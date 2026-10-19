# ai-native-engine

A lightweight, AI-authorable game runtime. The agent writes text, renders, reads
the pixels back, inspects state numerically, and self-corrects.

**Phase 0 complete:** deterministic render + capture.
**Phase 1 complete:** versioned scene document, world/physics layer, orbit and
third-person cameras, hot reload that preserves simulation state.

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
index-BQ5mm_Df.js   raw 644911   gzip 164822
gzip total 164822 B (164.8 kB) of 400 kB budget — 41.2%
```

That includes THREE, Zod and the whole devtools surface. Vite's own log reports
166.63 kB for the same file because it uses a different gzip setting; the script
above is authoritative.

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
src/devtools/state.ts     snapshot + state hash
src/devtools/tests.ts     runTests()
src/engine.ts             the agent surface
src/main.ts               boot, input, rAF loop, hot-reload listener
vite.config.ts            /__capture sink + scene-watch
```

Renderer note: nodes are drawn as a **flat list** using precomputed world
matrices. The hierarchy lives in World, so THREE never becomes a second source of
truth.

## Conventions (never renegotiate)

meters · +Y up · +Z forward · floor-center origin for props · feet-center for characters

## Known gaps

- `inspect()` reports node world position and scale, not world rotation.
- The avatar has no facing direction, so it reads as a capsule rather than a
  character; that arrives with the Phase 2 character import.
- No shadow-quality tuning, no mesh instancing, no LOD.
