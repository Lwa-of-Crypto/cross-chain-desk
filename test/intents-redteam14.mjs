// ============================================================
// near-intents-desk — RED TEAM ROUND 27: NEAR payout verification + proof of delivery
// ============================================================
// Built on two REAL NEAR payouts read (test/fixtures/near-payout-*.json):
//   · 8ogx6qnr… — USDT ft_withdraw to mehran229229.tg (its OWN intents balance)
//   · FyHXw6gJ… — wNEAR paid out as native NEAR to e2e-tests-prod.near from another account
// Every case asserts the SAFE outcome; "BROKE" = a break.
//   node test/intents-redteam14.mjs
// ============================================================
import crypto from 'crypto'
import fs from 'fs'
import * as H from './intents-harness.mjs'
const { S, freshEnv, row, call, req } = H
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
const fx = n => JSON.parse(fs.readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8')).result
const USDT_TX = '8ogx6qnrUWfoXUEBWGpSjFqxLFgMp4arkdSEKQxJnkcj', NAT_TX = 'FyHXw6gJa2zTKj3ndmx1UbBv2pJjQC1RAw2iraRqbP8T'
const USDT = 'nep141:usdt.tether-token.near', NAT_AMT = 2034815837715581764571n
const clone = o => JSON.parse(JSON.stringify(o))
/** The real native payout, re-pointed at `to` for `amount` (string-level rewrite of the real tx). */
const nativeTo = (to, amount) => JSON.parse(JSON.stringify(fx('near-payout-native-wnear.json')).split('e2e-tests-prod.near').join(to).split(String(NAT_AMT)).join(String(amount)))
/**
 * One more payout in the same batch, as a real batch carries it (round 28): its own Transfer receipt
 * from intents.near AND its own dip4 native_withdraw event naming whose balance paid.
 */
function addNative(tx, to, amount, id, payer = 'solver-pays-' + id.slice(0, 6) + '.near') {
  const o = tx.receipts_outcome.find(x => x.outcome.executor_id === to && tx.receipts.find(r => r.receipt_id === x.id)?.receipt?.Action?.actions?.[0]?.Transfer)
  const r = tx.receipts.find(x => x.receipt_id === o.id)
  const o2 = clone(o), r2 = clone(r)
  o2.id = r2.receipt_id = id; r2.receipt.Action.actions[0].Transfer.deposit = String(amount)
  tx.receipts_outcome.push(o2); tx.receipts.push(r2)
  const host = tx.receipts_outcome.find(x => x.outcome.executor_id === 'intents.near' && x.outcome.logs.some(l => l.includes('"native_withdraw"')))
  host.outcome.logs.push('EVENT_JSON:' + JSON.stringify({ standard: 'dip4', version: '0.4.3', event: 'native_withdraw', data: [{ intent_hash: 'h' + id, account_id: payer, receiver_id: to, amount: String(amount) }] }))
  return o2.id
}

// ═══════════════════════════════════════════════════════════════════════
section('N1 the real payouts, judged')
{
  const usdt = fx('near-payout-ft-usdt.json'), nat = fx('near-payout-native-wnear.json')
  t('real USDT withdraw of the recipient\'s OWN intents balance → not a payout (pending)', V.judgeNear(usdt, USDT_TX, USDT, 'mehran229229.tg', 1n) === 'pending')
  // the same tx as a 1Click payout would look: the withdrawn balance belongs to another account
  const paid = clone(usdt)
  for (const o of paid.receipts_outcome) o.outcome.logs = o.outcome.logs.map(l => l.replace('"account_id":"mehran229229.tg"', '"account_id":"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd"'))
  const out = { parts: [] }
  t('…paid from another account\'s balance → verified for 59 USDT', V.judgeNear(paid, USDT_TX, USDT, 'mehran229229.tg', 59000000n, 'usdt.tether-token.near', out) === 'verified')
  t('…the payout is the token contract\'s receipt (tx#receipt)', out.parts.length === 1 && out.parts[0].key === USDT_TX + '#AXphjxH2WvcazbLzvThCrGggpE8Qp5KbGyRbATw9cwrY' && out.parts[0].paid === 59000000n, JSON.stringify(out.parts, (k, v) => typeof v === 'bigint' ? String(v) : v))
  t('…one unit more than paid → short', V.judgeNear(paid, USDT_TX, USDT, 'mehran229229.tg', 59000001n) === 'short')
  t('real native wNEAR payout → verified', V.judgeNear(nat, NAT_TX, 'nep141:wrap.near', 'e2e-tests-prod.near', NAT_AMT) === 'verified')
  t('…for someone else → pending', V.judgeNear(nat, NAT_TX, 'nep141:wrap.near', 'alice.near', 1n) === 'pending')
  t('…judged as a USDT payout → pending (wrong asset)', V.judgeNear(nat, NAT_TX, USDT, 'e2e-tests-prod.near', 1n) === 'pending')
  t('…with a different contract frozen at issue → pending', V.judgeNear(paid, USDT_TX, USDT, 'mehran229229.tg', 1n, 'evil-usdt.near') === 'pending')
  t('…a result for ANOTHER tx than the one asked → pending', V.judgeNear(nat, USDT_TX, 'nep141:wrap.near', 'e2e-tests-prod.near', 1n) === 'pending')
  const notFinal = clone(nat); notFinal.final_execution_status = 'EXECUTED_OPTIMISTIC'
  t('…not FINAL yet → pending', V.judgeNear(notFinal, NAT_TX, 'nep141:wrap.near', 'e2e-tests-prod.near', 1n) === 'pending')
  const failed = clone(paid)
  for (const o of failed.receipts_outcome) if (o.outcome.executor_id === 'usdt.tether-token.near') o.outcome.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'not registered' } } } } }
  t('the token transfer receipt FAILED → failed (alarm), not paid', V.judgeNear(failed, USDT_TX, USDT, 'mehran229229.tg', 1n) === 'failed')
  // a look-alike contract logging a perfect ft_transfer event is not the token
  const fake = JSON.parse(JSON.stringify(paid).split('"executor_id":"usdt.tether-token.near"').join('"executor_id":"usdt-tether-token.near"'))
  t('an ft_transfer event logged by another contract does not count', V.judgeNear(fake, USDT_TX, USDT, 'mehran229229.tg', 1n) === 'pending')
  // the receipt must come FROM intents.near
  const relay = clone(paid)
  for (const r of relay.receipts) if (r.receiver_id === 'usdt.tether-token.near') r.predecessor_id = 'solver.near'
  t('a token receipt not sent by intents.near does not count', V.judgeNear(relay, USDT_TX, USDT, 'mehran229229.tg', 1n) === 'pending')
  // a native Transfer from intents.near that is mixed with a function call is not a plain payout
  const mixed = clone(nat)
  for (const r of mixed.receipts) if (r.receiver_id === 'e2e-tests-prod.near') r.receipt.Action.actions.push({ FunctionCall: { method_name: 'x', args: '', gas: 1, deposit: '0' } })
  t('a native receipt that is not Transfer-only does not count', V.judgeNear(mixed, NAT_TX, 'nep141:wrap.near', 'e2e-tests-prod.near', 1n) === 'pending')
  t('garbage shapes → pending, never a throw', [null, 7, {}, { transaction: {} }, { transaction: { hash: NAT_TX }, final_execution_status: 'FINAL', receipts_outcome: 'x', receipts: 5 }]
    .every(g => V.judgeNear(g, NAT_TX, 'nep141:wrap.near', 'e2e-tests-prod.near', 1n) === 'pending'))
  t('asset ids: nep141 and 1cs_v1 NEAR forms parse; EVM forms do not', V.nearTokenOf('nep141:wrap.near') === 'wrap.near' && V.nearTokenOf('1cs_v1:near:nep141:zec.omft.near') === 'zec.omft.near' && V.nearTokenOf('nep245:v2_1.omni.hot.tg:56_x') === null)
}

