# 会话回合通知

环境插件需要知道它关心的 Session 何时结束了一个回合，例如 IM 要把定时任务的结果发回绑定的聊天。原版只提供 `sessionController.follow`，它是 SessionDO 经 EnvironmentDO 中转的流式响应。流开着时两个 DO 都有进行中的请求，不能休眠。如果对每个已绑定会话都常开一条 follow，每个会话每月约 32 万 GB-s（约 $4），环境 DO 也会因此常驻。

本设计让 SessionDO 在根会话回合结束时通知所属环境，再由环境转发给订阅了该会话的插件。插件收到通知后，只在短时间内读取所需事件。成本是每个回合一次 DO 调用，与绑定了多少会话无关。

## 流程

```
SessionDO：根会话 turn/end 落盘
   │  nativeSessionTurnEnded(scope, sessionId, seq)        best-effort，失败不影响回合
   ▼
EnvironmentDO：查 weft_session_watches(package, session_id)
   │  无订阅：立即返回
   │  有订阅：reconcile 后台包，仅投递给已获批、已启用且有「管理本环境会话」授权的包
   ▼
插件 facet：weftSessionEvents 处理函数 ({sessionId, seq})
   │  从自己的持久游标读取到 seq，按插件规则处理
```

- 只通知根会话。子代理的回合属于父回合，不单独通知。
- 通知前先刷新 Session 持久化，插件收到时可以读到 `turn/end` 及之前的事件。
- 通知只是提示，不承载内容，也不保证一定送达。SessionDO 崩溃、环境暂停或投递失败时，通知可能丢失；插件必须以自己的持久游标为准，在下次通知或下次主动读取时补上。同一个 `seq` 也可能被通知多次，插件按游标去重。

## 插件接口

Weft 专有的环境宿主服务 `weftSessionEvents`，归入「管理本环境会话」授权，不新增审核项。和 `sessionController` 一样，inject 这个服务会使包归入环境宿主。

```js
export const inject = ['sessionController', 'weftSessionEvents'];

await ctx.weftSessionEvents.watch(sessionId);    // 幂等；只能订阅本环境的根会话
await ctx.weftSessionEvents.unwatch(sessionId);  // 幂等
ctx.effect(() => ctx.weftSessionEvents.onTurnEnded(async ({sessionId, seq}) => { /* ... */ }));
```

- 订阅关系保存在 EnvironmentDO 的 SQLite，以包名为键，跨激活、驱逐和版本更新保留。卸载包时清除；停用时保留，但不会投递。
- 处理函数在插件初始化时登记，不持久化。插件尚未运行时，通知会先激活后台包，再交给处理函数。
- 处理函数受环境 Host 现有的 60 秒执行期限约束。耗时的读取和发送应放到后台进行，处理函数只需记下游标。

## IM 的使用方式

IM 为每个聊天保存当前对话会话，并为每个自动化任务独立保存机器人和聊天目标。`/new` 只改变当前对话会话；原执行会话的通知订阅和任务目标继续保留。任务更换执行会话时，环境将订阅提示复制给新执行会话，插件根据持久化的任务路由决定收件人。移除机器人时删除其对话、来源和任务路由并注销订阅。已有绑定在插件启动时迁移，保留游标。

每个会话行记录 `delivered`（已处理到的序号）和 `notified`（收到通知的最大序号）。只要还有待回复的 IM 消息，或 `notified > delivered`，就短暂地 follow 一次，处理到最新序号后关闭。回合结束时按来源决定是否投递：

| 回合来源 | 私聊 | 群聊 |
| --- | --- | --- |
| IM 自己发起的消息 | 投递（原有行为） | 投递（原有行为） |
| 定时任务（`source.kind === 'schedule'`） | 「会话回推」不是关闭时投递 | 同左 |
| Web 等其他来源 | 「会话回推」选择「定时任务和 Web 回合」时投递，附带用户的原文 | 不投递，避免刷屏 |

- 每个机器人的「会话回推」默认是「仅定时任务」。每个聊天与执行会话组合有独立通知游标；对话回复和自动化通知分别去重。
- 仅解析 `source.kind === schedule` 的原版 reminder framing 中的任务 ID；普通用户消息不能选定收件人。不同聊天任务被原版调度器合并时不转发合并结果，发送拆分执行会话的提示，避免内容串到其他聊天。
- 补订阅的旧会话，从收到的第一条通知开始同步，不会补发订阅前在 Web 上进行的回合。
- 只投递最终回答，不投递「本轮未完成」之类的提示。

