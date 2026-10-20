import { Context } from '@deepseek-ai/cordis';
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access';
import Typert from '../../../.generated/official-typert-registry.js';
import remoteAccessRemote from '../../../.generated/official-remotes/packages/api/remote-access/typert.remote-client.js';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { CredentialProvider, type CredentialInfo, type CredentialRecord, type CredentialRecordEntry, type CredentialRecordInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials';
import { invokeAgentRemote, openRemoteStream } from '../../harness-runtime/src/remote-dispatch.ts';
import { remoteStream } from '../../harness-runtime/src/remote-stream.ts';

/** Environment-wide official services that hold no Session state, opened per request. */
export async function openEnvironmentServices(): Promise<Context> {
  const ctx = new Context();
  try {
    await ctx.plugin(Typert);
    await ctx.plugin(RemoteAccessService);
    return ctx;
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}

/** The environment Remote whose method this is, if the environment services serve it. */
export function environmentRemoteFor(endpoint: string) {
  return Object.hasOwn(remoteAccessRemote.methods, endpoint) ? remoteAccessRemote : undefined;
}

/** One stream method of the environment services, disposed with its stream. */
export async function openEnvironmentStream(endpoint: string, args: unknown, abort: AbortController): Promise<Response> {
  const info = environmentRemoteFor(endpoint);
  if (!info) throw new RemoteError('gateway/method-unavailable', 'Remote stream is not connected yet', {endpoint});
  const services = await openEnvironmentServices();
  try {
    const stream = openRemoteStream(services, info, endpoint, args, abort.signal);
    return remoteStream(stream.items, abort, stream.parse, () => services.fiber.dispose());
  } catch (error) {await services.fiber.dispose(); throw error;}
}

/** One unary method of the environment services. */
export async function invokeEnvironmentRemote(endpoint: string, args: unknown, signal: AbortSignal): Promise<unknown> {
  const info = environmentRemoteFor(endpoint);
  if (!info) throw new RemoteError('gateway/method-unavailable', 'Remote method is not connected yet', {endpoint});
  const services = await openEnvironmentServices();
  try { return await invokeAgentRemote(services, info, endpoint, args, signal); }
  finally { await services.fiber.dispose(); }
}

/**
 * The credential seam a Session's native root reads: references resolve through
 * the environment's own store. Writes stay with the environment settings.
 */
export class EnvironmentCredentialReader extends CredentialProvider {
  constructor(ctx: Context, private readonly read: (ref: CredentialRef) => Promise<ResolvedCredential | undefined>) { super(ctx); }
  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> { return this.read(ref); }
  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = await this.read(ref);
    return {configured: value !== undefined, ...(value ? {source: value.source} : {}), writable: false};
  }
  override set(): Promise<void> { return Promise.reject(managedElsewhere()); }
  override unset(): Promise<void> { return Promise.reject(managedElsewhere()); }
  override readRecord(): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined); }
  override async describeRecord(): Promise<CredentialRecordInfo> { return {configured: false, writable: false}; }
  override listRecords(): Promise<readonly CredentialRecordEntry[]> { return Promise.resolve([]); }
  override modifyRecord(): Promise<CredentialRecord | undefined> { return Promise.reject(managedElsewhere()); }
  override deleteRecord(): Promise<void> { return Promise.reject(managedElsewhere()); }
}
const managedElsewhere = () => new Error('Credentials are managed in this environment\'s settings');
