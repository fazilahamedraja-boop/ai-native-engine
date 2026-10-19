/**
 * Build budget measurement.
 *
 * Contract: the budget covers every JavaScript file the browser must download
 * to run the engine, gzipped at level 9, summed over dist/assets/*.js.
 * kB means 1000 bytes. HTML and source maps are not counted.
 *
 * This is deliberately measured here rather than scraped from Vite's log, so
 * the number does not move when Vite changes how it reports sizes.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const BUDGET_BYTES = 400_000
const assets = join('dist', 'assets')

let files
try {
  files = (await readdir(assets)).filter((name) => name.endsWith('.js')).sort()
} catch {
  console.error(`no ${assets} directory — run the build first`)
  process.exit(2)
}

if (files.length === 0) {
  console.error(`no .js files in ${assets}`)
  process.exit(2)
}

let raw = 0
let gzip = 0

for (const name of files) {
  const body = await readFile(join(assets, name))
  const compressed = gzipSync(body, { level: 9 }).length
  raw += body.length
  gzip += compressed
  console.log(`${name.padEnd(28)} raw ${String(body.length).padStart(8)}  gzip ${String(compressed).padStart(7)}`)
}

const percent = ((gzip / BUDGET_BYTES) * 100).toFixed(1)
console.log('')
console.log(`files      ${files.length}`)
console.log(`raw total  ${raw} B (${(raw / 1000).toFixed(1)} kB)`)
console.log(`gzip total ${gzip} B (${(gzip / 1000).toFixed(1)} kB) of ${BUDGET_BYTES / 1000} kB budget — ${percent}%`)

if (gzip > BUDGET_BYTES) {
  console.error(`over budget by ${gzip - BUDGET_BYTES} B`)
  process.exit(1)
}
