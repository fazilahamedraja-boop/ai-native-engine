# Phase 13 — Evidence-driven diagnosis benchmark (Stage C)

Runner: `experiments/godot-harness/controller/diagnosis-benchmark.mjs`
Fixture: `fixtures/phase13-defect` (new, dedicated to this phase)
Evidence: `docs/phase13/stage-c-diagnosis/`

## 1. The defect

`fixtures/phase13-defect` is a copy of the Phase 10 observation fixture with one injected
one-line defect in the pressure plate's body-entered handler:

```gdscript
# scripts/observation_world.gd, _on_plate_body_entered
-	if not is_instance_valid(player) or body != player or plate_pressed:
+	if not is_instance_valid(player) or body == player or plate_pressed:
```

The comparison is inverted, so the plate discards the one body it is supposed to react to — the
player — and would only ever react to a foreign body. The plate never registers a press, so the
gate never opens, so the player cannot reach the goal.

The copy was made with a script that asserts exactly one occurrence of the target line is
replaced, so the injection is deterministic and auditable. No Phase 8–12 fixture was modified.

## 2. Pre-repair failure

```
node controller/harness.mjs test --project fixtures/phase13-defect --script res://tests/run_observation.gd --json
```

`exitCode: 1`, `RESULT passed=6 failed=2`:

```
FAIL observation-plate-opens-gate plate=false gate=false collision=true beacon=red events=["reset", "player_collision_start", "crate_collision_start"]
FAIL observation-gate-passable-after-plate goal=false z=-1.950 events=["reset", "player_collision_start", "crate_collision_start", "player_collision_start", "player_collision_end"]
```

## 3. The evidence bundle

`diagnosis-benchmark.mjs prepare` produced a bundle containing **no source code, no diff, and no
answer key**. The agent was given the task description in `task.md` and the five evidence files
below, and was explicitly barred from opening the fixture source until its diagnosis file
existed.

| File | Content |
| --- | --- |
| `evidence/test-output.txt` | the failing acceptance-test output, including the full trace |
| `evidence/state.json` | the fixture snapshot at the moment of the capture |
| `evidence/observation.json` | structured node observations, properties, collision shapes, layer/mask, and the full event stream |
| `evidence/physics-queries.json` | two physics-space box queries (plate volume, gate volume) |
| `evidence/frame-on-plate.png` | a fresh windowed screenshot of the running game |

The decisive observation is the **contradiction between the physics query and the fixture
state**:

```
physics query over the plate volume (0, 0.10, -1.1):
  /root/Main/Ground    StaticBody3D
  /root/Main/Player    CharacterBody3D     <-- the player IS inside the plate volume

fixture state at the same instant:
  player_position      [0, 0.85, -0.166664153337479]
  plate_pressed        false
  gate_open            false
  beacon_state         "red"
  feedback             "PLATE CLEAR - GATE CLOSED"
  prompt               "WALK ONTO THE PLATE"

event stream:  reset, player_collision_start, crate_collision_start
               (no plate event of any kind)

observe -> /root/Main/Plate -> collision:
  collision_layer 1, collision_mask 1, monitoring true, monitorable true, source "measured"
```

The player physically occupies the plate volume; the plate's detector is armed, on the right
layer, watching the right body; and the plate still reports itself clear. That is a falsifiable
claim, and it is the observation the Phase 11 blind diagnosis could not make — which is exactly
what the Phase 12 physics query was added for.

## 4. The agent's diagnosis

`diagnosis.md` was written by the diagnosing agent from the evidence alone. It states:

> The pressure plate's `body_entered` handler discarded the player itself, so the plate never
> registered, the gate never opened, and the player was blocked at `z=-1.95`.

Its contradiction section names precisely the two conflicting observations quoted above, and it
rules out, with evidence: the plate being disabled or mis-layered, the player being on the wrong
layer, the player never reaching the plate, the gate being the broken component, the observer
misreporting, and the crate or humanoid probe regressing.

**An honest limit the agent reported.** It explicitly declined to name the exact defect site from
the evidence alone:

> The evidence proves the *symptom* (armed detector, overlapping body, no event) and therefore
> that the plate's detection geometry or its signal wiring is broken, but the evidence alone
> cannot distinguish (a) a collision shape that is disabled/degenerate/mis-sized/mis-positioned
> relative to the pad from (b) a `body_entered` connection that is missing or wired to the wrong
> node. Reading the fixture source is required to name the single line.

That is the correct answer for the evidence available. The physics query narrows the fault to the
plate's detection path, but it cannot distinguish *where* in that path the fault is.

### Ordering proof

The diagnosis was required to be written before the source was opened, and the ordering was
verified from the filesystem:

| Artifact | Modified |
| --- | --- |
| `diagnosis.md` | 02:11:21 |
| `fixtures/phase13-defect/scripts/observation_world.gd` | 02:14:27 |
| `repair.md` | 02:16:36 |

The diagnosis precedes the first source modification by more than three minutes. The evidence
files were all last written at 02:01:30–02:01:35, before the agent session began, and their
hashes are unchanged, so the agent did not edit its own evidence.

## 5. The repair

