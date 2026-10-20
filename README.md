# ai-native-engine

A lightweight, AI-authorable game runtime. The agent writes text, renders, reads
the pixels back, inspects state numerically, and self-corrects.

**Phase 0 complete:** deterministic render + capture.
**Phase 1 complete:** versioned scene document, world/physics layer, orbit and
third-person cameras, hot reload that preserves simulation state.
**Phase 2 complete:** asset contract, three procedural assets, imported humanoid,
contact sheets and a predicted parameter change. Evidence:
[`docs/phase2-exit.md`](docs/phase2-exit.md).
**Phase 3 benchmarked:** five prompt-driven loop cycles, including a caught
visual failure and a deliberate socket break. Content-token (estimated) and
failure-detection targets pass; the 60 s end-to-end target does not, though the
mechanical path is 1-2 s. Evidence: [`docs/phase3-review.md`](docs/phase3-review.md).

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run typecheck
npm run build
```

## The agent surface

Everything the agent needs is on `window.__engine`. The engine source is not part
of the agent's working set.

```js
__engine.version                       // "0.1.0-phase1"
__engine.scene()                       // the live, defaulted SceneDoc

__engine.applyScene(rawObject)         // atomic: {ok, errors[], reload}
__engine.inspect()                     // {step, t, hash, player, camera, nodes[], colliders[], reload}
__engine.stats()                       // renderer counters only: {drawCalls, triangles, objects}

__engine.pause() / resume()
__engine.reset()                       // step 0, spawn, initial camera
__engine.step(n?)                       // advance n fixed steps, implies pause
__engine.setInput({moveX, moveZ, jump})// world-space movement, edge-triggered jump
__engine.setOrbit({yaw, pitch, distance})

