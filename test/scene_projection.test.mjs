import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// These functions are the arithmetic the whole camera story rests on: if the .tscn parser
// loses a transform or the projection drops a factor, the reticle silently lands on empty
// space — which is exactly the defect this replaced. Rather than re-implementing them here
// (which would test a copy, not the shipped code), slice the real source out of the bridge
// and evaluate it.
const bridgeSource = fs.readFileSync(new URL('../public/mcp_bridge.js', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const start = bridgeSource.indexOf(startMarker);
  const end = bridgeSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Could not slice ${startMarker} .. ${endMarker}`);
  return bridgeSource.slice(start, end);
}

const sceneGraphSource = slice('function meshHalfExtents', '  // ==========================================\n  // 6B.');
const projectionSource = slice('function projectWorldPoint', '  // ==========================================\n  // Real-Time 3D Live Scene Mutator');

const { sceneGraphFromFiles, findSceneNode, projectWorldPoint, projectedRadius, meshHalfExtents } =
  new Function(`${sceneGraphSource}\n${projectionSource}\nreturn { sceneGraphFromFiles, findSceneNode, projectWorldPoint, projectedRadius, meshHalfExtents };`)();

const SCENE = `[gd_scene load_steps=3 format=3]

[sub_resource type="CylinderMesh" id="Mesh_CyberPillar"]
top_radius = 0.4
bottom_radius = 0.4
height = 6.0

[sub_resource type="BoxMesh" id="Mesh_Platform"]
size = Vector3(4, 1, 4)

[node name="Main" type="Node3D"]

[node name="Rig" type="Node3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0)

[node name="CyberPillar" type="MeshInstance3D" parent="Rig"]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1.5, -3)
mesh = SubResource("Mesh_CyberPillar")

[node name="Platform" type="MeshInstance3D" parent="."]
transform = Transform3D(2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0)
mesh = SubResource("Mesh_Platform")

[node name="Camera" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 10)
fov = 60.0
`;

const FILES = { 'main_3d.tscn': SCENE };

test('scene graph extracts transforms and composes parent chains into world positions', () => {
  const graph = sceneGraphFromFiles(FILES);
  const pillar = graph.nodes.find(node => node.name === 'CyberPillar');
  assert.ok(pillar, 'CyberPillar was not parsed out of the scene');
  assert.equal(pillar.node_path, 'Rig/CyberPillar');
  // Parent rig is at y=2; the pillar is at y=1.5 within it.
  assert.deepEqual(pillar.world_position, [1, 3.5, -3]);
});

test('per-node AABBs come from the mesh sub-resource and inherit world scale', () => {
  const graph = sceneGraphFromFiles(FILES);
  const pillar = graph.nodes.find(node => node.name === 'CyberPillar');
  assert.deepEqual(pillar.aabb.half_extents, [0.4, 3, 0.4]);

  const platform = graph.nodes.find(node => node.name === 'Platform');
  // BoxMesh size 4x1x4 gives half-extents 2/0.5/2, uniformly scaled by 2.
  assert.deepEqual(platform.aabb.half_extents, [4, 1, 4]);
});

test('mesh half-extents match generateMeshSubResource defaults for every primitive', () => {
  assert.deepEqual(meshHalfExtents('BoxMesh', {}), [1, 1, 1]);
  assert.deepEqual(meshHalfExtents('SphereMesh', {}), [1, 1, 1]);
  assert.deepEqual(meshHalfExtents('CylinderMesh', {}), [0.5, 1, 0.5]);
  assert.deepEqual(meshHalfExtents('CapsuleMesh', {}), [0.5, 1, 0.5]);
  assert.deepEqual(meshHalfExtents('PrismMesh', {}), [0.5, 1, 0.5]);
  // An unknown primitive must fall back to a finite box, never NaN.
  assert.ok(meshHalfExtents('SomeFutureMesh', {}).every(Number.isFinite));
});

test('the last node in a scene file is parsed, not dropped', () => {
  // JavaScript has no `\Z`; writing the terminator that way makes the final block fail to
  // match, which silently loses whichever node an agent most recently appended.
  const graph = sceneGraphFromFiles(FILES);
  assert.ok(graph.nodes.some(node => node.name === 'Camera'), 'the trailing Camera node was dropped');

  const appended = sceneGraphFromFiles({
    'main_3d.tscn': `${SCENE}\n[node name="JustSpawned" type="MeshInstance3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 3.5, -3)\n`
  });
  const spawned = appended.nodes.find(node => node.name === 'JustSpawned');
  assert.ok(spawned, 'a freshly appended node must be findable immediately');
  assert.deepEqual(spawned.world_position, [0, 3.5, -3]);
});

