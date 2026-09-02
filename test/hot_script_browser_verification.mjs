// Browser verification for the hot GDScript channel.
//
// npm test covers the DECISION logic. This covers the part that only a real Godot WASM boot
// can answer: whether copying bytes into a running editor, refreshing through
// EditorFileSystem, and reloading the GDScript actually works — and whether it does it
// WITHOUT replacing the editor. The zero-restart claim is checked against
// window.__webmcpRestartCount, not asserted.
//
//   node test/hot_script_browser_verification.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, '..', 'artifacts', 'hot-script-verification');
const POLYFILL = fs.readFileSync(path.join(HERE, 'webmcp-polyfill.js'), 'utf8');
const BASE = process.env.GODOT_WEB_MCP_URL || 'http://localhost:8060';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const RUNNER_GD = `extends CharacterBody3D

const SPEED := 12.0
const GRAVITY := 24.0
const JUMP_VELOCITY := 9.0

var distance := 0.0

func _physics_process(delta: float) -> void:
	velocity.y -= GRAVITY * delta
	if is_on_floor() and Input.is_action_pressed("ui_accept"):
		velocity.y = JUMP_VELOCITY
	velocity.z = -SPEED
	move_and_slide()
	distance += SPEED * delta
`;

const MAIN_GD = `extends Node3D

func _ready() -> void:
	print("Temple Run online")
`;

const PROJECT_GODOT = `config_version=5

[application]

config/name="Temple Run"
run/main_scene="res://main.tscn"

[rendering]

renderer/rendering_method="gl_compatibility"
`;

const MAIN_TSCN = `[gd_scene load_steps=4 format=3]

[ext_resource type="Script" path="res://main.gd" id="1_main"]
[ext_resource type="Script" path="res://runner.gd" id="2_runner"]

[sub_resource type="BoxMesh" id="Mesh_ground"]
size = Vector3(12, 1, 400)

[node name="Main" type="Node3D"]
script = ExtResource("1_main")

[node name="Ground" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -1, -180)
mesh = SubResource("Mesh_ground")

[node name="Runner" type="CharacterBody3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0)
script = ExtResource("2_runner")

[node name="Camera3D" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 6, 14)

[node name="Sun" type="DirectionalLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.7, 0.7, 0, -0.7, 0.7, 0, 12, 6)
`;

