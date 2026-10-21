# Stage C blind diagnosis (evidence only)

Diagnosis of the Stage C combat fixture "before" run (`ATTACKS 1, HITS 0`, target health
unchanged `3/3`, acceptance test `2 of 3` checks failed), produced **only** from the captured
evidence listed below. No fixture source, no "after" artifacts, no repair diff, and no prior
diagnosis documents were read.

## Evidence used

Files read (all under `docs/phase11/stage-c/before/`):

- `manifest.json` — run manifest: capture states, per-frame sequence, `final_snapshot`, and the
  measured node tree.
- `observation.json` — the event stream (13 events) plus the measured node tree / runtime block.
- `snapshot.json` — final runtime snapshot (combat counters, target, weapon).
- `test.json` — headless acceptance test output (`res://tests/run_combat.gd`).
- `initial.png`, `attack-000.png` … `attack-006.png`, `final.png` — HUD debug readout and 3D view
  of the swing (all 9 PNGs read; `initial.png` is byte-identical to `attack-000.png` and
  `final.png` is byte-identical to `attack-006.png`, per matching `sha256` in `manifest.json`).

Derived geometry was computed numerically from the transforms recorded in those files
(pivot + local offset, yaw from `(hitbox_global_origin - pivot)/0.18`).

---

## 1. What exactly failed

**Acceptance test (`test.json`)** — `exitCode: 1`, `ok: false`, `summary: {passed: 1, failed: 2}`:

| check | passed | detail |
|---|---|---|
| `combat-attack-started` | **true** | `attacks=1 expected=1` |
| `combat-hit-registers` | **false** | `hits=0 expected=1 target_health=3` |
| `combat-target-health-decreases` | **false** | `target_health=3 expected=2` |

**Counters (`snapshot.json` → `combat`)**: `attacks: 1`, `hits: 0`, `target_health: 3`,
`target_max_health: 3`, `last_hit_distance: -1` (sentinel = never measured),
`last_hitbox_origin: [0.26977601647377, 0.879999995231628, 0.178223878145218]`.

**Event stream (13 events, `source: "fixture_recorded"`)** — the attack lifecycle ran correctly,
but every active tick reports a miss:

- `seq 1` `type: "reset"`, `label: "combat_fixture_reset"`, `simulation_step: 0`
- `seq 2` `type: "attack_start"`, `attack_index: 1`, `simulation_step: 1`, `tick: 45`
- `seq 3`–`seq 12` `type: "attack_active"`, `simulation_step: 4 … 13` — **every one** carries
  `hitbox_overlap_count: 0`, `target_in_hitbox: false`, `target_origin: [0, 0, 1.20000004768372]`
- `seq 13` `type: "attack_end"`, `simulation_step: 18`

**Geometry as measured (node tree, `observation.json` / `manifest.json` → `final_snapshot.weapon`)**:

| quantity | measured value |
|---|---|
| `WeaponHitbox` class | `Area3D` at `/root/Main/Player/Humanoid/character_root/hand_r/WeaponPivot/WeaponHitbox` |
| `WeaponHitbox` local origin **in `WeaponPivot`** | `0, 0, 0.180000007152557` |
| `WeaponHitbox/Collision` shape | `BoxShape3D`, `size: [0.449999988079071, 0.25, 1]` → half-extents `(0.225, 0.125, 0.5)` |
| `Blade` (MeshInstance3D) local origin in `WeaponPivot` | `0, 0, 0.600000023841858` (`blade_center_local_z: 0.6`) |
| `Guard` (MeshInstance3D) local origin | `0, 0, 0.0399999991059303` |
| `HitboxDebug` (MeshInstance3D) local origin | `0, 0, 0.180000007152557` — same as the hitbox |
| `WeaponPivot` world origin | `0.294999986886978, 0.879999995231628, 0` |
| `Target` | `StaticBody3D` at `0, 0, 1.20000004768372`; `Collision` = `CapsuleShape3D` `radius 0.319999992847443`, `height 1.5`, at local `0, 0.75, 0` |
| `Player` | `CharacterBody3D` at `0, 0, 0`, `rotation_degrees: [0,0,0]`, capsule `radius 0.33`, `height 1.7` |

**HUD (all PNGs, e.g. `attack-004.png`, `attack-005.png`, `final.png`)**:

