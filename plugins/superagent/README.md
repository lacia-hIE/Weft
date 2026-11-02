# @weft/dsh-superagent

A proactive agent for one GitHub repository, adapted to Weft's Worker Host from the [dsh-superagent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype). When someone allowed asks it for work, it opens a Ticket, works on it in its own Session and directory, and answers in the original conversation. The panel lists what needs a person.

Upstream calls the prototype research code, and so is this adaptation at 0.x. Review it before use.

## Setup

1. Install it from **Plugins** and approve files, tools, timers, HTTPS, plugin state, Session management, the public route and background running.
2. In the plugin's settings, fill in **githubToken**: a token of the agent's GitHub account, limited to one repository, without merge rights.
3. In the **Superagent** panel, name the repository on the GitHub Source and list who may start work under Policy. The Agent acts only on them.
4. Optional, for prompt reactions: add a repository webhook for `https://<your-domain>/v1/plugin-hooks/<tenant>/<environment>/%40weft%2Fdsh-superagent/github` with a secret, and fill in **webhookSecret**. `/v1/plugin-hooks/*` needs a Cloudflare Access Bypass. Without a webhook the Source polls on the background pass, every five minutes by default.

## How it runs here

- All orchestration lives in the environment's plugin facet, and its state in the facet's SQLite. The environment hibernates between webhooks, turn ends, tool calls and the background pass.
- Executors use whatever the environment's settings allow: the Worker shell, with no git or test run, or a container the agent switches to where allowed. Without a container, give them a GitHub MCP server under **mcp-servers** to read and write the repository; its token stays out of their reach. Passing CI is then their only check of a change.
- New Sessions run under `danger-full-access` by default, as an executor works unattended and an approval would stall it. Change it under Execution. Sessions in an environment share its files and container, so a worker can reach other projects there. Run the plugin in its own environment if that matters; the Policy's written rules and a narrow token are the limits that remain.

See [PARITY.md](PARITY.md) for what differs from the prototype.
