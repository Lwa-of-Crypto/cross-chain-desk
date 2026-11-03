/**
 * identity.ts — who is asking, on a desk with no accounts.
 *
 * Two different questions, answered separately:
 *
 *  1. WHICH BUDGET does this request spend?  → clientBucket()
 *     The caller's IP as Cloudflare saw it (CF-Connecting-IP, set at the edge).
 *     NOT VERIFIED: Cloudflare's header reference does not say a client-sent
 *     CF-Connecting-IP is overwritten on the request a Worker receives.
 *     Check after the first deploy (README "After deploying"). If a
 *     client could choose its own, per-client and per-network budgets would be
 *     bypassable. The desk-wide budgets would still cap what reaches 1Click, but only
 *     per Cloudflare location (rate-limiting bindings count per location); the money
 *     caps in the ledger are global and unaffected. IPv6 is bucketed by
 *     its /64, because one home or phone line gets a whole /64 and could
 *     otherwise rotate through 2^64 budgets. The IP is never stored: only an
 *     HMAC of it under DESK_SECRET, so the ledger holds no IP addresses.
 *
 *  2. WHO MAY SEE OR TOUCH A SWAP?  → swapToken() / tokenOk()
 *     A capability: HMAC(DESK_SECRET, swap id), handed back once when the
 *     swap is issued (and again on an idempotent replay, which proves the
 *     caller holds the request key). Not stored, so a database leak does not
 *     leak access. Sent in a header, never in a URL (URLs end up in logs).
 *
 * DESK_SECRET is required (≥ 32 characters). Without it the API refuses to
 * run rather than fall back to something guessable.
 */
import { cleanEnv } from './lib/intents-io'

const enc = new TextEncoder()

export function deskSecret(env: { DESK_SECRET?: string }): string | null {
  const s = cleanEnv(env.DESK_SECRET)
  return s.length >= 32 ? s : null
}

// The imported key is reused for as long as the secret is the same (round 13, CPU): a
// "my swaps" call checks up to 20 tokens plus two buckets, and importing the key for each
// was most of its CPU on a plan that allows 10 ms. Non-extractable; one entry per secret.
let keyCache: { secret: string; key: Promise<CryptoKey> } | null = null
async function hmacHex(secret: string, msg: string): Promise<string> {
  if (!keyCache || keyCache.secret !== secret)
    keyCache = { secret, key: crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) }
  const sig = await crypto.subtle.sign('HMAC', await keyCache.key, enc.encode(msg))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Expand an IPv6 address and keep its first 64 bits; anything else is returned as-is (lower-cased). */
export function ipPrefix(ip: string): string {
  const s = ip.trim().toLowerCase()
  if (!s.includes(':')) return s
  const bare = s.split('%')[0]
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) is really that IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare)
  if (mapped) return mapped[1]
  const [head, tail] = bare.includes('::') ? bare.split('::') : [bare, null]
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = tail === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
  return groups.slice(0, 4).map(g => (g || '0').padStart(4, '0')).join(':') + '::/64'
}

/** The budget key for this request: 'c:' + 32 hex of HMAC(secret, ip prefix). */
export async function clientBucket(request: Request, secret: string): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown'
  return 'c:' + (await hmacHex(secret, 'ip|' + ipPrefix(ip))).slice(0, 32)
}

/**
 * The NETWORK a client sits in: IPv6 /48, IPv4 /24 (red-team round 13). One tunnel
 * account hands out a routed /48 = 65,536 /64 "clients", so per-client budgets alone
 * meant nothing against IPv6. A network budget (a few times the client one) bounds
 * what one allocation can spend; a /24 is shared by few enough homes that the
 * multiple leaves room for neighbours.
 */
export function networkPrefix(ip: string): string {
  const p = ipPrefix(ip)
  if (p.endsWith('::/64')) return p.split(':').slice(0, 3).join(':') + '::/48'
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(p)
  return v4 ? v4[1] + '.0/24' : p
}
export async function networkBucket(request: Request, secret: string): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown'
  return 'n:' + (await hmacHex(secret, 'net|' + networkPrefix(ip))).slice(0, 32)
}

/** The access token for one swap. */
export function swapToken(secret: string, id: string): Promise<string> {
  return hmacHex(secret, 'swap|' + id)
}

/** Constant-time check of a presented token against the one for `id`. */
export async function tokenOk(secret: string, id: string, presented: string | null): Promise<boolean> {
  if (!presented || !/^[0-9a-f]{64}$/.test(presented)) return false
  const want = await swapToken(secret, id)
  let d = 0
  for (let i = 0; i < 64; i++) d |= want.charCodeAt(i) ^ presented.charCodeAt(i)
  return d === 0
}

/** Constant-time string equality (admin token). */
export function ctEq(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let d = a.length ^ b.length
  for (let i = 0; i < len; i++) d |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0)
  return d === 0
}
