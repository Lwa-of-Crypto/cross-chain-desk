/**
 * lib/intents-verify.ts — did the payout really land? Checked on the
 * destination chain itself, not taken from 1Click's word.
 *
 * 1Click's SUCCESS moves a swap to `delivered_claimed`; only
 * this file can move it to `settled`. Each chain adapter is narrow: it reads
 * ONE transaction from a public node and answers one question.
 *
 *   verified     the tx succeeded and paid the recipient ≥ minAmountOut
 *   confirmed    internal only: a native payout made by a contract call, not visible in
 *                tx.value. The recipient's balance across the block then decides, and
 *                the result is always 'verified' or 'pending'; 'confirmed' never settles.
 *   short        the tx paid the recipient LESS than minAmountOut
 *   failed       the tx reverted / errored
 *   pending      not found or not confirmed yet (retry next pass)
 *   unverifiable no adapter for this chain (Tron, DOGE, LTC; NEAR is checked since round 27)
 *
 * Every node used was probed (chain id / health answered).
 * Node answers are untrusted input: parsed defensively, never eval'd, and any
 * shape we do not recognise reads as `pending`, never as success.
 */

export type Verdict = 'verified' | 'confirmed' | 'short' | 'failed' | 'stale' | 'unproven' | 'pending' | 'unverifiable'

export const EVM_RPC: Readonly<Record<string, string>> = {
  eth: 'https://ethereum-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  arb: 'https://arbitrum-one-rpc.publicnode.com',
  op: 'https://optimism-rpc.publicnode.com',
  bsc: 'https://bsc-rpc.publicnode.com',
  pol: 'https://polygon-bor-rpc.publicnode.com',
  avax: 'https://avalanche-c-chain-rpc.publicnode.com',
  gnosis: 'https://gnosis-rpc.publicnode.com',
}
/**
 * Where native balances are read (round 26). publicnode keeps only ~127 blocks of state on these
 * chains (about 32 s on Arbitrum), so a payout the reconciler first sees a minute later could never
 * be proven. Measured: the dRPC free endpoints answered balances 100,000 blocks back on
 * Ethereum, Optimism, Polygon and Gnosis; Arbitrum's own RPC keeps 5,000–10,000 blocks (≥ 20 min).
 * publicnode's BSC, Base and Avalanche nodes kept ≥ 10,000 blocks, so they stay as they are. The
 * payout block is named by its HASH (EIP-1898, accepted by every node here, same date), so a node on
 * another fork cannot answer for a different block.
 */
export const STATE_RPC: Readonly<Record<string, string>> = {
  eth: 'https://eth.drpc.org',
  op: 'https://optimism.drpc.org',
  pol: 'https://polygon.drpc.org',
  gnosis: 'https://gnosis.drpc.org',
  arb: 'https://arb1.arbitrum.io/rpc',
}
export const SOL_RPC = 'https://solana-rpc.publicnode.com'
/**
 * Blocks a payout must be buried under before it counts (round 24). A settled swap is never
 * re-checked, so a payout a reorg later drops must not settle one. Chosen conservatively per
 * chain's reorg history; not measured here.
 */
export const CONFIRMATIONS: Record<string, number> = { eth: 12, base: 30, arb: 30, op: 30, bsc: 15, pol: 64, avax: 3, gnosis: 12, btc: 2 }
export const BTC_API = 'https://mempool.space/api'

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * What a payout of this asset looks like on its EVM chain.
 *   nep141:base-0xabc….omft.near → ERC-20 (the contract is in the id)
 *   nep141:base.omft.near        → native
 * Round 22: BSC, Polygon, Optimism and Avalanche assets come as nep245:…omni.hot.tg / omdep /
 * 1cs_v1 ids (measured in the token list). For those the contract FROZEN AT ISSUE
 * decides: a 0x… address → that ERC-20; none, on a native form (…_11111111111111111111 or
 * <chain>.omdep.near) → native. Anything else is null: never settled on a guess.
 */
export function evmAssetOf(assetId: string, contract: string | null = null): { kind: 'erc20'; contract: string } | { kind: 'native' } | null {
  const m = /^nep141:([a-z]+)-(0x[0-9a-f]{40})\.omft\.near$/.exec(assetId)
  if (m) return { kind: 'erc20', contract: m[2] }
  if (/^nep141:[a-z]+\.omft\.near$/.test(assetId)) return { kind: 'native' }
  if (contract && /^0x[0-9a-fA-F]{40}$/.test(contract)) return { kind: 'erc20', contract: contract.toLowerCase() }
  if (!contract && (/^nep245:v2_1\.omni\.hot\.tg:\d+_1{20}$/.test(assetId) || /^nep141:[a-z]+\.omdep\.near$/.test(assetId))) return { kind: 'native' }
  return null
}

