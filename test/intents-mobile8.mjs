// ============================================================
// near-intents-desk — MOBILE ROUND 8 (real WebKit + Chromium): paying from a connected wallet
// ============================================================
// A scripted EIP-1193 wallet (announced by EIP-6963, like real extensions) logs every request the
// page makes. The page may ask for accounts, the chain, a chain switch, and ONE eth_sendTransaction
// that is exactly the transfer the card shows. Anything else is a break. The swap API answers are
// scripted; the page itself is the real one on `wrangler dev`.
//   npx wrangler dev --port 8797 --ip 127.0.0.1    then    node test/intents-mobile8.mjs
// ============================================================
import { fileURLToPath } from 'url'
import path from 'path'
import { overrideClient } from './intents-client-override.mjs'
const { webkit, chromium, devices } = await import('playwright')
const URL0 = 'http://127.0.0.1:8797/'
const ID = '11111111-2222-4333-8444-555555555555', TOKEN = 'cd'.repeat(32)
const DEP = '0x' + '2a'.repeat(20), USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const ME = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const HASH = '0x' + 'ab'.repeat(32)

let pass = 0, fail = 0
const breaks = []
const t = (eng, name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  safe   [${eng}] ${name}`) }
  else { fail++; breaks.push(`[${eng}] ${name}`); console.log(`  BROKE  [${eng}] ${name}` + (extra ? '  — ' + String(extra).slice(0, 300) : '')) }
}
const J = o => JSON.stringify(o)
const swapOf = over => ({ id: ID, rev: 0, fromAsset: 'nep141:base-' + USDC + '.omft.near', toAsset: 'nep141:sol.omft.near', fromChain: 'base', toChain: 'sol',
  fromDecimals: 6, toDecimals: 9, fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: '47000000', amountOut: '200000000', minAmountOut: '199000000',
  recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', refundTo: ME, depositAddress: DEP, secondsLeft: 3600,
  state: 'awaiting_deposit', originTxs: [], destTxs: [], pay: { chainId: '0x2105', token: USDC }, ...over })
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const word = h => h.replace(/^0x/, '').toLowerCase().padStart(64, '0')

// The scripted wallet. `wallets` = [{name, uuid}] announced by EIP-6963; `injected` also sets
// window.ethereum. Each logs into window.__W.calls[] as {w, method, params}; window.__W.mode steers it.
function walletScript({ wallets, injected }) {
  window.__W = { calls: [], chainId: '0x1', mode: {}, n: 0 }
  const make = (name) => ({
    request: async ({ method, params }) => {
      const W = window.__W, m = W.mode
      W.calls.push({ w: name, method, params: params === undefined ? null : JSON.parse(JSON.stringify(params)) })
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        if (m.accountsDelay) await new Promise(r => setTimeout(r, m.accountsDelay))
        if (m.rejectAccounts) throw { code: 4001, message: 'User rejected' }
        return [m.account || '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed']
      }
      if (method === 'eth_chainId') return m.chainDecimal ? String(parseInt(W.chainId, 16)) : W.chainId
      if (method === 'wallet_switchEthereumChain') {
        if (m.switch === '4902') throw { code: 4902, message: 'Unrecognized chain' }
        if (m.switch === 'reject') throw { code: 4001, message: 'User rejected' }
        if (m.switch !== 'ignore') W.chainId = params[0].chainId
        return null
      }
      if (method === 'eth_sendTransaction') {
        if (m.sendDelay) await new Promise(r => setTimeout(r, m.sendDelay))
        if (m.chainMovedTo) W.chainId = m.chainMovedTo                    // the user moved the wallet before approving
        // Like MetaMask: a tx naming another chain than the wallet is on is refused (and one that
        // names none is sent on whatever chain the wallet is on — which is why the page names it).
        if (params[0].chainId && params[0].chainId !== W.chainId) throw { code: -32602, message: 'Invalid chainId' }
        W.sentOn = (W.sentOn || []).concat(W.chainId)
        if (m.sendReject) throw { code: 4001, message: 'User rejected the request.' }
        if (m.sendRejectWrapped) throw { code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: { code: 4001, message: 'User rejected' } } }
        if (m.sendError) throw { code: -32603, message: 'Internal JSON-RPC error.' }
        if (m.badHash) return 'not-a-hash'
        W.n++
        return '0x' + (m.hashByte || 'ab').repeat(32)
      }
      throw { code: 4200, message: 'Unsupported method ' + method }
    },
  })
  const provs = wallets.map(w => ({ info: { uuid: w.uuid, name: w.name, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'test.' + w.uuid }, provider: make(w.name) }))
  const announce = () => provs.forEach(d => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze(d) })))
  window.addEventListener('eip6963:requestProvider', announce)
  if (injected) window.ethereum = make('injected')
}

async function open(bt, device, { swap = swapOf({}), wallets = [{ name: 'Test Wallet', uuid: 'w1' }], injected = false, routes } = {}) {
  const browser = await bt.launch()
  const ctx = await browser.newContext({ ...devices[device] })
  const ip = '10.95.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250)
  await overrideClient(ctx)
  await ctx.route('http://127.0.0.1:8797/api/**', route => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }))
  await ctx.addInitScript(walletScript, { wallets, injected })
  const seen = { submit: [] }
  let cur = swap
  // On the context, so a second tab (M15) gets the same scripted answers.
  await ctx.route('**/api/swaps', r => json(r, 200, { ok: true, swaps: [cur] }))
  await ctx.route('**/api/swap?id=*', r => json(r, 200, { ok: true, swap: cur }))
  const page = await ctx.newPage()
  await ctx.route('**/api/submit', r => { seen.submit.push({ body: JSON.parse(r.request().postData() || '{}'), tok: r.request().headers()['x-swap-token'] || '' }); return json(r, 200, { ok: true, swap: { ...cur, rev: 5 } }) })
  if (routes) await routes(page)
  await page.goto(URL0, { waitUntil: 'load' })
  await page.evaluate(([id, tok]) => localStorage.setItem('desk.swaps', JSON.stringify([{ id, token: tok }])), [ID, TOKEN])
  await page.goto(URL0, { waitUntil: 'load' })
  await page.waitForFunction(() => document.getElementById('xc-status-pill')?.textContent === 'LIVE', null, { timeout: 20000 })
  await page.waitForSelector('.xc-hist', { timeout: 10000 }); await page.tap('.xc-hist')
  await page.waitForSelector('.xc-addr', { timeout: 10000 }).catch(() => {})
  return { browser, page, seen, setSwap: s => { cur = s } }
}
const calls = page => page.evaluate(() => window.__W.calls)
const mode = (page, m) => page.evaluate(m => { window.__W.mode = m }, m)
const payBtn = page => page.$('.xc-wallet button.xc-btn:not(.ghost)')
const walletText = page => page.textContent('.xc-wallet').catch(() => '')
const ALLOWED = new Set(['eth_requestAccounts', 'eth_accounts', 'eth_chainId', 'wallet_switchEthereumChain', 'eth_sendTransaction'])
const onlyAllowed = cs => cs.every(c => ALLOWED.has(c.method))

async function run(eng, bt, device) {
  console.log(`\n[${eng}: ${device} on ${bt.name()}]`)

  // ── M1 an ERC-20 (Base USDC) from a wallet on the wrong chain: switch, then the exact transfer
  {
    const { browser, page, seen } = await open(bt, device)
    const b = await payBtn(page)
    t(eng, 'the card offers "Pay with Test Wallet" (the name the wallet announced)', !!b && /Pay with Test Wallet/.test(await b.textContent()))
    t(eng, '…and says exactly what the wallet will be asked to send, and to where', /exactly 47 USDC on Base to 0x2a2a/.test(await walletText(page)), (await walletText(page)).slice(0, 200))
    await b.tap()
    await page.waitForFunction(() => window.__W.calls.some(c => c.method === 'eth_sendTransaction'), null, { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(800)
    const cs = await calls(page)
    const sends = cs.filter(c => c.method === 'eth_sendTransaction')
    t(eng, 'the wallet was asked to switch to Base (0x2105) before sending', cs.some(c => c.method === 'wallet_switchEthereumChain' && c.params[0].chainId === '0x2105')
      && cs.findIndex(c => c.method === 'wallet_switchEthereumChain') < cs.findIndex(c => c.method === 'eth_sendTransaction'), J(cs.map(c => c.method)))
    const tx = sends[0] && sends[0].params[0]
    const want = '0xa9059cbb' + word(DEP) + word((47000000).toString(16))
    t(eng, 'exactly ONE transaction: transfer(deposit address, 47000000) on the USDC contract, no value', sends.length === 1 && tx.to === USDC && tx.value === '0x0' && tx.data === want && tx.chainId === '0x2105' && tx.from === ME, J(tx))
    t(eng, 'the page never asked for an approval, a signature or anything else', onlyAllowed(cs) && !cs.some(c => /sign|approve/i.test(c.method)) && !/095ea7b3/.test(J(cs)), J(cs.map(c => c.method)))
    t(eng, 'the hash went to the desk for this swap, with its key', seen.submit.length === 1 && seen.submit[0].body.id === ID && seen.submit[0].body.txHash === HASH && seen.submit[0].tok === TOKEN, J(seen.submit))
    t(eng, 'the card now says "Do NOT send again" and offers no second payment', /Do NOT send again/.test(await walletText(page)) && !(await payBtn(page)), await walletText(page))
    const hrefs = await page.$$eval('.xc-wallet a', as => as.map(a => a.href))
    t(eng, 'it links the transfer on Basescan, built by the page', hrefs.length === 1 && hrefs[0] === 'https://basescan.org/tx/' + HASH, J(hrefs))
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    t(eng, 'no sideways scroll at phone width with the wallet box', over <= 1, over)
    // reload: the device remembers it paid this swap
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.xc-hist', { timeout: 15000 }); await page.tap('.xc-hist')
    await page.waitForSelector('.xc-wallet', { timeout: 10000 }).catch(() => {})
    t(eng, 'after a reload the card still says "Do NOT send again", with no pay button', /Do NOT send again/.test(await walletText(page)) && !(await payBtn(page)), await walletText(page))
    const stored = await page.evaluate(() => localStorage.getItem('desk.walletSent') || '')
    t(eng, 'what is stored is the swap id, the amount sent and the hash only (no date, no address)', stored === J([{ id: ID, amt: '47000000', hash: HASH }]), stored)
    await browser.close()
  }

  // ── M2 a native coin (Arbitrum ETH), already on the right chain: value, no data, no switch
  {
    const amt = '50000000000000000'
    const { browser, page } = await open(bt, device, { swap: swapOf({ fromAsset: 'nep141:arb.omft.near', fromChain: 'arb', fromDecimals: 18, fromSymbol: 'ETH', amountIn: amt, pay: { chainId: '0xa4b1', token: null } }) })
    await page.evaluate(() => { window.__W.chainId = '0xa4b1' })
    await (await payBtn(page)).tap()
    await page.waitForFunction(() => window.__W.calls.some(c => c.method === 'eth_sendTransaction'), null, { timeout: 8000 }).catch(() => {})
    const cs = await calls(page), tx = (cs.find(c => c.method === 'eth_sendTransaction') || {}).params?.[0]
    t(eng, 'native ETH: to = the deposit address, value = the exact amount in hex, no data', tx && tx.to === DEP && tx.value === '0x' + BigInt(amt).toString(16) && tx.data === undefined && tx.chainId === '0xa4b1', J(tx))
    t(eng, '…and no chain switch when the wallet is already on Arbitrum', !cs.some(c => c.method === 'wallet_switchEthereumChain'))
    await browser.close()
  }

  // ── M3 big amounts: hex built from digits without BigInt, checked against BigInt here
  {
    const amt = '123456789012345678901234567890'
    const { browser, page } = await open(bt, device, { swap: swapOf({ fromAsset: 'nep141:arb.omft.near', fromChain: 'arb', fromDecimals: 18, fromSymbol: 'ETH', amountIn: amt, pay: { chainId: '0xa4b1', token: null } }) })
    await page.evaluate(() => { window.__W.chainId = '0xa4b1' })
    await (await payBtn(page)).tap()
    await page.waitForFunction(() => window.__W.calls.some(c => c.method === 'eth_sendTransaction'), null, { timeout: 8000 }).catch(() => {})
    const tx = ((await calls(page)).find(c => c.method === 'eth_sendTransaction') || {}).params?.[0]
    t(eng, 'a 30-digit amount converts exactly', tx && tx.value === '0x' + BigInt(amt).toString(16), J(tx && tx.value))
    await browser.close()
  }

  // ── M4 part payment: only the rest; unknown received amount: no wallet payment
  {
    const { browser, page } = await open(bt, device, { swap: swapOf({ state: 'incomplete_deposit', deposited: '20000000' }) })
    t(eng, 'a part-paid swap asks the wallet for exactly the rest (27 USDC)', /exactly 27 USDC/.test(await walletText(page)), await walletText(page))
    await (await payBtn(page)).tap()
    await page.waitForFunction(() => window.__W.calls.some(c => c.method === 'eth_sendTransaction'), null, { timeout: 8000 }).catch(() => {})
    const tx = ((await calls(page)).find(c => c.method === 'eth_sendTransaction') || {}).params?.[0]
    t(eng, '…and the transfer is for 27000000, not the full 47000000', tx && tx.data === '0xa9059cbb' + word(DEP) + word((27000000).toString(16)), J(tx))
    await browser.close()
    const o2 = await open(bt, device, { swap: swapOf({ state: 'incomplete_deposit', deposited: null }) })
    t(eng, 'part-paid with the received amount not reported: no wallet payment offered', !(await o2.page.$('.xc-wallet')))
    await o2.browser.close()
  }

  // ── M5 the user says no, or the wallet cannot switch: nothing is sent, nothing recorded
  for (const [m, name, re, sends] of [
    [{ sendReject: true }, 'the user rejects the transfer in the wallet', /cancelled in your wallet\. Nothing was sent/, 1],
    [{ sendRejectWrapped: true }, 'the user rejects, and the wallet wraps the 4001 (MetaMask mobile)', /cancelled in your wallet\. Nothing was sent/, 1],
    [{ rejectAccounts: true }, 'the user refuses to connect', /cancelled in your wallet\. Nothing was sent/, 0],
    [{ switch: '4902' }, 'the wallet does not know Base', /does not have the Base network/, 0],
    [{ switch: 'reject' }, 'the user refuses the chain switch', /cancelled in your wallet/, 0],
    [{ switch: 'ignore' }, 'the wallet "switches" but stays on Ethereum', /not on Base/, 0],
    [{ account: 'not-an-address' }, 'the wallet shares no valid account', /did not share an account/, 0],
  ]) {
    const { browser, page, seen } = await open(bt, device)
    await mode(page, m)
    await (await payBtn(page)).tap()
    await page.waitForTimeout(1500)
    const cs = await calls(page), txt = await walletText(page)
    t(eng, `${name}: the page says so, sent ${sends} request(s) to send, recorded nothing, told the desk nothing`,
      re.test(txt) && cs.filter(c => c.method === 'eth_sendTransaction').length === sends && seen.submit.length === 0 && !/pending|0x/.test(await page.evaluate(() => localStorage.getItem('desk.walletSent') || '')), txt.slice(-180))
    t(eng, `${name}: the pay button is back`, !!(await payBtn(page)) && !(await (await payBtn(page)).isDisabled()))
    await browser.close()
  }

  // ── M5b failures AFTER the wallet was asked to send: unknown outcome, so "check your wallet", never "Pay"
  for (const [m, name] of [[{ sendError: true }, 'the wallet fails mid-send'], [{ badHash: true }, 'the wallet answers with something that is not a hash']]) {
    const { browser, page, seen } = await open(bt, device)
    await mode(page, m)
    await (await payBtn(page)).tap()
    await page.waitForTimeout(1500)
    const txt = await walletText(page)
    t(eng, `${name}: the card says "check your wallet … do NOT send again", with no Pay button`, /does not know whether it was sent/.test(txt) && /do NOT send again/.test(txt) && !(await payBtn(page)), txt.slice(0, 200))
    t(eng, `${name}: …nothing told to the desk, and the swap is marked pending in this browser`, seen.submit.length === 0 && /"hash":"pending"/.test(await page.evaluate(() => localStorage.getItem('desk.walletSent') || '')))
    // the member checked the wallet: nothing there
    await page.tap('.xc-wallet button:has-text("pay again")')
    t(eng, `${name}: "My wallet shows nothing sent: pay again" brings the Pay button back`, !!(await payBtn(page)) && !(await page.evaluate(() => /pending/.test(localStorage.getItem('desk.walletSent') || ''))))
    await browser.close()
  }

  // ── M6 double tap: one transfer
  {
    const { browser, page } = await open(bt, device)
    await mode(page, { sendDelay: 1500 })
    const b = await payBtn(page)
    await b.tap(); await b.tap({ force: true }).catch(() => {}); await page.evaluate(() => { const x = document.querySelector('.xc-wallet button.xc-btn:not(.ghost)'); if (x) x.click() })
    await page.waitForTimeout(3000)
    const n = (await calls(page)).filter(c => c.method === 'eth_sendTransaction').length
    t(eng, 'three taps while the wallet is open ask for ONE transfer', n === 1, n)
    await browser.close()
  }

  // ── M6b the second guard alone: even if the Pay button were clickable while the wallet is still
  // connecting (the disabled button is the first guard), a second press starts no second request:
  // no second wallet prompt, and one transfer
  {
    const { browser, page } = await open(bt, device)
    await mode(page, { accountsDelay: 2000 })
    await (await payBtn(page)).tap()
    await page.waitForTimeout(300)
    await page.evaluate(() => document.querySelectorAll('.xc-wallet button.xc-btn:not(.ghost)').forEach(x => { x.disabled = false; x.click() }))
    await page.waitForTimeout(4500)
    const cs = await calls(page)
    const asks = cs.filter(c => c.method === 'eth_requestAccounts').length, n = cs.filter(c => c.method === 'eth_sendTransaction').length
    t(eng, 'a press that gets past the disabled button opens no second wallet prompt, and one transfer', asks === 1 && n === 1, J({ asks, n }))
    await browser.close()
  }

  // ── M7 the wallet answers after the member pressed "New swap": recorded to ITS swap, form untouched
  {
    const { browser, page, seen } = await open(bt, device)
    await mode(page, { sendDelay: 3000 })
    await (await payBtn(page)).tap()
    await page.waitForTimeout(600)
    await page.tap('.xc-actions button:has-text("New swap")')
    await page.waitForTimeout(3500)
    const stored = await page.evaluate(() => localStorage.getItem('desk.walletSent') || '')
    t(eng, 'a late wallet answer is still recorded against its swap', stored.includes(ID) && stored.includes(HASH), stored)
    t(eng, '…and still told to the desk with that swap\'s key', seen.submit.length === 1 && seen.submit[0].body.id === ID && seen.submit[0].tok === TOKEN, J(seen.submit))
    t(eng, '…without drawing anything over the form', await page.isVisible('#xc-form') && !(await page.isVisible('#xc-card')))
    await browser.close()
  }

  // ── M8 only where an address may be paid; no wallet = a hint, no button
  {
    for (const [over, name] of [
      [{ pay: null }, 'no pay facts from the desk (e.g. a Solana deposit)'],
      [{ state: 'processing' }, 'a swap already processing'],
      [{ state: 'expired', depositAddress: null, pay: null }, 'an expired swap'],
      [{ originTxs: [{ hash: '0x' + '11'.repeat(32) }] }, 'a deposit already seen on chain'],
    ]) {
      const { browser, page } = await open(bt, device, { swap: swapOf(over) })
      await page.waitForTimeout(400)
      t(eng, `${name}: no wallet payment offered`, !(await payBtn(page)))
      await browser.close()
    }
    const { browser, page } = await open(bt, device, { wallets: [] })
    t(eng, 'no wallet in the browser: a hint, no button', !(await payBtn(page)) && /Open this page in its browser/.test(await walletText(page)), await walletText(page))
    await browser.close()
  }

  // ── M9 window.ethereum only (no EIP-6963): still works
  {
    const { browser, page } = await open(bt, device, { wallets: [], injected: true })
    const b = await payBtn(page)
    t(eng, 'an older wallet that only sets window.ethereum is offered too', !!b && /Pay with your browser wallet/.test(await b.textContent()))
    await b.tap()
    await page.waitForFunction(() => window.__W.calls.some(c => c.method === 'eth_sendTransaction'), null, { timeout: 8000 }).catch(() => {})
    t(eng, '…and pays through it', (await calls(page)).filter(c => c.method === 'eth_sendTransaction' && c.w === 'injected').length === 1)
    await browser.close()
  }

  // ── M10 two wallets: each gets its own button, the chosen one alone is asked; a hostile name is text
  {
    const { browser, page } = await open(bt, device, { wallets: [{ name: 'Alpha', uuid: 'a' }, { name: '<img src=x onerror="window.__pwned=1">Beta', uuid: 'b' }] })
    const btns = await page.$$('.xc-wallet button.xc-btn:not(.ghost)')
    t(eng, 'two announced wallets: two buttons', btns.length === 2, btns.length)
    t(eng, 'a wallet name with HTML in it is shown as text, never run', !(await page.evaluate(() => window.__pwned)) && !(await page.$('.xc-wallet img')))
    await btns[1].tap()
    await page.waitForFunction(() => window.__W.calls.some(c => c.method === 'eth_sendTransaction'), null, { timeout: 8000 }).catch(() => {})
    const ws = [...new Set((await calls(page)).map(c => c.w))]
    t(eng, 'only the chosen wallet was asked anything', ws.length === 1 && /Beta/.test(ws[0]), J(ws))
    await browser.close()
  }

  // ── M12 under 5 minutes left: the wallet is never asked to send (a request cannot be withdrawn)
  for (const secs of [40, 240]) {
    const { browser, page } = await open(bt, device, { swap: swapOf({ secondsLeft: secs }) })
    const b = await payBtn(page)
    if (b) { await b.tap(); await page.waitForTimeout(1500) }
    const n = (await calls(page)).filter(c => c.method === 'eth_sendTransaction').length
    t(eng, `${secs} s left: no transfer is requested, and the page says why`, n === 0 && (!b || /Less than 5 minutes are left/.test(await walletText(page))), await walletText(page))
    await browser.close()
  }

  // ── M13 "Stop waiting" while the wallet's send prompt is open: no second Pay; the late hash is still kept
  {
    const { browser, page, seen } = await open(bt, device)
    await mode(page, { sendDelay: 5000 })
    await (await payBtn(page)).tap()
    await page.waitForFunction(() => window.__W.calls.some(c => c.method === 'eth_sendTransaction'), null, { timeout: 8000 })
    await page.tap('.xc-wallet button:has-text("Stop waiting")')
    const txt = await walletText(page)
    t(eng, 'Stop while the send prompt is open: "check your wallet", and NO Pay button to tap again', /does not know whether it was sent/.test(txt) && !(await payBtn(page)), txt.slice(0, 160))
    await page.waitForTimeout(5000)
    t(eng, '…the wallet then sends: the card says "Sent … do NOT send again", the desk is told once', /Sent from your wallet/.test(await walletText(page)) && seen.submit.length === 1, await walletText(page))
    t(eng, '…and the wallet was asked for one transfer in all', (await calls(page)).filter(c => c.method === 'eth_sendTransaction').length === 1)
    await browser.close()
  }
  // ── M13b "Stop waiting" BEFORE the send prompt: Pay comes back, and the stopped request never sends
  {
    const { browser, page } = await open(bt, device)
    await mode(page, { accountsDelay: 3000 })
    await (await payBtn(page)).tap()
    await page.waitForTimeout(400)
    await page.tap('.xc-wallet button:has-text("Stop waiting")')
    t(eng, 'Stop while the wallet is still connecting: Pay is offered again', !!(await payBtn(page)) && !(await (await payBtn(page)).isDisabled()))
    await page.waitForTimeout(3500)
    t(eng, '…and the stopped request, answering late, never asks to send', (await calls(page)).filter(c => c.method === 'eth_sendTransaction').length === 0)
    await mode(page, {})
    await (await payBtn(page)).tap()
    await page.waitForFunction(() => window.__W.calls.some(c => c.method === 'eth_sendTransaction'), null, { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(500)
    t(eng, '…a new tap then pays exactly once', (await calls(page)).filter(c => c.method === 'eth_sendTransaction').length === 1)
    await browser.close()
  }

  // ── M14 reload while the wallet's send prompt is open: no Pay after the reload
  {
    const { browser, page } = await open(bt, device)
    await mode(page, { sendDelay: 60000 })
    await (await payBtn(page)).tap()
    await page.waitForFunction(() => window.__W.calls.some(c => c.method === 'eth_sendTransaction'), null, { timeout: 8000 })
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.xc-hist', { timeout: 15000 }); await page.tap('.xc-hist')
    await page.waitForSelector('.xc-wallet', { timeout: 10000 }).catch(() => {})
    t(eng, 'reloaded mid-prompt: "check your wallet", no Pay button', /does not know whether it was sent/.test(await walletText(page)) && !(await payBtn(page)), await walletText(page))
    await browser.close()
  }

  // ── M15 two tabs: one pays, the other stops offering Pay
  {
    const { browser, page } = await open(bt, device)
    const page2 = await page.context().newPage()
    await page2.goto(URL0, { waitUntil: 'load' })
    await page2.waitForFunction(() => document.getElementById('xc-status-pill')?.textContent === 'LIVE', null, { timeout: 20000 })
    await page2.waitForSelector('.xc-hist', { timeout: 10000 }); await page2.tap('.xc-hist')
    await page2.waitForSelector('.xc-wallet button.xc-btn:not(.ghost)', { timeout: 10000 })
    await mode(page, { sendDelay: 3000 })
    await (await payBtn(page)).tap()
    await page.waitForFunction(() => window.__W.calls.some(c => c.method === 'eth_sendTransaction'), null, { timeout: 8000 })
    await page2.waitForTimeout(800)
    t(eng, 'while tab 1\'s wallet prompt is open, tab 2 shows "check your wallet", not Pay', !(await payBtn(page2)) && /does not know whether it was sent/.test(await walletText(page2)), await walletText(page2))
    await page.waitForTimeout(3000)
    await page2.waitForTimeout(500)
    t(eng, '…and once tab 1 has the hash, tab 2 says "Sent"', /Sent from your wallet/.test(await walletText(page2)), await walletText(page2))
    await browser.close()
  }

  // ── M16 the swap stops waiting for a deposit while the wallet is connecting: nothing is sent
  {
    const o = await open(bt, device)
    await mode(o.page, { accountsDelay: 12000 })
    await (await payBtn(o.page)).tap()
    o.setSwap(swapOf({ state: 'processing', rev: 9, deposited: '47000000' }))     // the next poll (10 s) sees it
    await o.page.waitForTimeout(13500)
    t(eng, 'the deposit arrived (from elsewhere) while the wallet connected: no transfer requested', (await calls(o.page)).filter(c => c.method === 'eth_sendTransaction').length === 0)
    await o.browser.close()
  }

  // ── M17 after a full wallet payment the router reports only part arrived: the REST is offered
  {
    const o = await open(bt, device)
    await (await payBtn(o.page)).tap()
    await o.page.waitForFunction(() => /Sent from your wallet/.test(document.querySelector('.xc-wallet')?.textContent || ''), null, { timeout: 8000 })
    o.setSwap(swapOf({ state: 'incomplete_deposit', deposited: '46000000', rev: 9 }))
    await o.page.waitForTimeout(11000)
    t(eng, 'the card offers the wallet exactly the rest (1 USDC), not "do not send again"', /exactly 1 USDC/.test(await walletText(o.page)) && !!(await payBtn(o.page)), await walletText(o.page))
    await o.browser.close()
  }

  // ── M18 a decimal chain id from the wallet is read as the same chain
  {
    const { browser, page } = await open(bt, device)
    await page.evaluate(() => { window.__W.chainId = '0x2105'; window.__W.mode = { chainDecimal: true } })
    await (await payBtn(page)).tap()
    await page.waitForFunction(() => window.__W.calls.some(c => c.method === 'eth_sendTransaction'), null, { timeout: 8000 }).catch(() => {})
    const cs = await calls(page)
    t(eng, 'a wallet answering "8453" is on Base: no switch prompt, one transfer', !cs.some(c => c.method === 'wallet_switchEthereumChain') && cs.filter(c => c.method === 'eth_sendTransaction').length === 1, J(cs.map(c => c.method)))
    await browser.close()
  }

  // ── M19 a wallet request open on swap A does not block paying swap B
  {
    const B = '22222222-3333-4444-8555-666666666666', TOKB = 'ef'.repeat(32), DEPB = '0x' + '3b'.repeat(20)
    const A0 = swapOf({}), B0 = swapOf({ id: B, depositAddress: DEPB, amountIn: '99000000' })
    const browser = await bt.launch()
    const ctx = await browser.newContext({ ...devices[device] })
    await overrideClient(ctx)
    await ctx.addInitScript(walletScript, { wallets: [{ name: 'Test Wallet', uuid: 'w1' }], injected: false })
    const page = await ctx.newPage()
    await page.route('**/api/swaps', r => json(r, 200, { ok: true, swaps: [A0, B0] }))
    await page.route('**/api/swap?id=*', r => json(r, 200, { ok: true, swap: r.request().url().includes(B) ? B0 : A0 }))
    await page.route('**/api/submit', r => json(r, 200, { ok: true }))
    await page.goto(URL0, { waitUntil: 'load' })
    await page.evaluate(([a, ta, b, tb]) => localStorage.setItem('desk.swaps', JSON.stringify([{ id: a, token: ta }, { id: b, token: tb }])), [ID, TOKEN, B, TOKB])
    await page.goto(URL0, { waitUntil: 'load' })
    await page.waitForSelector('.xc-hist', { timeout: 20000 })
    await page.locator('.xc-hist').nth(0).tap()
    await page.waitForSelector('.xc-wallet button.xc-btn:not(.ghost)', { timeout: 10000 })
    await mode(page, { accountsDelay: 5000 })
    await (await payBtn(page)).tap()
    await page.tap('.xc-actions button:has-text("New swap")')
    await page.waitForSelector('.xc-hist', { timeout: 10000 })
    await page.locator('.xc-hist').nth(1).tap()
    await page.waitForSelector('.xc-wallet', { timeout: 10000 })
    const b = await payBtn(page)
    t(eng, 'swap B can be paid while a request for swap A is still open', !!b && !(await b.isDisabled()) && /Pay with/.test(await b.textContent()))
    await page.waitForTimeout(5500)
    t(eng, '…and A\'s request, answering while B is on screen, never asks to send', (await calls(page)).filter(c => c.method === 'eth_sendTransaction').length === 0)
    await browser.close()
  }

  // ── M19b as M19, but B is for the SAME amount: only the "which swap is on screen" checks can stop A
  {
    const B = '22222222-3333-4444-8555-666666666666', TOKB = 'ef'.repeat(32), DEPB = '0x' + '3b'.repeat(20)
    const A0 = swapOf({}), B0 = swapOf({ id: B, depositAddress: DEPB })
    const browser = await bt.launch()
    const ctx = await browser.newContext({ ...devices[device] })
    await overrideClient(ctx)
    await ctx.addInitScript(walletScript, { wallets: [{ name: 'Test Wallet', uuid: 'w1' }], injected: false })
    const page = await ctx.newPage()
    await page.route('**/api/swaps', r => json(r, 200, { ok: true, swaps: [A0, B0] }))
    await page.route('**/api/swap?id=*', r => json(r, 200, { ok: true, swap: r.request().url().includes(B) ? B0 : A0 }))
    await page.route('**/api/submit', r => json(r, 200, { ok: true }))
    await page.goto(URL0, { waitUntil: 'load' })
    await page.evaluate(([a, ta, b, tb]) => localStorage.setItem('desk.swaps', JSON.stringify([{ id: a, token: ta }, { id: b, token: tb }])), [ID, TOKEN, B, TOKB])
    await page.goto(URL0, { waitUntil: 'load' })
    await page.waitForSelector('.xc-hist', { timeout: 20000 })
    await page.locator('.xc-hist').nth(0).tap()
    await page.waitForSelector('.xc-wallet button.xc-btn:not(.ghost)', { timeout: 10000 })
    await mode(page, { accountsDelay: 4000 })
    await (await payBtn(page)).tap()
    await page.tap('.xc-actions button:has-text("New swap")')
    await page.waitForSelector('.xc-hist', { timeout: 10000 })
    await page.locator('.xc-hist').nth(1).tap()
    await page.waitForSelector('.xc-wallet', { timeout: 10000 })
    await page.waitForTimeout(9000)
    t(eng, 'same amount: A\'s request, answering while B is on screen, never asks to send', (await calls(page)).filter(c => c.method === 'eth_sendTransaction').length === 0)
    await browser.close()
  }

  // ── M20 the page went to sleep and came back mid-request: no transfer until a fresh status lands
  {
    let stall = false
    const o = await open(bt, device, { routes: async page => { await page.route('**/api/swap?id=*', async r => { if (stall) await new Promise(z => setTimeout(z, 20000)); return json(r, 200, { ok: true, swap: swapOf({}) }) }) } })
    await mode(o.page, { accountsDelay: 2500 })
    await (await payBtn(o.page)).tap()
    stall = true
    await o.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))     // "back on screen": status is stale again
    await o.page.waitForTimeout(3500)
    t(eng, 'resumed mid-request, fresh status not back yet: no transfer requested', (await calls(o.page)).filter(c => c.method === 'eth_sendTransaction').length === 0)
    await o.browser.close()
  }

  // ── M22 tab 2 pays while tab 1's wallet is still connecting: tab 1 then never asks to send
  {
    const { browser, page } = await open(bt, device)
    const page2 = await page.context().newPage()
    await page2.goto(URL0, { waitUntil: 'load' })
    await page2.waitForFunction(() => document.getElementById('xc-status-pill')?.textContent === 'LIVE', null, { timeout: 20000 })
    await page2.waitForSelector('.xc-hist', { timeout: 10000 }); await page2.tap('.xc-hist')
    await page2.waitForSelector('.xc-wallet button.xc-btn:not(.ghost)', { timeout: 10000 })
    await mode(page, { accountsDelay: 3000 })
    await (await payBtn(page)).tap()
    await (await payBtn(page2)).tap()
    await page2.waitForFunction(() => /Sent from your wallet/.test(document.querySelector('.xc-wallet')?.textContent || ''), null, { timeout: 8000 })
    await page.waitForTimeout(3500)
    t(eng, 'paid in tab 2 while tab 1 connected: tab 1 never asks its wallet to send', (await calls(page)).filter(c => c.method === 'eth_sendTransaction').length === 0, J((await calls(page)).map(c => c.method)))
    await browser.close()
  }

  // ── M23 a real hash outranks a pending mark for the same swap and amount
  {
    const { browser, page } = await open(bt, device, { routes: async page => {
      await page.addInitScript(([id, h]) => { try { localStorage.setItem('desk.walletSent', JSON.stringify([{ id, amt: '47000000', hash: 'pending', req: 'x' }, { id, amt: '47000000', hash: h }])) } catch (e) {} }, [ID, HASH])
    } })
    t(eng, 'pending + real hash recorded: the card says "Sent", not "check your wallet"', /Sent from your wallet/.test(await walletText(page)), await walletText(page))
    await browser.close()
  }

  // ── M24 the wallet moves to another chain between the page's check and the approval
  {
    const { browser, page } = await open(bt, device)
    await mode(page, { chainMovedTo: '0x1' })
    await (await payBtn(page)).tap()
    await page.waitForTimeout(1500)
    const sentOn = await page.evaluate(() => window.__W.sentOn || [])
    t(eng, 'moved to Ethereum at the prompt: the transfer names Base, so it is refused, never sent on Ethereum', sentOn.length === 0, J(sentOn))
    await browser.close()
  }

  // ── M25 a STOPPED request's late "cancel" must not touch the newer request
  {
    const { browser, page } = await open(bt, device)
    await mode(page, { sendDelay: 4000, sendReject: true })          // the first prompt: rejected, later
    await (await payBtn(page)).tap()
    await page.waitForFunction(() => window.__W.calls.some(c => c.method === 'eth_sendTransaction'), null, { timeout: 8000 })
    await page.tap('.xc-wallet button:has-text("Stop waiting")')
    await page.tap('.xc-wallet button:has-text("pay again")')
    await mode(page, { sendDelay: 9000 })                             // the second prompt: approved, later
    await (await payBtn(page)).tap()
    await page.waitForFunction(() => window.__W.calls.filter(c => c.method === 'eth_sendTransaction').length === 2, null, { timeout: 8000 })
    await page.waitForTimeout(4500)                                   // the first prompt's rejection has arrived
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem('desk.walletSent') || '[]'))
    const txt = await walletText(page)
    t(eng, 'the old request\'s rejection leaves the new request\'s pending mark in place', st.filter(r => r.hash === 'pending').length === 1, J(st))
    t(eng, '…and does not tell the member "Nothing was sent" while the new prompt is open', !/Nothing was sent/.test(txt) && /Waiting for your wallet/.test(txt), txt.slice(0, 200))
    const busy = await page.evaluate(() => [...document.querySelectorAll('.xc-wallet button')].filter(b => /Waiting for your wallet/.test(b.textContent)).map(b => b.disabled))
    t(eng, '…and its wallet button stays disabled while that prompt is open', busy.length > 0 && busy.every(Boolean), J(busy))
    await page.waitForTimeout(7000)
    t(eng, '…the new request then lands as "Sent"', /Sent from your wallet/.test(await walletText(page)), await walletText(page))
    await browser.close()
  }

  // ── M26 the desk, asked right before sending, disagrees with the card: nothing is sent
  {
    const o = await open(bt, device)
    await mode(o.page, { accountsDelay: 1500 })
    await (await payBtn(o.page)).tap()
    o.setSwap(swapOf({ state: 'processing', rev: 9, deposited: '47000000' }))     // no poll lands before the check
    await o.page.waitForTimeout(2500)
    t(eng, 'the desk says "processing" at the last moment: no transfer requested', (await calls(o.page)).filter(c => c.method === 'eth_sendTransaction').length === 0)
    t(eng, '…and the member is told why', /This swap changed, so nothing was sent/.test(await walletText(o.page)) || !(await o.page.$('.xc-wallet')), await walletText(o.page))
    await o.browser.close()
  }

  // ── M21 malformed pay facts or deposit address reach the page: nothing is sent
  for (const [over, name] of [
    [{ pay: { chainId: '0x2105', token: 'not-a-contract' } }, 'a token that is not an address'],
    [{ depositAddress: '0x1234' }, 'a deposit address that is not an EVM address'],
  ]) {
    const { browser, page } = await open(bt, device, { swap: swapOf(over) })
    const b = await payBtn(page)
    if (b) { await b.tap(); await page.waitForTimeout(1500) }
    t(eng, `${name}: the wallet is never asked to send`, (await calls(page)).filter(c => c.method === 'eth_sendTransaction').length === 0)
    await browser.close()
  }
}

await run('iOS', webkit, 'iPhone 14')
await run('Android', chromium, 'Pixel 7')
console.log(`\n${pass} safe, ${fail} BROKE`)
if (fail) { console.log('BROKE:\n  - ' + breaks.join('\n  - ')); process.exit(1) }
