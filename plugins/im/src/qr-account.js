import Schema from '@deepseek-ai/schemastery';
import {background, header, json, sleep} from './shared.js';

/** A short, non-secret fingerprint of the credentials, so a rebound account replaces the gateway connection. */
const fingerprint = text => {let hash = 0x811c9dc5; for (const char of String(text)) hash = Math.imul(hash ^ char.codePointAt(0), 0x01000193) >>> 0; return hash.toString(16);};

export const connectionMode = () => Schema.union(['manual', 'qr']).default('manual').description('Manual HTTP callback or QR-created bot with an outbound WebSocket.');
const record = {parse: value => value};

/** One channel-owned account. Device codes and encryption keys never leave this activation. */
export async function qrAccount(ctx, channel, config, provider) {
  const domain = await ctx.storageDomain.open({name: `im_${channel}_account`, version: 1, tables: {}, global: {schema: record, initial: {}}});
  ctx.effect(() => () => domain.close(), `${channel} account storage`);
  // Switching back to manual credentials removes the previous QR identity.
  if (config.connectionMode !== 'qr' && domain.global.get().credentials) await domain.global.set({});
  let attempt, connection, writes = Promise.resolve();
  const stored = () => domain.global.get().credentials;
  const credentials = () => config.connectionMode === 'qr' ? stored() : config;
  const persist = operation => {const result = writes.catch(() => {}).then(operation); writes = result; return result;};
  const cancel = () => {
    if (attempt) {attempt.task?.abort(); attempt = undefined;}
  };
  /** The socket lives in the shared gateway; only an explicit stop closes it. */
  const stop = async () => {connection = undefined; await ctx.weftConnections.close(channel).catch(() => {});};
  const launch = () => {
    provider.changed?.();
    if (!config.enabled || config.connectionMode !== 'qr' || !stored()) {void stop(); return;}
    const current = stored();
    connection = ctx.weftConnections.socket(channel, {version: `${current.appId}:${fingerprint(current.appSecret)}`, ...provider.socket(current)});
  };
  const health = async () => {
    const status = await connection?.status().catch(() => null);
    return status?.state === 'open' && status.tracked.online ? 'online' : 'connecting';
  };
  const view = async (check = false) => {
    if (!config.enabled) return {state: 'disabled', ...(stored() ? {botId: stored().appId, owner: stored().owner} : {})};
    if (config.connectionMode !== 'qr') {
      if (check) await provider.validate(config);
      return {state: 'ready', botId: config.appId, checkedAt: Date.now()};
    }
    if (attempt) return {state: attempt.state, attemptId: attempt.id, ...(attempt.state === 'login' ? {qrcodeUrl: attempt.publicUrl, expiresAt: attempt.expiresAt} : {}), ...(attempt.error ? {error: attempt.error} : {})};
    const account = stored();
    return account ? {state: await health(), botId: account.appId, owner: account.owner, transport: 'websocket', checkedAt: Date.now()} : {state: 'idle'};
  };
  let starting;
  const begin = () => starting ??= (async () => {
    cancel();
    const current = attempt = {id: crypto.randomUUID(), state: 'starting'};
    const abort = new AbortController(); current.task = {abort: () => abort.abort()};
    try {
      const device = await provider.start(abort.signal, config.domain);
      abort.signal.throwIfAborted();
      Object.assign(current, {state: 'login', publicUrl: device.url, expiresAt: device.expiresAt});
      current.task = background(ctx, `${channel} registration`, async signal => {
        try {
          for (let interval = device.interval; !signal.aborted;) {
            await sleep(interval, signal);
            if (Date.now() >= device.expiresAt) {current.state = 'expired'; current.error = 'qrExpiredError'; return;}
            const result = await provider.poll(device, signal);
            signal.throwIfAborted();
            if (result.interval) interval = result.interval;
            if (result.state) {current.state = result.state; current.error = result.error; return;}
            if (!result.credentials) continue;
            current.state = 'connecting';
            await provider.validate(result.credentials);
            signal.throwIfAborted();
            await persist(async () => {
              signal.throwIfAborted();
              const previous = domain.global.get();
              await domain.global.set({credentials: result.credentials});
              if (signal.aborted) {await domain.global.set(previous); signal.throwIfAborted();}
            });
            if (attempt !== current || signal.aborted) return;
            if (credentials()?.appId !== result.credentials.appId) return;
            await ctx.im.clear(channel);
            if (attempt !== current || signal.aborted) return;
            attempt = undefined; launch(); return;
          }
        } catch {if (!signal.aborted && attempt === current) {current.state = 'error'; current.error = 'qrFailed';}}
      });
      return view();
    } catch (error) {if (attempt === current) {current.state = 'error'; current.error = 'qrFailed';} throw error;}
    finally {starting = undefined;}
  })();
  const route = (path, method, run) => ctx.effect(() => ctx.webServer.register({kind: 'exact', path: `/${channel}/${path}`, handler: async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (!config.managementKey || header(request, 'authorization') !== `Bearer ${config.managementKey}`) {json(response, 403, {error: 'management key required'}); return;}
    if (request.method !== method) {json(response, 405, {error: `${method} required`}); return;}
    try {json(response, 200, await run());} catch {json(response, 502, {error: 'channel_operation_failed'});}
  }}), `${channel} ${path}`);
  route('status', 'GET', async () => ({...await view(true), ...provider.status?.()}));
  route('login', 'POST', () => {if (!config.enabled || config.connectionMode !== 'qr') throw new Error('QR setup is disabled'); return begin();});
  route('cancel', 'POST', async () => {cancel(); return view();});
  route('disconnect', 'POST', async () => {
    cancel(); await stop();
    await persist(() => domain.global.set({})); provider.changed?.();
    await ctx.im.clear(channel); return {state: 'idle'};
  });
  ctx.effect(() => () => {cancel();}, `${channel} account lifecycle`);
  return {credentials, launch, owner: () => config.connectionMode === 'qr' ? stored()?.owner : undefined};
}
