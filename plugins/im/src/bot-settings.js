import React from 'react';
import {CONTEXT_ENHANCEMENT_FIELDS, normalizeContextEnhancementConfig} from './reference/context-enhancement.mjs';

const h = React.createElement;
const scenes = channel => ['weixin', 'email'].includes(channel) ? ['direct'] : ['direct', 'group'];

export function ModelSettings({selection, catalog, load, disabled, loadingDisabled, onChange, t}) {
  const key = selection ? JSON.stringify([selection.provider, selection.model]) : '';
  const entries = (catalog?.groups ?? []).flatMap(group => group.models.map(model => ({...model, provider: group.id})));
  const selected = entries.find(model => model.provider === selection?.provider && model.id === selection?.model);
  return h('div', {className: 'im-model-settings'},
    h('label', {className: 'dim-credentialField'}, t('model'), h('select', {disabled: disabled || !catalog, value: key,
      onChange: event => {
        const model = entries.find(entry => JSON.stringify([entry.provider, entry.id]) === event.target.value);
        onChange(model ? {provider: model.provider, model: model.id} : null);
      }}, h('option', {value: ''}, t('followDefault')),
    selection && !selected ? h('option', {value: key, disabled: true}, `${selection.provider} / ${selection.model}`) : null,
    ...(catalog?.groups ?? []).map(group => h('optgroup', {key: group.id, label: group.name}, ...group.models.map(model => h('option', {key: model.id, value: JSON.stringify([group.id, model.id])}, model.name)))))),
    h('label', {className: 'dim-credentialField'}, t('reasoningEffort'), h('select', {disabled: disabled || !selected?.reasoning, value: selection?.reasoningEffort ?? '', onChange: event => {
      const {reasoningEffort: _, ...route} = selection;
      onChange(event.target.value ? {...route, reasoningEffort: event.target.value} : route);
    }}, h('option', {value: ''}, t('modelDefault')), ...(selected?.reasoning?.efforts ?? []).map(effort => h('option', {key: effort.id, value: effort.id}, effort.description ? `${effort.name} — ${effort.description}` : effort.name)))),
    h('button', {type: 'button', className: 'im-button', disabled: loadingDisabled, onClick: load}, t(catalog ? 'refreshModels' : 'loadModels')),
    h('p', {className: 'im-description'}, t('modelSelectionHint')),
    ...(catalog?.failures ?? []).map(failure => h('p', {key: failure.id, className: 'im-description', role: 'status'}, `${failure.name}: ${t('catalogProviderFailed')}`)));
}

/** Upgrade the old shared list only when an administrator edits the new policy. */
export function editableAccessPolicy(value) {
  if (value.accessPolicy != null) return value.accessPolicy;
  const scope = () => ({mode: 'allowlist', open: {defaultCanExecuteCommands: false, commandPermissionOverrides: []},
    allowlist: {users: (value.allowedSenders ?? []).filter(id => id.trim()).map(id => ({id: id.trim(), canExecuteCommands: true}))}});
  return {direct: scope(), group: scope()};
}

export function AccessSettings({channel, value, edit, disabled, t}) {
  const policy = editableAccessPolicy(value);
  const update = (scene, scope) => edit('accessPolicy', {...policy, [scene]: scope});
  return h(React.Fragment, null,
    h('p', {className: 'im-description'}, t(channel === 'email' ? 'emailAccessHint' : 'accessOwnerHint')),
    ...scenes(channel).map(scene => {
      const scope = policy[scene], open = scope.mode === 'open';
      const branch = open ? 'open' : 'allowlist', key = open ? 'commandPermissionOverrides' : 'users';
      const users = scope[branch][key];
      const changeUsers = next => update(scene, {...scope, [branch]: {...scope[branch], [key]: next}});
      return h('fieldset', {key: scene, className: 'im-settings-scene', disabled},
        h('legend', null, t(scene)),
        h('label', {className: 'dim-credentialField'}, t('accessMode'), h('select', {value: scope.mode, onChange: event => update(scene, {...scope, mode: event.target.value})},
          h('option', {value: 'allowlist'}, t('allowlist')), h('option', {value: 'open'}, t('openAccess')))),
        open ? h('label', {className: 'im-checkbox'}, h('input', {type: 'checkbox', checked: scope.open.defaultCanExecuteCommands,
          onChange: event => update(scene, {...scope, open: {...scope.open, defaultCanExecuteCommands: event.target.checked}})}), t('defaultCommandPermission')) : null,
        h('p', {className: 'im-description'}, t(open ? 'commandOverridesHint' : 'allowlistHint')),
        ...users.map((user, index) => h('div', {key: index, className: 'im-policy-user'},
          h('label', {className: 'dim-credentialField'}, t(channel === 'email' ? 'emailSender' : 'userId'), h('input', {type: 'text', value: user.id, autoComplete: 'off', maxLength: 256,
            onChange: event => changeUsers(users.map((entry, n) => n === index ? {...entry, id: event.target.value} : entry))})),
          h('label', {className: 'im-checkbox'}, h('input', {type: 'checkbox', checked: user.canExecuteCommands,
            onChange: event => changeUsers(users.map((entry, n) => n === index ? {...entry, canExecuteCommands: event.target.checked} : entry))}), t('canExecuteCommands')),
          h('button', {type: 'button', className: 'im-button', onClick: () => changeUsers(users.filter((_, n) => n !== index))}, t('removeUser')))),
        h('button', {type: 'button', className: 'im-button', onClick: () => changeUsers([...users, {id: '', canExecuteCommands: false}])}, t('addUser')));
    }));
}

export function ContextSettings({channel, value, edit, disabled, t}) {
  const config = normalizeContextEnhancementConfig(value.contextEnhancement);
  return h(React.Fragment, null, h('p', {className: 'im-description'}, t('contextHint')),
    ...scenes(channel).map(scene => {
      const scope = config[scene];
      const update = patch => edit('contextEnhancement', {...config, [scene]: {...scope, ...patch}});
      return h('fieldset', {key: scene, className: 'im-settings-scene', disabled},
        h('legend', null, t(scene)),
        h('label', {className: 'im-checkbox'}, h('input', {type: 'checkbox', role: 'switch', checked: scope.enabled, onChange: event => update({enabled: event.target.checked})}), t('enableContext')),
        h('div', {className: 'im-context-fields'}, ...CONTEXT_ENHANCEMENT_FIELDS.map(field => h('label', {key: field, className: 'im-checkbox'},
          h('input', {type: 'checkbox', checked: scope.fields.includes(field), disabled: disabled || !scope.enabled,
            onChange: event => update({fields: event.target.checked ? [...scope.fields, field] : scope.fields.filter(item => item !== field)})}), t(`source_${field}`)))),
        h('label', {className: 'dim-credentialField'}, t('contextGuidance'), h('textarea', {rows: 4, maxLength: 8000, disabled: disabled || !scope.enabled, value: scope.guidance, onChange: event => update({guidance: event.target.value})})));
    }));
}
