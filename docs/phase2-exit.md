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

## Observed (after regenerating)

- `assets inspect pine-nordic-01`: **172 triangles**, **516 vertices**, artifact
  hash `62e253c437e66a18`.
- Bounds: unchanged at `[-1.68, 0, -1.68] .. [1.68, 8, 1.68]` (float32).
- `regen pine-nordic-01`: contract matches artifact. No bounds or socket drift.
- `validate`: PASS (5/5 manifests overall).
- The extra foliage tier is visible; the trunk, footprint and height are
  unchanged. The bottom tier is shorter, as predicted.
- Captures:
  - before: `pine-before-tiers6.png`, SHA256
    `1385b5be8d61b580bbe079a9730844956c8ebd3d62c255f7ddd9019966949ee4`
  - after: `pine-after-tiers6.png`, SHA256
    `7d0c8c9013e1a22ecf47ddf19f8d8e7e0d592f0a442ac3eb41f316d9b5fe7d9f`
  - the after capture and the contact-sheet three-quarter capture are
    byte-identical.

## Contact sheets

| asset | kind | triangles | artifact hash | sheet | SHA-256 |
|---|---|---|---|---|---|
| `sword-iron-01` | sword | 90 | `775afbcb1721bd57` | [sheet](contact-sheets/sword-iron-01.png) | `876d58ce…` |
| `rock-granite-01` | rock | 320 | `a78d1aface8da1f6` | [sheet](contact-sheets/rock-granite-01.png) | `d12e3c9b…` |
| `pine-nordic-01` | pine | 172 | `62e253c437e66a18` | [sheet](contact-sheets/pine-nordic-01.png) | `1d3b7f7f…` |
| `humanoid-01` | character | 264 | `24a10e9da432a551` | [sheet](contact-sheets/humanoid-01.png) | `3d59d43b…` |

The predicted parameter change is shown side by side in
[`pine-nordic-01-param-change.png`](contact-sheets/pine-nordic-01-param-change.png),
SHA256 `ccd7f219…`.

`placeholder-character` is the minimal import fixture (72 triangles, hash
`4aace1dd1ecb9259`), not one of the four Phase 2 exit assets, so it has no
contact sheet.

## Exit checklist

- [x] Three procedural assets: sword, rock, pine.
- [x] One imported character: `humanoid-01`.
- [x] All self-tests passing: `assets validate` is 5/5 (including the fixture).
- [x] A contact sheet per exit asset, four views each.
- [x] One predicted parameter change: pine `tiers` 5 -> 6, predicted 172
  triangles / 516 vertices and unchanged bounds; measured exactly that.
- [x] Preview and CLI agree: `pine-nordic-01` is 172 triangles with artifact
  hash `62e253c437e66a18` in both.
