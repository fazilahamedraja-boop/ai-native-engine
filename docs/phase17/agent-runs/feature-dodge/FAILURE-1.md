# Verification failure after attempt 1

Mode: feature

The independent runner executed the real Godot game. The game did not meet the feature contract.
The hidden test source is not in this workspace and is not provided. Use the failing behavior
and the source code to repair the implementation.

## Failing checks

- dodge-does-not-cancel-attack-input: during_phase=idle during_attack=missing ready_attack=missing starts=1

## Runner summary

- dodge: 11/12 passed, exit 1, 4003 ms
- existing: 18/18 passed, exit 0, 14205 ms
- total failing: 1

## Runtime error tail

```
(none)
```

## Rules

- Do not edit anything under game/tests/.
- Do not modify game/harness/.
- Repair the game source in this disposable copy only.
