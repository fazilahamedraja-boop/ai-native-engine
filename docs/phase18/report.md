# Phase 18 report: image-driven visual diagnosis and repair

## Outcome

Phase 18 is complete in the isolated worktree
`C:\Users\<user>\ai-native-engine-phase18` on `experiment/phase18-visual`,
based on Phase 17 commit `0ce8d6f`. No merge, push, reset, or history rewrite
was performed. Phase 19 was not started.

The accepted build adds a real 3D ground-level enemy windup cue that grows in
size and brightness as the attack approaches. It was diagnosed from images
before source access, accepted against criteria written before implementation,
and verified in headless, windowed, exported-build, and browser contexts.

The Phase 18 result is **not** reported as one uninterrupted autonomous
implementation pass. The main implementation agent's run is preserved as a
failed run (`repair-2026-10-23T13-33-59`); its attempt-1 source was independently
rechecked under the pre-written two-tick tolerance and freshly recaptured, and
that recapture passes 39/39. A separate controlled-defect repair is a clean
two-attempt autonomous pass and is the direct evidence that the adapter can
observe, repair, and verify a bounded visual regression. Both records are below.

## The visual change

`experiments/godot-harness/game/scripts/fighter_rig.gd` builds a flat,
ground-level warning disc at the enemy's feet. It is visible only when the
existing enemy phase is `windup`; its scale grows from `0.45` to `1.25` and its
emission energy from `0.5` to `2.0` as `phase_progress()` advances. It is
purely visual (no collision), remains below the character body so it is
readable while the player partly occludes the enemy, and is reset when the
fighter resets.

`experiments/godot-harness/game/scripts/game_world.gd` drives it from the
existing enemy windup phase/tick:

```gdscript
var windup: bool = enemy_ai.phase == "windup"
enemy_rig.set_warning(windup, enemy_ai.phase_progress())
```

No second warning system, timing change, input change, health change, HUD
change, or scene change was added. The small harness additions
(`controller/harness.mjs` `setup()` and `game/harness/bridge.gd`
`harness_setup`) expose the game's existing test-only setup function to the
capture runner; they are not gameplay paths.

Accepted source hashes:

| File | SHA256 |
| --- | --- |
| `game/scripts/game_world.gd` | `b47e5ecbda9db96a95018ea218a722b6fa40ca8932bb34794238269aa5b175bc` |
| `game/scripts/fighter_rig.gd` | `0369c3831f5bd3dce19b7e9d63df187ac4491bcd33544c8d23d820e6b0f4942a` |

## Diagnosis before source access

The evidence-only diagnosis is
`docs/phase18/evidence/diagnosis/diagnosis-2026-10-23T02-50-41/`.
It used `opencode/deepseek-v4.1-flash-free` against six baseline images and
the correlated public observations. The sandbox record says
`source_copied: false`, tests were not copied, and shell/webfetch/websearch/
execute/question/skill/subagent tools were denied. It separated observed facts
from hypotheses. It observed that early and late windup were visually
indistinguishable in the 3D scene and that the HUD was carrying the only
unambiguous warning. Its chosen problem was:

> The windup's in-world telegraph is static and non-escalating, so the 3D scene
> does not communicate how imminent the attack is; the HUD line is the only
> unambiguous warning.

That diagnosis proposed the missing progression evidence and a mid-windup
sample. The canonical seven-image baseline was captured afterward at
`docs/phase18/evidence/baseline/2026-10-23T02-56-46/`. The acceptance criteria
in `docs/phase18/acceptance.md` were written before implementation and use the
already-proposed ground-band measurement, escalation requirement, mid sample,
and the documented two-tick phase tolerance.

## Baseline and accepted windowed result

All captures are real 1280x720 windowed images with `state_before.hash ==
state_after.hash` at the paused encounter. The warm-pixel measurements are from
the independent checker's fixed ground band around the projected enemy feet.

| Capture | Baseline | Accepted post | Meaning |
| --- | ---: | ---: | --- |
| idle | 59 | 59 | no cue |
| windup-early | 31 | 1705 | cue appears |
| windup-mid | 43 | 2101 | cue grows |
| windup-late | 53 | 2609 | cue is strongest |
| active | 2052 | 2052 | attack/impact, not windup cue |
| recovery | 73 | 73 | cue absent |
| restart | 131 | 131 | clean reset |

