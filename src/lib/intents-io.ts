/**
 * lib/intents-io.ts — the cross-chain desk's outside world: 1Click, the price
 * check, the NEAR account check, and refreshSwap() (the ONE place a swap's
 * state changes after it is issued).
 *
 * Pure decisions live in intents.ts / intents-risk.ts /
 * intents-ledger.ts / intents-verify.ts; this file wires them to fetch + D1.
 * Every outside answer is treated as untrusted input.
 */
import { ONECLICK_BASE, CHAINS, slimTokens, slimStatus, isNearNamed, type Token } from './intents'
import {
  nextState, reconcileFlags, applyObservation, logEvent, setControl, readControls,
  CRITICAL_FLAGS, FINAL, VERIFY_GRACE_ATTEMPTS, type SwapRow, type State,
} from './intents-ledger'
import { verifyDestinationDetailed } from './intents-verify'
import { ensureTables } from './intents-ledger'

export interface IntentsEnv {
  DESK_DB?: D1Database
  DESK_SECRET?: string              // HMAC key: swap access tokens + hashed client buckets (≥ 32 chars, required)
  ADMIN_TOKEN?: string              // operator API; unset = the admin API does not exist (404)
  COINGECKO_PRO_KEY?: string        // optional — the free CoinGecko base and DeFiLlama are used without it
  INTENTS_API_KEY?: string          // 1Click partner JWT — optional (lower fees)
  INTENTS_FEE_BPS?: string          // our fee — default off
  INTENTS_FEE_RECIPIENT?: string    // NEAR-side account for our fee
  INTENTS_LIMITS?: string           // JSON override of LAUNCH_LIMITS
  INTENTS_ENABLED?: string          // '0' = deploy-level kill switch for NEW quotes
  INTENTS_SUBREQ_BUDGET?: string    // reconciler subrequests per pass (default 45: fits the 50/request Free-plan cap)
}

export const json = (b: unknown, s = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(b), {
  status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
})

/**
 * A config value as the owner MEANT it: PowerShell pipes prepend a BOM and append
 * CRLF to secrets (the cron worker's own comments record an outage from exactly
 * that), so every env value is read through this. Red-team round 10.
 */
export function cleanEnv(v: unknown): string { return String(v ?? '').replace(/^\uFEFF/, '').trim() }
// Every way an owner would write "off" switches the desk off (round 10: only "0" did).
const OFF = new Set(['0', 'false', 'off', 'no', 'disabled', 'disable'])
export function enabled(env: IntentsEnv): boolean { return !OFF.has(cleanEnv(env.INTENTS_ENABLED).toLowerCase()) }

type Fetch = typeof fetch
// Indirection so tests can stand in for the network without touching globals.
let rawNet: Fetch = (...a) => fetch(...a)
export function __setFetch(f: Fetch | null) { rawNet = f || ((...a) => fetch(...a)) }
// Every outbound call from this module is counted, so the reconciler can stay under
// the Worker subrequest cap (50 on the Free plan — the plan is not known here, so it
// is not assumed). Red-team round 8: one pass over 25 swaps made 100 subrequests.
let subrequests = 0
export const subrequestCount = () => subrequests
const net: Fetch = (...a) => { subrequests++; return rawNet(...a) }

/** One call to 1Click. Never throws: { status, body } with status 0 on network failure. */
export async function oneClick(env: IntentsEnv, path: string, init: { method?: string; body?: unknown } = {}, via: Fetch = net): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  // trimmed: a key with a trailing newline makes fetch() reject the header and took the whole desk down (round 10)
  const apiKey = cleanEnv(env.INTENTS_API_KEY)
  if (apiKey) headers['x-api-key'] = apiKey
  try {
    const r = await via(ONECLICK_BASE + path, {
      method: init.method || 'GET', headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15000),
    })
    const text = await r.text()
    if (text.length > 2_000_000) return { status: 502, body: null }
    let body: any = null
    try { body = JSON.parse(text) } catch { /* non-JSON → null */ }
    return { status: r.status, body }
  } catch {
    return { status: 0, body: null }
  }
}

// ── tokens (5-minute isolate cache; stale copy up to 1 h if 1Click is down) ──
let tokCache: { at: number; tokens: Token[] } | null = null
export function __resetTokenCache() { tokCache = null }
export async function getTokens(env: IntentsEnv, now = Date.now(), via: Fetch = net): Promise<{ tokens: Token[]; stale: boolean } | null> {
  if (tokCache && now - tokCache.at < 300_000) return { tokens: tokCache.tokens, stale: false }
  const r = await oneClick(env, '/v0/tokens', {}, via)
  const tokens = r.status === 200 ? slimTokens(r.body) : []
  if (tokens.length) { tokCache = { at: now, tokens }; return { tokens, stale: false } }
  if (tokCache && now - tokCache.at < 3_600_000) return { tokens: tokCache.tokens, stale: true }
  return null
}

/**
 * USD prices from CoinGecko — deliberately NOT 1Click's own `price` field, so
 * the router is never graded with its own ruler. Missing → null.
 *
 * Measured (backtest run 2): without `precision=full` CoinGecko
 * rounds every coin above $1 to two decimals — ±10.7 bps on NEAR at $4.68 —
 * and the thin `wrapped-near` feed sat 12 bps off `near`, although wNEAR
 * redeems 1:1 on-chain. Together they showed USDC→wNEAR as an 80+ bps cost
 * while the router-only round trip lost 21 bps a leg.
 */
