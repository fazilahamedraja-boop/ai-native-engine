// Real-window gameplay verification for an arena project.
//
// The acceptance suite proves the rules headlessly; this proves the same rules
// in a real Godot window through the same harness input path a player uses.
// It is deliberately separate from `npm test` because it opens a window.
//
// Usage:
//   node test/gameplay-probe.mjs                 # template + reference impl
//   node test/gameplay-probe.mjs --project DIR   # a real project on disk
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { HarnessSession } from '../../experiments/godot-harness/controller/harness.mjs'

const TICK = 1 / 60

function resolveProject() {
  const index = process.argv.indexOf('--project')
  if (index !== -1 && process.argv[index + 1]) {
    const dir = path.resolve(process.argv[index + 1])
    if (!fs.existsSync(path.join(dir, 'project.godot'))) {
      throw new Error(`not a Godot project: ${dir}`)
    }
    return { dir, temporary: false }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-gameplay-'))
  const dir = path.join(root, 'arena')
  fs.cpSync(path.join(import.meta.dirname, '..', 'templates', 'arena'), dir, { recursive: true })
  fs.copyFileSync(
    path.join(import.meta.dirname, 'fixtures', 'arena-reference', 'scripts', 'main.gd'),
    path.join(dir, 'scripts', 'main.gd'),
  )
  return { dir, temporary: true }
}

function stateOf(snapshot) {
  const state = snapshot?.snapshot ?? snapshot?.final ?? snapshot ?? {}
  return {
    player_health: Number(state.player_health),
    enemy_health: Number(state.enemy_health),
    outcome: String(state.outcome ?? ''),
    player_position: state.player_position,
    enemy_position: state.enemy_position,
    enemy_visible: state.enemy_visible,
    controls_text: String(state.controls_text ?? ''),
  }
}

function distance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null
  return Math.hypot(a[0] - b[0], a[2] - b[2])
}

async function main() {
  const { dir, temporary } = resolveProject()
  console.log(`project: ${dir}${temporary ? ' (temporary reference copy)' : ''}`)
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true })

  const session = new HarnessSession({ project: dir, headless: false, timeoutMs: 60000, allowOutsideRoot: true })
  const started = await session.start()
  console.log(`pid: ${started.pid ?? session.pid}`)

  const result = { project: dir, observations: {}, shots: {} }

  await session.pause()
  await session.reset()
  const initial = stateOf(await session.snapshot())
  result.observations.initial = initial

  // Read the on-screen text from the live tree, whatever node type the game
  // used, instead of assuming the template's node names survived.
  const tree = await session.sceneTree()
  const textPaths = []
  const walk = (node) => {
    if (['Label', 'Label3D', 'RichTextLabel'].includes(node?.class)) textPaths.push(node.path)
    for (const child of node?.children ?? []) walk(child)
  }
  walk(tree.result?.tree ?? tree.tree ?? tree)
  const onScreenText = []
  for (const nodePath of textPaths) {
    try {
      const value = await session.property(nodePath, 'text')
      if (typeof value?.value === 'string' && value.value.trim().length > 0) {
        onScreenText.push({ path: nodePath, text: value.value })
      }
    } catch (error) {
      console.log(`could not read text of ${nodePath}: ${error.message}`)
    }
  }
  result.observations.on_screen_text = onScreenText

  // 1. Movement with real harness input.
  await session.setInput({ forward: 1 })
  await session.step({ steps: 30 })
  await session.setInput({})
  const moved = stateOf(await session.snapshot())
  result.observations.after_move = moved
  result.observations.moved_distance = distance(initial.player_position, moved.player_position)
  result.shots.moved = (await session.captureFrame({ path: 'res://artifacts/probe-moved.png', scenario: 'probe-moved' })).screenshot

  // 2. An attack out of range must do nothing (negative check).
  await session.setInput({ actions: { attack: true } })
  await session.step({ steps: 1 })
  await session.setInput({})
  await session.step({ steps: 1 })
  const farAttack = stateOf(await session.snapshot())
  result.observations.attack_out_of_range = {
    distance: distance(farAttack.player_position, farAttack.enemy_position),
    enemy_health: farAttack.enemy_health,
  }

  // 3. Close the distance with real movement input, then attack to win.
  let gap = distance(farAttack.player_position, farAttack.enemy_position) ?? 0
  let closeSteps = 0
  while (gap > 2.2 && closeSteps < 900) {
    await session.setInput({ forward: 1 })
    await session.step({ steps: 10 })
    closeSteps += 10
    const state = stateOf(await session.snapshot())
    gap = distance(state.player_position, state.enemy_position) ?? gap
  }
  await session.setInput({})
  result.observations.closed_distance = { steps: closeSteps, gap }

  const attacks = []
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await session.setInput({ actions: { attack: true } })
    await session.step({ steps: 1 })
    await session.setInput({})
    await session.step({ steps: 1 })
    const state = stateOf(await session.snapshot())
    attacks.push({ attempt: attempt + 1, enemy_health: state.enemy_health, outcome: state.outcome })
    if (state.outcome !== 'playing') break
  }
  result.observations.attacks = attacks
  const won = stateOf(await session.snapshot())
  result.observations.won_state = won
  const wonShot = await session.captureFrame({ path: 'res://artifacts/probe-won.png', scenario: 'probe-won' })
  result.shots.won = wonShot.screenshot

  // 4. Restart must restore the fight.
  await session.setInput({ restart: true })
  await session.step({ steps: 1 })
  await session.setInput({})
  await session.step({ steps: 1 })
  result.observations.after_restart = stateOf(await session.snapshot())

  // 5. Stand still and let the enemy win: contact damage must end the fight.
  await session.step({ steps: 1200 })
  const lost = stateOf(await session.snapshot())
  result.observations.lost_state = lost
  const lostShot = await session.captureFrame({ path: 'res://artifacts/probe-lost.png', scenario: 'probe-lost' })
  result.shots.lost = lostShot.screenshot

  await session.stop()

  result.checks = {
    starts_at_full_health: initial.player_health === 100 && initial.enemy_health === 100,
    starts_playing: initial.outcome === 'playing',
    enemy_visible_at_start: initial.enemy_visible === true,
    controls_on_screen:
      initial.controls_text.length > 0 &&
      onScreenText.some((entry) => /(WASD|MOVE|ARROW)/i.test(entry.text)) &&
      onScreenText.some((entry) => /(SPACE|ATTACK|ENTER|J\b)/i.test(entry.text)),
    movement_observed: (result.observations.moved_distance ?? 0) > 0.5,
    attack_out_of_range_does_nothing: farAttack.enemy_health === 100,
    attack_damages_enemy: attacks.some((entry) => entry.enemy_health < 100),
    attack_kills_enemy: won.outcome === 'won' && won.enemy_health <= 0,
    enemy_hidden_on_win: won.enemy_visible === false,
    restart_restores_fight:
      result.observations.after_restart.outcome === 'playing' &&
      result.observations.after_restart.enemy_health === 100 &&
      result.observations.after_restart.player_health === 100,
    contact_damage_loses: lost.outcome === 'lost' && lost.player_health <= 0,
  }
  result.ok = Object.values(result.checks).every(Boolean)

  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

await main()
