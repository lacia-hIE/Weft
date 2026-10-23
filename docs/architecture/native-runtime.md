# 原生运行时重构：Profile 装配、环境存储与 Computer 执行后端

状态：方案，待实施。目标是在 Cloudflare Workers / Durable Objects 上原生运行 deepseek-harness：插件由官方 profile 装配，Weft 只替换平台相关的条目。

## 背景

DeepSeek Harness 的所有能力都是插件，由 Cordis Loader 按 profile（`base` + `web-app` 两个 bundle patch，共 184 个条目）装配。Weft 目前只在 Agent 预设内部使用 Loader（`WorkerdLoader`）；根级服务是手写的 `ctx.plugin(...)` 清单，部分能力用自写实现代替（DeepSeek 适配器、写死的提供商目录）。后果是：约 20 个官方插件缺失（模型重试、增量会话日志、spill、超时、会话统计、轮次大纲、工作区改动、MCP 资源、workflow 等），思考等级曾被锁定，第三方模型提供商（`llm-pi-ai`）没有接通。

## 1. Profile 驱动装配

- 用 `WorkerdLoader` 加载官方 `base` 与 `web-app` bundle patch，模块来自构建期静态模块表，不读磁盘。
- Weft 增加一层覆盖 patch（官方 profile 的标准机制），只做三类修改：
  - **替换平台条目：** `session-persistence-jsonl` → DO SQLite 持久化；`credentials-local` → 环境凭据；`subprocess-local` / `sandbox-local` / `bash-sandbox` → Computer 执行后端；`storage-json` → DO 存储；`spill-local` → 工作区 spill 存储（`packages/workspace/src/spill.ts`：超出 `spill-policy` 预算的工具结果写入 `/workspace/.dsh/spill/session-*/`，模型用文件工具读回；超过单次写入上限的文本按顺序分片存放；目录内 `.gitignore` 使其不进入 git 与改动快照；每个 Session 启动时按原版规则清理 30 天前的溢出文件（WorkspaceDO 的 `sweep` 操作只作用于溢出区，并清掉清空的目录）；bash 等命令超出内存上限的输出也完整保存到 `/workspace/.dsh/spill/output/`，结果里报告该路径，单条流最多保留 8 MiB，`tests/native-spill.test.ts`）；`settings` → 环境设置。
  - **禁用桌面、遥测与开发条目：** `otel`、`session-telemetry-otel`、`open-in-app`、`directory-picker`、`desktop-product-telemetry`、`harness-dev-context`、PowerShell。
  - **调整部署选择：** 例如 HTTPS 端点要求。
- 构建期平台替换继续沿用现有方式（`scripts/native-*-platform.mjs`），只处理在模块加载时就用到 Node API 的包。
- **世界划分：** 原版 Host 是一个进程托管所有会话；Weft 把同一份 profile 拆到两类对象：
  - **EnvironmentDO（环境级）：** 设置、凭据、模型目录（`llm` 目录与发现）、插件管理与市场、Remote Access、事件中心。
  - **SessionDO（会话级）：** Agent、会话日志、工具、预设、会话投影。
  - 两边各自加载 profile，按条目的服务归属启用；跨对象调用沿用现有 RPC。
- **模型：** 直接使用官方 `llm-deepseek-api-key` 与 `llm-pi-ai` 条目，删除自写的 `SafeDeepSeekAdapter` 与写死的提供商目录。第三方提供商（OpenAI、Anthropic、Kimi 等）、思考等级与重试策略按原版工作。pi-ai 1.1.0 打包后增加约 315 KiB（gzip 后），已验证可打包。

## 2. 平台目录与环境本地数据

D1 只管理环境之外的平台抽象，目前保存环境目录与租户归属。环境内部配置和业务状态由其 Durable Object 持有；用户、成员关系和配额等后续平台模型可放在 D1，不把环境内的插件设置同步回 D1。

| 存储位置 | 权威数据 |
| --- | --- |
| D1 / TenantDO 目录 | 环境 ID、显示名称、租户归属和创建时间 |
| EnvironmentDO SQLite | 环境设置及修订号、预设发布版本、工作区登记与会话归属、会话索引、凭据、插件安装审批 |
| SessionDO SQLite | 会话日志、投影、Inbox、冻结预设、提醒和会话插件状态 |
| WorkspaceDO / Computer | 文件、附件、执行任务与转换缓存 |

