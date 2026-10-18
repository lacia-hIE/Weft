# 多套 Harness 环境与官方 UI

目标：Weft 管理多套 Harness 环境，每套环境内部使用完整的官方 Web 客户端。主题、控件或近似聊天界面不构成这一目标的完成。

## 资源边界

产品中的 Agent 对应一个 Environment，而 Harness 内部的 AgentSpec 对应该环境中的预设与发布版本。Environment 可以有多个 Session 和 Workspace；环境配置与会话执行分别持久化，不引入常驻进程。

页面只有两层职责：Weft 入口负责创建和管理环境，环境内部交给官方 Harness 的导航、聊天、工作区、插件和设置页面。切换环境相当于连接另一套 Harness。Weft 的环境管理入口可以通过独立的 Cordis 扩展贡献“返回我的 Agents”导航，不接管官方工作台布局。

“用户主机”是体验上的类比。workerd 环境没有完整操作系统或常驻主机进程；环境隔离要由服务端寻址、存储、凭据和执行权限共同保证，不能只依靠页面或 Cordis Context 的分离。共享官方客户端代码和构建产物不意味着共享用户状态。

- TenantDO 只管理环境目录，默认环境与其他环境一样使用 EnvironmentDO。
- 新环境的预设、配置版本、客户端插件版本及 Session 索引由独立 EnvironmentDO 保存。
- SessionDO / WorkspaceDO 寻址包含 tenantId、environmentId、资源 ID。不同环境允许同名资源，默认不共享。
- 采用全新的 `harness-v1` 存储寻址版本，所有资源都包含环境 ID；浏览器持久化也使用同一版本。不读取或迁移旧对象与旧客户端缓存。旧数据无需兼容，这是本轮明确的产品决定；旧底层对象并未因更换地址而物理删除。
- 新 API 入口为 `/v1/tenants/:tenant/environments/:environment/...`。入口先验证 Access 租户和环境存在性，DO 再验证寻址范围。旧租户级 API 继续映射默认环境。
- 预设发布版本固定 Session 的初始配置；官方模型选择通过原生 `model/selection` 事件持久化，并保存环境默认选择。环境自有配置和凭据存于 EnvironmentDO，服务端授权的租户凭据作为显式回退层。凭据引用按操作解析，密钥不进入预设、会话日志或设置读取结果。

管理入口为 `/`，环境入口为 `/agents/:environmentId`。切换环境采用完整页面导航，销毁前一个浏览器运行时；客户端宿主 API 只构造当前环境的资源路径。同源用户脚本仍与登录用户页面同权，这不等同于浏览器插件安全沙箱。

## 官方客户端接入边界

固定源码 `86a402200d95fecef4529d969836f1fe13c6cb0d` 的官方入口为 `AppWebEntry`。它依赖模块系统、Cordis Loader、Boot Graph 和 Remote 服务图。最终环境入口必须运行这条官方启动链路，使用官方的 Session/Workspace 客户端模型、Conversation、Slots、Layout、Sidebar、插件管理与设置界面。Weft 只贡献管理导航及 Cloudflare 宿主适配。

官方 Remote ABI 通过上游 `WorkspaceAnalyzer` / `FaceModelEmitter` 生成到 `.generated/official-remotes/`，不修改上游 checkout，也不手写一套近似协议。后端适配应消费这些契约，对接真实 DO 状态、日志和执行生命周期。缺失能力必须显式报告，不使用测试 mock 或固定假数据作为生产宿主。

原生会话宿主适配位于 `apps/worker/src/native-http.ts`，入口为环境 API 下的 `/native/api/<endpoint>` 与 `/native/streams/session/follow`。它消费官方 Connection 请求信封和生成的参数、结果解析器，连接真实 SessionDO。历史分页与实时订阅复用官方 SessionHistoryController / SessionQuery；执行仍由原生 AgentLoop 驱动。活动会话的读取借用真实 Session，不重复取得写入权，也不把运行中的流当成崩溃恢复。

