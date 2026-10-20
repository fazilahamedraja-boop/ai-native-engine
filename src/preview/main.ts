import { effectiveMaterial } from '../assets/build'
import { catalog, findAsset } from '../assets/catalog'
import { inspectAsset } from '../assets/inspect'
import type { AssetInspection } from '../assets/inspect'
import { AssetPreview, VIEWS, isViewName } from './preview'
import type { CameraFrame, ViewName } from './preview'

export interface PreviewInspection extends AssetInspection {
  view: ViewName
  camera: CameraFrame
}

export interface PreviewSurface {
  readonly asset: string
  readonly view: ViewName
  inspect(): PreviewInspection
  setView(view: string): ViewName
  capture(name: string): Promise<{ path: string; bytes: number; width: number; height: number }>
}

declare global {
  interface Window {
    __preview?: PreviewSurface
  }
}

export async function bootPreview(
  container: HTMLElement,
  errorsEl: HTMLElement,
  params: URLSearchParams,
): Promise<void> {
  const requestedId = params.get('asset') ?? ''
  const requestedView = params.get('view') ?? 'three-quarter'
  const view: ViewName = isViewName(requestedView) ? requestedView : 'three-quarter'

  const entry = await findAsset(requestedId)
  if (entry === undefined) {
    const loaded = await catalog()
    const known = loaded.entries.map((item) => `${item.doc.id} (${item.doc.kind})`)
    const broken = loaded.failures.map(
      (failure) => `${failure.file}: ${failure.errors[0]?.message ?? 'failed to load'}`,
    )
    showError(errorsEl, [
      `asset '${requestedId}' not found`,
      `available: ${known.join(', ') || 'none'}`,
      ...(broken.length === 0 ? [] : ['failed to load:', ...broken]),
    ])
    throw new Error(`asset '${requestedId}' not found`)
  }

  const outcome = entry.outcome
  const artifact = outcome.artifact
  const report = outcome.report
  if (!outcome.ok || artifact === undefined || report === undefined) {
    showError(errorsEl, [
      `asset '${entry.doc.id}' failed to build:`,
      ...outcome.errors.map((issue) => `  ${issue.path || '<root>'}: ${issue.message} [${issue.code}]`),
    ])
    throw new Error(`asset '${entry.doc.id}' failed to build`)
  }

  const infoEl = document.getElementById('info')
  const preview = new AssetPreview(container)
  preview.load({ ...artifact, material: effectiveMaterial(artifact, entry.doc.override.material) })
  preview.setView(view)
  preview.render()
  errorsEl.classList.remove('visible')
  errorsEl.textContent = ''

  const syncInfo = (): void => {
    const inspection = inspectAsset(entry.doc, outcome, entry.file)
    const triangles = inspection.artifact?.triangles ?? 0
    const hash = inspection.artifact?.hash ?? ''
    if (infoEl !== null) {
      infoEl.textContent = `${entry.doc.id} · ${entry.doc.kind} · ${preview.view} · ${triangles} tri · ${hash}`
    }
    const url = new URL(window.location.href)
    url.searchParams.set('asset', entry.doc.id)
    url.searchParams.set('view', preview.view)
    window.history.replaceState(null, '', url)
  }

  syncInfo()

  const inspect = (): PreviewInspection => ({
    ...inspectAsset(entry.doc, outcome, entry.file),
    view: preview.view,
    camera: preview.frame,
  })

  window.__preview = {
    asset: entry.doc.id,
    get view() {
      return preview.view
    },
    inspect,
    setView(next: string): ViewName {
      if (!isViewName(next)) throw new Error(`unknown view '${next}'; expected one of ${VIEWS.join(', ')}`)
      preview.setView(next)
      preview.render()
      syncInfo()
      return next
    },
    capture(name: string) {
      return preview.capture(name)
    },
  }

  console.info('[preview] ready', inspect())
}

function showError(errorsEl: HTMLElement, lines: string[]): void {
  errorsEl.classList.add('visible')
  errorsEl.textContent = lines.join('\n')
}
