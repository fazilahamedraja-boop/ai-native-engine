# Deflect Arena — game design (Phase 16)

## 1. Purpose

Prove the Phase 8–15 harness can build, run, inspect, and repair a real game,
not only fixtures. The game is a compact third-person sword duel: one player,
one enemy, one arena, one complete loop. It is intentionally small enough to
finish and verify, and complete enough to be played.

The engine is Godot 4.7.2. The renderer, physics, scene system, and animation
paths are Godot's. No engine infrastructure was added in this phase.

## 2. Non-goals

Not a commercial Soulslike. Out of scope: multiple enemies, lock-on, combos,
weapon variety, inventory, progression, save files, menus, audio, level
streaming, networking, or a boss with phases. The camera does not orbit.

## 3. Core loop

1. Spawn in the arena, facing the enemy.
2. Close distance.
3. The enemy telegraphs a heavy slash: its blade glows and the HUD says
   `INCOMING ATTACK - press K to deflect`.
4. Deflect inside the late windup: the blow is cancelled, the player takes no
   damage, posture damage is awarded, and a `DEFLECT` label appears.
5. Miss the window: the blow lands and the player loses one health pip.
6. Attack during the enemy's recovery or stagger to reduce its health and add
   posture. At 100 posture the enemy staggers for 70 ticks.
7. Reduce enemy health to zero: `VICTORY`, `press R to restart`.
8. Lose all four health: `DEFEAT`, `press R to restart`.
9. `R` restores step 0 with full health and the enemy's full health, cleared
   events, and the spawn arrangement.

## 4. Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | world-axis movement, aligned with the fixed camera |
| `J` or left mouse | sword attack |
| `K` | deflect |
| `R` | restart |

Movement accelerates to 4.4 m/s with 26 m/s² acceleration and turns toward the
movement direction. Input is edge-triggered for one-shot actions; holding the
key does not re-trigger.

## 5. Arena and camera

- 24 x 24 m walled arena, dark stone floor, central ring, four pillars.
- Player spawns at `(0, 0.02, 4.4)`, enemy at `(0, 0.02, 0.8)`.
- Third-person camera: fixed-angle follow at `player + (1.1, 2.7, 4.7)`,
  looking at `player + (0, 1.15, 0)`, blended 0.35 per tick.
- The shoulder offset keeps the enemy visible beside the player at melee range.
- A ray from the look target to the desired camera position tests the world
  layer. On a hit the camera is pulled to the surface plus the hit normal, then
  raised so the boom never collapses inside the player. With the player's back
  to a wall the view becomes a close high angle instead of clipping.
- The camera follows position only; it does not rotate with the player.

## 6. Player

| Property | Value |
| --- | --- |
| Health | 4 |
| Movement | 4.4 m/s, 26 m/s² acceleration |
| Attack | 6 windup + 8 active + 14 recover + 6 cooldown ticks |
| Attack reach | box `1.5 x 1.3 x 2.0` at local `(0, 1.0, -1.3)` |
| Deflect | 14-tick window, 8-tick recovery, 8-tick cooldown |
| Deflect result states | `idle` → `active` → `success` / `expired` |

A swing records at most one hit (`hit_landed` latch). The hitbox is queried
only during active ticks, against the enemy layer, with `collide_with_areas`
off. After the active window, no query runs at all. A swing that starts facing
away misses because the box is in the player's local forward space.

The deflect window opens when `K` is pressed and counts down one tick per
physics frame. It can only succeed if the enemy's active hit arrives while the
window is open. If the window reaches zero first, the result becomes `expired`
and a later hit is a normal hit. A successful deflect cancels that enemy attack,
awards 55 posture, and does not damage the player.

## 7. Enemy

Pure state machine in `scripts/enemy_ai.gd`; it does not query physics or draw.

| Property | Value |
| --- | --- |
| Health | 5 |
| Attack | 30 windup + 9 active + 18 recover + 22 cooldown ticks |
| Attack range | 2.3 m (starts windup inside it) |
| Movement | 2.2 m/s toward the player outside range |
| Posture | 100 max, +16 per sword hit, +55 per deflect, −0.35/tick decay |
| Stagger | 70 ticks at 100 posture; no attacks during stagger |
| Telegraph | emissive red blade + HUD warning during windup |

States: `idle`/`approach` → `windup` → `active` → `recover` → `cooldown` →
`approach`, with `stagger` interrupting any non-defeated state. The enemy turns
toward the player at 8 rad/s. Defeat sets `defeated`, stops AI updates, and the
rig lays the model down.

A staggered enemy can still be damaged; stagger is the player's reward window.
It only prevents the enemy from attacking, it does not make it invulnerable.

## 8. Combat resolution

All timing is in physics ticks at 60 Hz. A tick is one `_physics_process` call.

