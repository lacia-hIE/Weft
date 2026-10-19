import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolve} from 'node:path';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import type {SessionSearchPage, SessionSearchHit, SessionEventSearchPage} from '@deepseek-ai/dsh-session-query';

function runtime() {
  const options = convertV4MiniflareOptions({workers: [{name: 'query', modules: true,
    scriptPath: resolve('dist/native-query-worker.js'), compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
    durableObjects: {QUERY: {className: 'QueryDO', useSQLite: true}}}]});
  for (const worker of options.workers) worker.dev = {...worker.dev, unsafeRegisterWorker: false};
  return new Miniflare(options);
}
async function call<Value>(instance: Miniflare, body: object, owner = 'query'): Promise<Value> {
  const response = await instance.dispatchFetch(`http://query.local/${owner}`, {method: 'POST', body: JSON.stringify(body)});
  const result = await response.json() as {value: Value; error?: string; code?: string};
  assert.equal(response.status, 200, JSON.stringify(result));
  return result.value;
}
type Page = SessionSearchPage<SessionSearchHit>;

test('opening the native execution query cannot clear the reader live corpus or invalidate its cursor', async () => {
  const instance = runtime();
  try {
    await call(instance, {mode: 'live', id: 'live-a', text: 'shared live needle'});
    await call(instance, {mode: 'live', id: 'live-b', text: 'shared live needle'});
    const first = await call<Page>(instance, {mode: 'search', query: {query: 'needle', limit: 1}});
    assert.ok(first.nextCursor);
    assert.equal((await call<Page>(instance, {mode: 'runtime-search', query: {query: 'needle'}})).items.length, 0);
    const second = await call<Page>(instance, {mode: 'search', query: {query: 'needle', limit: 1, cursor: first.nextCursor}});
    assert.equal(new Set([...first.items, ...second.items].map(item => item.header.id)).size, 2);
  } finally {await instance.dispose();}
});

test('the official SQLite provider searches a complete durable corpus, preserves ranking and invalidates stale cursors', async () => {
  const instance = runtime();
  try {
    const records = Array.from({length: 205}, (_, i) => ({id: `session-${i.toString().padStart(3, '0')}`, text: i === 0 ? 'needle needle shortest' : `needle ordinary document ${i}`, time: i + 1}));
    await call(instance, {mode: 'seed', records});
    const first = await call<Page>(instance, {mode: 'search', query: {query: 'needle', limit: 100}});
    assert.equal(first.items.length, 100);
    assert.equal(first.items[0]!.header.id, 'session-000');
    assert.equal(first.items[0]!.live, false); assert.equal(first.items[0]!.persisted, true);
    assert.ok(first.nextCursor);
    const second = await call<Page>(instance, {mode: 'search', query: {query: 'needle', limit: 100, cursor: first.nextCursor}});
    const last = await call<Page>(instance, {mode: 'search', query: {query: 'needle', limit: 100, cursor: second.nextCursor}});
    assert.equal(last.items.length, 5); assert.equal(last.nextCursor, undefined);
    assert.equal(new Set([...first.items, ...second.items, ...last.items].map(hit => hit.header.id)).size, 205);
    const api = await call<{items: {sessionId: string}[]; hasMore: boolean}>(instance, {mode: 'api-search', text: 'needle'});
    assert.equal(api.items.length, 20); assert.equal(api.hasMore, true);
    assert.equal(api.items[0]!.sessionId, 'session-000');
    assert.equal((await call<Page>(instance, {mode: 'search', query: {query: 'needle'}}, 'other')).items.length, 0);
    await call(instance, {mode: 'seed', records: [{id: 'newest', text: 'needle changed', time: 999}]});
    const stale = await instance.dispatchFetch('http://query.local/query', {method: 'POST', body: JSON.stringify({mode: 'search', query: {query: 'needle', limit: 100, cursor: first.nextCursor}})});
    assert.equal((await stale.json() as {code: string}).code, 'SESSION_QUERY_STALE_CURSOR');
    await call(instance, {mode: 'reset'});
    assert.equal((await call<Page>(instance, {mode: 'search', query: {query: 'needle', limit: 100}})).items.length, 100);
    assert.equal((await call<{canonical: number}>(instance, {mode: 'stats'})).canonical, 206);
  } finally {await instance.dispose();}
});

test('live native sessions and semantic documents retain official text and observation behavior', async () => {
  const instance = runtime();
  try {
    await call(instance, {mode: 'live', id: 'live', text: 'A multilingual AI helper 搜索 🌍'});
    const unicode = await call<Page>(instance, {mode: 'search', query: {query: '搜索'}});
    assert.equal(unicode.items[0]!.header.id, 'live'); assert.equal(unicode.items[0]!.live, true); assert.equal(unicode.items[0]!.persisted, false);
    await call(instance, {mode: 'assistant', id: 'live', text: 'visible answer marker'});
    assert.equal((await call<Page>(instance, {mode: 'search', query: {query: 'private-reasoning-marker'}})).items.length, 0);
    const visible = await call<SessionEventSearchPage>(instance, {mode: 'events', events: {sessionId: 'live', query: 'visible'}});
    assert.equal(visible.items[0]!.type, 'assistant/message'); assert.match(visible.items[0]!.snippet, /visible answer marker/);
    await call(instance, {mode: 'reset'});
    assert.equal((await call<Page>(instance, {mode: 'search', query: {query: 'visible'}})).items.length, 0, 'connection-local live documents cannot survive a query owner restart');
    assert.equal((await call<{live: number}>(instance, {mode: 'stats'})).live, 0);
  } finally {await instance.dispose();}
});

test('failed derived reconciliation rolls back every search write and preserves canonical logs', async () => {
  const instance = runtime();
  try {
    await call(instance, {mode: 'seed', records: [{id: 'fault-a', text: 'atomic needle'}, {id: 'fault-b', text: 'atomic needle'}]});
    await call(instance, {mode: 'failure', failure: true});
    const failed = await instance.dispatchFetch('http://query.local/query', {method: 'POST', body: JSON.stringify({mode: 'search', query: {query: 'needle'}})});
    assert.equal((await failed.json() as {code: string}).code, 'SESSION_QUERY_INDEX_FAILED');
    assert.deepEqual(await call(instance, {mode: 'stats'}), {canonical: 2, indexed: 0, live: 0});
    await call(instance, {mode: 'failure', failure: false});
    assert.equal((await call<Page>(instance, {mode: 'search', query: {query: 'needle'}})).items.length, 2);
  } finally {await instance.dispose();}
});

test('the environment persistence reader cancels paged reads and then searches the full committed log without truncation', async () => {
  const instance = runtime();
  try {
    await call(instance, {mode: 'large'});
    const aborted = await instance.dispatchFetch('http://query.local/query', {method: 'POST', body: JSON.stringify({mode: 'remote-search', text: 'last-page-needle', failure: true})});
    assert.equal((await aborted.json() as {code: string}).code, 'gateway/cancelled');
    assert.deepEqual(await call(instance, {mode: 'stats'}), {canonical: 1, indexed: 0, live: 0});
    const found = await call<{result: {items: {sessionId: string; snippet: string}[]; hasMore: boolean}; pages: number; maxPageBytes: number}>(instance, {mode: 'remote-search', text: 'last-page-needle'});
    assert.equal(found.result.items[0]!.sessionId, 'large'); assert.match(found.result.items[0]!.snippet, /last-page-needle/);
    assert.equal(found.result.hasMore, false); assert.ok(found.pages > 1);
    assert.ok(found.maxPageBytes <= 524288, 'transport pages are bounded by UTF-8 bytes');
  } finally {await instance.dispose();}
});
