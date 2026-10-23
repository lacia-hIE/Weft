import {PluginRegistry} from '../../plugin-registry/src/catalog.ts';
import {workerPluginBundles} from '../../worker-plugins/src/catalog.ts';

/** The audited deployment catalog. Adding a bundle does not change the host's control paths. */
export const environmentPlugins = new PluginRegistry([...workerPluginBundles]);
