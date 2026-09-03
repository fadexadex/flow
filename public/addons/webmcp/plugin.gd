@tool
extends EditorPlugin

## WebMCP command channel.
##
## Publishes a synchronous, JSON-in/JSON-out function on 'window.__godotEditorCommand'
## so the in-page WebMCP bridge can drive the *real* editor: selection, Godot's own
## damped 'focus_selection' fly-to, viewport camera reads, and scene mutations that go
## through the editor's own UndoRedo stack instead of rebooting the WASM process.
##
## Every reply carries 'generation', which the JS side fences against its editor-boot
## counter so a command issued before a restart can never be mistaken for a live one.

const CHANNEL_VERSION := "1.0.0"

var _command_callback: JavaScriptObject = null
var _window: JavaScriptObject = null

func _enter_tree() -> void:
	if not OS.has_feature("web"):
		return
	if not Engine.has_singleton("JavaScriptBridge") and not ClassDB.class_exists("JavaScriptBridge"):
		return
	_window = JavaScriptBridge.get_interface("window")
	if _window == null:
		return
	_command_callback = JavaScriptBridge.create_callback(_on_command)
	_window.__godotEditorCommand = _command_callback
	_window.__godotEditorPluginVersion = CHANNEL_VERSION
	_window.__godotEditorPluginReady = true
	set_process(false)
	_tune_navigation_feel()

func _exit_tree() -> void:
	if _window == null:
		return
	_window.__godotEditorPluginReady = false
	_window.__godotEditorCommand = null
	_command_callback = null

## Godot already owns a damped fly-to; we only widen its easing so agent-driven
## framing reads as cinematic motion rather than a snap.
func _tune_navigation_feel() -> void:
	var settings := EditorInterface.get_editor_settings()
	if settings == null:
		return
	var feel := {
		"editors/3d/navigation_feel/orbit_inertia": 0.22,
		"editors/3d/navigation_feel/translation_inertia": 0.22,
		"editors/3d/navigation_feel/zoom_inertia": 0.22,
	}
	for key in feel:
		if settings.has_setting(key):
			settings.set_setting(key, feel[key])

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

## Why no EditorInterface.save_scene() in the mutation ops below.
##
## JavaScriptBridge callbacks run SYNCHRONOUSLY, inline, on whatever JS call stack invoked
## them (platform/web/javascript_bridge_singleton.cpp: JavaScriptObjectImpl::callback calls
## _callback directly on the main thread, with no call_deferred). So this code executes at an
## arbitrary point in the frame, not from a settled main-loop iteration.
##
## EditorInterface.save_scene() routes through EditorNode::_save_scene_with_preview, which
## reads back the live 3D viewport texture to build a thumbnail and then packs the scene.
## Called re-entrantly from a JS callback that path aborted the whole WASM runtime with
## "FATAL: Index p_index = -1 is out of bounds (size() = 0)" — CRASH_BAD_INDEX, which calls
## GENERATE_TRAP(), an unconditional abort rather than a recoverable error. Recovery was
## impossible: subsequent file copies failed with "Engine must be inited".
##
## UndoRedo.commit_action() already applies the change to the live scene tree, and the WebMCP
## bridge serializes the .tscn text itself and syncs it to the virtual filesystem
## (window.__godotSyncToFS) before a playtest. Saving from here bought nothing and cost the
## editor. The scene is simply left dirty, which is also the honest state: there are unsaved
## live edits.
func _on_command(args: Array) -> String:
	var payload: Variant = null
	if args.size() > 0 and typeof(args[0]) == TYPE_STRING:
		payload = JSON.parse_string(args[0])
	if typeof(payload) != TYPE_DICTIONARY:
		return _reply({"ok": false, "error": "Command payload must be a JSON object string."})
	var op := String(payload.get("op", ""))
	var reply: Dictionary
	match op:
		"ping": reply = _op_ping()
		"viewport_state": reply = _op_viewport_state()
		"camera_pose": reply = _op_camera_pose()
		"select": reply = _op_select(payload)
		"focus": reply = _op_focus(payload)
		"focus_dispatch": reply = _op_focus_dispatch()
		"workspace_3d": reply = _op_workspace_3d(payload)
		"workspace_state": reply = _op_workspace_state()
		"view_preset": reply = _op_view_preset(payload)
		"view_state": reply = _op_view_state()
		"project_state": reply = _op_project_state()
		"project_files": reply = _op_project_files()
		"selection_state": reply = _op_selection_state()
		"asset_import": reply = _op_asset_import(payload)
		"asset_state": reply = _op_asset_state(payload)
		"viewport_tree": reply = _op_viewport_tree()
		"node_add": reply = _op_node_add(payload)
		"node_transform": reply = _op_node_transform(payload)
		"node_material": reply = _op_node_material(payload)
		"node_delete": reply = _op_node_delete(payload)
		"node_state": reply = _op_node_state(payload)
		"save_scene": reply = _op_save_scene()
		"inspect_property": reply = _op_inspect_property(payload)
		"open_scene": reply = _op_open_scene(payload)
		"script_preflight": reply = _op_script_preflight(payload)
		"script_refresh": reply = _op_script_refresh(payload)
		"script_delete": reply = _op_script_delete(payload)
		"script_job_status": reply = _op_script_job_status(payload)
		"script_open": reply = _op_script_open(payload)
		"node_script_attach": reply = _op_node_script_attach(payload)
		"node_script_restore": reply = _op_node_script_restore(payload)
		_: reply = {"ok": false, "error": "Unsupported op: %s" % op}
	return _reply(reply)

func _reply(body: Dictionary) -> String:
	_expire_stale_flash()
	body["generation"] = _generation()
	body["channel_version"] = CHANNEL_VERSION
	var text := JSON.stringify(body)
	# Belt-and-braces: some browsers drop synchronous return values across the
	# JavaScriptBridge boundary, so the last reply is also readable from JS.
	if _window != null:
		_window.__godotEditorCommandResult = text
	return text

## The boot generation the JS bridge stamped on 'window' before starting this editor.
func _generation() -> int:
	if _window == null:
		return 0
	var value = _window.__godotEditorGeneration
	return int(value) if value != null else 0

# ---------------------------------------------------------------------------
# Read operations
# ---------------------------------------------------------------------------

func _op_ping() -> Dictionary:
	return {
		"ok": true,
		"engine_version": Engine.get_version_info().get("string", ""),
		"has_edited_scene": EditorInterface.get_edited_scene_root() != null,
	}

func _viewport_camera() -> Camera3D:
	var viewport := EditorInterface.get_editor_viewport_3d(0)
	return viewport.get_camera_3d() if viewport != null else null

func _op_camera_pose() -> Dictionary:
	var camera := _viewport_camera()
	if camera == null:
		return {"ok": false, "error": "No 3D editor viewport camera is available."}
	var transform := camera.global_transform
	var basis := transform.basis
	return {
		"ok": true,
		"position": [transform.origin.x, transform.origin.y, transform.origin.z],
		"basis": [
			basis.x.x, basis.x.y, basis.x.z,
			basis.y.x, basis.y.y, basis.y.z,
			basis.z.x, basis.z.y, basis.z.z,
		],
		"fov": camera.fov,
		"near": camera.near,
		"far": camera.far,
		"projection": camera.projection,
	}

func _op_viewport_state() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var selected: Array = []
	for node in EditorInterface.get_selection().get_selected_nodes():
		if root != null:
			selected.append(String(root.get_path_to(node)))
	var pose := _op_camera_pose()
	return {
		"ok": true,
		"edited_scene": root.scene_file_path if root != null else "",
		"root_name": root.name if root != null else "",
		"selection": selected,
		"unsaved": EditorInterface.get_edited_scene_root() != null and _scene_is_dirty(),
		"camera": pose if pose.get("ok", false) else null,
	}

func _scene_is_dirty() -> bool:
	# 4.x exposes no public dirty flag; the marker is advisory only.
	return false

