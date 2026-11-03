// ============================================================
// near-intents-desk — MOBILE ROUND 4 (real WebKit + Chromium): the round-13 page fixes
// ============================================================
// One attack per hole the round-13 client review found, against the real page served by
// `wrangler dev` (port 8797). Each asserts the SAFE outcome; BROKE = a break.
//
//   npx wrangler dev --port 8797 --ip 127.0.0.1    then    node test/intents-mobile4.mjs
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

async function session(bt, device, { init = null } = {}) {
  const browser = await bt.launch()
  const ctx = await browser.newContext({ ...devices[device] })
  const ip = '10.99.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250)
  await overrideClient(ctx)
  await ctx.route('http://127.0.0.1:8797/api/**', route => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }))
  if (init) await ctx.addInitScript(init)
  const page = await ctx.newPage()
  return { browser, ctx, page }
}
async function ready(page) {
  await page.goto(URL0, { waitUntil: 'load' })
  await page.waitForFunction(() => document.getElementById('xc-status-pill')?.textContent === 'LIVE', null, { timeout: 20000 })
}
/** Open a crafted swap through "My swaps": the device holds its key, the list and polls are answered by the test. */
async function openViaHistory(page, sw, onPoll) {
  await page.route('**/api/swaps', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, swaps: [sw] }) }))
  await page.route('**/api/swap?id=*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, swap: onPoll ? onPoll() : sw }) }))
  await page.goto(URL0, { waitUntil: 'load' })
  await page.evaluate(([id, tok]) => localStorage.setItem('desk.swaps', JSON.stringify([{ id, token: tok }])), [ID, TOKEN])
  await ready(page)
  await page.waitForSelector('.xc-hist', { timeout: 10000 })
  await page.tap('.xc-hist')
  await page.waitForSelector('#xc-card:not([hidden])', { timeout: 10000 })
}
const amountBig = page => page.$$eval('.xc-amount-big', els => els.map(e => e.textContent.trim()))

