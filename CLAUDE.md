# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-hosted Godot 4 editor (WASM/WebGL build in `public/godot.editor.*`) instrumented with a WebMCP tool bridge, so an AI agent can author, mutate, playtest, and record a Godot project entirely inside the page — no local Godot install, no filesystem access. The in-page bridge (`public/mcp_bridge.js`) is the entire system: an IIFE that boots alongside the Godot editor, holds the authoritative project state in memory, and exposes ~35 tools both to the browser's native WebMCP (`navigator.modelContext` / `document.modelContext`) and over a WebSocket relay for headless/remote agents.

## Commands

```bash
npm install
npm test               # catalog parity + 4 node --test suites (41 tests)
npm run verify:catalog # catalog parity check only
npm run verify:plugin  # re-embed public/addons/webmcp/plugin.gd and check it matches
node server.mjs        # run the local Express + WebSocket server on :8060 (set PORT to override)
```

There is no build step — `public/` is served as-is. There is no lint config. `npm test` runs
`verify_catalog_parity.mjs` plus four `node --test` suites:

| Suite | Covers |
|---|---|
| `test/operation_state_machine.test.mjs` | fingerprints, idempotency, managed-operation phases |
| `test/scene_projection.test.mjs` | `.tscn` parsing, world transforms, AABBs, world→screen projection |
| `test/scene_roundtrip.test.mjs` | mutate-then-reparse: transforms, materials, duplicate leaf paths, shared-material forking, and the `source_synced` verifiers |
| `test/lifecycle_and_handshake.test.mjs` | editor replacement sequencing, playtest handshake verification, generation-scoped errors, overall-health derivation |
| `test/plugin_source_parity.test.mjs` | embedded vs on-disk plugin source, op coverage, project.godot patching |

**Reading a result honestly.** A live mutation reports four independent facts; do not collapse
them. `applied` is `editor_command` or `editor_restart`. `source_synced` is the answer to
re-reading the written `.tscn` and comparing every requested property — `true`, `false` with a
`source_mismatch`, or **`null`** meaning it could not be checked, which is not the same as
passing. `source_authoritative` says the text came from Godot's own serialized state (its
twelve transform floats, or its resolved material values) rather than the bridge recomputing
it. `persisted` says the snapshot reached IndexedDB at that revision.

**The persistence invariant, stated precisely.** Mutations are two-phase: build the candidate,
apply it to the editor, **persist the candidate**, then publish `activeFilesDict` and
`sceneRevision`. A failed fallback restart rolls both back and publishes nothing. It is *not*
claimed that revision and persistence can never disagree — storage can still fail after the
editor has already applied the edit. When that happens the session becomes
`dirty_unpersisted` and `godot_get_session_status` reports `persisted_revision` alongside
`scene_revision` plus an `unpersisted` flag, so the gap is visible rather than silent.

**What `npm test` still does not prove.** The *decision logic* for the lifecycle, handshake,
health derivation, and generation scoping is now unit-tested, but the integration around it is
browser-only and is verified by hand or by the `webmcp-verifier` subagent against a running
page — never assume a green `npm test` covers it: a real Godot WASM boot, `JavaScriptBridge`
command execution, UndoRedo behaviour, the zero-restart claim, actual camera movement,
MediaRecorder capture, and IndexedDB reload persistence.

