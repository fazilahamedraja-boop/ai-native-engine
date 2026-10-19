import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * Accepts POSTed PNGs and writes them into .cache/captures/.
 *
 * This is the agent's eye: without a file on disk the agent can open, a
 * screenshot is just a string it cannot inspect. Keeping the sink inside the
 * dev server means no extra process and no extra dependency.
 */
function captureSink(): Plugin {
  return {
    name: 'capture-sink',
    configureServer(server) {
      server.middlewares.use('/__capture', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }

        const url = new URL(req.url ?? '/', 'http://localhost')
        const rawName = url.searchParams.get('name') ?? 'capture'
        const name = rawName.replace(/[^\w.-]+/g, '_')

        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const body = Buffer.concat(chunks)
        if (body.length === 0) {
          res.statusCode = 400
          res.end('empty body')
          return
        }

        const dir = resolve(process.cwd(), '.cache', 'captures')
        await mkdir(dir, { recursive: true })
        const file = resolve(dir, `${name}.png`)
        await writeFile(file, body)

        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, path: file, bytes: body.length }))
      })
    },
  }
}

export default defineConfig({
  plugins: [captureSink()],
  server: { port: 5173, strictPort: true },
})
