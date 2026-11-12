# 官方组合包与 Agent Teams

## Agent Teams（DSH 0.2.2-rc.2 起）

DSH 0.2.2-rc.2 把 Agent Teams 从实验性可选组合包 `@deepseek-ai/dsh-experimental-agent-team-profile` 并入官方 base 与 web-app bundle，Weft 随之把它作为每个会话都有的内置能力，不再需要安装。

- **团队模式是根会话的开关**。原版会话菜单通过 `agentTeams/setEnabled` 保存选择，写入根会话日志（`team/mode`），新会话默认关闭。只有根会话能切换，子代理调用会被拒绝。开关只影响该会话树，不影响同一环境里的其他会话。
- **挂载**：每个会话的原生根世界挂载原版 `agent-team` 服务（`maxTasks: 256`，与官方 base bundle 相同）和 `tool-agent-team`。`team_task_create/list/get/update` 工具与团队协作提示只在团队模式开启时提供给模型。浏览器模块 `ui-agent-team` 随官方 Boot Graph 加载。
- **队友就是具名子代理**：由原版 `subagent` / `subagent_fork` 工具以 `name` 创建，在所属 SessionDO 内运行，不为每个成员新建容器。`send_message` 按名称投递，根代理名为 `lead`。任务板写入根会话日志；只读 Session reader 注册原版 Team 投影，冷读取不会启动 Agent。关闭团队模式不会删除任务板，也不会停止已有子代理。
- **升级**：环境里登记过的旧组合包选择在注册表打开时删除。旧修订或环境自建预设中残留的 `agent-team`、`tool-agent-team`、`ui-agent-team` 行在装配与预设迁移时丢弃。旧团队日志仍可读取。

`tests/native-bundles.test.ts` 在真实 workerd 中用脚本模型验证：默认关闭时没有任务工具；开启后创建具名队友和共享任务；另一个根会话不受影响；子代理不能切换模式；重启后冷读投影恢复开关、任务与成员；冷启动后向队友发消息并收到回复；关闭后工具消失且任务保留。

## 可选官方组合包的安装路径

Plugins 页仍支持安装部署预编译目录中的官方 `dsh.bundle.patch` 组合包：构建从锁定、干净的上游 checkout 读取原始 manifest 和 patch，记录版本、commit 与 patch 的 SHA-256；环境 SQLite 原子保存安装选择。名称不带版本时固定解析为当前部署版本，其他版本、安装脚本和替换 registry 一律拒绝。

DSH 0.2.2-rc.2 没有需要单独安装的官方组合包，所以目录为空。每个可选组合包都要先有审查过的运行时适配，没有适配时拒绝启用，不会静默忽略。这不是任意官方或第三方 bundle 的通用运行器：新增组合包前必须验证它的宿主服务、工具及 Client 依赖。