The original baseline acceptance run has 38 checks and fails four:
`telegraph-cue-visible-late`, `telegraph-cue-change-over-idle`,
`telegraph-cue-changes-pixels-vs-idle`, and `telegraph-cue-present-early`.
Its late/early ratio happens to pass because the baseline band is tiny and
noisy; the controlled defect is the case that isolates escalation. Later
acceptance runs add `visual-cue-increased-vs-baseline` and have 39 checks.
Baseline acceptance hash:
`b48a9a50cee125842fecf6aeb79857e0806ca8396b84e3e288df1518990689d4`.

The fresh accepted windowed run is
`docs/phase18/evidence/post/2026-10-23T19-19-21/`: 39/39 checks pass, zero
failed checks. Its acceptance hash is
`a1c8e46a00759d7be2a6f6d3594c99c4002c71abf4de40104dae779efe57d299`.
The baseline and post captures are linked in the dashboard under
`phase18/baseline-*.png` and `phase18/post-*.png`.

## Main implementation agent run (preserved failure)

`docs/phase18/evidence/agent-runs/repair-2026-10-23T13-33-59/` records the
main implementation attempt with
`opencode/nemotron-3.5-super-vl-free`. Its `run.json` says `status: failed`
after three attempts. Attempt 1 did produce the accepted source and real
captures:

- idle 59, early 1705, mid 2219, late 2609, active 2025, recovery 73,
  restart 131;
- 18/18 existing game checks and 12/12 hidden dodge checks passed;
- its original acceptance run failed exactly `framed-states-match-baseline`
  because the mid capture was one tick later (22 vs 23) and the active enemy
  position differed by 0.021667 units. The pre-written tolerance permits two
  ticks and 0.12 units.

A recheck using the corrected comparator is preserved as
`attempt-1/post/visual-acceptance-recheck.json` and passes 39/39. A completely
fresh windowed capture was then run independently at
`evidence/post/2026-10-23T19-19-21/`, also passing 39/39. The canonical worktree
source still matches attempt 1 (`fighter_rig.gd` and `game_world.gd` hashes
above). Attempts 2 and 3 did not produce a passing result; the failed run and
its evidence were not silently rewritten.

This distinction matters: the original implementation run is a failed
autonomous run, not an autonomous success claim. Its source was accepted only
after the tolerance was already written down and a fresh capture independently
passed.

## Controlled defect and autonomous repair

`docs/phase18/evidence/defect/` is a separate disposable test. One expression
in the already-healthy source was replaced with:

```gdscript
_warning_progress = clampf(progress * 0.0 + 0.35, 0.0, 1.0)
```

This produces a static, non-escalating cue rather than removing it. A real
windowed capture at `defect/before/2026-10-23T19-25-41/` fails exactly one
check, `telegraph-cue-escalates`:

| Capture | Warm pixels |
| --- | ---: |
| idle | 59 |
| windup-early | 1080 |
| windup-mid | 1101 |
| windup-late | 1126 |
| active | 2052 |
| recovery | 72 |
| restart | 131 |

The late/early ratio is 1.04 against the required 1.20. The cue is present, so
a repair cannot satisfy the test by adding a second effect.

The accepted image-only comparison is
`defect/diagnosis/compare-healthy-mid-2026-10-23T19-50-07/`, using
`opencode/deepseek-v4.1-flash-free`. It cites all seven image pairs and
separates observed pixels from source interpretation. A Nemotron comparison at
`compare-2026-10-23T19-30-21/` is rejected and preserved: it hallucinated a
pink player and `STRUCK` in windup frames. Its `REVIEW.md` is the record.

The repair task is `defect/task.md`; the checker failure is
`defect/seed-failure.md` (copied to the sandbox as `FAILURE.md`). The task
exposes only `game/`, allows only `.gd` changes under `game/scripts/`, and
does not name the defective line. The completed run is
`agent-runs/controlled-defect-repair-2026-10-23T20-01-18/` using
`opencode/deepseek-v4.1-flash-free`:

- attempt 1 changed the right expression but omitted required implementation
  note sections; it did not pass the runner;
- attempt 2 passed 39/39 visual checks, 18/18 existing game checks, and 12/12
  hidden dodge checks;
- attempt 2's `fighter_rig.gd` hash equals the healthy source
  `0369c383...`; its defect input under `source-baseline/` has hash
  `5ced74eb...`; the final source diff against the healthy backup is empty.

The run's `run.json` labels `source` and `source_files_*` with the canonical
worktree, not the sandbox input. `CORRECTION.md` in that run records the actual
input/output hashes and explains why this is metadata semantics, not a false
pass. The controlled test also has a limitation: the disposable source
contained a comment explicitly labeling the injected defect. The independent
image-only diagnosis had already found the static cue before source access, and
the pass still had to be proved by a fresh capture, but source tracing could
lean on that comment.

## Verification matrix

