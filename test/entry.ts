// Bundle entry for the Node suites: the REAL libs, and the REAL router (worker.fetch).
//
// The suites were written against the old members-only Pages Functions
// (S.quote.onRequestPost(ctx) with a clwa_session cookie). Rather than fork
// 1,000 assertions, this file adapts those calls onto the standalone desk:
//   · every call goes through worker.fetch — the router, cross-site check,
//     method table and headers are exercised, not bypassed;
//   · a test "member" becomes a client IP (CF-Connecting-IP), derived from the
//     cookie's subject; no cookie → one fixed anonymous IP;
//   · swap tokens are kept per client IP, exactly as each browser would keep its
//     own, and presented only by the client that received them.
// Nothing here weakens a check: a client without the token gets the real 404.
import worker from '../src/worker'
export * as risk from '../src/lib/intents-risk'
export * as ledger from '../src/lib/intents-ledger'
export * as verify from '../src/lib/intents-verify'
export * as io from '../src/lib/intents-io'
export * as lib from '../src/lib/intents'
export * as identity from '../src/identity'
export * as common from '../src/api/common'
export * as proof from '../src/lib/intents-proof'
import { reconcileBatch } from '../src/lib/intents-io'
import { ensureTables } from '../src/lib/intents-ledger'
export { worker }

export const TEST_SECRET = 'test-desk-secret-0123456789abcdef0123456789'
export const TEST_ADMIN = 'test-admin-token-0123456789abcdef0123456789'

const jar = new Map<string, Map<string, string>>()      // ip → (swap id → token)
export function __resetJar() { jar.clear() }
export const jarFor = (ip: string) => { if (!jar.has(ip)) jar.set(ip, new Map()); return jar.get(ip)! }

/** A cookie's JWT subject → a stable test IP. Unsigned read: the desk has no sessions. */
export function ipOf(request: Request): string {
  const explicit = request.headers.get('cf-connecting-ip')
  if (explicit) return explicit
  const m = /clwa_session=([^;]+)/.exec(request.headers.get('cookie') || '')
  if (!m) return '192.0.2.250'
  let sub = 'x'
  try { sub = JSON.parse(atob(m[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub || 'x' } catch { /* malformed → its own bucket */ }
  let h = 0
  for (const c of String(sub)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `10.${(h >>> 16) & 255}.${(h >>> 8) & 255}.${h & 255}`
}

export function envOf(env: any) {
  return {
    ...env,
    DESK_DB: 'DESK_DB' in env ? env.DESK_DB : env.CLWA_CLUSTERS,
    DESK_SECRET: 'DESK_SECRET' in env ? env.DESK_SECRET : TEST_SECRET,
    ADMIN_TOKEN: 'ADMIN_TOKEN' in env ? env.ADMIN_TOKEN : TEST_ADMIN,
    ASSETS: { fetch: async () => new Response('<!doctype html>page', { headers: { 'content-type': 'text/html' } }) },
  }
}

const execCtx = { waitUntil() {}, passThroughOnException() {} } as any

/** Send `request` to the desk at `path` (+ query), as client `ip`, through the real router. */
export async function viaRouter(request: Request, env: any, path: string, opts: { ip?: string; token?: string; body?: string; method?: string } = {}) {
  const u = new URL(request.url)
  const target = new URL(path, u.origin)
  const headers = new Headers(request.headers)
  const ip = opts.ip || ipOf(request)
  headers.set('cf-connecting-ip', ip)
  headers.delete('cookie')
  if (opts.token && !headers.has('x-swap-token')) headers.set('x-swap-token', opts.token)
  const method = opts.method || request.method
  const body = opts.body !== undefined ? opts.body : (method === 'GET' || method === 'HEAD' ? undefined : await request.text())
  const res = await worker.fetch(new Request(target, { method, headers, body }), envOf(env), execCtx)
  // Keep any token this client was handed (issue or idempotent replay).
  const copy = res.clone()
  try {
    const j: any = await copy.json()
    if (j && j.token && j.swap && j.swap.id) jarFor(ip).set(j.swap.id, j.token)
  } catch { /* not JSON */ }
  return res
}

const ctxShim = (fn: (c: any) => Promise<Response>) => fn
export const quote = { onRequestPost: ctxShim(async ({ request, env }) => viaRouter(request, env, '/api/quote')) }
export const tokens = { onRequestGet: ctxShim(async ({ request, env }) => viaRouter(request, env, '/api/tokens')) }
export const submit = {
  onRequestPost: ctxShim(async ({ request, env }) => {
    const raw = await request.clone().text()
    let id = ''
    try { id = String(JSON.parse(raw)?.id || '') } catch { /* bad body: the router decides */ }
    return viaRouter(request, env, '/api/submit', { token: jarFor(ipOf(request)).get(id), body: raw })
  }),
}
export const swaps = {
  onRequestGet: ctxShim(async ({ request, env }) => {
    const id = new URL(request.url).searchParams.get('id')
    const ip = ipOf(request)
    if (id !== null) return viaRouter(request, env, '/api/swap?id=' + encodeURIComponent(id), { token: jarFor(ip).get(id) })
    const items = Array.from(jarFor(ip).entries()).map(([i, token]) => ({ id: i, token }))
    const h = new Headers(request.headers); h.set('content-type', 'application/json')
    return viaRouter(new Request(request.url, { method: 'POST', headers: h }), env, '/api/swaps', { method: 'POST', body: JSON.stringify({ items }) })
  }),
}
// Proof of delivery (round 27): the proof is fetched with the swap token this client holds.
export const proofApi = {
  get: ctxShim(async ({ request, env }) => {
    const id = new URL(request.url).searchParams.get('id') || ''
    return viaRouter(request, env, '/api/proof?id=' + encodeURIComponent(id), { token: jarFor(ipOf(request)).get(id) })
  }),
  verify: ctxShim(async ({ request, env }) => viaRouter(request, env, '/api/proof/verify')),
  key: ctxShim(async ({ request, env }) => viaRouter(request, env, '/api/proof/key')),
}
export const admin = {
  onRequestGet: ctxShim(async ({ request, env }) => {
    const h = new Headers(request.headers); if (!h.has('x-admin-token')) h.set('x-admin-token', envOf(env).ADMIN_TOKEN || '')
    return viaRouter(new Request(request.url, { method: 'GET', headers: h }), env, '/api/admin' + new URL(request.url).search)
  }),
  onRequestPost: ctxShim(async ({ request, env }) => {
    const h = new Headers(request.headers); if (!h.has('x-admin-token')) h.set('x-admin-token', envOf(env).ADMIN_TOKEN || '')
    return viaRouter(new Request(request.url, { method: 'POST', headers: h, body: await request.text() }), env, '/api/admin')
  }),
}
/**
 * The reconciler has NO HTTP door on the standalone desk: it runs from the cron
 * trigger. Suites that drove it over HTTP now drive the same function the
 * scheduled() handler runs. (The old REFRESH_KEY checks are replaced by a test
 * that no reconcile route exists.)
 */
export const reconcile = {
  onRequest: ctxShim(async ({ env }) => {
    const e = envOf(env)
    if (!e.DESK_DB) return new Response(JSON.stringify({ ok: false, error: 'ledger_unavailable' }), { status: 503 })
    await ensureTables(e.DESK_DB)
    return new Response(JSON.stringify({ ok: true, ...(await reconcileBatch(e, e.DESK_DB)) }), { status: 200, headers: { 'content-type': 'application/json' } })
  }),
}
