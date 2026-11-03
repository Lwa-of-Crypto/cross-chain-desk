// /api/admin — operations for the cross-chain swap desk.
// Header `x-admin-token` must equal ADMIN_TOKEN (≥ 32 chars, constant-time).
// No ADMIN_TOKEN configured → this API does not exist (404, same as any unknown path).
// It is a header, not a cookie, so a browser can never send it on its own (no CSRF).
//
// GET                         ledger summary, flagged swaps, recent swaps + events,
//                             pauses, effective limits
// GET  ?id=<uuid>             one swap with its full event trail
// POST {action:'pause',  scope:'global'|'route'|'chain'|'asset', key?, reason}
// POST {action:'resume', scope, key?}
// POST {action:'limits', limits:{...}}      (validated; hard ceilings in intents-risk.ts)
// POST {action:'limits', limits:null}       back to launch limits
// POST {action:'reconcile'}                 run one reconciliation pass now
//
// A pause stops NEW quotes and deposit addresses only. Swaps already issued keep
// being tracked, verified and reconciled — members can always see where their
// money is.
import { CHAINS } from '../lib/intents'
import { LAUNCH_LIMITS, mergeLimits, parseLimits } from '../lib/intents-risk'
import { ensureTables, readControls, setControl, getSwap } from '../lib/intents-ledger'
import { json, enabled, reconcileBatch, cleanEnv, type IntentsEnv } from '../lib/intents-io'
import { ctEq } from '../identity'
import { readJson, type Handler } from './common'

const ROUTE = /^([a-z]+)>([a-z]+)$/
const ASSET = /^(nep141|nep245|1cs_v1):[A-Za-z0-9._:\-]{1,200}$/

/** null = allowed; otherwise the response to send (404 hides the API entirely). */
export function adminDenied(request: Request, env: IntentsEnv): Response | null {
  const want = cleanEnv(env.ADMIN_TOKEN)
  if (want.length < 32) return json({ ok: false, error: 'not_found' }, 404)
  if (!ctEq(cleanEnv(request.headers.get('x-admin-token')), want)) return json({ ok: false, error: 'not_found' }, 404)
  return null
}

export const adminGet: Handler = async ({ request, env }) => {
  const denied = adminDenied(request, env)
  if (denied) return denied
  const db = env.DESK_DB
  if (!db) return json({ ok: false, error: 'DESK_DB not bound' }, 503)
  await ensureTables(db)
  const id = new URL(request.url).searchParams.get('id')
  if (id) {
    const swap = await getSwap(db, id)
    if (!swap) return json({ ok: false, error: 'not_found' }, 404)
    const events = (await db.prepare('SELECT * FROM intents_events WHERE swap_id = ? ORDER BY seq').bind(id).all()).results
    return json({ ok: true, swap, events })
  }
  const now = Date.now(), day = now - 86400e3
  const all = async (sql: string, ...b: unknown[]) => ((await db.prepare(sql).bind(...b).all()).results || [])
  const { controls, limits } = await readControls(db)
  return json({
    ok: true,
    enabled: enabled(env),
    controls,
    limits: { effective: mergeLimits(parseLimits(env.INTENTS_LIMITS), limits), launch: LAUNCH_LIMITS, override: limits },
    byState: await all(`SELECT state, COUNT(*) AS n, ROUND(COALESCE(SUM(usd_in),0),2) AS usd FROM intents_swaps GROUP BY state`),
    last24h: await all(`SELECT route, COUNT(*) AS n, ROUND(COALESCE(SUM(usd_in),0),2) AS usd, ROUND(AVG(cost_bps),1) AS avg_cost_bps
                        FROM intents_swaps WHERE created_at >= ? AND state NOT IN ('reserving','abandoned') GROUP BY route ORDER BY usd DESC`, day),
    flagged: await all(`SELECT id, member, route, state, flags, dest_verified, updated_at FROM intents_swaps
                        WHERE flags IS NOT NULL AND flags <> '[]' ORDER BY updated_at DESC LIMIT 50`),
    recent: await all(`SELECT id, member, route, state, usd_in, cost_bps, platform_fee_bps, dest_verified, created_at, updated_at
                       FROM intents_swaps ORDER BY created_at DESC LIMIT 50`),
    events: await all(`SELECT * FROM intents_events ORDER BY seq DESC LIMIT 80`),
  })
}

