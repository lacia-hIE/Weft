import {z} from 'zod';
import type {PluginEntryId} from '@deepseek-ai/dsh-host-plugin-inventory/types';

export const permissionSchema = z.object({
  files: z.enum(['none', 'read', 'write']).default('none'),
  tools: z.boolean().default(false), timer: z.boolean().default(false),
  client: z.boolean().default(false),
}).strict();
export const declarationSchema = z.object({patch: z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(16)])}).strict();
export type Permissions = z.infer<typeof permissionSchema>;
export type Declaration = z.infer<typeof declarationSchema>;
export const patchSchema = z.array(z.record(z.string(), z.json())).max(128);
export const lockSchema = z.array(z.object({name: z.string(), version: z.string(), integrity: z.string(), tarball: z.string()})).max(32);
export type PackageLock = z.infer<typeof lockSchema>;
export const assetTypes = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm', txt: 'text/plain',
} as const;
export const assetPath = /^assets\/[A-Za-z0-9_-]+\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|wasm|txt)$/;
const assetsSchema = z.record(z.string().regex(assetPath), z.string().max(1_398_104).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)).superRefine((assets, ctx) => {
  let bytes = 0;
  for (const value of Object.values(assets)) {
    const size = value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
    if (size > 1_048_576) ctx.addIssue({code: 'custom', message: 'An asset exceeds 1 MiB'});
    bytes += size;
  }
  if (Object.keys(assets).length > 128 || bytes > 4_194_304) ctx.addIssue({code: 'custom', message: 'Assets exceed 128 files or 4 MiB'});
});
export const artifactSchema = z.object({
  name: z.string(), version: z.string(), description: z.string().max(2000),
  patch: patchSchema, rows: patchSchema, permissions: permissionSchema, lock: lockSchema, host: z.string().max(1_048_576).optional(),
  client: z.string().max(1_048_576).optional(),
  css: z.string().max(1_048_576).optional(), assets: assetsSchema.optional(),
}).strict();
export type Artifact = z.infer<typeof artifactSchema>;
export interface PackageRevision {
  name: string; version: string; digest: string; enabled: boolean; approved: boolean;
  patch: Record<string, unknown>[]; rows: Record<string, unknown>[]; permissions: Permissions; description: string; installedAt: number;
  needsReinstall?: true;
}
export interface Installation extends PackageRevision {
  candidate?: PackageRevision; previous?: PackageRevision; lastError?: string;
  switching?: {enabled: boolean};
}
/** Revision history never recursively embeds previous revisions or transfers approvals. */
export function revision(row: Installation): PackageRevision {
  const {candidate: _candidate, previous: _previous, lastError: _error, switching: _switching, ...value} = row;
  return value;
}
export interface InstallJob {
  id: string; spec: string; phase: 'resolving' | 'building' | 'review' | 'failed';
  error?: string; digest?: string; createdAt: number;
  name?: string; baseDigest?: string; resolvedSpec?: string;
}
export const exactSpec = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
export const entryId = (name: string) => `installed:${name}` as PluginEntryId;
export async function sha256(value: string | Uint8Array): Promise<string> {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function artifactKey(owner: object, digest: string): string {
  return `packages/${encodeURIComponent(JSON.stringify(owner))}/${digest}.json`;
}