渠道限制保持不变：QQ 主动消息有配额，微信依赖用户最近一次的 context token，过期后可能发送失败。发送失败会记录日志并推进游标，不重复发送。

## 成本

| 项 | 量级 |
| --- | --- |
| SessionDO → EnvironmentDO | 每个根回合一次 RPC；无订阅时环境只查一次索引 |
| EnvironmentDO → 插件 | 每个被订阅会话的每个回合一次 |
| 插件读取事件 | 每个有待处理回合的对话／任务通知绑定短暂 follow，读完即关闭 |
| 任务路由发现 | 每次刷新离线聚合本环境的根会话任务，最多 16 个并发；不启动 Agent |
| 常驻 DO | 无 |

## 实现位置

| 部分 | 位置 |
| --- | --- |
| SessionDO 通知 | `apps/worker/src/index.ts`（`onEvent` 中根会话 `turn/end` → `notifyTurnEnded`） |
| 订阅表与转发 | `packages/control-plane/src/object.ts`（`weft_session_watches`、`nativePackageWatchSession`、`nativeSessionTurnEnded`） |
| 后台包投递 | `packages/package-install/src/environment.ts`（`dispatchSessionEvent`）→ `packages/native-plugins/src/platform.ts` → facet |
| 插件服务 | `packages/native-plugins/src/session-events.ts`，由 `kernel.ts` 在授权后提供 |
| IM | `plugins/im/src/core.js`（订阅、`turnEnded`、`mirrored`），设置项 `sessionSync` |

## 验证

`tests/im-session-turns.test.ts`（Miniflare，真实 SessionDO/EnvironmentDO 和原版定时任务）：用户通过 QQ 让模型创建 2 秒后的提醒，提醒回合的回答发回 QQ 且只发一次；Web 回合默认不投递；切换到「定时任务和 Web 回合」后，之后的 Web 回合连同提问投递到私聊，之前的 Web 回合不补发。

测试还覆盖 `/new` 后原任务通知、跨 SessionDO 更换执行会话、投递记录和频率限制保留，以及单任务关闭。`tests/native-schedule.test.ts` 覆盖旧运行时任务只读查看及迁移、导入已提交但响应丢失后的重启恢复。群聊、移除机器人和停用的专门回归仍可继续扩充。


## 自动化执行会话迁移

`sessionController.scheduleCatalog({})` 是 Weft 的环境级只读扩展，与现有会话权限共用授权；重新检查激活凭据后返回本环境各根 Session 的任务。IM 在首次观察任务时按原始 involvedSessionIds 建立默认通知目标，之后只有显式 `/notify` 改变目标。

网页 `schedule/edit` 跨会话修改目标时，由 EnvironmentDO 的持久化迁移日志协调。源对象先停止调度器并排空已接受的投递，检查 Agent 和持久化 inbox 空闲，在同一事务中保存迁移文档并移除源任务。目标以迁移 token 幂等导入完整任务，恢复自己的调度器与 alarm；源对象收到确认后清理迁移文档。环境只在收到两端确认后移除日志。导入响应丢失时不会覆写已运行过的目标任务，下次全局读取恢复同一迁移。

迁移使用原版规则更新器和任务 schema，保留投递历史、lastDelivery 和最短投递间隔。已有历史会话不改写、不激活旧 Agent。`schedule/view` 与 `schedule/history` 可离线读取，因此旧运行时任务仍能打开编辑器并选择新执行会话。执行中或仍有排队输入的当前运行时会话拒绝迁移。源任务移除和目标导入之间可能暂时延迟，下一次全局调度请求恢复日志；不承诺跨对象零延迟投递。


## 旧任务删除

旧执行运行时不可激活时，网页单条删除和“清理已结束任务”直接操作任务存储，无需先迁移或运行旧 Agent。删除沿用原服务的任务查找与 `expectedUpdatedAt` 冲突检查；批量清理仅删除 ended（含 v1 的 inactive），保留 active 与 paused。删除和 v1 → v2 版本戳更新在同一事务中完成；单条删除同步剩余任务的 alarm，最后一个活动任务删除后清除 alarm。会话记录不改写。当前运行时仍使用原调度服务的 FIFO 与变更通知。回归覆盖真实 v1 行、旧运行时、冲突、批量清理、alarm 和重启持久性。
