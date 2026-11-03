// ============================================================
// near-intents-desk — RED TEAM ROUND 15: regression suite
// ============================================================
// Reads that scan (D1 Free: 5M rows read a day), the per-network daily address cap,
// one swap that throws, crashes after a reservation, and stamps that go backwards.
// Every case asserts the SAFE outcome; "BROKE" = a break.   node test/intents-redteam11.mjs
// ============================================================
import crypto from 'crypto'
import * as H from './intents-harness.mjs'
const { S, freshEnv, row, base, call, req } = H
const W = () => H.getWorld(), ENV = () => H.getEnv()
const raw = () => ENV().CLWA_CLUSTERS.raw

let pass = 0, fail = 0
const breaks = []
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  safe   ' + name) }
  else { fail++; breaks.push(name); console.log('  BROKE  ' + name + (extra ? '  — ' + String(extra).slice(0, 400) : '')) }
}
const section = s => console.log('\n[' + s + ']')
const asIp = (ip, body) => call(S.quote.onRequestPost, req('POST', '/api/quote', { body, who: null, headers: { 'cf-connecting-ip': ip } }))
async function realIssue(ip, over = {}) {
  const pv = await asIp(ip, { ...base, ...over, dry: true })
  if (pv.status !== 200) return { pv }
  const body = { ...base, ...over, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut }
  return { pv, body, r: await asIp(ip, body) }
}
/** Wrap the D1 shim: record every SQL text; optionally make a matching statement throw. */
function instrument(onRun) {
  const db = ENV().CLWA_CLUSTERS, orig = db.prepare, seen = new Set()
  db.prepare = sql => {
    seen.add(sql.replace(/\s+/g, ' ').trim())
    const s = orig(sql)
    const wrap = st => ({ ...st, bind: (...a) => wrap(st.bind(...a)), run: async () => { onRun && onRun(sql, st); return st.run() } })
    return wrap(s)
  }
  return { seen, restore: () => { db.prepare = orig } }
}

// ═══════════════════════════════════════════════════════════════════════
section('Y1 no query the desk issues scans a whole swaps, events or payouts table')
await freshEnv()
{
  const rec = instrument()
  // Some volume, of every kind, so the planner has real tables to reason about.
  for (let i = 0; i < 6; i++) await realIssue(`10.96.${i}.1`, { amount: String(20 + i) })
  raw().prepare("UPDATE intents_swaps SET state = 'processing' WHERE rowid % 3 = 0").run()
  raw().prepare("UPDATE intents_swaps SET state = 'expired' WHERE rowid % 3 = 1").run()
  raw().prepare("INSERT INTO intents_payouts (hash, swap_id, at) SELECT 'h' || id, id, 0 FROM intents_swaps").run()
  raw().exec('ANALYZE')
  await H.reconcile()
  await realIssue('10.96.9.1', { amount: '33' })
  rec.restore()
  const bad = []
  for (const sql of rec.seen) {
    if (!/^(SELECT|INSERT INTO intents_swaps|DELETE FROM intents_(swaps|events)|UPDATE intents_swaps)/i.test(sql)) continue
    let plan
    // A statement SQLite cannot even plan (e.g. an INDEXED BY with no solution) fails in production too.
    try { plan = raw().prepare('EXPLAIN QUERY PLAN ' + sql).all().map(x => x.detail) } catch (e) { bad.push(sql.slice(0, 160) + '  →  CANNOT PLAN: ' + e.message); continue }
    // A bare "SCAN <table>" (also under the aliases p / e of the purge's KEEP rule) = every row read.
    const scans = plan.filter(d => /^SCAN (intents_swaps|intents_events|intents_payouts|p|e)\b/.test(d) && !/USING (COVERING )?INDEX/.test(d))
    if (scans.length) bad.push(sql.slice(0, 160) + '  →  ' + plan.join(' | '))
  }
  if (bad.length) console.log(bad.map(b => '      ' + b).join('\n'))
  t(`${rec.seen.size} distinct statements, none reads a whole table`, bad.length === 0, bad.length + ' scanning')
}