// A scripted NEAR node for the driver.
function near(txs, blockMs = {}) {
  const calls = []
  const f = async (url, init) => {
    const b = JSON.parse(init.body); calls.push(b.method)
    if (b.method === 'EXPERIMENTAL_tx_status') { const r = txs[b.params.tx_hash]; return new Response(JSON.stringify(r ? { result: r } : { error: { name: 'HANDLER_ERROR' } })) }
    if (b.method === 'block') return new Response(JSON.stringify({ result: { header: { hash: b.params.block_id, timestamp_nanosec: String(BigInt(blockMs[b.params.block_id] ?? Date.now()) * 1000000n) } } }))
    return new Response('{}')
  }
  return { f, calls }
}

// ═══════════════════════════════════════════════════════════════════════
section('N2 the driver: freshness, batches, node trouble')
{
  const nat = fx('near-payout-native-wnear.json'), bh = nat.transaction_outcome.block_hash
  const created = Math.floor(Date.now() / 1000)
  const ok = await V.verifyDestinationDetailed(near({ [NAT_TX]: nat }).f, 'near', 'nep141:wrap.near', 'e2e-tests-prod.near', NAT_AMT, [{ hash: NAT_TX }], 'wrap.near', created - 60)
  t('a fresh real payout → verified, settled on its receipt', ok.verdict === 'verified' && ok.hash === NAT_TX + '#7kNPqLAUV7DtttNRLik5d4ZjJ5zgGfn6cm8ksLnus2V2', JSON.stringify(ok))
  const old = await V.verifyDestinationDetailed(near({ [NAT_TX]: nat }, { [bh]: Date.now() - 86400e3 }).f, 'near', 'nep141:wrap.near', 'e2e-tests-prod.near', NAT_AMT, [{ hash: NAT_TX }], 'wrap.near', created)
  t('the same payout mined a day BEFORE the swap → stale', old.verdict === 'stale', old.verdict)
  const down = await V.verifyDestinationDetailed(async () => { throw new TypeError('down') }, 'near', 'nep141:wrap.near', 'e2e-tests-prod.near', 1n, [{ hash: NAT_TX }])
  t('node down → pending', down.verdict === 'pending')
  const unknown = await V.verifyDestinationDetailed(near({}).f, 'near', 'nep141:wrap.near', 'e2e-tests-prod.near', 1n, [{ hash: NAT_TX }])
  t('unknown tx → pending', unknown.verdict === 'pending')
  // a solver batch: two payouts to the same wallet in one tx
  const two = nativeTo('alice.near', 500n)
  const o = two.receipts_outcome.find(x => x.outcome.executor_id === 'alice.near'), r = two.receipts.find(x => x.receipt_id === o.id)
  const o2 = { id: addNative(two, 'alice.near', 900n, 'R2' + 'x'.repeat(42)) }
  const b = await V.verifyDestinationDetailed(near({ [NAT_TX]: two }).f, 'near', 'nep141:wrap.near', 'alice.near', 400n, [{ hash: NAT_TX }])
  t('a batch paying the same wallet twice offers BOTH receipts, smallest that covers first', b.verdict === 'verified' && b.hash === NAT_TX + '#' + o.id && (b.alts || [])[0] === NAT_TX + '#' + o2.id, JSON.stringify(b))
  const c = await V.verifyDestinationDetailed(near({ [NAT_TX]: two }).f, 'near', 'nep141:wrap.near', 'alice.near', 800n, [{ hash: NAT_TX }])
  t('…a 800 guarantee only the 900 receipt covers', c.verdict === 'verified' && c.hash === NAT_TX + '#' + o2.id && !(c.alts || []).length, JSON.stringify(c))
  const n = near({ [NAT_TX]: nat })
  await V.verifyDestinationDetailed(n.f, 'near', 'nep141:wrap.near', 'e2e-tests-prod.near', NAT_AMT, [{ hash: NAT_TX }, { hash: NAT_TX }, { hash: NAT_TX }], null, created - 60)
  t('the same hash named three times is looked up once (2 calls: tx + block)', n.calls.length === 2, JSON.stringify(n.calls))
}

// ═══════════════════════════════════════════════════════════════════════
section('N3 end to end: two NEAR swaps settled by one solver batch')
await freshEnv()
{
  const a = (await H.issue({ to: H.WNEAR, recipient: 'alice.near', amount: '100' }, '10.140.0.1')).r?.j?.swap
  const b = (await H.issue({ to: H.WNEAR, recipient: 'alice.near', amount: '100' }, '10.140.0.2')).r?.j?.swap
  t('precondition: two wNEAR swaps to alice.near issued', !!a && !!b, '')
  if (a && b) {
    const tx = nativeTo('alice.near', a.minAmountOut)
    const o = tx.receipts_outcome.find(x => x.outcome.executor_id === 'alice.near'), r = tx.receipts.find(x => x.receipt_id === o.id)
    addNative(tx, 'alice.near', b.minAmountOut, 'R2' + 'y'.repeat(42))
    W().nearTx = new Map([[NAT_TX, tx]])
    // 1Click names the payout ONLY in nearTxHashes (no destinationChainTxHashes) for both swaps
    for (const s of [a, b]) W().status.set(s.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: s.minAmountOut, nearTxHashes: ['4tfE8ZS25m5MQ732B7pwzPNeGT78VWqcADF83Ddq55fj', NAT_TX] } })
    raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
    await H.reconcile()
    const ra = await row(a.id), rb = await row(b.id)
    t('both settle, verified on-chain', ra.state === 'settled' && rb.state === 'settled' && ra.dest_verified === 'verified' && rb.dest_verified === 'verified', ra.state + '/' + ra.dest_verified + ' ' + rb.state + '/' + rb.dest_verified)
    t('…each on its OWN receipt (one receipt, one swap)', ra.settled_tx && rb.settled_tx && ra.settled_tx !== rb.settled_tx, ra.settled_tx + ' ' + rb.settled_tx)
    t('…and sharing the batch tx raised no "reused payout" alarm', !/payout_tx_reused/.test((ra.flags || '') + (rb.flags || '')), ra.flags + ' ' + rb.flags)
    t('the payout is shown with our own NEAR explorer link', JSON.parse(ra.dest_txs).some(d => d.hash === NAT_TX && d.explorerUrl === 'https://nearblocks.io/txns/' + NAT_TX), ra.dest_txs)
    t('no route was paused', !Object.keys((await H.adminGet()).j.controls.routes || {}).length)
  }
}

