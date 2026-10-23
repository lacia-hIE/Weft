import React from 'react';
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path';
import * as WorkspaceRuntimeSettings from './workspace-runtime-settings.ts';
import * as PackageInstallations from './package-installations.ts';
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
    plugin(plugin: object): unknown;
    on(name: string, listener: () => void): unknown;
    locale: {
        register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
        bind(namespace: string): (key: string) => string;
    };
    layout: {
        selectPanel(panelId: string | null): void;
    };
    sidebarRight: {
        mounted: { getSnapshot(): string | undefined };
        openResource(address: string): void;
    };
    sessions: {
        list: { getSnapshot(): { byId: Record<string, { cwd?: string } | undefined> } };
    };
}
export const name = 'weft-environment';
export const inject = ['slots', 'remote', 'remote.dynamicCordisRunner', 'dynamicCordisRunner', 'locale', 'layout', 'sidebarRight', 'sessions'];
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
    // The workspace runtime page waits for the Settings forms service on its own.
    ctx.plugin(WorkspaceRuntimeSettings);
    ctx.plugin(PackageInstallations);
    ctx.on('connection/reset', recover);
    ctx.remote.$on('cordis/dynamic-package', recover);
    recover();
    // Settings' Open configuration file writes the environment's document to its workspace; show it in the open Session.
    ctx.remote.$on('weft/settings-document', ((document: { path: string }) => {
        const sessionId = ctx.sidebarRight.mounted.getSnapshot();
        if (sessionId === undefined) return;
        ctx.sidebarRight.openResource(fileAddressFor(sessionId, ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd, document.path));
    }) as () => void);
    // My Agents is the site home page, outside every environment's workbench; the sidebar entry leaves for it.
    ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'weft.environments-locale');
    const t = ctx.locale.bind(NS);
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 100, label: () => t('panel'), locale: NS }, EnvironmentsIcon));
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, () => React.createElement(LeaveForHome, { layout: ctx.layout })));
}

const NS = 'weft.environments';
const PANEL_ID = 'weft-agents';
const zh = { panel: '我的 Agents' };
const en = { panel: 'My Agents' };

function EnvironmentsIcon(): React.ReactNode {
    return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
        React.createElement('rect', { x: 2, y: 2, width: 5, height: 5, rx: 1 }), React.createElement('rect', { x: 9, y: 2, width: 5, height: 5, rx: 1 }),
        React.createElement('rect', { x: 2, y: 9, width: 5, height: 5, rx: 1 }), React.createElement('rect', { x: 9, y: 9, width: 5, height: 5, rx: 1 }));
}

/** Selecting My Agents returns the workbench to its Conversation and opens the site home page. */
function LeaveForHome({ layout }: { layout: ClientContext['layout'] }): React.ReactNode {
    React.useEffect(() => {
        layout.selectPanel(null);
        location.assign('/');
    }, [layout]);
    return null;
}
