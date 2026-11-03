// ============================================================
// near-intents-desk — MOBILE ROUND 7 (real WebKit + Chromium): the proof-of-delivery box (round 27)
// ============================================================
// Real page on `wrangler dev`; the swap API answers are scripted so a settled swap can be shown.
//   npx wrangler dev --port 8797 --ip 127.0.0.1    then    node test/intents-mobile7.mjs
// ============================================================
import { fileURLToPath } from 'url'
import path from 'path'
import { overrideClient } from './intents-client-override.mjs'
const { webkit, chromium, devices } = await import('playwright')
const URL0 = 'http://127.0.0.1:8797/'
const ID = '11111111-2222-4333-8444-555555555555', TOKEN = 'cd'.repeat(32)
const TX = 'FyHXw6gJa2zTKj3ndmx1UbBv2pJjQC1RAw2iraRqbP8T'

let pass = 0, fail = 0
const breaks = []
const t = (eng, name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  safe   [${eng}] ${name}`) }
  else { fail++; breaks.push(`[${eng}] ${name}`); console.log(`  BROKE  [${eng}] ${name}` + (extra ? '  — ' + String(extra).slice(0, 260) : '')) }
}
const swapOf = over => ({ id: ID, rev: 0, fromAsset: 'x', toAsset: 'nep141:wrap.near', fromChain: 'base', toChain: 'near',
  fromDecimals: 6, toDecimals: 24, fromSymbol: 'USDC', toSymbol: 'wNEAR', amountIn: '47000000', amountOut: '20000000000000000000000000', minAmountOut: '19900000000000000000000000',
  recipient: 'alice.near', refundTo: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', depositAddress: '0x' + '22'.repeat(20), secondsLeft: 3600,
  state: 'settled', destVerified: 'verified', amountOutActual: '20000000000000000000000000', originTxs: [], destTxs: [{ hash: TX, explorerUrl: 'https://nearblocks.io/txns/' + TX }], ...over })
const payloadOf = over => JSON.stringify({ v: 1, type: 'near-intents-desk/proof-of-delivery', swap: ID,
  to: { chain: 'near', recipient: 'alice.near', minAmountOut: '19900000000000000000000000' },
  payout: { tx: TX, receipt: '7kNPqLAUV7DtttNRLik5d4ZjJ5zgGfn6cm8ksLnus2V2', explorer: 'https://evil.example/claim' }, check: 'onchain',
  checkText: 'Checked on NEAR by the desk <img src=x onerror="window.__pwned=1"> one receipt.', ...over })
const PROOF = { payload: payloadOf({}), sig: 'S'.repeat(86), kid: '0586d78b4a2f8f6e', alg: 'Ed25519' }
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

async function open(bt, device, routes) {
  const browser = await bt.launch()
  const ctx = await browser.newContext({ ...devices[device] })
  const ip = '10.96.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250)
  await overrideClient(ctx)
  await ctx.route('http://127.0.0.1:8797/api/**', route => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }))
  const page = await ctx.newPage()
  await page.route('**/api/swaps', r => json(r, 200, { ok: true, swaps: [swapOf({})] }))
  await page.route('**/api/swap?id=*', r => json(r, 200, { ok: true, swap: swapOf({}) }))
  if (routes) await routes(page)
  await page.goto(URL0, { waitUntil: 'load' })
  await page.evaluate(([id, tok]) => localStorage.setItem('desk.swaps', JSON.stringify([{ id, token: tok }])), [ID, TOKEN])
  await page.goto(URL0, { waitUntil: 'load' })
  await page.waitForFunction(() => document.getElementById('xc-status-pill')?.textContent === 'LIVE', null, { timeout: 20000 })
  await page.waitForSelector('.xc-hist', { timeout: 10000 }); await page.tap('.xc-hist')
  await page.waitForSelector('.xc-proof', { timeout: 10000 })
  return { browser, page }
}

async function run(eng, bt, device) {
  console.log(`\n[${eng}: ${device} on ${bt.name()}]`)
  // P1 the happy path
  {
    const seen = { tok: [], verifyBody: null }
    const { browser, page } = await open(bt, device, async page => {
      await page.route('**/api/proof?id=*', r => { seen.tok.push(r.request().headers()['x-swap-token'] || ''); return json(r, 200, { ok: true, proof: PROOF }) })
      await page.route('**/api/proof/verify', r => { seen.verifyBody = r.request().postData(); return json(r, 200, { ok: true, valid: true, facts: JSON.parse(PROOF.payload) }) })
    })
    t(eng, 'a settled swap shows the proof box with a "Get proof" button', /Get proof of delivery/.test(await page.textContent('.xc-proof')))
    await page.tap('.xc-proof button')
    await page.waitForFunction(() => /Signed by this desk/.test(document.querySelector('.xc-proof')?.textContent || ''), null, { timeout: 8000 })
    t(eng, 'the proof request carries this swap\'s key (header, never the URL)', seen.tok.length === 1 && seen.tok[0] === TOKEN, JSON.stringify(seen.tok))
    t(eng, 'hostile text in the proof is shown as text, never run', !(await page.evaluate(() => window.__pwned)) && !(await page.$('.xc-proof img')))
    const hrefs = await page.$$eval('.xc-proof a', as => as.map(a => a.href))
    t(eng, 'the payout link is built by the page (nearblocks + tx), not the proof\'s "explorer"', hrefs.length === 1 && hrefs[0] === 'https://nearblocks.io/txns/' + TX && !hrefs.some(h => /evil/.test(h)), JSON.stringify(hrefs))
    await page.tap('.xc-proof button:has-text("Check signature")')
    await page.waitForFunction(() => /Signature valid/.test(document.querySelector('.xc-proof')?.textContent || ''), null, { timeout: 8000 })
    t(eng, '"Check signature" sends the proof to the desk and says it is valid', !!seen.verifyBody && JSON.parse(seen.verifyBody).proof?.sig === PROOF.sig)
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    t(eng, 'no sideways scroll at phone width with the long receipt and tx', over <= 1, over)
    await browser.close()
  }
  // P1b the desk says the signature is NOT valid: the page must say so (client-campaign survivor)
  {
    const { browser, page } = await open(bt, device, async page => {
      await page.route('**/api/proof?id=*', r => json(r, 200, { ok: true, proof: PROOF }))
      await page.route('**/api/proof/verify', r => json(r, 200, { ok: true, valid: false, facts: null }))
    })
    await page.tap('.xc-proof button')
    await page.waitForSelector('.xc-proof button:has-text("Check signature")', { timeout: 8000 })
    await page.tap('.xc-proof button:has-text("Check signature")')
    await page.waitForTimeout(1500)
    const txt = await page.textContent('.xc-proof')
    t(eng, 'an invalid signature is reported as NOT valid (never as valid)', /NOT valid/.test(txt) && !/Signature valid/.test(txt), txt.slice(-120))
    await browser.close()
  }
  // P2 a proof that is not for this swap
  {
    const { browser, page } = await open(bt, device, async page => {
      await page.route('**/api/proof?id=*', r => json(r, 200, { ok: true, proof: { ...PROOF, payload: payloadOf({ swap: '99999999-2222-4333-8444-555555555555' }) } }))
    })
    await page.tap('.xc-proof button'); await page.waitForTimeout(1500)
    const txt = await page.textContent('.xc-proof')
    t(eng, 'a proof for ANOTHER swap is refused, with no download/check buttons', /did not match this swap/.test(txt) && !(await page.$('.xc-proof button:has-text("Download proof")')), txt.slice(0, 160))
    await browser.close()
  }
  // P3 the answer arrives after the member left the card
  {
    const { browser, page } = await open(bt, device, async page => {
      await page.route('**/api/proof?id=*', async r => { await new Promise(z => setTimeout(z, 2500)); return json(r, 200, { ok: true, proof: PROOF }) })
    })
    await page.tap('.xc-proof button')
    await page.tap('.xc-actions button:has-text("New swap")')
    await page.waitForTimeout(3500)
    t(eng, 'a late proof answer after "New swap" draws nothing on the form', !(await page.$('.xc-proof')) && await page.isVisible('#xc-form'))
    await browser.close()
  }
  // P3b a late FAILED answer after the member left the card: no proof error on the form (client-campaign survivor)
  {
    const { browser, page } = await open(bt, device, async page => {
      await page.route('**/api/proof?id=*', async r => { await new Promise(z => setTimeout(z, 2500)); return json(r, 503, { ok: false, message: 'Could not get the proof now. Try again in a minute.' }) })
    })
    await page.tap('.xc-proof button')
    await page.tap('.xc-actions button:has-text("New swap")')
    await page.waitForTimeout(3500)
    const msg = await page.textContent('#xc-msg')
    t(eng, 'a late proof failure after "New swap" puts no proof error on the form', !/proof/i.test(msg || ''), msg)
    await browser.close()
  }
  // P3c a late "Submit" answer for swap A after the member opened swap B: B stays on screen
  // (client-campaign survivor: with the epoch and id guards both gone, A's answer passed the
  // "same swap" check, which compares against A, and re-drew A over B).
  {
    const B = '22222222-3333-4444-8555-666666666666', TOKB = 'ef'.repeat(32), DEPA = '0x' + 'aa'.repeat(20), DEPB = '0x' + 'bb'.repeat(20)
    const A0 = swapOf({ state: 'awaiting_deposit', depositAddress: DEPA }), B0 = swapOf({ id: B, state: 'awaiting_deposit', depositAddress: DEPB, amountIn: '99000000' })
    const browser = await bt.launch()
    const ctx = await browser.newContext({ ...devices[device] })
    await overrideClient(ctx)
    const page = await ctx.newPage()
    await page.route('**/api/swaps', r => json(r, 200, { ok: true, swaps: [A0, B0] }))
    await page.route('**/api/swap?id=*', r => json(r, 200, { ok: true, swap: r.request().url().includes(B) ? B0 : A0 }))
    await page.route('**/api/submit', async r => { await new Promise(z => setTimeout(z, 3000)); return json(r, 200, { ok: true, swap: { ...A0, rev: 9 } }) })
    await page.goto(URL0, { waitUntil: 'load' })
    await page.evaluate(([a, ta, b, tb]) => localStorage.setItem('desk.swaps', JSON.stringify([{ id: a, token: ta }, { id: b, token: tb }])), [ID, TOKEN, B, TOKB])
    await page.goto(URL0, { waitUntil: 'load' })
    await page.waitForSelector('.xc-hist', { timeout: 20000 })
    await page.locator('.xc-hist').nth(0).tap()
    await page.waitForSelector('#xc-txhash', { timeout: 10000 })
    const first = await page.textContent('.xc-addr')
    await page.fill('#xc-txhash', '0x' + '33'.repeat(32))
    await page.tap('.xc-tx button:has-text("Submit")')
    await page.tap('.xc-actions button:has-text("New swap")')
    await page.waitForSelector('.xc-hist', { timeout: 10000 })
    await page.locator('.xc-hist').nth(1).tap()
    await page.waitForSelector('.xc-addr', { timeout: 10000 })
    await page.waitForTimeout(3500)                                             // A's submit answer has landed
    const addr = await page.textContent('.xc-addr').catch(() => '')
    t(eng, 'a late Submit answer for swap A never re-draws A over swap B', first === DEPA && addr === DEPB, JSON.stringify({ first, addr }))
    await browser.close()
  }
  // P4 no box before the swap is settled
  {
    const browser = await bt.launch()
    const ctx = await browser.newContext({ ...devices[device] })
    await overrideClient(ctx)
    const page = await ctx.newPage()
    await page.route('**/api/swaps', r => json(r, 200, { ok: true, swaps: [swapOf({ state: 'delivered_claimed' })] }))
    await page.route('**/api/swap?id=*', r => json(r, 200, { ok: true, swap: swapOf({ state: 'delivered_claimed' }) }))
    await page.goto(URL0, { waitUntil: 'load' })
    await page.evaluate(([id, tok]) => localStorage.setItem('desk.swaps', JSON.stringify([{ id, token: tok }])), [ID, TOKEN])
    await page.goto(URL0, { waitUntil: 'load' })
    await page.waitForSelector('.xc-hist', { timeout: 20000 }); await page.tap('.xc-hist'); await page.waitForTimeout(1200)
    t(eng, 'a swap still being confirmed shows no proof box', !(await page.$('.xc-proof')))
    await browser.close()
  }
}

await run('webkit', webkit, 'iPhone 14')
await run('chromium', chromium, 'Pixel 7')
console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) console.log('BROKE:\n  - ' + breaks.join('\n  - '))
process.exit(fail ? 1 : 0)
