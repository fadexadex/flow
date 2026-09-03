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

test('the project-manager re-exec path shares the same fenced, catchable boot', async () => {
  // Godot's own project-manager -> editor transition used to be a separate promise chain whose
  // init()/start() were neither returned nor caught, so an async rejection went unhandled and
  // stranded the UI on the loader. It now goes through runEditorBoot with no project files.
  const life = lifecycle(1);
  const engine = fakeEngine();
  let beforeStartRan = false;
  const booting = runEditorBoot({
    engine,
    generation: 1,
    activeGeneration: life.activeGeneration,
    noteStale: life.noteStale,
    projectFiles: null,
    args: ['--path', '/home/web_user/projects/demo', '--editor'],
    startOptions: { persistentDrops: false, canvas: { id: 'editor-canvas' } },
    beforeStart: () => { beforeStartRan = true; }
  });

  engine.finishInit();
  await Promise.resolve();
  engine.failStart(new Error('re-exec start failed'));

  // The whole point: this rejection is observable instead of unhandled.
  await assert.rejects(booting, /re-exec start failed/);
  assert.equal(beforeStartRan, true);
  // No project files were restaged; only the `keep` marker is written.
  assert.deepEqual(engine.copied(), ['/home/web_user/keep']);
});

test('startOptions reach engine.start() without losing args', async () => {
  const life = lifecycle(1);
  const engine = fakeEngine();
  const canvas = { id: 'editor-canvas' };
  const booting = runEditorBoot(bootOptions(engine, life, 1, {
    projectFiles: null,
    startOptions: { persistentDrops: false, canvas }
  }));
  engine.finishInit();
  await Promise.resolve();
  engine.finishStart();
  await booting;

  const [, options] = engine.calls.find(([kind]) => kind === 'start');
  assert.deepEqual(options.args, ['--editor']);
  assert.equal(options.persistentDrops, false, 'startOptions must override the default');
  assert.equal(options.canvas, canvas);
});

// ---------------------------------------------------------------- lifecycle integration
//
// The previous re-exec test checked the boot function's options and rejection propagation but
// never executed the surrounding lifecycle, so it could not catch that the re-exec left the
// lifecycle reading `exited` while the engine was initializing and then running. A false
// terminal state lets a replacement build a second Engine over a live one — the exact
// ownership condition. These drive the transitions themselves.

// A lifecycle that mirrors index.html's, including the keepGeneration rule.
function fakeLifecycle(initialState = 'idle', initialGeneration = 0) {
  const record = { state: initialState, generation: initialGeneration, bootInFlight: false, transitions: [] };
  return {
    record,
    set(state, detail) {
      if (state === 'initializing' && !(detail && detail.keepGeneration)) record.generation += 1;
      record.transitions.push(`${record.state}->${state}@g${record.generation}`);
      record.state = state;
      return record.generation;
    },
    markBootInFlight(active) { record.bootInFlight = active; },
    activeGeneration: () => record.generation
  };
}

test('the re-exec boot leaves the lifecycle running, never stranded at exited', async () => {
  const life = fakeLifecycle('exited', 1);
  const engine = fakeEngine();
  const booting = runEditorBoot({
    engine,
    generation: 1,
    activeGeneration: life.activeGeneration,
    initArgument: undefined,
    projectFiles: null,
    args: ['--path', '/demo', '--editor'],
    startOptions: { persistentDrops: false },
    onBootStart: () => life.set('initializing', { keepGeneration: true }),
    markBootInFlight: life.markBootInFlight,
    onRunning: () => life.set('running')
  });

  // The moment the boot starts, the state must no longer be terminal.
  assert.equal(life.record.state, 'initializing');
  assert.equal(life.record.bootInFlight, true);
  assert.equal(life.record.generation, 1, 'a re-exec reuses the same Engine, so the generation must not move');

  engine.finishInit();
  await Promise.resolve();
  engine.finishStart();
  await booting;

  assert.equal(life.record.state, 'running');
  assert.equal(life.record.bootInFlight, false);
  assert.deepEqual(life.record.transitions, ['exited->initializing@g1', 'initializing->running@g1']);
});

test('bumping the generation on a re-exec would make the boot reject itself', async () => {
  // Guards the keepGeneration rule: generation identity is Engine-instance identity, and a
  // re-exec reuses the instance. Bumping makes the boot's own ownership check fail.
  const life = fakeLifecycle('exited', 1);
  const engine = fakeEngine();
  const booting = runEditorBoot({
    engine,
    generation: 1,
    activeGeneration: life.activeGeneration,
    projectFiles: null,
    onBootStart: () => life.set('initializing'), // deliberately WITHOUT keepGeneration
    markBootInFlight: life.markBootInFlight,
    onRunning: () => life.set('running')
  });
  engine.finishInit();
  const result = await booting;
  assert.equal(result.status, 'superseded', 'a bumped generation must abort its own boot');
  assert.equal(engine.started(), false);
});

test('bootInFlight is cleared even when the boot fails', async () => {
  // Otherwise a failed boot would block every future replacement forever.
  const life = fakeLifecycle('exited', 1);
  const engine = fakeEngine();
  engine.copyFailures.add('main.tscn');
  const booting = runEditorBoot({
    engine,
    generation: 1,
    activeGeneration: life.activeGeneration,
    projectFiles: { 'main.tscn': '[gd_scene]' },
    projectName: 'demo',
    onBootStart: () => life.set('initializing', { keepGeneration: true }),
    markBootInFlight: life.markBootInFlight
  });
  engine.finishInit();
  await assert.rejects(booting, /EDITOR_FS_COPY_FAILED/);
  assert.equal(life.record.bootInFlight, false, 'a failed boot must not leave the flag set');
});

