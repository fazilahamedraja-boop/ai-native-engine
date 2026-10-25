# Phase 19 evidence

Evidence for the Phase 19 voxel sandbox. Every directory here is a timestamped
run. Accepted runs are named in `docs/phase19/REPORT.md`; failed runs are kept
deliberately so the failures that shaped the fixes are still reviewable.

Nothing in this tree is generated after the fact. Each `run.json` was written by
the runner that performed the work. The one exception is `web/`, which is a
browser session recorded by hand (Playwright MCP plus `ffmpeg`) rather than by a
runner; `web/web-verification.json` is the record of what was observed.

## Layout

```text
evidence/
  runtime/        windowed gameplay observation + 1280x720 captures
  repair/         controlled-defect repair experiment (disposable copies)
  measurements/   CPU timings, world counts, windowed performance monitors
  export/         native Windows build verification + window capture
  web/            browser session on http://127.0.0.1:8790/ (frames + clip)
  agent-runs/     preserved external implementation-agent attempts
  agent-run-console.txt
```

## Accepted runs

| Run | Result |
| --- | --- |
| `runtime/2026-10-25T05-55-04-354Z` | 12/12 observation checks, 9 captures |
| `repair/2026-10-25T06-02-23-740Z` | defect 14/15, agent repair 15/15, canonical unchanged |
| `measurements/2026-10-25T06-05-56-931Z` | world 32x16x32, 6181 solid, 16 chunks |
| `export/2026-10-25T06-11-40-680Z` | 12/12 packaged checks, real window capture |
| `web/` | 6/6 browser interactions, 6 frames + 7.25 s clip |

## Accepted artifact hashes

| File | Bytes | SHA256 |
| --- | --- | --- |
| `runtime/2026-10-25T05-55-04-354Z/run.json` | 35544 | `5a3dcc622d32167cb16c538039cd2516049f761d1ed398f38e56ce64c8649c51` |
| `runtime/2026-10-25T05-55-04-354Z/observations.json` | 7271 | `29feb30792ef8586f4712190590ec55c5037917897fe40b177d6f9ba302965f0` |
| `runtime/2026-10-25T05-55-04-354Z/spawn.png` | 267099 | `c9900db02d256b025ae07844196c03987ffa05e92d721b5bdcf2c3d04b2e525e` |
| `runtime/2026-10-25T05-55-04-354Z/movement.png` | 247071 | `31f9f82d5f8e1dd074b2e6a40cd9bf76fadf6dfc20fbcf9512a96fb87caecdbc` |
| `runtime/2026-10-25T05-55-04-354Z/jump.png` | 310721 | `5424acc3899932325219c56a3403058a25e2507f04346e3330d9bb12dd242226` |
| `runtime/2026-10-25T05-55-04-354Z/targeting.png` | 320914 | `7719094ba1cb48d96a4e2047f58a858603222f6463f2b6cc53b41199cce2efbb` |
| `runtime/2026-10-25T05-55-04-354Z/mining.png` | 348061 | `eee586739b83b1c24d30f8dbda4243c395a7d6bba7ff62957c750e8535fef8c1` |
| `runtime/2026-10-25T05-55-04-354Z/placement.png` | 156864 | `4c83439976ec1bb4504519ad4fea874951ad5637cce260e42e26c8c4e81c1810` |
| `runtime/2026-10-25T05-55-04-354Z/hotbar.png` | 263626 | `19a0841a9c5731dc2c47094c6b7d6961d286d670c34b9ead8a55bc760e2bd77c` |
| `runtime/2026-10-25T05-55-04-354Z/save.png` | 250803 | `0a2cf834d87726318908cc0210b1b2bd88f2ae2efe604c4d877b2a86f6aa5870` |
| `runtime/2026-10-25T05-55-04-354Z/reload.png` | 250494 | `d06d5de1e456c64e51a3ed27b37b4283903b4ad598215d492f907e27567b8077` |
| `repair/2026-10-25T06-02-23-740Z/run.json` | 2354 | `6b505cafa59ae650f3015a7b8261f83d41453cdbab889429209d0518dfede58a` |
| `repair/2026-10-25T06-02-23-740Z/defect-suite/hidden-suite.json` | 2410 | `2ec26b2dcf87fd4ab78f6b2742cf5ac9e9c98e8bb0b105301faef67d2e59344e` |
| `repair/2026-10-25T06-02-23-740Z/agent-attempt/hidden-suite.json` | 2403 | `1faa4400b267faac050280b2675514fa30c69b98b48fc25a781d168b26698b0e` |
| `repair/2026-10-25T06-02-23-740Z/agent-attempt/voxel_data.gd` | 8713 | `338d3ee055fc605333271c1ed725237812cd2c8f5bffa56ad915583479ea0b27` |
| `measurements/2026-10-25T06-05-56-931Z/run.json` | 1128 | `33be2224053cd72fe81eab7cd348d7c7e6070a102958d2021dd068517f3dcf5d` |
| `measurements/2026-10-25T06-05-56-931Z/cpu-measure.json` | 1152 | `d04c407a4d033a8813e35375cb6acf53e77dc5c49a895f422caae8bfb8b53e14` |
| `measurements/2026-10-25T06-05-56-931Z/runtime.json` | 1585 | `a63100f4e3534ea14e2d1da74621a02f69de6d0f080db0504c983d8ea5a8399b` |
| `export/2026-10-25T06-11-40-680Z/run.json` | 4229 | `d542b88e6768934d841760a6c03006b0e9ff3cbcc7067044801ab81c275e3a04` |
| `export/2026-10-25T06-11-40-680Z/packaged-window.png` | 322349 | `35cf3d6eb639359a7b289f8d062ec794ce94ebe03c67bd0ebd1e5b264be32e7b` |
| `web/web-verification.json` | see file | recorded in the file itself |
| `web/page-load.png` | 278566 | `dfe708b8a15904813eef8fb9cd0e11b42901c649f75bff190345d85f642b2599` |
| `web/mined.png` | 290453 | `34e275120163226a0b63ceb5c5995778084f241f01f0ad6397b6e0c978408a6b` |
| `web/moved.png` | 238613 | `2bf37e3287a96059e8f71a207cc44b8b1db7cd570ee161ec6900c16c963babaf` |
| `web/jumped.png` | 294112 | `f91f41cd3b5f842604478cc5e0b13550de71d495ebb4f144e2f801634f5fca1d` |
| `web/saved.png` | 253603 | `bdac85296203e66bdbdea813916971c3bfb40c80382a62d8fdc03e9fb76ae933` |
| `web/loaded.png` | 254452 | `4e43af697a92ea2b507fd56d0d94f7135083b03a27bd2a2324bac9d7b084a853` |
| `web/playthrough.mp4` | 583648 | `a1557021e90930fe8d7bc1929c6453bdcc12489d57a82f13ccb93ff7412cd33a` |

