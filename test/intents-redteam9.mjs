// ============================================================
// near-intents-desk — RED TEAM ROUND 13 (machine level): regression suite
// ============================================================
// Every hole found in round 13, each pinned by an attack that broke the old code.
// Every case asserts the SAFE outcome; "BROKE" = a break.   node test/intents-redteam9.mjs
// ============================================================
import crypto from 'crypto'
import * as H from './intents-harness.mjs'
const { S, Q, issue, swapGet, freshEnv, row, base, call, req } = H
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
const rlCount = k => { try { return Number(raw().prepare('SELECT COALESCE(SUM(n),0) AS v FROM intents_rl WHERE k = ?').get(k).v) } catch { return 0 } }   // no table = nothing was ever counted
const realIssue = async (ip, over = {}) => {
  const pv = await asIp(ip, { ...base, ...over, dry: true })
  if (pv.status !== 200) return { pv }
  return { pv, r: await asIp(ip, { ...base, ...over, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut }) }
}

// ═══════════════════════════════════════════════════════════════════════
section('R1 junk requests cannot spend the desk-wide budgets')
await freshEnv()
{
  // 20 networks × 6 junk "get address" requests a minute used to fill a:* (60) and lock everyone out.
  for (let n = 0; n < 20; n++) for (let i = 0; i < 6; i++) await asIp(`203.0.${n}.7`, { dry: false })
  for (let n = 0; n < 20; n++) for (let i = 0; i < 40; i++) await asIp(`198.18.${n}.7`, {})
  t('120 invalid issue requests spent none of the desk-wide address budget', rlCount('aa:*') === 0, rlCount('aa:*'))
  t('800 invalid previews spent none of the desk-wide preview budget', rlCount('qa:*') === 0, rlCount('qa:*'))
  const r = await realIssue('192.0.2.77')
  t('a real user still gets a deposit address afterwards', r.r?.status === 200 && !!r.r.j.swap?.depositAddress, JSON.stringify(r.r?.j || r.pv?.j).slice(0, 200))
  t('invalid idempotency key is refused before any budget', (await asIp('192.0.2.78', { ...base, dry: false, idempotencyKey: 'x', acceptedAmountOut: '1' })).j.error === 'bad_idempotency_key' && rlCount('aa:*') === 1)
}

// ═══════════════════════════════════════════════════════════════════════
section('R2 one IPv6 /48 is one network: rotating /64s does not multiply its allowance')
await freshEnv()
{
  let issued = 0, limited = 0
  for (let i = 0; i < 30; i++) {
    const ip = `2001:db8:77:${(i + 1).toString(16)}::1`
    const r = await realIssue(ip, { amount: String(20 + i) })
    if (r.r?.status === 200) issued++
    else if (r.r?.status === 429 || r.pv?.status === 429) limited++
  }
  t('30 /64s inside one /48 get at most 18 addresses a minute (the network allowance)', issued <= 18 && limited > 0, JSON.stringify({ issued, limited }))
  const other = await realIssue('2001:db8:78:1::1')
  t('a different /48 is unaffected', other.r?.status === 200, other.r?.status + ' ' + JSON.stringify(other.r?.j || other.pv?.j).slice(0, 150))
  t('IPv4 /24 is a network too', S.identity.networkPrefix('203.0.113.9') === '203.0.113.0/24' && S.identity.networkPrefix('2001:db8:77:5::1') === '2001:0db8:0077::/48')
  t('IPv4-mapped IPv6 is that IPv4 network', S.identity.networkPrefix('::ffff:203.0.113.9') === '203.0.113.0/24')
}

// ═══════════════════════════════════════════════════════════════════════
section('R3 rate-limit binding: per-client budgets cost no D1 writes when it is bound')
{
  const calls = []
  const deny = { limit: async o => { calls.push(o.key); return { success: false } } }
  const allow = { limit: async o => { calls.push(o.key); return { success: true } } }
  await freshEnv({ RL_Q: deny })
  const r = await asIp('192.0.2.90', { ...base, dry: true })
  t('a binding that says no → 429', r.status === 429, r.status)
  t('…and the refusal wrote nothing to D1', Number(raw().prepare('SELECT COUNT(*) AS v FROM intents_rl').get().v) === 0)
  await freshEnv({ RL_Q: allow, RL_QN: allow })
  await asIp('192.0.2.91', { ...base, dry: true })
  const keys = raw().prepare('SELECT k FROM intents_rl').all().map(x => x.k)
  t('with the binding allowing, only the desk-wide counter is written', keys.length === 1 && keys[0] === 'qa:*', JSON.stringify(keys))
  t('binding keys are hashed buckets, never an IP', calls.every(k => /^(q|qn):(c|n):[0-9a-f]{32}$/.test(k)), JSON.stringify(calls))
  const boom = { limit: async () => { throw new Error('binding down') } }
  await freshEnv({ RL_Q: boom })
  let okN = 0
  for (let i = 0; i < 45; i++) if ((await asIp('192.0.2.92', { ...base, dry: true })).status === 200) okN++
  t('a binding that throws falls back to the strict D1 limit (40), never to no limit', okN === 40, okN)
  // the whole-API gate
  await freshEnv({ RL_API: deny })
  const tk = await call(S.tokens.onRequestGet, req('GET', '/api/tokens', { who: null }))
  t('the network gate refuses even the public token list', tk.status === 429, tk.status)
}

