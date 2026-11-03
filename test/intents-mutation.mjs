// ============================================================
// CRYPTO LWA · cross-chain desk — MUTATION CAMPAIGN
// ============================================================
// "Can't break it" is only as strong as the tests that would notice a break.
// Each mutant below switches off ONE safety guard in a copy of the built bundle;
// every suite runs against it; the mutant must be KILLED (some suite fails).
// A surviving mutant = a guard no test protects.
//
//   node intents-mutation.mjs
// ============================================================
import fs from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
const BUNDLE = new URL('./.build/sys.mjs', import.meta.url)
const SRC = fs.readFileSync(BUNDLE, 'utf8')
const SUITES = ['intents-redteam.mjs', 'intents-redteam2.mjs', 'intents-redteam3.mjs', 'intents-redteam4.mjs', 'intents-redteam5.mjs', 'intents-redteam6.mjs', 'intents-redteam9.mjs', 'intents-redteam10.mjs', 'intents-redteam11.mjs', 'intents-redteam12.mjs', 'intents-redteam13.mjs', 'intents-redteam14.mjs', 'intents-system.mjs', 'intents-wallet.mjs', 'intents-nearkeys.mjs']

const MUTANTS = [
  // 1Click's tx lists (slimStatus): the live shape has explorerUrl "" on every tx (first real swap)
  ['txs: a tx without an https explorer link is dropped (old rule)', '.filter((t) => t && typeof t.hash === "string" && /^[0-9A-Za-z]{1,120}$/.test(t.hash))', '.filter((t) => t && typeof t.hash === "string" && /^[0-9A-Za-z]{1,120}$/.test(t.hash) && /^https:\\/\\//.test(t.explorerUrl || ""))'],
  ['txs: any string stored as a hash', '.filter((t) => t && typeof t.hash === "string" && /^[0-9A-Za-z]{1,120}$/.test(t.hash))', '.filter((t) => t && typeof t.hash === "string")'],
  ['txs: a non-https explorer link stored', 'explorerUrl: typeof t.explorerUrl === "string" && /^https:\\/\\//.test(t.explorerUrl) ? t.explorerUrl.slice(0, 300) : ""', 'explorerUrl: typeof t.explorerUrl === "string" ? t.explorerUrl.slice(0, 300) : ""'],
  // the NEAR key checker: who can sign for the account a payout lands in (nearKeys + the quote's warnings)
  ['nearkeys: one operator is enough', 'if (a === null || b === null) return null;', 'if (a === null) return null; if (b === null) b = a;'],
  ['nearkeys: operators may disagree', 'if (JSON.stringify(a) !== JSON.stringify(b)) return null;', ''],
  ['nearkeys: an unknown permission counted as an app key', 'const limited = !!p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 1 && LIMITED_KEYS.has(Object.keys(p)[0]);', 'const limited = p !== "FullAccess";'],
  ['nearkeys: any string shown as a key', 'if (typeof pk !== "string" || !NEAR_PK.test(pk)) return null;', 'if (typeof pk !== "string") return null;'],
  ['nearkeys: an oversized key list accepted', 'if (!Array.isArray(ks) || ks.length > 100) return null;', 'if (!Array.isArray(ks)) return null;'],
  ['nearkeys: a missing account read as locked', 'if (j?.error?.cause?.name === "UNKNOWN_ACCOUNT") {\n        fresh = true;', 'if (j?.error?.cause?.name === "UNKNOWN_ACCOUNT") {\n        locked = true;'],
  ['nearkeys: only the first other operator is tried', 'const b = others.find((x) => x !== null) ?? null;', 'const b = others[0];'],
  ['nearkeys: fastnear alone is enough when the others are down', 'const b = others.find((x) => x !== null) ?? null;', 'const b = others.find((x) => x !== null) ?? a;'],
  ['nearkeys: a later operator outvotes the first one that answered', 'const b = others.find((x) => x !== null) ?? null;', 'const b = others.filter((x) => x !== null).find((x) => JSON.stringify(x) === JSON.stringify(a)) ?? null;'],
  ['nearkeys: the account check asks one operator only', 'for (const url of NEAR_RPCS) {\n      const j = await nearQuery(url, { request_type: "view_account"', 'for (const url of NEAR_RPCS.slice(0, 1)) {\n      const j = await nearQuery(url, { request_type: "view_account"'],
  ['nearkeys: an eth-implicit account called locked', 'locked = !ethImplicit;', 'locked = true;'],
  ['nearkeys: "too many keys" from one operator is enough', 'return a === b ? { full: [], limited: 0, locked: false, fresh: false, tooMany: true, ethImplicit } : null;', 'return { full: [], limited: 0, locked: false, fresh: false, tooMany: true, ethImplicit };'],
  ['nearkeys: payout account not checked', 'if (to.chain === "near") {\n    const account', 'if (false) {\n    const account'],
  ['nearkeys: a failed check not warned', 'if (!k) chainWarn.push("near_keys_unchecked");', 'if (!k) ;'],
  ['nearkeys: too many keys not warned', 'else if (k.tooMany) chainWarn.push("near_keys_too_many");', ''],
  ['nearkeys: a locked account not warned', 'else if (k.locked) chainWarn.push("near_keys_locked");', ''],
  ['nearkeys: a second full-access key not warned', 'else if (k.full.length > 1) chainWarn.push("near_keys_several");', ''],
  // wallet payment: what a connected wallet may be told to pay (payWith)
  ['wallet: pay offered in any state', 'if (r.state !== "awaiting_deposit" && r.state !== "incomplete_deposit") return null;\n  const chainId', 'const chainId'],
  ['wallet: deposit address format unchecked', '!r.deposit_address || !/^0x[0-9a-fA-F]{40}$/.test(r.deposit_address)) return null;', '!r.deposit_address) return null;'],
  ['wallet: asset id may name another chain', 'if (!assetOnChain(r.from_asset, r.from_chain, chainId)) return null;', ''],
  ['wallet: HOT chain number not compared', 'if (m) return Number(m[1]) === parseInt(chainId, 16);', 'if (m) return true;'],
  // pairs: the contract an id names is checked twice (the `named` check, then evmAssetOf), so each
  // mutant switches off both layers at once (each alone was measured to survive behind the other)
  ['wallet: frozen contract not compared with the asset id (both layers)',
    'if (named && (fc === "native" || (named[1] || named[2]).toLowerCase() !== fc.toLowerCase())) return null;\n  const a = evmAssetOf(r.from_asset, fc === "native" ? null : fc);\n  if (!a) return null;\n  if (fc === "native") return a.kind === "native" ? { chainId, token: null } : null;\n  return a.kind === "erc20" && a.contract === fc.toLowerCase() ? { chainId, token: a.contract } : null;',
    'const a = evmAssetOf(r.from_asset, fc === "native" ? null : fc);\n  if (!a) return null;\n  if (fc === "native") return a.kind === "native" ? { chainId, token: null } : null;\n  return a.kind === "erc20" ? { chainId, token: fc.toLowerCase() } : null;'],
  ['wallet: "native" trusted for a token asset (both layers)',
    'if (named && (fc === "native" || (named[1] || named[2]).toLowerCase() !== fc.toLowerCase())) return null;\n  const a = evmAssetOf(r.from_asset, fc === "native" ? null : fc);\n  if (!a) return null;\n  if (fc === "native") return a.kind === "native" ? { chainId, token: null } : null;',
    'const a = evmAssetOf(r.from_asset, fc === "native" ? null : fc);\n  if (!a) return null;\n  if (fc === "native") return { chainId, token: null };'],
  ['wallet: a row without a frozen contract reads the asset id alone', 'if (fc !== "native" && !(typeof fc === "string" && /^0x[0-9a-fA-F]{40}$/.test(fc))) return null;', ''],
  ['wallet: contract written in an omdep / 1cs id not compared', 'if (named && (fc === "native" || (named[1] || named[2]).toLowerCase() !== fc.toLowerCase())) return null;', ''],
  ['wallet: deposit contract not frozen at issue', 'from_contract: from.contract ?? "native",', ''],
  ['wallet: Base chain id wrong', 'evmChainId: "0x2105"', 'evmChainId: "0x1"'],
  ['wallet: Polygon chain id is a testnet\'s (Amoy)', 'evmChainId: "0x89"', 'evmChainId: "0x13882"'],
  ['burn/system addresses accepted', 'async function unspendable(chain, addr) {', 'async function unspendable(chain, addr) { return false;'],
    // anchored on the name only: esbuild renames the first parameter (tokens → tokens3) as the bundle grows
  ['token contracts accepted as wallets', 'function isTokenContract(', 'function isTokenContract(...__a) { return false; } function __unusedTC('],
  ['router may change the recipient', 'if (!sameAddr(to.chain, r.recipient, sent.recipient)) return { ok: false, error: "echo_recipient" };', ''],
  ['memo deposits accepted', 'if (q.depositMemo) return { ok: false, error: "memo_required" };', ''],
  ['dying deposit address accepted', 'if (Date.parse(q.deadline) < Date.now() + 15 * 6e4) return { ok: false, error: "upstream_deadline_too_soon" };', ''],
  ['dead address re-served', 'const dead = !!r.deadline && Number.isFinite(Date.parse(r.deadline)) && Date.parse(r.deadline) <= now;', 'const dead = false;'],
  ['D1 budgets disabled', 'async function take(db, key, limit, windowSec, now = Date.now()) {', 'async function take(db, key, limit, windowSec, now = Date.now()) { return true;'],
  ['refresh lease disabled', 'if (lease.meta?.changes !== 1) return', 'if (false) return'],
  ['old payouts accepted', 'return n + (toChain === "btc" ? 7200 : 120) < notBefore ? "stale" : v;', 'return v;'],
  ['status feed may name another recipient', 'echoBad = "status_recipient_mismatch";', ';'],
  ['too-good prices accepted', 't.costBps > limits.costBlockBps || t.costBps < -limits.costBlockBps', 't.costBps > limits.costBlockBps'],
  ['ambiguous symbols offered', 'return out.filter((t) => count.get(t.chain + "\\0" + t.symbol.toUpperCase()) === 1)', 'return out.filter((t) => true)'],
  ['missing NEAR accounts accepted', 'if (ex === false) return', 'if (false) return'],
  ['Solana token accounts accepted', 'if (TOKEN_PROGRAMS.has(String(v.owner))) return { hard: "token_account" };', ''],
  // anchored on text esbuild never renames (it renamed norm → norm2 once another `norm` joined the bundle)
  ['payout ownership ignored', 'typeof t?.hash === "string" && owned.has(', 'typeof t?.hash === "string" && true || owned.has('],
  // rounds 7–9
  ['future segwit versions (anyone-can-spend) accepted', 'if (ver >= 2) return false;', ''],
  ['non-taproot v1 programs accepted', 'if (ver === 1 && prog.length !== 32) return false;', ''],
  ['dirty Transfer topic bytes accepted', 'if (lc(l.topics[2]) !== "0x" + "0".repeat(24) + rcpt.slice(2)) continue;', 'if (lc(l.topics[2]).slice(-40) !== rcpt.slice(2)) continue;'],
  ['non-32-byte Transfer data accepted', 'if (typeof l.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(l.data)) continue;', ''],
  ['BTC block-clock tolerance too tight (false replay alarms)', 'toChain === "btc" ? 7200 : 120', '120'],
  ['reconciler ignores the subrequest budget', 'if (meter.n + PER_SWAP_MAX > budget) {', 'if (false) {'],
  ['payout claimed for another swap not flagged', 'if (owner && owner.swap_id !== row.id) foreign.add(h);', ''],
  ['atomic open-swap cap removed', 'AND (SELECT COUNT(*) FROM intents_swaps WHERE member = ? AND ${OPEN_SLOT}) < ?', 'AND (SELECT COUNT(*) FROM intents_swaps WHERE member = ? AND ${OPEN_SLOT}) < ? + 1000'],
  // round 10 — operator/config guards
  ['kill switch only honours "false"', 'new Set(["0", "false", "off", "no", "disabled", "disable"])', 'new Set(["false"])'],
  ['kill switch case-sensitive', 'return !OFF.has(cleanEnv(env.INTENTS_ENABLED).toLowerCase());', 'return !OFF.has(String(env.INTENTS_ENABLED ?? ""));'],
  ['secrets keep BOM / CRLF', 'return String(v ?? "").replace(/^\\uFEFF/, "").trim();', 'return String(v ?? "");'],
  ['fee bps parsed loosely (hex / exponent)', 'const bps = /^\\d{1,3}$/.test(rawBps) ? Number(rawBps) : 0;', 'const bps = Number(rawBps);'],
  ['slippage strings parsed loosely', '/^\\d{1,4}$/.test(body.slippageBps)', 'true'],
  ['1Click API key sent raw', 'const apiKey = cleanEnv(env.INTENTS_API_KEY);', 'const apiKey = String(env.INTENTS_API_KEY ?? "");'],
  // standalone desk: no accounts — tokens, client buckets, the router
  ['any swap token accepted', 'if (!presented || !/^[0-9a-f]{64}$/.test(presented)) return false;', 'return true;'],
  ['swap view skips the token', 'if (!UUID.test(id) || !await tokenOk(secret, id, presentedToken(ctx.request))) return notFound();', 'if (!UUID.test(id)) return notFound();'],
  ['tx submit skips the token', 'if (!await tokenOk(secret, id, presentedToken(ctx.request))) return json(', 'if (false) return json('],
  ['swap list skips the tokens', 'if (!UUID.test(id) || !await tokenOk(secret, id, tok)) continue;', 'if (!UUID.test(id)) continue;'],
  ['swap list not capped at 20', 'b.items.slice(0, 20)', 'b.items.slice(0, 100000)'],
  ['IPv6 not grouped by /64 (rotation buys budgets)', 'return groups.slice(0, 4)', 'return groups.slice(0, 8)'],
  ['client bucket ignores the IP', '"ip|" + ipPrefix(ip)', '"ip|"'],
  ['deposit address kept for the router’s 3 days', 'const deadline = q.deadline && Date.parse(q.deadline) < Date.parse(ours) ? q.deadline : ours;', 'const deadline = q.deadline;'],
  ['cross-site POST allowed', 'if (method === "POST" && crossSite(request, url))', 'if (false)'],
  ['short ADMIN_TOKEN accepted', 'if (want.length < 32)', 'if (want.length < 1)'],
  ['short DESK_SECRET accepted', 'return s.length >= 32 ? s : null;', 'return s.length >= 1 ? s : null;'],
  ['request key scoped per IP (network switch → second swap)', 'idem: await idemKey("desk", idem)', 'idem: await idemKey(owner, idem)'],
  // round 13 (machine level)
  ['IPv6 network = /64 instead of /48', 'return p.split(":").slice(0, 3).join(":") + "::/48";', 'return p;'],
  ['rate-limit binding ignored (every budget writes D1)', 'return (await rl.limit({ key: cls + ":" + key })).success;', ';'],
  ['whole-API network gate off', 'if (secret && env.RL_API &&', 'if (false &&'],
  ['content-type substring test', 'if (type !== "application/json")', 'if (!(request.headers.get("content-type") || "").includes("application/json"))'],
  ['declared Content-Length not checked', 'Number(declared) <= max)) return', 'true)) return'],
  ['stream read without a byte cap', 'if (n + value.byteLength > max) {', 'if (false) {'],
  ['stuck measured from the last poll', 'if (now - (row.state_at ?? row.updated_at) > lim)', 'if (now - row.updated_at > lim)'],   // round 25: the grace check uses the same expression
  ['state clock not restarted on a transition', 'if (patch.state && patch.state !== row.state) merged.state_at = now;', ''],
  ['state_at never written', 'if (p.state && p.state !== row.state) p.state_at = now;', ''],
  ['commit stamp may equal the lease stamp', 'const stamp = Math.max(now, row.updated_at + 1);', 'const stamp = now;'],
  ['dead addresses still hold open-swap slots', "(state = 'awaiting_deposit' AND (deadline_ms IS NULL OR deadline_ms > ?))", "(state = 'awaiting_deposit' AND (? IS NOT NULL))"],
  // no dates leave the desk (owner's rule): 1Click's raw quote, a deadline, a settled-at time
  ['a replay hands back 1Click\'s raw dated quote', 'replay: true, swap: publicSwap(row), token:', 'replay: true, swap: publicSwap(row), receipt: JSON.parse(row.quote_json || "null"), token:'],
  ['the issue answer carries 1Click\'s raw dated quote', 'ok: true, terms, swap: publicSwap(row), token:', 'ok: true, terms, swap: publicSwap(row), receipt: JSON.parse(row.quote_json || "null"), token:'],
  ['the public swap carries its deadline and timestamps', '    id: r.id,\n    rev: Math.max(', '    id: r.id, deadline: r.deadline, createdAt: r.created_at,\n    rev: Math.max('],
  ['the proof signs a settled-at time', 'NEAR_TEXT : CHECK_TEXT[check]\n  });', 'NEAR_TEXT : CHECK_TEXT[check],\n    settledAt: new Date(row.state_at ?? row.updated_at).toISOString()\n  });'],
  // round 14 (round 13, second pass)
  ['retry refused before its swap is looked up (double mint)', 'return replay(ex, secret);', ';'],
  ['dead unpaid addresses count toward the daily cap', "NOT (state = 'awaiting_deposit' AND deadline_ms IS NOT NULL AND deadline_ms <= ?)", "(? IS NOT NULL)"],
  ['unvisited dead addresses never expire (unbounded backlog)', "WHERE state = 'awaiting_deposit' AND deadline_ms IS NOT NULL AND deadline_ms < ?`).bind(now, now, now - 36e5)", "WHERE 0 AND ?`).bind(now - 36e5)"],
  ['every payout tx in the feed is processed', 'slim.s.destinationTxs || [] : []).slice(0, MAX_PAYOUT_TXS);', 'slim.s.destinationTxs || [] : []);'],   // round 27: dest_txs got its own slice
  ['old rows keep state_at NULL', 'UPDATE intents_swaps SET state_at = created_at WHERE state_at IS NULL', 'SELECT 1'],
  ['expired swaps not re-checked after day 7', '    now - 30 * 864e5,\n    now - 7 * 864e5,', '    now - 7 * 864e5,\n    now - 7 * 864e5,'],
  ['idle poll writes twice', 'if (!Object.keys(patch).length) {', 'if (!Object.keys(patch).length) { await applyObservation(db, row, { upstream_status: row.upstream_status }, actor, now);'],
  // re-anchored after rounds 14–15 changed the code under them
  ['desk-wide budget spent before validation (lockout)', 'const dry = body.dry !== false;', 'const dry = body.dry !== false; await ensureTables(db); if (!await spend(env, db, dry ? "qa" : "aa", "*")) return refuse(429, "rate_limited");'],
  ['no network budget (a /48 = 65,536 clients)', '[["q", owner], ["qn", network], ["qa", "*"]] : [["a", owner], ["an", network], ["aa", "*"]]', '[["q", owner], ["qa", "*"]] : [["a", owner], ["aa", "*"]]'],
  ['no retention purge', '...gone.flatMap(', '...[].flatMap('],
  ['refusals claim the key is free when a swap may hold it', 'keyFree = !!ex && ex.state === "abandoned";', 'keyFree = true;'],
  ['refusals never say the key is free', 'keyFree = !!ex && ex.state === "abandoned";', 'keyFree = false;'],
  // round 15
  ['conflict on a dead key not marked free (press-again loop)', '...res.dead ? { keyFree: true } : {}', '...{}'],
  ['crash after reserve leaves it reserving', 'if (st.db && st.reservedId) await abandon(', 'if (false) await abandon('],
  ['any fill error logged as a reused-address critical', 'if (!/UNIQUE/i.test(String(e?.message))) throw e;', ''],
  ['one throwing swap ends the reconciler pass', 'console.error("reconcile", r.id, String(e?.message || e).slice(0, 300));', 'throw e;'],
  ['funded totals scan every funded swap ever', 'var BY_STATE_TIME = "INDEXED BY intents_swaps_state_created";', 'var BY_STATE_TIME = "";'],
  ['payouts looked up by swap without an index', 'db.prepare(`CREATE INDEX IF NOT EXISTS intents_payouts_swap ON intents_payouts(swap_id)`),', ''],
  ['bulk-expire winds the version stamp back', "SET state = 'expired', state_at = ?, updated_at = MAX(updated_at + 1, ?)", "SET state = 'expired', state_at = ?, updated_at = ?"],
  // round 16
  ['refused reservations count toward the network/client daily caps', 'var ISSUED = `deposit_address IS NOT NULL AND created_at >= ?`;', 'var ISSUED = `created_at >= ?`;'],
  ['no network daily USD cap (fund dead-to-us addresses later)', '+ ? <= ${NET_DAILY_USD}', '+ ? <= 1e15'],
  ['no per-client daily address cap inside a network', '< ${MEMBER_DAILY_SWAPS}', '< 1000000'],
  ['expired rows purged with no check after 1Click\'s deadline', "(state = 'abandoned' OR updated_at > COALESCE(", "(1 OR updated_at > COALESCE("],
  ['1Click\'s deadline not stored', 'upstream_deadline_ms: q.deadline && Number.isFinite(Date.parse(q.deadline)) ? Date.parse(q.deadline) : null,', 'upstream_deadline_ms: null,'],
  ['a housekeeping failure ends the pass', 'console.error("reconcile housekeeping",', 'throw e; console.error("reconcile housekeeping",'],
  ['a cap refusal says the key is free (in-flight twin may still mint)', 'if (res.kind === "cap") return res.reason === "rate_limited"', 'if (res.kind === "cap") keyFree = true; if (res.kind === "cap") return res.reason === "rate_limited"'],
  // re-anchored after round 16
  ['old ledgers not upgraded', 'var ADDED_COLUMNS = [["state_at", "INTEGER"], ["deadline_ms", "INTEGER"], ["net", "TEXT"], ["upstream_deadline_ms", "INTEGER"], ["to_contract", "TEXT"], ["dest_proof", "TEXT"], ["from_contract", "TEXT"]];', 'var ADDED_COLUMNS = [];'],
  ['purge deletes evidence', "AND deposited IS NULL AND origin_txs IS NULL AND (flags IS NULL OR flags = '[]' OR state = 'abandoned')", 'AND 1'],
  ['no per-network daily address cap', 'AND ${ISSUED}) < ${NET_DAILY_SWAPS}', 'AND ${ISSUED}) < 1000000'],
  // round 17
  ['dust counts its full quoted USD against the desk caps', "usd_in * MIN(1.0, CAST(COALESCE(deposited, '0') AS REAL) / MAX(1.0, CAST(amount_in AS REAL)))", 'usd_in'],
  ['refunded and failed swaps still count against the desk caps', "'delivered_claimed','settled') AND created_at >= ?`", "'delivered_claimed','settled','refunded','failed') AND created_at >= ?`"],
  ['swaps in progress take the whole pass', 'if (j < mixed.length) rows.push(mixed[j++]);', 'if (i >= money.length && j < mixed.length) rows.push(mixed[j++]);'],
  ['refunds re-checked by creation date (30 days scanned)', "INDEXED BY intents_swaps_state_at WHERE state IN ('refunded','failed') AND state_at >= ?", "INDEXED BY intents_swaps_state_created WHERE state IN ('refunded','failed') AND created_at >= ?"],
  // re-anchored after round 17 (the 'unpaid count toward the desk cap' mutant is moot: an unpaid row has no deposit, so it counts $0)
  ['funded swaps not counted toward the desk-wide cap', "state IN ('deposit_seen','incomplete_deposit','processing','delivered_claimed','settled') AND created_at >= ?`", "state IN ('none') AND created_at >= ?`"],
  ['final swaps stay "recent" forever', "state IN ('refunded','failed') AND state_at >= ?", "state IN ('refunded','failed') AND updated_at >= ?"],
  ['re-checks not interleaved with open addresses', 'if (recheck[i]) mixed.push(recheck[i]);', 'if (recheck[i] && i >= open.length) mixed.push(recheck[i]);'],
  ['money swaps not first', '    if (i < money.length) rows.push(money[i++]);\n    if (i < money.length) rows.push(money[i++]);\n    if (j < mixed.length) rows.push(mixed[j++]);',
    '    if (j < mixed.length) rows.push(mixed[j++]);\n    if (i < money.length) rows.push(money[i++]);\n    if (i < money.length) rows.push(money[i++]);'],
  // round 18
  ["verification ignores the pass budget","meter.n + VERIFY_MAX + AFTER_VERIFY_MAX <= meter.max","true"],
  ["verification forgets the calls that follow it","meter.n + VERIFY_MAX + AFTER_VERIFY_MAX <= meter.max","meter.n + VERIFY_MAX <= meter.max"],
  ["an idle poll that 1Click answers writes twice","if (v !== row[k]) patch[k] = v;","patch[k] = v;"],
  ["a refund re-check can be pushed out by an expired backlog","...finalDue.slice(0, 1), ...[...expiredDue, ...finalDue.slice(1)]","...[...expiredDue, ...finalDue]"],
  // round 19
  ["a swap in progress counts only its reported deposit (dust-then-unreported bypass)","CASE WHEN state IN ('processing','delivered_claimed','settled') THEN usd_in","CASE WHEN 0 THEN usd_in"],
  ["delivered swaps do not lead the queue","[...claimed, ...await q(","[...await q("],
  ["a manual reconcile ignores the setup calls made before it","reconcileBatch(env, db, 25, Date.now(), 12)","reconcileBatch(env, db)"],
  // round 21
  ["delivered swaps that never verify take every pass","AND (verify_attempts < ? OR updated_at < ?) ORDER BY updated_at ASC LIMIT 2","AND (? > 0 OR ? > 0) ORDER BY updated_at ASC LIMIT 25"],
  ["payout checked against today's token list, not the frozen one","const contract = row.to_contract === \"native\" ? null : row.to_contract ?? tk?.tokens","const contract = tk?.tokens"],
  ["admin resolve closes a swap in any state","WHERE id = ? AND state = 'delivered_claimed'","WHERE id = ?"],
  // round 22
  ["payouts on BSC/Polygon/OP/AVAX ignore the frozen contract","if (contract && /^0x[0-9a-fA-F]{40}$/.test(contract)) return { kind: \"erc20\", contract: contract.toLowerCase() };",""],
  ["native BNB/POL/AVAX/OP-ETH payouts not recognised","if (!contract && (/^nep245:v2_1\\.omni\\.hot\\.tg:\\d+_1{20}$/.test(assetId) || /^nep141:[a-z]+\\.omdep\\.near$/.test(assetId))) return { kind: \"native\" };",""],
  ["an unrecognised asset settles on any Transfer to the recipient","    return \"confirmed\";\n  }\n  return \"pending\";\n}","    return \"confirmed\";\n  }\n  for (const l of Array.isArray(receipt.logs) ? receipt.logs : []) if (Array.isArray(l?.topics) && lc(l.topics[0]) === TRANSFER && lc(l.topics[2]).slice(-40) === rcpt.slice(2)) return \"confirmed\";\n  return \"pending\";\n}"],
  ["an SPL payout with no mint settles on \"the recipient was touched\"","if (!mint) return \"pending\";","if (!mint) return \"confirmed\";"],
  ["destinations whose payout cannot be checked are offered","if (CHAINS[built.to.chain]?.family === \"evm\" && !evmAssetOf(built.to.id, built.to.contract) ||","if (false && CHAINS[built.to.chain]?.family === \"evm\" && !evmAssetOf(built.to.id, built.to.contract) ||"],
  ["the member's own polls use up the verification grace","if (actor === \"reconciler\") patch.verify_attempts","patch.verify_attempts"],
  ["a NOT-paid close-out shows the member \"Done\"","bind(outcome === \"paid\" ? \"settled\" : \"failed\", now, now, id)","bind(\"settled\", now, now, id)"],
  // round 23
  ["a native payout with unreadable balances counts as confirmed","if (before === null || after === null) return \"pending\";","if (before === null || after === null) return \"confirmed\";"],
  ["a native payout with no balance rise counts as confirmed","if (d <= 0n) return \"pending\";","if (d <= 0n) return \"confirmed\";"],
  ["a native receipt with no block number counts as confirmed","if (!okBlock) v = \"pending\";",""],
  ["native destinations stored without the native marker (live list decides)","to_contract: to.contract ?? \"native\",","to_contract: to.contract ?? null,"],
  ["bep20/erc20/omdep ids not held to their own contract","if (named && (!contract || contract.toLowerCase() !== named[1].toLowerCase())) continue;",""],
  ["1cs SPL ids not held to their own mint","if (spl && contract !== spl[1]) continue;",""],
  // round 24
  ["a native balance rise below the guaranteed amount settles","return d >= minOut ? \"verified\" : \"pending\";","return d >= minOut ? \"verified\" : \"confirmed\";"],
  ["an ERC-20 self-transfer proves a payout","if (lc(l.topics[1]) === \"0x\" + \"0\".repeat(24) + rcpt.slice(2)) continue;",""],
  ["a native tx the recipient sent itself proves a payout","if (tx && lc(tx.from) === rcpt) return \"pending\";",""],
  ["Solana native with unreadable balances settles","if (pre === null || post2 === null) return \"pending\";","if (pre === null || post2 === null) return \"confirmed\";"],
  ["a Bitcoin tx the recipient funded (its change) proves a payout","if ((Array.isArray(tx.vin) ? tx.vin : []).some((i) => same(i?.prevout?.scriptpubkey_address))) return \"pending\";",""],
  ["a receipt for a different tx counts","if (receipt && lc(receipt.transactionHash) !== lc(h)) receipt = null;",""],
  ["a payout too shallow to be final counts","if (head === null || head - BigInt(receipt.blockNumber) < BigInt(CONFIRMATIONS[toChain] ?? 12)) v = \"pending\";",""],
  // round 25
  ["a tx object for another tx (or another block) is believed","if (tx && (lc(tx.hash) !== lc(h) || !isHex(tx.blockNumber) || !okBlock || BigInt(tx.blockNumber) !== BigInt(receipt.blockNumber))) tx = null;",""],
  ["a payout whose tx (and so its sender) cannot be read is judged anyway","let v = kind && receipt?.status === \"0x1\" && !tx ? \"pending\" :","let v = false ? \"pending\" :"],
  ["Solana: a tx the recipient signed proves a payout","if (raw.some((k) => k?.pubkey === recipient && k?.signer !== false)) return \"pending\";",""],
  ["Solana: a key list without signer marks is trusted","if (raw.some((k) => typeof k === \"string\")) return \"pending\";",""],
  ["Solana: no balance rise reads as an under-delivery alarm","if (post2 - pre <= 0n) return \"pending\";",""],
  ["Bitcoin: one confirmation is enough","tip - height + 1 < CONFIRMATIONS.btc) return \"pending\";","tip - height + 1 < 1) return \"pending\";"],
  ["a payout tx named twice is counted twice","if (seen.has(k)) return false;",""],
  ["a split payout is never summed (false under-delivery alarm)","if (parts.length > 1 && total >= minOut) {","if (false) {"],
  ["the unverified alarm ignores the destination chain's grace"," && now - (row.state_at ?? row.updated_at) > (VERIFY_GRACE_MS[row.to_chain ?? \"\"] ?? VERIFY_GRACE_DEFAULT_MS))",""],   // round 30: the flag name is chosen on the next line
  ["an unchecked payout chain is not disclosed before payment","decision.warn.push(\"payout_unchecked\");",""],
  // round 26
  ["native balances read from publicnode (it forgets the block within ~127 blocks)","node = STATE_RPC[toChain] ?? evm;","node = evm;"],
  ["the payout block is read by number, not by its hash","[\"eth_getBalance\", [recipient, { blockHash }]],","[\"eth_getBalance\", [recipient, \"0x\" + bn.toString(16)]],"],   // round 31: now inside the batch
  ["a not-yet-ready part of a split payout lets the other read short (route paused)","if (got.some((g) => g.verdict === \"pending\")) return { verdict: \"pending\", hash: null, proofs: proved };",""],
  // round 27
  ["NEAR: a tx-status answer for another tx is believed","|| !res.transaction || res.transaction.hash !== hash) return \"pending\";","|| !res.transaction) return \"pending\";"],
  ["NEAR: a payout not yet FINAL counts","if (res.final_execution_status !== \"FINAL\") return \"pending\";",""],
  ["NEAR: the contract frozen at issue is ignored","if (!token || contract && contract !== token) return \"pending\";","if (!token) return \"pending\";"],
  ["NEAR: a receipt not sent by intents.near counts","if (!r || r.predecessor_id !== INTENTS || typeof o.id !== \"string\") continue;","if (!r || typeof o.id !== \"string\") continue;"],
  ["NEAR: an ft_transfer event from a look-alike contract counts","if (ex === token && r.receiver_id === token) {","if (r.receiver_id === token || ex !== recipient) {"],
  ["NEAR: a failed token transfer is not an alarm","return failed ? \"failed\" : \"pending\";","return \"pending\";"],
  ["NEAR: payouts are not checked at all (back to 1Click's word)","toChain !== \"btc\" && toChain !== \"near\") return { verdict: \"unverifiable\"","toChain !== \"btc\") return { verdict: \"unverifiable\""],
  ["NEAR: a block answer for another block dates the payout","const ns = blk?.header?.hash === bh ? blk?.header?.timestamp_nanosec : null;","const ns = blk?.header?.timestamp_nanosec;"],
  ["NEAR: payouts named only in nearTxHashes are never seen","const nearExtra = row.to_chain === \"near\" && Array.isArray(s.nearTxs)","const nearExtra = false && Array.isArray(s.nearTxs)"],
  ["NEAR: tx-level payout ownership applied (a shared batch tx raises a false alarm)","const feedTxs = nearDest ? [] :","const feedTxs = false ? [] :"],
  ["intents.near accepted as a recipient","\"registrar\", \"intents.near\", \"wrap.near\"]","\"registrar\"]"],
  ["NEAR still disclosed as unchecked","to.chain !== \"btc\" && to.chain !== \"near\") decision.warn.push(\"payout_unchecked\");","to.chain !== \"btc\") decision.warn.push(\"payout_unchecked\");"],
  ["proof: a non-canonical signature spelling verifies","return b64u(out) === s ? out : null;","return out;"],
  ["proof: issued before the swap is settled","if (row.state !== \"settled\") return null;",""],
  ["proof: issued for a swap with no recognised check","if (!check) return null;",""],
  ["proof: anyone gets a proof without the swap token","if (!UUID2.test(id) || !await tokenOk(secret, id, presentedToken(ctx.request))) return notFound2();","if (!UUID2.test(id)) return notFound2();"],
  ["proof: every proof checks as valid","const valid = await checkProof(secret, p?.payload, p?.sig);","const valid = true;"],
  // round 28
  ["one payout may settle many swaps","const free = cands.find((k) => !taken.has(k)) ?? null;","const free = cands[0] ?? null;"],   // re-anchored round 33
  ["only the first settle candidate is tried","const cands = [res.hash, ...res.alts || []].slice(0, 20);","const cands = [res.hash];"],
  ["NEAR: the largest receipt is offered first (a batch steals the other swap's receipt)",".sort((a, b) => a.paid < b.paid ? -1 : a.paid > b.paid ? 1 : 0).map((p) => p.key).slice(0, 20);",".sort((a, b) => a.paid < b.paid ? 1 : a.paid > b.paid ? -1 : 0).map((p) => p.key).slice(0, 20);"],
  ["NEAR: only 3 receipts are offered (the 4th swap in a batch never settles)",".sort((a, b) => a.paid < b.paid ? -1 : a.paid > b.paid ? 1 : 0).map((p) => p.key).slice(0, 20);",".sort((a, b) => a.paid < b.paid ? -1 : a.paid > b.paid ? 1 : 0).map((p) => p.key).slice(0, 3);"],
  ["NEAR: the recipient's own withdrawals count as payouts","own: d.account_id === recipient || typeof d.account_id !== \"string\",","own: false,"],
  ["NEAR: a receipt ambiguous with the recipient's own withdrawal counts","if (events.some((ev2) => ev2.own && fits(ev2))) return null;",""],
  ["NEAR: one withdraw event pairs with many receipts (two 60s settle 100)","if (ev) ev.used = true;",""],
  ["NEAR: a receipt pairs with a withdraw event of another amount"," && ev2.amount === amount;",";"],
  ["NEAR: ft_transfer_call counts as a payout","if (!fc || fc.method_name !== \"ft_transfer\" || acts.length > 2","if (!fc || acts.length > 2"],
  ["NEAR: the transfer's arguments are not checked against the event","&& d?.amount === args.amount));","));"],
  ["NEAR: an ft_transfer not from intents.near counts","list(e.data).some((d) => d?.old_owner_id === INTENTS && d?.new_owner_id === recipient","list(e.data).some((d) => d?.new_owner_id === recipient"],
  ["NEAR: a token receipt that only hands off counts as finished","if (!(st && typeof st === \"object\" && \"SuccessValue\" in st)) {","if (!okStatus(st)) {"],
  ["NEAR: the recipient's own failed withdrawal raises an alarm","\"Failure\" in st && claim(false, amount)) failed = true;","\"Failure\" in st) failed = true;"],
  ["NEAR: a long nearTxHashes list loses its newest txs",".test(h)).slice(-10)",".test(h)).slice(0, 10)"],
  ["proof: a reported proof signs any feed string as the tx","/^(0x)?[0-9a-fA-F]{64}$/.test(d[0].hash) ? d[0].hash : null;","d[0].hash;"],
  // round 29
  ["NEAR: a payout to an account new to the token (storage_deposit + ft_transfer) is refused","const fc = acts[acts.length - 1]?.FunctionCall;","const fc = acts.length === 1 ? acts[0]?.FunctionCall : null;"],
  ["NEAR: a receipt with any number of actions counts","|| acts.length > 2 || acts.length === 2 &&","|| false && acts.length === 2 &&"],
  ["NEAR: any first action is accepted before the ft_transfer","acts[0]?.FunctionCall?.method_name !== \"storage_deposit\") continue;","false) continue;"],
  ["NEAR: two swaps settling at once pause the route (no race guard)","if (nearDest && /UNIQUE/i.test(String(e?.message || e))) {","if (false) {"],
  ["NEAR: candidates come from the first verified tx only","if (toChain === \"near\" && best?.verdict === \"verified\") {","if (false) {"],
  ["proof: the NEAR proof uses the generic \"parts\" text","check === \"onchain\" && row.to_chain === \"near\" ? NEAR_TEXT","false ? NEAR_TEXT"],
  // round 30
  ["native: a forwarded (unreadable-amount) payout pauses the route again","v = before !== null && after !== null && (covered || couldHide) ? \"unproven\" : \"pending\";","v = before !== null && after !== null && covered ? \"unproven\" : \"pending\";"],   // re-anchored round 33
  ["an unproven payout raises the route-pausing alarm","row.dest_verified === \"unproven\" ? \"dest_unproven\" : \"dest_unverified\"","\"dest_unverified\""],
  ["one client network can pause the whole desk","COUNT(DISTINCT COALESCE(s.net, s.id))","COUNT(DISTINCT e.swap_id)"],
  // round 31
  ["native: a plain wallet (no code) can make a non-payment \"unproven\" (silences the alarm)","const couldHide = typeof code === \"string\" && /^0x[0-9a-fA-F]+$/.test(code) && code.length > 2 || big(n0) !== null && big(n1) !== null && big(n0) !== big(n1);","const couldHide = true;"],   // re-anchored round 33
  ["an unproven payout decays into the alarm on a later failed read","if (v === \"pending\" && row.dest_verified === \"unproven\") v = \"unproven\";",""],
  ["an \"unproven\" tx from before the swap is not stale","v !== \"short\" && v !== \"unproven\") return v;","v !== \"short\") return v;"],
  // round 32
  ["native: a wallet that sent in the payout block is still an alarm (cheap route pause)"," || big(n0) !== null && big(n1) !== null && big(n0) !== big(n1);",";"],   // re-anchored round 33
  // round 33
  ["omft native: a contract tx is judged by a balance rise (round 19: settled on another swap's money)","if (/^nep141:(eth|base|arb|gnosis)\\.omft\\.near$/.test(toAsset) || !okBlock || !blockHash) v = \"pending\";","if (!okBlock || !blockHash) v = \"pending\";"],   // re-anchored round 34
  ["a covering balance rise settles a native payout made through a contract","v = before !== null && after !== null && (covered || couldHide) ? \"unproven\" : \"pending\";","v = before !== null && after !== null && covered ? \"verified\" : before !== null && after !== null && couldHide ? \"unproven\" : \"pending\";"],
  // round 34
  ["the reconciler leases every unpaid open address every minute (D1 writes)","now - OPEN_RECHECK_MS, limit)","now + 1e12, limit)"],
  ["Gnosis xDAI judged by a balance rise (not measured as anything but direct)","(eth|base|arb|gnosis)","(eth|base|arb)"],
]

