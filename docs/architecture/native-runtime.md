# 原生运行时重构：Profile 装配、D1 配置面与 Computer 执行后端

状态：方案，待实施。目标是在 Cloudflare Workers / Durable Objects 上原生运行 deepseek-harness：插件由官方 profile 装配，Weft 只替换平台相关的条目。

## 背景

DeepSeek Harness 的所有能力都是插件，由 Cordis Loader 按 profile（`base` + `web-app` 两个 bundle patch，共 184 个条目）装配。Weft 目前只在 Agent 预设内部使用 Loader（`WorkerdLoader`）；根级服务是手写的 `ctx.plugin(...)` 清单，部分能力用自写实现代替（DeepSeek 适配器、写死的提供商目录）。后果是：约 20 个官方插件缺失（模型重试、增量会话日志、spill、超时、会话统计、轮次大纲、工作区改动、MCP 资源、workflow 等），思考等级曾被锁定，第三方模型提供商（`llm-pi-ai`）没有接通。

## 1. Profile 驱动装配

- 用 `WorkerdLoader` 加载官方 `base` 与 `web-app` bundle patch，模块来自构建期静态模块表，不读磁盘。
- Weft 增加一层覆盖 patch（官方 profile 的标准机制），只做三类修改：
  - **替换平台条目：** `session-persistence-jsonl` → DO SQLite 持久化；`credentials-local` → 环境凭据；`subprocess-local` / `sandbox-local` / `bash-sandbox` → Computer 执行后端；`storage-json` / `spill-local` → DO 存储；`settings` → 环境设置。
  - **禁用桌面、遥测与开发条目：** `otel`、`session-telemetry-otel`、`open-in-app`、`directory-picker`、`desktop-product-telemetry`、`harness-dev-context`、PowerShell。
  - **调整部署选择：** 例如 HTTPS 端点要求。
- 构建期平台替换继续沿用现有方式（`scripts/native-*-platform.mjs`），只处理在模块加载时就用到 Node API 的包。
- **世界划分：** 原版 Host 是一个进程托管所有会话；Weft 把同一份 profile 拆到两类对象：
  - **EnvironmentDO（环境级）：** 设置、凭据、模型目录（`llm` 目录与发现）、插件管理与市场、Remote Access、事件中心。
  - **SessionDO（会话级）：** Agent、会话日志、工具、预设、会话投影。
  - 两边各自加载 profile，按条目的服务归属启用；跨对象调用沿用现有 RPC。
- **模型：** 直接使用官方 `llm-deepseek-api-key` 与 `llm-pi-ai` 条目，删除自写的 `SafeDeepSeekAdapter` 与写死的提供商目录。第三方提供商（OpenAI、Anthropic、Kimi 等）、思考等级与重试策略按原版工作。pi-ai 1.1.0 打包后增加约 315 KiB（gzip 后），已验证可打包。

## 2. D1 配置面

配置类数据集中到 D1，便于跨环境管理与查询；运行时状态继续留在 Durable Object。

| 放 D1 | 留在 DO |
| --- | --- |
| 租户与环境注册表 | 会话日志与投影（SessionDO SQLite） |
| Agent 组合（预设定义与版本） | 工作区文件（Computer VFS，WorkspaceDO） |
| 工作区注册表与会话-工作区归属 | 实时事件中心、流、waterfall |
| 环境设置文档（非密钥字段） | 调度提醒（DO Alarm） |
| | 会话索引（标题、更新时间、所属 Agent；EnvironmentDO SQLite） |
| | 凭据（EnvironmentDO，见下） |

