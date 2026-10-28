# Arena scaffold

A minimal Godot 4 arena project used by the AI Game Studio's **Build Game with
AI** workflow.

It renders a readable arena (camera, sun, 24 x 24 floor, on-screen hint) and
answers the harness protocol, but the game logic in `scripts/main.gd` is an
honest stub: no player, no enemy, no combat. The acceptance suite fails on it
by design, so a generated game has to add real gameplay before it can pass.

- `ARENA_SPEC.md` — the contract the AI must implement.
- `tests/run_arena_tests.gd` — the acceptance suite (read-only).
- `scripts/arena_host.gd` — read-only harness host and frame loop.
- `harness/bridge.gd` — the shared Studio harness bridge (verbatim copy).

Run the suite by hand:

```powershell
godot --headless --path . -s res://tests/run_arena_tests.gd
```

The template itself is read-only. The Studio copies it into
`studio/.data/projects/<slug>/` when a project is created.
