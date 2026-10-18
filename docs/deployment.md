# Cloudflare 部署

项目使用 npm 锁定的 `cf@1.0.0-beta.17`，`cloudflare.config.ts` 声明主 Worker、Access audience 与 SessionDO / WorkspaceDO / TenantDO / EnvironmentDO 四个 SQLite Durable Object。`apps/assets/cloudflare.config.ts` 声明私有 UI 资产 Worker。esbuild 打包后通过 Cloudflare 官方 config/build-output-utils 生成标准 Build Output，由 cf 按资产、主 Worker 的顺序发布。

Worker：`weft-kernel-validation`。自定义域名：`weft.luxuncang.com`。健康检查：https://weft.luxuncang.com/health 。源码：https://github.com/lacia-hIE/Weft 。

## 手动部署

```bash
npm ci
npm run check
cf auth login
npm run deploy
```

也可以先运行 `npm run build`，再执行 `npm run deploy:workers`。该命令使用 `cf deploy --prebuilt` 顺序发布两个 Worker；先运行 `npm run deploy:check` 可检查两份产物。构建产物生成后才能发布。

## Access 用户登录

直接打开 https://weft.luxuncang.com/ ，通过 Cloudflare Access 的邮箱验证码登录。登录后 `/` 进入 Web UI，`/v1/me` 返回当前用户及个人 `tenantId`；Session API 使用浏览器登录会话，无需手工配置 Bearer Token。`/health` 也需要登录。

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

Worker 的“构建 → Git 存储库”已原生绑定 `lacia-hIE/Weft` 的 `main` 分支。构建命令为 `npm run build`，部署命令为 `npm run deploy:workers`，根目录为 `/`。生产自动构建已开启：推送到 `main` 后由 Cloudflare 原生 Git 构建并顺序部署私有 UI 资产与主 Worker。预览构建仍关闭，其他分支不自动发布。项目不配置 GitHub Actions。

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

`cloudflare.config.ts` 指定 `MODEL_BACKEND=deepseek`、`DEEPSEEK_MODEL=deepseek-flash` 及 `DEEPSEEK_API_KEY` Secret。首次部署通过权限为 `0600` 的临时 secrets JSON 文件提供模型密钥，再执行 `npx cf deploy --secrets-file /path/to/secrets.json`；发布成功后删除临时副本。后续手动部署和原生 GitHub 构建沿用 Cloudflare 的 Secret。

默认由平台提供共享模型凭据，用户 Session 和历史仍按个人租户隔离。服务端解析器支持 `TENANT_MODEL_CONFIG_JSON` Secret：键为实际 `tenantId`，值为 `{ "apiKey": "...", "model": "deepseek-flash" }`。启用该 Secret 时应在配置的 `worker.env` 中声明对应 `bindings.secret()` 并部署；此时注册表独占，缺席租户返回 `MODEL_NOT_CONFIGURED`，不会回退到平台共享密钥。官方 UI 的 Models 设置已可保存环境自己的密钥；密钥不会读取回客户端。平台回退密钥只用于服务端配置的 endpoint，自定义域名或 base path 要求环境自己的密钥。

可在服务端配置中声明 `DEEPSEEK_BASE_URL`、`MODEL_IDLE_TIMEOUT_MS` 和 `MODEL_TURN_TIMEOUT_MS` 文本绑定，调整网关与期限；默认分别为官方 Anthropic 兼容 API、60 秒和 180 秒。网关必须使用 HTTPS，无 URL 凭据、查询参数或片段，HTTP 客户端不能覆盖这些配置。当前自动模型重试关闭，避免隐藏重放；后续在幂等和任务恢复设计中明确重试策略。

2026-10-16 真实模型版本已由 `cf deploy` 发布：`bc3db012-0947-4963-aa8c-bea2507cd52b`。模型密钥已写入 Cloudflare Secret，临时部署文件已删除。真实 DeepSeek 的工具调用、SSE 与第二回合恢复在本地 workerd 中通过；Access 用户登录后的云端端到端验证仍需允许的用户完成。

## Workspace 部署

新增 `WORKSPACES` 绑定与 `WorkspaceDO` SQLite export；`cf deploy` 管理对应生命周期声明。现有 SessionDO 命名和存储保留。工作区使用 `@cloudflare/computer@0.5.1`，无 Container 或执行后端；无需增加模型以外的 Secret。文件 API、Session 绑定及验证细节见 [Workspace 记录](validation/workspace.md)。

2026-10-16 Workspace 版本发布成功：`d621df0e-aeda-4add-91f7-0cefa9fa25c8`。已复核 WorkspaceDO 为 SQLite namespace `340c996ea191459484a0ce6059072943`，SessionDO namespace 保留。模型 Secret、指定 Access 策略及 GitHub 原生仓库关联保留，自动构建与预览构建均关闭。云端文件入口的未登录及伪造身份请求会跳转 Access 登录。

