// Built-in project templates.
//
// Two complete Godot projects emitted as source: every .tscn, .gd and project.godot the
// editor needs to open them. They are pure string builders with no dependency on bridge
// state, which is why they live here rather than in the middle of mcp_bridge.js - together
// they were ~340 lines of GDScript and scene text sitting between the session state machine
// and the editor command channel.
//
// Consumed by mcp_bridge.js via window.GodotProjectTemplates.
(function () {
  'use strict';

const NeonSkyrail = {
  generateProjectGodot() {
    return `; Engine configuration file for Neon Skyrail 3D
config_version=5

[application]
config/name="Neon Skyrail 3D"
run/main_scene="res://main_3d.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")

[display]
window/size/viewport_width=1280
window/size/viewport_height=720
window/stretch/mode="canvas_items"

[rendering]
renderer/rendering_method="gl_compatibility"
environment/defaults/default_clear_color=Color(0.04, 0.05, 0.1, 1.0)
`;
  },

  generateMain3dScene() {
    return `[gd_scene load_steps=7 format=3 uid="uid://neon_skyrail_main_3d"]

[ext_resource type="Script" path="res://main_3d.gd" id="1_main"]
[ext_resource type="PackedScene" uid="uid://player_runner_3d" path="res://player_runner.tscn" id="2_player"]

[sub_resource type="ProceduralSkyMaterial" id="ProceduralSkyMaterial_1"]
sky_top_color = Color(0.15, 0.25, 0.45, 1)
sky_horizon_color = Color(0.85, 0.45, 0.65, 1)
ground_bottom_color = Color(0.05, 0.05, 0.12, 1)

[sub_resource type="Sky" id="Sky_1"]
sky_material = SubResource("ProceduralSkyMaterial_1")

[sub_resource type="Environment" id="Environment_1"]
background_mode = 2
sky = SubResource("Sky_1")
ambient_light_source = 3
ambient_light_color = Color(0.4, 0.3, 0.55, 1)
fog_enabled = true
fog_light_color = Color(0.75, 0.4, 0.6, 1)
fog_density = 0.0025

[sub_resource type="BoxMesh" id="BoxMesh_Deck"]
size = Vector3(8, 0.4, 900)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Deck"]
albedo_color = Color(0.08, 0.12, 0.25, 1)
metallic = 0.8
roughness = 0.2
emission_enabled = true
emission = Color(0.0, 0.5, 0.9, 1)
emission_energy_multiplier = 0.4

[node name="Main3D" type="Node3D"]
script = ExtResource("1_main")

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Environment_1")

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.866, -0.25, 0.433, 0, 0.866, 0.5, -0.5, -0.433, 0.75, 0, 30, 0)
light_color = Color(1, 0.92, 0.8, 1)
light_energy = 1.6

[node name="SkyrailDeck" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -400)
mesh = SubResource("BoxMesh_Deck")
surface_material_override/0 = SubResource("StandardMaterial3D_Deck")

[node name="PlayerRunner" parent="." instance=ExtResource("2_player")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1.2, 0)
`;
  },

  generateMain3dGd() {
    return `extends Node3D

var score: int = 0
var hazards_passed: int = 0
var collectibles_count: int = 0
const GOAL_Z: float = -800.0

func _ready():
	print("[Neon Skyrail] 3D Environment initialized with 900m Skyrail course.")

func _process(delta):
	var player = get_node_or_null("PlayerRunner")
	if player and player.global_position.z <= GOAL_Z:
		print("[Neon Skyrail] Dawn Gate Reached! Victory!")
`;
  },

  generatePlayerTscn() {
    return `[gd_scene load_steps=5 format=3 uid="uid://player_runner_3d"]

[ext_resource type="Script" path="res://player_runner.gd" id="1_player_gd"]

[sub_resource type="CapsuleMesh" id="CapsuleMesh_Ship"]
radius = 0.6
height = 2.0

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Ship"]
albedo_color = Color(0.0, 0.8, 1.0, 1)
metallic = 0.9
roughness = 0.1
emission_enabled = true
emission = Color(0.0, 0.9, 1.0, 1)
emission_energy_multiplier = 0.8

[sub_resource type="CapsuleShape3D" id="CapsuleShape3D_Ship"]
radius = 0.6
height = 2.0

[node name="PlayerRunner" type="CharacterBody3D"]
script = ExtResource("1_player_gd")

[node name="MeshInstance3D" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, -4.37114e-08, 1, 0, -1, -4.37114e-08, 0, 0, 0)
mesh = SubResource("CapsuleMesh_Ship")
surface_material_override/0 = SubResource("StandardMaterial3D_Ship")

[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
transform = Transform3D(1, 0, 0, 0, -4.37114e-08, 1, 0, -1, -4.37114e-08, 0, 0, 0)
shape = SubResource("CapsuleShape3D_Ship")

[node name="ChaseCamera" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.9659, 0.2588, 0, -0.2588, 0.9659, 0, 3.2, 5.8)
fov = 68.0
current = true
`;
  },

  generatePlayerGd() {
    return `extends CharacterBody3D

@export var forward_speed: float = 48.0
@export var lateral_speed: float = 14.0
@export var jump_impulse: float = 12.0
var gravity: float = 24.0

func _physics_process(delta):
	velocity.z = -forward_speed
	var input_x = Input.get_axis("ui_left", "ui_right")
	velocity.x = input_x * lateral_speed
	
	if is_on_floor() and Input.is_action_just_pressed("ui_accept"):
		velocity.y = jump_impulse
	elif not is_on_floor():
		velocity.y -= gravity * delta
		
	move_and_slide()
`;
  }
};

// ==========================================
// 5B. Echoes of the Orbital Garden Generator
// ==========================================
const OrbitalGarden = {
  generateProjectGodot(name = 'Echoes of the Orbital Garden') {
    return `; Engine configuration file for Echoes of the Orbital Garden
config_version=5

[application]
config/name="${name}"
run/main_scene="res://orbital_sanctuary.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")

[display]
window/size/viewport_width=1280
window/size/viewport_height=720
window/stretch/mode="canvas_items"

[rendering]
renderer/rendering_method="gl_compatibility"
environment/defaults/default_clear_color=Color(0.02, 0.08, 0.06, 1.0)
`;
  },

  generateSanctuaryScene() {
    return `[gd_scene load_steps=8 format=3 uid="uid://orbital_sanctuary_3d"]

[ext_resource type="Script" path="res://orbital_sanctuary.gd" id="1_sanctuary"]
[ext_resource type="PackedScene" uid="uid://botanist_player_3d" path="res://botanist_player.tscn" id="2_player"]

[sub_resource type="ProceduralSkyMaterial" id="SkyMat_Orbital"]
sky_top_color = Color(0.05, 0.25, 0.2, 1)
sky_horizon_color = Color(0.2, 0.75, 0.55, 1)
ground_bottom_color = Color(0.02, 0.08, 0.05, 1)

[sub_resource type="Sky" id="Sky_Orbital"]
sky_material = SubResource("SkyMat_Orbital")

[sub_resource type="Environment" id="Env_Orbital"]
background_mode = 2
sky = SubResource("Sky_Orbital")
ambient_light_source = 3
ambient_light_color = Color(0.2, 0.6, 0.45, 1)
fog_enabled = true
fog_light_color = Color(0.15, 0.55, 0.4, 1)
fog_density = 0.0035

[sub_resource type="TorusMesh" id="Torus_Ring"]
inner_radius = 45.0
outer_radius = 65.0
rings = 48
ring_segments = 32

[sub_resource type="StandardMaterial3D" id="Mat_TerraformRing"]
albedo_color = Color(0.08, 0.35, 0.22, 1)
metallic = 0.4
roughness = 0.6
emission_enabled = true
emission = Color(0.0, 0.8, 0.5, 1)
emission_energy_multiplier = 0.35

[node name="OrbitalSanctuary" type="Node3D"]
script = ExtResource("1_sanctuary")

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Env_Orbital")

[node name="SunLight" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.707, -0.5, 0.5, 0, 0.707, 0.707, -0.707, -0.5, 0.5, 0, 40, 0)
light_color = Color(0.85, 1.0, 0.9, 1)
light_energy = 1.8

[node name="BiodomeRing" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, -4.37114e-08, 1, 0, -1, -4.37114e-08, 0, 0, 0)
mesh = SubResource("Torus_Ring")
surface_material_override/0 = SubResource("Mat_TerraformRing")

[node name="BotanistPlayer" parent="." instance=ExtResource("2_player")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1.5, 52)
`;
  },

  generateSanctuaryGd() {
    return `extends Node3D

var pollen_gathered: int = 0
var relics_awakened: int = 0
const TOTAL_RELICS: int = 8
const TOTAL_POLLEN: int = 12

func _ready():
	print("[Orbital Garden] Ecosystem initialized. 8 Flora Relics & 12 Solar Pollen nodes online.")

func _process(delta):
	var player = get_node_or_null("BotanistPlayer")
	if player:
		# Check sanctuary flora resonance
		pass
`;
  },

  generateBotanistTscn() {
    return `[gd_scene load_steps=5 format=3 uid="uid://botanist_player_3d"]

[ext_resource type="Script" path="res://botanist_player.gd" id="1_botanist"]

[sub_resource type="CylinderMesh" id="Cylinder_Botanist"]
top_radius = 0.4
bottom_radius = 0.5
height = 1.8

[sub_resource type="StandardMaterial3D" id="Mat_Botanist"]
albedo_color = Color(0.1, 0.9, 0.65, 1)
metallic = 0.7
roughness = 0.2
emission_enabled = true
emission = Color(0.2, 1.0, 0.7, 1)
emission_energy_multiplier = 0.6

[sub_resource type="CylinderShape3D" id="Shape_Botanist"]
top_radius = 0.4
bottom_radius = 0.5
height = 1.8

[node name="BotanistPlayer" type="CharacterBody3D"]
script = ExtResource("1_botanist")

[node name="MeshInstance3D" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.9, 0)
mesh = SubResource("Cylinder_Botanist")
surface_material_override/0 = SubResource("Mat_Botanist")

[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.9, 0)
shape = SubResource("Shape_Botanist")

[node name="OrbitalCamera" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.9396, 0.342, 0, -0.342, 0.9396, 0, 3.8, 6.2)
fov = 72.0
current = true
`;
  },

  generateBotanistGd() {
    return `extends CharacterBody3D

@export var move_speed: float = 18.0
@export var glide_speed: float = 28.0
@export var jump_impulse: float = 10.0
var gravity: float = 14.0
var is_gliding: bool = false

func _physics_process(delta):
	var input_dir = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	var dir = Vector3(input_dir.x, 0, input_dir.y).normalized()
	
	if dir:
		velocity.x = dir.x * (glide_speed if is_gliding else move_speed)
		velocity.z = dir.z * (glide_speed if is_gliding else move_speed)
	else:
		velocity.x = move_toward(velocity.x, 0, move_speed)
		velocity.z = move_toward(velocity.z, 0, move_speed)
		
	if is_on_floor() and Input.is_action_just_pressed("ui_accept"):
		velocity.y = jump_impulse
	elif not is_on_floor():
		if Input.is_action_pressed("ui_accept") and velocity.y < 0:
			is_gliding = true
			velocity.y = -2.5 # Gentle botanical glide
		else:
			is_gliding = false
			velocity.y -= gravity * delta
	else:
		is_gliding = false
		
	move_and_slide()
`;
  }
};

// A 2D starting point. The live mutator spoke only Node3D, so an agent asked for a 2D game
// had nowhere to begin - not because Godot cannot, but because nothing here did.
const Arcade2D = {
  generateProjectGodot(name = 'Arcade 2D') {
    return `; Engine configuration file for ${name}
config_version=5

[application]
config/name="${name}"
run/main_scene="res://main_2d.tscn"
config/features=PackedStringArray("4.7", "GL Compatibility")

[display]
window/size/viewport_width=1152
window/size/viewport_height=648
window/stretch/mode="canvas_items"

[rendering]
renderer/rendering_method="gl_compatibility"
environment/defaults/default_clear_color=Color(0.06, 0.07, 0.12, 1)
`;
  },

  generateMainScene() {
    return `[gd_scene load_steps=4 format=3 uid="uid://arcade_2d_main"]

[ext_resource type="Script" path="res://arcade_2d.gd" id="1_arcade"]
[ext_resource type="PackedScene" path="res://runner_2d.tscn" id="2_runner"]

[sub_resource type="RectangleShape2D" id="Shape_Ground"]
size = Vector2(1152, 64)

[node name="Arcade" type="Node2D"]
script = ExtResource("1_arcade")

[node name="Camera2D" type="Camera2D" parent="."]
position = Vector2(576, 324)

[node name="Ground" type="StaticBody2D" parent="."]
position = Vector2(576, 600)

[node name="GroundCollision" type="CollisionShape2D" parent="Ground"]
shape = SubResource("Shape_Ground")

[node name="GroundRect" type="ColorRect" parent="Ground"]
offset_left = -576.0
offset_top = -32.0
offset_right = 576.0
offset_bottom = 32.0
color = Color(0.16, 0.2, 0.3, 1)
mouse_filter = 2

[node name="Runner" parent="." instance=ExtResource("2_runner")]
position = Vector2(240, 400)
`;
  },

  generateMainGd() {
    return `extends Node2D
## Arcade 2D - a starting point for a side-on game.

var elapsed: float = 0.0

func _ready() -> void:
\tprint("[Arcade2D] ready; move the runner with the arrow keys, jump with space")

func _process(delta: float) -> void:
\telapsed += delta
`;
  },

  generateRunnerTscn() {
    return `[gd_scene load_steps=3 format=3 uid="uid://arcade_2d_runner"]

[ext_resource type="Script" path="res://runner_2d.gd" id="1_runner"]

[sub_resource type="RectangleShape2D" id="Shape_Runner"]
size = Vector2(44, 64)

[node name="Runner" type="CharacterBody2D"]
script = ExtResource("1_runner")

[node name="RunnerCollision" type="CollisionShape2D" parent="."]
shape = SubResource("Shape_Runner")

[node name="RunnerRect" type="ColorRect" parent="."]
offset_left = -22.0
offset_top = -32.0
offset_right = 22.0
offset_bottom = 32.0
color = Color(0.35, 0.9, 0.7, 1)
mouse_filter = 2
`;
  },

  generateRunnerGd() {
    return `extends CharacterBody2D

@export var move_speed: float = 320.0
@export var jump_velocity: float = -640.0
var gravity: float = 1400.0

func _physics_process(delta: float) -> void:
\tif not is_on_floor():
\t\tvelocity.y += gravity * delta
\tif Input.is_action_just_pressed("ui_accept") and is_on_floor():
\t\tvelocity.y = jump_velocity
\tvar direction := Input.get_axis("ui_left", "ui_right")
\tif direction != 0.0:
\t\tvelocity.x = direction * move_speed
\telse:
\t\tvelocity.x = move_toward(velocity.x, 0.0, move_speed)
\tmove_and_slide()
`;
  }
};

  window.GodotProjectTemplates = { NeonSkyrail: NeonSkyrail, OrbitalGarden: OrbitalGarden, Arcade2D: Arcade2D };
}());
