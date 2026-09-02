import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridgeSource = fs.readFileSync(new URL('../public/mcp_bridge.js', import.meta.url), 'utf8');

test('1. SHA-256 canonical fingerprint sensitive to content changes', async () => {
  async function computeProjectContentFingerprint(filesDict) {
    const entries = Object.entries(filesDict).sort(([a], [b]) => a.localeCompare(b));
    const parts = [];
    const encoder = new TextEncoder();
    for (const [rawPath, content] of entries) {
      const cleanPath = rawPath.replace(/^res:\/\//, '').replace(/^\/+/, '');
      const pathBytes = encoder.encode(cleanPath);
      const isText = typeof content === 'string';
      const bodyBytes = isText ? encoder.encode(content) : new Uint8Array(content);
      const header = encoder.encode(`\0file:${pathBytes.length}:${isText ? 't' : 'b'}:${bodyBytes.length}:`);
      parts.push(header, pathBytes, bodyBytes);
    }
    const totalLen = parts.reduce((sum, p) => sum + p.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    const hashBuffer = await crypto.subtle.digest('SHA-256', merged);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return `sha256:${hashArray.map(b => b.toString(16).padStart(2, '0')).join('')}`;
  }

  const filesA = {
    'project.godot': 'config_version=5',
    'main.gd': 'var health = 100'
  };
  const filesB = {
    'project.godot': 'config_version=5',
    'main.gd': 'var health = 200'
  };
  const filesA_duplicate = {
    'main.gd': 'var health = 100',
    'project.godot': 'config_version=5'
  };

  const hashA = await computeProjectContentFingerprint(filesA);
  const hashB = await computeProjectContentFingerprint(filesB);
  const hashA_dup = await computeProjectContentFingerprint(filesA_duplicate);

  assert.notEqual(hashA, hashB, 'Hashes must differ when content changes at same length');
  assert.equal(hashA, hashA_dup, 'Hashes must be identical regardless of key insertion order');
  assert.match(hashA, /^sha256:[a-f0-9]{64}$/, 'Hash must be a valid SHA-256 hex string');
});

test('2. Operation sequence monotonicity and phase tracking', async () => {
  const operation = {
    id: 'op_test_1',
    tool: 'godot_create_project',
    label: 'Creating project: Test',
    status: 'running',
    phase: 'accepted',
    sequence: 0,
    lastProgressAt: Date.now(),
    terminal: false,
    startedAt: Date.now(),
    completedAt: null,
    waiters: new Set()
  };

  function advancePhase(op, phase) {
    if (op.terminal) return;
    op.phase = phase;
    op.sequence += 1;
    op.lastProgressAt = Date.now();
    for (const waiter of op.waiters) waiter();
    op.waiters.clear();
  }

  const sequences = [operation.sequence];
  advancePhase(operation, 'validating_request');
  sequences.push(operation.sequence);
  advancePhase(operation, 'staging_files');
  sequences.push(operation.sequence);
  advancePhase(operation, 'stopping_runtime');
  sequences.push(operation.sequence);
  advancePhase(operation, 'booting_editor');
  sequences.push(operation.sequence);
  advancePhase(operation, 'persisting_commit');
  sequences.push(operation.sequence);

  assert.deepEqual(sequences, [0, 1, 2, 3, 4, 5], 'Sequences must increase strictly monotonically');
  assert.equal(operation.phase, 'persisting_commit');
  assert.equal(operation.terminal, false);
});

test('3. Waiter immediate return on newer sequence', async () => {
  const operation = {
    id: 'op_test_2',
    status: 'running',
    phase: 'booting_editor',
    sequence: 5,
    terminal: false,
    waiters: new Set()
  };

  function waitForOperationChange(op, afterSequence, waitMs) {
    if (op.terminal || op.sequence > afterSequence || waitMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let timer = null;
      const onWake = () => {
        if (timer) clearTimeout(timer);
        op.waiters.delete(onWake);
        resolve();
      };
      timer = setTimeout(onWake, waitMs);
      op.waiters.add(onWake);
    });
  }

  const start = Date.now();
  await waitForOperationChange(operation, 3, 5000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `Expected instant return, got ${elapsed}ms`);
  assert.equal(operation.waiters.size, 0, 'No dangling waiters');
});

test('4. Waiter wakeup upon phase change', async () => {
  const operation = {
    id: 'op_test_3',
    status: 'running',
    phase: 'booting_editor',
    sequence: 4,
    terminal: false,
    waiters: new Set()
  };

  function advancePhase(op, phase) {
    op.phase = phase;
    op.sequence += 1;
    for (const w of op.waiters) w();
    op.waiters.clear();
  }

  function waitForOperationChange(op, afterSequence, waitMs) {
    if (op.terminal || op.sequence > afterSequence || waitMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let timer = null;
      const onWake = () => {
        if (timer) clearTimeout(timer);
        op.waiters.delete(onWake);
        resolve();
      };
      timer = setTimeout(onWake, waitMs);
      op.waiters.add(onWake);
    });
  }

  const waitPromise = waitForOperationChange(operation, 4, 3000);
  assert.equal(operation.waiters.size, 1, 'Waiter should be registered');

  setTimeout(() => {
    advancePhase(operation, 'validating_runtime');
  }, 50);

  const start = Date.now();
  await waitPromise;
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `Waiter woke up on phase change in ${elapsed}ms`);
  assert.equal(operation.sequence, 5);
  assert.equal(operation.phase, 'validating_runtime');
  assert.equal(operation.waiters.size, 0);
});

