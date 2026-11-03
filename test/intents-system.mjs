// ============================================================
// CRYPTO LWA · cross-chain desk — system tests through the SHIPPED handlers
// ============================================================
// D1  = a real SQLite database (node:sqlite) behind a D1-shaped shim
// KV  = an in-memory map
// Net = a scripted 1Click / CoinGecko / chain-node world, including outages,
//       tampered answers, regressions, short payouts and late deposits
// Clients = test cookies mapped to client IPs by test/entry.ts (the desk has no accounts)
//
//   npm run bundle:test   then   node test/intents-system.mjs
// ============================================================
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'url'
import * as S from './.build/sys.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  — ' + String(extra).slice(0, 400) : '')) }
}
const section = s => console.log('\n[' + s + ']')

// ── D1 shim over real SQLite ────────────────────────────────────────────
function makeD1() {
  const db = new DatabaseSync(':memory:')
  // STRICT like real D1 (red-team round 7): D1 throws D1_TYPE_ERROR on an undefined
  // bind and has no boolean/bigint/object type. The old shim turned undefined into
  // null and could hide crashes that would only appear in production.
  const norm = a => a.map((v, i) => {
    if (v === undefined) throw new Error('D1_TYPE_ERROR: Type undefined is not supported for bind #' + (i + 1))
    if (typeof v === 'bigint' || (typeof v === 'object' && v !== null)) throw new Error('D1_TYPE_ERROR: Type ' + typeof v + ' is not supported for bind #' + (i + 1))
    return typeof v === 'boolean' ? (v ? 1 : 0) : v
  })
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => { const r = db.prepare(sql).run(...norm(args)); return { success: true, meta: { changes: Number(r.changes) } } },
    first: async () => db.prepare(sql).get(...norm(args)) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...norm(args)) }),
  })
  return { prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run() }, raw: db }
}
function makeKV() {
  const m = new Map()
  return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) }, _m: m }
}

// ── auth ────────────────────────────────────────────────────────────────
const SECRET = 'test-secret-' + crypto.randomBytes(8).toString('hex')
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function session(email, plan = 'lifetime') {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const p = b64u(JSON.stringify({ sub: email, plan, iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 3600 }))
  const s = b64u(crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest())
  return `clwa_session=${h}.${p}.${s}`
}

// ── scripted outside world ──────────────────────────────────────────────
const rawTokens = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/fixtures-intents-tokens.json'), 'utf8'))
const TOK = Object.fromEntries(rawTokens.map(x => [x.assetId, x]))
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
const SOL = 'nep141:sol.omft.near'
const ETH_ARB = 'nep141:arb.omft.near'
const USDC_ARB = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'
const WNEAR = 'nep141:wrap.near'
const EVM_ME = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'
const EVM_ME2 = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'
const SOL_ME = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const b58 = buf => { let n = BigInt('0x' + Buffer.from(buf).toString('hex')), s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n } return s }

