// Bundled into the native client; every rule stays inside this plugin's form.
export const connectionStyles=`
[data-weft-local-connection] { box-sizing: border-box; display: grid; gap: 20px; min-width: 0; padding: 20px; border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-lg, 12px); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
[data-weft-local-connection] p, [data-weft-local-connection] h4, [data-weft-local-connection] dl, [data-weft-local-connection] dd { margin: 0; }
[data-weft-local-connection] .weft-connection-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 12px; }
[data-weft-local-connection] .weft-connection-title { font-size: 14px; line-height: 20px; font-weight: 500; }
[data-weft-local-connection] .weft-connection-description { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
[data-weft-local-connection] .weft-connection-status { flex: none; max-width: 100%; }
[data-weft-local-connection] .weft-connection-status > span { white-space: normal; }
[data-weft-local-connection] .weft-connection-destination { min-width: 0; padding: 12px 0; border-block: .5px solid var(--dsw-alias-border-l4); }
[data-weft-local-connection] .weft-connection-destination summary { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; cursor: pointer; list-style: none; }
[data-weft-local-connection] .weft-connection-destination summary::-webkit-details-marker { display: none; }
[data-weft-local-connection] .weft-connection-site { min-width: 0; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
[data-weft-local-connection] .weft-connection-detail-label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
[data-weft-local-connection] .weft-connection-detail-label::after { content: ''; width: 5px; height: 5px; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(45deg) translateY(-2px); }
[data-weft-local-connection] details[open] .weft-connection-detail-label::after { transform: rotate(225deg) translate(-2px, -1px); }
[data-weft-local-connection] summary:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 4px; border-radius: 4px; }
[data-weft-local-connection] .weft-connection-facts { display: grid; gap: 10px; padding-top: 12px; }
[data-weft-local-connection] .weft-connection-facts > div { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 12px; font-size: 12px; line-height: 18px; }
[data-weft-local-connection] dt { color: var(--dsw-alias-label-tertiary); }
[data-weft-local-connection] dd { overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }
[data-weft-local-connection] .weft-connection-address { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
[data-weft-local-connection] .weft-connection-form { display: grid; gap: 12px; min-width: 0; }
[data-weft-local-connection] .weft-connection-field { display: grid; gap: 6px; min-width: 0; }
[data-weft-local-connection] .weft-connection-field label { font-size: 13px; line-height: 20px; font-weight: 500; }
[data-weft-local-connection] .weft-connection-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
[data-weft-local-connection] .weft-connection-input { box-sizing: border-box; width: 100%; min-width: 0; margin-top: 4px; }
[data-weft-local-connection] .weft-connection-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding-top: 4px; }
[data-weft-local-connection] .weft-connection-secondary { display: flex; flex-wrap: wrap; gap: 8px; }
[data-weft-local-connection] .weft-connection-secondary > button { white-space: nowrap; }
[data-weft-local-connection] .weft-connection-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
[data-weft-local-connection] .weft-connection-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
@media (max-width: 600px) {
  [data-weft-local-connection] { padding: 16px; gap: 16px; }
  [data-weft-local-connection] .weft-connection-actions { align-items: stretch; flex-direction: column; }
  [data-weft-local-connection] .weft-connection-secondary > button { flex: 1; }
  [data-weft-local-connection] .weft-connection-facts > div { grid-template-columns: minmax(0, 1fr); gap: 4px; }
}
`;
