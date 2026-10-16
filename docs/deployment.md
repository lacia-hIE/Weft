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

Worker 的“构建 → Git 存储库”已原生绑定 `lacia-hIE/Weft` 的 `main` 分支。构建命令为 `npm run build`，部署命令为 `npx cf deploy`，根目录为 `/`。自动构建和预览构建均关闭；项目不配置 GitHub Actions，检查与发布由开发者手动执行。

Cloudflare 仓库连接已确认，连接 ID 为 `8256897f-8bbb-490b-993e-8a1537f0a29a`。部署配置的 `worker.domains` 声明自定义域名，发布时由 Cloudflare 管理 DNS 和证书。

也可在 Cloudflare 控制台手动启动构建，或执行：

```bash
npx cf builds create 7757abed-2c84-40db-9c15-60baaef0c190 --branch main
```

Cloudflare 原生构建使用专用 `weft-native-builds` 部署凭据；凭据保存在 Cloudflare，不上传 GitHub Secret。

原生构建环境固定 Node.js `22.21.1`。2026-10-16 手动构建 `942d398c-d2e5-4039-827f-6af24d24c112` 已成功从 GitHub 获取源码、安装依赖、检出固定 Harness commit、打包并通过 `cf` 发布至自定义域名。构建结果为 `success`，部署版本为 `b1693a7c-a345-4412-ad4b-5c90c5178aa4`。

2026-10-16 的首次云端检查已验证：健康检查、两租户模型工具循环、Session 日志读取、无凭据返回 401、跨租户访问返回 403。
