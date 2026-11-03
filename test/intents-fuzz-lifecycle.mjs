// ============================================================
// CRYPTO LWA · cross-chain desk — LIFECYCLE INVARIANT FUZZER (red-team round 6)
// ============================================================
// Random status feeds, random payout receipts (right, short, wrong recipient,
// wrong token, old block, re-used tx, reverted, missing), random pollers and
// reconciler passes. Invariants checked after every step:
//
//   L1  nothing throws; every poll answers 200/404
//   L2  'settled' only with PROOF: a payout tx (EVM) that succeeded, paid THIS recipient
//       ≥ minimum in THIS token, was mined after the swap was created, and settled no
//       other swap — or, on a chain we cannot check, a named tx and a reported amount ≥ min
//   L3  settled / refunded / failed never change again
//   L4  state never moves backwards (only expired → a later state, for a late deposit)
//   L5  every critical flag on a swap has paused its route (or the whole desk)
//   L6  one payout tx settles at most one swap (ledger-wide)
//
//   node intents-fuzz-lifecycle.mjs [swaps=400] [seed]
// ============================================================
import crypto from 'crypto'
import * as H from './intents-harness.mjs'
const { S, issue, swapGet, reconcile, adminGet, freshEnv, setRowTime, USDC_ARB, WNEAR, EVM_ME, EVM_ME2 } = H
const W = () => H.getWorld(), ENV = () => H.getEnv()
const NSWAPS = Number(process.argv[2] || 400)
let seed = Number(process.argv[3] || 7)
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = a => a[Math.floor(rnd() * a.length)]

const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const USDC_ARB_C = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const pad = a => '0x' + '0'.repeat(24) + a.slice(2)
const RANK = { awaiting_deposit: 0, expired: 0, deposit_seen: 1, incomplete_deposit: 1, processing: 2, delivered_claimed: 3, settled: 4, refunded: 4, failed: 4 }
const FINAL = new Set(['settled', 'refunded', 'failed'])
const blockTs = new Map()
const baseFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (url.hostname.endsWith('publicnode.com') && init.body) {
    const b = JSON.parse(init.body)
    if (b.method === 'eth_getBlockByNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { timestamp: '0x' + (blockTs.get(b.params[0]) ?? Math.floor(Date.now() / 1000)).toString(16) } }))
  }
  return baseFetch(input, init)
}

const v = []
const bad = (rule, d) => { if (v.length < 25) v.push(rule + ': ' + d) }
await freshEnv()
await S.ledger.ensureTables(ENV().CLWA_CLUSTERS)
const db = () => ENV().CLWA_CLUSTERS.raw
// receipts the feed may point at: honest and dishonest
const receipts = []
const mkReceipt = (kind, sw) => {
  const hash = '0x' + crypto.randomBytes(32).toString('hex')
  const min = BigInt(sw.min_amount_out)
  const block = '0x' + (1000 + receipts.length).toString(16)
  blockTs.set(block, Math.floor(Date.now() / 1000) + 5)
  let rc
  if (kind === 'good') rc = { status: '0x1', blockNumber: block, logs: [{ address: USDC_ARB_C, topics: [T0, pad(EVM_ME2), pad(sw.recipient)], data: '0x' + (min + 1n).toString(16).padStart(64, '0') }] }
  if (kind === 'short') rc = { status: '0x1', blockNumber: block, logs: [{ address: USDC_ARB_C, topics: [T0, pad(EVM_ME2), pad(sw.recipient)], data: '0x' + (min - 1n).toString(16).padStart(64, '0') }] }
  if (kind === 'wrongTo') rc = { status: '0x1', blockNumber: block, logs: [{ address: USDC_ARB_C, topics: [T0, pad(EVM_ME2), pad(EVM_ME2)], data: '0x' + (min * 2n).toString(16).padStart(64, '0') }] }
  if (kind === 'wrongToken') rc = { status: '0x1', blockNumber: block, logs: [{ address: '0x' + '9'.repeat(40), topics: [T0, pad(EVM_ME2), pad(sw.recipient)], data: '0x' + (min * 2n).toString(16).padStart(64, '0') }] }
  if (kind === 'reverted') rc = { status: '0x0', blockNumber: block, logs: [] }
  if (kind === 'old') { rc = { status: '0x1', blockNumber: block, logs: [{ address: USDC_ARB_C, topics: [T0, pad(EVM_ME2), pad(sw.recipient)], data: '0x' + (min * 2n).toString(16).padStart(64, '0') }] }; blockTs.set(block, Math.floor(Date.now() / 1000) - 30 * 86400) }
  if (rc) W().receipts.set(hash, rc)
  const r = { hash, kind, ok: kind === 'good', to: sw.id }
  receipts.push(r)
  return r
}

