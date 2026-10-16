import type { Context } from "@deepseek-ai/cordis";
import * as InspectTools from "@deepseek-ai/dsh-tool-cordis";
import { CordisInspectRegistryService } from "@weft/upstream/packages/extensions/cordis-host-runner/src/inspect-registry.ts";
import {
  queryServiceApi,
  SERVICE_API,
} from "@weft/upstream/packages/extensions/cordis-client-runner/src/client/api-catalog.ts";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import { browserImports } from "./compiler.ts";
import {
  primitiveExports,
  dockkitExports,
} from "../../../.generated/browser-capabilities.ts";

/** Reuse official model-facing inspect tools without loading the Node VM runner.
 * BrowserAPI is a pinned contract, not a claim to inspect a connected browser.
 */
export async function mountClientInspection(ctx: Context): Promise<void> {
  const registry = new CordisInspectRegistryService(ctx, 1000);
  ctx.effect(() =>
    registry.register({
      manifest: {
        id: "WeftBrowserAPI",
        description:
          "Pinned browser plugin contract supported by this Cloudflare host; static API, not live browser state.",
        methods: [
          {
            name: "describe",
            description:
              "Read native SlotRegistry contracts and the supported browser host surface before writing a UI plugin.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            outputSchema: {},
          },
        ],
      },
      query: async () =>
        ({
          imports: Object.keys(browserImports),
          slots: ["weft.panel", "weft.toolbar", "shell.overlay"].map(
            (name) => ({
              name,
              kind: "list",
              scope: "root",
              owner: { host: "{environmentId,sessionId,workspaceId,agentId,revision}" },
            }),
          ),
          services: {
            slots: queryServiceApi("slots", SERVICE_API),
            weft: [
              "api(path,init):Promise<JSON>",
              "getSelection():Selection",
              "subscribeSelection(listener):dispose",
              "refresh():Promise<void>",
            ],
          },
          primitives: primitiveExports.filter(
            (name) => !name.startsWith("Icon"),
          ),
          icons:
            "The native Icon* exports are also available from ui-primitives.",
          dockkit: dockkitExports,
          publication:
            "Write one TSX module into /workspace, then ui_publish_plugin. Human activation is required per revision.",
        }) as unknown as JsonValue,
    }),
  );
  ctx.effect(() =>
    registry.register({
      manifest: {
        id: "Tool",
        description: "Native tools available to this Agent.",
        methods: [
          {
            name: "listTools",
            description: "Return actual mounted tool schemas.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            outputSchema: {},
          },
        ],
      },
      query: async (_method, _input, context) =>
        ({ tools: ctx.tools.schemas(context.agent) }) as unknown as JsonValue,
    }),
  );
  await ctx.plugin(InspectTools);
}
