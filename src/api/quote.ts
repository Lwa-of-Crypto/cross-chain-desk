// POST /api/quote — the cross-chain desk's quote + deposit-address issuer.
// Public: no account.
//
// Body: { from, to, amount, recipient, refundTo, slippageBps?, dry,
//         idempotencyKey?  (required when dry=false)
//         acceptedAmountOut? (required when dry=false: the amountOut the user saw and accepted) }
//
// dry=true  → price preview. Nothing stored. No deposit address.
// dry=false → a real deposit address, issued only if every check passes, and
//             recorded in the ledger BEFORE it is shown. A retry with the same
//             idempotencyKey returns the same swap — never a second address.
//             The answer carries `token`: the swap's access capability (identity.ts).
//
// Refusal order: config → kill switch → budgets → validation → NEAR account exists →
// idempotency → 1Click → echo check → independent price → risk limits → terms.
import { buildQuoteRequest, checkQuote, costBps, feeCfgFrom, fromBaseUnits, CHAINS } from '../lib/intents'
import { evaluate, mergeLimits, parseLimits, pausedReason, routeKey, reasonText, REASON_TEXT } from '../lib/intents-risk'
import { ensureTables, readControls, reserve, fillReservation, abandon, usage, logEvent, publicSwap, type SwapRow } from '../lib/intents-ledger'
import { json, enabled, getTokens, oneClick, independentPrices, nearAccountExists, nearKeys, addressOnChain, idemKey } from '../lib/intents-io'
import { swapToken } from '../identity'
import { evmAssetOf, EVM_RPC, nearTokenOf } from '../lib/intents-verify'
import { guard, readJson, spendAll, type Ctx, type Handler } from './common'

const MAX_BODY = 4096
const TERMS_TOLERANCE_BPS = 25n   // a real quote may be at most 0.25% worse than the one the user accepted

const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  json({ ok: false, error, message: REASON_TEXT[error] || undefined, ...extra }, status)

/** The swap a request key already made, with its access token (a lost answer, retried). */
async function replay(row: SwapRow, secret: string): Promise<Response> {
  // 1Click's raw signed quote is never sent (it carries dates), so an expired swap's hidden
  // deposit address cannot leak through it either (round 13, second pass).
  return json({ ok: true, replay: true, swap: publicSwap(row), token: await swapToken(secret, row.id) })
}

/**
 * A crash after a reservation abandons it on the way out (round 15). It used to stay
 * 'reserving' until the reconciler's 2-minute sweep, and every retry in between got
 * "conflict" with no word on whether the key was free. abandon() touches only a row still
 * in 'reserving', so a swap whose address was already issued is never undone.
 */
export const quote: Handler = async (ctx) => {
  const st: { db?: D1Database; reservedId?: string } = {}
  try { return await quoteInner(ctx, st) }
  catch (e) {
    if (st.db && st.reservedId) await abandon(st.db, st.reservedId, 'internal_error', Date.now()).catch(() => {})
    throw e
  }
}

