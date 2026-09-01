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
