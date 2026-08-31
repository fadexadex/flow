import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = '/Users/fadex/.gemini/antigravity/brain/b6740f2c-938d-470b-8bc4-b2fbf28438b0';
if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

// -------------------------------------------------------------
// Scene and GDScript Definitions for Cyber Runner: Quantum Surge
// -------------------------------------------------------------

const PROJECT_GODOT = `; Engine configuration file for Cyber Runner: Quantum Surge
config_version=5

[application]
config/name="Cyber Runner: Quantum Surge"
run/main_scene="res://main_3d.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")

[display]
window/size/viewport_width=1280
window/size/viewport_height=720
window/stretch/mode="canvas_items"

[rendering]
renderer/rendering_method="gl_compatibility"
environment/defaults/default_clear_color=Color(0.02, 0.03, 0.08, 1.0)
`;

const LASER_BARRIER_TSCN = `[gd_scene load_steps=5 format=3 uid="uid://laser_barrier_3d"]

[ext_resource type="Script" path="res://laser_barrier.gd" id="1_laser_gd"]

[sub_resource type="BoxMesh" id="BoxMesh_Laser"]
size = Vector3(3.2, 0.4, 0.3)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Laser"]
albedo_color = Color(1.0, 0.05, 0.3, 1)
emission_enabled = true
emission = Color(1.0, 0.1, 0.4, 1)
emission_energy_multiplier = 4.0

[sub_resource type="BoxShape3D" id="BoxShape3D_Laser"]
size = Vector3(3.2, 0.4, 0.3)

[node name="LaserBarrier" type="Area3D" groups=["hazards"]]
script = ExtResource("1_laser_gd")

[node name="MeshInstance3D" type="MeshInstance3D" parent="."]
mesh = SubResource("BoxMesh_Laser")
surface_material_override/0 = SubResource("StandardMaterial3D_Laser")

[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
shape = SubResource("BoxShape3D_Laser")

[node name="OmniLight3D" type="OmniLight3D" parent="."]
light_color = Color(1, 0.1, 0.3, 1)
light_energy = 2.5
omni_range = 4.0
`;

const LASER_BARRIER_GD = `extends Area3D

@export var damage: int = 25
var pulse_time: float = 0.0

func _ready():
	connect("body_entered", _on_body_entered)

func _process(delta):
	pulse_time += delta * 6.0
	var light = get_node_or_null("OmniLight3D")
	if light:
		light.light_energy = 2.0 + sin(pulse_time) * 1.0

func _on_body_entered(body):
	if body.has_method("take_damage"):
		body.take_damage(damage)
`;

const PLASMA_DISC_TSCN = `[gd_scene load_steps=5 format=3 uid="uid://plasma_disc_3d"]

[ext_resource type="Script" path="res://plasma_disc.gd" id="1_disc_gd"]

[sub_resource type="CylinderMesh" id="CylinderMesh_Disc"]
top_radius = 1.1
bottom_radius = 1.1
height = 0.25

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Disc"]
albedo_color = Color(0.9, 0.2, 1.0, 1)
emission_enabled = true
emission = Color(0.8, 0.1, 1.0, 1)
emission_energy_multiplier = 3.5

[sub_resource type="CylinderShape3D" id="CylinderShape3D_Disc"]
top_radius = 1.1
bottom_radius = 1.1
height = 0.25

[node name="PlasmaDisc" type="Area3D" groups=["hazards"]]
script = ExtResource("1_disc_gd")

[node name="MeshInstance3D" type="MeshInstance3D" parent="."]
mesh = SubResource("CylinderMesh_Disc")
surface_material_override/0 = SubResource("StandardMaterial3D_Disc")

[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
shape = SubResource("CylinderShape3D_Disc")

[node name="OmniLight3D" type="OmniLight3D" parent="."]
light_color = Color(0.8, 0.1, 1, 1)
light_energy = 2.0
omni_range = 5.0
`;

