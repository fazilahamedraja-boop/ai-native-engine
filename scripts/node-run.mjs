/**
 * Runs a TypeScript entry in Node with no test framework and no extra
 * dependency: Vite builds it as an SSR bundle (~100 ms), then we import it.
 *
 * The asset pipeline is pure TypeScript, so it can be validated headlessly. The
 * browser is only needed for pixels.
 */
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const entry = process.argv[2]
if (!entry) {
  console.error('usage: node scripts/node-run.mjs <entry.ts> [args...]')
  process.exit(2)
}

const outDir = '.cache/node-build'

await build({
  configFile: false,
  logLevel: 'error',
  build: { ssr: entry, outDir, emptyOutDir: true },
})

const outFile = basename(entry).replace(/\.ts$/, '.js')
const moduleUrl = pathToFileURL(resolve(outDir, outFile)).href
const mod = await import(moduleUrl)

if (typeof mod.main === 'function') {
  const result = await mod.main(process.argv.slice(3))
  if (typeof result === 'number') process.exitCode = result
}
