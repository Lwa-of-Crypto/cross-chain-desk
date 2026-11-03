// ============================================================
// CRYPTO LWA · cross-chain desk — RED TEAM ROUND 7+ ("break it down to machine language")
// ============================================================
// Byte / encoding / protocol level: Bitcoin consensus rules (future segwit
// versions are ANYONE-CAN-SPEND), base58/bech32 canonical forms, JSON parser
// quirks (duplicate keys, lone surrogates, BOM, NUL), Date parser quirks,
// numeric encodings (hex, exponent, -0, float noise), charset/content-type
// tricks, and how upstream bytes are trusted. BROKE = a break.
//
//   node intents-redteam5.mjs
// ============================================================
import crypto from 'crypto'
import * as H from './intents-harness.mjs'
const { S, Q, call, freshEnv, base, SITE, USDC_BASE, EVM_ME } = H
const W = () => H.getWorld()
const BTC = 'nep141:btc.omft.near'

let pass = 0, fail = 0
const breaks = []
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  safe   ' + name) }
  else { fail++; breaks.push(name); console.log('  BROKE  ' + name + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const section = s => console.log('\n[' + s + ']')
const noAddr = j => !/"depositAddress":"[^"]/.test(JSON.stringify(j || {}))

// independent bech32/bech32m encoder (BIP-173/350)
function bech32(hrp, ver, prog, m) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  const pm = vals => { let c = 1; for (const v of vals) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= G[i] } return c >>> 0 }
  const conv = []; let acc = 0, bits = 0
  for (const b of prog) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; conv.push((acc >> bits) & 31) } }
  if (bits) conv.push((acc << (5 - bits)) & 31)
  const data = [ver, ...conv]
  const exp = [...hrp].map(c => c.charCodeAt(0) >> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31))
  const mod = pm(exp.concat(data, [0, 0, 0, 0, 0, 0])) ^ (m ? 0x2bc830a3 : 1)
  const chk = []; for (let i = 0; i < 6; i++) chk.push((mod >> (5 * (5 - i))) & 31)
  return hrp + '1' + data.concat(chk).map(d => 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'[d]).join('')
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const b58 = buf => { let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0')), s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n } for (const b of buf) { if (b === 0) s = '1' + s; else break } return s }
const sha = b => crypto.createHash('sha256').update(b).digest()
const b58c = p => b58(Buffer.concat([p, sha(sha(p)).subarray(0, 4)]))

// ═══════════════════════════════════════════════════════════════════════
section('P1 Bitcoin consensus: outputs anyone can spend')
for (const [why, addr] of [
  ['segwit v2 (bech32m, 32-byte program) — anyone-can-spend today', bech32('bc', 2, crypto.randomBytes(32), true)],
  ['segwit v16 (2-byte program) — anyone-can-spend', bech32('bc', 16, crypto.randomBytes(2), true)],
  ['segwit v1 with a 20-byte program (not taproot) — anyone-can-spend', bech32('bc', 1, crypto.randomBytes(20), true)],
  ['segwit v1 with a 40-byte program — anyone-can-spend', bech32('bc', 1, crypto.randomBytes(40), true)],
  ['Litecoin segwit v3', bech32('ltc', 3, crypto.randomBytes(32), true)],
]) {
  const chain = addr.startsWith('ltc') ? 'ltc' : 'btc'
  t(why + ' → refused', !(await S.lib.validAddress(chain, addr)) || (await S.lib.unspendable(chain, addr)), addr.slice(0, 20))
}
t('taproot v1 32-byte (real) → still accepted', await S.lib.validAddress('btc', bech32('bc', 1, crypto.randomBytes(32), true)) && !(await S.lib.unspendable('btc', bech32('bc', 1, Buffer.alloc(32, 7), true))))
t('v0 P2WPKH 20 bytes → accepted', await S.lib.validAddress('btc', bech32('bc', 0, crypto.randomBytes(20), false)))

section('P2 base58 canonical form')
{
  const good = b58c(Buffer.concat([Buffer.from([0]), crypto.randomBytes(20)]))
  t('P2PKH with one extra leading "1" (an extra zero byte) → refused', !(await S.lib.validAddress('btc', '1' + good)))
  t('valid checksum but a 22-byte payload → refused', !(await S.lib.validAddress('btc', b58c(Buffer.concat([Buffer.from([0]), crypto.randomBytes(21)])))))
  t('Tron with 0x41 but 19-byte hash → refused', !(await S.lib.validAddress('tron', b58c(Buffer.concat([Buffer.from([0x41]), crypto.randomBytes(19)])))))
  t('SOL key with leading zero bytes (encoded as leading 1s) → accepted when 32 bytes', await S.lib.validAddress('sol', b58(Buffer.concat([Buffer.alloc(3), crypto.randomBytes(29).fill(9, 0, 1)]))))
}

section('P3 JSON parser quirks')
await freshEnv()
const rawQ = (body, headers = {}) => call(S.quote.onRequestPost, new Request(SITE + '/api/intents/quote', { method: 'POST',
  headers: { cookie: H.session('paid@x.io'), origin: SITE, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body }))
const J = o => JSON.stringify(o).slice(1, -1)
{
  const r = await rawQ('{' + J({ ...base }) + ',"dry":false,"dry":true}')
  t('duplicate "dry" keys (false then true) → the parser keeps the last → preview, no address', r.status === 200 && r.j.dry === true && noAddr(r.j))
  const r2 = await rawQ('{' + J(base) + ',"recipient":"' + EVM_ME + '"}')
  t('duplicate "recipient" (valid SOL, then an EVM address) → judged on the value actually used (refused)', r2.status === 400 && r2.j.field === 'recipient')
  for (const [why, rec] of [['lone surrogate', '\ud800' + base.recipient.slice(1)], ['NUL byte', base.recipient + '\u0000'], ['BOM prefix', '﻿' + base.recipient],
                           ['LRM from a messaging app', '‎' + base.recipient], ['fullwidth digits', base.recipient.replace(/[1-9]/, c => String.fromCharCode(c.charCodeAt(0) + 0xfee0))]]) {
    const r3 = await rawQ(JSON.stringify({ ...base, recipient: rec, dry: true }))
    t('recipient with ' + why + ' → refused, no crash', r3.status === 400 && r3.j.field === 'recipient', r3.status)
  }
  // Proven, not assumed: the WHATWG UTF-8 decoder behind Request.text() strips a leading
  // BOM, so the body is byte-for-byte the same JSON — it must behave exactly like it.
  { const a = await rawQ('﻿' + JSON.stringify({ ...base, dry: true })), b = await rawQ(JSON.stringify({ ...base, dry: true }))
    t('UTF-8 BOM before the JSON body → treated exactly like the same JSON (decoder strips it)', a.status === b.status && a.j.dry === b.j.dry && noAddr(a.j)) }
  t('UTF-16 body declared as charset=utf-16 → clean 4xx, no crash', [400, 415].includes((await call(S.quote.onRequestPost, new Request(SITE + '/api/intents/quote', { method: 'POST',
    headers: { cookie: H.session('paid@x.io'), origin: SITE, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json; charset=utf-16' }, body: Buffer.from(JSON.stringify({ ...base, dry: true }), 'utf16le') }))).status))
  t('1e400 amount (JSON number → Infinity) → refused', (await rawQ('{' + J({ ...base }).replace(/"amount":"100"/, '"amount":1e400') + ',"dry":true}')).status === 400)
}

section('P4 numeric encodings')
await freshEnv()
for (const [why, amt, ok] of [['leading zeros 0100', '0100', true], ['-0', '-0', false], ['hex 0x64', '0x64', false], ['exponent 1e2', '1e2', false], ['trailing dot 100.', '100.', false],
                               ['31 integer digits', '1'.repeat(31), false], ['decimal comma 100,5', '100,5', false], ['Arabic-Indic ١٠٠', '١٠٠', false], ['plus sign +100', '+100', false]]) {
  H.getEnv().CLWA_CLUSTERS.raw.prepare?.('SELECT 1')
  const r = await Q({ ...base, amount: amt, dry: true })
  t(`amount ${why} → ${ok ? 'read exactly' : 'refused'}`, ok ? (r.status === 200 && r.j.terms.amountIn === '100000000') : (r.status === 400 && r.j.error === 'bad_amount'), r.status + ' ' + (r.j && (r.j.error || r.j.terms && r.j.terms.amountIn)))
}
for (const [why, slip, ok] of [['"100" (string)', '100', true], ['100.0', 100.0, true], ['1e2', 1e2, true], ['100.0000001', 100.0000001, false], ['NaN', NaN, false], ['true', true, false], ['[100]', [100], false],
                                // strings are digits only (mutation campaign, round 11): Number() would read all of these as 100
                                ['"0x64" (hex string)', '0x64', false], ['"1e2" (exponent string)', '1e2', false], ['" 100" (padded string)', ' 100', false],
                                ['"100\\n"', '100\n', false], ['"+100"', '+100', false], ['"100.0" (string)', '100.0', false], ['"" (empty string)', '', false]]) {
  const r = await Q({ ...base, slippageBps: slip, dry: true })
  t(`slippage ${why} → ${ok ? 'accepted as 100' : 'refused'}`, ok ? r.status === 200 : (r.status === 400 && r.j.error === 'bad_slippage'), r.status + ' ' + (r.j && r.j.error))
}

section('P5 Date parser quirks in the router’s deadline')
for (const [why, dl, ok] of [['year-only "1999" (parses as 1 Jan 1999 — past)', '1999', false], ['"1970-01-01"', '1970-01-01', false], ['garbage', 'soon', false],
                              ['RFC-2822 three days out', new Date(Date.now() + 3 * 86400e3).toUTCString(), true], ['max JS date +275760', '+275760-09-13T00:00:00.000Z', true],
                              ['numeric timestamp as string', String(Date.now() + 86400e3), false], ['ISO with a lying offset (already past in UTC)', new Date(Date.now() - 3600e3).toISOString().replace('Z', '-00:30'), false]]) {
  await freshEnv()
  const orig = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const r = await orig(input, init)
    if (String(typeof input === 'string' ? input : input.url).includes('/v0/quote') && init.body && JSON.parse(init.body).dry === false) { const j = await r.json(); j.quote.deadline = dl; return new Response(JSON.stringify(j), { status: 201 }) }
    return r
  }
  const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: '1' })
  globalThis.fetch = orig
  t(`router deadline ${why} → ${ok ? 'issued' : 'refused'}`, ok ? r.status === 200 : (r.status >= 400 && noAddr(r.j)), r.status + ' ' + (r.j && (r.j.error + ' ' + (r.j.detail || ''))))
}

section('P6 bytes the router controls')
for (const [why, mut] of [
  ['deposit address with a trailing space', q => { q.quote.depositAddress = q.quote.depositAddress + ' ' }],
  ['deposit address 0X-prefixed', q => { q.quote.depositAddress = '0X' + q.quote.depositAddress.slice(2) }],
  ['deposit address with a broken EIP-55 checksum', q => { const a = q.quote.depositAddress; q.quote.depositAddress = '0x' + a.slice(2, 10).toUpperCase() + a.slice(10).toLowerCase() }],
  ['deposit address with a zero-width joiner', q => { q.quote.depositAddress = q.quote.depositAddress.slice(0, 8) + '‍' + q.quote.depositAddress.slice(8) }],
  ['amountOut "0x10"', q => { q.quote.amountOut = '0x10' }], ['amountOut "1e30"', q => { q.quote.amountOut = '1e30' }],
  ['amountIn echoed with leading zeros', q => { q.quote.amountIn = '0' + q.quote.amountIn }],
  ['fee as the string "20"', q => { q.quoteRequest.appFees = [{ recipient: 'x', fee: '20' }] }],
  ['fee of -50 (a "rebate" that hides another fee)', q => { q.quoteRequest.appFees = [{ recipient: 'x', fee: -50 }, { recipient: 'y', fee: 120 }] }],
]) {
  await freshEnv()
  const orig = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const r = await orig(input, init)
    if (String(typeof input === 'string' ? input : input.url).includes('/v0/quote') && init.body && JSON.parse(init.body).dry === false) { const j = await r.json(); mut(j); return new Response(JSON.stringify(j), { status: 201 }) }
    return r
  }
  const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: '1' })
  globalThis.fetch = orig
  const harmless = why.startsWith('fee as the string')
  t(`router sends ${why} → ${harmless ? 'handled' : 'refused, never shown'}`, harmless ? r.status < 500 : (r.status >= 400 && noAddr(r.j)), r.status + ' ' + (r.j && (r.j.error + ' ' + (r.j.detail || ''))))
}

section('P7 round 8 — payout bytes, chain clocks, platform limits')
{
  const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const usdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831', me = EVM_ME.toLowerCase()
  const J8 = S.verify.judgeEvm
  const dirty = { status: '0x1', logs: [{ address: usdc, topics: [T0, '0x' + '0'.repeat(64), '0x' + 'f'.repeat(24) + me.slice(2)], data: '0x' + (10n ** 9n).toString(16).padStart(64, '0') }] }
  t('Transfer topic with dirty high bytes (not a canonical address) → not accepted as a payout', J8(dirty, null, 'nep141:arb-' + usdc + '.omft.near', me, 1n) !== 'verified')
  const longData = { status: '0x1', logs: [{ address: usdc, topics: [T0, '0x' + '0'.repeat(64), '0x' + '0'.repeat(24) + me.slice(2)], data: '0x' + 'f'.repeat(64) + '0'.repeat(64) }] }
  t('Transfer data longer than one 32-byte word → not accepted', J8(longData, null, 'nep141:arb-' + usdc + '.omft.near', me, 1n) !== 'verified')
  const shortData = { status: '0x1', logs: [{ address: usdc, topics: [T0, '0x' + '0'.repeat(64), '0x' + '0'.repeat(24) + me.slice(2)], data: '0x' + 'ff' }] }
  t('Transfer data shorter than 32 bytes → not accepted', J8(shortData, null, 'nep141:arb-' + usdc + '.omft.near', me, 1n) !== 'verified')
  const canon = { status: '0x1', logs: [{ address: usdc, topics: [T0, '0x' + '0'.repeat(64), '0x' + '0'.repeat(24) + me.slice(2)], data: '0x' + (5n).toString(16).padStart(64, '0') }] }
  t('a canonical Transfer still verifies', J8(canon, null, 'nep141:arb-' + usdc + '.omft.near', me, 5n) === 'verified')
  // BTC block time that trails the swap's creation by an hour (legal under consensus)
  const txid = 'cd'.repeat(32), created = Math.floor(Date.now() / 1000)
  const fake = async u => String(u).endsWith('/blocks/tip/height') ? new Response('1000') : new Response(JSON.stringify({ txid, status: { confirmed: true, block_height: 990, block_time: created - 3600 }, vout: [{ scriptpubkey_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', value: 5000 }] }))
  t('BTC payout whose block time trails the swap by 1 h (consensus allows it) → verified, not a false replay alarm',
    await S.verify.verifyDestination(fake, 'btc', BTC, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 5000n, [{ hash: txid }], null, created) === 'verified')
  const fakeOld = async u => String(u).endsWith('/blocks/tip/height') ? new Response('1000') : new Response(JSON.stringify({ txid, status: { confirmed: true, block_height: 990, block_time: created - 3 * 86400 }, vout: [{ scriptpubkey_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', value: 5000 }] }))
  t('BTC payout 3 days older than the swap → still refused as stale', await S.verify.verifyDestination(fakeOld, 'btc', BTC, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 5000n, [{ hash: txid }], null, created) === 'stale')
}
await freshEnv()
{
  // Free plan: 50 subrequests per invocation, counting fetch AND D1 AND KV (Cloudflare docs, read)
  const ENVx = H.getEnv(), Wx = H.getWorld(), d = ENVx.CLWA_CLUSTERS.raw
  const ids = []
  for (let i = 0; i < 25; i++) {
    try { d.prepare('DELETE FROM intents_rl').run(); d.prepare("UPDATE intents_swaps SET state='expired' WHERE state='awaiting_deposit'").run(); d.prepare('UPDATE intents_swaps SET created_at = created_at - 61000').run() } catch {}
    const r = (await H.issue({ to: H.USDC_ARB, recipient: EVM_ME, amount: '100' })).r
    ids.push(r.j.swap)
  }
  d.prepare("UPDATE intents_swaps SET state='delivered_claimed', created_at = ?").run(Date.now() - 3600e3)
  for (const sw of ids) { Wx.status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.minAmountOut, destinationChainTxHashes: [0, 1, 2].map(() => ({ hash: '0x' + crypto.randomBytes(32).toString('hex'), explorerUrl: 'https://arbiscan.io/tx/x' })) } }); H.setRowTime(sw.id, Date.now() - 60e3) }
  let count = 0
  const wrapDB = db => ({ ...db, prepare: sql => { const st = db.prepare(sql); const w = s => ({ bind: (...a) => w(s.bind(...a)), run: () => { count++; return s.run() }, first: () => { count++; return s.first() }, all: () => { count++; return s.all() } }); return w(st) }, batch: l => { count++; return db.batch(l) }, raw: db.raw })
  ENVx.CLWA_CLUSTERS = wrapDB(ENVx.CLWA_CLUSTERS)
  const of = globalThis.fetch; globalThis.fetch = async (...a) => { count++; return of(...a) }
  const r1 = await H.reconcile()
  const first = count
  count = 0
  const r2 = await H.reconcile()
  globalThis.fetch = of
  t(`one reconcile pass with 25 swaps due stays under the Free cap of 50 (fetch+D1+KV = ${first})`, first <= 50, JSON.stringify({ checked: r1.j.checked, deferred: r1.j.deferred }))
  // round 21: delivered swaps lead at most 2 a pass, so the rest wait in the queue rather than as 'deferred'
  t('…it leaves the rest for later instead of dying, and the next pass moves on to them', (r1.j.deferred > 0 || r1.j.checked < 25) && r2.j.checked > 0 && (r2.j.results || []).every(x => !(r1.j.results || []).some(y => y.id === x.id)), JSON.stringify({ p1: r1.j.results.map(x => x.id.slice(0, 4)), p2: r2.j.results.map(x => x.id.slice(0, 4)) }))
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) { console.log('\nBREAKS:'); for (const b of breaks) console.log('  - ' + b) }
process.exit(fail ? 1 : 0)
