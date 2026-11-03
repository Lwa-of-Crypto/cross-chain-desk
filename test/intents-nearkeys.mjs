// ============================================================
// CRYPTO LWA · cross-chain desk — the NEAR key checker (nearKeys in lib/intents-io.ts)
// ============================================================
// Who can sign for the NEAR account a payout lands in. Answers are scripted per RPC
// operator, in the shapes mainnet returned when checked live (view_access_key_list,
// view_account, TOO_MANY_ACCESS_KEYS). Every check asserts the SAFE outcome.
//
//   npm run bundle:test   then   node test/intents-nearkeys.mjs
//   LIVE=1 node test/intents-nearkeys.mjs     also asks mainnet itself (network)
// ============================================================
import * as S from './.build/sys.mjs'

let pass = 0, fail = 0
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const J = (o) => JSON.stringify(o)

const PK1 = 'ed25519:njV8oUZbvd1HswZiKL8j7zx2U1wnvaLQiysYDRPMBsF'
const PK2 = 'ed25519:oxEocH88sCavwDRXqoMtryK2Qm9Af72jxMsvsQGHQJx'
const PK3 = 'ed25519:2nwukzu9FrAYbrrBRyHH7XNaJpQcYCoVqZAPeSXEbQJF'
const full = (pk) => ({ access_key: { nonce: 1, permission: 'FullAccess' }, public_key: pk })
const fnKey = (pk) => ({ access_key: { nonce: 1, permission: { FunctionCall: { allowance: null, method_names: [], receiver_id: 'app.near' } } }, public_key: pk })
const keysOk = (keys) => ({ jsonrpc: '2.0', id: 'clwa', result: { block_hash: 'x', block_height: 1, keys } })
const ACCOUNT = { jsonrpc: '2.0', id: 'clwa', result: { amount: '1000', locked: '0', code_hash: '11111111111111111111111111111111' } }
const UNKNOWN = { jsonrpc: '2.0', id: 'clwa', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } }
const TOO_MANY = { jsonrpc: '2.0', id: 'clwa', error: { name: 'HANDLER_ERROR', cause: { name: 'TOO_MANY_ACCESS_KEYS', info: { limit: 100 } } } }

// world: per operator host, what view_access_key_list and view_account answer ('down' = network error)
let W, calls
function world(byHost) {
  W = byHost; calls = []
  S.io.__setFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    const p = JSON.parse(init.body).params
    calls.push(url.hostname + ' ' + p.request_type)
    const w = W[url.hostname] || W['*']
    const a = w && w[p.request_type]
    if (a === undefined || a === 'down') throw new TypeError('down')
    return new Response(typeof a === 'string' ? a : J(a), { headers: { 'content-type': 'application/json' } })
  })
}
const both = (o) => ({ '*': o })

console.log('\n[the keys an account has]')
world(both({ view_access_key_list: keysOk([full(PK1)]) }))
let r = await S.io.nearKeys('alice.near')
t('one full-access key → listed', r && J(r.full) === J([PK1]) && r.limited === 0 && !r.locked && !r.fresh && !r.tooMany, J(r))
t('…fastnear and at least one other operator were asked', calls.includes('free.rpc.fastnear.com view_access_key_list') && new Set(calls.map((c) => c.split(' ')[0])).size >= 2, J(calls))

world(both({ view_access_key_list: keysOk([full(PK1), fnKey(PK2)]) }))
r = await S.io.nearKeys('alice.near')
t('a function-call key is counted as limited, not listed as full access', r && J(r.full) === J([PK1]) && r.limited === 1, J(r))

world(both({ view_access_key_list: keysOk([full(PK1), full(PK2)]) }))
r = await S.io.nearKeys('alice.near')
t('two full-access keys → both listed', r && r.full.length === 2 && r.full.includes(PK1) && r.full.includes(PK2), J(r))

