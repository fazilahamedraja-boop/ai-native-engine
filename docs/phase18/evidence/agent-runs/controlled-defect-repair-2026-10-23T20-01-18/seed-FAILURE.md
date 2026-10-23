# Observed visual acceptance failure

This is a controlled repair run. The disposable build is the accepted Phase 18
implementation with one visual regression. The observed build is real: it was
launched in a visible window and captured at the same frozen encounter, camera,
and input sequence as the accepted build.

## Independent checker result

The windowed capture produced seven images. The independent pixel/state checker
failed exactly one visual check:

- `telegraph-cue-escalates`

Observed warm-pixel measurements around the enemy's feet:

| Capture | Warm pixels |
| --- | ---: |
| idle | 59 |
| windup-early | 1080 |
| windup-mid | 1101 |
| windup-late | 1126 |
| active | 2052 |
| recovery | 72 |
| restart | 131 |

Healthy accepted reference:

| Capture | Warm pixels |
| --- | ---: |
| idle | 59 |
| windup-early | 1705 |
| windup-mid | 2219 |
| windup-late | 2609 |
| active | 2025 |
| recovery | 73 |
| restart | 131 |

The observed cue is present, but it is essentially static during windup: late
is only 1.04 times early, while the accepted build grows to 1.53 times early.
Idle, recovery, active, restart, HUD, health, positions, and the camera remain
consistent with the accepted build (the late/recovery captures can drift by one
tick because the capture loop pauses between ticks).

The regression is visual-only. Do not add a second warning effect or change
gameplay, timing, input, health, scenes, the HUD, or the camera. Compare
`observed/` with `baseline/` and repair the existing implementation minimally.
