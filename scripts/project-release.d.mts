export function releaseIdentity(version: unknown): {tag: string; prerelease: boolean};
export function assertProjectCI(run: unknown, jobs: {name: string; conclusion: string}[], expected: {repository: string; sha: string; dsh: string}): void;
