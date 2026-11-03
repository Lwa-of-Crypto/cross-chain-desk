// ============================================================
// near-intents-desk — RED TEAM ROUND 17: regression suite
// ============================================================
// Dust against the desk-wide caps, busy swaps starving the re-checks, and the refund
// re-check query. Every case asserts the SAFE outcome; "BROKE" = a break.
//   node test/intents-redteam12.mjs
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
  else { fail++; breaks.push(name); console.log('  BROKE  ' + name + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const section = s => console.log('\n[' + s + ']')
const POL_USDC = 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L'   // contract 0x3c49…3359, from the real list
const BSC_BNB = 'nep245:v2_1.omni.hot.tg:56_11111111111111111111'
const asIp = (ip, body) => call(S.quote.onRequestPost, req('POST', '/api/quote', { body, who: null, headers: { 'cf-connecting-ip': ip } }))
async function realIssue(ip, over = {}) {
  const pv = await asIp(ip, { ...base, ...over, dry: true })
  if (pv.status !== 200) return { pv }
  return { pv, r: await asIp(ip, { ...base, ...over, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut }) }
}

// ═══════════════════════════════════════════════════════════════════════
section('K1 dust deposits cannot fill the desk-wide cap')
await freshEnv({ INTENTS_LIMITS: JSON.stringify({ globalDailyUsd: 3000, routeDailyUsd: 3000 }) })
{
  const ids = []
  for (let i = 0; i < 3; i++) ids.push((await realIssue(`10.110.${i}.1`, { amount: '1000' })).r?.j?.swap?.id)
  t('precondition: three $1,000 addresses issued', ids.every(Boolean), JSON.stringify(ids))
  // each gets 1 base unit of USDC: 1Click reports a partial deposit
  raw().prepare("UPDATE intents_swaps SET state = 'incomplete_deposit', deposited = '1' WHERE state = 'awaiting_deposit'").run()
  const r = await realIssue('10.110.9.1', { amount: '1000' })
  t('three dust deposits do not count as $3,000 against a $3,000 desk cap', r.r?.status === 200, JSON.stringify(r.r?.j || r.pv?.j).slice(0, 160))
  raw().prepare("UPDATE intents_swaps SET state = 'processing', deposited = amount_in WHERE id = ?").run(ids[0])
  raw().prepare("UPDATE intents_swaps SET state = 'processing', deposited = amount_in WHERE id = ?").run(ids[1])
  raw().prepare("UPDATE intents_swaps SET state = 'processing', deposited = amount_in WHERE id = ?").run(ids[2])
  const r2 = await realIssue('10.110.10.1', { amount: '1000' })
  t('…but three FULL deposits do: the cap still holds', r2.r?.j?.error === 'global_daily_cap' || r2.r?.j?.error === 'route_daily_cap', JSON.stringify(r2.r?.j).slice(0, 160))
  raw().prepare("UPDATE intents_swaps SET state = 'refunded' WHERE id IN (?, ?, ?)").run(ids[0], ids[1], ids[2])
  const r3 = await realIssue('10.110.11.1', { amount: '1000' })
  t('…and refunded swaps put nothing through, so they free it', r3.r?.status === 200, JSON.stringify(r3.r?.j).slice(0, 160))
}

// ═══════════════════════════════════════════════════════════════════════
section('K2 busy swaps cannot starve the re-checks and open addresses')
await freshEnv()
{
  const busy = []
  for (let i = 0; i < 10; i++) busy.push((await realIssue(`10.111.${i}.1`, { amount: String(20 + i) })).r.j.swap)
  const late = (await realIssue('10.111.50.1', { amount: '40' })).r.j.swap
  for (const s of busy) W().status.set(s.depositAddress, { status: 'PROCESSING', updatedAt: 'x', swapDetails: { depositedAmount: s.amountIn } })
  raw().prepare("UPDATE intents_swaps SET state = 'processing', updated_at = 1 WHERE id <> ?").run(late.id)
  raw().prepare("UPDATE intents_swaps SET state = 'expired', updated_at = 2, created_at = ? WHERE id = ?").run(Date.now() - 3600e3, late.id)
  W().status.set(late.depositAddress, { status: 'KNOWN_DEPOSIT_TX', updatedAt: 'x', swapDetails: { depositedAmount: late.amountIn } })
  const r = await S.io.reconcileBatch(S.envOf(ENV()), ENV().CLWA_CLUSTERS)
  t('10 swaps in progress: the late deposit to an expired address is still found in the same pass', r.results.some(x => x.id === late.id) && (await row(late.id)).state === 'deposit_seen',
    JSON.stringify({ checked: r.checked, deferred: r.deferred, late: (await row(late.id)).state }))
}

// ═══════════════════════════════════════════════════════════════════════
section('K3 refunds are re-checked by when they were refunded')
await freshEnv()
{
  const id = (await realIssue('10.112.0.1')).r.j.swap.id
  raw().prepare("UPDATE intents_swaps SET state = 'refunded', refunded = '1', created_at = ?, state_at = ?, updated_at = ? WHERE id = ?").run(Date.now() - 20 * 86400e3, Date.now() - 3600e3, Date.now() - 11 * 60e3, id)
  const r = await H.reconcile()
  t('a swap created 20 days ago but refunded an hour ago is re-checked', r.j.results.some(x => x.id === id))
  const plan = raw().prepare("EXPLAIN QUERY PLAN SELECT * FROM intents_swaps INDEXED BY intents_swaps_state_at WHERE state IN ('refunded','failed') AND state_at >= ? AND updated_at < ? LIMIT 5").all().map(x => x.detail).join(' | ')
  t('…through a range on (state, state_at), not 30 days of refunds', /intents_swaps_state_at \(state=\? AND state_at>\?\)/.test(plan), plan)
}

// ═══════════════════════════════════════════════════════════════════════
section('K4 (round 18) an idle poll that 1Click ANSWERS writes one row, not two')
await freshEnv()
{
  const first = await realIssue('10.113.0.1')
  const sw = first.r.j.swap
  W().status.set(sw.depositAddress, { status: 'PENDING_DEPOSIT', updatedAt: 'x', swapDetails: {} })     // same as stored
  const db = ENV().CLWA_CLUSTERS
  let writes = 0
  const orig = db.prepare
  db.prepare = sql => { const s = orig(sql); if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql) && !/intents_rl/.test(sql)) { const bind = s.bind; return { ...s, bind: (...a) => { const b = bind(...a); return { ...b, run: async () => { writes++; return b.run() } } } } } return s }
  raw().prepare('UPDATE intents_swaps SET updated_at = ?').run(Date.now() - 60e3)
  await S.worker.fetch(new Request('https://d.test/api/swap?id=' + sw.id, { headers: { 'cf-connecting-ip': '10.113.0.1', 'x-swap-token': first.r.j.token } }), S.envOf(ENV()), { waitUntil() {} })
  db.prepare = orig
  t('1Click answered "still pending" → exactly one write (the lease)', writes === 1, writes)
}

