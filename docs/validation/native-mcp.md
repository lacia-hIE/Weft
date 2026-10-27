# 原生 MCP

环境在原版设置页的 `mcp-servers` 中配置远程 MCP 服务器。每台服务器在每个 Session 中成为一条原版 `@deepseek-ai/dsh-mcp-client` 条目（`mcp-server-<名称>`），工具以 `mcp__<名称>__<工具>` 出现；有服务器时原版 `dsh-mcp-resources` 同时提供 `list_mcp_resources`、`list_mcp_resource_templates` 和 `read_mcp_resource`。客户端、协议协商（2026-07-28 优先，回退旧版）、工具同步、取消、超时与重连都由原版包和官方 SDK 负责，Weft 只提供条目与配置。

| 字段 | 说明 |
|---|---|
| `name` | `[A-Za-z0-9_-]{1,32}`，环境内唯一 |
| `url` | Streamable HTTP 端点，必须是公开域名的 `https://` |
| `headers` | 请求头，例如 `Authorization`；值为 `role('secret')`，只写不读，配置文档和复制也不带出 |
| `toolCallTimeoutMs` | 单次工具调用或资源读取的时限，1 秒到 10 分钟，默认 60 秒 |
| `enabled` | 关闭后条目在下一轮前移除 |

保存时拒绝重复名称、非 HTTPS、IP 字面量和 localhost/internal 类域名。编辑在每轮开始前应用到运行中的 Session：未变化的服务器保持连接，变化的条目以新配置重建，删除或停用的服务器连同工具一起移除。连接失败不影响 Session，原版客户端记录错误并按其退避策略重连。

MCP 客户端是可信的原版代码，运行在 SessionDO 中，直接使用 Worker 的 `fetch`，不经过第三方插件出口，也不受其 15 秒 / 1 MiB 限制；长时间的 SSE 响应随工具调用一起结束。每个 Session 各自连接；SessionDO 休眠或重启后，下次使用时重新协商。stdio 服务器需要本地子进程，Worker Session 中配置为 stdio 的条目会明确报错，`mcp-servers` 也只提供 Streamable HTTP。MCP 的 OAuth 授权流程尚未接入，需要令牌时请在 `headers` 中提供。
