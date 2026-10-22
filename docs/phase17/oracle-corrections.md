# Runner-owned oracle corrections

The dodge acceptance test is runner-owned and never enters the agent workspace.
Two corrections were made after the first independent run. Both are recorded
here so the change to the oracle is auditable and is not mistaken for weakening
the feature contract.

## 1. Zero-based phase tick

The implementation starts the active phase at `dodge_tick = 0`, which is a
valid reading of "18 active physics ticks" and is used by the running game. The
first test draft required `dodge_tick >= 1` at initiation. That assumption was
not in the feature contract. The assertion now accepts the zero-based start and
still checks that the active phase lasts 18 ticks.

## 2. Snapshot field name

The game snapshot exposes the attack state as `player_attack_phase`, matching
the Phase 16 field name. One test queried a nonexistent `attack_phase` key and
therefore printed `missing` even when the sword attack had started. The test now
queries `player_attack_phase`. This is a test bug, not an implementation bug;
the attack event count in the same check was already 1.

## 3. Stronger cooldown assertion

While correcting the field name, the test was strengthened: at initiation the
cooldown must be in the inclusive range 44-45 ticks, accommodating a valid
implementation that decrements the cooldown on the start tick, while rejecting a
shortened cooldown. The controlled defect experiment relies on this assertion.

## First-run disposition

`docs/phase17/agent-runs/feature-dodge/` is the first run. Its attempt 1
reported `dodge-does-not-cancel-attack-input` because of correction 2. The
implementation itself passed the corrected 12/12 suite. The first-run attempt 2
was stopped rather than accepting a repair based on the bad oracle. The final
evidence run is `docs/phase17/agent-runs/feature-dodge-run2/`, which started
from the corrected hidden suite and the unchanged unimplemented baseline.
