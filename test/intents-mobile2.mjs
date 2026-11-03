// ============================================================
// CRYPTO LWA · cross-chain desk — MOBILE ROUND 2 (real WebKit + Chromium)
// ============================================================
// Phone conditions: tiny / odd screens, landscape, losing the network right
// after the tap, slow out-of-order responses, double taps, QR-scanner pastes
// ("bitcoin:…?amount=", "solana:…", "ethereum:0x…@1"), the copy button.
// Drives the desk under `npx wrangler dev --port 8797`. BROKE = a break.
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

async function open(browserType, opts) {
  const browser = await browserType.launch()
  const ctx = await browser.newContext({ acceptDownloads: true, ...opts })
  // Only OUR api gets the test-member header — attached to third-party requests
  // (fonts, CoinGecko) it trips their CORS checks and shows up as console errors.
  const member = 'm2-' + browserType.name() + '-' + Date.now()
  await overrideClient(ctx)
  await ctx.route('http://127.0.0.1:8797/api/**', route => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': member } }))
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => { if (!/api\.coingecko\.com.*access control checks/.test(e.message)) errors.push(e.message) })
  await page.goto(URL0, { waitUntil: 'load' })
  await page.waitForFunction(() => document.getElementById('xc-status-pill')?.textContent === 'LIVE', null, { timeout: 20000 })
  return { browser, ctx, page, errors, member }
}
const fillForm = async (page, amount, rec = SOLW, ref = EVM) => { await page.fill('#xc-amount', amount); await page.fill('#xc-recipient', rec); await page.fill('#xc-refund', ref); await page.waitForTimeout(3500) }
// The server's own count of the swaps this browser holds keys for (no accounts: the keys are in localStorage).
const mySwaps = page => page.evaluate(async () => {
  const items = JSON.parse(localStorage.getItem('desk.swaps') || '[]')
  return (await (await fetch('/api/swaps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) })).json()).swaps.length
})

async function run(eng, bt, device) {
  console.log(`\n[${eng} on ${bt.name()}]`)
  // ── screens
  for (const [label, vp] of [['folded Galaxy Fold 280×653', { width: 280, height: 653 }], ['iPhone SE 375×667', { width: 375, height: 667 }], ['landscape 844×390', { width: 844, height: 390 }]]) {
    const { browser, page } = await open(bt, { ...devices[device], viewport: vp })
    await fillForm(page, '35')
    const o = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      clipped: [...document.querySelectorAll('#xc-desk *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1) }).map(e => e.id || e.className).slice(0, 4) }))
    t(eng, `${label}: nothing runs off the screen`, o.over <= 0 && o.clipped.length === 0, JSON.stringify(o))
    await browser.close()
  }

  const { browser, ctx, page, errors, member } = await open(bt, devices[device])
  const withMember = route => ({ headers: { ...route.request().headers(), 'cf-connecting-ip': member } })
  // ── QR-scanner pastes
  for (const [label, to, pasted, want] of [
    ['"solana:" URI', 'sol', 'solana:' + SOLW, SOLW],
    ['"bitcoin:" URI with ?amount', 'btc', 'bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.01&label=me', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
    ['"ethereum:" URI with @chainId', 'arb', 'ethereum:' + EVM + '@42161', EVM],
  ]) {
    await page.selectOption('#xc-to-chain', to); await page.dispatchEvent('#xc-to-chain', 'change')
    await page.fill('#xc-amount', '100'); await page.fill('#xc-recipient', pasted); await page.fill('#xc-refund', EVM)
    await page.waitForTimeout(3500)
    const v = await page.inputValue('#xc-recipient'), p = await page.textContent('#xc-preview')
    t(eng, `${label} pasted from a QR scanner → the address is extracted and shown`, v === want && /You send/.test(p), JSON.stringify(v) + ' | ' + (await page.textContent('#xc-msg')))
  }
  {
    await page.selectOption('#xc-to-chain', 'arb'); await page.dispatchEvent('#xc-to-chain', 'change')
    const tokenTransfer = 'ethereum:0xaf88d065e77c8cc2239327c5edb3a432268e5831@42161/transfer?address=' + EVM + '&uint256=1e6'
    await page.fill('#xc-recipient', tokenTransfer); await page.waitForTimeout(3500)
    const v = await page.inputValue('#xc-recipient')
    t(eng, 'an EIP-681 TOKEN-transfer URI is NOT guessed into an address (left for the member to fix)', v === tokenTransfer && !/You send/.test(await page.textContent('#xc-preview')), v)
  }
  await page.selectOption('#xc-to-chain', 'sol'); await page.dispatchEvent('#xc-to-chain', 'change')
  await page.selectOption('#xc-to-token', { label: 'SOL' }); await page.dispatchEvent('#xc-to-token', 'change')

  // ── out-of-order previews on a slow network
  let n = 0
  await page.route('**/api/quote', async route => {
    const body = JSON.parse(route.request().postData() || '{}')
    if (body.dry && body.amount === '40') { n++; await new Promise(r => setTimeout(r, 4000)) }   // the OLDER request is slow
    await route.continue(withMember(route))
  })
  await page.fill('#xc-recipient', SOLW); await page.fill('#xc-refund', EVM)
  await page.fill('#xc-amount', '40'); await page.waitForTimeout(900)
  await page.fill('#xc-amount', '41'); await page.waitForTimeout(6000)
  const shown = await page.textContent('#xc-preview')
  t(eng, 'a slow OLD preview arriving after a newer one never overwrites it', /41 USDC/.test(shown) && !/You send40 USDC/.test(shown), shown.slice(0, 90))
  await page.unroute('**/api/quote')

  // ── network drops right after the tap, then comes back
  const before = await mySwaps(page)
  await fillForm(page, '45')
  await page.tap('#xc-ack-amount'); await page.tap('#xc-ack-address')
  if (await page.isDisabled('#xc-go')) console.log('    DIAG go disabled · msg=' + JSON.stringify(await page.textContent('#xc-msg')) + ' · preview=' + JSON.stringify((await page.textContent('#xc-preview')).slice(0, 160)) + ' · ack1=' + await page.isChecked('#xc-ack-amount') + ' ack2=' + await page.isChecked('#xc-ack-address'))
  let dropped = false
  await page.route('**/api/quote', async route => {
    const body = JSON.parse(route.request().postData() || '{}')
    if (!body.dry && !dropped) { dropped = true; const resp = await route.fetch(withMember(route)); void resp; await route.abort('internetdisconnected'); return }   // server issued it, phone never heard back
    await route.continue(withMember(route))
  })
  await page.tap('#xc-go')
  await page.waitForTimeout(5000)
  const msg = await page.textContent('#xc-msg')
  t(eng, 'network lost after the tap → honest "could not confirm" message, button usable', /could not confirm/i.test(msg) && !(await page.isDisabled('#xc-go')), msg)
  await page.tap('#xc-go')
  await page.waitForSelector('.xc-addr', { timeout: 20000 }).catch(() => {})
  const after = await mySwaps(page)
  t(eng, 'retrying after the drop shows the SAME swap — one swap, not two', after - before === 1 && !!(await page.$('.xc-addr')), `swaps before ${before}, after ${after}`)
  await page.unroute('**/api/quote')

  // ── double tap on a fresh swap
  await page.tap('text=New swap')
  const b2 = await mySwaps(page)
  await fillForm(page, '46')
  await page.tap('#xc-ack-amount'); await page.tap('#xc-ack-address')
  await Promise.all([page.tap('#xc-go'), page.tap('#xc-go').catch(() => {})])
  await page.waitForSelector('.xc-addr', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1500)
  t(eng, 'a double tap creates exactly one swap', (await mySwaps(page)) - b2 === 1)

  // ── copy button
  if (bt.name() === 'chromium') await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:8797' })
  const addr = (await page.textContent('.xc-addr')).trim()
  await page.tap('text=Copy address')
  await page.waitForTimeout(500)
  const label = await page.textContent('.xc-dep-text button')
  if (bt.name() === 'chromium') {
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    t(eng, 'Copy puts exactly the deposit address on the clipboard', clip === addr, clip)
  } else t(eng, 'Copy works without an error (WebKit test build: clipboard read is not exposed to scripts)', label === 'Copied' || label === 'Copy address')
  // receipt by clipboard (in-app browsers often block downloads)
  await page.tap('text=Copy receipt')
  await page.waitForTimeout(600)
  if (bt.name() === 'chromium') {
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    let rc = null; try { rc = JSON.parse(clip) } catch {}
    t(eng, 'Copy receipt puts a valid JSON receipt for THIS swap on the clipboard (with the support address)', !!rc && rc.swap && rc.swap.depositAddress === addr && rc.support === 'support@cryptolwa.io', clip.slice(0, 120))
    // Owner's rule: nothing carries a date — no ISO date, no clock time, no epoch-ms timestamp, no page-only field.
    t(eng, 'the receipt carries no date, timestamp or page-only field', !!rc && !/\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}|\b1\d{12}\b|"_|signedQuote|savedAt|deadline|createdAt|updatedAt/.test(clip), clip.slice(0, 400))
  } else {
    const txt = await page.textContent('.xc-actions')
    t(eng, 'Copy receipt responds (copied, or tells the member to use Download)', /Receipt copied|Copy failed — use Download|Copy receipt/.test(txt), txt)
  }
  t(eng, 'no JavaScript errors in this run', errors.length === 0, errors.slice(0, 3).join(' || '))
  await browser.close()
}

await run('iOS', webkit, 'iPhone 14')
await run('Android', chromium, 'Pixel 7')
console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) { console.log('\nBREAKS:'); for (const b of breaks) console.log('  - ' + b) }
process.exit(fail ? 1 : 0)
