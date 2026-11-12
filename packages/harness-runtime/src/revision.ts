import upstream from '../../../upstream.lock.json';

/**
 * Exact source transitions reviewed against the V4 log, preset and tool contracts.
 * DSH 0.2.2-rc.2 reads every 0.2.2-rc.1 log in place: its persistence changes add
 * the `team/mode` selection, retry and settlement attribution, and named subagent
 * catalogs, each readable from earlier records. Sessions created under rc.1 keep
 * their revision and continue on rc.2. 0.2.1 sources remain refused.
 */
const reviewedSources:Readonly<Record<string,readonly string[]>>={
  // dsh-v0.2.2-rc.2 ← dsh-v0.2.2-rc.1
  ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c:['66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db'],
};
export function supportsAgentRuntime(source:string):boolean {
  return source===upstream.commit || reviewedSources[upstream.commit]?.includes(source)===true;
}