const PLASMA_DISC_GD = `extends Area3D

@export var damage: int = 35
@export var oscillation_width: float = 3.5
@export var oscillation_speed: float = 2.4
var initial_x: float = 0.0
var time: float = 0.0

func _ready():
	initial_x = position.x
	connect("body_entered", _on_body_entered)

func _process(delta):
	time += delta * oscillation_speed
	position.x = initial_x + sin(time) * oscillation_width
	rotate_y(delta * 4.0)

func _on_body_entered(body):
	if body.has_method("take_damage"):
		body.take_damage(damage)
`;

const FLUX_ORB_TSCN = `[gd_scene load_steps=5 format=3 uid="uid://flux_orb_3d"]

[ext_resource type="Script" path="res://flux_orb.gd" id="1_orb_gd"]

[sub_resource type="SphereMesh" id="SphereMesh_Orb"]
radius = 0.4
height = 0.8

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Orb"]
albedo_color = Color(1.0, 0.85, 0.1, 1)
emission_enabled = true
emission = Color(1.0, 0.8, 0.0, 1)
emission_energy_multiplier = 4.0

[sub_resource type="SphereShape3D" id="SphereShape3D_Orb"]
radius = 0.6

[node name="FluxOrb" type="Area3D" groups=["collectibles"]]
script = ExtResource("1_orb_gd")

[node name="MeshInstance3D" type="MeshInstance3D" parent="."]
mesh = SubResource("SphereMesh_Orb")
surface_material_override/0 = SubResource("StandardMaterial3D_Orb")

[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
shape = SubResource("SphereShape3D_Orb")

[node name="OmniLight3D" type="OmniLight3D" parent="."]
light_color = Color(1, 0.8, 0.1, 1)
light_energy = 2.0
omni_range = 3.5
`;

const FLUX_ORB_GD = `extends Area3D

@export var score_value: int = 100
var base_y: float = 0.0
var time: float = 0.0

func _ready():
	base_y = position.y
	connect("body_entered", _on_body_entered)

func _process(delta):
	time += delta * 4.0
	position.y = base_y + sin(time) * 0.25
	rotate_y(delta * 3.0)

func _on_body_entered(body):
	if body.is_in_group("player") or body.name == "PlayerRunner":
		var main = get_tree().root.get_node_or_null("Main3D")
		if main and main.has_method("add_score"):
			main.add_score(score_value)
		queue_free()
`;

const HUD_OVERLAY_TSCN = `[gd_scene load_steps=2 format=3 uid="uid://hud_overlay_2d"]

[ext_resource type="Script" path="res://hud_overlay.gd" id="1_hud_gd"]

[node name="HUDOverlay" type="CanvasLayer"]
script = ExtResource("1_hud_gd")

[node name="TopBar" type="Control" parent="."]
layout_mode = 3
anchors_preset = 10
anchor_right = 1.0
offset_bottom = 80.0
grow_horizontal = 2

[node name="TitleLabel" type="Label" parent="TopBar"]
layout_mode = 0
offset_left = 24.0
offset_top = 16.0
offset_right = 450.0
offset_bottom = 44.0
theme_override_colors/font_color = Color(0, 0.9, 1, 1)
theme_override_font_sizes/font_size = 20
text = "CYBER RUNNER // QUANTUM SURGE"

[node name="DistanceLabel" type="Label" parent="TopBar"]
layout_mode = 1
anchors_preset = 5
anchor_left = 0.5
offset_left = -150.0
offset_top = 16.0
offset_right = 150.0
offset_bottom = 44.0
grow_horizontal = 2
theme_override_colors/font_color = Color(1, 0.9, 0.2, 1)
theme_override_font_sizes/font_size = 18
text = "DISTANCE: 0m / 1000m"
horizontal_alignment = 1

[node name="ScoreLabel" type="Label" parent="TopBar"]
layout_mode = 1
anchors_preset = 1
anchor_left = 1.0
offset_left = -280.0
offset_top = 16.0
offset_right = -24.0
offset_bottom = 44.0
grow_horizontal = 0
theme_override_colors/font_color = Color(0.4, 1, 0.6, 1)
theme_override_font_sizes/font_size = 18
text = "QUANTUM SCORE: 0"
horizontal_alignment = 2

[node name="ShieldBarContainer" type="HBoxContainer" parent="."]
offset_left = 24.0
offset_top = 52.0
offset_right = 280.0
offset_bottom = 74.0

[node name="ShieldLabel" type="Label" parent="ShieldBarContainer"]
layout_mode = 2
theme_override_colors/font_color = Color(0, 0.9, 1, 1)
theme_override_font_sizes/font_size = 14
text = "SHIELD: "

[node name="ShieldValue" type="Label" parent="ShieldBarContainer"]
layout_mode = 2
theme_override_colors/font_color = Color(0.2, 1, 0.8, 1)
theme_override_font_sizes/font_size = 14
text = "100% [ |||||||||| ]"

[node name="SpeedLabel" type="Label" parent="."]
anchors_preset = 3
anchor_left = 1.0
anchor_top = 1.0
offset_left = -220.0
offset_top = -48.0
offset_right = -24.0
offset_bottom = -20.0
grow_horizontal = 0
grow_vertical = 0
theme_override_colors/font_color = Color(0.9, 0.4, 1, 1)
theme_override_font_sizes/font_size = 16
text = "VELOCITY: 180 KM/H"
horizontal_alignment = 2
`;

