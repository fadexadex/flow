import { StudioToolError, validateStudioToolInput } from "./tool-definitions.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export const PUBLIC_TOOL_PROTOCOL_VERSION = "oriel.studio-public-tools/1";
export const MAX_PUBLIC_TOOL_DECODED_BYTES = 64 * 1_024 * 1_024;
export const MAX_PUBLIC_TOOL_ENCODED_LENGTH =
  Math.ceil(MAX_PUBLIC_TOOL_DECODED_BYTES / 3) * 4;

export const PUBLIC_TOOL_ENVELOPE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  maxProperties: 3,
  properties: Object.freeze({
    tool: Object.freeze({ type: "string", minLength: 1, maxLength: 128,
      pattern: "^[A-Za-z0-9_.-]{1,128}$" }),
    encoding: Object.freeze({ type: "string", minLength: 1, maxLength: 6,
      enum: Object.freeze(["json", "base64"]) }),
    input: Object.freeze({ type: "string", minLength: 2,
      maxLength: MAX_PUBLIC_TOOL_ENCODED_LENGTH }),
  }),
  required: Object.freeze(["tool", "encoding", "input"]),
});

function invalidEnvelope(message) {
  throw new StudioToolError("INVALID_ARGUMENT", message);
}

function decodedLimit(value) {
  if (!Number.isSafeInteger(value) || value < 2
      || value > MAX_PUBLIC_TOOL_DECODED_BYTES) {
    throw new TypeError("The public-tool decoded byte limit is invalid.");
  }
  return value;
}

function enforceByteBudget(bytes, maximum) {
  if (bytes > maximum) {
    throw new StudioToolError("PAYLOAD_TOO_LARGE",
      "The modeling action exceeds its decoded input budget.");
  }
}

function encodeBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  if (typeof globalThis.btoa !== "function") {
    throw new StudioToolError("CAPABILITY_UNAVAILABLE",
      "Canonical base64 encoding is unavailable in this browser.");
  }
  return globalThis.btoa(binary);
}

function decodeBase64(value, maximum) {
  if (value.length % 4 !== 0 || !CANONICAL_BASE64.test(value)) {
    invalidEnvelope("The modeling action contains malformed base64 input.");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const length = value.length / 4 * 3 - padding;
  enforceByteBudget(length, maximum);
  if (typeof globalThis.atob !== "function") {
    throw new StudioToolError("CAPABILITY_UNAVAILABLE",
      "Canonical base64 decoding is unavailable in this browser.");
  }
  let binary;
  try {
    binary = globalThis.atob(value);
  } catch {
    invalidEnvelope("The modeling action contains malformed base64 input.");
  }
  // atob accepts non-zero padding bits. Re-encoding prevents alternate aliases.
  if (globalThis.btoa(binary) !== value) {
    invalidEnvelope("The modeling action requires canonical base64 input.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function assertSafeJson(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidEnvelope("The modeling action input must be one JSON object.");
  }
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    for (const key of Object.keys(current)) {
      if (DANGEROUS_KEYS.has(key)) {
        invalidEnvelope("The modeling action contains a forbidden object property.");
      }
      const selected = current[key];
      if (selected !== null && typeof selected === "object") pending.push(selected);
    }
  }
  return value;
}

/** Encode one existing logical operation for a registered effect-separated tool. */
export function encodePublicToolEnvelope(tool, input, {
  encoding = "json", maxDecodedBytes = MAX_PUBLIC_TOOL_DECODED_BYTES,
} = {}) {
  const maximum = decodedLimit(maxDecodedBytes);
  if (encoding !== "json" && encoding !== "base64") {
    invalidEnvelope("The modeling action uses an unsupported input encoding.");
  }
  let serialized;
  try {
    serialized = JSON.stringify(input);
  } catch {
    invalidEnvelope("The modeling action input must be JSON serializable.");
  }
  if (typeof serialized !== "string") {
    invalidEnvelope("The modeling action input must be one JSON object.");
  }
  const bytes = encoder.encode(serialized);
  enforceByteBudget(bytes.byteLength, maximum);
  const envelope = { tool, encoding,
    input: encoding === "json" ? serialized : encodeBase64(bytes) };
  validateStudioToolInput(envelope, PUBLIC_TOOL_ENVELOPE_SCHEMA);
  return envelope;
}

/** Decode and structurally harden an existing operation without changing its schema. */
export function decodePublicToolEnvelope(envelope, {
  maxDecodedBytes = MAX_PUBLIC_TOOL_DECODED_BYTES,
} = {}) {
  const maximum = decodedLimit(maxDecodedBytes);
  validateStudioToolInput(envelope, PUBLIC_TOOL_ENVELOPE_SCHEMA);
  let serialized;
  if (envelope.encoding === "json") {
    const bytes = encoder.encode(envelope.input);
    enforceByteBudget(bytes.byteLength, maximum);
    serialized = envelope.input;
  } else {
    const bytes = decodeBase64(envelope.input, maximum);
    try {
      serialized = decoder.decode(bytes);
    } catch {
      invalidEnvelope("The modeling action input must contain valid UTF-8.");
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    invalidEnvelope("The modeling action input must contain valid JSON.");
  }
  return assertSafeJson(parsed);
}
