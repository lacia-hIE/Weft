# 第三方插件的 Worker Host

Worker Host 使用标准 Cordis 导出和原版 `dsh.bundle.patch`。这一轮扩展安装包的宿主服务，不引入新的作者协议，也不增加 Node Host。普通工具插件仍在所属 Session 的隔离 facet 中执行；需要环境服务的包由 EnvironmentDO 持有一份后台实例。

## 运行位置与权限

安装阶段在隔离环境检查实际 `inject`。依赖 `storage`、`storageDomain`、`sessionController`、`credentials` 或 `webServer` 的包归入环境宿主；其余包保留会话宿主。运行位置是检查得到的产物元数据，不是 npm 包另写的 Weft 声明。

沿用 Plugins 包详情的原版审核入口，审核精确代码摘要后授权：

| 权限 | 能力 |
| --- | --- |
| 文件 | 原有工作区 fs 桥接；无、只读或读写 |
| 工具、计时器、Client | 原有注册工具、计时器和浏览器模块能力 |
| 外部 HTTPS | 标准 `fetch` 经监督者出口执行，不直接开放任意网络 |
| 插件持久状态 | 原版 `storage` / `storageDomain`，后端是插件 facet 自己的 SQLite |
| 管理环境会话 | 原版 Session Controller 的受支持方法，限定所属环境的根会话 |
| 读取环境凭据 | 原版 `credentials.resolve(ref)`，每次向所属环境解析 |
| 环境后台运行 | 实例独立于浏览器和 Session 存在，可按持久计划唤醒 |
| 公开 Webhook | 在所属包的独立路径内注册入口；插件负责提供方认证与验签 |

新网络、凭据和公开路由权限默认不勾选。旧安装记录不自动增加权限；如需新增能力，安装新版本并重新审核。授权跟随精确产物和启用批次，撤销后旧能力引用不能继续访问环境资源。

环境包本版不能同时注册 Agent 工具；需要后台触发与模型工具的组合，应拆成后台包和会话工具包。创造模式的动态函数体插件继续使用原来的 fs/tools/timer 边界，不自动取得后台或网络权限。

## 存储与恢复

Kernel 装配原版 Storage 和 StorageDomain，使用已有 DurableStorageBackend 写入 facet 的独立 SQLite。DomainSpec 的 schema 在插件所在 isolate 执行，保留原版同步内存读取、写入队列、校验与 `domain/changed` 行为；不把 schema 函数序列化成远程协议。

EnvironmentDO 的数据库只登记安装和调度元数据，不保存插件代码；代码继续位于私有 R2。插件 facet 的数据属于该环境，不能读环境主库或其他包。普通宿主重建保留状态；明确停用会释放实例，重新启用保留 domain 数据。环境删除会删除已登记的插件 facet；卸载保留其私有状态以便重装。环境复制不复制插件运行状态或凭据，复制的安装仍须重新审核。

## 后台计时器

环境包的 `ctx.timer.interval(callback, delay)` / `ctx.interval` 与 `ctx.timer.timeout(callback, delay)` / `ctx.timeout` 登记持久计划。回调由插件正常初始化时重新注册，序号、周期和截止时间保存在 facet SQLite，EnvironmentDO 使用一个共享 Alarm 协调插件唤醒与安装恢复，不互相覆盖。

- interval 至少 60 秒，timeout 至少 1 秒，每包最多 32 个。
- 回调本体和普通变量不持久化；订阅参数必须由配置或 domain 状态重建。
- 正常重建保留已完成的一次性计划和未完成计划；注册顺序应保持稳定。
- 成功后推进下一次期限，失败后延迟重试；错过的周期合并，不逐次补跑。
- 崩溃可能使未确认的回调再次执行。使用持久游标、渠道消息 ID 和 Session `requestId` 去重，不能据此承诺外部副作用恰好一次。
- 停用/暂停释放回调，重新启用时重新登记；不会在后台持续计费等待一个 JS 定时器。
- `timeout(delay)`、`interval(delay)` 等其他重载没有持久恢复承诺；本版持久接口限定为回调形式。

