import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * Accepts POSTed PNGs and writes them into .cache/captures/.
 *
 * This is the agent's eye: without a file on disk the agent can open, a
 * screenshot is just a string it cannot inspect.
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

/**
 * Pushes scene text to the page instead of letting Vite reload the module.
 * A full reload would discard simulation state, which is the thing Phase 1
 * exists to preserve.
 */
function sceneWatch(): Plugin {
  return {
    name: 'scene-watch',
    configureServer(server) {
      const scenes = resolve(process.cwd(), 'content', 'scenes')
      server.watcher.add(scenes)

      const push = async (file: string): Promise<void> => {
        if (!file.replace(/\\/g, '/').includes('/content/scenes/') || !file.endsWith('.json')) return
        try {
          const text = await readFile(file, 'utf8')
          server.ws.send({ type: 'custom', event: 'scene-update', data: { file, text } })
        } catch (error) {
          server.config.logger.error(`[scene-watch] ${(error as Error).message}`)
        }
      }

      server.watcher.on('change', (file) => void push(file))
      server.watcher.on('add', (file) => void push(file))
    },
  }
}

export default defineConfig({
  plugins: [captureSink(), sceneWatch()],
  server: { port: 5173, strictPort: true },
})
