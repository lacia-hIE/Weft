import type { Context, Plugin } from '@deepseek-ai/cordis';
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import {registerRemoteTool, toolDescriptions} from './tool-bridge.ts';
import { kernelModule } from '../../../.generated/native-plugin-kernel.ts';
import {createHash} from 'node:crypto';

// The bundled kernel is large. Hash it once, rather than serializing and hashing it for every activation.
const kernelRevision = createHash('sha256').update(kernelModule).digest('hex');
const COMPATIBILITY_DATE = '2026-07-30', COMPATIBILITY_FLAGS = ['nodejs_compat'];
const descriptionSchema = z.object({ name: z.string().max(200), inject: z.record(z.string().max(100), z.json()), handlers: z.array(z.string().min(1).max(100)).max(100) });
const metadataSchema = descriptionSchema.extend({tools:toolDescriptions});
type Metadata = z.infer<typeof metadataSchema>;
interface FacetApi {
    setHost(activationId: string, host: Fetcher): Promise<void>;
    describe(): Promise<unknown>;
    configSchemas(): Promise<unknown>;
    metadata(): Promise<unknown>;
    deliverWebhook(delivery: unknown): Promise<void>;
    deliverSessionEvent(event: unknown): Promise<void>;
    deliverConnectionEvents(connectionId: string, events: unknown[]): Promise<'ok' | 'unknown'>;
    deliverIm(bot: string, event: unknown): Promise<'delivered' | 'unclaimed'>;
    answerIm(caller: string, bot: string, operation: string, argument: unknown): Promise<{handled: false} | {handled: true; value: unknown}>;
    consumesIm(): Promise<boolean>;
    assignedIm(caller: string): Promise<{bot: string; kind: string; name?: string}[]>;
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
    activationId: string;
    host?: Fetcher;
}
/**
 * Per-invocation limits of a plugin's Dynamic Worker. A Session tool runs one bounded call per invocation. An
 * environment package wakes in whatever invocation reaches it first and runs its own work there, such as a background
 * pass with many outbound reads and Host calls, so it gets the Workers Paid default subrequest limit.
 */
