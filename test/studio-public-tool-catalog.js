import {
  STUDIO_TOOL_FAMILIES,
  StudioToolError,
  validateStudioToolInput,
} from "./tool-definitions.js";
import {
  MAX_PUBLIC_TOOL_DECODED_BYTES,
  PUBLIC_TOOL_ENVELOPE_SCHEMA,
  PUBLIC_TOOL_PROTOCOL_VERSION,
  decodePublicToolEnvelope,
} from "./studio-public-tool-protocol.js";

const encoder = new TextEncoder();
const PROFILE_HASH_PATTERN = "^sha256:[0-9a-f]{64}$";
const MAX_HELP_BYTES = 65_536;
const MAX_COMPACT_DIRECT_DESCRIPTION_LENGTH = 40;
const DESTRUCTIVE_DIRECT_TOOLS = new Set([
  "project_delete", "part_remove", "part_boolean",
]);
const DESTRUCTIVE_SCENE_OPERATIONS = new Set(["mesh_boolean", "remove_entity"]);
// This mixed-effect descriptor can contain destructive operations, so its
// original static annotations cannot truthfully authorize direct execution.
const DISPATCH_ONLY_TOOLS = new Set(["scene_apply_batch"]);
// Keep the most useful complete modeling loop directly invocable before using
// the remaining actual document budget to expose the largest safe inventory.
const PRIORITY_DIRECT_TOOL_NAMES = Object.freeze([
  "parts_add",
  "scene_get",
  "mesh_inspect",
  "mesh_extrude",
  "mesh_create",
  "part_feature",
  "part_curve",
  "mesh_transform",
]);
const DIRECT_FAMILY_PRIORITY = Object.freeze({
  modeling: 0,
  materials: 1,
  inspection: 2,
  scene: 3,
  export: 4,
  import: 5,
  references: 6,
  projects: 7,
  feedback: 8,
  guidance: 9,
});

const CAPABILITY_SEARCH_ALIASES = Object.freeze({
  scene_preflight_batch: Object.freeze([
    "dry run", "geometry budget", "validate batch", "preview atomic translation",
  ]),
  scene_apply_batch: Object.freeze([
    "move multiple parts", "paired transforms", "atomic scene edit",
    "batch translate entities", "paired eye placement",
  ]),
  mesh_apply_batch: Object.freeze(["atomic mesh edit", "mesh batch"]),
  mesh_create: Object.freeze([
    "high resolution sphere", "high resolution uv sphere", "widthSegments heightSegments",
    "64 segment sphere", "spherical editable geometry",
  ]),
  mesh_transform: Object.freeze([
    "translate mesh vertices", "move selected vertices", "direct mesh translation",
  ]),
  part_edit: Object.freeze([
    "move named part", "translate existing part", "reposition eyeball",
  ]),
  part_add: Object.freeze([
    "spherical uv mapping", "front facing spherical uv", "uv seam aware sphere",
  ]),
  parts_add: Object.freeze([
    "add multiple parts", "batch add parts", "atomic part assembly",
    "create multiple parts", "batch character blockout",
  ]),
  material_create: Object.freeze([
    "procedural surface markings", "flush facial markings", "texture eye patches",
    "paint spherical uv", "mirrored face markings",
  ]),
  render_contact_sheet: Object.freeze([
    "strict profile view", "front side back review", "contact geometry diagnostics",
    "eye socket clearance", "surface intersection review", "owner preserving viewpoints",
  ]),
  part_boolean: Object.freeze([
    "boolean eye sockets", "difference socket cutter", "mirrored recessed openings",
    "confirmed destructive batch",
  ]),
  camera_guide: Object.freeze([
    "restore hero viewport", "final three quarter camera", "transient owner camera",
  ]),
});

export const PUBLIC_DIRECT_TOOL_NAMES = Object.freeze([
  "readInstructionsForCodex",
  "status",
  "listDocs",
  "getDoc",
  "material_samples_list",
  "material_sample_inspect",
  "project_create",
  "project_open",
  "project_acquire",
  "project_delete",
  "scene_undo",
  "part_add",
  "part_remove",
  "part_boolean",
  "render_capture",
  "render_contact_sheet",
]);

export const PUBLIC_TOOL_NAMES = Object.freeze([
  ...PUBLIC_DIRECT_TOOL_NAMES,
  "capabilities_search",
  "capabilities_help",
  "action_read",
  "action_mutate",
]);

