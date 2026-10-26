# Releases / 版本与发布

## Version identities

| Component | Version source | Git tag | Distribution |
| --- | --- | --- | --- |
| Weft | Root `package.json` and both root entries in `package-lock.json` | `vX.Y.Z` | GitHub Release / source; deploy to your own Cloudflare account |
| Local DSH connector | `packages/local-host-connector/package.json` | `dsh-local-host-vX.Y.Z` | `@laciaproject/dsh-local-host` on npm |
| Upstream DSH | `upstream.lock.json` | No Weft tag implied | Pinned upstream source and compatibility matrix |

These versions are independent. A Weft release does not automatically publish a connector version or upgrade upstream DSH. Tags identify immutable commits: never force-push or reuse a published tag. Correct mistakes with a new version.

Use canonical `MAJOR.MINOR.PATCH`, with optional prerelease identifiers such as `0.2.0-rc.1`. While Weft is below 1.0, a minor release can change compatibility; patch releases should preserve existing interfaces. Document data resets, required migrations, image changes and any manual deployment work explicitly. Prereleases are marked on GitHub; connector prereleases use npm's `next` dist-tag.

## Release Weft

1. Update the root version and both root lockfile version entries. Add `docs/releases/vX.Y.Z.md` with English and Chinese release notes; update `CHANGELOG.md`. Describe observed behavior, upstream compatibility and upgrade requirements.
2. Push the candidate commit to `ci` and wait for **every Test job** to succeed. Builds, types, browsers, unit tests, native DSH Hosts and real container checks run in GitHub Actions. Do not use local test results as the release gate.
3. Fast-forward the exact tested commit to `main`. A squash or merge commit has a different SHA and must itself be tested on `ci` before release.
4. In Actions, run **Release Weft** on `main`, entering the exact root version and optionally its successful Test run ID:

   ```bash
   gh workflow run release.yml --ref main -f version=0.1.0 -f ci_run=SUCCESSFUL_RUN_ID
   ```

The workflow validates the repository, exact SHA, `ci` push event, Test workflow identity, all required jobs, version consistency and committed notes. A separate job with `contents: write` repeats validation, creates an annotated `vX.Y.Z` tag and publishes the release. It needs no npm or Cloudflare credentials. Existing tags must resolve to the same SHA; existing published releases are left unchanged, allowing a failed publication to be retried without moving tags.

Release source archives are provided by GitHub. They do not include private configuration, production Build Output, model credentials or container images. Build and deploy with your own resources following [the deployment guide](deployment.md). A release neither applies migrations nor guarantees production rollout; Workers Builds deployment is a separate operation.

The project release workflow works in a fork using that fork's Actions token and `ci` history. Fork owners should update README badges, repository metadata and issue links. This does not grant rights to the official npm package.

## Release the local connector

Follow [npm trusted publishing](deployment/npm-publishing.md). Keep the fixed repository, workflow and `npm-production` environment identity; do not trigger npm publishing from a tag or a pull request.

After a successful npm publication, record the connector version with an annotated tag at the **exact published source SHA**, not the latest unrelated main commit:

```bash
git fetch origin main
git tag -a dsh-local-host-vX.Y.Z PUBLISHED_SOURCE_SHA -m "Local DSH connector X.Y.Z"
git push origin refs/tags/dsh-local-host-vX.Y.Z
```

Check the npm version and publication workflow's source SHA before tagging. Connector tags are bookkeeping; they do not trigger npm publication. Avoid inventing historical tags when the published source commit cannot be established. Connector GitHub releases, if created, must use this tag namespace and must not replace the latest Weft application release.

## 中文说明

Weft、连接插件和上游 DSH 分别版本管理。项目 Tag 使用 `vX.Y.Z`；连接插件使用 `dsh-local-host-vX.Y.Z`。已发布 Tag 不移动、不复用，错误通过新版本修正。0.x 阶段的兼容变化、数据库操作和镜像要求必须写入中英文发版说明。

发布 Weft 时更新根目录版本及 lockfile，提交 `docs/releases/vX.Y.Z.md` 和更新记录；将候选提交推送到 `ci`，全部测试通过后，把**同一提交**快进到 `main`，再手动运行 **Release Weft**。工作流校验同一仓库、同一 SHA、完整测试和发版说明后创建注释 Tag 与 GitHub Release，不需要 Cloudflare 或 npm 密钥。合并或压缩产生的新提交必须重新验证。

GitHub Release 提供源码，不包含私有配置、容器镜像或可以直接上线的产物。发布版本与部署是两个独立操作；不会自动迁移数据库。连接插件继续使用现有 npm OIDC 发布流程，成功后才为实际发布的源码提交登记独立 Tag；Tag 不触发 npm 发布。
