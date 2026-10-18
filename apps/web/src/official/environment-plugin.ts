import React from 'react';
interface InventoryRow {
    pluginId: string;
    agentId: string;
    currentPackageId?: string;
    packages: {
        packageId: string;
        name: string;
        purpose: string;
        hasClientHalf: boolean;
    }[];
    activeRun?: {
        pluginRunId: string;
        packageId: string;
    };
}
interface ClientContext {
    slots: {
        inject(name: string, callback: () => unknown): unknown;
        register(spec: object, component: (props: {
            wide: boolean;
        }) => React.ReactNode): unknown;
    };
    remote: {
        dynamicCordisRunner: {
            inventory(): Promise<{
                ok: boolean;
                value?: InventoryRow[];
            }>;
        };
        $on(name: string, listener: () => void): unknown;
    };
    dynamicCordisRunner: {
        isLoaded(id: string): boolean;
        activeRuns: {
            getSnapshot(): ReadonlyMap<string, unknown>;
        };
        startUserRun(request: {
            agentId: string;
            pluginId: string;
            packageId: string;
            hasClientHalf: boolean;
            mode: 'run';
        }): Promise<void>;
    };
    effect(callback: () => () => void, label: string): unknown;
    on(name: string, listener: () => void): unknown;
}
export const name = 'weft-environment';
export const inject = ['slots', 'remote', 'remote.dynamicCordisRunner', 'dynamicCordisRunner'];
/** A small host extension; the official loader and UI own the workspace. */
export function apply(ctx: ClientContext): void {
    try {
        mount(ctx);
    }
    catch (error) {
        console.error('[weft] environment extension startup failed', error);
        throw error;
    }
}
function mount(ctx: ClientContext): void {
    let closed = false;
    let recovering: Promise<void> | undefined;
    const recover = () => {
        if (closed || recovering)
            return;
        recovering = (async () => {
            const answer = await ctx.remote.dynamicCordisRunner.inventory();
            if (!answer.ok || closed)
                return;
            for (const row of answer.value ?? []) {
                if (closed)
                    break;
                const active = row.activeRun;
                const pkg = row.packages.find(pkg => pkg.packageId === active?.packageId);
                if (!active || !pkg?.hasClientHalf || row.currentPackageId !== pkg.packageId)
                    continue;
                if (ctx.dynamicCordisRunner.isLoaded(row.pluginId) || ctx.dynamicCordisRunner.activeRuns.getSnapshot().has(row.pluginId))
                    continue;
                await ctx.dynamicCordisRunner.startUserRun({ agentId: row.agentId, pluginId: row.pluginId, packageId: pkg.packageId, hasClientHalf: true, mode: 'run' });
            }
        })().catch(error => { if (!closed)
            console.error('[weft] restoring approved plugins failed', error); }).finally(() => { recovering = undefined; });
    };
    ctx.effect(() => () => { closed = true; }, 'weft.environment-lifetime');
    ctx.on('connection/reset', recover);
    ctx.remote.$on('cordis/dynamic-package', recover);
    recover();
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'weft-agents', order: -100 }, ({ wide }) => React.createElement('a', {
        href: '/', 'aria-label': 'My Agents', title: 'My Agents',
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', color: 'inherit', textDecoration: 'none', fontSize: 13 },
    }, React.createElement('span', { 'aria-hidden': true }, '←'), wide ? 'My Agents' : null)));
}
