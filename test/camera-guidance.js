export const CAMERA_GUIDANCE_PREFERENCE_KEY = "codex-modeling.camera-guidance";
export const CAMERA_GUIDANCE_CHANGE_EVENT = "codex:camera-guidance-change";
export const CAMERA_GUIDANCE_USER_INPUT_EVENT = "codex:camera-guidance-user-input";
export const CAMERA_GUIDANCE_POSE_EVENT = "codex:camera-guidance-pose";
export const CAMERA_AUTO_FOLLOW_PREFERENCE_KEY = "codex-modeling.auto-follow";
export const CAMERA_AUTO_FOLLOW_CHANGE_EVENT = "codex:camera-auto-follow-change";

const USER_INPUT_COOLDOWN_MILLISECONDS = 750;
const MAX_GUIDANCE_FRAMES = 8;
const MAX_AUTO_FOLLOW_SETTLE_MILLISECONDS = 30_000;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function enabled(scope) {
  try {
    return scope.localStorage?.getItem(CAMERA_GUIDANCE_PREFERENCE_KEY) !== "off";
  } catch {
    return true;
  }
}

function cameraEntity(scene) {
  const entries = Object.entries(scene?.entities ?? {})
    .filter(([, entity]) => entity.components?.["oriel.camera"]);
  return entries.find(([, entity]) => entity.components["oriel.camera"].active === true)
    ?? entries[0] ?? null;
}

function validPosition(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function samePosition(left, right) {
  return validPosition(left) && validPosition(right)
    && left.every((coordinate, index) => Math.abs(coordinate - right[index]) <= 0.00001);
}

const GEOMETRY_COMPONENTS = Object.freeze(["oriel.primitive", "oriel.mesh_modeling",
  "oriel.procedural_mesh", "oriel.asset"]);

function renderableEntity(entity) {
  return entity && GEOMETRY_COMPONENTS.some((component) =>
    entity.components?.[component] !== undefined);
}

function geometrySignature(entity) {
  if (!renderableEntity(entity)) return null;
  const boundedComponent = (component) => {
    if (!component || typeof component !== "object") return component ?? null;
    const result = {};
    for (const [field, value] of Object.entries(component)) {
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
        result[field] = value;
      } else if (field === "primitive") {
        result[field] = boundedComponent(value);
      } else if (Array.isArray(value)) {
        result[field] = value.length <= 4
          && value.every((coordinate) => typeof coordinate === "number")
          ? value : { length: value.length };
      }
    }
    return result;
  };
  return JSON.stringify({
    parent: entity.parent ?? null,
    transform: entity.components?.["oriel.transform"] ?? null,
    geometry: GEOMETRY_COMPONENTS.map((component) =>
      boundedComponent(entity.components?.[component])),
  });
}