func _op_inspect_property(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null:
		return _resolve_error(String(payload.get("node_path", "")))
	var property_name := String(payload.get("property", ""))
	if property_name == "":
		var names: Array = []
		for entry in node.get_property_list():
			if int(entry.get("usage", 0)) & PROPERTY_USAGE_EDITOR:
				names.append(entry.get("name", ""))
		return {"ok": true, "node_path": String(payload.get("node_path", "")), "properties": names}
	var value = node.get(property_name)
	return {
		"ok": true,
		"node_path": String(payload.get("node_path", "")),
		"property": property_name,
		"value": str(value),
		"type": type_string(typeof(value)),
	}

# ---------------------------------------------------------------------------
# Selection and framing
# ---------------------------------------------------------------------------

func _resolve_node(node_path: String) -> Node:
	var root := EditorInterface.get_edited_scene_root()
	if root == null or node_path == "":
		return null
	if node_path == "." or node_path == String(root.name):
		return root
	var direct := root.get_node_or_null(NodePath(node_path))
	if direct != null:
		return direct
	# Fall back to a by-name search so agents can address nodes without full paths — but only
	# when the name is unique. A .tscn may hold BranchA/TwinOrb and BranchB/TwinOrb, and
	# silently picking the first is how an edit lands on the wrong object.
	var leaf := node_path.get_file() if node_path.contains("/") else node_path
	var matches := _find_all_by_name(root, leaf)
	return matches[0] if matches.size() == 1 else null

## Every node with this name, so callers can tell "missing" from "ambiguous".
func _find_all_by_name(node: Node, wanted: String, found: Array = []) -> Array:
	if String(node.name) == wanted:
		found.append(node)
	for child in node.get_children():
		_find_all_by_name(child, wanted, found)
	return found

func _find_by_name(node: Node, wanted: String) -> Node:
	if String(node.name) == wanted:
		return node
	for child in node.get_children():
		var found := _find_by_name(child, wanted)
		if found != null:
			return found
	return null

## A single explanation for every failed lookup, so an ambiguous path is never reported as a
## missing node (which would send the caller looking for the wrong problem).
func _resolve_error(node_path: String, expected := "Node") -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"ok": false, "error": "No scene is open in the editor."}
	var leaf := node_path.get_file() if node_path.contains("/") else node_path
	var matches := _find_all_by_name(root, leaf)
	if matches.size() > 1:
		var paths: Array = []
		for match in matches:
			paths.append(String(root.get_path_to(match)))
		return {
			"ok": false,
			"code": "AMBIGUOUS_NODE_PATH",
			"candidates": paths,
			"error": "'%s' is ambiguous: %d nodes are named '%s' (%s). Pass the full scene-relative path." % [node_path, matches.size(), leaf, ", ".join(paths)],
		}
	return {"ok": false, "error": "%s not found: %s" % [expected, node_path]}

