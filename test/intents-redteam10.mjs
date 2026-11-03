// ============================================================
// near-intents-desk — RED TEAM ROUND 14 (round 13, second pass): regression suite
// ============================================================
// The holes the second pass found in round 13's own fixes. Every case asserts the SAFE
// outcome; "BROKE" = a break.   node test/intents-redteam10.mjs
// ============================================================
import crypto from 'crypto'
import fs from 'fs'
import * as H from './intents-harness.mjs'
const { S, freshEnv, row, base, call, req } = H
const W = () => H.getWorld(), ENV = () => H.getEnv()
const raw = () => ENV().CLWA_CLUSTERS.raw

let pass = 0, fail = 0
const breaks = []
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  safe   ' + name) }
  else { fail++; breaks.push(name); console.log('  BROKE  ' + name + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const section = s => console.log('\n[' + s + ']')
const asIp = (ip, body) => call(S.quote.onRequestPost, req('POST', '/api/quote', { body, who: null, headers: { 'cf-connecting-ip': ip } }))
async function realIssue(ip, over = {}, key = crypto.randomUUID()) {
  const pv = await asIp(ip, { ...base, ...over, dry: true })
  if (pv.status !== 200) return { pv }
  const body = { ...base, ...over, dry: false, idempotencyKey: key, acceptedAmountOut: pv.j.terms.amountOut }
  return { pv, body, r: await asIp(ip, body) }
}
const deny = { limit: async () => ({ success: false }) }

// ═══════════════════════════════════════════════════════════════════════
section('Z1 a retry gets its swap back before anything that could refuse it')
for (const [label, setup] of [
  ['the client budget is spent', () => { ENV().RL_A = deny }],
  ['the network budget is spent', () => { ENV().RL_AN = deny }],
  ['the desk-wide budget is spent', () => { ENV().RL_AA = deny }],
  ['the desk was switched off', () => { ENV().INTENTS_ENABLED = '0' }],
  ['the route was paused', () => raw().prepare("INSERT INTO intents_control (key,value,updated_at,actor) VALUES ('pause:route:base>sol','x',0,'t')").run()],
  ['the Solana RPC is down', () => { W().solDown = true; W().cgDown = true }],
]) {
  await freshEnv()
  const first = await realIssue('192.0.2.10')          // its answer is "lost"
  setup()
  const retry = await asIp('192.0.2.10', first.body)
  t(`${label} → the retry still returns THE swap with its key`, retry.status === 200 && retry.j.replay === true && retry.j.swap?.id === first.r.j.swap.id && /^[0-9a-f]{64}$/.test(retry.j.token || ''),
    retry.status + ' ' + JSON.stringify(retry.j).slice(0, 160))
}
{
  await freshEnv()
  const first = await realIssue('192.0.2.11')
  const other = await asIp('192.0.2.11', { ...first.body, amount: '31' })
  t('the same key with a DIFFERENT deal is not a replay', other.j.error === 'idempotency_conflict' && !other.j.keyFree, JSON.stringify(other.j).slice(0, 120))
}

// ═══════════════════════════════════════════════════════════════════════
section('Z2 every refusal says whether the key is free')
await freshEnv()
{
  const pv = await asIp('192.0.2.20', { ...base, dry: true })
  const body = { ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut }
  ENV().RL_A = deny
  const r = await asIp('192.0.2.20', body)
  // Round 15: "no row yet" is NOT "free" — the first press may be between its lookup and its reserve().
  t('a key with no row yet, refused by a budget → NOT keyFree', r.status === 429 && !r.j.keyFree, JSON.stringify(r.j))
  delete ENV().RL_A
  W().quoteMode = '400'
  const r2 = await asIp('192.0.2.20', body)
  t('a key whose reservation was abandoned after the router refused → keyFree', r2.j.error === 'router_rejected' && r2.j.keyFree === true, JSON.stringify(r2.j).slice(0, 160))
  W().quoteMode = 'ok'
  const r3 = await asIp('192.0.2.20', body)
  t('retrying that abandoned key → conflict WITH keyFree (round 15: it looped on "press again")', r3.j.error === 'idempotency_conflict' && r3.j.keyFree === true, JSON.stringify(r3.j).slice(0, 160))
  ENV().RL_A = deny
  const r3b = await asIp('192.0.2.20', body)
  t('…and a budget refusal for that dead key says keyFree too', r3b.status === 429 && r3b.j.keyFree === true, JSON.stringify(r3b.j).slice(0, 160))
  delete ENV().RL_A
  raw().prepare("UPDATE intents_swaps SET state = 'reserving', created_at = ? WHERE idem IS NOT NULL").run(Date.now())
  const r4 = await asIp('192.0.2.20', body)
  t('a key held by a reservation in flight → in_progress, NOT keyFree', r4.j.error === 'in_progress' && !r4.j.keyFree, JSON.stringify(r4.j).slice(0, 160))
  ENV().RL_A = deny
  const r5 = await asIp('192.0.2.20', body)
  t('a key held by a reservation in flight, refused by a budget BEFORE reserve → NOT keyFree (it may still mint)', r5.status === 429 && !r5.j.keyFree, JSON.stringify(r5.j).slice(0, 160))
  delete ENV().RL_A
}

// ═══════════════════════════════════════════════════════════════════════
section('Z3 config and code agree on every budget')
{
  const cfg = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  const rl = Object.fromEntries((cfg.ratelimits || []).map(r => [r.name, r]))
  const mism = []
  for (const [cls, [binding, n]] of Object.entries(S.common.BUDGETS)) {
    if (!rl[binding]) mism.push(`${cls}: ${binding} not in wrangler.jsonc`)
    else if (rl[binding].simple.limit !== n || rl[binding].simple.period !== 60) mism.push(`${cls}: code ${n}/60 vs config ${rl[binding].simple.limit}/${rl[binding].simple.period}`)
  }
  t('every budget class has a binding with the same limit', mism.length === 0, mism.join('; '))
  const ids = (cfg.ratelimits || []).map(r => r.namespace_id)
  t('no two bindings share a namespace (shared counters)', new Set(ids).size === ids.length, ids.join(','))
  t('the whole-API gate is configured', !!rl.RL_API)
  t('desk-wide caps take more than 10 networks to fill', S.common.BUDGETS.aa[1] / S.common.BUDGETS.an[1] >= 10 && S.common.BUDGETS.qa[1] / S.common.BUDGETS.qn[1] >= 10)
}

// ═══════════════════════════════════════════════════════════════════════
section('Z4 dead unpaid addresses stop counting toward the daily cap')
await freshEnv()
{
  const ip = '192.0.2.40'
  for (let i = 0; i < 4; i++) await realIssue(ip, { amount: String(2400 + i) })
  const fifth = await realIssue(ip, { amount: '2410' })
  t('4 × ~$2,400 open → a 5th is refused by the $10,000 daily cap', fifth.r?.j?.error === 'member_daily_cap', JSON.stringify(fifth.r?.j || fifth.pv?.j).slice(0, 140))
  raw().prepare("UPDATE intents_swaps SET deadline_ms = ? WHERE state = 'awaiting_deposit'").run(Date.now() - 1000)
  raw().prepare('DELETE FROM intents_rl').run()
  const again = await realIssue(ip, { amount: '2411' })
  t('once those addresses are dead (not yet marked expired) the client is not locked out', again.r?.status === 200, JSON.stringify(again.r?.j).slice(0, 160))
}

// ═══════════════════════════════════════════════════════════════════════
section('Z5 the purge keeps evidence')
await freshEnv()
{
  const now = Date.now()
  const mk = async (ip, amount) => (await realIssue(ip, { amount })).r.j.swap.id
  const a = await mk('10.90.0.1', '20'), b = await mk('10.90.1.1', '21'), c = await mk('10.90.2.1', '22'), d = await mk('10.90.3.1', '23'), e = await mk('10.90.4.1', '24')
  raw().prepare("UPDATE intents_swaps SET state = 'abandoned', created_at = ? WHERE id IN (?, ?)").run(now - 2 * 86400e3, a, b)
  raw().prepare("INSERT INTO intents_events (at, swap_id, actor, kind, detail) VALUES (?, ?, 'quote', 'critical', '[\"deposit_address_reused\"]')").run(now, a)
  raw().prepare("UPDATE intents_swaps SET state = 'expired', created_at = ?, upstream_deadline_ms = ?, updated_at = ?, flags = '[\"status_recipient_mismatch\"]' WHERE id = ?").run(now - 31 * 86400e3, now - 28 * 86400e3, now - 3600e3, c)
  raw().prepare("UPDATE intents_swaps SET state = 'expired', created_at = ?, upstream_deadline_ms = ?, updated_at = ? WHERE id IN (?, ?)").run(now - 31 * 86400e3, now - 28 * 86400e3, now - 3600e3, d, e)
  raw().prepare("INSERT INTO intents_payouts (hash, swap_id, at) VALUES ('0xpayout', ?, ?)").run(d, now)
  await H.reconcile()
  const ids = new Set(raw().prepare('SELECT id FROM intents_swaps').all().map(x => x.id))
  t('an abandoned reservation with a CRITICAL event is kept', ids.has(a))
  t('an ordinary abandoned one is purged', !ids.has(b))
  t('an expired swap carrying a flag is kept', ids.has(c))
  t('an expired swap that owns a payout tx is kept (and so is its payout row)', ids.has(d) && raw().prepare("SELECT COUNT(*) AS v FROM intents_payouts WHERE hash='0xpayout'").get().v === 1)
  t('an ordinary unpaid expired one is purged', !ids.has(e))
}

// ═══════════════════════════════════════════════════════════════════════
section('Z6 the backlog cannot grow without limit')
await freshEnv()
{
  const ids = []
  for (let i = 0; i < 8; i++) ids.push((await realIssue(`10.91.${i}.1`, { amount: String(20 + i) })).r.j.swap.id)
  raw().prepare("UPDATE intents_swaps SET deadline_ms = ? WHERE state = 'awaiting_deposit'").run(Date.now() - 2 * 3600e3)
  const r = await S.io.reconcileBatch(S.envOf(ENV()), ENV().CLWA_CLUSTERS, 0)     // a pass that visits NO swap
  const states = ids.map(id => raw().prepare('SELECT state FROM intents_swaps WHERE id = ?').get(id).state)
  t('addresses an hour past their deadline are marked expired even when no pass reaches them', states.every(s => s === 'expired'), JSON.stringify(states))
  const plan = raw().prepare(`EXPLAIN QUERY PLAN SELECT * FROM intents_swaps WHERE state = 'awaiting_deposit' ORDER BY updated_at ASC LIMIT 25`).all().map(x => x.detail).join(' | ')
  t('the open-address queue is read through the (state, updated_at) index, not a full scan + sort', /USING INDEX intents_swaps_state/.test(plan) && !/TEMP B-TREE/.test(plan), plan)
}

// ═══════════════════════════════════════════════════════════════════════
section('Z7 one swap cannot overrun the pass budget')
await freshEnv()
{
  const sw = (await realIssue('10.92.0.1')).r.j.swap
  const txs = Array.from({ length: 5 }, (_, i) => ({ hash: '0x' + String(i).repeat(64).slice(0, 64), explorerUrl: 'https://x/' }))
  W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountIn: sw.amountIn, depositedAmount: sw.amountIn, amountOut: sw.amountOut, destinationChainTxHashes: txs } })
  raw().prepare('UPDATE intents_swaps SET updated_at = 0').run()
  const r = await S.io.reconcileBatch(S.envOf(ENV()), ENV().CLWA_CLUSTERS)
  const owned = raw().prepare('SELECT COUNT(*) AS v FROM intents_payouts WHERE swap_id = ?').get(sw.id).v
  t('a feed naming 5 payout txs → at most 3 are recorded and checked', owned <= 3, owned)
  t(`the pass stayed inside its 48-call budget (used ${r.subrequests})`, r.subrequests <= 48, r.subrequests)
}
{
  // k swaps 1Click calls delivered, each naming 3 payout txs, on the smallest budget (48 =
  // per-swap 20 + verification 18 + the 10 calls after it; round 18). Delivered swaps lead the
  // queue (round 19), so it is a LATER one whose verification no longer fits: it must WAIT, not
  // run over the budget, and the wait must not count as a failed attempt.
  const seen = []
  for (let k = 1; k <= 4; k++) {
    await freshEnv({ INTENTS_SUBREQ_BUDGET: '38' })
    const sws = []
    for (let i = 0; i < k; i++) sws.push((await realIssue(`10.92.1.${i + 1}`, { amount: String(20 + i) })).r.j.swap)
    sws.forEach((sw, i) => {
      const txs = [0, 1, 2].map(j => ({ hash: '0x' + String((i * 3 + j) % 10).repeat(64), explorerUrl: 'https://x/' }))
      W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountIn: sw.amountIn, depositedAmount: sw.amountIn, amountOut: sw.amountOut, destinationChainTxHashes: txs } })
    })
    sws.forEach((sw, i) => raw().prepare("UPDATE intents_swaps SET state = 'delivered_claimed', updated_at = ? WHERE id = ?").run(i + 1, sw.id))
    const r = await S.io.reconcileBatch(S.envOf(ENV()), ENV().CLWA_CLUSTERS)
    const rows = await Promise.all(sws.map(sw => row(sw.id)))
    seen.push({ k, used: r.subrequests, waited: rows.filter((x, i) => r.results.some(y => y.id === sws[i].id) && (x.verify_attempts || 0) === 0 && x.dest_verified === null).length })
  }
  t('no pass ran over its 48-call budget, however many payouts were waiting', seen.every(x => x.used <= 48), JSON.stringify(seen))
  t('for some queue, a delivered swap was refreshed but its verification WAITED (attempt not counted)',
    seen.some(x => x.waited > 0), JSON.stringify(seen))
}

