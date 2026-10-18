import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Response, type V4FetchHandler } from 'miniflare';

export const hostCode = `let count=0; return {name:'Native counter',inject:['fs'],apply(ctx){harness.handle('increment',async()=>{const target=await ctx.fs.resolve('plugin-counter.txt');await ctx.fs.writeText(target,'count:'+ ++count);return {count}})}}`;
export const clientCode = `return {inject:['slots'],apply(ctx){function Counter(){const [count,setCount]=React.useState(0);return React.createElement('button',{onClick:async()=>setCount((await host.call('increment',null)).count)},'Native count '+count)}ctx.slots.register({name:'conversation.session.header.utilities',id:'native-counter'},Counter)}}`;
function response(tool?: {name: string; input: unknown}): Response {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
  return new Response(event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) + event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: 'plugin-'+randomUUID(), name: tool.name, input: {}} : {type: 'text', text: ''}}) + event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: JSON.stringify(tool.input)} : {type: 'text_delta', text: 'Native plugin ready for review'}}) + event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}), {headers: {'content-type': 'text/event-stream'}});
}
export {response as nativeFixtureResponse};
function receiptIn(value: unknown): {pluginId: string; packageId: string} | undefined {
  if (typeof value === 'string') {try {return receiptIn(JSON.parse(value));} catch {return undefined;}}
  if (!value || typeof value !== 'object') return;
  if ('pluginId' in value && 'packageId' in value && typeof value.pluginId === 'string' && typeof value.packageId === 'string') return {pluginId: value.pluginId, packageId: value.packageId};
  for (const child of Object.values(value)) {const result = receiptIn(child); if (result) return result;}
}
/** Transport fixture only: native tools, Runner, approval and facets are real. */
export function nativePluginModel(code = {host: hostCode, client: clientCode}, inspectBoundary = false) {
  let calls = 0;
  let inspection: {services: {key: string; methods: {signature: string}[]}[]} | undefined;
  let primary: {pluginId: string; packageId: string} | undefined;
  let update = 0;
  const outbound: V4FetchHandler = async request => {
    const body = await request.json();
    const step = ++calls - Number(inspectBoundary);
    if (step === 0) return response({name: 'cordis_inspect_query', input: {platform: 'host', provider: 'Service', method: 'listService', input: {}}});
    if (step === 1) {
      if (inspectBoundary) {
        const find = (value: unknown): {services: {key: string; methods: {signature: string}[]}[]} | undefined => {
          if (typeof value === 'string') {try {return find(JSON.parse(value));} catch {return;}}
          if (!value || typeof value !== 'object') return;
          if ('services' in value && Array.isArray(value.services)) return value as ReturnType<typeof find>;
          for (const child of Object.values(value)) {const result = find(child); if (result) return result;}
        };
        inspection = find(body);
      }
      return response({name: 'cordis_define', input: {plugin: {kind: 'new', idPrefix: 'count'}, name: 'Native counter', purpose: 'A user approved counter backed by a scoped workspace', code}});
    }
    if (step === 2) {const receipt = primary = receiptIn(body); assert.ok(receipt, 'native model request must carry the real definition receipt'); return response({name: 'cordis_run', input: {...receipt, mode: 'run'}});}
    if (update === 1) {update++; return response({name: 'cordis_define', input: {plugin: {kind: 'existing', pluginId: primary!.pluginId}, name: 'Counter version two', purpose: 'An update which still requires exact user approval', code: {host: hostCode, client: clientCode}}});}
    if (update === 2) {update++; const receipt = receiptIn((body as {messages: unknown[]}).messages.toReversed()); assert.ok(receipt); return response({name: 'cordis_run', input: {...receipt, mode: 'update'}});}
    if (update === 3) update = 0;
    return response();
  };
  return {outbound, calls: () => calls, inspection: () => inspection, requestUpdate() {assert.ok(primary); update = 1;}};
}
