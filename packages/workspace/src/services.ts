import {Context, Service} from '@deepseek-ai/cordis';
import type {JavaScriptTransport} from '../../native-computer/src/index.ts';
import type {DocumentTransport} from '../../native-documents/src/index.ts';
import type {PluginPlanEntry} from '../../plugin-registry/src/types.ts';
import type {WorkspaceScope} from './protocol.ts';

declare module '@deepseek-ai/cordis' {interface Context {weftWorkspaceServices: WorkspaceServices}}
export interface WorkspaceServicesOptions {
  scope: WorkspaceScope;
  transport: JavaScriptTransport & DocumentTransport;
  resolve(id: string): Promise<PluginPlanEntry | undefined>;
}
/** Scoped privileged RPC provider; plugins receive services rather than Cloudflare bindings. */
export class WorkspaceServices extends Service {
  readonly scope: WorkspaceScope;
  readonly transport: WorkspaceServicesOptions['transport'];
  readonly resolve: WorkspaceServicesOptions['resolve'];
  constructor(ctx: Context, options: WorkspaceServicesOptions) {
    super(ctx, 'weftWorkspaceServices');
    this.scope = options.scope; this.transport = options.transport; this.resolve = options.resolve;
  }
}
