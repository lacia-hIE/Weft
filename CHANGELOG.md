# Changelog / 更新记录

Application versions use `vX.Y.Z`; local connector versions are independent. See [release policy](docs/releases.md). Entries describe released behavior; planned work does not imply availability.

## Unreleased / 未发布

- Environment-owned Worker Host plugins with native domain persistence, durable callbacks, approved HTTPS egress, scoped session operations, credential resolution and plugin-authenticated Webhook routes. Node Host is not included.
- 环境级 Worker Host：原版 domain 持久状态、后台唤醒、受控 HTTPS、会话操作、凭据解析与插件验签的 Webhook 路由；不包含 Node Host。

## [0.1.0](https://github.com/lacia-hIE/Weft/releases/tag/v0.1.0) — 2026-10-26

First versioned application release: native DSH on Cloudflare, persistent environments and workspaces, real Linux terminals, reviewed Cordis bundles, Worker tasks/documents and local Host connections. Adds bilingual open-source documentation and CI-verified release tags.

首个项目版本：原版 DSH 云端适配、持久环境与工作区、真实终端、插件审核、Worker 任务和文档处理、本地 Host 接入；补齐中英文开源文档与通过 CI 才可发布的 Tag 流程。

[Full English / 中文 release notes](docs/releases/v0.1.0.md).

## Earlier development / 早期开发

Earlier application commits were not assigned project releases; consult Git history and `docs/validation/` for historical implementation records. The independently published local connector reached `0.2.4` before application versioning; its npm versions do not represent Weft application releases.
