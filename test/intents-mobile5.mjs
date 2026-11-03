// ============================================================
// near-intents-desk — MOBILE ROUND 5 (real WebKit + Chromium): round 14 page fixes
// ============================================================
// The second-pass client review broke round 13's "pending key" lock in two ways and
// found four smaller holes. One attack each, against the real page on `wrangler dev`.
//   npx wrangler dev --port 8797 --ip 127.0.0.1    then    node test/intents-mobile5.mjs
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

async function session(bt, device, { init = null } = {}) {
  const browser = await bt.launch()
  const ctx = await browser.newContext({ ...devices[device] })
  const ip = '10.98.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250)
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
/** Route the "get address" call: each press is answered by the next entry ('drop' = connection lost). */
async function scriptIssue(page, answers) {
  const keys = []
  await page.route('**/api/quote', route => {
    const b = JSON.parse(route.request().postData() || '{}')
    if (b.dry !== false) return route.continue()
    keys.push(b.idempotencyKey)
    const a = answers[Math.min(keys.length - 1, answers.length - 1)]
    return a === 'drop' ? route.abort('connectionreset') : json(route, a.status, a.body)
  })
  return keys
}
const press = async page => { await page.tap('#xc-go').catch(() => {}); await page.waitForTimeout(1200) }
const amountLocked = page => page.isDisabled('#xc-amount')

async function run(eng, bt, device) {
  console.log(`\n[${eng}: ${device} on ${bt.name()}]`)

  // ── F1. an answer was lost; the retry is REFUSED (429 / RPC blip) without "keyFree":
  //        the key must survive, the form stay locked, and the next press reuse the key
  {
    const { browser, page } = await session(bt, device)
    await ready(page); await previewAndAccept(page)
    const keys = await scriptIssue(page, ['drop',
      { status: 429, body: { ok: false, error: 'rate_limited', message: 'Too many requests. Wait a minute.' } },
      { status: 503, body: { ok: false, error: 'address_unchecked', message: 'Could not check that Solana address.' } },
      'drop'])
    await press(page); await press(page); await press(page); await press(page)
    t(eng, 'lost answer, then 429, then an RPC refusal: every press resends the SAME key', keys.length === 4 && new Set(keys).size === 1, JSON.stringify(keys))
    t(eng, '…the form stays locked through the refusals', await amountLocked(page))
    t(eng, '…and the page says the earlier request may still hold an address', /may still have created a deposit address|could not confirm/i.test(await page.textContent('#xc-msg')), await page.textContent('#xc-msg'))
    await browser.close()
  }
  // ── F1b. a refusal that says the key IS free releases it
  {
    const { browser, page } = await session(bt, device)
    await ready(page); await previewAndAccept(page)
    const keys = await scriptIssue(page, ['drop', { status: 429, body: { ok: false, error: 'rate_limited', message: 'Too many requests.', keyFree: true } }])
    await press(page); await press(page)
    t(eng, 'a refusal with keyFree unlocks the form', !(await amountLocked(page)), JSON.stringify(keys))
    await browser.close()
  }

  // ── F2. while the outcome is in doubt, history cannot open a card (it dropped the key)
  {
    const { browser, page } = await session(bt, device)
    await page.route('**/api/swaps', r => json(r, 200, { ok: true, swaps: [swapOf({ id: '99999999-2222-4333-8444-555555555555' })] }))
    await page.goto(URL0, { waitUntil: 'load' })
    await page.evaluate(() => localStorage.setItem('desk.swaps', JSON.stringify([{ id: '99999999-2222-4333-8444-555555555555', token: 'ef'.repeat(32) }])))
    await ready(page); await previewAndAccept(page)
    const keys = await scriptIssue(page, ['drop', 'drop'])
    await press(page)
    await page.waitForSelector('.xc-hist', { timeout: 10000 })
    await page.tap('.xc-hist'); await page.waitForTimeout(500)
    t(eng, 'history click while a request is in doubt → no card opens', await page.isHidden('#xc-card'))
    t(eng, '…and the page says why', /Finish the request above/.test(await page.textContent('#xc-msg')), await page.textContent('#xc-msg'))
    await press(page)
    t(eng, '…and the next press still carries the same key', keys.length === 2 && keys[0] === keys[1], JSON.stringify(keys))
    await browser.close()
  }

  // ── F3–F6. on the swap card
  async function openViaHistory(page, sw, onPoll) {
    await page.route('**/api/swaps', r => json(r, 200, { ok: true, swaps: [sw] }))
    await page.route('**/api/swap?id=*', r => json(r, 200, { ok: true, swap: onPoll ? onPoll() : sw }))
    await page.goto(URL0, { waitUntil: 'load' })
    await page.evaluate(([id, tok]) => localStorage.setItem('desk.swaps', JSON.stringify([{ id, token: tok }])), [ID, TOKEN])
    await ready(page)
    await page.waitForSelector('.xc-hist', { timeout: 10000 }); await page.tap('.xc-hist')
    await page.waitForSelector('#xc-card:not([hidden])', { timeout: 10000 })
  }
  {
    // secondsLeft from answers that took a second or two longer or shorter (network delay) must
    // not re-pin the deadline: a moved deadline redraws the card on every poll (half-done copy /
    // typing lost). The deadline is fixed; only the measuring jitters by ±2 s.
    const { browser, page } = await session(bt, device)
    const T = Date.now() + 3600e3; let k = 0
    const live = () => swapOf({ secondsLeft: Math.floor((T - Date.now()) / 1000) + (++k % 2 ? 2 : -2) })
    await openViaHistory(page, live(), live)
    await page.waitForTimeout(2500)
    await page.evaluate(() => { const a = document.querySelector('.xc-addr'); if (a) a.__mark = 1 })
    await page.waitForTimeout(22000)
    const kept = await page.evaluate(() => { const a = document.querySelector('.xc-addr'); return !!(a && a.__mark === 1) })
    t(eng, 'polls whose time-left jitters by a second or two do not redraw the deposit card', kept && k >= 3, JSON.stringify({ kept, polls: k }))
    await browser.close()
  }
  {
    const { browser, page } = await session(bt, device)
    await openViaHistory(page, swapOf({ state: 'incomplete_deposit', deposited: null }))
    const big = await page.$$eval('.xc-amount-big', els => els.map(e => e.textContent))
    t(eng, 'partial deposit with NO amount reported → no "send exactly 47" (it would be paid twice)', big.length === 0 && /not reported yet/.test(await page.textContent('#xc-card')), JSON.stringify(big))
    await browser.close()
  }
  {
    // Owner's rule: no date anywhere. The card says how long is left, never when.
    const { browser, page } = await session(bt, device)
    await ready(page); await previewAndAccept(page)
    await scriptIssue(page, [{ status: 200, body: { ok: true, swap: swapOf({ secondsLeft: 3600 }), token: TOKEN } }])
    await press(page); await page.waitForTimeout(800)
    const card = await page.textContent('#xc-card')
    t(eng, 'the deposit card shows the time left to send (1 h), not a date', /Time left to send: (1 h 0|60|59) min/.test(card), card.slice(0, 300))
    t(eng, '…and no date or clock time anywhere on the card', !/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM)?/i.test(card), card.slice(0, 300))
    await browser.close()
  }
  {
    const { browser, page } = await session(bt, device)
    let n = 0
    await openViaHistory(page, swapOf({}), () => swapOf({ deposited: ++n > 0 ? '5' : null, state: 'awaiting_deposit', originTxs: [{ hash: '0x' + 'aa'.repeat(32) }] }))
    await page.fill('#xc-txhash', '0xabc123')
    await page.waitForTimeout(11500)                      // a poll lands with new data → the card is redrawn
    t(eng, 'a half-typed tx hash survives the card being redrawn by a poll', (await page.inputValue('#xc-txhash').catch(() => '')) === '0xabc123', await page.inputValue('#xc-txhash').catch(() => 'gone'))
    await browser.close()
  }
  // ── G1 (round 15). a card opened from history shows NO address until a fresh status
  //        arrives: the list said "waiting", but the swap was paid from another device
  {
    const { browser, page } = await session(bt, device)
    await page.route('**/api/swaps', r => json(r, 200, { ok: true, swaps: [swapOf({})] }))
    await page.route('**/api/swap?id=*', async r => { await new Promise(res => setTimeout(res, 2500)); return json(r, 200, { ok: true, swap: swapOf({ state: 'deposit_seen' }) }) })
    await page.goto(URL0, { waitUntil: 'load' })
    await page.evaluate(([id, tok]) => localStorage.setItem('desk.swaps', JSON.stringify([{ id, token: tok }])), [ID, TOKEN])
    await ready(page)
    await page.waitForSelector('.xc-hist', { timeout: 10000 }); await page.tap('.xc-hist')
    await page.waitForSelector('#xc-card:not([hidden])', { timeout: 10000 })
    const early = await page.$('.xc-addr')
    await page.waitForTimeout(3500)
    const late = await page.$('.xc-addr')
    t(eng, 'history card: no deposit address before a fresh status (the list may be stale)', !early, 'address shown from the stale list')
    t(eng, '…and once the status says the deposit arrived, none at all', !late && /deposit was seen/i.test(await page.textContent('#xc-card')))
    await browser.close()
  }

  // ── G1b (round 15). after the page slept, the address on screen is hidden until a fresh status
  {
    const { browser, page } = await session(bt, device)
    let slow = false
    await page.route('**/api/swaps', r => json(r, 200, { ok: true, swaps: [swapOf({})] }))
    await page.route('**/api/swap?id=*', async r => {
      if (slow) { await new Promise(res => setTimeout(res, 2500)); return json(r, 200, { ok: true, swap: swapOf({ state: 'deposit_seen' }) }) }
      return json(r, 200, { ok: true, swap: swapOf({}) })
    })
    await page.goto(URL0, { waitUntil: 'load' })
    await page.evaluate(([id, tok]) => localStorage.setItem('desk.swaps', JSON.stringify([{ id, token: tok }])), [ID, TOKEN])
    await ready(page)
    await page.waitForSelector('.xc-hist', { timeout: 10000 }); await page.tap('.xc-hist')
    await page.waitForSelector('.xc-addr', { timeout: 8000 }).catch(() => {})
    const shownFresh = !!(await page.$('.xc-addr'))
    slow = true
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.waitForTimeout(400)
    t(eng, 'fresh card shows the address (precondition)', shownFresh)
    t(eng, 'back from sleep: the old address is hidden until the fresh status lands', !(await page.$('.xc-addr')))
    await browser.close()
  }

  // ── G2 (round 15). Go is dead while a request is in flight, even if a box is re-ticked
  {
    const { browser, page } = await session(bt, device)
    await ready(page); await previewAndAccept(page)
    const keys = []
    await page.route('**/api/quote', async route => {
      const b = JSON.parse(route.request().postData() || '{}')
      if (b.dry !== false) return route.continue()
      keys.push(b.idempotencyKey)
      await new Promise(res => setTimeout(res, 3000))
      return json(route, 200, { ok: true, swap: swapOf({}), token: TOKEN })
    })
    await page.tap('#xc-go'); await page.waitForTimeout(300)
    await page.tap('#xc-ack-amount').catch(() => {}); await page.tap('#xc-ack-amount').catch(() => {})
    const goOff = await page.isDisabled('#xc-go')
    await page.tap('#xc-go', { force: true }).catch(() => {})
    await page.waitForTimeout(3500)
    t(eng, 'Go stays disabled while the request is in flight, even after re-ticking a box', goOff)
    t(eng, '…and exactly one request went out', keys.length === 1, JSON.stringify(keys))
    await browser.close()
  }

  // ── G3 (round 15). a malformed tx list from the API cannot break the card or stop polling
  {
    const { browser, page } = await session(bt, device)
    let polls = 0
    await openViaHistory(page, swapOf({}), () => { polls++; return swapOf({ originTxs: { length: 2, 0: 'x' }, destTxs: 'nope' }) })
    await page.waitForTimeout(11500)
    t(eng, 'non-array tx lists: the card still has its buttons', await page.isVisible('text=New swap'))
    t(eng, '…and polling carried on', polls >= 2, polls)
    await browser.close()
  }

  {
    const { browser, page } = await session(bt, device)
    const polls = []
    await openViaHistory(page, swapOf({}), () => { polls.push(Date.now()); return swapOf({}) })
    const t0 = Date.now()
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.waitForTimeout(1500)
    t(eng, 'coming back to the tab refreshes the card at once, not 10 s later', polls.some(x => x >= t0 && x - t0 < 1500), JSON.stringify(polls.map(x => x - t0)))
    await browser.close()
  }
}

await run('iOS', webkit, 'iPhone 14')
await run('Android', chromium, 'Pixel 7')
console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) { console.log('\nBREAKS:'); for (const b of breaks) console.log('  - ' + b) }
process.exit(fail ? 1 : 0)
