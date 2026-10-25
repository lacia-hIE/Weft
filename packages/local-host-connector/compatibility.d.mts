export const SUPPORTED_DSH_VERSIONS: readonly string[];
export const LOCAL_HOST_BUNDLE: string;
export function supportsDshVersion(version: unknown): version is string;
