import { createBrowserRuntimeBridge } from
  "../../../tools/browser-authoring-core/src/runtime-bridge.js";
import { createSceneStore } from
  "../../../tools/browser-authoring-core/src/scene-store.js";
import { createGeometryComputeService } from
  "../../../tools/browser-authoring-core/src/geometry-compute.js";
import { loadAuthenticatedModelingKernel } from
  "../../../tools/browser-authoring-core/src/modeling-kernel-release.js";
import { createReferenceCatalog } from "/modules/reference-catalog.js";
import { createInspectionCaptureService } from "/modules/inspection-capture.js";
import { createCameraGuidance } from "/modules/camera-guidance.js";
import { createGroupedExportService } from "/modules/grouped-export.js";
import { createDeviceBrowserPersistence as createDefaultDevicePersistence } from "/modules/device-browser-persistence.js";
import { createModelImportService as createDefaultModelImportService } from
  "../../../tools/browser-authoring-core/src/model-import-service.js";
import { createModelImportSessions as createDefaultModelImportSessions } from "/modules/model-import-session.js";
import { createMaterialAuthoringService as createDefaultMaterialAuthoringService } from "/modules/material-authoring-service.js";
import { createMaterialUploadSessions as createDefaultMaterialUploadSessions } from "/modules/material-upload-session.js";
import { createModelArtifactRegistry as createDefaultModelArtifactRegistry } from "/modules/model-artifact-registry.js";
import { createStudioTools, validateStudioToolInput } from "/modules/tool-definitions.js";
import { createPublicToolCatalog } from "/modules/studio-public-tool-catalog.js";
import { encodePublicToolEnvelope } from "/modules/studio-public-tool-protocol.js";
import { createStudioUI } from "/modules/studio-ui.js";
import { createWebMcpRegistrar } from
  "../../../tools/web-editor-webmcp/src/browser/registrar.js";

export { loadAuthenticatedModelingKernel };

const DEFAULT_RUNTIME_MODULE_URL = "/assets/oriel.js";
const DEFAULT_RUNTIME_WASM_URL = "/assets/oriel_bg.wasm";
const DEFAULT_SEED_MANIFEST_URL = "/assets/seed-manifest.json";
const DEFAULT_RUNTIME_PROVENANCE_URL = "/assets/runtime-provenance.json";
const DEFAULT_MODELING_KERNEL_MANIFEST_URL = "/assets/oriel_modeling_manifest.json";
const DEFAULT_RUNTIME_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_PRESENTATION_TIMEOUT_MILLISECONDS = 30_000;
const MAX_SEED_ASSETS = 4_096;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_CONCURRENT_ASSET_REQUESTS = 8;
const MAX_PAGE_TOOL_INPUT_BYTES = 1_048_576;
const MAX_PENDING_EXPORTS = 8;
const MAX_PENDING_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_SAVED_DEMO_PROJECTS = 10;
const VISIBLE_RENDERER_OBSERVATION_MILLISECONDS = 250;
const HIDDEN_RENDERER_OBSERVATION_MILLISECONDS = 2_000;
const READINESS_FORMAT = "oriel.webmcp-document/1";
const PRESENTATION_FORMAT = "oriel.modeling-studio-presentation/1";
const PAGE_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const PROJECT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_PROJECT_NAME_LENGTH = 80;
const LEGACY_STUDIO_ENVIRONMENT_ID = "b9100000-0000-4000-8000-000000000001";
const LEGACY_STUDIO_FLOOR_ID = "b9100000-0000-4000-8000-000000000002";
const LEGACY_STUDIO_CAMERA_ID = "b9100000-0000-4000-8000-000000000007";
const STUDIO_STARTER_CUBE_ID = "b9100000-0000-4000-8000-000000000008";
const LEGACY_STUDIO_FLOORS = Object.freeze([
  {
    name: "Studio Floor",
    parent: LEGACY_STUDIO_ENVIRONMENT_ID,
    components: {
      "oriel.transform": { translation: [0, 0, 0] },
      "oriel.primitive": { shape: "plane", size: [24, 24] },
      "oriel.material": {
        baseColor: [0.23, 0.245, 0.27, 1],
        metallic: 0.015,
        perceptualRoughness: 0.84,
        reflectance: 0.34,
      },
    },
  },
  {
    name: "Studio Floor",
    parent: LEGACY_STUDIO_ENVIRONMENT_ID,
    components: {
      "oriel.transform": { translation: [0, 0, 0] },
      "oriel.primitive": { shape: "plane", size: [200, 200] },
      "oriel.material": {
        baseColor: [0.32, 0.32, 0.32, 1],
        metallic: 0,
        perceptualRoughness: 0.92,
        reflectance: 0.25,
      },
    },
  },
]);
const LEGACY_STUDIO_BASELINE = Object.freeze([
  ["b9100000-0000-4000-8000-000000000001", "oriel.environment", {
    clock: { phaseHours: 15.4, anchorUnixMs: 1784937600000,
      autoplay: false, dayLengthSeconds: 1800 },
    sunLightEntityId: "b9100000-0000-4000-8000-000000000004",
    latitudeDegrees: 32,
    solarAzimuthDegrees: 140,
    cloudCoverage: 0,
    cloudDensity: 0,
    cloudShadowStrength: 0,
    aerialPerspectiveStrength: 0.035,
    exposureCompensationEv: -0.12,
    quality: "high",
  }],
  ["b9100000-0000-4000-8000-000000000002", "oriel.primitive", {
    shape: "plane", size: [24, 24],
  }],
  ["b9100000-0000-4000-8000-000000000002", "oriel.material", {
    baseColor: [0.23, 0.245, 0.27, 1],
    metallic: 0.015,
    perceptualRoughness: 0.84,
    reflectance: 0.34,
  }],
  ["b9100000-0000-4000-8000-000000000004", "oriel.directionalLight", {
    color: [1, 0.91, 0.82], illuminance: 14500, shadowsEnabled: true,
  }],
  ["b9100000-0000-4000-8000-000000000005", "oriel.pointLight", {
    color: [0.76, 0.85, 1], intensity: 165000, range: 16, shadowsEnabled: false,
  }],
  ["b9100000-0000-4000-8000-000000000006", "oriel.pointLight", {
    color: [1, 0.83, 0.7], intensity: 110000, range: 15, shadowsEnabled: false,
  }],
  ["b9100000-0000-4000-8000-000000000007", "oriel.transform", {
    translation: [5, 3.4, 6.8],
  }],
  ["b9100000-0000-4000-8000-000000000007", "oriel.transform", {
    translation: [7, 6, 7],
  }],
  ["b9100000-0000-4000-8000-000000000007", "oriel.camera", {
    active: true,
    hdr: true,
    bloomIntensity: 0.035,
    lookAt: [0, 0.8, 0],
    perspective: { verticalFovDegrees: 40, near: 0.05, far: 120 },
  }],
]);

function equalSceneValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key)
      && equalSceneValue(left[key], right[key]));
}

function sceneOperationReferencesEntity(value, entityId) {
  if (value === entityId) return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((entry) => sceneOperationReferencesEntity(entry, entityId));
}

function replacePristineStudioStarter(seedScene, scene, operation, context) {
  const starter = seedScene?.entities?.[STUDIO_STARTER_CUBE_ID];
  if (!starter || context.revision !== 0 || context.operationIndex !== 0
      || !["mesh_create", "mesh_curve_create"].includes(operation.op)
      || operation.name === starter.name
      || sceneOperationReferencesEntity(context.operations, STUDIO_STARTER_CUBE_ID)
      || !equalSceneValue(scene, seedScene)
      || !equalSceneValue(scene.entities[STUDIO_STARTER_CUBE_ID], starter)
      || Object.values(scene.entities).some((entity) =>
        entity.parent === STUDIO_STARTER_CUBE_ID)) {
    return null;
  }
  return { op: "remove_entity", entityId: STUDIO_STARTER_CUBE_ID };
}

function legacyStudioBaselineOperations(restoredScene, seedScene) {
  if (!restoredScene?.entities || !seedScene?.entities) return [];
  const operations = LEGACY_STUDIO_BASELINE.flatMap(([entityId, component, legacy]) => {
    const restored = restoredScene.entities[entityId]?.components?.[component];
    const next = seedScene.entities[entityId]?.components?.[component];
    if (!next || !equalSceneValue(restored, legacy) || equalSceneValue(restored, next)) {
      return [];
    }
    return [{ op: "patch_component", entityId, component, mode: "replace", value: next }];
  });
  const floor = restoredScene.entities[LEGACY_STUDIO_FLOOR_ID];
  if (!seedScene.entities[LEGACY_STUDIO_FLOOR_ID]
      && LEGACY_STUDIO_FLOORS.some((baseline) => equalSceneValue(floor, baseline))
      && !Object.values(restoredScene.entities)
        .some((entity) => entity.parent === LEGACY_STUDIO_FLOOR_ID)) {
    operations.push({ op: "remove_entity", entityId: LEGACY_STUDIO_FLOOR_ID });
  }
  const restoredCamera = restoredScene.entities[LEGACY_STUDIO_CAMERA_ID];
  const seedCamera = seedScene.entities[LEGACY_STUDIO_CAMERA_ID];
  const restoredCameraComponent = restoredCamera?.components?.["oriel.camera"];
  const seedCameraComponent = seedCamera?.components?.["oriel.camera"];
  if (restoredCameraComponent?.hdr === true && seedCameraComponent?.hdr === false
      && equalSceneValue(restoredCameraComponent, { ...seedCameraComponent, hdr: true })
      && !operations.some((operation) => operation.entityId === LEGACY_STUDIO_CAMERA_ID
        && operation.component === "oriel.camera")) {
    operations.push({ op: "patch_component", entityId: LEGACY_STUDIO_CAMERA_ID,
      component: "oriel.camera", mode: "replace", value: seedCameraComponent });
  }
  return operations;
}

class StudioBootstrapError extends Error {
  constructor(message, { code = "BOOTSTRAP_FAILED", cause, unsupported = false } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StudioBootstrapError";
    this.code = code;
    this.unsupported = unsupported;
  }
}

function asBootstrapError(error, message = "Codex Modeling Studio could not start.") {
  if (error instanceof StudioBootstrapError) return error;
  return new StudioBootstrapError(error?.message || message, {
    code: error?.code || "BOOTSTRAP_FAILED",
    cause: error,
  });
}

function abortError(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Codex Modeling Studio was stopped.", "AbortError");
}

function safeLocation(scope) {
  try {
    return new URL(scope.location?.href || "https://invalid.local/");
  } catch (cause) {
    throw new StudioBootstrapError("The studio document URL is invalid.", {
      code: "INVALID_DOCUMENT_URL",
      cause,
    });
  }
}

function browserProjectStorage(scope) {
  try {
    return scope.localStorage;
  } catch {
    return undefined;
  }
}

function browserProjectSessionStorage(scope) {
  try {
    return scope.sessionStorage;
  } catch {
    return undefined;
  }
}

function validProjectIdentifier(value, legacyProjectId) {
  if (typeof value !== "string" || !PROJECT_IDENTIFIER.test(value)) return false;
  if (value === legacyProjectId) return true;
  if (!value.startsWith(`${legacyProjectId}:`)) return false;
  return PROJECT_UUID.test(value.slice(legacyProjectId.length + 1));
}

function safeProjectName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0 || name.length > MAX_PROJECT_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new StudioBootstrapError("A project name must contain 1–80 printable characters.", {
      code: "INVALID_PROJECT_NAME",
    });
  }
  return name;
}

function sameOriginUrl(value, scope, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new StudioBootstrapError(`${label} must be a bounded same-origin URL.`, {
      code: "INVALID_ASSET_URL",
    });
  }
  const base = safeLocation(scope);
  let url;
  try {
    url = new URL(value, base);
  } catch (cause) {
    throw new StudioBootstrapError(`${label} is not a valid URL.`, {
      code: "INVALID_ASSET_URL",
      cause,
    });
  }
  if (url.origin !== base.origin || url.username || url.password || url.search || url.hash) {
    throw new StudioBootstrapError(`${label} must remain on the studio origin.`, {
      code: "INVALID_ASSET_URL",
    });
  }
  return url.href;
}

function validateAssetPath(path, label) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 1_024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new StudioBootstrapError(`${label} is not a safe, project-relative asset path.`, {
      code: "INVALID_ASSET_PATH",
    });
  }
  return path;
}

async function checkedFetch(scope, value, { signal, label, accept } = {}) {
  const fetch = scope.fetch?.bind(scope);
  if (typeof fetch !== "function") {
    throw new StudioBootstrapError("The browser cannot load same-origin studio assets.", {
      code: "FETCH_UNAVAILABLE",
      unsupported: true,
    });
  }
  abortError(signal);
  const response = await fetch(sameOriginUrl(value, scope, label || "Asset URL"), {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    ...(accept ? { headers: { Accept: accept } } : {}),
    signal,
  });
  if (!response?.ok) {
    throw new StudioBootstrapError(
      `${label || "Studio asset"} could not be loaded (${response?.status ?? "network error"}).`,
      { code: "ASSET_FETCH_FAILED" },
    );
  }
  return response;
}

async function verifyExpectedDigest(scope, bytes, expectedDigest, path) {
  if (expectedDigest == null) return;
  const expected = String(expectedDigest).replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new StudioBootstrapError(`The seed digest for ${path} is malformed.`, {
      code: "INVALID_ASSET_DIGEST",
    });
  }
  if (typeof scope.crypto?.subtle?.digest !== "function") {
    throw new StudioBootstrapError("Web Crypto is required to verify studio seed assets.", {
      code: "WEB_CRYPTO_UNAVAILABLE",
      unsupported: true,
    });
  }
  const digest = new Uint8Array(await scope.crypto.subtle.digest("SHA-256", bytes));
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== expected) {
    throw new StudioBootstrapError(`The verified seed asset ${path} has unexpected bytes.`, {
      code: "ASSET_DIGEST_MISMATCH",
    });
  }
}

function normalizeSeedManifest(manifest, scope) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new StudioBootstrapError("The studio seed manifest is malformed.", {
      code: "INVALID_SEED_MANIFEST",
    });
  }
  const scene = manifest.scene;
  if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
    throw new StudioBootstrapError("The seed manifest does not describe its initial scene.", {
      code: "INVALID_SEED_MANIFEST",
    });
  }
  const assets = manifest.assets;
  if (!Array.isArray(assets) || assets.length > MAX_SEED_ASSETS) {
    throw new StudioBootstrapError("The seed manifest has an invalid or excessive asset closure.", {
      code: "INVALID_SEED_MANIFEST",
    });
  }
  const scenePath = validateAssetPath(scene.path, "Scene path");
  const seen = new Set([scenePath]);
  const normalizedAssets = assets.map((asset, index) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      throw new StudioBootstrapError(`Seed asset ${index + 1} is malformed.`, {
        code: "INVALID_SEED_MANIFEST",
      });
    }
    const path = validateAssetPath(asset.path, `Seed asset ${index + 1}`);
    if (seen.has(path)) {
      throw new StudioBootstrapError(`The seed manifest repeats asset ${path}.`, {
        code: "DUPLICATE_SEED_ASSET",
      });
    }
    seen.add(path);
    return {
      ...asset,
      path,
      url: sameOriginUrl(asset.url || `/assets/${path}`, scope, `Seed asset ${path}`),
    };
  });
  return {
    scenePath,
    sceneUrl: sameOriginUrl(scene.url, scope, "Seed scene URL"),
    sceneDigest: scene.sha256 || scene.digest,
    sceneBytes: scene.bytes,
    assetId: manifest.assetId || scene.assetId,
    revision: manifest.revision,
    assets: normalizedAssets,
  };
}

async function fetchSeedAsset(scope, asset, signal) {
  const response = await checkedFetch(scope, asset.url, {
    signal,
    label: `Seed asset ${asset.path}`,
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new StudioBootstrapError(`Seed asset ${asset.path} exceeds the browser asset limit.`, {
      code: "ASSET_TOO_LARGE",
    });
  }
  if (Number.isSafeInteger(asset.bytes) && bytes.byteLength !== asset.bytes) {
    throw new StudioBootstrapError(`Seed asset ${asset.path} does not match its declared size.`, {
      code: "ASSET_SIZE_MISMATCH",
    });
  }
  await verifyExpectedDigest(scope, bytes, asset.sha256 || asset.digest, asset.path);
  abortError(signal);
  return bytes;
}

export async function loadStudioSeed({
  scope = globalThis,
  manifestUrl = DEFAULT_SEED_MANIFEST_URL,
  signal,
  onProgress,
} = {}) {
  const manifestResponse = await checkedFetch(scope, manifestUrl, {
    signal,
    label: "Studio seed manifest",
    accept: "application/json",
  });
  const manifest = normalizeSeedManifest(await manifestResponse.json(), scope);
  const sceneResponse = await checkedFetch(scope, manifest.sceneUrl, {
    signal,
    label: "Initial modeling scene",
    accept: "application/json",
  });
  const sceneBytes = new Uint8Array(await sceneResponse.arrayBuffer());
  if (sceneBytes.byteLength > MAX_ASSET_BYTES) {
    throw new StudioBootstrapError("The initial modeling scene exceeds the browser asset limit.", {
      code: "ASSET_TOO_LARGE",
    });
  }
  if (Number.isSafeInteger(manifest.sceneBytes) && sceneBytes.byteLength !== manifest.sceneBytes) {
    throw new StudioBootstrapError("The initial modeling scene has an unexpected byte length.", {
      code: "ASSET_SIZE_MISMATCH",
    });
  }
  await verifyExpectedDigest(scope, sceneBytes, manifest.sceneDigest, manifest.scenePath);
  let scene;
  try {
    scene = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sceneBytes));
  } catch (cause) {
    throw new StudioBootstrapError("The initial modeling scene is not valid UTF-8 JSON.", {
      code: "INVALID_SEED_SCENE",
      cause,
    });
  }
  if (!scene || scene.format !== "oriel.scene/1" || !scene.entities) {
    throw new StudioBootstrapError("The initial scene is not a valid authored modeling scene.", {
      code: "INVALID_SEED_SCENE",
    });
  }

  const assets = new Map();
  const assetMetadata = new Map();
  let totalBytes = sceneBytes.byteLength;
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(MAX_CONCURRENT_ASSET_REQUESTS, manifest.assets.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < manifest.assets.length) {
      abortError(signal);
      const asset = manifest.assets[nextIndex++];
      const bytes = await fetchSeedAsset(scope, asset, signal);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_ASSET_BYTES) {
        throw new StudioBootstrapError("The initial scene exceeds the total browser asset limit.", {
          code: "ASSET_BUDGET_EXCEEDED",
        });
      }
      assets.set(asset.path, bytes);
      assetMetadata.set(asset.path, {
        mediaType: asset.mediaType || asset.mimeType,
        sha256: asset.sha256 || asset.digest,
        bytes: bytes.byteLength,
        readiness: "required",
      });
      onProgress?.({ loaded: ++completed, total: manifest.assets.length, path: asset.path });
    }
  }));

  return {
    scene,
    scenePath: manifest.scenePath,
    sceneAssetId: manifest.assetId || scene.assetId,
    assets,
    assetMetadata,
    requiredAssets: Array.from(assets.keys()).sort(),
    engineRevision: manifest.revision,
    totalBytes,
  };
}

function validateRuntimeProvenance(value, seedRevision) {
  const revision = value?.engineRevision;
  const digest = value?.releaseManifestSha256;
  const wasmDigest = value?.wasm?.sha256;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.format !== "oriel.webmcp-runtime-provenance/1" ||
      typeof revision !== "string" || !/^[0-9a-f]{40}$/u.test(revision) ||
      value.gitRevision !== revision ||
      value.source?.format !== "oriel.source-provenance/1" ||
      value.source?.orielRevision !== revision || value.source?.dirty !== false ||
      value.backend?.format !== "oriel.web-runtime-backend/1" ||
      value.backend?.backend !== "webgpu" || value.backend?.orielRevision !== revision ||
      value.backend?.dirty !== false || !Array.isArray(value.backend?.features) ||
      !value.backend.features.includes("editor-preview-runtime") ||
      typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest) ||
      typeof wasmDigest !== "string" || !/^[0-9a-f]{64}$/u.test(wasmDigest) ||
      !Number.isSafeInteger(value.wasm?.byteLength) || value.wasm.byteLength < 1 ||
      seedRevision !== undefined && seedRevision !== revision) {
    throw new StudioBootstrapError("The renderer provenance is not an exact clean WebGPU release.", {
      code: "INVALID_RUNTIME_PROVENANCE",
    });
  }
  return Object.freeze({
    engineRevision: revision,
    runtimeReleaseId: `sha256:${digest}`,
    wasmDigest: `sha256:${wasmDigest}`,
    authority: "verified-browser-local-runtime",
  });
}

async function loadRuntimeProvenance({ scope, url, seedRevision, value, required, signal }) {
  if (value !== undefined) return validateRuntimeProvenance(value, seedRevision);
  if (!required) return null;
  const response = await checkedFetch(scope, url, {
    signal,
    label: "Verified WebGPU renderer provenance",
    accept: "application/json",
  });
  return validateRuntimeProvenance(await response.json(), seedRevision);
}