const PRICE_ALIAS: Record<string, string> = { 'wrapped-near': 'near' }   // 1:1 by protocol only; custodial wraps (wBTC, cbBTC) are NOT aliased
// Red-team round 3 (live): keyless CoinGecko answered 429 and every
// deposit address was refused — safe, but one provider's bad minute took the
// desk down. So: a 30 s isolate cache (each preview no longer costs a call),
// and DeFiLlama — also independent of 1Click, keyed by the same CoinGecko ids,
// checked live — as the fallback. Its answer is used only if confident and fresh.
// CoinGecko: the Pro base first when a key is set, the free base otherwise or when
// Pro refuses (401/403/429/5xx). Through `net`, so it counts toward the subrequest cap.
const CG_FREE = 'https://api.coingecko.com/api/v3', CG_PRO = 'https://pro-api.coingecko.com/api/v3'
async function cgFetch(path: string, proKey: string): Promise<Response | null> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (proKey) {
    try {
      const r = await net(CG_PRO + path, { headers: { ...headers, 'x-cg-pro-api-key': proKey }, signal: AbortSignal.timeout(8000) })
      if (!(r.status === 401 || r.status === 403 || r.status === 429 || r.status >= 500)) return r
    } catch { /* fall back to the free base */ }
  }
  try { return await net(CG_FREE + path, { headers, signal: AbortSignal.timeout(8000) }) } catch { return null }
}
const PRICE_TTL_MS = 30_000
const priceCache = new Map<string, { p: number; at: number }>()
export function __resetPriceCache() { priceCache.clear() }
export async function independentPrices(env: IntentsEnv, ids: (string | null)[], now = Date.now()): Promise<Record<string, number>> {
  const want = Array.from(new Set(ids.filter((x): x is string => !!x))).slice(0, 10)
  if (!want.length) return {}
  const src = (id: string) => PRICE_ALIAS[id] || id
  const got: Record<string, number> = {}
  for (const id of want) { const c = priceCache.get(src(id)); if (c && now - c.at < PRICE_TTL_MS) got[id] = c.p }
  let missing = want.filter(id => !(id in got))
  const keep = (id: string, p: number) => { if (Number.isFinite(p) && p > 0) { got[id] = p; priceCache.set(src(id), { p, at: now }) } }
  if (missing.length) {
    try {
      const ask = Array.from(new Set(missing.map(src)))
      const r = await cgFetch('/simple/price?vs_currencies=usd&precision=full&ids=' + ask.map(encodeURIComponent).join(','), cleanEnv(env.COINGECKO_PRO_KEY))
      if (r && r.ok) { const j: any = await r.json(); for (const id of missing) keep(id, Number(j?.[src(id)]?.usd)) }
    } catch { /* fall through to the second source */ }
    missing = want.filter(id => !(id in got))
  }
  if (missing.length) {
    try {
      const keys = Array.from(new Set(missing.map(id => 'coingecko:' + src(id))))
      const r = await net('https://coins.llama.fi/prices/current/' + keys.map(encodeURIComponent).join(',') + '?searchWidth=1h', { signal: AbortSignal.timeout(8000) })
      if (r.ok) {
        const j: any = await r.json()
        for (const id of missing) {
          const c = j?.coins?.['coingecko:' + src(id)]
          if (c && Number(c.confidence) >= 0.9 && Math.abs(now / 1000 - Number(c.timestamp)) < 3600) keep(id, Number(c.price))
        }
      }
    } catch { /* both sources down → unpriced → no deposit address (fail closed) */ }
  }
  return got
}

/**
 * Does a NEAR named account exist? (An implicit/hex account always can be
 * paid; a named one that does not exist cannot.) true / false / null = could
 * not tell. Independent RPC operators, probed live FROM CLOUDFLARE: free public NEAR nodes rate-limit
 * Cloudflare's shared addresses (rpc.mainnet.near.org: 429 "deprecated"; near.drpc.org: 429 "too many
 * requests" a day after it worked) while answering home connections, so no single second operator
 * is trusted to stay up: the first of NEAR_OTHERS that answers is the second voice.
 */
const NEAR_FAST = 'https://free.rpc.fastnear.com'
const NEAR_OTHERS = ['https://rpc.intea.rs', 'https://near.drpc.org']     // operators other than fastnear
const NEAR_RPCS = [NEAR_FAST, ...NEAR_OTHERS]
export async function nearAccountExists(id: string): Promise<boolean | null> {
  if (!isNearNamed(id)) return true
  for (const url of NEAR_RPCS) {
    try {
      const r = await net(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'clwa', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: id } }),
        signal: AbortSignal.timeout(6000),
      })
      const j: any = await r.json().catch(() => null)
      if (j?.result && typeof j.result.amount === 'string') return true
      if (j?.error?.cause?.name === 'UNKNOWN_ACCOUNT') return false
    } catch { /* try the next operator */ }
  }
  return null
}

/**
 * Who can sign for a NEAR account: the key checker. A phishing page that gets someone to add
 * the attacker's FULL-ACCESS key gives the attacker the account, and anything paid there after.
 * So the payout account's full-access keys are shown BEFORE the member accepts, for them to
 * match against their own wallet. Read-only: the desk holds no NEAR key and signs nothing.
 *
 * Two DIFFERENT operators must answer and agree: fastnear, and the first of NEAR_OTHERS that answers.
 * One operator alone could show a clean list.
 * Checked live against mainnet:
 *  - an account that does not exist answers an EMPTY key list, not an error, so an empty list
 *    is told apart with view_account (empty + exists = locked: only its contract can act);
 *  - more than 100 keys is an error (TOO_MANY_ACCESS_KEYS), reported as such;
 *  - permission is "FullAccess" or { FunctionCall: … }; nomicon also lists gas-key variants.
 *    Anything not plainly a function-call key counts as FULL access (fail safe).
 * An eth-implicit account (0x…) is run by the Ethereum key behind that address, not by NEAR
 * keys, so it is never reported as locked.
 *   null → could not tell (an operator down, or the two disagree)
 */
