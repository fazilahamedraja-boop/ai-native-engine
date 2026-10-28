# Studio verification report

Date: 2026-10-26
Worktree: local checkout of the repository (commands below are repo-relative)
Branch: `experiment/studio-s0` at `0582fd7`
State: **nothing committed, nothing pushed.** `git status --short` shows only
`?? studio/`.

---

## 1. What was delivered

| Area | Where |
| --- | --- |
| HTTP app, Studio routes, SSE, security headers, 64 KiB body cap | `studio/server/index.mjs` |
| Job persistence, artifact addressing, corruption handling | `studio/server/lib/jobs.mjs` |
| Job pipeline: import → baseline → agent → policy → verify → repair → decision | `studio/server/lib/agent-runner.mjs` |
| Independent verification (parse, public suite, hidden suite, windowed smoke) | `studio/server/lib/verification.mjs` |
| Provider error classification (quota / auth / model / timeout / network / crash) | `studio/server/lib/provider-errors.mjs` |
| Isolated copy, tree diff, scope policy, unified diff | `studio/server/lib/workspace.mjs` |
| Path containment, hashing, atomic writes | `studio/server/lib/studio-paths.mjs` |
| Fixed named operations, native session lifecycle, preview, export | `studio/server/lib/operations.mjs` |
| Project registry: built-ins, templates, validated creation, disk discovery | `studio/server/lib/projects.mjs` |
| Process supervision with timeouts and output caps | `studio/server/lib/process.mjs` |
| Dashboard + Studio UI (plain HTML/CSS/JS, no framework) | `studio/public/` |
| Documentation | `studio/README.md` |
| Tests (12 files) | `studio/test/` |

The S0 evidence dashboard at `/` is unchanged in behaviour and still serves the
Phase 19 evidence; the Studio lives at `/studio` and has its own UI, state and
routes.

---

## 2. Exact commands and results

### Studio suite

```
cd studio
npm test
```

```
ℹ tests 133
ℹ pass 133
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 14588
```

The 133 include the two new arena-template contract tests (§10.2), which each
run a real headless Godot suite, plus the feature-mode scope tests; that is why
the suite takes twice as long as the 125-test run recorded earlier.

### Existing harness suite

```
cd experiments\godot-harness
npm test
```

```
ℹ tests 84
ℹ pass 84
ℹ fail 0
ℹ duration_ms 97774
```

### Native-window tests

```
cd experiments\godot-harness
python -m pytest tests/test_win_game.py -q
```

```
12 passed in 2.35s
```

### GDScript diagnostics

```
cd experiments\godot-harness
npm run check:gd
```

```
[gd-check] 9 files (lsp) in 5072 ms: 0 errors, 11 warnings, 0 info, 0 hints
[gd-check] OK at --fail-on error
```

The 11 warnings are pre-existing (integer division, a shadowed `position`
variable, an unused local in `run_voxel_tests.gd`).

### Repository state

```
git status --short --branch   ->  ## experiment/studio-s0
                                  ?? studio/
git log --oneline -1          ->  0582fd7 feat: add GDScript LSP checks, native window automation, and a run supervisor

hashTree('experiments/godot-harness/voxel')      -> b3e8bd5cff53a3049abc92ee71aa93a4b4c73125728ef1185e71e5ff9f9a4749
sha256('.../voxel/scripts/voxel_data.gd')        -> 338d3ee055fc605333271c1ed725237812cd2c8f5bffa56ad915583479ea0b27
```

Both hashes equal the values recorded before the first job, so the canonical
voxel project is byte-identical to HEAD. Phases 8–19 are untouched: the only
working-tree entry is the new `studio/` directory.

The Godot import file `experiments/godot-harness/voxel/assets/icon.svg.import`
is regenerated with CRLF churn by every LSP/import/export run; it was restored
with `git checkout -- experiments/godot-harness/voxel/assets/icon.svg.import`
and the tree is clean.

---

## 3. Real jobs (12 total, all preserved under `studio/.data/jobs/`)

