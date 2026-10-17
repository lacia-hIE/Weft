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

产物和报告在 `.generated/official-remotes/` 与 `.generated/official-ui/`。Boot Graph 与静态资源生成到 `.generated/official-web-assets/`，使用官方模块排序函数及 manifest parser 验证；当前激活 67 个 Web 模块，按上游条件排除 Desktop 专用的 product-analytics 和 sidebar-browser。它们尚未挂入生产环境入口。

## 原生会话 Host 验证

新增 5 项真实 workerd 测试，覆盖官方生成契约和真实 SessionDO：

- 在首条提示词前创建真实空白 Session；只复用空白会话，已使用的会话创建新身份。
- 官方历史分页、事件连续性、assistant 帧、消息请求 ID、多个文本块、时区及重复提交去重。
- 原生标题事件与投影、运行中修改标题、非法标题拒绝，以及进程重建后的恢复。
- 延迟 DeepSeek 协议流中重连，看到真实活动 Session 与已积累 assistant 输出；关闭所有订阅后模型仍继续执行。
- 取消到达原生 Agent 并写入 `aborted/user` 终止事件；凭据缺失在确认提示词之前返回失败。
- 同名会话的环境隔离；未知接口、未接入的 workspace catalog、steer 与运行中 Inbox 排队明确报告不可用。

完整 workerd 回归共 42 项通过，严格类型检查通过；3 项现有浏览器回归通过，两个 Worker 的预构建部署检查通过。UI 资产改为私有 Worker 的 Static Assets binding，公开主 Worker 仍先验证原生 Access 身份。本地 Miniflare 需显式设置资产 router 的 `has_user_worker`，保证与生产的 Worker-first 路由一致。

当前环境入口仍是过渡工作台。原生会话 Host 是完整官方 UI 的基础，不能计为完整官方客户端接入。工作区、设置、插件配置、全局事件及 AppWebEntry 启动仍需完成；参见 [架构与剩余验收](../architecture/agent-environments.md)。
