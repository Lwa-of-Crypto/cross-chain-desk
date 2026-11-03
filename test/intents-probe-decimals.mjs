// ============================================================
// near-intents-desk — PROBE: the token list's decimals vs each ERC-20's own decimals()
// ============================================================
// The card tells the member "send exactly N", and a connected wallet sends N in base units, both
// using the decimals 1Click lists (frozen at issue). If a listed token's decimals ever disagree
// with its contract, both paths are off by a power of ten. Run before each release; live network
// (1Click's token list + the public RPCs in intents-verify.ts). Exits 1 on any mismatch or error.
//   npm run bundle:test   then   node test/intents-probe-decimals.mjs
// ============================================================
const S = await import(new URL('./.build/sys.mjs', import.meta.url))
const list = await (await fetch(S.lib.ONECLICK_BASE + '/v0/tokens')).json()
const toks = S.lib.slimTokens(list)
const evm = toks.filter(t => S.lib.CHAINS[t.chain]?.family === 'evm')
let same = 0, natives = 0
const bad = []
for (const t of evm) {
  const a = S.verify.evmAssetOf(t.id, t.contract)
  if (!a) { bad.push(`${t.chain} ${t.symbol} ${t.id}: not classified`); continue }
  if (a.kind === 'native') { natives++; if (t.decimals !== 18) bad.push(`${t.chain} ${t.symbol}: native listed with ${t.decimals} decimals`); continue }
  let r
  try {
    r = await (await fetch(S.verify.EVM_RPC[t.chain], { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: a.contract, data: '0x313ce567' }, 'latest'] }) })).json()
  } catch (e) { bad.push(`${t.chain} ${t.symbol}: RPC error ${e.message}`); continue }
  if (typeof r?.result !== 'string' || r.result === '0x') { bad.push(`${t.chain} ${t.symbol}: no decimals() answer ${JSON.stringify(r).slice(0, 100)}`); continue }
  const d = Number(BigInt(r.result))
  if (d === t.decimals) same++; else bad.push(`${t.chain} ${t.symbol} ${a.contract}: list ${t.decimals}, contract ${d}`)
}
console.log(`EVM tokens ${evm.length}: ${same} ERC-20 match their contract, ${natives} natives at 18, ${bad.length} problem(s)`)
for (const b of bad) console.log('  ! ' + b)
process.exit(bad.length ? 1 : 0)
