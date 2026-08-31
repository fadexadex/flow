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
    undoDepth: 0,
    activeProject: 'neon_skyrail_3d'
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
      ready: 'Ready',
      rolling_back: 'Rolling back',
      failed: 'Failed'
    };
    return labels[phase] || phase;
  }

  function holdRuntimeFrame() {
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
      cover.style.cssText = 'position:fixed;inset:0;z-index:var(--gd-z-frame-hold, 950);width:100vw;height:100vh;object-fit:fill;background:var(--gd-surface, #141414);pointer-events:none;';
      document.body.appendChild(cover);
    }
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
          timeline: operation.timeline
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

  async function persistActiveProjectState() {
    try {
      const database = await openRecordingDatabase();
      const contentFingerprint = await computeProjectContentFingerprint(activeFilesDict);
      const snapshot = {
        id: 'active',
        project_name: DiagnosticState.activeProject,
        main_scene: activeMainScene,
        scene_revision: DiagnosticState.sceneRevision,
        files: cloneProjectFiles(activeFilesDict),
        undo_stack: undoStack.map(entry => ({ ...entry, files_before: cloneProjectFiles(entry.files_before || {}), files_after: cloneProjectFiles(entry.files_after || {}) })),
        idempotent_mutations: [...idempotentMutations.entries()].slice(-100),
        content_fingerprint: contentFingerprint,
        last_validated_revision: DiagnosticState.sceneRevision,
        validation_state: 'runtime_validated',
        updated_at: Date.now()
      };
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('projects', 'readwrite');
        transaction.objectStore('projects').put(snapshot);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Failed to persist project state.'));
      });
      database.close();
      persistedProjectAvailable = Object.keys(snapshot.files).length > 0;
      hydratedSnapshot = snapshot;
      projectPersistenceError = null;
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
      const snapshot = await new Promise((resolve, reject) => {
        const request = database.transaction('projects', 'readonly').objectStore('projects').get('active');
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('Failed to hydrate project state.'));
      });
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
        const hydratedFiles = cloneProjectFiles(snapshot.files || {});
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
    return {
      accepted: true,
      success: false,
      status: 'pending',
      operation_id: operation.id,
      label,
      poll_with: 'godot_get_operation_status'
    };
  }

  function normalizeResourcePath(filePath, fallback = 'res://main.tscn') {
    if (!filePath || typeof filePath !== 'string') return fallback;
    return filePath.startsWith('res://') ? filePath : `res://${filePath.replace(/^\/+/, '')}`;
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
    if (hasUsableRuntime && DiagnosticState.engine !== 'failed') {
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

  let editorRestartCount = 0;

  async function restartEditorWithProject(files, projectName = DiagnosticState.activeProject, timeoutMs = 60000, operation = null) {
    if (typeof window === 'undefined' || typeof window.startEditor !== 'function') {
      throw new Error('Godot editor bootstrap is unavailable.');
    }
    validateProjectFiles(files);
    editorRestartCount += 1;
    window.__webmcpRestartCount = editorRestartCount;
    if (typeof window !== 'undefined') holdRuntimeFrame();
    // A running game owns the same virtual project filesystem. Replacing the
    // editor first can race its shutdown and leave the new --path unmounted.
    if (operation) await advancePhase(operation, 'stopping_runtime');
    await stopGameRuntime(10000);
    const closeEditorButton = document.getElementById('btn-close-editor');
    if (closeEditorButton && !closeEditorButton.disabled) {
      if (operation) await advancePhase(operation, 'replacing_editor');
      if (typeof window.closeEditor === 'function') window.closeEditor();
      await waitFor(() => closeEditorButton.disabled, 3000);
    }

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
    // The editor and game share one generated Web audio module. Giving the
    // editor a real AudioContext can race game teardown/restart and invalidate
    // the next AudioWorkletNode. Authoring itself does not need audio output.
    window.startEditor(null, ['--path', `/home/web_user/projects/${projectName}`, '--editor', '--audio-driver', 'Dummy']);
    const ready = await waitFor(() => {
      if (failureMessage || readyEventObserved) return true;
      const editorTab = document.getElementById('btn-tab-editor');
      const editorCanvas = document.getElementById('editor-canvas');
      const bootTelemetry = activeLogs.some(entry => entry.time >= bootStartedAt && /Build configuration:|Godot Engine v/i.test(entry.msg));
      return Boolean(editorTab && !editorTab.disabled && editorCanvas && bootTelemetry);
    }, timeoutMs);
    window.removeEventListener('godot-engine-ready', onReady);
    window.removeEventListener('godot-engine-failed', onFailed);
    if (failureMessage) throw new Error(failureMessage);
    if (!ready) throw new Error(`Godot editor did not confirm project readiness within ${Math.round(timeoutMs / 1000)} seconds.`);
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
  }

  async function restoreProjectSnapshot(previous, operation = null) {
    if (operation) await advancePhase(operation, 'rolling_back');
    DiagnosticState.activeProject = previous.projectName;
    activeMainScene = previous.mainScene;
    activeFilesDict = cloneProjectFiles(previous.files);
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
    const stopped = await waitFor(() => stoppedEventObserved || closeGameButton.disabled || ['stopped', 'failed'].includes(window.__godotGameState), timeoutMs);
    window.removeEventListener('godot-game-stopped', onStopped);
    if (!stopped || !closeGameButton.disabled) {
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

  async function validateProjectRuntimeBoot(operation = null) {
    if (operation) await advancePhase(operation, 'validating_runtime');
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
    activeLogs.push({ level: 'info', time: Date.now(), msg: args.map(String).join(' ') });
    if (activeLogs.length > MAX_LOGS) activeLogs.shift();
    origLog.apply(console, args);
  };
  console.error = function (...args) {
    activeLogs.push({ level: 'error', time: Date.now(), msg: args.map(String).join(' ') });
    if (activeLogs.length > MAX_LOGS) activeLogs.shift();
    origError.apply(console, args);
  };
  console.warn = function (...args) {
    activeLogs.push({ level: 'warn', time: Date.now(), msg: args.map(String).join(' ') });
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
  const NeonSkyrail = {
    generateProjectGodot() {
      return `; Engine configuration file for Neon Skyrail 3D
config_version=5

[application]
config/name="Neon Skyrail 3D"
run/main_scene="res://main_3d.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")

[display]
window/size/viewport_width=1280
window/size/viewport_height=720
window/stretch/mode="canvas_items"

[rendering]
renderer/rendering_method="gl_compatibility"
environment/defaults/default_clear_color=Color(0.04, 0.05, 0.1, 1.0)
`;
    },

    generateMain3dScene() {
      return `[gd_scene load_steps=7 format=3 uid="uid://neon_skyrail_main_3d"]

[ext_resource type="Script" path="res://main_3d.gd" id="1_main"]
[ext_resource type="PackedScene" uid="uid://player_runner_3d" path="res://player_runner.tscn" id="2_player"]

[sub_resource type="ProceduralSkyMaterial" id="ProceduralSkyMaterial_1"]
sky_top_color = Color(0.15, 0.25, 0.45, 1)
sky_horizon_color = Color(0.85, 0.45, 0.65, 1)
ground_bottom_color = Color(0.05, 0.05, 0.12, 1)

[sub_resource type="Sky" id="Sky_1"]
sky_material = SubResource("ProceduralSkyMaterial_1")

[sub_resource type="Environment" id="Environment_1"]
background_mode = 2
sky = SubResource("Sky_1")
ambient_light_source = 3
ambient_light_color = Color(0.4, 0.3, 0.55, 1)
fog_enabled = true
fog_light_color = Color(0.75, 0.4, 0.6, 1)
fog_density = 0.0025

[sub_resource type="BoxMesh" id="BoxMesh_Deck"]
size = Vector3(8, 0.4, 900)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Deck"]
albedo_color = Color(0.08, 0.12, 0.25, 1)
metallic = 0.8
roughness = 0.2
emission_enabled = true
emission = Color(0.0, 0.5, 0.9, 1)
emission_energy_multiplier = 0.4

[node name="Main3D" type="Node3D"]
script = ExtResource("1_main")

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Environment_1")

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.866, -0.25, 0.433, 0, 0.866, 0.5, -0.5, -0.433, 0.75, 0, 30, 0)
light_color = Color(1, 0.92, 0.8, 1)
light_energy = 1.6

[node name="SkyrailDeck" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -400)
mesh = SubResource("BoxMesh_Deck")
surface_material_override/0 = SubResource("StandardMaterial3D_Deck")

[node name="PlayerRunner" parent="." instance=ExtResource("2_player")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1.2, 0)
`;
    },

    generateMain3dGd() {
      return `extends Node3D

var score: int = 0
var hazards_passed: int = 0
var collectibles_count: int = 0
const GOAL_Z: float = -800.0

func _ready():
	print("[Neon Skyrail] 3D Environment initialized with 900m Skyrail course.")

func _process(delta):
	var player = get_node_or_null("PlayerRunner")
	if player and player.global_position.z <= GOAL_Z:
		print("[Neon Skyrail] Dawn Gate Reached! Victory!")
`;
    },

    generatePlayerTscn() {
      return `[gd_scene load_steps=5 format=3 uid="uid://player_runner_3d"]

[ext_resource type="Script" path="res://player_runner.gd" id="1_player_gd"]

[sub_resource type="CapsuleMesh" id="CapsuleMesh_Ship"]
radius = 0.6
height = 2.0

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Ship"]
albedo_color = Color(0.0, 0.8, 1.0, 1)
metallic = 0.9
roughness = 0.1
emission_enabled = true
emission = Color(0.0, 0.9, 1.0, 1)
emission_energy_multiplier = 0.8

[sub_resource type="CapsuleShape3D" id="CapsuleShape3D_Ship"]
radius = 0.6
height = 2.0

[node name="PlayerRunner" type="CharacterBody3D"]
script = ExtResource("1_player_gd")

[node name="MeshInstance3D" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, -4.37114e-08, 1, 0, -1, -4.37114e-08, 0, 0, 0)
mesh = SubResource("CapsuleMesh_Ship")
surface_material_override/0 = SubResource("StandardMaterial3D_Ship")

[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
transform = Transform3D(1, 0, 0, 0, -4.37114e-08, 1, 0, -1, -4.37114e-08, 0, 0, 0)
shape = SubResource("CapsuleShape3D_Ship")

[node name="ChaseCamera" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.9659, 0.2588, 0, -0.2588, 0.9659, 0, 3.2, 5.8)
fov = 68.0
current = true
`;
    },

    generatePlayerGd() {
      return `extends CharacterBody3D

@export var forward_speed: float = 48.0
@export var lateral_speed: float = 14.0
@export var jump_impulse: float = 12.0
var gravity: float = 24.0

func _physics_process(delta):
	velocity.z = -forward_speed
	var input_x = Input.get_axis("ui_left", "ui_right")
	velocity.x = input_x * lateral_speed
	
	if is_on_floor() and Input.is_action_just_pressed("ui_accept"):
		velocity.y = jump_impulse
	elif not is_on_floor():
		velocity.y -= gravity * delta
		
	move_and_slide()
`;
    }
  };

  // ==========================================
  // 5B. Echoes of the Orbital Garden Generator
  // ==========================================
  const OrbitalGarden = {
    generateProjectGodot(name = 'Echoes of the Orbital Garden') {
      return `; Engine configuration file for Echoes of the Orbital Garden
config_version=5

[application]
config/name="${name}"
run/main_scene="res://orbital_sanctuary.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")

[display]
window/size/viewport_width=1280
window/size/viewport_height=720
window/stretch/mode="canvas_items"

[rendering]
renderer/rendering_method="gl_compatibility"
environment/defaults/default_clear_color=Color(0.02, 0.08, 0.06, 1.0)
`;
    },

    generateSanctuaryScene() {
      return `[gd_scene load_steps=8 format=3 uid="uid://orbital_sanctuary_3d"]

[ext_resource type="Script" path="res://orbital_sanctuary.gd" id="1_sanctuary"]
[ext_resource type="PackedScene" uid="uid://botanist_player_3d" path="res://botanist_player.tscn" id="2_player"]

[sub_resource type="ProceduralSkyMaterial" id="SkyMat_Orbital"]
sky_top_color = Color(0.05, 0.25, 0.2, 1)
sky_horizon_color = Color(0.2, 0.75, 0.55, 1)
ground_bottom_color = Color(0.02, 0.08, 0.05, 1)

[sub_resource type="Sky" id="Sky_Orbital"]
sky_material = SubResource("SkyMat_Orbital")

[sub_resource type="Environment" id="Env_Orbital"]
background_mode = 2
sky = SubResource("Sky_Orbital")
ambient_light_source = 3
ambient_light_color = Color(0.2, 0.6, 0.45, 1)
fog_enabled = true
fog_light_color = Color(0.15, 0.55, 0.4, 1)
fog_density = 0.0035

[sub_resource type="TorusMesh" id="Torus_Ring"]
inner_radius = 45.0
outer_radius = 65.0
rings = 48
ring_segments = 32

[sub_resource type="StandardMaterial3D" id="Mat_TerraformRing"]
albedo_color = Color(0.08, 0.35, 0.22, 1)
metallic = 0.4
roughness = 0.6
emission_enabled = true
emission = Color(0.0, 0.8, 0.5, 1)
emission_energy_multiplier = 0.35

[node name="OrbitalSanctuary" type="Node3D"]
script = ExtResource("1_sanctuary")

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Env_Orbital")

[node name="SunLight" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.707, -0.5, 0.5, 0, 0.707, 0.707, -0.707, -0.5, 0.5, 0, 40, 0)
light_color = Color(0.85, 1.0, 0.9, 1)
light_energy = 1.8

[node name="BiodomeRing" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, -4.37114e-08, 1, 0, -1, -4.37114e-08, 0, 0, 0)
mesh = SubResource("Torus_Ring")
surface_material_override/0 = SubResource("Mat_TerraformRing")

[node name="BotanistPlayer" parent="." instance=ExtResource("2_player")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1.5, 52)
`;
    },

    generateSanctuaryGd() {
      return `extends Node3D

var pollen_gathered: int = 0
var relics_awakened: int = 0
const TOTAL_RELICS: int = 8
const TOTAL_POLLEN: int = 12

func _ready():
	print("[Orbital Garden] Ecosystem initialized. 8 Flora Relics & 12 Solar Pollen nodes online.")

func _process(delta):
	var player = get_node_or_null("BotanistPlayer")
	if player:
		# Check sanctuary flora resonance
		pass
`;
    },

    generateBotanistTscn() {
      return `[gd_scene load_steps=5 format=3 uid="uid://botanist_player_3d"]

[ext_resource type="Script" path="res://botanist_player.gd" id="1_botanist"]

[sub_resource type="CylinderMesh" id="Cylinder_Botanist"]
top_radius = 0.4
bottom_radius = 0.5
height = 1.8

[sub_resource type="StandardMaterial3D" id="Mat_Botanist"]
albedo_color = Color(0.1, 0.9, 0.65, 1)
metallic = 0.7
roughness = 0.2
emission_enabled = true
emission = Color(0.2, 1.0, 0.7, 1)
emission_energy_multiplier = 0.6

[sub_resource type="CylinderShape3D" id="Shape_Botanist"]
top_radius = 0.4
bottom_radius = 0.5
height = 1.8

[node name="BotanistPlayer" type="CharacterBody3D"]
script = ExtResource("1_botanist")

[node name="MeshInstance3D" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.9, 0)
mesh = SubResource("Cylinder_Botanist")
surface_material_override/0 = SubResource("Mat_Botanist")

[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.9, 0)
shape = SubResource("Shape_Botanist")

[node name="OrbitalCamera" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.9396, 0.342, 0, -0.342, 0.9396, 0, 3.8, 6.2)
fov = 72.0
current = true
`;
    },

    generateBotanistGd() {
      return `extends CharacterBody3D

@export var move_speed: float = 18.0
@export var glide_speed: float = 28.0
@export var jump_impulse: float = 10.0
var gravity: float = 14.0
var is_gliding: bool = false

func _physics_process(delta):
	var input_dir = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	var dir = Vector3(input_dir.x, 0, input_dir.y).normalized()
	
	if dir:
		velocity.x = dir.x * (glide_speed if is_gliding else move_speed)
		velocity.z = dir.z * (glide_speed if is_gliding else move_speed)
	else:
		velocity.x = move_toward(velocity.x, 0, move_speed)
		velocity.z = move_toward(velocity.z, 0, move_speed)
		
	if is_on_floor() and Input.is_action_just_pressed("ui_accept"):
		velocity.y = jump_impulse
	elif not is_on_floor():
		if Input.is_action_pressed("ui_accept") and velocity.y < 0:
			is_gliding = true
			velocity.y = -2.5 # Gentle botanical glide
		else:
			is_gliding = false
			velocity.y -= gravity * delta
	else:
		is_gliding = false
		
	move_and_slide()
`;
    }
  };

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
          await validateProjectRuntimeBoot(operation);
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
  const WEBMCP_PLUGIN_CFG = `[plugin]

name="WebMCP Command Channel"
description="Publishes a synchronous JS-callable command channel on window.__godotEditorCommand so the in-page WebMCP bridge can select, focus, and mutate the edited scene without restarting the editor."
author="Godot WebMCP"
version="1.0.0"
script="plugin.gd"
`;

  const WEBMCP_PLUGIN_GD = `@tool
extends EditorPlugin

## WebMCP command channel.
##
## Publishes a synchronous, JSON-in/JSON-out function on 'window.__godotEditorCommand'
## so the in-page WebMCP bridge can drive the *real* editor: selection, Godot's own
## damped 'focus_selection' fly-to, viewport camera reads, and scene mutations that go
## through the editor's own UndoRedo stack instead of rebooting the WASM process.
##
## Every reply carries 'generation', which the JS side fences against its editor-boot
## counter so a command issued before a restart can never be mistaken for a live one.

const CHANNEL_VERSION := "1.0.0"

var _command_callback: JavaScriptObject = null
var _window: JavaScriptObject = null

func _enter_tree() -> void:
	if not OS.has_feature("web"):
		return
	if not Engine.has_singleton("JavaScriptBridge") and not ClassDB.class_exists("JavaScriptBridge"):
		return
	_window = JavaScriptBridge.get_interface("window")
	if _window == null:
		return
	_command_callback = JavaScriptBridge.create_callback(_on_command)
	_window.__godotEditorCommand = _command_callback
	_window.__godotEditorPluginVersion = CHANNEL_VERSION
	_window.__godotEditorPluginReady = true
	_tune_navigation_feel()

func _exit_tree() -> void:
	if _window == null:
		return
	_window.__godotEditorPluginReady = false
	_window.__godotEditorCommand = null
	_command_callback = null

## Godot already owns a damped fly-to; we only widen its easing so agent-driven
## framing reads as cinematic motion rather than a snap.
func _tune_navigation_feel() -> void:
	var settings := EditorInterface.get_editor_settings()
	if settings == null:
		return
	var feel := {
		"editors/3d/navigation_feel/orbit_inertia": 0.22,
		"editors/3d/navigation_feel/translation_inertia": 0.22,
		"editors/3d/navigation_feel/zoom_inertia": 0.22,
	}
	for key in feel:
		if settings.has_setting(key):
			settings.set_setting(key, feel[key])

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

func _on_command(args: Array) -> String:
	var payload: Variant = null
	if args.size() > 0 and typeof(args[0]) == TYPE_STRING:
		payload = JSON.parse_string(args[0])
	if typeof(payload) != TYPE_DICTIONARY:
		return _reply({"ok": false, "error": "Command payload must be a JSON object string."})
	var op := String(payload.get("op", ""))
	var reply: Dictionary
	match op:
		"ping": reply = _op_ping()
		"viewport_state": reply = _op_viewport_state()
		"camera_pose": reply = _op_camera_pose()
		"select": reply = _op_select(payload)
		"focus": reply = _op_focus(payload)
		"focus_dispatch": reply = _op_focus_dispatch()
		"view_preset": reply = _op_view_preset(payload)
		"viewport_tree": reply = _op_viewport_tree()
		"node_add": reply = _op_node_add(payload)
		"node_transform": reply = _op_node_transform(payload)
		"node_material": reply = _op_node_material(payload)
		"node_delete": reply = _op_node_delete(payload)
		"inspect_property": reply = _op_inspect_property(payload)
		"open_scene": reply = _op_open_scene(payload)
		_: reply = {"ok": false, "error": "Unsupported op: %s" % op}
	return _reply(reply)

func _reply(body: Dictionary) -> String:
	body["generation"] = _generation()
	body["channel_version"] = CHANNEL_VERSION
	var text := JSON.stringify(body)
	# Belt-and-braces: some browsers drop synchronous return values across the
	# JavaScriptBridge boundary, so the last reply is also readable from JS.
	if _window != null:
		_window.__godotEditorCommandResult = text
	return text

## The boot generation the JS bridge stamped on 'window' before starting this editor.
func _generation() -> int:
	if _window == null:
		return 0
	var value = _window.__godotEditorGeneration
	return int(value) if value != null else 0

# ---------------------------------------------------------------------------
# Read operations
# ---------------------------------------------------------------------------

func _op_ping() -> Dictionary:
	return {
		"ok": true,
		"engine_version": Engine.get_version_info().get("string", ""),
		"has_edited_scene": EditorInterface.get_edited_scene_root() != null,
	}

func _viewport_camera() -> Camera3D:
	var viewport := EditorInterface.get_editor_viewport_3d(0)
	return viewport.get_camera_3d() if viewport != null else null

func _op_camera_pose() -> Dictionary:
	var camera := _viewport_camera()
	if camera == null:
		return {"ok": false, "error": "No 3D editor viewport camera is available."}
	var transform := camera.global_transform
	var basis := transform.basis
	return {
		"ok": true,
		"position": [transform.origin.x, transform.origin.y, transform.origin.z],
		"basis": [
			basis.x.x, basis.x.y, basis.x.z,
			basis.y.x, basis.y.y, basis.y.z,
			basis.z.x, basis.z.y, basis.z.z,
		],
		"fov": camera.fov,
		"near": camera.near,
		"far": camera.far,
		"projection": camera.projection,
	}

func _op_viewport_state() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var selected: Array = []
	for node in EditorInterface.get_selection().get_selected_nodes():
		if root != null:
			selected.append(String(root.get_path_to(node)))
	var pose := _op_camera_pose()
	return {
		"ok": true,
		"edited_scene": root.scene_file_path if root != null else "",
		"root_name": root.name if root != null else "",
		"selection": selected,
		"unsaved": EditorInterface.get_edited_scene_root() != null and _scene_is_dirty(),
		"camera": pose if pose.get("ok", false) else null,
	}

func _scene_is_dirty() -> bool:
	# 4.x exposes no public dirty flag; the marker is advisory only.
	return false

func _op_inspect_property(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null:
		return {"ok": false, "error": "Node not found: %s" % payload.get("node_path", "")}
	var property_name := String(payload.get("property", ""))
	if property_name == "":
		var names: Array = []
		for entry in node.get_property_list():
			if int(entry.get("usage", 0)) & PROPERTY_USAGE_EDITOR:
				names.append(entry.get("name", ""))
		return {"ok": true, "node_path": String(payload.get("node_path", "")), "properties": names}
	var value = node.get(property_name)
	return {
		"ok": true,
		"node_path": String(payload.get("node_path", "")),
		"property": property_name,
		"value": str(value),
		"type": type_string(typeof(value)),
	}

# ---------------------------------------------------------------------------
# Selection and framing
# ---------------------------------------------------------------------------

func _resolve_node(node_path: String) -> Node:
	var root := EditorInterface.get_edited_scene_root()
	if root == null or node_path == "":
		return null
	if node_path == "." or node_path == String(root.name):
		return root
	var direct := root.get_node_or_null(NodePath(node_path))
	if direct != null:
		return direct
	# Fall back to a by-name search so agents can address nodes without full paths.
	var leaf := node_path.get_file() if node_path.contains("/") else node_path
	return _find_by_name(root, leaf)

func _find_by_name(node: Node, wanted: String) -> Node:
	if String(node.name) == wanted:
		return node
	for child in node.get_children():
		var found := _find_by_name(child, wanted)
		if found != null:
			return found
	return null

func _op_select(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null:
		return {"ok": false, "error": "Node not found: %s" % payload.get("node_path", "")}
	var selection := EditorInterface.get_selection()
	selection.clear()
	selection.add_node(node)
	var root := EditorInterface.get_edited_scene_root()
	return {
		"ok": true,
		"selected": String(root.get_path_to(node)),
		"node_class": node.get_class(),
	}

## Frame the node using Godot's own 'spatial_editor/focus_selection' shortcut, which eases
## the viewport camera with the editor's configured navigation inertia. There is no public
## API for setting the 3D viewport camera (godot-proposals#12112), and Camera3D.look_at is
## reset by the user's next navigation input, so the shortcut is the only supported path.
##
## Node3DEditorViewport handles that shortcut in _sinput, which is connected to the
## gui_input signal of its focusable 'surface' Control. Pushing the key into the SubViewport
## does not reach it: the SubViewport is a *child* of the container, so input pushed there
## only travels down into the 3D scene. Emitting gui_input on the surface reaches the handler
## directly, without depending on where the mouse happens to be.
func _spatial_editor_surface() -> Control:
	var viewport := EditorInterface.get_editor_viewport_3d(0)
	if viewport == null:
		return null
	var editor_viewport := viewport.get_parent()
	if editor_viewport != null:
		editor_viewport = editor_viewport.get_parent()
	if editor_viewport == null:
		return null
	for child in editor_viewport.get_children():
		if child is Control and (child as Control).focus_mode != Control.FOCUS_NONE:
			return child as Control
	return null

func _dispatch_viewport_shortcut(keycode: int) -> Dictionary:
	var surface := _spatial_editor_surface()
	var viewport := EditorInterface.get_editor_viewport_3d(0)
	if surface == null and viewport == null:
		return {"ok": false, "error": "No 3D editor viewport is available."}
	var mechanism := ""
	for pressed in [true, false]:
		var event := InputEventKey.new()
		event.keycode = keycode
		event.physical_keycode = keycode
		event.pressed = pressed
		event.echo = false
		if surface != null:
			if pressed:
				surface.grab_focus()
			surface.emit_signal("gui_input", event)
			mechanism = "surface.gui_input"
		else:
			viewport.push_input(event)
			mechanism = "subviewport.push_input"
	return {"ok": true, "mechanism": mechanism}

func _op_focus(payload: Dictionary) -> Dictionary:
	var selected := _op_select(payload)
	if not selected.get("ok", false):
		return selected
	var dispatched := _op_focus_dispatch()
	selected["focused"] = dispatched.get("ok", false)
	selected["mechanism"] = dispatched.get("mechanism", "")
	selected["shortcut"] = "spatial_editor/focus_selection"
	selected["camera_moved"] = dispatched.get("camera_moved", false)
	return selected

## Dispatch only, no selection. Node3DEditor reacts to EditorSelection changes on a deferred
## call, so a shortcut sent in the same frame as the selection frames an empty set. The JS
## side selects, waits a frame, then calls this.
func _op_focus_dispatch() -> Dictionary:
	var camera := _viewport_camera()
	var before := camera.global_transform.origin if camera != null else Vector3.ZERO
	var dispatched := _dispatch_viewport_shortcut(KEY_F)
	if not dispatched.get("ok", false):
		return dispatched
	var selection_count := EditorInterface.get_selection().get_selected_nodes().size()
	var after := camera.global_transform.origin if camera != null else Vector3.ZERO
	dispatched["selection_count"] = selection_count
	dispatched["camera_before"] = [before.x, before.y, before.z]
	# The camera itself eases over several frames; camera_cursor moves immediately, so an
	# unchanged origin here is not yet proof that nothing happened.
	dispatched["camera_after_immediate"] = [after.x, after.y, after.z]
	dispatched["camera_moved"] = before.distance_to(after) > 0.0001
	return dispatched

## Diagnostic: report the ancestor chain of the 3D editor viewport so the JS side can see
## which control actually owns the spatial editor shortcuts.
func _op_viewport_tree() -> Dictionary:
	var viewport := EditorInterface.get_editor_viewport_3d(0)
	if viewport == null:
		return {"ok": false, "error": "No 3D editor viewport."}
	var chain: Array = []
	var node: Node = viewport
	while node != null and chain.size() < 12:
		chain.append({"class": node.get_class(), "name": String(node.name)})
		node = node.get_parent()
	return {"ok": true, "chain": chain}

## Godot's own numpad view shortcuts, dispatched through the same surface handler so the
## camera interpolates to the preset with the editor's configured inertia.
func _op_view_preset(payload: Dictionary) -> Dictionary:
	var preset := String(payload.get("preset", "")).to_lower()
	var keycode := 0
	match preset:
		"front": keycode = KEY_KP_1
		"top": keycode = KEY_KP_7
		"left": keycode = KEY_KP_3
		"perspective": keycode = KEY_KP_5
		_: return {"ok": false, "error": "Unknown view preset: %s" % preset}
	var dispatched := _dispatch_viewport_shortcut(keycode)
	if not dispatched.get("ok", false):
		return dispatched
	return {"ok": true, "preset": preset, "mechanism": dispatched.get("mechanism", "")}

# ---------------------------------------------------------------------------
# Mutations — every one lands in the editor's own undo stack
# ---------------------------------------------------------------------------

func _vector3(value: Variant, fallback: Vector3) -> Vector3:
	if typeof(value) != TYPE_ARRAY or (value as Array).size() < 3:
		return fallback
	var array := value as Array
	return Vector3(float(array[0]), float(array[1]), float(array[2]))

func _color(value: Variant, fallback: Color) -> Color:
	if typeof(value) != TYPE_STRING:
		return fallback
	var text := String(value)
	return Color(text) if text.begins_with("#") else fallback

func _build_mesh(payload: Dictionary) -> Mesh:
	var mesh_type := String(payload.get("mesh_type", "box")).to_lower()
	match mesh_type:
		"cylinder":
			var cylinder := CylinderMesh.new()
			cylinder.top_radius = float(payload.get("radius", 0.5))
			cylinder.bottom_radius = float(payload.get("radius", 0.5))
			cylinder.height = float(payload.get("height", 2.0))
			return cylinder
		"sphere":
			var sphere := SphereMesh.new()
			sphere.radius = float(payload.get("radius", 1.0))
			sphere.height = float(payload.get("height", float(payload.get("radius", 1.0)) * 2.0))
			return sphere
		"torus":
			var torus := TorusMesh.new()
			torus.inner_radius = float(payload.get("inner_radius", 2.0))
			torus.outer_radius = float(payload.get("outer_radius", 2.6))
			return torus
		"prism":
			var prism := PrismMesh.new()
			prism.size = _vector3(payload.get("size"), Vector3(1, 2, 1))
			return prism
		"capsule":
			var capsule := CapsuleMesh.new()
			capsule.radius = float(payload.get("radius", 0.5))
			capsule.height = float(payload.get("height", 2.0))
			return capsule
		"plane":
			var plane := PlaneMesh.new()
			var plane_size := _vector3(payload.get("size"), Vector3(10, 10, 0))
			plane.size = Vector2(plane_size.x, plane_size.y)
			return plane
		_:
			var box := BoxMesh.new()
			box.size = _vector3(payload.get("size"), Vector3(2, 2, 2))
			return box

func _build_material(payload: Dictionary, base: StandardMaterial3D = null) -> StandardMaterial3D:
	var material := base if base != null else StandardMaterial3D.new()
	if payload.has("albedo_color"):
		material.albedo_color = _color(payload["albedo_color"], material.albedo_color)
	if payload.has("metallic"):
		material.metallic = float(payload["metallic"])
	if payload.has("roughness"):
		material.roughness = float(payload["roughness"])
	if payload.has("emission"):
		material.emission_enabled = true
		material.emission = _color(payload["emission"], material.emission)
	if payload.has("emission_energy"):
		material.emission_enabled = true
		material.emission_energy_multiplier = float(payload["emission_energy"])
	return material

func _compose_transform(position: Vector3, rotation_degrees: Vector3, scale: Vector3) -> Transform3D:
	var node := Node3D.new()
	node.position = position
	node.rotation_degrees = rotation_degrees
	node.scale = scale
	var composed := node.transform
	node.free()
	return composed

func _op_node_add(payload: Dictionary) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"ok": false, "error": "No scene is open in the editor."}
	var parent := _resolve_node(String(payload.get("parent_path", ".")))
	if parent == null:
		parent = root
	var node_name := String(payload.get("name", ""))
	if node_name == "":
		return {"ok": false, "error": "node_add requires a name."}
	if _find_by_name(root, node_name) != null:
		return {"ok": false, "error": "A node named '%s' already exists in this scene." % node_name}

	var instance := MeshInstance3D.new()
	instance.name = node_name
	instance.mesh = _build_mesh(payload)
	if typeof(payload.get("material")) == TYPE_DICTIONARY:
		instance.set_surface_override_material(0, _build_material(payload["material"]))
	instance.transform = _compose_transform(
		_vector3(payload.get("position"), Vector3.ZERO),
		_vector3(payload.get("rotation"), Vector3.ZERO),
		_vector3(payload.get("scale"), Vector3.ONE))

	var undo := get_undo_redo()
	undo.create_action("WebMCP: add %s" % node_name, UndoRedo.MERGE_DISABLE, root)
	undo.add_do_method(parent, "add_child", instance, true)
	undo.add_do_method(instance, "set_owner", root)
	undo.add_do_reference(instance)
	undo.add_undo_method(parent, "remove_child", instance)
	undo.commit_action()
	EditorInterface.save_scene()
	return {
		"ok": true,
		"node_path": String(root.get_path_to(instance)),
		"node_name": node_name,
		"aabb": _aabb_of(instance),
	}

func _op_node_transform(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null or not (node is Node3D):
		return {"ok": false, "error": "Node3D not found: %s" % payload.get("node_path", "")}
	var node3d := node as Node3D
	var relative := bool(payload.get("relative", false))
	var target := node3d.transform
	var position := _vector3(payload.get("position"), node3d.position)
	var rotation := _vector3(payload.get("rotation"), node3d.rotation_degrees)
	var scale := _vector3(payload.get("scale"), node3d.scale)
	if relative:
		position = node3d.position + _vector3(payload.get("position"), Vector3.ZERO)
		rotation = node3d.rotation_degrees + _vector3(payload.get("rotation"), Vector3.ZERO)
		scale = node3d.scale * _vector3(payload.get("scale"), Vector3.ONE)
	target = _compose_transform(position, rotation, scale)

	var undo := get_undo_redo()
	undo.create_action("WebMCP: transform %s" % node3d.name, UndoRedo.MERGE_ENDS, node3d)
	undo.add_do_property(node3d, "transform", target)
	undo.add_undo_property(node3d, "transform", node3d.transform)
	undo.commit_action()
	EditorInterface.save_scene()
	return {
		"ok": true,
		"node_path": String(EditorInterface.get_edited_scene_root().get_path_to(node3d)),
		"position": [target.origin.x, target.origin.y, target.origin.z],
		"aabb": _aabb_of(node3d),
	}

func _op_node_material(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null or not (node is MeshInstance3D):
		return {"ok": false, "error": "MeshInstance3D not found: %s" % payload.get("node_path", "")}
	var instance := node as MeshInstance3D
	var previous := instance.get_surface_override_material(0)
	var updated := _build_material(payload, previous.duplicate() if previous != null else null)
	var undo := get_undo_redo()
	undo.create_action("WebMCP: material %s" % instance.name, UndoRedo.MERGE_ENDS, instance)
	undo.add_do_method(instance, "set_surface_override_material", 0, updated)
	undo.add_do_reference(updated)
	undo.add_undo_method(instance, "set_surface_override_material", 0, previous)
	undo.commit_action()
	EditorInterface.save_scene()
	return {"ok": true, "node_path": String(payload.get("node_path", ""))}

func _op_node_delete(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null:
		return {"ok": false, "error": "Node not found: %s" % payload.get("node_path", "")}
	var root := EditorInterface.get_edited_scene_root()
	if node == root:
		return {"ok": false, "error": "The scene root cannot be deleted through the command channel."}
	var parent := node.get_parent()
	var index := node.get_index()
	var undo := get_undo_redo()
	undo.create_action("WebMCP: delete %s" % node.name, UndoRedo.MERGE_DISABLE, root)
	undo.add_do_method(parent, "remove_child", node)
	undo.add_undo_method(parent, "add_child", node, true)
	undo.add_undo_method(parent, "move_child", node, index)
	undo.add_undo_method(node, "set_owner", root)
	undo.add_undo_reference(node)
	undo.commit_action()
	EditorInterface.save_scene()
	return {"ok": true, "deleted_node": String(payload.get("node_path", ""))}

func _op_open_scene(payload: Dictionary) -> Dictionary:
	var scene_path := String(payload.get("scene_path", ""))
	if not scene_path.begins_with("res://"):
		return {"ok": false, "error": "scene_path must be a res:// path."}
	if not ResourceLoader.exists(scene_path):
		return {"ok": false, "error": "Scene does not exist: %s" % scene_path}
	EditorInterface.open_scene_from_path(scene_path)
	return {"ok": true, "scene_path": scene_path}

func _aabb_of(node: Node) -> Array:
	if node is VisualInstance3D:
		var box := (node as VisualInstance3D).get_aabb()
		var origin := (node as Node3D).global_transform.origin
		return [
			origin.x + box.position.x, origin.y + box.position.y, origin.z + box.position.z,
			box.size.x, box.size.y, box.size.z,
		]
	return []
`;

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
      return window.__godotEditorPluginReady === true && typeof window.__godotEditorCommand === 'function';
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

  function findSceneNode(filesDict, nodeName) {
    if (!nodeName) return null;
    const leaf = String(nodeName).replace(/^.*\//, '');
    const graph = sceneGraphFromFiles(filesDict);
    return graph.nodes.find(node => node.name === leaf || node.node_path === nodeName) || null;
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
    if (typeof val === 'string' && val.startsWith('#')) {
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
    const updatedTscn = mutatorFn(currentTscn);

    let channel = 'transaction';
    let channelError = null;
    const command = options.command;
    if (command && EditorCommandChannel.available()) {
      const reply = EditorCommandChannel.call(command.op, command.payload || {});
      if (reply.ok) {
        channel = 'command';
      } else if (reply.unsupported || reply.stale) {
        // The channel is gone or belongs to a previous editor process. Falling back to a
        // restart is correct: the .tscn text is the authority and nothing has been applied.
        channelError = reply.error || EditorCommandChannel.unavailableReason;
      } else {
        // The editor examined the operation and refused it — a duplicate node name, a
        // missing target, a non-Node3D. Splicing the .tscn anyway and restarting would
        // write exactly the state the editor just rejected, which is how a second
        // MagentaPortalRing ends up in the scene. Fail instead.
        const error = new Error(`The Godot editor rejected this operation: ${reply.error}`);
        error.code = 'EDITOR_COMMAND_REJECTED';
        throw error;
      }
    } else if (command) {
      channelError = EditorCommandChannel.unavailableReason;
    }

    activeFilesDict[mainScenePath] = updatedTscn;
    DiagnosticState.sceneRevision++;
    DiagnosticHUD.render();
    BuildingBlocksHUD.updateFromFiles(activeFilesDict, DiagnosticState.sceneRevision);

    let restarted = false;
    if (channel !== 'command' && typeof window !== 'undefined' && typeof restartEditorWithProject === 'function') {
      await restartEditorWithProject(activeFilesDict, DiagnosticState.activeProject);
      restarted = true;
    }
    persistActiveProjectState().catch(() => {});
    return {
      revision: DiagnosticState.sceneRevision,
      mainScene: `res://${mainScenePath}`,
      channel,
      channelError,
      restarted,
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
      // Measured wall clock for this call, including the editor restart when one was needed.
      execution_time_ms: res.elapsedMs,
      ...(res.channelError ? { editor_channel_note: res.channelError } : {})
    };
  }

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
        return {
          status: 'healthy',
          engine_state: DiagnosticState.engine,
          webmcp_state: DiagnosticState.webmcp,
          webmcp_registered_tools_count: DiagnosticState.webmcpRegisteredCount,
          webmcp_surface: DiagnosticState.webmcpSurface,
          editor_command_channel: EditorCommandChannel.describe(),
          editor_restart_count: editorRestartCount,
          camera: {
            auto_follow: CameraGuidance.autoFollowEnabled(),
            active_viewport: activeGodotViewport(),
            pose_source: resolveCameraPose()?.source || null
          },
          session: {
            state: DiagnosticState.session,
            active_project: DiagnosticState.activeProject,
            active_main_scene: activeMainScene,
            scene_revision: DiagnosticState.sceneRevision,
            undo_stack_depth: undoStack.length,
            active_operation_id: activeManagedMutationId
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
            last_error: projectPersistenceError
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

          // Synthesize audio suite assets
          const audioTypes = ['laser_fire', 'rail_impact', 'energy_pickup', 'jump_boost', 'gate_warp', 'shield_down'];
          const generatedAudio = [];
          for (const t of audioTypes) {
            const aud = AudioEngine.synthesizeSound(t, 0.4);
            activeFilesDict[aud.filename] = aud.raw_bytes;
            generatedAudio.push({ name: aud.name, filename: aud.filename, duration: aud.duration_seconds, license: aud.license });
          }

          try {
            await restartEditorWithProject(activeFilesDict, projName, 60000, operation);
            await validateProjectRuntimeBoot(operation);
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
        description: 'Procedurally synthesizes the complete 6-piece 16-bit WAV sound effects suite with duration, loudness, and MIT license metadata',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async () => {
        const audioTypes = ['laser_fire', 'rail_impact', 'energy_pickup', 'jump_boost', 'gate_warp', 'shield_down'];
        const suite = audioTypes.map(t => AudioEngine.synthesizeSound(t, 0.4));
        return {
          suite_count: suite.length,
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
          fileProvenance[filePath] = supplied || {
            source: generatedProject ? 'generated_by_godot_webmcp' : 'user_supplied_via_webmcp',
            license: generatedProject ? 'MIT' : 'unspecified'
          };
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
        description: 'Creates custom 2D/3D visual scenes, GDScripts, shaders, or authors complete project templates (orbital_garden, neon_skyrail_3d, custom) with arbitrary file injection',
        input_schema: {
          type: 'object',
          properties: {
            project_name: { type: 'string', default: 'echoes_of_the_orbital_garden' },
            template: { type: 'string', enum: ['orbital_garden', 'neon_skyrail_3d', 'custom'], default: 'orbital_garden' },
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
        validateProjectFiles(stagedFiles);
        DiagnosticState.activeProject = projName;
        activeFilesDict = stagedFiles;
        activeMainScene = mainScene;

        try {
          await restartEditorWithProject(activeFilesDict, projName, 60000, operation);
          await validateProjectRuntimeBoot(operation);
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
        description: 'Revision-checked atomic project edit. Writes or deletes text files, restarts the real Godot Editor, commits only after readiness acknowledgement, and records an undo snapshot',
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
          const previousFiles = cloneProjectFiles(activeFilesDict);
        const previousMainScene = activeMainScene;
        const restorePlaytest = typeof window !== 'undefined' && window.__godotGameState === 'running';
        if (typeof window !== 'undefined') window.__godotWebMcpKeepRuntimeFrame = restorePlaytest;
        const stagedFiles = cloneProjectFiles(activeFilesDict);
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
        await advancePhase(operation, 'staging_files');
        const validation = validateProjectFiles(stagedFiles);
        const stagedMainScene = inferMainScene(stagedFiles);

        try {
          await restartEditorWithProject(stagedFiles, DiagnosticState.activeProject, 60000, operation);
          await validateProjectRuntimeBoot(operation);
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
        description: 'Restores the exact project snapshot captured by the most recent acknowledged authoring transaction and restarts the Godot Editor',
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
        try {
          await startGameRuntime({ visible: true, timeoutMs: 15000 });
        } catch (error) {
          DiagnosticState.session = 'failed';
          DiagnosticHUD.render();
          throw error;
        }
        DiagnosticState.engine = 'ready';
        DiagnosticState.session = 'playtesting';
        DiagnosticHUD.render();
        return { success: true, status: 'running', main_scene: activeMainScene, viewport: 'game', viewport_visible: true };
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
        input_schema: { type: 'object', properties: { key: { type: 'string' }, pressed: { type: 'boolean' }, duration_ms: { type: 'integer', minimum: 20, maximum: 5000 }, await_telemetry: { type: 'boolean', default: true }, target: { type: 'string', enum: ['auto', 'editor', 'game'], default: 'auto', description: "Which Godot canvas to address. 'auto' follows the visible tab." } }, additionalProperties: false },
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
                properties: { at_ms: { type: 'integer', minimum: 0, maximum: 10000 }, key: { type: 'string' }, pressed: { type: 'boolean' } },
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
        name: 'godot_camera_focus',
        description: 'Transient viewport-only framing: selects a node and dispatches Godot\'s own spatial_editor/focus_selection so the editor camera eases to it with the configured navigation inertia, and anchors the on-page focus reticle to the node\'s projected screen position. Never mutates scene JSON, advances scene_revision, creates an undo entry, triggers autosave, or survives a project reload. Yields to the user for 750 ms after any pointer, wheel, or key input on the viewport.',
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
        if (findSceneNode(activeFilesDict, nodeName)) {
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

        const nodeBlock = `\n[node name="${nodeName}" type="MeshInstance3D" parent="${parentPath}"]\ntransform = Transform3D(${scale[0]}, 0, 0, 0, ${scale[1]}, 0, 0, 0, ${scale[2]}, ${pos[0]}, ${pos[1]}, ${pos[2]})\nmesh = SubResource("${meshSubResId}")\nsurface_material_override/0 = SubResource("${matSubResId}")\n`;

        const res = await liveMutateSceneFile((source) => {
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
          }
        });

        if (typeof window !== 'undefined') {
          AgentFocusOverlay.focus(nodeName, pos, meshType, 'SPAWNED');
          CameraGuidance.noteSceneChanged(nodeName);
        }

        return liveMutationResult(res, {
          node_name: nodeName,
          type: 'MeshInstance3D',
          parent_path: parentPath,
          position: pos,
          mesh_type: meshType
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
        const nodeName = args.node_path.replace(/^.*\//, '');
        const pos = Array.isArray(args.position) && args.position.length >= 3 ? args.position : null;
        const scale = Array.isArray(args.scale) && args.scale.length >= 3 ? args.scale : [1, 1, 1];

        const res = await liveMutateSceneFile((source) => {
          const nodeHeader = `[node name="${nodeName}"`;
          const nodeIdx = source.indexOf(nodeHeader);
          if (nodeIdx < 0) throw new Error(`Node '${nodeName}' not found in active 3D scene.`);
          const nextNodeIdx = source.indexOf('\n[node name="', nodeIdx + 1);
          const blockEnd = nextNodeIdx > 0 ? nextNodeIdx : source.length;
          let nodeBlock = source.slice(nodeIdx, blockEnd);

          if (pos) {
            const newTransform = `transform = Transform3D(${scale[0]}, 0, 0, 0, ${scale[1]}, 0, 0, 0, ${scale[2]}, ${pos[0]}, ${pos[1]}, ${pos[2]})`;
            if (nodeBlock.includes('transform = Transform3D(')) {
              nodeBlock = nodeBlock.replace(/transform = Transform3D\([^\)]+\)/, newTransform);
            } else {
              nodeBlock = nodeBlock.replace(nodeHeader, `${nodeHeader}\n${newTransform}`);
            }
          }
          return source.slice(0, nodeIdx) + nodeBlock + source.slice(blockEnd);
        }, {
          command: {
            op: 'node_transform',
            payload: {
              node_path: args.node_path, position: args.position,
              rotation: args.rotation, scale: args.scale, relative: args.relative === true
            }
          }
        });

        if (typeof window !== 'undefined') {
          AgentFocusOverlay.focus(nodeName, pos || [0, 0, 0], 'Node3D', 'TRANSFORMED');
          CameraGuidance.noteSceneChanged(nodeName);
        }

        return liveMutationResult(res, {
          node_path: args.node_path,
          position: pos,
          scale
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
        const nodeName = args.node_path.replace(/^.*\//, '');
        const matSubResId = `Mat_${nodeName}`;
        const newMatSubRes = generateMaterialSubResource(args, matSubResId);

        const res = await liveMutateSceneFile((source) => {
          const matHeader = `[sub_resource type="StandardMaterial3D" id="${matSubResId}"]`;
          let updated = source;
          const matIdx = updated.indexOf(matHeader);
          if (matIdx >= 0) {
            const nextSubResIdx = updated.indexOf('\n[sub_resource ', matIdx + 1);
            const nextNodeIdx = updated.indexOf('\n[node ', matIdx + 1);
            let endIdx = updated.length;
            if (nextSubResIdx > 0 && nextSubResIdx < endIdx) endIdx = nextSubResIdx;
            if (nextNodeIdx > 0 && nextNodeIdx < endIdx) endIdx = nextNodeIdx;
            updated = updated.slice(0, matIdx) + newMatSubRes.trimEnd() + updated.slice(endIdx);
          } else {
            const firstNodeIdx = updated.indexOf('\n[node name="');
            if (firstNodeIdx > 0) {
              updated = updated.slice(0, firstNodeIdx) + '\n' + newMatSubRes + updated.slice(firstNodeIdx);
            } else {
              updated = updated + '\n' + newMatSubRes;
            }
          }
          return updated;
        }, {
          command: {
            op: 'node_material',
            payload: {
              node_path: args.node_path, albedo_color: args.albedo_color,
              metallic: args.metallic, roughness: args.roughness,
              emission: args.emission, emission_energy: args.emission_energy
            }
          }
        });

        // A material tweak is not a geometry change: no auto-follow, and the reticle is
        // anchored to the node's real position rather than the origin.
        if (typeof window !== 'undefined') {
          AgentFocusOverlay.focus(nodeName, null, 'StandardMaterial3D', 'MATERIAL');
        }

        return liveMutationResult(res, {
          node_path: args.node_path,
          material: {
            albedo_color: args.albedo_color,
            metallic: args.metallic,
            roughness: args.roughness,
            emission: args.emission,
            emission_energy: args.emission_energy
          }
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
        const nodeName = args.node_path.replace(/^.*\//, '');
        const res = await liveMutateSceneFile((source) => {
          const nodeHeader = `[node name="${nodeName}"`;
          const nodeIdx = source.indexOf(nodeHeader);
          if (nodeIdx < 0) throw new Error(`Node '${nodeName}' not found in active scene.`);
          const nextNodeIdx = source.indexOf('\n[node name="', nodeIdx + 1);
          const blockEnd = nextNodeIdx > 0 ? nextNodeIdx : source.length;
          return source.slice(0, nodeIdx) + source.slice(blockEnd);
        }, { command: { op: 'node_delete', payload: { node_path: args.node_path } } });

        if (typeof window !== 'undefined') {
          AgentFocusOverlay.hide('node_deleted');
          CameraGuidance.noteSceneChanged(null);
        }

        return liveMutationResult(res, { deleted_node: nodeName });
      }
    }
  ];

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
        godot_author_3d_runner: `Authoring 3D runner architecture: ${input.project_name || 'Neon Skyrail'}`,
        godot_inspect_project_files: input.paths?.length ? `Inspecting ${input.paths.length} project files` : 'Inspecting authoritative project manifest',
        godot_apply_file_transaction: input.label ? `${input.label} (${input.operations?.length || 1} file${input.operations?.length === 1 ? '' : 's'})` : `Applying file transaction (${input.operations?.length || 0} operations)`,
        godot_apply_text_patch: input.label || `Patching ${input.target_path || 'file'}`,
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
        godot_camera_focus: `Framing ${input.node_path || 'node'} in the 3D viewport`,
        godot_camera_follow: `${input.enabled === false ? 'Disabling' : input.enabled === true ? 'Enabling' : 'Reading'} automatic camera follow`,
        godot_node_spawn: `Spawning ${input.name || 'Node3D'} (${input.mesh_type || 'box'})`,
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
      } else {
        entry = {
          id: ++this.sequence,
          operationId: extra.operation_id || null,
          phase: extra.phase || null,
          sequence: extra.sequence || 0,
          terminal: extra.terminal || false,
          timeline: Array.isArray(extra.timeline) ? extra.timeline.map(event => ({ ...event })) : [],
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
      const detail = result?.scene_revision ? `Rev #${result.scene_revision}` : result?.success === true ? 'Complete' : '';
      AgentObservationHUD.update('succeeded', tool.definition.name, input, detail, observation.id);
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
      if (publishState) this.publish({ mode: 'hidden', reason });
    },

    // Read by the verification harness (test/checklists/camera.md) so a check can assert
    // where the reticle actually landed rather than eyeballing a screenshot.
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

    focus(nodeName, pos = null, type = 'Node3D', action = 'SPAWNED') {
      if (!this.ensure()) return { mode: 'hidden', reason: 'no_document' };
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
      const state = projection.onScreen
        ? this.renderReticle(nodeName, type, action, target, projection, radius, rect, pose)
        : this.renderEdgeArrow(nodeName, type, action, target, projection, rect, pose);

      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => this.hide('expired'), 3200);
      return state;
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

    label(nodeName, type, action, detail) {
      return `<div style="margin-top:10px;display:flex;align-items:center;gap:8px;padding:4px 10px;border:1px solid var(--gd-border,#484848);border-radius:6px;background:var(--gd-panel,#1b1b1b);color:var(--gd-text,#d0d0d0);font:600 12px/1.3 var(--gd-font-ui,Inter,system-ui,sans-serif);white-space:nowrap;transform:translateX(-50%)">`
        + `<span style="color:var(--gd-accent,#538dda);text-transform:uppercase;letter-spacing:.06em;font-size:10px">${this.escape(action)}</span>`
        + `<span>${this.escape(nodeName)}</span>`
        + `<span style="color:var(--gd-text-muted,#9a9a9a);font:400 11px/1.3 var(--gd-font-mono,ui-monospace,monospace)">${this.escape(detail)}</span>`
        + `</div>`;
    },

    escape(value) {
      return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    },

    renderReticle(nodeName, type, action, target, projection, radius, rect, pose) {
      const size = Math.round(radius * 2);
      const coordinates = target.worldPosition.map(value => Number(value).toFixed(1)).join(', ');
      this.overlay.innerHTML =
        `<div style="position:relative;width:${size}px;height:${size}px;margin-left:${-size / 2}px;margin-top:${-size / 2}px;border:1px solid var(--gd-accent,#538dda);border-radius:4px">`
        + ['top:-1px;left:-1px;border-top:2px solid var(--gd-accent,#538dda);border-left:2px solid var(--gd-accent,#538dda)',
           'top:-1px;right:-1px;border-top:2px solid var(--gd-accent,#538dda);border-right:2px solid var(--gd-accent,#538dda)',
           'bottom:-1px;left:-1px;border-bottom:2px solid var(--gd-accent,#538dda);border-left:2px solid var(--gd-accent,#538dda)',
           'bottom:-1px;right:-1px;border-bottom:2px solid var(--gd-accent,#538dda);border-right:2px solid var(--gd-accent,#538dda)']
          .map(style => `<span style="position:absolute;width:10px;height:10px;${style}"></span>`).join('')
        + `</div>`
        + this.label(nodeName, type, action, `[${coordinates}]`);
      this.overlay.style.opacity = '1';
      this.moveTo(projection.x, projection.y);
      const state = {
        mode: 'reticle',
        x: projection.x,
        y: projection.y,
        canvas_rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        ndc: projection.ndc,
        radius,
        nodeName,
        offscreen: false,
        camera_source: pose.source,
        world_position: target.worldPosition
      };
      this.publish(state);
      AgentStatusRail.setFocusNote(`${nodeName} · framed`);
      return state;
    },

    renderEdgeArrow(nodeName, type, action, target, projection, rect, pose) {
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
        + this.label(nodeName, type, action, detail);
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
  const CAMERA_AUTO_FOLLOW_PREFERENCE_KEY = 'godot-webmcp.auto-follow';

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
    queued: false,
    lastGeometrySignature: null,
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
      if (enabled) this.lastInteractionAt = Number.NEGATIVE_INFINITY;
      else this.pending = null;
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
    // then polls the viewport pose for a bounded number of frames so the reticle tracks the
    // camera while Godot eases it.
    async guide({ nodeName, reason = 'explicit' }) {
      this.install();
      if (this.withinCooldown()) return this.yieldedToUser();
      const generation = EditorCommandChannel.generation;
      const node = findSceneNode(activeFilesDict, nodeName);
      if (!node) {
        return { status: 'failed', reason: 'unknown_node', error: `Node '${nodeName}' is not in the active scene.`, transient: true };
      }

      const overlayState = AgentFocusOverlay.focus(node.name, node.world_position, node.type, 'FOCUS');
      // Select, let Node3DEditor's deferred selection handling run, then dispatch the
      // framing shortcut. Sending both in one frame frames an empty selection.
      const selected = EditorCommandChannel.call('select', { node_path: node.node_path });
      let reply = selected;
      if (selected.ok) {
        await nextFrame();
        await nextFrame();
        reply = EditorCommandChannel.call('focus_dispatch');
      }
      if (!reply.ok) {
        return {
          status: 'overlay_only',
          reason: reply.unsupported ? 'command_channel_unavailable' : 'focus_rejected',
          error: reply.error,
          camera_moved: false,
          target_reached: false,
          transient: true,
          overlay: overlayState,
          scene_revision: DiagnosticState.sceneRevision
        };
      }

      const reduced = typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
      const frames = reduced ? 1 : MAX_GUIDANCE_FRAMES;
      let framesPresented = 0;
      for (let frame = 0; frame < frames; frame += 1) {
        await nextFrame();
        if (EditorCommandChannel.generation !== generation) {
          return { status: 'stale', reason: 'editor_restarted', transient: true, frames_presented: framesPresented };
        }
        if (this.withinCooldown()) return this.yieldedToUser();
        AgentFocusOverlay.focus(node.name, node.world_position, node.type, 'FOCUS');
        framesPresented += 1;
      }
      return {
        status: 'framed',
        reason,
        camera_moved: true,
        target_reached: true,
        transient: true,
        frames_presented: framesPresented,
        mechanism: reply.mechanism || 'spatial_editor/focus_selection',
        node_path: node.node_path,
        scene_revision: DiagnosticState.sceneRevision,
        overlay: overlayState
      };
    },

    // One pending follow at a time: a burst of spawns collapses to a single camera move.
    queueFollow(nodeName, reason = 'geometry_change') {
      if (!this.autoFollowEnabled()) return;
      this.pending = { nodeName, reason };
      if (this.queued) return;
      this.queued = true;
      Promise.resolve().then(async () => {
        this.queued = false;
        const request = this.pending;
        this.pending = null;
        if (!request || !this.autoFollowEnabled()) return;
        try {
          await this.guide(request);
        } catch (_) {
          // Auto-follow is best-effort; it must never fail an accepted scene mutation.
        }
      });
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
      if (changed && nodeName) this.queueFollow(nodeName);
      return changed;
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

  // Godot's own docks already fill a narrow screen, so below this width the rail folds to a
  // single full-width status strip and the camera controls and scene list move inside its
  // expanded panel. Three side-by-side panels at 493px overlap each other and the docks.
  const RAIL_STACK_BREAKPOINT = 760;

  function isNarrowRail() {
    return typeof window !== 'undefined' && window.innerWidth < RAIL_STACK_BREAKPOINT;
  }

  function cameraControlsMarkup() {
    const following = CameraGuidance.autoFollowEnabled();
    const available = EditorCommandChannel.available();
    return `<button type="button" data-follow="1" aria-pressed="${following}" style="${BUTTON_STYLE};border-color:${following ? RAIL_TOKENS.accent : RAIL_TOKENS.border};color:${following ? RAIL_TOKENS.accent : RAIL_TOKENS.muted}">`
      + `<span aria-hidden="true" style="display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;background:${following ? RAIL_TOKENS.accent : RAIL_TOKENS.muted}"></span>Auto follow</button>`
      + `<span aria-hidden="true" style="width:1px;height:18px;background:${RAIL_TOKENS.border}"></span>`
      + ['perspective', 'front', 'top'].map(preset =>
        `<button type="button" data-preset="${preset}" ${available ? '' : 'disabled'} title="${available ? `Switch the 3D viewport to the ${preset} view` : 'Requires the editor command plugin'}" style="${BUTTON_STYLE};text-transform:capitalize;${available ? '' : `opacity:.45;cursor:not-allowed;color:${RAIL_TOKENS.muted}`}">${preset}</button>`).join('');
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

    ensure() {
      if (typeof document === 'undefined' || !document.body) return false;
      if (this.root && document.body.contains(this.root)) return true;
      this.root = document.createElement('div');
      this.root.id = 'webmcp-agent-rail';
      this.root.style.cssText = `position:fixed;left:0;right:0;bottom:0;z-index:var(--gd-z-rail, 900);display:flex;align-items:flex-end;gap:8px;padding:8px 10px;pointer-events:none;font:500 12px/1.35 ${RAIL_TOKENS.ui}`;
      document.body.appendChild(this.root);
      if (!this.resizeBound && typeof window !== 'undefined') {
        this.resizeBound = true;
        window.addEventListener('resize', () => {
          this.applyLayout();
          AgentStatusRail.render();
        });
      }
      this.applyLayout();
      return true;
    },

    applyLayout() {
      if (!this.root) return;
      const narrow = isNarrowRail();
      for (const [id, hideWhenNarrow] of [['webmcp-camera-slot', true], ['webmcp-status-slot', false], ['webmcp-inspector-slot', true]]) {
        const slot = document.getElementById(id);
        if (slot) slot.style.display = narrow && hideWhenNarrow ? 'none' : 'flex';
      }
      const strip = document.getElementById('webmcp-agent-status-strip');
      if (strip) strip.style.maxWidth = narrow ? 'calc(100vw - 20px)' : 'min(620px, calc(100vw - 32px))';
    },

    slot(id, alignment) {
      if (!this.ensure()) return null;
      let element = document.getElementById(id);
      if (!element) {
        element = document.createElement('div');
        element.id = id;
        element.style.cssText = `display:flex;justify-content:${alignment};min-width:0;flex:1 1 0;pointer-events:none`;
        this.root.appendChild(element);
      }
      return element;
    }
  };

  const CameraControls = {
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
      const reply = EditorCommandChannel.call('view_preset', { preset });
      if (!reply.ok) {
        AgentStatusRail.setFocusNote(reply.unsupported
          ? 'Camera presets need the editor command plugin'
          : `Camera preset failed: ${reply.error}`);
      }
      this.render();
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

    render() {
      if (!this.ensure()) return;
      const entries = AgentObservationHUD.entries;
      const latest = entries[entries.length - 1] || null;
      const elapsed = latest ? ((latest.completedAt || Date.now()) - latest.startedAt) / 1000 : 0;
      const color = latest ? statusColor(latest.status) : RAIL_TOKENS.muted;
      const label = latest ? latest.label : 'Waiting for a WebMCP action';
      const detail = latest?.detail ? ` · ${latest.detail}` : '';
      const note = this.focusNote ? ` · ${this.focusNote}` : '';
      const head = `<div style="display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap">`
        + this.readinessDots()
        + `<span style="width:6px;height:6px;border-radius:50%;background:${color};flex:0 0 auto"></span>`
        + `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${escapeHtml(label)}${escapeHtml(detail)}${escapeHtml(note)}</span>`
        + `<span style="flex:0 0 auto;color:${RAIL_TOKENS.muted};font:400 11px/1 ${RAIL_TOKENS.mono}">${latest ? `${elapsed.toFixed(1)}s · ` : ''}Rev #${DiagnosticState.sceneRevision}</span>`
        + `<span aria-hidden="true" style="flex:0 0 auto;color:${RAIL_TOKENS.muted}">${this.expanded ? '⌄' : '⌃'}</span>`
        + `</div>`;
      if (!this.expanded) {
        this.node.innerHTML = head;
        return;
      }
      const timeline = (latest?.timeline || []).slice(-7).map(event =>
        `<div style="display:flex;gap:8px;color:${RAIL_TOKENS.muted};font:400 11px/1.5 ${RAIL_TOKENS.mono}">`
        + `<span style="color:${event.phase === latest.phase ? RAIL_TOKENS.accent : RAIL_TOKENS.muted}">${event.phase === latest.phase ? '●' : '·'}</span>`
        + `<span style="color:${RAIL_TOKENS.text}">${escapeHtml(event.label)}</span>`
        + `<span style="margin-left:auto">${(event.elapsed_ms / 1000).toFixed(1)}s</span></div>`).join('');
      const rows = entries.slice(-5).reverse().map(entry =>
        `<div style="display:grid;grid-template-columns:64px 1fr;gap:8px;padding:3px 0;border-top:1px solid ${RAIL_TOKENS.border}">`
        + `<span style="color:${statusColor(entry.status)};text-transform:uppercase;font:500 10px/1.6 ${RAIL_TOKENS.ui}">${escapeHtml(entry.status)}</span>`
        + `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${escapeHtml(entry.label)}${entry.detail ? ` <span style="color:${RAIL_TOKENS.muted}">${escapeHtml(entry.detail)}</span>` : ''}</span></div>`).join('');
      const narrow = isNarrowRail();
      const folded = narrow
        ? `<div data-folded-camera style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;padding-top:6px;border-top:1px solid ${RAIL_TOKENS.border}">${cameraControlsMarkup()}</div>`
          + (() => {
            const scene = sceneRowsMarkup(12);
            return `<div style="margin-top:6px;padding-top:6px;border-top:1px solid ${RAIL_TOKENS.border}">`
              + `<div style="display:flex;gap:8px;color:${RAIL_TOKENS.muted};text-transform:uppercase;letter-spacing:.06em;font-size:10px"><span>Scene details</span><span style="margin-left:auto">${scene.count} nodes</span></div>`
              + `${scene.rows}${scene.overflow}</div>`;
          })()
        : '';
      this.node.innerHTML = `${head}<div style="margin-top:6px;max-height:min(40vh,240px);overflow-y:auto">${timeline}${rows}${folded}</div>`;
      if (narrow) wireCameraControls(this.node.querySelector('[data-folded-camera]'));
    }
  };

  const SceneInspector = {
    node: null,
    expanded: false,

    ensure() {
      const slot = AgentRail.slot('webmcp-inspector-slot', 'flex-end');
      if (!slot) return false;
      if (!this.node) {
        this.node = document.createElement('div');
        this.node.id = 'webmcp-scene-inspector';
        this.node.style.cssText = `${PANEL_STYLE};width:min(320px, calc(100vw - 32px));padding:6px 10px;cursor:pointer`;
        this.node.tabIndex = 0;
        this.node.setAttribute('aria-label', 'Scene details. Enter or Space expands the node list.');
        const toggle = () => { this.expanded = !this.expanded; this.render(); };
        this.node.addEventListener('click', toggle);
        this.node.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
        });
        slot.appendChild(this.node);
      }
      return true;
    },

    // Reads only what is actually in the parsed scene. The version this replaces invented
    // gameplay facts ("Active Hazards (25 DMG)", "Finish Line Portal @ 800m") from filename
    // substrings, for every project — re-committing the exact TRUTH-02 defect the gap log
    // records as fixed.
    render() {
      if (!this.ensure()) return;
      const graph = sceneGraphFromFiles(activeFilesDict);
      const head = `<div style="display:flex;align-items:center;gap:8px;white-space:nowrap">`
        + `<span style="color:${RAIL_TOKENS.muted};text-transform:uppercase;letter-spacing:.06em;font-size:10px">Scene details</span>`
        + `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${escapeHtml(activeMainScene)}</span>`
        + `<span style="margin-left:auto;color:${RAIL_TOKENS.muted};font:400 11px/1 ${RAIL_TOKENS.mono}">${graph.nodes.length} nodes</span>`
        + `<span aria-hidden="true" style="color:${RAIL_TOKENS.muted}">${this.expanded ? '⌄' : '⌃'}</span></div>`;
      if (!this.expanded) {
        this.node.innerHTML = head;
        return;
      }
      const scene = sceneRowsMarkup(40);
      this.node.innerHTML = `${head}<div style="margin-top:5px;max-height:min(40vh,240px);overflow-y:auto">${scene.rows}${scene.overflow}</div>`;
    }
  };

  // Back-compat shims: `DiagnosticHUD.render()` and `BuildingBlocksHUD.updateFromFiles()`
  // are called from ~30 places across the tool handlers. They now drive the rail.
  const DiagnosticHUD = {
    init() { AgentStatusRail.ensure(); CameraControls.ensure(); SceneInspector.ensure(); this.render(); },
    render() { AgentRail.applyLayout(); AgentStatusRail.render(); CameraControls.render(); }
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

    window.addEventListener('godot-game-stopped', () => {
      // A deliberate close should return to the editor. A page reload, however,
      // keeps the preview intent so the host can rebuild the Game canvas.
      if (!window.__godotWebMcpPageUnloading) forgetPreviewWasRunning();
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