`packages/environment-storage` 提供当前环境的 SQLite 持久化适配器，不持有 D1 或租户路由。设置与预设发布共用写入队列，设置校验在本地事务读取的最新修订号上进行；工作区多行修改使用 `storage.transactionSync`，失败后数据库一起回滚，不维护另一份提交前缓存。预设按需查询当前版本，冷启动不再载入完整历史。

原版设置协议、Config schema、配置 YAML 与插件生命周期行为保持一致。`NativeSettings` 和 `NativeWorkspaces` 继续承担当前 Cloudflare 平台适配，并不宣称已替换为原版 SettingsForms 或 WorkspaceRegistry 的完整实现。后续向原版服务收敛时，优先复用现有的 `StorageBackend / StorageDomain` 和环境文件、会话读取服务，不恢复 D1 业务副本。

本轮使用新的 `harness-v2` 对象与浏览器存储地址，不导入旧配置、日志或文件卷。D1 迁移 `0007` 删除旧环境内部四类表，保留平台环境目录。完整边界、重置和验证见[环境数据归属](environment-storage.md)。

## 3. Computer 执行后端

Workspace 同时注册三种后端，由 `workspace.runtime.exec(source, {backend})` 选择：

| 后端 id | 实现 | 用途 |
| --- | --- | --- |
| `container-shell` | `@cloudflare/computer/backends/container-legacy`，Container 运行 `computerd`，由按规格划分的 `WorkspaceContainer*DO` 托管、WorkspaceDO 驱动 | 真实 Linux：bash、git、ripgrep、node 22、python 3；`tool-fs-search`；`workspace-changes`（git 快照与每轮改动卡片）；后续接 `office-to-pdf` |
| `worker-shell` | `@cloudflare/computer/backends/worker-shell`（现有） | 低延迟 bash 与 Terminal，无需容器 |
| `worker-javascript` | `@cloudflare/computer/backends/worker-javascript` | 隔离的 ESM 执行，可读写工作区文件 |

- Harness 的 `subprocess` 接口按环境设置选择 shell 后端（`container-shell` 或 `worker-shell`），两者看到同一工作区文件。
- Worker shell 的文件策略由 WorkspaceDO 观察器执行；容器真实进程由 dsh 原版 Linux sandbox runner 执行 read-only / workspace-write 策略，并报告实际 enforcement。私有附件不向容器同步。详见 [真实进程与 PTY](workspace-processes.md)。
- Container 后端需要镜像与 `containers` 配置；没有配置时环境只提供 `worker-shell` 与 `worker-javascript`。

## 实施顺序

