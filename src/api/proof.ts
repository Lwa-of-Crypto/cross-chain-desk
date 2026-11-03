// GET  /api/proof?id=<uuid>   header x-swap-token — the signed proof of delivery of a settled swap
// POST /api/proof/verify {payload, sig} — is this a proof this desk signed? (anyone; no token)
// GET  /api/proof/key         — the desk's public proof key (Ed25519), to check proofs offline
// A proof is built only from the ledger row, so these endpoints are no signing oracle: nothing a
// caller sends is ever signed. Budgets: the "my swaps" class (reads only, no upstream call).
import { ensureTables, getSwap } from '../lib/intents-ledger'
import { json } from '../lib/intents-io'
import { checkProof, proofPayload, publicKey, signProof } from '../lib/intents-proof'
import { deskSecret, tokenOk } from '../identity'
import { guard, presentedToken, readJson, spendAll, type Handler } from './common'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const notFound = () => json({ ok: false, error: 'not_found' }, 404)

export const proofGet: Handler = async (ctx) => {
  const g = await guard(ctx)
  if (!g.ok) return g.response
  const { db, secret, owner, network } = g
  const id = new URL(ctx.request.url).searchParams.get('id') || ''
  if (!UUID.test(id) || !(await tokenOk(secret, id, presentedToken(ctx.request)))) return notFound()
  await ensureTables(db)
  if (!(await spendAll(ctx.env, db, [['l', owner], ['ln', network]]))) return json({ ok: false, error: 'rate_limited' }, 429)
  const row = await getSwap(db, id)
  if (!row || row.state === 'reserving' || row.state === 'abandoned') return notFound()
  const payload = proofPayload(row)
  if (!payload) return json({ ok: false, error: 'not_settled', message: 'A proof of delivery exists only once the swap is settled.' }, 409)
  return json({ ok: true, proof: await signProof(secret, payload) })
}

export const proofVerify: Handler = async (ctx) => {
  const g = await guard(ctx)
  if (!g.ok) return g.response
  const { db, secret, owner, network } = g
  const rb = await readJson(ctx.request, 6144)
  if (!rb.ok) return json({ ok: false, error: rb.error }, rb.status)
  await ensureTables(db)
  if (!(await spendAll(ctx.env, db, [['l', owner], ['ln', network]]))) return json({ ok: false, error: 'rate_limited' }, 429)
  const b: any = rb.value
  const p = b && typeof b === 'object' && b.proof && typeof b.proof === 'object' ? b.proof : b
  const valid = await checkProof(secret, p?.payload, p?.sig)
  let facts: unknown = null
  if (valid) { try { facts = JSON.parse(p.payload) } catch { facts = null } }
  return json({ ok: true, valid, facts })
}

export const proofKey: Handler = async (ctx) => {
  const secret = deskSecret(ctx.env)
  if (!secret) return json({ ok: false, error: 'not_configured' }, 503)
  return json({ ok: true, ...(await publicKey(secret)) }, 200, { 'cache-control': 'public, max-age=3600' })
}