export interface NearKeys { full: string[]; limited: number; locked: boolean; fresh: boolean; tooMany: boolean; ethImplicit: boolean }
const LIMITED_KEYS = new Set(['FunctionCall', 'GasKeyFunctionCall'])
const NEAR_PK = /^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{32,100}$/
async function nearQuery(url: string, params: Record<string, string>): Promise<any> {
  try {
    const r = await net(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'clwa', method: 'query', params: { finality: 'final', ...params } }),
      signal: AbortSignal.timeout(6000),
    })
    return await r.json().catch(() => null)
  } catch { return null }
}
async function keyList(url: string, id: string): Promise<[string, 'full' | 'limited'][] | 'tooMany' | null> {
  const j = await nearQuery(url, { request_type: 'view_access_key_list', account_id: id })
  if (j?.error?.cause?.name === 'TOO_MANY_ACCESS_KEYS') return 'tooMany'
  const ks = j?.result?.keys
  if (!Array.isArray(ks) || ks.length > 100) return null
  const out: [string, 'full' | 'limited'][] = []
  for (const k of ks) {
    const pk = k?.public_key, p = k?.access_key?.permission
    if (typeof pk !== 'string' || !NEAR_PK.test(pk)) return null
    const limited = !!p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 1 && LIMITED_KEYS.has(Object.keys(p)[0])
    out.push([pk, limited ? 'limited' : 'full'])
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}
export async function nearKeys(id: string): Promise<NearKeys | null> {
  const ethImplicit = /^0x[0-9a-f]{40}$/.test(id)
  const [a, ...others] = await Promise.all(NEAR_RPCS.map(u => keyList(u, id)))
  const b = others.find(x => x !== null) ?? null
  if (a === null || b === null) return null
  if (a === 'tooMany' || b === 'tooMany')
    return a === b ? { full: [], limited: 0, locked: false, fresh: false, tooMany: true, ethImplicit } : null
  if (JSON.stringify(a) !== JSON.stringify(b)) return null
  const full = a.filter(k => k[1] === 'full').map(k => k[0])
  let locked = false, fresh = false
  if (!a.length) {
    let known = false
    for (const url of NEAR_RPCS) {
      const j = await nearQuery(url, { request_type: 'view_account', account_id: id })
      if (j?.result && typeof j.result.amount === 'string') { locked = !ethImplicit; known = true; break }
      if (j?.error?.cause?.name === 'UNKNOWN_ACCOUNT') { fresh = true; known = true; break }
    }
    if (!known) return null
  }
  return { full, limited: a.length - full.length, locked, fresh, tooMany: false, ethImplicit }
}

/**
 * What the chain itself says about a receiving / refund address.
 * Red-team round 2, checked live: a Solana USDC *token account*
 * (HrTf9…, owner TokenkegQ…) is a perfectly valid 32-byte key, and a payout
 * sent there is stuck — pasting a token account instead of the wallet is a
 * classic loss. Programs are `executable`. On EVM a contract recipient is only
 * WARNED (Safe-style smart wallets are legitimate); EIP-7702 code (0xef0100…)
 * is a delegated EOA, not a contract.
 *   hard  → refuse     warn → show     null → could not tell
 */
const SOL_RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com']
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'])
const EVM_NODES: Record<string, string> = {
  eth: 'https://ethereum-rpc.publicnode.com', base: 'https://base-rpc.publicnode.com', arb: 'https://arbitrum-one-rpc.publicnode.com',
  op: 'https://optimism-rpc.publicnode.com', bsc: 'https://bsc-rpc.publicnode.com', pol: 'https://polygon-bor-rpc.publicnode.com',
  avax: 'https://avalanche-c-chain-rpc.publicnode.com', gnosis: 'https://gnosis-rpc.publicnode.com',
}
async function rpcCall(url: string, method: string, params: unknown[]): Promise<{ ok: boolean; result?: any }> {
  try {
    const r = await net(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(6000) })
    const j: any = await r.json().catch(() => null)
    return j && 'result' in j ? { ok: true, result: j.result } : { ok: false }
  } catch { return { ok: false } }
}
export async function addressOnChain(chain: string, addr: string): Promise<{ hard?: string; warn?: string } | null> {
  if (chain === 'sol') {
    for (const url of SOL_RPCS) {
      const r = await rpcCall(url, 'getAccountInfo', [addr, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }])
      if (!r.ok) continue
      const v = r.result?.value
      if (v === null || v === undefined) return {}            // brand-new wallet: fine
      if (v.executable === true) return { hard: 'unspendable' }
      if (TOKEN_PROGRAMS.has(String(v.owner))) return { hard: 'token_account' }
      return {}
    }
    return null
  }
  const node = EVM_NODES[chain]
  if (node) {
    const r = await rpcCall(node, 'eth_getCode', [addr, 'latest'])
    if (!r.ok || typeof r.result !== 'string') return null
    const code = r.result.toLowerCase()
    if (code === '0x' || code.startsWith('0xef0100')) return {}
    return { warn: 'contract' }
  }
  return {}
}

/**
 * Hashed idempotency key. Scoped to the desk, not to the client bucket: a phone
 * that switches from Wi-Fi to mobile data between "Get address" and the retry
 * changes IP, and must still get its first swap back, never a second one.
 * A key is a client-generated UUID (122 random bits), so two clients never share one.
 */
export async function idemKey(scope: string, key: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope + '\u0000' + key))
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ─────────────────────────────────────────────────────── refreshSwap ──
const MIN_REFRESH_MS = 8_000
const OPEN_RECHECK_MS = 5 * 60e3     // round 34: unpaid open addresses, reconciler only

