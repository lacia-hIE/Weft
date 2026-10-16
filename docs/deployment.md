# Cloudflare 部署

项目使用 npm 锁定的 `cf@1.0.0-beta.17`，`cloudflare.config.ts` 声明 Worker、Access audience 与 SessionDO / WorkspaceDO 两个 SQLite Durable Object，`wrangler.config.ts` 保留构建器设置。源码先由 Weft 的 esbuild 脚本打包，再由 cf 生成 Build Output 并发布。

Worker：`weft-kernel-validation`。自定义域名：`weft.luxuncang.com`。健康检查：https://weft.luxuncang.com/health 。源码：https://github.com/lacia-hIE/Weft 。

## 手动部署

```bash
npm ci
npm run check
cf auth login
npm run deploy
```

也可以先运行 `npm run build`，再执行 `npx cf deploy`。`cf` 本身不执行 package.json 的 build 脚本，不能在未生成 `dist/worker.js` 时直接部署。

## Access 用户登录

直接打开 https://weft.luxuncang.com/ ，通过 Cloudflare Access 的邮箱验证码登录。登录后 `/` 与 `/v1/me` 返回当前用户及个人 `tenantId`；Session API 使用浏览器登录会话，无需手工配置 Bearer Token。`/health` 也需要登录。

- Access 组织：`aigraph.cloudflareaccess.com`。
- 应用：`Weft`，ID `c087ebda-0e03-4204-bc71-a99f2be49a6c`，保护完整域名 `weft.luxuncang.com`。
- 引用已有可复用策略 `luxuncang`，ID `794a6757-ac89-4f8b-8e6a-6d68bef91490`，允许 `@luxuncang.com` 邮箱；未额外允许 QQ 邮箱。
- 应用 audience 固定在 `cloudflare.config.ts`；重新创建 Access 应用时必须更新并重新部署。
- `workers.dev` 和 preview URL 显式关闭。即使出现其他入口，缺少可信 `ctx.access` 或 audience 不匹配的请求也会被 Worker 拒绝。
- 使用域名级 Access 应用，便于后续接入 WebSocket；当前未启用不支持 WebSocket 的 Worker 级 Access 规则。

Worker 使用 Cloudflare 官方提供的 [`ctx.access`](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) 读取认证身份，不自行信任 `Cf-Access-Jwt-Assertion` 或邮箱头。只有包含邮箱和稳定用户 ID 的人类用户身份可以访问，Service Token 不提供用户入口。写请求要求 JSON，拒绝跨 Origin 或 `Sec-Fetch-Site: cross-site` 请求。

个人租户 ID 为 `user-` 加 SHA-256(JSON([Access 组织域名, 用户 ID]))。不同用户即使使用同一个 Session 名也对应不同的 Durable Object。邮箱变更不改变同一用户 ID 的租户；在 Access 中删除并重建用户可能产生新用户 ID，历史租户迁移需显式处理。原 alpha / beta 验证 Session 不映射给真实用户。

本地 `npm run dev` 使用 `access.dev` 的模拟身份；该设置不参与生产认证。原应用 `VALIDATION_AUTH_JSON` 注册表已停用并从部署中移除。当前默认接入真实 DeepSeek 模型，服务端模型密钥存储于 `DEEPSEEK_API_KEY` Secret，与用户 Access 登录分离。

## GitHub 关联

Worker 的“构建 → Git 存储库”已原生绑定 `lacia-hIE/Weft` 的 `main` 分支。构建命令为 `npm run build`，部署命令为 `npx cf deploy`，根目录为 `/`。自动构建和预览构建均关闭；项目不配置 GitHub Actions，检查与发布由开发者手动执行。

Cloudflare 仓库连接已确认，连接 ID 为 `8256897f-8bbb-490b-993e-8a1537f0a29a`。部署配置的 `worker.domains` 声明自定义域名，发布时由 Cloudflare 管理 DNS 和证书。

也可在 Cloudflare 控制台手动启动构建，或执行：

```bash
npx cf builds create 7757abed-2c84-40db-9c15-60baaef0c190 --branch main
```

Cloudflare 原生构建使用专用 `weft-native-builds` 部署凭据；凭据保存在 Cloudflare，不上传 GitHub Secret。

