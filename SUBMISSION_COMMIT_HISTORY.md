# Detailed Commit History Summary (for Submission Update Explanation)

Repository: `fadexadex/flow`  
Generated from local git history on 2026-09-03.

## 1) Complete commit list (chronological)

| Order | Commit | Date | Author | Subject |
|---|---|---|---|---|
| 1 | `e879d038e9436670cc848158a6a9b45e40ffa55f` | 2026-09-03T05:59:04+01:00 | Daniel Fadehan | chore: ignore .netlify folder |
| 2 | `e282226f3a0cdcdbfdf40151b606db9f1d4e0cd0` | 2026-09-03T09:40:01+01:00 | Daniel Fadehan | feat: make the editor the source of truth, fix the viewport presets, and read the human's selection |

---

## 2) Detailed breakdown by commit

## Commit 1 — `e879d038e9436670cc848158a6a9b45e40ffa55f`
**Subject:** `chore: ignore .netlify folder`  
**Date:** 2026-09-03T05:59:04+01:00  
**Author:** Daniel Fadehan  
**Diff size:** **98 files changed, 42,581 insertions**

### What this commit did (high-level)
This is the large initial repository population commit. It introduced the full browser-hosted Godot + WebMCP platform, including:
- Runtime/editor bridge and Godot web assets
- Server/runtime deployment configuration for local + Netlify + Vercel
- Plugin source, embedding script, and tool catalog endpoints
- Extensive test harnesses, checklists, and verification utilities
- Example projects and documentation

### Scope by top-level area
- `test/`: 53 files, +24,029 lines
- `public/`: 17 files, +15,133 lines
- repository root files: 11 files, +1,955 lines
- `netlify/`: 3 files, +666 lines
- `examples/`: 6 files, +607 lines
- `.netlify/`: 6 files, +111 lines
- `.claude/`: 1 file, +61 lines
- `scripts/`: 1 file, +19 lines

### Files added in this commit
- `.claude/agents/webmcp-verifier.md`
- `.dockerignore`
- `.gitignore`
- `.netlify/functions/health.zip`
- `.netlify/functions/manifest.json`
- `.netlify/functions/rpc.zip`
- `.netlify/functions/tools.zip`
- `.netlify/netlify.toml`
- `.netlify/state.json`
- `CLAUDE.md`
- `Dockerfile`
- `README.md`
- `examples/dune_dash/dune_dash.gd`
- `examples/dune_dash/dune_dash.tscn`
- `examples/dune_dash/project.godot`
- `examples/skybridge_relay/project.godot`
- `examples/skybridge_relay/skybridge_relay.gd`
- `examples/skybridge_relay/skybridge_relay.tscn`
- `netlify.toml`
- `netlify/functions/health.mjs`
- `netlify/functions/rpc.mjs`
- `netlify/functions/tools.mjs`
- `package-lock.json`
- `package.json`
- `public/__mm.html`
- `public/addons/webmcp/plugin.cfg`
- `public/addons/webmcp/plugin.gd`
- `public/editor_boot.js`
- `public/favicon.png`
- `public/godot.editor.audio.position.worklet.js`
- `public/godot.editor.audio.worklet.js`
- `public/godot.editor.html`
- `public/godot.editor.js`
- `public/godot.editor.wasm`
- `public/index.html`
- `public/inter-bold.woff2`
- `public/inter-regular.woff2`
- `public/logo.svg`
- `public/manifest.json`
- `public/mcp_bridge.js`
- `public/service.worker.js`
- `scripts/embed_plugin.py`
- `server.mjs`
- `test/analyze_codex_bootstrap.mjs`
- `test/analyze_ui.mjs`
- `test/browser_resume_ui_verification.mjs`
- `test/browser_verification.mjs`
- `test/build_cyber_runner.mjs`
- `test/build_neon_horizon.mjs`
- `test/camera-guidance.js`
- `test/capture_annotated_overlays.mjs`
- `test/capture_breadcrumb_mockup.mjs`
- `test/capture_breadcrumb_states.mjs`
- `test/capture_codex_details.mjs`
- `test/checklists/boot.md`
- `test/checklists/camera.md`
- `test/checklists/catalog.md`
- `test/checklists/persistence.md`
- `test/checklists/restarts.md`
- `test/codex_bootstrap.js`
- `test/deep_dive_codex_studio.mjs`
- `test/download_bootstrap.mjs`
- `test/download_modules.mjs`
- `test/download_ui.mjs`
- `test/editor_boot.test.mjs`
- `test/execute_codex_full_flow.mjs`
- `test/execute_codex_modeling.mjs`
- `test/execute_codex_modeling_v2.mjs`
- `test/hot_script_browser_verification.mjs`
- `test/hot_script_channel.test.mjs`
- `test/inspect_bridge.mjs`
- `test/inspect_camera_tools.mjs`
- `test/inspect_catalog_camera.mjs`
- `test/inspect_codex_studio.mjs`
- `test/inspect_create_tools.mjs`
- `test/inspect_material_tools.mjs`
- `test/inspect_part_add.mjs`
- `test/inspect_part_fields.mjs`
- `test/inspect_scene_details.mjs`
- `test/inspect_ui_functions.mjs`
- `test/lifecycle_and_handshake.test.mjs`
- `test/operation_state_machine.test.mjs`
- `test/parse_bootstrap.mjs`
- `test/plugin_source_parity.test.mjs`
- `test/project_text_normalization.test.mjs`
- `test/render_annotated_overlays.html`
- `test/render_breadcrumb_states.html`
- `test/render_breadcrumb_ui.html`
- `test/scene_projection.test.mjs`
- `test/scene_roundtrip.test.mjs`
- `test/studio-public-tool-catalog.js`
- `test/studio-public-tool-protocol.js`
- `test/studio-ui.js`
- `test/tool-definitions.js`
- `test/webmcp-harness.md`
- `test/webmcp-polyfill.js`
- `vercel.json`
- `verify_catalog_parity.mjs`

