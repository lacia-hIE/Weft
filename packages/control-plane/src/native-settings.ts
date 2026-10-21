import type Schema from '@deepseek-ai/schemastery';
import { Context } from '@deepseek-ai/cordis';
import { Config as DeepSeekConfig, resolveAdapterOptions, type Options as DeepSeekOptions } from '@weft/upstream/packages/llm/llm-deepseek-api-key/src/config.ts';
import { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model';
import { Config as DeveloperToolsConfig } from '@weft/upstream/packages/client/ui-settings/src/index.ts';
import { Config as WelcomeConfig } from '@weft/upstream/packages/client/ui-settings-general/src/index.ts';
import { plainConfig, projectForm, volatileForm, isVolatilePath } from '@weft/upstream/packages/settings/settings/src/schema.ts';
import { redactSecrets } from '@weft/upstream/packages/settings/settings/src/redact.ts';
import type { SettingsNamespaceView, SettingsDescribeValue, SettingsPathOpView } from '@deepseek-ai/dsh-settings/types';
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import settingsRemote from '../../../.generated/official-remotes/packages/api/settings-controller/typert.remote-client.js';
import { DurableCredentials } from './native-credentials.ts';
import type { D1SettingsDocuments } from '../../config-store/src/index.ts';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Subagents from '@deepseek-ai/dsh-subagent';
import PermissionPresets from '@deepseek-ai/dsh-permission-presets';
import PluginMarket from '@deepseek-ai/dsh-plugin-market';
import { profileSettingRows } from '../../native-profile/src/settings-rows.ts';
import YAML from 'yaml';
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai';

// The official composition's entry id differs from its provider package name.
// The curated Models editor addresses this entry id.
export const MODEL_NAMESPACE = 'llm-deepseek';
export const DEFAULT_MODEL_NAMESPACE = 'agent-default-model';
export const PRESET_NAMESPACE = 'agent-preset-registry';
export const LOOP_NAMESPACE = 'agent-loop';
export const SUBAGENT_NAMESPACE = 'subagent';
export const PERMISSION_NAMESPACE = 'permission';
export const MARKET_NAMESPACE = 'plugin-market';
export const PI_AI_NAMESPACE = 'llm-pi-ai';
type Section = Record<string, unknown>;
interface Namespace {
  id: string; schema: Schema; base(): Section; autoGenerate: boolean;
  validate(value: Section): void;
  /** Held for a service the official profile does not mount, so Settings does not list it. */
  hidden?: true;
  /** An official profile row loaded by the Loader; its value overrides the row's configuration. */
  profileRow?: true;
}
export interface NativeSettingsHost {
  providerBase(): Section;
  modelBase(): Section;
  changed(event: string, args: readonly unknown[]): void;
  validatePreset?(id: string): void;
  /** Materialize the configuration document where the environment's client can open it. */
  openDocument?(): Promise<void>;
}

/** The header of the configuration document; the rows below replace the environment's configuration as a whole. */
export const DOCUMENT_HEADER = [
  '# This environment\'s plugin configuration, as official profile patch rows: one row per edited entry.',
  '# Saving replaces the whole configuration once every row passes its plugin schema; a rejected document',
  '# leaves the configuration unchanged and explains why in profile.error.txt. Secret fields are never',
  '# written here and keep their values.',
].join('\n');
const object = (value: unknown): value is Section => value !== null && typeof value === 'object' && !Array.isArray(value);
function reference(value: string): CredentialRef {
  try { return credentialRef(value); }
  catch { throw new RemoteError('gateway/bad-request', 'Invalid credential reference', {}); }
}
/** Plain objects merge; arrays and scalar values replace, matching native profile layers. */
function merge(base: Section, patch: Section): Section {
  const result = {...base};
  for (const [key, value] of Object.entries(patch)) Object.defineProperty(result, key, {value: object(value) && object(base[key]) ? merge(base[key], value) : structuredClone(value), enumerable: true, writable: true, configurable: true});
  return result;
}
function editPath(value: unknown, path: readonly string[], op: SettingsPathOpView, node?: Schema): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return op.op === 'set' ? structuredClone(op.value) : undefined;
  if (value === undefined) value = node?.meta.default;
  if (Array.isArray(value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(head) || Number(head) > value.length || (Number(head) === value.length && (rest.length > 0 || op.op === 'unset'))) throw new Error('Config array index is out of range');
    const next = [...value];
    if (rest.length === 0 && op.op === 'unset') next.splice(Number(head), 1);
    else next[Number(head)] = editPath(value[Number(head)], rest, op, node?.inner);
    return next;
  }
  const next = object(value) ? {...value} : {};
  const child = editPath(Object.hasOwn(next, head) ? next[head] : undefined, rest, op, Object.hasOwn(node?.dict ?? {}, head) ? node?.dict?.[head] : node?.inner);
  if (child === undefined) Reflect.deleteProperty(next, head);
  else Object.defineProperty(next, head, {value: child, enumerable: true, writable: true, configurable: true});
  return next;
}

