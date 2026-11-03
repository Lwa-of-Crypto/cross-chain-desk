// ============================================================
// near-intents-desk — RED TEAM ROUND 25: regression suite
// ============================================================
// Round-12 review of payout verification: the recipient's own trades, the tx object a node
// returns, Bitcoin depth, split payouts, public nodes that forget old state (measured
// ~127 blocks on Ethereum/Arbitrum/Optimism/Polygon/Gnosis), the grace before
// "unverified" is an alarm, and saying BEFORE payment when a payout is not checked.
// Every case asserts the SAFE outcome; "BROKE" = a break.
//   node test/intents-redteam13.mjs
// ============================================================
import crypto from 'crypto'
import * as H from './intents-harness.mjs'
const { S, freshEnv, row } = H
const W = () => H.getWorld()
const raw = () => H.getEnv().CLWA_CLUSTERS.raw

let pass = 0, fail = 0
const breaks = []
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  safe   ' + name) }
  else { fail++; breaks.push(name); console.log('  BROKE  ' + name + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const section = s => console.log('\n[' + s + ']')
const V = S.verify
const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad = a => '0x' + '0'.repeat(24) + a.slice(2)
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const POOL = '0x' + '77'.repeat(20), SOLVER = '0x' + '55'.repeat(20), ROUTER = '0x' + '99'.repeat(20)
const hex = n => '0x' + BigInt(n).toString(16)
const xfer = (from, to, v) => ({ status: '0x1', blockNumber: '0x64', logs: [{ address: USDC, topics: [T0, pad(from), pad(to)], data: '0x' + BigInt(v).toString(16).padStart(64, '0') }] })

// ═══════════════════════════════════════════════════════════════════════
section('U1 a payout the recipient made itself proves nothing')
{
  // its own DEX buy: the Transfer comes from the POOL, so only the tx's sender gives it away
  t('ERC-20: the recipient\'s own buy (pool → recipient, sent by the recipient) is not a payout',
    V.judgeEvm(xfer(POOL, H.EVM_ME, 10n ** 9n), { from: H.EVM_ME, to: POOL }, H.USDC_ARB, H.EVM_ME, 1000n) === 'pending')
  t('ERC-20: the same transfer in a solver\'s tx still is', V.judgeEvm(xfer(POOL, H.EVM_ME, 1000n), { from: SOLVER, to: POOL }, H.USDC_ARB, H.EVM_ME, 1000n) === 'verified')
  const sol = (signer, d) => ({ meta: { err: null, preBalances: [5, 100], postBalances: [5, 100 + d] },
    transaction: { message: { accountKeys: [{ pubkey: 'Payer11111111111111111111111111111111111111', signer: true }, { pubkey: H.SOL_ME, signer }] } } })
  t('Solana: a tx the recipient signed (its own sale for SOL) is not a payout', V.judgeSol(sol(true, 10 ** 9), 'nep141:sol.omft.near', H.SOL_ME, 1n) === 'pending')
  t('Solana: a solver\'s tx to it still is', V.judgeSol(sol(false, 1000), 'nep141:sol.omft.near', H.SOL_ME, 1000n) === 'verified')
  t('Solana: a balance that did not rise is no payout at all, not an under-delivery alarm', V.judgeSol(sol(false, -5), 'nep141:sol.omft.near', H.SOL_ME, 1000n) === 'pending')
  t('…a real rise below the minimum still is "short"', V.judgeSol(sol(false, 10), 'nep141:sol.omft.near', H.SOL_ME, 1000n) === 'short')
  const plain = { meta: { err: null, preBalances: [100], postBalances: [5000] }, transaction: { message: { accountKeys: [H.SOL_ME] } } }
  t('Solana: a key list with no signer marks cannot rule the recipient out → unproven', V.judgeSol(plain, 'nep141:sol.omft.near', H.SOL_ME, 1n) === 'pending')
  const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const spl = signer => ({ meta: { err: null, preTokenBalances: [{ owner: H.SOL_ME, mint: MINT, uiTokenAmount: { amount: '0' } }], postTokenBalances: [{ owner: H.SOL_ME, mint: MINT, uiTokenAmount: { amount: '5000' } }] },
    transaction: { message: { accountKeys: [{ pubkey: H.SOL_ME, signer }] } } })
  t('SPL: the recipient\'s own buy of the mint (it signed) is not a payout', V.judgeSol(spl(true), 'x', H.SOL_ME, 1000n, MINT) === 'pending')
  t('SPL: a solver\'s transfer still is', V.judgeSol(spl(false), 'x', H.SOL_ME, 1000n, MINT) === 'verified')
}

// ═══════════════════════════════════════════════════════════════════════
section('U2 Bitcoin payouts must be 2 blocks deep')
{
  const r = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
  const tx = h => ({ status: { confirmed: true, block_height: h }, vin: [], vout: [{ scriptpubkey_address: r, value: 5000 }] })
  t('1 confirmation → not yet', V.judgeBtc(tx(100), r, 5000n, 100) === 'pending')
  t('2 confirmations → verified', V.judgeBtc(tx(100), r, 5000n, 101) === 'verified')
  t('no tip height read → unproven', V.judgeBtc(tx(100), r, 5000n, null) === 'pending')
  t('no block height in the answer → unproven', V.judgeBtc({ ...tx(100), status: { confirmed: true } }, r, 5000n, 500) === 'pending')
}

// A scripted EVM node for the driver: receipts, txs, balances (only within `window` blocks of
// head, like the measured publicnode behaviour), block times.
function node(o) {
  const calls = []
  // round 31: a JSON-RPC batch is answered element by element, in one request
  const f = async (url, init) => {
    const parsed = JSON.parse(init.body)
    if (Array.isArray(parsed)) { const out = []; for (const one of parsed) { const j = await (await f1(url, { body: JSON.stringify(one) })).json(); out.push({ ...j, id: one.id }) } calls.push('batch'); return new Response(JSON.stringify(out)) }
    return f1(url, init)
  }
  const f1 = async (url, init) => {
    const b = JSON.parse(init.body); calls.push(b.method)
    const ok = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
    const h = b.params[0]
    if (b.method === 'eth_getTransactionReceipt') return ok(o.receipts[h] ?? null)
    if (b.method === 'eth_getTransactionByHash') return ok(o.txs[h] ?? null)
    if (b.method === 'eth_blockNumber') return ok(hex(o.head))
    if (b.method === 'eth_getCode') return ok(o.code ?? '0x')     // round 31: a plain wallet unless the case says otherwise
    if (b.method === 'eth_getTransactionCount') return ok(o.nonce ? o.nonce(b.params[1]) : '0x7')     // round 32: idle by default
    if (b.method === 'eth_getBlockByNumber') return ok({ number: h, timestamp: hex(Math.floor(Date.now() / 1000)) })
    if (b.method === 'eth_getBalance') {
      const at = b.params[1]
      if (at && typeof at === 'object' && at.blockHash !== (o.blockHash ?? BH)) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'block not found' } }))
      o.balUrls = (o.balUrls || []).concat(url); o.balAt = (o.balAt || []).concat([at])
      const n = at && typeof at === 'object' ? 0x64 : Number(BigInt(at))
      if (o.head - n > (o.window ?? 127)) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Archive requests require a personal token.' } }))
      return ok(o.bal(n))
    }
    return ok(null)
  }
  return { f, calls }
}
var H1 = '0x' + '11'.repeat(32), H2 = '0x' + '22'.repeat(32), BH = '0x' + 'b1'.repeat(32)