// ═══════════════════════════════════════════════════════════════════════
section('K5 (round 18) a refund re-check is never pushed out by an expired backlog')
await freshEnv()
{
  const exp = []
  for (let i = 0; i < 8; i++) exp.push((await realIssue(`10.114.${i}.1`, { amount: String(20 + i) })).r.j.swap.id)
  const ref = (await realIssue('10.114.50.1', { amount: '40' })).r.j.swap.id
  const now = Date.now()
  for (const id of exp) raw().prepare("UPDATE intents_swaps SET state = 'expired', created_at = ?, updated_at = ? WHERE id = ?").run(now - 2 * 86400e3, now - 3600e3, id)
  raw().prepare("UPDATE intents_swaps SET state = 'refunded', refunded = '1', state_at = ?, updated_at = ? WHERE id = ?").run(now - 3600e3, now - 11 * 60e3, ref)
  const r = await H.reconcile()
  t('8 older expired re-checks due: the refund is still re-checked in this pass', r.j.results.some(x => x.id === ref), JSON.stringify(r.j.results.map(x => x.from)))
}

// ═══════════════════════════════════════════════════════════════════════
section('K6 (round 18) a swap in progress with no reported deposit counts in full')
await freshEnv({ INTENTS_LIMITS: JSON.stringify({ globalDailyUsd: 3000, routeDailyUsd: 3000 }) })
{
  for (let i = 0; i < 3; i++) await realIssue(`10.115.${i}.1`, { amount: '1000' })
  raw().prepare("UPDATE intents_swaps SET state = 'processing', deposited = NULL WHERE state = 'awaiting_deposit'").run()
  const r = await realIssue('10.115.9.1', { amount: '1000' })
  t('three $1,000 swaps PROCESSING with no deposit figure still fill a $3,000 cap', r.r?.j?.error === 'global_daily_cap' || r.r?.j?.error === 'route_daily_cap', JSON.stringify(r.r?.j).slice(0, 160))
}

