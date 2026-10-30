# 出站长连接网关

状态：已实现。代码在 `packages/connection-gateway`（`ConnectionGatewayDO`）、`packages/native-plugins/src/connections.ts`（插件服务）和 EnvironmentDO 的 `nativeConnection*` 方法；IM 0.6.0 起使用。

环境 Host 现在直接持有出站 WebSocket 和长轮询（见 [Worker Host 的 HTTPS 出口](worker-host-plugins.md#https-出口)）。出站连接不能休眠，EnvironmentDO 因此 24 小时按 128 MB 计费；联网插件即使没有建立任何连接，也会被每 60 秒一次的看门狗 Alarm 唤醒。开了 IM 的环境越多，常驻 DO 就越多。

本设计新增 Weft 专有的环境宿主服务 `weftConnections`。插件声明要保持哪些连接，以及心跳和控制帧的处理规则；连接本身由少量共享的 `ConnectionGatewayDO` 持有。插件所在的环境只在有业务消息时被唤醒，其余时间可以休眠。IM 插件是第一个使用方。

## 目标与边界

- 网关只执行宿主代码，不加载插件代码。Cloudflare 每个 DO 同时最多 10 个 Dynamic Worker 有进行中的请求，长连接会一直占用名额，因此不能在网关里运行各环境的插件。
- 网关不内置飞书、QQ、微信等任何渠道协议。心跳、控制帧过滤和游标都用声明式规则表达；凡是需要协议判断的消息，一律投递给插件处理。
- 消息至少投递一次。插件负责去重（IM 已按渠道消息 ID 和 Session `requestId` 去重）。
- 不提供原始 TCP 连接。目标地址仍走现有出口检查：只允许公开域名的 HTTPS/WSS 标准端口。

## 成本对比

| 开着 IM 的环境数 | 现状（每个环境一个常驻 DO） | 网关（按分片计） |
| --- | --- | --- |
| 1–2 个 | 在账号含有的 40 万 GB-s 内 | 无差别 |
| 10 个 | 约 324 万 GB-s/月，约 $35 | 1 个分片，约 $4 |
| 100 个 | 约 3240 万 GB-s/月，约 $400 | 1 个分片（容量内），约 $4 |

按每个常驻 DO 每月 0.125 GB × 2,592,000 秒估算，单价为每百万 GB-s $12.50。环境侧剩余的成本是每条业务消息、每次续租和每次重连各一次 DO 请求。

## 插件接口

`inject: ['weftConnections']` 与 `storage`、`sessionController` 一样，会使包归入环境宿主。审核页新增一行「外部长连接」能力（高风险）；没有同时授予「访问外部 HTTPS 服务」时不能获批。

```js
const connection = ctx.weftConnections.socket('feishu', {
  version: `${appId}:${fingerprint}`,        // 账号标识；与网关记录不同时替换连接
  async open(state) {                        // 需要（重新）建连时调用，可在这里换取新的 URL 或 token
    return {url, heartbeat: {everyMs: 120_000, frame: {base64: ping}}, drop: [{bytesInclude: PONG_HEADER}], idleMs: 360_000};
  },
  async connected(connection) { /* 例如 update({state: {online: true}}) */ },
  async message(data, connection, state) { /* 处理事件，再 connection.send(ack) */ },
  async closed(info, connection) { /* 返回 false 停止；否则调用 open(state) 重连 */ },
});

ctx.weftConnections.poll('weixin', {
  version: botId,
  open(state) {
    return {
      request: {url, method: 'POST', headers, body: '{"get_updates_buf":{{cursor}}}'},
      cursor: {path: 'get_updates_buf', initial: savedCursor},
      deliverWhen: {path: 'msgs', nonEmpty: true},
      failWhen: [{path: 'ret', notIn: [0, null]}],
    };
  },
  async response(body) { /* 处理 msgs；正常返回后网关才推进游标 */ },
  async failed(body, connection) { /* 例如登录过期时 close()，其他错误 reconnect() */ },
});

await ctx.weftConnections.close('qq');      // 关闭本次激活没有登记的连接，例如已停用的渠道
```

- 处理函数在插件初始化时按稳定 ID 登记，和持久计时器一样：环境被驱逐或重新部署后，插件重新初始化并再次登记同一个 ID。`version` 相同且连接仍在时，网关保留现有连接，不会重连；首次建连失败会在插件内退避重试几次。
- fiber 释放不会关闭连接，因为驱逐和部署本来就不执行 disposer。只有四种情况会关闭连接：插件调用 `connection.close()` 或 `weftConnections.close(id)`、宿主撤销授权、插件停用或卸载、环境停止或删除。
- `connection.send(data)`、`connection.update({heartbeat, idleMs, state})`（例如收到 QQ hello 后设置心跳，或把 `online` 写进跟踪状态）、`connection.reconnect()` 和 `connection.status()` 都可以在任何处理函数中调用。轮询连接的 `reconnect()` 在退避后重新调用 `open`。

## 声明式规则

| 规则 | 作用 | 用例 |
| --- | --- | --- |
| `heartbeat` | 网关按间隔发送固定帧或模板帧，`{{state.x}}` 替换为跟踪到的值 | 飞书 ping（固定二进制帧）；QQ `{"op":1,"d":{{state.seq}}}` |
| `track` | 从文本 JSON 帧提取字段存入连接状态，先于 `drop` 执行 | QQ 的 `s` 字段，存为 `seq` |
| `drop` | 匹配的帧不投递给插件；支持 JSON 路径等值匹配和二进制字节序列包含 | QQ 的 `op: 11`（心跳确认）；飞书 pong |
| `idleMs` | 超过这个时间没有收到任何帧，就判定连接失效并重连 | 各渠道心跳超时 |
| `cursor` / `deliverWhen` / `failWhen` | 轮询模式下的游标提取、何时投递、何时判定失败 | 微信 `getupdates` |

规则只能匹配字段或字节，不能执行表达式，以免把插件逻辑带进网关。重连时调用插件的 `open(state)`，`state` 中带着跟踪到的值，例如 QQ 的 `seq`，插件据此决定发 resume 还是 identify。

## 投递与可靠性

```
ConnectionGatewayDO ──(按连接顺序、批量)──▶ EnvironmentDO.nativeConnectionDeliver(scope, receipt, batch)
        ▲                                             │ reconcile 后调用插件已登记的处理函数
        └──────────────── 处理成功 ─────────────────────┘
```

1. 网关收到业务帧后，先写入自己的 SQLite 缓冲，再投递给环境。
2. 插件处理函数正常返回，才视为确认：网关删除缓冲，轮询模式这时才推进游标。投递失败时退避重试；同一连接内严格按顺序处理，后面的帧不会越过失败的帧。
3. 渠道层面的确认（例如飞书的事件 ack）由插件在处理函数里通过 `connection.send()` 发出。各渠道对 ack 时限的要求，需要压测确认唤醒环境的延迟能否满足。
4. 缓冲有上限，例如每个连接 1,000 帧、16 MiB。超过上限就暂停读取或关闭连接，并向插件报告 `closed({reason: 'backpressure'})`。

## 授权与生命周期

- **建连**：插件第一次登记时，网关通过 EnvironmentDO 校验精确版本、启用批次，以及外部长连接和网络两项授权，确认后签发一份租约（例如 15 分钟）。
- **续租**：由网关的 Alarm 发起，每 10 分钟向环境确认一次。环境每 10 分钟被唤醒一次，每次只需几毫秒。续租失败或授权已撤销时关闭连接。这取代了现在每 30 秒一次的复查。
- **主动撤销**：停用、卸载、改变授权、暂停或删除环境时，EnvironmentDO 立即通知网关关闭该环境对应的连接，不必等租约过期。
- **网关自身重启**（部署或驱逐）：连接规格和状态持久化在网关 SQLite 中，网关的 Alarm 恢复后自动重连；重连需要新参数时调用插件的 `open`。
- **环境侧**：使用网关的包不再计入 `networked()`，EnvironmentDO 不再为它设置 60 秒看门狗。

## 部署与分片

- 新建 `packages/connection-gateway`，导出 `ConnectionGatewayDO`；Worker 增加对应的 DO 绑定和 migration。
- **按最低成本分片：先填满再扩展。** 所有租户共用分片 `gateway-0`、`gateway-1`……。新连接先尝试 `gateway-0`，满了（返回 `full`）再试下一片，直到 `WEFT_GATEWAY_SHARDS`（默认 8）片都满时拒绝。环境在自己的 SQLite 里记录每条连接所在的分片，之后的发送、更新、关闭和撤销都直接找那一片，不需要协调者。
- 没有连接的分片没有常驻 I/O，会休眠，不计时长费。连接数在一片容量以内时，整个账号只有一个常驻 DO。相比按哈希固定分 4 片（连接少时也会散落到 4 个常驻 DO），这是费用最低的布局。
- 每片容量上限默认 500 条连接（`WEFT_GATEWAY_SHARD_CAPACITY`），以单个 DO 单线程的吞吐和 128 MB 内存为界，需要压测校准。连接关闭后释放名额；已有连接不会在分片之间迁移。
- 网关里会同时存放不同租户的连接规格。这些规格可能带有 token，例如微信长轮询的请求头，所以存储时按 `scope` 分区，任何接口都不回显，连接关闭时一并删除。日志不记录帧内容。

## IM 插件迁移

| 渠道 | 现状 | 迁移后 |
| --- | --- | --- |
| 飞书 | `feishuSocket`：插件自己发 ping、处理 pong、维护 watchdog | `socket`：心跳为固定 ping 帧，`drop` 掉 pong；事件帧投递给插件，插件发 ack。pong 里携带的 ClientConfig 只在建连后读取一次 |
| QQ | `qqSocket`：自己处理心跳、序号和 resume | `socket`：用 `track` 跟踪 `s`，心跳模板带上 `seq`，丢弃 `op:11`；hello、dispatch 和 reconnect 帧投递给插件 |
| 微信 | `background` 循环里长轮询 | `poll`：游标为 `get_updates_buf`，`ret` 非零判定失败；`-14`（登录过期）上报给插件后停止轮询 |

`channel-sockets.js` 中的帧编解码继续由插件使用，用于解析业务帧和构造 ack；建连、心跳和看门狗代码删除。插件 inject `weftConnections` 后成为 Weft 专有插件，不能再在原版 DSH Host 上运行；这和它作为 `@weft/dsh-im` 的定位一致。

## 验证

- Miniflare 中模拟飞书和 QQ 的 WebSocket 服务端（复用 `tests/helpers/im-qr.ts`）以及微信长轮询，覆盖：心跳与 `drop`（控制帧不唤醒环境）、业务帧顺序投递与确认、投递失败后重试且不越过失败帧。
- 模拟环境驱逐：连接保持，环境恢复后登记同一 ID 不触发重连。模拟网关重启：从 SQLite 恢复并重连，调用 `open(state)`，QQ 走 resume。
- 撤销授权或停用插件后，连接在主动通知时关闭；不通知时，最迟在租约到期时关闭。
- 达到容量和缓冲上限时有明确的错误或背压表现。
- 成本：用指标确认环境 DO 只在业务消息和续租时被唤醒，网关分片的时长与连接数无关。

## 待定

- 单分片的连接数和吞吐上限，需要压测确定。
- 各渠道对确认时限的要求（例如飞书事件 ack 的超时）能否容忍唤醒环境的延迟；如果不能，再评估由网关代发通用确认帧。


### Generic mailbox connections

`weftConnections.mail(id, handlers)` declares an encrypted IMAP/SMTP mailbox. The Host owns the TCP transports (ImapFlow over `cloudflare:sockets`, bounded SMTP submission and MIME encoding); a package never obtains a raw TCP socket. The existing network and persistent connection grants, receipt leases and tenant/environment routing apply. Mailboxes poll from Durable Object alarms about once a minute, persist UIDVALIDITY/UID cursors and only advance after buffered events are acknowledged. First connection and a UIDVALIDITY reset baseline at UIDNEXT rather than replaying historical mail.

`checkMail`, `replyMail` and `mailAttachment` are scoped to that connection. SMTP recipients and thread headers are reconstructed from the original IMAP message. Replies reserve a durable SHA-256 delivery identity before SMTP so an uncertain DATA acknowledgement cannot cause automatic duplicate sends. New credentials replace the transport without resetting a same-account cursor; a different mailbox discards old buffered events and starts a new cursor. No messages are marked read or removed.