let W, CG_ROUNDED = 0, CG_CALLS = 0
function resetWorld() {
  W = {
    quoteMode: 'ok', outFactor: 1, cgDown: false, cgPrice: { 'usd-coin': 1, solana: 101.14, ethereum: 2342.92, 'wrapped-near': 4.67, near: 4.67, bitcoin: 80658 },
    status: new Map(), receipts: new Map(), nearAccounts: new Set(['alice.near', 'wrap.near']), nearDown: false,
    oneclickDown: false, calls: { quoteDry: 0, quoteReal: 0, status: 0, submit: 0, cg: 0, evm: 0, near: 0 },
    lastQuoteBody: null, depositSeq: 0,
  }
}
const resp = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function quoteFor(body) {
  const a = TOK[body.originAsset], b = TOK[body.destinationAsset]
  const usd = Number(body.amount) / 10 ** a.decimals * a.price
  const out = BigInt(Math.floor(usd / b.price * 10 ** b.decimals * 0.9975 * W.outFactor))
  const minOut = out * BigInt(10000 - body.slippageTolerance) / 10000n
  W.depositSeq++
  const depositAddress = a.blockchain === 'sol' ? b58(crypto.createHash('sha256').update('d' + W.depositSeq).digest())
    : '0x' + crypto.createHash('sha256').update('d' + W.depositSeq).digest('hex').slice(0, 40)
  const quote = { amountIn: body.amount, amountInFormatted: '', amountInUsd: String(usd), minAmountIn: body.amount,
    amountOut: out.toString(), amountOutFormatted: '', amountOutUsd: String(usd * 0.9975), minAmountOut: minOut.toString(), timeEstimate: 30 }
  if (!body.dry) Object.assign(quote, { depositAddress, deadline: new Date(Date.now() + 3 * 86400e3).toISOString(), timeWhenInactive: new Date(Date.now() + 3 * 86400e3).toISOString() })
  const appFees = [...(body.appFees || []), { recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 20 }]
  return { quote, quoteRequest: { ...body, appFees }, signature: 'ed25519:test', timestamp: new Date().toISOString(), correlationId: crypto.randomUUID() }
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  const body = init.body ? JSON.parse(init.body) : null
  // round 31: a JSON-RPC batch is answered element by element, like a real node (one HTTP request)
  if (Array.isArray(body)) {
    const out = []
    for (const one of body) { const r = await globalThis.fetch(input, { ...init, body: JSON.stringify(one) }); const j = await r.json().catch(() => null); out.push({ ...(j || {}), id: one.id }) }
    return resp(out)
  }
  if (url.hostname === '1click.chaindefuser.com') {
    if (W.oneclickDown) throw new TypeError('network down')
    if (url.pathname === '/v0/tokens') return resp(rawTokens)
    if (url.pathname === '/v0/quote') {
      body.dry ? W.calls.quoteDry++ : W.calls.quoteReal++
      W.lastQuoteBody = body
      if (W.quoteMode === '500') return resp({ message: 'boom' }, 500)
      if (W.quoteMode === '400') return resp({ message: 'Amount is too low for bridge, try at least 1000000' }, 400)
      if (W.quoteMode === 'noliq-once' && !body.quoteWaitingTimeMs) return resp({ message: 'No liquidity available' }, 400)
      if (W.quoteMode === 'noliq') return resp({ message: 'No liquidity available' }, 400)
      if (W.quoteMode === 'timeout') throw new DOMException('timeout', 'TimeoutError')
      const q = quoteFor(body)
      if (W.quoteMode === 'tamper') q.quoteRequest.recipient = EVM_ME2
      if (W.quoteMode === 'memo' && !body.dry) q.quote.depositMemo = '777'
      if (W.quoteMode === 'lowmin' && !body.dry) q.quote.minAmountOut = String(BigInt(q.quote.amountOut) * 9700n / 10000n)
      if (W.reapOnQuote && !body.dry) ENV.CLWA_CLUSTERS.raw.prepare("UPDATE intents_swaps SET state='abandoned' WHERE state='reserving'").run()
      if (W.pauseOnQuote && !body.dry) ENV.CLWA_CLUSTERS.raw.prepare("INSERT INTO intents_control (key,value,updated_at,actor) VALUES ('pause:global','drill',0,'test')").run()
      if (W.quoteMode === 'slow') await new Promise(r => setTimeout(r, 30))
      return resp(q, 201)
    }
    if (url.pathname === '/v0/status') {
      W.calls.status++
      const s = W.status.get(url.searchParams.get('depositAddress'))
      return s ? resp(s) : resp({ message: 'not found' }, 404)
    }
    if (url.pathname === '/v0/deposit/submit') { W.calls.submit++; return resp({ status: 'KNOWN_DEPOSIT_TX' }) }
  }
  if (url.hostname === 'coins.llama.fi') {
    W.calls.llama = (W.calls.llama || 0) + 1
    if (W.llamaDown || W.cgDown === 'both') return resp({}, 503)
    const keys = decodeURIComponent(url.pathname.split('/').pop()).split(',')
    const coins = {}
    for (const k of keys) { const id = k.replace('coingecko:', ''); if (W.cgPrice[id]) coins[k] = { price: W.cgPrice[id], confidence: 0.99, timestamp: Math.floor(Date.now() / 1000) } }
    return resp({ coins })
  }
  if (url.hostname === 'api.coingecko.com') {
    W.calls.cg++
    if (W.cgDown) return resp({ error: 'down' }, 503)
    const ids = (url.searchParams.get('ids') || '').split(',')
    if (url.searchParams.get('precision') !== 'full') CG_ROUNDED++; CG_CALLS++; return resp(Object.fromEntries(ids.filter(i => W.cgPrice[i]).map(i => [i, { usd: W.cgPrice[i] }])))
  }
  if (body && body.method === 'getAccountInfo' && (url.hostname.endsWith('publicnode.com') || url.hostname === 'api.mainnet-beta.solana.com')) {
    if (W.solDown) throw new TypeError('down')
    const a = (W.solAccounts || {})[body.params[0]]
    return resp({ jsonrpc: '2.0', id: 1, result: { context: {}, value: a === undefined ? { owner: '11111111111111111111111111111111', executable: false, lamports: 1 } : a } })
  }
  if (body && body.method === 'eth_getCode' && (url.hostname.endsWith('publicnode.com') || url.hostname.endsWith('drpc.org') || url.hostname === 'arb1.arbitrum.io')) {
    return resp({ jsonrpc: '2.0', id: 1, result: (W.evmCode || {})[String(body.params[0]).toLowerCase()] || '0x' })
  }
  // round 26: native balances are read from these state-keeping nodes; faked like publicnode
  if (url.hostname.endsWith('publicnode.com') || url.hostname.endsWith('drpc.org') || url.hostname === 'arb1.arbitrum.io') {
    W.calls.evm++
    if (url.hostname.endsWith('drpc.org') || url.hostname === 'arb1.arbitrum.io') W.stateCalls = (W.stateCalls || 0) + 1
    if (body.method === 'eth_getTransactionReceipt') {
      const rc = W.receipts.get(body.params[0])
      // Like a real node: the receipt names its own tx (round 24 checks it).
      return resp({ jsonrpc: '2.0', id: 1, result: rc ? { blockNumber: '0x1', blockHash: '0x' + 'bb'.repeat(32), transactionHash: body.params[0], ...rc } : null })
    }
    // Chain head far ahead of every test block (payouts are final) unless a case sets W.head.
    if (body.method === 'eth_blockNumber') return resp({ jsonrpc: '2.0', id: 1, result: '0x' + (W.head ?? 1_000_000).toString(16) })
    // Block times: by default every block is "now" (a fresh payout). Suites that test replays set W.blockTs.
    if (body.method === 'eth_getBlockByNumber') {
      const ts = (W.blockTs || {})[body.params[0]] ?? Math.floor(Date.now() / 1000)
      return resp({ jsonrpc: '2.0', id: 1, result: { number: body.params[0], timestamp: '0x' + ts.toString(16) } })
    }
    if (body.method === 'eth_getTransactionByHash') {
      // Like a real node (round 25): the tx of a known receipt, in the receipt's block, sent by a
      // solver unless a suite overrides fields through W.txs.
      const h = body.params[0], rc = W.receipts.get(h), o = W.txs && W.txs.get(h)
      return resp({ jsonrpc: '2.0', id: 1, result: rc || o ? { hash: h, blockNumber: (rc && rc.blockNumber) || '0x1', from: '0x' + '55'.repeat(20), to: null, value: '0x0', ...(o || {}) } : null })
    }
    // round 32: the recipient's nonce (W.nonce(blockNumber|hash)); by default it did not move
    if (body.method === 'eth_getTransactionCount') return resp({ jsonrpc: '2.0', id: 1, result: W.nonce ? W.nonce(body.params[1]) : '0x7' })
    if (body.method === 'eth_getBalance') {
      // W.balances(blockNumber) when a suite sets it. Like publicnode (measured), state
      // more than ~127 blocks behind the head is gone.
      // a {blockHash} (EIP-1898) names the block of the receipt that carries that hash
      const at = body.params[1], byHash = at && typeof at === 'object'
      const rcOf = byHash ? Array.from(W.receipts.values()).find(r => (r.blockHash || '0x' + 'bb'.repeat(32)) === at.blockHash) : null
      if (byHash && !rcOf) return resp({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'block not found' } })
      const n = Number(BigInt(byHash ? (rcOf.blockNumber || '0x1') : at)), head = W.head ?? 1_000_000
      if (!W.balances || head - n > 127) return resp({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Archive requests require a personal token.' } })
      return resp({ jsonrpc: '2.0', id: 1, result: W.balances(n) })
    }
  }
  if (url.hostname === 'near.drpc.org' || url.hostname === 'free.rpc.fastnear.com') {
    W.calls.near++
    if (W.nearDown) throw new TypeError('down')
    // round 27: payout checks. W.nearTx: tx hash → EXPERIMENTAL_tx_status result; blocks are "now"
    // unless W.nearBlockTs names a time (ms) for a block hash.
    if (body.method === 'EXPERIMENTAL_tx_status') {
      const r = (W.nearTx || new Map()).get(body.params.tx_hash)
      return resp(r ? { jsonrpc: '2.0', id: 1, result: r } : { jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } })
    }
    if (body.method === 'block') {
      const ms = (W.nearBlockTs || {})[body.params.block_id] ?? Date.now()
      return resp({ jsonrpc: '2.0', id: 1, result: { header: { hash: body.params.block_id, timestamp_nanosec: String(BigInt(Math.floor(ms)) * 1000000n) } } })
    }
    const id = body.params.account_id
    // the key checker: W.nearKeys[id] scripts an account's keys; an existing account has one full-access
    // key by default, and a missing one answers an EMPTY list (as mainnet does, checked live)
    if (body.params.request_type === 'view_access_key_list') {
      if (W.nearTooMany === id) return resp({ jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name: 'TOO_MANY_ACCESS_KEYS', info: { limit: 100 } } } })
      const ks = (W.nearKeys || {})[id] ?? (W.nearAccounts.has(id) ? [{ access_key: { nonce: 1, permission: 'FullAccess' }, public_key: 'ed25519:njV8oUZbvd1HswZiKL8j7zx2U1wnvaLQiysYDRPMBsF' }] : [])
      return resp({ jsonrpc: '2.0', id: 1, result: { block_hash: 'x', block_height: 1, keys: ks } })
    }
    return W.nearAccounts.has(id) ? resp({ result: { amount: '1' } }) : resp({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } })
  }
  return resp({ error: 'unexpected host ' + url.hostname }, 599)
}

