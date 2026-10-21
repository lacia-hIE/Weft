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

## 工作区容器

`container-shell` 后端的镜像在 `apps/workspace-container/Dockerfile`。修改 Dockerfile 或升级 `@cloudflare/computer` 后运行 `node scripts/workspace-container.mjs`：它构建镜像、用 `cf containers push` 推送到账号的 Cloudflare 镜像仓库，并把镜像地址写进 `apps/workspace-container/image.json`（需提交）。构建会校验该地址与当前 Dockerfile 一致，未推送的修改会让构建失败。部署时 Cloudflare 按这个地址创建由 Durable Object 调度的 Container 应用 `weft-workspace-shell`；容器按运行时长计费，空闲 10 分钟后休眠。

## 配置数据库（D1）

环境设置等非密钥配置保存在 D1 数据库 `weft-config`，主 Worker 以 `CONFIG_DB` 绑定（见 `cloudflare.config.ts`）；凭据仍保存在各环境的 EnvironmentDO。表结构由 `migrations/` 下的迁移文件定义，部署新版本前先应用迁移：

```bash
cf d1 create weft-config          # 首次部署：创建数据库，记下返回的 database id
cf d1 migrations apply <database-id> --dir migrations
```

生产数据库 `weft-config` 已创建（id `e0b7a68b-1af9-467e-986e-c2171c8f2dac`，写入 `cloudflare.config.ts`），2026-10-20 应用了 `0001` 至 `0005` 迁移。`cf d1 migrations apply` 记录已应用的迁移，只执行新增文件；新增迁移需在推送前应用。本地测试由 miniflare 提供同名数据库，测试辅助代码在启动时应用同一组迁移文件。

## Access 用户登录

直接打开 https://weft.luxuncang.com/ ，通过 Cloudflare Access 的邮箱验证码登录。登录后 `/` 进入 Web UI，`/v1/me` 返回当前用户及个人 `tenantId`；Session API 使用浏览器登录会话，无需手工配置 Bearer Token。`/health` 也需要登录。

- Access 组织：`aigraph.cloudflareaccess.com`。
- 应用：`Weft`，ID `c087ebda-0e03-4204-bc71-a99f2be49a6c`，保护完整域名 `weft.luxuncang.com`。
- 引用已有可复用策略 `luxuncang`，ID `794a6757-ac89-4f8b-8e6a-6d68bef91490`，允许 `@luxuncang.com` 邮箱；未额外允许 QQ 邮箱。
- 应用 audience 固定在 `cloudflare.config.ts`；重新创建 Access 应用时必须更新并重新部署。
- `workers.dev` 和 preview URL 显式关闭。即使出现其他入口，缺少可信 Access 身份或 audience 不匹配的请求也会被 Worker 拒绝。
- 使用域名级 Access 应用，便于后续接入 WebSocket；当前未启用不支持 WebSocket 的 Worker 级 Access 规则。

生产请求链路为 `浏览器 → 域名级 Access 应用 → weft-kernel-validation → UI Service Binding → weft-ui-assets / Static Assets`。业务 API 由主 Worker 路由至所属环境的 Durable Objects。Access 应用的域名、destinations 和策略配置在 Zero Trust 中；`cloudflare.config.ts` 的 `worker.domains` 声明 Worker 自定义域名，`access.dev` 仅模拟本地身份，不负责创建生产 Access 应用。

Worker 优先使用 Cloudflare 官方提供的 [`ctx.access`](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) 读取认证身份。上下文缺失时，验证 `Cf-Access-Jwt-Assertion` 或 `CF_Authorization` 登录 Cookie 的 RS256 签名、组织 issuer、应用 audience 和有效期；公钥只从配置组织的 Access 证书端点获取。不接受未验证的断言、客户端邮箱头或应用 Bearer Token。只有包含邮箱和稳定用户 ID 的人类用户身份可以访问，Service Token 不提供用户入口。写请求要求 JSON，拒绝跨 Origin 或 `Sec-Fetch-Site: cross-site` 请求。

静态资源通过 Access 校验后从私有资产 Worker 返回，不对每个并发模块请求重复读取用户资料。静态资产不包含租户数据；`/v1/me`、会话和其他业务接口继续要求完整用户身份。无可验证身份、audience 不匹配或用户身份不完整分别返回稳定的鉴权错误码；身份服务或验证公钥获取异常返回 503。不存在的 `/assets/` 路径在通过 Access 校验后返回 404。独立启动模块捕获应用模块图加载失败，显示重试入口，避免页面永久停在加载提示。

