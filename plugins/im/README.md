# @weft/dsh-im

This is an incomplete Worker adaptation of dsh-im. See the [three-channel parity checklist](./PARITY.md) for the pinned reference version, implemented behavior and remaining gaps. QR setup and a similar layout do not imply feature parity.

功能对齐尚未完成，完整差距及验收要求见[三渠道功能清单](./PARITY.md)。当前新增「通用 → 排队／插话」「访问 → 私聊／群聊权限与命令权限」「上下文增强 → 来源字段与提示词」；飞书还可设置收到群消息后的响应方式。旧白名单保持兼容，首次修改新权限页时迁移；扫码绑定者保留权限。开放模式必须显式选择，不会在升级时自动扩大已有账号权限。

Connects Feishu, WeChat and QQ conversations to DeepSeek Harness Sessions. It is a standard Cordis bundle (`dsh.bundle.patch`) with four entries:

| Entry | Role |
|---|---|
| `im-core` (`@weft/dsh-im/core`) | The `im` service: one Session per conversation, deduplicated prompts, `/new` `/stop` `/help`, and delivery of each finished turn from a durable cursor |
| `im-feishu` | Feishu / Lark QR app creation and outbound WebSocket; manual event subscription at `/feishu` |
| `im-weixin` | WeChat iLink: QR login at `/weixin/login?key=…`, long-polled messages, replies with the user's context token |
| `im-qq` | QQ QR bot creation and outbound WebSocket; manual HTTP callback at `/qq` (Ed25519) |

Channels inject `im`; other plugins can do the same to add a channel. Every channel is disabled until configured. By default only listed senders and the QR binding owner may talk to the bot. The access page can explicitly enable open access separately for private and group chats, and control command permission per user. A refused sender is told their id so an administrator can add it.

## Host services

`sessionController`, `weftSessionEvents` (Weft's [turn notifications](../../docs/architecture/session-turn-notifications.md)), `weftConnections` (Weft's [connection gateway](../../docs/architecture/connection-gateway.md)), `storageDomain` and `webServer`, plus outbound HTTPS. In Weft the deployment ships this bundle: install it from the Plugins page (no npm registry is used), then approve its browser module, network, routes, persistent storage, sessions and environment background access. Open **Settings → IM bots** (中文：**设置 → IM 机器人**) or the bundle detail page to configure channels.

The page follows [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im): the channel rail leads to an empty-state introduction, QR or credential binding, a bot card, and **More settings → General / Access**. The brand header, channel logos, surfaces, QR instructions, status indicators and responsive layout are adapted from that project's UI. See [third-party notices](THIRD_PARTY_NOTICES.md) for its MIT license and source revision.

If upgrading from 0.1.0–0.5.0, build an update to **0.6.0** in the plugin's bundle review, approve the new artifact with browser module access, then refresh the workbench. Channel configuration and the connected WeChat account persist across this update. The settings page and stylesheet unload when the bundle is disabled or removed.

Deploy the matching Weft build before upgrading to 0.6.0: 0.6.0 injects the Host's `weftSessionEvents` and `weftConnections` services, so on an older Weft Host the plugin cannot activate. Approve **Persistent outbound connections** together with external HTTPS: QR-created Feishu and QQ bots and the WeChat long poll are held by the shared connection gateway, so the environment sleeps between messages and a plugin reload keeps the connection.

Routes are served at `/v1/plugin-hooks/<tenant>/<environment>/@weft%2Fdsh-im/<path>`.

## Channel setup

- **Feishu**: choose **Connect with QR**, scan with Feishu or Lark, confirm the requested message permissions and complete any required app publication or tenant approval. The account that authorizes creation is automatically allowed to chat. Credentials stay on the server, and an outbound WebSocket receives messages without an HTTP callback. Alternatively choose **Manual setup**, select Feishu or Lark, enter App ID / App Secret and the Verification Token / optional Encrypt Key from *Events and Callbacks*, then click **Bind bot**. Enable the app's bot capability and `im:message` permissions; subscribe to `im.message.receive_v1` with the page's callback URL, then publish the app. In groups the bot answers when mentioned.
- **QQ**: choose **Connect with QR**, scan with mobile QQ and confirm bot creation/binding. The server decrypts and saves the returned credentials and automatically allows the authorizing account; an outbound WebSocket receives C2C and group @ messages. Alternatively choose **Manual setup**, enter AppID / AppSecret and click **Bind bot**. Set the displayed HTTP callback URL in the QQ developer platform and subscribe to C2C and group @ message events. The route answers the platform's validation request.
- **WeChat**: choose **Connect with QR**, scan the displayed code with the WeChat account that will act as the bot and confirm on your phone. The QR card shows the scan steps and renews expired codes through **Refresh QR code**. After confirmation the bot card replaces it. **Check connection** retains the existing login; **Scan again** begins replacement login. The capability travels in an Authorization header, and status responses never include the bot token. The original `/weixin/login?key=<key>` page remains available for manual setup.

