import {z} from 'zod';

/** Worker-supported permission presets for a plugin's newly created Session. */
export const initialSessionPermissionSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
