import type { Context, Plugin } from '@deepseek-ai/cordis';
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import {registerRemoteTool, toolDescriptions} from './tool-bridge.ts';
import { kernelModule } from '../../../.generated/native-plugin-kernel.ts';
const descriptionSchema = z.object({ name: z.string().max(200), inject: z.record(z.string().max(100), z.json()), handlers: z.array(z.string().min(1).max(100)).max(100) });
const metadataSchema = descriptionSchema.extend({tools:toolDescriptions});
type Metadata = z.infer<typeof metadataSchema>;
interface FacetApi {
    describe(): Promise<unknown>;
    configSchemas(): Promise<unknown>;
    metadata(): Promise<unknown>;
    deliverWebhook(delivery: unknown): Promise<void>;
    deliverSessionEvent(event: unknown): Promise<void>;
    deliverConnectionEvents(connectionId: string, events: unknown[]): Promise<'ok' | 'unknown'>;
    start(): Promise<unknown>;
    invoke(method: string, args: unknown): Promise<{
        value: unknown;
        metadata: unknown;
    }>;
    tool(name: string, args: unknown, callId: string, operationId: string, callerSessionId?: string): Promise<ToolExecutionResult>;
    cancelTool(operationId: string): Promise<void>;
    fetch(request: Request): Promise<Response>;
    tick(): Promise<void>;
    nextAlarm(): Promise<number | undefined>;
    stop(): Promise<void>;
}
interface Allocation {
    name: string;
    runId: string;
    facet: FacetApi;
    disposers: (() => void)[];
    releasing?: boolean;
    deadlineMs: number;
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
        }, allocation.deadlineMs);
        try {
            return await operation();
        }
        finally {
            clearTimeout(timer);
        }
    }
    async evaluate(ctx: Context, pluginId: string, runId: string, source: string, handle: (method: unknown, fn: unknown) => () => void, installed?: {module: string; services: string[]; environment?: boolean; network?: boolean; activationId?: string; config?: Record<string, Record<string, unknown>>}): Promise<Plugin> {
        if (!this.loader)
            throw new Error('Dynamic Workers loader is not configured');
        const name = 'harness-plugin:' + pluginId;
        for (const [id, previous] of this.allocations)
            if (previous.name === name) {
                await this.release(id);
            }
        const factory = installed?.module ?? `export default async function(harness){\n${source}\n}`;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([this.scope, pluginId, runId, kernelModule, factory])));
        const codeId = 'weft-native-host:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        const capability = this.capability?.(pluginId, runId);
        const worker = this.loader.get(codeId, () => ({
            compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], mainModule: 'kernel.js',
            modules: { 'kernel.js': kernelModule, 'weft:plugin-factory': { js: factory } },
            env: {...(capability ? {HOST: capability} : {}), ...(installed ? {ALLOWED: installed.services, BACKGROUND: installed.environment === true, ACTIVATION: installed.activationId ?? runId, ...(installed.config ? {CONFIG: installed.config} : {})} : {})}, globalOutbound: installed?.network && capability ? capability : null,
            limits: { cpuMs: 100, subRequests: 64 },
        }));
        const facet = this.state.facets.get(name, () => ({ class: worker.getDurableObjectClass('PluginFacet') })) as unknown as FacetApi;
        const allocation: Allocation = { name, runId, facet, disposers: [], deadlineMs: installed?.environment ? 60_000 : 15_000 };
        this.allocations.set(runId, allocation);
        try {
            const description = descriptionSchema.parse(await this.bounded(allocation, () => facet.describe()));
            const handlers = new Map<string, () => void>();
            const tools = new Map<string, {
                signature: string;
                dispose: () => void;
            }>();
            const sync = (metadata: Metadata) => {
                if (installed && !installed.services.includes('tools') && metadata.tools.length)
                    throw new Error('Plugin permission denied: tools');
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
                    if (installed?.environment) continue;
                    const dispose = registerRemoteTool(ctx, tool, {
                        execute: (name,args,callId,operationId) => this.bounded(allocation, () => facet.tool(name,args,callId,operationId)),
                        cancel: operationId => facet.cancelTool(operationId), waitUntil: work => this.state.waitUntil(work),
                    });
                    tools.set(tool.name, { signature, dispose });
                    allocation.disposers.push(dispose);
                }
            };
            sync({ ...description, tools: [] });
            return {
                name: description.name, inject: installed?.environment ? {} : description.inject as NonNullable<Plugin.Object['inject']>, apply: async (child) => {
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
    /** Serialized entry Config schemas of an evaluated bundle. */
    async configSchemas(runId: string): Promise<unknown> {
        const allocation = this.allocations.get(runId);
        if (!allocation) throw new Error('Plugin is not active');
        return this.bounded(allocation, () => allocation.facet.configSchemas());
    }
    async tick(runId: string): Promise<void> {
        const allocation = this.allocations.get(runId);
        if (allocation) await this.bounded(allocation, () => allocation.facet.tick());
    }
    async fetch(runId: string, request: Request): Promise<Response> {
        const allocation = this.allocations.get(runId);
        if (!allocation) return new Response(null, {status:404});
        return this.bounded(allocation, () => allocation.facet.fetch(request));
    }
    async nextAlarm(runId: string): Promise<number | undefined> {
        const allocation = this.allocations.get(runId);
        return allocation ? this.bounded(allocation, () => allocation.facet.nextAlarm()) : undefined;
    }
    async toolMetadata(runId: string) {
        const allocation=this.allocations.get(runId);if(!allocation)throw new Error('Plugin is not active');
        return metadataSchema.parse(await this.bounded(allocation,()=>allocation.facet.metadata())).tools;
    }
    async tool(runId:string,name:string,args:unknown,callId:string,operationId:string,callerSessionId?:string):Promise<ToolExecutionResult> {
        const allocation=this.allocations.get(runId);if(!allocation)throw new Error('Plugin is not active');
        return this.bounded(allocation,()=>allocation.facet.tool(name,args,callId,operationId,callerSessionId));
    }
    async cancelTool(runId:string,operationId:string):Promise<void> {await this.allocations.get(runId)?.facet.cancelTool(operationId);}
    async deliverWebhook(runId:string,delivery:unknown):Promise<void> {
        const allocation=this.allocations.get(runId);if(!allocation)throw new Error('Plugin is not active');
        await this.bounded(allocation,()=>allocation.facet.deliverWebhook(delivery));
    }
    async deliverConnectionEvents(runId: string, connectionId: string, events: unknown[]): Promise<'ok' | 'unknown'> {
        const allocation = this.allocations.get(runId); if (!allocation) throw new Error('Plugin is not active');
        return this.bounded(allocation, () => allocation.facet.deliverConnectionEvents(connectionId, events));
    }
    async deliverSessionEvent(runId: string, event: unknown): Promise<void> {
        const allocation = this.allocations.get(runId); if (!allocation) throw new Error('Plugin is not active');
        await this.bounded(allocation, () => allocation.facet.deliverSessionEvent(event));
    }
    async release(runId: string, destroy = false): Promise<void> {
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
            if (destroy) this.state.facets.delete(allocation.name);
            else this.state.facets.abort(allocation.name, new Error('Plugin activation stopped'));
        }
    }
    async reconcile(active: ReadonlySet<string>): Promise<void> {
        for (const id of this.allocations.keys())
            if (!active.has(id))
                await this.release(id);
    }
}