```
COMBAT AUDIT
TARGET HP 3/3
ATTACKS 1  HITS 0
STATE swinging  TIMER 12            (idle  TIMER 18 in final.png)
HITBOX CENTER z=0.18   BLADE CENTER z=0.60
HITBOX SIZE z=1.00
```

The orange `HitboxDebug` box is visibly parked at the character's hip while the blade (dark bar)
sweeps past it and reaches the red target capsule — the debug mesh and the real `Area3D` are both
anchored at `z=0.18`, i.e. **0.42 m behind the blade centre**.

**So: the attack was started and animated correctly, the hit-detection query ran on ~10 separate
ticks, and every one of them measured "no overlap". The target was never touched.**

---

## 2. Most likely root cause

### Precise claim

> The weapon hitbox is anchored **0.42 m too far back along the weapon's own axis**: the
> `WeaponHitbox` `Area3D` sits at local `z = 0.18` inside `WeaponPivot`, while the blade it is
> supposed to represent has its centre at local `z = 0.60` and its tip at local `z = 1.20`.
> Because the `BoxShape3D` is only `1.0` long, the hit volume spans local `z = -0.32 … 0.68`
> and therefore never reaches the target's collision volume, which starts at world
> `z ≈ 0.88` (`Target` capsule, radius `0.32`, axis at `x = 0, z = 1.2`).
> The hitbox is effectively glued to the wrist instead of to the blade.

### What the evidence **proves**

1. **The anchor offset is `0.18`, the blade centre is `0.60`.** Both numbers are independently
   attested: the node tree gives `WeaponHitbox` local origin `0, 0, 0.180000007152557` and `Blade`
   local origin `0, 0, 0.600000023841858`; the HUD prints `HITBOX CENTER z=0.18` and
   `BLADE CENTER z=0.60` on the same line.
2. **The transforms are self-consistent with a single yaw rotation of `WeaponPivot`.** Reconstructing
   the world origin as `pivot + offset · localZ` reproduces the recorded values to 6+ digits:
   `0.295 + 0.18·sin10° = 0.326257` vs recorded `0.326256662607193`; `0.18·cos10° = 0.177265` vs
   recorded `0.177265405654907`; and likewise `0.6·sin10° = 0.399189` / `0.6·cos10° = 0.590885`
   vs the recorded `blade_center_world`. The scene model below is therefore exact, not estimated.
3. **Geometrically, the two volumes never intersect.** Sweeping the recorded swing yaw
   (derived from the event stream: `-55.0°` at `attack_start`, then `-40.6°`, `-33.3°`, `-26.1°`,
   `-18.9°`, `-11.7°`, `-8.1°` on the `attack_active` ticks, `-0.83°` at `simulation_step 15`,
   `+10.0°` in the final pose) against the fixed pivot origin, the closest the hitbox OBB ever
   comes to the target capsule's axis (`x = 0, z = 1.2`) is **0.5195 m**; the target's radius is
   **0.32 m**. The hitbox comes closest at the *most forward* pose, and is still **≈ 0.20 m short
   of the capsule surface**. In the forward (z) axis alone the hitbox reaches at most
   `z ≈ 0.705` while the target's near surface along that ray is `z ≈ 1.03`.
   The recorded `hitbox_overlap_count: 0` / `target_in_hitbox: false` is exactly what the physics
   engine must report for these transforms.
4. **The size alone cannot explain the miss, the offset can.** Keeping the anchor at `0.18` and
   enlarging the box (`z` size `1.0 → 1.2 → 1.4`) still never reaches (min distance `0.4239`,
   `0.3274` vs radius `0.32`); only `z` size `1.5` grazes in (`0.2789`) and then only over a
   narrow yaw window with ~0.003 m of margin. Moving the **anchor** to `0.60` with the size
   untouched (`1.0`) gives min distance `0.1130` and an overlap window of `-39.5° … +10°`, i.e.
   the whole active phase of the swing.

### What is **inferred** (not proven by the capture)

- That `0.18` is a *mutated* value rather than the author's original intent. Inference rests on:
  (a) the fixture's own HUD prints the hitbox centre and the blade centre side by side, which is
  a self-check that only makes sense if they are supposed to agree (or the box is meant to cover
  the blade); (b) the `HitboxDebug` mesh is anchored at the same `0.18`, so the debug visual
  confirms the offset is a single shared configuration value rather than a coincidence; (c) with
  anchor `0.18` **no reasonable box size** reaches the target, whereas with anchor `0.60` the
  observed box size `1.0` hits comfortably — so `0.60` is the self-consistent design point and
  `0.18` is the anomaly.
