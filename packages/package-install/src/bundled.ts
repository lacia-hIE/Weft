import {bundledPackages} from '../../../.generated/bundled-packages.ts';
import type {BundleInfo} from '@deepseek-ai/dsh-plugin-manager/types';
import {declarationSchema} from './contracts.ts';
import type {ResolvedPackage} from './resolver.ts';

/**
 * Repository plugins this deployment ships as npm archives. A bundled name is
 * always resolved here, so a registry package of the same name cannot stand in.
 */
export function bundledPackage(spec: string): ResolvedPackage | undefined {
  const row = bundledPackages.find(item => spec === item.name || spec.startsWith(item.name + '@'));
  if (!row) return undefined;
  if (spec !== row.name && spec !== `${row.name}@${row.version}`) throw new Error(`This deployment includes ${row.name}@${row.version} only`);
  const manifest = structuredClone(row.manifest) as unknown as ResolvedPackage['manifest'];
  return {manifest, declaration: declarationSchema.parse(manifest.dsh?.bundle),
    lock: [{name: row.name, version: row.version, integrity: row.manifest.dist.integrity, tarball: row.manifest.dist.tarball}],
    packages: [{name: row.name, version: row.version, bytes: row.archive}]};
}

/** Not yet installed bundled plugins, offered on the Plugins page as on-demand entries. */
export function bundledPackageInfo(installed: (name: string) => boolean): BundleInfo[] {
  return bundledPackages.filter(row => !installed(row.name)).map(row => ({
    name: row.name, version: row.version, description: row.description, official: true, availability: 'missing', installed: false, enabled: false,
    installTarget: {spec: `${row.name}@${row.version}`, version: row.version}, optional: false, removable: false,
    rows: row.rows.map(item => ({rowId: item.rowId, moduleName: item.moduleName})), overrides: [],
  }));
}
