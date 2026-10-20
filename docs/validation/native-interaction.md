# 原版交互服务与预设插件

官方 Web 客户端在会话中依赖的命令、压缩、提问、计划、目标、定时提醒、反馈和引用服务，均直接挂载固定上游的原版服务与插件。Weft 只提供 workerd 宿主适配：服务所在的 Context、存储介质、跨对象寻址和 Remote 路由。

## 预设与根服务

内置预设对齐官方 `standard` 预设的插件结构，压缩与计划插件按官方 group 和 isolate realm 组装：

- 根服务：`TokenMeter`、`CommandRuntime`、`UserQuestionService`、`GoalService` 与 goal round driver、子 Agent 模型选择设置，以及原版 `SessionSkillCatalog`、`MessageFeedbackService`、command-feedback。
- 预设插件：`agent-instructions`、`plan-mode`、`tool-schedule`、`command-goal`、`tool-goal`、`tool-subagent`（spawn）、`tool-subagent-fork`、`tool-subagent-list-agents`、`tool-subagent-control`、`tool-ask-user`、`tool-web`、`present`、`compaction-basic`、`command-compact`、`tool-result-pruner`。
- 读取侧 reader 注册同一批 projection（userQuestions、goal、plan、tokenUsage、contextPressure、contextBreakdown），冷读与热会话返回相同的官方投影。

环境卷就是整个文件系统：卷外路径对只读探测表现为不存在（项目根标记查找因此按原版规则结束），读取和写入仍然拒绝。Harness home 与共享 agents home 位于 `/workspace/.dsh` 与 `/workspace/.agents`，与 Remote Events 宿主 home 一致。

## Remote 分发

Agent 级的直接调用方法（commands、userQuestions、goals、skills、fileReferences、schedule 的会话方法、反馈、sessionReferenceResolver）读取生成的 Remote 描述：strict codec、Agent lookup、按声明顺序的 JSON 参数与取消信号，与官方 gateway 的 direct 绑定一致。请求按 Agent 或 `request.sessionId` 路由到所属 SessionDO 的原生根。隔离作用域内的服务通过自身作用域访问，因为 Cordis 会把 Service 的 `this.ctx` 绑定到读取它的 Context。

## Remote Events waterfall

`user-questions/request` 与 `approval/request` 按官方 `api-remotes` 监听语义转发：SessionDO 把请求交给 EnvironmentDO，后者推送到该环境的 `$events` 客户端；首个结果决定结果，没有客户端时请求等待连接，取消会撤回所有投递。`$events/result` 校验结果所属的活动流。`goal/activation-changed`、`commands/change`、`schedule/changed` 在根 Agent 就绪后转发。

## 定时提醒

原版 `ScheduleService` 的存储域使用 DO SQLite 上的 `StorageBackend`（原版 KV 单元布局，私有表名前缀）。最早的活动提醒同步为 DO Alarm；对象被驱逐后，Alarm 唤醒原生根，原版运行时投递到期提醒。`resolveAgent` 等待正在恢复的根 Agent，与原版控制器恢复冷会话的语义一致；投递失败时 Alarm 退避重试，不会立即反复触发。`schedule/catalog` 是环境级列表，入口对每个会话对象扇出，未激活的对象直接冷读任务表。

## 引用、分叉与环境服务

- `@` 文件引用：原版 `SessionFileReferences` 加 `LocalFileReferenceService` 子类，目录读取改走环境的 `ctx.fs`，排序规则沿用原版；单次全量索引上限为 5000 项。
- `@` 会话引用：原版 `SessionReferenceResolver` 运行在隔离的只读查询作用域中，通过环境会话目录和各 SessionDO 的提交日志读取其他会话；本对象自己的会话不在候选中。
- `session/fork`：源对象用原版 `buildForkSeed` 生成种子，新 SessionDO 以 `agents.create({seed, inheritedEventCount})` 创建，并加入父会话所在的 Workspace。
- `remoteAccess/follow` 由原版服务给出 owner 基线；`job/*` 由原版 JobController 读取没有进程运行器的 registry，列表为空，启动明确拒绝。这些长连接流由 EnvironmentDO 提供：无状态入口请求只等待非 I/O promise 会被运行时判定为挂起。
- `llm/discoverModels` 对环境的 DeepSeek 路由使用适配器自身的模型表，其他端点明确拒绝。

