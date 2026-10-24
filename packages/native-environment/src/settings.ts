import {Context} from '@deepseek-ai/cordis';
import SettingsForms, {type SettingsDescriptor} from '@deepseek-ai/dsh-settings';
import type {ConfigEditor} from '@deepseek-ai/dsh-config-editor';
import type {Entry} from '@deepseek-ai/cordis-plugin-loader';
import type Schema from '@deepseek-ai/schemastery';
import {workerdLoader, createEntry} from '../../native-profile/src/loader.ts';
import {updateLoaderEntry} from '../../plugin-registry/src/host.ts';
import type {DurableSettingsDocuments} from '../../environment-storage/src/index.ts';

type Section = Record<string, unknown>;
export interface SettingsEntryDefinition {id: string; schema: Schema; base(): Section; autoGenerate: boolean;}
declare module '@deepseek-ai/cordis' {interface Context {weftSettingsPersistence: {revision(id: string): number}}}
const object = (value: unknown): value is Section => value !== null && typeof value === 'object' && !Array.isArray(value);
function merge(base: Section, patch: Section): Section {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) Object.defineProperty(result, key, {value: object(value) && object(base[key]) ? merge(base[key], value) : structuredClone(value), enumerable: true, writable: true, configurable: true});
  return result;
}
/** Profile inheritance is persisted as overrides, including replacement arrays. */
function overrides(value: Section, base: Section): Section {
  const result: Section = {};
  for (const [key, item] of Object.entries(value)) {
    if (JSON.stringify(item) === JSON.stringify(base[key])) continue;
    const next = object(item) && object(base[key]) ? overrides(item, base[key]) : item;
    if (object(next) && object(base[key]) && Object.keys(next).length === 0) continue;
    Object.defineProperty(result, key, {value: structuredClone(next), enumerable: true, writable: true, configurable: true});
  }
  return result;
}

/**
 * A real Loader composition for schema-backed configuration, without creating
 * Agents or executing the configured tools. SettingsForms owns form projection,
 * field/path edits, JSON validation, redaction and conflict checking.
 */
export class EnvironmentSettings {
  private readonly ready: Promise<Context>;
  private syncWork: Promise<unknown> = Promise.resolve();
  private applied = -1;
  private description: {revision: number; value: SettingsDescriptor[]} | undefined;
  constructor(private readonly documents: DurableSettingsDocuments, private readonly definitions: readonly SettingsEntryDefinition[], validate: (id: string, user: Section) => void) {
    this.ready = (async () => {
      const ctx = new Context();
      try {
        const modules = Object.fromEntries(definitions.map(row => [this.module(row.id), {name: this.module(row.id), Config: row.schema, apply: () => {}}]));
        const loader = await workerdLoader(ctx, modules);
        for (const row of definitions) await createEntry(loader, {id: row.id, name: this.module(row.id), config: merge(row.base(), documents.get(row.id).user)});
        const editor = {
          documentPath: '/workspace/.dsh/profile.yml',
          entries: () => [...loader.entries()],
          configuration: () => definitions.map(row => ({entry: loader.resolve(row.id), inherited: row.base(), override: documents.get(row.id).user})),
          edit: async (entry: Entry, change: (raw: Section, inherited: Section) => Section): Promise<void> => {
            const definition = definitions.find(row => row.id === entry.options.id);
            if (!definition || loader.resolve(definition.id) !== entry) throw new Error('Configuration entry changed');
            await documents.update(definition.id, current => {
              const inherited = definition.base();
              const user = overrides(change(merge(inherited, current.user), inherited), inherited);
              validate(definition.id, user);
              return {revision: current.revision + Number(JSON.stringify(current.user) !== JSON.stringify(user)), user};
            });
            await this.sync();
          },
        };
        ctx.provide('configEditor', editor as unknown as ConfigEditor);
        ctx.provide('weftSettingsPersistence', {revision: id => documents.get(id).revision});
        await ctx.plugin(SettingsForms);
        for (const row of definitions) ctx.settings.configure({auto: row.autoGenerate}, loader.resolve(row.id).fiber!);
        this.applied = documents.revision;
        return ctx;
      } catch (error) {await ctx.fiber.dispose(); throw error;}
    })();
    void this.ready.catch(() => {});
  }
  private module(id: string): string {return `weft:settings:${id}`;}
  private sync(): Promise<void> {
    const pending = this.syncWork.then(async () => {
      const ctx = await this.ready;
      const revision = this.documents.revision;
      if (revision === this.applied) return;
      for (const row of this.definitions) {
        const entry = ctx.loader.resolve(row.id), config = merge(row.base(), this.documents.get(row.id).user);
        if (JSON.stringify(entry.options.config) !== JSON.stringify(config)) await updateLoaderEntry(ctx.loader, {...entry.options, config});
      }
      this.applied = revision;
    });
    this.syncWork = pending.catch(() => {});
    return pending;
  }
  async describe(): Promise<SettingsDescriptor[]> {
    const ctx = await this.ready;
    for (;;) {
      await this.sync();
      if (this.applied !== this.documents.revision) continue;
      const revision = this.applied;
      if (this.description?.revision !== revision) this.description = {revision, value: ctx.settings.describe({redactSecrets: true})};
      return structuredClone(this.description.value);
    }
  }
  async update(method: 'update' | 'replace' | 'mutate', ns: string, value: unknown, expected?: number): Promise<void> {
    await this.sync();
    const service = (await this.ready).settings;
    if (method === 'update') await service.update(ns, value as Section, expected);
    else if (method === 'replace') await service.replace(ns, value as Section, expected);
    else await service.mutate(ns, value as Parameters<SettingsForms['mutate']>[1], expected);
  }
  async dispose(): Promise<void> {await (await this.ready).fiber.dispose();}
}
