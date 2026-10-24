import upstream from '../../../upstream.lock.json';

/** Exact source transitions reviewed against the V4 log, preset and tool contracts.
 * This permits retained alpha.4 preset documents on rc.2, without rewriting
 * their provenance or allowing arbitrary old/new Host protocol versions.
 */
const reviewedSources:Readonly<Record<string,readonly string[]>>={
  '687f282e8625c6b8d11ff58211a90524be2e4317':['86a402200d95fecef4529d969836f1fe13c6cb0d'],
};
export function supportsAgentRuntime(source:string):boolean {
  return source===upstream.commit || reviewedSources[upstream.commit]?.includes(source)===true;
}
