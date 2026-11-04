# @weft/dsh-superagent

A proactive agent for one GitHub repository, adapted to Weft's Worker Host from the [dsh-superagent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype). When someone allowed asks it for work, it opens a Ticket, works on it in its own Session and directory, and answers in the original conversation. The panel lists what needs a person.

Upstream calls the prototype research code, and so is this adaptation at 0.x. Review it before use.

## Setup

1. Install it from **Plugins** and approve files, tools, timers, HTTPS, plugin state, Session management, the public route and background running.
2. Create a dedicated GitHub account for the agent and add it only to the target repository, public or private, with Write access. Protect the default branch: Write access can otherwise merge.
3. In the **Superagent** panel, under Settings → Deployment, fill in its classic token with the `repo` and `notifications` scopes. A fine-grained token cannot read notifications, which is how the Source learns it was addressed, and a GitHub App is no user with notifications. The token reaches every repository the account can.
4. Under Settings → Sources, name the repository, and under Eval list who may start work under Policy. The Agent acts only on them.
5. Optional, for prompt reactions: under Settings → Deployment, generate a webhook secret and copy it, the URL and the content type into the repository's Add webhook page, which takes admin rights there. `/v1/plugin-hooks/*` needs a Cloudflare Access Bypass. A delivery reads only the Issue or PR it names, and only when that concerns the agent (a followed Thread, a Ticket's PR, or a mention of the agent's account); full rounds, which read notifications, run on the background pass at most as often as GitHub's poll interval allows, every five minutes by default. Without a webhook the Source relies on those rounds alone.

## IM Sources

Besides GitHub, requests can come from Feishu, WeChat, QQ and email bots of `@weft/dsh-im`. In dsh-im, open a bot's **More settings → General → Assign to plugin** and choose `@weft/dsh-superagent`; then, under Settings → Sources here, enable the channel's Source and enter the bot's key (`feishu` for the first Feishu bot, `feishu_0a1b2c` for an added one). List who may start work under the Source's Policy. A direct message or a mention of the bot from someone on the list is an explicit request; the Feishu Source also observes whole chats set to "All". Replies go out through the bot that received the request, in the message's topic on Feishu. Ticket work still lands in the GitHub repository, so the GitHub setup above remains required.

## How it runs here

- All orchestration lives in the environment's plugin facet, and its state in the facet's SQLite. The environment hibernates between webhooks, turn ends, tool calls and the background pass.
- Executors use whatever the environment's settings allow: the Worker shell, with no git or test run, or a container the agent switches to where allowed. Without a container, give them a GitHub MCP server under **Settings → MCP servers** (its GitHub preset fills in the hosted server) to read and write the repository; its token, which may be fine-grained and limited to the repository, stays out of their reach. Passing CI is then their only check of a change.
- New Sessions run under `danger-full-access` by default, as an executor works unattended and an approval would stall it. Change it under Execution. Sessions in an environment share its files and container, so a worker can reach other projects there. Run the plugin in its own environment if that matters; the Policy's written rules and a narrow token are the limits that remain.

See [PARITY.md](PARITY.md) for what differs from the prototype.

## Local execution computers

Under **Settings → Execution**, register an execution computer and copy its one-time pairing code. On that computer,
install DSH and `@laciaproject/dsh-local-host` 0.3.0, open **Superagent Executor** in the plugin's settings, paste the code,
and choose an absolute task root and optionally a local Agent preset. Pairing starts with task acceptance paused;
enable it explicitly on the computer. Configure its model provider locally. Use a dedicated DSH profile and agent
credentials; a directory or profile does not isolate an OS account.

Select that computer as the default execution location and save. Only new Tickets use the new location; existing
Tickets retain their executor. Each runs a full native DSH Agent in a persistent Session and its own directory.
Ticket, Policy, Sources and original-conversation delivery remain in this Weft environment. There is no second
Superagent or separately registered local environment. Local Workers get only their Assignment's executor tools,
including bounded source reads, acknowledgements, reports and handbacks; they never get the router tools or cloud
model credentials. Local model and permission presets take precedence over cloud execution settings.

The computer connects outbound over HTTPS to the plugin's existing `/v1/plugin-hooks/*` public routes; no inbound
local port or additional Access Bypass is needed. The first carrier polls every 15 seconds, sooner after dispatch;
there is no persistent Cloudflare request waiting on a model turn. Commands, receipts and reports survive reconnects.
An offline computer keeps already accepted work; Weft never automatically moves it to another computer. Local DSH
restart during work reports failure; Retry creates a new Assignment in the retained Session and directory. Stopping a
Ticket remains pending until the computer confirms its turn and jobs stopped. Revoking a computer blocks cloud
access but does not remotely kill disconnected processes. Native spawn/fork subagents inherit the Assignment tool limits and the native delegated permission policy.
Only the root worker may report or change the cloud Ticket; children may read its bounded context.
Local DSH controls delegation depth and concurrent children. The carrier tracks durable child catalogs,
drains the entire native tree and its processes before acknowledging stop, and releases the root Agent handle
so Retry can resume its retained Session with fresh admission. Restart reconciliation preserves child history
and requires an explicit Retry instead of replaying unfinished child prompts. Ordinary shell jobs use native DSH job delivery. Tests still follow the repository's CI policy.

The 0.3.0 sources add this mode; the previously published 0.2.7 connector supports remote workbench access only.
