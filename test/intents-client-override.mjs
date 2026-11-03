// Mutation hook for the mobile suites (intents-mutation-client.mjs): when
// CLIENT_OVERRIDE_JS / _HTML / _CSS name a file, the browser context is served
// that file instead of /desk.js, the page, or /desk.css. The shipped files in
// public/ are never written. Unset = the real files, as served by wrangler dev.
import fs from 'fs'
export async function overrideClient(ctx) {
  const js = process.env.CLIENT_OVERRIDE_JS, html = process.env.CLIENT_OVERRIDE_HTML, css = process.env.CLIENT_OVERRIDE_CSS
  if (js) await ctx.route(/:8797\/desk\.js(\?.*)?$/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(js, 'utf8') }))
  if (css) await ctx.route(/:8797\/desk\.css(\?.*)?$/, r => r.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(css, 'utf8') }))
  if (html) await ctx.route(/:8797\/(index\.html)?(\?.*)?$/, r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(html, 'utf8') }))
}
