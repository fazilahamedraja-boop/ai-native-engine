import fs from 'node:fs'
import path from 'node:path'
import { HARNESS_ROOT, HarnessSession } from './harness.mjs'

const PROJECT = 'fixtures/sentry'
const EVIDENCE = path.resolve(HARNESS_ROOT, '..', '..', 'docs', 'phase8', 'stage-c-live.json')

function summary(snapshot) {
  return {
    step: snapshot.step,
    phase: snapshot.phase,
    detection: snapshot.detection,
    detection_percent: snapshot.detection_percent,
    player_position: snapshot.player_position,
    player_velocity: snapshot.player_velocity,
    grounded: snapshot.grounded,
    seen_by: snapshot.seen_by,
    exit_distance: snapshot.exit_distance,
    hash: snapshot.hash,
    hud: snapshot.hud,
  }
}

function check(name, condition, detail) {
  return { name, ok: Boolean(condition), detail }
}

async function run(session) {
  const checks = []
  const scenarios = {}

  await session.reset()
  const movement = await session.step({ steps: 80, input: { forward: 1, strafe: 0 } })
  scenarios.movement = summary(movement.final)
  checks.push(
    check(
      'movement-forward',
      movement.final.player_position[2] < -5.9 && movement.final.player_position[2] > -6.1,
      `z=${movement.final.player_position[2]}`,
    ),
  )

  await session.reset()
  const rise = await session.step({ steps: 80, input: { forward: 1, strafe: 0 } })
  const moved = await session.step({ steps: 30, input: { forward: 0, strafe: 1 } })
  const decay = await session.step({ steps: 60, input: { forward: 0, strafe: 0 } })
  scenarios.detection = {
    rise: summary(rise.final),
    outside: summary(moved.final),
    decay: summary(decay.final),
  }
  checks.push(
    check('detection-rise', rise.final.phase === 'active' && rise.final.detection > 0.6, `detection=${rise.final.detection}`),
  )
  checks.push(
    check(
      'detection-decay',
      decay.final.detection < rise.final.detection && decay.final.seen_by.length === 0,
      `rise=${rise.final.detection} decay=${decay.final.detection}`,
    ),
  )

  await session.reset()
  const right = await session.step({ steps: 100, input: { forward: 0, strafe: 1 } })
  const forward = await session.step({ steps: 240, input: { forward: 1, strafe: 0 } })
  const win = await session.step({ steps: 100, input: { forward: 0, strafe: -1 } })
  scenarios.escape = { right: summary(right.final), forward: summary(forward.final), win: summary(win.final) }
  checks.push(
    check(
      'escape-win',
      win.final.phase === 'won' && win.final.exit_distance <= 0.01,
      `phase=${win.final.phase} exit=${win.final.exit_distance}`,
    ),
  )

  await session.reset()
  const approach = await session.step({ steps: 80, input: { forward: 1, strafe: 0 } })
  const lost = await session.step({ steps: 30, input: { forward: 0, strafe: 0 } })
  scenarios.failure = { approach: summary(approach.final), lost: summary(lost.final) }
  checks.push(
    check(
      'detection-loss',
      lost.final.phase === 'lost' && lost.final.detection === 1,
      `phase=${lost.final.phase} detection=${lost.final.detection}`,
    ),
  )

  const reset = await session.reset()
  const resetSnapshot = await session.step({ steps: 0 })
  scenarios.reset = summary(resetSnapshot.final)
  checks.push(
    check(
      'reset',
      reset.snapshot.phase === 'active' &&
        reset.snapshot.detection === 0 &&
        reset.snapshot.step === 0 &&
        reset.snapshot.player_position[2] === 0,
      `phase=${reset.snapshot.phase} detection=${reset.snapshot.detection} step=${reset.snapshot.step}`,
    ),
  )

  const jump = await session.step({ steps: 1, input: { jump: true, forward: 0, strafe: 0 } })
  const air = await session.step({ steps: 20, input: { jump: false, forward: 0, strafe: 0 } })
  const land = await session.step({ steps: 80, input: { jump: false, forward: 0, strafe: 0 } })
  scenarios.jump = { takeoff: summary(jump.final), air: summary(air.final), land: summary(land.final) }
  checks.push(
    check(
      'jump-and-land',
      jump.final.grounded === false && air.final.player_position[1] > 1.0 && land.final.grounded === true,
      `takeoff_y=${jump.final.player_position[1]} air_y=${air.final.player_position[1]} land_y=${land.final.player_position[1]}`,
    ),
  )

  const repeat = async () => {
    await session.reset()
    const first = await session.step({ steps: 80, input: { forward: 1, strafe: 0 } })
    const second = await session.step({ steps: 30, input: { forward: 0, strafe: 1 } })
    const third = await session.step({ steps: 20, input: { forward: 0, strafe: 0 } })
    return { first: summary(first.final), second: summary(second.final), final: summary(third.final) }
  }
  const repeatA = await repeat()
  const repeatB = await repeat()
  scenarios.repeatability = { first: repeatA, second: repeatB }
  checks.push(
    check(
      'same-process-repeatability',
      repeatA.final.hash === repeatB.final.hash,
      `hashA=${repeatA.final.hash} hashB=${repeatB.final.hash}`,
    ),
  )

  return { checks, scenarios, repeatA, repeatB }
}

async function main() {
  const session = new HarnessSession({ project: PROJECT, headless: true })
  let result
  try {
    await session.startProject()
    await session.pause()
    result = await run(session)
  } finally {
    await session.stopProject()
  }

  const freshSession = new HarnessSession({ project: PROJECT, headless: true })
  let fresh
  try {
    await freshSession.startProject()
    await freshSession.pause()
    await freshSession.reset()
    const first = await freshSession.step({ steps: 80, input: { forward: 1, strafe: 0 } })
    const second = await freshSession.step({ steps: 30, input: { forward: 0, strafe: 1 } })
    const third = await freshSession.step({ steps: 20, input: { forward: 0, strafe: 0 } })
    fresh = { first: summary(first.final), second: summary(second.final), final: summary(third.final) }
  } finally {
    await freshSession.stopProject()
  }

  result.checks.push(
    check(
      'fresh-process-repeatability',
      fresh.final.hash === result.repeatA.final.hash,
      `sameProcess=${result.repeatA.final.hash} freshProcess=${fresh.final.hash}`,
    ),
  )
  const ok = result.checks.every((item) => item.ok)
  const evidence = {
    operation: 'live_gameplay_suite',
    ok,
    project: PROJECT,
    godot: '4.7.2-stable.official.ed1daf0bf',
    rendering: 'headless (screenshots captured separately in a windowed run)',
    hash_fields: [
      'step',
      'phase',
      'detection',
      'player position xyz',
      'player velocity xyz',
      'grounded',
      'seen guard ids',
      'exit distance',
    ],
    excluded_from_hash: ['camera transform', 'HUD text', 'port', 'PID', 'uptime', 'render frame timing'],
    physics_note:
      'The fixture uses explicit move_and_collide(Vector3 * delta) rather than CharacterBody3D.move_and_slide() for harness steps. This removes frame-derived timing from the stepped path. It does not prove that arbitrary Godot physics is deterministic.',
    checks: result.checks,
    scenarios: result.scenarios,
    fresh_process: fresh,
    generated_at: new Date().toISOString(),
  }
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true })
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ ok, evidence: EVIDENCE, checks: evidence.checks }, null, 2)}\n`)
  process.exitCode = ok ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 2
})
