// Shared harness for the cross-chain desk suites (extracted from
// intents-system.mjs for test/intents-redteam.mjs). Real SQLite D1 shim, KV
// map, signed sessions, and a scripted outside world that suites can bend.
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
export function makeD1() {
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
  // Like real D1: one result per statement, in order (round 22 — code that reads the results of a
  // batch crashed here and nowhere else). All or nothing, as D1 runs a batch as one transaction.
  return {
    prepare: sql => stmt(sql),
    batch: async list => {
      db.exec('BEGIN')
      try { const out = []; for (const s of list) out.push(await s.run()); db.exec('COMMIT'); return out }
      catch (e) { db.exec('ROLLBACK'); throw e }
    },
    raw: db,
  }
}
export function makeKV() {
  const m = new Map()
  return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) }, _m: m }
}

// ── auth ────────────────────────────────────────────────────────────────
export const SECRET = 'test-secret-' + crypto.randomBytes(8).toString('hex')
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export function session(email, plan = 'lifetime') {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const p = b64u(JSON.stringify({ sub: email, plan, iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 3600 }))
  const s = b64u(crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest())
  return `clwa_session=${h}.${p}.${s}`
}

// ── scripted outside world ──────────────────────────────────────────────
export const rawTokens = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/fixtures-intents-tokens.json'), 'utf8'))
export const TOK = Object.fromEntries(rawTokens.map(x => [x.assetId, x]))
export const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
export const SOL = 'nep141:sol.omft.near'
export const ETH_ARB = 'nep141:arb.omft.near'
export const USDC_ARB = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'
export const WNEAR = 'nep141:wrap.near'
export const EVM_ME = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'
export const EVM_ME2 = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'
export const SOL_ME = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'   // a normal key (the wSOL MINT used before is now correctly refused)
export const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export const b58 = buf => { let n = BigInt('0x' + Buffer.from(buf).toString('hex')), s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n } return s }

export let W, CG_ROUNDED = 0, CG_CALLS = 0
export function resetWorld() {
  W = {
    quoteMode: 'ok', outFactor: 1, cgDown: false, cgPrice: { 'usd-coin': 1, solana: 101.14, ethereum: 2342.92, 'wrapped-near': 4.67, near: 4.67, bitcoin: 80658, binancecoin: 742.29, 'polygon-ecosystem-token': 0.091872 },     // BNB/POL: the token list's prices (round 33)
    status: new Map(), receipts: new Map(), nearAccounts: new Set(['alice.near', 'wrap.near']), nearDown: false,
    oneclickDown: false, calls: { quoteDry: 0, quoteReal: 0, status: 0, submit: 0, cg: 0, evm: 0, near: 0 },
    lastQuoteBody: null, depositSeq: 0,
  }
}
export const resp = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function quoteFor(body) {
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
    if (url.pathname === '/v0/tokens') return resp(W.tokensOverride || rawTokens)
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
      if (W.statusDelay) await new Promise(r => setTimeout(r, W.statusDelay))   // a slow router: lets concurrent polls truly overlap
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
      // Like a real node: the receipt names its own tx (round 24 checks it); a test can override it.
      return resp({ jsonrpc: '2.0', id: 1, result: rc ? { blockNumber: '0x1', blockHash: '0x' + 'bb'.repeat(32), transactionHash: body.params[0], ...rc } : null })
    }
    // Chain head: far ahead of every test block (payouts are final) unless a suite sets W.head.
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
    // the key checker (as in intents-system.mjs): W.nearKeys[id] scripts an account's keys
    if (body.params.request_type === 'view_access_key_list') {
      const ks = (W.nearKeys || {})[id] ?? (W.nearAccounts.has(id) ? [{ access_key: { nonce: 1, permission: 'FullAccess' }, public_key: 'ed25519:njV8oUZbvd1HswZiKL8j7zx2U1wnvaLQiysYDRPMBsF' }] : [])
      return resp({ jsonrpc: '2.0', id: 1, result: { block_hash: 'x', block_height: 1, keys: ks } })
    }
    return W.nearAccounts.has(id) ? resp({ result: { amount: '1' } }) : resp({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } })
  }
  return resp({ error: 'unexpected host ' + url.hostname }, 599)
}

// ── harness ─────────────────────────────────────────────────────────────
export let ENV
export async function freshEnv(extra = {}) {
  resetWorld()
  S.ledger.__resetLedger(); S.__resetJar(); S.io.__resetTokenCache(); S.io.__resetPriceCache()
  const members = makeKV()
  for (const [e, plan] of [['paid@x.io', 'lifetime'], ['other@x.io', 'lifetime'], ['free@x.io', 'free']])
    await members.put('member:' + e, JSON.stringify({ email: e, plan, status: 'active' }))
  ENV = { MEMBER_JWT_SECRET: SECRET, CLWA_MEMBERS: members, CLWA_SESSIONS: makeKV(), CLWA_CLUSTERS: makeD1(), REFRESH_KEY: 'rk-123', ...extra }
  return ENV
}
export const SITE = 'https://www.cryptolwa.io'
export function req(method, p, { who = 'paid@x.io', body, headers = {} } = {}) {
  const h = { origin: SITE, 'sec-fetch-site': 'same-origin', ...headers }
  if (who) h.cookie = session(who, who.startsWith('free') ? 'free' : 'lifetime')
  if (body !== undefined) h['content-type'] = 'application/json'
  return new Request(SITE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
}
export const call = async (fn, request, data = {}) => { const r = await fn({ request, env: ENV, data, params: {}, next: async () => new Response('next'), waitUntil() {} }); return { status: r.status, j: await r.json().catch(() => null) } }
export const Q = (body, who) => call(S.quote.onRequestPost, req('POST', '/api/intents/quote', { body, who }))
export const swapGet = (id, who) => call(S.swaps.onRequestGet, req('GET', '/api/intents/swaps' + (id ? '?id=' + id : ''), { who }))
export const adminPost = body => call(S.admin.onRequestPost, req('POST', '/api/admin/intents', { body }), { adminEmail: 'owner@x.io' })
export const adminGet = () => call(S.admin.onRequestGet, req('GET', '/api/admin/intents'), { adminEmail: 'owner@x.io' })
export const reconcile = (key = 'rk-123') => call(S.reconcile.onRequest, new Request(SITE + '/api/intents/reconcile', { method: 'POST', headers: { 'x-refresh-key': key } }))
export const base = { from: USDC_BASE, to: SOL, amount: '100', recipient: SOL_ME, refundTo: EVM_ME }
export async function issue(over = {}, who) {
  const pv = await Q({ ...base, ...over, dry: true }, who)
  if (pv.status !== 200) return { pv }
  const r = await Q({ ...base, ...over, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut }, who)
  return { pv, r }
}
export const row = async id => ENV.CLWA_CLUSTERS.raw.prepare('SELECT * FROM intents_swaps WHERE id = ?').get(id)
export const setRowTime = (id, ms) => ENV.CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET updated_at = ? WHERE id = ?').run(ms, id)

export { S }
export const getEnv = () => ENV
export const getWorld = () => W
