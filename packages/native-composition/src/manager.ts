import {RemoteError} from '@deepseek-ai/dsh-typert-protocol';
import remote from '../../../.generated/official-remotes/packages/boot/plugin-manager/typert.remote-client.js';
import type {ChangeResult} from '@deepseek-ai/dsh-plugin-manager/types';
import type {AgentSpec, AgentRevision} from '../../control-plane/src/contracts.ts';
import {profileManifest, presetEntryId} from '../../harness-profile/src/index.ts';
import {isManageableProfileRow} from '../../harness-profile/src/management.ts';
import {officialPluginIds, officialBundleNames} from './inventory.ts';

interface ProfileManagementHost {
  profiles(): Promise<AgentRevision[]>;
  defaultPreset(): Promise<string>;
  publish(spec: AgentSpec, expectedRevision: number): Promise<Response>;
  setProfileEnabled(id: string, enabled: boolean): Promise<boolean>;
}

/** Original Remote contracts over a scoped, durable profile publisher. */
export async function manageNativePlugins(host: ProfileManagementHost, endpoint: string, raw: unknown): Promise<Response> {
    const method = remote.methods[endpoint as keyof typeof remote.methods];
    if (!method) throw new RemoteError('gateway/method-unavailable', 'Unknown plugin management method', {endpoint});
    let args: Record<string, unknown>;
    try {args = method.input({strict: true}).create().parse(raw) as Record<string, unknown>;}
    catch {throw new RemoteError('gateway/bad-request', 'Invalid plugin management arguments', {});}
    let value: unknown;
    if (endpoint === 'pluginManager/setPluginEnabled') {
      const entryId = String(args.id);
      const preset = (await host.profiles()).find(row => presetEntryId(row.spec.id) === entryId);
      const failure = (code: 'unknown-plugin' | 'management-required'): ChangeResult => ({changed: false, application: 'failed', stage: 'enable', target: entryId, enabled: Boolean(args.enabled), error: {code}});
      if (isManageableProfileRow(entryId)) value = {changed: await host.setProfileEnabled(entryId, Boolean(args.enabled)), application: 'applied', stage: 'enable', target: entryId, enabled: Boolean(args.enabled),
        warnings: ['Saved for this environment. Applies before the next turn; active turns finish unchanged.']} satisfies ChangeResult;
      else if (!preset) value = failure(officialPluginIds.has(entryId) ? 'management-required' : 'unknown-plugin');
      else if (!args.enabled && preset.spec.id === await host.defaultPreset()) value = failure('management-required');
      else if (Boolean(preset.spec.disabled) === !args.enabled) value = {changed: false, application: 'applied', stage: 'enable', target: entryId, enabled: args.enabled};
      else {
        const response = await host.publish({...preset.spec, disabled: !args.enabled}, preset.revision);
        if (!response.ok) throw new RemoteError('gateway/internal', 'Preset enablement was rejected', {});
        value = {changed: true, application: 'applied', stage: 'enable', target: entryId, enabled: args.enabled};
      }
    } else if (endpoint === 'pluginManager/setBundleEnabled' || endpoint === 'pluginManager/removeBundle') {
      value = {changed: false, application: 'failed', stage: endpoint.endsWith('removeBundle') ? 'remove' : 'enable', target: args.name, error: {code: args.name === profileManifest.name || officialBundleNames.includes(String(args.name)) ? 'management-required' : 'unknown-plugin'}};
    } else if (endpoint === 'pluginManager/registries') {
      value = {registry: null, fallbackRegistries: [], resolved: null};
    } else if (endpoint === 'pluginManager/inspect') {
      value = {status: 'refused', problem: args.spec === profileManifest.name ? 'already-installed' : 'unknown', reason: args.spec === profileManifest.name ? 'This composition is included in the deployment.' : 'Runtime package installation is not connected. The workerd host currently loads prebuilt modules and approved dynamic Cordis packages.'};
    } else if (endpoint === 'pluginManager/installBundle') {
      value = {changed: false, application: 'failed', stage: 'install', target: args.spec, error: {code: 'operation-error', diagnostic: 'Runtime package installation is not connected for this workerd host.'}};
    } else throw new RemoteError('gateway/method-unavailable', 'Package operation is not connected for this workerd host', {endpoint});
    return Response.json({value: method.result.create().parse(value)});
}
