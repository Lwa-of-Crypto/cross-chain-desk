// ============================================================
// CRYPTO LWA · cross-chain desk — RED TEAM ROUND 4 ("keep breaking it")
// ============================================================
// Display drift after issue, desk-wide (not just per-member) budgets toward the
// partner API, and what a swap looks like when the world changes under it.
// Every case asserts the SAFE outcome; BROKE = a break.
//
//   npx esbuild intents-entry.ts --bundle --format=esm --platform=neutral --outfile=intents-sys.mjs
//   node intents-redteam4.mjs
// ============================================================
import crypto from 'crypto'
import fs from 'fs'
import * as H from './intents-harness.mjs'
const { S, Q, issue, swapGet, freshEnv, row, base, USDC_BASE } = H
const W = () => H.getWorld(), ENV = () => H.getEnv()

let pass = 0, fail = 0
const breaks = []
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  safe   ' + name) }
  else { fail++; breaks.push(name); console.log('  BROKE  ' + name + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const section = s => console.log('\n[' + s + ']')
const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/fixtures-intents-tokens.json', import.meta.url), 'utf8'))

// ═══════════════════════════════════════════════════════════════════════
section('G1 the token list changes AFTER a swap was issued')
await freshEnv()
{
  const sw = (await issue({ amount: '30' })).r.j.swap
  // 1Click delists the origin token (or it becomes ambiguous and is withheld)
  W().tokensOverride = raw.filter(x => x.assetId !== USDC_BASE); S.io.__resetTokenCache()
  const g = (await swapGet(sw.id)).j.swap
  t('the swap still carries its OWN decimals and symbol (the card cannot fall back to 0 decimals)',
    g.fromDecimals === 6 && g.fromSymbol === 'USDC' && g.toDecimals === 9 && g.toSymbol === 'SOL', JSON.stringify({ fd: g.fromDecimals, fs: g.fromSymbol, td: g.toDecimals, ts: g.toSymbol }))
  // the list comes back saying USDC has 18 decimals (bug or poisoning)
  W().tokensOverride = raw.map(x => x.assetId === USDC_BASE ? { ...x, decimals: 18 } : x); S.io.__resetTokenCache()
  const g2 = (await swapGet(sw.id)).j.swap
  t('a later token list with different decimals does not change what the member is told to send', g2.fromDecimals === 6, g2.fromDecimals)
  W().tokensOverride = null; S.io.__resetTokenCache()
}

section('G2 desk-wide budgets toward 1Click (many members at once)')
await freshEnv()
{
  for (let i = 0; i < 30; i++) await ENV().CLWA_MEMBERS.put('member:m' + i + '@x.io', JSON.stringify({ email: 'm' + i + '@x.io', plan: 'lifetime', status: 'active' }))
  W().calls.quoteDry = 0
  await Promise.all([...Array(30)].flatMap((_, i) => [...Array(40)].map(() => Q({ ...base, dry: true }, 'm' + i + '@x.io'))))
  t(`30 members × 40 previews at once → 1Click sees at most 1200 in the minute (got ${W().calls.quoteDry})`, W().calls.quoteDry <= 1200)   // round 13 r2: desk-wide caps raised so ~10 networks, not 5, are needed to fill them
  W().calls.quoteReal = 0
  await Promise.all([...Array(30)].flatMap((_, i) => [...Array(6)].map(() => Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: '9'.repeat(40) }, 'm' + i + '@x.io'))))
  t(`30 members × 6 doomed real requests → 1Click mints at most 180 addresses in the minute (got ${W().calls.quoteReal})`, W().calls.quoteReal <= 180)   // ~15 networks to fill (was 4)
}

