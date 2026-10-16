# Weft

在 Cloudflare Workers / Durable Objects 上运行 deepseek-harness，提供租户隔离、持久 Session 和可维护的运行环境适配。

当前已接入真实 DeepSeek Messages 模型与 Web UI：直接运行固定版本的 upstream Agent Loop，支持工具循环、SSE、取消、SQLite、租户隔离及独立 Computer Workspace。Web 可配置原生 Todo、时间上下文、重复调用提醒与 Skills；Agent 可编写客户端 Cordis 插件，由用户审核启用。技术可行性、兼容性和模块边界优先，成本优化后置。

需要 Node.js 22.19+ 和 Git。

```bash
npm ci
npm run check
```

`check` 会校验或获取 `upstream.lock.json` 固定的 Harness 源码，生成源码解析配置和 vendor 类型声明，然后执行严格类型检查及真实 workerd 集成测试。已有 `deepseek-harness/` checkout 的 commit 不匹配或包含 tracked 修改时会停止，不会覆盖现有工作。

本地启动：

```bash
cp .env.example .env
# 填入服务端 DeepSeek API Key；用户登录仍由 Cloudflare Access 负责。
npm run dev
```

浏览器打开本地地址即可使用 Web UI。先在「Agent 预设」启用插件并发布，再开始会话；需要 Agent 编写 UI 时开启相应选项。界面复用官方 Harness 组件、样式和交互布局。浏览器验证为 `npm run test:web`，真实模型生成插件验证为 `npm run test:web:live`，首次需 `npx playwright install chromium`。参见 [Web 插件记录](docs/validation/web-plugins.md)。

本地通过 `cloudflare.config.ts` 的 `access.dev` 模拟开发用户；该配置只用于本地运行，不会授予云端访问权限。无需应用 Token 或 `.dev.vars`。先获取当前用户及个人租户 ID，再发送消息：

```bash
curl http://localhost:8787/v1/me
# 将上一步返回的 tenantId 填入 TENANT_ID。
curl http://localhost:8787/v1/tenants/TENANT_ID/sessions/example/messages \
  -H 'Content-Type: application/json' \
  -d '{"text":"调用身份工具"}'
curl http://localhost:8787/v1/tenants/TENANT_ID/sessions/example/events
```

云端使用 Cloudflare Access 邮箱登录和浏览器会话。Worker 只接受运行时 `ctx.access` 的可信身份，并校验应用 audience；Bearer Token 和客户端身份头不作为认证依据。首期每个 Access 用户有独立个人租户，由 Access 组织域名和用户 ID 派生；邮箱不作为租户键，组织成员关系后续接入独立授权层。云端默认模型为 `deepseek-flash`；模型密钥只在服务端配置。`npm run check` 使用确定性模型和模拟 HTTP 响应，不需要模型密钥。

发送消息时增加 `Accept: text/event-stream` 可获取增量事件；省略时返回完整 JSON。正在运行 `npm run dev` 时，可另开终端执行 `npm run test:live`，验证真实模型工具调用、SSE 和会话恢复。

创建文件 Session 时，在消息 JSON 中传入 `workspaceId`（例如 `project`），即可使用原生 `read`、`write`、`edit` 和 `workspace_search`。绑定在 Session 中持久保存，后续请求可省略；同一用户的多个 Session 可绑定同一个 Workspace 共享文件。真实文件工具验证命令为 `npm run test:live:workspace`。

目录职责：

| 路径 | 职责 |
| --- | --- |
| `apps/worker` | HTTP 入口、租户授权、SessionDO 寻址及串行执行 |
| `apps/web` | 原生 Cordis UI、官方控件与样式、会话/插件/文件交互 |
| `apps/assets` | 无公网入口的 UI 资产 Worker；主入口在 Access 鉴权后通过 Service Binding 调用 |
| `packages/control-plane` | TenantDO、不可变 Agent/客户端版本、Session 索引 |
| `packages/plugin-runtime` | 原生服务端插件目录、Config 与装配 |
| `packages/client-plugins` | TSX 转换、原生 API 检查工具、发布工具 |
| `packages/dynamic-runner` | Dynamic Workers/Cordis 隔离 runner 验证 |
| `packages/harness-runtime` | 装配 upstream 插件，通过原有 Agent API 创建、恢复和驱动 Session |
| `packages/workspace` | Computer WorkspaceDO、原生 Harness 文件系统适配、版本冲突与文件 API |
| `packages/model-provider` | 按租户解析模型与凭据、复用上游 DeepSeek 适配器、归一化安全错误 |
| `packages/session-persistence-do` | 实现 upstream `SessionPersistence` 和 `SessionHandle`，管理 SQLite 事件与写入所有权 |
| `packages/tenant` | Access 用户身份映射、SessionScope 校验和租户限定的对象名称 |
| `scripts` | 固定上游、生成类型声明、构建及依赖审计 |
| `tests` | 在本地 workerd 中执行行为、隔离、存储及恢复测试 |

Harness 装配层不依赖 Cloudflare API；模型适配器、模型路由、工具注册和持久化由宿主注入。每次请求重建 Context 并通过 upstream 恢复 Session，便于验证持久状态与运行时内存分离。

`npm run build` 生成 `dist/worker.js`、依赖清单和 `dist/runtime-audit.json`。测试专用的 `dist/contracts-worker.js` 包含故障注入入口，Wrangler 配置只引用应用 Worker。

```bash
npm run deploy:check
```

上述命令通过 `cf deploy --prebuilt --dry-run` 检查两个 Worker。正式部署使用 `npm run deploy`，或在 build 后运行 `npm run deploy:workers`，顺序用 cf 发布私有 UI 资产与主 Worker。构建通过 Cloudflare 官方 config/build-output-utils 生成标准 Build Output；配置分别在 `cloudflare.config.ts` 与 `apps/assets/cloudflare.config.ts`。

内核验证见 [技术验证记录](docs/validation/kernel.md)，真实模型、SSE 与取消协议见 [模型验证记录](docs/validation/model.md)，工作区、原生文件工具与文件 API 见 [Workspace 验证记录](docs/validation/workspace.md)。原始产品提案见 [产品架构 RFC](WEFT_PRODUCT_ARCHITECTURE.md)。上游许可见 [第三方许可](THIRD_PARTY_NOTICES.md)。

云端入口：[Weft](https://weft.luxuncang.com/)，登录后进入 Web UI；用户与租户信息在 `/v1/me`，健康检查同样受 Access 保护。源码保存在 GitHub，Cloudflare 连接 GitHub 仓库；项目不配置流水线，通过 `cf` 手动部署。部署及鉴权说明见 [部署记录](docs/deployment.md)。
