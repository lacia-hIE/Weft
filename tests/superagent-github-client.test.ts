import assert from 'node:assert/strict';
import {test} from 'node:test';
import {z} from 'zod';
import {Commands} from '../plugins/superagent/src/infra/commands.ts';
import type {Deployment} from '../plugins/superagent/src/deployment.ts';

test('the GitHub client pages wrapped lists, answers unchanged lists from their ETag, and meters every request', async t => {
  const seen: {url: string; etag: string | null}[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    seen.push({url: input, etag: headers.get('if-none-match')});
    const limit = {'x-ratelimit-remaining': String(5000 - seen.length), 'x-ratelimit-limit': '5000'};
    if (input.endsWith('check-runs?per_page=100')) return Response.json({total_count: 2, check_runs: [{name: 'a', status: 'completed', conclusion: 'success'}]},
      {headers: {...limit, link: '<https://api.github.com/repos/acme/widgets/commits/abc/check-runs?per_page=100&page=2>; rel="next"'}});
    if (input.endsWith('check-runs?per_page=100&page=2')) return Response.json({total_count: 2, check_runs: [{name: 'b', status: 'in_progress', conclusion: null}]}, {headers: limit});
    if (headers.get('if-none-match') === '"v1"') return new Response(null, {status: 304, headers: limit});
    return Response.json([{id: 1}], {headers: {...limit, etag: '"v1"'}});
  });
  const commands = new Commands(() => ({repository: 'acme/widgets'}) as Deployment, () => 'token', new AbortController().signal);
  const check = z.looseObject({name: z.string()});
  const runs = await commands.pages(check, 'commits/abc/check-runs?per_page=100', undefined, 'check_runs');
  assert.deepEqual(runs.map(run => run.name), ['a', 'b'], 'every page of a wrapped list is read');

  const first = await commands.withSignal(new AbortController().signal).listed(z.looseObject({id: z.number()}), 'issues/7/comments?per_page=100');
  assert.deepEqual(first, {unchanged: false, items: [{id: 1}], etag: '"v1"'});
  assert.deepEqual(await commands.listed(z.looseObject({id: z.number()}), 'issues/7/comments?per_page=100', {etag: '"v1"'}), {unchanged: true});
  assert.equal(seen.at(-1)!.etag, '"v1"', 'the stored validator is sent');
  assert.equal(commands.meter.requests, 4, 'clients derived with a signal share the meter');
  assert.deepEqual([commands.meter.remaining, commands.meter.limit], [4996, 5000]);
});
