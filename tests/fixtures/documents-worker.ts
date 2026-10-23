import worker, {SessionDO as BaseSessionDO, WorkspaceDO as BaseWorkspaceDO, type Env} from '../../apps/worker/src/index.ts';
import {workspaceAddress, type WorkspaceScope} from '../../packages/workspace/src/protocol.ts';
export {EnvironmentDO, TenantDO, WorkspaceProxy, WorkspaceServiceProxy, PluginCapabilities} from '../../apps/worker/src/index.ts';

/** Only the external conversion service is substituted; the native tool, filesystem and Agent are real. */
const ai = {
  toMarkdown(file?: MarkdownDocument) {
    if (!file) return {supported: async () => [{extension: 'html', mimeType: 'text/html'}]};
    return file.blob.text().then(text => ({id: 'fixture', name: file.name, mimeType: 'text/html', format: 'markdown', tokens: 4, data: '# Converted document\n\n'+text.replace(/<[^>]*>/g, '')}));
  },
} as unknown as Ai;
export class SessionDO extends BaseSessionDO {
  constructor(ctx: DurableObjectState, env: Env) {super(ctx, {...env, AI: ai});}
}
export class WorkspaceDO extends BaseWorkspaceDO {
  constructor(ctx: DurableObjectState, env: Env) {super(ctx, {...env, AI: ai});}
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname !== '/_test/documents') return worker.fetch(request, env, ctx);
    const {scope, name, content} = await request.json() as {scope: WorkspaceScope; name: string; content: string};
    return env.WORKSPACES.getByName(workspaceAddress(scope)).convertDocument(scope, name, new TextEncoder().encode(content).buffer);
  },
};
