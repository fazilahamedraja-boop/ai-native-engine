# Phase 10 - Stage A addendum: Godot MCP inspection

Status: read-only inspection completed. The Godot MCP server was not used to
control the Phase 10 fixture.

## Observed server

- server: `godot-mcp` version `2026.10.15`
- contract version: `1`
- transport: HTTP
- bridge URL: `ws://127.0.0.1:9080`
- bridge connected during inspection: `false`
- active scene: `null`
- Godot editor project connected: none

The server was reachable for capability discovery, but its Godot addon bridge
was offline. Runtime, input, testing, and debugger commands therefore could not
be exercised without opening an editor session and enabling the addon.

## Enabled capabilities

The default configuration enabled these toolsets:

- `core` (diagnostics and toolset management)
- `inspection` (read-only project, scene, and node inspection)
- `scene_edit` (mutating scene/node/script/signal editing)
- `runtime` (headless project runs, output, screenshots)
- `scripts` (GDScript read/write/parse checks)
- `resources_edit`, `project`, `editor`, `physics`, `scene_3d`
- `input` (simulated key/mouse/action input; needs a play session and runtime
  probe)
- `testing` (scenario runs, live assertions, screenshot comparison, fuzzing)
- `profiling`, `batch`, `analysis`, `debugger`, `asset_import`, `composite`

Disabled by default: `animation`, `particles`, `navigation`, `audio`, `tilemap`,
`theme_ui`, `shader`, `input_map`, `export`, `visual_shader`,
`project_scaffold`.

## Why Phase 10 does not depend on it

The MCP is editor/runtime-probe based. Its live control surface requires a
connected Godot editor, an addon WebSocket bridge, and `MCPRuntimeProbe` for
game input/inspection. It does not provide the Phase 8/9 requirement of a
controller-owned headless process, project-local real fixed-tick advance, or an
owned-process stop path.

The existing project-local harness already provides those operations, so Phase
10 continues to extend it. This is a deliberate reuse decision, not a claim
that the MCP is incapable. The MCP remains useful for editor-assisted scene
authoring and interactive debugging when a Godot editor session is available.

## Follow-up

No repository state, fixture, scene, or editor project was modified by this
inspection. The Stage A design's earlier statement that the MCP was not exposed
in this session is superseded by this addendum: it was exposed but offline.
