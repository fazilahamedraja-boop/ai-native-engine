# Repair task: dodge distance regression

This is a disposable copy of the Phase 17 game. The independent runner has
already reproduced a regression in the dodge feature. The hidden test source is
not present and will not be provided. Work only in the copied `game/` source.

## Observed failure

The runner's dodge acceptance suite failed one check:

```text
dodge-active-motion-and-phases
```

The detail reported that the dodge phase reached idle, but the measured travel
distance was far below the contract. Existing attack, deflect, posture, victory,
defeat, and restart checks still pass.

## Contract to restore

- The dodge is a committed 18-tick active burst at **9.0 m/s** in the XZ plane.
- With a pure sideways input (`strafe = 1.0`), the player must move about
  **2.7 m** along +X and approximately 0 m along Z.
- Active duration is 18 physics ticks; recovery is 10 ticks; cooldown is 45
  ticks from the start.
- Direction comes from movement input at the start; no input means backward.
- Do not change the input bindings, HUD, events, i-frame window, restart
  behavior, or any existing combat rule.
- Do not edit anything under `game/tests/` or `game/harness/`.

## Required result

Repair the game source so the dodge carries the player the specified distance.
Run the game's existing 18-check suite and the hidden dodge suite through the
runner; both must be green. Write `AGENT-NOTES.md` in the workspace with the
files changed, the root cause, and the verification commands you ran.