const lc = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '')
const big = (s: unknown): bigint | null => {
  try { return typeof s === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(s) ? BigInt(s) : null } catch { return null }
}

/** What a judge measured as paid by one tx, when it can be summed with others (split payouts). */
export type Paid = { paid: bigint | null }

/** Pure: an EVM receipt (+ its tx) → verdict. */
export function judgeEvm(receipt: any, tx: any, assetId: string, recipient: string, minOut: bigint, contract: string | null = null, out?: Paid): Verdict {
  if (!receipt || typeof receipt !== 'object') return 'pending'
  if (receipt.status === '0x0') return 'failed'
  if (receipt.status !== '0x1') return 'pending'
  const asset = evmAssetOf(assetId, contract)
  const rcpt = lc(recipient)
  // A tx the recipient sent itself proves nothing (round 25: for ERC-20 only the Transfer's own
  // sender was looked at, so the recipient's own DEX buy — pool → recipient — 'proved' a payout).
  if (tx && lc(tx.from) === rcpt) return 'pending'
  if (asset?.kind === 'erc20') {
    let paid = 0n, touched = false
    for (const l of Array.isArray(receipt.logs) ? receipt.logs : []) {
      if (lc(l?.address) !== asset.contract || !Array.isArray(l?.topics) || lc(l.topics[0]) !== TRANSFER) continue
      // Byte-exact ABI (red-team round 8): an `address` topic is 12 zero bytes + 20
      // address bytes, and an ERC-20 Transfer's data is exactly one 32-byte word.
      // Dirty high bits or a longer data blob are not a standard Transfer to us.
      if (lc(l.topics[2]) !== '0x' + '0'.repeat(24) + rcpt.slice(2)) continue
      // …and not FROM the recipient (round 24: a self-transfer 'proved' a payout).
      if (lc(l.topics[1]) === '0x' + '0'.repeat(24) + rcpt.slice(2)) continue
      if (typeof l.data !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(l.data)) continue
      const v = big(l.data)
      if (v === null) continue
      touched = true; paid += v
    }
    if (!touched) return 'pending'
    if (out) out.paid = paid
    return paid >= minOut ? 'verified' : 'short'
  }
  if (asset?.kind === 'native') {
    if (tx && lc(tx.to) === rcpt) {
      const v = big(tx.value)
      if (v !== null) { if (out) out.paid = v; return v >= minOut ? 'verified' : 'short' }
    }
    // Succeeded, but a contract-routed native payout is not visible in tx.value:
    // verifyDestination then checks the recipient's balance across that block.
    return 'confirmed'
  }
  // Unrecognised asset: never proven (round 22). Any token's Transfer to the recipient used to
  // count, so a junk-token airdrop could 'prove' a payout. Such a swap stays unverified until a
  // human looks (dest_unverified pauses its route); the desk no longer issues them (quote.ts).
  return 'pending'
}

/**
 * Pure: native balance before/after the payout block → verdict.
 * Round 23: 'confirmed' settles a swap, so it now needs the recipient's balance to have RISEN in
 * that block. Unreadable balances or no rise used to be 'confirmed' too, so any successful tx the
 * feed named — someone else's — 'proved' a native payout. Those are now 'pending' (unproven).
 */
export function judgeNativeDelta(before: bigint | null, after: bigint | null, minOut: bigint): Verdict {
  if (before === null || after === null) return 'pending'
  const d = after - before
  if (d <= 0n) return 'pending'
  // Round 24: only a rise of at least the guaranteed amount proves the payout. Any smaller rise used
  // to be 'confirmed' — which settles — so 1 wei from anyone in that block 'proved' a native payout,
  // and a real under-delivery could never read as one. A partial rise stays unproven (not 'short':
  // the recipient's own spending in the same block can hide part of a full payout).
  return d >= minOut ? 'verified' : 'pending'
}

/**
 * Pure: a Solana getTransaction(jsonParsed) result → verdict. `mint` is the SPL
 * mint from 1Click's token list (contractAddress); with it the payout amount is
 * proven, without it only "the recipient was touched" is.
 */
