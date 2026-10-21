# Stage C — one controlled combat defect, diagnosed from evidence and repaired

**Worktree:** `C:\Users\hacke\ai-native-engine-phase11`
**Branch:** `experiment/phase11-audit` (baseline `e72ba64`)
**Fixture:** `experiments/godot-harness/fixtures/combat`
**Runner:** `experiments/godot-harness/controller/combat-defect.mjs`
**Evidence bundle:** `docs/phase11/stage-c/`

---

## 1. What this stage did, and what it deliberately did not do

The stage answers one question: **can the existing harness evidence be enough for an agent to
diagnose a real character/combat defect, fix it minimally, and prove the fix with an identical
test?**

- It did **not** create a skeleton, a rig, a new character, or a combat/AI framework.
- It did **not** implement character intelligence, behaviour trees, targeting, or navigation.
- It reused the existing repository humanoid `humanoid-01.glb` (rigid, no skin) exactly as shipped.
- It built one small deterministic fixture around that humanoid, injected **one** one-line data
  defect into a **copy** of the fixture, diagnosed the defect from captured evidence, restored the
  single line, and re-ran the **byte-identical** test (`sha256 93cbb7d5…e88ed2` in both runs).

### The fixture (all new code under `fixtures/combat/`)

| Piece | What it is | Why |
| --- | --- | --- |
| `Player` | `CharacterBody3D` (layer 1) + the existing `humanoid-01.glb` as a child | real physics body, real project asset |
| `WeaponPivot` | child of the existing `hand_r` node, `rotY` −55° → +10° | weapon follows the shipped hand transform, no rig needed |
| `Blade` | `BoxMesh` 1.2 long, centre at local z = 0.60 | the **visible** weapon |
| `WeaponHitbox` | `Area3D` + `BoxShape3D` (0.45 × 0.25 × 1.00) at local z = `HITBOX_CENTER_LOCAL` | the **measured** weapon volume |
| `HitboxDebug` | translucent red box at the same local z | makes the hitbox visible in captures |
| `Target` | `StaticBody3D` (layer 2) + capsule shape r = 0.32, h = 1.5 at z = 1.2 | a real, separate collision body |
| HUD | `Label` with `HITBOX CENTER z=…`, `BLADE CENTER z=…`, `HITBOX SIZE z=…`, HP, attacks, hits | the visual half of the evidence |
| events | fixture-recorded `attack_start` / `attack_active` / `hit` / `hitbox_body_entered` | the structured half of the evidence |

The swing is 18 fixed physics steps, active window steps 4–13. The hitbox centre is one constant,
`HITBOX_CENTER_LOCAL`, so the defect and the repair are both a single number.

---

## 2. Setup corrections made *before* the controlled defect (reported for honesty)

Two fixture problems were found and fixed **before** any defect was injected. They are part of the
result, not hidden from it.

### 2.1 `Area3D.monitorable = false` silently blanked the overlap list

Symptom: `hitbox.get_overlapping_bodies()` returned `[]` even when the hitbox was moved onto the
target's centre, and even with `collision_mask` set to the target's layer.

Probe (`fixtures/combat/tests/probe_collision.gd`, run with
`godot --headless --path fixtures/combat -s res://tests/probe_collision.gd`; saved output in
[`stage-c/monitorable-probe.txt`](stage-c/monitorable-probe.txt)):

```
target global=[… O: (0.0, 0.0, 1.2)]
target shape global=[… O: (0.0, 0.75, 1.2)]  disabled=false
target layer=2 mask=0
hitbox parent=/root/Main/Player/Humanoid/character_root/hand_r/WeaponPivot
hitbox layer=0 mask=2 monitoring=true monitorable=true
A fixture area, monitorable=false -> []
B freshly built area, same spot  -> [Target:<StaticBody3D#…>]
C fixture area, monitorable=true  -> [Target:<StaticBody3D#…>]
D direct space-state query        -> 1 hit(s)
   collider=Target:<StaticBody3D#…> shape=0
```

A freshly constructed `Area3D` at the same position *did* overlap the target, and a direct
`PhysicsDirectSpaceState3D.intersect_shape` query found it, so the target's collider was active
and the physics space was fine. The only difference between the working area and the fixture area
was `monitorable`: with it off the fixture area reported nothing (line A), with it on it reported
the target (line C).

Fix: `hitbox.monitorable = true` (`fixtures/combat/scripts/combat_world.gd:168`).

