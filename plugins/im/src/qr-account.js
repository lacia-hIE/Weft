import Schema from '@deepseek-ai/schemastery';
import {background, header, json, sleep} from './shared.js';

export const connectionMode = () => Schema.union(['manual', 'qr']).default('manual').description('Manual HTTP callback or QR-created bot with an outbound WebSocket.');
const record = {parse: value => value};

/** One channel-owned account. Device codes and encryption keys never leave this activation. */
export async function qrAccount(ctx, channel, config, provider) {
  const domain = await ctx.storageDomain.open({name: `im_${channel}_account`, version: 1, tables: {}, global: {schema: record, initial: {}}});
  ctx.effect(() => () => domain.close(), `${channel} account storage`);
  // Switching back to manual credentials removes the previous QR identity.
  if (config.connectionMode !== 'qr' && domain.global.get().credentials) await domain.global.set({});
  let attempt, transport, health = 'connecting', writes = Promise.resolve();
  const stored = () => domain.global.get().credentials;
  const credentials = () => config.connectionMode === 'qr' ? stored() : config;
  const persist = operation => {const result = writes.catch(() => {}).then(operation); writes = result; return result;};
  const cancel = () => {
    if (attempt) {attempt.task?.abort(); attempt = undefined;}
  };
  const stop = () => {transport?.abort(); transport = undefined;};
  const launch = () => {
    stop(); provider.changed?.();
    if (!config.enabled || config.connectionMode !== 'qr' || !stored()) return;
    const current = stored(); health = 'connecting';
    transport = background(ctx, `${channel} socket`, async signal => {
      for (let retry = 0; !signal.aborted; retry++) {
        try {
          health = 'connecting';
          await provider.connect(current, signal, () => {health = 'online'; retry = 0;});
        } catch {if (!signal.aborted) health = 'error';}
        if (!signal.aborted) await sleep(Math.min(30_000, 1000 * 2 ** Math.min(retry, 5)), signal);
      }
    });
  };
  const view = async (check = false) => {
    if (!config.enabled) return {state: 'disabled', ...(stored() ? {botId: stored().appId, owner: stored().owner} : {})};
    if (config.connectionMode !== 'qr') {
      if (check) await provider.validate(config);
      return {state: 'ready', botId: config.appId, checkedAt: Date.now()};
    }
    if (attempt) return {state: attempt.state, attemptId: attempt.id, ...(attempt.state === 'login' ? {qrcodeUrl: attempt.publicUrl, expiresAt: attempt.expiresAt} : {}), ...(attempt.error ? {error: attempt.error} : {})};
    const account = stored();
    return account ? {state: health, botId: account.appId, owner: account.owner, transport: 'websocket', checkedAt: Date.now()} : {state: 'idle'};
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
  route('status', 'GET', () => view(true));
  route('login', 'POST', () => {if (!config.enabled || config.connectionMode !== 'qr') throw new Error('QR setup is disabled'); return begin();});
  route('cancel', 'POST', async () => {cancel(); return view();});
  route('disconnect', 'POST', async () => {
    cancel(); stop();
    await persist(() => domain.global.set({})); provider.changed?.();
    await ctx.im.clear(channel); return {state: 'idle'};
  });
  ctx.effect(() => () => {cancel(); stop();}, `${channel} account lifecycle`);
  return {credentials, launch, owner: () => config.connectionMode === 'qr' ? stored()?.owner : undefined};
}
