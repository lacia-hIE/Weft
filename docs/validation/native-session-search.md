# 原版会话搜索与完整目录

`session/search` 通过官方生成的输入、结果 codec 与 Connection 信封，调用原版 `ApiSessionList.search`。侧栏的标题匹配、正文搜索、加载状态、无结果提示、结果点击与刷新恢复保持原版 UI。环境索引只读取所属 SessionDO，不跨租户或环境搜索。

## 原生实现

`packages/native-query` 挂载固定上游的真实 `SqliteSessionQueryEngine`。字面量查询处理、FTS5 语义文档、current/shadowed 分类、排序、Unicode 摘要、游标与失效规则均由上游代码负责。Web 搜索仍只选取 current 的 user/assistant 消息，最多返回 20 个不同会话，并如实提供 `hasMore`；不索引模型 reasoning 或用原始 JSON 的字符串匹配替代正文搜索。

EnvironmentDO 保存派生索引，SessionDO 保留唯一权威日志和写入者。`EnvironmentSessionPersistence` 是真实的只读持久化服务：元数据来自源对象，读句柄按固定日志 cut 获取连续、经过原版 schema 校验的事件页，写操作明确拒绝。原生子会话按实际 owner 定位源 DO，保留自身逻辑 ID。页通常不超过 512 KiB UTF-8；单个超过该预算的合法事件整条返回，不截断事件。目录和源页取消通过内部 Fetch 传递，元数据扇出最多 4 个。原版引擎在对比前后 revision 后提交索引，源变化处理沿用上游的稳定观察和重试规则。

跨对象的搜索来源是实际已提交日志；活动历史订阅继续借用 SessionDO 内真实的热 Session。原版只读冷查询可能在派生观察中平衡未结束的 turn，但搜索不持有 writer、不将这些闭合事件写回，也不把它们交给活动历史订阅。Web 搜索的消息类型过滤排除这些恢复结果。流式显示中尚未提交的 assistant 帧不构成已提交正文。

## SQLite 平台适配

实测 workerd 的 DO SQLite 支持 STRICT 表、FTS5、highlight、窗口函数及 `transactionSync` 回滚，但拒绝 TEMP 表。Cloudflare 也不允许通过 `sql.exec` 执行 SQL 事务指令。

`scripts/native-query-platform.mjs` 从固定源码提取原版 DDL，并只替换数据库打开和原子提交边界。原版查询表名被映射到固定的 `weft_query_*` 名称；连接级 live 表使用专用持久表，在新的查询实例首次开放时清空。派生 schema 版本变化只重建已知的派生表，不设置全库 `application_id/user_version`，不清理原始日志或配置。事务使用 `storage.transactionSync`，不能把 BEGIN/COMMIT 当作无操作跳过。构建拒绝未适配的事务语句和生产包中的 `node:sqlite`。

目录继续遵循官方完整 `items` 协议，没有新增私有客户端分页协议。两处 `LIMIT 200` 已移除，Workspace header 读取、目录状态读取与控制基线采用有界扇出。完整目录仍受平台内存、响应和调用预算限制；当前验证规模为每环境 205 个会话，不将此结果扩展为任意规模承诺。

## 验证

- 原版引擎在真实 workerd 中检索 205 个提交会话，分页不重复，排序与 20 条 Web 结果上限保持原版行为；源变化导致旧游标失效。
- 真实 Native Session、当前正文、Unicode 与 reasoning 排除；查询宿主重建后连接级 live 记录消失，持久记录仍可检索。
- 派生索引注入写入故障后整体回滚，原始日志保持完整，移除故障后可重新搜索。
- 同名 Session 在不同租户和环境中分别检索；非法查询拒绝，冷重启后的搜索不激活 Agent。
- 持续运行的真实 Agent 在受控模型传输中接受搜索；活动历史和 cursor 保持原样，原生工具及第二次模型调用正常完成。
- 205 个实际 SessionDO 的目录、最旧正文命中及完整控制基线；空白会话不因目录和搜索而激活 Agent。
- 大日志通过字节限额分页，页读取被取消时不提交该批派生索引，后续检索可覆盖末页。
- 原版浏览器搜索输入、正文结果、无结果状态、结果点击和刷新恢复；真实 DeepSeek 流程另行记录，不把受控模型当作真实模型验收。

命令：`npm run test:unit`、`npx playwright test tests/browser/search.spec.ts`、`WEFT_BROWSER_LIVE=1 npx playwright test --grep 'real DeepSeek'`。

2026-10-19 验证：完整 workerd 回归 93/93 通过；正文搜索的普通浏览器流程通过；最终真实 DeepSeek 浏览器回归 7/7 通过，覆盖搜索、原版聊天与历史、通用附件、图片输入、`read_image` 和两条插件流程。严格类型检查、69 个官方客户端的完整构建及两份 Worker 的 `cf deploy --dry-run` 均通过。完整构建后的 Worker、资产 Worker、入口脚本与搜索 DDL 哈希均与已测试产物一致。模型生成控件可具有独立的可访问名称，插件回归按精确可见计数文字定位，并继续验证真实 Host 调用及文件写入。

以上浏览器验证运行在本地真实 workerd 并调用真实模型，不替代 Cloudflare Access 用户登录后的云端完整流程。更大规模并发、长任务、子 Agent 和其余原生接口仍需继续验收。