**A warning about timing in a background tab.** Godot's main loop is driven by
`requestAnimationFrame`, which browsers throttle to roughly 2fps in a hidden or backgrounded
pane. Editor boots, `requestQuit()` acknowledgements, and playtest launches all stretch by
orders of magnitude there, and `setTimeout` is clamped too. Every latency number measured that
way is meaningless, and timeouts tuned for a foreground tab will fire spuriously. Keep the page
foregrounded (a screenshot wakes it) when measuring anything. The `test/*.mjs` files outside the four suites above are ad hoc
Puppeteer inspection scripts run manually with `node test/<name>.mjs`.

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
- Never report an outcome you did not observe. `godot_camera_focus` dispatches a shortcut; whether Godot *moved* is a separate measurement, which is why `status: 'framed'` requires a real pose delta and `dispatched_unconfirmed` exists. Results separate `applied` (the editor took the command), `source_synced` (the `.tscn` matches), and `source_authoritative` (that text came from Godot's own serialized state).
- **Never infer engine lifecycle from the DOM.** `#btn-close-editor` is disabled while an editor is *initializing*, not only when it has stopped, so reading it as "the old editor is gone" let a rollback build a second `Engine` over a half-constructed one — `Engine must be inited before copying files` for every file, and a dead viewport with no recovery. `index.html` owns an explicit machine (`idle → initializing → running → quitting → exited|failed`) on `window.__godotEditorLifecycle`, with `window.__godotAwaitEditorExit(ms)` resolving on the engine's real exit. Replacement is serialized by `editorReplacementInFlight` — one at a time, always.
  The wait is asymmetric on purpose (`editorReplacementPlan`): **initializing** is a hard barrier (25s, refuse with `EDITOR_EXIT_TIMEOUT` rather than replace a half-built engine), while **running/quitting** gets a short bounded wait and then proceeds, because the host is designed for a replacement to take over the canvas and this editor does not always honour `requestQuit()`. Treating `running` as a hard barrier stopped every restart.
- **The editor and the playtest are two separate `Engine` instances with two separate filesystems.** `index.html` creates `editor = new Engine(editorConfig)` and, on playtest, `game = new Engine(gameConfig)`. Copying files into the editor engine tells you *nothing* about what the game will load — doing only that reported `source_synced_to_disk: true` while the playtest still rendered the pre-edit scene. `godot_run_game` stages `{revision, fingerprint, launchToken, files}` on `window.__godotStagedProject`; the game engine **consumes it exactly once** (clearing it on read) between `init()` and `start()`, and publishes `window.__godotGameFsAck` with the launch token and a SHA-256 fingerprint **of the bytes it actually copied**. `verifyPlaytestAcknowledgement` requires all of it — token, revision, file count, fingerprint, freshness — and `godot_run_game` throws `PLAYTEST_REVISION_UNCONFIRMED` (with a `handshake_code`) otherwise. Clearing on read matters because `Execute()` also runs when a human presses Play: a stale WebMCP snapshot must never be applied to a later manual run.
  The handshake fingerprint uses `fingerprintProjectBytes`, **not** `computeProjectContentFingerprint`. The latter tags text and binary differently, which is right for the persisted snapshot and wrong here: the bridge stages strings while the copier hashes encoded buffers, so identical content hashed to two different values and a correct copy was reported as `FINGERPRINT_MISMATCH`. One byte-canonical framing, used by both sides.
- **`status` is derived, never asserted.** It was a hardcoded `'healthy'` literal that stayed healthy while `engine_state` was `failed`, the session was `failed`, and the command channel was gone. `deriveOverallStatus` returns `healthy` / `degraded` (channel missing or unpersisted edits) / `recovering` (restarting or restoring) / `failed` (engine, session, or a current-generation fatal), plus a `status_reason`.
- **A `FATAL:` log line is never tolerable noise.** It comes from `CRASH_BAD_INDEX` → `GENERATE_TRAP()`, an unconditional abort, so the runtime does not survive it and everything reported afterwards is suspect. `fatalGodotErrors()` is checked by `validateProjectRuntimeBoot`, which fails the authoring operation with `ENGINE_FATAL` and rolls back. Log entries are tagged with the editor boot generation, so teardown noise (RID/ObjectDB/WebGL leaks from a previous process) is separable from the current session's errors — see `currentGenerationErrors()`.
- **Never call `EditorInterface.save_scene()` (or `save_scene_as`) inline from a command-channel op.** `JavaScriptBridge` callbacks run *synchronously* on whatever JS stack invoked them — `JavaScriptObjectImpl::callback` calls `_callback` directly on the main thread with no `call_deferred` — so plugin code executes at an arbitrary point in the frame. `save_scene()` routes through `EditorNode::_save_scene_with_preview`, which reads back the live 3D viewport texture; called re-entrantly it aborted the whole WASM runtime with `FATAL: Index p_index = -1 is out of bounds (size() = 0)`. That is `CRASH_BAD_INDEX` → `GENERATE_TRAP()`, an unconditional abort, not a recoverable error — nothing survives it, and later calls fail with `Engine must be inited`. `UndoRedo.commit_action()` already applies the edit to the live tree; the bridge serializes the `.tscn` itself and pushes it to the virtual filesystem with `window.__godotSyncToFS` before a playtest. The plugin's `save_scene` op exists but is explicit, guarded, deferred, and uses `save_scene_as(path, false)` to skip the preview branch.
- **A node is identified by its scene-relative path, never by its leaf name.** A `.tscn` may hold `BranchA/TwinOrb` and `BranchB/TwinOrb`. Stripping the path and taking the first match edited the wrong node while the editor edited the right one, so a reload swapped which object had moved. `findNodeBlock`/`findSceneNode` resolve an exact path first and accept a bare leaf only when unique; ambiguity throws `AMBIGUOUS_NODE_PATH` listing the candidates, and the plugin refuses the same way. Handlers pass `commandReply.node_path` — the path the *editor* resolved — into the text mutation, so both sides agree by construction.
- **Material edits are copy-on-write.** Several nodes may reference one sub-resource. Mutating it in place recoloured every node using it. `applyMaterialToSceneText` forks a shared material (inheriting its values), repoints only the target node, and mutates in place only when the material is private.
- **What the human sees must be what survives reload.** Live mutations write to two places — the running editor and the in-memory `.tscn`. Route every text edit through `applyTransformToSceneText` / `applyMaterialToSceneText`, and when the command channel applied the change, write back the transform Godot itself reported instead of recomputing one. Two independent implementations of the same mutation is exactly how a rotation ended up in the editor but not in the saved scene, and how a recoloured node kept pointing at its old material. `test/scene_roundtrip.test.mjs` is the regression net for that whole bug class.
- The scene inspector renders only what `sceneGraphFromFiles` actually parsed. Do not infer gameplay semantics from filename substrings.
- `#game-canvas` is a static element in `index.html` and always exists, so `getElementById('game-canvas') || getElementById('editor-canvas')` can never reach the editor. Route through `resolveGodotCanvas(target)`, which follows the visible tab.
- The canvas is destroyed and recreated by `replaceCanvas` on every engine exit — never cache the element, and re-query after each `godot-engine-ready`.
- Projection math works in CSS pixels via `getBoundingClientRect()`; the canvas backing store is `innerWidth * devicePixelRatio`, so mixing the two doubles every coordinate on a Retina display.

## Verification harness

Because most browsers (including the in-app browser used by this project's agent tooling) don't implement native WebMCP, `test/webmcp-harness.md` documents a dependency-free polyfill (`test/webmcp-polyfill.js`) that installs a spec-shaped `document.modelContext`/`navigator.modelContext` surface so a cheap model can still drive the `godot_*` tools via `javascript_tool`. The `webmcp-verifier` subagent (`.claude/agents/webmcp-verifier.md`, runs on `model: haiku`) bootstraps this polyfill against a live page and executes one of the numbered checklists in `test/checklists/` (`catalog.md`, `boot.md`, `camera.md`, `restarts.md`, `persistence.md`), reporting only observed PASS/FAIL/NOT_IMPLEMENTED facts — never fixes anything itself. Use it for cheap, repeatable, read-only regression passes against the tool catalog, boot sequence, camera-focus HUD, and live-mutator restart behavior.
