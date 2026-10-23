# Contributing

欢迎提交问题与 Pull Request。请说明问题的具体触发方式、期望行为、实际结果和运行模式（自动 / 仅 Worker / 始终容器），删除日志中的用户数据、Cookie、模型密钥及 Access 断言。

## 开发

需要 Node.js 22.19+、npm 与 Git。运行 `npm ci` 和 `npm run dev`；首次构建会获取固定上游源码。本地身份与状态均独立于云端，模型在界面的 Settings → Models 配置。

- 使用仓库现有模块边界和原版 Cordis / Harness API；适配写在本项目，不直接编辑 `deepseek-harness/` 或其他生成目录。
- 更新上游需明确修改 `upstream.lock.json` 并检查 ABI / Boot Graph 变化。
- 配置变化说明默认行为、缺失配置的结果与部署影响；D1 表结构变更新增顺序迁移，不覆盖已应用文件。
- 插件包使用原生 `dsh.bundle.patch` 与标准 Cordis 导出，避免引入额外作者协议。
- 新增运行能力需保持租户 / 环境边界、明确授权、可取消和重建恢复。

## 验证

推送候选提交至自己 fork 的 `ci` 分支，或提交 Pull Request；`.github/workflows/test.yml` 会执行构建、类型检查、workerd、浏览器和真实容器回归。常规验证不需要 Cloudflare 或模型凭据。`main` push 不运行测试，部署账号可选择在 Cloudflare Workers Builds 中绑定自己的 main。

修改镜像源时按发布脚本的哈希规则更新 `apps/*/image.json` 中的通用内容标签；CI 构建并测试镜像，随后从通过的运行下载镜像制品并发布。不得用未验证的镜像替换已批准版本。完整操作见 [部署指南](docs/deployment.md)。

提交说明应包含用户能观察到的变化、必要的实现取舍、验证结果和已知限制。可逆的样式或文档变更无需新增镜像实现细节的测试；行为修复应覆盖真实触发条件。

## 私有配置与许可

不要提交 `.weft/`、`.env*`（示例除外）、`.dev.vars*`、Cloudflare 凭据、私钥、用户会话或构建制品。发布前检查当前文件及 Git 历史；删除当前文件不能清除历史中的凭据，已泄露密钥应先撤销。

贡献代码按本项目 MIT 许可提供。保留第三方的版权与许可声明；引入依赖时说明用途与许可。
