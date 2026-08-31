# Checklist: camera

Verifies camera-focus behavior and the targeting-reticle/arrow HUD state for a spawned node.

# STATUS: implemented. `godot_camera_focus` and `godot_camera_follow` ship in the tool catalog, and
# `window.__webmcpFocusState` is published by `AgentFocusOverlay.publish()` on every focus attempt.
# `mode` is one of `reticle` (node projects inside the frame), `arrow` (outside the frustum, so an
# edge-clamped direction arrow with a distance label is drawn instead), or `hidden` with a `reason`.
# `hidden` is a FAIL only when a camera pose was available: `reason: "no_camera_pose"` is the honest
# answer when the editor plugin is absent and the playtest is not running, and
# `reason: "canvas_not_laid_out"` is expected when the canvas has zero size, which is the normal state
# in a hidden or backgrounded browser pane: the host pauses requestAnimationFrame, so index.html never
# sizes the canvas and there is no frame to project onto. Front the pane (take a screenshot, or call
# resize_window with an explicit width/height) and re-run before recording that row as a FAIL.

Prerequisite: complete the bootstrap sequence in `test/webmcp-harness.md` first.

## Steps

1. **Confirm `godot_camera_focus` exists.**
   Run:
   ```js
   __webmcp.tools().includes('godot_camera_focus')
   ```
   If `false`: report this row as `NOT_IMPLEMENTED` (not FAIL) and stop the checklist here — the remaining steps cannot be exercised.

2. **Create/confirm a project is active** (skip if `godot_get_session_status` already shows an active project):
   ```js
   await __webmcp.call('godot_get_session_status', {})
   ```
   Record `result.session.active_project`.

3. **Spawn a node at `[0, 3.5, -3]`.**
   ```js
   await __webmcp.call('godot_node_spawn', { name: 'CameraCheckNode', mesh_type: 'sphere', position: [0, 3.5, -3] })
   ```
   Assert: `ok === true`. Record the returned `revision` and node path/name used in the next step.

4. **Call `godot_camera_focus` on the spawned node.**
   ```js
   await __webmcp.call('godot_camera_focus', { node_path: 'CameraCheckNode' })
   ```
   (adjust `node_path` to whatever path the spawn call actually returned, if different)
   Assert: `ok === true`.

5. **Capture the viewport** (for evidence only, response will be truncated by the polyfill's data-url cap — that's expected):
   ```js
   await __webmcp.call('godot_capture_viewport', {})
   ```

6. **Read the debug focus state.**
   ```js
   typeof window.__webmcpFocusState === 'undefined' ? 'NOT_IMPLEMENTED' : window.__webmcpFocusState
   ```
   If `'NOT_IMPLEMENTED'`: report this row as NOT_IMPLEMENTED, not FAIL.
   Otherwise assert the object has shape `{mode, x, y, nodeName, offscreen}` and:
   - `mode !== 'hidden'`
   - if `mode === 'reticle'`: `x` and `y` fall inside the middle 60% of the canvas bounding rect. Get the rect with:
     ```js
     document.querySelector('canvas')?.getBoundingClientRect()
     ```
     Middle 60% means `x` is between `rect.left + 0.2*rect.width` and `rect.left + 0.8*rect.width` (same formula for `y`/height).

## Report

One table row per step. For step 1, if the tool is missing, the whole checklist reports as a single NOT_IMPLEMENTED row with a note that steps 2-6 were skipped. If the tool exists but `window.__webmcpFocusState` is missing, steps 1-5 get PASS/FAIL as normal and step 6 gets NOT_IMPLEMENTED. Never mark step 6 PASS by guessing what the object "probably" looks like.