// ═══════════════════════════════════════════════════════════════════════
section('U3 the tx object must be the one asked for, in the receipt\'s block')
{
  const rc = { status: '0x1', blockNumber: '0x64', blockHash: BH, transactionHash: H1, logs: [] }
  const pay = { hash: H1, blockNumber: '0x64', from: SOLVER, to: H.EVM_ME, value: hex(10n ** 18n) }
  const run = tx => V.verifyDestinationDetailed(node({ receipts: { [H1]: rc }, txs: { [H1]: tx }, head: 0x64 + 100, bal: () => '0x0' }).f,
    'arb', H.ETH_ARB, H.EVM_ME, 10n ** 17n, [{ hash: H1 }])
  t('control: the right tx, paying the recipient → verified', (await run(pay)).verdict === 'verified')
  t('a node answering with ANOTHER tx\'s body (to the recipient, with value) is not believed', (await run({ ...pay, hash: H2 })).verdict === 'pending')
  t('…nor a tx from a different block than its receipt', (await run({ ...pay, blockNumber: '0x65' })).verdict === 'pending')
  t('…nor a missing tx (its sender cannot be checked)', (await run(null)).verdict === 'pending')
  const erc = await V.verifyDestinationDetailed(node({ receipts: { [H1]: { ...xfer(POOL, H.EVM_ME, 1000n), blockHash: BH, transactionHash: H1 } }, txs: { [H1]: { hash: H1, blockNumber: '0x64', from: H.EVM_ME } }, head: 0x64 + 100, bal: () => '0x0' }).f,
    'arb', H.USDC_ARB, H.EVM_ME, 1000n, [{ hash: H1 }])
  t('the driver applies the ERC-20 sender rule (recipient\'s own buy → not settled)', erc.verdict === 'pending', erc.verdict)
  // round 25 survivor: with no tx object there is no sender to check, so an ERC-20 transfer must not settle on the receipt alone
  const noTx = await V.verifyDestinationDetailed(node({ receipts: { [H1]: { ...xfer(POOL, H.EVM_ME, 1000n), blockHash: BH, transactionHash: H1 } }, txs: {}, head: 0x64 + 100, bal: () => '0x0' }).f,
    'arb', H.USDC_ARB, H.EVM_ME, 1000n, [{ hash: H1 }])
  t('ERC-20: a node that does not return the tx → unproven (the sender was never checked)', noTx.verdict === 'pending', noTx.verdict)
}