export const adminPost: Handler = async ({ request, env }) => {
  const denied = adminDenied(request, env)
  if (denied) return denied
  const db = env.DESK_DB
  if (!db) return json({ ok: false, error: 'DESK_DB not bound' }, 503)
  const rb = await readJson(request, 4096)
  if (!rb.ok) return json({ ok: false, error: rb.error }, rb.status)
  const b: any = rb.value
  await ensureTables(db)
  const actor = 'admin'
  const action = String(b?.action || '')

  if (action === 'pause' || action === 'resume') {
    const scope = String(b?.scope || '')
    const k = String(b?.key || '')
    let key: string
    if (scope === 'global') key = 'pause:global'
    else if (scope === 'route') {
      const m = ROUTE.exec(k)
      if (!m || !CHAINS[m[1]] || !CHAINS[m[2]]) return json({ ok: false, error: 'route must look like base>sol, both chains allowlisted' }, 400)
      key = 'pause:route:' + k
    } else if (scope === 'chain') {
      if (!CHAINS[k]) return json({ ok: false, error: 'unknown chain', chains: Object.keys(CHAINS) }, 400)
      key = 'pause:chain:' + k
    } else if (scope === 'asset') {
      if (!ASSET.test(k)) return json({ ok: false, error: 'asset must be a 1Click assetId' }, 400)
      key = 'pause:asset:' + k
    } else return json({ ok: false, error: 'scope must be global, route, chain or asset' }, 400)
    if (action === 'pause') {
      const reason = String(b?.reason || '').trim().slice(0, 200)
      if (!reason) return json({ ok: false, error: 'a reason is required to pause' }, 400)
      await setControl(db, key, `${reason} (by ${actor})`, actor)
    } else await setControl(db, key, null, actor)
    return json({ ok: true, action, key, controls: (await readControls(db)).controls })
  }

  if (action === 'limits') {
    if (b?.limits === null) { await setControl(db, 'limits', null, actor); return json({ ok: true, limits: mergeLimits(parseLimits(env.INTENTS_LIMITS)) }) }
    if (!b?.limits || typeof b.limits !== 'object') return json({ ok: false, error: 'limits object required' }, 400)
    const known = Object.keys(LAUNCH_LIMITS)
    const clean: Record<string, number> = {}
    for (const [k, v] of Object.entries(b.limits)) if (known.includes(k)) clean[k] = Number(v)
    const merged = mergeLimits(parseLimits(env.INTENTS_LIMITS), clean)
    const rejected = Object.keys(clean).filter(k => (merged as any)[k] !== clean[k])
    if (rejected.length) return json({ ok: false, error: 'out of range (see hard ceilings in lib/intents-risk.ts)', rejected }, 400)
    await setControl(db, 'limits', JSON.stringify(clean), actor)
    return json({ ok: true, limits: merged })
  }

  // Close out a swap 1Click calls delivered that can never be verified (round 21): only from
  // delivered_claimed, with a reason, logged. It becomes 'settled' with dest_verified 'manual',
  // so the member sees a human decided, and it leaves the reconciler's queue.
  // outcome 'paid' (payout seen by hand) → settled; 'not_paid' (round 22: a false SUCCESS) → failed,
  // so the member is told to contact support instead of seeing "Done". Update and record in one batch.
  if (action === 'resolve') {
    const id = String(b?.id || ''), note = String(b?.note || '').slice(0, 300), outcome = String(b?.outcome || '')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) || note.length < 8 || (outcome !== 'paid' && outcome !== 'not_paid'))
      return json({ ok: false, error: "id, outcome ('paid' or 'not_paid') and a note (8+ characters) required" }, 400)
    const now = Date.now()
    const [r] = await db.batch([
      db.prepare(`UPDATE intents_swaps SET state = ?, dest_verified = 'manual', state_at = ?, updated_at = MAX(updated_at + 1, ?)
          WHERE id = ? AND state = 'delivered_claimed'`).bind(outcome === 'paid' ? 'settled' : 'failed', now, now, id),
      db.prepare(`INSERT INTO intents_events (at, swap_id, actor, kind, detail) SELECT ?, ?, ?, 'resolved', ?
          WHERE changes() = 1`).bind(now, id, actor, JSON.stringify({ outcome, note })),
    ])
    if ((r?.meta as any)?.changes !== 1) return json({ ok: false, error: 'not a delivered_claimed swap' }, 409)
    return json({ ok: true, state: outcome === 'paid' ? 'settled' : 'failed' })
  }
  // ensureTables above may have made up to ~12 calls on a cold isolate (round 19): counted.
  if (action === 'reconcile') return json({ ok: true, ...(await reconcileBatch(env, db, 25, Date.now(), 12)) })
  return json({ ok: false, error: 'unknown action' }, 400)
}
