export const RELEASE_REPOSITORY: string;
export const RELEASE_ENVIRONMENT: string;
export const RELEASE_WORKFLOW: string;
export function assertReleaseRun(run: unknown, sha: string): void;
export function assertReleaseJobs(jobs: {name: string; conclusion: string}[], engines: string): void;
export function inspectReleaseTarball(bytes: Uint8Array, expected: unknown, sourceFile?: (name: string) => Uint8Array): {name: string; version: string; sha256: string; tag: 'next' | 'latest'};
