# Independent verification failure

The real windowed game was run after your change. The independent image checker did not accept it.

## Failed visual checks
- framed-states-match-baseline

## Observed ground-band warm pixels
- idle: warm=59, changed_vs_idle=n/a, phase=idle:0
- windup-early: warm=1705, changed_vs_idle=n/a, phase=windup:18
- windup-mid: warm=2219, changed_vs_idle=n/a, phase=windup:23
- windup-late: warm=2609, changed_vs_idle=2662, phase=windup:26
- active: warm=2025, changed_vs_idle=n/a, phase=active:2
- recovery: warm=73, changed_vs_idle=n/a, phase=recover:1
- restart: warm=131, changed_vs_idle=n/a, phase=idle:0

## New screenshots
The actual post-change frames are in the feedback directory. Read them with the read tool; they are real captures, not rendered mockups. Compare early and late windup, and idle/recovery.

## Constraints
Do not edit tests, the harness, project.godot, scenes, assets, or HUD. The warning must be in the 3D world at the enemy feet and must escalate during windup. Keep gameplay behavior unchanged.