export function judgeSol(res: any, assetId: string, recipient: string, minOut: bigint, mint: string | null = null, out?: Paid): Verdict {
  if (!res || typeof res !== 'object' || !res.meta) return 'pending'
  if (res.meta.err) return 'failed'
  const raw: any[] = Array.isArray(res.transaction?.message?.accountKeys) ? res.transaction.message.accountKeys : []
  const keys: string[] = raw.map((k: any) => (typeof k === 'string' ? k : k?.pubkey))
  // A tx the recipient signed proves nothing (round 25: its own sale for SOL, or its own buy of the
  // mint, 'proved' a payout). A payout never needs the recipient's signature. jsonParsed marks
  // signers; a key list without the marks cannot rule it out, so it is unproven.
  if (raw.some((k: any) => typeof k === 'string')) return 'pending'
  if (raw.some((k: any) => k?.pubkey === recipient && k?.signer !== false)) return 'pending'
  if (assetId === 'nep141:sol.omft.near') {
    const i = keys.indexOf(recipient)
    if (i < 0) return 'pending'
    const pre = big(String(res.meta.preBalances?.[i])), post = big(String(res.meta.postBalances?.[i]))
    if (pre === null || post === null) return 'pending'     // unreadable is unproven (round 24; it settled)
    // No rise is not a payout at all (round 25: it read as 'short' and paused the route).
    if (post - pre <= 0n) return 'pending'
    if (out) out.paid = post - pre
    return post - pre >= minOut ? 'verified' : 'short'
  }
  const owned = (arr: any) => (Array.isArray(arr) ? arr : []).filter((b: any) => b?.owner === recipient)
  const post = owned(res.meta.postTokenBalances)
  if (!post.length && keys.indexOf(recipient) < 0) return 'pending'
  if (!mint) return 'pending'     // an SPL token with no mint to check: never settled on 'the recipient was touched' (round 22)
  const sum = (arr: any[]): bigint => arr.filter(b => b?.mint === mint)
    .reduce((s: bigint, b) => s + (big(String(b?.uiTokenAmount?.amount ?? '')) ?? 0n), 0n)
  const delta = sum(post) - sum(owned(res.meta.preTokenBalances))
  if (delta <= 0n) return 'pending'
  if (out) out.paid = delta
  return delta >= minOut ? 'verified' : 'short'
}

/**
 * Pure: a mempool.space /tx/{txid} body → verdict. `tip`: the latest block height; the payout
 * must be CONFIRMATIONS.btc deep (round 25: one block was enough, and a settled swap is never
 * re-checked). No tip read → unproven.
 */
export function judgeBtc(tx: any, recipient: string, minOut: bigint, tip: number | null = null, out?: Paid): Verdict {
  if (!tx || typeof tx !== 'object' || !Array.isArray(tx.vout)) return 'pending'
  if (!tx.status?.confirmed) return 'pending'
  const height = tx.status?.block_height
  if (tip === null || !Number.isSafeInteger(height) || tip - height + 1 < CONFIRMATIONS.btc) return 'pending'
  let paid = 0n
  // bech32 compares case-insensitively; base58 (1…/3…) must match exactly.
  const same = (a: unknown) => typeof a === 'string' && (/^(bc1|ltc1)/i.test(recipient) ? a.toLowerCase() === recipient.toLowerCase() : a === recipient)
  // A tx the recipient itself funded pays it nothing new — its outputs to the recipient are its own
  // change (round 24: a reused address's change 'proved' a payout).
  if ((Array.isArray(tx.vin) ? tx.vin : []).some((i: any) => same(i?.prevout?.scriptpubkey_address))) return 'pending'
  for (const o of tx.vout) if (same(o?.scriptpubkey_address) && Number.isSafeInteger(o?.value)) paid += BigInt(o.value)
  if (paid === 0n) return 'pending'
  if (out) out.paid = paid
  return paid >= minOut ? 'verified' : 'short'
}

// ───────────────────────────────────────────────────────────────── NEAR ──
// Round 27. Read from real 1Click-style payouts (fixtures/near-payout-*.json):
//   tokens: intents.near → ft_transfer on the token contract; that receipt logs
//           EVENT_JSON nep141 ft_transfer {old_owner_id: intents.near, new_owner_id, amount}
//   wNEAR:  intents.near unwraps via wrap.near and sends a native Transfer receipt to the recipient
// Both carry a dip4 ft_withdraw / native_withdraw event naming whose intents balance paid
// (account_id) and the receiver. The tx is signed by intents.near; the RPC's sender_account_id
// only routes the lookup (a wrong one returned the same tx, measured).
export const NEAR_RPC = 'https://free.rpc.fastnear.com'
const INTENTS = 'intents.near'