__engine.capture(name)                 // render, POST PNG, return {path, bytes, step, hash}
__engine.runTests()                    // {passed, results[], statePreserved, hash}
```

`capture` writes to `.cache/captures/<name>.png` via the dev-server sink in
`vite.config.ts`, so the agent gets a real file it can open.

`inspect()` reads World only and never touches THREE objects. Renderer counters
are a separate `stats()` call on purpose: draw calls must not be able to change
what "state" means.

## Determinism contract

- Fixed timestep `FIXED_DT = 1/60`. Nothing in the simulation reads the clock.
- `pause()` + `step()` is the deterministic path. The rAF loop only advances the
  world while unpaused.
- Renderer uses `pixelRatio = 1` and a fixed 800x500 buffer.
- State hash covers `step + player pos/vel/grounded + camera yaw/pitch/distance`
  (or third-person yaw/distance/height). Node transforms are configuration and
  are excluded — a material edit must not invalidate a state hash.
- `capture()` pauses first, so a frame cannot be overwritten between render and
  `toBlob`.

Verified: `reset(); step(120); capture(...)` twice in one session produced
byte-identical PNGs, SHA256 `A097AC68…`, 41098 bytes, hash `4bc0682a`.

## Scene document

`content/scenes/phase1.scene.json`, validated by `src/schema/scene.ts`.

```jsonc
{
  "version": 1,                 // anything else is rejected with the expected value
  "id": "phase1",
  "units": "m", "up": "+Y", "forward": "+Z",   // literals, not free text
  "environment": { "background": "#0e1428" },
  "player": {
    "spawn": [0, 3, 0],         // FEET position
    "radius": 0.35, "height": 1.7,
    "speed": 4.5, "jumpSpeed": 6, "gravity": -20
  },
  "nodes": [ /* group | mesh | light | camera */ ]
}
```

Node fields: `id` (lowercase slug), `parent`, `visible`, `transform`
(`pos`, `rot` in **degrees**, `scale`), plus type-specific fields.

- `group` — transform only.
- `mesh` — `geometry` (`box{size}` | `plane{size:[w,h]}` | `sphere{radius,segments}` |
  `capsule{radius,height}`), `material` (`color`, `roughness`, `metalness`),
  `collider` (`{shape:"none"}` default, or `{shape:"aabb", size?}`).
- `light` — `kind: "ambient" | "directional"`, `color`, `intensity`, `dir`
  (directional only; setting `dir` on ambient is an error), `castShadow`.
- `camera` — `rig: "orbit" | "third-person"`, `fov`, `near`, `far`, `orbit{...}`,
  `thirdPerson{...}`. **Exactly one camera node is required.**

Graph rules: ids unique, parents must exist, cycles rejected, depth ≤ 16,
capsule `height > 2 * radius`, and a `plane` mesh cannot derive a collider
(zero thickness) — it must declare `collider.size`.

Transform composition is `world = parentWorld · T · R · S` with
`R = Rx · Ry · Rz` (degrees), matching THREE's `XYZ` Euler. Matrices are computed
in `src/core/math.ts`; World does not import THREE.

### Errors

Every rejection carries `{path, code, message}` and nothing is partially applied:

```
nodes[3].material.color: expected a #rrggbb hex colour [invalid_format]
nodes[7].type: unsupported node type "sprite"; supported: group, mesh, light, camera
nodes[3].transform.scale[0]: Too small: expected number to be >0 [too_small]
nodes[2].parent: parent chain contains a cycle at 'ground'
nodes: scene must contain exactly one 'camera' node, found 2
```

## Asset contract

Phase 2. An asset is a text manifest plus a pure build function; the artifact is
never checked in. `src/assets/schema.ts` validates the manifest, `kinds.ts` owns
the ontology, `validate.ts` judges what was built. Phase 2 exit evidence,
including four-view contact sheets and the predicted pine change, is in
[`docs/phase2-exit.md`](docs/phase2-exit.md).

Six concepts, and no more:

| concept | meaning | mutable by |
|---|---|---|
| `kind` | closed vocabulary | schema only |
| `provenance` | generator + pinned version + seed, or file + sha256 | author |
| `params` | semantic knobs, enums or bounded numbers | author |
| `contract` | origin, declared bounds, declared sockets | author, then verified |
| `tests` | extra promises the asset makes | author |
| `override` | colour / roughness / metalness | instance |

Four kinds, each with contract defaults and required sockets:

| kind | origin | scaleClass | required sockets | params |
|---|---|---|---|---|
| `sword` | `grip` | handheld | `grip`, `tip` | length, bladeWidth, guard, material |
| `rock` | `base-center` | prop | — | size, family, detail, moss |
| `pine` | `base-center` | prop | `base` | height, tiers, spread, snow |
| `character` | `feet-center` | character | `head`, `hand_l`, `hand_r` | none (imported) |

Adding a kind is a params schema plus a row in `KIND_SPECS`. If it also needs a
change in `validate.ts`, the ontology is wrong.

**Bounds and sockets are declared, not derived.** A generator change that
silently grows an asset must fail validation rather than quietly move every
placement built on it. `artifactHash` covers geometry, sockets, material and any
vertex colours, so the same `(params, seed, generatorVersion)` must reproduce the
same hash.

**Colour can be per-vertex.** `MeshData.colors` is optional sRGB RGB, one triple
per vertex, and the material colour multiplies it. That is how one rock carries
stone and moss, and one pine carries bark, foliage and snow, without three
materials. Colours fold into the hash only when present, so assets that never had
them keep the hashes they were published with.

Three checks always run and cannot be declared away: the artifact is non-empty,
every coordinate is finite, and measured bounds match the contract within
`1e-4 m`. Every declared socket must also exist and match within `1e-4 m`; a
socket outside the mesh is a warning, not an error — it is legal, and usually a
stale coordinate. `tests[]` adds `origin-at`, `sockets-present`, `max-extent`,
`triangles-max`, `watertight`, `area-positive`.

Errors use the same `{path, code, message}` shape as scene errors, plus
`expected`/`measured` where a number is involved.

```bash
npm run test:assets    # 123 tests: contract, sword, rock, pine, framing, GLB index, decode, import
```

### Inspection

```bash
npm run assets -- list
npm run assets -- validate [--json] [id...]
npm run assets -- inspect sword-iron-01
npm run assets -- preview sword-iron-01 --view front
npm run assets -- regen sword-iron-01 [--accept]
```

`inspect` prints one JSON object: provenance, params, declared contract, the
measured artifact (hash, bounds, sockets, material, triangles, generation ms),
override, tests, errors, warnings. The CLI and the preview page return the same
shape, so the agent does not have to learn two.

`regen` compares the artifact against the declared contract. Without `--accept`
it reports drift and exits 1. With `--accept` it rewrites bounds and sockets —
but refuses if any check other than contract drift is failing, so a broken
generator or importer cannot be papered over.

### Preview page

`http://localhost:5173/?asset=<id>&view=<view>`, where view is `three-quarter`
(default), `front`, `side` or `top`. `window.__preview` is the agent surface:

```js
__preview.inspect()          // CLI JSON + view + camera
__preview.setView('side')    // re-render, URL updated in place
__preview.capture('name')    // PNG through the same sink, returns {path, bytes}
```

All views share one camera distance, derived from the asset's bounding sphere.
That makes two captures directly comparable and makes a size change visible. The
cost is that `top` on a tall asset is small — it exists to read the
cross-section. Captures are byte-identical across repeats: `5CBCB50C…` for a
procedural asset, `5C5DB509…` for the placeholder character, and `6719C524…`
for `humanoid-01`. Metals are lit by a baked `RoomEnvironment`, without which
`metalness 0.7` renders as flat grey.

### Character import

A character is the one kind that is imported rather than generated. The manifest
pins the GLB by SHA-256, and the build path is:

```
GLB bytes -> container/JSON index -> accessor decode -> MeshData -> validate
```

`src/assets/import/glb.ts` indexes the JSON chunk first: node names, transforms,
skins, animations, and declared bounds. That keeps malformed files and
unsupported structures cheap to reject, and it is the evidence the manifest
contract is checked against. Non-triangle primitives, accessors without min/max,
parent cycles and dangling indices are rejected at this stage, because the index
is the evidence the manifest will have. `src/assets/import/decode.ts` then reads
the BIN chunk into the same `MeshData` every procedural asset produces.

Supported: float32 VEC3 positions and normals, indexed (uint8/16/32) and
non-indexed `TRIANGLES`, accessor and bufferView offsets, interleaved
`byteStride`, node TRS or matrix transforms, and one material covering base
colour, roughness, metalness and double-sided. Normals use the inverse-transpose;
a mirroring node reverses winding. If `NORMAL` is absent the primitive is
de-indexed and flat normals are generated, as glTF requires.

Rejected explicitly, never silently dropped: skins, morph targets, textures,
non-opaque or emissive materials, extensions, sparse accessors, external or
data-URI buffers, multiple buffers, unsupported attributes (`COLOR_0`,
`JOINTS_0`, `WEIGHTS_0`), mixed materials, singular transforms, out-of-range
indices and degenerate triangles. Animation clips are indexed but warn
(`animations_ignored`): the manifest describes the static mesh, and nothing is
played.

```bash
npm run assets -- index content/assets/character/placeholder-character.glb
npm run assets -- decode content/assets/character/placeholder-character.glb
npm run assets -- character content/assets/character/placeholder-character.glb
```

`decode` prints decoded bounds, sockets, material, triangle count and artifact
hash beside the declared index. `character` applies the kind contract: bounds
must exist, triangles must be non-zero, and `head`, `hand_l` and `hand_r` must
each resolve to exactly one node. Names are normalised (`Hand.L` -> `hand_l`),
and two nodes claiming one slug is an `ambiguous_socket`.

`buildImportedAsset` refuses a source whose SHA-256 differs from the manifest,
and reports an importer-version mismatch instead of guessing. The browser
catalog fetches the bundled GLB and computes the digest with WebCrypto, so the
preview and the CLI build the same bytes; the placeholder's artifact hash is
`4aace1dd1ecb9259` in both.

`humanoid-01` is the first character asset: a static, unrigged humanoid assembled
from 22 boxes, 1.82 m tall, feet at the origin, facing +Z. The GLB is 33,728
bytes, sha256 `1e5628f8…`; `scripts/make-humanoid.py` produced identical bytes on
three consecutive headless runs. It decodes to 264 triangles / 528 vertices,
bounds `[-0.34, 0, -0.12] .. [0.34, 1.82, 0.175]`, sockets `head (0, 1.7, 0)`,
`hand_l (-0.295, 0.88, 0)`, `hand_r (0.295, 0.88, 0)`, and a single-sided clay
material `#a2816c` (roughness 0.62). Artifact hash `24a10e9da432a551`;
`assets validate` is 6/6. The Phase 3 manifest override renders it slate
`#6f7f95` at roughness 0.5 without changing the artifact hash.

