import type { Context, Fiber } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceRuntimeGuide } from './container-policy.ts';

/** Where an environment runs commands: always the Worker shell, always the container, or as the agent chooses. */
export type WorkspaceShell = 'worker' | 'container' | 'auto';
type Target = 'worker' | 'container';


const DESCRIPTION = 'Choose where your shell commands run for the rest of this session. '
  + '"worker" (the default) is an instant shell with common Unix tools but no git, node, npm or python. '
  + '"container" is a full Linux machine with git, node 22, npm, python 3 and ripgrep, real PTYs and interactive stdin; it takes a few seconds to start and sleeps after 10 idle minutes. '
  + 'Source and .git in /workspace persist. Container dependencies and caches (including node_modules and .venv) are local-only, invisible to Worker/file tools, and must be rebuilt after the container is replaced. '
  + 'Synced files have a 256 MiB per-file limit; prefer shallow clones when full history is unnecessary. '
  + 'Switch to the container when a task needs those programs, and back to the worker when it no longer does.';

/**
 * The environment's command location, including the agent's own choice when
 * the environment leaves it to the agent: while the setting is `auto` the
 * world offers a tool that switches between the Worker shell and the
 * container, and commands follow the last switch.
 */
export class WorkspaceRuntimeChoice {
  private chosen: Target;
  private tool: Fiber | undefined;

  constructor(private readonly ctx: Context, private readonly storage: DurableObjectStorage, private readonly shell: () => WorkspaceShell) {
    // The agent's choice under `auto`, kept with the Session's world so it survives a cold host.
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_runtime_choice (id INTEGER PRIMARY KEY CHECK (id = 1), target TEXT NOT NULL)');
    this.chosen = storage.sql.exec<{target: string}>('SELECT target FROM weft_runtime_choice WHERE id = 1').toArray()[0]?.target === 'container' ? 'container' : 'worker';
    ctx.systemPrompt.context({
      name: 'weft:workspace-runtime', order: 112, required: true, interpolate: false,
      text: () => workspaceRuntimeGuide(this.shell(), this.container()),
    });
  }

  /** Whether commands run in the container now. */
  container(): boolean {
    const shell = this.shell();
    return shell === 'container' || (shell === 'auto' && this.chosen === 'container');
  }

  /** Offer the switch tool exactly while the setting is `auto`; run before each turn. */
  async reconcile(): Promise<void> {
    const offered = this.shell() === 'auto';
    if (offered === (this.tool !== undefined)) return;
    if (this.tool) {
      const tool = this.tool;
      this.tool = undefined;
      await tool.dispose();
      return;
    }
    this.tool = this.ctx.plugin({inject: ['tools'], apply: (ctx: Context) => {
      ctx.tools.register(defineTool({
        name: 'workspace_runtime',
        description: DESCRIPTION,
        parameters: {target: {type: 'string', required: true, enum: ['worker', 'container'], description: 'Where later commands run.'}},
        output: {
          schema: {type: 'object', properties: {target: {type: 'string', required: true}, previous: {type: 'string', required: true}}, additionalProperties: false},
          render: (_args, value) => [{type: 'text', text: value.target === value.previous
            ? `Commands already run in the ${value.target}.`
            : `Commands now run in the ${value.target}${value.target === 'container' ? '; the first one may take a few seconds while it starts' : ''}.`}],
        },
        execute: async ({target}) => {
          const previous = this.chosen;
          this.chosen = target === 'container' ? 'container' : 'worker';
          this.storage.sql.exec('INSERT INTO weft_runtime_choice VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET target = excluded.target', this.chosen);
          return {target: this.chosen, previous};
        },
      }));
    }});
    await this.tool.await();
  }
}