// ═══════════════════════════════════════════════════════════════════════
section('Z8 a replay never hands back a dead address')
await freshEnv()
{
  const first = await realIssue('192.0.2.80')
  raw().prepare('UPDATE intents_swaps SET deadline = ?, deadline_ms = ?').run(new Date(Date.now() - 1000).toISOString(), Date.now() - 1000)
  const again = await asIp('192.0.2.80', first.body)
  const txt = JSON.stringify(again.j)
  t('the replay of an expired swap carries no signed quote', again.j.replay === true && again.j.receipt === undefined && again.j.swap?.state === 'expired', txt.slice(0, 200))
  t('…and the deposit address appears nowhere in it', !txt.includes(first.r.j.swap.depositAddress), txt.slice(0, 200))
}

// ═══════════════════════════════════════════════════════════════════════
section('Z9 the late-deposit window reaches the purge')
await freshEnv()
{
  const id = (await realIssue('10.93.0.1')).r.j.swap.id
  raw().prepare("UPDATE intents_swaps SET state = 'expired', created_at = ?, updated_at = ? WHERE id = ?").run(Date.now() - 12 * 86400e3, Date.now() - 7 * 3600e3, id)
  const r = await H.reconcile()
  t('an address that expired 12 days ago is still re-checked (every 6 h) until the 30-day purge', r.j.results.some(x => x.id === id), JSON.stringify(r.j.results.map(x => x.id)))
  raw().prepare('UPDATE intents_swaps SET updated_at = ? WHERE id = ?').run(Date.now() - 3600e3, id)
  t('…but not more often than that', (await H.reconcile()).j.results.every(x => x.id !== id))
}

