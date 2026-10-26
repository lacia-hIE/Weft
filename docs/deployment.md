# 部署到 Cloudflare

本文面向独立部署者。使用仓库锁定的 `cf`、Node.js 22.19+ 与 npm；命令通过 `npx cf` 调用已安装版本。Cloudflare 账号需具备项目使用的 Workers、SQLite Durable Objects、D1、R2、Worker Loader、Images、Workers AI 和 Containers 能力。`AI` binding 专用于文档转 Markdown，不替代用户的模型提供商配置。认证通过 Cloudflare Access 配置，模型凭据由用户在每个环境的 Settings → Models 保存。

## Deploy to Cloudflare

Cloudflare 提供官方 [Deploy to Cloudflare 按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)，可复制公开 Git 仓库、收集配置并自动创建受支持的绑定资源。官方文档明确列出多 Worker 项目限制：多个应用不能通过同一按钮一起部署。

**当前 Weft 尚不支持完整的一键初始化。** 本项目使用 `cf` 生成 Build Output 和自定义发布脚本，依次部署私有 UI Worker 与主 Worker；根 Wrangler 配置不直接列出全部资源。Access 应用及策略由部署者创建，两份容器镜像须经过 CI 验证并发布到自己的账号。官方按钮本身不会完成这些步骤，因此 README 暂不提供会误导用户的一键部署按钮。

首次部署请按下文准备资源。完成后，使用第 6 节的 Workers Builds 配置即可自动部署后续更新。未来接入一键初始化时，需要先提供可重复执行的资源初始化流程，安全收集 Access / 域名配置、发布已验证镜像，并协调两个 Worker；所有私有值仍保留在部署者自己的账号中。

Cloudflare offers a deployment button, but Weft's complete setup is not supported yet: two Workers, separately managed Access policy and verified private container images require additional initialization. Follow this guide for the first deployment, then enable Workers Builds for automatic updates. The repository currently does not advertise a working one-click deployment button.

## 1. 准备账号、域名和 Access

安装依赖并登录自己的账号：

```bash
npm ci
npx cf auth login
```

选择已接入自己 Cloudflare 账号的域名，例如 `weft.example.com`。在 Zero Trust 中创建保护**完整域名**的 Access 应用，配置允许的用户 / 组织策略，记录应用的 AUD 与组织域名（`your-team.cloudflareaccess.com`）。Access 应用和策略由部署者管理，Worker 配置不会替你创建。

请求路径为：浏览器 → 自定义域名与 Access → 主 Worker → 私有 UI Worker / 所属环境 Durable Objects。两个 Worker 均关闭 workers.dev 和预览 URL；UI Worker 仅接受 Service Binding 调用。

主 Worker 优先使用运行时 `ctx.access`；缺少上下文时校验 Access 请求断言或登录 Cookie 的 RS256 签名、issuer、audience 与有效期。客户端邮箱头、应用 Bearer Token 或服务凭据不会成为人类用户身份。`access.dev` 仅用于本地模拟，不能授予云端访问权限。

## 2. 创建数据资源

```bash
npx cf d1 create --name weft-config
npx cf d1 migrations apply YOUR_DATABASE_UUID --dir migrations
npx cf r2 buckets create --name weft-plugin-artifacts
```

记录数据库 UUID；按所选资源名修改私有配置。R2 bucket 用于插件不可变产物，保持私有，不开启公开访问。

更新已有部署时应用所有尚未执行的迁移，不能只执行历史文档中的某几个文件。会话与文件卷存于各自 Durable Object 的 SQLite，环境设置、预设版本、工作区登记与模型凭据存于对应 EnvironmentDO。D1 当前只保存平台环境目录与租户归属。`harness-v2` 是一次明确的数据重置，不导入旧对象或浏览器缓存；旧 D1 环境内部表由 `0007` 删除。升级已有部署应先发布 v2 Worker，再执行这项清理，避免旧 Worker 访问已删除的表；这次更新无需兼容旧数据。更换对象地址不会物理删除旧 DO，旧资源清理与恢复边界见[环境数据归属](architecture/environment-storage.md)。

## 3. 私有部署配置

```bash
mkdir -p .weft
cp deployment.example.json .weft/deployment.json
```

替换模板中的占位值。`.weft/` 已被 Git 忽略，不要提交这个文件。配置分为：

| 字段 | 含义 |
| --- | --- |
| `workerName`, `uiWorkerName` | 主 Worker 与私有资产 Worker 的不同名称 |
| `domain` | Access 保护的完整域名，不带协议或路径 |
| `accessAudience` | Access 应用 AUD，64 位十六进制 |
| `accessTeamDomain` | Access 组织域名，不带 `https://` |
| `databaseName`, `databaseId` | 自己的 D1 名称与 UUID |
| `artifactBucketName` | 私有插件产物 R2 bucket 名称 |
| `workspaceContainerPrefix` | 各规格工作区容器应用的名称前缀 |
| `pluginBuilderName` | 插件编译容器应用名称 |
| `workspaceImage`, `pluginBuilderImage` | 在自己的账号中发布的确切镜像地址，见下一节 |

