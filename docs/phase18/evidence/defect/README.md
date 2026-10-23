# Controlled defect evidence chain

This directory is a **controlled, disposable** repair test, not the original
Phase 18 diagnosis. The original baseline/post evidence is under
`docs/phase18/evidence/baseline/` and `docs/phase18/evidence/post/`.

## 1. Defect injection

The accepted source was copied to a disposable directory. One expression in
`set_warning()` was changed so the existing ground-level cue stayed at a fixed
progress instead of following the enemy windup:

```gdscript
_warning_progress = clampf(progress * 0.0 + 0.35, 0.0, 1.0)
```

This is a static, non-escalating warning ring. It is bounded and visual-only: it
does not touch timing, input, health, HUD, camera, scenes, or tests. The
canonical worktree was **not** modified by this injection.

## 2. Real defective capture

`before/2026-10-23T19-25-41/` contains seven real 1280x720 windowed captures and
their correlated snapshots. The independent checker fails exactly one check:

- `telegraph-cue-escalates`: warm pixels `1080 -> 1126`, ratio `1.04`, minimum
  required ratio `1.20`.

The cue is present, but static. This is important: a missing ring would let a
repair add a second effect; this defect requires restoring the existing
progression.

## 3. Image-only comparison diagnosis

The accepted comparison is
`diagnosis/compare-healthy-mid-2026-10-23T19-50-07/` using
`opencode/deepseek-v4.1-flash-free`. It was produced before the repair agent had
source access, cites all seven image pairs, and separates observed pixels from
source interpretation. It identified the healthy early/mid/late progression and
the flat defective cue.

A Nemotron comparison at `diagnosis/compare-2026-10-23T19-30-21/` is preserved
but **rejected**. It hallucinated a pink player and a `STRUCK` label in windup
frames where neither is present. See that run's `REVIEW.md`.

The earlier DeepSeek comparison runs are also preserved as iterations; the
`compare-healthy-mid` run is the one used for the repair and is the one whose
image set is complete.

## 4. Task and failure evidence

- `TASK.md`: the bounded repair instructions. It exposes only `game/`, allows
  only `.gd` files under `game/scripts/`, and requires an implementation note.
- `seed-failure.md`: the independent checker's failure and measurement table.
  The runner copies this into the sandbox as `FAILURE.md`.
- The task deliberately does **not** name the defective line or file.

The disposable tree contained a comment that explicitly labelled the injected
defect. This is recorded as a limitation: source tracing could lean on that
comment. The independent image-only diagnosis had already identified the static
cue before source access, and the accepted repair still had to be proved by a
fresh capture, not by trusting the comment.

## 5. Agent repair

`../agent-runs/controlled-defect-repair-2026-10-23T20-01-18/` is the preserved
two-attempt run using `opencode/deepseek-v4.1-flash-free`:

- attempt 1 changed the right expression but omitted required note sections;
- attempt 2 passed 39/39 visual checks and 18/18 + 12/12 gameplay suites;
- attempt 2's source hash equals the accepted healthy source
  (`0369c383...` for `fighter_rig.gd`).

The run's `CORRECTION.md` explains that `run.json.source_files_*` describe the
canonical worktree, not the sandbox input; the real defective input is
`source-baseline/` with hash `5ced74eb...`.

## 6. What this proves

The controlled test proves the adapter can preserve a failed attempt, expose
real before/after images, accept a minimal source repair, and verify both the
visual escalation and the existing game behavior without a human writing the
fix. It does **not** prove that every source-level cause will be found from
images alone; the comment limitation and the failed first attempt are part of
the record.