func _op_select(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null:
		return _resolve_error(String(payload.get("node_path", "")))
	var selection := EditorInterface.get_selection()
	selection.clear()
	selection.add_node(node)
	var root := EditorInterface.get_edited_scene_root()
	return {
		"ok": true,
		"selected": String(root.get_path_to(node)),
		"node_class": node.get_class(),
	}

## Frame the node using Godot's own 'spatial_editor/focus_selection' shortcut, which eases
## the viewport camera with the editor's configured navigation inertia. There is no public
## API for setting the 3D viewport camera (godot-proposals#12112), and Camera3D.look_at is
## reset by the user's next navigation input, so the shortcut is the only supported path.
##
## Node3DEditorViewport handles that shortcut in _sinput, which is connected to the
## gui_input signal of its focusable 'surface' Control. Pushing the key into the SubViewport
## does not reach it: the SubViewport is a *child* of the container, so input pushed there
## only travels down into the 3D scene. Emitting gui_input on the surface reaches the handler
## directly, without depending on where the mouse happens to be.
func _spatial_editor_surface() -> Control:
	var viewport := EditorInterface.get_editor_viewport_3d(0)
	if viewport == null:
		return null
	var editor_viewport := viewport.get_parent()
	if editor_viewport != null:
		editor_viewport = editor_viewport.get_parent()
	if editor_viewport == null:
		return null
	for child in editor_viewport.get_children():
		if child is Control and (child as Control).focus_mode != Control.FOCUS_NONE:
			return child as Control
	return null

func _dispatch_viewport_shortcut(keycode: int) -> Dictionary:
	var surface := _spatial_editor_surface()
	var viewport := EditorInterface.get_editor_viewport_3d(0)
	if surface == null and viewport == null:
		return {"ok": false, "error": "No 3D editor viewport is available."}
	var mechanism := ""
	for pressed in [true, false]:
		var event := InputEventKey.new()
		event.keycode = keycode
		event.physical_keycode = keycode
		event.pressed = pressed
		event.echo = false
		if surface != null:
			if pressed:
				surface.grab_focus()
			surface.emit_signal("gui_input", event)
			mechanism = "surface.gui_input"
		else:
			viewport.push_input(event)
			mechanism = "subviewport.push_input"
	return {"ok": true, "mechanism": mechanism}

## Which main-screen editor Godot is actually showing.
##
## EditorInterface can set the main screen but cannot report it, so this reads the visible
## child of the main-screen container. The control's node name is its class ("Node3DEditor"),
## not the tab label ("3D"), so the match is by hint and returns null rather than a guess when
## the mapping is unknown - a follow result must say what was observed, not what was asked for.
const MAIN_SCREEN_HINTS := {
	"3D": ["node3d", "spatial"],
	"2D": ["canvasitem", "2d"],
	"Script": ["script"],
	"Game": ["game"],
	"AssetLib": ["asset"],
}

func _visible_main_screen() -> String:
	var main_screen := EditorInterface.get_editor_main_screen()
	if main_screen == null:
		return ""
	for child in main_screen.get_children():
		if child is Control and (child as Control).visible:
			return _main_screen_identity(child as Control)
	return ""

## Godot can wrap a main-screen editor in a WindowWrapper so the human can tear it off into its
## own window, so the visible child is not always the editor itself. One level of unwrapping is
## the difference between observing "ScriptEditor" and observing "WindowWrapper" and then
## reporting a confirmation failure for a switch that in fact worked.
func _main_screen_identity(control: Control) -> String:
	var screen_name := control.name
	if not screen_name.to_lower().contains("windowwrapper"):
		return screen_name
	for child in control.get_children():
		if child is Control:
			return child.name
	return screen_name

func _select_main_screen(screen_name: String) -> Dictionary:
	EditorInterface.set_main_screen_editor(screen_name)
	var shown := _visible_main_screen()
	var confirmed = null
	if shown != "" and MAIN_SCREEN_HINTS.has(screen_name):
		confirmed = false
		for hint in MAIN_SCREEN_HINTS[screen_name]:
			if shown.to_lower().contains(hint):
				confirmed = true
				break
	return {
		"workspace": screen_name,
		"workspace_control": shown,
		"workspace_confirmed": confirmed,
	}

func _op_workspace_state() -> Dictionary:
	var shown := _visible_main_screen()
	return {
		"ok": true,
		"workspace_control": shown,
		"process_ticks": _process_ticks,
		"flash_active": _flash_edit != null,
		"scroll_active": _scroll_edit != null,
	}

func _op_focus(payload: Dictionary) -> Dictionary:
	var screen := _select_main_screen("3D")
	var selected := _op_select(payload)
	if not selected.get("ok", false):
		return selected
	selected.merge(screen, true)
	var dispatched := _op_focus_dispatch()
	selected["focused"] = dispatched.get("ok", false)
	selected["mechanism"] = dispatched.get("mechanism", "")
	selected["shortcut"] = "spatial_editor/focus_selection"
	selected["camera_moved"] = dispatched.get("camera_moved", false)
	return selected

func _op_workspace_3d(payload: Dictionary) -> Dictionary:
	var screen := _select_main_screen("3D")
	var node_path := String(payload.get("node_path", ""))
	if node_path == "":
		var reply := {"ok": true, "selected": null}
		reply.merge(screen, true)
		return reply
	var selected := _op_select({"node_path": node_path})
	if not selected.get("ok", false):
		return selected
	selected.merge(screen, true)
	return selected

## Dispatch only, no selection. Node3DEditor reacts to EditorSelection changes on a deferred
## call, so a shortcut sent in the same frame as the selection frames an empty set. The JS
## side selects, waits a frame, then calls this.
func _op_focus_dispatch() -> Dictionary:
	var camera := _viewport_camera()
	var before := camera.global_transform.origin if camera != null else Vector3.ZERO
	var dispatched := _dispatch_viewport_shortcut(KEY_F)
	if not dispatched.get("ok", false):
		return dispatched
	var selection_count := EditorInterface.get_selection().get_selected_nodes().size()
	var after := camera.global_transform.origin if camera != null else Vector3.ZERO
	dispatched["selection_count"] = selection_count
	dispatched["camera_before"] = [before.x, before.y, before.z]
	# The camera itself eases over several frames; camera_cursor moves immediately, so an
	# unchanged origin here is not yet proof that nothing happened.
	dispatched["camera_after_immediate"] = [after.x, after.y, after.z]
	dispatched["camera_moved"] = before.distance_to(after) > 0.0001
	return dispatched

## Diagnostic: report the ancestor chain of the 3D editor viewport so the JS side can see
## which control actually owns the spatial editor shortcuts.
func _op_viewport_tree() -> Dictionary:
	var viewport := EditorInterface.get_editor_viewport_3d(0)
	if viewport == null:
		return {"ok": false, "error": "No 3D editor viewport."}
	var chain: Array = []
	var node: Node = viewport
	while node != null and chain.size() < 12:
		chain.append({"class": node.get_class(), "name": String(node.name)})
		node = node.get_parent()
	return {"ok": true, "chain": chain}

## Godot's own numpad view shortcuts, dispatched through the same surface handler so the
## camera interpolates to the preset with the editor's configured inertia.
## Godot labels the direction entries "Top View", "Front View" and so on, while the projection
## entries are bare. The button's own text is the short form ("Top"), which is what the applied
## check below compares against.
const VIEW_PRESET_LABELS := {
	"front": "Front View",
	"rear": "Rear View",
	"left": "Left View",
	"right": "Right View",
	"top": "Top View",
	"bottom": "Bottom View",
	"perspective": "Perspective",
	"orthogonal": "Orthogonal",
}

## The 3D viewport's own view menu - the control whose label reads "Perspective".
##
## The previous implementation synthesised a numpad InputEventKey and emitted it as the
## surface's gui_input signal. It reported ok on every call and did nothing: the camera pose was
## identical before and after and the viewport label never changed, because the shortcut match
## inside Node3DEditorViewport never fired for a hand-built event. Driving the menu the
## viewport already owns is the same action a human takes, and unlike a synthetic key it can be
## checked afterwards by reading the label back.
func _viewport_view_menu(label: String) -> MenuButton:
	# Climb from the SubViewport rather than assuming a fixed depth: the container chain
	# between the viewport and the Control that owns the view menu is Godot's business, and it
	# has changed between versions. Each ancestor is searched before moving further out, so the
	# menu found belongs to the nearest viewport rather than to a sibling one.
	var node: Node = EditorInterface.get_editor_viewport_3d(0)
	var hops := 0
	while node != null and hops < 6:
		var found := _find_menu_with_item(node, label)
		if found != null:
			return found
		node = node.get_parent()
		hops += 1
	# Last resort: the main screen. An item named Top or Perspective only exists in a 3D
	# viewport's own view menu, so a match here is still the right control.
	var main_screen := EditorInterface.get_editor_main_screen()
	if main_screen != null:
		return _find_menu_with_item(main_screen, label)
	return null

func _find_menu_with_item(node: Node, label: String) -> MenuButton:
	for child in node.get_children():
		if child is MenuButton:
			var candidate := child as MenuButton
			if _menu_item_index(candidate, label) >= 0:
				return candidate
		var nested := _find_menu_with_item(child, label)
		if nested != null:
			return nested
	return null

func _menu_item_index(menu: MenuButton, label: String) -> int:
	var popup := menu.get_popup()
	if popup == null:
		return -1
	for index in popup.item_count:
		if popup.get_item_text(index).to_lower() == label.to_lower():
			return index
	return -1

## What the 3D viewport reports about its own view. Used by the rail to reflect the current
## projection, and the honest answer to "why did the preset not apply".
## What Godot actually has open.
##
## The bridge keeps its own model of the project in memory, and until now nothing ever asked
## the editor whether that model was still true. Open a different project through Godot own
## project manager and the rail kept describing the previous one - the same scene tree, the
## same node count, the same project name - while the editor showed an empty scene. This is
## the editor answer, so the two can be compared instead of assumed equal.
## Read the open project's own text files out of the editor filesystem.
##
## A project created through Godot's own project manager exists only in the engine's virtual
## filesystem; the bridge never staged it and so could never list it, reopen it, or persist it.
## This is how such a project is adopted into the library: the editor is already holding it, so
## the files can simply be read back. Binary assets are named but not carried - the bridge's
## project model is text - so an adoption reports what it left behind instead of pretending the
## project is complete.
const ADOPTABLE_TEXT_EXTENSIONS := ["gd", "tscn", "tres", "godot", "cfg", "json", "txt", "md", "gdshader", "import"]
const ADOPT_MAX_BYTES := 2000000

func _op_project_files() -> Dictionary:
	var acc := {"files": {}, "skipped": [], "bytes": 0}
	_collect_project_files("res://", acc)
	return {
		"ok": true,
		"files": acc["files"],
		"skipped": acc["skipped"],
		"bytes": acc["bytes"],
		"project_name": String(ProjectSettings.get_setting("application/config/name", "")),
		"main_scene": String(ProjectSettings.get_setting("application/run/main_scene", "")),
	}

func _collect_project_files(path: String, acc: Dictionary) -> void:
	var dir := DirAccess.open(path)
	if dir == null:
		return
	dir.list_dir_begin()
	var entry := dir.get_next()
	while entry != "":
		if entry.begins_with("."):
			entry = dir.get_next()
			continue
		var full := path.path_join(entry)
		if dir.current_is_dir():
			# The bridge injects its own addon at every editor boot. Adopting it back would put
			# the command channel into the project's own file list, and from there into exports
			# and undo snapshots.
			if full != "res://addons/webmcp":
				_collect_project_files(full, acc)
		elif ADOPTABLE_TEXT_EXTENSIONS.has(entry.get_extension().to_lower()):
			var text := FileAccess.get_file_as_string(full)
			if int(acc["bytes"]) + text.length() <= ADOPT_MAX_BYTES:
				acc["files"][full] = text
				acc["bytes"] = int(acc["bytes"]) + text.length()
			else:
				(acc["skipped"] as Array).append(full)
		else:
			(acc["skipped"] as Array).append(full)
		entry = dir.get_next()
	dir.list_dir_end()

## What the human is currently pointed at.
##
## An agent asked to "make this one taller" had no way to know what "this" was: the bridge
## could read the scene but never the human's selection, so every instruction had to name a
## node explicitly. This is the other half of the collaboration - the editor reporting what the
## person is looking at and has selected, so the agent can resolve a pronoun.
## Make an asset the bridge just wrote into the live filesystem real to Godot.
##
## Assets cannot be staged into a project before the editor boots: a .wav present at boot
## aborts this WASM build during the initial import scan. Writing into the RUNNING editor and
## importing here is the path that works, so this reports the two facts that matter - whether
## Godot can see the file, and whether it could actually import it into a loadable resource.
func _op_asset_import(payload: Dictionary) -> Dictionary:
	var path := String(payload.get("path", ""))
	if not path.begins_with("res://"):
		return {"ok": false, "error": "path must be a res:// path."}
	if not FileAccess.file_exists(path):
		return {"ok": false, "error": "Godot cannot see %s in its filesystem." % path}
	_script_job_counter += 1
	var job_id := "script_job_%d" % _script_job_counter
	_script_jobs[job_id] = {"state": "pending", "path": path, "queued_at": Time.get_ticks_msec()}
	# Scanning and importing walk the whole filesystem and touch the editor docks. This callback
	# runs inline on a JS call stack (see the note above _on_command), and doing that work here
	# aborted the WebAssembly runtime with CRASH_BAD_INDEX - the same way save_scene() did.
	# It has to happen from a settled main-loop iteration instead.
	var steps := {
		"reimport": bool(payload.get("reimport", true)),
		"reveal": bool(payload.get("reveal", true)),
	}
	# call_deferred still runs inside the current frame's idle callbacks, which is where the
	# editor's own EditorProgress task can still be open: nesting a scan there made
	# ProgressDialog::end_task fail its "tasks.has(p_task)" check and then abort the runtime on
	# an empty task stack. Run it from _process instead, on a settled frame with nothing else
	# in flight.
	_asset_jobs.append({"job_id": job_id, "path": path, "steps": steps})
	set_process(true)
	return {"ok": true, "deferred": true, "job_id": job_id, "path": path}

func _run_asset_import_job(job_id: String, path: String, steps: Dictionary) -> void:
	var job: Dictionary = _script_jobs.get(job_id, {})
	job["state"] = "done"
	job["finished_at"] = Time.get_ticks_msec()
	job["failure"] = null
	job["error"] = null
	var filesystem := EditorInterface.get_resource_filesystem()
	if filesystem == null:
		job["ok"] = false
		job["failure"] = "filesystem_unavailable"
		job["error"] = "The editor filesystem is unavailable."
		_script_jobs[job_id] = job
		return
	# A file written straight into the virtual filesystem is invisible to EditorFileSystem until
	# it rescans: update_file() only refreshes an entry a previous scan already found, and a
	# brand new directory was never walked at all. Without the scan there is no import metadata
	# for reimport_files() to work from, and the asset stays unloadable while every call says ok.
	filesystem.update_file(path)
	if not filesystem.is_scanning():
		filesystem.scan()
		job["scanned"] = true
	# reimport_files() is deliberately not called. The scan above already imports a newly seen
	# file, and asking for a second, explicit reimport of the same path aborted this build.
	var dock := EditorInterface.get_file_system_dock()
	if dock != null and bool(steps.get("reveal", true)):
		dock.navigate_to_path(path)
		job["dock_revealed"] = true
	job["exists"] = FileAccess.file_exists(path)
	job["size_bytes"] = FileAccess.get_file_as_bytes(path).size() if bool(job["exists"]) else 0
	job["ok"] = bool(job["exists"])
	if not bool(job["ok"]):
		job["failure"] = "asset_missing"
		job["error"] = "Godot no longer sees %s after the import pass." % path
	_script_jobs[job_id] = job

func _op_asset_state(payload: Dictionary) -> Dictionary:
	var path := String(payload.get("path", ""))
	if not path.begins_with("res://"):
		return {"ok": false, "error": "path must be a res:// path."}
	var filesystem := EditorInterface.get_resource_filesystem()
	var exists := FileAccess.file_exists(path)
	return {
		"ok": true,
		"path": path,
		"exists": exists,
		"has_import": FileAccess.file_exists(path + ".import"),
		"loadable": ResourceLoader.exists(path),
		"scanning": filesystem != null and filesystem.is_scanning(),
		"size_bytes": FileAccess.get_file_as_bytes(path).size() if exists else 0,
	}

func _op_selection_state() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var nodes := []
	var selection := EditorInterface.get_selection()
	if selection != null and root != null:
		for node in selection.get_selected_nodes():
			var script_path := ""
			var script = node.get_script()
			if script != null and script is Resource:
				script_path = (script as Resource).resource_path
			nodes.append({
				"node_path": String(root.get_path_to(node)),
				"name": String(node.name),
				"class": node.get_class(),
				"script": script_path,
			})
	var current_script := ""
	var caret_line := 0
	var script_editor := EditorInterface.get_script_editor()
	if script_editor != null:
		var open_script := script_editor.get_current_script()
		if open_script != null:
			current_script = open_script.resource_path
		var edit := _current_code_edit()
		if edit != null:
			caret_line = edit.get_caret_line() + 1
	return {
		"ok": true,
		"selected_nodes": nodes,
		"selection_count": nodes.size(),
		"workspace": _visible_main_screen(),
		"current_script": current_script,
		"caret_line": caret_line,
		"edited_scene": root.scene_file_path if root != null else "",
	}

func _op_project_state() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var scene_path := ""
	var root_name := ""
	var node_count := 0
	if root != null:
		scene_path = root.scene_file_path
		root_name = root.name
		node_count = _count_nodes(root)
	var open_scenes := []
	for path in EditorInterface.get_open_scenes():
		open_scenes.append(path)
	return {
		"ok": true,
		"project_name": String(ProjectSettings.get_setting("application/config/name", "")),
		"project_path": ProjectSettings.globalize_path("res://"),
		"main_scene": String(ProjectSettings.get_setting("application/run/main_scene", "")),
		"edited_scene_path": scene_path,
		"edited_scene_root": root_name,
		"node_count": node_count,
		"open_scenes": open_scenes,
		"has_edited_scene": root != null,
	}

func _count_nodes(node: Node) -> int:
	var total := 1
	for child in node.get_children():
		total += _count_nodes(child)
	return total

func _op_view_state() -> Dictionary:
	var menus := []
	var main_screen := EditorInterface.get_editor_main_screen()
	if main_screen != null:
		_collect_menus(main_screen, menus)
	var viewport := EditorInterface.get_editor_viewport_3d(0)
	return {
		"ok": true,
		"has_viewport": viewport != null,
		"menus": menus,
	}

func _collect_menus(node: Node, into: Array) -> void:
	for child in node.get_children():
		if child is MenuButton:
			var menu := child as MenuButton
			var popup := menu.get_popup()
			var items := []
			if popup != null:
				for index in popup.item_count:
					items.append(popup.get_item_text(index))
			into.append({"text": menu.text, "name": menu.name, "items": items})
		_collect_menus(child, into)

func _op_view_preset(payload: Dictionary) -> Dictionary:
	var preset := String(payload.get("preset", "")).to_lower()
	if not VIEW_PRESET_LABELS.has(preset):
		return {"ok": false, "error": "Unknown view preset: %s" % preset}
	var label := String(VIEW_PRESET_LABELS[preset])
	var menu := _viewport_view_menu(label)
	if menu == null:
		return {"ok": false, "error": "The 3D viewport view menu is not available."}
	var index := _menu_item_index(menu, label)
	var popup := menu.get_popup()
	var before := menu.text
	# The same signal a click emits, so Godot runs its own _menu_option path.
	popup.id_pressed.emit(popup.get_item_id(index))
	var after := menu.text
	return {
		"ok": true,
		"preset": preset,
		"mechanism": "view_menu.id_pressed",
		"label_before": before,
		"label_after": after,
		"applied": after.to_lower().contains(preset),
	}

# ---------------------------------------------------------------------------
# Mutations — every one lands in the editor's own undo stack
# ---------------------------------------------------------------------------

func _vector3(value: Variant, fallback: Vector3) -> Vector3:
	if typeof(value) != TYPE_ARRAY or (value as Array).size() < 3:
		return fallback
	var array := value as Array
	return Vector3(float(array[0]), float(array[1]), float(array[2]))

func _color(value: Variant, fallback: Color) -> Color:
	if typeof(value) != TYPE_STRING:
		return fallback
	var text := String(value)
	return Color(text) if text.begins_with("#") else fallback

func _build_mesh(payload: Dictionary) -> Mesh:
	var mesh_type := String(payload.get("mesh_type", "box")).to_lower()
	match mesh_type:
		"cylinder":
			var cylinder := CylinderMesh.new()
			cylinder.top_radius = float(payload.get("radius", 0.5))
			cylinder.bottom_radius = float(payload.get("radius", 0.5))
			cylinder.height = float(payload.get("height", 2.0))
			return cylinder
		"sphere":
			var sphere := SphereMesh.new()
			sphere.radius = float(payload.get("radius", 1.0))
			sphere.height = float(payload.get("height", float(payload.get("radius", 1.0)) * 2.0))
			return sphere
		"torus":
			var torus := TorusMesh.new()
			torus.inner_radius = float(payload.get("inner_radius", 2.0))
			torus.outer_radius = float(payload.get("outer_radius", 2.6))
			return torus
		"prism":
			var prism := PrismMesh.new()
			prism.size = _vector3(payload.get("size"), Vector3(1, 2, 1))
			return prism
		"capsule":
			var capsule := CapsuleMesh.new()
			capsule.radius = float(payload.get("radius", 0.5))
			capsule.height = float(payload.get("height", 2.0))
			return capsule
		"plane":
			var plane := PlaneMesh.new()
			var plane_size := _vector3(payload.get("size"), Vector3(10, 10, 0))
			plane.size = Vector2(plane_size.x, plane_size.y)
			return plane
		_:
			var box := BoxMesh.new()
			box.size = _vector3(payload.get("size"), Vector3(2, 2, 2))
			return box

func _build_material(payload: Dictionary, base: StandardMaterial3D = null) -> StandardMaterial3D:
	var material := base if base != null else StandardMaterial3D.new()
	if payload.has("albedo_color"):
		material.albedo_color = _color(payload["albedo_color"], material.albedo_color)
	if payload.has("metallic"):
		material.metallic = float(payload["metallic"])
	if payload.has("roughness"):
		material.roughness = float(payload["roughness"])
	if payload.has("emission"):
		material.emission_enabled = true
		material.emission = _color(payload["emission"], material.emission)
	if payload.has("emission_energy"):
		material.emission_enabled = true
		material.emission_energy_multiplier = float(payload["emission_energy"])
	return material

func _compose_transform(position: Vector3, rotation_degrees: Vector3, scale: Vector3) -> Transform3D:
	var node := Node3D.new()
	node.position = position
	node.rotation_degrees = rotation_degrees
	node.scale = scale
	var composed := node.transform
	node.free()
	return composed

func _op_node_add(payload: Dictionary) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"ok": false, "error": "No scene is open in the editor."}
	var parent := _resolve_node(String(payload.get("parent_path", ".")))
	if parent == null:
		parent = root
	var node_name := String(payload.get("name", ""))
	if node_name == "":
		return {"ok": false, "error": "node_add requires a name."}
	if _find_by_name(root, node_name) != null:
		return {"ok": false, "error": "A node named '%s' already exists in this scene." % node_name}

	var instance := MeshInstance3D.new()
	instance.name = node_name
	instance.mesh = _build_mesh(payload)
	if typeof(payload.get("material")) == TYPE_DICTIONARY:
		instance.set_surface_override_material(0, _build_material(payload["material"]))
	instance.transform = _compose_transform(
		_vector3(payload.get("position"), Vector3.ZERO),
		_vector3(payload.get("rotation"), Vector3.ZERO),
		_vector3(payload.get("scale"), Vector3.ONE))

	var undo := get_undo_redo()
	undo.create_action("WebMCP: add %s" % node_name, UndoRedo.MERGE_DISABLE, root)
	undo.add_do_method(parent, "add_child", instance, true)
	undo.add_do_method(instance, "set_owner", root)
	undo.add_do_reference(instance)
	undo.add_undo_method(parent, "remove_child", instance)
	undo.commit_action()
	return {
		"ok": true,
		"node_path": String(root.get_path_to(instance)),
		"node_name": node_name,
		"aabb": _aabb_of(instance),
		"transform": _transform_array(instance),
	}