原生构建环境固定 Node.js `22.21.1`。2026-10-16 手动构建 `942d398c-d2e5-4039-827f-6af24d24c112` 已成功从 GitHub 获取源码、安装依赖、检出固定 Harness commit、打包并通过 `cf` 发布至自定义域名。构建结果为 `success`，部署版本为 `b1693a7c-a345-4412-ad4b-5c90c5178aa4`。

2026-10-16 的首次云端检查已验证：健康检查、两租户模型工具循环、Session 日志读取、无凭据返回 401、跨租户访问返回 403。

2026-10-16 Access 迁移：本地真实 workerd 的 11 项集成测试通过，覆盖可信身份、错误 audience、服务身份与伪造请求头拒绝、跨用户隔离、邮箱变更、跨站写入拒绝，以及原 Harness / SQLite / 重建恢复验证。云端未登录请求和伪造身份请求均由 Access 拦截并重定向至登录；真实邮箱验证码登录后的端到端操作需由允许的用户完成。

本次通过 `cf` 发布的 Worker 版本：`a1404037-0a25-410f-9513-a1e1190c4a21`。复核云端 Secret 列表为空；原生 GitHub 仓库关联保持，`auto_build_enabled` 与 `previews_enabled` 均为 `false`。`cf dev` 的本地模拟身份查询及实际 Harness 工具循环也已通过。

## 真实模型部署

`cloudflare.config.ts` 指定 `MODEL_BACKEND=deepseek`、`DEEPSEEK_MODEL=deepseek-flash` 及 `DEEPSEEK_API_KEY` Secret。首次部署通过权限为 `0600` 的临时 secrets JSON 文件提供模型密钥，再执行 `npx cf deploy --secrets-file /path/to/secrets.json`；发布成功后删除临时副本。后续手动部署和原生 GitHub 手动构建沿用 Cloudflare 的 Secret。

默认由平台提供共享模型凭据，用户 Session 和历史仍按个人租户隔离。服务端解析器支持 `TENANT_MODEL_CONFIG_JSON` Secret：键为实际 `tenantId`，值为 `{ "apiKey": "...", "model": "deepseek-flash" }`。启用该 Secret 时应在配置的 `worker.env` 中声明对应 `bindings.secret()` 并部署；此时注册表独占，缺席租户返回 `MODEL_NOT_CONFIGURED`，不会回退到平台共享密钥。当前尚无用户自助密钥管理页面。

可在服务端配置中声明 `DEEPSEEK_BASE_URL`、`MODEL_IDLE_TIMEOUT_MS` 和 `MODEL_TURN_TIMEOUT_MS` 文本绑定，调整网关与期限；默认分别为官方 Anthropic 兼容 API、60 秒和 180 秒。网关必须使用 HTTPS，无 URL 凭据、查询参数或片段，HTTP 客户端不能覆盖这些配置。当前自动模型重试关闭，避免隐藏重放；后续在幂等和任务恢复设计中明确重试策略。

2026-10-16 真实模型版本已由 `cf deploy` 发布：`bc3db012-0947-4963-aa8c-bea2507cd52b`。模型密钥已写入 Cloudflare Secret，临时部署文件已删除。真实 DeepSeek 的工具调用、SSE 与第二回合恢复在本地 workerd 中通过；Access 用户登录后的云端端到端验证仍需允许的用户完成。

## Workspace 部署

新增 `WORKSPACES` 绑定与 `WorkspaceDO` SQLite export；`cf deploy` 管理对应生命周期声明。现有 SessionDO 命名和存储保留。工作区使用 `@cloudflare/computer@0.5.1`，无 Container 或执行后端；无需增加模型以外的 Secret。文件 API、Session 绑定及验证细节见 [Workspace 记录](validation/workspace.md)。

2026-10-16 Workspace 版本发布成功：`d621df0e-aeda-4add-91f7-0cefa9fa25c8`。已复核 WorkspaceDO 为 SQLite namespace `340c996ea191459484a0ce6059072943`，SessionDO namespace 保留。模型 Secret、指定 Access 策略及 GitHub 原生仓库关联保留，自动构建与预览构建均关闭。云端文件入口的未登录及伪造身份请求会跳转 Access 登录。
