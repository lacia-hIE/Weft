import type { Context, Fiber } from '@deepseek-ai/cordis';
import * as WorkspaceChanges from '@deepseek-ai/dsh-workspace-changes';
import * as Deliverables from 'weft:official-deliverables';
import type { ConnectionFetchRoute } from '@weft/upstream/packages/client/connection/src/rpc.ts';
import type {} from '../../native-attachments/src/index.ts';

/** Host services the deliverables routes name that a Weft deployment has no desktop for. */
const DESKTOPLESS = ['connection', 'sessionController', 'sessionQuery', 'workspaceFiles'] as const;
const noDesktop = () => { throw new Error('This deployment has no Host desktop'); };

/**
 * The official deliverables Host half: change summary and comparison routes
 * and the file-reference guidance. Its routes join the Session's
 * authenticated fetch routes; its desktop-open routes answer that no Host
 * desktop is available, as the original does on a headless Host, so the
 * services behind them are never reached.
 */
function DeliverablesHost(ctx: Context): void {
  ctx.provide('connection', {fetch: {register: (route: ConnectionFetchRoute) => ctx.effect(() => ctx.weftConnectionRoutes.register(route))}});
  ctx.provide('sessionController', {
    workspaceDesktop: () => ({name: 'Cloudflare', available: false, fileManager: null}),
    workspacePathApplications: noDesktop, openWorkspacePath: noDesktop,
  });
  ctx.provide('sessionQuery', {readEvent: noDesktop});
  ctx.provide('workspaceFiles', {stat: noDesktop});
  ctx.plugin(Deliverables);
}
DeliverablesHost.inject = ['weftConnectionRoutes'];

/**
 * The official change recorder and its routes, mounted while the
 * environment runs commands in the workspace container: the recorder's git
 * snapshots and captures run there. Switching the environment back to the
 * worker shell removes both before the next turn; summaries already
 * announced are then no longer served, as after a Host restart.
 * @returns the reconciliation to run before each turn.
 */
export function mountWorkspaceChanges(ctx: Context, enabled: () => boolean): () => Promise<void> {
  let fibers: Fiber[] | undefined;
  return async () => {
    if (enabled() === (fibers !== undefined)) return;
    if (fibers) {
      const current = fibers;
      fibers = undefined;
      for (const fiber of current.reverse()) await fiber.dispose();
      return;
    }
    const isolated = DESKTOPLESS.reduce((scope, name) => scope.isolate(name), ctx);
    fibers = [ctx.plugin(WorkspaceChanges, WorkspaceChanges.Config({} as WorkspaceChanges.Config)), isolated.plugin(DeliverablesHost)];
    for (const fiber of fibers) await fiber.await();
  };
}
