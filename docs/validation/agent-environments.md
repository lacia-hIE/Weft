# Harness 多环境验收

2026-10-17 本地验证，固定上游 `86a402200d95fecef4529d969836f1fe13c6cb0d`。

下文保留阶段性验证记录。本轮已明确无需兼容旧数据，使用新的 `harness-v2` 寻址与浏览器存储版本；旧对象不再读取，默认环境和其他环境统一由 EnvironmentDO 承载。历史迁移/采用不再属于验收目标；更换地址并不等于物理删除旧底层对象。

## 数据与运行

37 项真实 workerd 回归通过，其中新增多环境测试验证：

- 同一用户的两个环境可以使用同名 Session、Workspace、预设和插件，数据互不覆盖。
- 不同用户的同名环境隔离；不存在的环境返回 404，跨用户访问返回 403。
- 配置发布和插件启用只改变所属环境；另一环境无法获取该模块版本。
- 文件和会话在 workerd 重建后恢复，旧租户数据能从默认环境入口读取。
- 两个环境可选择不同模型，模型密钥仍由服务端提供；发布新模型版本后，旧会话保持原版本，新会话使用新版本。

严格类型检查通过，两个生产 Worker 的预构建部署检查通过。环境控制状态增加 EnvironmentDO SQLite export；SessionDO 和 WorkspaceDO 保留现有绑定，通过地址加入环境 ID 隔离。

## 页面与真实模型

3 项浏览器回归通过：管理目录创建环境并进入、切换页面后插件卸载、既有聊天/历史/文件 CAS、原生 Store/Config/Markdown/DockKit、安全模式、移动端与深色模式。

真实 DeepSeek 流程在新建的独立环境中通过：从 Web 发消息，模型写 TSX 并发布，用户启用插件，点击计数器后刷新恢复。该验证使用本地 workerd 的原生 Access 模拟，不等于云端用户完成邮箱验证码登录的验收。

## 完整官方 UI 的构建验证

官方生成器已生成 30 个包的 Remote ABI；上游源 checkout 未修改。官方 Web 构建目录中的 69 个浏览器模块已全部使用各自的原始 tsdown 配置构建成功，包含模块表工厂、CSS 生命周期、动态分块及文档预览构建。目录包含条件启用的模块，实际 Boot Graph 仍需遵循 Web profile 的激活条件。

```bash
npm run build:official-ui
```

产物和报告在 `.generated/official-remotes/` 与 `.generated/official-ui/`。Boot Graph 与静态资源生成到 `.generated/official-web-assets/`，使用官方模块排序函数及 manifest parser 验证；当前激活 67 个 Web 模块，按上游条件排除 Desktop 专用的 product-analytics 和 sidebar-browser。标准 `npm run build` 已包含完整生成链，并已完成一次完整构建。

## 原生会话 Host 验证

新增 5 项真实 workerd 测试，覆盖官方生成契约和真实 SessionDO：

- 在首条提示词前创建真实空白 Session；只复用空白会话，已使用的会话创建新身份。
- 官方历史分页、事件连续性、assistant 帧、消息请求 ID、多个文本块、时区及重复提交去重。
- 原生标题事件与投影、运行中修改标题、非法标题拒绝，以及进程重建后的恢复。
- 延迟 DeepSeek 协议流中重连，看到真实活动 Session 与已积累 assistant 输出；关闭所有订阅后模型仍继续执行。
- 取消到达原生 Agent 并写入 `aborted/user` 终止事件；凭据缺失在确认提示词之前返回失败。
- 同名会话的环境隔离；未知接口、steer 与运行中 Inbox 排队明确报告不可用。

完整 workerd 回归共 42 项通过，严格类型检查通过；3 项现有浏览器回归通过，两个 Worker 的预构建部署检查通过。UI 资产改为私有 Worker 的 Static Assets binding，公开主 Worker 仍先验证原生 Access 身份。本地 Miniflare 需显式设置资产 router 的 `has_user_worker`，保证与生产的 Worker-first 路由一致。

## 官方页面、工作区与模型选择

