# Parity with dsh-superagent

Against [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) at commit `6337fc8`. Later upstream changes are not covered.

| Area | State here |
| --- | --- |
| Domain core, Policy, Eval, Tickets, Outbox | Kept as written; the core's specs run in CI |
| Legacy GitHub Source | Same reads and Trigger ids over REST instead of `gh`; a webhook wakes a poll round instead of a fixed loop |
| Feishu Source | Through a dsh-im bot assigned with `weftIm` instead of `lark-cli`: same Triggers, scope, Policy part and topic replies; Assessments read the topic, or the newest page of a chat without topics. Chat history backfill, chat name refresh, member sync and images are not ported; a message that arrives while dsh-superagent is inactive is delivered again by dsh-im's connection |
| WeChat, QQ and email Sources | New: one Thread per chat (per conversation for email), direct messages and QQ group mentions, replies through the same dsh-im bot |
| Independent repository Sources | Multiple GitHub Webhook, GitLab and RSS/Atom instances; independent private credentials, progress and transport health; feed observations remain weaker than verified requests |
| Execution placement | Fixed user targets or explicit main-Session selection from paired computers, including queued offline work; existing tasks retain placement |
| Collaboration context | Versioned scoped notes maintained from allowed human requests or retained Assignment reports; panel editing and snapshot restore; no automatic core role or Policy changes |
| Worker tools | Kept; scoped to the Sessions configured with them |
| Prompts | Kept; `prepare` is an instruction to the worker, since an environment plugin runs no process |
| Agent presets | Cloud Sessions use the environment default. Local DSH workers use the native Agent preset selected on their computer |
| Tool limits on Sessions | Kept: the main Session and workers keep the prototype's lists, plus MCP tools and the switch to a container for workers; subagents keep a worker's list; an ended Ticket's worker keeps none. A list takes effect at the next turn, so a worker that ends its own Ticket keeps it for the rest of that turn. `subagent` is an Agent's own tool and stays on every list, as in the prototype, also after a Ticket ended |
| The main Session's wait guard, and moving a command to the background after five seconds | Not ported: a guard runs in the Session and this plugin in the environment, and a plugin adds no presets here. A long command delays a person's message until the worker's next step |
| Blocked commands and account shims | Removed; they rely on a local OS account |
| Background jobs and subagent slots | Not tracked: a worker's slot ends with its turn. Subagents see their worker's instructions |
| Notices without waking the main Session | Held and sent with its next message |
| Model budget retries in health | Not ported |
| Container credentials | Not provided: a worker that switches to the container has no `git push` credential from this plugin |
| Migration from prototype databases | Not provided |
