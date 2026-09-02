import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The playtest handshake, editor replacement sequencing, generation-scoped error attribution,
// and overall-health derivation were all manual checklist procedures. They are the parts most
// likely to break silently — a stale snapshot, a rollback racing a still-initializing engine,
// a teardown fatal blamed on the wrong generation, a `healthy` line over a dead editor — so
// the decision logic is extracted as pure functions and exercised here.
const bridgeSource = fs.readFileSync(new URL('../public/mcp_bridge.js', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const start = bridgeSource.indexOf(startMarker);
  const end = bridgeSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Could not slice ${startMarker} .. ${endMarker}`);
  return bridgeSource.slice(start, end);
}

const api = new Function(`
  ${slice('const EDITOR_TERMINAL_STATES', '  const EditorLifecycle = {')}
  ${slice('const PLAYTEST_SNAPSHOT_TTL_MS', '  async function awaitPlaytestAcknowledgement')}
  ${slice("  // \`status: 'healthy'\` used to be a hardcoded literal", '  function resolvedNodePath')}
  ${slice('  function fatalGodotErrors', '  function currentGenerationErrors')}
  return { editorReplacementPlan, verifyPlaytestAcknowledgement, deriveOverallStatus,
           fatalGodotErrors, generationScopedErrors, PLAYTEST_SNAPSHOT_TTL_MS };
`)();

const {
  editorReplacementPlan, verifyPlaytestAcknowledgement, deriveOverallStatus,
  fatalGodotErrors, generationScopedErrors, PLAYTEST_SNAPSHOT_TTL_MS
} = api;

// ---------------------------------------------------------------- playtest handshake

const stagedSnapshot = (overrides = {}) => ({
  projectName: 'demo',
  revision: 7,
  launchToken: 'launch_abc',
  stagedAt: 1000,
  files: { 'project.godot': 'x', 'main.tscn': 'y' },
  fingerprint: 'sha256:deadbeef',
  ...overrides
});

const goodAck = (overrides = {}) => ({
  ok: true, revision: 7, launchToken: 'launch_abc', fingerprint: 'sha256:deadbeef',
  written: 2, failed: [], ...overrides
});

test('1. a correct revision and fingerprint is accepted', () => {
  const result = verifyPlaytestAcknowledgement(stagedSnapshot(), goodAck(), 1500);
  assert.equal(result.ok, true);
  assert.equal(result.revision, 7);
  assert.equal(result.fingerprint, 'sha256:deadbeef');
});

test('2. a wrong revision is rejected', () => {
  const result = verifyPlaytestAcknowledgement(stagedSnapshot(), goodAck({ revision: 107 }), 1500);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REVISION_MISMATCH');
  assert.match(result.error, /107.*not 7/);
});

test('3. a missing acknowledgement is rejected', () => {
  const result = verifyPlaytestAcknowledgement(stagedSnapshot(), null, 1500);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_ACK');
});

test('4. a partial copy is rejected even when the engine reports ok', () => {
  // Two files staged, one written: the game would boot a half-updated project.
  const result = verifyPlaytestAcknowledgement(stagedSnapshot(), goodAck({ written: 1 }), 1500);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PARTIAL_COPY');
  assert.match(result.error, /wrote 1 of 2/);

  const failed = verifyPlaytestAcknowledgement(stagedSnapshot(), goodAck({ ok: false, failed: [{ path: 'main.tscn' }] }), 1500);
  assert.equal(failed.code, 'COPY_FAILED');
});

test('5. a human pressing Play with no staged snapshot never satisfies a tool launch', () => {
  // Execute() also runs for a manual Play. The game side reports `no_staged_snapshot`, which
  // must not be mistaken for a verified launch.
  const ack = { ok: false, reason: 'no_staged_snapshot', error: 'No project snapshot was staged for this run.', revision: null, launchToken: null };
  const result = verifyPlaytestAcknowledgement(stagedSnapshot(), ack, 1500);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SNAPSHOT_ALREADY_CONSUMED');
});

test('6. a stale launch token is rejected, and so is an expired snapshot', () => {
  const replayed = verifyPlaytestAcknowledgement(stagedSnapshot(), goodAck({ launchToken: 'launch_previous' }), 1500);
  assert.equal(replayed.ok, false);
  assert.equal(replayed.code, 'LAUNCH_TOKEN_MISMATCH');

  const expired = verifyPlaytestAcknowledgement(stagedSnapshot(), goodAck(), 1000 + PLAYTEST_SNAPSHOT_TTL_MS + 1);
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'SNAPSHOT_EXPIRED');
});

test('a fingerprint that disagrees, or is absent, is rejected', () => {
  // The revision is only a label; the fingerprint is what ties the ack to the actual bytes.
  const wrong = verifyPlaytestAcknowledgement(stagedSnapshot(), goodAck({ fingerprint: 'sha256:0000' }), 1500);
  assert.equal(wrong.code, 'FINGERPRINT_MISMATCH');

  const missing = verifyPlaytestAcknowledgement(stagedSnapshot(), goodAck({ fingerprint: null }), 1500);
  assert.equal(missing.code, 'FINGERPRINT_MISSING');
});

// ---------------------------------------------------------------- editor lifecycle

test('7. a boot timeout leaves the engine initializing, which is a HARD barrier to replacement', () => {
  // This is the state that corrupted things: a boot that never confirmed, then a rollback
  // building a second Engine over the half-constructed first one.
  const plan = editorReplacementPlan('initializing');
  assert.equal(plan.action, 'await_exit');
  assert.equal(plan.mustAwaitExit, true);
  assert.equal(plan.requestQuit, true, 'a stuck initializing engine must be asked to quit');
  assert.equal(plan.exitRequired, true, 'replacing an initializing engine must be refused, not risked');
  assert.ok(plan.waitMs >= 20000, 'an initializing engine gets the long wait');
});

test('8. no same-page takeover without a confirmed exit, in ANY non-terminal state', () => {
  // The barrier was defeated by being asymmetric: the original path refused for
  // `initializing`, then rollback arrived while the engine read `quitting` — a state that
  // permitted takeover after a short wait — and recreated the very overlap the barrier
  // existed to prevent. Both Engines share one JS context, the canvas, and the `editor`
  // global, so no non-terminal state is safe to replace over.
  for (const state of ['initializing', 'running', 'quitting']) {
    const plan = editorReplacementPlan(state);
    assert.equal(plan.mustAwaitExit, true, `state ${state} must await exit`);
    assert.equal(plan.exitRequired, true, `state ${state} must REQUIRE a confirmed exit, never take over`);
    assert.ok(plan.waitMs >= 20000, `state ${state} must get the full wait`);
  }
  // A quitting engine has already been asked to quit; asking again is pointless.
  assert.equal(editorReplacementPlan('quitting').requestQuit, false);
  assert.equal(editorReplacementPlan('running').requestQuit, true);
  assert.equal(editorReplacementPlan('initializing').requestQuit, true);
});

test('terminal states start a replacement immediately', () => {
  for (const state of ['idle', 'exited', 'failed']) {
    const plan = editorReplacementPlan(state);
    assert.equal(plan.action, 'start', `state ${state} is terminal`);
    assert.equal(plan.mustAwaitExit, false);
    assert.equal(plan.exitRequired, false);
  }
});

// ---------------------------------------------------------------- generation scoping

const LOGS = [
  { time: 10, level: 'error', generation: 1, msg: 'ERROR: FATAL: Index p_index = -1 is out of bounds (size() = 0).' },
  { time: 20, level: 'error', generation: 1, msg: 'ERROR: 5 RID allocations of type ShadowAtlas were leaked at exit.' },
  { time: 30, level: 'error', generation: 2, msg: 'ERROR: SCRIPT ERROR: something real in the new generation' },
  { time: 31, level: 'error', generation: 2, msg: 'WARNING: 195 ObjectDB instances were leaked at exit' },
  { time: 40, level: 'info', generation: 2, msg: 'ERROR: 13 RID allocations of type Texture were leaked at exit.' }
];

test('10. a fatal from the previous generation does not fail the replacement', () => {
  // The fatal at t=10 belongs to generation 1's teardown. Validating generation 2 must ignore
  // it, or every replacement after a crash would fail forever.
  assert.equal(fatalGodotErrors(0, 2, LOGS).length, 0);
  assert.equal(fatalGodotErrors(0, 1, LOGS).length, 1);
  // Ungenerationed queries still see everything, which is what session status wants.
  assert.equal(fatalGodotErrors(0, null, LOGS).length, 1);
});

test('teardown leak noise is excluded from a generation\'s real errors', () => {
  const errors = generationScopedErrors(LOGS, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /SCRIPT ERROR/);

  const generationOne = generationScopedErrors(LOGS, 1);
  assert.equal(generationOne.length, 1, 'the RID leak line must not count as a generation-1 error');
  assert.match(generationOne[0].msg, /FATAL/);
});

// ---------------------------------------------------------------- overall health

test('overall status is never healthy while the engine or session has failed', () => {
  assert.equal(deriveOverallStatus({ engine: 'failed', session: 'failed', commandChannelAvailable: false }).status, 'failed');
  assert.equal(deriveOverallStatus({ engine: 'ready', session: 'failed', commandChannelAvailable: true }).status, 'failed');
  assert.equal(deriveOverallStatus({ engine: 'ready', session: 'restore_failed', commandChannelAvailable: true }).status, 'failed');
  // The exact reported state: engine failed, session failed, channel gone — previously 'healthy'.
  const reported = deriveOverallStatus({ engine: 'failed', session: 'failed', commandChannelAvailable: false, lifecycleState: 'failed' });
  assert.equal(reported.status, 'failed');
  assert.equal(reported.reason, 'engine_failed');
});

test('a current-generation fatal fails the overall status outright', () => {
  assert.equal(deriveOverallStatus({ engine: 'ready', session: 'editor-ready', commandChannelAvailable: true, fatalCount: 1 }).status, 'failed');
});

test('9. an editor apply that could not be persisted reports degraded, not healthy', () => {
  const result = deriveOverallStatus({ engine: 'ready', session: 'dirty_unpersisted', commandChannelAvailable: true, unpersisted: true });
  assert.equal(result.status, 'degraded');
  assert.equal(result.reason, 'unpersisted_changes');
});

test('a missing command channel is degraded, and restarting is recovering', () => {
  assert.equal(deriveOverallStatus({ engine: 'ready', session: 'editor-ready', commandChannelAvailable: false, commandChannelExpected: true }).status, 'degraded');
  assert.equal(deriveOverallStatus({ engine: 'loading', session: 'authoring' }).status, 'recovering');
  assert.equal(deriveOverallStatus({ engine: 'ready', session: 'authoring', lifecycleState: 'initializing', commandChannelAvailable: true }).status, 'recovering');
  assert.equal(deriveOverallStatus({ engine: 'ready', session: 'auto_restoring', commandChannelAvailable: true }).status, 'recovering');
});

test('healthy requires everything, and is reachable', () => {
  const result = deriveOverallStatus({
    engine: 'ready', session: 'editor-ready', lifecycleState: 'running',
    commandChannelAvailable: true, commandChannelExpected: true, fatalCount: 0, unpersisted: false
  });
  assert.equal(result.status, 'healthy');
  assert.equal(result.reason, null);

  // Before any editor has booted the channel is not expected, so its absence is not degraded.
  assert.equal(deriveOverallStatus({
    engine: 'ready', session: 'editor-ready', commandChannelAvailable: false, commandChannelExpected: false
  }).status, 'healthy');
});

// ---------------------------------------------------------------- fingerprint canonicality

const fingerprintProjectBytes = new Function(`
  ${slice('  async function fingerprintProjectBytes', '  function yieldProgress')}
  return fingerprintProjectBytes;
`)();

test('the handshake fingerprint is identical whether content is held as text or bytes', async () => {
  // The bridge stages strings; the playtest copier hashes the encoded buffers it actually
  // wrote. A framing that distinguishes the two makes the comparison always fail — which is
  // exactly what happened live, with a correct copy reported as FINGERPRINT_MISMATCH.
  const encoder = new TextEncoder();
  const asText = { 'project.godot': 'config_version=5', 'main.tscn': '[gd_scene]' };
  const asBytes = Object.fromEntries(Object.entries(asText).map(([k, v]) => [k, encoder.encode(v)]));
  assert.equal(await fingerprintProjectBytes(asText), await fingerprintProjectBytes(asBytes));
});

test('the fingerprint is order-independent but content- and path-sensitive', async () => {
  const a = await fingerprintProjectBytes({ 'a.txt': 'one', 'b.txt': 'two' });
  const b = await fingerprintProjectBytes({ 'b.txt': 'two', 'a.txt': 'one' });
  assert.equal(a, b, 'key order must not change the fingerprint');

  assert.notEqual(a, await fingerprintProjectBytes({ 'a.txt': 'one', 'b.txt': 'CHANGED' }));
  assert.notEqual(a, await fingerprintProjectBytes({ 'a.txt': 'one', 'c.txt': 'two' }));
  // res:// prefixes and leading slashes normalize to the same path.
  assert.equal(a, await fingerprintProjectBytes({ 'res://a.txt': 'one', '/b.txt': 'two' }));
});

test('a length-prefixed framing prevents adjacent-content collisions', async () => {
  // Without length prefixes, {ab: '', c: 'd'} and {a: 'bc', d: ''} could concatenate alike.
  assert.notEqual(
    await fingerprintProjectBytes({ ab: '', c: 'd' }),
    await fingerprintProjectBytes({ a: 'bc', d: '' }));
});

// ---------------------------------------------------------------- recovery after exit timeout

test('a page that cannot confirm an exit is reported as failed, not merely degraded', () => {
  // Once an engine has not confirmed its exit, nothing in this JS context can host a
  // replacement. The status must say so rather than describing a recoverable condition.
  const blocked = deriveOverallStatus({
    engine: 'ready', session: 'editor-ready', commandChannelAvailable: true, restartRequired: true
  });
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.reason, 'restart_required');

  // The session flag alone is enough, even without the explicit input.
  assert.equal(deriveOverallStatus({ engine: 'loading', session: 'restart_required' }).reason, 'restart_required');
});

// ---------------------------------------------------------------- diagnostic classification

const diagnosticApi = new Function(`
  ${slice('  const PLATFORM_DIAGNOSTIC_PATTERNS', '  function currentGenerationErrors')}
  return { classifyEngineDiagnostics, diagnoseEngineSession };
`)();
const { classifyEngineDiagnostics, diagnoseEngineSession } = diagnosticApi;

test('platform noise is separated from actionable project errors', () => {
  // A healthy fresh session reported `session_errors: 5`, all of which were the browser
  // platform behaving normally. Presenting those next to `status: healthy` teaches people to
  // ignore the number, which is how a real error gets missed.
  const logs = [
    { time: 1, level: 'error', generation: 2, msg: 'ERROR: Occlusion culling is disabled in this build.' },
    { time: 2, level: 'error', generation: 2, msg: 'ERROR: Condition "err != OK" is true. Returning: ERR_CANT_CREATE' },
    { time: 2.5, level: 'error', generation: 2, msg: '   at: listen (core/io/tcp_server.cpp:56)' },
    { time: 3, level: 'error', generation: 2, msg: 'Blocking on the main thread is very dangerous, see emscripten docs' },
    { time: 4, level: 'error', generation: 2, msg: 'ERROR: SCRIPT ERROR: Parse Error in res://main.gd' },
    { time: 5, level: 'warn', generation: 2, msg: 'WARNING: node has no shape defined' },
    { time: 6, level: 'error', generation: 2, msg: 'ERROR: 5 RID allocations were leaked at exit.' },
    { time: 7, level: 'error', generation: 1, msg: 'ERROR: SCRIPT ERROR: belongs to a previous generation' }
  ];
  const result = classifyEngineDiagnostics(logs, 2);
  assert.deepEqual(result.errors.length, 1, `expected one actionable error, got ${JSON.stringify(result.errors)}`);
  assert.match(result.errors[0], /Parse Error/);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.platform_diagnostics.length, 3);
});

test('a FATAL is always an actionable error, never platform noise', () => {
  const result = classifyEngineDiagnostics(
    [{ time: 1, level: 'error', generation: 1, msg: 'ERROR: FATAL: Index p_index = -1 is out of bounds (size() = 0).' }], 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.platform_diagnostics.length, 0);
});

test('a message is classified together with its "at:" location line', () => {
  // `ERROR: Condition "err != OK" is true. Returning: ERR_CANT_CREATE` is meaningless alone —
  // only the following `at: listen (core/io/tcp_server.cpp:56)` identifies it as the browser
  // having no TCP sockets. Classified apart, it showed up as an actionable project error in an
  // otherwise healthy session.
  const paired = classifyEngineDiagnostics([
    { time: 1, level: 'error', generation: 1, msg: 'ERROR: Condition "err != OK" is true. Returning: ERR_CANT_CREATE' },
    { time: 2, level: 'error', generation: 1, msg: '   at: listen (core/io/tcp_server.cpp:56)' }
  ], 1);
  assert.equal(paired.errors.length, 0, `expected no actionable errors, got ${JSON.stringify(paired.errors)}`);
  assert.equal(paired.platform_diagnostics.length, 1);

  // A genuine project error keeps its location line attached and stays actionable.
  const real = classifyEngineDiagnostics([
    { time: 1, level: 'error', generation: 1, msg: 'ERROR: SCRIPT ERROR: Parse Error: Unexpected token' },
    { time: 2, level: 'error', generation: 1, msg: '   at: GDScript::reload (modules/gdscript/gdscript.cpp:100)' }
  ], 1);
  assert.equal(real.errors.length, 1);
  assert.match(real.errors[0], /gdscript\.cpp/);
});

test('a WARNING: written to stderr is a warning, not a project error', () => {
  // Godot writes WARNING: lines to stderr, so the console interceptor tags them level 'error'.
  // Testing the level before the prefix counted every engine warning as an actionable project
  // error; the live template simply happened not to emit one.
  const result = classifyEngineDiagnostics([
    { time: 1, level: 'error', generation: 1, msg: 'WARNING: Node has no shape defined.' },
    { time: 2, level: 'error', generation: 1, msg: '   at: _notification (scene/3d/collision_shape_3d.cpp:60)' }
  ], 1);
  assert.deepEqual(result.errors, [], `a stderr WARNING was counted as a project error: ${JSON.stringify(result.errors)}`);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /no shape defined/);
});

test('FATAL still outranks the WARNING prefix', () => {
  const result = classifyEngineDiagnostics(
    [{ time: 1, level: 'error', generation: 1, msg: 'WARNING: something then FATAL: Index p_index = -1 is out of bounds (size() = 0).' }], 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.warnings.length, 0);
});

test('a genuine stderr error is still an actionable project error', () => {
  const result = classifyEngineDiagnostics(
    [{ time: 1, level: 'error', generation: 1, msg: 'ERROR: SCRIPT ERROR: Parse Error: Unexpected identifier' }], 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.warnings.length, 0);
});

test('the browser filesystem sync limitation is classified as platform noise, not a project error', () => {
  const result = classifyEngineDiagnostics([
    { time: 1, generation: 1, level: 'error', msg: 'Failed to save IDB file system: No such file or directory' }
  ], 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.platform_diagnostics.length, 1);
});

test('rolled-back script diagnostics remain auditable but are not active project errors', () => {
  const result = classifyEngineDiagnostics([
    { time: 1, generation: 1, level: 'error', resolved: true, msg: 'SCRIPT ERROR: Parse Error: Expected parameter name.' },
    { time: 2, generation: 1, level: 'error', resolved: true, msg: 'at: GDScript::reload (res://broken.gd:3)' }
  ], 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.resolved_diagnostics.length, 1);
});

test('a fatal remains active even if a rollback window tried to mark it resolved', () => {
  const result = classifyEngineDiagnostics([
    { time: 1, generation: 1, level: 'error', resolved: true, msg: 'FATAL: engine invariant failed' }
  ], 1);
  assert.equal(result.errors.length, 1);
});

test('game-engine WebGL teardown noise is not attributed to the still-running editor project', () => {
  const messages = [
    'ERROR: Pages in use exist at exit in PagedAllocator: GeometryInstanceGLES3',
    'ERROR: 2 shaders of type SceneShaderGLES3 were never freed',
    'ERROR: Buffer with GL ID of 894: leaked 480 bytes.',
    'WARNING: Leaked instance dependency: Bug - did not call instance_notify_deleted when freeing.',
    'ERROR: 8 resources still in use at exit (run with --verbose for details).'
  ];
  const result = classifyEngineDiagnostics(messages.map((msg, index) => ({ time: index, generation: 1, level: 'error', msg })), 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
});

test('session diagnosis explains the Web DAP socket failure without blaming the project', () => {
  const result = diagnoseEngineSession([
    { time: 1, level: 'error', generation: 1, msg: 'ERROR: Condition "err != OK" is true. Returning: ERR_CANT_CREATE' },
    { time: 2, level: 'error', generation: 1, msg: '   at: listen (core/io/tcp_server.cpp:56)' },
    { time: 3, level: 'error', generation: 1, msg: '--- Failed to start Debug adapter server on port 6006: Can\'t create ---' }
  ], 1);
  assert.equal(result.status, 'no_project_action_required');
  assert.equal(result.actionable_issue_count, 0);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'GODOT_WEB_DAP_UNAVAILABLE');
  assert.equal(result.issues[0].owner, 'godot_web_platform');
  assert.equal(result.issues[0].severity, 'info');
  assert.equal(result.issues[0].automatic_fix.available, false);
  assert.match(result.issues[0].probable_cause, /raw TCP/i);
});

test('session diagnosis makes malformed resource escapes actionable and auto-repairable', () => {
  const result = diagnoseEngineSession([
    { time: 1, level: 'error', generation: 4, msg: 'WARNING: Godot 3.x SpatialMaterial remapped parameter not found: \\nemission_enabled' },
    { time: 2, level: 'error', generation: 4, msg: '   at: _set (scene/resources/material.cpp:4096)' }
  ], 4);
  assert.equal(result.status, 'action_required');
  assert.equal(result.issues[0].code, 'MALFORMED_TEXT_RESOURCE_ESCAPE');
  assert.equal(result.issues[0].owner, 'project_source');
  assert.equal(result.issues[0].automatic_fix.available, true);
  assert.equal(result.issues[0].automatic_fix.tool, 'godot_restore_project_session');
});

test('session diagnosis prioritizes script errors, fatal traps, and recovery state', () => {
  const result = diagnoseEngineSession([
    { time: 1, level: 'error', generation: 2, msg: 'ERROR: SCRIPT ERROR: Parse Error: Unexpected identifier in res://runner.gd' },
    { time: 2, level: 'error', generation: 2, msg: 'ERROR: FATAL: Index p_index = -1 is out of bounds (size() = 0).' }
  ], 2, { restartRequired: true, persistenceError: 'IndexedDB write failed' });
  assert.equal(result.status, 'restart_required');
  assert.equal(result.highest_severity, 'fatal');
  assert.ok(result.issues.some(issue => issue.code === 'ENGINE_FATAL'));
  assert.ok(result.issues.some(issue => issue.code === 'PROJECT_SCRIPT_OR_RESOURCE_ERROR'));
  assert.ok(result.issues.some(issue => issue.code === 'EDITOR_RESTART_REQUIRED'));
  assert.ok(result.issues.some(issue => issue.code === 'PROJECT_PERSISTENCE_FAILED'));
  assert.ok(result.recommended_next_tools.includes('godot_inspect_project_files'));
});

// ---------------------------------------------------------------- boot-in-flight overrides state

test('a terminal lifecycle state is not trusted while a boot is in flight', () => {
  // Godot's project-manager re-exec boots an engine while the lifecycle still reads `exited`.
  // Trusting that string would let a replacement construct a second Engine over a live one —
  // the exact ownership condition everything here exists to prevent.
  for (const state of ['idle', 'exited', 'failed']) {
    const idle = editorReplacementPlan(state, false);
    assert.equal(idle.action, 'start', `${state} with no boot in flight may start`);

    const booting = editorReplacementPlan(state, true);
    assert.equal(booting.action, 'await_exit', `${state} with a boot in flight must NOT start`);
    assert.equal(booting.exitRequired, true);
    assert.ok(booting.waitMs >= 20000);
  }
});

test('boot-in-flight does not weaken the non-terminal states', () => {
  for (const state of ['initializing', 'running', 'quitting']) {
    assert.equal(editorReplacementPlan(state, true).exitRequired, true);
    assert.equal(editorReplacementPlan(state, false).exitRequired, true);
  }
});

test("the page's own runtime-lifecycle notes are not counted as errors in the authored project", () => {
  const result = classifyEngineDiagnostics([
    { time: 1, generation: 1, level: 'error', msg: '[Runtime lifecycle] failed and cleaned up' },
    { time: 2, generation: 1, level: 'warn', msg: '[Preview Refresh] the preview could not be restarted' }
  ], 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.platform_diagnostics.length, 2);
});

test('a genuine project error is still an error even beside a bridge note', () => {
  const result = classifyEngineDiagnostics([
    { time: 1, generation: 1, level: 'error', msg: '[Runtime lifecycle] failed and cleaned up' },
    { time: 2, generation: 1, level: 'error', msg: 'SCRIPT ERROR: Parse Error: Expected end of statement.' }
  ], 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Parse Error/);
});

// ---------------------------------------------------------------------------
// Agent presence: a collaborator you can see, not a marker that blinks
// ---------------------------------------------------------------------------

const bridgeText = fs.readFileSync(new URL('../public/mcp_bridge.js', import.meta.url), 'utf8');

function bridgeSlice(startMarker, endMarker) {
  const start = bridgeText.indexOf(startMarker);
  const end = bridgeText.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Could not slice ${startMarker} .. ${endMarker}`);
  return bridgeText.slice(start, end);
}

