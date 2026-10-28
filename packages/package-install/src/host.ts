import {artifactKey, artifactSchema, sha256, type Artifact, revision, type Installation, type PackageRevision, type InstallJob} from './contracts.ts';
import {PackageRegistry} from './registry.ts';
import {inspectPackage, resolvePackage} from './resolver.ts';

interface Owner {
  state: DurableObjectState; scope: {tenantId: string; environmentId?: string}; bucket: R2Bucket | undefined;
  build(input: string): Promise<Response>;
  validate(artifact: Artifact): Promise<void>;
  changed(): Promise<void>;
  revoke(name: string, digest: string): Promise<void>;
  alarm?(at: number): Promise<void>;
}
/** A durable environment transaction: build -> review -> exact approval -> selected configuration. */
export class PackageInstaller {
  readonly registry: PackageRegistry;
  private operation: Promise<void> | undefined;
  constructor(private readonly owner: Owner) {this.registry = new PackageRegistry(owner.state.storage);}
  private mutations: Promise<unknown> = Promise.resolve();
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutations.catch(() => {}).then(fn); this.mutations = next; return next;
  }
  list() {return {available: Boolean(this.owner.bucket), installations: this.registry.list(), jobs: this.registry.jobs()};}
  async snapshotArtifacts(target: {tenantId:string;environmentId:string}, rows: Installation[]): Promise<void> {
    for(const row of rows) {
      if(row.needsReinstall) throw new Error(`Reinstall ${row.name} before copying this environment`);
      const object=await this.owner.bucket?.get(artifactKey(this.owner.scope,row.digest));
      if(!object) throw new Error(`Plugin artifact missing: ${row.name}`);
      const text=await object.text();
      if(await sha256(text)!==row.digest) throw new Error('Plugin artifact integrity mismatch');
      await this.owner.bucket!.put(artifactKey(target,row.digest),text,{httpMetadata:{contentType:'application/json'}});
    }
  }
  /** Immutable artifacts acquire independent ownership; approvals do not transfer. */
  async copyFrom(source: {tenantId:string;environmentId:string}, rows: Installation[]): Promise<void> {
    for(const row of rows) {
      if(row.needsReinstall) throw new Error(`Reinstall ${row.name} before copying this environment`);
      const object=await this.owner.bucket?.get(artifactKey(source,row.digest));
      if(!object) throw new Error(`Plugin artifact missing: ${row.name}`);
      const text=await object.text();
      if(await sha256(text)!==row.digest) throw new Error('Plugin artifact integrity mismatch');
      const artifact=artifactSchema.parse(JSON.parse(text));
      await this.owner.validate(artifact);
      await this.owner.bucket!.put(artifactKey(this.owner.scope,row.digest),text,{httpMetadata:{contentType:'application/json'}});
      this.registry.save({...revision(row),enabled:false,approved:false,installedAt:Date.now()});
    }
    await this.owner.state.storage.sync();
  }
  async inspect(spec: string) {
    try {
      const {manifest} = await inspectPackage(spec, AbortSignal.timeout(20_000));
      return {status: 'accepted', kind: 'registry', name: manifest.name, version: manifest.version, description: manifest.description, bundle: true, registry: 'https://registry.npmjs.org/'};
    } catch (error) {return {status: 'refused', problem: 'invalid-spec', reason: error instanceof Error ? error.message : String(error)};}
  }
  async start(spec: string, requestId: string): Promise<InstallJob> {
    if (!this.owner.bucket) throw new Error('Package artifact storage is unavailable in this deployment');
    if (spec.length > 250 || !/^[\w-]{1,100}$/.test(requestId)) throw new Error('Invalid installation request');
    const existing = this.registry.job(requestId);
    if (existing) {if (existing.spec !== spec) throw new Error('Installation request identity was reused'); return existing;}
    if (this.registry.jobs().some(job => ['resolving', 'building'].includes(job.phase))) throw new Error('Another package installation is in progress');
    const name = spec.replace(/@\d.*$/, '');
    const current = this.registry.get(name);
    if (!current && this.registry.list().length >= 16) throw new Error('An environment supports at most 16 installed packages');
    if (current?.candidate) throw new Error('Review or discard the pending version before building another update');
    const job: InstallJob = {id: requestId, spec, name, ...(current ? {baseDigest: current.digest} : {}), phase: 'resolving', createdAt: Date.now()};
    this.registry.saveJob(job);
    await this.owner.state.storage.sync();
    await (this.owner.alarm ? this.owner.alarm(Date.now() + 150_000) : this.owner.state.storage.setAlarm(Date.now() + 150_000));
    this.launch(job);
    return job;
  }
  private launch(job: InstallJob): void {
    if (this.operation) return;
    const operation = this.install(job);
    this.operation = operation;
    this.owner.state.waitUntil(operation);
    void operation.finally(() => {if (this.operation === operation) this.operation = undefined;}).catch(() => {});
  }
  /** A killed supervisor retries downloads/build, never activates an unreviewed artifact. */
  async recover(): Promise<void> {
    await this.exclusive(async () => {
      for (const row of this.registry.list()) if (row.switching) {
        const {switching, ...restored} = row;
        this.registry.save({...restored, enabled: switching.enabled, lastError: 'An interrupted version switch was rolled back.'});
        await this.owner.state.storage.sync(); await this.owner.changed();
      }
    });
    const job = this.registry.jobs().find(row => ['resolving', 'building'].includes(row.phase));
    if (job && !this.operation) this.launch(job);
    await this.operation;
  }
  async wait(id: string): Promise<InstallJob | undefined> {await this.operation; return this.registry.job(id);}
  private async install(job: InstallJob): Promise<void> {
    try {
      const resolved = await resolvePackage(job.resolvedSpec ?? job.spec, AbortSignal.timeout(90_000));
      const current = this.registry.get(resolved.manifest.name);
      if (current?.digest !== job.baseDigest || current?.candidate) throw new Error('Installation changed while resolving the package');
      if (current?.version === resolved.manifest.version) throw new Error('This exact version is already installed');
      job = {...job, name: resolved.manifest.name, resolvedSpec: `${resolved.manifest.name}@${resolved.manifest.version}`, phase: 'building'}; this.registry.saveJob(job); await this.owner.state.storage.sync();
      const response = await this.owner.build(JSON.stringify({name: resolved.manifest.name, version: resolved.manifest.version,
        declaration: resolved.declaration, declarationRaw: resolved.manifest.dsh!.bundle, lock: resolved.lock, packages: resolved.packages}));
      const raw = await response.json() as {error?: string};
      if (!response.ok) throw new Error(raw.error ?? 'Plugin build failed');
      const artifact = artifactSchema.parse(raw);
      if (artifact.name !== resolved.manifest.name || artifact.version !== resolved.manifest.version || JSON.stringify(artifact.lock) !== JSON.stringify(resolved.lock)) throw new Error('Build output differs from the resolved package');
      await this.owner.validate(artifact);
      const body = JSON.stringify(artifact), digest = await sha256(body);
      await this.owner.bucket!.put(artifactKey(this.owner.scope, digest), body, {httpMetadata: {contentType: 'application/json'}});
      const installed: Installation = {name: artifact.name, version: artifact.version, description: artifact.description,
        digest, patch: artifact.patch, rows: artifact.rows, permissions: artifact.permissions, ...(artifact.hostScope ? {hostScope: artifact.hostScope} : {}), ...(artifact.configs?.length ? {configs: artifact.configs} : {}), enabled: false, approved: false, installedAt: Date.now()};
      await this.exclusive(async () => {
        const current = this.registry.get(installed.name);
        if (current?.digest !== job.baseDigest || current?.candidate || this.registry.job(job.id)?.phase === 'failed') throw new Error('Installation changed while building the package');
        this.owner.state.storage.transactionSync(() => {
          this.registry.save(current ? {...current, candidate: installed} : installed);
          this.registry.saveJob({...job, phase: 'review', digest});
        });
      });
    } catch (error) {
      this.registry.saveJob({...job, phase: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 4000)});
    } finally {
      await this.owner.state.storage.sync();
      await this.owner.changed();
    }
  }
  private async read(digest: string): Promise<Artifact> {
    const object = await this.owner.bucket?.get(artifactKey(this.owner.scope, digest));
    if (!object) throw new Error('Package artifact is missing');
    const text = await object.text();
    if (await sha256(text) !== digest) throw new Error('Package artifact integrity mismatch');
    return artifactSchema.parse(JSON.parse(text));
  }
  async artifact(name: string, digest: string, approved = true): Promise<Artifact> {
    const authorized = () => {
      const row = this.registry.get(name);
      if (row?.needsReinstall) throw new Error('Remove and reinstall this package using its native dsh.bundle.patch declaration');
      if (!row || (approved ? row.digest !== digest || !row.approved || !row.enabled : ![row.digest,row.candidate?.digest,row.previous?.digest].includes(digest))) throw new Error('Package activation is not authorized');
    };
    authorized();
    const artifact = await this.read(digest);
    authorized(); // Revocation can happen while R2 is being read.
    return artifact;
  }
  approve(name: string, digest: string, grants?: Installation['permissions']): Promise<void> {
    return this.exclusive(async () => {
      const artifact = await this.artifact(name, digest, false);
      if (grants && ((grants.files === 'write' && artifact.permissions.files !== 'write') || (grants.files !== 'none' && artifact.permissions.files === 'none') || (['tools', 'timer', 'client', 'network', 'storage', 'sessions', 'credentials', 'routes', 'background', 'connections'] as const).some(key => grants[key] && !artifact.permissions[key]))) throw new Error('Approval exceeds bundle capability limits');
      const row = this.registry.get(name);
      const target = row?.digest === digest ? row : row?.candidate?.digest === digest ? row.candidate : undefined;
      if (!row || !target) throw new Error('Approval is stale');
      if (artifact.hostScope === 'environment' && !(grants ?? artifact.permissions).background) throw new Error('This plugin requires environment background permission');
      const next: Installation = {...revision(target), activationId: crypto.randomUUID(), permissions: grants ?? {...artifact.permissions, network: false, credentials: false, routes: false, connections: false}, approved: true, enabled: true,
        ...(target !== row ? {previous: revision(row), rollbackOnFailure:true as const} : { ...(row.previous ? {previous: row.previous} : {}), ...(row.candidate ? {candidate: row.candidate} : {}) })};
      await this.replace(row, next);
    });
  }
  /** Persist revocation before releasing old effects; failed switches restore the old receipt. */
  private async replace(old: Installation, next: Installation): Promise<void> {
    await (this.owner.alarm ? this.owner.alarm(Date.now() + 150_000) : this.owner.state.storage.setAlarm(Date.now() + 150_000));
    this.registry.save({...old, enabled: false, switching: {enabled: old.enabled}});
    await this.owner.state.storage.sync();
    try {
      await this.owner.revoke(old.name, old.digest);
      this.registry.save(next); await this.owner.state.storage.sync();
    } catch (error) {
      this.registry.save(old); await this.owner.state.storage.sync();
      await this.owner.changed(); throw error;
    }
    await this.owner.changed();
  }
  rollback(name: string, digest: string): Promise<void> {
    return this.exclusive(async () => {
      const row = this.registry.get(name);
      if (!row || row.digest !== digest || !row.previous?.approved) throw new Error('No approved previous version is available');
      if (row.candidate) throw new Error('Discard the pending update before restoring a previous version');
      await this.read(row.previous.digest);
      await this.replace(row, {...row.previous, activationId: crypto.randomUUID(), candidate: {...revision(row), approved: false, enabled: false}});
    });
  }
  /** Only an exact, still-selected activation can roll back; late failures cannot undo a later update. */
  failed(name: string, digest: string, half: 'host' | 'client', activationId?: string, reason?: string): Promise<boolean> {
    return this.exclusive(async () => {
      const row = this.registry.get(name);
      if (!row || row.digest !== digest || !row.enabled || !row.approved) return false;
      if ((row.activationId ?? digest) !== (activationId ?? digest)) return false;
      const lastError = `${half === 'host' ? 'Host' : 'Client'} activation failed for ${row.version}.${reason ? ' ' + reason.slice(0, 500) : ''}`;
      let next: Installation = {...row, enabled: false, lastError};
      if (row.rollbackOnFailure && row.previous?.approved) {
        try {
          await this.read(row.previous.digest);
          next = {...row.previous, activationId: crypto.randomUUID(), candidate: {...revision(row), enabled: false, approved: false}, lastError};
        } catch {next.lastError += ' Previous artifact is unavailable; the package was disabled.';}
      }
      this.registry.save(next); await this.owner.state.storage.sync();
      // The reporting Session is still inside its reconciliation. Calling back
      // into stop() here would deadlock; other Sessions reconcile before a turn.
      await this.owner.changed(); return true;
    });
  }
  discard(name: string, digest: string): Promise<void> {
    return this.exclusive(async () => {
      const row = this.registry.get(name);
      if (!row?.candidate || row.candidate.digest !== digest) throw new Error('Pending version changed');
      const {candidate: _candidate, ...next} = row;
      this.registry.save(next); await this.owner.state.storage.sync(); await this.owner.changed();
    });
  }
  enabled(name: string, enabled: boolean): Promise<boolean> {
    return this.exclusive(async () => {
      const row = this.registry.get(name);
      if (!row) throw new Error('Unknown installed package');
      if (enabled && !row.approved) throw new Error('Review and approve the exact artifact before enabling');
      if (row.enabled === enabled) return false;
      const {rollbackOnFailure:_rollback,...selected}=row;
      await this.replace(row, {...selected, enabled, activationId:crypto.randomUUID()}); return true;
    });
  }
  remove(name: string): Promise<void> {
    return this.exclusive(async () => {
      const row = this.registry.get(name);
      if (!row) throw new Error('Unknown installed package');
      this.registry.save({...row, enabled: false}); await this.owner.state.storage.sync();
      await this.owner.revoke(name, row.digest);
      this.owner.state.storage.transactionSync(() => {
        this.registry.remove(name);
        for (const job of this.registry.jobs()) if (job.name === name && ['resolving','building'].includes(job.phase)) this.registry.saveJob({...job,phase:'failed',error:'Package removed during installation'});
      });
      await this.owner.state.storage.sync(); await this.owner.changed();
      // Keep immutable artifacts until environment deletion. In-flight reads,
      // copy snapshots and revision receipts must never lose their bytes.
    });
  }
}
