import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The hot GDScript channel replaced "restart the whole editor for every file write" with
// "write into the running editor and make Godot prove it took the bytes". The decision logic
// that makes that safe — what is eligible, what actually changed, whether a shutdown budget
// is being spent — is pure, so it is tested here rather than only demonstrable by hand.
// The browser-only half (a real WASM boot, JavaScriptBridge, EditorFileSystem.update_file,
// Script.reload) is verified against a running page; a green run here does not cover it.
const bridgeSource = fs.readFileSync(new URL('../public/mcp_bridge.js', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const start = bridgeSource.indexOf(startMarker);
  const end = bridgeSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Could not slice ${startMarker} .. ${endMarker}`);
  return bridgeSource.slice(start, end);
}

const {
  cleanProjectPath,
  isHotScriptEligiblePath,
  hotScriptTransactionPlan,
  lineChangeSummary,
  scriptDiagnosticsFromLogs,
  summarizeScriptDiagnostics,
  attachScriptInSceneText,
  exactSourceHashAcknowledged,
  hotScriptRollbackPlan,
  createActiveBudget,
  tickActiveBudget
  , activityHeadline
} = new Function(`
  ${slice('  function phaseLabel', '  function holdRuntimeFrame')}
  ${slice('  function cleanProjectPath', '  function cleanProjectName')}
  ${slice('  function createActiveBudget', '  // Runs \`isDone\` until it returns true')}
  ${slice('  const HOT_SCRIPT_EXTENSION', '  async function sha256HexOfText')}
  ${slice('  function lineChangeSummary', '  const HotScriptChannel = {')}
  ${slice('  function attachScriptInSceneText', '  // Whether a Follow action may take over')}
  return {
    cleanProjectPath, isHotScriptEligiblePath, hotScriptTransactionPlan, lineChangeSummary,
    scriptDiagnosticsFromLogs, summarizeScriptDiagnostics, attachScriptInSceneText,
    exactSourceHashAcknowledged,
    hotScriptRollbackPlan,
    createActiveBudget, tickActiveBudget, activityHeadline
  };
`)();

// ---------------------------------------------------------------------------
// Eligibility: what may take the live path, and what must still replace the editor
// ---------------------------------------------------------------------------

test('only project .gd scripts are eligible for the live channel', () => {
  assert.equal(isHotScriptEligiblePath('temple_run.gd'), true);
  assert.equal(isHotScriptEligiblePath('res://scripts/player.gd'), true);
  assert.equal(isHotScriptEligiblePath('project.godot'), false);
  assert.equal(isHotScriptEligiblePath('main.tscn'), false);
  assert.equal(isHotScriptEligiblePath('art/icon.png'), false);
});

test('the WebMCP plugin is never hot-reloaded through the channel it publishes', () => {
  assert.equal(isHotScriptEligiblePath('addons/webmcp/plugin.gd'), false);
});

test('one ineligible operation sends the whole transaction down the restart path', () => {
  const mixed = hotScriptTransactionPlan([
    { kind: 'write', path: 'player.gd', content: 'extends Node' },
    { kind: 'write', path: 'project.godot', content: '[application]' }
  ]);
  assert.equal(mixed.eligible, false);
  assert.match(mixed.reason, /ineligible_path:project\.godot/);
});

test('deletes and binary writes are never eligible', () => {
  assert.equal(hotScriptTransactionPlan([{ kind: 'delete', path: 'player.gd' }]).eligible, false);
  assert.equal(hotScriptTransactionPlan([{ kind: 'write', path: 'player.gd', content: new Uint8Array([1]) }]).reason, 'binary_content');
  assert.equal(hotScriptTransactionPlan([]).reason, 'no_operations');
});

test('an all-script transaction is eligible and reports its paths', () => {
  const plan = hotScriptTransactionPlan([
    { kind: 'write', path: 'res://player.gd', content: 'extends Node' },
    { kind: 'write', path: 'enemy.gd', content: 'extends Node' }
  ]);
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.paths, ['player.gd', 'enemy.gd']);
});

// ---------------------------------------------------------------------------
// Change summary: what the shelf claims actually changed
// ---------------------------------------------------------------------------

test('a single edited line reports that one line, not the whole file', () => {
  const before = 'extends Node\n\nfunc _ready():\n\tprint("a")\n';
  const after = 'extends Node\n\nfunc _ready():\n\tprint("b")\n';
  const summary = lineChangeSummary(before, after);
  assert.equal(summary.changed, true);
  assert.equal(summary.start_line, 4);
  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 1);
});

test('an insertion reports added lines with nothing removed', () => {
  const summary = lineChangeSummary('a\nb\n', 'a\nx\ny\nb\n');
  assert.equal(summary.start_line, 2);
  assert.equal(summary.added, 2);
  assert.equal(summary.removed, 0);
});

test('identical sources report no change rather than a zero-width range', () => {
  const summary = lineChangeSummary('same\n', 'same\n');
  assert.equal(summary.changed, false);
  assert.equal(summary.start_line, null);
});

test('creating a file from nothing is a change over the whole new body', () => {
  const summary = lineChangeSummary('', 'extends Node\nfunc _ready():\n\tpass\n');
  assert.equal(summary.changed, true);
  assert.equal(summary.start_line, 1);
  assert.equal(summary.added, 3);
});

// ---------------------------------------------------------------------------
// Diagnostics: Godot prints the message and its line number on separate lines
// ---------------------------------------------------------------------------

test('a parse error is paired with its at: line so the line number survives', () => {
  const logs = [
    { time: 100, generation: 3, level: 'error', msg: 'SCRIPT ERROR: Parse Error: Expected indented block after "func".' },
    { time: 101, generation: 3, level: 'error', msg: '   at: GDScript::reload (res://temple_run.gd:42)' }
  ];
  const diagnostics = scriptDiagnosticsFromLogs(logs, 0, 'res://temple_run.gd', 3);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].line, 42);
  assert.match(diagnostics[0].message, /Expected indented block/);
  assert.match(summarizeScriptDiagnostics(diagnostics, 'res://temple_run.gd'), /temple_run\.gd has a problem on line 42/);
});

test('diagnostics from another script or another editor generation are not attributed here', () => {
  const logs = [
    { time: 100, generation: 3, level: 'error', msg: 'SCRIPT ERROR: Parse Error: bad' },
    { time: 101, generation: 3, level: 'error', msg: '   at: GDScript::reload (res://other.gd:9)' },
    { time: 102, generation: 2, level: 'error', msg: 'SCRIPT ERROR: Parse Error: stale' },
    { time: 103, generation: 2, level: 'error', msg: '   at: GDScript::reload (res://temple_run.gd:7)' }
  ];
  assert.deepEqual(scriptDiagnosticsFromLogs(logs, 0, 'res://temple_run.gd', 3), []);
});

test('a compile failure with no line-level output says so rather than inventing one', () => {
  assert.match(summarizeScriptDiagnostics([], 'res://a.gd'), /printed no line-level reason/);
});

test('publication requires a present exact source hash acknowledgement', () => {
  assert.equal(exactSourceHashAcknowledged('abc123', 'abc123'), true);
  assert.equal(exactSourceHashAcknowledged('abc123', 'different'), false);
  assert.equal(exactSourceHashAcknowledged('abc123', ''), false);
  assert.equal(exactSourceHashAcknowledged('abc123', null), false);
});

test('rollback restores existing scripts and deletes scripts created by the failed transaction', () => {
  const plan = hotScriptRollbackPlan(
    { 'existing.gd': 'extends Node\n' },
    ['existing.gd', 'newly_created.gd']
  );
  assert.deepEqual(plan.restore, { 'existing.gd': 'extends Node\n' });
  assert.deepEqual(plan.remove, ['newly_created.gd']);
});

test('the compact activity rail keeps a completed change label instead of collapsing to Ready', () => {
  assert.equal(activityHeadline({ status: 'running', phase: 'checking_code', label: 'Tune speed' }), 'Checking code');
  assert.equal(activityHeadline({ status: 'succeeded', phase: 'ready', label: 'Tune speed' }), 'Tune speed');
});

// ---------------------------------------------------------------------------
// Scene attachment: keeping the authoritative .tscn in step without a restart
// ---------------------------------------------------------------------------

const SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://player.tscn" id="1_player"]

[node name="Main" type="Node3D"]

[node name="Runner" type="CharacterBody3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)
`;

test('attaching a new script adds an ext_resource, bumps load_steps, and assigns it', () => {
  const result = attachScriptInSceneText(SCENE, 'Runner', 'res://runner.gd');
  assert.equal(result.ok, true);
  assert.match(result.text, /load_steps=3/);
  assert.match(result.text, /\[ext_resource type="Script" path="res:\/\/runner\.gd" id="[^"]+"\]/);
  assert.match(result.text, new RegExp(`script = ExtResource\\("${result.resource_id}"\\)`));
  assert.equal(result.added_ext_resource, true);
  // The assignment must land inside the Runner block, not the scene root's.
  const runnerBlock = result.text.slice(result.text.indexOf('[node name="Runner"'));
  assert.match(runnerBlock, /script = ExtResource/);
});

test('an already-referenced script reuses its id and does not inflate load_steps', () => {
  const first = attachScriptInSceneText(SCENE, 'Runner', 'res://runner.gd');
  const second = attachScriptInSceneText(first.text, 'Runner', 'res://runner.gd');
  assert.equal(second.ok, true);
  assert.equal(second.added_ext_resource, false);
  assert.equal(second.resource_id, first.resource_id);
  assert.match(second.text, /load_steps=3/);
  assert.equal(second.text.match(/script = ExtResource/g).length, 1);
});

test('a node the scene text does not contain is refused rather than silently skipped', () => {
  const result = attachScriptInSceneText(SCENE, 'Ghost', 'res://runner.gd');
  assert.equal(result.ok, false);
  assert.match(result.error, /No \[node name="Ghost"/);
});

test('the scene root accepts a script attachment through the canonical dot path', () => {
  const result = attachScriptInSceneText(SCENE, '.', 'res://main.gd');
  assert.equal(result.ok, true);
  const rootBlock = result.text.slice(
    result.text.indexOf('[node name="Main"'),
    result.text.indexOf('[node name="Runner"')
  );
  assert.match(rootBlock, /script = ExtResource/);
});

// ---------------------------------------------------------------------------
// Active-time budget: a hidden pane must not spend the shutdown deadline
// ---------------------------------------------------------------------------

test('hidden time is recorded but never charged to the budget', () => {
  const budget = createActiveBudget(25000, 0);
  tickActiveBudget(budget, { now: 60000, visible: false, frameAdvanced: false });
  assert.equal(budget.activeMs, 0);
  assert.equal(budget.hiddenMs, 60000);
  assert.equal(budget.status, 'waiting_for_foreground');
});

test('a foregrounded pane whose engine is not rendering is also suspended, not hidden', () => {
  const budget = createActiveBudget(25000, 0);
  tickActiveBudget(budget, { now: 5000, visible: true, frameAdvanced: false });
  assert.equal(budget.activeMs, 0);
  assert.equal(budget.hiddenMs, 0);
  assert.equal(budget.suspendedMs, 5000);
  assert.equal(budget.status, 'waiting_for_foreground');
});

test('the budget resumes on foreground frames and expires only on active time', () => {
  const budget = createActiveBudget(25000, 0);
  tickActiveBudget(budget, { now: 120000, visible: false, frameAdvanced: false });
  tickActiveBudget(budget, { now: 130000, visible: true, frameAdvanced: true });
  assert.equal(budget.status, 'running');
  assert.equal(budget.activeMs, 10000);
  tickActiveBudget(budget, { now: 145000, visible: true, frameAdvanced: true });
  assert.equal(budget.activeMs, 25000);
  assert.equal(budget.status, 'expired');
  // Both durations are kept, so "it took four minutes" and "it had 25 seconds of frames"
  // are separately reportable instead of one unfalsifiable number.
  assert.equal(budget.hiddenMs, 120000);
});

// ---------------------------------------------------------------------------
// Wiring the bridge actually performs, not just the helpers it defines
// ---------------------------------------------------------------------------

test('the file-transaction handler routes eligible .gd writes through the hot channel', () => {
  assert.match(bridgeSource, /const hotPlan = hotScriptTransactionPlan\(args\.operations\);/);
  assert.match(bridgeSource, /if \(hotPlan\.eligible && EditorCommandChannel\.available\(\)\)/);
});

test('the live filesystem write is fenced on both the Engine and the command generation', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /window\.__godotEditorWriteFiles = function/);
  for (const guard of ['replacement_in_flight', 'boot_in_flight', 'editor_not_running', 'generation_changed']) {
    assert.ok(html.includes(guard), `The live filesystem writer does not refuse on ${guard}.`);
  }
});

test('a failed hot transaction never constructs a second Engine', () => {
  const start = bridgeSource.indexOf('async function runHotScriptTransaction');
  const body = bridgeSource.slice(start, bridgeSource.indexOf('\n  // ====', start));
  assert.ok(!/restartEditorWithProject|restoreProjectSnapshot/.test(body),
    'The hot script path must never fall back to building another editor Engine.');
  assert.match(body, /DiagnosticState\.session = 'dirty_unpersisted'/);
});

test('every hot-channel op the bridge calls is dispatched by the plugin', () => {
  const plugin = fs.readFileSync(new URL('../public/addons/webmcp/plugin.gd', import.meta.url), 'utf8');
  for (const op of ['script_preflight', 'script_refresh', 'script_delete', 'script_job_status', 'script_open', 'node_script_attach', 'node_script_restore']) {
    assert.ok(plugin.includes(`"${op}": reply = _op_`), `plugin.gd does not dispatch '${op}'.`);
    assert.ok(bridgeSource.includes(`'${op}'`), `The bridge never calls '${op}'.`);
  }
});

test('preflight trusts Godot script editor dirty state and terminal jobs are consumed', () => {
  const plugin = fs.readFileSync(new URL('../public/addons/webmcp/plugin.gd', import.meta.url), 'utf8');
  assert.match(plugin, /get_unsaved_files\(\)/);
  assert.match(plugin, /_script_jobs\.erase\(job_id\)/);
});

test('a hot edit whose snapshot cannot be persisted is surfaced as dirty', () => {
  const start = bridgeSource.indexOf('async function runHotScriptTransaction');
  const body = bridgeSource.slice(start, bridgeSource.indexOf('\n  // ====', start));
  assert.match(body, /if \(!persisted\) \{\s*DiagnosticState\.session = 'dirty_unpersisted'/);
});

test('undo routes script-command transactions through the live channel without restarting the editor', () => {
  const start = bridgeSource.indexOf("name: 'godot_undo_transaction'");
  const body = bridgeSource.slice(start, bridgeSource.indexOf("name: 'godot_run_game'", start));
  assert.match(body, /transaction\.editor_channel === 'script_command'/);
  assert.match(body, /rollbackHotScripts/);
  assert.match(body, /editor_restarted: false/);
  assert.match(body, /refreshVisiblePlaytest/);
});

test('Follow navigation routes 3D edits back to the 3D workspace without launching a game', () => {
  assert.match(bridgeSource, /function follow3DWorkspace/);
  assert.match(bridgeSource, /EditorCommandChannel\.call\('workspace_3d'/);
  // It may refresh a preview that is already visible, because that IS the surface the change
  // has to appear on. It must never start one, and never switch the page to the game tab.
  assert.doesNotMatch(
    bridgeSource.slice(bridgeSource.indexOf('function follow3DWorkspace'), bridgeSource.indexOf('async function refreshVisiblePlaytest')),
    /startGameRuntime|showTab\('game'\)/
  );
});

test('workspace follow is WebMCP-controllable and survives a same-tab reload', () => {
  assert.match(bridgeSource, /name: 'godot_workspace_follow'/);
  assert.match(bridgeSource, /FollowAgent\.set\(args\.enabled\)/);
  assert.match(bridgeSource, /sessionStorage\?\.setItem\(WORKSPACE_FOLLOW_PREFERENCE_KEY/);
  assert.match(bridgeSource, /sessionStorage\?\.getItem\(WORKSPACE_FOLLOW_PREFERENCE_KEY\)/);
  const toolStart = bridgeSource.indexOf("name: 'godot_workspace_follow'");
  const toolBody = bridgeSource.slice(toolStart, bridgeSource.indexOf("name: 'godot_node_spawn'", toolStart));
  assert.match(toolBody, /DiagnosticHUD\.render\(\)/);
  assert.doesNotMatch(toolBody, /AgentRail\.render\(\)/);
});

test('refreshing an already-visible playtest keeps the session in playtesting state', () => {
  const start = bridgeSource.indexOf('async function refreshVisiblePlaytest');
  const body = bridgeSource.slice(start, bridgeSource.indexOf('async function runHotScriptTransaction', start));
  assert.match(body, /DiagnosticState\.session = 'playtesting'/);
});

// ---------------------------------------------------------------------------
// What the human actually sees: buffer sync, arrival before the write, changed-line reveal
// ---------------------------------------------------------------------------

// The channel's visible half is driven entirely by the payload it hands the plugin, so the
// payload is what is asserted here. The plugin's own half (a real CodeEdit, a real Tween) is
// browser-only and is verified against a running page.
function hotChannelHarness({ viewport = 'editor', jobFields = {}, workspaceConfirmed = true } = {}) {
  const calls = [];
  const EditorCommandChannel = {
    available: () => true,
    async waitForReady() { return true; },
    call(op, payload) {
      calls.push({ op, payload });
      if (op === 'script_refresh') return { ok: true, job_id: `job_${calls.length}`, deferred: true };
      if (op === 'script_job_status') {
        return {
          ok: true,
          job_state: 'done',
          job_ok: true,
          sha256: 'hash-of-' + payload.job_id,
          can_instantiate: true,
          ...jobFields
        };
      }
      if (op === 'workspace_3d') return { ok: true, workspace_confirmed: workspaceConfirmed, selected: payload.node_path || null };
      return { ok: true };
    }
  };
  const scope = new Function(
    'EditorCommandChannel', 'DiagnosticState', 'window', 'awaitWithActiveBudget',
    'exactSourceHashAcknowledged', 'sha256HexOfText', 'cleanProjectPath', 'activeGodotViewport',
    'refreshVisiblePlaytest', 'FollowAgent',
    `
    ${slice('  const HotScriptChannel = {', '  async function rollbackHotScripts')}
    ${slice('  async function follow3DWorkspace', '  async function refreshVisiblePlaytest')}
    return { HotScriptChannel, follow3DWorkspace };
  `)(
    EditorCommandChannel,
    { activeProject: 'demo' },
    { __godotEditorWriteFiles: () => ({ ok: true }) },
    async (probe) => { for (let i = 0; i < 50 && !probe(); i++) { /* settle */ } return { budget: { activeMs: 0 } }; },
    // Every job above answers with the hash of its own id, so acknowledgement is forced to
    // pass here and the assertions stay about the visible payload rather than about hashing.
    () => true,
    async (text) => text,
    (path) => String(path).replace(/^res:\/\//, ''),
    () => viewport,
    async () => 'refreshed',
    { active: () => true }
  );
  return { ...scope, calls };
}

test('only the file the human is following carries the focus and the changed line range', async () => {
  const harness = hotChannelHarness();
  await harness.HotScriptChannel.writeAndRefresh(
    { 'player.gd': 'a', 'enemy.gd': 'b' },
    { 'player.gd': 'x', 'enemy.gd': 'y' },
    { lifecycle: 1, command: 1 },
    { focus: { path: 'player.gd', start_line: 20, end_line: 25, animate: true } }
  );
  const refreshes = harness.calls.filter(entry => entry.op === 'script_refresh');
  const player = refreshes.find(entry => entry.payload.path === 'res://player.gd').payload;
  const enemy = refreshes.find(entry => entry.payload.path === 'res://enemy.gd').payload;
  assert.equal(player.focus, true);
  assert.equal(player.start_line, 20);
  assert.equal(player.end_line, 25);
  assert.equal(player.animate, true);
  assert.equal(enemy.focus, false);
  assert.equal(enemy.animate, false);
});

test('a reduced-motion reader still gets the reveal, without the animation', async () => {
  const harness = hotChannelHarness();
  await harness.HotScriptChannel.writeAndRefresh(
    { 'player.gd': 'a' }, { 'player.gd': 'x' }, { lifecycle: 1, command: 1 },
    { focus: { path: 'player.gd', start_line: 3, end_line: 3, animate: false } }
  );
  const payload = harness.calls.find(entry => entry.op === 'script_refresh').payload;
  assert.equal(payload.focus, true);
  assert.equal(payload.animate, false);
});

test('what the editor reports about the visible buffer is carried back, not assumed', async () => {
  const harness = hotChannelHarness({
    jobFields: {
      buffer: { synced: true },
      reveal: { revealed: true, first_line: 20, last_line: 25, animated: true },
      screen: { workspace: 'Script', workspace_confirmed: true }
    }
  });
  const applied = await harness.HotScriptChannel.writeAndRefresh(
    { 'player.gd': 'a' }, { 'player.gd': 'x' }, { lifecycle: 1, command: 1 },
    { focus: { path: 'player.gd', start_line: 20, end_line: 25, animate: true } }
  );
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.refreshed[0].buffer, { synced: true });
  assert.equal(applied.refreshed[0].revealed.revealed, true);
  assert.equal(applied.refreshed[0].workspace.workspace_confirmed, true);
});

test('an unsynced buffer is reported rather than papered over', async () => {
  const harness = hotChannelHarness({ jobFields: { buffer: { synced: false, stale: true, reason: 'background_buffer' } } });
  const applied = await harness.HotScriptChannel.writeAndRefresh(
    { 'player.gd': 'a' }, { 'player.gd': 'x' }, { lifecycle: 1, command: 1 }, {}
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.refreshed[0].buffer.stale, true);
  assert.equal(applied.refreshed[0].revealed, null);
});

test('following a 3D change while the playtest is visible refreshes the game, not a hidden workspace', async () => {
  const harness = hotChannelHarness({ viewport: 'game' });
  const followed = await harness.follow3DWorkspace('SkyrailDeck');
  assert.equal(followed.surface, 'game');
  assert.equal(followed.preview_state, 'refreshed');
  assert.equal(followed.followed, true);
  assert.equal(harness.calls.some(entry => entry.op === 'workspace_3d'), false);
});

test('following a 3D change with the editor visible switches the workspace and reports what was observed', async () => {
  const harness = hotChannelHarness({ viewport: 'editor' });
  const followed = await harness.follow3DWorkspace('SkyrailDeck');
  assert.equal(harness.calls.some(entry => entry.op === 'workspace_3d'), true);
  assert.equal(followed.workspace, '3D');
  assert.equal(followed.followed, true);
});

test('an accepted but unconfirmed 3D switch is not reported as visibly followed', async () => {
  const harness = hotChannelHarness({ viewport: 'editor', workspaceConfirmed: false });
  const followed = await harness.follow3DWorkspace('SkyrailDeck');
  assert.equal(followed.followed, false);
  assert.equal(followed.workspace, null);
  assert.equal(followed.reason, 'workspace_unconfirmed');
});

test('post-write reveal can confirm following for a script that did not exist at arrival time', () => {
  const start = bridgeSource.indexOf('async function runHotScriptTransaction');
  const body = bridgeSource.slice(start, bridgeSource.indexOf('// 6. Authoritative Native Tool Manifest', start));
  assert.match(body, /navigation\.arrived \|\| navigation\.workspace_confirmed === true \|\| navigation\.revealed === true/);
});

test('the human arrives at the script before the bytes are written, not after', () => {
  const start = bridgeSource.indexOf('async function runHotScriptTransaction');
  const body = bridgeSource.slice(start, bridgeSource.indexOf('// 6. Authoritative Native Tool Manifest', start));
  const arrival = body.indexOf("EditorCommandChannel.call('script_open'");
  const write = body.indexOf('HotScriptChannel.writeAndRefresh');
  assert.ok(arrival > 0 && write > 0, 'both the arrival and the write must be in the transaction');
  assert.ok(arrival < write, 'the Follow navigation must happen before the candidate bytes are written');
});

test('a preview refresh holds the last frame under the rail instead of going black', () => {
  const start = bridgeSource.indexOf('async function refreshVisiblePlaytest');
  const body = bridgeSource.slice(start, bridgeSource.indexOf('async function runHotScriptTransaction', start));
  assert.match(body, /holdRuntimeFrame\(\{ belowRail: true \}\)/);
  assert.match(body, /releaseRuntimeFrame\(\)/);
  // The release has to be unconditional, or a failed relaunch strands a frozen still over a
  // surface that is no longer running.
  assert.match(body, /finally \{[\s\S]*releaseRuntimeFrame\(\)/);
});

test('waiting for a hidden page to paint is reported as waiting, not as a runtime failure', () => {
  const start = bridgeSource.indexOf('async function stopGameRuntime');
  const body = bridgeSource.slice(start, bridgeSource.indexOf('async function startGameRuntime', start));
  assert.match(body, /awaitWithActiveBudget/);
  assert.match(body, /waiting_for_foreground/);
  assert.doesNotMatch(body, /waitFor\(/, 'a wall-clock wait declares a throttled quit failed');
});

// ---------------------------------------------------------------------------
// Following a script edit without taking the screen
// ---------------------------------------------------------------------------

test('file mode is the default, and it never opens the Script workspace', () => {
  assert.match(bridgeSource, /const FOLLOW_MODES = \['file', 'script'\]/);
  const start = bridgeSource.indexOf('  const FollowAgent = {');
  const body = bridgeSource.slice(start, bridgeSource.indexOf('async function follow3DWorkspace', start));
  assert.match(body, /FOLLOW_MODES\.includes\(stored\) \? stored : 'file'/, "an unknown stored mode falls back to 'file'");
  assert.match(body, /opensScriptWorkspace\(\)[\s\S]*this\.mode === 'script'/);
});

test('a script edit only takes the screen on the explicit opt-in', () => {
  const start = bridgeSource.indexOf('async function runHotScriptTransaction');
  const body = bridgeSource.slice(start, bridgeSource.indexOf('// 6. Authoritative Native Tool Manifest', start));
  assert.match(body, /const opensScript = following && FollowAgent\.mode === 'script'/);
  assert.match(body, /if \(opensScript\) \{/, 'the pre-write arrival is gated on the opt-in');
  assert.match(body, /focus: opensScript/, 'the plugin is only asked to focus in script mode');
  // The dock reveal is unconditional: it is the answer to "which file did the agent touch".
  assert.match(body, /reveal,/);
});

test('file mode reports what it did, and does not claim an arrival', () => {
  const start = bridgeSource.indexOf('async function runHotScriptTransaction');
  const body = bridgeSource.slice(start, bridgeSource.indexOf('// 6. Authoritative Native Tool Manifest', start));
  assert.match(body, /mode: 'file'/);
  assert.match(body, /workspace_preserved: true/);
  assert.match(body, /file_revealed: acknowledged \? acknowledged\.dock_revealed === true : false/,
    'the reveal is read back from the editor, not assumed from the request');
});

test('the dock reveal is carried back from the refresh job', async () => {
  const harness = hotChannelHarness({ jobFields: { dock_revealed: true } });
  const applied = await harness.HotScriptChannel.writeAndRefresh(
    { 'player.gd': 'a' }, { 'player.gd': 'x' }, { lifecycle: 1, command: 1 }, {});
  assert.equal(applied.refreshed[0].dock_revealed, true);
});

test('an editor with no FileSystem dock does not report a reveal', async () => {
  const harness = hotChannelHarness({ jobFields: { dock_revealed: false } });
  const applied = await harness.HotScriptChannel.writeAndRefresh(
    { 'player.gd': 'a' }, { 'player.gd': 'x' }, { lifecycle: 1, command: 1 }, {});
  assert.equal(applied.refreshed[0].dock_revealed, false);
});