Each bot card offers **Check connection**, **Pause / Resume**, **Remove bot** and **More settings**. For manually bound Feishu/QQ bots, credential checks request a provider token and report **Credentials verified**; HTTP callback setup must still be completed in the provider console. QR-created bots report the actual WebSocket connection state. Expired or declined authorization can be refreshed, and **Cancel** stops the current attempt. Cancelled or failed replacements preserve the existing QR account. Pausing, reloading or rotating the management key preserves completed bindings; unfinished attempts are cancelled on reload. QR credentials are held in the channel's environment storage and never returned by management routes or configuration forms. WeChat displays its actual iLink login status. Removing a bot clears its credentials and IM conversation bindings while preserving the native AI Sessions. Pausing preserves its credentials and bindings.

In **More settings → General**, edit the bot alias, workspace, Agent Preset, reply length and **Session sync**. Session sync sends turns the chat did not start back to it: *Scheduled tasks only* (default) delivers schedule results to private and group chats; *Scheduled tasks and Web turns* also delivers Web turns to private chats, prefixed with the Web question; *Off* delivers neither. Bindings made before 0.5.0 start syncing at their first turn after the upgrade. **Choose directory** opens a browser over the environment workspace (the Host `uiWorkspace` directory service), where you can open folders, enter a path or create a folder before selecting it; save the configuration afterwards. The Agent Preset list comes from the Host roster (`remote.agentPresets`); **Follow default** uses the Host default, and a saved preset that is no longer available stays listed and marked. On a Host without these services both fall back to text fields. Workspace and preset changes apply to newly created Sessions (send `/new` in an existing chat). **Access** edits the allowed-user list. The header's **General settings** sets the shared Agent Preset fallback and Session title prefix.

New IM Sessions use the native content-based automatic title, labeled `微信 · …`, `飞书 · …` or `QQ · …`, instead of pinning a raw chat/user ID. In the Session tree and search results, the loaded channel logo replaces the visual text prefix; the full title remains accessible, searchable and editable. Native status dots and row actions are preserved. Disabling the title-prefix option applies to new Sessions. Older `[weixin]`, `[feishu]` and `[qq]` titles also receive logos; their pinned titles remain editable, or send `/new` to start with automatic titles. The title decorator ignores inherited prompts in Web forks. Disabling the bundle removes its visual decoration and restores the plain text prefixes.

This Worker version connects one bot per channel and supports Feishu, WeChat and QQ. All three support QR setup; Feishu/QQ retain manual credentials and HTTP callbacks as an alternative. The Worker uses standard fetch, WebCrypto and the existing approved WebSocket egress, without requiring the reference project's Node SDK runtime. QR-created Feishu apps request message events, resource access and CardKit write permission. Existing apps must grant `im:resource` and `cardkit:card:write` and publish the updated permissions to use attachments and streaming cards. Secret inputs are write-only: leaving them blank preserves saved credentials. Existing per-entry configuration forms remain available for advanced settings.

中文操作：从左侧选择渠道。微信、飞书和 QQ 均可点击「扫码接入机器人」，飞书／QQ 也保留「手动接入」；接入后在机器人卡片上检查连接、暂停／恢复或移除。通过「更多设置」修改别名、工作区、Agent Preset、消息处理、访问权限与上下文增强；右上角齿轮打开通用设置。每个渠道当前支持一个机器人。飞书／QQ 扫码后通过长连接收消息，无需配置 HTTP 回调；只有手动接入需要在平台后台配置回调。飞书仍需按平台要求确认权限、发布或审批。扫码凭据仅保存在服务端，取消或失败不会覆盖已有绑定。

升级 0.6.0 前须先部署配套的 Weft 版本：0.6.0 依赖宿主的 `weftSessionEvents` 回合通知和 `weftConnections` 长连接网关，在旧 Host 上插件无法激活。审核时须同时授予「外部长连接」和「访问外部 HTTPS 服务」：飞书／QQ 扫码机器人的长连接和微信长轮询都由平台共享网关持有，环境在消息之间可以休眠，插件重载也不会断开连接。机器人选择模型不会改写全局默认模型。

