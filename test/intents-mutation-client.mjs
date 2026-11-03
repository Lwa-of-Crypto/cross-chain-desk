// ============================================================
// CRYPTO LWA · cross-chain desk — CLIENT MUTATION CAMPAIGN (real engines)
// ============================================================
// The server campaign (intents-mutation.mjs) cannot see the browser. This one
// switches off ONE client guard at a time — in a COPY of assets/intents-swap.js
// or swap.html — serves the copy to real WebKit (iPhone 14) and Chromium (Pixel 7)
// through the mobile suites' override hook (intents-client-override.mjs), and
// requires some check to fail. The shipped files on disk are never written.
//
//   npx wrangler dev --port 8797   then   node test/intents-mutation-client.mjs
// ============================================================
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUB = path.join(HERE, '..', 'public')
const JS = fs.readFileSync(path.join(PUB, 'desk.js'), 'utf8')
const HTML = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
const CSS = fs.readFileSync(path.join(PUB, 'desk.css'), 'utf8')
const TMP = fs.mkdtempSync(path.join(HERE, '.client-mutants-'))

// Old-Safari parse gate (intents-legacy-parse.mjs, acorn at ES2017): one syntax
// error blanks the whole desk on Safari 11 / iOS 12. Not esbuild — it only warns.
function legacyParse(file) {
  execFileSync(process.execPath, [path.join(HERE, 'intents-legacy-parse.mjs'), file], { stdio: 'pipe' })
}
const SUITES = [
  ['legacy-parse', (env) => legacyParse(env.CLIENT_OVERRIDE_JS || path.join(PUB, 'desk.js'))],
  ['mobile10', (env) => execFileSync(process.execPath, [path.join(HERE, 'intents-mobile10.mjs')], { stdio: 'pipe', timeout: 600000, env: { ...process.env, ...env } })],
  ['mobile9', (env) => execFileSync(process.execPath, [path.join(HERE, 'intents-mobile9.mjs')], { stdio: 'pipe', timeout: 600000, env: { ...process.env, ...env } })],
  ['mobile8', (env) => execFileSync(process.execPath, [path.join(HERE, 'intents-mobile8.mjs')], { stdio: 'pipe', timeout: 600000, env: { ...process.env, ...env } })],
  ['mobile7', (env) => execFileSync(process.execPath, [path.join(HERE, 'intents-mobile7.mjs')], { stdio: 'pipe', timeout: 600000, env: { ...process.env, ...env } })],
  ['mobile6', (env) => execFileSync(process.execPath, [path.join(HERE, 'intents-mobile6.mjs')], { stdio: 'pipe', timeout: 600000, env: { ...process.env, ...env } })],
  ['mobile5', (env) => execFileSync(process.execPath, [path.join(HERE, 'intents-mobile5.mjs')], { stdio: 'pipe', timeout: 600000, env: { ...process.env, ...env } })],
  ['mobile4', (env) => execFileSync(process.execPath, [path.join(HERE, 'intents-mobile4.mjs')], { stdio: 'pipe', timeout: 600000, env: { ...process.env, ...env } })],
  ['mobile3', (env) => execFileSync(process.execPath, [path.join(HERE, 'intents-mobile3.mjs')], { stdio: 'pipe', timeout: 600000, env: { ...process.env, ...env } })],
  ['mobile', (env) => execFileSync(process.execPath, [path.join(HERE, 'intents-mobile.mjs')], { stdio: 'pipe', timeout: 600000, env: { ...process.env, ...env } })],
  ['mobile2', (env) => execFileSync(process.execPath, [path.join(HERE, 'intents-mobile2.mjs')], { stdio: 'pipe', timeout: 600000, env: { ...process.env, ...env } })],
]
// ONLY="name fragment|other fragment" re-runs just those mutants (the sanity hook always runs).
const ONLY = (process.env.ONLY || '').split('|').map(s => s.trim().toLowerCase()).filter(Boolean)

