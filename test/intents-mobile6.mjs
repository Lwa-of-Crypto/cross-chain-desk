// ============================================================
// near-intents-desk — MOBILE ROUND 6 (real WebKit + Chromium): round 16 page fixes
// ============================================================
// The swap key in memory, poll epochs, late answers to an older press, and a reload that
// checks a request in doubt instead of orphaning it. Real page on `wrangler dev`.
//   npx wrangler dev --port 8797 --ip 127.0.0.1    then    node test/intents-mobile6.mjs
// ============================================================
import { fileURLToPath } from 'url'
import path from 'path'
import { overrideClient } from './intents-client-override.mjs'
const { webkit, chromium, devices } = await import('playwright')
const URL0 = 'http://127.0.0.1:8797/'
const SOLW = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', EVM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const DEP = '0x2222222222222222222222222222222222222222'
const ID = '11111111-2222-4333-8444-555555555555', TOKEN = 'cd'.repeat(32)

let pass = 0, fail = 0
const breaks = []
const t = (eng, name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  safe   [${eng}] ${name}`) }
  else { fail++; breaks.push(`[${eng}] ${name}`); console.log(`  BROKE  [${eng}] ${name}` + (extra ? '  — ' + String(extra).slice(0, 260) : '')) }
}
const blur = page => page.evaluate(() => document.activeElement && document.activeElement.blur())
const swapOf = over => ({ id: ID, rev: 0, fromAsset: 'x', toAsset: 'y', fromChain: 'base', toChain: 'sol',
  fromDecimals: 6, toDecimals: 9, fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: '47000000', amountOut: '200000000', minAmountOut: '199000000',
  recipient: SOLW, refundTo: EVM, depositAddress: DEP, secondsLeft: 3600, state: 'awaiting_deposit',
  originTxs: [], destTxs: [], ...over })
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function session(bt, device, { init = null } = {}) {
  const browser = await bt.launch()
  const ctx = await browser.newContext({ ...devices[device] })
  const ip = '10.97.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250)
  await overrideClient(ctx)
  await ctx.route('http://127.0.0.1:8797/api/**', route => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }))
  if (init) await ctx.addInitScript(init)
  return { browser, page: await ctx.newPage() }
}
async function ready(page) {
  await page.goto(URL0, { waitUntil: 'load' })
  await page.waitForFunction(() => document.getElementById('xc-status-pill')?.textContent === 'LIVE', null, { timeout: 20000 })
}
async function previewAndAccept(page) {
  await page.fill('#xc-amount', '47'); await page.fill('#xc-recipient', SOLW); await page.fill('#xc-refund', EVM)
  await blur(page); await page.waitForTimeout(3500)
  await page.tap('#xc-ack-amount'); await page.tap('#xc-ack-address')
}
const resume = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

async function run(eng, bt, device) {
  console.log(`\n[${eng}: ${device} on ${bt.name()}]`)

  // ── H1. the browser will not store the key: back from the wallet app, the card still works
  {
    const { browser, page } = await session(bt, device, { init: () => {
      const orig = Storage.prototype.setItem
      Storage.prototype.setItem = function (k, v) { if (k === 'desk.swaps') throw new Error('QuotaExceededError'); return orig.call(this, k, v) }
    } })
    await ready(page); await previewAndAccept(page)
    const tokens = []
    await page.route('**/api/quote', r => { const b = JSON.parse(r.request().postData() || '{}'); return b.dry === false ? json(r, 200, { ok: true, swap: swapOf({}), token: TOKEN }) : r.continue() })
    await page.route('**/api/swap?id=*', r => { const k = r.request().headers()['x-swap-token'] || ''; tokens.push(k); return k === TOKEN ? json(r, 200, { ok: true, swap: swapOf({}) }) : json(r, 404, { ok: false, error: 'not_found' }) })
    await page.tap('#xc-go'); await page.waitForSelector('.xc-addr', { timeout: 10000 })
    await resume(page); await page.waitForTimeout(1500)
    t(eng, 'key not storable: the status poll after resume still carries the key (kept in memory)', tokens.length >= 1 && tokens.every(k => k === TOKEN), JSON.stringify(tokens))
    t(eng, '…and the deposit address comes back after the fresh status', !!(await page.$('.xc-addr')))
    await browser.close()
  }

  // ── H2. a poll answer from before the page slept cannot put old data back
  {
    const { browser, page } = await session(bt, device)
    let n = 0
    // the list is older than both answers (server stamps only move forward)
    await page.route('**/api/swaps', r => json(r, 200, { ok: true, swaps: [swapOf({ rev: 500 })] }))
    await page.route('**/api/swap?id=*', async r => {
      const k = ++n
      if (k === 1) { await sleep(4000); return json(r, 200, { ok: true, swap: swapOf({ rev: 1000 }) }) }      // sent before the sleep, answered late
      return json(r, 200, { ok: true, swap: swapOf({ state: 'deposit_seen', rev: 2000 }) })
    })
    await page.goto(URL0, { waitUntil: 'load' })
    await page.evaluate(([id, tok]) => localStorage.setItem('desk.swaps', JSON.stringify([{ id, token: tok }])), [ID, TOKEN])
    await ready(page)
    await page.waitForSelector('.xc-hist', { timeout: 10000 }); await page.tap('.xc-hist')
    await page.waitForTimeout(800)
    await resume(page)
    await page.waitForTimeout(5000)
    const txt = await page.textContent('#xc-card')
    t(eng, 'the late answer from before resume is dropped: no "send" address over a paid swap', !(await page.$('.xc-addr')) && /deposit was seen/i.test(txt), txt.slice(0, 160))
    await browser.close()
  }

  // ── H3. back/forward-cache restore mid-request, a second press, the FIRST answer wins:
  //        the second press failing afterwards must not lock the page
  {
    const { browser, page } = await session(bt, device)
    await ready(page); await previewAndAccept(page)
    let n = 0
    await page.route('**/api/quote', async r => {
      const b = JSON.parse(r.request().postData() || '{}')
      if (b.dry !== false) return r.continue()
      const k = ++n
      if (k === 1) { await sleep(2000); return json(r, 200, { ok: true, swap: swapOf({}), token: TOKEN }) }
      await sleep(3500); return r.abort('connectionreset')
    })
    await page.tap('#xc-go'); await page.waitForTimeout(400)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await page.waitForTimeout(200)
    await page.tap('#xc-go').catch(() => {})
    await page.waitForTimeout(4500)
    const msg = await page.textContent('#xc-msg')
    t(eng, 'the first press’s swap is shown', await page.isVisible('#xc-card') && !!(await page.$('.xc-addr')))
    t(eng, '…and the second press failing later does not bring back "could not confirm"', !/could not confirm/i.test(msg), msg)
    await page.tap('text=New swap'); await page.waitForTimeout(400)
    await page.fill('#xc-amount', '48'); await blur(page); await page.waitForTimeout(3500)
    t(eng, '…and "New swap" gives a working form (it prices again)', /You send/.test(await page.textContent('#xc-preview')), await page.textContent('#xc-msg'))
    await browser.close()
  }

  // ── H4. reload while the outcome is in doubt: the same request is checked again
  {
    const { browser, page } = await session(bt, device)
    await ready(page); await previewAndAccept(page)
    const keys = []
    let phase = 'drop'
    await page.route('**/api/quote', r => {
      const b = JSON.parse(r.request().postData() || '{}')
      if (b.dry !== false) return r.continue()
      keys.push(b.idempotencyKey)
      return phase === 'drop' ? r.abort('connectionreset') : json(r, 200, { ok: true, replay: true, swap: swapOf({}), token: TOKEN })
    })
    await page.tap('#xc-go'); await page.waitForTimeout(1200)
    phase = 'ok'
    const r0 = Date.now()
    await page.reload({ waitUntil: 'load' })
    const rl = Date.now() - r0
    await page.waitForSelector('.xc-addr', { timeout: 15000 }).catch(() => {})
    const stored = await page.evaluate(() => localStorage.getItem('desk.swaps') || '')
    const why = await page.evaluate(() => ({ card: [...document.querySelectorAll('#xc-card .xc-state')].map(p => p.className + ': ' + p.textContent.slice(0, 70)), sess: sessionStorage.getItem('desk.pending') ? 'pending' : 'none', vis: document.visibilityState, msg: document.getElementById('xc-msg')?.textContent, pill: document.getElementById('xc-status-pill')?.textContent }))
    t(eng, 'after a reload the page re-sent the SAME request on its own', keys.length === 2 && keys[0] === keys[1], JSON.stringify(keys))
    t(eng, '…found the swap it had made, and saved its key', !!(await page.$('.xc-addr')) && stored.includes(ID), `reload ${rl}ms, total ${Date.now() - r0}ms, stored=${stored.includes(ID)} ` + JSON.stringify(why))
    t(eng, '…and the request in doubt is cleared', (await page.evaluate(() => sessionStorage.getItem('desk.pending'))) === null)
    await browser.close()
  }
}

async function run17(eng, bt, device) {
  // ── J1 (round 17). a request in doubt that keeps being refused (desk paused): there is a way out
  {
    const { browser, page } = await session(bt, device)
    await ready(page); await previewAndAccept(page)
    let phase = 'drop'
    await page.route('**/api/quote', r => {
      const b = JSON.parse(r.request().postData() || '{}')
      if (b.dry !== false) return r.continue()
      return phase === 'drop' ? r.abort('connectionreset') : json(r, 503, { ok: false, error: 'paused_global', message: 'Paused.' })
    })
    await page.tap('#xc-go'); await page.waitForTimeout(1200)
    phase = 'paused'
    await page.tap('#xc-go'); await page.waitForTimeout(1200)
    const locked = await page.isDisabled('#xc-amount')
    const btn = await page.$('button:has-text("Start over")')
    t(eng, 'paused desk + request in doubt: the form is locked but "Start over" is offered and usable', locked && !!btn && !(await btn.isDisabled()), JSON.stringify({ locked, btn: !!btn }))
    if (btn) await btn.tap()
    await page.waitForTimeout(400)
    t(eng, '…"Start over" unlocks the form and clears the saved request', !(await page.isDisabled('#xc-amount')) && (await page.evaluate(() => sessionStorage.getItem('desk.pending'))) === null)
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(2000)
    t(eng, '…and a reload no longer re-sends it', !(await page.isDisabled('#xc-amount')))
    await browser.close()
  }
  // ── J3 (round 18). a late answer for a request the user abandoned with "Start over"
  //        is kept (findable in history) but never put on screen
  {
    const { browser, page } = await session(bt, device)
    await ready(page); await previewAndAccept(page)
    let n = 0
    await page.route('**/api/quote', async r => {
      const b = JSON.parse(r.request().postData() || '{}')
      if (b.dry !== false) return r.continue()
      const k = ++n
      if (k === 1) return r.abort('connectionreset')                                  // unknown → in doubt
      await sleep(3000); return json(r, 200, { ok: true, swap: swapOf({}), token: TOKEN })   // press 2 answers late
    })
    await page.tap('#xc-go'); await page.waitForTimeout(1000)
    await page.tap('#xc-go'); await page.waitForTimeout(300)                           // press 2 in flight
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await page.waitForTimeout(200)
    const btn = await page.$('button:has-text("Start over")')
    if (btn) await btn.tap()
    await page.waitForTimeout(4000)                                                     // the late answer has landed
    const stored = await page.evaluate(() => localStorage.getItem('desk.swaps') || '')
    t(eng, 'abandoned request answered late: its address is NOT put on screen', !!btn && await page.isHidden('#xc-card') && !(await page.$('.xc-addr')))
    t(eng, '…the form stays usable', !(await page.isDisabled('#xc-amount')))
    t(eng, '…and the swap it made is kept, so it can still be found in history', stored.includes(ID), stored.slice(0, 120))
    // round 20: …but marked, and its card never offers the address
    await page.route('**/api/swaps', r => json(r, 200, { ok: true, swaps: [swapOf({})] }))
    await page.route('**/api/swap?id=*', r => json(r, 200, { ok: true, swap: swapOf({}) }))
    await page.tap('#xc-history-refresh'); await page.waitForTimeout(800)
    const label = await page.textContent('.xc-hist .st').catch(() => '')
    await page.tap('.xc-hist').catch(() => {}); await page.waitForTimeout(1500)
    t(eng, '…history labels it "abandoned"', /abandoned/.test(label), label)
    t(eng, '…and opening it shows "do NOT send", never the address', !(await page.$('.xc-addr')) && /started over before this deposit address/i.test(await page.textContent('#xc-card')), (await page.textContent('#xc-card')).slice(0, 120))
    await browser.close()
  }
  // ── J4 (round 20). a reload during the very FIRST request checks that same request again
  {
    const { browser, page } = await session(bt, device)
    await ready(page); await previewAndAccept(page)
    const keys = []
    let phase = 'hang'
    await page.route('**/api/quote', async r => {
      const b = JSON.parse(r.request().postData() || '{}')
      if (b.dry !== false) return r.continue()
      keys.push(b.idempotencyKey)
      if (phase === 'hang') { await sleep(20000); return r.abort('connectionreset') }
      return json(r, 200, { ok: true, replay: true, swap: swapOf({}), token: TOKEN })
    })
    await page.tap('#xc-go'); await page.waitForTimeout(800)                  // first request in flight, no answer yet
    phase = 'ok'
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.xc-addr', { timeout: 15000 }).catch(() => {})
    t(eng, 'reload during the FIRST request: the page re-sent that same request on its own', keys.length >= 2 && keys[1] === keys[0], JSON.stringify(keys))
    t(eng, '…and found its swap', !!(await page.$('.xc-addr')), JSON.stringify(await page.evaluate(() => ({ card: [...document.querySelectorAll('#xc-card .xc-state')].map(p => p.className + ': ' + p.textContent.slice(0, 70)), sess: sessionStorage.getItem('desk.pending') ? 'pending' : 'none', vis: document.visibilityState, msg: document.getElementById('xc-msg')?.textContent, pill: document.getElementById('xc-status-pill')?.textContent }))))
    await browser.close()
  }
  // ── J4b. the re-sent request answers BEFORE the page's load event (a slow font): the ordinary
  // load's pageshow is not a wake-up, so the address stays shown. Found as an intermittent J4/H4
  // failure: the answer won the race, pageshow then hid the address behind "Checking…".
  {
    const { browser, page } = await session(bt, device)
    await ready(page); await previewAndAccept(page)
    let phase = 'drop'
    await page.route('**/api/quote', r => {
      const b = JSON.parse(r.request().postData() || '{}')
      if (b.dry !== false) return r.continue()
      return phase === 'drop' ? r.abort('connectionreset') : json(r, 200, { ok: true, replay: true, swap: swapOf({}), token: TOKEN })
    })
    await page.route('**/api/swap?id=*', r => json(r, 404, { ok: false, error: 'not_found' }))   // no fresh status will ever come
    await page.tap('#xc-go'); await page.waitForTimeout(1200)
    phase = 'ok'
    await page.route('**/fonts/inter-latin-400-normal.woff2', async r => { await sleep(4000); return r.continue() })
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(800)
    t(eng, 'an answer that lands before the load event keeps its address on screen', !!(await page.$('.xc-addr')),
      JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('#xc-card .xc-state')].map(p => p.textContent.slice(0, 70)))))
    await browser.close()
  }
  // ── J5 (round 22). after a reload the request in doubt can be RETRIED, and the page says what it is
  {
    const { browser, page } = await session(bt, device)
    await ready(page); await previewAndAccept(page)
    const keys = []
    await page.route('**/api/quote', r => { const b = JSON.parse(r.request().postData() || '{}'); if (b.dry !== false) return r.continue(); keys.push(b.idempotencyKey); return r.abort('connectionreset') })
    await page.tap('#xc-go'); await page.waitForTimeout(1000)
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(2500)      // auto-resend: unknown again
    const msg = await page.textContent('#xc-msg')
    const goOn = !(await page.isDisabled('#xc-go'))
    await page.tap('#xc-go').catch(() => {}); await page.waitForTimeout(1200)
    t(eng, 'after a reload, the page says what it is re-checking (amount and recipient)', /47/.test(msg) && msg.includes(SOLW), msg)
    t(eng, '…and the request can be retried (Go stays usable), with the same key', goOn && keys.length >= 3 && new Set(keys).size === 1, JSON.stringify({ goOn, keys }))
    await browser.close()
  }
  // ── J6 (round 22). a late answer for an abandoned request never pushes a real swap off a full list
  {
    const { browser, page } = await session(bt, device)
    await page.goto(URL0, { waitUntil: 'load' })
    const old = Array.from({ length: 20 }, (_, i) => ({ id: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'), token: 'ee'.repeat(32) }))
    await page.evaluate(list => localStorage.setItem('desk.swaps', JSON.stringify(list)), old)
    await ready(page); await previewAndAccept(page)
    let n = 0
    await page.route('**/api/quote', async r => {
      const b = JSON.parse(r.request().postData() || '{}')
      if (b.dry !== false) return r.continue()
      if (++n === 1) return r.abort('connectionreset')
      await sleep(3000); return json(r, 200, { ok: true, swap: swapOf({}), token: TOKEN })
    })
    await page.tap('#xc-go'); await page.waitForTimeout(1000)
    await page.tap('#xc-go'); await page.waitForTimeout(300)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await page.waitForTimeout(200)
    const btn = await page.$('button:has-text("Start over")'); if (btn) await btn.tap()
    await page.waitForTimeout(4000)
    const kept = await page.evaluate(() => { const a = JSON.parse(localStorage.getItem('desk.swaps') || '[]'); return { n: a.length, last: a[19] && a[19].id } })
    t(eng, 'full list (20) + a late abandoned answer: every real swap keeps its key', kept.n === 20 && kept.last === old[19].id, JSON.stringify(kept))
    await browser.close()
  }
  // ── J2 (round 17). another tab drops this swap from the stored list: it is put back
  {
    const { browser, page } = await session(bt, device)
    await ready(page); await previewAndAccept(page)
    await page.route('**/api/quote', r => { const b = JSON.parse(r.request().postData() || '{}'); return b.dry === false ? json(r, 200, { ok: true, swap: swapOf({}), token: TOKEN }) : r.continue() })
    await page.tap('#xc-go'); await page.waitForSelector('#xc-card:not([hidden])', { timeout: 10000 })
    await page.evaluate(() => localStorage.setItem('desk.swaps', JSON.stringify([{ id: '99999999-0000-4000-8000-000000000000', token: 'ab'.repeat(32) }])))   // the other tab's write
    await page.waitForTimeout(900)
    const list = await page.evaluate(() => localStorage.getItem('desk.swaps') || '')
    t(eng, 'a key another tab wrote over is put back in storage (not just kept in memory)', list.includes(ID) && list.includes('99999999'), list.slice(0, 160))
    await browser.close()
  }
}

await run('iOS', webkit, 'iPhone 14')
await run17('iOS', webkit, 'iPhone 14')
await run17('Android', chromium, 'Pixel 7')
await run('Android', chromium, 'Pixel 7')
console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) { console.log('\nBREAKS:'); for (const b of breaks) console.log('  - ' + b) }
process.exit(fail ? 1 : 0)
