import * as THREE from 'three'
import { expect, expectEqual, runSuite } from '../../devtools/node-tests'
import type { NodeTestCase } from '../../devtools/node-tests'
import type { Bounds } from '../types'
import { frameCamera } from '../../preview/preview'
import { VIEWS } from '../../preview/views'

const SWORD_BOUNDS: Bounds = { min: [-0.11, -0.1, -0.026], max: [0.11, 0.85, 0.026] }

function camera(): THREE.PerspectiveCamera {
  return new THREE.PerspectiveCamera(45, 800 / 500, 0.01, 200)
}

function corners(bounds: Bounds): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) out.push(new THREE.Vector3(x, y, z))
    }
  }
  return out
}

const cases: NodeTestCase[] = [
  {
    name: 'every view fits the asset in frame',
    run: () => {
      const checked = VIEWS.map((view) => {
        const cam = camera()
        frameCamera(SWORD_BOUNDS, view, cam)
        cam.updateMatrixWorld(true)

        let worst = 0
        for (const corner of corners(SWORD_BOUNDS)) {
          const ndc = corner.clone().project(cam)
          expect(Number.isFinite(ndc.x) && Number.isFinite(ndc.y), `${view}: projected a non-finite coordinate`)
          expect(Math.abs(ndc.x) <= 1, `${view}: corner x=${ndc.x.toFixed(3)} is outside the frame`)
          expect(Math.abs(ndc.y) <= 1, `${view}: corner y=${ndc.y.toFixed(3)} is outside the frame`)
          expect(ndc.z >= -1 && ndc.z <= 1, `${view}: corner z=${ndc.z.toFixed(3)} is outside the depth range`)
          worst = Math.max(worst, Math.abs(ndc.x), Math.abs(ndc.y))
        }
        return `${view}=${worst.toFixed(2)}`
      })
      return `worst NDC extent ${checked.join(' ')}`
    },
  },
  {
    name: 'views share one scale',
    run: () => {
      // A bounding-sphere fit is orientation independent, so all four views sit
      // at the same distance and a size change is a real size change.
      const distances = VIEWS.map((view) => frameCamera(SWORD_BOUNDS, view, camera()).distance)
      const first = distances[0]
      for (const distance of distances) expectEqual(distance, first, 'camera distance')
      return `distance=${first.toFixed(4)} for ${VIEWS.length} views`
    },
  },
  {
    name: 'taller asset pulls the camera back',
    run: () => {
      const small = frameCamera({ min: [0, 0, 0], max: [0.5, 0.5, 0.5] }, 'front', camera()).distance
      const tall = frameCamera({ min: [0, 0, 0], max: [0.5, 8, 0.5] }, 'front', camera()).distance
      expect(tall > small * 5, `expected a much larger distance for an 8 m asset, got ${small} vs ${tall}`)
      return `0.5 m -> ${small.toFixed(2)} m, 8 m -> ${tall.toFixed(2)} m`
    },
  },
]

export function suite() {
  return runSuite('asset-preview', cases)
}