// ═══════════════════════════════════════════════════════════════════════
section('U4 (round 33) a native payout made through a contract is never settled on a balance rise')
{
  const rc = { status: '0x1', blockNumber: '0x64', blockHash: BH, transactionHash: H1, logs: [] }
  const tx = { hash: H1, blockNumber: '0x64', from: SOLVER, to: ROUTER, value: '0x0' }
  const rich = n => (n >= 0x64 ? hex(10n ** 18n) : '0x0')
  const go = (chain, asset, o) => V.verifyDestinationDetailed(node({ receipts: { [H1]: rc }, txs: { [H1]: tx }, head: 0x64 + 100, ...o }).f, chain, asset, H.EVM_ME, 10n ** 17n, [{ hash: H1 }], null, 0, [])
  // omft natives are paid by DIRECT transfer (measured): a tx that does not pay the recipient directly is not a payout
  const omft = await go('arb', H.ETH_ARB, { bal: rich, window: 1e9 })
  t('omft native (ETH on Arbitrum): a contract tx with a big rise in its block → pending (the alarm), never verified', omft.verdict === 'pending', JSON.stringify(omft))
  const om = node({ receipts: { [H1]: rc }, txs: { [H1]: tx }, head: 0x64 + 100, bal: rich })
  await V.verifyDestinationDetailed(om.f, 'arb', H.ETH_ARB, H.EVM_ME, 10n ** 17n, [{ hash: H1 }], null, 0, [])
  t('…and no balance is even read for it', !om.calls.includes('batch'), JSON.stringify(om.calls))
  // HOT natives (not measured): a covering rise is 'unproven' — the money arrived, but not provably THIS payout
  const hot = await go('pol', 'nep245:v2_1.omni.hot.tg:137_11111111111111111111', { bal: rich, window: 1e9 })
  t('HOT native (POL): a covering rise → unproven, NOT verified (round 19: a rise settled a swap on another\'s money)', hot.verdict === 'unproven' && hot.hash === null, JSON.stringify(hot))
  t('…and nothing is remembered as a proof', hot.proofs.length === 0)
  const idle = await go('pol', 'nep245:v2_1.omni.hot.tg:137_11111111111111111111', { bal: () => '0x5', window: 1e9 })
  t('HOT native, plain idle wallet, no rise → pending (the alarm: it cannot hide a payout)', idle.verdict === 'pending', JSON.stringify(idle))
  const coded = await go('pol', 'nep245:v2_1.omni.hot.tg:137_11111111111111111111', { bal: () => '0x5', code: '0x6080604052', window: 1e9 })
  t('…an address WITH code (it can pass coins on) → unproven', coded.verdict === 'unproven', JSON.stringify(coded))
  const sent = await go('pol', 'nep245:v2_1.omni.hot.tg:137_11111111111111111111', { bal: () => '0x5', window: 1e9, nonce: at => (at && typeof at === 'object' ? '0x8' : '0x7') })
  t('…a plain wallet that SENT in that block (nonce moved) → unproven, not the alarm it could trigger at will', sent.verdict === 'unproven', JSON.stringify(sent))
  const gone = await go('pol', 'nep245:v2_1.omni.hot.tg:137_11111111111111111111', { bal: rich, window: 10 })
  t('…balances the node no longer has → pending (unreadable is unproven-by-node, the alarm path)', gone.verdict === 'pending', JSON.stringify(gone))
  const nb = node({ receipts: { [H1]: rc }, txs: { [H1]: tx }, head: 0x64 + 100, bal: rich, window: 1e9 })
  await V.verifyDestinationDetailed(nb.f, 'pol', 'nep245:v2_1.omni.hot.tg:137_11111111111111111111', H.EVM_ME, 10n ** 17n, [{ hash: H1 }], null, 0, [])
  t('balances, code and nonces are read in ONE request', nb.calls.filter(c => c === 'batch').length === 1, JSON.stringify(nb.calls))
  const old = await V.verifyDestinationDetailed(node({ receipts: { [H1]: rc }, txs: { [H1]: tx }, head: 0x64 + 100, bal: rich, window: 1e9 }).f, 'pol', 'nep245:v2_1.omni.hot.tg:137_11111111111111111111', H.EVM_ME, 10n ** 17n, [{ hash: H1 }], null, Math.floor(Date.now() / 1000) + 3600, [])
  t('an "unproven" tx from before the swap → stale (the alarm)', old.verdict === 'stale', JSON.stringify(old))
}