普通会话插件的计时器行为不变。环境调用有执行期限，长任务应保存状态后分批推进，不在一次回调中无限等待模型或渠道连接。

## 会话接口

通过 `inject: ['sessionController']` 使用：

- `create(request)`、`prompt(request, signal?)`、`cancel(request)`、`rename(request)`；
- `list(request)`、`page(request, signal?)`、`projections(request, signal?)`；
- `follow(request, signal?)` 返回原版 SessionFollowFrame 异步流，关闭迭代器会取消观察，不取消 Agent。

参数及返回值使用固定上游 Remote 契约。prompt 在消息持久接纳后返回，不等待 Agent 完成；同一 `requestId` 由原版收件箱和日志去重。可向 Web 已有会话或插件创建的根会话投递，不能访问其他环境或直接取得 Agent 对象。子会话操作、任意代理对象、模型选择及其他未列方法暂不桥接。

## HTTPS 出口

显式授权后使用标准 `fetch()`。出口每次校验当前安装、版本和启用批次，只接受公开域名的 HTTPS 标准端口；拒绝凭据 URL、IP 字面量、localhost/internal 类域名、WebSocket 升级与原始 socket。请求和响应各最多 1 MiB，网络操作超时 15 秒。重定向不在监督者中隐式跟随，后续请求仍需经过出口检查。

Cloudflare Access 断言和内部认证头不会转发给第三方。授权并不提供浏览器登录 Cookie；插件自己的目标服务认证由已授权的凭据服务或其配置处理。流式外部 SSE/MCP、长期渠道 WebSocket 仍需后续适配。

## Webhook 路由

`inject: ['webServer']` 后，通过原版 `register({kind, path, handler})` 登记有限响应的 HTTP 处理器，并用 `ctx.effect` 交出 disposer。支持 exact 和最长 prefix 匹配。

本版 carrier 支持常用的 `req.method`、`req.url`、`req.headers`、异步迭代正文，以及 `res.statusCode`、`setHeader/getHeader`、`writeHead`、`write/end`。它不模拟完整 Node IncomingMessage/ServerResponse，也不开放监听端口、socket、升级、长期 SSE 或任意 Node 导入。可使用 Fetch 风格的 GET/HEAD `resource(request)`；依赖未支持 Node 接口的现成适配器仍需改为 Worker 可用写法。

公网地址：

```text
https://<your-domain>/v1/plugin-hooks/<tenant>/<environment>/<encodeURIComponent(package-name)>/<registered-path>
```

例如注册 `/github`，把最后一段替换为 `/github`。实际转入插件的 pathname 为 `/github`，不包含平台前缀。该入口不建立浏览器身份；只转给已启用、已批准公开路由的包，缺失包和路由返回 404。插件必须在创建任务前校验渠道签名或凭据。不要把“请求进入 Worker”当作已验证事件。

部署者需为 `/v1/plugin-hooks/*` 配置单独、更具体的 Access Bypass 应用；首页和 `/v1/tenants/*` 继续要求登录。没有配置 Bypass 时，请求仍会被 Cloudflare Access 拦截。本次代码不会修改部署账号的 Access 策略。

请求正文最多 64 KiB（已声明长度及 handler 读取时检查），有限 handler 响应最多 1 MiB。公开响应强制 no-store/nosniff 和 sandbox CSP，移除 Set-Cookie，避免插件入口成为主站身份或脚本执行入口。API 入口不用于插件 UI；界面扩展仍走批准的 Client 模块。

## 当前边界

这是一阶段的 Worker Host 服务扩展，尚不等于完整本地 Host。没有 Node Host、Node 原生扩展、任意 Node 内置导入、通用子进程桥接、完整 WebServer/Remote 服务、自定义凭据配置表单或跨包任意同步对象共享。原版 `webhookRuntime` 和提供方适配器不会因此自动兼容；可通过已开放的路由与 Session Controller 编写 Worker 插件，后续再逐项适配原版服务。

验证仅在 ci 执行，覆盖真实离线构建、workerd facet、原版 domain、重建后定时触发、原版消息接纳、渠道路由认证、版本撤销，以及现有浏览器、进程和本地 Host 回归。
