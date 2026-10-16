# Weft

在 Cloudflare Workers / Durable Objects 上运行 deepseek-harness，提供租户隔离、持久 Session 和可维护的运行环境适配。

当前交付为第一阶段技术验证工程：直接运行固定版本的 upstream Agent Loop，使用确定性模型适配器验证工具循环、SQLite 持久化和租户隔离。技术可行性、兼容性和模块边界优先，成本优化后置。

需要 Node.js 22.19+ 和 Git。

```bash
npm ci
npm run check
```

`check` 会校验或获取 `upstream.lock.json` 固定的 Harness 源码，生成源码解析配置和 vendor 类型声明，然后执行严格类型检查及真实 workerd 集成测试。已有 `deepseek-harness/` checkout 的 commit 不匹配或包含 tracked 修改时会停止，不会覆盖现有工作。

本地启动：

```bash
cp .dev.vars.example .dev.vars
# 将 .dev.vars 中的 token 替换为随机值。
npm run dev
```

```bash
curl http://localhost:8787/health
curl http://localhost:8787/v1/tenants/demo/sessions/example/messages \
  -H 'Authorization: Bearer YOUR_LOCAL_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"text":"调用身份工具"}'
curl http://localhost:8787/v1/tenants/demo/sessions/example/events \
  -H 'Authorization: Bearer YOUR_LOCAL_TOKEN'
```

`VALIDATION_AUTH_JSON` 是本阶段的验证用凭据注册表，提供 bearer token、租户和 persona 的可信映射；用户与组织管理、正式鉴权和模型凭据管理仍待实现。没有配置时，Session API 拒绝访问。当前模型始终为 `scripted`，无需模型 API Key。

目录职责：

| 路径 | 职责 |
| --- | --- |
| `apps/worker` | HTTP 入口、租户授权、SessionDO 寻址及串行执行 |
| `packages/harness-runtime` | 装配 upstream 插件，通过原有 Agent API 创建、恢复和驱动 Session |
| `packages/session-persistence-do` | 实现 upstream `SessionPersistence` 和 `SessionHandle`，管理 SQLite 事件与写入所有权 |
| `packages/tenant` | 验证环境身份映射、SessionScope 校验和租户限定的对象名称 |
| `scripts` | 固定上游、生成类型声明、构建及依赖审计 |
| `tests` | 在本地 workerd 中执行行为、隔离、存储及恢复测试 |

Harness 装配层不依赖 Cloudflare API；模型适配器、模型路由、工具注册和持久化由宿主注入。每次请求重建 Context 并通过 upstream 恢复 Session，便于验证持久状态与运行时内存分离。

`npm run build` 生成 `dist/worker.js`、依赖清单和 `dist/runtime-audit.json`。测试专用的 `dist/contracts-worker.js` 包含故障注入入口，Wrangler 配置只引用应用 Worker。

```bash
npm run deploy:check
```

上述命令通过 `cf deploy --dry-run` 检查部署产物。正式部署使用 `npm run deploy`，或在 `npm run build` 后执行 `npx cf deploy`。部署配置以 `cloudflare.config.ts` 为准，`wrangler.config.ts` 只提供构建器设置。

当前实测范围、适配点和下一阶段计划见 [技术验证记录](docs/validation/kernel.md)。原始产品提案见 [产品架构 RFC](WEFT_PRODUCT_ARCHITECTURE.md)。上游许可见 [第三方许可](THIRD_PARTY_NOTICES.md)。

云端验证入口：[健康检查](https://weft.luxuncang.com/health)。源码保存在 GitHub，Cloudflare 连接 GitHub 仓库；项目不配置流水线，通过 `cf` 手动部署。部署及鉴权说明见 [部署记录](docs/deployment.md)。
