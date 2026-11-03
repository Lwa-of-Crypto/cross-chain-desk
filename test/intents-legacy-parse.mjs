// ============================================================
// CRYPTO LWA · cross-chain desk — OLD-SAFARI PARSE GATE
// ============================================================
// Safari 11 / iOS 12 understands ES2017 and nothing newer. One newer token
// (1n, ?., ??, catch without a binding, numeric separators…) is a SyntaxError
// there, and a SyntaxError blanks the WHOLE desk, not one feature.
// esbuild --target=safari11 is NOT a gate: it only warns and silently rewrites
// `1n` to BigInt("1") (measured). acorn at ecmaVersion 2017 refuses it.
//
//   acorn 8.14.0 is a devDependency (npm install)
//   node intents-legacy-parse.mjs [file]       (default: the shipped client)
// ============================================================
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parse } from 'acorn'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const file = process.argv[2] || path.join(HERE, '..', 'public', 'desk.js')
const src = fs.readFileSync(file, 'utf8')

// The gate must refuse what it claims to refuse, or a pass means nothing.
let selfOk = true
for (const bad of ['var a = 1n;', 'var a = b?.c;', 'var a = b ?? c;', 'try {} catch {}', 'var a = 1_000;', 'var a = {...b};'])
  try { parse(bad, { ecmaVersion: 2017 }); console.log('GATE BROKEN: accepted ' + bad); selfOk = false } catch {}
if (!selfOk) process.exit(2)

try {
  parse(src, { ecmaVersion: 2017, sourceType: 'script' })
  console.log('parses as ES2017 (Safari 11 / iOS 12): ' + path.basename(file))
} catch (e) {
  console.log('SYNTAX NEWER THAN ES2017 in ' + path.basename(file) + ': ' + e.message)
  console.log('  ' + (src.split('\n')[e.loc.line - 1] || '').trim().slice(0, 160))
  process.exit(1)
}
