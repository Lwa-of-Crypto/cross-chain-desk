// ============================================================
// CRYPTO LWA · cross-chain desk — RED TEAM ("try to break the swap", Stan)
// ============================================================
// Every case asserts the SAFE outcome. A FAIL is a break.
// Attacker models: hostile member, other member (IDOR), cross-site page,
// racing client, compromised/buggy router, lying status feed, replayed chain txs.
//
//   npx esbuild intents-entry.ts --bundle --format=esm --platform=neutral --outfile=intents-sys.mjs
//   node intents-redteam.mjs
// ============================================================
import crypto from 'crypto'
import * as H from './intents-harness.mjs'
const { S, Q, issue, swapGet, adminPost, adminGet, reconcile, call, req, freshEnv, row, setRowTime, base,
  USDC_BASE, SOL, USDC_ARB, ETH_ARB, WNEAR, EVM_ME, EVM_ME2, SOL_ME, SITE } = H
const W = () => H.getWorld(), ENV = () => H.getEnv()

let pass = 0, fail = 0
const breaks = []
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  safe   ' + name) }
  else { fail++; breaks.push(name); console.log('  BROKE  ' + name + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const section = s => console.log('\n[' + s + ']')
const noAddr = j => !JSON.stringify(j || {}).includes('"depositAddress":"')
const clearRL = () => ENV().CLWA_SESSIONS._m.clear()
// an attempt counts as refused if the preview OR the real request refused, and no address leaked
const refused = x => { const z = x.r || x.pv; return z.status >= 400 && noAddr(z.j) && (!x.pv || noAddr(x.pv.j)) }

// extra chain-node behaviour for replay attacks (block timestamps, balances)
const baseFetch = globalThis.fetch
let BLOCK_TS = new Map()   // blockNumber hex → unix seconds
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (url.hostname.endsWith('publicnode.com') && init.body) {
    const b = JSON.parse(init.body)
    if (b.method === 'eth_getBlockByNumber') {
      const ts = BLOCK_TS.get(b.params[0])
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: ts === undefined ? null : { number: b.params[0], timestamp: '0x' + ts.toString(16) } }))
    }
  }
  return baseFetch(input, init)
}
const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const pad = a => '0x' + '0'.repeat(24) + a.slice(2)
function payReceipt(to, amount, block = '0x100') {
  return { status: '0x1', blockNumber: block, logs: [{ address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', topics: [T0, pad(EVM_ME2), pad(to)], data: '0x' + BigInt(amount).toString(16).padStart(64, '0') }] }
}
async function issueArb(who) { clearRL(); return (await issue({ to: USDC_ARB, recipient: EVM_ME }, who)).r }
async function claimSuccess(sw, hash, explorerUrl = 'https://arbiscan.io/tx/' + hash) {
  W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.minAmountOut, destinationChainTxHashes: [{ hash, explorerUrl }] } })
  setRowTime(sw.id, Date.now() - 60e3)
  clearRL()
  return (await swapGet(sw.id, sw._who)).j.swap
}

// ═══════════════════════════════════════════════════════════════════════
section('A1 amount fuzzing')
await freshEnv()
for (const a of ['1e3', '0x10', '1.', '.5', '١٢٣', '１', 'Infinity', 'NaN', '-1', '+1', '-0', '9'.repeat(31), '1,5', '1_000', '0', '0.0000000', '1.0000001', '']) {
  const r = await Q({ ...base, amount: a, dry: true }); clearRL()
  t('amount ' + JSON.stringify(a) + ' → refused 400', r.status === 400 && r.j.error === 'bad_amount', r.status + ' ' + JSON.stringify(r.j).slice(0, 120))
}
for (const a of [1e21, true, null, ['1'], { v: 1 }]) {
  const r = await Q({ ...base, amount: a, dry: true }); clearRL()
  t('amount of type ' + (Array.isArray(a) ? 'array' : typeof a) + ' ' + JSON.stringify(a) + ' → refused', r.status === 400, r.status)
}
{
  const sp = await Q({ ...base, amount: ' 1 ', dry: true }); clearRL()
  t('amount " 1 " is read as exactly 1 USDC (whitespace trimmed, nothing else)', sp.status === 200 && sp.j.terms.amountIn === '1000000', sp.status)
  const r = await issue({ amount: '999999999999' }); clearRL()
  t('a $1 trillion amount → refused by the per-swap cap, no address', refused(r))
  const d = await issue({ amount: '0.000001' }); clearRL()
  t('a 1-micro-unit amount → refused (below minimum), no address', refused(d))
}

