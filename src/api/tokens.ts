// GET /api/tokens — what the desk can swap right now. Public.
// Tokens come from 1Click /v0/tokens filtered to the v1 chain allowlist
// (lib/intents.ts CHAINS); pauses and limits come from the ledger.
import { CHAINS, SLIPPAGE, feeCfgFrom } from '../lib/intents'
import { mergeLimits, parseLimits } from '../lib/intents-risk'
import { ensureTables, readControls } from '../lib/intents-ledger'
import { json, enabled, getTokens } from '../lib/intents-io'
import { deskSecret } from '../identity'
import type { Handler } from './common'

export const tokens: Handler = async ({ env }) => {
  const tk = await getTokens(env)
  if (!tk) return json({ ok: false, error: 'router_unavailable', message: 'The 1Click router did not answer.' }, 503)

  let controls = null, limits = mergeLimits(parseLimits(env.INTENTS_LIMITS))
  if (env.DESK_DB) {
    await ensureTables(env.DESK_DB)
    const c = await readControls(env.DESK_DB)
    controls = c.controls
    limits = mergeLimits(parseLimits(env.INTENTS_LIMITS), c.limits)
  }
  const pausedChains = controls ? Object.keys(controls.chains) : []
  const pausedAssets = controls ? Object.keys(controls.assets) : []
  return json({
    ok: true,
    // Live only when everything a real swap needs is present: a misconfigured
    // deploy shows PAUSED instead of failing at the last step.
    enabled: enabled(env) && !!env.DESK_DB && !!deskSecret(env) && !controls?.globalPaused,
    stale: tk.stale,
    chains: Object.entries(CHAINS).map(([id, c]) => ({ id, label: c.label, paused: pausedChains.includes(id) })),
    tokens: tk.tokens.map(t => ({ id: t.id, chain: t.chain, symbol: t.symbol, decimals: t.decimals, paused: pausedAssets.includes(t.id) })),
    pausedRoutes: controls ? Object.keys(controls.routes) : [],
    slippage: SLIPPAGE,
    limits: { minTradeUsd: limits.minTradeUsd, minTradeUsdUtxoDest: limits.minTradeUsdUtxoDest, maxTradeUsd: limits.maxTradeUsd, memberDailyUsd: limits.memberDailyUsd },
    fees: { ourBps: feeCfgFrom(env).feeBps, partnerKey: !!env.INTENTS_API_KEY },
  }, 200, { 'cache-control': 'public, max-age=30' })
}
