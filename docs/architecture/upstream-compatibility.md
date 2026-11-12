# Harness 兼容性与维护

当前目标为 **DSH `0.2.2-rc.2`**，提交 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`。这是固定的适配基线，不随 npm `latest` 或上游分支自动更新；云端内核、原版前端和 Remote ABI 一起升级。

0.2.2 相对 0.2.1 含破坏性变化，云端运行时不执行 0.2.1 来源的修订。rc.2 可以原地读取 rc.1 的会话日志，因此 rc.1 时期创建的会话在 rc.2 运行时继续运行（见下文）。本地 Host 连接插件 0.5.1 接受 `0.2.2-rc.1` 与 `0.2.2-rc.2`，0.5.0 只接受 rc.1。连接协议仍为 3。CI 对这两个版本分别启动 npm 发布的原版 Web Host，并以 `desktop` profile 验证桌面 Host 启动方式、原生文件、Git、PTY 与刷新恢复；它们要求 Node 24.9 或更高。`engines.dsh` 仍是安装器、Host、中继及 UI 共用的精确清单，不接受未经审查的后续版本。

upstream.lock.json 固定 commit。服务端插件、模型协议、浏览器内核、UI 控件与样式从同一份源码构建。prepare-upstream.mjs 保留用户现有 checkout，必要时使用独立固定副本；所有公共及内部导入均指向同一副本。管理的副本若版本不匹配或有 tracked 修改则停止。升级需显式审查兼容契约。

| 适配边界 | 职责 |
| --- | --- |
| `packages/harness-runtime`、`apps/worker/src/native-session-host.ts` | 原生 Agent 创建、恢复、turn 生命周期与会话所有权 |
| `packages/native-profile`、`packages/harness-profile` | 原版配置、插件分类、workerd Loader 与装配顺序 |
| `packages/environment-storage`、`packages/control-plane` | 环境本地持久化、预设发布、Session 索引及平台目录 |
| `packages/native-plugins`、`packages/package-install` | 隔离 Host 插件、标准 `dsh.bundle.patch` 安装、版本审批与生命周期 |
| `packages/native-composition` | 原版预设、插件清单、可选 bundle 与平台配置装配 |
| `apps/web/src/official`、`apps/web/src/runtime` | 原版浏览器入口、Weft 环境插件与共享 ESM 导出面 |
| `scripts/generate-official-remotes.mjs` | 从同一份源码生成并校验官方 Remote ABI |
| `scripts/build-official-ui.mjs`、`scripts/prepare-official-boot.mjs` | 使用上游构建预设生成 Client 模块，并用原版解析器验证 Boot Graph |

Weft 实现 Access、DO 存储、Workspace FileSystem、凭据、HTTP/SSE 和发布；上游实现 AgentLoop、Tools、Session、投影、Cordis、Slots、Store 和 UI 原子组件。

浏览器使用原版 Client 装配和工作台，通过生成的 Remote 契约访问所属环境。Weft 以普通插件增加环境入口及平台能力。Host 插件在隔离 Dynamic Worker 中运行，通过明确桥接的服务访问所属会话；未实现能力在插件清单中说明，不因升级自动获得本机或系统访问权限。

升级验收：

1. 审查 Session/Tools/FileSystem/Config/Slot/Store/Renderer 接口及内部 UI 引用路径。
2. 审查构建中版本加载与 provider fetch 两个适配锚点；锚点变化会使构建失败。
3. 执行严格类型检查、workerd 和浏览器生命周期测试，检查 runtime-audit.json 的 Node imports、插件包、UI 与执行依赖。
4. 在 CI 使用脚本模型验证原版工具与插件的真实 workerd 执行、浏览器交互、手机与深色模式。真实模型验证需单独配置凭据，不能把无密钥 CI 当作实模验收。
5. 审查旧发布及持久事件。revision 保留来源 upstream commit；仅允许当前提交及下方列出的已审查来源继续执行，其他版本仍拒绝。旧日志读取不等于允许旧版本运行。

vendor 使用独立声明；上游 repeat-tool-reminder 的 broad-union 类型问题、仅类型引用的 Node Gateway 也通过声明边界消费。生产仍打包原始模块，Weft 核心代码保持严格检查，相关行为由 workerd 测试覆盖。

Cordis 兼容不自动提供浏览器、Node 主机、进程或真实 Shell 能力。扩展任意生态包时先判定宿主需求，建立适配与验收后加入目录。

## 0.2.2-rc.1 → 0.2.2-rc.2 的兼容范围

rc.1（`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）→ rc.2 的审查覆盖完整 Git diff 与上游 `docs/upgrade-guide` 中 0.2.2-rc.1 之后的契约说明。Session V4 存储格式未变；rc.2 新增的 `team/mode` 选择、重试与结算归属、具名子代理目录都可从旧记录读取，`packages/harness-runtime/src/revision.ts` 因此把 rc.1 列为已审查来源：rc.1 时期的修订与会话在 rc.2 运行时继续执行，不重新发布。

