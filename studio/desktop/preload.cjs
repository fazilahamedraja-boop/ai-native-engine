/**
 * Sandboxed preload. The renderer can read a tiny, fixed description of its
 * host and ask the main process to open a loopback URL in the default browser.
 * It gets no Node APIs, no IPC channel of its own and no filesystem access.
 */
const { contextBridge, ipcRenderer } = require('electron')

function argument(name, fallback) {
  const prefix = `--${name}=`
  const found = (process.argv || []).find((value) => value.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

contextBridge.exposeInMainWorld('studioDesktop', {
  isDesktop: true,
  version: argument('studio-version', '0.1.0'),
  mode: argument('studio-mode', 'in-process'),
  platform: process.platform,
  openExternal: (url) => ipcRenderer.invoke('studio:open-external', String(url)),
})
