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

`packages/native-files` 接通原版 `WorkspaceFiles` 服务的目录、文本分页、字节预览与变更订阅。只读宿主读取实际会话 header，不激活 Agent 或获得写入权；相对路径依照会话 cwd，文件系统能力仍严格限制在所属租户与环境卷。原版 Connection 的 multipart 编码函数和生成的 Typert codec 保留真实字节类型，WorkspaceDO 提供落盘后的失效通知及明确关闭 RPC，见 [文件 Host 验证](../validation/native-files.md)。

`packages/native-attachments` 接通原版 FileUploads 的通用文件上传和提示词回执流程。实际 Agent 持有回执缓存，SessionDO SQLite 保存回执及绑定；WorkspaceDO 使用 Computer 分块写入、校验摘要并原子发布不可变文件。上传、排队、移除、消费、重复请求与冷恢复保留原生语义。原版输入框和后台上传器直接使用该协议，不引入 Node 传输或应用 Token。图片输入通过 Cloudflare Images 规范化到环境文件系统，原版图库与模型 Files API 使用真实内容及持久映射，具体范围见 [附件验证](../validation/native-attachments.md) 与 [图片验证](../validation/native-images.md)。

配置宿主位于 `packages/control-plane/src/native-settings.ts`，复用官方 DeepSeek API-key、默认模型、开发工具和欢迎确认的 Config schema，以及原生 volatile form、plainConfig 和 secret redaction。官方 Models 编辑器使用原版 composition entry ID `llm-deepseek`，对应 API-key provider 包；运行路由使用 `deepseek-official`。SQLite 保存用户覆盖层和修订号，过期表单拒绝覆盖新版本；数组替换和路径编辑保留继承/重置语义。配置不伪装为本地 YAML 文件。

`DurableCredentials` 实现原生 CredentialProvider seam，按环境保存凭据引用与插件记录。客户端仅能写入密钥、读取配置状态；实际值只经服务端可信绑定送往执行宿主。平台回退密钥限定服务端配置的完整 endpoint；环境更改域名或 base path 后须提供自己的密钥。模型请求捕获一致的 endpoint/credential 配置快照。运行中的设置变更在下一次原生 prompt assembly 前重新解析，不改动已经开始的模型请求。

`$events`、`session/control` 与 `workspace/follow` 提供环境内的真实通知及重新连接基线。通知本身不持久化，重连重新读取 DO 状态；观察者退出不终止 Agent 执行。浏览器切换采用完整导航，并按租户与环境划分原版客户端持久化键，防止同名 Session 缓存串用。

## 原生动态 Cordis 插件

`packages/native-plugins` 直接挂载固定上游的 `DynamicCordisRunnerService`；define/run/stop、不可变 package、原版审批面板、客户端 runner 和生命周期反馈沿用原实现。`scripts/native-cordis-platform.mjs` 仅在构建时替换注册表所有权、Node VM 沙箱入口和环境全局请求 ID，遇到上游 seam 变化立即构建失败；不修改上游 checkout。

SessionDO SQLite 保存源码、版本、精确版本批准、未来版本授权、待处理请求和运行身份，EnvironmentDO 保存不含源码的目录与请求所属 Session。已批准活动版本在重建后恢复，保持 run ID；存在待批准的新版本时，只恢复旧活动版本，不吞掉新版本的请求或诊断。插件运行状态可恢复，任意 JavaScript 闭包内存并不持久，作者应把业务状态写入工作区。

Host 源码编译为 Dynamic Worker 的静态模块，在 SessionDO 的 Durable Object facet 内运行真实 Cordis 与原版工具契约，父 Worker 不 eval 用户代码。子环境仅获得固定所属 Session/plugin/run 的 FS RPC；没有 Namespace、平台 Secret 或外网出口。支持工具、timer、限定异步 fs，未桥接服务明确拒绝。原生 Agent 的策略仍在父宿主执行；子工具不伪造 Agent 对象。协作取消保留实例，操作超过 15 秒则终止 facet 并收回注册，反馈进入原生 Inbox。该适配不等于任意 npm 安装、完整 Node 系统或跨隔离区自定义 Cordis 服务。

