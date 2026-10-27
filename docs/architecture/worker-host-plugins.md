# 第三方插件的 Worker Host

Worker Host 使用标准 Cordis 导出和原版 `dsh.bundle.patch`。这一轮扩展安装包的宿主服务，不引入新的作者协议，也不增加 Node Host。普通工具插件仍在所属 Session 的隔离 facet 中执行；需要环境服务的包由 EnvironmentDO 持有一份后台实例。

## 运行位置与权限

安装阶段在隔离环境检查实际 `inject`。依赖 `storage`、`storageDomain`、`sessionController`、`webhookRuntime`、`credentials` 或 `webServer` 的包归入环境宿主；其余包保留会话宿主。运行位置是检查得到的产物元数据，不是 npm 包另写的 Weft 声明。

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

环境包可以同时注册 Agent 工具，无须拆 npm 包。后台代码只在环境 facet 初始化一次；每个 Agent 在自己的原版 Tools 注册表挂载描述和调用代理，参数校验、结果投影与取消信号继续走原版执行链。每次执行校验精确版本及启用批次，调用以所属 Session 和独立 operationId 区分，不设置共享“当前 Agent”。工具授权关闭后不再向 Agent 暴露工具，后台服务仍可运行。工具清单在每轮开始前刷新；背景工具中的 `ctx.fs` 仍指向环境工作区，不自动切换成调用会话的 cwd。直接依赖 Agent 对象的插件仍须按 Agent 生命周期适配。创造模式的动态函数体插件继续使用原来的 fs/tools/timer 边界，不自动取得后台或网络权限。

## 存储与恢复

Kernel 装配原版 Storage 和 StorageDomain，使用已有 DurableStorageBackend 写入 facet 的独立 SQLite。DomainSpec 的 schema 在插件所在 isolate 执行，保留原版同步内存读取、写入队列、校验与 `domain/changed` 行为；不把 schema 函数序列化成远程协议。

EnvironmentDO 的数据库只登记安装和调度元数据，不保存插件代码；代码继续位于私有 R2。插件 facet 的数据属于该环境，不能读环境主库或其他包。普通宿主重建保留状态；明确停用会释放实例，重新启用保留 domain 数据。环境删除会删除已登记的插件 facet；卸载保留其私有状态以便重装。环境复制不复制插件运行状态或凭据，复制的安装仍须重新审核。

## 后台计时器

环境包的 `ctx.timer.interval(callback, delay)` / `ctx.interval` 与 `ctx.timer.timeout(callback, delay)` / `ctx.timeout` 登记持久计划。回调由插件正常初始化时重新注册，序号、周期和截止时间保存在 facet SQLite，EnvironmentDO 使用一个共享 Alarm 协调插件唤醒与安装恢复，不互相覆盖。

- interval 至少 60 秒，timeout 至少 1 秒，每包最多 32 个。
- 回调本体和普通变量不持久化；订阅参数必须由配置或 domain 状态重建。恢复只覆盖初始化时按稳定顺序重新登记的回调，运行中临时创建的闭包不能自动恢复。
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

显式授权后使用标准 `fetch()` 与 `WebSocket`。出口每次校验当前安装、版本和启用批次，只接受公开域名的 HTTPS 标准端口；拒绝凭据 URL、IP 字面量、localhost/internal 类域名与原始 socket。重定向不在监督者中隐式跟随，后续请求仍需经过出口检查。

| 档位 | 会话插件 | 环境 Host |
|---|---|---|
| 请求体 | 1 MiB | 16 MiB |
| 响应 | 整体缓冲，1 MiB | 流式透传，累计 64 MiB |
| 时限 | 整个请求 15 秒 | 响应头 120 秒（容纳长轮询），之后无数据 300 秒 |
| 授权复核 | 发送前、收完后 | 另外每 30 秒一次，撤销即中止流 |
| WebSocket | 拒绝升级 | 经监督者中继，单条消息 1 MiB |