// ═══════════════════════════════════════════════════════════════════════
section('Z10 an idle poll writes one row, not two')
await freshEnv()
{
  const first = await realIssue('10.94.0.1')
  const db = ENV().CLWA_CLUSTERS
  let writes = 0
  const orig = db.prepare
  db.prepare = sql => { const s = orig(sql); if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql) && !/intents_rl/.test(sql)) { const run = s.bind; return { ...s, bind: (...a) => { const b = run(...a); return { ...b, run: async () => { writes++; return b.run() } } } } } return s }
  raw().prepare('UPDATE intents_swaps SET updated_at = ?').run(Date.now() - 60e3)
  const tok = first.r.j.token
  await S.worker.fetch(new Request('https://d.test/api/swap?id=' + first.r.j.swap.id, { headers: { 'cf-connecting-ip': '10.94.0.1', 'x-swap-token': tok } }), S.envOf(ENV()), { waitUntil() {} })
  db.prepare = orig
  t('a status poll where nothing changed writes exactly one row (the lease)', writes === 1, writes)
}

// ═══════════════════════════════════════════════════════════════════════
section('Z11 old rows get the new columns filled in')
await freshEnv()
{
  const id = (await realIssue('10.95.0.1')).r.j.swap.id
  raw().exec('DROP INDEX IF EXISTS intents_swaps_state_deadline; DROP INDEX IF EXISTS intents_swaps_state_at; ALTER TABLE intents_swaps DROP COLUMN state_at; ALTER TABLE intents_swaps DROP COLUMN deadline_ms')
  S.ledger.__resetLedger()
  await asIp('10.95.0.2', { ...base, dry: true })
  const r = raw().prepare('SELECT * FROM intents_swaps WHERE id = ?').get(id)
  t('deadline_ms is computed from the stored deadline', r.deadline_ms === Date.parse(r.deadline), `${r.deadline_ms} vs ${Date.parse(r.deadline)}`)
  t('state_at falls back to created_at (stuck errs towards a human look)', r.state_at === r.created_at)
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) console.log('BROKE:\n  - ' + breaks.join('\n  - '))
process.exit(fail ? 1 : 0)