// ═══════════════════════════════════════════════════════════════════════
section('N4 a third NEAR swap cannot settle on a receipt another swap already used')
await freshEnv()
{
  const a = (await H.issue({ to: H.WNEAR, recipient: 'alice.near', amount: '100' }, '10.141.0.1')).r?.j?.swap
  const b = (await H.issue({ to: H.WNEAR, recipient: 'alice.near', amount: '100' }, '10.141.0.2')).r?.j?.swap
  if (a && b) {
    W().nearTx = new Map([[NAT_TX, nativeTo('alice.near', a.minAmountOut)]])     // ONE payout receipt
    for (const s of [a, b]) W().status.set(s.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: s.minAmountOut, nearTxHashes: [NAT_TX] } })
    raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
    await H.reconcile()
    const ra = await row(a.id), rb = await row(b.id)
    const settled = [ra, rb].filter(x => x.state === 'settled')
    t('one payout receipt settles exactly ONE of two swaps paying the same wallet', settled.length === 1, ra.state + ' ' + rb.state)
    t('…the other is flagged, not settled', [ra, rb].some(x => x.state === 'delivered_claimed' && /payout_tx_reused/.test(x.flags || '')), ra.flags + ' | ' + rb.flags)
  } else t('precondition', false)
}

// ═══════════════════════════════════════════════════════════════════════
section('N5 quotes: NEAR is checked, intents.near is no wallet')
await freshEnv()
{
  const q = await H.Q({ ...H.base, to: H.WNEAR, recipient: 'alice.near', dry: true })
  t('a NEAR payout quote no longer says "not checked on-chain"', q.status === 200 && !/not checked on-chain/.test((q.j?.terms?.risk?.text || []).join(' ')), q.status + ' ' + JSON.stringify(q.j).slice(0, 160))
  for (const bad of ['intents.near', 'wrap.near']) {
    const r = await H.Q({ ...H.base, to: H.WNEAR, recipient: bad, dry: true })
    t(`recipient ${bad} is refused`, r.status === 400, r.status + ' ' + JSON.stringify(r.j).slice(0, 120))
  }
}

// ═══════════════════════════════════════════════════════════════════════
section('P1 proof of delivery')
await freshEnv()
{
  const ip = '10.150.0.1'
  const who = null
  const getProof = (id, from = ip) => call(S.proofApi.get, req('GET', '/api/proof?id=' + id, { who, headers: { 'cf-connecting-ip': from } }))
  const verify = (body, from = ip) => call(S.proofApi.verify, req('POST', '/api/proof/verify', { who, body, headers: { 'cf-connecting-ip': from } }))
  // issued AS this IP (no cookie), so the swap token lands in this client's jar
  const asIp = body => call(S.quote.onRequestPost, req('POST', '/api/quote', { body, who: null, headers: { 'cf-connecting-ip': ip } }))
  const pv = await asIp({ ...H.base, to: H.WNEAR, recipient: 'alice.near', amount: '100', dry: true })
  const sw = (await asIp({ ...H.base, to: H.WNEAR, recipient: 'alice.near', amount: '100', dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j?.terms?.amountOut })).j?.swap
  t('precondition: swap issued', !!sw)
  if (sw) {
    const early = await getProof(sw.id)
    t('no proof before the swap is settled (409)', early.status === 409 && early.j?.error === 'not_settled', early.status + ' ' + JSON.stringify(early.j))
    W().nearTx = new Map([[NAT_TX, nativeTo('alice.near', sw.minAmountOut)]])
    W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.minAmountOut, nearTxHashes: [NAT_TX] } })
    raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
    await H.reconcile()
    t('precondition: settled', (await row(sw.id)).state === 'settled')
    const p = await getProof(sw.id)
    t('the member gets a signed proof', p.status === 200 && p.j?.proof?.alg === 'Ed25519' && typeof p.j.proof.sig === 'string', p.status + ' ' + JSON.stringify(p.j).slice(0, 200))
    const facts = JSON.parse(p.j.proof.payload)
    t('it states what was checked: on-chain, the recipient, the guarantee, the payout tx AND receipt',
      facts.check === 'onchain' && facts.to.recipient === 'alice.near' && facts.to.minAmountOut === sw.minAmountOut && facts.payout.tx === NAT_TX && /^.{40,}$/.test(facts.payout.receipt || ''), p.j.proof.payload)
    t('…with our own explorer link', facts.payout.explorer === 'https://nearblocks.io/txns/' + NAT_TX)
    const pj = p.j.proof.payload
    t('it carries no refund address, deposit address or client bucket', !pj.includes(H.EVM_ME) && !pj.includes(sw.depositAddress) && !/"member"|"net"|refund/i.test(pj), pj)
    t('it carries no date or timestamp (owner\'s rule)', !/\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}|\b1\d{12}\b|At"/.test(pj), pj)
    const again = await getProof(sw.id)
    t('the same swap gives the same proof (nothing time-varying is signed)', again.j?.proof?.sig === p.j.proof.sig && again.j.proof.payload === pj)
    const v = await verify({ proof: p.j.proof }, '10.150.9.9')
    t('ANYONE can check it (another client, no token) → valid, with the facts', v.status === 200 && v.j?.valid === true && v.j.facts?.swap === sw.id, JSON.stringify(v.j).slice(0, 160))
    const tampered = await verify({ payload: pj.replace(sw.minAmountOut, sw.minAmountOut + '0'), sig: p.j.proof.sig })
    t('one changed digit in the payload → invalid', tampered.j?.valid === false && tampered.j.facts === null)
    const sig = p.j.proof.sig
    const flip = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)          // a bit of the FIRST byte
    t('a changed signature → invalid', (await verify({ payload: pj, sig: flip })).j?.valid === false)
    // the last character carries 4 unused bits: a second spelling of the SAME bytes is refused too
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', last = B64.indexOf(sig[sig.length - 1])
    const alias = sig.slice(0, -1) + B64[last ^ 1]
    t('a non-canonical spelling of the same signature → invalid', alias !== sig && (await verify({ payload: pj, sig: alias })).j?.valid === false)
    t('junk → invalid, never a 500', (await Promise.all([{}, { payload: 1, sig: 2 }, { payload: pj, sig: '!!' }, { payload: 'x'.repeat(5000), sig: p.j.proof.sig }, []].map(b => verify(b)))).every(r => r.status === 200 && r.j?.valid === false))
    // offline: the published key verifies it with nothing but standard Ed25519
    const k = await call(S.proofApi.key, req('GET', '/api/proof/key', { who }))
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.j.x }, format: 'jwk' })
    t('the published public key verifies it offline (node:crypto, no desk code)', k.j?.kid === p.j.proof.kid && crypto.verify(null, Buffer.from(pj), pub, Buffer.from(p.j.proof.sig, 'base64url')), JSON.stringify(k.j))
    const other = await getProof(sw.id, '10.150.7.7')
    t('a client without the swap token gets 404 (same as an unknown id)', other.status === 404)
    t('an unknown id → 404', (await getProof(crypto.randomUUID())).status === 404)
    // a proof for a desk with ANOTHER secret does not verify here
    const foreign = await S.proof.signProof('another-desk-secret-0123456789abcdef0123456789', pj)
    t('a proof signed by another desk\'s key → invalid', (await verify({ proof: foreign })).j?.valid === false)
  }
}

