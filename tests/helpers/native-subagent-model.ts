import {Response, type V4FetchHandler} from 'miniflare';

/** Only model HTTP is controlled; the real native tool creates and drives children. */
export function nativeSubagentModel() {
  const ready = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const observations: {child: boolean; messages: unknown[]}[] = [];
  let delegated = false;
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://subagent-model.test') throw new Error('Unexpected subagent fixture outbound request');
    const body = await request.json() as {messages: {role: string; content: unknown}[]};
    const child = body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('CHILD_TASK_ALPHA'));
    observations.push({child, messages: body.messages});
    if (child && !JSON.stringify(body.messages).includes('CHILD_FOLLOW_BETA')) {ready.resolve(); await released.promise;}
    const tool = !child && !delegated && JSON.stringify(body.messages).includes('PARENT_TASK');
    if (tool) delegated = true;
    const args = JSON.stringify({description: 'Native delegated task', prompt: 'CHILD_TASK_ALPHA'});
    const text = child ? JSON.stringify(body.messages).includes('CHILD_FOLLOW_BETA') ? 'CHILD_FOLLOW_REPLY' : 'CHILD_NATIVE_REPLY' : 'PARENT_NATIVE_REPLY';
    return new Response(
      event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}}) +
      event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: 'delegate', name: 'subagent', input: {}} : {type: 'text', text: ''}}) +
      event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: args} : {type: 'text_delta', text}}) +
      event('content_block_stop', {index: 0}) +
      event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };
  return {outbound, ready: ready.promise, release: () => released.resolve(), observations};
}
