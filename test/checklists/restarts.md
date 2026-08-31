# Checklist: restarts

Verifies how many times the live 3D mutator restarts the editor process across five node spawns, and whether the `execution_time_ms` figure returned by spawn calls is a real measurement or a hardcoded constant.

# STATUS: implemented. `window.__webmcpRestartCount` counts real `restartEditorWithProject` calls.
# With the editor command plugin loaded, a five-node build must leave it UNCHANGED and every spawn
# result must report `editor_channel: "command"` and `editor_restarted: false`. Without the plugin the
# same build falls back to one restart per mutation — that is a documented fallback, not a failure, so
# always record `editor_command_channel.available` from `godot_get_session_status` alongside the delta.
# `execution_time_ms` is now a measured wall-clock value, not a constant; report it, do not judge it.

Prerequisite: complete the bootstrap sequence in `test/webmcp-harness.md` first.

## Steps

1. **Check for the restart counter.**
   ```js
   typeof window.__webmcpRestartCount === 'undefined' ? 'NOT_IMPLEMENTED' : window.__webmcpRestartCount
   ```
   If `'NOT_IMPLEMENTED'`: report this row as NOT_IMPLEMENTED and still proceed with steps 2-4 (the spawn/timing checks are independent of the counter).

2. **Read the counter before spawning (skip if NOT_IMPLEMENTED).**
   Record the numeric value from step 1 as `before`.

3. **Spawn five nodes, one at a time, recording each result.**
   Run this five times (do not batch into a single call — each is a separate `godot_node_spawn` invocation so restarts, if any, happen between them):
   ```js
   await __webmcp.call('godot_node_spawn', { name: 'RestartCheckNode_N', mesh_type: 'box', position: [N, 0, 0] })
   ```
   substituting `N` = 1..5 in both the node name and the JS call. For each call, record:
   - `ok`
   - `result.revision` (should increase by 1 each time)
   - `result.execution_time_ms` if present

4. **Read the counter after spawning (skip if NOT_IMPLEMENTED).**
   ```js
   window.__webmcpRestartCount
   ```
   Record as `after`. Report the delta (`after - before`) as a plain fact — do not assert what the "correct" delta should be, just report it alongside the count of spawn calls made (5).

5. **Determine whether `execution_time_ms` is a real measurement or a hardcoded constant.**
   Compare the five `execution_time_ms` values collected in step 3. Also run each spawn call again with `mcp__Claude_Browser__javascript_tool` wrapping a real `Date.now()` measurement around the `await __webmcp.call(...)`, e.g.:
   ```js
   (async () => {
     const t0 = Date.now();
     const r = await __webmcp.call('godot_node_spawn', { name: 'TimingCheckNode', mesh_type: 'box', position: [9, 0, 0] });
     const wallClockMs = Date.now() - t0;
     return { reported_execution_time_ms: r.result?.execution_time_ms, wallClockMs };
   })()
   ```
   Report as fact: if all five `execution_time_ms` values from step 3 are identical (e.g. always `1` or always `2`) while `wallClockMs` varies noticeably between calls, that is strong evidence `execution_time_ms` is a hardcoded constant, not a real measurement — state this plainly as an observation, do not editorialize about whether that's acceptable.

## Report

Table rows: (1) counter present/NOT_IMPLEMENTED, (2) five spawn calls succeeded with revision incrementing, (3) restart-count delta (or NOT_IMPLEMENTED), (4) execution_time_ms constant-vs-real-measurement finding with the raw numbers as evidence.
