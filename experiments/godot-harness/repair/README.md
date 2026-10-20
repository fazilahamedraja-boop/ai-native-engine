# Reproducible repair experiment

The clean baseline is `fixtures/sentry`. The experiment never edits that
directory.

`npm run test:repair` performs the whole sequence:

1. Delete the previous `artifacts/repair-run/sentry` working copy.
2. Copy `fixtures/sentry` into that working copy, excluding `.godot` and
   artifacts.
3. Inject one exact defect into `scripts/player.gd`: forward movement uses
   `+forward` instead of `-forward`.
4. Run the focused live test in `tests/repair.test.mjs`; it must fail.
5. Capture the failing output and a diagnostic snapshot.
6. Restore only the exact movement line.
7. Run the same test again; it must pass.
8. Run the pure sentry suite and a final diagnostic snapshot, then write
   `docs/phase8/repair-evidence.json` and the before/after text logs.

The defect is intentionally not committed as a broken copy of the fixture. It is
represented by `defect.mjs` and `defect.patch`; this keeps the baseline clean and
the injection deterministic.

No manual edit is needed to reproduce the experiment. The operator only runs the
command and reviews the captured evidence.