| Layer | Evidence | Result |
| --- | --- | --- |
| Headless existing gameplay | `evidence/canonical/final-game-18.log` | 18/18 pass, exit 0 |
| Headless hidden dodge | `evidence/canonical/final-dodge-12.log` | 12/12 pass, exit 0 |
| Full Phase 8-17 regression | `evidence/regression/final-full-suite-65.log` | 65 tests, 65 pass, 0 fail |
| Windowed visual, accepted build | `evidence/post/2026-10-23T19-19-21/` | 39/39, zero failed |
| Controlled repair visual | `evidence/agent-runs/controlled-defect-repair-2026-10-23T20-01-18/attempt-2/post/` | 39/39, zero failed |
| Windows export visual | `evidence/export/visual-export-2026-10-23T20-34-45/` | 39/39 on real 1280x720 exported window |
| Windows export gameplay | `evidence/export/gameplay-2026-10-23T20-37-58/` | 9/9, exit 0 |
| Browser load/input | `evidence/web/` | 0 console errors, held trusted key input verified |
| Post-cleanup rerun | `evidence/canonical/post-cleanup/` and `evidence/regression/post-cleanup-full-65.log` | 18/18, 12/12, 65/65 again |

The post-cleanup rerun was executed after removing the generated `game/build`,
`game/artifacts`, and `__pycache__` noise and restoring the generated `.import`
metadata. It confirms the source still passes without those artifacts.

The existing 18 checks cover startup, movement/grounding, camera follow and
wall avoidance, attack timing and facing, enemy damage, player damage, deflect
success and mistimed deflect, stagger/posture transition, victory, defeat,
restart, HUD state, and the event stream. The 12 dodge checks cover startup,
active motion and i-frames, late-active vulnerability, cooldown
rejection/expiry, attack/parry rejection, HUD, defeat rejection, and restart.
Those two suites are headless and do not produce screenshots; the visual proof
comes from the windowed/exported/browser runs above.

The export build is a real Windows export:

- `DeflectArena.exe`: `cd2526cc93bc164d9d8f011761c2348973dfe06654824498767096fa58568212`
- `DeflectArena.pck`: `f2fc27551493b652cd5dff78735682ccab1ce3a1b8dfb3432973af8c43bea6eb`
- build log: `evidence/export/build.log`

The exported bridge rejects `res://` screenshot writes, so the visual proof
uses DPI-aware OS client-area window capture at 1280x720. Earlier export
capture failures are preserved under
`evidence/export/visual-export-2026-10-23T20-27-02/` through
`...20-30-52/`; only the final run is presented as the pass.

## Browser verification

The Phase 18 web export is served at:

```text
http://127.0.0.1:8788/play18/index.html
```

`evidence/web/build-manifest.json` records the wasm/pck and source hashes. The
page title is `deflect-arena`; the canvas backing store is 1920x842 and the
CSS viewport is 1536x673. The browser console had 3 informational messages,
0 errors, and 0 warnings. The HTML, JS, wasm, and pck requests returned 200.

Phase 17 left `keyboard_input_verified: false` because a quick synthetic key
press did not reach the Godot polling loop. Phase 18 tested this directly:

- a single `page.keyboard.press(' ')` between game frames did not register; the
  probe is preserved at `evidence/web/probes/quick-press-space.png`;
- a **trusted keydown held across multiple game frames**, followed by keyup,
  did register.

The measured sequence produced:

- `W` held 659 ms: player advanced into enemy range; `STRUCK` and PLAYER HP
  3/4 appeared;
- `J` held 462 ms: HUD `STATE attacking`, sword pose changed (enemy HP stayed
  5/5 because the sword was out of range);
- `K` held 266 ms: HUD `STATE deflecting`;
- `Space` held 256 ms: HUD `STATE dodging`, `DODGE ACTIVE`, lateral movement;
- `R`: HUD returned to `STATE duel`, PLAYER 4/4, ENEMY 5/5, DODGE READY.

Screenshots and pixel diffs are in `evidence/web/`: `load-initial.png`,
`move-w.png`, `attack.png`, `deflect.png`, `dodge.png`, `restart.png`, plus the
probe folder. The verification JSON is
`evidence/web/web-verification.json`; it records all 16 trusted key events,
screenshot hashes, console counts, network status, and observed HUD states.
These browser screenshots are 1920x843 device-pixel captures and are not
substitutes for the 1280x720 windowed acceptance set. The browser probe does
not independently assert enemy damage, posture break, victory, or defeat; the
game and export checks cover those.

## Safety and isolation

- Worktree: `C:\Users\<user>\ai-native-engine-phase18`; branch
  `experiment/phase18-visual`; base `0ce8d6f`.
