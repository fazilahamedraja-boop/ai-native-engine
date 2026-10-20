import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { HARNESS_ROOT, HarnessSession, runTests } from '../controller/harness.mjs'
import { injectDefect, repairDefect } from './defect.mjs'

const SOURCE = path.join(HARNESS_ROOT, 'fixtures', 'sentry')
const TARGET = path.join(HARNESS_ROOT, 'artifacts', 'repair-run', 'sentry')
const TARGET_RELATIVE = path.relative(HARNESS_ROOT, TARGET).replaceAll('\\', '/')
const EVIDENCE = path.resolve(HARNESS_ROOT, '..', '..', 'docs', 'phase8')

function cleanCopy() {
  fs.rmSync(TARGET, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(TARGET), { recursive: true })
  fs.cpSync(SOURCE, TARGET, {
    recursive: true,
    filter: (source) => !['.godot', 'artifacts'].includes(path.basename(source)),
  })
}

function runRepairTest() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', 'tests/repair.test.mjs'], {
      cwd: HARNESS_ROOT,
      env: { ...process.env, HARNESS_PROJECT: TARGET_RELATIVE },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 120000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ exitCode: code, signal, timedOut, stdout, stderr })
    })
  })
}

async function diagnose() {
  const session = new HarnessSession({ project: TARGET_RELATIVE, headless: true })
  try {
    await session.startProject()
    await session.pause()
    await session.reset()
    const moved = await session.step({ steps: 80, input: { forward: 1, strafe: 0 } })
    return {
      operation: 'diagnose_defect',
      phase: moved.final.phase,
      position: moved.final.player_position,
      expected_z: -6.0,
      seen_by: moved.final.seen_by,
      detection: moved.final.detection,
      hash: moved.final.hash,
    }
  } finally {
    await session.stopProject()
  }
}

function writeEvidence(name, text) {
  fs.mkdirSync(EVIDENCE, { recursive: true })
  fs.writeFileSync(path.join(EVIDENCE, name), text)
}

async function main() {
  cleanCopy()
  injectDefect(TARGET)
  const beforePure = await runTests({ project: TARGET_RELATIVE })
  const beforeLive = await runRepairTest()
  const before = await diagnose()

  repairDefect(TARGET)
  const afterLive = await runRepairTest()
  const after = await diagnose()
  const afterPure = await runTests({ project: TARGET_RELATIVE })

  const evidence = {
    operation: 'repair_experiment',
    ok:
      beforePure.ok === true &&
      beforeLive.exitCode !== 0 &&
      before.position?.[2] > 0 &&
      afterLive.exitCode === 0 &&
      afterPure.ok === true &&
      after.position?.[2] < -5.9,
    source: 'fixtures/sentry',
    working_copy: TARGET_RELATIVE,
    defect: {
      file: 'scripts/player.gd',
      change: 'var direction := Vector3(strafe, 0.0, -forward) -> Vector3(strafe, 0.0, forward)',
      pure_logic_suite: beforePure.ok ? 'passed before repair (defect is in live movement)' : 'failed',
    },
    before: {
      live_test_exit: beforeLive.exitCode,
      live_test_stdout: beforeLive.stdout,
      live_test_stderr: beforeLive.stderr,
      diagnosis: before,
    },
    repair: {
      action: 'restore the exact movement direction line only',
      target: 'scripts/player.gd',
    },
    after: {
      live_test_exit: afterLive.exitCode,
      live_test_stdout: afterLive.stdout,
      live_test_stderr: afterLive.stderr,
      diagnosis: after,
      pure_logic_ok: afterPure.ok,
    },
    human_intervention:
      'None required for the experiment: the script injects and repairs the exact one-line defect deterministically. The fix is limited to scripts/player.gd.',
  }

  writeEvidence('repair-evidence.json', `${JSON.stringify(evidence, null, 2)}\n`)
  writeEvidence('repair-before.txt', beforeLive.stdout + beforeLive.stderr)
  writeEvidence('repair-after.txt', afterLive.stdout + afterLive.stderr)
  process.stdout.write(`${JSON.stringify({
    ok: evidence.ok,
    before_live_exit: beforeLive.exitCode,
    before_position: before.position,
    after_live_exit: afterLive.exitCode,
    after_position: after.position,
    evidence: path.join(EVIDENCE, 'repair-evidence.json'),
  }, null, 2)}\n`)
  process.exitCode = evidence.ok ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 2
})
