# Phase 3 — Loop benchmarks

Five prompt-driven content cycles. Each cycle is:

> prompt -> read one manifest -> edit -> regenerate -> validate -> preview/capture -> commit

The predictions below were recorded before the first edit. The deliberate-break
benchmark is the required case that must fail; the broken state is never
committed.

## Method

- **End-to-end wall-clock** is the interval between the previous benchmark
  checkpoint and this benchmark's checkpoint. It includes agent reasoning and
  browser round-trips, so it is not the engine's compute time.
- **Mechanical time** is measured separately with `Measure-Command` around the
  CLI regenerate/validate calls and in-page `performance.now()` around the
  capture. It isolates the engine/tooling from model latency.
- **Content tokens** are an estimate: characters of the prompt, prediction,
  manifest diff, CLI output and preview metadata in this page, divided by 4.
  They exclude hidden model reasoning and image tokens; they are the visible
  loop's working set, not a billing measurement.
- **Commit interval**: every benchmark except the deliberate break ends in its
  own commit, so the interval is auditable from `git log`.
- The deliberate break is restored before its evidence commit; only the failure
  output and the restored state are committed.

## Summary

| # | Benchmark | Prediction | Observed | Wall-clock | Content tokens | Result |
|---|---|---|---|---|---|---|
| B1 | Sword disc guard | 122 tri, ±0.05 x/z | 122 tri, 366 v, bounds ±0.05; hash `c2324397` | 334 s core / 1,312 s full | ~1.1k | PASS |
| B2 | Bronze shortsword | 122 tri, 0.7 m | pending | pending | pending | pending |
| B3 | Humanoid slate override | artifact hash unchanged | pending | pending | pending | pending |
| B4 | Pine snow | 316 tri, bounds unchanged | pending | pending | pending | pending |
| B5 | Deliberate socket break | `socket_mismatch` | pending | pending | pending | pending |

## B1 — Sword disc guard

### Prompt

> Change the iron sword's guard from a crossguard to a disc guard. Predict the
> triangle and bounds change before regenerating.

### Prediction (recorded before edit)

- Baseline: 90 triangles, 270 vertices, hash `775afbcb1721bd57`, bounds
  `[-0.11, -0.1, -0.026] .. [0.11, 0.85, 0.026]`.
- The crossguard is a box: 12 triangles. The disc guard is a closed
  12-segment cylinder: `4 * 12 - 4 = 44` triangles. Change: **+32 triangles**.
- Predicted artifact: **122 triangles**, **366 vertices**.
- Predicted bounds: x/z shrink to **±0.05** (disc radius); y stays
  **-0.1 .. 0.85**. Sockets stay `grip`, `blade_mid`, `tip`.
- `regen` without `--accept` should reject the stale x/z bounds; `regen
  --accept` should update the declared bounds.
- Tests still pass: `max-extent 1.4`, `triangles-max 300`, `watertight`,
  `area-positive`.
- Visual: the crossbar becomes a round disc; no length change.

### Observed

- `assets regen sword-iron-01` rejected the stale bounds exactly as predicted:
  declared `[-0.110, -0.100, -0.026] .. [0.110, 0.850, 0.026]`, measured
  `[-0.050, -0.100, -0.050] .. [0.050, 0.850, 0.050]`, exit 1.
- `regen --accept` rewrote the bounds; `validate` passed 1/1.
- Artifact: **122 triangles**, **366 vertices**, hash
  `c2324397626e6ad3`; bounds `±0.05` x/z, `-0.1 .. 0.85` y.
- Captures: before 22 ms, after 29 ms. CLI accept + validate: 1,294 ms.
- Core loop wall-clock (prompt -> validated preview): **334 s** (5.6 min).
- Full checkpoint interval (through commit `fbb0154`): **1,312 s** (21.9 min);
  the review image and doc update account for the difference.
- Content tokens: **~1.1k** (estimate; includes the CLI's full-file
  formatting rewrite, see below).
- **Finding:** `regen --accept` rewrites the whole manifest with expanded
  2-space formatting, turning a two-value semantic change into a large diff.
  It is correct but costly for the text-first loop. A canonical formatter or a
  format-preserving accept is a candidate follow-up.
