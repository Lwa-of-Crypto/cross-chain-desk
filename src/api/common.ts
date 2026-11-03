// Shared plumbing for the API handlers: the context shape and the per-request guard.
import { json, type IntentsEnv } from '../lib/intents-io'
import { take } from '../lib/intents-ledger'
import { deskSecret, clientBucket, networkBucket } from '../identity'

export interface Ctx { request: Request; env: IntentsEnv; waitUntil?: (p: Promise<unknown>) => void }
export type Handler = (ctx: Ctx) => Promise<Response>

/**
 * Every swap endpoint needs the ledger and the secret; without either it refuses
 * (fail closed) instead of running on a guessable key or no ledger.
 */
export async function guard(ctx: Ctx): Promise<{ ok: true; secret: string; owner: string; network: string; db: D1Database } | { ok: false; response: Response }> {
  const secret = deskSecret(ctx.env)
  if (!secret) return { ok: false, response: json({ ok: false, error: 'not_configured', message: 'The desk is not configured (DESK_SECRET). Nothing was issued.' }, 503) }
  const db = ctx.env.DESK_DB
  if (!db) return { ok: false, response: json({ ok: false, error: 'ledger_unavailable', message: 'The swap ledger is not configured, so no swap can be issued.' }, 503) }
  return { ok: true, secret, owner: await clientBucket(ctx.request, secret), network: await networkBucket(ctx.request, secret), db }
}

/**
 * Per-client and per-network budgets (red-team round 13).
 *
 * They used to be D1 counters, and every counted request WROTE rows. D1 Free allows
 * 100,000 rows written per day (developers.cloudflare.com/d1/platform/pricing) and then refuses every query until 00:00 UTC, so one client spending
 * only its own allowance could take the whole desk down by the evening. They now use
 * Cloudflare's rate-limiting binding, which stores nothing (measured on local workerd:
 * exact under 20 concurrent calls). It is per Cloudflare location and approximate, which
 * is fine for a per-client allowance. No binding (tests, a misconfigured deploy) → the
 * same limit is enforced with the D1 counter instead: never no limit.
 *
 * Second pass of round 13: the DESK-WIDE budgets moved to bindings too (key '*'). As D1
 * counters they still wrote a row per request, and one /48 could spend the day's write
 * quota in hours. A desk-wide cap is a lever by nature (enough networks can fill any
 * cap), so the ratio is what matters: it now takes ~15 networks to fill the address
 * cap (was 4) and ~10 the preview cap. Money caps stay atomic in D1 (ledger reserve()).
 * NOTE: a binding counts per Cloudflare LOCATION, so a desk-wide cap is per location too:
 * an attacker spread over N locations gets N times it. Only reserve()'s caps (and the
 * per-network daily address cap there) are global.
 */
export interface Limiter { limit(o: { key: string }): Promise<{ success: boolean }> }
export const BUDGETS = {
  q: ['RL_Q', 40], qn: ['RL_QN', 120], qa: ['RL_QA', 1200],     // previews: client / network / desk
  a: ['RL_A', 6], an: ['RL_AN', 12], aa: ['RL_AA', 180],        // deposit addresses
  s: ['RL_S', 12], sn: ['RL_SN', 12], sa: ['RL_SA', 1200],      // status refreshes (a token works from any IP; each writes D1)
  l: ['RL_L', 30], ln: ['RL_LN', 90],                           // "my swaps" (D1 reads only)
  t: ['RL_T', 6], tn: ['RL_TN', 6], ta: ['RL_TA', 240],         // tx-hash submits (each writes D1)
} as const
/** Every class in order; stops at the first refusal. */
export async function spendAll(env: IntentsEnv, db: D1Database, steps: [keyof typeof BUDGETS, string][]): Promise<boolean> {
  for (const [cls, key] of steps) if (!(await spend(env, db, cls, key))) return false
  return true
}
export async function spend(env: IntentsEnv, db: D1Database, cls: keyof typeof BUDGETS, key: string): Promise<boolean> {
  const [binding, n] = BUDGETS[cls]
  const rl = (env as any)[binding] as Limiter | undefined
  if (rl && typeof rl.limit === 'function') {
    try { return (await rl.limit({ key: cls + ':' + key })).success } catch { /* binding error → strict D1 counter */ }
  }
  return take(db, cls + ':' + key, n, 60)
}

/**
 * The JSON body, read with a BYTE cap (red-team round 13).
 *  · the media type must be exactly application/json ("text/plain; x=application/json"
 *    and "application/jsonx" used to pass a substring test);
 *  · a declared Content-Length over the cap is refused before a byte is read;
 *  · the stream is read only up to the cap and then cancelled, so a chunked body
 *    with no length cannot make the isolate buffer megabytes (128 MB per isolate);
 *  · the cap counts bytes, not UTF-16 units (4-byte characters got 4x through).
 */
export async function readJson(request: Request, max: number): Promise<{ ok: true; value: any } | { ok: false; status: number; error: string }> {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') return { ok: false, status: 415, error: 'json_only' }
  const declared = request.headers.get('content-length')
  if (declared !== null && !(/^\d{1,9}$/.test(declared.trim()) && Number(declared) <= max)) return { ok: false, status: 413, error: 'too_large' }
  const bytes = new Uint8Array(max)
  let n = 0
  if (request.body) {
    const reader = request.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (n + value.byteLength > max) { await reader.cancel().catch(() => {}); return { ok: false, status: 413, error: 'too_large' } }
      bytes.set(value, n); n += value.byteLength
    }
  }
  try { return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes.subarray(0, n))) } }
  catch { return { ok: false, status: 400, error: 'bad_json' } }
}

/** The swap token travels in a header only — never in the URL. */
export const presentedToken = (r: Request) => (r.headers.get('x-swap-token') || '').trim().toLowerCase()