// ═══════════════════════════════════════════════════════════════════════
section('Y2 a network gets at most 300 deposit addresses a day')
await freshEnv()
{
  const ip = '203.0.113.50'
  const net = await S.identity.networkBucket(new Request('https://x/', { headers: { 'cf-connecting-ip': ip } }), S.TEST_SECRET)
  await H.Q({ ...base, dry: true })      // tables exist
  // ISSUED addresses (round 16: refused reservations no longer count toward the network cap)
  const ins = raw().prepare(`INSERT INTO intents_swaps (id, idem, member, net, created_at, updated_at, route, from_chain, to_chain, from_asset, to_asset, amount_in, recipient, refund_to, state, deposit_address, usd_in)
    VALUES (?, ?, 'c:other', ?, ?, ?, 'base>sol', 'base', 'sol', 'a', 'b', '1', 'r', 'f', 'expired', ?, 1)`)
  for (let i = 0; i < 300; i++) ins.run(crypto.randomUUID(), crypto.randomUUID(), net, Date.now() - 3600e3, Date.now() - 3600e3, '0x' + crypto.randomBytes(20).toString('hex'))
  const r = await realIssue('203.0.113.77')        // same /24, different client
  // round 16: a cap refusal never says keyFree (another request with this key may be in flight)
  t('the 301st address of the day from one /24 is refused (and not marked keyFree)', r.r?.j?.error === 'network_daily_cap' && !r.r.j.keyFree, JSON.stringify(r.r?.j || r.pv?.j).slice(0, 200))
  const other = await realIssue('198.51.100.7')
  t('another network is unaffected', other.r?.status === 200, JSON.stringify(other.r?.j).slice(0, 120))
  raw().prepare('UPDATE intents_swaps SET created_at = ? WHERE member = ?').run(Date.now() - 25 * 3600e3, 'c:other')
  raw().prepare('DELETE FROM intents_rl').run()
  const later = await realIssue('203.0.113.78')
  t('a day later the network can swap again', later.r?.status === 200, JSON.stringify(later.r?.j).slice(0, 120))
}

// ═══════════════════════════════════════════════════════════════════════
section('Y3 one swap that throws does not end the pass')
await freshEnv()
{
  const ids = []
  for (let i = 0; i < 3; i++) ids.push((await realIssue(`10.97.${i}.1`, { amount: String(20 + i) })).r.j.swap.id)
  raw().prepare('UPDATE intents_swaps SET updated_at = 1 WHERE id = ?').run(ids[0])
  raw().prepare('UPDATE intents_swaps SET updated_at = 2 WHERE id IN (?, ?)').run(ids[1], ids[2])
  const rec = instrument((sql, st) => { if (/^UPDATE intents_swaps SET updated_at = \? WHERE id = \? AND updated_at = \?/.test(sql.trim()) && st && JSON.stringify(st).includes(ids[0])) throw new Error('D1_ERROR: boom') })
  // the shim's statements do not expose their binds; fail the FIRST lease of the pass instead
  rec.restore()
  let first = true
  const rec2 = instrument(sql => { if (first && /^UPDATE intents_swaps SET updated_at = \? WHERE id = \? AND updated_at = \?/.test(sql.trim())) { first = false; throw new Error('D1_ERROR: boom') } })
  const r = (await H.reconcile()).j
  rec2.restore()
  t('the swap whose refresh threw is reported, not fatal', r.results.some(x => x.flags === 'error'), JSON.stringify(r.results))
  t('…and every other swap in the queue was still checked', r.results.filter(x => x.flags !== 'error').length === 2, JSON.stringify(r.results))
}