section('A2 address fuzzing (would the money go somewhere it can never come back from?)')
await freshEnv()
const ZW = '​', RLO = '‮'
const evmBad = [
  ['Cyrillic а homoglyph', EVM_ME.replace('a', 'а')], ['zero-width space inside', EVM_ME.slice(0, 10) + ZW + EVM_ME.slice(10)],
  ['trailing newline', EVM_ME + '\n'], ['RTL override', RLO + EVM_ME], ['leading space', ' ' + EVM_ME], ['41 hex', EVM_ME + 'a'],
  ['EIP-55 checksum broken', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'],
  ['the ZERO address (burn)', '0x0000000000000000000000000000000000000000'],
  ['precompile 0x…01 (burn)', '0x0000000000000000000000000000000000000001'],
  ['0x…dEaD burn address', '0x000000000000000000000000000000000000dEaD'],
  ['the USDC token contract itself', '0xaf88d065e77c8cc2239327c5edb3a432268e5831'],
]
for (const [why, a] of evmBad) {
  const r = await Q({ ...base, to: USDC_ARB, recipient: a, dry: true }); clearRL()
  t('EVM recipient: ' + why + ' → refused', r.status === 400 && r.j.field === 'recipient', r.status + ' ' + (r.j && r.j.error))
}
for (const [why, a] of [['zero address as REFUND', '0x0000000000000000000000000000000000000000'], ['dead address as REFUND', '0x000000000000000000000000000000000000dEaD']]) {
  const r = await Q({ ...base, refundTo: a, dry: true }); clearRL()
  t('EVM ' + why + ' → refused', r.status === 400 && r.j.field === 'refundTo', r.status + ' ' + (r.j && r.j.error))
}
for (const [why, a] of [['System Program (all-zero key)', '11111111111111111111111111111111'],
                        ['wSOL mint (a token mint, not a wallet)', 'So11111111111111111111111111111111111111112'],
                        ['SPL Token program', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
                        ['Associated Token program', 'ATokenGPvbdGVxr1b2hvZ9MGRXV1i8Xm6pXjkUzWcfb6']]) {
  const r = await Q({ ...base, recipient: a, dry: true }); clearRL()
  t('SOL recipient: ' + why + ' → refused', r.status === 400 && r.j.field === 'recipient', r.status + ' ' + (r.j && r.j.error))
}
for (const [why, a] of [['BTC burn 1111111111111111111114oLvT2', '1111111111111111111114oLvT2']]) {
  const r = await Q({ ...base, to: 'nep141:btc.omft.near', recipient: a, amount: '100', dry: true }); clearRL()
  t('BTC recipient: ' + why + ' → refused', r.status === 400 && r.j.field === 'recipient', r.status + ' ' + (r.j && r.j.error))
}
for (const [why, a] of [['Tron zero address T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb']]) {
  const tronUsdt = H.S && 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near'
  const r = await Q({ ...base, to: tronUsdt, recipient: a, dry: true }); clearRL()
  t('Tron recipient: ' + why + ' → refused', r.status === 400 && (r.j.field === 'recipient' || r.j.error === 'unsupported_to_asset'), r.status + ' ' + (r.j && r.j.error))
}
for (const a of [['x'], 12345, null, { a: 1 }, 'a'.repeat(5000)]) {
  const r = await Q({ ...base, recipient: a, dry: true }); clearRL()
  t('recipient of type ' + (Array.isArray(a) ? 'array' : typeof a) + ' → refused', r.status === 400 || r.status === 413, r.status)
}
{
  W().nearAccounts.add('near')
  const r = await issue({ from: USDC_BASE, to: WNEAR, recipient: 'Alice.near', amount: '50' }); clearRL()
  t('NEAR uppercase account → refused (accounts are lowercase)', refused(r) && (r.r || r.pv).j.field === 'recipient')
}

section('A3 asset / chain / prototype tricks')
await freshEnv()
for (const id of ['__proto__', 'constructor', 'toString', 'NEP141:SOL.OMFT.NEAR', 'nep141:xrp.omft.near', 'nep141:sol.omft.near ', '']) {
  const r = await Q({ ...base, to: id, dry: true }); clearRL()
  t('to=' + JSON.stringify(id) + ' → refused', r.status === 400 && r.j.error === 'unsupported_to_asset', r.status + ' ' + (r.j && r.j.error))
}
{
  const r = await call(S.quote.onRequestPost, new Request(SITE + '/api/intents/quote', { method: 'POST',
    headers: { cookie: (await import('./intents-harness.mjs')).session('paid@x.io'), origin: SITE, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: '{"__proto__":{"dry":false,"idempotencyKey":"aaaaaaaaaaaaaaaaaaaa"},"from":"' + USDC_BASE + '","to":"' + SOL + '","amount":"100","recipient":"' + SOL_ME + '","refundTo":"' + EVM_ME + '"}' }))
  t('__proto__ smuggling of dry:false → still treated as a preview', r.status === 200 && r.j.dry === true && noAddr(r.j), r.status)
}
for (const [scope, key] of [['chain', 'toString'], ['chain', '__proto__'], ['route', 'constructor>sol'], ['route', 'base>toString']]) {
  const r = await adminPost({ action: 'pause', scope, key, reason: 'x' })
  t(`admin pause ${scope} "${key}" (prototype name) → refused`, r.status === 400, r.status)
}
{
  const r = await adminPost({ action: 'limits', limits: JSON.parse('{"__proto__":{"maxTradeUsd":1e9},"maxTradeUsd":100}') })
  const eff = (await adminGet()).j.limits.effective.maxTradeUsd
  t('admin limits __proto__ pollution ignored', r.status === 200 && eff === 100 && ({}).maxTradeUsd === undefined, eff)
  await adminPost({ action: 'limits', limits: null })
}

section('A4 body / transport abuse')
await freshEnv()
const raw = (body, headers = {}) => call(S.quote.onRequestPost, new Request(SITE + '/api/intents/quote', { method: 'POST',
  headers: { cookie: H.session('paid@x.io'), origin: SITE, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body }))
t('JSON array body → 400', (await raw('[1,2,3]')).status === 400)
t('JSON string body → 400', (await raw('"hi"')).status === 400)
t('truncated JSON → 400', (await raw('{"from":')).status === 400)
t('2,000-deep nesting inside 4 KB → handled (400), no crash', [400].includes((await raw('['.repeat(2000) + ']'.repeat(2000))).status))
t('"dry":"false" (string) → stays a preview', await (async () => { clearRL(); const r = await raw(JSON.stringify({ ...base, dry: 'false' })); return r.status === 200 && r.j.dry === true })())
t('"dry":0 → stays a preview', await (async () => { clearRL(); const r = await raw(JSON.stringify({ ...base, dry: 0 })); return r.status === 200 && r.j.dry === true })())
{
  const big = 'x'.repeat(5_000_000)
  const t0 = Date.now()
  const r = await raw(JSON.stringify({ ...base, pad: big }), { 'content-length': String(5_000_020) })
  t('5 MB body with honest content-length → 413 before parsing', r.status === 413, r.status + ' ' + (Date.now() - t0) + 'ms')
}

section('A5 no accounts: forged swap tokens and rotated IPs (standalone desk)')
await freshEnv()
{
  const a = (await issue()).r.j, b = (await issue({ amount: '120' })).r.j
  const get = (id, token, ip = '10.9.9.9', extra = {}) => S.worker.fetch(new Request(SITE + '/api/swap?id=' + id, { headers: { 'cf-connecting-ip': ip, ...(token === undefined ? {} : { 'x-swap-token': token }), ...extra } }), S.envOf(ENV()), { waitUntil() {} })
  t('the real token opens the swap from ANY network (a phone on mobile data)', (await get(a.swap.id, a.token)).status === 200)
  t('a random 64-hex token → 404', (await get(a.swap.id, crypto.randomBytes(32).toString('hex'))).status === 404)
  t('swap A’s token presented for swap B → 404', (await get(b.swap.id, a.token)).status === 404)
  t('the token with one character changed → 404', (await get(a.swap.id, a.token.slice(0, 63) + (a.token[63] === '0' ? '1' : '0'))).status === 404)
  t('the token in the query string instead of the header → 404 (URLs end up in logs)', (await S.worker.fetch(new Request(SITE + '/api/swap?id=' + a.swap.id + '&token=' + a.token, { headers: { 'cf-connecting-ip': '10.9.9.9' } }), S.envOf(ENV()), { waitUntil() {} })).status === 404)
  t('no token → 404, the same answer as an id that does not exist', (await get(a.swap.id)).status === 404 && (await get(crypto.randomUUID(), a.token)).status === 404)
  t('a token minted under ANOTHER desk secret → 404', (await get(a.swap.id, await S.identity.swapToken('another-secret-0123456789abcdef0123456789', a.swap.id))).status === 404)
  t('a token is never written to the ledger (a database leak leaks no access)', !JSON.stringify(ENV().CLWA_CLUSTERS.raw.prepare('SELECT * FROM intents_swaps').all()).includes(a.token))
  t('…and no IP address is written to it either, only the keyed hash', !JSON.stringify(ENV().CLWA_CLUSTERS.raw.prepare('SELECT * FROM intents_swaps').all()).match(/10\.\d+\.\d+\.\d+/))
  const subm = (token) => S.worker.fetch(new Request(SITE + '/api/submit', { method: 'POST', headers: { 'cf-connecting-ip': '10.9.9.9', 'content-type': 'application/json', ...(token ? { 'x-swap-token': token } : {}) }, body: JSON.stringify({ id: a.swap.id, txHash: '0x' + 'ab'.repeat(32) }) }), S.envOf(ENV()), { waitUntil() {} })
  t('submit a tx hash for someone else’s swap without its token → 404, nothing sent to 1Click', (await subm(null)).status === 404 && W().calls.submit === 0)
  const list = async items => (await (await S.worker.fetch(new Request(SITE + '/api/swaps', { method: 'POST', headers: { 'cf-connecting-ip': '10.9.9.8', 'content-type': 'application/json' }, body: JSON.stringify({ items }) }), S.envOf(ENV()), { waitUntil() {} })).json())
  const forged = await list([{ id: a.swap.id, token: crypto.randomBytes(32).toString('hex') }, { id: b.swap.id, token: a.token }])
  t('swap list with forged tokens (random, and A’s token on B) → returns nothing', forged.ok && forged.swaps.length === 0, JSON.stringify(forged).slice(0, 200))
  const real = await list([{ id: a.swap.id, token: a.token }, { id: b.swap.id, token: b.token }])
  t('…and with the real tokens → exactly those two swaps', real.ok && real.swaps.length === 2 && new Set(real.swaps.map(s => s.id)).size === 2)
  // 30 items still fit the 4 KB body limit, so this reaches the item cap itself (a 500-item list never did).
  const flood = await list(Array.from({ length: 30 }, () => ({ id: a.swap.id, token: a.token })))
  t('a 30-item list (under the 4 KB limit) is cut to 20 lookups', flood.ok === true && flood.swaps.length === 20, JSON.stringify(flood).slice(0, 120))
}
{
  // One home or phone line gets a whole IPv6 /64: rotating inside it must not buy fresh budgets.
  await freshEnv()
  const qv = ip => S.worker.fetch(new Request(SITE + '/api/quote', { method: 'POST', headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json' }, body: JSON.stringify({ ...base, dry: true }) }), S.envOf(ENV()), { waitUntil() {} })
  const rs = []
  for (let i = 0; i < 60; i++) rs.push((await qv('2001:db8:1:2:' + (i + 1).toString(16) + '::' + (i * 7 + 3).toString(16))).status)
  t(`60 previews from 60 addresses in ONE IPv6 /64 → at most 40 pass the client budget (got ${rs.filter(s => s === 200).length})`, rs.filter(s => s === 200).length <= 40)
  t('a different /64 has its own budget', (await qv('2001:db8:1:3::1')).status === 200)
  t('compressed and full spellings of one /64 are one bucket', S.identity.ipPrefix('2001:db8:0:0:1::1') === S.identity.ipPrefix('2001:0db8:0000:0000:ffff:0:0:2'))
  t('an IPv4-mapped IPv6 address is the IPv4 address', S.identity.ipPrefix('::ffff:203.0.113.9') === '203.0.113.9')
}

section('A6 IDOR — someone else’s swap')
await freshEnv()
{
  const r = (await issue()).r; clearRL()
  const id = r.j.swap.id
  for (const probe of [id.toUpperCase(), id + "' OR '1'='1", "' OR 1=1--", '../' + id, id + '%00']) {
    const g = await swapGet(encodeURIComponent(probe), 'other@x.io')
    t('other member probing ' + JSON.stringify(probe.slice(0, 20)) + ' → 404', g.status === 404, g.status)
  }
  t('other member, exact id → 404 (same as nonexistent)', (await swapGet(id, 'other@x.io')).status === 404)
  const sub = await call(S.submit.onRequestPost, req('POST', '/api/intents/submit', { who: 'other@x.io', body: { id, txHash: '0x' + 'a'.repeat(64) } }))
  t('other member submitting a tx hash to my swap → 404', sub.status === 404)
  t('owner still sees it', (await swapGet(id)).status === 200)
}

section('A7 cross-site / same-site writes')
await freshEnv()
for (const [why, h] of [['evil origin', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }],
                        ['swap.cryptolwa.io (same-site, third-party bundle)', { origin: 'https://swap.cryptolwa.io', 'sec-fetch-site': 'same-site' }],
                        ['origin "null" (sandboxed iframe)', { origin: 'null', 'sec-fetch-site': 'cross-site' }],
                        ['no origin but sec-fetch-site cross-site', { 'sec-fetch-site': 'cross-site' }]]) {
  const r = await call(S.quote.onRequestPost, new Request(SITE + '/api/intents/quote', { method: 'POST', headers: { cookie: H.session('paid@x.io'), 'content-type': 'application/json', ...h }, body: JSON.stringify({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: '1' }) }))
  t('quote from ' + why + ' → 403', r.status === 403, r.status)
}
{
  const r = await call(S.submit.onRequestPost, new Request(SITE + '/api/intents/submit', { method: 'POST', headers: { cookie: H.session('paid@x.io'), 'content-type': 'application/json', origin: 'https://swap.cryptolwa.io', 'sec-fetch-site': 'same-site' }, body: '{}' }))
  t('submit from swap.cryptolwa.io → 403', r.status === 403, r.status)
}

section('A8 races against the caps (one member, many tabs, KV limiter is not atomic)')
// Real Cloudflare KV: reads and writes interleave across isolates and are not
// atomic. Model that, so ONLY the database can be what holds the caps.
function laggyKV() {
  const m = new Map(), tick = () => new Promise(r => setTimeout(r, 3))
  return { get: async k => { await tick(); return m.get(k) ?? null }, put: async (k, v) => { await tick(); m.set(k, v) }, delete: async k => { m.delete(k) }, _m: m }
}
const laggy = async () => { await freshEnv(); ENV().CLWA_SESSIONS = laggyKV() }
await laggy()
{
  const pv = await Q({ ...base, dry: true })
  W().quoteMode = 'slow'
  const many = await Promise.all(Array.from({ length: 20 }, () => Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })))
  const issued = many.filter(x => x.status === 200).length
  const rlPassed = many.filter(x => !(x.j && x.j.error === 'rate_limited')).length
  console.log(`    (the non-atomic rate limiter let ${rlPassed}/20 through — the caps must hold anyway)`)
  t(`20 simultaneous different-key requests → at most 5 open addresses (got ${issued})`, issued <= 5, JSON.stringify(many.map(x => x.j && x.j.error || x.status)))
}
await laggy()
{
  await adminPost({ action: 'limits', limits: { memberDailyUsd: 500, memberOpenSwaps: 50 } })
  const pv = await Q({ ...base, amount: '200', dry: true }); clearRL()
  W().quoteMode = 'slow'
  const many = await Promise.all(Array.from({ length: 10 }, () => Q({ ...base, amount: '200', dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })))
  const usd = ENV().CLWA_CLUSTERS.raw.prepare("SELECT COALESCE(SUM(usd_in),0) v FROM intents_swaps WHERE state='awaiting_deposit'").get().v
  t(`10 simultaneous $200 swaps vs a $500 daily cap → issued total ≤ $500 (got $${Math.round(usd)})`, usd <= 500, JSON.stringify(many.map(x => x.j && x.j.error || x.status)))
}
await laggy()
{
  await adminPost({ action: 'limits', limits: { globalDailyUsd: 450, memberOpenSwaps: 50 } })
  const pv = await Q({ ...base, amount: '200', dry: true })
  W().quoteMode = 'slow'
  const many = await Promise.all(['paid@x.io', 'other@x.io', 'paid@x.io', 'other@x.io', 'paid@x.io', 'other@x.io'].map(w => Q({ ...base, amount: '200', dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut }, w)))
  // Standalone desk: the desk-wide cap counts FUNDED swaps. Unpaid addresses from
  // anonymous clients must not be able to freeze the whole desk (design review).
  const unpaid = many.filter(x => x.status === 200).length
  t(`unpaid addresses cannot use up a $450 desk-wide cap: 6 × $200 unpaid all issued (got ${unpaid})`, unpaid === 6, JSON.stringify(many.map(x => x.j && x.j.error || x.status)))
  // Two of them get paid ($400 funded): the next $200 would take funded volume past $450.
  ENV().CLWA_CLUSTERS.raw.prepare("UPDATE intents_swaps SET state='deposit_seen', deposited = amount_in WHERE id IN (SELECT id FROM intents_swaps WHERE state='awaiting_deposit' LIMIT 2)").run()
  W().quoteMode = 'ok'
  const next = await Q({ ...base, amount: '200', dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut }, 'free@x.io')
  t('…but once $400 is FUNDED, a $200 swap that would pass $450 is refused (global_daily_cap)', next.status === 422 && next.j.error === 'global_daily_cap' && noAddr(next.j), next.status + ' ' + next.j?.error)
}

section('A9 replayed / reused payout transactions (the router lies about SUCCESS)')
await freshEnv()
{
  const a = await issueArb(); const sw = { ...a.j.swap, _who: 'paid@x.io' }
  const old = '0x' + 'aa'.repeat(32)
  W().receipts.set(old, payReceipt(EVM_ME, BigInt(sw.minAmountOut) * 10n, '0x50'))
  BLOCK_TS.set('0x50', Math.floor(Date.now() / 1000) - 30 * 86400)     // paid 30 days ago
  const s = await claimSuccess(sw, old)
  t('an OLD payment to the same wallet (before this swap existed) is NOT accepted as the payout', s.state !== 'settled', s.state + ' / ' + s.destVerified)
}
await freshEnv()
{
  const a = await issueArb(); const b = await issueArb()
  const shared = '0x' + 'bb'.repeat(32)
  W().receipts.set(shared, payReceipt(EVM_ME, BigInt(a.j.swap.minAmountOut) * 3n, '0x60'))
  BLOCK_TS.set('0x60', Math.floor(Date.now() / 1000) + 5)
  const s1 = await claimSuccess({ ...a.j.swap, _who: 'paid@x.io' }, shared)
  const s2 = await claimSuccess({ ...b.j.swap, _who: 'paid@x.io' }, shared)
  t('first swap settles on a fresh payout', s1.state === 'settled', s1.state)
  t('ONE payout tx cannot settle TWO swaps', s2.state !== 'settled', s2.state + ' / ' + s2.destVerified)
}
await freshEnv()
{
  // The live 1Click shape (first real swap): explorerUrl "" on every tx. The payout must still be verified.
  const a = await issueArb()
  const pay = '0x' + 'cc'.repeat(32)
  W().receipts.set(pay, payReceipt(EVM_ME, BigInt(a.j.swap.minAmountOut), '0x61'))
  BLOCK_TS.set('0x61', Math.floor(Date.now() / 1000) + 5)
  const s = await claimSuccess({ ...a.j.swap, _who: 'paid@x.io' }, pay, '')
  t('1Click names the payout with an EMPTY explorerUrl (live shape) → still verified and settled', s.state === 'settled' && (s.destTxs || []).some(x => x.hash === pay), s.state + ' / ' + s.destVerified + ' ' + JSON.stringify(s.destTxs))
}
await freshEnv()
{
  const a = await issueArb(); const sw = { ...a.j.swap, _who: 'paid@x.io' }
  W().status.set(sw.depositAddress, { status: 'PROCESSING', updatedAt: 'x', swapDetails: {}, quoteResponse: { quoteRequest: { recipient: EVM_ME2, refundTo: EVM_ME } } })
  setRowTime(sw.id, Date.now() - 60e3)
  const s = (await swapGet(sw.id)).j.swap
  const r = await row(sw.id)
  t('status feed claiming a DIFFERENT recipient is flagged critical at once', /status_recipient_mismatch/.test(r.flags || ''), r.flags)
}

section('A10 compromised router hands out a poisoned deposit address')
for (const [why, mut] of [
  ['deposit address = the USDC token contract on Base', q => { q.quote.depositAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
  ['deposit address = the zero address', q => { q.quote.depositAddress = '0x0000000000000000000000000000000000000000' }],
  ['deposit address = the member’s OWN refund wallet', q => { q.quote.depositAddress = EVM_ME }],
  ['amountOut 1,000× the market (bait)', q => { q.quote.amountOut = String(BigInt(q.quote.amountOut) * 1000n); q.quote.minAmountOut = String(BigInt(q.quote.amountOut) * 99n / 100n) }],
]) {
  await freshEnv()
  const pv = await Q({ ...base, dry: true })
  const orig = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const r = await orig(input, init)
    const u = String(typeof input === 'string' ? input : input.url)
    if (u.includes('/v0/quote') && init.body && JSON.parse(init.body).dry === false) { const j = await r.json(); mut(j); return new Response(JSON.stringify(j), { status: 201 }) }
    return r
  }
  const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: '1' })
  globalThis.fetch = orig
  t(why + ' → refused, never shown', r.status >= 400 && noAddr(r.j), r.status + ' ' + (r.j && (r.j.error + ' ' + (r.j.detail || ''))))
}

section('A11 malformed status feed')
await freshEnv()
{
  const a = (await issue()).r; const id = a.j.swap.id, dep = a.j.swap.depositAddress
  const feeds = [
    ['status as an array', ['SUCCESS']], ['status number', { status: 7 }], ['huge tx list', { status: 'PROCESSING', updatedAt: 'x', swapDetails: { originChainTxHashes: Array.from({ length: 5000 }, (_, i) => ({ hash: 'h' + i, explorerUrl: 'https://x/' + i })) } }],
    ['javascript: explorer url', { status: 'PROCESSING', updatedAt: 'x', swapDetails: { originChainTxHashes: [{ hash: 'h', explorerUrl: 'javascript:alert(1)' }] } }],
    ['amountOut not a number', { status: 'PROCESSING', updatedAt: 'x', swapDetails: { amountOut: '1e99' } }],
    ['a tx hash carrying markup', { status: 'PROCESSING', updatedAt: 'x', swapDetails: { originChainTxHashes: [{ hash: '<img src=x onerror=alert(1)>', explorerUrl: '' }, { hash: 'x"y', explorerUrl: '' }] } }],
  ]
  for (const [why, f] of feeds) {
    W().status.set(dep, f); setRowTime(id, Date.now() - 60e3); clearRL()
    const g = await swapGet(id)
    const s = g.j && g.j.swap
    t('status feed: ' + why + ' → handled, no crash, nothing unsafe stored', g.status === 200 && (s.originTxs || []).length <= 5
      && !(s.originTxs || []).some(x => (x.explorerUrl !== '' && !/^https:\/\//.test(x.explorerUrl)) || !/^[0-9A-Za-z]{1,120}$/.test(x.hash))
      && !/e99/.test(String(s.amountOutActual)), g.status + ' ' + JSON.stringify(s).slice(0, 160))
  }
}

section('A12 admin surface')
await freshEnv()
t('pause with a 5 KB reason is capped', await (async () => { await adminPost({ action: 'pause', scope: 'global', reason: 'x'.repeat(5000) }); return ((await adminGet()).j.controls.globalPaused || '').length < 400 })())
t('limits: negative / NaN / string values refused', (await adminPost({ action: 'limits', limits: { maxTradeUsd: -5 } })).status === 400 && (await adminPost({ action: 'limits', limits: { maxTradeUsd: 'NaN' } })).status === 400)

section('C1 round 3 — price provider outage (seen live: CoinGecko keyless 429)')
await freshEnv()
{
  W().cgDown = true                     // CoinGecko 503/429, DeFiLlama up
  clearRL(); const pv = await Q({ ...base, dry: true })
  clearRL(); const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })
  t('CoinGecko down, DeFiLlama up → still priced independently and issued', pv.j.terms.price.source === 'market' && r.status === 200 && W().calls.llama >= 1, r.status + ' ' + (r.j && r.j.error))
  const before = W().calls.cg + (W().calls.llama || 0)
  for (let i = 0; i < 10; i++) { clearRL(); await Q({ ...base, dry: true }) }
  t('10 more previews inside 30 s cost 0 extra price calls (cache)', W().calls.cg + (W().calls.llama || 0) === before, (W().calls.cg + (W().calls.llama || 0)) - before)
  S.io.__resetPriceCache(); W().cgDown = 'both'
  clearRL(); const r2 = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })
  t('both price sources down → no deposit address (fail closed)', r2.status === 422 && r2.j.error === 'unpriced' && noAddr(r2.j), r2.status)
}

section('B1 round 2 — what the chain says about the address')
await freshEnv()
{
  const TA = 'HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq'   // a REAL USDC token account (owner Tokenkeg…), read live
  W().solAccounts = { [TA]: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', executable: false, lamports: 2039280 },
                      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, lamports: 1 } }
  const r1 = await Q({ ...base, recipient: TA, dry: true }); clearRL()
  t('SOL recipient that is a TOKEN ACCOUNT → refused on the preview', r1.status === 400 && r1.j.error === 'recipient_is_token_account', r1.status + ' ' + (r1.j && r1.j.error))
  const r2 = await Q({ ...base, recipient: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', dry: true }); clearRL()
  t('SOL recipient that is an executable program → refused', r2.status === 400 && r2.j.error === 'recipient_unspendable', r2.status + ' ' + (r2.j && r2.j.error))
  const r3 = await Q({ from: SOL, to: USDC_BASE, amount: '1', recipient: EVM_ME, refundTo: TA, dry: true }); clearRL()
  t('SOL REFUND address that is a token account → refused', r3.status === 400 && r3.j.error === 'refund_is_token_account', r3.status + ' ' + (r3.j && r3.j.error))
  W().solDown = true
  const pv = await Q({ ...base, dry: true }); clearRL()
  const real = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: '1' }); clearRL()
  t('Solana nodes down: preview still works, real address NOT issued (fail closed)', pv.status === 200 && real.status === 503 && real.j.error === 'address_unchecked' && noAddr(real.j), pv.status + '/' + real.status)
  W().solDown = false
  W().evmCode = { [EVM_ME2]: '0x6080604052', [EVM_ME]: '0xef0100' + 'ab'.repeat(20) }
  const c = await Q({ ...base, to: USDC_ARB, recipient: EVM_ME2, dry: true }); clearRL()
  t('EVM recipient that is a contract → warned (not blocked: smart wallets are real)', c.status === 200 && c.j.terms.risk.warn.includes('recipient_is_contract') && c.j.terms.risk.allow, JSON.stringify(c.j && c.j.terms && c.j.terms.risk))
  const d = await Q({ ...base, to: USDC_ARB, recipient: EVM_ME, dry: true }); clearRL()
  t('EIP-7702 delegated wallet (0xef0100…) is treated as a wallet, no warning', d.status === 200 && !d.j.terms.risk.warn.includes('recipient_is_contract'))
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) { console.log('\nBREAKS:'); for (const b of breaks) console.log('  - ' + b) }
process.exit(fail ? 1 : 0)
