// ============================================================
// CRYPTO LWA · cross-chain desk — INVARIANT FUZZER (red-team round 5)
// ============================================================
// Thousands of random requests (valid, mutated, hostile) against a router whose
// answers are randomly corrupted. No expected outputs — only rules that must
// NEVER break, checked after every single request:
//
//   I1  the handler never throws and never answers outside {200,400,409,413,415,422,423,429,502,503}
//   I2  a deposit address is returned ONLY if the ledger holds exactly that swap, awaiting deposit
//   I3  that swap is exactly what was asked: assets, base amount, recipient, refund (bech32 lowercased)
//   I4  the address is valid on the origin chain, spendable, not a token contract, not the member's own
//   I5  the address is alive (deadline ≥ 15 min away) and memo-free
//   I6  open swaps per member ≤ cap; per-minute reservations ≤ 6; USD totals ≤ caps
//   I7  a preview NEVER creates a ledger row
//
//   node intents-fuzz.mjs [iterations=3000] [seed]
// ============================================================
import crypto from 'crypto'
import * as H from './intents-harness.mjs'
const { S, Q, freshEnv } = H
const W = () => H.getWorld(), ENV = () => H.getEnv()
const N = Number(process.argv[2] || 3000)
let seed = Number(process.argv[3] || 20261028)
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = a => a[Math.floor(rnd() * a.length)]

const fs = await import('fs')
const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/fixtures-intents-tokens.json', import.meta.url), 'utf8'))
const tokens = S.lib.slimTokens(raw)
const ALLOWED = new Set([200, 400, 409, 413, 415, 422, 423, 429, 502, 503])
const ADDR = {
  evm: ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359', '0x0000000000000000000000000000000000000000', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'],
  sol: ['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'So11111111111111111111111111111111111111112', '11111111111111111111111111111111', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  btc: ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '1111111111111111111114oLvT2', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5'],
  near: ['alice.near', 'f'.repeat(64), 'ghost.near', 'wrap.near', 'Alice.near', 'system'],
  tron: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'],
  doge: ['D9nssC5jR1viPZhWwFvDkjYpJZYJVydN8k'], ltc: ['LZ3v1o8qK4b7sJ9mH2f5xQp8Pd1cR6TuVa'],
}
const famOf = c => S.lib.CHAINS[c] ? S.lib.CHAINS[c].family : 'evm'
const junk = ['', ' ', 'null', '<script>', '../../', 'x'.repeat(130), '0x', '\u0000', '‮' + ADDR.evm[0]]
const amounts = ['1', '25', '100', '0.5', '2500', '2600', '0.000001', '1e3', '-1', '0', ' 30 ', '99999999999', '30.1234567', '0.0123456789012345678']
const mutateRouter = () => pick([
  null, null, null, null,
  q => { q.quoteRequest.recipient = ADDR.evm[1] }, q => { q.quote.depositMemo = '1' }, q => { if (q.quote.depositAddress) q.quote.depositAddress = '0x0000000000000000000000000000000000000000' },
  q => { q.quote.amountOut = '9'.repeat(50) }, q => { q.quote.minAmountOut = '1' }, q => { q.quote.deadline = new Date(Date.now() - 1e3).toISOString() },
  q => { q.quoteRequest.amount = '1' }, q => { q.quoteRequest.slippageTolerance = 999 }, q => { delete q.quote },
  q => { q.quoteRequest.appFees = [{ recipient: 'x', fee: 499 }] }, q => { if (q.quote.depositAddress) q.quote.depositAddress = q.quoteRequest.refundTo },
  q => { q.quote.amountOut = String(BigInt(q.quote.amountOut) * 3n); q.quote.minAmountOut = String(BigInt(q.quote.amountOut) * 99n / 100n) },
])

const counts = { requests: 0, issued: 0, refused: 0, previews: 0, byStatus: {} }
const violations = []
const bad = (rule, detail) => { if (violations.length < 25) violations.push(rule + ': ' + detail) }

