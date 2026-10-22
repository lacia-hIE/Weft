# 插件运行诊断

全局插件清单描述固定部署的接入方式和环境配置，不代表每个会话的实时状态。运行诊断提供两个明确的数据来源：当前浏览器的真实 Cordis Loader / registry，以及指定会话所属根 SessionDO 中已存在的原生宿主。

入口为 Plugins → 插件运行诊断，以及 Settings → 内置插件 → 插件运行诊断。选择当前浏览器或已有会话，可筛选插件、查看 Fiber 状态和缺失服务，并手动刷新。页面可见时每 5 秒刷新；隐藏标签和卸载页面后停止发起新的读取，卸载时取消在途 HTTP 请求。采集时间用于区分上次成功读取与当前读取失败。

服务端接口为当前环境下的 `GET native/plugins/runtime?sessionId=...`。入口保留 Access、租户和环境校验；先确认会话所属根，再调用根 SessionDO 的只读 RPC。查询可能激活 Durable Object，但不会恢复 Agent、调用模型、运行工具或启动容器。没有热宿主时返回 `inactive` 和空条目；宿主创建中返回 `loading`，当前实例的创建失败返回 `failed`。Durable Object 重建后不会把之前实例的错误当作当前运行状态。

条目从实际 Loader entries 和 registry fibers 读取，不使用预设检查世界。Loader 条目保留模块及 entry id，手动挂载的 Fiber 使用运行时名称和 uid；最多返回 2048 项并明确标记截断。缺失依赖来自该 Fiber 的声明和实际服务可见性。禁用时尚未结束的异步清理仍显示卸载中。

失败使用公开的 Fiber `await()` 读取已失败的结果，只返回固定白名单中的错误类型与代码，区分配置校验和插件启动失败。原始错误文本、堆栈、配置和凭据不返回浏览器；任意自定义错误名与错误码也不会直接透出。详情仍在宿主日志中。模块未创建 Fiber 时显示无运行实例，不凭空归因为启动失败。

验证位于 `tests/plugin-runtime.test.ts`、Workerd 夹具 `tests/fixtures/plugin-runtime-worker.ts` 和 `tests/browser/plugin-runtime.spec.ts`，覆盖真实活动/等待/失败 Fiber、配置校验错误、错误脱敏、冷读不恢复 Agent、实际 Loader 开关变化、环境隔离、浏览器状态和两个 UI 入口。按项目约定在 `ci` 分支运行。

范围：这是指定宿主或当前页面的即时诊断，不是所有会话的汇总、历史监控或配置开关的应用确认。子会话与根共用宿主，诊断响应的 `sessionId` 指明根身份；进程状态、容器端口和端口预览属于后续工作。
