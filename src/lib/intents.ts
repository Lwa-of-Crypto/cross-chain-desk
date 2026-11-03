/**
 * lib/intents.ts — the cross-chain swap desk (NEAR Intents 1Click API).
 *
 * The live facts each check rests on are noted beside it.
 *
 * Pure: no bindings, no fetch. Everything that decides whether a member is
 * handed a deposit address lives here so test/intents.mjs can exercise the
 * exact shipped code.
 *
 * The rule this file exists to keep: a deposit address is only shown when
 *   - both assets are on a chain whose address format we check with a real
 *     checksum (no memo chains: a missing memo/tag loses the deposit),
 *   - the recipient is valid on the destination chain and the refund address
 *     is valid on the origin chain,
 *   - 1Click's answer echoes exactly what we asked for, and
 *   - the price is not absurd against an INDEPENDENT price (CoinGecko).
 * Every failure is a refusal with a reason, never a best guess.
 */

export const ONECLICK_BASE = 'https://1click.chaindefuser.com'

export type Family = 'evm' | 'btc' | 'ltc' | 'doge' | 'tron' | 'sol' | 'near'

// evmChainId: the chain a connected wallet must be on to pay a deposit here (EIP-155, hex as
// wallets report it). Each was read from that chain's own RPC (eth_chainId), not from memory.
export interface ChainInfo { label: string; family: Family; deadlineMin: number; evmChainId?: string }

// v1 allowlist. Left out on purpose (read, docs.near-intents.org
// resources/chain-support.md): xrp (destination tags unsupported), stellar/ton
// (deposit memo required), cardano/zec (marked partial). Add a chain only after
// its address format is checked here.
// Null prototype + frozen: CHAINS['toString'] / CHAINS['__proto__'] must be
// undefined, not Object.prototype members (red-team: the admin pause
// validator accepted "toString" and "constructor>sol" as chains).
export const CHAINS: Readonly<Record<string, ChainInfo>> = Object.freeze(Object.assign(Object.create(null), {
  eth:    { label: 'Ethereum',  family: 'evm',  deadlineMin: 60, evmChainId: '0x1' },
  base:   { label: 'Base',      family: 'evm',  deadlineMin: 60, evmChainId: '0x2105' },
  arb:    { label: 'Arbitrum',  family: 'evm',  deadlineMin: 60, evmChainId: '0xa4b1' },
  op:     { label: 'Optimism',  family: 'evm',  deadlineMin: 60, evmChainId: '0xa' },
  bsc:    { label: 'BNB Chain', family: 'evm',  deadlineMin: 60, evmChainId: '0x38' },
  pol:    { label: 'Polygon',   family: 'evm',  deadlineMin: 60, evmChainId: '0x89' },
  avax:   { label: 'Avalanche', family: 'evm',  deadlineMin: 60, evmChainId: '0xa86a' },
  gnosis: { label: 'Gnosis',    family: 'evm',  deadlineMin: 60, evmChainId: '0x64' },
  // UTXO chains: a deposit can sit an hour before it confirms.
  btc:    { label: 'Bitcoin',   family: 'btc',  deadlineMin: 360 },
  ltc:    { label: 'Litecoin',  family: 'ltc',  deadlineMin: 360 },
  doge:   { label: 'Dogecoin',  family: 'doge', deadlineMin: 360 },
  tron:   { label: 'Tron',      family: 'tron', deadlineMin: 60 },
  sol:    { label: 'Solana',    family: 'sol',  deadlineMin: 60 },
  near:   { label: 'NEAR',      family: 'near', deadlineMin: 60 },
}))

export const SLIPPAGE = { min: 10, max: 300, def: 100 } as const
// Cost vs an independent mid price, in bps. Calibrated against the live quote
// sweep in the live quote backtest.
export const COST = { warn: 150, block: 800 } as const

// ───────────────────────────────────────────────────────────── tokens ──
export interface Token {
  id: string; chain: string; symbol: string; decimals: number
  price: number | null; cg: string | null
  contract: string | null      // token contract / SPL mint / NEP-141 account; null for native coins
}

