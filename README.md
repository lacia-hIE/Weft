# Weft

在 Cloudflare Workers、Durable Objects 和 Containers 上运行 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，复用原版 Agent Loop、Web UI 和 Cordis 插件体系。

Weft runs DeepSeek Harness on Cloudflare with persistent sessions, isolated agent environments, Linux workspaces and native Cordis bundles. This is an independent project; upstream source is pinned and platform adaptations live here.

## 当前能力

- 每个用户可创建多个独立 Agent 环境，分别保存设置、模型凭据、插件、会话与工作区。
- 原版标准、PTC、极简与创造预设；流式回复、工具调用、排队、取消、会话搜索、文件与图片附件。
- Worker 轻量 shell，以及容器内的真实 Linux 进程、PTY、交互终端。自动模式由 Agent 在需要时切换到容器。
- 原版 Plugins 页管理全局插件；创造模式可编写双端 Cordis 插件，由用户审核精确版本后加载。
- 使用原生 `package.json.dsh.bundle.patch` 安装公开 npm 插件；隔离编译、代码及权限审核、启停、卸载与刷新恢复。部分官方组合包包含预编译适配。
- Cloudflare Access 用户身份、租户隔离、SQLite 持久会话、D1 设置与私有 R2 插件产物。

项目仍在持续适配。支持原版格式不代表可以运行所有本地 DSH 插件；Node 内置模块、原生扩展及未桥接宿主服务会明确拒绝。详见[插件安装范围](docs/validation/package-installation.md)和[官方组合包](docs/validation/official-bundles.md)。

## 本地开发

需要 Node.js **22.19+**、npm 与 Git。首次构建会下载 `upstream.lock.json` 固定的公开上游源码，无需维护者账号或生产配置。

```bash
npm ci
npm run dev
```

打开 `http://127.0.0.1:8787`，创建或选择 Agent 环境，再到 **Settings → Models** 配置自己的模型 API Key、模型与 HTTPS endpoint。应用不读取 `.env` 中的模型凭据，也不提供共享平台密钥。

本地使用模拟开发身份，仅监听回环地址；D1 迁移自动应用，数据保存在 `.cloudflare/local-state/`。本地支持 Worker shell、持久会话、设置和动态 Worker 插件；真实 Linux 容器与隔离 npm 编译服务需要云端部署。不要把开发服务器当作公共服务。

已有上游 checkout 的版本不匹配或包含修改时，准备脚本保留原目录，改用 `.generated/upstream/<commit>` 的独立固定副本。不要直接修改上游 checkout；适配放在本仓库的 `packages/`、`apps/` 和 `scripts/`。

## 部署到自己的 Cloudflare 账号

源码不包含维护者的账号、域名、Access audience、数据库 ID 或私有镜像仓库地址。部署使用两个 Worker、SQLite Durable Objects、D1、私有 R2、Worker Loader、Images，以及工作区和插件编译容器。

1. 创建自己的 Access 应用、D1 数据库和私有 R2 bucket，按[部署指南](docs/deployment.md)应用迁移。
2. 复制 `deployment.example.json` 到被 Git 忽略的 `.weft/deployment.json`，填写自己的资源配置。
3. 在 GitHub Actions 的 `ci` 分支验证两个容器，从通过的 CI 下载镜像并发布到自己的 Cloudflare 账号。
4. 运行构建后，使用 `npm run deploy:workers` 顺序发布私有 UI Worker 与主 Worker。云端自动构建使用 `WEFT_DEPLOY_CONFIG` JSON 构建变量。

完整步骤、配置字段、镜像发布和 Access 验收见[部署指南](docs/deployment.md)。未配置部署参数时仍可构建和本地开发，发布会在上传任何 Worker 前拒绝不完整配置。

## 开发与 CI

```bash
git push origin HEAD:ci
```

测试工作流在 `ci` 分支、Pull Request 和手动触发时运行；`main` 的普通 push 不触发该测试工作流。CI 检查构建、严格类型、workerd 集成、浏览器、无网络插件编译，以及真实容器进程 / PTY / Git / FUSE。模型联调测试需要显式启用并提供测试凭据，常规 CI 不调用收费模型。

本仓库的验证与发布流程以 CI 为准。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。

## 运行边界

- 同一环境的会话共享工作区；容器中的进程与 PTY 状态不会跨重启恢复，命令不会自动重放。
- 源码和 `.git` 持久保存；`node_modules`、`.venv` 和常见缓存仅保存在容器本地，替换或休眠后可能需要按锁文件重建。
- `/workspace` 同步文件单个最大 **256 MiB**；大型 Git pack 可能超限，按任务选择浅克隆或稀疏检出。扩大容器规格不会提高此上限。
- Client 插件在用户的工作台页面运行，批准它相当于信任其页面代码。Host 插件在独立 Dynamic Worker facet 中运行，通过明确授权的桥接服务访问工作区。
- 端口预览、Office 转 PDF、平台账号登录和更多本地宿主服务尚未完整适配。当前不是本地 DSH 的完全替代。

## 代码与文档

| 路径 | 用途 |
| --- | --- |
| `apps/worker` | HTTP、Access、Durable Objects 与平台服务入口 |
| `apps/web` / `apps/assets` | 入口页面、原版 Web 扩展与私有静态资源 Worker |
| `apps/workspace-container` | Linux shell、进程、PTY 与工作区同步 |
| `apps/plugin-builder` | 无网络插件编译容器 |
| `packages` | Harness 装配、持久化、模型、原版插件与平台适配 |
| `scripts` | 固定上游、生成原版 Remote / Boot Graph、构建及发布 |
| `migrations` | D1 版本迁移 |
| `tests` | workerd、浏览器与真实容器回归 |

- [多环境与官方 UI](docs/architecture/agent-environments.md)
- [真实进程与 PTY](docs/architecture/workspace-processes.md)
- [Git 项目与工作区](docs/architecture/workspace-git.md)
- [插件包安装](docs/validation/package-installation.md)
- [部署指南](docs/deployment.md)

`docs/validation/` 保存各项功能的实现和历史验收记录；当前入口和部署流程以本 README 与部署指南为准。

## 许可

项目代码采用 [MIT](LICENSE)。DeepSeek Harness、Cloudflare Computer 及其他依赖保留各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。构建产物包含第三方许可清单 `/licenses.txt`。
