/** Worker Host services retain the original injection keys and Remote method names. */
export const workerHostServices = ['fs', 'tools', 'timer', 'storage', 'storageDomain', 'sessionController', 'credentials'] as const;
export const environmentHostServices = ['storage', 'storageDomain', 'sessionController', 'credentials'] as const;
export type WorkerService = typeof workerHostServices[number];
export const sessionMethods = ['create', 'prompt', 'cancel', 'rename', 'page', 'projections', 'list'] as const;
