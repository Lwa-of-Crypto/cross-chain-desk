/**
 * lib/intents-risk.ts — the risk engine for the cross-chain swap desk.
 *
 * Pure: every decision is a function of (limits, controls,
 * usage, this trade). The quote endpoint gathers the inputs; this file decides.
 *
 * What it enforces, in order (first hard failure wins, all reasons reported):
 *   1. kill switches — global, per route (fromChain>toChain), per chain, per asset
 *   2. allowlist     — both chains in lib/intents.ts CHAINS (checked upstream too)
 *   3. sizing        — a trade that cannot be priced in USD is not sized, so it is
 *                      refused for a real deposit address (a dry preview still shows)
 *   4. per-trade     — min / max USD
 *   5. exposure      — per member 24 h, per route 24 h, all routes 24 h, and how
 *                      many unfinished swaps one member may hold open at once
 *   6. price         — cost vs an INDEPENDENT mid price (lib/intents.ts costVerdict)
 *
 * CryptoLwa never holds the funds — the member's wallet sends, 1Click settles —
 * so these caps protect members and the desk's reputation, not a treasury.
 * Launch caps are deliberately low (Stan's brief: "launch with low
 * caps and a narrow route list; increase limits only after reconciliation and
 * incident procedures work reliably").
 */
import { CHAINS, COST } from './intents'

export interface Limits {
  minTradeUsd: number
  minTradeUsdUtxoDest: number     // payouts to BTC / LTC / DOGE carry a fixed network fee
  maxTradeUsd: number
  memberDailyUsd: number
  routeDailyUsd: number
  globalDailyUsd: number
  memberOpenSwaps: number
  costWarnBps: number
  costBlockBps: number
}

export const LAUNCH_LIMITS: Readonly<Limits> = {
  minTradeUsd: 5,
  // Measured (the live quote backtest, final
  // run 4): USDC→BTC cost 1,559 bps at $10 and 172 bps at $100 vs 22-35 bps at
  // $1k+. The payout network fee is roughly fixed, so small BTC payouts are mostly fee.
  minTradeUsdUtxoDest: 50,
  maxTradeUsd: 2_500,
  memberDailyUsd: 10_000,
  routeDailyUsd: 50_000,
  globalDailyUsd: 150_000,
  memberOpenSwaps: 5,
  costWarnBps: COST.warn,
  costBlockBps: COST.block,
}

// Hard ceilings an override can never raise past (a typo of an extra zero in
// the admin panel must not open the desk to $25M trades).
const CEILING: Readonly<Limits> = {
  minTradeUsd: 1_000, minTradeUsdUtxoDest: 1_000, maxTradeUsd: 250_000, memberDailyUsd: 1_000_000, routeDailyUsd: 5_000_000,
  globalDailyUsd: 10_000_000, memberOpenSwaps: 50, costWarnBps: 1_000, costBlockBps: 2_000,
}

/** LAUNCH_LIMITS overlaid with an override object; anything invalid is ignored. */
export function mergeLimits(...overrides: unknown[]): Limits {
  const out: Limits = { ...LAUNCH_LIMITS }
  for (const o of overrides) {
    if (!o || typeof o !== 'object') continue
    for (const k of Object.keys(LAUNCH_LIMITS) as (keyof Limits)[]) {
      const v = Number((o as any)[k])
      if ((o as any)[k] === undefined || !Number.isFinite(v) || v < 0 || v > CEILING[k]) continue
      out[k] = k === 'memberOpenSwaps' ? Math.floor(v) : v
    }
  }
  if (out.minTradeUsd > out.maxTradeUsd) out.minTradeUsd = LAUNCH_LIMITS.minTradeUsd
  if (out.costWarnBps > out.costBlockBps) out.costWarnBps = out.costBlockBps
  return out
}

