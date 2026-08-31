extends Node3D

const LANES := [-3.0, 0.0, 3.0]
const JUMP_CLEARANCE := 1.35

var runner: Node3D
var runner_y := 0.0
var velocity_y := 0.0
var lane := 1
var active := false
var finished := false
var gates_cleared := 0
var shields := 3
var gates: Array[Dictionary] = []
var spawn_at := -72.0
var pattern_index := 0

var objective: Label
var progress: Label
var prompt: Label
var outcome: Label

func _ready() -> void:
	_make_world()
	_make_hud()
	for z in [-20.0, -36.0, -53.0, -71.0]:
		_spawn_gate(z)
	_refresh_hud()

func _input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo:
		if event.keycode == KEY_SPACE or event.physical_keycode == KEY_SPACE:
			if finished:
				_reset_course()
			elif not active:
				active = true
				velocity_y = 9.5
			elif runner_y < 0.02:
				velocity_y = 9.5
		elif event.keycode == KEY_LEFT or event.physical_keycode == KEY_LEFT:
			lane = max(0, lane - 1)
		elif event.keycode == KEY_RIGHT or event.physical_keycode == KEY_RIGHT:
			lane = min(2, lane + 1)

func _process(delta: float) -> void:
	if Input.is_action_just_pressed("ui_accept"):
		if finished:
			_reset_course()
		else:
			active = true
			if runner_y < 0.02:
				velocity_y = 9.5
	if not active or finished:
		_refresh_hud()
		return
	if Input.is_action_pressed("ui_left"):
		lane = max(0, lane - 1)
	if Input.is_action_pressed("ui_right"):
		lane = min(2, lane + 1)
	runner.position.x = move_toward(runner.position.x, LANES[lane], delta * 14.0)
	velocity_y -= 24.0 * delta
	runner_y = maxf(0.0, runner_y + velocity_y * delta)
	if runner_y == 0.0:
		velocity_y = 0.0
	runner.position.y = 0.95 + runner_y

	for gate_data in gates.duplicate():
		var gate: Node3D = gate_data.node
		gate.position.z += 13.5 * delta
		if not gate_data.checked and gate.position.z > -0.5:
			gate_data.checked = true
			if absf(runner.position.x - gate_data.lane) < 1.2 and runner_y < JUMP_CLEARANCE:
				shields -= 1
				_tint_gate(gate, Color("e3522f"))
				if shields == 0:
					finished = true
					outcome.text = "THE DUNES TAKE THIS ONE"
			else:
				gates_cleared += 1
				_tint_gate(gate, Color("ffd06f"))
		if gate.position.z > 13.0:
			gates.erase(gate_data)
			gate.queue_free()
	if gates.size() < 5:
		_spawn_gate(-72.0)
	if gates_cleared >= 12:
		finished = true
		outcome.text = "HORIZON REACHED · 12 GATES CLEARED"
	_refresh_hud()

func _make_world() -> void:
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color("2b1710")
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.ambient_light_color = Color("d69355")
	environment.ambient_light_energy = 0.65
	var world := WorldEnvironment.new()
	world.environment = environment
	add_child(world)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-52, -32, 0)
	sun.light_color = Color("ffdb9c")
	sun.light_energy = 2.0
	add_child(sun)
	var camera := Camera3D.new()
	camera.position = Vector3(0, 5.8, 11.0)
	camera.look_at(Vector3(0, 1.1, -22.0))
	add_child(camera)
	_make_box(self, Vector3(11.0, 0.28, 140.0), Vector3(0, -0.2, -62), Color("54301e"))
	_make_box(self, Vector3(0.1, 0.08, 140.0), Vector3(-1.5, 0.03, -62), Color("ef9a43"), Color("e77927"))
	_make_box(self, Vector3(0.1, 0.08, 140.0), Vector3(1.5, 0.03, -62), Color("ef9a43"), Color("e77927"))
	for z in range(-10, -128, -13):
		_make_box(self, Vector3(11.0, 0.06, 0.5), Vector3(0, 0.02, z), Color("9e4a25"))
	for side in [-1, 1]:
		for z in range(-12, -126, -19):
			_make_box(self, Vector3(1.6, 4.0, 2.8), Vector3(side * 10.5, 1.8, z), Color("3c2119"))
	runner = Node3D.new()
	runner.position = Vector3(0, 0.95, 0)
	add_child(runner)
	var body := CapsuleMesh.new()
	body.radius = 0.5
	body.height = 1.9
	var mesh := MeshInstance3D.new()
	mesh.mesh = body
	mesh.material_override = _material(Color("f5c46c"), Color("f28b32"))
	runner.add_child(mesh)