## 网页搜索与抓取

`tool-web` 的 `web_search` 与 `web_fetch` 使用原版 `web`、`web-search-deepseek` 与 `web-fetch-http`。原生根上的只读 CredentialProvider 经 EnvironmentDO 解析凭据引用，搜索因此使用 Models 设置保存的同一个密钥；搜索端点为环境 DeepSeek 端点的 `/v1`（与官方默认一致）。`scripts/native-web-platform.mjs` 只在构建时替换两处 Node 传输：抓取的 undici 与 DNS 固定改为 workerd `fetch`，由平台在边缘解析主机名，IP 字面量仍按原版地址分类拒绝非公网目标；搜索的 `redirect: 'error'` 改为 `manual`，3xx 由原版的非 2xx 分支报错。HTML 转换使用 turndown 的 Node 构建与 domino。重定向、大小、字符集与超时策略保持原版。

## Shell、终端与权限

产品决定启用 Computer 的 Worker Shell，并允许其 curl 访问公网。命令在每个工作区自己的 Dynamic Worker 内由 just-bash 执行，文件调用经 `WorkspaceServiceProxy` 回到同一个 WorkspaceDO，没有第二份存储。

- Harness 侧实现原版 `subprocess` 接口：`bash -c` / `sh -c` 交给 Computer 运行时，输出按原版契约提供 Node 流与有界收集。原版 `bash-local` 执行器（以 `ComputerBashExecutor` 继承并按 `sandboxPolicy` 解析每次执行的模式）、`shell-env`、`jobs-local` 与 `JobController` 原样复用，`tool-bash` 与 `tool-jobs` 进入预设。后台作业保存在会话对象内存中，对象被驱逐后不保留。
- WorkspaceDO 的 Computer 观察器在每个文件操作前执行策略：附件私有区（`/workspace/.weft`）不可访问，符号链接被拒绝，写入按执行的沙箱模式检查（`read-only` 拒绝写入；`workspace-write` 限于会话根目录与 `/tmp`；`danger-full-access` 可写卷外，但私有区仍受保护）。并发执行同时满足各自模式，只会多拒绝。成功的写入更新 Weft 文件版本与变更通知，旧版本写入因此被拒绝。Weft 文件工具也按同一策略检查 `write` / `edit`。
- 原版 `ApprovalService` 与 `PermissionPresetService` 使用 base bundle 的三个预设；`/permission` 切换会话预设，`permission` 设置命名空间保存新会话默认值。升级请求经 `approval/request` waterfall 交给客户端批准。读取侧与环境级目录使用一个不含会话的私有权限服务，只提供目录与 `permissions` 投影，不写入会话。
- 官方 Terminal 使用原版 `TerminalController` 与 xterm 无头模拟器（构建时静态打包）。`spawnTerminal` 是基于 just-bash 的行模式终端：本地回显与编辑、回车执行、Ctrl-C 结束当前命令、工作目录跨命令保留；全屏和交互式程序不可用。用户自己的终端不受沙箱模式限制，私有区规则仍然适用。
- 双向流：客户端把 uplink 消息按顺序以 `$stream/input` RPC 发给打开该流的 SessionDO，分发器按原版 gateway 的方式提供 `ctx.invocation.uplink()`，并用生成的 uplink codec 校验。

## 已知限制

