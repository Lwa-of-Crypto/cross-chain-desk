# Kalfou Swap — Cross-Chain Desk

By CryptoLwa. Kalfou is the Lwa of the crossroads: a swap is where two chains meet.

A non-custodial cross-chain swap desk on **NEAR Intents (1Click)**. Swap between Bitcoin,
Solana, NEAR, Tron, Dogecoin, Litecoin and eight EVM chains from any wallet: send to a deposit
address (copy it or scan the QR code), or on an EVM chain pay from a connected browser wallet.
No token approvals, no signatures, no account.

1Click does the routing and settlement. This desk does the part a router should not be trusted
to do for you: it checks every answer, from the router, the price feeds and the chain nodes,
before it hands you a deposit address, and it checks the payout on the destination chain before
it calls a swap done.

One Cloudflare Worker: a static page, a JSON API, and a reconciler on a cron trigger. It has its
own D1 database and its own secrets, and shares nothing with any other site.

Built for the NEAR Protocol hackathon. It is served at `desk.cryptolwa.io`, a separate origin from
the rest of CryptoLwa: no shared code, database, keys, cookies or member accounts, and not behind
the CryptoLwa membership paywall. Free, no account.

## The problem it solves

A cross-chain swap through a router asks you to trust three things you cannot see: that the
deposit address belongs to the swap you asked for, that the price is fair, and that "delivered"
means the money really arrived. If the router, a price feed or a node is wrong (or lies), you find
out after your money is gone. This desk checks all three itself, refuses to hand out an address
when something does not add up, and only calls a swap done when the payout is visible on the
destination chain. It then gives you a signed proof of delivery anyone can check.

A payout to a NEAR account has one more risk: if a phishing page got you to add an attacker's
full-access key, the attacker controls the account and anything paid into it. Before you accept a
payout to NEAR, the desk shows who can sign for that account (its full-access keys, read from NEAR)
so you can check nobody else controls it.

## What NEAR does here

- **Settlement runs through NEAR Intents.** The desk asks the 1Click API for a quote and a deposit
  address; NEAR Intents' solvers fill the swap and pay out on the destination chain. The desk never
  holds funds and has no keys that can move them.
- **NEAR payouts are verified on NEAR itself.** For a payout to NEAR the desk reads the final
  transaction from NEAR RPC and requires a successful receipt from `intents.near` that pays the
  recipient at least the guaranteed amount (details below).
- **NEAR accounts are checked before an address is issued**: a receiving account that does not
  exist on NEAR (`view_account`) is refused.
- **Key checker: who controls the NEAR account you are paid to.** Every preview of a payout to NEAR
  lists the account's full-access keys (`view_access_key_list`, from two NEAR RPC operators that must
  agree) and counts its function-call (app) keys. More than one full-access key, an account with no
  keys (only its contract can act), more than 100 keys, or a check that could not be made is a
  warning on the quote. Whenever keys are listed, the "my own wallet" box also says every listed
  key is yours. It warns, never refuses: only you know which keys are yours. Read-only: the desk holds no NEAR key.

## Try it

Hosted demo: https://desk.cryptolwa.io (steps 2–4 work there as written in a browser; step 5 moves
real money). The cryptolwa.io zone challenges clients that do not look like a browser, so scripted
checks (curl, test suites) belong on the local run below.

Locally (Node 22+, which wrangler requires; the desk talks to the live 1Click API, live price feeds and live public nodes):

1. `npm install`, then create `.dev.vars` with a secret (the same command works in bash and PowerShell):
   `node -e "require('fs').writeFileSync('.dev.vars','DESK_SECRET='+require('crypto').randomBytes(32).toString('hex')+'\n')"`
   On Windows, keep the folder's own path under about 130 characters: wrangler's local database
   file sits about 125 characters below it, and a path over 260 characters makes every request
   fail with "internal" (measured).
2. `npx wrangler dev` and open the address it prints. **See:** the swap form. With MetaMask, Rabby
   or another EVM wallet in the browser, **Connect &lt;wallet&gt;** fills your refund address.
