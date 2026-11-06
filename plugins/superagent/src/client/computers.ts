import {hookBase} from './access.ts'

export interface ConnectedComputer {id: string; name: string; ready: boolean; executorId?: string}
const tenantBase = () => {
  const hook = new URL(hookBase())
  return `${hook.origin}/v1/tenants/${hook.pathname.split('/')[3]}`
}
async function json<T>(address: string, init?: RequestInit): Promise<T> {
  const response = await fetch(address, {...init, credentials: 'same-origin', cache: 'no-store'})
  if (response.redirected || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Refresh Weft and sign in again')
  const value = await response.json() as T & {error?: string}
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value
}
const endpoint = (id: string) => `${tenantBase()}/environments/${encodeURIComponent(id)}/local/web/api/weft-executor`
/** Only the current authenticated owner's connected Hosts appear here. Local policy remains on each computer. */
export async function connectedComputers(): Promise<ConnectedComputer[]> {
  const {environments} = await json<{environments: {id: string; name: string; kind?: string; local?: {online: boolean}}[]}>(`${tenantBase()}/environments`)
  return Promise.all(environments.filter(row => row.kind === 'local' && row.local?.online).map(async row => {
    try {
      const state = await json<{ready?: boolean; endpoint?: string}>(endpoint(row.id))
      const prefix = `${hookBase()}/executor/`
      return {id: row.id, name: row.name, ready: state.ready === true,
        ...(state.endpoint?.startsWith(prefix) ? {executorId: state.endpoint.slice(prefix.length)} : {})}
    } catch {return {id: row.id, name: row.name, ready: false}}
  }))
}
export async function attachComputer(id: string, credential: {id: string; protocol: string; pairingKey: string}): Promise<void> {
  await json(endpoint(id), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({action: 'attach',
    code: JSON.stringify({protocol: credential.protocol, endpoint: `${hookBase()}/executor/${credential.id}`, pairingKey: credential.pairingKey})})})
}
/** Resolve through the authenticated owner's environment catalogue; never trust a device-supplied URL. */
export async function localSessionAddress(executorId: string, sessionId: string): Promise<string | undefined> {
  if(!/^[a-f0-9-]{36}$/.test(executorId)||!new RegExp(`^weft-${executorId}-[a-f0-9]{32}$`).test(sessionId))return;
  const computer=(await connectedComputers()).find(row=>row.executorId===executorId);
  if(!computer)return;
  const root=`${tenantBase()}/environments/${encodeURIComponent(computer.id)}/local/web/`;
  const result=await json<{result:{ok:boolean;value?:{items:{sessionId:string}[]}}}>(root+'api/session/list',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'session/list',payload:{args:{_request:{}}}}),
  });
  if(!result.result.ok||!result.result.value?.items.some(row=>row.sessionId===sessionId))return;
  const address=new URL(root);address.searchParams.set('weft-session',sessionId);return address.href;
}
