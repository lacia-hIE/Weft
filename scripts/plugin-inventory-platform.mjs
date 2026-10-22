/** Small, checked adaptations of the pinned Settings component; upstream stays immutable. */
export const pluginInventoryPlatform = {
  name: 'weft-plugin-inventory-platform',
  transform(source, id) {
    const path = id.replaceAll('\\', '/');
    if (path.endsWith('/packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx')) {
      const before = 'const listed = state.packages.filter(pkg => !BUILTIN_PROFILE_BUNDLES.has(pkg.name)';
      const after = "const listed = state.packages.filter(pkg => (!BUILTIN_PROFILE_BUNDLES.has(pkg.name) || pkg.name === '@deepseek-ai/dsh-base' || pkg.name === '@deepseek-ai/dsh-web-app')";
      if (!source.includes(before)) throw new Error('Upstream plugin manager bundle visibility changed');
      return {code: source.replace(before, after), map: null};
    }
    if (path.endsWith('/packages/client/ui-plugin-manager/src/client/locales.ts')) {
      for (const [before, after] of [["rowStateIdle: '未运行'", "rowStateIdle: '未观测实时状态'"], ["rowStateIdle: 'Not running'", "rowStateIdle: 'Live state not observed'"]]) {
        if (!source.includes(before)) throw new Error('Upstream plugin manager status copy changed');
        source = source.replace(before, after);
      }
      return {code: source, map: null};
    }
    const root = '/packages/client/ui-settings-plugin-inventory/src/client/';
    if (!path.includes(root)) return null;
    const file = path.slice(path.indexOf(root) + root.length);
    const edits = file === 'PluginInventorySettingsTab.tsx' ? [
      ['  list: () => Promise<PluginInventorySnapshot>', '  list: () => Promise<PluginInventorySnapshot>\n  subscribe: (listener: () => void) => () => void'],
      ['{ list, presetName, resolveText, t, useClientSync, retryClient }', '{ list, subscribe, presetName, resolveText, t, useClientSync, retryClient }'],
      ['  const normalizedQuery = query.trim().toLocaleLowerCase()', '  useEffect(() => subscribe(() => { setRequest(value => value + 1) }), [subscribe])\n\n  const normalizedQuery = query.trim().toLocaleLowerCase()'],
      ["<p className={css.groupSub}>{t('presetSubtitle')}</p>", "<p className={css.groupSub}>{t('presetSubtitle')} · {selectedRows.length}</p>"],
      ["<p className={css.groupSub}>{t('globalSubtitle')}</p>", "<p className={css.groupSub}>{t('globalSubtitle')} · {globalCount}</p>"],
      ['data-plugin-scope="global"', 'data-plugin-scope="global" data-plugin-count={globalCount}'],
    ] : file === 'index.ts' ? [
      ["  const injected = (): PluginInventorySettingsTabInjected => ({", "  const subscribe = (listener: () => void): (() => void) => {\n    const disposers = [ctx.remote.$on('plugin-manager/changed', listener), ctx.on('connection/reset', listener)]\n    return () => { for (const dispose of disposers) dispose() }\n  }\n  const injected = (): PluginInventorySettingsTabInjected => ({"],
      ['    list, presetName,', '    list, subscribe, presetName,'],
    ] : file === 'locales.ts' ? [
      ["globalSubtitle: '系统与所有会话共用'", "globalSubtitle: '当前部署的插件清单（含按会话加载及未接入条目）'"],
      ["globalSubtitle: 'Shared by the system and every session'", "globalSubtitle: 'Deployment inventory, including session-loaded and unavailable plugins'"],
      ["unobserved: '未运行'", "unobserved: '未观测实时状态'"],
      ["unobserved: 'Not running'", "unobserved: 'Live state not observed'"],
    ] : [];
    if (!edits.length) return null;
    for (const [before, after] of edits) {
      if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error('Upstream plugin inventory changed; review '+file);
      source = source.replace(before, after);
    }
    return {code: source, map: null};
  },
};