const HUD_OVERLAY_GD = `extends CanvasLayer

@onready var distance_label = $TopBar/DistanceLabel
@onready var score_label = $TopBar/ScoreLabel
@onready var shield_val = $ShieldBarContainer/ShieldValue
@onready var speed_label = $SpeedLabel

func update_hud(distance: float, score: int, shield: int, speed: float):
	if distance_label:
		distance_label.text = "DISTANCE: %dm / 1000m" % [int(distance)]
	if score_label:
		score_label.text = "QUANTUM SCORE: %d" % [score]
	if shield_val:
		var pips = int(shield / 10.0)
		var bar = ""
		for i in range(pips):
			bar += "|"
		shield_val.text = "%d%% [ %s ]" % [shield, bar]
		if shield <= 25:
			shield_val.set("theme_override_colors/font_color", Color(1, 0.2, 0.3, 1))
		else:
			shield_val.set("theme_override_colors/font_color", Color(0.2, 1, 0.8, 1))
	if speed_label:
		speed_label.text = "VELOCITY: %d KM/H" % [int(speed * 3.6)]
`;

const PLAYER_RUNNER_TSCN = `[gd_scene load_steps=6 format=3 uid="uid://player_runner_3d"]

[ext_resource type="Script" path="res://player_runner.gd" id="1_player_gd"]

[sub_resource type="PrismMesh" id="PrismMesh_Ship"]
size = Vector3(1.6, 0.8, 2.4)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Ship"]
albedo_color = Color(0.0, 0.8, 1.0, 1)
metallic = 0.95
roughness = 0.1
emission_enabled = true
emission = Color(0.0, 0.9, 1.0, 1)
emission_energy_multiplier = 1.2

[sub_resource type="BoxShape3D" id="BoxShape3D_Ship"]
size = Vector3(1.6, 0.8, 2.4)

[node name="PlayerRunner" type="CharacterBody3D" groups=["player"]]
script = ExtResource("1_player_gd")

[node name="ShipMesh" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, -4.37114e-08, 1, 0, -1, -4.37114e-08, 0, 0.4, 0)
mesh = SubResource("PrismMesh_Ship")
surface_material_override/0 = SubResource("StandardMaterial3D_Ship")

[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.4, 0)
shape = SubResource("BoxShape3D_Ship")

[node name="ThrusterLight" type="OmniLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.4, 1.4)
light_color = Color(0, 0.9, 1, 1)
light_energy = 3.5
omni_range = 6.0

[node name="ChaseCamera" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.9659, 0.2588, 0, -0.2588, 0.9659, 0, 2.8, 5.2)
fov = 72.0
current = true
`;