// ═══════════════════════════════════════════════════════════════════════
section('P2 the proof says honestly what was NOT checked')
{
  const base = { id: crypto.randomUUID(), state: 'settled', from_chain: 'base', to_chain: 'tron', from_asset: H.USDC_BASE, to_asset: 'nep141:tron.omft.near',
    from_symbol: 'USDC', to_symbol: 'TRX', amount_in: '100000000', from_decimals: 6, to_decimals: 6, recipient: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
    min_amount_out: '1000', settled_tx: null, dest_txs: JSON.stringify([{ hash: 'ab'.repeat(32), explorerUrl: 'https://evil.example/x' }]), dest_verified: 'unverifiable', state_at: 1, updated_at: 1 }
  const f = JSON.parse(S.proof.proofPayload(base))
  t('an unverifiable chain → check "reported", and the text says it was not checked', f.check === 'reported' && /not checked on-chain/.test(f.checkText))
  t('…the explorer link is ours, never the feed\'s', f.payout.explorer === 'https://tronscan.org/#/transaction/' + 'ab'.repeat(32))
  t('manual close → check "manual"', JSON.parse(S.proof.proofPayload({ ...base, dest_verified: 'manual' })).check === 'manual')
  t('not settled → no proof', S.proof.proofPayload({ ...base, state: 'delivered_claimed' }) === null)
  t('settled with an unknown verdict → no proof', S.proof.proofPayload({ ...base, dest_verified: 'pending' }) === null)
}

// ═══════════════════════════════════════════════════════════════════════
section('N6 (round 28) each payout receipt is paired with its own withdraw event')
{
  const N = 'nep141:wrap.near'
  // F1: two receipts of 60 to the same wallet must NOT add up to a 100 guarantee
  const t1 = nativeTo('alice.near', 60n); addNative(t1, 'alice.near', 60n, 'Rb' + 'a'.repeat(42))
  t('two 60 payouts in one batch never settle a 100 guarantee (they belong to two swaps)', V.judgeNear(t1, NAT_TX, N, 'alice.near', 100n) === 'short')
  // a receipt with no withdraw event of its own does not count
  const t2 = nativeTo('alice.near', 500n)
  const o = t2.receipts_outcome.find(x => x.outcome.executor_id === 'alice.near'), r = t2.receipts.find(x => x.receipt_id === o.id)
  const o3 = clone(o), r3 = clone(r); o3.id = r3.receipt_id = 'Rc' + 'b'.repeat(42); r3.receipt.Action.actions[0].Transfer.deposit = '900'
  t2.receipts_outcome.push(o3); t2.receipts.push(r3)
  const p2 = { parts: [] }
  V.judgeNear(t2, NAT_TX, N, 'alice.near', 1n, null, p2)
  t('a payout receipt with no withdraw event of its own is not counted', p2.parts.length === 1 && p2.parts[0].paid === 500n, JSON.stringify(p2.parts, (k, v) => typeof v === 'bigint' ? String(v) : v))
  // F3: the recipient's OWN withdrawal in the same batch no longer blocks our payout…
  const t3 = nativeTo('alice.near', 500n); addNative(t3, 'alice.near', 777n, 'Rd' + 'c'.repeat(42), 'alice.near')
  const p3 = { parts: [] }
  t('the recipient\'s own withdrawal in the batch does not block our payout', V.judgeNear(t3, NAT_TX, N, 'alice.near', 500n, null, p3) === 'verified' && p3.parts.length === 1 && p3.parts[0].paid === 500n)
  t('…and its own withdrawal (777) is not counted as a payout', V.judgeNear(t3, NAT_TX, N, 'alice.near', 600n) === 'short')
  // …but one with the SAME amount as ours is ambiguous: neither counts
  const t4 = nativeTo('alice.near', 500n); addNative(t4, 'alice.near', 500n, 'Re' + 'd'.repeat(42), 'alice.near')
  t('an own withdrawal of the same amount makes the receipts ambiguous → not proven', V.judgeNear(t4, NAT_TX, N, 'alice.near', 500n) === 'pending')
  // the recipient's own FAILED withdrawal is not our failed payout
  const t5 = nativeTo('alice.near', 500n); const fid = addNative(t5, 'alice.near', 333n, 'Rf' + 'e'.repeat(42), 'alice.near')
  t5.receipts_outcome.find(x => x.id === fid).outcome.status = { Failure: { ActionError: { index: 0 } } }
  t('the recipient\'s own failed withdrawal is not an alarm on our payout', V.judgeNear(t5, NAT_TX, N, 'alice.near', 500n) === 'verified')
  // ft_transfer_call is not a payout (its amount can be refunded later)
  const usdt = fx('near-payout-ft-usdt.json'), paid = clone(usdt)
  for (const x of paid.receipts_outcome) x.outcome.logs = x.outcome.logs.map(l => l.replace('"account_id":"mehran229229.tg"', '"account_id":"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd"'))
  t('control: the token payout verifies', V.judgeNear(paid, USDT_TX, USDT, 'mehran229229.tg', 59000000n) === 'verified')
  const call = clone(paid)
  for (const x of call.receipts) if (x.receiver_id === 'usdt.tether-token.near') x.receipt.Action.actions[0].FunctionCall.method_name = 'ft_transfer_call'
  t('ft_transfer_call instead of ft_transfer → not counted', V.judgeNear(call, USDT_TX, USDT, 'mehran229229.tg', 1n) === 'pending')
  const argLie = clone(paid)
  for (const x of argLie.receipts) if (x.receiver_id === 'usdt.tether-token.near') x.receipt.Action.actions[0].FunctionCall.args = Buffer.from(JSON.stringify({ receiver_id: 'mehran229229.tg', amount: '99000000' })).toString('base64')
  t('the transfer\'s own arguments and its event must agree on the amount', V.judgeNear(argLie, USDT_TX, USDT, 'mehran229229.tg', 1n) === 'pending')
  const later = clone(paid)
  for (const x of later.receipts_outcome) if (x.outcome.executor_id === 'usdt.tether-token.near') x.outcome.status = { SuccessReceiptId: 'Z'.repeat(44) }
  t('a token receipt that only hands off to another receipt is not a finished payout', V.judgeNear(later, USDT_TX, USDT, 'mehran229229.tg', 1n) === 'pending')
}

