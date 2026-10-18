import {DurableObject} from 'cloudflare:workers';
import {openHarnessSession, type HarnessSessionHost} from '../../packages/harness-runtime/src/runtime.ts';
import {initializeSessionStorage, SqliteSessionPersistence} from '../../packages/session-persistence-do/src/index.ts';
import {ScriptedAdapter} from '../../packages/harness-runtime/src/scripted-adapter.ts';
import {registerIdentityTool} from '../../packages/harness-runtime/src/validation-tools.ts';
import {mountNativeComposition} from '../../packages/native-composition/src/index.ts';
import {createUserMessage, ToolCallId} from '@deepseek-ai/dsh-llm';
import {agentPresetProjectionDefinition} from '@weft/upstream/packages/preset/agent-preset-registry/src/session.ts';
import type {Context} from '@deepseek-ai/cordis';

interface BenchEnv {COMPOSITIONS: DurableObjectNamespace<CompositionBench>}
export class CompositionBench extends DurableObject<BenchEnv> {
  private host: Promise<HarnessSessionHost> | undefined;
  constructor(ctx: DurableObjectState, env: BenchEnv) {
    super(ctx, env);
    initializeSessionStorage(ctx.storage);
  }
  async action(action: string, preset?: string): Promise<Response> {
    let root: Context;
    const host = await (this.host ??= openHarnessSession({
      sessionId: 'composition', presentation: true, meta: {agentPreset: 'single'}, persona: 'Native composition validation', model: {provider: 'validation', model: 'scripted'}, adapter: new ScriptedAdapter(),
      mountPersistence: async ctx => {await ctx.plugin(SqliteSessionPersistence, {storage: this.ctx.storage});},
      mountTools: async ctx => {
        root = ctx;
        registerIdentityTool(ctx, this.ctx.id.toString());
        await mountNativeComposition(ctx, [
          {id: 'minimal', name: 'Minimal', plugins: []},
          {id: 'single', name: 'One active todo', plugins: [{id: 'todos', name: 'cordis:tool-todo', config: {allowParallelInProgress: false}}]},
          {id: 'parallel', name: 'Parallel todos', plugins: [{id: 'todos', name: 'cordis:tool-todo', config: {allowParallelInProgress: true}}]},
          {id: 'broken', plugins: [{name: 'unavailable-package'}]},
          {id: 'expression', plugins: [{name: 'cordis:tool-todo', config: {allowParallelInProgress: {__jsExpr: 'true'}}}]},
        ], 'single');
      },
      setupAgent: async (ctx, agent) => {await root.agentPresets.mount(ctx, root.sessionProjections.stateOf(agent.session, 'agentPreset') ?? 'single');},
    }));
    const {ctx, agent} = host;
    if (action === 'roster') return Response.json(await ctx.agentPresets.remoteExportList());
    if (action === 'read') return Response.json(await ctx.agentPresets.readDocument(preset!));
    if (action === 'select') {await ctx.agentPresets.select(agent, preset!); await ctx.sessionPersistence.flush();}
    if (action === 'prompt') {agent.followup(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'Who am I?'}]})); await agent.whenIdle(); await ctx.sessionPersistence.flush();}
    if (action === 'todos') return Response.json(await ctx.tools.execute({agent, callId: ToolCallId(crypto.randomUUID()), name: 'todo_write', arguments: {todos: [{content: 'A', status: 'in_progress'}, {content: 'B', status: 'in_progress'}]}, signal: new AbortController().signal}));
    return Response.json({
      seq: agent.session.seq,
      selections: agent.session.snapshotEvents().filter(event => event.type === 'agent-preset/selected').map(event => event.data),
      selected: ctx.sessionProjections.stateOf(agent.session, agentPresetProjectionDefinition.key),
      tools: ctx.tools.schemas(agent).map(tool => tool.name),
      rootTools: ctx.tools.schemas().map(tool => tool.name),
      scopes: ctx.agentPresets.inspectCompositions(agent.ctx),
    });
  }
}
export default {async fetch(request: Request, env: {COMPOSITIONS: DurableObjectNamespace<CompositionBench>}) {
  const {owner = 'one', action, preset} = await request.json() as {owner?: string; action: string; preset?: string};
  try {return await env.COMPOSITIONS.getByName(owner).action(action, preset);}
  catch (error) {return Response.json({error: error instanceof Error ? error.message : String(error)}, {status: 400});}
}};