`NativeSessionHost` 让 SessionDO 在热实例内持有真实 Agent 和 Cordis Context，轮次结束不会销毁宿主。原版 Inbox 保存排队、编辑、删除及 steer 的 splice 事件；重复 RPC 不会重新插入已经移除的消息。取消保留待处理消息，下一次唤醒后继续按原版轮次规则处理。插件生命周期消息也通过真实 Inbox 投递，可只注入上下文而不调用模型。DO 重建恢复持久事件，不承诺保留热内存；这不引入常驻 Node 进程。原生会话拒绝通过过渡消息接口再次取得写入权。

UI 资产由没有公网入口的 Worker 通过 Static Assets binding 读取；公开入口保持独立，并先验证原生 Access 身份，再通过 Service Binding 调用资产 Worker。这为完整官方客户端及文档预览分块提供资产承载方式。

官方入口适配在 `apps/web/src/official/`。它调用原版 AppWebEntry，提供环境范围内的 Fetch/SSE transport 和浏览器存储命名空间，由官方模块系统、Loader 和 Slots 挂载界面。页面内部的相对 HTTP 请求通过同源 base 路径指向该环境。原版 Loader 表达式及动态客户端插件依赖 Function，因此仅官方环境文档启用对应 CSP；管理页面维持原来的策略。

工作区注册表使用官方记录 schema，保存到 EnvironmentDO 的 SQLite，并通过官方 Workspace 协议提供排序、会话归属、固定与归档。官方 Workspace 对应环境文件系统中的真实目录，会话使用该目录作为 cwd；目录创建和文件操作落到 WorkspaceDO 的 Computer 文件系统。删除注册不会删除文件或会话。

配置宿主位于 `packages/control-plane/src/native-settings.ts`，复用官方 DeepSeek API-key、默认模型、开发工具和欢迎确认的 Config schema，以及原生 volatile form、plainConfig 和 secret redaction。官方 Models 编辑器使用原版 composition entry ID `llm-deepseek`，对应 API-key provider 包；运行路由使用 `deepseek-official`。SQLite 保存用户覆盖层和修订号，过期表单拒绝覆盖新版本；数组替换和路径编辑保留继承/重置语义。配置不伪装为本地 YAML 文件。

`DurableCredentials` 实现原生 CredentialProvider seam，按环境保存凭据引用与插件记录。客户端仅能写入密钥、读取配置状态；实际值只经服务端可信绑定送往执行宿主。平台回退密钥限定服务端配置的完整 endpoint；环境更改域名或 base path 后须提供自己的密钥。模型请求捕获一致的 endpoint/credential 配置快照。运行中的设置变更在下一次原生 prompt assembly 前重新解析，不改动已经开始的模型请求。

`$events`、`session/control` 与 `workspace/follow` 提供环境内的真实通知及重新连接基线。通知本身不持久化，重连重新读取 DO 状态；观察者退出不终止 Agent 执行。浏览器切换采用完整导航，并按租户与环境划分原版客户端持久化键，防止同名 Session 缓存串用。

## 原生动态 Cordis 插件

`packages/native-plugins` 直接挂载固定上游的 `DynamicCordisRunnerService`；define/run/stop、不可变 package、原版审批面板、客户端 runner 和生命周期反馈沿用原实现。`scripts/native-cordis-platform.mjs` 仅在构建时替换注册表所有权、Node VM 沙箱入口和环境全局请求 ID，遇到上游 seam 变化立即构建失败；不修改上游 checkout。

SessionDO SQLite 保存源码、版本、精确版本批准、未来版本授权、待处理请求和运行身份，EnvironmentDO 保存不含源码的目录与请求所属 Session。已批准活动版本在重建后恢复，保持 run ID；存在待批准的新版本时，只恢复旧活动版本，不吞掉新版本的请求或诊断。插件运行状态可恢复，任意 JavaScript 闭包内存并不持久，作者应把业务状态写入工作区。

