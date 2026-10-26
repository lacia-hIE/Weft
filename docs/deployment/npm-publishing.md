# 本地连接插件发布到 npm

包名为 `@laciaproject/dsh-local-host`，公开发布到 npmjs。首次发布使用维护者的本机 npm 网页登录；后续由 GitHub 官方托管 Runner 使用 OIDC 可信发布，不向 GitHub 保存 npm Token。

## 固定的发布身份

| npm Trusted Publisher 字段 | 固定值 |
| --- | --- |
| Organization or user | `lacia-hIE` |
| Repository | `Weft` |
| Workflow filename | `publish-local-host.yml`（只填文件名） |
| Environment name | `npm-production` |
| Allowed actions | 允许 `npm publish` |

GitHub 的 `npm-production` Environment 仅放行 **main 分支**，不放行 tag；工作流也检查仓库与 ref。`id-token: write` 只授予发布 job。准备 job 只有代码及 Actions 读取权限。npm 会核对这组 OIDC 声明；仅在 YAML 写一个 environment 名称不会自动完成 npm 侧绑定。

工作流手动启动，不监听 PR 或任意版本 tag。准备阶段要求同一提交在 `ci` 分支完成 Test 工作流，所有 job 成功且包含两个受支持 DSH 的原生 Host 验证。随后下载该次 CI 的 build artifact，取出实际安装测试过的 `.tgz`，校验包名、版本、文件清单、原版 patch、客户端模块身份和源码，附带 SHA-256 再交给独立的发布 job。发布 job 不安装项目依赖、不重新构建包，以原 tarball 发布并生成 provenance。

## 首次发布与 npm 侧绑定

npm 当前要求配置可信发布的包已经存在，且维护者拥有包写权限并启用 2FA。参考 [npm trust 官方说明](https://docs.npmjs.com/cli/v11/commands/npm-trust/) 和 [可信发布说明](https://docs.npmjs.com/trusted-publishers/)。

1. 在 `ci` 验证发布提交，成功后将同一提交合并到 `main`。
2. 下载该次 CI 的 build artifact，取出 `dist/public/downloads/weft-dsh-local-host-<version>.tgz`。不要直接发布 `packages/local-host-connector` 源码目录，其中没有编译好的 `client.js`。
3. 在本机使用 `npm login --auth-type=web --registry=https://registry.npmjs.org/` 登录具有 `laciaproject` 发布权限的账号。
4. 使用上一步的 tarball 做一次首次发布：

   ```sh
   npm publish /absolute/path/weft-dsh-local-host-0.2.0.tgz --access public --registry=https://registry.npmjs.org/ --ignore-scripts
   ```

5. 在 npm 包设置页配置上表的 Trusted Publisher，勾选允许直接 `npm publish`。也可使用支持 `npm trust` 的 CLI（当前流程固定为 `11.21.1`）：

   ```sh
   npm exec --yes --package=npm@11.21.1 -- npm trust github @laciaproject/dsh-local-host \
     --repo=lacia-hIE/Weft \
     --file=publish-local-host.yml \
     --env=npm-production \
     --allow-publish --yes
   ```

   根据 npm 提示在网页完成 2FA。不要在 GitHub 配置 `NPM_TOKEN` / `NODE_AUTH_TOKEN`。

首次本机发布没有 GitHub provenance；后续 OIDC 发布会附带 provenance。新建信任关系应按 npm 当时的有效期要求及时完成首个 OIDC 发布；不可用已经发布的相同版本号重试。若首次发布后暂时不发布新版本，可等下个版本准备好时再创建绑定。

## 后续版本

1. 修改插件 `package.json` 的版本；兼容范围改变时同步 CI 的 DSH 矩阵。插件文档中的安装版本也应更新。
2. 提交到 `ci`，等待 Test 工作流全通过，再把相同提交合并到 `main`。
3. GitHub Actions → **Publish local Host connector** → **Run workflow**，分支选 `main`，version 填包中的精确版本。`ci_run` 可以留空；有多个 CI 重跑时可填明确的成功 run ID。
4. 工作流复用 CI 包发布；正式版本使用 `latest`，预发布版本使用 `next`。

CI build artifact 默认只保留一天，过期需在同一 `ci` 提交重新运行 Test。已存在的 npm 版本不能覆盖，不会自动递增版本或忽略发布失败。

源码开源 fork 若需要自行发布，需同时修改包名、repository 元数据、工作流和脚本中的固定仓库，并在自己的 npm 包上重新绑定可信发布。原仓库的 npm 信任不授予 fork。