section('G3 one payout reported for two different swaps (found by the lifecycle fuzzer)')
await freshEnv()
{
  const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad = a => '0x' + '0'.repeat(24) + a.slice(2)
  const mk = async () => { return (await issue({ to: H.USDC_ARB, recipient: H.EVM_ME, amount: '120' })).r.j.swap }
  const A = await mk()
  ENV().CLWA_CLUSTERS.raw.prepare('DELETE FROM intents_rl').run()
  const B = await mk()
  const X = '0x' + 'ef'.repeat(32)
  W().receipts.set(X, { status: '0x1', blockNumber: '0x1', logs: [{ address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', topics: [T0, pad(H.EVM_ME2), pad(H.EVM_ME)], data: '0x' + (BigInt(A.minAmountOut) * 2n).toString(16).padStart(64, '0') }] })
  // the router names X for A while A is still processing (so the desk READS it)…
  W().status.set(A.depositAddress, { status: 'PROCESSING', updatedAt: 'x', swapDetails: { destinationChainTxHashes: [{ hash: X, explorerUrl: 'https://arbiscan.io/tx/' + X }] } })
  H.setRowTime(A.id, Date.now() - 60e3); ENV().CLWA_CLUSTERS.raw.prepare('DELETE FROM intents_rl').run(); await swapGet(A.id)
  // …then says A was refunded, and claims the very same X as B's payout.
  W().status.set(A.depositAddress, { status: 'REFUNDED', updatedAt: 'x', swapDetails: { refundedAmount: '5' } })
  H.setRowTime(A.id, Date.now() - 60e3); ENV().CLWA_CLUSTERS.raw.prepare('DELETE FROM intents_rl').run(); await swapGet(A.id)
  W().status.set(B.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: B.minAmountOut, destinationChainTxHashes: [{ hash: X, explorerUrl: 'https://arbiscan.io/tx/' + X }] } })
  H.setRowTime(B.id, Date.now() - 60e3); ENV().CLWA_CLUSTERS.raw.prepare('DELETE FROM intents_rl').run()
  const b = (await swapGet(B.id)).j.swap
  const rb = await row(B.id)
  t('a payout first reported for swap A cannot settle swap B', b.state !== 'settled', b.state)
  t('…B is flagged payout_tx_reused and its route paused', /payout_tx_reused/.test(rb.flags || '') && !!(await H.adminGet()).j.controls.routes[rb.route], rb.flags)
}

section('G4 layer tests — each guard alone, with the other layers out of the way (mutation campaign survivors)')
await freshEnv()
{
  // (a) refresh lease: 40 isolates that ALREADY read the same stale row refresh at once
  const sw = (await issue()).r.j.swap
  W().status.set(sw.depositAddress, { status: 'PROCESSING', updatedAt: 'x', swapDetails: {} })
  H.setRowTime(sw.id, Date.now() - 60e3)
  const stale = await row(sw.id)
  W().calls.status = 0; W().statusDelay = 20
  await Promise.all([...Array(40)].map(() => S.io.refreshSwap(ENV(), ENV().CLWA_CLUSTERS, { ...stale }, 'member')))
  W().statusDelay = 0
  t(`lease: 40 isolates holding the same stale row → 1Click asked once (got ${W().calls.status})`, W().calls.status === 1)
  t('…and the state still moved forward', (await row(sw.id)).state === 'processing')
}
await freshEnv()
{
  // (b) atomic open-swap cap: 10 reservations hit the insert at the same instant
  await S.ledger.ensureTables(ENV().CLWA_CLUSTERS)
  const caps = { memberOpenSwaps: 5, memberDailyUsd: 1e9, routeDailyUsd: 1e9, globalDailyUsd: 1e9 }
  const mk = i => ({ id: 'r' + i, idem: 'i' + i, member: 'paid@x.io', route: 'base>sol', from_chain: 'base', to_chain: 'sol', from_asset: 'a', to_asset: 'b',
    amount_in: '1', recipient: 'x', refund_to: 'y', usd_in: 1, from_decimals: 6, to_decimals: 9, from_symbol: 'A', to_symbol: 'B' })
  ENV().CLWA_CLUSTERS.raw.prepare("INSERT INTO intents_swaps (id, idem, member, created_at, updated_at, route, from_chain, to_chain, from_asset, to_asset, amount_in, recipient, refund_to, usd_in, state) VALUES ('old1','o1','paid@x.io',?,?,'base>sol','base','sol','a','b','1','x','y',1,'awaiting_deposit'), ('old2','o2','paid@x.io',?,?,'base>sol','base','sol','a','b','1','x','y',1,'awaiting_deposit')").run(Date.now() - 3600e3, Date.now() - 3600e3, Date.now() - 3600e3, Date.now() - 3600e3)
  const res = await Promise.all([...Array(10)].map((_, i) => S.ledger.reserve(ENV().CLWA_CLUSTERS, mk(i), Date.now(), caps)))
  const got = res.filter(r => r.kind === 'new').length
  t(`atomic insert alone: 2 open + 10 simultaneous reservations vs a cap of 5 → exactly 3 granted (got ${got})`, got === 3, JSON.stringify(res.map(r => r.kind)))
}
await freshEnv()
{
  // (c) one-payout-one-swap check, with the ownership record lost (only this layer stands)
  const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad = a => '0x' + '0'.repeat(24) + a.slice(2)
  const A = (await issue({ to: H.USDC_ARB, recipient: H.EVM_ME, amount: '120' })).r.j.swap
  ENV().CLWA_CLUSTERS.raw.prepare('DELETE FROM intents_rl').run()
  const B = (await issue({ to: H.USDC_ARB, recipient: H.EVM_ME, amount: '120' })).r.j.swap
  const X = '0x' + 'ab'.repeat(32)
  W().receipts.set(X, { status: '0x1', blockNumber: '0x1', logs: [{ address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', topics: [T0, pad(H.EVM_ME2), pad(H.EVM_ME)], data: '0x' + (BigInt(A.minAmountOut) * 2n).toString(16).padStart(64, '0') }] })
  for (const s of [A]) { W().status.set(s.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: s.minAmountOut, destinationChainTxHashes: [{ hash: X, explorerUrl: 'https://arbiscan.io/tx/' + X }] } }); H.setRowTime(s.id, Date.now() - 60e3) }
  ENV().CLWA_CLUSTERS.raw.prepare('DELETE FROM intents_rl').run(); await swapGet(A.id)
  ENV().CLWA_CLUSTERS.raw.prepare('DELETE FROM intents_payouts').run()          // ownership record lost
  W().status.set(B.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: B.minAmountOut, destinationChainTxHashes: [{ hash: X, explorerUrl: 'https://arbiscan.io/tx/' + X }] } })
  H.setRowTime(B.id, Date.now() - 60e3); ENV().CLWA_CLUSTERS.raw.prepare('DELETE FROM intents_rl').run(); await swapGet(B.id)
  const rb = await row(B.id)
  t('with ownership lost, the settled-tx check still refuses B and records why on the swap', (await row(A.id)).state === 'settled' && rb.state !== 'settled' && rb.dest_verified === 'reused' && /payout_tx_reused/.test(rb.flags || ''), JSON.stringify({ a: (await row(A.id)).state, b: rb.state, v: rb.dest_verified, f: rb.flags }))
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) { console.log('\nBREAKS:'); for (const b of breaks) console.log('  - ' + b) }
process.exit(fail ? 1 : 0)