2026-10-19 的资源加载排查确认 Access 应用的域名和 destinations 均为 `weft.luxuncang.com`，策略引用也匹配。原先的随机模块 401 来自主 Worker 的 `ACCESS_CONTEXT_MISSING`，不能据此判断为资源不存在或 Access 未绑定域名。版本 `3bbb92f` 已增加签名断言验证；线上日志已观察到原先失败模块及原生 API 的 `weft.access.assertion.accepted`。这验证了实际请求的鉴权路径，完整登录后界面操作仍需单独验收。

个人租户 ID 为 `user-` 加 SHA-256(JSON([Access 组织域名, 用户 ID]))。不同用户即使使用同一个 Session 名也对应不同的 Durable Object。邮箱变更不改变同一用户 ID 的租户；在 Access 中删除并重建用户可能产生新用户 ID，历史租户迁移需显式处理。原 alpha / beta 验证 Session 不映射给真实用户。

本地 `npm run dev` 使用 `access.dev` 的模拟身份；该设置不参与生产认证。原应用 `VALIDATION_AUTH_JSON` 注册表已停用并从部署中移除。模型由用户在各环境的 Settings → Models 中配置，本地与生产均不读取 `.env` 或 Worker 模型 Secret。

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

进入环境后，打开官方 **Settings → Models**，保存 API Key、模型和需要时的 HTTPS endpoint。凭据按环境保存在 Durable Object SQLite 中，设置接口只返回配置状态，不回读密钥；每个用户、每套环境单独配置。更改在下一次模型调用前生效，已经开始的请求保留一致的配置快照。

Worker 不再读取 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL`、`TENANT_MODEL_CONFIG_JSON` 或模型期限环境变量。平台没有共享密钥回退；删除用户密钥即使在热 Agent 中也会阻止下一次调用。新环境可以先进入设置、查看历史和模型目录；发送消息前未配置凭据则返回原生 `session/provider-credentials-unavailable`，提示用户前往 Models。

官方 API 地址和 `deepseek-flash` 是可编辑设置的初始值，不是部署变量。流空闲期限默认 60 秒，对应环境设置中的 `llm-deepseek.streamIdleTimeoutMs`；原版 Models 卡片未提供该字段的专门控件。整个回合期限由宿主固定为 180 秒。当前自动模型重试默认关闭。自定义 endpoint 必须使用 HTTPS，并通过原版配置校验。

生产构建会删除验证专用的 scripted adapter 与短期限开关。`dist/test-worker.js` 只供本地测试，部署产物始终是 `dist/worker.js`。真实模型浏览器测试将测试凭据通过实际设置 API 写入对应环境，并运行生产 Worker，不以 Worker Secret 配置模型。这些验证仍不替代允许用户的云端 Access 登录后验收。

## Workspace 部署

新增 `WORKSPACES` 绑定与 `WorkspaceDO` SQLite export；`cf deploy` 管理对应生命周期声明。现有 SessionDO 命名和存储保留。工作区使用 `@cloudflare/computer@0.5.1`；bash 与 Terminal 使用 Computer Worker Shell，经 `LOADER` 绑定在 Dynamic Worker 中执行，无 Container；无需平台模型 Secret。文件 API、Session 绑定及验证细节见 [Workspace 记录](validation/workspace.md)。

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

### Access 与 UI 资源入口

请求路径为自定义域名 `weft.luxuncang.com` → Access 应用 → `weft-kernel-validation` → UI Service Binding → 私有 `weft-ui-assets` → Static Assets。Access 应用的 `domain` 和 public destination 均为 `weft.luxuncang.com`，使用指定策略 `794a6757-ac89-4f8b-8e6a-6d68bef91490`。私有资产 Worker 不直接对用户提供公网入口。

线上日志曾确认，同一次页面加载的部分模块请求没有原生 `ctx.access`，主 Worker 因而返回 `ACCESS_CONTEXT_MISSING`；资源本身存在且可从私有资产服务读取。入口现在优先使用原生上下文，缺失时按照 [Cloudflare 的断言验证方式](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)校验 Access 的请求断言或登录 Cookie。`jose` 在 workerd 中使用 Web Crypto 验证 RS256，仅从配置组织的 `/cdn-cgi/access/certs` 获取公钥，不信任断言中提供的密钥地址；还必须匹配 issuer、audience、有效期和用户声明。原生 audience 不匹配时直接拒绝，不允许断言覆盖。验证公钥临时不可用返回 503，匿名、无效及服务凭据继续被拒绝；此路径没有新增应用 Token 登录。

主 Worker 开启持久化诊断日志，记录 Access 拒绝码、验证服务故障、断言验证成功路径和资产错误状态。日志不记录断言、Cookie 或模型密钥，关闭默认调用日志并移除 URL 查询字符串。浏览器启动失败时可展开“查看错误详情”，查看原始模块错误及失败资源状态。

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