func _op_node_transform(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null or not (node is Node3D):
		return _resolve_error(String(payload.get("node_path", "")), "Node3D")
	var node3d := node as Node3D
	var relative := bool(payload.get("relative", false))
	var target := node3d.transform
	var position := _vector3(payload.get("position"), node3d.position)
	var rotation := _vector3(payload.get("rotation"), node3d.rotation_degrees)
	var scale := _vector3(payload.get("scale"), node3d.scale)
	if relative:
		position = node3d.position + _vector3(payload.get("position"), Vector3.ZERO)
		rotation = node3d.rotation_degrees + _vector3(payload.get("rotation"), Vector3.ZERO)
		scale = node3d.scale * _vector3(payload.get("scale"), Vector3.ONE)
	target = _compose_transform(position, rotation, scale)

	var undo := get_undo_redo()
	undo.create_action("WebMCP: transform %s" % node3d.name, UndoRedo.MERGE_ENDS, node3d)
	undo.add_do_property(node3d, "transform", target)
	undo.add_undo_property(node3d, "transform", node3d.transform)
	undo.commit_action()
	return {
		"ok": true,
		"node_path": String(EditorInterface.get_edited_scene_root().get_path_to(node3d)),
		"position": [target.origin.x, target.origin.y, target.origin.z],
		"aabb": _aabb_of(node3d),
		"transform": _transform_array(node3d),
	}

func _op_node_material(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null or not (node is MeshInstance3D):
		return _resolve_error(String(payload.get("node_path", "")), "MeshInstance3D")
	var instance := node as MeshInstance3D
	var previous := instance.get_surface_override_material(0)
	# Copy-on-write, exactly like the editor's own inspector: never mutate a material that
	# other nodes may share. With no override yet, seed from whatever the mesh is actually
	# rendering so a recolour changes one property instead of resetting the whole look.
	var seed: Material = previous
	if seed == null and instance.mesh != null:
		seed = instance.get_active_material(0)
	var updated := _build_material(payload, seed.duplicate() if seed != null else null)
	var undo := get_undo_redo()
	undo.create_action("WebMCP: material %s" % instance.name, UndoRedo.MERGE_ENDS, instance)
	undo.add_do_method(instance, "set_surface_override_material", 0, updated)
	undo.add_do_reference(updated)
	undo.add_undo_method(instance, "set_surface_override_material", 0, previous)
	undo.commit_action()
	# The RESOLVED path, not the requested one: the bridge targets its .tscn edit with this, so
	# echoing back a bare ambiguous leaf would send the source edit to the wrong node.
	var root := EditorInterface.get_edited_scene_root()
	# Report what actually happened rather than a proxy for it. A new material resource is
	# ALWAYS assigned here (copy-on-write), so "forked_material: previous == null" was false
	# precisely in the case that forks from a shared seed.
	var seed_source := "surface_override"
	if previous == null:
		seed_source = "mesh_active_material" if seed != null else "new"
	var applied := {
		"ok": true,
		"node_path": String(root.get_path_to(instance)),
		"requested_path": String(payload.get("node_path", "")),
		"assigned_new_material": true,
		"material_seed": seed_source,
	}
	var resolved := _op_node_state({"node_path": String(root.get_path_to(instance))})
	if resolved.get("ok", false) and resolved.has("material"):
		applied["material"] = resolved["material"]
	return applied

## Explicit, opt-in, and deferred. Never called from a mutation op.
##
## Deferring moves the save onto the next main-loop pass, which is the execution context the
## packer and the thumbnail readback assume. save_scene_as(path, false) is used instead of
## save_scene() specifically to skip the with_preview branch, which is the render-state
## sensitive part. Both guards mirror EditorInterface::save_scene's own preconditions so this
## fails predictably rather than relying on the C++ check.
func _op_save_scene() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"ok": false, "error": "No scene is open in the editor."}
	if root.scene_file_path.is_empty():
		return {"ok": false, "error": "The edited scene has no file path yet; save it once from the editor first."}
	EditorInterface.call_deferred("save_scene_as", root.scene_file_path, false)
	return {
		"ok": true,
		"scene_file_path": root.scene_file_path,
		"deferred": true,
		"note": "Queued for the next main-loop pass; saving inline from a JS callback aborts the web editor.",
	}

func _op_node_delete(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null:
		return _resolve_error(String(payload.get("node_path", "")))
	var root := EditorInterface.get_edited_scene_root()
	if node == root:
		return {"ok": false, "error": "The scene root cannot be deleted through the command channel."}
	var parent := node.get_parent()
	var index := node.get_index()
	var undo := get_undo_redo()
	undo.create_action("WebMCP: delete %s" % node.name, UndoRedo.MERGE_DISABLE, root)
	undo.add_do_method(parent, "remove_child", node)
	undo.add_undo_method(parent, "add_child", node, true)
	undo.add_undo_method(parent, "move_child", node, index)
	undo.add_undo_method(node, "set_owner", root)
	undo.add_undo_reference(node)
	var resolved_path := String(root.get_path_to(node))
	undo.commit_action()
	return {"ok": true, "deleted_node": resolved_path, "node_path": resolved_path, "requested_path": String(payload.get("node_path", ""))}

func _op_open_scene(payload: Dictionary) -> Dictionary:
	var scene_path := String(payload.get("scene_path", ""))
	if not scene_path.begins_with("res://"):
		return {"ok": false, "error": "scene_path must be a res:// path."}
	if not ResourceLoader.exists(scene_path):
		return {"ok": false, "error": "Scene does not exist: %s" % scene_path}
	EditorInterface.open_scene_from_path(scene_path)
	return {"ok": true, "scene_path": scene_path}

## The exact twelve floats Godot itself would write into a .tscn Transform3D, in the same
## column-major order. The JS side writes these back verbatim instead of recomputing a basis
## from Euler angles, which is what let a rotation-only edit exist in the editor but never
## reach the saved scene.
func _transform_array(node: Node) -> Array:
	if not (node is Node3D):
		return []
	var t := (node as Node3D).transform
	return [
		t.basis.x.x, t.basis.x.y, t.basis.x.z,
		t.basis.y.x, t.basis.y.y, t.basis.y.z,
		t.basis.z.x, t.basis.z.y, t.basis.z.z,
		t.origin.x, t.origin.y, t.origin.z,
	]

## Read back what the editor actually holds, so the bridge can serialize truth rather than
## its own model of what it asked for.
func _op_node_state(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null:
		return _resolve_error(String(payload.get("node_path", "")))
	var root := EditorInterface.get_edited_scene_root()
	var state := {
		"ok": true,
		"node_path": String(root.get_path_to(node)),
		"node_class": node.get_class(),
		"transform": _transform_array(node),
		"aabb": _aabb_of(node),
	}
	if node is MeshInstance3D:
		var material := (node as MeshInstance3D).get_surface_override_material(0)
		if material is StandardMaterial3D:
			var standard := material as StandardMaterial3D
			state["material"] = {
				"albedo_color": standard.albedo_color.to_html(true),
				"metallic": standard.metallic,
				"roughness": standard.roughness,
				"emission_enabled": standard.emission_enabled,
				"emission": standard.emission.to_html(false),
				"emission_energy": standard.emission_energy_multiplier,
			}
	return state

func _aabb_of(node: Node) -> Array:
	if node is VisualInstance3D:
		var box := (node as VisualInstance3D).get_aabb()
		var origin := (node as Node3D).global_transform.origin
		return [
			origin.x + box.position.x, origin.y + box.position.y, origin.z + box.position.z,
			box.size.x, box.size.y, box.size.z,
		]
	return []

# ---------------------------------------------------------------------------
# Hot GDScript channel
# ---------------------------------------------------------------------------
#
# Why these are deferred jobs rather than plain ops.
#
# The same constraint that rules out EditorInterface.save_scene() applies here: a
# JavaScriptBridge callback runs inline on whatever JS call stack invoked it, at an arbitrary
# point in the frame. EditorFileSystem.update_file() and Script.reload() both walk editor
# state that a settled main-loop iteration owns, and the script editor may be holding an open
# buffer on the very resource being replaced. So script_refresh only *queues* the work and
# returns a job id; the caller polls script_job_status until the job reports done. That keeps
# the synchronous boundary trivial and puts the real work where the editor expects it.
#
# The job result is deliberately evidence, not reassurance: the sha256 Godot reads back off
# its own filesystem, the Error code reload() returned, and whether the script can be
# instantiated. The bridge publishes nothing until those agree with the bytes it wrote.

var _script_jobs: Dictionary = {}
var _script_job_counter: int = 0

## Live state for the changed-line flash and the reveal scroll.
##
## Both are driven from _process rather than from a Tween. A Tween created by an EditorPlugin
## did not advance in the editor's own loop - the tint was applied and then simply stayed - so
## the fade is stepped by the frame callback that demonstrably runs. Only one flash exists at a
## time: a second agent edit replaces the first rather than layering two fades on one buffer.
const FLASH_SECONDS := 1.25
const FLASH_PEAK := 0.34
const SCROLL_SMOOTHING := 9.0

var _flash_edit: TextEdit = null
var _flash_lines: PackedInt32Array = PackedInt32Array()
var _flash_alpha: float = 0.0
var _flash_started_at: int = 0
var _scroll_edit: TextEdit = null
var _scroll_target: float = 0.0
## Counted so the bridge can verify from the outside that the editor is actually giving this
## plugin frames, instead of an animation silently never running again.
var _process_ticks: int = 0
var _asset_jobs: Array = []

func _open_script_for_path(path: String) -> Script:
	var script_editor := EditorInterface.get_script_editor()
	if script_editor == null:
		return null
	for opened in script_editor.get_open_scripts():
		if opened != null and opened.resource_path == path:
			return opened
	return null

## Refuse to overwrite a human's unsaved work.
##
## Godot 4 exposes no per-buffer dirty flag, so "unsaved" is defined by evidence: the script
## is open in the script editor AND its in-memory source differs from what is on disk. This
## has to run BEFORE the bridge copies its candidate bytes in, because afterwards disk and
## buffer differ by design and every edit would look like a conflict.
func _op_script_preflight(payload: Dictionary) -> Dictionary:
	var path := String(payload.get("path", ""))
	if not path.begins_with("res://"):
		return {"ok": false, "error": "path must be a res:// path."}
	var exists := FileAccess.file_exists(path)
	var opened := _open_script_for_path(path)
	# ScriptEditor owns the authoritative dirty-buffer list. Comparing source_code with disk is
	# racy during a refresh and can both miss editor state and flag our own acknowledged write.
	var unsaved_files := EditorInterface.get_script_editor().get_unsaved_files()
	var unsaved := path in unsaved_files
	return {
		"ok": not unsaved,
		"conflict": "user_buffer" if unsaved else null,
		"error": "%s has unsaved edits open in the script editor; save or close it first." % path if unsaved else null,
		"path": path,
		"exists": exists,
		"open_in_script_editor": opened != null,
		"disk_sha256": FileAccess.get_sha256(path) if exists else "",
	}

## The CodeEdit behind the script tab that is currently in front.
func _current_code_edit() -> TextEdit:
	var script_editor := EditorInterface.get_script_editor()
	if script_editor == null:
		return null
	var current := script_editor.get_current_editor()
	if current == null:
		return null
	return current.get_base_editor() as TextEdit

## Push acknowledged bytes into an already-open script buffer.
##
## The bridge writes candidate bytes straight into the engine's virtual filesystem, so Godot's
## own "this file changed on disk" path never runs. A script the human already had open kept
## rendering its pre-edit text while the agent reported success - and, worse, a later manual
## save of that stale buffer would have silently overwritten the agent's work. Syncing the
## buffer is therefore correctness; the flash below is the part that is decoration.
func _sync_open_script_buffer(script: Script, source: String, focus: bool, line: int) -> Dictionary:
	var script_editor := EditorInterface.get_script_editor()
	if script_editor == null:
		return {"synced": false, "reason": "no_script_editor"}
	var is_open := false
	for opened in script_editor.get_open_scripts():
		if opened == script:
			is_open = true
			break
	# Reading the caret has to happen before edit_script moves it, or "restore where the human
	# was" restores where the agent just put them.
	var previous := _current_code_edit()
	var caret_line: int = previous.get_caret_line() if previous != null else 0
	var caret_column: int = previous.get_caret_column() if previous != null else 0
	var scroll: float = previous.scroll_vertical if previous != null else 0.0
	if not focus:
		# Never pull a background tab in front of someone who is reading a different file, and
		# never open a tab nobody asked for. A buffer that is open but behind stays as it was
		# and is reported stale, so the bridge can say so instead of the editor quietly lying.
		if not is_open:
			return {"synced": false, "reason": "not_open"}
		if script_editor.get_current_script() != script:
			return {"synced": false, "reason": "background_buffer", "stale": true}
	# Following is exactly the request to be taken to the file, so a script that is not open yet
	# - a file the agent just created - is opened here rather than left invisible.
	EditorInterface.edit_script(script, line, 1, focus)
	var edit := _current_code_edit()
	if edit == null:
		return {"synced": false, "reason": "no_base_editor", "stale": true}
	if edit.text == source:
		return {"synced": true, "already_matching": true, "opened": not is_open}
	edit.begin_complex_operation()
	edit.text = source
	edit.end_complex_operation()
	# The buffer now equals what Godot has on disk. Without this the tab would carry an unsaved
	# marker for bytes nobody typed, and the next preflight would refuse the next agent edit as
	# a human-buffer conflict.
	edit.tag_saved_version()
	if not focus:
		edit.set_caret_line(mini(caret_line, maxi(edit.get_line_count() - 1, 0)))
		edit.set_caret_column(caret_column)
		edit.scroll_vertical = scroll
	return {"synced": true, "opened": not is_open}

func _visible_line_span(edit: TextEdit) -> int:
	if edit.has_method("get_visible_line_count"):
		return maxi(int(edit.call("get_visible_line_count")), 4)
	return 20

## Bring the changed lines into view and mark them.
##
## Two deliberate non-choices. The range is never *selected*: a selection survives until the
## next click, and one stray keystroke would then replace the code the agent just wrote. And
## nothing is ever typed out character by character - the bytes are already in the engine, so
## animating them arriving would be a re-enactment, not the edit. What is animated is the
## reader's attention: a damped scroll to the change, and a tint on exactly the changed lines
## that fades out on its own.
func _reveal_script_change(start_line: int, end_line: int, animate: bool) -> Dictionary:
	var edit := _current_code_edit()
	if edit == null:
		return {"revealed": false, "reason": "no_base_editor"}
	var line_count := edit.get_line_count()
	if line_count <= 0:
		return {"revealed": false, "reason": "empty_buffer"}
	var first := clampi(start_line, 1, line_count)
	var last := clampi(maxi(end_line, start_line), first, line_count)
	edit.set_caret_line(first - 1)
	edit.set_caret_column(0)
	var target := clampi(first - 1 - int(_visible_line_span(edit) / 3.0), 0, maxi(line_count - 1, 0))
	if animate:
		_glide_scroll(edit, float(target))
		_flash_change(edit, first, last)
	else:
		edit.scroll_vertical = float(target)
	return {
		"revealed": true,
		"first_line": first,
		"last_line": last,
		"animated": animate,
	}

## A short damped scroll instead of a jump cut. Godot's own smooth scrolling only applies to
## mouse wheel input, so an agent-driven reveal has to move the value itself.
func _glide_scroll(edit: TextEdit, target: float) -> void:
	if absf(edit.scroll_vertical - target) <= 1.0:
		edit.scroll_vertical = target
		_scroll_edit = null
		return
	_scroll_edit = edit
	_scroll_target = target
	set_process(true)

func _flash_change(edit: TextEdit, first: int, last: int) -> void:
	_clear_flash()
	_flash_edit = edit
	_flash_lines = PackedInt32Array()
	for line in range(first - 1, last):
		if line >= 0 and line < edit.get_line_count():
			_flash_lines.append(line)
	if _flash_lines.is_empty():
		_flash_edit = null
		return
	_flash_alpha = FLASH_PEAK
	_flash_started_at = Time.get_ticks_msec()
	_paint_flash(_flash_alpha)
	set_process(true)

func _paint_flash(alpha: float) -> void:
	if _flash_edit == null or not is_instance_valid(_flash_edit):
		return
	var tint := Color(0.29, 0.72, 1.0, alpha)
	for line in _flash_lines:
		if line < _flash_edit.get_line_count():
			_flash_edit.set_line_background_color(line, tint)

func _clear_flash() -> void:
	if _flash_edit != null and is_instance_valid(_flash_edit):
		for line in _flash_lines:
			if line < _flash_edit.get_line_count():
				_flash_edit.set_line_background_color(line, Color(0, 0, 0, 0))
	_flash_edit = null
	_flash_lines = PackedInt32Array()
	_flash_alpha = 0.0

## Belt and braces. If this plugin ever stops being given frames, a tint that was meant to last
## a second must not become permanent decoration on someone's code, so any command arriving
## after the fade should have finished clears it.
func _expire_stale_flash() -> void:
	if _flash_edit == null:
		return
	if Time.get_ticks_msec() - _flash_started_at > int(FLASH_SECONDS * 3000.0):
		_clear_flash()

func _process(delta: float) -> void:
	_process_ticks += 1
	var busy := false
	if not _asset_jobs.is_empty():
		var filesystem := EditorInterface.get_resource_filesystem()
		if filesystem != null and filesystem.is_scanning():
			busy = true
		else:
			var next: Dictionary = _asset_jobs.pop_front()
			_run_asset_import_job(String(next["job_id"]), String(next["path"]), next["steps"])
			busy = not _asset_jobs.is_empty()
	if _flash_edit != null and is_instance_valid(_flash_edit):
		_flash_alpha = maxf(_flash_alpha - delta * (FLASH_PEAK / FLASH_SECONDS), 0.0)
		if _flash_alpha <= 0.0:
			_clear_flash()
		else:
			_paint_flash(_flash_alpha)
			busy = true
	elif _flash_edit != null:
		_clear_flash()
	if _scroll_edit != null and is_instance_valid(_scroll_edit):
		var current := _scroll_edit.scroll_vertical
		if absf(_scroll_target - current) < 0.4:
			_scroll_edit.scroll_vertical = _scroll_target
			_scroll_edit = null
		else:
			_scroll_edit.scroll_vertical = current + (_scroll_target - current) * clampf(delta * SCROLL_SMOOTHING, 0.0, 1.0)
			busy = true
	elif _scroll_edit != null:
		_scroll_edit = null
	if not busy:
		set_process(false)

func _op_script_refresh(payload: Dictionary) -> Dictionary:
	var path := String(payload.get("path", ""))
	if not path.begins_with("res://"):
		return {"ok": false, "error": "path must be a res:// path."}
	_script_job_counter += 1
	var job_id := "script_job_%d" % _script_job_counter
	_script_jobs[job_id] = {"state": "pending", "path": path, "queued_at": Time.get_ticks_msec()}
	# 'reveal' navigates the FileSystem dock; 'focus' is the stronger request that may bring the
	# script tab forward, and only the bridge - which knows whether the human turned following
	# on - is allowed to ask for it.
	var reveal := {
		"reveal": bool(payload.get("reveal", true)),
		"focus": bool(payload.get("focus", false)),
		"start_line": int(payload.get("start_line", 0)),
		"end_line": int(payload.get("end_line", 0)),
		"animate": bool(payload.get("animate", true)),
	}
	call_deferred("_run_script_refresh_job", job_id, path, reveal)
	return {"ok": true, "deferred": true, "job_id": job_id, "path": path}

func _op_script_delete(payload: Dictionary) -> Dictionary:
	var path := String(payload.get("path", ""))
	if not path.begins_with("res://"):
		return {"ok": false, "error": "path must be a res:// path."}
	_script_job_counter += 1
	var job_id := "script_job_%d" % _script_job_counter
	_script_jobs[job_id] = {"state": "pending", "path": path, "queued_at": Time.get_ticks_msec()}
	call_deferred("_run_script_delete_job", job_id, path)
	return {"ok": true, "deferred": true, "job_id": job_id, "path": path}

func _run_script_delete_job(job_id: String, path: String) -> void:
	var job: Dictionary = _script_jobs.get(job_id, {})
	job["state"] = "done"
	job["finished_at"] = Time.get_ticks_msec()
	job["failure"] = null
	job["error"] = null
	if FileAccess.file_exists(path):
		var remove_error := DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
		if remove_error != OK:
			job["ok"] = false
			job["failure"] = "delete_failed"
			job["error"] = "Godot could not remove %s: %s" % [path, error_string(remove_error)]
			_script_jobs[job_id] = job
			return
	var filesystem := EditorInterface.get_resource_filesystem()
	if filesystem != null:
		filesystem.update_file(path)
	job["exists"] = FileAccess.file_exists(path)
	job["ok"] = not bool(job["exists"])
	if not bool(job["ok"]):
		job["failure"] = "delete_failed"
		job["error"] = "Godot still sees %s after removal." % path
	_script_jobs[job_id] = job

func _run_script_refresh_job(job_id: String, path: String, reveal: Dictionary) -> void:
	var job: Dictionary = _script_jobs.get(job_id, {})
	job["state"] = "done"
	job["finished_at"] = Time.get_ticks_msec()
	job["ok"] = false
	job["failure"] = null
	job["error"] = null
	var filesystem := EditorInterface.get_resource_filesystem()
	if filesystem != null:
		filesystem.update_file(path)
	if not FileAccess.file_exists(path):
		job["failure"] = "refresh_failed"
		job["error"] = "Godot's filesystem does not see %s after the write." % path
		_script_jobs[job_id] = job
		return
	# Read back from Godot's own filesystem. This is the only fact that proves the bytes the
	# bridge handed to copyToFS are the bytes the engine now holds.
	job["sha256"] = FileAccess.get_sha256(path)
	var disk_source := FileAccess.get_file_as_string(path)
	# CACHE_MODE_REPLACE updates the cached Resource in place, so a script the human already
	# has open in the script editor follows the new source instead of stranding a stale buffer.
	var loaded := ResourceLoader.load(path, "Script", ResourceLoader.CACHE_MODE_REPLACE)
	if loaded == null or not (loaded is Script):
		job["failure"] = "compile_failed"
		job["error"] = "Godot could not load %s as a Script." % path
		_script_jobs[job_id] = job
		return
	var script := loaded as Script
	# Assign the disk source EXPLICITLY before reloading.
	#
	# Script.reload() re-parses the resource's in-memory source_code, and CACHE_MODE_REPLACE
	# does not reliably refresh that from disk for a script the editor already has cached. So a
	# deliberately broken file was written to disk, hashed correctly, and then "compiled"
	# successfully — because reload() had re-parsed the previous, valid source and returned OK.
	# The compile check was reporting on the wrong bytes. Assigning source_code first makes the
	# Error code reload() returns an answer about the candidate that was actually written.
	script.source_code = disk_source
	var reload_error := script.reload(true)
	job["reload_error"] = reload_error
	job["reload_error_name"] = error_string(reload_error)
	job["can_instantiate"] = script.can_instantiate()
	if reload_error != OK:
		job["failure"] = "compile_failed"
		job["error"] = "GDScript did not compile: %s" % error_string(reload_error)
		_script_jobs[job_id] = job
		return
	job["ok"] = true
	# The bytes are acknowledged. Everything below is about what the human can see: the open
	# buffer must stop showing pre-edit text, and if the agent is being followed the change is
	# scrolled to and marked.
	var focus := bool(reveal.get("focus", false))
	var start_line := int(reveal.get("start_line", 0))
	var end_line := int(reveal.get("end_line", start_line))
	if focus:
		job["screen"] = _select_main_screen("Script")
	job["buffer"] = _sync_open_script_buffer(script, disk_source, focus, maxi(start_line, 1))
	if focus and bool(job["buffer"].get("synced", false)):
		job["reveal"] = _reveal_script_change(maxi(start_line, 1), maxi(end_line, start_line), bool(reveal.get("animate", true)))
	# Revealing the file in the FileSystem dock is the whole of the visible feedback in the
	# default follow mode: it points at what the agent touched without taking the screen. It is
	# reported rather than assumed, because "we told the dock" and "the dock exists" differ.
	job["dock_revealed"] = false
	if bool(reveal.get("reveal", true)):
		var dock := EditorInterface.get_file_system_dock()
		if dock != null:
			dock.navigate_to_path(path)
			job["dock_revealed"] = true
	_script_jobs[job_id] = job

## Poll a deferred job. 'ok' here answers "did the poll succeed", which is not the same
## question as "did the work succeed" — that is 'job_ok', and it is null while pending.
func _op_script_job_status(payload: Dictionary) -> Dictionary:
	var job_id := String(payload.get("job_id", ""))
	if not _script_jobs.has(job_id):
		return {"ok": false, "error": "Unknown script job: %s" % job_id, "job_state": "unknown"}
	var job: Dictionary = _script_jobs[job_id]
	var state := String(job.get("state", "pending"))
	var reply := {
		"ok": true,
		"job_id": job_id,
		"job_state": state,
		"path": job.get("path", ""),
		"queued_at": job.get("queued_at", 0),
	}
	if state != "done":
		reply["job_ok"] = null
		return reply
	reply["job_ok"] = job.get("ok", false)
	reply["failure"] = job.get("failure", null)
	reply["job_error"] = job.get("error", null)
	reply["sha256"] = job.get("sha256", "")
	reply["reload_error"] = job.get("reload_error", null)
	reply["reload_error_name"] = job.get("reload_error_name", null)
	reply["can_instantiate"] = job.get("can_instantiate", null)
	reply["finished_at"] = job.get("finished_at", 0)
	reply["exists"] = job.get("exists", null)
	reply["buffer"] = job.get("buffer", null)
	reply["dock_revealed"] = job.get("dock_revealed", null)
	reply["reveal"] = job.get("reveal", null)
	reply["screen"] = job.get("screen", null)
	# A polled terminal result is one-shot. Keeping every completed source snapshot forever made
	# long authoring sessions grow without bound.
	_script_jobs.erase(job_id)
	return reply

## Switches to the Script workspace at a line. Only ever called when the user has turned
## Follow on, or asked for this one change explicitly.
func _op_script_open(payload: Dictionary) -> Dictionary:
	var path := String(payload.get("path", ""))
	if not ResourceLoader.exists(path):
		return {"ok": false, "error": "Script does not exist: %s" % path}
	var loaded := ResourceLoader.load(path, "Script")
	if loaded == null or not (loaded is Script):
		return {"ok": false, "error": "Could not load %s as a Script." % path}
	var line := int(payload.get("line", 1))
	var end_line := int(payload.get("end_line", line))
	var reply := {"ok": true, "path": path, "line": line, "end_line": end_line}
	reply.merge(_select_main_screen("Script"), true)
	EditorInterface.edit_script(loaded as Script, line, 1, true)
	reply["reveal"] = _reveal_script_change(maxi(line, 1), maxi(end_line, line), bool(payload.get("animate", true)))
	return reply

## Attach a script to an existing node through UndoRedo, so the human can undo it exactly as
## if they had dragged the file onto the node — and so the editor's own scene state, not the
## bridge's model of it, is what the .tscn is then serialized from.
func _op_node_script_attach(payload: Dictionary) -> Dictionary:
	var requested := String(payload.get("node_path", ""))
	var node := _resolve_node(requested)
	if node == null:
		return _resolve_error(requested)
	var path := String(payload.get("script_path", ""))
	if not path.begins_with("res://"):
		return {"ok": false, "error": "script_path must be a res:// path."}
	var filesystem := EditorInterface.get_resource_filesystem()
	if filesystem != null:
		filesystem.update_file(path)
	var loaded := ResourceLoader.load(path, "Script", ResourceLoader.CACHE_MODE_REPLACE)
	if loaded == null or not (loaded is Script):
		return {"ok": false, "error": "Could not load %s as a Script." % path}
	var script := loaded as Script
	var previous := node.get_script()
	var root := EditorInterface.get_edited_scene_root()
	var resolved_path := String(root.get_path_to(node))
	var undo := get_undo_redo()
	undo.create_action("WebMCP: attach %s to %s" % [path.get_file(), node.name], UndoRedo.MERGE_DISABLE, node)
	undo.add_do_method(node, "set_script", script)
	undo.add_undo_method(node, "set_script", previous)
	undo.commit_action()
	var attached: bool = node.get_script() == script
	# A failed command must not leave a half-applied scene mutation behind. This direct restore
	# only runs when UndoRedo did not produce the requested state.
	if not attached:
		node.set_script(previous)
	return {
		"ok": attached,
		"error": null if attached else "The editor did not report the script attached to %s." % resolved_path,
		"node_path": resolved_path,
		"requested_path": requested,
		"script_path": path,
		"previous_script": previous.resource_path if previous != null else null,
	}

## Restore the node-side half of a previously acknowledged WebMCP attachment during hot undo.
## This deliberately does not add a second UndoRedo action: the WebMCP transaction is the undo
## unit, and recording its rollback as another user action would make Ctrl-Z reapply stale state.
func _op_node_script_restore(payload: Dictionary) -> Dictionary:
	var requested := String(payload.get("node_path", ""))
	var node := _resolve_node(requested)
	if node == null:
		return _resolve_error(requested)
	var path := String(payload.get("script_path", ""))
	var script: Script = null
	if path != "":
		var loaded := ResourceLoader.load(path, "Script", ResourceLoader.CACHE_MODE_REPLACE)
		if loaded == null or not (loaded is Script):
			return {"ok": false, "error": "Could not restore script %s." % path}
		script = loaded as Script
	node.set_script(script)
	var root := EditorInterface.get_edited_scene_root()
	return {
		"ok": node.get_script() == script,
		"error": null if node.get_script() == script else "The editor did not restore the script on %s." % requested,
		"node_path": String(root.get_path_to(node)),
		"script_path": path if path != "" else null,
	}