// ═══════════════════════════════════════════════════════════════════════
section('L1 (round 19) a swap 1Click calls delivered is checked first')
await freshEnv()
{
  const busy = []
  for (let i = 0; i < 8; i++) busy.push((await realIssue(`10.116.${i}.1`, { amount: String(20 + i) })).r.j.swap)
  const claimed = (await realIssue('10.116.50.1', { amount: '40' })).r.j.swap
  for (const s of busy) W().status.set(s.depositAddress, { status: 'INCOMPLETE_DEPOSIT', updatedAt: 'x', swapDetails: { depositedAmount: '1' } })
  raw().prepare("UPDATE intents_swaps SET state = 'incomplete_deposit', deposited = '1', updated_at = 1 WHERE id <> ?").run(claimed.id)
  raw().prepare("UPDATE intents_swaps SET state = 'delivered_claimed', updated_at = ? WHERE id = ?").run(Date.now() - 60e3, claimed.id)
  const r = await S.io.reconcileBatch(S.envOf(ENV()), ENV().CLWA_CLUSTERS)
  t('8 older dust-funded swaps queued: the delivered claim is the first one checked', r.results[0]?.id === claimed.id, JSON.stringify(r.results.map(x => x.from)))
}

// ═══════════════════════════════════════════════════════════════════════
section('L2 (round 19) dust first, then an unreported full deposit, still counts in full')
await freshEnv({ INTENTS_LIMITS: JSON.stringify({ globalDailyUsd: 3000, routeDailyUsd: 3000 }) })
{
  for (let i = 0; i < 3; i++) await realIssue(`10.117.${i}.1`, { amount: '1000' })
  raw().prepare("UPDATE intents_swaps SET state = 'processing', deposited = '1' WHERE state = 'awaiting_deposit'").run()
  const r = await realIssue('10.117.9.1', { amount: '1000' })
  t('three $1,000 swaps PROCESSING with a dust deposit figure fill a $3,000 cap', r.r?.j?.error === 'global_daily_cap' || r.r?.j?.error === 'route_daily_cap', JSON.stringify(r.r?.j).slice(0, 160))
}

// ═══════════════════════════════════════════════════════════════════════
section('L3 (round 19) a manual reconcile counts the setup calls made before it')
await freshEnv()
{
  // no swaps queued: a pass on its own makes ~8 calls, so a count of 12+ proves the setup calls were counted
  await H.Q({ ...base, dry: true })
  S.ledger.__resetLedger()                                 // a cold isolate
  const r = await H.adminPost({ action: 'reconcile' })
  t('the admin pass starts its count above zero and stays inside the 48-call budget', r.j?.ok && r.j.subrequests >= 12 && r.j.subrequests <= 48, JSON.stringify(r.j).slice(0, 160))
}

