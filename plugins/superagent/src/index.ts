/** Main plugin entry: mounts the Runtime and its low-frequency background pass. */
import type { Context } from '@deepseek-ai/cordis'
import { Runtime, type HostContext } from './app/runtime.ts'
import { Config, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['weftSql', 'sessionController', 'weftSessionEvents', 'weftManagedSessions', 'tools', 'webServer', 'fs', 'timer', 'weftIm']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  // A saved repository takes effect by building the Runtime again; all of its state is in the Store. A plugin cannot restart its own fiber here.
  let restarting: Promise<void> | undefined, cancelTimer: (() => void) | undefined, period = 0
  const schedule = () => {
    const next = runtime.wakePeriod()
    if (next === period) return
    cancelTimer?.();period = next
    cancelTimer = (ctx as unknown as {timer: {interval(callback: () => unknown, delay: number): () => void}}).timer.interval(() => runtime.tick(), next * 1000)
  }
  const start = (): Runtime => new Runtime(ctx as unknown as HostContext, config, () => {
    restarting ??= (async () => { await runtime.stop(); runtime = start(); await runtime.ready; schedule() })()
      .catch((error: unknown) => { console.error('dsh-superagent restart failed:', String(error)) }).finally(() => { restarting = undefined })
  }, schedule)
  let runtime = start()
  ctx.effect(() => () => {cancelTimer?.(); return runtime.stop()}, 'superagent: runtime')
  // A persistent plan, restored by the Host, not a JavaScript timer: the environment hibernates between passes.
  await runtime.ready
  schedule()
}
export * from './core/index.ts'
