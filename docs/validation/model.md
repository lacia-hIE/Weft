# DeepSeek 模型、流式输出与取消验证

验证日期：2026-10-16。运行环境仍为纯 workerd，模型 HTTP 请求由固定版本 Harness 的 `DeepSeekAdapter` 发起；没有单独的 Node 服务或容器。

## 当前能力

- 通过官方 Messages API 调用 `deepseek-flash`，上游适配器负责协议序列化、SSE 解析、工具调用和历史回放。
- 每次运行由宿主解析租户的模型与凭据，再注入 Harness；用户 HTTP 请求不能指定模型密钥、网关或租户 persona。
- 默认使用平台共享模型密钥；可切换为独占的租户凭据注册表，缺席租户拒绝访问模型。
- JSON 完整响应与 SSE 增量响应共用执行路径、租户授权、持久化和取消逻辑。
- 显式取消可绕过 Session 执行队列，只作用于指定请求；取消排队请求不会将其输入写入历史。
- 模型流空闲期限默认 60 秒，整个活动回合期限默认 180 秒；排队等待不计入回合期限。
- 关闭自动模型重试，拒绝重复的活动请求 ID，同一 Session 最多接纳 32 个活动或排队请求。
- 模型错误按稳定 code 返回；供应商错误原文和 cause 在进入 Harness 日志之前替换为安全描述，避免错误响应回显服务端凭据。

## HTTP 协议

先通过 `/v1/me` 获取实际 `tenantId`。以下请求均需要 Access 用户浏览器会话，本地开发由 `access.dev` 模拟身份。

`POST /v1/tenants/:tenantId/sessions/:sessionId/messages`

```json
{"text":"调用身份工具","requestId":"d25273d7-9b66-4c03-bd52-51fcd744c46d"}
```

`requestId` 可省略，服务端会生成 UUID。JSON 响应包含租户、Session、请求 ID、模型信息和完整事件历史。

请求头添加 `Accept: text/event-stream` 时，响应包含以下事件：

| SSE 事件 | 含义 |
| --- | --- |
| `session` | 本次请求的租户、Session 与 requestId |
| `assistant-stream` | 上游原生 start / chunk / end 帧，包含文本、推理或工具调用增量 |
| `ping` | 每 5 秒的连接保活通知 |
| `session-event` | 本次运行生成的会话事件通知；最终持久化状态以完成后读取的日志为准 |
| `done` | 执行完成且持久化 flush 已完成，包含请求和模型信息 |
| `error` | 执行失败或被取消，包含 code、message、status 和 requestId |

自动断流取消采用 `enable_request_signal` 和流取消回调做尽力处理；当前本地代理链路未可靠传递该信号，不承诺客户端断开立即终止模型。需要确定停止时应调用显式取消接口，空闲与回合期限提供兜底。

SSE 一旦开始，HTTP 状态为 200；后续失败通过 `error` 事件传递。`assistant-stream` 是临时通知，不能独立充当持久历史；重连后应调用 `GET .../events` 读取已保存的事件。当前未实现按 Last-Event-ID 自动续传。每个流的本地待消费队列超过约 1 MiB 时会停止该请求，避免无限缓存。

`POST /v1/tenants/:tenantId/sessions/:sessionId/cancel`

```json
{"requestId":"d25273d7-9b66-4c03-bd52-51fcd744c46d"}
```

返回 `{ "requestId": "...", "cancelled": true }` 表示已向该活动或排队请求发送取消；未知或已完成 ID 返回 false。JSON 模式的被取消请求返回 409 / `TURN_CANCELLED`；整体期限返回 504 / `TURN_TIMEOUT`。取消完成后可读取日志，并继续发送下一回合。

请求 ID 目前只用于活动请求去重及取消，完成后重复提交同一 ID 仍可能产生新回合，不构成持久幂等保证。服务中断后自动重新投递、后台持续运行、执行中崩溃恢复仍未承诺。

## workerd 适配

上游 Messages 适配器的 `redirect: error` 在 workerd 中抛出 TypeError。构建插件仅在该固定文件内注入 `fetchProvider`，使用 `manual` 并拒绝全部 3xx，不跟随 Location、不转发模型凭据。源码匹配 guard 失败时停止构建，要求审查上游变更。上游 checkout 未修改。

原有 LLM attribution 的静态版本导入适配保留。新增 `eventsource-parser@3.1.0` 用于上游 SSE 解析。DOM AsyncIterable 类型用于检查 Web Streams 的异步迭代；运行时仍由 workerd 执行。

## 验证范围

无密钥测试在真实 workerd 中运行生产 Worker 和上游适配器，仅由 Miniflare outbound service 模拟模型 HTTP 服务。覆盖 UTF-8 / JSON / SSE 分片、心跳、真实工具回合、会话继续、提前收到文本增量、错误码分类、原始错误敏感内容清理、流截断与损坏、租户凭据选择、配置缺失、超时、取消、重复活动 ID、排队取消、断开后期限释放队列与重定向拒绝。

真实模型验证使用本地 `cf dev`，通过真实 DeepSeek API 完成模型 → tenant_identity 工具 → 模型回复，并读取持久化事件。该验证与云端 Access 邮箱登录后的用户端到端验证分开记录。

```bash
# 终端一：在被忽略的 .env 中配置 DEEPSEEK_API_KEY
npm run dev
# 终端二：显式执行真实模型测试，不加入默认回归测试
npm run test:live
```

图片 / Files API、完整 Harness profile、Computer / Workspace、工具外部副作用以及大上下文长时间运行仍待独立验证。

本次 `npm run check` 通过严格类型检查及 23 项 workerd 集成测试；`cf deploy --dry-run` 通过。`npm run test:live` 实测模型 `deepseek-flash` 完成 1 次工具调用和 2 个回合，首个文本增量约 2016 ms，总耗时约 3339 ms，第二回合完整保留第一回合事件前缀。耗时仅为本次环境观察，不作为性能保证。
