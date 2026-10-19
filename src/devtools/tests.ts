import type { CameraState } from '../camera/rigs'
import type { Vec3 } from '../core/math'
import { capsuleFor, capsulePenetration } from '../physics/capsule-aabb'
import { FIXED_DT, stepWorld } from '../physics/step'
import type { SceneDoc } from '../schema/scene'
import type { InputState, PlayerState, World } from '../world/world'
import { rebuildWorld, resetWorld } from '../world/world'
import { stateHash } from './state'

export interface TestResult {
  name: string
  passed: boolean
  detail: string
}

export interface TestReport {
  passed: boolean
  results: TestResult[]
  durationMs: number
  /** True when the live world was bit-identical to how runTests found it. */
  statePreserved: boolean
  hash: string
}

/**
 * Renderer-side reads. The avatar is deliberately not part of World, so its
 * linkage can only be checked from outside the simulation.
 */
export interface TestHooks {
  avatarFeet?: () => Vec3
}

const IDLE: InputState = { moveX: 0, moveZ: 0, jump: false }

function settle(world: World, steps = 120): void {
  world.input = { ...IDLE }
  for (let i = 0; i < steps; i++) stepWorld(world)
}

/** Highest collider top directly under a world-space column, or null. */
function supportTop(world: World, x: number, z: number): number | null {
  let best: number | null = null
  for (const collider of world.colliders) {
    if (x >= collider.min[0] && x <= collider.max[0] && z >= collider.min[2] && z <= collider.max[2]) {
      if (best === null || collider.max[1] > best) best = collider.max[1]
    }
  }
  return best
}

/**
 * Discrete jump numbers derived from the integration order, not measured.
 *
 *   v_n = v0 + n*g*dt
 *   height(n) = dt * sum(v_i) = dt*(n*v0 + g*dt*n(n+1)/2)
 *
 * v_n hits zero at n = v0/(-g*dt) = 18, and that step displaces the player by
 * exactly zero, so the apex is a two-step plateau (n=17 and n=18) at
 * 0.850 m. n_land solves height(n) = 0:
 *
 *   0 = n*v0 + g*dt*n(n+1)/2  ->  n = 2*v0/(-g*dt) - 1 = 35
 */
function analyticJump(jumpSpeed: number, gravity: number) {
  const zeroSpeedStep = jumpSpeed / (-gravity * FIXED_DT)
  const stepsToApex = Math.ceil(zeroSpeedStep) - 1
  const apex = FIXED_DT * (stepsToApex * jumpSpeed + gravity * FIXED_DT * ((stepsToApex * (stepsToApex + 1)) / 2))
  const airSteps = Math.round((2 * jumpSpeed) / (-gravity * FIXED_DT)) - 1
  return { stepsToApex, apex, airSteps }
}

function apexGain(world: World): { gain: number; atStep: number; landingStep: number | null; restY: number } {
  const restY = world.player.pos[1]
  const before = world.step

  world.input = { moveX: 0, moveZ: 0, jump: true }
  stepWorld(world)
  world.input.jump = false

  let gain = world.player.pos[1] - restY
  let atStep = 1
  let landingStep: number | null = null

  for (let i = 2; i <= 120; i++) {
    stepWorld(world)
    const delta = world.player.pos[1] - restY
    if (delta > gain) {
      gain = delta
      atStep = i
    }
    if (world.player.grounded && delta <= 1e-6) {
      landingStep = i
      break
    }
  }

  void before
  return { gain, atStep, landingStep, restY }
}

type Outcome = { passed: boolean; detail: string }

const pass = (detail: string): Outcome => ({ passed: true, detail })
const fail = (detail: string): Outcome => ({ passed: false, detail })

/**
 * Runs against the live World, restores everything afterwards, and reports
 * numbers rather than adjectives.
 */
