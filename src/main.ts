import { createApi, type EngineApi } from './devtools/api'
import { SceneRuntime } from './render/scene'

declare global {
  interface Window {
    __engine: EngineApi
  }
}

const container = document.getElementById('app')
if (!container) throw new Error('#app missing from index.html')

const runtime = new SceneRuntime(container)
const api = createApi(runtime)

window.__engine = api

runtime.reset()
runtime.render()

console.info('[engine] phase 0 ready — window.__engine is the agent surface')
