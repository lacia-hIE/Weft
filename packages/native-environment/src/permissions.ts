import { Context } from '@deepseek-ai/cordis';
import Sessions from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import { ComputerBashExecutor, WorkspaceSubprocess } from '../../workspace/src/subprocess.ts';

/** The official approval and permission rows, composed over the Computer shell's confinement. */
// The base bundle's preset table.
const PRESETS = {
  'read-only': {sandbox: 'read-only', approval: 'ask'},
  'workspace-write': {sandbox: 'workspace-write', approval: 'ask'},
  'danger-full-access': {sandbox: 'danger-full-access', approval: 'never'},
} as const;

export async function mountPermissions(ctx: Context, defaultPreset: string | undefined): Promise<void> {
  await ctx.plugin(ApprovalService, {policy: 'ask'});
  await ctx.plugin(PermissionPresetService, {presets: PRESETS, ...(defaultPreset === undefined ? {} : {defaultPreset})} as never);
}

type Definition = Parameters<SessionProjectionRegistry['register']>[0];

/**
 * A private world holding no Session: the original permission service built
 * there serves the process catalog and its `permissions` projection fold for
 * read-only contexts, which must never take a Session writer.
 */
export async function openPermissionWorld(defaultPreset: string | undefined): Promise<{ctx: Context; catalog(): unknown; definitions: readonly Definition[]}> {
  const definitions: Definition[] = [];
  class CapturingProjections extends SessionProjectionRegistry {
    override register(definition: Definition): () => void { definitions.push(definition); return super.register(definition); }
  }
  const ctx = new Context();
  try {
    const inspectOnly = () => Promise.reject(new Error('The permission catalog does not execute commands'));
    await ctx.plugin(Sessions);
    await ctx.plugin(CapturingProjections as typeof SessionProjectionRegistry);
    await ctx.plugin(SandboxPolicy, {workspaceRoot: '/workspace', mode: 'workspace-write'});
    await ctx.plugin(WorkspaceSubprocess, {exec: inspectOnly, kill: inspectOnly});
    await ctx.plugin(ComputerBashExecutor, {cwd: '/workspace'});
    await mountPermissions(ctx, defaultPreset);
    const service = ctx.get('permissionPresets');
    if (!service) throw new Error('Permission presets are not mounted');
    return {ctx, catalog: () => service.catalog(), definitions: definitions.filter(definition => (definition.key as string) === 'permissions')};
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}
