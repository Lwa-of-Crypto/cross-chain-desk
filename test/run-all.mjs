// Runs every Node suite (no browser, no network) and fails if any suite fails.
// Mobile suites and the client mutation campaign need `npx wrangler dev --port 8797`
// and Playwright; run them by hand (see README).
import { execFileSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNS = [
  ['intents.mjs'], ['intents-system.mjs'], ['intents-nearkeys.mjs'],
  ['intents-redteam.mjs'], ['intents-redteam2.mjs'], ['intents-redteam3.mjs'], ['intents-redteam4.mjs'], ['intents-redteam5.mjs'], ['intents-redteam6.mjs'], ['intents-redteam9.mjs'], ['intents-redteam10.mjs'], ['intents-redteam11.mjs'], ['intents-redteam12.mjs'], ['intents-redteam13.mjs'], ['intents-redteam14.mjs'], ['intents-wallet.mjs'],
  ['intents-fuzz.mjs', '20000', '23'], ['intents-fuzz-lifecycle.mjs', '600', '23'],
  ['intents-legacy-parse.mjs', path.join(HERE, '..', 'public', 'desk.js')],
]
let failed = 0
for (const [f, ...args] of RUNS) {
  const t0 = Date.now()
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, f), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 })
    const last = out.trim().split('\n').filter(l => /passed|safe,|invariants held|parses/i.test(l)).pop() || 'ok'
    console.log(`PASS  ${f.padEnd(28)} ${last.trim()}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
  } catch (e) {
    failed++
    const tail = String(e.stdout || e.message).trim().split('\n').slice(-5).join('\n      ')
    console.log(`FAIL  ${f}\n      ${tail}`)
  }
}
console.log(failed ? `\n${failed} suite(s) failed` : '\nall Node suites pass')
process.exit(failed ? 1 : 0)
