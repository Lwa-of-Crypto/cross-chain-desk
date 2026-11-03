// ============================================================
// near-intents-desk — RED TEAM ROUND 13: the machine level, on the REAL runtime
// ============================================================
// Raw TCP against `wrangler dev` (workerd + local D1), so the bytes on the wire are
// exactly what we choose — no fetch() normalising them first. Every case asserts the
// SAFE outcome; "BROKE" = a break.
//
//   npx wrangler dev --port 8797 --ip 127.0.0.1      (unsandboxed: workerd's SQLite)
//   node test/intents-redteam8-workerd.mjs
//
// Live 1Click is NOT called by this suite: every request here is refused before the
// router, or goes to endpoints that never call it. Nothing is issued.
// ============================================================
import net from 'net'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HOST = '127.0.0.1', PORT = Number(process.env.DESK_PORT || 8797), ORIGIN = `http://${HOST}:${PORT}`
const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const breaks = []
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  safe   ' + name) }
  else { fail++; breaks.push(name); console.log('  BROKE  ' + name + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const section = s => console.log('\n[' + s + ']')

/** Send raw bytes, collect the raw answer (or a timeout marker). */
function raw(bytes, { timeout = 8000, keepOpenMs = 0, chunks = null } = {}) {
  return new Promise(resolve => {
    const sock = net.connect(PORT, HOST)
    let buf = Buffer.alloc(0), done = false
    const t0 = Date.now()
    const finish = (extra = {}) => { if (done) return; done = true; sock.destroy(); resolve({ ...parse(buf), ms: Date.now() - t0, ...extra }) }
    const timer = setTimeout(() => finish({ timedOut: true }), timeout)
    sock.on('data', d => { buf = Buffer.concat([buf, d]); const p = parse(buf); if (p.complete) { clearTimeout(timer); finish() } })
    sock.on('error', e => { clearTimeout(timer); finish({ error: e.code || String(e) }) })
    sock.on('close', () => { clearTimeout(timer); finish({ closed: true }) })
    sock.on('connect', async () => {
      if (chunks) { for (const c of chunks) { if (done) return; if (!sock.write(c)) await new Promise(r => sock.once('drain', r)) } }
      else sock.write(bytes)
      if (keepOpenMs) setTimeout(() => {}, keepOpenMs)
    })
  })
}
function parse(buf) {
  const s = buf.toString('latin1')
  const i = s.indexOf('\r\n\r\n')
  if (i < 0) return { complete: false, status: 0, headers: {}, body: '' }
  const [line, ...hl] = s.slice(0, i).split('\r\n')
  const headers = {}
  for (const h of hl) { const k = h.slice(0, h.indexOf(':')).toLowerCase(); headers[k] = (headers[k] ? headers[k] + ', ' : '') + h.slice(h.indexOf(':') + 1).trim() }
  let body = s.slice(i + 4)
  let complete = false
  if (headers['content-length'] !== undefined) complete = Buffer.byteLength(body, 'latin1') >= Number(headers['content-length'])
  else if (/chunked/i.test(headers['transfer-encoding'] || '')) { complete = body.endsWith('0\r\n\r\n'); body = dechunk(body) }
  return { complete, status: Number(line.split(' ')[1]) || 0, headers, body }
}
function dechunk(b) { let out = '', i = 0; for (;;) { const j = b.indexOf('\r\n', i); if (j < 0) break; const n = parseInt(b.slice(i, j), 16); if (!n) break; out += b.slice(j + 2, j + 2 + n); i = j + 2 + n + 2 } return out }
const req = (method, p, { headers = {}, body = null } = {}) => {
  const h = { host: `${HOST}:${PORT}`, connection: 'close', ...headers }
  if (body !== null && h['content-length'] === undefined && h['transfer-encoding'] === undefined) h['content-length'] = String(Buffer.byteLength(body))
  return Buffer.concat([Buffer.from(`${method} ${p} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n', 'latin1'), body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body)])
}
const jsonOf = r => { try { return JSON.parse(r.body) } catch { return null } }
const alive = async () => (await raw(req('GET', '/api/tokens'), { timeout: 30000 })).status === 200

if (!(await alive())) { console.log(`desk not answering on ${ORIGIN} — start wrangler dev first`); process.exit(2) }

// ═══════════════════════════════════════════════════════════════════════
section('M1 body bombs — the Worker must not buffer what it will refuse')
// A declared-90 MB body is NOT tested here: measured, `wrangler dev`'s local proxy
// holds the whole upload before the Worker sees the request (even /api/admin, which refuses
// before reading, hung). That case is tested straight against worker.fetch in redteam9 R10.
{
  // Chunked, no Content-Length: 24 MB of spaces. Must be cut off at the cap, not read whole.
  const chunk = Buffer.alloc(256 * 1024, 0x20)
  const head = Buffer.from(`POST /api/quote HTTP/1.1\r\nhost: ${HOST}:${PORT}\r\nconnection: close\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n`)
  const parts = [head]
  for (let i = 0; i < 96; i++) parts.push(Buffer.from(chunk.length.toString(16) + '\r\n'), chunk, Buffer.from('\r\n'))
  parts.push(Buffer.from('0\r\n\r\n'))
  const t0 = Date.now()
  const r = await raw(null, { chunks: parts, timeout: 20000 })
  t('chunked 24 MB with no Content-Length → 413 (streamed with a byte cap)', r.status === 413, JSON.stringify({ status: r.status, ms: Date.now() - t0, body: r.body.slice(0, 120) }))
}
{
  // 4,000 four-byte characters = 4,000 UTF-16 units but 16,000 bytes: the cap is in BYTES.
  const emoji = '\u{1F600}'.repeat(1100)
  const body = JSON.stringify({ dry: true, from: emoji, to: 'x', amount: '1', recipient: 'x', refundTo: 'x' })
  const r = await raw(req('POST', '/api/quote', { headers: { 'content-type': 'application/json' }, body }))
  t(`a ${Buffer.byteLength(body)}-byte body made of 4-byte characters is over the 4 KB cap`, r.status === 413, r.status + ' ' + r.body.slice(0, 100))
}
t('the desk still answers after the body bombs', await alive())

// ═══════════════════════════════════════════════════════════════════════
section('M2 paths: no spelling of a path reaches a door it should not')
for (const p of ['/api/admin/', '/api//admin', '/api/%61dmin', '/API/admin', '/api/./admin', '/api/admin%00', '/api/admin;x', '/api/admin%2f', '/api/x/../admin', '/api/admin?x-admin-token=' + 'a'.repeat(40)]) {
  const r = await raw(req('GET', p))
  const j = jsonOf(r)
  t(`GET ${p.slice(0, 40)} → not the admin API`, r.status === 404 || (r.status === 200 && !j), r.status + ' ' + r.body.slice(0, 80))
}
for (const p of ['/.dev.vars', '/../.dev.vars', '/%2e%2e/.dev.vars', '/..%2f.dev.vars', '/wrangler.jsonc', '/src/worker.ts', '/package.json', '/.git/config', '/test/entry.ts', '/node_modules/wrangler/package.json']) {
  const r = await raw(req('GET', p))
  t(`GET ${p} serves no project file`, !/DESK_SECRET|ADMIN_TOKEN|compatibility_date|import |"devDependencies"|\[core\]/.test(r.body), r.status + ' ' + r.body.slice(0, 80))
}
{
  const r = await raw(req('GET', '/does-not-exist'))
  t('an unknown page still carries the page CSP', /default-src 'none'/.test(r.headers['content-security-policy'] || ''), JSON.stringify(r.headers))
  const r2 = await raw(req('GET', '/vendor/qrcode.min.js'))
  t('static scripts carry nosniff', r2.headers['x-content-type-options'] === 'nosniff')
}

// ═══════════════════════════════════════════════════════════════════════
section('M3 methods')
for (const [m, p, ok] of [['OPTIONS', '/api/quote', [405]], ['PUT', '/api/quote', [405]], ['DELETE', '/api/admin', [404, 405]], ['PATCH', '/api/swap', [405]], ['TRACE', '/api/tokens', [405, 400]], ['post', '/api/quote', [405, 400, 403, 415, 501]], ['HEAD', '/api/quote', [405]], ['GET', '/api/quote', [405]]]) {
  const r = await raw(req(m, p))
  t(`${m} ${p} → ${ok.join('/')}`, ok.includes(r.status), String(r.status))
}
{
  const r = await raw(req('HEAD', '/api/tokens'))
  t('HEAD /api/tokens answers with no body', r.status === 200 && r.body === '', r.status + ' ' + r.body.length)
}

// ═══════════════════════════════════════════════════════════════════════
section('M4 cross-site: every spelling of "another site" is refused before any work')
const sw = { 'content-type': 'application/json' }
const emptyList = JSON.stringify({ items: [] })
for (const [label, h] of [
  ['Origin evil', { origin: 'https://evil.example' }],
  ['Origin null (sandboxed iframe / data: page)', { origin: 'null' }],
  ['Origin = ours + suffix', { origin: ORIGIN + '.evil.example' }],
  ['Origin = ours with a path', { origin: ORIGIN + '/x' }],
  ['Sec-Fetch-Site cross-site, no Origin', { 'sec-fetch-site': 'cross-site' }],
  ['Sec-Fetch-Site same-site (a sibling subdomain)', { 'sec-fetch-site': 'same-site' }],
  ['text/plain simple request from evil', { origin: 'https://evil.example', 'content-type': 'text/plain' }],
]) {
  const r = await raw(req('POST', '/api/swaps', { headers: { ...sw, ...h }, body: emptyList }))
  t(`${label} → 403`, r.status === 403, r.status + ' ' + r.body.slice(0, 60))
}
{
  const r = await raw(req('POST', '/api/swaps', { headers: { ...sw, origin: ORIGIN, 'sec-fetch-site': 'same-origin' }, body: emptyList }))
  t('our own page passes', r.status === 200, r.status + ' ' + r.body.slice(0, 80))
}
for (const ct of ['text/plain; charset=application/json', 'application/json-patch+json', 'application/jsonx', 'text/plain;application/json', 'multipart/form-data; boundary=application/json']) {
  const r = await raw(req('POST', '/api/swaps', { headers: { 'content-type': ct }, body: emptyList }))
  t(`content-type "${ct}" is not JSON → 415`, r.status === 415, String(r.status))
}

// ═══════════════════════════════════════════════════════════════════════
section('M5 bytes inside the JSON')
for (const [label, body] of [
  ['UTF-8 BOM before the JSON', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(emptyList)])],
  ['invalid UTF-8 inside a string', Buffer.concat([Buffer.from('{"items":[{"id":"'), Buffer.from([0xc3, 0x28, 0xff, 0xfe]), Buffer.from('","token":"x"}]}')])],
  ['NUL bytes', Buffer.from('{"items":[{"id":"\u0000","token":"\u0000"}]}')],
  ['__proto__ item', Buffer.from('{"items":[{"__proto__":{"id":"x"},"token":"y"}],"__proto__":{"items":[1]}}')],
  ['deep nesting 1,500', Buffer.from('{"items":' + '['.repeat(1500) + ']'.repeat(1500) + '}')],
  ['number 1e400 and -0', Buffer.from('{"items":[{"id":1e400,"token":-0}]}')],
  ['items is an object with length', Buffer.from('{"items":{"length":1e9,"0":{"id":"a"}}}')],
]) {
  const r = await raw(req('POST', '/api/swaps', { headers: sw, body }))
  t(`${label} → a clean 4xx or an empty list, never a 500`, r.status !== 500 && r.status !== 0 && (r.status >= 400 || (jsonOf(r)?.swaps || []).length === 0), r.status + ' ' + r.body.slice(0, 80))
}
t('the desk still answers', await alive())

// ═══════════════════════════════════════════════════════════════════════
section('M6 swap tokens on the wire')
const fakeId = '00000000-0000-4000-8000-000000000000'
for (const [label, tok] of [['empty', ''], ['64 zeros', '0'.repeat(64)], ['two tokens joined', '0'.repeat(64) + ', ' + 'f'.repeat(64)], ['65 hex', 'a'.repeat(65)], ['huge 60 KB', 'a'.repeat(60000)], ['non-ASCII', 'ä'.repeat(64)]]) {
  const r = await raw(req('GET', '/api/swap?id=' + fakeId, { headers: { 'x-swap-token': tok } }))
  t(`token ${label} → 404 (same as unknown id)`, r.status === 404 || r.status === 431 || r.status === 400, String(r.status))
}
{
  const a = await raw(req('GET', '/api/swap?id=' + fakeId))
  const b = await raw(req('GET', '/api/swap?id=not-a-uuid'))
  t('unknown id and malformed id answer byte-identically', a.status === b.status && a.body === b.body, a.body + ' | ' + b.body)
  t('a 404 is not cacheable', /no-store/.test(a.headers['cache-control'] || ''))
}

// ═══════════════════════════════════════════════════════════════════════
section('M7 budgets under real concurrency (local D1)')
{
  // 90 simultaneous list calls from ONE client: the l: budget is 30/min. Atomic take() must let exactly 30 through.
  const ip = '198.51.100.' + (1 + Math.floor(Math.random() * 200))
  const rs = await Promise.all(Array.from({ length: 90 }, () => raw(req('POST', '/api/swaps', { headers: { ...sw, 'cf-connecting-ip': ip }, body: emptyList }), { timeout: 30000 })))
  const okN = rs.filter(r => r.status === 200).length, rl = rs.filter(r => r.status === 429).length
  t('90 parallel list calls from one client: at most 30 get through', okN <= 30 && okN + rl === 90, JSON.stringify({ okN, rl, other: rs.filter(r => r.status !== 200 && r.status !== 429).map(r => r.status) }))
  console.log(`         (${okN} through, ${rl} rate-limited — local dev ${okN === 30 ? 'honours' : 'IGNORES'} a client-sent CF-Connecting-IP per-request)`)
}

// ═══════════════════════════════════════════════════════════════════════
section('M8 the whole-API network gate (rate-limit binding, 300/min per network)')
{
  const net = (100 + Math.floor(Math.random() * 3000)).toString(16)
  const rs = []
  for (let wave = 0; wave < 7; wave++)
    rs.push(...await Promise.all(Array.from({ length: 50 }, (_, i) => raw(req('GET', '/api/swap?id=' + fakeId, { headers: { 'cf-connecting-ip': `2001:db8:${net}:${(wave * 50 + i + 1).toString(16)}::1` } }), { timeout: 30000 }))))
  const limited = rs.filter(r => r.status === 429).length
  t('350 calls from 350 different /64s of ONE /48 → the network gate refuses the excess', limited >= 40 && limited <= 60, JSON.stringify({ limited, statuses: [...new Set(rs.map(r => r.status))] }))
  const other = await raw(req('GET', '/api/swap?id=' + fakeId, { headers: { 'cf-connecting-ip': '2001:db8:ffff:1::1' } }))
  t('another /48 is not affected', other.status === 404, String(other.status))
  t('a refusal says when to retry', rs.find(r => r.status === 429)?.headers['retry-after'] === '60')
}

console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) console.log('BROKE:\n  - ' + breaks.join('\n  - '))
process.exit(fail ? 1 : 0)