- **访问方式：** 仓储层封装 D1，所有查询带 `tenant_id` 与 `environment_id` 条件；写入经 EnvironmentDO 串行化，保持设置 revision 与冲突检测语义。
- **迁移：** 使用 D1 migrations（`migrations/` 目录），本地由 miniflare 提供 D1。本轮沿用全新数据布局，不迁移旧 DO 数据。
- **会话索引：** 会话只属于一个环境，也只经它读取，所以索引留在 EnvironmentDO 自己的 SQLite（`session_index` 表），创建与更新会话不再跨区域写 D1。D1 的 `session_index` 表由迁移 `0006` 删除，旧索引行不保留。
- **凭据：** 存于 EnvironmentDO，不进入 D1，保持密钥与可查询配置分离（已确认）。

## 3. Computer 执行后端

Workspace 同时注册三种后端，由 `workspace.runtime.exec(source, {backend})` 选择：

| 后端 id | 实现 | 用途 |
| --- | --- | --- |
| `container-shell` | `@cloudflare/computer/backends/container`，Container 运行 `computerd`，由 WorkspaceDO 调度 | 真实 Linux：bash、git、ripgrep、node/npm；`tool-fs-search`、`workspace-changes`（git 快照）、插件打包；可在镜像中加入 LibreOffice 供 `office-to-pdf` 使用 |
| `worker-shell` | `@cloudflare/computer/backends/worker-shell`（现有） | 低延迟 bash 与 Terminal，无需容器 |
| `worker-javascript` | `@cloudflare/computer/backends/worker-javascript` | 隔离的 ESM 执行，可读写工作区文件 |

- Harness 的 `subprocess` 接口按环境设置选择 shell 后端（`container-shell` 或 `worker-shell`），两者看到同一工作区文件。
- 现有的沙箱策略（私有区、符号链接、read-only / workspace-write / danger-full-access）继续在 WorkspaceDO 的文件观察器中执行，对三种后端一致生效。
- Container 后端需要镜像与 `containers` 配置；没有配置时环境只提供 `worker-shell` 与 `worker-javascript`。

## 实施顺序