// ═══════════════════════════════════════════════════════════════════════
section('N1 (round 21) delivered swaps that can never verify do not starve the other paid swaps')
await freshEnv()
{
  const stuck = []
  for (let i = 0; i < 4; i++) stuck.push((await realIssue(`10.119.${i}.1`, { amount: String(20 + i) })).r.j.swap)
  const paid = (await realIssue('10.119.50.1', { amount: '40' })).r.j.swap
  const txs = [0, 1, 2].map(j => ({ hash: '0x' + String(j + 1).repeat(64), explorerUrl: 'https://x/' }))
  for (const s of stuck) W().status.set(s.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountIn: s.amountIn, depositedAmount: s.amountIn, amountOut: s.amountOut, destinationChainTxHashes: txs } })
  W().status.set(paid.depositAddress, { status: 'PROCESSING', updatedAt: 'x', swapDetails: { depositedAmount: paid.amountIn } })
  raw().prepare("UPDATE intents_swaps SET state = 'delivered_claimed', verify_attempts = 12, updated_at = ? WHERE id <> ?").run(Date.now() - 60e3, paid.id)
  raw().prepare("UPDATE intents_swaps SET state = 'processing', updated_at = ? WHERE id = ?").run(Date.now() - 30e3, paid.id)
  const r = await S.io.reconcileBatch(S.envOf(ENV()), ENV().CLWA_CLUSTERS)
  t('4 delivered swaps that keep failing verification: the paid swap in progress is still checked', r.results.some(x => x.id === paid.id), JSON.stringify(r.results.map(x => x.from)))
  t('…and at most 2 delivered swaps lead a pass', r.results.filter(x => x.from === 'delivered_claimed').length <= 2)
}

// ═══════════════════════════════════════════════════════════════════════
section('N2 (round 21) the payout is checked against the token frozen at issue, not today\'s list')
await freshEnv()
{
  const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad = a => '0x' + '0'.repeat(24) + a.slice(2)
  // Polygon USDC: a nep245 id that does NOT name its contract (round 22) — only the frozen contract can prove it
  const sw = (await H.issue({ to: POL_USDC, recipient: H.EVM_ME, amount: '100' })).r.j.swap
  const r0 = await row(sw.id)
  t('the destination contract is stored when the address is issued', (r0.to_contract || '').toLowerCase() === '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', r0.to_contract)
  const X = '0x' + crypto.randomBytes(32).toString('hex')
  W().receipts.set(X, { status: '0x1', blockNumber: '0x1', logs: [{ address: r0.to_contract.toLowerCase(), topics: [T0, pad(H.EVM_ME2), pad(H.EVM_ME)], data: '0x' + BigInt(sw.minAmountOut).toString(16).padStart(64, '0') }] })
  W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.minAmountOut, destinationChainTxHashes: [{ hash: X, explorerUrl: 'https://polygonscan.com/tx/' + X }] } })
  // today's token list no longer carries that asset (delisted, or withheld as ambiguous)
  W().tokensOverride = H.rawTokens.filter(x => x.assetId !== POL_USDC); S.io.__resetTokenCache()
  raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
  await H.reconcile()
  W().tokensOverride = null; S.io.__resetTokenCache()
  const r1 = await row(sw.id)
  t('the payout of the frozen token still verifies after the list changed', r1.state === 'settled' && r1.dest_verified === 'verified', r1.state + ' ' + r1.dest_verified)
}

// ═══════════════════════════════════════════════════════════════════════
section('N3 (round 21) the owner can close a delivered swap that can never be verified')
await freshEnv()
{
  const a = (await realIssue('10.120.0.1')).r.j.swap, b = (await realIssue('10.120.1.1', { amount: '31' })).r.j.swap
  raw().prepare("UPDATE intents_swaps SET state = 'delivered_claimed' WHERE id = ?").run(a.id)
  const bad = await H.adminPost({ action: 'resolve', id: a.id, note: 'x' })
  t('a close-out needs a written reason', bad.status === 400)
  const ok = await H.adminPost({ action: 'resolve', id: a.id, outcome: 'paid', note: 'payout seen by hand on the explorer' })
  const ra = await row(a.id)
  t('…with one, it is closed: settled, marked manual, logged', ok.j?.ok && ra.state === 'settled' && ra.dest_verified === 'manual' &&
    raw().prepare("SELECT COUNT(*) AS v FROM intents_events WHERE swap_id = ? AND kind = 'resolved'").get(a.id).v === 1, JSON.stringify(ok.j))
  const nope = await H.adminPost({ action: 'resolve', id: b.id, outcome: 'paid', note: 'not delivered yet, must refuse' })
  t('a swap that is not delivered_claimed cannot be closed this way', nope.status === 409 && (await row(b.id)).state === 'awaiting_deposit')
}