- Computer worker shell 的文件系统错误会结束当前脚本；用户可见的效果是后续用 `;` 连接的命令不再执行。没有真实进程、包管理器、node/python 等外部程序，`tool-fs-search`（ripgrep）不可用，Weft 继续提供 `workspace_search`。
- 主机名经平台在边缘解析，Worker 无法预先检查域名解析到的地址；IP 字面量按原版规则检查。
- DeepSeek 平台账号登录依赖 loopback 回调的 OAuth，`account/*` 明确拒绝；模型凭据使用环境 API key。
- Office 转 PDF 依赖 LibreOffice（原生库或数十 MB 的 WASM），超出 Worker 的体积与内存上限，`officeToPdf/*` 明确拒绝。
- 插件市场的原版 `pluginMarket` 服务已在 EnvironmentDO 中运行：索引 URL 保存在环境设置 `plugin-market` 命名空间，`listIndexes`、`setIndexes`、`search` 使用原版解析、搜索与兼容性检查（运行时版本固定为构建所用 app-boot 版本），设置变更广播 `plugin-market/changed`。上游官方 Web profile 不挂载市场，Discover 页属于默认关闭的实验 bundle，因此本部署同样不显示它。通用包安装需要在宿主 isolate 中加载任意 npm 代码，`pluginManager/installBundle` 明确拒绝。语音、思维链翻译等实验模块不在官方 Web profile 中。
- 上述三项的外部服务方案见 [外部服务设计](../architecture/external-services.md)。
- 受控模型不会产生真实网络 I/O；goal 连续轮次在测试中需要设置轮次上限。

## 验证

- `tests/native-commands.test.ts`：命令目录含 `compact`、`plan`、`goal`，`/compact` 的生命周期事件在重启后保留。
- `tests/native-questions.test.ts`：`ask_user_question` 经 `$events` 推送到客户端，答案恢复原生轮次，失效结果被拒绝。
- `tests/native-goals.test.ts`：Goal 创建、投影、激活通知、过期 revision 拒绝与清除。
- `tests/native-schedule.test.ts`：`schedule_create` 设置 DO Alarm，workerd 重启后 Alarm 投递提醒，提醒结束并保留回执。
- `tests/native-context.test.ts`：Skills 目录、`@` 文件引用、`@` 会话引用（候选与模型上下文）、AGENTS.md 注入。
- `tests/native-fork.test.ts`：无完成轮次时拒绝分叉；分叉继承前缀、加入 Workspace，后续提示词不影响父会话。
- `tests/native-models.test.ts`：模型发现与会话模型目录一致，自定义端点被拒绝。
- `tests/native-plan.test.ts`：`/plan` 进入计划模式，`exit_plan_mode` 的审阅经 `$events` 批准后退出。
- `tests/native-shell.test.ts`：bash 读写同一工作区卷、私有区与卷外写入及符号链接被拒绝、`/tmp` 可写、后台作业出现在 `job/list`、curl 出网、shell 写入使旧版本写入失效。
- `tests/native-terminal.test.ts`：shell 发现、终端创建与列表、`attach` 经 uplink 输入、工作目录保留、Ctrl-C。
- `tests/native-permissions.test.ts`：权限目录与默认值、`/permission read-only` 拒绝写入、升级请求经 `$events` 批准后以完全访问运行。
- `tests/browser/terminal.spec.ts`：官方 Terminal 侧栏中输入命令并看到输出。
- `tests/native-market.test.ts`：保存索引源并收到 `plugin-market/changed`，搜索、默认版本、安装参数、`engines.dsh` 不兼容、索引标题缓存、未知索引与重定向拒绝，安装仍被拒绝。
- `tests/native-web.test.ts`：`web_fetch` 转换公网页面、拒绝非公网 IP 字面量；`web_search` 携带环境密钥并返回原版结果。
- `tests/browser/interaction-live.spec.ts`（`WEFT_BROWSER_LIVE=1`）：真实 DeepSeek 调用 `ask_user_question`，官方问题卡片在页面中作答后，模型按所选答案继续。
- `tests/browser/official-coverage.spec.ts`：官方入口、命令与引用弹层、Automation tasks、右侧栏标签页、反馈与账号菜单等交互中，失败的原生调用只能属于 `account/*` 与 `officeToPdf/*`，且返回 `gateway/method-unavailable`，页面无运行时错误。
- 浏览器审计：官方入口、命令与引用弹层、Automation tasks、右侧栏、反馈与账号菜单等交互中，只剩上述已知限制对应的调用返回明确拒绝，页面无运行时错误。
