# Dynamic Workers runner 验证

结论：可作为纯 workerd 的服务端动态代码执行底座。本地 Miniflare/workerd 已验证 isolate 中原生 Cordis、限定租户的 RPC、阻止外网、宿主 Secret 不传入，以及插件失败后宿主继续工作。代码 packages/dynamic-runner，测试 tests/dynamic-runner.test.ts。

当前是技术验证：生产未声明 LOADER，Web 发布不会调用它，尚未替换官方 Node VM runner 或桥接完整 Harness 工具、事件、持久化、双端动态包协议。

get() 的 ID 对租户、revision、源码、配置计算摘要。每次调用创建 Cordis Context，装配插件，调用 pluginApi.run 后销毁。env 只有配置及受限宿主 RPC；globalOutbound:null 阻止 fetch/connect。已配置 CPU/子请求上限，本地测试不作为云端 CPU 限制证据。

get() 缓存代码不等于持久 Agent，后续请求不保证命中同一个 isolate。Session、Workspace、插件定义及执行记录继续存 DO。[官方 API](https://developers.cloudflare.com/dynamic-workers/api-reference/)

isolate 中的 Context 与主 Harness Context 是不同对象。注册模型工具、读 Session、使用 fs、传事件需要明确的 RPC adapter；不能直接共享内存 Service/闭包。宿主传限定租户的能力，而非整个 DO Namespace 或凭据。[Bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/)

UI 插件仍在浏览器 Cordis 执行，Dynamic Worker 可承载其服务端部分。后续适配官方 define/run/stop、审批、invoke 和错误回报协议，验证 abort/deadline、事件、重启恢复、云端 LOADER 与隔离限制。目前实验接收已准备的 JS，不等于任意 npm 安装。

当前单 Worker 请求最多 4 个不同 Dynamic Workers 并发，DO I/O 上下文最多 10 个，需要限制编排并发。[平台限制](https://developers.cloudflare.com/dynamic-workers/platform/limits/)
