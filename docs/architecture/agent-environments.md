# 多套 Harness 环境与官方 UI

目标：Weft 管理多套 Harness 环境，每套环境内部使用完整的官方 Web 客户端。主题、控件或近似聊天界面不构成这一目标的完成。

## 资源边界

产品中的 Agent 对应一个 Environment，而 Harness 内部的 AgentSpec 对应该环境中的预设与发布版本。Environment 可以有多个 Session 和 Workspace；环境配置与会话执行分别持久化，不引入常驻进程。

页面只有两层职责：Weft 入口负责创建和管理环境，环境内部交给官方 Harness 的导航、聊天、工作区、插件和设置页面。切换环境相当于连接另一套 Harness。Weft 的环境管理入口可以通过独立的 Cordis 扩展贡献“返回我的 Agents”导航，不接管官方工作台布局。

“用户主机”是体验上的类比。workerd 环境没有完整操作系统或常驻主机进程；环境隔离要由服务端寻址、存储、凭据和执行权限共同保证，不能只依靠页面或 Cordis Context 的分离。共享官方客户端代码和构建产物不意味着共享用户状态。

- TenantDO 管理环境目录，并继续承载既有默认环境。
- 新环境的预设、配置版本、客户端插件版本及 Session 索引由独立 EnvironmentDO 保存。
- SessionDO / WorkspaceDO 寻址包含 tenantId、environmentId、资源 ID。不同环境允许同名资源，默认不共享。
- `default` 环境显式采用原来的 TenantDO / SessionDO / WorkspaceDO 地址，保留历史数据；已有预设保留为默认环境内的预设。
- 新 API 入口为 `/v1/tenants/:tenant/environments/:environment/...`。入口先验证 Access 租户和环境存在性，DO 再验证寻址范围。旧租户级 API 继续映射默认环境。
- 模型选择属于已发布预设，Session 固定其版本；凭据仍由服务端租户授权提供，不写入预设文档。环境自有凭据管理尚待接入。

管理入口为 `/`，环境入口为 `/agents/:environmentId`。切换环境采用完整页面导航，销毁前一个浏览器运行时；客户端宿主 API 只构造当前环境的资源路径。同源用户脚本仍与登录用户页面同权，这不等同于浏览器插件安全沙箱。

## 官方客户端接入边界

固定源码 `86a402200d95fecef4529d969836f1fe13c6cb0d` 的官方入口为 `AppWebEntry`。它依赖模块系统、Cordis Loader、Boot Graph 和 Remote 服务图。最终环境入口必须运行这条官方启动链路，使用官方的 Session/Workspace 客户端模型、Conversation、Slots、Layout、Sidebar、插件管理与设置界面。Weft 只贡献管理导航及 Cloudflare 宿主适配。

官方 Remote ABI 通过上游 `WorkspaceAnalyzer` / `FaceModelEmitter` 生成到 `.generated/official-remotes/`，不修改上游 checkout，也不手写一套近似协议。后端适配应消费这些契约，对接真实 DO 状态、日志和执行生命周期。缺失能力必须显式报告，不使用测试 mock 或固定假数据作为生产宿主。

原生会话宿主适配位于 `apps/worker/src/native-http.ts`，入口为环境 API 下的 `/native/api/<endpoint>` 与 `/native/streams/session/follow`。它消费官方 Connection 请求信封和生成的参数、结果解析器，连接真实 SessionDO。历史分页与实时订阅复用官方 SessionHistoryController / SessionQuery；执行仍由原生 AgentLoop 驱动。活动会话的读取借用真实 Session，不重复取得写入权，也不把运行中的流当成崩溃恢复。

UI 资产由没有公网入口的 Worker 通过 Static Assets binding 读取；公开入口保持独立，并先验证原生 Access 身份，再通过 Service Binding 调用资产 Worker。这为完整官方客户端及文档预览分块提供资产承载方式。

## 验收状态

已实现并验证环境目录创建、默认数据采用、配置/文件/插件/同名会话的环境隔离及重启恢复。浏览器验证覆盖目录进入、环境切换卸载及既有工作台回归。

已接通官方协议的会话创建、列表、分页、订阅、投影、提示词、标题及取消接口。它们尚未替换环境内的过渡 UI；完整原生 Inbox 的排队/steer、附件、子 Agent、模型选择和全局控制流仍需接入。提示词只有在原生用户消息入日志并同步存储后才确认接受；缺失能力明确拒绝。运行中关闭订阅不等于取消任务。

官方 Remote 的 30 个包与官方 Web 目录的 69 个客户端模块已使用上游生成器、各包自身的构建配置成功生成。运行 `npm run build:official-ui` 可复现；构建报告位于 `.generated/official-ui/build-report.json`。这些产物尚未接入生产环境入口。

Boot Graph 由真实客户端工厂产物生成，复用官方 `orderByModuleGraph` 和 `parseBootManifest` 排序与校验。当前 Web profile 激活 67 个模块，按上游条件排除仅 Desktop 启用的 product-analytics 与 sidebar-browser；不能将全部构建目录直接视为应激活的插件树。打包资产位于 `.generated/official-web-assets/`，尚未挂入生产页面。

以下工作仍未完成，目标保持进行中：

1. 将已生成的 Remote 和客户端模块产物接入官方 Boot Graph 与资产服务。
2. 官方 Session、Workspace、Settings、插件配置等 Host 接口与 DO 的连接，以及实时流和恢复。
3. 使用官方 AppWebEntry 替换当前过渡工作台，接入完整官方客户端模块树。
4. 原生动态插件与官方模块系统、检查工具、配置生命周期的对接。
5. 环境自有凭据授权、环境管理生命周期及旧数据兼容验收。
6. 在真实模型、多环境、重连、重启和 Cloudflare 部署中验收完整官方 UI。

当前 `harness-shell.tsx` 是保留既有功能的过渡入口，不是完整官方 Web App；验收时不能把它计为官方 UI 接入完成。