const MUTANTS = [
  // sanity: proves the override hook really serves the mutant (all else rests on it)
  ['js', 'HOOK SANITY — client throws on load', "  function $(id) { return document.getElementById(id); }", "  throw new Error('mutant'); function $(id) { return document.getElementById(id); }"],
  // "Connect wallet" on the form (mobile10)
  ['js', 'connect: a typed refund address is overwritten', 'if (!CONN || !fromIsEvm() || el.refund.value || !formFree()) return false;', 'if (!CONN || !fromIsEvm() || !formFree()) return false;'],
  ['js', 'connect: an EVM address put in a non-EVM refund field', 'if (!CONN || !fromIsEvm() || el.refund.value || !formFree()) return false;', 'if (!CONN || el.refund.value || !formFree()) return false;'],
  ['js', 'connect: fills the form while a request is in doubt', 'if (!CONN || !fromIsEvm() || el.refund.value || !formFree()) return false;', 'if (!CONN || !fromIsEvm() || el.refund.value) return false;'],
  ['js', 'connect: a forced press rewrites the form while a request is in doubt', 'function useAddr(input) { if (!CONN || !formFree()) return;', 'function useAddr(input) { if (!CONN) return;'],
  ['js', 'connect: buttons live while a request is in doubt', 'var locked = !formFree();', 'var locked = false;'],
  ['js', 'connect: the receiving address is filled without a press', 'CONN = { w: w, addr: a }; CONN_MSG = null;', 'CONN = { w: w, addr: a }; CONN_MSG = null; el.recipient.value = a;'],
  ['js', 'connect: the address is stored', 'CONN = { w: w, addr: a }; CONN_MSG = null;', "CONN = { w: w, addr: a }; CONN_MSG = null; try { localStorage.setItem('desk.wallet', a); } catch (e) {}"],
  ['js', 'connect: anything the wallet answers is taken as an address', "if (typeof a !== 'string' || !EVM_ADDR.test(a)) { CONN_MSG = { text: 'Your wallet did not share an address.", "if (typeof a !== 'string') { CONN_MSG = { text: 'Your wallet did not share an address."],
  ['js', 'connect: a second press asks the wallet again', 'if (CONNECTING || CONN) return;', 'if (CONN) return;'],
  ['js', 'connect: a wallet account switch rewrites the refund field', "else if (!sameAddr(a, CONN.addr)) { CONN.addr = a;", "else if (!sameAddr(a, CONN.addr)) { CONN.addr = a; el.refund.value = a;"],
  ['js', 'connect: the receive button shows without the smart-wallet warning', "box.appendChild(h('p', 'k', 'Receive to the same address only if it is a normal wallet", "void (h('p', 'k', 'Receive to the same address only if it is a normal wallet"],
  ['js', 'connect: the wallet is asked on page load', 'wire(); syncLabels(); renderConnect();', "wire(); syncLabels(); renderConnect(); (function () { var w = walletList()[0]; if (w) connectWallet(w); })();"],
  // the NEAR key checker on the page (nearKeysRows)
  ['js', 'nearkeys: keys not shown', 'var nk = nearKeysRows(box, t.nearKeys);', 'var nk = false;'],
  ['js', 'nearkeys: keys rendered as HTML', "full.forEach(function (pk) { row(box, 'Full-access key', pk, 'nearkey'); });", "full.forEach(function (pk) { var d = h('div', 'xc-row nearkey'); d.innerHTML = '<span class=\"k\">Full-access key</span><span class=\"v\">' + pk + '</span>'; box.appendChild(d); });"],
  ['js', 'nearkeys: the box claims keys that were never listed', "+ (nk ? ' Every full-access key listed above is mine.' : '');", "+ ' Every full-access key listed above is mine.';"],
  ['js', 'nearkeys: the box does not cover the keys', "+ (nk ? ' Every full-access key listed above is mine.' : '');", ";"],
  ['js', 'nearkeys: a failed check shown as no keys', "if (k.checked !== true) { row(box, who, 'could not check right now', 'warn'); return false; }", ''],
  ['js', 'nearkeys: a second key not marked', "full.length > 1 ? 'warn' : ''", "''"],
  ['js', 'boxes worded for the old swap stay tickable while the new price loads', 'el.confirm.hidden = true; updateGo();', 'updateGo();'],
  ['js', 'nearkeys: a locked account not explained', "if (k.locked) { row(box, who, 'no keys: only its smart contract', 'warn'); return false; }", ''],
  ['js', 'full-width digits not folded (NFKC removed)', "try { s = s.normalize('NFKC'); } catch (e) {}", ''],
  ['js', 'invisible marks kept in amounts', "s = s.replace(INVISIBLE, '');", ''],
  ['js', 'comma decimals not converted', "if (s.indexOf(',') !== -1 && s.indexOf('.') === -1 && (s.match(/,/g) || []).length === 1 && !/,\\d{3}$/.test(s)) s = s.replace(',', '.');", ''],
  ['js', 'QR URIs not unwrapped', 'return m ? m[2] : s;', 'return s;'],
  ['js', 'EIP-681 token-transfer URI guessed into an address', '(?:\\?[^/]*)?$/i', '(?:[/?].*)?$/i'],
  ['js', 'invisible marks kept in addresses', "var s = String(v || '').replace(INVISIBLE, '');", "var s = String(v || '');"],
  ['js', 'Get-address enabled without both acknowledgements', 'el.ack1.checked && el.ack2.checked && S.enabled', 'S.enabled'],
  ['js', 'address requested for terms the form no longer matches', 'if (S.termsKey !== JSON.stringify(formBody())) { schedulePreview(); return; }', ''],
  // (retired) "new idempotency key on every press": equivalent since round 13. Every path that ends
  // an attempt clears S.idem and every retry resends the saved body with its key, so S.idem is
  // always empty at that line. Its old "kills" were the J4/H4 flake. The retry key is guarded by
  // "unknown outcome forgets the idempotency key" and the mobile6 H/J reload checks.
  ["js","unknown outcome forgets the idempotency key","S.pending = true; S.pendingBody = b; savePending(b); el.go.disabled = false; showAbandon(true); loadHistory();","S.idem = null; S.pending = false; el.go.disabled = false; showAbandon(true); loadHistory();"],
  ['js', 'expired deposit address still shown', 'var alive = isFinite(dlMs) && dlMs > Date.now();', 'var alive = true;'],
  ['js', 'server strings rendered as HTML', 'e.textContent = String(text);', 'e.innerHTML = String(text);'],
  ['js', 'swap amounts use live token decimals, not the frozen ones', 'Number.isInteger(sw.fromDecimals) ? sw.fromDecimals : null', '(ft && ft.decimals) || 18'],
  ['js', 'partial deposit asks for the full amount again', "sw.state === 'incomplete_deposit' && owed && got", "false && owed && got"],
  ['js', 'BigInt literal (blanks the desk on Safari < 14)', "owed && got && got !== '0' && cmpDigits", "owed && got && got !== '0' && 0n === 0n && cmpDigits"],
  ['js', 'accepted terms survive into the swap card', '// Drop the accepted terms: nothing on screen may be able to request another address for them.\n    invalidateTerms();', '// (mutant)'],
  // standalone desk: no accounts — the swap's key lives in this browser
  ['js', 'swap token not kept (swap lost on reload)', 'var kept = remember(j.swap.id, j.token);', 'var kept = true;'],
  // round 13 (machine level)
  // pair guard: the sequence bump on every edit AND the form-key check on arrival
  ['js', 'old preview answer paired with the new form',
    ['    // amount and the request sent another).\n    S.previewSeq++;', 'if (key !== JSON.stringify(formBody())) return;           // the form changed while it was in flight'],
    ['    // amount and the request sent another).', '']],
  ['js', 'card redrawn on state changes only (stale "send the remaining")', 'var changed = cardSig(j.swap) !== cardSig(S.swap)', 'var changed = j.swap.state !== S.swap.state'],
  // the card's own copy (6-space indent); walletAmount has its own, guarded by the wallet mutants
  ['js', 'partial-deposit maths needs BigInt (full amount on iOS < 14)', "      var owed = digits(sw.amountIn), got = digits(sw.deposited);",
    "      var owed = typeof BigInt === 'function' ? digits(sw.amountIn) : null, got = digits(sw.deposited);"],
  ['js', 'digit subtraction never borrows', 'borrow = d < 0 ? 1 : 0;', 'borrow = 0;'],
  // pair guard: the poll epoch AND the swap id (either one alone already drops the late answer)
  ['js', 'late submit answer redraws a card the user left', ['if (epoch !== S.pollEpoch) return;     // answered after a resume / another card (round 17)', 'if (!S.swap || S.swap.id !== id) return;'], ['', '']],
  // wallet payment (EVM): each guard on what the page asks a connected wallet to send
  ['js', 'wallet: sends without switching to the swap\'s chain', 'if (chainIdOf(c) === pay.chainId || !still()) return c;', 'return c;'],
  ['js', 'wallet: sends while the wallet is on another chain', 'if (chainIdOf(c) !== pay.chainId) stop(', 'if (false) stop('],
  ['js', 'wallet: a decimal chain id from the wallet is not understood', "if (typeof x === 'string' && /^[1-9]\\d{0,15}$/.test(x)) return '0x' + Number(x).toString(16);", ''],
  // A second press cannot send twice even without this guard (each request's own token stops the
  // older one, and the pending mark blocks after the send prompt); what it guards is a second wallet prompt.
  ['js', 'wallet: a second press opens a second wallet prompt', 'if (PAYING[id] || sentRec(id, amt)) return;', 'if (sentRec(id, amt)) return;'],
  ['js', 'wallet: Pay stays enabled while the wallet is open', 'b.disabled = busy;', 'b.disabled = false;'],
  ['js', 'wallet: a stopped request may still send', 'function still() { return PAYING[id] === mine; }', 'function still() { return true; }'],
  ['js', 'wallet: nothing marked before the wallet is asked (reload / other tab pays again)', '      markPending(id, amt, mine);', ''],
  ['js', 'wallet: an unknown outcome offers Pay again', 'if (rec && !busy) {', 'if (false) {'],
  ['js', 'wallet: any failure after asking forgets the pending payment', 'if (asked && errCode(e) === 4001) clearPendingPay(id, amt, mine);', 'if (asked) clearPendingPay(id, amt, mine);'],
  ['js', 'wallet: a refusal at the send prompt keeps blocking Pay', 'if (asked && errCode(e) === 4001) clearPendingPay(id, amt, mine);', ''],
  ['js', 'wallet: a stopped request clears a newer request\'s mark', '(req === null || x.req === req)', 'true'],
  ['js', 'wallet: a stopped request talks over a newer one', 'if (cur && text) S.walletMsg', 'if (text) S.walletMsg'],
  ['js', 'wallet: a pending mark outranks a real hash', "if (!best || (best.hash === 'pending' && r.hash !== 'pending')) best = r;", 'if (!best) best = r;'],
  ['js', 'wallet: a wrapped 4001 is not read as a refusal', 'var cs = [e && e.code, e && e.data && e.data.code, e && e.data && e.data.originalError && e.data.originalError.code];', 'var cs = [e && e.code];'],
  ['js', 'wallet: other tabs are not told', "window.addEventListener('storage', function (e) { if (e.key === SENT && S.walletRefill) S.walletRefill(); });", ''],
  ['js', 'wallet: a sent transfer is not remembered (pay twice after reload)', '      markSent(id, amt, hash, mine);', ''],
  ['js', 'wallet: card forgets it was paid', "if (rec && rec.hash !== 'pending') {", 'if (false) {'],
  ['js', 'wallet: a late wallet answer is dropped when the card changed', '      markSent(id, amt, hash, mine);', '      if (!S.swap || S.swap.id !== id) return;\n      markSent(id, amt, hash, mine);'],
  ['js', 'wallet: part payment asks for the full amount again', "if (sw.state === 'incomplete_deposit' && got && got !== '0' && cmpDigits(got, owed) < 0) return subDigits(owed, got);", "if (sw.state === 'incomplete_deposit' && got && got !== '0' && cmpDigits(got, owed) < 0) return owed;"],
  ['js', 'wallet: a record blocks the rest of a part payment', 'if (!r || r.id !== id || r.amt !== amt ||', 'if (!r || r.id !== id ||'],
  ['js', 'wallet: offered after the deposit was already seen on chain', "(got && got !== '0') || (Array.isArray(sw.originTxs) && sw.originTxs.length) ? null : owed;", "(got && got !== '0') ? null : owed;"],
  ['js', 'wallet: sends with under 5 minutes left', "!(typeof f.secondsLeft === 'number' && f.secondsLeft > 300) || ", ''],
  ['js', 'wallet: no fresh word from the desk before sending', "return api('/api/swap?id=' + encodeURIComponent(id), undefined, tokenFor(id));\n      });", "return { ok: true, swap: cur };\n      });"],
  ['js', 'wallet: the tx does not name its chain (sent on whatever chain the wallet moved to)', 'tx.from = from; tx.chainId = pay.chainId;', 'tx.from = from;'],
  // pair: the card's last look AND the desk's answer each check another tab's payment
  ['js', 'wallet: another tab\'s payment is not checked before sending',
    ['walletAmount(cur) !== amt || sentRec(id, amt) || isAbandoned(id))', 'f.secondsLeft > 300) || sentRec(id, amt) || isAbandoned(id))'],
    ['walletAmount(cur) !== amt || isAbandoned(id))', 'f.secondsLeft > 300) || isAbandoned(id))']],
  // triple: the card's last look (its id AND its fresh status) AND the second look after the desk answers.
  // Each one alone already refuses another card, so only all three together are a real hole.
  ['js', 'wallet: sends for a swap no longer on screen',
    ['if (!cur || cur.id !== id || S.freshId !== id ||', '|| !cur || cur.id !== id || f.rev'],
    ['if (!cur ||', '|| !cur || f.rev']],
  // The fresh-status check alone is shadowed by the desk read right before sending (the desk is
  // the authority, and its answer is what L2 checks), so it is mutated together with that read.
  ['js', 'wallet: sends on a stale (resumed) status with no fresh word from the desk',
    ['S.freshId !== id || ', "return api('/api/swap?id=' + encodeURIComponent(id), undefined, tokenFor(id));\n      });"],
    ['', "return { ok: true, swap: cur };\n      });"]],
  // pair: the card's last look AND the desk's answer each check the amount still owed
  ['js', 'wallet: sends after the swap stopped waiting for this amount', ['walletAmount(cur) !== amt || ', 'walletAmount(f) !== amt || '], ['', '']],
  ['js', 'wallet: any answer taken as a tx hash', "if (typeof hash !== 'string' || !EVM_TX.test(hash))", 'if (typeof hash !== \'string\')'],
  ['js', 'wallet: any account the wallet names is used', "if (typeof from !== 'string' || !EVM_ADDR.test(from)) stop(", 'if (typeof from !== \'string\') stop('],
  ['js', 'wallet: malformed pay facts or deposit address are sent anyway', "if (!pay || !EVM_ADDR.test(sw.depositAddress) || !hex || hex === '0x0' || (pay.token && !EVM_ADDR.test(pay.token))) return;", 'if (!pay || !hex) return;'],
  ['js', 'wallet: offered without the desk\'s pay facts', "var wamt = sw.pay && typeof sw.pay === 'object' ? walletAmount(sw) : null;", 'var wamt = walletAmount(sw);'],
  ['js', 'wallet: token transfer also sends coin value', "{ to: pay.token, value: '0x0', data: '0xa9059cbb' + word(sw.depositAddress) + word(hex) }", "{ to: pay.token, value: hex, data: '0xa9059cbb' + word(sw.depositAddress) + word(hex) }"],
  ['js', 'wallet: token transfer pays the wallet itself, not the deposit address', "data: '0xa9059cbb' + word(sw.depositAddress) + word(hex) }", "data: '0xa9059cbb' + word(sw.refundTo) + word(hex) }"],
  ['js', 'wallet: wallet name rendered as HTML', "var b = h('button', 'xc-btn', busy ? 'Waiting for your wallet…' : 'Pay with ' + w.name); b.type = 'button';", "var b = h('button', 'xc-btn'); b.innerHTML = 'Pay with ' + w.name; b.type = 'button';"],
  ['js', 'failed copy is silent', '}, 1500); }, copyFailed); }', '}, 1500); }); }'],
  ['js', '"1,000" guessed instead of asked', "if (/^\\d+,\\d{3}$/.test(b.amount)) {", 'if (false) {'],
  ['js', '"1,000" folded into 1.000', " && !/,\\d{3}$/.test(s)) s = s.replace", ") s = s.replace"],
  ['js', 'explorer link taken from the feed', 'a.href = EXPLORER[chain] + hash;', 'a.href = t.explorerUrl;'],
  ['js', 'explorer link for a hash of any shape', 'if (EXPLORER[chain] && txHashOk(chain, hash)) {', 'if (EXPLORER[chain]) {'],
  ["js","unknown outcome leaves the form editable (drops the key)","S.pending = true; S.pendingBody = b; savePending(b); el.go.disabled = false; showAbandon(true); loadHistory();","S.pending = true; S.pendingBody = b; savePending(b); el.go.disabled = false; showAbandon(true); loadHistory(); setFormLocked(false);"],
  ["js","key that could not be stored is not reported","    return storedToken(id) === token;","    return true;"],
  ['js', 'swap list never capped (storage grows forever)', 'var kept = a.slice(0, 20);', 'var kept = a;'],
  // round 14 (round 13, second pass)
  ['js', 'pending key dropped by a refusal that does not say the key is free', 'if (S.pending && !j.keyFree) {', 'if (false) {'],
  ['js', 'pending key never released, even when the server says it is free', 'if (S.pending && !j.keyFree) {', 'if (S.pending) {'],
  // pair guard: history blocked while in doubt AND invalidateTerms keeps a pending key
  ['js', 'history card drops a pending key',
    ["if (S.issuing || S.pending) { say('Finish the request above first", "    if (S.pending) { updateGo(); return; }\n"],
    ["if (false) { say('Finish the request above first", '']],
  ['js', 'partial deposit with no amount asks for the full amount', "} else if (sw.state === 'incomplete_deposit') {", '} else if (false) {'],
  // no dates (owner's rule): the receipt drops page-only fields; the deadline is pinned, not re-read each poll
  ['js', 'receipt carries the page-only device-clock deadline', "if (k.charAt(0) !== '_') rec[k] = sw[k];", 'rec[k] = sw[k];'],
  ['js', 'deadline re-pinned on every answer (card redraws every poll)', 'if (isFinite(prev) && isFinite(dl) && Math.abs(prev - dl) < 5000) dl = prev;', ''],
  ['js', 'deposit card says nothing about the time left', 'var tl = h(\'div\', \'k\', timeLeftText(dlMs));', "var tl = h('div', 'k', '');"],
  ['js', 'half-typed tx hash lost on redraw', 'if (S.txDraft && S.txDraft.id === sw.id) tx.value = S.txDraft.v;', ''],
  ['js', 'coming back to the tab does not refresh the card', "document.addEventListener('visibilitychange', function () { resumed(null); });", ''],
  ['js', 'internal error treated as a known refusal (second swap on retry)', " || j.error === 'internal'", ''],
  ['js', 'status poll sent without the swap token', "api('/api/swap?id=' + encodeURIComponent(id), undefined, tokenFor(id)).then(function (j) {", "api('/api/swap?id=' + encodeURIComponent(id)).then(function (j) {"],
  ['html', 'recipient field autocapitalises (iOS "Alice.near")', 'id="xc-recipient" type="text" autocomplete="off" autocapitalize="none" autocorrect="off"', 'id="xc-recipient" type="text" autocomplete="off"'],
  ['css', 'swap-direction button below 44px tap target', 'width:44px;height:44px;cursor:pointer;color:var(--gold-bright)', 'width:30px;height:30px;cursor:pointer;color:var(--gold-bright)'],
  ['css', 'form inputs below 44px tap target', '.xc-wrap input[inputmode]{min-height:44px;', '.xc-wrap input[inputmode]{min-height:30px;'],
  ['css', 'inputs under 16px on phones (iOS zooms the page on focus)', '.xc-wrap input[inputmode]{font-size:16px;}}', '.xc-wrap input[inputmode]{font-size:13px;}}'],
  // round 15
  ['js', 'history card shows the address before a fresh status', 'var showDeposit = waiting && S.freshId === sw.id && !isAbandoned(sw.id);', 'var showDeposit = waiting && !isAbandoned(sw.id);'],
  ["js","back from sleep, the old address stays on screen","if (S.swap) { S.pollEpoch = (S.pollEpoch || 0) + 1; S.freshId = null; renderSwap(S.swap); poll(true); }","if (S.swap) { S.pollEpoch = (S.pollEpoch || 0) + 1; renderSwap(S.swap); poll(true); }"],
  ['js', 'an ordinary load\'s pageshow hides a fresh address', "    if (e && e.type === 'pageshow' && !e.persisted) return;\n", ''],
  // pair guard: Go disabled while issuing AND issue() refusing a second call
  ["js","Go re-armed while a request is in flight",["var ok = !S.issuing && ((S.pending","    if (S.issuing || S.swap) return;"],["var ok = ((S.pending","    if (S.swap) return;"]],
  ['js', 'non-array tx list breaks the card and stops polling', ['(Array.isArray(sw.originTxs) ? sw.originTxs : [])', '(Array.isArray(sw.destTxs) ? sw.destTxs : [])'], ['(sw.originTxs || [])', '(sw.destTxs || [])']],
  // round 16
  ['js', 'swap key only in storage (lost when the user returns from the wallet app)', "return KEYS_MEM[id] || '';", "return '';"],
  // pair guard: the poll epoch AND the never-older-than-shown check
  ['js', 'a poll answer from before the page slept is applied', ['        if (epoch !== S.pollEpoch) return;\n', '&& !(j.swap.rev < S.swap.rev)) {\n          land(j.swap);\n          var changed'], ['', ') {\n          land(j.swap);\n          var changed']],
  ['js', 'a reload orphans the request in doubt', 'if (pend && pend.body &&', 'if (false && pend && pend.body &&'],
  ['js', 'a late answer re-locks a page that already shows its swap', 'if (S.swap) { if (j.ok && j.swap) remember(j.swap.id, j.token); clearPending(); return; }', ''],
  // round 17
  ['js', 'two-tab repair checks the in-memory copy (never fires)', 'if (storedToken(id) !== token) {', 'if (tokenFor(id) !== token) {'],
  ['js', 'no way out of a request in doubt that keeps being refused', 'abandonBtn.hidden = !on;', 'abandonBtn.hidden = true;'],
  ['js', '"Start over" disabled by the form lock', 'if (i !== abandonBtn) i.disabled = locked;', 'i.disabled = locked;'],
  // round 18
  ['js', 'a late answer for an abandoned request opens its old swap', 'if (ABANDONED[b.idempotencyKey]) {', 'if (false) {'],
  // round 27/29: the proof-of-delivery box
  ["js","proof: a proof for another swap is shown","if (!f || f.swap !== sw.id) {","if (!f) {"],
  ["js","proof: the proof's own explorer link is used","if (f.payout && f.payout.tx) txLink(links, 'Payout ', sw.toChain, { hash: f.payout.tx });","if (f.payout && f.payout.explorer) { var ea = h('a', null, 'Payout'); ea.href = f.payout.explorer; links.appendChild(ea); }"],
  ["js","proof: check text rendered as HTML","body.appendChild(h('p', 'xc-state settled', f.checkText || ''));","var hp = h('p', 'xc-state settled'); hp.innerHTML = f.checkText || ''; body.appendChild(hp);"],
  ["js","proof: fetched without the swap key","api('/api/proof?id=' + encodeURIComponent(sw.id), undefined, tokenFor(sw.id))","api('/api/proof?id=' + encodeURIComponent(sw.id), undefined)"],
  ["js","proof: a late answer lands after the card changed","if (epoch !== S.pollEpoch || !S.swap || S.swap.id !== sw.id) return;     // another card by now",""],
  ["js","proof: box shown before the swap is settled","if (sw.state === 'settled') el.card.appendChild(proofBox(sw));","el.card.appendChild(proofBox(sw));"],
  ["js","proof: \"Check signature\" treats any answer as valid","j.ok && j.valid === true ? 'Signature valid","j.ok ? 'Signature valid"],
  ["css","proof: long receipt overflows the phone width","gap:8px;overflow-wrap:anywhere;}","gap:8px;white-space:nowrap;}"],
]

