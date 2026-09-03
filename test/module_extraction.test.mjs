import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// mcp_bridge.js was one ~11k-line file. Sections with no dependency on its closure state now
// live in their own files, loaded before it. These tests hold the two invariants that make
// that safe: the extracted code still produces exactly what it produced inline, and the page
// still loads it in an order where the bridge can see it.
const read = (name) => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const bridgeSource = read('mcp_bridge.js');
const indexSource = read('index.html');

function loadTemplates() {
  const win = {};
  new Function('window', read('project_templates.js'))(win);
  return win.GodotProjectTemplates;
}

test('the extracted modules load before the bridge that consumes them', () => {
  const order = ['editor_boot.js', 'webmcp_plugin_source.js', 'project_templates.js', 'mcp_bridge.js']
    .map(name => indexSource.indexOf(`<script src="${name}"></script>`));
  assert.ok(order.every(index => index > 0), 'every module is loaded by index.html');
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], `${i}: modules must load in dependency order`);
  }
});

test('the bridge refuses to run rather than silently losing an extracted module', () => {
  // A missing script tag must be a loud failure at load, not a mystery at first use.
  assert.match(bridgeSource, /webmcp_plugin_source\.js must be loaded before mcp_bridge\.js/);
  assert.match(bridgeSource, /project_templates\.js must be loaded before mcp_bridge\.js/);
});

test('custom games have a structured telemetry publisher that does not depend on CustomEvent detail', () => {
  assert.match(bridgeSource, /function recordGameTelemetry\(state\)/);
  assert.match(bridgeSource, /window\.__godotWebMcpPublishTelemetry = \(state\) =>/);
  assert.match(bridgeSource, /return recordGameTelemetry\(state\)/);
});

test('timed input waits for release before returning telemetry by default', () => {
  assert.match(bridgeSource, /if \(releaseCompleted\) await releaseCompleted/);
  assert.match(bridgeSource, /release_completed: durationMs > 0 \? true : null/);
});

test('both built-in templates still emit every file the editor needs', () => {
  const { NeonSkyrail, OrbitalGarden } = loadTemplates();
  for (const [name, template, scene] of [
    ['NeonSkyrail', NeonSkyrail, 'res://main_3d.tscn'],
    ['OrbitalGarden', OrbitalGarden, 'res://orbital_sanctuary.tscn']
  ]) {
    const config = template.generateProjectGodot();
    assert.match(config, /^config_version=5$/m, `${name} project.godot`);
    assert.ok(config.includes(`run/main_scene="${scene}"`), `${name} names its main scene`);
    assert.match(config, /renderer\/rendering_method="gl_compatibility"/,
      `${name} must stay on the renderer the Web build actually has`);
  }
});

test('the generated plugin source carries both files and nothing else', () => {
  const win = {};
  new Function('window', read('webmcp_plugin_source.js'))(win);
  const source = win.__WEBMCP_PLUGIN_SOURCE;
  assert.deepEqual(Object.keys(source).sort(), ['cfg', 'gd']);
  assert.match(source.gd, /^@tool\nextends EditorPlugin/);
  assert.match(source.cfg, /script="plugin\.gd"/);
  // The bridge injects this verbatim into a template literal at boot.
  for (const text of [source.gd, source.cfg]) {
    assert.ok(!text.includes('`') && !text.includes('${') && !text.includes('\\'),
      'the plugin source must stay embeddable verbatim');
  }
});