环境 Host 的 `new WebSocket('wss://…')` 握手同样走出口检查。监督者持有远端连接，向插件交出配对的另一端：双向转发、关闭码透传，超限以 1009 关闭，授权撤销以 1008 关闭两端。出站连接不能休眠，EnvironmentDO 在连接打开期间常驻计费；部署或驱逐会断开连接，联网的环境 Host 运行时 EnvironmentDO 每 60 秒设置看门狗 Alarm，重启后重新激活，由插件自身的重连逻辑恢复连接与游标。

Cloudflare Access 断言和内部认证头不会转发给第三方。授权并不提供浏览器登录 Cookie；插件自己的目标服务认证由已授权的凭据服务或其配置处理。流式外部 SSE/MCP、长期渠道 WebSocket 仍需后续适配。

## 原版 webhookRuntime

环境包可直接 `inject: ['webhookRuntime']`，使用原版 `register(rule)` / `dispatch(delivery)`。宿主已装配运行时，不必另外挂载本地 Node Host 的运行时入口。授权对应“管理本环境会话”。

规则注册、输入快照、匹配、回调取消与卸载等待复用固定上游 `WebhookRuntime` 的实现；只将其内部创建 Session 的宿主动作替换为 Worker 端口。规则函数留在自己的 facet，不跨 RPC 传函数或伪造 Agent 对象。环境将事件分发给已启用的规则包，因此提供方适配器和规则可以放在同一个 bundle，也可以分别安装。

创建动作使用真实 Workspace 和 Session 服务，设置 Agent 预设、权限预设、标题、初始模型选择及可选 maxTokens；省略 model 时捕获环境的初始选择。消息保留原版 webhook source（provider/source/deliveryId/ruleId）。发布前再次确认授权和取消状态；失败时清理本次创建的 Session、工作区关联和列表摘要。成功接纳后 Agent 由 Session 持有，卸载规则不会取消已接纳的会话。

`dispatch()` 保留立即返回、不等待规则执行完成的行为；HTTP carrier 在返回 202 前等待跨 Worker 的分发接纳。执行由 Worker `waitUntil` 持有，**目前不是崩溃后可重放的持久消息队列**。deliveryId 是来源信息，不自动去重；需要可靠重试的渠道应在自己的持久状态中处理重复消息。

官方 `@deepseek-ai/dsh-webhook-github` 可作为普通 bundle 依赖并在原版 patch 中配置：

```yaml
- insert:
    - id: github
      name: '@deepseek-ai/dsh-webhook-github'
      config:
        source: primary
        path: /github
        secretEnv: GITHUB_WEBHOOK_SECRET
        maxBodyBytes: 65536
```

在环境凭据中设置 `GITHUB_WEBHOOK_SECRET`，批准凭据、公开路由、会话和后台运行权限。该适配器复用原版原始正文读取和 Octokit 验签；Worker carrier 补齐其所需的 headersDistinct、complete 与 resume，含糊的单值认证头按失败处理。编译器共享匹配的原版模块和品牌类型，支持 Worker 内的 node:crypto / node:buffer；不开放进程、文件系统模块或监听端口。

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

这是一阶段的 Worker Host 服务扩展，尚不等于完整本地 Host。没有 Node Host、Node 原生扩展、任意 Node 内置导入、通用子进程桥接、完整 WebServer/Remote 服务、自定义凭据配置表单或跨包任意同步对象共享。原版 Webhook 规则接口与官方 GitHub 适配器已有 Worker 兼容路径；其他提供方若依赖完整 Node 请求、socket、进程或任意 Host 对象，仍需逐项适配。

验证仅在 ci 执行，覆盖真实离线构建、workerd facet、原版 domain、重建后定时触发、原版消息接纳、渠道路由认证、版本撤销，以及现有浏览器、进程和本地 Host 回归。