- Image: `docs/phase3/b1-sword-guard.png`.

Result: **PASS** (122 tri and bounds match; validation clean).

## B2 — Bronze shortsword

### Prompt

> Author `sword-bronze-01`: a 0.7 m bronze shortsword with a narrow blade and a
> disc guard. Write its contract and tests, then verify it.

### Prediction (recorded before edit)

- The topology is the same as B1: pommel (10-segment cylinder), grip
  (8-segment cylinder), disc guard (12-segment cylinder), diamond blade.
  Predicted artifact: **122 triangles**, **366 vertices**.
- Length 0.7 puts the tip at `0.7 - 0.1 = 0.6 m`; the disc radius is 0.05 m.
  Predicted bounds: `[-0.05, -0.1, -0.05] .. [0.05, 0.6, 0.05]`.
- Predicted sockets: `grip [0,0,0]`, `blade_mid [0,0.375,0]`,
  `tip [0,0.6,0]`.
- Contract tests: `origin-at grip`, `sockets-present`, `max-extent 0.75`,
  `triangles-max 200`, `watertight`, `area-positive`.
- `regen` should match the authored contract without `--accept`.
- Material: bronze `#b18b58`, roughness 0.45, metalness 0.75.
- Visual: a shorter bronze sword with a disc guard.

### Observed

Pending.

## B3 — Humanoid slate override

### Prompt

> Recolor the humanoid's clay to slate blue `#6f7f95` at roughness 0.5. This is
> appearance-only; geometry and the artifact hash must not change.

### Prediction (recorded before edit)

- Baseline: 264 triangles, hash `24a10e9da432a551`, artifact material
  `#a2816c`, roughness `0.6200000047683716`, metalness `0`.
- The manifest override changes only `override.material`; the imported artifact
  and its hash stay **`24a10e9da432a551`**.
- Effective material: color **`#6f7f95`**, roughness **0.5**, metalness `0`,
  single-sided. The preview must show slate instead of warm clay.
- `regen` and `validate` should both pass; no contract drift.

### Observed

Pending.

## B4 — Pine snow

### Prompt

> Turn on snow for the pine. Predict the triangle and vertex change, and confirm
> the silhouette and bounds do not move.

### Prediction (recorded before edit)

- Baseline: 172 triangles, 516 vertices, 6 tiers, `snow: false`, bounds
  `[-1.68, 0, -1.68] .. [1.68, 8, 1.68]`, hash `62e253c437e66a18`,
  `triangles-max 400`.
- Each tier with snow becomes 12 lower side quads (24 triangles) + 12 upper
  triangles + 12 base-cap triangles = **48 triangles**, versus 24 without snow.
  Six tiers add **144 triangles**; the trunk is unchanged.
- Predicted artifact: **316 triangles**, **948 vertices**.
- Bounds stay **`[-1.68, 0, -1.68] .. [1.68, 8, 1.68]`**; the snow waist ring is
  inside the base ring and the apex is unchanged.
- `triangles-max 400` still passes; `watertight` and `area-positive` still pass.
- Visual: a white snow band on each foliage tier; trunk and footprint unchanged.

### Observed

Pending.

## B5 — Deliberate socket break

### Prompt

> Move the humanoid's declared `head` socket from y=1.70 to y=1.60, confirm
> validation rejects it with `socket_mismatch`, confirm the preview refuses to
> build it, then restore. Do not commit the broken state.

### Prediction (recorded before edit)

- The GLB measures `head [0, 1.7, 0]`; the declared position moves 0.10 m,
  far beyond `SOCKET_TOLERANCE = 1e-4`.
- `assets validate humanoid-01` fails at path `contract.sockets.head` with code
  **`socket_mismatch`**.
- The asset inspector at `?asset=humanoid-01` shows a build error and does not
  create `window.__preview`.
- Restoring the socket makes validation pass again (6/6 after B2 adds an asset).
- This is the required deliberate break that must fail; no broken content is
  committed.

### Observed

Pending.
