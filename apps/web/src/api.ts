export const environmentId = /^\/agents\/([a-zA-Z0-9_-]{1,80})\/?$/.exec(location.pathname)?.[1];
export interface Selection {
  environmentId: string;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  revision: number;
}
let tenantId = "";
let selection: Selection = {
  environmentId: environmentId ?? "default",
  sessionId: "",
  workspaceId: "default",
  agentId: "default",
  revision: 1,
};
const listeners = new Set<() => void>();
export function configureTenant(value: string): void {
  tenantId = value;
}
export const getSelection = (): Selection => selection;
export function select(next: Omit<Selection, "environmentId">): void {
  selection = { ...next, environmentId: environmentId ?? "default" };
  listeners.forEach((fn) => {
    fn();
  });
}
export const subscribeSelection = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export function tenantPath(path: string): string {
  return `/v1/tenants/${tenantId}/${environmentId ? `environments/${environmentId}/` : ""}${path}`;
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (
    path.startsWith("/") ||
    path.includes("://") ||
    path.split(/[/?#]/).includes("..")
  )
    throw new Error("Expected a path relative to the current tenant");
  const response = await fetch(tenantPath(path), {
    ...init,
    credentials: "same-origin",
    headers: {
      ...init?.headers,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (
    response.status === 401 ||
    response.redirected ||
    response.headers.get("content-type")?.includes("text/html")
  )
    throw new Error("登录已过期，请刷新页面重新登录");
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(value.error ?? `请求失败 (${response.status})`);
  return value;
}
export const post = <T>(path: string, value: unknown): Promise<T> =>
  api(path, { method: "POST", body: JSON.stringify(value) });