func _spawn_gate(z: float) -> void:
	var route := [1, 0, 2, 1, 2, 0, 1]
	var gate := Node3D.new()
	gate.position = Vector3(LANES[route[pattern_index % route.size()]], 0, z)
	add_child(gate)
	for x in [-1.2, 1.2]:
		_make_box(gate, Vector3(0.26, 2.0, 0.42), Vector3(x, 1.0, 0), Color("cb552d"))
	_make_box(gate, Vector3(2.75, 0.34, 0.48), Vector3(0, JUMP_CLEARANCE, 0), Color("cb552d"), Color("f5a83c"))
	gates.append({"node": gate, "lane": gate.position.x, "checked": false})
	pattern_index += 1

func _make_box(parent: Node3D, size: Vector3, position: Vector3, color: Color, emission := Color(0, 0, 0, 1)) -> void:
	var box := BoxMesh.new()
	box.size = size
	var instance := MeshInstance3D.new()
	instance.mesh = box
	instance.position = position
	instance.material_override = _material(color, emission)
	parent.add_child(instance)

func _material(color: Color, emission := Color(0, 0, 0, 1)) -> StandardMaterial3D:
	var material := StandardMaterial3D.new()
	material.albedo_color = color
	material.roughness = 0.52
	if emission != Color(0, 0, 0, 1):
		material.emission_enabled = true
		material.emission = emission
		material.emission_energy_multiplier = 0.45
	return material

func _make_hud() -> void:
	var layer := CanvasLayer.new()
	add_child(layer)
	objective = _label(Vector2(30, 26), 24, Color("ffe2ad"))
	progress = _label(Vector2(31, 62), 16, Color("e8b87c"))
	prompt = _label(Vector2(0, 646), 19, Color("ffe2ad"))
	prompt.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	prompt.size = Vector2(1280, 35)
	outcome = _label(Vector2(0, 300), 30, Color("ffe2ad"))
	outcome.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	outcome.size = Vector2(1280, 70)
	layer.add_child(objective)
	layer.add_child(progress)
	layer.add_child(prompt)
	layer.add_child(outcome)

func _label(position: Vector2, size: int, color: Color) -> Label:
	var label := Label.new()
	label.position = position
	label.add_theme_font_size_override("font_size", size)
	label.add_theme_color_override("font_color", color)
	return label

func _refresh_hud() -> void:
	objective.text = "DUNE DASH · CLEAR THE HORIZON"
	progress.text = "GATES %02d / 12     SHIELDS %d" % [gates_cleared, shields]
	if finished:
		prompt.text = "SPACE TO RUN THE COURSE AGAIN"
	elif not active:
		prompt.text = "← → CHOOSE A LANE     ·     SPACE TO JUMP & BEGIN"
	else:
		var imminent := false
		for gate_data in gates:
			if gate_data.node.position.z > -16.0 and absf(runner.position.x - gate_data.lane) < 1.2:
				imminent = true
		prompt.text = "JUMP NOW" if imminent else "HOLD YOUR LINE     ·     SPACE JUMP     ← → MOVE"
	if not finished:
		outcome.text = ""

func _tint_gate(gate: Node3D, color: Color) -> void:
	for child in gate.get_children():
		if child is MeshInstance3D:
			var material := child.material_override as StandardMaterial3D
			material.emission_enabled = true
			material.emission = color
			material.emission_energy_multiplier = 1.6

func _reset_course() -> void:
	for gate_data in gates:
		gate_data.node.queue_free()
	gates.clear()
	runner.position = Vector3(0, 0.95, 0)
	runner_y = 0
	velocity_y = 0
	lane = 1
	active = false
	finished = false
	gates_cleared = 0
	shields = 3
	spawn_at = -72.0
	pattern_index = 0
	for z in [-20.0, -36.0, -53.0, -71.0]:
		_spawn_gate(z)
