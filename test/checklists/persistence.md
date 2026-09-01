# Checklist: persistence

Verifies the property the whole live path exists to protect: **what the human sees in the editor
is exactly what survives a reload.**

Every live mutation writes to two places — the running Godot editor (through the command
channel) and the in-memory `.tscn` that export, `godot_restore_project_session`, and reload all
read back. When those two drift, the editor shows one thing and the saved project holds
another. That drift is the bug class this checklist guards.

`test/scene_roundtrip.test.mjs` covers the text mutations offline. This checklist covers the
part that only a real editor can prove: that the text written back came from Godot itself.

Prerequisite: complete the bootstrap in `test/webmcp-harness.md`, and wait until
`window.__godotEditorPluginReady === true`.

Helpers to paste into any step that needs them:

```js
const call = (n, a) => window.godotWebMcpTestBridge.callTool(n, a || {});
const tscn = async () => (await call('godot_inspect_project_files', { paths: ['res://main_3d.tscn'], include_content: true })).files[0].content;
const blockOf = (s, n) => { const i = s.indexOf(`[node name="${n}"`); if (i < 0) return null; const j = s.indexOf('\n[node name="', i + 1); return s.slice(i, j > 0 ? j : s.length); };
const matBody = (s, id) => { const i = s.indexOf(`[sub_resource type="StandardMaterial3D" id="${id}"]`); return i < 0 ? 'MISSING' : s.slice(i).split('\n').filter(l => l.trim()).slice(0, 6).join(' | '); };
```

## Steps

1. **Rotation reaches the saved scene.** A rotation-only edit used to apply in the editor and
   never appear in the `.tscn`, because the text path only rewrote a transform when a
   `position` was supplied.
   ```js
   const tag = 'P' + Date.now().toString(36);
   await call('godot_node_spawn', { name: tag, mesh_type: 'prism', size: [1,2,1], position: [3,1,0], scale: [1.5,1.5,1.5] });
   const spawned = blockOf(await tscn(), tag).split('\n')[1];
   const r = await call('godot_node_transform', { node_path: tag, rotation: [0, 47, 18] });
   ({ tag, spawned, rotated: blockOf(await tscn(), tag).split('\n')[1], source_authoritative: r.source_authoritative })
   ```
   PASS: `rotated` has a non-identity basis, keeps the origin `3, 1, 0`, and differs from
   `spawned`. Record `source_authoritative` — `true` means the twelve floats came from Godot's
   own `Transform3D`, not from the bridge recomputing one.

2. **Scale and rotation survive a later position-only move.** Reuse the `tag` from step 1.
   ```js
   const m = await call('godot_node_transform', { node_path: TAG, position: [5, 2, 1] });
   ({ moved: blockOf(await tscn(), TAG).split('\n')[1], source_authoritative: m.source_authoritative })
   ```
   PASS: the first nine numbers match step 1's basis; the last three are `5, 2, 1`.
   FAIL if the basis collapses to `1.5, 0, 0, 0, 1.5, 0, 0, 0, 1.5` (rotation lost) or to
   `1, 0, 0, 0, 1, 0, 0, 0, 1` (scale lost too).

3. **Recolouring mutates the material the node actually references.** `SkyrailDeck` in the
   Neon Skyrail template references `StandardMaterial3D_Deck` — deliberately *not* named
   `Mat_SkyrailDeck`, which is what makes it the reproduction case: the old handler always
   minted a fresh `Mat_<node>` sub-resource and never repointed the node, so the colour change
   vanished on reload.
   ```js
   const before = matBody(await tscn(), 'StandardMaterial3D_Deck');
   const r = await call('godot_node_material', { node_path: 'SkyrailDeck', albedo_color: '#ff00aa' });
   const s2 = await tscn();
   ({ before, after: matBody(s2, 'StandardMaterial3D_Deck'),
      nodeRef: (blockOf(s2, 'SkyrailDeck').match(/surface_material_override\/0 = SubResource\("([^"]+)"\)/) || [])[1],
      orphanCreated: s2.includes('id="Mat_SkyrailDeck"') })
   ```
   PASS: `nodeRef === "StandardMaterial3D_Deck"`, `orphanCreated === false`, `after` shows the
   new albedo.

4. **Unrelated material properties are preserved.** From step 3's `after`: it must still
   contain `metallic`, `roughness`, `emission_enabled`, and `emission`. Recolouring merges into
   the existing material; it does not replace it. FAIL if any of those disappeared.

5. **The round trip actually round-trips.** Export the project and re-read the scene from the
   archive rather than from memory:
   ```js
   const zip = await call('godot_export_zip', {});
   ({ ok: zip.success, bytes: zip.size_bytes ?? zip.byte_length ?? null, files: (zip.files || []).length })
   ```
   Then reload the page, wait for the session to restore, and re-run the `blockOf` / `matBody`
   reads from steps 2 and 3. PASS: the transform and the material are identical to what the
   editor was showing before the reload. This is the check the whole checklist exists for.

6. **A rejected operation must not be written to source.** The editor refusing an operation and
   the bridge splicing the `.tscn` anyway is how a duplicate node once appeared.
   ```js
   const existing = 'SkyrailDeck';
   try { await call('godot_node_spawn', { name: existing, mesh_type: 'box' }); 'UNEXPECTED_SUCCESS' }
   catch (e) { ({ refused: true, message: e.message.slice(0, 120) }) }
   ```
   PASS: it refuses, and a follow-up `tscn()` contains exactly one `[node name="SkyrailDeck"`.

## Reporting

`check | expected | observed | PASS/FAIL`, then raw JSON for every FAIL. Never infer a pass
from a tool reporting `success: true` — read the scene text.

## Steps 7-9 — the failures a second confirmation run found

These need a scene with **two nodes sharing a leaf name** and **two nodes sharing one
material**. Create one with `godot_create_project` (`template: "custom"`) containing
`BranchA/TwinOrb` and `BranchB/TwinOrb`, both with
`surface_material_override/0 = SubResource("SharedCometMat")`.

7. **Editing one twin must not move the other.**
   ```js
   const r = await call('godot_node_transform', { node_path: 'BranchB/TwinOrb', position: [1.8, 2.4, -1.0] });
   const s = await tscn();
   ({ resolved: r.resolved_node_path, source_synced: r.source_synced, mismatch: r.source_mismatch })
   ```
   Then read both twins' transforms out of `s` by full path. PASS: `BranchB/TwinOrb` is
   `1.8, 2.4, -1` and `BranchA/TwinOrb` is unchanged. `resolved_node_path` must be
   `BranchB/TwinOrb`. FAIL if BranchA moved — that is the reported bug.

8. **A bare ambiguous name must refuse, not guess.**
   ```js
   try { await call('godot_node_transform', { node_path: 'TwinOrb', position: [9,9,9] }); 'UNEXPECTED_SUCCESS' }
   catch (e) { e.message }
   ```
   PASS: it refuses and the message names both candidates. FAIL if it silently succeeds.

9. **Recolouring one twin must not repaint the other.**
   ```js
   const r = await call('godot_node_material', { node_path: 'BranchB/TwinOrb', albedo_color: '#00ff66' });
   const s = await tscn();
   ({ source_synced: r.source_synced, mismatch: r.source_mismatch })
   ```
   Read each twin's `surface_material_override/0` id from `s`. PASS: the ids **differ**,
   BranchA still points at `SharedCometMat` with its original albedo, and BranchB points at a
   fork carrying the new albedo plus the inherited `metallic`/`roughness`. FAIL if both ids are
   still the same — after a reload that repaints both nodes.

   `source_synced` must be `false` (with a mismatch mentioning the material is still shared) in
   the broken case, never `true`.

10. **The playtest must show the live edit.** `godot_run_game` syncs the authoritative files to
    the virtual filesystem first and reports `source_synced_to_disk`. PASS: the running game
    renders the edited colour/position, and the field is `true`. The editor's own scene tab
    will show `(*)` unsaved — that is expected and correct, since the plugin deliberately does
    not call `save_scene()`.

## Steps 11-13 — engine filesystem isolation

The editor and the playtest are **separate `Engine` instances with separate filesystems**.
These steps exist because copying into the editor engine once reported success while the
playtest rendered the pre-edit scene.

11. **Mutate, then run immediately — no reload.**
    ```js
    const m = await call('godot_node_material', { node_path: 'BranchB/TwinOrb', albedo_color: '#00e5ff', emission: '#00e5ff', emission_energy: 2.0 });
    const r = await call('godot_run_game', {});
    ({ rev: m.scene_revision, confirmed: r.playtest_revision_confirmed, files: r.playtest_files_received, editorCopy: r.editor_fs_copy_succeeded })
    ```
    PASS: `confirmed === m.scene_revision`, and a screenshot of the running game shows the new
    colour. FAIL if the game renders the old appearance — regardless of what any field says.
    `editor_fs_copy_succeeded` is a weaker, separate fact; never read it as proof.

12. **A mismatched handshake must refuse.** Force the ack to disagree and confirm the tool
    aborts rather than reporting a current playtest:
    ```js
    let held = null;
    Object.defineProperty(window, '__godotStagedProject', { configurable: true,
      get(){ return held; }, set(v){ held = v ? { ...v, revision: (v.revision || 0) + 100 } : v; } });
    try { await call('godot_run_game', {}); 'UNEXPECTED_SUCCESS' } catch (e) { ({ code: e.code, message: e.message }) }
    ```
    PASS: `code === 'PLAYTEST_REVISION_UNCONFIRMED'`, the message names both revisions, and the
    session returns to `editor-ready`. Restore with
    `delete window.__godotStagedProject; window.__godotStagedProject = null;`.

13. **A FATAL must fail verification.** `FATAL:` is an unconditional engine abort, not noise.
    ```js
    setTimeout(() => console.error('ERROR: FATAL: Index p_index = -1 is out of bounds (size() = 0).'), 400);
    await call('godot_create_project', { project_name: 'fatal_guard_probe', template: 'neon_skyrail_3d' });
    // then poll:
    const r = await call('godot_get_operation_status', {});
    (r.recent_operations || []).slice(-1)
    ```
    PASS: the operation ends `status: "failed"` with an `ENGINE_FATAL`-derived message, and
    `godot_get_session_status` shows the revision and active project rolled back. Also record
    `engine_health.fatal_errors` — it is scoped to the current editor generation, so leaks
    logged by a previous process must NOT appear there.
