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

IM 为每个绑定的会话订阅通知：新建或 `/new` 时订阅新会话、注销旧会话，移除机器人时全部注销。已有绑定在插件启动时补订阅一次，并记录在会话行上。

每个会话行记录 `delivered`（已处理到的序号）和 `notified`（收到通知的最大序号）。只要还有待回复的 IM 消息，或 `notified > delivered`，就短暂地 follow 一次，处理到最新序号后关闭。回合结束时按来源决定是否投递：

| 回合来源 | 私聊 | 群聊 |
| --- | --- | --- |
| IM 自己发起的消息 | 投递（原有行为） | 投递（原有行为） |
| 定时任务（`source.kind === 'schedule'`） | 「会话回推」不是关闭时投递 | 同左 |
| Web 等其他来源 | 「会话回推」选择「定时任务和 Web 回合」时投递，附带用户的原文 | 不投递，避免刷屏 |

- 每个机器人的「会话回推」默认是「仅定时任务」。
- 补订阅的旧会话，从收到的第一条通知开始同步，不会补发订阅前在 Web 上进行的回合。
- 只投递最终回答，不投递「本轮未完成」之类的提示。

渠道限制保持不变：QQ 主动消息有配额，微信依赖用户最近一次的 context token，过期后可能发送失败。发送失败会记录日志并推进游标，不重复发送。

## 成本

| 项 | 量级 |
| --- | --- |
| SessionDO → EnvironmentDO | 每个根回合一次 RPC；无订阅时环境只查一次索引 |
| EnvironmentDO → 插件 | 每个被订阅会话的每个回合一次 |
| 插件读取事件 | 每次通知一次短暂的 follow，读完即关闭 |
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

尚未覆盖：群聊只回推定时任务、`/new` 切换订阅、移除机器人后注销，以及停用包时不投递。