The export -> import -> preview sequence ran end to end: `character` accepted the
GLB, `regen --accept` wrote the measured contract, `validate` passed every
declared test including `watertight`, and the browser preview produced the same
artifact hash as the CLI. Two three-quarter captures are byte-identical
(SHA256 `6719C5247EC0E321…`). **Milestone 5 is complete** with this generated
character; it is deliberately blocky and has no rig, animation or textures.

`placeholder-character.glb` remains the minimal fixture: six boxes, 72
triangles, no armature, no animation, feet at the origin, sha256 `1af652d7…`.
`scripts/make-character.py` regenerates it headlessly and produced identical
bytes on three consecutive runs. It is genuinely Blender-exported and remains
useful as the smallest real container/index/decode case; it is not the milestone
asset.

## Hot reload

Saving `content/scenes/*.json` pushes the text to the page over the Vite
websocket (`scene-watch` plugin). No module reload, no page reload — the running
`World` is only rebuilt from the new document.

**Compatibility is decided from the effective collision world**, not from a
config diff: the fingerprint is every collider's world-space AABB (sorted by node
id) plus player radius/height.

| fingerprint | player capsule vs new colliders | result |
| --- | --- | --- |
| unchanged | — | state fully preserved, `stateReset: null` |
| changed | no overlap | position + velocity preserved, grounded re-probed, `stateReset: "colliders-changed"` |
| changed | overlap | reset to spawn, `stateReset: "player-inside-collider"` |

Camera state is preserved unless the camera node's id or rig changes. Material,
colour, geometry and light edits never reset the player — they do not alter the
collision world.

## Physics

`src/physics/capsule-aabb.ts` + `src/physics/step.ts`. Vertical capsule
(feet + height, radius) against world-space AABBs. One step is:

```
input → horizontal velocity (instant, no acceleration) → jump edge → gravity
      → move → push out of penetrating boxes (4 iterations, deepest first)
      → support probe → velocity cleanup
```

Gravity is applied *before* the position update (semi-implicit Euler), so the
jump is lower than the continuous solution:

- apex `0.850 m` at **step 17**, held through step 18 (velocity hits 0 and the
  step displaces by 0 — the apex is a two-step plateau)
- landing at **step 35**, airtime 583 ms
- continuous physics would give `v²/2g = 0.900 m`

Grounded is a **support probe**, never a resolution flag: the capsule's bottom
sphere must be within `radius + 0.02 m` of a surface whose outward normal has
`·up ≥ cos 45°`. Standing beside a wall therefore stays grounded; touching a wall
alone never does.

Measured, not asserted:

```
scene-settle           grounded=true feetY=0.000000 supportTop=0.000000 vy=0
player-avatar          maxTrackingError=0.00e+0 lift=0.8500m landedAt=34
                       restingError=0.00e+0 notASceneNode=true
jump-apex-and-landing  apex=0.8500m (model 0.8500) at step 17; landing=35
wall-adjacency         x 0.000 -> 1.400; drift 0.00e+0; grounded=true; penetrating=[]
determinism            identical hash 5f154676
reload-compatibility   away=colliders-changed preserved=true;
                       onto=player-inside-collider resetToSpawn=true
```

`x → 1.400` is the wall face at `1.75` minus radius `0.35`; the residual drift is
exactly zero, so the player is blocked rather than sliding.

### Limits (deliberate, Phase 1)

AABBs only. No slopes, stairs, step-up, moving platforms, rotated colliders
(enveloped by their axis-aligned bounds), CCD, friction, bounciness, or pushing
dynamic bodies. Corner cases can pop. Horizontal velocity is reported from actual
displacement, so a blocked player reads `0` rather than the commanded speed.

## Player avatar

A single cream capsule, drawn by the renderer from `world.player.pos` every
frame. It is **render-only**:

- not a `SceneDoc` node, so `inspect().nodes` never lists it
- contributes no collider, so physics cannot see it
- has no skeleton, no animation, no state of its own

`syncPlayer(world)` is the whole link: group origin = `feet + height/2`, with the
capsule geometry rebuilt only when `player.radius`/`player.height` change.
`avatarFeet()` reads the position back out of the scene graph, which is why the
`player-avatar` test can prove the derivation instead of re-asserting the input.

