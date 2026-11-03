// ============================================================
// CRYPTO LWA · cross-chain desk — RED TEAM ROUND 2 ("twice as hard", Stan)
// ============================================================
// New attack classes beyond round 1 (test/intents-redteam.mjs): token-list
// poisoning, symbol ambiguity, regex CPU bombs, router deposit-address reuse,
// settlement races, stale addresses past their deadline, numeric bombs, case
// tricks that break verification, lying feeds on chains we cannot verify.
// Every case asserts the SAFE outcome; BROKE = a break.
//
//   npx esbuild intents-entry.ts --bundle --format=esm --platform=neutral --outfile=intents-sys.mjs
//   node intents-redteam2.mjs
// ============================================================
import crypto from 'crypto'
import * as H from './intents-harness.mjs'
const { S, Q, issue, swapGet, adminGet, reconcile, freshEnv, row, setRowTime, base,
  USDC_BASE, SOL, USDC_ARB, WNEAR, EVM_ME, EVM_ME2, SOL_ME } = H
const W = () => H.getWorld(), ENV = () => H.getEnv()
const BTC = 'nep141:btc.omft.near'

let pass = 0, fail = 0
const breaks = []
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  safe   ' + name) }
  else { fail++; breaks.push(name); console.log('  BROKE  ' + name + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const section = s => console.log('\n[' + s + ']')
const noAddr = j => !JSON.stringify(j || {}).includes('"depositAddress":"0x') && !JSON.stringify(j || {}).includes('"depositAddress":"bc1')
const clearRL = () => ENV().CLWA_SESSIONS._m.clear()
const raw = JSON.parse((await import('fs')).readFileSync(new URL('./fixtures/fixtures-intents-tokens.json', import.meta.url), 'utf8'))

// mempool.space for BTC payout checks (lowercase addresses, as the real API returns)
const baseFetch = globalThis.fetch
let MEMPOOL = new Map()
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (url.hostname === 'mempool.space') {
    if (url.pathname.endsWith('/blocks/tip/height')) return new Response('1000000')     // round 25: depth is checked
    const tx = MEMPOOL.get(url.pathname.split('/').pop())
    return tx ? new Response(JSON.stringify(tx)) : new Response('not found', { status: 404 })
  }
  return baseFetch(input, init)
}
const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const pad = a => '0x' + '0'.repeat(24) + a.slice(2)
const payArb = (to, amount) => ({ status: '0x1', blockNumber: '0x1', logs: [{ address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', topics: [T0, pad(EVM_ME2), pad(to)], data: '0x' + BigInt(amount).toString(16).padStart(64, '0') }] })

// ═══════════════════════════════════════════════════════════════════════
section('D1 token-list poisoning ("ticker symbols are not unique identifiers")')
await freshEnv()
{
  const usdc = raw.find(x => x.assetId === USDC_BASE)
  const evil = { ...usdc, assetId: 'nep141:base-0x1111111111111111111111111111111111111111.omft.near', contractAddress: '0x1111111111111111111111111111111111111111', price: 1 }
  const sl = S.lib.slimTokens([...raw, evil])
  const both = sl.filter(x => x.chain === 'base' && x.symbol === 'USDC')
  t('two different tokens both called "USDC" on Base → neither is offered (ambiguous)', both.length === 0, both.map(x => x.id).join(' , '))
  const liar = { ...usdc, assetId: 'nep141:base-0x2222222222222222222222222222222222222222.omft.near', contractAddress: usdc.contractAddress, symbol: 'USDZ' }
  t('assetId says one contract, contractAddress says another → dropped', !S.lib.slimTokens([liar]).length)
  const homo = { ...usdc, assetId: 'nep141:base-0x3333333333333333333333333333333333333333.omft.near', contractAddress: '0x3333333333333333333333333333333333333333', symbol: 'UЅDC' }
  t('look-alike symbol with a Cyrillic letter → dropped by the symbol filter', !S.lib.slimTokens([homo]).length)
  W().tokensOverride = [...raw, evil]
  S.io.__resetTokenCache()
  const r = await Q({ ...base, dry: true }); clearRL()
  t('…and a quote for the now-ambiguous USDC on Base is refused', r.status === 400 && r.j.error === 'unsupported_from_asset', r.status + ' ' + (r.j && r.j.error))
  W().tokensOverride = null; S.io.__resetTokenCache()
}

section('D2 regex CPU bombs (a Worker that burns CPU dies — DoS)')
{
  const bombs = [
    ['near', 'a-'.repeat(31) + 'a!'], ['near', ('a-a.').repeat(15) + '!'], ['near', 'a'.repeat(63) + '-'],
    ['near', ('a_').repeat(30) + '.near!'], ['sol', '1'.repeat(120)], ['btc', 'bc1' + 'q'.repeat(87)],
    ['eth', '0x' + 'a'.repeat(118)], ['tron', 'T' + 'z'.repeat(119)],
  ]
  for (const [chain, s] of bombs) {
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) await S.lib.validAddress(chain, s)
    const ms = (performance.now() - t0) / 20
    t(`validAddress(${chain}, ${JSON.stringify(s.slice(0, 18))}…) stays fast (${ms.toFixed(2)} ms)`, ms < 5)
  }
  const t0 = performance.now(); S.lib.toBaseUnits('1'.repeat(30) + '.' + '1'.repeat(30), 30)
  t('toBaseUnits on a 61-char number stays fast', performance.now() - t0 < 5)
}

section('D3 router re-uses a deposit address for two different swaps')
await freshEnv()
{
  const pv = await Q({ ...base, dry: true }); clearRL()
  const a = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut }); clearRL()
  const dup = a.j.swap.depositAddress
  const orig = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const r = await orig(input, init)
    if (String(typeof input === 'string' ? input : input.url).includes('/v0/quote') && init.body && JSON.parse(init.body).dry === false) {
      const j = await r.json(); j.quote.depositAddress = dup; return new Response(JSON.stringify(j), { status: 201 })
    }
    return r
  }
  const b = await Q({ ...base, amount: '101', dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: '1' }, 'other@x.io'); clearRL()
  globalThis.fetch = orig
  t('second swap given the SAME deposit address → refused with a clean JSON error, never shown', b.status >= 400 && b.status < 600 && b.j && b.j.error && noAddr(b.j), b.status + ' ' + JSON.stringify(b.j).slice(0, 160))
  t('…logged as critical', ENV().CLWA_CLUSTERS.raw.prepare("SELECT COUNT(*) n FROM intents_events WHERE kind='critical' AND detail LIKE '%deposit_address_reused%'").get().n >= 1)
  t('…the first member’s swap is untouched', (await row(a.j.swap.id)).state === 'awaiting_deposit')
}

section('D4 settlement races')
await freshEnv()
{
  H.getWorld().calls.quoteReal = 0
  const mk = async () => { clearRL(); return (await issue({ to: USDC_ARB, recipient: EVM_ME })).r.j.swap }
  const a = await mk(), b = await mk()
  const tx = '0x' + 'cd'.repeat(32)
  W().receipts.set(tx, payArb(EVM_ME, BigInt(a.minAmountOut) * 5n))
  for (const s of [a, b]) { W().status.set(s.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: s.minAmountOut, destinationChainTxHashes: [{ hash: tx, explorerUrl: 'https://arbiscan.io/tx/' + tx }] } }); setRowTime(s.id, Date.now() - 60e3) }
  clearRL()
  await Promise.all([swapGet(a.id), swapGet(b.id), reconcile(), swapGet(a.id), swapGet(b.id)])
  const ra = await row(a.id), rb = await row(b.id)
  const settled = [ra, rb].filter(r => r.state === 'settled').length
  t(`two swaps racing to settle on ONE payout tx at the same instant → exactly one settles (got ${settled})`, settled === 1, ra.state + '/' + rb.state)
  const ev = ENV().CLWA_CLUSTERS.raw.prepare("SELECT swap_id, COUNT(*) n FROM intents_events WHERE kind='state' AND detail LIKE '%settled%' GROUP BY swap_id").all()
  t('no swap logged "settled" twice under concurrent polling', ev.every(e => e.n === 1), JSON.stringify(ev))
}