3. Pick "from" and "to" coins and type an amount. **See:** a live price preview, with the
   guaranteed minimum and the cost measured against CoinGecko. Nothing is stored and no address
   exists yet (a `dry` quote).
   Now pick **NEAR** as "to" and paste a NEAR account (for example `nearhackathon.near`). **See:**
   "Who controls nearhackathon.near" with its full-access key read from NEAR mainnet, and the
   "my own wallet" box now asks you to confirm every listed key is yours.
4. Paste a receiving address and a refund address, tick both acknowledgements, press
   **Get my deposit address**. **See:** a deposit address, a QR code, the exact amount to send and
   the time left. Try a wrong address first (a typo, a burn address, a token contract): **see** it
   refused before any address is issued.
5. Sending money is the only step that moves funds, and it is real mainnet money (NEAR Intents has
   no testnet). With a small amount: send exactly the amount shown, or on an EVM chain press
   **Pay with &lt;your wallet&gt;**. **See:** the card move through "Deposit seen", "Swapping",
   "Delivered — confirming on-chain" and "Done".
6. On a settled swap press **Get proof of delivery**, then **Check signature**. **See:** what was
   checked, the payout transaction with an explorer link, and a valid signature.

Without sending money, `npm test` runs every Node suite (see "Test it" below).

## How this was built

- **Built at NEAR HACKATHON.** Work on this desk began after the hackathon announcement. It was
  first built inside the cryptolwa.io codebase (also after the announcement) and then moved into
  this standalone Worker.
- **Written with AI:** the code, tests and this README were written with Claude Code (Anthropic),
  directed by the owner.
- **Older and third-party pieces in this repository:**
  - `public/vendor/qrcode.min.js`: qrcodejs by davidshimjs, unmodified, MIT
    (`public/vendor/qrcode-LICENSE.txt`).
  - `public/fonts/`: Cinzel, Inter, Lora and Space Mono, SIL Open Font License (license file beside each).
  - `public/logo.svg`: the CryptoLwa logo, made earlier for cryptolwa.io. The page follows
    cryptolwa.io's colours and fonts.
  - `ctEq` in `src/identity.ts`: the same four-line constant-time string comparison is used in
    earlier cryptolwa.io code.
- **Artwork:** `public/kalfou-veve.png` and its faint copy `public/kalfou-veve-faint.png` show Kalfou's
  veve (the crossroads), a traditional sacred symbol of the Lwa: public and owned by no one, so not
  covered by this repository's license. Colored for the page.
- **License:** MIT (`LICENSE`) for this desk's own code. The files listed above keep their own licenses.
  The CryptoLwa name and logo are not licensed for reuse.
- **Build and test tools** (dev only, not shipped): wrangler, esbuild, TypeScript, acorn,
  `@cloudflare/workers-types`, Playwright (phone suites).
- **Services it calls:** NEAR Intents 1Click API, CoinGecko and DeFiLlama (prices), public chain
  nodes (publicnode, dRPC, chain RPCs, NEAR RPC).

## What it checks

| Before an address is issued | How |
|---|---|
| Your addresses are real and spendable | Checksums per chain (EIP-55, bech32/bech32m, base58check). Burn addresses, token contracts, Solana token accounts and programs, missing NEAR accounts (NEAR RPC `view_account`), and anyone-can-spend SegWit v2+ outputs are refused. |
| Who controls the NEAR account you are paid to | Its full-access keys are listed on the quote (two NEAR RPC operators must agree; a permission that is not plainly a function-call key counts as full access). More than one full-access key, no keys, more than 100 keys, or no answer is warned. |
| The router quoted what you asked | Its answer must echo assets, amount, recipient and refund address exactly, carry no deposit memo, and keep the deposit address alive at least 15 minutes. |
| The price is fair | Cost is measured against CoinGecko (DeFiLlama as fallback), never the router's own price. Too bad *or* too good is blocked. |
| The deal you accepted is the deal you get | A real quote more than 0.25% worse than the preview needs a fresh "yes". |
| One press, one swap | The request is reserved in the ledger (atomic D1 insert) before 1Click is called. Double taps, retries and dropped connections return the same swap. |