| 上游变化 | Weft 适配 |
| --- | --- |
| Agent Teams 从实验性可选 bundle（`agent-team-profile`）并入 base 与 web-app bundle；团队模式改为每个根会话保存的开关（`agentTeams/setEnabled`），默认关闭；队友即具名子代理，消息按名称投递，根代理名为 `lead` | 每个会话的原生根世界都挂载 `agent-team`（`maxTasks: 256`）与 `tool-agent-team`；`agentTeams` Remote 按 Agent 路由到所属 SessionDO；原版 `ui-agent-team` 进入 Boot Graph，不再按环境筛选。环境里已登记的旧 bundle 在注册表打开时移除；旧修订与环境预设里残留的 Team 行在装配和迁移时丢弃 |
| `office-to-pdf` 改为 `office-kit`（渲染、转换、重算），新增 `tool-office` 与 `skill-office`；`tool-office` 进入 standard 与 ptc 预设 | 三者都等待 LibreOffice Container：`office-kit`、`skill-office` 列为外部服务；`tool-office` 列入 `PRESET_PENDING`，在预设中显示但停用。它的工具只在 Office 技能加载后才出现，所以停用不影响其他工具 |
| 新增 `mcp-manager`，按设置启动 stdio MCP 服务器 | 由环境的 `mcp-servers` 设置为每个会话挂载原版 `dsh-mcp-client`（远程服务器），不挂载 `mcp-manager` |
| `workspace-dependencies` 管理桌面版主 Python 运行时 | 列为不适用 |
| Web search：`deepseek-official` 搜索 provider 改名为 `deepseek-search-api`，凭据改为有序来源；移除 Exa 与 Perplexity 搜索插件 | 预设检查世界使用新 provider 名；Weft 未接入被移除的搜索插件 |
| 子代理用户控制改为只指明目标会话（`subagents/interruptByUser`、`subagents/prompt` 不再带父会话）；`waitForChildren` 改为 `waitForTreeWork` | 入口按子会话找到所属树的根 SessionDO，并在其中校验目标确属该树 |
| 内置预设给 `tool-subagent-control` 加上 `interrupt: false`，子代理与团队模式默认不提供 `interrupt_agent` | 目录改用该插件的原版 Config 校验并带配置挂载，复制官方预设发布的自定义预设也能通过校验 |
| Web 搜索设置页改为按 `web/listProviders` 列出的 provider 选择，并按能力分设计费、端点与密钥（`searchBaseURL` / `searchApiKeyEnv`、`fetch*`） | 入口在临时世界中挂载原版 `web` 与三个固定的 provider 行后回答 `web/listProviders`；该世界不搜索也不抓取 |
| DeepSeek Search / Fetch API 按入口 id 与包名（`@deepseek-ai/dsh-llm-deepseek-api-key`）寻找 API-key 模型路由，找不到时退回官方地址并发送 `DEEPSEEK_API_KEY` | Weft 的模型入口改用原版包名注册，Search / Fetch 跟随环境所配 DeepSeek 端点的 origin（`/v1/tools`），不会把自定义端点的密钥发往官方地址 |
| 侧栏终端以 `terminal/watch` 流订阅会话终端列表 | 与 `job/list` 一样走可休眠 WebSocket；未改时这条常开 HTTP 流会让 SessionDO 无法休眠 |
| `BundleInfo.updatable` 改为 `update` | 各插件清单不再输出该字段 |
| `workspaceFiles/search` 新增；ripgrep 路径解析移入 `dsh-util-ripgrep` | 原生文件 Host 转发搜索；构建时在新位置替换 ripgrep 路径解析，仍使用容器镜像里的 `rg` |
| 插件市场导入 `dsh-plugin-manager` 的 `pinnedGitOrigin` | 构建时只引入纯函数 `install-spec.ts`，不把 Node 插件管理器打进 Worker |
| 账号通知（`ui-account-notifications`）取代账号控制器 | 与账号登录一样依赖 DeepSeek 平台 OAuth，列为不可用 |
| 内置 LLM 失败码不再含 `PROVIDER_ERROR` | 未列出的失败统一以 `UNKNOWN` 和固定文案记录，不保留 provider 原文 |

依赖方面只有 `zod` 随上游从 4.4.3 升到 4.6.6。两份容器镜像标签均有变化。

## 0.2.1 → 0.2.2-rc.1 的兼容范围

