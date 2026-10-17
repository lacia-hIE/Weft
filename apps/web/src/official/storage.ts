/** Native Harness assumes one host per origin. Weft assigns browser state per environment. */
import { DATA_LAYOUT_VERSION } from '../../../../packages/tenant/src/layout.ts';
export function installEnvironmentStorage(tenantId: string, environmentId: string): void {
  const prefix = `weft.${DATA_LAYOUT_VERSION}.${JSON.stringify([tenantId, environmentId])}.`;
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      const original = window[name];
      const keys = () => Array.from({length: original.length}, (_, index) => original.key(index)!).filter(key => key.startsWith(prefix));
      const scoped: Storage = {
        get length() { return keys().length; },
        key: index => keys()[index]?.slice(prefix.length) ?? null,
        getItem: key => original.getItem(prefix + key),
        setItem: (key, value) => original.setItem(prefix + key, value),
        removeItem: key => original.removeItem(prefix + key),
        clear: () => { for (const key of keys()) original.removeItem(key); },
      };
      Object.defineProperty(window, name, {configurable: true, value: scoped});
    } catch {
      // Native stores already treat unavailable browser persistence as optional.
    }
  }
}
