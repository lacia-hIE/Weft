import {maxSatisfying, valid, validRange, satisfies} from 'semver';
import {declarationSchema, exactSpec, type Declaration, type PackageLock} from './contracts.ts';

interface Manifest {
  name: string; version: string; description?: string;
  dist: {tarball: string; integrity: string}; dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>; scripts?: Record<string, string>; weft?: {plugin?: unknown};
}
export interface ResolvedPackage {manifest: Manifest; declaration: Declaration; lock: PackageLock; packages: {name: string; version: string; bytes: string}[]}
const REGISTRY = 'https://registry.npmjs.org';
const enc = new TextEncoder();
export async function limitedBytes(response: Response, max: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Package download failed (HTTP ${response.status})`);
  if (Number(response.headers.get('content-length') ?? 0) > max) throw new Error('Package download exceeds the size limit');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Package response has no body');
  const blocks: Uint8Array[] = []; let size = 0;
  try {for (;;) {const {value, done} = await reader.read(); if (done) break; size += value.length; if (size > max) throw new Error('Package download exceeds the size limit'); blocks.push(value);}}
  catch (error) {await reader.cancel().catch(() => {}); throw error;}
  const bytes = new Uint8Array(size); let offset = 0;
  for (const block of blocks) {bytes.set(block, offset); offset += block.length;}
  return bytes;
}
const base64 = (bytes: Uint8Array) => {let value = ''; for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return btoa(value);};
function metadata(value: unknown, name: string, version: string): Manifest {
  const item = value as Manifest;
  if (!item || item.name !== name || item.version !== version || !item.dist || typeof item.dist.tarball !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(item.dist.integrity)) throw new Error('Registry returned invalid package identity or SHA-512 integrity');
  const target = new URL(item.dist.tarball);
  if (target.protocol !== 'https:' || target.hostname !== 'registry.npmjs.org' || target.port || target.username || target.password) throw new Error('Only public npm registry tarballs are supported in v1');
  if (Object.keys(item.scripts ?? {}).some(key => ['preinstall', 'install', 'postinstall', 'prepare'].includes(key))) throw new Error(`${name} requires installation scripts, unsupported in v1`);
  return item;
}
async function json(address: string, signal: AbortSignal): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await limitedBytes(await fetch(address, {redirect: 'error', signal}), 4 * 1024 * 1024)));
}
export async function inspectPackage(spec: string, signal: AbortSignal): Promise<{manifest: Manifest; declaration: Declaration}> {
  const match = exactSpec.exec(spec);
  if (!match || !valid(match[2]!)) throw new Error('Use an exact public npm version, for example @scope/plugin@1.2.3');
  const manifest = metadata(await json(`${REGISTRY}/${encodeURIComponent(match[1]!)}/${match[2]}`, signal), match[1]!, match[2]!);
  const declaration = declarationSchema.parse(manifest.weft?.plugin);
  return {manifest, declaration};
}
/** Registry access is confined to the supervisor; the build receives verified archives and has no network. */
export async function resolvePackage(spec: string, signal: AbortSignal): Promise<ResolvedPackage> {
  const {manifest, declaration} = await inspectPackage(spec, signal);
  const selected = new Map<string, Manifest>([[manifest.name, manifest]]);
  const queue = [manifest];
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index]!;
    for (const [name, range] of Object.entries(item.dependencies ?? {})) {
      if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || !validRange(range)) throw new Error(`${name}: only registry semver dependencies are supported`);
      const existing = selected.get(name);
      if (existing) {if (!satisfies(existing.version, range)) throw new Error(`Dependency version conflict: ${name}`); continue;}
      if (selected.size >= 32) throw new Error('A plugin may have at most 32 packages in v1');
      const packument = await json(`${REGISTRY}/${encodeURIComponent(name)}`, signal) as {versions?: Record<string, unknown>};
      const version = maxSatisfying(Object.keys(packument.versions ?? {}), range);
      if (!version) throw new Error(`No compatible version for ${name}@${range}`);
      const child = metadata(packument.versions![version], name, version);
      selected.set(name, child); queue.push(child);
    }
  }
  for (const item of selected.values()) for (const [name, range] of Object.entries(item.peerDependencies ?? {})) {
    const peer = selected.get(name);
    if (!peer || !validRange(range) || !satisfies(peer.version, range)) throw new Error(`Unsatisfied peer dependency: ${name}@${range}`);
  }
  const lock: PackageLock = []; const packages: ResolvedPackage['packages'] = []; let total = 0;
  for (const item of [...selected.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    signal.throwIfAborted();
    const bytes = await limitedBytes(await fetch(item.dist.tarball, {redirect: 'error', signal}), 4 * 1024 * 1024);
    total += bytes.length; if (total > 12 * 1024 * 1024) throw new Error('Plugin archives exceed the combined 12 MiB limit');
    const integrity = 'sha512-' + base64(new Uint8Array(await crypto.subtle.digest('SHA-512', bytes as BufferSource)));
    if (integrity !== item.dist.integrity) throw new Error(`Package integrity mismatch: ${item.name}@${item.version}`);
    lock.push({name: item.name, version: item.version, integrity, tarball: item.dist.tarball});
    packages.push({name: item.name, version: item.version, bytes: base64(bytes)});
  }
  return {manifest, declaration, lock, packages};
}