The exported binary itself is **not** stored here:

| Artifact | Bytes | SHA256 |
| --- | --- | --- |
| `experiments/godot-harness/voxel/build/voxel-sandbox.exe` | 109235296 | `1ade5406fb14049b6c077f751cf4eba1bf8237014030fcbc05c7d7f77ba652bb` |

`voxel/build/` is git-ignored, matching `game/build/`. Rebuild it with the
export command in `docs/phase19/REPORT.md`; the hash will only match on the same
Godot version and export settings.

## Preserved failures

| Run | What happened |
| --- | --- |
| `runtime/2026-10-25T05-50-50-624Z` | Runner treated `setup()` as a snapshot; the bridge returns a reply envelope |
| `runtime/2026-10-25T05-51-52-107Z` | Saved state omitted the `save` block, so the save check could not read it |
| `runtime/2026-10-25T05-52-29-297Z` | 11/12 - `reload-event` mismatched because `harness_hash()` included the tick counter |
| `repair/2026-10-25T05-59-10-201Z` | Runner refused to inject: literal match assumed LF, checkout is CRLF. No agent ran |
| `repair/2026-10-25T05-59-48-987Z` | Injected flat-terrain defect was masked by seed-dependent trees; hidden suite still passed. No agent ran |
| `export/2026-10-25T06-08-43-608Z` | Wrong bridge command name (`setup` instead of `harness_setup`); 2/2 then error |
| `export/2026-10-25T06-09-03-921Z` | 11/12 - capture script filters titles containing `deflect` |
| `export/2026-10-25T06-10-38-770Z` | 11/12 - same script, and the child process was spawned with a hidden window |
| `agent-runs/implementation-2026-10-23T17-06-43-470Z` | 3 rejected implementation attempts; attempt 3 ended with HTTP 429 `FreeUsageLimitError` |

## Reproduction

From `experiments/godot-harness`:

```powershell
godot --headless --editor --path voxel --quit
godot --headless --path voxel -s res://tests/run_voxel_data_tests.gd
godot --headless --path voxel -s res://tests/run_voxel_tests.gd
node controller/voxel-observe.mjs --out-dir ../../docs/phase19/evidence/runtime/<run>
node controller/voxel-measure.mjs
node controller/voxel-defect.mjs --timeout-ms 600000
godot --headless --path voxel --export-release "Windows Desktop" voxel/build/voxel-sandbox.exe
node controller/voxel-export-verify.mjs --exe voxel/build/voxel-sandbox.exe
npm run play:voxel   # Web export + loopback server on http://127.0.0.1:8790/
```

Runners write to a new timestamped directory and refuse output paths outside
`docs/phase19`, so reproducing a run never overwrites the evidence above.
