import {Response, type V4FetchHandler} from 'miniflare';

/** Real Team tools and lifecycle; only the model HTTP response is controlled. */
export function nativeTeamModel() {
  const observations: {child: boolean; tools: string[]; body: string}[] = [];
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const outbound: V4FetchHandler = async request => {
    if (new URL(request.url).origin !== 'https://team-model.test') throw new Error('Unexpected Team outbound request');
    const body = await request.json() as {messages: {role: string; content: unknown}[]; tools?: {name: string}[]};
    const users = body.messages.filter(row => row.role === 'user').flatMap(row => Array.isArray(row.content) ? row.content.filter(block => block.type === 'text').map(block => String(block.text)) : [String(row.content)]).join('\n');
    const child = users.includes('TEAM_CHILD_SEED');
    const history = JSON.stringify(body.messages);
    const called = (name: string) => body.messages.some(row => row.role === 'assistant' && Array.isArray(row.content) && row.content.some(block => block.type === 'tool_use' && block.name === name));
    observations.push({child, tools: body.tools?.map(row => row.name) ?? [], body: JSON.stringify(body)});
    let name: string | undefined, input: object = {};
    if (!child && users.includes('CREATE_TEAM') && !called('spawn_teammate')) {
      name = 'spawn_teammate'; input = {name: 'reviewer', description: 'Review the shared workspace', prompt: 'TEAM_CHILD_SEED', context: 'fresh'};
    } else if (!child && users.includes('CREATE_TEAM') && !called('team_task_create')) {
      name = 'team_task_create'; input = {subject: 'Review plugin integration', description: 'Inspect the shared implementation', write_scopes: ['packages/native-bundles']};
    } else if (!child && users.includes('MESSAGE_TEAM') && !called('send_message')) {
      name = 'send_message'; input = {target: 'reviewer', message: 'WAKE_TEAM'};
    } else if (child && users.includes('WAKE_TEAM') && !called('send_message')) {
      name = 'send_message'; input = {target: 'lead', message: 'REVIEWER_ACK'};
    }
    // An old, frozen Session must not receive new Team tools.
    if (name && !body.tools?.some(tool => tool.name === name)) name = undefined;
    const text = child ? history.includes('WAKE_TEAM') ? 'TEAM_CHILD_AWAKE' : 'TEAM_CHILD_DONE' : 'TEAM_LEAD_DONE';
    return new Response(event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}})
      + event('content_block_start', {index: 0, content_block: name ? {type: 'tool_use', id: crypto.randomUUID(), name, input: {}} : {type: 'text', text: ''}})
      + event('content_block_delta', {index: 0, delta: name ? {type: 'input_json_delta', partial_json: JSON.stringify(input)} : {type: 'text_delta', text}})
      + event('content_block_stop', {index: 0})
      + event('message_delta', {delta: {stop_reason: name ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 4}}) + event('message_stop', {}),
      {headers: {'content-type': 'text/event-stream'}});
  };
  return {outbound, observations};
}