rc.5（`b830ec950faba0a46dda564be3e2d854afed94f1`）→ rc.1 的审查覆盖完整 Git diff。Session V4 存储格式版本未变，但以下契约改变，Weft 已按原版接口适配：

| 上游变化 | Weft 适配 |
| --- | --- |
| Loader 的 `EntryTree.write()` 改为 `commit(change)`；浏览器 Loader 新增文件系统解析器 | workerd 与安装包 Loader 实现空 `commit`；浏览器构建与上游 Vite 一样把该解析器的 Node 导入替换为不可调用的存根 |
| 工具执行拆为 `tool-executor-native` / `tool-executor-ptc`，`tools.execute` 变为批量接口 | 根世界加载原版 native 执行器；PTC 预设的 `tool-executor-ptc` 行使用每次运行独立的 Dynamic Worker 运行时；单次调用经 `executeToolCall` 走同一执行器 |
| 模型选择归 Agent 所有（`agent.model`），投影由 Agent Loop 注册 | 移除 Weft 自己的选择引用，切换通知在 Agent 未发布的 setup 作用域安装 |
| 会话历史改由 `HistoryController` / `WebController` 提供；`session/control` 投影帧改为每个事件一帧、`changes: [{key, val}]` | 读侧使用原版控制器；环境控制流按新帧格式发出摘要变化 |
| `session/attachment` 携带完整图片引用，不再扫描会话历史 | 从环境附件存储按引用读取；仍要求目标会话存在 |
| Schedule 改为 Host 级任务（`create/list/view/edit/history/run`，RRULE 计时，`active/paused/ended`），存储写 v2、读 v1 | 每个会话 DO 保存其投递目标的任务；入口 Worker 聚合读取并按任务 id 路由操作；DO KV 后端支持 `compatibleVersions`，首次写入时原子更新版本戳。会话 DO 不创建其他会话，`new` / `new_once` 目标按原版文案拒绝 |
| `FileSystem` 新增 `patchText`、`deleteFile`、`moveFile`；`fs-observation-policy` 默认关闭 | 工作区存储在一个 SQL 事务内应用原版 `applyHunks`、删除与移动；跟随原版不再挂载读前写策略 |
| 插件管理页、插件市场详情页与 Web 抓取 | 管理页仍显示 base / web-app；市场详情的局部克隆在 workerd 报告原版 `git-unavailable`；Web 抓取改用平台 `fetch`（Workers 拒绝 IP 地址主机名） |
| `tool-subagent-control/list-agents` 合入主插件；预设改用 `modelSelection` / `modelDiscovery` | 目录随原版移除该行，预设直接取用原版配置 |

`packages/harness-runtime/src/revision.ts` 因此不再列出任何旧来源。0.2.1 时期发布的修订（含 `0.2.1-alpha.4`、`rc.2`–`rc.5`）保留来源记录与可读历史，但不能在 0.2.2-rc.1 运行时继续执行或创建会话；原版预设按种子归属规则以新上游重新发布；环境自己的预设（含改过的原版预设）在激活时去掉已合并的 `tool-subagent-list-agents` 行、把 `modelSelectionSettings` 改为 `modelSelection` 与 `modelDiscovery`，校验通过后以新上游重新发布，校验失败的保持原样且不能运行。已有会话仍绑定创建时的修订。CI 覆盖旧来源拒绝、历史保留、预设迁移和未知版本拒绝。

上游对 `pi-ai`、`lexical` 等依赖的补丁仍不进入 Weft 构建，与此前一致。

rc.3 的插件「更多」菜单与草稿复用使用原版实现。API Key 模型目录也使用原版 `/models` 跟随逻辑；workerd 仅把该请求的 `redirect: error` 替换为 `manual`，原版非 2xx 分支继续拒绝重定向，避免转发密钥。CI 验证模型目录请求、重定向拒绝、插件入口与未发送草稿恢复。

本次同时接通原版 `web-deepseek-api` 插件：Web search 配置页可以选择新版 Search / Fetch API，密钥由环境凭据服务解析；默认仍使用原版 Messages 搜索与 HTTP 抓取。workerd 适配仅把不支持的 `redirect: error` 改为 `manual`，原版错误处理拒绝 3xx，不跟随携带凭据的跳转。旧 Messages 搜索、新 Search / Fetch、Code Mode、终端、插件安装、环境生命周期与浏览器界面均由 `ci` 工作流验证。

上游固定提交也是两份容器镜像内容标签的输入。升级需从通过 CI 的同一提交下载镜像制品，发布到自己的账号并更新私有部署配置，再部署 Worker；不得沿用旧标签绕过镜像一致性检查。
