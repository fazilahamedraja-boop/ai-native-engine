// Side-effect import: registers every generator so a manifest can be built.
import './generators/index'
import { createRng } from './rng'
import { getGenerator, registeredKinds } from './registry'
import { IMPORTER_VERSION, decodeGlb } from './import/decode'
import { indexGlb, readGlbContents } from './import/glb'
import { parseAsset } from './schema'
import type { AssetDoc } from './schema'
import type { AssetIssue, BuiltAsset, MaterialPatch } from './types'
import type { MaterialSpec } from './types'
import { validateArtifact } from './validate'
import type { ValidationReport } from './validate'

export interface BuildOutcome {
  ok: boolean
  doc?: AssetDoc
  artifact?: BuiltAsset
  report?: ValidationReport
  errors: AssetIssue[]
}

/** Source bytes plus the digest the platform computed over them. */
export interface ImportedSource {
  bytes: Uint8Array
  /** Lowercase hex SHA-256. */
  sha256: string
}

/**
 * Builds and validates one parsed manifest. Never throws for authoring mistakes:
 * a missing generator or a pinned-version mismatch is a reportable issue.
 */
export function buildAsset(doc: AssetDoc): BuildOutcome {
  if (doc.provenance.type !== 'procedural') {
    return {
      ok: false,
      doc,
      errors: [
        {
          path: 'provenance.type',
          code: 'unsupported_provenance',
          message: 'imported assets are indexed, not generated; run the importer instead',
        },
      ],
    }
  }

  const generator = getGenerator(doc.kind)
  if (!generator) {
    return {
      ok: false,
      doc,
      errors: [
        {
          path: 'provenance.generator',
          code: 'unknown_generator',
          message: `no generator registered for kind '${doc.kind}'; registered: ${registeredKinds().join(', ') || 'none'}`,
        },
      ],
    }
  }

  if (generator.version !== doc.provenance.generatorVersion) {
    return {
      ok: false,
      doc,
      errors: [
        {
          path: 'provenance.generatorVersion',
          code: 'generator_version_mismatch',
          message: `generator '${doc.kind}' is version ${generator.version}, manifest pins ${doc.provenance.generatorVersion}`,
          expected: generator.version,
          measured: doc.provenance.generatorVersion,
        },
      ],
    }
  }

  const started = performance.now()
  const artifact = generator.build(doc.params, createRng(doc.provenance.seed))
  const generationMs = performance.now() - started
  const report = validateArtifact(doc, artifact, generationMs)

  return report.ok ? { ok: true, doc, artifact, report, errors: [] } : { ok: false, doc, artifact, report, errors: report.errors }
}

export function buildAssetRaw(raw: unknown): BuildOutcome {
  const parsed = parseAsset(raw)
  if (!parsed.ok) return { ok: false, errors: parsed.errors }
  return buildAsset(parsed.value)
}

/**
 * Builds an imported character from its source bytes.
 *
 * The caller supplies the SHA-256 because Node and the browser compute it with
 * different APIs; keeping the digest out of this function lets the whole import
 * path stay synchronous and platform-free. A digest mismatch is a hard failure:
 * the manifest pins the exact bytes its contract was measured from.
 */
export function buildImportedAsset(doc: AssetDoc, source: ImportedSource): BuildOutcome {
  if (doc.provenance.type !== 'imported') {
    return {
      ok: false,
      doc,
      errors: [
        {
          path: 'provenance.type',
          code: 'unsupported_provenance',
          message: 'buildImportedAsset requires imported provenance',
          measured: doc.provenance.type,
        },
      ],
    }
  }
  if (doc.kind !== 'character') {
    return {
      ok: false,
      doc,
      errors: [
        {
          path: 'kind',
          code: 'unsupported_kind',
          message: `imported assets are characters; kind is '${doc.kind}'`,
          expected: 'character',
          measured: doc.kind,
        },
      ],
    }
  }
  if (doc.provenance.importerVersion !== IMPORTER_VERSION) {
    return {
      ok: false,
      doc,
      errors: [
        {
          path: 'provenance.importerVersion',
          code: 'importer_version_mismatch',
          message: `GLB importer is version ${IMPORTER_VERSION}, manifest pins ${doc.provenance.importerVersion}`,
          expected: IMPORTER_VERSION,
          measured: doc.provenance.importerVersion,
        },
      ],
    }
  }
  if (!/^[0-9a-f]{64}$/.test(source.sha256)) {
    return {
      ok: false,
      doc,
      errors: [
        {
          path: 'provenance.sha256',
          code: 'invalid_source_hash',
          message: 'the source digest must be 64 lowercase hex characters',
          measured: source.sha256,
        },
      ],
    }
  }
  if (source.sha256 !== doc.provenance.sha256) {
    return {
      ok: false,
      doc,
      errors: [
        {
          path: 'provenance.sha256',
          code: 'source_hash_mismatch',
          message: 'source bytes do not match the hash pinned by the manifest',
          expected: doc.provenance.sha256,
          measured: source.sha256,
        },
      ],
    }
  }

  const started = performance.now()
  const contents = readGlbContents(source.bytes)
  if (!contents.ok) return { ok: false, doc, errors: contents.errors }

  const index = indexGlb(contents.value)
  if (!index.ok) return { ok: false, doc, errors: index.errors }

  const decoded = decodeGlb(contents.value, index.value)
  if (!decoded.ok) return { ok: false, doc, errors: decoded.errors }

  const generationMs = performance.now() - started
  const report = validateArtifact(doc, decoded.value.artifact, generationMs)
  report.warnings.push(...decoded.value.warnings)

  return report.ok
    ? { ok: true, doc, artifact: decoded.value.artifact, report, errors: [] }
    : { ok: false, doc, artifact: decoded.value.artifact, report, errors: report.errors }
}

/**
 * Applies an instance's appearance override. Geometry, bounds and sockets are
 * deliberately not reachable here: the contract stays with the asset.
 */
export function effectiveMaterial(asset: BuiltAsset, override?: MaterialPatch): MaterialSpec {
  const patch = override ?? {}
  return {
    color: patch.color ?? asset.material.color,
    roughness: patch.roughness ?? asset.material.roughness,
    metalness: patch.metalness ?? asset.material.metalness,
    ...(asset.material.doubleSided === true ? { doubleSided: true } : {}),
  }
}
