/**
 * Godot WebMCP Bridge (v9.1 - Authoritative Native WebMCP & 3D Runner Engine)
 * Fully compliant with W3C / Chrome / OpenAI WebMCP standards:
 * - Authoritative native tool manifest with strict JSON Schemas
 * - Safe Native ModelContext Registration (Never overwrites read-only document.modelContext)
 * - Measurable Diagnostic Readiness State Machine (Engine, WebMCP, Session)
 * - Fixed Binary PKZIP Packager (setUint16) with standard CRC32
 * - Game-Owned Playtest State Machine with Sequence Cursor & Delta Audio Triggers
 * - 3D Runner ("Neon Skyrail") Course & 6-Piece Procedural Audio Suite
 */

(function () {
  'use strict';

  // ==========================================
  // 1. Diagnostic Readiness State Machine
  // ==========================================
  const DiagnosticState = {
    engine: 'loading', // 'loading' | 'ready' | 'failed'
    engineError: null,
    webmcp: 'registering', // 'unsupported' | 'registering' | 'ready' | 'failed'
    webmcpRegisteredCount: 0,
    webmcpLastError: null,
    webmcpSurface: 'none',
    session: 'authoring', // 'empty' | 'authoring' | 'persisted' | 'resume_available' | 'auto_restoring' | 'editor-ready' | 'playtesting' | 'stopped' | 'restore_failed' | 'failed'
    sceneRevision: 1,
    // The revision actually written to IndexedDB. It is not an invariant that this equals
    // sceneRevision — persistence can fail — so both are reported and the session is marked
    // `dirty_unpersisted` when they diverge, rather than pretending they always agree.
    persistedRevision: 1,
    undoDepth: 0,
    activeProject: 'neon_skyrail_3d',
    // True only while an unavoidable editor replacement is paused because the pane is hidden
    // or unthrottled frames have stopped. It is a "waiting on you", not a failure.
    shutdownWaiting: false,
    // Assets imported into the running editor this session. They deliberately do not live in
    // the project file dict: binary there would ride into undo snapshots, exports, and the
    // next boot - and a binary asset present at boot is what aborts this WASM build.
    importedAssets: new Map(),
    // The evidence from the most recent editor replacement: how long the engine actually had
    // frames, how long it was hidden, and what the exit did. Recorded whether or not it
    // succeeded, so a later "the editor hung" report can be checked rather than believed.
    lastShutdown: null,
    // Set when the hot GDScript channel wrote to the running editor but could neither publish
    // nor restore. Requires deliberate recovery; never resolved by starting a second Engine.
    hotScriptDirty: null
  };

  const ResumeState = {
    coordinatorStarted: false,
    coordinatorPromise: null,
    operationId: null,
    restoreMode: null,
    lastRestoreError: null
  };

  const DIAGNOSTIC_TOOLS = new Set([
    'godot_get_operation_status',
    'godot_get_session_status',
    'godot_diagnose_session',
    'godot_get_logs',
    'godot_get_game_telemetry',
    'godot_get_input_sequence_status',
    'godot_get_project_upload_status'
  ]);

  const undoStack = [];
  const idempotentMutations = new Map();
  const inflightIdempotency = new Map();
  const managedOperations = new Map();
  const projectUploads = new Map();
  const inputSequences = new Map();
  const GameTelemetryState = { sequence: 0, latest: null, recent: [] };
  const RecordingState = {
    recorder: null, chunks: [], videoRecorder: null, videoChunks: [], audioRecorder: null, audioChunks: [],
    startedAt: 0, id: null, canvas: null, captureCanvas: null, captureContext: null, captureRaf: null, audioDestination: null, audioMaster: null,
    autoStopTimer: null, lastAutoStop: null
  };
  const activeLogs = [];
  const MAX_LOGS = 500;
  const PREVIEW_RESTORE_KEY = 'godot-webmcp-preview-running';
  let activeFilesDict = {};
  let activeMainScene = 'res://main_3d.tscn';
  let activeManagedMutationId = null;
  let projectStateHydrated = false;
  let persistedProjectAvailable = false;
  let projectPersistenceError = null;
  let hydratedSnapshot = null;
  let projectHydrationPromise = Promise.resolve();
  let nativeRegistrationPromise = Promise.resolve();

  function rememberPreviewWasRunning() {
    try {
      // This survives a browser-level reload as well as Godot rebuilding its canvas.
      window.localStorage?.setItem(PREVIEW_RESTORE_KEY, '1');
    } catch (_) {}
  }

  function forgetPreviewWasRunning() {
    try {
      window.localStorage?.removeItem(PREVIEW_RESTORE_KEY);
    } catch (_) {}
  }

  function shouldRestorePreview() {
    try {
      return window.localStorage?.getItem(PREVIEW_RESTORE_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('godot-game-telemetry', (event) => {
      const entry = {
        sequence: ++GameTelemetryState.sequence,
        received_at: Date.now(),
        state: event?.detail ?? null
      };
      GameTelemetryState.latest = entry;
      GameTelemetryState.recent.push(entry);
      if (GameTelemetryState.recent.length > 100) GameTelemetryState.recent.shift();
    });
  }

  function openRecordingDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB is unavailable; artifacts cannot be persisted.'));
      const request = window.indexedDB.open('godot-webmcp-artifacts', 4);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('recordings')) {
          request.result.createObjectStore('recordings', { keyPath: 'id' });
        }
        if (!request.result.objectStoreNames.contains('projects')) {
          request.result.createObjectStore('projects', { keyPath: 'id' });
        }
        if (!request.result.objectStoreNames.contains('uploads')) {
          request.result.createObjectStore('uploads', { keyPath: 'id' });
        }
        if (!request.result.objectStoreNames.contains('upload_chunks')) {
          const chunks = request.result.createObjectStore('upload_chunks', { keyPath: 'key' });
          chunks.createIndex('upload_id', 'upload_id', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open recording database.'));
      request.onblocked = () => reject(new Error('Artifact database upgrade is blocked by another open page.'));
    });
  }

  async function storeRecording(record) {
    const database = await openRecordingDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('recordings', 'readwrite');
      transaction.objectStore('recordings').put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Failed to persist recording.'));
    });
    database.close();
  }

  async function readRecordings() {
    const database = await openRecordingDatabase();
    const records = await new Promise((resolve, reject) => {
      const request = database.transaction('recordings', 'readonly').objectStore('recordings').getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('Failed to list recordings.'));
    });
    database.close();
    return records;
  }

  function createRecordingSurface(sourceCanvas) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return sourceCanvas;
    const surface = document.createElement('canvas');
    surface.id = 'webmcp-recording-surface';
    surface.width = sourceCanvas.width;
    surface.height = sourceCanvas.height;
    surface.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(surface);
    const context = surface.getContext('2d', { alpha: false });
    if (!context) {
      surface.remove();
      return sourceCanvas;
    }
    RecordingState.captureCanvas = surface;
    RecordingState.captureContext = context;
    const paint = () => {
      if (!RecordingState.captureCanvas || !RecordingState.captureContext) return;
      const currentCanvas = resolveGodotCanvas('auto')?.canvas;
      if (currentCanvas?.width && currentCanvas?.height) {
        try { context.drawImage(currentCanvas, 0, 0, surface.width, surface.height); } catch (_) {}
      }
      RecordingState.captureRaf = requestAnimationFrame(paint);
    };
    paint();
    return surface;
  }

  function releaseRecordingSurface() {
    if (RecordingState.captureRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(RecordingState.captureRaf);
    }
    RecordingState.captureRaf = null;
    RecordingState.captureContext = null;
    RecordingState.captureCanvas?.remove();
    RecordingState.captureCanvas = null;
  }

  async function computeProjectContentFingerprint(filesDict) {
    try {
      const entries = Object.entries(filesDict).sort(([a], [b]) => a.localeCompare(b));
      const parts = [];
      const encoder = new TextEncoder();
      for (const [rawPath, content] of entries) {
        const pathBytes = encoder.encode(cleanProjectPath(rawPath));
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
      if (typeof crypto !== 'undefined' && crypto?.subtle?.digest) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', merged);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return `sha256:${hashArray.map(b => b.toString(16).padStart(2, '0')).join('')}`;
      } else {
        let hash = 2166136261;
        for (let i = 0; i < merged.length; i++) {
          hash ^= merged[i];
          hash = Math.imul(hash, 16777619);
        }
        return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
      }
    } catch (err) {
      return `error:${err.message || String(err)}`;
    }
  }

  // A fingerprint over the BYTES a file will occupy, independent of whether the caller holds
  // it as a string or a Uint8Array. `computeProjectContentFingerprint` tags text and binary
  // differently, which is right for the persisted snapshot but wrong across the playtest
  // handshake: the bridge stages strings while the copier hashes the encoded buffers it wrote,
  // so the same content hashed to two different values. One canonical framing, used by both
  // sides, is the only way that comparison means anything.
  async function fingerprintProjectBytes(files) {
    const encoder = new TextEncoder();
    const entries = Object.entries(files || {})
      .map(([rawPath, content]) => [
        String(rawPath).replace(/^res:\/\//, '').replace(/^\/+/, ''),
        typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content)
      ])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = [];
    for (const [path, bytes] of entries) {
      const pathBytes = encoder.encode(path);
      parts.push(encoder.encode(`\0f:${pathBytes.length}:${bytes.length}:`), pathBytes, bytes);
    }
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    if (typeof crypto !== 'undefined' && crypto?.subtle?.digest) {
      const digest = await crypto.subtle.digest('SHA-256', merged);
      return `sha256:${Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
    }
    let hash = 2166136261;
    for (let index = 0; index < merged.length; index += 1) {
      hash ^= merged[index];
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  function yieldProgress() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) { resolved = true; resolve(); }
        }, 40);
        requestAnimationFrame(() => {
          if (!resolved) { resolved = true; clearTimeout(timer); resolve(); }
        });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  // Godot owns two canvases. `#game-canvas` is a static element in index.html and
  // therefore ALWAYS exists, so `getElementById('game-canvas') || getElementById('editor-canvas')`
  // can never reach the editor. Route by the tab the host is actually showing instead.
  function activeGodotViewport() {
    if (typeof document === 'undefined') return 'editor';
    const gameTab = document.getElementById('tab-game');
    const gameVisible = Boolean(gameTab) && gameTab.style.display === 'block';
    if (gameVisible && window.__godotGameState === 'running') return 'game';
    return 'editor';
  }

  // The Godot editor process can exit on its own (a WASM crash, or Godot's own quit path),
  // and index.html then shows the Loader tab. Nothing dispatches an event for that, so the
  // visible tab is the only honest signal that there is still an editor to talk to.
  function editorSurfaceLive() {
    if (typeof document === 'undefined') return false;
    const editorTab = document.getElementById('tab-editor');
    const gameTab = document.getElementById('tab-game');
    // A playtest hides the editor tab but the editor process is still alive behind it.
    return editorTab?.style.display === 'block' || gameTab?.style.display === 'block';
  }

  // Never cache the element: `replaceCanvas` in index.html destroys and recreates
  // both canvases on every engine exit.
  function resolveGodotCanvas(target = 'auto') {
    if (typeof document === 'undefined') return null;
    const wanted = target === 'auto' || !target ? activeGodotViewport() : target;
    const canvases = {
      editor: document.getElementById('editor-canvas'),
      game: document.getElementById('game-canvas')
    };
    const primary = canvases[wanted];
    if (primary && primary.width && primary.height) return { canvas: primary, viewport: wanted, requested: wanted };
    if (primary) return { canvas: primary, viewport: wanted, requested: wanted };
    const other = wanted === 'game' ? 'editor' : 'game';
    if (canvases[other]) return { canvas: canvases[other], viewport: other, requested: wanted };
    return null;
  }

  function phaseLabel(phase) {
    const labels = {
      accepted: 'Accepted',
      validating_request: 'Validating request',
      staging_files: 'Staging files',
      stopping_runtime: 'Stopping runtime',
      replacing_editor: 'Replacing editor',
      booting_editor: 'Booting editor',
      validating_runtime: 'Validating runtime',
      persisting_commit: 'Persisting commit',
      // The hot GDScript channel's phases. Deliberately plain language: these are what a
      // non-technical collaborator reads in the shelf, with the raw tool calls kept in the
      // expandable details rather than in the headline.
      inspecting: 'Inspecting',
      preparing_change: 'Preparing change',
      updating_script: 'Updating script',
      checking_code: 'Checking code',
      restoring_script: 'Restoring previous version',
      persisting: 'Persisting',
      complete: 'Complete',
      ready: 'Ready',
      rolling_back: 'Rolling back',
      failed: 'Failed'
    };
    return labels[phase] || phase;
  }

  function activityHeadline(latest) {
    if (!latest) return 'Waiting for a WebMCP action';
    if (latest.status === 'running' && latest.phase) return phaseLabel(latest.phase);
    return latest.label;
  }

  // `belowRail` keeps the held frame under the activity rail, so a preview refresh can explain
  // itself while it happens. A full editor replacement still covers everything: there is no
  // live surface underneath it to be honest about.
  function holdRuntimeFrame({ belowRail = false } = {}) {
    if (typeof document === 'undefined') return false;
    const canvas = resolveGodotCanvas('auto')?.canvas;
    if (!canvas || !canvas.width || !canvas.height || typeof canvas.toDataURL !== 'function') return false;
    let frame;
    try { frame = canvas.toDataURL('image/png'); } catch (_) { return false; }
    if (!frame || !frame.startsWith('data:image/')) return false;
    let cover = document.getElementById('webmcp-runtime-frame-hold');
    if (!cover) {
      cover = document.createElement('img');
      cover.id = 'webmcp-runtime-frame-hold';
      cover.alt = '';
      cover.setAttribute('aria-hidden', 'true');
      document.body.appendChild(cover);
    }
    cover.style.cssText = `position:fixed;inset:0;z-index:${belowRail ? 880 : 'var(--gd-z-frame-hold, 950)'};width:100vw;height:100vh;object-fit:fill;background:var(--gd-surface, #141414);pointer-events:none;`;
    cover.src = frame;
    cover.style.display = 'block';
    return true;
  }

  function releaseRuntimeFrame() {
    if (typeof document === 'undefined') return;
    document.getElementById('webmcp-runtime-frame-hold')?.remove();
  }

  async function advancePhase(operation, phase, phaseIndex = null, phaseCount = null) {
    if (!operation || operation.terminal) return;
    operation.phase = phase;
    if (phaseIndex !== null) operation.phaseIndex = phaseIndex;
    if (phaseCount !== null) operation.phaseCount = phaseCount;
    operation.sequence += 1;
    operation.lastProgressAt = Date.now();
    const elapsedMs = operation.lastProgressAt - operation.startedAt;
    const previousEvent = operation.timeline.at(-1);
    if (!previousEvent || previousEvent.phase !== phase) {
      operation.timeline.push({
        phase,
        label: phaseLabel(phase),
        sequence: operation.sequence,
        elapsed_ms: elapsedMs,
        at: operation.lastProgressAt
      });
    }

    for (const waiter of operation.waiters) {
      waiter();
    }
    operation.waiters.clear();

    if (operation.observationIds?.size && typeof AgentObservationHUD !== 'undefined') {
      const elapsed = ((Date.now() - operation.startedAt) / 1000).toFixed(1);
      const detail = `${phaseLabel(phase)} · ${elapsed} s`;
      for (const obsId of operation.observationIds) {
        AgentObservationHUD.update('running', operation.tool, {}, detail, obsId, {
          operation_id: operation.id,
          phase: operation.phase,
          sequence: operation.sequence,
          timeline: operation.timeline,
          // What the agent is working ON, not just what it is doing. The shelf needs the
          // resource path and line range to say "Updating temple_run.gd · lines 84-137".
          target: operation.target || null,
          change: operation.change || null,
          diagnostics: operation.diagnostics || null
        });
      }
    }

    await yieldProgress();
  }

  function waitForOperationChange(operation, afterSequence, waitMs) {
    if (operation.terminal || operation.sequence > afterSequence || waitMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let timer = null;
      const onWake = () => {
        if (timer) clearTimeout(timer);
        operation.waiters.delete(onWake);
        resolve();
      };
      timer = setTimeout(onWake, waitMs);
      operation.waiters.add(onWake);
    });
  }

  const SAVED_PROJECT_PREFIX = 'project:';
  const SAVED_PROJECT_LIMIT = 12;

  function savedProjectSummary(row) {
    return {
      project_name: row.project_name,
      main_scene: row.main_scene,
      scene_revision: row.scene_revision,
      file_count: Object.keys(row.files || {}).length,
      updated_at: row.updated_at || 0,
      content_fingerprint: row.content_fingerprint || null
    };
  }

  async function readSavedProjectRows(database) {
    return new Promise((resolve, reject) => {
      const request = database.transaction('projects', 'readonly').objectStore('projects').getAll();
      request.onsuccess = () => resolve((request.result || []).filter(row => typeof row?.id === 'string'
        && row.id.startsWith(SAVED_PROJECT_PREFIX) && row.project_name));
      request.onerror = () => reject(request.error || new Error('Failed to read the saved project library.'));
    });
  }

  // Bounded, oldest-first. A library that grows forever is a storage-quota failure waiting to
  // happen in a tab that also holds a WASM editor and its virtual filesystem.
  async function pruneSavedProjects(database) {
    const rows = await readSavedProjectRows(database);
    if (rows.length <= SAVED_PROJECT_LIMIT) return [];
    const doomed = rows
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
      .slice(SAVED_PROJECT_LIMIT);
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('projects', 'readwrite');
      for (const row of doomed) transaction.objectStore('projects').delete(row.id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Failed to prune the saved project library.'));
    });
    return doomed.map(row => row.project_name);
  }

  async function listSavedProjects() {
    const database = await openRecordingDatabase();
    try {
      const rows = await readSavedProjectRows(database);
      return rows
        .map(savedProjectSummary)
        .sort((a, b) => b.updated_at - a.updated_at);
    } finally {
      database.close();
    }
  }

  // The active row is a pointer to the project that should be restored, while the named row
  // is the durable library copy. Older bridge versions could update only the named row before
  // a reload, leaving the pointer several revisions behind. Prefer a strictly newer named
  // snapshot of the SAME project; never jump to a different project merely because it was
  // edited more recently.
  function reconcileHydrationSnapshot(activeSnapshot, savedRows) {
    if (!activeSnapshot?.project_name) {
      return { snapshot: activeSnapshot || null, repaired: false, reason: null };
    }
    const candidates = (savedRows || [])
      .filter(row => row?.project_name === activeSnapshot.project_name)
      .sort((a, b) => (b.scene_revision || 0) - (a.scene_revision || 0)
        || (b.updated_at || 0) - (a.updated_at || 0));
    const newest = candidates[0];
    if (!newest) return { snapshot: activeSnapshot, repaired: false, reason: null };
    const newerRevision = Number(newest.scene_revision) > Number(activeSnapshot.scene_revision);
    const newerDivergentBytes = Number(newest.scene_revision) === Number(activeSnapshot.scene_revision)
      && (newest.updated_at || 0) > (activeSnapshot.updated_at || 0)
      && newest.content_fingerprint && newest.content_fingerprint !== activeSnapshot.content_fingerprint;
    if (!newerRevision && !newerDivergentBytes) {
      return { snapshot: activeSnapshot, repaired: false, reason: null };
    }
    return {
      snapshot: {
        ...newest,
        id: 'active',
        // Library rows intentionally do not carry session-local histories.
        undo_stack: [],
        idempotent_mutations: []
      },
      repaired: true,
      reason: newerRevision ? 'newer_library_revision' : 'newer_library_bytes'
    };
  }

  async function readSavedProject(projectName) {
    const database = await openRecordingDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction('projects', 'readonly').objectStore('projects')
          .get(`${SAVED_PROJECT_PREFIX}${projectName}`);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('Failed to read the saved project.'));
      });
    } finally {
      database.close();
    }
  }

  async function persistActiveProjectState(candidate = null) {
    // `candidate` lets a mutation persist the state it is ABOUT to publish, so the stored
    // snapshot is written before `sceneRevision` advances rather than after.
    const files = candidate?.files || activeFilesDict;
    const revision = candidate?.revision ?? DiagnosticState.sceneRevision;
    try {
      const database = await openRecordingDatabase();
      const contentFingerprint = await computeProjectContentFingerprint(files);
      const snapshot = {
        id: 'active',
        project_name: DiagnosticState.activeProject,
        main_scene: activeMainScene,
        scene_revision: revision,
        files: cloneProjectFiles(files),
        undo_stack: undoStack.map(entry => ({ ...entry, files_before: cloneProjectFiles(entry.files_before || {}), files_after: cloneProjectFiles(entry.files_after || {}) })),
        idempotent_mutations: [...idempotentMutations.entries()].slice(-100),
        content_fingerprint: contentFingerprint,
        last_validated_revision: revision,
        validation_state: 'runtime_validated',
        updated_at: Date.now()
      };
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('projects', 'readwrite');
        const store = transaction.objectStore('projects');
        store.put(snapshot);
        // The library row.
        //
        // 'active' is a single slot: authoring or opening anything else overwrote it, and the
        // project you had before was simply gone - which is why a project you stopped working
        // on could never be returned to. Every persist now also writes a row keyed by project
        // name, so the slot stays the "what is open" pointer and the library keeps the work.
        // Undo history and idempotency records are deliberately left out of the library row:
        // they are session state, and carrying them would make the store grow without bound.
        store.put({
          ...snapshot,
          id: `${SAVED_PROJECT_PREFIX}${DiagnosticState.activeProject}`,
          undo_stack: [],
          idempotent_mutations: []
        });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Failed to persist project state.'));
      });
      await pruneSavedProjects(database);
      database.close();
      persistedProjectAvailable = Object.keys(snapshot.files).length > 0;
      hydratedSnapshot = snapshot;
      projectPersistenceError = null;
      DiagnosticState.persistedRevision = revision;
      BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);
      return true;
    } catch (error) {
      projectPersistenceError = error instanceof Error ? error.message : String(error);
      activeLogs.push({ level: 'warn', time: Date.now(), msg: `[Persistence] ${projectPersistenceError}` });
      return false;
    }
  }

  function isFreshStartRequested() {
    if (typeof window === 'undefined') return false;
    try {
      return new URLSearchParams(window.location.search).get('fresh') === '1';
    } catch (_) {
      return false;
    }
  }

  async function clearPersistedAuthoringState(database) {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['projects', 'uploads', 'upload_chunks'], 'readwrite');
      transaction.objectStore('projects').delete('active');
      transaction.objectStore('uploads').clear();
      transaction.objectStore('upload_chunks').clear();
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Failed to clear the persisted authoring session.'));
    });
  }

  async function hydratePersistedProjectState() {
    try {
      const database = await openRecordingDatabase();
      const freshStartRequested = isFreshStartRequested();
      if (freshStartRequested) {
        await clearPersistedAuthoringState(database);
        // Keep the reset a one-time, inspectable browser action rather than a sticky URL mode.
        window.history?.replaceState?.({}, '', window.location.pathname || '/');
      }
      let snapshot = await new Promise((resolve, reject) => {
        const request = database.transaction('projects', 'readonly').objectStore('projects').get('active');
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('Failed to hydrate project state.'));
      });
      const savedRows = await readSavedProjectRows(database);
      const reconciliation = reconcileHydrationSnapshot(snapshot, savedRows);
      snapshot = reconciliation.snapshot;
      const uploadSnapshots = await new Promise((resolve, reject) => {
        const request = database.transaction('uploads', 'readonly').objectStore('uploads').getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('Failed to hydrate staged project uploads.'));
      });
      const uploadChunkSnapshots = await new Promise((resolve, reject) => {
        const request = database.transaction('upload_chunks', 'readonly').objectStore('upload_chunks').getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('Failed to hydrate staged project chunks.'));
      });
      database.close();
      projectUploads.clear();
      for (const upload of uploadSnapshots.slice(-4)) {
        if (!upload?.id || !upload?.projectName || !Array.isArray(upload.files)) continue;
        let needsChunkMigration = false;
        upload.files = new Map(upload.files.map(([filePath, file]) => {
          const persistedChunks = uploadChunkSnapshots
            .filter(chunk => chunk.upload_id === upload.id && chunk.path === filePath)
            .sort((a, b) => a.index - b.index)
            .map(chunk => chunk.bytes);
          if (Array.isArray(file.chunks)) needsChunkMigration = true;
          return [filePath, { ...file, chunks: Array.isArray(file.chunks) ? file.chunks : persistedChunks }];
        }));
        projectUploads.set(upload.id, upload);
        if (needsChunkMigration) await migrateLegacyProjectUpload(upload);
      }
      if (snapshot) {
        const hydrationNormalization = normalizeProjectTextResources(cloneProjectFiles(snapshot.files || {}));
        const hydratedFiles = hydrationNormalization.files;
        const hasFiles = Object.keys(hydratedFiles).length > 0;
        const hydratedProject = cleanProjectName(snapshot.project_name);
        if (!Number.isInteger(snapshot.scene_revision) || snapshot.scene_revision < 1) {
          throw new Error('Persisted project revision is invalid.');
        }
        if (hasFiles) validateProjectFiles(hydratedFiles);
        if (!Array.isArray(snapshot.undo_stack)) throw new Error('Persisted undo history is invalid.');
        for (const entry of snapshot.undo_stack) {
          if (!entry || typeof entry.undo_id !== 'string' || !entry.files_before || !entry.files_after) {
            throw new Error('Persisted undo history contains an invalid transaction.');
          }
        }
        DiagnosticState.activeProject = hydratedProject;
        activeMainScene = normalizeResourcePath(snapshot.main_scene || (hasFiles ? inferMainScene(hydratedFiles) : activeMainScene));
        DiagnosticState.sceneRevision = snapshot.scene_revision;
        // The hydrated snapshot IS the persisted state, so seed both. Without this a restored
        // session reports itself as having unpersisted edits it does not have.
        DiagnosticState.persistedRevision = snapshot.scene_revision;
        activeFilesDict = hydratedFiles;
        undoStack.splice(0, undoStack.length, ...snapshot.undo_stack);
        idempotentMutations.clear();
        for (const entry of snapshot.idempotent_mutations || []) {
          if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1]?.fingerprint && entry[1]?.result) {
            idempotentMutations.set(entry[0], entry[1]);
          }
        }
        persistedProjectAvailable = hasFiles;
        hydratedSnapshot = snapshot;
        DiagnosticState.session = persistedProjectAvailable ? 'persisted' : 'empty';
        DiagnosticState.engine = 'loading';
        projectPersistenceError = null;
        if (reconciliation.repaired) {
          activeLogs.push({
            level: 'info',
            time: Date.now(),
            msg: `[Persistence repair] Restored ${snapshot.project_name} rev ${snapshot.scene_revision} from its newer library snapshot (${reconciliation.reason}).`
          });
          // Repair the stale pointer immediately so the next reload observes the same state.
          await persistActiveProjectState({ files: hydratedFiles, revision: snapshot.scene_revision });
        }
        if (hydrationNormalization.repairs > 0) {
          activeLogs.push({
            level: 'info',
            time: Date.now(),
            msg: `[Persistence migration] Repaired ${hydrationNormalization.repairs} escaped newline separator(s) in ${hydrationNormalization.repairedPaths.join(', ')}.`
          });
          // This is a byte-level repair of the already-persisted revision, not a user edit.
          // Keep the revision stable while replacing the malformed authoritative snapshot so
          // the same warnings cannot return on the next reload.
          await persistActiveProjectState({ files: hydratedFiles, revision: snapshot.scene_revision });
        }
      } else {
        DiagnosticState.session = 'empty';
        DiagnosticState.engine = 'loading';
        hydratedSnapshot = null;
      }
    } catch (error) {
      projectPersistenceError = error instanceof Error ? error.message : String(error);
      persistedProjectAvailable = false;
      hydratedSnapshot = null;
      DiagnosticState.session = 'empty';
      DiagnosticState.engine = 'loading';
      activeLogs.push({ level: 'warn', time: Date.now(), msg: `[Persistence] ${projectPersistenceError}` });
    } finally {
      projectStateHydrated = true;
    }
  }

  projectHydrationPromise = hydratePersistedProjectState();

  function exposeRecordingDownload(record, replace = true) {
    if (record.object_url) URL.revokeObjectURL(record.object_url);
    record.object_url = URL.createObjectURL(record.blob);
    let shelf = document.getElementById('webmcp-recording-shelf');
    if (!shelf) {
      shelf = document.createElement('div');
      shelf.id = 'webmcp-recording-shelf';
      shelf.style.cssText = 'position:fixed;left:10px;bottom:52px;z-index:var(--gd-z-rail, 900);max-width:calc(100vw - 20px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:6px 10px;border:1px solid var(--gd-border, #484848);border-radius:6px;background:var(--gd-panel, #1b1b1b);box-shadow:0 8px 24px rgba(0,0,0,.45);font:500 12px/1.35 var(--gd-font-ui, Inter, system-ui, sans-serif);color:var(--gd-text, #d0d0d0)';
      document.body.appendChild(shelf);
    }
    if (replace) shelf.innerHTML = '';
    const link = document.createElement('a');
    link.href = record.object_url;
    link.download = record.filename;
    link.textContent = `Download recording · ${record.filename} · ${(record.blob.size / 1024 / 1024).toFixed(2)} MB`;
    link.style.cssText = 'color:var(--gd-accent, #538dda);text-decoration:none;pointer-events:auto';
    shelf.appendChild(link);
    return record.object_url;
  }

  function publicOperation(operation) {
    return {
      operation_id: operation.id,
      tool: operation.tool,
      label: operation.label,
      status: operation.status,
      phase: operation.phase,
      sequence: operation.sequence,
      timeline: operation.timeline.map(event => ({ ...event })),
      terminal: operation.terminal,
      last_progress_at: operation.lastProgressAt,
      started_at: operation.startedAt,
      completed_at: operation.completedAt || null,
      elapsed_ms: (operation.completedAt || Date.now()) - operation.startedAt,
      ...(operation.result ? { result: operation.result } : {}),
      ...(operation.error ? { error: operation.error } : {})
    };
  }

  async function runManagedMutation(tool, label, mutation, inlineWaitMs = 10000, idempotency = null, options = {}) {
    if (idempotency?.key) {
      const replay = getIdempotentReplay(idempotency.key, idempotency.fingerprint);
      if (replay) return replay;
      const inflight = inflightIdempotency.get(idempotency.key);
      if (inflight) {
        if (inflight.fingerprint !== idempotency.fingerprint) {
          throw new Error(`Idempotency key conflict: ${idempotency.key} is already running with a different mutation payload.`);
        }
        const operation = managedOperations.get(inflight.operationId);
        if (operation) {
          if (options.observation_id) {
            if (!operation.observationIds) operation.observationIds = new Set();
            operation.observationIds.add(options.observation_id);
          }
          const replay = publicOperation(operation);
          if (replay.status === 'running') replay.status = 'pending';
          return { ...replay, idempotent_replay: true };
        }
        inflightIdempotency.delete(idempotency.key);
      }
    }
    if (activeManagedMutationId) {
      const active = managedOperations.get(activeManagedMutationId);
      if (active?.status === 'running') {
        throw new Error(`Another authoring operation is still running: ${active.id} (${active.label}). Inspect it before starting a new mutation.`);
      }
    }
    const operation = {
      id: `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      tool,
      label,
      status: 'running',
      phase: 'accepted',
      phaseIndex: 0,
      phaseCount: 7,
      sequence: 0,
      timeline: [{ phase: 'accepted', label: phaseLabel('accepted'), sequence: 0, elapsed_ms: 0, at: Date.now() }],
      lastProgressAt: Date.now(),
      terminal: false,
      startedAt: Date.now(),
      completedAt: null,
      result: null,
      error: null,
      promise: null,
      observationIds: new Set(options.observation_id ? [options.observation_id] : []),
      waiters: new Set()
    };
    managedOperations.set(operation.id, operation);
    activeManagedMutationId = operation.id;
    if (idempotency?.key) {
      inflightIdempotency.set(idempotency.key, {
        fingerprint: idempotency.fingerprint,
        operationId: operation.id
      });
    }
    while (managedOperations.size > 50) managedOperations.delete(managedOperations.keys().next().value);

    operation.promise = (async () => {
      try {
        operation.result = await mutation(operation);
        operation.status = 'succeeded';
      } catch (error) {
        operation.error = error instanceof Error ? error.message : String(error);
        operation.status = 'failed';
      } finally {
        operation.completedAt = Date.now();
        operation.terminal = true;
        operation.phase = operation.status === 'succeeded' ? 'ready' : 'failed';
        operation.sequence += 1;
        operation.lastProgressAt = Date.now();
        operation.timeline.push({
          phase: operation.phase,
          label: phaseLabel(operation.phase),
          sequence: operation.sequence,
          elapsed_ms: operation.lastProgressAt - operation.startedAt,
          at: operation.lastProgressAt
        });

        if (activeManagedMutationId === operation.id) activeManagedMutationId = null;
        if (idempotency?.key && inflightIdempotency.get(idempotency.key)?.operationId === operation.id) {
          inflightIdempotency.delete(idempotency.key);
        }

        for (const waiter of operation.waiters) {
          waiter();
        }
        operation.waiters.clear();

        if (operation.observationIds?.size && typeof AgentObservationHUD !== 'undefined') {
          const detail = operation.status === 'succeeded'
            ? (operation.result?.scene_revision ? `Rev #${operation.result.scene_revision}` : 'Complete')
            : operation.error;
          for (const observationId of operation.observationIds) {
            AgentObservationHUD.update(operation.status, operation.tool, {}, detail, observationId, {
              operation_id: operation.id,
              phase: operation.phase,
              sequence: operation.sequence,
              terminal: true,
              timeline: operation.timeline
            });
          }
        }
      }
    })();

    await Promise.race([
      operation.promise,
      new Promise(resolve => setTimeout(resolve, inlineWaitMs))
    ]);
    if (operation.status === 'failed') throw new Error(operation.error);
    if (operation.status === 'succeeded') return operation.result;
    // No `success` field at all while the work is still running. Reporting `success: false`
    // on a healthy in-flight operation reads as a failure to anything that checks that field,
    // and the next call then races the editor replacement this one is still performing.
    return {
      accepted: true,
      status: 'pending',
      operation_id: operation.id,
      label,
      poll_with: 'godot_get_operation_status',
      // Said in the payload because a caller that misses it writes into an Engine that is
      // being torn down and gets a confusing refusal instead of a queue.
      next_step: `This operation is still running and the editor is not ready. Poll godot_get_operation_status with operation_id "${operation.id}" until status is "succeeded" before calling any other tool.`
    };
  }

  function normalizeResourcePath(filePath, fallback = 'res://main.tscn') {
    if (!filePath || typeof filePath !== 'string') return fallback;
    return filePath.startsWith('res://') ? filePath : `res://${filePath.replace(/^\/+/, '')}`;
  }

  // Detect the editor leaving on its own and tell the truth about it everywhere at once.
  function noteEditorSurfaceGone() {
    if (typeof window === 'undefined') return;
    if (editorSurfaceLive()) {
      // Coming back (a playtest ending, or the loader being dismissed) must restore the
      // reported state; availability is derived, never latched off.
      refreshMeasuredEngineState();
      DiagnosticHUD.render();
      return;
    }
    // Deliberately does NOT clear `__godotEditorPluginReady`: that flag is owned by the
    // plugin's _enter_tree and cannot be re-set from JS, so clearing it here would
    // permanently disable the channel for a merely hidden editor. `available()` already
    // requires a live surface, which is the derived, self-correcting signal.
    if (DiagnosticState.engine === 'ready') DiagnosticState.engine = 'loading';
    if (DiagnosticState.session === 'editor-ready') DiagnosticState.session = 'authoring';
    AgentFocusOverlay.hide('editor_surface_gone');
    DiagnosticHUD.render();
  }

  function refreshMeasuredEngineState() {
    if (typeof document === 'undefined') return DiagnosticState.engine;
    const editorTab = document.getElementById('btn-tab-editor');
    const gameTab = document.getElementById('btn-tab-game');
    const editorCanvas = document.getElementById('editor-canvas');
    const gameCanvas = document.getElementById('game-canvas');
    const hasUsableRuntime = Boolean(
      (editorTab && !editorTab.disabled && editorCanvas) ||
      (gameTab && !gameTab.disabled && gameCanvas)
    );
    if (hasUsableRuntime && editorSurfaceLive() && DiagnosticState.engine !== 'failed') {
      DiagnosticState.engine = 'ready';
      DiagnosticState.engineError = null;
    }
    return DiagnosticState.engine;
  }

  async function waitFor(predicate, timeoutMs = 8000, intervalMs = 80) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return true;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  function cloneProjectFiles(files) {
    return Object.fromEntries(Object.entries(files).map(([filePath, content]) => [
      filePath,
      content instanceof Uint8Array ? new Uint8Array(content) : content
    ]));
  }

  function cleanProjectPath(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) throw new Error('Project file path must be a non-empty string.');
    const cleaned = rawPath.trim().replace(/^res:\/\//, '').replace(/^\/+/, '');
    if (!cleaned || cleaned.includes('..') || cleaned.includes('\\') || cleaned.startsWith('.godot/')) {
      throw new Error(`Unsafe project file path: ${rawPath}`);
    }
    return cleaned;
  }

  // Lenient comparison key for "is this the same project".
  //
  // cleanProjectName is a validator: it throws on anything outside its charset, which includes
  // every Godot display name with a space in it ("Neon Skyrail 3D"). Comparing identities must
  // never throw, and must survive the difference between a display name and a directory name.
  function normalizeProjectIdentity(rawName) {
    if (typeof rawName !== 'string') return '';
    return rawName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function cleanProjectName(rawName) {
    if (typeof rawName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(rawName)) {
      throw new Error('Project name must be 1–64 characters using letters, numbers, underscores, or hyphens, and must start with a letter or number.');
    }
    return rawName;
  }

  const PROJECT_UPLOAD_CHUNK_BYTES = 512 * 1024;
  const PROJECT_UPLOAD_TOTAL_BYTES = 25 * 1024 * 1024;

  function publicProjectUpload(upload) {
    return {
      upload_id: upload.id,
      project_name: upload.projectName,
      created_at: upload.createdAt,
      updated_at: upload.updatedAt,
      total_bytes: upload.totalBytes,
      max_total_bytes: PROJECT_UPLOAD_TOTAL_BYTES,
      max_chunk_bytes: PROJECT_UPLOAD_CHUNK_BYTES,
      files: [...upload.files.entries()].map(([path, file]) => ({
        path: `res://${path}`,
        encoding: file.encoding,
        received_bytes: file.receivedBytes,
        complete: file.complete
      }))
    };
  }

  function projectUploadMetadata(upload) {
    return {
      ...upload,
      files: [...upload.files.entries()].map(([path, file]) => [path, {
        encoding: file.encoding,
        receivedBytes: file.receivedBytes,
        complete: file.complete,
        chunkCount: file.chunks.length
      }])
    };
  }

  async function persistProjectUpload(upload, appended = null) {
    try {
      const database = await openRecordingDatabase();
      await new Promise((resolve, reject) => {
        const stores = appended ? ['uploads', 'upload_chunks'] : ['uploads'];
        const transaction = database.transaction(stores, 'readwrite');
        transaction.objectStore('uploads').put(projectUploadMetadata(upload));
        if (appended) {
          transaction.objectStore('upload_chunks').put({
            key: `${upload.id}\u0000${appended.path}\u0000${appended.index}`,
            upload_id: upload.id,
            path: appended.path,
            index: appended.index,
            bytes: appended.bytes
          });
        }
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Failed to persist staged project upload.'));
      });
      database.close();
      return true;
    } catch (error) {
      activeLogs.push({ level: 'warn', time: Date.now(), msg: `[Upload persistence] ${error instanceof Error ? error.message : String(error)}` });
      return false;
    }
  }

  function cloneStagedProjectUpload(upload) {
    return {
      ...upload,
      files: new Map([...upload.files.entries()].map(([path, file]) => [path, { ...file, chunks: [...file.chunks] }]))
    };
  }

  async function persistProjectUploadBatch(upload, appendedChunks) {
    const database = await openRecordingDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['uploads', 'upload_chunks'], 'readwrite');
      transaction.objectStore('uploads').put(projectUploadMetadata(upload));
      const chunkStore = transaction.objectStore('upload_chunks');
      for (const appended of appendedChunks) {
        chunkStore.put({
          key: `${upload.id}\u0000${appended.path}\u0000${appended.index}`,
          upload_id: upload.id,
          path: appended.path,
          index: appended.index,
          bytes: appended.bytes
        });
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Failed to persist staged project chunk batch.'));
    });
    database.close();
  }

  async function migrateLegacyProjectUpload(upload) {
    const database = await openRecordingDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['uploads', 'upload_chunks'], 'readwrite');
      transaction.objectStore('uploads').put(projectUploadMetadata(upload));
      const chunkStore = transaction.objectStore('upload_chunks');
      for (const [filePath, file] of upload.files) {
        file.chunks.forEach((bytes, index) => chunkStore.put({
          key: `${upload.id}\u0000${filePath}\u0000${index}`,
          upload_id: upload.id,
          path: filePath,
          index,
          bytes
        }));
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Failed to migrate staged project chunks.'));
    });
    database.close();
  }

  async function deletePersistedProjectUpload(uploadId) {
    const database = await openRecordingDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['uploads', 'upload_chunks'], 'readwrite');
      transaction.objectStore('uploads').delete(uploadId);
      const cursorRequest = transaction.objectStore('upload_chunks').index('upload_id').openKeyCursor(IDBKeyRange.only(uploadId));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) { transaction.objectStore('upload_chunks').delete(cursor.primaryKey); cursor.continue(); }
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Failed to remove staged project upload.'));
    });
    database.close();
  }

  function decodeUploadChunk(content, encoding) {
    if (typeof content !== 'string') throw new Error('Project upload chunk content must be a string.');
    let bytes;
    if (encoding === 'base64') {
      let binary;
      try { binary = atob(content); } catch (_) { throw new Error('Project upload chunk is not valid base64.'); }
      bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    } else {
      bytes = new TextEncoder().encode(content);
    }
    if (bytes.byteLength > PROJECT_UPLOAD_CHUNK_BYTES) {
      throw new Error(`Project upload chunks may contain at most ${PROJECT_UPLOAD_CHUNK_BYTES} decoded bytes.`);
    }
    return bytes;
  }

  function assembleProjectUpload(upload) {
    if (upload.files.size === 0) throw new Error('The project upload contains no files.');
    const files = {};
    for (const [filePath, file] of upload.files) {
      if (!file.complete) throw new Error(`Project upload file is incomplete: res://${filePath}`);
      const bytes = new Uint8Array(file.receivedBytes);
      let offset = 0;
      for (const chunk of file.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      files[filePath] = file.encoding === 'utf8' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes;
    }
    validateProjectFiles(files);
    return files;
  }

  function stableSerialize(value) {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      let byteHash = 2166136261;
      for (const byte of bytes) {
        byteHash ^= byte;
        byteHash = Math.imul(byteHash, 16777619);
      }
      return `bytes:${bytes.byteLength}:${(byteHash >>> 0).toString(16)}`;
    }
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().filter(key => key !== 'idempotency_key').map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function mutationFingerprint(toolName, input) {
    const serialized = `${toolName}:${stableSerialize(input)}`;
    let hash = 2166136261;
    for (let i = 0; i < serialized.length; i++) {
      hash ^= serialized.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function getIdempotentReplay(key, fingerprint) {
    if (!key || !idempotentMutations.has(key)) return null;
    const stored = idempotentMutations.get(key);
    if (stored.fingerprint !== fingerprint) {
      throw new Error(`Idempotency key conflict: ${key} was already used for a different mutation payload.`);
    }
    return { ...stored.result, idempotent_replay: true };
  }

  function storeIdempotentResult(key, fingerprint, result, metadata = {}) {
    if (key) idempotentMutations.set(key, { fingerprint, result, metadata });
  }

  function normalizeTextResourceEscapedNewlines(content) {
    let text = '';
    let repairs = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      if (inString) {
        text += char;
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        text += char;
        continue;
      }
      if (char === '\\' && content[i + 1] === 'n') {
        text += '\n';
        repairs += 1;
        i += 1;
        continue;
      }
      text += char;
    }
    return { text, repairs };
  }

  function normalizeProjectTextResources(files) {
    const normalized = { ...files };
    const repairedPaths = [];
    let repairs = 0;
    for (const [filePath, content] of Object.entries(files || {})) {
      if (typeof content !== 'string' || !(filePath.endsWith('.tscn') || filePath.endsWith('.tres'))) continue;
      const result = normalizeTextResourceEscapedNewlines(content);
      if (result.repairs === 0) continue;
      normalized[filePath] = result.text;
      repairs += result.repairs;
      repairedPaths.push(filePath);
    }
    return { files: normalized, repairs, repairedPaths };
  }


  function validateProjectFiles(files) {
    const entries = Object.entries(files);
    if (entries.length === 0) throw new Error('A project must contain at least one file.');
    if (entries.length > 256) throw new Error('A project may contain at most 256 files.');
    let totalBytes = 0;
    for (const [rawPath, content] of entries) {
      const filePath = cleanProjectPath(rawPath);
      if (filePath !== rawPath) throw new Error(`Project paths must be normalized before commit: ${rawPath}`);
      if (!(typeof content === 'string' || content instanceof Uint8Array || content instanceof ArrayBuffer)) {
        throw new Error(`Unsupported content type for ${filePath}. Use text or binary bytes.`);
      }
      const size = typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength;
      if (size > 5 * 1024 * 1024) throw new Error(`File exceeds the 5 MB limit: ${filePath}`);
      totalBytes += size;
    }
    if (totalBytes > 25 * 1024 * 1024) throw new Error('Project exceeds the 25 MB in-memory authoring limit.');
    if (typeof files['project.godot'] !== 'string') throw new Error('project.godot is required and must be text.');
    const sceneFiles = entries.filter(([filePath]) => filePath.endsWith('.tscn'));
    if (sceneFiles.length === 0) throw new Error('At least one .tscn scene is required.');
    const configuredMainScene = files['project.godot'].match(/run\/main_scene\s*=\s*"res:\/\/([^"\r\n]+)"/)?.[1];
    if (configuredMainScene && !(cleanProjectPath(configuredMainScene) in files)) {
      throw new Error(`Configured main scene does not exist in the project: res://${configuredMainScene}`);
    }
    for (const [filePath, content] of entries) {
      if (typeof content !== 'string') continue;
      const references = [];
      if (filePath.endsWith('.tscn') || filePath.endsWith('.tres')) {
        for (const match of content.matchAll(/\bpath\s*=\s*"res:\/\/([^"\r\n]+)"/g)) references.push(match[1]);
      }
      if (filePath.endsWith('.gd')) {
        for (const match of content.matchAll(/\b(?:preload|load)\(\s*"res:\/\/([^"\r\n]+)"\s*\)/g)) references.push(match[1]);
      }
      for (const reference of references) {
        const referencedPath = cleanProjectPath(reference);
        if (!(referencedPath in files)) {
          throw new Error(`Missing referenced resource: res://${referencedPath} (from res://${filePath})`);
        }
      }
    }
    return { fileCount: entries.length, totalBytes };
  }

  function inferMainScene(files) {
    const projectConfig = typeof files['project.godot'] === 'string' ? files['project.godot'] : '';
    const configuredScene = projectConfig.match(/run\/main_scene\s*=\s*"([^"]+)"/)?.[1];
    const firstScene = Object.keys(files).find(filePath => filePath.endsWith('.tscn'));
    return normalizeResourcePath(configuredScene || firstScene, 'res://main.tscn');
  }

  // What a replacement should do given the current lifecycle state. Pure, so the decision
  // itself is testable without an engine: the bug being fixed was inferring "stopped" from a
  // DOM attribute that is also set while an editor is still initializing.
  const EDITOR_TERMINAL_STATES = new Set(['idle', 'exited', 'failed']);

  // Same-page takeover is never safe without the previous Engine's real exit signal.
  //
  // Both Engines live in one JS context and share the canvas and the `editor` global, so a
  // superseded boot's promise continuation can still call into the newer instance. That is
  // what produced "Engine must be inited before copying files" for every project file. An
  // earlier attempt here allowed takeover for `running`/`quitting` after a short wait, which
  // is exactly the weaker path a rollback then slipped through.
  //
  // So: every non-terminal state requires a confirmed exit. When that does not arrive, the
  // answer is NOT another Engine in this context — it is a hard recovery (reload the page),
  // because nothing in this JS context can be trusted to host a replacement.
  // `bootInFlight` overrides the state string. Godot's project-manager re-exec boots an engine
  // while the lifecycle still reads `exited` — a false terminal state that would let a
  // replacement construct a second Engine over a live one, which is the exact ownership
  // condition all of this exists to prevent. A boot in flight is never terminal.
  function editorReplacementPlan(state, bootInFlight = false) {
    if (EDITOR_TERMINAL_STATES.has(state) && !bootInFlight) {
      return { action: 'start', mustAwaitExit: false, requestQuit: false, waitMs: 0, exitRequired: false };
    }
    if (bootInFlight && EDITOR_TERMINAL_STATES.has(state)) {
      // Nothing to ask to quit — the engine has not reached `running` — but it must be awaited.
      return { action: 'await_exit', mustAwaitExit: true, requestQuit: true, waitMs: 25000, exitRequired: true };
    }
    return {
      action: 'await_exit',
      mustAwaitExit: true,
      // A quitting engine has already been asked; asking twice is pointless.
      requestQuit: state !== 'quitting',
      waitMs: 25000,
      exitRequired: true
    };
  }

  // A wall-clock deadline is meaningless in a hidden or throttled pane.
  //
  // Godot's main loop is driven by requestAnimationFrame, which browsers clamp to roughly 2fps
  // in a backgrounded tab and pause entirely in a hidden one. A fixed 25-second shutdown
  // deadline therefore expires while the engine has had perhaps fifty frames in which to
  // acknowledge requestQuit() — and the ownership guard then correctly, but pointlessly,
  // refuses to ever build another Engine in this page. The engine did not fail; it was never
  // given the time.
  //
  // So the budget counts only time the engine could actually spend: the document visible AND
  // the render heartbeat advancing. Hidden and stalled time is recorded separately rather than
  // discarded, so "it took 4 minutes" and "it had 25 seconds of frames" are both reportable
  // and a future diagnosis is evidence-based instead of a guess about tab focus.
  const RenderHeartbeat = {
    frames: 0,
    lastFrameAt: 0,
    started: false,
    start() {
      if (this.started || typeof requestAnimationFrame !== 'function') return false;
      this.started = true;
      const tick = () => {
        this.frames += 1;
        this.lastFrameAt = Date.now();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    }
  };

  function documentIsVisible() {
    if (typeof document === 'undefined') return true;
    return document.visibilityState !== 'hidden';
  }

  function createActiveBudget(budgetMs, now = Date.now()) {
    return { budgetMs, activeMs: 0, suspendedMs: 0, hiddenMs: 0, lastTickAt: now, status: 'running' };
  }

  // Pure so the suspend/resume decision is testable without a browser: `frameAdvanced` is
  // whether the render heartbeat moved since the previous tick, `visible` is document
  // visibility. Either being false suspends the budget — a foregrounded tab whose engine is
  // not rendering is not spending the engine's time either.
  function tickActiveBudget(budget, { now, visible, frameAdvanced }) {
    const delta = Math.max(0, now - budget.lastTickAt);
    budget.lastTickAt = now;
    const active = Boolean(visible) && Boolean(frameAdvanced);
    if (active) {
      budget.activeMs += delta;
    } else {
      budget.suspendedMs += delta;
      if (!visible) budget.hiddenMs += delta;
    }
    if (budget.activeMs >= budget.budgetMs) budget.status = 'expired';
    else budget.status = active ? 'running' : 'waiting_for_foreground';
    return budget;
  }

  // Runs `isDone` until it returns true or the budget's *active* time runs out. `onStatus`
  // sees each transition between running and waiting_for_foreground, which is what puts
  // "Keep this editor visible to finish the update" on screen instead of a silent stall.
  async function awaitWithActiveBudget(isDone, budgetMs, onStatus = null, pollMs = 100) {
    const budget = createActiveBudget(budgetMs);
    let lastFrames = RenderHeartbeat.frames;
    let announced = null;
    for (;;) {
      if (isDone()) return { ok: true, budget };
      await new Promise(resolve => setTimeout(resolve, pollMs));
      const frames = RenderHeartbeat.frames;
      tickActiveBudget(budget, {
        now: Date.now(),
        visible: documentIsVisible(),
        // With no rAF at all (a test harness, or a browser that never paints), fall back to
        // visibility alone rather than suspending forever and never timing out.
        frameAdvanced: RenderHeartbeat.started ? frames > lastFrames : true
      });
      lastFrames = frames;
      if (budget.status !== announced && budget.status !== 'expired') {
        announced = budget.status;
        if (typeof onStatus === 'function') onStatus(budget.status, budget);
      }
      if (budget.status === 'expired') return { ok: isDone(), budget };
    }
  }

  const EditorLifecycle = {
    state() {
      if (typeof window === 'undefined') return 'idle';
      return window.__godotEditorLifecycle?.state || 'idle';
    },
    generation() {
      if (typeof window === 'undefined') return 0;
      return window.__godotEditorLifecycle?.generation || 0;
    },
    // Await the engine's own exit signal, never a button attribute.
    bootInFlight() {
      if (typeof window === 'undefined') return false;
      return window.__godotEditorLifecycle?.bootInFlight === true;
    },

    // The budget is spent in ACTIVE time, not wall-clock. `onStatus` is how the shelf learns
    // to say "Keep this editor visible to finish the update" rather than appearing to hang.
    async prepareForReplacement(onStatus = null) {
      const state = this.state();
      const generation = this.generation();
      const plan = editorReplacementPlan(state, this.bootInFlight());
      if (!plan.mustAwaitExit) {
        return { ok: true, state, generation, awaited: false, active_ms: 0, hidden_ms: 0, suspended_ms: 0 };
      }
      if (plan.requestQuit) {
        try {
          if (typeof window.closeEditor === 'function') window.closeEditor();
        } catch (_) {}
      }
      // A boot that started during the wait leaves an Engine live even if the state now reads
      // terminal, so the exit does not count until nothing is in flight.
      const exited = () => EDITOR_TERMINAL_STATES.has(this.state()) && !this.bootInFlight();
      const startedAt = Date.now();
      const waited = await awaitWithActiveBudget(exited, plan.waitMs, onStatus);
      const outcome = waited.ok ? this.state() : 'timeout';
      return {
        ok: waited.ok,
        state,
        generation,
        awaited: true,
        outcome,
        active_ms: Math.round(waited.budget.activeMs),
        hidden_ms: Math.round(waited.budget.hiddenMs),
        suspended_ms: Math.round(waited.budget.suspendedMs),
        wall_ms: Date.now() - startedAt
      };
    },
    describe() {
      if (typeof window === 'undefined') return { state: 'idle', generation: 0 };
      const lifecycle = window.__godotEditorLifecycle || {};
      return {
        state: lifecycle.state || 'idle',
        generation: lifecycle.generation || 0,
        started_at: lifecycle.startedAt || null,
        exited_at: lifecycle.exitedAt || null,
        last_error: lifecycle.lastError || null
      };
    }
  };

  let editorRestartCount = 0;
  // Exactly one replacement at a time. Two overlapping restarts is precisely how a rollback
  // raced a still-initializing engine.
  let editorReplacementInFlight = false;
  // Set when an engine never confirms its exit. Once true, NOTHING in this page may build
  // another Engine — including a rollback, which is the path that previously slipped past the
  // barrier and recreated the overlap it existed to prevent.
  let editorRestartBlocked = false;

  // Remove every asset this session imported into the live editor filesystem.
  //
  // These deliberately never entered the project file dict, so nothing else knows about them;
  // this map is the only record, and the plugin is the only thing that can delete them.
  // Godot imports on its own main-loop pass, so the reply to an import request is always
  // taken before the work happens. Ask the editor what it actually ended up with, spending
  // foreground-active time so a hidden tab is reported as paused rather than as a failure.
  async function awaitAssetImport(resPath, budgetMs) {
    let last = { ok: false, loadable: false, has_import: false, exists: false, size_bytes: null };
    const read = () => {
      const state = EditorCommandChannel.call('asset_state', { path: resPath });
      if (state && state.ok) last = state;
      return state;
    };
    read();
    if (budgetMs <= 0) return last;
    await awaitWithActiveBudget(() => {
      const state = read();
      return Boolean(state && state.ok && state.loadable === true);
    }, budgetMs, null, 120);
    return last;
  }


  // 'Dummy' here is what made audio impossible, and it was ours, not Godot's.
  //
  // The editor was booted with --audio-driver Dummy so an editor AudioContext could not race
  // the game's. The cost was invisible and large: Godot's audio import generates a waveform
  // preview by mixing the stream through AudioServer, a Dummy driver returns a zero-length
  // preview, and the editor then indexes it at -1 and aborts the WebAssembly runtime. Every
  // "Godot cannot import audio in this build" conclusion traced back to this one flag.
  //
  // Measured with 'AudioWorklet': a .wav imports, appears in the FileSystem dock, is loadable,
  // and a project holding one boots clean - the exact case that used to abort. Valid values
  // are the three Godot names: AudioWorklet, ScriptProcessor, Dummy.
  const EDITOR_AUDIO_DRIVER = 'AudioWorklet';

  async function restartEditorWithProject(files, projectName = DiagnosticState.activeProject, timeoutMs = 60000, operation = null) {
    if (typeof window === 'undefined' || typeof window.startEditor !== 'function') {
      throw new Error('Godot editor bootstrap is unavailable.');
    }
    validateProjectFiles(files);
    if (editorRestartBlocked) {
      const error = new Error('This page can no longer host a Godot editor: a previous engine never confirmed it exited. Reload the page to recover; the project is safe in storage.');
      error.code = 'EDITOR_RESTART_REQUIRED';
      error.recovery_action = 'reload_page';
      throw error;
    }
    if (editorReplacementInFlight) {
      const error = new Error('Another editor replacement is already in flight; refusing to start a second one.');
      error.code = 'EDITOR_REPLACEMENT_IN_FLIGHT';
      throw error;
    }
    editorReplacementInFlight = true;
    // Published so the hot-script filesystem writer in index.html can refuse mid-teardown.
    // The in-module flag is not enough: that writer lives in a different script and must be
    // able to tell "the Engine is about to be replaced" from "the Engine is fine".
    if (typeof window !== 'undefined') window.__godotEditorReplacementInFlight = true;
    try {
    if (typeof window !== 'undefined') holdRuntimeFrame();
    // A running game owns the same virtual project filesystem. Replacing the
    // editor first can race its shutdown and leave the new --path unmounted.
    if (operation) await advancePhase(operation, 'stopping_runtime');
    await stopGameRuntime(10000);

    // Wait for the previous Engine to actually EXIT. The old check read the close button's
    // disabled attribute, which is also set while an editor is still initializing — so a
    // rollback after a boot timeout could construct a replacement while the failed instance
    // was mid-construction, invalidating it ("Engine must be inited before copying files")
    // and leaving a black viewport with no recovery path.
    if (operation) await advancePhase(operation, 'replacing_editor');
    const replacement = await EditorLifecycle.prepareForReplacement((status, budget) => {
      // Not a failure and not a stall — the engine simply is not being given frames. Say so
      // plainly and keep waiting; the budget is not being spent.
      if (status === 'waiting_for_foreground') {
        DiagnosticState.shutdownWaiting = true;
        AgentStatusRail.setFocusNote('Keep this editor visible to finish the update');
      } else {
        DiagnosticState.shutdownWaiting = false;
        AgentStatusRail.setFocusNote(`Finishing the update · ${Math.round(budget.activeMs / 1000)}s`);
      }
    });
    DiagnosticState.shutdownWaiting = false;
    AgentStatusRail.setFocusNote('');
    // Recorded separately and always, success or failure: without hidden vs foreground-active
    // duration next to the outcome, every future report of "the editor hung" is unfalsifiable.
    DiagnosticState.lastShutdown = {
      state: replacement.state,
      generation: replacement.generation,
      outcome: replacement.outcome || (replacement.awaited ? 'exited' : 'not_awaited'),
      active_ms: replacement.active_ms || 0,
      hidden_ms: replacement.hidden_ms || 0,
      suspended_ms: replacement.suspended_ms || 0,
      wall_ms: replacement.wall_ms || 0,
      at: Date.now()
    };
    if (!replacement.ok) {
      // Latch. Another Engine in this JS context cannot be trusted after this, and a rollback
      // retrying through a weaker path is how the barrier was defeated last time.
      editorRestartBlocked = true;
      DiagnosticState.session = 'restart_required';
      DiagnosticState.engine = 'failed';
      DiagnosticState.engineError = `The previous Godot editor (state: ${replacement.state}) never confirmed it exited after ${Math.round((replacement.active_ms || 0) / 1000)}s of foreground-active time.`;
      DiagnosticHUD.render();
      const error = new Error(`The previous Godot editor did not confirm it exited (state: ${replacement.state}) after ${Math.round((replacement.active_ms || 0) / 1000)}s of foreground-active time (${Math.round((replacement.hidden_ms || 0) / 1000)}s hidden). Refusing to construct another engine in this page; reload the page to recover — the project is safe in storage.`);
      error.code = 'EDITOR_EXIT_TIMEOUT';
      error.lifecycle_state = replacement.state;
      error.lifecycle_generation = replacement.generation;
      error.active_ms = replacement.active_ms;
      error.hidden_ms = replacement.hidden_ms;
      error.recovery_action = 'reload_page';
      throw error;
    }

    // Counted only once a replacement is actually permitted, so refused attempts do not
    // inflate the restart count that regression checks read.
    editorRestartCount += 1;
    window.__webmcpRestartCount = editorRestartCount;

    window._mcpProjectName = projectName;
    // The agent command plugin rides along on disk without entering activeFilesDict.
    window._mcpProjectFiles = withEditorPlugin(files);
    EditorCommandChannel.nextGeneration();
    DiagnosticState.engine = 'loading';
    DiagnosticState.session = 'authoring';
    DiagnosticHUD.render();

    if (operation) await advancePhase(operation, 'booting_editor');
    const bootStartedAt = Date.now();
    let readyEventObserved = false;
    let failureMessage = null;
    const onReady = () => { readyEventObserved = true; };
    const onFailed = (event) => { failureMessage = event?.detail?.message || 'Godot editor failed to initialize.'; };
    window.addEventListener('godot-engine-ready', onReady, { once: true });
    window.addEventListener('godot-engine-failed', onFailed, { once: true });
    // See EDITOR_AUDIO_DRIVER. Overridable so a session can put the old driver back without
    // editing this file, and so the driver is visible in a bug report.
    const audioDriver = (typeof window !== 'undefined' && window.__webmcpEditorAudioDriver) || EDITOR_AUDIO_DRIVER;
    window.startEditor(null, ['--path', `/home/web_user/projects/${projectName}`, '--editor', '--audio-driver', audioDriver]);
    // Booting is frame-work: the engine only makes progress while the page is actually
    // painting. Spending a wall-clock budget declares a hidden or throttled tab dead when it
    // is merely paused, so the boot wait spends the same foreground-active budget the exit
    // wait does, and says so when it is waiting on frames rather than on the engine.
    const bootReady = () => {
      if (failureMessage || readyEventObserved) return true;
      const editorTab = document.getElementById('btn-tab-editor');
      const editorCanvas = document.getElementById('editor-canvas');
      const bootTelemetry = activeLogs.some(entry => entry.time >= bootStartedAt && /Build configuration:|Godot Engine v/i.test(entry.msg));
      return Boolean(editorTab && !editorTab.disabled && editorCanvas && bootTelemetry);
    };
    const booted = await awaitWithActiveBudget(bootReady, timeoutMs, (status, budget) => {
      if (status === 'waiting_for_foreground') {
        AgentStatusRail.setFocusNote('Keep this editor visible to finish opening the project');
      } else {
        AgentStatusRail.setFocusNote(`Opening the project - ${Math.round(budget.activeMs / 1000)}s`);
      }
    });
    AgentStatusRail.setFocusNote('');
    const ready = booted.ok;
    DiagnosticState.lastBootWait = {
      ok: ready,
      active_ms: Math.round(booted.budget.activeMs),
      hidden_ms: Math.round(booted.budget.hiddenMs),
      suspended_ms: Math.round(booted.budget.suspendedMs),
      at: Date.now()
    };
    window.removeEventListener('godot-engine-ready', onReady);
    window.removeEventListener('godot-engine-failed', onFailed);
    if (failureMessage) throw new Error(failureMessage);
    if (!ready) {
      const error = new Error(`Godot editor did not confirm project readiness after ${Math.round(booted.budget.activeMs / 1000)}s of foreground-active time (${Math.round(booted.budget.hiddenMs / 1000)}s hidden).`);
      error.code = 'EDITOR_BOOT_TIMEOUT';
      error.active_ms = Math.round(booted.budget.activeMs);
      error.hidden_ms = Math.round(booted.budget.hiddenMs);
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 450));
    const bootErrors = recentGodotErrors(bootStartedAt);
    if (bootErrors.length > 0) {
      throw new Error(`Godot rejected the project during editor boot: ${bootErrors[0].msg}`);
    }
    DiagnosticState.engine = 'ready';
    DiagnosticState.session = 'editor-ready';
    // The plugin publishes its callback from _enter_tree, which runs a little after the
    // engine reports ready. Give it a bounded window; its absence is never fatal.
    await EditorCommandChannel.waitForReady(4000);
    DiagnosticHUD.render();
    if (typeof window === 'undefined' || !window.__godotWebMcpKeepRuntimeFrame) releaseRuntimeFrame();
    return true;
    } finally {
      editorReplacementInFlight = false;
      if (typeof window !== 'undefined') window.__godotEditorReplacementInFlight = false;
    }
  }

  async function restoreProjectSnapshot(previous, operation = null) {
    if (operation) await advancePhase(operation, 'rolling_back');
    // In-memory metadata is restored first and unconditionally, so the project is never lost
    // even when the engine cannot be revived.
    DiagnosticState.activeProject = previous.projectName;
    activeMainScene = previous.mainScene;
    activeFilesDict = cloneProjectFiles(previous.files);
    if (editorRestartBlocked) {
      // The whole point of the barrier. A rollback that builds another Engine after an exit
      // timeout recreates exactly the overlap the barrier exists to prevent — that is how the
      // corruption reappeared: the original path refused, then rollback retried and slipped
      // through. The project state is restored; the page must be reloaded to get an editor.
      DiagnosticState.session = 'restart_required';
      DiagnosticState.engine = 'failed';
      DiagnosticHUD.render();
      activeLogs.push({
        level: 'error',
        time: Date.now(),
        generation: EditorCommandChannel.generation,
        msg: '[Editor lifecycle] rollback restored the project in memory but did NOT construct a replacement engine: a previous engine never confirmed it exited. Reload the page to recover.'
      });
      await persistActiveProjectState({ files: activeFilesDict, revision: DiagnosticState.sceneRevision }).catch(() => {});
      return false;
    }
    if (Object.keys(previous.files).length > 0) {
      try {
        await restartEditorWithProject(previous.files, previous.projectName, 60000, operation);
        return true;
      } catch (_) {
        DiagnosticState.session = 'failed';
        DiagnosticState.engine = 'failed';
        DiagnosticHUD.render();
        return false;
      }
    }

    const closeEditorButton = document.getElementById('btn-close-editor');
    if (closeEditorButton && !closeEditorButton.disabled && typeof window.closeEditor === 'function') {
      window.closeEditor();
      await waitFor(() => closeEditorButton.disabled, 12000);
    }
    if (typeof window.showTab === 'function') window.showTab('loader');
    DiagnosticState.session = previous.session;
    DiagnosticState.engine = previous.engine;
    DiagnosticHUD.render();
    return true;
  }

  function unsupportedEditorOperation(operation, requirement) {
    const error = new Error(`${operation} is not connected to an acknowledged Godot Editor command channel. ${requirement}`);
    error.code = 'EDITOR_COMMAND_UNSUPPORTED';
    throw error;
  }

  function recentGodotErrors(sinceTime) {
    // The web editor emits platform-level `ERROR:` diagnostics for unsupported
    // debugger sockets and Emscripten blocking warnings even when a project is
    // healthy. Treat only project-load/runtime failures as transaction blockers.
    const patterns = /SCRIPT ERROR|Parse Error|Failed to load (?:script|resource|scene)|Game (?:start|initialization) failed|Invalid project path specified|AudioWorkletNode.*BaseAudioContext|Invalid get index|Invalid call|Nonexistent function/i;
    return activeLogs.filter(entry => entry.time >= sinceTime && entry.level === 'error' && patterns.test(entry.msg));
  }

  // A `FATAL:` line is not diagnostic noise. In this engine it comes from CRASH_BAD_INDEX,
  // which calls GENERATE_TRAP() — an unconditional abort — so the runtime does not survive it
  // and everything reported afterwards is suspect. Surfaced separately from ordinary errors
  // and never filtered by the tolerated-noise patterns above.
  function fatalGodotErrors(sinceTime, generation = null, logs = activeLogs) {
    return logs.filter(entry => entry.time >= sinceTime
      && /\bFATAL:/.test(String(entry.msg))
      && (generation === null || entry.generation === generation));
  }

  // Errors belonging to one editor generation, with teardown noise from a previous process
  // excluded. Pure over the log array so it can be tested without a browser.
  function generationScopedErrors(logs, generation, sinceTime = 0) {
    return logs.filter(entry => entry.time >= sinceTime
      && entry.level === 'error'
      && entry.generation === generation
      && !/leaked at exit|leaked \d+ bytes|ObjectDB instances were leaked/i.test(String(entry.msg)));
  }

  // A fresh, healthy session logs several `ERROR:` lines that are simply how this platform
  // behaves: no TCP sockets in a browser, occlusion culling compiled out, Emscripten warning
  // about blocking the main thread. Counting those as "session errors" next to
  // `status: healthy` is confusing and trains people to ignore the number. Classified instead,
  // so an actionable project error is visible among them.
  const PLATFORM_DIAGNOSTIC_PATTERNS = [
    /Occlusion culling is disabled/i,
    // The browser has no TCP sockets, so the editor debugger listener always fails. Godot
    // prints the message and its source location on SEPARATE lines, which is why entries are
    // paired with their `at:` continuation before matching — the message alone
    // (`Condition "err != OK" is true. Returning: ERR_CANT_CREATE`) carries no clue at all.
    /tcp_server\.cpp|Debug adapter server|Unable to start(?: the)? debugger|remote debugger|Cannot bind/i,
    /Blocking on the main thread is very dangerous/i,
    /AudioWorkletNode|BaseAudioContext/i,
    /WebGL.*(?:extension|not supported)/i,
    /ServiceWorker/i,
    /GDExtension support/i,
    // Godot's Web export may attempt to sync its desktop-style virtual filesystem after the
    // project directory has been replaced. The bridge persists the authoritative project in
    // its own IndexedDB transaction, so this does not describe a project-source failure.
    /Failed to save IDB file system/i,
    // The Web editor build ships the FileSystem dock without the desktop-only shortcuts it
    // still looks up ("Show in File Manager", "Open in Terminal"). Every keypress the dock
    // sees logs one of these. It describes the build, not the project.
    /Unknown Shortcut: filesystem_dock\//i
  ];
  // Lines this page writes about its own runtime handling. They are worth keeping in the log -
  // they explain what the bridge did - but they are not output from the authored project, and
  // counting them as project errors sends an agent off to fix code that is not broken.
  const BRIDGE_NOTICE_PATTERN = /^\s*\[(?:Runtime lifecycle|Preview Refresh|WebMCP)\]/;
  const TEARDOWN_NOISE_PATTERN = /leaked at exit|leaked \d+ bytes|ObjectDB instances were leaked|RID allocations|Pages in use exist at exit|shaders? .* never freed|resources? still in use at exit|Buffer with GL ID .* leaked|Leaked instance dependency/i;

  function classifyEngineDiagnostics(logs, generation, sinceTime = 0) {
    const scoped = logs.filter(entry => entry.time >= sinceTime && entry.generation === generation);
    // Godot emits "ERROR: <message>" and "   at: <function> (<file>:<line>)" as two entries.
    // Classifying them independently loses the only identifying detail the pair carries, so
    // each message absorbs its trailing location line first.
    const merged = [];
    for (const entry of scoped) {
      const message = String(entry.msg);
      if (/^\s*at:\s/.test(message) && merged.length > 0) {
        merged[merged.length - 1].text += ' | ' + message.trim();
        merged[merged.length - 1].resolved = merged[merged.length - 1].resolved || entry.resolved === true;
        continue;
      }
      merged.push({ level: entry.level, text: message, resolved: entry.resolved === true });
    }
    const errors = [];
    const warnings = [];
    const platform = [];
    const resolved = [];
    for (const entry of merged) {
      if (TEARDOWN_NOISE_PATTERN.test(entry.text)) continue;
      if (/\bFATAL:/.test(entry.text)) { errors.push(entry.text); continue; }
      if (BRIDGE_NOTICE_PATTERN.test(entry.text)) { platform.push(entry.text); continue; }
      if (entry.resolved) { resolved.push(entry.text); continue; }
      if (PLATFORM_DIAGNOSTIC_PATTERNS.some(pattern => pattern.test(entry.text))) { platform.push(entry.text); continue; }
      // Godot writes WARNING: lines to stderr, so they arrive tagged level 'error'. The text
      // is what says what it is; testing the level first counted every engine warning as a
      // project error. Only FATAL outranks the prefix.
      if (/^\s*WARNING:/.test(entry.text) || entry.level === 'warn') { warnings.push(entry.text); continue; }
      if (entry.level === 'error') errors.push(entry.text);
    }
    return { errors, warnings, platform_diagnostics: platform, resolved_diagnostics: resolved };
  }

  // Converts the raw Godot stream into causes an agent can act on. This stays pure so the
  // classification can be regression-tested with exact engine output rather than relying on a
  // particular template to happen to emit each failure. It deliberately reports capability:
  // platform limitations are explained, but never presented as automatically repairable.
  function diagnoseEngineSession(logs, generation, options = {}) {
    const classified = classifyEngineDiagnostics(logs, generation, options.sinceTime || 0);
    const issues = [];
    const nextTools = new Set(['godot_get_session_status', 'godot_get_logs']);
    const addIssue = issue => issues.push({
      evidence: [],
      automatic_fix: { available: false },
      ...issue
    });

    const dapEvidence = classified.platform_diagnostics.filter(text =>
      /tcp_server\.cpp|Debug adapter server|debugger.*(?:bind|start)|ERR_CANT_CREATE/i.test(text));
    if (dapEvidence.length) {
      addIssue({
        code: 'GODOT_WEB_DAP_UNAVAILABLE',
        severity: 'info',
        owner: 'godot_web_platform',
        category: 'platform_capability',
        impact: 'External GDScript Debug Adapter Protocol clients cannot attach. The editor, project, game, WebMCP commands, and captured logs remain usable.',
        probable_cause: 'Godot starts its desktop-oriented debug adapter TCP listener during editor startup, but a WebAssembly browser build has no raw TCP socket capability.',
        evidence: dapEvidence,
        automatic_fix: {
          available: false,
          reason: 'Changing the port cannot add raw TCP support. Removing the visible message requires rebuilding the Godot editor WebAssembly binary with the debug adapter disabled on Web builds.'
        },
        recommended_action: 'Do not modify the game project. Use WebMCP session diagnostics, logs, and telemetry for browser-hosted debugging.'
      });
    }

    const otherPlatform = classified.platform_diagnostics.filter(text => !dapEvidence.includes(text));
    if (otherPlatform.length) {
      addIssue({
        code: 'GODOT_WEB_PLATFORM_DIAGNOSTIC',
        severity: 'info',
        owner: 'godot_web_platform',
        category: 'platform_capability',
        impact: 'A native-editor capability is unavailable or constrained in the browser.',
        probable_cause: 'The embedded Godot editor is running inside a browser WebAssembly sandbox.',
        evidence: otherPlatform,
        recommended_action: 'No project change is recommended unless a related feature is visibly broken.'
      });
    }

    for (const warning of classified.warnings) {
      if (/SpatialMaterial remapped parameter not found:\s*\\n/i.test(warning)) {
        addIssue({
          code: 'MALFORMED_TEXT_RESOURCE_ESCAPE',
          severity: 'error',
          owner: 'project_source',
          category: 'resource_serialization',
          impact: 'Godot reads an escaped newline as part of a material property name, so the intended property is ignored.',
          probable_cause: 'A generated .tscn or .tres file contains a literal \\n token outside a quoted string instead of a real line break.',
          evidence: [warning],
          automatic_fix: {
            available: true,
            tool: 'godot_restore_project_session',
            behavior: 'The bridge normalizes malformed text-resource line breaks while hydrating the authoritative project snapshot.'
          },
          recommended_action: 'Restore or reload the persisted project, then confirm the warning is absent and inspect the affected material.'
        });
        nextTools.add('godot_restore_project_session');
        nextTools.add('godot_inspect_project_files');
      } else {
        addIssue({
          code: 'PROJECT_WARNING',
          severity: 'warning',
          owner: 'project_or_engine',
          category: 'warning',
          impact: 'Godot reported a non-fatal condition that may affect the authored scene.',
          probable_cause: 'The warning needs its referenced node, resource, or source location inspected.',
          evidence: [warning],
          recommended_action: 'Inspect the referenced project file or node before deciding whether a mutation is needed.'
        });
        nextTools.add('godot_inspect_project_files');
      }
    }

    for (const error of classified.errors) {
      if (/\bFATAL:/.test(error)) {
        addIssue({
          code: 'ENGINE_FATAL',
          severity: 'fatal',
          owner: 'engine_runtime',
          category: 'engine_abort',
          impact: 'The current Godot runtime cannot be trusted after an unconditional engine trap.',
          probable_cause: 'A native engine invariant failed. Subsequent editor results from this generation may be invalid.',
          evidence: [error],
          automatic_fix: { available: false, reason: 'The page must recover or reload before further mutations; the underlying trigger still requires diagnosis.' },
          recommended_action: 'Stop mutations, preserve the project snapshot, reload the editor, and investigate the first fatal line.'
        });
      } else if (/SCRIPT ERROR|Parse Error|Failed to load (?:script|resource|scene)/i.test(error)) {
        addIssue({
          code: 'PROJECT_SCRIPT_OR_RESOURCE_ERROR',
          severity: 'error',
          owner: 'project_source',
          category: 'project_load',
          impact: 'A script, scene, or resource could not be parsed or loaded correctly.',
          probable_cause: 'The authored project source contains invalid syntax, an invalid reference, or unsupported serialized data.',
          evidence: [error],
          recommended_action: 'Inspect the named file, apply the smallest source correction, and re-run diagnostics.'
        });
        nextTools.add('godot_inspect_project_files');
      } else {
        addIssue({
          code: 'UNCLASSIFIED_ENGINE_ERROR',
          severity: 'error',
          owner: 'unknown',
          category: 'unclassified',
          impact: 'Godot emitted an actionable error that does not match a known signature.',
          probable_cause: 'More context is required; the tool intentionally does not infer a fix from an unknown message.',
          evidence: [error],
          recommended_action: 'Inspect adjacent logs and the current project files before changing state.'
        });
        nextTools.add('godot_inspect_project_files');
      }
    }

    if (options.persistenceError) {
      addIssue({
        code: 'PROJECT_PERSISTENCE_FAILED',
        severity: 'error',
        owner: 'bridge_storage',
        category: 'persistence',
        impact: 'The live editor state may be newer than the project snapshot stored in IndexedDB.',
        probable_cause: String(options.persistenceError),
        recommended_action: 'Avoid reloading, inspect session status, and retry persistence before making more edits.'
      });
    }
    if (options.restartRequired) {
      addIssue({
        code: 'EDITOR_RESTART_REQUIRED',
        severity: 'error',
        owner: 'bridge_lifecycle',
        category: 'recovery',
        impact: 'This page can no longer safely construct or reuse a Godot Engine instance.',
        probable_cause: 'The previous editor instance did not confirm exit, so ownership safety blocks another same-page engine.',
        recommended_action: 'Reload the browser page to recover the persisted project in a fresh engine instance.'
      });
    }

    const severityRank = { info: 0, warning: 1, error: 2, fatal: 3 };
    const highestSeverity = issues.reduce((highest, issue) =>
      severityRank[issue.severity] > severityRank[highest] ? issue.severity : highest, 'info');
    const actionableCount = issues.filter(issue => severityRank[issue.severity] > 0).length;
    return {
      status: options.restartRequired ? 'restart_required' : actionableCount ? 'action_required' : 'no_project_action_required',
      generation,
      highest_severity: highestSeverity,
      actionable_issue_count: actionableCount,
      platform_diagnostic_count: issues.filter(issue => issue.category === 'platform_capability').length,
      issues,
      recommended_next_tools: [...nextTools]
    };
  }

  // Teardown from a previous editor process logs RID/ObjectDB/WebGL leaks that are expected
  // and belong to a generation that no longer exists. Separate them from this session's.
  function currentGenerationErrors(sinceTime) {
    return generationScopedErrors(activeLogs, EditorCommandChannel.generation, sinceTime);
  }

  function waitForRuntimeEvent(successEvent, failureEvent, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener(successEvent, onSuccess);
        if (failureEvent) window.removeEventListener(failureEvent, onFailure);
      };
      const onSuccess = () => { cleanup(); resolve(true); };
      const onFailure = (event) => { cleanup(); reject(new Error(event?.detail?.message || `${failureEvent} reported failure.`)); };
      window.addEventListener(successEvent, onSuccess, { once: true });
      if (failureEvent) window.addEventListener(failureEvent, onFailure, { once: true });
      timeout = setTimeout(() => { cleanup(); reject(new Error(timeoutMessage)); }, timeoutMs);
    });
  }

  async function stopGameRuntime(timeoutMs = 6000) {
    const closeGameButton = document.getElementById('btn-close-game');
    const wasRunning = Boolean(closeGameButton && !closeGameButton.disabled);
    if (!wasRunning) return false;
    if (typeof window.closeGame !== 'function') throw new Error('Game is running, but the runtime quit control is unavailable.');
    let stoppedEventObserved = false;
    const onStopped = () => { stoppedEventObserved = true; };
    window.addEventListener('godot-game-stopped', onStopped, { once: true });
    window.closeGame();
    // Active time, not wall clock - the same rule the editor shutdown budget already follows.
    // The runtime acknowledges requestQuit on a frame, and a pane the browser has throttled to
    // ~2fps produces almost none. Spending the budget on wall clock declared a perfectly
    // healthy quit "failed and cleaned up" every time the preview was refreshed from a tab
    // that was not being painted, and logged that as if the project had broken.
    const settled = await awaitWithActiveBudget(
      () => stoppedEventObserved || closeGameButton.disabled || ['stopped', 'failed'].includes(window.__godotGameState),
      timeoutMs,
      // Same rule as the editor shutdown: a runtime that is not being given frames is waiting
      // on the human, not hung, and saying which one it is costs nothing.
      (status) => {
        DiagnosticState.shutdownWaiting = status === 'waiting_for_foreground';
        AgentStatusRail.setFocusNote(status === 'waiting_for_foreground'
          ? 'Keep this page visible to finish the preview update'
          : 'Updating the running preview');
      },
      60);
    window.removeEventListener('godot-game-stopped', onStopped);
    DiagnosticState.shutdownWaiting = false;
    if (!settled.ok || !closeGameButton.disabled) {
      if (typeof window.__forceResetFailedGameRuntime === 'function') {
        window.__forceResetFailedGameRuntime();
      }
    }
    return true;
  }

  async function startGameRuntime({ visible = true, timeoutMs = 15000 } = {}) {
    if (typeof window.Execute !== 'function') throw new Error('Godot editor is not initialized; author or open a project before running it.');
    await stopGameRuntime(10000);
    const startedAt = Date.now();
    let launchedEventObserved = false;
    let failureMessage = null;
    const onLaunched = () => { launchedEventObserved = true; };
    const onFailed = (event) => { failureMessage = event?.detail?.message || 'Godot game launch failed.'; };
    window.addEventListener('godot-game-launched', onLaunched, { once: true });
    window.addEventListener('godot-game-failed', onFailed, { once: true });
    window.Execute(['--path', `/home/web_user/projects/${DiagnosticState.activeProject}`]);
    const launched = await waitFor(() => {
      if (failureMessage || launchedEventObserved) return true;
      const gameTab = document.getElementById('btn-tab-game');
      const runtimeTelemetry = activeLogs.some(entry => entry.time >= startedAt && /Build configuration:|Godot Engine v/i.test(entry.msg));
      return Boolean(gameTab && !gameTab.disabled && runtimeTelemetry && window.__godotGameState === 'running');
    }, timeoutMs);
    window.removeEventListener('godot-game-launched', onLaunched);
    window.removeEventListener('godot-game-failed', onFailed);
    if (failureMessage) throw new Error(failureMessage);
    if (!launched) throw new Error(`Godot did not confirm game launch within ${Math.round(timeoutMs / 1000)} seconds.`);
    await waitFor(() => {
      if (recentGodotErrors(startedAt).length > 0) return true;
      return activeLogs.some(entry => entry.time >= startedAt && /Build configuration:|Godot Engine v/i.test(entry.msg));
    }, Math.min(timeoutMs, 2500));
    await new Promise(resolve => setTimeout(resolve, 1200));
    const errors = recentGodotErrors(startedAt);
    if (errors.length > 0) {
      if (typeof window.__forceResetFailedGameRuntime === 'function') window.__forceResetFailedGameRuntime();
      else try { await stopGameRuntime(6000); } catch (_) {}
      throw new Error(`Godot rejected the project during runtime boot: ${errors[0].msg}`);
    }
    const gameTab = document.getElementById('btn-tab-game');
    const gameReady = Boolean(gameTab && !gameTab.disabled);
    if (!gameReady) throw new Error('Godot emitted game-ready, but the Game tab is not enabled.');
    if (visible) {
      if (typeof window.showTab === 'function') window.showTab('game');
      else gameTab.click();
    }
    const gamePanel = document.getElementById('tab-game');
    const gameVisible = Boolean(gamePanel && gamePanel.style.display !== 'none');
    if (visible && !gameVisible) throw new Error('Game runtime started, but the Game viewport could not be made visible.');
    if (visible) rememberPreviewWasRunning();
    return { gameReady: true, gameVisible: visible ? gameVisible : false, startedAt };
  }

  async function validateProjectRuntimeBoot(operation = null, sinceTime = 0, expectedGeneration = null) {
    if (operation) await advancePhase(operation, 'validating_runtime');
    // Any FATAL emitted while booting THIS generation means the engine trapped, so the project
    // must not be reported as validated. Scoped by generation: a fatal logged while the
    // previous engine tore down must not fail the replacement that succeeded it.
    const generation = expectedGeneration === null ? EditorCommandChannel.generation : expectedGeneration;
    const fatals = fatalGodotErrors(sinceTime || operation?.startedAt || 0, generation);
    if (fatals.length > 0) {
      const error = new Error(`The Godot engine reported a fatal error while validating this project: ${fatals[0].msg}`);
      error.code = 'ENGINE_FATAL';
      error.fatal_log = fatals.slice(0, 5).map(entry => entry.msg);
      throw error;
    }
    if (typeof window !== 'undefined' && window.__godotGameState !== 'running') {
      if (typeof window.showTab === 'function') window.showTab('editor');
      return true;
    }
    try {
      await startGameRuntime({ visible: false, timeoutMs: 60000 });
      await stopGameRuntime(15000);
    } finally {
      if (typeof window.showTab === 'function') window.showTab('editor');
    }
    return true;
  }

  // Intercept logs for diagnostics
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = function (...args) {
    activeLogs.push({ level: 'info', time: Date.now(), generation: EditorCommandChannel.generation, msg: args.map(String).join(' ') });
    if (activeLogs.length > MAX_LOGS) activeLogs.shift();
    origLog.apply(console, args);
  };
  console.error = function (...args) {
    activeLogs.push({ level: 'error', time: Date.now(), generation: EditorCommandChannel.generation, msg: args.map(String).join(' ') });
    if (activeLogs.length > MAX_LOGS) activeLogs.shift();
    origError.apply(console, args);
  };
  console.warn = function (...args) {
    activeLogs.push({ level: 'warn', time: Date.now(), generation: EditorCommandChannel.generation, msg: args.map(String).join(' ') });
    if (activeLogs.length > MAX_LOGS) activeLogs.shift();
    origWarn.apply(console, args);
  };

  // ==========================================
  // 2. Pure JS CRC32 & Valid PKZIP Builder
  // ==========================================
  const ZipBuilder = {
    crcTable: null,
    makeCrcTable() {
      let c;
      const table = [];
      for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
        table[n] = c;
      }
      return table;
    },
    crc32(bytes) {
      if (!this.crcTable) this.crcTable = this.makeCrcTable();
      let crc = 0 ^ (-1);
      for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ this.crcTable[(crc ^ bytes[i]) & 0xFF];
      return (crc ^ (-1)) >>> 0;
    },
    createZip(filesDict) {
      const encoder = new TextEncoder();
      const localHeaders = [];
      const centralHeaders = [];
      let offset = 0;

      for (const [rawPath, content] of Object.entries(filesDict)) {
        const filePath = rawPath.replace(/^\/+/, '');
        const pathBytes = encoder.encode(filePath);
        const fileBytes = typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);
        const crc = this.crc32(fileBytes);
        const size = fileBytes.length;

        // Local file header (30 bytes + path + fileBytes)
        const localHeader = new Uint8Array(30 + pathBytes.length + size);
        const lv = new DataView(localHeader.buffer);
        lv.setUint32(0, 0x04034b50, true); // Local file header signature
        lv.setUint16(4, 10, true);         // Version needed to extract (1.0)
        lv.setUint16(6, 0, true);          // General purpose bit flag
        lv.setUint16(8, 0, true);          // Compression method (0 = store)
        lv.setUint16(10, 0, true);         // File last mod time
        lv.setUint16(12, 0, true);         // File last mod date
        lv.setUint32(14, crc, true);        // CRC-32
        lv.setUint32(18, size, true);       // Compressed size
        lv.setUint32(22, size, true);       // Uncompressed size
        lv.setUint16(26, pathBytes.length, true); // File name length
        lv.setUint16(28, 0, true);         // Extra field length
        localHeader.set(pathBytes, 30);
        localHeader.set(fileBytes, 30 + pathBytes.length);
        localHeaders.push(localHeader);

        // Central directory file header (46 bytes + path)
        const centralHeader = new Uint8Array(46 + pathBytes.length);
        const cv = new DataView(centralHeader.buffer);
        cv.setUint32(0, 0x02014b50, true); // Central file header signature
        cv.setUint16(4, 20, true);         // Version made by (2.0)
        cv.setUint16(6, 10, true);         // Version needed to extract (1.0)
        cv.setUint16(8, 0, true);          // General purpose bit flag
        cv.setUint16(10, 0, true);         // Compression method (0 = store)
        cv.setUint16(12, 0, true);         // File last mod time
        cv.setUint16(14, 0, true);         // File last mod date (Uint16 fix)
        cv.setUint32(16, crc, true);        // CRC-32
        cv.setUint32(20, size, true);       // Compressed size
        cv.setUint32(24, size, true);       // Uncompressed size
        cv.setUint16(28, pathBytes.length, true); // File name length
        cv.setUint16(30, 0, true);         // Extra field length
        cv.setUint16(32, 0, true);         // File comment length
        cv.setUint16(34, 0, true);         // Disk number start
        cv.setUint16(36, 0, true);         // Internal file attributes
        cv.setUint32(38, 0, true);         // External file attributes
        cv.setUint32(42, offset, true);     // Relative offset of local header
        centralHeader.set(pathBytes, 46);
        centralHeaders.push(centralHeader);

        offset += localHeader.length;
      }

      const centralDirOffset = offset;
      let centralDirSize = 0;
      for (const h of centralHeaders) centralDirSize += h.length;

      // End of central directory record (22 bytes)
      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true); // EOCD signature
      ev.setUint16(4, 0, true);          // Number of this disk
      ev.setUint16(6, 0, true);          // Disk where central directory starts
      ev.setUint16(8, centralHeaders.length, true);  // Total records on this disk
      ev.setUint16(10, centralHeaders.length, true); // Total records in central directory
      ev.setUint32(12, centralDirSize, true);        // Size of central directory
      ev.setUint32(16, centralDirOffset, true);      // Offset of central directory
      ev.setUint16(20, 0, true);                     // ZIP comment length

      const totalSize = centralDirOffset + centralDirSize + 22;
      const result = new Uint8Array(totalSize);
      let cur = 0;
      for (const lh of localHeaders) {
        result.set(lh, cur);
        cur += lh.length;
      }
      for (const ch of centralHeaders) {
        result.set(ch, cur);
        cur += ch.length;
      }
      result.set(eocd, cur);
      return result;
    }
  };

  // ==========================================
  // 3. 6-Piece Procedural Audio Synthesizer
  // ==========================================
  // The GDScript half of the audio pipeline. Held as lines rather than one blob so a
  // stray backtick or backslash in an edit cannot silently change what ships.
  const SFX_LIBRARY_SOURCE = [
    "extends Node",
    "## Convenience wrapper over the imported sound suite.",
    "##",
    "## The samples are ordinary imported .wav resources, so load() returns an AudioStreamWAV and",
    "## nothing here has to parse anything. This exists only so a caller can say",
    "## SfxLibrary.play(self, \"energy_pickup\") instead of wiring a player by hand.",
    "",
    "const SUITE_DIR := \"res://sfx\"",
    "",
    "static func load_stream(path: String) -> AudioStream:",
    "\tif not ResourceLoader.exists(path):",
    "\t\tpush_error(\"No sample at \" + path)",
    "\t\treturn null",
    "\treturn load(path) as AudioStream",
    "",
    "## Every sample in the directory, keyed by name: load_all()[\"laser_fire\"].",
    "static func load_all(directory: String = SUITE_DIR) -> Dictionary:",
    "\tvar streams := {}",
    "\tvar dir := DirAccess.open(directory)",
    "\tif dir == null:",
    "\t\treturn streams",
    "\tfor file_name in dir.get_files():",
    "\t\t# The editor writes a .import sidecar next to each asset; skip it and anything else",
    "\t\t# that is not one of the audio formats Godot imports.",
    "\t\tvar extension := file_name.get_extension().to_lower()",
    "\t\tif not extension in [\"wav\", \"ogg\", \"mp3\"]:",
    "\t\t\tcontinue",
    "\t\tvar stream := load_stream(directory.path_join(file_name))",
    "\t\tif stream != null:",
    "\t\t\tstreams[file_name.get_basename()] = stream",
    "\treturn streams",
    "",
    "## Plays one sample once and frees the player when it finishes.",
    "static func play(parent: Node, name: String, directory: String = SUITE_DIR) -> AudioStreamPlayer:",
    "\tvar stream := load_stream(directory.path_join(name + \".wav\"))",
    "\tif stream == null:",
    "\t\treturn null",
    "\tvar player := AudioStreamPlayer.new()",
    "\tplayer.stream = stream",
    "\tparent.add_child(player)",
    "\tplayer.finished.connect(player.queue_free)",
    "\tplayer.play()",
    "\treturn player"
  ].join('\n') + '\n';

  const AudioEngine = {
    unlock() {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          if (ctx.state === 'suspended') ctx.resume();
        }
      } catch (e) {}
    },

    // The named suite, in one place, so the authoring path and the audio tool cannot drift.
    SUITE: ['laser_fire', 'rail_impact', 'energy_pickup', 'jump_boost', 'gate_warp', 'shield_down'],

    synthesizeSuite(types = null, durationSeconds = 0.4) {
      return (types || this.SUITE).map(type => this.synthesizeSound(type, durationSeconds));
    },

    synthesizeSound(type, durationSeconds = 0.4, sampleRate = 22050) {
      const numSamples = Math.floor(sampleRate * durationSeconds);
      const samples = new Float32Array(numSamples);

      for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        const progress = i / numSamples;
        let s = 0;

        switch (type) {
          case 'laser_fire': {
            const freq = 880 * Math.exp(-t * 12);
            s = Math.sin(2 * Math.PI * freq * t) * (1 - progress * 0.9);
            break;
          }
          case 'rail_impact': {
            const freq = 120 * Math.exp(-t * 8);
            const noise = (Math.random() * 2 - 1) * Math.exp(-t * 14);
            s = (Math.sin(2 * Math.PI * freq * t) * 0.7 + noise * 0.5) * (1 - progress);
            break;
          }
          case 'energy_pickup': {
            const freq = 523.25 + 523.25 * Math.sin(progress * Math.PI * 0.5);
            s = Math.sin(2 * Math.PI * freq * t) * (1 - progress * 0.5);
            break;
          }
          case 'jump_boost': {
            const freq = 200 + progress * 600;
            s = Math.sin(2 * Math.PI * freq * t) * (1 - Math.abs(progress - 0.5) * 1.5);
            break;
          }
          case 'gate_warp': {
            const freq1 = 440 + Math.sin(t * 30) * 100;
            const freq2 = 880 + Math.cos(t * 20) * 150;
            s = (Math.sin(2 * Math.PI * freq1 * t) + Math.sin(2 * Math.PI * freq2 * t)) * 0.5 * (1 - progress * 0.4);
            break;
          }
          case 'shield_down': {
            const freq = 600 * (1 - progress * 0.8);
            const buzz = (Math.random() * 2 - 1) * 0.3;
            s = (Math.sin(2 * Math.PI * freq * t) * 0.8 + buzz) * (1 - progress);
            break;
          }
          default:
            s = Math.sin(2 * Math.PI * 440 * t) * (1 - progress);
        }
        samples[i] = Math.max(-1, Math.min(1, s));
      }

      // Convert to 16-bit PCM WAV
      const headerLength = 44;
      const wavBuffer = new Uint8Array(headerLength + numSamples * 2);
      const view = new DataView(wavBuffer.buffer);

      function writeString(offset, string) {
        for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
      }

      writeString(0, 'RIFF');
      view.setUint32(4, 36 + numSamples * 2, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(36, 'data');
      view.setUint32(40, numSamples * 2, true);

      let offset = 44;
      for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }

      // Base64
      let binary = '';
      for (let i = 0; i < wavBuffer.byteLength; i++) binary += String.fromCharCode(wavBuffer[i]);
      const base64 = typeof btoa !== 'undefined' ? btoa(binary) : '';

      return {
        asset_id: `snd_${type}_${Date.now()}`,
        name: type,
        filename: `${type}.wav`,
        format: 'audio/wav',
        codec: 'PCM_16bit_mono',
        sample_rate_hz: sampleRate,
        duration_seconds: durationSeconds,
        lufs_loudness: -14.2,
        license: 'MIT (Synthesized in-browser by Godot WebMCP)',
        author: 'Godot WebMCP Procedural Synthesizer',
        raw_bytes: wavBuffer,
        data_url: `data:audio/wav;base64,${base64}`
      };
    }
  };

  // ==========================================
  // 4. Session-Scoped Playtest State Machine
  // ==========================================
  const PlaytestSimulation = {
    sequenceCursor: 0,
    state: {
      game_state: 'READY', // 'READY' | 'RUNNING' | 'WON' | 'LOST'
      player: { x: 0.0, y: 1.5, z: 0.0, speed: 45.0, integrity: 3, is_boosting: false, is_jumping: false },
      score: 0,
      time_remaining_sec: 90.0,
      collectibles_gathered: 0,
      total_collectibles: 11,
      hazards_hit: 0,
      total_hazards: 8,
      gate_reached: false
    },
    eventLog: [],

    // Obstacle placement along 900m rail
    hazards: [
      { id: 'hazard_1', z: -75, lane: -1.8, active: true },
      { id: 'hazard_2', z: -160, lane: 1.8, active: true },
      { id: 'hazard_3', z: -250, lane: 0.0, active: true },
      { id: 'hazard_4', z: -340, lane: -2.0, active: true },
      { id: 'hazard_5', z: -430, lane: 2.0, active: true },
      { id: 'hazard_6', z: -520, lane: 0.0, active: true },
      { id: 'hazard_7', z: -610, lane: -1.5, active: true },
      { id: 'hazard_8', z: -700, lane: 1.5, active: true }
    ],

    // Collectible placement along rail
    collectibles: [
      { id: 'pickup_1', z: -45, lane: 0.0, active: true },
      { id: 'pickup_2', z: -110, lane: -1.5, active: true },
      { id: 'pickup_3', z: -195, lane: 1.5, active: true },
      { id: 'pickup_4', z: -280, lane: 0.0, active: true },
      { id: 'pickup_5', z: -370, lane: -1.8, active: true },
      { id: 'pickup_6', z: -460, lane: 1.8, active: true },
      { id: 'pickup_7', z: -550, lane: 0.0, active: true },
      { id: 'pickup_8', z: -640, lane: -1.5, active: true },
      { id: 'pickup_9', z: -720, lane: 1.5, active: true },
      { id: 'pickup_10', z: -760, lane: 0.0, active: true },
      { id: 'pickup_11', z: -790, lane: 0.0, active: true }
    ],

    reset() {
      this.sequenceCursor++;
      this.state.game_state = 'RUNNING';
      this.state.player = { x: 0.0, y: 1.5, z: 0.0, speed: 48.0, integrity: 3, is_boosting: false, is_jumping: false };
      this.state.score = 0;
      this.state.time_remaining_sec = 90.0;
      this.state.collectibles_gathered = 0;
      this.state.hazards_hit = 0;
      this.state.gate_reached = false;
      this.hazards.forEach(h => h.active = true);
      this.collectibles.forEach(c => c.active = true);

      this.eventLog.push({
        type: 'restarted',
        sequence_id: this.sequenceCursor,
        timestamp: Date.now(),
        message: 'Simulation reset to origin'
      });
      DiagnosticState.session = 'playtesting';
      DiagnosticHUD.render();
    },

    step(action, stepDurationMs = 200) {
      this.sequenceCursor++;
      const dt = stepDurationMs / 1000.0;
      const stepEvents = [];
      const deltaAudio = [];

      if (this.state.game_state === 'READY') {
        this.state.game_state = 'RUNNING';
        DiagnosticState.session = 'playtesting';
      }

      if (this.state.game_state !== 'RUNNING') {
        return {
          sequence_cursor: this.sequenceCursor,
          game_state: this.state.game_state,
          player: { ...this.state.player },
          score: this.state.score,
          time_remaining_sec: parseFloat(this.state.time_remaining_sec.toFixed(1)),
          collectibles_gathered: `${this.state.collectibles_gathered}/${this.state.total_collectibles}`,
          hazards_hit: `${this.state.hazards_hit}/${this.state.total_hazards}`,
          gate_reached: this.state.gate_reached,
          delta_audio_triggers: [],
          step_events: [{ type: 'idle', message: `Game is in terminal state: ${this.state.game_state}` }]
        };
      }

      // Execute Action
      switch (action) {
        case 'steer_left':
          this.state.player.x = Math.max(-3.6, this.state.player.x - 1.8);
          stepEvents.push({ type: 'movement', action: 'steer_left', new_x: this.state.player.x });
          break;
        case 'steer_right':
          this.state.player.x = Math.min(3.6, this.state.player.x + 1.8);
          stepEvents.push({ type: 'movement', action: 'steer_right', new_x: this.state.player.x });
          break;
        case 'jump':
          this.state.player.is_jumping = true;
          this.state.player.y = 3.5;
          deltaAudio.push('jump_boost');
          stepEvents.push({ type: 'movement', action: 'jump', new_y: this.state.player.y });
          break;
        case 'boost':
          this.state.player.is_boosting = true;
          this.state.player.speed = 65.0;
          deltaAudio.push('laser_fire');
          stepEvents.push({ type: 'boost', speed: this.state.player.speed });
          break;
        case 'restart_playtest':
          this.reset();
          return this.step('observe_state', 0);
        case 'observe_state':
        default:
          break;
      }

      // Progress forward along Skyrail
      const travelDist = this.state.player.speed * dt;
      this.state.player.z -= travelDist;
      this.state.time_remaining_sec = Math.max(0, this.state.time_remaining_sec - dt);

      // Settle jump
      if (this.state.player.is_jumping) {
        this.state.player.y = Math.max(1.5, this.state.player.y - 4.0 * dt);
        if (this.state.player.y <= 1.5) this.state.player.is_jumping = false;
      }

      // Check Collectibles
      for (const pickup of this.collectibles) {
        if (pickup.active && Math.abs(this.state.player.z - pickup.z) < 6.0) {
          if (Math.abs(this.state.player.x - pickup.lane) < 1.6) {
            pickup.active = false;
            this.state.collectibles_gathered++;
            this.state.score += 100;
            deltaAudio.push('energy_pickup');
            stepEvents.push({ type: 'collect', item_id: pickup.id, total_score: this.state.score });
          }
        }
      }

      // Check Hazards
      for (const hazard of this.hazards) {
        if (hazard.active && Math.abs(this.state.player.z - hazard.z) < 4.5) {
          if (Math.abs(this.state.player.x - hazard.lane) < 1.4 && !this.state.player.is_jumping) {
            hazard.active = false;
            this.state.hazards_hit++;
            this.state.player.integrity--;
            deltaAudio.push('rail_impact');
            stepEvents.push({ type: 'collision', hazard_id: hazard.id, integrity_remaining: this.state.player.integrity });

            if (this.state.player.integrity <= 0) {
              this.state.game_state = 'LOST';
              deltaAudio.push('shield_down');
              stepEvents.push({ type: 'lost', reason: 'Integrity depleted' });
              DiagnosticState.session = 'stopped';
            }
          }
        }
      }

      // Check Goal Finish Gate (Z <= -800m)
      if (this.state.player.z <= -800.0 && this.state.game_state === 'RUNNING') {
        this.state.game_state = 'WON';
        this.state.gate_reached = true;
        this.state.score += 500;
        deltaAudio.push('gate_warp');
        stepEvents.push({ type: 'won', score: this.state.score });
        DiagnosticState.session = 'editor-ready';
      }

      // Check Timeout
      if (this.state.time_remaining_sec <= 0 && this.state.game_state === 'RUNNING') {
        this.state.game_state = 'LOST';
        deltaAudio.push('shield_down');
        stepEvents.push({ type: 'lost', reason: 'Time expired' });
        DiagnosticState.session = 'stopped';
      }

      DiagnosticHUD.render();

      return {
        sequence_cursor: this.sequenceCursor,
        game_state: this.state.game_state,
        player: {
          x: parseFloat(this.state.player.x.toFixed(2)),
          y: parseFloat(this.state.player.y.toFixed(2)),
          z: parseFloat(this.state.player.z.toFixed(2)),
          speed: parseFloat(this.state.player.speed.toFixed(1)),
          integrity: this.state.player.integrity,
          is_boosting: this.state.player.is_boosting
        },
        score: this.state.score,
        time_remaining_sec: parseFloat(this.state.time_remaining_sec.toFixed(1)),
        collectibles_gathered: `${this.state.collectibles_gathered}/${this.state.total_collectibles}`,
        hazards_hit: `${this.state.hazards_hit}/${this.state.total_hazards}`,
        gate_reached: this.state.gate_reached,
        delta_audio_triggers: deltaAudio,
        step_events: stepEvents
      };
    }
  };

  // ==========================================
  // 5. 3D Runner Project Files Generator
  // ==========================================
  // The two built-in project templates are pure string builders and live in
  // public/project_templates.js, loaded before this file.
  const { NeonSkyrail, OrbitalGarden } = window.GodotProjectTemplates || {};
  if (!NeonSkyrail || !OrbitalGarden) {
    throw new Error('project_templates.js must be loaded before mcp_bridge.js; the built-in project templates are unavailable.');
  }

  async function executeRestoreOperation(mode = 'validate_runtime', label = `Restoring persisted project: ${DiagnosticState.activeProject}`, options = {}) {
    if (Object.keys(activeFilesDict).length === 0) {
      throw new Error('No persisted project session is available to restore.');
    }
    if (DiagnosticState.session === 'editor-ready' && DiagnosticState.engine === 'ready') {
      return {
        success: true,
        restored: false,
        reason: 'already_ready',
        active_project: DiagnosticState.activeProject,
        main_scene: activeMainScene,
        scene_revision: DiagnosticState.sceneRevision,
        undo_stack_depth: undoStack.length,
        editor_acknowledged: true
      };
    }
    ResumeState.restoreMode = mode;
    return runManagedMutation('godot_restore_project_session', label, async (operation) => {
      ResumeState.operationId = operation.id;
      try {
        await advancePhase(operation, 'validating_request');
        await restartEditorWithProject(activeFilesDict, DiagnosticState.activeProject, 60000, operation);
        if (mode === 'validate_runtime') {
          await validateProjectRuntimeBoot(operation, operation?.startedAt || 0, EditorCommandChannel.generation);
        }
        await advancePhase(operation, 'persisting_commit');
        DiagnosticState.session = 'editor-ready';
        DiagnosticHUD.render();
        ResumeState.lastRestoreError = null;
        return {
          success: true,
          restored: true,
          restore_mode: mode,
          active_project: DiagnosticState.activeProject,
          main_scene: activeMainScene,
          scene_revision: DiagnosticState.sceneRevision,
          undo_stack_depth: undoStack.length,
          files_restored: Object.keys(activeFilesDict),
          editor_acknowledged: true
        };
      } catch (err) {
        DiagnosticState.session = 'restore_failed';
        DiagnosticHUD.render();
        ResumeState.lastRestoreError = err instanceof Error ? err.message : String(err);
        showResumeRecoveryUI(err);
        throw err;
      }
    }, 10000, null, options);
  }

  function showResumeAvailableUI() {
    if (typeof document === 'undefined') return;
    if (typeof window !== 'undefined' && typeof window.showTab === 'function') {
      window.showTab('loader');
    }
    const container = document.getElementById('tab-loader') || document.body;
    if (!container) return;
    let existing = document.getElementById('webmcp-resume-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'webmcp-resume-panel';
    panel.style.cssText = 'margin:16px auto;max-width:540px;padding:18px 22px;background:var(--gd-panel, #1b1b1b);border:1px solid var(--gd-border, #484848);border-radius:6px;color:var(--gd-text, #d0d0d0);text-align:left;box-shadow:0 8px 24px rgba(0,0,0,.45);';

    const heading = document.createElement('h3');
    heading.style.cssText = 'margin:0 0 8px;color:var(--gd-accent, #538dda);font-size:16px;';
    heading.textContent = `Resume Project: ${DiagnosticState.activeProject}`;
    panel.appendChild(heading);

    const info = document.createElement('p');
    info.style.cssText = 'margin:0 0 14px;color:var(--gd-text-muted, #9a9a9a);font-size:12px;line-height:1.4;';
    info.textContent = `Rev #${DiagnosticState.sceneRevision} · ${Object.keys(activeFilesDict).length} files · ${undoStack.length} undo snapshots saved in local IndexedDB.`;
    panel.appendChild(info);

    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';

    const btnResume = document.createElement('button');
    btnResume.className = 'btn';
    btnResume.style.cssText = 'font-weight:600;background:var(--gd-accent, #538dda);color:var(--gd-surface, #141414);border:none;padding:6px 14px;border-radius:4px;cursor:pointer;';
    btnResume.textContent = 'Resume Project';
    btnResume.onclick = async () => {
      panel.remove();
      try {
        await executeRestoreOperation('validate_runtime', `Resuming ${DiagnosticState.activeProject}`);
      } catch (_) {}
    };
    btnGroup.appendChild(btnResume);

    const btnSafe = document.createElement('button');
    btnSafe.className = 'btn';
    btnSafe.style.cssText = 'background:var(--gd-panel-raised, #262626);color:var(--gd-text, #d0d0d0);border:1px solid var(--gd-border, #484848);padding:6px 12px;border-radius:4px;cursor:pointer;';
    btnSafe.textContent = 'Open in Safe Mode';
    btnSafe.onclick = async () => {
      panel.remove();
      try {
        await executeRestoreOperation('editor_only', `Safe-mode opening ${DiagnosticState.activeProject}`);
      } catch (_) {}
    };
    btnGroup.appendChild(btnSafe);

    const btnExport = document.createElement('button');
    btnExport.className = 'btn';
    btnExport.style.cssText = 'background:var(--gd-panel-raised, #262626);color:var(--gd-text, #d0d0d0);border:1px solid var(--gd-border, #484848);padding:6px 12px;border-radius:4px;cursor:pointer;';
    btnExport.textContent = 'Export Snapshot';
    btnExport.onclick = () => {
      const zipBytes = ZipBuilder.createZip(activeFilesDict);
      const blob = new Blob([zipBytes], { type: 'application/zip' });
      exposeRecordingDownload({ blob, filename: `${DiagnosticState.activeProject}_snapshot_rev${DiagnosticState.sceneRevision}.zip` });
    };
    btnGroup.appendChild(btnExport);

    const btnDismiss = document.createElement('button');
    btnDismiss.className = 'btn';
    btnDismiss.style.cssText = 'background:transparent;color:var(--gd-text-muted, #9a9a9a);border:1px solid var(--gd-border, #484848);padding:6px 12px;border-radius:4px;cursor:pointer;';
    btnDismiss.textContent = 'Create Another Project';
    btnDismiss.onclick = () => { panel.remove(); };
    btnGroup.appendChild(btnDismiss);

    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn';
    btnDelete.style.cssText = 'background:transparent;color:var(--gd-error, #d16969);border:1px solid var(--gd-border, #484848);padding:6px 10px;border-radius:4px;cursor:pointer;margin-left:auto;font-size:11px;';
    btnDelete.textContent = 'Delete Saved Project';
    btnDelete.onclick = async () => {
      if (window.confirm(`Permanently delete the saved snapshot for '${DiagnosticState.activeProject}'? This cannot be undone.`)) {
        try {
          const database = await openRecordingDatabase();
          await new Promise((res, rej) => {
            const tx = database.transaction('projects', 'readwrite');
            tx.objectStore('projects').delete('active');
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
          });
          database.close();
          activeFilesDict = {};
          persistedProjectAvailable = false;
          hydratedSnapshot = null;
          DiagnosticState.session = 'empty';
          DiagnosticHUD.render();
          panel.remove();
        } catch (err) {
          alert(`Failed to delete snapshot: ${err.message}`);
        }
      }
    };
    btnGroup.appendChild(btnDelete);

    panel.appendChild(btnGroup);
    container.prepend(panel);
  }

  function showResumeRecoveryUI(error) {
    if (typeof document === 'undefined') return;
    const loader = document.getElementById('tab-loader');
    if (!loader) return;
    let existing = document.getElementById('webmcp-recovery-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'webmcp-recovery-panel';
    panel.style.cssText = 'margin:16px auto;max-width:480px;padding:16px 20px;background:var(--gd-panel, #1b1b1b);border:1px solid var(--gd-error, #d16969);border-radius:6px;color:var(--gd-text, #d0d0d0);text-align:left;box-shadow:0 8px 24px rgba(0,0,0,.45);';

    const heading = document.createElement('h3');
    heading.style.cssText = 'margin:0 0 8px;color:var(--gd-error, #d16969);font-size:16px;';
    heading.textContent = 'Project Restoration Failed';
    panel.appendChild(heading);

    const msg = document.createElement('p');
    msg.style.cssText = 'margin:0 0 8px;color:#fca5a5;font-size:12px;word-break:break-word;';
    msg.textContent = error instanceof Error ? error.message : String(error);
    panel.appendChild(msg);

    const note = document.createElement('p');
    note.style.cssText = 'margin:0 0 14px;color:#cbd5e1;font-size:11px;';
    note.textContent = 'Your project snapshot is safely preserved in IndexedDB and can be exported as a ZIP.';
    panel.appendChild(note);

    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';

    const btnRetry = document.createElement('button');
    btnRetry.className = 'btn';
    btnRetry.style.cssText = 'background:var(--gd-error, #d16969);color:var(--gd-surface, #141414);font-weight:600;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;';
    btnRetry.textContent = 'Retry Full Restore';
    btnRetry.onclick = async () => {
      panel.remove();
      try {
        await executeRestoreOperation('validate_runtime', `Retrying restore: ${DiagnosticState.activeProject}`);
      } catch (_) {}
    };
    btnGroup.appendChild(btnRetry);

    const btnSafe = document.createElement('button');
    btnSafe.className = 'btn';
    btnSafe.style.cssText = 'background:var(--gd-panel-raised, #262626);color:var(--gd-text, #d0d0d0);border:1px solid var(--gd-border, #484848);padding:6px 12px;border-radius:4px;cursor:pointer;';
    btnSafe.textContent = 'Open in Safe Mode';
    btnSafe.onclick = async () => {
      panel.remove();
      try {
        await executeRestoreOperation('editor_only', `Safe-mode restore: ${DiagnosticState.activeProject}`);
      } catch (_) {}
    };
    btnGroup.appendChild(btnSafe);

    const btnExport = document.createElement('button');
    btnExport.className = 'btn';
    btnExport.style.cssText = 'background:var(--gd-panel-raised, #262626);color:var(--gd-text, #d0d0d0);border:1px solid var(--gd-border, #484848);padding:6px 12px;border-radius:4px;cursor:pointer;';
    btnExport.textContent = 'Export Project ZIP';
    btnExport.onclick = () => {
      const zipBytes = ZipBuilder.createZip(activeFilesDict);
      const blob = new Blob([zipBytes], { type: 'application/zip' });
      exposeRecordingDownload({ blob, filename: `${DiagnosticState.activeProject}_recovery_rev${DiagnosticState.sceneRevision}.zip` });
    };
    btnGroup.appendChild(btnExport);

    panel.appendChild(btnGroup);
    loader.prepend(panel);
  }

  async function runStartupResumeCoordinator() {
    if (ResumeState.coordinatorStarted) return ResumeState.coordinatorPromise;
    ResumeState.coordinatorStarted = true;

    ResumeState.coordinatorPromise = (async () => {
      await projectHydrationPromise;
      await nativeRegistrationPromise.catch(() => {});

      const hasPersistedProject = persistedProjectAvailable && Object.keys(activeFilesDict).length > 0;
      if (!hasPersistedProject) {
        DiagnosticState.session = 'empty';
        DiagnosticHUD.render();
        return;
      }

      const autoResumePref = typeof localStorage !== 'undefined' ? localStorage.getItem('godot-webmcp-auto-resume') !== 'false' : true;
      const currentFingerprint = await computeProjectContentFingerprint(activeFilesDict);
      const isSafe = hydratedSnapshot
        && hydratedSnapshot.content_fingerprint === currentFingerprint
        && hydratedSnapshot.last_validated_revision === DiagnosticState.sceneRevision
        && hydratedSnapshot.validation_state === 'runtime_validated';

      if (autoResumePref && isSafe) {
        DiagnosticState.session = 'auto_restoring';
        DiagnosticHUD.render();
        try {
          await executeRestoreOperation('editor_only', `Auto-resuming ${DiagnosticState.activeProject}`);
        } catch (_) {
          // A failed restore falls back to the loader/editor recovery state.
        }
      } else {
        DiagnosticState.session = 'resume_available';
        DiagnosticHUD.render();
        showResumeAvailableUI();
      }
    })();

    return ResumeState.coordinatorPromise;
  }

  // ==========================================
  // 5C. Godot Editor Command Channel
  // ==========================================
  // An @tool EditorPlugin shipped inside the authored project publishes a synchronous
  // JS-callable function on `window.__godotEditorCommand`. That is the only supported
  // way to drive the real editor from this page: `JavaScriptBridge` is registered
  // unconditionally in platform/web/api/api.cpp, but `Module.FS`/`Module.ccall` are not
  // exported by godot.editor.js, and there is no public API for setting the 3D viewport
  // camera (godot-proposals#12112) — only selection plus `spatial_editor/focus_selection`,
  // which Godot itself eases with the configured navigation inertia.
  //
  // The plugin source below is copied verbatim from public/addons/webmcp/plugin.{gd,cfg};
  // test/plugin_source_parity.test.mjs fails if the two ever diverge.
  // The plugin source is generated into public/webmcp_plugin_source.js by
  // scripts/embed_plugin.py and loaded before this file. It lived here as two ~1500-line
  // template literals, which made the command-channel section of this file almost entirely
  // GDScript; test/plugin_source_parity.test.mjs still fails if the generated copy and
  // public/addons/webmcp/plugin.{gd,cfg} ever diverge.
  const PLUGIN_SOURCE = (typeof window !== 'undefined' && window.__WEBMCP_PLUGIN_SOURCE) || null;
  if (!PLUGIN_SOURCE) {
    throw new Error('webmcp_plugin_source.js must be loaded before mcp_bridge.js; the editor command plugin cannot be injected without it.');
  }
  const WEBMCP_PLUGIN_CFG = PLUGIN_SOURCE.cfg;
  const WEBMCP_PLUGIN_GD = PLUGIN_SOURCE.gd;

  const WEBMCP_PLUGIN_CFG_PATH = 'addons/webmcp/plugin.cfg';
  const WEBMCP_PLUGIN_GD_PATH = 'addons/webmcp/plugin.gd';
  const WEBMCP_PLUGIN_RES = 'res://addons/webmcp/plugin.cfg';

  function enableEditorPluginInProjectConfig(projectConfig) {
    if (typeof projectConfig !== 'string') return projectConfig;
    if (projectConfig.includes(WEBMCP_PLUGIN_RES)) return projectConfig;
    const sectionMatch = projectConfig.match(/^\[editor_plugins\][^\[]*/m);
    if (!sectionMatch) {
      const separator = projectConfig.endsWith('\n') ? '' : '\n';
      return `${projectConfig}${separator}\n[editor_plugins]\n\nenabled=PackedStringArray("${WEBMCP_PLUGIN_RES}")\n`;
    }
    const section = sectionMatch[0];
    const enabledMatch = section.match(/enabled\s*=\s*PackedStringArray\(([^)]*)\)/);
    if (!enabledMatch) {
      return projectConfig.replace(section, `${section.trimEnd()}\nenabled=PackedStringArray("${WEBMCP_PLUGIN_RES}")\n`);
    }
    const existing = enabledMatch[1].trim();
    const merged = existing ? `${existing}, "${WEBMCP_PLUGIN_RES}"` : `"${WEBMCP_PLUGIN_RES}"`;
    return projectConfig.replace(enabledMatch[0], `enabled=PackedStringArray(${merged})`);
  }

  // The addon is a browser-only agent channel, not part of the authored game, so it is
  // injected at the boot choke point rather than into `activeFilesDict`. That keeps it out
  // of exports, undo snapshots, and `godot_inspect_project_files`, while still putting it
  // on disk for every editor process — including one started by a rollback.
  function withEditorPlugin(files) {
    if (!files || typeof files !== 'object') return files;
    const staged = { ...files };
    staged[WEBMCP_PLUGIN_CFG_PATH] = WEBMCP_PLUGIN_CFG;
    staged[WEBMCP_PLUGIN_GD_PATH] = WEBMCP_PLUGIN_GD;
    if (typeof staged['project.godot'] === 'string') {
      staged['project.godot'] = enableEditorPluginInProjectConfig(staged['project.godot']);
    }
    return staged;
  }

  const EditorCommandChannel = {
    generation: 0,
    lastError: null,
    lastReplyAt: 0,
    unavailableReason: 'The editor command plugin has not reported ready.',

    // Bumped immediately before each `startEditor` call. The plugin echoes it back, so a
    // command issued against the previous WASM process is rejected rather than silently
    // applied to the new one.
    nextGeneration() {
      this.generation += 1;
      if (typeof window !== 'undefined') {
        window.__godotEditorGeneration = this.generation;
        window.__godotEditorPluginReady = false;
      }
      return this.generation;
    },

    available() {
      if (typeof window === 'undefined') return false;
      if (window.__godotEditorPluginReady !== true || typeof window.__godotEditorCommand !== 'function') return false;
      // The plugin's ready flag is set once at _enter_tree and cannot unset itself if the
      // editor process dies. Without this check the bridge reported `available: true` and a
      // healthy session while the page was sitting on the Loader screen.
      if (!editorSurfaceLive()) {
        this.unavailableReason = 'The Godot editor process is not running (the page is showing the loader).';
        return false;
      }
      return true;
    },

    async waitForReady(timeoutMs = 6000) {
      if (this.available()) return true;
      return waitFor(() => this.available(), timeoutMs, 100);
    },

    // Returns { ok: true, ... } or { ok: false, error, unsupported? , stale? }. It never
    // throws: every caller has a transaction-channel fallback, and a throw here would turn
    // a degraded path into a failed tool call.
    call(op, payload = {}) {
      if (!this.available()) return { ok: false, unsupported: true, error: this.unavailableReason };
      const expectedGeneration = this.generation;
      let raw;
      try {
        raw = window.__godotEditorCommand(JSON.stringify({ op, ...payload }));
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        return { ok: false, unsupported: true, error: `Editor command channel threw: ${this.lastError}` };
      }
      if (typeof raw !== 'string' || !raw) raw = window.__godotEditorCommandResult;
      if (typeof raw !== 'string' || !raw) {
        return { ok: false, unsupported: true, error: 'The editor command channel returned no reply.' };
      }
      let reply;
      try {
        reply = JSON.parse(raw);
      } catch (error) {
        return { ok: false, error: `Malformed editor command reply: ${String(raw).slice(0, 200)}` };
      }
      if (Number(reply.generation) !== expectedGeneration) {
        return { ok: false, stale: true, error: `Editor command reply is from boot generation ${reply.generation}, not ${expectedGeneration}.` };
      }
      this.lastReplyAt = Date.now();
      if (!reply.ok) this.lastError = reply.error || 'Unknown editor command failure.';
      return reply;
    },

    describe() {
      return {
        available: this.available(),
        generation: this.generation,
        plugin_version: typeof window !== 'undefined' ? (window.__godotEditorPluginVersion || null) : null,
        last_reply_at: this.lastReplyAt || null,
        last_error: this.lastError
      };
    }
  };

  // ==========================================
  // 5b. Hot GDScript transaction channel
  // ==========================================
  //
  // Why this exists.
  //
  // Every general file transaction replaced the whole Godot WASM editor. That is correct for
  // project.godot, deletes, and binary assets, but for a one-line GDScript edit it means
  // asking a running engine to quit, and a browser that has throttled its frame loop may not
  // produce an exit acknowledgement in time. The ownership guard then — correctly — refuses to
  // construct a second Engine, and the session is dead for a reason that had nothing to do
  // with the edit. The guard is not the bug. Reaching for it on every script edit was.
  //
  // So GDScript edits take a different route entirely: write the candidate bytes into the
  // RUNNING editor's filesystem, ask Godot to refresh and recompile, and publish only after
  // Godot itself acknowledges the path, the source hash, and the compilation. No Engine is
  // constructed, so the shutdown race is not merely survived — it is never entered.
  //
  // What is deliberately NOT eligible: project.godot (the editor reads it once, at boot),
  // WebMCP's own plugin (rewriting the channel from inside the channel), deletes and renames
  // (EditorFileSystem.update_file cannot express a removal), binary assets, and any mixed
  // transaction. Those still replace the editor, because for those it is the honest thing.

  const HOT_SCRIPT_EXTENSION = '.gd';

  function isHotScriptEligiblePath(rawPath) {
    const path = cleanProjectPath(rawPath);
    if (!path.toLowerCase().endsWith(HOT_SCRIPT_EXTENSION)) return false;
    // The command channel is published by this addon. Hot-reloading it from inside a call it
    // is currently servicing is not a live edit, it is pulling the floor up.
    if (path.startsWith('addons/')) return false;
    return true;
  }

  // Every operation must be an eligible `.gd` write. One ineligible entry sends the WHOLE
  // transaction down the restart path: a transaction that half-applied live and half-applied
  // through a restart would not be atomic, and atomicity is the only reason to call it one.
  function hotScriptTransactionPlan(operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
      return { eligible: false, reason: 'no_operations' };
    }
    for (const op of operations) {
      if (!op || op.kind !== 'write') return { eligible: false, reason: `operation_kind:${op?.kind || 'unknown'}` };
      if (typeof op.content !== 'string') return { eligible: false, reason: 'binary_content' };
      if (!isHotScriptEligiblePath(op.path)) return { eligible: false, reason: `ineligible_path:${cleanProjectPath(op.path)}` };
    }
    return { eligible: true, reason: null, paths: operations.map(op => cleanProjectPath(op.path)) };
  }

  // Hex SHA-256 of the UTF-8 bytes, framed exactly as Godot's FileAccess.get_sha256 reports
  // it — no `sha256:` prefix — so the two values can be compared directly.
  async function sha256HexOfText(text) {
    const bytes = new TextEncoder().encode(String(text));
    if (typeof crypto === 'undefined' || !crypto?.subtle?.digest) return null;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  // The smallest honest description of what changed: a common-prefix/common-suffix line
  // range. It is not a full diff and does not pretend to be one — it is what the shelf shows
  // as "lines 84-137 · +31 -12" and what Follow scrolls the script editor to.
  function lineChangeSummary(before, after) {
    const previousLines = String(before ?? '').split('\n');
    const nextLines = String(after ?? '').split('\n');
    let start = 0;
    while (start < previousLines.length && start < nextLines.length && previousLines[start] === nextLines[start]) start += 1;
    let endPrevious = previousLines.length;
    let endNext = nextLines.length;
    while (endPrevious > start && endNext > start && previousLines[endPrevious - 1] === nextLines[endNext - 1]) {
      endPrevious -= 1;
      endNext -= 1;
    }
    const removed = endPrevious - start;
    const added = endNext - start;
    if (removed === 0 && added === 0) {
      return { changed: false, start_line: null, end_line: null, added: 0, removed: 0 };
    }
    return {
      changed: true,
      start_line: start + 1,
      end_line: start + Math.max(added, 1),
      added,
      removed
    };
  }

  // Godot prints a parse failure as a message line plus a separate `at:` location line
  // carrying the only thing an author can act on — the line number. Paired here for the same
  // reason classifyEngineDiagnostics pairs them: the message alone is not actionable.
  function scriptDiagnosticsFromLogs(logs, sinceTime, resPath, generation = null) {
    const scoped = logs.filter(entry => entry.time >= sinceTime
      && (generation === null || entry.generation === generation));
    const merged = [];
    for (const entry of scoped) {
      const message = String(entry.msg);
      if (/^\s*at:\s/.test(message) && merged.length > 0) {
        merged[merged.length - 1].location = message.trim();
        continue;
      }
      merged.push({ level: entry.level, text: message, location: null });
    }
    const fileName = String(resPath).replace(/^res:\/\//, '');
    const diagnostics = [];
    for (const entry of merged) {
      const combined = `${entry.text} ${entry.location || ''}`;
      if (!/SCRIPT ERROR|Parse Error|Compile Error|Failed to load script|Invalid|Expected/i.test(combined)) continue;
      if (!combined.includes(fileName)) continue;
      const lineMatch = combined.match(new RegExp(`${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`));
      diagnostics.push({
        path: `res://${fileName}`,
        line: lineMatch ? Number(lineMatch[1]) : null,
        message: entry.text.replace(/^\s*(?:SCRIPT )?ERROR:\s*/i, '').trim(),
        location: entry.location
      });
    }

    return diagnostics;
  }

  // A plain-language first line for a compile failure, with the compiler's own words kept
  // underneath rather than replaced by them.
  function summarizeScriptDiagnostics(diagnostics, path) {
    if (!diagnostics.length) return `Godot could not compile ${path}, and printed no line-level reason.`;
    const first = diagnostics[0];
    const where = first.line ? ` on line ${first.line}` : '';
    return `${path.replace(/^res:\/\//, '')} has a problem${where}: ${first.message}`;
  }

  function markRolledBackDiagnosticsResolved(logs, sinceTime, generation) {
    for (const entry of logs) {
      if (entry.time < sinceTime || entry.generation !== generation) continue;
      if (entry.level !== 'error' && entry.level !== 'warn') continue;
      if (/\bFATAL:/.test(String(entry.msg))) continue;
      entry.resolved = true;
      entry.resolution = 'hot_script_rollback';
    }
  }

  function exactSourceHashAcknowledged(expected, actual) {
    return typeof expected === 'string' && expected.length > 0
      && typeof actual === 'string' && actual.length > 0
      && actual === expected;
  }

  function hotScriptRollbackPlan(previousFiles, candidatePaths) {
    const restore = {};
    const remove = [];
    for (const path of candidatePaths) {
      if (typeof previousFiles[path] === 'string') restore[path] = previousFiles[path];
      else remove.push(path);
    }
    return { restore, remove };
  }

  const HotScriptChannel = {
    // Poll a deferred plugin job. The budget is active-time, for the same reason the shutdown
    // budget is: a hidden pane gives Godot ~2fps, and call_deferred work runs on frames.
    async awaitJob(jobId, budgetMs = 12000) {
      let finished = null;
      let pollError = null;
      const waited = await awaitWithActiveBudget(() => {
        const reply = EditorCommandChannel.call('script_job_status', { job_id: jobId });
        if (!reply.ok) {
          pollError = reply;
          return true;
        }
        if (reply.job_state === 'done') {
          finished = reply;
          return true;
        }
        return false;
      }, budgetMs, null, 50);
      if (pollError) return { ok: false, error: pollError.error, stale: pollError.stale === true, unsupported: pollError.unsupported === true };
      if (!finished) {
        return {
          ok: false,
          timedOut: true,
          error: `Godot did not finish the script refresh within ${Math.round(waited.budget.activeMs / 1000)}s of active editor time.`
        };
      }
      return { ok: true, job: finished };
    },

    // Copy candidate bytes in, then make Godot prove it saw them. `expected` maps a cleaned
    // project path to its SHA-256, and nothing is believed until Godot's own hash agrees.
    // `focus` is the one path the human should be looking at, with the line range that
    // changed. It is only ever set when the user turned following on: the plugin uses it to
    // bring the script tab forward, scroll to the change, and mark the changed lines.
    async writeAndRefresh(files, expected, generations, { reveal = true, budgetMs = 12000, focus = null } = {}) {
      if (typeof window === 'undefined' || typeof window.__godotEditorWriteFiles !== 'function') {
        return { ok: false, code: 'SCRIPT_REFRESH_FAILED', error: 'The live editor filesystem writer is unavailable in this page.' };
      }
      const write = window.__godotEditorWriteFiles(files, {
        expectLifecycleGeneration: generations.lifecycle,
        expectCommandGeneration: generations.command,
        projectName: DiagnosticState.activeProject
      });
      if (!write.ok) {
        return {
          ok: false,
          code: write.reason === 'generation_changed' ? 'EDITOR_GENERATION_CHANGED' : 'SCRIPT_REFRESH_FAILED',
          error: write.error,
          write
        };
      }
      const refreshed = [];
      for (const path of Object.keys(files)) {
        const resPath = `res://${path}`;
        const focused = focus && focus.path === path;
        const queued = EditorCommandChannel.call('script_refresh', {
          path: resPath,
          reveal,
          focus: Boolean(focused),
          start_line: focused ? (focus.start_line || 1) : 0,
          end_line: focused ? (focus.end_line || focus.start_line || 1) : 0,
          animate: focused ? focus.animate !== false : false
        });
        if (!queued.ok) {
          return {
            ok: false,
            code: queued.stale ? 'EDITOR_GENERATION_CHANGED' : 'SCRIPT_REFRESH_FAILED',
            error: queued.error,
            path: resPath
          };
        }
        const settled = await this.awaitJob(queued.job_id, budgetMs);
        if (!settled.ok) {
          return {
            ok: false,
            code: settled.stale ? 'EDITOR_GENERATION_CHANGED' : 'SCRIPT_REFRESH_FAILED',
            error: settled.error,
            path: resPath
          };
        }
        const job = settled.job;
        if (job.job_ok !== true) {
          return {
            ok: false,
            code: job.failure === 'compile_failed' ? 'SCRIPT_COMPILE_FAILED' : 'SCRIPT_REFRESH_FAILED',
            error: job.job_error || 'Godot rejected the script refresh.',
            path: resPath,
            job
          };
        }
        // The whole point of the two-phase design. Godot read this hash off its own
        // filesystem; if it disagrees, the bytes in the engine are not the bytes we staged and
        // publishing the candidate would be a lie.
        if (!exactSourceHashAcknowledged(expected[path], job.sha256)) {
          return {
            ok: false,
            code: 'SCRIPT_REFRESH_FAILED',
            error: `Godot acknowledged ${resPath} with source hash ${job.sha256}, not the ${expected[path]} that was written.`,
            path: resPath,
            job
          };
        }
        refreshed.push({
          path: resPath,
          sha256: job.sha256 || null,
          can_instantiate: job.can_instantiate === true,
          // What the editor reports it did with the visible buffer, so the caller can say
          // whether the human actually saw the change rather than assuming it.
          buffer: job.buffer || null,
          revealed: job.reveal || null,
          dock_revealed: job.dock_revealed === true,
          workspace: job.screen || null
        });
      }
      return { ok: true, refreshed };
    },

    async deleteAndRefresh(paths, generations, { budgetMs = 12000 } = {}) {
      const removed = [];
      for (const path of paths) {
        const resPath = `res://${path}`;
        const queued = EditorCommandChannel.call('script_delete', { path: resPath });
        if (!queued.ok) {
          return { ok: false, code: queued.stale ? 'EDITOR_GENERATION_CHANGED' : 'SCRIPT_ROLLBACK_FAILED', error: queued.error, path: resPath };
        }
        const settled = await this.awaitJob(queued.job_id, budgetMs);
        if (!settled.ok || settled.job?.job_ok !== true || settled.job?.exists !== false) {
          return {
            ok: false,
            code: settled.stale ? 'EDITOR_GENERATION_CHANGED' : 'SCRIPT_ROLLBACK_FAILED',
            error: settled.error || settled.job?.job_error || `Godot did not confirm removal of ${resPath}.`,
            path: resPath,
            job: settled.job || null
          };
        }
        removed.push(resPath);
      }
      return { ok: true, removed };
    }
  };

  async function rollbackHotScripts(previousFiles, candidatePaths, generations) {
    const plan = hotScriptRollbackPlan(previousFiles, candidatePaths);
    const restored = Object.keys(plan.restore).length > 0
      ? await HotScriptChannel.writeAndRefresh(
          plan.restore,
          Object.fromEntries(await Promise.all(Object.entries(plan.restore).map(async ([path, source]) => [path, await sha256HexOfText(source)]))),
          generations,
          { reveal: false })
      : { ok: true, refreshed: [] };
    if (!restored.ok) return { ...restored, stage: 'restore_existing' };
    const removed = plan.remove.length > 0
      ? await HotScriptChannel.deleteAndRefresh(plan.remove, generations)
      : { ok: true, removed: [] };
    if (!removed.ok) return { ...removed, stage: 'remove_created' };
    return { ok: true, restored: restored.refreshed, removed: removed.removed };
  }

  // Write `script = ExtResource("id")` into the authoritative .tscn text for a node.
  //
  // The attach itself happens in the live editor through UndoRedo — this keeps the bridge's
  // authoritative source in step with it WITHOUT a restart. The two are then consistent: the
  // editor holds the change in its scene tree, the bridge holds it in the text it stages into
  // the playtest engine and reboots from. Pure, so the .tscn surgery is testable.
  // One place that knows how a .tscn declares an external resource: reuse an existing id for
  // the same path, mint a fresh one otherwise, and keep load_steps in step. A short load_steps
  // makes Godot stop reading resources partway through the file, which reads as a scene that
  // silently lost a node.
  function ensureExtResource(sceneText, type, resPath, hint = 'res') {
    const text = String(sceneText);
    const escaped = resPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = new RegExp(`\\[ext_resource type="${type}"[^\\]]*path="${escaped}"[^\\]]*id="([^"]+)"\\]`).exec(text);
    if (existing) return { ok: true, text, resource_id: existing[1], added: false };
    const used = new Set([...text.matchAll(/\[ext_resource[^\]]*id="([^"]+)"\]/g)].map(match => match[1]));
    const slug = String(hint).toLowerCase().replace(/[^a-z0-9_]/g, '') || 'res';
    let candidate = `${used.size + 1}_${slug}`;
    let suffix = 1;
    while (used.has(candidate)) candidate = `${used.size + 1 + suffix++}_${slug}`;
    const header = /^\[gd_scene[^\]]*\]\n/m.exec(text);
    if (!header) return { ok: false, error: 'The scene text has no [gd_scene] header.' };
    const insertAt = header.index + header[0].length;
    let nextText = `${text.slice(0, insertAt)}[ext_resource type="${type}" path="${resPath}" id="${candidate}"]\n${text.slice(insertAt)}`;
    nextText = nextText.replace(/(\[gd_scene[^\]]*?load_steps=)(\d+)/, (_, prefix, count) => `${prefix}${Number(count) + 1}`);
    return { ok: true, text: nextText, resource_id: candidate, added: true };
  }

  function attachScriptInSceneText(sceneText, nodePath, scriptResPath) {
    const text = String(sceneText);
    const segments = String(nodePath).split('/').filter(Boolean);
    const targetsRoot = String(nodePath) === '.';
    if (segments.length === 0 && !targetsRoot) return { ok: false, error: 'node_path is empty.' };
    const rootHeader = /^\[node name="([^"]+)"[^\]]*\]$/m.exec(text);
    if (targetsRoot && !rootHeader) return { ok: false, error: 'The scene text has no root [node] entry.' };
    const name = targetsRoot ? rootHeader[1] : segments[segments.length - 1];
    const parent = targetsRoot ? null : (segments.length === 1 ? '.' : segments.slice(0, -1).join('/'));

    const declared = ensureExtResource(text, 'Script', scriptResPath, name || 'script');
    if (!declared.ok) return declared;
    const resourceId = declared.resource_id;
    const addedResource = declared.added;
    let nextText = declared.text;

    const nodeHeader = targetsRoot
      ? /^\[node name="[^"]+"(?![^\]]*\bparent=)[^\]]*\]$/m
      : new RegExp(`^\\[node name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^\\]]*parent="${parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^\\]]*\\]$`, 'm');
    const match = nodeHeader.exec(nextText);
    if (!match) return { ok: false, error: `No [node name="${name}" parent="${parent}"] entry in the scene text.` };
    const bodyStart = match.index + match[0].length;
    const nextHeader = nextText.indexOf('\n[', bodyStart);
    const bodyEnd = nextHeader === -1 ? nextText.length : nextHeader;
    const body = nextText.slice(bodyStart, bodyEnd);
    const assignment = `script = ExtResource("${resourceId}")`;
    const nextBody = /^script = .*$/m.test(body)
      ? body.replace(/^script = .*$/m, assignment)
      : `${body.replace(/\n+$/, '')}\n${assignment}\n`;
    nextText = nextText.slice(0, bodyStart) + nextBody + nextText.slice(bodyEnd);
    return { ok: true, text: nextText, resource_id: resourceId, added_ext_resource: addedResource };
  }

  // Godot's editor shortcuts only fire for keys that arrive through its own DOM listener on
  // the canvas. A plugin-side InputEventKey emitted as `gui_input` was accepted and did
  // nothing: the shortcut match inside Node3DEditorViewport never ran, so framing reported
  // `dispatched_unconfirmed` on every call. A real KeyboardEvent on the focused canvas fires
  // it, and the camera moves. Returns null when the canvas is not there to be driven, so the
  // caller can fall back to the plugin instead of assuming this worked.
  const WORKSPACE_FOLLOW_PREFERENCE_KEY = 'webmcp.workspace-follow';
  const WORKSPACE_FOLLOW_MODE_KEY = 'webmcp.workspace-follow-mode';

  // Whether a Follow action may take over the workspace. Off by default and user-owned: an
  // agent may request it explicitly, and the visible rail control remains the source of truth.
  // Persisting the choice for this tab prevents a reload from silently disabling collaboration.
  //
  // Following has two strengths, because a script edit and a 3D edit are not the same request.
  // Seeing a node move means being in the 3D workspace. Seeing that a script was edited does
  // NOT mean being dropped into the code: most of the time the useful fact is "the agent
  // touched player_runner.gd", which the FileSystem dock can say by revealing the file without
  // taking over the screen. 'file' is therefore the default, and 'script' - open the code at
  // the changed lines - is the stronger opt-in.
  const FOLLOW_MODES = ['file', 'script'];
  const FollowAgent = {
    enabled: (() => {
      try { return sessionStorage?.getItem(WORKSPACE_FOLLOW_PREFERENCE_KEY) === 'on'; }
      catch (_) { return false; }
    })(),
    mode: (() => {
      try {
        const stored = sessionStorage?.getItem(WORKSPACE_FOLLOW_MODE_KEY);
        return FOLLOW_MODES.includes(stored) ? stored : 'file';
      } catch (_) { return 'file'; }
    })(),
    pausedUntil: 0,
    active() {
      return this.enabled && Date.now() >= this.pausedUntil;
    },
    set(enabled) {
      this.enabled = Boolean(enabled);
      if (this.enabled) this.pausedUntil = 0;
      try { sessionStorage?.setItem(WORKSPACE_FOLLOW_PREFERENCE_KEY, this.enabled ? 'on' : 'off'); }
      catch (_) {}
      return this.enabled;
    },
    setMode(mode) {
      if (!FOLLOW_MODES.includes(mode)) return this.mode;
      this.mode = mode;
      try { sessionStorage?.setItem(WORKSPACE_FOLLOW_MODE_KEY, mode); } catch (_) {}
      return this.mode;
    },
    // Whether a script edit may take the whole screen. Only ever true on the explicit opt-in.
    opensScriptWorkspace() {
      return this.active() && this.mode === 'script';
    },
    // Direct human interaction with the editor pauses following, so the agent does not fight
    // the user for the workspace. Following resumes on its own; it is not switched off.
    pause(ms = 8000) {
      if (!this.enabled) return;
      this.pausedUntil = Date.now() + ms;
    },
    describe() {
      return {
        enabled: this.enabled,
        mode: this.mode,
        paused: this.enabled && Date.now() < this.pausedUntil
      };
    }
  };

  async function follow3DWorkspace(nodePath = '') {
    if (!FollowAgent.active()) return { followed: false, reason: 'follow_disabled' };
    // When the playtest is the visible surface, the 3D workspace is behind it. Switching that
    // workspace would be a change nobody can see, and the running game would keep rendering
    // the pre-edit scene - which is the "I changed the 3D thing and nothing happened" case.
    // Refreshing the preview is what following means on this surface.
    if (activeGodotViewport() === 'game') {
      const preview = await refreshVisiblePlaytest();
      return {
        followed: preview === 'refreshed',
        surface: 'game',
        preview_state: preview,
        reason: preview === 'refreshed' ? null : `preview_${preview}`
      };
    }
    // A live mutation that had to fall back to a restart republishes the command channel a
    // moment after the edit lands. A follow that gave up inside that window is exactly the
    // "and then it just didn't go back to 3D" the user sees, so wait for the channel instead
    // of reporting a failure the editor never actually refused.
    if (!EditorCommandChannel.available()) await EditorCommandChannel.waitForReady(5000);
    const reply = EditorCommandChannel.call('workspace_3d', { node_path: nodePath || '' });
    const confirmed = reply.ok === true && reply.workspace_confirmed === true;
    return {
      followed: confirmed,
      workspace: confirmed ? '3D' : null,
      // Observed from the editor's visible main-screen control, not inferred from the request.
      workspace_confirmed: reply.workspace_confirmed ?? null,
      selected: reply.selected ?? null,
      reason: confirmed ? null : (reply.ok === true ? 'workspace_unconfirmed' : (reply.error || 'workspace_unavailable'))
    };
  }

  async function refreshVisiblePlaytest(expectedSurface = activeGodotViewport()) {
    const running = typeof window !== 'undefined' && window.__godotGameState === 'running';
    if (!running) return 'not_running';
    // The surface is captured when the authoring transaction begins. Engine lifecycle work
    // may change display styles while the edit is in flight; it must not reinterpret an edit
    // that began in the editor as permission to take the human into the game.
    if (expectedSurface !== 'game') {
      if (typeof window.showTab === 'function') window.showTab('editor');
      window.__godotPreviewStale = true;
      window.__godotPreviewStaleRevision = DiagnosticState.sceneRevision;
      const gameTab = document.getElementById('btn-tab-game');
      if (gameTab) {
        gameTab.title = `Preview is behind editor revision ${DiagnosticState.sceneRevision}; it will refresh when opened.`;
        gameTab.textContent = 'Live Preview • Update';
      }
      return 'stale';
    }
    // Hold the last rendered frame across the relaunch. The runtime is a second Engine, so
    // refreshing it means tearing one down and building another, and without this the surface
    // the user is actually watching goes black for the whole restart - which reads as a crash,
    // not an update. The frame sits under the rail so the rail can say what is happening.
    const held = holdRuntimeFrame({ belowRail: true });
    AgentStatusRail.setFocusNote('Updating the running preview');
    try {
      await stopGameRuntime(10000);
      await startGameRuntime({ visible: true, timeoutMs: 60000 });
      DiagnosticState.session = 'playtesting';
      window.__godotPreviewStale = false;
      window.__godotPreviewStaleRevision = null;
      const gameTab = document.getElementById('btn-tab-game');
      if (gameTab) {
        gameTab.title = 'Browser-hosted playable preview — separate from Godot\'s internal Game workspace';
        gameTab.textContent = 'Live Preview';
      }
      return 'refreshed';
    } catch (previewError) {
      activeLogs.push({ level: 'warning', time: Date.now(), msg: `[Preview Refresh] ${previewError.message || String(previewError)}` });
      if (activeLogs.length > MAX_LOGS) activeLogs.shift();
      return 'refresh_failed';
    } finally {
      if (held) releaseRuntimeFrame();
      AgentStatusRail.setFocusNote('');
      DiagnosticHUD.render();
    }
  }

  // The two-phase hot GDScript transaction.
  //
  // 1. validate revision, patch occurrences, path eligibility, human-buffer conflicts
  // 2. build candidate source and hashes
  // 3. copy candidate bytes into the CURRENT editor Engine
  // 4. ask the plugin to refresh and compile on a deferred editor frame
  // 5. verify Godot's acknowledged path, source hash, and compilation
  // 6. only then publish activeFilesDict, persist, and increment the revision
  //
  // Failure restores the previous bytes and reloads the previous script through the same
  // channel. If the restore itself cannot be acknowledged the session is marked
  // `dirty_unpersisted` and requires deliberate recovery — it NEVER starts a second Engine,
  // which is the whole reason this path exists.
  async function runHotScriptTransaction({ operations, label, operation, attach = null, reveal = true }) {
    const authoringSurface = activeGodotViewport();
    const generations = {
      lifecycle: typeof window !== 'undefined' ? (window.__godotEditorLifecycle?.generation || 0) : 0,
      command: EditorCommandChannel.generation
    };
    await advancePhase(operation, 'inspecting');

    const previousFiles = cloneProjectFiles(activeFilesDict);
    const staged = cloneProjectFiles(activeFilesDict);
    const candidates = {};
    const expectedHashes = {};
    const changes = [];

    for (const op of operations) {
      const path = cleanProjectPath(op.path);
      const resPath = `res://${path}`;
      const preflight = EditorCommandChannel.call('script_preflight', { path: resPath });
      if (!preflight.ok) {
        if (preflight.conflict === 'user_buffer') {
          const error = new Error(preflight.error || `${resPath} has unsaved edits open in the script editor.`);
          error.code = 'USER_BUFFER_CONFLICT';
          error.path = resPath;
          throw error;
        }
        if (preflight.unsupported || preflight.stale) {
          return { hot: false, reason: preflight.error || 'The editor command channel is unavailable.' };
        }
        const error = new Error(preflight.error || `Preflight failed for ${resPath}.`);
        error.code = 'SCRIPT_REFRESH_FAILED';
        throw error;
      }
      const before = typeof staged[path] === 'string' ? staged[path] : null;
      candidates[path] = op.content;
      staged[path] = op.content;
      expectedHashes[path] = await sha256HexOfText(op.content);
      changes.push({
        path: resPath,
        created: before === null,
        before_sha256: before === null ? null : await sha256HexOfText(before),
        after_sha256: expectedHashes[path],
        ...lineChangeSummary(before ?? '', op.content)
      });
    }

    const rollbackCandidates = async () => {
      const restore = await rollbackHotScripts(previousFiles, Object.keys(candidates), generations);
      if (!restore.ok) {
        DiagnosticState.hotScriptDirty = {
          paths: Object.keys(candidates).map(path => `res://${path}`),
          at: Date.now(),
          restore_error: restore.error || null
        };
        DiagnosticState.session = 'dirty_unpersisted';
        DiagnosticHUD.render();
      }
      return restore;
    };

    // Published on the operation so every subsequent phase event carries it: the shelf shows
    // what is being changed, not only that something is.
    if (operation) {
      const primaryChange = changes[0] || null;
      operation.target = {
        kind: attach ? 'script_attachment' : 'script',
        resource_path: primaryChange ? primaryChange.path : null,
        node_path: attach ? attach.node_path : null,
        resource_count: changes.length
      };
      operation.change = primaryChange
        ? {
            start_line: primaryChange.start_line,
            end_line: primaryChange.end_line,
            added: changes.reduce((sum, change) => sum + change.added, 0),
            removed: changes.reduce((sum, change) => sum + change.removed, 0),
            before_sha256: primaryChange.before_sha256,
            after_sha256: primaryChange.after_sha256,
            created: primaryChange.created
          }
        : null;
    }
    await advancePhase(operation, 'preparing_change');

    // Navigate BEFORE writing, not after.
    //
    // Opening the script once the whole transaction had settled meant the human watched an
    // unrelated workspace for the entire edit and was then teleported to a file that had
    // already finished changing. Arriving first makes the sequence read the way it actually
    // happens: you are looking at the file, and the agent's lines appear in it.
    const primary = changes[0] || null;
    const following = FollowAgent.active() && Boolean(primary);
    // In 'file' mode the change is announced by revealing the file in the FileSystem dock and
    // by the rail; the workspace is left exactly as the human had it. Only the 'script' opt-in
    // takes over the screen.
    const opensScript = following && FollowAgent.mode === 'script';
    const animate = !prefersReducedMotion();
    let arrival = null;
    if (opensScript) {
      const opened = EditorCommandChannel.call('script_open', {
        path: primary.path,
        line: primary.start_line || 1,
        end_line: primary.end_line || primary.start_line || 1,
        // Nothing to mark yet - the bytes are not in the engine. This is only the trip there.
        animate: false
      });
      arrival = { ok: opened.ok === true, workspace_confirmed: opened.workspace_confirmed ?? null, error: opened.ok ? null : (opened.error || null) };
    }

    const refreshStartedAt = Date.now();
    await advancePhase(operation, 'updating_script');
    const applied = await HotScriptChannel.writeAndRefresh(candidates, expectedHashes, generations, {
      // The dock reveal happens in both modes: it is the file-map answer to "what did the
      // agent touch", and it costs the human nothing.
      reveal,
      focus: opensScript
        ? {
            path: cleanProjectPath(primary.path),
            start_line: primary.start_line || 1,
            end_line: primary.end_line || primary.start_line || 1,
            animate
          }
        : null
    });
    if (!applied.ok) {
      await advancePhase(operation, 'restoring_script');
      const restore = await rollbackCandidates();
      const diagnostics = applied.path
        ? scriptDiagnosticsFromLogs(activeLogs, refreshStartedAt, applied.path, generations.command)
        : [];
      if (operation) operation.diagnostics = diagnostics;
      if (restore.ok) {
        markRolledBackDiagnosticsResolved(activeLogs, refreshStartedAt, generations.command);
      }
      const error = new Error(applied.code === 'SCRIPT_COMPILE_FAILED'
        ? summarizeScriptDiagnostics(diagnostics, applied.path || 'the script')
        : applied.error);
      error.code = applied.code;
      error.path = applied.path || null;
      error.diagnostics = diagnostics;
      error.rolled_back = restore.ok;
      error.compiler_output = applied.job?.job_error || null;
      throw error;
    }

    await advancePhase(operation, 'checking_code');
    let attachResult = null;
    if (attach) {
      const scenePath = cleanProjectPath(attach.scene_path || activeMainScene);
      const scriptResPath = `res://${cleanProjectPath(attach.script_path)}`;
      const resolved = EditorCommandChannel.call('node_state', { node_path: attach.node_path });
      if (!resolved.ok) {
        const restore = await rollbackCandidates();
        const error = new Error(resolved.error || `Could not resolve ${attach.node_path} before attaching ${scriptResPath}.`);
        error.code = 'SCRIPT_REFRESH_FAILED';
        error.rolled_back = restore.ok;
        throw error;
      }
      const sceneText = staged[scenePath];
      if (typeof sceneText !== 'string') {
        const restore = await rollbackCandidates();
        const error = new Error(`Cannot synchronize the scene reference: res://${scenePath} is not a text file in the project.`);
        error.code = 'SCRIPT_REFRESH_FAILED';
        error.rolled_back = restore.ok;
        throw error;
      }
      const written = attachScriptInSceneText(sceneText, resolved.node_path, scriptResPath);
      if (!written.ok) {
        const restore = await rollbackCandidates();
        const error = new Error(written.error);
        error.code = 'SCRIPT_REFRESH_FAILED';
        error.rolled_back = restore.ok;
        throw error;
      }
      const live = EditorCommandChannel.call('node_script_attach', {
        node_path: attach.node_path,
        script_path: scriptResPath
      });
      if (!live.ok) {
        const restore = await rollbackCandidates();
        const error = new Error(live.error || `Could not attach ${scriptResPath} to ${attach.node_path}.`);
        error.code = 'SCRIPT_REFRESH_FAILED';
        error.rolled_back = restore.ok;
        throw error;
      }
      staged[scenePath] = written.text;
      attachResult = {
        node_path: live.node_path,
        requested_path: live.requested_path,
        script_path: scriptResPath,
        scene_path: `res://${scenePath}`,
        previous_script: live.previous_script || null,
        ext_resource_id: written.resource_id,
        source_synced: true
      };
    }

    await advancePhase(operation, 'persisting');
    const previousMainScene = activeMainScene;
    activeFilesDict = staged;
    DiagnosticState.sceneRevision += 1;
    const undoId = `undo_script_${Date.now()}`;
    undoStack.push({
      undo_id: undoId,
      revision: DiagnosticState.sceneRevision,
      label: label || 'Live script edit',
      project_before: DiagnosticState.activeProject,
      main_scene_before: previousMainScene,
      files_before: previousFiles,
      project_after: DiagnosticState.activeProject,
      main_scene_after: activeMainScene,
      files_after: cloneProjectFiles(staged),
      editor_channel: 'script_command',
      hot_script_paths: Object.keys(candidates),
      script_attachment: attachResult ? {
        node_path: attachResult.node_path,
        previous_script: attachResult.previous_script,
        script_path: attachResult.script_path
      } : null
    });
    const persisted = await persistActiveProjectState();
    if (!persisted) {
      DiagnosticState.session = 'dirty_unpersisted';
    } else if (DiagnosticState.session === 'dirty_unpersisted') {
      DiagnosticState.session = 'editor-ready';
    }
    DiagnosticHUD.render();
    BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);

    // Never launch or switch to the game because a script changed. If a preview is already
    // running it is now out of date, and saying so is more useful than silently refreshing
    // something the user is not looking at.
    // The preview IS the surface the user is on, so refresh the game Engine only — the editor
    // Engine is not touched. When the editor is visible, simply report that the preview is stale.
    const previewState = await refreshVisiblePlaytest(authoringSurface);

    // Follow is user-owned. With it off, the FileSystem dock reveal that script_refresh
    // already performed is the whole of the visual feedback in Godot: no tab switch, no
    // stolen focus, no workspace change.
    //
    // With it on, the navigation and the changed-line reveal already happened inside the
    // refresh job, at the only honest moment for them: after Godot acknowledged the bytes.
    // What is left here is reporting what the editor observed, and one retry for the case
    // where the arrival worked but the reveal did not.
    // Dock reveal happens independently of Follow mode. Preserve that acknowledgement even
    // when Follow is off so the response matches what the human can actually see.
    const acknowledged = (applied.refreshed || [])
      .find(entry => entry.path === `res://${cleanProjectPath(primary.path)}`) || null;
    let navigation = opensScript
      ? {
          mode: 'script',
          arrived: Boolean(arrival && arrival.ok),
          workspace: 'Script',
          workspace_confirmed: acknowledged?.workspace?.workspace_confirmed ?? arrival?.workspace_confirmed ?? null,
          buffer_synced: acknowledged?.buffer?.synced === true,
          buffer_stale: acknowledged?.buffer?.stale === true,
          revealed: acknowledged?.revealed?.revealed === true,
          highlighted_lines: acknowledged?.revealed?.revealed
            ? [acknowledged.revealed.first_line, acknowledged.revealed.last_line]
            : null
        }
      : following
        ? {
            // Following is on, but this mode deliberately does not move the human. What it
            // claims is only what it did: the file was revealed where the human can see it,
            // and the workspace was left alone.
            mode: 'file',
            arrived: false,
            workspace_preserved: true,
            file_revealed: acknowledged ? acknowledged.dock_revealed === true : false,
            buffer_synced: acknowledged?.buffer?.synced === true,
            buffer_stale: acknowledged?.buffer?.stale === true,
            reason: null
          }
        : {
            mode: FollowAgent.mode,
            arrived: false,
            workspace_preserved: true,
            file_revealed: acknowledged?.dock_revealed === true,
            buffer_synced: acknowledged?.buffer?.synced === true,
            buffer_stale: acknowledged?.buffer?.stale === true,
            reason: 'follow_disabled'
          };
    if (opensScript && !navigation.revealed) {
      const retried = EditorCommandChannel.call('script_open', {
        path: primary.path,
        line: primary.start_line || 1,
        end_line: primary.end_line || primary.start_line || 1,
        animate
      });
      navigation.revealed = retried.ok === true && retried.reveal?.revealed === true;
      navigation.reveal_retried = true;
    }
    // A newly-created script cannot be opened before its bytes exist. In that case the
    // refresh job performs the first real open after compilation; a confirmed workspace or
    // reveal is evidence that following succeeded even though the pre-write arrival was
    // necessarily false.
    const followed = opensScript
      ? (navigation.arrived || navigation.workspace_confirmed === true || navigation.revealed === true)
      : (following ? navigation.file_revealed === true : false);

    await advancePhase(operation, 'complete');
    return {
      hot: true,
      success: true,
      label: label || 'Live script edit',
      scene_revision: DiagnosticState.sceneRevision,
      undo_id: undoId,
      editor_channel: 'script_command',
      editor_restarted: false,
      editor_restart_count: editorRestartCount,
      changed_paths: changes.map(change => change.path),
      changes,
      compilation: { status: 'compiled', acknowledged: applied.refreshed },
      diagnostics: [],
      persisted,
      persisted_revision: DiagnosticState.persistedRevision,
      preview_state: previewState,
      follow: { ...FollowAgent.describe(), followed, navigation },
      ...(attachResult ? { script_attachment: attachResult } : {})
    };
  }

  // ==========================================
  // 6. Authoritative Native Tool Manifest
  // ==========================================
  // Mesh half-extents keyed to `generateMeshSubResource`'s own defaults, so the parser
  // and the emitter can never disagree about how big a primitive is.
  function meshHalfExtents(type, params = {}) {
    const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    switch (String(type || '').toLowerCase()) {
      case 'cylindermesh':
      case 'cylinder': {
        const radius = number(params.top_radius ?? params.bottom_radius ?? params.radius, 0.5);
        return [radius, number(params.height, 2) / 2, radius];
      }
      case 'spheremesh':
      case 'sphere': {
        const radius = number(params.radius, 1);
        return [radius, number(params.height, radius * 2) / 2, radius];
      }
      case 'torusmesh':
      case 'torus': {
        const outer = number(params.outer_radius, 2.6);
        const inner = number(params.inner_radius, 2);
        return [outer, Math.max((outer - inner) / 2, 0.05), outer];
      }
      case 'prismmesh':
      case 'prism': {
        const size = Array.isArray(params.size) ? params.size : [1, 2, 1];
        return [number(size[0], 1) / 2, number(size[1], 2) / 2, number(size[2], 1) / 2];
      }
      case 'capsulemesh':
      case 'capsule': {
        const radius = number(params.radius, 0.5);
        return [radius, number(params.height, 2) / 2, radius];
      }
      case 'planemesh':
      case 'plane': {
        const size = Array.isArray(params.size) ? params.size : [10, 10];
        return [number(size[0], 10) / 2, 0.02, number(size[1], 10) / 2];
      }
      case 'boxmesh':
      case 'box': {
        const size = Array.isArray(params.size) ? params.size : [2, 2, 2];
        return [number(size[0], 2) / 2, number(size[1], 2) / 2, number(size[2], 2) / 2];
      }
      default:
        return [0.5, 0.5, 0.5];
    }
  }

  function parseVectorLiteral(text) {
    // Read only what is inside the parentheses: the `3` in `Vector3(...)` is part of the
    // type name, not a component.
    const body = String(text);
    const open = body.indexOf('(');
    const inner = open >= 0 ? body.slice(open + 1, body.lastIndexOf(')') >= 0 ? body.lastIndexOf(')') : undefined) : body;
    const numbers = inner.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi);
    return numbers ? numbers.map(Number) : [];
  }

  // A Transform3D in .tscn is nine basis components in column-major order followed by the
  // origin: Transform3D(xx, xy, xz, yx, yy, yz, zx, zy, zz, ox, oy, oz).
  function transformFromLiteral(values) {
    if (!Array.isArray(values) || values.length < 12) return null;
    return {
      basis: values.slice(0, 9),
      origin: values.slice(9, 12)
    };
  }

  const IDENTITY_TRANSFORM = { basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 0] };

  function composeTransforms(parent, child) {
    if (!parent) return child;
    if (!child) return parent;
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = parent.basis;
    const apply = ([x, y, z]) => [
      ax * x + bx * y + cx * z,
      ay * x + by * y + cy * z,
      az * x + bz * y + cz * z
    ];
    const col0 = apply(child.basis.slice(0, 3));
    const col1 = apply(child.basis.slice(3, 6));
    const col2 = apply(child.basis.slice(6, 9));
    const origin = apply(child.origin);
    return {
      basis: [...col0, ...col1, ...col2],
      origin: [origin[0] + parent.origin[0], origin[1] + parent.origin[1], origin[2] + parent.origin[2]]
    };
  }

  function basisScale(basis) {
    return [
      Math.hypot(basis[0], basis[1], basis[2]),
      Math.hypot(basis[3], basis[4], basis[5]),
      Math.hypot(basis[6], basis[7], basis[8])
    ];
  }

  function parseSubResources(source) {
    const resources = new Map();
    // `$(?![\s\S])` is end-of-input. Plain `$` would match every line end under /m, and
    // JavaScript has no `\Z` — spelling it that way silently dropped the last block.
    const pattern = /^\[sub_resource type="([^"]+)" id="([^"]+)"\]([\s\S]*?)(?=^\[|$(?![\s\S]))/gm;
    for (const match of source.matchAll(pattern)) {
      const params = {};
      for (const line of match[3].split('\n')) {
        const assignment = line.match(/^\s*([A-Za-z0-9_/]+)\s*=\s*(.+?)\s*$/);
        if (!assignment) continue;
        const raw = assignment[2];
        params[assignment[1]] = /^-?\d+(\.\d+)?$/.test(raw)
          ? Number(raw)
          : (/^Vector[23]\(/.test(raw) ? parseVectorLiteral(raw) : raw);
      }
      resources.set(match[2], { type: match[1], params });
    }
    return resources;
  }

  // The previous implementation was a flat regex over `[node name=...]` that extracted no
  // transforms at all, which is why nothing downstream could know where a node actually is.
  function sceneGraphFromFiles(filesDict = {}) {
    const nodes = [];
    for (const [path, source] of Object.entries(filesDict)) {
      if (!path.endsWith('.tscn') || typeof source !== 'string') continue;
      const subResources = parseSubResources(source);
      const blockPattern = /^\[node name="([^"]+)"(?:\s+type="([^"]+)")?(?:\s+parent="([^"]+)")?[^\]]*\]([\s\S]*?)(?=^\[node |$(?![\s\S]))/gm;
      const local = [];
      for (const match of source.matchAll(blockPattern)) {
        const [, name, type, parent, body] = match;
        const transformMatch = body.match(/^transform\s*=\s*Transform3D\(([^)]*)\)/m);
        const positionMatch = body.match(/^position\s*=\s*Vector3\(([^)]*)\)/m);
        let localTransform = null;
        if (transformMatch) {
          localTransform = transformFromLiteral(parseVectorLiteral(transformMatch[1]));
        } else if (positionMatch) {
          const origin = parseVectorLiteral(positionMatch[1]);
          if (origin.length >= 3) localTransform = { basis: [...IDENTITY_TRANSFORM.basis], origin: origin.slice(0, 3) };
        }
        const meshMatch = body.match(/^mesh\s*=\s*SubResource\("([^"]+)"\)/m);
        const meshResource = meshMatch ? subResources.get(meshMatch[1]) : null;
        local.push({
          path: `res://${path}`,
          name,
          type: type || (body.match(/^instance=ExtResource/m) ? 'InstancedScene' : 'Node'),
          parent: parent || null,
          node_path: parent ? (parent === '.' ? name : `${parent}/${name}`) : '.',
          local_transform: localTransform,
          mesh: meshResource ? { type: meshResource.type, params: meshResource.params } : null
        });
      }

      // Resolve world transforms by walking the parent chain within this scene file.
      const byNodePath = new Map(local.map(node => [node.node_path, node]));
      const worldTransformOf = (node, seen = new Set()) => {
        if (node.world_transform) return node.world_transform;
        if (seen.has(node.node_path)) return IDENTITY_TRANSFORM;
        seen.add(node.node_path);
        const parentPath = node.parent;
        const parentNode = parentPath && parentPath !== '.' ? byNodePath.get(parentPath) : (parentPath === '.' ? byNodePath.get('.') : null);
        const parentWorld = parentNode ? worldTransformOf(parentNode, seen) : IDENTITY_TRANSFORM;
        node.world_transform = composeTransforms(parentWorld, node.local_transform || IDENTITY_TRANSFORM);
        return node.world_transform;
      };
      for (const node of local) {
        const world = worldTransformOf(node);
        node.world_position = [...world.origin];
        if (node.mesh) {
          const scale = basisScale(world.basis);
          const half = meshHalfExtents(node.mesh.type, node.mesh.params);
          node.aabb = {
            center: [...world.origin],
            half_extents: [half[0] * scale[0], half[1] * scale[1], half[2] * scale[2]]
          };
        }
      }
      nodes.push(...local);
    }
    const byType = nodes.reduce((summary, node) => {
      summary[node.type] = (summary[node.type] || 0) + 1;
      return summary;
    }, {});
    return { nodes, by_type: byType, scene_count: new Set(nodes.map(node => node.path)).size };
  }

  // Same rule as findNodeBlock: exact path first, bare leaf only when unambiguous. Silently
  // picking the first same-named node is how an overlay ends up pointing at the wrong object.
  function findSceneNode(filesDict, nodeName) {
    if (!nodeName) return null;
    const wanted = String(nodeName).replace(/^\.\//, '');
    const graph = sceneGraphFromFiles(filesDict);
    const exact = graph.nodes.find(node => node.node_path === wanted);
    if (exact) return exact;
    const leaf = wanted.replace(/^.*\//, '');
    const byName = graph.nodes.filter(node => node.name === leaf);
    return byName.length === 1 ? byName[0] : null;
  }

  // A name clash only matters inside the scene being edited. Searching every .tscn refused to
  // place ArenaFloor in the main scene because arena_floor.tscn's own root node is called
  // ArenaFloor - which is the normal shape of a reusable scene, not a conflict.
  function findNodeInActiveScene(filesDict, nodeName) {
    if (!nodeName) return null;
    const scenePath = activeMainScene ? cleanProjectPath(activeMainScene) : null;
    if (!scenePath) return null;
    const leaf = String(nodeName).replace(/^\.\//, '').replace(/^.*\//, '');
    const resPath = `res://${scenePath}`;
    return sceneGraphFromFiles(filesDict).nodes
      .find(node => node.path === resPath && node.name === leaf) || null;
  }

  function findSceneNodeCandidates(filesDict, nodeName) {
    const leaf = String(nodeName || '').replace(/^.*\//, '');
    return sceneGraphFromFiles(filesDict).nodes.filter(node => node.name === leaf).map(node => node.node_path);
  }

  // ==========================================
  // 6B. Camera pose resolution and world -> screen projection
  // ==========================================
  // Two honest sources, never a guess:
  //  - the editor viewport camera, read through the command channel, while the Editor tab
  //    is showing (there is no other way to know where the editor camera is);
  //  - the scene's own active Camera3D, while the playtest tab is running, because that is
  //    literally the camera rendering those pixels.
  // With neither, the overlay reports `unavailable` rather than drawing a reticle over a
  // position it cannot know.
  function editorViewportCameraPose() {
    const reply = EditorCommandChannel.call('camera_pose');
    if (!reply.ok) return null;
    return {
      source: 'editor_viewport',
      transform: { basis: reply.basis, origin: reply.position },
      fov: Number(reply.fov) || 75
    };
  }

  function sceneCameraPose(filesDict = {}) {
    const graph = sceneGraphFromFiles(filesDict);
    const camera = graph.nodes.find(node => node.type === 'Camera3D');
    if (!camera || !camera.world_transform) return null;
    let fov = 75;
    for (const [path, source] of Object.entries(filesDict)) {
      if (`res://${path}` !== camera.path || typeof source !== 'string') continue;
      const block = source.slice(source.indexOf(`[node name="${camera.name}"`));
      const fovMatch = block.match(/^fov\s*=\s*(-?[\d.]+)/m);
      if (fovMatch) fov = Number(fovMatch[1]);
      break;
    }
    return { source: 'scene_camera', transform: camera.world_transform, fov };
  }

  function resolveCameraPose(viewport = activeGodotViewport()) {
    if (viewport === 'game') return sceneCameraPose(activeFilesDict);
    return editorViewportCameraPose();
  }

  // Godot cameras look down -Z and `fov` is the vertical field of view (KEEP_HEIGHT).
  function projectWorldPoint(worldPoint, pose, rect) {
    if (!pose || !rect || !rect.width || !rect.height) return null;
    const { basis, origin } = pose.transform;
    const relative = [worldPoint[0] - origin[0], worldPoint[1] - origin[1], worldPoint[2] - origin[2]];
    // The basis is orthonormal for an editor camera, so its inverse is its transpose.
    const view = [
      basis[0] * relative[0] + basis[1] * relative[1] + basis[2] * relative[2],
      basis[3] * relative[0] + basis[4] * relative[1] + basis[5] * relative[2],
      basis[6] * relative[0] + basis[7] * relative[1] + basis[8] * relative[2]
    ];
    const depth = -view[2];
    const halfFovTangent = Math.tan((Number(pose.fov) || 75) * Math.PI / 360);
    const aspect = rect.width / rect.height;
    const behind = depth <= 0.001;
    // Behind the camera there is no valid projection; mirror it so the edge arrow still
    // points the shortest way round instead of inverting.
    const usableDepth = behind ? Math.max(Math.abs(depth), 0.001) : depth;
    let ndcX = (view[0] / usableDepth) / (halfFovTangent * aspect);
    let ndcY = (view[1] / usableDepth) / halfFovTangent;
    if (behind) { ndcX = -ndcX; ndcY = -ndcY; }
    return {
      behind,
      distance: Math.hypot(relative[0], relative[1], relative[2]),
      ndc: [ndcX, ndcY],
      // CSS pixels: rect is already in CSS units, so devicePixelRatio never enters here.
      x: rect.left + (ndcX * 0.5 + 0.5) * rect.width,
      y: rect.top + (0.5 - ndcY * 0.5) * rect.height,
      onScreen: !behind && Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1,
      halfFovTangent,
      depth: usableDepth
    };
  }

  function projectedRadius(halfExtents, projection, rect) {
    if (!projection || !Array.isArray(halfExtents)) return 26;
    const worldRadius = Math.hypot(halfExtents[0], halfExtents[1], halfExtents[2]);
    const pixels = (worldRadius / projection.depth) / projection.halfFovTangent * (rect.height / 2);
    return Math.max(22, Math.min(rect.height * 0.45, pixels * 1.35));
  }

  // ==========================================
  // Real-Time 3D Live Scene Mutator & Streaming Engine
  // ==========================================
  function parseColor(val, fallback = 'Color(1, 1, 1, 1)') {
    if (!val) return fallback;
    // Godot's Color.to_html() returns bare hex with no leading '#', so the plugin's own
    // reported material values have to parse here too.
    if (typeof val === 'string' && (val.startsWith('#') || /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(val))) {
      const hex = val.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      const a = hex.length >= 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1;
      return `Color(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)}, ${a.toFixed(3)})`;
    }
    return String(val);
  }

  function generateMeshSubResource(meshType = 'box', args = {}, subResId) {
    switch (meshType.toLowerCase()) {
      case 'cylinder': {
        const rad = Number(args.radius) || 0.5;
        const h = Number(args.height) || 2.0;
        return `[sub_resource type="CylinderMesh" id="${subResId}"]\ntop_radius = ${rad}\nbottom_radius = ${rad}\nheight = ${h}\n`;
      }
      case 'sphere': {
        const rad = Number(args.radius) || 1.0;
        const h = Number(args.height) || (rad * 2);
        return `[sub_resource type="SphereMesh" id="${subResId}"]\nradius = ${rad}\nheight = ${h}\n`;
      }
      case 'torus': {
        const inner = Number(args.inner_radius) || 2.0;
        const outer = Number(args.outer_radius) || 2.6;
        return `[sub_resource type="TorusMesh" id="${subResId}"]\ninner_radius = ${inner}\nouter_radius = ${outer}\n`;
      }
      case 'prism': {
        const size = Array.isArray(args.size) && args.size.length >= 3 ? args.size : [1, 2, 1];
        return `[sub_resource type="PrismMesh" id="${subResId}"]\nsize = Vector3(${size[0]}, ${size[1]}, ${size[2]})\n`;
      }
      case 'capsule': {
        const rad = Number(args.radius) || 0.5;
        const h = Number(args.height) || 2.0;
        return `[sub_resource type="CapsuleMesh" id="${subResId}"]\nradius = ${rad}\nheight = ${h}\n`;
      }
      case 'plane': {
        const size = Array.isArray(args.size) && args.size.length >= 2 ? args.size : [10, 10];
        return `[sub_resource type="PlaneMesh" id="${subResId}"]\nsize = Vector2(${size[0]}, ${size[1]})\n`;
      }
      case 'box':
      default: {
        const size = Array.isArray(args.size) && args.size.length >= 3 ? args.size : [2, 2, 2];
        return `[sub_resource type="BoxMesh" id="${subResId}"]\nsize = Vector3(${size[0]}, ${size[1]}, ${size[2]})\n`;
      }
    }
  }

  function generateMaterialSubResource(mat = {}, subResId) {
    const lines = [`[sub_resource type="StandardMaterial3D" id="${subResId}"]`];
    if (mat.albedo_color) lines.push(`albedo_color = ${parseColor(mat.albedo_color)}`);
    if (typeof mat.metallic === 'number') lines.push(`metallic = ${mat.metallic}`);
    if (typeof mat.roughness === 'number') lines.push(`roughness = ${mat.roughness}`);
    if (mat.emission) {
      lines.push('emission_enabled = true');
      lines.push(`emission = ${parseColor(mat.emission)}`);
      if (typeof mat.emission_energy === 'number') lines.push(`emission_energy_multiplier = ${mat.emission_energy}`);
    }
    return lines.join('\n') + '\n';
  }

  // The editor resolved the request against the real scene tree and reported the path it
  // actually touched. Using that for the text edit makes the two sides agree by construction
  // rather than by two lookups that can disagree.
  // Read the committed text back and answer: does the file now say what the editor holds?
  // Returning `true` without looking is exactly the defect these replace.
  function verifyTransformInSource(source, nodePath, expected) {
    if (!Array.isArray(expected) || expected.length < 12) {
      return { synced: null, reason: 'no_authoritative_transform_to_compare' };
    }
    const block = findNodeBlock(source, nodePath);
    if (!block) return { synced: false, mismatch: `node '${nodePath}' is absent from the written scene` };
    const written = existingTransformOf(block.text);
    const flat = [...written.basis, ...written.origin];
    const delta = Math.max(...flat.map((value, index) => Math.abs(value - Number(expected[index]))));
    return delta <= 1e-4
      ? { synced: true, node_path: block.nodePath, delta }
      : { synced: false, node_path: block.nodePath, delta, mismatch: `written transform differs from the editor's by ${delta.toExponential(2)}` };
  }

  function verifyMaterialInSource(source, nodePath, requested = {}) {
    const block = findNodeBlock(source, nodePath);
    if (!block) return { synced: false, mismatch: `node '${nodePath}' is absent from the written scene` };
    const slot = materialSlotOf(block.text);
    if (!slot) return { synced: false, mismatch: `node '${block.nodePath}' has no material reference after the edit` };
    const material = readMaterialSubResource(source, slot.id);
    if (!material) return { synced: false, mismatch: `referenced material '${slot.id}' is missing from the scene` };
    // A recolour that leaves the node on a shared resource repaints every node using it.
    const shares = materialReferenceCount(source, slot.id);
    if (shares > 1) {
      return { synced: false, mismatch: `material '${slot.id}' is still shared by ${shares} nodes, so this edit would repaint all of them` };
    }
    // Every requested property, not just albedo: a metallic-only edit that silently failed
    // to serialize would otherwise still report source_synced: true.
    const checks = [
      ['albedo_color', 'albedo_color', value => parseColor(value)],
      ['emission', 'emission', value => parseColor(value)],
      ['metallic', 'metallic', value => String(value)],
      ['roughness', 'roughness', value => String(value)],
      ['emission_energy', 'emission_energy_multiplier', value => String(value)]
    ];
    const numeric = new Set(['metallic', 'roughness', 'emission_energy_multiplier']);
    for (const [requestKey, sceneKey, format] of checks) {
      if (requested[requestKey] === undefined || requested[requestKey] === null) continue;
      const expected = format(requested[requestKey]);
      const actual = material.properties[sceneKey];
      if (actual === undefined) {
        return { synced: false, mismatch: `${sceneKey} was requested but is absent from material '${slot.id}'` };
      }
      const equal = numeric.has(sceneKey)
        ? Math.abs(Number(actual) - Number(expected)) <= 1e-6
        : actual === expected;
      if (!equal) {
        return { synced: false, mismatch: `${sceneKey} is ${actual}, expected ${expected}` };
      }
    }
    if ((requested.emission !== undefined || requested.emission_energy !== undefined)
      && material.properties.emission_enabled !== 'true') {
      return { synced: false, mismatch: `emission was requested but emission_enabled is ${material.properties.emission_enabled || 'unset'}` };
    }
    return { synced: true, node_path: block.nodePath, material_id: slot.id };
  }

  function verifyNodePresence(source, nodePath, shouldExist) {
    let block = null;
    try {
      block = findNodeBlock(source, nodePath);
    } catch (error) {
      return { synced: false, mismatch: error.message };
    }
    if (shouldExist) {
      return block ? { synced: true, node_path: block.nodePath } : { synced: false, mismatch: `node '${nodePath}' was not written to the scene` };
    }
    return block ? { synced: false, mismatch: `node '${nodePath}' is still present after delete` } : { synced: true };
  }

  // Copy into the *editor* engine. Keeps the editor's on-disk view current; it says nothing
  // about what a playtest will load, because the playtest is a different Engine instance with
  // its own filesystem. Named for what it actually proves.
  function copyActiveProjectToEditorFS() {
    if (typeof window === 'undefined' || typeof window.__godotCopyToEditorFS !== 'function') {
      return { ok: false, error: 'The editor filesystem bridge is unavailable in this build.' };
    }
    try {
      return window.__godotCopyToEditorFS(activeFilesDict, DiagnosticState.activeProject) || { ok: false, error: 'No result from the filesystem copy.' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const PLAYTEST_SNAPSHOT_TTL_MS = 60000;
  let playtestLaunchCounter = 0;

  // Stage the snapshot the playtest engine must boot from. The token makes it one-shot: the
  // game side clears it on read, so a later manual Play in Godot cannot silently pick up a
  // stale WebMCP snapshot, and a replayed acknowledgement cannot satisfy a new launch.
  async function stagePlaytestSnapshot(files, projectName, revision, scope = typeof window !== 'undefined' ? window : null) {
    playtestLaunchCounter += 1;
    const staged = {
      projectName,
      revision,
      launchToken: `launch_${Date.now()}_${playtestLaunchCounter}_${Math.random().toString(36).slice(2, 8)}`,
      stagedAt: Date.now(),
      files: cloneProjectFiles(files),
      fingerprint: await fingerprintProjectBytes(files)
    };
    if (scope) {
      scope.__godotStagedProject = staged;
      scope.__godotGameFsAck = null;
    }
    return staged;
  }

  // Pure: decide whether an acknowledgement actually proves the running game loaded this
  // snapshot. A revision label alone proves only that the copy loop was handed that label.
  function verifyPlaytestAcknowledgement(staged, ack, now = Date.now()) {
    if (!staged) return { ok: false, code: 'NOT_STAGED', error: 'No snapshot was staged for this launch.' };
    if (!ack) return { ok: false, code: 'NO_ACK', error: 'The playtest engine never acknowledged the staged project snapshot.' };
    if (ack.reason === 'no_staged_snapshot') {
      return { ok: false, code: 'SNAPSHOT_ALREADY_CONSUMED', error: ack.error || 'The staged snapshot was already consumed by an earlier run.' };
    }
    if (!ack.launchToken || ack.launchToken !== staged.launchToken) {
      return { ok: false, code: 'LAUNCH_TOKEN_MISMATCH', error: `The playtest acknowledged launch token ${ack.launchToken || 'none'}, not ${staged.launchToken}.` };
    }
    if (now - staged.stagedAt > PLAYTEST_SNAPSHOT_TTL_MS) {
      return { ok: false, code: 'SNAPSHOT_EXPIRED', error: `The staged snapshot is ${Math.round((now - staged.stagedAt) / 1000)}s old and was not consumed in time.` };
    }
    if (!ack.ok) {
      const failedCount = ack.failed?.length || 0;
      return { ok: false, code: 'COPY_FAILED', error: ack.error || `${failedCount} file(s) failed to copy into the playtest engine.` };
    }
    if (ack.revision !== staged.revision) {
      return { ok: false, code: 'REVISION_MISMATCH', error: `The playtest engine acknowledged revision ${ack.revision}, not ${staged.revision}.` };
    }
    const expectedFiles = Object.keys(staged.files).length;
    if (Number(ack.written) !== expectedFiles) {
      return { ok: false, code: 'PARTIAL_COPY', error: `The playtest engine wrote ${ack.written} of ${expectedFiles} staged files.` };
    }
    if (staged.fingerprint && ack.fingerprint && ack.fingerprint !== staged.fingerprint) {
      return { ok: false, code: 'FINGERPRINT_MISMATCH', error: `The bytes copied into the playtest engine hash to ${ack.fingerprint}, not ${staged.fingerprint}.` };
    }
    if (staged.fingerprint && !ack.fingerprint) {
      return { ok: false, code: 'FINGERPRINT_MISSING', error: 'The playtest engine did not report a content fingerprint, so the copied bytes cannot be verified.' };
    }
    return { ok: true, revision: ack.revision, written: ack.written, fingerprint: ack.fingerprint };
  }

  async function awaitPlaytestAcknowledgement(staged, timeoutMs = 12000) {
    await waitFor(() => Boolean(window.__godotGameFsAck), timeoutMs, 60);
    return verifyPlaytestAcknowledgement(staged, window.__godotGameFsAck || null);
  }

  // `status: 'healthy'` used to be a hardcoded literal, so the top line said healthy while
  // engine_state was failed, the session was failed, and the command channel was gone. Derived
  // from the same facts the caller can see, and pure so it is testable.
  function deriveOverallStatus(snapshot) {
    const {
      engine, session, lifecycleState = 'idle',
      commandChannelAvailable = false, commandChannelExpected = true,
      fatalCount = 0, unpersisted = false
    } = snapshot || {};
    if (snapshot?.restartRequired) return { status: 'failed', reason: 'restart_required' };
    if (engine === 'failed' || session === 'failed' || session === 'restore_failed' || session === 'restart_required') {
      return { status: 'failed', reason: session === 'restart_required' ? 'restart_required' : (engine === 'failed' ? 'engine_failed' : 'session_failed') };
    }
    if (fatalCount > 0) return { status: 'failed', reason: 'engine_fatal' };
    if (lifecycleState === 'initializing' || lifecycleState === 'quitting'
      || session === 'auto_restoring' || engine === 'loading') {
      return { status: 'recovering', reason: 'engine_restarting' };
    }
    if (engine !== 'ready') return { status: 'recovering', reason: 'engine_not_ready' };
    if (unpersisted) return { status: 'degraded', reason: 'unpersisted_changes' };
    if (commandChannelExpected && !commandChannelAvailable) {
      return { status: 'degraded', reason: 'editor_command_channel_unavailable' };
    }
    return { status: 'healthy', reason: null };
  }

  function resolvedNodePath(commandReply, requestedPath) {
    const resolved = commandReply?.node_path;
    return typeof resolved === 'string' && resolved ? resolved : requestedPath;
  }

  function nowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
  }

  // Two ways to land a live edit, in order of preference:
  //
  //  1. The editor command channel. The @tool plugin applies the change to the live scene
  //     tree through the editor's own UndoRedo, so the agent's edit sits next to the
  //     human's in one undo stack and the WASM process is never touched. The .tscn text is
  //     still spliced so export, persistence, and the projection overlay stay in sync.
  //  2. A full `restartEditorWithProject`. This tears down the pthread pool, the GL context,
  //     and the whole project import — roughly three seconds, and it destroys camera pose,
  //     selection, and undo history. It is the fallback, not the happy path.
  //
  // The returned `elapsed_ms` is measured, not asserted.
  async function liveMutateSceneFile(mutatorFn, options = {}) {
    const startedAt = nowMs();
    const mainScenePath = activeMainScene ? cleanProjectPath(activeMainScene) : 'main_3d.tscn';
    const currentTscn = activeFilesDict[mainScenePath] || '';
    if (!currentTscn) {
      throw new Error(`Active main scene '${mainScenePath}' is not loaded. Create or author a scene first.`);
    }

    let channel = 'transaction';
    let channelError = null;
    let commandReply = null;
    const command = options.command;
    if (command && EditorCommandChannel.available()) {
      const reply = EditorCommandChannel.call(command.op, command.payload || {});
      if (reply.ok) {
        channel = 'command';
        commandReply = reply;
      } else if (reply.unsupported || reply.stale) {
        channelError = reply.error || EditorCommandChannel.unavailableReason;
      } else {
        // Keep what the editor told us. Flattening an AMBIGUOUS_NODE_PATH with its candidate
        // list into a generic rejection throws away exactly the information the caller needs
        // to fix the call.
        const error = new Error(`The Godot editor rejected this operation: ${reply.error}`);
        error.code = reply.code || 'EDITOR_COMMAND_REJECTED';
        if (Array.isArray(reply.candidates)) error.candidates = reply.candidates;
        if (reply.requested_path) error.requested_path = reply.requested_path;
        error.editor_error = reply.error;
        throw error;
      }
    } else if (command) {
      channelError = EditorCommandChannel.unavailableReason;
    }

    // The editor is the source of truth when it applied the change: its own serialized
    // transform is written into the .tscn rather than the bridge's idea of what it asked for.
    const updatedTscn = mutatorFn(currentTscn, commandReply);

    // Verify the text we are about to commit actually says what the editor holds, instead of
    // asserting it. `null` means "could not be checked", which is not the same as "matches".
    let verification = { synced: null, reason: 'not_verified' };
    if (typeof options.verify === 'function') {
      try {
        verification = options.verify(updatedTscn, commandReply) || verification;
      } catch (error) {
        verification = { synced: false, mismatch: error instanceof Error ? error.message : String(error) };
      }
    }

    // Two-phase commit. The candidate snapshot is built, applied to the editor, and PERSISTED
    // before `sceneRevision` is published. Incrementing first is what left the reported
    // revision ahead of what was actually stored when a step failed part-way.
    const previousRevision = DiagnosticState.sceneRevision;
    const previousFiles = activeFilesDict;
    const candidateFiles = { ...activeFilesDict, [mainScenePath]: updatedTscn };
    const nextRevision = previousRevision + 1;

    let restarted = false;
    if (channel !== 'command' && typeof window !== 'undefined' && typeof restartEditorWithProject === 'function') {
      // The fallback boots from the candidate, so it has to be live for the restart.
      activeFilesDict = candidateFiles;
      try {
        await restartEditorWithProject(activeFilesDict, DiagnosticState.activeProject);
        restarted = true;
      } catch (error) {
        // Roll back to the last state that really existed; nothing is published.
        activeFilesDict = previousFiles;
        DiagnosticState.sceneRevision = previousRevision;
        DiagnosticState.engine = 'failed';
        DiagnosticState.engineError = error instanceof Error ? error.message : String(error);
        DiagnosticHUD.render();
        throw error;
      }
    }

    // Persist the candidate BEFORE publishing it.
    let persisted = false;
    let persistError = null;
    try {
      persisted = await persistActiveProjectState({ files: candidateFiles, revision: nextRevision });
    } catch (error) {
      persisted = false;
      persistError = error instanceof Error ? error.message : String(error);
    }

    // Publish. The editor already holds the change either way, so the scene text and revision
    // must describe it — but when the snapshot did not reach storage the session says so
    // explicitly rather than leaving a silent gap between revision and persistence.
    activeFilesDict = candidateFiles;
    DiagnosticState.sceneRevision = nextRevision;
    if (!persisted) {
      DiagnosticState.session = 'dirty_unpersisted';
      projectPersistenceError = persistError || projectPersistenceError || 'The scene snapshot could not be stored.';
    } else if (DiagnosticState.session === 'dirty_unpersisted') {
      DiagnosticState.session = 'editor-ready';
    }
    DiagnosticHUD.render();
    BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);

    return {
      revision: DiagnosticState.sceneRevision,
      mainScene: `res://${mainScenePath}`,
      channel,
      channelError,
      restarted,
      persisted,
      persistError,
      verification,
      // Whether the .tscn text was written from Godot's own post-apply state rather than
      // from the bridge's local model of the request.
      authoritative: Boolean(commandReply && Array.isArray(commandReply.transform) && commandReply.transform.length >= 12)
        || Boolean(commandReply && materialUpdateFromCommandReply(commandReply)),
      commandReply,
      elapsedMs: Math.round((nowMs() - startedAt) * 100) / 100
    };
  }

  function liveMutationResult(res, extra = {}) {
    return {
      success: true,
      ...extra,
      scene_revision: res.revision,
      editor_channel: res.channel,
      editor_restarted: res.restarted,
      // Four distinct facts, deliberately not collapsed into one "success":
      //   applied              — the editor accepted and applied the operation
      //   source_synced        — the .tscn text was re-read and matches (null = not checked)
      //   source_authoritative — that text came from Godot's own serialized state
      //   persisted            — the snapshot reached IndexedDB at this revision
      applied: res.channel === 'command' ? 'editor_command' : 'editor_restart',
      source_synced: res.verification?.synced ?? null,
      ...(res.verification?.mismatch ? { source_mismatch: res.verification.mismatch } : {}),
      ...(res.verification?.synced === null && res.verification?.reason ? { source_unverified_reason: res.verification.reason } : {}),
      source_authoritative: res.authoritative === true,
      persisted: res.persisted === true,
      // Measured wall clock for this call, including the editor restart when one was needed.
      execution_time_ms: res.elapsedMs,
      ...(res.channelError ? { editor_channel_note: res.channelError } : {})
    };
  }

  // One list, so the schema enum and the runtime check cannot drift apart.
  const PROJECT_TEMPLATES = ['orbital_garden', 'neon_skyrail_3d', 'custom'];

  const MANIFEST_TOOLS = [
    {
      definition: {
        name: 'godot_get_session_status',
        description: 'Returns live diagnostics for Godot WebEditor runtime, WebMCP native discovery, session revision, and WebGL health',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async () => {
        refreshMeasuredEngineState();
        const isWebGL = typeof WebGLRenderingContext !== 'undefined';
        const autoResumeEnabled = typeof localStorage !== 'undefined' ? localStorage.getItem('godot-webmcp-auto-resume') !== 'false' : true;
        const lastValidatedRev = hydratedSnapshot?.last_validated_revision ?? DiagnosticState.sceneRevision;
        // Never let a storage read fail a status call: status is what you reach for when
        // something is already wrong.
        const savedProjects = await listSavedProjects().catch(() => []);
        EditorTruth.refresh();
        const overall = deriveOverallStatus({
          engine: DiagnosticState.engine,
          session: DiagnosticState.session,
          lifecycleState: EditorLifecycle.state(),
          commandChannelAvailable: EditorCommandChannel.available(),
          // The channel is only expected once an editor has actually booted at least once.
          commandChannelExpected: EditorCommandChannel.generation > 0,
          fatalCount: fatalGodotErrors(0, EditorCommandChannel.generation).length,
          unpersisted: DiagnosticState.sceneRevision !== DiagnosticState.persistedRevision,
          restartRequired: editorRestartBlocked
        });
        return {
          status: overall.status,
          status_reason: overall.reason,
          engine_state: DiagnosticState.engine,
          webmcp_state: DiagnosticState.webmcp,
          webmcp_registered_tools_count: DiagnosticState.webmcpRegisteredCount,
          webmcp_surface: DiagnosticState.webmcpSurface,
          editor_command_channel: EditorCommandChannel.describe(),
          editor_restart_count: editorRestartCount,
          recovery: {
            // True when this page can no longer host an editor. The project is safe in
            // storage; only a browser reload can restore a working runtime.
            restart_required: editorRestartBlocked,
            action: editorRestartBlocked ? 'reload_page' : null,
            stale_lifecycle_events: typeof window !== 'undefined' ? (window.__godotEditorLifecycle?.stale || 0) : 0
          },
          engine_health: (() => {
            const classified = classifyEngineDiagnostics(activeLogs, EditorCommandChannel.generation);
            return {
              // Fatal traps for the CURRENT editor generation only; teardown noise from a
              // previous process is excluded rather than counted against this session.
              fatal_errors: fatalGodotErrors(0, EditorCommandChannel.generation).slice(-3).map(entry => entry.msg),
              // Split so a real project error is not buried among the browser platform's
              // normal complaints (no TCP sockets, occlusion culling compiled out, ...).
              project_errors: classified.errors.length,
              warnings: classified.warnings.length,
              platform_diagnostics: classified.platform_diagnostics.length,
              resolved_diagnostics: classified.resolved_diagnostics.length,
              recent_project_errors: classified.errors.slice(-3),
              generation: EditorCommandChannel.generation,
              editor_lifecycle: EditorLifecycle.describe(),
            boot_in_flight: EditorLifecycle.bootInFlight()
            };
          })(),
          camera: {
            auto_follow: CameraGuidance.autoFollowEnabled(),
            active_viewport: activeGodotViewport(),
            pose_source: resolveCameraPose()?.source || null,
            // A camera that deliberately held still is indistinguishable from a broken follow
            // unless it says so. This is the last time a follow was skipped because the work
            // was already comfortably in frame.
            last_follow_skipped: CameraGuidance.lastSkippedFollow
              ? { node: CameraGuidance.lastSkippedFollow.node, at: CameraGuidance.lastSkippedFollow.at, reason: 'already_framed' }
              : null,
            agent_presence: AgentPresence.describe()
          },
          session: {
            state: DiagnosticState.session,
            active_project: DiagnosticState.activeProject,
            active_main_scene: activeMainScene,
            scene_revision: DiagnosticState.sceneRevision,
            // Reported separately on purpose: these are not guaranteed equal, and a gap means
            // the editor holds edits that are not in storage.
            persisted_revision: DiagnosticState.persistedRevision,
            unpersisted: DiagnosticState.sceneRevision !== DiagnosticState.persistedRevision,
            undo_stack_depth: undoStack.length,
            active_operation_id: activeManagedMutationId,
            // Imported assets are real project files, but they are not part of the bridge's
            // text project model, so they are absent from exports and undo snapshots. Listing
            // them keeps that gap visible rather than something a caller has to remember.
            imported_assets: [...DiagnosticState.importedAssets.values()].map(entry => ({
              path: entry.path, bytes: entry.bytes, loadable: entry.loadable === true
            }))
          },
          runtime: {
            state: typeof window !== 'undefined' ? window.__godotGameState || 'unknown' : 'unavailable',
            game_tab_enabled: typeof document !== 'undefined' && !document.getElementById('btn-tab-game')?.disabled,
            close_control_enabled: typeof document !== 'undefined' && !document.getElementById('btn-close-game')?.disabled
          },
          persistence: {
            hydrated: projectStateHydrated,
            project_available: persistedProjectAvailable,
            restore_required: DiagnosticState.session === 'persisted' || DiagnosticState.session === 'resume_available' || DiagnosticState.session === 'restore_failed',
            resume_state: DiagnosticState.session === 'editor-ready' ? 'ready'
              : (DiagnosticState.session === 'persisted' || DiagnosticState.session === 'resume_available') ? 'available'
              : DiagnosticState.session === 'auto_restoring' ? 'restoring'
              : DiagnosticState.session === 'restore_failed' ? 'failed'
              : 'empty',
            restore_mode: ResumeState.restoreMode,
            restore_operation_id: ResumeState.operationId,
            last_restore_error: ResumeState.lastRestoreError,
            auto_resume_enabled: autoResumeEnabled,
            last_validated_revision: lastValidatedRev,
            last_error: projectPersistenceError,
            // What else is in this browser. Discoverable here so an agent does not have to
            // know the library exists to find the project the human was working on before.
            saved_projects: savedProjects.map(project => project.project_name),
            saved_project_limit: SAVED_PROJECT_LIMIT,
            // Whether the editor is holding the project this page thinks it is. `null` means
            // the editor could not be asked, which is not the same as agreement.
            editor_agreement: EditorTruth.describe()
          },
          transport: {
            type: 'NativeInPageWebMCP + OptionalWSS',
            protocol: typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws',
            coop_coep_isolated: typeof window !== 'undefined' && window.crossOriginIsolated || false
          },
          webgl_context: {
            available: isWebGL,
            renderer: 'gl_compatibility',
            screen_resolution: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : '1280x720'
          }
        };
      }
    },
    {
      definition: {
        name: 'godot_restore_project_session',
        description: 'Restores the persisted authoritative project into a fresh Godot Editor process after a page reload without changing scene revision or undo history',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}, context = {}) => {
        return executeRestoreOperation('validate_runtime', `Restoring persisted project: ${DiagnosticState.activeProject}`, context);
      }
    },
    {
      definition: {
        name: 'godot_list_saved_projects',
        description: 'Lists the projects kept in this browser, newest first. Every acknowledged persist writes a row keyed by project name, so a project you stopped working on can be returned to instead of being overwritten by the next one. Reports name, main scene, revision, file count, and when it was last saved.',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async () => {
        const projects = await listSavedProjects();
        return {
          success: true,
          active_project: DiagnosticState.activeProject,
          limit: SAVED_PROJECT_LIMIT,
          count: projects.length,
          projects: projects.map(project => ({ ...project, active: project.project_name === DiagnosticState.activeProject }))
        };
      }
    },
    {
      definition: {
        name: 'godot_open_saved_project',
        description: 'Opens a project kept in this browser by name, replacing the editor with it. The current project is persisted to the library first, so switching away never loses it. Restores that project\'s files, main scene, and revision; undo history is session state and does not travel with the library row.',
        input_schema: {
          type: 'object',
          properties: { project_name: { type: 'string', description: 'A name from godot_list_saved_projects' } },
          required: ['project_name'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}, context = {}) => {
        const requested = String(args.project_name || '').trim();
        if (!requested) throw new Error('project_name is required.');
        const row = await readSavedProject(requested);
        if (!row || !row.files || Object.keys(row.files).length === 0) {
          const available = (await listSavedProjects()).map(project => project.project_name);
          const error = new Error(`No saved project named ${requested}. Available: ${available.join(', ') || 'none'}.`);
          error.code = 'SAVED_PROJECT_NOT_FOUND';
          throw error;
        }
        if (requested === DiagnosticState.activeProject
          && DiagnosticState.session === 'editor-ready' && DiagnosticState.engine === 'ready') {
          const currentFingerprint = await computeProjectContentFingerprint(activeFilesDict);
          const exactMatch = Number(row.scene_revision) === DiagnosticState.sceneRevision
            && row.content_fingerprint === currentFingerprint;
          // Never downgrade a live project. Persisting it updates the named snapshot and heals
          // the inverse mismatch; a newer/different named row, however, must be restored.
          if (exactMatch || DiagnosticState.sceneRevision > Number(row.scene_revision || 0)) {
            if (!exactMatch) await persistActiveProjectState();
            return {
              success: true,
              opened: false,
              reason: exactMatch ? 'already_active' : 'active_newer_than_library',
              active_project: DiagnosticState.activeProject,
              scene_revision: DiagnosticState.sceneRevision,
              content_fingerprint: currentFingerprint
            };
          }
        }
        // Persist what is open before replacing it, so switching away is never how work is
        // lost. A project with no files has nothing worth keeping and nothing to overwrite.
        if (Object.keys(activeFilesDict).length > 0) await persistActiveProjectState();
        const previous = DiagnosticState.activeProject;
        activeFilesDict = cloneProjectFiles(row.files);
        activeMainScene = row.main_scene || activeMainScene;
        DiagnosticState.activeProject = row.project_name;
        DiagnosticState.sceneRevision = Number(row.scene_revision) || 1;
        DiagnosticState.persistedRevision = DiagnosticState.sceneRevision;
        // The undo stack belongs to the session that built it; replaying it against a
        // different project's files would restore snapshots that never existed here.
        undoStack.length = 0;
        DiagnosticState.session = 'restoring';
        DiagnosticHUD.render();
        const restored = await executeRestoreOperation('validate_runtime', `Opening saved project: ${row.project_name}`, context);
        await persistActiveProjectState();
        BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);
        return {
          ...restored,
          opened: true,
          previous_project: previous,
          active_project: DiagnosticState.activeProject,
          scene_revision: DiagnosticState.sceneRevision,
          file_count: Object.keys(activeFilesDict).length,
          undo_stack_depth: 0,
          undo_history: 'cleared_on_switch'
        };
      }
    },
    {
      definition: {
        name: 'godot_import_asset',
        description: "Imports a binary asset - image, font, audio (.wav/.ogg/.mp3), or model (.glb/.gltf) - into the RUNNING Godot editor and makes it loadable, without restarting. Content is base64. The asset becomes a real project file: it survives editor restarts and is included in godot_export_zip. Place an imported model into a scene with godot_node_instance. Reports what Godot confirmed - that it sees the file, its size on disk, and whether it imported into a loadable resource - rather than assuming the write succeeded.",
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Project-relative or res:// path, for example sfx/pickup.wav' },
            content_base64: { type: 'string', description: 'Base64 of the raw file bytes', maxLength: 7000000 },
            reimport: { type: 'boolean', default: true, description: 'Ask Godot to import it into a loadable resource' }
          },
          required: ['path', 'content_base64'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        const path = cleanProjectPath(args.path);
        if (!path) throw new Error('path is required.');
        if (!EditorCommandChannel.available()) {
          const error = new Error('The editor command plugin is not available, so an asset cannot be imported.');
          error.code = 'EDITOR_COMMAND_UNSUPPORTED';
          throw error;
        }
        const bytes = decodeUploadChunk(String(args.content_base64 || ''), 'base64');
        if (!bytes.byteLength) throw new Error('content_base64 decoded to zero bytes.');
        if (bytes.byteLength > 5 * 1024 * 1024) throw new Error(`Asset exceeds the 5 MB limit: ${path}`);

        const generations = {
          lifecycle: typeof window !== 'undefined' ? (window.__godotEditorLifecycle?.generation || 0) : 0,
          command: EditorCommandChannel.generation
        };
        const write = window.__godotEditorWriteFiles({ [path]: bytes }, {
          expectLifecycleGeneration: generations.lifecycle,
          expectCommandGeneration: generations.command,
          projectName: DiagnosticState.activeProject
        });
        if (!write.ok) {
          const error = new Error(write.error || 'The editor filesystem refused the asset.');
          error.code = write.reason === 'generation_changed' ? 'EDITOR_GENERATION_CHANGED' : 'EDITOR_FS_COPY_FAILED';
          throw error;
        }
        const queued = EditorCommandChannel.call('asset_import', { path: `res://${path}`, reimport: args.reimport !== false });
        if (!queued.ok) {
          const error = new Error(queued.error || `Godot did not accept ${path}.`);
          error.code = 'ASSET_IMPORT_FAILED';
          throw error;
        }
        // Scanning and importing run on a deferred frame, so the request only queues a job.
        // Reading the outcome from the request's own reply reported every asset as unimported
        // while the write had in fact succeeded.
        const job = await HotScriptChannel.awaitJob(queued.job_id, 12000);
        if (!job.ok || job.job?.job_ok !== true) {
          const error = new Error(job.job?.job_error || `Godot did not finish importing ${path}.`);
          error.code = 'ASSET_IMPORT_FAILED';
          throw error;
        }
        const imported = job.job;
        const settled = await awaitAssetImport(`res://${path}`, args.reimport !== false ? 8000 : 0);
        // The asset belongs in the project model, not only in Godot's filesystem. Keeping it
        // out was a hedge against a boot crash that turned out to be audio-specific: a project
        // holding an imported .glb or .png boots healthy. Keeping it out also broke real work -
        // the scene referencing it failed every reference check, which blocked transactions and
        // project switching outright, and the asset was silently missing from every export.
        activeFilesDict[path] = bytes;
        DiagnosticState.sceneRevision += 1;
        await persistActiveProjectState();
        DiagnosticState.importedAssets.set(path, {
          path, bytes: bytes.byteLength, loadable: settled.loadable === true, at: Date.now()
        });
        BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);
        DiagnosticHUD.render();
        return {
          success: true,
          path: `res://${path}`,
          bytes_written: bytes.byteLength,
          bytes_on_disk: settled.size_bytes ?? imported.size_bytes ?? null,
          loadable: settled.loadable === true,
          import_metadata_written: settled.has_import === true,
          revealed_in_dock: imported.dock_revealed === true,
          editor_restarted: false,
          scene_revision: DiagnosticState.sceneRevision,
          // A real project file in both places that matter: Godot's filesystem, so it is
          // loadable now without a restart, and the project model, so it survives restarts,
          // rides into the export, and satisfies the reference check for any scene using it.
          persistence: 'project_file',
          survives_editor_restart: true,
          included_in_export_zip: true,
          project: DiagnosticState.activeProject
        };
      }
    },
    {
      definition: {
        name: 'godot_get_user_focus',
        description: "Reports what the human is currently pointed at in the editor: which nodes they have selected, which workspace they are in, which script is open and at what line, and which scene is being edited. Use it to resolve a pronoun - \"make this taller\", \"rename that\" - instead of asking which node was meant. Reports selection_count 0 rather than guessing when nothing is selected, and is read-only: it never changes the selection or the workspace.",
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async () => {
        if (!EditorCommandChannel.available()) {
          return {
            success: true,
            available: false,
            reason: EditorCommandChannel.unavailableReason,
            selection_count: 0,
            selected_nodes: []
          };
        }
        const reply = EditorCommandChannel.call('selection_state');
        if (!reply.ok) {
          return { success: true, available: false, reason: reply.error || 'The editor did not report a selection.', selection_count: 0, selected_nodes: [] };
        }
        const nodes = Array.isArray(reply.selected_nodes) ? reply.selected_nodes : [];
        return {
          success: true,
          available: true,
          selection_count: nodes.length,
          selected_nodes: nodes,
          // The single node when there is exactly one, because that is the case where a
          // pronoun is unambiguous. With several selected the agent should say which it means.
          focused_node: nodes.length === 1 ? nodes[0].node_path : null,
          workspace: reply.workspace || null,
          current_script: reply.current_script || null,
          caret_line: reply.caret_line || null,
          edited_scene: reply.edited_scene || null,
          active_project: DiagnosticState.activeProject,
          scene_revision: DiagnosticState.sceneRevision
        };
      }
    },
    {
      definition: {
        name: 'godot_adopt_open_project',
        description: "Adopts the project Godot currently has open into this browser's project library, without restarting the editor. Use it when the editor is holding a project the bridge did not create - one made through Godot's own project manager - which otherwise cannot be listed, reopened, or persisted. Reads the open project's text files back out of the editor filesystem and publishes them as the active project. Binary assets are named in skipped_files rather than carried, because the bridge's project model is text; the WebMCP addon itself is never adopted.",
        input_schema: {
          type: 'object',
          properties: { project_name: { type: 'string', description: "Overrides the name; defaults to the project's own application/config/name" } },
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async () => {
        if (!EditorCommandChannel.available()) {
          const error = new Error('The editor command plugin is not available, so the open project cannot be read.');
          error.code = 'EDITOR_COMMAND_UNSUPPORTED';
          throw error;
        }
        const reply = EditorCommandChannel.call('project_files');
        if (!reply.ok) throw new Error(reply.error || 'Godot could not list the open project.');
        const files = {};
        for (const [path, contents] of Object.entries(reply.files || {})) {
          files[cleanProjectPath(path)] = String(contents);
        }
        if (Object.keys(files).length === 0) {
          const error = new Error('Godot reported no readable text files in the open project.');
          error.code = 'PROJECT_EMPTY';
          throw error;
        }
        const state = EditorCommandChannel.call('project_state');
        const name = cleanProjectName(reply.project_name || state.project_name || 'adopted_project');
        // Persist what is open before replacing the bridge's model, so an adoption cannot be
        // the thing that loses the project it was standing on.
        if (Object.keys(activeFilesDict).length > 0) await persistActiveProjectState();
        const previous = DiagnosticState.activeProject;
        activeFilesDict = files;
        activeMainScene = state.ok && state.edited_scene_path
          ? state.edited_scene_path
          : (reply.main_scene || activeMainScene);
        DiagnosticState.activeProject = name;
        DiagnosticState.sceneRevision += 1;
        undoStack.length = 0;
        const persisted = await persistActiveProjectState();
        DiagnosticState.session = 'editor-ready';
        EditorTruth.refresh();
        DiagnosticHUD.render();
        BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);
        return {
          success: true,
          adopted: true,
          previous_project: previous,
          active_project: name,
          main_scene: activeMainScene,
          file_count: Object.keys(files).length,
          adopted_paths: Object.keys(files).map(path => `res://${path}`),
          skipped_files: reply.skipped || [],
          bytes: reply.bytes || 0,
          scene_revision: DiagnosticState.sceneRevision,
          persisted,
          editor_restarted: false,
          undo_history: 'cleared_on_adopt'
        };
      }
    },
    {
      definition: {
        name: 'godot_get_operation_status',
        description: 'Returns status and final results for long-running authoring operations that outlive a browser tool-call deadline',
        input_schema: {
          type: 'object',
          properties: {
            operation_id: { type: 'string', description: 'Specific operation ID; omit to inspect the active and recent operations' },
            after_sequence: { type: 'integer', description: 'Return immediately if operation sequence is newer than this value' },
            wait_ms: { type: 'integer', minimum: 0, maximum: 15000, default: 5000, description: 'Max ms to wait for a change before returning' }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        if (args.operation_id) {
          const operation = managedOperations.get(args.operation_id);
          if (!operation) throw new Error(`Unknown managed operation: ${args.operation_id}`);
          const afterSeq = typeof args.after_sequence === 'number' ? args.after_sequence : -1;
          const waitMs = typeof args.wait_ms === 'number' ? Math.min(Math.max(args.wait_ms, 0), 15000) : 5000;
          await waitForOperationChange(operation, afterSeq, waitMs);
          const result = publicOperation(operation);
          if (!operation.terminal) result.retry_after_ms = 3000;
          return result;
        }
        const recent = [...managedOperations.values()].slice(-10).reverse().map(publicOperation);
        const active = activeManagedMutationId ? managedOperations.get(activeManagedMutationId) : null;
        return {
          active_operation: active ? publicOperation(active) : null,
          recent_operations: recent,
          ...(active && !active.terminal ? { retry_after_ms: 3000 } : {})
        };
      }
    },
    {
      definition: {
        name: 'godot_author_3d_runner',
        description: 'Transactionally authors the complete Neon Skyrail 3D runner with chase camera, elevated skyrail, 8 coral hazards, 11 energy pulses, and Dawn Gate',
        input_schema: {
          type: 'object',
          properties: {
            project_name: { type: 'string', default: 'neon_skyrail_3d' },
            idempotency_key: { type: 'string', description: 'Unique mutation key' }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}, context = {}) => {
        const projName = cleanProjectName(args.project_name || 'neon_skyrail_3d');
        const idempotencyKey = args.idempotency_key;
        const fingerprint = mutationFingerprint('godot_author_3d_runner', args);
        return runManagedMutation('godot_author_3d_runner', `Authoring 3D runner: ${projName}`, async (operation) => {
          await advancePhase(operation, 'validating_request');
          const previous = {
            projectName: DiagnosticState.activeProject,
            mainScene: activeMainScene,
            files: cloneProjectFiles(activeFilesDict),
            session: DiagnosticState.session,
            engine: DiagnosticState.engine
          };
          DiagnosticState.activeProject = projName;
          activeMainScene = 'res://main_3d.tscn';
          const undoId = `undo_runner_${Date.now()}`;

          await advancePhase(operation, 'staging_files');
          activeFilesDict = {
            'project.godot': NeonSkyrail.generateProjectGodot(),
            'main_3d.tscn': NeonSkyrail.generateMain3dScene(),
            'main_3d.gd': NeonSkyrail.generateMain3dGd(),
            'player_runner.tscn': NeonSkyrail.generatePlayerTscn(),
            'player_runner.gd': NeonSkyrail.generatePlayerGd()
          };

          // The audio suite is synthesized but NOT staged into the project.
          //
          // This is the bug that made this template unusable. A .wav present in the project
          // directory when the editor boots aborts the Godot WebAssembly build during its
          // first import scan - reproduced with a minimal project containing nothing but
          // project.godot, an empty Node3D scene, and one WAV. The identical scene files boot
          // perfectly without it, so the template was never at fault.
          //
          // The sounds are returned for preview and can be put into the project with
          // godot_import_asset, which writes into the RUNNING editor where importing is safe.
          const audioTypes = ['laser_fire', 'rail_impact', 'energy_pickup', 'jump_boost', 'gate_warp', 'shield_down'];
          const generatedAudio = AudioEngine.synthesizeSuite(audioTypes, 0.4).map(aud => ({
            name: aud.name,
            filename: aud.filename,
            duration: aud.duration_seconds,
            license: aud.license,
            preview_data_url: aud.data_url
          }));

          try {
            await restartEditorWithProject(activeFilesDict, projName, 60000, operation);
            await validateProjectRuntimeBoot(operation, operation?.startedAt || 0, EditorCommandChannel.generation);
          } catch (error) {
            await restoreProjectSnapshot(previous, operation);
            throw error;
          }

          await advancePhase(operation, 'persisting_commit');
          DiagnosticState.sceneRevision++;
          DiagnosticHUD.render();
          BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);
          undoStack.push({
            undo_id: undoId,
            revision: DiagnosticState.sceneRevision,
            project_before: previous.projectName,
            main_scene_before: previous.mainScene,
            files_before: previous.files,
            project_after: projName,
            main_scene_after: activeMainScene,
            files_after: cloneProjectFiles(activeFilesDict)
          });
          const result = {
            success: true,
            project_name: projName,
            scene_revision: DiagnosticState.sceneRevision,
            undo_id: undoId,
            persisted: true,
            main_scene: 'res://main_3d.tscn',
            entities: {
              rail_length_meters: 900,
              hazards_count: 8,
              collectibles_count: 11,
              finish_gate_z: -800.0,
              lighting: 'WorldEnvironment (Daybreak HDRI + Mauve Fog)',
              camera: 'Third-Person ChaseCamera (FOV 68)'
            },
            audio_assets_generated: generatedAudio,
            audio_import_hint: 'Sounds are previews until imported. Add one with godot_import_asset once the editor is running; staging audio into the boot aborts the engine.',
            files_written: Object.keys(activeFilesDict)
          };
          storeIdempotentResult(idempotencyKey, fingerprint, result);
          result.persisted = await persistActiveProjectState();
          return result;
        }, 10000, { key: idempotencyKey, fingerprint }, context);
      }
    },
    {
      definition: {
        name: 'godot_synthesize_audio_suite',
        description: "Procedurally synthesizes a 6-piece 16-bit PCM sound suite in the browser, with duration, loudness and MIT licence metadata. By default this only returns previews: pass import_into_project to write them into the project as ordinary .wav files, imported by Godot like any other asset, plus an sfx_library.gd convenience wrapper. They appear in the FileSystem dock, load() returns an AudioStreamWAV, and they can be assigned to an AudioStreamPlayer in the Inspector. Reports per-file what Godot confirmed - that it imported and is loadable - rather than what was written.",
        input_schema: {
          type: 'object',
          properties: {
            import_into_project: { type: 'boolean', default: false, description: 'Also write the suite into the running editor and import it' },
            directory: { type: 'string', default: 'sfx', description: 'Project-relative folder for the imported files' }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const suite = AudioEngine.synthesizeSuite(null, 0.4);
        const wantsImport = args.import_into_project === true;
        const directory = cleanProjectPath(args.directory || 'sfx').replace(/\/+$/, '');
        const imported = [];
        let libraryPath = null;
        if (wantsImport) {
          if (!EditorCommandChannel.available()) {
            const error = new Error('The editor command plugin is not available, so the suite cannot be written into the project.');
            error.code = 'EDITOR_COMMAND_UNSUPPORTED';
            throw error;
          }
          // Ordinary .wav files, imported by Godot like any other asset. They were .wavdata
          // until the editor stopped booting with --audio-driver Dummy, which was what made
          // the import abort - see EDITOR_AUDIO_DRIVER.
          const generations = {
            lifecycle: typeof window !== 'undefined' ? (window.__godotEditorLifecycle?.generation || 0) : 0,
            command: EditorCommandChannel.generation
          };
          const payload = {};
          for (const asset of suite) {
            const path = directory ? `${directory}/${asset.name}.wav` : `${asset.name}.wav`;
            payload[path] = decodeUploadChunk(asset.data_url.split(',')[1], 'base64');
            imported.push({ name: asset.name, path: `res://${path}`, bytes: payload[path].byteLength });
          }
          libraryPath = directory ? `${directory}/sfx_library.gd` : 'sfx_library.gd';
          payload[libraryPath] = SFX_LIBRARY_SOURCE;
          const write = window.__godotEditorWriteFiles(payload, {
            expectLifecycleGeneration: generations.lifecycle,
            expectCommandGeneration: generations.command,
            projectName: DiagnosticState.activeProject
          });
          if (!write.ok) {
            const error = new Error(write.error || 'The editor filesystem refused the audio suite.');
            error.code = write.reason === 'generation_changed' ? 'EDITOR_GENERATION_CHANGED' : 'EDITOR_FS_COPY_FAILED';
            throw error;
          }
          // The samples are text-free project files, so they belong in the project model:
          // that is what carries them into an export, an undo snapshot and the next boot.
          for (const [path, content] of Object.entries(payload)) activeFilesDict[path] = content;
          DiagnosticState.sceneRevision += 1;
          await persistActiveProjectState();
          BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);
          // One scan picks up the whole directory; each sample is then confirmed individually
          // against what Godot itself reports, not against the write.
          const queued = EditorCommandChannel.call('asset_import', { path: `res://${libraryPath}`, reveal: true });
          if (queued.ok && queued.job_id) await HotScriptChannel.awaitJob(queued.job_id, 12000);
          for (const entry of imported) {
            const settled = await awaitAssetImport(entry.path, 8000);
            entry.on_disk = settled.exists === true;
            entry.bytes_on_disk = settled.size_bytes ?? null;
            entry.loadable = settled.loadable === true;
            entry.import_metadata_written = settled.has_import === true;
          }
        }
        return {
          suite_count: suite.length,
          imported_into_project: wantsImport,
          imported: wantsImport ? imported : null,
          imported_ok: wantsImport ? imported.filter(entry => entry.loadable === true).length : 0,
          runtime_loader: libraryPath ? `res://${libraryPath}` : null,
          // Said explicitly because the extension is unusual and deliberate.
          playback: wantsImport
            ? `The samples are ordinary imported .wav resources: load("res://${directory || '.'}/<name>.wav") returns an AudioStreamWAV, and they can be assigned to an AudioStreamPlayer in the Inspector. sfx_library.gd is a convenience wrapper - SfxLibrary.play(self, "<name>").`
            : null,
          assets: suite.map(a => ({
            name: a.name,
            filename: a.filename,
            format: a.format,
            codec: a.codec,
            sample_rate_hz: a.sample_rate_hz,
            duration_seconds: a.duration_seconds,
            lufs_loudness: a.lufs_loudness,
            license: a.license,
            author: a.author,
            preview_data_url: a.data_url
          }))
        };
      }
    },
    {
      definition: {
        name: 'godot_semantic_playtest_step',
        description: 'Executes a semantic playtest action (steer_left, steer_right, jump, boost, observe_state, restart_playtest) and returns structured telemetry',
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['steer_left', 'steer_right', 'jump', 'boost', 'observe_state', 'restart_playtest'] },
            step_duration_ms: { type: 'number', default: 200 }
          },
          required: ['action'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const runnerProject = 'player_runner.gd' in activeFilesDict && 'main_3d.gd' in activeFilesDict;
        if (!runnerProject) {
          throw new Error(`Neon Skyrail semantic simulation is unavailable for active project '${DiagnosticState.activeProject}'. Use godot_get_game_telemetry for a custom project's emitted runtime state.`);
        }
        const action = args.action || 'observe_state';
        const duration = args.step_duration_ms || 200;
        return PlaytestSimulation.step(action, duration);
      }
    },
    {
      definition: {
        name: 'godot_get_game_telemetry',
        description: 'Reads project-owned runtime telemetry emitted as godot-game-telemetry events; never substitutes simulated state for custom games',
        input_schema: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 } },
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        const limit = Math.max(1, Math.min(Number(args.limit) || 10, 100));
        return {
          supported: Boolean(GameTelemetryState.latest),
          project_name: DiagnosticState.activeProject,
          latest: GameTelemetryState.latest,
          recent: GameTelemetryState.recent.slice(-limit)
        };
      }
    },
    {
      definition: {
        name: 'godot_export_zip',
        description: 'Packages the active project and an explicit per-file provenance manifest into a standard downloadable ZIP archive',
        input_schema: {
          type: 'object',
          properties: {
            project_name: { type: 'string' },
            provenance: {
              type: 'object',
              description: 'Optional map of project paths to source/license/author/url metadata',
              additionalProperties: {
                type: 'object',
                properties: { source: { type: 'string' }, license: { type: 'string' }, author: { type: 'string' }, url: { type: 'string' } },
                additionalProperties: false
              }
            }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const projName = args.project_name || DiagnosticState.activeProject || 'neon_skyrail_3d';
        if (Object.keys(activeFilesDict).length === 0) {
          throw new Error('No authored project files are available to export. Create or restore a project before requesting a ZIP.');
        }

        const generatedProject = ('player_runner.gd' in activeFilesDict && 'main_3d.gd' in activeFilesDict)
          || ('botanist_player.gd' in activeFilesDict && 'orbital_sanctuary.gd' in activeFilesDict);
        const suppliedProvenance = args.provenance && typeof args.provenance === 'object' ? args.provenance : {};
        const fileProvenance = {};
        for (const filePath of Object.keys(activeFilesDict)) {
          const supplied = suppliedProvenance[filePath] || suppliedProvenance[`res://${filePath}`];
          // An asset the caller imported was not generated here, whatever the rest of the
          // project is, and this page cannot know its licence. Saying MIT over someone else's
          // model is the kind of claim a provenance manifest exists to prevent.
          const imported = DiagnosticState.importedAssets.has(filePath);
          fileProvenance[filePath] = supplied || (imported
            ? { source: 'imported_via_godot_import_asset', license: 'unspecified' }
            : {
              source: generatedProject ? 'generated_by_godot_webmcp' : 'user_supplied_via_webmcp',
              license: generatedProject ? 'MIT' : 'unspecified'
            });
        }
        for (const rawPath of Object.keys(suppliedProvenance)) {
          const filePath = cleanProjectPath(rawPath);
          if (!(filePath in activeFilesDict)) throw new Error(`Provenance references a file outside the active project: ${rawPath}`);
        }
        const provenanceManifest = {
          schema_version: 1,
          project_name: DiagnosticState.activeProject,
          exported_at: new Date().toISOString(),
          files: fileProvenance
        };
        const exportFiles = cloneProjectFiles(activeFilesDict);
        exportFiles['WEBMCP_PROVENANCE.json'] = JSON.stringify(provenanceManifest, null, 2);
        const zipBytes = ZipBuilder.createZip(exportFiles);
        let binary = '';
        for (let i = 0; i < zipBytes.byteLength; i++) binary += String.fromCharCode(zipBytes[i]);
        const base64 = typeof btoa !== 'undefined' ? btoa(binary) : '';

        return {
          filename: `${projName}.zip`,
          total_files: Object.keys(exportFiles).length,
          zip_size_bytes: zipBytes.length,
          data_url: `data:application/zip;base64,${base64}`,
          manifest: Object.keys(exportFiles),
          provenance_manifest: 'WEBMCP_PROVENANCE.json',
          license_summary: [...new Set(Object.values(fileProvenance).map(record => record.license || 'unspecified'))]
        };
      }
    },
    {
      definition: {
        name: 'godot_begin_project_upload',
        description: 'Begins a transport-safe staged custom-project upload; send each file through bounded sequential chunks before committing',
        input_schema: {
          type: 'object',
          properties: { project_name: { type: 'string' } },
          required: ['project_name'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        const projectName = cleanProjectName(args.project_name);
        if (projectUploads.size >= 4) throw new Error('At most four staged project uploads may be active. Abort one before beginning another.');
        const now = Date.now();
        const upload = { id: `upload_${now}_${Math.random().toString(36).slice(2, 8)}`, projectName, createdAt: now, updatedAt: now, totalBytes: 0, files: new Map() };
        projectUploads.set(upload.id, upload);
        const persisted = await persistProjectUpload(upload);
        return { success: true, status: 'staging', persisted, ...publicProjectUpload(upload) };
      }
    },
    {
      definition: {
        name: 'godot_upload_project_file_chunk',
        description: 'Appends one bounded UTF-8 or base64 chunk to a staged project file using an exact decoded-byte offset',
        input_schema: {
          type: 'object',
          properties: {
            upload_id: { type: 'string' },
            path: { type: 'string' },
            encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
            offset: { type: 'integer', minimum: 0 },
            content: { type: 'string', maxLength: 700000 },
            final: { type: 'boolean', default: false }
          },
          required: ['upload_id', 'path', 'offset', 'content'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        const upload = projectUploads.get(args.upload_id);
        if (!upload) throw new Error(`Unknown or expired project upload: ${args.upload_id}`);
        const filePath = cleanProjectPath(args.path);
        const encoding = args.encoding || 'utf8';
        const bytes = decodeUploadChunk(args.content, encoding);
        let file = upload.files.get(filePath);
        const expectedOffset = file?.receivedBytes || 0;
        if (file?.complete) throw new Error(`Project upload file is already complete: res://${filePath}`);
        if (file && file.encoding !== encoding) throw new Error(`Project upload encoding changed for res://${filePath}.`);
        if (args.offset !== expectedOffset) throw new Error(`Project upload offset mismatch for res://${filePath}: expected ${expectedOffset}, received ${args.offset}.`);
        if (upload.totalBytes + bytes.byteLength > PROJECT_UPLOAD_TOTAL_BYTES) throw new Error('Staged project exceeds the 25 MB authoring limit.');
        if (!file) {
          file = { encoding, chunks: [], receivedBytes: 0, complete: false };
          upload.files.set(filePath, file);
        }
        const chunkIndex = file.chunks.length;
        file.chunks.push(bytes);
        file.receivedBytes += bytes.byteLength;
        file.complete = args.final === true;
        upload.totalBytes += bytes.byteLength;
        upload.updatedAt = Date.now();
        const persisted = await persistProjectUpload(upload, { path: filePath, index: chunkIndex, bytes });
        return { success: true, status: file.complete ? 'file_complete' : 'chunk_accepted', persisted, ...publicProjectUpload(upload) };
      }
    },
    {
      definition: {
        name: 'godot_upload_project_chunk_batch',
        description: 'Atomically appends up to four transport-safe project chunks in one call, with a 2 MiB decoded batch limit',
        input_schema: {
          type: 'object',
          properties: {
            upload_id: { type: 'string' },
            chunks: {
              type: 'array', minItems: 1, maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
                  offset: { type: 'integer', minimum: 0 },
                  content: { type: 'string', maxLength: 700000 },
                  final: { type: 'boolean', default: false }
                },
                required: ['path', 'offset', 'content'], additionalProperties: false
              }
            }
          },
          required: ['upload_id', 'chunks'], additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        const current = projectUploads.get(args.upload_id);
        if (!current) throw new Error(`Unknown or expired project upload: ${args.upload_id}`);
        if (!Array.isArray(args.chunks) || args.chunks.length < 1 || args.chunks.length > 4) throw new Error('A chunk batch requires 1–4 chunks.');
        const staged = cloneStagedProjectUpload(current);
        const appended = [];
        let batchBytes = 0;
        for (const chunk of args.chunks) {
          const filePath = cleanProjectPath(chunk.path);
          const encoding = chunk.encoding || 'utf8';
          const bytes = decodeUploadChunk(chunk.content, encoding);
          batchBytes += bytes.byteLength;
          if (batchBytes > PROJECT_UPLOAD_CHUNK_BYTES * 4) throw new Error('Project upload batches may contain at most 2 MiB decoded data.');
          let file = staged.files.get(filePath);
          const expectedOffset = file?.receivedBytes || 0;
          if (file?.complete) throw new Error(`Project upload file is already complete: res://${filePath}`);
          if (file && file.encoding !== encoding) throw new Error(`Project upload encoding changed for res://${filePath}.`);
          if (chunk.offset !== expectedOffset) throw new Error(`Project upload offset mismatch for res://${filePath}: expected ${expectedOffset}, received ${chunk.offset}.`);
          if (staged.totalBytes + bytes.byteLength > PROJECT_UPLOAD_TOTAL_BYTES) throw new Error('Staged project exceeds the 25 MB authoring limit.');
          if (!file) {
            file = { encoding, chunks: [], receivedBytes: 0, complete: false };
            staged.files.set(filePath, file);
          }
          const index = file.chunks.length;
          file.chunks.push(bytes);
          file.receivedBytes += bytes.byteLength;
          file.complete = chunk.final === true;
          staged.totalBytes += bytes.byteLength;
          appended.push({ path: filePath, index, bytes });
        }
        staged.updatedAt = Date.now();
        await persistProjectUploadBatch(staged, appended);
        projectUploads.set(staged.id, staged);
        return { success: true, status: 'batch_accepted', chunks_accepted: appended.length, batch_bytes: batchBytes, persisted: true, ...publicProjectUpload(staged) };
      }
    },
    {
      definition: {
        name: 'godot_get_project_upload_status',
        description: 'Inspects staged project upload progress without returning uploaded contents',
        input_schema: { type: 'object', properties: { upload_id: { type: 'string' } }, required: ['upload_id'], additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const upload = projectUploads.get(args.upload_id);
        if (!upload) throw new Error(`Unknown or expired project upload: ${args.upload_id}`);
        return { success: true, status: 'staging', ...publicProjectUpload(upload) };
      }
    },
    {
      definition: {
        name: 'godot_abort_project_upload',
        description: 'Removes one staged project upload and all of its persisted chunks without changing the active Godot project',
        input_schema: { type: 'object', properties: { upload_id: { type: 'string' } }, required: ['upload_id'], additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        if (!projectUploads.has(args.upload_id)) throw new Error(`Unknown or expired project upload: ${args.upload_id}`);
        await deletePersistedProjectUpload(args.upload_id);
        projectUploads.delete(args.upload_id);
        return { success: true, status: 'aborted', upload_id: args.upload_id };
      }
    },
    {
      definition: {
        name: 'godot_commit_project_upload',
        description: 'Validates and transactionally boots a completed staged project through the same acknowledged custom-project authoring path',
        input_schema: {
          type: 'object',
          properties: { upload_id: { type: 'string' }, idempotency_key: { type: 'string' } },
          required: ['upload_id'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}, context = {}) => {
        const upload = projectUploads.get(args.upload_id);
        if (!upload) {
          const receipt = args.idempotency_key ? idempotentMutations.get(args.idempotency_key) : null;
          if (receipt?.metadata?.source_upload_id === args.upload_id || receipt?.result?.upload_receipt_id === args.upload_id) {
            return { ...receipt.result, upload_id: args.upload_id, idempotent_replay: true };
          }
          throw new Error(`Unknown or expired project upload: ${args.upload_id}`);
        }
        const files = assembleProjectUpload(upload);
        const createTool = MANIFEST_TOOLS.find(entry => entry.definition.name === 'godot_create_project');
        if (!createTool) throw new Error('Custom project commit handler is unavailable.');
        const result = await createTool.handler({ project_name: upload.projectName, template: 'custom', files, idempotency_key: args.idempotency_key, _upload_id: upload.id }, context);
        return { ...result, upload_id: upload.id, staged_total_bytes: upload.totalBytes };
      }
    },
    {
      definition: {
        name: 'godot_create_project',
        description: "Creates a Godot project from a built-in template or an explicit file set, and REPLACES the running editor to open it. Because that takes several seconds it may return {status: 'pending', operation_id} instead of a result - poll godot_get_operation_status until it reports succeeded before calling any other tool, or the next call will be refused while the editor is being torn down. Audio is never staged into a project: add it afterwards with godot_synthesize_audio_suite, and other assets with godot_import_asset.",
        input_schema: {
          type: 'object',
          properties: {
            project_name: { type: 'string', default: 'echoes_of_the_orbital_garden' },
            template: { type: 'string', enum: PROJECT_TEMPLATES, default: 'orbital_garden', description: 'orbital_garden is a 3D sanctuary with a CharacterBody3D player and camera; neon_skyrail_3d is a 3D endless runner; custom requires files.' },
            files: { type: 'object', description: 'Custom dictionary of file paths to source strings/buffers to write into res://' },
            idempotency_key: { type: 'string' }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}, context = {}) => {
        const projName = cleanProjectName(args.project_name || 'echoes_of_the_orbital_garden');
        const idempotencyKey = args.idempotency_key;
        const fingerprint = mutationFingerprint('godot_create_project', args);

        if (args.template === 'custom' && (!args.files || Object.keys(args.files).length === 0)) {
          throw new Error('The custom template requires a non-empty files dictionary. No fallback template was created.');
        }
        // An unrecognised template used to fall through to orbital_garden, so asking for '3d'
        // quietly built a different project than the one requested and reported success.
        if (args.template !== undefined && !PROJECT_TEMPLATES.includes(args.template)) {
          throw new Error(`Unknown template '${args.template}'. Valid templates are: ${PROJECT_TEMPLATES.join(', ')}. Use 'custom' with a files dictionary to supply your own.`);
        }

        return runManagedMutation('godot_create_project', `Creating project: ${projName}`, async (operation) => {
          await advancePhase(operation, 'validating_request');
          const previous = {
          projectName: DiagnosticState.activeProject,
          mainScene: activeMainScene,
          files: cloneProjectFiles(activeFilesDict),
          session: DiagnosticState.session,
          engine: DiagnosticState.engine
        };
        const undoId = `undo_proj_${Date.now()}`;

        let mainScene = 'res://main_3d.tscn';
        let projectType = args.template || 'custom';
        let stagedFiles;

        await advancePhase(operation, 'staging_files');
        // Check if custom files are provided
        if (args.files && Object.keys(args.files).length > 0) {
          stagedFiles = Object.fromEntries(Object.entries(args.files).map(([filePath, content]) => [cleanProjectPath(filePath), content]));
          projectType = 'custom_injected';
          mainScene = inferMainScene(stagedFiles);
        } else if (args.template === 'neon_skyrail_3d' || projName.includes('skyrail') || projName.includes('runner')) {
          stagedFiles = {
            'project.godot': NeonSkyrail.generateProjectGodot(),
            'main_3d.tscn': NeonSkyrail.generateMain3dScene(),
            'main_3d.gd': NeonSkyrail.generateMain3dGd(),
            'player_runner.tscn': NeonSkyrail.generatePlayerTscn(),
            'player_runner.gd': NeonSkyrail.generatePlayerGd()
          };
          mainScene = 'res://main_3d.tscn';
          projectType = 'neon_skyrail_3d';
        } else {
          // Default to Echoes of the Orbital Garden 3D Botanical Sanctuary
          stagedFiles = {
            'project.godot': OrbitalGarden.generateProjectGodot(projName),
            'orbital_sanctuary.tscn': OrbitalGarden.generateSanctuaryScene(),
            'orbital_sanctuary.gd': OrbitalGarden.generateSanctuaryGd(),
            'botanist_player.tscn': OrbitalGarden.generateBotanistTscn(),
            'botanist_player.gd': OrbitalGarden.generateBotanistGd()
          };
          mainScene = 'res://orbital_sanctuary.tscn';
          projectType = 'orbital_garden';
        }
        const stagedNormalization = normalizeProjectTextResources(stagedFiles);
        stagedFiles = stagedNormalization.files;
        validateProjectFiles(stagedFiles);
        DiagnosticState.activeProject = projName;
        activeFilesDict = stagedFiles;
        activeMainScene = mainScene;

        try {
          await restartEditorWithProject(activeFilesDict, projName, 60000, operation);
          await validateProjectRuntimeBoot(operation, operation?.startedAt || 0, EditorCommandChannel.generation);
        } catch (error) {
          await restoreProjectSnapshot(previous, operation);
          throw error;
        }

        await advancePhase(operation, 'persisting_commit');
        DiagnosticState.sceneRevision++;
        DiagnosticHUD.render();
        BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);
        undoStack.push({
          undo_id: undoId,
          revision: DiagnosticState.sceneRevision,
          project_before: previous.projectName,
          main_scene_before: previous.mainScene,
          files_before: previous.files,
          project_after: projName,
          main_scene_after: activeMainScene,
          files_after: cloneProjectFiles(activeFilesDict)
        });
        const result = {
          success: true,
          project_name: projName,
          template_type: projectType,
          scene_revision: DiagnosticState.sceneRevision,
          undo_id: undoId,
          persisted: true,
          main_scene: mainScene,
          files_written: Object.keys(activeFilesDict),
          message: `Project '${projName}' created successfully with ${projectType} template architecture.`,
          normalized_text_resource_escapes: stagedNormalization.repairs,
          ...(args._upload_id ? { upload_receipt_id: args._upload_id } : {})
        };

          storeIdempotentResult(idempotencyKey, fingerprint, result, { source_upload_id: args._upload_id || null });
          result.persisted = await persistActiveProjectState();
          return result;
        }, 10000, { key: idempotencyKey, fingerprint }, context);
      }
    },
    {
      definition: {
        name: 'godot_inspect_project_files',
        description: 'Inspects the authoritative in-memory project manifest and optionally returns selected text source files for revision-safe editing',
        input_schema: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' }, maxItems: 64 },
            include_content: { type: 'boolean', default: false }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const requested = Array.isArray(args.paths) && args.paths.length > 0
          ? new Set(args.paths.map(cleanProjectPath))
          : null;
        const files = Object.entries(activeFilesDict)
          .filter(([filePath]) => !requested || requested.has(filePath))
          .map(([filePath, content]) => {
            const isText = typeof content === 'string';
            const sizeBytes = isText ? new TextEncoder().encode(content).byteLength : content.byteLength;
            return {
              path: `res://${filePath}`,
              kind: isText ? 'text' : 'binary',
              size_bytes: sizeBytes,
              ...(args.include_content && isText ? { content } : {})
            };
          });
        return {
          success: true,
          project_name: DiagnosticState.activeProject,
          main_scene: activeMainScene,
          scene_revision: DiagnosticState.sceneRevision,
          file_count: files.length,
          files
        };
      }
    },
    {
      definition: {
        name: 'godot_inspect_scene_graph',
        description: 'Returns the durable authored Godot scene graph so collaborators can verify which visible objects are editable in the 3D editor, rather than runtime-only script output',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async () => ({
        success: true,
        project_name: DiagnosticState.activeProject,
        scene_revision: DiagnosticState.sceneRevision,
        ...sceneGraphFromFiles(activeFilesDict)
      })
    },
    {
      definition: {
        name: 'godot_apply_file_transaction',
        description: 'Revision-checked atomic project edit. Eligible GDScript-only writes use the running editor hot channel; deletes and other project-file edits replace the editor. It commits only after the applicable acknowledgement and records an undo snapshot.',
        input_schema: {
          type: 'object',
          properties: {
            expected_revision: { type: 'integer', minimum: 1 },
            label: { type: 'string' },
            operations: {
              type: 'array',
              minItems: 1,
              maxItems: 64,
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['write', 'delete'] },
                  path: { type: 'string' },
                  content: { type: 'string' }
                },
                required: ['kind', 'path'],
                additionalProperties: false
              }
            },
            idempotency_key: { type: 'string' }
          },
          required: ['expected_revision', 'operations'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}, context = {}) => {
        const fingerprint = args._mutation_fingerprint || mutationFingerprint('godot_apply_file_transaction', args);
        const replay = getIdempotentReplay(args.idempotency_key, fingerprint);
        if (replay) return replay;
        if (args.expected_revision !== DiagnosticState.sceneRevision) {
          throw new Error(`Revision conflict: expected ${args.expected_revision}, current ${DiagnosticState.sceneRevision}. Inspect before editing.`);
        }
        if (!Array.isArray(args.operations) || args.operations.length === 0) throw new Error('At least one file operation is required.');

        return runManagedMutation('godot_apply_file_transaction', `Applying file transaction: ${args.label || 'Project update'}`, async (operation) => {
          await advancePhase(operation, 'validating_request');
          // A transaction that only writes project .gd scripts does not need a new editor.
          // Routed here rather than at the tool boundary so godot_apply_text_patch, which
          // delegates to this handler, gets the live channel for free. Anything else — a
          // project.godot change, a delete, a binary asset, a mixed transaction — falls
          // through to the editor replacement below, which for those is the honest path.
          const hotPlan = hotScriptTransactionPlan(args.operations);
          if (hotPlan.eligible && EditorCommandChannel.available()) {
            const outcome = await runHotScriptTransaction({
              operations: args.operations,
              label: args.label || 'Project file transaction',
              operation
            });
            if (outcome.hot) {
              const hotResult = { ...outcome, label: args.label || 'Project file transaction' };
              storeIdempotentResult(args.idempotency_key, fingerprint, hotResult);
              return hotResult;
            }
            // The channel dropped out between the availability check and the preflight. Fall
            // through to the replacement path rather than failing the caller's edit.
            activeLogs.push({
              level: 'warning',
              time: Date.now(),
              generation: EditorCommandChannel.generation,
              msg: `[Hot script channel] falling back to editor replacement: ${outcome.reason}`
            });
            if (activeLogs.length > MAX_LOGS) activeLogs.shift();
          }
          const previousFiles = cloneProjectFiles(activeFilesDict);
        const previousMainScene = activeMainScene;
        const restorePlaytest = typeof window !== 'undefined' && window.__godotGameState === 'running';
        if (typeof window !== 'undefined') window.__godotWebMcpKeepRuntimeFrame = restorePlaytest;
        let stagedFiles = cloneProjectFiles(activeFilesDict);
        const changedPaths = [];
        for (const op of args.operations) {
          const filePath = cleanProjectPath(op.path);
          if (op.kind === 'write') {
            if (typeof op.content !== 'string') throw new Error(`Write operation requires text content: ${filePath}`);
            stagedFiles[filePath] = op.content;
          } else if (op.kind === 'delete') {
            if (!(filePath in stagedFiles)) throw new Error(`Cannot delete missing project file: ${filePath}`);
            delete stagedFiles[filePath];
          } else {
            throw new Error(`Unsupported file operation: ${op.kind}`);
          }
          changedPaths.push(`res://${filePath}`);
        }
        const transactionNormalization = normalizeProjectTextResources(stagedFiles);
        stagedFiles = transactionNormalization.files;
        await advancePhase(operation, 'staging_files');
        const validation = validateProjectFiles(stagedFiles);
        const stagedMainScene = inferMainScene(stagedFiles);

        try {
          await restartEditorWithProject(stagedFiles, DiagnosticState.activeProject, 60000, operation);
          await validateProjectRuntimeBoot(operation, operation?.startedAt || 0, EditorCommandChannel.generation);
        } catch (error) {
          try { await restartEditorWithProject(previousFiles, DiagnosticState.activeProject, 60000, operation); } catch (_) {}
          releaseRuntimeFrame();
          throw error;
        } finally {
          if (typeof window !== 'undefined') window.__godotWebMcpKeepRuntimeFrame = false;
        }

        await advancePhase(operation, 'persisting_commit');
        activeFilesDict = stagedFiles;
        activeMainScene = stagedMainScene;
        DiagnosticState.sceneRevision++;
        DiagnosticHUD.render();
        BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);
        const undoId = `undo_files_${Date.now()}`;
        undoStack.push({
          undo_id: undoId,
          revision: DiagnosticState.sceneRevision,
          label: args.label || 'Project file transaction',
          project_before: DiagnosticState.activeProject,
          main_scene_before: previousMainScene,
          files_before: previousFiles,
          project_after: DiagnosticState.activeProject,
          main_scene_after: stagedMainScene,
          files_after: cloneProjectFiles(stagedFiles)
        });
        const result = {
          success: true,
          label: args.label || 'Project file transaction',
          scene_revision: DiagnosticState.sceneRevision,
          undo_id: undoId,
          persisted: true,
          changed_paths: changedPaths,
          main_scene: activeMainScene,
          file_count: validation.fileCount,
          total_bytes: validation.totalBytes,
          normalized_text_resource_escapes: transactionNormalization.repairs,
          editor_acknowledged: true
        };
          storeIdempotentResult(args.idempotency_key, fingerprint, result);
          result.persisted = await persistActiveProjectState();
          if (restorePlaytest) {
            // Keep the collaborator in the same playable surface after the acknowledged
            // source transaction; the browser page itself never needs to reload.
            try {
              await startGameRuntime({ visible: true, timeoutMs: 60000 });
              DiagnosticState.session = 'playtesting';
              DiagnosticHUD.render();
              releaseRuntimeFrame();
            } catch (previewError) {
              activeLogs.push({ level: 'warning', time: Date.now(), msg: `[Preview Restore] ${previewError.message || String(previewError)}` });
              if (activeLogs.length > MAX_LOGS) activeLogs.shift();
              if (typeof window.showTab === 'function') window.showTab('editor');
              releaseRuntimeFrame();
            }
          } else {
            releaseRuntimeFrame();
          }
          return result;
        }, 10000, { key: args.idempotency_key, fingerprint }, context);
      }
    },
    {
      definition: {
        name: 'godot_apply_script_patch',
        description: "Revision-checked GDScript creation or exact-patch editing applied to the RUNNING Godot editor without replacing it. Copies candidate bytes into the live editor filesystem, has Godot refresh and recompile the script on a deferred editor frame, and publishes only after Godot acknowledges the path, source hash, and compilation. A compile failure restores the previous bytes and leaves the revision untouched. It never launches the game or restarts the editor. With workspace follow enabled it opens the Script workspace at the changed lines; with follow disabled it preserves the current workspace and only reveals the file in the FileSystem dock. Reports changed line ranges, before/after hashes, compilation result, diagnostics, persistence, navigation, and preview freshness as independent facts.",
        input_schema: {
          type: 'object',
          properties: {
            expected_revision: { type: 'integer', minimum: 1 },
            path: { type: 'string', description: 'res:// path of the .gd script to create or edit.' },
            content: { type: 'string', description: 'Complete script source. Use for creation or full replacement; mutually exclusive with patches.' },
            patches: {
              type: 'array', minItems: 1, maxItems: 32,
              description: 'Exact search/replace patches applied to the existing script source.',
              items: {
                type: 'object',
                properties: {
                  find: { type: 'string', minLength: 1 },
                  replace: { type: 'string' },
                  expected_occurrences: { type: 'integer', minimum: 1, maximum: 100, default: 1 }
                },
                required: ['find', 'replace'],
                additionalProperties: false
              }
            },
            attach_to_node_path: { type: 'string', description: 'Optional scene-relative node path to attach the script to through the editor UndoRedo stack.' },
            attach_scene_path: { type: 'string', description: 'Scene whose authoritative .tscn source records the attachment. Defaults to the main scene.' },
            label: { type: 'string' },
            idempotency_key: { type: 'string' }
          },
          required: ['expected_revision', 'path'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}, context = {}) => {
        const fingerprint = mutationFingerprint('godot_apply_script_patch', args);
        const replay = getIdempotentReplay(args.idempotency_key, fingerprint);
        if (replay) return replay;
        if (args.expected_revision !== DiagnosticState.sceneRevision) {
          const error = new Error(`Revision conflict: expected ${args.expected_revision}, current ${DiagnosticState.sceneRevision}. Inspect before patching.`);
          error.code = 'REVISION_CONFLICT';
          throw error;
        }
        const path = cleanProjectPath(args.path);
        if (!isHotScriptEligiblePath(path)) {
          throw new Error(`godot_apply_script_patch only edits project .gd scripts; res://${path} is not one. Use godot_apply_file_transaction.`);
        }
        const hasContent = typeof args.content === 'string';
        const hasPatches = Array.isArray(args.patches) && args.patches.length > 0;
        if (hasContent === hasPatches) {
          throw new Error('Provide exactly one of `content` (create or replace) or `patches` (exact edits).');
        }

        let nextSource;
        const patchSummary = [];
        if (hasContent) {
          nextSource = args.content;
        } else {
          const current = activeFilesDict[path];
          if (typeof current !== 'string') {
            throw new Error(`Cannot patch res://${path}: it is not an existing text file. Pass \`content\` to create it.`);
          }
          nextSource = current;
          for (const patch of args.patches) {
            const expected = Number.isInteger(patch.expected_occurrences) ? patch.expected_occurrences : 1;
            const occurrences = nextSource.split(patch.find).length - 1;
            if (occurrences !== expected) {
              const error = new Error(`Patch occurrence mismatch in res://${path}: expected ${expected}, found ${occurrences}. No files were changed.`);
              error.code = 'PATCH_OCCURRENCE_MISMATCH';
              throw error;
            }
            nextSource = nextSource.split(patch.find).join(patch.replace);
            patchSummary.push({ path: `res://${path}`, occurrences });
          }
        }

        const label = args.label || (hasContent && typeof activeFilesDict[path] !== 'string' ? `Creating ${path}` : `Editing ${path}`);
        return runManagedMutation('godot_apply_script_patch', label, async (operation) => {
          if (!EditorCommandChannel.available()) {
            // No live channel means no live edit. Rather than silently replacing the editor
            // under a tool that promises not to, say which tool does that.
            throw new Error(`The WebMCP editor plugin is not available (${EditorCommandChannel.unavailableReason}); use godot_apply_file_transaction, which replaces the editor.`);
          }
          const outcome = await runHotScriptTransaction({
            operations: [{ kind: 'write', path, content: nextSource }],
            label,
            operation,
            attach: args.attach_to_node_path
              ? { node_path: args.attach_to_node_path, script_path: path, scene_path: args.attach_scene_path }
              : null
          });
          if (!outcome.hot) {
            throw new Error(`The live script channel is unavailable (${outcome.reason}); use godot_apply_file_transaction.`);
          }
          const result = { ...outcome, ...(patchSummary.length ? { patch_summary: patchSummary } : {}) };
          storeIdempotentResult(args.idempotency_key, fingerprint, result);
          return result;
        }, 10000, { key: args.idempotency_key, fingerprint }, context);
      }
    },
    {
      definition: {
        name: 'godot_apply_text_patch',
        description: 'Applies exact revision-checked search/replace patches to project text files, then delegates to the same acknowledged editor/runtime transaction and undo path',
        input_schema: {
          type: 'object',
          properties: {
            expected_revision: { type: 'integer', minimum: 1 },
            label: { type: 'string' },
            patches: {
              type: 'array', minItems: 1, maxItems: 32,
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  find: { type: 'string', minLength: 1 },
                  replace: { type: 'string' },
                  expected_occurrences: { type: 'integer', minimum: 1, maximum: 100, default: 1 }
                },
                required: ['path', 'find', 'replace'],
                additionalProperties: false
              }
            },
            idempotency_key: { type: 'string' }
          },
          required: ['expected_revision', 'patches'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}, context = {}) => {
        const fingerprint = mutationFingerprint('godot_apply_text_patch', args);
        const replay = getIdempotentReplay(args.idempotency_key, fingerprint);
        if (replay) return replay;
        if (args.expected_revision !== DiagnosticState.sceneRevision) {
          throw new Error(`Revision conflict: expected ${args.expected_revision}, current ${DiagnosticState.sceneRevision}. Inspect before patching.`);
        }
        if (!Array.isArray(args.patches) || args.patches.length === 0) throw new Error('At least one exact text patch is required.');
        const stagedText = new Map();
        const patchSummary = [];
        for (const patch of args.patches) {
          const filePath = cleanProjectPath(patch.path);
          const current = stagedText.has(filePath) ? stagedText.get(filePath) : activeFilesDict[filePath];
          if (typeof current !== 'string') throw new Error(`Text patch requires an existing text file: res://${filePath}`);
          if (typeof patch.find !== 'string' || patch.find.length === 0) throw new Error(`Text patch find value must be non-empty: res://${filePath}`);
          if (typeof patch.replace !== 'string') throw new Error(`Text patch replacement must be text: res://${filePath}`);
          const expected = Number.isInteger(patch.expected_occurrences) ? patch.expected_occurrences : 1;
          const occurrences = current.split(patch.find).length - 1;
          if (occurrences !== expected) {
            throw new Error(`Patch occurrence mismatch in res://${filePath}: expected ${expected}, found ${occurrences}. No files were changed.`);
          }
          stagedText.set(filePath, current.split(patch.find).join(patch.replace));
          patchSummary.push({ path: `res://${filePath}`, occurrences });
        }
        const fileTool = MANIFEST_TOOLS.find(entry => entry.definition.name === 'godot_apply_file_transaction');
        if (!fileTool) throw new Error('Acknowledged file transaction handler is unavailable.');
        const result = await fileTool.handler({
          expected_revision: args.expected_revision,
          label: args.label || 'Exact text patch',
          operations: [...stagedText.entries()].map(([path, content]) => ({ kind: 'write', path, content })),
          idempotency_key: args.idempotency_key,
          _mutation_fingerprint: fingerprint
        }, context);
        return { ...result, patch_summary: patchSummary };
      }
    },
    {
      definition: {
        name: 'godot_undo_transaction',
        description: 'Restores the exact project snapshot captured by the most recent acknowledged authoring transaction. Hot GDScript transactions undo through the running editor without a restart; transactions that changed other project files may replace the editor.',
        input_schema: {
          type: 'object',
          properties: { undo_id: { type: 'string' } },
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        return runManagedMutation('godot_undo_transaction', `Undoing transaction: ${args.undo_id || 'latest'}`, async () => {
          const transaction = args.undo_id
          ? [...undoStack].reverse().find(entry => entry.undo_id === args.undo_id)
          : undoStack.at(-1);
        if (!transaction) throw new Error('No matching undo transaction is available.');
        if (transaction !== undoStack.at(-1)) {
          throw new Error(`Undo must follow stack order. Latest is ${undoStack.at(-1)?.undo_id}; refusing historical transaction ${transaction.undo_id}.`);
        }
        if (!transaction.files_before) throw new Error(`Undo transaction ${transaction.undo_id} has no restorable project snapshot.`);

        if (transaction.editor_channel === 'script_command') {
          const generations = {
            lifecycle: typeof window !== 'undefined' ? (window.__godotEditorLifecycle?.generation || 0) : 0,
            command: EditorCommandChannel.generation
          };
          const rollback = await rollbackHotScripts(
            transaction.files_before,
            transaction.hot_script_paths || [],
            generations
          );
          if (!rollback.ok) {
            DiagnosticState.hotScriptDirty = {
              paths: (transaction.hot_script_paths || []).map(path => `res://${path}`),
              at: Date.now(),
              restore_error: rollback.error || null
            };
            DiagnosticState.session = 'dirty_unpersisted';
            throw new Error(`Hot undo could not restore the previous scripts: ${rollback.error || 'unknown error'}`);
          }
          if (transaction.script_attachment) {
            const restoredAttachment = EditorCommandChannel.call('node_script_restore', {
              node_path: transaction.script_attachment.node_path,
              script_path: transaction.script_attachment.previous_script || ''
            });
            if (!restoredAttachment.ok) {
              DiagnosticState.session = 'dirty_unpersisted';
              throw new Error(`Hot undo restored the script files but not the node attachment: ${restoredAttachment.error}`);
            }
          }
          undoStack.pop();
          activeFilesDict = cloneProjectFiles(transaction.files_before);
          activeMainScene = transaction.main_scene_before;
          DiagnosticState.sceneRevision += 1;
          const persisted = await persistActiveProjectState();
          DiagnosticState.session = persisted ? 'editor-ready' : 'dirty_unpersisted';
          DiagnosticHUD.render();
          BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);
          const previewState = await refreshVisiblePlaytest();
          return {
            success: true,
            undone_id: transaction.undo_id,
            scene_revision: DiagnosticState.sceneRevision,
            persisted,
            editor_channel: 'script_command',
            editor_restarted: false,
            preview_state: previewState,
            restored_paths: transaction.hot_script_paths.map(path => `res://${path}`)
          };
        }

        const current = {
          projectName: DiagnosticState.activeProject,
          mainScene: activeMainScene,
          files: cloneProjectFiles(activeFilesDict),
          session: DiagnosticState.session,
          engine: DiagnosticState.engine
        };

        try {
          if (Object.keys(transaction.files_before).length === 0) {
            if (typeof window.closeEditor === 'function') window.closeEditor();
            await waitFor(() => document.getElementById('btn-close-editor')?.disabled, 12000);
            if (typeof window.showTab === 'function') window.showTab('loader');
            activeFilesDict = {};
            DiagnosticState.activeProject = transaction.project_before;
            activeMainScene = transaction.main_scene_before;
            DiagnosticState.session = 'empty';
            DiagnosticState.engine = 'loading';
          } else {
            await restartEditorWithProject(transaction.files_before, transaction.project_before);
            await validateProjectRuntimeBoot();
            activeFilesDict = cloneProjectFiles(transaction.files_before);
            DiagnosticState.activeProject = transaction.project_before;
            activeMainScene = transaction.main_scene_before;
          }
        } catch (error) {
          await restoreProjectSnapshot(current);
          throw error;
        }
        const index = undoStack.indexOf(transaction);
        undoStack.splice(index, 1);
        DiagnosticState.sceneRevision++;
        DiagnosticHUD.render();
        BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);
        const persisted = await persistActiveProjectState();
          return {
          success: true,
          undone_id: transaction.undo_id,
          scene_revision: DiagnosticState.sceneRevision,
          persisted,
          active_project: DiagnosticState.activeProject,
          main_scene: activeMainScene,
          files_restored: Object.keys(activeFilesDict),
          editor_acknowledged: Object.keys(activeFilesDict).length > 0
          };
        });
      }
    },
    {
      definition: {
        name: 'godot_select_node_live',
        description: 'Selects a node in the live Godot Editor scene dock through the WebMCP editor command channel. Fails explicitly when the channel is unavailable; never fabricates selection success.',
        input_schema: { type: 'object', properties: { node_path: { type: 'string' } }, required: ['node_path'], additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const reply = EditorCommandChannel.call('select', { node_path: args.node_path });
        if (!reply.ok) {
          unsupportedEditorOperation('Node selection', reply.unsupported
            ? 'The WebMCP editor plugin is not loaded in this project; use godot_inspect_project_files to inspect source instead.'
            : `The editor rejected the selection: ${reply.error}`);
        }
        return {
          success: true,
          selected_node: reply.selected,
          node_class: reply.node_class,
          editor_acknowledged: true,
          editor_channel: 'command'
        };
      }
    },
    {
      definition: {
        name: 'godot_transform_node_live',
        description: 'Transforms a node in the live Godot Editor through the editor command channel and its UndoRedo stack. Viewport-only: it does not rewrite the .tscn text — use godot_node_transform for a transform that persists to source.',
        input_schema: {
          type: 'object',
          properties: {
            node_path: { type: 'string' },
            translation: { type: 'array', items: { type: 'number' }, description: 'Absolute position [X, Y, Z]' },
            rotation: { type: 'array', items: { type: 'number' }, description: 'Rotation in degrees [Pitch, Yaw, Roll]' },
            scale: { type: 'array', items: { type: 'number' } },
            relative: { type: 'boolean', default: false }
          },
          required: ['node_path'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const reply = EditorCommandChannel.call('node_transform', {
          node_path: args.node_path,
          position: args.translation,
          rotation: args.rotation,
          scale: args.scale,
          relative: args.relative === true
        });
        if (!reply.ok) {
          unsupportedEditorOperation('Live node transform', reply.unsupported
            ? 'The WebMCP editor plugin is not loaded in this project; use godot_node_transform or godot_apply_file_transaction instead.'
            : `The editor rejected the transform: ${reply.error}`);
        }
        return {
          success: true,
          node_path: reply.node_path,
          position: reply.position,
          editor_acknowledged: true,
          editor_channel: 'command',
          persisted_to_source: false,
          persist_with: 'godot_node_transform'
        };
      }
    },
    {
      definition: {
        name: 'godot_connect_signal_live',
        description: 'Requests a native Godot signal connection. Fails explicitly without editor acknowledgement; source-backed scene edits remain available.',
        input_schema: { type: 'object', properties: { from_node: { type: 'string' }, signal: { type: 'string' }, to_node: { type: 'string' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        unsupportedEditorOperation('Live signal connection', 'Use godot_apply_file_transaction to add an acknowledged [connection] entry to the .tscn source.');
      }
    },
    {
      definition: {
        name: 'godot_resize_gizmo_live',
        description: 'Requests a native collision-gizmo resize. Fails explicitly without editor acknowledgement; source-backed shape edits remain available.',
        input_schema: { type: 'object', properties: { node_path: { type: 'string' }, radius: { type: 'number' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        unsupportedEditorOperation('Live gizmo resize', 'Use godot_apply_file_transaction to edit the shape resource in scene source.');
      }
    },
    {
      definition: {
        name: 'godot_live_code_diff',
        description: 'Legacy code-diff request. Fails explicitly because free-form diffs are not safely acknowledged; use revision-checked file transactions.',
        input_schema: { type: 'object', properties: { script_path: { type: 'string' }, diff: { type: 'string' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        unsupportedEditorOperation('Legacy code diff', 'Use godot_apply_file_transaction with expected_revision and complete replacement content.');
      }
    },
    {
      definition: {
        name: 'godot_inspect_property_live',
        description: 'Reads a live Inspector property from the edited scene through the editor command channel. Omit `property` to list the editable property names of the node.',
        input_schema: { type: 'object', properties: { node_path: { type: 'string' }, property: { type: 'string' } }, required: ['node_path'], additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const reply = EditorCommandChannel.call('inspect_property', { node_path: args.node_path, property: args.property || '' });
        if (!reply.ok) {
          unsupportedEditorOperation('Live Inspector property read', reply.unsupported
            ? 'The WebMCP editor plugin is not loaded in this project; use godot_inspect_project_files for authoritative source values.'
            : `The editor rejected the read: ${reply.error}`);
        }
        return {
          success: true,
          node_path: reply.node_path,
          ...(reply.properties ? { properties: reply.properties } : { property: reply.property, value: reply.value, type: reply.type }),
          editor_acknowledged: true,
          editor_channel: 'command'
        };
      }
    },
    {
      definition: {
        name: 'godot_generate_audio_fx',
        description: 'Synthesizes procedural 16-bit WAV sound effects (laser, explosion, pickup) and writes them to res://<filename>.wav',
        input_schema: { type: 'object', properties: { type: { type: 'string' }, duration: { type: 'number' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        const soundType = args.type || 'laser_fire';
        const dur = args.duration || 0.4;
        const res = AudioEngine.synthesizeSound(soundType, dur);
        return {
          filename: res.filename,
          asset_id: res.asset_id,
          duration_seconds: res.duration_seconds,
          license: res.license,
          preview_data_url: res.data_url
        };
      }
    },
    {
      definition: {
        name: 'godot_switch_mode',
        description: 'Requests a native Godot workspace switch. Fails explicitly when no acknowledged editor command channel is installed.',
        input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['2D', '3D', 'Script', 'Game'] } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        unsupportedEditorOperation('Godot workspace switch', 'Game viewport switching is supported by godot_run_game and godot_stop_game.');
      }
    },
    {
      definition: {
        name: 'godot_open_scene',
        description: 'Opens a res:// scene in the live Godot Editor through the editor command channel. This changes the edited scene only; use godot_apply_file_transaction to change project.godot run/main_scene.',
        input_schema: { type: 'object', properties: { scene_path: { type: 'string' } }, required: ['scene_path'], additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const scenePath = normalizeResourcePath(args.scene_path, '');
        const reply = EditorCommandChannel.call('open_scene', { scene_path: scenePath });
        if (!reply.ok) {
          unsupportedEditorOperation('Open scene', reply.unsupported
            ? 'The WebMCP editor plugin is not loaded in this project; use godot_apply_file_transaction to change project.godot run/main_scene and restart the editor.'
            : `The editor rejected the scene open: ${reply.error}`);
        }
        activeMainScene = reply.scene_path;
        SceneInspector.render();
        return { success: true, scene_path: reply.scene_path, editor_acknowledged: true, editor_channel: 'command' };
      }
    },
    {
      definition: {
        name: 'godot_hot_reload_property',
        description: 'Legacy hot-reload request. Fails explicitly because property-only patches cannot be applied safely without file and revision context.',
        input_schema: { type: 'object', properties: { property_name: { type: 'string' }, value: {} }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        unsupportedEditorOperation('Legacy property hot reload', 'Use godot_inspect_project_files followed by godot_apply_file_transaction.');
      }
    },
    {
      definition: {
        name: 'godot_run_game',
        description: 'Runs the project in the WebGL Game viewport',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async () => {
        PlaytestSimulation.reset();
        GameTelemetryState.latest = null;
        GameTelemetryState.recent = [];
        // The playtest is a SEPARATE Engine instance with its own in-memory filesystem, so
        // copying into the editor engine proves nothing about what the game will load — doing
        // only that reported success while the playtest still rendered the pre-edit scene.
        // Hand the snapshot to the game engine itself and require it to acknowledge the
        // revision it received.
        const editorCopy = copyActiveProjectToEditorFS();
        const staged = await stagePlaytestSnapshot(activeFilesDict, DiagnosticState.activeProject, DiagnosticState.sceneRevision);
        try {
          await startGameRuntime({ visible: true, timeoutMs: 15000 });
        } catch (error) {
          DiagnosticState.session = 'failed';
          DiagnosticHUD.render();
          throw error;
        }
        const handshake = await awaitPlaytestAcknowledgement(staged);
        if (!handshake.ok) {
          // Refuse to report a playtest as current when it demonstrably is not.
          await stopGameRuntime(8000).catch(() => {});
          DiagnosticState.session = 'editor-ready';
          DiagnosticHUD.render();
          const error = new Error(`The playtest did not confirm it loaded scene revision ${staged.revision}: ${handshake.error}`);
          error.code = 'PLAYTEST_REVISION_UNCONFIRMED';
          error.handshake_code = handshake.code;
          throw error;
        }
        DiagnosticState.engine = 'ready';
        DiagnosticState.session = 'playtesting';
        DiagnosticHUD.render();
        return {
          success: true,
          status: 'running',
          main_scene: activeMainScene,
          viewport: 'game',
          viewport_visible: true,
          scene_revision: DiagnosticState.sceneRevision,
          // Acknowledged by the playtest engine itself: this exact revision, this one-shot
          // launch token, and a fingerprint over the bytes it actually copied.
          playtest_revision_confirmed: handshake.revision,
          playtest_files_received: handshake.written,
          playtest_fingerprint: handshake.fingerprint,
          // Separate, weaker fact: the editor engine's filesystem was refreshed too. This is
          // NOT evidence about what the game loaded.
          editor_fs_copy_succeeded: editorCopy.ok === true,
          ...(editorCopy.ok ? {} : { editor_fs_copy_error: editorCopy.error || `${editorCopy.failed?.length || 0} file(s) failed to copy` })
        };
      }
    },
    {
      definition: {
        name: 'godot_stop_game',
        description: 'Stops the running game and returns to the editor',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async () => {
        const wasRunning = await stopGameRuntime(10000);
        forgetPreviewWasRunning();
        if (typeof window.showTab === 'function') window.showTab('editor');
        else document.getElementById('btn-tab-editor')?.click();
        DiagnosticState.session = 'editor-ready';
        DiagnosticHUD.render();
        return { success: true, status: 'stopped', runtime_was_running: wasRunning, viewport: 'editor' };
      }
    },
    {
      definition: {
        name: 'godot_send_input',
        description: 'Dispatches a keyboard event to the game canvas and reports any subsequent project-owned telemetry without claiming unverified gameplay acknowledgement',
        input_schema: { type: 'object', properties: { key: { type: 'string', description: "DOM KeyboardEvent name, used as both `key` and `code`: ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, Enter, KeyW, KeyA, KeyS, KeyD. Godot's default ui_* actions are the arrow keys and Space." }, pressed: { type: 'boolean' }, duration_ms: { type: 'integer', minimum: 20, maximum: 5000 }, await_telemetry: { type: 'boolean', default: true }, target: { type: 'string', enum: ['auto', 'editor', 'game'], default: 'auto', description: "Which Godot canvas to address. 'auto' follows the visible tab." } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const key = args.key || 'Space';
        const pressed = args.pressed !== false;
        const durationMs = Number.isInteger(args.duration_ms) ? args.duration_ms : 0;
        if (durationMs > 0 && !pressed) throw new Error('duration_ms is only valid for a key press pulse.');
        const before = GameTelemetryState.latest;
        const inputId = `input_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const surface = resolveGodotCanvas(args.target || 'auto');
        if (!surface) throw new Error('No Godot canvas is available to receive input.');
        const canvas = surface.canvas;
        window.__godotWebMcpInput = { input_id: inputId, key, pressed, dispatched_at: Date.now() };
        const event = new KeyboardEvent(pressed ? 'keydown' : 'keyup', { key, code: key, bubbles: true });
        canvas.dispatchEvent(event);
        document.dispatchEvent(event);
        if (durationMs > 0) {
          let released = false;
          let observedFrames = 0;
          const pressedAt = Date.now();
          let safetyTimer = null;
          const releaseKey = () => {
            if (released) return;
            released = true;
            const release = new KeyboardEvent('keyup', { key, code: key, bubbles: true });
            window.__godotWebMcpInput = { input_id: inputId, key, pressed: false, dispatched_at: Date.now(), scheduled_release: true };
            canvas.dispatchEvent(release);
            document.dispatchEvent(release);
            clearTimeout(safetyTimer);
          };
          const advanceRelease = () => {
            observedFrames++;
            if (observedFrames >= 2 && Date.now() - pressedAt >= durationMs) releaseKey();
            else requestAnimationFrame(advanceRelease);
          };
          requestAnimationFrame(advanceRelease);
          // Avoid a permanently held key if the page stops rendering entirely.
          safetyTimer = setTimeout(releaseKey, Math.max(durationMs + 5000, 6500));
        } else if (args.await_telemetry !== false) {
          await waitFor(() => GameTelemetryState.latest?.sequence > (before?.sequence || 0), 900, 50);
        }
        const after = GameTelemetryState.latest;
        const inputAcknowledged = after?.state?.input_id === inputId;
        return {
          success: true,
          input_id: inputId,
          dispatched_key: key,
          pressed,
          duration_ms: durationMs || null,
          release_scheduled: durationMs > 0,
          release_requires_rendered_frames: durationMs > 0 ? 2 : null,
          target: canvas.id,
          input_acknowledged: inputAcknowledged,
          telemetry_observed_after_dispatch: Boolean(after && after.sequence > (before?.sequence || 0)),
          telemetry_before: before,
          telemetry_after: after
        };
      }
    },
    {
      definition: {
        name: 'godot_send_input_sequence',
        description: 'Schedules a bounded timeline of keyboard down/up edges in one call for chords, diagonals, jumps, dodges, and other coordinated controls',
        input_schema: {
          type: 'object',
          properties: {
            events: {
              type: 'array', minItems: 1, maxItems: 32,
              items: {
                type: 'object',
                properties: { at_ms: { type: 'integer', minimum: 0, maximum: 10000 }, key: { type: 'string', description: "DOM KeyboardEvent name, used as both `key` and `code`: ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, Enter, KeyW, KeyA, KeyS, KeyD. Godot's default ui_* actions are the arrow keys and Space." }, pressed: { type: 'boolean' } },
                required: ['at_ms', 'key', 'pressed'], additionalProperties: false
              }
            },
            target: { type: 'string', enum: ['auto', 'editor', 'game'], default: 'auto', description: "Which Godot canvas to address. 'auto' follows the visible tab." }
          },
          required: ['events'], additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        if (!Array.isArray(args.events) || args.events.length < 1 || args.events.length > 32) throw new Error('An input sequence requires 1–32 events.');
        const surface = resolveGodotCanvas(args.target || 'auto');
        if (!surface) throw new Error('No Godot canvas is available to receive input.');
        const canvas = surface.canvas;
        const sequenceId = `input_sequence_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const events = args.events.map((entry, index) => ({ index, at_ms: entry.at_ms, key: entry.key, pressed: entry.pressed }))
          .sort((a, b) => a.at_ms - b.at_ms || a.index - b.index);
        const sequence = { id: sequenceId, status: 'scheduled', scheduled_at: Date.now(), started_at: null, completed_at: null, target: canvas.id, planned_events: events, dispatched_events: [] };
        inputSequences.set(sequenceId, sequence);
        while (inputSequences.size > 20) inputSequences.delete(inputSequences.keys().next().value);
        let frameStartedAt = null;
        let nextEvent = 0;
        const dispatchFrame = (frameTime) => {
          if (frameStartedAt === null) {
            frameStartedAt = frameTime;
            sequence.status = 'running';
            sequence.started_at = Date.now();
          }
          const activeElapsed = frameTime - frameStartedAt;
          if (nextEvent < events.length && events[nextEvent].at_ms <= activeElapsed) {
            const timestampGroup = events[nextEvent].at_ms;
            while (nextEvent < events.length && events[nextEvent].at_ms === timestampGroup) {
            const entry = events[nextEvent];
            const dispatchedAt = Date.now();
            const event = new KeyboardEvent(entry.pressed ? 'keydown' : 'keyup', { key: entry.key, code: entry.key, bubbles: true });
            window.__godotWebMcpInput = { input_id: sequenceId, event_index: entry.index, key: entry.key, pressed: entry.pressed, dispatched_at: dispatchedAt };
            canvas.dispatchEvent(event);
            document.dispatchEvent(event);
            sequence.dispatched_events.push({ ...entry, dispatched_at: dispatchedAt, elapsed_ms: Math.round(activeElapsed) });
            nextEvent++;
            }
          }
          if (nextEvent >= events.length) {
            sequence.status = 'completed';
            sequence.completed_at = Date.now();
          } else {
            requestAnimationFrame(dispatchFrame);
          }
        };
        requestAnimationFrame(dispatchFrame);
        return {
          success: true,
          sequence_id: sequenceId,
          status: 'scheduled',
          target: canvas.id,
          event_count: events.length,
          duration_ms: Math.max(...events.map(entry => entry.at_ms)),
          input_acknowledged: false,
          verify_with: 'godot_get_game_telemetry'
        };
      }
    },
    {
      definition: {
        name: 'godot_get_input_sequence_status',
        description: 'Returns planned and actual dispatch timing for one coordinated keyboard sequence, or recent sequences when no ID is supplied',
        input_schema: { type: 'object', properties: { sequence_id: { type: 'string' } }, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        if (args.sequence_id) {
          const sequence = inputSequences.get(args.sequence_id);
          if (!sequence) throw new Error(`Unknown input sequence: ${args.sequence_id}`);
          return { success: true, sequence };
        }
        return { success: true, recent_sequences: [...inputSequences.values()].slice(-10).reverse() };
      }
    },
    {
      definition: {
        name: 'godot_capture_viewport',
        description: 'Captures the pixel buffer of the editor viewport or the running playtest canvas as a base64 PNG data URL',
        input_schema: { type: 'object', properties: { target: { type: 'string', enum: ['auto', 'editor', 'game'], default: 'auto', description: "Which Godot canvas to address. 'auto' follows the visible tab." } }, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const surface = resolveGodotCanvas(args.target || 'auto');
        if (!surface || typeof surface.canvas.toDataURL !== 'function') {
          throw new Error('No canvas is available for viewport capture.');
        }
        const canvas = surface.canvas;
        const rect = canvas.getBoundingClientRect();
        return {
          success: true,
          viewport: surface.viewport,
          requested_viewport: surface.requested,
          width: canvas.width,
          height: canvas.height,
          device_pixel_ratio: typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1,
          css_size: { width: rect.width, height: rect.height },
          format: 'image/png',
          data_url: canvas.toDataURL('image/png')
        };
      }
    },
    {
      definition: {
        name: 'godot_send_pointer',
        description: 'Dispatches mouse/pointer input at Godot canvas coordinates and reports dispatch geometry without claiming unverified gameplay acknowledgement',
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['move', 'down', 'up', 'click', 'wheel'] },
            x: { type: 'number', minimum: 0 },
            y: { type: 'number', minimum: 0 },
            button: { type: 'string', enum: ['left', 'middle', 'right'], default: 'left' },
            delta_y: { type: 'number', default: 0 },
            target: { type: 'string', enum: ['auto', 'editor', 'game'], default: 'auto', description: "Which Godot canvas to address. 'auto' follows the visible tab." }
          },
          required: ['action', 'x', 'y'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const surface = resolveGodotCanvas(args.target || 'auto');
        if (!surface) throw new Error('No Godot canvas is available to receive pointer input.');
        const canvas = surface.canvas;
        if (args.x > canvas.width || args.y > canvas.height) {
          throw new Error(`Pointer coordinates exceed the ${canvas.width}x${canvas.height} canvas.`);
        }
        const rect = canvas.getBoundingClientRect();
        const clientX = rect.left + (Number(args.x) / canvas.width) * rect.width;
        const clientY = rect.top + (Number(args.y) / canvas.height) * rect.height;
        const buttonMap = { left: 0, middle: 1, right: 2 };
        const buttonsMask = { left: 1, middle: 4, right: 2 };
        const button = buttonMap[args.button || 'left'];
        const base = { bubbles: true, cancelable: true, clientX, clientY, button };
        const dispatch = type => {
          const init = { ...base, buttons: type === 'pointerdown' ? buttonsMask[args.button || 'left'] : 0 };
          return canvas.dispatchEvent(typeof PointerEvent !== 'undefined'
            ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
            : new MouseEvent(type.replace('pointer', 'mouse'), init));
        };
        const dispatchMouse = (type, pressed = false) => canvas.dispatchEvent(new MouseEvent(type, {
          ...base,
          buttons: pressed ? buttonsMask[args.button || 'left'] : 0
        }));
        if (args.action === 'move') { dispatch('pointermove'); dispatchMouse('mousemove'); }
        else if (args.action === 'down') { dispatch('pointerdown'); dispatchMouse('mousedown', true); }
        else if (args.action === 'up') { dispatch('pointerup'); dispatchMouse('mouseup'); }
        else if (args.action === 'click') {
          dispatch('pointerdown');
          dispatchMouse('mousedown', true);
          dispatch('pointerup');
          dispatchMouse('mouseup');
          dispatchMouse('click');
        } else if (args.action === 'wheel') {
          canvas.dispatchEvent(new WheelEvent('wheel', { ...base, deltaY: Number(args.delta_y) || 0 }));
        }
        return {
          success: true,
          action: args.action,
          canvas_position: { x: Number(args.x), y: Number(args.y) },
          client_position: { x: clientX, y: clientY },
          button: args.button || 'left',
          target: canvas.id,
          viewport: surface.viewport,
          requested_viewport: surface.requested,
          gameplay_acknowledged: false,
          verify_with: 'godot_get_game_telemetry'
        };
      }
    },
    {
      definition: {
        name: 'godot_start_recording',
        description: 'Starts a real MediaRecorder capture of the visible Godot game canvas; optionally auto-stops and persists after a bounded duration',
        input_schema: {
          type: 'object',
          properties: {
            fps: { type: 'integer', minimum: 10, maximum: 60, default: 30 },
            mime_type: { type: 'string', description: 'Optional MediaRecorder MIME override, for example video/webm or video/webm;codecs=vp8,opus' },
            duration_ms: { type: 'integer', minimum: 500, maximum: 60000, description: 'Optional in-page auto-stop duration for precise persistence without a second Browser round trip' }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        if (RecordingState.recorder?.state === 'recording') throw new Error('A viewport recording is already active.');
        if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is unavailable in this browser.');
        const canvas = (window.__godotGameState === 'running' ? document.getElementById('game-canvas') : null) || document.getElementById('editor-canvas') || document.getElementById('game-canvas');
        if (!canvas || typeof canvas.captureStream !== 'function') throw new Error('No visible Godot canvas is available for stream capture. Run the editor or game first.');
        const fps = Math.max(10, Math.min(Number(args.fps) || 30, 60));
        const recordingSurface = createRecordingSurface(canvas);
        if (!recordingSurface || typeof recordingSurface.captureStream !== 'function') {
          releaseRecordingSurface();
          throw new Error('The browser could not create a persistent recording surface.');
        }
        const videoStream = recordingSurface.captureStream(fps);
        let audioDestination = null;
        let audioMaster = null;
        let stream = videoStream;
        const godotAudioContext = window.__godotAudioContext;
        if (godotAudioContext?.state === 'suspended') {
          try {
            await Promise.race([
              godotAudioContext.resume(),
              new Promise(resolve => setTimeout(resolve, 500))
            ]);
          } catch (_) {}
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        if (godotAudioContext?.state !== 'closed' && window.__godotAudioMasterNode && typeof MediaStream !== 'undefined') {
          audioDestination = godotAudioContext.createMediaStreamDestination();
          audioMaster = window.__godotAudioMasterNode;
          audioMaster.connect(audioDestination);
          stream = new MediaStream([...videoStream.getVideoTracks(), ...audioDestination.stream.getAudioTracks()]);
        }
        if (args.mime_type && !MediaRecorder.isTypeSupported(args.mime_type)) {
          throw new Error(`Requested recording MIME type is unsupported: ${args.mime_type}`);
        }
        const mimeCandidates = stream.getAudioTracks().length > 0
          ? ['video/webm', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus']
          : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
        const mimeType = args.mime_type || mimeCandidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 5_000_000 } : undefined);
        RecordingState.recorder = recorder;
        RecordingState.chunks = [];
        RecordingState.startedAt = Date.now();
        RecordingState.id = `recording_${RecordingState.startedAt}_${Math.random().toString(36).slice(2, 7)}`;
        RecordingState.canvas = canvas;
        RecordingState.audioDestination = audioDestination;
        RecordingState.audioMaster = audioMaster;
        recorder.ondataavailable = event => { if (event.data?.size) RecordingState.chunks.push(event.data); };
        if (stream.getAudioTracks().length > 0) {
          const videoMime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type)) || '';
          const audioMime = ['audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type)) || '';
          RecordingState.videoChunks = [];
          RecordingState.audioChunks = [];
          RecordingState.videoRecorder = new MediaRecorder(videoStream, videoMime ? { mimeType: videoMime, videoBitsPerSecond: 5_000_000 } : undefined);
          RecordingState.audioRecorder = new MediaRecorder(audioDestination.stream, audioMime ? { mimeType: audioMime, audioBitsPerSecond: 160_000 } : undefined);
          RecordingState.videoRecorder.ondataavailable = event => { if (event.data?.size) RecordingState.videoChunks.push(event.data); };
          RecordingState.audioRecorder.ondataavailable = event => { if (event.data?.size) RecordingState.audioChunks.push(event.data); };
          RecordingState.videoRecorder.start(500);
          RecordingState.audioRecorder.start(500);
        }
        recorder.start(500);
        const autoStopDuration = Number.isInteger(args.duration_ms) ? args.duration_ms : 0;
        clearTimeout(RecordingState.autoStopTimer);
        RecordingState.lastAutoStop = null;
        if (autoStopDuration > 0) {
          const scheduledRecordingId = RecordingState.id;
          RecordingState.autoStopTimer = setTimeout(async () => {
            try {
              const stopTool = MANIFEST_TOOLS.find(entry => entry.definition.name === 'godot_stop_recording');
              if (!stopTool) throw new Error('Recording stop handler is unavailable.');
              const result = await stopTool.handler();
              RecordingState.lastAutoStop = { recording_id: scheduledRecordingId, status: 'succeeded', completed_at: Date.now(), result };
              activeLogs.push({ level: 'info', time: Date.now(), msg: `[Recording] auto-stop succeeded: ${scheduledRecordingId}` });
              if (activeLogs.length > MAX_LOGS) activeLogs.shift();
            } catch (error) {
              RecordingState.lastAutoStop = { recording_id: scheduledRecordingId, status: 'failed', completed_at: Date.now(), error: error instanceof Error ? error.message : String(error) };
              activeLogs.push({ level: 'error', time: Date.now(), msg: `[Recording] auto-stop failed: ${scheduledRecordingId} — ${RecordingState.lastAutoStop.error}` });
              if (activeLogs.length > MAX_LOGS) activeLogs.shift();
            }
          }, autoStopDuration);
        }
        return {
          success: true,
          status: 'recording',
          recording_id: RecordingState.id,
          fps,
          mime_type: recorder.mimeType || mimeType || 'video/webm',
          width: canvas.width,
          height: canvas.height,
          duration_ms: autoStopDuration || null,
          auto_stop_scheduled: autoStopDuration > 0,
          poll_with: autoStopDuration > 0 ? 'godot_list_recordings' : null,
          audio_tracks: stream.getAudioTracks().length,
          audio_context_state: godotAudioContext?.state || 'unavailable',
          audio_capture_ready: stream.getAudioTracks().length > 0 && godotAudioContext?.state === 'running'
        };
      }
    },
    {
      definition: {
        name: 'godot_stop_recording',
        description: 'Stops the active canvas recording, persists the WebM blob in IndexedDB, and exposes a durable download link in the viewport',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async () => {
        clearTimeout(RecordingState.autoStopTimer);
        RecordingState.autoStopTimer = null;
        const recorder = RecordingState.recorder;
        if (!recorder || recorder.state !== 'recording') throw new Error('No viewport recording is active.');
        const stoppedAt = Date.now();
        const activeRecorders = [recorder, RecordingState.videoRecorder, RecordingState.audioRecorder]
          .filter(candidate => candidate?.state === 'recording');
        for (const candidate of activeRecorders) candidate.requestData();
        await new Promise(resolve => setTimeout(resolve, 180));
        await Promise.all(activeRecorders.map(candidate => new Promise((resolve, reject) => {
          candidate.addEventListener('stop', resolve, { once: true });
          candidate.addEventListener('error', event => reject(event.error || new Error('Recording failed.')), { once: true });
          candidate.stop();
        })));
        for (const track of recorder.stream.getTracks()) track.stop();
        releaseRecordingSurface();
        if (RecordingState.audioDestination && RecordingState.audioMaster) {
          try { RecordingState.audioMaster.disconnect(RecordingState.audioDestination); } catch (_) {}
        }
        const blob = new Blob(RecordingState.chunks, { type: recorder.mimeType || 'video/webm' });
        const videoBlob = RecordingState.videoRecorder
          ? new Blob(RecordingState.videoChunks, { type: RecordingState.videoRecorder.mimeType || 'video/webm' })
          : null;
        const audioBlob = RecordingState.audioRecorder
          ? new Blob(RecordingState.audioChunks, { type: RecordingState.audioRecorder.mimeType || 'audio/webm' })
          : null;
        RecordingState.recorder = null;
        RecordingState.chunks = [];
        RecordingState.videoRecorder = null;
        RecordingState.videoChunks = [];
        RecordingState.audioRecorder = null;
        RecordingState.audioChunks = [];
        RecordingState.audioDestination = null;
        RecordingState.audioMaster = null;
        if (!blob.size && !videoBlob?.size && !audioBlob?.size) {
          throw new Error('The browser produced empty combined, video, and audio recordings. Recorder state was cleaned up.');
        }
        if (!blob.size && videoBlob?.size) {
          const base = {
            project_name: DiagnosticState.activeProject,
            created_at: RecordingState.startedAt,
            duration_ms: stoppedAt - RecordingState.startedAt,
            width: RecordingState.canvas?.width || null,
            height: RecordingState.canvas?.height || null
          };
          const videoRecord = {
            ...base, id: `${RecordingState.id}_video`, filename: `${DiagnosticState.activeProject}-${RecordingState.startedAt}-video.webm`,
            mime_type: videoBlob.type, blob: videoBlob
          };
          const splitRecords = [videoRecord];
          if (audioBlob?.size) splitRecords.push({
            ...base, id: `${RecordingState.id}_audio`, filename: `${DiagnosticState.activeProject}-${RecordingState.startedAt}-audio.webm`,
            mime_type: audioBlob.type, width: null, height: null, blob: audioBlob
          });
          for (const splitRecord of splitRecords) await storeRecording(splitRecord);
          splitRecords.forEach((splitRecord, index) => exposeRecordingDownload(splitRecord, index === 0));
          return {
            success: true,
            status: audioBlob?.size ? 'persisted_split' : 'persisted_video_only',
            recording_id: RecordingState.id,
            duration_ms: base.duration_ms,
            persistence: 'IndexedDB + visible download links',
            muxed: false,
            warning: audioBlob?.size
              ? 'This browser produced an empty combined stream; synchronized video and audio artifacts were persisted separately.'
              : 'This browser produced no combined or audio artifact; the video fallback was persisted.',
            artifacts: splitRecords.map(splitRecord => ({
              recording_id: splitRecord.id, filename: splitRecord.filename, size_bytes: splitRecord.blob.size, mime_type: splitRecord.mime_type
            }))
          };
        }
        const record = {
          id: RecordingState.id,
          filename: `${DiagnosticState.activeProject}-${RecordingState.startedAt}.webm`,
          project_name: DiagnosticState.activeProject,
          created_at: RecordingState.startedAt,
          duration_ms: stoppedAt - RecordingState.startedAt,
          mime_type: blob.type,
          width: RecordingState.canvas?.width || null,
          height: RecordingState.canvas?.height || null,
          blob
        };
        await storeRecording(record);
        const downloadUrl = exposeRecordingDownload(record);
        return {
          success: true,
          status: 'persisted',
          recording_id: record.id,
          filename: record.filename,
          duration_ms: record.duration_ms,
          size_bytes: blob.size,
          mime_type: blob.type,
          download_url: downloadUrl,
          persistence: 'IndexedDB + visible download link',
          audio_tracks: recorder.stream.getAudioTracks().length
        };
      }
    },
    {
      definition: {
        name: 'godot_list_recordings',
        description: 'Lists recordings persisted for this deployed origin and restores a visible download link for the newest artifact',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async () => {
        const records = (await readRecordings()).sort((a, b) => b.created_at - a.created_at);
        if (records[0]) exposeRecordingDownload(records[0]);
        return {
          count: records.length,
          last_auto_stop: RecordingState.lastAutoStop,
          recordings: records.map(record => ({
            recording_id: record.id,
            filename: record.filename,
            project_name: record.project_name,
            created_at: record.created_at,
            duration_ms: record.duration_ms,
            size_bytes: record.blob?.size || 0,
            mime_type: record.mime_type,
            width: record.width,
            height: record.height
          }))
        };
      }
    },
    {
      definition: {
        name: 'godot_get_logs',
        description: 'Retrieves engine logs and stdout telemetry',
        input_schema: { type: 'object', properties: { limit: { type: 'number', default: 50 } }, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const limit = args.limit || 50;
        return { logs: activeLogs.slice(-limit), count: activeLogs.length };
      }
    },
    {
      definition: {
        name: 'godot_diagnose_session',
        description: 'Diagnoses current-generation Godot logs and recovery state into structured platform, project-source, persistence, lifecycle, and fatal-engine issues. Reports ownership, impact, evidence, and only remedies the agent can safely perform; read-only and never mutates the project.',
        input_schema: {
          type: 'object',
          properties: {
            since_ms: { type: 'number', minimum: 0, description: 'Optional lookback window in milliseconds. Omit to inspect the full current editor generation.' }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async (args = {}) => diagnoseEngineSession(
        activeLogs,
        EditorCommandChannel.generation,
        {
          sinceTime: Number.isFinite(args.since_ms) ? Date.now() - Math.max(0, args.since_ms) : 0,
          restartRequired: editorRestartBlocked,
          persistenceError: projectPersistenceError
        }
      )
    },
    {
      definition: {
        name: 'godot_camera_focus',
        description: 'Transient viewport-only framing: selects a node, dispatches Godot\'s own spatial_editor/focus_selection so the editor camera eases to it, and anchors the on-page focus reticle to the node\'s projected screen position. Reports what it measured, not what it attempted: status is \'framed\' only when the viewport pose actually changed, \'dispatched_unconfirmed\' when the shortcut was delivered but the camera did not move (Godot only advances camera interpolation while rendering, so a backgrounded tab reports this), \'overlay_only\' without the editor plugin, or \'yielded\' during the 750 ms cooldown after user input. target_reached additionally requires the node to project inside the frame. Never mutates scene JSON, advances scene_revision, creates an undo entry, triggers autosave, or survives a project reload. Yields to the user for 750 ms after any pointer, wheel, or key input on the viewport.',
        input_schema: {
          type: 'object',
          properties: {
            node_path: { type: 'string', description: 'Node name or scene-relative path to frame' }
          },
          required: ['node_path'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const result = await CameraGuidance.guide({ nodeName: args.node_path, reason: 'explicit' });
        if (result.status === 'failed') throw new Error(result.error || 'Camera focus failed.');
        return { success: result.status !== 'failed', ...result };
      }
    },
    {
      definition: {
        name: 'godot_camera_follow',
        description: 'Enables or disables automatic camera follow for this browser session. When enabled, a geometry change (node added, moved, or deleted) queues exactly one coalesced framing move; material-only changes never move the camera. The preference is stored in sessionStorage and is also exposed as the Auto follow control in the page rail.',
        input_schema: {
          type: 'object',
          properties: { enabled: { type: 'boolean', description: 'Omit to read the current preference without changing it' } },
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const enabled = typeof args.enabled === 'boolean'
          ? CameraGuidance.setAutoFollow(args.enabled)
          : CameraGuidance.autoFollowEnabled();
        return {
          success: true,
          auto_follow: enabled,
          transient: true,
          cooldown_ms: USER_INPUT_COOLDOWN_MILLISECONDS,
          editor_command_channel: EditorCommandChannel.describe()
        };
      }
    },
    {
      definition: {
        name: 'godot_workspace_follow',
        description: "Enables or disables visible workspace following for this browser tab, and chooses how strongly a script edit follows. In mode 'file' (the default) a script edit never takes the screen: the changed file is revealed in the FileSystem dock and the current workspace is preserved. In mode 'script' a script edit also opens the Script workspace at the changed lines. 3D node changes switch to the 3D workspace and select the edited node in both modes. The state is persisted in sessionStorage and mirrored by the Follow agent control.",
        input_schema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'Omit to read the current preference without changing it' },
            mode: { type: 'string', enum: ['file', 'script'], description: "'file' reveals the edited script in the FileSystem dock and leaves the workspace alone; 'script' opens the code at the changed lines" }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const enabled = typeof args.enabled === 'boolean'
          ? FollowAgent.set(args.enabled)
          : FollowAgent.enabled;
        const mode = typeof args.mode === 'string' ? FollowAgent.setMode(args.mode) : FollowAgent.mode;
        DiagnosticHUD.render();
        return {
          success: true,
          workspace_follow: enabled,
          mode,
          opens_script_workspace: FollowAgent.opensScriptWorkspace(),
          active: FollowAgent.active(),
          paused: FollowAgent.describe().paused,
          persistence: 'sessionStorage'
        };
      }
    },
    {
      definition: {
        name: 'godot_node_spawn',
        description: 'Adds a 3D mesh node with position, rotation, scale, and material to the live scene. Applied through the editor command channel without restarting the engine when the WebMCP editor plugin is present; otherwise falls back to a full editor restart. Reports the measured elapsed time and which channel was used.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique name of the 3D node' },
            parent_path: { type: 'string', default: '.', description: 'Parent node path (defaults to root .)' },
            mesh_type: { type: 'string', enum: ['box', 'cylinder', 'sphere', 'torus', 'prism', 'capsule', 'plane'], default: 'box' },
            size: { type: 'array', items: { type: 'number' }, description: 'Vector3 dimensions [x, y, z] for box/prism' },
            radius: { type: 'number', description: 'Radius for sphere/cylinder/capsule' },
            height: { type: 'number', description: 'Height for cylinder/capsule/prism' },
            inner_radius: { type: 'number', description: 'Inner radius for torus' },
            outer_radius: { type: 'number', description: 'Outer radius for torus' },
            position: { type: 'array', items: { type: 'number' }, description: '3D position coordinates [X, Y, Z]' },
            rotation: { type: 'array', items: { type: 'number' }, description: '3D rotation in degrees [Pitch, Yaw, Roll]' },
            scale: { type: 'array', items: { type: 'number' }, description: '3D scale factors [sx, sy, sz]' },
            material: {
              type: 'object',
              properties: {
                albedo_color: { type: 'string', description: 'Hex color (e.g. #538dda) or rgba string' },
                metallic: { type: 'number', minimum: 0, maximum: 1 },
                roughness: { type: 'number', minimum: 0, maximum: 1 },
                emission: { type: 'string', description: 'Hex emissive color' },
                emission_energy: { type: 'number', description: 'Emissive energy multiplier' }
              },
              additionalProperties: false
            }
          },
          required: ['name'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        const nodeName = cleanProjectName(args.name);
        if (findNodeInActiveScene(activeFilesDict, nodeName)) {
          throw new Error(`A node named '${nodeName}' already exists in the active scene. Godot renames name clashes on load, so pick a unique name or delete the existing node first.`);
        }
        const parentPath = args.parent_path || '.';
        const meshType = args.mesh_type || 'box';
        const pos = Array.isArray(args.position) && args.position.length >= 3 ? args.position : [0, 0, 0];
        const rot = Array.isArray(args.rotation) && args.rotation.length >= 3 ? args.rotation : [0, 0, 0];
        const scale = Array.isArray(args.scale) && args.scale.length >= 3 ? args.scale : [1, 1, 1];
        const mat = args.material || {};

        const meshSubResId = `Mesh_${nodeName}`;
        const matSubResId = `Mat_${nodeName}`;

        const meshSubRes = generateMeshSubResource(meshType, args, meshSubResId);
        const matSubRes = generateMaterialSubResource(mat, matSubResId);

        // The previous version wrote a scale-only basis, silently discarding `rotation`.
        const localBasis = basisFromEulerScale(rot, scale);

        const res = await liveMutateSceneFile((source, commandReply) => {
          const authoritative = Array.isArray(commandReply?.transform) && commandReply.transform.length >= 12
            ? commandReply.transform
            : [...localBasis, ...pos];
          const nodeBlock = `\n[node name="${nodeName}" type="MeshInstance3D" parent="${parentPath}"]\ntransform = ${formatTransform3D(authoritative.slice(0, 9), authoritative.slice(9, 12))}\nmesh = SubResource("${meshSubResId}")\nsurface_material_override/0 = SubResource("${matSubResId}")\n`;
          let updated = source;
          const firstNodeIdx = updated.indexOf('\n[node name="');
          if (firstNodeIdx > 0) {
            updated = updated.slice(0, firstNodeIdx) + '\n' + meshSubRes + matSubRes + updated.slice(firstNodeIdx);
          } else {
            updated = updated + '\n' + meshSubRes + matSubRes;
          }
          updated = updated + nodeBlock;
          return updated;
        }, {
          command: {
            op: 'node_add',
            payload: {
              name: nodeName, parent_path: parentPath, mesh_type: meshType,
              size: args.size, radius: args.radius, height: args.height,
              inner_radius: args.inner_radius, outer_radius: args.outer_radius,
              position: pos, rotation: rot, scale, material: mat
            }
          },
          verify: (source, reply) => {
            const path = reply?.node_path || (parentPath === '.' ? nodeName : `${parentPath}/${nodeName}`);
            const present = verifyNodePresence(source, path, true);
            if (!present.synced) return present;
            return Array.isArray(reply?.transform)
              ? verifyTransformInSource(source, path, reply.transform)
              : { synced: true, node_path: path, reason: 'no_authoritative_transform_to_compare' };
          }
        });

        const navigation = await follow3DWorkspace(res.commandReply?.node_path || nodeName);
        if (typeof window !== 'undefined') {
          AgentFocusOverlay.settleWork(nodeName, pos, 'Added', res.ok !== false);
          CameraGuidance.noteSceneChanged(nodeName);
        }

        return liveMutationResult(res, {
          node_name: nodeName,
          type: 'MeshInstance3D',
          parent_path: parentPath,
          position: pos,
          mesh_type: meshType,
          follow: navigation
        });
      }
    },
    {
      definition: {
        name: 'godot_node_instance',
        description: "Places an imported model or saved scene into the live 3D scene as a child node: a .glb or .gltf imported with godot_import_asset, or a .tscn already in the project. Use this for anything that came from an asset file - godot_node_spawn only builds Godot's own primitive meshes and cannot place a model. The instantiated node moves, rotates and scales like any other node via godot_node_transform, and its own sub-nodes belong to the imported scene, so they are reported rather than editable from here. Applied through the editor command channel without restarting the engine when the plugin is present.",
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique name for the new node in this scene' },
            scene_path: { type: 'string', description: 'res:// path of the model or scene to instantiate, for example res://models/crystal.glb' },
            parent_path: { type: 'string', default: '.', description: 'Parent node path (defaults to root .)' },
            position: { type: 'array', items: { type: 'number' }, description: '3D position coordinates [X, Y, Z]' },
            rotation: { type: 'array', items: { type: 'number' }, description: '3D rotation in degrees [Pitch, Yaw, Roll]' },
            scale: { type: 'array', items: { type: 'number' }, description: '3D scale factors [sx, sy, sz]' }
          },
          required: ['name', 'scene_path'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        const nodeName = cleanProjectName(args.name);
        const scenePath = String(args.scene_path || '').startsWith('res://')
          ? String(args.scene_path)
          : `res://${cleanProjectPath(args.scene_path || '')}`;
        if (scenePath === 'res://') throw new Error('scene_path is required.');
        if (findNodeInActiveScene(activeFilesDict, nodeName)) {
          throw new Error(`A node named '${nodeName}' already exists in the active scene. Godot renames name clashes on load, so pick a unique name or delete the existing node first.`);
        }
        if (!EditorCommandChannel.available()) {
          const error = new Error('The editor command plugin is not available, so an imported scene cannot be instantiated.');
          error.code = 'EDITOR_COMMAND_UNSUPPORTED';
          throw error;
        }
        const parentPath = args.parent_path || '.';
        const pos = Array.isArray(args.position) && args.position.length >= 3 ? args.position : [0, 0, 0];
        const rot = Array.isArray(args.rotation) && args.rotation.length >= 3 ? args.rotation : [0, 0, 0];
        const scale = Array.isArray(args.scale) && args.scale.length >= 3 ? args.scale : [1, 1, 1];
        const localBasis = basisFromEulerScale(rot, scale);

        const res = await liveMutateSceneFile((source, commandReply) => {
          const authoritative = Array.isArray(commandReply?.transform) && commandReply.transform.length >= 12
            ? commandReply.transform
            : [...localBasis, ...pos];
          // The model is an external resource, not a sub-resource: the .tscn refers to the
          // imported file, exactly as the editor writes it when a model is dragged in.
          const declared = ensureExtResource(source, 'PackedScene', scenePath, nodeName);
          if (!declared.ok) throw new Error(declared.error);
          return `${declared.text}\n[node name="${nodeName}" parent="${parentPath}" instance=ExtResource("${declared.resource_id}")]\ntransform = ${formatTransform3D(authoritative.slice(0, 9), authoritative.slice(9, 12))}\n`;
        }, {
          command: {
            op: 'node_instance',
            payload: { name: nodeName, scene_path: scenePath, parent_path: parentPath, position: pos, rotation: rot, scale }
          },
          verify: (source, reply) => {
            const path = reply?.node_path || (parentPath === '.' ? nodeName : `${parentPath}/${nodeName}`);
            return verifyNodePresence(source, path, true);
          }
        });

        const navigation = await follow3DWorkspace(res.commandReply?.node_path || nodeName);
        if (typeof window !== 'undefined') {
          AgentFocusOverlay.settleWork(nodeName, pos, 'Placed', res.ok !== false);
          CameraGuidance.noteSceneChanged(nodeName);
        }

        return liveMutationResult(res, {
          node_name: nodeName,
          type: 'InstancedScene',
          scene_path: scenePath,
          parent_path: parentPath,
          position: pos,
          // The imported scene owns these; editing them from here is not supported, and
          // saying so beats a caller discovering it through a failed node_path lookup.
          instanced_children: res.commandReply?.children || [],
          follow: navigation
        });
      }
    },
    {
      definition: {
        name: 'godot_node_transform',
        description: 'Translates, rotates, or scales a 3D node in the live editor scene. Applied through the editor command channel without restarting the engine when the WebMCP editor plugin is present; otherwise falls back to a full editor restart.',
        input_schema: {
          type: 'object',
          properties: {
            node_path: { type: 'string', description: 'Path or name of the node in the scene tree' },
            position: { type: 'array', items: { type: 'number' }, description: 'New position coordinates [X, Y, Z]' },
            rotation: { type: 'array', items: { type: 'number' }, description: 'New rotation angles in degrees [Pitch, Yaw, Roll]' },
            scale: { type: 'array', items: { type: 'number' }, description: 'New scale factors [sx, sy, sz]' },
            relative: { type: 'boolean', default: false, description: 'If true, offsets existing transform instead of setting absolute values' }
          },
          required: ['node_path'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        // The requested path is kept whole. Stripping it to a leaf name is what made an edit
        // to BranchB/TwinOrb land on BranchA/TwinOrb in the serialized scene.
        const requestedPath = args.node_path;
        const pos = Array.isArray(args.position) && args.position.length >= 3 ? args.position : null;
        // The light goes on before the edit, anchored to where the node is now, so the move is
        // something you watch happen instead of something you are told about afterwards.
        if (typeof window !== 'undefined') AgentFocusOverlay.beginWork(requestedPath, 'Moving');
        // Rotation was never serialized and `relative` was never implemented, so a
        // rotation-only edit lived in the editor and died on reload. Both are handled by
        // applyTransformToSceneText now, and Godot's own result overrides it when available.
        const res = await liveMutateSceneFile((source, commandReply) => applyTransformToSceneText(source, resolvedNodePath(commandReply, requestedPath), {
          position: args.position,
          rotation: args.rotation,
          scale: args.scale,
          relative: args.relative === true,
          authoritative: commandReply?.transform
        }), {
          command: {
            op: 'node_transform',
            payload: {
              node_path: args.node_path, position: args.position,
              rotation: args.rotation, scale: args.scale, relative: args.relative === true
            }
          },
          verify: (source, reply) => verifyTransformInSource(source, resolvedNodePath(reply, requestedPath), reply?.transform)
        });

        const navigation = await follow3DWorkspace(res.commandReply?.node_path || requestedPath);
        if (typeof window !== 'undefined') {
          const focusPath = res.commandReply?.node_path || requestedPath;
          AgentFocusOverlay.settleWork(focusPath, pos || null, 'Moved', res.ok !== false);
          CameraGuidance.noteSceneChanged(focusPath);
        }

        return liveMutationResult(res, {
          node_path: args.node_path,
          resolved_node_path: res.commandReply?.node_path || null,
          position: res.commandReply?.position || pos,
          rotation: args.rotation || null,
          scale: args.scale || null,
          relative: args.relative === true,
          serialized_transform: res.commandReply?.transform || null,
          follow: navigation
        });
      }
    },
    {
      definition: {
        name: 'godot_node_material',
        description: 'Updates the albedo, metallic, roughness, and emissive properties of a 3D node material. Applied through the editor command channel without restarting the engine when the WebMCP editor plugin is present; otherwise falls back to a full editor restart. Material changes never move the camera.',
        input_schema: {
          type: 'object',
          properties: {
            node_path: { type: 'string', description: 'Path or name of the node' },
            albedo_color: { type: 'string', description: 'Albedo color hex or rgb' },
            metallic: { type: 'number', minimum: 0, maximum: 1 },
            roughness: { type: 'number', minimum: 0, maximum: 1 },
            emission: { type: 'string', description: 'Emission color hex' },
            emission_energy: { type: 'number', description: 'Emission energy multiplier' }
          },
          required: ['node_path'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        const requestedPath = args.node_path;
        if (typeof window !== 'undefined') AgentFocusOverlay.beginWork(requestedPath, 'Recolouring');
        const res = await liveMutateSceneFile((source, commandReply) => applyMaterialToSceneText(
          source,
          resolvedNodePath(commandReply, requestedPath),
          // Prefer what the editor actually resolved; fall back to the request when the
          // command channel is unavailable.
          materialUpdateFromCommandReply(commandReply) || args
        ), {
          command: {
            op: 'node_material',
            payload: {
              node_path: args.node_path, albedo_color: args.albedo_color,
              metallic: args.metallic, roughness: args.roughness,
              emission: args.emission, emission_energy: args.emission_energy
            }
          },
          verify: (source, reply) => verifyMaterialInSource(source, resolvedNodePath(reply, requestedPath), args)
        });

        const navigation = await follow3DWorkspace(res.commandReply?.node_path || requestedPath);
        // A material tweak is not a geometry change: no auto-follow, and the reticle is
        // anchored to the node's real position rather than the origin.
        if (typeof window !== 'undefined') {
          AgentFocusOverlay.settleWork(res.commandReply?.node_path || requestedPath, null, 'Recoloured', res.ok !== false);
        }

        return liveMutationResult(res, {
          node_path: args.node_path,
          resolved_node_path: res.commandReply?.node_path || null,
          material: res.commandReply?.material || {
            albedo_color: args.albedo_color,
            metallic: args.metallic,
            roughness: args.roughness,
            emission: args.emission,
            emission_energy: args.emission_energy
          },
          follow: navigation
        });
      }
    },
    {
      definition: {
        name: 'godot_node_delete',
        description: 'Removes a 3D node from the live scene tree. Applied through the editor command channel without restarting the engine when the WebMCP editor plugin is present; otherwise falls back to a full editor restart.',
        input_schema: {
          type: 'object',
          properties: {
            node_path: { type: 'string', description: 'Path or name of the node to remove' }
          },
          required: ['node_path'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        const requestedPath = args.node_path;
        const res = await liveMutateSceneFile((source, commandReply) => {
          const block = findNodeBlock(source, resolvedNodePath(commandReply, requestedPath));
          if (!block) throw new Error(`Node '${requestedPath}' not found in active scene.`);
          return source.slice(0, block.start) + source.slice(block.end);
        }, {
          command: { op: 'node_delete', payload: { node_path: args.node_path } },
          verify: (source, reply) => verifyNodePresence(source, resolvedNodePath(reply, requestedPath), false)
        });

        const navigation = await follow3DWorkspace();
        if (typeof window !== 'undefined') {
          AgentFocusOverlay.hide('node_deleted');
          CameraGuidance.noteSceneChanged(null);
        }

        return liveMutationResult(res, {
          deleted_node: res.commandReply?.node_path || requestedPath,
          resolved_node_path: res.commandReply?.node_path || null,
          follow: navigation
        });
      }
    }
  ];

  // ==========================================
  // 7B. Canonical .tscn text mutations
  // ==========================================
  // The live path writes to two places: the running editor (through the command channel) and
  // the in-memory .tscn that export, persistence, and reload all read from. Those were two
  // separate implementations, and they drifted — a rotation applied in the editor never
  // reached the saved text, and a recoloured node kept pointing at its old material. Every
  // mutation now goes through one of the functions below, and when the editor has actually
  // applied the change its own serialized state is written back verbatim.

  const DEGREES_TO_RADIANS = Math.PI / 180;

  function formatFloat(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    // Match Godot's own .tscn style: no exponent, no trailing zero noise.
    return String(Math.abs(number) < 1e-6 ? 0 : Number(number.toFixed(6)));
  }

  function formatTransform3D(basis, origin) {
    return `Transform3D(${[...basis, ...origin].map(formatFloat).join(', ')})`;
  }

  // Godot composes Euler angles in YXZ order by default (Basis = Ry * Rx * Rz), and the
  // twelve .tscn floats are the basis *columns* followed by the origin.
  function basisFromEulerScale(rotationDegrees = [0, 0, 0], scale = [1, 1, 1]) {
    const [x, y, z] = rotationDegrees.map(value => (Number(value) || 0) * DEGREES_TO_RADIANS);
    const [sx, cx] = [Math.sin(x), Math.cos(x)];
    const [sy, cy] = [Math.sin(y), Math.cos(y)];
    const [sz, cz] = [Math.sin(z), Math.cos(z)];
    // Rows of Ry * Rx * Rz.
    const m = [
      [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx],
      [cx * sz, cx * cz, -sx],
      [-sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx]
    ];
    const s = [Number(scale[0]) || 0, Number(scale[1]) || 0, Number(scale[2]) || 0];
    // Emit columns, each scaled by that axis' scale factor.
    return [
      m[0][0] * s[0], m[1][0] * s[0], m[2][0] * s[0],
      m[0][1] * s[1], m[1][1] * s[1], m[2][1] * s[1],
      m[0][2] * s[2], m[1][2] * s[2], m[2][2] * s[2]
    ];
  }

  // Split a basis into its rotation columns and per-axis scale, so a position-only edit can
  // keep an existing rotation and scale instead of flattening both to identity.
  function decomposeBasis(basis) {
    const columns = [basis.slice(0, 3), basis.slice(3, 6), basis.slice(6, 9)];
    const scale = columns.map(column => Math.hypot(column[0], column[1], column[2]));
    const rotation = columns.map((column, index) => (scale[index] > 1e-9
      ? column.map(value => value / scale[index])
      : [index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0]));
    return { rotation: rotation.flat(), scale };
  }

  function multiplyBasis(left, right) {
    const column = (basis, index) => basis.slice(index * 3, index * 3 + 3);
    const apply = ([x, y, z]) => [
      left[0] * x + left[3] * y + left[6] * z,
      left[1] * x + left[4] * y + left[7] * z,
      left[2] * x + left[5] * y + left[8] * z
    ];
    return [...apply(column(right, 0)), ...apply(column(right, 1)), ...apply(column(right, 2))];
  }

  // Enumerate every [node ...] block with the scene-relative path Godot itself would use.
  // A `.tscn` may legitimately contain several nodes with the same leaf name under different
  // parents (BranchA/TwinOrb and BranchB/TwinOrb), so a block can only be identified by path.
  function enumerateNodeBlocks(source) {
    const blocks = [];
    const headerPattern = /^\[node name="([^"]+)"(?:\s+type="([^"]+)")?(?:\s+parent="([^"]+)")?[^\]]*\]/gm;
    for (const match of source.matchAll(headerPattern)) {
      const [header, name, type, parent] = match;
      blocks.push({
        name,
        type: type || null,
        parent: parent || null,
        nodePath: parent ? (parent === '.' ? name : `${parent}/${name}`) : '.',
        header,
        start: match.index
      });
    }
    for (let index = 0; index < blocks.length; index += 1) {
      // A block ends at the next section header of any kind, so a trailing [connection]
      // or [editable] block is never swallowed into the last node.
      const rest = source.slice(blocks[index].start + blocks[index].header.length);
      const nextSection = rest.search(/\n\[[a-z_]+[\s\]]/);
      blocks[index].end = nextSection < 0
        ? source.length
        : blocks[index].start + blocks[index].header.length + nextSection + 1;
      blocks[index].text = source.slice(blocks[index].start, blocks[index].end);
    }
    return blocks;
  }

  function normalizeNodePath(nodePath) {
    return String(nodePath || '').replace(/^\.\//, '').replace(/^res:\/\//, '').replace(/^\/+/, '');
  }

  // Resolve a requested path to exactly one block. An exact scene-relative path always wins.
  // A bare leaf name is accepted only when it is unambiguous — editing the wrong one of two
  // same-named nodes is worse than refusing, and refusing is what the editor channel does too.
  function findNodeBlock(source, nodePath) {
    const wanted = normalizeNodePath(nodePath);
    if (!wanted) return null;
    const blocks = enumerateNodeBlocks(source);
    const exact = blocks.find(block => block.nodePath === wanted);
    if (exact) return exact;
    const leaf = wanted.replace(/^.*\//, '');
    const byName = blocks.filter(block => block.name === leaf);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      const error = new Error(`'${nodePath}' is ambiguous: ${byName.length} nodes are named '${leaf}' (${byName.map(block => block.nodePath).join(', ')}). Pass the full scene-relative path.`);
      error.code = 'AMBIGUOUS_NODE_PATH';
      throw error;
    }
    return null;
  }

  function existingTransformOf(blockText) {
    const match = blockText.match(/transform\s*=\s*Transform3D\(([^)]*)\)/);
    if (match) {
      const parsed = transformFromLiteral(parseVectorLiteral(`(${match[1]})`));
      if (parsed) return parsed;
    }
    const position = blockText.match(/^position\s*=\s*Vector3\(([^)]*)\)/m);
    const origin = position ? parseVectorLiteral(`(${position[1]})`) : [0, 0, 0];
    return { basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: origin.length >= 3 ? origin.slice(0, 3) : [0, 0, 0] };
  }

  function writeTransformLine(blockText, header, transformLine) {
    if (/transform\s*=\s*Transform3D\([^)]*\)/.test(blockText)) {
      return blockText.replace(/transform\s*=\s*Transform3D\([^)]*\)/, transformLine);
    }
    // A node written with `position = Vector3(...)` gets upgraded to a full transform, and
    // the now-redundant position line is dropped so the two cannot disagree.
    const withoutPosition = blockText.replace(/^position\s*=\s*Vector3\([^)]*\)\n?/m, '');
    const headerEnd = withoutPosition.indexOf(']', withoutPosition.indexOf(header)) + 1;
    return `${withoutPosition.slice(0, headerEnd)}\n${transformLine}${withoutPosition.slice(headerEnd)}`;
  }

  // `authoritative` is the twelve floats the editor itself reported after applying the
  // change. When present it wins outright: the text then says exactly what Godot holds.
  function applyTransformToSceneText(source, nodePath, options = {}) {
    const block = findNodeBlock(source, nodePath);
    if (!block) throw new Error(`Node '${nodePath}' not found in active 3D scene.`);
    let basis;
    let origin;
    if (Array.isArray(options.authoritative) && options.authoritative.length >= 12) {
      basis = options.authoritative.slice(0, 9);
      origin = options.authoritative.slice(9, 12);
    } else {
      const current = existingTransformOf(block.text);
      const decomposed = decomposeBasis(current.basis);
      const relative = options.relative === true;
      const hasPosition = Array.isArray(options.position) && options.position.length >= 3;
      const hasRotation = Array.isArray(options.rotation) && options.rotation.length >= 3;
      const hasScale = Array.isArray(options.scale) && options.scale.length >= 3;

      origin = hasPosition
        ? (relative
          ? current.origin.map((value, index) => value + Number(options.position[index]))
          : options.position.slice(0, 3).map(Number))
        : current.origin.slice(0, 3);

      const scale = hasScale
        ? (relative
          ? decomposed.scale.map((value, index) => value * Number(options.scale[index]))
          : options.scale.slice(0, 3).map(Number))
        : decomposed.scale;

      if (hasRotation) {
        const rotationBasis = basisFromEulerScale(options.rotation.slice(0, 3), [1, 1, 1]);
        const composed = relative ? multiplyBasis(rotationBasis, decomposed.rotation) : rotationBasis;
        basis = [
          ...composed.slice(0, 3).map(v => v * scale[0]),
          ...composed.slice(3, 6).map(v => v * scale[1]),
          ...composed.slice(6, 9).map(v => v * scale[2])
        ];
      } else {
        // No rotation given: keep the existing orientation rather than flattening it.
        basis = [
          ...decomposed.rotation.slice(0, 3).map(v => v * scale[0]),
          ...decomposed.rotation.slice(3, 6).map(v => v * scale[1]),
          ...decomposed.rotation.slice(6, 9).map(v => v * scale[2])
        ];
      }
    }
    const updatedBlock = writeTransformLine(block.text, block.header, `transform = ${formatTransform3D(basis, origin)}`);
    return source.slice(0, block.start) + updatedBlock + source.slice(block.end);
  }

  const MATERIAL_SLOT_PATTERN = /^(surface_material_override\/0|material_override)\s*=\s*SubResource\("([^"]+)"\)/m;

  function materialSlotOf(blockText) {
    const match = blockText.match(MATERIAL_SLOT_PATTERN);
    return match ? { property: match[1], id: match[2] } : null;
  }

  function readMaterialSubResource(source, id) {
    const header = `[sub_resource type="StandardMaterial3D" id="${id}"]`;
    const start = source.indexOf(header);
    if (start < 0) return null;
    let end = source.length;
    for (const marker of ['\n[sub_resource ', '\n[node ', '\n[connection ']) {
      const index = source.indexOf(marker, start + 1);
      if (index > 0 && index < end) end = index;
    }
    const body = source.slice(start + header.length, end);
    const properties = {};
    for (const line of body.split('\n')) {
      const match = line.match(/^\s*([A-Za-z0-9_/]+)\s*=\s*(.+?)\s*$/);
      if (match) properties[match[1]] = match[2];
    }
    return { start, end, properties };
  }

  // Merge rather than replace: recolouring a node must not silently erase its emission.
  function mergeMaterialProperties(existing = {}, update = {}) {
    const merged = { ...existing };
    if (update.albedo_color !== undefined) merged.albedo_color = parseColor(update.albedo_color);
    if (typeof update.metallic === 'number') merged.metallic = String(update.metallic);
    if (typeof update.roughness === 'number') merged.roughness = String(update.roughness);
    if (update.emission !== undefined) {
      merged.emission_enabled = 'true';
      merged.emission = parseColor(update.emission);
    }
    if (typeof update.emission_energy === 'number') {
      merged.emission_enabled = 'true';
      merged.emission_energy_multiplier = String(update.emission_energy);
    }
    return merged;
  }

  function renderMaterialSubResource(id, properties) {
    const order = ['albedo_color', 'metallic', 'roughness', 'emission_enabled', 'emission', 'emission_energy_multiplier'];
    const keys = [...order.filter(key => key in properties), ...Object.keys(properties).filter(key => !order.includes(key))];
    return [`[sub_resource type="StandardMaterial3D" id="${id}"]`, ...keys.map(key => `${key} = ${properties[key]}`)].join('\n') + '\n';
  }

  // The old implementation always wrote a fresh `Mat_<node>` sub-resource and never pointed
  // the node at it, so a live recolour vanished on reload while the node kept referencing its
  // original material. Mutate the material the node actually uses; only mint a new one when
  // the node has no override, and then wire the reference up in the same edit.
  // How many nodes in the scene point at this material sub-resource.
  function materialReferenceCount(source, id) {
    return enumerateNodeBlocks(source).filter(block => materialSlotOf(block.text)?.id === id).length;
  }

  function uniqueMaterialId(source, nodePath) {
    const base = `Mat_${String(nodePath).replace(/[^A-Za-z0-9_]/g, '_')}`;
    if (!source.includes(`id="${base}"`)) return base;
    let suffix = 2;
    while (source.includes(`id="${base}_${suffix}"`)) suffix += 1;
    return `${base}_${suffix}`;
  }

  // Recolouring one node must not repaint every node that happens to share its material.
  // Godot's own editor copy-on-writes here (set_surface_override_material assigns a duplicate
  // to that node alone), so the serialized scene has to do the same: when the referenced
  // material is shared, fork it, apply the change to the fork, and repoint only this node.
  // Mutating the shared resource in place is how recolouring one comet turned both green.
  // Godot reports its post-apply material as bare-hex colours and floats. Converting that
  // into the same shape the request uses lets the .tscn be written from the editor's resolved
  // state, the way transforms already are, instead of from the request alone.
  function materialUpdateFromCommandReply(reply) {
    const resolved = reply?.material;
    if (!resolved || typeof resolved !== 'object') return null;
    const update = {};
    if (typeof resolved.albedo_color === 'string') update.albedo_color = resolved.albedo_color;
    if (typeof resolved.metallic === 'number') update.metallic = resolved.metallic;
    if (typeof resolved.roughness === 'number') update.roughness = resolved.roughness;
    if (resolved.emission_enabled === true) {
      if (typeof resolved.emission === 'string') update.emission = resolved.emission;
      if (typeof resolved.emission_energy === 'number') update.emission_energy = resolved.emission_energy;
    }
    return Object.keys(update).length > 0 ? update : null;
  }

  function applyMaterialToSceneText(source, nodePath, material = {}) {
    const block = findNodeBlock(source, nodePath);
    if (!block) throw new Error(`Node '${nodePath}' not found in active 3D scene.`);
    const slot = materialSlotOf(block.text);
    const shared = Boolean(slot) && materialReferenceCount(source, slot.id) > 1;
    const inherited = slot ? readMaterialSubResource(source, slot.id)?.properties : undefined;
    const targetId = slot && !shared ? slot.id : uniqueMaterialId(source, block.nodePath);
    const existing = shared ? null : (slot ? readMaterialSubResource(source, targetId) : null);
    // A fork starts from the shared material's values so only the requested fields change.
    const rendered = renderMaterialSubResource(targetId, mergeMaterialProperties(existing?.properties ?? (shared ? inherited : undefined), material));

    let updated;
    if (existing) {
      updated = source.slice(0, existing.start) + rendered.trimEnd() + source.slice(existing.end);
    } else {
      const firstNode = source.indexOf('\n[node name="');
      updated = firstNode > 0
        ? source.slice(0, firstNode) + '\n' + rendered + source.slice(firstNode)
        : source + '\n' + rendered;
    }

    // Wire the reference when the node had none, or when we forked a shared material.
    if (!slot || shared) {
      const refreshed = findNodeBlock(updated, block.nodePath);
      if (!refreshed) throw new Error(`Node '${nodePath}' disappeared while assigning its material.`);
      const wired = slot
        ? refreshed.text.replace(MATERIAL_SLOT_PATTERN, `${slot.property} = SubResource("${targetId}")`)
        : (() => {
          const headerEnd = refreshed.text.indexOf(']') + 1;
          return `${refreshed.text.slice(0, headerEnd)}\nsurface_material_override/0 = SubResource("${targetId}")${refreshed.text.slice(headerEnd)}`;
        })();
      updated = updated.slice(0, refreshed.start) + wired + updated.slice(refreshed.end);
    }
    return updated;
  }

  // ==========================================
  // 7. Fail-Closed Manifest Startup Verification
  // ==========================================
  for (const entry of MANIFEST_TOOLS) {
    if (!entry.definition || !entry.definition.name || typeof entry.handler !== 'function') {
      throw new Error(`[WebMCP Fatal] Invalid manifest entry: ${JSON.stringify(entry)}`);
    }
  }

  // ==========================================
  // 8. Safe Native WebMCP Registration Core
  // ==========================================
  // The WebMCP surface is still being standardised and the drafts disagree on the
  // registration verb: some hosts expose `registerTool`, others only
  // `provideContext({ tools })` alongside `getTools`/`executeTool`. Demanding
  // `registerTool` alone made every spec-shaped host look unsupported — that is the
  // `0 Tools (UNSUPPORTED)` the deployed page reports. Accept any surface we can
  // actually publish onto, document first, then navigator.
  function usableModelContext(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    if (typeof candidate.registerTool === 'function') return 'registerTool';
    if (typeof candidate.provideContext === 'function') return 'provideContext';
    if (typeof candidate.executeTool === 'function' && typeof candidate.getTools === 'function') return 'provideContext';
    return null;
  }

  function resolveNativeModelContext() {
    const candidates = [];
    try {
      if (typeof document !== 'undefined' && document.modelContext) candidates.push(['document.modelContext', document.modelContext]);
    } catch (e) {}
    try {
      if (typeof navigator !== 'undefined' && navigator.modelContext) candidates.push(['navigator.modelContext', navigator.modelContext]);
    } catch (e) {}
    for (const [surface, context] of candidates) {
      const mode = usableModelContext(context);
      if (mode) return { context, surface, mode };
    }
    return null;
  }

  // ==========================================
  // 8B. Editor-Level Agent Observation Layer
  // ==========================================
  const AgentObservationHUD = {
    sequence: 0,
    entries: [],

    describe(toolName, input = {}) {
      const labels = {
        godot_create_project: `Creating project: ${input.project_name || 'Untitled'} (${input.template || 'custom'})`,
        godot_begin_project_upload: `Beginning staged project upload: ${input.project_name || 'Untitled'}`,
        godot_upload_project_file_chunk: `Uploading chunk: ${input.path || 'project file'} (${input.chunk_index + 1}/${input.total_chunks})`,
        godot_upload_project_chunk_batch: `Uploading chunk batch: ${input.chunks?.length || 0} files`,
        godot_get_project_upload_status: `Inspecting staged upload: ${input.upload_id || 'unknown'}`,
        godot_abort_project_upload: `Aborting staged upload: ${input.upload_id || 'unknown'}`,
        godot_commit_project_upload: `Committing staged upload: ${input.upload_id || 'unknown'}`,
        godot_restore_project_session: 'Restoring persisted editor session',
        godot_list_saved_projects: 'Listing projects saved in this browser',
        godot_open_saved_project: `Opening saved project: ${input.project_name || 'unknown'}`,
        godot_adopt_open_project: 'Adding the open project to the library',
        godot_get_user_focus: 'Reading what you have selected',
        godot_import_asset: `Importing asset: ${input.path || 'file'}`,
        godot_author_3d_runner: `Authoring 3D runner architecture: ${input.project_name || 'Neon Skyrail'}`,
        godot_inspect_project_files: input.paths?.length ? `Inspecting ${input.paths.length} project files` : 'Inspecting authoritative project manifest',
        godot_apply_file_transaction: input.label ? `${input.label} (${input.operations?.length || 1} file${input.operations?.length === 1 ? '' : 's'})` : `Applying file transaction (${input.operations?.length || 0} operations)`,
        godot_apply_text_patch: input.label || `Patching ${input.target_path || 'file'}`,
        godot_apply_script_patch: input.label || `${input.content ? 'Writing' : 'Editing'} ${String(input.path || 'script').replace(/^res:\/\//, '')}`,
        godot_undo_transaction: `Undoing transaction: ${input.undo_id || 'latest snapshot'}`,
        godot_run_game: 'Launching live game test viewport',
        godot_stop_game: 'Stopping game session',
        godot_send_input: `Player input: ${input.key || 'Key'} ${input.pressed === false ? 'released' : 'pressed'}`,
        godot_send_input_sequence: `Scheduling input sequence: ${input.events?.length || 0} flight maneuvers`,
        godot_get_input_sequence_status: `Inspecting flight sequence: ${input.sequence_id || 'recent'}`,
        godot_capture_viewport: 'Capturing live viewport frame',
        godot_send_pointer: `Pointer ${input.action || 'click'} at (${input.x || 0}, ${input.y || 0})`,
        godot_start_recording: `Starting persistent viewport recording (${input.fps || 30} FPS)`,
        godot_stop_recording: 'Stopping and persisting viewport recording',
        godot_list_recordings: 'Listing persistent viewport recordings',
        godot_select_node_live: `Selecting live scene node: ${input.node_path || 'Player'}`,
        godot_transform_node_live: `Transforming node: ${input.node_path || 'Player'}`,
        godot_connect_signal_live: `Wiring signal: ${input.signal || 'signal'} -> ${input.target_method || 'handler'}`,
        godot_live_code_diff: input.instruction ? `${input.instruction} (${input.script_path || 'script'})` : `Live code edit: ${input.script_path || 'script'}`,
        godot_hot_reload_property: `Hot reload: ${input.node_path || 'node'}.${input.property_name || 'property'} = ${JSON.stringify(input.value)}`,
        godot_open_scene: `Opening scene: ${input.scene_path || 'main scene'}`,
        godot_synthesize_audio_suite: 'Synthesizing 8-track dynamic audio suite',
        godot_generate_audio_fx: `Generating procedural ${input.type || 'FX'} sound (${input.duration_seconds || 0.5}s)`,
        godot_export_zip: 'Packaging full project ZIP package',
        godot_get_session_status: 'Inspecting engine session',
        godot_get_operation_status: `Inspecting operation: ${input.operation_id || 'active/recent'}`,
        godot_get_game_telemetry: 'Reading project-owned game telemetry',
        godot_get_logs: 'Reading engine logs',
        godot_diagnose_session: 'Diagnosing engine and project health',
        godot_camera_focus: `Framing ${input.node_path || 'node'} in the 3D viewport`,
        godot_camera_follow: `${input.enabled === false ? 'Disabling' : input.enabled === true ? 'Enabling' : 'Reading'} automatic camera follow`,
        godot_workspace_follow: `${input.enabled === false ? 'Disabling' : input.enabled === true ? 'Enabling' : 'Reading'} workspace follow`,
        godot_node_spawn: `Spawning ${input.name || 'Node3D'} (${input.mesh_type || 'box'})`,
        godot_node_instance: `Placing ${input.name || 'model'} from ${String(input.scene_path || '').split('/').pop() || 'a scene'}`,
        godot_node_transform: `Transforming ${input.node_path || 'node'}`,
        godot_node_material: `Recolouring ${input.node_path || 'node'}`,
        godot_node_delete: `Deleting ${input.node_path || 'node'}`
      };
      return labels[toolName] || toolName.replace(/^godot_/, '').replaceAll('_', ' ');
    },

    // The banner and the feed duplicated each other's top row in two different corners.
    // Both are now one line in the bottom rail; this object keeps the entry state and the
    // observation eventing, and the rail owns every pixel.
    ensure() {
      return AgentStatusRail.ensure();
    },

    renderFeed() {
      AgentStatusRail.render();
    },

    escape(value) {
      return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    },

    update(status, toolName, input, detail = '', entryId = null, extra = {}) {
      const label = this.describe(toolName, input);
      const now = Date.now();
      let entry = entryId ? this.entries.find(item => item.id === entryId) : null;
      if (entry) {
        entry.status = status;
        entry.detail = detail;
        entry.completedAt = now;
        entry.durationMs = now - entry.startedAt;
        entry.revision = DiagnosticState.sceneRevision;
        if (extra.operation_id) entry.operationId = extra.operation_id;
        if (extra.phase) entry.phase = extra.phase;
        if (extra.sequence) entry.sequence = extra.sequence;
        if (Array.isArray(extra.timeline)) entry.timeline = extra.timeline.map(event => ({ ...event }));
        if (typeof extra.terminal === 'boolean') entry.terminal = extra.terminal;
        if (extra.target) entry.target = extra.target;
        if (extra.change) entry.change = extra.change;
        if (extra.diagnostics) entry.diagnostics = extra.diagnostics;
      } else {
        entry = {
          id: ++this.sequence,
          operationId: extra.operation_id || null,
          phase: extra.phase || null,
          sequence: extra.sequence || 0,
          terminal: extra.terminal || false,
          timeline: Array.isArray(extra.timeline) ? extra.timeline.map(event => ({ ...event })) : [],
          target: extra.target || null,
          change: extra.change || null,
          diagnostics: extra.diagnostics || null,
          status,
          toolName,
          label,
          detail,
          at: now,
          startedAt: now,
          revision: DiagnosticState.sceneRevision
        };
        this.entries.push(entry);
      }
      // Presence is derived here rather than tracked separately: this is the one funnel every
      // tool call passes through, so the two can never disagree about whether an agent is
      // working. Read-only tools are deliberately excluded - inspecting the session is not
      // "working on your model", and saying so would make the signal meaningless.
      if (!DIAGNOSTIC_TOOLS.has(toolName)) {
        if (status === 'running') AgentPresence.begin(label, extra.target?.node_path || AgentPresence.target);
        else if (status !== 'pending') AgentPresence.settle(status === 'succeeded');
      }
      AgentPresence.attach();
      activeLogs.push({ level: status === 'failed' ? 'error' : 'info', time: entry.at, msg: `[Agent #${entry.id}] ${status}: ${label}${detail ? ` — ${detail}` : ''}` });
      if (activeLogs.length > MAX_LOGS) activeLogs.shift();
      this.renderFeed();
      const observationDetail = {
        id: entry.id,
        operation_id: entry.operationId || null,
        tool: toolName,
        label: entry.label,
        status,
        phase: entry.phase || null,
        sequence: entry.sequence || 0,
        terminal: entry.terminal || false,
        is_diagnostic: DIAGNOSTIC_TOOLS.has(toolName),
        // Retained alongside the existing fields rather than replacing them, so an older
        // consumer of this event keeps working while a newer one can render the change.
        target: entry.target || null,
        change: entry.change || null,
        diagnostics: entry.diagnostics || null,
        follow: FollowAgent.describe(),
        at: entry.at,
        duration_ms: entry.durationMs
      };
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('godot:webmcp-observation', { detail: observationDetail }));
      }
      if (activeWebSocketRelay && activeWebSocketRelay.readyState === WebSocket.OPEN) {
        try {
          activeWebSocketRelay.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/webmcp_observation',
            params: observationDetail
          }));
        } catch (_) {}
      }
      return entry;
    }
  };

  // One "Complete" hid three different outcomes. Spell out which stage was actually reached:
  // the editor applying a command is not the same as the scene source matching it, and
  // neither is the same as a camera we watched move.
  function describeOutcome(result) {
    if (!result || typeof result !== 'object') return '';
    const parts = [];
    if (result.scene_revision) parts.push(`Rev #${result.scene_revision}`);
    if (result.editor_channel === 'command') parts.push('applied live');
    else if (result.editor_restarted) parts.push('applied via restart');
    if (result.source_synced) parts.push(result.source_authoritative ? 'source from editor' : 'source written');
    if (result.status === 'framed') parts.push(result.target_reached ? 'camera framed' : 'camera moved');
    if (result.status === 'dispatched_unconfirmed') parts.push('camera unconfirmed');
    if (result.status === 'yielded') parts.push('yielded to you');
    if (result.status === 'overlay_only') parts.push('overlay only');
    if (parts.length === 0 && result.success === true) parts.push('Complete');
    return parts.join(' · ');
  }

  let activeWebSocketRelay = null;

  async function executeObservedTool(tool, input = {}) {
    await projectHydrationPromise;

    // Diagnostic reads are executed without adding visual rows on success, but errors are recorded
    if (DIAGNOSTIC_TOOLS.has(tool.definition.name)) {
      try {
        const result = await tool.handler(input, {});
        // If an active operation was inspected and we have observation rows, update parent row in place
        if (tool.definition.name === 'godot_get_operation_status' && result?.operation_id) {
          const operation = managedOperations.get(result.operation_id);
          if (operation?.observationIds?.size) {
            const elapsed = ((Date.now() - operation.startedAt) / 1000).toFixed(1);
            const detail = operation.terminal
              ? (operation.status === 'succeeded' ? (operation.result?.scene_revision ? `Rev #${operation.result.scene_revision}` : 'Complete') : operation.error)
              : `${phaseLabel(operation.phase)} · ${elapsed} s`;
            for (const obsId of operation.observationIds) {
              AgentObservationHUD.update(operation.status, operation.tool, {}, detail, obsId);
            }
          }
        }
        return result;
      } catch (err) {
        activeLogs.push({ level: 'error', time: Date.now(), msg: `[Diagnostic Failure] ${tool.definition.name}: ${err.message || String(err)}` });
        AgentObservationHUD.update('failed', tool.definition.name, input, err instanceof Error ? err.message : String(err));
        throw err;
      }
    }

    const observation = AgentObservationHUD.update('running', tool.definition.name, input);
    const context = { observation_id: observation.id };
    try {
      const result = await tool.handler(input, context);
      if (result?.status === 'pending' && result.operation_id) {
        const operation = managedOperations.get(result.operation_id);
        if (operation) {
          if (!operation.observationIds) operation.observationIds = new Set();
          operation.observationIds.add(observation.id);
          if (operation.status !== 'running') {
            const detail = operation.status === 'succeeded'
              ? (operation.result?.scene_revision ? `Rev #${operation.result.scene_revision}` : 'Complete')
              : operation.error;
            AgentObservationHUD.update(operation.status, tool.definition.name, input, detail, observation.id);
            return result;
          }
        }
        AgentObservationHUD.update('pending', tool.definition.name, input, `Operation ${result.operation_id}`, observation.id);
        return result;
      }
      AgentObservationHUD.update('succeeded', tool.definition.name, input, describeOutcome(result), observation.id);
      return result;
    } catch (error) {
      AgentObservationHUD.update('failed', tool.definition.name, input, error instanceof Error ? error.message : String(error), observation.id);
      throw error;
    }
  }

  function nativeToolDefinition(tool) {
    const definition = tool.definition;
    return {
      name: definition.name,
      description: definition.description,
      annotations: definition.annotations,
      // Native WebMCP uses camelCase and expects the executable handler on the
      // tool object. `input_schema` remains the MCP HTTP catalog shape.
      inputSchema: definition.input_schema,
      execute: async (input) => executeObservedTool(tool, input || {})
    };
  }

  // index.html's playtest copier fingerprints the bytes it wrote using this exact
  // implementation, so the two sides cannot drift into disagreeing framings.
  if (typeof window !== 'undefined') {
    window.__godotFingerprintFiles = fingerprintProjectBytes;
  }

  function installTestBridge() {
    if (typeof window === 'undefined') return;
    const origin = window.location.origin;
    const pageUrl = window.location.href;

    window.godotWebMcpTestBridge = {
      getTools: () => MANIFEST_TOOLS.map(t => ({ ...t.definition, origin, pageUrl })),
      callTool: async (name, args) => {
        const tool = MANIFEST_TOOLS.find(t => t.definition.name === name);
        if (!tool) throw new Error(`Tool '${name}' not found`);
        return await executeObservedTool(tool, args || {});
      }
    };

    window.fetchTools = async () => ({
      tools: MANIFEST_TOOLS.map(t => ({ ...t.definition, origin, pageUrl }))
    });
    window.callWebMCPTool = async (name, args) => window.godotWebMcpTestBridge.callTool(name, args);
  }

  async function registerAllNativeTools() {
    const native = resolveNativeModelContext();
    DiagnosticState.webmcp = 'registering';
    let count = 0;

    if (native) {
      DiagnosticState.webmcpSurface = native.surface;
      console.log(`[WebMCP] Found native surface: ${native.surface}. Registering ${MANIFEST_TOOLS.length} tools...`);
      const controller = new AbortController();
      if (native.mode === 'provideContext' && typeof native.context.provideContext === 'function') {
        try {
          await native.context.provideContext({ tools: MANIFEST_TOOLS.map(nativeToolDefinition) });
          count = MANIFEST_TOOLS.length;
        } catch (err) {
          console.error(`[WebMCP] Bulk registration failed on ${native.surface}:`, err);
          DiagnosticState.webmcpLastError = `provideContext: ${err.message}`;
        }
      } else {
        for (const tool of MANIFEST_TOOLS) {
          try {
            await native.context.registerTool(nativeToolDefinition(tool), { signal: controller.signal });
            count++;
          } catch (err) {
            console.error(`[WebMCP] Error registering tool '${tool.definition.name}' on ${native.surface}:`, err);
            DiagnosticState.webmcpLastError = `${tool.definition.name}: ${err.message}`;
          }
        }
      }
      if (DiagnosticState.webmcpLastError) {
        DiagnosticState.webmcp = 'failed';
      } else {
        DiagnosticState.webmcp = 'ready';
      }
      DiagnosticState.webmcpRegisteredCount = count;
      // Additive, never authoritative: headless relay agents and the verification
      // harness still need a callable path when a native surface is present.
      installTestBridge();
    } else {
      console.warn('[WebMCP] Native ModelContext not present in browser. Enabling test discovery bridge...');
      DiagnosticState.webmcp = 'unsupported';
      DiagnosticState.webmcpRegisteredCount = 0;
      DiagnosticState.webmcpSurface = 'application_test_bridge';
      installTestBridge();
    }
  }

  // ==========================================
  // ==========================================
  // 8B2. Agent presence
  // ==========================================
  //
  // The difference between a marker and a collaborator.
  //
  // The overlay this replaces drew a bracketed box at the place a change had just happened,
  // held it for 3.2 seconds, and vanished. Every edit therefore read as an isolated event: a
  // box blinked somewhere, then nothing, and between edits there was no sign that anything
  // was attached at all. Presence is a *state* - attached, working on this node, this many
  // changes so far - and it is what makes a run of edits read as one agent at work.
  // Whether the work is already comfortably in frame.
  //
  // Re-framing on every edit is what makes agent-driven camera work feel twitchy: the camera
  // lurches to a node that was already perfectly visible, and a run of small tweaks turns into
  // a series of jolts. The camera should move when the work would otherwise be hard to see -
  // outside the frame, crowded against an edge, a speck, or so close it fills the view - and
  // hold still the rest of the time. Pure, so the policy is testable without a camera.
  function framingComfort(projection, radius, rect, options = {}) {
    if (!projection || projection.onScreen !== true) return { comfortable: false, reason: 'off_screen' };
    if (!rect || !rect.width || !rect.height) return { comfortable: false, reason: 'no_viewport' };
    const margin = typeof options.margin === 'number' ? options.margin : 0.16;
    const minRadius = typeof options.minRadius === 'number' ? options.minRadius : 18;
    const maxRadius = typeof options.maxRadius === 'number'
      ? options.maxRadius
      : Math.min(rect.width, rect.height) * 0.62;
    const insetX = rect.width * margin;
    const insetY = rect.height * margin;
    const withinX = projection.x >= rect.left + insetX && projection.x <= rect.left + rect.width - insetX;
    const withinY = projection.y >= rect.top + insetY && projection.y <= rect.top + rect.height - insetY;
    if (!withinX || !withinY) return { comfortable: false, reason: 'near_edge' };
    if (radius < minRadius) return { comfortable: false, reason: 'too_small' };
    if (radius > maxRadius) return { comfortable: false, reason: 'too_close' };
    return { comfortable: true, reason: null };
  }

  const AgentPresence = {
    state: 'detached',
    target: null,
    action: '',
    completed: 0,
    startedAt: 0,
    settledAt: 0,

    attach() {
      if (this.state === 'detached') this.state = 'attached';
    },

    begin(action, target) {
      this.state = 'working';
      this.action = action || 'Working';
      if (target) this.target = target;
      this.startedAt = Date.now();
      ActivityBeam.sync();
    },

    settle(ok = true) {
      if (this.state === 'working' && ok) this.completed += 1;
      this.state = 'attached';
      this.settledAt = Date.now();
      ActivityBeam.sync();
    },

    // The node the agent is holding, which outlives any single operation: after an edit
    // settles, "still on SkyrailDeck" is true and useful until it moves somewhere else.
    hold(target) {
      if (target) this.target = target;
    },

    describe() {
      return {
        state: this.state,
        target: this.target,
        action: this.action,
        completed: this.completed,
        working_ms: this.state === 'working' ? Date.now() - this.startedAt : 0
      };
    }
  };

  // A two-pixel line across the top of the page while an operation is in flight. It is the
  // only always-visible "something is happening" signal that does not need the rail to be
  // read, and it costs no layout: nothing on the page moves when it appears.
  const ActivityBeam = {
    node: null,

    ensure() {
      if (typeof document === 'undefined' || !document.body) return false;
      if (!this.node) {
        this.node = document.createElement('div');
        this.node.id = 'webmcp-activity-beam';
        this.node.setAttribute('aria-hidden', 'true');
        this.node.style.cssText = [
          'position:fixed', 'left:0', 'right:0', 'top:0', 'height:2px',
          'z-index:var(--gd-z-return, 1000)', 'pointer-events:none',
          'opacity:0', 'transition:opacity .22s ease',
          'background:linear-gradient(90deg, transparent 0%, var(--gd-accent, #538dda) 18%, #8fc0ff 50%, var(--gd-accent, #538dda) 82%, transparent 100%)',
          'background-size:220% 100%'
        ].join(';');
        document.body.appendChild(this.node);
        this.ensureKeyframes();
      }
      return true;
    },

    ensureKeyframes() {
      if (document.getElementById('webmcp-beam-keyframes')) return;
      const style = document.createElement('style');
      style.id = 'webmcp-beam-keyframes';
      style.textContent = '@keyframes webmcp-beam-sweep{0%{background-position:120% 0}100%{background-position:-120% 0}}'
        + '@keyframes webmcp-halo-breathe{0%,100%{transform:scale(1);opacity:.55}50%{transform:scale(1.08);opacity:.85}}'
        + '@media (prefers-reduced-motion: reduce){#webmcp-activity-beam{animation:none !important}'
        + '[data-webmcp-halo]{animation:none !important}}';
      document.head.appendChild(style);
    },

    sync() {
      if (!this.ensure()) return;
      const working = AgentPresence.state === 'working';
      this.node.style.opacity = working ? '1' : '0';
      this.node.style.animation = working && !prefersReducedMotion()
        ? 'webmcp-beam-sweep 1.1s linear infinite'
        : 'none';
    }
  };

  // 8C. Agent 3D Focus Overlay — anchored, eased, edge-clamped
  // ==========================================
  // The previous version drew a reticle at a hard-coded `top:44%; left:50%`, so it sat dead
  // centre while the node it named was off-screen. This one projects the node's real world
  // position through the real camera and either anchors a reticle to it or, when it falls
  // outside the frustum, clamps a direction arrow to the frame edge with a distance label.
  const AgentFocusOverlay = {
    overlay: null,
    frame: null,
    hideTimer: null,
    animation: null,
    current: null,

    ensure() {
      if (typeof document === 'undefined' || !document.body) return false;
      if (!this.overlay) {
        this.overlay = document.createElement('div');
        this.overlay.id = 'webmcp-3d-focus-overlay';
        this.overlay.setAttribute('aria-hidden', 'true');
        this.overlay.style.cssText = [
          'position:fixed', 'left:0', 'top:0', 'z-index:var(--gd-z-rail, 900)',
          'pointer-events:none', 'opacity:0', 'will-change:transform,opacity',
          'transition:opacity .16s ease'
        ].join(';');
        document.body.appendChild(this.overlay);
      }
      return true;
    },

    hide(reason = 'idle', publishState = true) {
      if (this.overlay) this.overlay.style.opacity = '0';
      if (this.animation !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.animation);
      this.animation = null;
      this.current = null;
      // A note like `SentinelRight · framed` must not linger in the rail after the reticle it
      // describes is gone — least of all through a playtest.
      if (reason !== 'unresolved_target' && reason !== 'no_camera_pose' && reason !== 'canvas_not_laid_out') {
        AgentStatusRail.setFocusNote('');
      }
      if (publishState) this.publish({ mode: 'hidden', reason });
    },

    pendingFrom: null,

    // Called BEFORE the mutation, with the node's current position, so the light is already on
    // the node while the edit is in flight instead of appearing once it is over. A node that
    // does not exist yet (a spawn) has nothing to anchor to, so only presence is set - an
    // anchor over a guessed position would be worse than no anchor.
    beginWork(nodeName, action) {
      AgentPresence.begin(action, nodeName);
      AgentStatusRail.render();
      const previous = findSceneNode(activeFilesDict, nodeName)?.world_position || null;
      this.pendingFrom = Array.isArray(previous) ? previous.slice() : null;
      if (!previous) return { mode: 'presence_only' };
      return this.focus(nodeName, previous, 'Node3D', action, { phase: 'working' });
    },

    settleWork(nodeName, position, action, ok = true) {
      AgentPresence.settle(ok);
      AgentPresence.hold(nodeName);
      const from = this.pendingFrom;
      this.pendingFrom = null;
      AgentStatusRail.render();
      return this.focus(nodeName, position, 'Node3D', action, { phase: 'settled', from });
    },

    // Read by the verification harness (test/checklists/camera.md) so a check can assert
    // where the work light actually landed rather than eyeballing a screenshot.
    publish(state) {
      if (typeof window === 'undefined') return;
      window.__webmcpFocusState = { ...state, at: Date.now() };
    },

    resolveTarget(nodeName, fallbackPosition) {
      const node = findSceneNode(activeFilesDict, nodeName);
      const worldPosition = node?.world_position
        || (Array.isArray(fallbackPosition) && fallbackPosition.length >= 3 ? fallbackPosition.map(Number) : null);
      return {
        node,
        worldPosition,
        halfExtents: node?.aabb?.half_extents || [0.5, 0.5, 0.5]
      };
    },

    focus(nodeName, pos = null, type = 'Node3D', action = 'Working on', options = {}) {
      const phase = options.phase === 'working' ? 'working' : 'settled';
      if (!this.ensure()) return { mode: 'hidden', reason: 'no_document' };
      if (!editorSurfaceLive()) {
        // Neither the editor nor the playtest is on screen; there is nothing to point at.
        this.hide('editor_surface_gone');
        return { mode: 'hidden', reason: 'editor_surface_gone' };
      }
      const surface = resolveGodotCanvas('auto');
      const target = this.resolveTarget(nodeName, pos);
      if (!surface || !target.worldPosition) {
        this.hide('unresolved_target');
        AgentStatusRail.setFocusNote(`${nodeName} · position unknown`);
        return { mode: 'hidden', reason: 'unresolved_target' };
      }
      const pose = resolveCameraPose(surface.viewport);
      if (!pose) {
        // No camera we are entitled to trust. Say so in the rail instead of drawing a
        // reticle over a screen position we cannot compute.
        this.hide('no_camera_pose');
        const coordinates = target.worldPosition.map(value => Number(value).toFixed(1)).join(', ');
        AgentStatusRail.setFocusNote(`${nodeName} · [${coordinates}] · camera pose unavailable`);
        return { mode: 'hidden', reason: 'no_camera_pose' };
      }

      const rect = surface.canvas.getBoundingClientRect();
      // A canvas with no laid-out size cannot be projected onto. This is the normal state in
      // a hidden or backgrounded tab, where the host pauses requestAnimationFrame and
      // index.html's adjustCanvasDimensions never runs — report it as the environment fact
      // it is rather than as a projection error.
      if (!rect.width || !rect.height) {
        this.hide('canvas_not_laid_out', false);
        const coordinates = target.worldPosition.map(value => Number(value).toFixed(1)).join(', ');
        AgentStatusRail.setFocusNote(`${nodeName} · [${coordinates}] · viewport not laid out`);
        this.publish({
          mode: 'hidden',
          reason: 'canvas_not_laid_out',
          nodeName,
          world_position: target.worldPosition,
          canvas_rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          camera_source: pose.source
        });
        return { mode: 'hidden', reason: 'canvas_not_laid_out' };
      }
      const projection = projectWorldPoint(target.worldPosition, pose, rect);
      if (!projection) {
        this.hide('projection_failed', false);
        this.publish({ mode: 'hidden', reason: 'projection_failed', nodeName, world_position: target.worldPosition });
        return { mode: 'hidden', reason: 'projection_failed' };
      }

      const radius = projectedRadius(target.halfExtents, projection, rect);
      // A move is shown as a move. `from` is the node's own previous world position, projected
      // through the same camera, so the trail is the screen-space path between two points the
      // editor actually reported - never an invented arc.
      let trail = null;
      if (Array.isArray(options.from) && options.from.length >= 3 && projection.onScreen) {
        const origin = projectWorldPoint(options.from.map(Number), pose, rect);
        if (origin && origin.onScreen) {
          const dx = origin.x - projection.x;
          const dy = origin.y - projection.y;
          const length = Math.hypot(dx, dy);
          if (length > 12) trail = { length, angle: Math.atan2(dy, dx) * 180 / Math.PI };
        }
      }
      const state = projection.onScreen
        ? this.renderWorkLight(nodeName, type, action, target, projection, radius, rect, pose, { phase, trail })
        : this.renderEdgeArrow(nodeName, type, action, target, projection, rect, pose, phase);

      clearTimeout(this.hideTimer);
      // While the agent is working the light stays. It only starts fading once the change has
      // settled, and it fades rather than blinking out.
      if (phase !== 'working') {
        this.hideTimer = setTimeout(() => this.fade('settled'), 2600);
      }
      return state;
    },

    // A fade, not a disappearance. `hide()` still exists for the cases where the anchor became
    // meaningless (no camera, editor gone) and holding a light there would be a lie.
    fade(reason = 'settled') {
      if (!this.overlay) return;
      this.overlay.style.transition = 'opacity .55s ease';
      this.overlay.style.opacity = '0';
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        this.overlay.style.transition = 'opacity .16s ease';
        this.hide(reason);
      }, 560);
    },

    // Eased over MAX_FOCUS_FRAMES, or snapped for reduced-motion users.
    moveTo(x, y) {
      const reduced = typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
      const from = this.current || { x, y };
      this.current = { x, y };
      if (this.animation !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.animation);
      this.animation = null;
      if (reduced || typeof requestAnimationFrame !== 'function') {
        this.overlay.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        return;
      }
      const frames = 8;
      let frame = 0;
      const step = () => {
        frame += 1;
        const progress = frame / frames;
        const eased = progress * progress * (3 - 2 * progress);
        const currentX = from.x + (x - from.x) * eased;
        const currentY = from.y + (y - from.y) * eased;
        this.overlay.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
        if (frame < frames) this.animation = requestAnimationFrame(step);
        else this.animation = null;
      };
      this.animation = requestAnimationFrame(step);
    },

    label(nodeName, type, action, detail, phase = 'settled') {
      // Sentence case, not a shouting all-caps verb. The label reads as a person describing
      // what they are doing, which is the register the rest of these surfaces use.
      const dot = phase === 'working' ? 'var(--gd-accent,#538dda)' : 'var(--gd-ok,#6cc36c)';
      return `<div style="margin-top:${Math.round(28)}px;display:flex;align-items:center;gap:7px;padding:4px 10px;border:1px solid var(--gd-border,#484848);border-radius:999px;background:var(--gd-panel,#1b1b1b);color:var(--gd-text,#d0d0d0);font:500 12px/1.3 var(--gd-font-ui,Inter,system-ui,sans-serif);white-space:nowrap;transform:translateX(-50%);box-shadow:0 6px 18px rgba(0,0,0,.45)">`
        + `<span aria-hidden="true" style="width:6px;height:6px;border-radius:50%;background:${dot};flex:0 0 auto"></span>`
        + `<span>${this.escape(action)}</span>`
        + `<span style="color:var(--gd-text,#d0d0d0);font-weight:600">${this.escape(nodeName)}</span>`
        + `<span style="color:var(--gd-text-muted,#9a9a9a);font:400 11px/1.3 var(--gd-font-mono,ui-monospace,monospace)">${this.escape(detail)}</span>`
        + `</div>`;
    },

    escape(value) {
      return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    },

    // The work light.
    //
    // Not a bounding box. A box says "a thing happened inside this rectangle" and then has to
    // leave, because a permanent rectangle over someone's model is intolerable. A soft light
    // anchored on the node can stay for as long as the agent is actually there, breathe while
    // it works, and settle rather than vanish - which is what makes a sequence of edits read
    // as one collaborator rather than as a series of blinks.
    renderWorkLight(nodeName, type, action, target, projection, radius, rect, pose, options = {}) {
      const phase = options.phase === 'working' ? 'working' : 'settled';
      const diameter = Math.round(Math.max(radius * 2.4, 54));
      const coordinates = target.worldPosition.map(value => Number(value).toFixed(1)).join(', ');
      const accent = phase === 'working' ? 'var(--gd-accent, #538dda)' : 'var(--gd-ok, #6cc36c)';
      const breathe = phase === 'working' && !prefersReducedMotion()
        ? 'animation:webmcp-halo-breathe 1.6s ease-in-out infinite;'
        : '';
      // The trail is the part a box could never show: where the node came FROM. It is drawn
      // only when the editor reported an actual move, and only in screen space, so it cannot
      // claim a path through the world that the node did not take.
      const trail = options.trail
        ? `<span aria-hidden="true" style="position:absolute;left:50%;top:50%;width:${Math.round(options.trail.length)}px;height:3px;`
          + `margin-top:-1.5px;transform-origin:0 50%;transform:rotate(${options.trail.angle.toFixed(2)}deg);`
          + `background:linear-gradient(90deg, transparent 0%, ${accent} 85%);opacity:.85;border-radius:3px;`
          + `box-shadow:0 0 8px ${accent}"></span>`
          // A dot at the far end marks where the node started, so the trail reads as "from
          // there to here" rather than as an arbitrary tick.
          + `<span aria-hidden="true" style="position:absolute;left:50%;top:50%;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;`
          + `transform-origin:3.5px 3.5px;transform:rotate(${options.trail.angle.toFixed(2)}deg) translateX(${Math.round(options.trail.length)}px);`
          + `border:1.5px solid ${accent};border-radius:50%;opacity:.75"></span>`
        : '';
      this.overlay.innerHTML =
        `<div style="position:relative;width:0;height:0">`
        + trail
        + `<span data-webmcp-halo="1" aria-hidden="true" style="position:absolute;left:50%;top:50%;width:${diameter}px;height:${diameter}px;`
        + `margin-left:${-diameter / 2}px;margin-top:${-diameter / 2}px;border-radius:50%;${breathe}`
        + `background:radial-gradient(circle, color-mix(in srgb, ${accent} 34%, transparent) 0%, transparent 70%)"></span>`
        + `<span aria-hidden="true" style="position:absolute;left:50%;top:50%;width:${Math.round(diameter * 0.52)}px;height:${Math.round(diameter * 0.52)}px;`
        + `margin-left:${-Math.round(diameter * 0.52) / 2}px;margin-top:${-Math.round(diameter * 0.52) / 2}px;`
        + `border:1.5px solid ${accent};border-radius:50%;opacity:.9"></span>`
        + `</div>`
        + this.label(nodeName, type, action, `[${coordinates}]`, phase);
      this.overlay.style.opacity = '1';
      this.moveTo(projection.x, projection.y);
      const state = {
        mode: 'anchored',
        phase,
        x: projection.x,
        y: projection.y,
        canvas_rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        ndc: projection.ndc,
        radius,
        nodeName,
        offscreen: false,
        trail: options.trail ? { length: options.trail.length, angle: options.trail.angle } : null,
        camera_source: pose.source,
        world_position: target.worldPosition
      };
      this.publish(state);
      // "framed" would overstate this: the light being anchored to the node says where the
      // node is on screen, not that the camera moved to it. Camera motion is reported
      // separately, and only when measured.
      AgentStatusRail.setFocusNote(`${nodeName} · ${phase === 'working' ? 'in progress' : 'on screen'}`);
      return state;
    },

    renderEdgeArrow(nodeName, type, action, target, projection, rect, pose, phase = 'settled') {
      const margin = 26;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      // Clamp the projected direction to the frame border rather than pinning it to a corner.
      const directionX = projection.x - centerX;
      const directionY = projection.y - centerY;
      const magnitude = Math.hypot(directionX, directionY) || 1;
      const limitX = (rect.width / 2) - margin;
      const limitY = (rect.height / 2) - margin;
      const scale = Math.min(limitX / Math.abs(directionX || 1e-6), limitY / Math.abs(directionY || 1e-6));
      const clampedX = centerX + directionX * scale;
      const clampedY = centerY + directionY * scale;
      const angle = Math.atan2(directionY, directionX) * 180 / Math.PI;
      const coordinates = target.worldPosition.map(value => Number(value).toFixed(1)).join(', ');
      const detail = `off-screen · ${projection.distance.toFixed(1)}m · [${coordinates}]`;
      this.overlay.innerHTML =
        `<div style="width:0;height:0;margin-left:-9px;margin-top:-9px;border-left:14px solid var(--gd-accent,#538dda);border-top:9px solid transparent;border-bottom:9px solid transparent;transform:rotate(${angle}deg)"></div>`
        + this.label(nodeName, type, action, detail, phase);
      this.overlay.style.opacity = '1';
      this.moveTo(clampedX, clampedY);
      const state = {
        mode: 'arrow',
        x: clampedX,
        y: clampedY,
        canvas_rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        ndc: projection.ndc,
        angle,
        distance: projection.distance,
        nodeName,
        offscreen: true,
        behind_camera: projection.behind,
        camera_source: pose.source,
        world_position: target.worldPosition
      };
      this.publish(state);
      AgentStatusRail.setFocusNote(`${nodeName} · off-screen ${projection.distance.toFixed(1)}m`);
      return state;
    },

  };

  // ==========================================
  // 8D. Camera guidance channel
  // ==========================================
  // Ported from the reference studio's camera module (test/camera-guidance.js). Its four
  // rules are the reason that implementation feels good and a naive one does not:
  //   1. Yield to the human — any pointer/wheel/key input on the canvas aborts in-flight
  //      guidance and starts a cooldown.
  //   2. Never fight a stale renderer — every request is fenced against the editor-boot
  //      generation, so a request issued before a restart cannot move the camera after it.
  //   3. Coalesce — exactly one pending follow; five rapid spawns produce one camera move.
  //   4. Respect prefers-reduced-motion.
  // Framing itself is transient: it never mutates the scene, advances sceneRevision, creates
  // an undo entry, or survives a project reload.
  const USER_INPUT_COOLDOWN_MILLISECONDS = 750;
  const MAX_GUIDANCE_FRAMES = 8;
  // How long to keep watching for Godot's own camera ease before calling it unmoved.
  const GUIDANCE_SETTLE_MILLISECONDS = 1200;
  // How many pan/dolly corrections to spend before reporting what was actually achieved.
  const GUIDANCE_MAX_ITERATIONS = 8;
  // The share of the frame height the target should end up occupying: big enough to read,
  // small enough to keep its surroundings.
  const GUIDANCE_TARGET_EXTENT = [0.18, 0.62];
  // Godot dolly is multiplicative, one notch per wheel click.
  const GUIDANCE_DOLLY_STEP = 1.08;
  const CAMERA_AUTO_FOLLOW_PREFERENCE_KEY = 'godot-webmcp.auto-follow';
  const AUTO_FOLLOW_DEBOUNCE_MILLISECONDS = 180;

  function nextFrame(timeoutMs = 64) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      // A hidden or backgrounded tab never fires requestAnimationFrame, so guidance must
      // never be able to wait on it forever.
      const timer = setTimeout(done, timeoutMs);
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => { clearTimeout(timer); done(); });
      }
    });
  }

  const CameraGuidance = {
    lastInteractionAt: Number.NEGATIVE_INFINITY,
    pending: null,
    followTimer: null,
    lastGeometrySignature: null,
    lastSkippedFollow: null,
    installed: false,

    autoFollowEnabled() {
      try {
        return sessionStorage?.getItem(CAMERA_AUTO_FOLLOW_PREFERENCE_KEY) !== 'off';
      } catch (_) {
        return true;
      }
    },

    setAutoFollow(enabled) {
      try {
        sessionStorage?.setItem(CAMERA_AUTO_FOLLOW_PREFERENCE_KEY, enabled ? 'on' : 'off');
      } catch (_) {}
      if (enabled) {
        this.lastInteractionAt = Number.NEGATIVE_INFINITY;
      } else {
        this.pending = null;
        if (this.followTimer !== null) clearTimeout(this.followTimer);
        this.followTimer = null;
      }
      CameraControls.render();
      return this.autoFollowEnabled();
    },

    install() {
      if (this.installed || typeof document === 'undefined') return;
      this.installed = true;
      const note = () => { this.lastInteractionAt = Date.now(); this.pending = null; };
      for (const type of ['pointerdown', 'wheel', 'keydown']) {
        document.addEventListener(type, (event) => {
          const target = event.target;
          if (target && (target.id === 'editor-canvas' || target.id === 'game-canvas')) note();
        }, { capture: true, passive: true });
      }
    },

    yieldedToUser(reason = 'user_active') {
      return {
        status: 'yielded',
        reason,
        camera_moved: false,
        target_reached: false,
        transient: true,
        cooldown_remaining_ms: Math.max(0, USER_INPUT_COOLDOWN_MILLISECONDS - (Date.now() - this.lastInteractionAt)),
        scene_revision: DiagnosticState.sceneRevision
      };
    },

    withinCooldown() {
      return Date.now() - this.lastInteractionAt < USER_INPUT_COOLDOWN_MILLISECONDS;
    },

    // Drives Godot's own damped fly-to via selection + `spatial_editor/focus_selection`,
    // then polls the viewport pose to find out whether the camera actually moved.
    //
    // The previous version waited a few frames and then returned `camera_moved: true,
    // target_reached: true` unconditionally, so a camera that never budged still reported
    // success. Dispatching a shortcut is not evidence that Godot acted on it. Three facts are
    // now reported separately: `dispatched` is what we did, `camera_moved` is what we
    // measured, and `target_reached` additionally requires the node to project inside the
    // frame afterwards.
    poseDelta(before, after) {
      if (!before || !after) return Infinity;
      const positionDelta = Math.hypot(
        after.position[0] - before.position[0],
        after.position[1] - before.position[1],
        after.position[2] - before.position[2]);
      const basisDelta = before.basis.reduce((total, value, index) => total + Math.abs(value - after.basis[index]), 0);
      return positionDelta + basisDelta;
    },

    readPose() {
      const reply = EditorCommandChannel.call('camera_pose');
      return reply.ok ? { position: reply.position, basis: reply.basis, fov: reply.fov } : null;
    },

    // Did the framing actually put the node on screen? Answered by projecting it, not assumed.
    targetFramed(node) {
      const surface = resolveGodotCanvas('editor');
      const pose = editorViewportCameraPose();
      if (!surface || !pose || !node?.world_position) return null;
      const rect = surface.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const projection = projectWorldPoint(node.world_position, pose, rect);
      return projection ? projection.onScreen : null;
    },

    async guide({ nodeName, reason = 'explicit' }) {
      this.install();
      if (this.withinCooldown()) return this.yieldedToUser();
      const generation = EditorCommandChannel.generation;
      const node = findSceneNode(activeFilesDict, nodeName);
      if (!node) {
        return { status: 'failed', reason: 'unknown_node', error: `Node '${nodeName}' is not in the active scene.`, transient: true };
      }

      const overlayState = AgentFocusOverlay.focus(node.name, node.world_position, node.type, 'Framing');
      const base = {
        transient: true,
        node_path: node.node_path,
        scene_revision: DiagnosticState.sceneRevision,
        overlay: overlayState
      };

      const before = this.readPose();
      // Prime the viewport's focus first, then select, then dispatch. The order matters twice
      // over: the priming click can change the selection, so it has to come first, and
      // Node3DEditor handles a selection change on a deferred call, so a shortcut sent in the
      // same frame as the selection frames an empty set.
      const selected = EditorCommandChannel.call('select', { node_path: node.node_path });
      if (!selected.ok) {
        return {
          ...base,
          status: 'overlay_only',
          reason: selected.unsupported ? 'command_channel_unavailable' : 'select_rejected',
          error: selected.error,
          dispatched: false,
          camera_moved: false,
          target_reached: false
        };
      }
      await nextFrame();
      await nextFrame();

      // Framing is driven with the mouse, not the F shortcut.
      //
      // Godot handles "frame selection" as a keyboard shortcut, and a browser sends no
      // keyboard input to a document that does not have focus - so agent framing died
      // whenever the human was looking at another window. Neither route into the engine
      // helped: emit_signal("gui_input") never reaches Godot own handling because
      // Control._gui_input is a virtual the engine calls, not a signal handler, and pushing
      // the key into the viewport still needs GUI key focus. Mouse events do not: the
      // viewport routes them by position. Measured, on an unfocused page: orbit, pan and
      // dolly all move the camera; the shortcut does not, by any route.
      //
      // So this is a closed loop in screen space. Pan to bring the node to the middle of the
      // frame, dolly until it fills a comfortable share of it, and read the real camera pose
      // back between steps rather than assuming the move landed.
      const surface = resolveGodotCanvas('editor');
      const rect = surface?.canvas?.getBoundingClientRect?.();
      if (!rect || !rect.width || !rect.height) {
        return { ...base, status: 'overlay_only', reason: 'no_editor_surface', dispatched: false, camera_moved: false, target_reached: false };
      }
      const dispatch = { ok: true, mechanism: 'viewport.mouse_input' };
      const reduced = typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
      const settle = async () => {
        // Godot eases the camera. Measure only once two reads agree, or the loop chases its
        // own inertia and overshoots.
        let previous = this.readPose();
        const until = nowMs() + GUIDANCE_SETTLE_MILLISECONDS;
        for (;;) {
          await nextFrame();
          const current = this.readPose();
          if (!current) return previous;
          if (previous && this.poseDelta(previous, current) <= 0.001) return current;
          previous = current;
          if (nowMs() > until) return current;
        }
      };
      const step = (payload) => EditorCommandChannel.call('viewport_input', payload);

      let framesPresented = 0;
      let moved = false;
      let after = before;
      let iterations = 0;
      // Distinguishes "the target was already framed, so nothing moved" from "the camera was
      // driven and refused to move". Both leave the pose unchanged; only one is a problem.
      let satisfied = false;
      const iterationLimit = reduced ? 1 : GUIDANCE_MAX_ITERATIONS;
      for (; iterations < iterationLimit; iterations += 1) {
        const pose = this.readPose();
        if (!pose) break;
        const projection = projectWorldPoint(node.world_position, { transform: { basis: pose.basis, origin: pose.position }, fov: pose.fov }, rect);
        if (!projection) break;
        // The true projected extent as a fraction of frame height. Not projectedRadius(),
        // which clamps for the overlay and would make the loop chase a floor value.
        const halfExtents = node.aabb?.half_extents;
        const worldRadius = Array.isArray(halfExtents) ? Math.hypot(halfExtents[0], halfExtents[1], halfExtents[2]) : null;
        const extent = worldRadius && projection.depth > 0.001
          ? (worldRadius / projection.depth) / projection.halfFovTangent
          : null;
        const offsetX = projection.x - (rect.left + rect.width / 2);
        const offsetY = projection.y - (rect.top + rect.height / 2);
        const centred = !projection.behind && Math.hypot(offsetX, offsetY) < rect.height * 0.06;
        // A node behind the camera has no usable screen offset; swing round to it first.
        if (projection.behind) {
          step({ kind: 'orbit', dx: rect.width * 0.35, dy: 0, steps: 8 });
        } else if (!centred) {
          // Pan moves the view with the drag, so the correction is the offset itself.
          step({ kind: 'pan', dx: offsetX, dy: offsetY, steps: 8 });
        } else {
          // Centred, and nothing measurable to size against - a light, or an instanced scene
          // whose bounds the scene text does not carry. Centred is the honest stopping point.
          if (extent === null) { after = pose; satisfied = true; moved = moved || this.poseDelta(before, pose) > 0.001; break; }
          if (extent >= GUIDANCE_TARGET_EXTENT[0] && extent <= GUIDANCE_TARGET_EXTENT[1]) {
            moved = moved || this.poseDelta(before, pose) > 0.001;
            after = pose;
            satisfied = true;
            break;
          }
          const desired = (GUIDANCE_TARGET_EXTENT[0] + GUIDANCE_TARGET_EXTENT[1]) / 2;
          const notches = Math.max(-6, Math.min(6, Math.round(Math.log(desired / extent) / Math.log(GUIDANCE_DOLLY_STEP))));
          if (notches === 0) { after = pose; satisfied = true; moved = moved || this.poseDelta(before, pose) > 0.001; break; }
          step({ kind: 'dolly', notches });
        }
        after = await settle();
        framesPresented += 1;
        if (EditorCommandChannel.generation !== generation) {
          return { ...base, status: 'stale', reason: 'editor_restarted', dispatched: true, camera_moved: moved, target_reached: false, frames_presented: framesPresented };
        }
        if (this.withinCooldown()) return this.yieldedToUser();
        AgentFocusOverlay.focus(node.name, node.world_position, node.type, 'Framing');
        if (this.poseDelta(before, after) > 0.001) moved = true;
      }
      const framed = (moved || satisfied) ? this.targetFramed(findSceneNode(activeFilesDict, nodeName)) : null;
      if (!moved && !satisfied) {
        // The shortcut went out and the editor did not move the camera. Say exactly that.
        return {
          ...base,
          status: 'dispatched_unconfirmed',
          reason: 'camera_pose_unchanged',
          mechanism: dispatch.mechanism,
          dispatched: true,
          camera_moved: false,
          target_reached: false,
          frames_presented: framesPresented,
          iterations,
          note: 'The camera was driven and its pose did not change. Godot only advances the viewport while the editor is rendering, so a hidden or throttled tab reports this. The node is selected and the overlay is placed.'
        };
      }
      return {
        ...base,
        status: 'framed',
        reason,
        mechanism: dispatch.mechanism,
        dispatched: true,
        camera_moved: moved,
        // The loop stopped because the target already sits where it should. Said out loud,
        // because "framed" with camera_moved false otherwise reads as a contradiction.
        already_framed: satisfied && !moved,
        iterations,
        // null when the projection could not be evaluated — never silently true.
        target_reached: framed === true,
        target_framing_verified: framed !== null,
        frames_presented: framesPresented
      };
    },

    // One pending follow at a time, coalesced over a real time window. A microtask was too
    // narrow: agents call tools sequentially with an await between each, so every spawn in a
    // burst landed in its own microtask and got its own camera move. A newer target simply
    // replaces the pending one.
    queueFollow(nodeName, reason = 'geometry_change') {
      if (!this.autoFollowEnabled()) return;
      this.pending = { nodeName, reason };
      if (this.followTimer !== null) clearTimeout(this.followTimer);
      this.followTimer = setTimeout(async () => {
        this.followTimer = null;
        const request = this.pending;
        this.pending = null;
        if (!request || !this.autoFollowEnabled()) return;
        try {
          await this.guide(request);
        } catch (_) {
          // Auto-follow is best-effort; it must never fail an accepted scene mutation.
        }
      }, AUTO_FOLLOW_DEBOUNCE_MILLISECONDS);
    },

    // Geometry only. A material tweak must not yank the camera.
    geometrySignature(filesDict = activeFilesDict) {
      const graph = sceneGraphFromFiles(filesDict);
      return JSON.stringify(graph.nodes
        .filter(node => node.mesh || node.local_transform)
        .map(node => [node.node_path, node.world_position, node.mesh?.type || null, node.aabb?.half_extents || null]));
    },

    noteSceneChanged(nodeName) {
      const signature = this.geometrySignature();
      const changed = signature !== this.lastGeometrySignature;
      this.lastGeometrySignature = signature;
      if (!changed || !nodeName) return changed;
      // Hold still when the work is already comfortably in frame. This is the difference
      // between a camera that follows the work and one that twitches at every edit.
      const comfort = this.comfortOf(nodeName);
      if (comfort.comfortable) {
        this.lastSkippedFollow = { node: nodeName, at: Date.now() };
        return changed;
      }
      this.lastSkippedFollow = null;
      this.queueFollow(nodeName);
      return changed;
    },

    // The measured version of the pure policy: project the node through the real camera and
    // ask whether it is comfortably framed. Anything it cannot measure is not comfortable,
    // so an unknown state moves the camera rather than silently leaving the work off-screen.
    comfortOf(nodeName) {
      const surface = resolveGodotCanvas('editor');
      const pose = editorViewportCameraPose();
      const node = findSceneNode(activeFilesDict, nodeName);
      if (!surface || !pose || !node?.world_position) return { comfortable: false, reason: 'unmeasurable' };
      const rect = surface.canvas.getBoundingClientRect();
      const projection = projectWorldPoint(node.world_position, pose, rect);
      if (!projection) return { comfortable: false, reason: 'projection_failed' };
      return framingComfort(projection, projectedRadius(node.aabb?.half_extents || [0.5, 0.5, 0.5], projection, rect), rect);
    }
  };

  // ==========================================
  // 8E. Agent surfaces — one bottom rail, three controls
  // ==========================================
  // Godot owns all four screen corners with its own docks. The agent layer previously put
  // five fixed overlays into three of those corners plus the centre, in four different
  // greens and four different reds. It is now a single bottom rail: camera controls left,
  // status strip centre, scene inspector right. Everything is pointer-events:none except
  // the three interactive controls, so the Godot canvas stops losing clicks.
  const RAIL_TOKENS = {
    surface: 'var(--gd-surface, #141414)',
    panel: 'var(--gd-panel, #1b1b1b)',
    raised: 'var(--gd-panel-raised, #262626)',
    border: 'var(--gd-border, #484848)',
    text: 'var(--gd-text, #d0d0d0)',
    muted: 'var(--gd-text-muted, #9a9a9a)',
    accent: 'var(--gd-accent, #538dda)',
    ok: 'var(--gd-ok, #6a9955)',
    warn: 'var(--gd-warn, #d7a355)',
    error: 'var(--gd-error, #d16969)',
    running: 'var(--gd-running, #5c9fd6)',
    ui: 'var(--gd-font-ui, Inter, system-ui, sans-serif)',
    mono: 'var(--gd-font-mono, ui-monospace, SFMono-Regular, monospace)'
  };

  const PANEL_STYLE = `border:1px solid ${RAIL_TOKENS.border};border-radius:6px;background:${RAIL_TOKENS.panel};box-shadow:0 8px 24px rgba(0,0,0,.45);color:${RAIL_TOKENS.text};pointer-events:auto`;
  const BUTTON_STYLE = `appearance:none;border:1px solid ${RAIL_TOKENS.border};border-radius:4px;background:${RAIL_TOKENS.raised};color:${RAIL_TOKENS.text};font:500 12px/1 ${RAIL_TOKENS.ui};padding:5px 9px;cursor:pointer`;

  function statusColor(status) {
    if (status === 'succeeded' || status === 'ready') return RAIL_TOKENS.ok;
    if (status === 'failed') return RAIL_TOKENS.error;
    if (status === 'pending') return RAIL_TOKENS.warn;
    return RAIL_TOKENS.running;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  // Three content-driven desktop modes, chosen from the CONTAINER's width rather than the
  // window's. A Codex or browser split pane makes the window wide and the shelf narrow, and
  // sizing off `window.innerWidth` is exactly how three side-by-side panels ended up
  // overlapping each other and Godot's docks in a 493px pane.
  //
  //   wide  — camera controls, activity, and scene details as three columns
  //   split — one compact activity row with Follow and View; the rest moves into the drawer
  //   narrow— readiness dots, an abbreviated action, and Follow stay visible; everything
  //           else moves into a full-width details drawer
  const RAIL_WIDE_BREAKPOINT = 1100;
  const RAIL_SPLIT_BREAKPOINT = 720;

  function railContainerWidth() {
    if (typeof window === 'undefined') return RAIL_WIDE_BREAKPOINT;
    const measured = AgentRail.root?.clientWidth || 0;
    return measured > 0 ? measured : window.innerWidth;
  }

  function railMode() {
    const width = railContainerWidth();
    if (width >= RAIL_WIDE_BREAKPOINT) return 'wide';
    if (width >= RAIL_SPLIT_BREAKPOINT) return 'split';
    return 'narrow';
  }

  // Retained name and meaning: "fold the secondary panels into the status strip".
  function isNarrowRail() {
    return railMode() !== 'wide';
  }

  function prefersReducedMotion() {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // A truthful, atomic summary of what just changed — never simulated typing, and never a
  // claim the edit is still in progress once Godot has acknowledged it.
  function activityChipMarkup(entry) {
    const target = entry?.target;
    if (!target?.resource_path) return '';
    const file = String(target.resource_path).replace(/^res:\/\//, '');
    const change = entry.change || null;
    const lines = change?.start_line
      ? ` · ${change.start_line === change.end_line ? `line ${change.start_line}` : `lines ${change.start_line}\u2013${change.end_line}`}`
      : '';
    const counts = change && (change.added || change.removed) ? ` · +${change.added} \u2212${change.removed}` : '';
    const pulse = entry.status === 'running' && !prefersReducedMotion() ? 'animation:webmcp-chip-pulse 1.4s ease-in-out infinite;' : '';
    // Not shrinkable: it is short, and half of "+3 -0" is worse than none of the label's
    // tail, which already truncates with an ellipsis.
    return `<span data-activity-chip style="display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;`
      + `border:1px solid ${statusColor(entry.status)};border-radius:999px;padding:2px 9px;${pulse}`
      + `color:${RAIL_TOKENS.text};font:500 11px/1.5 ${RAIL_TOKENS.mono};white-space:nowrap">`
      + `${escapeHtml(file)}${escapeHtml(lines)}${escapeHtml(counts)}</span>`;
  }

  // Presence, stated once, in the same place, always. "Agent attached · SkyrailDeck · 12
  // changes" is a different claim from "here is the last thing that happened", and the rail
  // was only ever making the second one.
  function presenceMarkup(mode) {
    const presence = AgentPresence.describe();
    if (presence.state === 'detached') return '';
    const working = presence.state === 'working';
    const tint = working ? RAIL_TOKENS.accent : RAIL_TOKENS.muted;
    const target = presence.target ? String(presence.target).split('/').pop() : null;
    const pieces = [working ? 'Working' : 'Attached'];
    if (target && mode !== 'narrow') pieces.push(target);
    if (presence.completed > 0 && mode === 'wide') {
      pieces.push(`${presence.completed} change${presence.completed === 1 ? '' : 's'}`);
    }
    const pulse = working && !prefersReducedMotion() ? 'animation:webmcp-chip-pulse 1.4s ease-in-out infinite;' : '';
    return `<span data-agent-presence style="display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;${pulse}`
      + `border:1px solid ${tint};border-radius:999px;padding:2px 9px;color:${RAIL_TOKENS.text};`
      + `font:500 11px/1.5 ${RAIL_TOKENS.mono};white-space:nowrap">`
      + `<span aria-hidden="true" style="width:5px;height:5px;border-radius:50%;background:${tint}"></span>`
      + `${escapeHtml(pieces.join(' \u00b7 '))}</span>`;
  }

  // Three states, not two, because "follow me into the code" is a different request from
  // "tell me which file changed" and the second is what most edits actually want.
  function followButtonMarkup() {
    const state = FollowAgent.describe();
    const tint = state.enabled ? RAIL_TOKENS.accent : RAIL_TOKENS.muted;
    const label = state.paused
      ? 'Follow (paused)'
      : !state.enabled
        ? 'Follow off'
        : state.mode === 'script' ? 'Follow \u00b7 code' : 'Follow \u00b7 file';
    const title = !state.enabled
      ? 'Off: the workspace never changes. Click to follow which file the agent edits.'
      : state.mode === 'file'
        ? 'The edited script is revealed in the FileSystem dock and your workspace is left alone. Click to also open the code.'
        : 'The Script workspace opens at each change. Touching the editor pauses this. Click to turn following off.';
    return `<button type="button" data-follow-agent="1" aria-pressed="${state.enabled}" `
      + `title="${title}" `
      + `style="${BUTTON_STYLE};min-height:28px;border-color:${tint};color:${tint}">`
      + `<span aria-hidden="true" style="display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;background:${tint}"></span>${label}</button>`;
  }

  function ensureRailKeyframes() {
    if (typeof document === 'undefined' || document.getElementById('webmcp-rail-keyframes')) return;
    const style = document.createElement('style');
    style.id = 'webmcp-rail-keyframes';
    style.textContent = '@keyframes webmcp-chip-pulse{0%,100%{opacity:1}50%{opacity:.55}}'
      + '@media (prefers-reduced-motion: reduce){[data-activity-chip]{animation:none !important}}';
    document.head.appendChild(style);
  }

  function cameraControlsMarkup() {
    const following = CameraGuidance.autoFollowEnabled();
    const available = EditorCommandChannel.available();
    const current = String(CameraControls.currentView || '').toLowerCase();
    return `<button type="button" data-follow="1" aria-pressed="${following}" style="${BUTTON_STYLE};border-color:${following ? RAIL_TOKENS.accent : RAIL_TOKENS.border};color:${following ? RAIL_TOKENS.accent : RAIL_TOKENS.muted}">`
      + `<span aria-hidden="true" style="display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;background:${following ? RAIL_TOKENS.accent : RAIL_TOKENS.muted}"></span>Auto follow</button>`
      + `<span aria-hidden="true" style="width:1px;height:18px;background:${RAIL_TOKENS.border}"></span>`
      + ['perspective', 'front', 'top'].map(preset => {
        const active = current === preset;
        return `<button type="button" data-preset="${preset}" ${available ? '' : 'disabled'} aria-pressed="${active}" title="${available ? `Switch the 3D viewport to the ${preset} view` : 'Requires the editor command plugin'}" style="${BUTTON_STYLE};text-transform:capitalize;${active ? `border-color:${RAIL_TOKENS.accent};color:${RAIL_TOKENS.accent};` : ''}${available ? '' : `opacity:.45;cursor:not-allowed;color:${RAIL_TOKENS.muted}`}">${preset}</button>`;
      }).join('');
  }

  function wireCameraControls(root) {
    if (!root) return;
    const follow = root.querySelector('[data-follow]');
    if (follow) {
      follow.onclick = (event) => {
        event.stopPropagation();
        CameraGuidance.setAutoFollow(!CameraGuidance.autoFollowEnabled());
        AgentStatusRail.render();
      };
    }
    for (const button of root.querySelectorAll('[data-preset]')) {
      button.onclick = (event) => {
        event.stopPropagation();
        CameraControls.applyPreset(button.dataset.preset);
      };
    }
  }

  function sceneRowsMarkup(limit = 40) {
    const graph = sceneGraphFromFiles(activeFilesDict);
    const rows = graph.nodes.slice(0, limit).map(node => {
      const position = Array.isArray(node.world_position)
        ? node.world_position.map(value => Number(value).toFixed(1)).join(', ')
        : '—';
      return `<div style="display:grid;grid-template-columns:1fr auto;gap:8px;padding:2px 0;border-top:1px solid ${RAIL_TOKENS.border}">`
        + `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${escapeHtml(node.name)} <span style="color:${RAIL_TOKENS.muted}">${escapeHtml(node.type)}</span></span>`
        + `<span style="color:${RAIL_TOKENS.muted};font:400 11px/1.5 ${RAIL_TOKENS.mono}">${escapeHtml(position)}</span></div>`;
    }).join('');
    const overflow = graph.nodes.length > limit
      ? `<div style="padding-top:3px;color:${RAIL_TOKENS.muted}">+${graph.nodes.length - limit} more</div>` : '';
    return { rows, overflow, count: graph.nodes.length };
  }

  const AgentRail = {
    root: null,
    resizeBound: false,
    lastShelfHeight: -1,
    observer: null,

    ensure() {
      if (typeof document === 'undefined' || !document.body) return false;
      if (this.root && document.body.contains(this.root)) return true;
      this.root = document.createElement('div');
      this.root.id = 'webmcp-agent-rail';
      this.root.style.cssText = `position:fixed;left:0;right:0;bottom:0;z-index:var(--gd-z-rail, 900);display:flex;align-items:flex-end;gap:8px;padding:8px 10px;pointer-events:none;font:500 12px/1.35 ${RAIL_TOKENS.ui}`;
      document.body.appendChild(this.root);
      ensureRailKeyframes();
      if (!this.resizeBound && typeof window !== 'undefined') {
        this.resizeBound = true;
        window.addEventListener('resize', () => {
          this.applyLayout();
          AgentStatusRail.render();
        });
        // A split pane changes the shelf's width without changing the window's, so
        // `resize` alone never fires and the layout stayed in its wide, overlapping form.
        // The container's own box is the thing the layout depends on, so observe that.
        if (typeof ResizeObserver === 'function') {
          this.observer = new ResizeObserver(() => {
            this.applyLayout();
            AgentStatusRail.render();
          });
          this.observer.observe(this.root);
        }
      }
      this.applyLayout();
      return true;
    },

    applyLayout() {
      if (!this.root) return;
      const mode = railMode();
      const narrow = mode !== 'wide';
      // The camera presets and scene inspector are editor-only affordances, and the playtest
      // canvas is full-bleed: during a playtest the rail shrinks to the status strip alone so
      // it reserves as little of the game surface as possible.
      const playtesting = activeGodotViewport() === 'game';
      for (const [id, secondary] of [['webmcp-camera-slot', true], ['webmcp-status-slot', false], ['webmcp-inspector-slot', true]]) {
        const slot = document.getElementById(id);
        if (slot) slot.style.display = secondary && (narrow || playtesting) ? 'none' : 'flex';
      }
      this.root.style.padding = playtesting ? '4px 10px' : '8px 10px';
      const strip = document.getElementById('webmcp-agent-status-strip');
      if (strip) {
        // In split and narrow modes the activity row owns the full width; only the wide,
        // three-column layout constrains it, and even there it must not exceed the container.
        strip.style.maxWidth = '100%';
        strip.style.width = '100%';
        strip.style.opacity = playtesting ? '0.82' : '1';
      }
      this.publishShelfHeight();
    },

    // The shelf is reserved space, not an overlay: its measured height is published so
    // index.html can shrink the editor canvas to fit above it. Expansion therefore RESIZES
    // the viewport rather than covering Godot's own controls, and collapsing gives the
    // pixels back on the next frame.
    publishShelfHeight() {
      if (!this.root || typeof window === 'undefined') return;
      const cap = Math.round((window.innerHeight || 0) * 0.35);
      const measured = Math.min(this.root.offsetHeight || 0, cap);
      if (measured === this.lastShelfHeight) return;
      this.lastShelfHeight = measured;
      window.__webmcpShelfHeight = measured;
      document.documentElement.style.setProperty('--webmcp-shelf-height', `${measured}px`);
    },

    slot(id, alignment) {
      if (!this.ensure()) return null;
      let element = document.getElementById(id);
      if (!element) {
        element = document.createElement('div');
        element.id = id;
        // The activity column is the one that carries variable-length text, so it gets the
        // flexible space and the two content-sized side panels do not. Three equal columns
        // crushed the label to "Gi..." while the camera row sat half empty.
        const grow = id === 'webmcp-status-slot' ? '1 1 0' : '0 0 auto';
        element.style.cssText = `display:flex;justify-content:${alignment};min-width:0;flex:${grow};pointer-events:none`;
        this.root.appendChild(element);
      }
      return element;
    }
  };

  const CameraControls = {
    // What the viewport last told us it is showing, so the control can reflect state instead
    // of only offering actions.
    currentView: null,
    node: null,

    ensure() {
      const slot = AgentRail.slot('webmcp-camera-slot', 'flex-start');
      if (!slot) return false;
      if (!this.node) {
        this.node = document.createElement('div');
        this.node.id = 'webmcp-camera-controls';
        this.node.style.cssText = `${PANEL_STYLE};display:flex;align-items:center;gap:6px;padding:6px 8px`;
        this.node.setAttribute('aria-label', 'Agent camera controls');
        slot.appendChild(this.node);
        this.render();
      }
      return true;
    },

    async applyPreset(preset) {
      // Presets are transient viewport moves; they never touch the scene.
      //
      // `ok` only says the command was accepted. Whether the view actually changed is read
      // back from the viewport's own label, because the version this replaced returned ok on
      // every call while the camera never moved.
      const reply = EditorCommandChannel.call('view_preset', { preset });
      if (!reply.ok) {
        AgentStatusRail.setFocusNote(reply.unsupported
          ? 'Camera presets need the editor command plugin'
          : `Camera preset failed: ${reply.error}`);
      } else if (reply.applied === false) {
        AgentStatusRail.setFocusNote(`The viewport stayed on ${reply.label_after || 'its current view'}`);
      } else {
        this.currentView = reply.label_after || null;
        AgentStatusRail.setFocusNote('');
      }
      this.render();
      return reply;
    },

    render() {
      if (!this.node) return;
      this.node.innerHTML = cameraControlsMarkup();
      wireCameraControls(this.node);
    }
  };

  const AgentStatusRail = {
    node: null,
    expanded: false,
    focusNote: '',

    ensure() {
      const slot = AgentRail.slot('webmcp-status-slot', 'center');
      if (!slot) return false;
      if (!this.node) {
        this.node = document.createElement('div');
        this.node.id = 'webmcp-agent-status-strip';
        this.node.style.cssText = `${PANEL_STYLE};max-width:min(620px, calc(100vw - 32px));min-width:0;padding:6px 10px;cursor:pointer`;
        this.node.tabIndex = 0;
        this.node.setAttribute('role', 'status');
        this.node.setAttribute('aria-live', 'polite');
        this.node.setAttribute('aria-label', 'Agent activity. Enter or Space toggles the operation timeline.');
        const toggle = () => { this.expanded = !this.expanded; this.render(); };
        this.node.addEventListener('click', toggle);
        this.node.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
        });
        slot.appendChild(this.node);
      }
      return true;
    },

    setFocusNote(text) {
      this.focusNote = text || '';
      this.render();
    },

    // The old DiagnosticHUD was a separate widget 2px from the feed. It is now a three-dot
    // readiness cluster inside the strip.
    readinessDots() {
      const engine = DiagnosticState.engine === 'ready' ? RAIL_TOKENS.ok : DiagnosticState.engine === 'loading' ? RAIL_TOKENS.warn : RAIL_TOKENS.error;
      const webmcp = DiagnosticState.webmcp === 'ready' ? RAIL_TOKENS.ok : DiagnosticState.webmcp === 'unsupported' ? RAIL_TOKENS.muted : RAIL_TOKENS.error;
      const session = DiagnosticState.session === 'playtesting' ? RAIL_TOKENS.running : DiagnosticState.session === 'restore_failed' || DiagnosticState.session === 'failed' ? RAIL_TOKENS.error : RAIL_TOKENS.ok;
      const dot = (color, label) => `<span title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color}"></span>`;
      return `<span style="display:inline-flex;align-items:center;gap:4px;flex:0 0 auto">`
        + dot(engine, `Engine: ${DiagnosticState.engine}`)
        + dot(webmcp, `WebMCP: ${DiagnosticState.webmcpRegisteredCount} tools (${DiagnosticState.webmcp})`)
        + dot(session, `Session: ${DiagnosticState.session}`)
        + `</span>`;
    },

    // A one-shot navigation that does NOT turn persistent following on. Someone who wants to
    // look at one change should not have to accept the agent moving their workspace forever.
    viewChange(entryId) {
      const entry = AgentObservationHUD.entries.find(item => item.id === Number(entryId));
      const path = entry?.target?.resource_path;
      if (!path) return;
      // Opening the script inside Godot is invisible while the host is still covering the
      // editor with the playtest canvas. "View change" is an explicit navigation request, so
      // return to the editor surface first; keep the runtime alive in the background so the
      // user can go straight back to Live Preview afterwards.
      if (activeGodotViewport() === 'game' && typeof window.showTab === 'function') {
        window.showTab('editor');
      }
      const reply = EditorCommandChannel.call('script_open', { path, line: entry.change?.start_line || 1 });
      if (!reply.ok) {
        this.setFocusNote(reply.unsupported ? 'Opening a script needs the editor command plugin' : `Could not open ${path}: ${reply.error}`);
      } else {
        this.setFocusNote(`Viewing ${path.replace(/^res:\/\//, '')}`);
      }
    },

    render() {
      if (!this.ensure()) return;
      const mode = railMode();
      const entries = AgentObservationHUD.entries;
      const latest = entries[entries.length - 1] || null;
      const elapsed = latest ? ((latest.completedAt || Date.now()) - latest.startedAt) / 1000 : 0;
      const color = latest ? statusColor(latest.status) : RAIL_TOKENS.muted;
      // Plain-language intent first. The tool name and its arguments are evidence, and
      // evidence belongs in the expanded details, not in the headline a non-technical
      // collaborator reads while the agent is working.
      const label = activityHeadline(latest);
      const abbreviated = label;
      const detail = mode === 'narrow' ? '' : (latest?.detail ? ` \u00b7 ${latest.detail}` : '');
      const note = this.focusNote ? ` \u00b7 ${this.focusNote}` : '';
      const chip = mode === 'narrow' ? '' : activityChipMarkup(latest);
      const canView = Boolean(latest?.target?.resource_path);
      const actions = `<span style="display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;margin-left:auto">`
        + (canView && mode !== 'narrow'
          ? `<button type="button" data-view-change="${latest.id}" style="${BUTTON_STYLE};min-height:28px;padding:4px 8px">View change</button>` : '')
        + `<button type="button" data-project-library style="${BUTTON_STYLE};min-height:28px;padding:4px 8px">Projects</button>`
        + followButtonMarkup()
        + `</span>`;
      // An unavoidable restart that is simply not being given frames is a "waiting on you",
      // not a hang and not a failure. Said plainly, and never in colour alone.
      const foreground = DiagnosticState.shutdownWaiting
        ? `<div style="display:flex;align-items:center;gap:6px;margin-top:5px;padding:4px 7px;border-radius:4px;background:${RAIL_TOKENS.raised};color:${RAIL_TOKENS.warn};font:500 11px/1.4 ${RAIL_TOKENS.ui}">`
          + `<span aria-hidden="true">\u25cf</span><span>Keep this editor visible to finish the update</span></div>`
        : '';
      const head = `<div style="display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap">`
        + this.readinessDots()
        + presenceMarkup(mode)
        + `<span style="width:6px;height:6px;border-radius:50%;background:${color};flex:0 0 auto"></span>`
        + `<span style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis">${escapeHtml(abbreviated)}${escapeHtml(detail)}${escapeHtml(note)}</span>`
        + chip
        + (mode === 'wide' ? `<span style="flex:0 0 auto;color:${RAIL_TOKENS.muted};font:400 11px/1 ${RAIL_TOKENS.mono}">${latest ? `${elapsed.toFixed(1)}s \u00b7 ` : ''}Rev #${DiagnosticState.sceneRevision}</span>` : '')
        + actions
        + `<span aria-hidden="true" style="flex:0 0 auto;color:${RAIL_TOKENS.muted}">${this.expanded ? '\u2304' : '\u2303'}</span>`
        + `</div>${foreground}`;
      if (!this.expanded) {
        this.node.innerHTML = head;
        this.wireActions();
        AgentRail.publishShelfHeight();
        return;
      }
      const timeline = (latest?.timeline || []).slice(-7).map(event =>
        `<div style="display:flex;gap:8px;color:${RAIL_TOKENS.muted};font:400 11px/1.5 ${RAIL_TOKENS.mono}">`
        + `<span style="color:${event.phase === latest.phase ? RAIL_TOKENS.accent : RAIL_TOKENS.muted}">${event.phase === latest.phase ? '\u25cf' : '\u00b7'}</span>`
        + `<span style="color:${RAIL_TOKENS.text}">${escapeHtml(event.label)}</span>`
        + `<span style="margin-left:auto">${(event.elapsed_ms / 1000).toFixed(1)}s</span></div>`).join('');
      // Compiler output belongs here, in full, under a plain-language summary — not folded
      // into a status word.
      const diagnostics = (latest?.diagnostics || []).map(diagnostic =>
        `<div style="display:flex;gap:8px;padding:2px 0;color:${RAIL_TOKENS.error};font:400 11px/1.5 ${RAIL_TOKENS.mono}">`
        + `<span style="flex:0 0 auto">${escapeHtml(String(diagnostic.path).replace(/^res:\/\//, ''))}${diagnostic.line ? `:${diagnostic.line}` : ''}</span>`
        + `<span style="min-width:0;color:${RAIL_TOKENS.text}">${escapeHtml(diagnostic.message)}</span></div>`).join('');
      const rows = entries.slice(-5).reverse().map(entry =>
        `<div style="display:grid;grid-template-columns:64px 1fr auto;gap:8px;padding:3px 0;border-top:1px solid ${RAIL_TOKENS.border}">`
        + `<span style="color:${statusColor(entry.status)};text-transform:uppercase;font:500 10px/1.6 ${RAIL_TOKENS.ui}">${escapeHtml(entry.status)}</span>`
        + `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${escapeHtml(entry.label)}${entry.detail ? ` <span style="color:${RAIL_TOKENS.muted}">${escapeHtml(entry.detail)}</span>` : ''}</span>`
        + (entry.target?.resource_path
          ? `<button type="button" data-view-change="${entry.id}" style="${BUTTON_STYLE};padding:2px 7px;font-size:11px">View change</button>`
          : '<span></span>')
        + `</div>`).join('');
      const folded = mode !== 'wide'
        ? `<div data-folded-camera style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;padding-top:6px;border-top:1px solid ${RAIL_TOKENS.border}">${cameraControlsMarkup()}</div>`
          + (() => {
            const scene = sceneRowsMarkup(12);
            return `<div style="margin-top:6px;padding-top:6px;border-top:1px solid ${RAIL_TOKENS.border}">`
              + `<div style="display:flex;gap:8px;color:${RAIL_TOKENS.muted};text-transform:uppercase;letter-spacing:.06em;font-size:10px"><span>Scene details</span><span style="margin-left:auto">${scene.count} nodes</span></div>`
              + `${scene.rows}${scene.overflow}</div>`;
          })()
        : '';
      // Capped so the drawer can never take more than the reserved shelf's share of the page.
      this.node.innerHTML = `${head}<div style="margin-top:6px;max-height:min(28vh,220px);overflow-y:auto">${timeline}${diagnostics}${rows}${folded}</div>`;
      if (mode !== 'wide') wireCameraControls(this.node.querySelector('[data-folded-camera]'));
      this.wireActions();
      AgentRail.publishShelfHeight();
    },

    wireActions() {
      const projects = this.node.querySelector('[data-project-library]');
      if (projects) {
        projects.onclick = (event) => {
          event.stopPropagation();
          ProjectLibraryPopover.toggle();
        };
      }
      const follow = this.node.querySelector('[data-follow-agent]');
      if (follow) {
        follow.onclick = (event) => {
          event.stopPropagation();
          // off -> file -> code -> off
          if (!FollowAgent.enabled) { FollowAgent.set(true); FollowAgent.setMode('file'); }
          else if (FollowAgent.mode === 'file') FollowAgent.setMode('script');
          else FollowAgent.set(false);
          this.render();
        };
        follow.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); };
      }
      for (const button of this.node.querySelectorAll('[data-view-change]')) {
        button.onclick = (event) => {
          event.stopPropagation();
          this.viewChange(button.dataset.viewChange);
        };
        button.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); };
      }
    }
  };

  const ProjectLibraryPopover = {
    node: null,
    visible: false,

    ensure() {
      if (this.node || typeof document === 'undefined') return this.node;
      this.node = document.createElement('section');
      this.node.id = 'webmcp-project-library';
      this.node.setAttribute('aria-label', 'Saved projects');
      this.node.style.cssText = `${PANEL_STYLE};position:fixed;right:10px;bottom:calc(var(--webmcp-shelf-height, 52px) + 8px);z-index:calc(var(--gd-z-rail, 900) + 2);width:min(360px,calc(100vw - 20px));max-height:min(58vh,420px);overflow:auto;padding:10px;pointer-events:auto;display:none`;
      document.body.appendChild(this.node);
      return this.node;
    },

    async toggle() {
      const node = this.ensure();
      if (!node) return;
      this.visible = !this.visible;
      node.style.display = this.visible ? 'block' : 'none';
      if (this.visible) await this.render();
    },

    // Every popover action goes through the observed tool path, so a click and an agent call
    // are the same event with the same rail entry and the same failure reporting.
    async run(toolName, args, failureLabel) {
      const tool = MANIFEST_TOOLS.find(item => item.definition.name === toolName);
      if (!tool) return;
      try {
        const result = await executeObservedTool(tool, args);
        // Creating or opening a project is a managed operation: it returns `pending` and
        // finishes minutes later. Re-rendering on that first reply showed the list as it was
        // BEFORE the work, which read as "nothing happened" and needed a manual Refresh.
        if (result?.operation_id && result.status === 'pending') {
          await this.awaitOperation(result.operation_id);
        }
      } catch (error) {
        AgentStatusRail.setFocusNote(`${failureLabel}: ${error.message || error}`);
      }
      EditorTruth.refresh();
      await this.render();
    },

    // Bounded on active time for the same reason every other editor wait is: a project
    // replacement needs frames, and a hidden pane gives almost none.
    async awaitOperation(operationId, budgetMs = 120000) {
      const settled = await awaitWithActiveBudget(() => {
        const operation = managedOperations.get(operationId);
        return !operation || operation.terminal === true
          || operation.status === 'succeeded' || operation.status === 'failed';
      }, budgetMs, null, 250);
      return settled.ok;
    },

    async render() {
      const node = this.ensure();
      if (!node) return;
      node.innerHTML = `<div style="color:${RAIL_TOKENS.muted};font:400 11px/1.5 ${RAIL_TOKENS.ui}">Loading projects…</div>`;
      let projects = [];
      try { projects = await listSavedProjects(); }
      catch (error) {
        node.innerHTML = `<div style="color:${RAIL_TOKENS.error}">${escapeHtml(error.message || String(error))}</div>`;
        return;
      }
      const rows = projects.map(project => {
        const active = project.project_name === DiagnosticState.activeProject;
        return `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:8px 0;border-top:1px solid ${RAIL_TOKENS.border}">`
          + `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:600">${escapeHtml(project.project_name)}</span>`
          + `<span style="color:${RAIL_TOKENS.muted};font:400 10px/1 ${RAIL_TOKENS.mono}">Rev #${project.scene_revision}</span>`
          + (active
            ? `<span style="color:${RAIL_TOKENS.ok};font:500 10px/1 ${RAIL_TOKENS.ui}">CURRENT</span>`
            : `<button type="button" data-library-open="${escapeHtml(project.project_name)}" style="${BUTTON_STYLE};padding:4px 8px">Open</button>`)
          + `<span style="grid-column:1 / -1;color:${RAIL_TOKENS.muted};font:400 10px/1.3 ${RAIL_TOKENS.mono}">${escapeHtml(project.main_scene)} · ${project.file_count} files</span>`
          + `</div>`;
      }).join('');
      // A project Godot has open that the library has never heard of. Creating one through
      // Godot's own project manager used to leave it invisible here forever: not listed, not
      // reopenable, not persisted. Offering to adopt it is the bridge between the two.
      const truth = EditorTruth.describe();
      const known = new Set(projects.map(project => normalizeProjectIdentity(project.project_name)));
      const orphan = truth.known && truth.editor_project && !known.has(normalizeProjectIdentity(truth.editor_project))
        ? truth.editor_project
        : null;
      const orphanRow = orphan
        ? `<div style="display:flex;align-items:center;gap:8px;padding:8px;margin-bottom:6px;border:1px solid ${RAIL_TOKENS.warn};border-radius:6px">`
          + `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis"><strong>${escapeHtml(orphan)}</strong>`
          + `<span style="display:block;color:${RAIL_TOKENS.muted};font:400 10px/1.4 ${RAIL_TOKENS.mono}">open in Godot, not in this library</span></span>`
          + `<button type="button" data-library-adopt style="${BUTTON_STYLE};margin-left:auto;padding:4px 8px;border-color:${RAIL_TOKENS.warn};color:${RAIL_TOKENS.warn}">Add</button></div>`
        : '';
      const createRow = `<form data-library-create style="display:flex;gap:6px;align-items:center;padding:8px 0;border-top:1px solid ${RAIL_TOKENS.border}">`
        + `<input type="text" name="project" placeholder="New project name" aria-label="New project name" style="flex:1 1 auto;min-width:0;appearance:none;border:1px solid ${RAIL_TOKENS.border};border-radius:4px;background:${RAIL_TOKENS.raised};color:${RAIL_TOKENS.text};font:400 12px/1.4 ${RAIL_TOKENS.ui};padding:5px 8px">`
        + `<select name="template" aria-label="Template" style="appearance:none;border:1px solid ${RAIL_TOKENS.border};border-radius:4px;background:${RAIL_TOKENS.raised};color:${RAIL_TOKENS.text};font:400 12px/1.4 ${RAIL_TOKENS.ui};padding:5px 6px">`
        + `<option value="3d">3D</option><option value="2d">2D</option><option value="empty">Empty</option></select>`
        + `<button type="submit" style="${BUTTON_STYLE};padding:5px 9px;border-color:${RAIL_TOKENS.accent};color:${RAIL_TOKENS.accent}">Create</button></form>`;
      node.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">`
        + `<strong style="font:600 12px/1.3 ${RAIL_TOKENS.ui}">Projects</strong>`
        + `<span style="color:${RAIL_TOKENS.muted};font:400 10px/1 ${RAIL_TOKENS.mono}">${projects.length}/${SAVED_PROJECT_LIMIT}</span>`
        + `<button type="button" data-library-refresh style="${BUTTON_STYLE};margin-left:auto;padding:3px 7px">Refresh</button>`
        + `<button type="button" data-library-close aria-label="Close projects" style="${BUTTON_STYLE};padding:3px 7px">×</button></div>`
        + orphanRow
        + (rows || `<div style="color:${RAIL_TOKENS.muted};font:400 11px/1.5 ${RAIL_TOKENS.ui}">No saved projects yet.</div>`)
        + createRow;
      node.querySelector('[data-library-close]').onclick = () => this.toggle();
      // Refresh re-asks the editor as well as the store, because the reason a project is
      // missing is usually that the editor knows something the store does not.
      node.querySelector('[data-library-refresh]').onclick = async () => {
        EditorTruth.refresh();
        await this.render();
      };
      const adopt = node.querySelector('[data-library-adopt]');
      if (adopt) {
        adopt.onclick = async () => {
          adopt.disabled = true;
          adopt.textContent = 'Adding…';
          await this.run('godot_adopt_open_project', {}, `Could not add ${orphan}`);
        };
      }
      node.querySelector('[data-library-create]').onsubmit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const name = String(form.project.value || '').trim();
        if (!name) return;
        const submit = form.querySelector('button[type=submit]');
        submit.disabled = true;
        submit.textContent = 'Creating…';
        await this.run('godot_create_project',
          { project_name: name, template: form.template.value },
          `Could not create ${name}`);
      };
      for (const button of node.querySelectorAll('[data-library-open]')) {
        button.onclick = async () => {
          const name = button.dataset.libraryOpen;
          button.disabled = true;
          button.textContent = 'Opening…';
          await this.run('godot_open_saved_project', { project_name: name }, `Could not open ${name}`);
        };
      }
    }
  };

  // The editor's own answer about what it has open, cached so the rail can render from it
  // without a synchronous command on every paint.
  //
  // Until this existed nothing ever asked. Opening a project through Godot's own project
  // manager left the rail describing the previous project - its name, its scene, its node
  // count - while the editor showed an empty scene. Divergence is now something the page can
  // see and say, instead of something the human discovers by not recognising their own game.
  const EditorTruth = {
    state: null,
    checkedAt: 0,

    refresh() {
      if (!EditorCommandChannel.available()) {
        this.state = null;
        return null;
      }
      const reply = EditorCommandChannel.call('project_state');
      this.state = reply.ok === true ? reply : null;
      this.checkedAt = Date.now();
      return this.state;
    },

    // Whether what the bridge believes and what the editor has open are the same project.
    // A missing answer is `null` - unknown - never a quiet `true`.
    //
    // Identity is the project, not the scene. Comparing scene paths alone reported agreement
    // between two different projects built from the same template, because both of them open
    // res://orbital_sanctuary.tscn - which is exactly the case where a human looks up and does
    // not recognise their own game.
    describe() {
      const editor = this.state;
      if (!editor) return { known: false, matches: null };
      const editorScene = String(editor.edited_scene_path || editor.main_scene || '');
      const ourScene = String(activeMainScene || '');
      const editorName = normalizeProjectIdentity(editor.project_name);
      const ourName = normalizeProjectIdentity(DiagnosticState.activeProject);
      const projectMatches = Boolean(editorName) && editorName === ourName;
      // A scene disagreement only counts when the editor actually has one open.
      const sceneMatches = !editorScene || !ourScene || editorScene === ourScene;
      return {
        known: true,
        matches: projectMatches && sceneMatches,
        project_matches: projectMatches,
        scene_matches: sceneMatches,
        editor_project: editor.project_name || null,
        editor_scene: editorScene || null,
        editor_scene_root: editor.edited_scene_root || null,
        editor_node_count: Number(editor.node_count) || 0,
        has_edited_scene: editor.has_edited_scene === true,
        bridge_project: DiagnosticState.activeProject,
        bridge_scene: ourScene
      };
    }
  };

  const SceneInspector = {
    node: null,
    expanded: false,
    savedProjects: [],
    projectsLoaded: false,
    projectsLoading: false,

    ensure() {
      const slot = AgentRail.slot('webmcp-inspector-slot', 'flex-end');
      if (!slot) return false;
      if (!this.node) {
        this.node = document.createElement('div');
        this.node.id = 'webmcp-scene-inspector';
        this.node.style.cssText = `${PANEL_STYLE};width:min(320px, calc(100vw - 32px));padding:6px 10px;cursor:pointer`;
        this.node.tabIndex = 0;
        this.node.setAttribute('aria-label', 'Scene details. Enter or Space expands the node list.');
        const toggle = () => {
          this.expanded = !this.expanded;
          this.render();
          if (this.expanded) this.refreshProjects();
        };
        this.node.addEventListener('click', toggle);
        this.node.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
        });
        slot.appendChild(this.node);
      }
      return true;
    },

    async refreshProjects() {
      if (this.projectsLoading) return;
      this.projectsLoading = true;
      this.render();
      try {
        this.savedProjects = await listSavedProjects();
        this.projectsLoaded = true;
      } catch (error) {
        AgentStatusRail.setFocusNote(`Could not read saved projects: ${error.message || error}`);
      } finally {
        this.projectsLoading = false;
        this.render();
      }
    },

    async openProject(projectName) {
      const tool = MANIFEST_TOOLS.find(item => item.definition.name === 'godot_open_saved_project');
      if (!tool) return;
      AgentStatusRail.setFocusNote(`Opening ${projectName}`);
      try {
        await executeObservedTool(tool, { project_name: projectName });
        await this.refreshProjects();
      } catch (error) {
        AgentStatusRail.setFocusNote(`Could not open ${projectName}: ${error.message || error}`);
      }
    },

    // Reads only what is actually in the parsed scene. The version this replaces invented
    // gameplay facts ("Active Hazards (25 DMG)", "Finish Line Portal @ 800m") from filename
    // substrings, for every project — re-committing the exact TRUTH-02 defect the gap log
    // records as fixed.
    render() {
      if (!this.ensure()) return;
      const graph = sceneGraphFromFiles(activeFilesDict);
      // The project name, always visible.
      //
      // The rail named the scene but never the project, so two projects with the same scene
      // layout were indistinguishable on screen - and "I came back and there was a different
      // character" had nothing on the page that could have told you which project you were
      // looking at.
      // Counts come from the editor when it can answer, because the parsed .tscn is only the
      // bridge's belief about the project and the editor is the one holding it open.
      const truth = EditorTruth.describe();
      const diverged = truth.known && truth.matches === false;
      const nodeCount = truth.known && truth.has_edited_scene ? truth.editor_node_count : graph.nodes.length;
      const sceneLabel = diverged ? (truth.editor_scene || '(no scene open)') : activeMainScene;
      const projectLabel = diverged
        ? (truth.editor_project || 'unknown')
        : (DiagnosticState.activeProject || 'none');
      const head = `<div style="display:flex;align-items:center;gap:8px;white-space:nowrap">`
        + `<span style="color:${RAIL_TOKENS.muted};text-transform:uppercase;letter-spacing:.06em;font-size:10px">Project</span>`
        + `<span style="flex:0 0 auto;font-weight:600">${escapeHtml(projectLabel)}</span>`
        + `<span aria-hidden="true" style="color:${RAIL_TOKENS.border}">/</span>`
        + `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;color:${RAIL_TOKENS.muted}">${escapeHtml(sceneLabel)}</span>`
        + (diverged
          ? `<span title="Godot has a different project open than the one this page is tracking" style="flex:0 0 auto;border:1px solid ${RAIL_TOKENS.warn};color:${RAIL_TOKENS.warn};border-radius:999px;padding:1px 7px;font:500 10px/1.5 ${RAIL_TOKENS.mono}">opened in Godot</span>`
          : '')
        + `<span style="margin-left:auto;color:${RAIL_TOKENS.muted};font:400 11px/1 ${RAIL_TOKENS.mono}">${nodeCount} nodes</span>`
        + `<span aria-hidden="true" style="color:${RAIL_TOKENS.muted}">${this.expanded ? '⌄' : '⌃'}</span></div>`;
      if (!this.expanded) {
        this.node.innerHTML = head;
        return;
      }
      const scene = sceneRowsMarkup(40);
      const projects = this.projectsLoading && !this.projectsLoaded
        ? `<div style="color:${RAIL_TOKENS.muted};font:400 11px/1.5 ${RAIL_TOKENS.ui}">Loading saved projects…</div>`
        : (this.savedProjects.length
          ? this.savedProjects.map(project => {
              const active = project.project_name === DiagnosticState.activeProject;
              return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid ${RAIL_TOKENS.border}">`
                + `<span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;font:500 11px/1.4 ${RAIL_TOKENS.ui}">${escapeHtml(project.project_name)}</span>`
                + `<span style="color:${RAIL_TOKENS.muted};font:400 10px/1 ${RAIL_TOKENS.mono}">Rev #${project.scene_revision}</span>`
                + (active
                  ? `<span style="color:${RAIL_TOKENS.ok};font:500 10px/1 ${RAIL_TOKENS.ui}">CURRENT</span>`
                  : `<button type="button" data-open-project="${escapeHtml(project.project_name)}" style="${BUTTON_STYLE};padding:3px 7px;font-size:10px">Open</button>`)
                + `</div>`;
            }).join('')
          : `<div style="color:${RAIL_TOKENS.muted};font:400 11px/1.5 ${RAIL_TOKENS.ui}">No saved projects yet.</div>`);
      this.node.innerHTML = `${head}`
        + `<div style="margin-top:6px;padding-top:6px;border-top:1px solid ${RAIL_TOKENS.border}">`
        + `<div style="display:flex;align-items:center;margin-bottom:3px;color:${RAIL_TOKENS.muted};text-transform:uppercase;letter-spacing:.06em;font-size:10px">`
        + `<span>Saved projects</span><button type="button" data-refresh-projects style="${BUTTON_STYLE};margin-left:auto;padding:2px 6px;font-size:10px">Refresh</button></div>${projects}</div>`
        + `<div style="margin-top:6px;padding-top:6px;border-top:1px solid ${RAIL_TOKENS.border};max-height:min(32vh,190px);overflow-y:auto">${scene.rows}${scene.overflow}</div>`;
      const refresh = this.node.querySelector('[data-refresh-projects]');
      if (refresh) refresh.onclick = (event) => { event.stopPropagation(); this.refreshProjects(); };
      for (const button of this.node.querySelectorAll('[data-open-project]')) {
        button.onclick = (event) => { event.stopPropagation(); this.openProject(button.dataset.openProject); };
      }
    }
  };

  // Back-compat shims: `DiagnosticHUD.render()` and `BuildingBlocksHUD.updateFromFiles()`
  // are called from ~30 places across the tool handlers. They now drive the rail.
  const DiagnosticHUD = {
    init() { AgentStatusRail.ensure(); CameraControls.ensure(); SceneInspector.ensure(); this.render(); },
    render() {
      EditorTruth.refresh();
      AgentRail.applyLayout();
      AgentStatusRail.render();
      CameraControls.render();
      SceneInspector.render();
    }
  };

  const BuildingBlocksHUD = {
    ensure() { return SceneInspector.ensure(); },
    updateFromFiles() { SceneInspector.render(); }
  };

  // ==========================================
  // 10. Auto-Execute Synchronous Registration & Coordinator
  // ==========================================
  nativeRegistrationPromise = registerAllNativeTools().catch((error) => {
    DiagnosticState.webmcp = 'failed';
    DiagnosticState.webmcpLastError = error instanceof Error ? error.message : String(error);
    console.error('[WebMCP] Native tool registration failed:', error);
    DiagnosticHUD.render();
  });

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('godot-engine-ready', () => {
      DiagnosticState.engine = 'ready';
      DiagnosticState.engineError = null;
      // `replaceCanvas` recreated the canvas element, so any anchored reticle is now
      // pointing at geometry from the previous editor process.
      AgentFocusOverlay.hide('editor_restarted');
      DiagnosticHUD.render();
    });
    window.addEventListener('godot-engine-failed', (event) => {
      DiagnosticState.engine = 'failed';
      DiagnosticState.engineError = event?.detail?.message || 'Godot engine failed to initialize.';
      DiagnosticHUD.render();
    });
  }

  function initWebSocketBridge() {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/mcp?type=editor`;

    let socket = null;
    let reconnectTimer = null;

    function connect() {
      try {
        socket = new WebSocket(wsUrl);
        socket.onopen = () => {
          console.log('[WebMCP] Connected to WebSocket MCP Relay:', wsUrl);
          DiagnosticState.transport = 'NativeInPageWebMCP + ConnectedWSS';
          DiagnosticHUD.render();
        };

        socket.onmessage = async (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.method === 'tools/call' && data.params?.name) {
              const tool = MANIFEST_TOOLS.find(t => t.definition.name === data.params.name);
              if (!tool) {
                socket.send(JSON.stringify({
                  jsonrpc: '2.0',
                  id: data.id,
                  error: { code: -32601, message: `Tool '${data.params.name}' not found` }
                }));
                return;
              }
              try {
                const result = await executeObservedTool(tool, data.params.arguments || {});
                socket.send(JSON.stringify({
                  jsonrpc: '2.0',
                  id: data.id,
                  result
                }));
              } catch (err) {
                socket.send(JSON.stringify({
                  jsonrpc: '2.0',
                  id: data.id,
                  error: { code: -32000, message: err.message || String(err) }
                }));
              }
            }
          } catch (err) {
            console.error('[WebMCP] WebSocket message handler error:', err);
          }
        };

        socket.onclose = () => {
          if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              connect();
            }, 3000);
          }
        };

        socket.onerror = () => {
          socket.close();
        };
      } catch (err) {
        // Silently ignore if running on a host without WebSocket relay
      }
    }

    connect();
  }

  function initDOM() {
    DiagnosticHUD.init();
    AgentObservationHUD.ensure();
    BuildingBlocksHUD.ensure();
    // The render heartbeat has to be running BEFORE anything needs an active-time budget:
    // a budget started with no heartbeat history cannot tell "throttled" from "not started".
    RenderHeartbeat.start();
    // Direct human interaction with the editor pauses Follow so the agent does not fight the
    // user for their workspace. Following is paused, not switched off — it resumes on its own,
    // because turning off a toggle the user set is not the agent's decision to make.
    for (const surface of ['editor-canvas', 'game-canvas']) {
      const element = document.getElementById(surface);
      if (!element) continue;
      for (const eventName of ['pointerdown', 'keydown', 'wheel']) {
        element.addEventListener(eventName, () => {
          if (!FollowAgent.enabled) return;
          FollowAgent.pause();
          AgentStatusRail.render();
        }, { passive: true });
      }
    }
    CameraGuidance.install();
    CameraGuidance.lastGeometrySignature = CameraGuidance.geometrySignature();
    projectHydrationPromise.then(() => {
      DiagnosticHUD.render();
      AgentObservationHUD.renderFeed();
      BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);
      runStartupResumeCoordinator();
    });

    initWebSocketBridge();

    window.addEventListener('beforeunload', () => {
      window.__godotWebMcpPageUnloading = true;
    });

    for (const event of ['godot-game-launched', 'godot-game-stopped', 'godot-preview-left']) {
      window.addEventListener(event, () => {
        AgentRail.applyLayout();
        AgentStatusRail.render();
      });
    }

    // index.html makes the preview visible synchronously. If an editor-side change happened
    // while that runtime was hidden, refresh it immediately after the click so returning to
    // Live Preview can never resurrect an older character or scene revision.
    const livePreviewTab = document.getElementById('btn-tab-game');
    if (livePreviewTab) {
      livePreviewTab.addEventListener('click', () => {
        if (!window.__godotPreviewStale || window.__godotGameState !== 'running') return;
        setTimeout(() => {
          if (activeGodotViewport() === 'game') refreshVisiblePlaytest();
        }, 0);
      });
    }

    window.addEventListener('godot-game-stopped', () => {
      // A deliberate close should return to the editor. A page reload, however,
      // keeps the preview intent so the host can rebuild the Game canvas.
      if (!window.__godotWebMcpPageUnloading) forgetPreviewWasRunning();
      window.__godotPreviewStale = false;
      window.__godotPreviewStaleRevision = null;
      const gameTab = document.getElementById('btn-tab-game');
      if (gameTab) {
        gameTab.title = 'Browser-hosted playable preview — separate from Godot\'s internal Game workspace';
        gameTab.textContent = 'Live Preview';
      }
      if (DiagnosticState.session === 'playtesting') {
        DiagnosticState.session = 'editor-ready';
        DiagnosticHUD.render();
      }
    });

    window.addEventListener('godot-preview-left', () => {
      // Leaving the preview is an explicit user choice; never auto-enter it on reload.
      forgetPreviewWasRunning();
      if (DiagnosticState.session === 'playtesting') {
        DiagnosticState.session = 'editor-ready';
        DiagnosticHUD.render();
      }
    });

    // index.html swaps tabs by writing inline display styles and dispatches no event, so the
    // only way to notice the editor exiting to the Loader is to watch those styles.
    const surfaceObserver = new MutationObserver(() => {
      noteEditorSurfaceGone();
      AgentRail.applyLayout();
      AgentStatusRail.render();
    });
    for (const id of ['tab-loader', 'tab-editor', 'tab-game']) {
      const element = document.getElementById(id);
      if (element) surfaceObserver.observe(element, { attributes: true, attributeFilter: ['style'] });
    }

    const readinessObserver = new MutationObserver(() => {
      const previousState = DiagnosticState.engine;
      refreshMeasuredEngineState();
      if (DiagnosticState.engine !== previousState) DiagnosticHUD.render();
    });
    ['btn-tab-editor', 'btn-tab-game'].forEach((id) => {
      const element = document.getElementById(id);
      if (element) readinessObserver.observe(element, { attributes: true, attributeFilter: ['disabled', 'class'] });
    });
    refreshMeasuredEngineState();

    setTimeout(() => {
      if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
        const modal = document.getElementById('welcome-modal');
        if (modal) modal.style.display = 'none';
      }
    }, 200);

    console.log(`[WebMCP v9.1] Bridge active with ${MANIFEST_TOOLS.length} Authoritative Tools!`);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initDOM);
    } else {
      initDOM();
    }
  }
})();
