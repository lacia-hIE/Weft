import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Response, type V4FetchHandler} from 'miniflare';
import {McpServer, createMcpHandler} from '@modelcontextprotocol/server';
import {z} from 'zod';
import type {SettingsDescribeValue} from '@deepseek-ai/dsh-settings/types';
import {createRuntime} from './helpers/miniflare.ts';
import {nativeClient} from './helpers/native.ts';

const TOOL = 'mcp__demo__echo';
/** The model calls the MCP tool once per CALL_MCP prompt, then answers. */
function mcpModel() {
  const requests: {tools?: {name: string}[]; messages: {role: string; content: unknown}[]}[] = [];
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
  const outbound: V4FetchHandler = async request => {
    const body = await request.json() as typeof requests[number];
    requests.push(body);
    const start = body.messages.findLastIndex(row => row.role === 'user' && JSON.stringify(row.content).includes('CALL_MCP'));
    const called = body.messages.slice(start + 1).some(row => row.role === 'assistant' && JSON.stringify(row.content).includes(TOOL));
    const tool = start >= 0 && !called && body.tools?.some(row => row.name === TOOL);
    return new Response(event('message_start', {message: {usage: {input_tokens: 10, output_tokens: 0}}})
      + event('content_block_start', {index: 0, content_block: tool ? {type: 'tool_use', id: crypto.randomUUID(), name: TOOL, input: {}} : {type: 'text', text: ''}})
      + event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: '{"text":"hello"}'} : {type: 'text_delta', text: 'MCP_DONE'}})
      + event('content_block_stop', {index: 0}) + event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 3}}) + event('message_stop', {}),
    {headers: {'content-type': 'text/event-stream'}});
  };
  return {outbound, requests};
}

test('environment MCP servers mount the original client over Streamable HTTP with write-only headers', {timeout: 150000}, async () => {
  const model = mcpModel(), authorizations: (string | null)[] = [];
  const mcp = createMcpHandler(() => {
    const server = new McpServer({name: 'demo', version: '1.0.0'});
    server.registerTool('echo', {description: 'Echo the text', inputSchema: z.object({text: z.string()})}, async ({text}) => ({content: [{type: 'text', text: 'echo:' + text}]}));
    return server;
  });
  const runtime = createRuntime(undefined, {
    bindings: {MODEL_BACKEND: 'deepseek', DEEPSEEK_API_KEY: 'mcp-fixture', DEEPSEEK_BASE_URL: 'https://mcp-model.test/anthropic'},
    outbound: async (request, mf) => {
      const target = new URL(request.url);
      if (target.hostname === 'mcp-model.test') return model.outbound(request, mf);
      if (target.hostname === 'mcp.example.test') {
        authorizations.push(request.headers.get('authorization'));
        return await mcp.fetch(new Request(request.url, {method: request.method, headers: Object.fromEntries(request.headers), ...(request.method === 'GET' || request.method === 'HEAD' ? {} : {body: await request.text()})})) as never;
      }
      return new Response('not found', {status: 404});
    },
  });
  const api = nativeClient(() => runtime);
  const form = async () => (await api.call<SettingsDescribeValue>('settings/describe', {})).namespaces.find(row => row.ns === 'mcp-servers')!;
  const server = {name: 'demo', url: 'https://mcp.example.test/mcp', headers: {Authorization: 'Bearer mcp-token'}};
  const turn = async (sessionId: string) => {
    const follow = await api.follow(sessionId); await follow.next();
    try {
      await api.call('session/prompt', {request: {sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{type: 'text', text: 'CALL_MCP ' + crypto.randomUUID()}]}});
      for (;;) {const frame = await follow.next(); if (frame.type === 'event' && frame.event.type === 'turn/end') break;}
    } finally {await follow.close();}
  };
  try {
    const initial = await form();
    assert.equal((await api.raw('settings/update', {ns: 'mcp-servers', patch: {servers: [{...server, url: 'http://mcp.example.test/mcp'}]}, expectedRevision: initial.revision})).result.error?.code, 'settings/rejected', 'Plain HTTP endpoints are refused');
    assert.equal((await api.raw('settings/update', {ns: 'mcp-servers', patch: {servers: [server, server]}, expectedRevision: initial.revision})).result.error?.code, 'settings/rejected', 'Server names are unique');
    await api.call('settings/update', {ns: 'mcp-servers', patch: {servers: [server]}, expectedRevision: initial.revision});
    assert.doesNotMatch(JSON.stringify((await form()).value), /mcp-token/, 'Header values are write-only');

    await api.call('session/create', {request: {sessionId: 'mcp'}});
    await turn('mcp');
    const toolNames = model.requests.find(request => request.tools?.length)?.tools?.map(tool => tool.name) ?? [];
    assert.ok(toolNames.includes(TOOL), JSON.stringify(toolNames));
    assert.ok(toolNames.includes('list_mcp_resources'), 'The original resource tools appear once a server is configured');
    assert.match(JSON.stringify(model.requests.at(-1)!.messages), /echo:hello/, 'The tool result reached the model');
    assert.ok(authorizations.length > 0 && authorizations.every(value => value === 'Bearer mcp-token'));

    const current = await form();
    await api.call('settings/update', {ns: 'mcp-servers', patch: {servers: [{...server, enabled: false}]}, expectedRevision: current.revision});
    const before = model.requests.length;
    await turn('mcp');
    assert.ok(model.requests.slice(before).every(request => !request.tools?.some(tool => tool.name === TOOL)), 'A disabled server leaves the live Session before its next turn');
  } finally {await runtime.dispose();}
});