// ═══════════════════════════════════════════════════════════════════════
section('N4 (round 21) a pass full of paid swaps stays inside its call budget')
await freshEnv()
{
  const sws = []
  for (let i = 0; i < 20; i++) sws.push((await realIssue(`10.121.${i}.1`, { amount: String(20 + i) })).r.j.swap)
  for (const s of sws) W().status.set(s.depositAddress, { status: 'PROCESSING', updatedAt: 'x', swapDetails: { depositedAmount: s.amountIn } })
  raw().prepare("UPDATE intents_swaps SET state = 'processing', updated_at = 1").run()
  const r = await S.io.reconcileBatch(S.envOf(ENV()), ENV().CLWA_CLUSTERS)
  t(`20 paid swaps due: the pass stops inside 48 calls (used ${r.subrequests}) and leaves the rest for the next one`, r.subrequests <= 48 && r.deferred > 0, JSON.stringify({ used: r.subrequests, deferred: r.deferred }))
}

// ═══════════════════════════════════════════════════════════════════════
section('P1 (round 22) BSC / Polygon / Optimism / Avalanche payouts are really checked')
await freshEnv()
{
  const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad = a => '0x' + '0'.repeat(24) + a.slice(2)
  const POL_USDC_CONTRACT = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
  const V = S.verify
  const rc = (addr, amount) => ({ status: '0x1', blockNumber: '0x1', logs: [{ address: addr, topics: [T0, pad(H.EVM_ME2), pad(H.EVM_ME)], data: '0x' + BigInt(amount).toString(16).padStart(64, '0') }] })
  t('Polygon USDC paid by its own contract → verified', V.judgeEvm(rc(POL_USDC_CONTRACT, 1000n), null, POL_USDC, H.EVM_ME, 1000n, POL_USDC_CONTRACT) === 'verified')
  t('…a JUNK token sent to the recipient instead → not proven', V.judgeEvm(rc('0x' + 'ab'.repeat(20), 1000n), null, POL_USDC, H.EVM_ME, 1000n, POL_USDC_CONTRACT) === 'pending')
  t('…too little of the right token → short (alarm)', V.judgeEvm(rc(POL_USDC_CONTRACT, 999n), null, POL_USDC, H.EVM_ME, 1000n, POL_USDC_CONTRACT) === 'short')
  t('native BNB (nep245 …_1111…) is recognised as native', V.evmAssetOf(BSC_BNB, null)?.kind === 'native')
  t('a native BNB payout tx straight to the recipient → verified', V.judgeEvm({ status: '0x1', blockNumber: '0x1', logs: [] }, { to: H.EVM_ME, value: '0x' + (10n ** 18n).toString(16) }, BSC_BNB, H.EVM_ME, 10n ** 17n, null) === 'verified')
  t('an id the verifier cannot classify is never proven', V.judgeEvm(rc('0x' + 'ab'.repeat(20), 1000n), null, 'nep245:v2_1.omni.hot.tg:56_SomethingElse', H.EVM_ME, 1n, null) === 'pending')
  const sw = (await H.issue({ to: POL_USDC, recipient: H.EVM_ME, amount: '100' })).r?.j?.swap
  t('a Polygon USDC swap can be issued (its payout is checkable)', !!sw?.depositAddress)
}