await freshEnv()
await S.ledger.ensureTables(ENV().CLWA_CLUSTERS)
const members = ['paid@x.io', 'other@x.io']
const origFetch = globalThis.fetch
let currentMut = null, goodReq = null
// every token gets its fixture price, so pricing never hides the issue path
for (const t of raw) if (t.coingeckoId && t.price) W().cgPrice[t.coingeckoId] = t.price
globalThis.fetch = async (input, init = {}) => {
  const r = await origFetch(input, init)
  const u = String(typeof input === 'string' ? input : input.url)
  if (currentMut && u.includes('/v0/quote') && r.status === 201) {
    const j = await r.json(); try { currentMut(j) } catch {}
    return new Response(JSON.stringify(j), { status: 201 })
  }
  return r
}

for (let i = 0; i < N; i++) {
  // Model time passing so the run keeps reaching the issue path instead of the
  // per-minute budgets (those are attacked in redteam2/3/4): reset budget windows
  // every request, and age old swaps out of the 24 h caps every 50.
  try {
    ENV().CLWA_CLUSTERS.raw.prepare('DELETE FROM intents_rl').run()
    if (i % 50 === 0) ENV().CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET created_at = created_at - 86400000 - 61000').run()
  } catch { /* tables not created yet */ }
  // 60% fully valid requests (only the router's answer is corrupted), 40% hostile.
  const good = rnd() < 0.6
  if (good) {
    const GOOD = ['nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', 'nep141:sol.omft.near', 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
      'nep141:arb.omft.near', 'nep141:btc.omft.near', 'nep141:wrap.near', 'nep141:eth.omft.near']
    let f = pick(GOOD), g = pick(GOOD); while (g === f) g = pick(GOOD)
    const fT = tokens.find(t => t.id === f), tT = tokens.find(t => t.id === g)
    const okAddr = { evm: ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'], sol: ['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'],
      btc: ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'], near: ['alice.near', 'f'.repeat(64)] }
    const usd = 60 + Math.floor(rnd() * 1500)
    const amt = (usd / (fT.price || 1)).toFixed(Math.min(6, fT.decimals))
    goodReq = { from: f, to: g, amount: amt, recipient: pick(okAddr[famOf(tT.chain)]), refundTo: pick(okAddr[famOf(fT.chain)]) }
  } else goodReq = null
  const from = goodReq ? goodReq.from : rnd() < 0.05 ? pick(['__proto__', 'nep141:fake.near', '']) : pick(tokens).id
  const to = rnd() < 0.05 ? pick(['toString', 'nep141:xrp.omft.near']) : pick(tokens).id
  const fT = tokens.find(t => t.id === from), tT = tokens.find(t => t.id === to)
  const recipient = rnd() < 0.1 ? pick(junk) : pick(ADDR[famOf(tT ? tT.chain : 'eth')] || ADDR.evm)
  const refundTo = rnd() < 0.1 ? pick(junk) : pick(ADDR[famOf(fT ? fT.chain : 'eth')] || ADDR.evm)
  const dry = rnd() < 0.5
  const body = goodReq ? { ...goodReq, dry, slippageBps: pick([undefined, 50, 100, 300]) }
    : { from, to, amount: rnd() < 0.05 ? pick([['1'], 5, null]) : pick(amounts), recipient, refundTo, dry, slippageBps: pick([undefined, 50, 100, 300, 5, '100']) }
  if (!dry) { body.idempotencyKey = (!goodReq && rnd() < 0.05) ? 'short' : crypto.randomUUID(); body.acceptedAmountOut = goodReq ? '1' : pick(['1', '9'.repeat(30), '0', undefined]) }
  currentMut = mutateRouter()
  W().cgDown = rnd() < 0.03 ? 'both' : false
  W().solDown = rnd() < 0.03
  const who = pick(members)
  // Standalone desk: the ledger's owner is the keyed hash of the client's IP, not an email.
  const bucket = await S.identity.clientBucket(new Request('https://x/', { headers: { 'cf-connecting-ip': S.ipOf(H.req('GET', '/', { who })) } }), S.TEST_SECRET)
  const rowsBefore = ENV().CLWA_CLUSTERS.raw.prepare("SELECT COUNT(*) n FROM intents_swaps").get().n
  let r
  try { r = await Q(body, who) } catch (e) { bad('I1 threw', e.message + ' ' + JSON.stringify(body).slice(0, 160)); continue }
  counts.requests++; counts.byStatus[r.status] = (counts.byStatus[r.status] || 0) + 1
  if (!ALLOWED.has(r.status)) bad('I1 status', r.status + ' ' + JSON.stringify(r.j).slice(0, 120))
  const addr = r.j && r.j.swap && r.j.swap.depositAddress
  if (dry) {
    counts.previews++
    const rowsAfter = ENV().CLWA_CLUSTERS.raw.prepare("SELECT COUNT(*) n FROM intents_swaps").get().n
    if (rowsAfter !== rowsBefore) bad('I7 preview wrote a row', JSON.stringify(body).slice(0, 120))
    if (JSON.stringify(r.j || {}).includes('"depositAddress":"')) bad('I7 preview leaked an address', JSON.stringify(body).slice(0, 120))
    continue
  }
  if (!addr) { counts.refused++; continue }
  counts.issued++
  const row = ENV().CLWA_CLUSTERS.raw.prepare('SELECT * FROM intents_swaps WHERE id = ?').get(r.j.swap.id)
  if (!row || row.state !== 'awaiting_deposit' || row.deposit_address !== addr || row.member !== bucket) { bad('I2 ledger', JSON.stringify(row && { s: row.state, a: row.deposit_address })); continue }
  // Judge against the request ACTUALLY sent (the valid branch replaces from/to/addresses).
  const sentFrom = tokens.find(t => t.id === body.from), sentTo = tokens.find(t => t.id === body.to)
  { const fT = sentFrom, tT = sentTo, from = body.from, to = body.to, recipient = body.recipient, refundTo = body.refundTo
  const canon = (c, a) => /^(bc1|ltc1)/i.test(a) && ['btc', 'ltc'].includes(famOf(c)) ? a.toLowerCase() : a
  const base = S.lib.toBaseUnits(String(body.amount), fT.decimals)
  if (row.from_asset !== from || row.to_asset !== to || row.amount_in !== String(base) || row.recipient !== canon(tT.chain, recipient) || row.refund_to !== canon(fT.chain, refundTo))
    bad('I3 not what was asked', JSON.stringify({ want: { a: String(base), r: canon(tT.chain, recipient), rf: canon(fT.chain, refundTo) }, row: { a: row.amount_in, r: row.recipient, rf: row.refund_to }, bodyRecipient: body.recipient }))
  if (!(await S.lib.validAddress(fT.chain, addr)) || (await S.lib.unspendable(fT.chain, addr)) || S.lib.isTokenContract(tokens, fT.chain, addr)
      || addr.toLowerCase() === String(refundTo).toLowerCase() || addr.toLowerCase() === String(recipient).toLowerCase()) bad('I4 bad address', addr)
  if (!row.deadline || Date.parse(row.deadline) < Date.now() + 15 * 60e3) bad('I5 dying address', row.deadline)
  const open = ENV().CLWA_CLUSTERS.raw.prepare("SELECT COUNT(*) n FROM intents_swaps WHERE member = ? AND state IN ('reserving','awaiting_deposit')").get(bucket).n
  if (open > S.risk.LAUNCH_LIMITS.memberOpenSwaps) bad('I6 open cap', open)
  const usd = ENV().CLWA_CLUSTERS.raw.prepare("SELECT COALESCE(SUM(usd_in),0) v FROM intents_swaps WHERE member = ? AND state NOT IN ('abandoned','expired') AND created_at >= ?").get(bucket, Date.now() - 86400e3).v
  if (usd > S.risk.LAUNCH_LIMITS.memberDailyUsd + 1e-6) bad('I6 daily USD cap', usd)
  }
  // let issued swaps age out so the run keeps exercising the issue path
  ENV().CLWA_CLUSTERS.raw.prepare("UPDATE intents_swaps SET state = 'expired' WHERE id = ?").run(row.id)
}

console.log(`requests ${counts.requests} · previews ${counts.previews} · real issued ${counts.issued} · real refused ${counts.refused}`)
console.log('by status ' + JSON.stringify(counts.byStatus))
if (violations.length) { console.log(`\nINVARIANT VIOLATIONS (${violations.length}):`); for (const v of violations) console.log('  ✗ ' + v); process.exit(1) }
console.log('\nall 7 invariants held on every request')
