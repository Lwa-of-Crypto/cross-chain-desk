// POST /api/submit {id, txHash}  header x-swap-token — "I sent it, here is my transaction."
// Optional: 1Click finds deposits on its own; telling it the hash only speeds
// that up. The hash is recorded in the ledger's event log either way, so a
// dispute has the user's own claim on file.
import { TX_HASH } from '../lib/intents'
import { ensureTables, getSwap, logEvent, publicSwap } from '../lib/intents-ledger'
import { json, oneClick, refreshSwap } from '../lib/intents-io'
import { tokenOk } from '../identity'
import { guard, presentedToken, readJson, spendAll, type Handler } from './common'

export const submit: Handler = async (ctx) => {
  const g = await guard(ctx)
  if (!g.ok) return g.response
  const { db, secret, owner, network } = g
  const rb = await readJson(ctx.request, 1024)
  if (!rb.ok) return json({ ok: false, error: rb.error }, rb.status)
  const b: any = rb.value
  const id = typeof b?.id === 'string' ? b.id : '', txHash = typeof b?.txHash === 'string' ? b.txHash.trim() : ''
  if (!TX_HASH.test(txHash)) return json({ ok: false, error: 'bad_tx_hash', message: 'That does not look like a transaction hash.' }, 400)
  if (!(await tokenOk(secret, id, presentedToken(ctx.request)))) return json({ ok: false, error: 'not_found' }, 404)

  await ensureTables(db)
  // Atomic D1 budget (red-team round 3: 30/30 parallel submits reached 1Click via the KV limiter).
  if (!(await spendAll(ctx.env, db, [['t', owner], ['tn', network], ['ta', '*']]))) return json({ ok: false, error: 'rate_limited' }, 429)
  const row = await getSwap(db, id)
  if (!row || !row.deposit_address) return json({ ok: false, error: 'not_found' }, 404)
  if (!['awaiting_deposit', 'expired', 'incomplete_deposit'].includes(row.state)) return json({ ok: true, swap: publicSwap(row), note: 'already_seen' })

  const up = await oneClick(ctx.env, '/v0/deposit/submit', { method: 'POST', body: { txHash, depositAddress: row.deposit_address } })
  await logEvent(db, row.id, 'client', 'tx_submitted', { txHash, upstream: up.status })
  const fresh = await refreshSwap(ctx.env, db, row, 'client', Date.now(), true)
  return json({ ok: up.status === 200 || up.status === 201, upstream: up.status, swap: publicSwap(fresh) },
    up.status === 200 || up.status === 201 ? 200 : 502)
}