section('N7 (round 28) four desk swaps paid in ONE batch all settle')
await freshEnv()
{
  const sws = []
  for (let i = 0; i < 4; i++) { const s = (await H.issue({ to: H.WNEAR, recipient: 'alice.near', amount: '100' }, '10.142.0.' + (i + 1))).r?.j?.swap; if (s) sws.push(s) }
  t('precondition: four swaps issued', sws.length === 4)
  if (sws.length === 4) {
    const tx = nativeTo('alice.near', sws[0].minAmountOut)
    for (let i = 1; i < 4; i++) addNative(tx, 'alice.near', sws[i].minAmountOut, 'R' + i + 'z'.repeat(43))
    W().nearTx = new Map([[NAT_TX, tx]])
    for (const s of sws) W().status.set(s.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: s.minAmountOut, nearTxHashes: [NAT_TX] } })
    raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
    await H.reconcile(); raw().prepare("UPDATE intents_swaps SET updated_at = 0 WHERE state <> 'settled'").run(); await H.reconcile()
    const rows = []; for (const s of sws) rows.push(await row(s.id))
    t('all four settle (the 4th used to be refused: only 3 candidates were tried)', rows.every(x => x.state === 'settled'), rows.map(x => x.state).join(' '))
    t('…on four different receipts', new Set(rows.map(x => x.settled_tx)).size === 4, rows.map(x => x.settled_tx).join(' '))
    t('…with no alarm', rows.every(x => !/payout_tx_reused/.test(x.flags || '')))
  }
}

section('N8 (round 28) a long nearTxHashes list still finds the payout at its end')
{
  const many = Array.from({ length: 14 }, (_, i) => String(i + 1).padStart(2, '1') + 'A'.repeat(42))
  const sl = S.lib.slimStatus({ status: 'SUCCESS', swapDetails: { nearTxHashes: [...many, NAT_TX] } })
  t('the last NEAR tx (where a payout is) is kept', sl.ok && sl.s.nearTxs.includes(NAT_TX) && sl.s.nearTxs.length === 10, JSON.stringify(sl.s && sl.s.nearTxs))
}

section('N9 (round 28) a "reported" proof never signs feed bytes that are not a tx hash')
{
  const r = { id: crypto.randomUUID(), state: 'settled', from_chain: 'base', to_chain: 'tron', from_asset: H.USDC_BASE, to_asset: 'nep141:tron.omft.near', from_symbol: 'USDC', to_symbol: 'TRX',
    amount_in: '1', from_decimals: 6, to_decimals: 6, recipient: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', min_amount_out: '1', settled_tx: null, dest_verified: 'unverifiable', state_at: 1, updated_at: 1,
    dest_txs: JSON.stringify([{ hash: 'see https://evil.example/claim-your-refund', explorerUrl: 'https://evil.example' }]) }
  const f = JSON.parse(S.proof.proofPayload(r))
  t('junk in the feed\'s tx field → no tx and no link in the signed proof', f.payout.tx === null && f.payout.explorer === null, JSON.stringify(f.payout))
}

// ═══════════════════════════════════════════════════════════════════════
section('N10 (round 29) all seven real mainnet NEAR withdrawals verify (read)')
{
  const REAL = [
    ['Gta2AAoorVTGHHazAwGPFhRUf2gcycKJSvQ59ZNjwE1t', 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'domtest1.near', 400129n],
    ['BvumqTD215xwB5aJAutDqx5nv6Goe8SCGdEd75WE8698', 'nep141:usdt.tether-token.near', 'dustclear.near', 1490707321n],
    ['5uK8oVoFDsgYd6SVNyEz6KKM8aPmjrGpYtrPywZ2ZFF6', 'nep141:eth.bridge.near', 'snowinter2000.tg', 13176758418989094n],
    ['7CgijSRRBatAsg12jUSf7jd5aRx2YKkwyHrhaWncoReN', 'nep141:wrap.near', 'e2e-tests-prod.near', 31034100887474124208n],
    ['DDwHEo5uCMVGeMDNt5FuYuKts4QFmQ3xMZ4wA4fa2X85', 'nep141:wrap.near', '112956feb793461100fe8937b5ad4b03ef7a580cdafcd3da5729d05ff4106e92', 4616000000000000000000n],
    ['2jLpv4GEUsjDQHJd7AWTLhMrfd1M6GNpfXBdgxjGUAog', 'nep141:wrap.near', 'irisout.near', 19964186048939952402538530n],
    ['FpVYfZkiXpeAymQ8muxbnBKXtn4YYyDFZumcD6bn1XCG', 'nep141:wrap.near', 'hideon.near', 20489736751356637083993660n],
  ]
  for (const [h, asset, to, amt] of REAL) {
    const res = fx('near-real-' + h + '.json')
    t('real ' + h.slice(0, 8) + ' → verified for exactly its amount', V.judgeNear(res, h, asset, to, amt) === 'verified' && V.judgeNear(res, h, asset, to, amt + 1n) === 'short')
  }
  // DDwHEo5u is a real batch with an ft_transfer_call (mpDAO) to the same recipient: excluded
  const dd = fx('near-real-DDwHEo5uCMVGeMDNt5FuYuKts4QFmQ3xMZ4wA4fa2X85.json'), o = { parts: [] }
  V.judgeNear(dd, 'DDwHEo5uCMVGeMDNt5FuYuKts4QFmQ3xMZ4wA4fa2X85', 'nep141:mpdao-token.near', '112956feb793461100fe8937b5ad4b03ef7a580cdafcd3da5729d05ff4106e92', 1n, null, o)
  t('…its plain mpDAO ft_transfer counts once; its ft_transfer_call does not', o.parts.length === 1 && o.parts[0].paid === 32672n, JSON.stringify(o.parts, (k, v) => typeof v === 'bigint' ? String(v) : v))
}

section('N11 (round 29) a payout to an account new to the token: storage_deposit + ft_transfer in one receipt')
{
  const usdt = fx('near-payout-ft-usdt.json'), paid = clone(usdt)
  for (const x of paid.receipts_outcome) x.outcome.logs = x.outcome.logs.map(l => l.replace('"account_id":"mehran229229.tg"', '"account_id":"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd"'))
  const withAct = (acts) => { const c = clone(paid); for (const x of c.receipts) if (x.receiver_id === 'usdt.tether-token.near') x.receipt.Action.actions = acts(x.receipt.Action.actions); return c }
  const SD = { FunctionCall: { method_name: 'storage_deposit', args: '', gas: 1, deposit: '1250000000000000000000' } }
  t('[storage_deposit, ft_transfer] (intents.near\'s own chaining) → verified', V.judgeNear(withAct(a => [SD, ...a]), USDT_TX, USDT, 'mehran229229.tg', 59000000n) === 'verified')
  t('[ft_transfer, storage_deposit] → not counted', V.judgeNear(withAct(a => [...a, SD]), USDT_TX, USDT, 'mehran229229.tg', 1n) === 'pending')
  const OTHER = { FunctionCall: { method_name: 'ft_transfer', args: '', gas: 1, deposit: '1' } }
  t('[ft_transfer, ft_transfer] (two transfers in one receipt) → not counted', V.judgeNear(withAct(a => [OTHER, ...a]), USDT_TX, USDT, 'mehran229229.tg', 1n) === 'pending')
  t('three actions → not counted', V.judgeNear(withAct(a => [SD, SD, ...a]), USDT_TX, USDT, 'mehran229229.tg', 1n) === 'pending')
}