// ═══════════════════════════════════════════════════════════════════════
section('U5 a payout split across txs is summed — once each, own sends excluded')
{
  const r = (h, from = POOL) => ({ ...xfer(from, H.EVM_ME, 600n), blockHash: BH, transactionHash: h })
  const tx = (h, from = SOLVER) => ({ hash: h, blockNumber: '0x64', from })
  const go = (receipts, txs, list) => V.verifyDestinationDetailed(node({ receipts, txs, head: 0x64 + 100, bal: () => '0x0' }).f, 'arb', H.USDC_ARB, H.EVM_ME, 1000n, list)
  const two = await go({ [H1]: r(H1), [H2]: r(H2) }, { [H1]: tx(H1), [H2]: tx(H2) }, [{ hash: H1 }, { hash: H2 }])
  t('two parts of 600 against a 1,000 minimum → verified (it used to read "short" and pause the route)', two.verdict === 'verified', JSON.stringify(two))
  const dup = await go({ [H1]: r(H1) }, { [H1]: tx(H1) }, [{ hash: H1 }, { hash: H1.toUpperCase().replace('0X', '0x') }])
  t('the SAME tx named twice is counted once → short', dup.verdict === 'short', dup.verdict)
  const own = await go({ [H1]: r(H1), [H2]: r(H2) }, { [H1]: tx(H1), [H2]: tx(H2, H.EVM_ME) }, [{ hash: H1 }, { hash: H2 }])
  // round 26: the recipient's own part reads 'pending' (unproven), and a pending part makes the payout
  // wait rather than read 'short'; it still never settles, and the grace alarm (dest_unverified) fires.
  t('a part the recipient sent itself is not added → not settled', own.verdict !== 'verified' && own.verdict !== 'confirmed', own.verdict)
}

// ═══════════════════════════════════════════════════════════════════════
section('U6 the "still unverified" alarm waits for the destination chain')
{
  const now = Date.now()
  const rowAt = (chain, ageMin) => ({ state: 'delivered_claimed', from_chain: 'base', to_chain: chain, updated_at: now, state_at: now - ageMin * 60e3,
    min_amount_out: '1', amount_out_actual: '1', refunded: null, dest_txs: '[{"hash":"x"}]', dest_verified: 'pending', verify_attempts: 12 })
  const has = (r) => S.ledger.reconcileFlags(r, now, null).includes('dest_unverified')
  t('Bitcoin: 12 passes but only 30 min (a payout waiting on 2 blocks) → no alarm', !has(rowAt('btc', 30)))
  t('Bitcoin: 4 h → alarm', has(rowAt('btc', 240)))
  t('Arbitrum: 30 min → alarm (unchanged)', has(rowAt('arb', 30)))
  t('Arbitrum: 12 passes in 12 min → not yet', !has(rowAt('arb', 12)))
}

// ═══════════════════════════════════════════════════════════════════════
section('U7 (round 33) end to end: a BNB payout through a contract is never auto-settled')
await freshEnv()
{
  const sw = (await H.issue({ to: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111', recipient: H.EVM_ME, amount: '100' })).r?.j?.swap
  t('precondition: a BNB swap is issued', !!sw, '')
  if (sw) {
    const X = '0x' + crypto.randomBytes(32).toString('hex')
    W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.minAmountOut, destinationChainTxHashes: [{ hash: X, explorerUrl: 'https://bscscan.com/tx/' + X }] } })
    W().receipts.set(X, { status: '0x1', blockNumber: '0x64', blockHash: BH, logs: [] })
    W().txs = new Map([[X, { from: SOLVER, to: ROUTER, value: '0x0' }]])
    W().balances = n => (n >= 0x64 ? hex(BigInt(sw.minAmountOut) * 2n) : '0x0')
    W().head = 0x64 + 20
    raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
    await H.reconcile()
    const a = await row(sw.id)
    t('a covering rise in the payout block → unproven, NOT settled', a.state === 'delivered_claimed' && a.dest_verified === 'unproven', a.state + ' ' + a.dest_verified)
    raw().prepare("UPDATE intents_swaps SET updated_at = 0, verify_attempts = 12, state_at = ? WHERE id = ?").run(Date.now() - 3600e3, sw.id)
    await H.reconcile()
    const b = await row(sw.id), ctl = (await H.adminGet()).j.controls
    t('after the grace: flagged for the operator (dest_unproven), no route pause', /dest_unproven/.test(b.flags || '') && !Object.keys(ctl.routes || {}).length, b.flags + ' ' + JSON.stringify(ctl.routes))
    W().head = undefined; W().balances = undefined; W().txs = undefined
  }
}