/**
 * Bring one swap up to date: ask 1Click, move the state machine, verify the
 * payout on-chain when 1Click claims success, record flags, and pause the
 * route on anything critical. Safe to call concurrently (optimistic update).
 */
export async function refreshSwap(env: IntentsEnv, db: D1Database, row: SwapRow, actor: string, now = Date.now(), force = false,
                                  meter?: { n: number; max?: number }): Promise<SwapRow> {
  // The reconciler passes its own meter: outbound calls are counted per invocation,
  // not in the module-wide tally that concurrent requests in the isolate also move (round 13).
  const via: Fetch = meter ? (...a) => { meter.n++; return net(...a) } : net
  if (row.state === 'reserving' || row.state === 'abandoned' || !row.deposit_address) return row
  const depositAddress: string = row.deposit_address
  // Final swaps only get re-checked by the reconciler (to catch contradictions), and settled ones never.
  if (row.state === 'settled') return row
  if (FINAL.has(row.state) && actor !== 'reconciler') return row
  if (!force && now - row.updated_at < MIN_REFRESH_MS) return row
  // Lease: only the caller that atomically moves updated_at from the value it
  // read gets to ask 1Click; every concurrent poller gets the stored row.
  // Red-team round 3: 40 overlapping polls made 40 status calls.
  // The stamp only ever moves forward (round 13): a lease at a clock reading not
  // newer than the stored stamp would wind the version back.
  const leaseAt = Math.max(now, row.updated_at + 1)
  const lease = await db.prepare('UPDATE intents_swaps SET updated_at = ? WHERE id = ? AND updated_at = ?').bind(leaseAt, row.id, row.updated_at).run()
  if ((lease.meta as any)?.changes !== 1) return (await db.prepare('SELECT * FROM intents_swaps WHERE id = ?').bind(row.id).first<SwapRow>()) || row
  row = { ...row, updated_at: leaseAt }
  const committedAt = leaseAt + 1    // what applyObservation writes: max(now, leaseAt + 1)

  const deadlineMs = row.deadline ? Date.parse(row.deadline) : null
  const r = await oneClick(env, '/v0/status?depositAddress=' + encodeURIComponent(depositAddress), {}, via)
  const slim = r.status === 200 ? slimStatus(r.body) : null
  const upstream = slim && slim.ok ? (slim.s.status as string) : null
  if (r.status === 200 && !(slim && slim.ok)) await logEvent(db, row.id, actor, 'upstream_unrecognised', { status: r.body?.status ?? null })

  // The feed must be describing THIS swap. A status whose own quote names a
  // different recipient / refund / asset / amount is not applied at all, and it
  // pauses the route (red-team: it used to be ignored).
  let echoBad: string | null = null
  const echo: any = slim && slim.ok ? (slim.s as any).echo : null
  if (echo) {
    const evmTo = CHAINS[row.to_chain]?.family === 'evm', evmFrom = CHAINS[row.from_chain]?.family === 'evm'
    const eq = (a: unknown, b: string, ci: boolean) => typeof a === 'string' && (ci ? a.toLowerCase() === b.toLowerCase() : a === b)
    if ((echo.recipient && !eq(echo.recipient, row.recipient, evmTo)) || (echo.refundTo && !eq(echo.refundTo, row.refund_to, evmFrom))
        || (echo.originAsset && echo.originAsset !== row.from_asset) || (echo.destinationAsset && echo.destinationAsset !== row.to_asset)
        || (echo.amount && echo.amount !== row.amount_in)) echoBad = 'status_recipient_mismatch'
  }

  const tr = echoBad ? { state: row.state, changed: false, anomaly: echoBad }
    : nextState(row.state, upstream, now, Number.isFinite(deadlineMs as number) ? deadlineMs : null)
  const patch: Partial<SwapRow> = {}
  if (tr.changed) patch.state = tr.state
  // Detail fields follow any report that is not itself a regression/contradiction.
  if (upstream && !tr.anomaly) {
    const s: any = (slim as any).s
    // Only what CHANGED (round 18): every field was patched on every answer, so an idle poll
    // never reached the "nothing new" path and wrote twice (lease + commit) against D1's
    // 100k-rows-a-day Free quota.
    const set = (k: keyof SwapRow, v: unknown) => { if (v !== (row as any)[k]) (patch as any)[k] = v }
    set('upstream_status', upstream)
    if (s.depositedAmount) set('deposited', s.depositedAmount)
    if (s.amountOut) set('amount_out_actual', s.amountOut)
    if (s.refundedAmount) set('refunded', s.refundedAmount)
    if (s.refundReason) set('refund_reason', s.refundReason)
    if (s.originTxs?.length) set('origin_txs', JSON.stringify(s.originTxs))
    // A payout ON NEAR may be named only in nearTxHashes (round 27): those join the candidates,
    // newest first, after any destination tx, with an explorer link the member can open.
    const nearExtra = row.to_chain === 'near' && Array.isArray(s.nearTxs)
      ? (s.nearTxs as string[]).slice().reverse().map(h => ({ hash: h, explorerUrl: 'https://nearblocks.io/txns/' + h })) : []
    const dests = [...(s.destinationTxs || []), ...nearExtra].filter((t: any, i: number, a: any[]) => a.findIndex(x => x.hash === t.hash) === i)
      .slice(0, row.to_chain === 'near' ? NEAR_PAYOUT_TXS : MAX_PAYOUT_TXS)
    if (dests.length) set('dest_txs', JSON.stringify(dests))
  }

  const state: State = (patch.state as State) || row.state
  const merged = { ...row, ...patch } as SwapRow
  if (patch.state && patch.state !== row.state) merged.state_at = now   // a state just entered has not been stuck in it
  const extraFlags: string[] = []

  // PAYOUT OWNERSHIP. The first swap the feed ever names a payout tx for owns it —
  // recorded at first sight, even when the report itself is contradictory. A tx
  // later named for a DIFFERENT swap can never settle it. Lifecycle fuzzer
  // (round 6): two swaps paying the same wallet the same amount let one payout,
  // reported for swap A (which never settled on it), settle swap B as well.
  // At most 3, the same 3 verification looks at: each costs 2 D1 calls, and a pass has a
  // fixed call budget (round 13, second pass: 5 txs made one swap overrun its allowance).
  // Not on NEAR (round 27): a solver batches many payouts into ONE NEAR tx, so two swaps naming the
  // same tx is normal there. On NEAR the unit is the payout RECEIPT, and settled_tx (tx#receipt,
  // UNIQUE) makes one receipt settle one swap.
  const nearDest = row.to_chain === 'near'
  const feedTxs: { hash: string }[] = nearDest ? [] : (slim && slim.ok ? (((slim.s as any).destinationTxs) || []) : []).slice(0, MAX_PAYOUT_TXS)
  const norm = (h: string) => (/^(0x)?[0-9a-fA-F]+$/.test(h) ? h.toLowerCase() : h)
  const foreign = new Set<string>()
  for (const t of feedTxs) {
    const h = norm(t.hash)
    await db.prepare('INSERT INTO intents_payouts (hash, swap_id, at) VALUES (?, ?, ?) ON CONFLICT(hash) DO NOTHING').bind(h, row.id, now).run()
    const owner = await db.prepare('SELECT swap_id FROM intents_payouts WHERE hash = ?').bind(h).first<{ swap_id: string }>()
    if (owner && owner.swap_id !== row.id) foreign.add(h)
  }
  if (foreign.size) extraFlags.push('payout_tx_reused')

  // "Submitted" is not "settled": 1Click's SUCCESS is checked on the destination chain.
  // Inside a reconciler pass the check runs only if its worst case still fits the pass's
  // call budget; otherwise it waits for the next pass and does NOT count as an attempt.
  // …plus the calls that follow it (update, events, autoPause): round 18 — they used to be able to
  // overrun the cap AFTER the flags were written, losing the route pause for good.
  const verifyFits = !meter?.max || meter.n + VERIFY_MAX + AFTER_VERIFY_MAX <= meter.max
  if (state === 'delivered_claimed' && !echoBad && verifyFits) {
    let txs: { hash: string }[] = []
    try { txs = JSON.parse(merged.dest_txs || '[]') } catch { /* none */ }
    // Only payouts this swap owns may prove it (see PAYOUT OWNERSHIP above).
    if (!nearDest) {
      const owned = new Set<string>(((await db.prepare('SELECT hash FROM intents_payouts WHERE swap_id = ?').bind(row.id).all<{ hash: string }>()).results || []).map(x => x.hash))
      txs = txs.filter(t => typeof t?.hash === 'string' && owned.has(norm(t.hash)) && !foreign.has(norm(t.hash)))
    }
    const tk = await getTokens(env, Date.now(), via)
    // The contract / SPL mint frozen when the swap was issued (round 21: the live list was used, so
    // a wrong or poisoned list could name another mint, and a junk-token transfer 'proved' the
    // payout). Rows from before the column: the live list, as before.
    const contract = row.to_contract === 'native' ? null : row.to_contract ?? tk?.tokens.find(t => t.id === row.to_asset)?.contract ?? null
    // The payout must be mined AFTER this swap was created, and each payout tx can settle one swap only.
    // (dest_proof, the remembered balance-rise proofs of rounds 25–32, is no longer read or written: since
    // round 33 a rise never settles a swap. The column stays — columns are never removed.)
    const res = await verifyDestinationDetailed(via, row.to_chain, row.to_asset, row.recipient, BigInt(row.min_amount_out || '0'), txs, contract,
      Math.floor(row.created_at / 1000))
    let v: string = res.verdict
    // Once established, 'unproven' does not decay into 'pending' because a later read failed or the
    // node pruned that block (round 31, round 17 review: it then raised the route-pausing alarm anyway).
    if (v === 'pending' && row.dest_verified === 'unproven') v = 'unproven'
    if ((v === 'verified' || v === 'confirmed') && res.hash) {
      // The first candidate no other swap settled on (NEAR offers every receipt that covers the
      // guarantee, smallest first). One query for all of them (round 28: one each capped it at 3).
      const cands = [res.hash, ...(res.alts || [])].slice(0, 20)
      const taken = new Set(((await db.prepare(`SELECT settled_tx FROM intents_swaps WHERE settled_tx IN (${cands.map(() => '?').join(',')}) AND id <> ?`)
        .bind(...cands, row.id).all<{ settled_tx: string }>()).results || []).map(x => x.settled_tx))
      const free: string | null = cands.find(k => !taken.has(k)) ?? null
      if (!free) { v = 'reused'; extraFlags.push('payout_tx_reused') }
      else patch.settled_tx = free
    }
    // Only when it changed (round 34): an 'unproven' swap rewrote the same value on every poll.
    if (v !== row.dest_verified) patch.dest_verified = v
    // Only the reconciler's attempts count toward the grace (round 22): the member's page polls
    // every 10 s, so its attempts ran the '~12 passes' grace out in about 2 minutes and paused
    // the route while a Bitcoin payout was still confirming.
    if (actor === 'reconciler') patch.verify_attempts = (row.verify_attempts || 0) + 1
    merged.dest_verified = v
    merged.verify_attempts = patch.verify_attempts ?? row.verify_attempts
    // On chains we cannot check, 1Click's word is accepted only if it is at least
    // internally consistent: a payout tx is named and the reported amount meets
    // the guaranteed minimum (red-team round 2: a bare "SUCCESS" settled a NEAR swap).
    const unverifiableOk = v === 'unverifiable' && txs.length > 0
      && !!merged.amount_out_actual && /^\d+$/.test(merged.amount_out_actual)
      && BigInt(merged.amount_out_actual) >= BigInt(row.min_amount_out || '0')
    if (v === 'verified' || v === 'confirmed' || unverifiableOk) {
      // 'unverifiable' chains settle on 1Click's (consistent) word, and say so (dest_verified is shown to the member).
      patch.state = 'settled'; merged.state = 'settled'
    }
  }

  const flags = Array.from(new Set([...reconcileFlags(merged, now, tr.anomaly), ...extraFlags]))
  const prev: string[] = (() => { try { return JSON.parse(row.flags || '[]') } catch { return [] } })()
  const allFlags = Array.from(new Set([...prev, ...flags]))
  if (allFlags.length !== prev.length) patch.flags = JSON.stringify(allFlags)

  if (!Object.keys(patch).length) {
    // Nothing new. The lease already moved updated_at, so pollers back off without a
    // second write (round 13, second pass: every idle poll wrote twice, and D1 Free
    // allows 100,000 rows written a day).
    return row
  }
  let landed = false
  try {
    landed = await applyObservation(db, row, patch, actor, now)
  } catch (e) {
    // UNIQUE(settled_tx) backstop: two swaps raced to settle on one payout tx.
    if (!patch.settled_tx) throw e
    // On NEAR a batch pays several swaps, so two of ours settling at the same moment can pick the same
    // receipt (round 29: the loser paused the route on an honest payout). It just waits: its next
    // refresh sees the receipt taken and settles on its own one.
    if (nearDest && /UNIQUE/i.test(String((e as Error)?.message || e))) {
      await logEvent(db, row.id, actor, 'settle_race', { receipt: patch.settled_tx })
      return row
    }
    await logEvent(db, row.id, actor, 'critical', ['payout_tx_reused'])
    await autoPause(db, row, ['payout_tx_reused'])
    return row
  }
  if (!landed) return (await db.prepare('SELECT * FROM intents_swaps WHERE id = ?').bind(row.id).first<SwapRow>()) || row

  const fresh = flags.filter(f => !prev.includes(f))
  if (fresh.length) await logEvent(db, row.id, actor, 'flags', fresh)
  const critical = fresh.filter(f => CRITICAL_FLAGS.has(f))
  if (critical.length) await autoPause(db, row, critical)
  return { ...merged, ...patch, ...(patch.state && patch.state !== row.state ? { state_at: now } : {}), updated_at: committedAt } as SwapRow
}

