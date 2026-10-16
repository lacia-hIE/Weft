import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export const accessAudience = 'weft-test-app';
export const accessTeamDomain = 'test.cloudflareaccess.com';
export const users = {
  alpha: { user_uuid: 'user-alpha', email: 'alpha@example.com' },
  beta: { user_uuid: 'user-beta', email: 'beta@example.com' },
};
export type User = keyof typeof users;
export function tenantId(user: User): string {
  return 'user-' + createHash('sha256').update(JSON.stringify([accessTeamDomain, users[user].user_uuid])).digest('hex');
}
export function url(user: string, path: string): string { return `http://${user}.local${path}`; }
export function sessionPath(user: User, sessionId: string, operation: 'messages' | 'events'): string {
  return `/v1/tenants/${tenantId(user)}/sessions/${sessionId}/${operation}`;
}

export function createRuntime(persist?: string): Miniflare {
  const profiles = [
    { name: 'alpha', access: { aud: accessAudience, identity: users.alpha } },
    { name: 'beta', access: { aud: accessAudience, identity: users.beta } },
    { name: 'anonymous', access: undefined },
    { name: 'wrong-app', access: { aud: 'another-app', identity: users.alpha } },
    { name: 'service', access: { aud: accessAudience, identity: { common_name: 'service.access', sub: '' } } },
    { name: 'no-user-id', access: { aud: accessAudience, identity: { email: users.alpha.email } } },
    { name: 'renamed', access: { aud: accessAudience, identity: { ...users.alpha, email: 'renamed@example.com' } } },
    { name: 'claims', access: { aud: accessAudience, identity: { sub: users.alpha.user_uuid, email: users.alpha.email } } },
  ];
  const options = convertV4MiniflareOptions({ workers: profiles.map(profile => ({
    name: profile.name,
    routes: [`${profile.name}.local/*`],
    modules: true,
    scriptPath: resolve('dist/worker.js'),
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { SESSIONS: { className: 'SessionDO', scriptName: 'alpha', useSQLite: true } },
    bindings: { ACCESS_AUD: accessAudience, ACCESS_TEAM_DOMAIN: accessTeamDomain },
    ...(profile.access ? { access: profile.access } : {}),
  })) });
  for (const worker of options.workers) worker.dev = { ...worker.dev, unsafeRegisterWorker: false };
  return new Miniflare({ ...options, ...(persist ? { resourcePersistencePath: persist } : {}) });
}

export function send(runtime: Miniflare, user: User, sessionId: string, text: string, caller: string = user) {
  return runtime.dispatchFetch(url(caller, sessionPath(user, sessionId, 'messages')), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  });
}

export interface EventRecord {
  type: string;
  seq: number;
  data: { turn?: number; step?: number; reason?: { kind: string }; message?: { content: { type: string; text?: string }[] }; content?: { type: string; text?: string }[] };
}
export interface SessionResponse { tenantId: string; sessionId: string; events: EventRecord[] }