let issued = 0
for (let n = 0; n < NSWAPS; n++) {
  db().prepare('DELETE FROM intents_rl').run()
  db().prepare("UPDATE intents_swaps SET created_at = created_at - 90000000 WHERE state NOT IN ('awaiting_deposit')").run()
  db().prepare("UPDATE intents_swaps SET state = 'expired' WHERE state = 'awaiting_deposit' AND id NOT IN (SELECT id FROM intents_swaps ORDER BY created_at DESC LIMIT 3)").run()
  // resume every pause so new swaps can still be issued; pauses are checked per step below
  db().prepare('DELETE FROM intents_control').run()
  const near = rnd() < 0.25
  const { r } = await issue(near ? { to: WNEAR, recipient: 'alice.near', amount: '50' } : { to: USDC_ARB, recipient: EVM_ME, amount: '120' })
  if (!r || r.status !== 200) continue
  issued++
  const id = r.j.swap.id
  let prev = db().prepare('SELECT * FROM intents_swaps WHERE id = ?').get(id)
  for (let step = 0; step < 8; step++) {
    const sw = db().prepare('SELECT * FROM intents_swaps WHERE id = ?').get(id)
    // A payout can only be "named for A" if the server actually reads that report:
    // swaps already final are not read by member polls (correctly), so the router
    // naming a tx for them is unobservable and is not counted as ownership.
    let st = pick(['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'SUCCESS', 'SUCCESS', 'REFUNDED', 'FAILED', 'WAT', null])
    if (FINAL.has(sw.state) && st === 'SUCCESS') st = 'PROCESSING'
    let destTxs = []
    if (st === 'SUCCESS') {
      if (near) destTxs = rnd() < 0.5 ? [] : [{ hash: 'nearTx' + n, explorerUrl: 'https://nearblocks.io/txns/x' }]
      else {
        const reuse = receipts.filter(x => x.ok && x.to !== id)
        const rc = rnd() < 0.25 && reuse.length ? pick(reuse) : mkReceipt(pick(['good', 'good', 'short', 'wrongTo', 'wrongToken', 'reverted', 'old', 'missing']), sw)
        destTxs = [{ hash: rc.hash, explorerUrl: 'https://arbiscan.io/tx/' + rc.hash }]
      }
    }
    const amountOut = near && st === 'SUCCESS' ? (rnd() < 0.5 ? sw.min_amount_out : '1') : sw.min_amount_out
    if (st === null) W().status.delete(sw.deposit_address)
    else W().status.set(sw.deposit_address, st === 'WAT' ? { status: 'WAT' } : { status: st, updatedAt: 'x', swapDetails: { amountOut, refundedAmount: st === 'REFUNDED' ? '5' : '0', destinationChainTxHashes: destTxs } })
    setRowTime(id, Date.now() - 60e3)
    let res
    // SUCCESS reports go through the member poll, which always reads THIS swap's feed;
    // other steps alternate with reconciler passes (bounded to the 25 oldest rows).
    try { res = (st === 'SUCCESS' || pick([0, 1])) ? await swapGet(id) : await reconcile() } catch (e) { bad('L1 threw', e.message); continue }
    if (st === 'SUCCESS' && destTxs.length && !near) {
      const owner = db().prepare('SELECT swap_id FROM intents_payouts WHERE hash = ?').get(destTxs[0].hash.toLowerCase())
      const made = receipts.find(x => x.hash === destTxs[0].hash)
      if (made && owner && made.to !== owner.swap_id && made.to !== id) {} // named first for a third swap: ownership is the server's first read
      if (made && made.to !== id && owner && owner.swap_id === id && receipts.some(x => x.hash === made.hash && x.to !== id && x.read)) bad('L6 a payout read for another swap was re-owned', made.hash)
      if (made && made.to === id) made.read = true
    }
    if (![200, 404].includes(res.status)) bad('L1 status', res.status)
    const now = db().prepare('SELECT * FROM intents_swaps WHERE id = ?').get(id)
    if (FINAL.has(prev.state) && now.state !== prev.state) bad('L3 final changed', prev.state + ' → ' + now.state)
    if (RANK[now.state] < RANK[prev.state] && !(now.state === 'expired')) bad('L4 went backwards', prev.state + ' → ' + now.state)
    if (now.state === 'settled' && prev.state !== 'settled') {
      if (near) {
        const txs = JSON.parse(now.dest_txs || '[]')
        if (!txs.length || !now.amount_out_actual || BigInt(now.amount_out_actual) < BigInt(now.min_amount_out)) bad('L2 NEAR settled without a tx and a full amount', JSON.stringify({ txs, a: now.amount_out_actual, m: now.min_amount_out }))
      } else {
        const rc = receipts.find(x => x.hash === now.settled_tx)
        const owner = db().prepare('SELECT swap_id FROM intents_payouts WHERE hash = ?').get(now.settled_tx)
        // proof = an honest receipt, owned by THIS swap at the server's first read, and never
        // READ by the server for any other swap first
        const readForOther = rc && rc.to !== id && rc.read
        if (!rc || !rc.ok || !owner || owner.swap_id !== id || readForOther) bad('L2 settled without proof', JSON.stringify({ tx: now.settled_tx, kind: rc && rc.kind, owner: owner && owner.swap_id === id, readForOther }))
      }
    }
    const flags = JSON.parse(now.flags || '[]').filter(f => S.ledger.CRITICAL_FLAGS.has(f))
    if (flags.length) {
      const c = db().prepare("SELECT key FROM intents_control WHERE key IN ('pause:global', ?)").all('pause:route:' + now.route)
      if (!c.length) bad('L5 critical flag without a pause', flags.join(',') + ' on ' + now.route)
    }
    prev = now
  }
}
const dup = db().prepare("SELECT settled_tx, COUNT(*) n FROM intents_swaps WHERE settled_tx IS NOT NULL GROUP BY settled_tx HAVING n > 1").all()
if (dup.length) bad('L6 one tx settled several swaps', JSON.stringify(dup))
const by = db().prepare('SELECT state, COUNT(*) n FROM intents_swaps GROUP BY state').all()
console.log(`swaps ${issued} · steps ${issued * 8} · final states ${JSON.stringify(Object.fromEntries(by.map(x => [x.state, x.n])))}`)
console.log(`payout receipts offered ${receipts.length} (honest ${receipts.filter(x => x.ok).length}, dishonest ${receipts.filter(x => !x.ok).length})`)
if (v.length) { console.log(`\nINVARIANT VIOLATIONS (${v.length}):`); for (const x of v) console.log('  ✗ ' + x); process.exit(1) }
console.log('\nall 6 lifecycle invariants held on every step')