const ASSET_ID = /^(nep141|nep245|1cs_v1):[A-Za-z0-9._:\-]{1,200}$/

/** 1Click /v0/tokens → the slim list the desk may use (allowlisted chains only). */
export function slimTokens(raw: unknown): Token[] {
  if (!Array.isArray(raw)) return []
  const out: Token[] = []
  const seen = new Set<string>()
  for (const t of raw as any[]) {
    if (!t || typeof t !== 'object') continue
    const chain = String(t.blockchain || '')
    if (!Object.prototype.hasOwnProperty.call(CHAINS, chain)) continue
    const id = String(t.assetId || '')
    if (!ASSET_ID.test(id) || seen.has(id)) continue
    const decimals = Number(t.decimals)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) continue
    const symbol = String(t.symbol || '').slice(0, 16)
    if (!/^[A-Za-z0-9.$_\-+]{1,16}$/.test(symbol)) continue
    const price = Number(t.price)
    const cg = typeof t.coingeckoId === 'string' && /^[a-z0-9\-]{1,80}$/.test(t.coingeckoId) ? t.coingeckoId : null
    const contract = typeof t.contractAddress === 'string' && /^[A-Za-z0-9._\-]{2,120}$/.test(t.contractAddress) ? t.contractAddress : null
    // An EVM asset id names its own contract; if the list's contractAddress
    // disagrees, the entry is lying about what it is (red-team round 2).
    const m = /^nep141:[a-z]+-(0x[0-9a-f]{40})\.omft\.near$/.exec(id)
    if (m && (!contract || contract.toLowerCase() !== m[1])) continue
    // Round 23: the other forms that name their contract are held to it too — since round 22 the
    // contract frozen at issue decides which token proves a payout. (Solana's sol-0x….omdep.near
    // embeds a bridge address, not the mint, so it is not compared.)
    const named = /^nep141:(?!sol-)[a-z]+-(0x[0-9a-f]{40})\.omdep\.near$/.exec(id)
      || /^1cs_v1:[a-z]+:(?:erc20|bep20):(0x[0-9a-fA-F]{40})$/.exec(id)
    if (named && (!contract || contract.toLowerCase() !== named[1].toLowerCase())) continue
    const spl = /^1cs_v1:sol:spl:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(id)
    if (spl && contract !== spl[1]) continue
    seen.add(id)
    out.push({ id, chain, symbol, decimals, price: Number.isFinite(price) && price > 0 ? price : null, cg, contract })
  }
  // "Ticker symbols are not unique identifiers" (Stan's brief): a member picks
  // by symbol, so two tokens sharing a symbol on one chain are BOTH withheld
  // rather than letting a poisoned list slip a look-alike under a trusted name.
  const count = new Map<string, number>()
  for (const t of out) { const k = t.chain + '\u0000' + t.symbol.toUpperCase(); count.set(k, (count.get(k) || 0) + 1) }
  return out.filter(t => count.get(t.chain + '\u0000' + t.symbol.toUpperCase()) === 1)
    .sort((a, b) => a.chain.localeCompare(b.chain) || a.symbol.localeCompare(b.symbol))
}

// ──────────────────────────────────────────────────────────── amounts ──
/** "1.5" with 6 decimals → 1500000n. BigInt only; null on anything odd. */
export function toBaseUnits(s: string, decimals: number): bigint | null {
  const v = String(s ?? '').trim()
  if (!/^\d{1,30}(\.\d{1,30})?$/.test(v)) return null
  const [i, f = ''] = v.split('.')
  if (f.length > decimals) return null
  const n = BigInt(i + f.padEnd(decimals, '0'))
  return n > 0n ? n : null
}

/** 1500000n, 6 → "1.5" */
export function fromBaseUnits(n: bigint | string, decimals: number): string {
  const s = BigInt(n).toString().padStart(decimals + 1, '0')
  if (!decimals) return s
  const i = s.slice(0, s.length - decimals)
  const f = s.slice(s.length - decimals).replace(/0+$/, '')
  return f ? i + '.' + f : i
}

