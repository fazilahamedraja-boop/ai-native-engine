# Injected defect not detected (experiment design bug)

The first injected defect replaced procedural terrain height with a constant.
The hidden suite still passed: tree placement is seed-dependent and creates
surface-height variation, so `data-generation-deterministic` and
`data-height-variation` stayed green. The reported block counts did change,
which proves the suite really ran the modified module rather than a cached one.

No agent ran. The experiment was re-designed with a raycast `previous`-cell
off-by-one, which the `data-raycast-*` checks assert directly.
