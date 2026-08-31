# Checklist: catalog

Verifies the WebMCP tool catalog itself: count, no duplicates, every tool has a well-shaped `inputSchema`, and the four documented "stub" tools still fail explicitly instead of silently succeeding.

Prerequisite: complete the bootstrap sequence in `test/webmcp-harness.md` first (polyfill installed, `__webmcp.reload()` done).

## Steps

1. **Get the tool list.**
   Run:
   ```js
   __webmcp.tools()
   ```
   Assert: returns an array of strings, length >= 40 (target ~45), every entry starts with `godot_`.

2. **Check for duplicate names.**
   Run:
   ```js
   (() => { const t = __webmcp.tools(); return { total: t.length, unique: new Set(t).size }; })()
   ```
   Assert: `total === unique`. If not, report FAIL and list the duplicate name(s) (diff the array against the Set).

3. **Check every tool has a proper inputSchema.**
   This requires reading the raw tool definitions, not just names. Run:
   ```js
   (() => {
     const ctx = document.modelContext || navigator.modelContext || window.__webmcpPolyfill;
     const tools = ctx && typeof ctx.getTools === 'function' ? ctx.getTools() : [];
     const bad = tools.filter(t => !t.inputSchema || t.inputSchema.type !== 'object');
     return { checked: tools.length, bad: bad.map(t => t.name) };
   })()
   ```
   Assert: `bad` is an empty array. If not, report FAIL and list every name in `bad`.

4. **Verify the four documented stub tools each fail with `EDITOR_COMMAND_UNSUPPORTED`.**
   For each of: `godot_connect_signal_live`, `godot_resize_gizmo_live`, `godot_live_code_diff`, `godot_hot_reload_property` — run:
   ```js
   await __webmcp.call('godot_connect_signal_live', {})
   ```
   (repeat with the other three names, one call each)
   Assert for each: `ok === false` AND `error` contains the substring `EDITOR_COMMAND_UNSUPPORTED` (case-sensitive). Record the exact `error` string as evidence.
   If any of the four returns `ok:true`, that is a FAIL — a stub tool unexpectedly succeeded, report the full result.

## Report

One table row per step above (4 rows: tool count/shape, duplicates, schema shape, stub behavior — or one row per individual stub tool call if you want finer granularity, 7 rows total is also acceptable). Include the raw `__webmcp.tools()` array length and the four stub-tool error strings as evidence for any FAIL.