section('D5 stale deposit addresses (past the router’s deadline)')
await freshEnv()
{
  const pv = await Q({ ...base, dry: true }); clearRL()
  const key = crypto.randomUUID()
  const a = await Q({ ...base, dry: false, idempotencyKey: key, acceptedAmountOut: pv.j.terms.amountOut }); clearRL()
  ENV().CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET deadline = ? WHERE id = ?').run(new Date(Date.now() - 60e3).toISOString(), a.j.swap.id)
  W().oneclickDown = true    // nobody has reconciled it yet
  const replay = await Q({ ...base, dry: false, idempotencyKey: key, acceptedAmountOut: pv.j.terms.amountOut }); clearRL()
  t('idempotent replay of a swap whose address has EXPIRED does not hand the address out again', replay.status === 200 && !replay.j.swap.depositAddress && replay.j.swap.state === 'expired', JSON.stringify(replay.j.swap && { s: replay.j.swap.state, d: replay.j.swap.depositAddress }))
  const list = await swapGet(null); clearRL()
  t('history list hides an expired address too', list.j.swaps.every(s => !s.depositAddress || s.state !== 'expired') && !list.j.swaps.some(s => s.depositAddress && s.deadline && Date.parse(s.deadline) < Date.now()))
  W().oneclickDown = false
  const orig = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const r = await orig(input, init)
    if (String(typeof input === 'string' ? input : input.url).includes('/v0/quote') && init.body && JSON.parse(init.body).dry === false) {
      const j = await r.json(); j.quote.deadline = new Date(Date.now() - 1000).toISOString(); return new Response(JSON.stringify(j), { status: 201 })
    }
    return r
  }
  const past = await Q({ ...base, amount: '102', dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: '1' }); clearRL()
  globalThis.fetch = orig
  t('router hands out an address that is ALREADY past its deadline → refused', past.status >= 400 && noAddr(past.j), past.status + ' ' + (past.j && (past.j.error + ' ' + (past.j.detail || ''))))
}

