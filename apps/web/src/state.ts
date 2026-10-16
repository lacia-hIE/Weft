import type { TenantState } from "../../../packages/control-plane/src/contracts.ts";
import { api } from "./api.ts";
import { BrowserPluginHost } from "./plugin-host.ts";
const emptyState: TenantState = { agents: [], sessions: [], clientPlugins: [] };
export const host = new BrowserPluginHost(async () => {
  await refreshState();
});
const subscribers = new Set<() => void>();
let state = emptyState;
export const getState = (): TenantState => state;
export let pluginErrors: Record<string, string> = {};
export const safeMode = new URL(location.href).searchParams.get("safe") === "1";
export async function refreshState(loadPlugins = true): Promise<void> {
  state = await api<TenantState>("state");
  subscribers.forEach((listener) => {
    listener();
  });
  if (loadPlugins && !safeMode) {
    pluginErrors = await host.reconcile(state.clientPlugins);
    state = { ...state }; // Publish diagnostics with a new external-store snapshot.
    subscribers.forEach((listener) => {
      listener();
    });
  }
}
export const subscribe = (listener: () => void): (() => void) => {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
};
