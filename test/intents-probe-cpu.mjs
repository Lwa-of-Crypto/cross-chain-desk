// PROBE (not pass/fail): CPU time per request path, measured in Node with the outside
// world faked. Workers Free allows 10 ms CPU per request (developers.cloudflare.com/
// workers/platform/limits, read). Node's SQLite is in-process, so D1 work is
// counted here as CPU although in production it is I/O: these numbers are an UPPER bound.
import crypto from 'crypto'
import * as H from './intents-harness.mjs'
const { S, Q, swapGet, freshEnv, base, call, req } = H

const cpu = async fn => { const a = process.cpuUsage(); await fn(); const d = process.cpuUsage(a); return (d.user + d.system) / 1000 }
// Windows' process CPU clock ticks every 15.6 ms, so each path is run n times under ONE
// measurement and the total divided by n (the average, not a per-request percentile).
async function measure(label, fn, n = 60) {
  for (let i = 0; i < 3; i++) await fn(i)           // warm (JIT, caches)
  const total = await cpu(async () => { for (let i = 0; i < n; i++) await fn(i + 3) })
  console.log(`${label.padEnd(52)} avg ${(total / n).toFixed(2)} ms CPU  (${n} runs, ${total.toFixed(0)} ms)`)
}
await freshEnv()
const ip = i => `10.80.${i % 250}.${(i >> 8) % 250 + 1}`
const asIp = (i, body) => call(S.quote.onRequestPost, req('POST', '/api/quote', { body, who: null, headers: { 'cf-connecting-ip': ip(i) } }))
await measure('dry preview (USDC Base → SOL)', i => asIp(i, { ...base, amount: String(20 + (i % 50)), dry: true }))
await measure('dry preview to a BTC bech32 address', i => asIp(i, { ...base, to: 'nep141:btc.omft.near', recipient: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: String(60 + (i % 50)), dry: true }))
await measure('junk preview (refused at validation)', i => asIp(i, { dry: true, from: 'x', to: 'y', amount: '1', recipient: 'z', refundTo: 'w' }))
const issued = []
await measure('real issue (preview + address)', async i => {
  const pv = await asIp(i + 1000, { ...base, amount: String(20 + (i % 50)), dry: true })
  const r = await asIp(i + 1000, { ...base, amount: String(20 + (i % 50)), dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })
  if (r.j?.swap) issued.push({ i: i + 1000, id: r.j.swap.id, token: r.j.token })
})
await measure('swap poll (token check + refresh)', async i => {
  const s = issued[i % issued.length]
  await S.worker.fetch(new Request('https://d.test/api/swap?id=' + s.id, { headers: { 'cf-connecting-ip': ip(s.i), 'x-swap-token': s.token } }), S.envOf(H.getEnv()), { waitUntil() {} })
})
const items = issued.slice(0, 20).map(s => ({ id: s.id, token: s.token }))
await measure('"my swaps" list, 20 items (20 HMAC checks)', i => S.worker.fetch(new Request('https://d.test/api/swaps', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip(5000 + i) }, body: JSON.stringify({ items }) }), S.envOf(H.getEnv()), { waitUntil() {} }))
await measure('"my swaps" list, 20 FORGED items', i => S.worker.fetch(new Request('https://d.test/api/swaps', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip(6000 + i) }, body: JSON.stringify({ items: items.map(x => ({ id: x.id, token: 'f'.repeat(64) })) }) }), S.envOf(H.getEnv()), { waitUntil() {} }))
H.getEnv().CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET updated_at = 0').run()
await measure('reconcile pass', () => H.reconcile(), 10)