section('D6 numeric bombs from the router')
for (const [why, mut] of [
  ['amountOut with 60 digits', q => { q.quote.amountOut = '9'.repeat(60); q.quote.minAmountOut = '9'.repeat(59) }],
  ['amountOutUsd "NaN"', q => { q.quote.amountOutUsd = 'NaN'; q.quote.amountInUsd = 'Infinity' }],
  ['timeEstimate a string', q => { q.quote.timeEstimate = '<b>soon</b>' }],
  ['negative-looking amountOut', q => { q.quote.amountOut = '-5' }],
  ['amountOut with leading zeros and spaces', q => { q.quote.amountOut = ' 000123' }],
  ['3 MB response body', q => { q.pad = 'x'.repeat(3_000_000) }],
]) {
  await freshEnv()
  const orig = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const r = await orig(input, init)
    if (String(typeof input === 'string' ? input : input.url).includes('/v0/quote')) { const j = await r.json(); mut(j); return new Response(JSON.stringify(j), { status: 201 }) }
    return r
  }
  let r
  try { r = await Q({ ...base, dry: true }) } catch (e) { r = { status: 'THREW ' + e.message } }
  globalThis.fetch = orig
  const shownBad = r.j && r.j.terms && (/9{40}/.test(JSON.stringify(r.j.terms)) || /NaN|Infinity|<b>/.test(JSON.stringify(r.j.terms)))
  // Junk in fields the desk never uses (the router's own USD figures, its time
  // estimate) must not block a valid quote — but must never be SHOWN either.
  const informational = why.startsWith('timeEstimate') || why.startsWith('amountOutUsd')
  t('router sends ' + why + ' → handled cleanly (no crash, no garbage shown, no address)', typeof r.status === 'number' && r.status < 600 && !shownBad && noAddr(r.j) && (informational || r.status >= 400 || r.j.terms.risk.allow === false),
    r.status + ' ' + JSON.stringify(r.j || {}).slice(0, 200))
}

section('D7 case tricks that break payout verification')
await freshEnv()
{
  W().cgPrice.bitcoin = 80658
  const UP = 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'          // legal: bech32 is case-insensitive; QR codes use uppercase
  clearRL()
  const { r } = await issue({ to: BTC, recipient: UP, amount: '100' })
  t('uppercase bech32 recipient is accepted (it is legal)', r && r.status === 200, r && r.status)
  if (r && r.status === 200) {
    const sw = r.j.swap
    const txid = 'ab'.repeat(32)
    MEMPOOL.set(txid, { txid, status: { confirmed: true, block_height: 999990, block_time: Math.floor(Date.now() / 1000) }, vout: [{ scriptpubkey_address: UP.toLowerCase(), value: Number(BigInt(sw.minAmountOut) + 10n) }] })
    W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.minAmountOut, destinationChainTxHashes: [{ hash: txid, explorerUrl: 'https://mempool.space/tx/' + txid }] } })
    setRowTime(sw.id, Date.now() - 60e3); clearRL()
    const s = (await swapGet(sw.id)).j.swap
    t('…and its payout (reported lowercase by the chain) VERIFIES — no false alarm, no route pause', s.state === 'settled' && s.destVerified === 'verified', s.state + ' / ' + s.destVerified)
  }
}

