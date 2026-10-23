import * as TaskManagement from './worker-tasks.ts';
import {TaskCards} from './worker-tasks.ts';

/** Trusted client modules. Native bundle/profile declarations select their entries. */
export const environmentClientModules: Record<string, object> = {
  [TaskManagement.name]: TaskManagement,
  [TaskCards.name]: TaskCards,
};