/** The NEP-141 contract of a NEAR-chain asset: nep141:X or 1cs_v1:near:nep141:X. */
export function nearTokenOf(assetId: string): string | null {
  const m = /^(?:1cs_v1:near:)?nep141:([a-z0-9][a-z0-9._-]{1,63})$/.exec(assetId)
  return m ? m[1] : null
}

const okStatus = (st: any) => !!st && typeof st === 'object' && ('SuccessValue' in st || 'SuccessReceiptId' in st)
const nearEvents = (logs: unknown): any[] => (Array.isArray(logs) ? logs : []).map(l => {
  if (typeof l !== 'string' || !l.startsWith('EVENT_JSON:')) return null
  try { return JSON.parse(l.slice(11)) } catch { return null }
}).filter(Boolean)
const list = (a: unknown): any[] => (Array.isArray(a) ? a : [])

/** One payout receipt to the recipient: `key` is tx#receipt (a NEAR tx can pay several swaps). */
export type NearPart = { key: string; paid: bigint }

/**
 * Pure: an EXPERIMENTAL_tx_status result → verdict. `out.parts` gets every successful payout
 * receipt to the recipient from intents.near. A solver batches many intents into one tx, so the
 * receipt — not the tx — is what one swap may settle on.
 */
export function judgeNear(res: any, hash: string, assetId: string, recipient: string, minOut: bigint, contract: string | null = null,
                          out?: { parts: NearPart[] }): Verdict {
  if (!res || typeof res !== 'object' || !res.transaction || res.transaction.hash !== hash) return 'pending'
  if (res.final_execution_status !== 'FINAL') return 'pending'     // every receipt executed and final
  const token = nearTokenOf(assetId)
  if (!token || (contract && contract !== token)) return 'pending'
  const outcomes = list(res.receipts_outcome)
  const receipts = new Map(list(res.receipts).map((r: any) => [r?.receipt_id, r]))
  // Round 28: every payout receipt is paired ONE-TO-ONE with a dip4 withdraw event to the recipient of
  // the same token and amount. A batch can hold other withdrawals to the same wallet — another swap's,
  // or the recipient withdrawing its OWN intents balance — so the tx as a whole proves nothing: a
  // receipt counts only if its own event shows the money came from an account that is not the
  // recipient. A receipt whose (token, amount) also matches one of the recipient's own withdrawals is
  // ambiguous and does not count.
  const DIG = /^\d{1,40}$/
  const events: { own: boolean; native: boolean; token: string | null; amount: string; used: boolean }[] = []
  for (const o of outcomes) {
    if (o?.outcome?.executor_id !== INTENTS) continue
    for (const e of nearEvents(o.outcome.logs)) {
      if (e?.standard !== 'dip4' || (e.event !== 'ft_withdraw' && e.event !== 'native_withdraw')) continue
      for (const d of list(e.data)) {
        if (d?.receiver_id !== recipient || typeof d?.amount !== 'string' || !DIG.test(d.amount)) continue
        events.push({ own: d.account_id === recipient || typeof d.account_id !== 'string', native: e.event === 'native_withdraw',
          token: e.event === 'ft_withdraw' && typeof d.token === 'string' ? d.token : null, amount: d.amount.replace(/^0+(?=\d)/, ''), used: false })
      }
    }
  }
  /** The unused withdraw event this receipt answers, or null (none, or ambiguous with the recipient's own). */
  const claim = (native: boolean, amount: string) => {
    const fits = (ev: (typeof events)[number]) => !ev.used && ev.native === native && (native || ev.token === token) && ev.amount === amount
    if (events.some(ev => ev.own && fits(ev))) return null
    const ev = events.find(x => !x.own && fits(x))
    if (ev) ev.used = true
    return ev || null
  }
  const parts: NearPart[] = []
  let failed = false
  for (const o of outcomes) {
    const r: any = receipts.get(o?.id)
    if (!r || r.predecessor_id !== INTENTS || typeof o.id !== 'string') continue
    const st = o.outcome?.status, ex = o.outcome?.executor_id
    const acts = r.receipt?.Action?.actions
    if (!Array.isArray(acts) || !acts.length) continue
    if (ex === token && r.receiver_id === token) {
      // One plain ft_transfer (not ft_transfer_call, whose amount can be refunded later), optionally
      // after a storage_deposit for a recipient new to the token (round 29: intents.near's
      // do_ft_withdraw chains them onto ONE promise — near/intents contracts/defuse/src/contract/
      // tokens/nep141/withdraw.rs, read — so that payout is a two-action receipt).
      const fc = acts[acts.length - 1]?.FunctionCall
      if (!fc || fc.method_name !== 'ft_transfer' || acts.length > 2
          || (acts.length === 2 && acts[0]?.FunctionCall?.method_name !== 'storage_deposit')) continue
      let args: any = null
      try { args = JSON.parse(atob(String(fc.args || ''))) } catch { args = null }
      if (!args || args.receiver_id !== recipient || typeof args.amount !== 'string' || !DIG.test(args.amount)) continue
      const amount = args.amount.replace(/^0+(?=\d)/, '')
      if (!(st && typeof st === 'object' && 'SuccessValue' in st)) {
        // a failed transfer that answers one of OUR withdrawals is a failed payout (alarm)
        if (st && typeof st === 'object' && 'Failure' in st && claim(false, amount)) failed = true
        continue
      }
      // …and the token's own event says the same thing
      const logged = nearEvents(o.outcome.logs).some(e => e?.standard === 'nep141' && e.event === 'ft_transfer'
        && list(e.data).some((d: any) => d?.old_owner_id === INTENTS && d?.new_owner_id === recipient && d?.amount === args.amount))
      if (!logged || BigInt(amount) === 0n || !claim(false, amount)) continue
      parts.push({ key: hash + '#' + o.id, paid: BigInt(amount) })
    } else if (token === 'wrap.near' && ex === recipient && r.receiver_id === recipient) {
      // wNEAR paid out as native NEAR: a receipt of exactly one Transfer
      const d = acts.length === 1 ? acts[0]?.Transfer?.deposit : null
      if (typeof d !== 'string' || !DIG.test(d)) continue
      const amount = d.replace(/^0+(?=\d)/, '')
      if (!okStatus(st)) { if (st && typeof st === 'object' && 'Failure' in st && claim(true, amount)) failed = true; continue }
      if (BigInt(amount) === 0n || !claim(true, amount)) continue
      parts.push({ key: hash + '#' + o.id, paid: BigInt(amount) })
    }
  }
  if (out) out.parts = parts
  // One receipt pays one swap: parts are never added up (round 28: summing other swaps' receipts in a
  // batch settled a swap that was paid 60 of 100).
  if (parts.some(p => p.paid >= minOut)) return 'verified'
  if (parts.length) return 'short'
  return failed ? 'failed' : 'pending'
}