默认预设的 `allowClientPlugins` 为 false；内置 Creator（ID `cordis`）为 true，可以在原版 Agent presets 中选择。开启后装配五个小型编写工具，调用实际 Runner；只读检查工具复用上游契约，仅列出已桥接的服务与方法、隔离实例自身的工具事件，并补充 Workerd 执行说明。原版 Node HostConfig 检查没有挂载，避免把不存在的文件配置能力伪装成可用。

独立的 `@weft/harness-environment` 浏览器扩展提供 My Agents 导航，并用原版客户端 runner 重新挂载已批准的活动 Client；刷新不会批准待处理的新版本。Client 插件仍与当前浏览器页面同权。原生动态插件面板不等于侧栏静态 Plugins 管理器已完整接通。

## 原生预设与静态组合

`packages/native-composition` 挂载原版 Loader 和 AgentPresetRegistry，使用其真实配置树、工具作用域、保留代际、选择校验及 `agent-preset/selected` 事件。固定模块与校验器共享 `plugin-runtime` 的同一目录；Loader 只接收预构建 `cordis:` 引用和字面配置。构建适配去掉 Node 内部模块加载和配置表达式求值，替换为明确的 admission 边界；上游源码保持不变。Host 侧不运行用户提供的配置 JavaScript。

`packages/harness-profile` 提供真实的部署内置配置包、profile 依赖声明和 Cordis patch。预设通过原版 AgentPreset 插件成为 Loader 条目，不再由额外的声明 Fiber 表持有。初始预设取自同一配置包，环境中的发布版本作为用户配置层；包声明与实际版本不匹配时直接失败。

EnvironmentDO 保存预设版本，提供原版列表、只读 YAML 声明和默认选择。它使用真实组合上下文及所属环境的 Computer FS 校验激活，不创建 Agent 或会话写入者。Standard / Creator 初始化为持久预设，Creator 使用原版 ID `cordis`；更具体的可用服务仍以 workerd 能力检查为准。默认选择沿用原版 `agent-preset-registry.selectedDefault` schema、修订号与设置协议。

SessionDO 在真实 Agent 的 setup 阶段绑定冻结的预设；已有会话不会因环境发布新版本而改变能力。首轮前的选择调用原版 registry，持久化原生选择事件；创建 header 保持原始身份，当前选择由 projection 表示。提示词入队和预设切换共用 admission 锁，替换后的旧宿主不会接受新消息。Persona、模型默认值及动态编写开关在新的会话宿主中使用所选快照。

预设切换保存准备快照与事件边界；重建只在边界之后发现对应的原生选择事件时提升快照。测试分别模拟事件已提交和事件未提交的中断窗口。冷读复用原版 AgentPreset 和 Todo 投影；不会为读取历史启动 Agent 或调用模型。

组合、冻结、恢复与原版页面操作的验证范围见 [原生预设验证](../validation/native-presets.md)。

## 原版 Plugins 页面与配置

Plugins 页面已接通原版 `pluginInventory/list`、`pluginManager/listPlugins`、`listBundles` 和预设条目的启停。清单读取原版 `readPluginInventory`，运行状态来自实际 Loader Fiber；配置包信息来自部署内的 manifest、profile 依赖和真实 patch，读取不创建 Agent 或会话写入者。它表示当前环境声明的组合状态，已有会话的保留版本继续由各 SessionDO 持有。

管理适配在 `packages/native-composition/src/manager.ts`，只取得当前环境的读取和发布能力；EnvironmentDO 保留 scope 校验、SQLite 版本、CAS 和持久化职责。停用预设发布新版本，阻止新任务选择该预设，已有会话继续使用冻结快照。当前新任务默认预设和必要的配置包不能停用或删除。默认检查、版本比较和插入之间不跨异步边界，避免并发操作留下失效的默认值。