> **Audit-relevant fact.** `monitorable` is documented as controlling whether *other* areas can
> detect this one. In Godot 4.7.2 the same flag also gates this area's own
> `get_overlapping_bodies()` result. An agent that only reads the class documentation would have
> concluded "the collider is missing"; the probe showed the collider was present and the *query*
> was suppressed. This is a genuine trap and is recorded as such in Stage D.

### 2.2 The first defect attempt was not actually a defect

With the original geometry (hitbox length 1.30, target at z = 1.0), lowering the hitbox centre
from 0.60 to 0.18 **still hit** the target: the box still reached the target's front surface, and
the acceptance test still passed 3/3 in the "defective" run. A defect that does not change the
outcome is not a defect, so the fixture geometry was widened to make the two states separable:

- hitbox length 1.30 → **1.00** (`HITBOX_SIZE`),
- target position z 1.0 → **1.2** (`target.position`).

Both changes are in the baseline fixture; the baseline was re-verified as passing 3/3 afterwards.

---

## 3. The controlled defect

One constant in `fixtures/combat/scripts/combat_world.gd`:

```gdscript
-const HITBOX_CENTER_LOCAL := Vector3(0.0, 0.0, 0.18)   # defective copy
+const HITBOX_CENTER_LOCAL := Vector3(0.0, 0.0, 0.60)   # baseline / repaired
```

Patch file: `docs/phase11/stage-c/repair.diff`.

| | source sha256 |
| --- | --- |
| baseline fixture | `775443656fefde6dbe711077b5471a27e0d9b5a469fd03abe320bacf7896a8c3` |
| defective copy | `e5e66f2a4363ee0b2626644f60ac2019154dac0bea2e5a5c5f6c8cf0d9cd7e94` |
| after repair | `775443656fefde6dbe711077b5471a27e0d9b5a469fd03abe320bacf7896a8c3` |

The repaired file hash equals the baseline file hash byte-for-byte: the repair restored the fixture
exactly, it did not "fix" it by editing around the defect.

The runner (`controller/combat-defect.mjs`) copies the fixture to a temporary project, injects the
defect with an exact-string replacement (asserting exactly one match), runs the headless test,
runs the windowed capture scenario, then restores the line and repeats the identical steps in the
same copy.

---

## 4. "Before" evidence (defective copy)

### 4.1 Structured

Test (`docs/phase11/stage-c/before/test.json`, exit code 1):

```
combat-attack-started          passed=true   attacks=1 expected=1
combat-hit-registers           passed=false  hits=0 expected=1 target_health=3
combat-target-health-decreases passed=false  target_health=3 expected=2
```

Event stream (`docs/phase11/stage-c/before/observation.json`), 13 events, no `hit` and **no
`hitbox_body_entered` at all**:

| step | event | data |
| --- | --- | --- |
| 0 | `reset` | — |
| 1 | `attack_start` | `blade_center_local_z=0.6`, `hitbox_center_local=[0,0,0.18]`, `hitbox_global_origin=[-0.196, 0.88, 0.344]` |
| 4–13 | `attack_active` ×10 | `hitbox_overlap_count=0`, `target_in_hitbox=false` (every sample) |
| 18 | `attack_end` | — |

Final snapshot (`docs/phase11/stage-c/before/snapshot.json`):

```json
"combat": { "attacks": 1, "hits": 0, "target_health": 3, "attack_state": "idle" },
"weapon": {
  "blade_center_local_z": 0.6,
  "hitbox_center_local": [0, 0, 0.18],
  "hitbox_center_world": [0.3263, 0.88, 0.1773],
  "blade_center_world":  [0.3992, 0.88, 0.5909],
  "hitbox_shape_size": [0.45, 0.25, 1.0],
  "hitbox_overlaps": [],
  "target_in_hitbox": false
}
"target": { "center": [0, 0.75, 1.2], "health": 3, "collision_shape": [0.32, 1.5] }
```

### 4.2 Visual

`docs/phase11/stage-c/before/attack-002.png` (step 6, mid-swing):

```
COMBAT AUDIT
TARGET HP 3/3
ATTACKS 1   HITS 0
STATE swinging   TIMER 6
HITBOX CENTER z=0.18   BLADE CENTER z=0.60
HITBOX SIZE z=1.00
```

The translucent red hitbox volume sits at the wrist, while the pale blade mesh passes straight
through the red target capsule. The target stays red (no hit flash).