| Job | What it proves | Outcome |
| --- | --- | --- |
| `job-20261026063638-bfb40cfa` | Baseline gate runs before any model call | `failed` at `baseline`, 0 attempts, no agent call |
| `job-20261026063815-15485d28` | Provider classification was too eager (a token count looked like an auth error) | `discarded`; bug found, classifier restricted to real diagnostics |
| `job-20261026064018-9105485a` | Scope guard catches Godot `.import` churn | `discarded`, `scope_violation`, diff kept |
| `job-20261026064239-8015d7f4` | Full success path, end to end | `applied` |
| `job-20261026064413-71e864f8` | Agent refuses to edit tests, edits only the allowed file | `applied` |
| `job-20261026085954-b5927f30` | Agent refuses a change that would break the suite, explains why | `failed` (`scope_violation`, no change), transcript kept |
| `job-20261026090108-7f762660` | Deliberate verification failure + bounded repair | `failed`, 2 attempts |
| `job-20261026090545-e1a6de2b` | Model produced a *compatible* change instead of the break; verified pass | `awaiting_approval` → `discarded` by the operator |
| `job-20261026090725-60b2e0b9` | Deliberate failure reproduced with the improved terminal message | `failed`, 2 attempts |
| `job-20261026105245-b58c6972` | First arena build: the harness sent `forward`, the arena only listened for `move_forward`, so the windowed smoke saw no movement | `cancelled` by the operator before any agent write |
| `job-20261026105655-61737289` | Arena build that passed 20/20 on a template whose camera actually faced the sky, so its captures were blank | `discarded`; template defect found and fixed, suite gained a real camera gate |
| `job-20261026111017-d553bc82` | **Build Game with AI**, end to end, on the fixed template | `applied` after human approval |

Evidence size: 10.7 MB total (583 files).

### 3.1 Successful job `job-20261026064239-8015d7f4`

- Task: add `block_name(block_id: int) -> String` to `VoxelWorldData`.
- Model: `opencode/deepseek-v4.1-flash-free`.
- Start commit `0582fd7…`, baseline tree `de32036c…`, candidate tree `c6a0560f…`.
- Changed files: exactly one, `scripts/voxel_data.gd`, 8 713 → 8 851 bytes.
- Verification:

| Step | Result |
| --- | --- |
| Candidate diagnostics | pass |
| Voxel public suite | **36 passed, 0 failed** (1 expected diagnostic line: `ERROR: Parse JSON failed. Error at line 0: Expected key`) |
| Hidden voxel-data acceptance suite | **15 passed, 0 failed** |
| Native gameplay smoke | observed `player_position` change of **0.619** after real harness input |

- Before/after frames: `artifacts/before.png` 264 876 B, `artifacts/after.png`
  264 927 B, both 1280×720, `paused: true`.
- Approve: applied `scripts/voxel_data.gd`, `338d3ee0…` → `55a9dc2e…`.
- Post-approve canonical suites were re-run green (36/0 and 15/0), then the file
  was restored to HEAD bytes so the protected tree ends untouched while the job
  stays `applied` with its evidence.

### 3.2 Deliberate failing run `job-20261026090725-60b2e0b9`

Task: rewrite `counts()` to return only decimal-string keys — plausible, and it
breaks the real contract.

```
attempt 1  (14.5 s)  scripts/voxel_data.gd changed
  verify.static  ok      Candidate scripts parsed cleanly.
  verify.test    FAIL    Voxel public suite: 35 passed, 1 failed.
                           - startup-block-types: counts={"0":10203,...}
                           - ERROR: Parse JSON failed. Error at line 0: Expected key
  verify.hidden  FAIL    Hidden voxel-data acceptance suite: 14 passed, 1 failed.
                           - data-required-block-types: counts={"0":9815,...}
  verify.gameplay ok     player_position change 0.566
  verify.failed / attempt.retry  (STUDIO_FAILURE.md written for the repair)

attempt 2  (148.6 s)  no file differed from the baseline
  scope.no_change        The agent finished without changing an allowed file.

final: failed/verify, error.class = scope_violation
  "The agent made no change. None of the allowed files was modified.
   The earlier attempt failed verification: Voxel public suite: Godot reported ERROR lines"
```

Both attempts keep their transcript, diff, verification JSON and latency. The
job is not resumable into approval: approve is refused while the candidate is
unchanged.

The earlier failing run `job-20261026090108-7f762660` shows the same shape with
the pre-fix message; it is left as-is because evidence is append-only.

### 3.3 Build Game with AI `job-20261026111017-d553bc82`

This is the end-to-end demo of §10: one natural-language description in, a
playable game out, verified twice (headless contract + real window) before a
human approved it.

```
project   arena-action (created from the arena template, isolated under studio/.data/projects/)
task      "Create a small 3D arena action game. Add a controllable player, a visible
           enemy, player attacks, enemy health, player health, and a win or loss
           condition. Make the arena visually readable and ensure the controls are
           explained on screen."
model     opencode/deepseek-v4.1-flash-free
commit    0582fd7456ed      workspace cd431bed1dd7
```