test('bootInFlight brackets the whole sequence, including the superseded exit', async () => {
  const life = fakeLifecycle('idle', 1);
  const engine = fakeEngine();
  const booting = runEditorBoot({
    engine,
    generation: 1,
    activeGeneration: life.activeGeneration,
    projectFiles: null,
    markBootInFlight: life.markBootInFlight
  });
  assert.equal(life.record.bootInFlight, true);
  life.record.generation += 1; // superseded mid-boot
  engine.finishInit();
  const result = await booting;
  assert.equal(result.status, 'superseded');
  assert.equal(life.record.bootInFlight, false);
});

// ---------------------------------------------------------------- call-site guards
//
// The tests above drive runEditorBoot with a lifecycle the test itself wires up, which proves
// the contract but NOT that index.html honours it — the original omission was exactly a
// missing option at the call site. These read the real call sites.

const indexHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function bootCallSites(source) {
  const sites = [];
  let index = source.indexOf('runEditorBoot({');
  while (index >= 0) {
    // Walk braces to the end of the options object.
    let depth = 0;
    let cursor = source.indexOf('{', index);
    const start = cursor;
    do {
      if (source[cursor] === '{') depth += 1;
      else if (source[cursor] === '}') depth -= 1;
      cursor += 1;
    } while (depth > 0 && cursor < source.length);
    sites.push(source.slice(start, cursor));
    index = source.indexOf('runEditorBoot({', cursor);
  }
  return sites;
}

test('every runEditorBoot call site brackets its boot with markBootInFlight', () => {
  const sites = bootCallSites(indexHtml);
  assert.equal(sites.length, 2, `expected the main boot and the re-exec boot, found ${sites.length}`);
  for (const [position, site] of sites.entries()) {
    assert.match(site, /markBootInFlight\s*:/,
      `call site ${position} does not mark its boot in flight, so a terminal lifecycle state would be trusted while an Engine is live`);
  }
});

test('the re-exec call site transitions the lifecycle out of exited and back to running', () => {
  // The reported defect: onExit set `exited`, the re-exec then booted without ever leaving
  // that state, so prepareForReplacement saw a false terminal state.
  const reexec = bootCallSites(indexHtml).find(site => /projectFiles\s*:\s*null/.test(site));
  assert.ok(reexec, 'could not find the re-exec call site (it is the one that stages no files)');
  assert.match(reexec, /onBootStart\s*:/, 're-exec must leave the terminal state before initializing');
  assert.match(reexec, /keepGeneration\s*:\s*true/, 're-exec reuses the same Engine, so it must not bump the generation');
  assert.match(reexec, /onRunning\s*:/, 're-exec must report running when its engine starts');
  assert.match(reexec, /setEditorLifecycle\('running'\)/, 're-exec onRunning must set the lifecycle');
});

test('both call sites catch their boot, so no rejection can go unhandled', () => {
  for (const marker of ['runEditorBoot({']) {
    let index = indexHtml.indexOf(marker);
    while (index >= 0) {
      const tail = indexHtml.slice(index, index + 4000);
      assert.match(tail, /\}\)\s*\.catch\(/, 'a runEditorBoot call site is missing its .catch');
      index = indexHtml.indexOf(marker, index + 1);
    }
  }
});

// ---------------------------------------------------------------------------
// A quit racing a boot: the Engine is torn down between init() and the copy
// ---------------------------------------------------------------------------

// init() resolving does not guarantee the instance is still inited when the very next
// continuation runs. A concurrent quit clears it, and every copyToFS then throws
// "Engine must be inited before copying files" - which is what produced
// EDITOR_FS_COPY_FAILED naming all four project files at once.
function uninitedUntilReinit(engine) {
  let inits = 0;
  const realInit = engine.init.bind(engine);
  const realCopy = engine.copyToFS.bind(engine);
  engine.init = (what) => { inits += 1; return realInit(what); };
  engine.copyToFS = (path, bytes) => {
    if (inits < 2) {
      engine.calls.push(['copyToFS', path]);
      throw new Error('Engine must be inited before copying files');
    }
    return realCopy(path, bytes);
  };
  return { initCount: () => inits };
}

test('an engine torn down between init and the copy is re-inited once, then boots', async () => {
  const life = lifecycle(1);
  const engine = fakeEngine();
  const probe = uninitedUntilReinit(engine);
  const booting = runEditorBoot(bootOptions(engine, life, 1));
  engine.finishInit();
  await Promise.resolve();
  await Promise.resolve();
  engine.finishStart();

  const result = await booting;
  assert.equal(result.status, 'running');
  assert.equal(probe.initCount(), 2, 'the same engine is re-inited; a second Engine is never built');
  assert.equal(engine.started(), true);
});

test('the same teardown while superseded is reported as superseded, not as a copy failure', async () => {
  const life = lifecycle(1);
  const engine = fakeEngine();
  uninitedUntilReinit(engine);
  const booting = runEditorBoot(bootOptions(engine, life, 1));
  engine.finishInit();
  await Promise.resolve();
  life.supersede();

  const result = await booting;
  assert.equal(result.status, 'superseded');
  // Either side of the retry is correct; what matters is that a takeover is reported as a
  // takeover and never as an unwritable-project error.
  assert.ok(['copy', 'reinit'].includes(result.at), `unexpected supersede point: ${result.at}`);
  assert.equal(engine.started(), false, 'a superseded boot must never start');
  assert.ok(life.state.stale.length > 0, 'the takeover is recorded');
});