`/agents/:environmentId?ui=official` 使用真实 AppWebEntry、官方 Loader 和 67 个 Web 模块，已在浏览器完成原生会话发送、回复展示与刷新恢复。新增端到端测试还让两个环境使用相同 Session ID，验证页面内容、localStorage/sessionStorage 的读取、清理与切换恢复均按环境隔离。并行执行完整类型检查时首次启动超过原先 12 秒测试等待，官方启动检查调整为 45 秒后通过。

新增真实 workerd 验证覆盖：

- `$events` 的真实会话通知、环境隔离与重连后从持久状态重新读取。
- Workspace 注册、真实目录创建、重命名、排序、会话归属、固定/归档、重启恢复；删除注册保留文件和会话。
- `session/control` 的持久投影基线，以及配置模型目录。
- 指定项目目录后，原生文件工具用相对路径写入该项目，而非默认根目录。
- 原生模型选择事件与投影；重启后实际推理请求使用所选模型，切换后写入官方模型变更提示。不存在的模型、外部路由及无效推理档位被拒绝。

本轮完整 workerd 回归 **46 项全部通过**；严格类型检查、完整官方构建及两个 Worker 的预部署检查通过。3 项既有浏览器回归通过，新增官方页面隔离/历史恢复测试重跑通过。真实 DeepSeek 的官方页面测试也通过：在独立环境中发送消息，收到指定回复，刷新后恢复同一原生历史；推理与恢复流程耗时 21.4 秒。该实测使用本地 workerd 和测试 Access 身份，不能替代云端允许用户的登录后验收。

该阶段默认入口保留过渡工作台，官方页面不能计为完整接入。原生通知不持久化，断线重新获取基线。后续设置/凭据进展见下节；原生动态插件、其他业务接口和云端 Access 用户登录后的验收仍需完成。旧数据兼容已从目标移除；参见 [架构与剩余验收](../architecture/agent-environments.md)。

## 原生模型设置与环境凭据

新增真实 workerd 用例验证官方设置读取、schema 表单、修订号冲突、路径编辑和数组继承/重置。通过官方 Models 页保存模型名、endpoint 与密钥后刷新，配置仍在，密钥输入保持为空；读取结果只包含凭据的 configured/source/writable 状态。官方欢迎确认与开发工具偏好也使用上游 Config schema 持久化。

环境 A 的 credential ref、endpoint、模型目录及默认模型不会改变环境 B。重启后，新 Session 的真实 DeepSeek 协议请求使用 A 配置的地址、密钥、模型和输出上限。运行中的双步骤工具调用验证：第一条请求继续使用旧快照，设置变更后第二条请求采用新 endpoint、key 和 maxTokens；推理调用未因配置写入被重放。

官方 Models 编辑器使用 composition entry ID `llm-deepseek`，不是 provider 包名 `llm-deepseek-api-key`；运行时路由统一为官方 `deepseek-official`。设置持久化不依赖本机 YAML 文件，`hasDocument` 如实返回 false。非法请求参数在 DO 边界被转换为原生 `gateway/bad-request`，模型配置失败也通过显式私有响应保留分类，避免依赖跨 RPC 的 Error 原型。

5 项普通浏览器回归通过，包含新增 Models 表单用例。完整官方 UI 目标仍在进行中：预设、权限、原生动态插件、文件/附件和完整 Inbox 等接口还需补齐，不能将本轮模型设置与凭据接入计为全部设置/插件管理完成。

最终完整 workerd 回归 **48 项全部通过**，严格类型检查、完整官方构建及两个 Worker 的预部署检查通过。2 项真实模型浏览器用例通过：官方聊天与刷新恢复耗时 26.6 秒；模型通过原生文件工具生成插件、用户启用并交互的流程耗时 18.1 秒。初次全量回归中的配置错误分类和旧寻址测试夹具问题已修复，并已重跑完整回归确认。

## 原生 Agent 生命周期与 Inbox

SessionDO 热实例跨轮次复用真实 Agent / Cordis Context，结束回答后仍报告 `agentAvailable`。原生队列直接使用 AgentLoop 的 Inbox；测试固定第一步模型传输，验证后续消息入队、编辑、删除、重复 RPC、提升为 steer，以及直接 steer 的精确事件次序。next-turn 消息保持独立轮次，next-step 消息在当前轮次的下一步消费。