console.log('\n[unknown permissions count as full access (fail safe)]')
for (const [label, perm, isFull] of [
  ['GasKeyFullAccess (nomicon)', { GasKeyFullAccess: { balance: '0' } }, true],
  ['GasKeyFunctionCall (nomicon)', { GasKeyFunctionCall: { receiver_id: 'app.near', method_names: [] } }, false],
  ['a permission name never seen', 'SomethingNew', true],
  ['an object with two kinds', { FunctionCall: {}, FullAccess: {} }, true],
  ['null', null, true],
  ['an array', ['FunctionCall'], true],
]) {
  world(both({ view_access_key_list: keysOk([{ access_key: { nonce: 1, permission: perm }, public_key: PK3 }]) }))
  r = await S.io.nearKeys('alice.near')
  t(label + ' → ' + (isFull ? 'full access' : 'limited'), r && (isFull ? J(r.full) === J([PK3]) : r.full.length === 0 && r.limited === 1), J(r))
}

console.log('\n[two operators must agree]')
world({ 'near.drpc.org': { view_access_key_list: keysOk([full(PK1)]) }, 'free.rpc.fastnear.com': { view_access_key_list: keysOk([full(PK1), full(PK2)]) } })
t('operators disagree on the keys → could not tell (null)', (await S.io.nearKeys('alice.near')) === null)
world({ 'near.drpc.org': { view_access_key_list: keysOk([full(PK1)]) }, 'free.rpc.fastnear.com': { view_access_key_list: keysOk([fnKey(PK1)]) } })
t('operators disagree on a key\'s permission → null', (await S.io.nearKeys('alice.near')) === null)
world({ 'near.drpc.org': { view_access_key_list: keysOk([full(PK1), full(PK2)]) }, 'free.rpc.fastnear.com': { view_access_key_list: keysOk([full(PK2), full(PK1)]) } })
r = await S.io.nearKeys('alice.near')
t('same keys in another order → agreed', r && r.full.length === 2, J(r))
world({ 'near.drpc.org': { view_access_key_list: keysOk([full(PK1)]) }, 'free.rpc.fastnear.com': { view_access_key_list: 'down' } })
t('one operator down → null (one operator alone could show a clean list)', (await S.io.nearKeys('alice.near')) === null)
world({ 'near.drpc.org': { view_access_key_list: keysOk([full(PK1)]) }, 'free.rpc.fastnear.com': { view_access_key_list: '<html>busy</html>' } })
t('one operator answers HTML → null', (await S.io.nearKeys('alice.near')) === null)
world(both({ view_access_key_list: { jsonrpc: '2.0', id: 'clwa', result: { amount: '1' } } }))
t('an answer with no key list → null', (await S.io.nearKeys('alice.near')) === null)

console.log('\n[the second operator: the first of the others that answers]')
// Measured from Cloudflare: free nodes rate-limit Workers, so one second operator is not enough.
const RL = { jsonrpc: '2.0', id: 0, error: { code: 429, message: 'Too many requests' } }
world({ 'rpc.intea.rs': { view_access_key_list: RL }, 'near.drpc.org': { view_access_key_list: keysOk([full(PK1)]) }, 'free.rpc.fastnear.com': { view_access_key_list: keysOk([full(PK1)]) } })
r = await S.io.nearKeys('alice.near')
t('first other operator rate-limited (429) → the next one is the second voice', r && J(r.full) === J([PK1]), J(r))
world({ 'rpc.intea.rs': { view_access_key_list: 'down' }, 'near.drpc.org': { view_access_key_list: keysOk([full(PK1)]) }, 'free.rpc.fastnear.com': { view_access_key_list: keysOk([full(PK1)]) } })
r = await S.io.nearKeys('alice.near')
t('first other operator down → the next one is the second voice', r && J(r.full) === J([PK1]), J(r))
world({ 'rpc.intea.rs': { view_access_key_list: RL }, 'near.drpc.org': { view_access_key_list: 'down' }, 'free.rpc.fastnear.com': { view_access_key_list: keysOk([full(PK1)]) } })
t('every other operator down → null (fastnear alone is never enough)', (await S.io.nearKeys('alice.near')) === null)
world({ 'rpc.intea.rs': { view_access_key_list: keysOk([full(PK1), full(PK2)]) }, 'near.drpc.org': { view_access_key_list: keysOk([full(PK1)]) }, 'free.rpc.fastnear.com': { view_access_key_list: keysOk([full(PK1)]) } })
t('the first other operator that answers disagrees → null (a later one cannot outvote it)', (await S.io.nearKeys('alice.near')) === null)
world({ 'free.rpc.fastnear.com': { view_access_key_list: keysOk([]), view_account: 'down' }, 'rpc.intea.rs': { view_access_key_list: keysOk([]), view_account: ACCOUNT } })
r = await S.io.nearKeys('vault.near')
t('no keys, fastnear cannot say if the account exists → the next operator answers (locked)', r && r.locked === true, J(r))

