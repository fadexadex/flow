import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Ownership regression protection with two controllable fake Engines.
//
// Every failure in this area has been a continuation from a superseded generation reaching the
// live one, and until now those properties were only demonstrable by hand in a browser. This
// drives the real boot sequence from public/editor_boot.js with engines whose init/start
// promises resolve exactly when the test says so.
const scope = {};
new Function('window', fs.readFileSync(new URL('../public/editor_boot.js', import.meta.url), 'utf8'))(scope);
const { runEditorBoot, copyProjectFilesIntoEngine } = scope.GodotEditorBoot;

// A fake Engine whose init() and start() are resolved by the test, recording every call.
function fakeEngine(name = 'engine') {
  const calls = [];
  let resolveInit; let rejectInit; let resolveStart; let rejectStart;
  const initPromise = new Promise((resolve, reject) => { resolveInit = resolve; rejectInit = reject; });
  const startPromise = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  return {
    name,
    calls,
    copyFailures: new Set(),
    init(what) { calls.push(['init', what]); return initPromise; },
    start(options) { calls.push(['start', options]); return startPromise; },
    copyToFS(path) {
      calls.push(['copyToFS', path]);
      for (const needle of this.copyFailures) {
        if (String(path).includes(needle)) throw new Error(`injected copyToFS failure for ${needle}`);
      }
    },
    finishInit: () => resolveInit(),
    failInit: (error) => rejectInit(error),
    finishStart: () => resolveStart(),
    failStart: (error) => rejectStart(error),
    copied() { return calls.filter(([kind]) => kind === 'copyToFS').map(([, path]) => path); },
    started() { return calls.some(([kind]) => kind === 'start'); }
  };
}

// A generation counter the test advances to simulate a replacement taking over.
function lifecycle(initial = 1) {
  const state = { generation: initial, stale: [] };
  return {
    state,
    activeGeneration: () => state.generation,
    noteStale: (generation, what) => state.stale.push({ generation, what }),
    supersede: () => { state.generation += 1; return state.generation; }
  };
}

const bootOptions = (engine, life, generation, extra = {}) => ({
  engine,
  generation,
  activeGeneration: life.activeGeneration,
  noteStale: life.noteStale,
  projectFiles: { 'project.godot': 'config_version=5', 'main.tscn': '[gd_scene]' },
  projectName: 'demo',
  args: ['--editor'],
  ...extra
});

test('1. generation A resolving init() after generation B exists must not touch anything', async () => {
  // The exact crash: A's slow init() resolves after B was constructed, and A's continuation
  // copies files into whatever the globals now point at — an Engine that is not yet inited.
  const life = lifecycle(1);
  const engineA = fakeEngine('A');
  const booting = runEditorBoot(bootOptions(engineA, life, 1));

  life.supersede(); // generation 2 takes over while A is still initializing
  engineA.finishInit();

  const result = await booting;
  assert.equal(result.status, 'superseded');
  assert.equal(result.at, 'init');
  assert.deepEqual(engineA.copied(), [], 'a superseded boot must not copy a single file');
  assert.equal(engineA.started(), false, 'a superseded boot must never start its engine');
  assert.equal(life.state.stale.length, 1);
  assert.match(life.state.stale[0].what, /init\(\) continuation/);
});

test('2. generation A rejecting init() after B is running surfaces as a normal rejection', async () => {
  const life = lifecycle(1);
  const engineA = fakeEngine('A');
  const booting = runEditorBoot(bootOptions(engineA, life, 1));
  life.supersede();
  engineA.failInit(new Error('WebGL context lost'));

  // It still rejects — the caller decides whether to show it, and index.html's
  // displayFailureNotice fences on generation BEFORE logging so it cannot be filed against
  // the live generation.
  await assert.rejects(booting, /WebGL context lost/);
  assert.equal(engineA.started(), false);
});

test('3. a late start() resolution from a superseded generation does not report running', async () => {
  const life = lifecycle(1);
  const engineA = fakeEngine('A');
  let ranOnRunning = false;
  const booting = runEditorBoot(bootOptions(engineA, life, 1, { onRunning: () => { ranOnRunning = true; } }));

  engineA.finishInit();
  await Promise.resolve();
  life.supersede(); // B takes over while A is starting
  engineA.finishStart();

  const result = await booting;
  assert.equal(result.status, 'superseded');
  assert.equal(result.at, 'start');
  assert.equal(ranOnRunning, false, 'a superseded boot must never announce itself as running');
  assert.ok(life.state.stale.some(entry => /start\(\) continuation/.test(entry.what)));
});