/** CF profile persistence consumes the original schema, volatile forms and redaction. */
export class NativeSettings {
  readonly credentials: DurableCredentials;
  private readonly namespaces: Namespace[];
  constructor(storage: DurableObjectStorage, private readonly host: NativeSettingsHost, private readonly documents: D1SettingsDocuments) {
    this.credentials = new DurableCredentials(new Context(), storage, (event, ref) => host.changed(event, [ref]));
    this.namespaces = [
      {id: MODEL_NAMESPACE, schema: DeepSeekConfig, base: () => host.providerBase(), autoGenerate: false, validate: value => {
        const options = resolveAdapterOptions(value as DeepSeekOptions);
        if (new URL(options.baseURL).protocol !== 'https:') throw new Error('Provider endpoint must use HTTPS');
      }},
      {id: DEFAULT_MODEL_NAMESPACE, schema: AgentDefaultModelConfig.Config, base: () => host.modelBase(), autoGenerate: false, validate: () => {}},
      {id: PRESET_NAMESPACE, schema: AgentPresets.Config, base: () => ({default: 'standard'}), autoGenerate: false, validate: value => {host.validatePreset?.(String(value.selectedDefault ?? value.default));}},
      {id: LOOP_NAMESPACE, schema: AgentLoop.Config, base: () => ({agents: []}), autoGenerate: false, validate: () => {}},
      {id: SUBAGENT_NAMESPACE, schema: Subagents.Config, base: () => ({}), autoGenerate: false, validate: () => {}},
      {id: PERMISSION_NAMESPACE, schema: PermissionPresets.Config, base: () => ({}), autoGenerate: false, validate: value => {
        const presets = PermissionPresets.Config(value as never).presets as Record<string, unknown>;
        if (value.defaultPreset !== undefined && !Object.hasOwn(presets, String(value.defaultPreset))) throw new Error('Unknown permission preset');
      }},
      {id: PI_AI_NAMESPACE, schema: PiAiConfig, base: () => ({}), autoGenerate: false, validate: value => {
        for (const profile of Object.values(object(value.providers) ? value.providers : {})) {
          if (object(profile) && profile.baseURL !== undefined && new URL(String(profile.baseURL)).protocol !== 'https:') throw new Error('Provider endpoint must use HTTPS');
        }
      }},
      {id: MARKET_NAMESPACE, schema: PluginMarket.Config, base: () => ({}), autoGenerate: false, validate: () => {}, hidden: true},
      {id: 'ui-settings', schema: DeveloperToolsConfig, base: () => ({}), autoGenerate: false, validate: () => {}},
      {id: 'ui-settings-general', schema: WelcomeConfig, base: () => ({}), autoGenerate: false, validate: () => {}},
    ];
    // Profile rows the Loader composes: their forms come from the official schemas, edits override the profile configuration.
    for (const row of profileSettingRows) {
      if (this.namespaces.some(ns => ns.id === row.id)) continue;
      this.namespaces.push({id: row.id, schema: row.schema, base: () => structuredClone(row.base), autoGenerate: false, validate: () => {}, profileRow: true});
    }
  }
  /** The environment's configuration of the profile rows it has edited, applied to Loader rows in every world. */
  profileOverrides(): Record<string, Section> {
    return Object.fromEntries(this.namespaces.filter(ns => ns.profileRow && Object.keys(this.row(ns.id).user).length > 0).map(ns => [ns.id, this.value(ns.id)]));
  }
  private namespace(id: string): Namespace {
    const ns = this.namespaces.find(row => row.id === id);
    if (!ns) throw new RemoteError('settings/rejected', 'No configurable plugin entry', {ns: id});
    return ns;
  }
  private row(ns: string): {revision: number; user: Section} {
    return this.documents.get(ns);
  }
  value(id: string): Section {
    const ns = this.namespace(id);
    return plainConfig(ns.schema(merge(ns.base(), this.row(id).user))) as Section;
  }
  private view(id: string): SettingsNamespaceView {
    const ns = this.namespace(id), form = volatileForm(ns.schema);
    if (!form) throw new Error('Namespace has no volatile configuration');
    const {revision, user} = this.row(id);
    const redaction = form as Schema<never>;
    const value = redactSecrets(redaction, projectForm(form, this.value(id)));
    const base = plainConfig(ns.schema(ns.base()));
    return settingsRemote.methods['settings/update'].result.create().parse({ns: id, revision, autoGenerate: ns.autoGenerate, schema: form.toJSON(), value: value.value, base: redactSecrets(redaction, projectForm(form, base)).value, user: redactSecrets(redaction, projectForm(form, user)).value, secrets: value.secrets, applies: 'live'});
  }
  describe(): SettingsDescribeValue {
    return {writable: true, hasDocument: this.host.openDocument !== undefined, namespaces: this.namespaces.filter(ns => !ns.hidden).map(ns => this.view(ns.id))};
  }
  /** Reject a user section its namespace would not accept: unknown or non-live fields, schema or provider failures. */
  private check(ns: Namespace, next: Section): void {
    for (const key of Object.keys(next)) if (!Object.hasOwn(ns.schema.dict ?? {}, key) || !isVolatilePath(ns.schema, [key])) throw new Error(`Config field "${key}" of "${ns.id}" is not editable`);
    const effective = merge(ns.base(), next);
    ns.schema(effective);
    ns.validate(effective);
  }
  private secrets(ns: Namespace, user: Section): readonly {path: string[]; set: boolean}[] {
    const form = volatileForm(ns.schema);
    return form ? redactSecrets(form as Schema<never>, user).secrets : [];
  }
  /** The environment's configuration as official profile patch rows, secrets left out. */
  document(): string {
    const rows = this.namespaces.flatMap(ns => {
      const {user} = this.row(ns.id);
      if (Object.keys(user).length === 0) return [];
      const form = volatileForm(ns.schema);
      return [{id: ns.id, config: form ? redactSecrets(form as Schema<never>, user).value : user}];
    });
    return `${DOCUMENT_HEADER}\n${rows.length ? YAML.stringify(rows) : '[]\n'}`;
  }
  /**
   * Replace the environment's configuration with a document's rows. Every row
   * is checked before anything is written; an entry the document leaves out
   * returns to its profile configuration, and secret fields keep their values.
   * @throws Error naming the first rejected row; nothing is written then.
   */
  async replaceDocument(text: string): Promise<void> {
    const parsed: unknown = YAML.parse(text) ?? [];
    if (!Array.isArray(parsed)) throw new Error('The document must be a YAML list of profile rows');
    const next = new Map<string, Section>();
    for (const [index, row] of parsed.entries()) {
      if (!object(row) || typeof row.id !== 'string') throw new Error(`Row ${index + 1} needs an id`);
      const ns = this.namespaces.find(item => item.id === row.id);
      if (!ns) throw new Error(`"${row.id}" is not a configurable plugin entry`);
      if (next.has(ns.id)) throw new Error(`"${ns.id}" appears more than once`);
      const config = row.config ?? {};
      if (!object(config)) throw new Error(`The config of "${ns.id}" must be a mapping`);
      const user = structuredClone(config);
      const current = this.row(ns.id).user;
      for (const secret of this.secrets(ns, current)) {
        if (!secret.set) continue;
        const kept = secret.path.reduce<unknown>((value, key) => object(value) ? value[key] : undefined, current);
        let target: Section = user;
        for (const key of secret.path.slice(0, -1)) target = object(target[key]) ? target[key] as Section : (target[key] = {}) as Section;
        const last = secret.path.at(-1)!;
        if (!Object.hasOwn(target, last)) target[last] = kept;
      }
      try { this.check(ns, user); }
      catch (error) { throw new Error(`"${ns.id}": ${error instanceof Error ? error.message : String(error)}`); }
      next.set(ns.id, user);
    }
    for (const ns of this.namespaces) {
      const user = next.get(ns.id) ?? {};
      if (JSON.stringify(user) !== JSON.stringify(this.row(ns.id).user)) await this.write(ns.id, undefined, () => user);
    }
  }
  /** Preset declarations are dependencies of the roster/default settings view. */
  async invalidate(id: string): Promise<void> {
    this.namespace(id);
    const {revision} = await this.documents.update(id, current => ({revision: current.revision + 1, user: current.user}));
    this.host.changed('settings/document-updated', [id, revision]);
  }
  private async write(id: string, expected: number | undefined, change: (user: Section, schema: Schema) => Section): Promise<SettingsNamespaceView> {
    const ns = this.namespace(id);
    const {revision} = await this.documents.update(id, current => {
      if (expected !== undefined && expected !== current.revision) throw new RemoteError('settings/conflict', 'Configuration changed since it was read', {ns: id, expected, actual: current.revision});
      const next = change(current.user, ns.schema);
      this.check(ns, next);
      return {revision: current.revision + Number(JSON.stringify(current.user) !== JSON.stringify(next)), user: next};
    });
    this.host.changed('settings/document-updated', [id, revision]);
    return this.view(id);
  }
  async saveMarketIndexes(indexes: string[]): Promise<void> {
    await this.write(MARKET_NAMESPACE, undefined, user => ({...user, indexes}));
  }
  async saveDefault(selected: {provider: string; model: string; reasoningEffort?: string}): Promise<void> {
    await this.write(DEFAULT_MODEL_NAMESPACE, undefined, () => ({...selected}));
  }
  /** The effective sections the official model entries run with, and the environment's explicit default selection. */
  modelSections(): {deepseek: Section; piAi: Section; baseModel: {provider: string; model: string; reasoningEffort?: string}; defaultModel?: {provider: string; model: string; reasoningEffort?: string}} {
    const defaults = this.value(DEFAULT_MODEL_NAMESPACE);
    const selection = {provider: String(defaults.provider), model: String(defaults.model), ...(defaults.reasoningEffort === undefined ? {} : {reasoningEffort: String(defaults.reasoningEffort)})};
    const explicit = Object.keys(this.row(DEFAULT_MODEL_NAMESPACE).user).length > 0;
    return {deepseek: this.value(MODEL_NAMESPACE), piAi: this.value(PI_AI_NAMESPACE), baseModel: selection, ...(explicit ? {defaultModel: selection} : {})};
  }
  async invoke(endpoint: string, raw: unknown): Promise<Response> {
    type Method = keyof typeof settingsRemote.methods;
    const method = settingsRemote.methods[endpoint as Method];
    if (!method) throw new RemoteError('gateway/method-unavailable', 'Settings method is not connected', {endpoint});
    // Preserve boundary validation across RPC; native ZodError instances do not
    // retain their class identity when transported out of a Durable Object.
    try { method.input({strict: true}).create().parse(raw); }
    catch { throw new RemoteError('gateway/bad-request', 'Invalid Remote arguments', {}); }
    let value: unknown;
    let subject = '';
    try {
      switch (endpoint) {
        case 'settings/describe': settingsRemote.methods[endpoint].input({strict: true}).create().parse(raw); value = this.describe(); break;
        case 'settings/openSettingsDocument': {
          settingsRemote.methods[endpoint].input({strict: true}).create().parse(raw);
          if (!this.host.openDocument) throw new RemoteError('settings/rejected', 'This environment has no configuration document', {ns: ''});
          await this.host.openDocument();
          value = {opened: true}; break;
        }
        case 'settings/update': case 'settings/replace': {
          const args = endpoint === 'settings/update' ? settingsRemote.methods[endpoint].input({strict: true}).create().parse(raw) : settingsRemote.methods[endpoint].input({strict: true}).create().parse(raw);
          subject = args.ns;
          const input = 'patch' in args ? args.patch : args.section;
          if (!object(input)) throw new Error('Expected an object section');
          value = await this.write(args.ns, args.expectedRevision, user => endpoint === 'settings/update' ? merge(user, input) : input); break;
        }
        case 'settings/mutate': {
          const args = settingsRemote.methods[endpoint].input({strict: true}).create().parse(raw);
          subject = args.ns;
          value = await this.write(args.ns, args.expectedRevision, (user, schema) => {
            let next: unknown = user;
            for (const op of args.ops) {
              if (op.path.length && !isVolatilePath(schema, op.path)) throw new Error('Config field is not editable');
              next = editPath(next, op.path, op, schema);
            }
            if (!object(next)) throw new Error('Config root must be an object');
            return next;
          }); break;
        }
        case 'credentials/describe': {
          const args = settingsRemote.methods[endpoint].input({strict: true}).create().parse(raw);
          if (args.refs.length > 64) throw new RemoteError('gateway/bad-request', 'At most 64 credential references are accepted', {});
          const refs = args.refs.map(reference);
          value = Object.fromEntries(await Promise.all(refs.map(async ref => [ref, await this.credentials.describe(ref)]))); break;
        }
        case 'credentials/set': {
          const args = settingsRemote.methods[endpoint].input({strict: true}).create().parse(raw);
          subject = args.ref;
          if (!args.value.length) throw new RemoteError('gateway/bad-request', 'Credential value must not be empty', {});
          await this.credentials.set(reference(args.ref), args.value); break;
        }
        case 'credentials/unset': {
          const args = settingsRemote.methods[endpoint].input({strict: true}).create().parse(raw);
          subject = args.ref;
          await this.credentials.unset(reference(args.ref)); break;
        }
      }
      return Response.json({value: method.result.create().parse(value)});
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      if (endpoint.startsWith('credentials/')) throw new RemoteError('credential/rejected', 'Credential operation was rejected', {ref: subject});
      throw new RemoteError('settings/rejected', 'Configuration was rejected by the plugin schema or provider', {ns: subject});
    }
  }
}
