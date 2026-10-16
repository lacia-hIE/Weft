import { WorkerEntrypoint } from "cloudflare:workers";
import { createDynamicRunner } from "../../packages/dynamic-runner/src/index.ts";
interface Env {
  LOADER: WorkerLoader;
  PLATFORM_SECRET: string;
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
