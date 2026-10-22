# Phase 15 agent repair task: diagnose from evidence only

A Godot game scene is failing its acceptance suite. This sandbox contains the
failing test output, a screenshot of the running game, structured runtime
state, the recorded event stream, and physics-space query results. It does not
contain the game source: you cannot read it yet, and you are not expected to.

Your job in this step is **diagnosis only**.

## Write this file

`diagnosis.md` in the current directory. It must start with the H1 title
`# Phase 15 diagnosis` and contain these exact sections:

- **Failure** - what failed, quoting the specific evidence values
- **Contradiction** - the falsifiable claim, and which two observations conflict
- **Hypotheses ruled out** - alternatives and the evidence that excludes them
- **Proposed correction** - the smallest change you would make
- **Confidence** - and what extra evidence would raise it

Rules:

- Use only files under `evidence/`. Do not guess a file path for the source.
- Name the failing acceptance case explicitly.
- Do not write any other file.

## Evidence available

- `evidence/test-output.txt` - the failing acceptance test output
- `evidence/test-result.json` - the parsed result of that run
- `evidence/observation.json` - structured runtime state and events
- `evidence/physics-queries.json` - physics-space query results
- `evidence/state.json` - the fixture snapshot at the end of the scenario
- `evidence/before.png` - a screenshot of the running game

Sandbox directory: C:\Users\hacke\AppData\Local\Temp\phase15-agent-kGW0Vv\sandbox
