# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-hosted Godot 4 editor (WASM/WebGL build in `public/godot.editor.*`) instrumented with a WebMCP tool bridge, so an AI agent can author, mutate, playtest, and record a Godot project entirely inside the page — no local Godot install, no filesystem access. The in-page bridge (`public/mcp_bridge.js`) is the entire system: an IIFE that boots alongside the Godot editor, holds the authoritative project state in memory, and exposes ~35 tools both to the browser's native WebMCP (`navigator.modelContext` / `document.modelContext`) and over a WebSocket relay for headless/remote agents.

## Commands

```bash
npm install
npm test              # verify_catalog_parity.mjs + operation_state_machine.test.mjs (node --test)
npm run verify:catalog # catalog parity check only
node server.mjs        # run the local Express + WebSocket server on :8060 (set PORT to override)
```

There is no build step — `public/` is served as-is. `npm test` is the only automated check; there is no lint config and no browser test runner wired into `npm test` (the `test/*.mjs` scripts outside `operation_state_machine.test.mjs` are ad hoc Puppeteer inspection/capture scripts run manually with `node test/<name>.mjs`, not part of CI).

### Running a single test

```bash
node --test test/operation_state_machine.test.mjs
node --test --test-name-pattern="SHA-256" test/operation_state_machine.test.mjs
```

## Deployment targets

The same `public/` + `netlify/functions/` code ships three ways, kept in sync manually:
- **`server.mjs`** — Express + `ws` server for local dev / Docker (`Dockerfile`), serves `public/` and proxies `/api/*` to the same tool catalog, plus a `/mcp` WebSocket broker.
- **Netlify** (`netlify.toml`, `netlify/functions/{health,rpc,tools}.mjs`) — static `public/` + serverless functions for the stateless HTTP endpoints only.
- **Vercel** (`vercel.json`) — static `public/` with equivalent headers; no serverless functions configured there.

The HTTP/serverless endpoints (`/api/mcp/rpc`, `/api/mcp/tools`, `/api/health`) are **read-only discovery** — `tools/list` and health checks. They deliberately return `-32601` for `tools/call`: actual tool execution only happens inside the live page (native WebMCP or the WebSocket relay to a connected editor), because tools mutate in-memory Godot project state that only exists in that browser tab. When changing the tool catalog, update `netlify/functions/tools.mjs` (`MCP_TOOL_CATALOG`) and the `MANIFEST_TOOLS` block in `public/mcp_bridge.js` together — `verify_catalog_parity.mjs` fails the build if the two ever diverge (name sets, schema shape, or annotations).

COOP/COEP headers (`same-origin` / `require-corp`) are set identically in `server.mjs`, `netlify.toml`, and `vercel.json` — required for the WASM build's SharedArrayBuffer/threading. If you add a new static file type or route, mirror the header rule across all three.

## Architecture of `public/mcp_bridge.js`

Single ~5000-line IIFE, organized into numbered sections (search for `// ====`). Reading order for orientation:

