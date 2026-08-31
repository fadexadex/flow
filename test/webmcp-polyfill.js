/**
 * webmcp-polyfill.js
 *
 * Dependency-free, spec-shaped WebMCP polyfill. Paste this WHOLE file as the
 * `text` argument of a single `mcp__Claude_Browser__javascript_tool` call,
 * BEFORE the page's own `mcp_bridge.js` has registered tools (or call
 * `__webmcp.reload()` afterward to force a fresh registration pass against
 * this polyfill).
 *
 * Installs (first available wins):
 *   1. document.modelContext   (native spec surface, defined via defineProperty)
 *   2. navigator.modelContext  (fallback spec surface)
 *   3. window.__webmcpPolyfill (last-resort plain object, same shape)
 *
 * Always exposes window.__webmcp with agent-friendly helpers that never throw
 * and always return JSON-serializable values:
 *   __webmcp.install()        -> { surface, installed }
 *   __webmcp.reload()         -> { ok, before, after, grew, timedOut }
 *   __webmcp.tools()          -> string[] (sorted tool names)
 *   __webmcp.call(name, args) -> { ok, name, result } | { ok:false, name, error }
 *   __webmcp.status()         -> { surface, toolCount, engine, webmcp, sceneRevision }
 *
 * Idempotent: running this script twice is safe. The second run detects the
 * existing installation and returns { already_installed: true } from install().
 */
