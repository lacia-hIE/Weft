# Changelog / 更新记录

Application versions use `vX.Y.Z`; local connector versions are independent. See [release policy](docs/releases.md). Entries describe released behavior; planned work does not imply availability.

## [0.2.2-rc.1](https://github.com/lacia-hIE/Weft/releases/tag/v0.2.2-rc.1) — Unreleased / 未发布

- Superagent `0.4.2` and local connector `0.5.1` add owner-verified local Session navigation, the original DSH directory chooser for task roots, and advisory dispatch hints over the existing outbound relay. Devices authenticate and fetch commands as before; lost hints and older servers fall back to polling. The cloud plugin requests the existing connections capability.
- Superagent `0.4.2` 与本地连接插件 `0.5.1` 增加本地任务会话直达、原版任务根目录选择器及经现有出站中继发送的派工提示。本机仍凭原凭据取任务，提示丢失或服务端为旧版本时保留轮询兜底；云端插件使用原有连接授权。

- Local connector `0.5.1` allows opening completed or stopped Superagent task Sessions without reactivating their Assignment or rolling native Session activation back. Task workspaces and Files remain visible after selection and reload; Retry/Stop on a browser-owned native Agent releases only connector-owned Assignment effects.
- 本地连接插件 `0.5.1` 修复打开已完成或停止的 Superagent 任务时，会话恢复被拒绝、侧栏条目消失及文件栏提示没有目录的问题。浏览历史不会重新派工；对已打开会话重试、停止任务时，仅清理连接插件登记的派工工具和限制，保留原生浏览器持有的 Agent。

- Targets DSH `0.2.2-rc.1` and is compatible with that release only. 0.2.2 changes the Loader, tool executor, Session history, Schedule and preset contracts, so Sessions created under 0.2.1 keep their history but no longer run; the environment's own presets are migrated and republished. The project version now follows the targeted DSH release. Both container images change; publish them before deploying.
- 适配 DSH `0.2.2-rc.1`，且仅兼容该版本。0.2.2 改变了 Loader、工具执行器、会话历史、Schedule 与预设契约，0.2.1 时期创建的会话保留历史但不能继续运行；环境自己的预设会迁移后重新发布。项目版本改为与所适配的 DSH 版本一致。两份容器镜像均有变化，部署前需发布。
- Local connector `0.5.0` supports DSH `0.2.2-rc.1` only (Node 24.9 or newer); connector `0.4.0` and earlier accept only 0.2.1. Upgrade DSH and the connector together.
- 本地连接插件 `0.5.0` 只支持 DSH `0.2.2-rc.1`（Node 24.9 及以上）；`0.4.0` 及更早版本只接受 0.2.1，需同时升级 DSH 与连接插件。

- New built-in plugin `@weft/dsh-superagent`, adapted from the dsh-superagent research prototype: a proactive agent for one GitHub repository that works without a container. Environment plugins gain `weftSql` and `weftManagedSessions`, and may import the Host's `zod`, which changes the plugin builder image; publish the new image before deploying.
- 新增内置插件 `@weft/dsh-superagent`，由 dsh-superagent 研究原型适配而来：面向单个 GitHub 仓库的主动 Agent，不要求容器。环境插件新增 `weftSql`、`weftManagedSessions` 服务，并可导入宿主的 `zod`，因此插件构建镜像有变化，部署前需发布新镜像。

- Local connector `0.2.6` uses carrier protocol 3: HTTP bodies and native Mux messages keep 16 chunks in flight per stream, and text responses are gzip compressed between the device and the relay. Remote pages through a local Host load several times faster. The relay accepts protocol 3 only; upgrade the connector together with Weft.
- 本地连接插件 `0.2.6` 使用传输协议 3：HTTP 正文与原版 Mux 消息每条流最多 16 块在途，文本响应在设备与中继之间以 gzip 传输，远程打开本地 Host 页面明显更快。中继只接受协议 3，插件需与 Weft 同步升级。

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

[Full English / 中文 release notes](docs/releases/v0.2.2-rc.1.md).

## [0.1.0](https://github.com/lacia-hIE/Weft/releases/tag/v0.1.0) — 2026-10-26

First versioned application release: native DSH on Cloudflare, persistent environments and workspaces, real Linux terminals, reviewed Cordis bundles, Worker tasks/documents and local Host connections. Adds bilingual open-source documentation and CI-verified release tags.

首个项目版本：原版 DSH 云端适配、持久环境与工作区、真实终端、插件审核、Worker 任务和文档处理、本地 Host 接入；补齐中英文开源文档与通过 CI 才可发布的 Tag 流程。

[Full English / 中文 release notes](docs/releases/v0.1.0.md).

## Earlier development / 早期开发

Earlier application commits were not assigned project releases; consult Git history and `docs/validation/` for historical implementation records. The independently published local connector reached `0.2.4` before application versioning; its npm versions do not represent Weft application releases.