// ═══════════════════════════════════════════════════════════════════════
section('P2 (round 22) a destination whose payout cannot be checked is never offered')
await freshEnv()
{
  const odd = { assetId: 'nep245:v2_1.omni.hot.tg:56_UnknownFormX', blockchain: 'bsc', symbol: 'ODDX', decimals: 18, price: 1, contractAddress: null }
  W().tokensOverride = [...H.rawTokens, odd]; S.io.__resetTokenCache()
  const r = await asIp('10.122.0.1', { ...base, to: odd.assetId, recipient: H.EVM_ME, dry: true })
  W().tokensOverride = null; S.io.__resetTokenCache()
  t('a BSC token with no contract and no native form → refused before any address', r.status === 400 && r.j.error === 'unverifiable_destination', JSON.stringify(r.j).slice(0, 160))
}

// ═══════════════════════════════════════════════════════════════════════
section('P3 (round 22) the member\'s own polls do not use up the verification grace')
await freshEnv()
{
  const first = await realIssue('10.123.0.1')
  const sw = first.r.j.swap
  W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.amountOut, destinationChainTxHashes: [{ hash: '5' + 'K'.repeat(86), explorerUrl: 'https://x/' }] } })
  raw().prepare("UPDATE intents_swaps SET state = 'delivered_claimed' WHERE id = ?").run(sw.id)
  for (let i = 0; i < 15; i++) {
    raw().prepare('UPDATE intents_swaps SET updated_at = ? WHERE id = ?').run(Date.now() - 60e3, sw.id)
    raw().prepare('DELETE FROM intents_rl').run()
    await S.worker.fetch(new Request('https://d.test/api/swap?id=' + sw.id, { headers: { 'cf-connecting-ip': '10.123.0.' + (i + 2), 'x-swap-token': first.r.j.token } }), S.envOf(ENV()), { waitUntil() {} })
  }
  const r = await row(sw.id)
  t('15 page polls on a payout still confirming: no attempts counted, no alarm', (r.verify_attempts || 0) === 0 && !/dest_unverified/.test(r.flags || ''), JSON.stringify({ attempts: r.verify_attempts, flags: r.flags }))
}

// ═══════════════════════════════════════════════════════════════════════
section('P4 (round 22) the owner can record that a "delivered" swap was NOT paid')
await freshEnv()
{
  const a = (await realIssue('10.124.0.1')).r.j.swap
  raw().prepare("UPDATE intents_swaps SET state = 'delivered_claimed' WHERE id = ?").run(a.id)
  t('a close-out needs an outcome', (await H.adminPost({ action: 'resolve', id: a.id, note: 'checked the explorer by hand' })).status === 400)
  const r = await H.adminPost({ action: 'resolve', id: a.id, outcome: 'not_paid', note: 'no payout on chain after 2 days' })
  const ra = await row(a.id)
  t('"not_paid" → failed (the member is told to contact support, not "Done"), logged with the note',
    r.j?.ok && ra.state === 'failed' && (raw().prepare("SELECT detail FROM intents_events WHERE swap_id = ? AND kind = 'resolved'").get(a.id)?.detail || '').includes('not_paid'), JSON.stringify(r.j))
}

// ═══════════════════════════════════════════════════════════════════════
section('Q1 (round 23) a native payout is never "proven" by someone else\'s transaction')
await freshEnv()
{
  const sw = (await H.issue({ to: H.ETH_ARB, recipient: H.EVM_ME, amount: '100' })).r?.j?.swap
  const X = '0x' + crypto.randomBytes(32).toString('hex')
  // a real, successful tx on Arbitrum — but not to the recipient, and balances unreadable
  W().receipts.set(X, { status: '0x1', blockNumber: '0x10', logs: [] })
  W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.amountOut, destinationChainTxHashes: [{ hash: X, explorerUrl: 'https://arbiscan.io/tx/' + X }] } })
  raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
  await H.reconcile()
  const r = await row(sw.id)
  t('an unrelated successful tx named as the payout does NOT settle a native swap', r.state === 'delivered_claimed' && r.dest_verified === 'pending', r.state + ' ' + r.dest_verified)
}

