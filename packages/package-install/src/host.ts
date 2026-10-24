import {artifactKey, artifactSchema, sha256, type Artifact, type Installation, type InstallJob} from './contracts.ts';
import {PackageRegistry} from './registry.ts';
import {inspectPackage, resolvePackage} from './resolver.ts';

interface Owner {
  state: DurableObjectState; scope: {tenantId: string; environmentId?: string}; bucket: R2Bucket | undefined;
  build(input: string): Promise<Response>;
  validate(artifact: Artifact): Promise<void>;
  changed(): Promise<void>;
  revoke(name: string, digest: string): Promise<void>;
}
/** A durable environment transaction: build -> review -> exact approval -> selected configuration. */
export class PackageInstaller {
  readonly registry: PackageRegistry;
  private operation: Promise<void> | undefined;
  constructor(private readonly owner: Owner) {this.registry = new PackageRegistry(owner.state.storage);}
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
      this.registry.save({...row,enabled:false,approved:false,installedAt:Date.now()});
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
    if (this.registry.list().length >= 16) throw new Error('An environment supports at most 16 installed packages in v1');
    const job: InstallJob = {id: requestId, spec, phase: 'resolving', createdAt: Date.now()};
    this.registry.saveJob(job);
    await this.owner.state.storage.sync();
    await this.owner.state.storage.setAlarm(Date.now() + 150_000);
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
    const job = this.registry.jobs().find(row => ['resolving', 'building'].includes(row.phase));
    if (job && !this.operation) this.launch(job);
    await this.operation;
  }
  async wait(id: string): Promise<InstallJob | undefined> {await this.operation; return this.registry.job(id);}
  private async install(job: InstallJob): Promise<void> {
    try {
      const resolved = await resolvePackage(job.spec, AbortSignal.timeout(90_000));
      if (this.registry.get(resolved.manifest.name)) throw new Error('Already installed; uninstall before installing another version in v1');
      job = {...job, phase: 'building'}; this.registry.saveJob(job); await this.owner.state.storage.sync();
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
        digest, patch: artifact.patch, rows: artifact.rows, permissions: artifact.permissions, enabled: false, approved: false, installedAt: Date.now()};
      this.owner.state.storage.transactionSync(() => {this.registry.save(installed); this.registry.saveJob({...job, phase: 'review', digest});});
    } catch (error) {
      this.registry.saveJob({...job, phase: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 4000)});
    } finally {
      await this.owner.state.storage.sync();
      await this.owner.changed();
    }
  }
  async artifact(name: string, digest: string, approved = true): Promise<Artifact> {
    const row = this.registry.get(name);
    if (row?.needsReinstall) throw new Error('Remove and reinstall this package using its native dsh.bundle.patch declaration');
    if (!row || row.digest !== digest || (approved && (!row.approved || !row.enabled))) throw new Error('Package activation is not authorized');
    const object = await this.owner.bucket?.get(artifactKey(this.owner.scope, digest));
    if (!object) throw new Error('Package artifact is missing');
    const text = await object.text();
    if (await sha256(text) !== digest) throw new Error('Package artifact integrity mismatch');
    return artifactSchema.parse(JSON.parse(text));
  }
  async approve(name: string, digest: string, grants?: Installation['permissions']): Promise<void> {
    const artifact = await this.artifact(name, digest, false);
    if (grants && ((grants.files === 'write' && artifact.permissions.files !== 'write') || (grants.files !== 'none' && artifact.permissions.files === 'none') || ['tools', 'timer', 'client'].some(key => grants[key as 'tools'] && !artifact.permissions[key as 'tools']))) throw new Error('Approval exceeds bundle capability limits');
    const row = this.registry.get(name);
    if (!row || row.digest !== digest) throw new Error('Approval is stale');
    this.registry.save({...row, ...(grants ? {permissions: grants} : {}), approved: true, enabled: true});
    await this.owner.state.storage.sync(); await this.owner.changed();
  }
  async enabled(name: string, enabled: boolean): Promise<boolean> {
    const row = this.registry.get(name);
    if (!row) throw new Error('Unknown installed package');
    if (enabled && !row.approved) throw new Error('Review and approve the exact artifact before enabling');
    if (row.enabled === enabled) return false;
    this.registry.save({...row, enabled});
    await this.owner.state.storage.sync();
    if (!enabled) await this.owner.revoke(name, row.digest);
    await this.owner.changed(); return true;
  }
  async remove(name: string): Promise<void> {
    const row = this.registry.get(name);
    if (!row) throw new Error('Unknown installed package');
    this.registry.save({...row, enabled: false}); await this.owner.state.storage.sync();
    await this.owner.revoke(name, row.digest);
    await this.owner.bucket?.delete(artifactKey(this.owner.scope, row.digest));
    this.registry.remove(name); await this.owner.state.storage.sync();
    await this.owner.changed();
    // Never delete workspace/user data; completed job metadata remains a deduplication receipt.
  }
}