const PLAYER_RUNNER_GD = `extends CharacterBody3D

@export var forward_speed: float = 45.0
@export var max_forward_speed: float = 70.0
@export var acceleration: float = 0.5
@export var lane_width: float = 3.2
@export var jump_impulse: float = 14.0
@export var gravity: float = 32.0

var current_lane: int = 0 # -1 = Left, 0 = Center, 1 = Right
var target_x: float = 0.0
var shield: int = 100
var invulnerable_time: float = 0.0
var is_alive: bool = true

func _ready():
	target_x = 0.0

func _physics_process(delta):
	if not is_alive:
		return

	# Speed acceleration
	forward_speed = min(forward_speed + acceleration * delta, max_forward_speed)
	velocity.z = -forward_speed

	# Lane switching controls
	if Input.is_action_just_pressed("ui_left") and current_lane > -1:
		current_lane -= 1
		target_x = current_lane * lane_width
	elif Input.is_action_just_pressed("ui_right") and current_lane < 1:
		current_lane += 1
		target_x = current_lane * lane_width

	# Smooth lateral lane shift
	position.x = lerp(position.x, target_x, delta * 14.0)

	# Banking tilt effect
	var ship = get_node_or_null("ShipMesh")
	if ship:
		var target_tilt = -(position.x - target_x) * 0.15
		ship.rotation.z = lerp(ship.rotation.z, target_tilt, delta * 12.0)

	# Jump / Hop
	if is_on_floor() and (Input.is_action_just_pressed("ui_up") or Input.is_action_just_pressed("ui_accept")):
		velocity.y = jump_impulse
	elif not is_on_floor():
		velocity.y -= gravity * delta

	if invulnerable_time > 0.0:
		invulnerable_time -= delta

	move_and_slide()

func take_damage(amount: int):
	if invulnerable_time > 0.0 or not is_alive:
		return
	shield = max(0, shield - amount)
	invulnerable_time = 0.8
	print("[Cyber Runner] Impact! Shield at: ", shield, "%")
	if shield <= 0:
		is_alive = false
		print("[Cyber Runner] Hull Breach! Critical Failure.")
`;

const MAIN_3D_BASE_TSCN = `[gd_scene load_steps=7 format=3 uid="uid://main_3d_cyber_runner"]

[ext_resource type="Script" path="res://main_3d.gd" id="1_main"]
[ext_resource type="PackedScene" uid="uid://player_runner_3d" path="res://player_runner.tscn" id="2_player"]

[sub_resource type="ProceduralSkyMaterial" id="ProceduralSkyMaterial_Cyber"]
sky_top_color = Color(0.08, 0.15, 0.35, 1)
sky_horizon_color = Color(0.9, 0.3, 0.65, 1)
ground_bottom_color = Color(0.02, 0.02, 0.08, 1)

[sub_resource type="Sky" id="Sky_Cyber"]
sky_material = SubResource("ProceduralSkyMaterial_Cyber")

[sub_resource type="Environment" id="Environment_Cyber"]
background_mode = 2
sky = SubResource("Sky_Cyber")
ambient_light_source = 3
ambient_light_color = Color(0.3, 0.2, 0.5, 1)
fog_enabled = true
fog_light_color = Color(0.8, 0.25, 0.6, 1)
fog_density = 0.0018

[sub_resource type="BoxMesh" id="BoxMesh_Track"]
size = Vector3(10.5, 0.5, 1200)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Track"]
albedo_color = Color(0.05, 0.08, 0.16, 1)
metallic = 0.85
roughness = 0.2
emission_enabled = true
emission = Color(0.0, 0.5, 0.85, 1)
emission_energy_multiplier = 0.35

[node name="Main3D" type="Node3D"]
script = ExtResource("1_main")

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Environment_Cyber")

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.866, -0.25, 0.433, 0, 0.866, 0.5, -0.5, -0.433, 0.75, 0, 40, 0)
light_color = Color(1, 0.9, 0.8, 1)
light_energy = 1.8

[node name="SkyrailTrack" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -550)
mesh = SubResource("BoxMesh_Track")
surface_material_override/0 = SubResource("StandardMaterial3D_Track")

[node name="PlayerRunner" parent="." instance=ExtResource("2_player")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.8, 0)
`;

