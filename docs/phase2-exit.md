# Phase 2 exit evidence

Recorded 2026-10-20, before regenerating `pine-nordic-01`.

## Predicted parameter change

- Asset: `pine-nordic-01` (pine, procedural, 148 triangles at the time of
  prediction).
- Change: `params.tiers` 5 -> 6. No other param changes.
- Geometry: each tier is a closed cone with 12 segments. With `snow: false`, a
  tier is 12 side triangles + 12 base-cap triangles = 24 triangles. The trunk is
  unchanged.
- Predicted triangles: 148 + 24 = **172**.
- Predicted vertices: the triangle soup is non-indexed, so 3 vertices per
  triangle: 444 + 72 = **516**.
- Predicted bounds: unchanged at `[-1.68, 0, -1.68] .. [1.68, 8, 1.68]`
  (float32). Tier 0 still starts at `0.12 * 8 = 0.96 m` with radius
  `0.21 * 8 = 1.68 m`; the top apex is still `height = 8 m`.
- Predicted visual: one extra foliage tier, a denser stack, same trunk and
  footprint. The bottom tier becomes shorter (apex moves from 3.49 m to 3.31 m)
  because the tiers are distributed across the same 0.12H..H span.
- Predicted validation: `triangles-max 400` still passes; `watertight` still
  passes because each cone is closed; `max-extent 9` still passes. The contract
  bounds should not drift, so `regen` should report a match.

## Observed

Pending regeneration.