function runSuites(env, stopAtFirst, why) {
  const killers = []
  for (const [name, fn] of SUITES) {
    try { fn(env) } catch (e) {
      killers.push(name)
      // What broke, so a baseline failure can be told from a flake (it used to say only the suite name).
      if (why) why.push(name + ':\n    ' + String(e.stdout || e.message).split('\n').filter(l => /BROKE|Error|Timeout/.test(l)).slice(0, 6).join('\n    '))
      if (stopAtFirst) break
    }
  }
  return killers
}

// BASELINE through the hook with UNMODIFIED copies: every suite must pass,
// or a "kill" below could just be the hook itself breaking the page.
const baseJs = path.join(TMP, 'base.js'), baseHtml = path.join(TMP, 'base.html'), baseCss = path.join(TMP, 'base.css')
fs.writeFileSync(baseJs, JS); fs.writeFileSync(baseHtml, HTML); fs.writeFileSync(baseCss, CSS)
const BASE = { CLIENT_OVERRIDE_JS: baseJs, CLIENT_OVERRIDE_HTML: baseHtml, CLIENT_OVERRIDE_CSS: baseCss }
const baseWhy = []
const b = runSuites(BASE, false, baseWhy)
if (b.length) { console.log('BASELINE FAILED through the hook: ' + b.join(', ') + '\n  ' + baseWhy.join('\n  ')); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(2) }
console.log('baseline: all ' + SUITES.length + ' suites pass on unmodified copies served through the hook\n')