// ── harness ─────────────────────────────────────────────────────────────
let ENV
async function freshEnv(extra = {}) {
  resetWorld()
  S.ledger.__resetLedger(); S.__resetJar(); S.io.__resetTokenCache(); S.io.__resetPriceCache()
  const members = makeKV()
  for (const [e, plan] of [['paid@x.io', 'lifetime'], ['other@x.io', 'lifetime'], ['free@x.io', 'free']])
    await members.put('member:' + e, JSON.stringify({ email: e, plan, status: 'active' }))
  ENV = { MEMBER_JWT_SECRET: SECRET, CLWA_MEMBERS: members, CLWA_SESSIONS: makeKV(), CLWA_CLUSTERS: makeD1(), REFRESH_KEY: 'rk-123', ...extra }
  return ENV
}
const SITE = 'https://www.cryptolwa.io'
function req(method, p, { who = 'paid@x.io', body, headers = {} } = {}) {
  const h = { origin: SITE, 'sec-fetch-site': 'same-origin', ...headers }
  if (who) h.cookie = session(who, who.startsWith('free') ? 'free' : 'lifetime')
  if (body !== undefined) h['content-type'] = 'application/json'
  return new Request(SITE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
}
const call = async (fn, request, data = {}) => { const r = await fn({ request, env: ENV, data, params: {}, next: async () => new Response('next'), waitUntil() {} }); return { status: r.status, j: await r.json().catch(() => null) } }
const Q = (body, who) => call(S.quote.onRequestPost, req('POST', '/api/intents/quote', { body, who }))
const swapGet = (id, who) => call(S.swaps.onRequestGet, req('GET', '/api/intents/swaps' + (id ? '?id=' + id : ''), { who }))
const adminPost = body => call(S.admin.onRequestPost, req('POST', '/api/admin/intents', { body }), { adminEmail: 'owner@x.io' })
const adminGet = () => call(S.admin.onRequestGet, req('GET', '/api/admin/intents'), { adminEmail: 'owner@x.io' })
const reconcile = (key = 'rk-123') => call(S.reconcile.onRequest, new Request(SITE + '/api/intents/reconcile', { method: 'POST', headers: { 'x-refresh-key': key } }))
const base = { from: USDC_BASE, to: SOL, amount: '100', recipient: SOL_ME, refundTo: EVM_ME }
async function issue(over = {}, who) {
  const pv = await Q({ ...base, ...over, dry: true }, who)
  if (pv.status !== 200) return { pv }
  const r = await Q({ ...base, ...over, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut }, who)
  return { pv, r }
}
const row = async id => ENV.CLWA_CLUSTERS.raw.prepare('SELECT * FROM intents_swaps WHERE id = ?').get(id)
const setRowTime = (id, ms) => ENV.CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET updated_at = ? WHERE id = ?').run(ms, id)

// ═══════════════════════════════════════════════════════════════════════
section('pure: risk engine')
{
  const L = S.risk.LAUNCH_LIMITS, C = S.risk.NO_CONTROLS, U = { member24hUsd: 0, route24hUsd: 0, global24hUsd: 0, memberOpen: 0 }
  const T = { fromChain: 'base', toChain: 'sol', fromAsset: USDC_BASE, toAsset: SOL, usdIn: 100, costBps: 25, dry: false }
  const ev = (o = {}, u = {}, c = C, l = L) => S.risk.evaluate(l, c, { ...U, ...u }, { ...T, ...o })
  t('a normal trade passes', ev().allow)
  t('below min refused', ev({ usdIn: 1 }).hard.includes('below_min_trade'))
  t('above max refused', ev({ usdIn: L.maxTradeUsd + 1 }).hard.includes('above_max_trade'))
  t('member daily cap', ev({}, { member24hUsd: L.memberDailyUsd - 50 }).hard.includes('member_daily_cap'))
  t('route daily cap', ev({}, { route24hUsd: L.routeDailyUsd }).hard.includes('route_daily_cap'))
  t('global daily cap', ev({}, { global24hUsd: L.globalDailyUsd }).hard.includes('global_daily_cap'))
  t('open swaps cap (shown on the preview as well)', ev({}, { memberOpen: L.memberOpenSwaps }).hard.includes('too_many_open_swaps') && ev({ dry: true }, { memberOpen: 99 }).hard.includes('too_many_open_swaps'))
  t('unpriced origin: refused (preview shows the refusal too)', ev({ usdIn: null }).hard.includes('unpriced') && ev({ usdIn: null, dry: true }).hard.includes('unpriced'))
  t('unpriced DESTINATION (costBps null, usdIn known) refused — OGOU blocker 1', ev({ costBps: null }).hard.includes('unpriced') && !ev({ costBps: null }).allow)
  t('cost over block refused', ev({ costBps: L.costBlockBps + 1 }).hard.includes('price_deviation'))
  t('cost over warn only warns', ev({ costBps: L.costWarnBps + 1 }).allow && ev({ costBps: L.costWarnBps + 1 }).warn.includes('high_cost'))
  t('global pause refuses', ev({}, {}, { ...C, globalPaused: 'x' }).hard.includes('paused_global'))
  t('route pause refuses only that route', ev({}, {}, { ...C, routes: { 'base>sol': 'x' } }).hard.includes('paused_route') && ev({ toChain: 'arb' }, {}, { ...C, routes: { 'base>sol': 'x' } }).allow)
  t('chain pause refuses either side', ev({}, {}, { ...C, chains: { sol: 'x' } }).hard.includes('paused_chain'))
  t('asset pause refuses', ev({}, {}, { ...C, assets: { [SOL]: 'x' } }).hard.includes('paused_asset'))
  t('unknown chain refused', ev({ toChain: 'xrp' }).hard.includes('route_not_allowed'))
  t('mergeLimits ignores junk and above-ceiling values', S.risk.mergeLimits({ maxTradeUsd: 'lots', memberDailyUsd: 9e12, minTradeUsd: -1 }).maxTradeUsd === L.maxTradeUsd
    && S.risk.mergeLimits({ memberDailyUsd: 9e12 }).memberDailyUsd === L.memberDailyUsd)
  t('mergeLimits applies a valid override', S.risk.mergeLimits({ maxTradeUsd: 500 }).maxTradeUsd === 500)
  t('mergeLimits keeps min ≤ max', S.risk.mergeLimits({ minTradeUsd: 900, maxTradeUsd: 100 }).minTradeUsd <= 100)
  t('every reason code has member-facing text', ['paused_global', 'paused_route', 'paused_chain', 'paused_asset', 'route_not_allowed', 'unpriced', 'below_min_trade', 'above_max_trade',
    'member_daily_cap', 'route_daily_cap', 'global_daily_cap', 'too_many_open_swaps', 'price_deviation', 'high_cost'].every(k => S.risk.REASON_TEXT[k]))
}

section('pure: state machine')
{
  const N = S.ledger.nextState, now = 1e12
  const ok = (cur, up, want, an = null, dl = null) => { const r = N(cur, up, now, dl); return r.state === want && r.anomaly === an }
  t('awaiting + PENDING stays', ok('awaiting_deposit', 'PENDING_DEPOSIT', 'awaiting_deposit'))
  t('awaiting → deposit_seen', ok('awaiting_deposit', 'KNOWN_DEPOSIT_TX', 'deposit_seen'))
  t('awaiting → processing (skipping a step is forward)', ok('awaiting_deposit', 'PROCESSING', 'processing'))
  t('processing → delivered_claimed on SUCCESS (never straight to settled)', ok('processing', 'SUCCESS', 'delivered_claimed'))
  t('processing → refunded', ok('processing', 'REFUNDED', 'refunded'))
  t('deposit_seen ↔ incomplete_deposit allowed both ways', ok('deposit_seen', 'INCOMPLETE_DEPOSIT', 'incomplete_deposit') && ok('incomplete_deposit', 'KNOWN_DEPOSIT_TX', 'deposit_seen'))
  t('regression processing → PENDING ignored + flagged', ok('processing', 'PENDING_DEPOSIT', 'processing', 'status_regressed'))
  t('regression delivered_claimed → PROCESSING flagged', ok('delivered_claimed', 'PROCESSING', 'delivered_claimed', 'status_regressed'))
  t('final refunded contradicted by SUCCESS flagged, not applied', ok('refunded', 'SUCCESS', 'refunded', 'final_state_contradicted'))
  t('final settled + SUCCESS is consistent', ok('settled', 'SUCCESS', 'settled'))
  t('final failed + FAILED is consistent', ok('failed', 'FAILED', 'failed'))
  t('unknown upstream status flagged', ok('processing', 'HACKED', 'processing', 'unknown_upstream_status'))
  t('no answer before deadline: unchanged', ok('awaiting_deposit', null, 'awaiting_deposit', null, now + 1))
  t('no answer after deadline: expired', ok('awaiting_deposit', null, 'expired', null, now - 1))
  t('expired + late deposit reopens (money is real)', ok('expired', 'KNOWN_DEPOSIT_TX', 'deposit_seen', 'late_deposit'))
  t('expired + still PENDING stays expired', ok('expired', 'PENDING_DEPOSIT', 'expired'))
  t('reserving / abandoned never move', ok('reserving', 'SUCCESS', 'reserving') && ok('abandoned', 'SUCCESS', 'abandoned'))
  const F = (o, an = null) => S.ledger.reconcileFlags({ state: 'settled', from_chain: 'base', updated_at: now, min_amount_out: '1000', amount_out_actual: '1000', refunded: null, dest_txs: '[{"hash":"0x1"}]', dest_verified: 'verified', verify_attempts: 1, ...o }, now, an)
  t('clean settled swap has no flags', F({}).length === 0)
  t('under-delivered flagged', F({ amount_out_actual: '999' }).includes('under_delivered'))
  t('short on-chain payout flagged as under_delivered', F({ dest_verified: 'short' }).includes('under_delivered'))
  t('no destination tx flagged', F({ dest_txs: '[]' }).includes('no_dest_tx'))
  t('failed destination tx flagged', F({ dest_verified: 'failed' }).includes('dest_tx_failed'))
  t('unverified after grace flagged', F({ state: 'delivered_claimed', dest_verified: 'pending', verify_attempts: 12, state_at: now - 30 * 60e3 }).includes('dest_unverified'))   // round 25: 12 passes AND 20 min in the state
  t('unverified before grace not flagged', !F({ state: 'delivered_claimed', dest_verified: 'pending', verify_attempts: 3 }).includes('dest_unverified'))
  t('refund without amount flagged (review, not critical)', F({ state: 'refunded', refunded: '0' }).includes('refund_missing') && !S.ledger.CRITICAL_FLAGS.has('refund_missing'))
  t('stuck processing after 1 h (EVM)', F({ state: 'processing', updated_at: now - 61 * 60e3 }).includes('stuck'))
  t('BTC gets 6 h before stuck', !F({ state: 'processing', from_chain: 'btc', updated_at: now - 2 * 3600e3 }).includes('stuck'))
}

section('pure: destination verification')
{
  const J = S.verify.judgeEvm, pad = a => '0x' + '0'.repeat(24) + a.slice(2)
  const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const usdcArb = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
  const rc = (val, to = EVM_ME, token = usdcArb, status = '0x1') => ({ status, logs: [{ address: token, topics: [T0, pad(EVM_ME2), pad(to)], data: '0x' + val.toString(16).padStart(64, '0') }] })
  t('ERC-20 paid ≥ min → verified', J(rc(1000n), null, USDC_ARB, EVM_ME, 1000n) === 'verified')
  t('ERC-20 paid < min → short', J(rc(999n), null, USDC_ARB, EVM_ME, 1000n) === 'short')
  t('ERC-20 paid to someone else → pending (not success)', J(rc(5000n, EVM_ME2), null, USDC_ARB, EVM_ME, 1000n) === 'pending')
  t('ERC-20 from a DIFFERENT token contract ignored', J(rc(5000n, EVM_ME, '0x' + '1'.repeat(40)), null, USDC_ARB, EVM_ME, 1000n) === 'pending')
  t('reverted tx → failed', J(rc(5000n, EVM_ME, usdcArb, '0x0'), null, USDC_ARB, EVM_ME, 1n) === 'failed')
  t('no receipt yet → pending', J(null, null, USDC_ARB, EVM_ME, 1n) === 'pending')
  t('junk receipt → pending', J({ status: 'yes' }, null, USDC_ARB, EVM_ME, 1n) === 'pending')
  t('native: tx.to = recipient, value ≥ min → verified', J({ status: '0x1', logs: [] }, { to: EVM_ME, value: '0x3e8' }, ETH_ARB, EVM_ME, 1000n) === 'verified')
  t('native: contract-routed → confirmed (not over-claimed)', J({ status: '0x1', logs: [] }, { to: EVM_ME2, value: '0x0' }, ETH_ARB, EVM_ME, 1000n) === 'confirmed')
  t('unknown asset with NO transfer to the recipient → pending (OGOU obs.)', J({ status: '0x1', logs: [] }, null, WNEAR, EVM_ME, 1n) === 'pending')
  // round 22: an unrecognised asset is never proven by 'some token reached the recipient' (a junk airdrop would do)
  t('unknown asset with a transfer to the recipient → still pending (not proven)', J(rc(5n, EVM_ME, '0x' + '2'.repeat(40)), null, WNEAR, EVM_ME, 1n) === 'pending')
  t('native balance delta ≥ min → verified', S.verify.judgeNativeDelta(100n, 1100n, 1000n) === 'verified')
  // round 24: a partial rise proves nothing (1 wei from anyone used to settle); still never a false "short"
  t('native balance rose but below min → pending (unproven), never confirmed, never a false "short"', S.verify.judgeNativeDelta(100n, 600n, 1000n) === 'pending')
  // round 23: no rise, or no reading, is NOT proof — 'confirmed' settles a swap, and any unrelated tx used to earn it
  t('native balance did not rise, or could not be read → pending (unproven), never confirmed', S.verify.judgeNativeDelta(100n, 50n, 1n) === 'pending' && S.verify.judgeNativeDelta(null, 5n, 1n) === 'pending' && S.verify.judgeNativeDelta(5n, null, 1n) === 'pending')
  const sol = (d, err = null) => ({ meta: { err, preBalances: [5, 100], postBalances: [5, 100 + d] }, transaction: { message: { accountKeys: [{ pubkey: 'X', signer: true }, { pubkey: SOL_ME, signer: false }] } } })   // the real jsonParsed shape (round 25)
  t('SOL native delta ≥ min → verified', S.verify.judgeSol(sol(1000), SOL, SOL_ME, 1000n) === 'verified')
  t('SOL native delta < min → short', S.verify.judgeSol(sol(10), SOL, SOL_ME, 1000n) === 'short')
  t('SOL error → failed', S.verify.judgeSol(sol(1000, { InstructionError: 1 }), SOL, SOL_ME, 1n) === 'failed')
  const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const spl = (pre, post, mint = MINT) => ({ meta: { err: null, preTokenBalances: [{ owner: SOL_ME, mint, uiTokenAmount: { amount: String(pre) } }], postTokenBalances: [{ owner: SOL_ME, mint, uiTokenAmount: { amount: String(post) } }] }, transaction: { message: { accountKeys: [] } } })
  t('SPL with mint: delta ≥ min → verified', S.verify.judgeSol(spl(5, 1005), 'x', SOL_ME, 1000n, MINT) === 'verified')
  t('SPL with mint: delta < min → short', S.verify.judgeSol(spl(5, 900), 'x', SOL_ME, 1000n, MINT) === 'short')
  t('SPL: a different mint paid → not counted', S.verify.judgeSol(spl(5, 99999, 'OtherMint1111111111111111111111111111111111'), 'x', SOL_ME, 1000n, MINT) === 'pending')
  // round 22: an SPL payout with no mint to check is not proven
  t('SPL without a known mint → pending (not proven)', S.verify.judgeSol(spl(5, 1005), 'x', SOL_ME, 1000n, null) === 'pending')
  t('SOL recipient absent → pending', S.verify.judgeSol(sol(1000), SOL, 'Other1111111111111111111111111111111111111', 1n) === 'pending')
  t('BTC unconfirmed → pending', S.verify.judgeBtc({ status: { confirmed: false }, vout: [{ scriptpubkey_address: 'bc1x', value: 5000 }] }, 'bc1x', 1n) === 'pending')
  t('BTC confirmed ≥ min → verified', S.verify.judgeBtc({ status: { confirmed: true, block_height: 100 }, vout: [{ scriptpubkey_address: 'bc1x', value: 5000 }] }, 'bc1x', 5000n, 101) === 'verified')
  t('BTC confirmed < min → short', S.verify.judgeBtc({ status: { confirmed: true, block_height: 100 }, vout: [{ scriptpubkey_address: 'bc1x', value: 4999 }] }, 'bc1x', 5000n, 101) === 'short')
  t('asset parsing: erc20 / native / other', S.verify.evmAssetOf(USDC_ARB)?.kind === 'erc20' && S.verify.evmAssetOf(ETH_ARB)?.kind === 'native' && S.verify.evmAssetOf(WNEAR) === null)
  // round 27: NEAR payouts are checked on-chain now; Tron is still the desk's word-of-1Click case
  t('Tron destination is labelled unverifiable', await S.verify.verifyDestination(fetch, 'tron', 'nep141:tron.omft.near', 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', 1n, [{ hash: 'x' }]) === 'unverifiable')
  t('NEAR destination is checked (a malformed hash is unproven, not unverifiable)', await S.verify.verifyDestination(fetch, 'near', WNEAR, 'alice.near', 1n, [{ hash: 'x' }]) === 'pending')
}

// ═══════════════════════════════════════════════════════════════════════
section('auth + gate')
await freshEnv()
// Standalone desk: public, no account. What protects it is the secret, the budgets and the tokens.
t('no account needed: an anonymous preview → 200', (await Q({ ...base, dry: true }, null)).status === 200)
for (const [label, extra] of [['DESK_SECRET unset', { DESK_SECRET: undefined }], ['DESK_SECRET too short (31 chars)', { DESK_SECRET: 'x'.repeat(31) }], ['DESK_SECRET only whitespace', { DESK_SECRET: ' '.repeat(40) }]]) {
  await freshEnv(extra)
  const r = await Q({ ...base, dry: true })
  t(label + ' → 503 not_configured (fails closed, never a guessable key)', r.status === 503 && r.j.error === 'not_configured', r.status + ' ' + r.j?.error)
}
await freshEnv()
t('cross-site POST → 403', (await call(S.quote.onRequestPost, req('POST', '/api/intents/quote', { body: { ...base, dry: true }, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }))).status === 403)
t('tokens: public → 200 with allowlisted chains only', await (async () => { const r = await call(S.tokens.onRequestGet, req('GET', '/api/intents/tokens')); return r.status === 200 && r.j.tokens.every(x => x.chain in S.lib.CHAINS) && r.j.enabled })())
t('non-JSON body → 415', (await call(S.quote.onRequestPost, new Request(SITE + '/api/intents/quote', { method: 'POST', headers: { cookie: session('paid@x.io'), origin: SITE, 'content-type': 'text/plain' }, body: 'x' }))).status === 415)
t('oversize body → 413', (await Q({ ...base, dry: true, pad: 'x'.repeat(5000) })).status === 413)

section('dry preview')
await freshEnv()
{
  const r = await Q({ ...base, dry: true })
  t('dry quote 200', r.status === 200, JSON.stringify(r.j))
  t('dry has no deposit address anywhere', !JSON.stringify(r.j).includes('depositAddress'))
  t('cost measured against CoinGecko, not the router', r.j.terms.price.source === 'market' && Number.isFinite(r.j.terms.price.costBps))
  t('fee breakdown: 1Click 20 bps, ours 0', r.j.terms.fees.platformBps === 20 && r.j.terms.fees.oursBps === 0)
  t('request to 1Click carried the fixed safe types', W.lastQuoteBody.depositType === 'ORIGIN_CHAIN' && W.lastQuoteBody.recipientType === 'DESTINATION_CHAIN' && W.lastQuoteBody.swapType === 'EXACT_INPUT')
  t('nothing written to the ledger for a preview', ENV.CLWA_CLUSTERS.raw.prepare('SELECT COUNT(*) n FROM intents_swaps').get().n === 0)
  W.cgDown = 'both'; S.io.__resetPriceCache()   // CoinGecko AND DeFiLlama down, nothing cached
  const u = await Q({ ...base, dry: true })
  t('price source down: dry still previews, and says no address will be issued', u.status === 200 && u.j.terms.price.source === 'none' && u.j.terms.risk.hard.includes('unpriced') && !u.j.terms.risk.allow)
  W.cgDown = false
  t('bad recipient → 400 with field + plain message', await (async () => { const x = await Q({ ...base, recipient: EVM_ME, dry: true }); return x.status === 400 && x.j.field === 'recipient' && /not valid/.test(x.j.message) })())
  W.quoteMode = '400'
  const lo = await Q({ ...base, amount: '0.5', dry: true })
  t('router refusal message passed through (as data)', lo.status === 400 && lo.j.error === 'router_rejected' && /too low/.test(lo.j.message))
}

section('issuing a deposit address')
await freshEnv()
{
  t('real quote without idempotencyKey → 400', (await Q({ ...base, dry: false, acceptedAmountOut: '1' })).j.error === 'bad_idempotency_key')
  t('real quote without accepted terms → 400', (await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID() })).j.error === 'accepted_terms_missing')
  const { pv, r } = await issue()
  t('issued 200 with a deposit address', r.status === 200 && /^0x[0-9a-f]{40}$/.test(r.j.swap.depositAddress), JSON.stringify(r.j))
  const db = await row(r.j.swap.id)
  t('ledger row written BEFORE it was shown (state awaiting_deposit)', db && db.state === 'awaiting_deposit' && db.deposit_address === r.j.swap.depositAddress)
  t('ledger keeps the signed quote for disputes', db.signature === 'ed25519:test' && db.quote_json.includes('correlationId'))
  t('issue event logged', ENV.CLWA_CLUSTERS.raw.prepare("SELECT COUNT(*) n FROM intents_events WHERE kind='issued'").get().n === 1)
  // Owner's rule: no date leaves the desk — not 1Click's raw quote (its timestamp and deadlines),
  // not a deadline, not a creation or update time.
  const answer = JSON.stringify(r.j)
  t('no date or timestamp in the answer (no raw quote, deadline, createdAt or updatedAt)', r.j.receipt === undefined && !/\d{4}-\d{2}-\d{2}|\b1\d{12}\b|deadline|createdAt|updatedAt/.test(answer), answer.slice(0, 300))
  // The router answers a 1 h request with a 3-day deadline (measured live). The desk
  // offers the address until ITS deadline, so an unpaid address frees its slot.
  const sl = r.j.swap.secondsLeft, mins = S.lib.CHAINS.base.deadlineMin
  t(`deposit address offered until the desk's own deadline (≤ ${mins} min), not the router's 3 days`, sl <= mins * 60 + 5 && sl > (mins - 2) * 60, sl)
  t('swap token returned once, 64 hex', /^[0-9a-f]{64}$/.test(r.j.token || ''))
  void pv
}

section('idempotency + races')
await freshEnv()
{
  const pv = await Q({ ...base, dry: true })
  const key = crypto.randomUUID()
  const body = { ...base, dry: false, idempotencyKey: key, acceptedAmountOut: pv.j.terms.amountOut }
  const a = await Q(body), b = await Q(body)
  t('retry with the same key → same swap, same address', a.j.swap.id === b.j.swap.id && a.j.swap.depositAddress === b.j.swap.depositAddress && b.j.replay === true)
  t('retry did not call 1Click again', W.calls.quoteReal === 1, W.calls.quoteReal)
  const c = await Q({ ...body, amount: '101' })
  t('same key, different deal → 409 conflict', c.status === 409 && c.j.error === 'idempotency_conflict')
  const key2 = crypto.randomUUID()
  W.quoteMode = 'slow'
  const many = await Promise.all(Array.from({ length: 8 }, () => Q({ ...body, idempotencyKey: key2 })))
  const addrs = new Set(many.filter(x => x.status === 200).map(x => x.j.swap.depositAddress))
  t('8 simultaneous clicks → exactly one deposit address', addrs.size === 1, JSON.stringify(many.map(x => x.status)))
  t('…and the others were told to wait, got the same swap, or were rate-limited', many.every(x => x.status === 200 || (x.status === 409 && x.j.error === 'in_progress') || (x.status === 429 && x.j.error === 'rate_limited')), JSON.stringify(many.map(x => x.j?.error || x.status)))
  t('…and 1Click was asked for a real quote at most once for that key', W.calls.quoteReal <= 2, W.calls.quoteReal)
  // Standalone desk: the request key is scoped to the desk, not to the IP — a phone
  // that changes networks between the press and the retry must get its swap back,
  // never a second address. Only the holder of the (random, never shown) key can.
  t('same key from another network → the SAME swap and its token, never a second address', await (async () => {
    const o = await Q(body, 'other@x.io'); return o.status === 200 && o.j.swap.id === a.j.swap.id && /^[0-9a-f]{64}$/.test(o.j.token || '') })())
  t('…but a client that holds neither key nor token cannot see that swap', (await swapGet(a.j.swap.id, 'free@x.io')).status === 404)
}

section('untrusted router answers')
for (const [mode, want] of [['tamper', 'router_answer_rejected'], ['memo', 'router_answer_rejected'], ['500', 'router_unavailable'], ['timeout', 'router_unavailable']]) {
  await freshEnv()
  const pv = await Q({ ...base, dry: true })
  W.quoteMode = mode
  const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })
  const rows = ENV.CLWA_CLUSTERS.raw.prepare('SELECT state FROM intents_swaps').all()
  t(`${mode}: refused (${want}), no address shown, reservation abandoned`,
    r.status >= 400 && r.j.error === want && !JSON.stringify(r.j).includes('depositAddress') && rows.length === 1 && rows[0].state === 'abandoned', JSON.stringify(r.j) + JSON.stringify(rows))
}
await freshEnv()
W.oneclickDown = true
t('router fully down → 503, nothing issued', (await Q({ ...base, dry: true })).status === 503)
await freshEnv()
W.quoteMode = 'noliq-once'
{
  const r = await Q({ ...base, dry: true })
  t('"No liquidity" on the fast path → one retry with a 3 s solver wait → priced', r.status === 200 && W.calls.quoteDry === 2 && W.lastQuoteBody.quoteWaitingTimeMs === 3000)
  W.quoteMode = 'noliq'; W.calls.quoteDry = 0
  const r2 = await Q({ ...base, dry: true })
  t('…a second "No liquidity" is reported, not retried forever', r2.status === 400 && r2.j.error === 'router_rejected' && W.calls.quoteDry === 2)
}

