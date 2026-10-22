declare module '*/.generated/official-profile.mjs' {
  export const officialProfile: readonly import('@deepseek-ai/cordis-plugin-loader').EntryOptions[];
  export function walkEntries(entries: typeof officialProfile, visit: (entry: import('@deepseek-ai/cordis-plugin-loader').EntryOptions, groups: readonly string[]) => void): void;
  export function overlayProblems(): string[];
  export function enabledEntries(): {id: string}[];
  export function enabledModuleNames(): string[];
}
