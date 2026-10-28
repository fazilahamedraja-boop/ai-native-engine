/**
 * AI Game Studio — Electron main process.
 *
 * The desktop shell owns exactly one backend: it starts the existing Studio
 * server in-process on port 0 (the OS picks a free loopback port). That removes
 * the "is the server ready yet?" race and guarantees no duplicate backend when
 * the app is launched twice. `STUDIO_URL` attaches to an already running dev
 * server instead, which is useful while editing the UI.
 *
 * The renderer gets no Node access, no shell and no filesystem. Its only bridge
 * is `openExternal` for the loopback Studio/evidence URLs.
 */

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron'
import { startServer } from '../server/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEV_URL = typeof process.env.STUDIO_URL === 'string' ? process.env.STUDIO_URL.trim() : ''
const IS_DEV = Boolean(DEV_URL) || process.env.STUDIO_DEV === '1'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

let mainWindow = null
let backend = null
let baseUrl = ''
let quitReady = false
let fatalShown = false

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // A second launch focuses the existing window instead of starting a second
  // backend on a second port.
  app.quit()
} else {
  app.setAppUserModelId('studio.ai-game-studio.desktop')
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (baseUrl && BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('before-quit', handleBeforeQuit)
  app.whenReady().then(start).catch(handleFatal)
}

function appVersion() {
  // In development `app.getVersion()` reports Electron's own version because the
  // entry point is a bare script, not a packaged app. The Studio manifest is the
  // source of truth in both cases.
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
    if (typeof manifest.version === 'string' && manifest.version) return manifest.version
  } catch {
    // Fall through to whatever Electron resolved.
  }
  return app.getVersion()
}

function assertLoopbackUrl(raw) {
  const parsed = new URL(raw)
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`STUDIO_URL must be a loopback http URL, received ${raw}`)
  }
  return parsed
}

async function start() {
  if (DEV_URL) {
    const parsed = assertLoopbackUrl(DEV_URL)
    baseUrl = parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`
  } else {
    backend = await startServer({ port: 0 })
    baseUrl = backend.url
  }

  ipcMain.handle('studio:open-external', (_event, raw) => {
    try {
      const parsed = new URL(String(raw))
      if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) return false
      const allowed = new Set([new URL(baseUrl).origin])
      if (DEV_URL) allowed.add(assertLoopbackUrl(DEV_URL).origin)
      if (!allowed.has(parsed.origin)) return false
      shell.openExternal(parsed.href)
      return true
    } catch {
      return false
    }
  })

  installMenu()
  createWindow()
}

function installMenu() {
  if (!IS_DEV) {
    // The application UI is the menu. Keep the native frame for moving,
    // resizing, snap and Alt+F4, but no menu bar to steal vertical space.
    Menu.setApplicationMenu(null)
    return
  }
  const template = [
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open evidence dashboard',
          click: () => {
            if (baseUrl) shell.openExternal(new URL('/', baseUrl).href)
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    const bounds = parsed?.bounds
    if (
      bounds &&
      Number.isFinite(bounds.width) &&
      Number.isFinite(bounds.height) &&
      bounds.width >= 960 &&
      bounds.height >= 640
    ) {
      return bounds
    }
  } catch {
    // First run, or a hand-edited state file: use the default size.
  }
  return null
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ bounds: mainWindow.getNormalBounds(), savedAt: new Date().toISOString() }, null, 2),
      'utf8',
    )
  } catch {
    // Window placement is a convenience, never a startup requirement.
  }
}

function createWindow() {
  const saved = loadWindowState()
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1360,
    height: saved?.height ?? 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'AI Game Studio',
    backgroundColor: '#0a0c11',
    icon: path.join(HERE, 'icon.ico'),
    autoHideMenuBar: !IS_DEV,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
      additionalArguments: [
        `--studio-version=${appVersion()}`,
        `--studio-mode=${DEV_URL ? 'attached' : 'in-process'}`,
        `--studio-server=${baseUrl}`,
      ],
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.focus()
  })

  mainWindow.on('close', saveWindowState)
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Only the Studio origin may navigate the shell. Anything else is refused;
  // loopback links open in the user's default browser instead.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(baseUrl)) return
    event.preventDefault()
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) {
        shell.openExternal(url)
      }
    } catch {
      // Invalid URLs are simply ignored.
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) {
        shell.openExternal(url)
      }
    } catch {
      // Invalid URLs are denied.
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
    if (mainWindow) mainWindow.show()
    dialog.showErrorBox(
      'AI Game Studio could not load its window',
      `The Studio UI at ${validatedURL || baseUrl} failed to load.\n\n${description} (${code})`,
    )
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (fatalShown) return
    fatalShown = true
    dialog.showErrorBox(
      'AI Game Studio stopped responding',
      `The interface process exited (${details.reason}).\n\nReopen the app. Verified project files were not modified.`,
    )
    app.quit()
  })

  mainWindow.loadURL(new URL('/app', baseUrl).href)
}

async function handleBeforeQuit(event) {
  if (quitReady) return
  event.preventDefault()
  quitReady = true
  // Stop native Godot windows this server launched, then close the loopback
  // server (including open SSE connections) before the process exits.
  try {
    await backend?.studio?.operations?.stopAll()
  } catch {
    // Shutdown is best effort; no project file is touched either way.
  }
  try {
    if (backend?.server) {
      backend.server.closeAllConnections?.()
      await new Promise((resolve) => backend.server.close(() => resolve()))
    }
  } catch {
    // The process is leaving anyway.
  }
  backend = null
  app.quit()
}

function handleFatal(error) {
  if (fatalShown) {
    app.exit(1)
    return
  }
  fatalShown = true
  const message = error instanceof Error ? error.message : String(error)
  try {
    dialog.showErrorBox(
      'AI Game Studio could not start',
      `The local Studio backend or window failed to start.\n\n${message}\n\nNo project files were modified.`,
    )
  } catch {
    // A dialog can fail before the app is ready; the exit code still reports it.
  }
  app.exit(1)
}
