/**
 * npm records the application's version twice in the root lockfile. Neither is
 * an input to the container bundles. Normalize only these two fields, retaining
 * every dependency, integrity, engine and other build-related field.
 *
 * The historical 0.0.1 marker preserves existing reviewed image identities when
 * the application version alone changes; it is not the application's version.
 */
export function workspaceDependencyLock(bytes) {
  const lock = JSON.parse(bytes.toString());
  lock.version = '0.0.1';
  if (lock.packages?.['']) lock.packages[''].version = '0.0.1';
  return JSON.stringify(lock, null, 2) + '\n';
}