1. **Diagnostic Readiness State Machine** (`DiagnosticState`) — tracks engine/webmcp/session status and `sceneRevision`, the optimistic-concurrency counter every mutating tool must check.
2. **CRC32 / PKZIP builder** — pure-JS zip writer for `godot_export_zip` (no dependency).
3. **Procedural audio synthesizer** — generates the 16-bit WAV SFX suite in-browser.
4. **Session-scoped playtest state machine** — drives `godot_semantic_playtest_step`; rejects non-Neon-Skyrail projects rather than faking state.
5. **3D Runner ("Neon Skyrail") project generator** and **5B. "Echoes of the Orbital Garden" generator** — the two built-in project templates, emitted as complete `.tscn`/`.gd` source trees into the in-memory file dict.
6. **Authoritative native tool manifest** (`MANIFEST_TOOLS`) — the real source of truth for tool implementations (schema + handler). This is what `verify_catalog_parity.mjs` diffs against `netlify/functions/tools.mjs`.
7. **Real-Time 3D Live Scene Mutator** — the `godot_node_spawn`/`_transform`/`_material`/`_delete` family. These mutate the active `.tscn` text directly and hot-restart the editor (`restartEditorWithProject`) for sub-16ms perceived latency, bypassing the full transaction/undo path used by `godot_apply_file_transaction`.
8. **Safe Native WebMCP Registration** — never overwrites an existing `document.modelContext`/`navigator.modelContext`; registers each `MANIFEST_TOOLS` entry defensively.
8B. **Editor-Level Agent Observation Layer** (`AgentObservationHUD`) — the on-page activity feed/banner showing what the agent is doing; `describe()` has a label per tool name that must be kept in sync when tools are added.
8C. **3D Focus Overlay** (`AgentFocusOverlay`) — projects a node's real world position through the real camera and anchors a reticle there, or an edge-clamped direction arrow with a distance label when it falls outside the frustum. It reports `mode: 'hidden'` rather than guessing when no camera pose is available, and publishes its state on `window.__webmcpFocusState` for the verification harness.
8D. **Camera guidance channel** (`CameraGuidance`) — `godot_camera_focus` / `godot_camera_follow`. Ported from `test/camera-guidance.js` (the reference implementation's module) and keeps its four rules: yield to the human for 750 ms after any viewport input; fence every request against the editor-boot generation; coalesce bursts into one camera move; respect `prefers-reduced-motion`.
8E. **Agent surfaces** (`AgentRail`, `CameraControls`, `AgentStatusRail`, `SceneInspector`) — one bottom rail with three controls. `DiagnosticHUD` and `BuildingBlocksHUD` survive only as back-compat shims that drive the rail; don't add UI to them.
9. *(folded into 8E)*
10. **Auto-execute registration & coordinator** — runs on load: registers native tools, wires the `/mcp` WebSocket client (`initWebSocketBridge`, mirrors `server.mjs`'s broker), and boots `initDOM`.

### Three channels — do not conflate them

| Channel | Owns | Mutates scene? | Restarts editor? |
|---|---|---|---|
| **Command** (`EditorCommandChannel`, §5C) | selection, focus, live node add/move/recolour/delete, property and camera reads | Yes, via Godot's own `UndoRedo` | **No** |
| **Guidance** (`CameraGuidance`, §8D) | transient framing of the viewport camera | No | No |
| **Transaction** (`godot_apply_file_transaction`) | whole-file writes, project creation, validation | Yes, via `.tscn` text | Yes |

The command channel is an `@tool` `EditorPlugin` that lives in the *authored project* at `res://addons/webmcp/`. Its source is `public/addons/webmcp/plugin.{gd,cfg}`, embedded verbatim into `mcp_bridge.js` and injected on disk by `withEditorPlugin()` at the `restartEditorWithProject` choke point — deliberately **not** into `activeFilesDict`, so it never appears in exports, undo snapshots, or `godot_inspect_project_files`. After editing the GDScript run:

```bash
npm run verify:plugin
```

which re-embeds it (`scripts/embed_plugin.py`) and fails if the two copies diverge. The plugin source must contain no backticks, `${`, or backslashes — it is embedded as a JS template literal.

Camera framing uses selection plus Godot's `spatial_editor/focus_selection` shortcut, not a direct camera write: `Node3DEditorViewport`'s interpolation fields are private and there is no public API for the 3D viewport camera ([godot-proposals#12112](https://github.com/godotengine/godot-proposals/issues/12112)). Godot already owns the damped fly-to; the plugin only widens `editors/3d/navigation_feel/*_inertia`.

### Two mutation paths — pick deliberately

- **Transactional path** (`godot_apply_file_transaction`, `godot_apply_text_patch`): revision-checked (`expected_revision` must match `DiagnosticState.sceneRevision`), pushes an undo snapshot, fully restarts the Godot editor process to apply. Use for anything script/resource/multi-file, or when undo history matters.
- **Live mutator path** (`godot_node_spawn`/`_transform`/`_material`/`_delete`, via `liveMutateSceneFile`): rewrites the active scene's `.tscn` text in `activeFilesDict` and bumps `sceneRevision`, then applies the change through the **command channel** when the editor plugin is present — no restart, and the edit lands in Godot's real undo stack. It falls back to a full `restartEditorWithProject` when the plugin is absent or the op is rejected. Every result reports `editor_channel` (`command` or `transaction`), `editor_restarted`, and a **measured** `execution_time_ms`; never reintroduce hardcoded latency numbers. `window.__webmcpRestartCount` counts real restarts for regression tests.

Both paths persist state via `persistActiveProjectState()` (IndexedDB) so `godot_restore_project_session` can rehydrate after a page reload without losing revision/undo history.

### Idempotency and long-running ops

Mutating tools accept an `idempotency_key`; results are cached in `idempotentMutations`/`inflightIdempotency` so a retried call replays the prior result instead of double-applying. Operations that can outlive a single tool-call deadline (uploads, transactions) are tracked in `managedOperations` and polled via `godot_get_operation_status`.

### Adding or changing a tool

1. Add/edit the entry in `MANIFEST_TOOLS` in `public/mcp_bridge.js` (schema + handler).
2. Mirror the same `name`/`input_schema`/`annotations` in `MCP_TOOL_CATALOG` in `netlify/functions/tools.mjs` (used by `server.mjs` too, via import).
3. Add a human-readable label in `AgentObservationHUD.describe()`.
   If it drives the editor, add the matching `op` to `plugin.gd`'s `_on_command` match and re-run `npm run verify:plugin` — a test fails if the bridge calls an op the plugin does not dispatch.
4. Run `npm test` — catalog parity, the operation state machine, the scene-graph/projection maths (`test/scene_projection.test.mjs`), and plugin source parity (`test/plugin_source_parity.test.mjs`).

### Honesty rules this codebase has already had to re-learn

- A tool that is not wired to a real editor acknowledgement must throw `EDITOR_COMMAND_UNSUPPORTED`, not fake success. `godot_connect_signal_live`, `godot_resize_gizmo_live`, `godot_live_code_diff`, `godot_hot_reload_property`, and `godot_switch_mode` are still stubs on purpose.
- Never report a latency you did not measure, and never claim `live_streamed` for a path that restarted the editor.
- The scene inspector renders only what `sceneGraphFromFiles` actually parsed. Do not infer gameplay semantics from filename substrings.
- `#game-canvas` is a static element in `index.html` and always exists, so `getElementById('game-canvas') || getElementById('editor-canvas')` can never reach the editor. Route through `resolveGodotCanvas(target)`, which follows the visible tab.
- The canvas is destroyed and recreated by `replaceCanvas` on every engine exit — never cache the element, and re-query after each `godot-engine-ready`.
- Projection math works in CSS pixels via `getBoundingClientRect()`; the canvas backing store is `innerWidth * devicePixelRatio`, so mixing the two doubles every coordinate on a Retina display.

## Verification harness

Because most browsers (including the in-app browser used by this project's agent tooling) don't implement native WebMCP, `test/webmcp-harness.md` documents a dependency-free polyfill (`test/webmcp-polyfill.js`) that installs a spec-shaped `document.modelContext`/`navigator.modelContext` surface so a cheap model can still drive the `godot_*` tools via `javascript_tool`. The `webmcp-verifier` subagent (`.claude/agents/webmcp-verifier.md`, runs on `model: haiku`) bootstraps this polyfill against a live page and executes one of the numbered checklists in `test/checklists/` (`catalog.md`, `boot.md`, `camera.md`, `restarts.md`), reporting only observed PASS/FAIL/NOT_IMPLEMENTED facts — never fixes anything itself. Use it for cheap, repeatable, read-only regression passes against the tool catalog, boot sequence, camera-focus HUD, and live-mutator restart behavior.
