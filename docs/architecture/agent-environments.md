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

UI 资产由没有公网入口的 Worker 通过 Static Assets binding 读取；公开入口保持独立，并先验证原生 Access 身份，再通过 Service Binding 调用资产 Worker。这为完整官方客户端及文档预览分块提供资产承载方式。

官方入口适配在 `apps/web/src/official/`。它调用原版 AppWebEntry，提供环境范围内的 Fetch/SSE transport 和浏览器存储命名空间，由官方模块系统、Loader 和 Slots 挂载界面。页面内部的相对 HTTP 请求通过同源 base 路径指向该环境。原版 Loader 表达式及动态客户端插件依赖 Function，因此仅官方环境文档启用对应 CSP；管理页面维持原来的策略。

工作区注册表使用官方记录 schema，保存到 EnvironmentDO 的 SQLite，并通过官方 Workspace 协议提供排序、会话归属、固定与归档。官方 Workspace 对应环境文件系统中的真实目录，会话使用该目录作为 cwd；目录创建和文件操作落到 WorkspaceDO 的 Computer 文件系统。删除注册不会删除文件或会话。

配置宿主位于 `packages/control-plane/src/native-settings.ts`，复用官方 DeepSeek API-key、默认模型、开发工具和欢迎确认的 Config schema，以及原生 volatile form、plainConfig 和 secret redaction。官方 Models 编辑器使用原版 composition entry ID `llm-deepseek`，对应 API-key provider 包；运行路由使用 `deepseek-official`。SQLite 保存用户覆盖层和修订号，过期表单拒绝覆盖新版本；数组替换和路径编辑保留继承/重置语义。配置不伪装为本地 YAML 文件。

`DurableCredentials` 实现原生 CredentialProvider seam，按环境保存凭据引用与插件记录。客户端仅能写入密钥、读取配置状态；实际值只经服务端可信绑定送往执行宿主。模型请求捕获一致的 endpoint/credential 配置快照。运行中的设置变更在下一次原生 prompt assembly 前重新解析，不改动已经开始的模型请求。

`$events`、`session/control` 与 `workspace/follow` 提供环境内的真实通知及重新连接基线。通知本身不持久化，重连重新读取 DO 状态；观察者退出不终止 Agent 执行。浏览器切换采用完整导航，并按租户与环境划分原版客户端持久化键，防止同名 Session 缓存串用。

## 验收状态

已实现并验证环境目录创建、配置/文件/插件/同名会话的环境隔离及重启恢复。浏览器验证覆盖目录进入、环境切换卸载及既有工作台回归。旧数据采用与迁移不再是验收目标。

已接通官方协议的会话创建、列表、分页、订阅、标题、模型选择、提示词和取消，以及工作区、目录选择和全局通知。模型投影复用官方定义，请求装配复用原生模型切换钩子；冷启动后恢复所选路由。完整原生 Inbox 的排队/steer、附件、子 Agent 与更多业务投影仍需接入。提示词只有在原生用户消息入日志并同步存储后才确认接受；缺失能力明确拒绝。

官方 Remote 的 30 个包与官方 Web 目录的 69 个客户端模块已使用上游生成器、各包自身的构建配置成功生成。标准 `npm run build` 已包含这条完整构建链，确保全新的 Cloudflare Git 构建也会生成官方产物；构建报告位于 `.generated/official-ui/build-report.json`。

Boot Graph 由真实客户端工厂产物生成，复用官方 `orderByModuleGraph` 和 `parseBootManifest` 排序与校验。当前 Web profile 激活 67 个模块，按上游条件排除仅 Desktop 启用的 product-analytics 与 sidebar-browser。`/agents/:environmentId?ui=official` 已运行这条官方启动链；无参数入口仍保留过渡工作台，直至下面的兼容与完整功能验收通过。

以下工作仍未完成，目标保持进行中：

1. 继续补齐预设、权限、文件及更多插件的原生配置和 Host 接口，以及完整 Inbox 和业务投影；当前未连接的能力返回明确错误。
2. 验证实时控制流在并发写入、长任务、断线与 DO 重建后的完整一致性，并解决 Session 目录当前 200 条上限。
3. 验收后将官方 AppWebEntry 设为默认环境入口，并通过独立扩展补充 Weft 导航。
4. 原生动态插件与官方模块系统、检查工具、配置生命周期的对接。
5. 完成更多 provider/插件的凭据集成和环境管理生命周期，按新布局验收，不做旧数据兼容。
6. 在真实模型、多环境、重连、重启和 Cloudflare 部署中验收完整官方 UI。

当前 `harness-shell.tsx` 是保留既有功能的过渡入口，不是完整官方 Web App；验收时不能把它计为官方 UI 接入完成。
