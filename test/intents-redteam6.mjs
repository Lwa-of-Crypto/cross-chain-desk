// ============================================================
// CRYPTO LWA · cross-chain desk — RED TEAM ROUND 10: the OPERATOR side
// ============================================================
// Production breaks most often through configuration, not code. The cron worker's
// own comments record an outage from PowerShell piping a BOM + newline into a
// secret. Attacked here: kill-switch spellings, secrets with invisible bytes, a
// whitespace API key, bad JSON overrides, contradictory limits, the fee path,
// and two reconcile passes at the same instant. BROKE = a break.
//
//   node intents-redteam6.mjs
// ============================================================
import crypto from 'crypto'
import * as H from './intents-harness.mjs'
const { S, Q, issue, swapGet, reconcile, adminPost, adminGet, freshEnv, row, setRowTime, base, SITE, call } = H
const W = () => H.getWorld(), ENV = () => H.getEnv()

let pass = 0, fail = 0
const breaks = []
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  safe   ' + name) }
  else { fail++; breaks.push(name); console.log('  BROKE  ' + name + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const section = s => console.log('\n[' + s + ']')

section('O1 kill-switch spellings an owner would actually type')
for (const v of ['0', 'false', 'FALSE', 'off', 'Off', 'no', ' 0 ', '0\n', '﻿0', 'disabled']) {
  await freshEnv({ INTENTS_ENABLED: v })
  const r = await Q({ ...base, dry: true })
  t(`INTENTS_ENABLED=${JSON.stringify(v)} → desk is OFF`, r.status === 503, r.status)
}
for (const v of ['1', 'true', 'on', '', undefined]) {
  await freshEnv(v === undefined ? {} : { INTENTS_ENABLED: v })
  const r = await Q({ ...base, dry: true })
  t(`INTENTS_ENABLED=${JSON.stringify(v)} → desk is ON`, r.status === 200, r.status)
}

section('O2 secrets with invisible bytes (PowerShell piping: BOM + CRLF)')
// Standalone desk: the secrets are DESK_SECRET (tokens) and ADMIN_TOKEN (operator API).
{
  const S1 = 'desk-secret-0123456789abcdef0123456789'
  await freshEnv({ DESK_SECRET: '﻿' + S1 + '\r\n' })
  const a = (await issue()).r.j
  const want = await S.identity.swapToken(S1, a.swap.id)
  t('DESK_SECRET stored with BOM + CRLF issues the same tokens as the clean secret', a.token === want)
  const adminWith = (stored, sent) => S.worker.fetch(new Request(SITE + '/api/admin', { headers: { 'x-admin-token': sent } }), S.envOf({ ...ENV(), ADMIN_TOKEN: stored }), { waitUntil() {} })
  const A = 'admin-token-0123456789abcdef0123456789'
  t('ADMIN_TOKEN stored with BOM + CRLF still matches a clean header', (await adminWith('﻿' + A + '\r\n', A)).status === 200)
  t('…and a wrong admin token → 404', (await adminWith(A, A.slice(0, -1) + 'x')).status === 404)
  t('an ADMIN_TOKEN that is only whitespace counts as UNSET: the admin API does not exist (404), even for an empty header', (await adminWith(' '.repeat(40), '')).status === 404 && (await adminWith(' '.repeat(40), ' '.repeat(40))).status === 404)
  t('an ADMIN_TOKEN shorter than 32 chars is refused as unset, even when the header matches it', (await adminWith('short-admin-token', 'short-admin-token')).status === 404)
}
{
  await freshEnv({ INTENTS_API_KEY: 'jwt-abc\r\n' })
  let sent = null
  const orig = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    if (String(typeof input === 'string' ? input : input.url).includes('1click')) {
      const h = init.headers || {}
      for (const [k, v] of Object.entries(h)) if (/[\r\n]/.test(String(v))) throw new TypeError('Invalid header value')   // what fetch() really does
      if (h['x-api-key']) sent = h['x-api-key']
    }
    return orig(input, init)
  }
  const r = await Q({ ...base, dry: true })
  globalThis.fetch = orig
  t('INTENTS_API_KEY with a trailing CRLF does not take the desk down (key trimmed)', r.status === 200 && sent === 'jwt-abc', r.status + ' sent=' + JSON.stringify(sent))
}

section('O3 overrides that are wrong')
await freshEnv({ INTENTS_LIMITS: '{maxTradeUsd: 100' })
t('INTENTS_LIMITS with broken JSON → launch limits, desk still works', (await Q({ ...base, dry: true })).status === 200 && (await adminGet()).j.limits.effective.maxTradeUsd === S.risk.LAUNCH_LIMITS.maxTradeUsd)
await freshEnv({ INTENTS_LIMITS: JSON.stringify({ maxTradeUsd: '50' }) })
t('INTENTS_LIMITS with a numeric STRING ("50") is honoured', (await adminGet()).j.limits.effective.maxTradeUsd === 50)
await freshEnv()
{
  const r = await adminPost({ action: 'limits', limits: { minTradeUsd: 900, maxTradeUsd: 100 } })
  const eff = (await adminGet()).j.limits.effective
  t('admin sets min > max → refused, not silently half-applied', r.status === 400 && eff.minTradeUsd <= eff.maxTradeUsd, JSON.stringify({ status: r.status, eff: { min: eff.minTradeUsd, max: eff.maxTradeUsd } }))
}
for (const v of ['30 ', '0x1e', '3e1', '30.5', '-30', '1000']) {
  const f = S.lib.feeCfgFrom({ INTENTS_FEE_BPS: v, INTENTS_FEE_RECIPIENT: 'cryptolwa.near' })
  const want = ['30 '].includes(v) ? 30 : 0
  t(`INTENTS_FEE_BPS=${JSON.stringify(v)} → ${want ? 'fee 30' : 'fee OFF (only plain whole numbers 1–100)'}`, f.feeBps === want, f.feeBps)
}

section('O4 the fee path switched on')
await freshEnv({ INTENTS_FEE_BPS: '30', INTENTS_FEE_RECIPIENT: 'cryptolwa.near' })
{
  const pv = await Q({ ...base, dry: true })
  t('fee on: 1Click is asked for exactly our fee, and the member sees ours + 1Click’s', pv.status === 200 && pv.j.terms.fees.oursBps === 30 && pv.j.terms.fees.platformBps === 20
    && JSON.stringify(W().lastQuoteBody.appFees) === '[{"recipient":"cryptolwa.near","fee":30}]', JSON.stringify(pv.j.terms && pv.j.terms.fees))
  const orig = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const r = await orig(input, init)
    if (String(typeof input === 'string' ? input : input.url).includes('/v0/quote')) { const j = await r.json(); j.quoteRequest.appFees = j.quoteRequest.appFees.map(f => f.recipient === 'cryptolwa.near' ? { ...f, recipient: 'attacker.near' } : f); return new Response(JSON.stringify(j), { status: 201 }) }
    return r
  }
  const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: '1' })
  globalThis.fetch = orig
  t('router redirects OUR fee to another account → refused, no address', r.status === 502 && r.j.detail === 'echo_fee')
}