/**
 * One reconciliation pass: every unfinished swap, every expired one from the
 * last 7 days (a late deposit is still real money), and every refunded/failed
 * one from the last 24 h (to catch a contradiction). Oldest-touched first,
 * bounded so a pass fits the Worker subrequest budget.
 */
/**
 * D1 calls count against the same per-invocation subrequest cap as fetch()
 * (Cloudflare Workers limits page, read: "a request to Cloudflare
 * services like R2, KV, or D1"; D1 also caps queries at 50/invocation on Free,
 * a batch() counting as one). This proxy counts them into the same tally.
 */
function countingDB(db: D1Database, meter: { n: number; max?: number }): D1Database {
  const wrapStmt = (s: D1PreparedStatement): D1PreparedStatement => new Proxy(s, {
    get(target, prop) {
      if (prop === 'bind') return (...a: unknown[]) => wrapStmt((target as any).bind(...a))
      if (prop === 'run' || prop === 'first' || prop === 'all' || prop === 'raw') return (...a: unknown[]) => { subrequests++; meter.n++; return (target as any)[prop](...a) }
      return (target as any)[prop]
    },
  })
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrapStmt(target.prepare(sql))
      if (prop === 'batch') return (l: D1PreparedStatement[]) => { subrequests++; meter.n++; return target.batch(l) }
      return (target as any)[prop]
    },
  })
}

