# Manifest source-field correction

This correction is evidence-only. It does not modify `run.json`, the preserved
attempts, the screenshots, or the acceptance results.

## What the manifest fields mean

`run.json.source` and `source_files_before` / `source_files_after` describe the
**canonical Phase 18 worktree**, not the disposable sandbox the agent edited.
The runner needs that canonical path to know where an accepted change would be
mirrored. The actual controlled-defect input is the preserved
`source-baseline/` directory, and the agent's actual output is preserved under
`attempt-1/source/` and `attempt-2/source/`.

That distinction matters because the canonical worktree was healthy during the
run. Reading only `source_files_before` would therefore make it look as if the
agent was given healthy code. It was not.

## Actual source chain

| Role | Path | `scripts/fighter_rig.gd` SHA256 |
| --- | --- | --- |
| Controlled-defect input | `source-baseline/scripts/fighter_rig.gd` | `5ced74eb77802aac6c6f42fb4a413e6ccf4ba75a2acef9542c138d11d0b9be01` |
| Agent output, attempt 1 | `attempt-1/source/scripts/fighter_rig.gd` | `0369c3831f5bd3dce19b7e9d63df187ac4491bcd33544c8d23d820e6b0f4942a` |
| Agent output, attempt 2 | `attempt-2/source/scripts/fighter_rig.gd` | `0369c3831f5bd3dce19b7e9d63df187ac4491bcd33544c8d23d820e6b0f4942a` |
| Canonical worktree after run | `experiments/godot-harness/game/scripts/fighter_rig.gd` | `0369c3831f5bd3dce19b7e9d63df187ac4491bcd33544c8d23d820e6b0f4942a` |
| Healthy code backup | `C:\Users\hacke\AppData\Local\Temp\opencode\phase18-defect\healthy-scripts\fighter_rig.gd` | `0369c3831f5bd3dce19b7e9d63df187ac4491bcd33544c8d23d820e6b0f4942a` |

The other two scripts were identical in the defect input and healthy source:

| Script | SHA256 |
| --- | --- |
| `enemy_ai.gd` | `fda22478cb8691042abf1ac44f44fc04ced8375b87445baa56bd073c3614c3ad` |
| `game_world.gd` | `b47e5ecbda9db96a95018ea218a722b6fa40ca8932bb34794238269aa5b175bc` |

The preserved `attempt.diff` for each attempt shows the same single-expression
change from the defect baseline to the healthy output.

## What the manifest fields currently say

`run.json` records:

- `source`: `experiments/godot-harness/game`
- `source_files_before.scripts/fighter_rig.gd`: `0369c383...` (healthy)
- `source_files_after.scripts/fighter_rig.gd`: `0369c383...` (healthy)
- `observed.dir`: `docs/phase18/evidence/defect/before/2026-10-23T19-25-41`
  (correct: the real defective capture set)

Those canonical-snapshot values are internally consistent with the runner's
mirroring design. They are simply not the sandbox input and must not be cited as
such.

## Why this is not a false pass

- `source-baseline/` is the exact disposable input and has the defective hash.
- `attempt-2/post/` contains seven real captures with the frozen encounter.
- `attempt-2/post/visual-acceptance.json` passes 39/39.
- `attempt-2/tests/existing-18.json` and `hidden-dodge-12.json` pass 18/18 and
  12/12.
- The final controlled repair output hash equals the accepted healthy worktree
  hash.
- The original `run.json` is unchanged and still records the pass.

Future runner manifests should record an explicit `sandbox_source` path (or
rename these fields to `canonical_source_*`) so this ambiguity does not recur.