/** Guide the genuine visible owner camera without authoring or persisting its pose. */
export function createCameraGuidance({ store, inspection, runtime, scope = globalThis,
  cooldownMilliseconds = USER_INPUT_COOLDOWN_MILLISECONDS } = {}) {
  if (!store || typeof store.getScene !== "function"
      || typeof inspection?.focusTarget !== "function"
      || typeof runtime?.previewOwnerCameraPose !== "function"
      || typeof runtime?.finishOwnerCameraPreview !== "function") {
    throw new TypeError("Visible camera guidance requires the actual scene, native owner camera, and spatial framing.");
  }

  let interacting = false;
  let lastInteraction = Number.NEGATIVE_INFINITY;
  let active = null;
  let disposed = false;
  let automaticEnabled = true;
  try {
    automaticEnabled = scope.sessionStorage?.getItem(CAMERA_AUTO_FOLLOW_PREFERENCE_KEY) !== "off";
  } catch { /* Browser policy can deny session storage; dedicated events remain authoritative. */ }
  let ownerCheckpoint = null;
  try { ownerCheckpoint = store.getInspectionCheckpoint?.() ?? null; }
  catch { /* Minimal stores do not expose authenticated project checkpoints. */ }
  let lastRevision = typeof store.getRevision === "function"
    ? store.getRevision() : store.getState?.().revision;
  let previousEntities = (store.getState?.().scene ?? store.getScene()).entities ?? {};
  let pendingFollow = null;
  let followQueued = false;
  let automaticFollow = null;
  let automaticSettle = null;
  let unsubscribe = null;
  let rendererInvalidated = false;
  let rendererGeneration = null;
  let gestureGeneration = 0;
  const timestamp = () => typeof scope.performance?.now === "function"
    ? scope.performance.now() : Date.now();

  function runtimeStatus() {
    try { return runtime.status?.() ?? null; }
    catch { return null; }
  }

  function rendererIdentity() {
    const status = runtimeStatus();
    if (!status) return null;
    return {
      runtimeIncarnation: status.runtimeIncarnation ?? null,
      rendererGeneration: status.rendererGeneration
        ?? status.rendererLease?.generation ?? null,
      invalidationEpoch: status.invalidationEpoch
        ?? status.rendererLease?.invalidationEpoch ?? null,
    };
  }

  function sameRendererDevice(expected) {
    if (rendererInvalidated) return false;
    const status = runtimeStatus();
    if (status && ["failed", "reconciling", "disposed", "lost", "suspended"]
      .includes(status.phase)) return false;
    if (!expected) return true;
    const current = rendererIdentity();
    return current !== null
      && ["runtimeIncarnation", "rendererGeneration"]
        .every((field) => expected[field] === null || current[field] === expected[field]);
  }

  function sameRenderer(expected) {
    if (!sameRendererDevice(expected)) return false;
    const status = runtimeStatus();
    if (status && (status.ready === false || status.phase === "settling")) return false;
    if (!expected) return true;
    const current = rendererIdentity();
    return current !== null && (expected.invalidationEpoch === null
      || current.invalidationEpoch === expected.invalidationEpoch);
  }

  function assertRenderer(expected) {
    if (!currentOwner()) {
      throw failure("STALE_PROJECT", "The current owner no longer controls this visible camera.");
    }
    if (!sameRenderer(expected)) {
      throw failure("RENDERER_INVALIDATED",
        "The visible camera belongs to an invalidated native renderer generation.");
    }
  }

  function currentOwner() {
    if (disposed || store.lifecycle?.().retired === true) return false;
    if (typeof store.getInspectionCheckpoint !== "function") return true;
    let current;
    try { current = store.getInspectionCheckpoint(); }
    catch { return false; }
    return current?.retired !== true && current?.quiesced !== true
      && (ownerCheckpoint?.projectId === undefined
        || current?.projectId === ownerCheckpoint.projectId)
      && (ownerCheckpoint?.ownerGeneration === undefined
        || current?.ownerGeneration === ownerCheckpoint.ownerGeneration);
  }

  function followEnabled() {
    return !disposed && automaticEnabled && enabled(scope);
  }

  function latestTarget(entities = previousEntities) {
    return Object.values(entities).some(renderableEntity) ? "scene" : null;
  }

  function ownerFraming() {
    let pose;
    try { pose = runtime.getOwnerCameraPose?.(); }
    catch { return {}; }
    const lookAt = pose?.lookAt ?? pose?.target;
    if (!validPosition(pose?.position) || !validPosition(lookAt)) return {};
    const [horizontal, vertical, depth] = pose.position
      .map((coordinate, index) => coordinate - lookAt[index]);
    const distance = Math.hypot(horizontal, vertical, depth);
    if (!Number.isFinite(distance) || distance <= 0.00001) return {};
    return {
      preset: "custom",
      azimuthDegrees: Math.atan2(horizontal, depth) * 180 / Math.PI,
      elevationDegrees: Math.asin(Math.max(-1, Math.min(1, vertical / distance)))
        * 180 / Math.PI,
    };
  }

  function queueFollow({ revision = lastRevision, target } = {}) {
    const device = rendererIdentity();
    if (!followEnabled() || !currentOwner() || !sameRendererDevice(device)) return;
    const selected = target ?? latestTarget();
    if (selected === null) return;
    pendingFollow = { revision, target: selected, device,
      gestureGeneration, navigationToken: ownerNavigationToken() };
    automaticFollow?.abort(failure("STALE_REVISION",
      "A newer accepted modeling revision replaced automatic camera framing."));
    if (!sameRenderer(device)) {
      settleFollow(device);
      return;
    }
    if (followQueued) return;
    followQueued = true;
    Promise.resolve().then(async () => {
      followQueued = false;
      const request = pendingFollow;
      pendingFollow = null;
      if (request === null || !followEnabled() || !currentOwner()
          || !sameRendererDevice(request.device)
          || request.gestureGeneration !== gestureGeneration
          || request.navigationToken !== null
            && ownerNavigationToken() !== request.navigationToken) return;
      if (!sameRenderer(request.device)) {
        pendingFollow = request;
        settleFollow(request.device);
        return;
      }
      const revision = typeof store.getRevision === "function"
        ? store.getRevision() : store.getState?.().revision;
      if (Number.isSafeInteger(request.revision) && revision !== request.revision) return;
      const controller = new AbortController();
      automaticFollow = controller;
      try {
        await guide({ target: request.target, framing: ownerFraming(),
          expectedRevision: request.revision, signal: controller.signal });
      } catch {
        // Automatic follow is best-effort: native rejection, stale snapshots, and
        // empty geometry never fail or replay an already accepted scene mutation.
      } finally {
        if (automaticFollow === controller) automaticFollow = null;
      }
    });
  }

  function ownerNavigationToken() {
    if (typeof runtime.getOwnerNavigationToken !== "function") return null;
    try {
      const token = runtime.getOwnerNavigationToken(runtime.getOwnerCameraPose?.());
      return Number.isSafeInteger(token) ? token : null;
    } catch { return null; }
  }

  function settleFollow(device) {
    if (automaticSettle || typeof runtime.waitForReady !== "function") return;
    const controller = new AbortController();
    automaticSettle = controller;
    Promise.resolve().then(async () => {
      try {
        await runtime.waitForReady({
          signal: controller.signal,
          timeoutMs: MAX_AUTO_FOLLOW_SETTLE_MILLISECONDS,
          ...(device?.runtimeIncarnation == null ? {} : {
            runtimeIncarnation: device.runtimeIncarnation,
          }),
          ...(device?.rendererGeneration == null ? {} : {
            rendererGeneration: device.rendererGeneration,
          }),
          ...(ownerCheckpoint?.projectId === undefined ? {} : {
            projectId: ownerCheckpoint.projectId,
          }),
        });
        if (controller.signal.aborted || automaticSettle !== controller
            || !followEnabled() || !currentOwner() || !sameRendererDevice(device)) return;
        const request = pendingFollow;
        if (!request || request.gestureGeneration !== gestureGeneration
            || request.navigationToken !== null
              && ownerNavigationToken() !== request.navigationToken) {
          pendingFollow = null;
          return;
        }
        const revision = typeof store.getRevision === "function"
          ? store.getRevision() : store.getState?.().revision;
        pendingFollow = null;
        queueFollow({ revision, target: latestTarget() });
      } catch {
        // An owner change, genuine device failure, cancellation, or bounded
        // presentation timeout cannot move the current owner's manual camera.
      } finally {
        if (automaticSettle === controller) automaticSettle = null;
      }
    });
  }

  const sceneChanged = (state) => {
    if (disposed || !Number.isSafeInteger(state?.revision)
        || Number.isSafeInteger(lastRevision) && state.revision <= lastRevision) return;
    const entities = state.scene?.entities ?? store.getScene().entities ?? {};
    let geometryChanged = false;
    for (const [entityId, entity] of Object.entries(entities)) {
      if (geometrySignature(entity) !== geometrySignature(previousEntities[entityId])) {
        geometryChanged = true;
      }
    }
    if (!geometryChanged) {
      geometryChanged = Object.entries(previousEntities).some(([entityId, entity]) =>
        renderableEntity(entity) && !Object.hasOwn(entities, entityId));
    }
    previousEntities = entities;
    lastRevision = state.revision;
    if (!geometryChanged || !followEnabled() || !currentOwner()) return;
    queueFollow({ revision: state.revision, target: latestTarget(entities) });
  };

  const userInput = (event) => {
    const phase = event?.detail?.phase;
    if (phase === "start" || phase === "instant") gestureGeneration += 1;
    interacting = phase === "start" ? true : phase === "end" ? false : interacting;
    lastInteraction = timestamp();
    active?.abort(failure("USER_CAMERA_ACTIVE",
      "Camera guidance stopped because the user is controlling the visible camera."));
    automaticSettle?.abort(failure("USER_CAMERA_ACTIVE",
      "Automatic camera follow stopped because the owner moved the visible camera."));
    pendingFollow = null;
  };
  const preferenceChange = (event) => {
    if (event?.detail?.enabled === false || !enabled(scope)) {
      active?.abort(failure("CAMERA_GUIDANCE_DISABLED",
        "The user disabled automatic agent camera guidance."));
    } else if (event?.detail?.enabled === true && automaticEnabled) {
      queueFollow();
    }
  };
  const automaticPreferenceChange = (event) => {
    if (typeof event?.detail?.enabled !== "boolean") return;
    if (event.detail.reason === "user_motion") gestureGeneration += 1;
    automaticEnabled = event.detail.enabled;
    if (!automaticEnabled) {
      pendingFollow = null;
      automaticSettle?.abort(failure("CAMERA_AUTO_FOLLOW_DISABLED",
        "The user disabled automatic modeling camera follow for this tab."));
      automaticFollow?.abort(failure("CAMERA_AUTO_FOLLOW_DISABLED",
        "The user disabled automatic modeling camera follow for this tab."));
      return;
    }
    lastInteraction = Number.NEGATIVE_INFINITY;
    queueFollow();
  };
  scope.addEventListener?.(CAMERA_GUIDANCE_USER_INPUT_EVENT, userInput);
  scope.addEventListener?.(CAMERA_GUIDANCE_CHANGE_EVENT, preferenceChange);
  scope.addEventListener?.(CAMERA_AUTO_FOLLOW_CHANGE_EVENT, automaticPreferenceChange);
  if (typeof store.subscribe === "function") unsubscribe = store.subscribe(sceneChanged);

  function yieldedToUser({ framesPresented = 0, lastPose = null, projection } = {}) {
    const sceneRevision = typeof store.getRevision === "function"
      ? store.getRevision() : store.getState?.().revision;
    const cameraMoved = framesPresented > 0;
    return {
      status: "yielded",
      reason: "user_active",
      cameraMoved,
      targetReached: false,
      framesPresented,
      transient: true,
      revision: sceneRevision,
      sceneRevision,
      ownerCameraPreserved: !cameraMoved,
      ...(lastPose === null ? {} : {
        position: [...lastPose.position],
        lookAt: [...lastPose.lookAt],
      }),
      ...(projection === undefined ? {} : { projection }),
    };
  }

  async function guide({ target, framing = {}, expectedRevision, signal } = {}) {
    if (disposed) {
      throw failure("DISPOSED", "The retired modeling camera guidance cannot move the owner camera.");
    }
    if (!enabled(scope)) {
      throw failure("CAMERA_GUIDANCE_DISABLED",
        "Automatic agent camera guidance is turned off in this browser.");
    }
    const initialRenderer = rendererIdentity();
    assertRenderer(initialRenderer);
    if (interacting || timestamp() - lastInteraction < cooldownMilliseconds) {
      return yieldedToUser();
    }
    if (signal?.aborted) throw signal.reason ?? failure("CANCELLED", "Camera guidance was cancelled.");
    active?.abort(failure("CANCELLED", "A newer camera guidance request replaced this view."));
    const controller = new AbortController();
    active = controller;
    const abortExternal = () => controller.abort(signal.reason
      ?? failure("CANCELLED", "Camera guidance was cancelled."));
    signal?.addEventListener?.("abort", abortExternal, { once: true });
    let framesPresented = 0;
    let lastPose = null;
    let actualProjection;

    try {
      if (typeof runtime.getOwnerCameraProjection === "function") {
        actualProjection = await runtime.getOwnerCameraProjection();
        if (!actualProjection || !Number.isFinite(actualProjection.verticalFovDegrees)
            || !Number.isFinite(actualProjection.aspectRatio ?? actualProjection.aspect)) {
          throw failure("CAPABILITY_UNAVAILABLE",
            "The actual owner camera projection is unavailable for transient guidance.");
        }
        for (const [field, actual] of [["verticalFovDegrees", actualProjection.verticalFovDegrees],
          ["aspect", actualProjection.aspectRatio ?? actualProjection.aspect]]) {
          if (framing[field] !== undefined && Math.abs(framing[field] - actual) > 0.0001) {
            throw failure("INVALID_ARGUMENT",
              `Visible camera guidance cannot change its actual owner ${field}; use the existing projection.`);
          }
        }
      }
      const resolvedFraming = actualProjection === undefined ? framing : {
        ...framing,
        verticalFovDegrees: actualProjection.verticalFovDegrees,
        aspect: actualProjection.aspectRatio ?? actualProjection.aspect,
        ...(Number.isFinite(actualProjection.near) ? { near: actualProjection.near } : {}),
        ...(Number.isFinite(actualProjection.far) ? { far: actualProjection.far } : {}),
      };
      const framed = await inspection.focusTarget({ target, framing: resolvedFraming,
        signal: controller.signal });
      if (controller.signal.aborted) throw controller.signal.reason;
      assertRenderer(initialRenderer);
      const camera = cameraEntity(store.getScene());
      if (!camera) {
        throw failure("CAMERA_UNAVAILABLE", "The current scene has no real visible owner camera.");
      }
      const position = framed?.pose?.position;
      const lookAt = framed?.pose?.lookAt ?? framed?.pose?.target;
      if (!validPosition(position) || !validPosition(lookAt)) {
        throw failure("INVALID_CAMERA_POSE",
          "Genuine spatial framing did not return a valid visible camera pose.");
      }
      const sceneRevision = typeof store.getRevision === "function"
        ? store.getRevision() : store.getState?.().revision;
      if (Number.isSafeInteger(expectedRevision) && expectedRevision !== sceneRevision
          || Number.isSafeInteger(framed.revision) && framed.revision !== sceneRevision) {
        throw failure("STALE_REVISION", "The framed modeling scene changed before camera guidance.");
      }
      let currentPose = null;
      try { currentPose = runtime.getOwnerCameraPose?.(); }
      catch { /* Fall back to the actual authored camera when native pose reads are absent. */ }
      const startPosition = validPosition(currentPose?.position)
        ? currentPose.position
        : camera[1].components?.["oriel.transform"]?.translation;
      const startTarget = validPosition(currentPose?.lookAt ?? currentPose?.target)
        ? currentPose.lookAt ?? currentPose.target
        : camera[1].components?.["oriel.camera"]?.lookAt;
      if (samePosition(startPosition, position) && samePosition(startTarget, lookAt)) {
        return {
          status: "already_framed",
          revision: sceneRevision,
          sceneRevision,
          entityId: camera[0],
          cameraMoved: false,
          targetReached: true,
          framesPresented: 0,
          ownerCameraPreserved: true,
          transient: true,
          position: [...position],
          lookAt: [...lookAt],
          ...(actualProjection === undefined ? {} : { projection: actualProjection }),
          ...(framed.entityId === undefined ? {} : { targetEntityId: framed.entityId }),
        };
      }
      const reducedMotion = scope.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
        === true;
      const frameCount = !reducedMotion && typeof scope.requestAnimationFrame === "function"
        && validPosition(startPosition) && validPosition(startTarget)
        ? MAX_GUIDANCE_FRAMES : 1;
      const EventConstructor = scope.CustomEvent ?? globalThis.CustomEvent;

      for (let frame = 1; frame <= frameCount; frame += 1) {
        assertRenderer(initialRenderer);
        if (controller.signal.aborted || active !== controller) {
          throw controller.signal.reason ?? failure("CANCELLED", "Camera guidance was replaced.");
        }
        const progress = frame / frameCount;
        const eased = progress * progress * (3 - 2 * progress);
        const currentPosition = frame === frameCount ? [...position]
          : startPosition.map((value, index) => value + (position[index] - value) * eased);
        const currentTarget = frame === frameCount ? [...lookAt]
          : startTarget.map((value, index) => value + (lookAt[index] - value) * eased);
        await runtime.previewOwnerCameraPose({ position: currentPosition,
          lookAt: currentTarget });
        if (controller.signal.aborted || active !== controller) {
          throw controller.signal.reason ?? failure("CANCELLED", "Camera guidance was replaced.");
        }
        assertRenderer(initialRenderer);
        framesPresented += 1;
        lastPose = { position: [...currentPosition], lookAt: [...currentTarget] };
        const nextRevision = typeof store.getRevision === "function"
          ? store.getRevision() : store.getState?.().revision;
        if (Number.isSafeInteger(sceneRevision) && nextRevision !== sceneRevision) {
          throw failure("STALE_REVISION", "The modeling scene changed during camera guidance.");
        }
        if (typeof scope.dispatchEvent === "function" && typeof EventConstructor === "function") {
          scope.dispatchEvent(new EventConstructor(CAMERA_GUIDANCE_POSE_EVENT, {
            detail: { position: [...currentPosition], target: [...currentTarget],
              lookAt: [...currentTarget] },
          }));
        }
      }
      await runtime.finishOwnerCameraPreview();
      if (controller.signal.aborted) throw controller.signal.reason;
      assertRenderer(initialRenderer);
      return {
        status: "framed",
        revision: sceneRevision,
        sceneRevision,
        entityId: camera[0],
        cameraMoved: true,
        targetReached: true,
        framesPresented,
        ownerCameraPreserved: false,
        transient: true,
        position: [...position],
        lookAt: [...lookAt],
        ...(actualProjection === undefined ? {} : { projection: actualProjection }),
        ...(framed.entityId === undefined ? {} : { targetEntityId: framed.entityId }),
      };
    } catch (error) {
      if (controller.signal.reason?.code === "USER_CAMERA_ACTIVE") {
        return yieldedToUser({ framesPresented, lastPose, projection: actualProjection });
      }
      throw error;
    } finally {
      if (controller.signal.aborted && active === controller && !interacting
          && controller.signal.reason?.code !== "USER_CAMERA_ACTIVE") {
        try { await runtime.finishOwnerCameraPreview(); }
        catch { /* Native cancellation must not replace the true owner-side failure. */ }
      }
      signal?.removeEventListener?.("abort", abortExternal);
      if (active === controller) active = null;
    }
  }

  return Object.freeze({
    guide,
    isEnabled: () => !disposed && enabled(scope),
    isAutoFollowEnabled: followEnabled,
    captureRecoveryPose() {
      if (!currentOwner() || !sameRenderer(rendererIdentity())) return null;
      let pose;
      try { pose = runtime.getOwnerCameraPose?.(); }
      catch { return null; }
      const lookAt = pose?.lookAt ?? pose?.target;
      if (!validPosition(pose?.position) || !validPosition(lookAt)) return null;
      let navigationToken = null;
      try {
        const token = runtime.getOwnerNavigationToken?.(pose);
        if (Number.isSafeInteger(token)) navigationToken = token;
      } catch { return null; }
      return Object.freeze({
        pose: Object.freeze({ position: Object.freeze([...pose.position]),
          lookAt: Object.freeze([...lookAt]) }),
        gestureGeneration,
        navigationToken,
        ownerProjectId: ownerCheckpoint?.projectId ?? null,
        ownerGeneration: ownerCheckpoint?.ownerGeneration ?? null,
        renderer: rendererIdentity(),
      });
    },
    async restoreRecoveryPose(captured) {
      if (!captured || captured.gestureGeneration !== gestureGeneration
          || !currentOwner() || !sameRenderer(rendererIdentity())
          || captured.ownerProjectId !== null
            && captured.ownerProjectId !== ownerCheckpoint?.projectId
          || captured.ownerGeneration !== null
            && captured.ownerGeneration !== ownerCheckpoint?.ownerGeneration
          || !validPosition(captured.pose?.position)
          || !validPosition(captured.pose?.lookAt)) return false;
      const currentRenderer = rendererIdentity();
      if (captured.navigationToken !== null && captured.renderer !== null
          && currentRenderer !== null
          && ["runtimeIncarnation", "rendererGeneration", "invalidationEpoch"]
            .every((field) => captured.renderer[field] === currentRenderer[field])) {
        let currentPose;
        let token;
        try {
          currentPose = runtime.getOwnerCameraPose?.();
          token = runtime.getOwnerNavigationToken?.(currentPose);
        } catch { return false; }
        if (token !== captured.navigationToken) return false;
      }
      const beforeGesture = gestureGeneration;
      try {
        assertRenderer(currentRenderer);
        await runtime.previewOwnerCameraPose({ position: [...captured.pose.position],
          lookAt: [...captured.pose.lookAt] });
        if (beforeGesture !== gestureGeneration || !currentOwner()
            || !sameRenderer(currentRenderer)) return false;
        await runtime.finishOwnerCameraPreview();
        if (beforeGesture !== gestureGeneration || !currentOwner()
            || !sameRenderer(currentRenderer)) return false;
      } catch { return false; }
      const EventConstructor = scope.CustomEvent ?? globalThis.CustomEvent;
      if (typeof scope.dispatchEvent === "function" && typeof EventConstructor === "function") {
        scope.dispatchEvent(new EventConstructor(CAMERA_GUIDANCE_POSE_EVENT, {
          detail: { position: [...captured.pose.position], target: [...captured.pose.lookAt],
            lookAt: [...captured.pose.lookAt] },
        }));
      }
      return true;
    },
    invalidateRendererGeneration(generation) {
      if (disposed) return false;
      rendererInvalidated = true;
      rendererGeneration = generation ?? null;
      pendingFollow = null;
      const reason = failure("RENDERER_INVALIDATED",
        "The owner camera's genuine native renderer generation was invalidated.");
      automaticFollow?.abort(reason);
      automaticSettle?.abort(reason);
      active?.abort(reason);
      return true;
    },
    restoreRendererGeneration(generation) {
      if (!currentOwner()) return false;
      const status = runtimeStatus();
      if (status && (status.ready !== true || status.phase !== "ready")) return false;
      const actual = rendererIdentity();
      const requested = typeof generation === "object" && generation !== null
        ? generation.rendererGeneration ?? generation.generation : generation;
      if (requested !== undefined && requested !== null
          && actual?.rendererGeneration !== null
          && String(actual.rendererGeneration) !== String(requested)) return false;
      rendererInvalidated = false;
      rendererGeneration = requested ?? actual?.rendererGeneration ?? rendererGeneration;
      return true;
    },
    cancel() {
      if (disposed) return false;
      if (!active) return false;
      active.abort(failure("CANCELLED", "The current project camera guidance was cancelled."));
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingFollow = null;
      automaticSettle?.abort(failure("CANCELLED", "The modeling camera follow was disposed."));
      automaticFollow?.abort(failure("CANCELLED", "The modeling camera follow was disposed."));
      active?.abort(failure("CANCELLED", "The modeling camera guidance was disposed."));
      unsubscribe?.();
      unsubscribe = null;
      scope.removeEventListener?.(CAMERA_GUIDANCE_USER_INPUT_EVENT, userInput);
      scope.removeEventListener?.(CAMERA_GUIDANCE_CHANGE_EVENT, preferenceChange);
      scope.removeEventListener?.(CAMERA_AUTO_FOLLOW_CHANGE_EVENT, automaticPreferenceChange);
    },
  });
}