// Retention (round 13): nothing used to be deleted, so storage only grew, and an
// attacker minting addresses could fill a Free-plan database (500 MB). Swaps that never
// showed an address go after 1 day; unpaid addresses that expired go after 30 days
// (1Click refunds a late deposit by itself). Paid swaps are kept: they are the record.
const PURGE_PER_PASS = 50       // 2 statements each, one batch
// Never purged, whatever their age: anything that ever held money, owns a payout tx, or
// carries a flag or a critical / upstream-check event is evidence (round 13, second pass:
// the purge deleted the record of a router answer that named another swap's address).
// An expired row goes only once it has been checked AFTER 1Click's own deadline for the
// address (round 16: rows were purged with no final check, and a deposit 1Click accepted on
// day 2 of its 3 lost its record). Rows from before the column: our deadline + 3 days.
const KEEP = `(state = 'abandoned' OR updated_at > COALESCE(upstream_deadline_ms, deadline_ms + 259200000, created_at + 345600000))
  AND deposited IS NULL AND origin_txs IS NULL AND (flags IS NULL OR flags = '[]' OR state = 'abandoned')
  AND NOT EXISTS (SELECT 1 FROM intents_payouts p WHERE p.swap_id = intents_swaps.id)
  AND NOT EXISTS (SELECT 1 FROM intents_events e WHERE e.swap_id = intents_swaps.id AND e.kind IN ('critical','upstream_check_failed','flags'))`

