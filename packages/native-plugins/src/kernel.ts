import * as cryptoModule from 'node:crypto';
import * as bufferModule from 'node:buffer';
import * as valuesModule from '@deepseek-ai/dsh-util-values';
import * as sessionModule from '@deepseek-ai/dsh-session';
import {credentialRef} from '@deepseek-ai/dsh-credentials';
import Schema from '@deepseek-ai/schemastery';
import {WebhookDeliveryId,WebhookSourceId,WebhookRuleId} from '@deepseek-ai/dsh-webhook';
import { DurableObject } from 'cloudflare:workers';
import * as cordis from '@deepseek-ai/cordis';
import {applyEntryConfig, composeInstalledBundle, entrySchemas, type EntrySchema} from '../../package-install/src/composition.ts';
import { Context, Inject, type Fiber, type Plugin } from '@deepseek-ai/cordis';
import Timer from '@deepseek-ai/cordis-plugin-timer';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { guardedPlugin, isPlugin, normalizeHandler, sandboxDefineTool, sandboxRegisterTool } from '@weft/upstream/packages/extensions/cordis-host-runner/src/guard.ts';
// This module is supplied by WorkerLoader, never evaluated in the supervisor.
import factory from 'weft:plugin-factory';
import { nativePluginFsMethods } from './protocol.ts';
import {mountDurableStorage} from '../../native-storage/src/index.ts';
import {DurablePluginTimers} from './durable-timers.ts';
import {WorkerWebServer} from './web-server.ts';
import {pluginSessionStream} from './stream.ts';
import {WorkerWebhooks} from './webhooks.ts';
import type {VerifiedWebhookDelivery} from '@deepseek-ai/dsh-webhook';
import {sessionMethods} from './services.ts';
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
interface KernelEnv {
    ALLOWED?: string[];
    BACKGROUND?: boolean;
    ACTIVATION?: string;
    /** The environment's configuration of the bundle's entries, by entry id. */
    CONFIG?: Record<string, Record<string, unknown>>;
    HOST?: {
        callFs(method: string, args: unknown[]): Promise<unknown>;
        callSession(method: string, request: unknown): Promise<unknown>;
        resolveCredential(ref: string): Promise<unknown>;
        followSession(request: unknown): Promise<Response>;
        dispatchWebhook(delivery:unknown):Promise<void>;
        createWebhook(operationId:string,delivery:unknown,ruleId:string,request:unknown):Promise<void>;
        cancelWebhook(operationId:string):Promise<void>;
    };
}
function wire<T>(value: T): T {
    const detached = snapshotJsonValue(value);
    if (detached === undefined)
        throw new Error('Dynamic plugin RPC results must be lossless JSON');
    if (new TextEncoder().encode(JSON.stringify(detached)).byteLength > 1048576)
        throw new Error('Dynamic plugin RPC result exceeds 1 MiB');
    return detached as T;
}
/** One real Cordis tree in a separately isolated Durable Object facet. */
export class PluginFacet extends DurableObject<KernelEnv> {
    private root: Context | undefined;
    private plugin: Plugin | undefined;
    private fiber: Fiber | undefined;
    private preparing: Promise<void> | undefined;
    private starting: Promise<void> | undefined;
    private stopped = false;
    private bundle = false;
    private schemas: EntrySchema[] = [];
    private webServer: WorkerWebServer | undefined;
    private webhooks: WorkerWebhooks | undefined;
    private durableTimers: DurablePluginTimers | undefined;
    private readonly handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    private readonly operations = new Map<string, AbortController>();
    private readonly cancelled = new Set<string>();
    private prepare(): Promise<void> {
        if (this.stopped)
            throw new Error('Plugin activation has stopped');
        return this.preparing ??= (async () => {
            const root = this.root = new Context();
            await root.plugin(SystemPrompt);
            await root.plugin(Tools);
            await root.plugin(Timer);
            if (this.env.BACKGROUND && this.env.ALLOWED?.includes('timer')) this.durableTimers = new DurablePluginTimers(this.ctx.storage, this.env.ACTIVATION ?? 'initial');
            if (this.env.ALLOWED?.includes('webhookRuntime')) {this.webhooks=new WorkerWebhooks(this.env.HOST!,work=>this.ctx.waitUntil(work));await this.webhooks.mount(root);}
            if (this.env.ALLOWED?.includes('webServer')) {this.webServer = new WorkerWebServer();root.provide('webServer', this.webServer);}
            if (this.env.ALLOWED?.some(name => name === 'storage' || name === 'storageDomain')) await mountDurableStorage(root, this.ctx.storage);
            if (this.env.ALLOWED?.includes('sessionController')) {
              const host = this.env.HOST!;
              root.provide('sessionController', {...Object.fromEntries(sessionMethods.map(method => [method, async (request: unknown, signal?: AbortSignal) => {signal?.throwIfAborted(); const value = await host.callSession(method, wire(request)); signal?.throwIfAborted(); return value;}])),
                follow: (request: unknown, signal?: AbortSignal) => (async function* () {yield* pluginSessionStream(await host.followSession(wire(request)), signal);})(),
              });
            }
            if (this.env.ALLOWED?.includes('credentials')) root.provide('credentials', {resolve: (ref: string) => this.env.HOST!.resolveCredential(ref)});
            if (this.env.HOST)
                root.provide('fs', Object.fromEntries(nativePluginFsMethods.map(method => [method, async (...args: unknown[]) => {
                        const signals = args.flatMap(arg => arg instanceof AbortSignal ? [arg] : arg && typeof arg === 'object' && 'signal' in arg && arg.signal instanceof AbortSignal ? [arg.signal] : []);
                        for (const signal of signals)
                            signal.throwIfAborted();
                        const plain = args.map(arg => arg instanceof AbortSignal ? undefined : arg && typeof arg === 'object' && 'signal' in arg ? Object.fromEntries(Object.entries(arg).filter(([key]) => key !== 'signal')) : arg);
                        const result = await this.env.HOST!.callFs(method, plain);
                        for (const signal of signals)
                            signal.throwIfAborted();
                        return result;
                    }])));
            const harness = {
                crypto:cryptoModule,buffer:bufferModule,values:valuesModule,session:sessionModule,schema:Schema,credentials:{credentialRef},webhook:{WebhookDeliveryId,WebhookSourceId,WebhookRuleId},
                cordis, tools: {defineTool: sandboxDefineTool},
                compose: (rows: Record<string, unknown>[], modules: Record<string, unknown>) => {
                    this.bundle = true; this.schemas = entrySchemas(rows, modules);
                    return composeInstalledBundle(applyEntryConfig(rows, this.env.CONFIG ?? {}), modules, plugin => this.guard(plugin));
                },
                defineTool: sandboxDefineTool, registerTool: sandboxRegisterTool,
                handle: (method: unknown, fn: unknown) => {
                    const handler = normalizeHandler(method, fn);
                    this.handlers.set(handler.method, handler.handler);
                    return () => { if (this.handlers.get(handler.method) === handler.handler)
                        this.handlers.delete(handler.method); };
                },
            };
            const plugin: unknown = await factory(harness);
            if (!isPlugin(plugin))
                throw new Error('The Host half must return a Cordis plugin');
            this.plugin = plugin;
        })();
    }
    async describe() {
        await this.prepare();
        const plugin = this.plugin!;
        const unsupported = Object.keys(Inject.resolve(plugin.inject)).filter(name => !(this.env.ALLOWED ?? ['tools', 'timer', 'fs']).includes(name));
        if (unsupported.length)
            throw new Error('Services are not bridged in workerd Host plugins: ' + unsupported.join(', '));
        return wire({ name: typeof plugin === 'object' && 'name' in plugin ? String(plugin.name) : 'dynamic-host', inject: { ...Inject.resolve(plugin.inject) }, handlers: [...this.handlers.keys()] });
    }
    /** Config schemas of a bundle's entries, read without starting the plugin. */
    async configSchemas() {
        await this.prepare();
        return wire(this.schemas);
    }
    async start() {
        await this.prepare();
        await (this.starting ??= (async () => {
            const plugin = this.plugin!;
            const fiber = this.fiber = this.root!.plugin(this.bundle ? plugin : this.guard(plugin));
            await fiber.await();
            const missing = Object.keys(fiber.inject).filter(name => this.root!.get(name) === undefined);
            if (missing.length)
                throw new Error('Dynamic Host services are not bridged: ' + missing.join(', '));
        })());
        return this.metadata();
    }
    /** Host services plus those the bundle's own entries provide, shared by every entry of this facet. */
    private provided: Set<string> | undefined;
    private guard(plugin: Plugin): Plugin {
        const provided = this.provided ??= new Set<string>(this.env.ALLOWED ?? ['tools', 'timer', 'fs']);
            const facade = (ctx: Context) => new Proxy(ctx, {
                get: (target, key) => {
                    if (this.durableTimers && (key === 'interval' || key === 'timeout')) return (callback: () => unknown, delay: number) => target.effect(() => this.durableTimers!.register(callback, delay, key === 'interval'));
                    if (key === 'timer' && this.durableTimers && provided.has('timer')) return new Proxy(target.timer, {get: (timer, method) => method === 'interval' || method === 'timeout' ? (callback: () => unknown, delay: number) => target.effect(() => this.durableTimers!.register(callback, delay, method === 'interval')) : Reflect.get(timer, method)});
                    if (key==='webhookRuntime' && provided.has('webhookRuntime')) return this.webhooks?.service;
                    if (typeof key === 'string' && ['tools', 'timer', 'fs', 'storage', 'storageDomain', 'sessionController', 'webhookRuntime', 'credentials', 'webServer'].includes(key) && !provided.has(key))
                        throw new Error(`Plugin permission denied: ${key}`);
                    if (key === 'get')
                        return (name: string) => provided.has(name) ? name==='webhookRuntime' ? this.webhooks?.service : name === 'timer' && this.durableTimers ? facade(target).timer : target.get(name) : undefined;
                    if (key === 'provide')
                        return (name: string, value: unknown) => {
                            if (['systemPrompt', 'sessionController', 'webhookRuntime', 'credentials', 'storage', 'storageDomain', 'webServer'].includes(name))
                                throw new Error('The Agent systemPrompt service is not bridged');
                            const dispose = target.provide(name, value);
                            provided.add(name);
                            return dispose;
                        };
                    return Reflect.get(target, key);
                }
            });
        const isolated: Plugin.Object = {...plugin, ...(plugin.inject === undefined ? {} : {inject: plugin.inject}), apply: (ctx, config) => typeof plugin === 'function' ? Reflect.apply(plugin, undefined, [facade(ctx), config]) : plugin.apply(facade(ctx), config)};
        return guardedPlugin(isolated, error => {throw error;});
    }
    async metadata() {
        await this.prepare();
        return wire({
            ...await this.describe(), tools: this.root!.tools.schemas().map(schema => {
                const definition = this.root!.tools.get(schema.name)!;
                return { ...schema, outputSchema: definition.output.schema, hasPresentation: !!definition.output.presentationMeta, ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }) };
            })
        });
    }
    async invoke(method: string, args: unknown) {
        await this.prepare();
        const handler = this.handlers.get(method);
        if (!handler)
            throw new Error('Host method is not registered: ' + method);
        return wire({ value: await handler(args), metadata: await this.metadata() });
    }
    async tool(name: string, args: unknown, callId: string, operationId: string) {
        await this.start();
        const tool = this.root!.tools.get(name);
        if (!tool)
            throw new Error('Dynamic tool is not registered: ' + name);
        // The supervisor applies Agent-scoped policy first. The isolated registry
        // validates the body and its projections without inventing an Agent facade.
        const controller = new AbortController();
        this.operations.set(operationId, controller);
        if (this.cancelled.delete(operationId))
            controller.abort(new Error('Dynamic tool was cancelled'));
        try {
            return wire(await this.root!.tools.execute({ callId: ToolCallId(callId), name, arguments: args, signal: controller.signal }));
        }
        finally {
            this.operations.delete(operationId);
        }
    }
    cancelTool(operationId: string): void {
        const controller = this.operations.get(operationId);
        if (controller)
            controller.abort(new Error('Dynamic tool was cancelled'));
        else {
            this.cancelled.add(operationId);
            if (this.cancelled.size > 128)
                this.cancelled.delete(this.cancelled.values().next().value!);
        }
    }
    override async fetch(request: Request): Promise<Response> {await this.start();const dispatch=()=>this.webServer ? this.webServer.dispatch(request) : Promise.resolve(new Response(null,{status:404}));return this.webhooks?this.webhooks.run(dispatch):dispatch();}
    async deliverWebhook(delivery:VerifiedWebhookDelivery):Promise<void> {await this.start();await this.webhooks?.deliver(delivery);}
    async tick(): Promise<void> { await this.start(); if(this.webhooks)await this.webhooks.run(async()=>{await this.durableTimers?.tick();});else await this.durableTimers?.tick(); }
    async nextAlarm(): Promise<number | undefined> { await this.start(); return this.durableTimers?.next(); }
    async stop(): Promise<void> {
        this.stopped = true;
        for (const controller of this.operations.values())
            controller.abort(new Error('Plugin activation stopped'));
        await this.root?.fiber.dispose();
        this.handlers.clear();
    }
}