After writing the diagnosis, the agent read the source and found the one-operator inversion. Its
repair record (`repair.md`) notes the corroborating detail that pinned the intended relation: the
sibling handler `_on_plate_body_exited` already used `body != player`.

```diff
--- a/experiments/godot-harness/fixtures/phase13-defect/scripts/observation_world.gd
+++ b/experiments/godot-harness/fixtures/phase13-defect/scripts/observation_world.gd
@@ _on_plate_body_entered(body: Node3D) -> void:
-	if not is_instance_valid(player) or body == player or plate_pressed:
+	if not is_instance_valid(player) or body != player or plate_pressed:
```

**Scope audit.** After the repair, every file in `fixtures/phase13-defect` was compared with the
pristine `fixtures/observation`:

| File | Result |
| --- | --- |
| `scripts/observation_world.gd` | **identical** to the pristine fixture — the one-operator fix restored it exactly |
| `tests/run_observation.gd` | **identical** — the oracle was not weakened |
| `harness/bridge.gd`, `scripts/observation_player.gd`, `scripts/humanoid_probe.gd`, `assets/humanoid-01.glb`, `main.tscn` | **identical** |
| `project.godot` | differs only in `config/name` (`godot-phase13-defect-fixture`), which the fixture-creation script sets |
| `artifacts/` | generated PNGs only |

The acceptance script is byte-identical, no expected value was hard-coded, and no gameplay rule
was added.

## 6. Post-repair result

The **same** command, unchanged:

```
node controller/harness.mjs test --project fixtures/phase13-defect --script res://tests/run_observation.gd --json
```

`exitCode: 0`, `RESULT passed=8 failed=0`, no errors or warnings:

```
PASS observation-initial-state plate=false gate=false collision=true beacon=red grounded=true position=[0.0, 0.85, 5.5]
PASS observation-plate-opens-gate plate=true gate=true collision=false beacon=green events=[..., "plate_entered", "gate_open"]
PASS observation-gate-passable-after-plate goal=true z=-7.112 events=[..., "plate_exited", "gate_close", "goal_reached"]
PASS observation-closed-gate-blocks plate=false gate=false z=-1.950 gate_collision_seen=true
PASS observation-event-stream count=5 ordered=true fields_ok=true
PASS observation-reset step=0 plate=false gate=false beacon=red crate_y=2.992 last_event=reset
PASS observation-humanoid-probe mesh_count=22 bones=["root", "spine", "chest", "head"]
PASS observation-crate-falls crate_y=0.347 ground_collision=true sleeping=true
```

### Verified runtime change

`diagnosis-benchmark.mjs verify` re-ran the identical live scenario and captured the after
state:

| Quantity | Before | After |
| --- | --- | --- |
| Acceptance suite | 6/8 (exit 1) | **8/8 (exit 0)** |
| `plate_pressed` | false | **true** |
| `gate_open` | false | **true** |
| `gate_collision_enabled` | true | **false** |
| `beacon_state` | red | **green** |
| `feedback` | `PLATE CLEAR - GATE CLOSED` | **`PLATE PRESSED`** |
| Event stream | `reset, player_collision_start, crate_collision_start` | `…, plate_entered, gate_open` |
| Plate-volume physics query | Ground + **Player** | Ground + **Player** (unchanged) |

The last row is the important one: **the physics did not change**. The player occupied the plate
volume before and after. What changed is that the fixture now reacts to a fact that was already
true. That is precisely the distinction the physics query exists to make, and it is why the
agent could rule out "the player never reached the plate".

The after screenshot (`evidence/frame-after-repair.png`) shows the same viewpoint and the same
player position as the before frame, with `PLATE: PRESSED  GATE: OPEN  BEACON: GREEN  EVENTS: 5`
in the HUD and the gate visibly raised.

## 7. Did the AI genuinely choose the diagnosis?

**Yes for the diagnosis; the harness did not provide one.**

- The evidence bundle contains no source, no diff, and no answer key. Its file list is fixed by
  `task.md` and contains only the five evidence files.
- The diagnosis was written before the source was opened, verified by file modification time.
- The agent's diagnosis identified the defect *class* from the evidence alone and explicitly
  declined to name the exact line, saying the source was required for that. It then read the
  source and found the line.
- The repair was applied by the agent, and the agent ran the test itself.

**What was not autonomous.** The *orchestration* is manual. The harness has no agent-facing entry
point: it cannot spawn an agent, hand it the bundle, and read back a decision. In this phase the
bundle was handed to an external agent session and its written output was read back. Everything
the agent needed was in machine-readable files, so this step is automatable, but the automation
does not exist and is not claimed. See
[`capability-inventory.md`](capability-inventory.md) §3.

## 8. Remaining uncertainty

- The defect is a single operator inversion, which is a favourable case for an evidence-driven
  diagnosis. A defect whose symptom matches several causes would need a different evidence
  bundle — most likely a physics query parameter set that distinguishes area overlap from body
  overlap, which the current bridge does not expose.
- The diagnosis benchmark ran **once**. There is no measured distribution over repeated runs and
  no comparison against a no-evidence baseline, so this shows the loop works once, not that it
  is reliable.
- The pre-repair bundle was produced by the same runner that produced the after bundle. A bundle
  produced by a different capture path would be a stronger test.