console.log('\n[malformed answers]')
world(both({ view_access_key_list: keysOk([full('ed25519:<img src=x onerror=alert(1)>')]) }))
t('a key that is not a NEAR public key → null (never shown)', (await S.io.nearKeys('alice.near')) === null)
world(both({ view_access_key_list: keysOk([{ access_key: { nonce: 1, permission: 'FullAccess' } }]) }))
t('a key with no public key → null', (await S.io.nearKeys('alice.near')) === null)
world(both({ view_access_key_list: keysOk(Array.from({ length: 101 }, () => full(PK1))) }))
t('more than 100 keys in a list → null', (await S.io.nearKeys('alice.near')) === null)

console.log('\n[accounts with no keys]')
world(both({ view_access_key_list: keysOk([]), view_account: ACCOUNT }))
r = await S.io.nearKeys('vault.near')
t('no keys, account exists → locked (only its contract can act)', r && r.locked === true && r.fresh === false && r.full.length === 0, J(r))
world(both({ view_access_key_list: keysOk([]), view_account: UNKNOWN }))
r = await S.io.nearKeys('nobody.near')
t('no keys, account does not exist → fresh, not locked (mainnet answers an empty list here)', r && r.fresh === true && r.locked === false, J(r))
world(both({ view_access_key_list: keysOk([]), view_account: ACCOUNT }))
r = await S.io.nearKeys('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')
t('eth-implicit account with no NEAR keys → run by its Ethereum key, never "locked"', r && r.ethImplicit === true && r.locked === false, J(r))
world(both({ view_access_key_list: keysOk([]), view_account: 'down' }))
t('no keys and the account check fails → null', (await S.io.nearKeys('vault.near')) === null)

console.log('\n[too many keys to list]')
world(both({ view_access_key_list: TOO_MANY }))
r = await S.io.nearKeys('near')
t('both operators: more than 100 keys → tooMany', r && r.tooMany === true && r.full.length === 0, J(r))
world({ 'near.drpc.org': { view_access_key_list: TOO_MANY }, 'free.rpc.fastnear.com': { view_access_key_list: keysOk([full(PK1)]) } })
t('only one operator says too many → null', (await S.io.nearKeys('near')) === null)

S.io.__setFetch(null)
if (process.env.LIVE === '1') {
  console.log('\n[LIVE mainnet]')
  r = await S.io.nearKeys('nearhackathon.near')
  t('nearhackathon.near: answered, at least one full-access key', r && r.full.length >= 1 && !r.locked, J(r))
  r = await S.io.nearKeys('wrap.near')
  t('wrap.near: no keys, exists → locked', r && r.locked === true, J(r))
  r = await S.io.nearKeys('near')
  t('near: more than 100 keys → tooMany', r && r.tooMany === true, J(r))
  r = await S.io.nearKeys('zz-not-a-real-account-' + Date.now() + '.near')
  t('an account that does not exist → fresh', r && r.fresh === true, J(r))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
