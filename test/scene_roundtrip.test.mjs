import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// "What the human sees is exactly what survives reload."
//
// The live path writes to the running editor AND to the in-memory .tscn that export,
// persistence, and reload all read back. Those were two implementations, and they drifted:
// a rotation applied in the editor never reached the saved text, and a recoloured node kept
// referencing its original material. These tests apply a mutation to scene text and then
// read it back through the same parser the app uses — the save/reload/inspect round trip.
const bridgeSource = fs.readFileSync(new URL('../public/mcp_bridge.js', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const start = bridgeSource.indexOf(startMarker);
  const end = bridgeSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Could not slice ${startMarker} .. ${endMarker}`);
  return bridgeSource.slice(start, end);
}

const api = new Function(`
  ${slice('function meshHalfExtents', '  // ==========================================\n  // 6B.')}
  ${slice('function projectWorldPoint', '  // ==========================================\n  // Real-Time 3D Live Scene Mutator')}
  ${slice('function parseColor', '  async function liveMutateSceneFile')}
  ${slice('const DEGREES_TO_RADIANS', '  // ==========================================\n  // 7. Fail-Closed')}
  return { sceneGraphFromFiles, findSceneNode, applyTransformToSceneText, applyMaterialToSceneText,
           basisFromEulerScale, decomposeBasis, formatTransform3D, readMaterialSubResource,
           findNodeBlock, enumerateNodeBlocks, materialReferenceCount, materialSlotOf,
           verifyTransformInSource, verifyMaterialInSource, verifyNodePresence,
           materialUpdateFromCommandReply, parseColor, mergeMaterialProperties };
`)();

const {
  sceneGraphFromFiles, findSceneNode, applyTransformToSceneText,
  applyMaterialToSceneText, basisFromEulerScale, decomposeBasis, readMaterialSubResource,
  findNodeBlock, enumerateNodeBlocks, materialReferenceCount, materialSlotOf,
  verifyTransformInSource, verifyMaterialInSource, verifyNodePresence,
  materialUpdateFromCommandReply, parseColor
} = api;

const SCENE = `[gd_scene load_steps=3 format=3]

[sub_resource type="StandardMaterial3D" id="SingularityMaterial"]
albedo_color = Color(0.1, 0.1, 0.1, 1)
emission_enabled = true
emission = Color(0.2, 0.9, 1, 1)
emission_energy_multiplier = 3.0

[sub_resource type="BoxMesh" id="Mesh_Prism"]
size = Vector3(1, 1, 1)

[node name="Main3D" type="Node3D"]

[node name="Singularity" type="MeshInstance3D" parent="."]
transform = Transform3D(2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 4, 0)
mesh = SubResource("Mesh_Prism")
surface_material_override/0 = SubResource("SingularityMaterial")

[node name="OrbitPrismA" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3, 1, 0)
mesh = SubResource("Mesh_Prism")

[node name="PlainNode" type="MeshInstance3D" parent="."]
mesh = SubResource("Mesh_Prism")
`;

const reload = (source) => sceneGraphFromFiles({ 'main_3d.tscn': source });
const nodeIn = (source, name) => findSceneNode({ 'main_3d.tscn': source }, name);
const transformOf = (source, name) => {
  const block = source.slice(source.indexOf(`[node name="${name}"`));
  const match = block.match(/transform = Transform3D\(([^)]*)\)/);
  return match ? match[1].split(',').map(v => Number(v.trim())) : null;
};

// ---------------------------------------------------------------- transforms

test('a rotation-only edit survives the round trip', () => {
  // Reported: the command channel rotated OrbitPrismA to (0, 47, 18) inside Godot, but the
  // saved .tscn still held its original identity transform, because the text path only
  // rewrote the transform when a position was supplied.
  const updated = applyTransformToSceneText(SCENE, 'OrbitPrismA', { rotation: [0, 47, 18] });
  const values = transformOf(updated, 'OrbitPrismA');
  assert.ok(values, 'no transform was written at all');
  const expected = basisFromEulerScale([0, 47, 18], [1, 1, 1]);
  for (let i = 0; i < 9; i += 1) {
    assert.ok(Math.abs(values[i] - expected[i]) < 1e-5, `basis component ${i}: ${values[i]} vs ${expected[i]}`);
  }
  // The position must be preserved, not reset.
  assert.deepEqual(values.slice(9), [3, 1, 0]);
  assert.deepEqual(nodeIn(updated, 'OrbitPrismA').world_position, [3, 1, 0]);
});

test('a position-only edit preserves existing scale instead of flattening it to 1', () => {
  // Singularity is uniformly scaled 2x. Moving it must not silently shrink it.
  const updated = applyTransformToSceneText(SCENE, 'Singularity', { position: [1, 2, 3] });
  const values = transformOf(updated, 'Singularity');
  assert.deepEqual(values.slice(9), [1, 2, 3]);
  const { scale } = decomposeBasis(values.slice(0, 9));
  for (const axis of scale) assert.ok(Math.abs(axis - 2) < 1e-6, `scale became ${axis}, expected 2`);
});

test('a position-only edit preserves an existing rotation', () => {
  const rotated = applyTransformToSceneText(SCENE, 'OrbitPrismA', { rotation: [0, 47, 18] });
  const moved = applyTransformToSceneText(rotated, 'OrbitPrismA', { position: [9, 9, 9] });
  const before = transformOf(rotated, 'OrbitPrismA').slice(0, 9);
  const after = transformOf(moved, 'OrbitPrismA').slice(0, 9);
  for (let i = 0; i < 9; i += 1) {
    assert.ok(Math.abs(before[i] - after[i]) < 1e-5, `rotation lost on axis ${i}`);
  }
  assert.deepEqual(transformOf(moved, 'OrbitPrismA').slice(9), [9, 9, 9]);
});

test('relative transforms accumulate rather than overwrite', () => {
  const once = applyTransformToSceneText(SCENE, 'OrbitPrismA', { position: [1, 0, 0], relative: true });
  const twice = applyTransformToSceneText(once, 'OrbitPrismA', { position: [1, 0, 0], relative: true });
  assert.deepEqual(transformOf(twice, 'OrbitPrismA').slice(9), [5, 1, 0]);

  const scaled = applyTransformToSceneText(SCENE, 'Singularity', { scale: [2, 2, 2], relative: true });
  const { scale } = decomposeBasis(transformOf(scaled, 'Singularity').slice(0, 9));
  for (const axis of scale) assert.ok(Math.abs(axis - 4) < 1e-6, `relative scale gave ${axis}, expected 4`);
});

test("the editor's own serialized transform wins over the locally computed one", () => {
  // When the command channel applies the change, Godot reports the exact twelve floats it
  // holds. Writing anything else back is how the editor and the file diverge.
  const authoritative = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 7, 8, 9];
  const updated = applyTransformToSceneText(SCENE, 'OrbitPrismA', { position: [0, 0, 0], authoritative });
  assert.deepEqual(transformOf(updated, 'OrbitPrismA'), authoritative);
});

test('a node stored as position = Vector3(...) is upgraded to a full transform exactly once', () => {
  const positional = SCENE.replace(
    '[node name="PlainNode" type="MeshInstance3D" parent="."]\nmesh',
    '[node name="PlainNode" type="MeshInstance3D" parent="."]\nposition = Vector3(1, 2, 3)\nmesh');
  const updated = applyTransformToSceneText(positional, 'PlainNode', { rotation: [0, 90, 0] });
  const block = updated.slice(updated.indexOf('[node name="PlainNode"'));
  assert.ok(!/^position = Vector3/m.test(block), 'the stale position line must be removed so the two cannot disagree');
  assert.deepEqual(transformOf(updated, 'PlainNode').slice(9), [1, 2, 3]);
});

// ---------------------------------------------------------------- materials

test('recolouring mutates the material the node actually references', () => {
  // Reported: the handler minted a new Mat_<node> sub-resource but never repointed the node,
  // so the node kept using SingularityMaterial and the change vanished on reload.
  const updated = applyMaterialToSceneText(SCENE, 'Singularity', { albedo_color: '#ffcc00' });
  const block = updated.slice(updated.indexOf('[node name="Singularity"'));
  assert.match(block, /surface_material_override\/0 = SubResource\("SingularityMaterial"\)/);
  assert.ok(!updated.includes('id="Mat_Singularity"'), 'an orphan material was created instead of mutating the referenced one');

  const material = readMaterialSubResource(updated, 'SingularityMaterial');
  assert.match(material.properties.albedo_color, /^Color\(1\.000, 0\.800, 0\.000/);
});

test('recolouring preserves material properties it was not asked to change', () => {
  const updated = applyMaterialToSceneText(SCENE, 'Singularity', { albedo_color: '#ffcc00' });
  const material = readMaterialSubResource(updated, 'SingularityMaterial');
  assert.equal(material.properties.emission_enabled, 'true');
  assert.equal(material.properties.emission_energy_multiplier, '3.0');
  assert.match(material.properties.emission, /^Color\(0\.2, 0\.9, 1, 1\)/);
});

test('a node with no material override gets one created AND wired up', () => {
  const updated = applyMaterialToSceneText(SCENE, 'OrbitPrismA', { albedo_color: '#3366ff', emission: '#3366ff' });
  const block = updated.slice(updated.indexOf('[node name="OrbitPrismA"'), updated.indexOf('[node name="PlainNode"'));
  assert.match(block, /surface_material_override\/0 = SubResource\("Mat_OrbitPrismA"\)/);
  const material = readMaterialSubResource(updated, 'Mat_OrbitPrismA');
  assert.ok(material, 'the new material sub-resource was not written');
  assert.equal(material.properties.emission_enabled, 'true');
});

test('repeated recolours stay idempotent in shape: one material, one reference', () => {
  let source = SCENE;
  for (const colour of ['#ff0000', '#00ff00', '#0000ff']) {
    source = applyMaterialToSceneText(source, 'OrbitPrismA', { albedo_color: colour });
  }
  assert.equal((source.match(/id="Mat_OrbitPrismA"/g) || []).length, 1);
  assert.equal((source.match(/surface_material_override\/0 = SubResource\("Mat_OrbitPrismA"\)/g) || []).length, 1);
  const material = readMaterialSubResource(source, 'Mat_OrbitPrismA');
  assert.match(material.properties.albedo_color, /^Color\(0\.000, 0\.000, 1\.000/);
});

test('the scene still parses after a full mutation sequence, and keeps every node', () => {
  let source = SCENE;
  source = applyMaterialToSceneText(source, 'Singularity', { albedo_color: '#ffcc00' });
  source = applyTransformToSceneText(source, 'OrbitPrismA', { rotation: [0, 47, 18] });
  source = applyTransformToSceneText(source, 'Singularity', { position: [0, 6, 0] });
  const graph = reload(source);
  assert.deepEqual(
    graph.nodes.map(node => node.name).sort(),
    ['Main3D', 'OrbitPrismA', 'PlainNode', 'Singularity']);
  assert.deepEqual(nodeIn(source, 'Singularity').world_position, [0, 6, 0]);
});

// ---------------------------------------------------------------- engine fixture

test('the local Euler composition matches what Godot itself serialized', () => {
  // Captured from a live Godot 4.7.2 editor: godot_node_spawn with scale [1.5, 1.5, 1.5]
  // followed by godot_node_transform with rotation [0, 47, 18] produced exactly this basis in
  // main_3d.tscn. When the editor plugin is present its transform is written back verbatim,
  // but without the plugin this local composition is what lands in the file — so it has to
  // agree with the engine, including Godot's default YXZ Euler order.
  const godot = [0.972929, 0.463526, -1.043338, -0.316124, 1.426585, 0.339001, 1.097031, 0, 1.022998];
  const local = basisFromEulerScale([0, 47, 18], [1.5, 1.5, 1.5]);
  for (let i = 0; i < 9; i += 1) {
    assert.ok(Math.abs(local[i] - godot[i]) < 1e-5,
      `basis[${i}]: local ${local[i]} vs Godot ${godot[i]} — Euler order or column layout drifted from the engine`);
  }
  // Uniform scale must come back out of the basis unchanged.
  for (const axis of decomposeBasis(local).scale) {
    assert.ok(Math.abs(axis - 1.5) < 1e-6, `scale round trip gave ${axis}`);
  }
});

// ---------------------------------------------------------------- duplicate leaf names
//
// A .tscn may legitimately hold several nodes with the same leaf name under different
// parents. The live command channel resolved BranchB/TwinOrb correctly while the text path
// stripped the path to "TwinOrb" and edited the FIRST match — BranchA/TwinOrb — so a reload
// swapped which object had moved. These pin the resolution rule: exact path wins; a bare leaf
// is accepted only when unique; ambiguity refuses rather than guessing.

const TWIN_SCENE = `[gd_scene load_steps=2 format=3]

[sub_resource type="StandardMaterial3D" id="SharedCometMat"]
albedo_color = Color(1, 0.2, 0.6, 1)
metallic = 0.4

[sub_resource type="SphereMesh" id="Mesh_Orb"]
radius = 0.5

[node name="Arena" type="Node3D"]

[node name="BranchA" type="Node3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -2, 0, 0)

[node name="TwinOrb" type="MeshInstance3D" parent="BranchA"]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0)
mesh = SubResource("Mesh_Orb")
surface_material_override/0 = SubResource("SharedCometMat")

[node name="BranchB" type="Node3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, 0)

[node name="TwinOrb" type="MeshInstance3D" parent="BranchB"]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0)
mesh = SubResource("Mesh_Orb")
surface_material_override/0 = SubResource("SharedCometMat")

[node name="Core" type="MeshInstance3D" parent="."]
mesh = SubResource("Mesh_Orb")

[connection signal="ready" from="." to="." method="_on_ready"]
`;

const twinTransform = (source, path) => {
  const block = findNodeBlock(source, path);
  const match = block && block.text.match(/transform = Transform3D\(([^)]*)\)/);
  return match ? match[1].split(',').map(v => Number(v.trim())) : null;
};

test('node blocks are enumerated with their real scene-relative paths', () => {
  const paths = enumerateNodeBlocks(TWIN_SCENE).map(block => block.nodePath);
  assert.deepEqual(paths, ['.', 'BranchA', 'BranchA/TwinOrb', 'BranchB', 'BranchB/TwinOrb', 'Core']);
});

test('a trailing [connection] section is not swallowed into the last node block', () => {
  const core = findNodeBlock(TWIN_SCENE, 'Core');
  assert.ok(!core.text.includes('[connection'), 'the last node block absorbed the connection section');
});

test('an exact path selects the right one of two same-named siblings', () => {
  assert.equal(findNodeBlock(TWIN_SCENE, 'BranchB/TwinOrb').nodePath, 'BranchB/TwinOrb');
  assert.equal(findNodeBlock(TWIN_SCENE, 'BranchA/TwinOrb').nodePath, 'BranchA/TwinOrb');
});

test('editing BranchB/TwinOrb moves ONLY BranchB/TwinOrb', () => {
  // The reported failure: the transform landed on BranchA and a reload reversed which object
  // had moved.
  const updated = applyTransformToSceneText(TWIN_SCENE, 'BranchB/TwinOrb', { position: [1.8, 2.4, -1.0] });
  assert.deepEqual(twinTransform(updated, 'BranchB/TwinOrb').slice(9), [1.8, 2.4, -1]);
  assert.deepEqual(twinTransform(updated, 'BranchA/TwinOrb').slice(9), [0, 1, 0], 'BranchA was modified instead of, or as well as, BranchB');
});

test('a bare ambiguous leaf name refuses instead of silently picking the first', () => {
  assert.throws(() => findNodeBlock(TWIN_SCENE, 'TwinOrb'), (error) => {
    assert.equal(error.code, 'AMBIGUOUS_NODE_PATH');
    assert.match(error.message, /BranchA\/TwinOrb/);
    assert.match(error.message, /BranchB\/TwinOrb/);
    return true;
  });
  assert.throws(() => applyTransformToSceneText(TWIN_SCENE, 'TwinOrb', { position: [9, 9, 9] }),
    /ambiguous/i, 'an ambiguous transform must refuse, not guess');
});

test('an unambiguous bare leaf name still resolves', () => {
  assert.equal(findNodeBlock(TWIN_SCENE, 'Core').nodePath, 'Core');
  assert.equal(findSceneNode({ 'a.tscn': TWIN_SCENE }, 'Core').node_path, 'Core');
});

test('findSceneNode does not resolve an ambiguous leaf to an arbitrary node', () => {
  assert.equal(findSceneNode({ 'a.tscn': TWIN_SCENE }, 'TwinOrb'), null);
  assert.equal(findSceneNode({ 'a.tscn': TWIN_SCENE }, 'BranchB/TwinOrb').node_path, 'BranchB/TwinOrb');
});

// ---------------------------------------------------------------- shared materials
//
// Both comets referenced one SharedCometMat. Recolouring one mutated the shared resource, so
// after reload BOTH comets changed. Godot's own editor copy-on-writes here; the serialized
// scene has to as well.

test('recolouring one node that shares a material does not repaint the other', () => {
  assert.equal(materialReferenceCount(TWIN_SCENE, 'SharedCometMat'), 2);
  const updated = applyMaterialToSceneText(TWIN_SCENE, 'BranchB/TwinOrb', { albedo_color: '#00ff66' });

  const b = materialSlotOf(findNodeBlock(updated, 'BranchB/TwinOrb').text);
  const a = materialSlotOf(findNodeBlock(updated, 'BranchA/TwinOrb').text);
  assert.notEqual(b.id, a.id, 'both nodes still share one material, so both would change colour');
  assert.equal(a.id, 'SharedCometMat', 'the untouched node must keep referencing the original material');

  // The untouched node's material is byte-identical to before.
  assert.equal(readMaterialSubResource(updated, 'SharedCometMat').properties.albedo_color, 'Color(1, 0.2, 0.6, 1)');
  assert.match(readMaterialSubResource(updated, b.id).properties.albedo_color, /^Color\(0\.000, 1\.000, 0\.400/);
});

test('a forked material inherits the shared values it was not asked to change', () => {
  const updated = applyMaterialToSceneText(TWIN_SCENE, 'BranchB/TwinOrb', { albedo_color: '#00ff66' });
  const forked = readMaterialSubResource(updated, materialSlotOf(findNodeBlock(updated, 'BranchB/TwinOrb').text).id);
  assert.equal(forked.properties.metallic, '0.4', 'metallic from the shared material was lost in the fork');
});

test('an unshared material is still mutated in place rather than forked each time', () => {
  let source = applyMaterialToSceneText(TWIN_SCENE, 'Core', { albedo_color: '#ff0000' });
  const firstId = materialSlotOf(findNodeBlock(source, 'Core').text).id;
  source = applyMaterialToSceneText(source, 'Core', { albedo_color: '#0000ff' });
  const secondId = materialSlotOf(findNodeBlock(source, 'Core').text).id;
  assert.equal(firstId, secondId, 'a private material must not fork on every edit');
  assert.equal(sceneGraphFromFiles({ 'a.tscn': source }).nodes.length, 6);
});

test('the scene still parses, and keeps both twins, after the fork', () => {
  const updated = applyMaterialToSceneText(TWIN_SCENE, 'BranchB/TwinOrb', { albedo_color: '#00ff66' });
  const paths = sceneGraphFromFiles({ 'a.tscn': updated }).nodes.map(node => node.node_path);
  assert.deepEqual(paths, ['.', 'BranchA', 'BranchA/TwinOrb', 'BranchB', 'BranchB/TwinOrb', 'Core']);
});

// ---------------------------------------------------------------- source_synced is measured

test('source_synced reports false when the written transform does not match the editor', () => {
  const editorHolds = [1, 0, 0, 0, 1, 0, 0, 0, 1, 1.8, 2.4, -1];
  const wrongNode = applyTransformToSceneText(TWIN_SCENE, 'BranchA/TwinOrb', { position: [1.8, 2.4, -1] });
  // The editor moved BranchB; the text moved BranchA. That must NOT report as synced.
  const bad = verifyTransformInSource(wrongNode, 'BranchB/TwinOrb', editorHolds);
  assert.equal(bad.synced, false);
  assert.match(bad.mismatch, /differs/);

  const right = applyTransformToSceneText(TWIN_SCENE, 'BranchB/TwinOrb', { position: [1.8, 2.4, -1] });
  assert.equal(verifyTransformInSource(right, 'BranchB/TwinOrb', editorHolds).synced, true);
});

test('source_synced is null, not true, when there is nothing authoritative to compare', () => {
  const result = verifyTransformInSource(TWIN_SCENE, 'Core', undefined);
  assert.equal(result.synced, null, 'unverifiable must never be reported as verified');
  assert.match(result.reason, /no_authoritative_transform/);
});

test('source_synced reports false while a material is still shared', () => {
  // Simulates the pre-fix behaviour: mutate the shared resource in place, leave both nodes on it.
  const naive = TWIN_SCENE.replace('albedo_color = Color(1, 0.2, 0.6, 1)', 'albedo_color = Color(0.000, 1.000, 0.400, 1.000)');
  const result = verifyMaterialInSource(naive, 'BranchB/TwinOrb', { albedo_color: '#00ff66' });
  assert.equal(result.synced, false);
  assert.match(result.mismatch, /still shared by 2 nodes/);

  const forked = applyMaterialToSceneText(TWIN_SCENE, 'BranchB/TwinOrb', { albedo_color: '#00ff66' });
  assert.equal(verifyMaterialInSource(forked, 'BranchB/TwinOrb', { albedo_color: '#00ff66' }).synced, true);
});

test('node presence verification catches a delete that did not happen', () => {
  assert.equal(verifyNodePresence(TWIN_SCENE, 'Core', false).synced, false);
  assert.equal(verifyNodePresence(TWIN_SCENE, 'Core', true).synced, true);
  assert.equal(verifyNodePresence(TWIN_SCENE, 'Nope', true).synced, false);
});

// ---------------------------------------------------------------- full material verification
//
// verifyMaterialInSource used to check only albedo and sharing, so a metallic-only edit that
// failed to serialize still reported source_synced: true.

test('a requested property that did not reach the file is reported as a mismatch', () => {
  const applied = applyMaterialToSceneText(TWIN_SCENE, 'Core', { albedo_color: '#ff0000', metallic: 0.9 });
  assert.equal(verifyMaterialInSource(applied, 'Core', { albedo_color: '#ff0000', metallic: 0.9 }).synced, true);

  // Same file, but pretend metallic 0.1 was requested: verification must catch it.
  const wrong = verifyMaterialInSource(applied, 'Core', { albedo_color: '#ff0000', metallic: 0.1 });
  assert.equal(wrong.synced, false, 'a metallic mismatch was reported as synced');
  assert.match(wrong.mismatch, /metallic/);
});

test('every supported property is verified, not just albedo', () => {
  const request = { albedo_color: '#112233', metallic: 0.25, roughness: 0.75, emission: '#445566', emission_energy: 2.5 };
  const applied = applyMaterialToSceneText(TWIN_SCENE, 'Core', request);
  assert.equal(verifyMaterialInSource(applied, 'Core', request).synced, true);

  for (const [key, bad] of [['roughness', 0.1], ['emission_energy', 9], ['emission', '#000000']]) {
    const result = verifyMaterialInSource(applied, 'Core', { ...request, [key]: bad });
    assert.equal(result.synced, false, `a wrong ${key} was reported as synced`);
  }
});

test('requesting emission requires emission_enabled in the written material', () => {
  const applied = applyMaterialToSceneText(TWIN_SCENE, 'Core', { emission: '#00ff00' });
  const material = readMaterialSubResource(applied, materialSlotOf(findNodeBlock(applied, 'Core').text).id);
  assert.equal(material.properties.emission_enabled, 'true');
  assert.equal(verifyMaterialInSource(applied, 'Core', { emission: '#00ff00' }).synced, true);
});

// ---------------------------------------------------------------- authoritative material

test("Godot's bare-hex colours round-trip, so its resolved material can be serialized", () => {
  // Color.to_html() has no leading '#'. Without accepting that, the editor's own reported
  // material could not be written back and materials stayed request-derived.
  assert.equal(parseColor('ffcc00ff'), parseColor('#ffcc00ff'));
  assert.match(parseColor('00ff66'), /^Color\(0\.000, 1\.000, 0\.400/);
});

test('a command reply with resolved values becomes the material update', () => {
  const update = materialUpdateFromCommandReply({
    material: { albedo_color: 'ffcc00ff', metallic: 0.8, roughness: 0.2, emission_enabled: true, emission: '0080e6', emission_energy: 0.4 }
  });
  assert.equal(update.albedo_color, 'ffcc00ff');
  assert.equal(update.metallic, 0.8);
  assert.equal(update.emission, '0080e6');
  assert.equal(update.emission_energy, 0.4);

  // Emission that the editor reports as disabled must not be written as enabled.
  const off = materialUpdateFromCommandReply({ material: { albedo_color: 'ff0000ff', emission_enabled: false, emission: '00ff00' } });
  assert.equal(off.emission, undefined);

  // No resolved material at all -> null, so the caller falls back to the request and
  // source_authoritative stays false rather than being claimed.
  assert.equal(materialUpdateFromCommandReply({ ok: true }), null);
  assert.equal(materialUpdateFromCommandReply(null), null);
});

test('the editor-resolved material serializes into the scene and verifies against the request', () => {
  const reply = { node_path: 'Core', material: { albedo_color: '00ff66ff', metallic: 0.4, roughness: 0.3, emission_enabled: false } };
  const applied = applyMaterialToSceneText(TWIN_SCENE, 'Core', materialUpdateFromCommandReply(reply));
  assert.equal(verifyMaterialInSource(applied, 'Core', { albedo_color: '#00ff66', metallic: 0.4 }).synced, true);
});
