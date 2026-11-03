/* ============================================================
   CRYPTOLWA · cross-chain desk (NEAR Intents 1Click) — standalone page
   ------------------------------------------------------------
   Talks ONLY to its own /api/* (same origin; CSP connect-src 'self').
   No wallet SDK, no approvals, no account: the user sends from any wallet
   to a deposit address the server issued after its checks — by hand, or by
   letting a browser wallet (EIP-1193) send that one plain transfer.

   No account means each swap's access key (`token`, from the server) is kept
   in this browser's localStorage, with the swap id. The page has no inline
   script and no third-party script (CSP script-src 'self'), so nothing else
   on the page can read or plant one. Wallet addresses are never stored.

   Rules this file keeps:
     · every server string goes in with textContent / property assignment,
       never innerHTML
     · a deposit address is shown only from a server "swap" object
     · one idempotency key per "Get deposit address" decision, reused on retry,
       so a double click or a flaky network can never mint two addresses
     · no date is shown, stored or put in a receipt: the server sends the time
       left to send (`secondsLeft`), never a deadline or a timestamp
   ============================================================ */
(function () {
  'use strict';
  var root = document.getElementById('xc-desk');
  if (!root) return;

  // ── tiny DOM helpers ──────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(e) { while (e && e.firstChild) e.removeChild(e.firstChild); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  // Whole numbers as digit strings, so no browser needs BigInt (iOS before 14 has none).
  function digits(s) { s = String(s || '').replace(/^0+(?=\d)/, ''); return /^\d+$/.test(s) ? s : null; }
  function cmpDigits(a, b) { return a.length !== b.length ? (a.length < b.length ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0; }
  function subDigits(a, b) {      // a - b, a >= b
    var out = '', borrow = 0;
    for (var i = a.length - 1, j = b.length - 1; i >= 0; i--, j--) {
      var d = (a.charCodeAt(i) - 48) - borrow - (j >= 0 ? b.charCodeAt(j) - 48 : 0);
      borrow = d < 0 ? 1 : 0; out = String(d < 0 ? d + 10 : d) + out;
    }
    return out.replace(/^0+(?=\d)/, '');
  }
  function fromBase(s, dec) {
    s = String(s || '0').replace(/^0+(?=\d)/, '');
    if (!/^\d+$/.test(s)) return '—';
    if (!dec) return s;
    while (s.length <= dec) s = '0' + s;
    var i = s.slice(0, s.length - dec), f = s.slice(s.length - dec).replace(/0+$/, '');
    // Never truncated: red-team round 2 — the card said "send 0.01234567 ETH"
    // while the router expected 0.0123456789012; a member sending what the card
    // said would underpay and be refunded. Every amount is shown in full.
    return f ? i + '.' + f : i;
  }
  function pct(bps) { return (bps / 100).toFixed(2) + '%'; }
  function usd(n) { return n == null || !isFinite(n) ? '—' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  var SUPPORT = 'support@cryptolwa.io';

  // The server says how long is left (`secondsLeft`), never when: the deadline is pinned
  // on this device's clock when an answer lands, and kept while later answers agree within
  // a few seconds, so network delay cannot make the card redraw on every poll. `_dl` is
  // this page's own field and never leaves it (the receipt drops "_" fields).
  var DL = {};
  function land(sw) {
    if (!sw || typeof sw !== 'object') return sw;
    var prev = S.swap && S.swap.id === sw.id && isFinite(S.swap._dl) ? S.swap._dl : DL[sw.id];
    var dl = typeof sw.secondsLeft === 'number' && isFinite(sw.secondsLeft) ? Date.now() + sw.secondsLeft * 1000 : NaN;
    if (isFinite(prev) && isFinite(dl) && Math.abs(prev - dl) < 5000) dl = prev;
    sw._dl = dl;
    if (isFinite(dl)) DL[sw.id] = dl;
    return sw;
  }
  function timeLeftText(dlMs) {
    var m = Math.max(0, Math.ceil((dlMs - Date.now()) / 60000));
    var left = m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min';
    return 'Time left to send: ' + left + '. After that this address stops working.';
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var x = Array.prototype.map.call(b, function (v) { return (v + 256).toString(16).slice(1); }).join('');
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
  }

  // ── this device's swaps: [{id, token}], newest first, at most 20 ──────
  var KEYS = 'desk.swaps';
  function myKeys() {
    try { var a = JSON.parse(store(KEYS) || '[]'); return Array.isArray(a) ? a.filter(function (x) { return x && typeof x.id === 'string' && typeof x.token === 'string'; }) : []; }
    catch (e) { return []; }
  }
  // false when the browser refused to save it (quota, private mode): the caller says so.
  function remember(id, token) {
    if (!id || !token) return false;
    var a = myKeys().filter(function (x) { return x.id !== id; });
    a.unshift({ id: id, token: token });
    // Only the id and key are kept per swap (no quote, nothing dated), so a swap that falls off the list leaves nothing behind.
    var kept = a.slice(0, 20);
    try { localStorage.setItem(KEYS, JSON.stringify(kept)); } catch (e) { return false; }
    // Two tabs saving at the same moment can each write a list without the other's swap
    // (round 13, second pass): look again shortly and put this one back if it was lost.
    // Storage itself, not tokenFor(): its in-memory fallback made this check always pass (round 17).
    setTimeout(function () { if (storedToken(id) !== token) { var b = myKeys().filter(function (x) { return x.id !== id; }); b.unshift({ id: id, token: token }); try { localStorage.setItem(KEYS, JSON.stringify(b.slice(0, 20))); } catch (e) {} } }, 400);
    return storedToken(id) === token;
  }
  // At the END of the list, and only if there is room (round 22): an abandoned swap must never push
  // out — and delete the key and receipt of — a real swap that may still be in progress.
  function rememberLast(id, token) {
    var a = myKeys().filter(function (x) { return x.id !== id; });
    if (a.length >= 20) return false;
    a.push({ id: id, token: token });
    try { localStorage.setItem(KEYS, JSON.stringify(a)); return true; } catch (e) { return false; }
  }
  function storedToken(id) { var a = myKeys(); for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i].token; return ''; }
  // In memory too (round 16): a browser that will not store the key still has it for as
  // long as the page is open. It used to lose the address the moment the user came back
  // from their wallet app (the poll went out with no key and got 404).
  var KEYS_MEM = {};
  function tokenFor(id) { var a = myKeys(); for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i].token; return KEYS_MEM[id] || ''; }

  function api(path, body, token) {
    var init = { credentials: 'omit', headers: { accept: 'application/json' } };
    if (token) init.headers['x-swap-token'] = token;
    if (body !== undefined) { init.method = 'POST'; init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    // A request that never answers ends as "unknown" after 45 s (round 20: a stalled connection
    // left the page locked with nothing to do). Unknown is the safe reading: the key is kept.
    var ctl = typeof AbortController === 'function' ? new AbortController() : null, tm = null;
    if (ctl) { init.signal = ctl.signal; tm = setTimeout(function () { ctl.abort(); }, 45000); }
    // …and a timer that wins regardless (round 22: where abort does not cancel fetch, the limit never fired)
    var timeout = new Promise(function (res) { setTimeout(function () { res({ ok: false, error: 'network', _status: 0, message: 'No answer in 45 seconds — we could not confirm the result.' }); }, 46000); });
    return Promise.race([timeout, fetch(path, init).then(function (r) {
      clearTimeout(tm);
      return r.json().catch(function () { return { ok: false, error: 'bad_response' }; }).then(function (j) { j = j || {}; j._status = r.status; return j; });
    }, function () { clearTimeout(tm); return { ok: false, error: 'network', _status: 0, message: 'Network error — we could not confirm the result.' }; })]);
  }

  // ── state ─────────────────────────────────────────────────────────────
  var S = { chains: [], tokens: [], pausedRoutes: [], limits: null, slippage: null, enabled: false,
            terms: null, termsKey: '', idem: null, previewSeq: 0, timer: null, refreshTimer: null,
            swap: null, pollTimer: null };

  var el = {
    fromChain: $('xc-from-chain'), fromTok: $('xc-from-token'), amount: $('xc-amount'),
    toChain: $('xc-to-chain'), toTok: $('xc-to-token'), recipient: $('xc-recipient'), refund: $('xc-refund'),
    slip: $('xc-slippage'), msg: $('xc-msg'), preview: $('xc-preview'), confirm: $('xc-confirm'),
    ack1: $('xc-ack-amount'), ack2: $('xc-ack-address'), go: $('xc-go'), card: $('xc-card'),
    history: $('xc-history'), refreshHist: $('xc-history-refresh'), recipLbl: $('xc-recipient-label'), refundLbl: $('xc-refund-label'),
    form: $('xc-form'), status: $('xc-status-pill'),
  };

  function say(text, cls) { el.msg.textContent = text || ''; el.msg.className = 'xc-msg' + (cls ? ' ' + cls : ''); }
  function chainLabel(id) { for (var i = 0; i < S.chains.length; i++) if (S.chains[i].id === id) return S.chains[i].label; return id; }
  function tok(id) { for (var i = 0; i < S.tokens.length; i++) if (S.tokens[i].id === id) return S.tokens[i]; return null; }

  function fillChains(sel, keep) {
    clear(sel);
    S.chains.forEach(function (c) {
      var o = h('option', null, c.label + (c.paused ? ' (paused)' : ''));
      o.value = c.id; o.disabled = !!c.paused; sel.appendChild(o);
    });
    if (keep) sel.value = keep;
  }
  // A chain picked without a matching token starts on its main coin, not the first one in the list
  // (the list is alphabetical: NEAR opened on "ABG", Base on "BRETT", Solana on "$WIF").
  var MAIN_COIN = { eth: 'ETH', base: 'ETH', arb: 'ETH', op: 'ETH', bsc: 'BNB', pol: 'POL', avax: 'AVAX', gnosis: 'xDAI',
    btc: 'BTC', ltc: 'LTC', doge: 'DOGE', tron: 'TRX', sol: 'SOL', near: 'wNEAR' };
  function fillTokens(sel, chain, keepSymbol) {
    clear(sel);
    S.tokens.filter(function (t) { return t.chain === chain && !t.paused; }).forEach(function (t) {
      var o = h('option', null, t.symbol); o.value = t.id; sel.appendChild(o);
    });
    [keepSymbol, MAIN_COIN[chain]].some(function (want) {
      if (!want) return false;
      for (var i = 0; i < sel.options.length; i++) if (sel.options[i].textContent === want) { sel.selectedIndex = i; return true; }
      return false;
    });
  }
  // Addresses are NOT remembered (red-team round 2): a stored address can be
  // planted by any script that ever runs on the origin and then pre-filled as
  // the user's own receiving address.

  function syncLabels() {
    el.recipLbl.textContent = 'Your receiving address on ' + chainLabel(el.toChain.value);
    el.refundLbl.textContent = 'Your refund address on ' + chainLabel(el.fromChain.value) + ' (if the swap cannot complete)';
  }

  // ── preview (dry quote) ───────────────────────────────────────────────
  // What phone keyboards really type (measured on WebKit 26.5 + Chromium, round 9):
  //  · amounts: full-width digits from CJK keyboards ("３５") and a decimal COMMA
  //    from European keyboards ("35,5") — normalised to "35" / "35.5";
  //  · addresses: invisible direction / zero-width marks and line breaks that chat
  //    apps add on copy — removed. Nothing else is changed (case matters on
  //    Solana / EVM checksums), the cleaned text is written back into the field so
  //    the member sees exactly what will be used, and the server still validates it.
  var INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\s]/g;
  function cleanAmount(v) {
    var s = String(v || '');
    try { s = s.normalize('NFKC'); } catch (e) {}
    s = s.replace(INVISIBLE, '');
    // One comma, no point, and NOT exactly three digits after it: a decimal comma ("35,5").
    // "1,000" is left as typed and asked about (schedulePreview).
    if (s.indexOf(',') !== -1 && s.indexOf('.') === -1 && (s.match(/,/g) || []).length === 1 && !/,\d{3}$/.test(s)) s = s.replace(',', '.');
    return s;
  }
  // QR-scanner pastes (mobile round 2, WebKit 26.5 + Chromium): scanners hand over
  // "bitcoin:bc1…?amount=…", "solana:…", "ethereum:0x…@42161" instead of the bare
  // address. Only these simple forms are unwrapped. Anything with a path — e.g. an
  // EIP-681 token transfer "ethereum:<token>/transfer?address=…" — is left exactly
  // as pasted (the server refuses it and the member fixes it): never guessed.
  var URI = /^(bitcoin|litecoin|dogecoin|solana|tron|ethereum):(?:\/\/)?(?:pay-)?([^?@/]+)(?:@\d+)?(?:\?[^/]*)?$/i;
  function cleanAddr(v) {
    var s = String(v || '').replace(INVISIBLE, '');
    var m = URI.exec(s);
    return m ? m[2] : s;
  }
  function reflect(input, cleaned) { if (input.value !== cleaned && document.activeElement !== input) input.value = cleaned; }
  function formBody() {
    var a = cleanAmount(el.amount.value), r = cleanAddr(el.recipient.value), f = cleanAddr(el.refund.value);
    reflect(el.amount, a); reflect(el.recipient, r); reflect(el.refund, f);
    return { from: el.fromTok.value, to: el.toTok.value, amount: a, recipient: r, refundTo: f, slippageBps: Number(el.slip.value) };
  }
  function invalidateTerms() {
    // A request whose outcome is still in doubt keeps its terms and its key: nothing on
    // the page may drop them (round 13, second pass — see S.pending in issue()).
    if (S.pending) { updateGo(); return; }
    S.terms = null; S.idem = null; el.ack1.checked = false; el.ack2.checked = false;
    // The boxes still read the OLD swap's words (amount, chain, "every key listed above is mine"):
    // hidden until fresh terms render, so a box cannot be ticked against the wrong swap.
    el.confirm.hidden = true; updateGo();
  }
  function setFormLocked(locked) { el.form.querySelectorAll('input,select,button').forEach(function (i) { if (i !== abandonBtn) i.disabled = locked; }); }   // 'Start over' is the way OUT of a lock
  function schedulePreview() {
    // While a deposit request is in flight, or its outcome is in doubt, the key must
    // survive (QA re-audit): edits wait until the answer is in.
    if (S.issuing || S.pending) return;
    invalidateTerms();
    clearTimeout(S.timer);
    // Any preview already in flight is now for an older form (round 13: its answer
    // landed and was paired with the NEW amount, so the boxes were ticked against one
    // amount and the request sent another).
    S.previewSeq++;
    var b = formBody();
    if (!b.from || !b.to || !b.amount || !b.recipient || !b.refundTo) { clear(el.preview); say('Fill in every field to see a live price.'); return; }
    // "1,000": a thousand (US) or one (Europe)? Asked, never guessed (round 13).
    if (/^\d+,\d{3}$/.test(b.amount)) { clear(el.preview); say('Is that a thousand or one? Write it without the comma (1000) or with a point (1.000).', 'err'); return; }
    if (!/^\d+(\.\d+)?$/.test(b.amount)) { clear(el.preview); say('Enter the amount as a number, like 250 or 0.05.', 'err'); return; }
    say('Getting a live price…');
    S.timer = setTimeout(preview, 650);
  }
  function preview() {
    var b = formBody();
    var key = JSON.stringify(b);   // the form this price is FOR, captured when asked
    b.dry = true;
    var seq = ++S.previewSeq;
    api('/api/quote', b).then(function (j) {
      if (seq !== S.previewSeq || S.issuing || S.pending || S.swap) return;   // stale, or a deposit request is in flight / in doubt
      if (key !== JSON.stringify(formBody())) return;           // the form changed while it was in flight
      if (!j.ok) { clear(el.preview); say(j.message || ('Could not price this swap (' + (j.error || j._status) + ').'), 'err'); markField(j.field); return; }
      markField(null);
      // QA: a refresh must never silently replace the price the member
      // ticked the boxes against. Any change to the numbers clears the boxes.
      var prev = S.terms;
      if (prev && (prev.amountOut !== j.terms.amountOut || prev.minAmountOut !== j.terms.minAmountOut) && (el.ack1.checked || el.ack2.checked)) {
        el.ack1.checked = false; el.ack2.checked = false;
        setTimeout(function () { say('The price updated — check the new numbers and tick the boxes again.', 'err'); }, 0);
      }
      S.terms = j.terms; S.termsKey = key;
      renderTerms(j.terms);
      say(j.terms.risk.allow ? 'Live price. It refreshes every 30 seconds.' : '', j.terms.risk.allow ? 'ok' : '');
      clearTimeout(S.refreshTimer);
      S.refreshTimer = setTimeout(function () { if (!S.swap && !S.pending && !S.issuing && document.visibilityState === 'visible' && S.termsKey === JSON.stringify(formBody())) preview(); }, 30000);
    });
  }
  function markField(field) {
    [el.recipient, el.refund, el.amount].forEach(function (i) { i.classList.remove('bad'); });
    if (field === 'recipient') el.recipient.classList.add('bad');
    if (field === 'refundTo') el.refund.classList.add('bad');
    if (field === 'amount') el.amount.classList.add('bad');
  }
  function row(dl, k, v, cls) { var d = h('div', 'xc-row' + (cls ? ' ' + cls : '')); d.appendChild(h('span', 'k', k)); d.appendChild(h('span', 'v', v)); dl.appendChild(d); }

  function renderTerms(t) {
    clear(el.preview);
    var box = h('div', 'xc-terms');
    row(box, 'You send', t.amountInFmt + ' ' + t.from.symbol + ' on ' + t.from.chainLabel);
    row(box, 'You receive (estimate)', t.amountOutFmt + ' ' + t.to.symbol + ' on ' + t.to.chainLabel, 'big');
    row(box, 'Guaranteed minimum', t.minAmountOutFmt + ' ' + t.to.symbol + ' (or a full refund)');
    var c = t.price.costBps;
    row(box, 'Cost vs market price', c === null ? 'no independent price available' :
      (c <= 0 ? 'better than market by ' + pct(-c) : pct(c) + (t.price.usdIn ? ' (≈ ' + usd(t.price.usdIn * c / 10000) + ')' : '')),
      c !== null && c > 150 ? 'warn' : '');
    // The fee is already in the price above; the cost can even be lower than
    // the fee when the filler beats the market mid, so they are not added.
    row(box, 'Fees (already in the price)', '1Click ' + pct(t.fees.platformBps) + ' · this desk ' + (t.fees.oursBps ? pct(t.fees.oursBps) : 'none'));
    if (t.timeEstimateSec) row(box, 'Typical time after your deposit confirms', '~' + Math.max(1, Math.round(t.timeEstimateSec / 60)) + ' min');
    row(box, 'Price source', t.price.source === 'market' ? 'CoinGecko / DeFiLlama market price (independent of the router)' : 'none — preview only, no deposit address will be issued');
    var nk = nearKeysRows(box, t.nearKeys);
    el.preview.appendChild(box);
    if (t.risk.text.length) {
      var ul = h('ul', 'xc-risk' + (t.risk.allow ? ' warn' : ' stop'));
      t.risk.text.forEach(function (s) { ul.appendChild(h('li', null, s)); });
      el.preview.appendChild(ul);
    }
    el.ack1.nextElementSibling.textContent = 'I will send exactly ' + t.amountInFmt + ' ' + t.from.symbol + ' on the ' + t.from.chainLabel + ' network, from a wallet I control.';
    el.ack2.nextElementSibling.textContent = 'The receiving address is my own wallet on ' + t.to.chainLabel + ' (not an exchange deposit that needs a memo or tag).'
      + (nk ? ' Every full-access key listed above is mine.' : '');
    el.confirm.hidden = false;
    updateGo();
  }
  // The key checker: who can sign for the NEAR account the payout lands in. A full-access key added
  // by a phishing page is how NEAR accounts are taken over, so the keys are shown for the member to
  // match against their own wallet before they accept. True when keys were listed.
  function nearKeysRows(box, k) {
    if (!k || typeof k !== 'object' || typeof k.account !== 'string') return false;
    var who = 'Who controls ' + k.account;
    var full = Array.isArray(k.full) ? k.full.filter(function (x) { return typeof x === 'string'; }) : [];
    if (k.checked !== true) { row(box, who, 'could not check right now', 'warn'); return false; }
    if (k.tooMany) { row(box, who, 'more than 100 keys: check them in your wallet', 'warn'); return false; }
    if (k.locked) { row(box, who, 'no keys: only its smart contract', 'warn'); return false; }
    if (k.fresh) { row(box, who, k.ethImplicit ? 'the Ethereum wallet with this address' : /^[0-9a-f]{64}$/.test(k.account) ? 'new account: the key its address is made from' : 'this account does not exist yet'); return false; }
    if (!full.length) { row(box, who, k.ethImplicit ? 'the Ethereum wallet with this address' : 'no full-access key'); return false; }
    var lim = Number(k.limited) > 0 ? ' · ' + Number(k.limited) + ' app key' + (Number(k.limited) === 1 ? '' : 's') + ' (can’t transfer NEAR)' : '';
    row(box, who, full.length + ' full-access key' + (full.length === 1 ? '' : 's') + lim + ': check ' + (full.length === 1 ? 'it matches' : 'each one is') + ' yours', full.length > 1 ? 'warn' : '');
    full.forEach(function (pk) { row(box, 'Full-access key', pk, 'nearkey'); });
    return true;
  }
  function updateGo() {
    // Never while a request is in flight (round 15: the tick boxes sit outside the locked
    // form, so re-ticking re-armed Go and a second press went out beside the first).
    // A request in doubt is retried as it was sent, so the boxes and terms do not gate it (round 22:
    // after a reload there are no terms, and Go went dead — only "Start over" was left).
    var ok = !S.issuing && ((S.pending && !!S.pendingBody) || !!(S.terms && S.terms.risk.allow && el.ack1.checked && el.ack2.checked && S.enabled));
    el.go.disabled = !ok;
  }

  // ── issue a deposit address ───────────────────────────────────────────
  // A request whose outcome is in doubt is kept for THIS TAB (sessionStorage), so a reload
  // checks it again instead of orphaning a swap it may have created (round 16). Never the
  // swap key: only the request itself, which can only ever return its own swap.
  var PENDING = 'desk.pending';
  function savePending(b) { try { sessionStorage.setItem(PENDING, JSON.stringify({ idem: S.idem, body: b, at: Date.now() })); } catch (e) {} }
  // What the request in doubt IS, in words (round 22): after a reload the form is empty, so the
  // page must say what it keeps re-sending.
  function pendingWhat() {
    var b = S.pendingBody; if (!b) return '';
    var t = tok(b.from);
    return ' for ' + b.amount + ' ' + (t ? t.symbol : '') + ' to ' + b.recipient;
  }
  function clearPending() { S.pending = false; S.pendingBody = null; showAbandon(false); try { sessionStorage.removeItem(PENDING); } catch (e) {} }
  // "Start over" (round 17): a request in doubt that keeps being refused (desk paused,
  // route paused, budgets) used to lock the tab for up to an hour, reloads included. The
  // user may drop it. If it did create an address, that address was never shown, so
  // nothing can be sent to it; it expires unused.
  var abandonBtn = null, ABANDONED = {};
  // Swaps made by a request the user abandoned (round 20): kept on this device so they can be
  // found, but marked, and their card never offers the address — the page told the user it
  // would expire unused.
  var ABANDONED_SWAPS = 'desk.abandoned';
  function abandonedSwaps() { try { var a = JSON.parse(localStorage.getItem(ABANDONED_SWAPS) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function markAbandoned(id) { var a = abandonedSwaps(); if (a.indexOf(id) < 0) a.unshift(id); try { localStorage.setItem(ABANDONED_SWAPS, JSON.stringify(a.slice(0, 40))); } catch (e) {} }
  function isAbandoned(id) { return abandonedSwaps().indexOf(id) >= 0; }
  function showAbandon(on) {
    if (!abandonBtn) {
      abandonBtn = h('button', 'xc-btn ghost', 'Start over'); abandonBtn.type = 'button'; abandonBtn.hidden = true;
      abandonBtn.addEventListener('click', function () {
        if (S.issuing) { say('Wait for the current attempt to finish (at most 45 seconds), then Start over.', 'err'); return; }
        // The abandoned key is remembered for this page's life (round 18): a late answer for it
        // (back/forward cache) may only be stored, never put on screen or re-arm anything.
        if (S.idem) ABANDONED[S.idem] = 1;
        clearPending(); S.idem = null; setFormLocked(false); invalidateTerms();
        say('Started over. If that earlier request did create a deposit address, it was never shown to you and expires unused.');
        schedulePreview(); loadHistory();
      });
      el.msg.parentNode.insertBefore(abandonBtn, el.msg.nextSibling);
    }
    abandonBtn.hidden = !on;
  }
  function issue() {
    if (S.issuing || S.swap) return;
    // In doubt: resend EXACTLY the request already sent (same key, same body).
    if (S.pending && S.pendingBody) { send(S.pendingBody); return; }
    if (!S.terms) return;
    // A preview still in flight belongs to the form before this press (round 15: its late
    // answer replaced the terms and the "press again" warning while the outcome was in doubt).
    S.previewSeq++; clearTimeout(S.timer);
    if (S.termsKey !== JSON.stringify(formBody())) { schedulePreview(); return; }
    if (!S.idem) S.idem = uuid();
    var b = formBody(); b.dry = false; b.idempotencyKey = S.idem; b.acceptedAmountOut = S.terms.amountOut;
    // Saved BEFORE it is sent (round 20): a reload or a discarded tab during the very first
    // request used to lose it, and the next press minted a second swap.
    savePending(b);
    send(b);
  }
  function send(b) {
    var call = S.issueSeq = (S.issueSeq || 0) + 1;
    S.inFlightBody = b;
    clearTimeout(S.refreshTimer); S.issuing = true;
    setFormLocked(true);
    el.go.disabled = true; say('Checking everything and requesting your deposit address…');
    api('/api/quote', b).then(function (j) {
      // An answer that carries a swap is ALWAYS kept, whichever press it answers: its key is
      // the only way back to that swap (round 16).
      if (j.ok && j.swap && j.token) KEYS_MEM[j.swap.id] = j.token;
      // A request the user abandoned with "Start over": its swap (if any) is kept so it can be
      // found in history, but nothing on screen changes and nothing is re-armed (round 18).
      if (ABANDONED[b.idempotencyKey]) {
        if (j.ok && j.swap) { markAbandoned(j.swap.id); rememberLast(j.swap.id, j.token); loadHistory(); }
        if (call === S.issueSeq) { S.issuing = false; updateGo(); }
        return;
      }
      // An older press answering late (after a back/forward-cache restore and a second press):
      // only a swap may still act, and only while no card is open.
      // (round 17) …and only if no OTHER request is in flight: a different key's answer is still coming.
      var otherInFlight = S.issuing && S.inFlightBody && S.inFlightBody.idempotencyKey !== b.idempotencyKey;
      if (call !== S.issueSeq && !(j.ok && j.swap && !S.swap && !otherInFlight)) { if (j.ok && j.swap) { remember(j.swap.id, j.token); loadHistory(); } return; }
      S.issuing = false;
      // A card is already open (an earlier answer won): nothing here may lock the page again.
      if (S.swap) { if (j.ok && j.swap) remember(j.swap.id, j.token); clearPending(); return; }
      // Outcome UNKNOWN (no JSON, network drop, an unexplained 5xx): the server may
      // already hold a swap for this key. From now on the key is PENDING: the form stays
      // LOCKED, history cannot open, and only "Go" works, resending the SAME request with
      // the SAME key, which can only return that same swap (round 13).
      var unknown = j.error === 'network' || j.error === 'bad_response' || j.error === 'in_progress' || j.error === 'internal' || (j._status >= 500 && !j.error);
      if (unknown) {
        S.pending = true; S.pendingBody = b; savePending(b); el.go.disabled = false; showAbandon(true); loadHistory();
        say('We could not confirm whether a deposit address was issued' + pendingWhat() + '. Press the button again: it returns the same swap, never a second one. (Reloading the page checks it again.)', 'err');
        return;
      }
      if (j.ok && j.swap) {
        clearPending(); setFormLocked(false);
        var kept = remember(j.swap.id, j.token);
        S.idem = null;
        openSwap(j.swap, j.terms || S.terms, true);
        loadHistory();
        say(!kept ? 'This browser would not save the key for this swap, so after you leave this page it cannot be tracked here. Download the receipt now; the swap itself is not affected.' : '',
          kept ? '' : 'err');
        return;
      }
      // A refusal while the key is PENDING proves nothing about the first press unless the
      // server says the key is free (round 13, second pass: a 429 or an RPC blip on a retry
      // used to drop the key, and the next press minted a second swap). The server serves
      // any swap the key already made before every check that could refuse it.
      if (S.pending && !j.keyFree) {
        el.go.disabled = false; showAbandon(true);
        say((j.message || ('Refused: ' + (j.error || j._status))) + ' Your earlier request may still have created a deposit address, so this page keeps that same request: press again to retry it, or Start over.', 'err');
        return;
      }
      clearPending(); setFormLocked(false);
      if (j.error === 'terms_changed' && j.terms) {
        S.idem = null; S.terms = j.terms; renderTerms(j.terms);
        el.ack1.checked = el.ack2.checked = false; updateGo();
        say(j.message, 'err'); return;
      }
      S.idem = null; updateGo();
      say(j.message || ('Refused: ' + (j.error || j._status)), 'err');
    });
  }

  // ── the swap card ─────────────────────────────────────────────────────
  var STEPS = [
    ['awaiting_deposit', 'Waiting for your deposit'],
    ['deposit_seen', 'Deposit seen'],
    ['processing', 'Swapping'],
    ['delivered_claimed', 'Delivered — confirming on-chain'],
    ['settled', 'Done'],
  ];
  var ORDER = { awaiting_deposit: 0, expired: 0, deposit_seen: 1, incomplete_deposit: 1, processing: 2, delivered_claimed: 3, settled: 4, refunded: 4, failed: 4 };
  function stateText(sw) {
    var to = chainLabel(sw.toChain), from = chainLabel(sw.fromChain);
    switch (sw.state) {
      case 'awaiting_deposit': return 'Send the exact amount below to the deposit address. We will pick it up automatically.';
      case 'deposit_seen': return 'Your deposit was seen on ' + from + '. Waiting for it to confirm.';
      case 'incomplete_deposit': return 'Less than the quoted amount arrived. Send the rest before the deadline, or the deposit is refunded to your refund address.';
      case 'processing': return 'Your swap is being filled.';
      case 'delivered_claimed':
        // round 30: the payout tx succeeded but the receiving address's own code can hide the amount
        // round 33: also a native payout made through a contract, whose amount cannot be tied to this swap on-chain
        if (sw.destVerified === 'unproven') return '1Click reports the payout and its transaction succeeded on ' + to + ', but this desk could not tie the amount to this swap on-chain. Check your wallet; the desk operator will confirm this swap.';
        return '1Click reports the payout. We are confirming it on ' + to + ' before calling it done.';
      case 'settled':
        if (sw.destVerified === 'verified') return 'Delivered — we checked the payout on ' + to + ' ourselves.';
        if (sw.destVerified === 'confirmed') return 'Delivered — the payout transaction succeeded on ' + to + '.';
        // round 21: closed by the operator after a review (admin 'resolve'), not checked on-chain
        if (sw.destVerified === 'manual') return 'Closed by the desk operator after a manual review of the payout. Keep your receipt.';
        return 'Delivered — reported by 1Click. Payouts on ' + to + ' are not independently checked by this desk yet.';
      // 1Click's word, not something this desk checked on-chain — said so (red-team round 4).
      case 'refunded': return '1Click reports a refund to your refund address' + (sw.refundReason ? ' (' + sw.refundReason + ')' : '') + '. Check your wallet; if nothing arrives within an hour, email ' + SUPPORT + ' with your receipt.';
      case 'failed': return 'The swap failed. Email ' + SUPPORT + ' with your receipt — keep it safe.';
      case 'expired': return 'The deposit window closed. Do NOT send to this address now. If you already sent, it will be found and processed: swapped if 1Click still accepts it, otherwise refunded to your refund address.';
    }
    return sw.state;
  }

  // `fresh`: this swap object is the server's answer of a moment ago. A card opened from
  // the history list (data from when the list loaded) or after the page slept shows NO
  // deposit address until a fresh status arrives (round 15: a swap already paid from
  // another device still showed "Send exactly …" for its first 10 s — pay twice).
  function openSwap(sw, terms, fresh) {
    land(sw);
    S.pollEpoch = (S.pollEpoch || 0) + 1;
    if (!S.swap || S.swap.id !== sw.id) { S.txDraft = null; S.copyFailed = null; }
    S.swap = sw; S.freshId = fresh ? sw.id : null;
    clearTimeout(S.refreshTimer); clearTimeout(S.timer); S.previewSeq++;
    // Drop the accepted terms: nothing on screen may be able to request another address for them.
    invalidateTerms();
    el.form.hidden = true; el.confirm.hidden = true; clear(el.preview);
    renderSwap(sw, terms);
    poll(!fresh);
  }
  function closeSwap() {
    S.pollEpoch = (S.pollEpoch || 0) + 1;
    clearTimeout(S.pollTimer); S.swap = null; clear(el.card); el.card.hidden = true;
    el.form.hidden = false; setFormLocked(false); invalidateTerms(); schedulePreview();
  }

  function renderSwap(sw, terms) {
    var ft = tok(sw.fromAsset), tt = tok(sw.toAsset);
    // The swap's OWN decimals and symbols, frozen at issue (red-team round 4): a token
    // list that later drops the token or changes its decimals must never change what
    // the member is told to send. Without them, nothing is shown rather than a guess.
    var fsym = sw.fromSymbol || '', tsym = sw.toSymbol || '';
    var fdec = Number.isInteger(sw.fromDecimals) ? sw.fromDecimals : null, tdec = Number.isInteger(sw.toDecimals) ? sw.toDecimals : null;
    if (fdec === null || tdec === null) { clear(el.card); el.card.hidden = false; el.card.appendChild(h('p', 'xc-state failed', 'This swap is missing its amount details. Do not send anything — email ' + SUPPORT + ' with the swap id ' + sw.id + '.')); return; }
    clear(el.card); el.card.hidden = false;

    var steps = h('ol', 'xc-steps');
    var cur = ORDER[sw.state] === undefined ? 0 : ORDER[sw.state];
    var END = { refunded: 'Refunded', failed: 'Failed', expired: 'Expired' };
    STEPS.forEach(function (s, i) {
      var label = i === STEPS.length - 1 && END[sw.state] ? END[sw.state] : s[1];
      var li = h('li', i < cur ? 'done' : i === cur ? 'now' : '', label);
      steps.appendChild(li);
    });
    if (sw.state === 'refunded' || sw.state === 'failed' || sw.state === 'expired') steps.className += ' halted';
    el.card.appendChild(steps);
    el.card.appendChild(h('p', 'xc-state ' + sw.state, stateText(sw)));

    // The address is offered only while it is alive by THIS device's clock too: a
    // tab left open for days must not keep showing a dead address until the next
    // poll lands (red-team round 2). A timer re-renders the card at the deadline.
    var dlMs = sw._dl;
    var alive = isFinite(dlMs) && dlMs > Date.now();
    var waiting = (sw.state === 'awaiting_deposit' || sw.state === 'incomplete_deposit') && alive;
    var showDeposit = waiting && S.freshId === sw.id && !isAbandoned(sw.id);
    if (waiting && isAbandoned(sw.id)) el.card.appendChild(h('p', 'xc-state expired', 'You started over before this deposit address was shown. Do NOT send to it: it expires unused. If you already sent, it is tracked here and refunded or swapped as usual.'));
    if (waiting && !showDeposit) el.card.appendChild(h('p', 'xc-state', 'Checking the latest status of this swap before showing where to send…'));
    clearTimeout(S.deadlineTimer);
    if (showDeposit && dlMs - Date.now() < 2147483647) S.deadlineTimer = setTimeout(function () { if (S.swap && S.swap.id === sw.id) renderSwap(S.swap, terms); }, dlMs - Date.now() + 500);
    if ((sw.state === 'awaiting_deposit' || sw.state === 'incomplete_deposit') && !alive)
      el.card.appendChild(h('p', 'xc-state expired', 'This deposit address has expired. Do NOT send to it. If you already sent, it will be found and processed: swapped if 1Click still accepts it, otherwise refunded to your refund address.'));
    if (showDeposit && sw.depositAddress) {
      var dep = h('div', 'xc-deposit');
      var left = h('div', 'xc-dep-text');
      // A partial deposit asks only for the rest — paying the full amount again
      // would overpay and cost a refund fee (red-team round 2).
      // Digit-string arithmetic, not BigInt (round 13): without BigInt (iOS before 14) the
      // card asked for the FULL amount while the text above said "send the rest", and a
      // user following the big number paid the received part twice.
      var owed = digits(sw.amountIn), got = digits(sw.deposited);
      if (sw.state === 'incomplete_deposit' && owed && got && got !== '0' && cmpDigits(got, owed) < 0) {
        left.appendChild(h('div', 'k', 'Received so far: ' + fromBase(got, fdec) + ' ' + fsym + '. Send the remaining'));
        left.appendChild(h('div', 'xc-amount-big', fromBase(subDigits(owed, got), fdec) + ' ' + fsym));
      } else if (sw.state === 'incomplete_deposit') {
        // Part arrived but the amount is not reported (or does not add up): no figure at all
        // rather than the FULL amount again (round 13, second pass: that one was paid twice).
        left.appendChild(h('div', 'k', 'Part of your deposit arrived, but the amount received is not reported yet. Do not send more until it shows here — check your wallet or the deposit transaction.'));
      } else {
        left.appendChild(h('div', 'k', 'Send exactly'));
        left.appendChild(h('div', 'xc-amount-big', fromBase(sw.amountIn, fdec) + ' ' + fsym));
      }
      left.appendChild(h('div', 'k', 'on the ' + chainLabel(sw.fromChain) + ' network, to:'));
      var addr = h('code', 'xc-addr', sw.depositAddress);
      left.appendChild(addr);
      var copy = h('button', 'xc-btn ghost', 'Copy address'); copy.type = 'button';
      // A failed copy must SAY so (round 13): silently, the clipboard kept whatever it held
      // before — possibly an older swap's address — and that is what got pasted.
      if (S.copyFailed === sw.id) copy.textContent = 'Copy failed — select the address above';   // survives a redraw
      function copyFailed() {
        S.copyFailed = sw.id;
        copy.textContent = 'Copy failed — select the address above';
        try { var rg = document.createRange(); rg.selectNodeContents(addr); var se = window.getSelection(); se.removeAllRanges(); se.addRange(rg); } catch (e) {}
      }
      copy.addEventListener('click', function () {
        try { navigator.clipboard.writeText(sw.depositAddress).then(function () { S.copyFailed = null; copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy address'; }, 1500); }, copyFailed); }
        catch (e) { copyFailed(); }
      });
      left.appendChild(copy);
      var wamt = sw.pay && typeof sw.pay === 'object' ? walletAmount(sw) : null;
      if (wamt) left.appendChild(walletBox(sw, wamt, fsym, fdec, terms));
      else S.walletRefill = null;
      // Time left, never a date: it ticks on this device's clock between polls.
      var tl = h('div', 'k', timeLeftText(dlMs));
      left.appendChild(tl);
      clearInterval(S.leftTimer);
      S.leftTimer = setInterval(function () { if (tl.isConnected) tl.textContent = timeLeftText(dlMs); else clearInterval(S.leftTimer); }, 15000);
      var warn = h('ul', 'xc-risk warn');
      ['Send ' + fsym + ' on ' + chainLabel(sw.fromChain) + ' only. Any other coin or network can be lost.',
       'Send the exact amount. Less is refunded by the deadline; more is swapped and the extra refunded.',
       'Use this address once. Every swap gets its own address.'].forEach(function (s) { warn.appendChild(h('li', null, s)); });
      left.appendChild(warn);
      dep.appendChild(left);
      var qr = h('div', 'xc-qr');
      try { if (typeof QRCode !== 'undefined') new QRCode(qr, { text: sw.depositAddress, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M }); } catch (e) {}
      dep.appendChild(qr);
      el.card.appendChild(dep);

      var txWrap = h('div', 'xc-tx');
      var txl = h('label', 'k', 'Already sent? Paste your transaction hash to speed things up (optional).'); txl.htmlFor = 'xc-txhash';
      txWrap.appendChild(txl);
      var tx = h('input'); tx.id = 'xc-txhash'; tx.type = 'text'; tx.autocomplete = 'off'; tx.spellcheck = false; tx.setAttribute('autocapitalize', 'none'); tx.setAttribute('autocorrect', 'off'); tx.placeholder = 'transaction hash';
      // A half-typed hash survives the card being redrawn by a poll (round 13, second pass).
      if (S.txDraft && S.txDraft.id === sw.id) tx.value = S.txDraft.v;
      tx.addEventListener('input', function () { S.txDraft = { id: sw.id, v: tx.value }; });
      var txb = h('button', 'xc-btn ghost', 'Submit'); txb.type = 'button';
      txb.addEventListener('click', function () {
        txb.disabled = true;
        submitHash(sw.id, cleanAddr(tx.value), terms, function () { txb.disabled = false; });
      });
      var row2 = h('div', 'xc-txrow'); row2.appendChild(tx); row2.appendChild(txb); txWrap.appendChild(row2);
      el.card.appendChild(txWrap);
    }

    var facts = h('div', 'xc-terms');
    row(facts, 'Swap', fromBase(sw.amountIn, fdec) + ' ' + fsym + ' (' + chainLabel(sw.fromChain) + ') → ' + tsym + ' (' + chainLabel(sw.toChain) + ')');
    row(facts, 'Quoted', fromBase(sw.amountOut, tdec) + ' ' + tsym + ' · minimum ' + fromBase(sw.minAmountOut, tdec));
    if (sw.amountOutActual) row(facts, 'Delivered', fromBase(sw.amountOutActual, tdec) + ' ' + tsym, 'big');
    if (sw.refunded && sw.refunded !== '0') row(facts, 'Refunded', fromBase(sw.refunded, fdec) + ' ' + fsym);
    row(facts, 'To', sw.recipient);
    row(facts, 'Refunds to', sw.refundTo);
    el.card.appendChild(facts);

    var links = h('div', 'xc-links');
    // Links are built HERE from the chain and a hash of the right shape, never taken
    // from the router's explorerUrl (round 13: any https host passed, so a wrong or
    // compromised feed could put a phishing link on the trusted card).
    // Arrays only (round 15: any other JSON value threw here, mid-render, and stopped polling).
    (Array.isArray(sw.originTxs) ? sw.originTxs : []).forEach(function (t) { txLink(links, 'Deposit tx ', sw.fromChain, t); });
    (Array.isArray(sw.destTxs) ? sw.destTxs : []).forEach(function (t) { txLink(links, 'Payout tx ', sw.toChain, t); });
    var exp = h('a', null, 'NEAR Intents explorer'); exp.href = 'https://explorer.near-intents.org/'; exp.target = '_blank'; exp.rel = 'noopener noreferrer nofollow';
    links.appendChild(exp);
    el.card.appendChild(links);

    if (sw.state === 'settled') el.card.appendChild(proofBox(sw));

    var act = h('div', 'xc-actions');
    function receiptText() {
      // The access key is NOT in the receipt: a receipt gets shared (support, disputes), the key should not.
      // Nor is any date or this device's clock: fields starting with "_" are this page's own.
      var rec = {}; Object.keys(sw).forEach(function (k) { if (k.charAt(0) !== '_') rec[k] = sw[k]; });
      return JSON.stringify({ desk: 'CryptoLwa cross-chain desk (NEAR Intents 1Click)', support: SUPPORT, swap: rec }, null, 2);
    }
    var rec = h('button', 'xc-btn ghost', 'Download receipt'); rec.type = 'button';
    rec.addEventListener('click', function () {
      var blob = new Blob([receiptText()], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'swap-receipt-' + sw.id + '.json';
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    });
    act.appendChild(rec);
    // In-app browsers (Telegram / Instagram / X — WebKit on iOS, Chromium on Android)
    // often block downloads; the receipt is dispute evidence, so it can also be copied.
    var cp = h('button', 'xc-btn ghost', 'Copy receipt'); cp.type = 'button';
    cp.addEventListener('click', function () {
      try { navigator.clipboard.writeText(receiptText()).then(function () { cp.textContent = 'Receipt copied'; setTimeout(function () { cp.textContent = 'Copy receipt'; }, 1800); }, function () { cp.textContent = 'Copy failed — use Download'; }); }
      catch (e) { cp.textContent = 'Copy failed — use Download'; }
    });
    act.appendChild(cp);
    var nw = h('button', 'xc-btn', 'New swap'); nw.type = 'button'; nw.addEventListener('click', closeSwap);
    act.appendChild(nw);
    el.card.appendChild(act);
  }

  // ── pay from a connected wallet (EVM) ─────────────────────────────────
  // The wallet is asked for ONE thing: a plain transfer of the amount this card shows, to the
  // address this card shows, on the swap's chain. It is built here from the server's `pay`
  // facts (frozen when the swap was issued), never from the live token list. Never an approval,
  // a signature, or any other contract call. The wallet talks to its own node, so this page
  // still talks only to the desk. Wallets are found by EIP-6963, with window.ethereum as a
  // fallback; their names go in as text.
  var WALLETS = [];
  window.addEventListener('eip6963:announceProvider', function (e) {
    var d = e && e.detail;
    if (!d || !d.provider || typeof d.provider.request !== 'function' || !d.info) return;
    var uuid = String(d.info.uuid || ''), name = String(d.info.name || 'Wallet').slice(0, 40);
    for (var i = 0; i < WALLETS.length; i++) if (WALLETS[i].uuid === uuid || WALLETS[i].provider === d.provider) return;
    WALLETS.push({ uuid: uuid, name: name, provider: d.provider });
    if (S.walletRefill) S.walletRefill();
    renderConnect();
  });
  try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (e) {}
  function walletList() {
    var a = WALLETS.slice(0, 4);
    var inj = window.ethereum;
    if (!a.length && inj && typeof inj.request === 'function') a.push({ uuid: 'injected', name: 'your browser wallet', provider: inj });
    // The wallet connected on the form goes first on the deposit card.
    if (CONN) a.sort(function (x, y) { return (y.provider === CONN.w.provider) - (x.provider === CONN.w.provider); });
    return a;
  }

  // ── connect a wallet on the form (EVM) ────────────────────────────────
  // Asks the wallet for ONE thing: which address it is (eth_requestAccounts). No signature, no
  // approval, no transaction; the one transfer is still asked for on the deposit card. Kept in
  // this page's memory only: addresses are never stored (red-team round 2). The connected address
  // fills the REFUND field only, only when that field is empty and the sending chain is EVM. The
  // receiving field is filled only by an explicit press: a multisig / smart wallet can have a
  // different address (or none) on another chain. A wallet that switches account afterwards
  // changes the label, never a field the member may already have checked.
  var CONN = null, CONNECTING = false, CONN_MSG = null;
  function shortAddr(a) { return a.slice(0, 6) + '…' + a.slice(-4); }
  function fromIsEvm() { return !!EVM[el.fromChain.value]; }
  function toIsEvm() { return !!EVM[el.toChain.value]; }
  function sameAddr(a, b) { return String(a || '').toLowerCase() === String(b || '').toLowerCase(); }
  // Never while a deposit request is in flight or in doubt: the form must keep showing what was sent.
  function formFree() { return !(S.issuing || S.pending || el.form.hidden); }
  function fillRefundFromWallet() {
    if (!CONN || !fromIsEvm() || el.refund.value || !formFree()) return false;
    el.refund.value = CONN.addr; return true;
  }
  function useAddr(input) { if (!CONN || !formFree()) return; input.value = CONN.addr; schedulePreview(); renderConnect(); }
  function onAccounts(w) {
    return function (accts) {
      if (!CONN || CONN.w.provider !== w.provider) return;
      var a = Array.isArray(accts) ? accts[0] : null;
      if (typeof a !== 'string' || !EVM_ADDR.test(a)) { CONN = null; CONN_MSG = { text: 'Your wallet disconnected. The addresses below were not changed.', cls: 'err' }; }
      else if (!sameAddr(a, CONN.addr)) { CONN.addr = a; CONN_MSG = { text: 'Your wallet switched to ' + shortAddr(a) + '. The addresses below were not changed: check them.', cls: 'err' }; }
      renderConnect();
    };
  }
  function connectWallet(w) {
    if (CONNECTING || CONN) return;
    CONNECTING = true; CONN_MSG = { text: 'Open your wallet to share your address.', cls: '' }; renderConnect();
    walletReq(w.provider, 'eth_requestAccounts').then(function (accts) {
      var a = Array.isArray(accts) ? accts[0] : null;
      CONNECTING = false;
      if (typeof a !== 'string' || !EVM_ADDR.test(a)) { CONN_MSG = { text: 'Your wallet did not share an address. Nothing was changed.', cls: 'err' }; renderConnect(); return; }
      CONN = { w: w, addr: a }; CONN_MSG = null;
      try { if (typeof w.provider.on === 'function') { CONN.listener = onAccounts(w); w.provider.on('accountsChanged', CONN.listener); } } catch (e) {}
      if (fillRefundFromWallet()) schedulePreview();
      renderConnect(); if (S.walletRefill) S.walletRefill();
    }, function (e) {
      CONNECTING = false;
      var code = errCode(e);
      CONN_MSG = { text: code === 4001 ? 'You cancelled in your wallet. Nothing was shared.' : code === -32002 ? 'Your wallet already has a request open. Finish or close it in the wallet first.' : 'Your wallet could not connect. You can still paste your addresses below.', cls: 'err' };
      renderConnect();
    });
  }
  function disconnectWallet() {
    if (CONN && CONN.listener) try { if (typeof CONN.w.provider.removeListener === 'function') CONN.w.provider.removeListener('accountsChanged', CONN.listener); } catch (e) {}
    CONN = null; CONN_MSG = { text: 'Forgotten by this page. The addresses below were not changed.', cls: '' };
    renderConnect(); if (S.walletRefill) S.walletRefill();
  }
  function renderConnect() {
    var box = $('xc-connect');
    if (!box || !S.chains.length) return;      // drawn once the token list is in (boot)
    clear(box);
    var locked = !formFree();
    var acts = h('div', 'xc-actions');
    function btn(text, cls, fn) { var b = h('button', cls, text); b.type = 'button'; b.disabled = locked; b.addEventListener('click', fn); acts.appendChild(b); return b; }
    if (CONN) {
      box.appendChild(h('p', 'k', 'Connected: ' + CONN.w.name + ' · ' + shortAddr(CONN.addr) + '. This page sees your address only. Your wallet is asked for one transfer, on the deposit card, and nothing else.'));
      if (fromIsEvm() && !sameAddr(el.refund.value, CONN.addr))
        btn('Refund to ' + shortAddr(CONN.addr), 'xc-btn ghost', function () { useAddr(el.refund); });
      if (toIsEvm() && !sameAddr(el.recipient.value, CONN.addr))
        btn('Receive to ' + shortAddr(CONN.addr), 'xc-btn ghost', function () { useAddr(el.recipient); });
      btn('Disconnect', 'xc-btn ghost', disconnectWallet);
      if (toIsEvm() && !sameAddr(el.recipient.value, CONN.addr))
        box.appendChild(h('p', 'k', 'Receive to the same address only if it is a normal wallet: a multisig or smart wallet may not exist on ' + chainLabel(el.toChain.value) + '.'));
      if (!fromIsEvm()) box.appendChild(h('p', 'k', 'You send on ' + chainLabel(el.fromChain.value) + ', which this wallet does not pay from: paste your refund address there.'));
    } else {
      var ws = walletList();
      if (ws.length) {
        ws.forEach(function (w) { var b = btn(CONNECTING ? 'Waiting for your wallet…' : 'Connect ' + w.name, 'xc-btn', function () { connectWallet(w); }); if (CONNECTING) b.disabled = true; });
        box.appendChild(h('p', 'k', 'Optional. Shares your address only: no signature, no approval. Or paste your addresses below.'));
      } else box.appendChild(h('p', 'k', 'No browser wallet found. Paste your addresses below, or open this page in your wallet app’s browser to connect it.'));
    }
    if (acts.childNodes.length) box.insertBefore(acts, box.firstChild);
    if (CONN_MSG) box.appendChild(h('p', 'xc-msg ' + (CONN_MSG.cls || ''), CONN_MSG.text));
  }
  var EVM_ADDR = /^0x[0-9a-fA-F]{40}$/, EVM_TX = /^0x[0-9a-fA-F]{64}$/;
  // Digit string → 0x hex, no BigInt (iOS before 14 has none).
  function decToHex(s) {
    s = digits(s); if (s === null) return null;
    var hex = '';
    while (s !== '0') {
      var q = '', rem = 0;
      for (var i = 0; i < s.length; i++) { var cur = rem * 10 + (s.charCodeAt(i) - 48), d = Math.floor(cur / 16); rem = cur % 16; if (q || d) q += d; }
      hex = '0123456789abcdef'.charAt(rem) + hex; s = q || '0';
    }
    return '0x' + (hex || '0');
  }
  function word(hex) { hex = hex.replace(/^0x/, '').toLowerCase(); while (hex.length < 64) hex = '0' + hex; return hex; }
  function chainIdOf(x) {
    if (typeof x === 'number' && isFinite(x) && x > 0) return '0x' + x.toString(16);
    if (typeof x === 'string' && /^[1-9]\d{0,15}$/.test(x)) return '0x' + Number(x).toString(16);   // a few wallets answer in decimal
    return typeof x === 'string' && /^0x[0-9a-fA-F]+$/.test(x) ? '0x' + x.slice(2).toLowerCase().replace(/^0+(?=[0-9a-f])/, '') : null;
  }
  // What the wallet may send now, as a digit string: the full amount while nothing has arrived,
  // or exactly the rest of a part payment whose received amount is known. Anything else: none.
  function walletAmount(sw) {
    var owed = digits(sw.amountIn), got = digits(sw.deposited);
    if (!owed || owed === '0') return null;
    if (sw.state === 'awaiting_deposit') return (got && got !== '0') || (Array.isArray(sw.originTxs) && sw.originTxs.length) ? null : owed;
    if (sw.state === 'incomplete_deposit' && got && got !== '0' && cmpDigits(got, owed) < 0) return subDigits(owed, got);
    return null;
  }
  // What this browser knows about paying swaps from a wallet: a list of { id, amt, hash, req }.
  // `hash` is the transfer's hash, or 'pending' (with the asking request's own `req`) from the
  // moment the wallet is asked to send until that request ends; a reload, another tab, or an
  // error mid-send then sees "check your wallet", never "Pay". One entry per swap AND amount, so
  // paying the rest of a part payment never erases the record of the first payment. No date is
  // kept. Storage and memory are both read and a real hash wins: a browser that will not store
  // still remembers for the page's life, and another tab's record is seen.
  var SENT = 'desk.walletSent', SENT_MEM = [];
  function sentRecs() { try { var a = JSON.parse(store(SENT) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function sentRec(id, amt) {
    var best = null, all = sentRecs().concat(SENT_MEM);
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      if (!r || r.id !== id || r.amt !== amt || !(r.hash === 'pending' || EVM_TX.test(r.hash))) continue;
      if (!best || (best.hash === 'pending' && r.hash !== 'pending')) best = r;
    }
    return best;
  }
  // Rewrites both lists: drop what `gone` matches, then add `add` (if any) at the front.
  function editSent(gone, add) {
    function keep(x) { return x && !gone(x); }
    SENT_MEM = SENT_MEM.filter(keep); if (add) SENT_MEM.unshift(add);
    try { var a = sentRecs().filter(keep); if (add) a.unshift(add); localStorage.setItem(SENT, JSON.stringify(a.slice(0, 60))); } catch (e) {}
  }
  function markPending(id, amt, req) { editSent(function () { return false; }, { id: id, amt: amt, hash: 'pending', req: req }); }
  function markSent(id, amt, hash, req) {
    editSent(function (x) { return x.id === id && x.amt === amt && x.hash === 'pending' && x.req === req; }, { id: id, amt: amt, hash: hash });
  }
  // Only 'pending' marks are ever cleared, never a real hash: a request clears its OWN mark
  // (`req`); "My wallet shows nothing sent" (req null) clears every pending mark for that amount.
  function clearPendingPay(id, amt, req) {
    editSent(function (x) { return x.id === id && x.amt === amt && x.hash === 'pending' && (req === null || x.req === req); }, null);
  }
  window.addEventListener('storage', function (e) { if (e.key === SENT && S.walletRefill) S.walletRefill(); });
  var PAYING = {};          // swap id → the open wallet request's own token, on this page
  function walletReq(p, method, params) {
    try { return Promise.resolve(p.request(params ? { method: method, params: params } : { method: method })); }
    catch (e) { return Promise.reject(e); }
  }
  // Wallets wrap errors differently (MetaMask mobile: { code: -32603, data: { originalError: { code: 4001 } } }).
  function errCode(e) {
    var cs = [e && e.code, e && e.data && e.data.code, e && e.data && e.data.originalError && e.data.originalError.code];
    for (var i = 0; i < 3; i++) if (cs[i] === 4001 || cs[i] === 4902 || cs[i] === -32002) return cs[i];
    return e && e.code;
  }
  function walletErr(e, chain, asked) {
    var code = errCode(e);
    if (code === 4001) return 'You cancelled in your wallet. Nothing was sent.';
    if (code === 4902) return 'Your wallet does not have the ' + chain + ' network set up. Add it in your wallet, then try again.';
    if (code === -32002) return 'Your wallet already has a request open. Finish or close it in the wallet first.';
    if (e && e.own) return e.message;            // this page stopped it, before anything was sent
    var m = e && typeof e.message === 'string' ? e.message.slice(0, 160) : '';
    return asked
      ? 'Your wallet reported a problem' + (m ? ': ' + m : '') + '. Check its activity before doing anything else: if it shows this transfer, do NOT send again.'
      : 'Your wallet reported a problem' + (m ? ': ' + m : '') + '. Nothing was sent.';
  }
  // The wallet box on a live deposit card. `amt` is walletAmount(sw); the caller has already
  // checked that the address is shown (alive, fresh, not abandoned).
  function walletBox(sw, amt, fsym, fdec, terms) {
    var box = h('div', 'xc-wallet'), id = sw.id, chain = chainLabel(sw.fromChain);
    function msg() { if (S.walletMsg && S.walletMsg.id === id) box.appendChild(h('p', 'xc-msg ' + (S.walletMsg.cls || ''), S.walletMsg.text)); }
    function fill() {
      clear(box);
      var rec = sentRec(id, amt), busy = !!PAYING[id];
      if (rec && rec.hash !== 'pending') {
        box.appendChild(h('p', 'xc-state settled', 'Sent from your wallet. Do NOT send again: it is picked up automatically, usually within a few minutes. (A multi-signature wallet sends it only once its owners approve it there.)'));
        var l = h('div', 'xc-links'); txLink(l, 'Your transfer ', sw.fromChain, { hash: rec.hash }); box.appendChild(l);
        return;
      }
      if (rec && !busy) {
        box.appendChild(h('p', 'xc-state failed', 'A payment from your wallet was started for this swap, and this browser does not know whether it was sent. Open your wallet and check its activity. If it shows this transfer, pending or done, do NOT send again: it is picked up automatically.'));
        var again = h('button', 'xc-btn ghost', 'My wallet shows nothing sent: pay again'); again.type = 'button';
        again.addEventListener('click', function () { clearPendingPay(id, amt, null); S.walletMsg = null; fill(); });
        var a1 = h('div', 'xc-actions'); a1.appendChild(again); box.appendChild(a1);
        msg();
        return;
      }
      var ws = walletList();
      if (!ws.length) {
        box.appendChild(h('p', 'k', 'Have MetaMask, Rabby, Coinbase Wallet or another EVM wallet? Open this page in its browser (or with its extension) to pay with one tap. Or send to the address above from any wallet.'));
        return;
      }
      box.appendChild(h('p', 'k', 'Or pay from a connected wallet. It will ask you to send exactly ' + fromBase(amt, fdec) + ' ' + fsym + ' on ' + chain + ' to ' + sw.depositAddress
        + '. Check both in the wallet, and approve it now: never after the time left runs out. This desk never asks your wallet for an approval or a signature.'));
      var btns = h('div', 'xc-actions');
      ws.forEach(function (w) {
        var b = h('button', 'xc-btn', busy ? 'Waiting for your wallet…' : 'Pay with ' + w.name); b.type = 'button';
        b.disabled = busy;
        b.addEventListener('click', function () { payFromWallet(w, sw, amt, terms); });
        btns.appendChild(b);
      });
      if (busy) {
        var stop = h('button', 'xc-btn ghost', 'Stop waiting'); stop.type = 'button';
        stop.addEventListener('click', function () { PAYING[id] = null; S.walletMsg = { id: id, text: 'Stopped waiting. If your wallet still sends it, this page records it.', cls: 'err' }; fill(); });
        btns.appendChild(stop);
      }
      box.appendChild(btns);
      msg();
    }
    S.walletRefill = function () { if (S.swap && S.swap.id === id && box.isConnected) fill(); };
    fill();
    return box;
  }
  function payFromWallet(w, sw, amt, terms) {
    var id = sw.id;
    if (PAYING[id] || sentRec(id, amt)) return;
    var pay = sw.pay, p = w.provider, chain = chainLabel(sw.fromChain), asked = false;
    var hex = decToHex(amt);
    if (!pay || !EVM_ADDR.test(sw.depositAddress) || !hex || hex === '0x0' || (pay.token && !EVM_ADDR.test(pay.token))) return;
    var tx = pay.token
      ? { to: pay.token, value: '0x0', data: '0xa9059cbb' + word(sw.depositAddress) + word(hex) }
      : { to: sw.depositAddress, value: hex };
    // This request's own token: "Stop waiting" and a new tap get a new one, and a pending mark
    // carries it, so a stopped request can never clear or overwrite a newer request's mark.
    var mine = uuid();
    PAYING[id] = mine;
    function still() { return PAYING[id] === mine; }
    function release() { if (still()) PAYING[id] = null; }
    function show(text, cls) { S.walletMsg = { id: id, text: text, cls: cls }; if (S.walletRefill) S.walletRefill(); }
    // Ends this request: released FIRST, so the box is redrawn without it; only the request still
    // current may speak (a stopped one's late answer must not talk over a newer request).
    function finish(text, cls) { var cur = still(); release(); if (cur && text) S.walletMsg = { id: id, text: text, cls: cls }; if (S.walletRefill) S.walletRefill(); }
    function stop(message) { throw { own: true, message: message }; }
    var from = null;
    show('Open your wallet to continue.', '');
    walletReq(p, 'eth_requestAccounts').then(function (accts) {
      if (!still()) return null;
      from = Array.isArray(accts) ? accts[0] : null;
      if (typeof from !== 'string' || !EVM_ADDR.test(from)) stop('Your wallet did not share an account. Nothing was sent.');
      return walletReq(p, 'eth_chainId').then(function (c) {
        if (chainIdOf(c) === pay.chainId || !still()) return c;
        return walletReq(p, 'wallet_switchEthereumChain', [{ chainId: pay.chainId }]).then(function () { return walletReq(p, 'eth_chainId'); });
      }).then(function (c) {
        if (!still()) return null;
        // A wallet that "switched" but is still elsewhere would send on the wrong chain.
        if (chainIdOf(c) !== pay.chainId) stop('Your wallet is still not on ' + chain + '. Switch it to ' + chain + ' and try again. Nothing was sent.');
        // The swap on screen must still be this one, its status fresh, unpaid from here.
        var cur = S.swap;
        if (!cur || cur.id !== id || S.freshId !== id || walletAmount(cur) !== amt || sentRec(id, amt) || isAbandoned(id))
          stop('This swap changed, so nothing was sent.');
        // …and the DESK, asked now (not up to 10 s ago, and not whenever a poll last got through),
        // must say the same: waiting for exactly this amount, at this address, paid this way, with
        // time left to approve in the wallet (a request cannot be withdrawn once asked).
        return api('/api/swap?id=' + encodeURIComponent(id), undefined, tokenFor(id));
      });
    }).then(function (j) {
      if (j === null || !still()) return null;
      var f = j && j.ok && j.swap;
      var cur = S.swap;
      if (!f || f.id !== id || !cur || cur.id !== id || f.rev < cur.rev || f.depositAddress !== sw.depositAddress
          || !f.pay || f.pay.chainId !== pay.chainId || (f.pay.token || null) !== (pay.token || null)
          || walletAmount(f) !== amt || !(typeof f.secondsLeft === 'number' && f.secondsLeft > 300) || sentRec(id, amt) || isAbandoned(id))
        stop(f && f.id === id && !(f.secondsLeft > 300) && walletAmount(f) === amt
          ? 'Less than 5 minutes are left on this address, so nothing was sent. Start a new swap.'
          : j && j.ok ? 'This swap changed, so nothing was sent.' : 'Could not confirm this swap with the desk just now, so nothing was sent. Try again in a moment.');
      tx.from = from; tx.chainId = pay.chainId;     // the wallet refuses if it has moved to another chain since
      asked = true;
      markPending(id, amt, mine);                   // before asking: a reload or another tab must not offer "Pay"
      return walletReq(p, 'eth_sendTransaction', [tx]);
    }).then(function (hash) {
      if (!asked) { if (still()) finish('Nothing was sent.', 'err'); return; }
      // Recorded against ITS swap whatever is on screen now: the key to that swap is by id.
      if (typeof hash !== 'string' || !EVM_TX.test(hash)) { finish('Your wallet answered without a transaction hash. Check its activity before doing anything else: if it shows this transfer, do NOT send again.', 'err'); return; }
      markSent(id, amt, hash, mine);
      if (still()) S.walletMsg = null;
      finish(null);
      submitHash(id, hash, terms);
    }, function (e) {
      // Refused at the send prompt: certainly not sent, so this request's OWN mark goes. Any other
      // failure after asking keeps it ("check your wallet").
      if (asked && errCode(e) === 4001) clearPendingPay(id, amt, mine);
      finish(walletErr(e, chain, asked), 'err');
    });
  }
  // Tells the desk the hash (it only speeds pickup up): pasted by hand, or from the wallet.
  function submitHash(id, hash, terms, done) {
    var epoch = S.pollEpoch;
    return api('/api/submit', { id: id, txHash: hash }, tokenFor(id)).then(function (j) {
      if (done) done();
      if (epoch !== S.pollEpoch) return;     // answered after a resume / another card (round 17)
      // Only onto the card it was sent from (round 13: a late answer re-drew swap A
      // over swap B, or over the form after "New swap").
      if (!S.swap || S.swap.id !== id) return;
      if (j.swap && j.swap.id === id && !(j.swap.rev < S.swap.rev)) { S.swap = land(j.swap); S.freshId = id; renderSwap(j.swap, terms); }
      if (!j.ok) say(j.message || 'Could not submit that hash.', 'err');
    });
  }

  // ── proof of delivery (round 27) ──────────────────────────────────────
  // A settled swap's signed statement of what the desk checked. Fetched with the swap's key, kept in
  // memory for the page's life (the same swap always gives the same proof), checked against the
  // desk's key on request. Its explorer link is built here, like every other link on the card.
  var PROOFS = {};
  function proofBox(sw) {
    var box = h('div', 'xc-proof');
    box.appendChild(h('div', 'k', 'Proof of delivery'));
    var body = h('div'), btns = h('div', 'xc-actions');
    box.appendChild(body); box.appendChild(btns);
    function show(p) {
      clear(body); clear(btns);
      var f = null; try { f = JSON.parse(p.payload); } catch (e) {}
      if (!f || f.swap !== sw.id) { body.appendChild(h('p', 'xc-state failed', 'The proof did not match this swap. Keep your receipt and email ' + SUPPORT + '.')); return; }
      body.appendChild(h('p', 'xc-state settled', f.checkText || ''));
      body.appendChild(h('div', 'k', 'Signed by this desk (Ed25519, key ' + p.kid + '). The signature says the desk stated this; the explorer shows it happened.'));
      var links = h('div', 'xc-links');
      if (f.payout && f.payout.tx) txLink(links, 'Payout ', sw.toChain, { hash: f.payout.tx });
      body.appendChild(links);
      var dl = h('button', 'xc-btn ghost', 'Download proof'); dl.type = 'button';
      dl.addEventListener('click', function () {
        var text = JSON.stringify({ proof: p, check: location.origin + '/api/proof/verify', key: location.origin + '/api/proof/key' }, null, 2);
        var blob = new Blob([text], { type: 'application/json' });
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'proof-of-delivery-' + sw.id + '.json';
        document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      });
      btns.appendChild(dl);
      var cp = h('button', 'xc-btn ghost', 'Copy proof'); cp.type = 'button';
      cp.addEventListener('click', function () {
        try { navigator.clipboard.writeText(JSON.stringify({ proof: p })).then(function () { cp.textContent = 'Proof copied'; }, function () { cp.textContent = 'Copy failed — use Download'; }); }
        catch (e) { cp.textContent = 'Copy failed — use Download'; }
      });
      btns.appendChild(cp);
      var ck = h('button', 'xc-btn ghost', 'Check signature'), res = h('span', 'k'); ck.type = 'button';
      ck.addEventListener('click', function () {
        ck.disabled = true; res.textContent = 'Checking…';
        api('/api/proof/verify', { proof: p }).then(function (j) {
          ck.disabled = false;
          res.textContent = j.ok && j.valid === true ? 'Signature valid — this desk signed exactly this.' : j.ok ? 'Signature NOT valid.' : (j.message || 'Could not check it now.');
        });
      });
      btns.appendChild(ck); btns.appendChild(res);
    }
    if (PROOFS[sw.id]) { show(PROOFS[sw.id]); return box; }
    var get = h('button', 'xc-btn ghost', 'Get proof of delivery'); get.type = 'button';
    get.addEventListener('click', function () {
      get.disabled = true; get.textContent = 'Getting the proof…';
      var epoch = S.pollEpoch;
      api('/api/proof?id=' + encodeURIComponent(sw.id), undefined, tokenFor(sw.id)).then(function (j) {
        if (epoch !== S.pollEpoch || !S.swap || S.swap.id !== sw.id) return;     // another card by now
        if (j.ok && j.proof && typeof j.proof.payload === 'string') { PROOFS[sw.id] = j.proof; show(j.proof); return; }
        get.disabled = false; get.textContent = 'Get proof of delivery';
        say(j.message || 'Could not get the proof now. Try again in a minute.', 'err');
      });
    });
    btns.appendChild(get);
    return box;
  }

  var EXPLORER = {
    eth: 'https://etherscan.io/tx/', base: 'https://basescan.org/tx/', arb: 'https://arbiscan.io/tx/', op: 'https://optimistic.etherscan.io/tx/',
    bsc: 'https://bscscan.com/tx/', pol: 'https://polygonscan.com/tx/', avax: 'https://snowtrace.io/tx/', gnosis: 'https://gnosisscan.io/tx/',
    btc: 'https://mempool.space/tx/', ltc: 'https://blockchair.com/litecoin/transaction/', doge: 'https://blockchair.com/dogecoin/transaction/',
    tron: 'https://tronscan.org/#/transaction/', sol: 'https://solscan.io/tx/', near: 'https://nearblocks.io/txns/'
  };
  var EVM = { eth: 1, base: 1, arb: 1, op: 1, bsc: 1, pol: 1, avax: 1, gnosis: 1 };
  function txHashOk(chain, hash) {
    if (EVM[chain]) return /^0x[0-9a-fA-F]{64}$/.test(hash);
    if (chain === 'btc' || chain === 'ltc' || chain === 'doge' || chain === 'tron') return /^[0-9a-fA-F]{64}$/.test(hash);
    if (chain === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(hash);
    if (chain === 'near') return /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash);
    return false;
  }
  function txLink(box, label, chain, t) {
    var hash = t && typeof t.hash === 'string' ? t.hash : '';
    if (!hash) return;
    if (EXPLORER[chain] && txHashOk(chain, hash)) {
      var a = h('a', null, label + hash.slice(0, 10) + '…');
      a.href = EXPLORER[chain] + hash; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
      box.appendChild(a);
    } else box.appendChild(h('span', 'k', label + hash.slice(0, 24)));   // shown, not linked
  }

  // Everything renderSwap draws from: a change in ANY of it redraws the card (round 13:
  // only state changes did, so a second partial deposit left "send the remaining" stale).
  function cardSig(sw) {
    return JSON.stringify([sw.state, sw.destVerified, sw.deposited, sw._dl, sw.depositAddress, sw.amountOutActual, sw.refunded,
      sw.refundReason, sw.originTxs, sw.destTxs]);
  }
  var FINAL = { settled: 1, refunded: 1, failed: 1 };
  function poll(now) {
    clearTimeout(S.pollTimer);
    if (!S.swap) return;
    var wait = FINAL[S.swap.state] ? 0 : S.swap.state === 'expired' ? 60000 : 10000;
    if (!wait) return;
    S.pollTimer = setTimeout(function () {
      if (document.visibilityState !== 'visible') { poll(); return; }
      var id = S.swap.id, epoch = S.pollEpoch;
      api('/api/swap?id=' + encodeURIComponent(id), undefined, tokenFor(id)).then(function (j) {
        // Sent before the page moved on (resume, another card, closed): dropped; the newer
        // epoch has its own poll (round 16: a request queued in a frozen tab answered after
        // resume and put back hours-old "Send exactly …" data).
        if (epoch !== S.pollEpoch) return;
        // Key missing or rejected: say so, keep the card, keep trying (red-team round 4: it went silent).
        // Only about the swap still on screen (round 13, second pass).
        if (j._status === 404 && S.swap && S.swap.id === id) say('This browser no longer holds the key for this swap, so it cannot be tracked here. Your swap continues either way — keep your receipt.', 'err');
        // Never an answer older than what is already on screen (answers out of order).
        if (j.ok && j.swap && S.swap && j.swap.id === S.swap.id && !(j.swap.rev < S.swap.rev)) {
          land(j.swap);
          var changed = cardSig(j.swap) !== cardSig(S.swap), moved = j.swap.state !== S.swap.state;
          var wasFresh = S.freshId === j.swap.id;
          S.swap = j.swap; S.freshId = j.swap.id;
          if (changed || !wasFresh) renderSwap(j.swap); if (moved) loadHistory();
        }
        poll();
      });
    }, now ? 0 : wait);
  }
  // Back on screen (tab switch, phone unlocked, back/forward cache): the card is refreshed
  // at once, not up to a poll interval later (round 13, second pass). A request that was
  // in flight when the page was frozen has no answer coming: its outcome is unknown.
  function resumed(e) {
    if (document.visibilityState !== 'visible') return;
    // pageshow also fires on an ordinary load, after the fonts: nothing slept then. A swap
    // answer that landed first was hidden again behind "Checking the latest status…".
    if (e && e.type === 'pageshow' && !e.persisted) return;
    if (e && e.persisted && S.issuing) {
      S.pendingBody = S.inFlightBody; S.issuing = false; S.pending = true; if (S.pendingBody) savePending(S.pendingBody); el.go.disabled = false; showAbandon(true);
      say('We could not confirm whether a deposit address was issued' + pendingWhat() + '. Press the button again: it returns the same swap, never a second one. (Reloading the page checks it again.)', 'err');
    }
    // What is on screen may be hours old: hide the address until a fresh status lands.
    if (S.swap) { S.pollEpoch = (S.pollEpoch || 0) + 1; S.freshId = null; renderSwap(S.swap); poll(true); }
  }
  document.addEventListener('visibilitychange', function () { resumed(null); });
  window.addEventListener('pageshow', resumed);
  // Another tab added a swap: show it here too.
  window.addEventListener('storage', function (e) { if (e.key === KEYS && !S.issuing) loadHistory(); });

  // ── history ───────────────────────────────────────────────────────────
  var SHORT = { awaiting_deposit: 'waiting', deposit_seen: 'deposit seen', incomplete_deposit: 'partial deposit', processing: 'swapping',
                delivered_claimed: 'confirming', settled: 'done', refunded: 'refunded', failed: 'failed', expired: 'expired' };
  function loadHistory() {
    var items = myKeys();
    if (!items.length) { clear(el.history); el.history.appendChild(h('li', 'muted', 'No swaps on this device yet.')); return; }
    var seq = S.histSeq = (S.histSeq || 0) + 1;
    api('/api/swaps', { items: items }).then(function (j) {
      if (seq !== S.histSeq) return;     // a newer load is on its way (round 20: an older answer drew a list without the newest swap)
      clear(el.history);
      if (!j.ok) { el.history.appendChild(h('li', 'muted', 'Could not load your swaps.')); return; }
      if (!j.swaps.length) { el.history.appendChild(h('li', 'muted', 'No swaps on this device yet.')); return; }
      j.swaps.forEach(function (sw) {
        var ft = tok(sw.fromAsset), tt = tok(sw.toAsset);
        var li = h('li');
        var b = h('button', 'xc-hist', ''); b.type = 'button';
        b.appendChild(h('span', 'what', (Number.isInteger(sw.fromDecimals) ? fromBase(sw.amountIn, sw.fromDecimals) : '?') + ' ' + (sw.fromSymbol || '?') + ' → ' + (sw.toSymbol || '?') + ' · ' + chainLabel(sw.fromChain) + ' → ' + chainLabel(sw.toChain)));
        b.appendChild(h('span', 'st ' + sw.state, isAbandoned(sw.id) && sw.state === 'awaiting_deposit' ? 'abandoned' : (SHORT[sw.state] || sw.state)));
        b.addEventListener('click', function () {
          // Not while a request is in flight or in doubt: opening a card dropped the pending
          // key, and "New swap" then minted a second swap (round 13, second pass).
          if (S.issuing || S.pending) { say('Finish the request above first: press the button again, or Start over.', 'err'); return; }
          openSwap(sw); window.scrollTo({ top: root.offsetTop - 80, behavior: 'smooth' });
        });
        li.appendChild(b); el.history.appendChild(li);
      });
    });
  }

  // ── boot ──────────────────────────────────────────────────────────────
  function wire() {
    el.fromChain.addEventListener('change', function () { fillTokens(el.fromTok, el.fromChain.value, el.fromTok.selectedOptions[0] && el.fromTok.selectedOptions[0].textContent); el.refund.value = ''; syncLabels(); schedulePreview(); });
    el.toChain.addEventListener('change', function () { fillTokens(el.toTok, el.toChain.value, el.toTok.selectedOptions[0] && el.toTok.selectedOptions[0].textContent); el.recipient.value = ''; syncLabels(); schedulePreview(); });
    [el.fromTok, el.toTok, el.slip].forEach(function (i) { i.addEventListener('change', schedulePreview); });
    [el.amount, el.recipient, el.refund].forEach(function (i) { i.addEventListener('input', schedulePreview); });
    [el.ack1, el.ack2].forEach(function (i) { i.addEventListener('change', updateGo); });
    el.go.addEventListener('click', issue);
    el.refreshHist.addEventListener('click', loadHistory);
    $('xc-swap-dir').addEventListener('click', function () {
      var fc = el.fromChain.value, ft = el.fromTok.selectedOptions[0] && el.fromTok.selectedOptions[0].textContent;
      var tc = el.toChain.value, tt = el.toTok.selectedOptions[0] && el.toTok.selectedOptions[0].textContent;
      el.fromChain.value = tc; fillTokens(el.fromTok, tc, tt);
      el.toChain.value = fc; fillTokens(el.toTok, fc, ft);
      el.recipient.value = ''; el.refund.value = ''; syncLabels(); schedulePreview();
    });
    // A connected wallet refills the refund field the chain change just emptied (EVM only), and
    // its buttons follow the form. Runs after the handlers above (listeners fire in order).
    [el.fromChain, $('xc-swap-dir')].forEach(function (i) { i.addEventListener(i === el.fromChain ? 'change' : 'click', function () { if (fillRefundFromWallet()) schedulePreview(); }); });
    [el.fromChain, el.toChain].forEach(function (i) { i.addEventListener('change', renderConnect); });
    [el.recipient, el.refund].forEach(function (i) { i.addEventListener('input', renderConnect); });
    $('xc-swap-dir').addEventListener('click', renderConnect);
  }

  api('/api/tokens').then(function (j) {
    if (!j.ok) {
      el.status.textContent = 'OFFLINE';
      say(j.message || 'The desk could not reach the router right now.', 'err');
      el.form.hidden = true; return;
    }
    S.chains = j.chains; S.tokens = j.tokens; S.pausedRoutes = j.pausedRoutes || []; S.limits = j.limits; S.enabled = !!j.enabled;
    el.status.textContent = S.enabled ? 'LIVE' : 'PAUSED';
    el.status.className = 'xc-pill ' + (S.enabled ? 'green' : 'amber');
    fillChains(el.fromChain, 'base'); fillChains(el.toChain, 'sol');
    fillTokens(el.fromTok, 'base', 'USDC'); fillTokens(el.toTok, 'sol', 'SOL');
    clear(el.slip);
    [[50, '0.5%'], [100, '1% (default)'], [200, '2%'], [300, '3%']].forEach(function (s) { var o = h('option', null, s[1]); o.value = s[0]; el.slip.appendChild(o); });
    el.slip.value = '100';
    var lim = $('xc-limits');
    if (lim && S.limits) lim.textContent = 'Per swap ' + usd(S.limits.minTradeUsd) + ' – ' + usd(S.limits.maxTradeUsd) + ' · up to ' + usd(S.limits.memberDailyUsd) + ' per 24 h · '
      + usd(S.limits.minTradeUsdUtxoDest) + ' minimum into BTC / LTC / DOGE';
    if (!S.enabled) say('New cross-chain swaps are paused right now. Swaps already in progress are still tracked below.', 'err');
    wire(); syncLabels(); renderConnect();
    // A request this tab sent whose outcome was never confirmed (round 16): check it again now.
    var pend = null; try { pend = JSON.parse(sessionStorage.getItem(PENDING) || 'null'); } catch (e) {}
    if (pend && pend.body && typeof pend.idem === 'string' && pend.body.idempotencyKey === pend.idem && Date.now() - pend.at < 3600e3) {
      S.pending = true; S.idem = pend.idem; S.pendingBody = pend.body; showAbandon(true);
      el.confirm.hidden = false;
      // Say WHAT is being checked: the form is empty after a reload (round 22).
      var tk = tok(pend.body.from);
      say('This tab was reloaded while a deposit-address request was unconfirmed. Checking it again: ' + pend.body.amount + ' ' + (tk ? tk.symbol : '') + ' to ' + pend.body.recipient + '…', 'err');
      send(pend.body);
    } else { clearPending(); schedulePreview(); }
    loadHistory();
  });
})();
