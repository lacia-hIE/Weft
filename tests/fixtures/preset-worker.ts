import application, {SessionDO as ApplicationSessionDO} from '../../apps/worker/src/index.ts';
import type {SessionScope} from '../../packages/tenant/src/index.ts';
export {WorkspaceDO, EnvironmentDO, TenantDO, PluginCapabilities} from '../../apps/worker/src/index.ts';

/** Test-only interrupted-commit injection; never included in the deployed Worker. */
export class SessionDO extends ApplicationSessionDO {
  async stagePresetGap(scope: SessionScope, before: string, after: string, beforeSeq: number): Promise<void> {
    await this.nativeHeader(scope);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('UPDATE weft_session_config SET agent_document=? WHERE id=1', before);
      this.ctx.storage.sql.exec('INSERT INTO weft_pending_preset VALUES (1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document', JSON.stringify({beforeSeq, profile: JSON.parse(after)}));
    });
    await this.ctx.storage.sync();
  }
}
export default application;