section('risk at issue time')
await freshEnv()
{
  W.cgPrice.solana = 70           // router pays as if SOL were $101; at the market's $70 the member loses ~31%
  const pv = await Q({ ...base, dry: true })
  t('preview shows the deviation and that it will be refused', pv.j.terms.price.costBps > 800 && pv.j.terms.risk.hard.includes('price_deviation'))
  const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })
  t('price deviation → 422, no address', r.status === 422 && r.j.error === 'price_deviation' && !JSON.stringify(r.j).includes('"depositAddress"'))
}
await freshEnv()
{
  W.cgDown = 'both'; S.io.__resetPriceCache()   // CoinGecko AND DeFiLlama down, nothing cached
  const pv = await Q({ ...base, dry: true })
  const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })
  t('unpriced → no deposit address (cannot size the trade)', r.status === 422 && r.j.error === 'unpriced')
}
await freshEnv()
{
  delete W.cgPrice.solana     // origin (USDC) priced, destination (SOL) not
  const pv = await Q({ ...base, dry: true })
  const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })
  t('destination unpriced → preview refuses AND no address (OGOU blocker 1)', !pv.j.terms.risk.allow && r.status === 422 && r.j.error === 'unpriced' && W.calls.quoteReal === 1
    && ENV.CLWA_CLUSTERS.raw.prepare("SELECT state FROM intents_swaps").get().state === 'abandoned')
}
await freshEnv()
{
  const pv = await Q({ ...base, dry: true })
  W.reapOnQuote = true        // the reconciler reaps the reservation while 1Click is answering
  const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })
  t('reservation lost mid-request → 503, NO address and NO receipt (OGOU blocker 2)', r.status === 503 && r.j.error === 'ledger_write_failed'
    && !JSON.stringify(r.j).includes('depositAddress') && !r.j.receipt, JSON.stringify(r.j).slice(0, 300))
  t('…and it is logged as critical', ENV.CLWA_CLUSTERS.raw.prepare("SELECT COUNT(*) n FROM intents_events WHERE kind='critical' AND detail LIKE '%ledger_fill_lost%'").get().n === 1)
}
await freshEnv()
{
  const pv = await Q({ ...base, dry: true })
  W.pauseOnQuote = true       // the owner hits the kill switch while 1Click is answering
  const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })
  t('kill switch pressed mid-request still wins → 423, no address', r.status === 423 && !JSON.stringify(r.j).includes('depositAddress'))
}
await freshEnv()
{
  const pv = await Q({ ...base, dry: true })
  W.quoteMode = 'lowmin'      // router answers with a minimum below the slippage we asked for
  const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })
  t('minimum below our slippage → refused, no address', r.status === 502 && r.j.detail === 'min_out_below_slippage')
}
await freshEnv()
{
  const big = await issue({ amount: '3000' })
  t('above per-swap max → 422', big.r.status === 422 && big.r.j.error === 'above_max_trade')
  const tiny = await issue({ amount: '1' })
  t('below min → 422', tiny.r.status === 422 && tiny.r.j.error === 'below_min_trade')
  ENV.CLWA_SESSIONS._m.clear()
  const BTC = 'nep141:btc.omft.near'
  const smallBtc = await issue({ to: BTC, recipient: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: '20' })
  t('$20 into BTC refused (fee-dominated payout, measured)', smallBtc.r.status === 422 && smallBtc.r.j.error === 'below_min_trade_utxo' && /16%/.test(smallBtc.r.j.message))
  ENV.CLWA_SESSIONS._m.clear()
  t('$60 into BTC allowed', (await issue({ to: BTC, recipient: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: '60' })).r.status === 200)
  t('$20 into SOL allowed (no UTXO floor)', (await issue({ amount: '20' })).r.status === 200)
  ENV.CLWA_SESSIONS._m.clear()
  let last
  for (let i = 0; i < 6; i++) { ENV.CLWA_SESSIONS._m.clear(); ENV.CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET created_at = created_at - 61000').run(); ENV.CLWA_CLUSTERS.raw.prepare('DELETE FROM intents_rl').run(); last = await issue({ amount: '200' }) }   // a minute between swaps, so the 6-per-minute budget is not what answers   // isolate the open-swap cap from the rate limit
  t('6th open swap refused (cap 5 waiting for deposit)', last.r.status === 422 && last.r.j.error === 'too_many_open_swaps', JSON.stringify(last.r.j))
}
await freshEnv()
{
  // member daily cap: settle-free path, lower the cap via the admin panel
  await adminPost({ action: 'limits', limits: { memberDailyUsd: 450, memberOpenSwaps: 50 } })
  const a = await issue({ amount: '200' }), b = await issue({ amount: '200' }), c = await issue({ amount: '200' })
  t('member 24 h cap enforced across swaps', a.r.status === 200 && b.r.status === 200 && c.r.status === 422 && c.r.j.error === 'member_daily_cap', [a.r.status, b.r.status, c.r.status, c.r.j?.error].join(','))
  t('cap is per member (another member unaffected)', (await issue({ amount: '200' }, 'other@x.io')).r.status === 200)
}
await freshEnv()
{
  const pv = await Q({ ...base, dry: true })
  W.outFactor = 0.99   // the real quote is 1% worse than the preview
  const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })
  t('worse real price → 409 terms_changed, no address, fresh terms returned', r.status === 409 && r.j.error === 'terms_changed' && r.j.terms && !JSON.stringify(r.j).includes('"depositAddress"'))
  W.outFactor = 0.999  // 0.1% worse: inside the 0.25% tolerance
  const ok = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })
  t('a tiny move inside tolerance still issues', ok.status === 200)
}

