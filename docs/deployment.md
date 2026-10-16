# Cloudflare 部署

项目使用 npm 锁定的 `cf@1.0.0-beta.17`，`cloudflare.config.ts` 声明 Worker、Secret 和 SQLite Durable Object，`wrangler.config.ts` 保留构建器设置。源码先由 Weft 的 esbuild 脚本打包，再由 cf 生成 Build Output 并发布。

Worker：`weft-kernel-validation`。自定义域名：`weft.luxuncang.com`。健康检查：https://weft.luxuncang.com/health 。源码：https://github.com/lacia-hIE/Weft 。

## 手动部署

```bash
npm ci
npm run check
cf auth login
npm run deploy
```

也可以先运行 `npm run build`，再执行 `npx cf deploy`。`cf` 本身不执行 package.json 的 build 脚本，不能在未生成 `dist/worker.js` 时直接部署。

首次部署可用 `npx cf deploy --secrets-file /path/to/secrets.json` 设置 `VALIDATION_AUTH_JSON`。文件字段是 Secret 名，值为验证租户注册表的 JSON 字符串。后续部署沿用云端 Secret，不将注册表写入 Git 或 GitHub Actions 的明文变量。

当前机器的验证凭据保存于被忽略的 `.cloudflare/validation-secrets.json`，文件权限为 `0600`。该文件不随 GitHub checkout 分发。模型仍为确定性验证适配器。

## GitHub 关联

源码保存在 GitHub，Cloudflare 的 GitHub 连接授权访问该仓库。项目不配置 GitHub Actions 或其他部署流水线，也不创建推送触发的自动部署规则。发布由开发者通过 `cf` 命令手动执行，检查在本地运行。

Cloudflare 仓库连接已确认，连接 ID 为 `8256897f-8bbb-490b-993e-8a1537f0a29a`。部署配置的 `worker.domains` 声明自定义域名，发布时由 Cloudflare 管理 DNS 和证书。

2026-10-16 的首次云端检查已验证：健康检查、两租户模型工具循环、Session 日志读取、无凭据返回 401、跨租户访问返回 403。
