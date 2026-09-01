/**
 * Godot editor boot sequence — the ownership-critical part, isolated so it can be tested.
 *
 * Two Engine instances can exist in one page during a replacement, and they share the canvas
 * and the `editor` global. Every bug in this area has had the same shape: a continuation
 * belonging to a superseded generation reaching the live one. `init()` resolving late and
 * calling `copyToFS` on a newer, uninitialized Engine broke every project file with
 * "Engine must be inited before copying files"; a late `onExit` marked the wrong generation
 * dead.
 *
 * So the rule this module enforces is single: an Engine is owned by the boot that created it,
 * and every await point re-checks that the boot is still the active generation before it
 * touches anything shared.
 *
 * It is deliberately free of DOM and of the Engine class: the caller supplies both. That is
 * what lets `test/editor_boot.test.mjs` drive it with controllable fake engines instead of
 * only proving these properties by hand in a browser.
 */
(function (root) {
  'use strict';

  function copyProjectFilesIntoEngine(engine, files, projectName, encoder) {
    const failures = [];
    for (const [relPath, content] of Object.entries(files || {})) {
      const cleanPath = String(relPath).replace(/^\/+/, '');
      const fullPath = '/home/web_user/projects/' + projectName + '/' + cleanPath;
      const bytes = typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);
      try {
        engine.copyToFS(fullPath, bytes.buffer);
      } catch (error) {
        // Collected, never swallowed: continuing left the editor booting from stale or partial
        // contents and failing much later with no usable reason.
        failures.push({ path: cleanPath, error: error && error.message ? error.message : String(error) });
      }
    }
    return failures;
  }

  function filesystemCopyError(failures) {
    const detail = failures.map(failure => failure.path + ': ' + failure.error).join('; ');
    const error = new Error('EDITOR_FS_COPY_FAILED: ' + failures.length
      + ' project file(s) could not be written into the editor filesystem — ' + detail);
    error.code = 'EDITOR_FS_COPY_FAILED';
    error.failed_paths = failures.map(failure => failure.path);
    return error;
  }

  /**
   * Run one editor boot to completion.
   *
   * Written as a single async function with one try/catch at the call site on purpose: the
   * previous promise-chain form created `start()`'s promise inside `init().then(...)` without
   * returning it, so an asynchronous `start()` rejection escaped the trailing `.catch` and
   * left the lifecycle stuck in `initializing` until an outer timeout fired.
   *
   * Resolves `{ status: 'running' }`, or `{ status: 'superseded', at }` when a newer
   * generation took over mid-boot. Rejects with the underlying failure otherwise.
   */
  async function runEditorBoot(options) {
    const {
      engine,
      generation,
      activeGeneration,
      noteStale = function () {},
      setPhase = function () {},
      projectFiles = null,
      projectName = 'astro_dodger',
      zip = null,
      args = [],
      encoder = new TextEncoder(),
      // Extra options merged into engine.start(). Godot's own project-manager -> editor
      // re-exec needs `persistentDrops` and an explicit canvas; it shares this function so it
      // gets the same fencing and the same single-catch rejection handling.
      startOptions = {},
      beforeStart = function () {},
      onRunning = function () {}
    } = options;

    const isCurrent = () => activeGeneration() === generation;

    await engine.init('godot.editor');
    if (!isCurrent()) {
      noteStale(generation, 'init() continuation');
      return { status: 'superseded', at: 'init' };
    }

    setPhase('Mounting virtual filesystem');
    if (projectFiles) {
      const failures = copyProjectFilesIntoEngine(engine, projectFiles, projectName, encoder);
      if (failures.length > 0) throw filesystemCopyError(failures);
    }
    if (zip) engine.copyToFS('/tmp/preload.zip', zip);
    try {
      // Avoid the user creating a project in the persistent root folder.
      engine.copyToFS('/home/web_user/keep', new Uint8Array());
    } catch (error) {
      // The file already exists; that is the normal case after the first boot.
    }

    beforeStart();
    setPhase('Opening project');
    // Awaited, so a rejection propagates to the caller's single catch.
    await engine.start(Object.assign({ args: args, persistentDrops: true }, startOptions));
    if (!isCurrent()) {
      noteStale(generation, 'start() continuation');
      return { status: 'superseded', at: 'start' };
    }
    onRunning();
    return { status: 'running' };
  }

  root.GodotEditorBoot = {
    runEditorBoot: runEditorBoot,
    copyProjectFilesIntoEngine: copyProjectFilesIntoEngine,
    filesystemCopyError: filesystemCopyError
  };
}(typeof window !== 'undefined' ? window : globalThis));
