import upstream from '../../../upstream.lock.json';

/** Exact source transitions reviewed against the V4 log, preset and tool contracts.
 * This permits retained alpha.4 and rc.2 documents on rc.3, without rewriting
 * their provenance or allowing arbitrary old/new Host protocol versions.
 */
const reviewedSources:Readonly<Record<string,readonly string[]>>={
  '1f81c047fc48fa190a683e469daa699857e9afe8':['86a402200d95fecef4529d969836f1fe13c6cb0d','687f282e8625c6b8d11ff58211a90524be2e4317'],
};
export function supportsAgentRuntime(source:string):boolean {
  return source===upstream.commit || reviewedSources[upstream.commit]?.includes(source)===true;
}