(function () {
  'use strict';

  var MAX_DATA_URL_CHARS = 120;

  function truncateDataUrls(value, seen) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      if (value.indexOf('data:') === 0 && value.length > MAX_DATA_URL_CHARS) {
        var truncatedBytes = value.length - MAX_DATA_URL_CHARS;
        return value.slice(0, MAX_DATA_URL_CHARS) + '…(truncated ' + truncatedBytes + ' bytes)';
      }
      return value;
    }
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value !== 'object') return value;
    // DOM nodes and similar non-serializable objects: stringify defensively.
    if (typeof Node !== 'undefined' && value instanceof Node) return '[DOMNode]';
    seen = seen || new WeakSet();
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) arr.push(truncateDataUrls(value[i], seen));
      return arr;
    }
    var out = {};
    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      var v;
      try {
        v = truncateDataUrls(value[key], seen);
      } catch (e) {
        v = '[Unserializable]';
      }
      if (v !== undefined) out[key] = v;
    }
    return out;
  }

  function safeJson(value) {
    try {
      return JSON.parse(JSON.stringify(truncateDataUrls(value)));
    } catch (e) {
      return { __serialization_error__: String(e && e.message || e) };
    }
  }

  function makePolyfillContext() {
    var tools = new Map();

    function registerTool(definition, options) {
      if (!definition || typeof definition.name !== 'string') {
        throw new TypeError('registerTool: definition.name (string) is required');
      }
      if (typeof definition.execute !== 'function') {
        throw new TypeError('registerTool: definition.execute (function) is required');
      }
      tools.set(definition.name, definition);
      var signal = options && options.signal;
      if (signal) {
        if (signal.aborted) {
          tools.delete(definition.name);
        } else {
          signal.addEventListener('abort', function () {
            tools.delete(definition.name);
          });
        }
      }
      return {
        unregister: function () {
          tools.delete(definition.name);
        }
      };
    }

    function unregisterTool(name) {
      return tools.delete(name);
    }

    function getTools() {
      var out = [];
      tools.forEach(function (def) {
        out.push({
          name: def.name,
          description: def.description,
          annotations: def.annotations,
          inputSchema: def.inputSchema
        });
      });
      return out;
    }

    async function executeTool(name, args) {
      var def = tools.get(name);
      if (!def) throw new Error("Tool '" + name + "' not found");
      return await def.execute(args || {});
    }

    // Some spec drafts use a bulk `provideContext({ tools })` registration
    // method instead of (or alongside) `registerTool`.
    function provideContext(context) {
      var list = (context && context.tools) || [];
      var registered = [];
      for (var i = 0; i < list.length; i++) {
        registerTool(list[i]);
        registered.push(list[i].name);
      }
      return { registered: registered };
    }

    return {
      registerTool: registerTool,
      unregisterTool: unregisterTool,
      getTools: getTools,
      executeTool: executeTool,
      provideContext: provideContext,
      __isWebMcpPolyfill: true,
      __toolMap: tools
    };
  }

  function install() {
    // Already installed by a previous run of this same script?
    if (typeof document !== 'undefined' && document.modelContext && document.modelContext.__isWebMcpPolyfill) {
      return { surface: 'document.modelContext', installed: false, already_installed: true };
    }
    if (typeof navigator !== 'undefined' && navigator.modelContext && navigator.modelContext.__isWebMcpPolyfill) {
      return { surface: 'navigator.modelContext', installed: false, already_installed: true };
    }
    if (typeof window !== 'undefined' && window.__webmcpPolyfill && window.__webmcpPolyfill.__isWebMcpPolyfill) {
      return { surface: 'window.__webmcpPolyfill', installed: false, already_installed: true };
    }

    // If a REAL native modelContext already exists (has registerTool but is
    // not our polyfill), don't touch it — the page should use it directly.
    if (typeof document !== 'undefined' && document.modelContext && typeof document.modelContext.registerTool === 'function') {
      return { surface: 'document.modelContext', installed: false, already_installed: true, native: true };
    }
    if (typeof navigator !== 'undefined' && navigator.modelContext && typeof navigator.modelContext.registerTool === 'function') {
      return { surface: 'navigator.modelContext', installed: false, already_installed: true, native: true };
    }

    var ctx = makePolyfillContext();

    // Try document.modelContext first (the real spec surface).
    try {
      Object.defineProperty(document, 'modelContext', {
        value: ctx,
        configurable: true,
        writable: false,
        enumerable: true
      });
      return { surface: 'document.modelContext', installed: true };
    } catch (e) {
      // Spec surface may be non-configurable / read-only in this browser build.
    }

    // Fall back to navigator.modelContext.
    try {
      Object.defineProperty(navigator, 'modelContext', {
        value: ctx,
        configurable: true,
        writable: false,
        enumerable: true
      });
      return { surface: 'navigator.modelContext', installed: true };
    } catch (e) {
      // Also unavailable.
    }

    // Last resort: plain window property, still spec-shaped so callers can
    // use the same registerTool/executeTool API.
    window.__webmcpPolyfill = ctx;
    return { surface: 'window.__webmcpPolyfill', installed: true };
  }

  function currentContext() {
    if (typeof document !== 'undefined' && document.modelContext && typeof document.modelContext.executeTool === 'function') {
      return { ctx: document.modelContext, surface: 'document.modelContext' };
    }
    if (typeof navigator !== 'undefined' && navigator.modelContext && typeof navigator.modelContext.executeTool === 'function') {
      return { ctx: navigator.modelContext, surface: 'navigator.modelContext' };
    }
    if (typeof window !== 'undefined' && window.__webmcpPolyfill) {
      return { ctx: window.__webmcpPolyfill, surface: 'window.__webmcpPolyfill' };
    }
    return null;
  }

  function toolCountNow() {
    var found = currentContext();
    if (found && typeof found.ctx.getTools === 'function') {
      try {
        return found.ctx.getTools().length;
      } catch (e) {
        // fall through
      }
    }
    if (typeof window !== 'undefined' && window.godotWebMcpTestBridge && typeof window.godotWebMcpTestBridge.getTools === 'function') {
      try {
        return window.godotWebMcpTestBridge.getTools().length;
      } catch (e) {
        // fall through
      }
    }
    return 0;
  }

  async function reload() {
    var before = toolCountNow();
    var timeoutMs = 15000;
    var pollIntervalMs = 250;
    var stableRequiredMs = 750;

    var script = document.createElement('script');
    script.src = '/mcp_bridge.js?t=' + Date.now();

    var loadPromise = new Promise(function (resolve) {
      script.onload = function () { resolve(true); };
      script.onerror = function () { resolve(false); };
    });
    document.head.appendChild(script);
    var loaded = await loadPromise;

    var start = Date.now();
    var last = toolCountNow();
    var lastChangeAt = Date.now();
    var timedOut = false;

    while (Date.now() - start < timeoutMs) {
      await new Promise(function (r) { setTimeout(r, pollIntervalMs); });
      var now = toolCountNow();
      if (now !== last) {
        last = now;
        lastChangeAt = Date.now();
      } else if (Date.now() - lastChangeAt >= stableRequiredMs && now > 0) {
        break;
      }
      if (Date.now() - start >= timeoutMs) {
        timedOut = true;
      }
    }

    var after = toolCountNow();
    return {
      ok: loaded,
      before: before,
      after: after,
      grew: after > before,
      timedOut: timedOut
    };
  }

  function toolNames() {
    var found = currentContext();
    var names = [];
    if (found && typeof found.ctx.getTools === 'function') {
      try {
        found.ctx.getTools().forEach(function (t) { names.push(t.name); });
      } catch (e) {
        // ignore
      }
    } else if (typeof window !== 'undefined' && window.godotWebMcpTestBridge && typeof window.godotWebMcpTestBridge.getTools === 'function') {
      try {
        window.godotWebMcpTestBridge.getTools().forEach(function (t) { names.push(t.name); });
      } catch (e) {
        // ignore
      }
    }
    names.sort();
    return names;
  }

  async function call(name, args) {
    try {
      if (typeof document !== 'undefined' && document.modelContext && typeof document.modelContext.executeTool === 'function') {
        var result = await document.modelContext.executeTool(name, args || {});
        return { ok: true, name: name, result: safeJson(result) };
      }
      if (typeof navigator !== 'undefined' && navigator.modelContext && typeof navigator.modelContext.executeTool === 'function') {
        var result2 = await navigator.modelContext.executeTool(name, args || {});
        return { ok: true, name: name, result: safeJson(result2) };
      }
      if (typeof window !== 'undefined' && window.__webmcpPolyfill && typeof window.__webmcpPolyfill.executeTool === 'function') {
        var result3 = await window.__webmcpPolyfill.executeTool(name, args || {});
        return { ok: true, name: name, result: safeJson(result3) };
      }
      if (typeof window !== 'undefined' && window.godotWebMcpTestBridge && typeof window.godotWebMcpTestBridge.callTool === 'function') {
        var result4 = await window.godotWebMcpTestBridge.callTool(name, args || {});
        return { ok: true, name: name, result: safeJson(result4) };
      }
      return { ok: false, name: name, error: 'No WebMCP surface available (native, polyfill, or test bridge)' };
    } catch (err) {
      return { ok: false, name: name, error: String(err && err.message || err) };
    }
  }

  async function status() {
    var found = currentContext();
    var surface = found ? found.surface : (typeof window !== 'undefined' && window.godotWebMcpTestBridge ? 'application_test_bridge' : 'none');
    var toolCount = toolCountNow();
    var out = { surface: surface, toolCount: toolCount, engine: null, webmcp: null, sceneRevision: null };
    var sessionResult = await call('godot_get_session_status', {});
    if (sessionResult.ok && sessionResult.result) {
      out.engine = sessionResult.result.engine_state != null ? sessionResult.result.engine_state : null;
      out.webmcp = sessionResult.result.webmcp_state != null ? sessionResult.result.webmcp_state : null;
      out.sceneRevision = sessionResult.result.session && sessionResult.result.session.scene_revision != null
        ? sessionResult.result.session.scene_revision
        : null;
    }
    return out;
  }

  var installResult = install();

  window.__webmcp = {
    install: function () { return safeJson(install()); },
    reload: reload,
    tools: function () { return toolNames(); },
    call: call,
    status: status
  };

  // Return value of the whole script (useful when pasted via javascript_tool).
  return safeJson(installResult);
})();