// BASELINE: with no mutation every suite must pass, or the campaign proves nothing.
for (const s of SUITES) {
  try { execFileSync(process.execPath, [fileURLToPath(new URL('./' + s, import.meta.url))], { stdio: 'pipe', timeout: 240000 }) }
  catch { console.log('BASELINE FAILED: ' + s + ' — fix the suite before trusting any kill'); process.exit(2) }
}
console.log('baseline: all ' + SUITES.length + ' suites pass on the real code\n')

const results = []
try {
  // ONLY="fragment|fragment" re-runs just the matching mutants (the baseline always runs).
  const ONLY = (process.env.ONLY || '').split('|').map(s => s.trim().toLowerCase()).filter(Boolean)
  for (const [name, from, to] of MUTANTS) {
    if (ONLY.length && !ONLY.some(o => name.toLowerCase().includes(o))) continue
    const n = SRC.split(from).length - 1
    if (n !== 1) { results.push([name, `NOT APPLIED (pattern found ${n}×)`]); continue }
    fs.writeFileSync(BUNDLE, SRC.replace(from, to))
    const killers = []
    for (const s of SUITES) {
      // fileURLToPath, not URL.pathname: the project path has a space (%20). The first
      // campaign built paths with .pathname, so EVERY suite "failed" and all 17 kills
      // were fake — caught because every mutant was killed by every suite.
      try { execFileSync(process.execPath, [fileURLToPath(new URL('./' + s, import.meta.url))], { stdio: 'pipe', timeout: 240000 }) }
      catch { killers.push(s.replace('intents-', '').replace('.mjs', '')) }
    }
    results.push([name, killers.length ? 'killed by ' + killers.join(', ') : 'SURVIVED'])
    console.log((killers.length ? '  killed   ' : '  SURVIVED ') + name + (killers.length ? '  (' + killers.join(', ') + ')' : ''))
  }
} finally {
  fs.writeFileSync(BUNDLE, SRC)      // always restore the real bundle
}
const survived = results.filter(r => r[1] === 'SURVIVED' || r[1].startsWith('NOT APPLIED'))
console.log(`\n${results.length - survived.length}/${results.length} mutants killed`)
for (const [n, r] of survived) console.log('  ! ' + n + ' — ' + r)
process.exit(survived.length ? 1 : 0)
