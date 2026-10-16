# Harness 多环境验收

2026-10-17 本地验证，固定上游 `86a402200d95fecef4529d969836f1fe13c6cb0d`。

## 数据与运行

37 项真实 workerd 回归通过，其中新增多环境测试验证：

- 同一用户的两个环境可以使用同名 Session、Workspace、预设和插件，数据互不覆盖。
- 不同用户的同名环境隔离；不存在的环境返回 404，跨用户访问返回 403。
- 配置发布和插件启用只改变所属环境；另一环境无法获取该模块版本。
- 文件和会话在 workerd 重建后恢复，旧租户数据能从默认环境入口读取。
- 两个环境可选择不同模型，模型密钥仍由服务端提供；发布新模型版本后，旧会话保持原版本，新会话使用新版本。

严格类型检查通过，两个生产 Worker 的预构建部署检查通过。环境控制状态增加 EnvironmentDO SQLite export；SessionDO 和 WorkspaceDO 保留现有绑定，通过地址加入环境 ID 隔离。

## 页面与真实模型

3 项浏览器回归通过：管理目录创建环境并进入、切换页面后插件卸载、既有聊天/历史/文件 CAS、原生 Store/Config/Markdown/DockKit、安全模式、移动端与深色模式。

真实 DeepSeek 流程在新建的独立环境中通过：从 Web 发消息，模型写 TSX 并发布，用户启用插件，点击计数器后刷新恢复。该验证使用本地 workerd 的原生 Access 模拟，不等于云端用户完成邮箱验证码登录的验收。

## 完整官方 UI 的构建验证

官方生成器已生成 30 个包的 Remote ABI；上游源 checkout 未修改。官方 Web 构建目录中的 69 个浏览器模块已全部使用各自的原始 tsdown 配置构建成功，包含模块表工厂、CSS 生命周期、动态分块及文档预览构建。目录包含条件启用的模块，实际 Boot Graph 仍需遵循 Web profile 的激活条件。

```bash
npm run build:official-ui
```

产物和报告在 `.generated/official-remotes/` 与 `.generated/official-ui/`，不会作为已接入的生产 UI 发布。当前环境入口仍是过渡工作台；完整官方 UI 的 Host 接口、流和启动链路尚未接通，目标仍未完成。参见 [架构与剩余验收](../architecture/agent-environments.md)。
