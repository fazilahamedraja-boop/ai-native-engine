# Arena game contract

This project is an arena-game scaffold. Your job is to turn `scripts/main.gd`
into a real, playable 3D arena game. The contract below is enforced by
`tests/run_arena_tests.gd` (read-only) and by a pristine copy of that suite, so
the game must satisfy the behaviour, not just the file names.

Read `tests/run_arena_tests.gd` before you start. It is the specification.
You may not edit it, and editing it changes nothing: verification runs a clean
copy kept outside the project.

## Files

| Path | Policy |
| --- | --- |
| `scripts/main.gd` | **editable** — the arena game |
| `scripts/**` | **editable** — new helper scripts are allowed |
| `scenes/main.tscn` | **editable** — the main scene |
| `scenes/**`, `assets/**` | **editable** — new scenes and assets are allowed |
| `tests/**`, `harness/**`, `scripts/arena_host.gd`, `project.godot`, `ARENA_SPEC.md`, `PROJECT.md`, `project.manifest.json` | read-only |

`scripts/main.gd` currently only contains an honest stub. Nothing else in the
scene is gameplay code.

## Scene requirements

`res://scenes/main.tscn` is the main scene (already set in `project.godot`).
Its root must stay a `Node3D` in group `arena` carrying `scripts/main.gd`.
You may edit the scene file, build nodes from `scripts/main.gd`, or both.

At runtime (after `_ready()`) the running tree must contain:

- one current `Camera3D` that frames the arena;
- at least one visible `Light3D`;
- a visible floor `MeshInstance3D` whose horizontal extent is at least 12 units
  on both X and Z (the template floor is 24 x 24 and already satisfies this);
- a visible player node in group `player`, with a `MeshInstance3D` child that
  has a mesh;
- a visible enemy node in group `enemy`, with a `MeshInstance3D` child that has
  a mesh;
- visible on-screen text (`Label3D`, `Label` or `RichTextLabel`) that names the
  controls.

The template already provides the camera, light, floor and a `Hint` label in the
`HUD` canvas layer. Keep them or replace them with equivalents. A camera that
points up at the sky fails the acceptance suite, because every windowed capture
would then be a blank frame.

## Public API on the arena root node

```gdscript
func reset() -> void
func set_input(values: Dictionary) -> void
func tick(delta: float) -> void
func get_state() -> Dictionary
```

- `reset()` restores the initial state: both fighters at full health,
  `outcome == "playing"`, both visible, normal starting positions.
- `set_input(values)` stores one complete input frame. Missing keys are
  released. Keys: `move_forward`, `move_back`, `move_left`, `move_right`,
  `attack`, `restart`. Booleans and `0`/`1` numbers are both accepted.
  `attack` and `restart` are **edge triggered**: one action per transition from
  released to pressed, not one per tick while held.
- `tick(delta)` advances the simulation by `delta` seconds. Apply movement to
  the player position **directly inside `tick`**. Do not rely only on physics
  bodies: the automated suite steps a paused tree deterministically.
- `get_state()` returns a `Dictionary` with:
  - `player_health`: number, starts at 100
  - `enemy_health`: number, starts at 100
  - `outcome`: `"playing"`, `"won"` or `"lost"`
  - `player_position`: `[x, y, z]` array of numbers
  - `enemy_position`: `[x, y, z]` array of numbers
  - `controls_text`: non-empty string with the on-screen control hints
  - `enemy_visible`: bool

## Gameplay rules

- **Movement.** `move_forward` moves the player toward the enemy, `move_back`
  away from it, `move_left` / `move_right` sideways. Horizontal speed at least
  4 units per second. The player stays on the floor (Y constant).
- **Enemy chase.** While `outcome == "playing"` the enemy closes on the player
  at no less than 1.5 units per second until it is in contact range.
- **Contact damage.** While the enemy is within 1.6 units of the player, the
  player loses at least 8 health per second.
- **Attack.** When `attack` goes from released to pressed and the enemy is
  within 3 units, the enemy loses at least 25 health. An attack further away
  does nothing. Holding the key must not repeat damage.
- **Win.** `enemy_health <= 0` sets `outcome` to `"won"` and hides the enemy.
- **Loss.** `player_health <= 0` sets `outcome` to `"lost"`.
- **Stable outcome.** Once `outcome` is no longer `"playing"` it stays that way
  until `reset()` or a `restart` press. Restart behaves like `reset()`.

## Host and input

`scripts/arena_host.gd` is an autoload named `ArenaHost`. It owns the frame
loop: every frame it reads the keyboard (WASD, Space/Enter/J to attack, R to
restart) into one input frame and calls `set_input()` and then `tick(delta)`.
The Studio bridge calls the same host to step the game deterministically.

That means:

- do **not** add a `_process()` that calls `tick()`; the host already drives it
  (a second loop would double the simulation speed);
- do **not** call `Input` for gameplay; use the `set_input` dictionary so real
  play and the tests use the same path;
- do not edit `project.godot` to add input actions; the host registers them.

## How it is verified

1. Every `.gd` file is parsed with Godot's own check-only mode.
2. `tests/run_arena_tests.gd` runs against the candidate.
3. A pristine copy of the same suite runs from outside the project, so a
   tampered test file cannot pass.
4. The game is launched in a real window; a frame is captured and real harness
   input must move the player.