async function quoteInner(ctx: Ctx, st: { db?: D1Database; reservedId?: string }): Promise<Response> {
  const { request, env } = ctx
  const g = await guard(ctx)
  if (!g.ok) return g.response
  const { owner, network, db, secret } = g
  st.db = db

  const rb = await readJson(request, MAX_BODY)
  if (!rb.ok) return refuse(rb.status, rb.error)
  const body: any = rb.value
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse(400, 'bad_body')
  const dry = body.dry !== false

  // Everything that costs nothing is checked BEFORE any budget is spent (red-team
  // round 13): `{"dry":false}` from ten addresses used to fill the desk-wide minute
  // budget with requests that failed validation one line later, locking every real
  // user out of deposit addresses without a single upstream call.
  // Strings only: String(["1"]) === "1" let an array through (red-team).
  for (const f of ['from', 'to', 'amount', 'recipient', 'refundTo'] as const)
    if (typeof body[f] !== 'string') return refuse(400, f === 'amount' ? 'bad_amount' : f === 'from' ? 'unsupported_from_asset' : f === 'to' ? 'unsupported_to_asset' : f === 'recipient' ? 'bad_recipient' : 'bad_refund_address', { field: f })
  const idem = String(body.idempotencyKey || '')
  const accepted = String(body.acceptedAmountOut || '')
  if (!dry) {
    if (!/^[A-Za-z0-9-]{16,64}$/.test(idem)) return refuse(400, 'bad_idempotency_key')
    if (!/^\d{1,60}$/.test(accepted) || accepted === '0') return refuse(400, 'accepted_terms_missing',
      { message: 'Preview the swap first, then accept that price.' })
  }

  const tk = await getTokens(env)     // 5-minute isolate cache
  if (!tk) return refuse(503, 'router_unavailable', { message: 'The 1Click router did not answer. Nothing was issued.' })

  const now = Date.now()
  const fee = feeCfgFrom(env)
  const built = await buildQuoteRequest({
    from: body.from, to: body.to, amount: body.amount,
    recipient: body.recipient, refundTo: body.refundTo,
    // number or a plain numeric string only: Number([100]) === 100 let an array through (red-team round 7)
    slippageBps: body.slippageBps === undefined ? undefined
      : (typeof body.slippageBps === 'number' || (typeof body.slippageBps === 'string' && /^\d{1,4}$/.test(body.slippageBps))) ? Number(body.slippageBps) : NaN, dry,
  }, tk.tokens, fee, now)
  if (!built.ok) return refuse(400, built.error, { field: built.field })
  // A payout the desk could never verify is never issued (round 22): an EVM asset whose kind the
  // verifier cannot tell, or a Solana token with no mint. Their swaps could only end in a
  // "verified" guess or a false alarm that pauses the route.
  if ((CHAINS[built.to.chain]?.family === 'evm' && !evmAssetOf(built.to.id, built.to.contract))
      || (built.to.chain === 'sol' && built.to.id !== 'nep141:sol.omft.near' && !built.to.contract)
      // NEAR (round 27): a NEP-141 whose contract the verifier reads from the id, and that the list agrees on
      || (built.to.chain === 'near' && (!nearTokenOf(built.to.id) || (!!built.to.contract && built.to.contract !== nearTokenOf(built.to.id)))))
    return refuse(400, 'unverifiable_destination', { field: 'to' })
  const { from, to } = built
  await ensureTables(db)

  // RETRY FIRST (round 13, second pass). A retry whose first answer was lost must get
  // its swap back before anything that could refuse it: a budget, a pause, an RPC blip.
  // It used to be refused there, the page read the refusal as "no swap", dropped the
  // key, and the next press minted a second swap while the first one's address was
  // already out. Costs one indexed read; no upstream call, no new address.
  // `keyFree`: whether the server KNOWS no live swap holds this key. Every refusal from
  // here on says so, and the page drops its key only on that word (desk.js issue()).
  let keyFree = false
  if (!dry) {
    const ex = await db.prepare('SELECT * FROM intents_swaps WHERE idem = ?').bind(await idemKey('desk', idem)).first<SwapRow>()
    if (ex && ex.state !== 'reserving' && ex.state !== 'abandoned' && ex.from_asset === from.id && ex.to_asset === to.id
        && ex.amount_in === String(built.body.amount) && ex.recipient === String(built.body.recipient) && ex.refund_to === String(built.body.refundTo))
      return replay(ex, secret)
    // NOT "no row": the first press may be between its own lookup and its reserve() (seconds
    // of RPC calls), and would still mint after this answer said "free" (round 15). Only a
    // dead reservation is free here; after OUR reserve() the answer is exact (below).
    keyFree = !!ex && ex.state === 'abandoned'
  }
  const no = (status: number, error: string, extra: Record<string, unknown> = {}) => refuse(status, error, keyFree ? { keyFree: true, ...extra } : extra)

  if (!enabled(env)) return no(503, 'paused_global', { message: REASON_TEXT.paused_global })

  // Budgets: this client, its network, then the whole desk (strict D1 counter).
  // Red-team rounds 3-4: per-client alone let 30 callers drive 1,200 previews into 1Click a minute.
  const rlOk = await spendAll(env, db, dry ? [['q', owner], ['qn', network], ['qa', '*']] : [['a', owner], ['an', network], ['aa', '*']])
  if (!rlOk) return no(429, 'rate_limited', { message: 'Too many requests. Wait a minute.' })

  const { controls, limits: dbLimits } = await readControls(db)
  const limits = mergeLimits(parseLimits(env.INTENTS_LIMITS), dbLimits)
  const paused = pausedReason(controls, { fromChain: from.chain, toChain: to.chain, fromAsset: from.id, toAsset: to.id })
  if (paused) return no(423, paused)

  // What the chains themselves say about the two addresses (red-team round 2).
  // A Solana token account / program is refused on previews too; if Solana's
  // nodes cannot be reached, a real deposit address is not issued (fail closed).
  const chainWarn: string[] = []
  for (const [chain, addr, field, hardCode, warnCode] of [
    [to.chain, built.body.recipient, 'recipient', 'recipient_is_token_account', 'recipient_is_contract'],
    [from.chain, built.body.refundTo, 'refundTo', 'refund_is_token_account', 'refund_is_contract'],
  ] as const) {
    const oc = await addressOnChain(chain, String(addr))
    if (oc === null) { if (!dry && chain === 'sol') return no(503, 'address_unchecked', { field, message: 'Could not check that Solana address on-chain right now. Try again shortly.' }); continue }
    if (oc.hard) return no(400,oc.hard === 'token_account' ? hardCode : field === 'recipient' ? 'recipient_unspendable' : 'refund_unspendable', { field })
    if (oc.warn) chainWarn.push(warnCode)
  }

  // Who can sign for the NEAR account the payout lands in (the key checker, nearKeys()).
  // On every preview, so the member matches the keys against their own wallet BEFORE accepting.
  // A warning, never a refusal: the desk cannot know which keys are the member's.
  let nearKeysTerms: Record<string, unknown> | undefined
  if (to.chain === 'near') {
    const account = String(built.body.recipient)
    const k = await nearKeys(account)
    nearKeysTerms = k ? { account, checked: true, ...k } : { account, checked: false }
    if (!k) chainWarn.push('near_keys_unchecked')
    else if (k.tooMany) chainWarn.push('near_keys_too_many')
    else if (k.locked) chainWarn.push('near_keys_locked')
    else if (k.full.length > 1) chainWarn.push('near_keys_several')
  }

  // Priced BEFORE anything is reserved, so the reservation can carry its USD
  // and the database can enforce the caps atomically (red-team).
  const px = await independentPrices(env, [from.cg, to.cg])
  const pIn = from.cg ? px[from.cg] ?? null : null
  const pOut = to.cg ? px[to.cg] ?? null : null
  const usdIn = pIn ? Number(fromBaseUnits(built.amountBase, from.decimals)) * pIn : null
  const route = routeKey(from.chain, to.chain)

  let reservedId: string | null = null
  if (!dry) {
    // A named NEAR account that does not exist cannot receive or be refunded.
    for (const [chain, addr, field] of [[to.chain, built.body.recipient, 'recipient'], [from.chain, built.body.refundTo, 'refundTo']] as const) {
      if (chain !== 'near') continue
      const ex = await nearAccountExists(String(addr))
      if (ex === false) return no(400, 'near_account_missing', { field, message: `NEAR account ${String(addr)} does not exist.` })
      if (ex === null) return no(503, 'near_account_unchecked', { field, message: 'Could not confirm the NEAR account exists. Try again shortly.' })
    }

    if (usdIn === null) return no(422, 'unpriced', { message: reasonText('unpriced', limits) })

    const id = crypto.randomUUID()
    const res = await reserve(db, {
      id, idem: await idemKey('desk', idem), member: owner, route,
      from_chain: from.chain, to_chain: to.chain, from_asset: from.id, to_asset: to.id,
      amount_in: String(built.body.amount), recipient: String(built.body.recipient), refund_to: String(built.body.refundTo),
      usd_in: usdIn, from_decimals: from.decimals, to_decimals: to.decimals, from_symbol: from.symbol, to_symbol: to.symbol, net: network,
    }, now, { memberOpenSwaps: limits.memberOpenSwaps, memberDailyUsd: limits.memberDailyUsd, routeDailyUsd: limits.routeDailyUsd, globalDailyUsd: limits.globalDailyUsd })
    if (res.kind === 'existing') return replay(res.row, secret)   // a same-key request landed between the lookup and here
    // A cap refusal means reserve() found NO row for this key: it is free.
    if (res.kind === 'cap') return res.reason === 'rate_limited'
      ? no(429, 'rate_limited', { message: 'Too many requests. Wait a minute.' })
      : no(422, res.reason, { message: reasonText(res.reason, limits) })
    // busy / conflict: something holds this key — except an ABANDONED reservation, which
    // holds nothing; saying so ends the page's "press again" loop (round 15).
    if (res.kind === 'busy') return refuse(409, 'in_progress', { message: 'This request is already being processed.' })
    if (res.kind === 'conflict') return refuse(409, 'idempotency_conflict', { message: 'That request key was already used for a different swap. Start a new preview.', ...(res.dead ? { keyFree: true } : {}) })
    reservedId = id
    st.reservedId = id
    keyFree = true      // every refusal from here goes through fail(), which abandons OUR reservation first
  }

  // Our own reservation is abandoned before the refusal goes out, so the key is free again.
  const fail = async (status: number, error: string, extra: Record<string, unknown> = {}) => {
    if (reservedId) await abandon(db, reservedId, error, Date.now())
    return no(status, error, extra)
  }

  let up = await oneClick(env, '/v0/quote', { method: 'POST', body: built.body })
  // Fast path asks for the first solver answer (quoteWaitingTimeMs 0 — the wait
  // bought 0.28 bps for 2.7 s). Backtest run 4 saw 1 of 65 quotes come back
  // "No liquidity available" that way and succeed on retry, so give that one
  // case a single retry with the solvers given 3 s to answer.
  if (up.status === 400 && /liquidity/i.test(String(up.body?.message || ''))) {
    up = await oneClick(env, '/v0/quote', { method: 'POST', body: { ...built.body, quoteWaitingTimeMs: 3000 } })
  }
  if (up.status !== 200 && up.status !== 201) {
    const msg = typeof up.body?.message === 'string' ? up.body.message.slice(0, 200) : null
    if (up.status === 400) return fail(400, 'router_rejected', { message: msg ? 'The router refused this swap: ' + msg : 'The router refused this swap.' })
    return fail(502, 'router_unavailable', { message: 'The 1Click router did not answer. Nothing was issued.' })
  }
  const chk = await checkQuote(built.body as any, from, to, up.body, fee, tk.tokens)
  if (!chk.ok) {
    await logEvent(db, reservedId, 'quote', 'upstream_check_failed', { error: chk.error, correlationId: up.body?.correlationId ?? null })
    return fail(502, 'router_answer_rejected', { detail: chk.error, message: 'The router’s answer did not match the request, so it was discarded.' })
  }
  const q = chk.q

  const cost = costBps(q.amountIn, from, pIn, q.amountOut, to, pOut)
  const u = await usage(db, owner, route, now, reservedId || '')
  const decision = evaluate(limits, controls, u, { fromChain: from.chain, toChain: to.chain, fromAsset: from.id, toAsset: to.id, usdIn, costBps: cost, dry })
  decision.warn.push(...chainWarn)
  // Said BEFORE the member pays (round 25: it was only said after the swap had settled).
  if (!EVM_RPC[to.chain] && to.chain !== 'sol' && to.chain !== 'btc' && to.chain !== 'near') decision.warn.push('payout_unchecked')

  const terms = {
    from: { id: from.id, chain: from.chain, chainLabel: CHAINS[from.chain].label, symbol: from.symbol, decimals: from.decimals },
    to: { id: to.id, chain: to.chain, chainLabel: CHAINS[to.chain].label, symbol: to.symbol, decimals: to.decimals },
    amountIn: q.amountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut,
    amountInFmt: fromBaseUnits(q.amountIn, from.decimals), amountOutFmt: fromBaseUnits(q.amountOut, to.decimals),
    minAmountOutFmt: fromBaseUnits(q.minAmountOut, to.decimals),
    slippageBps: built.body.slippageTolerance, timeEstimateSec: q.timeEstimate,
    fees: { platformBps: q.platformFeeBps, oursBps: q.ourFeeBps },
    price: {
      source: pIn && pOut ? 'market' : 'none',     // CoinGecko, or DeFiLlama when CoinGecko is down — never the router
      usdIn, costBps: cost,
      routerUsdIn: q.amountInUsd, routerUsdOut: q.amountOutUsd,   // 1Click's own numbers, labelled as such
    },
    risk: { allow: decision.allow, hard: decision.hard, warn: decision.warn, text: [...decision.hard, ...decision.warn].map(r => reasonText(r, limits)) },
    ...(nearKeysTerms ? { nearKeys: nearKeysTerms } : {}),
    limits: { minTradeUsd: limits.minTradeUsd, minTradeUsdUtxoDest: limits.minTradeUsdUtxoDest, maxTradeUsd: limits.maxTradeUsd, memberDailyUsd: limits.memberDailyUsd, memberUsed24hUsd: Math.round(u.member24hUsd * 100) / 100 },
  }

  if (dry) return json({ ok: true, dry: true, terms })

  if (!decision.allow) {
    await logEvent(db, reservedId, 'risk', 'refused', { hard: decision.hard, usdIn, cost })
    return fail(422, decision.hard[0], { terms, reasons: decision.hard, message: reasonText(decision.hard[0], limits) })
  }
  // The deal the member accepted must still be the deal: a worse real quote needs a fresh "yes".
  if (BigInt(q.amountOut) * 10000n < BigInt(String(body.acceptedAmountOut)) * (10000n - TERMS_TOLERANCE_BPS)) {
    return fail(409, 'terms_changed', { terms, message: 'The price moved since your preview. Check the new numbers and accept again.' })
  }

  // A pause that landed while we were talking to 1Click still wins.
  const late = pausedReason((await readControls(db)).controls, { fromChain: from.chain, toChain: to.chain, fromAsset: from.id, toAsset: to.id })
  if (late) return fail(423, late)

  // The address is offered until OUR deadline (the one we asked 1Click for), not
  // 1Click's: it answered a 1 h request with 3 days (measured). An unpaid
  // address holds its client's open-swap slot until then, so 3 days let one user
  // lock themselves out for days. A deposit after our deadline is still found and
  // processed: expiry is ours, and a late deposit reopens the swap (ledger nextState).
  const ours = String(built.body.deadline)
  const deadline = q.deadline && Date.parse(q.deadline) < Date.parse(ours) ? q.deadline : ours

  let filled = false
  try {
    filled = await fillReservation(db, reservedId!, {
      amount_out: q.amountOut, min_amount_out: q.minAmountOut, usd_in: usdIn, cost_bps: cost,
      platform_fee_bps: q.platformFeeBps, our_fee_bps: q.ourFeeBps, deposit_address: q.depositAddress,
      deadline, signature: q.signature, correlation_id: q.correlationId,
      upstream_deadline_ms: q.deadline && Number.isFinite(Date.parse(q.deadline)) ? Date.parse(q.deadline) : null,
      // 'native' (round 23): an empty value could not be told from a row older than the column,
      // and those read the LIVE token list at verification time.
      to_contract: to.contract ?? 'native',
      // Same rule for the deposit token: a connected wallet pays exactly this (publicSwap `pay`).
      from_contract: from.contract ?? 'native',
      quote_json: JSON.stringify(up.body).slice(0, 20000),
    }, Date.now())
  } catch (e) {
    // UNIQUE(deposit_address): the router handed out an address that already
    // belongs to another swap. Two swaps sharing one address would credit one
    // member's deposit to the other — never shown (red-team round 2: it crashed).
    // ONLY that error (round 15): a passing D1 failure used to be logged as this
    // critical, counting toward the 3-a-day desk pause; anything else goes to the
    // outer handler, which abandons a still-reserving row and answers "unknown".
    if (!/UNIQUE/i.test(String((e as Error)?.message))) throw e
    await logEvent(db, reservedId, 'quote', 'critical', ['deposit_address_reused'])
    await abandon(db, reservedId!, 'deposit_address_reused', Date.now())
    return refuse(502, 'router_answer_rejected', { detail: 'deposit_address_reused', message: 'The router’s answer did not match the request, so it was discarded.' })
  }
  const row = await db.prepare('SELECT * FROM intents_swaps WHERE id = ?').bind(reservedId).first<any>()
  // The address is only ever shown if the ledger holds it (OGOU: a
  // reservation reaped mid-request used to return the raw receipt anyway).
  if (!filled || !row || row.state !== 'awaiting_deposit' || row.deposit_address !== q.depositAddress) {
    await logEvent(db, reservedId, 'quote', 'critical', ['ledger_fill_lost'])
    return refuse(503, 'ledger_write_failed', { message: 'We could not record this swap, so no deposit address is shown. Nothing was sent — start again.' })
  }
  await logEvent(db, reservedId, 'client', 'issued', { route, usdIn, cost, depositAddress: q.depositAddress, correlationId: q.correlationId })
  // 1Click's raw answer is not sent on: it carries dates (its timestamp and deadlines), and every
  // number the member needs from it is already in `swap`. The ledger keeps it (quote_json).
  return json({ ok: true, terms, swap: publicSwap(row), token: await swapToken(secret, row.id) })
}
