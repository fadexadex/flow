// Server-side asset fetch, shared by the Node server and the Netlify function.
//
// The page cannot fetch a third-party asset itself: it is served with
// Cross-Origin-Embedder-Policy: require-corp (the Godot build needs crossOriginIsolated for
// SharedArrayBuffer), so any cross-origin response without a Cross-Origin-Resource-Policy
// header is blocked before JavaScript sees it. Almost no CDN sends one. So the fetch happens
// here and the bytes are handed back with a CORP header the page can actually read.
//
// This is an SSRF surface and it is treated as one: a deployed copy of this app will happily
// be asked to fetch http://169.254.169.254/ by anyone who finds the endpoint. Every guard
// below exists for that, and redirects are followed by hand so each hop is re-checked rather
// than trusted because the first URL looked fine.

import dns from 'node:dns/promises';
import net from 'node:net';

export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15000;

// What Godot can actually do something with. An allowlist rather than a denylist: the point is
// to import assets, and "any content type at all" turns this into an open proxy.
export const ALLOWED_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.webp', '.svg', '.bmp',
  '.wav', '.ogg', '.mp3',
  '.glb', '.gltf', '.obj',
  '.ttf', '.otf', '.woff', '.woff2'
];

function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // Cloud metadata services live here, and they are the reason this function exists.
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;   // unique local
    if (lower.startsWith('fe80')) return true;                            // link local
    // An IPv4-mapped address has to be unwrapped and checked as IPv4, or 10.0.0.1 walks in
    // wearing a v6 hat. Both notations matter: URL normalises [::ffff:10.0.0.1] to
    // [::ffff:a00:1], so matching only the dotted form missed every real attempt.
    const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateAddress(dotted[1]);
    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return isPrivateAddress([high >> 8, high & 255, low >> 8, low & 255].join('.'));
    }
    // NAT64 embeds an arbitrary IPv4 address in the low 32 bits of 64:ff9b::/96.
    if (lower.startsWith('64:ff9b:')) return true;
    return false;
  }
  return true;
}

export function extensionOf(pathname) {
  const dot = pathname.lastIndexOf('.');
  return dot < 0 ? '' : pathname.slice(dot).toLowerCase();
}

export async function assertFetchable(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    throw Object.assign(new Error('That is not a URL.'), { status: 400 });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Object.assign(new Error(`Only http and https are fetched, not ${url.protocol}`), { status: 400 });
  }
  const extension = extensionOf(url.pathname);
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    throw Object.assign(new Error(
      `The URL must end in an asset extension Godot can import. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
    ), { status: 400 });
  }
  // URL.hostname keeps the brackets on an IPv6 literal, and dns.lookup cannot resolve those.
  // An IP literal is checked directly; only a name is resolved.
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const refuse = (address) => {
    throw Object.assign(new Error(
      `${url.hostname} resolves to a private or loopback address (${address}), which this endpoint will not fetch.`
    ), { status: 403 });
  };
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) refuse(host);
    return url;
  }
  // Resolve. A hostname that answers with a private address is the whole attack.
  let addresses = [];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch (_) {
    throw Object.assign(new Error(`Could not resolve ${url.hostname}`), { status: 400 });
  }
  if (addresses.length === 0) {
    throw Object.assign(new Error(`Could not resolve ${url.hostname}`), { status: 400 });
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) refuse(address);
  }
  return url;
}

// Redirects are followed by hand: each hop goes back through assertFetchable, so a public URL
// that redirects to 169.254.169.254 is stopped at the hop that matters.
export async function fetchAsset(rawUrl) {
  let target = await assertFetchable(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(target, { redirect: 'manual', signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      throw Object.assign(new Error(`Could not fetch ${target.href}: ${error.message}`), { status: 502 });
    }
    clearTimeout(timer);
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      target = await assertFetchable(new URL(response.headers.get('location'), target).href);
      continue;
    }
    if (!response.ok) {
      throw Object.assign(new Error(`${target.href} returned HTTP ${response.status}`), { status: 502 });
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_ASSET_BYTES) {
      throw Object.assign(new Error(`That asset is ${declared} bytes; the limit is ${MAX_ASSET_BYTES}.`), { status: 413 });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Checked again after reading: content-length is a claim, not a measurement.
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw Object.assign(new Error(`That asset is ${bytes.byteLength} bytes; the limit is ${MAX_ASSET_BYTES}.`), { status: 413 });
    }
    return {
      bytes,
      url: target.href,
      extension: extensionOf(target.pathname),
      content_type: response.headers.get('content-type') || 'application/octet-stream'
    };
  }
  throw Object.assign(new Error(`Too many redirects (limit ${MAX_REDIRECTS}).`), { status: 502 });
}