section('NEAR recipients')
await freshEnv()
{
  const near = { from: USDC_BASE, to: WNEAR, amount: '50', refundTo: EVM_ME }
  t('existing named account → issued', (await issue({ ...near, recipient: 'alice.near' })).r.status === 200)
  const miss = await issue({ ...near, recipient: 'ghost-account.near' })
  t('missing named account → 400 near_account_missing', miss.r.status === 400 && miss.r.j.error === 'near_account_missing')
  W.nearDown = true
  const down = await issue({ ...near, recipient: 'alice.near' })
  t('NEAR RPC down → 503 (fail closed)', down.r.status === 503 && down.r.j.error === 'near_account_unchecked')
  t('implicit 64-hex account needs no lookup', (await issue({ ...near, recipient: 'f'.repeat(64) })).r.status === 200)
}

section('NEAR key checker: who can sign for the payout account')
await freshEnv()
{
  const near = { from: USDC_BASE, to: WNEAR, amount: '50', refundTo: EVM_ME, dry: true }
  const K = (pk, perm = 'FullAccess') => ({ access_key: { nonce: 1, permission: perm }, public_key: pk })
  const PK1 = 'ed25519:njV8oUZbvd1HswZiKL8j7zx2U1wnvaLQiysYDRPMBsF', PK2 = 'ed25519:oxEocH88sCavwDRXqoMtryK2Qm9Af72jxMsvsQGHQJx'
  const nk = (r) => r.j && r.j.terms && r.j.terms.nearKeys
  const warns = (r) => (r.j && r.j.terms && r.j.terms.risk.warn) || []
  const keyWarns = (r) => warns(r).filter(w => /^near_keys_/.test(w))

  let r = await Q({ ...near, recipient: 'alice.near' })
  t('preview to a NEAR account lists its full-access key', r.status === 200 && nk(r) && nk(r).checked === true && nk(r).account === 'alice.near' && JSON.stringify(nk(r).full) === JSON.stringify([PK1]), JSON.stringify(nk(r)))
  t('…one key: no key warning', keyWarns(r).length === 0, JSON.stringify(warns(r)))

  W.nearKeys = { 'alice.near': [K(PK1), K(PK2)] }
  r = await Q({ ...near, recipient: 'alice.near' })
  t('a second full-access key → warned and both listed', keyWarns(r).join() === 'near_keys_several' && nk(r).full.length === 2, JSON.stringify(warns(r)))
  t('…a warning, not a refusal (the desk cannot know whose keys they are)', r.j.terms.risk.allow === true)
  t('…the warning text is shown', r.j.terms.risk.text.some(s => /more than one full-access key/.test(s)), JSON.stringify(r.j.terms.risk.text))
  const real = await issue({ ...near, dry: undefined, recipient: 'alice.near' })
  t('…and a real deposit address can still be issued', real.r.status === 200 && real.r.j.terms.risk.warn.includes('near_keys_several'), JSON.stringify(real.r.j).slice(0, 200))

  W.nearKeys = { 'alice.near': [K(PK1), K(PK2, { FunctionCall: { allowance: null, method_names: [], receiver_id: 'app.near' } })] }
  r = await Q({ ...near, recipient: 'alice.near' })
  t('a function-call (app) key is counted, not listed as full access, no warning', nk(r).full.length === 1 && nk(r).limited === 1 && keyWarns(r).length === 0, JSON.stringify(nk(r)))

  W.nearAccounts.add('vault.near'); W.nearKeys = { 'vault.near': [] }
  r = await Q({ ...near, recipient: 'vault.near' })
  t('an existing account with no keys → locked, warned', nk(r).locked === true && keyWarns(r).join() === 'near_keys_locked', JSON.stringify(nk(r)))

  W.nearKeys = {}
  W.nearTooMany = 'alice.near'
  r = await Q({ ...near, recipient: 'alice.near' })
  t('more than 100 keys → "cannot list", warned', nk(r).tooMany === true && keyWarns(r).join() === 'near_keys_too_many', JSON.stringify(nk(r)))
  W.nearTooMany = null
  W.nearDown = true
  r = await Q({ ...near, recipient: 'alice.near' })
  t('NEAR nodes down → "could not check", warned, preview still shown', r.status === 200 && nk(r).checked === false && keyWarns(r).join() === 'near_keys_unchecked', JSON.stringify(r.j).slice(0, 200))
  W.nearDown = false

  r = await Q({ from: WNEAR, to: USDC_BASE, amount: '10', recipient: EVM_ME, refundTo: 'alice.near', dry: true })
  t('payout to another chain → no NEAR key block in the terms', r.status === 200 && !('nearKeys' in r.j.terms), JSON.stringify(r.j).slice(0, 200))
  t('every key-checker warning has its text', ['near_keys_several', 'near_keys_locked', 'near_keys_too_many', 'near_keys_unchecked'].every(k => S.risk.REASON_TEXT[k]))
}

