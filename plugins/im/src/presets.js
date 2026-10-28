import React from 'react';

const h = React.createElement;

/**
 * The Host's Agent Preset roster through `remote.agentPresets`, the same
 * namespace the native preset chip reads. Absent leaves `available()` false
 * and the caller keeps a text field.
 */
export function agentPresets(ctx) {
  // Reading an uninjected service throws, so a child fiber holds it only while it is provided.
  let current;
  ctx.inject(['remote.agentPresets'], child => {child.effect(() => {current = child.remote.agentPresets; return () => {current = undefined;};}, 'dsh-im Agent Preset roster');});
  const service = () => current;
  return Object.freeze({
    available: () => typeof service()?.list === 'function',
    async list() {
      const result = await service().list();
      if (result.ok) return result.value.presets;
      // Without the preset service every Session uses the Host composition.
      if (result.error.code === 'gateway/invocation-unavailable') return [];
      throw new Error(result.error.message);
    },
  });
}

/** Healthy presets plus "follow default"; a saved preset that is missing or broken stays selectable and marked. */
export function PresetSelect({label, value, presets, disabled, onChange, t}) {
  const [roster, setRoster] = React.useState(), [error, setError] = React.useState(), [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setError(undefined);
    presets.list().then(rows => {if (active) setRoster(rows);}, reason => {if (active) setError(reason instanceof Error ? reason.message : String(reason));});
    return () => {active = false;};
  }, [presets, attempt]);
  const healthy = (roster ?? []).filter(row => row.broken === undefined);
  const saved = value && !healthy.some(row => row.id === value) ? value : undefined;
  return h('div', {className: 'im-preset-field'},
    h('label', {className: 'dim-credentialField'}, h('span', null, label),
      h('select', {disabled: disabled || !roster, value: value || '', onChange: event => onChange(event.target.value)},
        h('option', {value: ''}, t('followDefault')),
        healthy.map(row => h('option', {key: row.id, value: row.id}, row.name && row.name !== row.id ? `${row.name} · ${row.id}` : row.id)),
        saved ? h('option', {value: saved}, `${saved} · ${t('presetUnavailable')}`) : null)),
    !roster && !error ? h('p', {className: 'im-description', role: 'status'}, t('presetLoading')) : null,
    error ? h('p', {className: 'im-notice im-error', role: 'alert'}, `${t('presetFailed')} `, h('button', {type: 'button', className: 'im-button', 'data-kind': 'secondary', onClick: () => setAttempt(value => value + 1)}, t('directoryRetry'))) : null);
}
