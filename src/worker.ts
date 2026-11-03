/**
 * worker.ts — the whole desk is one Cloudflare Worker: static page (assets),
 * JSON API, and the reconciler on a cron trigger. Nothing is shared with any
 * other site: its own D1 database, its own secrets, its own hostname.
 *
 *   GET  /api/tokens            public
 *   POST /api/quote             public, budgeted per client + desk-wide
 *   GET  /api/swap?id=          x-swap-token
 *   POST /api/swaps             {items:[{id,token}]}
 *   POST /api/submit            x-swap-token
 *   GET  /api/proof?id=         x-swap-token — signed proof of delivery (settled swaps)
 *   POST /api/proof/verify      public — checks a proof's signature
 *   GET  /api/proof/key         public — the Ed25519 proof key
 *   GET  /api/admin, POST       x-admin-token (absent ADMIN_TOKEN → 404)
 *   scheduled()                 reconcileBatch — the only public trigger; the admin API
 *                               (ADMIN_TOKEN) can also run one pass ({action:'reconcile'})
 */
import { json, reconcileBatch, type IntentsEnv } from './lib/intents-io'
import { ensureTables } from './lib/intents-ledger'
import { tokens } from './api/tokens'
import { quote } from './api/quote'
import { swapOne, swapList } from './api/swap'
import { submit } from './api/submit'
import { adminGet, adminPost } from './api/admin'
import { proofGet, proofVerify, proofKey } from './api/proof'
import type { Handler, Limiter } from './api/common'
import { deskSecret, networkBucket } from './identity'

export interface Env extends IntentsEnv { ASSETS: Fetcher; RL_API?: Limiter }

const ROUTES: Record<string, Partial<Record<'GET' | 'POST', Handler>>> = {
  '/api/tokens': { GET: tokens },
  '/api/quote': { POST: quote },
  '/api/swap': { GET: swapOne },
  '/api/swaps': { POST: swapList },
  '/api/submit': { POST: submit },
  '/api/admin': { GET: adminGet, POST: adminPost },
  '/api/proof': { GET: proofGet },
  '/api/proof/verify': { POST: proofVerify },
  '/api/proof/key': { GET: proofKey },
}

// API answers are data, never a page: nothing may render, frame or sniff them.
const API_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
}

// The page: our own script, our own styles, no third party, no inline code.
// img data: is the QR code (qrcode.min.js draws it as a data: URL).
const PAGE_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; "
    + "manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'strict-transport-security': 'max-age=31536000',
}

function withHeaders(r: Response, set: Record<string, string> = API_HEADERS): Response {
  const out = new Response(r.body, r)
  for (const [k, v] of Object.entries(set)) out.headers.set(k, v)
  return out
}

/**
 * A POST from another site's page is refused. There are no cookies to steal,
 * but another page could still make its visitors' browsers spend this desk's
 * budgets (and theirs). A request with no Origin (curl, a server) is not a
 * browser acting for someone else, so it passes to the normal budgets.
 */
function crossSite(request: Request, url: URL): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return true
  const origin = request.headers.get('origin')
  return !!origin && origin !== url.origin
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return withHeaders(await env.ASSETS.fetch(request), PAGE_HEADERS)

    const route = ROUTES[url.pathname]
    if (!route) return withHeaders(json({ ok: false, error: 'not_found' }, 404))
    const method = request.method === 'HEAD' ? 'GET' : request.method
    const handler = route[method as 'GET' | 'POST']
    if (!handler) {
      const r = json({ ok: false, error: 'method_not_allowed' }, 405)
      r.headers.set('allow', Object.keys(route).join(', '))
      return withHeaders(r)
    }
    if (method === 'POST' && crossSite(request, url)) return withHeaders(json({ ok: false, error: 'cross_site' }, 403))
    try {
      // One allowance per NETWORK for the whole API, before any handler runs (round 13):
      // /api/tokens had no budget at all, and every handler's own budget is spent only after
      // its D1 reads. Binding only: falling back to a D1 counter here would make every
      // request write a row, which is the very cost this gate exists to cap.
      const secret = deskSecret(env)
      if (secret && env.RL_API && !(await env.RL_API.limit({ key: await networkBucket(request, secret) })).success)
        return withHeaders(json({ ok: false, error: 'rate_limited', message: 'Too many requests. Wait a minute.' }, 429, { 'retry-after': '60' }))
      const r = await handler({ request, env, waitUntil: p => ctx.waitUntil(p) })
      return withHeaders(request.method === 'HEAD' ? new Response(null, r) : r)
    } catch (e) {
      // Logged for the operator (Workers logs; never the request body, headers or a token),
      // because a silent 500 hid a schema break that only a real runtime showed (round 13).
      console.error('unhandled', url.pathname, String((e as Error)?.message || e).slice(0, 300))
      // Never a stack trace or SQL error to the caller.
      // 'internal' with a 5xx is treated by the page as an UNKNOWN outcome: it keeps
      // the request key, so pressing again can only return the same swap.
      return withHeaders(json({ ok: false, error: 'internal', message: 'Something went wrong and we could not confirm the result.' }, 500))
    }
  },

  async scheduled(_evt: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.DESK_DB) return
    ctx.waitUntil(reconcileBatch(env, env.DESK_DB))     // creates / upgrades tables itself, on its counted budget
  },
}
