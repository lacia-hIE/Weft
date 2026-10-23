import worker, {SessionDO as BaseSessionDO, type Env} from '../../apps/worker/src/index.ts';
export {WorkspaceDO, EnvironmentDO, TenantDO, WorkspaceProxy, WorkspaceServiceProxy, PluginCapabilities} from '../../apps/worker/src/index.ts';

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
export default worker;
