/** Optional policies whose removal does not remove a service required by the host. */
export const MANAGEABLE_PROFILE_ROWS = [
  'llm-retry', 'session-title-llm', 'repeat-tool-reminder', 'command-feedback',
] as const;

export type ProfileEnablement = Record<string, boolean>;
export const isManageableProfileRow = (id: string): boolean => (MANAGEABLE_PROFILE_ROWS as readonly string[]).includes(id);
