import type { Context, Plugin } from "@deepseek-ai/cordis";
import * as Todo from "@deepseek-ai/dsh-tool-todo";
import * as Time from "@deepseek-ai/dsh-time-context";
import * as Persona from "@deepseek-ai/dsh-persona";
import * as Repeat from "@deepseek-ai/dsh-repeat-tool-reminder";
import Skills from "@deepseek-ai/dsh-skill";
import * as SkillFiles from "@deepseek-ai/dsh-skill-filesystem";
import * as SkillTool from "@deepseek-ai/dsh-tool-skill";
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as Subagent from '@deepseek-ai/dsh-tool-subagent';
import * as SubagentControl from '@deepseek-ai/dsh-tool-subagent-control';
import * as ListAgents from '@deepseek-ai/dsh-tool-subagent-control/list-agents';
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic';
import * as CommandCompact from '@deepseek-ai/dsh-command-compact';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import * as AskUser from '@deepseek-ai/dsh-tool-ask-user';
import PlanMode, {resolveConfig as resolvePlanMode} from '@deepseek-ai/dsh-plan-mode';
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions';
import * as Present from '@deepseek-ai/dsh-tool-present';
import * as CommandGoal from '@deepseek-ai/dsh-command-goal';
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal';
import * as ToolSchedule from '@deepseek-ai/dsh-tool-schedule';
import * as ToolWeb from '@deepseek-ai/dsh-tool-web';
import * as ToolBash from '@deepseek-ai/dsh-tool-bash';
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs';
import * as ToolPresentation from '@deepseek-ai/dsh-agent-tool-presentation';
import WorkflowPtc from '@deepseek-ai/dsh-workflow-ptc';
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow';
import Terminals from '@deepseek-ai/dsh-terminal';
import * as TerminalBash from '@deepseek-ai/dsh-terminal-bash';
import * as PersistentBash from '@deepseek-ai/dsh-tool-bash-persistent';
import z from '@deepseek-ai/schemastery';

/** The official persona schema over a stored selection; `prefix` is required. */
function personaConfig(config: Record<string, unknown>): Persona.Config {
  const {prefix, ...rest} = config;
  if (typeof prefix !== "string") throw new Error("Persona prefix must be text");
  return Persona.Config({...rest, prefix});
}

export interface PluginSelection {
  id: string;
  config: Record<string, unknown>;
  /** Listed by the official inventory, never mounted. */
  disabled?: boolean | undefined;
}
interface Entry {
  id: string;
  package?: string;
  module: Plugin;
  title: string;
  description: string;
  workspace: boolean;
  schema: unknown;
  defaults: Record<string, unknown>;
  validate(config: Record<string, unknown>): void;
  mount(ctx: Context, config: Record<string, unknown>): Promise<void>;
}

/** The skill catalog and the environment workspace's skill directories, in place of the Node host's home roots. */
async function mountSkillCatalog(ctx: Context): Promise<void> {
  const cwd = ctx.workingDirectory.defaultDirectory;
  await ctx.plugin(Skills, {});
  await ctx.plugin(SkillFiles, {
    includeDefaultRoots: false, watch: false,
    dshHome: `${cwd}/.dsh`, agentsHome: `${cwd}/.agents`,
    customSkillDirs: [`${cwd}/.agents/skills`],
  });
}

async function mountSkills(ctx: Context, config: Record<string, unknown>): Promise<void> {
  await mountSkillCatalog(ctx);
  await ctx.plugin(SkillTool, SkillTool.Config(config));
}

/** The original modules are compiled into the Worker, never fetched at runtime. */
const SkillCatalogBundle = {name: 'workerd-skill-filesystem', Config: z.object({}), inject: ['workingDirectory'], apply: mountSkillCatalog};
const SubagentControlBundle = {...SubagentControl, Config: z.object({})};
const CommandCompactBundle = {...CommandCompact, Config: z.object({})};
const ListAgentsBundle = {...ListAgents, Config: z.object({})};
const PlanModeConfig = z.object({section: z.string().required()});
const CommandGoalBundle = {...CommandGoal, Config: z.object({})};
const ToolScheduleBundle = {...ToolSchedule, Config: z.object({})};
const TerminalsConfig = z.object({});
/**
 * The official file tools with their preset configuration; read_image is left
 * out where the deployment accepts no image type (no image codec), as the
 * workspace provider does outside preset realms.
 */
const FileToolsBundle = {
  name: 'workerd-tool-fs', Config: FileTools.Config,
  apply: async (ctx: Context, config: FileTools.Config) => {
    const accepted = (ctx.get('attachments') as {imageLimits?: {mediaTypes: readonly string[]}} | undefined)?.imageLimits?.mediaTypes.length ?? 0;
    await ctx.plugin(FileTools, {...config, readImage: config.readImage !== false && accepted > 0});
  },
};