export const PUBLIC_TOOL_LIMITS = Object.freeze({
  maxTools: 100,
  maxPublicTools: 100,
  maxHostBytes: 65_536,
  maxDecodedBytes: MAX_PUBLIC_TOOL_DECODED_BYTES,
  maxHelpBytes: MAX_HELP_BYTES,
  maxSearchResults: 24,
});

const profileHashSchema = Object.freeze({ type: "string", minLength: 71,
  maxLength: 71, pattern: PROFILE_HASH_PATTERN });

export const PUBLIC_CAPABILITIES_SEARCH_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  maxProperties: 5,
  properties: Object.freeze({
    query: Object.freeze({ type: "string", maxLength: 256 }),
    family: Object.freeze({ type: "string", maxLength: 32 }),
    cursor: Object.freeze({ type: "integer", minimum: 0, maximum: 128 }),
    limit: Object.freeze({ type: "integer", minimum: 1,
      maximum: PUBLIC_TOOL_LIMITS.maxSearchResults }),
    expectedProfileHash: profileHashSchema,
  }),
});

export const PUBLIC_CAPABILITIES_HELP_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  maxProperties: 2,
  properties: Object.freeze({
    name: Object.freeze({ type: "string", minLength: 1, maxLength: 128,
      pattern: "^[A-Za-z0-9_.-]{1,128}$" }),
    expectedProfileHash: profileHashSchema,
  }),
  required: Object.freeze(["name"]),
});

const familiesByTool = new Map();
for (const [family, names] of Object.entries(STUDIO_TOOL_FAMILIES)) {
  for (const name of names) {
    const existing = familiesByTool.get(name) ?? [];
    existing.push(family);
    familiesByTool.set(name, existing);
  }
}

function budgetError({ actualBytes, maxBytes, actualTools, maxTools }) {
  const details = { actualBytes, maxBytes, actualTools, maxTools };
  const error = new StudioToolError("WEBMCP_CATALOG_BUDGET_EXCEEDED",
    "The public modeling tool catalog exceeds the browser host budget.", details);
  Object.assign(error, details);
  return error;
}

function locationDetails(origin, pageUrl) {
  if (typeof pageUrl !== "string" || pageUrl.length === 0) {
    throw new TypeError("The actual modeling document URL is required.");
  }
  if (origin === undefined || origin === null || origin === "") {
    try {
      origin = new URL(pageUrl).origin;
    } catch {
      throw new TypeError("The actual modeling document origin is invalid.");
    }
  }
  if (typeof origin !== "string" || origin.length === 0) {
    throw new TypeError("The actual modeling document origin is invalid.");
  }
  return { origin, pageUrl };
}

