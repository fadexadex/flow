import { reportToolFeedback } from "./tool-feedback.js";
import { createCameraGuidance } from "./camera-guidance.js";
import { createContactSheet } from "./contact-sheet.js";
import { createPartAuthoringService } from "./part-authoring.js";
import { validateEditableCapsuleDimensions } from
  "../../../tools/browser-authoring-core/src/part-authoring.js";
import { OWNER_GROUPED_EXPORT_AUTHORITY } from "./grouped-export.js";
import { createVisualDesignReview, createVisualDiagnostics } from
  "../../../tools/visual-authoring-core/src/visual-diagnostics.js";
import { reviewReferenceSilhouette } from "./reference-silhouette.js";
import { describeMaterialResponse } from
  "../../../tools/visual-authoring-core/src/procedural-materials.js";
import { GAME_ASSET_EXPORT_PROFILE } from
  "../../../tools/visual-authoring-core/src/grouped-gltf-export.js";

const MAX_SAFE_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_SELECTION = 4_096;
const MAX_VERTICES = 131_072;
const MAX_FACES = 65_536;
const MAX_FACE_CORNERS = 64;
const MAX_BATCH_OPERATIONS = 100;
const MAX_INLINE_ARTIFACT_BYTES = 512 * 1_024;
const MAX_REFERENCE_IMAGES = 5;
const MAX_REFERENCE_IMAGE_BYTES = 8 * 1_024 * 1_024;
const MAX_REFERENCE_CHUNK_BYTES = 256 * 1_024;
const MAX_REFERENCE_CHUNK_BASE64 = Math.ceil(MAX_REFERENCE_CHUNK_BYTES / 3) * 4;
const MAX_MODEL_ROOT_BYTES = 16 * 1_024 * 1_024;
const MAX_MODEL_BUNDLE_BYTES = 16 * 1_024 * 1_024;
const MAX_OWNER_MODEL_BYTES = 64 * 1_024 * 1_024;
const MAX_CONFIRMED_BATCH_BYTES = 64 * 1_024 * 1_024;
const MAX_MODEL_FILES = 64;
const MAX_MESH_BATCH_OPERATIONS = 128;
const MAX_GROUP_EXPORT_ENTITIES = 64;
const MAX_INSPECTION_VIEWS = 5;
const MAX_CONTACT_SHEET_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_CONTACT_SHEET_BYTES = 4 * 1024 * 1024;
const DEFAULT_CONTACT_SHEET_BYTES = 2 * 1024 * 1024;
const MAX_CONTACT_SHEET_SOURCE_BYTES = MAX_CONTACT_SHEET_FRAME_BYTES * MAX_INSPECTION_VIEWS;
const MAX_CONTROL_BATCH_OPERATIONS = 32;
const MAX_MATERIAL_MAP_BYTES = 4 * 1024 * 1024;
const MAX_MATERIAL_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_MATERIAL_SOURCE_MAPS = 6;
const MAX_MATERIAL_MAP_DIMENSION = 2_048;
const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const OPAQUE_HANDLE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$";
const SHA256_DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";
const CANONICAL_BASE64_PATTERN =
  "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";
const ASSET_PATH_PATTERN =
  "^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*[?#%:\\\\\\u0000-\\u001f\\u007f])[^/]+(?:/[^/]+)*$";
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const finite = (minimum = -1_000_000, maximum = 1_000_000) => ({
  type: "number",
  minimum,
  maximum,
});
const positive = (maximum = 1_000_000) => ({
  type: "number",
  exclusiveMinimum: 0,
  maximum,
});
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const unit = () => finite(0, 1);
const vector = (length, item = finite()) => ({
  type: "array",
  minItems: length,
  maxItems: length,
  items: item,
});
const text = (maximum = 160, minimum = 1) => ({
  type: "string",
  minLength: minimum,
  maxLength: maximum,
});
const enumText = (values) => ({
  type: "string",
  minLength: 1,
  maxLength: Math.max(...values.map((value) => value.length)),
  enum: values,
});
const compactEnum = (values) => ({ enum: values });
const uvMappingSchema = compactEnum(["auto", "palmFrond", "uprightFoliage",
  "cylindrical", "spherical"]);
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const identifier = () => ({ ...text(36, 36), pattern: UUID_PATTERN });
const opaqueHandle = () => ({ ...text(160), pattern: OPAQUE_HANDLE_PATTERN });
const assetPath = () => ({ ...text(512), pattern: ASSET_PATH_PATTERN });
const revision = () => integer(0, MAX_SAFE_NUMBER);
const selection = (maximum = MAX_SELECTION) => ({
  type: "array",
  minItems: 1,
  maxItems: maximum,
  uniqueItems: true,
  items: integer(0, MAX_VERTICES - 1),
});

function closedObject(properties, required = [], extra = {}) {
  return {
    type: "object",
    additionalProperties: false,
    maxProperties: Object.keys(properties).length,
    properties,
    ...(required.length === 0 ? {} : { required }),
    ...extra,
  };
}

const materialFields = Object.freeze({
  baseColor: vector(4, unit()),
  emissiveFactor: vector(3, finite(0, 100)),
  metallic: unit(),
  perceptualRoughness: unit(),
  clearcoat: unit(),
  clearcoatPerceptualRoughness: unit(),
  anisotropyStrength: unit(),
  anisotropyRotation: finite(-Math.PI, Math.PI),
  reflectance: unit(),
  specularTransmission: unit(),
  diffuseTransmission: unit(),
  ior: finite(1, 3),
  thickness: finite(0, 1_000),
  attenuationDistance: positive(),
  attenuationColor: vector(4, unit()),
  baseColorTexture: assetPath(),
  metallicRoughnessTexture: assetPath(),
  normalTexture: assetPath(),
  occlusionTexture: assetPath(),
  emissiveTexture: assetPath(),
  alphaMode: enumText(["opaque", "mask", "blend"]),
  alphaCutoff: unit(),
});

const environmentFields = Object.freeze({
  phaseHours: { ...finite(0, 24), exclusiveMaximum: 24 },
});

const waterFields = Object.freeze({
  windDirection: vector(2, finite(-1.05, 1.05)),
  windSpeedMetersPerSecond: finite(0.1, 100),
  swellDirection: vector(2, finite(-1.05, 1.05)),
  foamHalfLifeSeconds: finite(0.05, 60),
  peakEnhancement: finite(1, 12),
  directionalSpreadExponent: finite(0, 32),
  swellWeight: unit(),
  foamThreshold: finite(0.02, 1.5),
  choppiness: finite(0, 4),
});

const foliageFields = Object.freeze({
  densityPerSquareMeter: positive(65_536),
  halfExtentsMeters: vector(2, positive(8_192)),
  rootColor: vector(4, unit()),
  tipColor: vector(4, unit()),
});

const cameraFields = Object.freeze({
  active: { type: "boolean" },
  hdr: { type: "boolean" },
  bloomIntensity: unit(),
  lookAt: nullable(vector(3)),
  verticalFovDegrees: finite(0.001, 179.999),
  near: positive(),
  far: positive(),
  perspective: closedObject({
    verticalFovDegrees: finite(0.001, 179.999),
    near: positive(),
    far: positive(),
  }),
});

const lightFields = Object.freeze({
  kind: enumText(["directional", "point"]),
  color: vector(3, unit()),
  illuminance: finite(0, 1_000_000),
  intensity: finite(0, 1_000_000),
  range: positive(),
  shadowsEnabled: { type: "boolean" },
});

const transformFields = Object.freeze({
  translation: vector(3),
  rotationDegrees: vector(3, finite(-36_000, 36_000)),
  scale: vector(3, positive(1_000)),
});

const primitiveSchema = {
  oneOf: [
    closedObject({ kind: { const: "cube" }, size: positive() }, ["kind"]),
    closedObject({
      kind: { const: "plane" },
      size: positive(),
      subdivisions: integer(1, 256),
    }, ["kind"]),
    closedObject({
      kind: { const: "cylinder" },
      radius: positive(),
      height: positive(),
      segments: integer(3, 64),
    }, ["kind"]),
    closedObject({
      kind: { const: "capsule" },
      radius: positive(),
      height: positive(),
      segments: integer(3, 64),
      capSegments: integer(2, 32),
    }, ["kind"]),
    closedObject({
      kind: { const: "torus" },
      radius: positive(),
      tubeRadius: positive(),
      segments: integer(3, 64),
      tubeSegments: integer(3, 64),
    }, ["kind"]),
    closedObject({
      kind: { const: "tube" },
      radius: positive(),
      innerRadius: positive(),
      height: positive(),
      segments: integer(3, 64),
    }, ["kind"]),
    closedObject({
      kind: { const: "arch" },
      width: positive(),
      height: positive(),
      depth: positive(),
      thickness: positive(),
      segments: integer(3, 128),
    }, ["kind"]),
    closedObject({
      kind: { const: "cone" },
      radius: positive(),
      height: positive(),
      segments: integer(3, 64),
    }, ["kind"]),
    closedObject({
      kind: { const: "lathe" },
      profile: {
        type: "array",
        minItems: 2,
        maxItems: 128,
        description: "Each point is [nonnegative radius, signed height].",
        items: vector(2, finite()),
      },
      segments: integer(3, 64),
      closed: { type: "boolean" },
      caps: compactEnum(["both", "start", "end", "none"]),
      thickness: positive(),
    }, ["kind", "profile"]),
    closedObject({
      kind: { const: "beveledBox" },
      size: vector(3, positive()),
      bevel: positive(),
      segments: integer(1, 32),
      clampBevel: { type: "boolean" },
    }, ["kind"]),
    closedObject({
      kind: { const: "vehicleBody" },
      size: vector(3, positive()),
      wheelbase: positive(),
      wheelArchRadius: positive(),
      pocketDepth: positive(),
      segments: integer(4, 32),
    }, ["kind"]),
    closedObject({
      kind: { const: "vehicleCabin" },
      size: vector(3, positive()),
      thickness: positive(),
      segments: integer(4, 32),
    }, ["kind"]),
    closedObject({
      kind: { const: "spokedRim" },
      radius: positive(),
      hubRadius: positive(),
      rimThickness: positive(),
      depth: positive(),
      spokes: integer(3, 16),
      segments: integer(2, 8),
    }, ["kind"]),
    closedObject({
      kind: { const: "uvSphere" },
      radius: positive(),
      radii: vector(3, positive()),
      widthSegments: integer(3, 128),
      heightSegments: integer(2, 128),
    }, ["kind"]),
    closedObject({
      kind: { const: "gableRoof" },
      width: positive(),
      depth: positive(),
      height: positive(),
      overhang: finite(0, 1_000),
    }, ["kind"]),
    closedObject({
      kind: { const: "hipRoof" },
      width: positive(),
      depth: positive(),
      height: positive(),
      overhang: finite(0, 1_000),
      ridgeLength: finite(0, 1_000_000),
    }, ["kind"]),
    closedObject({
      kind: { const: "windowFrame" },
      width: positive(),
      height: positive(),
      depth: positive(),
      frameWidth: positive(),
    }, ["kind"]),
    closedObject({
      kind: { const: "staircase" },
      width: positive(),
      depth: positive(),
      height: positive(),
      steps: integer(1, 30),
    }, ["kind"]),
    closedObject({
      kind: { const: "mesh" },
      vertices: {
        type: "array",
        minItems: 3,
        maxItems: MAX_VERTICES,
        items: vector(3),
      },
      faces: {
        type: "array",
        minItems: 1,
        maxItems: MAX_FACES,
        items: {
          type: "array",
          minItems: 3,
          maxItems: MAX_FACE_CORNERS,
          uniqueItems: true,
          items: integer(0, MAX_VERTICES - 1),
        },
      },
    }, ["kind", "vertices", "faces"]),
  ],
};

const coordinateAxis = enumText(["x", "y", "z"]);
const compactSolidCutter = closedObject({
  shape: compactEnum(["box", "roundedBox", "rounded_box", "sphere", "cylinder",
    "capsule", "cone", "torus", "tube"]),
  size: vector(3, positive()),
  radius: positive(),
  height: positive(),
  thickness: positive(),
  bevel: positive(),
  segments: integer(3, 64),
  capSegments: integer(2, 32),
  position: vector(3),
  rotation: vector(3, finite(-36_000, 36_000)),
  scale: vector(3, positive(1_000)),
  space: compactEnum(["target_local", "world"]),
}, ["shape"]);
const compactCutterMirror = closedObject({ axis: coordinateAxis,
  offset: finite() }, ["axis"]);
const materialCategory = enumText(["stone", "wood", "metal", "ceramic", "glass", "fabric",
  "vegetation", "paint", "composite", "rubber", "plastic", "leather", "electronics",
  "organic", "custom"]);
const partTarget = text(128);
const { minLength: _partTargetMinimumLength, ...compactMaterialTarget } = partTarget;
const partPlacement = closedObject({ to: partTarget,
  side: compactEnum(["top", "on", "above", "bottom", "below", "left", "right",
    "front", "back", "center", "inside"]),
  gap: finite(0, 1_000), offset: vector(3),
  mode: compactEnum(["surface"]), uv: vector(2, unit()),
  alignment: compactEnum(["normal", "position"]) }, ["to"]);
const partFields = Object.freeze({
  name: compactMaterialTarget,
  as: compactMaterialTarget,
  shape: compactEnum(["box", "rounded_box", "sphere", "cylinder", "capsule", "torus",
    "tube", "cone", "plane", "arch", "lathe", "gable_roof", "hip_roof",
    "window_frame", "stairs", "vehicle_body", "cabin", "tire", "rim", "glazing",
    "headlight", "grille"]),
  size: vector(3, positive()),
  radius: positive(),
  majorRadius: positive(),
  minorRadius: positive(),
  height: positive(),
  bevel: positive(),
  clampBevel: { type: "boolean" },
  segments: integer(1, 128),
  capSegments: integer(2, 32),
  tubeSegments: integer(3, 64),
  heightSegments: integer(2, 128),
  subdivisions: integer(1, 256),
  steps: integer(1, 30),
  thickness: positive(),
  overhang: finite(0, 1_000),
  ridgeLength: finite(0, 1_000_000),
  wheelbase: positive(),
  spokes: integer(3, 16),
  socket: compactEnum(["front_left", "front_right", "rear_left", "rear_right",
    "hub", "deck", "front", "rear", "left", "right", "headlight_left",
    "headlight_right", "front_intake"]),
  closed: { type: "boolean" },
  caps: compactEnum(["both", "start", "end", "none"]),
  profile: { type: "array", minItems: 2, maxItems: 128,
    description: "Points are [nonnegative radius, signed height].",
    items: { type: "array", minItems: 2, maxItems: 2, items: finite() } },
  position: vector(3),
  rotation: vector(3, finite(-36_000, 36_000)),
  scale: vector(3, positive(1_000)),
  space: compactEnum(["local", "world"]),
  parent: partTarget,
  attach: partPlacement,
  material: compactMaterialTarget,
  uvMapping: uvMappingSchema,
  color: { type: "string", maxLength: 9,
    pattern: "^#(?=.{3}$|.{6}(..)?$)[0-9a-fA-F]+$" },
  metallic: unit(),
  roughness: unit(),
});
const materialSampleParameters = closedObject({
  seed: integer(0, 4_294_967_295),
  scale: finite(0.25, 8),
  detail: unit(),
  weathering: unit(),
  hueShift: finite(-1, 1),
  size: { type: "integer", minimum: 128, maximum: 512, enum: [128, 256, 512] },
  normalStrength: finite(0, 2),
  roughness: unit(),
  metallic: unit(),
  emission: finite(0, 10),
  tint: vector(3, unit()),
  colorMode: enumText(["source", "neutral", "target"]),
  targetColor: vector(3, unit()),
});
const materialPreviewTarget = { oneOf: [
  closedObject({ entityId: identifier() }, ["entityId"]),
  closedObject({ selected: { type: "boolean", const: true } }, ["selected"]),
] };
const materialPreviewFields = Object.freeze({
  render: { type: "boolean", const: true },
  width: integer(64, 512),
  height: integer(64, 512),
  lighting: enumText(["studio", "neutral-reference"]),
  matchColor: vector(3, unit()),
  maxDeltaE: positive(100),
});
const materialSurfacePreview = closedObject({
  ...materialPreviewFields,
  target: materialPreviewTarget,
}, ["render"]);
const markingPreviewViews = { type: "array", minItems: 1, maxItems: 3,
  uniqueItems: true, items: compactEnum(["front", "left", "right"]) };
const assignedMaterialPreview = closedObject({ ...materialPreviewFields,
  views: markingPreviewViews }, ["render"]);
const semanticMarkingLandmark = compactEnum(["leftEye", "rightEye", "nose", "mouth"]);
function surfaceMarkingSchema({ semanticLandmarks = false } = {}) {
  const mark = closedObject({ center: vector(2, unit()),
    ...(semanticLandmarks ? { landmark: semanticMarkingLandmark } : {}),
    radius: vector(2, positive(1)), color: vector(4, unit()),
    softness: unit(), mirror: { type: "boolean" },
  }, semanticLandmarks ? ["radius", "color"] : ["center", "radius", "color"],
  semanticLandmarks ? { oneOf: [{ required: ["center"],
    properties: { landmark: false } }, { required: ["landmark"],
    properties: { center: false } }] } : {});
  return closedObject({ resolution: compactEnum([128, 256, 512]),
    background: vector(4, unit()),
    acknowledgeUnverifiedUv: { type: "boolean" },
    marks: { type: "array", minItems: 1, maxItems: 32, items: mark },
  }, ["resolution", "marks"]);
}
const materialHandle = () => ({ ...text(80, 80),
  pattern: "^material:sha256:[0-9a-f]{64}$" });
const modelSceneSelector = { anyOf: [integer(0, 255), text(128)] };
const materialSource = { oneOf: [
  closedObject({ sampleId: opaqueHandle(), parameters: materialSampleParameters },
    ["sampleId"]),
  closedObject({ materialHandle: materialHandle() }, ["materialHandle"]),
  closedObject({ materialId: materialHandle() }, ["materialId"]),
] };
const materialTextureRole = enumText(["baseColor", "normal", "roughness", "metallic",
  "occlusion", "emissive", "metallicRoughness", "albedo", "ambientOcclusion", "orm"]);
const scalarMaterialFields = Object.freeze(Object.fromEntries(
  Object.entries(materialFields).filter(([field]) => !field.endsWith("Texture"))));
const uploadedMaterialMap = closedObject({
  role: materialTextureRole,
  mediaType: enumText(["image/png", "image/jpeg"]),
  byteLength: integer(1, MAX_MATERIAL_MAP_BYTES),
  sha256: { ...text(71, 71), pattern: SHA256_DIGEST_PATTERN },
  width: integer(1, MAX_MATERIAL_MAP_DIMENSION),
  height: integer(1, MAX_MATERIAL_MAP_DIMENSION),
  colorSpace: enumText(["srgb", "linear"]),
}, ["role", "mediaType", "byteLength", "sha256", "width", "height"]);
const materialTarget = { oneOf: [
  closedObject({ entityIds: { type: "array", minItems: 1, maxItems: 128,
    uniqueItems: true, items: identifier() } }, ["entityIds"]),
  closedObject({ selected: { type: "boolean", const: true },
    includeDescendants: { type: "boolean" } }, ["selected"]),
  closedObject({ rootEntityId: identifier(),
    includeDescendants: { type: "boolean", const: true } },
  ["rootEntityId", "includeDescendants"]),
] };

const loftSurfaceSchema = closedObject({
  interpolation: enumText(["centripetalCatmullRom"]),
  longitudinalSegments: integer(1, 8),
  profileSegments: integer(1, 8),
}, ["interpolation"]);

const meshOperationSchema = {
  oneOf: [
    closedObject({ op: { const: "extrude" }, faces: selection(), distance: finite() },
      ["op", "faces", "distance"]),
    closedObject({ op: { const: "inset" }, faces: selection(), amount: positive(),
      depth: finite() }, ["op", "faces", "amount"]),
    closedObject({
      op: { const: "bevel" },
      edges: {
        type: "array", minItems: 1, maxItems: MAX_SELECTION,
        uniqueItems: true, items: vector(2, integer(0, MAX_VERTICES - 1)),
      },
      amount: positive(),
    }, ["op", "edges", "amount"]),
    closedObject({ op: { const: "subdivide" }, faces: selection(),
      levels: integer(1, 6), smooth: { type: "boolean" }, strength: unit(),
      creaseAngleDegrees: finite(0, 180) }, ["op"]),
    closedObject({ op: { const: "transform" }, vertices: selection(),
      translation: vector(3), rotate: vector(3, finite(-Math.PI * 200, Math.PI * 200)),
      rotationDegrees: vector(3, finite(-36_000, 36_000)),
      scale: vector(3, positive(1_000)),
    }, ["op"], { minProperties: 2 }),
    closedObject({ op: { const: "weld" }, distance: positive() },
      ["op", "distance"]),
    closedObject({ op: { const: "arrayLinear" }, count: integer(2, 64),
      offset: vector(3) }, ["op", "count", "offset"]),
    closedObject({ op: { const: "arrayRadial" }, count: integer(2, 64),
      axis: coordinateAxis, angle: finite(-Math.PI * 200, Math.PI * 200),
      angleDegrees: finite(-36_000, 36_000), center: vector(3),
    }, ["op", "count", "axis"]),
    closedObject({ op: { const: "mirror" }, axis: coordinateAxis,
      offset: finite() }, ["op", "axis"]),
    closedObject({ op: { const: "loopCut" }, axis: coordinateAxis,
      position: finite() }, ["op", "axis", "position"]),
    closedObject({ op: { const: "sculpt" }, center: vector(3),
      extents: vector(3, positive()), translation: vector(3),
      falloff: compactEnum(["constant", "linear", "smooth"]),
      symmetryAxis: coordinateAxis, symmetryOffset: finite(),
    }, ["op", "center", "extents", "translation"]),
  ],
};

const inspectionViewPreset = enumText([
  "front", "back", "left", "right", "three-quarter", "top", "custom",
]);
const inspectionFit = enumText(["projected", "bounds"]);
const inspectionBackground = enumText(["inherit", "studio", "transparent"]);
const inspectionTarget = {
  oneOf: [
    closedObject({ entityId: identifier(), feature: text(160), component: text(256) },
      ["entityId"]),
    closedObject({ name: text(256), feature: text(160), component: text(256) },
      ["name"]),
    closedObject({ point: vector(3), radius: positive() }, ["point"]),
  ],
};
const inspectionFraming = closedObject({
  preset: inspectionViewPreset,
  azimuthDegrees: finite(-360, 360),
  elevationDegrees: finite(-90, 90),
  padding: finite(1, 4),
  verticalFovDegrees: finite(5, 150),
  aspect: finite(0.1, 10),
  distanceScale: finite(0.1, 10),
  anchor: enumText(["center", "top", "bottom", "left", "right", "front", "back"]),
});
const ownerCameraFraming = closedObject({
  preset: inspectionViewPreset,
  azimuthDegrees: finite(-360, 360),
  elevationDegrees: finite(-90, 90),
  padding: finite(1, 4),
  distanceScale: finite(0.1, 10),
  anchor: enumText(["center", "top", "bottom", "left", "right", "front", "back"]),
});
const inspectionViewFields = {
  id: { ...text(64), pattern: "^[A-Za-z0-9_-]{1,64}$" },
  preset: inspectionViewPreset,
  azimuthDegrees: finite(-360, 360),
  elevationDegrees: finite(-90, 90),
  distanceScale: finite(0.1, 10),
  verticalFovDegrees: finite(5, 150),
  near: finite(0.0001, 1_000),
  far: positive(),
  width: integer(1, 1_920),
  height: integer(1, 1_920),
  fit: inspectionFit,
  padding: finite(1.01, 2),
  background: inspectionBackground,
};
const inspectionView = closedObject(inspectionViewFields, ["id"]);
const orthographicInspectionView = closedObject({ ...inspectionViewFields,
  projection: enumText(["perspective", "orthographic"]),
  verticalSpan: finite(0.0001, 1_000_000),
}, ["id"]);
const visualDiagnosticsFields = {
  enabled: { type: "boolean", const: true },
  includeScene: { type: "boolean" },
  maxEntities: integer(1, 32),
  maxFindings: integer(1, 16),
};
const visualDiagnosticsOptions = closedObject(visualDiagnosticsFields, ["enabled"]);
const referenceVisualDiagnosticsOptions = closedObject({ ...visualDiagnosticsFields,
  reference: { type: "boolean", const: true },
  referenceId: identifier(),
}, ["enabled"]);
const designEntityIds = { type: "array", minItems: 1, maxItems: 32,
  uniqueItems: true, items: identifier() };
const designGoal = closedObject({ id: { ...text(64), pattern: "^[A-Za-z0-9_-]{1,64}$" },
  viewId: { ...text(64), pattern: "^[A-Za-z0-9_-]{1,64}$" },
  metric: enumText(["silhouette_aspect_ratio", "foreground_occupancy"]),
  minimum: finite(0, 1_000), maximum: finite(0, 1_000),
}, ["id", "viewId", "metric"]);
const relativeProportion = closedObject({ entityId: identifier(),
  referenceEntityId: identifier(), axis: compactEnum(["x", "y", "z", "max"]),
  minimum: finite(0, 1_000), maximum: finite(0, 1_000),
}, ["entityId", "referenceEntityId", "axis"]);
const designContact = closedObject({ entityId: identifier(), targetEntityId: identifier(),
  maxGap: finite(0, 1_000),
  viewId: { ...text(64), pattern: "^[A-Za-z0-9_-]{1,64}$" },
  maxProjection: finite(0, 1_000), minEmbed: finite(0, 1_000),
  minClearance: finite(0, 1_000), maxPenetration: finite(0, 1_000),
  maxCoplanarGap: finite(0, 1_000),
}, ["entityId", "targetEntityId", "maxGap"]);
const designPair = closedObject({ leftEntityId: identifier(), rightEntityId: identifier() },
  ["leftEntityId", "rightEntityId"]);
const designOpening = closedObject({ entityId: identifier(),
  kind: enumText(["through", "recess"]), origin: vector(3), direction: vector(3),
  radius: positive(), minimumDepth: positive(), space: { const: "entity_local" },
}, ["entityId", "kind", "origin", "direction", "radius", "minimumDepth", "space"]);
const visualDesignBrief = closedObject({ summary: text(240),
  members: designEntityIds,
  requiredViewIds: { type: "array", minItems: 1, maxItems: 5,
    uniqueItems: true,
    items: { ...text(64), pattern: "^[A-Za-z0-9_-]{1,64}$" } },
  proportionGoals: { type: "array", minItems: 1, maxItems: 8, items: designGoal },
  relativeProportions: { type: "array", minItems: 1, maxItems: 8,
    items: relativeProportion },
  continuousEntityIds: designEntityIds,
  intentionalSeparateEntityIds: designEntityIds,
  requiredContacts: { type: "array", minItems: 1, maxItems: 16, items: designContact },
  allowedIntersectionPairs: { type: "array", minItems: 1, maxItems: 16, items: designPair },
  expectedOpenings: { type: "array", minItems: 1, maxItems: 8, items: designOpening },
});

const componentValueSchemas = Object.freeze({
  "oriel.material": closedObject(materialFields),
  "oriel.water": closedObject(waterFields),
  "oriel.foliage_field": closedObject(foliageFields),
  "oriel.transform": closedObject(transformFields),
  "oriel.camera": closedObject(cameraFields),
  "oriel.directionalLight": closedObject({
    color: vector(3, unit()),
    illuminance: finite(0, 1_000_000),
    shadowsEnabled: { type: "boolean" },
  }),
  "oriel.pointLight": closedObject({
    color: vector(3, unit()),
    intensity: finite(0, 1_000_000),
    range: positive(),
    shadowsEnabled: { type: "boolean" },
  }),
  "oriel.part_attachment": closedObject({ targetId: identifier(),
    side: compactEnum(["top", "on", "above", "bottom", "below", "left", "right",
      "front", "back", "center", "inside"]),
    socket: partFields.socket,
  }, ["targetId", "side"]),
});

const entityFields = Object.freeze({
  entityId: identifier(),
  name: text(),
  parent: nullable(identifier()),
  ...transformFields,
});

const curveGeometryFields = Object.freeze({
  mode: enumText(["curve", "sweep", "loft"]),
  path: { type: "array", minItems: 2, maxItems: 128, items: vector(3) },
  profile: { type: "array", minItems: 3, maxItems: 64, items: vector(2) },
  profiles: { type: "array", minItems: 2, maxItems: 32,
    items: { type: "array", minItems: 3, maxItems: 65, items: vector(3) } },
  radius: positive(),
  segments: integer(3, 128),
  closed: { type: "boolean" },
  alignProfiles: { type: "boolean" },
  surface: loftSurfaceSchema,
});

const stableControlIdentifier = { ...text(16), pattern: "^[vfc][0-9]{1,14}$" };
const authoredControlIdentifier = { ...text(16), pattern: "^[cp][0-9]{1,14}$" };
const controlIndex = { anyOf: [integer(0, MAX_VERTICES - 1), stableControlIdentifier] };
const controlIndices = { type: "array", minItems: 1, maxItems: MAX_SELECTION,
  uniqueItems: true, items: controlIndex };
const authoredControlIndices = { type: "array", minItems: 1, maxItems: MAX_SELECTION,
  uniqueItems: true, items: authoredControlIdentifier };
const controlEdge = vector(2, controlIndex);
const controlEdges = { type: "array", minItems: 1, maxItems: MAX_SELECTION,
  items: controlEdge };
const controlSelection = closedObject({
  mode: enumText(["vertices", "edges", "faces", "edgeLoop", "boundary", "spatial",
    "controls", "role"]),
  vertices: controlIndices,
  controlIds: authoredControlIndices,
  role: compactEnum(["upper", "lower", "left", "right", "center"]),
  profilePosition: compactEnum(["start", "middle", "end"]),
  profileRange: vector(2, unit()),
  mirror: { type: "boolean" },
  nearest: integer(1, MAX_SELECTION),
  edges: controlEdges,
  faces: controlIndices,
  edge: controlEdge,
  center: vector(3),
  radius: positive(),
  bounds: closedObject({ min: vector(3), max: vector(3) }, ["min", "max"]),
  grow: integer(0, 64),
  maxVertices: integer(1, MAX_SELECTION),
  protectBoundary: { type: "boolean" },
  protectCreases: { type: "boolean" },
}, ["mode"]);
const compactControlSelection = closedObject({
  mode: compactEnum(["vertices", "edges", "faces", "edgeLoop", "boundary", "spatial",
    "controls", "role"]),
  vertices: controlIndices,
  controlIds: authoredControlIndices,
  role: compactEnum(["upper", "lower", "left", "right", "center"]),
  profilePosition: compactEnum(["start", "middle", "end"]),
  profileRange: vector(2, unit()),
  mirror: { type: "boolean" },
  nearest: integer(1, MAX_SELECTION),
  edges: controlEdges,
  faces: controlIndices,
  edge: controlEdge,
  center: vector(3),
  radius: positive(),
  bounds: closedObject({ min: vector(3), max: vector(3) }, ["min", "max"]),
}, ["mode"]);
const batchControlSelection = closedObject({
  mode: compactEnum(["vertices", "spatial"]),
  vertices: controlIndices,
  center: vector(3),
  radius: positive(),
  maxVertices: integer(1, MAX_SELECTION),
}, ["mode"]);
const cageTransformOperation = closedObject({
  op: { const: "transform" },
  selection: batchControlSelection,
  translation: vector(3),
  scale: vector(3, positive(1_000)),
  center: vector(3),
  radius: positive(),
  falloff: compactEnum(["constant", "linear", "smooth"]),
  protectBoundary: { type: "boolean" },
  protectCreases: { type: "boolean" },
  maxVertices: integer(1, MAX_SELECTION),
}, ["op", "selection"], { minProperties: 3 });
const semanticSculptStroke = closedObject({
  region: text(96),
  move: vector(3),
  falloff: compactEnum(["constant", "linear", "smooth"]),
  symmetryAxis: coordinateAxis,
}, ["region", "move"]);
const boundaryLoop = { anyOf: [selection(),
  closedObject({ edge: vector(2, integer(0, MAX_VERTICES - 1)) }, ["edge"])] };
const curvePoint = { type: "array", minItems: 2, maxItems: 3, items: finite() };
const curveControlEdit = closedObject({
  kind: compactEnum(["loft_point", "path_point", "profile_point", "sweep_point",
    "loft_profile"]),
  action: compactEnum(["move", "set", "insert", "remove"]),
  profileId: authoredControlIdentifier,
  controlId: authoredControlIdentifier,
  afterControlId: authoredControlIdentifier,
  afterProfileId: authoredControlIdentifier,
  move: curvePoint,
  position: curvePoint,
  points: { type: "array", minItems: 3, maxItems: 64, items: vector(3) },
}, ["kind", "action"]);
const curveControlEdits = { type: "array", minItems: 1, maxItems: 128,
  items: curveControlEdit };
const compactCurveControlEdit = closedObject({
  kind: compactEnum(["loft_point", "path_point", "profile_point", "sweep_point",
    "loft_profile"]),
  action: compactEnum(["move", "set", "insert", "remove"]),
  profileId: authoredControlIdentifier,
  controlId: authoredControlIdentifier,
  move: curvePoint,
  position: curvePoint,
}, ["kind", "action"]);
const compactCurveControlEdits = { type: "array", minItems: 1, maxItems: 128,
  items: compactCurveControlEdit };
const reflectionConstraint = closedObject({
  mode: enumText(["enable", "disable", "bake"]),
  axis: coordinateAxis,
  offset: finite(),
  tolerance: positive(),
}, ["mode"]);

const componentPatchOperations = Object.entries(componentValueSchemas)
  .flatMap(([component, value]) => [
    closedObject({
      op: { const: "patch_component" },
      entityId: identifier(),
      component: { const: component },
      mode: { enum: ["merge", "replace"] },
      value,
    }, ["op", "entityId", "component", "value"]),
    closedObject({
      op: { const: "patch_component" },
      entityId: identifier(),
      component: { const: component },
      mode: { const: "remove" },
    }, ["op", "entityId", "component", "mode"]),
  ]);

const curvePath = curveGeometryFields.path;
const curveProfile = curveGeometryFields.profile;
const loftProfiles = curveGeometryFields.profiles;
const curveEntityFields = Object.freeze({ ...entityFields,
  material: closedObject(materialFields),
  shading: { enum: ["smooth", "flat"] },
  uvMapping: uvMappingSchema,
});
const sceneCurveOperations = [
  closedObject({ op: { const: "mesh_curve_create" }, ...curveEntityFields,
    mode: { const: "curve" }, path: curvePath, radius: positive(),
    segments: integer(3, 128), closed: { type: "boolean" },
  }, ["op", "entityId", "mode", "path"]),
  closedObject({ op: { const: "mesh_curve_create" }, ...curveEntityFields,
    mode: { const: "sweep" }, path: curvePath, profile: curveProfile,
    closed: { type: "boolean" },
  }, ["op", "entityId", "mode", "path", "profile"]),
  closedObject({ op: { const: "mesh_curve_create" }, ...curveEntityFields,
    mode: { const: "loft" }, profiles: loftProfiles,
    closed: { type: "boolean" }, alignProfiles: curveGeometryFields.alignProfiles,
    surface: curveGeometryFields.surface,
  }, ["op", "entityId", "mode", "profiles"]),
];
const inlineMeshEditOperations = meshOperationSchema.oneOf.map((variant) => {
  const { op, ...fields } = variant.properties;
  return closedObject({ op: { const: "mesh_edit" }, entityId: identifier(),
    operation: { const: op.const }, ...fields,
  }, ["op", "entityId", "operation",
    ...(variant.required ?? []).filter((field) => field !== "op")],
  variant.minProperties === undefined ? {} : {
    minProperties: variant.minProperties + 2,
  });
});

