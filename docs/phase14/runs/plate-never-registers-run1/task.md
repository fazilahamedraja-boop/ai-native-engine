# Phase 14 blind diagnosis task

A Godot game scene is failing its acceptance suite. You are given the failing
test output, a fresh screenshot of the running game, the structured runtime
state, the recorded event stream, and physics-space query results.

Your job:

1. State a **falsifiable diagnosis** supported by the collected evidence. Name
   the specific contradiction you can see in the data.
2. Identify the **smallest proposed correction**.
3. Implement that correction in the isolated fixture.
4. Run the **same acceptance test** that failed before the repair and show it
   now passes.
5. Verify the expected runtime change.

## What you may read

Only the evidence files in this directory:

- `C:\Users\<user>\ai-native-engine-phase14\docs\phase14\runs\plate-never-registers-run1/evidence/test-output.txt` - the failing acceptance test output
- `C:\Users\<user>\ai-native-engine-phase14\docs\phase14\runs\plate-never-registers-run1/evidence/observation.json` - structured runtime state and events
- `C:\Users\<user>\ai-native-engine-phase14\docs\phase14\runs\plate-never-registers-run1/evidence/physics-queries.json` - physics-space query results
- `C:\Users\<user>\ai-native-engine-phase14\docs\phase14\runs\plate-never-registers-run1/evidence/state.json` - the fixture snapshot at that moment
- `C:\Users\<user>\ai-native-engine-phase14\docs\phase14\runs\plate-never-registers-run1/evidence/before.png` - a fresh screenshot of the running game

## What you must not read before diagnosing

- The fixture source under `C:\Users\<user>\AppData\Local\Temp\phase14-blind-observation-e6DJQT\project` contains the defect.
  **Do not open it until you have written your diagnosis.**
- `experiments/godot-harness/controller/blind-cases.mjs` is the answer key.
  **Do not open it at all.**

Write your evidence-only diagnosis to:

- `C:\Users\<user>\ai-native-engine-phase14\docs\phase14\runs\plate-never-registers-run1/diagnosis.md`

That file must start with the H1 title "# Phase 14 blind diagnosis" and must contain:

- **Failure** - what failed, quoting the specific evidence values
- **Contradiction** - the falsifiable claim, and which two observations conflict
- **Hypotheses ruled out** - alternatives and the evidence that excludes them
- **Proposed correction** - the smallest change you intend to make
- **Confidence** - and what extra evidence would raise it

Only after `diagnosis.md` exists may you read the fixture source, locate the
defect, apply the fix, and re-run the test.

## The isolated fixture

- fixture directory: `C:\Users\<user>\AppData\Local\Temp\phase14-blind-observation-e6DJQT\project`
- the one file that differs from the pristine observation fixture:
  `scripts/observation_world.gd`
- the acceptance script `res://tests/run_observation.gd` is the oracle and **must not be
  modified**. It is byte-identical to the pristine one.

## Commands

```powershell
cd C:\Users\<user>\ai-native-engine-phase14\experiments\godot-harness
node controller/harness.mjs test --project "C:\Users\<user>\AppData\Local\Temp\phase14-blind-observation-e6DJQT\project" --script res://tests/run_observation.gd --json --allow-outside-root
```

## Recording your work

- Diagnosis: `C:\Users\<user>\ai-native-engine-phase14\docs\phase14\runs\plate-never-registers-run1/diagnosis.md`
- Repair record: `C:\Users\<user>\ai-native-engine-phase14\docs\phase14\runs\plate-never-registers-run1/repair.md` - the exact line changed before and
  after, why it is the smallest correct correction, and the before/after test
  results.
