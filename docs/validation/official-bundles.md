# 官方组合包

官方 Plugins 页支持部署预编译目录中的 `dsh.bundle.patch`：首个组合包为 `@deepseek-ai/dsh-experimental-agent-team-profile`。卡片开关进入原版安装进度窗口，安装默认启用，也支持 API 安装时 `options.enabled=false`。可停用、重新启用、卸载与重装。名称不带版本时固定解析为当前部署版本；其他版本、安装脚本和替换 registry 明确拒绝。此路径不使用外部包的 Weft ABI，也不把任意 npm 内容当成官方可信代码。

构建从锁定、干净的上游 checkout 读取原始 manifest 和 patch，记录版本、commit 与 SHA-256。解析使用 JSON YAML schema，不执行 `!!js`。环境 SQLite 原子保存安装选择；原版 `applyEntryPatches` 执行原始 patch。读取预设时，将组合包配置应用到当前源预设，Session 保存最终冻结配置。根服务、预设工具与浏览器模块分别交由现有的真实运行时装配。

Team 复用原版 TeamService、tool-agent-team 和 client-ui-agent-team。创建与任务状态写入 Lead 日志；成员实际运行在所属 SessionDO 内的原生 spawn/fork provider，不为每个成员新建容器。旧的 subagent/control/list/fork 工具被 patch 停用，避免名字冲突。只读 Session reader 注册原版 Team fold，冷读取不会启动 Agent。检查预设的 Context 挂载真实持久化服务但不打开 Session handle，也不取得 writer。

启停适用于新会话。已有会话、它们的子 Agent 和 fork 保留冻结配置；停止/卸载不是取消正在工作的团队。用户需要通过原版中断、归档或容器控制停止对应工作。官方浏览器模块通过已认证的环境 Boot 入口选择，启停后需要刷新工作台。停用时刷新会移除 Team 面板；旧 Team 日志保留，可在重新启用后查看。静态文件可被读取不代表安装选择或宿主权限已经授予。

这不是任意官方或第三方 bundle 的通用运行器。新增组合包必须验证其宿主服务、工具及 Client 依赖，再加入部署目录。更新部署后如旧声明的版本或摘要不同，拒绝以新代码冒充原版本，需显式重新安装。尚未提供通用 patch 上传、动态 Host 服务桥接、配置表达式执行、安装版本切换或历史二进制保存。

CI 验证覆盖真实 workerd、官方工具、团队成员/共享任务日志、冷读投影与成员 inbox 恢复、冻结会话、租户隔离、清单和启停卸载，以及官方安装页面。所有构建、类型检查和测试只在 ci 分支运行。云端多成员长任务仍需独立运行验收。
