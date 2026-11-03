// ============================================================
// CRYPTO LWA · cross-chain swap desk — lib/intents.ts
// ============================================================
// Tests the SHIPPED library (bundled from src/lib/intents.ts), not a
// copy. Reference vectors come from published standards: Keccak/EIP-55 from the
// EIP, segwit from BIP-173/BIP-350, base58check built here with node's own
// SHA-256 (an implementation independent of the one under test).
//
//   npm run bundle:test   then   node test/intents.mjs
// ============================================================
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import * as L from './.build/lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  — ' + extra : '')) }
}
const J = o => JSON.stringify(o, (k, v) => typeof v === "bigint" ? v.toString() : v)
const hex = b => Buffer.from(b).toString('hex')

// ── independent encoders (node crypto) ──────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function b58enc(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0')), s = ''
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n }
  for (const b of buf) { if (b === 0) s = '1' + s; else break }
  return s
}
const sha = b => crypto.createHash('sha256').update(b).digest()
const b58check = payload => b58enc(Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]))
const withVersion = (v, len = 20) => Buffer.concat([Buffer.from([v]), crypto.randomBytes(len)])

function flipOne(s, from = 4) {
  // change one character to another valid char of the same alphabet
  for (let i = from; i < s.length; i++) {
    const c = s[i], alt = c === 'a' ? 'b' : c === 'A' ? 'B' : c === '2' ? '3' : null
    if (alt) return s.slice(0, i) + alt + s.slice(i + 1)
  }
  return s.slice(0, -1) + (s.endsWith('z') ? 'y' : 'z')
}

// ── 1. Keccak + EIP-55 ──────────────────────────────────────────────────
console.log('\n[keccak / EIP-55]')
t('keccak256("") matches the published digest',
  hex(L.keccak256(new Uint8Array())) === 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
t('keccak256("abc") matches the published digest',
  hex(L.keccak256(new TextEncoder().encode('abc'))) === '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45')
// 200 bytes: crosses the 136-byte rate boundary
t('keccak256 multi-block input is deterministic and 32 bytes',
  L.keccak256(new Uint8Array(200)).length === 32 && hex(L.keccak256(new Uint8Array(200))) === hex(L.keccak256(new Uint8Array(200))))
const EIP55 = ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']
for (const a of EIP55) t('EIP-55 vector accepted ' + a.slice(0, 10), L.evmAddressOk(a))
for (const a of EIP55) {
  const i = [...a].findIndex((c, k) => k > 1 && /[a-fA-F]/.test(c))
  const bad = a.slice(0, i) + (a[i] === a[i].toLowerCase() ? a[i].toUpperCase() : a[i].toLowerCase()) + a.slice(i + 1)
  t('EIP-55 one flipped case rejected ' + a.slice(0, 10), !L.evmAddressOk(bad))
}
t('all-lowercase EVM accepted', L.evmAddressOk(EIP55[0].toLowerCase()))
t('41 hex chars rejected', !L.evmAddressOk('0x' + 'a'.repeat(41)))
t('non-hex rejected', !L.evmAddressOk('0x' + 'g'.repeat(40)))

// ── 2. Bitcoin ──────────────────────────────────────────────────────────
console.log('\n[bitcoin]')
const btcGood = [
  '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',                               // genesis coinbase
  '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',                               // P2SH (NEAR's docs print it with a Y: checksum-invalid)
  'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',                       // BIP-173 P2WPKH
  'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',                       // BIP-173 upper-case
  'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',   // BIP-173 P2WSH
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',   // BIP-350 taproot
]
for (const a of btcGood) t('BTC valid ' + a.slice(0, 14), await L.validAddress('btc', a))
const btcBad = [
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'segwit checksum off by one char'],
  ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k7grplx', 'v1 with bech32 (not bech32m) — BIP-350 invalid'],
  ['bc1QW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mixed case'],
  ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'testnet hrp'],
  ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', 'base58check checksum broken'],
  [' 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'leading space'],
  ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'an EVM address'],
]
for (const [a, why] of btcBad) t('BTC rejected: ' + why, !(await L.validAddress('btc', a)))

