// GET  /api/swap?id=<uuid>   header x-swap-token — one swap, refreshed from 1Click
//                            (and verified on the destination chain when 1Click claims success).
// POST /api/swaps {items:[{id, token}]}  — up to 20 swaps this device holds tokens for,
//                            as stored (no upstream call): the "My swaps" list.
// A wrong token, an unknown id and a half-made reservation all answer exactly
// the same 404, so the API never confirms that an id exists.
import { ensureTables, getSwap, publicSwap } from '../lib/intents-ledger'
import { json, refreshSwap } from '../lib/intents-io'
import { tokenOk } from '../identity'
import { guard, presentedToken, readJson, spendAll, type Handler } from './common'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const notFound = () => json({ ok: false, error: 'not_found' }, 404)

export const swapOne: Handler = async (ctx) => {
  const g = await guard(ctx)
  if (!g.ok) return g.response
  const { db, secret, owner, network } = g
  const id = new URL(ctx.request.url).searchParams.get('id') || ''
  if (!UUID.test(id) || !(await tokenOk(secret, id, presentedToken(ctx.request)))) return notFound()
  await ensureTables(db)
  const row = await getSwap(db, id)
  if (!row || row.state === 'reserving' || row.state === 'abandoned') return notFound()

  // Polling is cheap for us but not for 1Click: one upstream refresh per client per 5 s.
  // Atomic D1 budget (red-team round 3: 30/30 stale refreshes reached 1Click via the KV limiter).
  // Out of budget → the stored row is served; the reconciler keeps it moving regardless.
  const fresh = (await spendAll(ctx.env, db, [['s', owner], ['sn', network], ['sa', '*']])) ? await refreshSwap(ctx.env, db, row, 'client') : row
  return json({ ok: true, swap: publicSwap(fresh) })
}

export const swapList: Handler = async (ctx) => {
  const g = await guard(ctx)
  if (!g.ok) return g.response
  const { db, secret, owner, network } = g
  const rb = await readJson(ctx.request, 4096)
  if (!rb.ok) return json({ ok: false, error: rb.error }, rb.status)
  const b: any = rb.value
  const items = Array.isArray(b?.items) ? b.items.slice(0, 20) : null
  if (!items) return json({ ok: false, error: 'bad_body' }, 400)
  await ensureTables(db)
  if (!(await spendAll(ctx.env, db, [['l', owner], ['ln', network]]))) return json({ ok: false, error: 'rate_limited' }, 429)
  const now = Date.now(), rows = []
  for (const it of items) {
    const id = typeof it?.id === 'string' ? it.id : '', tok = typeof it?.token === 'string' ? it.token.toLowerCase() : ''
    if (!UUID.test(id) || !(await tokenOk(secret, id, tok))) continue
    const row = await getSwap(db, id)
    if (row && row.state !== 'reserving' && row.state !== 'abandoned') rows.push(row)
  }
  // Newest first, sorted here: the public projection carries no creation time.
  rows.sort((a, b) => b.created_at - a.created_at)
  return json({ ok: true, swaps: rows.map(r => publicSwap(r, now)) })
}
