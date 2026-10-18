import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {exportJWK, generateKeyPair, SignJWT} from 'jose';
import {Response} from 'miniflare';
import {accessAudience, accessTeamDomain, createRuntime, sessionPath, tenantId, url, users} from './helpers/miniflare.ts';

const signing = await generateKeyPair('RS256');
const attacker = await generateKeyPair('RS256');
const publicKey = {...await exportJWK(signing.publicKey), kid: 'access-fixture', alg: 'RS256', use: 'sig'};
const issuer = `https://${accessTeamDomain}`;
async function assertion(claims: Record<string, unknown> = {}, key = signing.privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({iss: issuer, aud: [accessAudience], iat: now, exp: now + 300,
    sub: users.alpha.user_uuid, email: users.alpha.email, ...claims})
    .setProtectedHeader({alg: 'RS256', kid: 'access-fixture'}).sign(key);
}
function fixture() {
  let unavailable = false;
  const requests: {url: string; cookie: string | null; authorization: string | null}[] = [];
  const runtime = createRuntime(undefined, {outbound: async request => {
    requests.push({url: request.url, cookie: request.headers.get('cookie'), authorization: request.headers.get('authorization')});
    assert.equal(request.url, issuer + '/cdn-cgi/access/certs');
    return unavailable ? new Response('unavailable', {status: 503}) : Response.json({keys: [publicKey]});
  }});
  return {runtime, requests, unavailable(value: boolean) {unavailable = value;}};
}

test('signed Access users load concurrent modules and retain the same tenant without runtime Access context', async () => {
  const {runtime, requests} = fixture();
  try {
    const token = await assertion();
    const headers = {'cf-access-jwt-assertion': token};
    const graph = JSON.parse(readFileSync('dist/web-metafile.json', 'utf8'));
    const imports = graph.outputs['dist/web/app.js'].imports as {path: string; kind: string}[];
    const paths = ['/assets/app.js', ...imports.filter(item => item.kind === 'import-statement')
      .map(item => '/assets/' + item.path.split('/').at(-1))];
    // A cold isolate receives the same parallel graph fetches as a real browser.
    const responses = await Promise.all(paths.map(path => runtime.dispatchFetch(url('anonymous', path), {headers})));
    for (const [index, response] of responses.entries()) {
      assert.equal(response.status, 200, paths[index] + ': ' + await response.clone().text());
      assert.match(response.headers.get('content-type')!, /javascript/);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
    for (const requestHeaders of [headers, {cookie: `other=x; CF_Authorization=${token}`}]) {
      const response = await runtime.dispatchFetch(url('anonymous', '/v1/me'), {headers: requestHeaders});
      assert.equal(response.status, 200, await response.clone().text());
      const me = await response.json() as {tenantId: string; user: {id: string; email: string}};
      assert.equal(me.tenantId, tenantId('alpha'));
      assert.deepEqual(me.user, {id: users.alpha.user_uuid, email: users.alpha.email});
    }
    const renamed = await assertion({email: 'renamed@example.com'});
    const me = await runtime.dispatchFetch(url('anonymous', '/v1/me'), {headers: {'cf-access-jwt-assertion': renamed}});
    assert.equal((await me.json() as {tenantId: string}).tenantId, tenantId('alpha'));
    const crossTenant = await runtime.dispatchFetch(url('anonymous', sessionPath('beta', 'private', 'events')), {headers});
    assert.equal(crossTenant.status, 403);
    const wrongNativeApp = await runtime.dispatchFetch(url('wrong-app', '/assets/app.js'), {headers});
    assert.equal(wrongNativeApp.status, 401, 'a signed header cannot override a mismatched native Access audience');
    assert.ok(requests.length > 0);
    assert.ok(requests.every(request => request.cookie === null && request.authorization === null));
    const before = requests.length;
    assert.equal((await runtime.dispatchFetch(url('anonymous', '/assets/app.js'), {headers})).status, 200);
    assert.equal(requests.length, before, 'verified public keys are reused across requests');
  } finally {await runtime.dispose();}
});

test('fallback rejects invalid signatures, claims, service credentials and application tokens', async () => {
  const {runtime} = fixture();
  try {
    const now = Math.floor(Date.now() / 1000);
    const invalid = [
      await assertion({}, attacker.privateKey),
      await assertion({aud: ['another-app']}),
      await assertion({iss: 'https://attacker.example'}),
      await assertion({exp: now - 1}),
      await assertion({nbf: now + 60}),
      await assertion({exp: undefined}),
      await assertion({email: undefined}),
      await assertion({email: 'not-an-email'}),
      await assertion({sub: ''}),
      await assertion({common_name: 'service.access'}),
      await assertion({service_token_id: 'service-id'}),
      'forged',
      'x'.repeat(16385),
    ];
    for (const token of invalid) {
      const response = await runtime.dispatchFetch(url('anonymous', '/assets/app.js'), {headers: {'cf-access-jwt-assertion': token}});
      assert.equal(response.status, 401);
    }
    const valid = await assertion();
    for (const headers of [
      {authorization: `Bearer ${valid}`},
      {'cf-access-authenticated-user-email': users.alpha.email, 'x-tenant-id': tenantId('alpha')},
      {cookie: `CF_Authorization=${valid}; CF_Authorization=${valid}`},
      {'cf-access-jwt-assertion': 'forged', cookie: `CF_Authorization=${valid}`},
    ]) assert.equal((await runtime.dispatchFetch(url('anonymous', '/v1/me'), {headers})).status, 401);
  } finally {await runtime.dispose();}
});

test('Access signing-key transport failures remain recoverable without admitting a request', async () => {
  const fixtureState = fixture();
  const {runtime} = fixtureState;
  try {
    const headers = {'cf-access-jwt-assertion': await assertion()};
    fixtureState.unavailable(true);
    const response = await runtime.dispatchFetch(url('anonymous', '/assets/app.js'), {headers});
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.json() as {code: string}).code, 'ACCESS_ASSERTION_UNAVAILABLE');
    fixtureState.unavailable(false);
    assert.equal((await runtime.dispatchFetch(url('anonymous', '/assets/app.js'), {headers})).status, 200);
  } finally {await runtime.dispose();}
});
