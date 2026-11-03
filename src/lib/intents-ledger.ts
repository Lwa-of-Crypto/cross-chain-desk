/**
 * lib/intents-ledger.ts — the swap ledger, its state machine and reconciliation.
 *
 * One row per deposit address the desk ever handed out, in
 * D1 (DESK_DB, tables created on first use). `member` is the hashed client
 * bucket (src/identity.ts): the desk has no accounts.
 * Every state change and every operator action is appended to intents_events.
 *
 * STATE MACHINE. 1Click's status is a CLAIM from an outside party, so it moves
 * our state forward only. "Submitted" is never "settled":
 *
 *   awaiting_deposit ─► deposit_seen ─► processing ─► delivered_claimed ─► settled
 *         │                  │  ▲              │                              (independently
 *         │                  ▼  │              ├──► refunded                   verified on the
 *         │          incomplete_deposit        └──► failed                     destination chain)
 *         └──► expired  (deadline passed, nothing seen — but a LATE deposit
 *                        reopens it, because the money is real even if late)
 *
 *   - A status that would move BACKWARDS is ignored and flagged (status_regressed).
 *   - settled / refunded / failed are final. A different claim afterwards is
 *     flagged, never applied.
 *   - delivered_claimed becomes settled only when lib/intents-verify.ts finds
 *     the payout on the destination chain. If it cannot be found within the
 *     grace period the swap is flagged dest_unverified.
 *
 * Pure parts (nextState, reconcileFlags) are exported for the Node suites in test/.
 */
import type { Controls } from './intents-risk'
import { CHAINS } from './intents'
import { evmAssetOf } from './intents-verify'

export type State =
  | 'reserving' | 'awaiting_deposit' | 'deposit_seen' | 'incomplete_deposit' | 'processing'
  | 'delivered_claimed' | 'settled' | 'refunded' | 'failed' | 'expired' | 'abandoned'

const RANK: Record<State, number> = {
  reserving: -1, abandoned: -1,
  awaiting_deposit: 0, expired: 0,
  deposit_seen: 1, incomplete_deposit: 1,
  processing: 2,
  delivered_claimed: 3,
  settled: 4, refunded: 4, failed: 4,
}
export const FINAL: ReadonlySet<State> = new Set(['settled', 'refunded', 'failed', 'abandoned'])
export const OPEN: ReadonlySet<State> = new Set(['awaiting_deposit', 'deposit_seen', 'incomplete_deposit', 'processing', 'delivered_claimed'])

const FROM_UPSTREAM: Record<string, State> = {
  PENDING_DEPOSIT: 'awaiting_deposit',
  KNOWN_DEPOSIT_TX: 'deposit_seen',
  INCOMPLETE_DEPOSIT: 'incomplete_deposit',
  PROCESSING: 'processing',
  SUCCESS: 'delivered_claimed',
  REFUNDED: 'refunded',
  FAILED: 'failed',
}

export interface Transition { state: State; changed: boolean; anomaly: string | null }

/**
 * Where does a swap go when 1Click reports `upstream` at time `now`?
 * `deadlineMs` is the quote deadline (deposit address inactive after it).
 */
export function nextState(cur: State, upstream: string | null, now: number, deadlineMs: number | null): Transition {
  const same = (anomaly: string | null = null): Transition => ({ state: cur, changed: false, anomaly })
  if (cur === 'reserving' || cur === 'abandoned') return same()
  const target = upstream ? FROM_UPSTREAM[upstream] : undefined
  if (upstream && !target) return same('unknown_upstream_status')

  if (FINAL.has(cur)) {
    // A final swap that is reported differently is a discrepancy, not an update.
    if (!target) return same()
    const consistent = target === cur || (cur === 'settled' && target === 'delivered_claimed')
    return same(consistent ? null : 'final_state_contradicted')
  }

  if (target) {
    // Expiry is ours, not theirs: a deposit seen after it is still real money.
    if (cur === 'expired') return target === 'awaiting_deposit' ? same() : { state: target, changed: true, anomaly: 'late_deposit' }
    if (target === cur) return same()
    if (RANK[target] < RANK[cur]) return same('status_regressed')
    return { state: target, changed: true, anomaly: null }
  }

  // No upstream answer: only the clock can move us (awaiting → expired).
  if (cur === 'awaiting_deposit' && deadlineMs !== null && now > deadlineMs) return { state: 'expired', changed: true, anomaly: null }
  return same()
}