| After you pay | How |
|---|---|
| "Delivered" is checked, not believed | Tokens: the `Transfer` log of the exact contract (or Solana mint) recorded when the address was issued, to the recipient, for at least the guaranteed amount. Native coins: a direct transfer of at least that amount to the recipient (a balance rise in the block is never enough to settle — see below). Bitcoin: the outputs, 2 blocks deep. EVM payouts must be buried `CONFIRMATIONS` blocks deep; Solana is read at `finalized`. A tx the recipient sent or signed itself, or (Bitcoin) funded, proves nothing. The payout must be newer than the swap (clock tolerance: 2 min, 2 h on Bitcoin) and can settle one swap only; a payout split across up to 3 txs is summed. Anything else stays unproven. On EVM chains and Solana, a token whose payout the desk could not check is never offered. |
| NEAR payouts are checked too | The NEAR transaction must be `FINAL`, contain a **successful** receipt from `intents.near` to the exact token contract frozen at issue whose NEP-141 `ft_transfer` event pays the recipient at least the guarantee (wNEAR: a native `Transfer` receipt from `intents.near`), and the `dip4` withdraw event must show the money came from an intents balance that is **not** the recipient's own. A solver batches many payouts into one NEAR tx, so on NEAR one **receipt** (not one tx) settles one swap. |
| You get a proof | A settled swap has a **signed proof of delivery** (Ed25519): what was checked, for whom, at least how much, and the payout tx (and NEAR receipt), with an explorer link. Anyone can check the signature (`POST /api/proof/verify`, or offline with the key from `GET /api/proof/key`); the explorer shows it happened without trusting the desk at all. |
| Contradictions stop the desk | A status that goes backwards, a feed naming another recipient, an under-delivery or a reused payout pauses the route. Critical swaps from three different client networks in 24 h pause the desk (one client's own swaps can pause only their routes). |
| A balance rise never settles a swap | Measured on real payouts: 1Click's bridge pays native ETH on Ethereum/Base/Arbitrum as a **direct** transfer, so for those a tx that does not pay the recipient directly is not a payout (alarm). For other native coins (BNB, POL, AVAX, OP-ETH via the HOT bridge — not measured) a rise in the payout block shows money arrived but cannot be tied to *this* payout, so such a swap is **"unproven"** the operator confirms it (admin `resolve`), it is never auto-settled and never pauses the route. |
| What it cannot prove, it says | (Older text, still true for "unproven") A native EVM payout made through a contract can only be judged by the recipient's balance in that block. If the receiving address's own code passes the coins on (a contract, or an EIP-7702 smart wallet), the rise is hidden: the swap is **"unproven"** — never called settled, flagged for the operator, and the member is told so — but it does not pause the route, because a recipient could trigger that at will. Only an address that **has code at the payout block** (read with the balances, in one batched request) can be "unproven"; a plain wallet with no rise is an alarm. Once unproven it stays so (a node later forgetting the block does not turn it into an alarm), and an old tx is still "stale". |

Payouts on Tron, Dogecoin and Litecoin are not yet checked on-chain. They settle on 1Click's word
only when it is self-consistent, and the page says so on the quote (before paying), on the settled
swap and in its proof ("reported", not "on-chain").

What the checks cannot rule out: a payout tx 1Click names that is really someone ELSE's transfer
to the recipient (not the recipient's own) of at least the guaranteed amount, mined after the swap.
The desk does not know the solver's address, so it cannot tell that apart from a real payout.

## No accounts: how access works

- **Budgets** are per client (an HMAC of the caller's IP from `CF-Connecting-IP`; IPv6 grouped by its
  /64) and per network (IPv6 /48, IPv4 /24), because one free IPv6 tunnel hands out 65,536 /64s.
  Every per-minute budget (client, network and desk-wide) uses Cloudflare's rate-limiting binding,
  which stores nothing. It counts per Cloudflare location, so a "desk-wide" minute budget is per
  location too. The daily caps (per client, per network, per route, desk-wide) are checked
  atomically in D1 when an address is issued. No IP address is stored.
- **Nothing that fails validation spends a shared budget.** Junk requests are refused before any
  client, network or desk-wide counter (only the caller's own network allowance for the API is
  spent), so they cannot lock other users out.
- **A swap is opened by its token**: `HMAC(DESK_SECRET, swap id)`, returned once when the swap is issued
  and kept in the browser. It is sent in a header, never in a URL, and never stored server-side.
  Rotating `DESK_SECRET` revokes every token.
- **Route and desk-wide 24 h caps count money actually deposited**: a swap being swapped or later
  counts its full quoted USD; a deposit still arriving counts its deposited share; refunded swaps
  count nothing. Counting unpaid addresses, or a dust deposit as its full
  quote, would let a few IPs freeze the desk for everyone. Per-client and per-network daily caps
  count every address issued (40 per client, 300 and $50,000 per network).
- **The caps are checked when an address is issued, not when it is paid.** 1Click keeps an address
  payable for days after the desk's own deadline, so the caps bound what a client or network can be
  issued per day, not exactly what flows through. The desk never holds funds either way.
- **Deposit addresses expire on the desk's deadline** (60 min; 6 h from BTC/LTC/DOGE), not the
  router's (measured: 3 days). A late deposit is still found and processed.
- **The reconciler runs from the cron trigger every minute** (the admin API can also run one pass).
  Each pass: two swaps holding someone's money, then one of the rest (a refund re-check first, then
  expired swaps and open addresses in turn), repeating; swaps 1Click calls delivered lead, at most two
  a pass, and one that has failed verification 12 times only every 30 minutes. Unpaid addresses an
  attacker can mint cannot push a paid swap, a refund re-check or a late-deposit check out of a
  pass. A delivered swap that can never be verified can be closed by the owner (admin `resolve`).
- **Data is kept only as long as it is needed.** Reservations that never showed an address are
  deleted after 1 day; unpaid addresses that expired, after 30 days. Swaps that received money are
  kept.
- **The admin API exists only if `ADMIN_TOKEN` (32+ chars) is set**, and is sent as a header.
- **Nothing the desk sends, shows or signs carries a date.** A swap carries `rev` (only ever grows, so
  the page can drop an answer older than the one on screen) and `secondsLeft` (time left to send), not
  timestamps or a deadline. 1Click's raw signed quote stays in the ledger and is not sent to the page;
  receipts and proofs carry no time.
- **Support:** support@cryptolwa.io, shown on the page and in every receipt.
- **Pay from a connected wallet (EVM only).** A swap on one of the 8 EVM chains carries `pay`
  `{ chainId, token | null }`, derived only from what was frozen at issue (`from_contract`, its own
  column) and only when the asset id, the frozen contract and the chain all agree. The page finds
  browser wallets by EIP-6963 (or `window.ethereum`), switches the wallet to `chainId`, re-reads it,
  and asks for ONE `eth_sendTransaction`: `transfer(deposit, amount)` on the token, or a plain value
  transfer for a native coin. No approval, no signature, no SDK; the wallet talks to its own node, so
  the page's CSP is unchanged. The tx hash goes to `/api/submit`. A swap paid this way is remembered on
  that device by id + hash only, and not offered again.
- **Connect a wallet on the form (EVM, optional).** A **Connect &lt;wallet&gt;** button at the top of the
  form asks the wallet for its address (`eth_requestAccounts`) and nothing else, only when pressed.
  The address fills the refund field only if it is empty and the sending chain is EVM; the receiving
  field only on a separate press, with a warning (a multisig or smart wallet may not exist on the
  other chain). A wallet that later switches account changes the label, never a field. Nothing is
  stored, and while a deposit request is in flight or in doubt the connect buttons are inert.

## Run it

```bash
npm install
# .dev.vars (never committed):  DESK_SECRET=<64 hex>   ADMIN_TOKEN=<64 hex>
npx wrangler dev
```

## Test it

```bash
npm run bundle:test
cd test
node intents.mjs                 # validators vs EIP-55 / BIP-173 / BIP-350 vectors, amounts, a real captured 1Click answer
node intents-system.mjs          # the real router + handlers on real SQLite, scripted outside world
node intents-redteam.mjs         # attacks; every case asserts the SAFE outcome (rounds 1–6: intents-redteam2…6.mjs)
node intents-fuzz.mjs 20000 23           # 7 invariants on every request
node intents-fuzz-lifecycle.mjs 600 23   # 6 invariants on every lifecycle step
node intents-redteam9.mjs        # round 13, machine level: budgets, bodies, queue, stamps, retention, upgrades
node intents-redteam12.mjs       # rounds 17–24; redteam13: rounds 25–26 (payout verification)
node intents-redteam14.mjs       # rounds 27–34: NEAR verification on real mainnet payouts, proof of delivery
node intents-wallet.mjs          # what a connected wallet may be told to pay (`pay`), and when
node intents-nearkeys.mjs        # the NEAR key checker (LIVE=1 also asks NEAR mainnet)
node intents-mutation.mjs        # switches off one guard at a time; some suite must fail
node run-all.mjs                 # every Node suite (19)
```

The phone suites need Playwright's browsers once: `npx playwright install webkit chromium`.

On the real runtime (`npx wrangler dev --port 8797 --ip 127.0.0.1`, run outside any sandbox):

```bash
node intents-redteam8-workerd.mjs   # raw TCP: paths, methods, cross-site, bytes, tokens, real D1 races, network gate
node intents-redteam15-workerd.mjs  # the proof endpoints on the real runtime
node intents-mobile.mjs             # real WebKit (iPhone 14) + Chromium (Pixel 7); also mobile2…10 (7: proof box, 8: wallet payment, 9: key checker, 10: connect wallet)
node intents-mutation-client.mjs    # page guards off one at a time, served to both engines
```

Probes (numbers, not pass/fail): `intents-probe-d1count.mjs` (D1 queries per request; Free allows 50),
`intents-probe-cpu.mjs` (CPU per request; Free allows 10 ms). Before each release, live:
`intents-probe-decimals.mjs` reads `decimals()` from every listed EVM token contract and compares it
with 1Click's list (the card's "send exactly" and a wallet payment both depend on it; exits 1 on any
mismatch).