// ─────────────────────────────────────────────────────────── keccak256 ──
// Original Keccak (0x01 padding), as used by EIP-55. BigInt lanes: slow but
// only ever run on a handful of addresses per request.
const M64 = (1n << 64n) - 1n
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]
const rotl = (v: bigint, n: number) => n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64

function keccakF(A: bigint[]): void {
  const C = new Array<bigint>(5), B = new Array<bigint>(25)
  for (let r = 0; r < 24; r++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1)
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++)
      B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y])
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++)
      A[x + y] = B[x + y] ^ (~B[(x + 1) % 5 + y] & M64 & B[(x + 2) % 5 + y])
    A[0] ^= RC[r]
  }
}

export function keccak256(bytes: Uint8Array): Uint8Array {
  const rate = 136
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate)
  padded.set(bytes)
  padded[bytes.length] ^= 0x01
  padded[padded.length - 1] ^= 0x80
  const A = new Array<bigint>(25).fill(0n)
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b])
      A[i] ^= lane
    }
    keccakF(A)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out[i * 8 + b] = Number((A[i] >> BigInt(8 * b)) & 0xffn)
  return out
}

/** EIP-55: all-lower and all-upper pass on shape alone; mixed case must match the checksum. */
export function evmAddressOk(s: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return false
  const body = s.slice(2)
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true
  const h = keccak256(new TextEncoder().encode(body.toLowerCase()))
  for (let i = 0; i < 40; i++) {
    const nib = (h[i >> 1] >> (i % 2 ? 0 : 4)) & 0xf
    const c = body[i]
    if (/[a-f]/.test(c) && nib >= 8) return false
    if (/[A-F]/.test(c) && nib < 8) return false
  }
  return true
}

// ─────────────────────────────────────────────────────────── base58 ──
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export function base58Decode(s: string): Uint8Array | null {
  if (!s || s.length > 120) return null
  let n = 0n
  for (const ch of s) {
    const v = B58.indexOf(ch)
    if (v < 0) return null
    n = n * 58n + BigInt(v)
  }
  const bytes: number[] = []
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n }
  for (const ch of s) { if (ch === '1') bytes.unshift(0); else break }
  return new Uint8Array(bytes)
}

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b))
}

/** base58check → payload (without checksum) if the checksum holds. */
export async function base58Check(s: string): Promise<Uint8Array | null> {
  const raw = base58Decode(s)
  if (!raw || raw.length < 5) return null
  const payload = raw.slice(0, -4)
  const sum = (await sha256(await sha256(payload))).slice(0, 4)
  for (let i = 0; i < 4; i++) if (sum[i] !== raw[raw.length - 4 + i]) return null
  return payload
}

// ─────────────────────────────────────────────────────────── bech32 ──
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i]
  }
  return chk >>> 0
}

/** Segwit address for `hrp` → true if checksum + witness program rules hold (BIP-173/350). */
export function segwitOk(hrp: string, addr: string): boolean {
  if (addr.length > 90) return false
  const lower = addr.toLowerCase()
  if (addr !== lower && addr !== addr.toUpperCase()) return false
  const pos = lower.lastIndexOf('1')
  if (pos < 1 || lower.slice(0, pos) !== hrp || lower.length - pos - 1 < 6) return false
  const data: number[] = []
  for (const ch of lower.slice(pos + 1)) { const v = B32.indexOf(ch); if (v < 0) return false; data.push(v) }
  const hrpExp = [...hrp].map(c => c.charCodeAt(0) >> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31))
  const pm = polymod(hrpExp.concat(data))
  const ver = data[0]
  if (ver > 16) return false
  if (pm !== (ver === 0 ? 1 : 0x2bc830a3)) return false
  // 5-bit → 8-bit, no padding allowed beyond 4 zero bits
  let acc = 0, bits = 0
  const prog: number[] = []
  for (const v of data.slice(1, -6)) {
    acc = (acc << 5) | v; bits += 5
    while (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 0xff) }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) return false
  if (prog.length < 2 || prog.length > 40) return false
  if (ver === 0 && prog.length !== 20 && prog.length !== 32) return false
  // Consensus, not just encoding (red-team round 7): witness v2–v16, and v1 with a
  // program that is not 32 bytes, are valid bech32m but ANYONE-CAN-SPEND under
  // today's rules — coins sent there can be taken by a stranger. Wallets refuse
  // them (BIP-350 "send to future versions" is for wallets that know better).
  if (ver >= 2) return false
  if (ver === 1 && prog.length !== 32) return false
  return true
}

