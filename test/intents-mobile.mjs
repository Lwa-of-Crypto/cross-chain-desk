// ============================================================
// CRYPTO LWA · cross-chain desk — MOBILE ENGINES (real WebKit + Chromium)
// ============================================================
// iOS = Playwright's WebKit build with the iPhone 14 profile (same WebKit/JSC
// engine family as iOS Safari — not an iPhone itself). Android = Chromium with
// the Pixel 7 profile. Both drive the desk under `npx wrangler dev --port 8797` (real
// handlers + live 1Click). Every check asserts the SAFE outcome; BROKE = a break.
//
//   npx wrangler dev --port 8797   then   node test/intents-mobile.mjs
// ============================================================
import { fileURLToPath } from 'url'
import path from 'path'
import { overrideClient } from './intents-client-override.mjs'
const { webkit, chromium, devices } = await import('playwright')
const URL0 = 'http://127.0.0.1:8797/'

let pass = 0, fail = 0
const breaks = []
const t = (eng, name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  safe   [${eng}] ${name}`) }
  else { fail++; breaks.push(`[${eng}] ${name}`); console.log(`  BROKE  [${eng}] ${name}` + (extra ? '  — ' + String(extra).slice(0, 260) : '')) }
}

async function run(eng, browserType, device) {
  console.log(`\n[${eng}: ${device} on ${browserType.name()}]`)
  const browser = await browserType.launch()
  const ctx = await browser.newContext({ ...devices[device], acceptDownloads: true })
  // Only OUR api gets the test-member header — attached to third-party requests
  // (fonts, CoinGecko) it trips their CORS checks and shows up as console errors.
  const member = 'm1-' + eng.toLowerCase() + '-' + Date.now()
  await overrideClient(ctx)
  await ctx.route('http://127.0.0.1:8797/api/**', route => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': member } }))
  // Every security-policy violation from the first byte of every page load.
  await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)) })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  // Standalone page: no third-party request exists, so only an API answer's HTTP status (a 400 for a bad preview) is tolerated.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()) })
  await page.goto(URL0, { waitUntil: 'load' })
  await page.waitForFunction(() => document.getElementById('xc-status-pill')?.textContent !== 'LOADING', null, { timeout: 20000 })
  t(eng, 'desk loads and reaches the router (status LIVE)', (await page.textContent('#xc-status-pill')) === 'LIVE')

  // ── layout
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  t(eng, `no sideways scroll (overflow ${over}px)`, over <= 0)
  const small = await page.evaluate(() => [...document.querySelectorAll('#xc-desk button, #xc-desk select, #xc-desk input:not([type=checkbox])')]
    .filter(e => e.offsetParent).map(e => ({ id: e.id || e.textContent.trim().slice(0, 14), h: Math.round(e.getBoundingClientRect().height) })).filter(x => x.h < 44))
  t(eng, 'every visible control is at least 44 px tall (thumb-sized, as desk.css sets)', small.length === 0, JSON.stringify(small))
  const zoomy = await page.evaluate(() => [...document.querySelectorAll('#xc-desk input, #xc-desk select')].filter(e => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.id))
  t(eng, 'inputs are ≥16 px so iOS does not zoom the page on focus', zoomy.length === 0, zoomy.join(','))
  const attrs = await page.evaluate(() => ['xc-recipient', 'xc-refund'].map(id => { const e = document.getElementById(id); return { id, cap: e.getAttribute('autocapitalize'), cor: e.getAttribute('autocorrect'), spell: e.getAttribute('spellcheck') } }))
  t(eng, 'address fields turn OFF autocapitalize + autocorrect (iOS would turn "alice.near" into "Alice.near")',
    attrs.every(a => (a.cap === 'none' || a.cap === 'off') && a.cor === 'off' && a.spell === 'false'), JSON.stringify(attrs))

  // ── what mobile keyboards actually type
  const preview = async (amount, recipient, refund) => {
    await page.fill('#xc-amount', amount); await page.fill('#xc-recipient', recipient); await page.fill('#xc-refund', refund)
    await page.waitForTimeout(3500)
    return { msg: await page.textContent('#xc-msg'), preview: await page.textContent('#xc-preview'), amountField: await page.inputValue('#xc-amount'), rec: await page.inputValue('#xc-recipient') }
  }
  const SOLW = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', EVM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  const comma = await preview('35,5', SOLW, EVM)
  t(eng, 'decimal COMMA from a European keyboard ("35,5") is understood as 35.5', /35\.5 USDC/.test(comma.preview), comma.msg + ' | ' + comma.preview.slice(0, 80))
  const lrm = await preview('35', '‎' + SOLW + '‏\n', EVM)
  t(eng, 'invisible marks + newline pasted from a chat app are stripped (and shown stripped)', /You send/.test(lrm.preview) && lrm.rec === SOLW, JSON.stringify(lrm.rec) + ' | ' + lrm.msg)
  const fw = await preview('３５', SOLW, EVM)
  t(eng, 'full-width digits from a CJK keyboard ("３５") are read as 35', /35 USDC/.test(fw.preview), fw.msg)

  // ── tap through to a real deposit address
  await preview('35', SOLW, EVM)
  await page.tap('#xc-ack-amount'); await page.tap('#xc-ack-address')
  if (await page.isDisabled('#xc-go')) console.log('    DIAG go disabled · msg=' + JSON.stringify(await page.textContent('#xc-msg')) + ' · risk=' + JSON.stringify(await page.evaluate(() => (document.querySelector('.xc-risk') || {}).textContent || '')))
  t(eng, 'tapping both confirmations enables the button', !(await page.isDisabled('#xc-go')))
  await page.tap('#xc-go')
  await page.waitForSelector('.xc-addr', { timeout: 20000 })
  const addr = await page.textContent('.xc-addr')
  t(eng, 'a real deposit address is shown after the tap', /^0x[0-9a-fA-F]{40}$/.test(addr.trim()), addr)
  t(eng, 'the QR code rendered', await page.$('.xc-qr img, .xc-qr canvas') !== null)
  const sendLine = await page.textContent('.xc-amount-big')
  t(eng, '"Send exactly" shows the exact amount', /^35 USDC$/.test(sendLine.trim()), sendLine)
  const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null)
  await page.tap('text=Download receipt')
  const d = await dl
  t(eng, 'the receipt downloads as a .json file', !!d && /\.json$/.test(d.suggestedFilename()), d && d.suggestedFilename())

  // ── back/forward cache: leave and come back
  await page.goto('about:blank'); await page.goBack({ waitUntil: 'load' })
  await page.waitForTimeout(2500)
  const hist = await page.textContent('#xc-history')
  t(eng, 'after leaving and coming back the swap is still in history', /USDC/.test(hist) && /SOL/.test(hist), hist.slice(0, 80))

  // Standalone page: script-src/style-src 'self', no inline code. This page load
  // re-opened the swap card from history, so the QR code was drawn under the policy too.
  await page.tap('.xc-hist').catch(() => {})
  await page.waitForTimeout(1500)
  const blocked = await page.evaluate(() => window.__csp || ['no recorder'])
  const qr = await page.$('.xc-qr img, .xc-qr canvas')
  t(eng, 'the strict page security policy blocked nothing, and the QR code still rendered', blocked.length === 0 && !!qr, blocked.join(' | ') + ' qr=' + !!qr)
  t(eng, 'no JavaScript errors on the whole run', errors.length === 0, errors.slice(0, 3).join(' || '))
  await browser.close()
}

await run('iOS', webkit, 'iPhone 14')
await run('Android', chromium, 'Pixel 7')
console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) { console.log('\nBREAKS:'); for (const b of breaks) console.log('  - ' + b) }
process.exit(fail ? 1 : 0)