取消沿用上游 `keepInbox: true`：当前轮次记录 aborted/user，队列停留，下一次输入唤醒后继续。测试同时检查取消后的投影和后续模型请求，避免把“取消后自动继续运行”当作原版行为。过渡消息接口对原生会话返回 `NATIVE_SESSION_REQUIRED`，热实例和重建后均不能打开第二个写入者。

插件生命周期反馈的内部投递 seam 使用原生 `cordis-host-runner` 来源。上下文可持久入队而不唤醒模型；workerd 重启后仍在 Inbox，下一次提示词将它消费一次。这只是原生插件 Host 接入的基础，不代表动态插件管理、审批或 Dynamic Workers 已完成生产接入。未配置模型密钥时可以创建空白会话；提示词仍须通过凭据检查才能确认入队。

`npm run test:web:queue` 使用可控的模型 HTTP 传输，官方 UI、AgentLoop、工具和 DO 存储均为真实实现。浏览器操作原版 QueueDock 的编辑、保存、删除与 steer 按钮；刷新保留编辑结果，删除项不进入用户消息历史，steer 在第一轮的下一步执行，最终 Inbox 为空。该用例不冒充真实模型调用；另两项真实 DeepSeek 浏览器验证已通过，耗时分别 22.0 秒和 16.8 秒。

普通浏览器回归 5 项通过，队列专项 1 项通过；严格类型检查通过。首次全量 workerd 回归为 50 项通过、1 项失败，原因是旧标题通知测试假定首条 projection 必为 title。加入原生 Inbox 后多个领域的投影可以交错，测试已改为验证对应 session 的真实 title 事件；完整回归重跑结果在下方记录。

修正后的宿主与 Inbox 完整 workerd 回归 **51 项全部通过**。随后补充的平台凭据 endpoint 约束专项 **3 项全部通过**，含新增的完整地址/路径保护用例：冷、热 Agent 都不向修改后的 endpoint 外发平台密钥，只有环境自己的密钥可用于自定义网关。严格类型检查及最终两个 Worker 的预部署检查通过。浏览器共 8 项通过（普通 5、可控队列 1、真实模型 2）；这些本地 workerd 结果不替代云端 Access 登录后的验收。


## 原生动态 Cordis Host 与官方插件面板

原生 Runner 已接通定义、运行、精确版本审批、Client 代码获取、Host invoke、错误回报、停止、移除和检查请求。SessionDO 保存不可变源版本与授权，EnvironmentDO 只保存目录和路由索引。Host 在 SessionDO 的 Dynamic Worker facet 中持有实际 Cordis；支持工具、timer 和限定异步 FS，未桥接服务明确失败。更完整的范围与验证见 [Dynamic Workers](dynamic-runner.md)。

官方 Boot Graph 仍使用原版 67 个 Web 模块，另加一个独立 Weft 扩展，共 68 个。扩展贡献 My Agents 导航，并通过原版 Client runner 重新挂载已经批准的活动 Client；不自动批准新版本，不覆盖上游页面。

动态 Cordis 面板的接通不代表侧栏静态 Plugins 管理器、预设、权限或完整附件能力已接通。默认预设仍禁用插件编写，必须先发布允许 `allowClientPlugins` 的配置。完整官方 UI 目标继续进行，默认入口仍为过渡工作台；本轮不增加旧数据兼容或迁移。


2026-10-18 最终回归：**55 项真实 workerd 测试全部通过**，包含新增的插件生命周期、隔离工具/取消/Secret 边界和可执行编写示例。严格类型检查与两个 Worker 的部署 dry-run 通过。普通浏览器 5 项、原版队列 1 项、原生插件面板专项 1 项通过；3 项真实 DeepSeek 浏览器故事分别验证官方聊天、过渡插件生成和原生双端插件。最终原生双端用例耗时 43.6 秒：模型生成代码，用户逐版本批准，按钮调用隔离 Host 写入真实文件，刷新恢复 Client。该结果仍是本地 workerd 与测试 Access 身份的证据，云端登录后验收另行完成。

2026-10-19 模型配置调整：上述平台凭据回退已移除。当前只有用户在官方 Models 中保存的环境凭据可用于模型调用，旧 Worker 模型变量全部忽略。
