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
    session: 'authoring', // 'empty' | 'authoring' | 'persisted' | 'editor-ready' | 'playtesting' | 'stopped' | 'failed'
    sceneRevision: 1,
    undoDepth: 0,
    activeProject: 'neon_skyrail_3d'
  };

  const undoStack = [];
  const idempotentMutations = new Map();
  const inflightIdempotency = new Map();
  const managedOperations = new Map();
  const projectUploads = new Map();
  const GameTelemetryState = { sequence: 0, latest: null, recent: [] };
  const RecordingState = {
    recorder: null, chunks: [], videoRecorder: null, videoChunks: [], audioRecorder: null, audioChunks: [],
    startedAt: 0, id: null, canvas: null, audioDestination: null, audioMaster: null
  };
  const activeLogs = [];
  const MAX_LOGS = 500;
  let activeFilesDict = {};
  let activeMainScene = 'res://main_3d.tscn';
  let activeManagedMutationId = null;
  let projectStateHydrated = false;
  let persistedProjectAvailable = false;
  let projectPersistenceError = null;
  let projectHydrationPromise = Promise.resolve();

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
      const request = window.indexedDB.open('godot-webmcp-artifacts', 3);
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

  async function persistActiveProjectState() {
    try {
      const database = await openRecordingDatabase();
      const snapshot = {
        id: 'active',
        project_name: DiagnosticState.activeProject,
        main_scene: activeMainScene,
        scene_revision: DiagnosticState.sceneRevision,
        files: cloneProjectFiles(activeFilesDict),
        undo_stack: undoStack.map(entry => ({ ...entry, files_before: cloneProjectFiles(entry.files_before || {}), files_after: cloneProjectFiles(entry.files_after || {}) })),
        idempotent_mutations: [...idempotentMutations.entries()].slice(-100),
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
      projectPersistenceError = null;
      return true;
    } catch (error) {
      projectPersistenceError = error instanceof Error ? error.message : String(error);
      activeLogs.push({ level: 'warn', time: Date.now(), msg: `[Persistence] ${projectPersistenceError}` });
      return false;
    }
  }

  async function hydratePersistedProjectState() {
    try {
      const database = await openRecordingDatabase();
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
      database.close();
      projectUploads.clear();
      for (const upload of uploadSnapshots.slice(-4)) {
        if (!upload?.id || !upload?.projectName || !Array.isArray(upload.files)) continue;
        upload.files = new Map(upload.files);
        projectUploads.set(upload.id, upload);
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
        DiagnosticState.session = persistedProjectAvailable ? 'persisted' : 'empty';
        DiagnosticState.engine = 'loading';
        projectPersistenceError = null;
      } else {
        DiagnosticState.session = 'empty';
        DiagnosticState.engine = 'loading';
      }
    } catch (error) {
      projectPersistenceError = error instanceof Error ? error.message : String(error);
      persistedProjectAvailable = false;
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
      shelf.style.cssText = 'position:fixed;left:14px;bottom:46px;z-index:999999;padding:9px 12px;border:1px solid rgba(255,200,87,.55);border-radius:8px;background:rgba(12,15,25,.94);font:600 11px/1.35 Inter,system-ui,sans-serif;color:#ffe6a2';
      document.body.appendChild(shelf);
    }
    if (replace) shelf.innerHTML = '';
    const link = document.createElement('a');
    link.href = record.object_url;
    link.download = record.filename;
    link.textContent = `Download recording · ${record.filename} · ${(record.blob.size / 1024 / 1024).toFixed(2)} MB`;
    link.style.cssText = 'color:#ffc857;text-decoration:none;pointer-events:auto';
    shelf.appendChild(link);
    return record.object_url;
  }

  function publicOperation(operation) {
    return {
      operation_id: operation.id,
      tool: operation.tool,
      label: operation.label,
      status: operation.status,
      started_at: operation.startedAt,
      completed_at: operation.completedAt || null,
      elapsed_ms: (operation.completedAt || Date.now()) - operation.startedAt,
      ...(operation.result ? { result: operation.result } : {}),
      ...(operation.error ? { error: operation.error } : {})
    };
  }

  async function runManagedMutation(tool, label, mutation, inlineWaitMs = 10000, idempotency = null) {
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
      startedAt: Date.now(),
      completedAt: null,
      result: null,
      error: null,
      promise: null
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
        operation.result = await mutation();
        operation.status = 'succeeded';
      } catch (error) {
        operation.error = error instanceof Error ? error.message : String(error);
        operation.status = 'failed';
      } finally {
        operation.completedAt = Date.now();
        if (activeManagedMutationId === operation.id) activeManagedMutationId = null;
        if (idempotency?.key && inflightIdempotency.get(idempotency.key)?.operationId === operation.id) {
          inflightIdempotency.delete(idempotency.key);
        }
        if (operation.observationIds?.size && typeof AgentObservationHUD !== 'undefined') {
          const detail = operation.status === 'succeeded'
            ? (operation.result?.scene_revision ? `Rev #${operation.result.scene_revision}` : 'Complete')
            : operation.error;
          for (const observationId of operation.observationIds) {
            AgentObservationHUD.update(operation.status, operation.tool, {}, detail, observationId);
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

  async function persistProjectUpload(upload) {
    try {
      const database = await openRecordingDatabase();
      const snapshot = { ...upload, files: [...upload.files.entries()] };
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('uploads', 'readwrite');
        transaction.objectStore('uploads').put(snapshot);
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

  async function deletePersistedProjectUpload(uploadId) {
    const database = await openRecordingDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('uploads', 'readwrite');
      transaction.objectStore('uploads').delete(uploadId);
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

  async function restartEditorWithProject(files, projectName = DiagnosticState.activeProject, timeoutMs = 60000) {
    if (typeof window === 'undefined' || typeof window.startEditor !== 'function') {
      throw new Error('Godot editor bootstrap is unavailable.');
    }
    validateProjectFiles(files);
    const closeEditorButton = document.getElementById('btn-close-editor');
    if (closeEditorButton && !closeEditorButton.disabled) {
      if (typeof window.closeEditor !== 'function') throw new Error('The existing editor cannot be closed safely.');
      window.closeEditor();
      const closed = await waitFor(() => closeEditorButton.disabled, 12000);
      if (!closed) throw new Error('Existing Godot editor did not stop within 12 seconds.');
    }

    window._mcpProjectName = projectName;
    window._mcpProjectFiles = files;
    DiagnosticState.engine = 'loading';
    DiagnosticState.session = 'authoring';
    DiagnosticHUD.render();

    const bootStartedAt = Date.now();
    let readyEventObserved = false;
    let failureMessage = null;
    const onReady = () => { readyEventObserved = true; };
    const onFailed = (event) => { failureMessage = event?.detail?.message || 'Godot editor failed to initialize.'; };
    window.addEventListener('godot-engine-ready', onReady, { once: true });
    window.addEventListener('godot-engine-failed', onFailed, { once: true });
    window.startEditor(null, ['--path', `/home/web_user/projects/${projectName}`, '--editor']);
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
    DiagnosticState.engine = 'ready';
    DiagnosticState.session = 'editor-ready';
    DiagnosticHUD.render();
    return true;
  }

  async function restoreProjectSnapshot(previous) {
    DiagnosticState.activeProject = previous.projectName;
    activeMainScene = previous.mainScene;
    activeFilesDict = cloneProjectFiles(previous.files);
    if (Object.keys(previous.files).length > 0) {
      try {
        await restartEditorWithProject(previous.files, previous.projectName);
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
    const patterns = /SCRIPT ERROR|Parse Error|Failed to load (?:script|resource|scene)|Game (?:start|initialization) failed|Invalid get index|Invalid call|Nonexistent function/i;
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

  async function stopGameRuntime(timeoutMs = 10000) {
    const closeGameButton = document.getElementById('btn-close-game');
    const wasRunning = Boolean(closeGameButton && !closeGameButton.disabled);
    if (!wasRunning) return false;
    if (typeof window.closeGame !== 'function') throw new Error('Game is running, but the runtime quit control is unavailable.');
    const stoppedEvent = waitForRuntimeEvent('godot-game-stopped', null, timeoutMs, `Godot did not emit a stopped event within ${Math.round(timeoutMs / 1000)} seconds.`);
    window.closeGame();
    await stoppedEvent;
    const controlsStopped = await waitFor(() => closeGameButton.disabled, 2000);
    if (!controlsStopped) throw new Error('Godot emitted a stopped event, but the game controls still report a running runtime.');
    return true;
  }

  async function startGameRuntime({ visible = true, timeoutMs = 15000 } = {}) {
    if (typeof window.Execute !== 'function') throw new Error('Godot editor is not initialized; author or open a project before running it.');
    await stopGameRuntime(10000);
    const startedAt = Date.now();
    const launchedEvent = waitForRuntimeEvent(
      'godot-game-launched',
      'godot-game-failed',
      timeoutMs,
      `Godot did not confirm game launch within ${Math.round(timeoutMs / 1000)} seconds.`
    );
    window.Execute(['--path', `/home/web_user/projects/${DiagnosticState.activeProject}`]);
    await launchedEvent;
    await waitFor(() => {
      if (recentGodotErrors(startedAt).length > 0) return true;
      return activeLogs.some(entry => entry.time >= startedAt && /Build configuration:|Godot Engine v/i.test(entry.msg));
    }, Math.min(timeoutMs, 2500));
    await new Promise(resolve => setTimeout(resolve, 450));
    const errors = recentGodotErrors(startedAt);
    if (errors.length > 0) {
      try { await stopGameRuntime(6000); } catch (_) {}
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
    return { gameReady: true, gameVisible: visible ? gameVisible : false, startedAt };
  }

  async function validateProjectRuntimeBoot() {
    try {
      await startGameRuntime({ visible: false, timeoutMs: 30000 });
    } finally {
      try { await stopGameRuntime(10000); } catch (_) {}
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

  // ==========================================
  // 6. Authoritative Native Tool Manifest
  // ==========================================
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
        return {
          status: 'healthy',
          engine_state: DiagnosticState.engine,
          webmcp_state: DiagnosticState.webmcp,
          webmcp_registered_tools_count: DiagnosticState.webmcpRegisteredCount,
          webmcp_surface: DiagnosticState.webmcpSurface,
          session: {
            state: DiagnosticState.session,
            active_project: DiagnosticState.activeProject,
            active_main_scene: activeMainScene,
            scene_revision: DiagnosticState.sceneRevision,
            undo_stack_depth: undoStack.length,
            active_operation_id: activeManagedMutationId
          },
          persistence: {
            hydrated: projectStateHydrated,
            project_available: persistedProjectAvailable,
            restore_required: DiagnosticState.session === 'persisted',
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
      handler: async () => {
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
        return runManagedMutation('godot_restore_project_session', `Restoring persisted project: ${DiagnosticState.activeProject}`, async () => {
          await restartEditorWithProject(activeFilesDict, DiagnosticState.activeProject);
          await validateProjectRuntimeBoot();
          return {
            success: true,
            restored: true,
            active_project: DiagnosticState.activeProject,
            main_scene: activeMainScene,
            scene_revision: DiagnosticState.sceneRevision,
            undo_stack_depth: undoStack.length,
            files_restored: Object.keys(activeFilesDict),
            editor_acknowledged: true
          };
        });
      }
    },
    {
      definition: {
        name: 'godot_get_operation_status',
        description: 'Returns status and final results for long-running authoring operations that outlive a browser tool-call deadline',
        input_schema: {
          type: 'object',
          properties: {
            operation_id: { type: 'string', description: 'Specific operation ID; omit to inspect the active and recent operations' }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        if (args.operation_id) {
          const operation = managedOperations.get(args.operation_id);
          if (!operation) throw new Error(`Unknown managed operation: ${args.operation_id}`);
          return publicOperation(operation);
        }
        const recent = [...managedOperations.values()].slice(-10).reverse().map(publicOperation);
        const active = activeManagedMutationId ? managedOperations.get(activeManagedMutationId) : null;
        return {
          active_operation: active ? publicOperation(active) : null,
          recent_operations: recent
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
      handler: async (args = {}) => {
        const projName = cleanProjectName(args.project_name || 'neon_skyrail_3d');
        const idempotencyKey = args.idempotency_key;
        const fingerprint = mutationFingerprint('godot_author_3d_runner', args);
        return runManagedMutation('godot_author_3d_runner', `Authoring 3D runner: ${projName}`, async () => {
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
          await restartEditorWithProject(activeFilesDict, projName);
          await validateProjectRuntimeBoot();
        } catch (error) {
          await restoreProjectSnapshot(previous);
          throw error;
        }

        DiagnosticState.sceneRevision++;
        DiagnosticHUD.render();
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
        }, 10000, { key: idempotencyKey, fingerprint });
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
        file.chunks.push(bytes);
        file.receivedBytes += bytes.byteLength;
        file.complete = args.final === true;
        upload.totalBytes += bytes.byteLength;
        upload.updatedAt = Date.now();
        const persisted = await persistProjectUpload(upload);
        return { success: true, status: file.complete ? 'file_complete' : 'chunk_accepted', persisted, ...publicProjectUpload(upload) };
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
      handler: async (args = {}) => {
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
        const result = await createTool.handler({ project_name: upload.projectName, template: 'custom', files, idempotency_key: args.idempotency_key, _upload_id: upload.id });
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
      handler: async (args = {}) => {
        const projName = cleanProjectName(args.project_name || 'echoes_of_the_orbital_garden');
        const idempotencyKey = args.idempotency_key;
        const fingerprint = mutationFingerprint('godot_create_project', args);

        if (args.template === 'custom' && (!args.files || Object.keys(args.files).length === 0)) {
          throw new Error('The custom template requires a non-empty files dictionary. No fallback template was created.');
        }

        return runManagedMutation('godot_create_project', `Creating project: ${projName}`, async () => {
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
          await restartEditorWithProject(activeFilesDict, projName);
          await validateProjectRuntimeBoot();
        } catch (error) {
          await restoreProjectSnapshot(previous);
          throw error;
        }

        DiagnosticState.sceneRevision++;
        DiagnosticHUD.render();
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
        }, 10000, { key: idempotencyKey, fingerprint });
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
      handler: async (args = {}) => {
        const fingerprint = mutationFingerprint('godot_apply_file_transaction', args);
        const replay = getIdempotentReplay(args.idempotency_key, fingerprint);
        if (replay) return replay;
        if (args.expected_revision !== DiagnosticState.sceneRevision) {
          throw new Error(`Revision conflict: expected ${args.expected_revision}, current ${DiagnosticState.sceneRevision}. Inspect before editing.`);
        }
        if (!Array.isArray(args.operations) || args.operations.length === 0) throw new Error('At least one file operation is required.');

        return runManagedMutation('godot_apply_file_transaction', `Applying file transaction: ${args.label || 'Project update'}`, async () => {
          const previousFiles = cloneProjectFiles(activeFilesDict);
        const previousMainScene = activeMainScene;
        const stagedFiles = cloneProjectFiles(activeFilesDict);
        const changedPaths = [];
        for (const operation of args.operations) {
          const filePath = cleanProjectPath(operation.path);
          if (operation.kind === 'write') {
            if (typeof operation.content !== 'string') throw new Error(`Write operation requires text content: ${filePath}`);
            stagedFiles[filePath] = operation.content;
          } else if (operation.kind === 'delete') {
            if (!(filePath in stagedFiles)) throw new Error(`Cannot delete missing project file: ${filePath}`);
            delete stagedFiles[filePath];
          } else {
            throw new Error(`Unsupported file operation: ${operation.kind}`);
          }
          changedPaths.push(`res://${filePath}`);
        }
        const validation = validateProjectFiles(stagedFiles);
        const stagedMainScene = inferMainScene(stagedFiles);

        try {
          await restartEditorWithProject(stagedFiles, DiagnosticState.activeProject);
          await validateProjectRuntimeBoot();
        } catch (error) {
          try { await restartEditorWithProject(previousFiles, DiagnosticState.activeProject); } catch (_) {}
          throw error;
        }

        activeFilesDict = stagedFiles;
        activeMainScene = stagedMainScene;
        DiagnosticState.sceneRevision++;
        DiagnosticHUD.render();
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
          return result;
        }, 10000, { key: args.idempotency_key, fingerprint });
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
        description: 'Requests native Godot Editor node selection. Fails explicitly when the editor command channel is unavailable; never fabricates selection success.',
        input_schema: { type: 'object', properties: { node_path: { type: 'string' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        unsupportedEditorOperation('Node selection', 'Use godot_inspect_project_files to inspect source until a native editor plugin exposes selection acknowledgements.');
      }
    },
    {
      definition: {
        name: 'godot_transform_node_live',
        description: 'Requests a native Godot node transform. Fails explicitly without editor acknowledgement; use the file transaction tool for source-backed transforms.',
        input_schema: { type: 'object', properties: { node_path: { type: 'string' }, translation: { type: 'array' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        unsupportedEditorOperation('Live node transform', 'Use godot_apply_file_transaction to update the owning .tscn scene transactionally.');
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
        description: 'Requests a native Inspector property read. Fails explicitly without editor acknowledgement; project source inspection remains available.',
        input_schema: { type: 'object', properties: { property: { type: 'string' }, value: {} }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        unsupportedEditorOperation('Live Inspector property read', 'Use godot_inspect_project_files for authoritative source values.');
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
        description: 'Requests a native scene-open operation. Fails explicitly without editor acknowledgement; main-scene changes can be made transactionally.',
        input_schema: { type: 'object', properties: { scene_path: { type: 'string' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        unsupportedEditorOperation('Open scene', 'Use godot_apply_file_transaction to change project.godot run/main_scene, then restart the acknowledged editor session.');
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
        input_schema: { type: 'object', properties: { key: { type: 'string' }, pressed: { type: 'boolean' }, await_telemetry: { type: 'boolean', default: true } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const key = args.key || 'Space';
        const pressed = args.pressed !== false;
        const before = GameTelemetryState.latest;
        const inputId = `input_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const canvas = document.getElementById('game-canvas') || document.getElementById('editor-canvas');
        if (!canvas) throw new Error('No Godot canvas is available to receive input.');
        window.__godotWebMcpInput = { input_id: inputId, key, pressed, dispatched_at: Date.now() };
        const event = new KeyboardEvent(pressed ? 'keydown' : 'keyup', { key, code: key, bubbles: true });
        canvas.dispatchEvent(event);
        document.dispatchEvent(event);
        if (args.await_telemetry !== false) {
          await waitFor(() => GameTelemetryState.latest?.sequence > (before?.sequence || 0), 900, 50);
        }
        const after = GameTelemetryState.latest;
        const inputAcknowledged = after?.state?.input_id === inputId;
        return {
          success: true,
          input_id: inputId,
          dispatched_key: key,
          pressed,
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
        name: 'godot_capture_viewport',
        description: 'Captures the WebGL canvas pixel buffer directly as base64 PNG data URL',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async () => {
        const canvas = document.getElementById('game-canvas') || document.getElementById('editor-canvas');
        if (!canvas || typeof canvas.toDataURL !== 'function') {
          throw new Error('No canvas is available for viewport capture.');
        }
        return {
          success: true,
          width: canvas.width,
          height: canvas.height,
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
            delta_y: { type: 'number', default: 0 }
          },
          required: ['action', 'x', 'y'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const canvas = document.getElementById('game-canvas') || document.getElementById('editor-canvas');
        if (!canvas) throw new Error('No Godot canvas is available to receive pointer input.');
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
          gameplay_acknowledged: false,
          verify_with: 'godot_get_game_telemetry'
        };
      }
    },
    {
      definition: {
        name: 'godot_start_recording',
        description: 'Starts a real MediaRecorder capture of the visible Godot game canvas; use godot_stop_recording to persist it in IndexedDB',
        input_schema: {
          type: 'object',
          properties: {
            fps: { type: 'integer', minimum: 10, maximum: 60, default: 30 },
            mime_type: { type: 'string', description: 'Optional MediaRecorder MIME override, for example video/webm or video/webm;codecs=vp8,opus' }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        if (RecordingState.recorder?.state === 'recording') throw new Error('A viewport recording is already active.');
        if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is unavailable in this browser.');
        const canvas = document.getElementById('game-canvas');
        if (!canvas || typeof canvas.captureStream !== 'function') throw new Error('The visible game canvas does not support stream capture. Run the game first.');
        const fps = Math.max(10, Math.min(Number(args.fps) || 30, 60));
        const videoStream = canvas.captureStream(fps);
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
        return {
          success: true,
          status: 'recording',
          recording_id: RecordingState.id,
          fps,
          mime_type: recorder.mimeType || mimeType || 'video/webm',
          width: canvas.width,
          height: canvas.height,
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
  function resolveNativeModelContext() {
    try {
      if (typeof document !== 'undefined' && document.modelContext && typeof document.modelContext.registerTool === 'function') {
        return { context: document.modelContext, surface: 'document.modelContext' };
      }
    } catch (e) {}
    try {
      if (typeof navigator !== 'undefined' && navigator.modelContext && typeof navigator.modelContext.registerTool === 'function') {
        return { context: navigator.modelContext, surface: 'navigator.modelContext' };
      }
    } catch (e) {}
    return null;
  }

  // ==========================================
  // 8B. Editor-Level Agent Observation Layer
  // ==========================================
  const AgentObservationHUD = {
    sequence: 0,
    banner: null,
    feed: null,
    entries: [],

    describe(toolName, input = {}) {
      const labels = {
        godot_create_project: `Creating project: ${input.project_name || 'Untitled'}`,
        godot_begin_project_upload: `Beginning staged project: ${input.project_name || 'Untitled'}`,
        godot_upload_project_file_chunk: `Uploading chunk: ${input.path || 'project file'}`,
        godot_get_project_upload_status: `Inspecting staged upload: ${input.upload_id || 'unknown'}`,
        godot_abort_project_upload: `Aborting staged upload: ${input.upload_id || 'unknown'}`,
        godot_commit_project_upload: `Committing staged upload: ${input.upload_id || 'unknown'}`,
        godot_restore_project_session: 'Restoring persisted editor session',
        godot_author_3d_runner: `Authoring 3D runner: ${input.project_name || 'Neon Skyrail'}`,
        godot_inspect_project_files: 'Inspecting authoritative project files',
        godot_apply_file_transaction: `Applying file transaction: ${input.label || 'Project update'}`,
        godot_undo_transaction: `Undoing transaction: ${input.undo_id || 'latest'}`,
        godot_run_game: 'Launching game viewport',
        godot_stop_game: 'Stopping game session',
        godot_send_input: `Flight input: ${input.key || 'Unknown'} ${input.pressed === false ? 'released' : 'pressed'}`,
        godot_capture_viewport: 'Capturing live viewport',
        godot_send_pointer: `Pointer ${input.action || 'action'} at ${input.x || 0},${input.y || 0}`,
        godot_start_recording: 'Starting persistent viewport recording',
        godot_stop_recording: 'Stopping and persisting viewport recording',
        godot_list_recordings: 'Listing persistent viewport recordings',
        godot_select_node_live: `Selecting node: ${input.node_path || 'Player'}`,
        godot_transform_node_live: `Transforming node: ${input.node_path || 'Player'}`,
        godot_connect_signal_live: `Wiring signal: ${input.signal || 'signal'}`,
        godot_live_code_diff: `Editing script: ${input.script_path || 'script'}`,
        godot_hot_reload_property: `Hot reload: ${input.property_name || 'property'}`,
        godot_open_scene: `Opening scene: ${input.scene_path || 'main scene'}`,
        godot_synthesize_audio_suite: 'Synthesizing flight audio suite',
        godot_generate_audio_fx: `Generating audio: ${input.type || 'effect'}`,
        godot_export_zip: 'Packaging project ZIP',
        godot_get_session_status: 'Inspecting engine session',
        godot_get_operation_status: `Inspecting operation: ${input.operation_id || 'active/recent'}`,
        godot_get_game_telemetry: 'Reading project-owned game telemetry',
        godot_get_logs: 'Reading engine logs'
      };
      return labels[toolName] || toolName.replace(/^godot_/, '').replaceAll('_', ' ');
    },

    ensure() {
      if (typeof document === 'undefined' || !document.body) return false;
      if (!this.banner) {
        this.banner = document.createElement('div');
        this.banner.id = 'webmcp-agent-action-banner';
        this.banner.style.cssText = 'position:fixed;top:38px;left:50%;transform:translateX(-50%);z-index:1000000;min-width:420px;max-width:min(760px,80vw);padding:8px 18px;border:1px solid #00e5ff;border-radius:999px;background:rgba(3,18,28,.94);box-shadow:0 0 22px rgba(0,229,255,.34),inset 0 0 12px rgba(0,229,255,.08);color:#dffbff;font:600 12px/1.2 Inter,system-ui,sans-serif;letter-spacing:.02em;text-align:center;pointer-events:none;opacity:0;transition:opacity .16s ease,transform .16s ease;';
        document.body.appendChild(this.banner);
      }
      if (!this.feed) {
        this.feed = document.createElement('div');
        this.feed.id = 'webmcp-agent-action-feed';
        this.feed.style.cssText = 'position:fixed;top:84px;right:14px;z-index:999999;width:330px;padding:10px;border:1px solid rgba(0,229,255,.35);border-radius:9px;background:rgba(5,12,20,.9);box-shadow:0 12px 32px rgba(0,0,0,.38);color:#b9d9df;font:500 10px/1.35 ui-monospace,SFMono-Regular,monospace;pointer-events:none;';
        this.feed.innerHTML = `<div style="color:#4de8ff;font-weight:750;letter-spacing:.08em;text-transform:uppercase">Agent activity · Rev #${DiagnosticState.sceneRevision}</div><div style="margin-top:5px;color:#789099">Waiting for a WebMCP action…</div>`;
        document.body.appendChild(this.feed);
      }
      return true;
    },

    renderFeed() {
      if (!this.ensure()) return;
      const rows = this.entries.slice(-5).reverse().map((entry) => {
        const color = entry.status === 'succeeded' ? '#45e7a4' : entry.status === 'failed' ? '#ff667f' : entry.status === 'pending' ? '#ffc857' : '#4de8ff';
        return `<div style="display:grid;grid-template-columns:58px 1fr;gap:8px;padding:5px 3px;border-bottom:1px solid rgba(255,255,255,.06)"><span style="color:${color};text-transform:uppercase">${this.escape(entry.status)}</span><span>${this.escape(entry.label)}</span></div>`;
      }).join('');
      this.feed.innerHTML = `<div style="margin-bottom:5px;color:#4de8ff;font-weight:750;letter-spacing:.08em;text-transform:uppercase">Agent activity · Rev #${DiagnosticState.sceneRevision}</div>${rows}`;
    },

    escape(value) {
      return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    },

    update(status, toolName, input, detail = '', entryId = null) {
      const label = this.describe(toolName, input);
      const now = Date.now();
      let entry = entryId ? this.entries.find(item => item.id === entryId) : null;
      if (entry) {
        entry.status = status;
        entry.detail = detail;
        entry.completedAt = now;
        entry.durationMs = now - entry.startedAt;
        entry.revision = DiagnosticState.sceneRevision;
      } else {
        entry = { id: ++this.sequence, status, toolName, label, detail, at: now, startedAt: now, revision: DiagnosticState.sceneRevision };
        this.entries.push(entry);
      }
      activeLogs.push({ level: status === 'failed' ? 'error' : 'info', time: entry.at, msg: `[Agent #${entry.id}] ${status}: ${label}${detail ? ` — ${detail}` : ''}` });
      if (activeLogs.length > MAX_LOGS) activeLogs.shift();
      if (this.ensure()) {
        const icon = status === 'succeeded' ? '✓' : status === 'failed' ? '!' : status === 'pending' ? '…' : '✦';
        this.banner.textContent = `${icon} AI Agent · ${label}${detail ? ` · ${detail}` : ''}`;
        this.banner.style.borderColor = status === 'failed' ? '#ff667f' : status === 'succeeded' ? '#45e7a4' : '#00e5ff';
        this.banner.style.opacity = '1';
        this.banner.style.transform = 'translateX(-50%) translateY(0)';
        clearTimeout(this._hideTimer);
        this._hideTimer = setTimeout(() => { if (this.banner) this.banner.style.opacity = '0'; }, status === 'running' ? 2200 : 3200);
        this.renderFeed();
      }
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('godot:webmcp-observation', { detail: entry }));
      }
      return entry;
    }
  };

  async function executeObservedTool(tool, input = {}) {
    await projectHydrationPromise;
    const observation = AgentObservationHUD.update('running', tool.definition.name, input);
    try {
      const result = await tool.handler(input);
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
      for (const tool of MANIFEST_TOOLS) {
        try {
          await native.context.registerTool(nativeToolDefinition(tool), { signal: controller.signal });
          count++;
        } catch (err) {
          console.error(`[WebMCP] Error registering tool '${tool.definition.name}' on ${native.surface}:`, err);
          DiagnosticState.webmcpLastError = `${tool.definition.name}: ${err.message}`;
        }
      }
      if (DiagnosticState.webmcpLastError) {
        DiagnosticState.webmcp = 'failed';
      } else {
        DiagnosticState.webmcp = 'ready';
      }
      DiagnosticState.webmcpRegisteredCount = count;
    } else {
      console.warn('[WebMCP] Native ModelContext not present in browser. Enabling test discovery bridge...');
      DiagnosticState.webmcp = 'unsupported';
      DiagnosticState.webmcpRegisteredCount = 0;
      DiagnosticState.webmcpSurface = 'application_test_bridge';
      installTestBridge();
    }
  }

  // ==========================================
  // 9. Persistent 3-State Diagnostic Readiness HUD
  // ==========================================
  const DiagnosticHUD = {
    container: null,

    init() {
      if (typeof document === 'undefined') return;
      if (this.container) return;

      this.container = document.createElement('div');
      this.container.id = 'webmcp-diagnostic-hud';
      this.container.style.cssText = `
        position: fixed;
        bottom: 12px;
        right: 12px;
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(13, 17, 23, 0.94);
        border: 1px solid rgba(56, 139, 253, 0.4);
        border-radius: 8px;
        padding: 6px 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
        font-size: 11px;
        color: #c9d1d9;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(8px);
        user-select: none;
      `;

      document.body.appendChild(this.container);
      this.render();
    },

    render() {
      if (!this.container) return;

      const engineColor = DiagnosticState.engine === 'ready' ? '#3fb950' : (DiagnosticState.engine === 'loading' ? '#d29922' : '#f85149');
      const webmcpColor = DiagnosticState.webmcp === 'ready' ? '#3fb950' : (DiagnosticState.webmcp === 'unsupported' ? '#58a6ff' : '#f85149');
      const sessionColor = DiagnosticState.session === 'playtesting' ? '#a371f7' : '#3fb950';

      this.container.innerHTML = `
        <div style="display:flex; align-items:center; gap:5px;">
          <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:${engineColor};"></span>
          <span style="font-weight:600;">Engine:</span>
          <span>${DiagnosticState.engine.toUpperCase()}</span>
        </div>
        <span style="color:#30363d;">|</span>
        <div style="display:flex; align-items:center; gap:5px;">
          <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:${webmcpColor};"></span>
          <span style="font-weight:600;">WebMCP:</span>
          <span>${DiagnosticState.webmcpRegisteredCount} Tools (${DiagnosticState.webmcp.toUpperCase()})</span>
        </div>
        <span style="color:#30363d;">|</span>
        <div style="display:flex; align-items:center; gap:5px;">
          <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:${sessionColor};"></span>
          <span style="font-weight:600;">Session:</span>
          <span>Rev #${DiagnosticState.sceneRevision} (${DiagnosticState.session})</span>
        </div>
      `;
    }
  };

  // ==========================================
  // 10. Auto-Execute Synchronous Registration
  // ==========================================
  registerAllNativeTools().catch((error) => {
    DiagnosticState.webmcp = 'failed';
    DiagnosticState.webmcpLastError = error instanceof Error ? error.message : String(error);
    console.error('[WebMCP] Native tool registration failed:', error);
    DiagnosticHUD.render();
  });

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('godot-engine-ready', () => {
      DiagnosticState.engine = 'ready';
      DiagnosticState.engineError = null;
      DiagnosticHUD.render();
    });
    window.addEventListener('godot-engine-failed', (event) => {
      DiagnosticState.engine = 'failed';
      DiagnosticState.engineError = event?.detail?.message || 'Godot engine failed to initialize.';
      DiagnosticHUD.render();
    });
  }

  function initDOM() {
    DiagnosticHUD.init();
    AgentObservationHUD.ensure();
    projectHydrationPromise.then(() => {
      DiagnosticHUD.render();
      AgentObservationHUD.renderFeed();
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
