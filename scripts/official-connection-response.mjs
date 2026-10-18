import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

/** Reuse the pure original JSON/multipart encoder without importing its Node RPC host. */
export function prepareConnectionResponse(upstreamDirectory) {
  // Keep upstream's implementation behind its public contract. Its internal
  // erased generic storage uses different strict compiler options from Weft.
  writeFileSync('.generated/official-typert-registry.js', "export {default} from '@weft/upstream/packages/typert/registry/src/index.ts';\n");
  writeFileSync('.generated/official-typert-registry.d.ts', "import type {Context, Service} from '@deepseek-ai/cordis';\ndeclare const Typert: new (ctx: Context) => Service;\nexport default Typert;\n");
  const source = readFileSync(resolve(upstreamDirectory, 'packages/client/connection/src/rpc-host.ts'), 'utf8');
  const start = source.indexOf('function fullResponse(');
  const end = source.indexOf('\nfunction assertChannel(', start);
  if (start < 0 || end < 0 || !source.slice(start, end).includes("parts.set('metadata'")) {
    throw new Error('Upstream Connection response encoder changed; review the workerd transport seam');
  }
  writeFileSync('.generated/official-connection-response.ts',
    "import type {RpcId as RpcIdType, ConnectionRpcHandler, ServerResponse as ConnectionServerResponse} from '@weft/upstream/packages/client/connection/src/rpc.ts';\n"
    + 'export ' + source.slice(start, end) + '\n');
}
