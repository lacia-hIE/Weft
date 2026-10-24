import {availableBundleStates, namesOfficialBundle, optionalBundleInfo, shippedBundle, type BundleState} from './catalog.ts';
import type {ChangeResult, PluginSpecInspection} from '@deepseek-ai/dsh-plugin-manager/types';

const warning = 'Applies to new Sessions. Existing Sessions retain their frozen composition. Refresh the workbench to update official browser plugins.';

/** Small atomic manifest for prebuilt official bundles, independent of untrusted npm artifacts. */
export class OfficialBundleRegistry {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_official_bundles (name TEXT PRIMARY KEY, document TEXT NOT NULL)');
  }
  list(): BundleState[] {
    return this.storage.sql.exec<{document: string}>('SELECT document FROM weft_official_bundles ORDER BY name').toArray().map(row => JSON.parse(row.document) as BundleState);
  }
  bundles() {return optionalBundleInfo(this.list());}
  importConfiguration(rows: BundleState[]): void {
    for(const row of rows) {
      const bundle=shippedBundle(row.name);
      if(!bundle || bundle.digest!==row.digest || bundle.version!==row.version) throw new Error('Copied official bundle is unavailable in this deployment');
      this.storage.sql.exec('INSERT INTO weft_official_bundles VALUES (?,?) ON CONFLICT(name) DO UPDATE SET document=excluded.document',row.name,JSON.stringify(row));
    }
  }
  inspect(spec: string): PluginSpecInspection | undefined {
    if (!namesOfficialBundle(spec)) return undefined;
    const bundle = shippedBundle(spec);
    if (!bundle) return {status: 'refused', problem: 'invalid-spec', reason: 'Only the exact official bundle version included in this deployment is supported.'};
    if (this.list().some(row => row.name === bundle.name && row.digest === bundle.digest && row.version === bundle.version)) return {status: 'refused', problem: 'already-installed', reason: 'This official bundle is already installed. Use its enable switch.'};
    return {status: 'accepted', kind: 'registry', name: bundle.name, version: bundle.version, description: bundle.description, bundle: true, registry: null};
  }
  async change(endpoint: string, args: Record<string, unknown>): Promise<ChangeResult | undefined> {
    const target = String(args.spec ?? args.name ?? '');
    if (!namesOfficialBundle(target)) return undefined;
    const stage = endpoint.endsWith('installBundle') ? 'install' : endpoint.endsWith('removeBundle') ? 'remove' : 'enable';
    const fail = (diagnostic: string): ChangeResult => ({changed: false, application: 'failed', stage, target, error: {code: 'operation-error', diagnostic}});
    const bundle = shippedBundle(target);
    if (!bundle) return fail('Only the exact version shipped with this deployment is available.');
    const old = this.list().find(row => row.name === bundle.name);
    if (endpoint.endsWith('removeBundle')) {
      this.storage.sql.exec('DELETE FROM weft_official_bundles WHERE name=?', bundle.name);
      await this.storage.sync();
      return {changed: Boolean(old), application: 'applied', stage, target, warnings: [warning]};
    }
    if (endpoint.endsWith('setBundleEnabled') && !old) return fail('Install the official bundle first.');
    if (endpoint.endsWith('setBundleEnabled') && old && !availableBundleStates([old]).length) return fail('Reinstall the version included in this deployment before enabling it.');
    const options = (args.options ?? {}) as {enabled?: boolean; registry?: string | null; approvedBuilds?: string[]};
    if (options.registry != null && options.registry.replace(/\/$/, '') !== 'https://registry.npmjs.org' || options.approvedBuilds?.length) return fail('Prebuilt official bundles do not use alternate registries or install scripts.');
    const next: BundleState = {name: bundle.name, version: bundle.version, digest: bundle.digest,
      enabled: endpoint.endsWith('installBundle') ? options.enabled !== false : args.enabled === true};
    const changed = JSON.stringify(old) !== JSON.stringify(next);
    this.storage.sql.exec('INSERT INTO weft_official_bundles VALUES (?,?) ON CONFLICT(name) DO UPDATE SET document=excluded.document', next.name, JSON.stringify(next));
    await this.storage.sync();
    return {changed, application: 'applied', stage, target, enabled: next.enabled, bundle: bundle.name, version: bundle.version, warnings: [warning]};
  }
}
