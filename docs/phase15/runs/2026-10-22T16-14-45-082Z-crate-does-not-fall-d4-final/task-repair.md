# Phase 15 agent repair task: implement the diagnosis

Your diagnosis was accepted and the defective project is now available at
`project/` inside this sandbox. It is a copy; nothing outside this sandbox is
reachable and no shell is available.

Your job:

1. Re-read `diagnosis.md`.
2. Locate the defect in `project/` and apply the **smallest correct correction**.
3. Do not modify anything under `project/tests/`. Those scripts are the oracle
   and must stay byte-identical.
4. Do not modify `project/scenes/` unless the diagnosis proves the defect is
   there.
5. Write `repair.md` describing the exact change you made and why it is the
   smallest correct correction.

Verification is performed by the harness outside the sandbox after you finish.
You cannot run Godot yourself, so reason carefully from the source and the
evidence you already have.

Acceptance script that must pass afterwards: `res://tests/run_observation.gd`
Sandbox directory: C:\Users\<user>\AppData\Local\Temp\phase15-agent-C330fS\sandbox