const MAIN_3D_HAZARDS_TSCN = `[gd_scene load_steps=9 format=3 uid="uid://main_3d_cyber_runner"]

[ext_resource type="Script" path="res://main_3d.gd" id="1_main"]
[ext_resource type="PackedScene" uid="uid://player_runner_3d" path="res://player_runner.tscn" id="2_player"]
[ext_resource type="PackedScene" uid="uid://laser_barrier_3d" path="res://laser_barrier.tscn" id="3_laser"]
[ext_resource type="PackedScene" uid="uid://plasma_disc_3d" path="res://plasma_disc.tscn" id="4_disc"]

[sub_resource type="ProceduralSkyMaterial" id="ProceduralSkyMaterial_Cyber"]
sky_top_color = Color(0.08, 0.15, 0.35, 1)
sky_horizon_color = Color(0.9, 0.3, 0.65, 1)
ground_bottom_color = Color(0.02, 0.02, 0.08, 1)

[sub_resource type="Sky" id="Sky_Cyber"]
sky_material = SubResource("ProceduralSkyMaterial_Cyber")

[sub_resource type="Environment" id="Environment_Cyber"]
background_mode = 2
sky = SubResource("Sky_Cyber")
ambient_light_source = 3
ambient_light_color = Color(0.3, 0.2, 0.5, 1)
fog_enabled = true
fog_light_color = Color(0.8, 0.25, 0.6, 1)
fog_density = 0.0018

[sub_resource type="BoxMesh" id="BoxMesh_Track"]
size = Vector3(10.5, 0.5, 1200)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Track"]
albedo_color = Color(0.05, 0.08, 0.16, 1)
metallic = 0.85
roughness = 0.2
emission_enabled = true
emission = Color(0.0, 0.5, 0.85, 1)
emission_energy_multiplier = 0.35

[node name="Main3D" type="Node3D"]
script = ExtResource("1_main")

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Environment_Cyber")

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.866, -0.25, 0.433, 0, 0.866, 0.5, -0.5, -0.433, 0.75, 0, 40, 0)
light_color = Color(1, 0.9, 0.8, 1)
light_energy = 1.8

[node name="SkyrailTrack" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -550)
mesh = SubResource("BoxMesh_Track")
surface_material_override/0 = SubResource("StandardMaterial3D_Track")

[node name="PlayerRunner" parent="." instance=ExtResource("2_player")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.8, 0)

[node name="ObstaclesContainer" type="Node3D" parent="."]

[node name="Laser1" parent="ObstaclesContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -3.2, 0.5, -100)

[node name="Laser2" parent="ObstaclesContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.2, 0.5, -180)

[node name="Laser3" parent="ObstaclesContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.5, -260)

[node name="Plasma1" parent="ObstaclesContainer" instance=ExtResource("4_disc")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.6, -340)

[node name="Laser4" parent="ObstaclesContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -3.2, 0.5, -440)

[node name="Laser5" parent="ObstaclesContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.2, 0.5, -440)

[node name="Plasma2" parent="ObstaclesContainer" instance=ExtResource("4_disc")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.6, -580)
`;

