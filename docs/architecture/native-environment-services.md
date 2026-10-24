# 原版环境服务、原子配置与摘要索引

## 原版业务和平台端口

`NativeWorkspaces` 装配原版 `WorkspaceRegistry`、`WorkspaceCommands`、`WorkspaceFeed`。登记、成员校验、排序、重命名、删除登记、归档、置顶与增量帧使用原版实现。原版 StorageDomain 通过已有 DurableStorageBackend 写入环境 SQLite，不为这些业务再维护一套 Weft 状态机。

原版 Workspace 包的 `node:fs/promises` 导入在构建时替换为 `workspace-fs.ts`。每次调用用 AsyncLocalStorage 绑定当前环境的 Computer RPC；同一次操作内重复 stat 合并，下一次操作重新验证。VFS 的路径边界与拒绝 symlink 的规则继续有效。会话持久化复用真实只读 EnvironmentSessionPersistence，访问实际源头和日志 cut，不创建 Agent 或取得 writer。单个未知会话头改用原版 persistence 的 `stat(id)` 点读，避免每次关联新会话都重新读取整个环境的头列表；冷启动的完整成员校验仍保留。

首次打开原版 Registry 时，同一 `harness-v2` 环境中的旧 SQLite 登记会在本地事务中导入原版域，保留 ID、名称、会话归属和顺序。导入成功才删除旧本地表。此过程不读旧 D1 或旧对象布局，也不改变文件卷地址。本轮不再重置环境数据。

`EnvironmentSettings` 创建真实 Loader 条目，条目使用各插件的原生 Config schema，只承担环境配置，不执行工具或创建 Agent。这些条目不作为另一份运行插件清单展示。原版 SettingsForms 负责字段和路径编辑、数组与继承语义、JSON 输入校验、表单投影、脱敏及冲突检查。

平台的 ConfigEditor 端口将原版编辑回调连接到本地共享写入队列、schema 校验和 Loader 更新。原版 SettingsForms 只有两类平台适配：修订号从环境 SQLite 读取，移除本地旧 `settings.yaml` 导入依赖。构建对这些源码边界作明确检查；上游 checkout 不被修改。

## 整份配置提交

YAML 先解析和验证，再在同一同步 SQLite 事务里更新全部命名空间及其修订号，记录已成功应用的文件版本，并推进配置总修订号。异常使事务整体回滚；不提前广播设置或插件变更。

配置文件版本只在成功后记录。发生存储故障时，同一个文件版本在下一次读取时仍可重试。派生配置缓存无论提交或回滚都会失效，避免未提交值留在内存中。原有 write-only 凭据和 YAML 的秘密字段保留规则继续生效。

## 配置快照

有效配置按总修订号复用；单个命名空间写入、整份 YAML 更新、预设失效和凭据变化都会推进修订号。返回值使用 detached 副本，调用方不能修改缓存。

Session 在轮次边界仍向环境校验最新修订号；没变化只返回 `unchanged`，复用已经解析的配置快照。变化时重新接入模型、权限、配置覆盖层和插件加载计划。不会通过 TTL 延迟权限或凭据撤销。

配置文档仍保留文件版本检查。同一 EnvironmentDO 内并发检查合并到一个在途任务，不设置跨请求时间缓存；文件读取失败继续向调用方报告，配置提交失败留下原有错误文件。

## 会话摘要

SessionDO 串行生成一组真实原版会话摘要，以持久单调序号发布到所属环境。EnvironmentDO 校验根和子会话归属，拒绝较旧发布覆盖较新摘要；成功写入后才发原有 added/status 通知和 projection 控制帧。冷读第一次遇到旧的 Agent 驻留标记时仍需向源确认，不能把内存中的服务可用性当作永久持久状态。

摘要是可删除的派生索引，带格式与固定上游 commit。会话头、原始日志、运行时和原版 projection fold 仍属于 SessionDO。注册根会话或子会话会使相关组失效。

- 已完成、无驻留 Agent 且有缓存的根会话：列表与控制流基线直接读取环境 SQLite；EnvironmentDO 冷重启也不需要逐个访问这些源对象。
- 仍在运行或缓存中有驻留 Agent 的根会话：回查源状态，避免宿主重建后保留过时的 running / agentAvailable 标志。
- 缺失或格式变化：有界并发读取源对象重建，保持原版空白、子会话、标题与投影语义。

HTTP 取消信号经内部 Fetch 传入环境，停止尚未派发的重建读取；已经派发的 RPC 仍按 Cloudflare 的 RPC 生命周期完成。没有增加第二个会话写入者或让列表唤醒 Agent。

## CI 验证和基线

`environment-services.test.ts` 验证多项配置写入故障后的整体回滚及原文件版本重试、工作区本地登记导入与原版 pending mutation 恢复、完成会话摘要在重启后零源读取，以及删除摘要后的源日志重建和标题更新。

fixture 给真实 SessionDO 的摘要读取计数，不用耗时阈值替代结构断言。CI 输出 `WEFT_PERFORMANCE`：冷列表耗时、热列表和设置读取的 p50/p95、提示词入队耗时，以及完成列表的源 RPC 数。这是 workerd 模拟环境的基线，不等于生产网络耗时，也不声称相对旧版的定量加速比例。原版浏览器、文件、终端、Git、插件和容器回归继续运行。
