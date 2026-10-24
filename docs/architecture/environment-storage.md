# 环境数据归属与重置

环境是完整 Harness 的持久化边界。平台负责身份、环境目录、访问控制与资源归属；环境负责自己的插件、配置、预设、工作区和会话。D1 不保存环境内部配置的副本。

## 存储边界

| 所有者 | 数据与介质 |
| --- | --- |
| TenantDO / 平台目录 | D1 `environments`：环境 ID、显示名称、时间和租户归属；预留用户、成员关系、配额等平台模型 |
| EnvironmentDO | SQLite：设置与修订号、预设发布版本、工作区记录与排序、归档和置顶、会话归属与索引、凭据、插件安装和审批 |
| SessionDO | SQLite：唯一会话日志、Inbox、投影、冻结的预设与调度任务；调度继续使用原版 StorageDomain |
| WorkspaceDO | Computer 文件卷、附件、执行任务和文档转换缓存 |
| 私有 R2 | 插件包不可变编译产物；是否安装、启用或获批仍以环境记录为准 |

平台用户目前来自 Cloudflare Access，并未新增一套 D1 用户系统。平台目录的环境存在性检查仍可能经过 TenantDO 和 D1；环境内部不需要等待 D1。会话与文件本身的跨 DO 调用仍然存在。

## 环境内的适配

`packages/environment-storage` 接收所属 DO 的 storage，不接收 D1、tenantId 或 environmentId。隔离在 DO 寻址和入口 scope 检查中完成，数据库内无需再重复租户键。`HarnessEnvironment` 不提供 `CONFIG_DB`，平台的 `TenantEnvironment` 才声明该绑定。

- 设置读取直接查询本地权威记录；修改经过共享写入队列，在 SQLite 事务内取得当前修订号并执行上层的 Config 校验和冲突检测。
- 预设版本只追加，重复 `(agent_id, revision)` 被拒绝；按需查询单个版本或当前版本，不在每次激活时加载全部历史。已有会话使用 SessionDO 内冻结的配置。
- 工作区登记、排序、置顶和归档由原版 WorkspaceRegistry / WorkspaceCommands 管理，使用原版 StorageDomain 与恢复标记。工作区源数据留在环境 SQLite；原版 Feed 提供基线与增量。
- 插件通过原有设置与管理协议读写配置，继续复用通用注册目录和 Loader 生命周期协调。平台适配只负责持久化，不额外解释插件开关。

环境已接入真实的原版 SettingsForms 和 WorkspaceRegistry。设置表单的字段编辑、路径操作、继承投影、脱敏与冲突检测由 SettingsForms 执行；Weft 提供 ConfigEditor 的本地持久化实现和稳定修订号。工作区的 Registry、Commands、Feed 保留原版实现，仅将文件操作转到所属 Computer 卷。详见[原版环境服务](native-environment-services.md)。

## 全新布局，无兼容读取

本轮明确允许清理旧数据。`DATA_LAYOUT_VERSION = harness-v2` 同时用于 TenantDO、EnvironmentDO、SessionDO、WorkspaceDO 和浏览器持久化地址。旧会话、文件卷、凭据、配置、安装记录和缓存不导入，不双写，不在读取失败时回退到旧布局。D1 的平台环境目录保留，同一个环境 ID 会连接新的空环境并初始化官方预设。

`0007_environment_owned_state.sql` 删除 D1 的 `environment_settings`、`agent_revisions`、`workspace_state`、`workspaces`。全新部署执行全部迁移；已有部署先发布 v2，再执行删除旧表的迁移。完成后，D1 的业务表只有 `environments`。

改变地址只是停止采用旧 DO，不等于物理删除旧 SQLite 对象、R2 产物或终止旧容器。当前提交不提供跨版本恢复，也不自动删除共享基础设施。旧对象的物理清理应在确认不再有旧请求或任务后，按旧对象身份单独执行；不能直接删除仍被 v2 使用的 DO namespace 或 R2 bucket。回退旧 Worker 也不能恢复已删除的 D1 配置表。

## 验证与延迟

CI 的环境存储 fixture 运行真实应用，但在构造 EnvironmentDO 前移除 D1 binding。它验证设置并发冲突、插件开关、环境隔离、凭据与工作区会话归属在 workerd 重启后恢复，以及默认预设升级和用户发布版本保留。SQL 故障注入验证整份配置文档和修订号回滚、同一文件版本可重试、原版工作区创建失败恢复，以及重复预设版本不可覆盖。

完整原版界面测试继续覆盖文件侧栏、终端、Git、插件启停和刷新恢复。所有构建、类型检查和运行测试都在 `ci` 分支的 GitHub Actions 执行。

延迟改善来自消除环境冷启动的 D1 加载、设置写入和工作区关联的远程数据库调用。此前已有内存读取缓存，所以不能把每次界面读取都算作一次节省；会话列表使用可重建的本地摘要，配置快照按修订号复用；CI 记录冷/热列表、设置读取和提示词入队耗时，以及已完成会话列表的源 RPC 次数。CI 数字是模拟环境的基线，不是生产网络延迟的定量对比。
