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
    locale: {
        register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
        bind(namespace: string): (key: string) => string;
    };
}
export const name = 'weft-environment';
export const inject = ['slots', 'remote', 'remote.dynamicCordisRunner', 'dynamicCordisRunner', 'locale'];
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
    // Environment switching lives with the sidebar panels, so the sidebar foot keeps the official single Settings button.
    ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'weft.environments-locale');
    const t = ctx.locale.bind(NS);
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 100, label: () => t('panel'), locale: NS }, EnvironmentsIcon));
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, () => React.createElement(EnvironmentsPage, { t })));
}

const NS = 'weft.environments';
const PANEL_ID = 'weft-agents';
const zh = { panel: '我的 Agents', title: '我的 Agents', description: '每个 Agent 是一套独立的 Harness 环境，拥有自己的预设、插件、会话与工作区。', current: '当前', open: '打开', manage: '管理 Agents', loading: '正在读取…', failed: '无法读取 Agent 列表' };
const en = { panel: 'My Agents', title: 'My Agents', description: 'Each Agent is an independent Harness environment with its own presets, plugins, sessions and workspaces.', current: 'Current', open: 'Open', manage: 'Manage Agents', loading: 'Loading…', failed: 'Agents could not be loaded' };

function EnvironmentsIcon(): React.ReactNode {
    return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
        React.createElement('rect', { x: 2, y: 2, width: 5, height: 5, rx: 1 }), React.createElement('rect', { x: 9, y: 2, width: 5, height: 5, rx: 1 }),
        React.createElement('rect', { x: 2, y: 9, width: 5, height: 5, rx: 1 }), React.createElement('rect', { x: 9, y: 9, width: 5, height: 5, rx: 1 }));
}

interface EnvironmentRow { id: string; name: string; updatedAt?: string }

/** The tenant's Harness environments; opening one loads its own official workbench. */
function EnvironmentsPage({ t }: { t: (key: string) => string }): React.ReactNode {
    const [state, setState] = React.useState<{ kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; rows: EnvironmentRow[] }>({ kind: 'loading' });
    React.useEffect(() => {
        let live = true;
        (async () => {
            const me = await (await fetch('/v1/me')).json() as { tenantId: string };
            const response = await fetch(`/v1/tenants/${encodeURIComponent(me.tenantId)}/environments`);
            if (!response.ok) throw new Error('environments');
            const body = await response.json() as { environments?: EnvironmentRow[] } | EnvironmentRow[];
            if (live) setState({ kind: 'ready', rows: Array.isArray(body) ? body : body.environments ?? [] });
        })().catch(() => { if (live) setState({ kind: 'failed' }); });
        return () => { live = false; };
    }, []);
    const current = /^\/agents\/([^/]+)/.exec(location.pathname)?.[1];
    const row = (environment: EnvironmentRow) => React.createElement('a', {
        key: environment.id, href: `/agents/${encodeURIComponent(environment.id)}`,
        'aria-current': environment.id === current ? 'page' : undefined,
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderRadius: 10, border: '1px solid var(--color-border, rgba(127,127,127,.25))', color: 'inherit', textDecoration: 'none' },
    }, React.createElement('span', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        React.createElement('strong', { style: { fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, environment.name),
        React.createElement('code', { style: { fontSize: 12, opacity: .6 } }, environment.id)),
        React.createElement('span', { style: { fontSize: 12, opacity: .7, flexShrink: 0 } }, environment.id === current ? t('current') : t('open')));
    return React.createElement('div', { style: { maxWidth: 720, margin: '0 auto', padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 12 } },
        React.createElement('h1', { style: { fontSize: 20, fontWeight: 600, margin: 0 } }, t('title')),
        React.createElement('p', { style: { fontSize: 13, opacity: .7, margin: '0 0 8px' } }, t('description')),
        state.kind === 'loading' ? React.createElement('p', { role: 'status' }, t('loading'))
            : state.kind === 'failed' ? React.createElement('p', { role: 'alert' }, t('failed'))
                : state.rows.map(row),
        React.createElement('a', { href: '/', style: { fontSize: 13, marginTop: 8, color: 'inherit' } }, t('manage')));
}
