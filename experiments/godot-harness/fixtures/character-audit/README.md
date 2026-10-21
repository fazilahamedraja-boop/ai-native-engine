# Character-audit test fixture

This fixture exists only for Phase 11 evidence. It is not part of the product
content catalog and it is not a new character pipeline.

## Assets

- `assets/humanoid-01.glb` — copied unchanged from
  `content/assets/character/humanoid-01.glb` (SHA-256
  `1e5628f87ef981f952dca4b8408cdb62bf09be406f28f7477632c5e0f87eae5c`). It is
  a rigid hierarchy with 22 meshes and no skin or animation.
- `assets/CesiumMan.glb` — pre-existing glTF Sample Assets model, used only to
  exercise Godot's real skin/skeleton/animation path. It is **not** a new
  skeleton and is not added to product content.

## CesiumMan attribution

Cesium Man, © 2017 Cesium, is licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode). The model
contains the Cesium logo, which is a Cesium trademark and is excluded from the
CC license. Source:
<https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan>.

Downloaded file SHA-256:
`b7001eaeea8254bd44773bcd247e78696d94169388fbb2a1800fc69434e777d9`.

## Run

```powershell
node controller/harness.mjs test --project fixtures/character-audit `
  --script res://tests/run_character_audit.gd --json
godot --headless --path fixtures/character-audit `
  -s res://tests/native_api.gd
```
