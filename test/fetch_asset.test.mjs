import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertFetchable, extensionOf, ALLOWED_EXTENSIONS, MAX_ASSET_BYTES } from '../deploy/fetch_asset.mjs';

// A deployed copy of this app will be asked to fetch http://169.254.169.254/ by whoever finds
// the endpoint. These tests are the reason that request fails.

const refuses = async (url, pattern) => {
  await assert.rejects(() => assertFetchable(url), error => {
    assert.match(error.message, pattern, `for ${url}: ${error.message}`);
    assert.ok(error.status >= 400, 'a refusal must carry an HTTP status');
    return true;
  });
};

test('only http and https are fetched', async () => {
  await refuses('file:///etc/passwd', /Only http and https/);
  await refuses('ftp://example.com/a.png', /Only http and https/);
  await refuses('not a url at all', /not a URL/);
});

test('the URL must name an asset Godot can import', async () => {
  await refuses('https://example.com/', /asset extension/);
  await refuses('https://example.com/index.html', /asset extension/);
  // Not an open proxy: an allowlist, so "any content type" is never an option.
  await refuses('https://example.com/payload.exe', /asset extension/);
});

test('loopback, private and link-local addresses are refused', async () => {
  await refuses('http://127.0.0.1/a.png', /private or loopback/);
  await refuses('http://localhost/a.png', /private or loopback/);
  await refuses('http://10.0.0.5/a.png', /private or loopback/);
  await refuses('http://192.168.1.4/a.png', /private or loopback/);
  await refuses('http://172.16.9.9/a.png', /private or loopback/);
  // Cloud metadata. This is the one that matters most.
  await refuses('http://169.254.169.254/latest/meta-data/a.png', /private or loopback/);
  await refuses('http://[::1]/a.png', /private or loopback/);
});

test('extensions and limits are the ones the import tool enforces', () => {
  assert.equal(extensionOf('/path/to/model.GLB'), '.glb');
  assert.equal(extensionOf('/no-extension'), '');
  for (const required of ['.png', '.wav', '.glb', '.ttf']) {
    assert.ok(ALLOWED_EXTENSIONS.includes(required), `${required} should be importable`);
  }
  assert.equal(MAX_ASSET_BYTES, 5 * 1024 * 1024, 'must match the import tool limit');
});

test('redirects are re-checked rather than trusted', () => {
  const source = fs.readFileSync(new URL('../deploy/fetch_asset.mjs', import.meta.url), 'utf8');
  // redirect: 'manual' plus a re-check per hop, or a public URL that redirects to the
  // metadata service walks straight through.
  assert.match(source, /redirect: 'manual'/);
  assert.match(source, /target = await assertFetchable\(new URL\(response\.headers\.get\('location'\), target\)\.href\)/);
});

test('the proxy answers with a header the isolated page can actually read', () => {
  for (const file of ['../server.mjs', '../netlify/functions/fetch-asset.mjs']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /Cross-Origin-Resource-Policy/, `${file} must set CORP`);
    assert.match(source, /fetchAsset/, `${file} must use the shared guards`);
  }
});

test('an IP literal is checked directly, not handed to a resolver', async () => {
  // URL.hostname keeps the brackets on IPv6, and dns.lookup cannot resolve '[::1]'. Refusing
  // it with "could not resolve" was the right outcome for the wrong reason.
  await refuses('http://[::1]/a.png', /private or loopback/);
  await refuses('http://[fe80::1]/a.png', /private or loopback/);
  await refuses('http://[::ffff:10.0.0.1]/a.png', /private or loopback/);
  await refuses('http://[fd00::5]/a.png', /private or loopback/);
});

test('an IPv4-mapped v6 address is unwrapped in either notation', async () => {
  // URL normalises [::ffff:10.0.0.1] to [::ffff:a00:1]; matching only the dotted form let a
  // private IPv4 through wearing a v6 hat.
  await refuses('http://[::ffff:10.0.0.1]/a.png', /private or loopback/);
  await refuses('http://[::ffff:127.0.0.1]/a.png', /private or loopback/);
  await refuses('http://[::ffff:169.254.169.254]/a.png', /private or loopback/);
  await refuses('http://[64:ff9b::a00:1]/a.png', /private or loopback/);
  // A public address in the same notation is still fetchable.
  assert.ok(await assertFetchable('http://[::ffff:93.184.216.34]/a.png'));
});

test('a dropped file goes through the import tool, not around it', () => {
  const bridge = fs.readFileSync(new URL('../public/mcp_bridge.js', import.meta.url), 'utf8');
  const at = bridge.indexOf('function installAssetDropTarget');
  assert.ok(at > 0, 'the page should accept a dropped asset');
  const body = bridge.slice(at, at + 2600);
  // Same tool, so the same confirmation and the same refusals apply.
  assert.match(body, /MANIFEST_TOOLS\.find\(item => item\.definition\.name === 'godot_import_asset'\)/);
  // A drop that silently does nothing is worse than one that says why.
  assert.match(body, /AgentStatusRail\.setFocusNote\(`\$\{file\.name\}: \$\{error\.message \|\| error\}`\)/);
  assert.match(bridge, /const ASSET_DROP_FOLDERS = \{/);
});
