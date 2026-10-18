import type { Context } from '@deepseek-ai/cordis';
import { SERVICE_API, EVENT_API, queryServiceApi, queryEventApi } from '@weft/upstream/packages/extensions/tool-cordis/src/api-catalog.ts';
import { z } from 'zod';
import { nativePluginFsMethods } from './protocol.ts';
import { nativeHostExample, nativeClientExample } from './guide.ts';
/** Native generated contracts and actual mounted tools, without the Node app boot graph. */
export function mountNativeInspectProviders(ctx: Context): void {
    const register = (id: string, method: string, field: string, query: (key?: string) => object) => {
        ctx.effect(() => ctx.cordisInspect.register({
            manifest: { id, description: 'Pinned native ' + id + ' API contracts for this workerd host.', methods: [{ name: method, description: 'Read the generated native contract.', inputSchema: { type: 'object', properties: { [field]: { type: 'string' } }, additionalProperties: false }, outputSchema: {} }] }, query: async (name, input) => {
                if (name !== method)
                    throw new Error('Unknown inspection method');
                const key = input && typeof input === 'object' && !Array.isArray(input) ? input[field] : undefined;
                return z.json().parse(query(typeof key === 'string' ? key : undefined));
            }
        }), 'weft.native-inspect:' + id);
    };
    const visibleServices = SERVICE_API.filter(service => ['tools', 'timer', 'fs'].includes(service.key) && ctx.get(service.key) !== undefined).map(service => ({
        ...service,
        methods: service.methods.filter(method => {
            const name = /^(?:(?:abstract|async)\s+)*(\w+)\s*(?:<|\()/.exec(method.signature)?.[1];
            return service.key === 'fs' ? nativePluginFsMethods.some(allowed => allowed === name) : service.key === 'tools' ? ['register', 'schemas', 'get'].includes(name ?? '') : true;
        }).map(method => service.key === 'tools' && method.signature.startsWith('get(') ? {...method, signature: 'get(name: string): ToolSchema | undefined', parameters: method.parameters.filter(parameter => parameter.name === 'name'), description: 'Read the visible tool schema; the native sandbox does not expose executable tool definitions.', returns: 'Tool schema, or undefined.'} : service.key === 'tools' && method.signature.startsWith('schemas(') ? {...method, signature: 'schemas(): ToolSchema[]', parameters: []} : method),
    }));
    register('Service', 'listService', 'service', key => queryServiceApi(key, visibleServices));
    register('Event', 'listEvent', 'event', key => queryEventApi(key, EVENT_API.filter(event => event.name.startsWith('tools/'))));
    ctx.effect(() => ctx.cordisInspect.register({
        manifest: { id: 'Tool', description: 'Tools actually visible to the owning Agent.', methods: [{ name: 'listTools', description: 'Read the current tool schemas.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: {} }] }, query: async (method, _input, { agent }) => {
            if (method !== 'listTools')
                throw new Error('Unknown tool inspection method');
            return z.json().parse({ tools: ctx.tools.schemas(agent) });
        }
    }), 'weft.native-inspect:Tool');
    ctx.effect(() => ctx.cordisInspect.register({
        manifest: { id: 'Workerd', description: 'Execution boundary of isolated Host plugin facets.', methods: [{ name: 'capabilities', description: 'Read supported isolate services and lifecycle limits.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: {} }] }, query: async (method) => {
            if (method !== 'capabilities')
                throw new Error('Unknown workerd inspection method');
            return {
                services: { tools: ['register', 'schemas', 'get'], timer: ['timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'], fs: [...nativePluginFsMethods] }, agentObjectsInIsolate: false, directNetwork: false, nodeProcesses: false,
                sourceContract: { host: 'JavaScript async function body with harness in scope; return a Cordis plugin. ctx exists only in returned apply(ctx), where declared services are accessed as ctx.fs/ctx.tools/ctx.timer. Resolve a path with await ctx.fs.resolve(path) before passing its FsTarget result to read/write methods; bare path strings are invalid there. No top-level ctx, harness.fs, React, imports of application modules, or systemPrompt.', client: 'JavaScript async function body with React and host in scope; return a Cordis plugin. Access slots/styles through declared injection in apply(ctx). Use React.createElement, not JSX.', handlers: 'Register harness.handle(method, async args => JSON) inside apply(ctx). ctx.effect(() => harness.handle(...)) owns cleanup. host.call(method,args) resolves to the returned JSON value. Unsupported services fail activation.' },
                hostExample: nativeHostExample, clientExample: nativeClientExample,
                eventScope: 'Host listeners observe only the local isolated services, including tools/* events. Parent Agent/session events and arbitrary parent services are not bridged.',
                slotRegistration: 'ctx.slots.register({name:FULL_SLOT_PATH,id:UNIQUE_ENTRY_ID,order:10}, Component). name selects the slot, id identifies this contribution. Registration metadata describes contribution fields, not the name selector.',
            };
        }
    }), 'weft.native-inspect:Workerd');
}
