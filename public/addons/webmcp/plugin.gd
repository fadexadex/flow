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
		"view_preset": reply = _op_view_preset(payload)
		"viewport_tree": reply = _op_viewport_tree()
		"node_add": reply = _op_node_add(payload)
		"node_transform": reply = _op_node_transform(payload)
		"node_material": reply = _op_node_material(payload)
		"node_delete": reply = _op_node_delete(payload)
		"inspect_property": reply = _op_inspect_property(payload)
		"open_scene": reply = _op_open_scene(payload)
		_: reply = {"ok": false, "error": "Unsupported op: %s" % op}
	return _reply(reply)

func _reply(body: Dictionary) -> String:
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
		return {"ok": false, "error": "Node not found: %s" % payload.get("node_path", "")}
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
	# Fall back to a by-name search so agents can address nodes without full paths.
	var leaf := node_path.get_file() if node_path.contains("/") else node_path
	return _find_by_name(root, leaf)

func _find_by_name(node: Node, wanted: String) -> Node:
	if String(node.name) == wanted:
		return node
	for child in node.get_children():
		var found := _find_by_name(child, wanted)
		if found != null:
			return found
	return null

func _op_select(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null:
		return {"ok": false, "error": "Node not found: %s" % payload.get("node_path", "")}
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

func _op_focus(payload: Dictionary) -> Dictionary:
	var selected := _op_select(payload)
	if not selected.get("ok", false):
		return selected
	var dispatched := _op_focus_dispatch()
	selected["focused"] = dispatched.get("ok", false)
	selected["mechanism"] = dispatched.get("mechanism", "")
	selected["shortcut"] = "spatial_editor/focus_selection"
	selected["camera_moved"] = dispatched.get("camera_moved", false)
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
func _op_view_preset(payload: Dictionary) -> Dictionary:
	var preset := String(payload.get("preset", "")).to_lower()
	var keycode := 0
	match preset:
		"front": keycode = KEY_KP_1
		"top": keycode = KEY_KP_7
		"left": keycode = KEY_KP_3
		"perspective": keycode = KEY_KP_5
		_: return {"ok": false, "error": "Unknown view preset: %s" % preset}
	var dispatched := _dispatch_viewport_shortcut(keycode)
	if not dispatched.get("ok", false):
		return dispatched
	return {"ok": true, "preset": preset, "mechanism": dispatched.get("mechanism", "")}

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
	EditorInterface.save_scene()
	return {
		"ok": true,
		"node_path": String(root.get_path_to(instance)),
		"node_name": node_name,
		"aabb": _aabb_of(instance),
	}

func _op_node_transform(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null or not (node is Node3D):
		return {"ok": false, "error": "Node3D not found: %s" % payload.get("node_path", "")}
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
	EditorInterface.save_scene()
	return {
		"ok": true,
		"node_path": String(EditorInterface.get_edited_scene_root().get_path_to(node3d)),
		"position": [target.origin.x, target.origin.y, target.origin.z],
		"aabb": _aabb_of(node3d),
	}

func _op_node_material(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null or not (node is MeshInstance3D):
		return {"ok": false, "error": "MeshInstance3D not found: %s" % payload.get("node_path", "")}
	var instance := node as MeshInstance3D
	var previous := instance.get_surface_override_material(0)
	var updated := _build_material(payload, previous.duplicate() if previous != null else null)
	var undo := get_undo_redo()
	undo.create_action("WebMCP: material %s" % instance.name, UndoRedo.MERGE_ENDS, instance)
	undo.add_do_method(instance, "set_surface_override_material", 0, updated)
	undo.add_do_reference(updated)
	undo.add_undo_method(instance, "set_surface_override_material", 0, previous)
	undo.commit_action()
	EditorInterface.save_scene()
	return {"ok": true, "node_path": String(payload.get("node_path", ""))}

func _op_node_delete(payload: Dictionary) -> Dictionary:
	var node := _resolve_node(String(payload.get("node_path", "")))
	if node == null:
		return {"ok": false, "error": "Node not found: %s" % payload.get("node_path", "")}
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
	undo.commit_action()
	EditorInterface.save_scene()
	return {"ok": true, "deleted_node": String(payload.get("node_path", ""))}

func _op_open_scene(payload: Dictionary) -> Dictionary:
	var scene_path := String(payload.get("scene_path", ""))
	if not scene_path.begins_with("res://"):
		return {"ok": false, "error": "scene_path must be a res:// path."}
	if not ResourceLoader.exists(scene_path):
		return {"ok": false, "error": "Scene does not exist: %s" % scene_path}
	EditorInterface.open_scene_from_path(scene_path)
	return {"ok": true, "scene_path": scene_path}

func _aabb_of(node: Node) -> Array:
	if node is VisualInstance3D:
		var box := (node as VisualInstance3D).get_aabb()
		var origin := (node as Node3D).global_transform.origin
		return [
			origin.x + box.position.x, origin.y + box.position.y, origin.z + box.position.z,
			box.size.x, box.size.y, box.size.z,
		]
	return []