// ═══════════════════════════════════════════════════════════════════════
section('Y4 a database error while filling is not a "reused address" critical')
await freshEnv()
{
  const pv = await asIp('10.98.0.1', { ...base, dry: true })
  const body = { ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut }
  const rec = instrument(sql => { if (/SET updated_at = \?, state_at = \?, state = 'awaiting_deposit'/.test(sql)) throw new Error('D1_ERROR: Network connection lost') })
  const r = await asIp('10.98.0.1', body)
  rec.restore()
  const rows = raw().prepare('SELECT * FROM intents_swaps').all()
  const crit = raw().prepare("SELECT COUNT(*) AS v FROM intents_events WHERE kind = 'critical'").get().v
  t('the answer is an UNKNOWN outcome (500 internal), not a confident refusal', r.status === 500 && r.j.error === 'internal', r.status + ' ' + JSON.stringify(r.j))
  t('no critical event was logged (it counts toward the 3-a-day desk pause)', crit === 0, crit)
  t('the half-made reservation was abandoned on the way out, not left "reserving"', rows.length === 1 && rows[0].state === 'abandoned' && /internal_error/.test(rows[0].flags), JSON.stringify(rows.map(x => [x.state, x.flags])))
  const retry = await asIp('10.98.0.1', body)
  t('…so the retry is told at once that the key is free (no 2-minute "conflict" loop)', retry.j.error === 'idempotency_conflict' && retry.j.keyFree === true, JSON.stringify(retry.j).slice(0, 160))
}

// ═══════════════════════════════════════════════════════════════════════
section('Y5 bulk updates never wind a version stamp back')
await freshEnv()
{
  const id = (await realIssue('10.99.0.1')).r.j.swap.id
  const future = Date.now() + 60e3        // a lease stamp ahead of this pass's clock
  raw().prepare('UPDATE intents_swaps SET deadline_ms = ?, updated_at = ? WHERE id = ?').run(Date.now() - 2 * 3600e3, future, id)
  await S.io.reconcileBatch(S.envOf(ENV()), ENV().CLWA_CLUSTERS, 0)
  const r = await row(id)
  t('bulk-expire moves the stamp forward from the stored one, never back to "now"', r.state === 'expired' && r.updated_at > future, `${future} → ${r.updated_at} (${r.state})`)
}

