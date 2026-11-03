// ============================================================
// near-intents-desk — MOBILE ROUND 9 (real WebKit + Chromium): the NEAR key checker on the page
// ============================================================
// Before a payout lands in a NEAR account, the preview shows who can sign for it (its
// full-access keys) and the "my own wallet" box asks the member to own every one.
// K1 is end to end: the real page, the real desk under `wrangler dev`, live 1Click and live
// NEAR mainnet (a dry preview: no address, no money). The rest answer the preview with crafted
// terms. Each check asserts the SAFE outcome; BROKE = a break.
//
//   npx wrangler dev --port 8797 --ip 127.0.0.1    then    node test/intents-mobile9.mjs
// ============================================================
import { overrideClient } from './intents-client-override.mjs'
const { webkit, chromium, devices } = await import('playwright')
const URL0 = 'http://127.0.0.1:8797/'
const EVM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const LIVE_ACCOUNT = 'nearhackathon.near'      // a real mainnet account with one full-access key (checked live)
const PK1 = 'ed25519:njV8oUZbvd1HswZiKL8j7zx2U1wnvaLQiysYDRPMBsF', PK2 = 'ed25519:oxEocH88sCavwDRXqoMtryK2Qm9Af72jxMsvsQGHQJx'

let pass = 0, fail = 0
const breaks = []
const t = (eng, name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  safe   [${eng}] ${name}`) }
  else { fail++; breaks.push(`[${eng}] ${name}`); console.log(`  BROKE  [${eng}] ${name}` + (extra ? '  — ' + String(extra).slice(0, 260) : '')) }
}
const blur = page => page.evaluate(() => document.activeElement && document.activeElement.blur())

async function session(bt, device) {
  const browser = await bt.launch()
  const ctx = await browser.newContext({ ...devices[device] })
  const ip = '10.98.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250)
  await overrideClient(ctx)
  await ctx.route('http://127.0.0.1:8797/api/**', route => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }))
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(URL0, { waitUntil: 'load' })
  await page.waitForFunction(() => document.getElementById('xc-status-pill')?.textContent === 'LIVE', null, { timeout: 20000 })
  return { browser, page, errors }
}
async function toNear(page, recipient) {
  await page.selectOption('#xc-to-chain', 'near'); await page.dispatchEvent('#xc-to-chain', 'change')
  await page.fill('#xc-recipient', recipient); await page.fill('#xc-refund', EVM)
  await page.fill('#xc-amount', '25'); await blur(page)
}
/** Answer dry previews with the desk's real terms, with `nearKeys` (and its warning) replaced. */
async function craft(page, nearKeys, warn) {
  await page.route('**/api/quote', async route => {
    const b = JSON.parse(route.request().postData() || '{}')
    if (!b.dry) return route.continue()
    const res = await route.fetch(); const j = await res.json()
    if (j.ok) {
      j.terms.nearKeys = nearKeys
      j.terms.risk.warn = j.terms.risk.warn.filter(w => !/^near_keys_/.test(w)).concat(warn ? [warn[0]] : [])
      j.terms.risk.text = j.terms.risk.text.filter(s => !/NEAR account/.test(s)).concat(warn ? [warn[1]] : [])
    }
    return route.fulfill({ status: res.status(), contentType: 'application/json', body: JSON.stringify(j) })
  })
}
const preview = page => page.textContent('#xc-preview').catch(() => '')
const ack2 = page => page.textContent('#xc-ack-address + *').catch(() => '')
const keyRows = page => page.$$eval('#xc-preview .xc-row.nearkey .v', els => els.map(e => e.textContent))
const waitTerms = page => page.waitForFunction(() => /Who controls|You receive/.test(document.getElementById('xc-preview')?.textContent || ''), null, { timeout: 20000 })

async function run(eng, bt, device) {
  console.log(`\n[${eng}: ${device} on ${bt.name()}]`)

  // ── K1 end to end: a real account's real key, from mainnet, through the desk
  {
    const { browser, page, errors } = await session(bt, device)
    await toNear(page, LIVE_ACCOUNT)
    await page.waitForFunction(a => (document.getElementById('xc-preview')?.textContent || '').includes('Who controls ' + a), LIVE_ACCOUNT, { timeout: 25000 }).catch(() => {})
    const pv = await preview(page), rows = await keyRows(page)
    t(eng, 'preview to a real NEAR account shows "Who controls" it', pv.includes('Who controls ' + LIVE_ACCOUNT), pv.slice(0, 300))
    t(eng, '…with its full-access key, as read from mainnet', rows.length >= 1 && rows.every(r => /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,}$/.test(r)), JSON.stringify(rows))
    t(eng, '…and the "my own wallet" box now covers the keys', /Every full-access key listed above is mine\./.test(await ack2(page)), await ack2(page))
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    t(eng, `a full key on a phone causes no sideways scroll (overflow ${over}px)`, over <= 0)
    t(eng, 'no page errors', errors.length === 0, errors.join(' | '))
    await browser.close()
  }

  // ── K2 a second full-access key: both listed, warned, the row marked
  {
    const { browser, page } = await session(bt, device)
    await craft(page, { account: 'alice.near', checked: true, full: [PK1, PK2], limited: 1, locked: false, fresh: false, tooMany: false, ethImplicit: false },
      ['near_keys_several', 'The receiving NEAR account has more than one full-access key (listed above).'])
    await toNear(page, 'alice.near'); await waitTerms(page)
    const rows = await keyRows(page)
    t(eng, 'two full-access keys → both listed in full', rows.length === 2 && rows.includes(PK1) && rows.includes(PK2), JSON.stringify(rows))
    t(eng, '…the count row is marked as a warning and names the app key', await page.$eval('#xc-preview .xc-row.warn', e => /2 full-access keys · 1 app key/.test(e.textContent)).catch(() => false))
    t(eng, '…and the warning is shown', /more than one full-access key/.test(await page.textContent('.xc-risk').catch(() => '')))
    t(eng, '…nothing can be accepted until both boxes are ticked', await page.isDisabled('#xc-go'))
    await browser.close()
  }

  // ── K3 a key that is not a key: shown as text, never as markup
  {
    const { browser, page } = await session(bt, device)
    await craft(page, { account: 'alice.near', checked: true, full: ['<img src=x onerror="window.__pwned=1">'], limited: 0, locked: false, fresh: false, tooMany: false, ethImplicit: false })
    await toNear(page, 'alice.near'); await waitTerms(page)
    await page.waitForTimeout(500)
    t(eng, 'a key carrying markup is rendered as text', (await page.$$('#xc-preview img')).length === 0 && !(await page.evaluate(() => window.__pwned)))
    await browser.close()
  }

  // ── K4 the check could not be made: said so, and the box does not claim keys were listed
  {
    const { browser, page } = await session(bt, device)
    await craft(page, { account: 'alice.near', checked: false }, ['near_keys_unchecked', 'Could not check who controls the receiving NEAR account right now.'])
    await toNear(page, 'alice.near'); await waitTerms(page)
    const pv = await preview(page)
    t(eng, 'check failed → "could not check right now", no key rows', /could not check right now/.test(pv) && (await keyRows(page)).length === 0, pv.slice(0, 200))
    t(eng, '…and the box does not mention keys that were never listed', !/full-access key/.test(await ack2(page)), await ack2(page))
    await browser.close()
  }

  // ── K5 locked / new accounts say what controls them
  {
    const { browser, page } = await session(bt, device)
    await craft(page, { account: 'vault.near', checked: true, full: [], limited: 0, locked: true, fresh: false, tooMany: false, ethImplicit: false }, ['near_keys_locked', 'The receiving NEAR account has no access keys.'])
    await toNear(page, 'vault.near'); await waitTerms(page)
    t(eng, 'a locked account → "only its smart contract"', /no keys: only its smart contract/.test(await preview(page)))
    await browser.close()
  }

  // ── K6 leaving NEAR: the key block goes with it
  {
    const { browser, page } = await session(bt, device)
    await craft(page, { account: 'alice.near', checked: true, full: [PK1], limited: 0, locked: false, fresh: false, tooMany: false, ethImplicit: false })
    await toNear(page, 'alice.near'); await waitTerms(page)
    await page.unroute('**/api/quote')
    await page.selectOption('#xc-to-chain', 'sol'); await page.dispatchEvent('#xc-to-chain', 'change')
    t(eng, 'while the new price loads, the boxes (still worded for the NEAR swap) cannot be ticked', await page.$eval('#xc-confirm', e => e.hidden || !e.offsetParent).catch(() => false))
    await page.fill('#xc-recipient', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'); await blur(page)
    const solana = await page.waitForFunction(() => /on Solana/.test(document.getElementById('xc-preview')?.textContent || ''), null, { timeout: 45000 }).then(() => true).catch(() => false)
    if (!solana) console.log(`  note   [${eng}] the live Solana price did not arrive in 45 s: ${(await page.textContent('#xc-msg').catch(() => '')).slice(0, 120)}`)
    else t(eng, 'payout moved to Solana → no NEAR key rows, box back to the plain wording', !/Who controls/.test(await preview(page)) && !/full-access key/.test(await ack2(page)), (await preview(page)).slice(0, 200))
    await browser.close()
  }
}

await run('iOS', webkit, 'iPhone 14')
await run('Android', chromium, 'Pixel 7')
console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) console.log(breaks.map(b => '  - ' + b).join('\n'))
process.exit(fail ? 1 : 0)
