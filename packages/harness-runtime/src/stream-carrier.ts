/** Passive native feeds that can restore their own baseline after hibernation. */
export function passiveNativeStream(endpoint: string): boolean {
  return ['$events', 'session/follow', 'session/control', 'workspace/follow', 'remoteAccess/follow', 'job/list'].includes(endpoint);
}
