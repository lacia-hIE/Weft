# @weft/dsh-im

Connects Feishu, WeChat and QQ conversations to DeepSeek Harness Sessions. It is a standard Cordis bundle (`dsh.bundle.patch`) with four entries:

| Entry | Role |
|---|---|
| `im-core` (`@weft/dsh-im/core`) | The `im` service: one Session per conversation, deduplicated prompts, `/new` `/stop` `/help`, and delivery of each finished turn from a durable cursor |
| `im-feishu` | Feishu / Lark event subscription at `/feishu`, replies through the open platform message API |
| `im-weixin` | WeChat iLink: QR login at `/weixin/login?key=…`, long-polled messages, replies with the user's context token |
| `im-qq` | QQ official bot HTTP callback at `/qq` (Ed25519), passive replies to C2C and group @ messages |

Channels inject `im`; other plugins can do the same to add a channel. Every channel is disabled until its entry is configured, and only listed senders may talk to the bot (WeChat also admits the account that scanned the login code). An unlisted sender is told their id so an administrator can add it.

## Host services

`sessionController`, `storageDomain` and `webServer`, plus outbound HTTPS. In Weft the deployment ships this bundle: install it from the Plugins page (no npm registry is used), then approve its browser module, network, routes, persistent storage, sessions and environment background access. Open **Settings → IM bots** (中文：**设置 → IM 机器人**) or the bundle detail page to configure channels.

The page follows [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im): the channel rail leads to an empty-state introduction, QR or credential binding, a bot card, and **More settings → General / Access**. The brand header, channel logos, surfaces, QR instructions, status indicators and responsive layout are adapted from that project's UI. See [third-party notices](THIRD_PARTY_NOTICES.md) for its MIT license and source revision.

If upgrading from 0.1.0 or 0.2.0, build an update to **0.3.0** in the plugin's bundle review, approve the new artifact with browser module access, then refresh the workbench. Channel configuration and the connected WeChat account persist across this update. The settings page and stylesheet unload when the bundle is disabled or removed.

Routes are served at `/v1/plugin-hooks/<tenant>/<environment>/@weft%2Fdsh-im/<path>`.

## Channel setup

- **Feishu**: choose **Manual setup**, select Feishu or Lark, enter App ID / App Secret and the Verification Token / optional Encrypt Key from *Events and Callbacks*, then click **Bind bot**. Enable the app's bot capability and `im:message` permissions; subscribe to `im.message.receive_v1` with the page's callback URL, then publish the app. In groups the bot answers when mentioned.
- **QQ**: choose **Manual setup**, enter AppID / AppSecret and click **Bind bot**. Set the displayed HTTP callback URL in the QQ developer platform and subscribe to C2C and group @ message events. The route answers the platform's validation request.
- **WeChat**: choose **Connect with QR**, scan the displayed code with the WeChat account that will act as the bot and confirm on your phone. The QR card shows the scan steps and renews expired codes through **Refresh QR code**. After confirmation the bot card replaces it. **Check connection** retains the existing login; **Scan again** begins replacement login. The capability travels in an Authorization header, and status responses never include the bot token. The original `/weixin/login?key=<key>` page remains available for manual setup.

Each bot card offers **Check connection**, **Pause / Resume**, **Remove bot** and **More settings**. Credential checks for Feishu/QQ request a provider token and report **Credentials verified**; HTTP callback setup must still be completed in the provider console. WeChat displays its actual iLink login status. Removing a bot clears its credentials and IM conversation bindings while preserving the native AI Sessions. Pausing preserves its credentials and bindings.

In **More settings → General**, edit the bot alias, workspace, Agent Preset and reply length. The workspace must be an existing directory; create it in Weft's workspace first if needed. Workspace and preset changes apply to newly created Sessions (send `/new` in an existing chat). **Access** edits the allowed-user list. The header's **General settings** sets the shared Agent Preset fallback and Session title prefix.

This Worker version connects one bot per channel and supports Feishu, WeChat and QQ. Feishu/QQ QR app provisioning and the reference project's Node SDK long connections are not included; their cards explicitly identify the HTTP callback transport. Secret inputs are write-only: leaving them blank preserves saved credentials. Existing per-entry configuration forms remain available for advanced settings.

中文操作：从左侧选择渠道。微信点击「扫码接入机器人」，飞书／QQ 点击「手动接入」并填写凭据；接入后在机器人卡片上检查连接、暂停／恢复或移除。通过「更多设置 → 通用／访问设置」修改别名、工作区、Agent Preset 和白名单；右上角齿轮打开通用设置。每个渠道当前支持一个机器人，飞书／QQ 仍需在平台后台配置 HTTP 回调。

## Validation

Build with `npm run build`; run the backend bridge and management tests with `npx tsx --test tests/im-plugin.test.ts`. Run the real installed Client module, provider-fixture checks and desktop/mobile browser flow with `WEFT_BROWSER_IM=1 npx playwright test tests/browser/im-plugin.spec.ts`. These tests use simulated providers, not real IM accounts.

The `Test` workflow runs the IM backend test in its unit shards and the IM setup browser regression as a dedicated step in Browser 1/2.

Only text messages are handled in this version.