- The exact authored value could be `0.60` (blade centre, matching the HUD's `BLADE CENTER z=0.60`)
  or a slightly larger value such as `0.70`; anything in roughly `0.55 … 0.75` satisfies the test.
  `0.60` is the smallest change that both fixes the test and makes the debug readout coherent.

---

## 3. Smallest change that fixes it

> **Change the `WeaponHitbox` `Area3D`'s local `z` offset inside `WeaponPivot` from `0.18` to
> `0.60`** — i.e. the weapon hitbox's local position `z` goes from **`0.180000007152557` to `0.6`**,
> placing the hitbox centre on the blade centre (`Blade` local `z = 0.6`, HUD `BLADE CENTER z=0.60`).
> Leave the `BoxShape3D` size at `[0.45, 0.25, 1.0]` and leave the target at `z = 1.2`.

Why this is the minimum:

- It is a **single scalar value** in a single node.
- It needs **no change** to the shape size, the target, the animation, the collision layers, or the
  test.
- The computed result is a **0.113 m** minimum separation-vs-radius margin (`0.1130 < 0.32`), i.e. the
  hitbox penetrates the target capsule rather than grazing it, across yaw `-39.5° … +10°` — the
  whole `attack_active` window (`simulation_step 4 … 13` covers `-40.6° … -8.1°`, all of it inside
  the overlap window). Expected post-fix state: `hits: 1`, `target_health: 2`,
  `combat-hit-registers` and `combat-target-health-decreases` both pass.
- Optional cosmetic companion (not required for the test to pass): the sibling
  `WeaponPivot/HitboxDebug` `MeshInstance3D` is a **separate node** with the same local `z = 0.18`
  — move it to `0.6` as well so the orange debug box continues to visualise the real hitbox.
  If the fixture derives both from one constant/exporter, this is a one-line edit.

Deliberately *not* proposed as the minimal fix: enlarging the box (`z` size `1.0 → 1.5` needed, 50 %
growth, ~0.003 m of margin) or moving the target (a scene-layout change that also makes the blade
visually impale the target).

---

## 4. Alternatives considered, and how the evidence rules them in or out

| # | Alternative | Verdict | Evidence |
|---|---|---|---|
| 1 | **Animation / pose not playing** (weapon never swings, wrong bone, animation absent) | **Ruled out** | The blade's world position changes continuously across the run: `blade_center_world` goes `(-0.196, 0.88, 0.344)` at `attack_start` → `(0.399, 0.88, 0.591)` in the final pose, and the pivot yaw sweeps `-55° → +10°`, i.e. it passes straight through `0°` (facing the target). The final `blade_tip_world` is `(0.503, 0.88, 1.182)`. The `attack_state` cycles `idle → swinging → idle` and `attacks` increments to `1`. A static/weapon-not-animated failure would show a frozen blade and a constant hitbox origin; the hitbox origin does move every tick. |
| 2 | **Collision layer / mask mismatch** (hitbox and target on non-overlapping layers) | **Not the cause; also not fully verifiable from this capture** | No `collision_layer` / `collision_mask` / `monitoring` field is recorded for the `Area3D` or the `Target` in either `observation.json` or `manifest.json` (all `null`/absent), so the layer configuration itself is **unverified by this evidence**. But it is **not required to explain the failure**: the two volumes are separated by ≈ 0.20 m of clear space at the closest approach, so *no* layer configuration could produce an overlap. It also cannot be the whole story, because the query path clearly executes (`hitbox_overlaps: []` is an evaluated array, `last_hitbox_origin` is updated every active tick, `last_hit_distance` stays at the `-1` sentinel). A latent mask bug remains a *possible second* defect that the geometry fix would not mask — see §5. |
| 3 | **Target placed too far away** | **Ruled out** | The target is a deliberate fixture element at `z = 1.20000004768372` with a `Label3D` "TARGET / HP 3/3" and collision capsule `radius 0.32 / height 1.5`. The blade's *visual* extent already reaches it (`blade_tip_world` `z = 1.182`; at the yaw-0 frame the tip is ~`0.295` from the target axis, inside the `0.32` radius). The scene is laid out so the weapon can reach; the hitbox is the part that does not. Moving the target would also be a larger, more invasive change than a scalar edit. |
| 4 | **Hitbox shape too small** (`BoxShape3D` z-size `1.0`) | **Ruled out as the cause** | With the anchor held at `0.18`, enlarging the box to `1.2` or `1.4` still never reaches (min distance `0.4239` / `0.3274` > radius `0.32`); `1.5` barely grazes (`0.2789`) with ~0.003 m of margin. So the *size* is not the defective quantity — the *anchor* is. (The box size `1.0` is also sane for a `1.2`-long blade once it is centred at `0.6`: it spans local `z = 0.1 … 1.1`, just inside the blade's `0 … 1.2`.) |
| 5 | **Timing / hit-window sampling too sparse** (swing passes between sampled ticks) | **Ruled out** | The event stream contains **10 distinct `attack_active` records** spanning `simulation_step 4 … 13`, each independently reporting `hitbox_overlap_count: 0` and `target_in_hitbox: false`. The miss is persistent across the entire active window, not a single missed frame. Furthermore the closest approach happens at the *end* of the swing (largest forward reach, `+10°`), so even a perfectly-timed check would fail. |
| 6 | **Hitbox disabled / shape disabled / Area3D not monitoring / not in tree** | **Ruled out** | `WeaponHitbox/Collision` is reported with `disabled: false`; the `Area3D` has a live global transform that updates every tick with the swing; the `BoxShape3D` size is read successfully (`[0.45, 0.25, 1]`); `hitbox_overlaps` is an evaluated (empty) array rather than missing data. |
| 7 | **Player not facing the target / wrong axis** | **Ruled out** | `Player.position = [0,0,0]`, `Player.rotation_degrees = [0,0,0]`, target directly ahead at `+z`; the pivot yaw passes through `0°` during the active window, i.e. the weapon is pointed at the target for a substantial part of the swing. |
| 8 | **Hit detection tests a point rather than the shape** (so a correctly-placed box would still miss) | **Not excluded, but irrelevant** | `target_in_hitbox` and `hitbox_overlaps` are consistent with either implementation. It is not needed to explain the failure — the shape-based test also fails — but it is the one unknown that could keep the test red *after* the geometry fix, which is why §5 asks for the layer/mask and query-type details. |

---

## 5. Confidence and what would raise it

**Confidence: high (~0.85) for the root cause and the fix.**

Supporting: three independent evidence channels agree (node transforms, HUD readout, event
stream); the reconstructed scene model reproduces the recorded transforms to 6+ significant
digits; the geometric model predicts the observed `hitbox_overlap_count: 0` on every active tick;
and the counterfactual sweep shows that *only* the anchor offset can explain the miss with a
one-value change.

Residual uncertainty (≈0.15), in decreasing order of weight:

1. **Collision layers/masks are not captured** (alternative 2). If the `Area3D`'s mask excludes
   the target's layer, the fix above could still leave `hits: 0` — an independent second defect
   that this evidence cannot exclude.
2. **The original authored value is inferred, not observed.** `0.60` is the best-supported
   candidate (it equals the blade centre and the HUD's `BLADE CENTER z=0.60`), but `0.55 … 0.75`
   would all pass; a value outside that range would not.
3. **The hit-detection query type is unknown** (shape-cast vs overlap vs analytic test), so the
   exact tick at which the hit registers cannot be predicted with certainty — only that it
   registers during `attack_active`.

**Additional evidence that would raise confidence to ≈0.95+:**

- Runtime dump of `WeaponHitbox.collision_layer` / `collision_mask` and
  `Target.collision_layer` (plus `Area3D.monitoring` / `monitorable`) — currently absent from the
  capture and the one genuine blind spot.
- The fixture's configuration value that sets the hitbox anchor (and whether `HitboxDebug` shares
  it) — would confirm the edit is a genuine one-liner and settle the exact original value.
- A re-run after the change showing `target_in_hitbox: true` and `hitbox_overlap_count ≥ 1` on at
  least one `attack_active` event, with `hits: 1` and `target_health: 2` in the final snapshot
  and `PASS` for both failing checks.
- A per-tick dump of the hitbox-to-target separation during the swing (e.g. the same
  `attack_active` payload with a distance field) — would directly confirm the predicted
  0.113 m penetration and the `-39.5° … +10°` overlap window.