// ═══════════════════════════════════════════════════════════════════════
section('Q2 (round 23) a native destination is marked native, never read from today\'s list')
await freshEnv()
{
  const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad = a => '0x' + '0'.repeat(24) + a.slice(2)
  W().cgPrice.binancecoin = 742.29        // the fake price feed had no BNB (the desk correctly refused it as unpriced)
  const sw = (await H.issue({ to: BSC_BNB, recipient: H.EVM_ME, amount: '100' })).r?.j?.swap
  const r0 = await row(sw.id)
  t('a BNB swap stores to_contract = "native"', r0.to_contract === 'native', r0.to_contract)
  // later, the list (poisoned or wrong) gives BNB a contract — and a junk Transfer from it is named as the payout
  const JUNK = '0x' + 'ab'.repeat(20), X = '0x' + crypto.randomBytes(32).toString('hex')
  W().tokensOverride = H.rawTokens.map(x => x.assetId === BSC_BNB ? { ...x, contractAddress: JUNK } : x); S.io.__resetTokenCache()
  W().receipts.set(X, { status: '0x1', blockNumber: '0x10', logs: [{ address: JUNK, topics: [T0, pad(H.EVM_ME2), pad(H.EVM_ME)], data: '0x' + BigInt(sw.amountOut).toString(16).padStart(64, '0') }] })
  W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.amountOut, destinationChainTxHashes: [{ hash: X, explorerUrl: 'https://bscscan.com/tx/' + X }] } })
  raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
  await H.reconcile()
  W().tokensOverride = null; S.io.__resetTokenCache()
  const r1 = await row(sw.id)
  t('…a junk-token Transfer from a contract the list later invents does not settle it', r1.state !== 'settled', r1.state + ' ' + r1.dest_verified)
}

// ═══════════════════════════════════════════════════════════════════════
section('Q3 (round 23) every id form that names its contract must agree with the list')
{
  const rawT = [
    { assetId: '1cs_v1:bsc:bep20:0x5382555840ef9f54ef6d3ee5da60f12bcabf4b87', blockchain: 'bsc', symbol: 'GOODX', decimals: 18, price: 1, contractAddress: '0x5382555840ef9f54ef6d3ee5da60f12bcabf4b87' },
    { assetId: '1cs_v1:bsc:bep20:0x1a6659d434482a2b1694098c6757a62a8619cf12', blockchain: 'bsc', symbol: 'LIEX', decimals: 18, price: 1, contractAddress: '0x' + 'cd'.repeat(20) },
    { assetId: 'nep141:pol-0x7b12598e3616261df1c05ec28de0d2fb10c1f206.omdep.near', blockchain: 'pol', symbol: 'LIEY', decimals: 18, price: 1, contractAddress: '0x' + 'ef'.repeat(20) },
    { assetId: '1cs_v1:sol:spl:3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG', blockchain: 'sol', symbol: 'LIEZ', decimals: 9, price: 1, contractAddress: 'So11111111111111111111111111111111111111112' },
  ]
  const kept = S.lib.slimTokens(rawT).map(x => x.symbol)
  t('an entry whose id and contract agree is kept', kept.includes('GOODX'), JSON.stringify(kept))
  t('entries whose listed contract contradicts their own id are dropped (bep20, omdep, spl)', !kept.includes('LIEX') && !kept.includes('LIEY') && !kept.includes('LIEZ'), JSON.stringify(kept))
}

