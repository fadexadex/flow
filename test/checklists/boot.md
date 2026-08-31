# Checklist: boot

Verifies the page boots the Godot editor and WebMCP registration cleanly.

Prerequisite: complete the bootstrap sequence in `test/webmcp-harness.md` first (navigate to `http://localhost:8060`, install polyfill, `__webmcp.reload()`).

## Steps

1. **Page loads.**
   After `mcp__Claude_Browser__navigate` to `http://localhost:8060`, confirm the tool call did not error and the page title/DOM is present. Run:
   ```js
   document.readyState
   ```
   Assert: `"complete"`.

2. **Engine reaches `ready` within 60 seconds.**
   Poll (up to ~12 times, every 5 seconds — do not busy-loop faster than that) using:
   ```js
   await __webmcp.call('godot_get_session_status', {})
   ```
   Assert: within 60 seconds total elapsed since navigation, some poll returns `result.engine_state === "ready"`. Record how many seconds it took (approx, based on your poll count).
   If it never reaches `"ready"` within 60s, report FAIL and include the last `engine_state` value observed plus any `result.engineError`.

3. **No uncaught console errors.**
   Run:
   ```
   mcp__Claude_Browser__read_console_messages   onlyErrors: true
   ```
   Assert: no messages present, OR every message present is an expected/benign one (the bridge is known to emit platform-level `ERROR:` lines for unsupported debugger sockets / Emscripten warnings even when healthy — these are not necessarily failures, but DO record them verbatim as evidence either way).
   A message containing `SCRIPT ERROR`, `Parse Error`, `Failed to load`, `Game initialization failed`, or an uncaught JS exception/stack trace not related to a deliberate `EDITOR_COMMAND_UNSUPPORTED` stub call is a FAIL — quote it verbatim.

4. **Registered tool count matches polyfill's tool count.**
   Run:
   ```js
   (async () => {
     const status = await __webmcp.call('godot_get_session_status', {});
     const reported = status.ok ? status.result.webmcp_registered_tools_count : null;
     const actual = __webmcp.tools().length;
     return { reported, actual, match: reported === actual };
   })()
   ```
   Assert: `match === true`. If not, report FAIL with both numbers — this could mean tools registered on a different surface than the one the polyfill/test-bridge fallback reports, or a partial registration failure (check `result.webmcp_state` for `"failed"` and `result.webmcp_registered_tools_count` vs. expected ~45).

## Report

One table row per step (4 rows). For any FAIL, include the raw JSON result of the relevant call and, for step 3, the exact console message text.