// ═══════════════════════════════════════════════════════════════════════
section('R4 the reconciler queue: money first, finished swaps age out')
await freshEnv()
{
  const now = Date.now()
  // 30 unpaid open addresses, all touched long ago, and one PAID swap touched most recently.
  const unpaid = []
  for (let i = 0; i < 30; i++) { const r = await realIssue(`10.40.${i}.1`, { amount: String(20 + (i % 9)) }); if (r.r?.j?.swap) unpaid.push(r.r.j.swap.id) }
  const paid = (await realIssue('10.41.0.1')).r.j.swap
  raw().prepare("UPDATE intents_swaps SET updated_at = ? WHERE state = 'awaiting_deposit'").run(now - 3600e3)
  raw().prepare("UPDATE intents_swaps SET state = 'processing', state_at = ?, updated_at = ? WHERE id = ?").run(now, now - 60e3, paid.id)
  W().status.set(paid.depositAddress, { status: 'PROCESSING', updatedAt: 'x', swapDetails: { depositedAmount: paid.amountIn } })
  const rc = (await H.reconcile()).j
  t(`${unpaid.length} unpaid addresses do not push the paid swap out of the pass`, rc.results[0]?.id === paid.id, JSON.stringify(rc.results.map(x => x.from)))

  // a refunded swap that is visited every pass must still leave the queue 24 h after it was refunded
  const old = unpaid[0]
  raw().prepare("UPDATE intents_swaps SET state = 'refunded', refunded = '1', state_at = ?, updated_at = ? WHERE id = ?").run(now - 25 * 3600e3, now - 11 * 60e3, old)
  const rc2 = (await H.reconcile()).j
  t('a swap refunded 25 h ago is not re-checked, however recently it was touched', rc2.results.every(x => x.id !== old))
  raw().prepare('UPDATE intents_swaps SET state_at = ? WHERE id = ?').run(now - 3600e3, old)
  const seen = []
  seen.push(...(await H.reconcile()).j.results.map(x => x.id))
  t('…one refunded an hour ago still is, in the very next pass, with 29 open addresses queued', seen.includes(old), JSON.stringify(seen.length))
}

// ═══════════════════════════════════════════════════════════════════════
section('R5 "stuck" measures time in the state, not since the last poll')
{
  const F = (r) => S.ledger.reconcileFlags({ state: 'processing', from_chain: 'base', updated_at: Date.now(), min_amount_out: '0', amount_out_actual: null, refunded: null, dest_txs: null, dest_verified: null, verify_attempts: 0, ...r }, Date.now(), null)
  t('processing for 2 h, polled a second ago → stuck', F({ state_at: Date.now() - 2 * 3600e3 }).includes('stuck'))
  t('processing for 5 min → not stuck', !F({ state_at: Date.now() - 5 * 60e3 }).includes('stuck'))
  await freshEnv()
  const sw = (await issue()).r.j.swap
  const now = Date.now()
  raw().prepare("UPDATE intents_swaps SET state = 'processing', state_at = ?, updated_at = ? WHERE id = ?").run(now - 2 * 3600e3, now - 60e3, sw.id)
  W().status.set(sw.depositAddress, { status: 'PROCESSING', updatedAt: 'x', swapDetails: {} })
  await H.reconcile()
  t('a swap processing for 2 h is flagged stuck by the real reconciler', JSON.parse((await row(sw.id)).flags || '[]').includes('stuck'), (await row(sw.id)).flags)
  const sw2 = (await issue({ amount: '31' })).r.j.swap
  raw().prepare("UPDATE intents_swaps SET state = 'deposit_seen', state_at = ?, updated_at = ? WHERE id = ?").run(now - 2 * 3600e3, now - 60e3, sw2.id)
  W().status.set(sw2.depositAddress, { status: 'PROCESSING', updatedAt: 'x', swapDetails: {} })
  await H.reconcile()
  const r2 = await row(sw2.id)
  t('a swap that JUST moved to processing is not called stuck for its time in the old state', r2.state === 'processing' && !JSON.parse(r2.flags || '[]').includes('stuck'), r2.state + ' ' + r2.flags)
  t('…and its state clock restarted', r2.state_at >= now - 5000, r2.state_at)
}

