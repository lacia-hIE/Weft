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

`sessionController`, `storageDomain` and `webServer`, plus outbound HTTPS. In Weft the deployment ships this bundle: install it from the Plugins page (no npm registry is used), then approve its browser module, network, routes, persistent storage, sessions and environment background access. Open **Settings → IM bots** (中文：**设置 → IM 机器人**) or the bundle detail page to configure channels.

The page follows [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im): the channel rail leads to an empty-state introduction, QR or credential binding, a bot card, and **More settings → General / Access**. The brand header, channel logos, surfaces, QR instructions, status indicators and responsive layout are adapted from that project's UI. See [third-party notices](THIRD_PARTY_NOTICES.md) for its MIT license and source revision.

If upgrading from 0.1.0–0.3.1, build an update to **0.4.0** in the plugin's bundle review, approve the new artifact with browser module access, then refresh the workbench. Channel configuration and the connected WeChat account persist across this update. The settings page and stylesheet unload when the bundle is disabled or removed.

Deploy the matching Weft build before upgrading to 0.4.0: Feishu's binary WebSocket protocol also requires the updated Host egress relay. Updating only the plugin artifact on an older Weft Host does not add that relay fix.

Routes are served at `/v1/plugin-hooks/<tenant>/<environment>/@weft%2Fdsh-im/<path>`.

## Channel setup

- **Feishu**: choose **Connect with QR**, scan with Feishu or Lark, confirm the requested message permissions and complete any required app publication or tenant approval. The account that authorizes creation is automatically allowed to chat. Credentials stay on the server, and an outbound WebSocket receives messages without an HTTP callback. Alternatively choose **Manual setup**, select Feishu or Lark, enter App ID / App Secret and the Verification Token / optional Encrypt Key from *Events and Callbacks*, then click **Bind bot**. Enable the app's bot capability and `im:message` permissions; subscribe to `im.message.receive_v1` with the page's callback URL, then publish the app. In groups the bot answers when mentioned.
- **QQ**: choose **Connect with QR**, scan with mobile QQ and confirm bot creation/binding. The server decrypts and saves the returned credentials and automatically allows the authorizing account; an outbound WebSocket receives C2C and group @ messages. Alternatively choose **Manual setup**, enter AppID / AppSecret and click **Bind bot**. Set the displayed HTTP callback URL in the QQ developer platform and subscribe to C2C and group @ message events. The route answers the platform's validation request.
- **WeChat**: choose **Connect with QR**, scan the displayed code with the WeChat account that will act as the bot and confirm on your phone. The QR card shows the scan steps and renews expired codes through **Refresh QR code**. After confirmation the bot card replaces it. **Check connection** retains the existing login; **Scan again** begins replacement login. The capability travels in an Authorization header, and status responses never include the bot token. The original `/weixin/login?key=<key>` page remains available for manual setup.

Each bot card offers **Check connection**, **Pause / Resume**, **Remove bot** and **More settings**. For manually bound Feishu/QQ bots, credential checks request a provider token and report **Credentials verified**; HTTP callback setup must still be completed in the provider console. QR-created bots report the actual WebSocket connection state. Expired or declined authorization can be refreshed, and **Cancel** stops the current attempt. Cancelled or failed replacements preserve the existing QR account. Pausing, reloading or rotating the management key preserves completed bindings; unfinished attempts are cancelled on reload. QR credentials are held in the channel's environment storage and never returned by management routes or configuration forms. WeChat displays its actual iLink login status. Removing a bot clears its credentials and IM conversation bindings while preserving the native AI Sessions. Pausing preserves its credentials and bindings.

In **More settings → General**, edit the bot alias, workspace, Agent Preset and reply length. The workspace must be an existing directory; create it in Weft's workspace first if needed. Workspace and preset changes apply to newly created Sessions (send `/new` in an existing chat). **Access** edits the allowed-user list. The header's **General settings** sets the shared Agent Preset fallback and Session title prefix.

New IM Sessions use the native content-based automatic title, labeled `微信 · …`, `飞书 · …` or `QQ · …`, instead of pinning a raw chat/user ID. In the Session tree and search results, the loaded channel logo replaces the visual text prefix; the full title remains accessible, searchable and editable. Native status dots and row actions are preserved. Disabling the title-prefix option applies to new Sessions. Older `[weixin]`, `[feishu]` and `[qq]` titles also receive logos; their pinned titles remain editable, or send `/new` to start with automatic titles. The title decorator ignores inherited prompts in Web forks. Disabling the bundle removes its visual decoration and restores the plain text prefixes.

This Worker version connects one bot per channel and supports Feishu, WeChat and QQ. All three support QR setup; Feishu/QQ retain manual credentials and HTTP callbacks as an alternative. The Worker uses standard fetch, WebCrypto and the existing approved WebSocket egress, without requiring the reference project's Node SDK runtime. QR-created Feishu apps request only the text-message scopes and message events handled by this plugin. Secret inputs are write-only: leaving them blank preserves saved credentials. Existing per-entry configuration forms remain available for advanced settings.

中文操作：从左侧选择渠道。微信、飞书和 QQ 均可点击「扫码接入机器人」，飞书／QQ 也保留「手动接入」；接入后在机器人卡片上检查连接、暂停／恢复或移除。通过「更多设置」修改别名、工作区、Agent Preset、消息处理、访问权限与上下文增强；右上角齿轮打开通用设置。每个渠道当前支持一个机器人。飞书／QQ 扫码后通过长连接收消息，无需配置 HTTP 回调；只有手动接入需要在平台后台配置回调。飞书仍需按平台要求确认权限、发布或审批。扫码凭据仅保存在服务端，取消或失败不会覆盖已有绑定。

升级 0.4.0 前须先部署配套的 Weft 版本：飞书的二进制长连接依赖本次 Host 网络转发修正，模型设置依赖新增的原生目录与会话模型接口；仅更新旧 Host 上的插件包不足以启用这些能力。机器人选择模型不会改写全局默认模型。

0.3.1 会根据聊天内容自动生成新会话标题，保留原生标题更新，并附加「微信／飞书／QQ」标识；会话列表和搜索结果用渠道图标显示该标识，状态提示、无障碍名称和重命名保持可用。旧会话的渠道前缀也支持图标，但旧版固定的 ID 标题需手动修改，或发送 `/new` 使用自动标题。标题前缀开关只影响新会话；升级插件后刷新工作台生效。

## Validation

Build with `npm run build`; run the backend bridge, management and native title tests with `npx tsx --test tests/im-plugin.test.ts tests/im-qr.test.ts tests/im-session-titles.test.ts`. Run the real installed Client module, provider-fixture checks, Session tree/search and desktop/mobile browser flow with `WEFT_BROWSER_IM=1 npx playwright test tests/browser/im-plugin.spec.ts`. These tests use simulated providers, not real IM accounts.

The `Test` workflow runs the IM backend test in its unit shards and the IM setup browser regression as a dedicated step in Browser 1/2.

Only text messages are handled in this version.