section('O5 two reconcile passes at the same instant (cron + the admin button)')
await freshEnv()
{
  const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad = a => '0x' + '0'.repeat(24) + a.slice(2)
  const ids = []
  for (let i = 0; i < 4; i++) {
    try { const d = ENV().CLWA_CLUSTERS.raw; d.prepare('DELETE FROM intents_rl').run(); d.prepare('UPDATE intents_swaps SET created_at = created_at - 61000').run() } catch {}
    const sw = (await issue({ to: H.USDC_ARB, recipient: H.EVM_ME, amount: '100' })).r.j.swap
    const X = '0x' + crypto.randomBytes(32).toString('hex')
    W().receipts.set(X, { status: '0x1', blockNumber: '0x1', logs: [{ address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', topics: [T0, pad(H.EVM_ME2), pad(H.EVM_ME)], data: '0x' + BigInt(sw.minAmountOut).toString(16).padStart(64, '0') }] })
    W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.minAmountOut, destinationChainTxHashes: [{ hash: X, explorerUrl: 'https://arbiscan.io/tx/' + X }] } })
    ids.push(sw.id)
  }
  ENV().CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET created_at = created_at - 3600000, updated_at = ?').run(Date.now() - 60e3)
  W().statusDelay = 15
  await Promise.all([reconcile(), reconcile(), adminPost({ action: 'reconcile' }), ...ids.map(id => swapGet(id))])
  W().statusDelay = 0
  // A verification that did not fit a pass's call budget waits for the next one (rounds 18-19); what
  // this case proves is that concurrent passes never settle a swap twice.
  await reconcile()
  const states = await Promise.all(ids.map(row))
  const ev = ENV().CLWA_CLUSTERS.raw.prepare("SELECT swap_id, COUNT(*) n FROM intents_events WHERE kind='state' AND detail LIKE '%\"to\":\"settled\"%' GROUP BY swap_id").all()
  t('every swap settled exactly once', states.every(s => s.state === 'settled') && ev.length === 4 && ev.every(e => e.n === 1), JSON.stringify({ s: states.map(s => s.state), ev }))
}

section('O8 an operator who rotates DESK_SECRET (standalone desk)')
{
  await freshEnv({ DESK_SECRET: 'old-secret-0123456789abcdef0123456789' })
  const a = (await issue()).r.j
  ENV().DESK_SECRET = 'new-secret-0123456789abcdef0123456789'
  const r = await S.worker.fetch(new Request(SITE + '/api/swap?id=' + a.swap.id, { headers: { 'x-swap-token': a.token, 'cf-connecting-ip': '10.1.1.1' } }), S.envOf(ENV()), { waitUntil() {} })
  t('after a secret rotation, an old token no longer opens the swap (rotation revokes every token)', r.status === 404)
  const rows = ENV().CLWA_CLUSTERS.raw.prepare("SELECT state FROM intents_swaps WHERE id = ?").get(a.swap.id)
  t('…but the swap itself is untouched and still reconciled', rows && rows.state === 'awaiting_deposit')
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) { console.log('\nBREAKS:'); for (const b of breaks) console.log('  - ' + b) }
process.exit(fail ? 1 : 0)
