import { createViewportControls } from "./viewport-controls.js";
import { createObserverPresentation } from
  "../../../tools/visual-authoring-core/src/observer-presentation.js";
import { resolveEntityLocalBounds, resolveEntityWorldTransform } from
  "../../../tools/visual-authoring-core/src/spatial-framing.js";

const AXIS_INDEX = Object.freeze({ x: 0, y: 1, z: 2 });
const MAX_ACTIVE_INVOCATIONS = 32;
const MAX_ACTIVITY_ENTRIES = 48;
const MAX_PENDING_DOWNLOAD_OFFERS = 8;
const MAX_PENDING_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_OBSERVER_MESSAGE_LENGTH = 240;
const MAX_REFERENCE_LABEL_LENGTH = 112;
const MAX_NATIVE_HIGHLIGHTS = 6;
const MAX_GRID_OCCLUDERS = 64;
const MAX_CUSTOM_MATERIAL_ROWS = 12;
const MAX_OWNER_IMPORT_BYTES = 16 * 1024 * 1024;
const CAMERA_GUIDANCE_PREFERENCE_KEY = "codex-modeling.camera-guidance";
const CAMERA_AUTO_FOLLOW_PREFERENCE_KEY = "codex-modeling.auto-follow";
const CAMERA_AUTO_FOLLOW_CHANGE_EVENT = "codex:camera-auto-follow-change";
const TOOL_LABELS = Object.freeze({
  readInstructionsForCodex: "Reading the scene brief",
  listDocs: "Checking references",
  getDoc: "Reading a reference",
  status: "Checking the renderer",
  scene_get: "Inspecting the scene",
  scene_preflight_batch: "Validating scene or mesh changes",
  scene_apply_batch: "Composing the scene",
  scene_undo: "Restoring the previous model",
  scene_redo: "Reapplying the restored change",
  mesh_create: "Creating geometry",
  mesh_inspect: "Inspecting the mesh",
  mesh_extrude: "Extruding faces",
  mesh_inset: "Insetting faces",
  mesh_bevel: "Beveling edges",
  mesh_subdivide: "Refining geometry",
  mesh_transform: "Shaping geometry",
  mesh_weld: "Welding vertices",
  part_add: "Adding editable geometry",
  parts_add: "Adding a small part assembly",
  part_edit: "Refining a named part",
  part_duplicate: "Duplicating an editable part",
  part_repeat: "Repeating editable parts",
  part_group: "Grouping modeling parts",
  part_feature: "Refining a modeling feature",
  part_remove: "Removing modeling geometry",
  part_convert: "Converting to editable geometry",
  part_boolean: "Cutting or joining real geometry",
  part_curve: "Sculpting continuous curved geometry",
  material_set: "Finishing materials",
  material_create: "Creating a custom material",
  material_upload_begin: "Preparing custom texture maps",
  material_upload_chunk: "Uploading a material texture",
  material_upload_status: "Checking the texture upload",
  material_upload_commit: "Adding a textured material",
  material_upload_abort: "Cancelling the texture upload",
  material_samples_list: "Browsing the material library",
  material_sample_inspect: "Inspecting a material finish",
  material_sample_apply: "Applying a material finish",
  light_set: "Shaping the light",
  camera_set: "Framing the asset",
  environment_set: "Adjusting visible daylight",
  render_capture: "Inspecting the frame",
  render_capture_batch: "Inspecting the model from every angle",
  render_contact_sheet: "Reviewing the model from multiple angles",
  asset_export_glb: "Preparing the asset",
  scene_export: "Preparing the scene",
  project_list: "Listing saved projects",
  project_active: "Checking the current project",
  project_acquire: "Acquiring project editing access",
  project_create: "Creating a project",
  project_open: "Opening a project",
  project_rename: "Renaming the project",
  project_delete: "Removing a saved project",
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function observerText(value, fallback = "", maximum = MAX_REFERENCE_LABEL_LENGTH) {
  return text(value, fallback).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, maximum);
}

function number(value, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function vector(value, fallback) {
  return Array.isArray(value) && value.length >= fallback.length
    ? fallback.map((entry, index) => number(value[index], entry)) : [...fallback];
}

function selectedEntity(state) {
  const selection = state?.selection ?? state?.selectedEntityId;
  return typeof selection === "string" ? selection
    : typeof selection?.entityId === "string" ? selection.entityId
      : Array.isArray(selection) ? selection[0] ?? null : null;
}

function entityKind(entity) {
  const components = entity?.components ?? {};
  if (components["oriel.camera"]) return "Camera";
  if (components["oriel.directionalLight"]) return "Directional light";
  if (components["oriel.pointLight"]) return "Point light";
  if (components["oriel.environment"]) return "Environment";
  const primitive = components["oriel.mesh_modeling"]?.primitive?.kind
    ?? components["oriel.primitive"]?.shape;
  if (primitive === "asset") return "Modeled mesh";
  if (primitive) return `${primitive.charAt(0).toUpperCase()}${primitive.slice(1)}`;
  return components["oriel.material"] ? "Mesh" : "Group";
}

function entityIcon(kind) {
  if (kind === "Camera") return "◎";
  if (kind.includes("light")) return "✳";
  if (kind === "Environment") return "◌";
  if (kind === "Group") return "▧";
  return "◇";
}

function cameraEntity(scene) {
  const entries = Object.entries(scene?.entities ?? {});
  return entries.find(([, entity]) => entity.components?.["oriel.camera"]?.active)
    ?? entries.find(([, entity]) => entity.components?.["oriel.camera"]);
}

function authoredCameraSignature(camera) {
  const entity = camera?.[1];
  const component = entity?.components?.["oriel.camera"];
  return JSON.stringify({
    position: entity?.components?.["oriel.transform"]?.translation ?? null,
    target: component?.lookAt ?? null,
    perspective: component?.perspective ?? null,
  });
}

function gridOccluders(scene, assets) {
  const occluders = [];
  let meshVertices = 0;
  let meshTriangles = 0;

  function worldPoint(transform, point) {
    return transform.translation.map((coordinate, row) => coordinate
      + transform.linear[row].reduce((total, value, axis) => total + value * point[axis], 0));
  }

  for (const [entityId, entity] of Object.entries(scene?.entities ?? {})) {
    const components = entity?.components;
    if (!components?.["oriel.primitive"] && !components?.["oriel.mesh_modeling"]
        && !components?.["oriel.procedural_mesh"]) continue;
    if (occluders.length >= MAX_GRID_OCCLUDERS) break;
    try {
      const local = resolveEntityLocalBounds(entity, { entityId, assets });
      if (!local) continue;
      const transform = resolveEntityWorldTransform(scene, entityId);
      const modeling = components["oriel.mesh_modeling"];
      if (modeling) {
        if (typeof assets?.inspectMesh !== "function") continue;
        const topology = assets.inspectMesh(entityId)?.topology;
        if (!Array.isArray(topology?.vertices) || !Array.isArray(topology.faces)
            || topology.vertices.length > 1024) continue;
        const triangleCount = topology.faces.reduce((total, face) =>
          total + (Array.isArray(face) && face.length >= 3 ? face.length - 2 : 0), 0);
        if (triangleCount > 2048 || meshVertices + topology.vertices.length > 8192
            || meshTriangles + triangleCount > 4096) continue;
        const vertices = topology.vertices.map((vertex) => worldPoint(transform, vertex));
        if (vertices.some((vertex) => vertex.length !== 3 || !vertex.every(Number.isFinite))) {
          continue;
        }
        const faces = topology.faces.map((face) => Array.isArray(face) ? [...face] : null);
        if (faces.some((face) => !face || face.length < 3
            || face.some((index) => !Number.isSafeInteger(index)
              || index < 0 || index >= vertices.length))) continue;
        meshVertices += vertices.length;
        meshTriangles += triangleCount;
        occluders.push({ entityId, kind: "mesh", vertices, faces });
        continue;
      }

      const primitive = components["oriel.primitive"];
      const procedural = components["oriel.procedural_mesh"];
      if (primitive?.shape === "sphere" || procedural?.generator === "uvSphere") {
        const localCenter = local.min.map((value, axis) => (value + local.max[axis]) / 2);
        const axes = [0, 1, 2].map((axis) => transform.linear.map((row) =>
          row[axis] * (local.max[axis] - local.min[axis]) / 2));
        occluders.push({ entityId, kind: "ellipsoid", center: worldPoint(transform, localCenter),
          axes });
        continue;
      }

      // Only genuine boxes have silhouettes matching their eight bounding corners.
      // Unknown curved/procedural geometry must never erase a phantom rectangle.
      if (primitive?.shape !== "cube") continue;
      const corners = Array.from({ length: 8 }, (_, index) => worldPoint(transform,
        [0, 1, 2].map((axis) =>
          (index & (1 << axis)) === 0 ? local.min[axis] : local.max[axis])));
      occluders.push({ entityId, corners });
    } catch {
      // One unavailable browser-owned asset cannot disable other exact scene occluders.
    }
  }
  return occluders;
}

function environmentEntity(scene) {
  return Object.entries(scene?.entities ?? {}).find(([, entity]) =>
    entity.components?.["oriel.environment"]);
}

export function hexToRgba(value, alpha = 1) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value)) return null;
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
    .concat(clamp(number(alpha, 1), 0, 1));
}