section('kill switch')
await freshEnv()
{
  const { r } = await issue()
  const id = r.j.swap.id
  t('pause needs a reason', (await adminPost({ action: 'pause', scope: 'route', key: 'base>sol' })).status === 400)
  t('pause rejects a non-allowlisted route', (await adminPost({ action: 'pause', scope: 'route', key: 'base>xrp', reason: 'x' })).status === 400)
  t('pause route ok', (await adminPost({ action: 'pause', scope: 'route', key: 'base>sol', reason: 'drill' })).status === 200)
  t('paused route → 423 on preview', (await Q({ ...base, dry: true })).status === 423)
  t('other routes still quote', (await Q({ ...base, to: USDC_ARB, recipient: EVM_ME, dry: true })).status === 200)
  W.status.set(r.j.swap.depositAddress, { status: 'KNOWN_DEPOSIT_TX', updatedAt: 'x', swapDetails: {} })
  setRowTime(id, Date.now() - 60e3)
  const g = await swapGet(id)
  t('in-flight swap on a paused route is still tracked', g.status === 200 && g.j.swap.state === 'deposit_seen')
  t('the tokens list reports the paused route', (await call(S.tokens.onRequestGet, req('GET', '/api/intents/tokens'))).j.pausedRoutes.includes('base>sol'))
  t('resume → quotes again', (await adminPost({ action: 'resume', scope: 'route', key: 'base>sol' })).status === 200 && (await Q({ ...base, dry: true })).status === 200)
  await adminPost({ action: 'pause', scope: 'global', reason: 'drill' })
  t('global pause → every route 423', (await Q({ ...base, to: USDC_ARB, recipient: EVM_ME, dry: true })).status === 423)
  t('global pause shows in tokens (enabled=false)', (await call(S.tokens.onRequestGet, req('GET', '/api/intents/tokens'))).j.enabled === false)
  await adminPost({ action: 'resume', scope: 'global' })
  await adminPost({ action: 'pause', scope: 'asset', key: SOL, reason: 'drill' })
  t('asset pause → 423', (await Q({ ...base, dry: true })).status === 423)
  await adminPost({ action: 'resume', scope: 'asset', key: SOL })
  t('every control change is in the audit log', ENV.CLWA_CLUSTERS.raw.prepare("SELECT COUNT(*) n FROM intents_events WHERE kind LIKE 'control_%'").get().n === 6)
}
await freshEnv({ INTENTS_ENABLED: '0' })
t('deploy-level switch INTENTS_ENABLED=0 → 503 on quotes', (await Q({ ...base, dry: true })).status === 503)

