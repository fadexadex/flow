extends Node3D

const LANES := [-3.0, 0.0, 3.0]
const CLEAR_HEIGHT := 1.3

@onready var runner: Node3D = $Runner
@onready var gates_root: Node3D = $Gates
@onready var progress: Label = $HUD/Progress
@onready var cue: Label = $HUD/Cue

var gates: Array[Dictionary] = []
var lane := 1
var runner_height := 0.0
var velocity_y := 0.0
var active := false
var complete := false
var cleared := 0
var shields := 3

func _ready() -> void:
	for gate in gates_root.get_children():
		gates.append({"node": gate, "lane": gate.position.x, "checked": false, "start": gate.position})
	_refresh_copy()

func _input(event: InputEvent) -> void:
	if not (event is InputEventKey) or not event.pressed or event.echo:
		return
	if event.keycode == KEY_LEFT or event.physical_keycode == KEY_LEFT:
		lane = max(0, lane - 1)
	elif event.keycode == KEY_RIGHT or event.physical_keycode == KEY_RIGHT:
		lane = min(2, lane + 1)
	elif event.keycode == KEY_SPACE or event.physical_keycode == KEY_SPACE:
		if complete:
			_reset_run()
		else:
			active = true
			if runner_height < 0.02:
				velocity_y = 9.4

func _process(delta: float) -> void:
	if not active or complete:
		_refresh_copy()
		return
	runner.position.x = move_toward(runner.position.x, LANES[lane], delta * 15.0)
	velocity_y -= 24.0 * delta
	runner_height = maxf(0.0, runner_height + velocity_y * delta)
	if runner_height == 0.0:
		velocity_y = 0.0
	runner.position.y = 0.85 + runner_height
	for gate_data in gates:
		var gate: Node3D = gate_data.node
		if gate_data.checked:
			continue
		gate.position.z += 13.2 * delta
		if gate.position.z > -0.45:
			gate_data.checked = true
			if absf(runner.position.x - gate_data.lane) < 1.2 and runner_height < CLEAR_HEIGHT:
				shields -= 1
			else:
				cleared += 1
	if cleared + (3 - shields) >= gates.size() or shields <= 0:
		complete = true
	_refresh_copy()

func _refresh_copy() -> void:
	progress.text = "GATES %d / %d     SHIELDS %d" % [cleared, gates.size(), shields]
	if complete:
		cue.text = "RELAY COMPLETE · SPACE TO RESET THE COURSE"
	elif not active:
		cue.text = "LEFT / RIGHT TO CHOOSE A LANE · SPACE TO JUMP & BEGIN"
	else:
		cue.text = "JUMP THE GATE · SPACE JUMP · LEFT / RIGHT MOVE"

func _reset_run() -> void:
	for gate_data in gates:
		gate_data.node.position = gate_data.start
		gate_data.checked = false
	runner.position = Vector3(0, 0.85, 0)
	lane = 1
	runner_height = 0.0
	velocity_y = 0.0
	active = false
	complete = false
	cleared = 0
	shields = 3