- The main checkout remains separate; no merge, push, reset, or Phase 8-17
  evidence rewrite was performed.
- Agent sandbox config:
  `controller/agent-sandbox/opencode.json`, SHA256
  `3bbdf761bd665be0a857fa912c0e5b16a0fbcaa5266f97b5ddbb0ba7bf879690`;
  shell, webfetch, websearch, execute, question, skill, and subagent are
  denied.
- The adapter policy allows only `scripts/*.gd`, forbids harness changes,
  does not copy tests, and records the hidden dodge test hash before/after
  (`08018e...` both times; unchanged).
- Source was copied into the implementation sandbox only after the diagnosis
  run completed (`model_access_order.source_copied_at` is later than
  `diagnosis_completed_at`).
- The main implementation run was capped at 3 attempts; the controlled repair
  at 2. Failed attempts, logs, diffs, and captures are preserved.
- The visual checker is outside the agent sandbox and reads only PNGs,
  correlated public snapshots, and HUD text. It does not import the game.

## Limits and honest gaps

1. The baseline acceptance file has 38 checks because it predates the
   baseline-reference check; post/defect/export use 39. The original baseline
   still correctly fails, and the acceptance thresholds are frozen in
   `acceptance.md`.
2. The main implementation run failed. The accepted source came from its
   attempt 1 but required an independent recheck under the pre-written
   tolerance and a fresh windowed run. It is not an uninterrupted autonomous
   pass.
3. The controlled-defect source comment labeled the injected defect. This
   weakens source-level blindness; the independent image-only diagnosis was
   already complete before source access.
4. The visual evidence is still-image based. It checks sampled windup frames,
   not motion smoothness, audio, or alternate camera angles. No new human
   blind-ordering study was run; the independent pixel/state checker is the
   formal oracle.
5. The browser probe confirms real input and visible state changes, but it is
   not a deterministic tick-level gameplay suite and does not assert victory or
   defeat.
6. The web-export helper still emits a `phase17.web-export.v1` manifest schema.
   The Phase 18 wrapper records the actual build hashes and explains the label;
   the game source and output are unaffected.
7. The accepted warning cue is a filled ground disc in code, described as a
   ring in comments and acceptance prose. The images and checker measure the
   ground cue, not a hollow ring shape.

## Reproduction

From `C:\Users\<user>\ai-native-engine-phase18\experiments\godot-harness`:

```powershell
npm run test:game
npm run test:game:dodge
npm test
```

The final logs are recorded under `docs/phase18/evidence/canonical/` and
`.../regression/`, including the post-cleanup rerun. The visual checker can be rerun against a capture
directory with:

```powershell
python controller/phase18_visual_acceptance.py `
  --run-dir ..\..\docs\phase18\evidence\post\2026-10-23T19-19-21 `
  --baseline-dir ..\..\docs\phase18\evidence\baseline\2026-10-23T02-56-46 `
  --out ..\..\docs\phase18\evidence\post\2026-10-23T19-19-21\visual-acceptance-rerun.json
```

Do not rerun the live agent into the canonical worktree without the same
sandbox and allowed-change policy. Do not edit or delete the preserved
evidence; add corrections instead.

## Evidence index

- `docs/phase18/acceptance.md` - criteria, baseline controls, tolerance.
- `docs/phase18/evidence/baseline/2026-10-23T02-56-46/` - canonical pre-fix
  captures and failed 38-check acceptance.
- `docs/phase18/evidence/diagnosis/diagnosis-2026-10-23T02-50-41/` - image-only
  main diagnosis.
- `docs/phase18/evidence/agent-runs/repair-2026-10-23T13-33-59/` - preserved
  failed main implementation run and attempt-1 recheck.
- `docs/phase18/evidence/post/2026-10-23T19-19-21/` - fresh accepted windowed
  capture, 39/39.
- `docs/phase18/evidence/defect/` - controlled defect task, failure, images,
  accepted/rejected comparisons, and README.
- `docs/phase18/evidence/agent-runs/controlled-defect-repair-2026-10-23T20-01-18/`
  - preserved two-attempt autonomous repair and correction.
- `docs/phase18/evidence/canonical/` - final 18/18 and 12/12 logs.
- `docs/phase18/evidence/regression/final-full-suite-65.log` - 65/65.
- `docs/phase18/evidence/export/` - build log, 39/39 exported visual run, 9/9
  exported gameplay run, and preserved earlier failures.
- `docs/phase18/evidence/web/` - web build manifest, browser screenshots,
  image metrics, server logs, and `web-verification.json`.

Phase 19 was not started.