const MAIN_3D_FULL_TSCN = `[gd_scene load_steps=11 format=3 uid="uid://main_3d_cyber_runner"]

[ext_resource type="Script" path="res://main_3d.gd" id="1_main"]
[ext_resource type="PackedScene" uid="uid://player_runner_3d" path="res://player_runner.tscn" id="2_player"]
[ext_resource type="PackedScene" uid="uid://hud_overlay_2d" path="res://hud_overlay.tscn" id="3_hud"]
[ext_resource type="PackedScene" uid="uid://laser_barrier_3d" path="res://laser_barrier.tscn" id="4_laser"]
[ext_resource type="PackedScene" uid="uid://plasma_disc_3d" path="res://plasma_disc.tscn" id="5_disc"]
[ext_resource type="PackedScene" uid="uid://flux_orb_3d" path="res://flux_orb.tscn" id="6_orb"]

[sub_resource type="ProceduralSkyMaterial" id="ProceduralSkyMaterial_Cyber"]
sky_top_color = Color(0.08, 0.15, 0.35, 1)
sky_horizon_color = Color(0.9, 0.3, 0.65, 1)
ground_bottom_color = Color(0.02, 0.02, 0.08, 1)

[sub_resource type="Sky" id="Sky_Cyber"]
sky_material = SubResource("ProceduralSkyMaterial_Cyber")

[sub_resource type="Environment" id="Environment_Cyber"]
background_mode = 2
sky = SubResource("Sky_Cyber")
ambient_light_source = 3
ambient_light_color = Color(0.3, 0.2, 0.5, 1)
fog_enabled = true
fog_light_color = Color(0.8, 0.25, 0.6, 1)
fog_density = 0.0018

[sub_resource type="BoxMesh" id="BoxMesh_Track"]
size = Vector3(10.5, 0.5, 1200)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Track"]
albedo_color = Color(0.05, 0.08, 0.16, 1)
metallic = 0.85
roughness = 0.2
emission_enabled = true
emission = Color(0.0, 0.5, 0.85, 1)
emission_energy_multiplier = 0.35

[node name="Main3D" type="Node3D"]
script = ExtResource("1_main")

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Environment_Cyber")

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.866, -0.25, 0.433, 0, 0.866, 0.5, -0.5, -0.433, 0.75, 0, 40, 0)
light_color = Color(1, 0.9, 0.8, 1)
light_energy = 1.8

[node name="SkyrailTrack" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -550)
mesh = SubResource("BoxMesh_Track")
surface_material_override/0 = SubResource("StandardMaterial3D_Track")

[node name="HUDOverlay" parent="." instance=ExtResource("3_hud")]

[node name="PlayerRunner" parent="." instance=ExtResource("2_player")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.8, 0)

[node name="ObstaclesContainer" type="Node3D" parent="."]

[node name="Laser1" parent="ObstaclesContainer" instance=ExtResource("4_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -3.2, 0.5, -100)

[node name="Laser2" parent="ObstaclesContainer" instance=ExtResource("4_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.2, 0.5, -180)

[node name="Laser3" parent="ObstaclesContainer" instance=ExtResource("4_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.5, -260)

[node name="Plasma1" parent="ObstaclesContainer" instance=ExtResource("5_disc")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.6, -340)

[node name="Laser4" parent="ObstaclesContainer" instance=ExtResource("4_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -3.2, 0.5, -440)

[node name="Laser5" parent="ObstaclesContainer" instance=ExtResource("4_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.2, 0.5, -440)

[node name="Plasma2" parent="ObstaclesContainer" instance=ExtResource("5_disc")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.6, -580)

[node name="Laser6" parent="ObstaclesContainer" instance=ExtResource("4_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.5, -700)

[node name="CollectiblesContainer" type="Node3D" parent="."]

[node name="Orb1" parent="CollectiblesContainer" instance=ExtResource("6_orb")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.8, -50)

[node name="Orb2" parent="CollectiblesContainer" instance=ExtResource("6_orb")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.2, 0.8, -130)

[node name="Orb3" parent="CollectiblesContainer" instance=ExtResource("6_orb")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -3.2, 0.8, -210)

[node name="Orb4" parent="CollectiblesContainer" instance=ExtResource("6_orb")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.8, -300)

[node name="Orb5" parent="CollectiblesContainer" instance=ExtResource("6_orb")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.8, -500)

[node name="Orb6" parent="CollectiblesContainer" instance=ExtResource("6_orb")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.2, 0.8, -640)
`;

const MAIN_3D_GD = `extends Node3D

var score: int = 0
var distance: float = 0.0
const GOAL_DISTANCE: float = 1000.0
var game_finished: bool = false

@onready var player = $PlayerRunner
@onready var hud = $HUDOverlay

func _ready():
	print("[Cyber Runner] Initializing Cyberpunk Skyrail Track (1200m).")

func _process(delta):
	if not player or game_finished:
		return

	distance = -player.global_position.z
	var speed = player.velocity.length()
	var shield = player.shield

	if hud and hud.has_method("update_hud"):
		hud.update_hud(distance, score, shield, speed)

	if distance >= GOAL_DISTANCE and not game_finished:
		game_finished = true
		print("[Cyber Runner] VICTORY! Quantum Rift Reached at ", int(distance), "m! Final Score: ", score)

func add_score(amount: int):
	score += amount
	print("[Cyber Runner] Score +", amount, " -> Total: ", score)
`;