const results = []
try {
  for (const [kind, name, from0, to] of MUTANTS) {
    if (ONLY.length && !name.startsWith('HOOK SANITY') && !ONLY.some(o => name.toLowerCase().includes(o))) continue
    const src = kind === 'js' ? JS : kind === 'css' ? CSS : HTML
    // A pair guard (two independent layers that each close the same hole) is switched
    // off as a unit: `from0` / `to` may be arrays of edits, all applied to one copy.
    // Multi-line patterns follow the file's own line ending.
    const froms = Array.isArray(from0) ? from0 : [from0], tos = Array.isArray(to) ? to : [to]
    let out = src, missing = null
    froms.forEach((f0, i) => {
      const from = f0.replace(/\n/g, src.includes('\r\n') ? '\r\n' : '\n')
      const n = out.split(from).length - 1
      if (n !== 1) { if (missing === null) missing = n } else out = out.replace(from, tos[i])
    })
    if (missing !== null) { results.push([name, `NOT APPLIED (pattern found ${missing}×)`]); console.log('  NOT APPLIED ' + name + ` (${missing}×)`); continue }
    const file = path.join(TMP, 'mutant.' + kind)
    fs.writeFileSync(file, out)
    const env = { ...BASE, ['CLIENT_OVERRIDE_' + kind.toUpperCase()]: file }
    const killers = runSuites(env, true)
    results.push([name, killers.length ? 'killed by ' + killers.join(', ') : 'SURVIVED'])
    console.log((killers.length ? '  killed   ' : '  SURVIVED ') + name + (killers.length ? '  (' + killers.join(', ') + ')' : ''))
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}
const bad = results.filter(r => !r[1].startsWith('killed'))
console.log(`\n${results.length - bad.length}/${results.length} client mutants killed`)
for (const [n, r] of bad) console.log('  ! ' + n + ' — ' + r)
process.exit(bad.length ? 1 : 0)