type Fetch = typeof fetch
const RANKED: Verdict[] = ['verified', 'confirmed', 'short', 'failed', 'stale', 'unproven', 'pending', 'unverifiable']

/** Several calls in ONE request (one subrequest). Each answer by id; a missing or failed one is undefined. */
async function rpcBatch(f: Fetch, url: string, calls: [string, unknown][]): Promise<any[]> {
  const r = await f(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: i + 1, method, params }))),
    signal: AbortSignal.timeout(8000),
  })
  if (!r.ok) return calls.map(() => undefined)
  const j: any = await r.json().catch(() => undefined)
  const byId = new Map((Array.isArray(j) ? j : []).filter((x: any) => x && typeof x === 'object' && 'result' in x).map((x: any) => [x.id, x.result]))
  return calls.map((_, i) => byId.get(i + 1))
}

async function rpc(f: Fetch, url: string, method: string, params: unknown): Promise<any> {
  const r = await f(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  })
  if (!r.ok) return undefined
  const j: any = await r.json().catch(() => undefined)
  return j && 'result' in j ? j.result : undefined
}

/**
 * Check every destination tx 1Click named; the best verdict across them wins,
 * and the hash that earned it is returned so the ledger can make sure ONE
 * payout settles ONE swap.
 *
 * `notBefore` (unix seconds): a payout mined before the swap existed is an old
 * transfer being passed off as this one — verdict 'stale', never success.
 * Red-team: a 30-day-old payment to the same wallet "verified" a new
 * swap, and one payout tx settled two swaps. When the block time cannot be read
 * the payout is not accepted ('pending'), so the swap waits rather than guesses.
 */
