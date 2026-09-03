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
import http from 'node:http';
import https from 'node:https';
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

async function resolveFetchable(rawUrl) {
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
    return { url, address: host, family: net.isIP(host) };
  }
  // Resolve. A hostname that answers with a private address is the whole attack.
  let addresses = [];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (_) {
    throw Object.assign(new Error(`Could not resolve ${url.hostname}`), { status: 400 });
  }
  if (addresses.length === 0) {
    throw Object.assign(new Error(`Could not resolve ${url.hostname}`), { status: 400 });
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) refuse(address);
  }
  // The request below is pinned to this exact checked address. Resolving once here and then
  // letting the HTTP client resolve the hostname again leaves a DNS-rebinding gap between the
  // check and the connection.
  return { url, address: addresses[0].address, family: addresses[0].family };
}

export async function assertFetchable(rawUrl) {
  return (await resolveFetchable(rawUrl)).url;
}

export async function readResponseBody(response, limit = MAX_ASSET_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const rawChunk of response) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.byteLength;
    if (total > limit) {
      response.destroy();
      throw Object.assign(new Error(`That asset exceeds the ${limit}-byte limit.`), { status: 413 });
    }
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

function requestPinned(target) {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const request = transport.request(target.url, {
      method: 'GET',
      headers: { Accept: '*/*', 'User-Agent': 'FLow-asset-import/1.0' },
      // Keep the original hostname for Host and TLS SNI, but connect only to the address that
      // resolveFetchable checked. Support both lookup callback shapes used by Node releases.
      lookup(_hostname, options, callback) {
        if (typeof options === 'function') {
          callback = options;
          options = {};
        }
        if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      }
    }, async (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location || null;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        finish(resolve, { redirect: location });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        finish(reject, Object.assign(new Error(`${target.url.href} returned HTTP ${status}`), { status: 502 }));
        return;
      }
      const declared = Number(response.headers['content-length'] || 0);
      if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
        response.destroy();
        finish(reject, Object.assign(new Error(`That asset is ${declared} bytes; the limit is ${MAX_ASSET_BYTES}.`), { status: 413 }));
        return;
      }
      try {
        const bytes = await readResponseBody(response);
        finish(resolve, {
          bytes,
          content_type: response.headers['content-type'] || 'application/octet-stream'
        });
      } catch (error) {
        finish(reject, error);
      }
    });
    const timer = setTimeout(() => {
      request.destroy(new Error(`Timed out fetching ${target.url.href} after ${TIMEOUT_MS} ms.`));
    }, TIMEOUT_MS);
    request.on('error', (error) => {
      finish(reject, Object.assign(new Error(`Could not fetch ${target.url.href}: ${error.message}`), { status: error.status || 502 }));
    });
    request.end();
  });
}

// Redirects are followed by hand: each hop goes back through assertFetchable, so a public URL
// that redirects to 169.254.169.254 is stopped at the hop that matters.
export async function fetchAsset(rawUrl) {
  let target = await resolveFetchable(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await requestPinned(target);
    if (response.redirect) {
      target = await resolveFetchable(new URL(response.redirect, target.url).href);
      continue;
    }
    return {
      bytes: response.bytes,
      url: target.url.href,
      extension: extensionOf(target.url.pathname),
      content_type: response.content_type
    };
  }
  throw Object.assign(new Error(`Too many redirects (limit ${MAX_REDIRECTS}).`), { status: 502 });
}