async function main() {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-features=SharedArrayBuffer',
      '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(POLYFILL);
  page.on('pageerror', error => console.log('  [page error]', error.message));

  console.log(`1. Loading ${BASE}`);
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__webmcp && window.__webmcp.tools().length > 0', { timeout: 60000 });
  const tools = await page.evaluate(() => window.__webmcp.tools());
  record('the bridge registers godot_apply_script_patch', tools.includes('godot_apply_script_patch'), `${tools.length} tools`);

  const call = async (name, args) => page.evaluate(
    async (n, a) => window.__webmcp.call(n, a), name, args);
  const shot = async (file) => {
    await page.screenshot({ path: path.join(SHOTS, file) });
    console.log(`     screenshot -> artifacts/hot-script-verification/${file}`);
  };

  console.log('2. Authoring the sample game (this boots the real Godot editor; 30-60s)');
  const created = await call('godot_create_project', {
    project_name: 'temple_run',
    template: 'custom',
    files: { 'project.godot': PROJECT_GODOT, 'main.tscn': MAIN_TSCN, 'main.gd': MAIN_GD, 'runner.gd': RUNNER_GD }
  });
  if (!created.ok) {
    record('sample project boots the editor', false, JSON.stringify(created.error).slice(0, 300));
    await shot('00-project-failed.png');
    await browser.close();
    return finish();
  }
  await page.waitForFunction("window.__godotEditorLifecycle && window.__godotEditorLifecycle.state === 'running'", { timeout: 120000 });
  await new Promise(r => setTimeout(r, 4000));
  record('sample project boots the editor', true, `revision ${created.result.scene_revision}`);
  await shot('01-editor-booted.png');

  const baseline = await page.evaluate(() => ({
    restarts: window.__webmcpRestartCount || 0,
    revision: window.__godotEditorLifecycle.generation
  }));
  console.log(`     baseline editor restarts: ${baseline.restarts}`);

  // --- Hot patch an existing script while the 3D workspace is visible -------------------
  console.log('3. Hot-patching runner.gd');
  const revision = created.result.scene_revision;
  const patched = await call('godot_apply_script_patch', {
    expected_revision: revision,
    path: 'res://runner.gd',
    label: 'Give the runner a double jump',
    patches: [{
      find: 'const JUMP_VELOCITY := 9.0',
      replace: 'const JUMP_VELOCITY := 9.0\nconst MAX_JUMPS := 2\n\nvar jumps_used := 0'
    }]
  });
  const hot = patched.ok ? patched.result : null;
  record('the script edit applies through the live command channel', Boolean(hot) && hot.editor_channel === 'script_command',
    hot ? `channel ${hot.editor_channel}` : JSON.stringify(patched.error).slice(0, 300));
  record('the revision advances', Boolean(hot) && hot.scene_revision === revision + 1, hot ? `rev ${hot.scene_revision}` : '');
  record('the changed line range is reported', Boolean(hot?.changes?.[0]?.start_line),
    hot ? `lines ${hot.changes[0].start_line}-${hot.changes[0].end_line} +${hot.changes[0].added} -${hot.changes[0].removed}` : '');
  record('Godot acknowledged the source hash', Boolean(hot?.compilation?.acknowledged?.[0]?.sha256),
    hot?.compilation?.acknowledged?.[0]?.sha256?.slice(0, 16));

  const afterPatch = await page.evaluate(() => ({
    restarts: window.__webmcpRestartCount || 0,
    lifecycle: window.__godotEditorLifecycle.state,
    generation: window.__godotEditorLifecycle.generation
  }));
  record('the editor was NOT restarted', afterPatch.restarts === baseline.restarts,
    `restarts ${baseline.restarts} -> ${afterPatch.restarts}, state ${afterPatch.lifecycle}`);
  record('the editor stayed on the same Engine generation', afterPatch.generation === baseline.revision,
    `generation ${baseline.revision} -> ${afterPatch.generation}`);
  record('the game was not launched', await page.evaluate(() => window.__godotGameState !== 'running'), '');
  await shot('02-hot-patch-applied.png');

  // --- Create a new script and attach it to a scene node --------------------------------
  console.log('4. Creating a new script and attaching it to the Runner node');
  const attached = await call('godot_apply_script_patch', {
    expected_revision: hot ? hot.scene_revision : revision + 1,
    path: 'res://trail.gd',
    label: 'Add a trail behaviour',
    content: 'extends Node3D\n\nfunc _process(delta: float) -> void:\n\tpass\n',
    attach_to_node_path: 'Ground'
  });
  const attachResult = attached.ok ? attached.result : null;
  record('a new script is created and attached with no restart',
    Boolean(attachResult?.script_attachment) && attachResult.editor_restarted === false,
    attachResult ? `${attachResult.script_attachment.node_path} <- ${attachResult.script_attachment.script_path}` : JSON.stringify(attached.error).slice(0, 300));
  const afterAttach = await page.evaluate(() => window.__webmcpRestartCount || 0);
  record('attaching a script did not restart the editor', afterAttach === baseline.restarts, `restarts ${afterAttach}`);
  await shot('03-script-attached.png');

  // --- Follow off must not steal focus; Follow on opens the Script workspace ------------
  console.log('5. Follow behaviour');
  const followOffScreen = await page.evaluate(() => window.__webmcpFollowProbe || null);
  const revNow = attachResult ? attachResult.scene_revision : (hot ? hot.scene_revision : revision);
  await page.evaluate(() => {
    const button = document.querySelector('[data-follow-agent]');
    if (button) button.click();
  });
  const followState = await page.evaluate(() => {
    const button = document.querySelector('[data-follow-agent]');
    return button ? button.getAttribute('aria-pressed') : null;
  });
  record('the Follow toggle is present and switches on', followState === 'true', `aria-pressed=${followState}`);
  const followed = await call('godot_apply_script_patch', {
    expected_revision: revNow,
    path: 'res://runner.gd',
    label: 'Tune the running speed',
    patches: [{ find: 'const SPEED := 12.0', replace: 'const SPEED := 15.0' }]
  });
  const followResult = followed.ok ? followed.result : null;
  record('with Follow on, the change opens the Script workspace',
    Boolean(followResult?.follow?.followed), JSON.stringify(followResult?.follow || followed.error).slice(0, 200));
  await new Promise(r => setTimeout(r, 2500));
  await shot('04-follow-on-script-workspace.png');

  // --- A syntax error must roll back and leave the revision alone ----------------------
  console.log('6. Injecting a syntax error');
  const beforeBad = await page.evaluate(() => window.__webmcp.status());
  const bad = await call('godot_apply_script_patch', {
    expected_revision: followResult ? followResult.scene_revision : revNow,
    path: 'res://runner.gd',
    label: 'Deliberate syntax error',
    patches: [{ find: 'func _physics_process(delta: float) -> void:', replace: 'func _physics_process(delta: float) -> void' }]
  });
  const afterBad = await page.evaluate(() => window.__webmcp.status());
  record('a syntax error is refused', bad.ok === false, String(bad.error).slice(0, 200));
  record('the revision is unchanged after a refused edit', afterBad.sceneRevision === beforeBad.sceneRevision,
    `rev ${beforeBad.sceneRevision} -> ${afterBad.sceneRevision}`);
  const restartsAfterBad = await page.evaluate(() => window.__webmcpRestartCount || 0);
  record('a refused edit never builds a second Engine', restartsAfterBad === baseline.restarts, `restarts ${restartsAfterBad}`);
  await shot('05-syntax-error-rejected.png');

  // --- Responsive shelf ----------------------------------------------------------------
  console.log('7. Responsive shelf');
  for (const [label, width] of [['wide', 1440], ['split', 900], ['narrow', 620]]) {
    await page.setViewport({ width, height: 900 });
    await new Promise(r => setTimeout(r, 1200));
    const geometry = await page.evaluate(() => {
      const rail = document.getElementById('webmcp-agent-rail');
      const canvas = document.getElementById('editor-canvas');
      const railBox = rail.getBoundingClientRect();
      const canvasBox = canvas.getBoundingClientRect();
      return {
        shelfHeight: window.__webmcpShelfHeight || 0,
        overlap: Math.max(0, canvasBox.bottom - railBox.top),
        railWidth: Math.round(railBox.width)
      };
    });
    record(`the shelf reserves space rather than covering the viewport (${label}, ${width}px)`,
      geometry.overlap <= 2, `overlap ${geometry.overlap.toFixed(1)}px, shelf ${geometry.shelfHeight}px`);
    await shot(`06-shelf-${label}-${width}.png`);
  }

  // Expanded drawer must still not cover the canvas.
  await page.setViewport({ width: 1440, height: 900 });
  await new Promise(r => setTimeout(r, 800));
  await page.evaluate(() => document.getElementById('webmcp-agent-status-strip').click());
  await new Promise(r => setTimeout(r, 1200));
  const expanded = await page.evaluate(() => {
    const rail = document.getElementById('webmcp-agent-rail').getBoundingClientRect();
    const canvas = document.getElementById('editor-canvas').getBoundingClientRect();
    return { overlap: Math.max(0, canvas.bottom - rail.top), shelf: window.__webmcpShelfHeight, cap: Math.round(window.innerHeight * 0.35) };
  });
  record('expanding the shelf resizes the viewport instead of covering it',
    expanded.overlap <= 2 && expanded.shelf <= expanded.cap,
    `overlap ${expanded.overlap.toFixed(1)}px, shelf ${expanded.shelf}px, cap ${expanded.cap}px`);
  await shot('07-shelf-expanded.png');

  await browser.close();
  finish();
}

function finish() {
  const failed = results.filter(entry => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