export function rgbaToHex(value) {
  return `#${vector(value, [0.75, 0.78, 0.86]).map((component) =>
    Math.round(clamp(component, 0, 1) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function formatValue(value, precision = 2) {
  if (!Number.isFinite(value)) return "—";
  return String(Number(value.toFixed(precision)));
}

function relativeTime(timestamp) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 8_000) return "just now";
  if (elapsed < 60_000) return `${Math.round(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m ago`;
  return `${Math.round(elapsed / 3_600_000)}h ago`;
}

function statusLabel(value, fallback) {
  if (typeof value === "string") return value;
  if (value?.ready === true) return "Ready";
  if (value?.supported === false || value?.available === false) return "Unavailable";
  return text(value?.message ?? value?.state ?? value?.phase ?? value?.status, fallback);
}

function setText(element, value) {
  if (element) element.textContent = String(value);
}

function setBadge(element, value, fallback = "Waiting") {
  if (!element) return;
  const label = statusLabel(value?.error ?? value, fallback);
  const lower = label.toLowerCase();
  const tone = /ready|connected|registered|active|attached|working|^\d+\s+tools?$/u.test(lower)
    && !/not |unavailable|unsupported|failed|error/u.test(lower) ? "ready"
    : /failed|error|unavailable|unsupported|denied/u.test(lower) ? "error" : "pending";
  const inner = element.querySelector?.("[data-status-value]");
  if (inner) inner.textContent = label;
  else element.textContent = label;
  element.dataset.status = tone;
  element.dataset.state = tone;
  element.setAttribute?.("aria-label", label);
}

function componentChanged(previous, current, name) {
  return JSON.stringify(previous?.components?.[name] ?? null)
    !== JSON.stringify(current?.components?.[name] ?? null);
}

function describeSceneDelta(before, after) {
  const previous = before?.entities ?? {};
  const current = after?.entities ?? {};
  const beforeIds = Object.keys(previous);
  const currentIds = Object.keys(current);
  const added = currentIds.filter((identifier) => !Object.hasOwn(previous, identifier));
  const removed = beforeIds.filter((identifier) => !Object.hasOwn(current, identifier));
  const modified = [];

  for (const identifier of currentIds) {
    if (!Object.hasOwn(previous, identifier)) continue;
    const former = previous[identifier];
    const latest = current[identifier];
    if (former.name !== latest.name || former.parent !== latest.parent) {
      modified.push({ entityId: identifier, entity: latest, change: "composition" });
    } else if (componentChanged(former, latest, "oriel.mesh_modeling")
        || componentChanged(former, latest, "oriel.primitive")) {
      modified.push({ entityId: identifier, entity: latest, change: "geometry" });
    } else if (componentChanged(former, latest, "oriel.material")) {
      modified.push({ entityId: identifier, entity: latest, change: "surface" });
    } else if (componentChanged(former, latest, "oriel.directionalLight")
        || componentChanged(former, latest, "oriel.pointLight")) {
      modified.push({ entityId: identifier, entity: latest, change: "lighting" });
    } else if (componentChanged(former, latest, "oriel.environment")) {
      modified.push({ entityId: identifier, entity: latest, change: "atmosphere" });
    } else if (componentChanged(former, latest, "oriel.camera")) {
      modified.push({ entityId: identifier, entity: latest, change: "camera" });
    } else if (componentChanged(former, latest, "oriel.transform")) {
      modified.push({ entityId: identifier, entity: latest, change: "transform" });
    }
  }

  const fragments = [];
  if (added.length) {
    const first = text(current[added[0]]?.name, "object");
    fragments.push(added.length === 1 ? `Added ${first}` : `Added ${added.length} objects`);
  }
  if (removed.length) fragments.push(removed.length === 1 ? "Removed one object"
    : `Removed ${removed.length} objects`);
  if (modified.length) {
    const first = modified[0];
    const label = { geometry: "reshaped", surface: "restyled", lighting: "relit",
      atmosphere: "updated atmosphere", camera: "reframed", transform: "repositioned",
      composition: "recomposed" }[first.change];
    fragments.push(modified.length === 1 ? `${label} ${text(first.entity.name, "object")}`
      : `${label} ${modified.length} objects`);
  }
  return { added, removed, modified, detail: fragments.join(" · ") || "Scene state updated" };
}

/** Mount the passive, agent-first observation cockpit around the genuine modeling scene. */
export function createStudioUI(options = {}) {
  const root = options.root ?? globalThis.document;
  const document = root?.ownerDocument ?? root;
  if (!root || typeof root.addEventListener !== "function"
      || typeof document?.createElement !== "function") {
    throw new TypeError("The agent observation cockpit requires a document or mounted root.");
  }

  let store = options.store ?? null;
  let runtime = options.runtime ?? null;
  let registrar = options.registrar ?? options.bridge ?? null;
  let canvas = options.canvas ?? root.querySelector?.("#studio-canvas") ?? null;
  let controls = null;
  let unsubscribeStore = null;
  let unsubscribeRuntime = null;
  let unsubscribeRegistrar = null;
  let unsubscribeReferences = null;
  let unsubscribeMaterialAuthoring = null;
  let unsubscribeDeviceCache = null;
  let unsubscribeProjects = null;
  let referenceService = options.referenceService ?? null;
  let materialService = options.materialService ?? null;
  let materialAuthoringService = options.materialAuthoringService ?? null;
  let materialLibraryGeneration = 0;
  let deviceCache = options.deviceCache ?? null;
  let projectController = options.projectController ?? null;
  let deviceCacheBusy = false;
  let projectBusy = false;
  let ownershipTransitionPending = false;
  let ownershipFeedback = "";
  let projectListRequest = 0;
  let previousState = null;
  let previousHierarchy = null;
  let previousSelection = null;
  let gridOcclusionRevision = null;
  let previousGridOccluders = [];
  let agentObserved = false;
  let activeInvocation = null;
  let activeReadOnlyInvocations = 0;
  let callbackOwner = options.owner ?? null;
  let callbackOwnerGeneration = Number.isSafeInteger(options.ownerGeneration)
    ? options.ownerGeneration : null;
  let unresolvedFailure = null;
  let checkpointFailure = null;
  let recoveryRequested = false;
  let rendererRecoveryRequired = false;
  let rendererOperationOutcome = null;
  let rendererRecoveryReason = null;
  let authenticatedOwnerFrameVisible = false;
  let authoritativeOwnerFrame = false;
  let ownerTransition = false;
  let lastRuntimeStatus = null;
  let pendingDownloadBytes = 0;
  let completedInvocations = 0;
  let registeredToolCount = 0;
  let viewerCameraActive = false;
  let pendingCameraPose = null;
  let cameraUpdate = null;
  let pendingOwnerCameraPreview = null;
  let ownerCameraPreview = null;
  let ownerCameraPreviewActive = false;
  let ownerCameraOverrideActive = false;
  let ownerAuthoredCamera = null;
  let presentationRevision = null;
  let presentedRows = [];
  let serial = 0;
  let disposed = false;
  let autoFollowEnabled = true;
  const disclosure = root.getElementById?.("observer-details")
    ?? root.querySelector?.("#observer-details") ?? null;
  const activity = [];
  const activeInvocations = new Map();
  const exports = new Map();
  const byId = (id) => root.getElementById?.(id) ?? root.querySelector?.(`#${id}`) ?? null;
  const browser = document.defaultView ?? globalThis;
  const prefersReducedMotion = () => options.reducedMotion === true
    || options.prefersReducedMotion?.() === true
    || document.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

  function matchesCallbackOwner(value, { allowUnfenced = false } = {}) {
    if (callbackOwner === null && callbackOwnerGeneration === null) return true;
    if (!value || typeof value !== "object") return allowUnfenced;
    if (callbackOwner !== null && value.owner !== callbackOwner) return false;
    if (callbackOwnerGeneration !== null
        && value.ownerGeneration !== callbackOwnerGeneration) return false;
    return true;
  }

  function safeObserverMessage(value, fallback = "", maximum = MAX_OBSERVER_MESSAGE_LENGTH) {
    return observerText(value, fallback, maximum);
  }

  function updateActiveInvocations() {
    activeInvocation = null;
    activeReadOnlyInvocations = 0;
    let mutatingInvocations = 0;
    for (const invocation of activeInvocations.values()) {
      if (invocation.readOnly) activeReadOnlyInvocations += 1;
      else {
        mutatingInvocations += 1;
        activeInvocation = invocation;
      }
    }
    if (mutatingInvocations > 1) activeInvocation = {
      name: "", operation: "Agent scene update", ambiguous: true,
    };
  }

  function presentObserverEvent(event) {
    if (disposed) return;
    const viewport = byId("viewport-stage");
    const signal = byId("presentation-signal");
    const workspace = byId("studio-shell");

    if (event.phase === "completed") {
      if (presentationRevision !== event.revision) return;
      for (const row of presentedRows) row.classList?.toggle("is-just-changed", false);
      presentedRows = [];
      presentationRevision = null;
      if (viewport) {
        viewport.dataset.presentationActive = "false";
        delete viewport.dataset.presentationKind;
      }
      if (workspace) delete workspace.dataset.presentationKind;
      if (signal) {
        signal.dataset.active = "false";
        delete signal.dataset.kind;
      }
      return;
    }

    presentationRevision = event.revision;
    if (event.reducedMotion) return;

    if (viewport) {
      viewport.dataset.presentationActive = "true";
      viewport.dataset.presentationKind = event.kind;
    }
    if (workspace) workspace.dataset.presentationKind = event.kind;
    if (signal) {
      signal.dataset.active = "true";
      signal.dataset.kind = event.kind;
    }

    if (!disclosure || disclosure.open) {
      for (const identifier of event.entityIds) {
        const row = root.querySelector?.(`[data-entity-id='${identifier}']`);
        if (!row) continue;
        row.classList?.toggle("is-just-changed", true);
        presentedRows.push(row);
      }
    }

    if (typeof options.highlight === "function") {
      for (const change of event.changes.slice(0, MAX_NATIVE_HIGHLIGHTS)) {
        if (change.kind === "removed") continue;
        try {
          const result = options.highlight({
            entityId: change.entityId,
            revision: event.revision,
            kind: change.kind,
            ttlMs: 250,
          });
          result?.catch?.(() => {});
        } catch { /* Native annotations are transient, optional observation only. */ }
      }
    }
  }

  const newPresentation = () => createObserverPresentation({
    maxPending: options.presentationMaxPending,
    durationMilliseconds: options.presentationDurationMilliseconds,
    reducedMotion: prefersReducedMotion,
    ...(typeof options.presentationSchedule === "function"
      ? { schedule: options.presentationSchedule } : {}),
    ...(typeof options.presentationCancel === "function"
      ? { cancel: options.presentationCancel } : {}),
    onEvent: presentObserverEvent,
  });
  let presentation = newPresentation();

  function state() {
    try { return store?.getState?.() ?? { scene: { entities: {} }, revision: 0 }; }
    catch { return { scene: { entities: {} }, revision: 0 }; }
  }

  function scene() {
    return state().scene ?? store?.getScene?.() ?? { entities: {} };
  }

  function report(message, { error = false } = {}) {
    const status = byId("status-message");
    if (status) {
      status.textContent = text(message, error ? "The requested observation failed." : "Ready.");
      status.dataset.status = error ? "error" : "ready";
      status.setAttribute?.("role", error ? "alert" : "status");
    }
    if (typeof options.status === "function") {
      try { options.status({ message: text(message), error }); }
      catch { /* reporting is optional and never grants scene-write authority */ }
    }
  }

  function perform(task, success) {
    try {
      return Promise.resolve(task()).then((value) => {
        if (success && !disposed) report(success);
        return value;
      }).catch((error) => {
        if (!disposed) report(text(error?.message, "The requested action failed."), { error: true });
        return null;
      });
    } catch (error) {
      report(text(error?.message, "The requested action failed."), { error: true });
      return Promise.resolve(null);
    }
  }

  function updateDeviceCache(value) {
    const current = value ?? deviceCache?.status?.() ?? null;
    let ownership = null;
    try { ownership = projectController?.projectStatus?.() ?? null; }
    catch { /* Existing project controls remain useful without an ownership provider. */ }
    const phase = current?.phase ?? ownership?.phase
      ?? (deviceCache ? "ephemeral" : "unavailable");
    const acquiring = ownershipTransitionPending || phase === "acquiring"
      || phase === "acquiring-project" || ownership?.phase === "acquiring"
      || ownership?.navigationPending === true && ownership?.readOnly === true;
    const navigationPending = projectBusy || acquiring || ownership?.navigationPending === true;
    const enabled = current?.enabled === true && !acquiring;
    const readOnly = acquiring || ownership?.readOnly === true || current?.readOnly === true
      || phase === "readonly" || phase === "competing-tab";
    const consented = ownership?.consented ?? current?.consented;
    const canNavigateProjects = (enabled || readOnly && consented === true) && !navigationPending;
    const canAcquire = typeof projectController?.acquireProject === "function"
      && readOnly && consented === true && ownership?.recoveryRequired !== true
      && (ownership?.canAttemptAcquire !== false || acquiring);
    const unavailable = !deviceCache || phase === "unavailable";
    const saveRecovered = phase === "saved" && !readOnly;
    const saveInProgress = phase === "saving" || phase === "retrying"
      || phase === "reclaiming" || phase === "evicting";
    const saveFailed = !readOnly && !saveRecovered && !saveInProgress
      && (phase === "quota-exceeded" || current?.error && typeof current.error === "object");
    if (saveRecovered && checkpointFailure !== null) {
      const previousFailure = checkpointFailure.message;
      checkpointFailure = null;
      renderObserverFailure();
      const previousStatus = byId("status-message");
      if (previousStatus?.dataset.status === "error"
          && previousStatus.textContent.includes(previousFailure)) {
        report("Project saved locally.");
      }
    }
    const label = acquiring ? "Acquiring editing access…"
      : phase === "saved" ? "Saved on this device"
      : phase === "saving" ? "Saving automatically…"
        : phase === "retrying" ? "Retrying automatic save…"
          : phase === "reclaiming" || phase === "evicting" ? "Making room to save…"
        : phase === "restoring" ? "Opening saved project…"
          : phase === "clearing" ? "Clearing saved data…"
            : readOnly ? "Read-only · another tab"
              : phase === "quota-exceeded" ? "Device storage limit reached"
                : saveFailed ? `Save failed · ${text(current.error?.message, "Device storage could not save the scene.")}`
                : enabled ? "Saving automatically"
                  : unavailable ? "Unavailable on this device" : "Off";
    const status = byId("device-cache-status");
    setText(status, label);
    const explanation = acquiring
      ? "Checking whether this tab can safely edit the latest saved project."
      : readOnly
        ? canAcquire
          ? "This tab is read-only. Another tab had editing access. If that tab has closed, choose Edit here."
          : "This tab is read-only. Another tab had editing access."
      : phase === "quota-exceeded"
        ? "Device storage is full. Older projects are removed automatically, or you can delete a saved project to free space."
      : enabled && Number.isSafeInteger(current?.evictedProjectCount)
          && current.evictedProjectCount > 0
        ? `Saved after removing ${current.evictedProjectCount} older ${current.evictedProjectCount === 1 ? "project" : "projects"} to free device storage.`
      : enabled ? "Your projects are saved automatically on this device."
        : unavailable ? "Saving is unavailable on this device."
          : "Turn on saving to keep your projects on this device.";
    setText(byId("device-cache-description"), explanation);
    if (status) status.dataset.state = acquiring ? "acquiring" : readOnly ? "readonly"
      : saveFailed || /unavailable|quota/u.test(phase) ? "error"
        : enabled ? phase : "disabled";
    const prominent = byId("project-persistence-status");
    if (prominent) {
      prominent.textContent = acquiring ? "Acquiring…" : readOnly ? "Read-only"
        : phase === "quota-exceeded" ? "Storage full"
          : saveFailed ? "Save failed"
            : enabled ? phase === "saved" ? "Saved locally" : "Saving…"
              : unavailable ? "Saving unavailable" : "Not saved";
      prominent.dataset.state = acquiring ? "acquiring" : readOnly ? "readonly"
        : saveFailed || /unavailable|quota/u.test(phase) ? "error"
          : enabled ? phase === "saved" ? "saved" : "enabled" : "disabled";
      prominent.setAttribute?.("aria-label", acquiring
        ? "Acquiring editing access for this saved project"
        : readOnly
          ? canAcquire
            ? "This tab is read-only. Another tab had editing access. Open project controls and choose Edit here if that tab has closed."
            : "This tab is read-only. Another tab had editing access."
        : phase === "quota-exceeded"
          ? "Device storage is full. Open project controls to remove an older saved project."
        : saveFailed
          ? text(current?.error?.message, "The project could not be saved on this device")
          : enabled && phase === "saved"
            ? "Project is saved on this device"
            : enabled ? "Project is being saved on this device"
              : "Project is not saved. Open project settings to turn on local saving");
    }
    const announcement = byId("project-ownership-status");
    if (announcement) setText(announcement, ownershipFeedback || (acquiring || readOnly
      ? explanation : ""));
    for (const button of root.querySelectorAll?.("[data-action='device-cache-enable']") ?? []) {
      button.disabled = unavailable || deviceCacheBusy || navigationPending || enabled || readOnly;
      button.hidden = enabled || readOnly;
    }
    for (const button of root.querySelectorAll?.("[data-action='device-cache-disable']") ?? []) {
      button.disabled = unavailable || deviceCacheBusy || navigationPending || !enabled || readOnly;
      button.hidden = !enabled || readOnly;
    }
    for (const button of root.querySelectorAll?.("[data-action='device-cache-clear']") ?? []) {
      button.disabled = unavailable || deviceCacheBusy || navigationPending || readOnly;
    }
    for (const button of root.querySelectorAll?.("[data-action='project-acquire']") ?? []) {
      button.hidden = !canAcquire;
      button.disabled = !canAcquire || navigationPending || deviceCacheBusy;
      button.textContent = acquiring ? "Checking editing access…" : "Edit here";
    }
    for (const button of root.querySelectorAll?.("[data-action='project-create']") ?? []) {
      button.disabled = !projectController || unavailable || !canNavigateProjects || projectBusy;
    }
    for (const button of root.querySelectorAll?.("[data-action='project-open']") ?? []) {
      button.disabled = !projectController || unavailable || !canNavigateProjects || projectBusy
        || button.dataset.projectActive === "true";
    }
    for (const button of root.querySelectorAll?.("[data-action='project-delete']") ?? []) {
      button.disabled = typeof projectController?.deleteProject !== "function" || unavailable
        || !enabled || readOnly || navigationPending || deviceCacheBusy
        || button.dataset.projectActive === "true";
    }
    for (const button of root.querySelectorAll?.("[data-action='owner-import-model']") ?? []) {
      button.disabled = typeof options.importAsset !== "function" || readOnly || navigationPending;
    }
    for (const button of root.querySelectorAll?.("[data-action='owner-load-example']") ?? []) {
      button.disabled = typeof options.loadExample !== "function" || readOnly || navigationPending;
    }
    return current;
  }

  function currentProject() {
    try {
      return projectController?.getActiveProject?.()
        ?? projectController?.getCurrentProject?.() ?? null;
    } catch {
      return null;
    }
  }

  function updateProject(value = currentProject()) {
    const project = value?.project ?? value;
    setText(byId("project-name"), text(project?.displayName ?? project?.name, "Untitled project"));
    const available = Boolean(projectController);
    for (const button of root.querySelectorAll?.("[data-action='project-new']") ?? []) {
      button.disabled = !available || projectBusy || ownershipTransitionPending;
    }
    updateDeviceCache();
    return project;
  }

  function projectUpdatedLabel(project) {
    const value = project?.updatedAt ?? project?.createdAt;
    if (!value) return project?.active ? "Current project" : "Saved on this device";
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) {
      return project?.active ? "Current project" : "Saved on this device";
    }
    try {
      const date = new Intl.DateTimeFormat(undefined,
        { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(instant);
      return project?.active ? `Current project · ${date}` : `Updated ${date}`;
    } catch {
      return project?.active ? "Current project" : "Saved on this device";
    }
  }

  async function refreshProjects() {
    const container = byId("project-list");
    const status = byId("project-list-status");
    if (!container) return [];
    if (typeof projectController?.listProjects !== "function") {
      container.replaceChildren?.();
      setText(status, "Unavailable");
      return [];
    }

    const request = ++projectListRequest;
    setText(status, "Loading…");
    try {
      const response = await projectController.listProjects();
      if (disposed || request !== projectListRequest) return [];
      const projects = Array.isArray(response) ? response
        : Array.isArray(response?.projects) ? response.projects : [];
      const active = currentProject();
      const activeId = text(active?.projectId ?? active?.id);
      const fragment = document.createDocumentFragment?.() ?? document.createElement("div");
      for (const project of projects) {
        const identifier = text(project?.projectId ?? project?.id);
        if (!identifier) continue;
        const selected = project.active === true || identifier === activeId;
        const displayName = text(project.displayName ?? project.name, "Untitled project");
        const row = document.createElement("button");
        row.type = "button";
        row.className = "project-row";
        row.dataset.action = "project-open";
        row.dataset.projectId = identifier;
        row.dataset.projectActive = String(selected);
        if (selected) row.setAttribute("aria-current", "true");

        const name = document.createElement("span");
        name.className = "project-row-name";
        name.textContent = displayName;
        const detail = document.createElement("span");
        detail.className = "project-row-detail";
        detail.textContent = projectUpdatedLabel({ ...project, active: selected });
        row.append(name, detail);
        if (typeof projectController.deleteProject === "function") {
          const item = document.createElement("div");
          item.className = "project-create-row";
          item.setAttribute("role", "listitem");
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "text-link";
          remove.dataset.action = "project-delete";
          remove.dataset.projectId = identifier;
          remove.dataset.projectName = displayName;
          remove.dataset.projectActive = String(selected);
          remove.textContent = "Delete";
          remove.setAttribute("aria-label", `Delete saved project ${displayName}`);
          if (selected) {
            remove.disabled = true;
            remove.setAttribute("title", "Open a different project before deleting this project.");
          }
          item.append(row, remove);
          fragment.append(item);
        } else {
          row.setAttribute("role", "listitem");
          fragment.append(row);
        }
      }
      container.replaceChildren(fragment);
      setText(status, projects.length ? `${projects.length} saved` : "No saved projects");
      updateDeviceCache();
      return projects;
    } catch (error) {
      if (!disposed && request === projectListRequest) {
        container.replaceChildren?.();
        setText(status, "Unable to load");
        report(text(error?.message, "Saved projects could not be listed."), { error: true });
      }
      return [];
    }
  }

  function showProjects({ create = false } = {}) {
    const dialog = byId("project-dialog");
    if (!dialog) return;
    dialog.hidden = false;
    for (const button of root.querySelectorAll?.("[data-action='project-open-dialog']") ?? []) {
      button.setAttribute?.("aria-expanded", "true");
    }
    if (create) byId("project-name-input")?.focus?.();
    updateProject();
    return refreshProjects();
  }

  function hideProjects() {
    const dialog = byId("project-dialog");
    if (!dialog) return;
    dialog.hidden = true;
    for (const button of root.querySelectorAll?.("[data-action='project-open-dialog']") ?? []) {
      button.setAttribute?.("aria-expanded", "false");
    }
  }

  function dismissOutsidePanels(event) {
    const target = event?.target;
    if (!target) return;
    const action = target.closest?.("[data-action]")?.dataset?.action;
    const projectTrigger = action === "project-open-dialog" || action === "project-new";
    const dialog = byId("project-dialog");
    if (dialog?.hidden === false && !projectTrigger
        && target !== dialog && dialog.contains?.(target) !== true) {
      hideProjects();
    }
    if (disclosure?.open && target !== disclosure
        && disclosure.contains?.(target) !== true) {
      disclosure.open = false;
    }
  }

  function changeProject(action, identifier) {
    if (projectBusy || ownershipTransitionPending) return;
    if (!projectController) {
      return report("Project management is unavailable in this browser.", { error: true });
    }
    const persistence = deviceCache?.status?.();
    const readOnly = persistence?.readOnly === true
      || ["readonly", "competing-tab"].includes(persistence?.phase);
    if (persistence?.enabled !== true && !(readOnly && persistence?.consented === true)) {
      showProjects({ create: action === "create" });
      return report("Turn on local saving to create or open projects.", { error: true });
    }
    const name = text(byId("project-name-input")?.value);
    if (action === "create" && (!name || name.length > 80)) {
      return report("Enter a project name of up to 80 characters.", { error: true });
    }
    if (action === "open" && !text(identifier)) {
      return report("Choose a saved project to open.", { error: true });
    }
    const operation = action === "create" ? projectController.createProject
      : projectController.openProject;
    if (typeof operation !== "function") {
      return report("That project action is unavailable in this browser.", { error: true });
    }
    projectBusy = true;
    updateProject();
    return perform(async () => {
      try {
        const result = await operation.call(projectController,
          action === "create" ? { name } : { projectId: identifier });
        updateProject(result);
        if (action === "create") {
          const input = byId("project-name-input");
          if (input) input.value = "";
        }
        return result;
      } finally {
        projectBusy = false;
        updateProject();
      }
    }, action === "create" ? `Opening ${name}.` : "Opening saved project.");
  }

  function deleteProject(identifier, displayName) {
    if (projectBusy || ownershipTransitionPending || deviceCacheBusy) return;
    const operation = projectController?.deleteProject;
    const persistence = deviceCache?.status?.();
    let ownership = null;
    try { ownership = projectController?.projectStatus?.() ?? null; }
    catch { /* Refuse to bypass the existing device-local ownership checks below. */ }
    const readOnly = ownership?.readOnly === true || persistence?.readOnly === true
      || ["readonly", "competing-tab", "acquiring", "acquiring-project"]
        .includes(persistence?.phase);
    if (typeof operation !== "function" || persistence?.enabled !== true || readOnly
        || ownership?.navigationPending === true) {
      return report("This saved project cannot be deleted while editing access is unavailable.",
        { error: true });
    }
    const projectId = text(identifier);
    const active = currentProject();
    if (!projectId || projectId === text(active?.projectId ?? active?.id)) {
      return report("Open a different project before deleting the current project.",
        { error: true });
    }
    const confirm = typeof options.confirm === "function" ? options.confirm : browser.confirm;
    if (typeof confirm !== "function") {
      return report("Deleting a saved project requires confirmation in this browser.",
        { error: true });
    }
    const name = text(displayName, "Untitled project");
    let confirmed;
    try {
      confirmed = confirm.call(browser,
        `Delete saved project “${name}”? This cannot be undone.`) === true;
    } catch {
      return report("The saved project could not be deleted because confirmation was unavailable.",
        { error: true });
    }
    if (!confirmed) return false;

    projectBusy = true;
    updateProject();
    return perform(async () => {
      try {
        const result = await operation.call(projectController, { projectId, confirm: true });
        if (disposed) return result;
        updateProject();
        if (byId("project-dialog")?.hidden === false) {
          await refreshProjects();
          if (!disposed) byId("project-name-input")?.focus?.({ preventScroll: true });
        }
        if (!disposed) {
          if (result?.saveError) {
            report(`Deleted ${name}, but the current project still could not be saved: ${text(
              result.saveError.message, "Device storage remains full.")}`, { error: true });
          } else report(`Deleted ${name}.`);
        }
        return result;
      } finally {
        projectBusy = false;
        if (!disposed) updateProject();
      }
    });
  }

  function acquireProject() {
    if (projectBusy || ownershipTransitionPending) return;
    const operation = projectController?.acquireProject;
    const persistence = deviceCache?.status?.();
    let ownership = null;
    try { ownership = projectController?.projectStatus?.() ?? null; }
    catch { /* Existing consent and reader state remain the safe fallback. */ }
    const consented = ownership?.consented ?? persistence?.consented;
    const readOnly = ownership?.readOnly === true || persistence?.readOnly === true
      || ["readonly", "competing-tab"].includes(persistence?.phase);
    if (typeof operation !== "function" || consented !== true || !readOnly
        || ownership?.canAttemptAcquire === false || ownership?.recoveryRequired === true) {
      return report("Editing access cannot be acquired for this project.", { error: true });
    }

    projectBusy = true;
    ownershipTransitionPending = true;
    ownershipFeedback = "Checking whether this tab can safely edit the latest saved project.";
    updateProject();
    return Promise.resolve().then(() => operation.call(projectController)).then((result) => {
      if (disposed) return null;
      projectBusy = false;
      ownershipTransitionPending = false;
      ownershipFeedback = "Editing access acquired. This tab can now edit the latest saved project.";
      updateProject(result);
      hideProjects();
      byId("project-persistence-status")?.focus?.({ preventScroll: true });
      report("Editing access acquired for this project.");
      return result;
    }).catch((error) => {
      if (disposed) return null;
      projectBusy = false;
      ownershipTransitionPending = false;
      const message = error?.code === "LOCK_UNAVAILABLE"
        ? "Editing is still active in another tab. Close that tab, then try Edit here again."
        : text(error?.message, "Editing access could not be acquired for this project.");
      ownershipFeedback = message;
      updateProject();
      report(message, { error: true });
      return null;
    });
  }

  function updateOwnerActions() {
    const available = typeof options.importAsset === "function";
    for (const button of root.querySelectorAll?.("[data-action='owner-import-model']") ?? []) {
      button.disabled = !available;
    }
    for (const button of root.querySelectorAll?.("[data-action='owner-load-example']") ?? []) {
      button.hidden = typeof options.loadExample !== "function";
      button.disabled = button.hidden;
    }
    updateDeviceCache();
  }

  function renderTree(current, selection) {
    const container = byId("scene-tree");
    if (!container) return;
    const entities = current.scene?.entities ?? {};
    const children = new Map();
    for (const [identifier, entity] of Object.entries(entities)) {
      const parent = entity.parent && Object.hasOwn(entities, entity.parent) ? entity.parent : null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push([identifier, entity]);
    }
    const fragment = document.createDocumentFragment?.() ?? document.createElement("div");
    const rendered = new Set();

    function append(parent, depth = 0) {
      for (const [identifier, entity] of children.get(parent) ?? []) {
        if (rendered.has(identifier)) continue;
        rendered.add(identifier);
        const kind = entityKind(entity);
        const item = document.createElement("div");
        item.className = "scene-tree-item";
        const row = document.createElement("button");
        row.type = "button";
        row.className = `scene-tree-row${identifier === selection ? " is-selected" : ""}`;
        row.dataset.entityId = identifier;
        row.dataset.depth = String(Math.min(depth, 12));
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-selected", String(identifier === selection));
        row.setAttribute("aria-level", String(depth + 1));
        const icon = document.createElement("span");
        icon.className = "scene-tree-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = entityIcon(kind);
        const copy = document.createElement("span");
        copy.className = "scene-tree-copy";
        const name = document.createElement("span");
        name.className = "scene-tree-name";
        name.textContent = text(entity.name, "Untitled");
        const subtitle = document.createElement("span");
        subtitle.className = "scene-tree-kind";
        subtitle.textContent = kind;
        copy.append(name, subtitle);
        row.append(icon, copy);
        item.append(row);
        fragment.append(item);
        append(identifier, depth + 1);
      }
    }

    append(null);
    for (const [identifier, entity] of Object.entries(entities)) {
      if (!rendered.has(identifier)) {
        if (!children.has(null)) children.set(null, []);
        children.get(null).push([identifier, entity]);
      }
    }
    append(null);
    container.replaceChildren(fragment);
    container.setAttribute?.("role", "tree");
  }

  function readout(element, value) {
    if (!element) return;
    const displayed = value === null || value === undefined || value === "" ? "—" : String(value);
    element.textContent = displayed;
    element.dataset.value = displayed;
  }

  function updateInspector(current, selection) {
    const entity = current.scene?.entities?.[selection] ?? null;
    const components = entity?.components ?? {};
    const transform = components["oriel.transform"] ?? {};
    const material = components["oriel.material"] ?? {};
    const light = components["oriel.pointLight"] ?? components["oriel.directionalLight"] ?? {};
    const camera = components["oriel.camera"] ?? {};
    const environment = environmentEntity(current.scene)?.[1]?.components?.["oriel.environment"] ?? {};

    const sceneName = text(current.scene?.name, "Live asset");
    setText(byId("selection-name"), entity ? text(entity.name, "Untitled") : sceneName);
    setText(byId("selection-title"), entity ? text(entity.name, "Untitled") : sceneName);
    setText(byId("selection-kind"), entity ? entityKind(entity) : "Select an object to inspect its authored state.");
    const empty = byId("selection-empty");
    if (empty) empty.hidden = Boolean(entity);
    const panel = byId("inspector-panel");
    if (panel) panel.dataset.hasSelection = String(Boolean(entity));

    if (disclosure && !disclosure.open) return;

    for (const element of root.querySelectorAll?.("[data-readout]") ?? []) {
      const property = element.dataset.readout;
      let value = null;
      if (/^(?:position|rotation|scale)\.[xyz]$/u.test(property)) {
        const [group, axis] = property.split(".");
        const key = { position: "translation", rotation: "rotationDegrees", scale: "scale" }[group];
        const fallback = group === "scale" ? [1, 1, 1] : [0, 0, 0];
        value = entity ? formatValue(vector(transform[key], fallback)[AXIS_INDEX[axis]]) : null;
      } else if (property === "material.color") {
        value = components["oriel.material"] ? rgbaToHex(material.baseColor) : null;
      } else if (property === "material.metalness") {
        value = components["oriel.material"] ? formatValue(number(material.metallic), 2) : null;
      } else if (property === "material.roughness") {
        value = components["oriel.material"] ? formatValue(number(material.perceptualRoughness, 0.5), 2) : null;
      } else if (property === "material.emissive") {
        value = components["oriel.material"] ? rgbaToHex(material.emissiveFactor ?? [0, 0, 0]) : null;
      } else if (property === "light.color") {
        value = components["oriel.pointLight"] || components["oriel.directionalLight"]
          ? rgbaToHex(light.color ?? [1, 1, 1]) : null;
      } else if (property === "light.intensity") {
        value = components["oriel.pointLight"] || components["oriel.directionalLight"]
          ? `${formatValue(number(light.intensity ?? light.illuminance), 0)} lm` : null;
      } else if (property === "camera.fov") {
        value = components["oriel.camera"]
          ? `${formatValue(number(camera.perspective?.verticalFovDegrees, 45), 0)}°` : null;
      } else if (property === "environment.time") {
        value = `${formatValue(number(environment.clock?.phaseHours, 12), 1)} h`;
      } else if (property === "environment.cloudCoverage") {
        value = `${formatValue(number(environment.cloudCoverage) * 100, 0)}%`;
      } else if (property === "environment.exposure") {
        value = `${formatValue(number(environment.exposureCompensationEv), 1)} EV`;
      }
      readout(element, value);
    }
  }

  function updateSummary(current = state()) {
    const revision = current.revision ?? store?.getRevision?.() ?? 0;
    const entities = current.scene?.entities ?? {};
    const modeled = Object.values(entities).filter((entity) =>
      entity.components?.["oriel.mesh_modeling"] || entity.components?.["oriel.primitive"]).length;
    setText(byId("object-count"), String(Object.keys(entities).length));
    setText(byId("scene-revision"), `r${revision}`);
    setText(byId("tool-count"), String(registeredToolCount));
    if (agentObserved) {
      const segments = [`${completedInvocations} ${completedInvocations === 1 ? "tool call" : "tool calls"}`,
        `revision ${revision}`, `${modeled} ${modeled === 1 ? "asset" : "assets"}`];
      setText(byId("agent-summary"), segments.join(" · "));
      const running = activeInvocations.size;
      setText(byId("agent-progress"), `${completedInvocations} completed`
        + (running > 0 ? ` · ${running} running` : ""));
    } else {
      setText(byId("agent-summary"), "No agent has attached yet.");
      setText(byId("agent-progress"), "—");
    }
    if (exports.size === 0) {
      setText(byId("artifact-status"), modeled
        ? `${modeled} ${modeled === 1 ? "scene asset" : "scene assets"} · no pending downloads`
        : "No exported artifacts yet");
    } else {
      setText(byId("artifact-status"), `${exports.size} ${exports.size === 1 ? "artifact is" : "artifacts are"} ready to download`);
    }
  }

  function render(current = state()) {
    if (disposed) return;
    const selection = selectedEntity(current);
    const entities = current.scene?.entities ?? {};
    if (!disclosure || disclosure.open) {
      const hierarchy = JSON.stringify(Object.entries(entities).map(([identifier, entity]) =>
        [identifier, entity.parent ?? null, entity.name ?? "", entityKind(entity)]));
      if (hierarchy !== previousHierarchy || selection !== previousSelection) {
        renderTree(current, selection);
        previousHierarchy = hierarchy;
        previousSelection = selection;
      }
    }
    updateInspector(current, selection);
    updateSummary(current);
    for (const button of root.querySelectorAll?.("[data-action='export-glb']") ?? []) {
      button.disabled = !selection || !entities[selection]?.components?.["oriel.mesh_modeling"];
    }
  }

  function renderObserverFailure() {
    const failure = byId("observer-failure");
    if (failure) failure.hidden = unresolvedFailure === null;
    setText(byId("observer-failure-message"), unresolvedFailure?.message ?? "");
    const checkpoint = byId("observer-checkpoint-failure");
    if (checkpoint) {
      checkpoint.hidden = checkpointFailure === null;
      setText(checkpoint, checkpointFailure
        ? `Scene committed · local save failed: ${checkpointFailure.message}` : "");
    }
    const recovery = byId("observer-recovery-action");
    if (recovery) {
      recovery.hidden = !rendererRecoveryRequired
        && unresolvedFailure?.unknownOutcome !== true
        && unresolvedFailure?.recoveryRequired !== true;
      recovery.disabled = recoveryRequested;
      recovery.textContent = recoveryRequested ? "Recovering…" : "Recover renderer";
      recovery.setAttribute?.("aria-busy", String(recoveryRequested));
    }
    if (unresolvedFailure) {
      setBadge(byId("agent-bridge-status"), unresolvedFailure.unknownOutcome
        ? "Agent outcome unknown" : unresolvedFailure.recoveryRequired
          ? "Renderer recovery required" : "Agent error");
      setText(byId("agent-current-step"), unresolvedFailure.unknownOutcome
        ? "Operation outcome unknown · recovery required"
        : unresolvedFailure.operationOutcome === "applied_uncommitted"
          ? "Renderer applied update; restoring last committed model"
          : unresolvedFailure.recoveryRequired ? "Recovering renderer"
            : "The agent encountered an error");
      setText(byId("agent-last-result"), unresolvedFailure.message);
      const transaction = byId("agent-transaction-state");
      if (transaction) {
        transaction.textContent = unresolvedFailure.unknownOutcome
          ? "Outcome unknown" : unresolvedFailure.operationOutcome === "applied_uncommitted"
            ? "Applied · not committed" : unresolvedFailure.recoveryRequired
              ? "Recovery required" : "Failed";
        transaction.dataset.state = unresolvedFailure.unknownOutcome
          ? "reconciliation-required" : unresolvedFailure.recoveryRequired
            ? "recovery-required" : "failed";
      }
    } else if (rendererRecoveryRequired) {
      setBadge(byId("agent-bridge-status"), "Renderer recovery required");
      setText(byId("agent-current-step"), rendererOperationOutcome === "applied_uncommitted"
        ? "Renderer applied update; restoring last committed model" : "Recovering renderer");
    }
  }

  function renderActivityHistory() {
    const history = byId("observer-activity-history");
    if (!history || disclosure && !disclosure.open) return;
    const fragment = document.createDocumentFragment?.() ?? document.createElement("div");
    for (const entry of activity) {
      const item = document.createElement("li");
      item.className = `observer-history-entry activity-${entry.status}`;
      item.dataset.status = entry.status;
      item.textContent = `${entry.name} · ${entry.detail}`;
      fragment.append(item);
    }
    history.replaceChildren(fragment);
  }

  function renderActivity() {
    const list = byId("tool-activity");
    if (!list) return;
    const fragment = document.createDocumentFragment?.() ?? document.createElement("div");
    const [pendingExportId, pendingArtifact] = exports.entries().next().value ?? [];
    const visibleEntry = pendingArtifact
      ? activity.find((entry) => entry.exportId === pendingExportId) ?? {
        name: pendingArtifact.fileName,
        status: "queued",
        detail: "Ready for explicit download",
        source: "Export",
        timestamp: Date.now(),
        exportId: pendingExportId,
      }
      : activity.find((entry) => !entry.exportId);
    if (!visibleEntry) {
      const placeholder = document.createElement("li");
      placeholder.className = "activity-empty";
      placeholder.textContent = "Waiting for an agent to invoke its first browser-local modeling tool.";
      fragment.append(placeholder);
    }
    // Keep the gallery to one line, without letting a newer tool completion
    // hide an artifact that still needs its explicit user download.
    for (const entry of visibleEntry ? [visibleEntry] : []) {
      const item = document.createElement("li");
      item.className = `activity-entry activity-${entry.status}`;
      item.dataset.status = entry.status;
      const name = document.createElement("span");
      name.className = "activity-name";
      name.textContent = entry.name;
      const detail = document.createElement("span");
      detail.className = "activity-detail";
      detail.textContent = entry.detail;
      detail.setAttribute("aria-label", `${entry.source} · ${relativeTime(entry.timestamp)}`);
      item.append(name, detail);
      if (entry.exportId && exports.has(entry.exportId)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "activity-download";
        button.dataset.action = "download-export";
        button.dataset.exportId = entry.exportId;
        button.textContent = `Download ${exports.get(entry.exportId).fileName}`;
        item.append(button);
      }
      fragment.append(item);
    }
    list.replaceChildren(fragment);
    renderActivityHistory();
  }

  function toolLabel(name, operation) {
    return safeObserverMessage(TOOL_LABELS[name], safeObserverMessage(operation,
      safeObserverMessage(name, "Observing scene")));
  }

  function actionableObserverFailure(error, fallback) {
    const message = safeObserverMessage(error?.message ?? error, fallback);
    const repair = safeObserverMessage(error?.details?.repair ?? error?.repair
      ?? error?.details?.suggestion ?? error?.suggestion, "", 120);
    if (!repair || message.includes(repair)) return message;
    return safeObserverMessage(`${message} · Next: ${repair}`);
  }

  function eventDetail(event, fallback) {
    const pieces = [];
    const detail = event.error
      ? actionableObserverFailure(event.error, safeObserverMessage(event.detail, fallback))
      : safeObserverMessage(event.detail);
    if (detail) pieces.push(detail);
    const revision = event.revision;
    if (Number.isSafeInteger(revision)) pieces.push(`r${revision}`);
    const vertices = event.vertexCount ?? event.mesh?.vertexCount;
    const faces = event.faceCount ?? event.mesh?.faceCount;
    if (Number.isSafeInteger(vertices)) pieces.push(`${vertices} vertices`);
    if (Number.isSafeInteger(faces)) pieces.push(`${faces} faces`);
    if (Number.isFinite(event.durationMilliseconds)) {
      pieces.push(`${Math.round(event.durationMilliseconds)} ms`);
    }
    return safeObserverMessage(pieces.length ? pieces.join(" · ") : fallback);
  }

  function addActivity(event) {
    if (!event || typeof event !== "object" || disposed
        || event.source !== "Export" && !matchesCallbackOwner(event)) return false;
    const timestamp = Number.isFinite(event.at) ? event.at
      : Number.isFinite(Date.parse(event.at)) ? Date.parse(event.at) : Date.now();
    const unknownOutcome = event.unknownOutcome === true
      || event.error?.unknownOutcome === true
      || event.operationOutcome === "unknown"
      || event.error?.operationOutcome === "unknown";
    const status = unknownOutcome ? "failed"
      : ["started", "completed", "failed", "aborted", "queued"].includes(event.status)
      ? event.status : "completed";
    const label = toolLabel(event.name, event.operation);
    const readOnly = event.readOnly === true || event.name === "scene_preflight_batch";
    const invocationId = safeObserverMessage(event.invocationId, "", 96);
    const validation = event.name === "scene_preflight_batch";
    const acquisition = event.name === "project_acquire";
    if (acquisition) {
      ownershipTransitionPending = status === "started";
      if (status === "completed") {
        ownershipFeedback = "Editing access acquired. This tab can now edit the latest saved project.";
      } else if (status === "failed" && event.error?.code === "LOCK_UNAVAILABLE") {
        ownershipFeedback = "Editing is still active in another tab. Close that tab, then try Edit here again.";
      }
      updateProject();
    }
    const fallback = status === "started" ? "Running in the browser"
      : status === "completed" ? "Completed against the live scene"
        : status === "failed" ? actionableObserverFailure(event.error,
          unknownOutcome ? "Operation outcome unknown. Recover the renderer to continue."
            : "Tool invocation failed")
          : status === "aborted" ? "Invocation cancelled" : "Waiting for your download";

    if (event.source !== "Export") {
      agentObserved = true;
      if (status === "started") {
        const key = invocationId || `legacy-${++serial}`;
        if (activeInvocations.size >= MAX_ACTIVE_INVOCATIONS) {
          activeInvocations.delete(activeInvocations.keys().next().value);
        }
        activeInvocations.set(key, {
          invocationId: key,
          name: safeObserverMessage(event.name),
          operation: safeObserverMessage(event.operation),
          readOnly,
        });
        updateActiveInvocations();
        if (!unresolvedFailure && (!readOnly || !activeInvocation)) {
          setText(byId("agent-current-step"), label);
          setText(byId("agent-transaction-state"), "Running");
          if (byId("agent-transaction-state")) byId("agent-transaction-state").dataset.state = "running";
          setBadge(byId("agent-bridge-status"), "An agent is working");
        }
      } else {
        if (status === "completed") completedInvocations += 1;
        if (invocationId) activeInvocations.delete(invocationId);
        else {
          const legacy = [...activeInvocations.entries()].find(([, value]) =>
            value.name === event.name && value.readOnly === readOnly);
          if (legacy) activeInvocations.delete(legacy[0]);
        }
        updateActiveInvocations();
        if (status === "failed") {
          const recoveryRequired = unknownOutcome || event.recoveryRequired === true
            || event.error?.recoveryRequired === true;
          unresolvedFailure = {
            invocationId: invocationId || null,
            code: safeObserverMessage(event.error?.code,
              unknownOutcome ? "RECONCILIATION_REQUIRED" : "INVOCATION_FAILED"),
            message: eventDetail(event, fallback),
            unknownOutcome,
            recoveryRequired,
            operationOutcome: text(event.operationOutcome
              ?? event.error?.operationOutcome) || null,
          };
          if (recoveryRequired) {
            rendererRecoveryRequired = true;
            rendererOperationOutcome = unresolvedFailure.operationOutcome
              ?? (unknownOutcome ? "unknown" : null);
          }
        } else if (status === "completed" && (!readOnly || !activeInvocation)
            && unresolvedFailure?.unknownOutcome !== true
            && unresolvedFailure?.recoveryRequired !== true
            && !rendererRecoveryRequired) {
          unresolvedFailure = null;
        }
        if (!unresolvedFailure && (!readOnly || !activeInvocation)) {
          const transaction = byId("agent-transaction-state");
          if (transaction) {
            transaction.textContent = status === "failed" ? "Failed"
              : status === "aborted" ? "Cancelled" : validation ? "Validated"
                : acquisition ? "Access granted"
                  : readOnly ? "Observed"
                  : Number.isSafeInteger(event.revision) ? `Applied · r${event.revision}`
                    : "Applied";
            transaction.dataset.state = status === "failed" ? "failed"
              : status === "aborted" ? "cancelled" : validation ? "validated"
                : acquisition ? "acquired" : readOnly ? "observed" : "applied";
          }
          setText(byId("agent-current-step"), status === "failed"
            ? "The agent encountered an error" : "Waiting for the next agent operation");
          setBadge(byId("agent-bridge-status"), status === "failed" ? "Agent error" : "Agent attached");
        }
        if (!unresolvedFailure) setText(byId("agent-last-result"), eventDetail(event, fallback));
      }
    }

    activity.unshift({
      name: label,
      status,
      detail: eventDetail(event, fallback),
      source: safeObserverMessage(event.source, "Codex · WebMCP"),
      timestamp,
      exportId: event.exportId ?? null,
      ...(invocationId ? { invocationId } : {}),
      ...(status === "failed" ? {
        errorCode: safeObserverMessage(event.error?.code, "INVOCATION_FAILED"),
      } : {}),
    });
    if (activity.length > MAX_ACTIVITY_ENTRIES) activity.splice(MAX_ACTIVITY_ENTRIES);
    renderActivity();
    renderObserverFailure();
    updateSummary();
    return true;
  }

  function observeTransaction(current) {
    const former = previousState;
    previousState = current;
    if (!former || current.revision === former.revision) return;
    const delta = describeSceneDelta(former.scene, current.scene);
    if (viewerCameraActive) {
      setText(byId("last-scene-delta"), "Observer camera adjusted");
      return;
    }
    const changes = [
      ...delta.added.map((entityId) => ({
        entityId,
        kind: "added",
        label: observerText(current.scene?.entities?.[entityId]?.name),
      })),
      ...delta.removed.map((entityId) => ({ entityId, kind: "removed" })),
      ...delta.modified.filter((change) => change.change !== "camera")
        .map((change) => ({
          entityId: change.entityId,
          kind: change.change,
          label: observerText(change.entity?.name),
        })),
    ];
    if (changes.length > 0) {
      presentation.enqueue({
        committed: true,
        phase: "committed",
        revision: current.revision,
        label: delta.detail,
        changes,
      });
      const surface = delta.modified.find((change) => change.change === "surface");
      if (surface) {
        const material = surface.entity?.components?.["oriel.material"];
        const procedural = /^textures\/procedural\/(.+)-[0-9a-f]{20}-(?:albedo|normal|orm)\.png$/u
          .exec(material?.baseColorTexture ?? material?.normalTexture ?? "");
        let sample = null;
        if (procedural && typeof materialService?.inspectMaterialSample === "function") {
          try { sample = materialService.inspectMaterialSample(procedural[1]); }
          catch { /* An unrecognized procedural sample remains a truthful object-level label. */ }
        }
        setMaterialStatus({
          name: sample?.name ?? surface.entity?.name,
          family: sample?.category,
          material,
        });
      }
    }
    const prefix = activeInvocation?.ambiguous ? "Agent scene update · "
      : activeInvocation ? `${toolLabel(activeInvocation.name,
        activeInvocation.operation)} · ` : agentObserved ? "Agent scene update · " : "Scene update · ";
    setText(byId("last-scene-delta"), `${prefix}${delta.detail} · r${current.revision}`);
    if ((agentObserved || activeInvocation) && !unresolvedFailure) {
      const transaction = byId("agent-transaction-state");
      if (transaction) {
        transaction.textContent = "Applied";
        transaction.dataset.state = "applied";
      }
    }
    if (activeInvocation && !unresolvedFailure) setText(byId("agent-current-step"), `${toolLabel(
      activeInvocation.name, activeInvocation.operation)} · ${delta.detail}`);
  }

  async function downloadArtifact(artifact) {
    if (!artifact) return;
    if (typeof options.download === "function") return options.download(artifact);
    const bytes = artifact.bytes instanceof Uint8Array ? artifact.bytes
      : artifact.bytes instanceof ArrayBuffer ? new Uint8Array(artifact.bytes)
        : artifact instanceof Uint8Array ? artifact : null;
    const blob = artifact.blob instanceof Blob ? artifact.blob
      : bytes ? new Blob([bytes], { type: artifact.mediaType ?? artifact.mimeType
        ?? "application/octet-stream" }) : null;
    if (!blob || typeof URL.createObjectURL !== "function") {
      throw new Error("This browser cannot prepare the requested download.");
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = text(artifact.fileName ?? artifact.name, "codex-model.glb");
    link.click();
    queueMicrotask(() => URL.revokeObjectURL(url));
  }

  function select(identifier) {
    if (!store || typeof store.setSelection !== "function") return;
    return perform(() => store.setSelection(identifier));
  }

  function applyCameraPose(pose) {
    if (!pose || disposed) return;
    pendingCameraPose = pose;
    if (cameraUpdate) return cameraUpdate;
    cameraUpdate = perform(async () => {
      viewerCameraActive = true;
      try {
        while (pendingCameraPose && !disposed) {
          const next = pendingCameraPose;
          pendingCameraPose = null;
          previewCameraPose(next);
          await ownerCameraPreview;
          if (ownerCameraPreviewActive) {
            ownerCameraPreviewActive = false;
            await runtime?.finishOwnerCameraPreview?.();
          }
        }
      } finally {
        viewerCameraActive = false;
      }
    }).finally(() => { cameraUpdate = null; });
    return cameraUpdate;
  }

  function retainOwnerCameraOverride() {
    if (!ownerCameraOverrideActive) {
      ownerAuthoredCamera = authoredCameraSignature(cameraEntity(scene()));
      ownerCameraOverrideActive = true;
    }
  }

  function synchronizeAutoFollow(event) {
    if (disposed || typeof event?.detail?.enabled !== "boolean") return;
    autoFollowEnabled = event.detail.enabled;
    root.querySelector?.("[data-action='auto-follow']")
      ?.setAttribute("aria-pressed", String(autoFollowEnabled));
  }

  function setAutoFollow(enabled, reason) {
    if (disposed || enabled === autoFollowEnabled) return;
    autoFollowEnabled = enabled;
    root.querySelector?.("[data-action='auto-follow']")
      ?.setAttribute("aria-pressed", String(enabled));
    try {
      browser.sessionStorage?.setItem(CAMERA_AUTO_FOLLOW_PREFERENCE_KEY,
        enabled ? "on" : "off");
    } catch { /* Browser-local camera controls remain available without storage access. */ }
    try {
      const Event = browser.CustomEvent ?? globalThis.CustomEvent;
      if (typeof Event === "function") browser.dispatchEvent?.(new Event(
        CAMERA_AUTO_FOLLOW_CHANGE_EVENT,
        { detail: reason ? { enabled, reason } : { enabled } }));
    } catch { /* A restricted embedding cannot prevent direct owner camera navigation. */ }
  }

  function disengageAutoFollow() {
    setAutoFollow(false, "user_motion");
  }

  function previewCameraPose(pose) {
    if (!pose || typeof runtime?.previewOwnerCameraPose !== "function" || disposed) return;
    const establishedOverride = ownerCameraOverrideActive;
    retainOwnerCameraOverride();
    pendingOwnerCameraPreview = pose;
    if (ownerCameraPreview) return ownerCameraPreview;
    let accepted = false;
    ownerCameraPreview = (async () => {
      while (pendingOwnerCameraPreview && !disposed) {
        const next = pendingOwnerCameraPreview;
        pendingOwnerCameraPreview = null;
        ownerCameraPreviewActive = true;
        await runtime.previewOwnerCameraPose({ position: next.position, lookAt: next.target });
        accepted = true;
      }
    })().catch(() => {
      if (!establishedOverride && !accepted) {
        ownerCameraOverrideActive = false;
        ownerAuthoredCamera = null;
        const authored = cameraEntity(scene());
        const camera = authored?.[1].components?.["oriel.camera"];
        if (authored) controls?.setCameraPose?.({
          position: authored[1].components?.["oriel.transform"]?.translation,
          target: camera?.lookAt,
          verticalFovDegrees: camera?.perspective?.verticalFovDegrees,
          near: camera?.perspective?.near,
        });
      }
      // An unavailable transient preview cannot replace the actual authored camera.
    }).finally(() => { ownerCameraPreview = null; });
    return ownerCameraPreview;
  }

  function synchronizeGuidedCamera(event) {
    if (disposed || viewerCameraActive || ownerCameraPreviewActive
        || pendingOwnerCameraPreview) return;
    const position = event?.detail?.position;
    const target = event?.detail?.target ?? event?.detail?.lookAt;
    if (![position, target].every((value) => Array.isArray(value)
        && value.length === 3 && value.every(Number.isFinite))) return;
    retainOwnerCameraOverride();
    controls?.setCameraPose?.({ position, target });
  }

  function mountCanvas(next) {
    if (next === canvas && controls) return;
    controls?.destroy();
    canvas = next;
    if (!canvas) {
      controls = null;
      return;
    }
    const camera = cameraEntity(scene());
    const perspective = camera?.[1].components?.["oriel.camera"]?.perspective;
    controls = createViewportControls({
      canvas,
      camera: camera ? { position: camera[1].components?.["oriel.transform"]?.translation,
        target: camera[1].components?.["oriel.camera"]?.lookAt,
        verticalFovDegrees: perspective?.verticalFovDegrees,
        near: perspective?.near } : undefined,
      getOwnerCameraPose: typeof runtime?.getOwnerCameraPose === "function"
        ? runtime.getOwnerCameraPose.bind(runtime) : undefined,
      onOwnerNavigation: () => {
        disengageAutoFollow();
        retainOwnerCameraOverride();
      },
      onCameraChange: (pose) => {
        disengageAutoFollow();
        return applyCameraPose(pose);
      },
      onCameraPreview: (pose) => {
        disengageAutoFollow();
        return previewCameraPose(pose);
      },
      onSelect: select,
      pick: runtime && typeof runtime.pick === "function" ? runtime.pick.bind(runtime) : undefined,
    });
    syncGridOccluders(state());
  }

  function syncGridOccluders(current) {
    const revision = Number.isSafeInteger(current?.revision) ? current.revision : null;
    if (revision === null || revision !== gridOcclusionRevision) {
      previousGridOccluders = gridOccluders(current?.scene, store);
      gridOcclusionRevision = revision;
    }
    controls?.setGridOccluders?.(previousGridOccluders);
  }

  function exportScene() {
    if (!store) return;
    return perform(async () => {
      const value = await store.exportScene();
      if (value?.bytes instanceof Uint8Array || value?.bytes instanceof ArrayBuffer) {
        await downloadArtifact({ ...value, fileName: text(value.fileName, "codex-scene.json"),
          mediaType: "application/json" });
      } else {
        const content = typeof value === "string" ? value : JSON.stringify(value?.scene ?? value, null, 2);
        await downloadArtifact({ fileName: "codex-scene.json", mediaType: "application/json",
          bytes: new TextEncoder().encode(content) });
      }
    }, "Scene downloaded.");
  }

  function exportGlb() {
    const selection = selectedEntity(state());
    if (!selection) return report("Select a modeled object before downloading its GLB.", { error: true });
    return perform(async () => {
      const artifact = await store.exportGlb(selection);
      await downloadArtifact(artifact instanceof Uint8Array ? {
        bytes: artifact, fileName: "codex-model.glb", mediaType: "model/gltf-binary",
      } : artifact);
    }, "3D asset downloaded.");
  }

  function exportPng() {
    const capture = options.capture ?? runtime?.capture?.bind(runtime);
    if (typeof capture !== "function") return report("A rendered frame is not available yet.", { error: true });
    return perform(async () => {
      const artifact = await capture({ format: "image/png" });
      await downloadArtifact(artifact instanceof Uint8Array ? {
        bytes: artifact, fileName: "codex-render.png", mediaType: "image/png",
      } : { fileName: "codex-render.png", mediaType: "image/png", ...artifact });
    }, "Rendered frame downloaded.");
  }

  function importOwnerAsset(file) {
    if (typeof options.importAsset !== "function") {
      return report("Model import is unavailable in this browser.", { error: true });
    }
    const persistence = deviceCache?.status?.();
    if (projectBusy || ownershipTransitionPending || persistence?.readOnly === true
        || ["readonly", "competing-tab"].includes(persistence?.phase)) {
      return report("This project is read-only while another browser tab owns local saving.",
        { error: true });
    }
    if (!file || typeof file.name !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}\.glb$/iu.test(file.name)) {
      return report("Choose one genuine .glb model from this device.", { error: true });
    }
    if (Number.isFinite(file.size) && file.size > MAX_OWNER_IMPORT_BYTES) {
      return report("The selected GLB exceeds the 16 MiB browser import limit.", { error: true });
    }
    const picker = byId("owner-import-file");
    return perform(async () => {
      try {
        return await options.importAsset(file);
      } finally {
        if (picker) picker.value = "";
      }
    }, `${file.name} imported into the live scene.`);
  }

  function change(event) {
    const target = event.target;
    if (target === byId("codex-camera-guidance")) {
      const enabled = target.checked === true;
      try { browser.localStorage?.setItem(CAMERA_GUIDANCE_PREFERENCE_KEY,
        enabled ? "on" : "off"); }
      catch { /* A blocked local preference cannot interrupt native scene authoring. */ }
      try {
        const Event = browser.CustomEvent ?? globalThis.CustomEvent;
        if (typeof Event === "function") browser.dispatchEvent?.(new Event(
          "codex:camera-guidance-change", { detail: { enabled } }));
      } catch { /* Guidance remains optional even in restricted embedded browsers. */ }
      return;
    }
    if (target === byId("owner-import-file")) {
      const files = target.files;
      if (files?.length === 1) return importOwnerAsset(files[0]);
      if ((files?.length ?? 0) > 1) {
        return report("Import exactly one GLB model at a time.", { error: true });
      }
    }
  }

  function changeDeviceCache(action) {
    if (projectBusy || ownershipTransitionPending) return;
    if (!deviceCache) {
      return report("Device-local saving is unavailable in this browser.", { error: true });
    }
    const message = action === "enable" ? "Automatic saving turned on for this device."
      : action === "clear" ? "Saved data cleared; the current scene remains open."
        : "Automatic saving turned off; the current scene remains open.";
    return perform(async () => {
      deviceCacheBusy = true;
      updateDeviceCache();
      try {
        let result;
        if (action === "enable") result = await deviceCache.enable({ acknowledged: true });
        else if (action === "clear") {
          await deviceCache.disable();
          result = await deviceCache.clear();
        } else result = await deviceCache.disable();
        const status = deviceCache.status?.() ?? result;
        await options.onDeviceCacheChange?.({ action, status, result });
        updateProject();
        if (byId("project-dialog")?.hidden === false) await refreshProjects();
        return result;
      } finally {
        deviceCacheBusy = false;
        updateDeviceCache();
      }
    }, message);
  }

  function click(event) {
    dismissOutsidePanels(event);
    const entity = event.target?.closest?.("[data-entity-id]");
    if (entity && root.contains?.(entity) !== false) {
      select(entity.dataset.entityId);
      if (event.detail >= 2) {
        const selected = scene().entities?.[entity.dataset.entityId];
        controls?.focusTarget(vector(selected?.components?.["oriel.transform"]?.translation, [0, 0, 0]));
      }
      return;
    }
    const button = event.target?.closest?.("[data-action]");
    if (!button || button.disabled || root.contains?.(button) === false) return;
    const action = button.dataset.action;
    if (action === "auto-follow") return setAutoFollow(!autoFollowEnabled);
    if (action === "project-open-dialog") {
      return byId("project-dialog")?.hidden === false ? hideProjects() : showProjects();
    }
    if (action === "project-new") return showProjects({ create: true });
    if (action === "project-close-dialog") return hideProjects();
    if (action === "project-create") return changeProject("create");
    if (action === "project-open") return changeProject("open", button.dataset.projectId);
    if (action === "project-delete") {
      return deleteProject(button.dataset.projectId, button.dataset.projectName);
    }
    if (action === "project-acquire") return acquireProject();
    if (action === "export-scene") return exportScene();
    if (action === "export-glb") return exportGlb();
    if (action === "export-png") return exportPng();
    if (action === "owner-import-model") {
      if (typeof options.importAsset !== "function") {
        return report("Model import is unavailable in this browser.", { error: true });
      }
      return byId("owner-import-file")?.click?.();
    }
    if (action === "owner-load-example") {
      if (typeof options.loadExample !== "function") {
        return report("The village example is unavailable.", { error: true });
      }
      return perform(() => options.loadExample(), "Village example authored through WebMCP.");
    }
    if (action === "device-cache-enable") return changeDeviceCache("enable");
    if (action === "device-cache-disable") return changeDeviceCache("disable");
    if (action === "device-cache-clear") return changeDeviceCache("clear");
    if (action === "clear-selection") return select(null);
    if (action === "retry-webmcp" || action === "retry-registration") {
      return perform(() => options.onRetryRegistration?.());
    }
    if (action === "retry-runtime") return perform(async () => {
      if (recoveryRequested || typeof options.onRetryRuntime !== "function") return false;
      if (runtime?.status?.()?.ready === true && !rendererRecoveryRequired
          && unresolvedFailure?.unknownOutcome !== true
          && unresolvedFailure?.recoveryRequired !== true) return true;
      const recovery = byId("observer-recovery-action");
      const restoreFocus = document.activeElement === recovery;
      recoveryRequested = true;
      renderObserverFailure();
      try {
        const result = await options.onRetryRuntime();
        if (result !== false && (result?.ready === true || result?.rendererReady === true
            || runtime?.status?.()?.ready === true)) {
          unresolvedFailure = null;
          rendererRecoveryRequired = false;
          rendererOperationOutcome = null;
          rendererRecoveryReason = null;
          setBadge(byId("agent-bridge-status"), agentObserved ? "Agent attached"
            : "Awaiting first invocation");
          setText(byId("agent-current-step"), "Waiting for the next agent operation");
          const transaction = byId("agent-transaction-state");
          if (transaction) {
            transaction.textContent = "Idle";
            transaction.dataset.state = "idle";
          }
        }
        return result;
      } finally {
        recoveryRequested = false;
        renderObserverFailure();
        if (restoreFocus && recovery?.hidden) canvas?.focus?.({ preventScroll: true });
      }
    });
    if (action === "download-export") {
      const identifier = button.dataset.exportId;
      const artifact = exports.get(identifier);
      if (artifact) return perform(async () => {
        await downloadArtifact(artifact);
        exports.delete(identifier);
        pendingDownloadBytes = Math.max(0, pendingDownloadBytes - artifact.offerByteLength);
        await options.onDownloadExport?.({ exportId: identifier,
          ...(artifact.artifactId ? { artifactId: artifact.artifactId } : {}),
          owner: artifact.owner, ownerGeneration: artifact.ownerGeneration });
        renderActivity();
        updateSummary();
      }, `${artifact.fileName} downloaded.`);
    }
    if (action.startsWith("camera-")) {
      const accepted = controls?.setViewPreset(action.slice("camera-".length));
      if (accepted) {
        for (const candidate of root.querySelectorAll?.("[data-action^='camera-']") ?? []) {
          candidate.classList?.toggle("is-current", candidate === button);
          candidate.setAttribute("aria-pressed", String(candidate === button));
        }
      }
    }
  }

  function keyDown(event) {
    if (event.target === byId("project-name-input") && event.key === "Enter") {
      event.preventDefault?.();
      return changeProject("create");
    }
    if (String(event.key ?? "").toLowerCase() === "escape"
        && byId("project-dialog")?.hidden === false) {
      event.preventDefault?.();
      return hideProjects();
    }
    if (String(event.key ?? "").toLowerCase() === "escape" && disclosure?.open) {
      event.preventDefault?.();
      disclosure.open = false;
      return;
    }
    const tag = String(event.target?.tagName ?? "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || event.target?.isContentEditable) return;
    if (String(event.key ?? "").toLowerCase() === "escape") select(null);
  }

  function disclosureChanged() {
    if (!disclosure?.open || disposed) return;
    previousHierarchy = null;
    previousSelection = null;
    render();
    renderActivityHistory();
  }

  function subscribeStore(next) {
    unsubscribeStore?.();
    store = next;
    ownerCameraOverrideActive = false;
    ownerAuthoredCamera = null;
    gridOcclusionRevision = null;
    previousHierarchy = null;
    previousState = state();
    if (store && typeof store.subscribe === "function") {
      const cleanup = store.subscribe((current) => {
        const nextState = current?.scene ? current : state();
        syncGridOccluders(nextState);
        const authoredCamera = cameraEntity(nextState.scene);
        const camera = authoredCamera?.[1].components?.["oriel.camera"];
        const perspective = camera?.perspective;
        if (ownerCameraOverrideActive
            && authoredCameraSignature(authoredCamera) !== ownerAuthoredCamera) {
          ownerCameraOverrideActive = false;
          ownerAuthoredCamera = null;
        }
        if (authoredCamera && !viewerCameraActive && !ownerCameraOverrideActive) {
          controls?.setCameraPose?.({
          position: authoredCamera[1].components?.["oriel.transform"]?.translation,
          target: camera.lookAt,
          verticalFovDegrees: perspective?.verticalFovDegrees,
          near: perspective?.near,
        });
        } else if (perspective) controls?.setCameraProjection?.({
          verticalFovDegrees: perspective.verticalFovDegrees,
          near: perspective.near,
        });
        observeTransaction(nextState);
        render(nextState);
      });
      if (typeof cleanup === "function") unsubscribeStore = cleanup;
    }
    if (controls) syncGridOccluders(state());
    render();
  }

  function setReference(value) {
    const strip = byId("reference-strip");
    let reference = value?.reference ?? value;
    if (Array.isArray(value?.references)) {
      reference = value.references.find((candidate) => candidate.selected
        || candidate.id === value.selectedReferenceId) ?? null;
    }
    if (value?.type === "reference-removed" || value?.selectedReferenceId) {
      const identifier = value.selectedReferenceId;
      if (!identifier) reference = null;
      else if (!reference || reference.id !== identifier && reference.referenceId !== identifier) {
        try { reference = referenceService?.get?.({ referenceId: identifier }) ?? null; }
        catch { reference = null; }
      }
    }

    const label = observerText(reference?.name ?? reference?.fileName
      ?? reference?.title ?? reference?.label);
    if (strip) {
      strip.hidden = !label;
      strip.dataset.state = label ? "selected" : "empty";
      setText(byId("reference-name"), label);
      const detail = byId("reference-detail");
      const dimensions = Number.isSafeInteger(reference?.width)
        && Number.isSafeInteger(reference?.height)
        ? `${reference.width} × ${reference.height}` : "";
      setText(detail, dimensions);
      if (detail) detail.hidden = !dimensions;
    }
    return label || null;
  }

  function setMaterialStatus(value) {
    const strip = byId("material-strip");
    const material = value?.material ?? value;
    const label = observerText(value?.name ?? value?.label ?? value?.materialName
      ?? material?.name ?? material?.label);
    const family = observerText(value?.family ?? value?.type ?? material?.family
      ?? material?.type, "", 32).toLowerCase();
    if (strip) {
      strip.hidden = !label;
      strip.dataset.state = label ? "ready" : "empty";
      const materialId = observerText(value?.materialId ?? value?.materialHandle
        ?? material?.materialId ?? material?.materialHandle, "", 128);
      if (label && materialId) strip.dataset.materialId = materialId;
      else delete strip.dataset.materialId;
      strip.dataset.tone = /stone|limestone|plaster/iu.test(family || label) ? "stone"
        : /slate|roof|navy/iu.test(family || label) ? "slate"
          : /gold|brass|metal/iu.test(family || label) ? "metal"
            : /cloth|banner|fabric/iu.test(family || label) ? "cloth"
              : /vegetation|ivy|moss|leaf/iu.test(family || label) ? "vegetation"
                : "neutral";
      setText(byId("material-name"), label);
    }
    return label || null;
  }

  function renderMaterialLibrary(value) {
    const records = Array.isArray(value) ? value
      : Array.isArray(value?.materials) ? value.materials
        : Array.isArray(value?.customMaterials) ? value.customMaterials : [];
    const selected = [];
    const seen = new Set();
    for (const candidate of records) {
      if (!candidate || typeof candidate !== "object") continue;
      const materialId = observerText(candidate.materialId
        ?? candidate.materialHandle ?? candidate.id, "", 128);
      const name = observerText(candidate.name ?? candidate.displayName
        ?? candidate.label ?? candidate.material?.name);
      if (!materialId || !name || seen.has(materialId)) continue;
      seen.add(materialId);
      selected.push({ materialId, name,
        family: observerText(candidate.category ?? candidate.family
          ?? candidate.type, "", 40),
        mapCount: Number.isSafeInteger(candidate.mapCount) && candidate.mapCount >= 0
          ? candidate.mapCount : Array.isArray(candidate.maps)
            ? candidate.maps.length : null });
      if (selected.length >= MAX_CUSTOM_MATERIAL_ROWS) break;
    }

    let container = byId("material-library");
    if (!container && selected.length > 0) {
      const host = byId("inspector-panel") ?? byId("effects-panel");
      if (!host || typeof host.append !== "function") return selected;
      container = document.createElement("section");
      container.id = "material-library";
      container.className = "details-section compact-readouts";
      container.setAttribute("aria-label", "Custom material library");
      container.setAttribute("aria-live", "polite");
      host.append(container);
    }
    if (!container) return selected;
    container.hidden = selected.length === 0;
    container.dataset.count = String(Number.isSafeInteger(value?.total)
      && value.total >= selected.length ? value.total : selected.length);

    const fragment = document.createDocumentFragment?.() ?? document.createElement("div");
    if (selected.length > 0) {
      const heading = document.createElement("div");
      heading.className = "readout-line";
      const title = document.createElement("span");
      title.textContent = "Custom materials";
      const count = document.createElement("span");
      count.id = "custom-material-count";
      count.textContent = container.dataset.count;
      heading.append(title, count);
      fragment.append(heading);
    }
    for (const material of selected) {
      const row = document.createElement("div");
      row.className = "readout-line";
      row.dataset.materialId = material.materialId;
      const name = document.createElement("span");
      name.textContent = material.name;
      const detail = document.createElement("span");
      detail.textContent = material.family || (material.mapCount === null ? "Custom"
        : `${material.mapCount} ${material.mapCount === 1 ? "map" : "maps"}`);
      row.append(name, detail);
      fragment.append(row);
    }
    container.replaceChildren(fragment);
    return selected;
  }

  function subscribeMaterialAuthoring(next) {
    unsubscribeMaterialAuthoring?.();
    unsubscribeMaterialAuthoring = null;
    materialAuthoringService = next ?? null;
    const generation = ++materialLibraryGeneration;
    renderMaterialLibrary([]);
    if (!materialAuthoringService || typeof materialAuthoringService.list !== "function") return;

    const refresh = (event) => {
      if (disposed || generation !== materialLibraryGeneration) return;
      const category = String(event?.type ?? event?.kind ?? "");
      if (/^material-(?:created|updated|uploaded|applied)$/u.test(category)) {
        const material = event.material ?? event;
        if (text(material.name ?? material.displayName ?? material.label)) {
          setMaterialStatus({ ...material,
            ...(event.materialId === undefined ? {} : { materialId: event.materialId }),
          });
        }
      } else if (category === "material-deleted") {
        const strip = byId("material-strip");
        if (strip?.dataset.materialId === event.materialId) setMaterialStatus(null);
      }
      try {
        const current = materialAuthoringService.list();
        if (current && typeof current.then === "function") {
          Promise.resolve(current).then((value) => {
            if (!disposed && generation === materialLibraryGeneration) {
              renderMaterialLibrary(value);
            }
          }).catch(() => {
            /* Private material library inspection never fabricates entries or blocks observation. */
          });
        } else if (!disposed && generation === materialLibraryGeneration) {
          renderMaterialLibrary(current);
        }
      } catch { /* Unavailable private material catalogs remain hidden and truthful. */ }
    };
    if (typeof materialAuthoringService.subscribe === "function") {
      try {
        const cleanup = materialAuthoringService.subscribe(refresh);
        if (typeof cleanup === "function") unsubscribeMaterialAuthoring = cleanup;
      } catch { /* Optional material notifications never block the actual modeling scene. */ }
    }
    refresh();
  }

  function subscribeReferences(next) {
    unsubscribeReferences?.();
    unsubscribeReferences = null;
    referenceService = next;
    if (!referenceService) {
      setReference(null);
      return;
    }
    try { setReference(referenceService.list?.() ?? null); }
    catch { setReference(null); }
    if (typeof referenceService.subscribe === "function") {
      try {
        const cleanup = referenceService.subscribe((event) => setReference(event));
        if (typeof cleanup === "function") unsubscribeReferences = cleanup;
      } catch { /* Reference metadata is optional and never controls scene ownership. */ }
    }
  }

  function applyRendererPresentation(value, { authoritative = false } = {}) {
    if (!value || typeof value !== "object") return;
    if (!authoritative) lastRuntimeStatus = value;

    const ready = authoritative ? value.rendererReady === true : value.ready === true;
    const phase = text(value.phase);
    const explicitOwnerFrame = typeof value.ownerFrameVisible === "boolean"
      || typeof value.ownerFrameAuthenticated === "boolean";
    if (authoritative && explicitOwnerFrame) {
      authoritativeOwnerFrame = true;
      authenticatedOwnerFrameVisible = value.ownerFrameVisible === true
        && value.ownerFrameAuthenticated !== false;
    }
    if (authoritative && typeof value.switching === "boolean") {
      ownerTransition = value.switching;
      if (ownerTransition) authenticatedOwnerFrameVisible = false;
    }

    const deviceChanged = value.rendererDeviceChanged === true
      || value.recoveryReason === "renderer_device_changed"
      || value.recoveryFence?.reason === "renderer_device_changed";
    const terminalFailure = phase === "failed" || phase === "failed_closed"
      || phase === "error" || value.failedClosed === true || deviceChanged;
    if (terminalFailure || ownerTransition) {
      authenticatedOwnerFrameVisible = false;
    } else if (ready && !authoritativeOwnerFrame) {
      // Standalone/legacy runtimes have no authenticated bootstrap owner feed.
      // A current ready transition is the only signal allowed to arm their latch.
      authenticatedOwnerFrameVisible = true;
    }

    const visible = !ownerTransition && !terminalFailure
      && (authenticatedOwnerFrameVisible || ready && !authoritativeOwnerFrame);
    const settling = !ready && !terminalFailure && !ownerTransition
      && (value.rendererSettling === true || phase === "settling"
        || phase === "renderer-settling" || phase === "warming"
        || visible && (phase === "applying" || phase === "presenting"));
    const explicitRecovery = value.recoveryRequired === true
      || phase === "recovery-required";
    const operationOutcome = text(value.operationOutcome
      ?? value.recoveryFence?.operationOutcome) || null;
    const unknownOutcome = value.unknownOutcome === true
      || operationOutcome === "unknown";
    if (explicitRecovery || unknownOutcome) {
      rendererRecoveryRequired = true;
      rendererOperationOutcome = unknownOutcome ? "unknown" : operationOutcome;
      rendererRecoveryReason = text(value.recoveryReason
        ?? value.recoveryFence?.reason) || null;
    } else if (authoritative && value.recoveryRequired === false
        && value.unknownOutcome === false && !recoveryRequested) {
      rendererRecoveryRequired = false;
      rendererOperationOutcome = null;
      rendererRecoveryReason = null;
    }

    if (unknownOutcome && unresolvedFailure?.unknownOutcome !== true) {
      unresolvedFailure = {
        invocationId: safeObserverMessage(value.invocationId
          ?? value.recoveryFence?.requestId, "", 96) || null,
        code: safeObserverMessage(value.error?.code, "RECONCILIATION_REQUIRED"),
        message: safeObserverMessage(value.error?.message ?? value.message,
          "Operation outcome unknown. Recover the renderer to continue."),
        unknownOutcome: true,
        recoveryRequired: true,
        operationOutcome: "unknown",
      };
    }

    const viewport = byId("viewport-stage");
    if (viewport) {
      viewport.dataset.ready = String(visible);
      viewport.dataset.ownerFrameVisible = String(visible);
      viewport.dataset.ownerTransition = String(ownerTransition);
      viewport.dataset.rendererReady = String(ready);
      viewport.dataset.rendererSettling = String(settling);
      viewport.dataset.recoveryReason = rendererRecoveryReason ?? "";
    }
    const startup = byId("viewport-empty");
    if (startup) {
      startup.hidden = visible;
      startup.setAttribute?.("aria-hidden", String(visible));
    }
    const title = byId("viewport-startup-title");
    if (title && !visible) {
      title.textContent = ownerTransition ? "Opening project"
        : terminalFailure ? "Renderer unavailable"
          : rendererRecoveryRequired ? "Renderer recovery required"
            : "Opening Codex Modeling Studio";
    }

    const rendererLabel = ready ? "Native WebGPU frames presented"
      : settling ? "Updating renderer"
        : rendererOperationOutcome === "applied_uncommitted"
          ? "Renderer applied update; restoring last committed model"
          : rendererRecoveryRequired || phase === "recovering"
            ? "Recovering renderer"
            : statusLabel(value.error ?? value.rendererLabel ?? value,
              "Initializing WebGPU renderer");
    setBadge(byId("webgpu-status"), ready ? "Ready" : rendererLabel,
      "Starting WebGPU");
    const renderer = byId("renderer-status");
    if (renderer) {
      renderer.textContent = rendererLabel;
      renderer.dataset.state = ready ? "ready" : terminalFailure ? "error"
        : settling ? "settling" : rendererRecoveryRequired ? "recovery-required" : "pending";
    }
    const mode = byId("render-mode");
    if (mode) mode.dataset.state = ready ? "ready"
      : settling ? "settling" : terminalFailure ? "error" : "pending";
    if (settling || rendererRecoveryRequired || phase === "recovering") {
      const announcement = byId("status-message");
      if (announcement) {
        announcement.textContent = rendererLabel;
        announcement.dataset.status = terminalFailure ? "error" : "pending";
        announcement.setAttribute?.("role", "status");
      }
    }
    if (Number.isSafeInteger(value.presentedFrames)) {
      setText(byId("connection-detail"),
        `${value.presentedFrames} genuinely presented WebGPU frames`);
    }
    if (unresolvedFailure || rendererRecoveryRequired) renderObserverFailure();
  }

  function subscribeRuntime(next) {
    unsubscribeRuntime?.();
    runtime = next;
    if (!runtime) return setBadge(byId("webgpu-status"), "Waiting for native renderer");
    const update = (value) => applyRendererPresentation(value ?? runtime.status?.());
    if (typeof runtime.subscribe === "function") {
      const cleanup = runtime.subscribe(update);
      if (typeof cleanup === "function") unsubscribeRuntime = cleanup;
    }
    update();
  }

  function subscribeRegistrar(next) {
    unsubscribeRegistrar?.();
    registrar = next;
    if (!registrar) return setBadge(byId("webmcp-status"), "Waiting for WebMCP");
    const update = (value) => {
      const status = value ?? registrar.getStatus?.() ?? registrar.status?.();
      const registered = status?.registeredNames ?? status?.registeredTools ?? [];
      registeredToolCount = status?.ready === true && Array.isArray(registered)
        ? registered.length : 0;
      setBadge(byId("webmcp-status"), status?.ready
        ? `${registered.length} tools` : status, "Registering tools");
      if (status?.agentBridgeObserved === true) agentObserved = true;
      if (!unresolvedFailure) {
        setBadge(byId("agent-bridge-status"), agentObserved ? "Agent attached"
          : status?.ready ? "Awaiting first invocation" : status, "Waiting for an agent");
      }
      if (status?.ready) {
        setText(byId("connection-detail"), `${registered.length} browser-local tools · waiting for real invocation`);
      }
      updateSummary();
    };
    if (typeof registrar.subscribe === "function") {
      const cleanup = registrar.subscribe(update);
      if (typeof cleanup === "function") unsubscribeRegistrar = cleanup;
    }
    update();
  }

  function subscribeDeviceCache(next) {
    unsubscribeDeviceCache?.();
    unsubscribeDeviceCache = null;
    deviceCache = next ?? null;
    if (typeof deviceCache?.subscribe === "function") {
      try {
        const subscribedCache = deviceCache;
        const cleanup = subscribedCache.subscribe((value) => {
          if (!disposed && deviceCache === subscribedCache) updateDeviceCache(value);
        });
        if (typeof cleanup === "function") unsubscribeDeviceCache = cleanup;
      } catch (error) {
        report(text(error?.message, "Device-local saving is unavailable."), { error: true });
      }
    }
    updateOwnerActions();
  }

  function subscribeProjects(next) {
    unsubscribeProjects?.();
    unsubscribeProjects = null;
    projectController = next ?? null;
    if (typeof projectController?.subscribe === "function") {
      try {
        const cleanup = projectController.subscribe((value) => {
          const supplied = value?.project ?? value;
          const active = currentProject();
          const suppliedId = text(supplied?.projectId ?? supplied?.id);
          const activeId = text(active?.projectId ?? active?.id);
          const hasSuppliedName = Boolean(text(supplied?.displayName ?? supplied?.name));
          const project = suppliedId && activeId && suppliedId !== activeId
            ? active : hasSuppliedName ? supplied : active;
          updateProject(project);
          if (byId("project-dialog")?.hidden === false) refreshProjects();
        });
        if (typeof cleanup === "function") unsubscribeProjects = cleanup;
      } catch (error) {
        report(text(error?.message, "Projects are unavailable."), { error: true });
      }
    }
    updateProject();
  }

  root.addEventListener("pointerdown", dismissOutsidePanels);
  root.addEventListener("click", click);
  root.addEventListener("change", change);
  root.addEventListener("keydown", keyDown);
  disclosure?.addEventListener?.("toggle", disclosureChanged);
  browser.addEventListener?.("codex:camera-guidance-pose", synchronizeGuidedCamera);
  browser.addEventListener?.(CAMERA_AUTO_FOLLOW_CHANGE_EVENT, synchronizeAutoFollow);
  try {
    const preference = browser.sessionStorage?.getItem(CAMERA_AUTO_FOLLOW_PREFERENCE_KEY);
    const navigation = browser.performance?.getEntriesByType?.("navigation")?.[0]?.type;
    if (preference === "off" && navigation === "navigate") {
      autoFollowEnabled = true;
      try { browser.sessionStorage?.setItem(CAMERA_AUTO_FOLLOW_PREFERENCE_KEY, "on"); }
      catch { /* An opener-cloned preference must not disable a genuinely new browser tab. */ }
    } else autoFollowEnabled = preference !== "off";
  } catch { autoFollowEnabled = true; }
  root.querySelector?.("[data-action='auto-follow']")
    ?.setAttribute("aria-pressed", String(autoFollowEnabled));
  const guidance = byId("codex-camera-guidance");
  if (guidance) {
    try { guidance.checked = browser.localStorage?.getItem(
      CAMERA_GUIDANCE_PREFERENCE_KEY) !== "off"; }
    catch { guidance.checked = true; }
  }
  subscribeStore(store);
  subscribeRuntime(runtime);
  subscribeRegistrar(registrar);
  subscribeReferences(referenceService);
  subscribeMaterialAuthoring(materialAuthoringService);
  subscribeDeviceCache(deviceCache);
  subscribeProjects(projectController);
  setText(byId("agent-current-step"), "Waiting for the first real agent operation");
  setText(byId("last-scene-delta"), "No agent scene changes observed yet");
  setText(byId("agent-last-result"), "No verified operation yet");
  const initialTransaction = byId("agent-transaction-state");
  if (initialTransaction) {
    initialTransaction.textContent = "Idle";
    initialTransaction.dataset.state = "idle";
  }
  renderActivity();
  mountCanvas(canvas);

  function offerExport(artifact, metadata = artifact) {
    if (!artifact || typeof artifact !== "object" || disposed
        || !matchesCallbackOwner(metadata)) return null;
    const byteLength = artifact.bytes?.byteLength ?? artifact.byteLength
      ?? artifact.size ?? 0;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0
        || exports.size >= MAX_PENDING_DOWNLOAD_OFFERS
        || byteLength > MAX_PENDING_DOWNLOAD_BYTES - pendingDownloadBytes) {
      const error = new Error("Pending browser downloads exceed the owner-local limit.");
      error.code = "QUOTA_EXCEEDED";
      throw error;
    }
    const identifier = safeObserverMessage(artifact.exportId ?? metadata?.exportId,
      `artifact-${++serial}`, 96);
    if (exports.has(identifier)) return identifier;
    const normalized = { ...artifact,
      fileName: observerText(artifact.fileName ?? artifact.name, "codex-model.glb"),
      offerByteLength: byteLength,
      owner: metadata?.owner ?? callbackOwner,
      ownerGeneration: metadata?.ownerGeneration ?? callbackOwnerGeneration };
    exports.set(identifier, normalized);
    pendingDownloadBytes += byteLength;
    addActivity({ name: normalized.fileName, status: "queued", source: "Export",
      detail: "Ready for explicit download", exportId: identifier });
    report(`${normalized.fileName} is ready. Choose Download to save it.`);
    return identifier;
  }

  function setAgentActivity(value) {
    if (!value || typeof value !== "object" || disposed
        || !matchesCallbackOwner(value)) return;
    const unknownOutcome = value.unknownOutcome === true
      || value.error?.unknownOutcome === true
      || value.operationOutcome === "unknown"
      || value.error?.operationOutcome === "unknown";
    const phase = unknownOutcome ? "failed" : text(value.phase, "idle");
    const readOnly = value.readOnly === true
      || value.toolName === "scene_preflight_batch";
    const validation = value.toolName === "scene_preflight_batch";
    const acquisition = value.toolName === "project_acquire";
    if (acquisition) {
      ownershipTransitionPending = phase === "started" || phase === "running";
      if (phase === "completed") {
        ownershipFeedback = "Editing access acquired. This tab can now edit the latest saved project.";
      } else if (phase === "failed" && value.error?.code === "LOCK_UNAVAILABLE") {
        ownershipFeedback = "Editing is still active in another tab. Close that tab, then try Edit here again.";
      }
      updateProject();
    }
    if (phase === "completed" && (!readOnly || !activeInvocation)
        && unresolvedFailure?.unknownOutcome !== true
        && unresolvedFailure?.recoveryRequired !== true
        && !rendererRecoveryRequired) {
      unresolvedFailure = null;
    }
    if (readOnly && activeInvocation || unresolvedFailure && phase !== "failed") {
      renderObserverFailure();
      updateSummary();
      return;
    }
    if (phase === "started" || phase === "running") {
      agentObserved = true;
      const transaction = byId("agent-transaction-state");
      if (transaction) {
        transaction.textContent = "Running";
        transaction.dataset.state = "running";
      }
      setText(byId("agent-current-step"), text(value.detail,
        toolLabel(value.toolName, value.operation)));
      setBadge(byId("agent-bridge-status"), "An agent is working");
    } else if (agentObserved && ["completed", "failed", "aborted", "idle"].includes(phase)) {
      if (phase === "failed") {
        const recoveryRequired = unknownOutcome || value.recoveryRequired === true
          || value.error?.recoveryRequired === true;
        unresolvedFailure = {
          invocationId: safeObserverMessage(value.invocationId) || null,
          code: safeObserverMessage(value.error?.code,
            unknownOutcome ? "RECONCILIATION_REQUIRED" : "INVOCATION_FAILED"),
          message: actionableObserverFailure(value.error, safeObserverMessage(value.detail,
            unknownOutcome ? "Operation outcome unknown. Recover the renderer to continue."
              : "The agent operation failed.")),
          unknownOutcome,
          recoveryRequired,
          operationOutcome: text(value.operationOutcome
            ?? value.error?.operationOutcome) || null,
        };
        if (recoveryRequired) {
          rendererRecoveryRequired = true;
          rendererOperationOutcome = unresolvedFailure.operationOutcome
            ?? (unknownOutcome ? "unknown" : null);
        }
      }
      const transaction = byId("agent-transaction-state");
      if (transaction) {
        transaction.textContent = phase === "failed" ? "Failed"
          : phase === "aborted" ? "Cancelled" : phase === "idle" ? "Idle"
            : validation ? "Validated" : acquisition ? "Access granted"
              : readOnly ? "Observed"
              : Number.isSafeInteger(value.revision) ? `Applied · r${value.revision}`
                : "Applied";
        transaction.dataset.state = phase === "failed" ? "failed"
          : phase === "aborted" ? "cancelled" : phase === "idle" ? "idle"
            : validation ? "validated" : acquisition ? "acquired"
              : readOnly ? "observed" : "applied";
      }
      if (value.detail || value.error) {
        setText(byId("agent-last-result"), text(value.detail,
          text(value.error?.message ?? value.error, "Verified operation completed")));
      }
      setText(byId("agent-current-step"), phase === "failed"
        ? "The agent encountered an error" : "Waiting for the next agent operation");
      setBadge(byId("agent-bridge-status"), phase === "failed" ? "Agent error" : "Agent attached");
    }
    renderObserverFailure();
    updateSummary();
  }

  function reportCheckpointFailure(value) {
    if (!value || typeof value !== "object" || disposed
        || !matchesCallbackOwner(value)) return false;
    checkpointFailure = {
      code: safeObserverMessage(value.code ?? value.error?.code, "CHECKPOINT_FAILED"),
      message: safeObserverMessage(value.message ?? value.error?.message,
        "The committed scene could not be saved on this device."),
    };
    const prominent = byId("project-persistence-status");
    if (prominent) {
      prominent.textContent = "Save failed";
      prominent.dataset.state = "error";
      prominent.setAttribute?.("aria-label", checkpointFailure.message);
    }
    const status = byId("device-cache-status");
    if (status) {
      status.textContent = `Save failed · ${checkpointFailure.message}`;
      status.dataset.state = "error";
    }
    renderObserverFailure();
    report(`Scene committed, but local saving failed: ${checkpointFailure.message}`, {
      error: true,
    });
    return true;
  }

  function logSceneTransaction(event) {
    if (!event || typeof event !== "object") return;
    if (event.source === "viewer") return;
    const revision = Number.isSafeInteger(event.revision) ? ` · r${event.revision}` : "";
    const detail = text(event.detail,
      text(event.operation, event.phase === "rendered" ? "Native frame presented"
        : event.phase === "started" ? "Applying scene changes" : "Scene transaction committed"));
    if (agentObserved || activeInvocation) {
      setText(byId("last-scene-delta"), `${detail}${revision}`);
      const transaction = byId("agent-transaction-state");
      if (transaction && !unresolvedFailure) {
        const phase = event.phase === "started" || event.phase === "applying"
          ? "running" : event.phase === "failed" ? "failed" : "applied";
        transaction.dataset.state = phase;
        transaction.textContent = phase === "running" ? "Running"
          : phase === "failed" ? "Failed" : "Applied";
      }
    }
  }

  function setRenderActivity(event) {
    if (!event || typeof event !== "object") return;
    if (Number.isSafeInteger(event.presentedFrames)) {
      setText(byId("connection-detail"), `${event.presentedFrames} presented WebGPU frames`
        + (agentObserved ? " · Agent attached" : ""));
    }
    if (event.error) report(text(event.error.message ?? event.error,
      "The native renderer could not present the scene."), { error: true });
  }

  function setOwner(value) {
    if (!value || typeof value !== "object" || disposed) return false;
    const nextOwner = value.owner ?? null;
    const nextGeneration = Number.isSafeInteger(value.ownerGeneration)
      ? value.ownerGeneration : null;
    if (callbackOwner === nextOwner && callbackOwnerGeneration === nextGeneration) return true;
    const sameOwner = callbackOwner !== null && callbackOwner === nextOwner;
    const previousOwner = callbackOwner;
    const previousGeneration = callbackOwnerGeneration;
    authenticatedOwnerFrameVisible = false;
    if (previousOwner !== null || previousGeneration !== null) ownerTransition = true;
    applyRendererPresentation({ rendererReady: false, ownerFrameVisible: false,
      ownerFrameAuthenticated: false, switching: ownerTransition }, { authoritative: true });
    callbackOwner = nextOwner;
    callbackOwnerGeneration = nextGeneration;
    activity.length = 0;
    activeInvocations.clear();
    if (sameOwner) {
      for (const artifact of exports.values()) artifact.ownerGeneration = nextGeneration;
    } else {
      exports.clear();
      pendingDownloadBytes = 0;
    }
    activeInvocation = null;
    activeReadOnlyInvocations = 0;
    completedInvocations = 0;
    unresolvedFailure = null;
    checkpointFailure = null;
    recoveryRequested = false;
    rendererRecoveryRequired = false;
    rendererOperationOutcome = null;
    rendererRecoveryReason = null;
    agentObserved = false;
    setText(byId("agent-current-step"), "Waiting for the first real agent operation");
    setText(byId("agent-last-result"), "No verified operation yet");
    const transaction = byId("agent-transaction-state");
    if (transaction) {
      transaction.textContent = "Idle";
      transaction.dataset.state = "idle";
    }
    setBadge(byId("agent-bridge-status"), "Awaiting first invocation");
    renderActivity();
    renderObserverFailure();
    updateSummary();
    return true;
  }

  function resetProjectState(next = {}) {
    if (disposed || !next || typeof next !== "object") return false;

    authenticatedOwnerFrameVisible = false;
    ownerTransition = true;
    applyRendererPresentation({ rendererReady: false, ownerFrameVisible: false,
      ownerFrameAuthenticated: false, switching: true }, { authoritative: true });
    presentation.dispose();
    presentation = newPresentation();
    presentationRevision = null;
    for (const row of presentedRows) row.classList?.toggle("is-just-changed", false);
    presentedRows = [];
    const viewport = byId("viewport-stage");
    if (viewport) {
      viewport.dataset.presentationActive = "false";
      delete viewport.dataset.presentationKind;
    }
    const workspace = byId("studio-shell");
    if (workspace) delete workspace.dataset.presentationKind;
    const signal = byId("presentation-signal");
    if (signal) {
      signal.dataset.active = "false";
      delete signal.dataset.kind;
    }

    activity.length = 0;
    activeInvocations.clear();
    exports.clear();
    pendingDownloadBytes = 0;
    activeInvocation = null;
    activeReadOnlyInvocations = 0;
    completedInvocations = 0;
    unresolvedFailure = null;
    checkpointFailure = null;
    recoveryRequested = false;
    rendererRecoveryRequired = false;
    rendererOperationOutcome = null;
    rendererRecoveryReason = null;
    agentObserved = false;
    previousState = null;
    previousHierarchy = null;
    previousSelection = null;
    gridOcclusionRevision = null;
    previousGridOccluders = [];
    pendingCameraPose = null;
    pendingOwnerCameraPreview = null;
    ownerCameraOverrideActive = false;
    ownerAuthoredCamera = null;
    if (ownerCameraPreviewActive) {
      ownerCameraPreviewActive = false;
      try { runtime?.finishOwnerCameraPreview?.(); }
      catch { /* A stale transient camera preview cannot prevent project isolation. */ }
    }
    projectBusy = false;
    deviceCacheBusy = false;
    projectListRequest += 1;
    hideProjects();
    const projectInput = byId("project-name-input");
    if (projectInput) projectInput.value = "";
    const importInput = byId("owner-import-file");
    if (importInput) importInput.value = "";
    byId("project-list")?.replaceChildren?.();
    setText(byId("project-list-status"), "");
    setReference(null);
    setMaterialStatus(null);
    subscribeMaterialAuthoring(Object.hasOwn(next, "materialAuthoringService")
      ? next.materialAuthoringService : null);

    if (Object.hasOwn(next, "materialService")) {
      materialService = next.materialService ?? null;
    }
    if (Object.hasOwn(next, "referenceService")) {
      subscribeReferences(next.referenceService);
    }
    if (Object.hasOwn(next, "deviceCache")) subscribeDeviceCache(next.deviceCache);
    if (Object.hasOwn(next, "store")) subscribeStore(next.store);
    const authored = cameraEntity(scene());
    const camera = authored?.[1].components?.["oriel.camera"];
    if (authored) controls?.setCameraPose?.({
      position: authored[1].components?.["oriel.transform"]?.translation,
      target: camera?.lookAt,
      verticalFovDegrees: camera?.perspective?.verticalFovDegrees,
      near: camera?.perspective?.near,
    });

    setText(byId("agent-current-step"), "Waiting for the first real agent operation");
    setText(byId("last-scene-delta"), "No agent scene changes observed yet");
    setText(byId("agent-last-result"), "No verified operation yet");
    const transaction = byId("agent-transaction-state");
    if (transaction) {
      transaction.textContent = "Idle";
      transaction.dataset.state = "idle";
    }
    setBadge(byId("agent-bridge-status"), "Awaiting first invocation");
    renderActivity();
    renderObserverFailure();
    updateProject();
    updateSummary();
    return true;
  }

  return {
    render,
    logToolInvocation: addActivity,
    logAgentInvocation: addActivity,
    logSceneTransaction,
    setAgentActivity,
    setOwner,
    reportCheckpointFailure,
    setRenderActivity,
    setReference,
    updateReference: setReference,
    setReferenceService: subscribeReferences,
    setMaterialAuthoringService: subscribeMaterialAuthoring,
    setDeviceCache: subscribeDeviceCache,
    setProjectController: subscribeProjects,
    setMaterialService(next) { materialService = next ?? null; },
    resetProjectState,
    refreshProjects,
    setMaterialStatus,
    setPresentation(value) {
      if (!value || typeof value !== "object") return false;
      if (value.reference || value.references || value.type?.startsWith?.("reference-")) {
        setReference(value);
      }
      if (value.material || value.materialName || value.kind === "material") {
        let material = value;
        if (typeof value.materialName === "string"
            && typeof materialService?.inspectMaterialSample === "function") {
          try {
            const sample = materialService.inspectMaterialSample(value.materialName);
            material = { ...value, name: sample?.name ?? value.materialName,
              family: value.family ?? sample?.category };
          } catch { /* Direct material changes retain their genuine supplied label. */ }
        }
        setMaterialStatus(material);
      }
      return value.phase === "committed"
        && Number.isSafeInteger(value.revision)
        && presentation.getState().revision === value.revision;
    },
    getPresentationState: () => presentation.getState(),
    offerExport,
    queueExport: offerExport,
    setStatus(value) {
      if (typeof value === "string") return report(value);
      if (value?.phase === "acquiring-project" || value?.phase === "acquiring") {
        ownershipTransitionPending = true;
        ownershipFeedback = "Checking whether this tab can safely edit the latest saved project.";
        updateProject();
      } else if (ownershipTransitionPending && value?.switching === false) {
        ownershipTransitionPending = false;
        updateProject();
      }
      if (value?.webgpu || value?.runtime) setBadge(byId("webgpu-status"), value.webgpu ?? value.runtime);
      if (value?.webmcp || value?.registration) setBadge(byId("webmcp-status"), value.webmcp ?? value.registration);
      if (typeof value?.rendererReady === "boolean"
          || typeof value?.ownerFrameVisible === "boolean"
          || typeof value?.switching === "boolean") {
        applyRendererPresentation({ ...value,
          rendererReady: typeof value.rendererReady === "boolean"
            ? value.rendererReady : lastRuntimeStatus?.ready === true },
        { authoritative: true });
        if (value.rendererReady && recoveryRequested
            && unresolvedFailure?.unknownOutcome === true) {
          unresolvedFailure = null;
        }
      }
      if (typeof value?.webmcpReady === "boolean") {
        const names = value.registeredNames ?? [];
        registeredToolCount = value.webmcpReady && Array.isArray(names) ? names.length : 0;
        setBadge(byId("webmcp-status"), value.webmcpReady
          ? names.length ? `${names.length} tools` : "Ready" : "Waiting");
        if (!value.webmcpReady) {
          setText(byId("connection-detail"), value.rendererReady
            ? "Renderer ready · registering browser-local modeling tools"
            : "WebMCP tools register after the renderer is Ready");
        } else if (Array.isArray(names) && names.length > 0) {
          setText(byId("connection-detail"),
            `${names.length} browser-local tools · waiting for real invocation`);
        }
      }
      if (value?.agentBridgeObserved === true) agentObserved = true;
      if (typeof value?.agentBridgeObserved === "boolean") {
        if (!unresolvedFailure) {
          setBadge(byId("agent-bridge-status"), agentObserved ? "Agent attached"
            : value.webmcpReady ? "Awaiting first invocation" : "Waiting for an agent");
        }
      }
      if (value?.message) report(value.message, { error: Boolean(value.error) });
      renderObserverFailure();
      updateSummary();
    },
    setRuntime: subscribeRuntime,
    setRegistrar: subscribeRegistrar,
    setStore: subscribeStore,
    setCanvas: mountCanvas,
    getViewportControls: () => controls,
    destroy() {
      if (disposed) return;
      presentation.dispose();
      disposed = true;
      unsubscribeStore?.();
      unsubscribeRuntime?.();
      unsubscribeRegistrar?.();
      unsubscribeReferences?.();
      unsubscribeMaterialAuthoring?.();
      materialLibraryGeneration += 1;
      unsubscribeDeviceCache?.();
      unsubscribeProjects?.();
      controls?.destroy();
      pendingCameraPose = null;
      pendingOwnerCameraPreview = null;
      ownerCameraOverrideActive = false;
      ownerAuthoredCamera = null;
      if (ownerCameraPreviewActive) {
        ownerCameraPreviewActive = false;
        try { runtime?.finishOwnerCameraPreview?.(); }
        catch { /* Closing an observer cannot fail on an optional native preview. */ }
      }
      root.removeEventListener("pointerdown", dismissOutsidePanels);
      root.removeEventListener("click", click);
      root.removeEventListener("change", change);
      root.removeEventListener("keydown", keyDown);
      disclosure?.removeEventListener?.("toggle", disclosureChanged);
      browser.removeEventListener?.("codex:camera-guidance-pose", synchronizeGuidedCamera);
      browser.removeEventListener?.(CAMERA_AUTO_FOLLOW_CHANGE_EVENT, synchronizeAutoFollow);
      activeInvocations.clear();
      exports.clear();
      pendingDownloadBytes = 0;
    },
  };
}

export default createStudioUI;
