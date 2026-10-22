# Git 项目与容器工作区

Weft 使用 `@cloudflare/computer` / computerd `0.5.1`。源码与 Git 状态保存在 WorkspaceDO；容器执行 git、Node、Python 和测试。官方 Web 同一环境内的项目目录与会话共享默认文件卷，不同用户和环境使用不同卷。

## 持久化边界

`packages/workspace/src/container-policy.ts` 定义容器启动时的 `MOUNT_IGNORE`：

- `/.weft`：继续隔离私有附件，不向容器暴露持久附件字节。
- `**/node_modules`、`**/.venv`：依赖安装保存在容器本地。
- `**/__pycache__`、`**/.pytest_cache`、`**/.mypy_cache`、`**/.ruff_cache`、`**/.next/cache`、`**/.turbo`：可重建缓存保存在容器本地。

本地目录不进入 VFS 或同步包，也不占 WorkspaceDO 的持久容量。它们只在容器中可见，Worker shell、文件工具与 Files 侧栏看不到。容器停止或替换后不保证保留，按锁文件重新安装依赖；依赖检查、构建和测试应继续在容器中运行。

源码、`.git`、锁文件、未提交修改和普通输出目录继续持久化。没有笼统排除 `dist`、`target` 或所有隐藏目录：仓库可能跟踪这些路径，交付文件也可能位于其中。不要把用户编写的文件放进本地依赖/缓存目录。`.gitignore` 只影响 Git，不控制 computerd 同步。

该策略没有删除旧的持久文件。升级前已同步到 DO 的依赖与缓存仍占原存储，在容器中会被本地目录遮住，不会自动迁入本地副本；首次使用需要重新安装。通过 Worker 文件接口写入这些路径也不会创建容器使用的依赖。不要依靠文件工具检查本地安装是否存在。

上游机制与限制：[对应版本的 Local-only paths](https://github.com/cloudflare/computer/blob/ef00c0a790cb87887bf209fa87838cb1a281220b/packages/computerd/README.md#local-only-paths-mount_ignore)。本地路径仍经过 FUSE 调用，但绕开持久 VFS 和同步成本。

## 克隆策略

任务只需要当前代码时，可浅克隆一个分支：

```bash
git clone --depth 1 --single-branch --no-tags <url> /workspace/project
```

大型 monorepo 可在服务端支持部分克隆时，只检出需要的目录：

```bash
git clone --depth 1 --filter=blob:none --sparse <url> /workspace/project
git -C /workspace/project sparse-checkout set apps/web packages/core
```

这些选项减少历史和检出范围，不能保证每个 pack 都小于 256 MiB。需要完整历史时不要擅自改成浅克隆。已有失败目录不要自动删除或覆盖，先检查是否有用户文件或未推送提交。

当前 FUSE 对同步文件有 **256 MiB 单文件硬限制**，大 pack 即使只包含很多小源文件也会触发 `EFBIG` / `File too large`。命令失败时，Weft 在保留原 stderr 和退出码的同时追加容量解释与克隆建议；它不自动重试、删目录、移动 `.git` 或更改历史。该提示只作用于实际容器执行，成功命令和其他错误保持原样。

增大容器规格、设置 `COMPUTERD_DB` 或客户端 `pack.packSizeLimit` 都不能解除收到大 pack 时的限制。限制来源：[固定版本 FUSE driver](https://github.com/cloudflare/computer/blob/ef00c0a790cb87887bf209fa87838cb1a281220b/packages/computerd/src/fuse/driver.ts#L31)。

## 大型 Git 历史

本轮保留 `.git` 的持久化。把它移到 `/var/tmp` 或加入 `MOUNT_IGNORE` 可以避开同步文件限制，但当前 Weft 没有为容器本地 Git 数据实现快照恢复：未推送提交、分支和暂存状态会丢失。这不能作为默认策略。

需要支持完整大型仓库时，应先建立 Git 数据的备份恢复或大文件存储机制，再调整 `.git` 的存储路径。切勿用提高 FUSE 常量代替内存与恢复设计。

## 验证

普通测试：`npx tsx --test tests/workspace-container.test.ts`，检查流式输出、跨数据块错误识别、退出码保留及成功/其他错误不追加提示。

真实容器：`npm run test:workspace:container`。需要 Docker、`/dev/fuse`、FUSE 挂载权限，以及 `apps/workspace-container/image.json` 中的镜像；可用 `WEFT_CONTAINER_IMAGE` 指定本地同版本镜像。测试使用独立临时容器，结束后移除，验证：

1. 全部依赖/缓存规则写入本地目录，数据库保存源码和 `.git`，不保存缓存标记。
2. 同步文件超过 256 MiB 被拒绝，同样大小的本地依赖文件可创建。
3. 含三个历史二进制版本的完整克隆因大 pack 失败，浅克隆当前小版本成功且 Git 状态正常。

真实容器测试默认不随 workerd 单元测试运行；没有 Docker 时的跳过不算容器验证通过。

2026-10-22 本地验证：完整官方构建和严格 TypeScript 检查通过；相关回归 12 项通过（shell、持久终端、spill、变更记录、运行环境策略及输出诊断），真实 Docker/computerd/FUSE 专项另有 1 项通过；工作区运行环境页面浏览器回归 1 项通过。普通回归中的容器用例按设计跳过，真实容器证据来自独立启用该用例的运行。本次没有部署，也未替代云端完整回归。