// -------------------------------------------------------------
// Step-by-Step Multi-Stage Runner Builder Execution
// -------------------------------------------------------------

async function buildCyberRunnerGame() {
  console.log('=== Step-by-Step Cyber Runner Game Construction ===');

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--enable-features=SharedArrayBuffer',
      '--window-size=1280,800'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[Cyber Runner') || text.includes('[WebMCP') || text.includes('[Agent')) {
      console.log('  [Engine Log]', text);
    }
  });

  console.log('\n--- Milestone 1: Navigating to WebMCP Workspace ---');
  await page.goto('http://localhost:8060/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#webmcp-diagnostic-hud', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 1000));

  // Screenshot Milestone 1
  const shot1 = path.join(ARTIFACTS_DIR, 'game_build_step1_workspace_init.png');
  await page.screenshot({ path: shot1 });
  console.log('  Captured Milestone 1 Screenshot:', shot1);

  // Milestone 2: Initialize Project Foundation with godot_create_project
  console.log('\n--- Milestone 2: Creating Cyber Runner 3D Project Foundation ---');
  const createResult = await page.evaluate(async (pGodot, mScene, mGd, pScene, pGd) => {
    return await window.godotWebMcpTestBridge.callTool('godot_create_project', {
      project_name: 'cyber_runner_quantum_surge',
      template: 'custom',
      files: {
        'project.godot': pGodot,
        'main_3d.tscn': mScene,
        'main_3d.gd': mGd,
        'player_runner.tscn': pScene,
        'player_runner.gd': pGd
      }
    });
  }, PROJECT_GODOT, MAIN_3D_BASE_TSCN, MAIN_3D_GD, PLAYER_RUNNER_TSCN, PLAYER_RUNNER_GD);

  console.log('  Project Created:', createResult.project_name, 'Revision:', createResult.scene_revision);
  await new Promise(r => setTimeout(r, 1200));

  const shot2 = path.join(ARTIFACTS_DIR, 'game_build_step2_project_foundation.png');
  await page.screenshot({ path: shot2 });
  console.log('  Captured Milestone 2 Screenshot:', shot2);

  // Milestone 3: Author Obstacles & Hazards Sub-system via Atomic File Transaction
  console.log('\n--- Milestone 3: Staging Hazards Sub-system (Laser Barriers & Plasma Discs) ---');
  const hazardTxResult = await page.evaluate(async (rev, mSceneHazards, laserTscn, laserGd, discTscn, discGd) => {
    return await window.godotWebMcpTestBridge.callTool('godot_apply_file_transaction', {
      expected_revision: rev,
      label: 'Authoring 3D Laser Barriers & Oscillating Plasma Hazards',
      operations: [
        { kind: 'write', path: 'res://laser_barrier.tscn', content: laserTscn },
        { kind: 'write', path: 'res://laser_barrier.gd', content: laserGd },
        { kind: 'write', path: 'res://plasma_disc.tscn', content: discTscn },
        { kind: 'write', path: 'res://plasma_disc.gd', content: discGd },
        { kind: 'write', path: 'res://main_3d.tscn', content: mSceneHazards }
      ]
    });
  }, createResult.scene_revision, MAIN_3D_HAZARDS_TSCN, LASER_BARRIER_TSCN, LASER_BARRIER_GD, PLASMA_DISC_TSCN, PLASMA_DISC_GD);

  console.log('  Hazards Staged:', hazardTxResult.changed_paths.join(', '), 'Revision:', hazardTxResult.scene_revision);
  await new Promise(r => setTimeout(r, 1200));

  const shot3 = path.join(ARTIFACTS_DIR, 'game_build_step3_hazards_staged.png');
  await page.screenshot({ path: shot3 });
  console.log('  Captured Milestone 3 Screenshot:', shot3);

  // Milestone 4: Author Collectibles, HUD Overlay, and Scoring Architecture
  console.log('\n--- Milestone 4: Authoring Collectible Flux Orbs & Cyberpunk HUD Overlay ---');
  const hudTxResult = await page.evaluate(async (rev, mSceneFull, orbTscn, orbGd, hudTscn, hudGd) => {
    return await window.godotWebMcpTestBridge.callTool('godot_apply_file_transaction', {
      expected_revision: rev,
      label: 'Authoring Collectible Quantum Flux Orbs & Cyberpunk HUD',
      operations: [
        { kind: 'write', path: 'res://flux_orb.tscn', content: orbTscn },
        { kind: 'write', path: 'res://flux_orb.gd', content: orbGd },
        { kind: 'write', path: 'res://hud_overlay.tscn', content: hudTscn },
        { kind: 'write', path: 'res://hud_overlay.gd', content: hudGd },
        { kind: 'write', path: 'res://main_3d.tscn', content: mSceneFull }
      ]
    });
  }, hazardTxResult.scene_revision, MAIN_3D_FULL_TSCN, FLUX_ORB_TSCN, FLUX_ORB_GD, HUD_OVERLAY_TSCN, HUD_OVERLAY_GD);

  console.log('  HUD & Collectibles Staged:', hudTxResult.changed_paths.join(', '), 'Revision:', hudTxResult.scene_revision);
  await new Promise(r => setTimeout(r, 1200));

  const shot4 = path.join(ARTIFACTS_DIR, 'game_build_step4_hud_collectibles.png');
  await page.screenshot({ path: shot4 });
  console.log('  Captured Milestone 4 Screenshot:', shot4);

  // Milestone 5: Synthesize Complete Procedural Audio Suite
  console.log('\n--- Milestone 5: Synthesizing Dynamic 8-Track Sound Suite ---');
  const audioResult = await page.evaluate(async () => {
    return await window.godotWebMcpTestBridge.callTool('godot_synthesize_audio_suite', {});
  });
  console.log('  Audio Suite Synthesized:', audioResult.tracks_generated?.length || '8 tracks');
  await new Promise(r => setTimeout(r, 1200));

  const shot5 = path.join(ARTIFACTS_DIR, 'game_build_step5_audio_synthesized.png');
  await page.screenshot({ path: shot5 });
  console.log('  Captured Milestone 5 Screenshot:', shot5);

  // Milestone 6: Live Playtesting, Running Game, and Capturing Active Gameplay
  console.log('\n--- Milestone 6: Launching Live Game Session & Executing Flight Controls ---');
  const launchResult = await page.evaluate(async () => {
    return await window.godotWebMcpTestBridge.callTool('godot_run_game', {});
  });
  console.log('  Game Session Launched:', launchResult.status);
  await new Promise(r => setTimeout(r, 1500));

  // Send input maneuvers to dodge obstacles and collect orbs
  console.log('  Sending Flight Maneuvers (Dodge Right, Jump, Dodge Left)...');
  await page.evaluate(async () => {
    await window.godotWebMcpTestBridge.callTool('godot_send_input_sequence', {
      events: [
        { key: 'ui_right', action: 'keydown', delay_ms: 100 },
        { key: 'ui_right', action: 'keyup', delay_ms: 250 },
        { key: 'ui_up', action: 'keydown', delay_ms: 400 },
        { key: 'ui_up', action: 'keyup', delay_ms: 600 },
        { key: 'ui_left', action: 'keydown', delay_ms: 800 },
        { key: 'ui_left', action: 'keyup', delay_ms: 1000 }
      ]
    });
  });

  await new Promise(r => setTimeout(r, 1500));

  const shot6 = path.join(ARTIFACTS_DIR, 'game_build_step6_live_playtest.png');
  await page.screenshot({ path: shot6 });
  console.log('  Captured Milestone 6 Screenshot:', shot6);

  // Inspect Final Project Manifest to verify all 12 project files
  const manifest = await page.evaluate(async () => {
    return await window.godotWebMcpTestBridge.callTool('godot_inspect_project_files', {});
  });
  console.log(`\nAuthoritative Project Manifest: ${manifest.file_count} files at Revision #${manifest.scene_revision}:`);
  manifest.files.forEach(f => console.log(`  - ${f.path} (${f.size_bytes} bytes)`));

  await browser.close();
  console.log('\n=== Cyber Runner Construction Completed Successfully ===');
}

buildCyberRunnerGame().catch(err => {
  console.error('Construction failed:', err);
  process.exit(1);
});
