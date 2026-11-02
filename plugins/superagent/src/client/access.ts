/** How the panel reaches the plugin's public routes: under the environment's hook path, with a key it saves through the Host's Settings. */
const PACKAGE = '@weft/dsh-superagent'
export const ENTRY_NAMESPACE = `installed/${PACKAGE}/dsh-superagent`
const FIELD = 'managementKey'
/** A saved key restarts the plugin, whose routes answer again shortly. */
const RESTART_TRIES = 12, RESTART_WAIT_MS = 500

interface KeyForm { commit(key: string): Promise<boolean> }
let form: KeyForm | undefined
export function installAccess(next: KeyForm): () => void { form = next; return () => { form = undefined } }

export function hookBase(base = document.baseURI): string {
  const url = new URL(base)
  const match = /^\/v1\/tenants\/([^/]+)\/environments\/([^/]+)\/native\//.exec(url.pathname)
  if (!match) throw new Error('The Superagent panel requires a Weft environment')
  return `${url.origin}/v1/plugin-hooks/${match[1]}/${match[2]}/${encodeURIComponent(PACKAGE)}`
}
const storageKey = () => `weft-superagent-key:${hookBase()}`
/** Writes a new key; another browser's key stops working, and that browser writes its own on its next request. */
async function rotate(): Promise<string> {
  if (!form) throw new Error('The Host\'s Settings are unavailable')
  const key = crypto.randomUUID() + crypto.randomUUID()
  if (!await form.commit(key)) throw new Error('The management key could not be saved')
  localStorage.setItem(storageKey(), key)
  return key
}
export async function managementFetch(path: string, init: RequestInit): Promise<Response> {
  let key = localStorage.getItem(storageKey()) ?? await rotate()
  let rotated = false
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${hookBase()}/api/${path}`, { ...init, cache: 'no-store', headers: { ...init.headers, authorization: `Bearer ${key}` } })
    if (response.status === 401 && !rotated) { key = await rotate(); rotated = true; continue }
    if (![401, 403, 404, 503].includes(response.status) || attempt >= RESTART_TRIES) return response
    await new Promise(resolve => setTimeout(resolve, RESTART_WAIT_MS))
  }
}
export const KEY_FIELD = FIELD