// Queue order (round 13): swaps holding someone's money first; then ONE after-the-fact
// re-check (expired / refunded / failed — where a late deposit is found), so a desk full
// of open addresses cannot starve them; then open unpaid addresses; then the other
// re-checks. Unpaid addresses an attacker can mint at will can push neither a funded
// swap nor the late-deposit check out of a pass. Separate queries, each served by the
// (state, updated_at) index: an ORDER BY over a CASE made SQLite read every open row.
const MONEY_IN = `'deposit_seen','incomplete_deposit','processing','delivered_claimed'`
const RECHECK_MS = 10 * 60e3
const LATE_RECHECK_MS = 6 * 3600e3     // expired 7-30 days ago: a late deposit is still possible, rarely
const MAX_PAYOUT_TXS = 3
// NEAR (round 28): up to 5, newest first after any destination tx — a NEAR check costs 2 calls a tx
// (status + block), so 5 = 10, plus the token list and one reuse query: within VERIFY_MAX.
const NEAR_PAYOUT_TXS = 5
// Worst cases, fetch + D1 counted together. Verification: token list + 3 txs × (receipt,
// tx, ONE batch of balances/code/nonces, block) + chain head + owned list + reuse check = 16
// (rounds 31–33). NEAR: token list + 5 × (status, block) + reuse
// = 12. The rest: lease, status, unrecognised
// event, payout ownership 3 × 2, update, state + flags events, autoPause (7), lost-race read.
const VERIFY_MAX = 19      // + the latest block height (confirmations, round 24)
const PER_SWAP_MAX = 20
const AFTER_VERIFY_MAX = 10      // update, state + flags events, autoPause (7)