---

## 5. Diagnosis from the evidence alone

### 5.1 What the evidence proves

1. The attack **ran**: `attacks = 1`, `attack_start` and ten `attack_active` samples exist, the
   swing transform moved (`hitbox_global_origin` changes every step).
2. The hit **never registered**: no `hitbox_body_entered` signal and `hitbox_overlap_count = 0` in
   all ten active samples, so the area and the target were never in contact at any sampled step.
3. The weapon's **measured volume** and its **visible geometry** disagreed: `hitbox_center_local`
   was `[0, 0, 0.18]` while `blade_center_local_z` was `0.6` — a 0.42 local-z separation, printed
   live in the HUD of every capture.
4. The target itself was healthy and correctly placed: `target.center = [0, 0.75, 1.2]`, capsule
   r = 0.32, h = 1.5, health 3/3, never entered by the area.

### 5.2 Root cause

**The weapon's collision volume was not attached to the weapon's geometry.** The hitbox `Area3D`
was positioned at local z = 0.18 while the blade it is supposed to represent is centred at local
z = 0.60, so the measured volume sat 0.42 units back at the wrist and never reached the target,
even though the visible blade did.

### 5.3 Why the geometry makes the miss certain (arithmetic on measured values)

The pivot is at world `(0.295, 0.88, 0)`; the swing rotates it by θ from −55° to +10°. The hitbox
is a box of half-extents `(0.225, 0.125, 0.5)` whose centre sits at local z = c, so its furthest
world z over the swing is

```
z_max(θ, c) = c·cosθ + 0.225·|sinθ| + 0.5·cosθ
```

The target capsule's front surface sits at `1.2 − 0.32 = 0.88`.

| c | θ = −40.6° (first active step) | θ = +10° (last) | max over the swing |
| --- | --- | --- | --- |
| **0.18 (defective)** | 0.663 | 0.709 | **0.709 < 0.88 → never reaches** |
| **0.60 (baseline)** | 0.981 | 1.122 | 1.122 > 0.88 → overlaps |

So the defective volume provably cannot touch the target at any point of the swing, while the
baseline volume overlaps it. This matches the measured events exactly.

### 5.4 Alternatives considered and ruled out

| Hypothesis | Ruled out by |
| --- | --- |
| The attack never fired | `attack_start` + 10 `attack_active` events, `attacks = 1`, HUD `STATE swinging` |
| Wrong timing window | the whole window (steps 4–13) shows overlap count 0; the baseline hits inside the same window with the same clock |
| Target on the wrong collision layer / mask | layer 2, mask 2, and the baseline hits through the exact same layer/mask pair; §2.1 shows a mask/layer change alone did not create the overlap |
| Target collider missing or disabled | `target shape global … disabled=false`; a direct physics-space query found the collider |
| Swing animation/pose broken | the pivot transform advances monotonically in every sample; the baseline reaches the same angles and hits |
| Target moved out of reach | target centre is identical in the before and after runs (`[0, 0.75, 1.2]`); only the hitbox constant differs |
| The overlap query was suppressed (as in §2.1) | `monitorable = true` in both runs, and the after run reports `hitbox_overlaps: ["/root/Main/Target"]` with the same code path |

### 5.5 Smallest repair

Restore the single constant to the blade's own centre:

```gdscript
const HITBOX_CENTER_LOCAL := Vector3(0.0, 0.0, 0.60)
```

Nothing else changes: no collision layer, no mask, no shape size, no timing, no test change.

### 5.6 Independent blind confirmation

The "before" bundle was then handed to a separate agent with an explicit read allow-list (the
manifest, observation, snapshot, test output and PNGs from `docs/phase11/stage-c/before/` only).
It was barred from the fixture source, the "after" bundle, the repair diff, and every prior Phase 11
document.

It reached the **same root cause** — hitbox anchored at local z 0.18 against a blade centred at
0.60, so the hit volume never reaches the target capsule (it measured ≈0.20 m of clear space at the
closest approach over the whole swing) — and the **same minimal fix** (local z 0.18 → 0.60), with
the same counterfactual check that enlarging the box instead would not work (it needs z-size 1.5,
a 50 % growth, to graze in with ~3 mm of margin).

Its residual uncertainty was different from mine and proved the more valuable: it **could not
exclude a collision layer/mask mismatch**, because the harness's `observe` output does not publish
`collision_layer` / `collision_mask` for observed collision objects. That gap is carried into
Stage D §2.2 and into the recommended next task.