// Only the platform adapter lives here. Schemas, tools, projections and lifecycle
// come from the same pinned upstream tree as the AgentLoop and browser renderer.
const entries: Entry[] = [
  {
    id: 'agent-instructions', module: AgentInstructions, title: '项目指令',
    description: '官方 AGENTS.md / CLAUDE.md 发现与上下文注入；读取所属环境的工作区。',
    workspace: true, schema: AgentInstructions.Config, defaults: {maxBytes: 65536},
    validate: config => {AgentInstructions.Config(config as unknown as AgentInstructions.Config);},
    mount: async (ctx, config) => {await ctx.plugin(AgentInstructions, AgentInstructions.Config(config as unknown as AgentInstructions.Config));},
  },
  {
    id: 'plan-mode', module: PlanMode, title: 'Plan 模式',
    description: '官方 /plan 与 exit_plan_mode；计划经官方审阅卡片批准。',
    workspace: false, schema: PlanModeConfig, defaults: {},
    validate: config => {resolvePlanMode(PlanModeConfig(config));},
    mount: async (ctx, config) => {await ctx.plugin(PlanMode, resolvePlanMode(PlanModeConfig(config)));},
  },
  {
    id: 'present', package: '@deepseek-ai/dsh-tool-present', module: Present, title: '交付文件',
    description: '官方 present 工具；在会话中展示工作区文件。',
    workspace: true, schema: Present.Config, defaults: {maxFiles: 8},
    validate: config => {Present.Config(config as unknown as Present.Config);},
    mount: async (ctx, config) => {await ctx.plugin(Present, Present.Config(config as unknown as Present.Config));},
  },
  {
    id: 'command-goal', module: CommandGoalBundle, title: '/goal 命令',
    description: '官方 /goal 命令；设置、暂停、恢复和清除会话目标。',
    workspace: false, schema: CommandGoalBundle.Config, defaults: {},
    validate: config => {CommandGoalBundle.Config(config);},
    mount: async ctx => {await ctx.plugin(CommandGoal);},
  },
  {
    id: 'tool-goal', module: ToolGoal, title: '目标工具',
    description: '官方 goal 工具与目标上下文；Agent 可读取并完成会话目标。',
    workspace: false, schema: ToolGoal.Config, defaults: {},
    validate: config => {ToolGoal.Config(config as unknown as ToolGoal.Config);},
    mount: async (ctx, config) => {await ctx.plugin(ToolGoal, ToolGoal.Config(config as unknown as ToolGoal.Config));},
  },
  {
    id: 'tool-schedule', module: ToolScheduleBundle, title: '定时提醒',
    description: '官方 schedule 工具；提醒由所属会话对象的 Durable Object Alarm 唤醒投递。',
    workspace: false, schema: ToolScheduleBundle.Config, defaults: {},
    validate: config => {ToolScheduleBundle.Config(config);},
    mount: async ctx => {await ctx.plugin(ToolSchedule);},
  },
  {
    id: 'tool-bash', module: ToolBash, title: 'Bash',
    description: '官方 bash 工具；命令在所属环境的 Computer shell（Dynamic Worker 内的 just-bash）中运行，可后台执行。',
    workspace: true, schema: ToolBash.Config, defaults: {},
    validate: config => {ToolBash.Config(config);},
    mount: async (ctx, config) => {await ctx.plugin(ToolBash, ToolBash.Config(config));},
  },
  {
    id: 'tool-jobs', module: ToolJobs, title: '后台作业',
    description: '官方作业工具；查看、等待和停止后台 bash 命令。',
    workspace: true, schema: ToolJobs.Config, defaults: {},
    validate: config => {ToolJobs.Config(config);},
    mount: async (ctx, config) => {await ctx.plugin(ToolJobs, ToolJobs.Config(config));},
  },
  {
    id: 'tool-presentation', package: '@deepseek-ai/dsh-agent-tool-presentation', module: ToolPresentation, title: '工具呈现方式',
    description: '官方工具呈现选择；ptc 模式下模型只见 run_code 与生成的 SDK，程序在每次运行独立的 Dynamic Worker 中执行。',
    workspace: false, schema: ToolPresentation.Config, defaults: {mode: 'native'},
    validate: config => {ToolPresentation.Config(config as unknown as ToolPresentation.Config);},
    mount: async (ctx, config) => {await ctx.plugin(ToolPresentation, ToolPresentation.Config(config as unknown as ToolPresentation.Config));},
  },
  {
    id: 'workflow-ptc', module: WorkflowPtc, title: 'Workflow 引擎',
    description: '官方 workflow 引擎；脚本与官方 guest 在会话的 Dynamic Worker PTC 运行时中执行，子 Agent 由会话派生。',
    workspace: false, schema: WorkflowPtc.Config, defaults: {provider: 'spawn'},
    validate: config => {WorkflowPtc.Config(config);},
    mount: async (ctx, config) => {await ctx.plugin(WorkflowPtc, WorkflowPtc.Config(config));},
  },
  {
    id: 'tool-workflow', module: ToolWorkflow, title: 'Workflow 工具',
    description: '官方 workflow 工具；Agent 编写并运行编排多个子 Agent 的工作流脚本。',
    workspace: false, schema: ToolWorkflow.Config, defaults: {},
    validate: config => {ToolWorkflow.Config(config as unknown as ToolWorkflow.Config);},
    mount: async (ctx, config) => {await ctx.plugin(ToolWorkflow, ToolWorkflow.Config(config as unknown as ToolWorkflow.Config));},
  },
  {
    id: 'pty', package: '@deepseek-ai/dsh-terminal', module: Terminals, title: '持久终端',
    description: '官方持久终端服务；终端会话属于 Agent，命令在 Computer shell 中运行。',
    workspace: true, schema: TerminalsConfig, defaults: {},
    validate: config => {TerminalsConfig(config);},
    mount: async ctx => {await ctx.plugin(Terminals);},
  },
  {
    id: 'terminal-bash', package: '@deepseek-ai/dsh-terminal-bash', module: TerminalBash, title: 'Bash 终端后端',
    description: '官方 bash 终端后端；每条命令在新的 just-bash 中运行，变量、别名、函数与工作目录在命令之间保持。',
    workspace: true, schema: TerminalBash.Config, defaults: {},
    validate: config => {TerminalBash.Config(config as unknown as TerminalBash.Config);},
    mount: async (ctx, config) => {await ctx.plugin(TerminalBash, TerminalBash.Config(config as unknown as TerminalBash.Config));},
  },
  {
    id: 'persistent-bash', package: '@deepseek-ai/dsh-tool-bash-persistent', module: PersistentBash, title: '持久 Bash',
    description: '官方持久 bash 工具；Agent 在同一个终端会话中连续执行命令。',
    workspace: true, schema: PersistentBash.Config, defaults: {},
    validate: config => {PersistentBash.Config(config as unknown as PersistentBash.Config);},
    mount: async (ctx, config) => {await ctx.plugin(PersistentBash, PersistentBash.Config(config as unknown as PersistentBash.Config));},
  },
  {
    id: 'tool-web', module: ToolWeb, title: '网页搜索与抓取',
    description: '官方 web_search 与 web_fetch；搜索使用环境的 DeepSeek 密钥，抓取经 workerd 访问公网。',
    workspace: false, schema: ToolWeb.Config, defaults: {fetch: true, searchTimeoutMs: 60000},
    validate: config => {ToolWeb.Config(config);},
    mount: async (ctx, config) => {await ctx.plugin(ToolWeb, ToolWeb.Config(config));},
  },
  {
    id: 'tool-ask-user', module: AskUser, title: '向用户提问',
    description: '官方 ask_user_question 工具；问题卡片由官方客户端回答。',
    workspace: false, schema: AskUser.Config, defaults: {},
    validate: config => {AskUser.Config(config);},
    mount: async (ctx, config) => {await ctx.plugin(AskUser, AskUser.Config(config));},
  },
  {
    id: 'compaction-basic', module: BasicCompaction, title: '上下文压缩',
    description: '官方自动上下文压缩；按 token 压力摘要较早的历史。',
    workspace: false, schema: BasicCompaction.Config, defaults: {},
    validate: config => {BasicCompaction.Config(config);},
    mount: async (ctx, config) => {await ctx.plugin(BasicCompaction, BasicCompaction.Config(config));},
  },
  {
    id: 'command-compact', module: CommandCompactBundle, title: '/compact 命令',
    description: '官方手动压缩命令，使用当前预设的压缩服务。',
    workspace: false, schema: CommandCompactBundle.Config, defaults: {},
    validate: config => {CommandCompactBundle.Config(config);},
    mount: async ctx => {await ctx.plugin(CommandCompact);},
  },
  {
    id: 'tool-result-pruner', package: '@deepseek-ai/dsh-compaction-tool-result-pruner', module: ToolResultPruner, title: '工具结果裁剪',
    description: '官方超长工具结果裁剪，保留首尾内容。',
    workspace: false, schema: ToolResultPruner.Config, defaults: {thresholdChars: 8192, headChars: 4096, tailChars: 1024},
    validate: config => {ToolResultPruner.Config(config);},
    mount: async (ctx, config) => {await ctx.plugin(ToolResultPruner, ToolResultPruner.Config(config));},
  },
  {
    id: 'tool-subagent', module: Subagent, title: '子 Agent',
    description: '官方委派工具；spawn 创建独立上下文，fork 继承已完成的父会话。',
    workspace: true, schema: Subagent.Config, defaults: {provider: 'spawn'},
    validate: config => {
      const value = Subagent.Config(config as unknown as Subagent.Config);
      if (!['spawn', 'fork'].includes(value.provider)) throw new Error('Unsupported subagent provider');
    },
    mount: async (ctx, config) => {await ctx.plugin(Subagent, Subagent.Config(config as unknown as Subagent.Config));},
  },
  {
    id: 'tool-subagent-fork', package: '@deepseek-ai/dsh-tool-subagent', module: Subagent, title: '子 Agent 分叉',
    description: '官方 subagent_fork 工具；子 Agent 继承已完成的父会话上下文。',
    workspace: true, schema: Subagent.Config, defaults: {provider: 'fork', toolName: 'subagent_fork'},
    validate: config => {
      const value = Subagent.Config(config as unknown as Subagent.Config);
      if (value.provider !== 'fork') throw new Error('Unsupported subagent provider');
    },
    mount: async (ctx, config) => {await ctx.plugin(Subagent, Subagent.Config(config as unknown as Subagent.Config));},
  },
  {
    id: 'tool-subagent-list-agents', package: '@deepseek-ai/dsh-tool-subagent-control', module: ListAgentsBundle, title: '子 Agent 列表',
    description: '官方 list_agents 工具；列出当前会话的子 Agent。',
    workspace: true, schema: ListAgentsBundle.Config, defaults: {},
    validate: config => {ListAgentsBundle.Config(config);},
    mount: async ctx => {await ctx.plugin(ListAgents);},
  },
  {
    id: 'tool-subagent-control', module: SubagentControlBundle, title: '子 Agent 控制',
    description: '官方 send_message 与 interrupt_agent 工具。',
    workspace: true, schema: SubagentControlBundle.Config, defaults: {},
    validate: config => {SubagentControlBundle.Config(config);},
    mount: async ctx => {await ctx.plugin(SubagentControl);},
  },
  {
    id: "tool-todo",
    module: Todo,
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
    module: Time,
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
    id: "persona",
    module: Persona,
    title: "人设",
    description: "把预设的人设写入系统提示，可选择完全替换默认提示或省略运行时上下文。",
    workspace: false,
    schema: Persona.Config,
    defaults: { prefix: "You are a coding agent powered by the {{model}} model." },
    validate: (config) => { personaConfig(config); },
    mount: async (ctx, config) => {
      await ctx.plugin(Persona, personaConfig(config));
    },
  },
  {
    id: "repeat-tool-reminder",
    module: Repeat,
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
    module: SkillTool,
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
    // A Session without preset realms has no skill-filesystem row; the tool brings the catalog itself.
    mount: mountSkills,
  },
  {
    id: 'skill-filesystem', package: '@deepseek-ai/dsh-skill-filesystem', module: SkillCatalogBundle, title: 'Skills 目录',
    description: '官方 SKILL.md 发现；目录为环境工作区的 /workspace/.agents/skills。',
    workspace: true, schema: SkillCatalogBundle.Config, defaults: {},
    validate: config => {SkillCatalogBundle.Config(config);},
    // tool-skill mounts the catalog where no preset realm composes this row.
    mount: async () => {},
  },
  {
    id: 'tool-fs', package: '@deepseek-ai/dsh-tool-fs', module: FileToolsBundle, title: '文件工具',
    description: '官方 read、write、edit 与 read_image；文件在环境工作区的 Computer 卷上。',
    workspace: true, schema: FileTools.Config, defaults: {},
    validate: config => {FileTools.Config(config as unknown as FileTools.Config);},
    // The workspace provider mounts the file tools where no preset realm composes this row.
    mount: async () => {},
  },
];
export const prebuiltPluginModules = Object.fromEntries(entries.map(entry => [entry.id, entry.module]));
/** The upstream package of each prebuilt row whose package name is not its row id's official package. */
export const prebuiltPluginPackages: Record<string, string> = Object.fromEntries(entries.flatMap(entry => entry.package === undefined ? [] : [[entry.id, entry.package]]));

export const pluginCatalog = entries.map(
  ({ id, package: name, title, description, workspace, schema, defaults }) => ({
    id,
    package: name ?? `@deepseek-ai/dsh-${id}`,
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
    // A disabled row is an official row Weft lists but does not load; it needs no catalog entry.
    if (selection.disabled) {
      if (seen.has(selection.id)) throw new Error("Unknown or duplicate plugin");
      seen.add(selection.id);
      continue;
    }
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
    if (selection.disabled) continue;
    const entry = entries.find((item) => item.id === selection.id);
    if (!entry)
      throw new Error(
        "Published plugin is unavailable; review upstream compatibility",
      );
    await entry.mount(ctx, selection.config);
  }
}