1. **模型链路（已完成）：** 官方 `llm-deepseek-api-key` + `llm-pi-ai` 作为 Loader 条目，环境级模型目录与发现，会话挂载；设置中加入 `llm-pi-ai` 命名空间；匿名 id 与 DeepSeek 上传索引改为环境级 harness home。详见 [模型验证](../validation/model.md)。
2. **Profile 装配（进行中）：** 构建期把官方 `base` + `web-app` bundle patch 转成 JSON，以原版 `applyEntryPatches` 合成 184 个条目，再叠加 `packages/harness-profile/src/overlay.ts`。覆盖层把每个 Host 条目归入一张表（`LOADED`、`MOUNTED_BY_WEFT`、`PLATFORM`、`NOT_APPLICABLE`、`EXTERNAL`、`PENDING`），浏览器条目由 Boot Graph 提供，预设级条目由预设装配启用；构建在条目未分类、表中名称失效或启用条目残留 `!!js` 时失败（workerd 不执行动态代码，`!!js` 由覆盖层固定为部署事实）。只有启用条目的模块进入 Worker（`weft:official-modules`）。已由会话 Loader 加载：`timer`、`llm-retry`、`deepseek-llm-api-extensions`、`session-log-deepseek`、`session-title-llm`、`timeout-policy`、`session-checkpoint-policy`、`image-offload`、`session-stats`、`session-turn-outline`。`MOUNTED_BY_WEFT` 中的条目逐步迁移为 Loader 加载。
3. **D1 配置面（已完成）：** `CONFIG_DB` 绑定与 `migrations/`（`cf d1 migrations apply` 记录已应用的文件；测试按同样方式应用）。已迁入 D1：环境设置（`environment_settings`）、Agent 组合版本（`agent_revisions`）、环境注册表（`environments`）、工作区注册表（`workspace_state`、`workspaces`）。EnvironmentDO 按对象名得到租户与环境，激活时载入本环境的行到缓存；写入经 EnvironmentDO 串行执行并以 revision 或主键为条件，预设发布与默认预设设置共用一个写入队列，检查与写入看到同一状态；工作区事务在副本上修改，变更行以一个 D1 batch 原子提交。留在 Durable Object 的是凭据、运行时拓扑（子会话归属、插件运行请求）、harness home 状态与代码产物（客户端插件模块、原生插件定义，单个模块可能超过 D1 的行大小上限）。
4. **执行后端：**
   - **PTC 运行时（已完成）：** `packages/native-ptc` 提供 `ctx.ptcRuntime`（`language: 'typescript'`，`isolation: 'dynamic-worker'`），覆盖层把 `ptc-runtime` 归入 `PLATFORM`。每次 `run_code` 由 SessionDO 的 Worker Loader 起一个新的 Dynamic Worker（`globalOutbound: null`，无文件系统），程序经 sucrase 擦除类型后作为模块加载，程序中 `import("data:text/javascript,…")` 引入的内联模块成为同一 isolate 的模块；程序只能经绑定访问文件，所以运行时报告会话的文件策略模式；`tools` 绑定通过 RPC 回到会话世界执行，所以审批、权限与工具日志与原生调用一致。失败按原版分类返回（`exception`、`timeout`、`abort`、`invalid-output`、`output-limit`、`worker-exit`）。运行时直接放在会话里而不经 WorkspaceDO：绑定是会话内的闭包，程序访问文件也走 `tools`。PTC 模式（`tool-presentation`，`mode: 'ptc'`）因此可用。
   - **workflow（已完成）：** 官方 `workflow-ptc` 原本用 `node:vm` 在宿主侧解析脚本、在 guest 中执行脚本。`scripts/native-workflow-platform.mjs` 在构建期做三处替换：宿主侧解析改用 acorn；PTC 程序把脚本体编进同一模块（Dynamic Worker 加载时编译，Workers 不在运行时求值源码）；guest 的 `vm.Script` 收到这个已编译的函数并以官方钩子（`agent`、`parallel`、`pipeline`、`phase`、`log`、`args`）调用。guest 由同一份官方源码重新打包。限制、子 Agent、进度与结果仍是官方代码；脚本以严格模式运行。预设装配沿用官方 `delegation` 分组（`isolate: {workflowEngine: true}`）。`tests/native-workflow.test.ts` 验证脚本派生子 Agent 并返回结果。
   - **持久 shell（已完成）：** 极简模式的官方 `pty`（`dsh-terminal`）、`terminal-bash` 与 `persistent-bash` 运行在 `packages/workspace/src/subprocess.ts` 的行模式终端上。每条命令仍在新的 just-bash 中执行；命令结束时脚本报告变量（`declare -p`）、别名、函数与工作目录，下一条命令先回放这些状态，再执行 `PROMPT_COMMAND`，所以官方 `133;D;<status>` 提示符标记与 `dsh> ` 提示符照常出现。Computer 内置的 just-bash 在 `type` 输出中丢失参数展开，终端因此保留每个函数定义的原文。`inspectForeground` 在空闲时返回 shell 自己的进程组。官方 `sandbox` 服务由 `WorkspaceSandbox` 提供：`confine` 把文件策略写入 argv 前缀，子进程接口把它交给 WorkspaceDO 的文件观察器执行。已知限制：被沙箱拒绝的重定向会结束整条命令（just-bash 把文件系统错误作为致命错误），终端随后补跑 `PROMPT_COMMAND`，工具输出中会带有命令回显；全屏程序与交互式子进程不可用。`tests/native-persistent-shell.test.ts` 验证这些行为。
   - `container-shell` 接 bash、搜索、git 与 Office 转 PDF，提供后端选择设置。

每一步单独测试、单独提交；部署（含创建 D1 数据库与 Container 应用）在每步完成后另行确认。

## 部署前提

- `cf` 命令行的 OAuth 凭据具备 D1 与 Containers 读写权限；账号已有 Container 应用在运行。
- 创建 D1 数据库、Container 应用与部署在各步完成后另行确认；Container 镜像与实例规格在第 4 步确定。
