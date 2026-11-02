/** Main plugin entry: mounts the Runtime and its low-frequency background pass. */
import type { Context } from '@deepseek-ai/cordis'
import { Runtime, type HostContext } from './app/runtime.ts'
import { Config, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['weftSql', 'sessionController', 'weftSessionEvents', 'weftManagedSessions', 'tools', 'webServer', 'fs', 'timer']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const restart = (): void => { void ctx.fiber.restart().catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) }) }
  const runtime = new Runtime(ctx as unknown as HostContext, config, restart)
  ctx.effect(() => () => runtime.stop(), 'superagent: runtime')
  // A persistent plan, restored by the Host, not a JavaScript timer: the environment hibernates between passes.
  ;(ctx as unknown as { timer: { interval(callback: () => unknown, delay: number): unknown } }).timer.interval(() => runtime.tick(), config.reconcileSeconds * 1000)
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export * from './core/index.ts'
