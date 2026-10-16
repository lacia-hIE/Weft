import type { Context } from "@deepseek-ai/cordis";
import * as Todo from "@deepseek-ai/dsh-tool-todo";
import * as Time from "@deepseek-ai/dsh-time-context";
import * as Repeat from "@deepseek-ai/dsh-repeat-tool-reminder";
import Skills from "@deepseek-ai/dsh-skill";
import * as SkillFiles from "@deepseek-ai/dsh-skill-filesystem";
import * as SkillTool from "@deepseek-ai/dsh-tool-skill";

export interface PluginSelection {
  id: string;
  config: Record<string, unknown>;
}
interface Entry {
  id: string;
  title: string;
  description: string;
  workspace: boolean;
  schema: unknown;
  defaults: Record<string, unknown>;
  validate(config: Record<string, unknown>): void;
  mount(ctx: Context, config: Record<string, unknown>): Promise<void>;
}

// Only the platform adapter lives here. Schemas, tools, projections and lifecycle
// come from the same pinned upstream tree as the AgentLoop and browser renderer.
const entries: Entry[] = [
  {
    id: "tool-todo",
    title: "任务清单",
    description: "官方 todo_write 工具与持久化任务事件。",
    workspace: false,
    schema: Todo.Config,
    defaults: { allowParallelInProgress: false },
    validate: (config) => {
      Todo.Config(config as unknown as Todo.Config);
    },
    mount: async (ctx, config) => {
      await ctx.plugin(Todo, Todo.Config(config as unknown as Todo.Config));
    },
  },
  {
    id: "time-context",
    title: "时间上下文",
    description: "为 Agent 注入带时区的原生时间上下文。",
    workspace: false,
    schema: Time.Config,
    defaults: { timeZone: "Asia/Shanghai", refreshIntervalMs: 600000 },
    validate: (config) => {
      const value = Time.Config(config);
      if (value.timeZone)
        new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
      if (
        value.refreshIntervalMs !== undefined &&
        (!Number.isSafeInteger(value.refreshIntervalMs) ||
          value.refreshIntervalMs < 0)
      )
        throw new Error("Invalid refresh interval");
    },
    mount: async (ctx, config) => {
      await ctx.plugin(Time, Time.Config(config));
    },
  },
  {
    id: "repeat-tool-reminder",
    title: "重复调用提醒",
    description: "通过官方 Agent 钩子提醒重复工具调用。",
    workspace: false,
    schema: Repeat.Config,
    defaults: {
      thresholds: [3, 5, 8],
      include: [],
      exclude: [],
      argumentsPreviewChars: 500,
    },
    validate: (config) => {
      const value = Repeat.Config(config);
      const thresholds = value.thresholds!;
      if (
        !thresholds.length ||
        thresholds.some((n) => !Number.isSafeInteger(n) || n < 2) ||
        new Set(thresholds).size !== thresholds.length
      )
        throw new Error("Invalid reminder thresholds");
      if (
        !Number.isSafeInteger(value.argumentsPreviewChars) ||
        value.argumentsPreviewChars! < 1
      )
        throw new Error("Invalid preview length");
    },
    mount: async (ctx, config) => {
      await ctx.plugin(Repeat, Repeat.Config(config));
    },
  },
  {
    id: "tool-skill",
    title: "Skills",
    description:
      "官方 SKILL.md 发现、目录上下文与 skill 工具；目录 /workspace/.agents/skills。",
    workspace: true,
    schema: SkillTool.Config,
    defaults: { catalogDescriptionMaxLength: 500 },
    validate: (config) => {
      const value = SkillTool.Config(config);
      if (
        !Number.isSafeInteger(value.catalogDescriptionMaxLength) ||
        value.catalogDescriptionMaxLength! < 3
      )
        throw new Error("Invalid catalog description length");
    },
    mount: async (ctx, config) => {
      await ctx.plugin(Skills, {});
      await ctx.plugin(SkillFiles, {
        includeDefaultRoots: false,
        watch: false,
        dshHome: "/workspace/.dsh",
        agentsHome: "/workspace/.agents",
        customSkillDirs: ["/workspace/.agents/skills"],
      });
      await ctx.plugin(SkillTool, SkillTool.Config(config));
    },
  },
];

export const pluginCatalog = entries.map(
  ({ id, title, description, workspace, schema, defaults }) => ({
    id,
    package: `@deepseek-ai/dsh-${id}`,
    title,
    description,
    workspace,
    schema: JSON.parse(JSON.stringify(schema)) as unknown,
    // Schemastery serializes a graph as {uid,refs}; do not mistake it for a
    // nested JSON schema. UI fields are a small explicit view over its root.
    fields: Object.entries(
      (schema as { dict: Record<string, { type: string }> }).dict,
    ).map(([name, field]) => ({ name, type: field.type })),
    defaults,
  }),
);

export function validatePlugins(
  plugins: PluginSelection[],
  workspaceId?: string,
): void {
  const seen = new Set<string>();
  for (const selection of plugins) {
    const entry = entries.find((item) => item.id === selection.id);
    if (!entry || seen.has(entry.id))
      throw new Error("Unknown or duplicate plugin");
    seen.add(entry.id);
    if (entry.workspace && !workspaceId)
      throw new Error("Plugin requires a workspace");
    const schema = entry.schema as { dict: Record<string, unknown> };
    if (
      Object.keys(selection.config).some(
        (key) => !Object.hasOwn(schema.dict, key),
      )
    )
      throw new Error("Unknown plugin configuration field");
    entry.validate(selection.config);
  }
}

export async function mountPlugins(
  ctx: Context,
  plugins: PluginSelection[],
): Promise<void> {
  for (const selection of plugins) {
    const entry = entries.find((item) => item.id === selection.id);
    if (!entry)
      throw new Error(
        "Published plugin is unavailable; review upstream compatibility",
      );
    await entry.mount(ctx, selection.config);
  }
}