// ═══════════════════════════════════════════════════════════════════════
section('U8 an unchecked destination is disclosed BEFORE payment (NEAR is checked since round 27; Tron is not)')
await freshEnv()
{
  const tron = await H.Q({ ...H.base, to: 'nep141:tron.omft.near', recipient: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', dry: true })
  const txt = (tron.j?.terms?.risk?.text || []).join(' ')
  t('a quote paying out on Tron says the payout is not checked on-chain', tron.status === 200 && /not checked on-chain/.test(txt), tron.status + ' ' + JSON.stringify(tron.j).slice(0, 200))
  const arb = await H.Q({ ...H.base, to: H.USDC_ARB, recipient: H.EVM_ME, dry: true })
  t('a quote paying out on Arbitrum does not', arb.status === 200 && !/not checked on-chain/.test((arb.j?.terms?.risk?.text || []).join(' ')), arb.status + '')
}

// ═══════════════════════════════════════════════════════════════════════
section('U9 (round 26/33) balances come from a node that still has the state, pinned to the block hash')
{
  const rc = { status: '0x1', blockNumber: '0x64', blockHash: BH, transactionHash: H1, logs: [] }
  const tx = { hash: H1, blockNumber: '0x64', from: SOLVER, to: ROUTER, value: '0x0' }
  const o = { receipts: { [H1]: rc }, txs: { [H1]: tx }, head: 0x64 + 100, window: 1e9, bal: n => (n >= 0x64 ? hex(10n ** 18n) : '0x0') }
  await V.verifyDestinationDetailed(node(o).f, 'pol', 'nep245:v2_1.omni.hot.tg:137_11111111111111111111', H.EVM_ME, 10n ** 17n, [{ hash: H1 }], null, 0, [])
  t('Polygon balances are read from the state node (publicnode keeps ~127 blocks)', (o.balUrls || []).length === 2 && o.balUrls.every(u => u === V.STATE_RPC.pol), JSON.stringify(o.balUrls))
  t('the payout block is named by its hash, not its number', (o.balAt || []).some(a => a && a.blockHash === BH), JSON.stringify(o.balAt))
  t('state nodes are set for exactly the chains whose publicnode forgets (eth, arb, op, pol, gnosis)', ['eth', 'arb', 'op', 'pol', 'gnosis'].every(c => V.STATE_RPC[c]) && !V.STATE_RPC.base && !V.STATE_RPC.bsc && !V.STATE_RPC.avax)
}

// ═══════════════════════════════════════════════════════════════════════
section('U10 (round 26) a split payout whose other part is not ready yet waits instead of alarming')
{
  const r = (h, blockNumber = '0x64') => ({ ...xfer(POOL, H.EVM_ME, 600n), blockNumber, blockHash: BH, transactionHash: h })
  const tx = (h, blockNumber = '0x64') => ({ hash: h, blockNumber, from: SOLVER })
  // part 2 is 2 blocks deep (Arbitrum needs 30): 'pending' this pass
  const go = head => V.verifyDestinationDetailed(node({ receipts: { [H1]: r(H1), [H2]: r(H2, hex(head - 2)) }, txs: { [H1]: tx(H1), [H2]: tx(H2, hex(head - 2)) }, head, bal: () => '0x0' }).f,
    'arb', H.USDC_ARB, H.EVM_ME, 1000n, [{ hash: H1 }, { hash: H2 }])
  const now = await go(0x64 + 100)
  t('one deep part of 600 + one shallow part → pending, not "short" (which pauses the route)', now.verdict === 'pending', now.verdict)
  const one = await V.verifyDestinationDetailed(node({ receipts: { [H1]: r(H1) }, txs: { [H1]: tx(H1) }, head: 0x64 + 100, bal: () => '0x0' }).f, 'arb', H.USDC_ARB, H.EVM_ME, 1000n, [{ hash: H1 }])
  t('a single payout below the minimum is still "short" (the alarm)', one.verdict === 'short', one.verdict)
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) console.log('BROKE:\n  - ' + breaks.join('\n  - '))
process.exit(fail ? 1 : 0)