「更多设置 → 通用 → 会话回推」把不是从这个聊天发起的回合结果发回来：默认「仅定时任务」，定时任务结果发到私聊和群聊；「定时任务和 Web 回合」还会把 Web 上的回合发到私聊，并附带 Web 上的提问；「关闭」都不发。0.5.0 之前绑定的会话，从升级后的第一个回合开始回推，不补发更早的回合。

0.3.1 会根据聊天内容自动生成新会话标题，保留原生标题更新，并附加「微信／飞书／QQ」标识；会话列表和搜索结果用渠道图标显示该标识，状态提示、无障碍名称和重命名保持可用。旧会话的渠道前缀也支持图标，但旧版固定的 ID 标题需手动修改，或发送 `/new` 使用自动标题。标题前缀开关只影响新会话；升级插件后刷新工作台生效。

## Validation

Build with `npm run build`; run the backend bridge, management and native title tests with `npx tsx --test tests/im-plugin.test.ts tests/im-qr.test.ts tests/im-session-titles.test.ts`. Run the real installed Client module, provider-fixture checks, Session tree/search and desktop/mobile browser flow with `WEFT_BROWSER_IM=1 npx playwright test tests/browser/im-plugin.spec.ts`. These tests use simulated providers, not real IM accounts.

The `Test` workflow runs the IM backend test in its unit shards and the IM setup browser regression as a dedicated step in Browser 1/2.

## Attachments and live replies (0.7.0)

Deploy the matching Weft Host before upgrading the bundle to 0.7.0. Approve workspace file access and tool registration alongside the existing Session, storage, network, routes and background grants. The new binary upload carrier and authenticated tool caller are Host extensions, so updating only the plugin is insufficient.

微信、飞书、QQ 可接收文件和图片；飞书也解析富文本中的图片。先检查聊天权限，再下载附件。单个附件最多 10 MiB，每条消息最多 10 个、合计 20 MiB；超限明确报错。原件按字节保存在会话附件中，图片交给原生 Images 解码、规范化与模型副本处理。不支持图片的模型、无效图片或未配置 Images 时保留文件，并在提示词中说明降级。附件不会自动过期或清理。

模型可调用 `im_send_file`，指定工作区文件的绝对路径，向本会话绑定的聊天回传文件；`asImage: true` 发送 PNG / JPEG / WebP / GIF 图片。工具使用宿主提供的真实调用会话，不能用参数指定其他聊天。单个回传文件最多 10 MiB；平台权限和额度仍可能拒绝。投递结果不确定时不自动重发，也不自动把图片改发为文件。

微信通过 iLink `getconfig` / `sendtyping` 显示并刷新“正在输入”，结束、取消或接入失败时停止。QQ 私聊发送并刷新原生输入状态；QQ 群聊没有该接口，结束后私聊状态由平台到期清除。飞书的 HTTP 回调与 WebSocket 共用 CardKit 单卡流式展示，结束时关闭 streaming mode；缺少卡片权限、更新失败或回答超出卡片预算时，完整回答改用普通 Markdown 卡片分段交付。普通卡片通过消息 API 内联发送，不依赖 CardKit 写权限；普通卡片也发送失败时再退回纯文本。命令回复和 Web/定时任务回推同样优先使用 Markdown 卡片。

0.7.2 在飞书「检查连接」结果中显示本次插件运行期间最近的回复格式，以及卡片失败的阶段、数字错误码和 HTTP 状态；这些诊断不包含服务商原始错误文本、消息正文或凭据。凭据验证成功不代表 CardKit 权限已经开通：手动接入及已有应用需在飞书开放平台添加「创建与更新卡片」（`cardkit:card:write`）权限，并发布新的应用版本。重新发送一条消息后检查结果；流式卡片权限失败也应保留普通 Markdown 卡片展示。飞书 Markdown 支持范围以其客户端规范为准。

Validation runs in the `Test` GitHub Actions workflow on the `ci` branch. The unit shards include `tests/im-media.test.ts`, `tests/im-plugin.test.ts`, `tests/im-qr.test.ts` and `tests/im-session-turns.test.ts`; Browser 1/2 also runs the installed IM settings regression. Provider fixtures cover native file admission above the JSON bridge limit, iLink encryption and input status, QQ input status, real environment-tool file return, and a card update before model completion. Real-account acceptance remains separate.


0.7.1 修正飞书群聊的 @ 判断：默认仅在 `mentions[].id.open_id` 命中当前机器人自身 ID 时触发；@ 其他人、其他机器人、@all 或同名成员不会触发。自身 ID 通过当前应用的机器人信息接口获取并缓存，账号重绑或插件重载后重新获取；无法确认身份时不处理群聊 @ 消息。明确选择「所有收到的群消息」时仍按开放响应模式工作。
