import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { headersForPath, GLOBAL_HEADERS } from '../deploy/policy.mjs';
import { renderNetlifyToml, renderVercelJson } from '../scripts/generate_deploy_config.mjs';

// The three targets used to carry three hand-written copies of the same policy, and had
// already drifted. These tests fail if the checked-in files stop matching the one source.

test('netlify.toml is what the generator produces', () => {
  const onDisk = fs.readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.equal(onDisk, renderNetlifyToml(), 'run: node scripts/generate_deploy_config.mjs');
});

test('vercel.json is what the generator produces', () => {
  const onDisk = fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');
  assert.equal(onDisk, renderVercelJson(), 'run: node scripts/generate_deploy_config.mjs');
});

test('the Node server applies the shared policy rather than its own headers', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /headersForPath\(req\.path\)/);
  // No hand-set copies left to drift.
  assert.doesNotMatch(server, /setHeader\('Cross-Origin-Opener-Policy'/);
});

test('the isolation headers the Godot build needs are on every path', () => {
  for (const path of ['/', '/index.html', '/godot.editor.wasm', '/mcp_bridge.js', '/anything']) {
    const headers = headersForPath(path);
    // Without crossOriginIsolated there is no SharedArrayBuffer, and the editor does not start.
    assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin', path);
    assert.equal(headers['Cross-Origin-Embedder-Policy'], 'require-corp', path);
    for (const key of Object.keys(GLOBAL_HEADERS)) assert.ok(headers[key], `${key} missing for ${path}`);
  }
});

test('the page is never cached and the engine payload always is', () => {
  // A stale bridge against a fresh page reads as a Godot bug for an hour.
  assert.equal(headersForPath('/')['Cache-Control'], 'no-store, max-age=0');
  assert.equal(headersForPath('/index.html')['Cache-Control'], 'no-store, max-age=0');
  assert.equal(headersForPath('/mcp_bridge.js')['Cache-Control'], 'no-cache, must-revalidate');
  assert.equal(headersForPath('/godot.editor.wasm')['Cache-Control'], 'public, max-age=31536000, immutable');
  assert.equal(headersForPath('/godot.editor.wasm')['Content-Type'], 'application/wasm');
});