预设声明发布会推进其依赖的 `agent-preset-registry` 设置修订号，发出原版设置和插件变更事件；默认选择变化也使管理清单失效。因此任务选择器和 Plugins 开关可以更新，不依靠手动刷新或伪造连接重置。

原版 Agent loop 页面消费原生 Config schema 中的 `maxParallelToolCalls`，不开放 factory 的 `agents` 数组。SessionDO 在 prompt assembly 前刷新实际 AgentLoop 的 Volatile 引用，当前工具组仍使用已经捕获的并发上限；下一步与重启后的执行使用已保存值。模型凭据仍在独立可信快照中解析。

当前配置包管理不等于通用 npm 安装器已经完成。安装、检查或移除未接通的包返回明确拒绝，不生成假的下载日志、安装成功或包库存。验证范围见 [Plugins 管理与 Loop 配置](../validation/native-plugin-management.md)。

## 验收状态

已实现并验证环境目录创建、配置/文件/插件/同名会话的环境隔离及重启恢复。浏览器验证覆盖目录进入、环境切换卸载及既有工作台回归。旧数据兼容与迁移不再是验收目标。

已接通官方协议的会话创建、列表、分页、订阅、标题、模型选择、提示词、取消，以及工作区、目录选择和全局通知。模型投影复用官方定义，请求装配复用原生模型切换钩子；冷启动后恢复所选路由。原生 Inbox 已接通排队、编辑、删除、steer、通用文件附件、图片提示词和持久恢复；子 Agent 与更多业务投影仍需接入。图片采用 Cloudflare Images、环境内 Computer 存储和持久请求衍生版本，DeepSeek 上传映射由当前环境的 SQLite 保存，清理仅操作该环境记录的远端文件 ID。原版图片读取协议验证附件确实被当前会话引用，冷读不创建 Agent。详见 [原版图片验证](../validation/native-images.md)。提示词只有在原生 Inbox 入队事件同步存储后才确认接受，用户消息在原版驱动消费时进入历史；缺失能力明确拒绝。

官方 Remote 的 30 个包与官方 Web 目录的 69 个客户端模块已使用上游生成器、各包自身的构建配置成功生成。标准 `npm run build` 已包含这条完整构建链，确保全新的 Cloudflare Git 构建也会生成官方产物；构建报告位于 `.generated/official-ui/build-report.json`。

Boot Graph 由真实客户端工厂产物生成，复用官方 `orderByModuleGraph` 和 `parseBootManifest` 排序与校验。当前 Web profile 激活 67 个官方模块，加上独立的 `@weft/harness-environment` 扩展，共 68 个模块；按上游条件排除仅 Desktop 启用的 product-analytics 与 sidebar-browser。`/agents/:environmentId` 默认运行这条官方启动链，Agent 卡片直接进入官方页面。`?ui=transition` 保留过渡实现的显式验证入口，不作为产品默认路径。默认环境文档采用原版 Loader 所需 CSP，管理入口维持独立策略。

以下工作仍未完成，目标保持进行中：

1. 继续补齐预设编辑、权限、文件及更多插件的原生配置和 Host 接口、业务投影；原版 Inbox 和预设选择的页面交互已验收，未连接能力返回明确错误。
2. 验证实时控制流在并发写入、长任务、断线与 DO 重建后的完整一致性，并解决 Session 目录当前 200 条上限。
3. 完成剩余业务接口后移除过渡界面；官方 AppWebEntry 已设为默认入口，独立扩展提供 My Agents 导航。
4. 继续补齐静态插件包的安装、更新、卸载及更多配置生命周期；原版 Plugins 的真实配置包清单、预设条目启停和 Agent loop 表单已接入。扩展动态插件的 workerd 服务桥接和部署验收。
5. 完成更多 provider/插件的凭据集成和环境管理生命周期，按新布局验收，不做旧数据兼容。
6. 在真实模型、多环境、重连、重启和 Cloudflare 部署中验收完整官方 UI。

`harness-shell.tsx` 仅通过显式参数保留为回归入口，不能将这些回归计为原版界面的功能验收。默认入口切换也不等于全部 Host 接口已经完成。