section('D8 lying router on chains we cannot verify (NEAR / Tron / LTC / DOGE)')
await freshEnv()
{
  clearRL()
  const { r } = await issue({ to: WNEAR, recipient: 'alice.near', amount: '50' })
  const sw = r.j.swap
  W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.minAmountOut, destinationChainTxHashes: [] } })
  setRowTime(sw.id, Date.now() - 60e3); clearRL()
  const s = (await swapGet(sw.id)).j.swap
  t('SUCCESS with NO payout tx on an unverifiable chain → not "Done"', s.state !== 'settled', s.state + ' / ' + s.destVerified)
  W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: '1', destinationChainTxHashes: [{ hash: 'abc', explorerUrl: 'https://nearblocks.io/txns/abc' }] } })
  setRowTime(sw.id, Date.now() - 60e3); clearRL()
  const s2 = (await swapGet(sw.id)).j.swap
  t('SUCCESS reporting less than the guaranteed minimum on an unverifiable chain → not "Done", flagged', s2.state !== 'settled' && /under_delivered/.test((await row(sw.id)).flags || ''), s2.state + ' ' + (await row(sw.id)).flags)
}

section('D9 concurrent polling storms do not corrupt the ledger')
await freshEnv()
{
  clearRL()
  const sw = (await issue()).r.j.swap
  const steps = ['KNOWN_DEPOSIT_TX', 'PROCESSING', 'PROCESSING', 'KNOWN_DEPOSIT_TX', 'PROCESSING']
  for (const st of steps) {
    W().status.set(sw.depositAddress, { status: st, updatedAt: 'x', swapDetails: {} })
    setRowTime(sw.id, Date.now() - 60e3)
    await Promise.all([...Array(8)].map(() => { clearRL(); return swapGet(sw.id) }).concat([reconcile(), reconcile()]))
  }
  const r = await row(sw.id)
  const stateEvents = ENV().CLWA_CLUSTERS.raw.prepare("SELECT detail FROM intents_events WHERE swap_id=? AND kind='state'").all(sw.id).map(x => x.detail)
  t('after a polling storm the swap is in a forward state and every transition was logged once', r.state === 'processing' && stateEvents.length === 2, r.state + ' ' + JSON.stringify(stateEvents))
  t('the late KNOWN_DEPOSIT_TX after PROCESSING was flagged as a regression, not applied', /status_regressed/.test(r.flags || ''))
}

section('D10 upstream abuse — forcing 1Click to mint addresses (non-atomic KV, parallel isolates)')
await freshEnv()
{
  const lag = () => new Promise(r => setTimeout(r, 3))
  const m = new Map(); ENV().CLWA_SESSIONS = { get: async k => { await lag(); return m.get(k) ?? null }, put: async (k, v) => { await lag(); m.set(k, v) }, delete: async () => {}, _m: m }
  W().quoteMode = 'slow'
  // acceptedAmountOut absurdly high → every request is refused as terms_changed AFTER 1Click minted an address
  const many = await Promise.all(Array.from({ length: 30 }, () => Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: '9'.repeat(40) })))
  const minted = W().calls.quoteReal
  t(`30 parallel doomed requests → 1Click asked to mint at most 6 addresses in a minute (got ${minted})`, minted <= 6, JSON.stringify(many.map(x => x.j && x.j.error)).slice(0, 200))
  t('…and none of them was shown an address', many.every(x => noAddr(x.j)))
}
await freshEnv()
{
  // Worst case for an eventually-consistent KV: every read is stale (requests
  // landing on different edge locations). The KV limiter then sees nothing.
  ENV().CLWA_SESSIONS = { get: async () => null, put: async () => {}, delete: async () => {}, _m: new Map() }
  for (let i = 0; i < 30; i++) await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: '9'.repeat(40) })
  const minted = W().calls.quoteReal
  t(`30 SEQUENTIAL doomed requests with a stale KV → 1Click minted at most 6 addresses (got ${minted})`, minted <= 6)
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) { console.log('\nBREAKS:'); for (const b of breaks) console.log('  - ' + b) }
process.exit(fail ? 1 : 0)