section('lifecycle: settle only after on-chain verification')
await freshEnv()
{
  const { r } = await issue({ to: USDC_ARB, recipient: EVM_ME })
  const id = r.j.swap.id, dep = r.j.swap.depositAddress
  const minOut = BigInt(r.j.swap.minAmountOut)
  const step = async (status, details = {}) => {
    W.status.set(dep, { status, updatedAt: new Date().toISOString(), swapDetails: details })
    setRowTime(id, Date.now() - 60e3)
    return (await swapGet(id)).j.swap
  }
  t('PENDING → awaiting_deposit', (await step('PENDING_DEPOSIT')).state === 'awaiting_deposit')
  t('KNOWN_DEPOSIT_TX → deposit_seen', (await step('KNOWN_DEPOSIT_TX', { depositedAmount: '200000000' })).state === 'deposit_seen')
  t('PROCESSING → processing', (await step('PROCESSING')).state === 'processing')
  const hash = '0x' + 'ab'.repeat(32)
  const s1 = await step('SUCCESS', { amountOut: minOut.toString(), destinationChainTxHashes: [{ hash, explorerUrl: 'https://arbiscan.io/tx/' + hash }] })
  t('SUCCESS with no receipt on-chain yet → delivered_claimed, NOT settled', s1.state === 'delivered_claimed' && s1.destVerified === 'pending')
  const pad = a => '0x' + '0'.repeat(24) + a.slice(2)
  W.receipts.set(hash, { status: '0x1', logs: [{ address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(EVM_ME2), pad(EVM_ME)], data: '0x' + minOut.toString(16).padStart(64, '0') }] })
  const s2 = await step('SUCCESS', { amountOut: minOut.toString(), destinationChainTxHashes: [{ hash, explorerUrl: 'https://arbiscan.io/tx/' + hash }] })
  t('receipt pays recipient ≥ min → settled + verified', s2.state === 'settled' && s2.destVerified === 'verified', JSON.stringify(s2))
  const evBefore = ENV.CLWA_CLUSTERS.raw.prepare('SELECT COUNT(*) n FROM intents_events').get().n
  setRowTime(id, Date.now() - 60e3)
  await swapGet(id); await swapGet(id)
  t('duplicate SUCCESS after settled changes nothing', ENV.CLWA_CLUSTERS.raw.prepare('SELECT COUNT(*) n FROM intents_events').get().n === evBefore && (await row(id)).state === 'settled')
  t('other member cannot read it (404)', (await swapGet(id, 'other@x.io')).status === 404)
  t('history lists my swap only', (await swapGet(null)).j.swaps.length === 1 && (await swapGet(null, 'other@x.io')).j.swaps.length === 0)
}

section('discrepancies auto-pause')
await freshEnv()
{
  const issueArb = async () => (await issue({ to: USDC_ARB, recipient: EVM_ME })).r.j.swap
  const shortPay = async sw => {
    const hash = '0x' + crypto.randomBytes(32).toString('hex')
    const pad = a => '0x' + '0'.repeat(24) + a.slice(2)
    W.receipts.set(hash, { status: '0x1', logs: [{ address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(EVM_ME2), pad(EVM_ME)], data: '0x' + (BigInt(sw.minAmountOut) - 1n).toString(16).padStart(64, '0') }] })
    W.status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.minAmountOut, destinationChainTxHashes: [{ hash, explorerUrl: 'https://arbiscan.io/tx/' + hash }] } })
    setRowTime(sw.id, Date.now() - 60e3)
    return (await swapGet(sw.id)).j.swap
  }
  const a = await issueArb()
  const sa = await shortPay(a)
  t('short on-chain payout → stays delivered_claimed (never settled)', sa.state === 'delivered_claimed' && sa.destVerified === 'short')
  const ctl = (await adminGet()).j.controls
  t('…and its route was auto-paused with the reason', !!ctl.routes['base>arb'] && /under_delivered/.test(ctl.routes['base>arb']))
  t('…new quotes on that route refused', (await Q({ ...base, to: USDC_ARB, recipient: EVM_ME, dry: true })).status === 423)
  t('…other routes unaffected', (await Q({ ...base, dry: true })).status === 200)
  t('admin sees it in flagged', (await adminGet()).j.flagged.some(f => f.id === a.id))
  // two more critical swaps on other routes → global pause
  const other1 = (await issue({ from: USDC_ARB, to: USDC_BASE, recipient: EVM_ME, refundTo: EVM_ME })).r.j.swap
  W.status.set(other1.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: '1', destinationChainTxHashes: [{ hash: '0x' + 'cd'.repeat(32), explorerUrl: 'https://basescan.org/tx/x' }] } })
  setRowTime(other1.id, Date.now() - 60e3); await swapGet(other1.id)
  const sol1 = (await issue()).r.j.swap
  W.status.set(sol1.depositAddress, { status: 'PROCESSING', updatedAt: 'x', swapDetails: {} }); setRowTime(sol1.id, Date.now() - 60e3); await swapGet(sol1.id)
  W.status.set(sol1.depositAddress, { status: 'PENDING_DEPOSIT', updatedAt: 'x', swapDetails: {} }); setRowTime(sol1.id, Date.now() - 60e3)
  const reg = (await swapGet(sol1.id)).j.swap
  t('status regression ignored (state kept)', reg.state === 'processing')
  // round 30: the whole desk stops only on critical swaps from 3 different client NETWORKS (one client
  // can pause its own routes, not every route for everyone). These three came from one test client.
  t('three critical swaps from ONE client network → their routes pause, the desk does not', !(await adminGet()).j.controls.globalPaused, JSON.stringify((await adminGet()).j.controls))
  ENV.CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET net = ? WHERE id = ?').run('n:net-1', a.id)
  ENV.CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET net = ? WHERE id = ?').run('n:net-2', other1.id)
  ENV.CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET net = ? WHERE id = ?').run('n:net-3', sol1.id)
  await adminPost({ action: 'resume', scope: 'route', key: 'base>arb' })
  await shortPay(await issueArb())     // one more critical: the count is re-read
  t('critical swaps from three different networks in 24 h → whole desk paused', !!(await adminGet()).j.controls.globalPaused, JSON.stringify((await adminGet()).j.controls))
}