// ═══════════════════════════════════════════════════════════════════════
section('Y6 (round 16) caps that hold even when addresses are funded after OUR deadline')
await freshEnv()
{
  // refused reservations do not use the network's daily quota
  const ip = '203.0.113.60'
  const net = await S.identity.networkBucket(new Request('https://x/', { headers: { 'cf-connecting-ip': ip } }), S.TEST_SECRET)
  await H.Q({ ...base, dry: true })
  const ins = raw().prepare(`INSERT INTO intents_swaps (id, idem, member, net, created_at, updated_at, route, from_chain, to_chain, from_asset, to_asset, amount_in, recipient, refund_to, state, flags)
    VALUES (?, ?, 'c:x', ?, ?, ?, 'base>sol', 'base', 'sol', 'a', 'b', '1', 'r', 'f', 'abandoned', '["terms_changed"]')`)
  for (let i = 0; i < 400; i++) ins.run(crypto.randomUUID(), crypto.randomUUID(), net, Date.now() - 600e3, Date.now() - 600e3)
  const r = await realIssue('203.0.113.61')
  t('400 refused reservations from a network do not lock its other users out', r.r?.status === 200, JSON.stringify(r.r?.j).slice(0, 160))
}
await freshEnv()
{
  // dead-to-us addresses still count toward the network's daily USD (1Click keeps them payable for days)
  const ip = '203.0.113.70'
  const net = await S.identity.networkBucket(new Request('https://x/', { headers: { 'cf-connecting-ip': ip } }), S.TEST_SECRET)
  await H.Q({ ...base, dry: true })
  const ins = raw().prepare(`INSERT INTO intents_swaps (id, idem, member, net, created_at, updated_at, route, from_chain, to_chain, from_asset, to_asset, amount_in, recipient, refund_to, state, deposit_address, deadline_ms, usd_in)
    VALUES (?, ?, 'c:y', ?, ?, ?, 'base>sol', 'base', 'sol', 'a', 'b', '1', 'r', 'f', 'expired', ?, ?, 2500)`)
  for (let i = 0; i < 20; i++) ins.run(crypto.randomUUID(), crypto.randomUUID(), net, Date.now() - 3 * 3600e3, Date.now() - 3 * 3600e3, '0x' + crypto.randomBytes(20).toString('hex'), Date.now() - 2 * 3600e3)
  const r = await realIssue('203.0.113.71')
  t('$50,000 of addresses issued today (all dead to us) → the network gets no more today', r.r?.j?.error === 'network_daily_cap', JSON.stringify(r.r?.j).slice(0, 160))
}
await freshEnv()
{
  // one client in a shared network: 40 addresses a day
  const ip = '198.51.100.90'
  const member = await S.identity.clientBucket(new Request('https://x/', { headers: { 'cf-connecting-ip': ip } }), S.TEST_SECRET)
  await H.Q({ ...base, dry: true })
  const ins = raw().prepare(`INSERT INTO intents_swaps (id, idem, member, created_at, updated_at, route, from_chain, to_chain, from_asset, to_asset, amount_in, recipient, refund_to, state, deposit_address, usd_in)
    VALUES (?, ?, ?, ?, ?, 'base>sol', 'base', 'sol', 'a', 'b', '1', 'r', 'f', 'expired', ?, 1)`)
  for (let i = 0; i < 40; i++) ins.run(crypto.randomUUID(), crypto.randomUUID(), member, Date.now() - 3 * 3600e3, Date.now() - 3 * 3600e3, '0x' + crypto.randomBytes(20).toString('hex'))
  const r = await realIssue(ip)
  t('a client that was issued 40 addresses today gets no 41st', r.r?.j?.error === 'member_daily_swaps', JSON.stringify(r.r?.j).slice(0, 160))
}
await freshEnv()
{
  // an expired row is purged only after a check made past 1Click's own deadline
  const id = (await realIssue('10.100.0.1')).r.j.swap.id
  const now = Date.now()
  raw().prepare("UPDATE intents_swaps SET state = 'expired', created_at = ?, upstream_deadline_ms = ?, updated_at = ? WHERE id = ?").run(now - 31 * 86400e3, now - 28 * 86400e3, now - 29 * 86400e3, id)
  await S.io.reconcileBatch(S.envOf(ENV()), ENV().CLWA_CLUSTERS, 0)
  t('31 days old but never checked after 1Click\'s deadline → kept', !!(await row(id)))
  raw().prepare('UPDATE intents_swaps SET updated_at = ? WHERE id = ?').run(now - 3600e3, id)
  await S.io.reconcileBatch(S.envOf(ENV()), ENV().CLWA_CLUSTERS, 0)
  t('…once checked after it → purged', !(await row(id)))
  t('the 1Click deadline is stored when the address is issued', Number.isFinite((await row((await realIssue('10.100.0.2')).r.j.swap.id)).upstream_deadline_ms))
}
await freshEnv()
{
  // housekeeping that throws does not stop the swap checks
  for (let i = 0; i < 2; i++) await realIssue(`10.101.${i}.1`, { amount: String(20 + i) })
  const db = ENV().CLWA_CLUSTERS, orig = db.batch
  db.batch = async () => { throw new Error('D1_ERROR: batch failed') }
  raw().prepare('UPDATE intents_swaps SET updated_at = 0').run()
  const r = await S.io.reconcileBatch(S.envOf(ENV()), db)
  db.batch = orig
  t('a failing purge batch does not stop the pass: the swaps were still checked', r.checked === 2, JSON.stringify(r).slice(0, 160))
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) console.log('BROKE:\n  - ' + breaks.join('\n  - '))
process.exit(fail ? 1 : 0)