Changed files — exactly the two editable paths, nothing added, nothing deleted:

| File | Status | Size |
| --- | --- | --- |
| `scenes/main.tscn` | modified | 1 201 → 9 578 B |
| `scripts/main.gd` | modified | 1 490 → 11 889 B |

Verification (independent of the agent's own claims):

| Step | Result |
| --- | --- |
| Godot import of the candidate | pass |
| Candidate script diagnostics | pass |
| Arena acceptance suite (in the project) | **20 passed, 0 failed** |
| Pristine arena acceptance suite (from outside the project) | **20 passed, 0 failed** |
| Native window, capture and input | pass — `player_position` changed by **3.000** |

Approval (`Approve & apply` in the UI) applied 2 files; the job is `applied` and
its artifacts stay under `.data/jobs/job-20261026111017-d553bc82/`
(`before.png` 27 192 B, `after.png` 78 169 B, `diff.patch`, `verification.json`,
transcript of the single attempt).

The `before.png` is the honest scaffold (empty dark grid with a "not implemented"
hint); `after.png` shows walls, pillars, a blue player, the red Granite Sentinel,
two health bars, `FIGHT!` and a control tip line.

### 3.4 Real-window gameplay proof on the approved project

`node test/gameplay-probe.mjs --project .data/projects/arena-action` drives the
**approved** project files in a real Godot window through the same harness input
path a player uses, and asserts the rules, not the pixels:

| Check | Observed |
| --- | --- |
| starts at full health, playing, enemy visible | 100/100, `playing` |
| controls on screen | `WASD move \| SPACE / ENTER / J attack \| R restart` read from the live `Label` nodes |
| movement | `forward` input for 30 steps |
| attack out of range does nothing | enemy health stays 100 |
| attack in range damages and kills | enemy health → 0, outcome `won` |
| enemy hidden on win | `enemy_visible: false` |
| restart restores the fight | 100/100, `playing` |
| contact damage loses | health → 0, outcome `lost` |

**11/11 checks, `ok: true`.** Screenshots `probe-won.png` (VICTORY + 0 enemy
health) and `probe-lost.png` (DEFEATED + 0 player health) come from that run.

HUD legibility was checked separately by cropping the captures at 4× nearest
neighbour: every label is a single sharp glyph run with a black outline. The
"doubled text" seen earlier was an artifact of the downscaled image preview, not
of the render — confirmed by row-band analysis showing exactly two text bands
(hint row, label row) and no second offset band. No template change was needed.

---

## 4. UI and browser verification

Browser: Playwright/Chromium against the live server on `127.0.0.1:8787`.

| Check | Result |
| --- | --- |
| `/` title, h1 | `AI Game Studio — Phase 19 evidence (S0)`, `AI Game Studio / evidence` |
| `/` console errors | 0 |
| `/studio` load console errors | 0 (the preview iframe mounts lazily, so the game is not requested until the tab is opened) |
| Preview tab | mounts the real 1280×720 game canvas; `allow="fullscreen; gamepad; pointer-lock"` so embedded mouse-look works after a real click |
| Job detail (success) | 2 gallery images at natural size 1280×720, `complete: true`; 4 verification steps; changed-files row; diff text with `+func block_name(...)` |
| Job detail (failure) | error banner names the verification failure; attempts 1 and 2 listed with status, duration and tool counts |
| Operations tab | fixed ops only; `Run tests` → `36 passed, 0 failed in Voxel public suite` |
| 1440×900 | no horizontal overflow (`scrollWidth == clientWidth`) |
| 390×844 | no horizontal overflow after `.sidebar { min-width: 0 }` (a grid item's default `min-width: auto` let the project rail widen the page) |
| 900×700 | no overflow, single-column layout |
| Build Game with AI card | prefilled with the demo prompt, model select, `Build game` submit; creating submits `POST /api/studio/build-game` and the new project appears selected |
| Build job detail | original description, project, stage timeline, 5 verification steps, 2 changed files with before/after sizes, `before.png`/`after.png` gallery at 1280×720, `Approve & apply` |
| After approval | job status `applied`, event `approval.applied: Applied 2 file(s) to the canonical project` |

Residual console message: `A user gesture is required to request Pointer Lock.`
It is emitted by the **game's** own startup code inside the iframe, not by the
Studio page, and disappears once a user clicks into the canvas.

Screenshot legibility on this machine: Chromium reports `devicePixelRatio 1.25`
and the UI uses fractional `rem` font sizes (e.g. `14.08px`), so full-page
captures show softened glyph edges that can read as doubled text. Page text was
therefore verified from the DOM (`textContent` / `value`), not from pixels; a
crop of the event timeline at native device resolution is sharp. This is a
pre-existing cosmetic font-scaling effect, not a Studio data problem.

### Native operations over HTTP

```
launch  -> ok  pid=4800 headless=False game_ready=True
capture -> ok  1280x720, 272 096 B  ("Captured 2026-10-26T08:56:42.905Z (1280x720).")
stop    -> ok  stopped=True
export  -> ok  109 235 296 B, exit 0 (earlier run)
shell   -> 400 invalid_op
```

`shell` is rejected because the HTTP layer never accepts an executable, a shell
string or a path — only a name from the fixed op set.

---

## 5. Provider and quota impact

- Model used for every real job: `opencode/deepseek-v4.1-flash-free`.
- Agent invocations: **13 attempts across 12 jobs** (one job stopped at baseline
  and never called the model; two jobs used 2 attempts).
- **No 429, no quota exhaustion, and no rate-limit event was hit**, so nothing
  was retried against a throttled provider. The agent is stopped after the first
  terminal classification, and quota/auth/model failures additionally require a
  different model before `resume` is accepted.
- The quota/429/auth/timeout/crash paths are covered by unit tests that feed
  realistic provider diagnostics (stderr and structured `error` events), not by
  provoking the provider. This is deliberate: the requirement was to avoid
  hammering a rate-limited provider, so the negative paths are proven
  deterministically instead.
- One real auth misclassification occurred (`job-…15485d28`) and was fixed:
  classification now reads only diagnostic text, never raw JSON counters.

---

## 6. Security and limits

| Control | Implementation |
| --- | --- |
| Bind address | Fixed to `127.0.0.1`; the server refuses to bind anything else |
| Operations | Named routines only (`check`, `test`, `launch`, `stop`, `capture`, `reset`, `advance`, `logs`, `export`, `preview`). Args are validated against a small schema; unknown ops are `400 invalid_op` |
| Paths | Every access goes through `resolveRelative`/`assertInside`; explicit `..`, absolute paths, null bytes and unknown extensions are rejected before disk access |
| Request size | 64 KiB body cap, with the stream drained before rejecting (`413`) |
| Timeouts | Per-attempt and per-job runtime limits; process supervision kills timed-out children |
| Agent sandbox | Private `XDG_CONFIG_HOME` per run; `controller/agent-sandbox/opencode.json` denies shell, web, subagents and external directories, allows only read/write/edit/glob/grep |
| Canonical protection | The agent only ever sees a disposable copy; approve re-verifies workspace and canonical hashes and applies only allowed modified files |
| Evidence | Append-only; failures, transcripts and diffs are preserved; a corrupt manifest is reported and can never be overwritten |
| Headers | Restrictive CSP, `nosniff`, `no-referrer`, `no-store` |
| Secrets | No credentials in code, prompts, logs or evidence |

Tests that pin these behaviours (all in the 133):

```
✔ path guard: rejects traversal, absolute paths, null bytes and odd extensions
✔ job store: invalid job ids and escaping paths are rejected before disk access
✔ registry: invalid project ids are rejected without touching the filesystem
✔ studio server: operations accept only named ops and registered arguments
✔ operations: unknown operations and unregistered test suites are refused
✔ runner: cancellation preserves the workspace and records the cancelled attempt
✔ runner: quota failures stop immediately and require a different model to resume
✔ runner: a resumed job refuses a workspace that changed while stopped
✔ runner: resume refuses a deleted workspace instead of re-running silently
✔ runner: corrupted job state blocks approve, discard, cancel and resume
✔ job store: a corrupt manifest is reported and can never be overwritten
✔ runner: approval refuses a workspace tampered after verification
✔ runner: approval refuses to overwrite a canonical file that changed independently
✔ runner: a repair that makes no change after a verified failure keeps the reason
```

---

## 7. Known limits and disabled capabilities

1. **Deflect Arena agent tasks are disabled.** There is no single bounded
   editable file and no hidden acceptance suite for it yet, so the registry
   refuses to start an agent job and the UI states the reason. Tests, launch,
   inspection and preview are enabled for it.
2. **The embedded browser preview shows the canonical build, not the candidate.**
   Candidate evidence comes from the windowed smoke run. The UI labels which is
   which; no browser frame is presented as proof of a candidate.
3. **Gameplay claims are conditional.** A control is only reported as verified
   when the smoke run observed real input plus a `player_position` change; the
   screenshot alone is never described as gameplay proof.
4. **Native window automation is Windows-only** (it drives the harness's
   `win-game` helper).
5. **Single operator, no authentication.** The tool is loopback-only and must not
   be exposed; anyone reaching the port can approve.
6. **No real 429 was provoked** (see §5). Quota behaviour is proven by tests
   against synthetic provider output.
7. **The free model often refuses harmful edits.** Two jobs show the agent
   declining a change that would break the suite, with its reasoning in the
   transcript. That is correct behaviour, but it means a "bad candidate" has to
   be induced with a plausible refactor rather than an openly destructive task.

---

## 8. Loose ends

- `studio/README.md` was rewritten in this pass to describe the whole Studio
  instead of S0 only.
- The terminal message for a repair that makes no change after a verified
  failure was improved in this pass (it used to say only "made no change"); it is
  covered by a new test and by the real run in §3.2.
- The two applied voxel jobs point at canonical files that have since been restored
  to HEAD bytes on purpose, so "applied" refers to the recorded approval, not to the
  current canonical content. The arena job (§3.3) is different: its files really are
  in `.data/projects/arena-action/`, which is outside git.
- Servers left running: Studio on `127.0.0.1:8787`, canonical browser game on
  `127.0.0.1:8790`. The arena native window used for §3.4 and for the capture
  screenshots was stopped (`op: stop`, `stopped: true`).
- The two discarded/cancelled arena scaffolds are kept under
  `studio/.data/retired/` rather than deleted, so the earlier failures stay
  inspectable.

---

## 9. Create New Project (added in this pass)

### 9.1 Why there was no button

The registry was a fixed array of two built-in projects and there was no
creation route, no creation service and no UI affordance. The Studio could only
inspect and run the two reference projects; every screen was read-only with
respect to the project list. Nothing was hidden behind a flag — the capability
did not exist.

### 9.2 What was added

| Area | Change |
| --- | --- |
| Registry | `createProjectRegistry()` in `server/lib/projects.mjs`: built-ins, one declared template, on-disk created projects, validation, duplicate/limit guards, staging + rename, manifest, `PROJECT.md` |
| Initialisation | Creation runs `godot --headless --path <dir> --import`; the manifest records `ready` or `needs_import` and the UI explains a failed import |
| Routing | `GET /api/studio/templates`, `POST /api/studio/projects` (201), templates in `/api/studio/meta`; operations and jobs resolve projects through the injected registry |
| UI | `+ New project` in the sidebar, a modal dialog (name, template, description), defaults, inline errors, auto-refresh + selection + Preview tab, `created` badge, origin fact |
| Tests | `studio/test/project-create.test.mjs` (13 tests: creation, manifest, persistence, isolation, duplicates, invalid names, traversal, template, limit, corruption, failed import, operations, HTTP) |

Only **Voxel Sandbox** is exposed as a template, and the dialog says it is the
only implemented one. (A second template, 3D Arena Action, is added in §10.1.)
Created projects live in
`studio/.data/projects/<slug>/`, outside the repository tree and outside git.
The source template and both built-ins are read-only to creation.

### 9.3 Browser and backend verification (real UI, real Godot)

Run against `http://127.0.0.1:8787/studio` in Chromium through the DevTools
protocol, driving the real buttons:

| Step | Observed |
| --- | --- |
| Button present | `#new-project` visible at 244.8 × 37.1 px, label `+ New project` |
| Dialog defaults | name `My Block World`, template `voxel-sandbox` (only option), focus in the name field |
| Cancel | dialog closed, project count unchanged (2), no directory written |
| Invalid name `../escape` | `400 invalid_project_name`, inline error, dialog stays open, count unchanged |
| Duplicate `Voxel Sandbox` | `409 project_exists`, inline message, count unchanged |
| Create `My Block World` | `201`, manifest written, project listed with a `created` badge, auto-selected, Preview tab opened |
| Template import | `initialization.ok = true` in 5075 ms; `manifestStatus = ready`; `.godot/global_script_class_cache.cfg` present |
| Launch | real native Godot window, `pid 27744`, op `launch` = `ok` |
| Capture | `1280 × 720` PNG loaded in the UI from `capture-20261026102110-cf7117.png` |
| Static check | `9 script(s) parsed cleanly (godot-check-only)` in 4140 ms |
| Public suite | `36 passed, 0 failed` in 8391 ms on the created project |
| Reload | card still listed with `live` + `created` badges; native session and capture still shown |
| Server restart | registry rediscovered `my-block-world` from disk; `ready: true`; deep link `#project=my-block-world` selected it |
| Traversal | `/api/studio/projects/..%2F..%2Fpackage.json` and `/%2e%2e` → `404`, no file read |
| Evidence dashboard | `/` still `200`, still links to `/studio` |

A first attempt to launch a project created **before** the import step existed
failed honestly: the operation returned `launch_failed` with Godot's real parse
errors (`Identifier "VoxelWorldData" not declared`) and the UI showed the
failure. That test project was removed and recreated after the fix; the failure
is why creation now imports the template.

### 9.4 Remaining limits of creation

1. There is exactly one template. "Choose a game type" is not available because
   no other game type is implemented; the dialog states this.
   **Superseded in §10.1:** a second template (3D Arena Action) now exists and
   the dialog offers both.
2. Created projects have no browser build (per-project export is not wired), so
   their preview is the native window only.
3. Creation needs Godot installed. Without it the project is created and marked
   `needs_import`; launch will fail and the UI reports the import error rather
   than pretending.
4. The Studio caps created projects at 20 and does not yet offer delete/rename.
5. The directory is not tracked by git; back it up separately if a created
   project matters.

---

## 10. Build Game with AI (added in this pass)

### 10.1 What is new

A description in, a playable game out. Nothing in the creation, isolation,
verification, approval or evidence pipeline is new — the pass adds a second
template, a feature-complete scope mode, one route and one UI card, all on top of
the existing job pipeline.

| Area | Change |
| --- | --- |
| Template | `studio/templates/arena/` — `project.godot`, `scenes/main.tscn`, stub `scripts/main.gd`, read-only `scripts/arena_host.gd`, `harness/bridge.gd`, 20-check `tests/run_arena_tests.gd`, `ARENA_SPEC.md`, `README.md` |
| Contract | `ARENA_SPEC.md` + the suite define the required state API (`reset` / `set_input` / `tick` / `get_state`), groups `arena` / `player` / `enemy`, controls text, win and loss rules |
| Registry | arena descriptor with its own `descriptor`, `templateSourceDir` resolving built-in harness dirs vs `studio/templates` with containment, per-template `allowedPatterns` |
| Scope | optional `patterns` / `allowAdditions` / `protectedPaths`; feature mode is opt-in per template and the exact-list behaviour is unchanged |
| Runner | `build` job kind, baseline suite skip by template policy, feature-mode additions, approve applies modified **and** added files, still refuses deletions and anything outside the patterns |
| HTTP | `POST /api/studio/build-game` — validates the prompt (10–4000 chars), creates the project from the template, starts the job, returns `202` |
| UI | **Build Game with AI** card: description, model select, submit, inline errors; the job detail then shows the normal timeline, verification, changed files and before/after gallery |

The agent is still sandboxed exactly as before: private config home, shell/web/
subagents denied, only read/write/edit/glob/grep, and it only ever sees a
disposable copy. Approval re-verifies the workspace hash and the canonical file
hashes before writing.

### 10.2 Two real template defects found and fixed

Both were found by running the pipeline, not by reading the code, and both would
have made the feature look like it worked while producing false evidence.

1. **The camera faced the sky.** `Transform3D` in a `.tscn` is written
   row-major, so the scaffold's "look down at the arena" values actually aimed
   the camera up and lit the scene from below. Every windowed capture was a flat
   grey frame, yet the suite still passed because it only checked that a
   `Camera3D` existed. Fixed the camera and sun transforms, and the suite now
   requires `camera.is_position_in_frustum(Vector3(0.0, 0.9, 0.0))` — that
   accepts third-person, first-person and top-down views and rejects a sky-facing
   one. `job-…61737289` had passed 20/20 under the old gate and was discarded.
2. **`Label3D` renders garbled glyphs in this Godot build**, even on the
   untouched scaffold with its original text. The template now uses a
   `CanvasLayer` + `Label` HUD, and the reference implementation looks the hint
   up with `find_child("Hint")` and accepts `Label` or `RichTextLabel`.

A third defect was in the harness translation, not the template: the harness
input vocabulary is `forward`/`strafe`/`jump`/`restart`/`actions`, while the
arena listens for `move_forward`/… . `scripts/arena_host.gd` now translates
between them, which is what makes the smoke run's movement check meaningful.
`job-…b58c6972` was cancelled on the old behaviour with zero agent writes.

### 10.3 Guard test

`studio/test/arena-template.test.mjs` (part of `npm test`) runs the suite twice
against a fresh copy of the template:

- the **untouched scaffold must fail** (it is honestly not a game), with no
  parse errors, so the suite cannot silently stop testing anything;
- the **reference implementation** in `test/fixtures/arena-reference/` (not
  shipped to the agent) must pass **20/20**.

### 10.4 Verified vs not verified

Verified, with the evidence in §3.3 and §3.4:

- The exact demo prompt produced a project and a real implementation, changing
  two files the agent was allowed to change and nothing else.
- The visible suite, a pristine copy of it from outside the project, GDScript
  diagnostics, and a real windowed run with input all passed **before** approval.
- After approval, the real-window probe certified 11/11 gameplay rules,
  including out-of-range attacks doing nothing, win, restart and loss.
- Discard leaves the project untouched; the failed/superseded arena scaffolds are
  preserved under `studio/.data/retired/` rather than deleted.

Not verified / limits:

- **One model, one prompt.** `opencode/deepseek-v4.1-flash-free` succeeded once;
  that is not evidence the pipeline works for every description. A description
  that asks for something outside the arena contract (multi-level, physics,
  multiplayer) has no template and no suite.
- The acceptance suite proves the arena contract, not fun, balance or visual
  quality. The screenshots are evidence of what rendered, not of gameplay; the
  gameplay claim rests on the observed state changes.
- The arena has no browser build; its preview is the native window.
- `My Block World`, the voxel project and the built-ins were not modified:
  `hashTree(experiments/godot-harness/voxel)` is still `b3e8bd5c…9a4749` and
  `scripts/voxel_data.gd` is still `338d3ee0…ea0b27`; `git status --short` is
  still just `?? studio/`.

---

## 11. Windows desktop app (2026-10-28)

### 11.1 What was added

| Area | Where |
| --- | --- |
| Electron main: single instance, in-process server on port 0, navigation guard, shutdown | `studio/desktop/main.mjs` |
| Sandboxed bridge (version/mode/platform + loopback `openExternal` only) | `studio/desktop/preload.cjs` |
| Portable Windows packaging (repo-shaped stage, `asar: false`) | `studio/desktop/package-win.mjs` |
| Generated app icon (256 px PNG + multi-size ICO) | `studio/desktop/make-icon.mjs`, `icon.png`, `icon.ico` |
| Desktop UI: project home, workspace, viewport, evidence | `studio/public/desktop.html`, `desktop.css`, `desktop.js` |
| Routes `/app` and `/app.html` (existing routes unchanged) | `studio/server/index.mjs` |
| Desktop tests (7) | `studio/test/desktop.test.mjs` |

The backend, job pipeline, verification, operations and approval logic are
reused unchanged. The desktop client calls the same HTTP API as `/studio`; it
adds presentation, routing and a second entry point, not a second pipeline.

### 11.2 End-to-end journey, actually performed

1. **Create.** The dialog loaded both templates, rejected a one-character name
   with “Give the project a name of at least 2 characters.”, then created
   **Desktop Smoke** from *3D Arena Action* (`#/project/desktop-smoke`, badge
   `Ready`, toast “Project created and imported.”).
2. **Describe and submit.** The 233-character arena prompt started a real job
   (`job-20261028145059-22715925`). The stage stepper moved through Baseline →
   AI edits → Verification → Review & apply; SSE log lines streamed
   (`job.created`, `workspace.ready`, `agent.tool`, `verify.*`). Cancel, history
   and the “one run at a time” guard were present; the cursor was blocked from
   starting a second run.
3. **Verify.** The run finished `awaiting_approval` with:
   - Godot import of the candidate — pass;
   - candidate GDScript diagnostics — pass;
   - arena acceptance suite — 20 passed, 0 failed;
   - **pristine** arena acceptance suite from outside the project — 20 passed;
   - native window, capture and input — `player_position` changed by **3.000**.
   The panel listed the NOT VERIFIED items separately (behaviour outside the
   suites, and the fact that nothing had been applied yet).
4. **Approve.** “Approve and apply…” opened the confirmation dialog showing
   `scenes/main.tscn 1.2 KB → 1.2 KB` and `scripts/main.gd 1.5 KB → 23.7 KB`
   with short hashes. Confirming changed the status to `Applied` and the files
   on disk:
   - `scripts/main.gd` 1 490 → **24 238 B**, SHA-256 `9acad454…3486b8b`;
   - `scenes/main.tscn` 1 201 → **1 266 B**, SHA-256 `93436247…d90c1eb`.
   Those file hashes are the ones the dialog showed.
5. **Run and inspect.** In the viewport, **Launch** started a real Godot window
   (`Running · pid 24176`), **Capture frame** produced
   `capture-20261028150318-5915ec.png` (1280×720), rendered with the caption
   “Captured frame — not live”, **Stop** ended the process, and **Run test
   suite** reported “20 passed, 0 failed in Arena acceptance suite”
   (758 ms). The same capture appeared under *Native captures*; the operation
   log recorded `capture`, `stop`, `test` and `launch` with results.

### 11.3 Real window and packaging

- `npm run desktop` opened a native window titled **AI Game Studio**, served
  from `http://127.0.0.1:63143/app` with an in-process backend. The window
  showed `v0.1.0 · desktop`, 3 created projects and 13 runs, and the *Arena
  Action* workspace with applied evidence. Window capture required
  `PrintWindow(PW_RENDERFULLCONTENT)`; plain `PrintWindow` returns black for
  Chromium's composited surface, and screen capture can be covered by another
  topmost window.
- `npm run package:win` produced
  `studio\desktop-dist\AI Game Studio-win32-x64\AI Game Studio.exe`
  (**409 MB**, Electron 45.0.0). Launched, it served `/app` from its own backend
  on `127.0.0.1:55813`, reported `0 created projects` (portable, clean data
  directory), and listed the two read-only reference projects.
- A second launch of the packaged executable **exited with code 0** and did not
  create a second backend or port; process count was unchanged.
- Closing the window (WM_CLOSE) ended every process in the tree and released
  port 55813; `Get-NetTCPConnection -LocalPort 55813 -State Listen` returned
  nothing.
- Browser-build path: after rebuilding the git-ignored voxel web export and
  serving it with `node controller/voxel-web.mjs --port 8790`, the vaulted
  `voxel-sandbox` project showed `live · embedded browser build`,
  `reachable · HTTP 200`, an iframe at `http://127.0.0.1:8790/`, and the
  read-only Build button disabled. The console showed no CSP `frame-src`
  violation; the only error was Godot's pointer-lock request needing a user
  gesture, plus the expected “Unrecognized feature: pointer-lock” warning.

### 11.4 Tests (all run after the desktop changes)

```
cd studio && npm test
ℹ tests 140   ℹ pass 140   ℹ fail 0   (133 previous + 7 desktop)

cd experiments/godot-harness && npm test
ℹ tests 84    ℹ pass 84    ℹ fail 0

cd experiments/godot-harness && python -m pytest tests/test_win_game.py -q
12 passed in 1.42s

cd experiments/godot-harness && npm run check:gd
[gd-check] 9 files (lsp): 0 errors, 11 warnings, 0 info, 0 hints
```

Canonical state after all of this: branch `experiment/studio-s0` at `0582fd7`,
`git status --short` = `?? studio/`, and the transient Godot churn in
`experiments/godot-harness/voxel/assets/icon.svg.import` (caused by the web
export) was reverted. Nothing was committed or pushed.

### 11.5 Not verified / limits

- No AI run was started **from the packaged build**; it needs the OpenCode CLI
  and Godot on the target machine and would duplicate the verified run above.
  The portable build shares the same code path, but that specific binary's job
  execution is unproven.
- The executable is unsigned; SmartScreen may warn. It is a portable folder,
  not an installer, with no auto-update.
- The native viewport cannot embed an OS window. It launches the real process
  and shows labelled captures; “live” is reserved for a registered browser
  build.
- Reference projects are read-only in the desktop client (Build/Approve hidden)
  to protect the Phase 8–19 tree; only the arena template is wired to AI.
- The window is Windows-only in practice: native automation drives the
  harness's `win-game` helper, and packaging is `win32-x64`.
- Electron renders at the machine's DPI scaling; automation screenshots should
  use CSS-scale capture or `PrintWindow(PW_RENDERFULLCONTENT)` to avoid
  misleading glyph artefacts.


