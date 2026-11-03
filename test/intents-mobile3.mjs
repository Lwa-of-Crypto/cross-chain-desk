// ============================================================
// CRYPTO LWA · cross-chain desk — MOBILE ROUND 3 (real WebKit + Chromium)
// ============================================================
// Written for the four client guards the client mutation campaign showed NO test
// protected (intents-mutation-client.mjs). Each check asserts on what
// the page SENDS to the server — not on what the input box shows, which is how the
// existing EIP-681 check missed its mutant (reflect() never rewrites a FOCUSED field).
// Drives the desk under `npx wrangler dev --port 8797`. BROKE = a break.
//
//   npx wrangler dev --port 8797   then   node test/intents-mobile3.mjs
// ============================================================
import { fileURLToPath } from 'url'
import path from 'path'
import { overrideClient } from './intents-client-override.mjs'
const { webkit, chromium, devices } = await import('playwright')
const URL0 = 'http://127.0.0.1:8797/'
const SOLW = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', EVM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'

let pass = 0, fail = 0
const breaks = []
const t = (eng, name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  safe   [${eng}] ${name}`) }
  else { fail++; breaks.push(`[${eng}] ${name}`); console.log(`  BROKE  [${eng}] ${name}` + (extra ? '  — ' + String(extra).slice(0, 260) : '')) }
}

async function open(bt, opts) {
  const browser = await bt.launch()
  const ctx = await browser.newContext({ ...opts })
  const member = 'm3-' + bt.name() + '-' + Date.now()
  await overrideClient(ctx)
  await ctx.route('http://127.0.0.1:8797/api/**', route => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': member } }))
  const page = await ctx.newPage()
  // Every quote request the page sends, as the server would receive it.
  const sent = []
  await page.route('**/api/quote', route => {
    try { sent.push(JSON.parse(route.request().postData() || '{}')) } catch { sent.push({ unparsable: true }) }
    return route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': member } })
  })
  await page.goto(URL0, { waitUntil: 'load' })
  await page.waitForFunction(() => document.getElementById('xc-status-pill')?.textContent === 'LIVE', null, { timeout: 20000 })
  return { browser, page, sent }
}
const blur = page => page.evaluate(() => document.activeElement && document.activeElement.blur())
const previewShown = async page => /You send/.test(await page.textContent('#xc-preview'))

async function run(eng, bt, device) {
  console.log(`\n[${eng}: ${device} on ${bt.name()}]`)
  const { browser, page, sent } = await open(bt, devices[device])

  // ── A. invisible marks inside an AMOUNT (addresses were tested; amounts were not)
  for (const [label, typed] of [['zero-width space', '1​00'], ['soft hyphen', '10­0'], ['word joiner', '100⁠'], ['BOM', '﻿100']]) {
    sent.length = 0
    await page.fill('#xc-amount', typed); await page.fill('#xc-recipient', SOLW); await page.fill('#xc-refund', EVM)
    await blur(page); await page.waitForTimeout(3500)
    const amounts = sent.filter(b => b.dry).map(b => b.amount)
    t(eng, `amount typed with a ${label} → sent to the server as exactly "100"`, amounts.length > 0 && amounts.every(a => a === '100'), JSON.stringify(amounts))
  }

  // ── B. an EIP-681 token-transfer URI must never become the TOKEN CONTRACT as recipient
  {
    await page.selectOption('#xc-to-chain', 'arb'); await page.dispatchEvent('#xc-to-chain', 'change')
    const TOKEN = '0x1111111111111111111111111111111111111111'      // a contract the desk does not list: the server only WARNS on unknown contracts
    const uri = 'ethereum:' + TOKEN + '@42161/transfer?address=' + EVM + '&uint256=1e6'
    sent.length = 0
    await page.fill('#xc-amount', '100'); await page.fill('#xc-recipient', uri); await page.fill('#xc-refund', EVM)
    await blur(page); await page.waitForTimeout(3500)
    const recips = sent.map(b => String(b.recipient || '').toLowerCase())
    t(eng, 'EIP-681 token-transfer URI → the token contract is NEVER sent as the recipient', !recips.includes(TOKEN), JSON.stringify(recips))
    t(eng, '…the field still shows exactly what was pasted after leaving it', (await page.inputValue('#xc-recipient')) === uri, await page.inputValue('#xc-recipient'))
    await page.selectOption('#xc-to-chain', 'sol'); await page.dispatchEvent('#xc-to-chain', 'change')
    await page.selectOption('#xc-to-token', { label: 'SOL' }); await page.dispatchEvent('#xc-to-token', 'change')
  }

  // ── C. both acknowledgements, every time
  {
    await page.fill('#xc-amount', '47'); await page.fill('#xc-recipient', SOLW); await page.fill('#xc-refund', EVM)
    await blur(page); await page.waitForTimeout(3500)
    const live = await previewShown(page)
    t(eng, 'a live preview is showing (precondition)', live, await page.textContent('#xc-msg'))
    const g0 = await page.isDisabled('#xc-go')
    await page.tap('#xc-ack-amount'); const g1 = await page.isDisabled('#xc-go')
    await page.tap('#xc-ack-address'); const g2 = await page.isDisabled('#xc-go')
    await page.tap('#xc-ack-amount'); const g3 = await page.isDisabled('#xc-go')
    t(eng, '"Get deposit address" stays disabled with NO acknowledgement', g0)
    t(eng, '…stays disabled with only the amount acknowledged', g1)
    t(eng, '…is enabled only once BOTH are acknowledged', live ? !g2 : true, 'disabled=' + g2)
    t(eng, '…and disables again when one is un-ticked', g3)
    await page.tap('#xc-ack-amount')
  }

  // ── D. the form changes WITHOUT an "input" event (autofill / password managers set
  //       .value and fire only "change", or nothing) after both boxes are ticked
  for (const [label, how] of [['"change" event only', 'change'], ['no event at all', 'none']]) {
    if (await page.isDisabled('#xc-go')) {               // re-arm: fresh preview + both acks
      await page.fill('#xc-amount', '47'); await blur(page); await page.waitForTimeout(3500)
      await page.tap('#xc-ack-amount'); await page.tap('#xc-ack-address')
    }
    const armed = !(await page.isDisabled('#xc-go'))
    sent.length = 0
    await page.evaluate(h => { const a = document.getElementById('xc-amount'); a.value = '470'; if (h === 'change') a.dispatchEvent(new Event('change', { bubbles: true })) }, how)
    await page.tap('#xc-go').catch(() => {})
    await page.waitForTimeout(2500)
    const issued = sent.filter(b => b.dry === false)
    t(eng, `amount changed by autofill (${label}) after both ticks → NO deposit address requested for terms nobody saw`, armed ? issued.length === 0 : false,
      armed ? JSON.stringify(issued.map(b => b.amount)) : 'precondition failed: button never armed')
    await page.fill('#xc-amount', '47'); await blur(page); await page.waitForTimeout(3500)
  }

  // ── D2. standalone desk: the Worker's catch-all answers 500 {error:'internal'} — the
  //        outcome is UNKNOWN (it may have issued). Pressing again must resend the SAME
  //        request key, so the server can only hand back that one swap.
  {
    await page.fill('#xc-amount', '47'); await page.fill('#xc-recipient', SOLW); await page.fill('#xc-refund', EVM)
    await blur(page); await page.waitForTimeout(3500)
    if (await page.isDisabled('#xc-go')) { await page.tap('#xc-ack-amount'); await page.tap('#xc-ack-address') }
    const keys = []
    const q = async route => {
      const b = JSON.parse(route.request().postData() || '{}')
      if (b.dry === false) { keys.push(b.idempotencyKey); return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'internal', message: 'Something went wrong and we could not confirm the result.' }) }) }
      return route.fallback()
    }
    await page.route('**/api/quote', q)
    const armed = !(await page.isDisabled('#xc-go'))
    await page.tap('#xc-go').catch(() => {}); await page.waitForTimeout(1500)
    await page.tap('#xc-go').catch(() => {}); await page.waitForTimeout(1500)
    await page.unroute('**/api/quote', q)
    t(eng, 'server answers "internal" (outcome unknown) → pressing again resends the SAME request key', armed && keys.length === 2 && !!keys[0] && keys[0] === keys[1], JSON.stringify({ armed, keys }))
    // Round 13: an edit after an unknown outcome used to drop the key, so the next press
    // minted a second swap while the first one's key never arrived. The form stays locked.
    const locked = await page.evaluate(() => ['xc-amount', 'xc-recipient', 'xc-refund', 'xc-slippage'].every(id => document.getElementById(id).disabled))
    t(eng, 'after an unknown outcome the form is locked: no edit can drop the request key', locked && !(await page.isDisabled('#xc-go')), String(locked))
    // A reload is the way to start over: the page resends the request in doubt, and its answer (a swap
    // card) takes as long as live 1Click does. Wait for the card or a free form, not a fixed time.
    await page.goto(URL0, { waitUntil: 'load' })
    await page.waitForFunction(() => !document.getElementById('xc-card')?.hidden || !document.getElementById('xc-amount')?.disabled, null, { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(300)
  }

  // ── E–H. the swap CARD, fed a crafted swap: the "get address" answer and the status
  //         feed are both answered by the test, so the client's own guards are all
  //         that stands between the member and a wrong screen.
  const DEP = '0x2222222222222222222222222222222222222222'
  const baseSwap = over => ({ id: 'sw_' + Math.random().toString(36).slice(2), rev: 0,
    fromAsset: 'x', toAsset: 'y', fromChain: 'base', toChain: 'sol', fromDecimals: 6, toDecimals: 9, fromSymbol: 'USDC', toSymbol: 'SOL',
    amountIn: '47000000', amountOut: '200000000', minAmountOut: '199000000', recipient: SOLW, refundTo: EVM,
    depositAddress: DEP, secondsLeft: 3600, state: 'awaiting_deposit', originTxs: [], destTxs: [], ...over })
  async function openCard(sw) {
    if (await page.$('text=New swap')) { await page.tap('text=New swap'); await page.waitForTimeout(300) }
    await page.fill('#xc-amount', '47'); await page.fill('#xc-recipient', SOLW); await page.fill('#xc-refund', EVM)
    await blur(page); await page.waitForTimeout(3500)
    await page.tap('#xc-ack-amount'); await page.tap('#xc-ack-address')
    // The issue answer carries the swap's access key, as the real server's does; every
    // status poll the page then makes is recorded with the key header it carried.
    const TOKEN = 'ab'.repeat(32), polls = []
    const q = async route => {
      const b = JSON.parse(route.request().postData() || '{}')
      if (b.dry === false) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, swap: sw, token: TOKEN }) })
      return route.fallback()
    }
    const s = route => { polls.push(route.request().headers()['x-swap-token'] || null); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, swap: sw }) }) }
    await page.route('**/api/quote', q); await page.route('**/api/swap?id=*', s)
    const armed = !(await page.isDisabled('#xc-go'))
    await page.tap('#xc-go')
    await page.waitForSelector('#xc-card:not([hidden])', { timeout: 10000 }).catch(() => {})
    return { armed, polls, TOKEN, done: async () => { await page.unroute('**/api/quote', q); await page.unroute('**/api/swap?id=*', s) } }
  }
  const cardText = () => page.textContent('#xc-card').catch(() => '')

  // E. left open past the deadline while the feed still says "awaiting"
  {
    const c = await openCard(baseSwap({ secondsLeft: 6 }))
    const before = await page.$('.xc-addr') ? (await page.textContent('.xc-addr')).trim() : null
    await page.waitForTimeout(8500)
    const after = await page.$('.xc-addr') ? (await page.textContent('.xc-addr')).trim() : null
    t(eng, 'deposit address shown while alive (precondition)', c.armed && before === DEP, before)
    // The accepted terms must not outlive the swap they produced: if the boxes stayed
    // ticked, the next form shown (history, "New swap") would start already "agreed".
    const acks = await page.evaluate(() => [document.getElementById('xc-ack-amount').checked, document.getElementById('xc-ack-address').checked])
    t(eng, 'once the swap card opens, both acknowledgements are cleared (accepted terms do not carry over)', !acks[0] && !acks[1], JSON.stringify(acks))
    t(eng, 'card left open past the deadline → the address is taken away, even though the feed still says "awaiting"', after === null && /expired/i.test(await cardText()), JSON.stringify(after) + ' | ' + (await cardText()).slice(0, 120))
    await c.done()
  }

  // F. markup in a server string is shown as text, never run
  {
    const evil = '<img src=x onerror="window.__xc_xss=1"><b id=xc-injected>X</b>'
    const c = await openCard(baseSwap({ fromSymbol: evil, toSymbol: evil }))
    await page.waitForTimeout(1500)
    // The card has a legitimate <img>: the deposit-address QR (a data: URL). Only an
    // image the payload made — src "x" or any on* handler attribute — is an injection.
    const r = await page.evaluate(() => ({ ran: !!window.__xc_xss, b: !!document.getElementById('xc-injected'),
      imgs: [...document.querySelectorAll('#xc-card img')].map(i => ({ src: (i.getAttribute('src') || '').slice(0, 30), on: [...i.attributes].some(a => /^on/i.test(a.name)) })) }))
    const injectedImg = r.imgs.some(i => i.on || i.src === 'x')
    console.log('    card images: ' + JSON.stringify(r.imgs))
    t(eng, 'HTML in a server-sent symbol → shown as text: no script ran, no element injected', c.armed && !r.ran && !r.b && !injectedImg, JSON.stringify(r))
    t(eng, '…and the raw text is visible to the member', (await cardText()).includes('<img src=x'), (await cardText()).slice(0, 120))
    await c.done()
  }

  // G. "send exactly" uses the decimals FROZEN in the swap, never a token-list guess
  {
    const c = await openCard(baseSwap({ fromAsset: 'nep141:not-in-the-token-list.near', fromDecimals: 6, amountIn: '47000000' }))
    await page.waitForTimeout(1000)
    const big = await page.$('.xc-amount-big') ? (await page.textContent('.xc-amount-big')).trim() : ''
    t(eng, 'token missing from the list → still "send exactly 47 USDC" from the swap\'s own decimals', c.armed && /^47(\.0+)? USDC$/.test(big), JSON.stringify(big))
    await c.done()
  }

  // H. a partial deposit asks only for the REST (paying the full amount again overpays)
  {
    const c = await openCard(baseSwap({ state: 'incomplete_deposit', deposited: '20000000' }))
    await page.waitForTimeout(1000)
    const text = await cardText(), big = await page.$('.xc-amount-big') ? (await page.textContent('.xc-amount-big')).trim() : ''
    t(eng, '20 of 47 USDC arrived → asks for the remaining 27 USDC, not 47 again', c.armed && /^27(\.0+)? USDC$/.test(big) && /Received so far: 20/.test(text), JSON.stringify(big) + ' | ' + text.slice(0, 140))
    await c.done()
  }

  // I. standalone desk: the status poll must present the swap's access key (without it
  //    the real server answers 404 and the card can never move past "waiting").
  {
    const c = await openCard(baseSwap({}))
    await page.waitForTimeout(11500)                     // the first poll fires 10 s after the card opens
    t(eng, 'status polls carry the swap’s access key in the x-swap-token header', c.armed && c.polls.length >= 1 && c.polls.every(h => h === c.TOKEN), JSON.stringify(c.polls))
    await c.done()
  }
  await browser.close()
}

await run('iOS', webkit, 'iPhone 14')
await run('Android', chromium, 'Pixel 7')
console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) { console.log('\nBREAKS:'); for (const b of breaks) console.log('  - ' + b) }
process.exit(fail ? 1 : 0)
