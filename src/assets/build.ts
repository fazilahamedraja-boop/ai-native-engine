import { createRng } from './rng'
import { getGenerator, registeredKinds } from './registry'
import { parseAsset } from './schema'
import type { AssetDoc } from './schema'
import type { AssetIssue, BuiltAsset } from './types'
import { validateArtifact } from './validate'
import type { ValidationReport } from './validate'

export interface BuildOutcome {
  ok: boolean
  doc?: AssetDoc
  artifact?: BuiltAsset
  report?: ValidationReport
  errors: AssetIssue[]
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
