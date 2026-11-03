// ============================================================
// CRYPTO LWA · cross-chain desk — RED TEAM ROUND 3+ ("keep breaking it", Stan)
// ============================================================
// Load + abuse: every budget that protects 1Click (a partner who can cut us
// off) must hold with an eventually-consistent KV, i.e. it must be atomic in
// D1. Plus lost-update and stampede checks on the status refresh path.
// Every case asserts the SAFE outcome; BROKE = a break.
//
//   npx esbuild intents-entry.ts --bundle --format=esm --platform=neutral --outfile=intents-sys.mjs
//   node intents-redteam3.mjs
// ============================================================
import crypto from 'crypto'
import * as H from './intents-harness.mjs'
const { S, Q, issue, swapGet, call, req, reconcile, freshEnv, row, setRowTime, base, SITE } = H
const W = () => H.getWorld(), ENV = () => H.getEnv()

let pass = 0, fail = 0
const breaks = []
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  safe   ' + name) }
  else { fail++; breaks.push(name); console.log('  BROKE  ' + name + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const section = s => console.log('\n[' + s + ']')
// Worst case for Cloudflare KV across edge locations: no read ever sees a write.
const staleKV = () => { ENV().CLWA_SESSIONS = { get: async () => null, put: async () => {}, delete: async () => {}, _m: new Map() } }

// ═══════════════════════════════════════════════════════════════════════
section('F1 status stampede — many polls of one swap at once')
await freshEnv()
{
  const sw = (await issue()).r.j.swap
  staleKV()
  W().status.set(sw.depositAddress, { status: 'PROCESSING', updatedAt: 'x', swapDetails: {} })
  setRowTime(sw.id, Date.now() - 60e3)
  W().calls.status = 0
  W().statusDelay = 40
  await Promise.all([...Array(40)].map(() => swapGet(sw.id)))
  W().statusDelay = 0
  t(`40 simultaneous polls → 1Click status asked at most twice (got ${W().calls.status})`, W().calls.status <= 2)
  t('…and the update was not lost (state moved to processing)', (await row(sw.id)).state === 'processing')
  W().calls.status = 0
  for (let i = 0; i < 30; i++) await swapGet(sw.id)
  t(`30 rapid sequential polls inside 8 s → 1Click asked at most once more (got ${W().calls.status})`, W().calls.status <= 1)
}

section('F2 preview spam — 1Click dry quotes with a stale KV')
await freshEnv()
{
  staleKV()
  W().calls.quoteDry = 0
  await Promise.all([...Array(120)].map(() => Q({ ...base, dry: true })))
  t(`120 parallel previews from one member → at most 40 reach 1Click in the minute (got ${W().calls.quoteDry})`, W().calls.quoteDry <= 40)
  W().calls.quoteDry = 0
  for (let i = 0; i < 60; i++) await Q({ ...base, dry: true })
  t(`60 more sequential previews in the same minute → none reach 1Click (got ${W().calls.quoteDry})`, W().calls.quoteDry === 0)
  const other = await Q({ ...base, dry: true }, 'other@x.io')
  t('another member is not affected by this member’s budget', other.status === 200)
}

section('F3 tx-hash submit spam with a stale KV')
await freshEnv()
{
  const sw = (await issue()).r.j.swap
  staleKV()
  W().calls.submit = 0
  const sub = () => call(S.submit.onRequestPost, req('POST', '/api/intents/submit', { body: { id: sw.id, txHash: '0x' + crypto.randomBytes(32).toString('hex') } }))
  await Promise.all([...Array(30)].map(sub))
  t(`30 parallel tx-hash submits → at most 6 forwarded to 1Click (got ${W().calls.submit})`, W().calls.submit <= 6)
}

section('F4 status refresh budget per member (many swaps, stale KV)')
await freshEnv()
{
  const ids = []
  for (let i = 0; i < 5; i++) { ENV().CLWA_SESSIONS._m.clear(); if (i) ENV().CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET created_at = created_at - 61000').run(); ids.push((await issue()).r.j.swap.id) }
  staleKV()
  W().calls.status = 0
  for (let round = 0; round < 6; round++) {
    for (const id of ids) setRowTime(id, Date.now() - 60e3)
    await Promise.all(ids.map(id => swapGet(id)))
  }
  t(`30 stale refreshes across 5 swaps in a minute → at most 12 reach 1Click (got ${W().calls.status})`, W().calls.status <= 12)
}

section('F5 the reconciler still works when members are over budget')
await freshEnv()
{
  const sw = (await issue()).r.j.swap
  staleKV()
  for (let i = 0; i < 30; i++) { setRowTime(sw.id, Date.now() - 60e3); await swapGet(sw.id) }
  W().status.set(sw.depositAddress, { status: 'KNOWN_DEPOSIT_TX', updatedAt: 'x', swapDetails: {} })
  setRowTime(sw.id, Date.now() - 6 * 60e3)   // round 34: the reconciler re-checks an unpaid open address after 5 min
  await reconcile()
  t('member budget exhausted → the reconciler still moves the swap forward', (await row(sw.id)).state === 'deposit_seen', (await row(sw.id)).state)
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) { console.log('\nBREAKS:'); for (const b of breaks) console.log('  - ' + b) }
process.exit(fail ? 1 : 0)