Full text: [`stage-c/blind-diagnosis.md`](stage-c/blind-diagnosis.md).

---

## 6. "After" evidence (same copy, one line restored, identical test)

### 6.1 Structured

Test (`docs/phase11/stage-c/after/test.json`, exit code 0), **same script, same sha256**:

```
combat-attack-started          passed=true   attacks=1 expected=1
combat-hit-registers           passed=true   hits=1 expected=1 target_health=2
combat-target-health-decreases passed=true   target_health=2 expected=2
```

Event stream (`docs/phase11/stage-c/after/observation.json`), 14 events:

| step | event | data |
| --- | --- | --- |
| 1 | `attack_start` | `hitbox_center_local=[0,0,0.6]`, `blade_center_local_z=0.6` |
| 4 | `attack_active` | `hitbox_overlap_count=0`, `target_in_hitbox=false` |
| 5 | `attack_active` | `hitbox_overlap_count=0`, `target_in_hitbox=false` |
| 5 | `hitbox_body_entered` | target entered the area |
| 6 | `hit` | `damage=1`, `target_health=2`, `hitbox_target_distance=1.124` |
| 7–13 | `attack_active` | (no further hit; one hit per swing) |
| 18 | `attack_end` | — |

Final snapshot (`docs/phase11/stage-c/after/snapshot.json`):

```json
"combat": { "attacks": 1, "hits": 1, "target_health": 2 },
"weapon": {
  "hitbox_center_local": [0, 0, 0.6],
  "hitbox_center_world": [0.3992, 0.88, 0.5909],
  "blade_center_world":  [0.3992, 0.88, 0.5909],
  "hitbox_overlaps": ["/root/Main/Target"],
  "target_in_hitbox": true
}
```

Note the visible consequence: `hitbox_center_world` and `blade_center_world` are now the **same
vector** — the measured volume and the drawn blade coincide, which is exactly the invariant the
defect broke.

**One-step detection latency.** The area's overlap list became non-empty one physics step *after*
the `body_entered` signal was emitted (signal at step 5, first `_check_hit` that observed the
overlap at step 6). This is an observed property of Godot's area detection ordering, not a
property of the defect, and it is why the hit lands on step 6 rather than step 4.

### 6.2 Visual

`docs/phase11/stage-c/after/attack-002.png` (same step 6, same camera, same input):

```
COMBAT AUDIT
TARGET HP 2/3
ATTACKS 1   HITS 1
STATE swinging   TIMER 6
HITBOX CENTER z=0.60   BLADE CENTER z=0.60
HITBOX SIZE z=1.00
```

The target is now yellow (hit flash) and its label reads `TARGET HP 2/3`; the translucent hitbox
volume has moved forward onto the blade instead of sitting at the wrist.

Full frame series (every 3 fixed physics ticks) for both runs:
`docs/phase11/stage-c/before/attack-000.png … attack-006.png` and the same under `after/`.

---

## 7. Reproduce

```powershell
# baseline fixture (must be 3/3)
node controller/harness.mjs test --project fixtures/combat --script res://tests/run_combat.gd --json

# full controlled-defect run: inject → capture → repair → capture
node controller/combat-defect.mjs
```

`controller/combat-defect.mjs` writes `docs/phase11/stage-c/` and prints:

```
before: 1 passed / 2 failed   hits=0  health=3  hitbox_local_z=0.18
after : 3 passed / 0 failed   hits=1  health=2  hitbox_local_z=0.60
same_test_sha256: 93cbb7d53e18cb3ecf6fbc3c9ad488ed041c1383e7a450900578ab6314e88ed2
```

---

## 8. Limits of this stage

- One fixture, one defect, one swing. It proves the *method* works end to end, not that the harness
  can characterise arbitrary combat bugs.
- The `hitbox_target_distance` metric is measured to the target's **body origin**, not its capsule
  centre, so it is a bookkeeping number, not a geometric distance. It was **not** used in the
  diagnosis.
- The target, HUD, debug mesh, and event stream are fixture-authored. The harness still cannot
  observe arbitrary engine events; it can only read what a fixture chooses to publish.
- The stage made no claim about the project's own game: `humanoid-01.glb` has no skin and no
  animation, so this fixture proves the harness can measure a weapon attached to a rigid hand, not
  that the project has combat.
