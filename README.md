# ai-native-engine

A lightweight, AI-authorable game runtime. The agent writes text, renders, reads
the pixels back, inspects state numerically, and self-corrects.

**Phase 0 complete:** deterministic render + capture.

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
__engine.version                        // "0.0.1-phase0"
__engine.inspect(t?)                    // JSON: step, time, state hash, transforms, draw stats
__engine.step(n?)                       // advance n fixed steps (1/60 s each)
__engine.reset()                        // back to step 0
__engine.capture(name, t?)              // render, POST PNG, return {path, bytes, hash}
__engine.dataUrl(t?)                    // same frame as a data URL
```

`capture` writes to `.cache/captures/<name>.png` via the dev-server sink in
`vite.config.ts`, so the agent gets a real file it can open.

## Determinism contract

- Fixed timestep: `FIXED_DT = 1/60`.
- Simulation state is a pure function of the step counter. Nothing reads the clock.
- Renderer uses `pixelRatio = 1` and a fixed 800x500 buffer.
- `seek(t)` quantizes to a whole step, so `inspect(1.5)` is always step 90.

Verified: `capture("a", 0)` twice produces byte-identical PNGs
(`17D020EF…`), and `inspect(1.5)` reports `hash 09529087`, `step 90`,
`rotY 0.75` — matching `0.5 rad/s × 1.5 s`.

## Layout

```
src/core/hash.ts        quantized FNV-1a state hash
src/render/scene.ts     renderer, scene, pure-function simulation
src/devtools/api.ts     window.__engine
src/main.ts             boot
vite.config.ts          /__capture sink
```

## Conventions (never renegotiate)

meters · +Y up · +Z forward · floor-center origin for props · feet-center for characters