- `WORLD_LAYER = 1`, `PLAYER_LAYER = 2`, `ENEMY_LAYER = 4`.
- Player attack query: `PhysicsShapeQueryParameters3D` with a `BoxShape3D`,
  collision mask `ENEMY_LAYER`, excludes the player, max results 8.
- Enemy attack query: same shape path, mask `PLAYER_LAYER`, excludes the enemy.
- The player's hitbox is only queried on active ticks. The enemy's hitbox is
  only queried on active ticks.
- Every hit emits a structured event: `player_hit_enemy`, `enemy_hit_player`,
  `parry_success`, `enemy_staggered`, `enemy_defeated`, `player_defeated`,
  `victory`, `defeat`, `reset`.
- Health, posture, phase, parry result, outcome, camera distance, and the last
  hitbox query step are exposed in `snapshot()` for tests and evidence.

No damage shortcut exists in the test hooks: `harness_setup` can place bodies
and set health/posture to create a scenario, but every hit still goes through
the same `_resolve_*` code that live play uses.

## 9. Presentation

- Placeholder humanoid built from named rigid limb meshes. No skeleton, no
  animation clips. The rig animates limbs procedurally:
  - attack: 0–0.22 raise, 0.22–0.52 swing, 0.52–1.0 settle;
  - deflect: blade raised over roughly 3 ticks;
  - stagger: lean back;
  - defeat: rotate the model down to `rotation.x = 1.48`.
- Player is blue (`#3d6f92`) with a cyan accent (`#9fe8ff`); enemy is rust
  (`#8c3f36`) with an orange accent (`#ff9a72`). The enemy blade emits red
  during windup.
- Sword: three box primitives (blade, guard, grip) parented to the right arm at
  local `(0, -0.275, 0)`, rotated so the blade extends forward (−Z).
- HUD: health pips, enemy health, posture bar with numeric value, state line,
  controls line, transient `HIT`/`DEFLECT`/`STRUCK` feedback, and centered
  `VICTORY`/`DEFEAT` text.

## 10. Asset plan

| Asset | Source | License/provenance |
| --- | --- | --- |
| Body mesh | `content/assets/character/placeholder-character.glb` copied to `game/assets/` | repository placeholder asset, no third-party art |
| Sword | runtime `BoxMesh` primitives | generated in `fighter_rig.gd` |
| Arena | runtime `BoxMesh`/`CylinderMesh`/`PlaneMesh` | generated in `game_world.gd` |
| Font/HUD | Godot default theme | engine default |

The GLB has 9 nodes / 6 meshes and no skin or animation. It is imported once
with `godot --headless --path game --import`; the generated `.import` file is
committed so a fresh checkout does not silently load a stale resource.

## 11. Acceptance criteria

The 12 required checks, each asserted on observable state:

1. Clean launch: scene instantiates, step 0, outcome `playing`.
2. Player moves and stays grounded.
3. Camera follows the player without wall clipping.
4. The sword can hit the enemy.
5. An attack outside its active window deals no damage.
6. The enemy can damage the player.
7. A correct deflect produces the expected result (no damage, posture gain,
   `parry_success` event).
8. A mistimed deflect does not register.
9. Enemy health/stagger/defeat transitions.
10. Player defeat is handled.
11. Victory after enemy defeat.
12. Restart restores a valid initial state.

The suite adds camera wall clipping, staggered-enemy safety, the event stream,
and HUD state for 18 total checks.

## 12. Tuning table

| Constant | Value | File |
| --- | --- | --- |
| `PLAYER_MAX_HEALTH` | 4 | `game_world.gd` |
| `ATTACK_WINDUP_TICKS` | 6 | `game_world.gd` |
| `ATTACK_ACTIVE_TICKS` | 8 | `game_world.gd` |
| `ATTACK_RECOVER_TICKS` | 14 | `game_world.gd` |
| `ATTACK_COOLDOWN_TICKS` | 6 | `game_world.gd` |
| `PARRY_WINDOW_TICKS` | 14 | `game_world.gd` |
| `PARRY_RECOVER_TICKS` | 8 | `game_world.gd` |
| `MAX_HEALTH` (enemy) | 5 | `enemy_ai.gd` |
| `WINDUP_TICKS` | 30 | `enemy_ai.gd` |
| `ACTIVE_TICKS` | 9 | `enemy_ai.gd` |
| `RECOVER_TICKS` | 18 | `enemy_ai.gd` |
| `COOLDOWN_TICKS` | 22 | `enemy_ai.gd` |
| `STAGGER_TICKS` | 70 | `enemy_ai.gd` |
| `MAX_POSTURE` | 100 | `enemy_ai.gd` |
| `POSTURE_PER_HIT` | 16 | `enemy_ai.gd` |
| `POSTURE_PER_PARRY` | 55 | `enemy_ai.gd` |
| `POSTURE_DECAY_PER_TICK` | 0.35 | `enemy_ai.gd` |
