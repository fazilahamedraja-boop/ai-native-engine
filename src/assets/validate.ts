import { artifactHash, boundsDrift, boundsOf, hasPositiveArea, isFiniteMesh, isWatertight, statsOf } from './mesh'
import type { MeshStats } from './mesh'
import type { AssetDoc, Assertion } from './schema'
import type { AssetIssue, Bounds, BuiltAsset } from './types'

/** Metres. A tenth of a millimetre is far below anything the game can show. */
export const BOUNDS_TOLERANCE = 1e-4
export const ORIGIN_TOLERANCE = 1e-4
export const SOCKET_TOLERANCE = 1e-4

export interface ValidationReport {
  ok: boolean
  assetId: string
  artifactHash: string
  errors: AssetIssue[]
  warnings: AssetIssue[]
  stats: MeshStats & { generationMs?: number }
}

function fail(message: string, expected?: unknown, measured?: unknown): AssetIssue {
  return { path: '', code: 'assert_failed', message, expected, measured }
}

function checkAssertion(
  assertion: Assertion,
  artifact: BuiltAsset,
  bounds: Bounds,
  stats: MeshStats,
): string | null {
  switch (assertion.assert) {
    case 'origin-at': {
      if (assertion.value === 'grip') {
        const grip = artifact.sockets.grip
        if (!grip) return "origin 'grip' requires a socket named 'grip'"
        const distance = Math.hypot(grip[0], grip[1], grip[2])
        return distance <= ORIGIN_TOLERANCE
          ? null
          : `socket 'grip' sits ${distance.toFixed(6)} m from the origin (tolerance ${ORIGIN_TOLERANCE})`
      }
      if (assertion.value === 'center') {
        const center = [0, 1, 2].map((axis) => (bounds.min[axis] + bounds.max[axis]) / 2)
        const distance = Math.hypot(center[0], center[1], center[2])
        return distance <= ORIGIN_TOLERANCE
          ? null
          : `bounds centre is ${distance.toFixed(6)} m from the origin (tolerance ${ORIGIN_TOLERANCE})`
      }
      return Math.abs(bounds.min[1]) <= ORIGIN_TOLERANCE
        ? null
        : `origin '${assertion.value}' requires the lowest point at y=0, found y=${bounds.min[1].toFixed(6)}`
    }
    case 'sockets-present': {
      const missing = assertion.value.filter((name) => !(name in artifact.sockets))
      if (missing.length > 0) return `missing sockets: ${missing.join(', ')}`
      const broken = assertion.value.filter((name) => artifact.sockets[name].some((v) => !Number.isFinite(v)))
      return broken.length > 0 ? `non-finite socket coordinates: ${broken.join(', ')}` : null
    }
    case 'max-extent': {
      const extent = Math.max(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      )
      return extent <= assertion.value
        ? null
        : `largest extent ${extent.toFixed(4)} m exceeds the declared maximum ${assertion.value} m`
    }
    case 'triangles-max':
      return stats.triangles <= assertion.value
        ? null
        : `artifact has ${stats.triangles} triangles, declared maximum is ${assertion.value}`
    case 'watertight':
      return isWatertight(artifact.geometry) ? null : 'mesh is not a closed manifold (unpaired edge)'
    case 'area-positive':
      return hasPositiveArea(artifact.geometry) ? null : 'mesh contains a zero-area triangle or no triangles'
  }
}

/**
 * Validates a built artifact against its manifest.
 *
 * Three checks always run and cannot be declared away: the artifact must be
 * non-empty, every coordinate must be finite, and its measured bounds must match
 * the declared contract. Everything else is an explicit promise in tests[].
 */
export function validateArtifact(doc: AssetDoc, artifact: BuiltAsset, generationMs?: number): ValidationReport {
  const errors: AssetIssue[] = []
  const warnings: AssetIssue[] = []
  const stats = statsOf(artifact.geometry)

  if (stats.vertices === 0 || stats.triangles === 0) {
    errors.push({ ...fail('artifact is empty', 'at least one triangle', stats), path: 'artifact' })
  }

  if (!isFiniteMesh(artifact.geometry)) {
    errors.push({
      ...fail('positions or normals contain non-finite values, or an index is out of range'),
      path: 'artifact.geometry',
    })
  }

  const bounds = boundsOf(artifact.geometry)
  const drift = boundsDrift(bounds, doc.contract.bounds)
  if (drift > BOUNDS_TOLERANCE) {
    errors.push({
      path: 'contract.bounds',
      code: 'assert_failed',
      message: `declared bounds differ from the artifact by ${drift.toExponential(2)} m (tolerance ${BOUNDS_TOLERANCE})`,
      expected: doc.contract.bounds,
      measured: bounds,
    })
  }

  // Declared sockets are a promise like bounds: an attachment point that moved
  // silently would invalidate every placement built on it.
  for (const [name, declared] of Object.entries(doc.contract.sockets)) {
    const measured = artifact.sockets[name]
    if (measured === undefined) {
      errors.push({
        path: `contract.sockets.${name}`,
        code: 'socket_missing',
        message: `contract declares socket '${name}' but the artifact does not provide it`,
        expected: declared,
      })
      continue
    }
    const distance = Math.hypot(measured[0] - declared[0], measured[1] - declared[1], measured[2] - declared[2])
    if (distance > SOCKET_TOLERANCE) {
      errors.push({
        path: `contract.sockets.${name}`,
        code: 'socket_mismatch',
        message: `socket '${name}' differs from the declared position by ${distance.toExponential(2)} m (tolerance ${SOCKET_TOLERANCE})`,
        expected: declared,
        measured,
      })
    }
  }

  doc.tests.forEach((assertion, index) => {
    const message = checkAssertion(assertion, artifact, bounds, stats)
    if (message !== null) {
      errors.push({ path: `tests[${index}]`, code: 'assert_failed', message, expected: assertion })
    }
  })

  // A socket outside the mesh is legal (a muzzle point, a look target) but is
  // far more often a stale coordinate, so it is surfaced rather than blocked.
  for (const [name, socket] of Object.entries(artifact.sockets)) {
    const outside =
      socket[0] < bounds.min[0] - BOUNDS_TOLERANCE ||
      socket[0] > bounds.max[0] + BOUNDS_TOLERANCE ||
      socket[1] < bounds.min[1] - BOUNDS_TOLERANCE ||
      socket[1] > bounds.max[1] + BOUNDS_TOLERANCE ||
      socket[2] < bounds.min[2] - BOUNDS_TOLERANCE ||
      socket[2] > bounds.max[2] + BOUNDS_TOLERANCE
    if (outside) {
      warnings.push({
        path: `contract.sockets.${name}`,
        code: 'socket_outside_bounds',
        message: `socket '${name}' lies outside the artifact bounds`,
        measured: socket,
        expected: bounds,
      })
    }
  }

  return {
    ok: errors.length === 0,
    assetId: doc.id,
    artifactHash: artifactHash(artifact),
    errors,
    warnings,
    stats: generationMs === undefined ? stats : { ...stats, generationMs },
  }
}