// ───────────────────────────────────────────────────────── addresses ──
const NEAR_NAMED = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/

/** NEAR named account (alice.near) — the only kind that can fail to exist. */
export function isNearNamed(s: string): boolean {
  return NEAR_NAMED.test(s) && !/^[0-9a-f]{64}$/.test(s)
}

export async function validAddress(chain: string, s: unknown): Promise<boolean> {
  if (typeof s !== 'string') return false
  const a = s.trim()
  if (a !== s || !a || a.length > 120) return false
  const info = CHAINS[chain]
  if (!info) return false
  switch (info.family) {
    case 'evm': return evmAddressOk(a)
    case 'btc': {
      if (/^bc1/i.test(a)) return segwitOk('bc', a)
      const p = await base58Check(a)
      return !!p && p.length === 21 && (p[0] === 0x00 || p[0] === 0x05)
    }
    case 'ltc': {
      if (/^ltc1/i.test(a)) return segwitOk('ltc', a)
      const p = await base58Check(a)
      return !!p && p.length === 21 && (p[0] === 0x30 || p[0] === 0x32 || p[0] === 0x05)
    }
    case 'doge': {
      const p = await base58Check(a)
      return !!p && p.length === 21 && (p[0] === 0x1e || p[0] === 0x16)
    }
    case 'tron': {
      const p = await base58Check(a)
      return !!p && p.length === 21 && p[0] === 0x41
    }
    case 'sol': {
      if (a.length < 32 || a.length > 44) return false
      const b = base58Decode(a)
      return !!b && b.length === 32
    }
    case 'near':
      // implicit (64 hex), eth-implicit (0x + 40 lowercase hex), or named
      return /^[0-9a-f]{64}$/.test(a) || /^0x[0-9a-f]{40}$/.test(a) || NEAR_NAMED.test(a)
  }
  return false
}

// ─────────────────────────────────────────────────────── unspendable ──
// Valid-looking addresses nobody holds a key for. Money sent there is gone.
// Red-team: every one of these passed validAddress.
const SOL_NOT_WALLETS = new Set([
  'So11111111111111111111111111111111111111112',   // wSOL mint
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',   // SPL Token program
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',   // Token-2022 program
  'ATokenGPvbdGVxr1b2hvZ9MGRXV1i8Xm6pXjkUzWcfb6',  // Associated Token program
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',   // Memo program
  'ComputeBudget111111111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
])
// …and the intents contract and the wNEAR contract (round 27): a payout there is no member's wallet,
// and payout verification on NEAR reads intents.near as the payer.
const NEAR_NOT_WALLETS = new Set(['system', 'near', 'registrar', 'intents.near', 'wrap.near'])
const allZero = (b: Uint8Array) => b.every(x => x === 0)

function segwitProgram(addr: string): Uint8Array | null {
  const lower = addr.toLowerCase(), pos = lower.lastIndexOf('1')
  const data: number[] = []
  for (const ch of lower.slice(pos + 1, -6)) data.push(B32.indexOf(ch))
  let acc = 0, bits = 0
  const out: number[] = []
  for (const v of data.slice(1)) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff) } }
  return new Uint8Array(out)
}

/** true when `addr` (already validAddress on `chain`) is a burn / system / program address. */
export async function unspendable(chain: string, addr: string): Promise<boolean> {
  const info = CHAINS[chain]
  if (!info) return true
  switch (info.family) {
    case 'evm': {
      const h = addr.slice(2).toLowerCase()
      // zero address, precompiles and every 0x000…dEaD-style address (first 18 bytes zero), and all-f
      return /^0{36}/.test(h) || /^f{40}$/.test(h)
    }
    case 'btc': case 'ltc': case 'doge': case 'tron': {
      if (/^(bc1|ltc1)/i.test(addr)) { const p = segwitProgram(addr); return !p || allZero(p) }
      const p = await base58Check(addr)
      return !p || allZero(p.slice(1))       // version byte + 20-byte hash; a zero hash is a burn address
    }
    case 'sol': {
      const b = base58Decode(addr)
      return !b || allZero(b) || SOL_NOT_WALLETS.has(addr)
    }
    case 'near':
      return /^0+$/.test(addr.replace(/^0x/, '')) || NEAR_NOT_WALLETS.has(addr)
  }
  return true
}

