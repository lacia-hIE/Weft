/**
 * Passive native feeds that can restore their own baseline after hibernation.
 * `terminal/watch` (DSH 0.2.2-rc.2's sidebar terminal roster) yields the whole
 * current set first, so a cold wake restores it like `job/list`.
 */
export function passiveNativeStream(endpoint: string): boolean {
  return ['$events', 'session/follow', 'session/control', 'workspace/follow', 'remoteAccess/follow', 'job/list', 'terminal/watch'].includes(endpoint);
}