const sceneOperationSchema = {
  oneOf: [
    closedObject({ op: { const: "add_entity" }, ...entityFields }, ["op", "name"]),
    closedObject({
      op: { const: "rename_entity" },
      entityId: identifier(),
      name: text(),
    }, ["op", "entityId", "name"]),
    closedObject({
      op: { const: "reparent_entity" },
      entityId: identifier(),
      parent: nullable(identifier()),
    }, ["op", "entityId", "parent"]),
    closedObject({
      op: { const: "remove_entity" },
      entityId: identifier(),
      recursive: { type: "boolean" },
    }, ["op", "entityId"]),
    closedObject({
      op: { const: "add_primitive" },
      ...entityFields,
      shape: { enum: ["cube", "plane", "sphere", "cylinder", "capsule", "torus", "beveledBox"] },
      size: { type: "array", minItems: 2, maxItems: 3, items: positive() },
      bevel: positive(),
      segments: integer(1, 32),
      radius: positive(),
      height: positive(),
      majorRadius: positive(),
      minorRadius: positive(),
      baseColor: materialFields.baseColor,
      metallic: materialFields.metallic,
      perceptualRoughness: materialFields.perceptualRoughness,
      spinRadiansPerSecond: finite(-1_000, 1_000),
    }, ["op", "name", "shape"]),
    closedObject({
      op: { const: "mesh_create" },
      ...entityFields,
      primitive: primitiveSchema,
      material: closedObject(materialFields),
      shading: { enum: ["smooth", "flat"] },
      uvMapping: uvMappingSchema,
    }, ["op", "entityId", "primitive"]),
    closedObject({ op: { const: "mesh_convert" }, entityId: identifier() },
      ["op", "entityId"]),
    closedObject({ op: { const: "mesh_reflect" }, entityId: identifier(),
      axis: coordinateAxis }, ["op", "entityId", "axis"]),
    closedObject({ op: { const: "mesh_boolean" }, targetId: identifier(),
      toolId: identifier(), operation: compactEnum(["difference", "union", "intersection", "blend"]),
      cutter: compactSolidCutter, mirror: compactCutterMirror,
      keepTool: { type: "boolean" }, radius: positive(), segments: integer(1, 4),
    }, ["op", "targetId", "operation"], { minProperties: 4 }),
    ...sceneCurveOperations,
    ...inlineMeshEditOperations,
    closedObject({ op: { const: "mesh_edit_batch" }, entityId: identifier(),
      operationSpecs: { type: "array", minItems: 1, maxItems: MAX_MESH_BATCH_OPERATIONS,
        items: meshOperationSchema },
    }, ["op", "entityId", "operationSpecs"]),
    closedObject({
      op: { const: "material_sample_apply" },
      entityId: identifier(),
      sampleId: opaqueHandle(),
      parameters: materialSampleParameters,
    }, ["op", "entityId", "sampleId"]),
    closedObject({
      op: { const: "material_sample_apply" },
      target: materialTarget,
      source: materialSource,
    }, ["op", "target", "source"]),
    closedObject({
      op: { const: "set_transform" },
      entityId: identifier(),
      ...transformFields,
    }, ["op", "entityId"], { minProperties: 3 }),
    closedObject({
      op: { const: "add_camera" },
      ...entityFields,
      ...cameraFields,
    }, ["op", "name"]),
    closedObject({
      op: { const: "set_camera" },
      entityId: identifier(),
      ...cameraFields,
    }, ["op", "entityId"], { minProperties: 3 }),
    closedObject({
      op: { const: "add_light" },
      ...entityFields,
      ...lightFields,
    }, ["op", "name", "kind"]),
    closedObject({
      op: { const: "set_light" },
      entityId: identifier(),
      ...lightFields,
    }, ["op", "entityId"], { minProperties: 3 }),
    closedObject({
      op: { const: "add_asset" },
      ...entityFields,
      path: assetPath(),
      scene: integer(0, 255),
    }, ["op", "name", "path"]),
    closedObject({
      op: { const: "set_material" },
      entityId: identifier(),
      ...materialFields,
      uvMapping: uvMappingSchema,
    }, ["op", "entityId"], { minProperties: 3 }),
    closedObject({
      op: { const: "set_environment" },
      entityId: identifier(),
      ...environmentFields,
    }, ["op"], { minProperties: 2 }),
    closedObject({
      op: { const: "set_water" },
      entityId: identifier(),
      ...waterFields,
    }, ["op", "entityId"], { minProperties: 3 }),
    closedObject({
      op: { const: "set_foliage" },
      entityId: identifier(),
      ...foliageFields,
    }, ["op", "entityId"], { minProperties: 3 }),
    ...componentPatchOperations,
  ],
};

// Native tool discovery serializes every descriptor, so repeating the same
// closed field schema across every discriminated operation is expensive. Keep
// the public envelope bounded and closed, then enforce the original exact
// operation-specific schema before invoking any scene mutation.
function compactDiscriminatedSchema(variants, discriminator) {
  const fields = new Map();
  for (const variant of variants) {
    for (const [field, schema] of Object.entries(variant.properties)) {
      const candidates = fields.get(field) ?? [];
      const serialized = JSON.stringify(schema);
      if (!candidates.some((candidate) => candidate.serialized === serialized)) {
        candidates.push({ serialized, schema });
      }
      fields.set(field, candidates);
    }
  }
  const properties = Object.fromEntries(Array.from(fields,
    ([field, candidates]) => [field, candidates.length === 1
      ? candidates[0].schema
      : { anyOf: candidates.map(({ schema }) => schema) }]));
  properties[discriminator] = compactEnum(Array.from(new Set(variants
    .map(({ properties: variant }) => variant[discriminator].const))));
  return closedObject(properties, [discriminator]);
}

function compactSceneOperationSchema(variants) {
  const envelope = compactDiscriminatedSchema(variants, "op");
  const { properties } = envelope;
  if (properties.primitive !== undefined) properties.primitive = primitiveSchema;
  if (properties.operationSpecs !== undefined) {
    properties.operationSpecs = { type: "array", minItems: 1,
      maxItems: MAX_MESH_BATCH_OPERATIONS, items: meshOperationSchema };
  }
  properties.component = compactEnum(Object.keys(componentValueSchemas));
  properties.mode = compactEnum(["merge", "replace", "remove", "curve", "sweep", "loft"]);
  if (properties.segments !== undefined) properties.segments = integer(1, 128);
  for (const field of ["entityId", "targetId", "toolId"]) {
    if (properties[field] !== undefined) properties[field] = text(36, 36);
  }
  return envelope;
}

const compactSceneOperation = compactSceneOperationSchema(sceneOperationSchema.oneOf);
const compactPreflightOperation = compactSceneOperationSchema([
  ...sceneOperationSchema.oneOf,
  ...meshOperationSchema.oneOf,
]);

const documentation = Object.freeze({
  overview: Object.freeze({
    title: "Agent Modeling Studio",
    body: "Any WebMCP-compatible agent can author hard-surface objects, organic forms, architecture, product concepts, and production assets in this modeling studio. Every new project starts with one centered default cube, a neutral-gray environment, restrained lighting, and an active camera; there is no floor or ground plane. The perspective-aligned reference grid is an editor-only viewport guide, never scene geometry. The default cube is a built-in scene primitive, not an external model asset. The agent inspects, creates, imports, edits, shades, frames, and exports real scene content through directly registered WebMCP tools. There is no application server, remote scene store, MCP HTTP endpoint, application websocket, synthetic render, or automatic download.",
  }),
  agent_loop: Object.freeze({
    title: "Agent-first inspect, author, capture, and refine loop",
    body: "1. Begin immediately with part_add and a natural material name such as Brushed Aluminum; inspect the existing scene only when needed to preserve user work, and browse material_samples_list only when a finish is unknown. 2. Shape one coarse editable mesh before adding details; establish its silhouette, proportions, and major volumes from genuinely different views. Use actual uploaded references and truly orthographic projections only when their registered tools and native capabilities support them. 3. Convert, refine, or replace the default cube; primitive blockouts are editable scaffolding, not an assembly recipe or proof that a complex form is finished. Persistent control cages and editable loft profiles require genuinely registered support. 4. Develop connected primary surfaces, existing genuine lofts or sweeps, integrated transitions, and real Boolean openings. Refine coarse-to-fine while protecting available creases; apply actual per-edit symmetry or mirroring without claiming an ongoing constraint. Disconnected decorative geometry needs a genuine structural justification. 5. When useful, inspect a suitable sample with material_sample_inspect and reuse it through material_sample_apply; tune genuine textured PBR materials and clear, readable lighting. Do not hand back an unfinished gray primitive unless explicitly requested. 6. Camera guidance is enabled by default: use camera_guide to move the user's actual visible camera. This is transient viewport movement only: it never serializes the camera, changes scene revision or undo history, triggers autosave, or persists. Use camera_set only for an explicitly requested authored, persistent scene-camera edit. Respect the user's opt-out and yield whenever the user orbits, pans, zooms, or interacts. 7. For a complex asset, inspect at least three genuinely different owner-independent WebGPU viewpoints with render_contact_sheet when available. If any actual frame exposes disconnected surfaces, floating or intersecting parts, a weak silhouette, fake openings, or poor lighting, mark needs_more_work, modify genuine geometry, and capture again. Never announce production_ready from a blockout, a tool-call count, or a critique alone. 8. Export actual GLB only when requested; report genuine missing features without fabricating results. The user observes; the agent performs every authoring operation.",
  }),
  workflow: Object.freeze({
    title: "Agent-authored visible modeling workflow",
    body: "Begin authoring immediately with actual WebMCP tools, not manual editing gestures or preparatory scripts. Use part_add with a friendly material name such as Brushed Aluminum; inspect existing work or browse the material library only when useful. Follow the requested subject without adding an unrequested floor. Start from one coarse editable mesh, establish its silhouette and proportions from multiple genuine viewpoints, then shape continuous connected primary surfaces with part_curve lofts/sweeps, actual mesh edits, and real part_boolean openings. Refine coarse-to-fine with existing crease-aware subdivision; use one-shot mirroring or per-edit symmetry without describing them as persistent constraints. Persistent editable controls, ongoing symmetry, true orthography, and image-grounded reference comparison may be recommended only when their actual native and registered capabilities exist. Disconnected decorative parts must be structurally justified. Refine real textured physically based materials and lighting. Use camera_guide for transient visible framing without changing scene revision, undo, autosave, or persistence; immediately yield to manual control. Only explicitly requested camera_set edits persist. Inspect at least three genuinely different owner-independent WebGPU views for complex work. Every visible defect means needs_more_work: modify the actual geometry, render again, and repeat until the user's requested model genuinely looks production-ready. Never optimize for the fewest modeling calls or call a primitive kitbash finished. Prepare a real GLB only when requested.",
  }),
  hero_asset: Object.freeze({
    title: "User-directed subjects and reference-led model authoring",
    body: "Begin immediately with the centered default cube or the current project's existing authored content, then model what the user requested. Hard-surface products, tools, furniture, vehicles, robotics, game props, architecture, environment assets, stylized characters, organic forms, and abstract sculpture are equally valid. Transform or replace the built-in cube, import genuine GLB/glTF geometry when relevant, then shape a coarse editable mesh into the requested silhouette, proportions, and major volumes. Develop continuous connected surfaces, genuine existing lofts or sweeps, integrated transitions, and actual openings before adding small details. Refine coarse-to-fine while preserving supported creases; use existing mirror or symmetric sculpt operations without claiming durable symmetry. Recommend persistent control cages, editable curve profiles, orthographic views, or image-grounded reference comparison only when those capabilities are genuinely registered and supported. Floating trim, arbitrary primitive piles, fake openings, and disconnected decorative surfaces without structural justification are modeling defects for any subject. Apply a known natural material name immediately; browse the existing material sample library only when a suitable finish is unknown. Never add a floor, scenery, or unrelated subject unless requested. Inspect at least three genuinely different actual WebGPU views; correct actual rendered geometry, material, lighting, and composition defects; do not hand off until the materialized model looks polished and complete unless the user requests an unfinished study. If defects remain, report needs_more_work and continue authoring instead of claiming production_ready. Prepare a genuine single or grouped GLB when export is requested.",
  }),
  production_quality: Object.freeze({
    title: "Production-quality visual review and corrective authoring",
    body: "Treat every requested hero asset as needs_more_work until real image evidence proves otherwise. A visible part, a material assignment, a large primitive count, one attractive angle, or a written critique is never evidence of a finished design. Establish the silhouette, proportions, and coherent major volumes on one coarse editable mesh before decorating. Replace stacked primitives with genuine connected lofts or sweeps from part_curve, refine actual editable surfaces with part_feature/mesh_apply_batch, and use part_boolean for functional openings and supported seamless transitions. Integrate neighboring surfaces instead of covering gaps with floating or intersecting pieces; disconnected decorative geometry requires a clear structural justification. Refine coarse-to-fine while protecting supported creases and applying only genuinely available symmetry operations. Never claim persistent control cages, editable loft profiles, ongoing symmetry constraints, true orthographic capture, or image-grounded reference comparison unless their registered operations and native capabilities exist. Light the design clearly enough to read every contour. Use render_contact_sheet to inspect at least three genuinely distinct owner-independent views; owner camera, revision, selection, and project must stay unchanged. In each actual image assess subject fidelity, proportion, silhouette, flowing surface continuity, topology and real openings, attachment/intersection integrity, material realism, lighting legibility, and presentation from every exposed side. For each failure call the real modeling, material, or lighting tools, then capture and critique again; repeat as many substantive iterations as required. Never describe a kitbash or a known-bad render as stunning, finished, production-ready, or complete. Declare production_ready only when every relevant view meets the user's brief; otherwise retain needs_more_work and honestly identify an actual capability gap. Preserve intentional user-requested low-poly, toy, stylized, clay, wireframe, or unfinished aesthetics without excusing unintended defects.",
  }),
  composition: Object.freeze({
    title: "Existing modeling scene composition and effects",
    body: "Reuse existing editor scene-operation contracts directly: add_entity, rename_entity, reparent_entity, remove_entity, add_primitive, set_transform, patch_component, add_camera, set_camera, add_light, set_light, set_material, set_environment, and add_asset. scene_preflight_batch validates ordered scene or mesh edits without changing authored state; scene_apply_batch commits scene operations atomically after genuine renderer acceptance. Adjust visible daylight and existing lights without introducing an unrequested floor or unrelated scenery. Use camera_guide for transient visible viewport framing: it never changes the authored scene, scene revision, undo history, autosave, or persisted project. Use camera_set only when the user explicitly asks to edit the authored, serialized scene camera. Advanced material patches expose real PBR transmission, attenuation, IOR, emission, and generated texture maps without adding an application backend.",
  }),
  revisions: Object.freeze({
    title: "Atomic edits, revision checks, and cancellation",
    body: "Read the current numeric revision and target entity IDs before authoring. Mutations accept expectedRevision; refresh status/scene_get after any stale response instead of guessing. scene_preflight_batch validates up to 100 ordered scene operations, or up to 128 mesh operations when entityId is supplied; its projected identities and inventory are hypothetical, rendererChecked is false, and authored scene, revision, selection, history, renderer, and autosave remain unchanged. Scene operation batches and generated-mesh changes commit atomically only after genuine native renderer acceptance. camera_guide is a transient viewport-only read operation: it can move the actual visible owner camera but never mutates scene JSON, advances its revision, creates an undo entry, triggers autosave, or survives project reload. Only an explicit camera_set scene edit intentionally changes the authored persistent camera and scene revision. Cancellation before submission leaves the scene unchanged; an already committed mutation returns its committed revision, and an ambiguous native submission must be reconciled rather than replayed.",
  }),
  modeling: Object.freeze({
    title: "Mesh modeling selections and budgets",
    body: "The neutral workspace starts with one centered built-in cube and no physical floor. The first accepted authored geometry automatically replaces an untouched starter cube in the same transaction. Do not blindly remove Cube after authoring; remove an existing inspected cube only when genuinely intended, and preserve modified or intentionally retained work. Add a named editable box, capsule, torus, tube, lathe, or architectural shape. Torus and tube dimensions use radius and thickness. Editable capsule height is its total pole-to-pole length and must strictly exceed twice its radius; native scene capsule height is only its cylindrical section. Raw editable capsules default to radius 0.25; named capsules derive radius from size and total height. Sphere dialects differ: part_add uses shape:sphere and segments 3-128; mesh_create uses primitive:{kind:uvSphere,widthSegments:3-128,heightSegments:2-128}; scene add_primitive uses top-level shape/radius, and segments 1-32 apply only to beveledBox; scene mesh_create accepts the high-resolution nested uvSphere primitive. Never put a nested primitive in add_primitive, use segments on uvSphere, or silently clamp excessive resolution. Generated spheres and ellipsoids default to genuine spherical UV mapping; explicit auto remains supported. Inspect the actual current mapping through mesh_inspect or material_inspect; update an existing modeled mesh through material_set:{entityId,uvMapping:'spherical'} or atomic set_material, rebuilding real GLB UVs and tangents in one undoable scene edit. Spherical mapping generates genuine seam-safe longitude/latitude coordinates; front +Z is U=0.25, back -Z is U=0.75, and the periodic seam is U=0/1. Scaling changes physical mark size, not UV orientation; verify the authored sphere mapping after conversion or Boolean edits instead of moving facial marks to the rear. Use real oriented patterns, Boolean difference/union/intersection, seamless contact-surface blending, curved paths, sweeps, lofts, and semantic face features. Set operation:blend on part_boolean to join touching opposed coplanar solids or genuinely intersecting curved surfaces with an optional positive radius and 1-4 segments while preserving attached children. Inline cutters accept omitted keepTool or harmless keepTool:false; keepTool:true cannot retain an ephemeral solid. mesh_create accepts cube, plane, cylinder, capsule, torus, tube, arch, cone, lathe, beveledBox, uvSphere, and custom indexed polygon geometry; entityId always reserves a new unused identity and never replaces an existing mesh. Edit an existing mesh with actual mesh/cage operations or atomically transform its existing entity. Custom meshes support up to 131072 vertices, 65536 faces, and 64 corners per face; atomic modeling batches support at most 128 operations. Supply entityId to scene_preflight_batch to validate the same mesh operations without committing geometry. Each generated GLB keeps a stable asset path while its digest changes after committed geometry edits. Parented part transforms default to local; use space:'world' on part_add, parts_add, or part_edit for absolute character positions and intended undistorted size. A group-level world space is inherited unless an individual part overrides it. Inspect the actual parent chain, local/world transforms, measured bounds, and attachment contacts immediately. Prefer an unscaled root group; compensate nonuniform parent scaling, and reject unsupported shear atomically. World placement cannot be combined with socket or attach. When the requested subject is a character, shape one continuous head, muzzle, jaw, and neck first; inspect genuine front, three-quarter, and strict profile views before facial details. Create two real recessed eye sockets using an actual mirrored difference cutter, add at most one seated eyeball per socket, and embed or sculpt the nose and mouth instead of stacking floating plates or wires. Use explicit verified face:eye_socket_left/right, face:brow, face:cheek_left/right, face:muzzle, face:jaw, face:chin, face:ear_base_left/right, and face:neck regions only when genuinely supported. Semantic facial sculpt requires connected bounded three-dimensional topology with at least 12 indexed vertices and eight editable faces; prefer a 24x16 sphere. A convertible native sphere is converted and sculpted in one atomic revision; an ineligible target fails with UNSUPPORTED_FEATURE and an actionable repair. Create flush patches, blush, irises, pupils, or catchlights through verified surface markings only when the actual material capability exists; spherical front +Z lies at U=0.25 and mirrored marks reflect around that actual axis using mod(0.5-U,1), never 1-U. Each semantic mark accepts exactly one explicit center or genuine leftEye, rightEye, nose, or mouth landmark. Unknown UV orientation fails before authoring unless markings.acknowledgeUnverifiedUv:true explicitly accepts that risk. Inspect genuine bounded markingFeedback, criticalWarnings, and advisories for tiny/subpixel or overlapping marks, periodic seam crossing, rear UV coverage, and profile-wrap risk; exact generated texels alone are not a rendered visibility preview and geometric footprints are estimates. When actual native directional WebGPU rendering and candidate authoring are both available, use read-only material_inspect:{entityId,markings,preview:{render:true,views:['front','right']}} for genuine owner-preserved front/profile frames of the uncommitted finish; this isolated-target preview cannot show surrounding-scene occlusion. Commit the accepted identical recipe atomically using material_create and entityIds. Avoid independently floating facial patch plates and catchlight spheres. Resolve ears, neck, shoulders, pelvis, relevant body transitions, intentional material seams, and consistent shared materials; inspect real front, three-quarter, strict profile, and back views. Floating, plate-like, detached, excessively protruding, likely depth-flickering, or unintentionally intersecting character features remain needs_more_work until corrected and genuinely recaptured. Review intentional lighting and restore an explicitly requested final visible camera view after owner-independent inspection. Preserve explicitly requested plush/toy seams and never claim unavailable painting, shrink-wrap, arbitrary semantic recognition, unavailable directional previews, automated aesthetic certification, or GPU depth/entity-ID buffers.",
  }),
  rendering: Object.freeze({
    title: "Physically based modeling and rendering controls",
    body: "Use the actual WebGPU renderer for a mandatory final visual critique. Apply a known friendly material name immediately; inspect the existing material sample library only when the requested finish is unclear. Reuse suitable materials and genuine baseColor, normal, metallic/roughness, emission, transmission, and procedural PNG maps. Camera guidance is enabled by default: use camera_guide when useful, immediately yielding to manual orbit, pan, zoom, or the user's explicit opt-out. Guidance changes only the temporary visible viewport pose; it never serializes the camera, advances scene revision, creates undo entries, triggers autosave, or persists. Only explicit camera_set intentionally authors and persists a scene-camera change. render_capture returns real presented WebGPU PNG/JPEG image bytes as base64 with mediaType, width, height, byteLength, and revision. render_contact_sheet composes three to five genuinely different, owner-preserving WebGPU viewpoints for complex assets and returns a quality-review checklist without pretending to certify subjective aesthetics. Any agent can save actual bytes with npm run webmcp -- capture --output /tmp/model.png. Inspect the real finish, lighting, and presentation polish; correct defects before declaring success. No Chrome-plugin screenshot, mock render, or automatic download is involved. Inspect actual images, critique, adjust, and capture again. Visible defects mean needs_more_work, never production_ready.",
  }),
  cli: Object.freeze({
    title: "Agent CLI drop-in WebMCP transport",
    body: "The bundled CLI is a transport-equivalent drop-in for native desktop WebMCP, not another scene API or application server. Any compatible agent can attach to the already-open https://codex-modeling-studio.openai.chatgpt.site page through loopback Chrome DevTools, default http://127.0.0.1:9222. Prefer genuine document.modelContext and navigator.modelContext getTools/executeTool discovery and invocation. Only if native invocation is unavailable, use window.__orielWebMcpPageTools.listTools(), describeTool(name), and executeTool(name,input); it delegates to the exact same registered WebMCP descriptors and observer lifecycle. Start immediately: npm run webmcp -- call part_add <JSON>; use a named shape and a friendly finish such as Brushed Aluminum. Other commands: npm run webmcp -- list; npm run webmcp -- describe part_add; npm run webmcp -- status; npm run webmcp -- instructions; npm run webmcp -- capture --output /tmp/model.png. Capture invokes the existing render_capture WebMCP tool, validates real PNG/JPEG base64 bytes and image metadata, and saves only the requested local file without a Chrome-plugin screenshot or browser download. Never reimplement scene mutations, create duplicate tool inventories, or bypass observer events.",
  }),
  observer: Object.freeze({
    title: "Observer experience and genuine asset handoff",
    body: "The human watches the requested agent-authored 3D model evolve in a neutral full-bleed workspace. Compatible desktop and CLI agents invoke the same registered WebMCP descriptors to inspect projects, import references or genuine models, author indexed geometry, adjust physically based materials and lighting, frame the camera, inspect real rendered frames, critique, and refine. Actual invocation events and committed revisions drive restrained follow-along feedback; fabricated progress never appears. Export tools prepare real individual or grouped GLB bytes in browser memory; only an explicit user action downloads them.",
  }),
});

const semanticFaceModelingGuidance = " Semantic part_feature sculpt accepts equivalent face.brow, face:brow, face_brow, and unambiguous bare brow selectors; face.cheek_left and face.muzzle likewise normalize to canonical face:cheek_left and face:muzzle. Face editing works on any connected bounded three-dimensional generated or imported editable mesh, or convertible native geometry, with sufficient actual topology, independently of its shape or subject; preserved imported surface attributes that cannot survive sculpting fail safely with UNSUPPORTED_FIDELITY. Existing genuine vehicle regions remain supported. Unknown face selectors report UNKNOWN_FACE_REGION; unrelated unknown selectors report UNKNOWN_SEMANTIC_REGION with model-neutral repair guidance and no scene mutation. For arbitrary subject-neutral spatial edits use mesh_apply_batch:{entityId,operations:[{op:'sculpt',center:[x,y,z],extents:[positiveX,positiveY,positiveZ],translation:[dx,dy,dz]}]} or the corresponding scene_apply_batch mesh_edit operation; never claim automatic recognition of arbitrary named features.";

const agentWorkflow = Object.freeze([
  Object.freeze({ stage: "inspect", goal: "Inspect existing authored work when the request needs context; otherwise begin the requested edit immediately. Scene, project, and material discovery are available on demand.",
    tools: Object.freeze(["status", "project_active", "project_list", "scene_get",
      "material_samples_list"]) }),
  Object.freeze({ stage: "references", goal: "Use genuinely available user-provided visual references to establish the requested form, proportions, style, and materials; never invent image-grounded comparison.",
    tools: Object.freeze(["reference_batch_begin", "reference_upload_begin",
      "reference_upload_chunk", "reference_upload_complete", "reference_list"]) }),
  Object.freeze({ stage: "import", goal: "When requested, import or inspect genuine GLB/glTF geometry, material assignments, textures, and hierarchy before converting supported assets to editable meshes.",
    tools: Object.freeze(["model_import_begin", "model_import_chunk",
      "model_import_inspect", "model_import_commit",
      "asset_convert_editable"]) }),
  Object.freeze({ stage: "model", goal: "Shape one coarse editable mesh into the requested silhouette and major proportions; develop continuous connected primary surfaces, existing lofts or sweeps, and real openings before details. Primitives are temporary scaffolding, never an assembly recipe. Preserve existing work and avoid an unsolicited floor.",
    tools: Object.freeze(["part_add", "parts_add", "part_edit",
      "part_duplicate", "part_repeat", "part_group",
      "part_feature", "part_remove", "part_convert",
      "part_boolean", "part_curve", "mesh_create",
      "mesh_inspect"]) }),
  Object.freeze({ stage: "sculpt", goal: "Refine actual selected topology coarse-to-fine while protecting available creases; use real per-edit symmetry or mirroring without claiming ongoing constraints, then inspect and revise weak forms.",
    tools: Object.freeze(["mesh_extrude", "mesh_inset", "mesh_bevel",
      "mesh_subdivide", "mesh_transform", "mesh_weld",
      "mesh_array_linear", "mesh_array_radial", "mesh_mirror",
      "mesh_loop_cut", "scene_preflight_batch", "mesh_apply_batch"]) }),
  Object.freeze({ stage: "materials", goal: "When materials matter, browse the complete compact preset catalog, reuse a suitable finish, or create a custom PBR material and upload verified texture maps.",
    tools: Object.freeze(["material_samples_list", "material_sample_inspect",
      "material_sample_apply", "material_set", "material_create",
      "material_upload_begin", "material_upload_chunk",
      "material_upload_commit"]) }),
  Object.freeze({ stage: "compose", goal: "Tune the requested model, scene hierarchy, physically based materials, and intentional lighting; transiently guide the actual visible viewport by default without revision, undo, autosave, or persistence, always respecting user opt-out and manual control.",
    tools: Object.freeze(["scene_preflight_batch", "scene_apply_batch", "material_set", "light_set",
      "camera_guide", "camera_set", "environment_set"]) }),
  Object.freeze({ stage: "capture", goal: "For every complex or hero asset, inspect at least three genuinely distinct owner-independent WebGPU viewpoints or a labeled contact sheet; preserve the user's camera and project, and keep needs_more_work whenever an actual image exposes a defect.",
    tools: Object.freeze(["camera_guide", "focus_target", "render_capture",
      "render_capture_batch", "render_contact_sheet", "render_frame_get"]) }),
  Object.freeze({ stage: "refine", goal: "Freely try geometry, materials, lighting, and composition; critique real rendered silhouette, proportions, topology, connected surfaces, actual openings, intersections, texture fidelity, and available reference fidelity; replace weak ideas, retry, and capture again until polished and presentation-ready. Require structural justification for disconnected decoration. Never claim production_ready while any substantive defect remains.",
    tools: Object.freeze(["mesh_inspect", "mesh_transform", "material_set",
      "material_sample_apply", "light_set", "camera_set",
      "environment_set", "scene_undo", "scene_redo",
      "render_capture"]) }),
  Object.freeze({ stage: "export", goal: "When requested, prepare the actual authored model or selected hierarchy as genuine individual or grouped browser-owned GLB bytes.",
    tools: Object.freeze(["asset_export_glb", "asset_export_group"]) }),
]);

const toolFamilies = Object.freeze({
  projects: Object.freeze(["project_active", "project_list",
    "project_create", "project_open", "project_acquire",
    "project_rename", "project_delete"]),
  references: Object.freeze(["reference_batch_begin",
    "reference_upload_begin", "reference_upload_chunk",
    "reference_upload_complete", "reference_list",
    "reference_select"]),
  import: Object.freeze(["model_import_begin", "model_import_chunk",
    "model_import_status", "model_import_inspect",
    "model_import_commit", "asset_convert_editable"]),
  modeling: Object.freeze(["part_add", "parts_add", "part_edit",
    "part_duplicate", "part_repeat", "part_group",
    "part_feature", "part_remove", "part_convert",
    "part_boolean", "part_curve", "mesh_create",
    "mesh_inspect", "mesh_extrude", "mesh_inset",
    "mesh_bevel", "mesh_subdivide", "mesh_transform",
    "mesh_weld", "mesh_array_linear", "mesh_array_radial",
    "mesh_mirror", "mesh_loop_cut", "scene_preflight_batch",
    "mesh_apply_batch"]),
  materials: Object.freeze(["material_inspect", "material_set",
    "material_samples_list", "material_sample_inspect",
    "material_sample_apply", "material_create",
    "material_upload_begin", "material_upload_chunk",
    "material_upload_status", "material_upload_commit",
    "material_upload_abort"]),
  scene: Object.freeze(["scene_get", "scene_undo", "scene_redo",
    "scene_apply_batch", "scene_preflight_batch", "light_set",
    "camera_set", "environment_set"]),
  inspection: Object.freeze(["camera_guide", "focus_target",
    "render_capture", "render_capture_batch",
    "render_contact_sheet", "render_frame_get"]),
  export: Object.freeze(["asset_export_glb", "asset_export_group",
    "asset_artifact_prepare", "asset_artifact_read_chunk",
    "asset_artifact_release", "scene_export"]),
  feedback: Object.freeze(["tooling_feedback_report"]),
});

/** Authored, overlapping classifications for the complete private tool inventory. */
export const STUDIO_TOOL_FAMILIES = Object.freeze({
  guidance: Object.freeze(["readInstructionsForCodex", "listDocs", "getDoc",
    "status"]),
  ...toolFamilies,
  references: Object.freeze([...toolFamilies.references,
    "reference_upload_abort", "reference_delete"]),
  import: Object.freeze([...toolFamilies.import, "model_import_abort"]),
});

function schemaAllowsValue(schema, value) {
  if (!schema || typeof schema !== "object") return false;
  if (Object.hasOwn(schema, "const")) return schema.const === value;
  if (Array.isArray(schema.enum)) return schema.enum.includes(value);
  return ["oneOf", "anyOf"].some((key) => Array.isArray(schema[key])
    && schema[key].some((candidate) => schemaAllowsValue(candidate, value)));
}

function actualFormFirstCapabilities(descriptors, inspectionCapabilities) {
  const available = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  const mutable = descriptors.filter(({ annotations }) => annotations.readOnlyHint === false);
  const hasProperty = (descriptor, name) =>
    Object.hasOwn(descriptor?.inputSchema?.properties ?? {}, name);
  const actualOrthography = Array.isArray(inspectionCapabilities?.projectionModes)
    && inspectionCapabilities.projectionModes.includes("orthographic")
    && ["render_capture_batch", "render_contact_sheet"]
      .some((name) => schemaAllowsValue(
        available.get(name)?.inputSchema?.properties?.views?.items?.properties?.projection,
        "orthographic",
      ));

  return {
    editableMeshes: available.has("mesh_inspect")
      && (available.has("mesh_transform") || available.has("mesh_apply_batch")),
    persistentControlCages: mutable.some((descriptor) =>
      hasProperty(descriptor, "controlCageId") || hasProperty(descriptor, "cageId")),
    editableCurveProfiles: mutable.some((descriptor) =>
      (hasProperty(descriptor, "curveId") || hasProperty(descriptor, "surfaceId"))
        && (hasProperty(descriptor, "profiles") || hasProperty(descriptor, "controlPoints"))),
    ongoingSymmetryConstraints: mutable.some((descriptor) =>
      hasProperty(descriptor, "symmetryConstraint") || hasProperty(descriptor, "constraintId")),
    perEditSymmetry: available.has("mesh_mirror")
      || hasProperty(available.get("part_feature"), "symmetryAxis"),
    creaseAwareSubdivision: hasProperty(available.get("mesh_subdivide"),
      "creaseAngleDegrees"),
    realOpenings: available.has("part_boolean"),
    referenceImages: available.has("reference_upload_complete")
      && available.has("reference_list"),
    referenceImageComparison: descriptors.some((descriptor) => {
      const diagnostics = descriptor?.inputSchema?.properties?.diagnostics?.properties;
      return hasProperty(descriptor, "referenceId")
        && (hasProperty(descriptor, "frameId") || hasProperty(descriptor, "views"))
        || hasProperty(descriptor, "views")
          && Object.hasOwn(diagnostics ?? {}, "referenceId")
          && schemaAllowsValue(diagnostics?.reference, true);
    }),
    ownerIndependentViews: available.has("render_capture_batch")
      || available.has("render_contact_sheet"),
    orthographicViews: actualOrthography,
  };
}

export class StudioToolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "StudioToolError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invalid(message, path = "input", details = undefined) {
  throw new StudioToolError("INVALID_ARGUMENT", `${path}: ${message}`, details);
}

function validateConstructiveOptions(input, path = "input") {
  const named = input.tool !== undefined || input.toolId !== undefined;
  const inline = input.cutter !== undefined;
  if (named === inline) {
    invalid("requires exactly one named tool or one ephemeral cutter", path);
  }
  if (inline && input.keepTool === true) {
    invalid("ephemeral cutters cannot be retained; omit keepTool or set it to false",
      `${path}.keepTool`);
  }
  if (inline && input.cutter.shape === "capsule") {
    validateEditableCapsuleDimensions(input.cutter, { path: `${path}.cutter` });
  }
  if (input.mirror !== undefined && (!inline || input.operation !== "difference")) {
    invalid("requires an ephemeral difference cutter", `${path}.mirror`);
  }
  if (input.operation === "blend") {
    if (input.keepTool === true) {
      invalid("must be false when blending joined surfaces", `${path}.keepTool`);
    }
    return;
  }
  for (const field of ["radius", "segments"]) {
    if (input[field] !== undefined) {
      invalid("requires operation blend", `${path}.${field}`);
    }
  }
}

function validateLatheProfile(profile, path) {
  for (const [index, point] of profile.entries()) {
    if (point[0] < 0) {
      invalid("lathe radius must be nonnegative in each [radius, signed height] point",
        `${path}[${index}][0]`, { field: `${path}[${index}][0]`,
          value: point[0], minimum: 0 });
    }
  }
}

function validateNamedPart(input, path = "input") {
  const shapeSpecificFields = {
    capSegments: ["capsule"],
    tubeSegments: ["torus"],
    heightSegments: ["sphere"],
    subdivisions: ["plane"],
    overhang: ["gable_roof", "hip_roof"],
    ridgeLength: ["hip_roof"],
    profile: ["lathe"],
    closed: ["lathe"],
    caps: ["lathe"],
    steps: ["stairs"],
    majorRadius: ["torus", "tire"],
    minorRadius: ["torus", "tire"],
  };
  for (const [field, supportedShapes] of Object.entries(shapeSpecificFields)) {
    if (input[field] !== undefined && !supportedShapes.includes(input.shape)) {
      invalid(`is unsupported for shape ${input.shape ?? "box"}; use ${supportedShapes.join(" or ")}`,
        `${path}.${field}`, { field: `${path}.${field}`,
          shape: input.shape ?? "box", supportedShapes });
    }
  }
  if (input.shape === "capsule") {
    const indexed = /^input\.parts\[(\d+)\]$/u.exec(path);
    validateEditableCapsuleDimensions(input, {
      route: "named",
      path,
      ...(indexed === null ? {} : { partIndex: Number(indexed[1]) }),
      ...(typeof input.name === "string" ? { partName: input.name }
        : typeof input.as === "string" ? { partName: input.as } : {}),
    });
  }
  if (input.shape === "sphere" && input.segments !== undefined
      && input.segments < 3) {
    invalid("sphere segments must be at least 3", `${path}.segments`,
      { field: `${path}.segments`, value: input.segments, minimum: 3 });
  }
  if (input.shape === "sphere" && input.radius !== undefined && input.size !== undefined) {
    const diameter = input.radius * 2;
    if (input.size.some((axis) =>
      Math.abs(axis - diameter) > 1e-9 * Math.max(1, Math.abs(axis), Math.abs(diameter)))) {
      invalid("conflicts with size; omit radius for an ellipsoid or match every size axis to twice the radius",
        `${path}.radius`, { field: `${path}.radius`, radius: input.radius,
          size: [...input.size] });
    }
  }
  if (input.shape !== "lathe") return;
  if (input.segments !== undefined
      && (input.segments < 3 || input.segments > 64)) {
    invalid("lathe segments must be between 3 and 64", `${path}.segments`,
      { field: `${path}.segments`, value: input.segments, minimum: 3, maximum: 64 });
  }
  if (input.profile !== undefined) validateLatheProfile(input.profile, `${path}.profile`);
}

