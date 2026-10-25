# Voxel Sandbox (Phase 19)

A small first-person voxel sandbox used to exercise the Phase 15 adapter and
Phase 18 observation/evidence workflow against a new game rather than a change
to Deflect Arena.

## Run it

```powershell
godot --path experiments/godot-harness/voxel
```

Controls: WASD move, Space jump, mouse look, LMB mine, RMB place, `1`-`4` or
mouse wheel select a block, `F5` save, `F9` load, `R` reset the world, `Esc`
release the mouse. Click the viewport to recapture it.

Saves go to `user://phase19-observation.json`, which resolves to
`%APPDATA%\Godot\app_userdata\voxel-sandbox\` on Windows. Nothing is written
inside the repository.

## Layout

| Path | Purpose |
| --- | --- |
| `main.tscn` | Single `Node3D` root running `scripts/voxel_world.gd` |
| `scripts/voxel_data.gd` | Pure world data: generation, raycast, save document, hash |
| `scripts/voxel_chunk_builder.gd` | Chunk mesh + collision faces from world data |
| `scripts/voxel_player.gd` | First-person `CharacterBody3D` controller |
| `scripts/voxel_save_store.gd` | `user://`-only JSON store |
| `scripts/voxel_world.gd` | Scene assembly, interaction, HUD, events, harness surface |
| `harness/bridge.gd` | Opt-in TCP bridge, enabled only with `--harness-port=` |
| `tests/run_voxel_data_tests.gd` | Hidden 15-check data suite |
| `tests/run_voxel_tests.gd` | 36-check gameplay acceptance suite |
| `tests/measure_voxel.gd` | World counts and CPU timing measurement |

## Verify

```powershell
godot --headless --editor --path experiments/godot-harness/voxel --quit
godot --headless --path experiments/godot-harness/voxel -s res://tests/run_voxel_data_tests.gd
godot --headless --path experiments/godot-harness/voxel -s res://tests/run_voxel_tests.gd
```

Observation, measurement, defect-repair, and export verification runners live in
`../controller/voxel-*.mjs`. See `docs/phase19/REPORT.md` for results and limits.

## Export

```powershell
godot --headless --path experiments/godot-harness/voxel --export-release "Windows Desktop" experiments/godot-harness/voxel/build/voxel-sandbox.exe
```

`build/` is git-ignored.