section('N12 (round 29) candidates come from every verified tx')
{
  // two txs, each paying alice 500 from another account; the swap may take either receipt
  const A = nativeTo('alice.near', 500n), B = JSON.parse(JSON.stringify(nativeTo('alice.near', 500n)).split(NAT_TX).join(USDT_TX))
  const ra = A.receipts_outcome.find(x => x.outcome.executor_id === 'alice.near').id
  const r = await V.verifyDestinationDetailed(near({ [NAT_TX]: A, [USDT_TX]: B }).f, 'near', 'nep141:wrap.near', 'alice.near', 400n, [{ hash: NAT_TX }, { hash: USDT_TX }])
  t('both txs\' receipts are offered (the 2nd tx\'s used to be invisible)', r.verdict === 'verified' && [r.hash, ...(r.alts || [])].length === 2 && [r.hash, ...(r.alts || [])].some(k => k.startsWith(USDT_TX + '#')) && [r.hash, ...(r.alts || [])].includes(NAT_TX + '#' + ra), JSON.stringify(r))
}

section('N13 (round 29) two batch swaps settling at the SAME moment: no false pause')
await freshEnv()
{
  const a = (await H.issue({ to: H.WNEAR, recipient: 'alice.near', amount: '100' }, '10.143.0.1')).r?.j?.swap
  const b = (await H.issue({ to: H.WNEAR, recipient: 'alice.near', amount: '100' }, '10.143.0.2')).r?.j?.swap
  if (a && b) {
    const tx = nativeTo('alice.near', a.minAmountOut); addNative(tx, 'alice.near', b.minAmountOut, 'Rr' + 'q'.repeat(42))
    W().nearTx = new Map([[NAT_TX, tx]])
    for (const s of [a, b]) W().status.set(s.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: s.minAmountOut, nearTxHashes: [NAT_TX] } })
    raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
    const env = H.getEnv(), db = env.DESK_DB || env.CLWA_CLUSTERS
    const ra0 = await row(a.id), rb0 = await row(b.id)
    // both refreshed concurrently: each reads the 'taken' set before the other writes
    await Promise.all([S.io.refreshSwap(S.envOf(env), db, ra0, 'client', Date.now(), true), S.io.refreshSwap(S.envOf(env), db, rb0, 'client', Date.now(), true)])
    const routes = (await H.adminGet()).j.controls.routes || {}
    t('a race for the same receipt pauses no route', !Object.keys(routes).length, JSON.stringify(routes))
    t('…and raises no critical flag', ![await row(a.id), await row(b.id)].some(x => /payout_tx_reused/.test(x.flags || '')))
    raw().prepare("UPDATE intents_swaps SET updated_at = 0 WHERE state <> 'settled'").run()
    await H.reconcile()
    const fa = await row(a.id), fb = await row(b.id)
    t('…and the next pass settles both, on different receipts', fa.state === 'settled' && fb.state === 'settled' && fa.settled_tx !== fb.settled_tx, fa.state + ' ' + fb.state)
  } else t('precondition', false)
}

section('N14 (round 29) the NEAR proof says exactly what was checked')
{
  const r = { id: crypto.randomUUID(), state: 'settled', from_chain: 'base', to_chain: 'near', from_asset: H.USDC_BASE, to_asset: H.WNEAR, from_symbol: 'USDC', to_symbol: 'wNEAR',
    amount_in: '1', from_decimals: 6, to_decimals: 24, recipient: 'alice.near', min_amount_out: '1', settled_tx: NAT_TX + '#7kNPqLAUV7DtttNRLik5d4ZjJ5zgGfn6cm8ksLnus2V2', dest_verified: 'verified', state_at: 1, updated_at: 1, dest_txs: '[]' }
  const f = JSON.parse(S.proof.proofPayload(r))
  t('NEAR proof: one receipt, from intents.near, not the recipient\'s own balance — no talk of parts', /payout receipt/.test(f.checkText) && /not the recipient's own/.test(f.checkText) && !/parts/.test(f.checkText) && f.payout.receipt === '7kNPqLAUV7DtttNRLik5d4ZjJ5zgGfn6cm8ksLnus2V2')
}

// ═══════════════════════════════════════════════════════════════════════
section('N15 (round 29) each NEAR rule on its own (round-28 mutation survivors)')
{
  const usdt = fx('near-payout-ft-usdt.json'), paid = clone(usdt)
  for (const x of paid.receipts_outcome) x.outcome.logs = x.outcome.logs.map(l => l.replace('"account_id":"mehran229229.tg"', '"account_id":"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd"'))
  const tokenLog = (c, fn) => { for (const x of c.receipts_outcome) if (x.outcome.executor_id === 'usdt.tether-token.near') x.outcome.logs = x.outcome.logs.map(fn); return c }
  // the token's own event contradicts the call (it moved another amount): not a payout
  const lie = tokenLog(clone(paid), l => l.replace('"amount":"59000000"', '"amount":"1"'))
  t('the token event moving another amount than the call asked → not counted', V.judgeNear(lie, USDT_TX, USDT, 'mehran229229.tg', 1n) === 'pending')
  // the token event names another sender than intents.near
  const notUs = tokenLog(clone(paid), l => l.replace('"old_owner_id":"intents.near"', '"old_owner_id":"someone.near"'))
  t('a token event whose sender is not intents.near → not counted', V.judgeNear(notUs, USDT_TX, USDT, 'mehran229229.tg', 1n) === 'pending')
  // the recipient's OWN token withdrawal failed: that is not our failed payout
  const ownFail = clone(usdt)
  for (const x of ownFail.receipts_outcome) if (x.outcome.executor_id === 'usdt.tether-token.near') x.outcome.status = { Failure: { ActionError: { index: 0 } } }
  t('the recipient\'s own FAILED token withdrawal is not an alarm (pending, not failed)', V.judgeNear(ownFail, USDT_TX, USDT, 'mehran229229.tg', 1n) === 'pending')
  // one withdraw event, two identical receipts: only one of them is a payout
  const dup = nativeTo('alice.near', 500n)
  const o = dup.receipts_outcome.find(x => x.outcome.executor_id === 'alice.near'), r = dup.receipts.find(x => x.receipt_id === o.id)
  const o2 = clone(o), r2 = clone(r); o2.id = r2.receipt_id = 'Rg' + 'h'.repeat(42); dup.receipts_outcome.push(o2); dup.receipts.push(r2)
  const pd = { parts: [] }
  V.judgeNear(dup, NAT_TX, 'nep141:wrap.near', 'alice.near', 1n, null, pd)
  t('one withdraw event pays ONE receipt (a duplicate receipt is not a second payout)', pd.parts.length === 1, pd.parts.length)
  // a block answer for ANOTHER block cannot date the payout
  const nat = fx('near-payout-native-wnear.json')
  const wrongBlock = async (url, init) => {
    const b = JSON.parse(init.body)
    if (b.method === 'EXPERIMENTAL_tx_status') return new Response(JSON.stringify({ result: nat }))
    return new Response(JSON.stringify({ result: { header: { hash: 'AnotherBlock1111111111111111111111111111111', timestamp_nanosec: String(BigInt(Date.now()) * 1000000n) } } }))
  }
  const wb = await V.verifyDestinationDetailed(wrongBlock, 'near', 'nep141:wrap.near', 'e2e-tests-prod.near', NAT_AMT, [{ hash: NAT_TX }], null, Math.floor(Date.now() / 1000) - 60)
  t('a block answer for another block → the payout time is unknown → pending', wb.verdict === 'pending', wb.verdict)
}

section('N16 (round 29) 1Click names the shared batch tx in destinationChainTxHashes for both swaps')
await freshEnv()
{
  const a = (await H.issue({ to: H.WNEAR, recipient: 'alice.near', amount: '100' }, '10.144.0.1')).r?.j?.swap
  const b = (await H.issue({ to: H.WNEAR, recipient: 'alice.near', amount: '100' }, '10.144.0.2')).r?.j?.swap
  if (a && b) {
    const tx = nativeTo('alice.near', a.minAmountOut); addNative(tx, 'alice.near', b.minAmountOut, 'Rs' + 'w'.repeat(42))
    W().nearTx = new Map([[NAT_TX, tx]])
    for (const s of [a, b]) W().status.set(s.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: s.minAmountOut,
      destinationChainTxHashes: [{ hash: NAT_TX, explorerUrl: 'https://nearblocks.io/txns/' + NAT_TX }] } })
    raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
    await H.reconcile()
    const ra = await row(a.id), rb = await row(b.id)
    t('both settle on their own receipts, and the shared tx raises no "reused payout" alarm',
      ra.state === 'settled' && rb.state === 'settled' && ra.settled_tx !== rb.settled_tx && !/payout_tx_reused/.test((ra.flags || '') + (rb.flags || '')), ra.state + ' ' + rb.state + ' ' + ra.flags + ' ' + rb.flags)
  } else t('precondition', false)
}

