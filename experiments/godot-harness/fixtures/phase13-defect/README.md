# Phase 13 diagnosis fixture

This fixture is a **copy of `fixtures/observation`** that exists only as the target of the Phase 13
evidence-driven diagnosis benchmark. It is not a new character, a new mechanic, or a change to
any earlier fixture.

## Why it exists

The Phase 13 benchmark needs a defect that is:

- reproducible from a clean checkout,
- isolated from every Phase 8–12 fixture and every committed evidence bundle,
- diagnosable from a source-free evidence bundle, and
- fixable with the smallest possible change.

Copying the observation fixture gives a real scene with a real character, a real pressure plate, a
real gate, a real event stream, and an existing 8-case acceptance suite — with none of that
duplicated as new logic.

## The controlled defect

The pressure plate's `body_entered` handler must ignore every body **except** the player. The
defect inverts that comparison, so the plate discards the one body it is supposed to react to:

```gdscript
# scripts/observation_world.gd, _on_plate_body_entered
-	if not is_instance_valid(player) or body != player or plate_pressed:
+	if not is_instance_valid(player) or body == player or plate_pressed:
```

Consequence: the plate never registers a press, the gate never opens, the beacon never turns
green, and the goal is never reached. The acceptance suite fails 2 of 8 cases.

## Current state: repaired

The committed state of this fixture is **repaired**. The defect was injected, diagnosed from
evidence by an external agent, and fixed in Phase 13. After the repair every file here is
byte-identical to `fixtures/observation` except `project.godot`, which carries a different
`config/name`, and the generated `artifacts/` directory.

## Reproducing the benchmark

The defect is managed by the benchmark runner. It refuses to act unless exactly one occurrence of
the target line is present, so a silent no-op is impossible.

```powershell
cd experiments/godot-harness

# current state
node controller/diagnosis-benchmark.mjs status

# put the defect back, and confirm it breaks the suite (expect 6/8, exit 1)
node controller/diagnosis-benchmark.mjs inject

# collect the evidence bundle for a diagnosing agent (expect the suite to fail)
node controller/diagnosis-benchmark.mjs prepare --out-dir <output-dir>

# ... the agent writes its diagnosis and applies the fix ...

# confirm the repair and capture the after state (expect 8/8, exit 0)
node controller/diagnosis-benchmark.mjs verify --out-dir <output-dir>

# restore the repaired state
node controller/diagnosis-benchmark.mjs repair
```

The output directory is configurable and defaults to a unique directory under
`docs/phase13/artifacts/`. Writing into a protected Phase 8–12 evidence directory is refused by
`controller/evidence-output.mjs`.

## The acceptance suite

`tests/run_observation.gd` is **byte-identical** to `fixtures/observation/tests/run_observation.gd`.
It is the oracle for the benchmark and must not be modified: a repair that changes it proves
nothing.

## Provenance

- Created for Phase 13 by copying `fixtures/observation`.
- The defect was injected by a script that asserts exactly one occurrence of the target line was
  replaced.
- The diagnosis, the repair, and the before/after evidence are in
  `docs/phase13/stage-c-diagnosis/`, and the analysis is in
  `docs/phase13/diagnosis-benchmark.md`.
