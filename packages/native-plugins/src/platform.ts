import type { Context, Plugin } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { kernelModule } from '../../../.generated/native-plugin-kernel.ts';
const descriptionSchema = z.object({ name: z.string().max(200), inject: z.record(z.string().max(100), z.json()), handlers: z.array(z.string().min(1).max(100)).max(100) });
const metadataSchema = descriptionSchema.extend({ tools: z.array(z.object({ name: z.string().min(1).max(100), description: z.string(), parameters: z.record(z.string(), z.unknown()), outputSchema: z.record(z.string(), z.unknown()), hasPresentation: z.boolean(), timeoutMs: z.number().positive().optional() })).max(100) });
type Metadata = z.infer<typeof metadataSchema>;
interface FacetApi {
    describe(): Promise<unknown>;
    start(): Promise<unknown>;
    invoke(method: string, args: unknown): Promise<{
        value: unknown;
        metadata: unknown;
    }>;
    tool(name: string, args: unknown, callId: string, operationId: string): Promise<ToolExecutionResult>;
    cancelTool(operationId: string): Promise<void>;
    stop(): Promise<void>;
}
interface Allocation {
    name: string;
    runId: string;
    facet: FacetApi;
    disposers: (() => void)[];
    releasing?: boolean;
}
/** The trusted bridge runs no user source in the main Harness isolate. */
export class NativePluginPlatform {
    private readonly allocations = new Map<string, Allocation>();
    private faultHandler: ((runId: string, error: Error) => void) | undefined;
    onFault(handler: (runId: string, error: Error) => void): void { this.faultHandler = handler; }
    constructor(private readonly state: DurableObjectState, private readonly loader: WorkerLoader | undefined, private readonly scope: object, private readonly capability?: (pluginId: string, runId: string) => Fetcher) { }
    private async bounded<T>(allocation: Allocation, operation: () => Promise<T>): Promise<T> {
        const timer = setTimeout(() => {
            const error = new Error('Dynamic plugin operation deadline exceeded');
            this.state.facets.abort(allocation.name, error);
            if (!allocation.releasing)
                this.faultHandler?.(allocation.runId, error);
        }, 15000);
        try {
            return await operation();
        }
        finally {
            clearTimeout(timer);
        }
    }
    async evaluate(ctx: Context, pluginId: string, runId: string, source: string, handle: (method: unknown, fn: unknown) => () => void): Promise<Plugin> {
        if (!this.loader)
            throw new Error('Dynamic Workers loader is not configured');
        const name = 'harness-plugin:' + pluginId;
        for (const [id, previous] of this.allocations)
            if (previous.name === name) {
                await this.release(id);
            }
        const factory = `export default async function(harness){\n${source}\n}`;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([this.scope, pluginId, runId, kernelModule, factory])));
        const codeId = 'weft-native-host:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        const capability = this.capability?.(pluginId, runId);
        const worker = this.loader.get(codeId, () => ({
            compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], mainModule: 'kernel.js',
            modules: { 'kernel.js': kernelModule, 'weft:plugin-factory': { js: factory } },
            env: capability ? { HOST: capability } : {}, globalOutbound: null,
            limits: { cpuMs: 100, subRequests: 64 },
        }));
        const facet = this.state.facets.get(name, () => ({ class: worker.getDurableObjectClass('PluginFacet') })) as unknown as FacetApi;
        const allocation: Allocation = { name, runId, facet, disposers: [] };
        this.allocations.set(runId, allocation);
        try {
            const description = descriptionSchema.parse(await this.bounded(allocation, () => facet.describe()));
            const handlers = new Map<string, () => void>();
            const tools = new Map<string, {
                signature: string;
                dispose: () => void;
            }>();
            const sync = (metadata: Metadata) => {
                for (const [method, dispose] of handlers)
                    if (!metadata.handlers.includes(method)) {
                        dispose();
                        handlers.delete(method);
                    }
                for (const method of metadata.handlers)
                    if (!handlers.has(method)) {
                        const dispose = handle(method, async (args: unknown) => {
                            const result = await this.bounded(allocation, () => facet.invoke(method, args));
                            sync(metadataSchema.parse(result.metadata));
                            return result.value;
                        });
                        allocation.disposers.push(dispose);
                        handlers.set(method, dispose);
                    }
                for (const [name, registration] of tools)
                    if (!metadata.tools.some(tool => tool.name === name)) {
                        registration.dispose();
                        tools.delete(name);
                    }
                for (const tool of metadata.tools) {
                    const signature = JSON.stringify(tool);
                    if (tools.get(tool.name)?.signature === signature)
                        continue;
                    tools.get(tool.name)?.dispose();
                    const projections = new WeakMap<object, {
                        content: ContentBlock[];
                        meta?: JsonValue;
                    }>();
                    const dispose = ctx.tools.register({
                        name: tool.name, description: tool.description, parameters: tool.parameters,
                        ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
                        output: {
                            schema: tool.outputSchema,
                            render: args => {
                                const result = projections.get(args as object);
                                if (!result)
                                    throw new Error('Missing isolated tool result projection');
                                return result.content;
                            },
                            ...(tool.hasPresentation ? { presentationMeta: (args: unknown) => projections.get(args as object)?.meta ?? null } : {}),
                        },
                        execute: async (args, exec) => {
                            exec.signal.throwIfAborted();
                            const operationId = crypto.randomUUID();
                            const abort = () => this.state.waitUntil(facet.cancelTool(operationId).catch(() => { }));
                            exec.signal.addEventListener('abort', abort, { once: true });
                            try {
                                const result = await this.bounded(allocation, () => facet.tool(tool.name, args, exec.callId, operationId));
                                exec.signal.throwIfAborted();
                                for (const context of result.additionalContexts ?? [])
                                    exec.deferContext(context);
                                if (result.isError)
                                    throw new HarnessError(result.error.message, result.error.info?.code ?? 'PLUGIN_TOOL_FAILED');
                                if (result.concludesTurn)
                                    exec.concludeTurn();
                                projections.set(args as object, result);
                                return result.value;
                            }
                            finally {
                                exec.signal.removeEventListener('abort', abort);
                            }
                        },
                    });
                    tools.set(tool.name, { signature, dispose });
                    allocation.disposers.push(dispose);
                }
            };
            sync({ ...description, tools: [] });
            return {
                name: description.name, inject: description.inject as NonNullable<Plugin.Object['inject']>, apply: async (child) => {
                    child.effect(() => () => this.release(runId), 'weft.native-plugin-facet');
                    sync(metadataSchema.parse(await this.bounded(allocation, () => facet.start())));
                }
            };
        }
        catch (error) {
            await this.release(runId);
            throw error;
        }
    }
    async release(runId: string): Promise<void> {
        const allocation = this.allocations.get(runId);
        if (!allocation)
            return;
        this.allocations.delete(runId);
        allocation.releasing = true;
        for (const dispose of allocation.disposers.splice(0).reverse())
            dispose();
        try {
            await this.bounded(allocation, () => allocation.facet.stop());
        }
        catch { /* A crashed or uncooperative isolate is still forcibly stopped below. */ }
        finally {
            this.state.facets.abort(allocation.name, new Error('Plugin activation stopped'));
        }
    }
    async reconcile(active: ReadonlySet<string>): Promise<void> {
        for (const id of this.allocations.keys())
            if (!active.has(id))
                await this.release(id);
    }
}
