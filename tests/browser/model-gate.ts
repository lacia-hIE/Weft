import { Response, type V4FetchHandler } from 'miniflare';

/** Deterministic model transport; execution, tools and storage still run in workerd. */
export function modelGate() {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://browser-model.test') throw new Error('Unexpected fixture outbound request');
    const call = ++calls;
    if (call === 1) await gate;
    const tool = call === 1;
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: 'identity', name: 'tenant_identity', input: {}} : {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: '{}'} : {type: 'text_delta', text: 'Queue response '+call}}) +
      event('content_block_stop', {index: 0}) +
      event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 3}}) +
      event('message_stop', {}), {headers: {'content-type': 'text/event-stream'}},
    );
  };
  return {outbound, release, calls: () => calls};
}
