import {Context} from '@deepseek-ai/cordis';
import Sessions, {SessionId} from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Typert from '../../../.generated/official-typert-registry.js';
import {z} from 'zod';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import WorkspaceFiles from '@deepseek-ai/dsh-api-workspace-files';
import {FsError} from '@deepseek-ai/dsh-fs';
import {RemoteError} from '@deepseek-ai/dsh-typert-protocol';
import {RpcId, type ConnectionRpcAttachment} from '@weft/upstream/packages/client/connection/src/rpc.ts';
import remote from '../../../.generated/official-remotes/packages/api/workspace-files/typert.remote-client.js';
import {fullResponse} from '../../../.generated/official-connection-response.ts';
import {SqliteSessionPersistence} from '../../session-persistence-do/src/index.ts';
import {ComputerFileSystem} from '../../workspace/src/provider.ts';
import type {WorkspaceScope, WorkspaceTransport} from '../../workspace/src/protocol.ts';
import {remoteStream} from '../../harness-runtime/src/remote-stream.ts';

export type NativeFileEndpoint = Exclude<keyof typeof remote.methods, 'workspaceFiles/changes'>;

/** Read-only native Host world: actual header lookup and file service, no Agent or writer. */
export async function createNativeFileHost(storage: DurableObjectStorage, scope: WorkspaceScope, sessionId: string, transport: WorkspaceTransport) {
  const ctx = new Context();
  try {
    await ctx.plugin(Sessions);
    await ctx.plugin(Projections);
    await ctx.plugin(Typert);
    await ctx.plugin(SqliteSessionPersistence, {storage});
    await ctx.plugin(ComputerFileSystem, {scope, transport, listLimit: 2001});
    await ctx.plugin(SandboxPolicy, {workspaceRoot: '/workspace', mode: 'workspace-write'});
    await ctx.plugin(WorkspaceFiles);
    const resolve = async (id: string) => {
      if (id !== sessionId) throw new RemoteError('gateway/bad-request', 'Session file scope mismatch', {});
      const resolved = await ctx.typert.lookups.get('workspaceFileScope')?.resolve(SessionId(id));
      if (!resolved) throw new RemoteError('session/not-found', 'Session not found', {sessionId: SessionId(id)});
      const value = z.object({sessionId: z.string(), workspaceRoot: z.string()}).parse(resolved);
      return {...value, sessionId: SessionId(value.sessionId)};
    };
    const fileError = (error: unknown, path: string): never => {
      if (error instanceof FsError) {
        if (error.code === 'FS_SANDBOX_DENIED' || error.code === 'FS_PERMISSION_DENIED') {
          throw new RemoteError('workspace-file/outside-workspace', 'Path is outside the environment filesystem', {path}, {cause: error});
        }
        if (error.code === 'FS_NOT_TEXT') throw new RemoteError('workspace-file/not-text', 'File is not UTF-8 text', {path}, {cause: error});
      }
      throw error;
    };
    return {
      async call(endpoint: NativeFileEndpoint, raw: unknown, rpcId: string): Promise<Response> {
        const method = remote.methods[endpoint];
        const args = method.input({strict: true}).create().parse(raw);
        const owner = await resolve(args.workspaceFileScopeId);
        const signal = new AbortController().signal;
        try {
          let value: unknown;
          switch (endpoint) {
            case 'workspaceFiles/list': value = await ctx.workspaceFiles.list(owner, args.path, signal); break;
            case 'workspaceFiles/stat': value = await ctx.workspaceFiles.stat(owner, args.path, signal); break;
            case 'workspaceFiles/read': {
              const input = remote.methods[endpoint].input({strict: true}).create().parse(raw);
              value = await ctx.workspaceFiles.read(owner, input.path, input.range, signal); break;
            }
            case 'workspaceFiles/readBytes': {
              const input = remote.methods[endpoint].input({strict: true}).create().parse(raw);
              const result = remote.methods[endpoint].result;
              const bytes = result.create().parse(await ctx.workspaceFiles.readBytes(owner, input.path, input.options, signal));
              const attachments: ConnectionRpcAttachment[] = [];
              if (!result.encode) throw new Error('Pinned byte result has no encoder');
              const encoded = result.encode(bytes, (data, path) => {attachments.push({path, bytes: data}); return null;});
              return fullResponse(RpcId(rpcId), {ok: true, value: encoded, attachments});
            }
          }
          return fullResponse(RpcId(rpcId), {ok: true, value: method.result.create().parse(value)});
        } catch (error) {return fileError(error, args.path);}
      },
      async changes(raw: unknown, abort: AbortController, dispose = () => ctx.fiber.dispose()): Promise<Response> {
        const method = remote.methods['workspaceFiles/changes'];
        const args = method.input({strict: true}).create().parse(raw);
        const owner = await resolve(args.workspaceFileScopeId);
        const source = ctx.workspaceFiles.changes(owner, args.path, abort.signal);
        const iterator = async function* () {
          try { yield* source; }
          catch (error) {fileError(error, args.path);}
        };
        return remoteStream(iterator(), abort, value => method.result.create().parse(value), dispose);
      },
      dispose: () => ctx.fiber.dispose(),
    };
  } catch (error) {await ctx.fiber.dispose(); throw error;}
}