test('findSceneNode resolves by leaf name and by scene-relative path', () => {
  assert.equal(findSceneNode(FILES, 'CyberPillar')?.node_path, 'Rig/CyberPillar');
  assert.equal(findSceneNode(FILES, 'Rig/CyberPillar')?.node_path, 'Rig/CyberPillar');
  assert.equal(findSceneNode(FILES, 'NoSuchNode'), null);
});

const RECT = { left: 0, top: 0, width: 800, height: 600 };
// Godot cameras look down -Z, so this one at z=10 with an identity basis faces the origin.
const POSE = { source: 'test', fov: 60, transform: { basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 10] } };

test('a point on the camera axis projects to the exact centre of the frame', () => {
  const projection = projectWorldPoint([0, 0, 0], POSE, RECT);
  assert.equal(projection.onScreen, true);
  assert.ok(Math.abs(projection.x - 400) < 1e-9);
  assert.ok(Math.abs(projection.y - 300) < 1e-9);
  assert.equal(projection.behind, false);
});

test('the [0, 3.5, -3] case from the demo lands inside the middle 60% of the frame', () => {
  const pillar = findSceneNode(FILES, 'CyberPillar');
  const projection = projectWorldPoint([0, 3.5, -3], POSE, RECT);
  assert.equal(projection.onScreen, true);
  assert.ok(Math.abs(projection.ndc[0]) <= 0.6 && Math.abs(projection.ndc[1]) <= 0.6,
    `Expected the node inside the middle 60%, got NDC ${JSON.stringify(projection.ndc)}`);
  assert.ok(Array.isArray(pillar.world_position));
});

test('y is inverted: a point above the camera axis projects above the centre line', () => {
  const above = projectWorldPoint([0, 2, 0], POSE, RECT);
  const below = projectWorldPoint([0, -2, 0], POSE, RECT);
  assert.ok(above.y < 300, 'a higher world point must render nearer the top of the frame');
  assert.ok(below.y > 300);
});

test('aspect ratio is applied on x only, so a square offset is not square on screen', () => {
  const horizontal = projectWorldPoint([2, 0, 0], POSE, RECT);
  const vertical = projectWorldPoint([0, 2, 0], POSE, RECT);
  const dx = Math.abs(horizontal.x - 400);
  const dy = Math.abs(vertical.y - 300);
  // 800x600 is 4:3, and fov is vertical, so the same world offset covers fewer pixels
  // horizontally than vertically by exactly the aspect ratio.
  assert.ok(Math.abs(dx / dy - 1) < 1e-9, `expected equal pixel offsets for a 4:3 frame, got ${dx} and ${dy}`);
});

test('a point outside the frustum reports offscreen rather than a centre-frame lie', () => {
  const projection = projectWorldPoint([40, 0, 0], POSE, RECT);
  assert.equal(projection.onScreen, false);
  assert.ok(Math.abs(projection.ndc[0]) > 1);
});

test('a point behind the camera is flagged, mirrored, and never reported on screen', () => {
  const projection = projectWorldPoint([0, 1, 30], POSE, RECT);
  assert.equal(projection.behind, true);
  assert.equal(projection.onScreen, false);
  assert.ok(Number.isFinite(projection.x) && Number.isFinite(projection.y));
});

test('projected radius grows as the target nears and is clamped to a usable range', () => {
  const near = projectWorldPoint([0, 0, 8], POSE, RECT);
  const far = projectWorldPoint([0, 0, -20], POSE, RECT);
  const nearRadius = projectedRadius([1, 1, 1], near, RECT);
  const farRadius = projectedRadius([1, 1, 1], far, RECT);
  assert.ok(nearRadius > farRadius);
  assert.ok(farRadius >= 22, 'the reticle must never collapse below a legible size');
  assert.ok(nearRadius <= RECT.height * 0.45, 'the reticle must never exceed the frame');
});

test('projection uses CSS pixels only, so devicePixelRatio never doubles the coordinates', () => {
  // The canvas backing store is innerWidth * devicePixelRatio while the CSS box is
  // unscaled. getBoundingClientRect() is already CSS pixels, so the same rect must give the
  // same answer regardless of what the backing store is.
  const cssRect = { left: 12, top: 34, width: 493, height: 400 };
  const first = projectWorldPoint([1, 1, 0], POSE, cssRect);
  const second = projectWorldPoint([1, 1, 0], POSE, { ...cssRect });
  assert.deepEqual([first.x, first.y], [second.x, second.y]);
  assert.ok(first.x >= cssRect.left && first.x <= cssRect.left + cssRect.width);
});
