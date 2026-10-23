import application, {EnvironmentDO as BaseEnvironmentDO, type Env} from '../../apps/worker/src/index.ts';
import {environmentAddress} from '../../packages/control-plane/src/object.ts';
import type {ControlScope, AgentRevision} from '../../packages/control-plane/src/contracts.ts';
import {ConfigWriteQueue, DurableSettingsDocuments, DurableAgentRevisions, DurableWorkspaceRegistry} from '../../packages/environment-storage/src/index.ts';

export * from '../../apps/worker/src/index.ts';

/** Real application environment, deliberately given no usable D1 binding. */
export class EnvironmentDO extends BaseEnvironmentDO {
  constructor(ctx: DurableObjectState, env: Env) {
    const localOnly = {...env, CONFIG_DB: undefined};
    super(ctx, localOnly);
  }

  async fixture(scope: ControlScope, operation: string, document?: string): Promise<Response> {
    // The normal entrypoint never exposes this fixture or these raw writes.
    if (!this.ctx.id.equals(this.env.ENVIRONMENTS.idFromName(environmentAddress(scope)))) throw new Error('Fixture scope mismatch');
    if (operation === 'seed-presets') {
      const revisions = JSON.parse(document!) as AgentRevision[];
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM official_preset_seeds');
        this.ctx.storage.sql.exec('DELETE FROM weft_agent_revisions');
        for (const row of revisions) this.ctx.storage.sql.exec('INSERT INTO weft_agent_revisions VALUES (?,?,?)', row.spec.id, row.revision, JSON.stringify(row));
      });
      return Response.json({seeded: true});
    }
    if (operation === 'atomicity') {
      const storage = this.ctx.storage;
      const settings = new DurableSettingsDocuments(storage, new ConfigWriteQueue());
      const key = 'storage-fixture';
      await settings.update(key, () => ({revision: 1, user: {value: 'before'}}));
      storage.sql.exec("CREATE TRIGGER reject_settings BEFORE UPDATE ON weft_settings_documents WHEN NEW.ns='storage-fixture' BEGIN SELECT RAISE(ABORT, 'injected settings failure'); END");
      let settingsRejected = false;
      try {await settings.update(key, () => ({revision: 2, user: {value: 'rejected'}}));} catch {settingsRejected = true;}
      storage.sql.exec('DROP TRIGGER reject_settings');
      const afterFailure = settings.get(key);
      const afterRetry = await settings.update(key, current => ({revision: current.revision + 1, user: {value: 'retried'}}));
      const registry = new DurableWorkspaceRegistry(storage, '{}');
      const state = registry.state(), count = registry.count;
      let workspaceRejected = false;
      try {
        await registry.transaction(tx => {
          tx.storeState('must roll back');
          tx.save({id: 'rollback-one', path: '/workspace/rollback', document: '{}'});
          tx.save({id: 'rollback-two', path: '/workspace/rollback', document: '{}'});
        });
      } catch {workspaceRejected = true;}
      const presets = new DurableAgentRevisions<{revision: number; value: string}>(storage);
      const first = await presets.publish('storage-fixture', {revision: 1, value: 'before'});
      const duplicate = await presets.publish('storage-fixture', {revision: 1, value: 'rejected'});
      return Response.json({settingsRejected, afterFailure, afterRetry, workspaceRejected, stateUnchanged: registry.state() === state, countUnchanged: registry.count === count, noPartialRow: !registry.get('rollback-one'), first, duplicate, preset: presets.latest('storage-fixture')});
    }
    return Response.json({state: await this.state(scope)});
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === '/_fixture/environment-storage') {
      const input = await request.json() as {scope: ControlScope; operation: string; document?: string};
      const target = env.ENVIRONMENTS.getByName(environmentAddress(input.scope)) as DurableObjectStub<EnvironmentDO>;
      return target.fixture(input.scope, input.operation, input.document);
    }
    return application.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