const { AgentPresence } = new Function('ActivityBeam', `
  ${bridgeSlice('  const AgentPresence = {', '  // A two-pixel line across the top')}
  return { AgentPresence };
`)({ sync() {} });

test('presence counts landed changes, not attempts', () => {
  AgentPresence.state = 'attached';
  AgentPresence.completed = 0;
  AgentPresence.begin('Recolouring SkyrailDeck', 'SkyrailDeck');
  assert.equal(AgentPresence.describe().state, 'working');
  AgentPresence.settle(true);
  AgentPresence.begin('Moving SkyrailDeck', 'SkyrailDeck');
  AgentPresence.settle(false);
  assert.equal(AgentPresence.describe().completed, 1, 'a failed operation is not a change');
  assert.equal(AgentPresence.describe().state, 'attached');
});

test('the held node outlives the operation that touched it', () => {
  AgentPresence.state = 'attached';
  AgentPresence.target = null;
  AgentPresence.begin('Moving PlayerRunner', 'PlayerRunner');
  AgentPresence.settle(true);
  assert.equal(AgentPresence.describe().target, 'PlayerRunner',
    'after an edit settles, the agent is still holding that node');
});

test('presence is derived in the one funnel every tool call passes through', () => {
  const start = bridgeText.indexOf('    update(status, toolName, input, detail');
  const body = bridgeText.slice(start, bridgeText.indexOf('  // 8B2. Agent presence', start));
  assert.match(body, /DIAGNOSTIC_TOOLS\.has\(toolName\)/,
    'reading the session status is not "working on your model"');
  assert.match(body, /AgentPresence\.begin/);
  assert.match(body, /AgentPresence\.settle/);
});