function validateMeshOperation(input, path = "input") {
  const operation = input.op === "mesh_edit" ? input.operation : input.op;
  if (operation === "transform" && input.rotate !== undefined
      && input.rotationDegrees !== undefined) {
    invalid("conflicts with rotate; specify radians or rotationDegrees, not both",
      `${path}.rotationDegrees`);
  }
  if (operation === "arrayRadial" && input.angle !== undefined
      && input.angleDegrees !== undefined) {
    invalid("conflicts with angle; specify radians or angleDegrees, not both",
      `${path}.angleDegrees`);
  }
  if (operation === "sculpt") {
    if (input.translation.every((coordinate) => coordinate === 0)) {
      invalid("sculpt translation must be nonzero", `${path}.translation`);
    }
    if (input.symmetryOffset !== undefined && input.symmetryAxis === undefined) {
      invalid("requires symmetryAxis", `${path}.symmetryOffset`);
    }
  }
  if (operation === "subdivide" && input.smooth !== true) {
    for (const field of ["strength", "creaseAngleDegrees"]) {
      if (input[field] !== undefined) {
        invalid("requires smooth: true", `${path}.${field}`);
      }
    }
  }
}

function validateSceneOperation(input, path) {
  if (input.op === "add_primitive" && input.segments !== undefined
      && input.shape !== "beveledBox") {
    invalid(`native ${input.shape} cannot control tessellation; use an editable mesh_create primitive`,
      `${path}.segments`, { field: `${path}.segments`, value: input.segments,
        shape: input.shape, supportedShapes: ["beveledBox"],
        suggestedOperation: "mesh_create",
        repair: "Use mesh_create with genuine supported primitive resolution controls." });
  }
  if (input.op === "add_primitive" && input.size !== undefined
      && (input.shape === "capsule" || input.shape === "cylinder")) {
    if (input.size.length !== 3) {
      invalid("requires exact [diameter, totalHeight, diameter] dimensions",
        `${path}.size`, { field: `${path}.size`, shape: input.shape,
          repair: "Use size:[diameter,totalHeight,diameter]." });
    }
    const [width, totalHeight, depth] = input.size;
    const equal = (left, right) => Math.abs(left - right)
      <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
    if (!equal(width, depth)) {
      invalid("requires equal width and depth; native radial geometry cannot honor anisotropic size",
        `${path}.size`, { field: `${path}.size`, shape: input.shape,
          repair: "Use matching size[0] and size[2], or create an editable scaled mesh." });
    }
    if (input.shape === "capsule" && !(totalHeight > width)) {
      invalid("capsule total height must strictly exceed its diameter",
        `${path}.size`, { field: `${path}.size`, shape: input.shape,
          repair: "Use size:[diameter,totalHeight,diameter] with totalHeight > diameter." });
    }
    const radius = width / 2;
    const sectionHeight = input.shape === "capsule" ? totalHeight - width : totalHeight;
    if (input.radius !== undefined && !equal(input.radius, radius)) {
      invalid("conflicts with size diameter; specify a matching radius or omit radius",
        `${path}.radius`, { field: `${path}.radius`, value: input.radius,
          suggestedValue: radius,
          repair: `Set radius to ${radius}, or omit it and derive the actual size diameter.` });
    }
    if (input.height !== undefined && !equal(input.height, sectionHeight)) {
      invalid(input.shape === "capsule"
        ? "conflicts with size; native capsule height is its cylindrical section"
        : "conflicts with size height", `${path}.height`,
      { field: `${path}.height`, value: input.height,
        suggestedValue: sectionHeight,
        repair: input.shape === "capsule"
          ? `Set native cylindrical-section height to ${sectionHeight}, or omit it and derive size total height.`
          : `Set height to ${sectionHeight}, or omit it and derive size height.` });
    }
  }
  if (input.op === "mesh_create" && input.primitive.kind === "capsule") {
    validateEditableCapsuleDimensions(input.primitive, {
      path: `${path}.primitive`,
    });
  }
  if (input.op === "mesh_create" && input.primitive.kind === "lathe") {
    validateLatheProfile(input.primitive.profile, `${path}.primitive.profile`);
  }
  if (input.op === "mesh_edit") validateMeshOperation(input, path);
  if (input.op === "mesh_edit_batch") {
    for (const [index, operation] of input.operationSpecs.entries()) {
      validateMeshOperation(operation, `${path}.operationSpecs[${index}]`);
    }
  }
}

function isPlainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("must be an object", path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid("must be a plain JSON object", path);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string"
    || DANGEROUS_KEYS.has(key)
    || descriptors[key].enumerable !== true
    || !("value" in descriptors[key]))) {
    invalid("must contain only safe enumerable JSON data properties", path);
  }
  return Object.keys(descriptors);
}

function comparable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(comparable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${comparable(value[key])}`).join(",")}}`;
}

function safeOwnValue(value, field) {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value : undefined;
}

function variantFailureScore(value, variant, error) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return 0;
  const fields = variant.properties ?? {};
  let score = 0;
  for (const field of ["op", "kind", "component", "mode"]) {
    const selected = safeOwnValue(value, field);
    const expected = fields[field];
    if (selected === undefined || expected === undefined) continue;
    if (Object.hasOwn(expected, "const")) {
      score += Object.is(selected, expected.const) ? 1_000 : -1_000;
    } else if (expected.enum) {
      score += expected.enum.some((candidate) => Object.is(selected, candidate))
        ? 250 : -250;
    }
  }
  for (const field of Reflect.ownKeys(Object.getOwnPropertyDescriptors(value))) {
    if (typeof field === "string" && Object.hasOwn(fields, field)) score += 10;
  }
  const failedPath = error?.details?.field
    ?? String(error?.message ?? "").split(":", 1)[0];
  score += (failedPath.match(/[.[]/gu) ?? []).length;
  return score;
}

function validateSchema(value, schema, path) {
  if (schema === false) invalid("is not supported in this operation mode", path);
  if (schema === true) return;
  if (schema.oneOf) {
    let valid = 0;
    let reason;
    let bestScore = -Infinity;
    for (const variant of schema.oneOf) {
      try {
        validateSchema(value, variant, path);
        valid += 1;
      } catch (error) {
        const score = variantFailureScore(value, variant, error);
        if (score > bestScore) {
          bestScore = score;
          reason = error;
        }
      }
    }
    if (valid !== 1) {
      if (valid === 0 && reason) throw reason;
      invalid("must match exactly one supported shape", path);
    }
  }
  if (schema.anyOf) {
    let matched = false;
    let reason;
    for (const variant of schema.anyOf) {
      try {
        validateSchema(value, variant, path);
        matched = true;
        break;
      } catch (error) {
        reason = error;
      }
    }
    if (!matched) throw reason ?? new StudioToolError("INVALID_ARGUMENT",
      `${path}: does not match an accepted value`);
  }
  if (Object.hasOwn(schema, "const") && !Object.is(value, schema.const)) {
    invalid(`${JSON.stringify(value)} must equal ${JSON.stringify(schema.const)}`,
      path, { field: path, value });
  }
  if (schema.enum && !schema.enum.some((option) => Object.is(value, option))) {
    invalid(`${JSON.stringify(value)} must be one of ${schema.enum.join(", ")}`,
      path, { field: path, value });
  }
  if (!schema.type && (schema.properties !== undefined || schema.required !== undefined)) {
    const keys = isPlainObject(value, path);
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) invalid(`requires ${key}`, path);
    }
    for (const key of keys) {
      if (Object.hasOwn(schema.properties ?? {}, key)) {
        validateSchema(value[key], schema.properties[key], `${path}.${key}`);
      }
    }
    return;
  }
  if (!schema.type) return;
  if (schema.type === "null") {
    if (value !== null) invalid("must be null", path);
    return;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") invalid("must be a boolean", path);
    return;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)
      || Math.abs(value) > MAX_SAFE_NUMBER
      || schema.type === "integer" && !Number.isSafeInteger(value)) {
      invalid(`must be a finite ${schema.type}`, path);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      invalid(`${value} must be at least ${schema.minimum}`, path,
        { field: path, value, minimum: schema.minimum });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      invalid(`${value} must be at most ${schema.maximum}`, path,
        { field: path, value, maximum: schema.maximum });
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      invalid(`${value} must be greater than ${schema.exclusiveMinimum}`, path,
        { field: path, value, minExclusive: schema.exclusiveMinimum });
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      invalid(`${value} must be less than ${schema.exclusiveMaximum}`, path,
        { field: path, value, maxExclusive: schema.exclusiveMaximum });
    }
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") invalid("must be a string", path);
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      invalid(`must contain at least ${schema.minLength} characters`, path);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      invalid(`must contain at most ${schema.maxLength} characters`, path);
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      invalid("has an unsupported format", path);
    }
    if (/\p{Cs}/u.test(value)) invalid("must not contain unpaired surrogates", path);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) invalid("must be an array", path);
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      invalid(`must contain at least ${schema.minItems} items`, path);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      invalid(`must contain at most ${schema.maxItems} items`, path);
    }
    const keys = Reflect.ownKeys(Object.getOwnPropertyDescriptors(value));
    if (keys.some((key) => key !== "length"
      && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)
        || Number(key) >= value.length))) {
      invalid("must not contain extra properties", path);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)
        || descriptor.enumerable !== true) {
        invalid("must contain only dense JSON data entries", path);
      }
      validateSchema(descriptor.value, schema.items ?? {}, `${path}[${index}]`);
    }
    if (schema.uniqueItems) {
      const unique = new Set(value.map(comparable));
      if (unique.size !== value.length) invalid("must not contain duplicate items", path);
    }
    return;
  }
  if (schema.type !== "object") invalid("uses an unsupported schema type", path);
  const keys = isPlainObject(value, path);
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) invalid(`requires ${key}`, path);
  }
  if (schema.additionalProperties === false) {
    for (const key of keys) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) {
        invalid(`does not support property ${key}`, path,
          { field: `${path}.${key}`, value: safeOwnValue(value, key) });
      }
    }
  }
  if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
    invalid(`must contain at least ${schema.minProperties} properties`, path);
  }
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
    invalid(`must contain at most ${schema.maxProperties} properties`, path);
  }
  for (const key of keys) {
    if (!Object.hasOwn(schema.properties ?? {}, key)) {
      continue;
    }
    validateSchema(value[key], schema.properties[key], `${path}.${key}`);
  }
}

export function validateStudioToolInput(value, schema) {
  validateSchema(value, schema, "input");
  return value;
}

function aborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  if (typeof DOMException === "function") {
    throw new DOMException("The WebMCP tool invocation was canceled.", "AbortError");
  }
  throw new StudioToolError("ABORTED", "The WebMCP tool invocation was canceled.");
}

