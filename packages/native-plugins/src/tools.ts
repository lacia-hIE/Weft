import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { CordisDynamicPackageId, CordisDynamicPluginId } from '@deepseek-ai/dsh-cordis-host-runner/types';
import { z } from 'zod';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { NATIVE_PLUGIN_GUIDE } from './guide.ts';
const request = z.object({ plugin: z.discriminatedUnion('kind', [z.object({ kind: z.literal('new'), idPrefix: z.string() }), z.object({ kind: z.literal('existing'), pluginId: z.string() })]), name: z.string(), purpose: z.string(), code: z.object({ host: z.string().optional(), client: z.string().optional() }) });
const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
const agent = (exec: ToolExecution): Agent => { if (!exec.agent)
    throw new Error('Plugin authoring requires the owning Agent'); return exec.agent; };
const json = (value: unknown): JsonValue => z.json().parse(value);
/** Small authoring surface; the pinned service owns versioning and approvals. */
export function mountNativePluginTools(ctx: Context): void {
    ctx.tools.register(defineTool({
        name: 'cordis_define', description: 'Define an immutable Cordis plugin package. Defining does not run code.' + NATIVE_PLUGIN_GUIDE, parameters: {
            plugin: { type: 'object', required: true, additionalProperties: false, properties: { kind: { type: 'string', required: true, enum: ['new', 'existing'] }, idPrefix: { type: 'string' }, pluginId: { type: 'string' } } },
            name: { type: 'string', required: true }, purpose: { type: 'string', required: true }, code: { type: 'object', required: true, additionalProperties: false, properties: { host: { type: 'string' }, client: { type: 'string' } } },
        }, output, execute: async (args, exec) => {
            const parsed = request.parse(args), owner = agent(exec);
            return json(ctx.dynamicCordisRunner.define({ sessionId: owner.id, name: parsed.name, purpose: parsed.purpose, code: { ...(parsed.code.host === undefined ? {} : { host: parsed.code.host }), ...(parsed.code.client === undefined ? {} : { client: parsed.code.client }) }, plugin: parsed.plugin.kind === 'new' ? parsed.plugin : { kind: 'existing', pluginId: parsed.plugin.pluginId as CordisDynamicPluginId } }));
        }
    }));
    ctx.tools.register(defineTool({
        name: 'cordis_run', description: 'Run or update an exact immutable plugin package. A client half requests explicit user approval; never claim it ran before the native response says running.', parameters: { pluginId: { type: 'string', required: true }, packageId: { type: 'string', required: true }, mode: { type: 'string', required: true, enum: ['run', 'update'] } }, output,
        execute: async (args, exec) => json(await ctx.dynamicCordisRunner.run(agent(exec), args.pluginId as CordisDynamicPluginId, args.packageId as CordisDynamicPackageId, args.mode as 'run' | 'update', exec.signal)),
    }));
    for (const name of ['cordis_stop', 'cordis_undefine'] as const)
        ctx.tools.register(defineTool({
            name, description: name === 'cordis_stop' ? 'Stop the owned plugin and retract its tools, UI and handlers.' : 'Remove the owned plugin and all immutable package definitions.', parameters: { pluginId: { type: 'string', required: true } }, output,
            execute: async (args, exec) => json(await (name === 'cordis_stop' ? ctx.dynamicCordisRunner.stop(agent(exec), args.pluginId as CordisDynamicPluginId) : ctx.dynamicCordisRunner.undefine(agent(exec), args.pluginId as CordisDynamicPluginId))),
        }));
    ctx.tools.register(defineTool({
        name: 'cordis_inspect_self', description: 'Read owned plugin versions and lifecycle state; supply packageId to read an exact stored source version.', parameters: { pluginId: { type: 'string' }, packageId: { type: 'string' } }, output, execute: async (args, exec) => {
            const owner = agent(exec);
            if (!args.pluginId)
                return json(ctx.dynamicCordisRunner.listPlugins(owner));
            return json(args.packageId ? ctx.dynamicCordisRunner.inspectPackage(owner, args.pluginId as CordisDynamicPluginId, args.packageId as CordisDynamicPackageId) : ctx.dynamicCordisRunner.inspectPlugin(owner, args.pluginId as CordisDynamicPluginId));
        }
    }));
}