test('the work light is anchored and settles; it is never a bounding box that expires', () => {
  const start = bridgeText.indexOf('    renderWorkLight(');
  const body = bridgeText.slice(start, bridgeText.indexOf('    renderEdgeArrow(', start));
  assert.doesNotMatch(body, /border-top:2px solid|border-left:2px solid/, 'the corner-bracket box is gone');
  assert.match(body, /radial-gradient/);
  assert.match(body, /webmcp-halo-breathe/);
  assert.match(body, /mode: 'anchored'/);
  const focusStart = bridgeText.indexOf("    focus(nodeName, pos = null");
  const focusBody = bridgeText.slice(focusStart, bridgeText.indexOf('    fade(reason', focusStart));
  assert.match(focusBody, /if \(phase !== 'working'\)/,
    'a light must not start fading while the agent is still working there');
});

test('a move is drawn from where the node actually was', () => {
  const start = bridgeText.indexOf("    focus(nodeName, pos = null");
  const body = bridgeText.slice(start, bridgeText.indexOf('    fade(reason', start));
  assert.match(body, /projectWorldPoint\(options\.from/,
    'the trail is two projected points, never an invented arc');
});

test('a camera that held still on purpose says so', () => {
  const start = bridgeText.indexOf('auto_follow: CameraGuidance.autoFollowEnabled()');
  const body = bridgeText.slice(start, start + 900);
  assert.match(body, /last_follow_skipped/);
  assert.match(body, /already_framed/);
  assert.match(body, /agent_presence: AgentPresence\.describe\(\)/);
});

// ---------------------------------------------------------------------------
// The saved project library
// ---------------------------------------------------------------------------

const { savedProjectSummary, SAVED_PROJECT_PREFIX, SAVED_PROJECT_LIMIT } = new Function(`
  ${bridgeSlice('  const SAVED_PROJECT_PREFIX', '  async function readSavedProjectRows')}
  return { savedProjectSummary, SAVED_PROJECT_PREFIX, SAVED_PROJECT_LIMIT };
`)();

test('a library row is summarised by what identifies the work, not by its bytes', () => {
  const summary = savedProjectSummary({
    id: `${SAVED_PROJECT_PREFIX}neon_skyrail_3d`,
    project_name: 'neon_skyrail_3d',
    main_scene: 'res://main_3d.tscn',
    scene_revision: 43,
    files: { 'project.godot': 'x', 'main_3d.tscn': 'y' },
    updated_at: 1700,
    content_fingerprint: 'sha256:abc'
  });
  assert.deepEqual(summary, {
    project_name: 'neon_skyrail_3d',
    main_scene: 'res://main_3d.tscn',
    scene_revision: 43,
    file_count: 2,
    updated_at: 1700,
    content_fingerprint: 'sha256:abc'
  });
});

test('every persist writes a library row beside the active slot', () => {
  const start = bridgeText.indexOf('async function persistActiveProjectState');
  const body = bridgeText.slice(start, bridgeText.indexOf('function isFreshStartRequested', start));
  assert.match(body, /id: 'active'/);
  assert.match(body, /id: `\$\{SAVED_PROJECT_PREFIX\}\$\{DiagnosticState\.activeProject\}`/);
  // Session state must not travel with the library row, or the store grows without bound.
  assert.match(body, /undo_stack: \[\],\s*\n\s*idempotent_mutations: \[\]/);
  assert.match(body, /pruneSavedProjects\(database\)/);
});

test('the library is bounded and evicts the oldest', () => {
  const start = bridgeText.indexOf('async function pruneSavedProjects');
  const body = bridgeText.slice(start, bridgeText.indexOf('async function listSavedProjects', start));
  assert.equal(SAVED_PROJECT_LIMIT, 12);
  assert.match(body, /rows\.length <= SAVED_PROJECT_LIMIT/);
  assert.match(body, /\(b\.updated_at \|\| 0\) - \(a\.updated_at \|\| 0\)/);
  assert.match(body, /\.slice\(SAVED_PROJECT_LIMIT\)/);
});

test('switching projects persists the one being left, and never replays its undo stack', () => {
  const start = bridgeText.indexOf("name: 'godot_open_saved_project'");
  const body = bridgeText.slice(start, bridgeText.indexOf("name: 'godot_get_operation_status'", start));
  assert.match(body, /if \(Object\.keys\(activeFilesDict\)\.length > 0\) await persistActiveProjectState\(\)/,
    'the outgoing project is saved before it is replaced');
  assert.match(body, /undoStack\.length = 0/);
  assert.match(body, /undo_history: 'cleared_on_switch'/);
  assert.match(body, /SAVED_PROJECT_NOT_FOUND/);
});

test('the rail names the project on screen, not only the scene', () => {
  const start = bridgeText.indexOf('// The project name, always visible.');
  assert.ok(start > 0, 'the scene inspector header must name the project');
  const body = bridgeText.slice(start, start + 1400);
  assert.match(body, /DiagnosticState\.activeProject \|\| 'none'/);
  assert.match(body, />Project</);
});
