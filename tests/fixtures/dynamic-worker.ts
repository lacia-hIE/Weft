import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createDynamicRunner } from "../../packages/dynamic-runner/src/index.ts";
import { NativePluginPlatform } from '../../packages/native-plugins/src/platform.ts';
import { openHarnessSession, type HarnessSessionHost } from '../../packages/harness-runtime/src/runtime.ts';
import { initializeSessionStorage, SqliteSessionPersistence } from '../../packages/session-persistence-do/src/index.ts';
import { ScriptedAdapter } from '../../packages/harness-runtime/src/scripted-adapter.ts';
import { normalizeHandler } from '@weft/upstream/packages/extensions/cordis-host-runner/src/guard.ts';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { Fiber } from '@deepseek-ai/cordis';
import { startHostHalf } from '@weft/upstream/packages/extensions/cordis-host-runner/src/lifecycle.ts';
interface Env {
  LOADER: WorkerLoader;
  PLATFORM_SECRET: string;
  NATIVE_PLUGINS: DurableObjectNamespace<NativePluginBench>;
}
export class NativePluginBench extends DurableObject<Env> {
  private host: Promise<HarnessSessionHost> | undefined;
  private platform: NativePluginPlatform | undefined;
  private fiber: Fiber | undefined;
  private handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  private toolController: AbortController | undefined;
  async action(action: string, input: {source?: string; method?: string; args?: unknown}) {
    initializeSessionStorage(this.ctx.storage);
    const host = await (this.host ??= openHarnessSession({sessionId: 'native-plugin', persona: 'test', model: {provider: 'validation', model: 'scripted'}, adapter: new ScriptedAdapter(), mountPersistence: async ctx => {await ctx.plugin(SqliteSessionPersistence, {storage: this.ctx.storage});}}));
    const platform = this.platform ??= new NativePluginPlatform(this.ctx, this.env.LOADER, {owner: this.ctx.id.toString()});
    if (action === 'start') {
      const plugin = await platform.evaluate(host.ctx, 'counter', crypto.randomUUID(), input.source!, (method, fn) => {
        const normalized = normalizeHandler(method, fn); this.handlers.set(normalized.method, normalized.handler);
        return () => {this.handlers.delete(normalized.method);};
      });
      const group = host.ctx.plugin({name: 'native-plugin-bench', apply() {}});
      this.fiber = await startHostHalf(group, plugin, error => {throw error;});
      return {tools: host.ctx.tools.schemas().map(tool => tool.name)};
    }
    if (action === 'invoke') return this.handlers.get(input.method!)!(input.args);
    if (action === 'tool') {
      const controller = this.toolController = new AbortController();
      try {return await host.ctx.tools.execute({agent: host.agent, callId: ToolCallId(crypto.randomUUID()), name: input.method!, arguments: input.args, signal: controller.signal});}
      finally {if (this.toolController === controller) this.toolController = undefined;}
    }
    if (action === 'cancel') this.toolController?.abort(new Error('Cancelled by the test user'));
    if (action === 'stop') {await this.fiber?.dispose(); this.fiber = undefined;}
    return {tools: host.ctx.tools.schemas().map(tool => tool.name), handlers: [...this.handlers.keys()]};
  }
}
export class ScopedHost extends WorkerEntrypoint<Env, { tenantId: string }> {
  async read(): Promise<{ tenantId: string; value: string }> {
    return {
      tenantId: this.ctx.props.tenantId,
      value: "Only this tenant capability",
    };
  }
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (new URL(request.url).pathname === '/native-plugin') {
      const body = await request.json() as {owner: string; action: string; source?: string; method?: string; args?: unknown};
      try {return Response.json(await env.NATIVE_PLUGINS.getByName(body.owner).action(body.action, body));}
      catch (error) {return Response.json({error: error instanceof Error ? error.message : String(error)}, {status: 400});}
    }
    const spec = (await request.json()) as {
      tenantId: string;
      revision: string;
      source: string;
      config: Record<string, unknown>;
      input: unknown;
    };
    const exports = ctx.exports as unknown as {
      ScopedHost(options: { props: { tenantId: string } }): Fetcher;
    };
    const host = exports.ScopedHost({ props: { tenantId: spec.tenantId } });
    const runner = await createDynamicRunner(env.LOADER, spec, host);
    const api = runner as unknown as { run(input: unknown): Promise<unknown> };
    try {
      return Response.json(await api.run(spec.input));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  },
} satisfies ExportedHandler<Env>;