Verified: tracking error `0` at rest, at the jump apex (`0.850 m`), at landing,
and after settling; screen position `(400, 293.3)` unchanged before and after a
4.5 m walk under the third-person rig, i.e. the camera follows rather than drifts.

## Build budget

The budget is **400 kB of gzipped JavaScript** — every `.js` file the browser
must download to run the engine, summed, gzip level 9, kB = 1000 bytes. HTML and
source maps are not counted. `npm run size` runs the build and measures it
directly with `node:zlib` so the number does not move when Vite changes how it
reports sizes.

```
index-BSyaA68O.js   raw 722751   gzip 187860
gzip total 187860 B (187.9 kB) of 400 kB budget — 47.0%
```

That includes THREE, Zod, the GLB decoder and the whole devtools surface. Vite's
own log reports 189.87 kB for the same file because it uses a different gzip
setting; the script above is authoritative.

## Cameras

Exactly one camera node is the active camera; there is no switching.

- `orbit` — yaw/pitch/distance around `target`; pitch clamped ±89°, distance
  1.5–40. Pointer drag and wheel drive the same `setOrbit` the tests use.
- `third-person` — position = player `- forward(yaw)·distance + height`, looking
  at player `+ lookHeight`. Follows position every frame, no smoothing, yaw
  user-controlled. Movement input is rotated into camera space for this rig only.

## Layout

```
src/schema/scene.ts       Zod grammar + graph validation (no THREE)
src/core/math.ts          vec3 / mat4, degrees, column-major
src/world/world.ts        SceneDoc -> World nodes, colliders, player, camera
src/physics/              capsule-vs-AABB primitives, fixed step
src/camera/rigs.ts        camera state + poses (no THREE)
src/render/renderer.ts    World -> THREE draw list, flat, rebuilt per revision
src/render/geometry.ts    MeshData -> BufferGeometry (the only asset/renderer seam)
src/assets/schema.ts      manifest grammar, per-kind params, ontology checks
src/assets/kinds.ts       4 kinds: contract defaults, required sockets, params
src/assets/generators/    pure build(params, rng) -> MeshData + sockets
src/assets/import/glb.ts  GLB container + JSON index (no geometry decode)
src/assets/import/decode.ts accessors -> MeshData, sockets and material
src/assets/catalog.ts     bundled manifests; fetch + hash imported GLBs
src/assets/validate.ts    declared bounds/sockets + assertion runner
src/assets/cli.ts         list | validate | inspect | preview | regen | index | character | decode
src/preview/              standalone asset viewport + window.__preview
src/devtools/state.ts     snapshot + state hash
src/devtools/tests.ts     runTests()
src/devtools/node-tests.ts Node suite runner (same report shape)
src/engine.ts             the agent surface
src/main.ts               boot, input, rAF loop, hot-reload listener
vite.config.ts            /__capture sink + scene-watch
scripts/make-character.py reproducible placeholder GLB fixture
scripts/make-humanoid.py  reproducible humanoid GLB character
```

Renderer note: nodes are drawn as a **flat list** using precomputed world
matrices. The hierarchy lives in World, so THREE never becomes a second source of
truth.

## Conventions (never renegotiate)

meters · +Y up · +Z forward · floor-center origin for props · feet-center for characters

## Known gaps

- `inspect()` reports node world position and scale, not world rotation.
- `regen --accept` rewrites the entire manifest in expanded JSON; a two-value
  edit produces a large diff until a canonical formatter exists.
- The pine `snow` parameter adds the predicted geometry, but stacked tiers hide
  the snow bands. The shipped pine stays `snow: false` until the generator
  places the band visibly.
- The Phase 3 60 s full-cycle target is not met end-to-end (core cycles
  152-385 s); the mechanical path is 1-2 s. Agent/review latency is the
  bottleneck.
- The avatar has no facing direction, so it reads as a capsule rather than a
  character.
- Imported characters are static meshes: no skinning, animation playback, morph
  targets, textures or advanced material graphs. One material per asset; multiple
  primitives with different materials are rejected.
- The preview's GLB digest uses WebCrypto, so imported assets load only from
  localhost or HTTPS.
- `humanoid-01` is deliberately blocky, unrigged and untextured; it proves the
  import path, not production character art.
- No shadow-quality tuning, no mesh instancing, no LOD.
