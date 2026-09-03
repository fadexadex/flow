// One description of how this app must be served, for all three targets.
//
// It was three: netlify.toml, vercel.json and server.mjs each carried their own copy, and
// they had already drifted - Vercel never sent Access-Control-Allow-Methods or -Headers, and
// the Node server sent none of the cache-control or content-type rules at all, so local
// development was not serving what production serves. scripts/generate_deploy_config.mjs
// writes the two config files from this, server.mjs applies it directly, and a test fails if
// the generated files stop matching.

// COOP/COEP are not optional: the Godot Web build needs crossOriginIsolated for
// SharedArrayBuffer and threading. Without them the editor does not start.
export const GLOBAL_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

const IMMUTABLE = 'public, max-age=31536000, immutable';

// Ordered: the first match that applies wins in the Node server, and the order is preserved in
// the generated configs so the three behave the same way.
export const PATH_RULES = [
  // The engine payload is content-addressed by release and never edited in place.
  { match: { extension: '.wasm' }, headers: { 'Content-Type': 'application/wasm', 'Cache-Control': IMMUTABLE } },
  { match: { extension: '.pck' }, headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': IMMUTABLE } },
  // The page and the bridge change on every deploy, and a stale bridge against a new page is
  // the kind of failure that looks like a Godot bug for an hour.
  { match: { exact: '/' }, headers: { 'Cache-Control': 'no-store, max-age=0' } },
  { match: { exact: '/index.html' }, headers: { 'Cache-Control': 'no-store, max-age=0' } },
  { match: { extension: '.js' }, headers: { 'Cache-Control': 'no-cache, must-revalidate' } }
];

export const API_ROUTES = [
  { path: '/api/health', function: 'health' },
  { path: '/api/mcp/tools', function: 'tools' },
  { path: '/api/mcp/rpc', function: 'rpc' },
  { path: '/api/fetch-asset', function: 'fetch-asset' }
];

// Which rules apply to one request path, in declaration order.
export function headersForPath(pathname) {
  const headers = { ...GLOBAL_HEADERS };
  for (const rule of PATH_RULES) {
    const { exact, extension } = rule.match;
    const hit = exact ? pathname === exact : pathname.toLowerCase().endsWith(extension);
    if (hit) Object.assign(headers, rule.headers);
  }
  return headers;
}
