import { DurableObject } from 'cloudflare:workers';
import { Context, Inject, type Fiber, type Plugin } from '@deepseek-ai/cordis';
import Timer from '@deepseek-ai/cordis-plugin-timer';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { guardedPlugin, isPlugin, normalizeHandler, sandboxDefineTool, sandboxRegisterTool } from '@weft/upstream/packages/extensions/cordis-host-runner/src/guard.ts';
// This module is supplied by WorkerLoader, never evaluated in the supervisor.
import factory from 'weft:plugin-factory';
import { nativePluginFsMethods } from './protocol.ts';
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
interface KernelEnv {
    ALLOWED?: string[];
    HOST?: {
        callFs(method: string, args: unknown[]): Promise<unknown>;
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
    async start() {
        await this.prepare();
        await (this.starting ??= (async () => {
            const plugin = this.plugin!;
            const provided = new Set<string>(this.env.ALLOWED ?? ['tools', 'timer', 'fs']);
            // systemPrompt exists only to support the isolated ToolRuntime. Exposing
            // it would silently modify a local prompt instead of the owning Agent.
            const facade = (ctx: Context) => new Proxy(ctx, {
                get(target, key) {
                    if (key === 'get')
                        return (name: string) => provided.has(name) ? target.get(name) : undefined;
                    if (key === 'provide')
                        return (name: string, value: unknown) => {
                            if (name === 'systemPrompt')
                                throw new Error('The Agent systemPrompt service is not bridged');
                            const dispose = target.provide(name, value);
                            provided.add(name);
                            return dispose;
                        };
                    return Reflect.get(target, key);
                }
            });
            const isolated: Plugin.Object = { ...plugin, inject: plugin.inject!, apply: (ctx, config) => typeof plugin === 'function' ? Reflect.apply(plugin, undefined, [facade(ctx), config]) : plugin.apply(facade(ctx), config) };
            const fiber = this.fiber = this.root!.plugin(guardedPlugin(isolated, error => { throw error; }));
            await fiber.await();
            const missing = Object.keys(fiber.inject).filter(name => this.root!.get(name) === undefined);
            if (missing.length)
                throw new Error('Dynamic Host services are not bridged: ' + missing.join(', '));
        })());
        return this.metadata();
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
    async stop(): Promise<void> {
        this.stopped = true;
        for (const controller of this.operations.values())
            controller.abort(new Error('Plugin activation stopped'));
        await this.root?.fiber.dispose();
        this.handlers.clear();
    }
}