// ── 3. base58check chains, independent encoder ──────────────────────────
console.log('\n[base58check chains]')
const cases = [
  ['ltc', 0x30, true, 'L legacy'], ['ltc', 0x32, true, 'M p2sh'], ['ltc', 0x05, true, '3 p2sh'], ['ltc', 0x00, false, 'BTC version byte'],
  ['doge', 0x1e, true, 'D legacy'], ['doge', 0x16, true, '9/A p2sh'], ['doge', 0x30, false, 'LTC version byte'],
  ['tron', 0x41, true, 'T 0x41'], ['tron', 0x00, false, 'version 0x00'],
  ['btc', 0x00, true, '1 legacy'], ['btc', 0x05, true, '3 p2sh'], ['btc', 0x6f, false, 'testnet m/n'],
]
for (const [chain, v, ok, why] of cases) {
  let all = true
  for (let i = 0; i < 25; i++) if ((await L.validAddress(chain, b58check(withVersion(v)))) !== ok) all = false
  t(`${chain} ${why} → ${ok ? 'accepted' : 'rejected'} (25 random)`, all)
}
{
  let caught = 0
  for (let i = 0; i < 50; i++) {
    const a = b58check(withVersion(0x41))
    const j = 5 + (i % (a.length - 6))
    const c = a[j], alt = B58[(B58.indexOf(c) + 1) % 58]
    if (!(await L.validAddress('tron', a.slice(0, j) + alt + a.slice(j + 1)))) caught++
  }
  t('tron: 50/50 single-character typos caught by the checksum', caught === 50, caught + '/50')
}
t('tron: real USDT contract TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t accepted', await L.validAddress('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'))

