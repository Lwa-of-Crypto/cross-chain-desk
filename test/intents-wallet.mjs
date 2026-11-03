// ============================================================
// near-intents-desk — WALLET PAYMENT (server side): the `pay` facts a connected wallet may act on
// ============================================================
// The page lets a browser wallet send ONE plain transfer: the swap's amount, to its deposit
// address, on its chain. What it sends is built only from `pay` = { chainId, token|null }, which
// the server derives from facts frozen when the address was issued. Every case asserts the SAFE
// outcome; "BROKE" = a break.
//   node test/intents-wallet.mjs
// ============================================================
import * as H from './intents-harness.mjs'
const { S, freshEnv, row, swapGet } = H
const W = () => H.getWorld()
const raw = () => H.getEnv().CLWA_CLUSTERS.raw

let pass = 0, fail = 0
const breaks = []
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  safe   ' + name) }
  else { fail++; breaks.push(name); console.log('  BROKE  ' + name + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const section = s => console.log('\n[' + s + ']')
const BSC_BNB = 'nep245:v2_1.omni.hot.tg:56_11111111111111111111'
const POL_USDC = 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L'   // contract 0x3c49…3359, from the real list
const USDC_BASE_C = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const J = o => JSON.stringify(o)

// ═══════════════════════════════════════════════════════════════════════
section('W1 chain ids: every EVM chain has the id read from its own RPC; no other chain has one')
{
  // Measured with eth_chainId against each chain's RPC in intents-verify.ts EVM_RPC.
  const MEASURED = { eth: '0x1', base: '0x2105', arb: '0xa4b1', op: '0xa', bsc: '0x38', pol: '0x89', avax: '0xa86a', gnosis: '0x64' }
  const C = S.lib.CHAINS
  const evm = Object.keys(C).filter(k => C[k].family === 'evm')
  t('the 8 EVM chains carry exactly the measured chain ids', evm.length === 8 && evm.every(k => C[k].evmChainId === MEASURED[k]), J(evm.map(k => [k, C[k].evmChainId])))
  t('no non-EVM chain carries one', Object.keys(C).filter(k => C[k].family !== 'evm').every(k => C[k].evmChainId === undefined))
}

// ═══════════════════════════════════════════════════════════════════════
section('W2 what is frozen at issue, and what the page is told')
await freshEnv()
{
  const sw = (await H.issue({})).r.j.swap                                   // Base USDC → SOL
  const r0 = await row(sw.id)
  t('a Base USDC swap freezes from_contract = the USDC contract', (r0.from_contract || '').toLowerCase() === USDC_BASE_C, r0.from_contract)
  t('…and the issue answer says: pay on Base (0x2105) with that token', sw.pay && sw.pay.chainId === '0x2105' && sw.pay.token === USDC_BASE_C, J(sw.pay))
  const g = await swapGet(sw.id)
  const gs = g.j?.swap || (g.j?.swaps || [])[0]
  t('the status answer carries the same pay facts', gs && J(gs.pay) === J(sw.pay), J(g.j).slice(0, 200))
  t('pay carries no date and nothing else', sw.pay && Object.keys(sw.pay).sort().join() === 'chainId,token', J(sw.pay))

  const eth = (await H.issue({ from: H.ETH_ARB, amount: '0.05' })).r?.j?.swap
  t('an Arbitrum ETH swap freezes "native" and pays native on 0xa4b1', eth && (await row(eth.id)).from_contract === 'native' && eth.pay && eth.pay.chainId === '0xa4b1' && eth.pay.token === null, J(eth && eth.pay))

  W().cgPrice.binancecoin = 742.29
  const bnb = (await H.issue({ from: BSC_BNB, amount: '0.2' })).r?.j?.swap
  t('a HOT BNB swap (nep245) pays native on BNB Chain (0x38)', bnb && bnb.pay && bnb.pay.chainId === '0x38' && bnb.pay.token === null, J(bnb && bnb.pay))
  const pol = (await H.issue({ from: POL_USDC, amount: '100' })).r?.j?.swap
  t('a HOT Polygon USDC swap pays its frozen contract on 0x89', pol && pol.pay && pol.pay.chainId === '0x89' && pol.pay.token === '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', J(pol && pol.pay))

  const sol = (await H.issue({ from: H.SOL, to: H.USDC_BASE, recipient: H.EVM_ME, refundTo: H.SOL_ME, amount: '1' })).r?.j?.swap
  t('a Solana deposit gets no wallet payment (pay null)', sol && sol.pay === null, J(sol && sol.pay))
}

// ═══════════════════════════════════════════════════════════════════════
section('W3 never from the live list, never on disagreement')
await freshEnv()
{
  const sw = (await H.issue({})).r.j.swap
  // later the list is poisoned: USDC's asset now claims another contract
  const JUNK = '0x' + 'ab'.repeat(20)
  W().tokensOverride = H.rawTokens.map(x => x.assetId === H.USDC_BASE ? { ...x, contractAddress: JUNK } : x); S.io.__resetTokenCache()
  const g = (await swapGet(sw.id)).j?.swap
  t('a poisoned token list later does not change what the wallet pays', g && g.pay && g.pay.token === USDC_BASE_C, J(g && g.pay))
  W().tokensOverride = null; S.io.__resetTokenCache()

  const set = (col, v) => raw().prepare(`UPDATE intents_swaps SET ${col} = ? WHERE id = ?`).run(v, sw.id)
  const payOf = async () => (await swapGet(sw.id)).j?.swap?.pay
  set('from_contract', null)
  t('a row from before the column (no frozen contract) gets no wallet payment', (await payOf()) === null)
  set('from_contract', JUNK)
  t('a frozen contract that is not the one the asset id names: no wallet payment', (await payOf()) === null)
  set('from_contract', 'native')
  t('"native" frozen for an ERC-20 asset id: no wallet payment', (await payOf()) === null)
  set('from_contract', 'garbage')
  t('a malformed frozen value: no wallet payment', (await payOf()) === null)
  set('from_contract', USDC_BASE_C.toUpperCase().replace('0X', '0x'))
  t('…a frozen contract in other letter case still matches', (await payOf())?.token === USDC_BASE_C)
}

// ═══════════════════════════════════════════════════════════════════════
section('W4 only while the address may be paid')
await freshEnv()
{
  const sw = (await H.issue({})).r.j.swap
  const set = (sql, ...a) => raw().prepare(sql).run(...a, sw.id)
  const payOf = async () => (await swapGet(sw.id)).j?.swap?.pay
  set("UPDATE intents_swaps SET state = 'incomplete_deposit', deposited = '1' WHERE id = ?")
  t('a part-paid swap still offers the wallet (the page sends only the rest)', (await payOf())?.chainId === '0x2105')
  for (const st of ['processing', 'settled', 'refunded', 'failed', 'delivered_claimed']) {
    set('UPDATE intents_swaps SET state = ? WHERE id = ?', st)
    t(`state ${st}: no wallet payment`, (await payOf()) === null)
  }
  set("UPDATE intents_swaps SET state = 'awaiting_deposit', deposited = NULL, deadline = ?, deadline_ms = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), Date.now() - 1000)
  const g = (await swapGet(sw.id)).j?.swap
  t('past its deadline: expired, no address, no wallet payment', g && g.state === 'expired' && g.depositAddress === null && g.pay === null, J({ s: g?.state, p: g?.pay }))
  set("UPDATE intents_swaps SET state = 'awaiting_deposit', deadline = ?, deadline_ms = ?, deposit_address = 'not-an-evm-address' WHERE id = ?", new Date(Date.now() + 3600e3).toISOString(), Date.now() + 3600e3)
  t('a deposit address that is not an EVM address: no wallet payment', (await payOf()) === null)
}

// ═══════════════════════════════════════════════════════════════════════
section('W5 pure payWith')
{
  const P = S.ledger.payWith
  const r = over => ({ state: 'awaiting_deposit', from_chain: 'base', from_asset: H.USDC_BASE, from_contract: USDC_BASE_C, deposit_address: '0x' + '11'.repeat(20), ...over })
  t('a good row', J(P(r({}))) === J({ chainId: '0x2105', token: USDC_BASE_C }))
  t('a chain with no EVM id (sol)', P(r({ from_chain: 'sol' })) === null)
  t('an unknown chain', P(r({ from_chain: 'toString' })) === null)
  t('an asset id that names a DIFFERENT contract than the frozen one', P(r({ from_asset: 'nep141:base-0x' + 'cd'.repeat(20) + '.omft.near' })) === null)
  t('an asset id that is not an EVM token at all (wrap.near), even with a frozen contract', P(r({ from_asset: 'nep141:wrap.near' })) === null)
  t('an Omni id naming another chain (arb USDC on a base row)', P(r({ from_asset: H.USDC_ARB, from_contract: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' })) === null)
  t('a HOT id naming another chain id (56 = BNB on a base row)', P(r({ from_asset: 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r', from_contract: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' })) === null)
  t('…the same HOT id on its own chain is accepted', J(P(r({ from_chain: 'bsc', from_asset: 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r', from_contract: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' }))) === J({ chainId: '0x38', token: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' }))
  t('a 1cs id naming another chain', P(r({ from_asset: '1cs_v1:bsc:bep20:0x' + '12'.repeat(20), from_contract: '0x' + '12'.repeat(20) })) === null)
  const C1 = '0x' + '12'.repeat(20), C2 = '0x' + '34'.repeat(20)
  t('a 1cs id on its chain with its own contract is accepted', J(P(r({ from_asset: '1cs_v1:base:erc20:' + C1, from_contract: C1 }))) === J({ chainId: '0x2105', token: C1 }))
  t('a 1cs id whose contract is not the frozen one', P(r({ from_asset: '1cs_v1:base:erc20:' + C1, from_contract: C2 })) === null)
  t('an omdep id whose contract is not the frozen one', P(r({ from_asset: 'nep141:base-' + C1 + '.omdep.near', from_contract: C2 })) === null)
  t('an omdep id frozen as "native"', P(r({ from_asset: 'nep141:base-' + C1 + '.omdep.near', from_contract: 'native' })) === null)
  t('an omdep id with its own contract is accepted', J(P(r({ from_asset: 'nep141:base-' + C1 + '.omdep.near', from_contract: C1 }))) === J({ chainId: '0x2105', token: C1 }))
}

// ═══════════════════════════════════════════════════════════════════════
section('W6 a ledger created before the column gains it, and its old rows pay nothing')
await freshEnv()
{
  const sw = (await H.issue({})).r.j.swap
  const db = raw()
  const cols = () => db.prepare('PRAGMA table_info(intents_swaps)').all().map(c => c.name)
  db.prepare('ALTER TABLE intents_swaps DROP COLUMN from_contract').run()
  t('precondition: the column is gone (an old ledger)', !cols().includes('from_contract'))
  S.ledger.__resetLedger()                              // a new isolate, an old database
  await S.ledger.ensureTables(H.getEnv().CLWA_CLUSTERS)
  t('ensureTables adds from_contract back to an old ledger', cols().includes('from_contract'), cols().join())
  t('…and the old row (NULL) gets no wallet payment', (await swapGet(sw.id)).j?.swap?.pay === null)
  const sw2 = (await H.issue({ amount: '101' })).r?.j?.swap
  t('…while a swap issued after the upgrade does', sw2 && sw2.pay && sw2.pay.token === USDC_BASE_C, J(sw2 && sw2.pay))
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (fail) { console.log('BROKE:\n  - ' + breaks.join('\n  - ')); process.exit(1) }