// ─────────────────────────────────────────────────────────── request ──
export interface QuoteInput {
  from: string; to: string; amount: string
  recipient: string; refundTo: string
  slippageBps?: number; dry: boolean
}
export interface FeeCfg { feeBps: number; feeRecipient: string }

export type Built = { ok: true; body: Record<string, unknown>; from: Token; to: Token; amountBase: bigint }
                  | { ok: false; error: string; field?: string }

export function feeCfgFrom(env: { INTENTS_FEE_BPS?: string; INTENTS_FEE_RECIPIENT?: string }): FeeCfg {
  // plain whole numbers only: Number('0x1e') and Number('3e1') are both 30 (round 10)
  const rawBps = String(env.INTENTS_FEE_BPS ?? '').replace(/^\uFEFF/, '').trim()
  const bps = /^\d{1,3}$/.test(rawBps) ? Number(rawBps) : 0
  const rec = String(env.INTENTS_FEE_RECIPIENT || '').replace(/^\uFEFF/, '').trim()
  // A fee needs a valid NEAR-side recipient and stays well under the 500 bps
  // total cap 1Click enforces (its own share is added on top).
  if (!Number.isInteger(bps) || bps <= 0 || bps > 100) return { feeBps: 0, feeRecipient: '' }
  if (!(/^[0-9a-f]{64}$/.test(rec) || /^0x[0-9a-f]{40}$/.test(rec) || NEAR_NAMED.test(rec))) return { feeBps: 0, feeRecipient: '' }
  return { feeBps: bps, feeRecipient: rec }
}

export function isTokenContract(tokens: Token[], chain: string, addr: string): boolean {
  const evm = CHAINS[chain]?.family === 'evm'
  const a = evm ? addr.toLowerCase() : addr
  return tokens.some(t => t.chain === chain && t.contract !== null && (evm ? t.contract.toLowerCase() : t.contract) === a)
}

export async function buildQuoteRequest(input: QuoteInput, tokens: Token[], fee: FeeCfg, now: number): Promise<Built> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'bad_body' }
  const from = tokens.find(t => t.id === input.from)
  const to = tokens.find(t => t.id === input.to)
  if (!from) return { ok: false, error: 'unsupported_from_asset', field: 'from' }
  if (!to) return { ok: false, error: 'unsupported_to_asset', field: 'to' }
  if (from.id === to.id) return { ok: false, error: 'same_asset', field: 'to' }
  const amountBase = toBaseUnits(input.amount, from.decimals)
  if (amountBase === null) return { ok: false, error: 'bad_amount', field: 'amount' }
  if (!(await validAddress(to.chain, input.recipient))) return { ok: false, error: 'bad_recipient', field: 'recipient' }
  if (!(await validAddress(from.chain, input.refundTo))) return { ok: false, error: 'bad_refund_address', field: 'refundTo' }
  // A pasted TOKEN CONTRACT is the classic way to send money nowhere. Measured
  // 1Click answers "Internal server error" to a refund of wrap.near.
  if (isTokenContract(tokens, to.chain, input.recipient)) return { ok: false, error: 'recipient_is_token_contract', field: 'recipient' }
  if (isTokenContract(tokens, from.chain, input.refundTo)) return { ok: false, error: 'refund_is_token_contract', field: 'refundTo' }
  if (await unspendable(to.chain, input.recipient)) return { ok: false, error: 'recipient_unspendable', field: 'recipient' }
  if (await unspendable(from.chain, input.refundTo)) return { ok: false, error: 'refund_unspendable', field: 'refundTo' }
  // bech32 is case-insensitive and QR codes carry it UPPERCASE, but the chain
  // (and our payout check) report it lowercase — send it lowercase so a legal
  // address never fails verification and pauses a route (red-team round 2).
  const canon = (chain: string, a: string) => /^(bc1|ltc1)/i.test(a) && ['btc', 'ltc'].includes(CHAINS[chain]?.family) ? a.toLowerCase() : a
  input = { ...input, recipient: canon(to.chain, input.recipient), refundTo: canon(from.chain, input.refundTo) }
  let slip = input.slippageBps === undefined ? SLIPPAGE.def : Number(input.slippageBps)
  if (!Number.isInteger(slip) || slip < SLIPPAGE.min || slip > SLIPPAGE.max) return { ok: false, error: 'bad_slippage', field: 'slippageBps' }
  const deadline = new Date(now + CHAINS[from.chain].deadlineMin * 60_000).toISOString()
  const body: Record<string, unknown> = {
    dry: !!input.dry,
    swapType: 'EXACT_INPUT',
    depositMode: 'SIMPLE',
    slippageTolerance: slip,
    originAsset: from.id,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: to.id,
    amount: amountBase.toString(),
    refundTo: input.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: input.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline,
    referral: 'cryptolwa',
    // A/B on live 1Click, 18 paired quotes on 3 routes: waiting 3 s
    // for solvers gained a mean 0.28 bps (median 0) and cost 2.7 s per quote.
    quoteWaitingTimeMs: 0,
  }
  if (fee.feeBps > 0) body.appFees = [{ recipient: fee.feeRecipient, fee: fee.feeBps }]
  return { ok: true, body, from, to, amountBase }
}