export interface SwapRow {
  id: string; idem: string; member: string
  created_at: number; updated_at: number; verify_attempts: number
  route: string; from_chain: string; to_chain: string; from_asset: string; to_asset: string
  amount_in: string; amount_out: string; min_amount_out: string
  usd_in: number | null; cost_bps: number | null; platform_fee_bps: number; our_fee_bps: number
  recipient: string; refund_to: string; deposit_address: string | null
  deadline: string | null; signature: string | null; correlation_id: string | null
  state: State; upstream_status: string | null
  deposited: string | null; amount_out_actual: string | null; refunded: string | null; refund_reason: string | null
  origin_txs: string | null; dest_txs: string | null
  dest_verified: string | null; flags: string | null; quote_json: string | null
  settled_tx: string | null           // the payout tx that settled this swap — UNIQUE: one payout, one swap
  // Frozen at issue time (red-team round 4): what the member was told to send must never
  // depend on a token list that can later change decimals, drop the token, or be poisoned.
  from_decimals: number | null; to_decimals: number | null; from_symbol: string | null; to_symbol: string | null
  // Red-team round 13. updated_at moves on every poll (it is the poll lease), so it
  // cannot say how long a swap has sat in its state: "stuck" never fired and final
  // swaps never left the reconciler queue. state_at moves only when the state does.
  state_at?: number | null
  net?: string | null                 // the client's NETWORK bucket (hashed, like member): per-network daily address cap
  upstream_deadline_ms?: number | null   // 1Click's own deadline for the address (it may be days after ours)
  to_contract?: string | null            // destination token contract / SPL mint, frozen at issue (payout verification)
  from_contract?: string | null          // the deposit token's contract or 'native', frozen at issue (wallet payment)
  deadline_ms?: number | null         // the deposit deadline as a number, so SQL can tell a dead address from an open one
  dest_proof?: string | null          // JSON ["txhash@blockhash"]: native payouts whose balance rise was proven (round 25)
}

// Critical = pauses the route. refund_missing / stuck / no_dest_tx are for a
// human to look at: 1Click's real REFUNDED payload has not been observed yet,
// so an unproven trigger must not take the desk down.
export const CRITICAL_FLAGS: ReadonlySet<string> = new Set([
  'under_delivered', 'dest_unverified', 'dest_tx_failed', 'status_regressed', 'final_state_contradicted',
  // red-team
  'payout_predates_swap', 'payout_tx_reused', 'status_recipient_mismatch',
])

const STUCK_MS: Record<string, number> = { btc: 6 * 3600e3, ltc: 6 * 3600e3, doge: 6 * 3600e3 }
const STUCK_DEFAULT_MS = 60 * 60e3
export const VERIFY_GRACE_ATTEMPTS = 12      // ~12 reconcile passes before "can't find the payout" is an alarm
// …AND this long in delivered_claimed (round 25): 12 passes is ~12 minutes, and a Bitcoin payout
// needs CONFIRMATIONS.btc blocks (one alone often takes longer), so a real payout paused its route.
const VERIFY_GRACE_MS: Record<string, number> = { btc: 3 * 3600e3 }
const VERIFY_GRACE_DEFAULT_MS = 20 * 60e3

/**
 * Discrepancies for one swap. Critical ones pause its route (see reconcile).
 * `amount_out_actual` / `refunded` are base units as 1Click reports them.
 */
export function reconcileFlags(row: Pick<SwapRow, 'state' | 'from_chain' | 'updated_at' | 'state_at' | 'min_amount_out' | 'amount_out_actual' | 'refunded' | 'dest_txs' | 'dest_verified' | 'verify_attempts'> & { to_chain?: string },
                               now: number, anomaly: string | null): string[] {
  const f: string[] = []
  if (anomaly && anomaly !== 'late_deposit') f.push(anomaly)
  if (row.state === 'delivered_claimed' || row.state === 'settled') {
    if (row.amount_out_actual && /^\d+$/.test(row.amount_out_actual) && BigInt(row.amount_out_actual) < BigInt(row.min_amount_out || '0')) f.push('under_delivered')
    if (row.dest_verified === 'short') f.push('under_delivered')
    if (row.dest_verified === 'stale') f.push('payout_predates_swap')
    let dest: unknown[] = []
    try { dest = JSON.parse(row.dest_txs || '[]') } catch { /* counted as none */ }
    if (!Array.isArray(dest) || dest.length === 0) f.push('no_dest_tx')
    if (row.dest_verified === 'failed') f.push('dest_tx_failed')
    // Still only "claimed" after the grace period — on any chain, including the
    // ones we cannot check (a NEAR "SUCCESS" with no payout tx must escalate too).
    if (row.state === 'delivered_claimed' && row.verify_attempts >= VERIFY_GRACE_ATTEMPTS
        && now - (row.state_at ?? row.updated_at) > (VERIFY_GRACE_MS[row.to_chain ?? ''] ?? VERIFY_GRACE_DEFAULT_MS))
      // Round 30: a native payout that succeeded but whose amount the recipient's own code can hide
      // ('unproven') is for a human, not a route pause — the recipient could trigger it at will.
      f.push(row.dest_verified === 'unproven' ? 'dest_unproven' : 'dest_unverified')
  }
  if (row.state === 'refunded' && (!row.refunded || /^0+$/.test(row.refunded))) f.push('refund_missing')
  if (row.state === 'processing' || row.state === 'deposit_seen') {
    const lim = STUCK_MS[row.from_chain] ?? STUCK_DEFAULT_MS
    // Time IN this state (state_at), not since the last poll (updated_at): every poll
    // moves updated_at, so measured from it a swap could never look stuck (round 13).
    if (now - (row.state_at ?? row.updated_at) > lim) f.push('stuck')
  }
  return Array.from(new Set(f))
}

