// Opt-in real-model smoke against npm run dev; credentials stay in the server's ignored .env.
import assert from 'node:assert/strict';
const base = 'http://localhost:8787';
const identity = await fetch(`${base}/v1/me`);
assert.equal(identity.status, 200, 'Start npm run dev first');
const { tenantId } = await identity.json();
const suffix = String(Date.now());
const workspaceId = `live-workspace-${suffix}`, sessionId = `workspace-agent-${suffix}`;
const session = `${base}/v1/tenants/${tenantId}/sessions/${sessionId}`;
const workspace = `${base}/v1/tenants/${tenantId}/workspaces/${workspaceId}`;
const started = Date.now();
const response = await fetch(`${session}/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
  body: JSON.stringify({ workspaceId, text: '验证文件工具：用 write 创建 /workspace/notes/verification.txt，内容严格为 Weft workspace proof A；用 read 读取它；用 edit 将 proof A 替换成 proof B；再次用 read 确认。必须实际调用以上工具，最后简短确认。' }),
  signal: AbortSignal.timeout(120_000),
});
assert.equal(response.status, 200);
const text = await response.text();
const frames = text.trim().split('\n\n').map(frame => { const lines = frame.split('\n'); return { event: lines[0].slice(7), data: JSON.parse(lines[1].slice(6)) }; });
assert.equal(frames.find(frame => frame.event === 'error'), undefined);
assert.equal(frames.at(-1)?.event, 'done');
const history = await (await fetch(`${session}/events`)).json();
const tools = history.events.filter(event => event.type === 'tool/call').map(event => event.data.name);
for (const name of ['read', 'write', 'edit']) assert.ok(tools.includes(name), `Missing actual native tool call: ${name}`);
assert.equal(history.events.at(-1).data.reason.kind, 'completed');
const fileResponse = await fetch(`${workspace}/files?path=${encodeURIComponent('/workspace/notes/verification.txt')}`);
assert.equal(fileResponse.status, 200);
const { value: file } = await fileResponse.json();
assert.equal(file.content.trim(), 'Weft workspace proof B');
assert.equal(file.version, '2');
const other = await fetch(`${base}/v1/tenants/${tenantId}/sessions/reader-${suffix}/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ workspaceId, text: '用 read 实际读取 /workspace/notes/verification.txt，然后简短复述文件内容。' }), signal: AbortSignal.timeout(90_000),
});
assert.equal(other.status, 200);
const second = await other.json();
assert.ok(second.events.some(event => event.type === 'tool/call' && event.data.name === 'read'));
assert.ok(JSON.stringify(second.events).includes('Weft workspace proof B'));
assert.equal(second.events.filter(event => event.type === 'turn/end').length, 1);
console.log(JSON.stringify({ live: true, workspaceId, sessionId, model: second.model, tools, fileVersion: file.version,
  sharedAcrossSessions: true, durationMs: Date.now() - started }));
