# Godot sentry benchmark

This is the Phase 7 Godot implementation of the same sentry scenario used by
`src/game/sentry.ts` in the custom engine.

## Requirements

- Godot **4.7.2** (the version measured in `docs/phase7-comparison.md`).
- No game assets or addons are required to run the game or the headless tests.
  The `addons/godot_mcp` tree is developer tooling and is ignored by Git.

## Run

```powershell
godot --path . --editor   # or open project.godot in Godot
```

or run the main scene directly:

```powershell
godot --path . --headless --quit-after 2
```

The scene starts at the origin. Walk toward the green beacon at the far end of
the ground; the two static guards and their red detection wedges are between the
start and the exit.

Controls: `WASD` move, `Space` jump, `R` restart.

## Headless tests

```powershell
godot --headless --path . -s res://tests/run_tests.gd
```

Expected final line: `RESULT passed=7 failed=0`.

## Layout

- `scripts/sentry_state.gd` - pure fixed-tick state machine (no scene/clock).
- `scripts/player.gd` - `CharacterBody3D` movement and jump.
- `scripts/main.gd` - scene construction, update order, camera, HUD.
- `tests/run_tests.gd` - headless detection, decay, loss, win, reset,
  determinism, and outside-cone checks.

## MCP tooling (not required to play)

The local `godot-ensure.ps1` helper copies `addons/godot_mcp` into this project
and enables the editor plugin. That addon is not part of the game and is
deliberately ignored by Git.