The Node suites call the real `worker.fetch`, so the router, cross-site check and method table
are exercised too. `test/entry.ts` explains how the older members-only suites map onto the
public desk.

## Deploy

```bash
npx wrangler d1 create near-intents-desk     # paste the id into wrangler.jsonc
npx wrangler secret put DESK_SECRET          # 32+ random characters
npx wrangler secret put ADMIN_TOKEN          # optional
npx wrangler deploy
```

### After deploying

1. **Can a client choose its own IP bucket?** Measured on the hosted desk: no. A request that carries
   its own `CF-Connecting-IP` header is refused by Cloudflare's edge (HTTP 403, "error code: 1000")
   before the Worker runs. `X-Forwarded-For` passes the edge, but the desk never reads it.
2. **Did the rate-limiting bindings deploy?** Measured on the hosted desk: yes. A steady stream of
   previews from one machine got its first 429 at request 43 (limit 40/min); 64 of 1,338 passed in
   that minute. Cloudflare documents these limits as approximate, per location and eventually
   consistent, and a single fast burst does pass: 50 previews sent at once all answered 200. A burst
   costs extra previews; the daily caps on issued addresses are separate, atomic D1 checks.
3. **One small real swap per route family**, from your own wallet: the only test that moves money.
   Include one swap **to NEAR**: it is the first time a desk swap's NEAR payout hash is seen. After it
   settles, press "Get proof of delivery" and "Check signature" on the swap card.

