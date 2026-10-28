# AI Game Studio

A local app for three things:

1. **The S0 evidence dashboard** (`/`) — a read-only view over the Phase 19
   evidence already committed in `docs/phase19/evidence`.
2. **The Studio** (`/studio`) — describes a change in plain language, lets a real
   OpenCode agent make it in an isolated copy of a registered game project, then
   verifies the candidate independently and waits for a human decision.
3. **The Windows desktop app** (`/app`) — the same backend, wrapped in an Electron
   shell with a project home, an AI workspace, a real viewport and an evidence
   panel. See [Desktop app](#windows-desktop-app).

Nothing the agent does reaches the canonical project until you approve it, and
approval re-checks both the workspace and the canonical hashes first.

## Run it

```powershell
Set-Location studio
npm start
# -> http://127.0.0.1:8787/       evidence dashboard
# -> http://127.0.0.1:8787/studio studio
# -> http://127.0.0.1:8787/app    desktop UI in a browser (attached to npm start)
```

Node.js 20 or newer. The agent reuses the
harness's `resolveOpencodeBin()` (`experiments/godot-harness/controller/agent-adapter.mjs`);
set `OPENCODE_BIN` to point at a specific `opencode` binary.

For the desktop shell, install development dependencies once (`npm install`
adds Electron 45 and `@electron/packager`), then:

```powershell
npm run desktop        # in-process backend on an OS-assigned loopback port
npm run desktop:dev    # Electron devtools + menu, same in-process backend
npm run desktop:attach # attach to an already running `npm start` (STUDIO_URL)
npm run package:win    # portable build in desktop-dist\
```

`npm run desktop` is the supported entry point: it starts the existing server
in-process, so there is exactly one backend, no readiness polling, and a second
launch focuses the existing window instead of starting another server.

## Configuration

The server reads these environment variables directly; there is no `.env` loader,
so set them in the shell that starts `npm start` or `npm run desktop`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `STUDIO_PORT` | `8787` | Loopback port. The host is fixed to `127.0.0.1`. |
| `STUDIO_AGENT_MODEL` | `opencode/deepseek-v4.1-flash-free` | Default model in the composer. |
| `STUDIO_AGENT_MODELS` | built-in list | Comma-separated allowlist of models the server will accept. |

## Windows desktop app

`desktop/main.mjs` is a thin Electron host around the unchanged Studio backend.
It does not reimplement projects, jobs, verification, operations or approval —
the renderer talks to the same HTTP API as `/studio`.

### What the window contains

- **Project home** — created projects with template, status and last run, the two
  read-only reference projects, empty states, and a creation dialog with a
  template description. Reference projects are marked read-only here so the
  Phase 8–19 tree cannot be changed from this client.
- **Workspace** — a large prompt, the selected project and its status, and
  **Build Game with AI** (a real `POST /api/studio/jobs`, not a simulated
  progress animation). A run shows its stage stepper, live SSE log, cancel, run
  history and the resulting evidence. New runs are blocked while one is
  queued, running or awaiting approval.
- **Viewport** — *Native window* launches the real Godot process and can stop,
  relaunch, capture a frame, run script checks, run the registered suite and read
  runtime logs. The panel explicitly says a captured frame is **not live** and
  never pretends to embed an OS window. *Browser build* embeds the registered
  canonical web build (CSP `frame-src` allows only `http://127.0.0.1:8790`).
- **Evidence** — verified vs unverified claims kept separate, changed files with
  before/after sizes and hashes, the diff, job and native screenshots, repair
  attempts, then **Approve and apply…** or **Discard**. Approval requires the
  confirmation dialog and is performed by the server, which re-checks the
  workspace and canonical hashes first.

### Lifecycle and security

- The main process starts `startServer({ port: 0 })`; the host is always
  `127.0.0.1` and the OS assigns the port. The window loads
  `http://127.0.0.1:<port>/app`.
- A single-instance lock means a second launch focuses the first window; it
  never starts a second backend on a second port.
- The renderer runs with `contextIsolation`, `sandbox`, no `nodeIntegration` and
  `webviewTag: false`. Its only bridge is `studioDesktop.openExternal(url)`,
  which the main process restricts to loopback origins. No shell, filesystem or
  arbitrary IPC is exposed.
- Navigation and `window.open` are restricted to the Studio origin; other
  loopback links open in the default browser.
- Closing the window stops native Godot windows, closes the server and its SSE
  connections, and saves window bounds. Errors during startup or a renderer
  crash surface a Windows dialog instead of a blank window.
- `desktop/preload.cjs` exposes the app version, mode, platform and
  `openExternal` only. The version comes from `studio/package.json`, not from
  Electron.

### Packaging

`desktop/package-win.mjs` stages a repository-shaped app root
(`studio/`, `experiments/godot-harness/`, `docs/phase19/evidence/`), excludes
`node_modules`, `test`, `.data`, `.packaging` and `desktop-dist`, and runs
`@electron/packager` with `asar: false` so the backend can read the harness and
templates from disk. The result is portable, not an installer:

```text
desktop-dist\AI Game Studio-win32-x64\AI Game Studio.exe
```

The packaged app creates its data under
`resources\app\studio\.data`, so keep it in a writable folder rather than
`Program Files`. Godot is still required (put `godot` on `PATH` or set
`GODOT_BIN` to the Godot 4.7 executable), as is the OpenCode CLI for AI runs; the
UI reports a missing tool instead of faking a run.

## Test it

```powershell
Set-Location studio
npm test
```

`node:test`, no dependencies for the backend tests. Covers the path guard,
evidence parsing, the job store, the workspace copier and differ, verification,
the provider classifier, the agent runner (success, repair, quota, cancel,
resume, approve, discard, corruption) and the HTTP surface including the
operations allowlist.

`test/desktop.test.mjs` covers the desktop surface specifically: `/app` and its
assets are served, the legacy `/` and `/studio` routes are unchanged, path
traversal on `/app/*` returns 404, the CSP is preserved, the HTML contains no
inline script/handler/style, the client never writes inline `style` attributes,
and the Electron host keeps its sandbox and loopback constraints.

## The Studio

### Projects

The registry in `server/lib/projects.mjs` is the only source of project paths,
test scripts, executable actions and editable files. It holds two kinds of
project:

- **Built-in reference projects** (fixed in the registry, rooted inside
  `experiments/godot-harness` and never written to by the Studio):
  - **Voxel Sandbox** — `experiments/godot-harness/voxel`, agent editing enabled
    for `scripts/voxel_data.gd` only, public suite + hidden acceptance suite +
    real windowed smoke.
  - **Deflect Arena** — read-only, tests and native launch only. Agent tasks are
    disabled because it has no single bounded editable file or hidden suite yet.
- **Created projects** — written to `studio/.data/projects/<slug>/` with a
  `project.manifest.json`, discovered from disk on every request, so they survive
  a server restart and stay outside the Phase 8–19 tree and outside git.

The dashboard shows the project path, run modes, controls, test suites, agent
policy, origin and live status. Nothing in the UI is hard-coded to voxel.

#### Creating a project

`+ New project` in the sidebar opens a dialog with a name, a template, and a
description. Two templates are implemented: **Voxel Sandbox** (the Phase 19
reference world) and **3D Arena Action** (a readable arena scaffold that the
agent turns into a real game). Templates that are not implemented are rejected
by the server rather than faked.

Creation is a real backend operation (`POST /api/studio/projects`):

1. Validate the name (2–48 chars, letters/numbers/space/`.`/`-`/`_`, no slashes
   or `..`, no reserved device names) and reject duplicates by id **and** name,
   including names that collide with a built-in project.
2. Copy the template tree (excluding `.godot`, `artifacts` and any manifest) into
   a staging directory, then rename it into place. Rename is the duplicate guard
   for two simultaneous requests.
3. Rewrite the copy's `project.godot` application name, write
   `project.manifest.json` (name, template, description, createdAt, status) and
   `PROJECT.md`.
4. Initialise the copy with `godot --headless --path <dir> --import`, which
   creates the import cache and the global script class cache the game needs.
   If the import fails the project is kept, the manifest records
   `status: "needs_import"` and the UI explains the failure instead of claiming
   success.
5. Register and return the project; the UI refreshes the list, selects it and
   opens the Preview tab.

Created projects inherit the template's public suite, hidden suite, windowed
smoke and agent policy. They have **no browser build**: a browser export is
per-project and is not wired, so the Preview panel says so and uses the native
window.

#### Build Game with AI

The **Build Game with AI** card takes one natural-language description, creates a
fresh project from the arena template and starts a real `build` job. The prompt
is stored as the job task and as the project description, and everything the job
does is the normal job pipeline — no separate shortcut:

1. Create the project (same validated, staged, imported path as `+ New project`).
2. Copy it into an isolated workspace, run the baseline (the arena suite is
   skipped on the untouched scaffold by template policy — the scaffold is
   honestly not a game yet), and capture a real `before.png`.
3. Feature mode: the agent may still only touch the project's `scripts/**`,
   `scenes/**` and `assets/**`, and may **add** new files inside those patterns;
   tests, the harness bridge, the arena host, `project.godot` and the manifest
   stay read-only. Any addition outside the patterns, and every deletion, fails
   the scope check.
4. Verify: GDScript parse, the visible acceptance suite, a pristine copy of the
   same suite from outside the project, then a real windowed run whose
   screenshot and observed `player_position` change are saved.
5. The candidate stays isolated until a human approves it; discard leaves the
   project untouched and keeps the evidence.

The arena contract lives in `studio/templates/arena/ARENA_SPEC.md`. The template
is covered by `test/arena-template.test.mjs`: the untouched scaffold must fail
its own suite and the reference implementation in `test/fixtures/arena-reference`
must pass all 20 checks.

`test/gameplay-probe.mjs` is the manual, real-window proof: it moves, attacks
out of range and in range, kills the enemy, restarts and loses, and prints a
pass/fail line per rule. It opens a window, so it is not part of `npm test`:

```powershell
node test/gameplay-probe.mjs --project .data/projects/<slug>
```

### A job

1. **Import** — a disposable copy of the project under `studio/.data/jobs/<id>/workspace`.
   The start commit and a tree hash are recorded.
2. **Baseline** — static check + tests run on the untouched copy. A failing
   baseline stops the job before any model call.
3. **Agent** — OpenCode runs with a private `XDG_CONFIG_HOME` (the sandbox config
   in `controller/agent-sandbox/opencode.json`), a bounded task file, and no
   shell/network affordances beyond that sandbox. The transcript and stderr are
   kept per attempt.
4. **Policy** — the candidate tree is diffed against the baseline. Any change to
   a file outside the allowlist fails the job; the diff is still saved.
5. **Verify** — parse check, public suite, hidden suite, then a real windowed
   launch with reset/step/input and a captured frame. `skipped` steps are neutral,
   never silently passing. Failures feed one bounded repair attempt.
6. **Decide** — approve applies only the allowed modified files after re-checking
   the workspace and canonical hashes; discard removes only the disposable
   workspace. Evidence survives both.

Jobs, attempts, steps, artifacts and events are persisted, so a crashed or
cancelled job is inspectable and resumable. 429/quota, auth, and unknown-model
failures stop immediately and require a different model to resume; timeout,
network and crash failures can resume with the same model. A resume revalidates
the workspace hash and refuses to skip or repeat verification silently.

### HTTP surface

| Route | Purpose |
| --- | --- |
| `GET /api/studio/meta` | Server scope, templates, models, limits |
| `GET /api/studio/projects` | Registered projects and status |
| `POST /api/studio/projects` | Create a project from a template (`201`) |
| `GET /api/studio/templates` | Implemented templates only |
| `POST /api/studio/build-game` | Create a project from a prompt and start a build job (`202`) |
| `GET /api/studio/projects/:id` | One project |
| `GET /api/studio/projects/:id/preview` | Browser-preview availability |
| `GET/POST /api/studio/jobs` | List / start a job |
| `GET /api/studio/jobs/:id` | Job detail (artifacts resolved job-relative) |
| `GET /api/studio/jobs/:id/events` | Event log |
| `GET /api/studio/jobs/:id/stream` | SSE progress stream |
| `GET /api/studio/jobs/:id/diff` | Unified diff of the candidate |
| `GET /api/studio/jobs/:id/artifacts/*` | Screenshots and JSON evidence |
| `POST /api/studio/jobs/:id/cancel\|approve\|discard\|resume` | Job lifecycle |
| `GET/POST /api/studio/ops` | List / run a trusted operation |
| `GET /api/studio/ops/:id` | One operation result |
| `GET /api/meta`, `/api/runs`, `/api/text`, `/api/file` | S0 evidence dashboard |

### Trusted operations

The browser sends only `{ projectId, op, args }`. Every operation is a fixed
routine in `server/lib/operations.mjs` — `check`, `test`, `launch`, `stop`,
`capture`, `reset`, `advance`, `logs`, `export`, `preview`. There is no way to
supply an executable, a shell string, a working directory or a filesystem path;
unknown op names are rejected with `400 invalid_op`. Native windows are owned by
the server and reused across capture/reset/stop.

## Boundaries

- The server binds `127.0.0.1` only, sets a restrictive CSP, `nosniff`,
  `no-referrer` and `no-store`, and caps request bodies at 64 KiB.
- Every filesystem access resolves through a containment check; explicit `..`,
  absolute paths and unknown extensions are rejected before disk access.
- The agent cannot reach the canonical project, run arbitrary shell commands
  against it, or edit anything outside the project's allowlist.
- Evidence is append-only: failures, transcripts, diffs and screenshots are kept
  and a corrupted manifest is reported rather than overwritten.
- Artifacts larger than the text cap are reported as `413`, not truncated
  silently.

## Known limitations

- Single operator, no authentication: this is a local tool, not a server to
  expose. Anyone who can reach the port can approve changes.
- Native window automation is Windows-only (it drives the harness's
  `win-game` helper).
- Two templates exist. **3D Arena Action** is deliberately one small arena with
  one enemy; it is a contract, not a game engine, and the build pipeline is
  wired only to it. Voxel Sandbox remains the only template with a browser build.
- A created project has no browser build; its preview is the real native window.
- Creation runs a Godot import, so it takes a few seconds. If Godot is missing
  the project is still created but marked `needs_import`.
- The browser preview embeds the **canonical** game build, not the candidate;
  candidate evidence comes from the windowed smoke run. The UI labels this.
- A browser frame is not gameplay proof: control verification requires observed
  input plus a state change, and is only claimed when the smoke run measured it.
- The desktop viewport cannot mirror a native OS window. It launches the real
  process and shows labelled captures; live embedding is only available for a
  registered browser build.
- The desktop client intentionally offers no Build/Approve actions for the two
  reference projects, and only the arena template is wired to the AI pipeline.
- The portable build is unsigned and ~400 MB (Electron plus harness plus
  evidence). It has not been code-signed, so SmartScreen may warn on first run.
- The embedded Godot web build requests pointer lock on load, which Chromium logs
  as a warning until the user clicks the canvas. It does not affect mouse
  capture once the frame has focus.
- Deflect Arena agent tasks are disabled (see above) — the UI shows the reason
  instead of pretending the button works.
- The evidence dashboard still scans `docs/phase19/evidence` at startup;
  restart to pick up new commits.