async function probeWebGpu(scope, document) {
  if (scope.isSecureContext !== true) {
    throw new StudioBootstrapError("Codex Modeling Studio requires a secure HTTPS browser context.", {
      code: "INSECURE_CONTEXT",
      unsupported: true,
    });
  }
  try {
    if (scope.top !== scope.self) {
      throw new StudioBootstrapError("The modeling studio must run in a top-level browser tab.", {
        code: "EMBEDDED_DOCUMENT",
        unsupported: true,
      });
    }
  } catch (cause) {
    if (cause instanceof StudioBootstrapError) throw cause;
    throw new StudioBootstrapError("The modeling studio cannot verify top-level browser access.", {
      code: "EMBEDDED_DOCUMENT",
      cause,
      unsupported: true,
    });
  }
  const gpu = scope.navigator?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== "function") {
    throw new StudioBootstrapError("WebGPU is unavailable in this browser or device.", {
      code: "WEBGPU_UNAVAILABLE",
      unsupported: true,
    });
  }
  let adapter;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch (cause) {
    throw new StudioBootstrapError("The browser could not initialize a WebGPU adapter.", {
      code: "WEBGPU_ADAPTER_FAILED",
      cause,
      unsupported: true,
    });
  }
  if (!adapter) {
    throw new StudioBootstrapError("No compatible WebGPU graphics adapter is available.", {
      code: "WEBGPU_ADAPTER_UNAVAILABLE",
      unsupported: true,
    });
  }
  if (!document?.querySelector) {
    throw new StudioBootstrapError("The studio document is unavailable.", {
      code: "DOCUMENT_UNAVAILABLE",
    });
  }
  return adapter;
}

async function nextAnimationFrame(scope, signal) {
  abortError(signal);
  if (typeof scope.requestAnimationFrame === "function") {
    await new Promise((resolve) => scope.requestAnimationFrame(resolve));
  } else {
    await new Promise((resolve) => scope.setTimeout(resolve, 16));
  }
  abortError(signal);
}

async function waitForNativeRuntime(scope, document, {
  signal,
  timeoutMilliseconds = DEFAULT_RUNTIME_TIMEOUT_MILLISECONDS,
} = {}) {
  const now = scope.performance?.now?.bind(scope.performance) || Date.now;
  const deadline = now() + timeoutMilliseconds;
  while (now() < deadline) {
    const runtime = scope.__ORIEL_EDITOR_PREVIEW_RUNTIME__;
    const canvases = document.querySelectorAll?.("canvas") || [];
    const canvas = Array.from(canvases).find((candidate) => candidate.id !== "studio-canvas-placeholder");
    if (
      runtime &&
      typeof runtime.enqueue === "function" &&
      typeof runtime.takeReceipt === "function" &&
      typeof runtime.cancel === "function" &&
      canvas
    ) {
      return { runtime, canvas };
    }
    await nextAnimationFrame(scope, signal);
  }
  throw new StudioBootstrapError("The WebGPU runtime did not expose its native renderer.", {
    code: "NATIVE_RUNTIME_TIMEOUT",
  });
}

function synchronizedCanvas(scope, canvas) {
  const bounds = canvas?.getBoundingClientRect?.();
  const ratio = scope.devicePixelRatio || 1;
  return canvas?.isConnected !== false
    && Number.isSafeInteger(canvas?.width) && canvas.width > 0
    && Number.isSafeInteger(canvas?.height) && canvas.height > 0
    && bounds && Number.isFinite(bounds.width) && bounds.width > 0
    && Number.isFinite(bounds.height) && bounds.height > 0
    && canvas.width === Math.round(bounds.width * ratio)
    && canvas.height === Math.round(bounds.height * ratio);
}

async function waitForCanvasSynchronization(scope, canvas, {
  document = scope.document,
  signal,
  timeoutMilliseconds = DEFAULT_RUNTIME_TIMEOUT_MILLISECONDS,
} = {}) {
  const now = scope.performance?.now?.bind(scope.performance) || Date.now;
  const startedAt = now();
  const maximumHiddenWait = timeoutMilliseconds * 4;
  return new Promise((resolve, reject) => {
    let timer = null;
    let frame = null;
    let observer = null;
    let settled = false;
    let lastCheckedAt = startedAt;
    let visibleElapsed = 0;
    let wasVisible = document?.visibilityState !== "hidden";

    const cleanup = () => {
      if (timer !== null) scope.clearTimeout?.(timer);
      if (frame !== null) scope.cancelAnimationFrame?.(frame);
      timer = null;
      frame = null;
      observer?.disconnect?.();
      document?.removeEventListener?.("visibilitychange", check);
      scope.removeEventListener?.("resize", check);
      signal?.removeEventListener?.("abort", failIfAborted);
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(canvas);
    };

    function failIfAborted() {
      if (!signal?.aborted) return;
      finish(signal.reason instanceof Error ? signal.reason
        : new DOMException("Codex Modeling Studio was stopped.", "AbortError"));
    }

    function check() {
      if (settled) return;
      if (signal?.aborted) return failIfAborted();
      if (timer !== null) scope.clearTimeout?.(timer);
      if (frame !== null) scope.cancelAnimationFrame?.(frame);
      timer = null;
      frame = null;

      const checkedAt = now();
      if (wasVisible) visibleElapsed += Math.max(0, checkedAt - lastCheckedAt);
      lastCheckedAt = checkedAt;
      const visible = document?.visibilityState !== "hidden";
      wasVisible = visible;

      if (visible && synchronizedCanvas(scope, canvas)) return finish();
      if (visibleElapsed >= timeoutMilliseconds
          || checkedAt - startedAt >= maximumHiddenWait) {
        return finish(new StudioBootstrapError(
          "The native modeling canvas did not synchronize with its viewport.",
          { code: "NATIVE_CANVAS_TIMEOUT" },
        ));
      }

      const remainingVisibleTime = Math.max(1, timeoutMilliseconds - visibleElapsed);
      timer = scope.setTimeout(check, Math.min(25, remainingVisibleTime));
      if (visible && typeof scope.requestAnimationFrame === "function") {
        frame = scope.requestAnimationFrame(check);
      }
    }

    document?.addEventListener?.("visibilitychange", check);
    scope.addEventListener?.("resize", check);
    signal?.addEventListener?.("abort", failIfAborted, { once: true });
    if (typeof scope.ResizeObserver === "function") {
      try {
        observer = new scope.ResizeObserver(check);
        observer.observe(canvas);
        if (canvas.parentElement) observer.observe(canvas.parentElement);
      } catch {
        observer?.disconnect?.();
        observer = null;
      }
    }
    check();
  });
}

function mountNativeCanvas(document, canvas) {
  const mount = document.querySelector("#viewport-stage") || document.querySelector("#oriel-mount");
  if (!mount) {
    throw new StudioBootstrapError("The studio viewport mount is missing.", {
      code: "VIEWPORT_MISSING",
    });
  }
  for (const existing of Array.from(mount.querySelectorAll?.("canvas") || [])) {
    if (existing !== canvas) existing.remove();
  }
  if (canvas.parentElement !== mount) mount.append(canvas);
  canvas.id = "studio-canvas";
  canvas.setAttribute("aria-label", "Codex Modeling Studio 3D viewport");
  if (!canvas.hasAttribute("tabindex")) canvas.setAttribute("tabindex", "0");
  return canvas;
}

function presentationStatus(result, runtime) {
  const candidates = [result, result?.status, result?.receipt, result?.receipt?.status, runtime?.status?.()];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && "applied" in candidate) return candidate;
  }
  return null;
}

function dispatchStatus(document, state) {
  const renderer = document.querySelector("#renderer-status, [data-status='renderer']");
  const gpu = document.querySelector("#webgpu-status, [data-status='webgpu']");
  const webmcp = document.querySelector("#webmcp-status, [data-status='webmcp']");
  const agent = document.querySelector("#agent-bridge-status, [data-status='agent']");
  const message = document.querySelector("#status-message, [data-studio-status-message]");
  const viewport = document.querySelector("#viewport-stage");
  const startup = document.querySelector("#viewport-empty");
  const root = document.documentElement;
  if (root?.dataset) {
    root.dataset.orielState = state.phase;
    root.dataset.orielReadinessFormat = READINESS_FORMAT;
    root.dataset.orielDocumentGeneration = state.documentGeneration ?? "";
    root.dataset.orielRegistrationGeneration = String(state.registrationGeneration ?? 0);
    root.dataset.orielProjectGeneration = String(state.projectGeneration ?? 0);
    root.dataset.orielWebgpuReady = String(state.webgpuReady === true);
    root.dataset.orielRendererReady = String(state.rendererReady === true);
    root.dataset.orielRendererSettling = String(state.rendererSettling === true);
    root.dataset.orielOwnerFrameVisible = String(state.ownerFrameVisible === true);
    root.dataset.orielRecoveryRequired = String(state.recoveryRequired === true);
    root.dataset.orielWebmcpReady = String(state.webmcpReady === true);
    root.dataset.orielProjectSwitching = String(state.switching === true);
    root.dataset.orielToolCount = String(state.registeredNames.length);
    root.dataset.orielCatalogHash = state.catalogHash ?? "";
  }
  if (renderer) {
    renderer.textContent = state.rendererReady ? "Ready · WebGPU" : state.rendererLabel;
    renderer.dataset.state = state.rendererReady ? "ready" : state.unsupported ? "unsupported" : state.phase;
  }
  if (gpu) {
    const value = gpu.querySelector?.("[data-status-value]") || gpu;
    const failed = state.phase === "error" || state.phase === "recovery-required";
    value.textContent = state.webgpuReady ? "Ready" : state.unsupported ? "Unavailable"
      : failed ? "Failed" : state.webgpuAvailable ? "Starting" : "Checking";
    gpu.dataset.state = state.webgpuReady ? "ready" : state.unsupported ? "unsupported"
      : failed ? "error" : "pending";
  }
  if (webmcp) {
    const count = state.registeredNames.length;
    const value = webmcp.querySelector?.("[data-status-value]") || webmcp;
    value.textContent = state.webmcpReady
      ? `${count} tool${count === 1 ? "" : "s"}`
      : state.rendererReady ? "Unavailable" : "Waiting";
    webmcp.dataset.state = state.webmcpReady ? "ready" : state.rendererReady ? "unavailable" : "pending";
  }
  if (agent) {
    agent.textContent = state.agentBridgeObserved ? "Agent connected" : "Awaiting an agent";
    agent.dataset.state = state.agentBridgeObserved ? "connected" : "waiting";
  }
  if (message) message.textContent = state.message;
  const visibleOwnerFrame = Object.hasOwn(state, "ownerFrameVisible")
    ? state.ownerFrameVisible === true && state.ownerFrameAuthenticated !== false
    : state.rendererReady === true;
  if (viewport?.dataset) {
    viewport.dataset.ready = String(visibleOwnerFrame);
    viewport.dataset.ownerFrameVisible = String(visibleOwnerFrame);
    viewport.dataset.ownerTransition = String(state.switching === true);
    viewport.dataset.rendererSettling = String(state.rendererSettling === true);
  }
  if (startup) startup.hidden = visibleOwnerFrame;
}

function artifactBlob(artifact) {
  if (artifact instanceof Blob) return artifact;
  if (artifact instanceof Uint8Array || artifact instanceof ArrayBuffer) return new Blob([artifact]);
  if (artifact?.blob instanceof Blob) return artifact.blob;
  if (artifact?.bytes instanceof Uint8Array || artifact?.bytes instanceof ArrayBuffer) {
    return new Blob([artifact.bytes], {
      type: artifact.mediaType || artifact.mimeType || "application/octet-stream",
    });
  }
  if (typeof artifact?.dataUrl === "string" && artifact.dataUrl.startsWith("data:")) return artifact.dataUrl;
  throw new StudioBootstrapError("The selected export does not contain browser-local asset bytes.", {
    code: "EXPORT_UNAVAILABLE",
  });
}

function downloadBrowserArtifact(scope, document, artifact) {
  const data = artifactBlob(artifact);
  const url = typeof data === "string" ? data : scope.URL.createObjectURL(data);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact?.fileName || artifact?.filename || artifact?.name || "codex-studio-export";
  anchor.rel = "noopener";
  document.body?.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    if (typeof data !== "string") {
      scope.setTimeout(() => scope.URL.revokeObjectURL(url), 1_000);
    }
  }
  return { fileName: anchor.download, mediaType: data.type || artifact?.mediaType || null };
}

function installPageToolBridge({ scope, document, registrar, tools, getLifecycle }) {
  if (!Array.isArray(tools) || typeof registrar?.listRegisteredTools !== "function" ||
      typeof registrar?.executeRegisteredTool !== "function") {
    return null;
  }
  const origin = safeLocation(scope).origin;
  const byName = new Map(tools.map((descriptor) => [descriptor.name, descriptor]));
  const nativeDescriptors = new WeakMap();
  let disposed = false;

  const ensureLive = () => {
    if (disposed || scope.isSecureContext !== true || scope.top !== scope.self ||
        safeLocation(scope).origin !== origin || registrar.getStatus?.().ready !== true) {
      throw new StudioBootstrapError("The local WebMCP page bridge is no longer available.", {
        code: "WEBMCP_BRIDGE_UNAVAILABLE",
      });
    }
  };

  const toolFor = (name) => {
    ensureLive();
    if (typeof name !== "string" || !PAGE_TOOL_NAME.test(name) || !byName.has(name)) {
      throw new StudioBootstrapError("The requested WebMCP tool is not registered in this page.", {
        code: "WEBMCP_TOOL_UNKNOWN",
      });
    }
    const registration = registrar.getStatus?.();
    const fence = {
      ...(Number.isSafeInteger(registration?.registrationGeneration)
        ? { expectedRegistrationGeneration: registration.registrationGeneration } : {}),
      ...(typeof registration?.catalogHash === "string"
        ? { expectedCatalogHash: registration.catalogHash } : {}),
    };
    let descriptor;
    try {
      if (typeof registrar.hasRegisteredTool === "function") {
        descriptor = registrar.hasRegisteredTool(name, fence) ? byName.get(name) : undefined;
      } else if (typeof registrar.describeRegisteredTool === "function") {
        descriptor = registrar.describeRegisteredTool(name, fence);
      } else {
        descriptor = registrar.listRegisteredTools().find((candidate) => candidate.name === name);
      }
    } catch (cause) {
      throw new StudioBootstrapError("The requested WebMCP tool no longer has a live registration.", {
        code: "WEBMCP_TOOL_UNAVAILABLE",
        cause,
      });
    }
    if (!descriptor) {
      throw new StudioBootstrapError("The requested WebMCP tool no longer has a live registration.", {
        code: "WEBMCP_TOOL_UNAVAILABLE",
      });
    }
    return { descriptor, registered: byName.get(name) };
  };

  const contexts = () => {
    const result = [];
    for (const read of [
      () => document.modelContext,
      () => document.defaultView?.navigator?.modelContext ?? scope.navigator?.modelContext,
    ]) {
      let context;
      try {
        context = read();
      } catch {
        continue;
      }
      if (context && !result.includes(context) &&
          typeof context.getTools === "function" &&
          typeof context.executeTool === "function") {
        result.push(context);
      }
    }
    return result;
  };

  const nativeFence = () => {
    const lifecycle = getLifecycle?.();
    const registration = registrar.getStatus?.();
    return Object.freeze({
      documentGeneration: lifecycle?.documentGeneration,
      registrationGeneration: registration?.registrationGeneration
        ?? lifecycle?.registrationGeneration,
      catalogHash: registration?.catalogHash ?? lifecycle?.catalogHash,
      projectGeneration: lifecycle?.projectGeneration,
    });
  };

  const sameNativeFence = (left, right) => left.documentGeneration === right.documentGeneration
    && left.registrationGeneration === right.registrationGeneration
    && left.catalogHash === right.catalogHash
    && left.projectGeneration === right.projectGeneration;

  const nativeInventory = async (context, fence) => {
    let cached = nativeDescriptors.get(context);
    if (!cached || !sameNativeFence(cached.fence, fence)) {
      const promise = Promise.resolve().then(() => context.getTools()).then((discovered) => {
        if (!Array.isArray(discovered)) {
          throw new StudioBootstrapError("The native WebMCP tool inventory is malformed.", {
            code: "WEBMCP_NATIVE_INVENTORY_INVALID",
          });
        }
        const descriptors = new Map();
        for (const descriptor of discovered) {
          if (typeof descriptor?.name === "string" && !descriptors.has(descriptor.name)) {
            descriptors.set(descriptor.name, descriptor);
          }
        }
        return descriptors;
      });
      cached = { fence, promise };
      nativeDescriptors.set(context, cached);
      promise.catch(() => {
        if (nativeDescriptors.get(context) === cached) nativeDescriptors.delete(context);
      });
    }
    const descriptors = await cached.promise;
    ensureLive();
    if (!sameNativeFence(fence, nativeFence()) || contexts()[0] !== context) {
      throw new StudioBootstrapError("The native WebMCP registration changed during tool discovery.", {
        code: "WEBMCP_NATIVE_REGISTRATION_CHANGED",
      });
    }
    return descriptors;
  };

  const bridge = Object.freeze({
    listTools(options) {
      ensureLive();
      if (options === undefined) return registrar.listRegisteredTools();
      const lifecycle = getLifecycle?.();
      if (options?.expectedDocumentGeneration !== undefined &&
          options.expectedDocumentGeneration !== lifecycle?.documentGeneration) {
        throw new StudioBootstrapError("The WebMCP document generation is no longer current.", {
          code: "WEBMCP_STALE_DOCUMENT",
        });
      }
      const compact = registrar.listRegisteredTools(options);
      return { ...compact,
        documentGeneration: lifecycle?.documentGeneration,
        projectGeneration: lifecycle?.projectGeneration };
    },

    describeTool(name, options = {}) {
      const { descriptor } = toolFor(name);
      if (options?.expectedDocumentGeneration !== undefined &&
          options.expectedDocumentGeneration !== getLifecycle?.()?.documentGeneration) {
        throw new StudioBootstrapError("The WebMCP descriptor belongs to a stale document.", {
          code: "WEBMCP_STALE_DOCUMENT",
        });
      }
      return typeof registrar.describeRegisteredTool === "function"
        ? registrar.describeRegisteredTool(name, options) : descriptor;
    },

    async executeTool(name, input = {}) {
      const { registered } = toolFor(name);
      validateStudioToolInput(input, registered.inputSchema);
      const encoded = JSON.stringify(input);
      if (typeof encoded !== "string" || new TextEncoder().encode(encoded).byteLength >
          MAX_PAGE_TOOL_INPUT_BYTES) {
        throw new StudioBootstrapError("The WebMCP tool input exceeds the browser safety budget.", {
          code: "WEBMCP_TOOL_INPUT_TOO_LARGE",
        });
      }

      const native = contexts()[0];
      if (native) {
        // Desktop WebMCP accepts its discovered descriptor and one JSON string.
        // Never fall back after a real browser context rejected an invocation.
        const fence = nativeFence();
        const verified = typeof registrar.getVerifiedNativeDescriptor === "function"
          ? registrar.getVerifiedNativeDescriptor(native, name, {
            ...(Number.isSafeInteger(fence.registrationGeneration)
              ? { expectedRegistrationGeneration: fence.registrationGeneration } : {}),
            ...(typeof fence.catalogHash === "string"
              ? { expectedCatalogHash: fence.catalogHash } : {}),
          }) : undefined;
        const descriptor = verified
          ?? (await nativeInventory(native, fence)).get(name);
        if (!descriptor) {
          throw new StudioBootstrapError("The native WebMCP surface does not expose this registered tool.", {
            code: "WEBMCP_NATIVE_TOOL_UNAVAILABLE",
          });
        }
        ensureLive();
        if (!sameNativeFence(fence, nativeFence()) || contexts()[0] !== native) {
          throw new StudioBootstrapError("The native WebMCP registration changed before execution.", {
            code: "WEBMCP_NATIVE_REGISTRATION_CHANGED",
          });
        }
        const value = await native.executeTool(descriptor, encoded);
        if (typeof value !== "string") return value;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }

      return registrar.executeRegisteredTool(name, input);
    },
  });

  Object.defineProperty(scope, "__orielWebMcpPageTools", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: bridge,
  });

  return Object.freeze({
    bridge,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (scope.__orielWebMcpPageTools === bridge) {
        try {
          delete scope.__orielWebMcpPageTools;
        } catch {
          // A locked browser global cannot restore a revoked registrar.
        }
      }
    },
  });
}

