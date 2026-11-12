import type {Context} from '@deepseek-ai/cordis';
import TeamService from '@deepseek-ai/dsh-agent-team';
import * as TeamTools from '@deepseek-ai/dsh-tool-agent-team';

const mounted = new WeakSet<Context>();

/**
 * Agent Teams ships in the official base bundle: `agent-team` (`maxTasks: 256`)
 * and the root `tool-agent-team` row. Team mode is a saved selection on each
 * root Session that defaults off, so mounting both changes nothing until a user
 * enables it from the conversation menu. The trusted service owns the native
 * persisted task board; the tools register only while Team mode is on.
 */
export async function mountOfficialTeam(ctx: Context): Promise<void> {
  if (mounted.has(ctx)) return;
  mounted.add(ctx);
  await ctx.plugin(TeamService, TeamService.Config({maxTasks: 256}));
  await ctx.plugin(TeamTools, TeamTools.Config({}));
}
