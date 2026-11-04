# 在 Cloudflare 查看 Dynamic Workers 用量

Weft 在平台的 Worker Loader 适配层挂接 `DynamicWorkerTail`。它把每个运行时事件的归属与指标
以结构化对象写入主 Worker 的 Cloudflare Workers Logs；查询、分组和图表使用 Cloudflare
Observability / Query Builder。业务插件、Agent 和用户代码不需要上报用量。

## 查询入口

Cloudflare → Workers & Pages → `weft-kernel-validation`（独立部署使用自己的主 Worker 名）→ Observability。
在日志详情中找到 `source = weft.dynamic-worker`，点击字段添加过滤条件。选择时间范围后，
按 `tenantId`、`environmentId`、`kind`、`pluginId` 分组；在 Query Builder 中选择数值字段进行聚合。

建议保存以下视图：

| 视图 | 筛选 / 分组 | 指标 |
| --- | --- | --- |
| 用户与环境用量 | `source`，按 `tenantId`、`environmentId` 分组 | 事件数量、`cpuTimeMs` 总和 |
| 执行类型分布 | 按 `kind` 分组 | CPU、事件数量、`wallTimeMs` 分位数 |
| 插件排行 | `kind = plugin`，按 `pluginId`、`pluginVersion` 分组 | CPU、异常数量 |
| 失败排查 | `outcome` 非成功，或 `exceptionCount > 0` | 时间、归属、`workerId`、`codeHash` |
| 重复加载排查 | 按日查看 `loaderMode`、`workerId`、`codeHash` | 唯一 Worker 观测身份、调用数量 |

`tenantId` 是资源所属用户/租户的内部 ID，不是邮件地址。用户和环境 ID 可从 Weft 的环境 URL
`/v1/tenants/<tenantId>/environments/<environmentId>/...` 获取。共享环境的后台工作归环境所有者，
不会被归到最后打开网页的人。

## 字段

所有记录包含 `source`、`event=invocation`、`schemaVersion`、`kind`、`loaderMode`、`workerId`、
`codeHash`（模块字节可获取时）、`eventTimestamp`、`cpuTimeMs`、`wallTimeMs`、`outcome`、
`exceptionCount`、`logCount`。运行时可提供时另有 `entrypoint` 与 `executionModel`。
CPU/耗时缺失时记为 `null`，不会伪装为零。

归属字段按所在资源补充 `tenantId`、`environmentId`、`sessionId`、`workspaceId`、`resourceId`；
插件另有 `pluginId`、`pluginVersion` 与 `pluginScope`。Workspace 执行由多个 Session 共享，
因此 JavaScript 与 Shell 按工作区归属，不写可能不准确的 Session ID。

执行类型：`plugin`、`ptc`、`workspace-javascript`、`workspace-shell`。本机 DSH 的 Agent 运算
不经过云端 Loader；其云端控制调用仍会产生相应的插件记录。

采集内容是指标和内部 ID，不复制程序、凭据、请求 URL、RPC 参数、用户日志正文或异常正文。
`logCount`、`exceptionCount` 保留数量，异常状态可按 `outcome` 筛选。

## 身份、恢复与计量口径

`.get()` 使用固定观测定义版本及稳定的资源归属组成缓存键；调用 ID 和时间不进入该键。
首次启用观测会切换一次定义，后续同代码、同归属的调用继续复用。
`.load()` 保持每次创建新 Worker 的行为，其 `load:<uuid>` 是 Weft 的观测关联 ID，
不是 Cloudflare 返回的 Worker ID。一个 Worker 的多次调用可产生多条事件。

Workspace 在自身 Durable Object 保存一次经过命名空间校验的归属元数据，供冷启动和后台任务
恢复使用。这里不保存用量明细或汇总，也不需要 D1、R2 用量账本或 Weft 统计页面。

日志事件数不等同于最终计费请求数；缺失、采样、保留期和 RPC 会话语义会影响分析结果。
取消执行或运行时终止可能没有最终 Tail 事件；被调用方捕获的 RPC 错误也不一定增加 `exceptionCount`。
Dynamic Worker 的计费创建数仍以 Cloudflare Usage / GraphQL 的 `distinctDynamicWorkerCount`
为准。CPU 与等待 I/O 的墙钟耗时分别展示；宿主 Worker、DO、容器、Tail 自身及模型的费用另行计算。

现有配置启用 Workers Logs，`headSamplingRate=1`，关闭默认 invocation logs；观测只新增结构化用量记录。
降低采样率后，图表应作为采样分析，不直接作为扣费账本。

官方说明：[Dynamic Workers 观测](https://developers.cloudflare.com/dynamic-workers/usage/observability/)、
[结构化日志](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)、
[计量与计费](https://developers.cloudflare.com/dynamic-workers/pricing/)。