export function runTests(world: World, hooks: TestHooks = {}): TestReport {
  const started = performance.now()
  const hashBefore = stateHash(world)

  const saved = {
    doc: world.doc,
    step: world.step,
    player: { pos: [...world.player.pos], vel: [...world.player.vel], grounded: world.player.grounded } as PlayerState,
    camera: JSON.parse(JSON.stringify(world.camera)) as CameraState,
    input: { ...world.input },
    prevJump: world.prevJump,
    lastReload: world.lastReload,
  }

  const results: TestResult[] = []
  const record = (name: string, fn: () => Outcome): void => {
    try {
      results.push({ name, ...fn() })
    } catch (error) {
      results.push({ name, passed: false, detail: `threw: ${(error as Error).message}` })
    }
  }

  record('scene-settle', () => {
    resetWorld(world)
    settle(world, 120)
    const cfg = world.doc.player
    const top = supportTop(world, world.spawn.pos[0], world.spawn.pos[2])
    // PlayerState.pos is FEET, so resting feet sit exactly on the support top.
    const expected = top
    const y = world.player.pos[1]

    const grounded = world.player.grounded
    const restOk = expected === null || Math.abs(y - expected) < 1e-6
    const stillOk = Math.abs(world.player.vel[1]) < 1e-9

    const detail = `grounded=${grounded} feetY=${y.toFixed(6)} supportTop=${expected?.toFixed(6) ?? 'n/a'} vy=${world.player.vel[1]} height=${cfg.height}`
    return grounded && restOk && stillOk ? pass(detail) : fail(detail)
  })

  record('player-avatar', () => {
    const readAvatar = hooks.avatarFeet
    if (!readAvatar) return fail('no avatar hook wired')

    const spread = (a: Vec3, b: Vec3): number =>
      Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))

    resetWorld(world)
    settle(world, 120)

    const avatarAtRest = readAvatar()
    let maxError = spread(avatarAtRest, world.player.pos)

    world.input = { moveX: 0, moveZ: 0, jump: true }
    stepWorld(world)
    world.input.jump = false

    let peak = avatarAtRest[1]
    let landedAt: number | null = null

    for (let i = 1; i <= 60; i++) {
      stepWorld(world)
      const avatar = readAvatar()
      maxError = Math.max(maxError, spread(avatar, world.player.pos))
      peak = Math.max(peak, avatar[1])
      if (world.player.grounded && i > 5) {
        landedAt = i
        break
      }
    }

    const lift = peak - avatarAtRest[1]
    const restingError = spread(readAvatar(), world.player.pos)
    const notANode = !world.nodes.some((node) => node.id === 'player-avatar')

    const ok =
      maxError < 1e-6 &&
      Math.abs(lift - 0.85) < 0.02 &&
      landedAt !== null &&
      world.player.grounded &&
      restingError < 1e-9 &&
      notANode

    const detail =
      `maxTrackingError=${maxError.toExponential(2)} lift=${lift.toFixed(4)}m ` +
      `landedAt=${landedAt} grounded=${world.player.grounded} ` +
      `restingError=${restingError.toExponential(2)} notASceneNode=${notANode}`

    return ok ? pass(detail) : fail(detail)
  })

  record('jump-apex-and-landing', () => {
    resetWorld(world)
    settle(world, 120)
    const cfg = world.doc.player
    const model = analyticJump(cfg.jumpSpeed, cfg.gravity)
    const measured = apexGain(world)

    const apexOk = Math.abs(measured.gain - model.apex) <= 0.02
    const apexStepOk = Math.abs(measured.atStep - model.stepsToApex) <= 1
    const landingOk = measured.landingStep !== null && Math.abs(measured.landingStep - model.airSteps) <= 1
    const landedFlat = Math.abs(world.player.pos[1] - measured.restY) < 1e-6 && world.player.grounded

    const detail =
      `apex=${measured.gain.toFixed(4)}m (model ${model.apex.toFixed(4)}) at step ${measured.atStep} (model ${model.stepsToApex}); ` +
      `landing=${measured.landingStep} (model ${model.airSteps}); restY=${measured.restY.toFixed(6)}`

    return apexOk && apexStepOk && landingOk && landedFlat ? pass(detail) : fail(detail)
  })

  record('wall-adjacency', () => {
    resetWorld(world)
    settle(world, 120)
    const cfg = world.doc.player
    const startX = world.player.pos[0]
    const startY = world.player.pos[1]

    world.input = { moveX: 1, moveZ: 0, jump: false }
    for (let i = 0; i < 120; i++) stepWorld(world)
    const blockedX = world.player.pos[0]
    const groundedWhileBlocked = world.player.grounded

    for (let i = 0; i < 60; i++) stepWorld(world)
    const drift = Math.abs(world.player.pos[0] - blockedX)
    const yDrift = Math.abs(world.player.pos[1] - startY)

    const capsule = capsuleFor(world.player.pos, cfg.radius, cfg.height)
    const penetrating = world.colliders.filter((collider) => capsulePenetration(capsule, collider) !== null).map((c) => c.nodeId)

    const moved = blockedX > startX + 0.05
    const stopped = drift < 1e-9
    const noPenetration = penetrating.length === 0

    const detail =
      `x ${startX.toFixed(3)} -> ${blockedX.toFixed(3)}; drift ${drift.toExponential(2)}; ` +
      `grounded=${groundedWhileBlocked}; yDrift=${yDrift.toExponential(2)}; penetrating=[${penetrating.join(',')}]`

    return moved && stopped && groundedWhileBlocked && noPenetration && yDrift < 1e-9 ? pass(detail) : fail(detail)
  })

  record('determinism', () => {
    const sequence = (): string => {
      resetWorld(world)
      settle(world, 120)
      world.input = { moveX: 0.3, moveZ: -0.7, jump: true }
      stepWorld(world)
      world.input.jump = false
      for (let i = 0; i < 45; i++) stepWorld(world)
      return stateHash(world)
    }

    const a = sequence()
    const b = sequence()
    return a === b ? pass(`identical hash ${a}`) : fail(`hash drift ${a} != ${b}`)
  })

  record('reload-compatibility', () => {
    resetWorld(world)
    settle(world, 120)

    const original = JSON.parse(JSON.stringify(world.doc)) as SceneDoc
    const stepBefore = world.step
    const posBefore = [...world.player.pos]

    const smallest = original.nodes
      .filter((node) => node.type === 'mesh' && node.collider.shape === 'aabb')
      .map((node) => {
        const mesh = node as Extract<typeof node, { type: 'mesh' }>
        const size = mesh.collider.shape === 'aabb' && mesh.collider.size ? mesh.collider.size : [1, 1, 1]
        return { id: node.id, volume: size[0] * size[1] * size[2] }
      })
      .sort((a, b) => a.volume - b.volume)[0]

    if (!smallest) return fail('scene has no mesh with an aabb collider to move')

    const movedAway = JSON.parse(JSON.stringify(original)) as SceneDoc
    const nodeAway = movedAway.nodes.find((node) => node.id === smallest.id)
    if (!nodeAway) return fail(`could not find '${smallest.id}'`)
    nodeAway.transform.pos = [40, 5, 40]
    const away = rebuildWorld(world, movedAway)

    const preserved = away.stateReset === 'colliders-changed' && world.step === stepBefore && Math.abs(world.player.pos[0] - posBefore[0]) < 1e-9

    const movedOnto = JSON.parse(JSON.stringify(original)) as SceneDoc
    const nodeOnto = movedOnto.nodes.find((node) => node.id === smallest.id)
    if (!nodeOnto) return fail(`could not find '${smallest.id}'`)
    nodeOnto.transform.pos = [posBefore[0], posBefore[1], posBefore[2]]
    const onto = rebuildWorld(world, movedOnto)

    const resetToSpawn = onto.stateReset === 'player-inside-collider' && Math.abs(world.player.pos[1] - world.spawn.pos[1]) < 1e-9

    rebuildWorld(world, original)

    const detail = `away=${away.stateReset} preserved=${preserved}; onto=${onto.stateReset} resetToSpawn=${resetToSpawn}`
    return preserved && resetToSpawn ? pass(detail) : fail(detail)
  })

  if (world.doc !== saved.doc) rebuildWorld(world, saved.doc)
  world.step = saved.step
  world.player = saved.player
  world.camera = saved.camera
  world.input = saved.input
  world.prevJump = saved.prevJump
  world.lastReload = saved.lastReload

  return {
    passed: results.every((result) => result.passed),
    results,
    durationMs: Number((performance.now() - started).toFixed(2)),
    statePreserved: stateHash(world) === hashBefore,
    hash: stateHash(world),
  }
}
