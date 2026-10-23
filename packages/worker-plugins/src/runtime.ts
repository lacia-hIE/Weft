import type {Context, Plugin} from '@deepseek-ai/cordis';
import {workerdLoader, createEntry} from '../../native-profile/src/loader.ts';
import {mountComputerJavaScript, type JavaScriptTransport} from '../../native-computer/src/index.ts';
import {mountWorkerDocuments, type DocumentTransport} from '../../native-documents/src/index.ts';
import type {WorkspaceScope} from '../../workspace/src/protocol.ts';
import {JS, DOCS, JavaScriptConfig, DocumentsConfig, workerRows, managementRows, type WorkerPluginSettings} from './catalog.ts';

/** The privileged transport stays in the platform; Loader fibers own only Agent tools. */
export async function mountWorkerPlugins(ctx: Context, scope: WorkspaceScope, transport: JavaScriptTransport & DocumentTransport, read: () => Promise<WorkerPluginSettings>, initial: WorkerPluginSettings) {
  let reconcile!: (settings: WorkerPluginSettings) => Promise<void>;
  await ctx.plugin({name: '@weft/worker-plugin-loader', inject: ['loader'], async apply(child: Context) {
    reconcile = await loadWorkerPlugins(child, scope, transport, read, initial);
  }});
  return reconcile;
}
async function loadWorkerPlugins(ctx: Context, scope: WorkspaceScope, transport: JavaScriptTransport & DocumentTransport, read: () => Promise<WorkerPluginSettings>, initial: WorkerPluginSettings) {
  let applied = initial;
  const guarded: JavaScriptTransport & DocumentTransport = {
    revokeJavaScriptWrites: (scope, owner) => transport.revokeJavaScriptWrites(scope, owner),
    javascript: async (scope, owner, request) => {
      if (request.operation === 'start' || request.operation === 'answer') {
        const settings = await read();
        if (!settings.bundles.javascript || !settings.javascript.enabled) throw new Error('Worker JavaScript plugin is disabled');
        if (request.operation === 'start' && request.writable && !settings.javascript.allowWritable) throw new Error('Writable JavaScript tasks are disabled');
      }
      return transport.javascript(scope, owner, request);
    },
    convertDocument: async (scope, name, bytes) => {
      const settings = await read();
      if (!settings.bundles.documents || !settings.documents.enabled) throw new Error('Worker document plugin is disabled');
      if (bytes.byteLength > settings.documents.maxInputMiB * 1048576) throw new Error('Document exceeds this environment’s input limit');
      return transport.convertDocument(scope, name, bytes);
    },
  };
  // This is a platform access-policy hook: unloading the creation tool must
  // never stop sandbox changes from revoking existing writable jobs.
  const sandbox: Plugin = {name: '@weft/worker-task-sandbox', apply(child: Context) {
    child.on('session/event', async (session, event) => {
      if (event.type === 'sandbox/mode' && event.data.mode === 'read-only') await transport.revokeJavaScriptWrites(scope, session.id);
    }, {global: true});
  }};
  const modules: Record<string, Plugin> = {
    [JS]: {name: '@weft/worker-javascript-tool', Config: JavaScriptConfig, inject: ['tools', 'sandboxPolicy', 'workingDirectory'], apply: (child: Context, config: ReturnType<typeof JavaScriptConfig>) => mountComputerJavaScript(child, scope, guarded, {
      get defaultTimeoutMs() {return config.defaultTimeoutMs.get();}, get allowWritable() {return config.allowWritable.get();},
    })},
    [DOCS]: {name: '@weft/worker-documents-tool', Config: DocumentsConfig, inject: ['tools', 'fs', 'workingDirectory', 'sandboxPolicy'], apply: (child: Context, config: ReturnType<typeof DocumentsConfig>) => mountWorkerDocuments(child, scope, guarded, {
      get maxInputMiB() {return config.maxInputMiB.get();}, get previewCharacters() {return config.previewCharacters.get();},
    })},
    'weft-task-sandbox': sandbox,
  };
  const loader = await workerdLoader(ctx, modules);
  for (const row of managementRows.filter(row => row.id === 'weft-task-sandbox')) await createEntry(loader, {...row, name: 'cordis:'+row.id});
  const rows = (settings: WorkerPluginSettings) => workerRows(settings).filter(row => row.id === JS || row.id === DOCS).map(row => ({...row, name: 'cordis:'+row.id,
    config: row.id === JS ? settings.javascript : settings.documents}));
  for (const row of rows(initial)) await createEntry(loader, row);
  return async (settings: WorkerPluginSettings) => {
    const previous = rows(applied);
    applied = structuredClone(settings);
    for (const row of rows(settings)) {
      if (JSON.stringify(row) === JSON.stringify(previous.find(old => old.id === row.id))) continue;
      const fiber = loader.resolve(row.id).fiber;
      await loader.update(row.id!, {disabled: row.disabled, config: row.config});
      if (row.disabled) await fiber?.dispose();
      else await loader.resolve(row.id).fiber?.await();
    }
  };
}