// ───────────────────────────────────────────────────────────── storage ──
export interface LedgerEnv { DESK_DB?: D1Database }

let ready = false
export async function ensureTables(db: D1Database): Promise<void> {
  if (ready) return
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS intents_swaps (
      id TEXT PRIMARY KEY, idem TEXT NOT NULL UNIQUE, member TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, verify_attempts INTEGER NOT NULL DEFAULT 0,
      route TEXT NOT NULL, from_chain TEXT NOT NULL, to_chain TEXT NOT NULL, from_asset TEXT NOT NULL, to_asset TEXT NOT NULL,
      amount_in TEXT NOT NULL, amount_out TEXT NOT NULL DEFAULT '0', min_amount_out TEXT NOT NULL DEFAULT '0',
      usd_in REAL, cost_bps INTEGER, platform_fee_bps INTEGER NOT NULL DEFAULT 0, our_fee_bps INTEGER NOT NULL DEFAULT 0,
      recipient TEXT NOT NULL, refund_to TEXT NOT NULL, deposit_address TEXT UNIQUE,
      deadline TEXT, signature TEXT, correlation_id TEXT,
      state TEXT NOT NULL, upstream_status TEXT,
      deposited TEXT, amount_out_actual TEXT, refunded TEXT, refund_reason TEXT,
      origin_txs TEXT, dest_txs TEXT, dest_verified TEXT, flags TEXT, quote_json TEXT, settled_tx TEXT UNIQUE,
      from_decimals INTEGER, to_decimals INTEGER, from_symbol TEXT, to_symbol TEXT,
      state_at INTEGER, deadline_ms INTEGER, net TEXT, upstream_deadline_ms INTEGER, to_contract TEXT, dest_proof TEXT, from_contract TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS intents_swaps_member ON intents_swaps(member, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS intents_swaps_state ON intents_swaps(state, updated_at)`),
    // Round 15: every "last 24 h / older than N days" filter not scoped to one client read
    // EVERY row in its states (D1 bills rows read: 5M a day on Free). These make them ranges.
    db.prepare(`CREATE INDEX IF NOT EXISTS intents_swaps_state_created ON intents_swaps(state, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS intents_swaps_route ON intents_swaps(route, state, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS intents_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, swap_id TEXT, actor TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS intents_events_swap ON intents_events(swap_id, seq)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS intents_events_kind ON intents_events(kind, at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS intents_control (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, actor TEXT NOT NULL)`),
    // Who first claimed each payout tx (see intents-io.ts PAYOUT OWNERSHIP).
    db.prepare(`CREATE TABLE IF NOT EXISTS intents_payouts (
      hash TEXT PRIMARY KEY, swap_id TEXT NOT NULL, at INTEGER NOT NULL)`),
    // A swap's payout txs are looked up by swap (verification, the purge's KEEP rule):
    // without this, both read the whole payouts table (round 15).
    db.prepare(`CREATE INDEX IF NOT EXISTS intents_payouts_swap ON intents_payouts(swap_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS intents_rl (
      k TEXT NOT NULL, win INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (k, win))`),
  ])
  // CREATE TABLE IF NOT EXISTS never adds a column to a table that already exists.
  // Round 13, measured on workerd: a ledger created before state_at / deadline_ms
  // existed made every preview a 500 ("no such column"). Columns added later are
  // added here, once per isolate.
  const have = new Set((((await db.prepare('PRAGMA table_info(intents_swaps)').all<{ name: string }>()).results) || []).map(c => c.name))
  for (const [col, type] of ADDED_COLUMNS) {
    if (have.has(col)) continue
    try { await db.prepare(`ALTER TABLE intents_swaps ADD COLUMN ${col} ${type}`).run() }
    catch (e) { if (!/duplicate column/i.test(String((e as Error)?.message))) throw e }   // another isolate added it first
  }
  if (!have.has('state_at') || !have.has('deadline_ms')) {
    // Rows from before the columns: deadline_ms from the stored ISO deadline; state_at from
    // created_at (a swap can only have entered its state after it was created, so "stuck"
    // errs towards asking a human, never towards silence).
    await db.batch([
      db.prepare(`UPDATE intents_swaps SET deadline_ms = CAST(ROUND((julianday(deadline) - 2440587.5) * 86400000) AS INTEGER)
        WHERE deadline_ms IS NULL AND deadline IS NOT NULL AND julianday(deadline) IS NOT NULL`),
      db.prepare(`UPDATE intents_swaps SET state_at = created_at WHERE state_at IS NULL`),
    ])
  }
  // After the columns exist: an index on an added column cannot be in the batch above.
  await db.prepare(`CREATE INDEX IF NOT EXISTS intents_swaps_net ON intents_swaps(net, created_at)`).run()
  // Bulk-expire finds dead unpaid addresses by deadline (round 16: it read every open one each minute).
  await db.prepare(`CREATE INDEX IF NOT EXISTS intents_swaps_state_deadline ON intents_swaps(state, deadline_ms)`).run()
  // Refunded/failed re-checks select by when the state was entered (round 17: a (state,
  // created_at) range read 30 days of them every minute).
  await db.prepare(`CREATE INDEX IF NOT EXISTS intents_swaps_state_at ON intents_swaps(state, state_at)`).run()
  ready = true
}
// Every column added after the first schema. Append only; never remove one.
const ADDED_COLUMNS: [string, string][] = [['state_at', 'INTEGER'], ['deadline_ms', 'INTEGER'], ['net', 'TEXT'], ['upstream_deadline_ms', 'INTEGER'], ['to_contract', 'TEXT'], ['dest_proof', 'TEXT'], ['from_contract', 'TEXT']]

/**
 * Deposit addresses one NETWORK (IPv6 /48, IPv4 /24) may be issued in 24 h (round 15).
 * Every address costs ~13 D1 rows written (row, indexes, fill, event); D1 Free allows
 * 100,000 a day. The per-minute budgets alone let one /48 spend that in hours; this
 * caps addresses at ~4k rows/day per network. Generous for a household, office or
 * carrier NAT: a person needs a handful.
 */
export const NET_DAILY_SWAPS = 300
/**
 * Round 16. A deposit address stays payable at 1Click until ITS deadline (measured: 3 days
 * for our 1 h request), long after it stops counting toward a client's open slots and daily
 * USD here. So per-client caps alone did not bound what one network could put through the
 * desk: mint, wait for our deadline, mint again, fund them all later. These two count every
 * address actually ISSUED in the last 24 h, dead or alive, and reservations that never got an
 * address count for nothing (one client could otherwise burn its whole network's quota
 * with refused requests).
 */
export const NET_DAILY_USD = 50_000
export const MEMBER_DAILY_SWAPS = 40      // one client inside a shared network: well below the network's 300
const ISSUED = `deposit_address IS NOT NULL AND created_at >= ?`

/**
 * Atomic fixed-window budget in D1. One upsert that only increments while under
 * the limit; `changes === 1` means this call got a slot. Red-team round 3: the
 * KV limiter is eventually consistent across edge locations, and with stale
 * reads 120/120 previews, 30/30 tx submits and 30/30 status refreshes went
 * through to 1Click — a partner who can cut the desk off for abuse.
 */
export async function take(db: D1Database, key: string, limit: number, windowSec: number, now = Date.now()): Promise<boolean> {
  const win = Math.floor(now / 1000 / windowSec)
  const r = await db.prepare(`INSERT INTO intents_rl (k, win, n) VALUES (?, ?, 1)
      ON CONFLICT(k, win) DO UPDATE SET n = n + 1 WHERE n < ?`).bind(key, win, limit).run()
  return (r.meta as any)?.changes === 1
}
/** Tests only: forget that tables were created (fresh in-memory DB per case). */
export function __resetLedger() { ready = false }

export async function logEvent(db: D1Database, swapId: string | null, actor: string, kind: string, detail: unknown): Promise<void> {
  await db.prepare('INSERT INTO intents_events (at, swap_id, actor, kind, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(Date.now(), swapId, actor, kind, detail === undefined ? null : JSON.stringify(detail).slice(0, 4000)).run()
}

/**
 * Reserve an idempotency key BEFORE talking to 1Click, so a double click, a
 * retry or two tabs can never yield two deposit addresses for one intent.
 *   'new'      → caller owns the reservation and must fill or abandon it
 *   'existing' → return this row as the answer (no new upstream call)
 *   'busy'     → another request holds it right now
 */
export interface Caps { memberOpenSwaps: number; memberDailyUsd: number; routeDailyUsd: number; globalDailyUsd: number }
// Every reservation (refused ones included) makes 1Click mint a deposit address.
// The KV limiter is eventually consistent across edge locations — red-team
// round 2 had a stale KV let 30 sequential doomed requests mint 30 addresses —
// so the per-member minute budget is enforced here, atomically, as well.
export const RESERVATIONS_PER_MINUTE = 6

/**
 * Route and desk-wide 24 h caps count FUNDED swaps only (a deposit was seen).
 * The desk is public with no accounts: counting every unpaid address let a
 * handful of IPs request addresses they never paid and hold the whole desk's
 * daily budget until those addresses expired (standalone design
 * review). Per-client caps still count every address issued.
 */
const FUNDED = `state IN ('deposit_seen','incomplete_deposit','processing','delivered_claimed','settled') AND created_at >= ?`
/**
 * What a funded swap puts against the route / desk-wide caps: the share of its quoted USD
 * that was actually DEPOSITED (round 17: the full quoted USD counted from the first sight
 * of any deposit, so dust sent to a few $2,500 addresses filled the desk-wide cap and locked
 * every user out for a day). A deposit not yet measured counts nothing until it is;
 * refunded and failed swaps put nothing through, so they count nothing.
 */
// …except a swap already SWAPPING or later whose deposit was never reported: it counts in
// full (round 18 — whether 1Click always reports depositedAmount there is unverified, and if
// it did not, the caps would count real volume as $0).
// Round 19: a swap 1Click is swapping (or has delivered) counts its full quote, whatever deposit
// figure is stored — dust first, then an unreported full deposit, left a few units counted.
const FUNDED_USD = `COALESCE(SUM(CASE WHEN state IN ('processing','delivered_claimed','settled') THEN usd_in
  ELSE usd_in * MIN(1.0, CAST(COALESCE(deposited, '0') AS REAL) / MAX(1.0, CAST(amount_in AS REAL))) END), 0)`
// Funded swaps are kept forever, so these sums must read only the last day's rows. Pinned
// (round 15, measured with EXPLAIN after ANALYZE): left to itself SQLite chose a full scan
// of every funded swap ever, on every preview — against D1 Free's 5M rows read a day.
const BY_STATE_TIME = 'INDEXED BY intents_swaps_state_created'
const BY_ROUTE = 'INDEXED BY intents_swaps_route'

/**
 * Exposure caps are enforced INSIDE the insert (one SQL statement, which D1
 * runs atomically), with this trade's USD stored on the reservation itself.
 * Red-team: checking usage first and inserting after let 20
 * simultaneous requests all pass the same cap; a KV rate limiter is not atomic
 * either, so it could not be the guard.
 */
/**
 * An "open" swap holds one of its client's open-swap slots: being reserved, or an
 * address still inside its deadline. A dead address no longer holds a slot even
 * if the reconciler has not marked it expired yet (round 13: a backed-up queue
 * left returning users locked out by their own expired addresses). One `?` = now.
 */
// Bounded to the last day (two `?`: since, now): unbounded, it read the client's whole
// history on every request (round 15). No address lives longer than 6 h.
const OPEN_SLOT = `(created_at >= ? AND (state = 'reserving' OR (state = 'awaiting_deposit' AND (deadline_ms IS NULL OR deadline_ms > ?))))`
/**
 * What counts toward a client's daily USD cap: every swap issued in the last 24 h except
 * abandoned, expired, and unpaid addresses already past their deadline (round 13, second
 * pass: four dead $2,500 addresses the reconciler had not reached yet locked a client
 * — on a shared carrier IP, everyone behind it — out for up to a day). One `?` = now.
 */
const COUNTS_TODAY = `state NOT IN ('abandoned','expired') AND NOT (state = 'awaiting_deposit' AND deadline_ms IS NOT NULL AND deadline_ms <= ?)`

export async function reserve(db: D1Database, row: Pick<SwapRow, 'id' | 'idem' | 'member' | 'route' | 'from_chain' | 'to_chain' | 'from_asset' | 'to_asset' | 'amount_in' | 'recipient' | 'refund_to'> & { usd_in: number; from_decimals: number; to_decimals: number; from_symbol: string; to_symbol: string; net?: string | null },
                              now: number, caps: Caps):
  Promise<{ kind: 'new' } | { kind: 'existing'; row: SwapRow } | { kind: 'busy' } | { kind: 'conflict'; dead?: boolean } | { kind: 'cap'; reason: string }> {
  const since = now - 86400e3
  const LIVE = `${COUNTS_TODAY} AND created_at >= ${'?'}`
  const res = await db.prepare(`INSERT INTO intents_swaps
      (id, idem, member, net, created_at, updated_at, state_at, route, from_chain, to_chain, from_asset, to_asset, amount_in, recipient, refund_to, usd_in,
       from_decimals, to_decimals, from_symbol, to_symbol, state)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserving'
      WHERE (SELECT COUNT(*) FROM intents_swaps WHERE member = ? AND created_at >= ?) < ${RESERVATIONS_PER_MINUTE}
        AND (SELECT COUNT(*) FROM intents_swaps WHERE net = ? AND ${ISSUED}) < ${NET_DAILY_SWAPS}
        AND (SELECT COALESCE(SUM(usd_in),0) FROM intents_swaps WHERE net = ? AND ${ISSUED}) + ? <= ${NET_DAILY_USD}
        AND (SELECT COUNT(*) FROM intents_swaps WHERE member = ? AND ${ISSUED}) < ${MEMBER_DAILY_SWAPS}
        AND (SELECT COUNT(*) FROM intents_swaps WHERE member = ? AND ${OPEN_SLOT}) < ?
        AND (SELECT COALESCE(SUM(usd_in),0) FROM intents_swaps WHERE member = ? AND ${LIVE}) + ? <= ?
        AND (SELECT ${FUNDED_USD} FROM intents_swaps ${BY_ROUTE} WHERE route = ? AND ${FUNDED}) + ? <= ?
        AND (SELECT ${FUNDED_USD} FROM intents_swaps ${BY_STATE_TIME} WHERE ${FUNDED}) + ? <= ?
      ON CONFLICT(idem) DO NOTHING`)
    .bind(row.id, row.idem, row.member, row.net ?? null, now, now, now, row.route, row.from_chain, row.to_chain, row.from_asset, row.to_asset, row.amount_in, row.recipient, row.refund_to, row.usd_in,
      row.from_decimals, row.to_decimals, row.from_symbol, row.to_symbol,
      row.member, now - 60_000,
      row.net ?? null, since,
      row.net ?? null, since, row.usd_in,
      row.member, since,
      row.member, since, now, caps.memberOpenSwaps,
      row.member, now, since, row.usd_in, caps.memberDailyUsd,
      row.route, since, row.usd_in, caps.routeDailyUsd,
      since, row.usd_in, caps.globalDailyUsd).run()
  if ((res.meta as any)?.changes === 1) return { kind: 'new' }
  const ex = await db.prepare('SELECT * FROM intents_swaps WHERE idem = ?').bind(row.idem).first<SwapRow>()
  if (!ex) {
    // Not an idempotency hit, so a cap refused it — name which one.
    const u = await usage(db, row.member, row.route, now)
    const lastMinute = Number((await db.prepare('SELECT COUNT(*) AS v FROM intents_swaps WHERE member = ? AND created_at >= ?').bind(row.member, now - 60_000).first<{ v: number }>())?.v || 0)
    const one = async (sql: string, ...b: unknown[]) => Number((await db.prepare(sql).bind(...b).first<{ v: number }>())?.v || 0)
    const netDay = row.net ? await one(`SELECT COUNT(*) AS v FROM intents_swaps WHERE net = ? AND ${ISSUED}`, row.net, since) : 0
    const netUsd = row.net ? await one(`SELECT COALESCE(SUM(usd_in),0) AS v FROM intents_swaps WHERE net = ? AND ${ISSUED}`, row.net, since) : 0
    const memberDay = await one(`SELECT COUNT(*) AS v FROM intents_swaps WHERE member = ? AND ${ISSUED}`, row.member, since)
    const reason = lastMinute >= RESERVATIONS_PER_MINUTE ? 'rate_limited'
      : netDay >= NET_DAILY_SWAPS || netUsd + row.usd_in > NET_DAILY_USD ? 'network_daily_cap'
      : memberDay >= MEMBER_DAILY_SWAPS ? 'member_daily_swaps'
      : u.memberOpen >= caps.memberOpenSwaps ? 'too_many_open_swaps'
      : u.member24hUsd + row.usd_in > caps.memberDailyUsd ? 'member_daily_cap'
      : u.route24hUsd + row.usd_in > caps.routeDailyUsd ? 'route_daily_cap'
      : u.global24hUsd + row.usd_in > caps.globalDailyUsd ? 'global_daily_cap' : 'busy'
    return reason === 'busy' ? { kind: 'busy' } : { kind: 'cap', reason }
  }
  // Same key, different deal → refuse rather than answer with the old deal.
  if (ex.from_asset !== row.from_asset || ex.to_asset !== row.to_asset || ex.amount_in !== row.amount_in
      || ex.recipient !== row.recipient || ex.refund_to !== row.refund_to) return { kind: 'conflict' }
  if (ex.state === 'reserving') return now - ex.created_at > 60_000 ? { kind: 'conflict' } : { kind: 'busy' }
  if (ex.state === 'abandoned') return { kind: 'conflict', dead: true }   // no swap holds this key: the caller may say so
  return { kind: 'existing', row: ex }
}

/** true only if THIS call turned the reservation into a live swap (OGOU: the result was ignored). */
export async function fillReservation(db: D1Database, id: string, f: Partial<SwapRow>, now: number): Promise<boolean> {
  const dl = f.deadline ? Date.parse(f.deadline) : NaN
  const res = await db.prepare(`UPDATE intents_swaps SET updated_at = ?, state_at = ?, state = 'awaiting_deposit', upstream_status = 'PENDING_DEPOSIT',
      amount_out = ?, min_amount_out = ?, usd_in = ?, cost_bps = ?, platform_fee_bps = ?, our_fee_bps = ?,
      deposit_address = ?, deadline = ?, deadline_ms = ?, upstream_deadline_ms = ?, to_contract = ?, from_contract = ?, signature = ?, correlation_id = ?, quote_json = ?
      WHERE id = ? AND state = 'reserving'`)
    .bind(now, now, f.amount_out, f.min_amount_out, f.usd_in ?? null, f.cost_bps ?? null, f.platform_fee_bps ?? 0, f.our_fee_bps ?? 0,
      f.deposit_address, f.deadline, Number.isFinite(dl) ? dl : null, f.upstream_deadline_ms ?? null, f.to_contract ?? null, f.from_contract ?? null, f.signature, f.correlation_id, f.quote_json, id).run()
  return (res.meta as any)?.changes === 1
}

export async function abandon(db: D1Database, id: string, reason: string, now: number): Promise<void> {
  await db.prepare(`UPDATE intents_swaps SET state = 'abandoned', updated_at = ?, flags = ? WHERE id = ? AND state = 'reserving'`)
    .bind(now, JSON.stringify([reason]), id).run()
}

export async function getSwap(db: D1Database, id: string): Promise<SwapRow | null> {
  return db.prepare('SELECT * FROM intents_swaps WHERE id = ?').bind(id).first<SwapRow>()
}

export async function memberSwaps(db: D1Database, member: string, limit = 20): Promise<SwapRow[]> {
  const r = await db.prepare(`SELECT * FROM intents_swaps WHERE member = ? AND state NOT IN ('reserving','abandoned')
      ORDER BY created_at DESC LIMIT ?`).bind(member, limit).all<SwapRow>()
  return r.results || []
}

/**
 * USD reserved or issued in the last 24 h (abandoned / expired excluded) —
 * the same rule reserve() enforces atomically. `excludeId` leaves out the
 * caller's own reservation so it is not counted twice.
 */
export async function usage(db: D1Database, member: string, route: string, now: number, excludeId = '') {
  const since = now - 86400e3
  const live = `${COUNTS_TODAY} AND created_at >= ? AND id <> ?`
  const funded = `${FUNDED} AND id <> ?`
  const one = async (sql: string, ...b: unknown[]) => Number((await db.prepare(sql).bind(...b).first<{ v: number }>())?.v || 0)
  return {
    member24hUsd: await one(`SELECT COALESCE(SUM(usd_in),0) AS v FROM intents_swaps WHERE ${live} AND member = ?`, now, since, excludeId, member),
    route24hUsd: await one(`SELECT ${FUNDED_USD} AS v FROM intents_swaps ${BY_ROUTE} WHERE ${funded} AND route = ?`, since, excludeId, route),
    global24hUsd: await one(`SELECT ${FUNDED_USD} AS v FROM intents_swaps ${BY_STATE_TIME} WHERE ${funded}`, since, excludeId),
    memberOpen: await one(`SELECT COUNT(*) AS v FROM intents_swaps WHERE member = ? AND ${OPEN_SLOT} AND id <> ?`, member, since, now, excludeId),
  }
}

/**
 * Apply one observation. Optimistic: the UPDATE only lands if the row is still
 * in the state we read, so two concurrent pollers cannot both move it.
 */
export async function applyObservation(db: D1Database, row: SwapRow, patch: Partial<SwapRow>, actor: string, now: number): Promise<boolean> {
  const p: Partial<SwapRow> = { ...patch }
  if (p.state && p.state !== row.state) p.state_at = now
  const cols = Object.keys(p).filter(k => k !== 'id' && k !== 'updated_at') as (keyof SwapRow)[]
  if (!cols.length) return false
  // The stamp written is always NEWER than the one read (round 13): the reconciler
  // leases at `now` and used to commit at that same `now`, so a poller holding a copy
  // read between lease and commit still matched and overwrote the newer row.
  const stamp = Math.max(now, row.updated_at + 1)
  const res = await db.prepare(`UPDATE intents_swaps SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ?
      WHERE id = ? AND state = ? AND updated_at = ?`)
    .bind(...cols.map(c => (p as any)[c] ?? null), stamp, row.id, row.state, row.updated_at).run()
  const landed = (res.meta as any)?.changes === 1
  if (landed && patch.state && patch.state !== row.state) await logEvent(db, row.id, actor, 'state', { from: row.state, to: patch.state })
  return landed
}

// ───────────────────────────────────────────────────────────── controls ──

export async function readControls(db: D1Database): Promise<{ controls: Controls; limits: unknown }> {
  const rows = ((await db.prepare('SELECT key, value FROM intents_control').all<{ key: string; value: string }>()).results) || []
  const c: Controls = { globalPaused: null, routes: {}, chains: {}, assets: {} }
  let limits: unknown = null
  for (const r of rows) {
    if (r.key === 'pause:global') c.globalPaused = r.value
    else if (r.key.startsWith('pause:route:')) c.routes[r.key.slice(12)] = r.value
    else if (r.key.startsWith('pause:chain:')) c.chains[r.key.slice(12)] = r.value
    else if (r.key.startsWith('pause:asset:')) c.assets[r.key.slice(12)] = r.value
    else if (r.key === 'limits') { try { limits = JSON.parse(r.value) } catch { /* ignored */ } }
  }
  return { controls: c, limits }
}

export async function setControl(db: D1Database, key: string, value: string | null, actor: string): Promise<void> {
  if (value === null) await db.prepare('DELETE FROM intents_control WHERE key = ?').bind(key).run()
  else await db.prepare(`INSERT INTO intents_control (key, value, updated_at, actor) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, actor = excluded.actor`)
    .bind(key, value, Date.now(), actor).run()
  await logEvent(db, null, actor, value === null ? 'control_clear' : 'control_set', { key, value })
}

/**
 * Public projection of a swap for its owner. Never includes another member's data.
 * A deposit address past its deadline is never handed out again, whatever the
 * stored state says — the reconciler may not have run yet (red-team round 2:
 * an idempotent replay re-served a dead address).
 */
export function publicSwap(r: SwapRow, now = Date.now()) {
  const dead = !!r.deadline && Number.isFinite(Date.parse(r.deadline)) && Date.parse(r.deadline) <= now
  if (dead && (r.state === 'awaiting_deposit' || r.state === 'incomplete_deposit')) r = { ...r, state: 'expired' as State }
  // Kept for every other state: it is the member's dispute evidence, and the card
  // only offers "send here" while the swap is awaiting/incomplete AND alive.
  const showAddr = r.state !== 'expired'
  const j = (s: string | null) => { try { return s ? JSON.parse(s) : [] } catch { return [] } }
  // No date or timestamp leaves the desk (owner's rule): `rev` orders answers for the page
  // (ms since this swap was created, only ever grows), `secondsLeft` is the time left to send.
  const dl = r.deadline ? Date.parse(r.deadline) : NaN
  return {
    id: r.id, rev: Math.max(0, r.updated_at - r.created_at),
    secondsLeft: Number.isFinite(dl) ? Math.max(0, Math.floor((dl - now) / 1000)) : null,
    fromAsset: r.from_asset, toAsset: r.to_asset, fromChain: r.from_chain, toChain: r.to_chain,
    fromDecimals: r.from_decimals, toDecimals: r.to_decimals, fromSymbol: r.from_symbol, toSymbol: r.to_symbol,
    amountIn: r.amount_in, amountOut: r.amount_out, minAmountOut: r.min_amount_out,
    usdIn: r.usd_in, costBps: r.cost_bps, platformFeeBps: r.platform_fee_bps, ourFeeBps: r.our_fee_bps,
    recipient: r.recipient, refundTo: r.refund_to, depositAddress: showAddr ? r.deposit_address : null,
    state: r.state, upstreamStatus: r.upstream_status,
    deposited: r.deposited, amountOutActual: r.amount_out_actual, refunded: r.refunded, refundReason: r.refund_reason,
    originTxs: j(r.origin_txs), destTxs: j(r.dest_txs), destVerified: r.dest_verified,
    signature: r.signature, correlationId: r.correlation_id,
    pay: showAddr ? payWith(r) : null,
  }
}

/**
 * What a connected wallet may send for this swap, or null (the card then offers copy/scan only).
 * Built only from what was frozen at issue, never from the live token list, and only when the
 * three agree: the chain is EVM, the frozen contract (or 'native') and the asset id name the
 * same thing. A row from before the column has none and gets no wallet payment.
 */
export function payWith(r: SwapRow): { chainId: string; token: string | null } | null {
  if (r.state !== 'awaiting_deposit' && r.state !== 'incomplete_deposit') return null
  const chainId = CHAINS[r.from_chain]?.evmChainId
  if (!chainId || !r.deposit_address || !/^0x[0-9a-fA-F]{40}$/.test(r.deposit_address)) return null
  if (!assetOnChain(r.from_asset, r.from_chain, chainId)) return null
  const fc = r.from_contract
  if (fc !== 'native' && !(typeof fc === 'string' && /^0x[0-9a-fA-F]{40}$/.test(fc))) return null
  // An id that writes its contract in (Omni, omdep, 1cs) must name the frozen one.
  const named = /-(0x[0-9a-fA-F]{40})\.(?:omft|omdep)\.near$|^1cs_v1:[a-z]+:[a-z0-9]+:(0x[0-9a-fA-F]{40})$/.exec(r.from_asset)
  if (named && (fc === 'native' || (named[1] || named[2]).toLowerCase() !== fc.toLowerCase())) return null
  const a = evmAssetOf(r.from_asset, fc === 'native' ? null : fc)
  if (!a) return null
  if (fc === 'native') return a.kind === 'native' ? { chainId, token: null } : null
  return a.kind === 'erc20' && a.contract === fc.toLowerCase() ? { chainId, token: a.contract } : null
}
/**
 * The asset id itself names the chain the wallet would pay on: Omni ids by chain name
 * (nep141:base-0x….omft.near, nep141:pol-0x….omdep.near), 1cs ids by chain name
 * (1cs_v1:bsc:bep20:0x…), HOT ids by EIP-155 number (nep245:v2_1.omni.hot.tg:137_…). Checked
 * against all 87 EVM tokens of the live list: every one names its own chain, and none is accepted
 * on any other. Anything else gets no wallet payment.
 */
function assetOnChain(assetId: string, chain: string, chainId: string): boolean {
  let m = /^nep141:([a-z]+)(?:-0x[0-9a-f]{40})?\.(?:omft|omdep)\.near$/.exec(assetId)
  if (m) return m[1] === chain
  m = /^1cs_v1:([a-z]+):[a-z0-9]+:0x[0-9a-fA-F]{40}$/.exec(assetId)
  if (m) return m[1] === chain
  m = /^nep245:v2_1\.omni\.hot\.tg:(\d{1,7})_[1-9A-HJ-NP-Za-km-z]{1,64}$/.exec(assetId)
  if (m) return Number(m[1]) === parseInt(chainId, 16)
  return false
}
