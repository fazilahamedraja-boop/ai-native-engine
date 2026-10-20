# Project instructions

Read `README.md` and `docs/project-state.md` before changing anything. The
project-state document is the portable handoff: architecture, completed phases,
current status, known issues, next steps, and backup/restore commands.

## Current checkpoint

- Branch: `master`
- Checkpoint tag: `checkpoint-2026-10-20`
- Version: `0.1.0-phase5`
- Phase 5 is complete: island collect/return plus one granite sentinel,
  edge-triggered `F` attack, health/contact/loss, defeat, HUD feedback, and 12
  browser game checks.

Confirm the live state with:

```powershell
git status --short --branch
git log --oneline -8
git tag -n
```

## Build and verification

```powershell
npm ci
npm run typecheck
npm run test:assets
npm run assets -- validate
npm run build
npm run size
```

Browser acceptance uses the existing in-page suites:

```text
http://localhost:5173/                  -> __engine.runTests()  (Phase 1, 6 checks)
http://localhost:5173/?scene=island    -> __engine.runTests()  (game, 12 checks)
```

Headless Chromium throttles rAF. Use real keyboard events plus
`__engine.pause()` and `__engine.step(n)` for deterministic evidence. For a
reproducible suite hash, call `__engine.reset()` after pausing (step 0). Wait
about 1.2 s before reading the HUD or taking a screenshot. `R` resets and
resumes; pause again before stepping.

## Working rules

- Preserve existing behavior and tests. Do not weaken a test to make a change
  pass.
- Do not add a dependency, global surface, MCP server, editor, second game mode,
  or general gameplay/combat framework without a concrete user request and a
  written reason.
- Keep `window.__engine` as the agent surface; `window.__preview` stays
  asset-only.
- Keep the pure layers pure: game state and World/physics must not import THREE.
- Use focused Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`,
  `refactor:`, `chore:`).
- Do not rewrite or delete historical phase evidence. Add a new review or a
  correction commit instead.
- Do not push to a remote without explicit user approval. Do not commit secrets,
  tokens, credentials, `.env` files, or personal data.
- Before claiming completion, run the relevant checks and report exact results
  and any remaining limits.

## Where to look

- `docs/project-state.md` - current handoff and next steps.
- `docs/phase5-plan.md` / `docs/phase5-review.md` - current combat scope and
  evidence.
- `docs/phase4-review.md` - island gate and visual/game limits.
- `docs/phase3-review.md` - loop benchmarks; the 60 s target is still unmet.
- `docs/phase2-exit.md` - asset contract and contact sheets.
- `README.md` - full scene/asset/runtime reference.
