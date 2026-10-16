import { Context, Inject, type Fiber, type Plugin } from "@deepseek-ai/cordis";
import * as Renderer from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ClientPlugin } from "../../../packages/control-plane/src/contracts.ts";
import { api, getSelection, subscribeSelection, tenantPath } from "./api.ts";

async function bounded<T>(operation: PromiseLike<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("插件加载或卸载超时，可用 /?safe=1 进入安全模式")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class BrowserPluginHost {
  readonly ctx = new Context();
  private readonly loaded = new Map<
    string,
    { revision: string; fiber: Fiber }
  >();
  private tail: Promise<void> = Promise.resolve();
  constructor(refresh: () => Promise<void>) {
    this.ctx.reflect.provide("weft", {
      api,
      getSelection,
      subscribeSelection,
      refresh,
    });
  }
  async initialize(): Promise<void> {
    await this.ctx.plugin(Renderer);
    // The official renderer always supplies an optional Session seat to root
    // components. Session-bound official UI plugins need the full domain adapter;
    // this host explicitly publishes absence rather than inventing that service.
    const absent = { key: undefined, hooks: {}, keyedHooks: {}, props: {} };
    const current = { getSnapshot: () => absent, subscribe: () => () => {} };
    this.ctx.slots.installScope("session", {
      current,
      bindingSource: () => current,
    });
  }
  reconcile(plugins: ClientPlugin[]): Promise<Record<string, string>> {
    const operation = this.tail.then(async () => {
      const errors: Record<string, string> = {};
      const enabled = plugins.filter((plugin) => plugin.enabled);
      for (const [id, live] of this.loaded) {
        if (
          !enabled.some(
            (plugin) => plugin.id === id && plugin.revision === live.revision,
          )
        ) {
          await bounded(Promise.resolve(live.fiber.dispose())).catch(() => {});
          this.loaded.delete(id);
        }
      }
      for (const record of enabled) {
        if (this.loaded.has(record.id)) continue;
        let fiber: Fiber | undefined;
        try {
          const module = (await bounded(
            import(
              /* @vite-ignore */ tenantPath(
                `client-plugins/${record.revision}/module.js`,
              )
            ),
          )) as { default?: Plugin } & Plugin.Object;
          const plugin = module.default ?? module;
          if (
            typeof plugin !== "function" &&
            (typeof plugin !== "object" || typeof plugin.apply !== "function")
          )
            throw new Error("请导出 Cordis apply 或 default plugin");
          // Fail explicitly instead of leaving an unmet native inject suspended forever.
          const required = Object.keys(Inject.resolve(plugin.inject));
          if (required.some((name) => this.ctx.get(name) === undefined))
            throw new Error(
              `缺少插件所需服务：${required.filter((name) => this.ctx.get(name) === undefined).join(", ")}`,
            );
          fiber = this.ctx.plugin(plugin, record.config);
          await bounded(fiber.await());
          this.loaded.set(record.id, { revision: record.revision, fiber });
        } catch (error) {
          if (fiber)
            await bounded(Promise.resolve(fiber.dispose()), 1000).catch(
              () => {},
            );
          errors[record.id] =
            error instanceof Error ? error.message : "插件加载失败";
        }
      }
      return errors;
    });
    this.tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
}