## Web UI 与插件部署

2026-10-17 已通过 cf 的标准 Build Output 发布两份 Worker：

- 主 Worker：`fba34fdc-ee9b-47ea-b4ae-b3bb083656ae`，自定义域名 `weft.luxuncang.com`。
- 私有 UI 资产 Worker：`c73c7860-209c-43bd-b874-6650910eb5f7`；无域名、公网路由、workers.dev 或预览入口，仅供主 Worker 的 UI Service Binding 调用。
- 新 TenantDO SQLite namespace：`7c6ef46aef124749a2bf357e023e7529`。SessionDO / WorkspaceDO namespace 保留。

严格类型检查、35 项 workerd 回归、源码目录切换后的 3 项补充测试、两项浏览器回归及真实 DeepSeek 生成客户端插件的浏览器故事均通过。UI 直接复用固定 Harness 的主题、控件、Markdown、布局算法及相关 CSS module。具体流程与支持边界见 [Web 插件验收](validation/web-plugins.md)。

云端复核：指定 Access 策略 `794a6757-ac89-4f8b-8e6a-6d68bef91490` 保留；根页面、资产与伪造身份 API 请求均返回 302 至 Access 登录。两个 Worker 的 workers.dev 与预览入口关闭。GitHub 原生关联仍为 main，构建命令 `npm run build`，部署命令已更新为 `npm run deploy:workers`，自动构建和预览构建仍为 false。实际允许用户完成邮箱验证码登录后的云端操作尚未验证。

## 推送触发自动部署

2026-10-17 按新的部署要求开启生产自动构建：`auto_build_enabled=true`，`previews_enabled=false`。监听仓库 `lacia-hIE/Weft` 的 `main` 分支，构建命令保持 `npm run build`，部署命令保持 `npm run deploy:workers`。因此推送到 main 会自动更新 `weft.luxuncang.com`；`git pull` 仅更新本地代码，不触发发布。此前记录中的“自动构建关闭”为当时配置。

可在 Cloudflare 控制台的 Worker 构建页面查看提交对应的构建和部署结果；手动部署命令仍可使用。

`scripts/deploy-workers.mjs` 顺序发布两份预构建产物。Workers Builds 注入的 `WRANGLER_CI_MATCH_TAG` / `WRANGLER_CI_OVERRIDE_NAME` 只描述关联的主 Worker，因此发布私有 UI 资产时移除这两个子进程变量，发布主 Worker 时保留原始环境和目标校验；账号与部署凭据保持原样。资产部署失败时不会继续发布主 Worker。

## 独立 Harness 环境

Agent 目录在 `/`，工作台在 `/agents/:environmentId`。EnvironmentDO 保存每套环境的配置、插件与 Session 索引，默认环境与其他环境同等处理。SessionDO / WorkspaceDO 使用新的 `harness-v1` 寻址，包含租户及环境 ID；不读取、迁移旧对象，旧底层对象尚未物理删除。部署命令仍为 `npm run deploy:workers`，Git 推送触发方式不变。

完整官方客户端接入尚在进行，官方模块构建与多环境回归结果见 [多环境验收](validation/agent-environments.md)。


## 原生动态插件运行配置

主 Worker 配置增加 `LOADER` Worker Loader binding 和 `PluginCapabilities` RPC export；不增加公开路由、应用 Token 或 Secret 复制。动态 Host 在 SessionDO 的 facet 中运行，子 Worker 只有绑定所属 session/plugin/run 的文件能力，直接网络关闭。私有 UI Worker 仍先于主 Worker 发布；`main` 推送继续使用既有 Cloudflare Git 自动构建。

原版动态 Cordis 面板提供版本审批、运行、停止与移除，刷新由独立 Weft 模块恢复已批准 Client。仅开启 `allowClientPlugins` 的会话预设装配编写工具。完整官方页面继续通过 `/agents/:environmentId?ui=official` 验证；静态 Plugins 管理器、预设、权限及其他未接通能力见 [剩余验收](architecture/agent-environments.md)。本地 workerd 通过不等于真实 Access 用户完成云端登录后验证。


## 官方默认入口与预设

`/agents/:environmentId` 默认启动原版 AppWebEntry，Agent 列表无需实验参数。`?ui=transition` 是过渡实现的显式回归入口。环境文档的 CSP 随入口选择同步，只有官方环境页面启用原版 Loader 所需的表达式执行；管理页面的策略不变。

原版预设列表、只读声明、默认设置及首轮前选择使用 EnvironmentDO / SessionDO 的真实数据。预构建组合使用原版 Loader / AgentPresetRegistry，拒绝 Node 文件加载和服务端 JavaScript 配置表达式。预设与 Todo 的冷读投影、冻结版本和中断恢复见 [多环境验收](validation/agent-environments.md)。静态 Plugins 包与配置管理、权限、文件附件和其余接口仍在继续接入。