const SESSION_LIMITS = { cpuMs: 100, subRequests: 64 }, ENVIRONMENT_LIMITS = { cpuMs: 100, subRequests: 10_000 };
/** The trusted bridge runs no user source in the main Harness isolate. */
export class NativePluginPlatform {
    private readonly allocations = new Map<string, Allocation>();
    private faultHandler: ((runId: string, error: Error) => void) | undefined;
    onFault(handler: (runId: string, error: Error) => void): void { this.faultHandler = handler; }
    constructor(private readonly state: DurableObjectState, private readonly loader: WorkerLoader | undefined, private readonly scope: object, private readonly capability?: (pluginId: string, runId: string) => Fetcher) { }
    private async bounded<T>(allocation: Allocation, operation: (facet: FacetApi) => Promise<T>, releasing = false): Promise<T> {
        const assertActive = () => {
            if (!releasing && this.allocations.get(allocation.runId) !== allocation) throw new Error('Plugin activation has stopped');
        };
        assertActive();
        const timer = setTimeout(() => {
            const error = new Error('Dynamic plugin operation deadline exceeded');
            this.state.facets.abort(allocation.name, error);
            if (!allocation.releasing)
                this.faultHandler?.(allocation.runId, error);
        }, allocation.deadlineMs);
        try {
            // Reattach after a facet wake as well as on first use. Service bindings cannot be placed in
            // Durable Object class props on Cloudflare production, but can cross an ordinary RPC call.
            const facet = allocation.facet;
            if (allocation.host) await facet.setHost(allocation.activationId, allocation.host);
            assertActive();
            return await operation(facet);
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
        const capability = this.capability?.(pluginId, runId);
        // Class props must contain data only: a service binding there fails with an internal error in production.
        // Environment and networked Workers already have a stable captured receipt; reusable offline Workers
        // receive their run-bound capability over RPC instead of putting it in the cached environment.
        const outbound = installed?.network && capability ? capability : null;
        const fixedHost = capability && (installed?.environment || outbound) ? capability : undefined;
        const fixedReceipt = fixedHost ? (installed?.environment && installed.activationId !== undefined ? installed.activationId : runId) : null;
        const definition = installed ? {services: installed.services, environment: installed.environment === true, network: installed.network === true,
            activationId: installed.activationId ?? null, config: installed.config ?? null} : null;
        const limits = installed?.environment ? ENVIRONMENT_LIMITS : SESSION_LIMITS;
        // Include the actual supervisor ID: session names and caller-provided scopes need not be globally unique.
        const codeId = 'weft-native-host:' + createHash('sha256').update(JSON.stringify([
            this.state.id.toString(), this.scope, pluginId, fixedReceipt, kernelRevision, factory, definition,
            COMPATIBILITY_DATE, COMPATIBILITY_FLAGS, limits,
        ])).digest('hex');
        const worker = this.loader.get(codeId, () => ({
            compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: COMPATIBILITY_FLAGS, mainModule: 'kernel.js',
            modules: { 'kernel.js': kernelModule, 'weft:plugin-factory': { js: factory } },
            ...(fixedHost ? {env: {HOST: fixedHost}} : {}),
            globalOutbound: outbound, limits,
        }));
        const activationId = installed?.activationId ?? runId;
        const props = {ACTIVATION: activationId, ...(installed ? {ALLOWED: installed.services, BACKGROUND: installed.environment === true, ...(installed.config ? {CONFIG: installed.config} : {})} : {})};
        const getFacet = () => this.state.facets.get(name, () => ({ class: worker.getDurableObjectClass('PluginFacet', {props}) })) as unknown as FacetApi;
        const allocation: Allocation = { name, runId, get facet() {return getFacet();}, disposers: [], deadlineMs: installed?.environment ? 60_000 : 15_000,
            activationId, ...(capability && !fixedHost ? {host: capability} : {}) };
        this.allocations.set(runId, allocation);
        try {
            const description = descriptionSchema.parse(await this.bounded(allocation, facet => facet.describe()));
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
                            const result = await this.bounded(allocation, facet => facet.invoke(method, args));
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
                        execute: (name,args,callId,operationId) => this.bounded(allocation, facet => facet.tool(name,args,callId,operationId)),
                        cancel: operationId => this.cancelTool(runId, operationId), waitUntil: work => this.state.waitUntil(work),
                    });
                    tools.set(tool.name, { signature, dispose });
                    allocation.disposers.push(dispose);
                }
            };
            sync({ ...description, tools: [] });
            return {
                name: description.name, inject: installed?.environment ? {} : description.inject as NonNullable<Plugin.Object['inject']>, apply: async (child) => {
                    child.effect(() => () => this.release(runId), 'weft.native-plugin-facet');
                    sync(metadataSchema.parse(await this.bounded(allocation, facet => facet.start())));
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
        return this.bounded(allocation, facet => facet.configSchemas());
    }
    async tick(runId: string): Promise<void> {
        const allocation = this.allocations.get(runId);
        if (allocation) await this.bounded(allocation, facet => facet.tick());
    }
    async fetch(runId: string, request: Request): Promise<Response> {
        const allocation = this.allocations.get(runId);
        if (!allocation) return new Response(null, {status:404});
        return this.bounded(allocation, facet => facet.fetch(request));
    }
    async nextAlarm(runId: string): Promise<number | undefined> {
        const allocation = this.allocations.get(runId);
        return allocation ? this.bounded(allocation, facet => facet.nextAlarm()) : undefined;
    }
    async toolMetadata(runId: string) {
        const allocation=this.allocations.get(runId);if(!allocation)throw new Error('Plugin is not active');
        return metadataSchema.parse(await this.bounded(allocation,facet=>facet.metadata())).tools;
    }
    async tool(runId:string,name:string,args:unknown,callId:string,operationId:string,callerSessionId?:string):Promise<ToolExecutionResult> {
        const allocation=this.allocations.get(runId);if(!allocation)throw new Error('Plugin is not active');
        return this.bounded(allocation,facet=>facet.tool(name,args,callId,operationId,callerSessionId));
    }
    async cancelTool(runId:string,operationId:string):Promise<void> {await this.allocations.get(runId)?.facet.cancelTool(operationId);}
    async deliverWebhook(runId:string,delivery:unknown):Promise<void> {
        const allocation=this.allocations.get(runId);if(!allocation)throw new Error('Plugin is not active');
        await this.bounded(allocation,facet=>facet.deliverWebhook(delivery));
    }
    async deliverConnectionEvents(runId: string, connectionId: string, events: unknown[]): Promise<'ok' | 'unknown'> {
        const allocation = this.allocations.get(runId); if (!allocation) throw new Error('Plugin is not active');
        return this.bounded(allocation, facet => facet.deliverConnectionEvents(connectionId, events));
    }
    async deliverIm(runId: string, bot: string, event: unknown): Promise<'delivered' | 'unclaimed'> {
        const allocation = this.allocations.get(runId); if (!allocation) throw new Error('Plugin is not active');
        return this.bounded(allocation, facet => facet.deliverIm(bot, event));
    }
    async answerIm(runId: string, caller: string, bot: string, operation: string, argument: unknown): Promise<{handled: false} | {handled: true; value: unknown}> {
        const allocation = this.allocations.get(runId); if (!allocation) throw new Error('Plugin is not active');
        return this.bounded(allocation, facet => facet.answerIm(caller, bot, operation, argument));
    }
    async consumesIm(runId: string): Promise<boolean> {
        const allocation = this.allocations.get(runId); if (!allocation) throw new Error('Plugin is not active');
        return this.bounded(allocation, facet => facet.consumesIm());
    }
    async assignedIm(runId: string, caller: string): Promise<{bot: string; kind: string; name?: string}[]> {
        const allocation = this.allocations.get(runId); if (!allocation) throw new Error('Plugin is not active');
        return this.bounded(allocation, facet => facet.assignedIm(caller));
    }
    async deliverSessionEvent(runId: string, event: unknown): Promise<void> {
        const allocation = this.allocations.get(runId); if (!allocation) throw new Error('Plugin is not active');
        await this.bounded(allocation, facet => facet.deliverSessionEvent(event));
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
            await this.bounded(allocation, facet => facet.stop(), true);
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
