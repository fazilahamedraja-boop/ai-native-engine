# Task: a mistimed deflection is accepted

`game/` is Deflect Arena, a small Godot 4 third-person duel. The player attacks
with `J` and deflects with `K`. A deflect is only supposed to work inside a
short, time-bounded window just before the enemy's blow lands. Pressing far too
early must let the window expire and the blow must connect.

The acceptance suite at `game/tests/run_game_tests.gd` is the project oracle.
It currently reports one failing case:

- `game-parry-mistimed-does-not-register`
  detail: `player_health=4 result=success parry_events=1`
  expected: the early press expires, the enemy hits, `player_health` becomes 3,
  `parry_result` is `expired`, and no `parry_success` event is recorded.

The scenario the suite runs for that case: reset, place the player at z=2.6 and
the enemy at z=0.8, wait for the enemy to enter its windup, press deflect once
at the start of the windup, then advance 60 ticks.

Your job:

1. Read `game/README.md`, the scripts under `game/scripts/`, and the failing
   test.
2. Find why a press at the very start of the windup still counts as a
   successful deflection at the moment the blow lands.
3. Make the smallest source change that restores a real timing bound.
4. Keep a correct late-window deflect working: pressing late in the windup must
   still deflect, award posture damage, and prevent the hit.
5. Do not edit the tests, the harness bridge, or weaken any assertion. The
   runner hashes `game/tests/` and rejects a changed oracle. Do not delete or
   replace project files.

Constraints:

- Shell and network access are disabled in this sandbox. You cannot run Godot.
- Keep the project loadable: GDScript must parse and the scene must still
  instantiate.
- Change only what the fix needs. No refactors, no new files, no art changes.
- The runner will import the project and execute the full acceptance suite
  after you finish. A correct fix turns all 18 checks green.