// LTC segwit via an independent bech32 encoder
function bech32Encode(hrp, ver, prog, m) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  const pm = vals => { let c = 1; for (const v of vals) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= G[i] } return c >>> 0 }
  const conv = []; let acc = 0, bits = 0
  for (const b of prog) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; conv.push((acc >> bits) & 31) } }
  if (bits) conv.push((acc << (5 - bits)) & 31)
  const data = [ver, ...conv]
  const exp = [...hrp].map(c => c.charCodeAt(0) >> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31))
  const mod = pm(exp.concat(data, [0, 0, 0, 0, 0, 0])) ^ (m ? 0x2bc830a3 : 1)
  const chk = []; for (let i = 0; i < 6; i++) chk.push((mod >> (5 * (5 - i))) & 31)
  const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  return hrp + '1' + data.concat(chk).map(d => CH[d]).join('')
}
t('ltc1q (v0, 20 bytes) accepted', await L.validAddress('ltc', bech32Encode('ltc', 0, crypto.randomBytes(20), false)))
t('ltc1p (v1, 32 bytes, bech32m) accepted', await L.validAddress('ltc', bech32Encode('ltc', 1, crypto.randomBytes(32), true)))
t('ltc1q v0 with 25-byte program rejected', !(await L.validAddress('ltc', bech32Encode('ltc', 0, crypto.randomBytes(25), false))))
t('bc1 address rejected on ltc', !(await L.validAddress('ltc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')))
t('independent encoder agrees with BIP-173 vector',
  bech32Encode('bc', 0, Buffer.from('751e76e8199196d454941c45d1b3a323f1433bd6', 'hex'), false) === 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')

// ── 4. Solana / NEAR ────────────────────────────────────────────────────
console.log('\n[solana / near]')
t('SOL wSOL mint accepted', await L.validAddress('sol', 'So11111111111111111111111111111111111111112'))
t('SOL system program (32 × "1") accepted', await L.validAddress('sol', '11111111111111111111111111111111'))
t('SOL random 32-byte key accepted', await L.validAddress('sol', b58enc(crypto.randomBytes(32).fill(1, 0, 1))))
t('SOL 33-byte value rejected', !(await L.validAddress('sol', b58enc(Buffer.concat([Buffer.from([9]), crypto.randomBytes(32)])))))
t('SOL with a 0 (not base58) rejected', !(await L.validAddress('sol', 'So1111111111111111111111111111111111111111O')))
t('SOL EVM address rejected', !(await L.validAddress('sol', EIP55[0])))
for (const a of ['alice.near', 'wrap.near', 'sub.account-1.near', 'a1', '0x' + 'ab'.repeat(20), 'f'.repeat(64)])
  t('NEAR accepted ' + a.slice(0, 20), await L.validAddress('near', a))
for (const a of ['Alice.near', 'a', '-bad.near', 'bad..near', 'bad.near.', 'x'.repeat(65), '0x' + 'AB'.repeat(20), 'alice near'])
  t('NEAR rejected ' + JSON.stringify(a.slice(0, 20)), !(await L.validAddress('near', a)))
t('isNearNamed: alice.near yes, 64-hex no', L.isNearNamed('alice.near') && !L.isNearNamed('f'.repeat(64)))
t('unknown chain rejected', !(await L.validAddress('xrp', 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv')))
t('non-string rejected', !(await L.validAddress('eth', 12345)))

// ── 5. Amounts ──────────────────────────────────────────────────────────
console.log('\n[amounts]')
t('1.5 @6 → 1500000', L.toBaseUnits('1.5', 6) === 1500000n)
t('0.000001 @6 → 1', L.toBaseUnits('0.000001', 6) === 1n)
t('too many decimals rejected', L.toBaseUnits('0.0000001', 6) === null)
t('zero rejected', L.toBaseUnits('0', 6) === null && L.toBaseUnits('0.000', 6) === null)
t('negative / exponent / comma rejected', L.toBaseUnits('-1', 6) === null && L.toBaseUnits('1e3', 6) === null && L.toBaseUnits('1,5', 6) === null)
t('24-decimal NEAR exact', L.toBaseUnits('1.000000000000000000000001', 24) === 1000000000000000000000001n)
t('no float drift: 0.1+0.2 style input exact', L.toBaseUnits('0.3', 18) === 300000000000000000n)
t('fromBaseUnits round-trips', L.fromBaseUnits(1500000n, 6) === '1.5' && L.fromBaseUnits('1', 8) === '0.00000001' && L.fromBaseUnits(5n, 0) === '5')

// ── 6. Token list ───────────────────────────────────────────────────────
console.log('\n[tokens]')
const rawTokens = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/fixtures-intents-tokens.json'), 'utf8'))
const tokens = L.slimTokens(rawTokens)
const chainsSeen = new Set(tokens.map(x => x.chain))
t('slimTokens keeps only allowlisted chains', [...chainsSeen].every(c => c in L.CHAINS), [...chainsSeen].join(','))
t('slimTokens drops memo chains (xrp/stellar/ton)', !['xrp', 'stellar', 'ton'].some(c => chainsSeen.has(c)))
t('slimTokens keeps BTC, SOL, NEAR', ['btc', 'sol', 'near'].every(c => chainsSeen.has(c)))
t('slimTokens ignores junk rows', L.slimTokens([null, 1, { assetId: 'evil', blockchain: 'eth', decimals: 6, symbol: 'X' },
  { assetId: 'nep141:a.near', blockchain: 'near', decimals: 99, symbol: 'X' }]).length === 0)
t('slimTokens is not an array → []', L.slimTokens({}).length === 0)
console.log('    (' + tokens.length + ' of ' + rawTokens.length + ' live tokens usable on ' + chainsSeen.size + ' chains)')

// ── 7. Request building ─────────────────────────────────────────────────
console.log('\n[request]')
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
const SOL = 'nep141:sol.omft.near', BTC = 'nep141:btc.omft.near'
const good = { from: USDC_BASE, to: SOL, amount: '100', recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', refundTo: EIP55[0], dry: true }
const NOW = 1e12                       // any fixed instant; the expected deadlines below are derived from it
const at = ms => new Date(NOW + ms).toISOString()
const NOFEE = { feeBps: 0, feeRecipient: '' }
let b = await L.buildQuoteRequest(good, tokens, NOFEE, NOW)
t('good request builds', b.ok, J(b))
t('amount converted to base units (100 USDC → 100000000)', b.ok && b.body.amount === '100000000')
t('types are fixed: EXACT_INPUT / ORIGIN_CHAIN / DESTINATION_CHAIN / SIMPLE',
  b.ok && b.body.swapType === 'EXACT_INPUT' && b.body.depositType === 'ORIGIN_CHAIN' && b.body.refundType === 'ORIGIN_CHAIN'
  && b.body.recipientType === 'DESTINATION_CHAIN' && b.body.depositMode === 'SIMPLE')
t('no appFees when our fee is off', b.ok && !('appFees' in b.body))
t('deadline = now + 60 min for an EVM origin', b.ok && b.body.deadline === at(60 * 60e3))
const bb = await L.buildQuoteRequest({ ...good, from: BTC, to: USDC_BASE, recipient: EIP55[0], refundTo: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: '0.01' }, tokens, NOFEE, NOW)
t('deadline = now + 6 h for a BTC origin', bb.ok && bb.body.deadline === at(6 * 60 * 60e3), J(bb))
const reject = async (patch, err) => {
  const r = await L.buildQuoteRequest({ ...good, ...patch }, tokens, NOFEE, NOW)
  t('refuses ' + err, !r.ok && r.error === err, J(r))
}
await reject({ from: 'nep141:fake.near' }, 'unsupported_from_asset')
await reject({ to: 'nep141:xrp.omft.near' }, 'unsupported_to_asset')
await reject({ to: USDC_BASE }, 'same_asset')
await reject({ amount: '0' }, 'bad_amount')
await reject({ amount: '1.0000001' }, 'bad_amount')                 // USDC has 6 decimals
await reject({ recipient: EIP55[0] }, 'bad_recipient')              // EVM address for a SOL payout
await reject({ refundTo: 'So11111111111111111111111111111111111111112' }, 'bad_refund_address') // SOL refund for a Base deposit
await reject({ slippageBps: 5 }, 'bad_slippage')
await reject({ slippageBps: 301 }, 'bad_slippage')
await reject({ slippageBps: 1.5 }, 'bad_slippage')
t('null body refused', !(await L.buildQuoteRequest(null, tokens, NOFEE, NOW)).ok)
// token contracts pasted as wallets
const WNEAR = 'nep141:wrap.near'
await reject({ to: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', from: SOL, refundTo: 'So11111111111111111111111111111111111111112', recipient: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, 'recipient_is_token_contract')
await reject({ from: WNEAR, to: USDC_BASE, recipient: EIP55[0], refundTo: 'wrap.near', amount: '1' }, 'refund_is_token_contract')
await reject({ to: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', recipient: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, 'recipient_is_token_contract')
t('a normal NEAR account is not mistaken for a contract', (await L.buildQuoteRequest({ ...good, from: WNEAR, to: USDC_BASE, recipient: EIP55[0], refundTo: 'alice.near', amount: '1' }, tokens, NOFEE, NOW)).ok)
t('slimTokens carries contract (SPL mint / NEP-141 / ERC-20), null for native', tokens.find(x => x.id === 'nep141:sol.omft.near').contract === null
  && tokens.find(x => x.chain === 'sol' && x.symbol === 'USDC').contract === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  && tokens.find(x => x.id === WNEAR).contract === 'wrap.near')

console.log('\n[fee config]')
t('fee off by default', L.feeCfgFrom({}).feeBps === 0)
t('fee on with a valid NEAR recipient', L.feeCfgFrom({ INTENTS_FEE_BPS: '30', INTENTS_FEE_RECIPIENT: 'cryptolwa.near' }).feeBps === 30)
t('fee refused without a recipient', L.feeCfgFrom({ INTENTS_FEE_BPS: '30' }).feeBps === 0)
t('fee refused above 100 bps', L.feeCfgFrom({ INTENTS_FEE_BPS: '101', INTENTS_FEE_RECIPIENT: 'cryptolwa.near' }).feeBps === 0)
t('fee refused when not an integer', L.feeCfgFrom({ INTENTS_FEE_BPS: '2.5', INTENTS_FEE_RECIPIENT: 'cryptolwa.near' }).feeBps === 0)
const fb = await L.buildQuoteRequest(good, tokens, { feeBps: 30, feeRecipient: 'cryptolwa.near' }, NOW)
t('fee on → appFees carries exactly our entry', fb.ok && JSON.stringify(fb.body.appFees) === '[{"recipient":"cryptolwa.near","fee":30}]')

// ── 8. checkQuote against a REAL captured response ──────────────────────
console.log('\n[checkQuote — live response captured]')
const live = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/fixtures-intents-quote-live.json'), 'utf8'))
// The capture's dates were taken out (owner's rule: no dates in the tree). As captured, 1Click
// echoed our 1 h request deadline and answered with a 3-day deposit deadline; set the same
// shape relative to the clock this runs on (a fixed date would also expire and fail this test).
{ const req = new Date(Date.now() + 3600e3).toISOString(), dep = new Date(Date.now() + 3 * 86400e3).toISOString()
  live.quoteRequest.deadline = req; live.quote.deadline = dep; live.quote.timeWhenInactive = dep }
const from = tokens.find(x => x.id === live.quoteRequest.originAsset), to = tokens.find(x => x.id === live.quoteRequest.destinationAsset)
const sent = { ...live.quoteRequest }; delete sent.appFees
const clone = () => JSON.parse(JSON.stringify(live))
let c = await L.checkQuote(sent, from, to, clone(), NOFEE)
t('the real response passes', c.ok, J(c))
t('platform fee read off the response (1Click injected 20 bps)', c.ok && c.q.platformFeeBps === 20 && c.q.ourFeeBps === 0)
t('deposit address surfaced', c.ok && c.q.depositAddress === live.quote.depositAddress)
t('signature kept for the receipt', c.ok && c.q.signature && c.q.signature.startsWith('ed25519:'))
const tamper = async (fn, err) => {
  const g = clone(); fn(g)
  const r = await L.checkQuote(sent, from, to, g, NOFEE)
  t('refuses tampered response: ' + err, !r.ok && r.error === err, J(r))
}
await tamper(g => { g.quoteRequest.recipient = 'So11111111111111111111111111111111111111112' }, 'echo_recipient')
await tamper(g => { g.quoteRequest.refundTo = EIP55[1] }, 'echo_refund')
await tamper(g => { g.quoteRequest.destinationAsset = USDC_BASE }, 'echo_asset')
await tamper(g => { g.quoteRequest.amount = '1' }, 'echo_amount')
await tamper(g => { g.quote.amountIn = '99999999' }, 'echo_amount_in')
await tamper(g => { g.quote.depositMemo = '123' }, 'memo_required')
await tamper(g => { g.quote.depositAddress = 'not-an-address' }, 'bad_deposit_address')
await tamper(g => { g.quote.depositAddress = 'So11111111111111111111111111111111111111112' }, 'bad_deposit_address')
await tamper(g => { g.quote.minAmountOut = String(BigInt(g.quote.amountOut) + 1n) }, 'upstream_amounts')
await tamper(g => { g.quote.amountOut = '0' }, 'upstream_amounts')
await tamper(g => { g.quoteRequest.appFees.push({ recipient: 'x.near', fee: 490 }) }, 'upstream_fee')
await tamper(g => { g.quoteRequest.customRecipientMsg = 'evil.near' }, 'unexpected_recipient_msg')
await tamper(g => { g.quoteRequest.recipientType = 'INTENTS' }, 'echo_types')
await tamper(g => { g.quoteRequest.dry = true }, 'echo_dry')
await tamper(g => { delete g.quote }, 'upstream_shape')
await tamper(g => { g.quote.minAmountOut = String(BigInt(g.quote.amountOut) * 9800n / 10000n) }, 'min_out_below_slippage')   // 2% below, we asked 1%
await tamper(g => { g.quoteRequest.slippageTolerance = 300 }, 'echo_slippage')
await tamper(g => { g.quoteRequest.deadline = new Date(Date.now() + 9 * 86400e3).toISOString() }, 'echo_deadline')
t('the real live answer honours our 1% slippage within 5 bps', BigInt(live.quote.minAmountOut) * 10000n >= BigInt(live.quote.amountOut) * 9895n)
{
  const r = await L.checkQuote(sent, from, to, clone(), { feeBps: 30, feeRecipient: 'cryptolwa.near' })
  t('refuses when our configured fee is missing from the response', !r.ok && r.error === 'echo_fee')
}
{
  const g = clone(); g.quoteRequest.recipient = g.quoteRequest.recipient   // SOL: case-sensitive
  const sentLower = { ...sent, refundTo: sent.refundTo.toLowerCase() }
  const r = await L.checkQuote(sentLower, from, to, g, NOFEE)
  t('EVM refund echo compared case-insensitively', r.ok)
}

// ── 9. Cost + status ────────────────────────────────────────────────────
console.log('\n[cost / status]')
t('costBps 100 USDC → 0.9863 SOL @ $101.14 ≈ 25 bps', L.costBps('100000000', from, 1.0, '986307351', to, 101.14) === Math.round((1 - 0.986307351 * 101.14 / 100) * 10000))
t('costBps null without a price', L.costBps('1', from, null, '1', to, 1) === null)
t('verdicts', L.costVerdict(null) === 'unpriced' && L.costVerdict(10) === 'ok' && L.costVerdict(L.COST.warn + 1) === 'warn' && L.costVerdict(L.COST.block + 1) === 'block')
t('negative cost (better than mid) is ok', L.costVerdict(-30) === 'ok')
const st = L.slimStatus({ status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOutFormatted: '1.0', destinationChainTxHashes: [{ hash: 'abc', explorerUrl: 'javascript:alert(1)' }, { hash: 'def', explorerUrl: 'https://solscan.io/tx/def' }] } })
t('status slimmed', st.ok && st.s.status === 'SUCCESS')
t('status drops non-https explorer links but keeps the hash', st.ok && st.s.destinationTxs.length === 2 && st.s.destinationTxs[0].hash === 'abc' && st.s.destinationTxs[0].explorerUrl === ''
  && st.s.destinationTxs[1].explorerUrl === 'https://solscan.io/tx/def', JSON.stringify(st.s && st.s.destinationTxs))
// The shape 1Click answered on the first real swap (Base USDC → SOL): every explorerUrl empty.
const SOL_TX = '4oaDvbvSStJVFh2rCRFkWwTM7XA5M5Copnfbk7Mryi5aXM7JqdaEpiCyy6S9RQZBogrF4JyzynTk2pwwYjFgARTe'
const liveSt = L.slimStatus({ status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: '65142241',
  originChainTxHashes: [{ hash: '0x5d62f2ffe2d78bb560fc5af1efd13ea45cfc9c0826aee8e617466b7a67898a8d', explorerUrl: '' }],
  destinationChainTxHashes: [{ hash: SOL_TX, explorerUrl: '' }] } })
t('live 1Click shape (explorerUrl "") → the payout hash is kept', liveSt.ok && liveSt.s.destinationTxs.length === 1 && liveSt.s.destinationTxs[0].hash === SOL_TX && liveSt.s.originTxs.length === 1, JSON.stringify(liveSt.s && liveSt.s.destinationTxs))
const bad = L.slimStatus({ status: 'SUCCESS', updatedAt: 'x', swapDetails: { destinationChainTxHashes: [{ hash: '<img src=x onerror=alert(1)>', explorerUrl: '' }, { hash: 'a'.repeat(121), explorerUrl: '' }, { hash: '0xab"cd', explorerUrl: '' }, { hash: 7 }] } })
t('a hash with markup, quotes, over 120 chars or not a string is dropped', bad.ok && bad.s.destinationTxs.length === 0, JSON.stringify(bad.s && bad.s.destinationTxs))
t('unknown status refused', !L.slimStatus({ status: 'HACKED' }).ok)
t('anyDepositAddress accepts EVM/BTC/SOL', await L.anyDepositAddress(EIP55[0]) && await L.anyDepositAddress(btcGood[0]) && await L.anyDepositAddress('So11111111111111111111111111111111111111112'))
t('anyDepositAddress refuses junk / path tricks', !(await L.anyDepositAddress('../../v0/tokens')) && !(await L.anyDepositAddress('a b')))
t('TX_HASH: evm hash ok, junk refused', L.TX_HASH.test('0x' + 'a'.repeat(64)) && !L.TX_HASH.test('0x123') && !L.TX_HASH.test('a/b'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