export function parseLimits(raw: string | undefined | null): unknown {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export interface Controls {
  globalPaused: string | null                 // reason, or null
  routes: Record<string, string>              // "base>sol" → reason
  chains: Record<string, string>              // "btc" → reason
  assets: Record<string, string>              // assetId → reason
}
export const NO_CONTROLS: Controls = { globalPaused: null, routes: {}, chains: {}, assets: {} }

export interface Usage { member24hUsd: number; route24hUsd: number; global24hUsd: number; memberOpen: number }

export interface Trade {
  fromChain: string; toChain: string; fromAsset: string; toAsset: string
  usdIn: number | null                        // independent price × amount; null = unpriced
  costBps: number | null
  dry: boolean
}

export interface Decision {
  allow: boolean                              // may a deposit address be issued / a preview shown
  hard: string[]                              // reasons that refuse
  warn: string[]                              // shown to the member, do not refuse
}

export const routeKey = (fromChain: string, toChain: string) => fromChain + '>' + toChain
const UTXO = new Set<string | undefined>(['btc', 'ltc', 'doge'])

/** Is this route stopped? Used by quote AND by the desk's token list. */
export function pausedReason(c: Controls, t: Pick<Trade, 'fromChain' | 'toChain' | 'fromAsset' | 'toAsset'>): string | null {
  if (c.globalPaused) return 'paused_global'
  if (c.routes[routeKey(t.fromChain, t.toChain)]) return 'paused_route'
  if (c.chains[t.fromChain] || c.chains[t.toChain]) return 'paused_chain'
  if (c.assets[t.fromAsset] || c.assets[t.toAsset]) return 'paused_asset'
  return null
}

export function evaluate(limits: Limits, controls: Controls, usage: Usage, t: Trade): Decision {
  const hard: string[] = [], warn: string[] = []

  const paused = pausedReason(controls, t)
  if (paused) hard.push(paused)
  if (!CHAINS[t.fromChain] || !CHAINS[t.toChain]) hard.push('route_not_allowed')

  // `allow` always answers "could a real deposit address be issued?", for a
  // preview too — a dry quote still returns its numbers, but the member sees
  // the refusal before they commit. Both sides must be independently priced:
  // OGOU audit found a missing DESTINATION price slipped through
  // (usdIn needs only the origin price; costBps needs both).
  if (t.usdIn === null || t.costBps === null) hard.push('unpriced')
  if (t.usdIn !== null) {
    if (t.usdIn < limits.minTradeUsd) hard.push('below_min_trade')
    else if (UTXO.has(CHAINS[t.toChain]?.family) && t.usdIn < limits.minTradeUsdUtxoDest) hard.push('below_min_trade_utxo')
    if (t.usdIn > limits.maxTradeUsd) hard.push('above_max_trade')
    if (usage.member24hUsd + t.usdIn > limits.memberDailyUsd) hard.push('member_daily_cap')
    if (usage.route24hUsd + t.usdIn > limits.routeDailyUsd) hard.push('route_daily_cap')
    if (usage.global24hUsd + t.usdIn > limits.globalDailyUsd) hard.push('global_daily_cap')
  }
  if (usage.memberOpen >= limits.memberOpenSwaps) hard.push('too_many_open_swaps')

  // Too GOOD is as wrong as too bad: a quote paying far above the market is a
  // broken or baiting router, not a bargain (red-team: 1,000× was shown).
  const v = t.costBps === null ? 'unpriced'
    : (t.costBps > limits.costBlockBps || t.costBps < -limits.costBlockBps) ? 'block'
    : t.costBps > limits.costWarnBps ? 'warn' : 'ok'
  if (v === 'block') hard.push('price_deviation')
  else if (v === 'warn') warn.push('high_cost')
  return { allow: hard.length === 0, hard, warn }
}

/** REASON_TEXT with the live limits filled in. */
export function reasonText(code: string, limits: Limits): string {
  return (REASON_TEXT[code] || code).replace('{utxoMin}', '$' + limits.minTradeUsdUtxoDest)
}

/** Plain-English text for every reason code (the desk and the admin view both use it). */
export const REASON_TEXT: Readonly<Record<string, string>> = {
  paused_global: 'Cross-chain swaps are paused while we check something. Swaps already in flight are still tracked.',
  paused_route: 'This route is paused while we check something. Swaps already in flight are still tracked.',
  paused_chain: 'One of these chains is paused while we check something.',
  paused_asset: 'One of these assets is paused while we check something.',
  route_not_allowed: 'This route is not supported.',
  unpriced: 'We could not find an independent price for one of these assets, so we will not issue a deposit address for it.',
  below_min_trade: 'This trade is below the minimum size.',
  // {utxoMin} is filled from the live limit (reasonText) so an admin override never leaves stale text.
  below_min_trade_utxo: 'Payouts on Bitcoin, Litecoin and Dogecoin carry a fixed network fee, so we need at least {utxoMin} here. We measured $10 swaps into BTC losing about 16% to that fee.',
  above_max_trade: 'This trade is above the per-swap limit.',
  member_daily_cap: 'This would take you over your 24-hour limit.',
  route_daily_cap: 'This route has reached its 24-hour limit.',
  global_daily_cap: 'The desk has reached its 24-hour limit.',
  too_many_open_swaps: 'You have too many swaps waiting for a deposit. Finish or let one expire first.',
  network_daily_cap: 'Your network has requested too many deposit addresses today. Try again tomorrow, or from another connection.',
  member_daily_swaps: 'You have requested too many deposit addresses today. Try again tomorrow.',
  unverifiable_destination: 'This desk cannot yet check payouts of that token on-chain, so it does not offer it as a destination.',
  payout_unchecked: 'Payouts on this chain are not checked on-chain by this desk yet: "delivered" will be 1Click’s report, not something the desk verified.',
  price_deviation: 'The router’s price is too far from the market price (in either direction). We will not hand out a deposit address at this price.',
  high_cost: 'This route costs more than usual against the market price. Check the numbers before you send.',
  // request validation (lib/intents.ts buildQuoteRequest)
  bad_recipient: 'That receiving address is not valid on the destination chain. Check every character.',
  bad_refund_address: 'That refund address is not valid on the chain you are sending from. Refunds go back to the sending chain.',
  recipient_is_token_contract: 'That is a token contract, not a wallet. Funds sent there are usually lost. Use your own wallet address.',
  refund_is_token_contract: 'That refund address is a token contract, not a wallet. Use your own wallet address.',
  recipient_is_token_account: 'That is a Solana TOKEN ACCOUNT, not a wallet. A payout sent there gets stuck. Paste your wallet address (the one your wallet app shows you).',
  refund_is_token_account: 'That refund address is a Solana token account, not a wallet. Paste your wallet address.',
  recipient_is_contract: 'The receiving address is a smart contract. That is fine for a smart wallet (like a Safe) — but if it is an app or token contract, the payout may be lost. Double-check it.',
  refund_is_contract: 'The refund address is a smart contract. Make sure it is a wallet you control.',
  near_keys_several: 'The receiving NEAR account has more than one full-access key (listed above). Whoever holds any of them controls the account and anything paid to it. Send only if every one is yours: a key you do not recognise is how phishing takes over NEAR accounts.',
  near_keys_locked: 'The receiving NEAR account has no access keys: only its smart contract can move what lands there. Send only if that is what you intend.',
  near_keys_too_many: 'The receiving NEAR account has more than 100 access keys, so this desk cannot list who controls it. Check its keys in your wallet before you send.',
  near_keys_unchecked: 'Could not check who controls the receiving NEAR account right now. Check its keys in your wallet before you send.',
  address_unchecked: 'Could not check that address on-chain right now. Try again shortly.',
  recipient_unspendable: 'That is a burn or system address — nobody can spend from it, so anything sent there is lost. Use your own wallet address.',
  refund_unspendable: 'That refund address is a burn or system address. Use your own wallet address.',
  bad_amount: 'Enter an amount greater than zero, with no more decimals than the token has.',
  same_asset: 'Pick two different assets.',
  unsupported_from_asset: 'That asset is not supported on this desk.',
  unsupported_to_asset: 'That asset is not supported on this desk.',
  bad_slippage: 'Slippage must be between 0.1% and 3%.',
}
