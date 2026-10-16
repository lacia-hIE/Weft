import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ClientPluginInput } from "../../control-plane/src/contracts.ts";

export const CLIENT_PLUGIN_GUIDE = `
You can create browser UI plugins when requested. First call cordis_inspect_list, then cordis_inspect_query for platform host, provider WeftBrowserAPI, method describe to discover the supported native API. Write a self-contained TSX module under /workspace using write/read/edit, then call ui_publish_plugin. Publishing stages a revision for the user to review and enable; do not claim it is active before they enable it.
The browser runs the native DeepSeek Harness Cordis Context, SlotRegistry and UI renderer. Supported imports: react, react/jsx-runtime, @deepseek-ai/cordis, @deepseek-ai/schemastery, @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-primitives (the real public UI kit), @deepseek-ai/dsh-client-ui-dockkit. Do not import Node modules, relative files or external npm packages. Export a Cordis plugin using named apply(ctx,config), inject=['slots','weft'], and optional native Config, or export a default Cordis plugin. Use native ctx.slots.inject('weft.panel', () => ctx.slots.register({name:'weft.panel',id:'unique'}, Component)); shell.overlay and weft.toolbar are also available list slots. Every contributed component receives host={sessionId,workspaceId,agentId}; these slots have root scope. Use React hooks normally. ctx.weft exposes api(path,init), getSelection(), subscribeSelection(listener), refresh(). api uses authenticated same-origin paths rooted at the current tenant; no API key is available in the browser. Use ctx.effect for cleanup. Plugins must respect the user's tenant and only perform requested actions.
Example:
import React from 'react'; export const inject=['slots']; export function apply(ctx){ctx.slots.inject('weft.panel',()=>ctx.slots.register({name:'weft.panel',id:'hello'},({host})=><section><h3>My panel</h3><p>{host.workspaceId}</p></section>))}
`;

export function mountClientPublisher(
  ctx: Context,
  publish: (input: ClientPluginInput) => Promise<Response>,
): void {
  ctx.tools.register(
    defineTool({
      name: "ui_publish_plugin",
      description:
        "Compile and stage a self-contained browser Cordis TSX UI plugin from the workspace. The user reviews and enables the immutable revision in the UI. Native slots: weft.panel, weft.toolbar, shell.overlay. This never executes source on the server.",
      parameters: {
        id: { type: "string", required: true },
        name: { type: "string", required: true },
        path: { type: "string", required: true },
      },
      output: {
        schema: {
          type: "object",
          properties: { result: { type: "string", required: true } },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: "text", text: value.result }],
      },
      execute: async (
        args: { id: string; name: string; path: string },
        exec,
      ) => {
        const target = await ctx.fs.resolve(args.path, {
          cwd: "/workspace",
          signal: exec.signal,
        });
        const source = await ctx.fs.readText(target, exec.signal);
        exec.signal.throwIfAborted();
        const response = await publish({
          id: args.id,
          name: args.name,
          source,
          config: {},
        });
        const data = (await response.json()) as Record<string, unknown>;
        if (!response.ok)
          throw new Error(
            String(data.error ?? "Client plugin publication failed"),
          );
        return {
          result: JSON.stringify({
            id: data.id,
            revision: data.revision,
            enabled: false,
            message: "Ready for user review in the UI plugins page",
          }),
        };
      },
    }),
  );
}
