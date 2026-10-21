# Phase 13 — Controlled action and observation (Stage B)

Runner: `experiments/godot-harness/controller/live-observe.mjs` (Stage B section)
Fixture: `fixtures/observation` (reused unchanged)
Evidence: `docs/phase13/stage-a-live-observation/action-results.json`,
`action-before.png`, `action-after.png`

## 1. Principle

An action is only reported as successful when the **resulting runtime state proves it**. The
controller never treats "the input was sent" or "the command returned without error" as success.
Each action below is checked against a measured consequence, and the check is written as an
assertion in the runner, so a regression fails the run rather than producing a flattering report.

## 2. Action 1 — move forward

| | |
| --- | --- |
| Input | `{ forward: 1 }` — the existing `set_input` / `advance_physics` contract, no new mechanics |
| Bound | 45 fixed physics frames (0.75 s of game time) |
| Before | `player_position = [0, 0.85, 5.5]`, `player_velocity = [0, 0, 0]`, `grounded: true` |
| After | `player_position = [0, 0.85, 2.5]`, `player_velocity = [0, 0, -4.0]` |

**Expected vs actual.**

The fixture's player controller uses `SPEED = 4.0` m/s at 60 Hz, so 45 frames should move the
player `4.0 × 45 / 60 = 3.0` m in −Z.

| Quantity | Value |
| --- | --- |
| Expected distance | 3.000 m |
| Actual distance | 3.000 m |
| Ratio | 1.0000 |
| Moved towards −Z | yes (`z` 5.5 → 2.5) |
| Still on the floor | yes (`y` stayed 0.85) |
| **Verified by state** | **yes** |

The verification is a compound assertion, not a single comparison:

```js
const actionVerified =
  movedTowardsNegativeZ &&
  actualDistance > expectedDistance * 0.5 &&
  actualDistance <= expectedDistance * 1.5 &&
  after.player_position[1] > 0.5
```

The `y > 0.5` clause is deliberate: without it, a player that fell through the floor while
"moving" would still satisfy a pure distance check. The action is only credited if the character
moved the right way, by a plausible amount, and stayed standing.

**Visual proof.** `action-before.png` shows the player at `z=5.5` near the bottom of the frame;
`action-after.png` shows the same player at `z=2.5`, noticeably closer to the pressure plate, with
the HUD `PLAYER z=2.50` in both cases matching the structured state.

## 3. Action 2 — interact

The observation fixture exposes a generic boolean action map. `interact` is consumed by the
fixture and increments its own counter, which makes it a bounded, observable action with no
movement involved.

| Quantity | Before | After |
| --- | --- | --- |
| `interaction_count` | 0 | 1 |

**Verified by state: yes** — the counter advanced by exactly one. The runner asserts
`afterInteract.interaction_count === interactBefore + 1`.

This action was included because the phase brief asks for a second action "only if the chosen
fixture genuinely supports it". The observation fixture supports `interact` natively, so no new
mechanic was added. The `observation` fixture has no attack action, and none was invented for it:
the combat fixture from Phase 11 is a different fixture with a different bridge, and Stage B does
not need to cross that line to prove the contract.

## 4. Why not a scripted "press the key and assume it worked"

Three failure modes are explicitly closed:

1. **Input sent, nothing happened.** Caught because the distance and direction are measured from
   the snapshot, not from the input echo.
2. **Something happened, but the wrong thing.** Caught because the check pins direction, distance
   band, and floor contact — not just "the position changed".
3. **A previous frame is reused.** Caught because each action's before/after frames carry
   distinct sha256 values, and Stage A's freshness check covers the whole sequence.

## 5. Limitations

- The expected distance is derived from the fixture's own `SPEED` constant. If that constant
  changed, the expected value would need to change with it. The tolerance band (50 %–150 %)
  absorbs small numeric differences but not a real behaviour change.
- Only two actions were exercised. The harness input contract supports `forward`, `strafe`,
  `jump`, `restart`, and an arbitrary boolean action map, but this phase verified two of them.
- The jump and restart edges were not exercised in Stage B; the Phase 8–12 suites already cover
  them.
- The player is driven by the deterministic `advance_physics` path. This is a repeatability result
  for this fixture on this machine and this Godot build, not a general Godot determinism claim.
