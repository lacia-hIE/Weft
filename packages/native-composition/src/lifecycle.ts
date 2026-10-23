import type {Context} from '@deepseek-ai/cordis';
import {workerdLoader} from '../../native-profile/src/loader.ts';
import {PluginCoordinator} from '../../plugin-registry/src/lifecycle.ts';
import {loaderDriver} from '../../plugin-registry/src/host.ts';
import type {PluginPlan} from '../../plugin-registry/src/types.ts';
import {environmentHostModules} from './modules.ts';

/** Mount the audited Host modules through the same lifecycle used for native profile rows. */
export async function mountEnvironmentPlugins(ctx: Context, initial: PluginPlan) {
  const loader = await workerdLoader(ctx, environmentHostModules);
  const coordinator = new PluginCoordinator(loaderDriver(loader));
  const reconcile = (plan: PluginPlan) => {
    const entries = plan.entries.filter(row => row.target === 'host');
    for (const row of entries) if (!Object.hasOwn(environmentHostModules, row.name)) throw new Error('Unregistered Host module: '+row.name);
    return coordinator.reconcile({entries});
  };
  ctx.effect(() => () => coordinator.dispose(), 'weft.environment-plugins');
  await reconcile(initial);
  return reconcile;
}
