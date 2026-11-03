/**
 * lib/intents-proof.ts — proof of delivery (round 27).
 *
 * A settled swap gets a signed statement of what the desk checked: which chain, which asset,
 * to whom, at least how much, and the payout tx (on NEAR, the payout receipt inside it). The
 * signature proves THE DESK said so; the explorer link lets anyone see it happened without
 * trusting the desk at all. Same swap, same proof: nothing time-varying is signed.
 *
 * Key: Ed25519, its 32-byte seed = HMAC-SHA256(DESK_SECRET, 'proof-key|v1'), so there is no
 * extra secret to manage and rotating DESK_SECRET rotates it. Checked against RFC 8032 test 1:
 * the PKCS#8 wrapping below gives the published public key. `kid` names the key.
 */
import { CHAINS, fromBaseUnits } from './intents'
import type { SwapRow } from './intents-ledger'

const enc = new TextEncoder()
const PKCS8_ED25519 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]
const b64u = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (const x of u) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unb64u = (s: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
    const out = Uint8Array.from(bin, c => c.charCodeAt(0))
    // Canonical only (round 27): a 64-byte value leaves 4 unused bits in the last character, and
    // atob ignores them, so a second spelling of the same signature also verified.
    return b64u(out) === s ? out : null
  } catch { return null }
}

type Keys = { priv: CryptoKey; pub: CryptoKey; x: string; kid: string }
let cache: { secret: string; keys: Promise<Keys> } | null = null

async function derive(secret: string): Promise<Keys> {
  const hk = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const seed = new Uint8Array(await crypto.subtle.sign('HMAC', hk, enc.encode('proof-key|v1')))
  const priv = await crypto.subtle.importKey('pkcs8', new Uint8Array([...PKCS8_ED25519, ...seed]), { name: 'Ed25519' }, true, ['sign'])
  const x = (await crypto.subtle.exportKey('jwk', priv) as JsonWebKey).x as string
  const pub = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x }, { name: 'Ed25519' }, false, ['verify'])
  const kid = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(x)))).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')
  return { priv, pub, x, kid }
}
export function proofKeys(secret: string): Promise<Keys> {
  if (!cache || cache.secret !== secret) {
    const keys = derive(secret)
    cache = { secret, keys }
    keys.catch(() => { if (cache?.keys === keys) cache = null })   // a failed derivation is not kept
  }
  return cache.keys
}

// Our own explorer links, never the feed's (1Click's explorerUrl is untrusted input).
const EXPLORER: Record<string, string> = {
  eth: 'https://etherscan.io/tx/', base: 'https://basescan.org/tx/', arb: 'https://arbiscan.io/tx/',
  op: 'https://optimistic.etherscan.io/tx/', bsc: 'https://bscscan.com/tx/', pol: 'https://polygonscan.com/tx/',
  avax: 'https://snowtrace.io/tx/', gnosis: 'https://gnosisscan.io/tx/', sol: 'https://solscan.io/tx/',
  btc: 'https://mempool.space/tx/', near: 'https://nearblocks.io/txns/', tron: 'https://tronscan.org/#/transaction/',
  doge: 'https://blockchair.com/dogecoin/transaction/', ltc: 'https://blockchair.com/litecoin/transaction/',
}

const CHECK_TEXT: Record<string, string> = {
  onchain: 'Checked on the destination chain by the desk: the payout named here (together with any other parts 1Click named for this swap, if it paid in parts) gave the recipient at least the guaranteed amount of this asset, after the swap was created, final, and not sent by the recipient itself.',
  reported: 'Reported delivered by 1Click with a payout transaction and an amount at least the guarantee. Payouts on this chain are not checked on-chain by this desk yet.',
  manual: 'Closed by the desk operator after a manual review of the payout.',
}

// On NEAR nothing is summed: one payout receipt settles one swap (round 29: the generic text spoke of parts).
const NEAR_TEXT = 'Checked on NEAR by the desk: this payout receipt (from intents.near, final, successful) paid the recipient at least the guaranteed amount of this token, from an intents balance that is not the recipient\'s own, after the swap was created. One receipt settles one swap.'

/** The statement for a settled swap, or null. Key order is fixed: the string IS what is signed. */
export function proofPayload(row: SwapRow): string | null {
  if (row.state !== 'settled') return null
  const check = row.dest_verified === 'verified' || row.dest_verified === 'confirmed' ? 'onchain'
    : row.dest_verified === 'manual' ? 'manual' : row.dest_verified === 'unverifiable' ? 'reported' : null
  if (!check) return null
  let tx: string | null = null, receipt: string | null = null
  if (row.settled_tx) [tx, receipt] = row.settled_tx.includes('#') ? row.settled_tx.split('#', 2) : [row.settled_tx, null]
  else if (check === 'reported') {
    // 1Click's bytes, so only a hash of this chain's shape is signed (round 28); otherwise none.
    try { const d = JSON.parse(row.dest_txs || '[]'); tx = typeof d?.[0]?.hash === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(d[0].hash) ? d[0].hash : null } catch { tx = null }
  }
  const fmt = (v: string | null, dec: number | null) => (v && /^\d+$/.test(v) && Number.isInteger(dec) ? fromBaseUnits(v, dec as number) : null)
  return JSON.stringify({
    v: 1,
    type: 'near-intents-desk/proof-of-delivery',
    swap: row.id,
    from: { chain: row.from_chain, chainLabel: CHAINS[row.from_chain]?.label ?? row.from_chain, asset: row.from_asset, symbol: row.from_symbol,
      amountIn: row.amount_in, amountInFmt: fmt(row.amount_in, row.from_decimals) },
    to: { chain: row.to_chain, chainLabel: CHAINS[row.to_chain]?.label ?? row.to_chain, asset: row.to_asset, symbol: row.to_symbol,
      recipient: row.recipient, minAmountOut: row.min_amount_out, minAmountOutFmt: fmt(row.min_amount_out, row.to_decimals) },
    payout: { tx, receipt, explorer: tx && EXPLORER[row.to_chain] ? EXPLORER[row.to_chain] + tx : null },
    check,
    checkText: check === 'onchain' && row.to_chain === 'near' ? NEAR_TEXT : CHECK_TEXT[check],
  })
}

export async function signProof(secret: string, payload: string): Promise<{ payload: string; sig: string; kid: string; alg: 'Ed25519' }> {
  const k = await proofKeys(secret)
  return { payload, sig: b64u(await crypto.subtle.sign('Ed25519', k.priv, enc.encode(payload))), kid: k.kid, alg: 'Ed25519' }
}

/** True only for a payload this desk's key signed, byte for byte. */
export async function checkProof(secret: string, payload: unknown, sig: unknown): Promise<boolean> {
  if (typeof payload !== 'string' || payload.length > 4000 || typeof sig !== 'string') return false
  const s = unb64u(sig)
  if (!s || s.length !== 64) return false
  const k = await proofKeys(secret)
  try { return await crypto.subtle.verify('Ed25519', k.pub, s, enc.encode(payload)) } catch { return false }
}

export async function publicKey(secret: string): Promise<{ alg: 'Ed25519'; kid: string; x: string }> {
  const k = await proofKeys(secret)
  return { alg: 'Ed25519', kid: k.kid, x: k.x }
}