export async function reconcileBatch(env: IntentsEnv, rawDb: D1Database, limit = 25, now = Date.now(), spent = 0) {
  // 49 of the Free plan's 50: a pass must be able to verify one payout end to end (rounds 18, 24).
  const budget = Math.max(PER_SWAP_MAX + VERIFY_MAX + AFTER_VERIFY_MAX, Number(env.INTENTS_SUBREQ_BUDGET || 49))
  // `spent`: calls this invocation already made before the pass (round 19: the admin path
  // set up the tables on its own, uncounted, and a pass could then overrun the cap).
  const meter = { n: spent, max: budget }
  const db = countingDB(rawDb, meter)
  await ensureTables(db)     // counted: on a cold isolate it is several calls
  const q = async (sql: string, ...b: unknown[]) => ((await db.prepare(sql).bind(...b).all<SwapRow>()).results) || []
  // Swaps 1Click calls delivered lead (round 19): verification only fits early in a pass, and a
  // skipped one went to the back behind dust-funded rows, so a false SUCCESS raised its alarm late.
  // At most 2 lead a pass, and one past its verification grace (already flagged, route paused)
  // only every 30 min (round 21: a few that can never verify took every pass, forever, and no
  // other paid swap was reconciled again). The admin API can close one out ('resolve').
  const claimed = await q(`SELECT * FROM intents_swaps INDEXED BY intents_swaps_state WHERE state = 'delivered_claimed'
      AND (verify_attempts < ? OR updated_at < ?) ORDER BY updated_at ASC LIMIT 2`, VERIFY_GRACE_ATTEMPTS, now - 30 * 60e3)
  const money = [...claimed, ...(await q(`SELECT * FROM intents_swaps INDEXED BY intents_swaps_state WHERE state IN ('deposit_seen','incomplete_deposit','processing') ORDER BY updated_at ASC LIMIT ?`, limit))]
  // Unpaid open addresses at most every 5 minutes (round 34): each check leases the row — a D1 write —
  // and a network minting addresses it never pays made the reconciler spend ~30k rows a day of D1 Free's
  // 100k on them. A deposit is still seen at once by the member's own page, and by the next check here.
  const open = await q(`SELECT * FROM intents_swaps INDEXED BY intents_swaps_state WHERE state = 'awaiting_deposit' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?`, now - OPEN_RECHECK_MS, limit)
  // Final and expired swaps are re-checked inside a window that runs from when they ENTERED
  // that state (state_at); updated_at moves on every visit, so measured from it a refunded
  // swap stayed "recent" forever. Expired: every 10 min for 7 days, then every 6 h until
  // the 30-day purge, so a deposit in that gap is recorded before the row could go.
  // Two queries, each a range on an index (round 15: the combined OR read every expired
  // and refunded row every minute, against a 5M-rows-read-a-day Free quota).
  const expiredDue = await q(`SELECT * FROM intents_swaps INDEXED BY intents_swaps_state WHERE state = 'expired' AND updated_at < ?
        AND created_at >= ? AND (created_at >= ? OR updated_at < ?) ORDER BY updated_at ASC LIMIT 5`,
    now - RECHECK_MS, now - 30 * 86400e3, now - 7 * 86400e3, now - LATE_RECHECK_MS)
  const finalDue = await q(`SELECT * FROM intents_swaps INDEXED BY intents_swaps_state_at WHERE state IN ('refunded','failed') AND state_at >= ?
        AND updated_at < ? LIMIT 5`,
    now - 86400e3, now - RECHECK_MS)
  // A refunded/failed swap always gets the first re-check slot (round 18: a backlog of older
  // expired rows sorted ahead of it until its 24 h window closed, unchecked — and only these
  // re-checks can catch a refund 1Click later contradicts).
  const recheck = [...finalDue.slice(0, 1), ...[...expiredDue, ...finalDue.slice(1)].sort((a, b) => a.updated_at - b.updated_at)].slice(0, 5)
  // Re-checks alternate with open addresses (round 16: with 8+ open addresses only ONE
  // re-check fit a pass, ~1,440 a day for every expired swap of the last 30 days).
  const mixed: SwapRow[] = []
  for (let i = 0; i < Math.max(recheck.length, open.length); i++) { if (recheck[i]) mixed.push(recheck[i]); if (open[i]) mixed.push(open[i]) }
  // Money first, but never ALL of the pass (round 17: ~7 swaps in progress took every slot,
  // and open addresses and late-deposit re-checks were never reached): two money rows,
  // then one of the rest, repeating.
  const rows: SwapRow[] = []
  for (let i = 0, j = 0; i < money.length || j < mixed.length;) {
    if (i < money.length) rows.push(money[i++])
    if (i < money.length) rows.push(money[i++])
    if (j < mixed.length) rows.push(mixed[j++])
  }
  // Housekeeping can fail without taking the pass with it (round 16): before, any error here
  // rejected the whole pass, every minute, and no swap was ever checked again.
  try {
  // Budget windows older than 10 minutes are no longer read by take().
  await db.prepare('DELETE FROM intents_rl WHERE win < ?').bind(Math.floor(now / 1000 / 60) - 10).run()
  // Two index ranges, not one OR (round 15: the OR read every abandoned and expired row,
  // twice a minute). Pinned: EXPLAIN after ANALYZE showed SQLite picking full scans.
  // Found through the index, then deleted one by one by key, in the same batch as the rest
  // (a DELETE … IN (subquery) let SQLite walk the whole table to match the list).
  const gone = ((await db.prepare(`SELECT id FROM (
      SELECT id FROM intents_swaps INDEXED BY intents_swaps_state_created WHERE state = 'abandoned' AND created_at < ? AND ${KEEP}
      UNION ALL
      SELECT id FROM intents_swaps INDEXED BY intents_swaps_state_created WHERE state = 'expired' AND created_at < ? AND ${KEEP}
    ) LIMIT ${PURGE_PER_PASS}`).bind(now - 86400e3, now - 30 * 86400e3).all<{ id: string }>()).results || []).map(r => r.id)
  await db.batch([
    ...gone.flatMap(id => [
      db.prepare(`DELETE FROM intents_events INDEXED BY intents_events_swap WHERE swap_id = ?`).bind(id),
      db.prepare(`DELETE FROM intents_swaps WHERE id = ?`).bind(id),
    ]),
    // Reservations that never finished (crash between reserve and fill) are closed out.
    // Stamps only move forward here too (round 15): MAX(updated_at + 1, now).
    db.prepare(`UPDATE intents_swaps INDEXED BY intents_swaps_state_created SET state = 'abandoned', flags = '["reservation_timeout"]', updated_at = MAX(updated_at + 1, ?)
      WHERE state = 'reserving' AND created_at < ?`).bind(now, now - 120_000),
    // Unpaid addresses an hour past their deadline that no pass reached are marked expired
    // in bulk (round 13, second pass: a backlog left them "open" forever, holding their
    // client's slots and caps). An expired swap is still re-checked: a late deposit reopens it.
    db.prepare(`UPDATE intents_swaps INDEXED BY intents_swaps_state_deadline SET state = 'expired', state_at = ?, updated_at = MAX(updated_at + 1, ?)
      WHERE state = 'awaiting_deposit' AND deadline_ms IS NOT NULL AND deadline_ms < ?`).bind(now, now, now - 3600e3),
  ])
  } catch (e) { console.error('reconcile housekeeping', String((e as Error)?.message || e).slice(0, 300)) }
  const out: { id: string; from: string; to: string; flags: string | null }[] = []
  let deferred = 0
  const t0 = Date.now()
  for (const r of rows) {
    if (meter.n + PER_SWAP_MAX > budget) { deferred++; continue }   // queue order → they lead the next pass
    // Each swap gets its own clock reading: a pass can take minutes of upstream calls.
    // One swap that throws must not end the pass for every swap after it (round 15).
    try {
      const after = await refreshSwap(env, db, r, 'reconciler', now + (Date.now() - t0), true, meter)
      out.push({ id: r.id, from: r.state, to: after.state, flags: after.flags })
    } catch (e) {
      console.error('reconcile', r.id, String((e as Error)?.message || e).slice(0, 300))
      out.push({ id: r.id, from: r.state, to: r.state, flags: 'error' })
    }
  }
  return { checked: out.length, deferred, subrequests: meter.n, results: out }
}

/**
 * A critical discrepancy pauses the swap's route at once. Three different
 * swaps with critical flags inside 24 h pause the whole desk. Resuming is a
 * human decision (admin panel), never automatic. In-flight swaps keep being
 * tracked either way — a pause stops NEW quotes only.
 */
async function autoPause(db: D1Database, row: SwapRow, critical: string[]): Promise<void> {
  const { controls } = await readControls(db)
  if (!controls.routes[row.route]) await setControl(db, 'pause:route:' + row.route, `auto: ${critical.join(',')} on swap ${row.id}`, 'reconciler')
  await logEvent(db, row.id, 'reconciler', 'critical', critical)
  // The whole desk stops only on critical swaps from 3 different client NETWORKS in 24 h (round 30): one
  // client's own swaps can pause their route, but not every route for everyone. Rows from before the
  // network was stored count each on their own.
  const n = Number((await db.prepare(`SELECT COUNT(DISTINCT COALESCE(s.net, s.id)) AS v FROM intents_events e JOIN intents_swaps s ON s.id = e.swap_id
      WHERE e.kind = 'critical' AND e.at >= ?`).bind(Date.now() - 86400e3).first<{ v: number }>())?.v || 0)
  if (n >= 3 && !controls.globalPaused) await setControl(db, 'pause:global', `auto: critical flags from ${n} client networks in 24h`, 'reconciler')
}