1. **模型链路（已完成）：** 官方 `llm-deepseek-api-key` + `llm-pi-ai` 作为 Loader 条目，环境级模型目录与发现，会话挂载；设置中加入 `llm-pi-ai` 命名空间；匿名 id 与 DeepSeek 上传索引改为环境级 harness home。详见 [模型验证](../validation/model.md)。
2. **Profile 装配（进行中）：** 构建期把官方 `base` + `web-app` bundle patch 转成 JSON，以原版 `applyEntryPatches` 合成 184 个条目，再叠加 `packages/harness-profile/src/overlay.ts`。覆盖层把每个 Host 条目归入一张表（`LOADED`、`MOUNTED_BY_WEFT`、`PLATFORM`、`NOT_APPLICABLE`、`EXTERNAL`、`PENDING`），浏览器条目由 Boot Graph 提供，预设级条目由预设装配启用；构建在条目未分类、表中名称失效或启用条目残留 `!!js` 时失败（workerd 不执行动态代码，`!!js` 由覆盖层固定为部署事实）。只有启用条目的模块进入 Worker（`weft:official-modules`）。已由会话 Loader 加载：`timer`、`llm-retry`、`deepseek-llm-api-extensions`、`session-log-deepseek`、`session-title-llm`、`timeout-policy`、`session-checkpoint-policy`、`image-offload`、`session-stats`、`session-turn-outline`；只在原生会话加载（`native`）的有 `message-feedback`、`command-feedback`、`web`、`web-fetch-http`、`web-search-deepseek`（其 `baseURL` 经条目覆盖层跟随环境的 DeepSeek 端点）与 `repeat-tool-reminder`。`MOUNTED_BY_WEFT` 中的条目逐步迁移为 Loader 加载。
3. **环境本地持久化（已实现）：** 环境设置、预设版本和工作区登记改为 EnvironmentDO SQLite；D1 仅保存平台目录。EnvironmentDO 的 binding 类型不提供 D1，激活与环境内部操作不等待 D1。使用真实无 D1 binding 的环境验证配置冲突、隔离、工作区会话归属、预设升级与冷重启。
4. **执行后端：**
   - **PTC 运行时（已完成）：** `packages/native-ptc` 提供 `ctx.ptcRuntime`（`language: 'typescript'`，`isolation: 'dynamic-worker'`），覆盖层把 `ptc-runtime` 归入 `PLATFORM`。每次 `run_code` 由 SessionDO 的 Worker Loader 起一个新的 Dynamic Worker（`globalOutbound: null`，无文件系统），程序经 sucrase 擦除类型后作为模块加载，程序中 `import("data:text/javascript,…")` 引入的内联模块成为同一 isolate 的模块；程序只能经绑定访问文件，所以运行时报告会话的文件策略模式；`tools` 绑定通过 RPC 回到会话世界执行，所以审批、权限与工具日志与原生调用一致。失败按原版分类返回（`exception`、`timeout`、`abort`、`invalid-output`、`output-limit`、`worker-exit`）。运行时直接放在会话里而不经 WorkspaceDO：绑定是会话内的闭包，程序访问文件也走 `tools`。PTC 模式（`tool-presentation`，`mode: 'ptc'`）因此可用。
   - **workflow（已完成）：** 官方 `workflow-ptc` 原本用 `node:vm` 在宿主侧解析脚本、在 guest 中执行脚本。`scripts/native-workflow-platform.mjs` 在构建期做三处替换：宿主侧解析改用 acorn；PTC 程序把脚本体编进同一模块（Dynamic Worker 加载时编译，Workers 不在运行时求值源码）；guest 的 `vm.Script` 收到这个已编译的函数并以官方钩子（`agent`、`parallel`、`pipeline`、`phase`、`log`、`args`）调用。guest 由同一份官方源码重新打包。限制、子 Agent、进度与结果仍是官方代码；脚本以严格模式运行。预设装配沿用官方 `delegation` 分组（`isolate: {workflowEngine: true}`）。`tests/native-workflow.test.ts` 验证脚本派生子 Agent 并返回结果。
   - **持久 shell（已完成）：** Worker 模式下，极简模式的官方 `pty`（`dsh-terminal`）、`terminal-bash` 与 `persistent-bash` 运行在 `packages/workspace/src/subprocess.ts` 的行模式终端上。每条命令仍在新的 just-bash 中执行；命令结束时脚本报告变量（`declare -p`）、别名、函数与工作目录，下一条命令先回放这些状态，再执行 `PROMPT_COMMAND`，所以官方 `133;D;<status>` 提示符标记与 `dsh> ` 提示符照常出现。Computer 内置的 just-bash 在 `type` 输出中丢失参数展开，终端因此保留每个函数定义的原文。`inspectForeground` 在空闲时返回 shell 自己的进程组。官方 `sandbox` 服务由 `WorkspaceSandbox` 提供：`confine` 把文件策略写入 argv 前缀，子进程接口把它交给 WorkspaceDO 的文件观察器执行。已知限制：被沙箱拒绝的重定向会结束整条命令（just-bash 把文件系统错误作为致命错误），终端随后补跑 `PROMPT_COMMAND`，工具输出中会带有命令回显；全屏程序与交互式子进程不可用。`tests/native-persistent-shell.test.ts` 验证这些行为。
   - **container-shell（已实现）：** 镜像在 `apps/workspace-container/Dockerfile`（官方 `computerd` 镜像加 Debian、git、ripgrep、node 22、python 3），由 `scripts/workspace-container.mjs` 构建并推送到账号的 Cloudflare 镜像仓库，镜像地址记在 `image.json`，构建时校验它与 Dockerfile 和 `@cloudflare/computer` 版本一致。配置语言按 Worker 名绑定每个 Durable Object，而带 `script_name` 的绑定不能托管 Container，所以容器由不声明绑定的宿主对象托管（经 `ctx.exports` 访问），WorkspaceDO 的 `LegacyContainerBackend` 通过 RPC 驱动它。账号未开通 Durable Object 调度的镜像预备，因此使用普通调度：每个可选规格（`basic`、`standard-1`、`standard-2`）是一个独立的 Container 应用和对应的宿主类；computerd 经 `WorkspaceProxy` 回连 WorkspaceDO，文件与执行仍属于该工作区。环境设置 `workspace-runtime` 选择 bash 与终端的后端和容器规格（默认 `basic`，下次启动生效）：`auto`（默认）从 Worker shell 开始，Agent 用 `workspace_runtime` 工具按任务切到容器或切回（选择记在 SessionDO，`packages/workspace/src/runtime-choice.ts`）；`worker` 禁止使用容器，不提供切换工具，ripgrep 文件搜索被拒绝；`container` 始终在容器中运行，在 设置 → 插件 → 工作区运行环境 中编辑（Weft 扩展用官方 `configForms` 与设置表单组件注册的 `plugins.item` 页，`tests/browser/workspace-runtime.spec.ts`），也可写在配置文件里，容器空闲 10 分钟后休眠：平台的空闲计时从宿主对象最后一次收到请求算起，而命令经 computerd 与 WorkspaceDO 的连接进入容器，所以 WorkspaceDO 在每条容器命令开始时及运行期间每分钟调用宿主的 `touch()`，计时因此从最后一条容器命令结束算起。computerd 回连工作区的出站拦截使用保留地址 `198.18.0.1`：容器可直接上网时主机名走公网解析，默认的 `computer.internal` 解析不到，回连会一直挂起；对容器端口的每个请求限时 60 秒，连不上时命令明确失败、宿主对象不被挂住。官方 `tool-fs-search` 的 ripgrep 固定在容器中运行。容器的 Harness subprocess 与终端通过内部 WebSocket 连接 `processd`，复用原版 LocalSubprocessRuntime、node-pty 与 sandbox-local；只读模式也在容器中由 Linux sandbox runner 执行。进程写入在运行期间及退出确认前同步到 WorkspaceDO，并推进文件版本；Weft 私有附件区 `/.weft` 在容器里是本地路径，既读不到也不同步。没有容器的部署选择容器时会明确报错（`tests/native-workspace-runtime.test.ts`）。环境使用容器 shell 时，Weft 挂载官方 `workspace-changes` 与 `ui-deliverables` 的宿主部分：构建期 `scripts/native-changes-platform.mjs` 把 recorder 的 `node:fs/promises`、`node:os` 换成 `packages/workspace/src/container-fs.ts`，它的临时目录、git 快照与文件捕获都在容器内（`/tmp`），每个监听器在所属 Session 的容器作用域中运行；`/api/changes.summary`、`/api/changes.diff` 由入口转发到该 Session 的 SessionDO，打开本机文件的路由回答没有宿主桌面（`409`），`present.host` 报告 `available: false`。切回 worker shell 时两者在下一轮前卸载，已公布的摘要不再提供（`tests/native-workspace-changes.test.ts` 用本机 sh 与 git 代替容器验证官方 recorder）。
   - **真实进程与 PTY（已实现）：** 普通 argv、流式 stdin/stdout/stderr、fd7、终端 resize、前台信号与会话级进程清理由原版 dsh 提供。适配层负责鉴权、会话归属、重连序号与文件同步；范围和本地验证见 [真实进程与 PTY](workspace-processes.md)。Office 转 PDF 尚待接入。

每一步单独测试、单独提交；部署（含创建 D1 数据库与 Container 应用）在每步完成后另行确认。

## 部署前提

- `cf` 命令行的 OAuth 凭据具备 D1 与 Containers 读写权限；账号已有 Container 应用在运行。
- 创建 D1 数据库、Container 应用与部署在各步完成后另行确认；Container 镜像与实例规格在第 4 步确定。