// ═══════════════════════════════════════════════════════════════════════
section('R30 a recipient whose code forwards incoming BNB cannot pause the route (HOT native, round 33)')
await freshEnv()
{
  const sw = (await H.issue({ to: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111', recipient: H.EVM_ME, amount: '100' }, '10.145.0.1')).r?.j?.swap
  t('precondition: a BNB swap', !!sw)
  if (sw) {
    const X = '0x' + crypto.randomBytes(32).toString('hex')
    W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.minAmountOut, destinationChainTxHashes: [{ hash: X, explorerUrl: 'https://bscscan.com/tx/' + X }] } })
    // paid through a router; the recipient's code passes the ETH straight on: its balance never rises
    W().receipts.set(X, { status: '0x1', blockNumber: '0x64', blockHash: '0x' + 'b7'.repeat(32), logs: [] })
    W().txs = new Map([[X, { from: '0x' + '55'.repeat(20), to: '0x' + '99'.repeat(20), value: '0x0' }]])
    W().balances = () => '0x5'
    W().head = 0x64 + 5
    // the recipient has code (a forwarding contract / 7702 wallet) — set after quoting, as an attacker would
    W().evmCode = { ...(W().evmCode || {}), [H.EVM_ME.toLowerCase()]: '0x6080604052' }
    raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
    await H.reconcile()
    const a = await row(sw.id)
    t('read balances, no rise → "unproven", not settled', a.state === 'delivered_claimed' && a.dest_verified === 'unproven', a.state + ' ' + a.dest_verified)
    raw().prepare("UPDATE intents_swaps SET updated_at = 0, verify_attempts = 12, state_at = ? WHERE id = ?").run(Date.now() - 3600e3, sw.id)
    await H.reconcile()
    const b = await row(sw.id)
    t('after the grace: flagged for a human (dest_unproven)…', /dest_unproven/.test(b.flags || '') && !/dest_unverified/.test(b.flags || ''), b.flags)
    const ctl = (await H.adminGet()).j.controls
    t('…and NO route or desk pause', !Object.keys(ctl.routes || {}).length && !ctl.globalPaused, JSON.stringify(ctl))
    t('…still never settled', b.state === 'delivered_claimed')
    // round 31: later the node forgets the block (or one read fails): it must NOT decay into the alarm
    const keepHead = W().head; W().head = 0x64 + 100000
    raw().prepare('UPDATE intents_swaps SET updated_at = 0 WHERE id = ?').run(sw.id)
    await H.reconcile()
    const b2 = await row(sw.id), ctl2 = (await H.adminGet()).j.controls
    t('a later failed read keeps it unproven: no route-pausing alarm (round 17)', b2.dest_verified === 'unproven' && !/dest_unverified/.test(b2.flags || '') && !Object.keys(ctl2.routes || {}).length, b2.dest_verified + ' ' + b2.flags)
    W().head = keepHead
    // balances the node cannot read are plain pending (node trouble), still the old alarm
    W().evmCode = {}
    W().balances = undefined
    raw().prepare("UPDATE intents_swaps SET updated_at = 0, dest_verified = NULL, flags = NULL WHERE id = ?").run(sw.id)
    W().head = 0x64 + 1000
    await H.reconcile()
    const c = await row(sw.id)
    t('unreadable balances stay "pending" (and keep the route-pausing alarm)', c.dest_verified === 'pending' && /dest_unverified/.test(c.flags || ''), c.dest_verified + ' ' + c.flags)
    W().head = undefined; W().txs = undefined
  }
}

