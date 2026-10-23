import * as JavaScript from '../../native-computer/src/plugin.ts';
import * as Documents from '../../native-documents/src/plugin.ts';
import * as TaskSandbox from '../../worker-plugins/src/sandbox.ts';

/** Immutable trusted module table; runtime configuration never supplies executable code. */
export const environmentHostModules = Object.fromEntries([JavaScript, Documents, TaskSandbox].map(plugin => [plugin.name, plugin]));
