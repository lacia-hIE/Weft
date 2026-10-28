# Changelog / 更新记录

Application versions use `vX.Y.Z`; local connector versions are independent. See [release policy](docs/releases.md). Entries describe released behavior; planned work does not imply availability.

## Unreleased / 未发布

- Local connector `0.2.5` supports DSH `0.2.1-rc.4` and DeepSeek Harness Desktop, whose Host runs the same release with its Desktop profile; CI validates that launch.
- 本地连接插件 `0.2.5` 支持 DSH `0.2.1-rc.4` 与 DeepSeek Harness 桌面 App（其 Host 以 desktop profile 运行同一发布版），CI 验证该启动方式。

- Shared outbound connection gateway: plugin WebSockets and long polls live in fill-first gateway shards, so environments sleep between messages. IM 0.6.0 uses it for QR Feishu/QQ bots and WeChat.
- 共享出站长连接网关：插件的 WebSocket 与长轮询由按需填满的网关分片持有，环境在消息之间休眠；IM 0.6.0 的飞书／QQ 扫码机器人与微信长轮询改用网关。

- Session turn notifications let environment plugins follow root Session turns without open streams; IM sends schedule results, and optionally Web turns, to bound chats.
- 会话回合通知：环境插件无需常开流即可获知根会话回合结束；IM 将定时任务结果（可选 Web 回合）发回绑定的聊天。

- Worker Host bundles share background activations with Agent tools and support native Webhook rules with the official GitHub adapter.
- Worker Host 同包支持后台服务与 Agent 工具，适配原版 Webhook 规则和官方 GitHub 入口。

- Environment-owned Worker Host plugins with native domain persistence, durable callbacks, approved HTTPS egress, scoped session operations, credential resolution and plugin-authenticated Webhook routes. Node Host is not included.
- 环境级 Worker Host：原版 domain 持久状态、后台唤醒、受控 HTTPS、会话操作、凭据解析与插件验签的 Webhook 路由；不包含 Node Host。

## [0.1.0](https://github.com/lacia-hIE/Weft/releases/tag/v0.1.0) — 2026-10-26

First versioned application release: native DSH on Cloudflare, persistent environments and workspaces, real Linux terminals, reviewed Cordis bundles, Worker tasks/documents and local Host connections. Adds bilingual open-source documentation and CI-verified release tags.

首个项目版本：原版 DSH 云端适配、持久环境与工作区、真实终端、插件审核、Worker 任务和文档处理、本地 Host 接入；补齐中英文开源文档与通过 CI 才可发布的 Tag 流程。

[Full English / 中文 release notes](docs/releases/v0.1.0.md).

## Earlier development / 早期开发

Earlier application commits were not assigned project releases; consult Git history and `docs/validation/` for historical implementation records. The independently published local connector reached `0.2.4` before application versioning; its npm versions do not represent Weft application releases.
