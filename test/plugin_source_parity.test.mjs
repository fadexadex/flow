import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The @tool EditorPlugin exists twice on purpose: once as real, readable GDScript under
// public/addons/webmcp/, and once embedded in public/mcp_bridge.js as the template injected
// into every authored project at boot. Silent divergence would ship an editor command
// channel that does not match the source anyone reads. Regenerate with:
//   python3 scripts/embed_plugin.py
const bridgeSource = fs.readFileSync(new URL('../public/mcp_bridge.js', import.meta.url), 'utf8');

function embeddedConstant(name) {
  const opening = `const ${name} = \``;
  const start = bridgeSource.indexOf(opening);
  assert.ok(start >= 0, `${name} is not embedded in public/mcp_bridge.js`);
  const bodyStart = start + opening.length;
  const bodyEnd = bridgeSource.indexOf('`;', bodyStart);
  assert.ok(bodyEnd > bodyStart, `${name} has no closing template literal`);
  return bridgeSource.slice(bodyStart, bodyEnd);
}

test('embedded plugin.gd matches public/addons/webmcp/plugin.gd byte for byte', () => {
  const onDisk = fs.readFileSync(new URL('../public/addons/webmcp/plugin.gd', import.meta.url), 'utf8');
  assert.equal(embeddedConstant('WEBMCP_PLUGIN_GD'), onDisk,
    'Run `python3 scripts/embed_plugin.py` to re-embed the plugin source.');
});

test('embedded plugin.cfg matches public/addons/webmcp/plugin.cfg byte for byte', () => {
  const onDisk = fs.readFileSync(new URL('../public/addons/webmcp/plugin.cfg', import.meta.url), 'utf8');
  assert.equal(embeddedConstant('WEBMCP_PLUGIN_CFG'), onDisk,
    'Run `python3 scripts/embed_plugin.py` to re-embed the plugin source.');
});

test('plugin source stays embeddable: no backticks, template holes, or backslashes', () => {
  for (const name of ['plugin.gd', 'plugin.cfg']) {
    const source = fs.readFileSync(new URL(`../public/addons/webmcp/${name}`, import.meta.url), 'utf8');
    assert.ok(!source.includes('`'), `${name} contains a backtick, which breaks the embedded template literal`);
    assert.ok(!source.includes('${'), `${name} contains a template hole`);
    assert.ok(!source.includes('\\'), `${name} contains a backslash, which would be re-escaped on embed`);
  }
});

test('every command-channel op the bridge calls is dispatched by the plugin', () => {
  const plugin = fs.readFileSync(new URL('../public/addons/webmcp/plugin.gd', import.meta.url), 'utf8');
  const dispatched = new Set([...plugin.matchAll(/^\t\t"([a-z_]+)": reply = _op_/gm)].map(match => match[1]));
  const called = new Set([
    ...[...bridgeSource.matchAll(/EditorCommandChannel\.call\('([a-z_]+)'/g)].map(match => match[1]),
    ...[...bridgeSource.matchAll(/op: '([a-z_]+)'/g)].map(match => match[1])
  ]);
  for (const op of called) {
    assert.ok(dispatched.has(op), `The bridge calls the '${op}' op but plugin.gd does not dispatch it.`);
  }
  assert.ok(called.size >= 8, `Expected the bridge to exercise the command channel; found ${called.size} ops.`);
});

// The addon only loads if project.godot actually enables it, and the projects it is injected
// into are agent-authored, so the patcher has to cope with a missing section, an existing
// empty one, and one that already lists other plugins — without ever duplicating our entry.
const patchSource = (() => {
  const start = bridgeSource.indexOf('function enableEditorPluginInProjectConfig');
  const end = bridgeSource.indexOf('function withEditorPlugin', start);
  assert.ok(start >= 0 && end > start, 'Could not slice enableEditorPluginInProjectConfig');
  return bridgeSource.slice(start, end);
})();
const enableEditorPluginInProjectConfig = new Function(
  `const WEBMCP_PLUGIN_RES = 'res://addons/webmcp/plugin.cfg';\n${patchSource}\nreturn enableEditorPluginInProjectConfig;`)();

const PLUGIN_RES = 'res://addons/webmcp/plugin.cfg';

test('project.godot with no [editor_plugins] section gains one', () => {
  const patched = enableEditorPluginInProjectConfig('config_version=5\n\n[application]\n\nrun/main_scene="res://main_3d.tscn"\n');
  assert.match(patched, /\[editor_plugins\]/);
  assert.ok(patched.includes(PLUGIN_RES));
});

test('an existing empty [editor_plugins] section gains the enabled key', () => {
  const patched = enableEditorPluginInProjectConfig('config_version=5\n\n[editor_plugins]\n');
  assert.equal((patched.match(/\[editor_plugins\]/g) || []).length, 1);
  assert.match(patched, /enabled=PackedStringArray\("res:\/\/addons\/webmcp\/plugin\.cfg"\)/);
});

test('an existing plugin list is preserved, not replaced', () => {
  const patched = enableEditorPluginInProjectConfig(
    'config_version=5\n\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/other/plugin.cfg")\n');
  assert.ok(patched.includes('res://addons/other/plugin.cfg'), 'the project\'s own plugin was dropped');
  assert.ok(patched.includes(PLUGIN_RES));
});

test('patching is idempotent across repeated editor restarts', () => {
  const once = enableEditorPluginInProjectConfig('config_version=5\n');
  const twice = enableEditorPluginInProjectConfig(once);
  assert.equal(once, twice);
  assert.equal((twice.match(/addons\/webmcp\/plugin\.cfg/g) || []).length, 1);
});