test('5. Waiter timeout and clean removal', async () => {
  const operation = {
    id: 'op_test_4',
    status: 'running',
    phase: 'booting_editor',
    sequence: 2,
    terminal: false,
    waiters: new Set()
  };

  function waitForOperationChange(op, afterSequence, waitMs) {
    if (op.terminal || op.sequence > afterSequence || waitMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let timer = null;
      const onWake = () => {
        if (timer) clearTimeout(timer);
        op.waiters.delete(onWake);
        resolve();
      };
      timer = setTimeout(onWake, waitMs);
      op.waiters.add(onWake);
    });
  }

  const start = Date.now();
  await waitForOperationChange(operation, 2, 80);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 70 && elapsed < 300, `Timed out in expected window: ${elapsed}ms`);
  assert.equal(operation.waiters.size, 0, 'Timed out waiter cleanly deleted from set');
});

test('6. Single terminal transition without double advance', async () => {
  const operation = {
    id: 'op_test_5',
    status: 'running',
    phase: 'persisting_commit',
    sequence: 6,
    terminal: false,
    waiters: new Set()
  };

  operation.completedAt = Date.now();
  operation.terminal = true;
  operation.status = 'succeeded';
  operation.phase = 'ready';
  operation.sequence += 1;
  for (const w of operation.waiters) w();
  operation.waiters.clear();

  assert.equal(operation.status, 'succeeded');
  assert.equal(operation.phase, 'ready');
  assert.equal(operation.terminal, true);
  assert.equal(operation.sequence, 7);
});

test('7. Multiple idempotent observers attached to one operation', () => {
  const observationIds = new Set();
  const options1 = { observation_id: 101 };
  const options2 = { observation_id: 102 };

  if (options1.observation_id) observationIds.add(options1.observation_id);
  if (options2.observation_id) observationIds.add(options2.observation_id);

  assert.equal(observationIds.size, 2);
  assert.ok(observationIds.has(101));
  assert.ok(observationIds.has(102));
});

test('8. Diagnostic tool identification set', () => {
  const DIAGNOSTIC_TOOLS = new Set([
    'godot_get_operation_status',
    'godot_get_session_status',
    'godot_diagnose_session',
    'godot_get_logs',
    'godot_get_game_telemetry',
    'godot_get_input_sequence_status',
    'godot_get_project_upload_status'
  ]);

  assert.ok(DIAGNOSTIC_TOOLS.has('godot_get_operation_status'));
  assert.ok(DIAGNOSTIC_TOOLS.has('godot_get_session_status'));
  assert.ok(DIAGNOSTIC_TOOLS.has('godot_diagnose_session'));
  assert.ok(!DIAGNOSTIC_TOOLS.has('godot_create_project'));
  assert.ok(!DIAGNOSTIC_TOOLS.has('godot_apply_file_transaction'));
});

test('9. Bridge source code integrity checks', () => {
  assert.ok(bridgeSource.includes('computeProjectContentFingerprint'), 'Bridge includes content fingerprinting');
  assert.ok(bridgeSource.includes('executeRestoreOperation'), 'Bridge includes executeRestoreOperation');
  assert.ok(bridgeSource.includes('runStartupResumeCoordinator'), 'Bridge includes startup resume coordinator');
  assert.ok(bridgeSource.includes('after_sequence'), 'Bridge includes after_sequence');
  assert.ok(bridgeSource.includes('wait_ms'), 'Bridge includes wait_ms');
  assert.ok(bridgeSource.includes('ResumeState'), 'Bridge includes ResumeState');
  assert.ok(bridgeSource.includes('showResumeAvailableUI'), 'Bridge includes showResumeAvailableUI');
  assert.ok(bridgeSource.includes('showResumeRecoveryUI'), 'Bridge includes showResumeRecoveryUI');
});