async function run(eng, bt, device) {
  console.log(`\n[${eng}: ${device} on ${bt.name()}]`)

  // ── P1. a slow preview for the OLD amount must not be paired with the NEW one
  {
    const { browser, page } = await session(bt, device)
    await ready(page)
    const slow = { '1000': 2500, '2000': 7000 }
    await page.route('**/api/quote', async route => {
      const b = JSON.parse(route.request().postData() || '{}')
      if (b.dry && slow[b.amount]) await new Promise(r => setTimeout(r, slow[b.amount]))
      return route.continue()
    })
    await page.fill('#xc-recipient', SOLW); await page.fill('#xc-refund', EVM)
    await page.fill('#xc-amount', '1000'); await blur(page)
    await page.waitForTimeout(900)                          // the 1000 preview is now in flight
    await page.fill('#xc-amount', '2000'); await blur(page)
    await page.waitForTimeout(3200)                         // the 1000 answer has landed; the 2000 one has not
    const ack = await page.textContent('#xc-ack-amount + *').catch(() => '')
    const shown = await page.textContent('#xc-preview').catch(() => '')
    t(eng, 'the OLD amount’s price is not shown against the NEW amount', !/1000|1,000/.test(shown) && !/exactly 1000 /.test(ack || ''), JSON.stringify({ shown: shown.slice(0, 80), ack }))
    t(eng, '…and nothing can be accepted until the right price arrives', await page.isDisabled('#xc-go'))
    // the 2000 answer is held 7 s by this test, plus live 1Click time: wait for it, not a fixed time
    await page.waitForFunction(() => /exactly 2000 /.test(document.querySelector('#xc-ack-amount + *')?.textContent || ''), null, { timeout: 20000 }).catch(() => {})
    t(eng, 'the right price then arrives for 2000', /exactly 2000 /.test(await page.textContent('#xc-ack-amount + *').catch(() => '') || ''), await page.textContent('#xc-ack-amount + *').catch(() => ''))
    await browser.close()
  }
  // ── P1b. the OLD amount's answer lands inside the 650 ms pause after the edit, BEFORE the new
  // request is sent: only the edit itself can retire it (client-campaign survivor; P1's old answer
  // landed after the new request had already retired it).
  {
    const { browser, page } = await session(bt, device)
    await ready(page)
    let release; const gate = new Promise(r => { release = r })
    await page.route('**/api/quote', async route => {
      const b = JSON.parse(route.request().postData() || '{}')
      if (!(b.dry && b.amount === '1000')) return route.continue()
      const res = await route.fetch()                       // the real answer, fetched now…
      await gate                                            // …and handed over only on release
      return route.fulfill({ response: res })
    })
    await page.fill('#xc-recipient', SOLW); await page.fill('#xc-refund', EVM)
    await page.fill('#xc-amount', '1000'); await blur(page)
    await page.waitForTimeout(3000)                         // the 1000 answer is fetched and held
    await page.fill('#xc-amount', '2000'); await blur(page)
    release()                                               // the 1000 answer now lands, inside the pause
    await page.waitForTimeout(350)                          // the 2000 request has not been sent yet
    const ack = await page.textContent('#xc-ack-amount + *').catch(() => '')
    const shown = await page.textContent('#xc-preview').catch(() => '')
    t(eng, 'an old answer landing before the new request is never shown against the new amount', !/1000|1,000/.test(shown) && !/exactly 1000 /.test(ack || ''), JSON.stringify({ shown: shown.slice(0, 80), ack }))
    await browser.close()
  }

  // ── P2. a SECOND partial deposit redraws "send the remaining"
  {
    const { browser, page } = await session(bt, device)
    let n = 0
    await openViaHistory(page, swapOf({ state: 'incomplete_deposit', deposited: '20000000' }),
      () => swapOf({ state: 'incomplete_deposit', deposited: ++n > 1 ? '30000000' : '20000000' }))
    const before = await amountBig(page)
    await page.waitForTimeout(11500)
    const after = await amountBig(page)
    t(eng, 'partial deposit: 20 of 47 received → "send the remaining 27"', before.some(s => s === '27 USDC'), JSON.stringify(before))
    t(eng, 'a second partial deposit (30 received, state unchanged) → the card now says 17', after.some(s => s === '17 USDC'), JSON.stringify(after))
    await browser.close()
  }

  // ── P3. a browser without BigInt (iOS before 14) still asks only for the rest
  {
    const { browser, page } = await session(bt, device, { init: () => { try { delete window.BigInt } catch (e) {} window.BigInt = undefined } })
    // 47.000000 − 20.500001 = 26.499999: every digit borrows
    await openViaHistory(page, swapOf({ state: 'incomplete_deposit', deposited: '20500001' }))
    const amts = await amountBig(page)
    t(eng, 'without BigInt the card asks for exactly the remaining 26.499999 (borrowing digits), not the full 47', amts.some(s => s === '26.499999 USDC') && !amts.some(s => s === '47 USDC'), JSON.stringify(amts))
    await browser.close()
  }

  // ── P8/P9. the swap's key: a browser that will not store it is told so; old receipts are pruned
  {
    const issueCrafted = async (page, sw) => {
      await page.fill('#xc-amount', '47'); await page.fill('#xc-recipient', SOLW); await page.fill('#xc-refund', EVM)
      await blur(page); await page.waitForTimeout(3500)
      await page.tap('#xc-ack-amount'); await page.tap('#xc-ack-address')
      await page.route('**/api/quote', r => {
        const b = JSON.parse(r.request().postData() || '{}')
        return b.dry === false ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, swap: sw, token: TOKEN, receipt: { signature: 'sig', timestamp: new Date().toISOString() } }) }) : r.continue()
      })
      await page.tap('#xc-go')
      await page.waitForSelector('#xc-card:not([hidden])', { timeout: 10000 })
    }
    const s1 = await session(bt, device, { init: () => {
      const orig = Storage.prototype.setItem
      Storage.prototype.setItem = function (k, v) { if (k === 'desk.swaps') throw new Error('QuotaExceededError'); return orig.call(this, k, v) }
    } })
    await ready(s1.page)
    await issueCrafted(s1.page, swapOf({}))
    t(eng, 'a browser that refuses to store the key → the user is told, and told to keep the receipt', /would not save the key/.test(await s1.page.textContent('#xc-msg')), await s1.page.textContent('#xc-msg'))
    await s1.browser.close()
    // …and one that drops it SILENTLY (no error thrown): only reading it back can tell
    const s1b = await session(bt, device, { init: () => {
      const orig = Storage.prototype.setItem
      Storage.prototype.setItem = function (k, v) { if (k === 'desk.swaps') return; return orig.call(this, k, v) }
    } })
    await ready(s1b.page)
    await issueCrafted(s1b.page, swapOf({}))
    t(eng, 'a browser that silently drops the key → the user is still told', /would not save the key/.test(await s1b.page.textContent('#xc-msg')), await s1b.page.textContent('#xc-msg'))
    await s1b.browser.close()

    const s2 = await session(bt, device)
    await s2.page.goto(URL0, { waitUntil: 'load' })
    const old = Array.from({ length: 20 }, (_, i) => ({ id: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'), token: 'ee'.repeat(32) }))
    await s2.page.evaluate(list => localStorage.setItem('desk.swaps', JSON.stringify(list)), old)
    await ready(s2.page)
    await issueCrafted(s2.page, swapOf({}))
    const keys = await s2.page.evaluate(() => JSON.parse(localStorage.getItem('desk.swaps')).length)
    t(eng, 'a 21st swap drops the oldest key (storage does not grow forever)', keys === 20, JSON.stringify({ keys }))
    // No dates (owner's rule): the only thing kept per swap is its id and key — no stored quote,
    // nothing with a time in it, even when the server answer carried one.
    const stored = await s2.page.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('desk.') === 0).map(k => k + '=' + localStorage.getItem(k)).join('\n'))
    t(eng, '…and the browser stores no quote and no date for any swap', !/desk\.receipt\.|\d{4}-\d{2}-\d{2}|\b1\d{12}\b/.test(stored), stored.slice(0, 300))
    await s2.browser.close()
  }

  // ── P4. a late tx-submit answer cannot redraw a card the user has left
  {
    const { browser, page } = await session(bt, device)
    await openViaHistory(page, swapOf({}))
    await page.route('**/api/submit', async r => { await new Promise(res => setTimeout(res, 3000)); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, swap: swapOf({}) }) }) })
    await page.fill('#xc-txhash', '0x' + 'ab'.repeat(32))
    await page.tap('.xc-txrow .xc-btn')
    await page.tap('text=New swap')
    await page.waitForTimeout(3800)
    t(eng, 'after "New swap", the late submit answer does not bring the old card back', await page.isHidden('#xc-card') && await page.isVisible('#xc-form'), JSON.stringify({ card: await page.isHidden('#xc-card') }))
    await browser.close()
  }

  // ── P5. a copy that fails says so (the clipboard would still hold an OLDER address)
  {
    const { browser, page } = await session(bt, device, { init: () => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } })
    } })
    await openViaHistory(page, swapOf({}))
    await page.tap('text=Copy address')
    await page.waitForTimeout(400)
    const label = await page.textContent('.xc-dep-text .xc-btn')
    const selected = await page.evaluate(() => String(window.getSelection()))
    t(eng, 'a refused copy says "Copy failed"', /Copy failed/.test(label), label)
    t(eng, '…and selects the address so it can be copied by hand', selected.trim() === DEP, selected)
    await browser.close()
  }

  // ── P6. "1,000" is asked about, never guessed
  {
    const { browser, page } = await session(bt, device)
    const sent = []
    await page.route('**/api/quote', r => { try { sent.push(JSON.parse(r.request().postData() || '{}')) } catch {} return r.continue() })
    await ready(page)
    await page.fill('#xc-recipient', SOLW); await page.fill('#xc-refund', EVM)
    await page.fill('#xc-amount', '1,000'); await blur(page); await page.waitForTimeout(1500)
    t(eng, '"1,000" → the page asks which was meant', /thousand or one/.test(await page.textContent('#xc-msg')), await page.textContent('#xc-msg'))
    t(eng, '…and sends no preview for 1 or for 1000', sent.filter(b => b.dry).length === 0, JSON.stringify(sent.map(b => b.amount)))
    await page.fill('#xc-amount', '35,5'); await blur(page); await page.waitForTimeout(2500)
    t(eng, 'a real decimal comma ("35,5") still means 35.5', sent.some(b => b.dry && b.amount === '35.5'), JSON.stringify(sent.map(b => b.amount)))
    await browser.close()
  }

  // ── P7. explorer links are ours, never the feed's
  {
    const { browser, page } = await session(bt, device)
    const goodEvm = '0x' + 'a1'.repeat(32)
    await openViaHistory(page, swapOf({ state: 'processing',
      originTxs: [{ hash: goodEvm, explorerUrl: 'https://evil.example/phish' }],
      destTxs: [{ hash: 'not-a-solana-hash', explorerUrl: 'https://solscan.io/tx/x' }, { hash: '5' + 'K'.repeat(86), explorerUrl: 'https://evil.example/2' }] }))
    const hrefs = await page.$$eval('.xc-links a', as => as.map(a => a.href))
    t(eng, 'no link points at a host the feed chose', hrefs.every(h => !/evil\.example/.test(h)), JSON.stringify(hrefs))
    t(eng, 'the deposit tx links to the Base explorer for that exact hash', hrefs.includes('https://basescan.org/tx/' + goodEvm), JSON.stringify(hrefs))
    t(eng, 'a payout hash of the wrong shape is shown but not linked', hrefs.filter(h => /solscan/.test(h)).length === 1 && /not-a-solana-hash/.test(await page.textContent('.xc-links')), JSON.stringify(hrefs))
    await browser.close()
  }
}

await run('iOS', webkit, 'iPhone 14')
await run('Android', chromium, 'Pixel 7')
console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) { console.log('\nBREAKS:'); for (const b of breaks) console.log('  - ' + b) }
process.exit(fail ? 1 : 0)