// ═══════════════════════════════════════════════════════════════════════
section('R6 version stamps only move forward')
await freshEnv()
{
  const sw = (await issue()).r.j.swap
  const r0 = await row(sw.id)
  const stale = { ...r0 }
  W().status.set(sw.depositAddress, { status: 'PROCESSING', updatedAt: 'x', swapDetails: { depositedAmount: sw.amountIn } })
  const after = await S.io.refreshSwap(ENV(), ENV().CLWA_CLUSTERS, r0, 'reconciler', r0.updated_at, true)
  const r1 = await row(sw.id)
  t('a commit in the same millisecond as the read still writes a NEWER stamp', r1.updated_at > r0.updated_at, `${r0.updated_at} → ${r1.updated_at}`)
  t('the returned row carries the stamp the database holds', after.updated_at === r1.updated_at, `${after.updated_at} vs ${r1.updated_at}`)
  const landed = await S.ledger.applyObservation(ENV().CLWA_CLUSTERS, stale, { flags: '[]' }, 'client', r0.updated_at)
  t('a writer holding the pre-commit copy cannot overwrite the newer row', landed === false && (await row(sw.id)).state === 'processing')
}

// ═══════════════════════════════════════════════════════════════════════
section('R7 the reconciler counts only its own subrequests')
await freshEnv()
{
  for (let i = 0; i < 6; i++) await realIssue(`10.50.${i}.1`, { amount: String(20 + i) })
  raw().prepare("UPDATE intents_swaps SET updated_at = 0").run()
  const alone = (await H.reconcile()).j.checked
  await freshEnv()
  for (let i = 0; i < 6; i++) await realIssue(`10.50.${i}.1`, { amount: String(20 + i) })
  raw().prepare("UPDATE intents_swaps SET updated_at = 0").run()
  W().statusDelay = 20
  // 40 previews from other clients run DURING the pass, each making outbound calls in the same isolate
  const busy = Promise.all(Array.from({ length: 40 }, (_, i) => asIp(`10.60.${i}.1`, { ...base, amount: String(20 + (i % 9)), dry: true })))
  const crowded = (await H.reconcile()).j.checked
  await busy; W().statusDelay = 0
  t('concurrent requests in the isolate do not shrink a pass', crowded === alone, `alone ${alone}, crowded ${crowded}`)
}

// ═══════════════════════════════════════════════════════════════════════
section('R8 a dead address no longer holds an open-swap slot')
await freshEnv()
{
  const ip = '192.0.2.120'
  for (let i = 0; i < 5; i++) await realIssue(ip, { amount: String(20 + i) })
  const sixth = await realIssue(ip, { amount: '26' })
  t('5 open addresses → the 6th is refused', sixth.r?.j?.error === 'too_many_open_swaps', JSON.stringify(sixth.r?.j).slice(0, 120))
  raw().prepare("UPDATE intents_swaps SET deadline_ms = ?, created_at = ? WHERE state = 'awaiting_deposit'").run(Date.now() - 1000, Date.now() - 120e3)
  raw().prepare("DELETE FROM intents_rl").run()   // a minute later: the per-client 6/min allowance is back
  const again = await realIssue(ip, { amount: '27' })
  t('once their deadlines pass (not yet marked expired) the client can swap again', again.r?.status === 200, JSON.stringify(again.r?.j).slice(0, 160))
}

// ═══════════════════════════════════════════════════════════════════════
section('R9 retention: the ledger does not grow forever')
await freshEnv()
{
  const now = Date.now()
  const mk = async (ip, amount) => (await realIssue(ip, { amount })).r.j.swap.id
  const a = await mk('10.70.0.1', '20'), b = await mk('10.70.1.1', '21'), c = await mk('10.70.2.1', '22'), d = await mk('10.70.3.1', '23')
  raw().prepare("UPDATE intents_swaps SET state = 'abandoned', created_at = ? WHERE id = ?").run(now - 2 * 86400e3, a)
  raw().prepare("UPDATE intents_swaps SET state = 'abandoned', created_at = ? WHERE id = ?").run(now - 3600e3, b)
  // round 16: last checked AFTER 1Click's own deadline for the address (3 days in)
  raw().prepare("UPDATE intents_swaps SET state = 'expired', created_at = ?, upstream_deadline_ms = ?, updated_at = ?, deposited = NULL, origin_txs = NULL WHERE id = ?").run(now - 31 * 86400e3, now - 28 * 86400e3, now - 3600e3, c)
  raw().prepare("UPDATE intents_swaps SET state = 'expired', created_at = ?, deposited = '5' WHERE id = ?").run(now - 31 * 86400e3, d)
  await H.reconcile()
  const ids = new Set(raw().prepare('SELECT id FROM intents_swaps').all().map(x => x.id))
  t('a 2-day-old abandoned reservation is deleted', !ids.has(a))
  t('…with its events', Number(raw().prepare('SELECT COUNT(*) AS v FROM intents_events WHERE swap_id = ?').get(a).v) === 0)
  t('a 1-hour-old abandoned one is kept (the idempotency window)', ids.has(b))
  t('an unpaid address expired 31 days ago is deleted', !ids.has(c))
  t('a swap that received money is kept, however old', ids.has(d))
}

