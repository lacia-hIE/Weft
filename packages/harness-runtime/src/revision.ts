import upstream from '../../../upstream.lock.json';

/**
 * Exact source transitions reviewed against the V4 log, preset and tool contracts.
 * DSH 0.2.2-rc.1 changes the Loader, tool executor, Schedule and preset contracts,
 * so no earlier source is admitted: documents published under 0.2.1 keep their
 * provenance and readable history but do not run on this runtime.
 */
const reviewedSources:Readonly<Record<string,readonly string[]>>={};
export function supportsAgentRuntime(source:string):boolean {
  return source===upstream.commit || reviewedSources[upstream.commit]?.includes(source)===true;
}