function invocationSignal(context) {
  if (!context || typeof context !== "object") return undefined;
  if (Object.hasOwn(context, "signal")) return context.signal;
  return typeof context.aborted === "boolean" ? context : undefined;
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function base64(bytes) {
  if (typeof btoa === "function") {
    let result = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      result += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(result);
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    result += alphabet[first >> 2];
    result += alphabet[(first & 3) << 4 | second >> 4];
    result += index + 1 < bytes.length ? alphabet[(second & 15) << 2 | third >> 6] : "=";
    result += index + 2 < bytes.length ? alphabet[third & 63] : "=";
  }
  return result;
}

function state(store) {
  const cheapCheckpoint = typeof store.getInspectionCheckpoint === "function"
    && typeof store.getInventory === "function";
  const current = cheapCheckpoint
    ? { ...store.getInspectionCheckpoint(), ...store.getInventory() }
    : typeof store.getState === "function" ? store.getState() : {};
  return {
    ...current,
    revision: typeof store.getRevision === "function"
      ? store.getRevision() : current.revision,
    selection: typeof store.getSelection === "function"
      ? store.getSelection() : current.selection ?? null,
  };
}

function sceneInventory(store, current = state(store), suppliedScene = undefined) {
  const hasEntityCount = Number.isSafeInteger(current.entityCount);
  const hasModeledAssetCount = Number.isSafeInteger(current.modeledAssetCount);
  const scene = suppliedScene ?? (hasEntityCount && hasModeledAssetCount
    ? undefined : current.scene ?? store.getScene());
  const entities = scene === undefined ? undefined : Object.values(scene.entities ?? {});
  const inventory = {
    entityCount: hasEntityCount ? current.entityCount : entities.length,
    modeledAssetCount: hasModeledAssetCount ? current.modeledAssetCount
      : entities.filter((entity) =>
        entity?.components?.["oriel.mesh_modeling"] !== undefined).length,
  };
  if (Number.isSafeInteger(current.assetCount) && current.assetCount >= 0) {
    inventory.assetCount = current.assetCount;
  } else if (typeof store.listAssets === "function") {
    inventory.assetCount = store.listAssets().length;
  }
  for (const field of ["textureAssetCount", "materialSampleCount", "customMaterialCount",
    "materialAssignmentCount", "uniqueMaterialAssetCount",
    "proceduralMaterialAssignmentCount", "uniqueProceduralMaterialAssetCount",
    "uniqueMaterialPresetCount", "availableMaterialPresetCount"]) {
    if (Number.isSafeInteger(current[field]) && current[field] >= 0) {
      inventory[field] = current[field];
    }
  }
  return inventory;
}

function runtimeStatus(runtime) {
  return typeof runtime?.status === "function" ? runtime.status()
    : { ready: false, backend: "webgpu" };
}

function summarizeMutation(result, store) {
  if (!result || typeof result !== "object") {
    return { revision: state(store).revision, value: result ?? null };
  }
  const current = state(store);
  const operation = result.results?.length === 1
    && result.results[0] && typeof result.results[0] === "object"
    ? result.results[0] : {};
  const compactCageReceipt = typeof (result.cageId ?? operation.cageId) === "string";
  const output = {
    revision: result.revision ?? current.revision,
    selection: result.selection ?? current.selection,
    ...sceneInventory(store, current),
  };
  for (const field of ["entityId", "path", "contentDigest", "snapshotId",
    "sceneSourceHash", "assetManifestHash", "vertexCount", "faceCount",
    "triangleCount", "renderVertexCount", "operationCount", "bounds",
    "windingCorrected", "correctedComponentCount", "correctedFaceCount",
    "sampleId", "category", "material", "assetPaths", "texturePaths",
    "textureAssetCount", "materialSampleCount", "customMaterialCount", "materialAssignmentCount",
    "uniqueMaterialAssetCount", "proceduralMaterialAssignmentCount",
    "uniqueProceduralMaterialAssetCount", "uniqueMaterialPresetCount",
    "availableMaterialPresetCount", "materialHandle", "materialId", "name", "maps",
    "mapCount", "affectedEntityIds", "affectedEntityCount", "operations", "cageId",
    "curveId", ...(compactCageReceipt ? [] : ["controlVertexIds", "controlSelection",
      "affectedVertices", "protectedVertices", "weights"]),
    "levels", "scheme", "bridge", "controlPoints",
    "correspondence", "continuity", "baked", "controlCagePreserved",
    "constructiveStageCount", "uvMapping", "changedBounds",
    "controlVertexCount", "affectedVertexCount", "affectedControlVertexCount",
    "protectedVertexCount", "selectedVertexCount", "selectedEdgeCount",
    "selectedFaceCount", "selectionMode"] ) {
    if (result[field] !== undefined) output[field] = result[field];
    else if (operation[field] !== undefined) output[field] = operation[field];
  }
  const starterStatus = result.starterStatus ?? operation.starterStatus;
  if (starterStatus && typeof starterStatus === "object"
      && ["removed", "retained"].includes(starterStatus.status)
      && typeof starterStatus.entityId === "string"
      && new RegExp(UUID_PATTERN, "u").test(starterStatus.entityId)) {
    output.starterStatus = { status: starterStatus.status,
      entityId: starterStatus.entityId };
  }
  const markingFeedback = result.markingFeedback ?? operation.markingFeedback;
  if (markingFeedback?.format === "oriel.material-marking-feedback/1"
      && Array.isArray(markingFeedback.marks) && markingFeedback.marks.length <= 64
      && Array.isArray(markingFeedback.warnings) && markingFeedback.warnings.length <= 64
      && Array.isArray(markingFeedback.targets) && markingFeedback.targets.length <= 4
      && new TextEncoder().encode(JSON.stringify(markingFeedback)).byteLength <= 32 * 1024) {
    output.markingFeedback = markingFeedback;
  }
  if (compactCageReceipt) {
    const arrayCount = (field, countField) => {
      const value = result[field] ?? operation[field];
      if (Array.isArray(value) && output[countField] === undefined) {
        output[countField] = value.length;
      }
    };
    arrayCount("controlVertexIds", "controlVertexCount");
    arrayCount("affectedVertices", "affectedVertexCount");
    arrayCount("protectedVertices", "protectedVertexCount");
    const selected = result.controlSelection ?? operation.controlSelection;
    if (selected && typeof selected === "object") {
      if (typeof selected.mode === "string" && output.selectionMode === undefined) {
        output.selectionMode = selected.mode;
      }
      for (const [fields, countField] of [
        [["vertexIds", "vertices", "controlIds"], "selectedVertexCount"],
        [["edges"], "selectedEdgeCount"],
        [["faceIds", "faces"], "selectedFaceCount"],
      ]) {
        const values = fields.map((field) => selected[field]).find(Array.isArray);
        if (values !== undefined && output[countField] === undefined) {
          output[countField] = values.length;
        }
      }
    }
  } else if (Array.isArray(result.results)) {
    output.results = result.results;
  }
  return output;
}

function entityResult(store, input) {
  const scene = store.getScene();
  const current = state(store);
  const entries = Object.entries(scene.entities ?? {});
  const selected = input.entityId
    ? entries.filter(([entityId]) => entityId === input.entityId)
    : entries.sort(([left], [right]) => left.localeCompare(right));
  if (input.entityId && selected.length === 0) {
    throw new StudioToolError("NOT_FOUND", `Scene entity ${input.entityId} does not exist.`);
  }
  const limit = input.maxEntities ?? 32;
  const entities = Object.fromEntries(selected.slice(0, limit).map(([id, entity]) => [id,
    input.includeComponents === false
      ? { name: entity.name, parent: entity.parent, components: Object.keys(entity.components ?? {}) }
      : entity]));
  return {
    revision: current.revision,
    selection: current.selection,
    ...sceneInventory(store, current, scene),
    returnedEntityCount: Object.keys(entities).length,
    truncated: selected.length > limit,
    scene: {
      format: scene.format,
      assetId: scene.assetId,
      name: scene.name,
      entities,
    },
  };
}

function meshInspection(store, input) {
  const result = store.inspectMesh(input.entityId);
  const { topology, ...summary } = result;
  const maxVertices = input.maxVertices ?? 128;
  const maxFaces = input.maxFaces ?? 128;
  const output = { ...summary };
  if (input.includeTopology && topology) {
    output.topology = {
      vertices: topology.vertices?.slice(0, maxVertices) ?? [],
      faces: topology.faces?.slice(0, maxFaces) ?? [],
      truncated: (topology.vertices?.length ?? 0) > maxVertices
        || (topology.faces?.length ?? 0) > maxFaces,
    };
  }
  if (input.includeControls === true) {
    if (typeof store.inspectModelingState !== "function") {
      throw new StudioToolError("CAPABILITY_UNAVAILABLE",
        "The active project cannot inspect durable modeling controls.");
    }
    const controls = store.inspectModelingState(input.entityId);
    if (controls !== undefined) {
      output.controls = controls;
      if (controls.cage !== undefined) {
        const cage = controls.cage;
        const coarse = cage.topology;
        output.controls = { ...output.controls, cage: { ...cage,
          topology: coarse === undefined ? undefined : { ...coarse,
            vertices: coarse.vertices?.slice(0, maxVertices) ?? [],
            faces: coarse.faces?.slice(0, maxFaces) ?? [],
            truncated: (coarse.vertices?.length ?? 0) > maxVertices
              || (coarse.faces?.length ?? 0) > maxFaces },
          ...(cage.vertexIds === undefined ? {} : {
            vertexIds: cage.vertexIds.slice(0, maxVertices) }),
          ...(cage.faceIds === undefined ? {} : {
            faceIds: cage.faceIds.slice(0, maxFaces) }),
          ...(cage.edgeCreases === undefined ? {} : {
            edgeCreases: cage.edgeCreases.slice(0, maxVertices) }),
          ...(cage.cornerCreases === undefined ? {} : {
            cornerCreases: cage.cornerCreases.slice(0, maxVertices) }),
        } };
        output.cageId = input.entityId;
      }
      if (controls.curve !== undefined) output.curveId = input.entityId;
      if (controls.symmetry !== undefined) {
        const symmetry = controls.symmetry;
        output.controls = { ...output.controls, symmetry: { ...symmetry,
          ...(symmetry.pairs === undefined ? {} : {
            pairs: symmetry.pairs.slice(0, maxVertices) }),
          ...(symmetry.seam === undefined ? {} : {
            seam: symmetry.seam.slice(0, maxVertices) }),
        } };
      }
    }
  }
  return output;
}

function withoutControlFields(input) {
  const { expectedRevision, entityId, ...patch } = input;
  return patch;
}

function mutationOptions(input, signal) {
  return {
    ...(input.expectedRevision === undefined ? {} : {
      expectedRevision: input.expectedRevision,
    }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function exportArtifact(artifact, { onExport, inline, signal }) {
  aborted(signal);
  if (!artifact || typeof artifact !== "object") {
    throw new StudioToolError("INTERNAL", "The browser scene store did not return an export artifact.");
  }
  const bytes = bytesFrom(artifact.bytes);
  if (!bytes) throw new StudioToolError("INTERNAL", "The export artifact does not contain valid bytes.");
  if (typeof onExport === "function") onExport({ ...artifact, bytes });
  const result = {
    fileName: artifact.fileName ?? artifact.path?.split("/").at(-1),
    mediaType: artifact.mediaType ?? "application/json",
    byteLength: bytes.byteLength,
    browserDownloadAvailable: typeof onExport === "function",
    ...(artifact.entityId === undefined ? {} : { entityId: artifact.entityId }),
    ...(artifact.path === undefined ? {} : { path: artifact.path }),
    ...(artifact.contentDigest === undefined ? {} : {
      contentDigest: artifact.contentDigest,
    }),
  };
  if (inline && bytes.byteLength <= MAX_INLINE_ARTIFACT_BYTES) {
    result.base64 = base64(bytes);
  } else if (inline) {
    result.inlineOmitted = true;
    result.maxInlineBytes = MAX_INLINE_ARTIFACT_BYTES;
  }
  return result;
}

const emptySchema = closedObject({});
const expectedRevisionField = Object.freeze({ expectedRevision: revision() });

function meshEditSchema(fields, required = [], extra = {}) {
  return closedObject({
    entityId: identifier(),
    ...fields,
    ...expectedRevisionField,
  }, ["entityId", ...required], extra);
}

const activityOperations = Object.freeze({
  readInstructionsForCodex: "agent.instructions",
  listDocs: "agent.documentation.list",
  getDoc: "agent.documentation.read",
  status: "scene.status",
  project_active: "project.active",
  project_list: "project.list",
  project_create: "project.create",
  project_open: "project.open",
  project_acquire: "project.acquire",
  project_rename: "project.rename",
  project_delete: "project.delete",
  scene_get: "scene.inspect",
  scene_undo: "scene.undo",
  scene_redo: "scene.redo",
  scene_apply_batch: "scene.batch",
  scene_preflight_batch: "scene.preflight",
  mesh_create: "mesh.create",
  mesh_inspect: "mesh.inspect",
  mesh_extrude: "mesh.extrude",
  mesh_inset: "mesh.inset",
  mesh_bevel: "mesh.bevel",
  mesh_subdivide: "mesh.subdivide",
  mesh_transform: "mesh.transform",
  mesh_weld: "mesh.weld",
  mesh_array_linear: "mesh.array.linear",
  mesh_array_radial: "mesh.array.radial",
  mesh_mirror: "mesh.mirror",
  mesh_loop_cut: "mesh.loop.cut",
  mesh_apply_batch: "mesh.batch",
  material_set: "material.set",
  material_samples_list: "material.samples.list",
  material_sample_inspect: "material.sample.inspect",
  material_sample_apply: "material.sample.apply",
  light_set: "light.set",
  camera_set: "camera.set",
  camera_guide: "camera.guide.visible",
  environment_set: "environment.set",
  focus_target: "camera.focus.target",
  render_capture: "render.capture",
  render_capture_batch: "render.capture.batch",
  render_contact_sheet: "render.contact.sheet",
  render_frame_get: "render.frame.inspect",
  asset_export_glb: "asset.export.glb",
  asset_export_group: "asset.export.group",
  material_inspect: "material.inspect",
  model_import_begin: "model.import.begin",
  model_import_chunk: "model.import.chunk",
  model_import_status: "model.import.status",
  model_import_inspect: "model.import.inspect",
  model_import_commit: "model.import.commit",
  model_import_abort: "model.import.abort",
  asset_convert_editable: "asset.convert.editable",
  asset_artifact_prepare: "asset.artifact.prepare",
  asset_artifact_read_chunk: "asset.artifact.read.chunk",
  asset_artifact_release: "asset.artifact.release",
  material_create: "material.custom.create",
  material_upload_begin: "material.upload.begin",
  material_upload_chunk: "material.upload.chunk",
  material_upload_status: "material.upload.status",
  material_upload_commit: "material.upload.commit",
  material_upload_abort: "material.upload.abort",
  part_add: "part.add",
  parts_add: "part.add.bounded",
  part_edit: "part.edit",
  part_duplicate: "part.duplicate",
  part_repeat: "part.repeat",
  part_group: "part.group",
  part_feature: "part.feature",
  part_remove: "part.remove",
  part_convert: "part.convert.editable",
  part_boolean: "part.boolean",
  part_curve: "part.curve",
  scene_export: "scene.export",
  reference_batch_begin: "reference.batch.begin",
  reference_upload_begin: "reference.upload.begin",
  reference_upload_chunk: "reference.upload.chunk",
  reference_upload_complete: "reference.upload.complete",
  reference_upload_abort: "reference.upload.abort",
  reference_list: "reference.list",
  reference_select: "reference.select",
  reference_delete: "reference.delete",
});

const activityLabels = Object.freeze({
  readInstructionsForCodex: ["Reading agent instructions", "Agent modeling workflow loaded"],
  listDocs: ["Listing modeling agent references", "Agent references listed"],
  getDoc: ["Reading modeling agent reference", "Agent authoring reference loaded"],
  status: ["Inspecting WebGPU renderer and scene", "Genuine renderer status inspected"],
  project_active: ["Inspecting the active modeling project", "Active modeling project inspected"],
  project_list: ["Listing saved modeling projects", "Saved modeling projects listed"],
  project_create: ["Creating a modeling project", "New modeling project created"],
  project_open: ["Opening a saved modeling project", "Saved modeling project opened"],
  project_acquire: ["Acquiring project editing access", "Project editing access acquired"],
  project_rename: ["Renaming a modeling project", "Modeling project renamed"],
  project_delete: ["Deleting the confirmed modeling project", "Confirmed modeling project deleted"],
  scene_get: ["Inspecting authored scene", "Authored scene inspected"],
  scene_undo: ["Undoing an authored modeling experiment", "Authored modeling experiment undone"],
  scene_redo: ["Redoing an authored modeling experiment", "Authored modeling experiment restored"],
  scene_apply_batch: ["Applying authored scene operations", "Authored scene operations committed"],
  scene_preflight_batch: ["Validating atomic scene or mesh operations", "Atomic scene or mesh operations validated"],
  mesh_create: ["Creating editable modeled mesh", "Editable modeled mesh created"],
  mesh_inspect: ["Inspecting genuine mesh topology", "Genuine mesh topology inspected"],
  mesh_extrude: ["Extruding selected mesh faces", "Selected mesh faces extruded"],
  mesh_inset: ["Insetting selected mesh faces", "Selected mesh faces inset"],
  mesh_bevel: ["Beveling selected mesh edges", "Selected mesh edges beveled"],
  mesh_subdivide: ["Subdividing mesh topology", "Mesh topology subdivided"],
  mesh_transform: ["Transforming mesh vertices", "Mesh vertices transformed"],
  mesh_weld: ["Welding adjacent mesh vertices", "Adjacent mesh vertices welded"],
  mesh_array_linear: ["Repeating genuine mesh geometry", "Linear mesh array committed"],
  mesh_array_radial: ["Repeating mesh geometry around an axis", "Radial mesh array committed"],
  mesh_mirror: ["Mirroring actual indexed geometry", "Mirrored mesh geometry committed"],
  mesh_loop_cut: ["Cutting an actual topology loop", "Mesh loop cut committed"],
  mesh_apply_batch: ["Applying atomic modeling operations", "Atomic modeling operations committed"],
  material_set: ["Refining physically based material", "Physically based material refined"],
  material_samples_list: ["Listing real procedural material samples", "Procedural material samples listed"],
  material_sample_inspect: ["Inspecting procedural PBR material", "Procedural PBR material inspected"],
  material_sample_apply: ["Generating actual procedural PBR textures", "Procedural textured material committed"],
  light_set: ["Refining actual scene lighting", "Actual scene lighting refined"],
  camera_set: ["Refining rendered camera composition", "Rendered camera composition refined"],
  camera_guide: ["Guiding your visible camera to the current work", "Visible modeling camera guided to the actual subject"],
  environment_set: ["Adjusting visible daylight", "Visible daylight adjusted"],
  focus_target: ["Framing genuine world-space target bounds", "Actual modeling target framed"],
  render_capture: ["Capturing presented WebGPU frame", "Genuine WebGPU frame captured"],
  render_capture_batch: ["Capturing genuine isolated WebGPU viewpoints", "Owner-preserving WebGPU view batch captured"],
  render_contact_sheet: ["Capturing genuine labeled modeling viewpoints", "Polished owner-preserving image contact sheet composed"],
  render_frame_get: ["Reading actual bounded inspection image", "Genuine WebGPU inspection image retrieved"],
  asset_export_glb: ["Preparing genuine modeled GLB", "Genuine modeled GLB prepared"],
  asset_export_group: ["Preparing genuine grouped scene GLB", "Grouped modeled GLB prepared"],
  material_inspect: ["Inspecting actual imported PBR material", "Actual imported PBR material inspected"],
  model_import_begin: ["Beginning bounded model dependency import", "Model dependency import initialized"],
  model_import_chunk: ["Uploading bounded actual model bytes", "Model dependency bytes accepted"],
  model_import_status: ["Inspecting bounded model upload", "Model upload status inspected"],
  model_import_inspect: ["Inspecting genuine model dependencies", "Genuine model dependencies inspected"],
  model_import_commit: ["Committing actual editable model", "Actual editable model committed"],
  model_import_abort: ["Aborting browser-local model upload", "Browser-local model upload aborted"],
  asset_convert_editable: ["Converting actual model asset to editable geometry", "Model asset converted to editable geometry"],
  asset_artifact_prepare: ["Retaining actual grouped GLB export", "Actual grouped GLB export retained"],
  asset_artifact_read_chunk: ["Reading bounded actual GLB export bytes", "Actual GLB export chunk read"],
  asset_artifact_release: ["Releasing private browser GLB export", "Private browser GLB export released"],
  material_create: ["Creating a genuine custom PBR material", "Custom PBR material registered"],
  material_upload_begin: ["Preparing verified material texture upload", "Material texture upload prepared"],
  material_upload_chunk: ["Uploading genuine material texture bytes", "Material texture bytes uploaded"],
  material_upload_status: ["Inspecting material texture upload", "Material texture upload inspected"],
  material_upload_commit: ["Registering verified textured PBR material", "Verified textured PBR material registered"],
  material_upload_abort: ["Aborting material texture upload", "Material texture upload safely discarded"],
  part_add: ["Adding an editable modeling part", "Editable modeling part added"],
  parts_add: ["Adding a small group of modeling parts", "Modeling part group added"],
  part_edit: ["Refining a named modeling part", "Named modeling part refined"],
  part_duplicate: ["Duplicating an editable modeling part", "Independent modeling part duplicated"],
  part_repeat: ["Repeating independent modeling parts", "Independent modeling pattern added"],
  part_group: ["Grouping named modeling parts", "Named modeling parts grouped"],
  part_feature: ["Refining a semantic modeling feature", "Semantic modeling feature refined"],
  part_remove: ["Removing the selected modeling part", "Selected modeling part removed"],
  part_convert: ["Converting a primitive to editable geometry", "Primitive converted to editable geometry"],
  part_boolean: ["Combining actual modeled solid geometry", "Constructive modeled geometry committed"],
  part_curve: ["Creating actual curved modeled geometry", "Curved modeled geometry created"],
  scene_export: ["Preparing authored scene export", "Authored scene export prepared"],
  reference_batch_begin: ["Beginning bounded reference-image batch", "Reference-image batch initialized"],
  reference_upload_begin: ["Beginning real reference-image upload", "Reference-image upload initialized"],
  reference_upload_chunk: ["Uploading bounded reference-image bytes", "Reference-image bytes accepted"],
  reference_upload_complete: ["Verifying actual reference-image digest", "Reference image verified and available"],
  reference_upload_abort: ["Aborting reference-image upload", "Reference-image upload aborted"],
  reference_list: ["Inspecting actual reference images", "Reference-image inventory inspected"],
  reference_select: ["Selecting actual reference image", "Reference image selected"],
  reference_delete: ["Removing actual reference image", "Reference image removed"],
});

function activityState(store) {
  try {
    const current = {};
    const cheapCheckpoint = typeof store.getInspectionCheckpoint === "function"
      && typeof store.getInventory === "function";
    const snapshot = cheapCheckpoint
      ? { ...store.getInspectionCheckpoint(), ...store.getInventory() }
      : typeof store.getState === "function" ? store.getState() : {};
    const revision = typeof store.getRevision === "function"
      ? store.getRevision() : snapshot.revision;
    const selection = typeof store.getSelection === "function"
      ? store.getSelection() : snapshot.selection;
    if (Number.isSafeInteger(revision) && revision >= 0) current.revision = revision;
    if (typeof selection === "string" || selection === null) {
      current.selection = selection;
    }
    if (Number.isSafeInteger(snapshot.entityCount)) {
      current.entityCount = snapshot.entityCount;
    } else if (snapshot.scene?.entities) {
      current.entityCount = Object.keys(snapshot.scene.entities).length;
    }
    if (Number.isSafeInteger(snapshot.assetCount)) {
      current.assetCount = snapshot.assetCount;
    } else if (typeof store.listAssets === "function") {
      current.assetCount = store.listAssets().length;
    }
    return current;
  } catch {
    return {};
  }
}

function activityInput(input) {
  const summary = {};
  for (const field of ["entityId", "name", "expectedRevision", "distance",
    "amount", "depth", "levels", "phaseHours", "format", "inline", "sampleId",
    "category", "referenceId", "batchId", "uploadId", "frameId", "count", "index",
    "offset", "byteLength", "mediaType", "axis", "position", "importId",
    "artifactId", "entryPath", "path", "parentEntityId", "maxBytes", "projectId",
    "materialId", "role", "sha256", "width", "height"]) {
    if (input[field] !== undefined) summary[field] = input[field];
  }
  if (input.primitive) {
    summary.primitive = {
      kind: input.primitive.kind,
      ...(input.primitive.vertices ? {
        vertexCount: input.primitive.vertices.length,
      } : {}),
      ...(input.primitive.faces ? {
        faceCount: input.primitive.faces.length,
      } : {}),
    };
  }
  for (const [field, label] of [["faces", "faceCount"],
    ["edges", "edgeCount"], ["vertices", "vertexCount"]]) {
    if (Array.isArray(input[field])) summary[label] = input[field].length;
  }
  if (Array.isArray(input.operations)) {
    summary.operationCount = input.operations.length;
    summary.operations = input.operations.slice(0, 8)
      .map(({ op }) => op);
  }
  if (Array.isArray(input.entityIds)) summary.entityCount = input.entityIds.length;
  if (Array.isArray(input.files)) summary.fileCount = input.files.length;
  if (Array.isArray(input.views)) summary.viewCount = input.views.length;
  if (typeof input.dataBase64 === "string") summary.encodedChunkBytes = input.dataBase64.length;
  return summary;
}

function activityResult(result) {
  if (!result || typeof result !== "object") return {};
  const summary = {};
  for (const field of ["revision", "selection", "entityId", "path", "contentDigest",
    "vertexCount", "faceCount", "triangleCount", "renderVertexCount",
    "operationCount", "entityCount", "assetCount", "modeledAssetCount",
    "returnedEntityCount", "fileName", "mediaType", "sampleId", "category",
    "referenceId", "batchId", "uploadId", "frameId", "frameCount", "totalBytes",
    "acceptedBytes", "receivedBytes", "remainingBytes", "textureAssetCount",
    "nodeCount", "meshCount", "materialCount", "textureCount", "count",
    "byteLength", "width", "height", "browserDownloadAvailable", "importId",
    "artifactId", "digest", "chunkBytes", "fileCount", "nextOffset", "eof",
    "released", "aborted", "complete", "idempotent", "projectId", "name",
    "activeProjectId", "projectCount", "canUndo", "canRedo", "materialId",
    "mode", "valid", "committed", "rendererChecked",
    "mapCount", "customMaterialCount", "status", "reason", "cameraMoved",
    "targetReached", "framesPresented", "ownerCameraPreserved"]) {
    if (result[field] !== undefined) summary[field] = result[field];
  }
  if (Array.isArray(result.results)) {
    if (summary.operationCount === undefined) summary.operationCount = result.results.length;
    summary.results = result.results.slice(0, 8).map(({ op, entityId }) => ({
      ...(op === undefined ? {} : { op }),
      ...(entityId === undefined ? {} : { entityId }),
    }));
  }
  if (result.scene?.name !== undefined) summary.sceneName = result.scene.name;
  if (result.reference?.referenceId !== undefined) {
    summary.referenceId = result.reference.referenceId;
  }
  return summary;
}

function boundedDetail(value) {
  return Array.from(String(value)).slice(0, 200).join("");
}

function contextualValidationFailure(error, input, toolName) {
  if (error?.code !== "INVALID_ARGUMENT") return error;
  const details = { ...error.details };
  if (!details.field) {
    const missingShape = /^input\.operations\[(\d+)\]: requires shape/u.exec(error.message);
    const operation = missingShape && (toolName === "scene_apply_batch"
      || toolName === "scene_preflight_batch")
      ? safeOwnValue(safeOwnValue(input, "operations"), missingShape[1]) : undefined;
    if (safeOwnValue(operation, "op") !== "add_primitive"
        || safeOwnValue(operation, "primitive") === undefined
        || safeOwnValue(operation, "shape") !== undefined) return error;
    details.field = `input.operations[${missingShape[1]}].primitive`;
  }
  const selectedEntity = safeOwnValue(input, "entityId");
  if (typeof selectedEntity === "string"
      && new RegExp(UUID_PATTERN, "u").test(selectedEntity)) {
    details.entityId ??= selectedEntity;
  }
  const match = /^input\.operations\[(\d+)\]/u.exec(details.field);
  if (match) {
    const index = Number(match[1]);
    const operation = safeOwnValue(safeOwnValue(input, "operations"), String(index));
    const kind = safeOwnValue(operation, "op");
    const preflight = toolName === "scene_preflight_batch";
    if (toolName === "mesh_apply_batch"
        || preflight && typeof selectedEntity === "string") {
      details.meshOperationIndex ??= index;
      if (typeof kind === "string") details.meshOperation ??= kind;
    } else if (toolName === "scene_apply_batch" || preflight) {
      details.operationIndex ??= index;
      if (typeof kind === "string") details.operation ??= kind;
      const identifier = safeOwnValue(operation, "entityId");
      if (typeof identifier === "string"
          && new RegExp(UUID_PATTERN, "u").test(identifier)) {
        details.entityId ??= identifier;
      }
      const name = safeOwnValue(operation, "name");
      if (typeof name === "string") details.entityName ??= name;
    }
  }
  const directPrimitive = safeOwnValue(input, "primitive");
  const directUvSphere = toolName === "mesh_create"
    && safeOwnValue(directPrimitive, "kind") === "uvSphere";
  const batchIndex = Number(/^input\.operations\[(\d+)\]/u.exec(details.field)?.[1]);
  const batchOperation = Number.isSafeInteger(batchIndex)
    ? safeOwnValue(safeOwnValue(input, "operations"), String(batchIndex)) : undefined;
  const batchPrimitive = safeOwnValue(batchOperation, "primitive");
  const namedPartIndex = /^input\.parts\[(\d+)\]/u.exec(details.field)?.[1];
  const namedPart = toolName === "part_add" ? input
    : toolName === "parts_add" && namedPartIndex !== undefined
      ? safeOwnValue(safeOwnValue(input, "parts"), namedPartIndex) : undefined;
  if (safeOwnValue(namedPart, "shape") === "sphere"
      && (details.field.endsWith(".widthSegments")
        || /does not support property widthSegments/u.test(error.message))) {
    details.suggestedField ??= "segments";
    details.minimum ??= 3;
    details.maximum ??= 128;
    details.repair ??= "Named spheres use top-level segments (3-128); widthSegments belongs to mesh_create uvSphere.";
  } else if ((directUvSphere || safeOwnValue(batchPrimitive, "kind") === "uvSphere")
      && (details.field.endsWith(".segments")
        || /does not support property segments/u.test(error.message))) {
    details.suggestedField ??= "widthSegments";
    details.minimum ??= 3;
    details.maximum ??= 128;
    details.repair ??= "Use primitive.widthSegments (3-128); heightSegments supports 2-128.";
  } else if (safeOwnValue(batchOperation, "op") === "add_primitive") {
    if (details.field.endsWith(".segments") && details.value > 32) {
      details.minimum ??= 1;
      details.maximum ??= 32;
      details.repair ??=
        "Native add_primitive supports segments 1-32; use mesh_create uvSphere.widthSegments for up to 128.";
    } else if (details.field.endsWith(".primitive")
        || /does not support property primitive/u.test(error.message)
        || safeOwnValue(batchOperation, "primitive") !== undefined
          && safeOwnValue(batchOperation, "shape") === undefined) {
      if (!details.field.endsWith(".primitive")) details.field += ".primitive";
      details.suggestedOperation ??= "mesh_create";
      details.repair ??=
        "Use top-level shape/radius/segments, or mesh_create with primitive:{kind:'uvSphere',widthSegments:64}.";
    }
  }
  error.details = details;
  return error;
}

function actionableGeometryMessage(error) {
  const details = error?.details;
  if (details?.geometry === "capsule") return error.message;
  if (error?.code !== "INVALID_ARGUMENT" || !details
      || details.repair === undefined && details.maxExclusive === undefined
        && details.edge === undefined && details.segments === undefined) {
    return error?.message;
  }
  const owner = [];
  if (Number.isSafeInteger(details.partIndex)) owner.push(`part[${details.partIndex}]`);
  if (Number.isSafeInteger(details.operationIndex)) {
    owner.push(`scene[${details.operationIndex}]${details.operation
      ? ` ${details.operation}` : ""}`);
  }
  const identifier = typeof details.entityId === "string"
    && new RegExp(UUID_PATTERN, "u").test(details.entityId)
    ? details.entityId : undefined;
  const mesh = [];
  if (Number.isSafeInteger(details.meshOperationIndex)) {
    mesh.push(`mesh[${details.meshOperationIndex}]${details.meshOperation
      ? ` ${details.meshOperation}` : ""}`);
  } else if (details.meshOperation) mesh.push(String(details.meshOperation));
  if (Number.isSafeInteger(details.profileIndex)) mesh.push(`profile[${details.profileIndex}]`);
  if (Number.isSafeInteger(details.pointIndex)) mesh.push(`point[${details.pointIndex}]`);
  if (Array.isArray(details.pointIndices)) mesh.push(`points[${details.pointIndices.join(",")}]`);
  if (Array.isArray(details.segmentIndices)) mesh.push(`edges[${details.segmentIndices.join(",")}]`);
  if (Number.isSafeInteger(details.planarGroupIndex)) {
    mesh.push(`plane[${details.planarGroupIndex}]`);
  }
  if (Array.isArray(details.edge)) mesh.push(`edge[${details.edge.join(",")}]`);
  if (details.field && details.value !== undefined) {
    mesh.push(`${details.field}=${String(details.value)}`);
  }
  if (Number.isSafeInteger(details.segments)) mesh.push(`segments=${details.segments}`);
  if (Number.isSafeInteger(details.faceIndex)) mesh.push(`face[${details.faceIndex}]`);

  const remaining = [];
  if (details.maxExclusive !== undefined) remaining.push(`limit <${details.maxExclusive}`);
  if (details.suggestedValue !== undefined) {
    remaining.push(`try ${details.suggestedValue}${details.edge
      ? " or widen adjacent faces" : ""}`);
  } else if (typeof details.repair === "string") {
    remaining.push(details.segments === undefined
      ? details.repair.replace(/^Reduce the /u, "reduce ").replace(/\.$/u, "")
      : "increase bevel or reduce segments");
  }
  const objectName = details.partName ?? details.entityName;
  const compose = (name = "", abbreviated = false) => {
    const leading = [...owner];
    if (abbreviated) {
      for (let index = 0; index < leading.length; index += 1) {
        leading[index] = leading[index].replace(/^(scene\[\d+\]) .*$/u, "$1");
      }
    }
    if (name) leading.push(`"${name}"`);
    if (identifier) leading.push(`(${identifier})`);
    return [...(leading.length ? [leading.join(" ")] : []),
      ...(mesh.length ? [mesh.join(" ")] : []), ...remaining].join("; ");
  };
  let message = compose();
  if (Array.from(message).length > 200) message = compose("", true);
  if (typeof objectName === "string" && objectName.length > 0) {
    const available = 200 - Array.from(message).length - (owner.length || identifier ? 3 : 2);
    if (available > 0) {
      const characters = Array.from(objectName);
      const abbreviated = characters.length > available;
      const selected = abbreviated && available > 1
        ? `${characters.slice(0, available - 1).join("")}…`
        : characters.slice(0, available).join("");
      const named = compose(selected, Array.from(compose()).length > 200);
      if (Array.from(named).length <= 200) message = named;
    }
  }
  return boundedDetail(message || error.message);
}

function describeActivity(name, status, input, result, error) {
  if (status === "failed" || status === "aborted") {
    return boundedDetail(error?.message ?? `${activityOperations[name]} ${status}`);
  }
  const [started, completed] = activityLabels[name] ?? [name, name];
  const parts = [status === "started" ? started : completed];
  if (name === "camera_guide" && status === "completed") {
    if (result.status === "yielded") {
      parts[0] = result.cameraMoved
        ? "Camera guidance yielded after partial movement"
        : "You retained control of your camera";
    } else if (result.status === "already_framed") {
      parts[0] = "Visible camera already frames the subject";
    }
  }
  if (name === "mesh_create" && input.primitive?.kind) {
    parts[0] += ` (${input.primitive.kind})`;
  }
  if (["scene_apply_batch", "scene_preflight_batch"].includes(name)
      && input.operationCount) {
    parts.push(`${input.operationCount} operation${input.operationCount === 1 ? "" : "s"}`);
  }
  if (status === "completed" && Number.isSafeInteger(result.revision)) {
    parts.push(`r${result.revision}`);
  }
  if (status === "completed" && Number.isSafeInteger(result.vertexCount)) {
    parts.push(`${result.vertexCount} vertices`);
  }
  if (status === "completed" && Number.isSafeInteger(result.faceCount)) {
    parts.push(`${result.faceCount} faces`);
  }
  if (status === "completed" && result.fileName) parts.push(result.fileName);
  if (status === "completed" && result.width && result.height) {
    parts.push(`${result.width}×${result.height}`);
  }
  return boundedDetail(parts.join(" · "));
}

function emitInvocation(callback, event) {
  if (typeof callback !== "function") return;
  try {
    const result = callback(event);
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Observer presentation cannot change an actual scene transaction.
  }
}

function invokeDescriptor({ name, title, description, inputSchema,
  readOnlyHint, untrustedContentHint, destructiveHint, validate, handle, onInvocation, store,
  runtime, getPersistenceStatus, createInvocationIdentity, getCallbackOwner,
  getOwnerGeneration }) {
  return Object.freeze({
    name,
    title,
    description,
    inputSchema,
    annotations: Object.freeze({ readOnlyHint, untrustedContentHint,
      ...(destructiveHint === true ? { destructiveHint: true } : {}) }),
    async execute(input = {}, context = undefined) {
      const started = Date.now();
      const invocationId = createInvocationIdentity();
      const owner = typeof getCallbackOwner === "function" ? getCallbackOwner()
        : typeof context?.getCallbackOwner === "function" ? context.getCallbackOwner()
          : context?.callbackOwner;
      const ownerGeneration = typeof getOwnerGeneration === "function" ? getOwnerGeneration()
        : typeof context?.getOwnerGeneration === "function" ? context.getOwnerGeneration()
          : context?.ownerGeneration;
      const invocation = { invocationId,
        ...(owner === undefined ? {} : { owner }),
        ...(ownerGeneration === undefined ? {} : { ownerGeneration }) };
      const signal = invocationSignal(context);
      const before = activityState(store);
      let summarizedInput = {};
      try {
        aborted(signal);
        try {
          validateStudioToolInput(input, inputSchema);
        } catch (error) {
          if (name === "readInstructionsForCodex" && error?.code === "INVALID_ARGUMENT"
              && safeOwnValue(input, "detail") !== undefined
              && safeOwnValue(input, "family") !== undefined
              && /must contain at most 1 properties/u.test(error.message)) {
            throw new StudioToolError("INVALID_ARGUMENT",
              "Select one capability family or an instruction detail, not both.");
          }
          if (name === "mesh_transform" && error?.code === "INVALID_ARGUMENT"
              && safeOwnValue(input, "selection") !== undefined
              && safeOwnValue(input, "cageId") === undefined) {
            throw new StudioToolError("INVALID_ARGUMENT",
              "input.selection: spatial/coarse control selection requires cageId; enable part_feature with {target:<entityId>,feature:'cage',levels:0}, then retry mesh_transform with cageId:<entityId>.");
          }
          throw error;
        }
        validate?.(input);
        summarizedInput = activityInput(input);
        if (readOnlyHint === false && typeof getPersistenceStatus === "function") {
          const persistenceStatus = getPersistenceStatus();
          if (persistenceStatus?.navigationPending === true) {
            throw new StudioToolError("PROJECT_NAVIGATION_PENDING",
              "The current project cannot be changed while another project is opening.");
          }
          if ((persistenceStatus?.readOnly === true
            || persistenceStatus?.phase === "readonly"
            || persistenceStatus?.phase === "read-only"
            || persistenceStatus?.phase === "competing-tab")
            && name !== "project_create" && name !== "project_open"
            && name !== "project_acquire") {
            throw new StudioToolError("PROJECT_READ_ONLY",
              "The current modeling project is read-only in this browser tab.");
          }
        }
        const operation = name === "scene_apply_batch"
          && summarizedInput.operations?.length === 1
          ? summarizedInput.operations[0] : activityOperations[name];
        emitInvocation(onInvocation, {
          ...invocation,
          name,
          status: "started",
          operation,
          input: summarizedInput,
          ...(before.revision === undefined ? {} : {
            revision: before.revision,
            previousRevision: before.revision,
          }),
          ...(before.selection === undefined ? {} : {
            selection: before.selection,
          }),
          ...(before.entityCount === undefined ? {} : {
            entityCount: before.entityCount,
          }),
          ...(before.assetCount === undefined ? {} : {
            assetCount: before.assetCount,
          }),
          ...(summarizedInput.entityId === undefined ? {} : {
            entityId: summarizedInput.entityId,
          }),
          detail: describeActivity(name, "started", summarizedInput, {}),
          at: new Date(started).toISOString(),
        });
        const result = await handle(input, signal);
        // A committed native scene transaction must remain observable even when
        // cancellation races its receipt; hiding it would invite unsafe replay.
        if (readOnlyHint) aborted(signal);
        const summarizedResult = activityResult(result);
        const after = activityState(store);
        const revision = summarizedResult.revision ?? after.revision;
        const selection = summarizedResult.selection ?? after.selection;
        const entityId = summarizedResult.entityId ?? summarizedInput.entityId;
        const entityCount = summarizedResult.entityCount ?? after.entityCount;
        const assetCount = summarizedResult.assetCount ?? after.assetCount;
        const mesh = Object.fromEntries(["vertexCount", "faceCount", "triangleCount",
          "renderVertexCount"].filter((field) =>
          Number.isSafeInteger(summarizedResult[field]))
          .map((field) => [field, summarizedResult[field]]));
        emitInvocation(onInvocation, {
          ...invocation,
          name,
          status: "completed",
          operation,
          input: summarizedInput,
          result: summarizedResult,
          ...(before.revision === undefined ? {} : {
            previousRevision: before.revision,
          }),
          ...(revision === undefined ? {} : { revision }),
          ...(readOnlyHint === false && name !== "project_acquire"
            && Number.isSafeInteger(revision)
            && Number.isSafeInteger(before.revision)
            && revision > before.revision ? { committed: true } : {}),
          ...Object.fromEntries(["snapshotId", "sceneSourceHash", "assetManifestHash"]
            .filter((field) => typeof result?.[field] === "string")
            .map((field) => [field, result[field]])),
          ...(selection === undefined ? {} : { selection }),
          ...(entityId === undefined ? {} : { entityId }),
          ...(entityCount === undefined ? {} : { entityCount }),
          ...(assetCount === undefined ? {} : { assetCount }),
          ...(summarizedResult.modeledAssetCount === undefined ? {} : {
            modeledAssetCount: summarizedResult.modeledAssetCount,
          }),
          ...(Object.keys(mesh).length === 0 ? {} : { mesh, ...mesh }),
          sceneChanged: readOnlyHint === false && name !== "project_acquire"
            && before.revision !== undefined
            && revision !== undefined && revision !== before.revision,
          detail: describeActivity(name, "completed", summarizedInput,
            { ...summarizedResult, revision }),
          durationMilliseconds: Date.now() - started,
          at: new Date().toISOString(),
        });
        return result;
      } catch (error) {
        let runtimeStatus;
        try { runtimeStatus = runtime?.status?.(); } catch { /* Status is advisory only. */ }
        const errorDetails = error?.details;
        const recoveryFence = error?.recoveryFence ?? errorDetails?.recoveryFence
          ?? runtimeStatus?.recoveryFence;
        const operationOutcome = error?.operationOutcome ?? errorDetails?.operationOutcome
          ?? recoveryFence?.operationOutcome ?? runtimeStatus?.operationOutcome;
        const recoveryReason = error?.recoveryReason ?? errorDetails?.recoveryReason
          ?? recoveryFence?.reason ?? runtimeStatus?.recoveryReason;
        const unknownOutcome = error?.unknownOutcome === true
          || errorDetails?.unknownOutcome === true
          || recoveryFence?.unknownOutcome === true
          || operationOutcome === "unknown"
          || recoveryReason === "unknown_submission";
        const recoveryRequired = error?.recoveryRequired === true
          || errorDetails?.recoveryRequired === true
          || recoveryFence != null
          || runtimeStatus?.recoveryRequired === true
          || unknownOutcome || operationOutcome === "applied_uncommitted";
        const status = !unknownOutcome && !recoveryRequired
          && (signal?.aborted || error?.name === "AbortError")
          ? "aborted" : "failed";
        if (status === "failed") {
          contextualValidationFailure(error, input, name);
          const message = actionableGeometryMessage(error);
          if (typeof message === "string" && message !== error.message) {
            try { error.message = message; } catch { /* Preserve sealed error identity. */ }
          }
        }
        const failure = {
          code: String(error?.code ?? error?.name ?? "INTERNAL").slice(0, 80),
          message: boundedDetail(error?.message ?? "The WebMCP invocation failed."),
        };
        const current = activityState(store);
        const failedEntity = summarizedInput.entityId ?? error?.details?.entityId;
        emitInvocation(onInvocation, {
          ...invocation,
          name,
          status,
          ...(unknownOutcome ? { unknownOutcome: true } : {}),
          ...(recoveryRequired ? {
            recoveryRequired: true,
            ...(unknownOutcome ? {} : { unknownOutcome: false }),
          } : {}),
          ...(typeof operationOutcome === "string" ? { operationOutcome } : {}),
          ...(typeof recoveryReason === "string" ? { recoveryReason } : {}),
          ...(operationOutcome === "applied_uncommitted" ? { committed: false } : {}),
          operation: activityOperations[name],
          ...(before.revision === undefined ? {} : {
            previousRevision: before.revision,
          }),
          ...(current.revision === undefined ? {} : {
            revision: current.revision,
          }),
          ...(current.selection === undefined ? {} : {
            selection: current.selection,
          }),
          ...(current.entityCount === undefined ? {} : {
            entityCount: current.entityCount,
          }),
          ...(current.assetCount === undefined ? {} : {
            assetCount: current.assetCount,
          }),
          ...(typeof failedEntity === "string"
            && new RegExp(UUID_PATTERN, "u").test(failedEntity)
            ? { entityId: failedEntity } : {}),
          error: failure,
          detail: describeActivity(name, status, summarizedInput, {}, failure),
          durationMilliseconds: Date.now() - started,
          at: new Date().toISOString(),
        });
        throw error;
      }
    },
  });
}

export const STUDIO_TOOL_NAMES = Object.freeze([
  "readInstructionsForCodex",
  "listDocs",
  "getDoc",
  "status",
  "tooling_feedback_report",
  "project_active",
  "project_list",
  "project_create",
  "project_open",
  "project_acquire",
  "project_rename",
  "project_delete",
  "scene_get",
  "scene_undo",
  "scene_redo",
  "scene_apply_batch",
  "scene_preflight_batch",
  "mesh_create",
  "mesh_inspect",
  "mesh_extrude",
  "mesh_inset",
  "mesh_bevel",
  "mesh_subdivide",
  "mesh_transform",
  "mesh_weld",
  "material_set",
  "light_set",
  "camera_set",
  "camera_guide",
  "environment_set",
  "render_capture",
  "asset_export_glb",
  "scene_export",
  "reference_batch_begin",
  "reference_upload_begin",
  "reference_upload_chunk",
  "reference_upload_complete",
  "reference_upload_abort",
  "reference_list",
  "reference_select",
  "reference_delete",
  "material_samples_list",
  "material_sample_inspect",
  "material_sample_apply",
  "mesh_array_linear",
  "mesh_array_radial",
  "mesh_mirror",
  "mesh_loop_cut",
  "mesh_apply_batch",
  "focus_target",
  "render_capture_batch",
  "render_contact_sheet",
  "render_frame_get",
  "asset_export_group",
  "material_inspect",
  "model_import_begin",
  "model_import_chunk",
  "model_import_status",
  "model_import_inspect",
  "model_import_commit",
  "model_import_abort",
  "asset_convert_editable",
  "asset_artifact_prepare",
  "asset_artifact_read_chunk",
  "asset_artifact_release",
  "material_create",
  "material_upload_begin",
  "material_upload_chunk",
  "material_upload_status",
  "material_upload_commit",
  "material_upload_abort",
  "part_add",
  "parts_add",
  "part_edit",
  "part_duplicate",
  "part_repeat",
  "part_group",
  "part_feature",
  "part_remove",
  "part_convert",
  "part_boolean",
  "part_curve",
]);

/** Build direct, browser-owned WebMCP tools with no broker or application server. */
export function createStudioTools({ store, runtime, capture, referenceAssets,
  inspection, exportAssets, modelImports, artifacts, projectController,
  materialAuthoring, materialUploads,
  getPersistenceStatus, getCallbackOwner, getOwnerGeneration,
  onInvocation, onExport, reserveExportOffer, publishExportOffer, releaseExportOffer,
  toolFeedback, cameraGuidance,
  composeContactSheet = createContactSheet, scope = globalThis } = {}) {
  if (!store || typeof store !== "object"
    || typeof store.getScene !== "function") {
    throw new TypeError("A browser-owned modeling scene store is required.");
  }
  if (onInvocation !== undefined && typeof onInvocation !== "function") {
    throw new TypeError("onInvocation must be a function when provided.");
  }
  if (onExport !== undefined && typeof onExport !== "function") {
    throw new TypeError("onExport must be a function when provided.");
  }
  if (getPersistenceStatus !== undefined && typeof getPersistenceStatus !== "function") {
    throw new TypeError("getPersistenceStatus must be a function when provided.");
  }
  for (const [name, callback] of Object.entries({ getCallbackOwner, getOwnerGeneration,
    reserveExportOffer, publishExportOffer, releaseExportOffer })) {
    if (callback !== undefined && typeof callback !== "function") {
      throw new TypeError(`${name} must be a function when provided.`);
    }
  }
  if (toolFeedback !== undefined && typeof toolFeedback !== "function") {
    throw new TypeError("toolFeedback must be a function when provided.");
  }
  if (cameraGuidance !== undefined && typeof cameraGuidance?.guide !== "function") {
    throw new TypeError("cameraGuidance must provide a genuine guide method when supplied.");
  }
  if (typeof composeContactSheet !== "function") {
    throw new TypeError("composeContactSheet must be a genuine browser image compositor.");
  }
  const guidance = cameraGuidance ?? (typeof runtime?.previewOwnerCameraPose === "function"
    && typeof runtime?.finishOwnerCameraPreview === "function"
    && typeof inspection?.focusTarget === "function"
    ? createCameraGuidance({ store, inspection, runtime, scope }) : null);
  const descriptors = [];
  let invocationSequence = 0;
  const createInvocationIdentity = () => `invocation_${(++invocationSequence).toString(36)}`;
  const partAuthoring = typeof store.applyBatch === "function"
    ? createPartAuthoringService({ store, scope }) : null;
  const persistentControlCages = typeof store.editControlCage === "function";
  const atomicControlCageBatches = persistentControlCages
    && typeof store.editControlCageBatch === "function";
  const editableCurveAuthoring = typeof store.editCurveAuthoring === "function";
  const durableModelingInspection = typeof store.inspectModelingState === "function";
  const ongoingReflectionSymmetry = durableModelingInspection
    && typeof store.setModelingState === "function"
    && typeof store.inspectMesh === "function";
  const getProjectStatus = getPersistenceStatus
    ?? (typeof projectController?.projectStatus === "function"
      ? () => projectController.projectStatus() : undefined);
  const projectOwnership = () => {
    if (typeof getProjectStatus !== "function") return undefined;
    const selected = getProjectStatus();
    if (!selected || typeof selected !== "object") return undefined;
    const pending = selected.phase === "acquiring";
    const recoveryRequired = selected.recoveryRequired === true
      || ["recovery", "recovery-required", "recovery_required"].includes(selected.phase);
    const readOnly = selected.readOnly === true
      || ["readonly", "read-only", "competing-tab"].includes(selected.phase);
    const hasWriter = !pending && !recoveryRequired && !readOnly
      && (selected.hasWriter === true
        || selected.hasWriter === undefined && selected.enabled === true);
    const navigationPending = selected.navigationPending === true;
    const canAttemptAcquire = !pending && !recoveryRequired && !navigationPending
      && readOnly && selected.canAttemptAcquire === true
      && typeof projectController?.acquireProject === "function";
    const mode = recoveryRequired ? "recovery_required" : pending ? "acquiring"
      : readOnly ? "read_only" : hasWriter ? "writable" : "ephemeral";
    const reason = recoveryRequired ? "recovery_required" : pending ? "acquiring"
      : readOnly ? "writer_conflict" : mode === "ephemeral"
        ? selected.consented === false ? "saving_disabled" : "ephemeral"
        : undefined;
    return {
      mode,
      canEdit: !pending && !recoveryRequired && !readOnly && !navigationPending,
      hasWriter,
      canAttemptAcquire,
      ...(reason === undefined ? {} : { reason }),
    };
  };
  const add = (definition) => descriptors.push(invokeDescriptor({
    ...definition,
    getPersistenceStatus: getProjectStatus,
    createInvocationIdentity,
    getCallbackOwner,
    getOwnerGeneration,
    onInvocation: definition.background === true ? undefined : onInvocation,
    store,
    runtime,
  }));

  add({ name: "readInstructionsForCodex",
    title: "Read agent modeling instructions",
    description: "Model, inspect real views, and fix defects. Request full for details.",
    inputSchema: closedObject({ detail: enumText(["compact", "full"]),
      family: enumText(Object.keys(toolFamilies)) }, [], { maxProperties: 1 }),
    readOnlyHint: true,
    untrustedContentHint: false,
    handle: (input) => {
      const { detail = "compact", family } = input;
      if (family !== undefined) {
        if (Object.hasOwn(input, "detail")) {
          throw new StudioToolError("INVALID_ARGUMENT",
            "Select one capability family or an instruction detail, not both.");
        }
        const registered = new Map(descriptors.map((descriptor) =>
          [descriptor.name, descriptor]));
        const tools = toolFamilies[family].filter((name) => registered.has(name));
        const feature = family === "modeling" ? registered.get("part_feature")
          : undefined;
        const modes = feature?.inputSchema?.properties?.feature?.enum;
        return { format: "oriel.tool-family/1", family, tools,
          ...(Array.isArray(modes) ? { surfaces: [{ tool: feature.name,
            modes: [...modes] }] } : {}) };
      }
      const current = state(store);
      const inventory = sceneInventory(store, current);
      const availableToolNames = new Set(descriptors.map(({ name }) => name));
      const availableCapabilities = (...names) => names.filter((name) =>
        availableToolNames.has(name));
      const formCapabilities = actualFormFirstCapabilities(descriptors, inspectionCapabilities);
      const formFirstWorkflow = {
        format: "oriel.form-first-workflow/1",
        capabilities: formCapabilities,
        sequence: ["coarse-editable-form", "silhouette-and-proportions",
          "connected-primary-surfaces", "structural-openings",
          "coarse-to-fine-refinement", "genuine-multi-view-critique",
          "correct-actual-geometry"],
        controls: formCapabilities.persistentControlCages
          ? "Shape a genuinely registered persistent control cage before fine surface details."
          : "Shape a coarse editable mesh first; persistent control cages are unavailable.",
        curves: formCapabilities.editableCurveProfiles
          ? "Adjust registered persistent curve or surface profiles before refining details."
          : "Existing curves and lofts create editable meshes; persistent profile controls are unavailable.",
        symmetry: formCapabilities.ongoingSymmetryConstraints
          ? "Maintain the genuinely registered ongoing symmetry constraint while shaping."
          : formCapabilities.perEditSymmetry
            ? "Use registered one-shot mirroring or per-edit symmetry; neither is an ongoing constraint."
            : "Symmetry operations are unavailable; do not claim mirrored edits.",
        references: formCapabilities.referenceImageComparison
          ? "Compare actual reference pixels against genuine rendered frames."
          : formCapabilities.referenceImages
            ? "Use real uploaded reference images; automatic image-grounded comparison is unavailable."
            : "Reference-image tools are unavailable; do not fabricate visual evidence.",
        viewpoints: formCapabilities.orthographicViews
          ? "Compare genuinely supported orthographic and perspective multi-angle WebGPU frames."
          : formCapabilities.ownerIndependentViews
            ? "Compare genuine owner-independent perspective frames; orthographic views are unavailable."
            : "Inspect genuinely presented WebGPU frames; independent and orthographic views are unavailable.",
        decoration: "Disconnected decorative geometry requires an actual structural justification.",
      };
      const availableProjectActions = [["project_active", "inspect"],
        ["project_list", "list"], ["project_create", "create"],
        ["project_open", "open"], ["project_acquire", "acquire editing access"],
        ["project_rename", "rename"],
        ["project_delete", "explicitly delete"]]
        .filter(([name]) => availableToolNames.has(name))
        .map(([, action]) => action);
      const ownership = projectOwnership();
      const readOnlyProject = ownership?.canEdit === false;
      const canAcquire = ownership?.canAttemptAcquire === true
        && availableToolNames.has("project_acquire");
      const currentStage = {
        revision: current.revision,
        selection: current.selection,
        ...inventory,
        heroPresent: inventory.modeledAssetCount > 0,
      };
      if (detail === "compact") {
        const modeling = availableCapabilities("part_add", "parts_add",
          "part_edit", "part_duplicate", "part_repeat",
          "part_group", "part_feature", "part_remove",
          "part_convert", "part_boolean", "part_curve",
          "mesh_create");
        const materials = availableCapabilities("material_samples_list",
          "material_sample_inspect", "material_sample_apply",
          "material_create", "material_upload_begin",
          "material_upload_chunk", "material_upload_commit");
        return {
          title: documentation.overview.title,
          quickStart: {
            firstAction: readOnlyProject
              ? canAcquire
                ? "This project is read-only; acquire editing access after its writer closes, or open another project."
                : "This project cannot currently be edited; inspect its ownership or open another project."
              : inventory.modeledAssetCount > 0
              ? "Preserve existing authored work; inspect only what the request affects, then edit."
              : "Begin modeling immediately; first authored geometry replaces the untouched starter cube.",
            firstCall: readOnlyProject ? { tool: canAcquire ? "project_acquire"
              : availableToolNames.has("project_active") ? "project_active"
                : "status", input: {} }
              : { tool: "part_add", input: { name: "Body",
                shape: "rounded_box", size: [2, 1, 1], material: "brushed-aluminum" } },
            bestPractices: [
              "Start with one coarse editable form: first visible part via part_add or default cube; shape silhouette and proportions before details; do not write scripts.",
              `Connect primary surfaces, cut real openings, and refine coarse-to-fine${
                formCapabilities.creaseAwareSubdivision ? " with crease protection" : ""}; ${
                formCapabilities.ongoingSymmetryConstraints
                  ? "use the actual ongoing symmetry constraint"
                  : formCapabilities.perEditSymmetry
                    ? "one-shot mirror or per-edit symmetry is not persistent"
                    : "never claim unavailable symmetry"}.`,
              "Use friendly material names such as Brushed Aluminum; browse presets or create/upload genuine custom PBR materials.",
              "Camera guidance is transient and yields to the user; when indirect invoke camera_guide through action_read, never action_mutate.",
              `Complex assets require three distinct real WebGPU views when available; ${
                formCapabilities.orthographicViews
                  ? "use genuine orthographic projection"
                  : "never call perspective views orthographic"}. Visible defects mean needs_more_work: call the modeling tools again, recapture, and refine until genuinely production_ready.`,
              "Export or download only when requested; never fabricate geometry, textures, renders, or capabilities.",
            ],
          },
          operatingMode: "agent-first-observer",
          currentStage,
          defaultStage: { mode: "neutral-modeling-workspace", preloadedHero: false },
          recommendedFirstTools: readOnlyProject
            ? availableCapabilities("project_acquire", "project_open",
              "project_create").slice(0, 2)
            : modeling.slice(0, 2),
          capabilities: {
            projects: availableCapabilities("project_active", "project_list",
              "project_create", "project_open", "project_acquire",
              "project_rename",
              "project_delete"),
            modeling,
            materials,
            history: availableCapabilities("scene_undo", "scene_redo"),
            inspection: availableCapabilities("scene_get", "camera_guide",
              "render_capture", "render_contact_sheet"),
          },
          materialCatalog: { tool: "material_samples_list", detail: "compact",
            presetCount: inventory.availableMaterialPresetCount },
          completionGate: { incompleteStatus: "needs_more_work",
            completeStatus: "production_ready", complexAssetMinimumViews: 3,
            reviewTool: availableToolNames.has("render_contact_sheet")
              ? "render_contact_sheet" : "render_capture",
            rule: "A critique, primitive count, or known visual defect never completes the requested model; correct it with real tools and inspect again." },
          cliTransport: { mode: "webmcp-drop-in", discovery: "native-webmcp-first",
            fallback: "same-page-registered-tool-descriptors", separateSceneApi: false },
          modelingContract: { format: "oriel.modeling-contract/1", detail: "full" },
          fullReference: { tool: "readInstructionsForCodex", input: { detail: "full" } },
        };
      }
      const quickStart = {
        capabilities: [`Create and import: editable meshes, built-in primitives${
          availableToolNames.has("model_import_commit") ? ", genuine GLB/glTF" : ""}${
          formCapabilities.referenceImages ? ", and reference images" : ""}.`,
          "Edit geometry: shape coarse indexed meshes; develop continuous lofts or sweeps, real openings, integrated transitions, and crease-aware refinement.",
          "Materials: reuse the existing sample library and assigned/custom assets; author textured PBR materials, upload verified PNG/JPEG maps, and preview actual GPU results.",
          "Lighting and camera: tune real lights; guide the user's visible viewport camera by default without saving its position; invoke hidden camera_guide through action_read.",
          formCapabilities.ownerIndependentViews
            ? "Render and inspect: compare projected-fit genuine owner-independent WebGPU viewpoints with studio/transparent backgrounds; export polished labeled PNG contact sheets."
            : "Render and inspect: use genuinely presented WebGPU frames; owner-independent multi-view capture is unavailable.",
          "Export: prepare individual/grouped GLB or scene files; downloads require explicit user action.",
          `Persistence: ${availableProjectActions.length === 0 ? "autosave"
            : `${availableProjectActions.join(", ")}, and autosave`} consented browser-local modeling projects.`,
          "Feedback: silently report genuine missing features or papercuts individually or in bounded idempotent batches."],
        bestPractices: ["Start with one centered default cube, no floor or ground plane, an editor-only viewport guide, and real WebGPU; no application server.",
          "Model the user's requested hard-surface objects, organic forms, architecture, product concepts, and production assets; the agent performs every authoring operation.",
          "Create a visible named part immediately with part_add; add incrementally without scripts. For atomic parts_add, use its direct or capabilities_help action_mutate route. Shape one coarse form first; import genuine GLB/glTF only when relevant.",
          "When choosing a finish, browse the compact complete material library if useful; inspect or reuse a preset, or create/upload a verified custom PBR material and apply it.",
          "Blockouts are temporary. Do not hand back an unfinished gray primitive, flat default shader, or blank surface; inspect silhouette, proportion, topology, texture scale, seams, material response; shape connected surfaces and real openings coarse-to-fine; deliver presentation-ready work.",
          "Guide the user's actual visible camera with camera_guide by default; movement is transient, never serialized or persisted, and immediately yields to manual orbit, pan, zoom, or opt-out. If hidden use action_read.",
          "Complex work requires three distinct genuine owner-independent WebGPU views or render_contact_sheet. Visible defects mean needs_more_work: author actual corrections, recapture, and repeat until genuinely production_ready.",
          "Experiment freely: authored edits have undo history. Try alternatives, inspect genuine renders, undo or redo with scene_undo/scene_redo, replace weak ideas, and retry; no Chrome-plugin screenshot is required: npm run webmcp -- capture --output /tmp/model.png.",
          "Report feedback silently with tooling_feedback_report using missing_feature or papercut; never interrupt the user, expose private scene data, or claim unsupported work succeeded.",
          "The agent CLI is a transport-equivalent drop-in using the same registered WebMCP descriptors and observer lifecycle."],
      };
      return {
      title: documentation.overview.title,
      quickStart,
      operatingMode: "agent-first-observer",
      agentRole: "The agent authors the user's requested hard-surface, organic, architectural, product, or asset model; imports references or geometry when relevant; renders, critiques, refines, and exports on request while the user observes actual scene changes.",
      supportedSubjects: ["hard-surface objects", "organic forms", "products",
        "furniture", "vehicles", "robotics", "game props", "architecture",
        "environment assets", "character components", "abstract sculpture"],
      workingRules: ["Follow the user's requested subject, style, scale, and deliverable; never impose an unrelated theme.",
        "Inspect the existing project or affected scene only when needed to preserve authored work; otherwise begin the requested edit immediately.",
        "When materials are relevant, browse the complete compact sample catalog, inspect a promising preset, reuse an assigned finish, or create/upload a genuine custom material.",
        "Preserve existing authored work while freely trying relevant geometry, materials, lighting, and composition; do not add floors or unrelated scenery unless appropriate to the request.",
        "Parented part transforms are local by default. For authored character positions and intended undistorted dimensions, explicitly use space:'world'; inspect the complete parent chain, actual local/world transforms and bounds, and attachment contact immediately. Prefer a neutral unscaled root group; preserve known explicit world attachment coordinates through real parent conversion. Nonuniform parent scale must be compensated; a rotated hierarchy requiring shear fails atomically instead of guessing.",
        "Shape one coarse editable mesh into the requested silhouette, proportions, and major volumes before details; develop continuous connected surfaces, genuinely registered lofts or sweeps, integrated transitions, and real openings; refine coarse-to-fine while protecting supported creases.",
        "Use persistent control cages, editable surface profiles, ongoing symmetry constraints, genuine orthographic viewpoints, and image-grounded reference comparisons only when their actual registered tools and native capabilities support them. Enable cage levels:0 for low-cost spatial control moves; batch supported face sculpt strokes without requiring a cage. One-shot mirrors and per-edit symmetric sculpting are not ongoing constraints.",
        "Disconnected decorative geometry requires a genuine structural justification; do not assemble subject-specific primitive nouns as a substitute for modeling a coherent form.",
        "Use only genuinely available WebMCP tools, accepted scene transactions, and actual WebGPU-rendered image evidence.",
        "Camera guidance is enabled by default; camera_guide moves only the transient visible viewport camera, never changes scene revision, undo history, autosave, or persistence, and immediately yields to user input or explicit opt-out. When capability help reports an indirect route, invoke camera_guide through action_read, never action_mutate.",
        "Use camera_set only when explicitly asked to edit the authored scene camera; unlike transient guidance, that intentional edit is serialized and persisted.",
        "Unfinished blockouts and reversible experiments are encouraged only while iterating; never hand off an unfinished gray model, unassigned material, missing texture, intersecting primitive pile, or unpolished placeholder unless requested.",
        "Review at least three genuinely distinct owner-independent WebGPU viewpoints or a contact sheet for every complex or hero asset; a single flattering image cannot hide weak silhouette, disconnected surfaces, floating parts, or fake openings.",
        "Experiment boldly because authored changes have undo history; capture and inspect a genuine final WebGPU frame, correct visible material, texture, lighting, framing, and geometry defects, and capture again before declaring completion. Keep needs_more_work and invoke more actual tools whenever any substantive defect remains; never optimize for the fewest calls or describe a known-bad render as production_ready.",
        "Silently report real unsupported features or workflow papercuts using tooling_feedback_report without interrupting the user or fabricating a result.",
        "Import references or models and prepare exports only when relevant; downloads always require an explicit user action."],
      instructions: quickStart.bestPractices,
      recommendedFirstTools: readOnlyProject
        ? availableCapabilities("project_acquire", "project_open",
          "project_create").slice(0, 2)
        : availableCapabilities("part_add", "parts_add",
          "mesh_create").slice(0, 2),
      defaultStage: {
        mode: "neutral-modeling-workspace",
        visualBrief: "A Blender-style neutral-gray viewport with one centered default cube, an aligned viewport-only grid, and no physical floor.",
        targetAsset: "user-requested 3D model or scene asset",
        defaultPrimitive: { name: "Cube", shape: "cube", size: [2, 2, 2],
          translation: [0, 0, 0] },
        supportingScene: ["centered default cube", "neutral environment",
          "directional key", "point fill", "rim point", "active camera"],
        preloadedHero: false,
      },
      currentStage,
      formFirstWorkflow,
      workflow: agentWorkflow.map(({ stage, goal, tools }) => ({
        stage,
        goal: stage === "references" && !formCapabilities.referenceImages
          ? "Reference-image tools are unavailable; inspect only genuine existing scene and frame evidence."
          : stage === "capture" && !formCapabilities.ownerIndependentViews
            ? "Inspect actual presented WebGPU frames; independent multi-view and orthographic capture are unavailable."
            : goal,
        tools: availableCapabilities(...tools),
      })),
      capabilities: Object.fromEntries(Object.entries(toolFamilies)
        .map(([name, names]) => [name, availableCapabilities(...names)])),
      modelingContract: {
        format: "oriel.modeling-contract/1",
        partShapes: [...partFields.shape.enum],
        primitiveKinds: primitiveSchema.oneOf.map(({ properties }) => properties.kind.const),
        hierarchyTransforms: {
          tools: ["part_add", "parts_add", "part_edit"],
          field: "space",
          supportedSpaces: ["local", "world"],
          defaultSpace: "local",
          parentedLocalCoordinatesInheritParentTranslationRotationAndScale: true,
          worldCoordinatesCompensateCompleteParentTransform: true,
          worldSizeAndScaleCompensateNonuniformParentScaling: true,
          batchDefaultField: "space",
          perPartField: "parts[].space",
          perPartOverridesBatchDefault: true,
          worldSpaceCannotBeCombinedWithSocketOrAttachmentPlacement: true,
          inspectParentChainAndActualLocalWorldBoundsImmediately: true,
          preferWorldSpaceForAuthoredCharacterAnatomy: true,
          noninvertibleParentOrRequiredShearFailsAtomically: true,
          unsupportedTransformCode: "UNSUPPORTED_TRANSFORM",
        },
        primitiveAuthoring: {
          namedSphere: { tool: "part_add", shape: "sphere",
            segments: { field: "segments", minimum: 3, maximum: 128 },
            heightSegments: { minimum: 2, maximum: 128 } },
          editableUvSphere: { tool: "mesh_create", wrapper: "primitive",
            kind: "uvSphere", widthSegments: { minimum: 3, maximum: 128 },
            heightSegments: { minimum: 2, maximum: 128 },
            createsNewEntityOnly: true },
          sceneNativePrimitive: { operation: "add_primitive",
            fields: ["shape", "radius"],
            segments: { minimum: 1, maximum: 32,
              supportedShapes: ["beveledBox"] }, nestedPrimitive: false },
          sceneEditablePrimitive: { operation: "mesh_create",
            requiredEntityId: true, wrapper: "primitive",
            highResolutionSphere: { kind: "uvSphere", widthSegments: 128,
              heightSegments: 128 } },
          automaticallyClampsUnsupportedSegments: false,
        },
        starterCube: { autoReplacement: "first_qualifying_authored_geometry_only",
          preserveModifiedOrRetainedCube: true,
          inspectExistingCubeBeforeRemoval: true,
          explicitRemovalOfMissingCube: "NOT_FOUND",
          transactionReceipt: "starterStatus_when_authenticated" },
        sphericalUv: { coordinateSpace: "entity_local",
          frontDirection: [0, 0, 1], frontU: 0.25, backU: 0.75,
          seamU: [0, 1], reflectedU: "mod(2 * 0.25 - u, 1)",
          scalingChangesWorldAppearanceNotUvCoordinates: true,
          worldSpaceMarkProjection: false,
          uncommittedMarkingPreview: materialAuthoring?.capabilities?.markingPreflight === true
            && typeof materialAuthoring.previewMarkings === "function"
            && typeof inspection?.previewMaterial === "function"
            && (() => {
              const native = typeof inspection?.getCapabilities === "function"
                ? inspection.getCapabilities() : inspection?.capabilities;
              return native?.materialPreview === true
                && native.surfaceMaterialPreview === true
                && Array.isArray(native.materialPreviewViews)
                && native.materialPreviewViews.includes("front")
                && native.materialPreviewViews.includes("right");
            })(),
          defaultForGeneratedSphere: "spherical",
          northPoleV: 1, southPoleV: 0,
          increasingVPhysicalDirection: "+Y",
          imageRowOrigin: "top", imageRowsIncrease: "down",
          imageRowConventionIsNotPhysicalVerticalDirection: true,
          inspectTool: "mesh_inspect", existingEntityEditTool: "material_set" },
        ...(materialAuthoring?.capabilities?.proceduralMarkings === true ? {
          surfaceMarkings: { tool: "material_create", genuinePngTexture: true,
            resolution: [128, 256, 512], maximumSourceMarks: 32,
            maximumMirroredMarks: 64, mirrorAxisU: 0.25,
            committedTexelFeedback: true, cameraVisibilityIsMeasured: false,
            uncommittedPreview: materialAuthoring.capabilities.markingPreflight === true
              && typeof materialAuthoring.previewMarkings === "function"
              && typeof inspection?.previewMaterial === "function"
              && (() => {
                const native = typeof inspection?.getCapabilities === "function"
                  ? inspection.getCapabilities() : inspection?.capabilities;
                return native?.materialPreview === true
                  && native.surfaceMaterialPreview === true
                  && Array.isArray(native.materialPreviewViews)
                  && native.materialPreviewViews.includes("front")
                  && native.materialPreviewViews.includes("right");
              })(),
            atomicAssignment: materialAuthoring.capabilities.atomicMaterialAssignment === true,
            ...(materialAuthoring.capabilities.semanticMarkingLandmarks === true ? {
              semanticLandmarks: { leftEye: [0.17, 0.56],
                rightEye: [0.33, 0.56], nose: [0.25, 0.44], mouth: [0.25, 0.34] },
          semanticVerticalOrder: ["leftEye", "rightEye", "nose", "mouth"],
              imageRowsIncreaseDownwardButMeshVIncreasesTowardTop: true,
              landmarkAndCenterAreExclusive: true,
              semanticCriticalWarningsBlockCommit: true,
              explicitRawCenterWarningsDoNotBlockCommit: true,
              nestedFeatureLayersAreInformational: true,
              actionableRepairSuggestionsAreBounded: true,
              unknownUvOrientationRequiresExplicitAcknowledgment: true,
              acknowledgmentField: "markings.acknowledgeUnverifiedUv",
            } : {}),
            ...(materialAuthoring.capabilities.markingPreflight === true
              && typeof materialAuthoring.previewMarkings === "function" ? {
                previewTool: "material_inspect",
                previewIsIsolatedTargetWithoutSceneOccluders: true,
              } : {}),
          },
        } : {}),
        characterMarkingWorkflow: {
          inspectActiveUvMappingFirst: true,
          explicitlyAutoMappingIsNotVerifiedSpherical: true,
          testOneSemanticLandmarkBeforeBulkAuthoring:
            materialAuthoring?.capabilities?.semanticMarkingLandmarks === true,
          requiredPreviewViews: ["front", "right"],
          stopOnIncorrectPreview: true,
          neverCommitOrAddFeaturesAfterIncorrectPreview: true,
          correctRecipeAndRecaptureBeforeContinuing: true,
          unresolvedCriticalWarningsBlockCommit: true,
          avoidOversizedDetachedMuzzlePlates: true,
          isolatedPreviewIncludesSurroundingSceneOccluders: false,
        },
        nativePrimitiveAuthoring: {
          capsule: { size: "[diameter,totalHeight,diameter]",
            totalHeightMustExceedDiameter: true,
            cylindricalSectionHeight: "totalHeight - diameter",
            defaultActualDimensions: [1, 2, 1],
            rejectsConflictingExplicitDimensions: true },
          cylinder: { size: "[diameter,height,diameter]",
            rejectsAnisotropicRadialSize: true },
          tessellationSegmentsSupportedShapes: ["beveledBox"],
          preflightDimensionsAreOwnerProjectedGeometry: true,
          inspectCommittedBoundsBeforeAddingFeatures: true,
          mappingEditsRequireEditableMeshConversion: true,
          conversionTool: "part_convert", conversionOperation: "mesh_convert",
        },
        semanticSculpt: { tool: "part_feature", feature: "sculpt",
          requires: ["region", "move"],
          atomicStrokeBatch: { field: "strokes", maximum: MAX_CONTROL_BATCH_OPERATIONS,
            requires: ["region", "move"], mutuallyExclusiveWithSingleStroke: true },
          bareFaceRegionAliasesNormalizeToFaceNamespace: true,
          dottedFaceRegionAliasesNormalizeToFaceNamespace: true,
          requiresControlCage: false,
          rejects: ["radius", "amount", "strength"],
          moveMustBeNonzero: true,
          characterFaceRequiresConnectedBoundedThreeDimensionalTopology: true,
          minimumIndexedVertices: 12,
          minimumEditableFaces: 8,
          recommendedSphereSegments: 24,
          recommendedSphereHeightSegments: 16,
          nativeSphereConvertsAtomicallyDuringSemanticEditing: true,
          unsupportedFeatureCode: "UNSUPPORTED_FEATURE",
          unsupportedFeatureIncludesActionableRepair: true },
        semanticFaceEditing: {
          tool: "part_feature",
          feature: "sculpt",
          acceptedRegionSelectors: ["face.region", "face:region",
            "unambiguous_bare_region", "face_region"],
          canonicalRegionSelector: "face:region",
          exactExamples: ["face.brow", "face.cheek_left", "face.muzzle"],
          targetEligibility: "connected_bounded_three_dimensional_editable_topology",
          minimumIndexedVertices: 12,
          minimumEditableFaces: 8,
          acceptsEligibleGeneratedMeshes: true,
          acceptsEligibleConvertibleNativePrimitives: true,
          acceptsEligibleImportedEditableMeshes: true,
          preservesRequiredImportedSurfaceFidelity: true,
          unsupportedImportedSurfaceFidelityCode: "UNSUPPORTED_FIDELITY",
          requiresSubjectClassification: false,
          requiresSpecificPrimitiveShape: false,
          unknownFaceRegionReason: "UNKNOWN_FACE_REGION",
          unknownSemanticRegionReason: "UNKNOWN_SEMANTIC_REGION",
          unknownRegionsIncludeModelNeutralRepair: true,
          genericSpatialSculpt: {
            tools: availableCapabilities("mesh_apply_batch", "scene_apply_batch"),
            operation: "sculpt",
            requires: ["center", "extents", "translation"],
            arbitrarySemanticRecognition: false,
          },
        },
        curves: { interpolation: ["linear", "centripetalCatmullRom"],
          correspondingPlanarProfiles: true,
          editableControlCages: persistentControlCages,
          curvatureContinuity: false, unequalProfileLandmarks: true,
          profileAlignment: true,
          ...(editableCurveAuthoring ? { editableProfiles: true,
            continuity: ["C0", "G0", "G1"], stableControlIds: true } : {}) },
        constructive: { requiresClosedManifold: true, requiresOutwardWinding: true,
          requiresPlanarConvexFaces: false, requiresConvexFaces: true,
          acceptsNonplanarQuads: true, preservesImportedSurfaceAttributes: false,
          ...(persistentControlCages ? { preservesActiveControlCages: true,
            replayableCutterStacks: true } : {}),
          surfaceBlend: { contact: "opposed_coplanar_touching_or_intersecting_curved",
            transition: "rounded", defaultRadius: 0.018,
            defaultSegments: 3, minimumSegments: 1, maximumSegments: 4,
            preservesSourceChildren: true },
          ephemeralCutter: { createsSceneEntity: false, keepToolFalseAccepted: true,
            keepToolTrueAccepted: false } },
        semanticEditing: { supportedGeneratedVehicleRegions: true,
          supportedCharacterFaceRegions: true,
          arbitraryImportedFeatureRecognition: false, symmetrySpace: "entity_local",
          ...(ongoingReflectionSymmetry ? { ongoingSymmetry: true } : {}) },
        roundedBox: { maximumBevel: "min(size) / 2, exclusive",
          repair: "explicit_opt_in" },
      },
      materialPolicy: {
        inspectExistingLibraryFirst: false,
        libraryTools: availableCapabilities("material_samples_list",
          "material_sample_inspect", "material_sample_apply"),
        reuseMatchingExistingMaterials: true,
        requireAppropriateTexturedPbrFinish: true,
        preserveSuitableImportedMaterials: true,
        rawMaterialException: "Only when the user explicitly requests clay, wireframe, an unfinished study, or an untextured presentation.",
      },
      experimentationPolicy: {
        approach: "try-render-refine-repeat",
        authoredEditsHaveUndoHistory: true,
        historyTools: availableCapabilities("scene_undo", "scene_redo"),
        explore: ["geometry", "materials", "lighting", "composition"],
        inspectGenuineRenderedViews: true,
        replaceUnsuccessfulIdeas: true,
        retryBeforeDeclaringUnsupported: true,
        preserveUnrelatedUserWork: true,
      },
      cameraGuidancePolicy: {
        tool: availableToolNames.has("camera_guide") ? "camera_guide" : null,
        indirectRoute: "action_read",
        enabledByDefault: true,
        movesActualVisibleCamera: true,
        transientViewportOnly: true,
        serialized: false,
        persistsAcrossReload: false,
        changesSceneRevision: false,
        createsUndoEntry: false,
        triggersAutosave: false,
        explicitPersistentCameraTool: "camera_set",
        respectUserOptOut: true,
        userInteractionTakesPriority: true,
        yieldOn: ["orbit", "pan", "zoom", "pointer interaction"],
        preferenceKey: "codex-modeling.camera-guidance",
        preferenceValues: ["on", "off"],
        preferenceChangeEvent: "codex:camera-guidance-change",
        disabledCode: "CAMERA_GUIDANCE_DISABLED",
        activeUserCode: "USER_CAMERA_ACTIVE",
      },
        finalQualityGate: {
        requireMaterialLibraryReview: false,
        requirePolishedMaterializedObject: true,
        requireGenuineRenderedFrame: true,
        minimumDistinctViewsForComplexAssets: 3,
        reviewTool: availableToolNames.has("render_contact_sheet")
          ? "render_contact_sheet" : "render_capture",
        incompleteStatus: "needs_more_work",
        completeStatus: "production_ready",
        primitiveCountIsNotEvidenceOfCompletion: true,
        continueAuthoringUntilVisibleDefectsAreResolved: true,
        inspectMeasuredPrimaryFormBoundsImmediately: true,
        inspectActualParentChainAndWorldAttachmentContacts: true,
        unexpectedInheritedScaleOrDetachedAnatomyBlocksCompletion: true,
        relativeEntityProportionFindingBlocksCompletion: true,
        partialCharacterAnatomyBlocksRequestedFullBodyCompletion: true,
        automatedAestheticCertification: false,
        requiresRecaptureAfterCorrections: true,
        requestedFinalViewportIsSeparateFromOwnerPreservingReview: true,
        unavailableEvidence: ["depth_buffer", "entity_id_buffer",
          ...(materialAuthoring?.capabilities?.markingPreflight === true
            && typeof materialAuthoring.previewMarkings === "function"
            && typeof inspection?.previewMaterial === "function"
            && (() => {
              const native = typeof inspection?.getCapabilities === "function"
                ? inspection.getCapabilities() : inspection?.capabilities;
              return native?.materialPreview === true
                && native.surfaceMaterialPreview === true
                && Array.isArray(native.materialPreviewViews)
                && native.materialPreviewViews.includes("front")
                && native.materialPreviewViews.includes("right");
            })() ? [] : ["uncommitted_uv_preview"]),
          "arbitrary_surface_region_projection"],
        evaluate: ["requested subject and silhouette", "proportions and topology",
          "continuous primary surfaces and integrated transitions",
          "actual openings, attachment alignment, and absence of floating or intersecting parts",
          "actual assigned materials and appropriate texture detail", "roughness, metallic response, transmission, and surface variation",
          "intentional lighting and camera framing", "reference fidelity and presentation polish from every required viewpoint"],
        reject: ["unfinished default-gray model", "unassigned or missing material",
          "missing or obviously broken texture", "unreviewed render", "visible unfinished placeholder",
          "stacked primitive kitbash standing in for a continuous complex form",
          "disconnected, floating, protruding, or unintentionally intersecting parts",
          "measured primary-form proportions outside the explicit design brief",
          "missing requested torso, limbs, feet, ears, or integrated facial features",
          "solid fake openings, unreadable lighting, or unresolved visible design defects",
          "completion claimed after identifying flaws without corrective authoring"],
        explicitUserOverride: "The user specifically requested an unfinished, clay, wireframe, untextured, low-poly, toy, or intentionally stylized result; preserve that intentional style without excusing unrelated visible defects.",
      },
      ambiguousCameraGuidanceRecovery: {
        timeoutDoesNotProveCameraMoved: true,
        inspectCurrentOwnerAndVisiblePoseFirst: true,
        retryOnlyWhenOwnerCurrentAndPoseWasNotApplied: true,
        neverAutomaticallyReplayUncertainMovement: true,
        neverMutateAuthoredCameraToRecoverTransientGuidance: true,
      },
      feedbackPolicy: {
        tool: availableToolNames.has("tooling_feedback_report")
          ? "tooling_feedback_report" : null,
        categories: ["missing_feature", "papercut"],
        guidance: "Try reasonable combinations of available tools first, then silently report genuine missing capabilities or workflow friction with concrete reproduction details; never interrupt the user, expose private scene data, or claim an unsupported operation succeeded.",
      },
      refinementPolicy: "Treat modeling as an exploratory loop: authored edits have undo history, so freely try geometry, material, lighting, and composition alternatives and retry. Browse or reuse materials when relevant; capture genuine GPU views, critique the result, refine it, and capture again. For complex assets inspect at least three distinct views; visible defects require needs_more_work and further actual modeling calls, never a premature production_ready claim.",
      visualInspection: {
        tool: "render_capture",
        imageSource: "genuinely-presented-webgpu-frame",
        encoding: "base64",
        mediaTypes: ["image/png", "image/jpeg"],
        resultFields: ["base64", "mediaType", "width", "height", "byteLength",
          "revision", "capturedAt"],
        maximumInlineBytes: MAX_INLINE_ARTIFACT_BYTES,
        localCaptureCommand: "npm run webmcp -- capture --output /tmp/model.png",
        chromePluginScreenshotRequired: false,
        browserDownloadRequired: false,
      },
      completionCriteria: ["actual WebGPU renderer ready", "requested model geometry genuinely authored or imported",
        "complex primary forms are continuous, integrated, and not merely stacked placeholder primitives",
        "appropriate existing, custom, or imported materials reused when relevant",
        "actual textured physically based materials assigned, tuned, and visually polished",
        "real presented or isolated frames inspected from at least three distinct viewpoints for complex assets and remaining visible defects corrected",
        "finished model materially complete, presentation-ready, and faithful to the user's brief",
        "production_ready is claimed only after the actual visual critique has no substantive unresolved defect",
        "requested single or grouped GLB genuinely prepared when export is requested"],
      observerPolicy: "Do not ask the user to perform scene editing. Visible scene, revision, tool activity, and optional explicit download are observer feedback.",
      cliTransport: {
        mode: "webmcp-drop-in",
        discovery: "native-webmcp-first",
        nativeSurfaces: ["document.modelContext", "navigator.modelContext"],
        fallback: "same-page-registered-tool-descriptors",
        fallbackSurface: "window.__orielWebMcpPageTools",
        fallbackMethods: ["listTools", "describeTool", "executeTool"],
        defaultDebuggerEndpoint: "http://127.0.0.1:9222",
        defaultTargetOrigin: "https://codex-modeling-studio.openai.chatgpt.site",
        endpointEnvironmentVariable: "ORIEL_WEBMCP_CDP_URL",
        originEnvironmentVariable: "ORIEL_WEBMCP_TARGET_ORIGIN",
        commands: ["npm run webmcp -- list", "npm run webmcp -- status",
          "npm run webmcp -- instructions", "npm run webmcp -- describe part_add",
          "npm run webmcp -- call part_add <JSON>",
          "npm run webmcp -- capture --output /tmp/model.png"],
        exampleCall: {
          command: "npm run webmcp -- call part_add",
          input: { name: "Body", shape: "rounded_box", size: [2, 1, 1],
            material: "Brushed Aluminum" },
        },
        imageCapture: {
          command: "npm run webmcp -- capture --output /tmp/model.png",
          tool: "render_capture",
          output: "/tmp/model.png",
          source: "actual-presented-webgpu-frame",
          chromePluginScreenshotRequired: false,
          browserDownloadRequired: false,
        },
        observerLifecycle: "same-actual-tool-invocations",
        separateSceneApi: false,
      },
      availableTools: [...availableToolNames],
    };
    },
  });

  add({ name: "listDocs",
    title: "List modeling references",
    description: "List modeling, visual-review, and scene references.",
    inputSchema: emptySchema,
    readOnlyHint: true,
    untrustedContentHint: false,
    handle: () => ({ documents: Object.entries(documentation)
      .map(([id, document]) => ({ id, title: document.title })) }),
  });

  add({ name: "getDoc",
    title: "Read modeling authoring reference",
    description: "Read one modeling, quality, rendering, or revision guide.",
    inputSchema: closedObject({
      id: enumText(Object.keys(documentation)),
    }, ["id"]),
    readOnlyHint: true,
    untrustedContentHint: false,
    handle: ({ id }) => ({ id, ...documentation[id],
      ...(id === "modeling" ? {
        body: `${documentation[id].body}${semanticFaceModelingGuidance}`,
      } : {}) }),
  });

  add({ name: "status",
    title: "Inspect modeling readiness",
    description: "Inspect WebGPU readiness, materials, assets, selection, and committed revision.",
    inputSchema: emptySchema,
    readOnlyHint: true,
    untrustedContentHint: false,
    handle: () => {
      const current = state(store);
      const ownership = projectOwnership();
      return {
        revision: current.revision,
        selection: current.selection,
        ...sceneInventory(store, current),
        canUndo: current.canUndo === true,
        canRedo: current.canRedo === true,
        runtime: runtimeStatus(runtime),
        ...(ownership === undefined ? {} : { ownership }),
      };
    },
  });

  const feedbackReportFields = {
    category: enumText(["missing_feature", "papercut"]),
    summary: text(240),
    details: text(2_000),
    toolName: { ...text(128), pattern: "^[A-Za-z0-9_.-]{1,128}$" },
    workflowStage: text(80),
    severity: enumText(["low", "medium", "high"]),
  };
  const feedbackReport = closedObject(feedbackReportFields, ["category", "summary"]);
  const feedbackIdempotencyKey = { ...text(36, 36),
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
  const feedbackReports = { type: "array", minItems: 1, maxItems: 20,
    items: feedbackReport };
  add({ name: "tooling_feedback_report",
    title: "Report modeling tool feedback",
    description: "Privately report one missing modeling capability or workflow papercut, or batch 1–20 bounded reports with an optional idempotency key; never send scene, asset, project, or identity data.",
    inputSchema: closedObject({ ...feedbackReportFields,
      reports: feedbackReports, idempotencyKey: feedbackIdempotencyKey }, [], {
      oneOf: [
        closedObject({ ...feedbackReportFields,
          idempotencyKey: feedbackIdempotencyKey }, ["category", "summary"]),
        closedObject({ reports: feedbackReports,
          idempotencyKey: feedbackIdempotencyKey }, ["reports"]),
      ],
    }),
    readOnlyHint: true,
    untrustedContentHint: true,
    background: true,
    handle: (input, signal) => (toolFeedback ?? reportToolFeedback)(input,
      ...(signal === undefined ? [] : [{ signal }])),
  });

  const getActiveProject = projectController?.getActiveProject
    ?? projectController?.getCurrentProject;
  const prepareGroupedExport = async (input, signal) => {
    if (input.profile !== GAME_ASSET_EXPORT_PROFILE) {
      return exportAssets.exportGroup({ ...input,
        ...(signal === undefined ? {} : { signal }) });
    }
    const dataset = scope.document?.documentElement?.dataset;
    const recordedGeneration = dataset?.orielProjectGeneration;
    if (recordedGeneration !== undefined
        && (!/^(?:0|[1-9][0-9]*)$/u.test(recordedGeneration)
          || !Number.isSafeInteger(Number(recordedGeneration)))) {
      throw new StudioToolError("STALE_PROJECT",
        "Strict game-asset export requires a genuine current modeling project generation.");
    }
    const project = typeof getActiveProject === "function"
      ? await getActiveProject.call(projectController) : undefined;
    const projectGeneration = Number.isSafeInteger(project?.projectGeneration)
      ? project.projectGeneration
      : recordedGeneration === undefined ? undefined : Number(recordedGeneration);
    if (recordedGeneration !== undefined
        && String(projectGeneration) !== recordedGeneration) {
      throw new StudioToolError("STALE_PROJECT",
        "The active modeling project changed before strict game-asset export.");
    }
    const committedRevision = typeof store.getRevision === "function"
      ? store.getRevision() : undefined;
    const artifact = await exportAssets.exportGroup({ ...input,
      ...(input.expectedRevision === undefined && committedRevision !== undefined
        ? { expectedRevision: committedRevision } : {}),
      ...(signal === undefined ? {} : { signal }) });
    if (recordedGeneration !== undefined
        && dataset.orielProjectGeneration !== recordedGeneration) {
      throw new StudioToolError("STALE_PROJECT",
        "The active modeling project changed during strict game-asset export.");
    }
    const result = { ...artifact,
      ...(typeof project?.projectId === "string" ? { projectId: project.projectId } : {}),
      ...(projectGeneration === undefined ? {} : { projectGeneration }) };
    const authority = Object.getOwnPropertyDescriptor(artifact,
      OWNER_GROUPED_EXPORT_AUTHORITY);
    if (authority) {
      Object.defineProperty(result, OWNER_GROUPED_EXPORT_AUTHORITY, authority);
    }
    return result;
  };
  if (typeof getActiveProject === "function") {
    add({ name: "project_active",
      title: "Inspect active modeling project",
      description: "Read browser-local project identity and state without exposing scene contents.",
      inputSchema: emptySchema,
      readOnlyHint: true,
      untrustedContentHint: true,
      handle: async () => {
        const current = await getActiveProject.call(projectController);
        const ownership = projectOwnership();
        return ownership === undefined ? current : { ...current, ownership };
      },
    });
  }

  if (typeof projectController?.listProjects === "function") {
    add({ name: "project_list",
      title: "List saved modeling projects",
      description: "List consented device-local projects without exposing scene contents.",
      inputSchema: emptySchema,
      readOnlyHint: true,
      untrustedContentHint: true,
      handle: () => projectController.listProjects(),
    });
  }

  if (typeof projectController?.createProject === "function") {
    add({ name: "project_create",
      title: "Create a modeling project",
      description: "Create and open a consented device-local project after saving the current scene.",
      inputSchema: closedObject({ name: text(80) }, ["name"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input) => projectController.createProject(input),
    });
  }

  if (typeof projectController?.openProject === "function") {
    add({ name: "project_open",
      title: "Open a saved modeling project",
      description: "Save the current scene and open one consented device-local project.",
      inputSchema: closedObject({ projectId: {
        ...text(128), pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      } }, ["projectId"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input) => projectController.openProject(input),
    });
  }

  if (typeof projectController?.acquireProject === "function") {
    add({ name: "project_acquire",
      title: "Acquire modeling project editing access",
      description: "Acquire a released local writer; never replace another tab's active writer.",
      inputSchema: emptySchema,
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (_input, signal) => projectController.acquireProject(
        signal === undefined ? {} : { signal }),
    });
  }

  if (typeof projectController?.renameProject === "function") {
    add({ name: "project_rename",
      title: "Rename a saved modeling project",
      description: "Rename a consented local project; preserve its scene and assets.",
      inputSchema: closedObject({
        projectId: { ...text(128), pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
        name: text(80),
      }, ["name"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input) => projectController.renameProject(input),
    });
  }

  if (typeof projectController?.deleteProject === "function") {
    add({ name: "project_delete",
      title: "Delete one explicitly confirmed project",
      description: "Permanently delete one inactive local project only with confirm:true; preserve active and last projects.",
      inputSchema: closedObject({
        projectId: { ...text(128), pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
        confirm: { type: "boolean", const: true },
      }, ["projectId", "confirm"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      destructiveHint: true,
      handle: (input) => projectController.deleteProject(input),
    });
  }

  add({ name: "scene_get",
    title: "Inspect the authored modeling scene",
    description: "Inspect actual meshes, assets, selection, and committed revision.",
    inputSchema: closedObject({
      entityId: identifier(),
      maxEntities: integer(1, 256),
      includeComponents: { type: "boolean" },
    }),
    readOnlyHint: true,
    untrustedContentHint: true,
    handle: (input) => entityResult(store, input),
  });

  for (const [operation, title, description] of [
    ["undo", "Undo an authored modeling change",
      "Restore the previous genuine scene, selection, geometry, and assets from bounded undo history after native renderer acceptance; reject stale revisions and empty history."],
    ["redo", "Redo an authored modeling change",
      "Restore the next genuine scene, selection, geometry, and assets from bounded redo history after native renderer acceptance; reject stale revisions and empty history."],
  ]) {
    if (typeof store[operation] !== "function") continue;
    add({ name: `scene_${operation}`,
      title,
      description,
      inputSchema: closedObject(expectedRevisionField),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: async (input, signal) => {
        const committed = await store[operation](mutationOptions(input, signal));
        const current = state(store);
        return { ...summarizeMutation(committed, store),
          canUndo: current.canUndo === true, canRedo: current.canRedo === true };
      },
    });
  }

  add({ name: "scene_apply_batch",
    title: "Apply atomic scene edits",
    description: "Atomically create, smooth, sculpt, sweep, spline-loft, reflect, combine, or seamlessly blend supported meshes; edit materials, transforms, lights, and hierarchy.",
    inputSchema: closedObject({
      operations: {
        type: "array",
        minItems: 1,
        maxItems: MAX_BATCH_OPERATIONS,
        items: compactSceneOperation,
      },
      ...expectedRevisionField,
    }, ["operations"]),
    readOnlyHint: false,
    untrustedContentHint: true,
    validate: (input) => {
      for (const [index, operation] of input.operations.entries()) {
        const path = `input.operations[${index}]`;
        validateSchema(operation, sceneOperationSchema, path);
        validateSceneOperation(operation, path);
        if (operation.op === "mesh_boolean") {
          validateConstructiveOptions(operation, path);
        }
      }
    },
    handle: async (input, signal) => {
      return summarizeMutation(await store.applyBatch(input.operations,
        mutationOptions(input, signal)), store);
    },
  });

  if (typeof store.preflightBatch === "function") {
    add({ name: "scene_preflight_batch",
      title: "Preflight atomic scene or mesh edits",
      description: "Validate ordered scene edits or mesh-modeling operations against the current authored project without changing the scene, renderer, revision, history, selection, or device checkpoint.",
      inputSchema: closedObject({
        entityId: identifier(),
        operations: {
          type: "array",
          minItems: 1,
          maxItems: MAX_MESH_BATCH_OPERATIONS,
          items: compactPreflightOperation,
        },
        ...expectedRevisionField,
      }, ["operations"]),
      readOnlyHint: true,
      untrustedContentHint: true,
      validate: (input) => {
        const mesh = input.entityId !== undefined;
        if (!mesh && input.operations.length > MAX_BATCH_OPERATIONS) {
          invalid(`must contain at most ${MAX_BATCH_OPERATIONS} items`, "input.operations");
        }
        for (const [index, operation] of input.operations.entries()) {
          const path = `input.operations[${index}]`;
          validateSchema(operation, mesh ? meshOperationSchema : sceneOperationSchema, path);
          if (mesh) validateMeshOperation(operation, path);
          else validateSceneOperation(operation, path);
          if (!mesh && operation.op === "mesh_boolean") {
            validateConstructiveOptions(operation, path);
          }
        }
      },
      handle: async (input, signal) => {
        const mesh = input.entityId !== undefined;
        const operations = mesh ? [{
          op: "mesh_edit_batch",
          entityId: input.entityId,
          operationSpecs: input.operations.map(({ op, ...operation }) => ({
            operation: op,
            ...operation,
          })),
        }] : input.operations;
        const result = await store.preflightBatch(operations, mutationOptions(input, signal));
        return {
          ...result,
          mode: mesh ? "mesh" : "scene",
          operationCount: input.operations.length,
        };
      },
    });
  }

  add({ name: "mesh_create",
    title: "Create editable polygon mesh",
    description: "Create a new editable mesh; entityId must be unused. Axial primitive axes are local +Y.",
    inputSchema: closedObject({
      primitive: primitiveSchema,
      name: text(),
      entityId: identifier(),
      parent: nullable(identifier()),
      ...transformFields,
      material: closedObject(materialFields),
      shading: { enum: ["smooth", "flat"] },
      uvMapping: uvMappingSchema,
      ...expectedRevisionField,
    }, ["primitive"]),
    readOnlyHint: false,
    untrustedContentHint: true,
    validate: ({ primitive }) => {
      if (primitive.kind === "capsule") {
        validateEditableCapsuleDimensions(primitive, { path: "input.primitive" });
      }
      if (primitive.kind === "lathe") {
        validateLatheProfile(primitive.profile, "input.primitive.profile");
      }
    },
    handle: async (input, signal) => {
      const { expectedRevision, ...mesh } = input;
      return summarizeMutation(await store.createMesh({
        name: `${mesh.primitive.kind[0].toUpperCase()}${mesh.primitive.kind.slice(1)} Mesh`,
        ...mesh,
      }, mutationOptions(input, signal)), store);
    },
  });

  add({ name: "mesh_inspect",
    title: "Inspect editable polygon topology",
    description: "Inspect actual GLB topology and available cage, curve, or symmetry controls.",
    inputSchema: closedObject({
      entityId: identifier(),
      includeTopology: { type: "boolean" },
      ...(durableModelingInspection ? { includeControls: { type: "boolean" } } : {}),
      maxVertices: integer(1, MAX_SELECTION),
      maxFaces: integer(1, MAX_SELECTION),
    }, ["entityId"]),
    readOnlyHint: true,
    untrustedContentHint: true,
    handle: (input) => meshInspection(store, input),
  });

  add({ name: "mesh_extrude",
    title: "Extrude selected polygon faces",
    description: "Extrude a bounded unique face selection and publish updated indexed geometry to the live modeling renderer.",
    inputSchema: meshEditSchema({ faces: selection(), distance: finite() },
      ["faces", "distance"]),
    readOnlyHint: false,
    untrustedContentHint: true,
    handle: async (input, signal) => summarizeMutation(await store.editMesh(
      input.entityId, { operation: "extrude", faces: input.faces,
        distance: input.distance }, mutationOptions(input, signal)), store),
  });

  add({ name: "mesh_inset",
    title: "Inset selected polygon faces",
    description: "Inset a bounded face selection, optionally offset its depth, and preserve stable generated GLB identity.",
    inputSchema: meshEditSchema({
      faces: selection(),
      amount: positive(),
      depth: finite(),
    }, ["faces", "amount"]),
    readOnlyHint: false,
    untrustedContentHint: true,
    handle: async (input, signal) => summarizeMutation(await store.editMesh(
      input.entityId, { operation: "inset", faces: input.faces,
        amount: input.amount, ...(input.depth === undefined ? {} : {
          depth: input.depth,
        }) }, mutationOptions(input, signal)), store),
  });

  add({ name: "mesh_bevel",
    title: "Bevel selected mesh edges",
    description: "Bevel a bounded unique edge selection by a positive width and regenerate genuine polygon topology.",
    inputSchema: meshEditSchema({
      edges: {
        type: "array",
        minItems: 1,
        maxItems: MAX_SELECTION,
        uniqueItems: true,
        items: vector(2, integer(0, MAX_VERTICES - 1)),
      },
      amount: positive(),
    }, ["edges", "amount"]),
    readOnlyHint: false,
    untrustedContentHint: true,
    handle: async (input, signal) => summarizeMutation(await store.editMesh(
      input.entityId, { operation: "bevel", edges: input.edges,
        amount: input.amount }, mutationOptions(input, signal)), store),
  });

  add({ name: "mesh_subdivide",
    title: "Subdivide polygon topology",
    description: "Refine actual polygons or coarse cages; preserve supported creases and bounds.",
    inputSchema: meshEditSchema({ faces: selection(), levels: integer(1, 6),
      smooth: { type: "boolean" }, strength: unit(),
      creaseAngleDegrees: finite(0, 180),
      ...(persistentControlCages ? { cageId: identifier(),
        scheme: enumText(["catmullClark", "loop"]) } : {}) }),
    readOnlyHint: false,
    untrustedContentHint: true,
    validate: (input) => {
      if (input.cageId === undefined) {
        if (input.scheme !== undefined) invalid("requires cageId", "input.scheme");
        validateMeshOperation({ op: "subdivide", ...input });
        return;
      }
      if (input.cageId !== input.entityId) {
        invalid("must match the modeled entity", "input.cageId");
      }
      if (input.faces !== undefined) invalid("is unavailable for control cages", "input.faces");
      if (input.smooth !== undefined) invalid("is unavailable for control cages", "input.smooth");
      if (!["levels", "scheme", "strength", "creaseAngleDegrees"]
        .some((field) => input[field] !== undefined)) {
        invalid("requires at least one actual subdivision setting", "input.cageId");
      }
    },
    handle: async (input, signal) => {
      if (input.cageId !== undefined) {
        const operation = { action: "subdivide",
          ...Object.fromEntries(["scheme", "levels", "strength", "creaseAngleDegrees"]
            .filter((field) => input[field] !== undefined)
            .map((field) => [field, input[field]])) };
        return summarizeMutation(await store.editControlCage(input.entityId,
          operation, mutationOptions(input, signal)), store);
      }
      return summarizeMutation(await store.editMesh(input.entityId,
        { operation: "subdivide",
          ...(input.faces === undefined ? {} : { faces: input.faces }),
          ...(input.levels === undefined ? {} : { levels: input.levels }),
          ...(input.smooth === undefined ? {} : { smooth: input.smooth }),
          ...(input.strength === undefined ? {} : { strength: input.strength }),
          ...(input.creaseAngleDegrees === undefined ? {} : {
            creaseAngleDegrees: input.creaseAngleDegrees }),
        }, mutationOptions(input, signal)), store);
    },
  });

  add({ name: "mesh_transform",
    title: "Transform selected mesh vertices",
    description: "Transform actual vertices or selected coarse-cage controls atomically.",
    inputSchema: meshEditSchema({
      vertices: selection(),
      translation: vector(3),
      rotate: vector(3, finite(-Math.PI * 200, Math.PI * 200)),
      rotationDegrees: vector(3, finite(-36_000, 36_000)),
      scale: vector(3, positive(1_000)),
      ...(persistentControlCages ? { cageId: identifier(), selection: controlSelection,
        radius: positive(), falloff: compactEnum(["constant", "linear", "smooth"]),
        protectBoundary: { type: "boolean" },
        protectCreases: { type: "boolean" } } : {}),
    }, [], { minProperties: 2,
      ...(persistentControlCages ? { oneOf: [
        { properties: { cageId: false, selection: false, radius: false } },
        { required: ["cageId"], anyOf: [{ required: ["selection"] },
          { required: ["vertices"] }] },
      ] } : {}) }),
    readOnlyHint: false,
    untrustedContentHint: true,
    validate: (input) => {
      if (input.cageId === undefined) {
        for (const field of ["selection", "radius", "falloff", "protectBoundary",
          "protectCreases"]) {
          if (input[field] !== undefined) invalid("requires cageId", `input.${field}`);
        }
        return;
      }
      if (input.cageId !== input.entityId) {
        invalid("must match the modeled entity", "input.cageId");
      }
      if (input.rotate !== undefined || input.rotationDegrees !== undefined) {
        invalid("does not support coarse control rotation", "input.cageId");
      }
      if ((input.translation === undefined) === (input.scale === undefined)) {
        invalid("requires exactly one translation or scale", "input.cageId");
      }
      if (input.selection === undefined && input.vertices === undefined) {
        invalid("requires actual coarse control selection", "input.selection");
      }
      if (input.selection !== undefined && input.vertices !== undefined) {
        invalid("cannot mix indexed and structured control selections", "input.selection");
      }
    },
    handle: async (input, signal) => {
      if (input.cageId !== undefined) {
        const operation = { action: input.translation === undefined ? "scale" : "move",
          selection: input.selection ?? { mode: "vertices", vertices: input.vertices },
          ...(input.translation === undefined ? { scale: input.scale }
            : { translation: input.translation }),
          ...Object.fromEntries(["radius", "falloff", "protectBoundary", "protectCreases"]
            .filter((field) => input[field] !== undefined)
            .map((field) => [field, input[field]])) };
        return summarizeMutation(await store.editControlCage(input.entityId,
          operation, mutationOptions(input, signal)), store);
      }
      const { entityId, expectedRevision, ...operation } = input;
      if (!["translation", "rotate", "rotationDegrees", "scale"]
        .some((field) => Object.hasOwn(operation, field))) {
        throw new StudioToolError("INVALID_ARGUMENT",
          "Mesh transform requires translation, rotate, rotationDegrees, or scale.");
      }
      return summarizeMutation(await store.editMesh(entityId, {
        operation: "transform", ...operation,
      }, mutationOptions(input, signal)), store);
    },
  });

  add({ name: "mesh_weld",
    title: "Weld neighboring mesh vertices",
    description: "Merge vertices within a positive bounded distance and regenerate the authored GLB and content digest.",
    inputSchema: meshEditSchema({ distance: positive() }, ["distance"]),
    readOnlyHint: false,
    untrustedContentHint: true,
    handle: async (input, signal) => summarizeMutation(await store.editMesh(
      input.entityId, { operation: "weld", distance: input.distance },
      mutationOptions(input, signal)), store),
  });

  add({ name: "material_set",
    title: "Adjust physically based material",
    description: "Explore actual PBR color, roughness, metallic response, emission, reflection, transmission, IOR, and attenuation; render the result and freely revise unsuccessful finishes.",
    inputSchema: closedObject({
      entityId: identifier(),
      ...materialFields,
      uvMapping: uvMappingSchema,
      ...expectedRevisionField,
    }, ["entityId"], { minProperties: 2 }),
    readOnlyHint: false,
    untrustedContentHint: true,
    validate: (input) => {
      if (Object.keys(withoutControlFields(input)).length === 0) {
        invalid("requires at least one material property; expectedRevision is not a material edit",
          "input.expectedRevision");
      }
    },
    handle: async (input, signal) => summarizeMutation(await store.setMaterial(
      input.entityId, withoutControlFields(input), mutationOptions(input, signal)), store),
  });

  add({ name: "light_set",
    title: "Adjust directional or point light",
    description: "Adjust actual directional or point-light color, intensity, range, and shadows.",
    inputSchema: closedObject({
      entityId: identifier(),
      ...lightFields,
      ...expectedRevisionField,
    }, ["entityId"], { minProperties: 2 }),
    readOnlyHint: false,
    untrustedContentHint: true,
    validate: (input) => {
      if (Object.keys(withoutControlFields(input)).length === 0) {
        invalid("requires at least one light property; expectedRevision is not a lighting edit",
          "input.expectedRevision");
      }
    },
    handle: async (input, signal) => summarizeMutation(await store.setLight(
      input.entityId, withoutControlFields(input), mutationOptions(input, signal)), store),
  });

  add({ name: "camera_set",
    title: "Adjust modeling camera and effects",
    description: "Refine the agent-authored asset presentation through real camera framing, look target, perspective/FOV, active state, HDR, and bloom.",
    inputSchema: closedObject({
      entityId: identifier(),
      ...cameraFields,
      ...expectedRevisionField,
    }, ["entityId"], { minProperties: 2 }),
    readOnlyHint: false,
    untrustedContentHint: true,
    validate: (input) => {
      if (Object.keys(withoutControlFields(input)).length === 0) {
        invalid("requires at least one camera property; expectedRevision is not a camera edit",
          "input.expectedRevision");
      }
      if (input.perspective !== undefined) {
        for (const field of ["verticalFovDegrees", "near", "far"]) {
          if (input[field] !== undefined
              && input.perspective[field] !== undefined
              && input[field] !== input.perspective[field]) {
            invalid(`conflicts with perspective.${field}; provide one consistent value`,
              `input.${field}`);
          }
        }
      }
      const near = input.perspective?.near ?? input.near;
      const far = input.perspective?.far ?? input.far;
      if (near !== undefined && far !== undefined && far <= near) {
        invalid("must exceed the near clipping plane", "input.far");
      }
    },
    handle: async (input, signal) => summarizeMutation(await store.setCamera(
      input.entityId, withoutControlFields(input), mutationOptions(input, signal)), store),
  });

  if (guidance) {
    add({ name: "camera_guide",
      title: "Guide your visible modeling camera",
      description: "Temporarily guide the visible camera without scene edits or saving; actual movement is reported and manual camera control always wins.",
      inputSchema: closedObject({ target: inspectionTarget, framing: ownerCameraFraming,
        ...expectedRevisionField }, ["target"]),
      readOnlyHint: true,
      untrustedContentHint: true,
      handle: async (input, signal) => {
        const result = await guidance.guide({ ...input,
          ...(signal === undefined ? {} : { signal }) });
        return { ...summarizeMutation(result, store),
          cameraMoved: result.cameraMoved ?? result.status !== "yielded",
          transient: true,
          ...(result.status === undefined ? {} : { status: result.status }),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          ...(result.targetReached === undefined ? {} : {
            targetReached: result.targetReached,
          }),
          ...(result.framesPresented === undefined ? {} : {
            framesPresented: result.framesPresented,
          }),
          ...(result.ownerCameraPreserved === undefined ? {} : {
            ownerCameraPreserved: result.ownerCameraPreserved,
          }),
          ...(result.sceneRevision === undefined ? {} : {
            sceneRevision: result.sceneRevision,
          }),
          ...(result.position === undefined ? {} : { position: result.position }),
          ...(result.lookAt === undefined ? {} : { lookAt: result.lookAt }),
          ...(result.projection === undefined ? {} : { projection: result.projection }),
          ...(result.targetEntityId === undefined ? {} : {
            targetEntityId: result.targetEntityId,
          }) };
      },
    });
  }

  add({ name: "environment_set",
    title: "Adjust visible daylight",
    description: "Adjust visible sun direction and daylight; edit scene lights separately.",
    inputSchema: closedObject({
      ...environmentFields,
      ...expectedRevisionField,
    }, [], { minProperties: 1 }),
    readOnlyHint: false,
    untrustedContentHint: true,
    handle: async (input, signal) => {
      const { expectedRevision, ...patch } = input;
      if (Object.keys(patch).length === 0) {
        throw new StudioToolError("INVALID_ARGUMENT",
          "An environment edit requires at least one authored setting.");
      }
      return summarizeMutation(await store.setEnvironment(patch,
        mutationOptions(input, signal)), store);
    },
  });

  add({ name: "render_capture",
    title: "Capture a presented modeling frame",
    description: "Capture real presented WebGPU PNG/JPEG image bytes and dimensions.",
    inputSchema: closedObject({
      format: { enum: ["png", "jpeg", "image/png", "image/jpeg"] },
      maxBytes: integer(1_024, MAX_INLINE_ARTIFACT_BYTES),
      maxWidth: integer(32, 4_096),
      quality: finite(0.05, 1),
    }),
    readOnlyHint: true,
    untrustedContentHint: true,
    handle: async (input, signal) => {
      const captureFrame = typeof capture === "function"
        ? capture : typeof runtime?.capture === "function"
          ? runtime.capture.bind(runtime) : undefined;
      if (!captureFrame) {
        throw new StudioToolError("CAPABILITY_UNAVAILABLE",
          "Presented WebGPU frame capture is unavailable in this browser.");
      }
      const format = input.format === "jpeg" || input.format === "image/jpeg"
        ? "image/jpeg" : "image/png";
      if (format === "image/png" && input.quality !== undefined) {
        invalid("applies only to JPEG; remove quality or set format to jpeg", "input.quality");
      }
      const frame = await captureFrame({
        ...input,
        format,
        maxBytes: input.maxBytes ?? MAX_INLINE_ARTIFACT_BYTES,
        ...(signal === undefined ? {} : { signal }),
      });
      aborted(signal);
      const bytes = bytesFrom(frame?.bytes);
      const byteLength = frame?.byteLength ?? bytes?.byteLength;
      if (!Number.isSafeInteger(byteLength) || byteLength < 1
        || byteLength > (input.maxBytes ?? MAX_INLINE_ARTIFACT_BYTES)) {
        throw new StudioToolError("CAPABILITY_UNAVAILABLE",
          "The presented frame was missing or exceeded its bounded image budget.");
      }
      const current = state(store);
      return {
        format: frame.format ?? "oriel.presented-frame/1",
        mediaType: frame.mediaType ?? format,
        width: frame.width,
        height: frame.height,
        byteLength,
        ...(current.revision === undefined ? {} : {
          revision: current.revision,
        }),
        ...(current.selection === undefined ? {} : {
          selection: current.selection,
        }),
        base64: frame.base64 ?? (bytes ? base64(bytes) : undefined),
        ...(frame.capturedAt === undefined ? {} : {
          capturedAt: frame.capturedAt,
        }),
      };
    },
  });

  add({ name: "asset_export_glb",
    title: "Export selected genuine modeled GLB",
    description: "Export actual model hierarchy, transforms, materials, and textures; user controls Download.",
    inputSchema: closedObject({
      entityId: identifier(),
      inline: { type: "boolean" },
    }, ["entityId"]),
    readOnlyHint: false,
    untrustedContentHint: true,
    handle: async (input, signal) => {
      const artifact = typeof exportAssets?.exportGroup === "function"
        ? await prepareGroupedExport({ entityIds: [input.entityId],
          ...(typeof store.getRevision === "function"
            ? { expectedRevision: store.getRevision() } : {}) }, signal)
        : await store.exportGlb(input.entityId);
      const selectedArtifact = artifact.entityId === undefined
        ? { ...artifact, entityId: input.entityId } : artifact;
      const authority = Object.getOwnPropertyDescriptor(artifact,
        OWNER_GROUPED_EXPORT_AUTHORITY);
      if (authority && selectedArtifact !== artifact) {
        Object.defineProperty(selectedArtifact, OWNER_GROUPED_EXPORT_AUTHORITY, authority);
      }
      if (typeof artifacts?.retain !== "function") {
        return exportArtifact(selectedArtifact, { onExport,
          inline: input.inline === true, signal });
      }
      const shouldOffer = typeof publishExportOffer === "function"
        || typeof onExport === "function";
      const reservation = shouldOffer && typeof reserveExportOffer === "function"
        ? reserveExportOffer({ byteLength: bytesFrom(selectedArtifact.bytes)?.byteLength,
          profile: selectedArtifact.profile }) : undefined;
      let retained;
      let published = false;
      try {
        retained = await artifacts.retain(selectedArtifact,
          signal === undefined ? {} : { signal });
        const publish = typeof publishExportOffer === "function"
          ? (offered) => publishExportOffer(reservation, { ...offered, ...retained })
          : onExport;
        const result = exportArtifact(selectedArtifact, { onExport: publish,
          inline: input.inline === true, signal });
        published = true;
        return { ...result, ...retained,
          ...Object.fromEntries(["revision", "entityIds", "nodeCount", "meshCount",
            "materialCount", "textureCount", "vertexCount", "editableVertexCount",
            "faceCount", "selectedRootCount", "fidelityPolicy", "externalResources"]
            .filter((key) => selectedArtifact[key] !== undefined)
            .map((key) => [key, selectedArtifact[key]])) };
      } catch (error) {
        if (!published && retained?.artifactId !== undefined) {
          try { artifacts.release({ artifactId: retained.artifactId }); } catch {}
        }
        if (!published && reservation !== undefined) releaseExportOffer?.(reservation);
        throw error;
      }
    },
  });

  add({ name: "scene_export",
    title: "Export the authored modeling scene",
    description: "Prepare actual scene JSON for explicit user-controlled download.",
    inputSchema: closedObject({ inline: { type: "boolean" } }),
    readOnlyHint: false,
    untrustedContentHint: true,
    handle: async (input, signal) => exportArtifact(
      await store.exportScene(), { onExport, inline: input.inline === true,
        signal }),
  });

  if (referenceAssets && typeof referenceAssets.beginBatch === "function") {
    add({ name: "reference_batch_begin",
      title: "Begin bounded reference-image batch",
      description: "Reserve one browser-local batch for up to five actual PNG/JPEG design reference images.",
      inputSchema: closedObject({ count: integer(1, MAX_REFERENCE_IMAGES), label: text(160) },
        ["count"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input) => referenceAssets.beginBatch(input),
    });
  }
  if (referenceAssets && typeof referenceAssets.beginUpload === "function") {
    add({ name: "reference_upload_begin",
      title: "Begin actual reference-image upload",
      description: "Begin a bounded browser-local PNG/JPEG upload with exact image size and SHA-256 digest.",
      inputSchema: closedObject({
        batchId: opaqueHandle(),
        name: text(256),
        mediaType: enumText(["image/png", "image/jpeg"]),
        byteLength: integer(1, MAX_REFERENCE_IMAGE_BYTES),
        digest: { ...text(71, 71), pattern: SHA256_DIGEST_PATTERN },
        width: integer(1, 8_192),
        height: integer(1, 8_192),
      }, ["name", "mediaType", "byteLength", "digest"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input) => referenceAssets.beginUpload(input),
    });
  }
  if (referenceAssets && typeof referenceAssets.uploadChunk === "function") {
    add({ name: "reference_upload_chunk",
      title: "Upload bounded real reference-image bytes",
      description: "Upload one canonical base64 image chunk of at most 256 KiB using exact ordered offset and index.",
      inputSchema: closedObject({
        uploadId: opaqueHandle(),
        offset: integer(0, MAX_REFERENCE_IMAGE_BYTES),
        index: integer(0, 128),
        dataBase64: { ...text(MAX_REFERENCE_CHUNK_BASE64, 4),
          pattern: CANONICAL_BASE64_PATTERN },
      }, ["uploadId", "offset", "index", "dataBase64"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input) => referenceAssets.uploadChunk(input),
    });
  }
  const completeReference = referenceAssets?.completeUpload ?? referenceAssets?.commitUpload;
  if (typeof completeReference === "function") {
    add({ name: "reference_upload_complete",
      title: "Verify uploaded reference image",
      description: "Verify actual PNG/JPEG bytes, SHA-256 digest, and dimensions.",
      inputSchema: closedObject({ uploadId: opaqueHandle() }, ["uploadId"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input) => completeReference.call(referenceAssets, input),
    });
  }
  if (referenceAssets && typeof referenceAssets.abortUpload === "function") {
    add({ name: "reference_upload_abort",
      title: "Abort reference-image upload",
      description: "Abort and discard one unfinished local reference upload.",
      inputSchema: closedObject({ uploadId: opaqueHandle() }, ["uploadId"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input) => referenceAssets.abortUpload(input),
    });
  }
  if (referenceAssets && typeof referenceAssets.list === "function") {
    add({ name: "reference_list",
      title: "Inspect local reference images",
      description: "List verified reference identities, metadata, and current selection.",
      inputSchema: closedObject({ batchId: opaqueHandle() }),
      readOnlyHint: true,
      untrustedContentHint: true,
      handle: (input) => referenceAssets.list(input),
    });
  }
  if (referenceAssets && typeof referenceAssets.select === "function") {
    add({ name: "reference_select",
      title: "Select a verified reference image",
      description: "Select one existing verified browser-local reference image.",
      inputSchema: closedObject({ referenceId: opaqueHandle() }, ["referenceId"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input) => referenceAssets.select(input),
    });
  }
  const removeReference = referenceAssets?.delete ?? referenceAssets?.remove;
  if (typeof removeReference === "function") {
    add({ name: "reference_delete",
      title: "Delete a local reference image",
      description: "Delete one verified reference, release its Blob URL, and update selection.",
      inputSchema: closedObject({ referenceId: opaqueHandle() }, ["referenceId"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input) => removeReference.call(referenceAssets, input),
    });
  }

  if (typeof store.listMaterialSamples === "function") {
    add({ name: "material_samples_list",
      title: "Browse the complete compact PBR material library",
      description: "List every preset compactly; filter categories or include assigned/custom materials.",
      inputSchema: closedObject({ category: materialCategory,
        detail: enumText(["compact", "full"]), limit: integer(1, 128),
        includeAssigned: { type: "boolean" }, includeCustom: { type: "boolean" } }),
      readOnlyHint: true,
      untrustedContentHint: false,
      handle: async ({ includeCustom, ...input }, signal) => {
        if (input.category === "custom" && includeCustom !== true) {
          invalid("requires includeCustom: true", "input.category");
        }
        const customOnly = input.category === "custom";
        const listed = customOnly
          ? { samples: [], categories: [], total: 0, returnedCount: 0 }
          : await store.listMaterialSamples(includeCustom === true
            ? { ...input, limit: 128 } : input);
        if (includeCustom !== true) return listed;
        if (typeof materialAuthoring?.list !== "function") {
          throw new StudioToolError("CAPABILITY_UNAVAILABLE",
            "A genuine project-scoped custom material library is unavailable.");
        }
        const custom = await materialAuthoring.list(
          signal === undefined ? {} : { signal });
        if (!custom || !Array.isArray(custom.materials)) {
          throw new StudioToolError("CAPABILITY_UNAVAILABLE",
            "The project did not return a genuine custom material catalog.");
        }
        const eligibleCustom = input.category === undefined || customOnly
          ? custom.materials : [];
        const customMaterials = eligibleCustom.map((entry) => input.detail === "full"
          ? { ...entry, sampleId: entry.materialId, category: "custom" }
          : { sampleId: entry.materialId, materialId: entry.materialId,
            name: entry.name, category: "custom" });
        const combined = [...(listed.samples ?? []), ...customMaterials];
        const samples = input.limit === undefined ? combined : combined.slice(0, input.limit);
        const visibleCustom = samples.filter(({ category }) => category === "custom");
        return { ...listed, samples,
          categories: [...new Set([...(listed.categories ?? []),
            ...(customMaterials.length === 0 ? [] : ["custom"])])],
          customMaterials: visibleCustom,
          customMaterialCount: customMaterials.length,
          total: (listed.total ?? listed.samples?.length ?? 0) + customMaterials.length,
          returnedCount: samples.length };
      },
    });
  }
  if (typeof store.inspectMaterialSample === "function") {
    add({ name: "material_sample_inspect",
      title: "Inspect a reusable PBR library sample",
      description: "Inspect PBR factors before reusing a polished final material; optional actual surface preview.",
      inputSchema: closedObject({
        sampleId: opaqueHandle(),
        parameters: materialSampleParameters,
        preview: materialSurfacePreview,
        ...expectedRevisionField,
      }, ["sampleId"]),
      readOnlyHint: true,
      untrustedContentHint: false,
      handle: async ({ sampleId, parameters = {}, preview, expectedRevision }, signal) => {
        if (expectedRevision !== undefined && expectedRevision !== state(store).revision) {
          throw new StudioToolError("STALE_REVISION",
            "The requested material sample belongs to a stale authored scene revision.");
        }
        if (/^material:sha256:[0-9a-f]{64}$/u.test(sampleId)) {
          if (typeof materialAuthoring?.inspect !== "function") {
            throw new StudioToolError("CAPABILITY_UNAVAILABLE",
              "The project cannot inspect a genuine custom material asset.");
          }
          if (Object.keys(parameters).length !== 0) {
            throw new StudioToolError("INVALID_ARGUMENT",
              "A registered custom material does not accept procedural sample parameters.");
          }
          return materialAuthoring.inspect({ materialId: sampleId,
            ...(preview === undefined ? {} : { preview }),
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            ...(signal === undefined ? {} : { signal }) });
        }
        const inspected = await store.inspectMaterialSample(sampleId, parameters);
        if (preview === undefined) return inspected;
        if (preview.matchColor !== undefined && preview.lighting !== "neutral-reference"
            || preview.maxDeltaE !== undefined && preview.matchColor === undefined) {
          throw new StudioToolError("INVALID_ARGUMENT",
            "Material color matching requires neutral-reference lighting and an explicit target color.");
        }
        let previewCapabilities;
        try {
          previewCapabilities = typeof inspection?.getCapabilities === "function"
            ? inspection.getCapabilities() : inspection?.capabilities;
        } catch {
          previewCapabilities = undefined;
        }
        const enhanced = preview.target !== undefined || preview.lighting !== undefined
          || preview.matchColor !== undefined || preview.maxDeltaE !== undefined;
        if (previewCapabilities?.materialPreview !== true
          || enhanced && previewCapabilities.surfaceMaterialPreview !== true
          || typeof inspection?.previewMaterial !== "function"
          || typeof store.previewMaterialSample !== "function") {
          throw new StudioToolError("CAPABILITY_UNAVAILABLE",
            "A genuine isolated WebGPU material preview is unavailable in this renderer.");
        }
        const initial = typeof store.getInspectionCheckpoint === "function"
          ? store.getInspectionCheckpoint() : state(store);
        const beforeRevision = initial.revision;
        if (expectedRevision !== undefined && expectedRevision !== beforeRevision) {
          throw new StudioToolError("STALE_REVISION",
            "The requested material preview belongs to a stale authored scene revision.");
        }
        const candidate = await store.previewMaterialSample(sampleId, parameters,
          ...(signal === undefined ? [] : [{ signal }]));
        const beforeCapture = typeof store.getInspectionCheckpoint === "function"
          ? store.getInspectionCheckpoint() : { revision: state(store).revision };
        if (beforeCapture.revision !== beforeRevision
            || initial.selectionEpoch !== undefined
              && initial.selectionEpoch !== beforeCapture.selectionEpoch) {
          throw new StudioToolError("OWNER_STATE_CHANGED",
            "The actual selected surface changed while its candidate material was generated.");
        }
        if (!candidate || typeof candidate.material !== "object"
          || !(candidate.assets instanceof Map)
          || !(candidate.assetMetadata instanceof Map)) {
          throw new StudioToolError("CAPABILITY_UNAVAILABLE",
            "The material library did not provide genuine transient preview textures.");
        }
        const textures = [];
        for (const [field, role, colorSpace] of [
          ["baseColorTexture", "baseColor", "srgb"],
          ["normalTexture", "normal", "linear"],
          ["metallicRoughnessTexture", "metallicRoughness", "linear"],
        ]) {
          const path = candidate.material[field];
          if (path === undefined) continue;
          const bytes = candidate.assets.get(path);
          const digest = candidate.assetMetadata.get(path)?.contentDigest;
          if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0
            || typeof digest !== "string"
            || !new RegExp(SHA256_DIGEST_PATTERN, "u").test(digest)) {
            throw new StudioToolError("INVALID_ASSET",
              "The candidate preview references an unverified procedural texture.");
          }
          textures.push({ role, digest, colorSpace, bytes });
        }
        const frame = await inspection.previewMaterial({
          material: candidate.material,
          textures,
          ...(preview.width === undefined ? {} : { width: preview.width }),
          ...(preview.height === undefined ? {} : { height: preview.height }),
          ...(preview.target === undefined ? {} : { target: preview.target }),
          ...(preview.lighting === undefined ? {} : { lighting: preview.lighting }),
          ...(preview.matchColor === undefined ? {} : {
            matchColor: [...preview.matchColor],
          }),
          ...(preview.maxDeltaE === undefined ? {} : { maxDeltaE: preview.maxDeltaE }),
          expectedRevision: expectedRevision ?? beforeRevision,
          ...(signal === undefined ? {} : { signal }),
        });
        if (!frame || frame.genuineWebGpu !== true
          || frame.ownerCameraPreserved !== true
          || frame.authoredSceneChanged !== false
          || typeof frame.frameId !== "string"
          || (typeof store.getInspectionCheckpoint === "function"
            ? store.getInspectionCheckpoint().revision : state(store).revision) !== beforeRevision
          || enhanced && !frame.appearance) {
          throw new StudioToolError("CAPABILITY_UNAVAILABLE",
            "The native renderer did not attest a genuine isolated material preview.");
        }
        return { ...inspected, preview: frame };
      },
    });
  }
  if (typeof store.applyMaterialSample === "function") {
    add({ name: "material_sample_apply",
      title: "Apply a polished textured PBR library material",
      description: "Reuse an inspected existing sample to generate genuine deterministic PNG albedo, normal, and roughness maps, or reuse a project-scoped material handle; atomically apply one finished PBR material to up to 128 exact, selected, or descendant entities.",
      inputSchema: closedObject({
        entityId: identifier(), sampleId: opaqueHandle(),
        parameters: materialSampleParameters, target: materialTarget,
        source: materialSource, ...expectedRevisionField,
      }, [], { oneOf: [
        closedObject({
          entityId: identifier(),
          sampleId: opaqueHandle(),
          parameters: materialSampleParameters,
          ...expectedRevisionField,
        }, ["entityId", "sampleId"]),
        closedObject({ target: materialTarget, source: materialSource,
          ...expectedRevisionField }, ["target", "source"]),
      ] }),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: async (input, signal) => {
        let result;
        if (input.target !== undefined) {
          result = await store.applyMaterialSample({ target: input.target,
            source: input.source }, mutationOptions(input, signal));
        } else if (/^material:sha256:[0-9a-f]{64}$/u.test(input.sampleId)) {
          if (typeof materialAuthoring?.apply !== "function") {
            throw new StudioToolError("CAPABILITY_UNAVAILABLE",
              "The project cannot apply a genuine custom material asset.");
          }
          if (input.parameters !== undefined && Object.keys(input.parameters).length !== 0) {
            throw new StudioToolError("INVALID_ARGUMENT",
              "A registered custom material does not accept procedural sample parameters.");
          }
          result = await materialAuthoring.apply({ materialId: input.sampleId,
            entityIds: [input.entityId],
            ...(input.expectedRevision === undefined ? {} : {
              expectedRevision: input.expectedRevision,
            }),
            ...(signal === undefined ? {} : { signal }) });
        } else {
          result = await store.applyMaterialSample(input.entityId, input.sampleId,
            input.parameters ?? {}, mutationOptions(input, signal));
        }
        return summarizeMutation(result, store);
      },
    });
  }

  if (typeof store.editMesh === "function") {
    add({ name: "mesh_array_linear",
      title: "Create genuinely repeated linear mesh geometry",
      description: "Repeat actual editable polygon geometry along a nonzero spatial offset and regenerate its GLB atomically.",
      inputSchema: meshEditSchema({ count: integer(2, 64), offset: vector(3) },
        ["count", "offset"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: async (input, signal) => summarizeMutation(await store.editMesh(
        input.entityId, { operation: "arrayLinear", count: input.count,
          offset: input.offset }, mutationOptions(input, signal)), store),
    });
    add({ name: "mesh_array_radial",
      title: "Create genuinely repeated radial mesh geometry",
      description: "Repeat actual indexed geometry around a bounded x/y/z axis and regenerate the authored mesh GLB.",
      inputSchema: meshEditSchema({
        count: integer(2, 64),
        axis: coordinateAxis,
        angle: finite(-Math.PI * 2, Math.PI * 2),
        angleDegrees: finite(-360, 360),
        center: vector(3),
      }, ["count"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: async (input, signal) => {
        const { entityId, expectedRevision, ...operation } = input;
        return summarizeMutation(await store.editMesh(entityId,
          { operation: "arrayRadial", ...operation },
          mutationOptions(input, signal)), store);
      },
    });
    add({ name: "mesh_mirror",
      title: "Mirror actual editable polygon geometry",
      description: "Generate real mirrored indexed geometry across a bounded x/y/z plane and preserve the authored GLB identity.",
      inputSchema: meshEditSchema({ axis: coordinateAxis, offset: finite() }, ["axis"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: async (input, signal) => summarizeMutation(await store.editMesh(
        input.entityId, { operation: "mirror", axis: input.axis,
          ...(input.offset === undefined ? {} : { offset: input.offset }) },
        mutationOptions(input, signal)), store),
    });
    add({ name: "mesh_loop_cut",
      title: "Cut a genuine polygon topology loop",
      description: "Split actual polygon topology across an x/y/z cutting plane and regenerate the modeled GLB.",
      inputSchema: meshEditSchema({ axis: coordinateAxis, position: finite() },
        ["axis", "position"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: async (input, signal) => summarizeMutation(await store.editMesh(
        input.entityId, { operation: "loopCut", axis: input.axis,
          position: input.position }, mutationOptions(input, signal)), store),
    });
  }
  const editMeshBatch = store.editMeshBatch ?? store.applyMeshOperations;
  if (typeof editMeshBatch === "function") {
    add({ name: "mesh_apply_batch",
      title: "Apply one atomic actual mesh-modeling batch",
      description: atomicControlCageBatches
        ? "Commit up to 128 topology edits or 32 selected cage moves in one atomic scene revision."
        : "Explore up to 128 genuine topology operations in one atomic authored edit; inspect the resulting shape and revise or replace unsuccessful ideas.",
      inputSchema: closedObject({
        entityId: identifier(),
        ...(atomicControlCageBatches ? { cageId: identifier() } : {}),
        operations: {
          type: "array", minItems: 1, maxItems: MAX_MESH_BATCH_OPERATIONS,
          items: atomicControlCageBatches
            ? { oneOf: [...meshOperationSchema.oneOf, cageTransformOperation] }
            : meshOperationSchema,
        },
        ...expectedRevisionField,
      }, ["entityId", "operations"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      validate: (input) => {
        if (input.cageId !== undefined) {
          if (input.cageId !== input.entityId) {
            invalid("must match the modeled entity", "input.cageId");
          }
          if (input.operations.length > MAX_CONTROL_BATCH_OPERATIONS) {
            invalid(`must contain at most ${MAX_CONTROL_BATCH_OPERATIONS} cage moves`,
              "input.operations");
          }
          for (const [index, operation] of input.operations.entries()) {
            const path = `input.operations[${index}]`;
            if (operation.op !== "transform") {
              invalid("cage batches support only actual control transforms", `${path}.op`);
            }
            if (operation.selection === undefined) {
              invalid("requires a genuine coarse control selection", `${path}.selection`);
            }
            if ((operation.translation === undefined) === (operation.scale === undefined)) {
              invalid("requires exactly one translation or scale", path);
            }
            if (operation.selection.mode === "vertices"
                && operation.selection.vertices === undefined) {
              invalid("requires actual control vertices", `${path}.selection.vertices`);
            }
            if (operation.selection.mode === "spatial"
                && (operation.selection.center === undefined
                  || operation.selection.radius === undefined)) {
              invalid("requires a genuine center and radius", `${path}.selection`);
            }
          }
          return;
        }
        for (const [index, operation] of input.operations.entries()) {
          if (operation.selection !== undefined) {
            invalid("requires cageId; enable part_feature with feature:'cage',levels:0 first",
              `input.operations[${index}].selection`);
          }
          validateMeshOperation(operation, `input.operations[${index}]`);
        }
      },
      handle: async (input, signal) => {
        if (input.cageId !== undefined) {
          const operations = input.operations.map(({ op: _op, translation,
            scale, ...operation }) => ({
            action: translation === undefined ? "scale" : "move",
            ...operation,
            ...(translation === undefined ? { scale } : { translation }),
          }));
          return summarizeMutation(await store.editControlCageBatch(input.entityId,
            operations, mutationOptions(input, signal)), store);
        }
        const operations = input.operations.map(({ op, ...operation }) => ({
          operation: op,
          ...operation,
        }));
        return summarizeMutation(await editMeshBatch.call(store, input.entityId,
          operations, mutationOptions(input, signal)), store);
      },
    });
  }

  if (inspection && typeof inspection.focusTarget === "function") {
    add({ name: "focus_target",
      title: "Frame genuine world-space authored geometry",
      description: "Compute exact target bounds and a fitted camera pose without moving the visible camera or changing the authored scene.",
      inputSchema: closedObject({ target: inspectionTarget, framing: inspectionFraming },
        ["target"]),
      readOnlyHint: true,
      untrustedContentHint: true,
      handle: (input, signal) => inspection.focusTarget({
        ...input,
        ...(signal === undefined ? {} : { signal }),
      }),
    });
  }
  let inspectionCapabilities;
  try {
    inspectionCapabilities = typeof inspection?.getCapabilities === "function"
      ? inspection.getCapabilities()
      : inspection?.capabilities;
  } catch {
    inspectionCapabilities = undefined;
  }
  const orthographicCapture = inspectionCapabilities?.projectionVersion === 1
    && Array.isArray(inspectionCapabilities.projectionModes)
    && inspectionCapabilities.projectionModes.includes("orthographic");
  const privateReferenceReview = orthographicCapture
    && typeof referenceAssets?.reviewSelected === "function";
  const evidenceGroundedDesignReview = inspectionCapabilities?.diagnosticPixels === true;
  const actualInspectionView = orthographicCapture ? orthographicInspectionView : inspectionView;
  const actualDiagnosticsOptions = privateReferenceReview
    ? referenceVisualDiagnosticsOptions : visualDiagnosticsOptions;
  const designReviewOptions = closedObject({ brief: visualDesignBrief,
    geometry: { type: "boolean" },
    ...(privateReferenceReview ? { reference: closedObject({
      viewId: { ...text(64), pattern: "^[A-Za-z0-9_-]{1,64}$" },
      referenceId: identifier(),
    }, ["viewId"]) } : {}),
  }, ["brief"]);
  const verifyProjection = (view) => {
    if (view.projection === "orthographic") {
      const available = typeof inspection?.getCapabilities === "function"
        ? inspection.getCapabilities() : inspectionCapabilities;
      if (available?.projectionVersion !== 1
          || !Array.isArray(available.projectionModes)
          || !available.projectionModes.includes("orthographic")) {
        throw new StudioToolError("CAPABILITY_UNAVAILABLE",
          "The active native renderer cannot produce an authenticated orthographic GPU projection.");
      }
      if (view.verticalFovDegrees !== undefined || view.distanceScale !== undefined) {
        throw new StudioToolError("INVALID_ARGUMENT",
          "An orthographic view uses verticalSpan, not perspective field-of-view or distance scaling.");
      }
    } else if (view.verticalSpan !== undefined) {
      throw new StudioToolError("INVALID_ARGUMENT",
        "An explicit verticalSpan requires a genuine orthographic inspection projection.");
    }
  };
  if (inspectionCapabilities?.ownerPreservingCapture === true
    && typeof inspection?.captureBatch === "function"
    && typeof inspection?.getFrame === "function") {
    add({ name: "render_capture_batch",
      title: "Capture genuine owner-preserving WebGPU viewpoints",
      description: orthographicCapture
        ? "Capture independent perspective or true orthographic GPU views without moving the visible camera."
        : "Capture up to five independent GPU viewpoints with verified optics; preserve the visible camera and inspect three angles for complex assets.",
      inputSchema: closedObject({
        target: inspectionTarget,
        views: {
          type: "array", minItems: 1, maxItems: MAX_INSPECTION_VIEWS,
          items: actualInspectionView,
        },
        format: enumText(["png", "jpeg", "image/png", "image/jpeg"]),
        quality: finite(0.05, 1),
        fit: inspectionFit,
        padding: finite(1.01, 2),
        background: inspectionBackground,
        ...expectedRevisionField,
      }, ["views"]),
      readOnlyHint: true,
      untrustedContentHint: true,
      handle: async (input, signal) => {
        for (const view of input.views) {
          verifyProjection(view);
          if (view.width !== undefined && view.height !== undefined
            && view.width * view.height > 1_920 * 1_080) {
            throw new StudioToolError("INVALID_ARGUMENT",
              "An isolated native WebGPU inspection view exceeds its actual pixel budget.");
          }
          if (view.near !== undefined && view.far !== undefined && view.far <= view.near) {
            throw new StudioToolError("INVALID_ARGUMENT",
              "An independent camera far plane must exceed its actual near plane.");
          }
        }
        const format = input.format === "jpeg" || input.format === "image/jpeg"
          ? "image/jpeg" : "image/png";
        if (format === "image/png" && input.quality !== undefined) {
          invalid("applies only to JPEG; remove quality or set format to jpeg", "input.quality");
        }
        if (format !== "image/png" && (input.background === "transparent"
          || input.views.some(({ background }) => background === "transparent"))) {
          throw new StudioToolError("INVALID_ARGUMENT",
            "A transparent inspection background requires genuine PNG image output.");
        }
        const batch = await inspection.captureBatch({
          ...input,
          format,
          ...(signal === undefined ? {} : { signal }),
        });
        if (!batch || !Array.isArray(batch.frames)
          || batch.frames.length < 1 || batch.frames.length > MAX_INSPECTION_VIEWS
          || batch.ownerCameraPreserved !== true || batch.ownerCameraRestored !== true) {
          throw new StudioToolError("CAPABILITY_UNAVAILABLE",
            "The native renderer did not provide genuinely owner-preserving inspection frames.");
        }
        return batch;
      },
    });
    add({ name: "render_contact_sheet",
      title: "Review genuine multi-view modeling quality",
      description: evidenceGroundedDesignReview
        ? "Compare actual GPU silhouettes, explicit visual goals, verified surface geometry, and available paired private references; technical validity never certifies design quality."
        : privateReferenceReview
        ? "Review real GPU views; optionally compare a private selected reference against a transparent orthographic silhouette."
        : orthographicCapture
          ? "Review real perspective or orthographic GPU views; image-grounded diagnostics suggest corrections."
          : "Review independent GPU views in one PNG/JPEG; opt-in image-grounded diagnostics suggest edits. Complex assets need three angles; fix visible defects.",
      inputSchema: closedObject({
        target: inspectionTarget,
        views: {
          type: "array", minItems: 1, maxItems: MAX_INSPECTION_VIEWS,
          items: actualInspectionView,
        },
        columns: integer(1, 3),
        format: compactEnum(["png", "jpeg", "image/png", "image/jpeg"]),
        quality: finite(0.05, 1),
        maxWidth: integer(320, 1_920),
        maxHeight: integer(240, 1_920),
        maxBytes: integer(16_384, MAX_CONTACT_SHEET_BYTES),
        fit: inspectionFit,
        padding: finite(1.01, 2),
        background: inspectionBackground,
        diagnostics: actualDiagnosticsOptions,
        ...(evidenceGroundedDesignReview ? { designReview: designReviewOptions } : {}),
        ...expectedRevisionField,
      }),
      readOnlyHint: true,
      untrustedContentHint: true,
      handle: async (input, signal) => {
        const outputFormat = input.format === "jpeg" || input.format === "image/jpeg"
          ? "image/jpeg" : "image/png";
        if (outputFormat === "image/png" && input.quality !== undefined) {
          invalid("applies only to JPEG; remove quality or set format to jpeg", "input.quality");
        }
        if (outputFormat === "image/jpeg" && (input.background === "transparent"
            || input.views?.some(({ background }) => background === "transparent"))) {
          invalid("a transparent contact sheet requires PNG output", "input.format");
        }
        const requestedDesign = input.designReview;
        const legacyReference = input.diagnostics?.reference === true;
        const designReference = requestedDesign?.reference;
        const reviewReference = legacyReference || designReference !== undefined;
        if (input.diagnostics?.referenceId !== undefined && !legacyReference) {
          throw new StudioToolError("INVALID_ARGUMENT",
            "A private reference identity requires explicit reference silhouette review.");
        }
        if (designReference?.referenceId !== undefined
            && input.diagnostics?.referenceId !== undefined
            && designReference.referenceId !== input.diagnostics.referenceId) {
          throw new StudioToolError("INVALID_ARGUMENT",
            "Legacy and design reference review must use the same explicitly selected image.");
        }
        const views = input.views ?? ["front", "right", "back", "three-quarter", "top"]
          .map((preset) => ({ id: preset, preset, width: 512, height: 384 }));
        let designScene;
        let designEntities;
        let selectedReference;
        if (requestedDesign !== undefined) {
          const ids = new Set(views.map(({ id }) => id));
          if (ids.size !== views.length) {
            throw new StudioToolError("INVALID_ARGUMENT",
              "Evidence-grounded design review requires unique actual viewpoint identities.");
          }
          for (const [index, viewId] of (requestedDesign.brief.requiredViewIds ?? [])
            .entries()) {
            if (!ids.has(viewId)) {
              invalid("must match an actual requested viewpoint",
                `input.designReview.brief.requiredViewIds[${index}]`);
            }
          }
          const goals = new Set();
          for (const goal of requestedDesign.brief.proportionGoals ?? []) {
            if (goals.has(goal.id) || !ids.has(goal.viewId)
                || goal.minimum === undefined && goal.maximum === undefined
                || goal.minimum !== undefined && goal.maximum !== undefined
                  && goal.minimum > goal.maximum
                || goal.metric === "foreground_occupancy"
                  && ((goal.minimum ?? 0) > 1 || (goal.maximum ?? 1) > 1)) {
              throw new StudioToolError("INVALID_ARGUMENT",
                "Design proportion goals require unique identities, requested views, and ordered real thresholds.");
            }
            goals.add(goal.id);
          }
          const proportionRelationships = new Set();
          for (const [index, relationship]
            of (requestedDesign.brief.relativeProportions ?? []).entries()) {
            if (relationship.entityId === relationship.referenceEntityId) {
              invalid("must compare two different actual entities",
                `input.designReview.brief.relativeProportions[${index}].referenceEntityId`);
            }
            if (relationship.minimum === undefined && relationship.maximum === undefined
                || relationship.minimum !== undefined && relationship.maximum !== undefined
                  && relationship.minimum > relationship.maximum) {
              invalid("requires at least one ordered minimum or maximum ratio",
                `input.designReview.brief.relativeProportions[${index}]`);
            }
            const key = `${relationship.entityId}:${relationship.referenceEntityId}:${relationship.axis}`;
            if (proportionRelationships.has(key)) {
              invalid("duplicates an actual entity/reference/axis relationship",
                `input.designReview.brief.relativeProportions[${index}]`);
            }
            proportionRelationships.add(key);
          }
          for (const [index, contact] of (requestedDesign.brief.requiredContacts ?? [])
            .entries()) {
            if ((contact.maxProjection !== undefined || contact.minEmbed !== undefined)
                && contact.viewId === undefined) {
              invalid("projection and embedding thresholds require a requested viewId",
                `input.designReview.brief.requiredContacts[${index}].viewId`);
            }
            if (contact.viewId !== undefined && !ids.has(contact.viewId)) {
              invalid("must match an actual requested viewpoint",
                `input.designReview.brief.requiredContacts[${index}].viewId`);
            }
          }
          const contactRelationships = (requestedDesign.brief.requiredContacts ?? [])
            .map(({ entityId, targetEntityId }) => [entityId, targetEntityId]);
          const intersectionRelationships = (requestedDesign.brief.allowedIntersectionPairs ?? [])
            .map(({ leftEntityId, rightEntityId }) => [leftEntityId, rightEntityId]);
          const relationships = [...contactRelationships, ...intersectionRelationships];
          const uniqueRelationships = (entries) =>
            new Set(entries.map((pair) => [...pair].sort().join(":"))).size === entries.length;
          if (relationships.some(([left, right]) => left === right)
              || !uniqueRelationships(contactRelationships)
              || !uniqueRelationships(intersectionRelationships)) {
            throw new StudioToolError("INVALID_ARGUMENT",
              "Structural design relationships require distinct, unique actual entities.");
          }
          for (const opening of requestedDesign.brief.expectedOpenings ?? []) {
            if (Math.hypot(...opening.direction) <= Number.EPSILON) {
              throw new StudioToolError("INVALID_ARGUMENT",
                "A genuine opening probe requires a nonzero local-space ray direction.");
            }
          }
          const structural = relationships.length > 0
            || proportionRelationships.size > 0
            || (requestedDesign.brief.continuousEntityIds?.length ?? 0) > 0
            || (requestedDesign.brief.expectedOpenings?.length ?? 0) > 0;
          if (structural && requestedDesign.geometry !== true) {
            throw new StudioToolError("INVALID_ARGUMENT",
              "Requested structural relationships require explicit genuine geometry review.");
          }
          if (requestedDesign.geometry === true) {
            if (input.diagnostics?.includeScene === false) {
              throw new StudioToolError("INVALID_ARGUMENT",
                "Geometry review cannot bypass an explicit scene-introspection opt-out.");
            }
            if (typeof store.inspectMesh !== "function") {
              throw new StudioToolError("CAPABILITY_UNAVAILABLE",
                "The current project cannot supply actual indexed geometry for design review.");
            }
            designEntities = new Set([...(requestedDesign.brief.members ?? []),
              ...(requestedDesign.brief.continuousEntityIds ?? []),
              ...(requestedDesign.brief.intentionalSeparateEntityIds ?? []),
              ...relationships.flat(),
              ...(requestedDesign.brief.relativeProportions ?? [])
                .flatMap(({ entityId, referenceEntityId }) =>
                  [entityId, referenceEntityId]),
              ...(requestedDesign.brief.expectedOpenings ?? [])
                .map(({ entityId }) => entityId)]);
            const currentScene = store.getScene();
            for (const entityId of designEntities) {
              if (!Object.hasOwn(currentScene.entities, entityId)) {
                throw new StudioToolError("NOT_FOUND",
                  `Design review references an entity absent from the current project: ${entityId}.`);
              }
            }
          }
        }
        const captureBackground = input.background
          ?? (reviewReference || (requestedDesign?.brief.proportionGoals?.length ?? 0) > 0
            ? "transparent" : undefined);
        if (outputFormat === "image/jpeg" && (captureBackground === "transparent"
            || views.some(({ background }) => background === "transparent"))) {
          invalid("a transparent contact sheet requires PNG output", "input.format");
        }
        if (reviewReference) {
          if (!privateReferenceReview) {
            throw new StudioToolError("CAPABILITY_UNAVAILABLE",
              "The active project cannot privately compare a genuine selected orthographic reference.");
          }
          const selected = typeof referenceAssets.status === "function"
            ? referenceAssets.status().selectedReferenceId
            : typeof referenceAssets.list === "function"
              ? referenceAssets.list().selectedReferenceId : undefined;
          selectedReference = selected;
          if (selected === null) {
            throw new StudioToolError("NOT_FOUND",
              "Select an actual project-private concept image before requesting reference review.");
          }
          const requestedReferenceId = designReference?.referenceId
            ?? input.diagnostics?.referenceId;
          if (requestedReferenceId !== undefined && selected !== undefined
              && requestedReferenceId !== selected) {
            throw new StudioToolError("REFERENCE_NOT_SELECTED",
              "Private silhouette review may use only this project's currently selected reference.");
          }
          const requestedReferenceView = designReference === undefined
            ? views.find((view) => view.projection === "orthographic"
              && (view.background ?? captureBackground) === "transparent")
            : views.find((view) => view.id === designReference.viewId);
          if (!requestedReferenceView || requestedReferenceView.projection !== "orthographic"
              || (requestedReferenceView.background ?? captureBackground) !== "transparent") {
            throw new StudioToolError("INVALID_ARGUMENT",
              "Private reference alignment requires its explicitly paired real transparent orthographic inspection view.");
          }
        }
        for (const view of views) {
          verifyProjection(view);
          if (view.width !== undefined && view.height !== undefined
              && view.width * view.height > 1_920 * 1_080) {
            throw new StudioToolError("INVALID_ARGUMENT",
              "An isolated contact-sheet viewpoint exceeds its actual native pixel budget.");
          }
          if (view.near !== undefined && view.far !== undefined && view.far <= view.near) {
            throw new StudioToolError("INVALID_ARGUMENT",
              "An independent contact-sheet far plane must exceed its actual near plane.");
          }
        }
        const nativeDiagnostics = evidenceGroundedDesignReview
          ? { enabled: true }
          : input.diagnostics === undefined
            ? requestedDesign === undefined ? undefined : { enabled: true }
            : (() => {
              const { reference: _privateReference, referenceId: _privateReferenceId,
                ...actual } = input.diagnostics;
              return actual;
            })();
        const captured = await inspection.captureBatch({
          ...(input.target === undefined ? {} : { target: input.target }),
          views,
          format: "image/png",
          fit: input.fit ?? "projected",
          ...(input.padding === undefined ? {} : { padding: input.padding }),
          ...(captureBackground === undefined ? {} : { background: captureBackground }),
          ...(nativeDiagnostics === undefined ? {} : { diagnostics: nativeDiagnostics }),
          ...(input.expectedRevision === undefined ? {} : {
            expectedRevision: input.expectedRevision,
          }),
          ...(signal === undefined ? {} : { signal }),
        });
        if (!captured || !Array.isArray(captured.frames)
            || captured.frames.length !== views.length
            || captured.ownerCameraPreserved !== true
            || captured.ownerCameraRestored !== true) {
          throw new StudioToolError("CAPABILITY_UNAVAILABLE",
            "The native renderer did not attest genuine owner-preserving modeling viewpoints.");
        }
        if (!Number.isSafeInteger(captured.revision) || captured.revision < 0) {
          throw new StudioToolError("INVALID_CAPTURE",
            "The native contact sheet did not attest its exact committed owner revision.");
        }
        const beforeRevision = captured.revision;
        if (state(store).revision !== beforeRevision
            || input.expectedRevision !== undefined
              && input.expectedRevision !== beforeRevision) {
          throw new StudioToolError("STALE_REVISION",
            "The authored modeling project changed during independent image capture.");
        }
        if (designEntities !== undefined) {
          designScene = store.getScene();
          for (const entityId of designEntities) {
            if (!Object.hasOwn(designScene.entities, entityId)) {
              throw new StudioToolError("NOT_FOUND",
                `Design review references an entity absent from the captured project: ${entityId}.`);
            }
          }
        }
        if (reviewReference) {
          const currentReference = typeof referenceAssets.status === "function"
            ? referenceAssets.status().selectedReferenceId
            : typeof referenceAssets.list === "function"
              ? referenceAssets.list().selectedReferenceId : undefined;
          const requestedReferenceId = designReference?.referenceId
            ?? input.diagnostics?.referenceId;
          if (currentReference === null
              || selectedReference !== undefined && currentReference !== selectedReference
              || requestedReferenceId !== undefined && currentReference !== undefined
                && requestedReferenceId !== currentReference) {
            throw new StudioToolError("REFERENCE_NOT_SELECTED",
              "Private reference review must remain bound to the captured owner's selected image.");
          }
        }
        const frames = [];
        let totalFrameBytes = 0;
        for (const metadata of captured.frames) {
          aborted(signal);
          const retrieveFrame = typeof inspection.getFrameBytes === "function"
            ? inspection.getFrameBytes.bind(inspection) : inspection.getFrame.bind(inspection);
          const frame = await retrieveFrame({ frameId: metadata.frameId,
            maxInlineBytes: MAX_CONTACT_SHEET_FRAME_BYTES,
            ...(signal === undefined ? {} : { signal }),
          });
          const genuineBytes = frame?.bytes instanceof Uint8Array
            && frame.bytes.byteLength === frame.byteLength;
          if (!frame || !genuineBytes && typeof frame.base64 !== "string"
              || !Number.isSafeInteger(frame.byteLength)
              || frame.byteLength < 1 || frame.byteLength > MAX_CONTACT_SHEET_FRAME_BYTES
              || frame.byteLength !== metadata.byteLength
              || frame.frameId !== metadata.frameId || frame.viewId !== metadata.viewId
              || frame.width !== metadata.width || frame.height !== metadata.height
              || frame.mediaType !== "image/png"
              || metadata.digest !== undefined && frame.digest !== metadata.digest) {
            throw new StudioToolError("INVALID_CAPTURE",
              "A real native contact-sheet frame did not match its owner-preserving capture.");
          }
          totalFrameBytes += frame.byteLength;
          if (totalFrameBytes > MAX_CONTACT_SHEET_SOURCE_BYTES) {
            throw new StudioToolError("QUOTA_EXCEEDED",
              "The actual modeling viewpoints exceeded their bounded aggregate image budget.");
          }
          frames.push(frame);
        }
        if (state(store).revision !== beforeRevision) {
          throw new StudioToolError("STALE_REVISION",
            "The authored modeling project changed during independent image capture.");
        }
        const capturedOwner = typeof getCallbackOwner === "function"
          ? getCallbackOwner() : undefined;
        const capturedGeneration = typeof getOwnerGeneration === "function"
          ? getOwnerGeneration() : undefined;
        const assertFresh = () => {
          aborted(signal);
          if (state(store).revision !== beforeRevision) {
            throw new StudioToolError("STALE_REVISION",
              "The authored modeling project changed while the image sheet was being composed.");
          }
          if (typeof getCallbackOwner === "function"
              && getCallbackOwner() !== capturedOwner
              || typeof getOwnerGeneration === "function"
                && getOwnerGeneration() !== capturedGeneration) {
            throw new StudioToolError("OWNER_STATE_CHANGED",
              "The authenticated modeling owner changed while the image sheet was being composed.");
          }
        };
        const composed = await composeContactSheet({
          frames,
          scope,
          assertFresh,
          format: outputFormat,
          ...(input.quality === undefined ? {} : { quality: input.quality }),
          ...(input.columns === undefined ? {} : { columns: input.columns }),
          ...(input.maxWidth === undefined ? {} : { maxWidth: input.maxWidth }),
          ...(input.maxHeight === undefined ? {} : { maxHeight: input.maxHeight }),
          maxBytes: input.maxBytes ?? DEFAULT_CONTACT_SHEET_BYTES,
          ...(signal === undefined ? {} : { signal }),
        });
        if (!composed || composed.format !== "oriel.contact-sheet/1"
            || composed.mediaType !== outputFormat
            || typeof composed.base64 !== "string"
            || !Number.isSafeInteger(composed.byteLength)
            || composed.byteLength < 1
            || composed.byteLength > (input.maxBytes ?? DEFAULT_CONTACT_SHEET_BYTES)
            || !Array.isArray(composed.views)
            || composed.views.length !== frames.length) {
          throw new StudioToolError("INVALID_CAPTURE",
            "The labeled modeling contact sheet was not backed by genuine bounded frames in the requested image format.");
        }
        if (state(store).revision !== beforeRevision) {
          throw new StudioToolError("STALE_REVISION",
            "The authored modeling project changed while the image sheet was being composed.");
        }
        const { bytes: _internalPngBytes, ...artifact } = composed;
        const distinctViewCount = new Set(views.map((view) => JSON.stringify([
          view.preset ?? "three-quarter", view.azimuthDegrees ?? null,
          view.elevationDegrees ?? null,
        ]))).size;
        let referenceComparison;
        if (reviewReference) {
          const orthographic = captured.frames.find((frame) =>
            (designReference === undefined || frame.viewId === designReference.viewId)
              && frame.projection?.mode === "orthographic"
              && frame.background === "transparent");
          if (!orthographic) {
            throw new StudioToolError("INVALID_CAPTURE",
              "The renderer did not attest the actual transparent orthographic reference frame.");
          }
          referenceComparison = await reviewReferenceSilhouette({
            catalog: referenceAssets, inspection, frame: orthographic, scope,
            ...(input.target === undefined ? {} : { target: input.target }),
            ...(designReference?.referenceId === undefined
              && input.diagnostics?.referenceId === undefined ? {} : {
              referenceId: designReference?.referenceId ?? input.diagnostics.referenceId,
            }),
            ...(signal === undefined ? {} : { signal }),
          });
        }
        const diagnostics = input.diagnostics === undefined ? undefined
          : createVisualDiagnostics({
            frames: captured.frames,
            ...(input.target === undefined ? {} : { target: input.target }),
            ...(input.diagnostics.includeScene === false ? {} : {
              scene: store.getScene(),
            }),
            revision: beforeRevision,
            snapshotId: captured.snapshotId,
            ...(input.diagnostics.includeScene === undefined ? {} : {
              includeScene: input.diagnostics.includeScene,
            }),
            ...(input.diagnostics.maxEntities === undefined ? {} : {
              maxEntities: input.diagnostics.maxEntities,
            }),
            ...(input.diagnostics.maxFindings === undefined ? {} : {
              maxFindings: input.diagnostics.maxFindings,
            }),
            ...(referenceComparison === undefined || !legacyReference ? {}
              : { referenceComparison }),
            ...(signal === undefined ? {} : { signal }),
          });
        const technicalDiagnostics = requestedDesign === undefined ? undefined
          : diagnostics !== undefined && !legacyReference ? diagnostics
            : createVisualDiagnostics({ frames: captured.frames,
              ...(input.target === undefined ? {} : { target: input.target }),
              ...(designScene === undefined ? {} : { scene: designScene }),
              revision: beforeRevision, snapshotId: captured.snapshotId,
              ...(input.diagnostics?.includeScene === false ? { includeScene: false } : {}),
              ...(signal === undefined ? {} : { signal }) });
        if (state(store).revision !== beforeRevision) {
          throw new StudioToolError("STALE_REVISION",
            "The authored modeling project changed while genuine image evidence was being analyzed.");
        }
        const actualDistinctViews = diagnostics?.actualDistinctViewCount
          ?? technicalDiagnostics?.actualDistinctViewCount ?? distinctViewCount;
        const design = requestedDesign === undefined ? undefined
          : createVisualDesignReview({ frames: captured.frames,
            brief: requestedDesign.brief,
            geometry: requestedDesign.geometry === true,
            store,
            ...(designScene === undefined ? {} : { scene: designScene }),
            revision: beforeRevision, snapshotId: captured.snapshotId,
            actualDistinctViewCount: technicalDiagnostics.actualDistinctViewCount,
            ...(referenceComparison === undefined ? {} : { referenceComparison }),
            ...(signal === undefined ? {} : { signal }) });
        if (state(store).revision !== beforeRevision) {
          throw new StudioToolError("STALE_REVISION",
            "The authored project changed while genuine objective design evidence was reviewed.");
        }
        const technicalFindings = design === undefined ? undefined
          : [...technicalDiagnostics.findings,
            ...design.findings.filter(({ code }) => code.startsWith("mesh_"))]
            .slice(0, 16);
        const technicalLimitations = design === undefined ? undefined
          : [...new Set([...technicalDiagnostics.limitations,
            ...design.limitations.filter((limitation) =>
              limitation.startsWith("mesh-")
                || limitation === "smooth-intent-unverified"),
            ...(requestedDesign.geometry === true ? [] : ["mesh-topology-not-inspected"]),
          ])];
        return { ...artifact,
          revision: beforeRevision,
          snapshotId: captured.snapshotId,
          ownerCameraPreserved: true,
          ownerCameraRestored: true,
          qualityReview: {
            status: "needs_visual_review",
            distinctViewCount: actualDistinctViews,
            minimumDistinctViewsForComplexAssets: 3,
            complexAssetViewCoverageSatisfied: actualDistinctViews >= 3,
            automaticApproval: false,
            inspect: ["silhouette and proportions", "continuous primary surfaces",
              "integrated attachments and real openings", "floating or intersecting parts",
              "materials and readable lighting", "presentation from every actual viewpoint"],
            nextAction: "Inspect the genuine image. Any visible flaw means needs_more_work: correct the actual geometry, materials, or lighting and capture again. Never claim production_ready from a contact sheet alone.",
            ...(diagnostics === undefined ? {} : { diagnostics }),
            ...(design === undefined ? {} : {
              technicalReview: { format: "oriel.technical-render-review/1",
                revision: beforeRevision, snapshotId: captured.snapshotId,
                status: technicalFindings.length === 0
                  ? "no_technical_findings" : "technical_findings",
                findings: technicalFindings,
                limitations: technicalLimitations },
              designReview: design,
            }),
          },
        };
      },
    });
    add({ name: "render_frame_get",
      title: "Retrieve a bounded genuine WebGPU inspection frame",
      description: "Retrieve one actual owner-independent PNG/JPEG view by opaque frame handle without exposing unrelated browser state.",
      inputSchema: closedObject({
        frameId: opaqueHandle(),
        maxInlineBytes: integer(1_024, MAX_INLINE_ARTIFACT_BYTES),
      }, ["frameId"]),
      readOnlyHint: true,
      untrustedContentHint: true,
      handle: async (input, signal) => {
        const frame = await inspection.getFrame({
          ...input,
          maxInlineBytes: input.maxInlineBytes ?? MAX_INLINE_ARTIFACT_BYTES,
          ...(signal === undefined ? {} : { signal }),
        });
        if (!frame || typeof frame.base64 !== "string"
          || !Number.isSafeInteger(frame.byteLength)
          || frame.byteLength < 1
          || frame.byteLength > (input.maxInlineBytes ?? MAX_INLINE_ARTIFACT_BYTES)) {
          throw new StudioToolError("CAPABILITY_UNAVAILABLE",
            "The native inspection frame was unavailable or exceeded its bounded image budget.");
        }
        return frame;
      },
    });
  }

  if (exportAssets && typeof exportAssets.exportGroup === "function") {
    add({ name: "asset_export_group",
      title: "Export genuine grouped models or scene assets as GLB",
      description: "Export bounded selected mesh hierarchies, transforms, PBR materials, and generated textures; preserve editable controls only when explicitly requested.",
      inputSchema: closedObject({
        entityIds: {
          type: "array", minItems: 1, maxItems: MAX_GROUP_EXPORT_ENTITIES,
          uniqueItems: true, items: identifier(),
        },
        name: text(96),
        profile: enumText([GAME_ASSET_EXPORT_PROFILE]),
        inline: { type: "boolean" },
        preserveControls: { type: "boolean" },
        ...expectedRevisionField,
      }, ["entityIds"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: async (input, signal) => {
        const { inline, ...options } = input;
        const artifact = await prepareGroupedExport(options, signal);
        if (typeof artifacts?.retain !== "function") {
          return { ...exportArtifact(artifact, { onExport,
            inline: inline === true, signal }),
          ...(artifact.revision === undefined ? {} : { revision: artifact.revision }),
          ...(artifact.entityIds === undefined ? {} : { entityIds: [...artifact.entityIds] }),
          ...Object.fromEntries(["nodeCount", "meshCount", "materialCount", "textureCount",
            "vertexCount", "editableVertexCount", "faceCount", "selectedRootCount",
            "profile", "fidelityPolicy", "externalResources", "projectId",
            "projectGeneration"].filter((key) => artifact[key] !== undefined)
            .map((key) => [key, artifact[key]])) };
        }
        const shouldOffer = typeof publishExportOffer === "function"
          || typeof onExport === "function";
        const reservation = shouldOffer && typeof reserveExportOffer === "function"
          ? reserveExportOffer({ byteLength: bytesFrom(artifact.bytes)?.byteLength,
            profile: artifact.profile }) : undefined;
        let retained;
        let published = false;
        try {
          retained = await artifacts.retain(artifact,
            signal === undefined ? {} : { signal });
          const publish = typeof publishExportOffer === "function"
            ? (offered) => publishExportOffer(reservation, { ...offered, ...retained })
            : onExport;
          const result = exportArtifact(artifact, { onExport: publish,
            inline: inline === true, signal });
          published = true;
          return {
            ...result,
            ...retained,
            ...(artifact.revision === undefined ? {} : { revision: artifact.revision }),
            ...(artifact.entityIds === undefined ? {} : { entityIds: [...artifact.entityIds] }),
            ...Object.fromEntries(["nodeCount", "meshCount", "materialCount", "textureCount",
              "vertexCount", "editableVertexCount", "faceCount", "selectedRootCount",
              "profile", "fidelityPolicy", "externalResources", "projectId",
              "projectGeneration"].filter((key) => artifact[key] !== undefined)
              .map((key) => [key, artifact[key]])),
          };
        } catch (error) {
          if (!published && retained?.artifactId !== undefined) {
            try { artifacts.release({ artifactId: retained.artifactId }); } catch {}
          }
          if (!published && reservation !== undefined) {
            releaseExportOffer?.(reservation);
          }
          throw error;
        }
      },
    });
  }

  const markingPreflight = materialAuthoring?.capabilities?.markingPreflight === true
    && typeof materialAuthoring.previewMarkings === "function";
  const semanticMarkingLandmarks =
    materialAuthoring?.capabilities?.semanticMarkingLandmarks === true;
  add({ name: "material_inspect",
    title: "Inspect actual entity PBR material",
    description: "Inspect actual committed PBR finish; optionally preview the owner-preserved surface.",
    inputSchema: closedObject({ entityId: identifier(), preview: assignedMaterialPreview,
      ...(markingPreflight ? { markings: surfaceMarkingSchema({
        semanticLandmarks: semanticMarkingLandmarks }) } : {}),
      ...expectedRevisionField }, ["entityId"]),
      readOnlyHint: true,
      untrustedContentHint: true,
      handle: async ({ entityId, preview, markings, expectedRevision }, signal) => {
        const currentRevision = state(store).revision;
        if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
          throw new StudioToolError("STALE_REVISION",
            "The inspected assigned finish belongs to a stale authored scene revision.");
        }
        if (typeof store.inspectAssignedMaterial === "function") {
          const assigned = await store.inspectAssignedMaterial(entityId,
            signal === undefined ? {} : { signal });
          if (expectedRevision !== undefined && assigned.revision !== undefined
              && assigned.revision !== expectedRevision) {
            throw new StudioToolError("STALE_REVISION",
              "The inspected assigned finish belongs to a stale authored scene revision.");
          }
          if (markings !== undefined) {
            if (preview?.render !== true) {
              invalid("requires an actual owner-preserved rendered preview", "input.preview");
            }
            const capabilities = typeof inspection?.getCapabilities === "function"
              ? inspection.getCapabilities() : inspection?.capabilities;
            const requestedViews = preview.views ?? ["front", "right"];
            if (capabilities?.materialPreview !== true
                || capabilities.surfaceMaterialPreview !== true
                || !Array.isArray(capabilities.materialPreviewViews)
                || requestedViews.some((view) => !capabilities.materialPreviewViews.includes(view))
                || typeof inspection?.previewMaterial !== "function") {
              throw new StudioToolError("CAPABILITY_UNAVAILABLE",
                "Genuine isolated owner-preserved marking preview views are unavailable.");
            }
            const candidate = await materialAuthoring.previewMarkings({
              material: Object.fromEntries(Object.entries(assigned.material ?? {})
                .filter(([field]) => Object.hasOwn(scalarMaterialFields, field))),
              markings, entityIds: [entityId],
              expectedRevision: expectedRevision ?? currentRevision,
              ...(signal === undefined ? {} : { signal }),
            });
            const maps = candidate?.candidate?.maps;
            if (!Array.isArray(maps) || maps.length < 1 || maps.length > 3
                || candidate.revision !== currentRevision
                || maps.some(({ role, mediaType, digest, bytes }) =>
                  !["baseColor", "normal", "metallicRoughness"].includes(role)
                  || mediaType !== "image/png"
                  || typeof digest !== "string"
                  || !new RegExp(SHA256_DIGEST_PATTERN, "u").test(digest)
                  || !(bytes instanceof Uint8Array)
                  || bytes.byteLength < 1 || bytes.byteLength > 2 * 1024 * 1024)) {
              throw new StudioToolError("INVALID_ASSET",
                "The hypothetical marking preview has no verified bounded owner texture.");
            }
            const textures = maps.map(({ role, digest, colorSpace, bytes }) =>
              ({ role, digest, colorSpace, bytes }));
            try {
              const views = [];
              for (const view of requestedViews) {
                if (state(store).revision !== currentRevision) {
                  throw new StudioToolError("STALE_REVISION",
                    "The hypothetical marking preview belongs to a stale scene revision.");
                }
                const frame = await inspection.previewMaterial({
                  material: candidate.candidate.material, textures,
                  target: { entityId }, view,
                  ...(preview.width === undefined ? {} : { width: preview.width }),
                  ...(preview.height === undefined ? {} : { height: preview.height }),
                  ...(preview.lighting === undefined ? {} : { lighting: preview.lighting }),
                  expectedRevision: currentRevision,
                  ...(signal === undefined ? {} : { signal }),
                });
                if (frame?.genuineWebGpu !== true || frame.ownerCameraPreserved !== true
                    || frame.authoredSceneChanged !== false
                    || frame.target?.entityId !== entityId || frame.view !== view
                    || state(store).revision !== currentRevision) {
                  throw new StudioToolError("INVALID_CAPTURE",
                    "The native renderer did not attest the exact hypothetical marking view.");
                }
                views.push(frame);
              }
              return { ...assigned, markingFeedback: candidate.markingFeedback,
                preview: { supported: true, views,
                  limitations: ["isolated-target-omits-surrounding-scene-occluders",
                    ...(Object.keys(assigned.texturePaths ?? {})
                      .some((field) => field !== "baseColorTexture")
                      ? ["isolated-preview-omits-existing-non-basecolor-texture-maps"]
                      : [])] } };
            } finally {
              for (const { bytes } of maps) bytes.fill(0);
            }
          }
          if (preview === undefined) return assigned;
          if (preview.views !== undefined) {
            invalid("requires hypothetical surface markings", "input.preview.views");
          }
        if (preview.matchColor !== undefined && preview.lighting !== "neutral-reference"
            || preview.maxDeltaE !== undefined && preview.matchColor === undefined) {
          throw new StudioToolError("INVALID_ARGUMENT",
            "Assigned material color matching requires neutral-reference lighting and an explicit target color.");
        }
        const capabilities = typeof inspection?.getCapabilities === "function"
          ? inspection.getCapabilities() : inspection?.capabilities;
        const maps = assigned.materialResponse?.textures ?? [];
        const unsupported = !Array.isArray(maps) || maps.length > 3
          || maps.some((map) => !["baseColor", "normal", "metallicRoughness"]
            .includes(map.role)
            || map.mediaType !== undefined && map.mediaType !== "image/png"
            || typeof map.digest !== "string"
            || !new RegExp(SHA256_DIGEST_PATTERN, "u").test(map.digest));
        if (capabilities?.materialPreview !== true
            || capabilities.surfaceMaterialPreview !== true
            || typeof inspection?.previewMaterial !== "function"
            || typeof store.getAsset !== "function" || unsupported) {
          return { ...assigned, preview: { supported: false,
            code: "CAPABILITY_UNAVAILABLE" } };
        }
        const textures = [];
        try {
          for (const map of maps) {
            const field = map.role === "baseColor" ? "baseColorTexture"
              : map.role === "normal" ? "normalTexture" : "metallicRoughnessTexture";
            const path = assigned.texturePaths?.[field];
            const bytes = typeof path === "string" ? store.getAsset(path) : null;
            if (!(bytes instanceof Uint8Array) || !path.endsWith(".png")) {
              throw new StudioToolError("INVALID_ASSET",
                "The assigned preview cannot recover its exact verified committed PNG texture.");
            }
            if (bytes.byteLength > 2 * 1024 * 1024) {
              bytes.fill(0);
              return { ...assigned, preview: { supported: false,
                code: "CAPABILITY_UNAVAILABLE" } };
            }
            textures.push({ role: map.role, digest: map.digest,
              colorSpace: map.role === "baseColor" ? "srgb" : "linear", bytes });
          }
          const frame = await inspection.previewMaterial({
            material: assigned.material,
            textures,
            target: { entityId },
            ...(preview.width === undefined ? {} : { width: preview.width }),
            ...(preview.height === undefined ? {} : { height: preview.height }),
            ...(preview.lighting === undefined ? {} : { lighting: preview.lighting }),
            ...(preview.matchColor === undefined ? {} : {
              matchColor: [...preview.matchColor],
            }),
            ...(preview.maxDeltaE === undefined ? {} : { maxDeltaE: preview.maxDeltaE }),
            expectedRevision: expectedRevision ?? assigned.revision,
            ...(signal === undefined ? {} : { signal }),
          });
          if (frame?.genuineWebGpu !== true || frame.ownerCameraPreserved !== true
              || frame.authoredSceneChanged !== false
              || frame.target?.entityId !== entityId || !frame.appearance) {
            throw new StudioToolError("INVALID_CAPTURE",
              "The native renderer did not preview the exact authenticated assigned surface.");
          }
          return { ...assigned, preview: { ...frame, supported: true } };
        } finally {
          for (const texture of textures) texture.bytes.fill(0);
        }
      }
      if (preview !== undefined) {
        return { entityId, preview: { supported: false,
          code: "CAPABILITY_UNAVAILABLE" } };
      }
      const scene = store.getScene();
      const entity = scene.entities?.[entityId];
      if (!entity) throw new StudioToolError("NOT_FOUND", "The selected scene entity does not exist.");
      const material = entity.components?.["oriel.material"];
      if (!material || typeof material !== "object") {
        throw new StudioToolError("NOT_FOUND", "The selected scene entity has no actual PBR material.");
      }
      const texturePaths = Object.fromEntries(Object.entries(material)
        .filter(([key, value]) => key.endsWith("Texture") && typeof value === "string"));
      const sample = entity.components?.["oriel.material_sample"];
      return { entityId, revision: state(store).revision, material,
        materialResponse: describeMaterialResponse(material),
        ...(Object.keys(texturePaths).length === 0 ? {} : { texturePaths }),
        ...(sample === undefined ? {} : { sample }) };
    },
  });

  const beginImport = modelImports?.beginBundle ?? modelImports?.begin;
  if (typeof beginImport === "function") {
    add({ name: "model_import_begin",
      title: "Begin bounded genuine GLB or glTF import",
      description: "Reserve a digest-verified model upload; ordinary roots remain 16 MiB, while an exact same-project opaque export handle permits up to 64 MiB.",
      inputSchema: closedObject({
        entryPath: assetPath(),
        files: { type: "array", minItems: 1, maxItems: MAX_MODEL_FILES,
          items: closedObject({ path: assetPath(), name: text(160),
            byteLength: integer(1, MAX_OWNER_MODEL_BYTES),
            digest: { ...text(71, 71), pattern: SHA256_DIGEST_PATTERN },
            mediaType: enumText(["model/gltf-binary", "model/gltf+json",
              "application/octet-stream", "image/png", "image/jpeg"]),
          }, ["path", "byteLength", "digest", "mediaType"]) },
        parentEntityId: identifier(),
        sourceArtifactId: identifier(),
        sceneSelector: modelSceneSelector,
        fidelityPolicy: enumText(["strict"]),
        ...expectedRevisionField,
      }, ["entryPath", "files"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      validate(input) {
        const total = input.files.reduce((count, file) => count + file.byteLength, 0);
        if (input.sourceArtifactId === undefined
            && (total > MAX_MODEL_BUNDLE_BYTES
              || input.files.some((file) => file.byteLength > MAX_MODEL_ROOT_BYTES))) {
          invalid("ordinary external model imports remain limited to 16 MiB; provide a verified same-project sourceArtifactId for a dense owner export",
            "input.files");
        }
      },
      handle: (input, signal) => beginImport.call(modelImports, { ...input,
        ...(signal === undefined ? {} : { signal }) }),
    });
  }

  const uploadModelChunk = modelImports?.uploadChunk ?? modelImports?.chunk;
  if (typeof uploadModelChunk === "function") {
    add({ name: "model_import_chunk",
      title: "Upload one bounded genuine model chunk",
      description: "Upload up to 256 KiB of canonical base64 GLB/glTF dependency bytes with an exact ordered file offset and retry-safe index.",
      inputSchema: closedObject({ importId: identifier(), path: assetPath(),
        index: integer(0, MAX_OWNER_MODEL_BYTES),
        offset: integer(0, MAX_OWNER_MODEL_BYTES),
        dataBase64: { ...text(MAX_REFERENCE_CHUNK_BASE64, 4),
          pattern: CANONICAL_BASE64_PATTERN },
      }, ["importId", "path", "index", "offset", "dataBase64"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input, signal) => uploadModelChunk.call(modelImports, { ...input,
        ...(signal === undefined ? {} : { signal }) }),
    });
  }

  if (typeof modelImports?.status === "function") {
    add({ name: "model_import_status",
      title: "Inspect genuine model upload status",
      description: "Inspect actual browser-owned GLB/glTF dependency upload progress without reading private model bytes.",
      inputSchema: closedObject({ importId: identifier() }, ["importId"]),
      readOnlyHint: true,
      untrustedContentHint: true,
      handle: (input) => modelImports.status(input),
    });
  }

  const inspectModelImport = modelImports?.inspect ?? modelImports?.inspectBundle;
  if (typeof inspectModelImport === "function") {
    add({ name: "model_import_inspect",
      title: "Inspect an uploaded genuine model bundle",
      description: "Parse a fully uploaded GLB/glTF bundle and inspect actual bounded mesh, material, texture, and scene counts.",
      inputSchema: closedObject({ importId: identifier(), sceneSelector: modelSceneSelector,
        fidelityPolicy: enumText(["strict"]) }, ["importId"]),
      readOnlyHint: true,
      untrustedContentHint: true,
      handle: (input, signal) => inspectModelImport.call(modelImports, { ...input,
        ...(signal === undefined ? {} : { signal }) }),
    });
  }

  const commitModelImport = modelImports?.commit ?? modelImports?.commitImport;
  if (typeof commitModelImport === "function") {
    add({ name: "model_import_commit",
      title: "Commit actual uploaded editable model",
      description: "Validate genuine uploaded model dependencies and atomically commit actual editable geometry; restore safe authoring controls only when explicitly requested.",
      inputSchema: closedObject({ importId: identifier(), parentEntityId: identifier(),
        sceneSelector: modelSceneSelector,
        preserveControls: { type: "boolean" },
        ...expectedRevisionField }, ["importId"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input, signal) => commitModelImport.call(modelImports, { ...input,
        ...(signal === undefined ? {} : { signal }) }),
    });
  }

  if (typeof modelImports?.abort === "function") {
    add({ name: "model_import_abort",
      title: "Abort actual browser-local model upload",
      description: "Abort an uncommitted GLB/glTF dependency import and immediately zero its retained browser-owned bytes.",
      inputSchema: closedObject({ importId: identifier() }, ["importId"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input) => modelImports.abort(input),
    });
  }

  if (typeof modelImports?.upgradeExisting === "function") {
    add({ name: "asset_convert_editable",
      title: "Convert actual GLB asset to editable geometry",
      description: "Convert one existing genuine GLB/glTF asset into actual editable geometry without replacing its entity identity.",
      inputSchema: closedObject({ entityId: identifier(), ...expectedRevisionField },
        ["entityId"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input, signal) => modelImports.upgradeExisting({ ...input,
        ...(signal === undefined ? {} : { signal }) }),
    });
  }

  if (typeof exportAssets?.exportGroup === "function" && typeof artifacts?.retain === "function") {
    add({ name: "asset_artifact_prepare",
      title: "Prepare actual grouped GLB artifact handle",
      description: "Export selected genuine mesh hierarchies behind a private artifact handle; include editable controls only when explicitly requested.",
      inputSchema: closedObject({ entityIds: { type: "array", minItems: 1,
        maxItems: MAX_GROUP_EXPORT_ENTITIES, uniqueItems: true, items: identifier() },
      name: text(96), preserveControls: { type: "boolean" },
      profile: enumText([GAME_ASSET_EXPORT_PROFILE]),
      ...expectedRevisionField }, ["entityIds"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: async (input, signal) => {
        const artifact = await prepareGroupedExport(input, signal);
        const shouldOffer = typeof publishExportOffer === "function"
          || typeof onExport === "function";
        const reservation = shouldOffer && typeof reserveExportOffer === "function"
          ? reserveExportOffer({ byteLength: bytesFrom(artifact.bytes)?.byteLength,
            profile: artifact.profile }) : undefined;
        let retained;
        let published = false;
        try {
          retained = await artifacts.retain(artifact,
            signal === undefined ? {} : { signal });
          const offered = { ...artifact, ...retained, bytes: bytesFrom(artifact.bytes) };
          if (typeof publishExportOffer === "function") {
            publishExportOffer(reservation, offered);
          } else if (typeof onExport === "function") {
            onExport(offered);
          }
          published = true;
          return retained;
        } catch (error) {
          if (!published && retained?.artifactId !== undefined) {
            try { artifacts.release({ artifactId: retained.artifactId }); } catch {}
          }
          if (!published && reservation !== undefined) {
            releaseExportOffer?.(reservation);
          }
          throw error;
        }
      },
    });
  }

  const readArtifact = artifacts?.readChunk ?? artifacts?.read;
  if (typeof readArtifact === "function") {
    add({ name: "asset_artifact_read_chunk",
      title: "Read bounded actual GLB artifact bytes",
      description: "Read up to 256 KiB of one actual private browser-owned GLB export by opaque artifact handle and exact byte offset.",
      inputSchema: closedObject({ artifactId: identifier(),
        offset: integer(0, MAX_OWNER_MODEL_BYTES),
        maxBytes: integer(1, MAX_REFERENCE_CHUNK_BYTES) }, ["artifactId", "offset"]),
      readOnlyHint: true,
      untrustedContentHint: true,
      handle: (input, signal) => readArtifact.call(artifacts, { ...input,
        ...(signal === undefined ? {} : { signal }) }),
    });
  }

  if (typeof artifacts?.release === "function") {
    add({ name: "asset_artifact_release",
      title: "Release actual browser-local GLB artifact",
      description: "Release one private browser-owned GLB export handle and immediately zero its retained bytes.",
      inputSchema: closedObject({ artifactId: identifier() }, ["artifactId"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input) => artifacts.release(input),
    });
  }

  if (typeof materialAuthoring?.create === "function") {
    const proceduralMarkings = materialAuthoring.capabilities?.proceduralMarkings === true;
    const atomicMaterialAssignment =
      materialAuthoring.capabilities?.atomicMaterialAssignment === true;
    add({ name: "material_create",
      title: "Create a genuine custom PBR material",
      description: proceduralMarkings
        ? "Create verified project-owned PBR materials and bounded real surface-marking textures."
        : "Create one project-owned PBR material; textures require verified upload.",
      inputSchema: closedObject({ name: text(80),
        material: closedObject(scalarMaterialFields),
        ...(proceduralMarkings ? { markings: surfaceMarkingSchema({
          semanticLandmarks: semanticMarkingLandmarks }) } : {}),
        ...(atomicMaterialAssignment ? { entityIds: { type: "array", minItems: 1,
          maxItems: 32, uniqueItems: true, items: identifier() } } : {}),
        ...expectedRevisionField }, ["name"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: async (input, signal) => summarizeMutation(
        await materialAuthoring.create({ ...input,
          ...(signal === undefined ? {} : { signal }) }), store),
    });
  }

  const beginMaterialUpload = materialUploads?.begin ?? materialUploads?.beginUpload;
  if (typeof beginMaterialUpload === "function") {
    add({ name: "material_upload_begin",
      title: "Begin a verified custom material texture upload",
      description: "Begin one project-fenced upload of up to six actual PNG/JPEG PBR source maps; each map is at most 4 MiB and 2048², the bundle at most 16 MiB, with exact role, dimensions, color space, and SHA-256.",
      inputSchema: closedObject({ name: text(80),
        material: closedObject(scalarMaterialFields),
        maps: { type: "array", minItems: 1, maxItems: MAX_MATERIAL_SOURCE_MAPS,
          items: uploadedMaterialMap },
        ...expectedRevisionField }, ["name", "maps"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input, signal) => {
        let totalBytes = 0;
        const normalizedRoles = new Set();
        for (const map of input.maps) {
          totalBytes += map.byteLength;
          const role = map.role === "albedo" ? "baseColor"
            : map.role === "ambientOcclusion" ? "occlusion"
              : map.role === "orm" ? "metallicRoughness" : map.role;
          if (normalizedRoles.has(role)) {
            throw new StudioToolError("INVALID_ARGUMENT",
              "Custom material source maps must have distinct normalized texture roles.");
          }
          normalizedRoles.add(role);
          if (map.colorSpace !== undefined
            && map.colorSpace !== (["baseColor", "emissive"].includes(role)
              ? "srgb" : "linear")) {
            throw new StudioToolError("INVALID_ARGUMENT",
              "A custom texture role requires its genuine physically based color space.");
          }
        }
        if (totalBytes > MAX_MATERIAL_BUNDLE_BYTES) {
          throw new StudioToolError("INVALID_ARGUMENT",
            "Custom material source maps exceed the bounded 16 MiB upload budget.");
        }
        if (normalizedRoles.has("metallicRoughness")
          && (normalizedRoles.has("metallic") || normalizedRoles.has("roughness"))) {
          throw new StudioToolError("INVALID_ARGUMENT",
            "A packed metallic-roughness map cannot be mixed with separate channels.");
        }
        return beginMaterialUpload.call(materialUploads, { ...input,
          ...(signal === undefined ? {} : { signal }) });
      },
    });
  }

  const uploadMaterialChunk = materialUploads?.uploadChunk ?? materialUploads?.chunk;
  if (typeof uploadMaterialChunk === "function") {
    add({ name: "material_upload_chunk",
      title: "Upload one verified custom material texture chunk",
      description: "Upload one exact ordered canonical-base64 texture chunk of at most 256 KiB to its project-owned material upload session; duplicate chunks must be byte-identical.",
      inputSchema: closedObject({ uploadId: identifier(), role: materialTextureRole,
        index: integer(0, MAX_MATERIAL_MAP_BYTES),
        offset: integer(0, MAX_MATERIAL_MAP_BYTES),
        dataBase64: { ...text(MAX_REFERENCE_CHUNK_BASE64, 4),
          pattern: CANONICAL_BASE64_PATTERN } },
      ["uploadId", "role", "index", "offset", "dataBase64"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input, signal) => uploadMaterialChunk.call(materialUploads, { ...input,
        ...(signal === undefined ? {} : { signal }) }),
    });
  }

  if (typeof materialUploads?.status === "function") {
    add({ name: "material_upload_status",
      title: "Inspect a project-owned material texture upload",
      description: "Inspect bounded progress, actual remaining bytes, map verification, and project ownership for one existing genuine custom material texture upload.",
      inputSchema: closedObject({ uploadId: identifier() }, ["uploadId"]),
      readOnlyHint: true,
      untrustedContentHint: true,
      handle: (input, signal) => materialUploads.status({ ...input,
        ...(signal === undefined ? {} : { signal }) }),
    });
  }

  if (typeof materialUploads?.commit === "function") {
    add({ name: "material_upload_commit",
      title: "Register a verified custom textured PBR material",
      description: "Verify all actual uploaded PNG/JPEG map bytes, dimensions, SHA-256 digests, and channel packing before atomically registering one project-owned reusable PBR material.",
      inputSchema: closedObject({ uploadId: identifier(),
        ...expectedRevisionField }, ["uploadId"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: async (input, signal) => summarizeMutation(
        await materialUploads.commit({ ...input,
          ...(signal === undefined ? {} : { signal }) }), store),
    });
  }

  if (typeof materialUploads?.abort === "function") {
    add({ name: "material_upload_abort",
      title: "Abort a private custom material texture upload",
      description: "Abort one project-owned custom material upload and immediately release its retained uncommitted texture bytes.",
      inputSchema: closedObject({ uploadId: identifier() }, ["uploadId"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input, signal) => materialUploads.abort({ ...input,
        ...(signal === undefined ? {} : { signal }) }),
    });
  }

  if (partAuthoring) {
    add({ name: "part_add",
      title: "Add one editable visible modeling part",
      description: "Create editable vehicles, cabins, wheels, windows, headlights, grilles, lathes; closed profiles, radial thickness, both/start/end/none caps; refine complex forms afterward.",
      inputSchema: closedObject({ ...partFields, ...expectedRevisionField }),
      readOnlyHint: false,
      untrustedContentHint: true,
      validate: validateNamedPart,
      handle: (input, signal) => partAuthoring.add(input, signal),
    });
    add({ name: "parts_add",
      title: "Add a small atomic group of named parts",
      description: "Create one to eight editable blockout or assembly parts atomically; attach by vehicle socket and optionally clamp invalid bevels with exact repair receipts.",
      inputSchema: closedObject({
        parts: { type: "array", minItems: 1, maxItems: 8,
          items: closedObject(partFields) },
        space: partFields.space,
        clampBevel: { type: "boolean" },
        ...expectedRevisionField,
      }, ["parts"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      validate: (input) => {
        for (const [index, part] of input.parts.entries()) {
          validateNamedPart(part, `input.parts[${index}]`);
        }
      },
      handle: (input, signal) => partAuthoring.addMany(input, signal),
    });
    add({ name: "part_edit",
      title: "Edit a named modeling part",
      description: "Move, resize, rename, or reseat an existing part against a genuine generated vehicle socket; preserve independently editable geometry and apply friendly materials.",
      inputSchema: closedObject({ target: partTarget, name: text(128),
        position: vector(3), move: vector(3), size: vector(3, positive()),
        rotation: vector(3, finite(-36_000, 36_000)),
        scale: vector(3, positive(1_000)), space: partFields.space,
        parent: nullable(partTarget),
        attach: partPlacement, socket: partFields.socket,
        material: partTarget, color: partFields.color,
        metallic: unit(), roughness: unit(), ...expectedRevisionField }, [],
      { minProperties: 1 }),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input, signal) => partAuthoring.edit(input, signal),
    });
    add({ name: "part_duplicate",
      title: "Duplicate an independently editable modeling part",
      description: "Duplicate one named part as independently editable geometry; optionally include attachments.",
      inputSchema: closedObject({ target: partTarget, name: text(128),
        offset: vector(3), includeAttached: { type: "boolean" },
        ...expectedRevisionField }),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input, signal) => partAuthoring.duplicate(input, signal),
    });
    add({ name: "part_repeat",
      title: "Create an independent editable part pattern",
      description: "Create independent linear, radial, grid, or mirrored parts; optionally include attachments.",
      inputSchema: closedObject({ target: partTarget,
        pattern: enumText(["linear", "radial", "grid", "mirror"]),
        count: integer(2, 32), axis: coordinateAxis,
        spacing: finite(), offset: vector(3), columns: integer(1, 32), radius: positive(),
        center: vector(3), angleDegrees: finite(-360, 360),
        includeAttached: { type: "boolean" },
        ...expectedRevisionField }, ["pattern"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      validate: (input) => {
        if (input.spacing === 0) invalid("must be nonzero", "input.spacing");
        if (input.offset !== undefined) {
          if (input.pattern !== "linear") {
            invalid("requires pattern linear", "input.offset");
          }
          if (input.offset.every((value) => value === 0)) {
            invalid("must be a nonzero displacement", "input.offset");
          }
          if (input.spacing !== undefined) {
            invalid("conflicts with offset; choose one linear displacement", "input.spacing");
          }
        }
        if (input.pattern === "radial" && input.angleDegrees === 0) {
          invalid("must be nonzero for a radial pattern", "input.angleDegrees");
        }
      },
      handle: (input, signal) => partAuthoring.repeat(input, signal),
    });
    add({ name: "part_group",
      title: "Group independently editable modeling parts",
      description: "Group up to eight sibling parts without changing geometry, materials, or positions.",
      inputSchema: closedObject({ name: text(128),
        targets: { type: "array", minItems: 1, maxItems: 8,
          uniqueItems: true, items: partTarget }, ...expectedRevisionField }, ["targets"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input, signal) => partAuthoring.group(input, signal),
    });
    add({ name: "part_feature",
      title: "Refine a named semantic modeling feature",
      description: ["Shape genuine editable surfaces",
        ...(persistentControlCages
          ? ["coarse control cages, creases, and open-boundary bridges"] : []),
        ...(editableCurveAuthoring ? ["stable curve profiles and actual C0/G1 joins"] : []),
        ...(ongoingReflectionSymmetry ? ["persistent reflection symmetry"] : []),
      ].join("; ") + ".",
      inputSchema: closedObject({ target: partTarget,
        feature: enumText(["extrude", "inset", "bevel", "subdivide", "smooth", "sculpt",
          ...(persistentControlCages ? ["cage", "control", "crease", "bridge"] : []),
          ...(editableCurveAuthoring ? ["profile", "continuity"] : []),
          ...(ongoingReflectionSymmetry ? ["symmetry"] : [])]),
        face: enumText(["top", "bottom", "left", "right", "front", "back"]),
        region: text(96), move: vector(3),
        strokes: { type: "array", minItems: 1, maxItems: MAX_CONTROL_BATCH_OPERATIONS,
          items: semanticSculptStroke },
        falloff: compactEnum(["constant", "linear", "smooth"]),
        symmetryAxis: coordinateAxis, symmetryOffset: finite(),
        amount: finite(-1_000, 1_000),
        radius: positive(),
        edges: controlEdges,
        segments: integer(1, 8),
        levels: integer(persistentControlCages ? 0 : 1, 6), strength: unit(),
        creaseAngleDegrees: finite(0, 180),
        ...(persistentControlCages || ongoingReflectionSymmetry ? {
          mode: enumText(["enable", "disable", "bake", "subdivide"]),
        } : {}),
        ...(persistentControlCages ? {
          scheme: enumText(["catmullClark", "loop"]),
          selection: compactControlSelection,
          vertices: controlIndices,
          scale: vector(3, positive(1_000)),
          protectBoundary: { type: "boolean" },
          protectCreases: { type: "boolean" },
          sharpness: finite(0, 6),
          leftLoop: boundaryLoop,
          rightLoop: boundaryLoop,
        } : {}),
        ...(editableCurveAuthoring ? {
          edits: compactCurveControlEdits,
          bake: { type: "boolean" },
          source: partTarget,
          sourceBoundary: enumText(["start", "end"]),
          boundary: enumText(["start", "end"]),
          order: enumText(["position", "C0", "G0", "tangent", "G1"]),
          sourceAnchorId: authoredControlIdentifier,
          targetAnchorId: authoredControlIdentifier,
          direction: enumText(["forward", "reverse"]),
          tangentScale: positive(),
        } : {}),
        ...(ongoingReflectionSymmetry ? {
          axis: coordinateAxis,
          offset: finite(),
          tolerance: positive(),
          symmetryConstraint: reflectionConstraint,
        } : {}),
        ...expectedRevisionField }, ["feature"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      validate: (input) => {
        if (input.strokes !== undefined && input.feature !== "sculpt") {
          invalid("requires feature sculpt", "input.strokes");
        }
        if (input.feature === "sculpt") {
          if (input.strokes === undefined) {
            if (input.region === undefined) invalid("is required", "input.region");
            if (input.move === undefined) invalid("is required", "input.move");
            if (input.move.every((coordinate) => coordinate === 0)) {
              invalid("sculpt movement must be nonzero", "input.move");
            }
          } else {
            for (const field of ["region", "move"]) {
              if (input[field] !== undefined) {
                invalid("cannot combine one sculpt stroke with batched strokes",
                  `input.${field}`);
              }
            }
            for (const [index, stroke] of input.strokes.entries()) {
              if (stroke.move.every((coordinate) => coordinate === 0)) {
                invalid("sculpt movement must be nonzero",
                  `input.strokes[${index}].move`);
              }
            }
          }
          if (input.symmetryOffset !== undefined && input.symmetryAxis === undefined) {
            invalid("requires symmetryAxis", "input.symmetryOffset");
          }
          for (const field of ["strength", "radius", "amount"]) {
            if (input[field] !== undefined) {
              invalid("is unsupported for sculpt", `input.${field}`);
            }
          }
        }
        if (input.feature === "subdivide") {
          if (!persistentControlCages || input.face !== undefined || input.region !== undefined) {
            for (const field of ["levels", "strength", "creaseAngleDegrees", "scheme"]) {
              if (input[field] !== undefined) {
                invalid("requires active cage-backed subdivision without a face or region",
                  `input.${field}`);
              }
            }
          }
        }
        if (input.feature === "bevel") {
          if (input.segments !== undefined && input.segments !== 1) {
            invalid("only one genuine bevel segment is currently supported", "input.segments");
          }
          if (input.amount !== undefined && input.radius !== undefined
              && input.amount !== input.radius) {
            invalid("conflicts with amount; specify one consistent bevel width", "input.radius");
          }
        }
        if (input.levels === 0 && input.feature !== "cage") {
          invalid("must be at least 1 for actual refinement", "input.levels");
        }
        if (input.feature === "control") {
          if ((input.move === undefined) === (input.scale === undefined)) {
            invalid("requires exactly one move or scale", "input.move");
          }
          if (input.selection === undefined && input.vertices === undefined) {
            invalid("is required", "input.selection");
          }
        }
        if (input.feature === "crease") {
          if (input.sharpness === undefined) invalid("is required", "input.sharpness");
          if (input.edges === undefined && input.vertices === undefined) {
            invalid("requires real control edges or vertices", "input.edges");
          }
        }
        if (input.feature === "bridge") {
          if (input.leftLoop === undefined) invalid("is required", "input.leftLoop");
          if (input.rightLoop === undefined) invalid("is required", "input.rightLoop");
        }
        if (input.feature === "profile") {
          if (input.bake !== true && input.edits === undefined
              && input.selection === undefined) {
            invalid("requires actual profile edits, a fluent control region, or explicit baking",
              "input.edits");
          }
          if (input.selection !== undefined && input.move === undefined) {
            invalid("requires a genuine source-control displacement", "input.move");
          }
          if (input.bake === true && (input.edits !== undefined
              || input.selection !== undefined)) {
            invalid("cannot combine baking with source-control edits", "input.bake");
          }
        }
        if (input.feature === "continuity" && input.source === undefined) {
          invalid("is required", "input.source");
        }
      },
      handle: (input, signal) => partAuthoring.feature(input, signal),
    });
    add({ name: "part_remove",
      title: "Remove a named modeling part",
      description: "Remove one explicitly named existing part in an undoable edit; preserve unrelated work.",
      inputSchema: closedObject({ target: partTarget, recursive: { type: "boolean" },
        ...expectedRevisionField }, ["target"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      destructiveHint: true,
      handle: (input, signal) => partAuthoring.remove(input, signal),
    });
    add({ name: "part_convert",
      title: "Convert a named primitive to editable geometry",
      description: "Convert an existing primitive to editable GLB; preserve identity, placement, and material.",
      inputSchema: closedObject({ target: partTarget,
        ...expectedRevisionField }, ["target"]),
      readOnlyHint: false,
      untrustedContentHint: true,
      handle: (input, signal) => partAuthoring.convert(input, signal),
    });
    add({ name: "part_boolean",
      title: "Cut, blend, or combine modeled solids",
      description: persistentControlCages
        ? "Cut or blend solids with replayable non-destructive cutter stacks; preserve live control cages; explicitly confirm destructive scene batches."
        : "Cut or blend closed solids across touching coplanar or intersecting curved surfaces; preserve openings and children; explicitly confirm destructive batches.",
      inputSchema: closedObject({ target: partTarget, tool: partTarget,
        cutter: compactSolidCutter, mirror: compactCutterMirror,
        operation: enumText(["difference", "union", "intersection", "blend", "batch"]),
        keepTool: { type: "boolean" }, radius: positive(), segments: integer(1, 4),
        batch: text(MAX_CONFIRMED_BATCH_BYTES, 2),
        confirm: { type: "boolean", const: true },
        ...expectedRevisionField },
      ["target", "operation"], { minProperties: 3 }),
      readOnlyHint: false,
      untrustedContentHint: true,
      destructiveHint: true,
      validate: (input) => {
        if (input.operation !== "batch") {
          if (input.batch !== undefined) invalid("requires operation batch", "input.batch");
          if (input.confirm !== undefined) invalid("requires operation batch", "input.confirm");
          validateConstructiveOptions(input);
          return;
        }
        if (input.batch === undefined) invalid("is required", "input.batch");
        if (input.confirm !== true) invalid("requires explicit true confirmation", "input.confirm");
        for (const field of ["tool", "cutter", "mirror", "keepTool", "radius", "segments",
          "expectedRevision"]) {
          if (input[field] !== undefined) {
            invalid("is unavailable for a confirmed atomic scene batch", `input.${field}`);
          }
        }
      },
      handle: async (input, signal) => {
        if (input.operation !== "batch") return partAuthoring.boolean(input, signal);
        const encodedBytes = new TextEncoder().encode(input.batch).byteLength;
        if (encodedBytes > MAX_CONFIRMED_BATCH_BYTES) {
          invalid(`must not exceed ${MAX_CONFIRMED_BATCH_BYTES} UTF-8 bytes`, "input.batch");
        }
        let batch;
        try {
          batch = JSON.parse(input.batch);
        } catch {
          invalid("must contain one canonical JSON scene-batch object", "input.batch");
        }
        if (batch === null || typeof batch !== "object" || Array.isArray(batch)
            || JSON.stringify(batch) !== input.batch) {
          invalid("must contain one canonical JSON scene-batch object", "input.batch");
        }
        const sceneBatch = descriptors.find(({ name }) => name === "scene_apply_batch");
        validateStudioToolInput(batch, sceneBatch.inputSchema);
        const destructive = batch.operations.find(({ op }) =>
          op === "mesh_boolean" || op === "remove_entity");
        if (!destructive) {
          invalid("must contain an actual Boolean or entity-removal operation", "input.batch");
        }
        const target = destructive.op === "mesh_boolean"
          ? destructive.targetId : destructive.entityId;
        if (target !== input.target) {
          invalid("must match the first destructive scene operation target", "input.target");
        }
        return sceneBatch.execute(batch, signal === undefined ? undefined : { signal });
      },
    });
    add({ name: "part_curve",
      title: "Create genuine curved, swept, or lofted geometry",
      description: editableCurveAuthoring
        ? "Create or re-edit stable curve, sweep, and spline-loft controls; regenerate actual geometry, replay valid openings, and join genuine C0/G1 boundaries."
        : "Create editable curves, sweeps, or aligned linear and Catmull–Rom spline-sampled lofts; persistent spline control cages and guaranteed curvature continuity are unavailable.",
      inputSchema: closedObject({ name: text(128),
        ...curveGeometryFields, material: partTarget,
        uvMapping: uvMappingSchema,
        at: vector(3), attach: partPlacement,
        ...(editableCurveAuthoring ? { curveId: identifier(),
          edits: curveControlEdits, controlPoints: compactCurveControlEdits,
          bake: { type: "boolean" } } : {}),
        ...expectedRevisionField }, editableCurveAuthoring ? [] : ["name", "mode"],
      { oneOf: [
        { required: ["name", "mode", "path"], properties: {
          mode: { const: "curve" }, profile: false, profiles: false,
          alignProfiles: false, surface: false, curveId: false } },
        { required: ["name", "mode", "path", "profile"], properties: {
          mode: { const: "sweep" }, radius: false, segments: false,
          profiles: false, alignProfiles: false, surface: false, curveId: false } },
        { required: ["name", "mode", "profiles"], properties: {
          mode: { const: "loft" }, path: false, profile: false,
          radius: false, segments: false, curveId: false } },
        ...(editableCurveAuthoring ? [{ required: ["curveId"], properties: {
          name: false, mode: false, path: false, profile: false,
          profiles: false, radius: false, segments: false, closed: false,
          alignProfiles: false, material: false, at: false, attach: false,
          uvMapping: false } }] : []),
      ] }),
      readOnlyHint: false,
      untrustedContentHint: true,
      validate: (input) => {
        if (input.curveId === undefined) {
          if (input.name === undefined) invalid("is required", "input.name");
          if (input.mode === undefined) invalid("is required", "input.mode");
          for (const field of ["edits", "controlPoints", "bake"]) {
            if (input[field] !== undefined) invalid("requires curveId", `input.${field}`);
          }
          return;
        }
        for (const field of ["name", "mode", "path", "profile", "profiles", "radius",
          "segments", "closed", "alignProfiles", "material", "at", "attach",
          "uvMapping"]) {
          if (input[field] !== undefined) {
            invalid("cannot mix creation with durable source edits", `input.${field}`);
          }
        }
        if (input.edits !== undefined && input.controlPoints !== undefined) {
          invalid("cannot duplicate the same source edits", "input.controlPoints");
        }
        if (input.bake !== true && input.edits === undefined
          && input.controlPoints === undefined && input.surface === undefined) {
          invalid("requires actual curve edits or explicit baking", "input.curveId");
        }
        if (input.bake === true && (input.edits !== undefined
          || input.controlPoints !== undefined || input.surface !== undefined)) {
          invalid("cannot combine baking with source-control edits", "input.bake");
        }
      },
      handle: (input, signal) => {
        if (input.curveId === undefined) return partAuthoring.curve(input, signal);
        const direct = input.edits ?? input.controlPoints;
        const edits = input.surface === undefined ? direct
          : [...direct ?? [], { kind: "surface", action: "set", surface: input.surface }];
        return partAuthoring.curveEdit({ target: input.curveId,
          ...(edits === undefined ? {} : { edits }),
          ...(input.bake === undefined ? {} : { bake: input.bake }),
          ...(input.expectedRevision === undefined ? {} : {
            expectedRevision: input.expectedRevision }) }, signal);
      },
    });
  }

  return Object.freeze(descriptors);
}