// ═══════════════════════════════════════════════════════════════════════
section('R10 request bodies: bytes, not characters; the declared length first')
await freshEnv()
{
  const send = (body, headers = {}) => S.worker.fetch(new Request('https://desk.test/api/quote', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.130', ...headers }, body, duplex: 'half' }), S.envOf(ENV()), { waitUntil() {} })
  // a stream that sends 64 KB and then never ends
  let pulled = 0
  const endless = new ReadableStream({ pull(c) { if (pulled++ < 1) c.enqueue(new Uint8Array(65536)); else return new Promise(() => {}) } })
  const r = await Promise.race([send(endless).then(x => x.status), new Promise(res => setTimeout(() => res('hung'), 3000))])
  t('a body that never ends is cut off at the cap, not waited for', r === 413, r)
  const big = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close() } })
  const r2 = await send(big, { 'content-length': String(90 * 1024 * 1024) })
  t('a declared 90 MB Content-Length is refused before reading', r2.status === 413, r2.status)
  const emoji = JSON.stringify({ ...base, dry: true, from: '\u{1F600}'.repeat(1100) })
  t(`a ${Buffer.byteLength(emoji)}-byte body of 4-byte characters is over the 4 KB cap`, (await send(emoji)).status === 413)
  for (const ct of ['text/plain; x=application/json', 'application/jsonx', 'application/json-patch+json'])
    t(`content-type "${ct}" → 415`, (await send(JSON.stringify({ ...base, dry: true }), { 'content-type': ct })).status === 415)
  t('content-type "application/json; charset=utf-8" still works', (await send(JSON.stringify({ ...base, dry: true }), { 'content-type': 'Application/JSON; charset=utf-8' })).status === 200)
}

// ═══════════════════════════════════════════════════════════════════════
section('R11 a replay hands back the signed quote too')
await freshEnv()
{
  const pv = await Q({ ...base, dry: true })
  const key = crypto.randomUUID()
  const b = { ...base, dry: false, idempotencyKey: key, acceptedAmountOut: pv.j.terms.amountOut }
  const first = await Q(b)
  const again = await Q(b)
  t('the replay carries the same swap and key as the first answer, and no raw dated quote', again.j.replay === true && again.j.swap?.id === first.j.swap?.id && again.j.token === first.j.token
    && again.j.receipt === undefined && first.j.receipt === undefined)
}

// ═══════════════════════════════════════════════════════════════════════
section('R12 a ledger created by an older version is upgraded, not broken')
await freshEnv()
{
  await Q({ ...base, dry: true })                       // creates today's schema
  raw().exec('DROP INDEX IF EXISTS intents_swaps_state_deadline; DROP INDEX IF EXISTS intents_swaps_state_at; ALTER TABLE intents_swaps DROP COLUMN state_at; ALTER TABLE intents_swaps DROP COLUMN deadline_ms')
  S.ledger.__resetLedger()                              // a new isolate, an old database
  const pv = await Q({ ...base, dry: true })
  t('a preview against a pre-round-13 ledger works (was: 500 "no such column", seen on workerd)', pv.status === 200, pv.status + ' ' + JSON.stringify(pv.j).slice(0, 120))
  const cols = raw().prepare('PRAGMA table_info(intents_swaps)').all().map(c => c.name)
  t('…and the missing columns were added', cols.includes('state_at') && cols.includes('deadline_ms'))
  S.ledger.__resetLedger()
  t('running the upgrade again is harmless', (await Q({ ...base, dry: true })).status === 200)
  const r = await issue({ amount: '33' })
  t('a swap issued on the upgraded ledger carries its deadline as a number', Number.isFinite((await row(r.r.j.swap.id)).deadline_ms))
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) console.log('BROKE:\n  - ' + breaks.join('\n  - '))
process.exit(fail ? 1 : 0)