// ───────────────────────────────────────────────────────────── check ──
const sameAddr = (chain: string, a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' &&
  (CHAINS[chain]?.family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b)

export interface CheckedQuote {
  amountIn: string; amountOut: string; minAmountOut: string
  amountInUsd: number | null; amountOutUsd: number | null
  timeEstimate: number | null
  depositAddress: string | null
  deadline: string | null; timeWhenInactive: string | null
  platformFeeBps: number; ourFeeBps: number
  signature: string | null; correlationId: string | null; timestamp: string | null
}

const posInt = (s: unknown) => typeof s === 'string' && /^\d{1,60}$/.test(s)
const num = (s: unknown) => { const n = Number(s); return Number.isFinite(n) ? n : null }

/** Fail closed: anything that does not echo our request exactly is refused. */
export async function checkQuote(sent: Record<string, any>, from: Token, to: Token, got: any, fee: FeeCfg, tokens: Token[] = []):
  Promise<{ ok: true; q: CheckedQuote } | { ok: false; error: string }> {
  if (!got || typeof got !== 'object' || !got.quote || !got.quoteRequest) return { ok: false, error: 'upstream_shape' }
  const r = got.quoteRequest, q = got.quote
  if (r.originAsset !== sent.originAsset || r.destinationAsset !== sent.destinationAsset) return { ok: false, error: 'echo_asset' }
  if (String(r.amount) !== String(sent.amount)) return { ok: false, error: 'echo_amount' }
  if (!sameAddr(to.chain, r.recipient, sent.recipient)) return { ok: false, error: 'echo_recipient' }
  if (!sameAddr(from.chain, r.refundTo, sent.refundTo)) return { ok: false, error: 'echo_refund' }
  if (r.recipientType !== 'DESTINATION_CHAIN' || r.refundType !== 'ORIGIN_CHAIN' || r.depositType !== 'ORIGIN_CHAIN') return { ok: false, error: 'echo_types' }
  if (r.swapType !== 'EXACT_INPUT') return { ok: false, error: 'echo_swap_type' }
  if (!!r.dry !== !!sent.dry) return { ok: false, error: 'echo_dry' }
  if (r.customRecipientMsg || q.customRecipientMsg) return { ok: false, error: 'unexpected_recipient_msg' }
  if (!posInt(q.amountIn) || !posInt(q.amountOut) || !posInt(q.minAmountOut)) return { ok: false, error: 'upstream_amounts' }
  if (String(q.amountIn) !== String(sent.amount)) return { ok: false, error: 'echo_amount_in' }
  if (BigInt(q.amountOut) <= 0n || BigInt(q.minAmountOut) <= 0n || BigInt(q.minAmountOut) > BigInt(q.amountOut)) return { ok: false, error: 'upstream_amounts' }
  // The guaranteed minimum must honour the slippage WE asked for (+5 bps for
  // rounding). Measured live: minAmountOut = amountOut × (1 − slippage) exactly.
  if (Number(r.slippageTolerance) !== Number(sent.slippageTolerance)) return { ok: false, error: 'echo_slippage' }
  if (BigInt(q.minAmountOut) * 10000n < BigInt(q.amountOut) * BigInt(10000 - Number(sent.slippageTolerance) - 5)) return { ok: false, error: 'min_out_below_slippage' }
  if (sent.deadline && r.deadline && Date.parse(r.deadline) !== Date.parse(sent.deadline)) return { ok: false, error: 'echo_deadline' }

  // Fees actually attached to the quote. Ours must be exactly what we sent;
  // everything else on the list is 1Click's platform fee (it adds its own
  // entry when the request carries no partner key — measured).
  let platform = 0, ours = 0
  for (const f of Array.isArray(r.appFees) ? r.appFees : []) {
    const bps = Number(f?.fee)
    if (!Number.isFinite(bps) || bps < 0 || bps > 500) return { ok: false, error: 'upstream_fee' }
    if (fee.feeBps > 0 && f?.recipient === fee.feeRecipient) ours += bps
    else platform += bps
  }
  if (ours !== fee.feeBps) return { ok: false, error: 'echo_fee' }
  if (platform + ours > 500) return { ok: false, error: 'upstream_fee' }

  let depositAddress: string | null = null
  if (!sent.dry) {
    if (q.depositMemo) return { ok: false, error: 'memo_required' }   // no memo chains in v1
    if (!(await validAddress(from.chain, q.depositAddress))) return { ok: false, error: 'bad_deposit_address' }
    // A compromised or buggy router must not be able to point the member at a
    // burn address, a token contract, or back at the member's own wallet
    // (red-team: all three were shown).
    if (await unspendable(from.chain, q.depositAddress)) return { ok: false, error: 'deposit_unspendable' }
    if (isTokenContract(tokens, from.chain, q.depositAddress)) return { ok: false, error: 'deposit_is_token_contract' }
    if (sameAddr(from.chain, q.depositAddress, sent.refundTo) || sameAddr(from.chain, q.depositAddress, sent.recipient)) return { ok: false, error: 'deposit_is_member_address' }
    depositAddress = q.depositAddress
    if (!q.deadline || !Number.isFinite(Date.parse(q.deadline))) return { ok: false, error: 'upstream_deadline' }
    // An address that dies before a member could realistically pay it is not an
    // address (red-team round 2: one already past its deadline was shown).
    if (Date.parse(q.deadline) < Date.now() + 15 * 60_000) return { ok: false, error: 'upstream_deadline_too_soon' }
  }
  return {
    ok: true,
    q: {
      amountIn: q.amountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut,
      amountInUsd: num(q.amountInUsd), amountOutUsd: num(q.amountOutUsd),
      timeEstimate: num(q.timeEstimate),
      depositAddress,
      deadline: q.deadline || null, timeWhenInactive: q.timeWhenInactive || null,
      platformFeeBps: platform, ourFeeBps: ours,
      signature: typeof got.signature === 'string' ? got.signature.slice(0, 200) : null,
      correlationId: typeof got.correlationId === 'string' ? got.correlationId.slice(0, 80) : null,
      timestamp: typeof got.timestamp === 'string' ? got.timestamp.slice(0, 40) : null,
    },
  }
}

/**
 * What the member gives up vs mid, in bps, using prices that do NOT come from
 * the router being graded. null when a price is missing.
 */
export function costBps(amountIn: string, from: Token, pIn: number | null,
                        amountOut: string, to: Token, pOut: number | null): number | null {
  if (!pIn || !pOut) return null
  const usdIn = Number(fromBaseUnits(amountIn, from.decimals)) * pIn
  const usdOut = Number(fromBaseUnits(amountOut, to.decimals)) * pOut
  if (!(usdIn > 0) || !Number.isFinite(usdOut)) return null
  return Math.round((1 - usdOut / usdIn) * 10000)
}

export function costVerdict(bps: number | null): 'ok' | 'warn' | 'block' | 'unpriced' {
  if (bps === null) return 'unpriced'
  if (bps > COST.block) return 'block'
  if (bps > COST.warn) return 'warn'
  return 'ok'
}

/** Status passthrough, trimmed to what the desk shows. */
export const STATUSES = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'] as const

export function slimStatus(raw: any): { ok: true; s: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || !STATUSES.includes(raw.status)) return { ok: false, error: 'upstream_shape' }
  const d = raw.swapDetails || {}
  // The HASH is what matters: the verifier reads the chain with it, and the page builds its own
  // explorer link from the chain + a hash of the right shape. A tx used to be dropped unless its
  // explorerUrl was https; measured live on the first real swap, 1Click answers explorerUrl "" for
  // every tx, so every payout hash was lost and no swap could be verified. Now: letters and digits
  // only (no markup can be stored), and the router's link kept only when it is https.
  const txs = (a: any) => (Array.isArray(a) ? a : []).slice(0, 5)
    .filter((t: any) => t && typeof t.hash === 'string' && /^[0-9A-Za-z]{1,120}$/.test(t.hash))
    .map((t: any) => ({ hash: t.hash, explorerUrl: typeof t.explorerUrl === 'string' && /^https:\/\//.test(t.explorerUrl) ? t.explorerUrl.slice(0, 300) : '' }))
  const str = (v: any, n = 60) => (typeof v === 'string' ? v.slice(0, n) : null)
  const base = (v: any) => (typeof v === 'string' && /^\d{1,60}$/.test(v) ? v : null)
  // What the status feed says the swap IS (checked live: every status
  // carries quoteResponse.quoteRequest). refreshSwap compares it with the ledger.
  const qr = raw.quoteResponse?.quoteRequest
  const echo = qr && typeof qr === 'object' ? {
    recipient: str(qr.recipient, 120), refundTo: str(qr.refundTo, 120),
    originAsset: str(qr.originAsset, 220), destinationAsset: str(qr.destinationAsset, 220), amount: base(qr.amount),
  } : null
  return {
    ok: true,
    s: {
      status: raw.status,
      echo,
      updatedAt: str(raw.updatedAt, 40),
      depositedAmount: base(d.depositedAmount),
      amountOut: base(d.amountOut),
      refundedAmount: base(d.refundedAmount),
      depositedAmountFormatted: str(d.depositedAmountFormatted),
      amountInFormatted: str(d.amountInFormatted),
      amountOutFormatted: str(d.amountOutFormatted),
      amountOutUsd: str(d.amountOutUsd),
      refundedAmountFormatted: str(d.refundedAmountFormatted),
      refundReason: str(d.refundReason),
      originTxs: txs(d.originChainTxHashes),
      destinationTxs: txs(d.destinationChainTxHashes),
      // "All NEAR transactions executed for this swap" (1Click OpenAPI, read): where a
      // payout ON NEAR is, when destinationChainTxHashes does not name it. Base58 tx hashes only.
      // The LAST ten (round 28): a payout is among a swap's latest NEAR txs, and the first five used
      // to be kept, so a long list lost it.
      nearTxs: (Array.isArray(d.nearTxHashes) ? d.nearTxHashes : []).slice(-50)
        .filter((h: any) => typeof h === 'string' && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(h)).slice(-10),
    },
  }
}

/** Deposit addresses the status/submit proxies accept: any allowlisted chain's format. */
export async function anyDepositAddress(s: unknown): Promise<boolean> {
  if (typeof s !== 'string' || s.length > 120) return false
  for (const c of ['eth', 'btc', 'ltc', 'doge', 'tron', 'sol', 'near']) if (await validAddress(c, s)) return true
  return false
}

export const TX_HASH = /^(0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{43,90})$/
