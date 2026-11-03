// ============================================================
// near-intents-desk — MOBILE ROUND 10 (real WebKit + Chromium): "Connect wallet" on the form
// ============================================================
// A scripted EIP-1193 wallet (announced by EIP-6963, with accountsChanged events) logs every
// request. Connecting may ask for ONE thing, the address (eth_requestAccounts), and only when the
// member presses Connect. It fills the refund field only when empty and only for an EVM sending
// chain; the receiving field only on an explicit press; it never rewrites a field on its own and
// never stores the address. Each case asserts the SAFE outcome.
//   npx wrangler dev --port 8797 --ip 127.0.0.1    then    node test/intents-mobile10.mjs
// ============================================================
import { overrideClient } from './intents-client-override.mjs'
const { webkit, chromium, devices } = await import('playwright')
const URL0 = 'http://127.0.0.1:8797/'
const ME = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const OTHER = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359'
const TYPED = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB'

let pass = 0, fail = 0
const breaks = []
const t = (eng, name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  safe   [${eng}] ${name}`) }
  else { fail++; breaks.push(`[${eng}] ${name}`); console.log(`  BROKE  [${eng}] ${name}` + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const J = o => JSON.stringify(o)

function walletScript({ wallets }) {
  window.__W = { calls: [], mode: {}, listeners: {} }
  const make = (name) => ({
    on(ev, fn) { (window.__W.listeners[ev] = window.__W.listeners[ev] || []).push(fn) },
    removeListener(ev, fn) { window.__W.listeners[ev] = (window.__W.listeners[ev] || []).filter(f => f !== fn) },
    request: async ({ method, params }) => {
      const W = window.__W, m = W.mode
      W.calls.push({ w: name, method, params: params === undefined ? null : JSON.parse(JSON.stringify(params)) })
      if (method === 'eth_requestAccounts') {
        if (m.accountsDelay) await new Promise(r => setTimeout(r, m.accountsDelay))
        if (m.rejectAccounts) throw { code: 4001, message: 'User rejected' }
        if (m.noAccount) return []
        if (m.badAccount) return ['not-an-address']
        return [m.account || '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed']
      }
      throw { code: 4200, message: 'Unsupported method ' + method }
    },
  })
  const provs = wallets.map(w => ({ info: { uuid: w.uuid, name: w.name, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'test.' + w.uuid }, provider: make(w.name) }))
  window.__W.emit = (ev, arg) => (window.__W.listeners[ev] || []).forEach(f => f(arg))
  const announce = () => provs.forEach(d => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze(d) })))
  window.addEventListener('eip6963:requestProvider', announce)
}

async function open(bt, device, { wallets = [{ name: 'Test Wallet', uuid: 'w1' }] } = {}) {
  const browser = await bt.launch()
  const ctx = await browser.newContext({ ...devices[device] })
  const ip = '10.96.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250)
  await overrideClient(ctx)
  await ctx.route('http://127.0.0.1:8797/api/**', route => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }))
  await ctx.addInitScript(walletScript, { wallets })
  const page = await ctx.newPage()
  await page.goto(URL0, { waitUntil: 'load' })
  await page.waitForFunction(() => document.getElementById('xc-status-pill')?.textContent === 'LIVE', null, { timeout: 20000 })
  await page.waitForFunction(() => document.getElementById('xc-connect')?.textContent.length > 0, null, { timeout: 5000 }).catch(() => {})
  return { browser, page }
}
const calls = page => page.evaluate(() => window.__W.calls)
const mode = (page, m) => page.evaluate(m => { window.__W.mode = m }, m)
const box = page => page.textContent('#xc-connect').catch(() => '')
const val = (page, id) => page.inputValue('#' + id)
const btnByText = (page, re) => page.$$eval('#xc-connect button', (bs, src) => { const r = new RegExp(src); const i = bs.findIndex(b => r.test(b.textContent)); return i }, re.source)
async function tapText(page, re) { const i = await btnByText(page, re); if (i < 0) return false; await (await page.$$('#xc-connect button'))[i].tap(); return true }
async function chain(page, which, id) { await page.selectOption('#xc-' + which + '-chain', id); await page.waitForTimeout(150) }
async function connect(page) { await tapText(page, /^Connect /); await page.waitForFunction(() => /Connected:/.test(document.getElementById('xc-connect').textContent), null, { timeout: 5000 }).catch(() => {}) }

async function run(eng, bt, device) {
  console.log(`\n[${eng}: ${device} on ${bt.name()}]`)

  // ── C1 a phone browser with no wallet: links that open this page in the wallet app, nothing else
  {
    const { browser, page } = await open(bt, device, { wallets: [] })
    const n = await page.$$eval('#xc-connect button', bs => bs.length)
    const links = await page.$$eval('#xc-connect a', as => as.map(a => ({ text: a.textContent, href: a.getAttribute('href'), rel: a.rel, h: a.getBoundingClientRect().height })))
    const host = new URL(URL0).host
    t(eng, 'no wallet on a phone: no connect button', n === 0, n)
    t(eng, '…"Open in MetaMask" = MetaMask\'s documented link to this page only',
      links.some(l => l.text === 'Open in MetaMask' && l.href === 'https://link.metamask.io/dapp/' + host + '/'), J(links))
    t(eng, '…"Open in Base app" = Coinbase Wallet\'s documented link to this page only',
      links.some(l => l.text === 'Open in Base app' && l.href === 'https://go.cb-w.com/dapp?cb_url=' + encodeURIComponent('https://' + host + '/')), J(links))
    t(eng, '…exactly those two links, each noopener noreferrer, each a 44 px tap target',
      links.length === 2 && links.every(l => /noopener/.test(l.rel) && /noreferrer/.test(l.rel) && l.h >= 44), J(links))
    t(eng, '…and it says to start the swap there (a swap stays in the browser it was made in)', /start your swap there/.test(await box(page)), await box(page))
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    t(eng, '…with no sideways scroll on the phone', ov <= 0, ov)
    // Once a swap's card replaces the form, leaving for the wallet app would strand the swap here.
    await page.evaluate(() => { document.getElementById('xc-form').hidden = true })
    await page.dispatchEvent('#xc-to-chain', 'change'); await page.waitForTimeout(150)
    const after = await page.$$eval('#xc-connect a', as => as.length)
    t(eng, 'no "Open in…" links once the form is replaced by a swap card', after === 0, await box(page))
    await browser.close()
  }

  // ── C1b a desktop browser with no wallet: the plain message, no app links
  {
    const { browser, page } = await open(bt, bt === webkit ? 'Desktop Safari' : 'Desktop Chrome', { wallets: [] })
    const nl = await page.$$eval('#xc-connect a', as => as.length)
    t(eng, 'no wallet on a computer: "No browser wallet found", no app links', /No browser wallet found/.test(await box(page)) && nl === 0, await box(page))
    await browser.close()
  }

  // ── C2–C3 one wallet: nothing asked on load; Connect asks for the address only and fills the empty refund field
  {
    const { browser, page } = await open(bt, device)
    t(eng, 'the button names the wallet ("Connect Test Wallet")', (await btnByText(page, /^Connect Test Wallet$/)) >= 0, await box(page))
    t(eng, 'inside a wallet app (a wallet is found) no "Open in…" links are shown', (await page.$$eval('#xc-connect a', as => as.length)) === 0)
    t(eng, 'the page asked the wallet NOTHING before Connect was pressed', (await calls(page)).length === 0, J(await calls(page)))
    const h = await page.$eval('#xc-connect button', b => b.getBoundingClientRect().height)
    t(eng, 'the Connect button is a 44 px tap target', h >= 44, h)
    await connect(page)
    const cs = await calls(page)
    t(eng, 'connecting asked for ONE thing: eth_requestAccounts', cs.length === 1 && cs[0].method === 'eth_requestAccounts', J(cs))
    t(eng, 'the empty refund field (sending on Base) now holds the wallet address', (await val(page, 'xc-refund')) === ME, await val(page, 'xc-refund'))
    t(eng, 'the receiving field was NOT filled (receiving on Solana)', (await val(page, 'xc-recipient')) === '', await val(page, 'xc-recipient'))
    t(eng, 'it says what the page sees: "Connected: Test Wallet · 0x5aAe…eAed", one transfer later, nothing else', /Connected: Test Wallet · 0x5aAe…eAed/.test(await box(page)) && /one transfer/.test(await box(page)), await box(page))
    const stored = await page.evaluate(() => JSON.stringify(Object.assign({}, localStorage)) + JSON.stringify(Object.assign({}, sessionStorage)))
    t(eng, 'the address is not stored anywhere (localStorage / sessionStorage)', !stored.toLowerCase().includes(ME.toLowerCase().slice(2)), stored.slice(0, 200))
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    t(eng, 'no sideways scroll at phone width with the connect box', over <= 1, over)

    // ── C4 receiving on an EVM chain: offered by a press, with the smart-wallet warning
    await chain(page, 'to', 'arb')
    t(eng, 'receiving on Arbitrum: "Receive to 0x5aAe…eAed" offered, with the multisig / smart-wallet warning', (await btnByText(page, /^Receive to 0x5aAe…eAed$/)) >= 0 && /multisig or smart wallet/.test(await box(page)), await box(page))
    t(eng, '…but the receiving field is still empty until pressed', (await val(page, 'xc-recipient')) === '')
    await tapText(page, /^Receive to /)
    t(eng, 'pressing it fills the receiving field', (await val(page, 'xc-recipient')) === ME, await val(page, 'xc-recipient'))
    t(eng, '…and the button and warning go away', (await btnByText(page, /^Receive to /)) < 0 && !/multisig or smart wallet/.test(await box(page)), await box(page))

    // ── C5 the wallet switches account: label changes, NO field changes
    await page.evaluate(a => window.__W.emit('accountsChanged', [a]), OTHER)
    await page.waitForTimeout(200)
    t(eng, 'wallet switched account: the page says so', /switched to 0xfB69…d359/.test(await box(page)) && /not changed/.test(await box(page)), await box(page))
    t(eng, '…and neither address field was rewritten', (await val(page, 'xc-refund')) === ME && (await val(page, 'xc-recipient')) === ME, (await val(page, 'xc-refund')) + ' ' + (await val(page, 'xc-recipient')))
    t(eng, '…but offers "Refund to" the new account, by a press', (await btnByText(page, /^Refund to 0xfB69…d359$/)) >= 0, await box(page))

    // ── C6 sending on a non-EVM chain: refund cleared (as before) and NOT refilled; back on EVM: refilled
    await chain(page, 'from', 'sol')
    t(eng, 'sending on Solana: the refund field is empty and NOT filled with an EVM address', (await val(page, 'xc-refund')) === '', await val(page, 'xc-refund'))
    t(eng, '…and it says to paste the Solana refund address', /You send on Solana/.test(await box(page)), await box(page))
    await chain(page, 'from', 'base')
    t(eng, 'back to Base: the emptied refund field is filled with the connected account', (await val(page, 'xc-refund')) === OTHER, await val(page, 'xc-refund'))

    // ── C7 disconnect: forgotten, fields untouched, Connect offered again
    await tapText(page, /^Disconnect$/)
    t(eng, 'Disconnect: forgotten, fields unchanged, Connect offered again', /Forgotten/.test(await box(page)) && (await val(page, 'xc-refund')) === OTHER && (await btnByText(page, /^Connect /)) >= 0, await box(page))
    await page.evaluate(a => window.__W.emit('accountsChanged', [a]), ME)
    await page.waitForTimeout(150)
    t(eng, 'after Disconnect a wallet event changes nothing', (await val(page, 'xc-refund')) === OTHER && !/Connected:/.test(await box(page)), await box(page))
    t(eng, 'the page never asked for anything but the address (no signature, no transaction)', (await calls(page)).every(c => c.method === 'eth_requestAccounts'), J((await calls(page)).map(c => c.method)))
    await browser.close()
  }

  // ── C8 a refund address already typed is never overwritten by Connect
  {
    const { browser, page } = await open(bt, device)
    await page.fill('#xc-refund', TYPED)
    await connect(page)
    t(eng, 'a typed refund address is kept when the wallet connects', (await val(page, 'xc-refund')) === TYPED, await val(page, 'xc-refund'))
    t(eng, '…and "Refund to" the wallet is offered instead', (await btnByText(page, /^Refund to 0x5aAe…eAed$/)) >= 0, await box(page))
    await browser.close()
  }

  // ── C9 cancelled in the wallet: nothing shared, nothing filled
  {
    const { browser, page } = await open(bt, device)
    await mode(page, { rejectAccounts: true })
    await tapText(page, /^Connect /)
    await page.waitForTimeout(400)
    t(eng, 'cancelled: "Nothing was shared", refund empty, not connected', /Nothing was shared/.test(await box(page)) && (await val(page, 'xc-refund')) === '' && !/Connected:/.test(await box(page)), await box(page))
    await mode(page, { noAccount: true })
    await tapText(page, /^Connect /)
    await page.waitForTimeout(400)
    t(eng, 'a wallet that shares no address: "did not share", nothing filled', /did not share an address/.test(await box(page)) && (await val(page, 'xc-refund')) === '', await box(page))
    await mode(page, { badAccount: true })
    await tapText(page, /^Connect /)
    await page.waitForTimeout(400)
    t(eng, 'a wallet that answers something that is not an address: refused, nothing filled', /did not share an address/.test(await box(page)) && (await val(page, 'xc-refund')) === '' && !/Connected:/.test(await box(page)), await box(page))
    await browser.close()
  }

  // ── C12 a deposit request in doubt (reloaded tab): connecting must not touch the form
  {
    const { browser, page } = await open(bt, device)
    const body = { from: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', to: 'nep141:sol.omft.near', amount: '25',
      recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', refundTo: TYPED, slippageBps: 100, dry: false, idempotencyKey: 'k'.repeat(24), acceptedAmountOut: '1' }
    await page.route('**/api/quote', r => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'internal', message: 'internal' }) }))
    await page.evaluate(b => sessionStorage.setItem('desk.pending', JSON.stringify({ idem: b.idempotencyKey, body: b, at: Date.now() })), body)
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(() => /unconfirmed/.test(document.getElementById('xc-msg')?.textContent || ''), null, { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(800)
    const dis = await page.$eval('#xc-connect button', b => b.disabled).catch(() => null)
    t(eng, 'request in doubt: the Connect button is disabled', dis === true, String(dis))
    await page.$eval('#xc-connect button', x => { x.disabled = false; x.click() })
    await page.waitForTimeout(600)
    t(eng, '…a forced Connect does not fill the refund field', (await val(page, 'xc-refund')) === '', await val(page, 'xc-refund'))
    // Redrawn while still in doubt (the wallet answered, then switched account): every button stays disabled.
    await page.evaluate(a => window.__W.emit('accountsChanged', [a]), OTHER)
    await page.waitForTimeout(200)
    const all = await page.$$eval('#xc-connect button', bs => bs.map(b => b.textContent + ':' + b.disabled))
    t(eng, '…and after a redraw every connect button is still disabled', all.length > 0 && all.every(s => s.endsWith(':true')), J(all))
    const i = await btnByText(page, /^Refund to /)
    if (i >= 0) await page.$$eval('#xc-connect button', (bs, i) => { bs[i].disabled = false; bs[i].click() }, i)
    await page.waitForTimeout(300)
    t(eng, '…nor does a forced "Refund to" press', i >= 0 && (await val(page, 'xc-refund')) === '', `button ${i}, refund "${await val(page, 'xc-refund')}"`)
    await browser.close()
  }

  // ── C10 a second press while the wallet is open asks once
  {
    const { browser, page } = await open(bt, device)
    await mode(page, { accountsDelay: 1500 })
    await tapText(page, /^Connect /)
    await page.waitForTimeout(100)
    const b = await page.$('#xc-connect button')
    t(eng, 'while the wallet is open the button says "Waiting for your wallet…" and is disabled', !!b && /Waiting for your wallet/.test(await b.textContent()) && await b.isDisabled(), b && await b.textContent())
    await page.$eval('#xc-connect button', x => { x.disabled = false; x.click() })
    await page.waitForTimeout(1800)
    t(eng, '…and a forced second press still asks the wallet only once', (await calls(page)).filter(c => c.method === 'eth_requestAccounts').length === 1, J(await calls(page)))
    await browser.close()
  }

  // ── C11 two wallets: one button each, and the right one is asked
  {
    const { browser, page } = await open(bt, device, { wallets: [{ name: 'Alpha', uuid: 'a' }, { name: 'Beta', uuid: 'b' }] })
    t(eng, 'two wallets: "Connect Alpha" and "Connect Beta"', (await btnByText(page, /^Connect Alpha$/)) >= 0 && (await btnByText(page, /^Connect Beta$/)) >= 0, await box(page))
    await tapText(page, /^Connect Beta$/)
    await page.waitForTimeout(400)
    const cs = await calls(page)
    t(eng, 'pressing "Connect Beta" asks Beta only', cs.length === 1 && cs[0].w === 'Beta' && /Connected: Beta/.test(await box(page)), J(cs))
    await browser.close()
  }
}

await run('webkit', webkit, 'iPhone 14')
await run('chromium', chromium, 'Pixel 7')
console.log(`\n${pass} safe, ${fail} BROKE`)
if (breaks.length) { console.log(breaks.join('\n')); process.exit(1) }
