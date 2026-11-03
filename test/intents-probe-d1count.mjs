// PROBE (not a pass/fail suite): how many D1 statements does each request make?
// Cloudflare limits D1 to 50 queries per Worker invocation on the Free plan
// (1,000 on Paid) — developers.cloudflare.com/d1/platform/limits, read.
// Every statement inside a batch is counted separately (the conservative reading).
import crypto from 'crypto'
import * as H from './intents-harness.mjs'
const { S, Q, issue, swapGet, freshEnv, base } = H
const W = () => H.getWorld(), ENV = () => H.getEnv()

function counted(db) {
  let n = 0
  const wrapStmt = s => ({
    bind: (...a) => wrapStmt(s.bind(...a)),
    run: () => { n++; return s.run() }, first: (...a) => { n++; return s.first(...a) }, all: () => { n++; return s.all() },
    _inner: s,
  })
  return {
    prepare: sql => wrapStmt(db.prepare(sql)),
    batch: async list => { n += list.length; return db.batch(list.map(x => x._inner || x)) },
    raw: db.raw, count: () => n, reset: () => { n = 0 },
  }
}
async function measure(label, fn, coldTables = false) {
  if (coldTables) S.ledger.__resetLedger()
  const db = ENV().CLWA_CLUSTERS
  db.reset()
  const out = await fn()
  console.log(`${String(db.count()).padStart(4)}  ${label}${out ? '  → ' + out : ''}`)
  return db.count()
}

await freshEnv()
ENV().CLWA_CLUSTERS = counted(ENV().CLWA_CLUSTERS)
await measure('dry preview (cold isolate: tables created)', async () => (await Q({ ...base, dry: true })).status, true)
await measure('dry preview (warm)', async () => (await Q({ ...base, dry: true })).status)
let sw
await measure('real issue (preview excluded)', async () => {
  const pv = await Q({ ...base, dry: true })
  ENV().CLWA_CLUSTERS.reset()
  const r = await Q({ ...base, dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut })
  sw = r.j.swap; return r.status
})
await measure('swap poll, nothing new upstream', async () => (await swapGet(sw.id)).status)
// a swap that 1Click says delivered: refresh + destination verification path
W().status.set(sw.depositAddress, { status: 'SUCCESS', updatedAt: new Date().toISOString(), swapDetails: { amountIn: sw.amountIn, amountOut: sw.amountOut, destinationChainTxHashes: [] } })
await new Promise(r => setTimeout(r, 5100))
await measure('swap poll, upstream SUCCESS', async () => (await swapGet(sw.id)).status)
for (let i = 0; i < 4; i++) await issue({ amount: String(20 + i) }, 'other@x.io')
await measure('cap refusal (too many open swaps)', async () => {
  const pv = await Q({ ...base, amount: '25', dry: true }, 'other@x.io')
  ENV().CLWA_CLUSTERS.reset()
  return (await Q({ ...base, amount: '25', dry: false, idempotencyKey: crypto.randomUUID(), acceptedAmountOut: pv.j.terms.amountOut }, 'other@x.io')).j?.error
})
await measure('my swaps list', async () => (await swapGet(null, 'other@x.io')).status)

// Worst case for the cron: 25 open swaps, every one moving this pass.
await freshEnv()
ENV().CLWA_CLUSTERS = counted(ENV().CLWA_CLUSTERS)
const ids = []
for (let i = 0; i < 25; i++) {
  const r = await issue({ amount: String(20 + i) }, `u${i}@x.io`)
  if (r.r?.j?.swap) ids.push(r.r.j.swap)
}
for (const s of ids) W().status.set(s.depositAddress, { status: 'PROCESSING', updatedAt: new Date().toISOString(), swapDetails: { amountIn: s.amountIn, depositedAmount: s.amountIn } })
ENV().CLWA_CLUSTERS.raw.prepare('UPDATE intents_swaps SET updated_at = 0').run()
await measure(`reconcile pass over ${ids.length} moving swaps`, async () => JSON.stringify((await H.reconcile()).j).slice(0, 160))