section('R31 a plain wallet cannot make a payout "unproven"; an old tx is stale')
await freshEnv()
{
  const sw = (await H.issue({ to: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111', recipient: H.EVM_ME, amount: '100' }, '10.146.0.1')).r?.j?.swap
  if (sw) {
    const X = '0x' + crypto.randomBytes(32).toString('hex')
    W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: sw.minAmountOut, destinationChainTxHashes: [{ hash: X, explorerUrl: 'https://bscscan.com/tx/' + X }] } })
    // 1Click names some unrelated successful tx that never paid this plain wallet
    W().receipts.set(X, { status: '0x1', blockNumber: '0x64', blockHash: '0x' + 'b8'.repeat(32), logs: [] })
    W().txs = new Map([[X, { from: '0x' + '55'.repeat(20), to: '0x' + '99'.repeat(20), value: '0x0' }]])
    W().balances = () => '0x5'; W().head = 0x64 + 5
    raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
    await H.reconcile()
    t('no rise to a plain wallet → pending (never the quiet "unproven")', (await row(sw.id)).dest_verified === 'pending', (await row(sw.id)).dest_verified)
    raw().prepare("UPDATE intents_swaps SET updated_at = 0, verify_attempts = 12, state_at = ? WHERE id = ?").run(Date.now() - 3600e3, sw.id)
    await H.reconcile()
    t('…and after the grace it raises the route alarm (dest_unverified)', /dest_unverified/.test((await row(sw.id)).flags || '') && !!(await H.adminGet()).j.controls.routes['base>bsc'])
    W().head = undefined; W().txs = undefined; W().balances = undefined
  } else t('precondition', false)
}
{
  // a contract recipient, but the named tx is from a block long before the swap: stale, not unproven
  const H1 = '0x' + '11'.repeat(32), BH = '0x' + 'b1'.repeat(32), SOLVER = '0x' + '55'.repeat(20), ROUTER = '0x' + '99'.repeat(20), hex = n => '0x' + BigInt(n).toString(16)
  const rc = { status: '0x1', blockNumber: '0x64', blockHash: BH, transactionHash: H1, logs: [] }
  const old = async (url, init) => {
    const one = async b => {
      if (b.method === 'eth_getTransactionReceipt') return rc
      if (b.method === 'eth_getTransactionByHash') return { hash: H1, blockNumber: '0x64', from: SOLVER, to: ROUTER, value: '0x0' }
      if (b.method === 'eth_blockNumber') return hex(0x64 + 50)
      if (b.method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: hex(Math.floor(Date.now() / 1000) - 30 * 86400) }
      if (b.method === 'eth_getBalance') return '0x5'
      if (b.method === 'eth_getCode') return '0x6080'
      return null
    }
    const parsed = JSON.parse(init.body)
    if (Array.isArray(parsed)) return new Response(JSON.stringify(await Promise.all(parsed.map(async b => ({ jsonrpc: '2.0', id: b.id, result: await one(b) })))))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: await one(parsed) }))
  }
  const v = await V.verifyDestinationDetailed(old, 'bsc', 'nep245:v2_1.omni.hot.tg:56_11111111111111111111', H.EVM_ME, 10n ** 17n, [{ hash: H1 }], null, Math.floor(Date.now() / 1000) - 60, [])
  t('an "unproven" tx from a month before the swap → stale (the alarm), not unproven', v.verdict === 'stale', v.verdict)
}

section('R32/R33 a balance rise settles NO swap — two swaps naming txs of one block stay unproven')
await freshEnv()
{
  const a = (await H.issue({ to: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111', recipient: H.EVM_ME, amount: '100' }, '10.147.0.1')).r?.j?.swap
  const b = (await H.issue({ to: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111', recipient: H.EVM_ME, amount: '100' }, '10.147.0.2')).r?.j?.swap
  if (a && b) {
    const X1 = '0x' + crypto.randomBytes(32).toString('hex'), X2 = '0x' + crypto.randomBytes(32).toString('hex'), BLK = '0x' + 'b9'.repeat(32)
    for (const [s, X] of [[a, X1], [b, X2]]) {
      W().status.set(s.depositAddress, { status: 'SUCCESS', updatedAt: 'x', swapDetails: { amountOut: s.minAmountOut, destinationChainTxHashes: [{ hash: X, explorerUrl: 'https://bscscan.com/tx/' + X }] } })
      W().receipts.set(X, { status: '0x1', blockNumber: '0x64', blockHash: BLK, logs: [] })
    }
    W().txs = new Map([[X1, { from: '0x' + '55'.repeat(20), to: '0x' + '99'.repeat(20), value: '0x0' }], [X2, { from: '0x' + '66'.repeat(20), to: '0x' + '99'.repeat(20), value: '0x0' }]])
    W().balances = n => (n >= 0x64 ? '0x' + (BigInt(a.minAmountOut) * 10n).toString(16) : '0x0')
    W().head = 0x64 + 20
    raw().prepare('UPDATE intents_swaps SET updated_at = 0, created_at = created_at - 3600000').run()
    // one verification fits a pass's call budget: run passes until both have been checked
    // (only the not-yet-checked swap is made due again: resetting both kept the first one ahead forever,
    //  which real passes do not — each pass moves the swap it checked to the back of the queue)
    for (let i = 0; i < 4; i++) { await H.reconcile(); raw().prepare("UPDATE intents_swaps SET updated_at = 0 WHERE dest_verified IS NULL AND state <> 'settled'").run() }
    const ra = await row(a.id), rb = await row(b.id)
    t('neither swap settles on the block\'s rise (it cannot be tied to either payout)', ra.state === 'delivered_claimed' && rb.state === 'delivered_claimed', ra.state + ' ' + rb.state)
    t('…both are "unproven" for the operator, not alarms', ra.dest_verified === 'unproven' && rb.dest_verified === 'unproven', JSON.stringify([ra, rb].map(x => [x.state, x.dest_verified, x.verify_attempts, x.dest_txs, x.upstream_status])) + JSON.stringify(raw().prepare('SELECT kind, detail FROM intents_events WHERE swap_id = ?').all(b.id)))
    W().head = undefined; W().txs = undefined; W().balances = undefined
  } else t('precondition', false)
}

section('R34 fewer D1 writes; the direct-payout rule covers exactly the measured chains')
await freshEnv()
{
  const sw = (await H.issue({ to: H.USDC_ARB, recipient: H.EVM_ME, amount: '100' }, '10.148.0.1')).r?.j?.swap
  if (sw) {
    const recent = Date.now() - 60e3
    raw().prepare('UPDATE intents_swaps SET updated_at = ? WHERE id = ?').run(recent, sw.id)
    await H.reconcile()
    t('an unpaid open address checked a minute ago is NOT leased again by the reconciler (no D1 write)', (await row(sw.id)).updated_at === recent, (await row(sw.id)).updated_at - recent)
    const old = Date.now() - 6 * 60e3
    raw().prepare('UPDATE intents_swaps SET updated_at = ? WHERE id = ?').run(old, sw.id)
    await H.reconcile()
    t('…after 5 minutes it is checked again', (await row(sw.id)).updated_at > old)
  } else t('precondition', false)
  // Gnosis xDAI: measured to be paid by direct transfer too, so a contract tx is not a payout (no balance read)
  const H1 = '0x' + '11'.repeat(32), BH = '0x' + 'b1'.repeat(32)
  const calls = []
  const f = async (url, init) => {
    const b = JSON.parse(init.body)
    if (Array.isArray(b)) { calls.push('batch'); return new Response(JSON.stringify(b.map(x => ({ jsonrpc: '2.0', id: x.id, result: '0x' + (10n ** 20n).toString(16) })))) }
    calls.push(b.method)
    const r = b.method === 'eth_getTransactionReceipt' ? { status: '0x1', blockNumber: '0x64', blockHash: BH, transactionHash: H1, logs: [] }
      : b.method === 'eth_getTransactionByHash' ? { hash: H1, blockNumber: '0x64', from: '0x' + '55'.repeat(20), to: '0x' + '99'.repeat(20), value: '0x0' }
      : b.method === 'eth_blockNumber' ? '0x' + (0x64 + 100).toString(16) : null
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: r }))
  }
  const g = await V.verifyDestinationDetailed(f, 'gnosis', 'nep141:gnosis.omft.near', H.EVM_ME, 1n, [{ hash: H1 }], null, 0, [])
  t('Gnosis xDAI via a contract tx → pending (the alarm), no balance read', g.verdict === 'pending' && !calls.includes('batch'), g.verdict + ' ' + JSON.stringify(calls))
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) console.log('BROKE:\n  - ' + breaks.join('\n  - '))
process.exit(fail ? 1 : 0)
