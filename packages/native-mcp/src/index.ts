import z from '@deepseek-ai/schemastery';
import type {Context} from '@deepseek-ai/cordis';
import type {EntryOptions} from '@deepseek-ai/cordis-plugin-loader';
import {createEntry, workerdLoader} from '../../native-profile/src/loader.ts';
import {updateLoaderEntry} from '../../plugin-registry/src/host.ts';

/** Weft's namespace: the environment's remote MCP servers, each an original `dsh-mcp-client` entry in every Session. */
export const MCP_NAMESPACE = 'mcp-servers';
export const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';
export const McpServersConfig = z.object({
  servers: z.array(z.object({
    name: z.string().pattern(/^[A-Za-z0-9_-]{1,32}$/).required()
      .description('Server name; its tools appear to the model as mcp__<name>__<tool>.'),
    url: z.string().role('link').required().description('Streamable HTTP endpoint, a public https:// URL.'),
    headers: z.dict(z.string().role('secret')).default({}).description('Request headers, such as Authorization; values are write-only.'),
    toolCallTimeoutMs: z.natural().min(1000).max(600_000).default(60_000).description('Limit for each tool call or resource read.'),
    enabled: z.boolean().default(true),
  })).default([]).volatile()
    .description('Remote MCP servers. Worker Sessions connect over Streamable HTTP; stdio servers need a local process and are not available here.'),
});
export interface McpServer {name: string; url: string; headers: Record<string, string>; toolCallTimeoutMs: number; enabled: boolean}

/** Reject what a Worker Session cannot or must not reach before the configuration is saved. */
export function validateMcpServers(servers: readonly McpServer[]): void {
  const names = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) throw new Error(`MCP server "${server.name}" is configured twice`);
    names.add(server.name);
    const url = new URL(server.url);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /[:\[\]]/.test(url.hostname)
      || /^\d+(?:\.\d+){3}$/.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|invalid)$/.test(url.hostname)) {
      throw new Error(`MCP server "${server.name}" must use a public https:// URL`);
    }
    for (const key of Object.keys(server.headers)) if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) throw new Error(`MCP server "${server.name}" has an invalid header name`);
  }
}

/** The original client's entries for the enabled servers. Ids cannot meet official profile rows. */
export function mcpEntries(servers: readonly McpServer[]): EntryOptions[] {
  return servers.filter(server => server.enabled).map(server => ({id: `mcp-server-${server.name}`, name: MCP_CLIENT,
    config: {serverName: server.name, transport: 'streamable-http', url: server.url, headers: {...server.headers}, toolCallTimeoutMs: server.toolCallTimeoutMs}}));
}

/**
 * Bring a Session world's MCP entries to the configured servers. Unchanged
 * servers keep their connections; a removed server's tools leave with its entry.
 * @returns the entries now mounted.
 */
export async function reconcileMcpServers(ctx: Context, applied: readonly EntryOptions[], next: readonly EntryOptions[]): Promise<EntryOptions[]> {
  const loader = await workerdLoader(ctx);
  for (const entry of applied) if (!next.some(row => row.id === entry.id)) loader.remove(entry.id);
  for (const entry of next) {
    const current = applied.find(row => row.id === entry.id);
    if (JSON.stringify(current) === JSON.stringify(entry)) continue;
    // A server that cannot connect leaves the Session usable; the original client logs and reconnects.
    if (current) await updateLoaderEntry(loader, structuredClone(entry));
    else await createEntry(loader, structuredClone(entry));
  }
  return next.map(entry => structuredClone(entry));
}