---

## Commit 2 — `e282226f3a0cdcdbfdf40151b606db9f1d4e0cd0`
**Subject:** `feat: make the editor the source of truth, fix the viewport presets, and read the human's selection`  
**Date:** 2026-09-03T09:40:01+01:00  
**Author:** Daniel Fadehan  
**Diff size:** **19 files changed, 2,706 insertions, 1,749 deletions**

### What this commit did (high-level)
This is the focused submission-period refinement commit. It moved behavior toward editor-authoritative state, improved camera preset behavior, added human-focus introspection, improved project adoption/state agreement, and refactored large embedded sections out of `mcp_bridge.js`.

### Key functional updates stated in commit message
1. **Viewport presets fixed**
   - Previous approach synthesized key events that did not trigger the expected viewport shortcut path.
   - Updated to drive the viewport menu path (`id_pressed`) used by real clicks.
   - Reported measured camera movement confirmation for top view behavior.

2. **Editor state as source of truth for open project info**
   - Added editor-backed project introspection operations (`project_state`, `project_files`).
   - Session/status now reports agreement signals between bridge/session view and actual editor-open project identity.
   - Corrected comparison logic so project identity is checked properly (not only scene path).

3. **Adopt-open-project flow added**
   - Added `godot_adopt_open_project` to bring editor-open projects into the bridge project library without forced restart.
   - Updated Projects UI flow to support create/adopt/refresh behaviors anchored to editor reality.

4. **Boot/quit race handling improved**
   - Addressed `EDITOR_FS_COPY_FAILED` symptom caused by quit-vs-boot timing races.
   - Added superseded-takeover handling and retry behavior without constructing a second engine instance.

5. **Human focus introspection added**
   - Added `godot_get_user_focus` so tools can resolve user references like “this one” based on current selection/workspace/caret context.

6. **Refactor and modular extraction**
   - Extracted embedded plugin source into generated `public/webmcp_plugin_source.js`.
   - Extracted built-in templates into `public/project_templates.js`.
   - Reduced and reorganized `public/mcp_bridge.js` by moving generated/static-heavy content out.

7. **Test/catalog updates**
   - Added module extraction test coverage.
   - Updated npm test script and parity-related files.

### File-level changes in this commit
**Deleted (`D`)**
- `.netlify/functions/health.zip`
- `.netlify/functions/manifest.json`
- `.netlify/functions/rpc.zip`
- `.netlify/functions/tools.zip`
- `.netlify/netlify.toml`
- `.netlify/state.json`

**Modified (`M`)**
- `netlify/functions/tools.mjs`
- `package.json`
- `public/addons/webmcp/plugin.gd`
- `public/editor_boot.js`
- `public/index.html`
- `public/mcp_bridge.js`
- `scripts/embed_plugin.py`
- `test/editor_boot.test.mjs`
- `test/lifecycle_and_handshake.test.mjs`
- `test/plugin_source_parity.test.mjs`

**Added (`A`)**
- `public/project_templates.js`
- `public/webmcp_plugin_source.js`
- `test/module_extraction.test.mjs`

---

## 3) Direct answer text for: “If existing, explain what you updated during the submission period”

During the submission period, I made a major refinement pass on top of the initial full implementation. Specifically, I updated the system so the live Godot editor is the authoritative source for project/session truth, fixed viewport preset behavior to use the editor’s actual menu-driven camera actions, added a new `godot_get_user_focus` capability to read human selection/workspace/caret context, and introduced `godot_adopt_open_project` so editor-open projects can be imported into the bridge library without restart. I also improved lifecycle handling for quit/boot race conditions, expanded and adjusted tests (including a new module extraction test), and refactored the architecture by extracting embedded plugin and template content out of `mcp_bridge.js` into dedicated generated modules. In the same period, I removed committed `.netlify` generated artifacts from versioned changes while keeping source-based Netlify function/catalog definitions in place.

---

## 4) Net effect across all commits

- Total commits in repository history: **2**
- Total net lines added: **45,287**
- Total net lines deleted: **1,749**
- Overall development pattern:
  1. Initial complete codebase and infrastructure import
  2. Focused functional hardening + editor-authoritative behavior + modular refactor during submission period