// ═══════════════════════════════════════════════════════════════════════
section('R1 (round 24) only real money to the recipient proves a payout')
{
  const V = S.verify
  const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad = a => '0x' + '0'.repeat(24) + a.slice(2)
  const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
  const xfer = (from, to, v) => ({ status: '0x1', logs: [{ address: USDC, topics: [T0, pad(from), pad(to)], data: '0x' + v.toString(16).padStart(64, '0') }] })
  t('a native balance rise SMALLER than the guaranteed amount proves nothing (it used to settle)', V.judgeNativeDelta(100n, 101n, 1000n) === 'pending')
  t('ERC-20: a transfer from the recipient to itself is not a payout', V.judgeEvm(xfer(H.EVM_ME, H.EVM_ME, 10n ** 9n), null, H.USDC_ARB, H.EVM_ME, 1000n) === 'pending')
  t('ERC-20: a transfer from someone else still is', V.judgeEvm(xfer(H.EVM_ME2, H.EVM_ME, 1000n), null, H.USDC_ARB, H.EVM_ME, 1000n) === 'verified')
  t('native: a tx the recipient sent to itself is not a payout', V.judgeEvm({ status: '0x1', logs: [] }, { from: H.EVM_ME, to: H.EVM_ME, value: '0x' + (10n ** 18n).toString(16) }, H.ETH_ARB, H.EVM_ME, 1n) === 'pending')
  const btcR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
  const btcTx = vin => ({ status: { confirmed: true, block_height: 100 }, vin, vout: [{ scriptpubkey_address: btcR, value: 500000 }] })
  t('Bitcoin: outputs of a tx the recipient itself funded (its change) are not a payout', V.judgeBtc(btcTx([{ prevout: { scriptpubkey_address: btcR } }]), btcR, 100000n, 200) === 'pending')
  t('Bitcoin: a tx funded by someone else still is', V.judgeBtc(btcTx([{ prevout: { scriptpubkey_address: 'bc1qother000000000000000000000000000000000' } }]), btcR, 100000n, 200) === 'verified')
  const solRes = { meta: { err: null, preBalances: [], postBalances: [] }, transaction: { message: { accountKeys: [{ pubkey: H.SOL_ME, signer: false }] } } }
  t('Solana native: balances that cannot be read prove nothing (they used to settle)', V.judgeSol(solRes, 'nep141:sol.omft.near', H.SOL_ME, 1n) === 'pending')
}

// ═══════════════════════════════════════════════════════════════════════
section('R2 (round 24) the receipt must be the one asked for, and final')
await freshEnv()
{
  const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad = a => '0x' + '0'.repeat(24) + a.slice(2)
  const mk = async ip => {
    const sw = (await H.issue({ to: H.USDC_ARB, recipient: H.EVM_ME, amount: '100' }, ip)).r.j.swap
    const X = '0x' + crypto.randomBytes(32).toString('hex')
    const receipt = { status: '0x1', blockNumber: '0x64', logs: [{ address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', topics: [T0, pad(H.EVM_ME2), pad(H.EVM_ME)], data: '0x' + BigInt(sw.minAmountOut).toString(16).padStart(64, '0') }] }
    W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.minAmountOut, destinationChainTxHashes: [{ hash: X, explorerUrl: 'https://arbiscan.io/tx/' + X }] } })
    return { sw, X, receipt }
  }
  const a = await mk()
  W().receipts.set(a.X, { ...a.receipt, transactionHash: '0x' + 'ee'.repeat(32) })      // the node answers with ANOTHER tx's receipt
  W().head = 1_000_000
  raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
  await H.reconcile()
  t('a receipt for a different tx than the one asked is ignored (not settled)', (await row(a.sw.id)).state !== 'settled', (await row(a.sw.id)).state)
  await freshEnv()
  const b = await mk()
  W().receipts.set(b.X, b.receipt)
  W().head = 0x64 + 5                                                                  // 5 blocks deep; Arbitrum needs 30
  raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
  await H.reconcile()
  t('a payout only 5 blocks deep is not settled yet (a reorg could drop it)', (await row(b.sw.id)).state === 'delivered_claimed', (await row(b.sw.id)).state)
  W().head = 0x64 + 40
  raw().prepare('UPDATE intents_swaps SET updated_at = 0').run()
  await H.reconcile()
  const rb = await row(b.sw.id)
  t('…once 40 blocks deep it settles, verified', rb.state === 'settled' && rb.dest_verified === 'verified', rb.state + ' ' + rb.dest_verified)
  W().head = undefined
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) console.log('BROKE:\n  - ' + breaks.join('\n  - '))
process.exit(fail ? 1 : 0)
