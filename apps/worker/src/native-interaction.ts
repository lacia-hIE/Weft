import type { Context } from '@deepseek-ai/cordis';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import SessionReferenceResolver from '@deepseek-ai/dsh-session-reference';
import MessageFeedback from '@deepseek-ai/dsh-message-feedback';
import * as CommandFeedback from '@deepseek-ai/dsh-command-feedback';
import SessionSkillCatalog from '@weft/upstream/packages/api/session-controller/src/skill-catalog.ts';
import Typert from '../../../.generated/official-typert-registry.js';
import WebRuntime from '@deepseek-ai/dsh-web';
import JobController from '@deepseek-ai/dsh-api-job-controller';
import TerminalController from '@deepseek-ai/dsh-api-terminal-controller';
import * as WebSearchDeepSeek from '@deepseek-ai/dsh-web-search-deepseek';
import * as WebFetchHttp from '@deepseek-ai/dsh-web-fetch-http';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { EnvironmentCredentialReader } from '../../../packages/native-environment/src/index.ts';
import { mountPermissions } from '../../../packages/native-environment/src/permissions.ts';
import { readEnvironmentModelConfiguration } from '../../../packages/model-provider/src/index.ts';
import type { Env } from './index.ts';
import { controlFor, NATIVE_FORWARDED_EVENTS, NATIVE_WATERFALLS } from '../../../packages/control-plane/src/object.ts';
import type { ControlScope } from '../../../packages/control-plane/src/contracts.ts';
import { forwardNativeWaterfalls } from '../../../packages/harness-runtime/src/remote-waterfalls.ts';
import { setRemoteReceiver } from '../../../packages/harness-runtime/src/remote-dispatch.ts';
import { mountNativeSchedule } from '../../../packages/native-schedule/src/index.ts';
import { EnvironmentSessionPersistence } from '../../../packages/native-query/src/persistence.ts';
import { installDurableSessionQuery } from '../../../packages/native-query/src/index.ts';
import { sessionReadPorts } from '../../../packages/native-query/src/ports.ts';
import { sessionAddress, type SessionScope } from '../../../packages/tenant/src/index.ts';

/** Remote Events the native root sends to the environment's clients: waterfalls and root notifications. */
export function forwardNativeNotifications(ctx: Context, env: Env, owner: ControlScope, live: () => boolean): void {
  const control = () => controlFor(env, owner);
  forwardNativeWaterfalls(ctx, NATIVE_WATERFALLS, {
    forward: (eventId, event, agentId, request) => control().nativeEventWaterfall(owner, eventId, event, agentId, request),
    cancel: eventId => control().nativeEventWaterfallCancel(owner, eventId),
  });
  // Registrations while the host opens are not changes a connected client has seen.
  for (const event of NATIVE_FORWARDED_EVENTS) ctx.on(event, (...args: unknown[]) => {
    if (!live()) return;
    void control().nativeForwardEvent(owner, event, structuredClone(args)).catch(() => { /* Notifications are ephemeral; clients repull state on reconnect. */ });
  });
}

/** The original Session-scoped Remote services, `@` Session references and Schedule on a native root. */
export async function mountNativeInteraction(ctx: Context, env: Env, storage: DurableObjectStorage, scope: SessionScope, owner: ControlScope): Promise<void> {
  await ctx.plugin(Typert);
  await ctx.plugin(SessionSkillCatalog);
  await ctx.plugin(MessageFeedback, {maxNoteBytes: 8192});
  await ctx.plugin(CommandFeedback);
  if (ctx.get('jobs')) await ctx.plugin(JobController, {});
  if (ctx.get('subprocess')) await ctx.plugin(TerminalController, TerminalController.Config({} as never));
  // Permission presets bundle the shell's sandbox mode with the approval policy; approvals reach the client as waterfalls.
  if (ctx.get('shell')) await mountPermissions(ctx, await controlFor(env, owner).nativePermissionDefault(owner));
  await ctx.plugin(EnvironmentCredentialReader, (ref: string) => controlFor(env, owner).nativeResolveCredential(owner, credentialRef(ref)));
  // The base bundle's web rows: DeepSeek search on the environment's configured DeepSeek endpoint
  // and model key (the official default is that endpoint's `/v1`), and HTTP fetch over workerd.
  const model = await readEnvironmentModelConfiguration(await controlFor(env, owner).nativeModelConfiguration(owner)).catch(() => undefined);
  await ctx.plugin(WebRuntime, {searchProvider: 'deepseek-official', fetchProvider: 'http'});
  await ctx.plugin(WebSearchDeepSeek, model?.providerOptions.baseURL ? {baseURL: `${model.providerOptions.baseURL.replace(/\/+$/, '')}/v1`} : {});
  await ctx.plugin(WebFetchHttp, {});
  await mountSessionReferences(ctx, env, storage, scope, owner);
  await mountNativeSchedule(ctx, storage, {set: async at => {
    if (at === undefined) {await storage.deleteAlarm(); return;}
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_alarm_scope (id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL)');
    storage.sql.exec('INSERT INTO weft_alarm_scope VALUES (1,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope', JSON.stringify(scope));
    // An already-due reminder means the live runtime could not deliver it; retry later instead of spinning.
    await storage.setAlarm(Math.max(at, Date.now() + (at <= Date.now() ? 60_000 : 0)));
  }}, SessionId(scope.sessionId));
}

/**
 * `@` Session references read other Sessions of the environment through a private
 * read-only query world; this object's own Sessions are excluded (an object never calls itself).
 */
async function mountSessionReferences(ctx: Context, env: Env, storage: DurableObjectStorage, scope: SessionScope, owner: ControlScope): Promise<void> {
  const references = ctx.isolate('sessions').isolate('sessionPersistence').isolate('sessionQuery').isolate('weftSessionSearchDatabase');
  let listed: {at: number; rows: Promise<{id: string; root: string}[]>} | undefined;
  const owners = () => {
    // One candidate listing reads many pages; share one owner snapshot across them briefly.
    if (!listed || Date.now() - listed.at > 2_000) listed = {at: Date.now(), rows: controlFor(env, owner).nativeSessionOwners(owner).then(rows => rows.filter(row => row.root !== scope.sessionId))};
    return listed.rows;
  };
  await references.plugin(Sessions);
  await references.plugin(EnvironmentSessionPersistence, sessionReadPorts(async () => (await owners()).map(row => row.id), async sessionId => {
    const root = (await owners()).find(row => row.id === sessionId)?.root;
    if (!root) throw new Error('Session is not readable from this environment');
    const address = {...scope, sessionId: root};
    return {scope: address, stub: env.SESSIONS.getByName(sessionAddress(address))};
  }));
  await installDurableSessionQuery(references, storage, 'reference');
  await references.plugin(SessionReferenceResolver, {});
  setRemoteReceiver(ctx, 'sessionReferenceResolver', references);
}
