# Dynamic Workers runner 验证

结论：可作为纯 workerd 的服务端动态代码执行底座。本地 Miniflare/workerd 已验证 isolate 中原生 Cordis、限定租户的 RPC、阻止外网、宿主 Secret 不传入，以及插件失败后宿主继续工作。代码 packages/dynamic-runner，测试 tests/dynamic-runner.test.ts。

当前是技术验证：生产未声明 LOADER，Web 发布不会调用它，尚未替换官方 Node VM runner 或桥接完整 Harness 工具、事件、持久化、双端动态包协议。

get() 的 ID 对租户、revision、源码、配置计算摘要。每次调用创建 Cordis Context，装配插件，调用 pluginApi.run 后销毁。env 只有配置及受限宿主 RPC；globalOutbound:null 阻止 fetch/connect。已配置 CPU/子请求上限，本地测试不作为云端 CPU 限制证据。

get() 缓存代码不等于持久 Agent，后续请求不保证命中同一个 isolate。Session、Workspace、插件定义及执行记录继续存 DO。[官方 API](https://developers.cloudflare.com/dynamic-workers/api-reference/)

isolate 中的 Context 与主 Harness Context 是不同对象。注册模型工具、读 Session、使用 fs、传事件需要明确的 RPC adapter；不能直接共享内存 Service/闭包。宿主传限定租户的能力，而非整个 DO Namespace 或凭据。[Bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/)

UI 插件仍在浏览器 Cordis 执行；原生 Host 已使用下方 facet 适配接入。上述单次调用 runner 仍保留为独立隔离验证，不等于任意 npm 安装。

## 原生 Harness Host facet

`packages/native-plugins` 使用真实上游 DynamicCordisRunnerService、注册表语义、guard 和 ToolRuntime。注册表持久化在 SessionDO，目录与审批/检查请求索引存 EnvironmentDO。源码作为静态 Worker 模块提供，使用 SessionDO 的 Durable Object facet 保存跨请求的原生 Cordis 实例；不在持有平台凭据的父 Worker 中运行用户代码。[Cloudflare facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)

支持工具、timer 和限定的异步文件能力。子 Worker env 只有不可变身份的 FS RPC；没有 Namespace、模型 Secret 或直接网络。文件调用再次检查 tenant/environment/session/plugin/run，停止后旧能力失效。父 Agent 执行原生策略，子工具使用真实执行契约与投影，不伪造 Agent。协作取消传递 AbortSignal；15 秒操作期限触发 facet abort、回收注册及原生错误反馈。

测试 `tests/native-plugins.test.ts` 覆盖实际模型协议传输触发定义/运行、精确版本审批、审批前重建、Host 文件写入、环境隔离、活动旧版本与待批准新版本并存、拒绝诊断重建、停止和移除。另一个 facet 用例验证跨请求计数、所有者隔离、原生工具输出与 presentation meta、取消后实例继续使用、初始化失败、框架内部访问拒绝、未桥接 systemPrompt 拒绝、无外网，以及通过 cloudflare:workers.env / node:process.env 无法读取父宿主 Secret。

`npm run test:web:plugins` 使用可控模型 HTTP 传输；原版 AppWebEntry、审批面板、Client runner、Host facets、FS RPC 和存储都是真实实现。浏览器批准后点击插件按钮写文件，刷新重新挂载已批准 Client，停止/重跑/移除及 My Agents 导航均有交互验证。真实模型用例由 `npm run test:web:live` 运行；测试身份为本地 Access 模拟，不能替代云端允许用户登录后的验收。

默认预设禁用插件编写，需要先发布 `allowClientPlugins: true` 的预设。这里只接通原生动态 Cordis 面板，侧栏静态 Plugins 包管理器、通用 npm 安装和完整 Host 服务图仍未完成。插件闭包变量会在 facet 重建后重新初始化；持久业务数据应写入工作区。平台 Dynamic Workers/facets 限额仍然适用，本地测试不证明云端上限或 CPU 限制。

当前单 Worker 请求最多 4 个不同 Dynamic Workers 并发，DO I/O 上下文最多 10 个，需要限制编排并发。[平台限制](https://developers.cloudflare.com/dynamic-workers/platform/limits/)


补充的编写契约用例直接执行对 Agent 发布的 Host 示例：先通过原生检查工具读取能力目录，再定义和批准源码，调用隔离 handler，验证工作区实际保存内容。目录不列出父宿主未桥接的服务、FS watch/stream 等方法，也不把原版工具定义对象当作 sandbox get() 的返回值。示例固定使用 `await fs.resolve(path)` 取得 FsTarget，再调用写入，避免将裸路径传给原生文件接口。
