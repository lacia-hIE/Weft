# 原生子 Agent

默认工作台继续使用固定上游的 `AppWebEntry`。选择 `Delegator` 预设后，模型使用原版 `tool-subagent` 委派任务，使用 `tool-subagent-control` 发送消息或中断；标题栏的子 Agent 目录、层级导航、历史与输入框均由官方客户端提供。

## 执行与所有权

- 实际挂载 `SubagentRuntime`、spawn-in-process 与 fork-in-process provider，以及原生 AgentRegistry / AgentLoop。这里的 in-process 表示所属 workerd isolate 内的真实子 Agent，不启动 Node 进程、容器或远程 ACP 后端。
- spawn 从独立上下文开始；fork 继承父会话已经完成的前缀，不继承正在执行的父 turn。子 Agent 有自己的 Session、原生 descriptor、事件日志、模型调用和 inbox，默认继承父会话冻结的预设。
- 同一根会话的原生子会话仍由所属 SessionDO 写入。EnvironmentDO 保存不可变的 child → parent / root 寻址关系；关系在原生 `agent/created` 的串行生命周期内登记。跨租户、跨环境和不同根会话通过独立寻址与原版 lineage 校验拒绝，子会话 ID 不能覆盖根会话的目录记录。
- 历史读取借用真实热 Session，冷读取沿用原版 query、projection 与 history controller。观察者不创建另一个 Agent，不取得 writer，也不向活动会话写入恢复闭合事件。
- 普通根会话的 follow 在交付冷快照后，沿原版 promotion 边界委托所属 SessionDO 激活唯一宿主，使重新打开父会话可以恢复 continuation。子会话、搜索、投影与附件的冷读取不执行此激活。
- 完整原生目录和控制基线包含真实子会话摘要，携带 `origin`、父 ID、运行状态、可用性及原版投影，由官方界面决定展示位置。子会话不作为新的 Weft 环境卡片；搜索仍以真实逻辑 Session ID 返回结果。

## 宿主接线

`session/page` 与 `session/follow` 先定位物理所属 SessionDO，再由原版历史控制器验证子会话地址。投影与图片读取同样校验所属范围，再读取相应逻辑 Session。`subagents/prompt` 和 `subagents/interruptByParent` 使用官方生成的参数、结果 codec，调用实际子 Agent 服务；内部 Fetch 携带取消信号，错误保留原版 Remote code。冷或已经结束的 interrupt 沿用原版的接受但无操作语义，不创建虚假的运行状态。

流式帧按实际产生它的 Agent 转发；超时计时器按 Session 分开管理。宿主通过原版 `waitForChildren` 跟踪正在推进的后代，父 Agent 暂时空闲时仍保留真实后台工作。

归档通过实际运行时的原版 `workspace/session-activity` 查询根 turn 与子 Agent 活动。默认拒绝归档仍有工作的会话；显式选择停止工作时先持久化归档，再通过原版 `workspace/session-stop` 通知各服务取消自己的工作。

运行侧和读取侧的 SQLite 查询使用独立的固定派生表前缀，避免打开一个查询宿主时清掉另一个宿主的 live 记录或使其 cursor 失效。原始日志仍只有一份。构建期声明边界同时覆盖子 Agent 主模块与 internal 入口，避免 TypeScript 把同一原生类解析为两个不同身份；运行包继续构建固定上游的真实源码。

## 配置

原版 Built-in plugins 中的子 Agent 限额页面读取 `subagent` settings namespace。默认深度为 1，活动容量为 8；原版 volatile schema 负责校验，修改后在下一次 prompt assembly 前更新同一服务的配置单元，不重启正在运行的子 Agent 管理器。`tool-subagent.provider` 可在发布的预设配置中选择 `spawn` 或 `fork`。

当前声明的能力是继承本会话已经挂载的冻结预设。独立子预设的完整目录、更多模型选择策略、权限配置与子会话动态插件全流程仍需继续接通。原版 continuation 协议支持文本和图片，不接受通用文件部分；不增加私有替代协议。

生产 Worker 保持 `2026-07-30` 兼容日期，并显式开启 `durable_object_io_tasks_prevent_eviction`。该开关让等待 DO / Service Binding、`waitUntil` 与定时器的对象获得新的空闲保留语义；每项操作的保护最多 15 分钟，不是任意长任务保证，见 [Cloudflare 官方变更](https://developers.cloudflare.com/changelog/post/2026-10-01-pending-io-keep-alive/)。长任务和大规模并发的云端验收仍需单独完成。

## 验证

`tests/native-subagents.test.ts` 使用受控模型 HTTP 和真实 workerd / 原生 Agent 执行，覆盖独立上下文、fork 前缀、实时帧、后续消息、中断、冷恢复、子会话搜索、跨用户拒绝、运行中更新深度限制与带子任务归档。`tests/native-query.test.ts` 验证执行侧查询不会清理读取侧 live 索引或破坏 cursor。`tests/native-promotion.test.ts` 检查根会话冷快照后的实际激活没有提交新模型 turn。`tests/browser/subagents.spec.ts` 覆盖原版层级导航、继续交互、刷新与 workerd 重建后的恢复，并提供独立的真实 DeepSeek 用例。

命令：`npm run test:unit`、`npm run test:web:subagents`、`npm run test:web:live`。本地 workerd、受控模型、真实模型和 Access 用户登录后的云端流程分别记录，不能相互代替。

2026-10-19 最终验证：完整回归 99 / 99；真实 DeepSeek 浏览器 8 / 8；生产 Models 浏览器 1 / 1；受控父子会话冷恢复浏览器 1 / 1（同文件真实模型用例在受控模式下按预期跳过，已在独立真实模型运行中通过）。严格类型检查、69 个官方模块构建和两个 Worker 的预部署检查均通过。
