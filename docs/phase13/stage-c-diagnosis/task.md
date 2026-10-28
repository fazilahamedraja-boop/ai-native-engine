# Phase 13 diagnosis task

A Godot game scene is failing its acceptance suite. You are given the failing
test output, fresh screenshots of the running game, the structured runtime
state, the recorded event stream, and physics-space query results.

Your job:

1. State a **falsifiable diagnosis** that is supported by the collected
   evidence. Name the specific contradiction you can see in the data.
2. Identify the **smallest proposed correction**.
3. Implement that correction in the isolated worktree.
4. Run the **same acceptance test** that failed before the repair and show it
   now passes.
5. Verify the expected runtime change.

## What you may read

Only the evidence files in this directory:

- `C:\Users\<user>\ai-native-engine-phase13\docs\phase13\stage-c-diagnosis/evidence/test-output.txt` - the failing acceptance test output
- `C:\Users\<user>\ai-native-engine-phase13\docs\phase13\stage-c-diagnosis/evidence/observation.json` - structured runtime state and events
- `C:\Users\<user>\ai-native-engine-phase13\docs\phase13\stage-c-diagnosis/evidence/physics-queries.json` - physics-space query results
- `C:\Users\<user>\ai-native-engine-phase13\docs\phase13\stage-c-diagnosis/evidence/frame-on-plate.png` - a fresh screenshot of the running game
- `C:\Users\<user>\ai-native-engine-phase13\docs\phase13\stage-c-diagnosis/evidence/state.json` - the fixture snapshot at that moment

## What you must not read before diagnosing

The fixture source under `experiments/godot-harness/fixtures/phase13-defect/`
contains the defect. **Do not open it until you have written your diagnosis.**

Write your evidence-only diagnosis to:

- `C:\Users\<user>\ai-native-engine-phase13\docs\phase13\stage-c-diagnosis/diagnosis.md`

That file must start with the H1 title "# Phase 13 diagnosis" and must contain:

- **Failure** - what failed, quoting the specific evidence values
- **Contradiction** - the falsifiable claim, and which two observations conflict
- **Hypotheses ruled out** - alternatives and the evidence that excludes them
- **Proposed correction** - the smallest change you intend to make
- **Confidence** - and what extra evidence would raise it

Only after `diagnosis.md` exists may you read the fixture source, locate the
defect, apply the fix, and re-run the test.

## Commands

```powershell
cd C:\Users\<user>\ai-native-engine-phase13\experiments\godot-harness
node controller/harness.mjs test --project fixtures/phase13-defect --script res://tests/run_observation.gd --json
```

The fixture is `fixtures/phase13-defect`. The acceptance script is
`res://tests/run_observation.gd` and must not be modified.
