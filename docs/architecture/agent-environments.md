# 多套 Harness 环境与官方 UI

目标：Weft 管理多套 Harness 环境，每套环境内部使用完整的官方 Web 客户端。主题、控件或近似聊天界面不构成这一目标的完成。

## 资源边界

产品中的 Agent 对应一个 Environment，而 Harness 内部的 AgentSpec 对应该环境中的预设与发布版本。Environment 可以有多个 Session 和 Workspace；环境配置与会话执行分别持久化，不引入常驻进程。

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

## 验收状态

已实现并验证环境目录创建、默认数据采用、配置/文件/插件/同名会话的环境隔离及重启恢复。浏览器验证覆盖目录进入、环境切换卸载及既有工作台回归。

官方 Remote 的 30 个包与官方 Web 目录的 69 个客户端模块已使用上游生成器、各包自身的构建配置成功生成。运行 `npm run build:official-ui` 可复现；构建报告位于 `.generated/official-ui/build-report.json`。这些产物尚未接入生产环境入口。

以下工作仍未完成，目标保持进行中：

1. 将已生成的 Remote 和客户端模块产物接入官方 Boot Graph 与资产服务。
2. 官方 Session、Workspace、Settings、插件配置等 Host 接口与 DO 的连接，以及实时流和恢复。
3. 使用官方 AppWebEntry 替换当前过渡工作台，接入完整官方客户端模块树。
4. 原生动态插件与官方模块系统、检查工具、配置生命周期的对接。
5. 环境自有凭据授权、环境管理生命周期及旧数据兼容验收。
6. 在真实模型、多环境、重连、重启和 Cloudflare 部署中验收完整官方 UI。

当前 `harness-shell.tsx` 是保留既有功能的过渡入口，不是完整官方 Web App；验收时不能把它计为官方 UI 接入完成。
