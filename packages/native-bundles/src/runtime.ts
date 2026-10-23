import type {Context} from '@deepseek-ai/cordis';
import TeamService from '@deepseek-ai/dsh-experimental-agent-team';
import type {AgentRevision} from '../../control-plane/src/contracts.ts';

/** Trusted Team service owns actual Agents and their native persisted logs. */
export async function mountOfficialTeam(ctx: Context, profiles: readonly AgentRevision[]): Promise<void> {
  const row = profiles.flatMap(profile => profile.spec.plugins).find(row => row.id === 'agent-team' && !row.disabled);
  if (row && !ctx.get('agentTeams')) await ctx.plugin(TeamService, TeamService.Config(row.config));
}
