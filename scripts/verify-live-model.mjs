// Run against `npm run dev` after configuring this environment in Settings → Models.
// This opt-in smoke is separate from the keyless regression suite.
import assert from 'node:assert/strict';

const base = 'http://localhost:8787';
const identity = await fetch(`${base}/v1/me`);
assert.equal(identity.status, 200, 'Start npm run dev and configure Settings → Models');
const { tenantId } = await identity.json();
const sessionId = `live-deepseek-${Date.now()}`;
const path = `${base}/v1/tenants/${tenantId}/sessions/${sessionId}`;
const started = Date.now();
const response = await fetch(`${path}/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
  body: JSON.stringify({ text: '必须先调用 tenant_identity 工具一次确认租户身份，再用一句中文简短确认工具已成功执行。' }),
  signal: AbortSignal.timeout(90_000),
});
assert.equal(response.status, 200);
let text = '', firstDeltaMs;
const decoder = new TextDecoder();
for await (const bytes of response.body) {
  text += decoder.decode(bytes, { stream: true });
  if (firstDeltaMs === undefined && text.includes('text-delta')) firstDeltaMs = Date.now() - started;
}
const frames = text.trim().split('\n\n').map(frame => {
  const lines = frame.split('\n');
  return { event: lines[0].slice(7), data: JSON.parse(lines[1].slice(6)) };
});
assert.equal(frames.find(frame => frame.event === 'error'), undefined, 'Model stream failed');
assert.equal(frames.at(-1)?.event, 'done');
assert.equal(frames.at(-1).data.model.provider, 'deepseek-official');
const before = await (await fetch(`${path}/events`)).json();
assert.ok(before.events.some(event => event.type === 'tool/call'), 'Model must actually invoke the tool');
assert.equal(before.events.at(-1).data.reason.kind, 'completed');
const followup = await fetch(`${path}/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '沿用刚才的会话，用一句话确认已恢复对话。' }), signal: AbortSignal.timeout(90_000),
});
assert.equal(followup.status, 200);
const after = await followup.json();
assert.deepEqual(after.events.slice(0, before.events.length), before.events);
assert.equal(after.events.filter(event => event.type === 'turn/end').length, 2);
assert.equal(after.events.at(-1).data.reason.kind, 'completed');
console.log(JSON.stringify({ live: true, sessionId, model: after.model, firstDeltaMs, durationMs: Date.now() - started,
  toolCalls: before.events.filter(event => event.type === 'tool/call').length, turns: 2, persistedPrefixPreserved: true }));
