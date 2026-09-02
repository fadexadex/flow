import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridgeSource = fs.readFileSync(new URL('../public/mcp_bridge.js', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const start = bridgeSource.indexOf(startMarker);
  const end = bridgeSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Could not slice ${startMarker} .. ${endMarker}`);
  return bridgeSource.slice(start, end);
}

const { normalizeTextResourceEscapedNewlines, normalizeProjectTextResources } = new Function(`
  ${slice('  function normalizeTextResourceEscapedNewlines', '  function validateProjectFiles')}
  return { normalizeTextResourceEscapedNewlines, normalizeProjectTextResources };
`)();

test('repairs literal escaped property separators outside quoted strings', () => {
  const source = `[sub_resource type="StandardMaterial3D" id="Mat_jade"]\nroughness = 0.2\\nemission_enabled = true\\nemission = Color(0, 1, 0, 1)\n`;
  const result = normalizeTextResourceEscapedNewlines(source);
  assert.equal(result.repairs, 2);
  assert.match(result.text, /roughness = 0\.2\nemission_enabled = true\nemission = Color/);
  assert.doesNotMatch(result.text, /\\nemission/);
});

test('preserves legitimate escaped newlines and assignments inside quoted values', () => {
  const source = `[node name="Help" type="Label"]\ntext = "Jump\\nscore = 10"\nmetadata = "\\nemission_enabled = documentation"\n`;
  const result = normalizeTextResourceEscapedNewlines(source);
  assert.equal(result.repairs, 0);
  assert.equal(result.text, source);
});

test('normalizes only Godot text resources and does not mutate the input dictionary', () => {
  const files = {
    'project.godot': '[application]\\nconfig/name="Demo"',
    'main.tscn': '[gd_scene]\\n[node name="Root" type="Node3D"]',
    'notes.txt': 'literal\\nproperty = keep',
    'icon.bin': new Uint8Array([1, 2, 3])
  };
  const result = normalizeProjectTextResources(files);
  assert.equal(result.repairs, 1);
  assert.equal(result.files['main.tscn'], '[gd_scene]\n[node name="Root" type="Node3D"]');
  assert.equal(result.files['notes.txt'], files['notes.txt']);
  assert.equal(files['main.tscn'], '[gd_scene]\\n[node name="Root" type="Node3D"]');
  assert.deepEqual(result.repairedPaths, ['main.tscn']);
});

test('the hydration and project-ingestion call sites use the normalizer', () => {
  assert.match(bridgeSource, /const hydrationNormalization = normalizeProjectTextResources\(cloneProjectFiles\(snapshot\.files \|\| \{\}\)\)/);
  assert.match(bridgeSource, /const stagedNormalization = normalizeProjectTextResources\(stagedFiles\)/);
  assert.match(bridgeSource, /const transactionNormalization = normalizeProjectTextResources\(stagedFiles\)/);
});
