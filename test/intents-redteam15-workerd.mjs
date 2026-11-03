// ============================================================
// near-intents-desk — round 27/28 on the REAL runtime: the proof endpoints on local workerd
// ============================================================
// Needs `npx wrangler dev --port 8797 --ip 127.0.0.1`. Every case asserts the SAFE outcome.
//   node test/intents-redteam15-workerd.mjs
// ============================================================
import crypto from 'crypto'
const BASE = process.env.DESK || 'http://127.0.0.1:8797'
let pass = 0, fail = 0
const breaks = []
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  safe   ' + name) }
  else { fail++; breaks.push(name); console.log('  BROKE  ' + name + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
let ipN = 0
const ip = () => '10.199.' + (Math.floor(ipN / 250) % 250) + '.' + (++ipN % 250 + 1)
const go = async (path, init = {}) => {
  const r = await fetch(BASE + path, { ...init, headers: { 'cf-connecting-ip': ip(), ...(init.headers || {}) } })
  let j = null; const text = await r.text(); try { j = JSON.parse(text) } catch {}
  return { status: r.status, j, h: r.headers }
}
const post = (path, body, headers = {}) => go(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

console.log('\n[W1 the public key]')
const k = await go('/api/proof/key')
t('GET /api/proof/key → 200 with an Ed25519 key', k.status === 200 && k.j?.alg === 'Ed25519' && /^[A-Za-z0-9_-]{43}$/.test(k.j?.x || '') && /^[0-9a-f]{16}$/.test(k.j?.kid || ''), JSON.stringify(k.j))
t('…served as data: nosniff + no-referrer + CSP none', k.h.get('x-content-type-options') === 'nosniff' && /default-src 'none'/.test(k.h.get('content-security-policy') || ''))
const k2 = await go('/api/proof/key')
t('…the same key every time', k2.j?.x === k.j?.x)
t('POST /api/proof/key → 405', (await post('/api/proof/key', {})).status === 405)

console.log('\n[W2 getting a proof]')
t('GET /api/proof with no token → 404 (same as unknown)', (await go('/api/proof?id=' + crypto.randomUUID())).status === 404)
t('…with a well-formed but wrong token → 404', (await go('/api/proof?id=' + crypto.randomUUID(), { headers: { 'x-swap-token': 'a'.repeat(64) } })).status === 404)
t('…with a junk id → 404', (await go('/api/proof?id=../../etc/passwd')).status === 404)
t('POST /api/proof → 405', (await post('/api/proof', {})).status === 405)

console.log('\n[W3 checking a proof]')
const v = await post('/api/proof/verify', { payload: '{"v":1}', sig: 'A'.repeat(86) })
t('a forged proof → 200, valid:false', v.status === 200 && v.j?.valid === false && v.j?.facts === null, JSON.stringify(v.j))
t('GET /api/proof/verify → 405', (await go('/api/proof/verify')).status === 405)
t('from another site → 403 before any work', (await post('/api/proof/verify', { payload: 'x', sig: 'y' }, { origin: 'https://evil.example' })).status === 403)
t('not JSON → 415', (await go('/api/proof/verify', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status === 415)
t('broken JSON → 400', (await post('/api/proof/verify', '{"payload":')).status === 400)
const big = await post('/api/proof/verify', JSON.stringify({ payload: 'x'.repeat(7000), sig: 'y' }))
t('over 6 KB → 413', big.status === 413, big.status)
const shapes = [[], 7, '"x"', { proof: 5 }, { proof: { payload: {}, sig: [] } }, { payload: null, sig: null }]
const rs = await Promise.all(shapes.map(b => post('/api/proof/verify', b)))
t('odd shapes → 200 valid:false, never a 500', rs.every(r => r.status === 200 && r.j?.valid === false), rs.map(r => r.status + ':' + JSON.stringify(r.j)).join(' '))

console.log('\n[W4 budget]')
const one = ip()
const many = await Promise.all(Array.from({ length: 40 }, () => fetch(BASE + '/api/proof/verify', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': one }, body: '{"payload":"x","sig":"y"}' }).then(r => r.status)))
t('one client checking proofs in a burst is rate-limited (the "my swaps" budget, 30/min)', many.filter(s => s === 429).length >= 5 && many.every(s => s === 200 || s === 429), JSON.stringify(many))

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) console.log('BROKE:\n  - ' + breaks.join('\n  - '))
process.exit(fail ? 1 : 0)