export async function verifyDestinationDetailed(f: Fetch, toChain: string, toAsset: string, recipient: string,
    minOut: bigint, txs: { hash: string }[], toContract: string | null = null, notBefore = 0,
    proofs: string[] = []): Promise<{ verdict: Verdict; hash: string | null; proofs: string[]; alts?: string[] }> {
  // Each hash once (round 25: split payouts are summed, and a repeated hash would count twice).
  const seen = new Set<string>()
  const hashes = (Array.isArray(txs) ? txs : []).map(t => t?.hash).filter((h): h is string => typeof h === 'string')
    .filter(h => { const k = /^(0x)?[0-9a-fA-F]+$/.test(h) ? h.toLowerCase() : h; if (seen.has(k)) return false; seen.add(k); return true })
    .slice(0, toChain === 'near' ? 5 : 3)     // NEAR: 2 calls a tx (see NEAR_PAYOUT_TXS in intents-io)
  const proved = proofs.filter(p => typeof p === 'string').slice(0, 3)
  const evm = EVM_RPC[toChain]
  if (!evm && toChain !== 'sol' && toChain !== 'btc' && toChain !== 'near') return { verdict: 'unverifiable', hash: null, proofs: proved }
  if (!hashes.length) return { verdict: 'pending', hash: null, proofs: proved }
  const fresh = (ts: unknown, v: Verdict): Verdict => {
    if (v !== 'verified' && v !== 'confirmed' && v !== 'short' && v !== 'unproven') return v     // round 31: unproven too
    if (!notBefore) return v
    const n = Number(ts)
    if (!Number.isFinite(n) || n <= 0) return 'pending'
    // Clock tolerance per chain (red-team round 8): a Bitcoin block's timestamp only
    // has to beat the median of the previous 11 blocks, so it can trail real time by
    // well over an hour; account chains keep tight clocks. A legit BTC payout must
    // never read as "older than the swap" and falsely pause the route.
    return n + (toChain === 'btc' ? 7200 : 120) < notBefore ? 'stale' : v
  }
  const got: { verdict: Verdict; hash: string; paid: bigint | null; alts?: string[]; nearParts?: NearPart[] }[] = []
  let head: bigint | null | undefined     // latest block, read once per verification
  let tip: number | null | undefined      // Bitcoin's, likewise
  const isHex = (s: unknown) => /^0x[0-9a-fA-F]+$/.test(String(s))
  for (const h of hashes) {
    const out: Paid = { paid: null }
    try {
      if (evm) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(h)) { got.push({ verdict: 'pending', hash: h, paid: null }); continue }
        let receipt = await rpc(f, evm, 'eth_getTransactionReceipt', [h])
        // The receipt must be the one asked for (round 24: a misrouted or lying node's other receipt counted).
        if (receipt && lc(receipt.transactionHash) !== lc(h)) receipt = null
        const okBlock = isHex(receipt?.blockNumber)
        const blockHash = typeof receipt?.blockHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) ? lc(receipt.blockHash) : null
        const kind = evmAssetOf(toAsset, toContract)?.kind
        let tx = kind && receipt?.status === '0x1' ? await rpc(f, evm, 'eth_getTransactionByHash', [h]) : null
        // …and so must the tx, in the same block (round 25: the tx object decides a native payout,
        // and a node's answer for another tx — to the recipient, with value — counted unchecked).
        if (tx && (lc(tx.hash) !== lc(h) || !isHex(tx.blockNumber) || !okBlock || BigInt(tx.blockNumber) !== BigInt(receipt.blockNumber))) tx = null
        // Without the tx its sender cannot be checked (round 25): unproven.
        let v: Verdict = kind && receipt?.status === '0x1' && !tx ? 'pending' : judgeEvm(receipt, tx, toAsset, recipient, minOut, toContract, out)
        if (v === 'confirmed' && kind === 'native') {
          // The tx succeeded but did not pay the recipient directly (tx.to is someone else).
          // Round 33 (round 19 review): a balance RISE in that block proves that money arrived, not that
          // THIS payout did — another payout or any inflow in the same block satisfied it, and one swap
          // settled on another's money. So a rise never settles a swap:
          //  · omft natives (nep141:<chain>.omft.near): 1Click's bridge pays these as DIRECT transfers
          //    (measured on 7 real payouts: hot wallet → recipient, value = amount, no
          //    calldata). A tx that does not pay the recipient directly is not a payout: 'pending', the
          //    alarm path. No balance is read.
          //  · other native forms (HOT bridge: BSC, Polygon, Avalanche, Optimism — not measured): the
          //    rise is read only to tell the operator what happened. A covering rise, or a recipient
          //    that could have hidden one (code at that block, or its nonce moved), is 'unproven' —
          //    never settled, flagged for a human, no route pause. A plain, idle wallet with no rise is
          //    'pending' (the alarm): it cannot hide a payout.
          // ONE batched request reads both balances, the code and the nonces (round 31; batch support
          // measured on every node used). Free nodes keep only ~127 blocks of state on some chains, so
          // STATE_RPC nodes are used (round 26).
          // (round 34: exactly the chains measured — Gnosis xDAI too: 2 real payouts, same hot wallet, direct)
          if (/^nep141:(eth|base|arb|gnosis)\.omft\.near$/.test(toAsset) || !okBlock || !blockHash) v = 'pending'
          else {
            const bn = BigInt(receipt.blockNumber), node = STATE_RPC[toChain] ?? evm
            const prev = '0x' + (bn - 1n).toString(16)
            const [b0, b1, code, n0, n1] = await rpcBatch(f, node, [['eth_getBalance', [recipient, prev]],
              ['eth_getBalance', [recipient, { blockHash }]], ['eth_getCode', [recipient, { blockHash }]],
              ['eth_getTransactionCount', [recipient, prev]], ['eth_getTransactionCount', [recipient, { blockHash }]]])
            const before = big(b0), after = big(b1)
            const covered = judgeNativeDelta(before, after, minOut) === 'verified'
            const couldHide = (typeof code === 'string' && /^0x[0-9a-fA-F]+$/.test(code) && code.length > 2)
              || (big(n0) !== null && big(n1) !== null && big(n0) !== big(n1))
            v = before !== null && after !== null && (covered || couldHide) ? 'unproven' : 'pending'
          }
        }
        // Buried deep enough not to be reorganised away (round 24: a settled swap is never re-checked).
        if (v === 'verified' || v === 'confirmed' || v === 'short') {
          if (!okBlock) v = 'pending'
          else {
            if (head === undefined) { const hb = await rpc(f, evm, 'eth_blockNumber', []).catch(() => null); head = typeof hb === 'string' && isHex(hb) ? BigInt(hb) : null }
            if (head === null || head - BigInt(receipt.blockNumber) < BigInt(CONFIRMATIONS[toChain] ?? 12)) v = 'pending'
          }
        }
        let ts: unknown = null
        if (notBefore && okBlock && (v === 'verified' || v === 'confirmed' || v === 'short' || v === 'unproven')) {
          const blk = await rpc(f, evm, 'eth_getBlockByNumber', [receipt.blockNumber, false])
          ts = typeof blk?.timestamp === 'string' && isHex(blk.timestamp) ? parseInt(blk.timestamp, 16) : null
        }
        got.push({ verdict: fresh(ts, v), hash: h.toLowerCase(), paid: out.paid })
      } else if (toChain === 'sol') {
        if (!/^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(h)) { got.push({ verdict: 'pending', hash: h, paid: null }); continue }
        const res = await rpc(f, SOL_RPC, 'getTransaction', [h, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }])
        got.push({ verdict: fresh(res?.blockTime, judgeSol(res, toAsset, recipient, minOut, toContract, out)), hash: h, paid: out.paid })
      } else if (toChain === 'near') {
        if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(h)) { got.push({ verdict: 'pending', hash: h, paid: null }); continue }
        const res = await rpc(f, NEAR_RPC, 'EXPERIMENTAL_tx_status', { tx_hash: h, sender_account_id: INTENTS, wait_until: 'FINAL' })
        const nout = { parts: [] as NearPart[] }
        const v = judgeNear(res, h, toAsset, recipient, minOut, toContract, nout)
        let ts: unknown = null
        if (notBefore && (v === 'verified' || v === 'short')) {
          const bh = res?.transaction_outcome?.block_hash
          const blk = typeof bh === 'string' ? await rpc(f, NEAR_RPC, 'block', { block_id: bh }) : null
          const ns = blk?.header?.hash === bh ? blk?.header?.timestamp_nanosec : null
          ts = typeof ns === 'string' && /^\d{1,25}$/.test(ns) ? Number(BigInt(ns) / 1_000_000_000n) : null
        }
        // The receipts that cover the guarantee; which one settles is chosen across all txs below.
        got.push({ verdict: fresh(ts, v), hash: h, paid: null, nearParts: nout.parts.filter(p => p.paid >= minOut) })
      } else {
        if (!/^[0-9a-fA-F]{64}$/.test(h)) { got.push({ verdict: 'pending', hash: h, paid: null }); continue }
        const r = await f(`${BTC_API}/tx/${h}`, { signal: AbortSignal.timeout(8000) })
        const body: any = r.ok ? await r.json().catch(() => null) : null
        if (tip === undefined && body?.status?.confirmed) {
          const tr = await f(`${BTC_API}/blocks/tip/height`, { signal: AbortSignal.timeout(8000) }).catch(() => null)
          const t = tr && tr.ok ? Number((await tr.text().catch(() => '')).trim()) : NaN
          tip = Number.isSafeInteger(t) && t > 0 ? t : null
        }
        got.push({ verdict: fresh(body?.status?.block_time, judgeBtc(body, recipient, minOut, tip ?? null, out)), hash: h.toLowerCase(), paid: out.paid })
      }
    } catch {
      got.push({ verdict: 'pending', hash: h, paid: null })     // a node that is down tells us nothing
    }
  }
  const best = got.slice().sort((a, b) => RANKED.indexOf(a.verdict) - RANKED.indexOf(b.verdict))[0]
  // NEAR (round 29): the candidates are the covering receipts of EVERY verified tx, smallest first —
  // only the first verified tx's were offered, so a swap whose free receipt sat in a later tx was refused.
  // Smallest first: another swap paid in the same batch may take one, and this swap then settles on
  // the next (refreshSwap); taking the smallest that covers never leaves another swap without one.
  // Up to 20 (round 28: only 3 were, so the 4th desk swap paid in one batch could never settle).
  if (toChain === 'near' && best?.verdict === 'verified') {
    const seenK = new Set<string>()
    const all = got.filter(g => g.verdict === 'verified').flatMap(g => g.nearParts || [])
      .filter(p => (seenK.has(p.key) ? false : (seenK.add(p.key), true)))
      .sort((a, b) => (a.paid < b.paid ? -1 : a.paid > b.paid ? 1 : 0)).map(p => p.key).slice(0, 20)
    if (all.length) return { verdict: 'verified', hash: all[0], proofs: proved, alts: all.slice(1) }
  }
  // Split payouts (round 25): each tx was judged alone, so a payout 1Click made in two parts read
  // as 'short' and paused the route. Parts that each passed every check (fresh, deep, not from the
  // recipient, owned by this swap) and whose amounts are exact are summed. The largest part is the
  // one recorded as settling it; the others are this swap's already (payout ownership).
  if (best?.verdict === 'short') {
    const parts = got.filter(g => g.verdict === 'short' && g.paid !== null)
    const total = parts.reduce((s, g) => s + (g.paid as bigint), 0n)
    if (parts.length > 1 && total >= minOut) {
      const top = parts.slice().sort((a, b) => ((b.paid as bigint) > (a.paid as bigint) ? 1 : -1))[0]
      return { verdict: 'verified', hash: top.hash, proofs: proved }
    }
    // A part that cannot be judged YET (not deep enough, or a node read that failed) may be the rest
    // of the payout (round 26: one shallow part made the other read 'short', which pauses the route at
    // once). Wait instead; a payout that stays unproven still raises dest_unverified after the grace.
    if (got.some(g => g.verdict === 'pending')) return { verdict: 'pending', hash: null, proofs: proved }
  }
  const none = best && (best.verdict === 'pending' || best.verdict === 'unproven')
  return best ? { verdict: best.verdict, hash: none ? null : best.hash, proofs: proved, alts: none ? [] : best.alts ?? [] }
    : { verdict: 'pending', hash: null, proofs: proved }
}

/** Verdict only (kept for callers that do not need the hash). */
export async function verifyDestination(f: Fetch, toChain: string, toAsset: string, recipient: string,
    minOut: bigint, txs: { hash: string }[], toContract: string | null = null, notBefore = 0): Promise<Verdict> {
  return (await verifyDestinationDetailed(f, toChain, toAsset, recipient, minOut, txs, toContract, notBefore)).verdict
}
