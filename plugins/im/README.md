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

`sessionController`, `storageDomain` and `webServer`, plus outbound HTTPS. In Weft the bundle runs as an environment Host: approve network access when reviewing it, then configure each entry on its Plugins page. Routes are served at `/v1/plugin-hooks/<tenant>/<environment>/@weft%2Fdsh-im/<path>`.

## Channel setup

- **Feishu**: create a self-built app with the bot capability and `im:message` permissions; set App ID / App Secret, and the Verification Token and Encrypt Key from *Events and Callbacks*. Subscribe to `im.message.receive_v1` with the `/feishu` route as the request URL. In groups the bot answers when mentioned.
- **QQ**: set AppID / AppSecret and use the `/qq` route as the callback URL; the route answers the platform's validation request. Subscribe to C2C and group @ message events.
- **WeChat**: set a long random login key, open `/weixin/login?key=<key>` and scan with the WeChat account that will act as the bot. When the login expires the page offers a new code.

Only text messages are handled in this version.
