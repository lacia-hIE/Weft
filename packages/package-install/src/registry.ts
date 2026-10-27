import type {Installation, InstallJob} from './contracts.ts';
import {entryId, entryNamespace} from './contracts.ts';
import type {BundleInfo, PluginInfo} from '@deepseek-ai/dsh-plugin-manager/types';

/** Environment-owned declarations and durable installation receipts. Never stores module bytes in SQL. */
export class PackageRegistry {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_installed_packages (name TEXT PRIMARY KEY, document TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_package_jobs (id TEXT PRIMARY KEY, document TEXT NOT NULL)');
  }
  list(): Installation[] {return this.storage.sql.exec<{document: string}>('SELECT document FROM weft_installed_packages ORDER BY name').toArray().map(row => {
    const value = JSON.parse(row.document) as Installation;
    // Keep pre-native records removable without treating their old approval as
    // authority for the new format, or breaking the entire Plugins catalogue.
    return Array.isArray(value.patch) && Array.isArray(value.rows) ? value : {...value, patch: [], rows: [], enabled: false, approved: false, needsReinstall: true as const};
  });}
  get(name: string): Installation | undefined {return this.list().find(row => row.name === name);}
  save(value: Installation): void {this.storage.sql.exec('INSERT INTO weft_installed_packages VALUES (?,?) ON CONFLICT(name) DO UPDATE SET document=excluded.document', value.name, JSON.stringify(value));}
  remove(name: string): void {this.storage.sql.exec('DELETE FROM weft_installed_packages WHERE name=?', name);}
  jobs(): InstallJob[] {return this.storage.sql.exec<{document: string}>('SELECT document FROM weft_package_jobs ORDER BY rowid DESC LIMIT 32').toArray().map(row => JSON.parse(row.document));}
  job(id: string): InstallJob | undefined {return this.jobs().find(row => row.id === id);}
  saveJob(value: InstallJob): void {
    this.storage.sql.exec('INSERT INTO weft_package_jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document', value.id, JSON.stringify(value));
    this.storage.sql.exec('DELETE FROM weft_package_jobs WHERE id NOT IN (SELECT id FROM weft_package_jobs ORDER BY rowid DESC LIMIT 32)');
  }
  bundles(): BundleInfo[] {return this.list().map(row => ({
    name: row.name, version: row.version, description: row.description, official: false,
    availability: 'profile', source: `${row.name}@${row.version}`, installed: true,
    enabled: row.enabled && row.approved, optional: false, removable: true,
    rows: row.rows.filter(item => !item.group).map(item => ({rowId: entryNamespace(row.name, String(item.id)), moduleName: String(item.name), entryId: entryId(row.name)})), overrides: row.patch.filter(item => item.id && !item.insert).map(item => String(item.id)),
    ...(!row.approved ? {error: {code: 'stale-approval' as const, diagnostic: row.needsReinstall ? 'Remove and reinstall this package using its native dsh.bundle.patch declaration.' : 'Built and installed; review this bundle’s patch, exact artifact and capabilities on its detail page before enabling.'}} : {}),
  }));}
  plugins(): PluginInfo[] {return this.list().map(row => ({entryId: entryId(row.name) as never, readOnlyReason: 'management-required', moduleName: row.name,
    enabled: row.enabled && row.approved, fiberPhase: null, meta: {title: row.name, description: row.description}}));}
}