test('4. an asynchronous start() rejection is chained and reaches the caller', async () => {
  // The reported P1: start()'s promise was created inside init().then(...) but not returned,
  // so its rejection escaped the trailing .catch and the lifecycle sat in `initializing`
  // until an outer timeout.
  const life = lifecycle(1);
  const engine = fakeEngine();
  let ranOnRunning = false;
  const booting = runEditorBoot(bootOptions(engine, life, 1, { onRunning: () => { ranOnRunning = true; } }));

  engine.finishInit();
  await Promise.resolve();
  engine.failStart(new Error('engine start failed asynchronously'));

  await assert.rejects(booting, /engine start failed asynchronously/);
  assert.equal(ranOnRunning, false);
});

test('5. a copyToFS failure aborts before start() and names every failed path', async () => {
  const life = lifecycle(1);
  const engine = fakeEngine();
  engine.copyFailures.add('main.tscn');
  const booting = runEditorBoot(bootOptions(engine, life, 1));
  engine.finishInit();

  const error = await booting.then(() => null, (e) => e);
  assert.ok(error, 'the boot must reject');
  assert.equal(error.code, 'EDITOR_FS_COPY_FAILED');
  assert.deepEqual(error.failed_paths, ['main.tscn']);
  assert.match(error.message, /injected copyToFS failure/);
  assert.equal(engine.started(), false, 'start() must never be called after a copy failure');
});

test('a successful boot copies every file, then starts, then reports running exactly once', async () => {
  const life = lifecycle(1);
  const engine = fakeEngine();
  const phases = [];
  let running = 0;
  const booting = runEditorBoot(bootOptions(engine, life, 1, {
    setPhase: (phase) => phases.push(phase),
    onRunning: () => { running += 1; }
  }));

  engine.finishInit();
  await Promise.resolve();
  engine.finishStart();

  const result = await booting;
  assert.equal(result.status, 'running');
  assert.equal(running, 1);
  const copied = engine.copied();
  assert.ok(copied.some(path => path.endsWith('/demo/project.godot')));
  assert.ok(copied.some(path => path.endsWith('/demo/main.tscn')));
  // Ordering matters: every file lands before the engine starts.
  const startIndex = engine.calls.findIndex(([kind]) => kind === 'start');
  const lastCopy = engine.calls.map(([kind]) => kind).lastIndexOf('copyToFS');
  assert.ok(lastCopy < startIndex, 'files must be copied before start()');
  assert.deepEqual(phases, ['Mounting virtual filesystem', 'Opening project']);
  assert.equal(life.state.stale.length, 0);
});

test('6. two concurrent boots: only the active generation reaches running', async () => {
  // Both engines exist at once, which is the situation the whole design guards. A must not
  // start, must not copy, and must not report running; B must complete normally.
  const life = lifecycle(1);
  const engineA = fakeEngine('A');
  const engineB = fakeEngine('B');
  let runningA = false; let runningB = false;

  const bootA = runEditorBoot(bootOptions(engineA, life, 1, { onRunning: () => { runningA = true; } }));
  const generationB = life.supersede();
  const bootB = runEditorBoot(bootOptions(engineB, life, generationB, { onRunning: () => { runningB = true; } }));

  // A's init resolves late, after B already exists.
  engineA.finishInit();
  engineB.finishInit();
  await Promise.resolve();
  engineB.finishStart();

  const [resultA, resultB] = await Promise.all([bootA, bootB]);
  assert.equal(resultA.status, 'superseded');
  assert.equal(resultB.status, 'running');
  assert.equal(runningA, false);
  assert.equal(runningB, true);
  assert.deepEqual(engineA.copied(), [], 'the superseded engine copied files');
  assert.ok(engineB.copied().length >= 2);
  // Critically: A never touched B.
  assert.ok(engineA.calls.every(([kind]) => kind === 'init'), `A did more than init: ${JSON.stringify(engineA.calls)}`);
});

test('the file copier reports every failure rather than stopping at the first', () => {
  const engine = fakeEngine();
  engine.copyFailures.add('a.txt');
  engine.copyFailures.add('c.txt');
  const failures = copyProjectFilesIntoEngine(engine, { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' }, 'demo', new TextEncoder());
  assert.deepEqual(failures.map(f => f.path), ['a.txt', 'c.txt']);
  assert.ok(engine.copied().some(path => path.endsWith('/demo/b.txt')), 'a healthy file must still be attempted');
});