On Workers Free a reconciler pass checks up to about 11 idle swaps, or fewer when payouts are being
verified (48 of the 50 subrequests per invocation; swaps 1Click calls delivered go first). On Workers
Paid, set `INTENTS_SUBREQ_BUDGET` (e.g. `900`) to check more per pass.

Optional: `INTENTS_API_KEY` (1Click partner key, lower fees), `INTENTS_FEE_BPS` + `INTENTS_FEE_RECIPIENT`
(our fee, off by default), `INTENTS_LIMITS` (JSON override of the launch limits), `INTENTS_ENABLED=0`
(kill switch for new quotes; swaps already issued keep being tracked).

## Measured, not assumed (live)

- 1Click needs no API key. Without one it adds a 20 bps fee (its docs say 25).
- Free public NEAR nodes treat Cloudflare Workers differently from home connections: probed from
  Cloudflare's network, `rpc.mainnet.near.org` answered 429 "deprecated" and `near.drpc.org` later
  answered 429 "too many requests", while both answered 200 from a home connection. So the key
  checker asks fastnear plus the first of several other operators that answers.
- A 1 h deadline request came back with a 3-day deposit deadline.
- 1Click quotes payouts to **shielded Zcash** unified addresses (Orchard-only and Sapling+Orchard
  test vectors from ZIP 316). Its docs say "transparent addresses only". Whether the payout really
  lands shielded is not yet verified: that needs a real swap.