Host 源码编译为 Dynamic Worker 的静态模块，在 SessionDO 的 Durable Object facet 内运行真实 Cordis 与原版工具契约，父 Worker 不 eval 用户代码。子环境仅获得固定所属 Session/plugin/run 的 FS RPC；没有 Namespace、平台 Secret 或外网出口。支持工具、timer、限定异步 fs，未桥接服务明确拒绝。原生 Agent 的策略仍在父宿主执行；子工具不伪造 Agent 对象。协作取消保留实例，操作超过 15 秒则终止 facet 并收回注册，反馈进入原生 Inbox。该适配不等于任意 npm 安装、完整 Node 系统或跨隔离区自定义 Cordis 服务。

默认预设的 `allowClientPlugins` 为 false。开启后装配五个小型编写工具，调用实际 Runner；只读检查工具复用上游契约，仅列出已桥接的服务与方法、隔离实例自身的工具事件，并补充 Workerd 执行说明。原版 Node HostConfig 检查没有挂载，避免把不存在的文件配置能力伪装成可用。

独立的 `@weft/harness-environment` 浏览器扩展提供 My Agents 导航，并用原版客户端 runner 重新挂载已批准的活动 Client；刷新不会批准待处理的新版本。Client 插件仍与当前浏览器页面同权。原生动态插件面板不等于侧栏静态 Plugins 管理器已完整接通。

## 验收状态

已实现并验证环境目录创建、配置/文件/插件/同名会话的环境隔离及重启恢复。浏览器验证覆盖目录进入、环境切换卸载及既有工作台回归。旧数据采用与迁移不再是验收目标。

已接通官方协议的会话创建、列表、分页、订阅、标题、模型选择、提示词、取消，以及工作区、目录选择和全局通知。模型投影复用官方定义，请求装配复用原生模型切换钩子；冷启动后恢复所选路由。原生 Inbox 已接通排队、编辑、删除、steer 和持久恢复；附件、子 Agent 与更多业务投影仍需接入。提示词只有在原生 Inbox 入队事件同步存储后才确认接受，用户消息在原版驱动消费时进入历史；缺失能力明确拒绝。

官方 Remote 的 30 个包与官方 Web 目录的 69 个客户端模块已使用上游生成器、各包自身的构建配置成功生成。标准 `npm run build` 已包含这条完整构建链，确保全新的 Cloudflare Git 构建也会生成官方产物；构建报告位于 `.generated/official-ui/build-report.json`。

Boot Graph 由真实客户端工厂产物生成，复用官方 `orderByModuleGraph` 和 `parseBootManifest` 排序与校验。当前 Web profile 激活 67 个官方模块，加上独立的 `@weft/harness-environment` 扩展，共 68 个模块；按上游条件排除仅 Desktop 启用的 product-analytics 与 sidebar-browser。`/agents/:environmentId?ui=official` 已运行这条官方启动链；无参数入口仍保留过渡工作台，直至下面的完整功能验收通过。

以下工作仍未完成，目标保持进行中：

1. 继续补齐预设、权限、文件及更多插件的原生配置和 Host 接口、业务投影，并完成 Inbox 的原版页面交互验收；当前未连接的能力返回明确错误。
2. 验证实时控制流在并发写入、长任务、断线与 DO 重建后的完整一致性，并解决 Session 目录当前 200 条上限。
3. 验收后将官方 AppWebEntry 设为默认环境入口；独立扩展已补充 My Agents 导航。
4. 补齐原版静态 Plugins 管理器的包与配置生命周期；继续扩展原生动态插件的 workerd 服务桥接和部署验收。
5. 完成更多 provider/插件的凭据集成和环境管理生命周期，按新布局验收，不做旧数据兼容。
6. 在真实模型、多环境、重连、重启和 Cloudflare 部署中验收完整官方 UI。

当前 `harness-shell.tsx` 是保留既有功能的过渡入口，不是完整官方 Web App；验收时不能把它计为官方 UI 接入完成。