/** Match Codex's exact host-injected descriptor projection, including the URL. */
export function measurePublicToolCatalog(catalog, { origin, pageUrl } = {}) {
  const descriptors = Array.isArray(catalog) ? catalog : catalog?.tools;
  if (!Array.isArray(descriptors)) {
    throw new TypeError("Public modeling tool descriptors are required.");
  }
  const location = locationDetails(origin ?? catalog?.origin,
    pageUrl ?? catalog?.pageUrl);
  const projected = descriptors.map((tool) => ({
    name: tool.name,
    ...(tool.title == null ? {} : { title: tool.title }),
    ...(tool.description == null ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema ?? null,
    annotations: {
      readOnlyHint: tool.annotations?.readOnlyHint,
      untrustedContentHint: tool.annotations?.untrustedContentHint,
    },
    origin: location.origin,
    pageUrl: location.pageUrl,
  }));
  return { projected, hostBytes: encoder.encode(JSON.stringify(projected)).byteLength,
    ...location };
}

/** Reject an oversized host payload before any descriptor registration occurs. */
export function preflightPublicToolCatalog(catalog, {
  origin, pageUrl,
  maxHostBytes = PUBLIC_TOOL_LIMITS.maxHostBytes,
  maxTools = PUBLIC_TOOL_LIMITS.maxTools,
} = {}) {
  if (!Number.isSafeInteger(maxHostBytes) || maxHostBytes < 1
      || !Number.isSafeInteger(maxTools) || maxTools < 1) {
    throw new TypeError("The public modeling host budget is invalid.");
  }
  const descriptors = Array.isArray(catalog) ? catalog : catalog?.tools;
  const measured = measurePublicToolCatalog(catalog, { origin, pageUrl });
  if (descriptors.length > maxTools || measured.hostBytes > maxHostBytes) {
    throw budgetError({ actualBytes: measured.hostBytes, maxBytes: maxHostBytes,
      actualTools: descriptors.length, maxTools });
  }
  return measured;
}

function capabilityError(code, message) {
  return new StudioToolError(code, message);
}

function routeFor(descriptor, direct) {
  if (direct.has(descriptor.name)) return descriptor.name;
  if (descriptor.annotations?.destructiveHint === true
      || DESTRUCTIVE_DIRECT_TOOLS.has(descriptor.name)) {
    return undefined;
  }
  if (descriptor.annotations?.untrustedContentHint !== true) return undefined;
  if (descriptor.annotations?.readOnlyHint === true) return "action_read";
  if (descriptor.annotations?.readOnlyHint === false) return "action_mutate";
  return undefined;
}

function availableDescriptors(byName, isAvailable) {
  return [...byName.values()].filter((descriptor) => {
    if (typeof descriptor?.execute !== "function") return false;
    return isAvailable === undefined || isAvailable(descriptor) === true;
  }).sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function authoredFamilies(name) {
  return [...(familiesByTool.get(name) ?? [])];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function profileHash(descriptors, identity, crypto) {
  const subtle = crypto?.subtle ?? globalThis.crypto?.subtle;
  if (typeof subtle?.digest !== "function") {
    throw capabilityError("CAPABILITY_UNAVAILABLE",
      "The modeling capability profile cannot be verified.");
  }
  const profile = { identity: identity ?? null,
    operations: descriptors.map((descriptor) => ({ name: descriptor.name,
      title: descriptor.title ?? null,
      description: descriptor.description ?? null,
      inputSchema: descriptor.inputSchema ?? null,
      annotations: descriptor.annotations ?? null,
      families: authoredFamilies(descriptor.name),
      searchAliases: CAPABILITY_SEARCH_ALIASES[descriptor.name] ?? [] })) };
  const digest = new Uint8Array(await subtle.digest("SHA-256",
    encoder.encode(stableJson(profile))));
  return `sha256:${Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0")).join("")}`;
}

function capabilitySummary(descriptor, direct) {
  const route = routeFor(descriptor, direct);
  if (route === undefined) return undefined;
  return {
    name: descriptor.name,
    ...(descriptor.title == null ? {} : { title: descriptor.title }),
    ...(descriptor.description == null ? {} : { description: descriptor.description }),
    families: authoredFamilies(descriptor.name),
    readOnly: descriptor.annotations.readOnlyHint === true,
    destructive: descriptor.annotations.destructiveHint === true
      || DESTRUCTIVE_DIRECT_TOOLS.has(descriptor.name),
    registered: direct.has(descriptor.name),
    route,
  };
}

function authoredSearchMatches(descriptor, families, query, family) {
  if (family !== undefined && !families.includes(family)) return false;
  if (query === undefined || query.length === 0) return true;
  const search = query.toLocaleLowerCase("en");
  return [descriptor.name, descriptor.title, descriptor.description,
    ...families, ...Object.keys(descriptor.inputSchema?.properties ?? {}),
    ...(CAPABILITY_SEARCH_ALIASES[descriptor.name] ?? [])]
    .some((value) => typeof value === "string"
      && value.toLocaleLowerCase("en").includes(search));
}

function publicDescriptor({ name, title, description, inputSchema,
  readOnlyHint, untrustedContentHint, execute }) {
  return Object.freeze({ name, title, description, inputSchema,
    annotations: Object.freeze({ readOnlyHint, untrustedContentHint }), execute });
}

function directFamilyPriority(name) {
  const families = familiesByTool.get(name);
  if (!families || families.length === 0) return Number.MAX_SAFE_INTEGER;
  return Math.min(...families.map((family) =>
    DIRECT_FAMILY_PRIORITY[family] ?? Number.MAX_SAFE_INTEGER));
}

function compactDirectDescriptor(descriptor) {
  // Titles repeat information already present in concise tool names. Preserve
  // every original executable, effect annotation, and exact validation schema;
  // complete authored metadata remains available through capabilities_help.
  const { title: _title, description, ...compact } = descriptor;
  if (typeof description === "string") {
    let shortened = description.slice(0, MAX_COMPACT_DIRECT_DESCRIPTION_LENGTH);
    if (description.length > shortened.length) {
      const lastBoundary = shortened.lastIndexOf(" ");
      if (lastBoundary > MAX_COMPACT_DIRECT_DESCRIPTION_LENGTH / 2) {
        shortened = shortened.slice(0, lastBoundary);
      }
    }
    compact.description = shortened;
  }
  return Object.freeze(compact);
}

function compareDirectCandidates(left, right) {
  const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
  const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  if (left.hostBytes !== right.hostBytes) return left.hostBytes - right.hostBytes;
  if (left.familyPriority !== right.familyPriority) {
    return left.familyPriority - right.familyPriority;
  }
  return left.descriptor.name.localeCompare(right.descriptor.name, "en");
}

function selectedDirectCount(candidates, { hostBytes, toolCount,
  maxHostBytes, maxTools }) {
  let count = toolCount;
  let bytes = hostBytes;
  for (const candidate of candidates) {
    if (count >= maxTools) break;
    if (bytes + candidate.hostBytes > maxHostBytes) continue;
    count += 1;
    bytes += candidate.hostBytes;
  }
  return count;
}

function expandDirectTools(tools, privateByName, direct, location, {
  maxHostBytes, maxTools,
}) {
  // Preflight the entire indispensable profile before considering any optional
  // descriptor. An oversized baseline must never become a partial registration.
  let { hostBytes } = preflightPublicToolCatalog(tools, {
    ...location, maxHostBytes, maxTools,
  });
  const priority = new Map(PRIORITY_DIRECT_TOOL_NAMES.map((name, index) =>
    [name, index]));
  let candidates = [...privateByName.values()]
    .filter(({ name }) => !direct.has(name) && !DISPATCH_ONLY_TOOLS.has(name))
    .map((descriptor) => ({
      descriptor,
      // The existing nonempty JSON array replaces its closing bracket with a
      // comma, this exact projection, and another closing bracket.
      hostBytes: measurePublicToolCatalog([descriptor], location).hostBytes - 1,
      priority: priority.get(descriptor.name),
      familyPriority: directFamilyPriority(descriptor.name),
    }))
    .sort(compareDirectCandidates);

  const batch = candidates.find(({ descriptor }) => descriptor.name === "parts_add");
  if (batch && tools.length < maxTools
      && hostBytes + batch.hostBytes <= maxHostBytes
      && selectedDirectCount(candidates, { hostBytes, toolCount: tools.length,
        maxHostBytes, maxTools }) < selectedDirectCount(candidates.map((candidate) =>
        candidate === batch ? { ...candidate, priority: undefined } : candidate)
        .sort(compareDirectCandidates), { hostBytes, toolCount: tools.length,
          maxHostBytes, maxTools })) {
    const compact = tools.map(compactDirectDescriptor);
    tools.splice(0, tools.length, ...compact);
    ({ hostBytes } = preflightPublicToolCatalog(tools, {
      ...location, maxHostBytes, maxTools,
    }));
    candidates = candidates.map((candidate) => {
      const descriptor = compactDirectDescriptor(candidate.descriptor);
      return { ...candidate, descriptor,
        hostBytes: measurePublicToolCatalog([descriptor], location).hostBytes - 1 };
    });
  }

  for (const candidate of candidates) {
    if (tools.length >= maxTools) break;
    if (hostBytes + candidate.hostBytes > maxHostBytes) continue;
    tools.push(candidate.descriptor);
    direct.add(candidate.descriptor.name);
    hostBytes += candidate.hostBytes;
  }

  // Re-measure the complete host-equivalent array to protect the arithmetic
  // invariant and ensure every original schema, annotation, and URL is counted.
  return preflightPublicToolCatalog(tools, {
    ...location, maxHostBytes, maxTools,
  });
}

/** Freeze one actual-URL-budgeted profile while preserving every original operation. */
export function createPublicToolCatalog({
  toolDefinitions,
  origin,
  pageUrl,
  getLifecycleIdentity,
  isAvailable,
  crypto,
  maxHostBytes = PUBLIC_TOOL_LIMITS.maxHostBytes,
  maxTools = PUBLIC_TOOL_LIMITS.maxTools,
} = {}) {
  if (!Array.isArray(toolDefinitions) || toolDefinitions.length === 0) {
    throw new TypeError("The complete private modeling tool inventory is required.");
  }
  if (getLifecycleIdentity !== undefined && typeof getLifecycleIdentity !== "function") {
    throw new TypeError("The modeling lifecycle identity must be a callback.");
  }
  if (isAvailable !== undefined && typeof isAvailable !== "function") {
    throw new TypeError("Modeling capability availability must be a callback.");
  }
  const location = locationDetails(origin, pageUrl);
  const privateByName = new Map();
  for (const descriptor of toolDefinitions) {
    if (!descriptor || typeof descriptor.name !== "string"
        || typeof descriptor.execute !== "function") {
      throw new TypeError("Each private modeling tool needs its original handler.");
    }
    if (privateByName.has(descriptor.name)) {
      throw new TypeError("The private modeling tool inventory contains duplicate names.");
    }
    privateByName.set(descriptor.name, descriptor);
  }
  const direct = new Set(PUBLIC_DIRECT_TOOL_NAMES.filter((name) =>
    privateByName.has(name)));
  let cachedProfile;

  async function currentProfile() {
    const descriptors = availableDescriptors(privateByName, isAvailable);
    const identity = getLifecycleIdentity?.() ?? null;
    const identityKey = stableJson(identity);
    if (cachedProfile?.identityKey === identityKey
        && cachedProfile.descriptors.length === descriptors.length
        && cachedProfile.descriptors.every((descriptor, index) =>
          descriptor === descriptors[index])) {
      return { descriptors, profileHash: await cachedProfile.hash };
    }
    const hash = profileHash(descriptors, identity, crypto);
    cachedProfile = { identityKey, descriptors, hash };
    try {
      return { descriptors, profileHash: await hash };
    } catch (error) {
      if (cachedProfile?.hash === hash) cachedProfile = undefined;
      throw error;
    }
  }

  async function search(input = {}) {
    validateStudioToolInput(input, PUBLIC_CAPABILITIES_SEARCH_SCHEMA);
    const { descriptors, profileHash: currentHash } = await currentProfile();
    const cursor = input.cursor ?? 0;
    if (input.expectedProfileHash !== undefined
        && input.expectedProfileHash !== currentHash
        || cursor > 0 && input.expectedProfileHash !== currentHash) {
      throw capabilityError("STALE_CAPABILITY_PROFILE",
        "The modeling capability profile is no longer current.");
    }
    const summaries = descriptors.map((descriptor) => {
      const summary = capabilitySummary(descriptor, direct);
      return summary && authoredSearchMatches(descriptor, summary.families,
        input.query, input.family) ? summary : undefined;
    }).filter(Boolean);
    const limit = input.limit ?? PUBLIC_TOOL_LIMITS.maxSearchResults;
    const operations = summaries.slice(cursor, cursor + limit);
    const next = cursor + operations.length;
    return { operations, total: summaries.length,
      ...(next < summaries.length ? { nextCursor: next } : {}),
      profileHash: currentHash };
  }

  async function help(input = {}) {
    validateStudioToolInput(input, PUBLIC_CAPABILITIES_HELP_SCHEMA);
    const { descriptors, profileHash: currentHash } = await currentProfile();
    if (input.expectedProfileHash !== undefined
        && input.expectedProfileHash !== currentHash) {
      throw capabilityError("STALE_CAPABILITY_PROFILE",
        "The modeling capability profile is no longer current.");
    }
    const descriptor = descriptors.find(({ name }) => name === input.name);
    const summary = descriptor && capabilitySummary(descriptor, direct);
    if (!summary) {
      throw capabilityError("CAPABILITY_UNAVAILABLE",
        "The requested modeling capability is unavailable.");
    }
    const { readOnly: _readOnly, ...metadata } = summary;
    const result = { ...metadata, inputSchema: descriptor.inputSchema,
      annotations: { ...descriptor.annotations }, profileHash: currentHash };
    if (encoder.encode(JSON.stringify(result)).byteLength > MAX_HELP_BYTES) {
      throw capabilityError("CAPABILITY_HELP_TOO_LARGE",
        "The requested modeling capability help exceeds its result budget.");
    }
    return result;
  }

  async function dispatch(expectedReadOnly, envelope, invocationContext) {
    const input = decodePublicToolEnvelope(envelope);
    const descriptor = privateByName.get(envelope.tool);
    if (!descriptor || typeof descriptor.execute !== "function"
        || isAvailable !== undefined && isAvailable(descriptor) !== true) {
      throw capabilityError("CAPABILITY_UNAVAILABLE",
        "The requested modeling capability is unavailable.");
    }
    if (descriptor.annotations?.destructiveHint === true
        || DESTRUCTIVE_DIRECT_TOOLS.has(descriptor.name)) {
      throw capabilityError("CAPABILITY_DESTRUCTIVE",
        "Destructive modeling capabilities require their explicit registered tool.");
    }
    if (descriptor.annotations?.untrustedContentHint !== true
        || descriptor.annotations?.readOnlyHint !== expectedReadOnly) {
      throw capabilityError("CAPABILITY_EFFECT_MISMATCH",
        "The requested modeling capability does not match this invocation route.");
    }
    if (!expectedReadOnly && descriptor.name === "scene_apply_batch") {
      try {
        validateStudioToolInput(input, descriptor.inputSchema);
      } catch (error) {
        const field = error?.details?.field;
        const indexed = typeof field === "string"
          ? /^input\.operations\[(\d+)\]\.primitive\.segments$/u.exec(field) : null;
        const index = indexed === null ? -1 : Number(indexed[1]);
        const operation = index >= 0 && Array.isArray(input.operations)
          ? input.operations[index] : undefined;
        if (error?.code === "INVALID_ARGUMENT"
            && operation?.op === "mesh_create"
            && operation.primitive?.kind === "uvSphere") {
          error.details = { ...error.details, operationIndex: index,
            operation: "mesh_create",
            ...(typeof operation.entityId === "string"
              ? { entityId: operation.entityId } : {}),
            suggestedField: "widthSegments", minimum: 3, maximum: 128,
            repair: "Use primitive.widthSegments (3-128); heightSegments supports 2-128." };
        }
        throw error;
      }
      if (input.operations.some(({ op }) => DESTRUCTIVE_SCENE_OPERATIONS.has(op))) {
        throw capabilityError("CAPABILITY_DESTRUCTIVE",
          "Atomic scene batches containing mesh_boolean or remove_entity require the "
          + "explicit direct part_boolean operation:batch route with confirm:true.");
      }
    }
    // The original descriptor alone owns strict schema validation, observer events,
    // project fences, cancellation, undo, persistence, and the real transaction.
    return descriptor.execute(input, invocationContext);
  }

  const tools = PUBLIC_DIRECT_TOOL_NAMES.flatMap((name) => {
    const descriptor = privateByName.get(name);
    return descriptor ? [descriptor] : [];
  });
  tools.push(
    publicDescriptor({ name: "capabilities_search",
      title: "Search genuine modeling capabilities",
      description: "Search authored names, families, and bounded operation metadata; use a matching profile hash to continue a stable page.",
      inputSchema: PUBLIC_CAPABILITIES_SEARCH_SCHEMA,
      readOnlyHint: true, untrustedContentHint: false, execute: search }),
    publicDescriptor({ name: "capabilities_help",
      title: "Inspect one genuine modeling capability",
      description: "Return one existing authored operation's exact input schema, truthful effects, families, and genuinely registered invocation route.",
      inputSchema: PUBLIC_CAPABILITIES_HELP_SCHEMA,
      readOnlyHint: true, untrustedContentHint: false, execute: help }),
    publicDescriptor({ name: "action_read",
      title: "Invoke one existing read-only modeling capability",
      description: "Decode one bounded JSON or canonical base64 object and execute its exact existing untrusted read-only operation once.",
      inputSchema: PUBLIC_TOOL_ENVELOPE_SCHEMA,
      readOnlyHint: true, untrustedContentHint: true,
      execute: (input, context) => dispatch(true, input, context) }),
    publicDescriptor({ name: "action_mutate",
      title: "Invoke one existing non-destructive modeling capability",
      description: "Decode one bounded JSON or canonical base64 object and execute its exact existing non-destructive scene mutation once.",
      inputSchema: PUBLIC_TOOL_ENVELOPE_SCHEMA,
      readOnlyHint: false, untrustedContentHint: true,
      execute: (input, context) => dispatch(false, input, context) }),
  );
  const measured = expandDirectTools(tools, privateByName, direct, location, {
    maxHostBytes, maxTools,
  });
  return Object.freeze({ tools: Object.freeze(tools),
    byName: new Map(tools.map((tool) => [tool.name, tool])),
    hostBytes: measured.hostBytes,
    origin: location.origin,
    pageUrl: location.pageUrl,
    protocolVersion: PUBLIC_TOOL_PROTOCOL_VERSION });
}