- Local workerd refuses compatibility dates newer than its own build; the date in `wrangler.jsonc`
  is pinned so tests and production run the same behaviour.
- `wrangler dev`'s local proxy holds a whole request upload before the Worker sees it, so body-size
  attacks are tested directly against `worker.fetch` (redteam9 R10), not through it.
- The rate-limiting binding works in local workerd: exactly 5 of 20 concurrent calls passed a 5/min limit.
- Cloudflare limits read: Workers Free 10 ms CPU and 50 subrequests per request; D1 Free
  100,000 rows written per day (then every query fails until 00:00 UTC) and 500 MB per database.
- Free publicnode EVM nodes keep only ~127 blocks of state on Ethereum, Arbitrum, Optimism, Polygon
  and Gnosis (≈32 s on Arbitrum), so native balances are read elsewhere (`STATE_RPC`): dRPC served
  balances 100,000 blocks back on Ethereum, Optimism, Polygon and Gnosis; Arbitrum's own RPC keeps
  5,000–10,000 blocks. Every node used accepted balance reads by block **hash** (EIP-1898).
  `debug_`/`trace_` methods are not offered on the free nodes.
- NEAR payouts, read from real mainnet transactions (fixtures in `test/fixtures/near-payout-*.json`):
  signed by `intents.near`, `ft_withdraw` → `ft_transfer` on the token contract, wNEAR →
  `near_withdraw` → native `Transfer`. `EXPERIMENTAL_tx_status` returns the same tx for any
  `sender_account_id`. 1Click's status lists the swap's NEAR txs in `swapDetails.nearTxHashes`
  (OpenAPI). Not yet observed on a desk swap: which of those hashes 1Click names for a NEAR payout;
  the desk checks every one it is given (up to 5, newest first).
- NEAR access keys, read from mainnet: an account that does not exist answers an **empty** key list,
  not an error (so the desk tells it apart with `view_account`); an account with more than 100 keys
  answers `TOO_MANY_ACCESS_KEYS`; a contract-only account (e.g. `wrap.near`) has no keys. Both NEAR
  RPC operators the desk uses answer `view_access_key_list`.
- workerd derives the Ed25519 proof key and signs with it; the public key it published matched an
  independent derivation in Node byte for byte, and the derivation matches RFC 8032 test vector 1.

Not affiliated with the NEAR Foundation or the NEAR Intents team. Not financial advice.