尚未发布镜像时，先从本地文件删除两个镜像字段；发布脚本会在每次成功推送后补回对应地址。不要保留 `REPLACE_WITH_...` 占位符，否则配置校验会拒绝读取。

也可通过环境变量 `WEFT_DEPLOY_CONFIG` 提供**完整 JSON**。该变量优先于本地文件，按整份配置替换，不做隐式合并。默认值仅供开发和 CI：无生产域名、无 Access 应用、无云端数据库 ID，镜像仅有通用标签。`deploy:workers`（包括 dry-run）会先检查生产必填字段和镜像版本，再上传任何 Worker。

Cloudflare 登录凭据 / API Token 由 CLI 或构建平台管理，不属于上述 JSON。模型 API Key 不应放入构建变量或应用环境变量。

## 4. 在 CI 验证并发布镜像

源码中的 `apps/workspace-container/image.json` 和 `apps/plugin-builder/image.json` 只保存内容哈希标签，不包含任何账号信息。工作区镜像的 computerd 版本必须与 Worker 中的 `@cloudflare/computer` 一致。

```bash
git push origin HEAD:ci
```

等待 Test 工作流全部通过。它会构建、测试并导出两份镜像制品：`workspace-container-image` 与 `plugin-builder-image`，保留一天。选择**对应当前待发布提交**且通过所有检查的运行，下载到本地忽略目录：

```bash
gh run download RUN_ID --name workspace-container-image --dir .generated/release-images
gh run download RUN_ID --name plugin-builder-image --dir .generated/release-images
docker load --input .generated/release-images/workspace-container-image.tar.gz
docker load --input .generated/release-images/plugin-builder-image.tar.gz
node scripts/workspace-container.mjs --publish
node scripts/plugin-builder.mjs --publish
```

发布仅使用已下载的镜像，不隐式本地构建。`cf containers push` 使用当前登录的 Cloudflare 账号，返回的镜像地址写入 `.weft/deployment.json`。确认账号正确；如果使用 `WEFT_DEPLOY_CONFIG`，需把新镜像地址同步到该 JSON，环境变量仍优先。

修改镜像源时须按脚本的哈希规则更新通用标签，并重新在 CI 验证；仅改镜像地址或复用旧标签会被拒绝。镜像以 `registry.cloudflare.com/<your-account>/weft-…:<source-hash>` 引用，不能直接使用维护者或其他私有账号的地址。

## 5. 构建和部署

配置、迁移和两份镜像就绪后，在有完整私有部署配置的构建环境执行：

```bash
npm run build
npm run deploy:workers -- --dry-run
npm run deploy:workers
```

`npm run build` 生成包含当前部署配置的标准 Cloudflare Build Output；`deploy:workers` 不会重新构建。**如果配置发生变化，必须重新构建**，不要发布由 CI 开发默认值产生的 Build Output。资产 Worker 先部署，成功后才部署主 Worker。

工作区部署三个可选规格的容器应用；插件编译器使用单独容器。应用有实例上限，工作区空闲 10 分钟后休眠。进程 / PTY 随容器重启结束；源码和 `.git` 持久保存，本地依赖缓存不保证保留。具体行为见[工作区进程](architecture/workspace-processes.md)和[Git / 文件边界](architecture/workspace-git.md)。

## 6. 自动部署

在自己的 Cloudflare Workers Builds 中绑定自己的 Git 仓库与 `main`，配置：

- 构建命令：`npm run build`。
- 部署命令：`npm run deploy:workers`。
- 构建变量：`WEFT_DEPLOY_CONFIG`，值为完整私有 JSON（包含已验证镜像地址）。
- 生产只监听 `main`；保持预览构建关闭。

GitHub Actions 负责候选提交验证；Cloudflare Workers Builds 负责所选生产分支部署。仓库内没有公共部署凭据。仅在自己的 CI 全部通过、数据迁移及镜像发布完成后，将候选提交合并到 main。

发布脚本为资产 Worker 移除 Workers Builds 的主 Worker 目标校验变量，为主 Worker 保留原值；其余账号与凭据保持构建平台配置。

## 验收与排查

匿名访问自定义域名应进入 Access 登录；允许用户登录后检查 `/health`、`/v1/me`、Agent 环境、Models 设置、会话持久化、容器终端与插件审批。健康检查同样受 Access 保护。

配置缺失 / 格式无效会在构建或部署前给出字段名，不打印字段值。模块资源 401 先检查 Access 域名、AUD、组织域名和 Cookie；模块 404 再检查私有资产 Worker 及 Service Binding。容器不可用则检查当前镜像已发布到正确账号，以及对应应用部署是否成功。

日志不应包含断言、Cookie 或模型密钥；对外分享前仍需移除用户数据与私有资源信息。开源前还要单独审查 Git 历史和已有构建制品，忽略规则不能删除过去的提交内容。
