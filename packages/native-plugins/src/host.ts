import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import Runner from '@deepseek-ai/dsh-cordis-host-runner';
import { mountNativeInspectProviders } from './inspect.ts';
import * as InspectTools from '@deepseek-ai/dsh-tool-cordis';
import remote from '../../../.generated/official-remotes/packages/extensions/cordis-host-runner/typert.remote-client.js';
import { DurablePluginRegistry } from './registry.ts';
import { NativePluginPlatform } from './platform.ts';
import { mountNativePluginTools } from './tools.ts';
import type {} from './sandbox.ts';
import { missingServices } from '@weft/upstream/packages/extensions/cordis-host-runner/src/lifecycle.ts';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export type NativePluginEndpoint = keyof typeof remote.methods;
interface Owner {
    state: DurableObjectState;
    loader?: WorkerLoader;
    scope: {
        sessionId: string;
    };
    capability?: (pluginId: string, runId: string) => Fetcher;
    allowAuthoring: boolean;
    sync(inventory: unknown, pending: {
        requestId: string;
        pluginId: string;
    }[]): Promise<void>;
    event(name: string, args: readonly unknown[]): Promise<void>;
    manifest(): Promise<unknown>;
}
const instances = new WeakMap<Context, NativePlugins>();
export const nativePlugins = (ctx: Context) => instances.get(ctx);
const mutations = ['run', 'runHostHalf', 'resolveRequestRun', 'settleUserRun', 'stop', 'undefine', 'stopFromPanel', 'undefineFromPanel', 'reportRenderFailure', 'reportClientGuardFailure'] as const;
export class NativePlugins {
    private tail = Promise.resolve();
    private restoring = false;
    private readonly restoredEvents: {
        name: string;
        value: unknown;
    }[] = [];
    private constructor(private readonly ctx: Context, readonly runner: Runner, private readonly registry: DurablePluginRegistry, private readonly platform: NativePluginPlatform, private readonly owner: Owner) { }
    static async mount(ctx: Context, owner: Owner): Promise<NativePlugins> {
        const registry = new DurablePluginRegistry(owner.state.storage, owner.scope.sessionId);
        const platform = new NativePluginPlatform(owner.state, owner.loader, owner.scope, owner.capability);
        ctx.provide('weftNativePluginRegistry', registry);
        ctx.provide('weftNativePluginPlatform', platform);
        await ctx.plugin(Runner);
        const runner = ctx.dynamicCordisRunner;
        const host = new NativePlugins(ctx, runner, registry, platform, owner);
        instances.set(ctx, host);
        const stop = runner.stop.bind(runner);
        platform.onFault((runId, error) => owner.state.waitUntil(host.enqueue(async () => {
            const plugin = registry.all().find(plugin => plugin.run?.pluginRunId === runId);
            const agent = ctx.agents.get(owner.scope.sessionId as never);
            if (!plugin || !agent)
                return;
            const packageId = plugin.run!.packageId;
            await stop(agent, plugin.pluginId);
            if (plugin.latestRun?.pluginRunId === runId) {
                plugin.latestRun.status = 'failed';
                plugin.latestRun.host = { status: 'failed', waitingFor: [], error: error.message };
                plugin.latestRun.error = { phase: 'host-apply', message: error.message, pluginId: plugin.pluginId, packageId, pluginRunId: runId as never };
            }
            agent.inject(createUserMessage({ source: { kind: 'cordis-host-runner' }, content: [{ type: 'text', text: `Cordis Host activation ${plugin.pluginId}/${packageId} (${runId}) was stopped: ${error.message}` }] }));
            await host.persist();
        })));
        const define = runner.define.bind(runner);
        runner.define = request => {
            const value = define(request);
            try {
                registry.checkpoint(runner);
            }
            catch (error) {
                if (request.plugin.kind === 'new')
                    registry.delete(value.pluginId);
                else
                    registry.get(value.pluginId)?.packages.delete(value.packageId);
                throw error;
            }
            owner.state.waitUntil(host.checkpoint());
            return value;
        };
        for (const name of mutations) {
            const fn = runner[name].bind(runner) as (...args: unknown[]) => Promise<unknown>;
            Object.defineProperty(runner, name, {
                configurable: true, writable: true, value: async (...args: unknown[]) => {
                    try {
                        return await fn(...args);
                    }
                    finally {
                        await host.checkpoint();
                    }
                }
            });
        }
        for (const name of ['cordis/request-run', 'cordis/request-run-resolved', 'cordis/dynamic-package', 'cordis/dynamic-retract', 'cordis/inspect-query'] as const)
            ctx.on(name, (value: unknown) => {
                if (host.restoring) {
                    host.restoredEvents.push({ name, value });
                    return;
                }
                owner.state.waitUntil(host.enqueue(async () => { await host.persist(); await owner.event(name, [value]); }));
            });
        const manifest = remote.methods['dynamicCordisRunner/syncInspectManifest'].input({ strict: true }).create().parse({ providers: await owner.manifest() });
        runner.syncInspectManifest(manifest.providers);
        mountNativeInspectProviders(ctx);
        await ctx.plugin(InspectTools);
        if (owner.allowAuthoring)
            mountNativePluginTools(ctx);
        return host;
    }
    private enqueue(operation: () => Promise<void>): Promise<void> {
        const result = this.tail.catch(() => { }).then(operation);
        this.tail = result;
        return result;
    }
    private async persist(): Promise<void> {
        this.registry.checkpoint(this.runner);
        await this.owner.state.storage.sync();
        await this.owner.sync(this.runner.inventory(), this.registry.pendingOwners());
    }
    checkpoint(): Promise<void> {
        if (this.restoring)
            return Promise.resolve();
        return this.enqueue(async () => {
            await this.platform.reconcile(new Set(this.registry.all().flatMap(plugin => plugin.run ? [plugin.run.pluginRunId] : [])));
            await this.persist();
        });
    }
    async restore(agent: Agent): Promise<void> {
        this.restoring = true;
        try {
            await this.registry.restore(this.runner, agent);
        }
        finally {
            this.restoring = false;
            await this.checkpoint();
        }
        for (const event of this.restoredEvents.splice(0))
            await this.owner.event(event.name, [event.value]);
    }
    hasRun(pluginId: string, runId: string): boolean {
        const plugin = this.registry.get(pluginId as never);
        return plugin?.run?.pluginRunId === runId || (plugin?.latestRun?.pluginRunId === runId && ['starting-host', 'client-pending'].includes(plugin.latestRun.status));
    }
    async invoke(endpoint: NativePluginEndpoint, raw: unknown, agent: Agent): Promise<Response> {
        const method = remote.methods[endpoint];
        const args = method.input({ strict: true }).create().parse(raw) as Record<string, unknown>;
        if ('agentId' in args && args.agentId !== agent.id)
            throw new Error('Native plugin session identity mismatch');
        // Reconnecting pages attach to a real, already approved activation. They
        // must not replace its state or consume a newer version's pending approval.
        const plugin = typeof args.pluginId === 'string' ? this.registry.get(args.pluginId as never) : undefined;
        const run = plugin?.run;
        if (plugin && run && plugin.currentPackageId === run.packageId) {
            const waitingFor = run.fiber ? missingServices(this.ctx, run.fiber) : [];
            let attached: unknown;
            if (endpoint === 'dynamicCordisRunner/runHostHalf' && args.requestId === null && args.mode === 'run' && args.packageId === run.packageId) {
                attached = { ok: true, pluginId: plugin.pluginId, packageId: run.packageId, pluginRunId: run.pluginRunId, waitingFor, startedHere: false };
            }
            if (endpoint === 'dynamicCordisRunner/settleUserRun') {
                const resolution = args.resolution as {
                    ok: boolean;
                    pluginRunId?: string;
                };
                if (resolution.ok && resolution.pluginRunId === run.pluginRunId && (plugin.latestRun?.pluginRunId !== run.pluginRunId || ['running', 'waiting'].includes(plugin.latestRun.status))) {
                    attached = { ok: true, status: 'running', pluginId: plugin.pluginId, packageId: run.packageId, pluginRunId: run.pluginRunId, waitingFor, currentPackageId: run.packageId, mode: 'run' };
                }
            }
            if (attached)
                return Response.json({ value: method.result.create().parse(attached) });
        }
        const parameters = method.parameters.map(parameter => parameter.source === 'lookup' ? agent : args[parameter.wire ?? parameter.name]);
        const action = endpoint.slice('dynamicCordisRunner/'.length) as keyof Runner;
        const fn = this.runner[action];
        if (typeof fn !== 'function')
            throw new Error('Native plugin endpoint is unavailable');
        const value = await Reflect.apply(fn, this.runner, parameters);
        await this.checkpoint();
        return Response.json({ value: method.result.create().parse(value) });
    }
}
