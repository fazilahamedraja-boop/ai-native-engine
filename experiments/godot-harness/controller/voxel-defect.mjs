#!/usr/bin/env node
/**
 * Phase 19 controlled-defect repair experiment.
 *
 * This is a trusted-runner script. It never edits the canonical worktree.
 *
 *   healthy source  ->  disposable copy  ->  injected defect
 *                   ->  hidden suite (must fail)  ->  external agent attempt
 *                   ->  hidden suite on the agent's candidate
 *                   ->  trusted reference repair (if the agent did not fix it)
 *                   ->  hidden suite (must pass)
 *
 * Every stage writes its own evidence, so a failed agent attempt is preserved
 * next to the passing result instead of being overwritten.
 *
 * Usage:
 *   node controller/voxel-defect.mjs [--out-dir DIR] [--model MODEL]
 *                                    [--timeout-ms N] [--skip-agent]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HARNESS_ROOT, runTests } from './harness.mjs'
import {
  SANDBOX_CONFIG_SOURCE,
  copyDir,
  nowStamp,
  resolveOpencodeBin,
  runOpencode,
} from './agent-adapter.mjs'
import { DOCS_ROOT, rejectReason, sha256, writeJsonFile } from './evidence-output.mjs'

const SOURCE = path.join(HARNESS_ROOT, 'voxel')
const DATA_REL = 'scripts/voxel_data.gd'
const HIDDEN_TEST_REL = 'tests/run_voxel_data_tests.gd'
const HIDDEN_TEST = path.join(SOURCE, HIDDEN_TEST_REL)
const PHASE19_DIR = path.join(DOCS_ROOT, 'phase19')
const DEFAULT_OUT = path.join(PHASE19_DIR, 'evidence', 'repair')
const DEFAULT_MODEL = 'opencode/deepseek-v4.1-flash-free'
const SKIP = ['.godot', 'build', 'tests', 'artifacts']

const DEFECT_BEFORE = `					"block": [cell.x, cell.y, cell.z],
					"previous": [previous.x, previous.y, previous.z],`

const DEFECT_AFTER = `					"block": [cell.x, cell.y, cell.z],
					"previous": [cell.x, cell.y, cell.z],`

// The canonical files use CRLF on this checkout, so match the unique single
// line instead of a multi-line literal. The origin-inside early return already
// reports `cell`, so this `previous` line appears exactly once.
const DEFECT_PATTERN = /"previous": \[previous\.x, previous\.y, previous\.z\]/
const DEFECT_REPLACEMENT = '"previous": [cell.x, cell.y, cell.z]'

const TASK = `# Repair task: voxel block targeting

The project in \`./project\` is a small Godot voxel sandbox. Its pure data module
is \`project/scripts/voxel_data.gd\`.

## Observed problem

Placing a block overwrites the block the crosshair is pointing at, instead of
placing into the empty cell on the face that was hit. Mining and targeting still
work, but every placement destroys a block it should have built against.

## Required behaviour

- A raycast must report the empty cell immediately before the hit block, i.e.
  the cell the ray occupied on the previous step, together with the face
  normal of the hit.
- For a downward ray that hits a block from above, the reported previous cell
  must be directly above the hit block.
- The reported hit block, distance, id, and miss behaviour must stay correct.
- Keep the existing public API, block ids, save format, world generation, and
  spawn helpers unchanged.

## Scope

Edit only \`project/scripts/voxel_data.gd\`. Do not edit tests, project
settings, scenes, or any other file. Describe the change in
\`project/IMPLEMENTATION.md\`.
`

function parseArgs(argv) {
  const options = {
    outDir: null,
    model: process.env.PHASE19_AGENT_MODEL || DEFAULT_MODEL,
    timeoutMs: 600000,
    skipAgent: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out-dir') options.outDir = argv[++i]
    else if (arg === '--model') options.model = argv[++i]
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else if (arg === '--skip-agent') options.skipAgent = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10000) {
    throw new Error('--timeout-ms must be at least 10000')
  }
  return options
}

function assertInsidePhase19(target) {
  const resolved = path.resolve(target)
  const relative = path.relative(PHASE19_DIR, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Phase 19 evidence must stay inside ${PHASE19_DIR}`)
  }
  const reason = rejectReason(resolved)
  if (reason) throw new Error(reason)
  fs.mkdirSync(resolved, { recursive: true })
  return resolved
}

function saveSuite(dir, name, result) {
  const record = {
    ok: result.ok,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    summary: result.summary,
    reason: result.reason,
    results: result.results,
    errors: result.errors,
    warnings: result.warnings,
  }
  writeJsonFile(dir, `${name}.json`, record)
  fs.writeFileSync(path.join(dir, `${name}.stdout.txt`), result.stdout || '', 'utf8')
  fs.writeFileSync(path.join(dir, `${name}.stderr.txt`), result.stderr || '', 'utf8')
  return record
}

function failedCheckNames(record) {
  return (record.results || []).filter((entry) => !entry.passed).map((entry) => entry.name)
}

function failureText(record) {
  const lines = []
  for (const entry of (record.results || []).filter((item) => !item.passed)) {
    lines.push(`FAIL ${entry.name}: ${entry.detail}`)
  }
  for (const error of record.errors || []) lines.push(`ERROR: ${error}`)
  if (record.reason) lines.push(`reason: ${record.reason}`)
  return lines.join('\n')
}

/** Copy the disposable project and swap in one script, then run the hidden suite. */
async function verifyCandidate(candidateSource, scratchDir) {
  const projectDir = path.join(scratchDir, 'project')
  copyDir(SOURCE, projectDir, { skip: SKIP })
  fs.copyFileSync(candidateSource, path.join(projectDir, DATA_REL))
  fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true })
  fs.copyFileSync(HIDDEN_TEST, path.join(projectDir, HIDDEN_TEST_REL))
  return runTests({
    project: projectDir,
    script: `res://${HIDDEN_TEST_REL}`,
    timeoutMs: 120000,
    allowOutsideRoot: true,
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(HIDDEN_TEST)) throw new Error(`missing hidden test: ${HIDDEN_TEST}`)
  const healthySource = path.join(SOURCE, DATA_REL)
  const healthySha = sha256(healthySource)

  const outDir = assertInsidePhase19(
    path.join(options.outDir || DEFAULT_OUT, nowStamp()),
  )
  const healthyDir = path.join(outDir, 'healthy')
  const defectDir = path.join(outDir, 'defect')
  const defectSuiteDir = path.join(outDir, 'defect-suite')
  const trustedDir = path.join(outDir, 'trusted-repair')
  for (const dir of [healthyDir, defectDir, defectSuiteDir, trustedDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.copyFileSync(healthySource, path.join(healthyDir, 'voxel_data.gd'))
  const healthyText = fs.readFileSync(healthySource, 'utf8')
  if (!DEFECT_PATTERN.test(healthyText)) {
    throw new Error('healthy raycast return did not match the expected source; refusing to inject')
  }
  const defectiveText = healthyText.replace(DEFECT_PATTERN, DEFECT_REPLACEMENT)
  if (defectiveText === healthyText || defectiveText.includes(DEFECT_BEFORE)) {
    throw new Error('defect injection did not change the target line')
  }
  const defectiveSource = path.join(defectDir, 'voxel_data.gd')
  fs.writeFileSync(defectiveSource, defectiveText, 'utf8')
  fs.writeFileSync(
    path.join(defectDir, 'DEFECT.md'),
    [
      '# Injected controlled defect',
      '',
      'One-line change in `scripts/voxel_data.gd`: the raycast hit reply reports',
      'the hit cell as the previous cell, so placement targets the block itself',
      'instead of the empty cell against the hit face.',
      '',
      '## Before (healthy)',
      '',
      '```gdscript',
      DEFECT_BEFORE,
      '```',
      '',
      '## After (defective)',
      '',
      '```gdscript',
      DEFECT_AFTER,
      '```',
      '',
    ].join('\n'),
    'utf8',
  )

  const manifest = {
    schema: 'phase19.voxel-defect-repair.v1',
    run_id: path.basename(outDir),
    exported_at: new Date().toISOString(),
    model: options.model,
    opencode_bin: resolveOpencodeBin(),
    source_project: SOURCE,
    hidden_test: HIDDEN_TEST_REL,
    hidden_test_sha256: sha256(HIDDEN_TEST),
    healthy_data_sha256: healthySha,
    defect_data_sha256: sha256(defectiveSource),
    ordering: [
      'healthy-copy',
      'defect-injection',
      'hidden-suite-fails',
      'external-agent-attempt',
      'hidden-suite-on-candidate',
      'trusted-repair',
      'hidden-suite-passes',
    ],
    actors: {
      agent: [
        'read ./TASK.md',
        'edit ./project/scripts/voxel_data.gd',
        'write ./project/IMPLEMENTATION.md',
      ],
      trusted_runner: [
        'copy+inject the defect',
        'run the hidden suite',
        'launch and time-box OpenCode',
        'verify the candidate in a separate copy',
        'apply the trusted repair and re-verify',
        'write all evidence',
      ],
    },
    stages: {},
    status: 'running',
    failure_reason: null,
  }

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase19-defect-'))
  try {
    // 1. The defect must be observable through the hidden behavioural suite.
    const defectResult = await verifyCandidate(defectiveSource, path.join(scratchRoot, 'defect'))
    const defectRecord = saveSuite(defectSuiteDir, 'hidden-suite', defectResult)
    const defectFailures = failedCheckNames(defectRecord)
    manifest.stages.defect = {
      suite_ok: defectRecord.ok,
      summary: defectRecord.summary,
      failing_checks: defectFailures,
      duration_ms: defectRecord.durationMs,
    }
    if (defectRecord.ok || defectFailures.length === 0) {
      throw new Error('the injected defect was not detected by the hidden suite')
    }
    fs.writeFileSync(
      path.join(defectSuiteDir, 'FAILURE.md'),
      `# Hidden suite on the defective copy\n\n${failureText(defectRecord)}\n`,
      'utf8',
    )

    // 2. One bounded external-agent attempt on a disposable project copy.
    const agentDir = path.join(outDir, 'agent-attempt')
    fs.mkdirSync(agentDir, { recursive: true })
    const sandboxRoot = fs.mkdtempSync(path.join(scratchRoot, 'agent-'))
    const projectDir = path.join(sandboxRoot, 'project')
    copyDir(SOURCE, projectDir, { skip: SKIP })
    fs.copyFileSync(defectiveSource, path.join(projectDir, DATA_REL))
    fs.writeFileSync(path.join(sandboxRoot, 'TASK.md'), TASK, 'utf8')
    fs.copyFileSync(path.join(sandboxRoot, 'TASK.md'), path.join(agentDir, 'TASK.md'))
    fs.writeFileSync(
      path.join(sandboxRoot, 'FAILURE.md'),
      `# Verified failure\n\n${failureText(defectRecord)}\n`,
      'utf8',
    )
    fs.copyFileSync(path.join(sandboxRoot, 'FAILURE.md'), path.join(agentDir, 'FAILURE.md'))

    const configDir = path.join(sandboxRoot, 'config')
    fs.mkdirSync(path.join(configDir, 'opencode'), { recursive: true })
    fs.copyFileSync(SANDBOX_CONFIG_SOURCE, path.join(configDir, 'opencode', 'opencode.json'))

    const beforeAgentSha = sha256(path.join(projectDir, DATA_REL))
    let agentRecord = {
      skipped: options.skipAgent,
      started_at: new Date().toISOString(),
      duration_ms: 0,
      opencode_exit_code: null,
      timed_out: false,
      changed: false,
      candidate_sha256: beforeAgentSha,
      verification_ok: false,
      failing_checks: defectFailures,
    }

    if (!options.skipAgent) {
      const startedMs = Date.now()
      const prompt = [
        'Read ./TASK.md and repair the voxel block targeting.',
        'Read ./FAILURE.md for the verified failing behaviour.',
        'Edit only ./project/scripts/voxel_data.gd and write ./project/IMPLEMENTATION.md.',
        'Do not edit tests, project settings, scenes, or any other file.',
        'Do not run shell commands; none are available.',
      ].join(' ')
      const run = await runOpencode({
        bin: resolveOpencodeBin(),
        args: [
          'run',
          '--standalone',
          '--format',
          'json',
          '--auto',
          '--model',
          options.model,
          '--title',
          'phase19 controlled-defect repair',
          prompt,
        ],
        cwd: sandboxRoot,
        env: { ...process.env, XDG_CONFIG_HOME: configDir },
        timeoutMs: options.timeoutMs,
      })
      fs.writeFileSync(path.join(agentDir, 'opencode.jsonl'), run.stdout || '', 'utf8')
      fs.writeFileSync(path.join(agentDir, 'opencode.stderr.txt'), run.stderr || '', 'utf8')

      const candidateSource = path.join(projectDir, DATA_REL)
      const candidateSha = sha256(candidateSource)
      const changed = candidateSha !== beforeAgentSha
      fs.copyFileSync(candidateSource, path.join(agentDir, 'voxel_data.gd'))
      const implementation = path.join(projectDir, 'IMPLEMENTATION.md')
      if (fs.existsSync(implementation)) {
        fs.copyFileSync(implementation, path.join(agentDir, 'IMPLEMENTATION.md'))
      }

      agentRecord = {
        skipped: false,
        started_at: new Date().toISOString(),
        duration_ms: Date.now() - startedMs,
        opencode_exit_code: run.code,
        timed_out: Boolean(run.timedOut),
        changed,
        candidate_sha256: candidateSha,
        verification_ok: false,
        failing_checks: [],
      }

      if (changed) {
        const candidateResult = await verifyCandidate(candidateSource, path.join(scratchRoot, 'candidate'))
        const candidateRecord = saveSuite(agentDir, 'hidden-suite', candidateResult)
        agentRecord.verification_ok = candidateRecord.ok
        agentRecord.failing_checks = failedCheckNames(candidateRecord)
        agentRecord.summary = candidateRecord.summary
        if (!candidateRecord.ok) {
          fs.writeFileSync(
            path.join(agentDir, 'FAILURE.md'),
            `# Agent candidate failed the hidden suite\n\n${failureText(candidateRecord)}\n`,
            'utf8',
          )
        }
      } else {
        agentRecord.note = 'the agent made no change to scripts/voxel_data.gd'
      }
    }

    manifest.stages.agent = agentRecord

    // 3. If the agent did not produce a passing module, repair with the trusted
    //    reference and prove the result. This is recorded as a trusted action,
    //    never as an agent success.
    if (agentRecord.verification_ok) {
      manifest.status = 'repaired-by-agent'
      manifest.stages.trusted = { applied: false, suite_ok: true }
    } else {
      const repairedSource = path.join(trustedDir, 'voxel_data.gd')
      fs.copyFileSync(healthySource, repairedSource)
      const repairedResult = await verifyCandidate(repairedSource, path.join(scratchRoot, 'trusted'))
      const repairedRecord = saveSuite(trustedDir, 'hidden-suite', repairedResult)
      manifest.stages.trusted = {
        applied: true,
        actor: 'trusted_runner',
        method: 'restore the reviewed reference data module from the healthy source',
        suite_ok: repairedRecord.ok,
        summary: repairedRecord.summary,
        duration_ms: repairedRecord.durationMs,
        data_sha256: sha256(repairedSource),
      }
      if (!repairedRecord.ok) {
        manifest.status = 'trusted-repair-failed'
        manifest.failure_reason = failureText(repairedRecord)
      } else {
        manifest.status = 'repaired-by-trusted-runner'
      }
    }

    // 4. The canonical worktree must still hold the healthy module untouched.
    manifest.stages.canonical = {
      healthy_sha256_before: healthySha,
      healthy_sha256_after: sha256(healthySource),
      unchanged: sha256(healthySource) === healthySha,
    }
    if (!manifest.stages.canonical.unchanged) {
      manifest.status = 'canonical-modified'
      manifest.failure_reason = 'the canonical data module changed during the experiment'
    }
  } catch (error) {
    manifest.status = 'error'
    manifest.failure_reason = error?.stack || String(error)
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true })
  }

  writeJsonFile(outDir, 'run.json', manifest)
  console.log(`status: ${manifest.status}`)
  console.log(`evidence: ${outDir}`)
  console.log(`defect failing checks: ${JSON.stringify(manifest.stages.defect?.failing_checks || [])}`)
  if (manifest.stages.agent && !manifest.stages.agent.skipped) {
    console.log(
      `agent: changed=${manifest.stages.agent.changed} exit=${manifest.stages.agent.opencode_exit_code} verified=${manifest.stages.agent.verification_ok}`,
    )
  }
  if (manifest.status !== 'repaired-by-agent' && manifest.status !== 'repaired-by-trusted-runner') {
    console.error(`experiment did not end in a verified repair: ${manifest.failure_reason}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error))
  process.exitCode = 1
})
