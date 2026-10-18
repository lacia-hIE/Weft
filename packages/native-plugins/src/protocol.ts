/** Explicit asynchronous filesystem capability shared by host, isolate and inspection. */
export const nativePluginFsMethods = ['resolve', 'stat', 'lstat', 'readText', 'readBytes', 'readByteRange', 'listDir', 'writeText', 'editText'] as const;
