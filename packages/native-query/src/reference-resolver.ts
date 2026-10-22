import type {Agent} from '@deepseek-ai/dsh-agent';
import SessionReferenceResolver, {DEFAULT_CANDIDATE_LIMIT, type Config, type SessionReferenceCandidate} from '@deepseek-ai/dsh-session-reference';
import type {Context} from '@deepseek-ai/cordis';
import type {SessionReferenceSummary} from './reference-metadata.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {weftSessionReferenceSummaries: Map<string, SessionReferenceSummary>;}
}

/** Keep original ranking, mention encoding and exact reference preparation.
 * Cross-object discovery labels come from the owner's bounded, read-only folds.
 */
export class NativeSessionReferenceResolver extends SessionReferenceResolver {
  private readonly candidateLimit: number;
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, config);
    this.candidateLimit = config.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  }
  override async listCandidates(agent: Agent, query = '', limit = this.candidateLimit, signal?: AbortSignal): Promise<SessionReferenceCandidate[]> {
    // The original validates the limit; collect its ranked rows before applying
    // summary visibility and title matching so blank rows cannot consume the cap.
    if (!Number.isSafeInteger(limit) || limit <= 0) return super.listCandidates(agent, query, limit, signal);
    const ranked = await super.listCandidates(agent, '', Number.MAX_SAFE_INTEGER, signal);
    const needle = query.toLocaleLowerCase();
    return ranked.flatMap(candidate => {
      const summary = this.ctx.weftSessionReferenceSummaries.get(candidate.sessionId);
      if (!summary || summary.blank) return [];
      const label = summary.title ?? candidate.sessionId;
      const displayTitle = summary.label ?? label;
      if (needle && ![candidate.sessionId, candidate.cwd ?? '', label, displayTitle].some(value => value.toLocaleLowerCase().includes(needle))) return [];
      return [{...candidate, label, displayTitle}];
    }).slice(0, limit);
  }
}