export function createStudioBootstrap({
  scope = globalThis,
  document = scope.document,
  runtimeModuleUrl = DEFAULT_RUNTIME_MODULE_URL,
  runtimeWasmUrl = DEFAULT_RUNTIME_WASM_URL,
  seedManifestUrl = DEFAULT_SEED_MANIFEST_URL,
  runtimeProvenanceUrl = DEFAULT_RUNTIME_PROVENANCE_URL,
  modelingKernelManifestUrl = DEFAULT_MODELING_KERNEL_MANIFEST_URL,
  runtimeProvenance,
  requireRuntimeProvenance,
  runtimeTimeoutMilliseconds = DEFAULT_RUNTIME_TIMEOUT_MILLISECONDS,
  presentationTimeoutMilliseconds = DEFAULT_PRESENTATION_TIMEOUT_MILLISECONDS,
  importRuntime = (url) => import(url),
  createRuntime = createBrowserRuntimeBridge,
  createStore = createSceneStore,
  createGeometryCompute = createGeometryComputeService,
  loadGeometryKernel = loadAuthenticatedModelingKernel,
  createReferenceAssets = createReferenceCatalog,
  createInspection = createInspectionCaptureService,
  createGuidance = createCameraGuidance,
  createExportAssets = createGroupedExportService,
  createDevicePersistence = createDefaultDevicePersistence,
  createModelImportService = createDefaultModelImportService,
  createModelImportSessions = createDefaultModelImportSessions,
  createMaterialAuthoringService = createDefaultMaterialAuthoringService,
  createMaterialUploadSessions = createDefaultMaterialUploadSessions,
  createModelArtifacts = createDefaultModelArtifactRegistry,
  loadVillageExample = () => import("/modules/village-example.js"),
  createUI = createStudioUI,
  createTools = createStudioTools,
  createRegistrar = createWebMcpRegistrar,
} = {}) {
  if (!document) throw new TypeError("A Codex Modeling Studio document is required.");

  let controller = null;
  let runtime = null;
  let store = null;
  let ui = null;
  let registrar = null;
  let referenceAssets = null;
  let inspection = null;
  let cameraGuidance = null;
  let exportAssets = null;
  let deviceCache = null;
  let modelImportService = null;
  let modelImports = null;
  let modelArtifacts = null;
  let materialAuthoring = null;
  let materialUploads = null;
  let persistenceCompatibility = null;
  let checkpointQueue = Promise.resolve();
  let authenticatedSeed = null;
  let projectSeedStoreFactory = null;
  let activeProjectStorageKey = null;
  let legacyProjectId = null;
  let activeProject = null;
  let projectNavigation = null;
  let projectNavigationPending = false;
  let projectScenePresented = false;
  let restoredProjectPending = false;
  let projectRecoveryRequired = false;
  let pageToolBridge = null;
  let currentOwner = null;
  let stableInternalTools = null;
  let stableTools = null;
  let publicToolCatalog = null;
  let failedCatalogPageUrl = null;
  let instantiateProjectStore = null;
  let authenticatedGeometryKernel = null;
  const projectGeometryOwners = new Map();
  const projectGeometryAuthorities = new WeakMap();
  const projectDenseGrants = new WeakMap();
  const denseGrantsBySnapshot = new Map();
  const deviceCheckpointSchedules = new WeakMap();
  let initialSnapshot = null;
  let nativeCanvas = null;
  let nativeStartup = null;
  let cancelCanvasRecovery = null;
  let cancelRendererObservation = null;
  let runtimeRecovery = null;
  let presentedOwnerFrame = null;
  let pendingOwnerReady = null;
  let disposed = false;
  let bootPromise = null;
  let unsubscribeStore = null;
  let unsubscribeRuntime = null;
  let unsubscribeRegistrar = null;
  let committedRevision = null;
  let lastRuntimeActivity = null;
  const activeAgentInvocations = [];
  const listeners = new Set();
  const projectListeners = new Set();
  const pendingExports = new Map();
  const exportReservations = new Set();
  let pendingExportBytes = 0;
  const state = {
    phase: "idle",
    message: "Preparing Codex Modeling Studio.",
    rendererLabel: "Preparing renderer",
    webgpuAvailable: false,
    webgpuReady: false,
    rendererReady: false,
    rendererSettling: false,
    ownerFrameVisible: false,
    ownerFrameAuthenticated: false,
    recoveryRequired: false,
    unknownOutcome: false,
    recoveryReason: null,
    operationOutcome: null,
    webmcpReady: false,
    agentBridgeObserved: false,
    agentActivity: "waiting",
    agentTool: null,
    sceneRevision: 0,
    registeredNames: [],
    unsupported: false,
    error: null,
    loadedAssets: 0,
    totalAssets: 0,
    documentGeneration: scope.crypto?.randomUUID?.() ?? "studio-document",
    registrationGeneration: 0,
    projectGeneration: 0,
    catalogHash: null,
    catalogHostBytes: null,
    switching: false,
  };

  const snapshot = () => Object.freeze({ ...state, registeredNames: [...state.registeredNames] });
  const publish = (changes = {}) => {
    Object.assign(state, changes);
    const authenticatedFrame = presentedOwnerFrame !== null
      && ownerFrameStillVisible(currentOwner);
    state.ownerFrameVisible = authenticatedFrame;
    state.ownerFrameAuthenticated = authenticatedFrame;
    const value = snapshot();
    dispatchStatus(document, value);
    ui?.setStatus?.(value);
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        scope.console?.warn?.("A Codex Modeling Studio status listener failed.", error);
      }
    }
    return value;
  };

  const clearPresentedOwnerFrame = () => {
    presentedOwnerFrame = null;
    pendingOwnerReady = null;
    state.ownerFrameVisible = false;
    state.ownerFrameAuthenticated = false;
  };

  const authenticatePresentedOwnerFrame = (owner, rendererState = runtime?.status?.(), {
    snapshot: expectedSnapshot,
    minimumFrames = 2,
  } = {}) => {
    if (!owner || owner !== currentOwner || disposed || projectNavigationPending
        || owner.projectGeneration !== state.projectGeneration
        || rendererState?.ready !== true
        || rendererState.phase !== undefined && rendererState.phase !== "ready"
        || !Number.isSafeInteger(rendererState.presentedFrames)
        || rendererState.presentedFrames < minimumFrames) return false;
    const checkpoint = owner.store?.getInspectionCheckpoint?.();
    const expected = expectedSnapshot ?? checkpoint;
    if (!expected || checkpoint?.retired === true
        || typeof expected.snapshotId !== "string"
        || typeof expected.sceneSourceHash !== "string"
        || typeof expected.assetManifestHash !== "string"
        || checkpoint?.snapshotId !== expected.snapshotId
        || checkpoint?.sceneSourceHash !== expected.sceneSourceHash
        || checkpoint?.assetManifestHash !== expected.assetManifestHash
        || rendererState.snapshotId !== expected.snapshotId
        || rendererState.sceneSourceHash !== expected.sceneSourceHash
        || rendererState.assetManifestHash !== expected.assetManifestHash) return false;
    const nativeBridge = scope.__ORIEL_EDITOR_PREVIEW_RUNTIME__;
    const requiresAuthoritativeFrontier =
      typeof nativeBridge?.getAgentCaptureCapabilities === "function";
    const frontier = rendererState.presentedFrontier;
    if (requiresAuthoritativeFrontier && (!frontier
        || typeof frontier !== "object" || Array.isArray(frontier)
        || !Number.isSafeInteger(frontier.operationSequence)
        || frontier.operationSequence < 0
        || (frontier.operationSequence === 0
          ? frontier.operationDigest !== null
          : typeof frontier.operationDigest !== "string"
            || !/^sha256:[0-9a-f]{64}$/u.test(frontier.operationDigest)))) return false;
    if (frontier && (frontier.snapshotId !== expected.snapshotId
        || frontier.sceneSourceHash !== expected.sceneSourceHash
        || frontier.assetManifestHash !== expected.assetManifestHash
        || frontier.projectId !== undefined
          && frontier.projectId !== owner.project?.projectId
        || frontier.projectGeneration !== undefined
          && frontier.projectGeneration !== owner.projectGeneration
        || frontier.rendererGeneration !== undefined
          && String(frontier.rendererGeneration)
            !== String(rendererState.rendererGeneration)
        || frontier.invalidationEpoch !== undefined
          && String(frontier.invalidationEpoch)
            !== String(rendererState.invalidationEpoch))) return false;
    presentedOwnerFrame = Object.freeze({
      owner,
      documentGeneration: state.documentGeneration,
      projectId: owner.project?.projectId,
      projectGeneration: owner.projectGeneration,
      nativeBridge,
      runtimeIncarnation: rendererState.runtimeIncarnation ?? null,
      rendererGeneration: rendererState.rendererGeneration ?? null,
      snapshotId: expected.snapshotId,
      sceneSourceHash: expected.sceneSourceHash,
      assetManifestHash: expected.assetManifestHash,
      presentedFrames: rendererState.presentedFrames,
    });
    state.ownerFrameVisible = true;
    state.ownerFrameAuthenticated = true;
    return true;
  };

  const ownerFrameStillVisible = (owner = currentOwner) => {
    const frame = presentedOwnerFrame;
    return frame !== null && frame.owner === owner && !disposed
      && !projectNavigationPending && state.switching !== true
      && frame.documentGeneration === state.documentGeneration
      && frame.projectId === owner?.project?.projectId
      && frame.projectGeneration === owner?.projectGeneration
      && owner?.projectGeneration === state.projectGeneration
      && frame.nativeBridge === scope.__ORIEL_EDITOR_PREVIEW_RUNTIME__;
  };

  const boundedText = (value, maximum = 160) =>
    typeof value === "string" ? value.slice(0, maximum) : undefined;

  const projectGeometryKey = (projectId, generation) =>
    `${projectId}:${generation}`;

  const createProjectGeometryOwner = (projectId, generation) => {
    if (authenticatedGeometryKernel === null) return null;
    const key = projectGeometryKey(projectId, generation);
    const existing = projectGeometryOwners.get(key);
    if (existing) return existing;
    const nonce = scope.crypto.randomUUID();
    const documentGeneration = 1;
    const service = createGeometryCompute({ scope, projectId,
      ownerGeneration: generation, documentGeneration,
      ownerNonce: nonce,
      kernelReleaseId: authenticatedGeometryKernel.kernelReleaseId,
      kernelUrl: authenticatedGeometryKernel.kernelUrl,
      authority: "provisional",
      acquireKernel: async (fence) => ({ ...fence,
        module: authenticatedGeometryKernel.module,
        operations: authenticatedGeometryKernel.operations }) });
    projectGeometryOwners.set(key, service);
    projectGeometryAuthorities.set(service,
      { projectId, ownerGeneration: generation,
        documentGeneration,
        kernelReleaseId: authenticatedGeometryKernel.kernelReleaseId, nonce });
    return service;
  };

  const prepareProjectGeometryOwner = async (geometry, {
    projectId, generation, signal, navigation = false,
  }) => {
    try {
      await geometry.prepare();
    } catch (error) {
      if (error?.code !== "COMPUTE_UNAVAILABLE") throw error;
      abortError(signal);
      const authority = projectGeometryAuthorities.get(geometry);
      if (disposed || projectGeometryOwners.get(projectGeometryKey(projectId, generation))
          !== geometry || authority?.projectId !== projectId
          || authority.ownerGeneration !== generation
          || state.projectGeneration !== generation
          || navigation && !projectNavigationPending) throw error;
      // A failed authenticated startup retires its worker; the same fenced owner
      // can safely attempt exactly one fresh worker before any destination mutation.
      await geometry.prepare();
    }
    abortError(signal);
  };

  const reserveDenseOwnerGrant = (geometry, snapshot) => {
    if (geometry === null || geometry === undefined
        || !snapshot.snapshot?.renderRequirements?.required?.includes(
          "modeling.asset.dense.v1")) return null;
    const bridge = scope.__ORIEL_EDITOR_PREVIEW_RUNTIME__;
    if (typeof bridge?.reserveModelingDenseOwnerGrant !== "function"
        || typeof bridge?.promoteModelingDenseOwnerGrant !== "function"
        || typeof bridge?.revokeModelingDenseOwnerGrant !== "function") {
      throw new StudioBootstrapError("Dense modeling assets require an authenticated native renderer owner grant.",
        { code: "CAPABILITY_UNAVAILABLE" });
    }
    const authority = projectGeometryAuthorities.get(geometry);
    if (!authority) {
      throw new StudioBootstrapError("The dense modeling renderer has no genuine project-worker owner.",
        { code: "STALE_PROJECT" });
    }
    const requested = { ...authority, snapshotId: snapshot.snapshotId,
      sceneSourceHash: snapshot.sceneSourceHash,
      assetManifestHash: snapshot.assetManifestHash };
    const receipt = Reflect.apply(bridge.reserveModelingDenseOwnerGrant,
      bridge, [JSON.stringify(requested)]);
    if (receipt?.format !== "oriel.modeling-dense-owner-grant/1"
        || typeof receipt.grantId !== "string" || receipt.grantId.length < 8
        || Object.entries(requested).some(([field, value]) =>
          receipt[field] !== value)) {
      throw new StudioBootstrapError("The native renderer rejected the exact pending dense project owner.",
        { code: "CAPABILITY_UNAVAILABLE" });
    }
    const grant = { ...requested, grantId: receipt.grantId };
    projectDenseGrants.set(geometry, grant);
    denseGrantsBySnapshot.set(snapshot.snapshotId, grant);
    return receipt;
  };

  const promoteDenseOwnerGrant = (geometry) => {
    const grant = projectDenseGrants.get(geometry);
    if (!grant) return;
    const bridge = scope.__ORIEL_EDITOR_PREVIEW_RUNTIME__;
    if (Reflect.apply(bridge.promoteModelingDenseOwnerGrant,
      bridge, [JSON.stringify(grant)]) !== true) {
      throw new StudioBootstrapError("The native renderer did not genuinely present its pending dense project owner.",
        { code: "PROJECT_PRESENTATION_FAILED" });
    }
  };

  const revokeDenseOwnerGrant = (geometry) => {
    const grant = projectDenseGrants.get(geometry);
    if (!grant) return;
    projectDenseGrants.delete(geometry);
    denseGrantsBySnapshot.delete(grant.snapshotId);
    const bridge = scope.__ORIEL_EDITOR_PREVIEW_RUNTIME__;
    if (typeof bridge?.revokeModelingDenseOwnerGrant === "function") {
      Reflect.apply(bridge.revokeModelingDenseOwnerGrant, bridge,
        [JSON.stringify({ projectId: grant.projectId,
          ownerGeneration: grant.ownerGeneration,
          nonce: grant.nonce, grantId: grant.grantId })]);
    }
  };

  const currentInvocation = () => {
    for (let index = activeAgentInvocations.length - 1; index >= 0; index -= 1) {
      const invocation = activeAgentInvocations[index];
      if (invocation.readOnly !== true) return invocation;
    }
    return null;
  };

  const checkpointOwnerProjectIds = (persistence, additional = []) => [...new Set([
    activeProject?.projectId,
    persistence?.projectId,
    ...additional,
  ].filter((projectId) => validProjectIdentifier(projectId, legacyProjectId)))];

  const reclaimInactiveProjects = async (persistence, {
    requiredBytes = 0,
    maxProjects,
    preserveProjectIds = [],
  } = {}) => {
    if (typeof persistence?.reclaimInactiveProjects !== "function"
        || persistence.status?.().enabled !== true
        || persistence.status?.().readOnly === true) return null;
    return persistence.reclaimInactiveProjects({
      requiredBytes,
      ...(maxProjects === undefined ? {} : { maxProjects }),
      preserveProjectIds: checkpointOwnerProjectIds(persistence, preserveProjectIds),
    });
  };

  const checkpointDeviceStore = async (persistence, selectedStore, {
    preserveProjectIds = [],
  } = {}) => {
    const protectedProjects = checkpointOwnerProjectIds(persistence, preserveProjectIds);
    try {
      return await persistence.checkpointStore(selectedStore, {
        compatibility: persistenceCompatibility,
        ...(protectedProjects.length === 0 ? {} : { preserveProjectIds: protectedProjects }),
      });
    } catch (error) {
      if (error?.code !== "QUOTA_EXCEEDED") throw error;
      if (Number.isSafeInteger(error?.details?.projectBytes)
          && Number.isSafeInteger(error?.details?.maxBytes)
          && error.details.projectBytes > error.details.maxBytes) {
        throw error;
      }
      const bytesNeeded = Number.isSafeInteger(error?.details?.requiredBytes)
        && error.details.requiredBytes > 0 ? error.details.requiredBytes
        : Number.isSafeInteger(error?.requiredBytes) && error.requiredBytes > 0
          ? error.requiredBytes : error?.name === "QuotaExceededError" ? 1 : 0;
      if (bytesNeeded === 0) throw error;
      const reclaimed = await reclaimInactiveProjects(persistence, {
        requiredBytes: bytesNeeded,
        preserveProjectIds: protectedProjects,
      });
      if (!Array.isArray(reclaimed?.projectIds) || reclaimed.projectIds.length === 0) throw error;
      return persistence.checkpointStore(selectedStore, {
        compatibility: persistenceCompatibility,
        ...(protectedProjects.length === 0 ? {} : { preserveProjectIds: protectedProjects }),
      });
    }
  };

  const queueDeviceCheckpoint = (owner = currentOwner) => {
    const selectedStore = owner?.store ?? store;
    const selectedPersistence = owner?.persistence ?? deviceCache;
    if (!projectScenePresented || projectRecoveryRequired || projectNavigationPending ||
        selectedPersistence?.status?.().enabled !== true ||
        typeof selectedStore?.exportPersistenceCheckpoint !== "function") {
      return Promise.resolve(null);
    }
    const requestedRevision = typeof selectedStore.getRevision === "function"
      ? selectedStore.getRevision() : null;
    const existing = deviceCheckpointSchedules.get(selectedPersistence);
    if (existing && existing.store === selectedStore
        && Number.isSafeInteger(requestedRevision)) {
      if (requestedRevision > existing.requestedRevision) {
        existing.requestedRevision = requestedRevision;
      }
      return existing.promise;
    }
    const previousQueue = owner?.checkpointQueue ?? checkpointQueue;
    const schedule = {
      store: selectedStore,
      requestedRevision,
      promise: null,
    };
    const queued = previousQueue.then(async () => {
      let result = null;
      do {
        if (!projectScenePresented || projectRecoveryRequired || projectNavigationPending
            || owner && owner !== currentOwner
            || selectedPersistence?.status?.().enabled !== true) return result;
        const scheduledRevision = schedule.requestedRevision;
        result = await checkpointDeviceStore(selectedPersistence, selectedStore);
        if (!Number.isSafeInteger(scheduledRevision)) return result;
      } while (schedule.requestedRevision > (Number.isSafeInteger(result?.revision)
        ? result.revision : scheduledRevision));
      return result;
    }).catch((error) => {
      scope.console?.warn?.("The acknowledged device-local scene checkpoint failed.", error);
      selectedPersistence?.reportError?.(error);
      if (owner === undefined || owner === null || owner === currentOwner) {
        ui?.reportCheckpointFailure?.({
          code: boundedText(error?.code, 64) || "PROJECT_CHECKPOINT_FAILED",
          message: boundedText(error?.message, 240)
            || "The current modeling project could not be saved on this device.",
          ...(currentOwner ? { owner: currentOwner,
            ownerGeneration: currentOwner.projectGeneration } : {}),
        });
      }
      ui?.setStatus?.({
        message: error?.message || "The current modeling project could not be saved on this device.",
        error: true,
      });
      return null;
    }).finally(() => {
      if (deviceCheckpointSchedules.get(selectedPersistence) === schedule) {
        deviceCheckpointSchedules.delete(selectedPersistence);
      }
    });
    schedule.promise = queued;
    deviceCheckpointSchedules.set(selectedPersistence, schedule);
    if (owner) owner.checkpointQueue = queued;
    if (!owner || owner === currentOwner) checkpointQueue = queued;
    return queued;
  };

  const flushDeviceCheckpoint = async (persistence = deviceCache, selectedStore = store,
    selectedQueue = currentOwner?.checkpointQueue ?? checkpointQueue,
    { preserveProjectIds = [], reportFailure = true } = {}) => {
    if (!projectScenePresented || projectRecoveryRequired
        || persistence?.status?.().enabled !== true
        || typeof persistence?.checkpointStore !== "function"
        || typeof selectedStore?.exportPersistenceCheckpoint !== "function") {
      throw new StudioBootstrapError("The current modeling project cannot be safely checkpointed.", {
        code: "PROJECT_CHECKPOINT_UNAVAILABLE",
      });
    }
    await selectedQueue;
    if (!projectScenePresented || projectRecoveryRequired || persistence.status().enabled !== true) {
      throw new StudioBootstrapError("The current modeling project lost its device-local writer.", {
        code: "PROJECT_WRITER_UNAVAILABLE",
      });
    }
    try {
      return await checkpointDeviceStore(persistence, selectedStore, { preserveProjectIds });
    } catch (error) {
      if (reportFailure) persistence.reportError?.(error);
      throw error;
    }
  };

  const currentProject = () => activeProject === null
    ? null : Object.freeze({ ...activeProject, active: true });

  const ownershipStatus = (persistence = deviceCache) => {
    const value = persistence?.status?.() ?? {};
    const consented = value.consented === true;
    const readOnly = value.readOnly === true;
    const hasWriter = value.hasWriter === undefined
      ? value.enabled === true && !readOnly && consented
      : value.hasWriter === true;
    const navigationPending = projectNavigationPending;
    const recoveryRequired = projectRecoveryRequired || !projectScenePresented
      || runtime?.status?.().phase === "reconciling" || runtimeRecovery !== null;
    return Object.freeze({
      ...value,
      phase: recoveryRequired ? "recovery-required"
        : navigationPending && state.phase === "acquiring-project"
          ? "acquiring" : value.phase ?? "ephemeral",
      enabled: value.enabled === true,
      readOnly,
      consented,
      hasWriter: !navigationPending && !recoveryRequired && hasWriter,
      canAttemptAcquire: !navigationPending && !recoveryRequired && readOnly && consented
        && persistence?.isAutoSaveDisabled?.() !== true
        && (value.canAttemptAcquire === undefined || value.canAttemptAcquire === true),
      navigationPending,
      recoveryRequired,
    });
  };

  const logicalOwnerGeneration = () => state.switching || projectNavigationPending
    ? Math.max(0, state.projectGeneration - 1) : state.projectGeneration;

  const publishCurrentProject = () => {
    const project = currentProject();
    for (const listener of [...projectListeners]) {
      try {
        listener(project);
      } catch (error) {
        scope.console?.warn?.("A modeling project listener failed.", error);
      }
    }
    return project;
  };

  const writeActiveProject = (projectId) => {
    const storage = browserProjectStorage(scope);
    const sessionStorage = browserProjectSessionStorage(scope);
    let previousSessionProject = null;
    let sessionWritten = false;
    try {
      if (typeof storage?.setItem !== "function" || typeof storage?.getItem !== "function") {
        throw new Error("Browser profile storage is unavailable.");
      }
      if (typeof sessionStorage?.setItem === "function"
          && typeof sessionStorage?.getItem === "function") {
        previousSessionProject = sessionStorage.getItem(activeProjectStorageKey);
        sessionStorage.setItem(activeProjectStorageKey, projectId);
        sessionWritten = true;
        if (sessionStorage.getItem(activeProjectStorageKey) !== projectId) {
          throw new Error("The selected tab-local project could not be verified.");
        }
      }
      storage.setItem(activeProjectStorageKey, projectId);
      if (storage.getItem(activeProjectStorageKey) !== projectId) {
        throw new Error("The selected project could not be verified.");
      }
    } catch (cause) {
      if (sessionWritten) {
        try {
          if (previousSessionProject === null) {
            sessionStorage.removeItem?.(activeProjectStorageKey);
          } else {
            sessionStorage.setItem(activeProjectStorageKey, previousSessionProject);
          }
        } catch { /* Preserve the original storage failure without claiming a safe switch. */ }
      }
      throw new StudioBootstrapError("The selected modeling project could not be saved on this device.", {
        code: "PROJECT_STORAGE_UNAVAILABLE",
        cause,
      });
    }
  };

  const listProjects = async () => {
    if (typeof deviceCache?.listProjects !== "function") return [];
    const entries = await deviceCache.listProjects();
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry) => entry && typeof entry === "object"
      && validProjectIdentifier(entry.projectId, legacyProjectId)
      && entry.sceneAssetId === authenticatedSeed?.sceneAssetId
      && entry.scenePath === authenticatedSeed?.scenePath)
      .map((entry) => Object.freeze({ ...entry, active: entry.projectId === activeProject?.projectId }));
  };

  const verifyProjectCheckpoint = (value) => {
    if (value?.sceneAssetId !== authenticatedSeed?.sceneAssetId ||
        value.scenePath !== authenticatedSeed?.scenePath ||
        value.scene?.format !== "oriel.scene/1" ||
        !(value.assets instanceof Map) || !(value.assetMetadata instanceof Map) ||
        !Number.isSafeInteger(value.revision) || value.revision < 0) {
      throw new StudioBootstrapError("The saved project does not contain its complete verified checkpoint.", {
        code: "INVALID_DEVICE_CHECKPOINT",
      });
    }
  };

  const createProjectOwner = ({ project, persistence, source, restored, generation }) => {
    if (typeof instantiateProjectStore !== "function") {
      throw new StudioBootstrapError("The verified modeling project store is unavailable.", {
        code: "PROJECT_SEED_UNAVAILABLE",
      });
    }
    const selectedStore = instantiateProjectStore(source, {
      projectId: project.projectId,
      restored,
      generation,
    });
    const selectedArtifacts = createModelArtifacts({ scope, crypto: scope.crypto,
      store: selectedStore, projectId: project.projectId,
      projectGeneration: generation });
    const selectedModelImport = createModelImportService({
      store: selectedStore, scope, crypto: scope.crypto,
      projectId: project.projectId, artifacts: selectedArtifacts,
    });
    const selectedModelImports = createModelImportSessions({
      service: selectedModelImport, store: selectedStore, scope, crypto: scope.crypto,
      artifacts: selectedArtifacts,
    });
    let selectedReferences = null;
    try {
      selectedReferences = createReferenceAssets({ scope, crypto: scope.crypto });
    } catch (error) {
      if (error?.code !== "CAPABILITY_UNAVAILABLE") throw error;
    }
    const selectedInspection = createInspection({ sceneStore: selectedStore, runtime, scope });
    const selectedGuidance = typeof runtime?.previewOwnerCameraPose === "function"
      && typeof runtime?.finishOwnerCameraPreview === "function"
      && typeof selectedInspection?.focusTarget === "function"
      ? createGuidance({ store: selectedStore, inspection: selectedInspection,
        runtime, scope }) : null;
    const selectedExports = createExportAssets({ store: selectedStore });
    const selectedMaterialAuthoring = createMaterialAuthoringService({
      store: selectedStore, projectController, inspection: selectedInspection, scope,
    });
    const selectedMaterialUploads = createMaterialUploadSessions({
      scope, projectController, materialAuthoringService: selectedMaterialAuthoring,
    });
    const owner = {
      projectGeneration: generation,
      project,
      store: selectedStore,
      geometryCompute: projectGeometryOwners.get(
        projectGeometryKey(project.projectId, generation)) ?? null,
      persistence,
      checkpointQueue: Promise.resolve(),
      referenceAssets: selectedReferences,
      inspection: selectedInspection,
      cameraGuidance: selectedGuidance,
      exportAssets: selectedExports,
      modelImportService: selectedModelImport,
      modelImports: selectedModelImports,
      modelArtifacts: selectedArtifacts,
      materialAuthoring: selectedMaterialAuthoring,
      materialUploads: selectedMaterialUploads,
      descriptorsByName: new Map(),
    };
    const descriptors = createTools({
      scope,
      store: selectedStore,
      runtime,
      capture: (options = {}) => runtime.capture({
        ...options,
        ...(options.format === "png" ? { format: "image/png" } : {}),
        ...(options.format === "jpeg" ? { format: "image/jpeg" } : {}),
      }),
      referenceAssets: selectedReferences,
      inspection: selectedInspection,
      ...(selectedGuidance === null ? {} : { cameraGuidance: selectedGuidance }),
      exportAssets: selectedExports,
      modelImports: selectedModelImports,
      artifacts: selectedArtifacts,
      materialAuthoring: selectedMaterialAuthoring,
      materialUploads: selectedMaterialUploads,
      projectController,
      getPersistenceStatus: () => ownershipStatus(persistence),
      getCallbackOwner: () => owner,
      getOwnerGeneration: () => logicalOwnerGeneration(),
      onInvocation: observerInvocation,
      onExport: queueBrowserExport,
      reserveExportOffer,
      publishExportOffer,
      releaseExportOffer,
    });
    owner.descriptorsByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
    return owner;
  };

  const disposeOwnerResources = (owner, { writer = true, retire = true } = {}) => {
    if (!owner) return Promise.resolve();
    owner.cameraGuidance?.dispose?.();
    if (retire) {
      revokeDenseOwnerGrant(owner.geometryCompute);
      owner.store?.retire?.();
      owner.geometryCompute?.dispose?.();
      const geometryAuthority = owner.geometryCompute === null
        || owner.geometryCompute === undefined ? undefined
        : projectGeometryAuthorities.get(owner.geometryCompute);
      const geometryGeneration = geometryAuthority?.ownerGeneration
        ?? owner.projectGeneration;
      projectGeometryOwners.delete(projectGeometryKey(owner.project?.projectId,
        geometryGeneration));
    }
    owner.inspection?.dispose?.();
    owner.exportAssets?.dispose?.();
    owner.modelImports?.dispose?.();
    owner.modelImportService?.dispose?.();
    owner.modelArtifacts?.dispose?.();
    owner.materialUploads?.dispose?.();
    owner.materialAuthoring?.dispose?.();
    owner.referenceAssets?.dispose?.();
    return writer ? Promise.resolve(owner.persistence?.dispose?.()) : Promise.resolve();
  };

  const sameDescriptorCatalog = (previous, candidate) => {
    if (previous.size !== candidate.size) return false;
    const canonical = (value) => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
        : value;
    for (const [name, descriptor] of previous) {
      const next = candidate.get(name);
      if (!next) return false;
      const project = ({ name: toolName, title, description, inputSchema, annotations }) => ({
        name: toolName, title, description, inputSchema, annotations,
      });
      if (JSON.stringify(canonical(project(descriptor))) !==
          JSON.stringify(canonical(project(next)))) return false;
    }
    return true;
  };

  const switchProject = async ({ projectId, displayName, create = false,
    acquire = false, signal } = {}) => {
    abortError(signal);
    if (!projectScenePresented || projectRecoveryRequired) {
      throw new StudioBootstrapError(
        "The current saved modeling project must be safely restored before it can be changed.",
        { code: "PROJECT_RECOVERY_REQUIRED" },
      );
    }
    if (projectNavigation || projectNavigationPending) {
      throw new StudioBootstrapError("A modeling project is already being opened.", {
        code: "PROJECT_SWITCH_PENDING",
      });
    }
    const current = deviceCache;
    const currentStatus = current?.status?.();
    const currentReadOnly = currentStatus?.readOnly === true;
    if (!authenticatedSeed || !activeProject || currentStatus?.consented !== true
        || currentStatus.enabled !== true && !currentReadOnly
        || acquire && current?.isAutoSaveDisabled?.() === true) {
      throw new StudioBootstrapError(
        "Acknowledge and enable device-local saving before creating or opening a project.",
        { code: "CONSENT_REQUIRED" },
      );
    }
    const selectedName = safeProjectName(displayName);
    let next = null;
    let provision = null;
    let candidate = null;
    let pendingGeometry = null;
    let sourceSnapshot = null;
    let destinationPresented = false;
    let selectionWritten = false;
    let ownerCommitted = false;
    const profileStorage = browserProjectStorage(scope);
    const tabStorage = browserProjectSessionStorage(scope);
    let previousProfileProject = null;
    let previousTabProject = null;
    try {
      previousProfileProject = profileStorage?.getItem?.(activeProjectStorageKey) ?? null;
      previousTabProject = tabStorage?.getItem?.(activeProjectStorageKey) ?? null;
    } catch {
      // writeActiveProject performs the authoritative availability verification.
    }
    const previous = currentOwner;
    const transitionGeneration = state.projectGeneration + 1;
    const transitionSignal = signal && controller?.signal
      && typeof globalThis.AbortSignal?.any === "function"
      ? globalThis.AbortSignal.any([controller.signal, signal])
      : signal ?? controller?.signal;
    clearPresentedOwnerFrame();
    projectNavigationPending = true;
    publish({ phase: acquire ? "acquiring-project" : "switching-project", switching: true,
      projectGeneration: transitionGeneration,
      rendererReady: false, rendererSettling: false,
      message: acquire
        ? "Restoring the latest saved project before acquiring editing access."
        : "Opening the selected project in the existing modeling workspace." });
    projectNavigation = (async () => {
      try {
        previous?.store?.quiesceMutations?.();
        const sessionController = new AbortController();
        const sessionTimeout = scope.setTimeout(() => {
          sessionController.abort(new StudioBootstrapError(
            "The current modeling project still has unfinished owner-local sessions.",
            { code: "PROJECT_BUSY" },
          ));
        }, 10_000);
        const sessionSignal = transitionSignal
          && typeof globalThis.AbortSignal?.any === "function"
          ? globalThis.AbortSignal.any([transitionSignal, sessionController.signal])
          : sessionController.signal;
        try {
          await Promise.all([
            previous?.modelImports?.quiesce?.({
              reason: "project-switch", signal: sessionSignal,
            }),
            previous?.materialUploads?.quiesce?.({
              reason: "project-switch", signal: sessionSignal,
            }),
          ]);
        } catch (cause) {
          if (cause?.code === "RECONCILIATION_REQUIRED") throw cause;
          throw new StudioBootstrapError(
            "The current modeling project still has an unfinished import or material upload.",
            { code: "PROJECT_BUSY", cause },
          );
        } finally {
          scope.clearTimeout?.(sessionTimeout);
        }
        await previous?.store?.whenIdle?.({ timeoutMilliseconds: 10_000 });
        abortError(transitionSignal);
        if (!currentReadOnly) {
          await flushDeviceCheckpoint(current, previous?.store ?? store,
            previous?.checkpointQueue ?? checkpointQueue, {
              preserveProjectIds: [projectId],
            });
          if (create) {
            await reclaimInactiveProjects(current, {
              maxProjects: MAX_SAVED_DEMO_PROJECTS - 1,
              preserveProjectIds: [projectId],
            });
          }
        }
        pendingGeometry = createProjectGeometryOwner(projectId,
          transitionGeneration);
        if (pendingGeometry !== null) {
          await prepareProjectGeometryOwner(pendingGeometry, {
            projectId, generation: transitionGeneration,
            signal: transitionSignal, navigation: true,
          });
        }
        next = createDevicePersistence({
          scope,
          projectId,
          projectName: selectedName,
          compatibility: persistenceCompatibility,
          runtimeEpoch: 4,
          ...(pendingGeometry === null ? {} : {
            geometryCompute: pendingGeometry }),
        });
        if (acquire) {
          if (typeof next.beginReleasedWriterAcquisition !== "function") {
            throw new StudioBootstrapError(
              "This browser cannot safely acquire its current modeling project writer.",
              { code: "PROJECT_ACQUISITION_UNAVAILABLE" },
            );
          }
          provision = await next.beginReleasedWriterAcquisition({
            sceneAssetId: authenticatedSeed.sceneAssetId,
            scenePath: authenticatedSeed.scenePath,
            compatibility: persistenceCompatibility,
            verifyCheckpoint: verifyProjectCheckpoint,
            ...(transitionSignal ? { signal: transitionSignal } : {}),
          });
        } else if (typeof next.beginProjectProvision === "function") {
          provision = await next.beginProjectProvision({
            acknowledged: true, create,
            sceneAssetId: authenticatedSeed.sceneAssetId,
            scenePath: authenticatedSeed.scenePath,
            compatibility: persistenceCompatibility,
            verifyCheckpoint: verifyProjectCheckpoint,
          });
        } else {
          await next.enable({ acknowledged: true });
          const restored = create ? null : await next.restore({
            sceneAssetId: authenticatedSeed.sceneAssetId,
            scenePath: authenticatedSeed.scenePath,
            compatibility: persistenceCompatibility,
            verifyCheckpoint: verifyProjectCheckpoint,
          });
          provision = { persistence: next, checkpoint: restored,
            commit() {}, rollback: () => next.dispose?.() };
        }
        if (!acquire && (next.status?.().readOnly === true
            || next.status?.().enabled !== true)) {
          throw new StudioBootstrapError("Another browser tab owns the selected project writer.", {
            code: "PROJECT_READ_ONLY",
          });
        }
        if (create && currentReadOnly) {
          await reclaimInactiveProjects(next, {
            maxProjects: MAX_SAVED_DEMO_PROJECTS - 1,
            preserveProjectIds: [previous?.project?.projectId],
          });
        }
        if (!create && !provision.checkpoint) {
          throw new StudioBootstrapError("The selected saved project has no complete checkpoint.", {
            code: "PROJECT_RECOVERY_REQUIRED",
          });
        }
        const projects = typeof next.listProjects === "function" ? await next.listProjects() : [];
        const catalogEntry = Array.isArray(projects)
          ? projects.find((entry) => entry.projectId === projectId) : null;
        const selectedProject = {
          projectId,
          displayName: catalogEntry?.displayName ?? selectedName,
          ...(Number.isSafeInteger(catalogEntry?.createdAt)
            ? { createdAt: catalogEntry.createdAt } : {}),
          ...(Number.isSafeInteger(catalogEntry?.updatedAt)
            ? { updatedAt: catalogEntry.updatedAt } : {}),
          ...(Number.isSafeInteger(catalogEntry?.revision)
            ? { revision: catalogEntry.revision } : {}),
        };
        candidate = createProjectOwner({
          project: selectedProject,
          persistence: next,
          source: create ? authenticatedSeed : provision.checkpoint,
          restored: !create,
          generation: transitionGeneration,
        });
        if (previous && !sameDescriptorCatalog(previous.descriptorsByName,
          candidate.descriptorsByName)) {
          throw new StudioBootstrapError("The selected project changed its registered modeling tool catalog.", {
            code: "PROJECT_TOOL_CATALOG_CHANGED",
          });
        }
        sourceSnapshot = await (previous?.store ?? store).buildSnapshot();
        const destinationSnapshot = await candidate.store.buildSnapshot();
        reserveDenseOwnerGrant(pendingGeometry, destinationSnapshot);
        abortError(transitionSignal);
        previous?.cameraGuidance?.cancel?.();
        cancelRendererObservation?.();
        const result = typeof runtime.resetProject === "function"
          ? await runtime.resetProject(destinationSnapshot, {
            expectedPreviousSnapshotId: sourceSnapshot.snapshotId,
            expectedPreviousSceneSourceHash: sourceSnapshot.sceneSourceHash,
            projectId,
            signal: transitionSignal,
          })
          : await runtime.applySnapshot(destinationSnapshot, {
            expectedPreviousSnapshotId: sourceSnapshot.snapshotId,
            expectedPreviousSceneSourceHash: sourceSnapshot.sceneSourceHash,
            signal: transitionSignal,
          });
        const presented = presentationStatus(result, runtime);
        if (presented?.applied !== true || presented.requiredAssetsReady !== true ||
            presented.snapshotId !== destinationSnapshot.snapshotId) {
          throw new StudioBootstrapError("The selected project was not genuinely accepted by the renderer.", {
            code: "PROJECT_PRESENTATION_FAILED",
          });
        }
        destinationPresented = true;
        if (!Number.isSafeInteger(result?.presentedFrames) || result.presentedFrames < 2) {
          await runtime.waitForPresentedFrames({ minimumFrames: 2, frames: 2,
            timeoutMilliseconds: presentationTimeoutMilliseconds, signal: transitionSignal });
        }
        abortError(transitionSignal);
        promoteDenseOwnerGrant(pendingGeometry);
        pendingGeometry?.promote?.({ snapshotId: destinationSnapshot.snapshotId,
          sceneSourceHash: destinationSnapshot.sceneSourceHash,
          assetManifestHash: destinationSnapshot.assetManifestHash });
        if (create) {
          await checkpointDeviceStore(next, candidate.store, {
            preserveProjectIds: [previous?.project?.projectId],
          });
        }
        if (!acquire) {
          writeActiveProject(projectId);
          selectionWritten = true;
        }
        await provision.commit?.();
        ownerCommitted = true;
        unsubscribeStore?.();
        currentOwner = candidate;
        activeProject = candidate.project;
        store = candidate.store;
        deviceCache = candidate.persistence;
        checkpointQueue = candidate.checkpointQueue;
        referenceAssets = candidate.referenceAssets;
        inspection = candidate.inspection;
        cameraGuidance = candidate.cameraGuidance;
        exportAssets = candidate.exportAssets;
        modelImportService = candidate.modelImportService;
        modelImports = candidate.modelImports;
        modelArtifacts = candidate.modelArtifacts;
        materialAuthoring = candidate.materialAuthoring;
        materialUploads = candidate.materialUploads;
        committedRevision = candidate.store.getRevision();
        unsubscribeStore = typeof store.subscribe === "function"
          ? store.subscribe(observeSceneState) : null;
        clearExportOffers();
        activeAgentInvocations.splice(0);
        try {
          if (typeof ui?.resetProjectState === "function") {
            ui.resetProjectState({ projectId, projectGeneration: transitionGeneration,
              store, referenceService: referenceAssets, materialService: store,
              materialAuthoringService: materialAuthoring, deviceCache });
          } else {
            ui?.setStore?.(store);
            ui?.setDeviceCache?.(deviceCache);
            ui?.setReferenceService?.(referenceAssets);
            ui?.setMaterialService?.(store);
            ui?.setMaterialAuthoringService?.(materialAuthoring);
          }
          ui?.setOwner?.({ owner: candidate,
            ownerGeneration: transitionGeneration });
        } catch (uiError) {
          scope.console?.warn?.("The committed project observer could not fully refresh.", uiError);
        }
        projectNavigationPending = false;
        authenticatePresentedOwnerFrame(candidate, runtime.status?.(), {
          snapshot: destinationSnapshot,
        });
        publish({ phase: state.webmcpReady ? "ready" : "renderer-ready",
          switching: false, projectGeneration: transitionGeneration,
          rendererReady: true, webgpuReady: true, rendererSettling: false,
          recoveryRequired: false, unknownOutcome: false,
          recoveryReason: null, operationOutcome: null, error: null,
          sceneRevision: store.getRevision(),
          message: acquire
            ? "Editing access was acquired using the latest saved modeling project."
            : "The selected modeling project is ready in the existing agent session." });
        observeRendererLifecycle(candidate);
        publishCurrentProject();
        try {
          await disposeOwnerResources(previous);
        } catch (retireError) {
          scope.console?.warn?.("The previous project owner could not fully retire.", retireError);
        }
        candidate = null;
        pendingGeometry = null;
        provision = null;
        next = null;
        return Object.freeze({ ...currentProject(), navigationPending: false,
          settled: state.webmcpReady === true,
          toolSessionPreserved: true,
          documentGeneration: state.documentGeneration,
          registrationGeneration: state.registrationGeneration,
          projectGeneration: transitionGeneration,
          revision: store.getRevision(),
          snapshotId: destinationSnapshot.snapshotId });
      } catch (error) {
        if (ownerCommitted) {
          projectNavigationPending = false;
          authenticatePresentedOwnerFrame(currentOwner, runtime.status?.());
          publish({ phase: state.webmcpReady ? "ready" : "renderer-ready",
            switching: false, projectGeneration: transitionGeneration,
            rendererReady: runtime.status?.().ready === true,
            webgpuReady: runtime.status?.().ready === true });
          throw error;
        }
        if (selectionWritten) {
          for (const [storage, prior] of [[tabStorage, previousTabProject],
            [profileStorage, previousProfileProject]]) {
            try {
              if (storage?.getItem?.(activeProjectStorageKey) !== projectId) continue;
              if (prior === null) storage.removeItem?.(activeProjectStorageKey);
              else storage.setItem(activeProjectStorageKey, prior);
            } catch (pointerError) {
              scope.console?.warn?.("The previous project selection could not be restored.", pointerError);
            }
          }
        }
        const actualRenderer = runtime?.status?.();
        const nativeOwnerChanged = sourceSnapshot && (
          typeof actualRenderer?.snapshotId === "string" &&
            actualRenderer.snapshotId !== sourceSnapshot.snapshotId ||
          typeof actualRenderer?.sceneSourceHash === "string" &&
            actualRenderer.sceneSourceHash !== sourceSnapshot.sceneSourceHash);
        const uncertainDispatch = actualRenderer?.phase === "reconciling"
          || error?.code === "RECONCILIATION_REQUIRED";
        if ((destinationPresented || nativeOwnerChanged || uncertainDispatch) && sourceSnapshot) {
          try {
            const originalDense = sourceSnapshot.snapshot?.renderRequirements
              ?.required?.includes("modeling.asset.dense.v1") === true;
            if (originalDense) {
              revokeDenseOwnerGrant(pendingGeometry);
              reserveDenseOwnerGrant(previous?.geometryCompute, sourceSnapshot);
            }
            let sourcePresentation;
            if (uncertainDispatch && typeof runtime.reconcile === "function") {
              sourcePresentation = await runtime.reconcile(sourceSnapshot, {
                signal: controller?.signal,
              });
            } else if (typeof runtime.resetProject === "function") {
              sourcePresentation = await runtime.resetProject(sourceSnapshot, {
                expectedPreviousSnapshotId: runtime.status?.().snapshotId,
                expectedPreviousSceneSourceHash: runtime.status?.().sceneSourceHash,
                projectId: previous?.project?.projectId,
                signal: controller?.signal,
              });
            } else {
              sourcePresentation = await runtime.applySnapshot(sourceSnapshot, {
                signal: controller?.signal,
              });
            }
            if (!Number.isSafeInteger(sourcePresentation?.presentedFrames)
                || sourcePresentation.presentedFrames < 2) {
              await runtime.waitForPresentedFrames({ minimumFrames: 2, frames: 2,
                timeoutMilliseconds: presentationTimeoutMilliseconds, signal: controller?.signal });
            }
            if (originalDense) {
              await runtime.waitForPresentedFrames({ minimumFrames: 2, frames: 2,
                timeoutMilliseconds: presentationTimeoutMilliseconds,
                signal: controller?.signal });
              promoteDenseOwnerGrant(previous?.geometryCompute);
            }
          } catch (recoveryError) {
            projectRecoveryRequired = true;
            publish({ phase: "recovery-required", switching: false,
              rendererReady: false, webgpuReady: false,
              error: { code: "PROJECT_RECOVERY_REQUIRED",
                message: recoveryError?.message ?? "The original project could not be presented." } });
          }
        }
        await disposeOwnerResources(candidate, { writer: false });
        if (pendingGeometry !== null) {
          revokeDenseOwnerGrant(pendingGeometry);
          pendingGeometry.dispose?.();
          projectGeometryOwners.delete(projectGeometryKey(projectId,
            transitionGeneration));
        }
        if (provision) await provision.rollback?.();
        else await next?.dispose?.();
        projectNavigationPending = false;
        if (!projectRecoveryRequired && !disposed) {
          const recoveredGeneration = transitionGeneration + 1;
          const previousGeneration = previous?.projectGeneration;
          previous?.modelArtifacts?.rebindOwnerGeneration?.({
            projectId: previous.project?.projectId,
            store: previous.store,
            previousGeneration,
            projectGeneration: recoveredGeneration,
          });
          if (previous) {
            previous.projectGeneration = recoveredGeneration;
            rebindExportOffers(previous, previousGeneration, recoveredGeneration);
          }
          state.projectGeneration = recoveredGeneration;
          if (previous) {
            ui?.setOwner?.({ owner: previous,
              ownerGeneration: recoveredGeneration });
          }
          authenticatePresentedOwnerFrame(previous, runtime.status?.(), {
            snapshot: sourceSnapshot ?? previous?.store?.getInspectionCheckpoint?.(),
          });
          publish({ phase: state.webmcpReady ? "ready" : "renderer-ready",
            switching: false, projectGeneration: recoveredGeneration,
            rendererReady: runtime.status?.().ready === true,
            webgpuReady: runtime.status?.().ready === true,
            rendererSettling: false, recoveryRequired: false,
            unknownOutcome: false, recoveryReason: null, operationOutcome: null,
            message: "The original modeling project remains open." });
          previous?.store?.resumeMutations?.();
          previous?.modelImports?.resume?.();
          previous?.materialUploads?.resume?.();
          observeRendererLifecycle(previous);
        }
        throw error;
      } finally {
        projectNavigation = null;
      }
    })();
    return projectNavigation;
  };

  const projectController = Object.freeze({
    getActiveProject: currentProject,
    getCurrentProject: currentProject,
    projectStatus: () => ownershipStatus(),
    listProjects,
    subscribe(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("A modeling project listener must be a function.");
      }
      projectListeners.add(listener);
      listener(currentProject());
      return () => projectListeners.delete(listener);
    },
    async createProject({ name } = {}) {
      const displayName = safeProjectName(name);
      const uuid = scope.crypto?.randomUUID?.();
      if (!PROJECT_UUID.test(uuid ?? "")) {
        throw new StudioBootstrapError("The browser could not generate a safe project identifier.", {
          code: "PROJECT_ID_UNAVAILABLE",
        });
      }
      return switchProject({
        projectId: `${legacyProjectId}:${uuid}`,
        displayName,
        create: true,
      });
    },
    async openProject({ projectId } = {}) {
      if (!validProjectIdentifier(projectId, legacyProjectId)) {
        throw new StudioBootstrapError("The selected modeling project has an invalid identity.", {
          code: "INVALID_PROJECT_ID",
        });
      }
      if (projectId === activeProject?.projectId) return currentProject();
      const projects = await listProjects();
      const selected = projects.find((entry) => entry.projectId === projectId);
      if (!selected) {
        throw new StudioBootstrapError("The selected modeling project was not found on this device.", {
          code: "PROJECT_NOT_FOUND",
        });
      }
      return switchProject({ projectId, displayName: selected.displayName });
    },
    async acquireProject({ signal } = {}) {
      if (signal !== undefined && (signal === null || typeof signal !== "object"
          || typeof signal.aborted !== "boolean")) {
        throw new StudioBootstrapError("Project acquisition requires a valid cancellation signal.", {
          code: "INVALID_ARGUMENT",
        });
      }
      abortError(signal);
      if (!projectScenePresented || projectRecoveryRequired || !activeProject) {
        throw new StudioBootstrapError("The current saved modeling project requires recovery.", {
          code: "PROJECT_RECOVERY_REQUIRED",
        });
      }
      if (projectNavigation || projectNavigationPending) {
        throw new StudioBootstrapError("A modeling project is already changing ownership.", {
          code: "PROJECT_SWITCH_PENDING",
        });
      }
      const current = ownershipStatus();
      if (current.hasWriter) return currentProject();
      if (!current.consented || deviceCache?.isAutoSaveDisabled?.() === true) {
        throw new StudioBootstrapError(
          "Existing device-local saving consent is required to acquire project editing.",
          { code: "CONSENT_REQUIRED" },
        );
      }
      if (!current.readOnly) {
        throw new StudioBootstrapError("The current modeling project has no recoverable reader.", {
          code: "PROJECT_ACQUISITION_UNAVAILABLE",
        });
      }
      return switchProject({ projectId: activeProject.projectId,
        displayName: activeProject.displayName, acquire: true,
        ...(signal ? { signal } : {}) });
    },
    async renameProject({ projectId = activeProject?.projectId, name } = {}) {
      if (!projectScenePresented || projectRecoveryRequired) {
        throw new StudioBootstrapError("The current saved modeling project requires recovery.", {
          code: "PROJECT_RECOVERY_REQUIRED",
        });
      }
      const displayName = safeProjectName(name);
      if (!validProjectIdentifier(projectId, legacyProjectId)) {
        throw new StudioBootstrapError("The selected modeling project has an invalid identity.", {
          code: "INVALID_PROJECT_ID",
        });
      }
      if (projectNavigation || projectNavigationPending) {
        throw new StudioBootstrapError("A modeling project is already being opened.", {
          code: "PROJECT_SWITCH_PENDING",
        });
      }
      if (deviceCache?.status?.().enabled !== true
          || deviceCache.status().consented !== true) {
        throw new StudioBootstrapError("Renaming a project requires its acknowledged device writer.", {
          code: deviceCache?.status?.().readOnly === true ? "PROJECT_READ_ONLY" : "CONSENT_REQUIRED",
        });
      }
      const selected = (await listProjects()).find((entry) => entry.projectId === projectId);
      if (!selected) {
        throw new StudioBootstrapError("The selected modeling project was not found on this device.", {
          code: "PROJECT_NOT_FOUND",
        });
      }
      const current = projectId === activeProject.projectId;
      let target = current ? deviceCache : null;
      try {
        if (!current) {
          target = createDevicePersistence({ scope, projectId, runtimeEpoch: 4,
            projectName: selected.displayName, compatibility: persistenceCompatibility });
          if (target.hasConsent?.() !== true) {
            throw new StudioBootstrapError("The selected project has not enabled device-local saving.", {
              code: "CONSENT_REQUIRED",
            });
          }
          await target.restore({ sceneAssetId: authenticatedSeed.sceneAssetId,
            scenePath: authenticatedSeed.scenePath, compatibility: persistenceCompatibility });
        }
        if (typeof target?.renameProject !== "function") {
          throw new StudioBootstrapError("This browser cannot rename saved modeling projects.", {
            code: "PROJECT_MANAGEMENT_UNAVAILABLE",
          });
        }
        const renamed = await target.renameProject({ name: displayName });
        const result = Object.freeze({ ...selected, ...renamed, active: current });
        if (current) {
          activeProject = { ...activeProject, displayName: result.displayName,
            ...(Number.isSafeInteger(result.updatedAt) ? { updatedAt: result.updatedAt } : {}) };
        }
        publishCurrentProject();
        return current ? currentProject() : result;
      } finally {
        if (!current) await target?.dispose?.();
      }
    },
    async deleteProject({ projectId, confirm } = {}) {
      if (!projectScenePresented || projectRecoveryRequired) {
        throw new StudioBootstrapError("The current saved modeling project requires recovery.", {
          code: "PROJECT_RECOVERY_REQUIRED",
        });
      }
      if (confirm !== true) {
        throw new StudioBootstrapError("Deleting a saved modeling project requires explicit confirmation.", {
          code: "PROJECT_CONFIRMATION_REQUIRED",
        });
      }
      if (!validProjectIdentifier(projectId, legacyProjectId)) {
        throw new StudioBootstrapError("The selected modeling project has an invalid identity.", {
          code: "INVALID_PROJECT_ID",
        });
      }
      if (projectId === activeProject?.projectId) {
        throw new StudioBootstrapError("Open another project before deleting the current project.", {
          code: "ACTIVE_PROJECT_DELETE_UNSUPPORTED",
        });
      }
      if (projectNavigation || projectNavigationPending) {
        throw new StudioBootstrapError("A modeling project is already being opened.", {
          code: "PROJECT_SWITCH_PENDING",
        });
      }
      if (deviceCache?.status?.().enabled !== true
          || deviceCache.status().consented !== true) {
        throw new StudioBootstrapError("Deleting a project requires its acknowledged device writer.", {
          code: deviceCache?.status?.().readOnly === true ? "PROJECT_READ_ONLY" : "CONSENT_REQUIRED",
        });
      }
      const projects = await listProjects();
      if (projects.length <= 1) {
        throw new StudioBootstrapError("The last saved modeling project cannot be deleted.", {
          code: "PROJECT_LAST_REMAINING",
        });
      }
      const selected = projects.find((entry) => entry.projectId === projectId);
      if (!selected) {
        throw new StudioBootstrapError("The selected modeling project was not found on this device.", {
          code: "PROJECT_NOT_FOUND",
        });
      }
      let quotaRecoveryRequired = false;
      try {
        await flushDeviceCheckpoint(deviceCache, store,
          currentOwner?.checkpointQueue ?? checkpointQueue, {
            preserveProjectIds: [projectId],
            reportFailure: false,
          });
      } catch (error) {
        if (error?.code !== "QUOTA_EXCEEDED") {
          deviceCache.reportError?.(error);
          throw error;
        }
        quotaRecoveryRequired = true;
      }
      let target = null;
      try {
        target = createDevicePersistence({ scope, projectId, runtimeEpoch: 4,
          projectName: selected.displayName, compatibility: persistenceCompatibility });
        if (target.hasConsent?.() !== true) {
          throw new StudioBootstrapError("The selected project has not enabled device-local saving.", {
            code: "CONSENT_REQUIRED",
          });
        }
        await target.restore({ sceneAssetId: authenticatedSeed.sceneAssetId,
          scenePath: authenticatedSeed.scenePath, compatibility: persistenceCompatibility });
        if (typeof target.deleteProject !== "function") {
          throw new StudioBootstrapError("This browser cannot delete saved modeling projects.", {
            code: "PROJECT_MANAGEMENT_UNAVAILABLE",
          });
        }
        await target.deleteProject();
        const current = publishCurrentProject();
        let saveError = null;
        if (quotaRecoveryRequired) {
          try {
            await flushDeviceCheckpoint(deviceCache, store,
              currentOwner?.checkpointQueue ?? checkpointQueue);
          } catch (error) {
            saveError = Object.freeze({
              code: boundedText(error?.code, 64) || "PROJECT_CHECKPOINT_FAILED",
              message: boundedText(error?.message, 240)
                || "The current modeling project could not be saved on this device.",
            });
          }
        }
        return Object.freeze({ projectId, deleted: true, activeProject: current,
          ...(saveError === null ? {} : { saveError }) });
      } finally {
        await target?.dispose?.();
      }
    },
  });

  const observerInvocation = (value) => {
    if (!value || typeof value !== "object") return;
    const name = boundedText(value.name, 128);
    const status = ["started", "completed", "failed", "aborted"].includes(value.status)
      ? value.status : null;
    if (!name || !status) return;
    const owner = currentOwner;
    const ownerGeneration = owner?.projectGeneration;
    const projectCompletion = status === "completed"
      && ["project_create", "project_open", "project_acquire"].includes(name)
      && value.result?.projectId === owner?.project?.projectId;
    if (!owner || (value.owner !== undefined && value.owner !== owner
        || value.ownerGeneration !== undefined && value.ownerGeneration !== ownerGeneration)
        && !projectCompletion) return;
    const invocationId = boundedText(value.invocationId, 128);
    const readOnly = currentOwner?.descriptorsByName.get(name)
      ?.annotations?.readOnlyHint === true;

    const entry = {
      name,
      status,
      owner,
      ownerGeneration,
      ...(invocationId ? { invocationId } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(typeof value.unknownOutcome === "boolean"
        ? { unknownOutcome: value.unknownOutcome } : {}),
      ...(typeof value.recoveryRequired === "boolean"
        ? { recoveryRequired: value.recoveryRequired } : {}),
      ...(typeof value.operationOutcome === "string"
        ? { operationOutcome: boundedText(value.operationOutcome, 40) } : {}),
      ...(typeof value.recoveryReason === "string"
        ? { recoveryReason: boundedText(value.recoveryReason, 64) } : {}),
      ...(typeof value.committed === "boolean" ? { committed: value.committed }
        : value.result?.committed === false ? { committed: false } : {}),
      ...(typeof value.snapshotId === "string"
        ? { snapshotId: boundedText(value.snapshotId, 80) } : {}),
      ...(typeof value.sceneSourceHash === "string"
        ? { sceneSourceHash: boundedText(value.sceneSourceHash, 80) } : {}),
      ...(typeof value.assetManifestHash === "string"
        ? { assetManifestHash: boundedText(value.assetManifestHash, 80) } : {}),
      ...(typeof value.detail === "string" ? { detail: boundedText(value.detail, 240) } : {}),
      ...(typeof value.operation === "string"
        ? { operation: boundedText(value.operation, 80) } : {}),
      ...(Number.isSafeInteger(value.revision) ? { revision: value.revision } : {}),
      ...(Number.isSafeInteger(value.previousRevision)
        ? { previousRevision: value.previousRevision } : {}),
      ...(typeof value.entityId === "string" ? { entityId: boundedText(value.entityId, 128) } : {}),
      ...(typeof value.selection === "string" ? { selection: boundedText(value.selection, 128) } : {}),
      ...(Number.isSafeInteger(value.vertexCount) && value.vertexCount >= 0
        ? { vertexCount: value.vertexCount } : {}),
      ...(Number.isSafeInteger(value.faceCount) && value.faceCount >= 0
        ? { faceCount: value.faceCount } : {}),
      ...(Number.isSafeInteger(value.triangleCount) && value.triangleCount >= 0
        ? { triangleCount: value.triangleCount } : {}),
      ...(Number.isSafeInteger(value.renderVertexCount) && value.renderVertexCount >= 0
        ? { renderVertexCount: value.renderVertexCount } : {}),
      ...(typeof value.sceneChanged === "boolean" ? { sceneChanged: value.sceneChanged } : {}),
      ...(Number.isFinite(value.durationMilliseconds)
        ? { durationMilliseconds: Math.max(0, Math.round(value.durationMilliseconds)) } : {}),
      ...(typeof value.at === "string" ? { at: boundedText(value.at, 64) } : {}),
      ...(value.error && typeof value.error === "object" ? {
        error: {
          code: boundedText(value.error.code, 64) || "INVOCATION_FAILED",
          message: boundedText(value.error.message, 240) || "The agent operation failed.",
        },
      } : {}),
    };

    if (status === "started") {
      if (activeAgentInvocations.length >= 32) activeAgentInvocations.shift();
      activeAgentInvocations.push({ name,
        ...(invocationId ? { invocationId } : {}),
        revision: store?.getRevision?.(), readOnly });
    }

    const phase = status === "started" ? "running" : status;
    const activity = {
      phase,
      toolName: name,
      owner,
      ownerGeneration,
      ...(invocationId ? { invocationId } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(typeof entry.unknownOutcome === "boolean"
        ? { unknownOutcome: entry.unknownOutcome } : {}),
      ...(typeof entry.recoveryRequired === "boolean"
        ? { recoveryRequired: entry.recoveryRequired } : {}),
      ...(entry.operationOutcome ? { operationOutcome: entry.operationOutcome } : {}),
      ...(entry.recoveryReason ? { recoveryReason: entry.recoveryReason } : {}),
      ...(typeof entry.committed === "boolean" ? { committed: entry.committed } : {}),
      ...(entry.snapshotId ? { snapshotId: entry.snapshotId } : {}),
      ...(entry.sceneSourceHash ? { sceneSourceHash: entry.sceneSourceHash } : {}),
      ...(entry.assetManifestHash ? { assetManifestHash: entry.assetManifestHash } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(entry.operation ? { operation: entry.operation } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.durationMilliseconds === undefined
        ? {} : { durationMilliseconds: entry.durationMilliseconds }),
      ...(Number.isSafeInteger(store?.getRevision?.())
        ? { revision: store.getRevision() } : {}),
    };
    const logInvocation = typeof ui?.logAgentInvocation === "function"
      ? ui.logAgentInvocation.bind(ui)
      : typeof ui?.logToolInvocation === "function"
        ? ui.logToolInvocation.bind(ui) : null;
    logInvocation?.(entry);
    ui?.setAgentActivity?.(activity);
    if (["material_sample_apply", "material_create",
      "material_upload_commit"].includes(name) && status === "completed" &&
        (value.sceneChanged === true || typeof value.result?.materialId === "string") &&
        (!Number.isSafeInteger(value.revision) || value.revision === store?.getRevision?.())) {
      const current = store?.getState?.();
      const entityId = value.entityId || value.selection || current?.selectedEntityId ||
        current?.selection;
      const material = current?.scene?.entities?.[entityId]?.components?.["oriel.material"]
        ?? value.result?.material;
      if (material && typeof material === "object") {
        ui?.setPresentation?.({
          kind: "material",
          materialName: boundedText(value.result?.name, 128)
            || boundedText(value.result?.materialName, 128)
            || boundedText(value.result?.sampleId, 128) || "Procedural material",
          ...(typeof value.result?.materialId === "string"
            ? { materialId: boundedText(value.result.materialId, 128) } : {}),
          ...(typeof value.result?.materialHandle === "string"
            ? { materialHandle: boundedText(value.result.materialHandle, 128) } : {}),
          ...(typeof value.result?.category === "string"
            ? { family: boundedText(value.result.category, 64) } : {}),
          material,
        });
      }
    }
    const rendererStatus = runtime?.status?.();
    if (entry.error?.code === "RECONCILIATION_REQUIRED"
        || rendererStatus?.phase === "reconciling"
        || rendererStatus?.recoveryRequired === true) {
      const unknownOutcome = value.unknownOutcome === true
        || rendererStatus?.unknownOutcome === true
        || rendererStatus?.recoveryReason === "unknown_submission";
      const operationOutcome = boundedText(value.operationOutcome, 40)
        || boundedText(rendererStatus?.operationOutcome, 40)
        || (unknownOutcome ? "unknown" : null);
      const recoveryReason = boundedText(value.recoveryReason, 64)
        || boundedText(rendererStatus?.recoveryReason, 64)
        || (unknownOutcome ? "unknown_submission" : null);
      publish({ phase: "recovery-required", rendererReady: false,
        webgpuReady: false, rendererLabel: "Renderer recovery required",
        rendererSettling: false, recoveryRequired: true, unknownOutcome,
        recoveryReason, operationOutcome,
        agentActivity: "failed", agentTool: name,
        error: { code: "RECONCILIATION_REQUIRED",
          message: entry.error?.message
            || (unknownOutcome
              ? "The interrupted modeling operation has an unknown outcome; recover the current project."
              : "The modeling renderer requires recovery from the current committed project.") },
        message: unknownOutcome
          ? "The interrupted modeling operation has an unknown outcome. Recover the current project before editing."
          : operationOutcome === "applied_uncommitted"
            ? "The renderer applied an update that did not commit; recover the last committed project."
            : "Recover the current committed modeling project before editing." });
    } else {
      publish({ agentActivity: phase, agentTool: name });
    }

    if (status !== "started") {
      if (!invocationId) return;
      for (let index = activeAgentInvocations.length - 1; index >= 0; index -= 1) {
        if (activeAgentInvocations[index].invocationId === invocationId) {
          activeAgentInvocations.splice(index, 1);
          break;
        }
      }
    }
  };

  const observeSceneState = (value) => {
    if (!value || typeof value !== "object" || !Number.isSafeInteger(value.revision)) return;
    if (!Number.isSafeInteger(committedRevision)) {
      committedRevision = value.revision;
      return;
    }
    if (value.revision <= committedRevision) return;

    const previousRevision = committedRevision;
    committedRevision = value.revision;
    const invocation = currentInvocation();
    const transaction = {
      phase: "committed",
      revision: value.revision,
      previousRevision,
      source: invocation ? "codex" : "viewer",
      ...(invocation ? { operation: invocation.name } : {}),
      ...(typeof value.selectedEntityId === "string"
        ? { entityId: boundedText(value.selectedEntityId, 128) }
        : typeof value.selection === "string"
          ? { entityId: boundedText(value.selection, 128) } : {}),
      ...(Number.isSafeInteger(value.entityCount) ? { entityCount: value.entityCount } : {}),
    };
    ui?.logSceneTransaction?.(transaction);
    const pending = pendingOwnerReady;
    const renderer = runtime?.status?.();
    const ownerReady = pending?.owner === currentOwner
      && pending.projectGeneration === state.projectGeneration
      && pending.documentGeneration === state.documentGeneration
      && renderer?.ready === true
      && authenticatePresentedOwnerFrame(currentOwner, renderer);
    if (ownerReady) pendingOwnerReady = null;
    publish({ sceneRevision: value.revision,
      ...(ownerReady ? {
        phase: state.webmcpReady ? "ready" : "renderer-ready",
        rendererReady: true, webgpuReady: true, rendererSettling: false,
        recoveryRequired: false, unknownOutcome: false,
        recoveryReason: null, operationOutcome: null,
        rendererLabel: "Ready · WebGPU", error: null,
        message: "The current modeling project is ready.",
      } : {}) });
    void queueDeviceCheckpoint();

    if (invocation && renderer?.ready === true) {
      ui?.setRenderActivity?.({
        phase: "rendered",
        revision: value.revision,
        ...(Number.isSafeInteger(renderer.presentedFrames)
          ? { presentedFrames: renderer.presentedFrames } : {}),
        ...(typeof renderer.snapshotId === "string"
          ? { snapshotId: boundedText(renderer.snapshotId, 80) } : {}),
      });
    }
  };

  const registrarStatus = (value = registrar?.getStatus?.() || registrar?.status?.()) => {
    if (!value || typeof value !== "object") return;
    const registeredNames = Array.isArray(value.registeredNames)
      ? [...value.registeredNames]
      : Array.isArray(value.tools)
        ? value.tools.map((tool) => typeof tool === "string" ? tool : tool?.name).filter(Boolean)
        : [];
    const ready = value.ready === true && registeredNames.length > 0 &&
      (!stableTools || registeredNames.length === stableTools.length);
    publish({
      webmcpReady: ready,
      registeredNames,
      registrationGeneration: Number.isSafeInteger(value.registrationGeneration)
        ? value.registrationGeneration : state.registrationGeneration,
      catalogHash: typeof value.catalogHash === "string" ? value.catalogHash : null,
      ...(state.rendererReady && !state.switching ? {
        phase: ready ? "ready" : value.state === "registering" ? "registering-tools" : "renderer-ready",
      } : {}),
      agentBridgeObserved: state.agentBridgeObserved || value.agentBridgeObserved === true,
    });
    if (ready && !pageToolBridge && stableTools && registrar) {
      pageToolBridge = installPageToolBridge({ scope, document, registrar,
        tools: stableTools, getLifecycle: snapshot });
    }
  };

  const registerPublicTools = async () => {
    if (!Array.isArray(stableInternalTools) || !currentOwner) {
      throw new StudioBootstrapError("The browser-owned modeling operations are unavailable.", {
        code: "WEBMCP_NOT_READY",
      });
    }
    if (state.rendererReady !== true || projectNavigationPending || state.switching
        || !authenticatePresentedOwnerFrame(currentOwner, runtime?.status?.())) {
      throw new StudioBootstrapError(
        "The native renderer has not genuinely presented the current modeling project owner.",
        { code: "WEBMCP_NOT_READY" },
      );
    }
    let catalog = publicToolCatalog;
    if (!catalog) {
      const actualPageUrl = scope.location?.href;
      const location = actualPageUrl === undefined
        ? safeLocation(scope) : new URL(actualPageUrl);
      catalog = createPublicToolCatalog({
        toolDefinitions: stableInternalTools,
        origin: location.origin,
        pageUrl: actualPageUrl ?? location.href,
        crypto: scope.crypto,
        getLifecycleIdentity: () => ({
          documentGeneration: state.documentGeneration,
          projectGeneration: state.projectGeneration,
          registrationGeneration: state.registrationGeneration,
        }),
      });
      publicToolCatalog = catalog;
    }
    failedCatalogPageUrl = null;
    stableTools = catalog.tools;
    publish({
      phase: "registering-tools",
      catalogHostBytes: catalog.hostBytes,
      error: null,
      message: "Registering the bounded browser-owned modeling tool catalog.",
    });
    registrar = createRegistrar({
      window: scope,
      document,
      tools: stableTools,
      onStatusChange: registrarStatus,
      onInvocation: ({ name } = {}) => {
        publish({
          agentBridgeObserved: true,
          ...(typeof name === "string" ? { agentTool: boundedText(name, 128) } : {}),
        });
      },
    });
    ui?.setRegistrar?.(registrar);
    if (typeof registrar?.subscribe === "function") {
      unsubscribeRegistrar = registrar.subscribe(registrarStatus);
    }
    await (registrar.start?.() || registrar.register?.());
    registrarStatus();
    if (state.webmcpReady) {
      pageToolBridge ??= installPageToolBridge({ scope, document, registrar,
        tools: stableTools, getLifecycle: snapshot });
      publish({
        phase: "ready",
        error: null,
        message: "Codex Modeling Studio and its modeling tools are ready.",
      });
    }
    return registrar.getStatus?.() ?? snapshot();
  };

  const reportRegistrationFailure = (error) => {
    const budgetExceeded = error?.code === "WEBMCP_CATALOG_BUDGET_EXCEEDED";
    if (budgetExceeded) failedCatalogPageUrl = scope.location?.href ?? null;
    scope.console?.warn?.("The renderer is ready, but WebMCP registration failed.", error);
    publish({
      phase: "renderer-ready",
      webmcpReady: false,
      registeredNames: [],
      ...(budgetExceeded ? {
        catalogHostBytes: Number.isSafeInteger(error.actualBytes) ? error.actualBytes : null,
        error: {
          code: "WEBMCP_CATALOG_BUDGET_EXCEEDED",
          message: "The public modeling tool catalog exceeds the browser host budget.",
        },
        message: "The modeling renderer is ready, but its public tool catalog exceeds the browser host budget.",
      } : {
        message: "The modeling renderer is ready, but the agent WebMCP bridge is unavailable.",
      }),
    });
  };

  const onRuntimeStatus = (value) => {
    if (!value || typeof value !== "object") return;
    const phase = boundedText(value.phase, 32);
    const signature = `${phase || "unknown"}|${value.snapshotId || ""}|${value.invalidationEpoch || ""}|${value.error?.code || ""}|${value.unknownOutcome === true}`;
    if (signature !== lastRuntimeActivity) {
      lastRuntimeActivity = signature;
      ui?.setRenderActivity?.({
        phase: phase || "unknown",
        ...(Number.isSafeInteger(value.presentedFrames)
          ? { presentedFrames: value.presentedFrames } : {}),
        ...(typeof value.snapshotId === "string"
          ? { snapshotId: boundedText(value.snapshotId, 80) } : {}),
        ...(value.error && typeof value.error === "object" ? {
          error: {
            code: boundedText(value.error.code, 64) || "RENDERER_FAILED",
            message: boundedText(value.error.message, 240) || "The modeling renderer failed.",
          },
        } : {}),
      });
      const invocation = currentInvocation();
      if (invocation && phase === "applying") {
        ui?.logSceneTransaction?.({
          phase: "started",
          revision: committedRevision,
          operation: invocation.name,
          source: "codex",
        });
      }
    }
    const owner = currentOwner;
    if (!owner || owner.projectGeneration !== state.projectGeneration
        || projectNavigationPending || state.switching === true || disposed) return;
    if (value.phase === "reconciling" || value.recoveryRequired === true) {
      const unknownOutcome = value.unknownOutcome === true
        || value.recoveryReason === "unknown_submission"
        || value.operationOutcome === "unknown";
      const operationOutcome = boundedText(value.operationOutcome, 40)
        || (unknownOutcome ? "unknown" : null);
      const recoveryReason = boundedText(value.recoveryReason, 64)
        || (unknownOutcome ? "unknown_submission" : null);
      publish({
        phase: "recovery-required",
        rendererReady: false,
        webgpuReady: false,
        rendererSettling: false,
        recoveryRequired: true,
        unknownOutcome,
        recoveryReason,
        operationOutcome,
        rendererLabel: "Renderer recovery required",
        error: { code: "RECONCILIATION_REQUIRED",
          message: boundedText(value.error?.message, 240)
            || "The modeling renderer requires owner-controlled recovery." },
        message: unknownOutcome
          ? "The interrupted modeling operation has an unknown outcome. Recover the current project before editing."
          : operationOutcome === "applied_uncommitted"
            ? "The renderer applied an update that did not commit; recover the last committed project."
            : "The modeling renderer requires recovery from the current committed project.",
      });
    } else if (value.phase === "failed" || value.phase === "error") {
      clearPresentedOwnerFrame();
      publish({
        phase: "error",
        rendererReady: false,
        webgpuReady: false,
        rendererSettling: false,
        recoveryRequired: value.recoveryRequired === true,
        unknownOutcome: value.unknownOutcome === true,
        rendererLabel: "Renderer failed",
        message: value.error?.message || value.message ||
          "The modeling renderer could not apply the scene.",
      });
    } else if (value.phase === "settling" || value.rendererSettling === true
        || value.phase === "suspended") {
      publish({
        phase: value.phase === "suspended" ? "renderer-suspended" : "renderer-settling",
        rendererReady: false,
        webgpuReady: value.phase !== "suspended",
        rendererSettling: value.phase !== "suspended",
        recoveryRequired: false,
        unknownOutcome: false,
        recoveryReason: null,
        operationOutcome: null,
        rendererLabel: value.phase === "suspended"
          ? "Renderer presentation paused" : "Updating WebGPU renderer",
        error: null,
        message: value.phase === "suspended"
          ? "Presentation is paused for the current modeling project."
          : "Updating the current modeling project while WebGPU pipelines settle.",
      });
    } else if (value.phase === "ready" && value.ready === true) {
      pendingOwnerReady = { owner,
        projectGeneration: owner.projectGeneration,
        documentGeneration: state.documentGeneration,
        snapshotId: value.snapshotId,
        sceneSourceHash: value.sceneSourceHash,
        assetManifestHash: value.assetManifestHash };
      if (authenticatePresentedOwnerFrame(owner, value)) {
        pendingOwnerReady = null;
        publish({
          phase: state.webmcpReady ? "ready" : "renderer-ready",
          rendererReady: true,
          webgpuReady: true,
          rendererSettling: false,
          recoveryRequired: false,
          unknownOutcome: false,
          recoveryReason: null,
          operationOutcome: null,
          rendererLabel: "Ready · WebGPU",
          error: null,
          message: "The current modeling project is ready.",
        });
      }
    } else if ((value.phase === "applying" || value.phase === "presenting")
        && ownerFrameStillVisible(owner)) {
      publish({ phase: "renderer-settling", rendererReady: false,
        rendererSettling: true, recoveryRequired: false,
        unknownOutcome: false, recoveryReason: null, operationOutcome: null,
        rendererLabel: "Updating WebGPU renderer",
        message: "Updating the current modeling project." });
    }
  };

  const initializeNativeRuntime = async (signal) => {
    publish({ phase: "loading-runtime", rendererLabel: "Loading WebGPU renderer",
      message: "Loading the verified WebGPU renderer. Modeling tools appear after Ready." });

    if (scope.isSecureContext !== true || scope.top !== scope.self || !document.documentElement?.dataset) {
      throw new StudioBootstrapError("The modeling presentation requires a secure top-level document.", {
        code: "INVALID_PRESENTATION_CONTEXT",
      });
    }
    document.documentElement.dataset.orielPresentationFormat = PRESENTATION_FORMAT;
    document.documentElement.dataset.orielPresentationOrigin = safeLocation(scope).origin;

    let native = nativeStartup;
    if (!native || native.runtime !== scope.__ORIEL_EDITOR_PREVIEW_RUNTIME__
        || native.canvas?.isConnected === false) {
      nativeStartup = null;
      const placeholder = document.querySelector("#studio-canvas");
      if (placeholder) placeholder.id = "studio-canvas-placeholder";

      let module;
      try {
        module = await importRuntime(sameOriginUrl(runtimeModuleUrl, scope, "WebGPU renderer module"));
      } catch (cause) {
        throw new StudioBootstrapError("The WebGPU renderer module could not be loaded.", {
          code: "RUNTIME_MODULE_FAILED",
          cause,
        });
      }
      abortError(signal);
      if (typeof module?.default !== "function") {
        throw new StudioBootstrapError("The verified renderer has no Wasm initializer.", {
          code: "INVALID_RUNTIME_MODULE",
        });
      }

      publish({ phase: "starting-runtime", rendererLabel: "Starting WebGPU renderer", message: "Starting the native WebGPU modeling renderer." });
      try {
        await module.default({
          module_or_path: sameOriginUrl(runtimeWasmUrl, scope, "WebGPU renderer WebAssembly"),
        });
      } catch (cause) {
        throw new StudioBootstrapError("The WebGPU renderer WebAssembly runtime could not initialize.", {
          code: "RUNTIME_WASM_FAILED",
          cause,
        });
      }

      native = await waitForNativeRuntime(scope, document, {
        signal,
        timeoutMilliseconds: runtimeTimeoutMilliseconds,
      });
      nativeStartup = native;
    }
    nativeCanvas = mountNativeCanvas(document, native.canvas);
    publish({
      phase: "awaiting-canvas",
      rendererLabel: "Synchronizing WebGPU viewport",
      message: document.visibilityState === "hidden"
        ? "Waiting for the modeling viewport to become visible."
        : "Waiting for the native modeling viewport to match its display size.",
    });
    await waitForCanvasSynchronization(scope, nativeCanvas, {
      document,
      signal,
      timeoutMilliseconds: runtimeTimeoutMilliseconds,
    });
    return native;
  };

  const watchForCanvasRecovery = () => {
    cancelCanvasRecovery?.();
    const owner = nativeStartup;
    const canvas = owner?.canvas;
    if (!canvas || disposed) return;
    const recoveryController = controller;
    const project = activeProject;
    const projectGeneration = state.projectGeneration;
    const documentGeneration = state.documentGeneration;

    const now = scope.performance?.now?.bind(scope.performance) || Date.now;
    const deadline = now() + Math.min(300_000,
      Math.max(runtimeTimeoutMilliseconds * 4, 1_000));
    let timer = null;
    let observer = null;
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (timer !== null) scope.clearTimeout?.(timer);
      observer?.disconnect?.();
      document.removeEventListener?.("visibilitychange", recover);
      scope.removeEventListener?.("resize", recover);
      scope.removeEventListener?.("pageshow", recover);
      if (cancelCanvasRecovery === cleanup) cancelCanvasRecovery = null;
    };

    function recover() {
      if (finished || disposed || state.error?.code !== "NATIVE_CANVAS_TIMEOUT"
          || nativeStartup !== owner || controller !== recoveryController
          || activeProject !== project || state.projectGeneration !== projectGeneration
          || state.documentGeneration !== documentGeneration
          || scope.__ORIEL_EDITOR_PREVIEW_RUNTIME__ !== owner.runtime) {
        cleanup();
        return;
      }
      if (document.visibilityState !== "hidden" && synchronizedCanvas(scope, canvas)) {
        cleanup();
        scope.setTimeout(() => {
          if (!disposed && state.error?.code === "NATIVE_CANVAS_TIMEOUT"
              && nativeStartup === owner && controller === recoveryController
              && activeProject === project && state.projectGeneration === projectGeneration
              && state.documentGeneration === documentGeneration
              && scope.__ORIEL_EDITOR_PREVIEW_RUNTIME__ === owner.runtime) {
            void start().catch(() => {});
          }
        }, 0);
        return;
      }
      if (timer !== null) scope.clearTimeout?.(timer);
      timer = null;
      if (now() >= deadline) {
        cleanup();
        return;
      }
      timer = scope.setTimeout(recover, 32);
    }

    cancelCanvasRecovery = cleanup;
    document.addEventListener?.("visibilitychange", recover);
    scope.addEventListener?.("resize", recover);
    scope.addEventListener?.("pageshow", recover);
    if (typeof scope.ResizeObserver === "function") {
      try {
        observer = new scope.ResizeObserver(recover);
        observer.observe(canvas);
        if (canvas.parentElement) observer.observe(canvas.parentElement);
      } catch {
        observer?.disconnect?.();
        observer = null;
      }
    }
    recover();
  };

  const clearExportOffers = () => {
    pendingExports.clear();
    exportReservations.clear();
    pendingExportBytes = 0;
  };

  const reserveExportOffer = ({ byteLength, profile } = {}) => {
    const owner = currentOwner;
    if (!owner || owner !== currentOwner
        || owner.projectGeneration !== state.projectGeneration) {
      throw new StudioBootstrapError("The export no longer belongs to the active modeling project.",
        { code: "STALE_PROJECT" });
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0
        || byteLength > MAX_PENDING_EXPORT_BYTES
        || profile === "oriel.game-asset/1" && byteLength > 8 * 1024 * 1024
        || pendingExports.size + exportReservations.size >= MAX_PENDING_EXPORTS
        || pendingExportBytes + byteLength > MAX_PENDING_EXPORT_BYTES) {
      throw new StudioBootstrapError("The pending local export offers exceed their owner-local limit.",
        { code: "QUOTA_EXCEEDED" });
    }
    const reservation = Object.freeze({ owner,
      ownerGeneration: owner.projectGeneration, byteLength,
      exportId: `export-${scope.crypto?.randomUUID?.() ?? Date.now()}` });
    exportReservations.add(reservation);
    pendingExportBytes += byteLength;
    return reservation;
  };

  const releaseExportOffer = (reservation) => {
    if (!exportReservations.delete(reservation)) return false;
    pendingExportBytes = Math.max(0, pendingExportBytes - reservation.byteLength);
    return true;
  };

  const publishExportOffer = (reservation, artifact) => {
    if (!exportReservations.has(reservation)) {
      throw new StudioBootstrapError("The selected local export reservation is no longer available.",
        { code: "STALE_PROJECT" });
    }
    if (reservation.owner !== currentOwner
        || reservation.ownerGeneration !== currentOwner?.projectGeneration
        || reservation.ownerGeneration !== state.projectGeneration) {
      releaseExportOffer(reservation);
      throw new StudioBootstrapError("The selected local export belongs to a previous project owner.",
        { code: "STALE_PROJECT" });
    }
    const normalized = { ...artifact, exportId: reservation.exportId,
      owner: reservation.owner, ownerGeneration: reservation.ownerGeneration };
    const published = ui?.offerExport?.(normalized, {
      owner: reservation.owner, ownerGeneration: reservation.ownerGeneration,
    });
    if (published === null || published === false) {
      releaseExportOffer(reservation);
      throw new StudioBootstrapError("The local export could not be offered to the current owner.",
        { code: "EXPORT_UNAVAILABLE" });
    }
    exportReservations.delete(reservation);
    pendingExports.set(reservation.exportId,
      { artifact: normalized, byteLength: reservation.byteLength,
        owner: reservation.owner, ownerGeneration: reservation.ownerGeneration });
    return { queued: true, exportId: reservation.exportId,
      fileName: artifact?.fileName || artifact?.filename || artifact?.name || null };
  };

  const queueBrowserExport = (artifact) => {
    const bytes = artifact?.bytes ?? artifact?.blob ?? artifact;
    const actualByteLength = Number.isSafeInteger(bytes?.byteLength)
      ? bytes.byteLength : Number.isSafeInteger(bytes?.size) ? bytes.size : undefined;
    if (Number.isSafeInteger(artifact?.byteLength)
        && actualByteLength !== undefined && artifact.byteLength !== actualByteLength) {
      throw new StudioBootstrapError("The local export byte length does not match its actual artifact.",
        { code: "INVALID_ARGUMENT" });
    }
    const byteLength = actualByteLength
      ?? (Number.isSafeInteger(artifact?.byteLength) ? artifact.byteLength : 0);
    const reservation = reserveExportOffer({ byteLength, profile: artifact?.profile });
    try {
      return publishExportOffer(reservation, artifact);
    } catch (error) {
      releaseExportOffer(reservation);
      throw error;
    }
  };

  const completeExportDownload = ({ exportId, owner, ownerGeneration, artifactId } = {}) => {
    const selected = pendingExports.get(exportId)
      ?? [...pendingExports.values()].find(({ artifact }) => artifact.artifactId === artifactId);
    if (!selected || selected.owner !== currentOwner
        || selected.owner !== owner || selected.ownerGeneration !== ownerGeneration) return false;
    pendingExports.delete(selected.artifact.exportId);
    pendingExportBytes = Math.max(0, pendingExportBytes - selected.byteLength);
    return true;
  };

  const rebindExportOffers = (owner, previousGeneration, projectGeneration) => {
    for (const [identifier, offered] of pendingExports) {
      if (offered.owner !== owner || offered.ownerGeneration !== previousGeneration) continue;
      offered.ownerGeneration = projectGeneration;
      offered.artifact.ownerGeneration = projectGeneration;
      pendingExports.set(identifier, offered);
    }
  };

  const observeRendererLifecycle = (owner = currentOwner) => {
    cancelRendererObservation?.();
    const renderer = runtime;
    const diagnostics = scope.__ORIEL_RUNTIME_DIAGNOSTICS__;
    if (!owner || owner !== currentOwner || !renderer
        || typeof renderer.invalidateRendererLifecycle !== "function"
        || diagnostics?.format !== "oriel.runtime-diagnostics/1"
        || diagnostics.renderer?.format !== "oriel.renderer-diagnostics/1") return;
    const ownerGeneration = owner.projectGeneration;
    const documentGeneration = state.documentGeneration;
    let handle = null;
    let stopped = false;
    let lastProjection = null;

    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      if (handle !== null) scope.clearTimeout?.(handle);
      handle = null;
      document.removeEventListener?.("visibilitychange", visibilityChanged);
      if (cancelRendererObservation === cleanup) cancelRendererObservation = null;
    };

    function sample({ schedule = true } = {}) {
      if (stopped || disposed || currentOwner !== owner || runtime !== renderer
          || state.documentGeneration !== documentGeneration
          || state.projectGeneration !== ownerGeneration
          || projectNavigationPending
          || owner.persistence?.status?.().enabled === true
            && owner.persistence.status().hasWriter === false) {
        cleanup();
        return;
      }
      if (handle !== null) scope.clearTimeout?.(handle);
      handle = null;
      const current = scope.__ORIEL_RUNTIME_DIAGNOSTICS__;
      const nativeRenderer = current?.renderer;
      if (current?.format === "oriel.runtime-diagnostics/1"
          && nativeRenderer?.format === "oriel.renderer-diagnostics/1") {
        const projection = {
          runtimeIncarnation: current.runtimeIncarnation,
          rendererGeneration: String(nativeRenderer.readinessToken?.generation ?? ""),
          invalidationEpoch: String(nativeRenderer.readinessToken?.invalidationEpoch ?? ""),
          phase: nativeRenderer.lifecycle?.phase ?? nativeRenderer.readinessState,
          readinessState: nativeRenderer.readinessState,
          ready: nativeRenderer.readiness?.complete === true
            && nativeRenderer.readiness?.failedPipelineCount === 0
            && nativeRenderer.readinessState === "ready"
            && (nativeRenderer.lifecycle?.phase === undefined
              || nativeRenderer.lifecycle.phase === "ready"),
          failedPipelineCount: nativeRenderer.readiness?.failedPipelineCount ?? 0,
          ...(nativeRenderer.lifecycle?.latestError === undefined ? {} : {
            latestError: nativeRenderer.lifecycle.latestError,
          }),
        };
        const signature = JSON.stringify(projection);
        if (lastProjection !== null && signature !== lastProjection) {
          const previousStatus = renderer.status?.();
          const identityChanged = projection.runtimeIncarnation !== previousStatus?.runtimeIncarnation
            || projection.rendererGeneration !== String(previousStatus?.rendererGeneration ?? "");
          const capturedPose = identityChanged
            ? owner.cameraGuidance?.captureRecoveryPose?.() : undefined;
          try {
            if (identityChanged) clearPresentedOwnerFrame();
            if (renderer.invalidateRendererLifecycle(projection) === true && identityChanged) {
              owner.cameraGuidance?.invalidateRendererGeneration?.(projection.rendererGeneration);
              owner.inspection?.invalidateRendererGeneration?.(projection.rendererGeneration);
              owner.recoveryCameraPose = capturedPose;
            }
          } catch (error) {
            scope.console?.warn?.("The active WebGPU renderer lifecycle could not be authenticated.", error);
          }
        }
        lastProjection = signature;
      }
      if (!stopped && schedule) {
        handle = scope.setTimeout(sample,
          document.visibilityState === "hidden"
            ? HIDDEN_RENDERER_OBSERVATION_MILLISECONDS
            : VISIBLE_RENDERER_OBSERVATION_MILLISECONDS);
        handle?.unref?.();
      }
    }

    function visibilityChanged() {
      sample();
    }

    cancelRendererObservation = cleanup;
    document.addEventListener?.("visibilitychange", visibilityChanged);
    sample();
  };

  const recoverRuntime = () => {
    if (runtimeRecovery !== null) return runtimeRecovery;
    if (!currentOwner || !runtime || typeof runtime.reconcile !== "function") return start();
    const currentStatus = runtime.status?.();
    if (currentStatus?.ready === true && currentStatus.phase !== "reconciling"
        && currentStatus.recoveryRequired !== true) {
      if (!authenticatePresentedOwnerFrame(currentOwner, currentStatus)) {
        clearPresentedOwnerFrame();
        return Promise.resolve(publish({
          phase: "recovery-required",
          rendererReady: false,
          webgpuReady: false,
          rendererSettling: false,
          recoveryRequired: true,
          unknownOutcome: false,
          recoveryReason: "owner_projection_diverged",
          operationOutcome: "no_operation",
          rendererLabel: "Renderer recovery required",
          error: { code: "RECONCILIATION_REQUIRED",
            message: "The renderer could not authenticate the current committed project owner." },
          message: "The current modeling project requires authenticated owner recovery.",
        }));
      }
      return Promise.resolve(publish({
        phase: state.webmcpReady ? "ready" : "renderer-ready",
        rendererReady: true,
        webgpuReady: true,
        rendererSettling: false,
        recoveryRequired: false,
        unknownOutcome: false,
        recoveryReason: null,
        operationOutcome: null,
        rendererLabel: "Ready · WebGPU",
        error: null,
      }));
    }
    if (currentStatus?.phase === "settling" && typeof runtime.waitForReady === "function") {
      const owner = currentOwner;
      const checkpoint = owner.store?.getInspectionCheckpoint?.();
      return runtime.waitForReady({
        signal: controller?.signal,
        timeoutMs: presentationTimeoutMilliseconds,
        snapshotId: checkpoint?.snapshotId,
        sceneSourceHash: checkpoint?.sceneSourceHash,
        assetManifestHash: checkpoint?.assetManifestHash,
        projectId: owner.project?.projectId,
        projectGeneration: owner.projectGeneration,
      }).then(() => snapshot());
    }
    if (currentStatus?.phase !== "reconciling"
        && currentStatus?.recoveryRequired !== true) return Promise.resolve(snapshot());
    const owner = currentOwner;
    const renderer = runtime;
    const project = activeProject;
    const ownerGeneration = owner.projectGeneration;
    const documentGeneration = state.documentGeneration;
    const recoveryController = controller;
    const revision = owner.store.getRevision();
    const cameraPose = owner.recoveryCameraPose
      ?? owner.cameraGuidance?.captureRecoveryPose?.();
    const ensureOwner = () => {
      if (disposed || currentOwner !== owner || activeProject !== project
          || runtime !== renderer || controller !== recoveryController
          || state.projectGeneration !== ownerGeneration
          || state.documentGeneration !== documentGeneration
          || owner.store.getRevision() !== revision
          || projectNavigationPending || owner.persistence?.status?.().enabled === true
            && owner.persistence.status().hasWriter === false) {
        throw new StudioBootstrapError("The current modeling project changed during renderer recovery.",
          { code: "STALE_PROJECT" });
      }
    };
    const operation = (async () => {
      let recoverySucceeded = false;
      try {
        ensureOwner();
        owner.store.quiesceMutations?.();
        publish({ phase: "recovering-runtime", rendererReady: false,
          webgpuReady: false, rendererLabel: "Recovering WebGPU renderer",
          rendererSettling: false, recoveryRequired: true,
          message: "Recovering the renderer from the current committed modeling project." });
        await owner.store.whenIdle?.({ timeoutMilliseconds: 10_000 });
        ensureOwner();
        const committed = await owner.store.buildSnapshot();
        ensureOwner();
        const recovered = await renderer.reconcile(committed, {
          signal: recoveryController?.signal,
        });
        ensureOwner();
        const presented = presentationStatus(recovered, renderer);
        if (presented?.applied !== true || presented.requiredAssetsReady !== true
            || presented.snapshotId !== committed.snapshotId
            || presented.sceneSourceHash !== committed.sceneSourceHash
            || presented.assetManifestHash !== committed.assetManifestHash) {
          throw new StudioBootstrapError("Renderer recovery did not accept the exact committed project.",
            { code: "RECONCILIATION_REQUIRED" });
        }
        if (!Number.isSafeInteger(recovered?.presentedFrames)
            || recovered.presentedFrames < 2) {
          await renderer.waitForPresentedFrames({ minimumFrames: 2, frames: 2,
            timeoutMilliseconds: presentationTimeoutMilliseconds,
            signal: recoveryController?.signal });
        }
        ensureOwner();
        const confirmed = renderer.status?.();
        if (confirmed?.ready !== true || confirmed.phase !== undefined && confirmed.phase !== "ready"
            || confirmed.snapshotId !== committed.snapshotId
            || confirmed.sceneSourceHash !== committed.sceneSourceHash
            || confirmed.assetManifestHash !== committed.assetManifestHash) {
          throw new StudioBootstrapError("The renderer did not authenticate the exact recovered owner.",
            { code: "RECONCILIATION_REQUIRED" });
        }
        owner.cameraGuidance?.restoreRendererGeneration?.(confirmed.rendererGeneration);
        owner.inspection?.restoreRendererGeneration?.(confirmed.rendererGeneration);
        if (cameraPose) await owner.cameraGuidance?.restoreRecoveryPose?.(cameraPose);
        ensureOwner();
        delete owner.recoveryCameraPose;
        authenticatePresentedOwnerFrame(owner, confirmed, { snapshot: committed });
        recoverySucceeded = true;
        publish({ phase: state.webmcpReady ? "ready" : "renderer-ready",
          rendererReady: true, webgpuReady: true,
          rendererSettling: false, recoveryRequired: false, unknownOutcome: false,
          recoveryReason: null, operationOutcome: null,
          rendererLabel: "Ready · WebGPU", error: null,
          message: "The current committed modeling project has been safely recovered." });
        return snapshot();
      } catch (error) {
        if (currentOwner === owner && runtime === renderer && !disposed) {
          publish({ phase: "recovery-required", rendererReady: false,
            webgpuReady: false, rendererLabel: "Renderer recovery required",
            rendererSettling: false, recoveryRequired: true,
            error: { code: error?.code === "STALE_PROJECT" ? "STALE_PROJECT"
              : "RECONCILIATION_REQUIRED",
            message: boundedText(error?.message, 240)
              || "The current modeling project still requires renderer recovery." },
            message: "The current modeling project still requires explicit renderer recovery." });
        }
        throw error;
      } finally {
        if (recoverySucceeded && currentOwner === owner && runtime === renderer && !disposed
            && renderer.status?.().phase === "ready") {
          owner.store.resumeMutations?.();
        }
      }
    })();
    runtimeRecovery = operation.finally(() => {
      if (runtimeRecovery === wrapped) runtimeRecovery = null;
    });
    const wrapped = runtimeRecovery;
    return wrapped;
  };

  const stop = () => {
    disposed = true;
    clearPresentedOwnerFrame();
    cancelCanvasRecovery?.();
    cancelRendererObservation?.();
    clearExportOffers();
    projectScenePresented = false;
    delete document.documentElement?.dataset?.orielPresentationFormat;
    delete document.documentElement?.dataset?.orielPresentationOrigin;
    controller?.abort(new DOMException("The modeling studio was disposed.", "AbortError"));
    pageToolBridge?.dispose?.();
    pageToolBridge = null;
    unsubscribeStore?.();
    unsubscribeStore = null;
    (currentOwner?.store ?? store)?.retire?.();
    for (const geometry of projectGeometryOwners.values()) {
      revokeDenseOwnerGrant(geometry);
      geometry.dispose?.();
    }
    projectGeometryOwners.clear();
    unsubscribeRuntime?.();
    unsubscribeRuntime = null;
    unsubscribeRegistrar?.();
    unsubscribeRegistrar = null;
    registrar?.dispose?.();
    ui?.destroy?.();
    projectListeners.clear();
    cameraGuidance?.dispose?.();
    cameraGuidance = null;
    inspection?.dispose?.();
    inspection = null;
    exportAssets?.dispose?.();
    exportAssets = null;
    modelImports?.dispose?.();
    modelImports = null;
    modelImportService?.dispose?.();
    modelImportService = null;
    modelArtifacts?.dispose?.();
    modelArtifacts = null;
    materialUploads?.dispose?.();
    materialUploads = null;
    materialAuthoring?.dispose?.();
    materialAuthoring = null;
    if (deviceCache) {
      void Promise.resolve(deviceCache.dispose?.()).catch((error) => {
        scope.console?.warn?.("The device-local scene writer could not close cleanly.", error);
      });
      deviceCache = null;
    }
    referenceAssets?.dispose?.();
    referenceAssets = null;
    runtime?.dispose?.();
    publish({
      phase: "disposed",
      message: "Codex Modeling Studio has stopped.",
      webgpuReady: false,
      rendererReady: false,
      rendererSettling: false,
      recoveryRequired: false,
      unknownOutcome: false,
      webmcpReady: false,
      agentActivity: "stopped",
      agentTool: null,
      registeredNames: [],
    });
  };

  const start = async () => {
    if (bootPromise) return bootPromise;
    disposed = false;
    cancelCanvasRecovery?.();
    controller = new AbortController();
    const { signal } = controller;

    bootPromise = (async () => {
      try {
        projectScenePresented = false;
        restoredProjectPending = false;
        projectRecoveryRequired = false;
        publish({
          phase: "preflight",
          rendererLabel: "Checking WebGPU",
          message: "Checking the secure browser context and WebGPU graphics adapter.",
          unsupported: false,
          error: null,
          webgpuReady: false,
          rendererReady: false,
          webmcpReady: false,
          registeredNames: [],
        });
        await probeWebGpu(scope, document);
        abortError(signal);
        publish({ webgpuAvailable: true, webgpuReady: false });

        await initializeNativeRuntime(signal);
        publish({
          phase: "loading-seed",
          rendererLabel: "Loading workspace",
          message: "Loading the minimal browser-owned modeling workspace.",
        });

        const seed = await loadStudioSeed({
          scope,
          manifestUrl: seedManifestUrl,
          signal,
          onProgress: ({ loaded, total }) => publish({
            loadedAssets: loaded,
            totalAssets: total,
            message: `Loading workspace dependencies (${loaded}/${total}).`,
          }),
        });
        abortError(signal);
        publish({
          loadedAssets: seed.requiredAssets.length,
          totalAssets: seed.requiredAssets.length,
          message: seed.requiredAssets.length === 0
            ? "Preparing the clean modeling workspace."
            : "Preparing the verified workspace assets.",
        });

        const hostname = safeLocation(scope).hostname;
        const provenanceRequired = requireRuntimeProvenance ??
          (hostname.endsWith(".openai.chatgpt.site") || runtimeProvenance !== undefined);
        const provenance = await loadRuntimeProvenance({
          scope,
          url: runtimeProvenanceUrl,
          seedRevision: seed.engineRevision,
          value: runtimeProvenance,
          required: provenanceRequired,
          signal,
        });
        abortError(signal);
        authenticatedGeometryKernel = await loadGeometryKernel({ scope,
          manifestUrl: modelingKernelManifestUrl,
          rendererRevision: provenance?.engineRevision ?? seed.engineRevision,
          signal });
        abortError(signal);

        persistenceCompatibility = Object.freeze({
          runtimeAbi: "oriel.web-runtime/1",
          sceneFormat: "oriel.scene/1",
          modeledVersions: [1, 2],
          securityPolicyVersion: "oriel.device-local-scene/1",
        });
        authenticatedSeed = {
          ...seed,
          sceneAssetId: seed.sceneAssetId || seed.scene.assetId,
        };
        legacyProjectId = `oriel-modeling-studio:${authenticatedSeed.sceneAssetId}`;
        activeProjectStorageKey = `oriel-webmcp.active-project:${authenticatedSeed.sceneAssetId}`;
        const storage = browserProjectStorage(scope);
        const sessionStorage = browserProjectSessionStorage(scope);
        let savedProjectId = null;
        let tabProjectId = null;
        let tabSelectionAvailable = typeof sessionStorage?.getItem === "function"
          && typeof sessionStorage?.setItem === "function";
        let legacyConsented = false;
        try {
          savedProjectId = storage?.getItem?.(activeProjectStorageKey) ?? null;
          legacyConsented = storage?.getItem?.(
            `oriel:modeling-studio:device-saving:v1:${legacyProjectId}`,
          ) === JSON.stringify({ version: 1, enabled: true });
        } catch {
          savedProjectId = null;
          legacyConsented = false;
        }
        try {
          if (tabSelectionAvailable) {
            tabProjectId = sessionStorage.getItem(activeProjectStorageKey) ?? null;
          }
        } catch {
          tabProjectId = null;
          tabSelectionAvailable = false;
        }
        let navigationType = null;
        try {
          navigationType = scope.performance?.getEntriesByType?.("navigation")?.[0]?.type ?? null;
        } catch { /* Preserve existing tab selection when navigation timing is unavailable. */ }
        const selectedTabProject = navigationType !== "navigate"
          && validProjectIdentifier(tabProjectId, legacyProjectId);
        const selectedProfileProject = !tabSelectionAvailable
          && validProjectIdentifier(savedProjectId, legacyProjectId);
        const selectedLegacyProject = !selectedTabProject && !selectedProfileProject
          && !validProjectIdentifier(savedProjectId, legacyProjectId) && legacyConsented;
        const selectedExistingProject = selectedTabProject || selectedProfileProject
          || selectedLegacyProject;
        const selectedProjectId = selectedTabProject ? tabProjectId
          : selectedProfileProject ? savedProjectId
            : selectedLegacyProject ? legacyProjectId
              : `${legacyProjectId}:${scope.crypto.randomUUID()}`;
        try {
          sessionStorage?.setItem?.(activeProjectStorageKey, selectedProjectId);
        } catch { /* Tab isolation is optional when browser session storage is unavailable. */ }
        activeProject = {
          projectId: selectedProjectId,
          displayName: "Untitled project",
        };
        publish({ projectGeneration: 1 });
        let provisionalGeometry = createProjectGeometryOwner(selectedProjectId, 1);
        if (provisionalGeometry !== null) {
          try {
            await prepareProjectGeometryOwner(provisionalGeometry, {
              projectId: selectedProjectId, generation: 1, signal,
            });
          } catch (error) {
            provisionalGeometry.dispose?.();
            projectGeometryOwners.delete(projectGeometryKey(selectedProjectId, 1));
            provisionalGeometry = null;
            abortError(signal);
            scope.console?.warn?.("Independent dense modeling verification is unavailable; compatible small projects remain readable.", error);
          }
        }
        deviceCache = createDevicePersistence({
          scope,
          projectId: selectedProjectId,
          compatibility: persistenceCompatibility,
          runtimeEpoch: 4,
          ...(provisionalGeometry === null ? {} : {
            geometryCompute: provisionalGeometry }),
        });

        const alreadyEnabled = typeof deviceCache.hasConsent === "function"
          ? deviceCache.hasConsent() : deviceCache.status?.().consented === true;
        if (!alreadyEnabled && deviceCache.isAutoSaveDisabled?.() !== true
            && deviceCache.canAutoEnable?.() === true) {
          try {
            await deviceCache.enable({ acknowledged: true });
          } catch (error) {
            if (error?.code === "PROJECT_UPGRADE_REQUIRED") {
              projectRecoveryRequired = true;
              throw new StudioBootstrapError(
                "This saved modeling project requires a compatible studio upgrade; its existing work has been preserved.",
                { code: "PROJECT_UPGRADE_REQUIRED", cause: error },
              );
            }
            scope.console?.warn?.("Automatic device-local scene saving is unavailable.", error);
          }
        }

        let restored = null;
        try {
          restored = await deviceCache.restore({
            sceneAssetId: seed.sceneAssetId || seed.scene.assetId,
            scenePath: seed.scenePath,
            compatibility: persistenceCompatibility,
            verifyCheckpoint(value) {
              if (value?.sceneAssetId !== (seed.sceneAssetId || seed.scene.assetId) ||
                  value.scenePath !== seed.scenePath ||
                  value.scene?.format !== "oriel.scene/1" ||
                  !(value.assets instanceof Map) ||
                  !(value.assetMetadata instanceof Map) ||
                  !Number.isSafeInteger(value.revision) || value.revision < 0) {
                throw new StudioBootstrapError(
                  "The saved device-local workspace does not match the verified modeling project.",
                  { code: "INVALID_DEVICE_CHECKPOINT" },
                );
              }
            },
          });
        } catch (error) {
          projectRecoveryRequired = true;
          const upgradeRequired = error?.code === "PROJECT_UPGRADE_REQUIRED"
            || error?.code === "INCOMPATIBLE_CHECKPOINT";
          throw new StudioBootstrapError(
            upgradeRequired
              ? "This saved modeling project requires a compatible studio upgrade; its existing work has been preserved."
              : "The saved modeling project could not be safely restored; recovery is required and its existing work has been preserved.",
            { code: upgradeRequired ? "PROJECT_UPGRADE_REQUIRED" : "PROJECT_RECOVERY_REQUIRED",
              cause: error },
          );
        }
        restoredProjectPending = restored !== null;
        abortError(signal);
        try {
          const selected = (await listProjects()).find((entry) => entry.projectId === selectedProjectId);
          if (selected) {
            if (!restored) {
              projectRecoveryRequired = true;
              throw new StudioBootstrapError(
                "The saved modeling project has no readable checkpoint; recovery is required and its existing work has been preserved.",
                { code: "PROJECT_RECOVERY_REQUIRED" },
              );
            }
            const { active, ...metadata } = selected;
            activeProject = metadata;
          }
        } catch (error) {
          if (projectRecoveryRequired) throw error;
          if (!restored && (alreadyEnabled || selectedExistingProject)) {
            projectRecoveryRequired = true;
            throw new StudioBootstrapError(
              "The existing modeling project could not be verified; recovery is required and its saved work has been preserved.",
              { code: "PROJECT_RECOVERY_REQUIRED", cause: error },
            );
          }
          scope.console?.warn?.("The saved modeling project catalog could not be read.", error);
        }

        runtime = createRuntime({
          scope,
          canvas: nativeCanvas,
          getDenseAssetGrant(snapshotId) {
            return denseGrantsBySnapshot.get(snapshotId)
              ?? projectDenseGrants.get(currentOwner?.geometryCompute)
              ?? null;
          },
          loadSnapshot: async (_request, _environment, candidate) => candidate,
          onStatus: onRuntimeStatus,
          localInspection: {
            projectId: selectedProjectId,
            documentGeneration: 1,
            projectGeneration: state.projectGeneration || 1,
            sceneAssetId: restored?.sceneAssetId || seed.sceneAssetId || seed.scene.assetId,
            scenePath: restored?.scenePath || seed.scenePath,
            ...(provenance ? {
              engineRevision: provenance.engineRevision,
              runtimeReleaseId: provenance.runtimeReleaseId,
            } : seed.engineRevision ? { engineRevision: seed.engineRevision } : {}),
          },
        });
        if (typeof runtime?.subscribe === "function") {
          unsubscribeRuntime = runtime.subscribe(onRuntimeStatus);
        }

        const instantiateStore = (source, { projectId = selectedProjectId,
          restored: isRestored = source === restored,
          generation = state.projectGeneration || 1 } = {}) => {
          const geometryCompute = projectGeometryOwners.get(projectGeometryKey(
            projectId, generation)) ?? null;
          return createStore({
          projectId,
          scene: source.scene,
          assets: source.assets,
          assetMetadata: source.assetMetadata,
          scenePath: source.scenePath,
          sceneAssetId: source.sceneAssetId || seed.sceneAssetId,
          starterEntityId: STUDIO_STARTER_CUBE_ID,
          beforeApplyOperation: (scene, operation, context) =>
            replacePristineStudioStarter(seed.scene, scene, operation, context),
          customMaterials: source.customMaterials ?? [],
          ...(source.modelingState === undefined ? {} : {
            modelingState: source.modelingState,
          }),
          requiredAssets: seed.requiredAssets,
          ...(isRestored ? {
            selection: source.selection,
            revision: source.revision,
            undoHistory: source.undoHistory,
            redoHistory: source.redoHistory,
          } : {}),
          runtimeBridge: runtime,
          ...(geometryCompute === null ? {} : { geometryCompute,
            ownerGeneration: generation }),
          renderCapabilities: {
            required: [
              "backend.webgpu",
              "image.jpeg.static",
              "image.png.static",
              "material.pbr",
              "renderer.3d",
              "scene.gltf",
            ],
            optional: ["image.ktx2.zstd", "image.webp.static"],
          },
          crypto: scope.crypto,
        });
        };
        instantiateProjectStore = instantiateStore;
        projectSeedStoreFactory = () => instantiateStore(seed, {
          projectId: activeProject.projectId, restored: false,
        });
        let startupMigrationApplied = false;
        try {
          store = instantiateStore(restored || seed, {
            projectId: selectedProjectId, restored: restored !== null,
          });
        } catch (error) {
          if (!restored) throw error;
          projectRecoveryRequired = true;
          throw new StudioBootstrapError(
            "This saved modeling project requires a compatible studio upgrade; its existing work has been preserved.",
            { code: "PROJECT_UPGRADE_REQUIRED", cause: error },
          );
        }
        if (restored && deviceCache.status?.().enabled === true
            && deviceCache.status?.().readOnly !== true) {
          const operations = legacyStudioBaselineOperations(store.getScene(), seed.scene);
          if (operations.length > 0) {
            let detached = false;
            try {
              store.setRuntimeBridge(null);
              detached = true;
              await store.applyBatch(operations, {
                expectedRevision: store.getRevision(),
                signal,
              });
              startupMigrationApplied = true;
            } catch (error) {
              scope.console?.warn?.(
                "The saved studio backdrop could not be upgraded without changing authored content.",
                error,
              );
            } finally {
              if (detached) store.setRuntimeBridge(runtime);
            }
          }
        }
        committedRevision = store.getRevision();

        modelArtifacts = createModelArtifacts({ scope, crypto: scope.crypto, store,
          projectId: activeProject.projectId,
          projectGeneration: state.projectGeneration || 1 });
        modelImportService = createModelImportService({
          store,
          scope,
          crypto: scope.crypto,
          projectId: activeProject.projectId,
          artifacts: modelArtifacts,
        });
        modelImports = createModelImportSessions({
          service: modelImportService,
          store,
          scope,
          crypto: scope.crypto,
          artifacts: modelArtifacts,
        });

        try {
          referenceAssets = createReferenceAssets({ scope, crypto: scope.crypto });
        } catch (error) {
          if (error?.code !== "CAPABILITY_UNAVAILABLE") throw error;
          scope.console?.warn?.("Browser-local reference images are unavailable.", error);
        }
        inspection = createInspection({ sceneStore: store, runtime, scope });
        exportAssets = createExportAssets({ store });
        materialAuthoring = createMaterialAuthoringService({
          store, projectController, inspection, scope,
        });
        materialUploads = createMaterialUploadSessions({
          scope, projectController, materialAuthoringService: materialAuthoring,
        });

        const capture = (options = {}) => runtime.capture({
          ...options,
          ...(options.format === "png" ? { format: "image/png" } : {}),
          ...(options.format === "jpeg" ? { format: "image/jpeg" } : {}),
        });

        ui = createUI({
          root: document,
          canvas: nativeCanvas,
          store,
          runtime,
          capture,
          referenceService: referenceAssets,
          materialService: store,
          materialAuthoringService: materialAuthoring,
          deviceCache,
          projectController,
          importAsset: (file) => {
            if (!projectScenePresented || projectRecoveryRequired) {
              throw new StudioBootstrapError("The current saved modeling project requires recovery.", {
                code: "PROJECT_RECOVERY_REQUIRED",
              });
            }
            if (projectNavigationPending || deviceCache.status?.().readOnly === true) {
              throw new StudioBootstrapError(projectNavigationPending
                ? "The selected modeling project is opening."
                : "Another browser tab owns this saved project's writer.", {
                code: projectNavigationPending ? "PROJECT_NAVIGATION_PENDING" : "PROJECT_READ_ONLY",
              });
            }
            return modelImports.importFile(file, {
              expectedRevision: store.getRevision(),
            });
          },
          async loadExample() {
            if (!projectScenePresented || projectRecoveryRequired) {
              throw new StudioBootstrapError("The current saved modeling project requires recovery.", {
                code: "PROJECT_RECOVERY_REQUIRED",
              });
            }
            if (projectNavigationPending || deviceCache.status?.().readOnly === true) {
              throw new StudioBootstrapError(projectNavigationPending
                ? "The selected modeling project is opening."
                : "Another browser tab owns this saved project's writer.", {
                code: projectNavigationPending ? "PROJECT_NAVIGATION_PENDING" : "PROJECT_READ_ONLY",
              });
            }
            if (state.webmcpReady !== true ||
                typeof registrar?.executeRegisteredTool !== "function") {
              throw new StudioBootstrapError(
                "The village example requires genuinely registered modeling tools.",
                { code: "WEBMCP_NOT_READY" },
              );
            }
            const village = await loadVillageExample();
            if (typeof village?.authorVillageExample !== "function") {
              throw new StudioBootstrapError(
                "The browser-safe village example cannot be loaded.",
                { code: "VILLAGE_EXAMPLE_UNAVAILABLE" },
              );
            }
            const villageOwner = currentOwner;
            const villageGeneration = state.projectGeneration;
            const logicalDescriptors = new Map();
            const ensureVillageOwner = () => {
              if (currentOwner !== villageOwner
                  || state.projectGeneration !== villageGeneration
                  || state.switching || projectNavigationPending
                  || state.webmcpReady !== true) {
                throw new StudioBootstrapError(
                  "The requested village no longer belongs to the active project owner.",
                  { code: "STALE_PROJECT" },
                );
              }
            };
            const describeVillageTool = async (name, selected = {}) => {
              ensureVillageOwner();
              let descriptor = logicalDescriptors.get(name);
              if (!descriptor) {
                if (publicToolCatalog?.byName?.has(name)) {
                  descriptor = publicToolCatalog.byName.get(name);
                } else {
                  descriptor = await registrar.executeRegisteredTool(
                    "capabilities_help", { name }, selected,
                  );
                  ensureVillageOwner();
                }
                logicalDescriptors.set(name, descriptor);
              }
              return descriptor;
            };
            return village.authorVillageExample({
              async invokeTool(name, input, selected = {}) {
                const descriptor = await describeVillageTool(name, selected);
                ensureVillageOwner();
                if (publicToolCatalog?.byName?.has(name)) {
                  return registrar.executeRegisteredTool(name, input, selected);
                }
                if (typeof descriptor?.route !== "string"
                    || !publicToolCatalog?.byName?.has(descriptor.route)) {
                  throw new StudioBootstrapError(
                    "The requested village operation has no genuine registered route.",
                    { code: "WEBMCP_TOOL_UNAVAILABLE" },
                  );
                }
                return registrar.executeRegisteredTool(
                  descriptor.route,
                  encodePublicToolEnvelope(name, input),
                  selected,
                );
              },
              async listTools() {
                ensureVillageOwner();
                const descriptors = [...registrar.listRegisteredTools()];
                const known = new Set(descriptors.map(({ name }) => name));
                const required = new Set([
                  ...(village.VILLAGE_REQUIRED_TOOLS ?? []),
                  "reference_select",
                  "asset_export_group",
                ]);
                for (const name of required) {
                  if (!known.has(name)
                      && villageOwner.descriptorsByName.has(name)) {
                    descriptors.push(await describeVillageTool(name,
                      signal === undefined ? {} : { signal }));
                    known.add(name);
                  }
                }
                ensureVillageOwner();
                return descriptors;
              },
              signal,
            });
          },
          async onDeviceCacheChange({ action } = {}) {
            if (action !== "enable") return undefined;
            const result = await flushDeviceCheckpoint();
            const storage = browserProjectStorage(scope);
            if (typeof storage?.setItem === "function" && typeof storage?.getItem === "function") {
              writeActiveProject(activeProject.projectId);
            }
            return result;
          },
          highlight: (value) => runtime.presentTransientHighlight?.(value),
          download: (artifact) => downloadBrowserArtifact(scope, document, artifact),
          onDownloadExport: completeExportDownload,
          status: snapshot(),
          onRetryRegistration: () => registrar?.retry?.(),
          onRetryRuntime: () => recoverRuntime(),
        });
        ui?.setCanvas?.(nativeCanvas);
        if (typeof store.subscribe === "function") {
          unsubscribeStore = store.subscribe(observeSceneState);
        }

        publish({
          phase: "applying-scene",
          rendererLabel: "Preparing workspace",
          message: "Applying the verified workspace through the native modeling renderer.",
        });
        initialSnapshot = await store.buildSnapshot();
        reserveDenseOwnerGrant(provisionalGeometry, initialSnapshot);
        abortError(signal);
        const applied = await runtime.start(initialSnapshot, { signal });
        const receipt = presentationStatus(applied, runtime);
        if (!receipt || receipt.applied !== true || receipt.requiredAssetsReady !== true) {
          throw new StudioBootstrapError(
            "The native modeling renderer did not accept all required scene assets.",
            { code: "SCENE_NOT_APPLIED" },
          );
        }

        publish({
          phase: "awaiting-presentation",
          rendererLabel: "Warming WebGPU pipelines",
          message: "Waiting for genuinely presented WebGPU frames.",
        });
        await runtime.waitForPresentedFrames({
          minimumFrames: 2,
          frames: 2,
          timeoutMilliseconds: presentationTimeoutMilliseconds,
          signal,
        });
        abortError(signal);
        promoteDenseOwnerGrant(provisionalGeometry);
        provisionalGeometry?.promote?.({ snapshotId: initialSnapshot.snapshotId,
          sceneSourceHash: initialSnapshot.sceneSourceHash,
          assetManifestHash: initialSnapshot.assetManifestHash });
        projectScenePresented = true;
        restoredProjectPending = false;
        const newProjectNeedsCheckpoint = !restored && deviceCache.status?.().enabled === true
          && deviceCache.status?.().readOnly !== true;
        if (startupMigrationApplied || newProjectNeedsCheckpoint) {
          const saved = await queueDeviceCheckpoint();
          if (newProjectNeedsCheckpoint && saved && !projectNavigationPending) {
            try {
              writeActiveProject(activeProject.projectId);
            } catch (error) {
              deviceCache.reportError?.(error);
              scope.console?.warn?.("The active modeling project could not be retained on this device.", error);
            }
          }
        }

        publish({
          phase: "renderer-ready",
          webgpuReady: true,
          rendererReady: true,
          rendererLabel: "Ready · WebGPU",
          message: "Workspace ready. Waiting for an agent.",
        });

        cameraGuidance = typeof runtime?.previewOwnerCameraPose === "function"
          && typeof runtime?.finishOwnerCameraPreview === "function"
          && typeof inspection?.focusTarget === "function"
          ? createGuidance({ store, inspection, runtime, scope }) : null;
        const availableTools = createTools({
          scope,
          store,
          runtime,
          capture,
          referenceAssets,
          inspection,
          ...(cameraGuidance === null ? {} : { cameraGuidance }),
          exportAssets,
          modelImports,
          artifacts: modelArtifacts,
          materialAuthoring,
          materialUploads,
          projectController,
      getPersistenceStatus: () => ownershipStatus(),
      getCallbackOwner: () => currentOwner,
      getOwnerGeneration: () => logicalOwnerGeneration(),
          onInvocation: observerInvocation,
          onExport: queueBrowserExport,
          reserveExportOffer,
          publishExportOffer,
          releaseExportOffer,
        });
        currentOwner = {
          projectGeneration: state.projectGeneration,
          project: activeProject,
          store,
          geometryCompute: projectGeometryOwners.get(projectGeometryKey(
            activeProject.projectId, state.projectGeneration)) ?? null,
          persistence: deviceCache,
          checkpointQueue,
          referenceAssets,
          inspection,
          cameraGuidance,
          exportAssets,
          modelImportService,
          modelImports,
          modelArtifacts,
          materialAuthoring,
          materialUploads,
          descriptorsByName: new Map(availableTools.map((descriptor) => [descriptor.name, descriptor])),
        };
        authenticatePresentedOwnerFrame(currentOwner, runtime.status?.(), {
          snapshot: initialSnapshot,
        });
        ui?.setOwner?.({ owner: currentOwner,
          ownerGeneration: currentOwner.projectGeneration });
        observeRendererLifecycle(currentOwner);
        stableInternalTools = availableTools.map((descriptor) => ({
          ...descriptor,
          async execute(input, invocation) {
            if (projectNavigationPending || state.switching) {
              throw new StudioBootstrapError("The selected modeling project is still opening.", {
                code: "PROJECT_SWITCH_PENDING",
              });
            }
            const owner = currentOwner;
            const selected = owner?.descriptorsByName.get(descriptor.name);
            if (!selected) {
              throw new StudioBootstrapError("This modeling tool belongs to a stale project owner.", {
                code: "STALE_PROJECT",
              });
            }
            if (selected.annotations?.readOnlyHint !== true
                && (runtime?.status?.().phase === "reconciling"
                  || runtime?.status?.().recoveryRequired === true
                  || runtimeRecovery !== null)) {
              throw new StudioBootstrapError(
                "The current modeling project must be recovered before another edit can be attempted.",
                { code: "RECONCILIATION_REQUIRED" },
              );
            }
            return selected.execute(input, invocation);
          },
        }));
        try {
          await registerPublicTools();
        } catch (error) {
          reportRegistrationFailure(error);
        }

        return api;
      } catch (failure) {
        if (signal.aborted) throw signal.reason || failure;
        projectScenePresented = false;
        if (restoredProjectPending) projectRecoveryRequired = true;
        const error = asBootstrapError(failure);
        publish({
          phase: error.unsupported ? "unsupported" : projectRecoveryRequired
            ? "recovery-required" : "error",
          rendererLabel: error.unsupported ? "WebGPU unsupported"
            : projectRecoveryRequired ? "Saved project preserved" : "Renderer unavailable",
          message: error.message,
          webgpuReady: false,
          rendererReady: false,
          webmcpReady: false,
          unsupported: error.unsupported,
          error: { code: error.code, message: error.message },
        });
        if (error.code === "NATIVE_CANVAS_TIMEOUT") watchForCanvasRecovery();
        scope.console?.error?.("Codex Modeling Studio failed to start.", error);
        throw error;
      }
    })();

    bootPromise.catch(() => {
      bootPromise = null;
    });
    return bootPromise;
  };

  const api = {
    start,
    dispose: stop,
    retry: () => recoverRuntime(),
    async retryWebMcp() {
      if (registrar) return registrar.retry?.();
      if (failedCatalogPageUrl === null
          || scope.location?.href === failedCatalogPageUrl) {
        return snapshot();
      }
      try {
        return await registerPublicTools();
      } catch (error) {
        reportRegistrationFailure(error);
        return snapshot();
      }
    },
    status: snapshot,
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("A studio status listener must be a function.");
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    get runtime() { return runtime; },
    get store() { return store; },
    get registrar() { return registrar; },
    get referenceAssets() { return referenceAssets; },
    get inspection() { return inspection; },
    get exportAssets() { return exportAssets; },
    get persistence() { return deviceCache; },
    get projectController() { return projectController; },
    get modelImports() { return modelImports; },
    get materialAuthoring() { return materialAuthoring; },
    get materialUploads() { return materialUploads; },
    get artifacts() { return modelArtifacts; },
    get canvas() { return nativeCanvas; },
    get pendingExports() {
      return [...pendingExports.values()].map(({ artifact }) => artifact);
    },
    download(artifact) { return downloadBrowserArtifact(scope, document, artifact); },
  };
  return Object.freeze(api);
}

export async function bootstrapStudio(options) {
  const studio = createStudioBootstrap(options);
  await studio.start();
  return studio;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const studio = createStudioBootstrap({ scope: window, document });

  const start = () => {
    void studio.start().catch(() => {
      // The visible status already contains the specific startup failure.
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
  window.addEventListener("pagehide", () => studio.dispose(), { once: true });
}