section('expiry, late deposit, unverified, outages')
await freshEnv()
{
  const sw = (await issue()).r.j.swap
  ENV.CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET deadline = ?, updated_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), Date.now() - 60e3, sw.id)
  W.oneclickDown = true
  t('deadline passed + router down → expired by the clock', (await swapGet(sw.id)).j.swap.state === 'expired')
  t('expired swap no longer counts as open', (await S.ledger.usage(ENV.CLWA_CLUSTERS, 'paid@x.io', 'base>sol', Date.now())).memberOpen === 0)
  W.oneclickDown = false
  W.status.set(sw.depositAddress, { status: 'KNOWN_DEPOSIT_TX', updatedAt: 'x', swapDetails: { depositedAmount: '100000000' } })
  // Round 13: an expired swap someone just looked at is re-checked by the reconciler 10 min later, not at once.
  t('an expired swap polled a moment ago waits for the 10-minute re-check', (await reconcile()).j.results.every(x => x.id !== sw.id))
  ENV.CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET updated_at = ? WHERE id = ?').run(Date.now() - 11 * 60e3, sw.id)
  const rc = await reconcile()
  t('reconciler picks up a LATE deposit and reopens the swap', rc.status === 200 && (await row(sw.id)).state === 'deposit_seen')
  t('late deposit is in the event log', ENV.CLWA_CLUSTERS.raw.prepare("SELECT COUNT(*) n FROM intents_events WHERE swap_id=? AND kind='state'").get(sw.id).n >= 2)
}
await freshEnv()
{
  const sw = (await issue({ to: USDC_ARB, recipient: EVM_ME })).r.j.swap
  W.status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.minAmountOut, destinationChainTxHashes: [{ hash: '0x' + 'ef'.repeat(32), explorerUrl: 'https://arbiscan.io/tx/x' }] } })
  // round 25: the alarm also needs 20 min in delivered_claimed (state_at), so that time is staged too
  for (let i = 0; i < 12; i++) { setRowTime(sw.id, Date.now() - 6 * 60e3); await reconcile(); ENV.CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET state_at = ? WHERE id = ?').run(Date.now() - 30 * 60e3, sw.id) }   // round 34: the reconciler re-checks an unpaid open address after 5 min
  const r12 = await row(sw.id)
  t('payout never found after 12 passes → dest_unverified + route paused', r12.state === 'delivered_claimed' && JSON.parse(r12.flags).includes('dest_unverified')
    && !!(await adminGet()).j.controls.routes['base>arb'], r12.flags)
}
await freshEnv()
{
  const sw = (await issue()).r.j.swap
  W.status.set(sw.depositAddress, { status: 'PROCESSING', updatedAt: 'x', swapDetails: {} })
  setRowTime(sw.id, Date.now() - 6 * 60e3); await reconcile()   // round 34: an open address is re-checked after 5 min
  W.oneclickDown = true
  setRowTime(sw.id, Date.now() - 6 * 60e3)   // round 34: the reconciler re-checks an unpaid open address after 5 min
  const rc = await reconcile()
  t('router outage during reconcile: no crash, state kept', rc.status === 200 && (await row(sw.id)).state === 'processing')
  W.oneclickDown = false
  W.status.set(sw.depositAddress, { status: 'GLITCH', updatedAt: 'x' })
  setRowTime(sw.id, Date.now() - 6 * 60e3)   // round 34: the reconciler re-checks an unpaid open address after 5 min
  await reconcile()
  t('unrecognised upstream payload: logged, state kept', (await row(sw.id)).state === 'processing'
    && ENV.CLWA_CLUSTERS.raw.prepare("SELECT COUNT(*) n FROM intents_events WHERE kind='upstream_unrecognised'").get().n === 1)
  // Standalone desk: the reconciler runs from the cron trigger only — there is no HTTP door to guard.
  for (const p of ['/api/intents/reconcile', '/api/reconcile']) {
    const r = await S.worker.fetch(new Request(SITE + p, { method: 'POST', headers: { 'x-refresh-key': 'rk-123' } }), S.envOf(ENV), { waitUntil() {} })
    t('no HTTP route to the reconciler: POST ' + p + ' → 404', r.status === 404)
  }
  ENV.CLWA_CLUSTERS.raw.prepare(`INSERT INTO intents_swaps (id, idem, member, created_at, updated_at, route, from_chain, to_chain, from_asset, to_asset, amount_in, recipient, refund_to, state)
    VALUES ('crash-1','i-crash','paid@x.io',?,?,'base>sol','base','sol','a','b','1','r','f','reserving')`).run(Date.now() - 300e3, Date.now() - 300e3)
  await reconcile()
  t('a reservation orphaned by a crash is closed out', (await row('crash-1')).state === 'abandoned')
}

section('submit tx hash')
await freshEnv()
{
  const sw = (await issue()).r.j.swap
  const sub = (b, who) => call(S.submit.onRequestPost, req('POST', '/api/intents/submit', { body: b, who }))
  t('bad hash → 400', (await sub({ id: sw.id, txHash: 'nope' })).status === 400)
  t('someone else’s swap → 404', (await sub({ id: sw.id, txHash: '0x' + 'a'.repeat(64) }, 'other@x.io')).status === 404)
  const ok = await sub({ id: sw.id, txHash: '0x' + 'a'.repeat(64) })
  t('valid → forwarded to 1Click + logged', ok.status === 200 && W.calls.submit === 1
    && ENV.CLWA_CLUSTERS.raw.prepare("SELECT COUNT(*) n FROM intents_events WHERE kind='tx_submitted'").get().n === 1)
}

section('admin limits')
await freshEnv()
t('limits above ceiling refused', (await adminPost({ action: 'limits', limits: { maxTradeUsd: 1e9 } })).status === 400)
t('limits ok → applied to quotes', (await adminPost({ action: 'limits', limits: { maxTradeUsd: 50 } })).status === 200 && (await issue({ amount: '60' })).r.j.error === 'above_max_trade')
t('limits reset to launch', (await adminPost({ action: 'limits', limits: null })).status === 200 && (await issue({ amount: '60' })).r.status === 200)
t('unknown admin action → 400', (await adminPost({ action: 'drain' })).status === 400)

section('load')
await freshEnv()
{
  const t0 = Date.now()
  const rs = await Promise.all(Array.from({ length: 120 }, (_, i) => Q({ ...base, dry: true }, i % 2 ? 'paid@x.io' : 'other@x.io')))
  const ms = Date.now() - t0
  const by = rs.reduce((m, x) => (m[x.status] = (m[x.status] || 0) + 1, m), {})
  t('120 concurrent previews: only 200 or 429, nothing else', Object.keys(by).every(s => s === '200' || s === '429'), JSON.stringify(by))
  t('per-member preview limit (40/min) holds under load', (by['200'] || 0) <= 80 && (by['200'] || 0) >= 40, JSON.stringify(by))
  console.log(`    (120 concurrent previews in ${ms} ms: ${JSON.stringify(by)})`)
}

section('price precision')
t('every independent-price request asked CoinGecko for full precision (' + CG_CALLS + ' calls)', CG_CALLS > 0 && CG_ROUNDED === 0, CG_ROUNDED + ' rounded')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
