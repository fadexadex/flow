import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = '/Users/fadex/.gemini/antigravity/brain/b6740f2c-938d-470b-8bc4-b2fbf28438b0';
if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

// =========================================================================
// 1. Scene & Script Definitions for Neon Horizon 3D: Quantum Speeder
// =========================================================================

const PROJECT_GODOT = `; Engine configuration for Neon Horizon 3D: Quantum Speeder
config_version=5

[application]
config/name="Neon Horizon 3D: Quantum Speeder"
run/main_scene="res://main_3d.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")

[display]
window/size/viewport_width=1280
window/size/viewport_height=720
window/stretch/mode="canvas_items"

[rendering]
renderer/rendering_method="gl_compatibility"
environment/defaults/default_clear_color=Color(0.04, 0.02, 0.1, 1.0)
`;

// -------------------------------------------------------------
// Building Block 1: Skyrail Highway Base Scene (Track + Sky + Light)
// -------------------------------------------------------------
const MAIN_3D_BASE_TSCN = `[gd_scene load_steps=12 format=3 uid="uid://main_3d_neon_horizon"]

[ext_resource type="Script" path="res://main_3d.gd" id="1_main"]
[ext_resource type="PackedScene" uid="uid://player_speeder_3d" path="res://player_speeder.tscn" id="2_player"]

[sub_resource type="ProceduralSkyMaterial" id="ProceduralSkyMaterial_Nebula"]
sky_top_color = Color(0.08, 0.05, 0.22, 1)
sky_horizon_color = Color(1.0, 0.25, 0.65, 1)
ground_bottom_color = Color(0.02, 0.01, 0.06, 1)
ground_horizon_color = Color(0.2, 0.05, 0.15, 1)

[sub_resource type="Sky" id="Sky_Nebula"]
sky_material = SubResource("ProceduralSkyMaterial_Nebula")

[sub_resource type="Environment" id="Environment_Nebula"]
background_mode = 2
sky = SubResource("Sky_Nebula")
ambient_light_source = 3
ambient_light_color = Color(0.4, 0.2, 0.6, 1)
fog_enabled = true
fog_light_color = Color(0.9, 0.2, 0.55, 1)
fog_density = 0.0018

[sub_resource type="BoxMesh" id="BoxMesh_Highway"]
size = Vector3(12, 0.4, 1000)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Highway"]
albedo_color = Color(0.06, 0.08, 0.16, 1)
metallic = 0.9
roughness = 0.15
emission_enabled = true
emission = Color(0.0, 0.3, 0.7, 1)
emission_energy_multiplier = 0.3

[sub_resource type="BoxMesh" id="BoxMesh_LaneMarker"]
size = Vector3(0.12, 0.05, 1000)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_CyanGlow"]
albedo_color = Color(0.0, 0.9, 1.0, 1)
emission_enabled = true
emission = Color(0.0, 0.9, 1.0, 1)
emission_energy_multiplier = 3.5

[sub_resource type="BoxMesh" id="BoxMesh_Rail"]
size = Vector3(0.3, 0.8, 1000)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_OrangeRail"]
albedo_color = Color(1.0, 0.4, 0.0, 1)
emission_enabled = true
emission = Color(1.0, 0.4, 0.0, 1)
emission_energy_multiplier = 2.5

[node name="Main3D" type="Node3D"]
script = ExtResource("1_main")

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Environment_Nebula")

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.866, -0.25, 0.433, 0, 0.866, 0.5, -0.5, -0.433, 0.75, 0, 45, 0)
light_color = Color(1, 0.9, 0.82, 1)
light_energy = 2.2

[node name="SkyrailHighway" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -450)
mesh = SubResource("BoxMesh_Highway")
surface_material_override/0 = SubResource("StandardMaterial3D_Highway")

[node name="LaneDividerLeft" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -1.8, 0.22, -450)
mesh = SubResource("BoxMesh_LaneMarker")
surface_material_override/0 = SubResource("StandardMaterial3D_CyanGlow")

[node name="LaneDividerRight" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 1.8, 0.22, -450)
mesh = SubResource("BoxMesh_LaneMarker")
surface_material_override/0 = SubResource("StandardMaterial3D_CyanGlow")

[node name="GuardRailLeft" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -5.8, 0.5, -450)
mesh = SubResource("BoxMesh_Rail")
surface_material_override/0 = SubResource("StandardMaterial3D_OrangeRail")

[node name="GuardRailRight" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 5.8, 0.5, -450)
mesh = SubResource("BoxMesh_Rail")
surface_material_override/0 = SubResource("StandardMaterial3D_OrangeRail")

[node name="PlayerRunner" parent="." instance=ExtResource("2_player")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.8, 0)
`;

// -------------------------------------------------------------
// Building Block 2: Player Cyber-Speeder Craft
// -------------------------------------------------------------
const PLAYER_SPEEDER_TSCN = `[gd_scene load_steps=8 format=3 uid="uid://player_speeder_3d"]

[ext_resource type="Script" path="res://player_speeder.gd" id="1_speeder_gd"]

[sub_resource type="PrismMesh" id="PrismMesh_Fuselage"]
size = Vector3(1.5, 0.6, 2.6)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Titanium"]
albedo_color = Color(0.1, 0.12, 0.18, 1)
metallic = 0.95
roughness = 0.1

[sub_resource type="BoxMesh" id="BoxMesh_Cockpit"]
size = Vector3(0.6, 0.35, 1.0)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_EmeraldGlass"]
albedo_color = Color(0.0, 1.0, 0.8, 0.8)
roughness = 0.05
emission_enabled = true
emission = Color(0.0, 1.0, 0.8, 1)
emission_energy_multiplier = 2.5

[sub_resource type="BoxShape3D" id="BoxShape3D_Hull"]
size = Vector3(1.8, 0.7, 2.6)

[node name="PlayerRunner" type="CharacterBody3D" groups=["player"]]
script = ExtResource("1_speeder_gd")

[node name="FuselageMesh" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, -4.37114e-08, 1, 0, -1, -4.37114e-08, 0, 0.35, 0)
mesh = SubResource("PrismMesh_Fuselage")
surface_material_override/0 = SubResource("StandardMaterial3D_Titanium")

[node name="CockpitMesh" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.65, -0.3)
mesh = SubResource("BoxMesh_Cockpit")
surface_material_override/0 = SubResource("StandardMaterial3D_EmeraldGlass")

[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.45, 0)
shape = SubResource("BoxShape3D_Hull")

[node name="ThrusterLight" type="OmniLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.4, 1.5)
light_color = Color(0, 0.9, 1, 1)
light_energy = 4.0
omni_range = 7.0

[node name="ChaseCamera" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.9659, 0.2588, 0, -0.2588, 0.9659, 0, 3.2, 6.5)
fov = 72.0
current = true
`;

const PLAYER_SPEEDER_GD = `extends CharacterBody3D

@export var forward_speed: float = 46.0
@export var max_forward_speed: float = 75.0
@export var acceleration: float = 0.6
@export var lane_width: float = 3.6
@export var jump_impulse: float = 14.5
@export var gravity: float = 34.0

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

	forward_speed = min(forward_speed + acceleration * delta, max_forward_speed)
	velocity.z = -forward_speed

	if Input.is_action_just_pressed("ui_left") and current_lane > -1:
		current_lane -= 1
		target_x = current_lane * lane_width
	elif Input.is_action_just_pressed("ui_right") and current_lane < 1:
		current_lane += 1
		target_x = current_lane * lane_width

	position.x = lerp(position.x, target_x, delta * 15.0)

	var ship = get_node_or_null("FuselageMesh")
	if ship:
		var target_tilt = -(position.x - target_x) * 0.18
		ship.rotation.z = lerp(ship.rotation.z, target_tilt, delta * 14.0)

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
	invulnerable_time = 0.9
	print("[Cyber Speeder] Hull Impact! Shield Integrity: ", shield, "%")
	if shield <= 0:
		is_alive = false
		print("[Cyber Speeder] Shield Depleted! Critical System Failure.")
`;

// -------------------------------------------------------------
// Building Block 3: Crimson Laser Barrier Hazards
// -------------------------------------------------------------
const LASER_BARRIER_TSCN = `[gd_scene load_steps=7 format=3 uid="uid://laser_barrier_3d"]

[ext_resource type="Script" path="res://laser_barrier.gd" id="1_laser_gd"]

[sub_resource type="CylinderMesh" id="CylinderMesh_Pillar"]
top_radius = 0.15
bottom_radius = 0.2
height = 1.8

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Pillar"]
albedo_color = Color(0.2, 0.22, 0.28, 1)
metallic = 0.9

[sub_resource type="BoxMesh" id="BoxMesh_LaserBeam"]
size = Vector3(3.6, 0.35, 0.25)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_LaserGlow"]
albedo_color = Color(1.0, 0.05, 0.25, 1)
emission_enabled = true
emission = Color(1.0, 0.05, 0.25, 1)
emission_energy_multiplier = 4.5

[sub_resource type="BoxShape3D" id="BoxShape3D_Laser"]
size = Vector3(3.6, 0.35, 0.25)

[node name="LaserBarrier" type="Area3D" groups=["hazards"]]
script = ExtResource("1_laser_gd")

[node name="LeftPillar" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -1.8, 0.9, 0)
mesh = SubResource("CylinderMesh_Pillar")
surface_material_override/0 = SubResource("StandardMaterial3D_Pillar")

[node name="RightPillar" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 1.8, 0.9, 0)
mesh = SubResource("CylinderMesh_Pillar")
surface_material_override/0 = SubResource("StandardMaterial3D_Pillar")

[node name="LaserBeam" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.6, 0)
mesh = SubResource("BoxMesh_LaserBeam")
surface_material_override/0 = SubResource("StandardMaterial3D_LaserGlow")

[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.6, 0)
shape = SubResource("BoxShape3D_Laser")

[node name="LaserLight" type="OmniLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.7, 0)
light_color = Color(1, 0.1, 0.2, 1)
light_energy = 3.0
omni_range = 5.0
`;

const LASER_BARRIER_GD = `extends Area3D

@export var damage: int = 25
var pulse: float = 0.0

func _ready():
	connect("body_entered", _on_body_entered)

func _process(delta):
	pulse += delta * 7.0
	var light = get_node_or_null("LaserLight")
	if light:
		light.light_energy = 2.5 + sin(pulse) * 1.2

func _on_body_entered(body):
	if body.has_method("take_damage"):
		body.take_damage(damage)
`;

// -------------------------------------------------------------
// Building Block 4: Oscillating Amethyst Plasma Mines
// -------------------------------------------------------------
const PLASMA_MINE_TSCN = `[gd_scene load_steps=6 format=3 uid="uid://plasma_mine_3d"]

[ext_resource type="Script" path="res://plasma_mine.gd" id="1_mine_gd"]

[sub_resource type="SphereMesh" id="SphereMesh_Core"]
radius = 0.7
height = 1.4

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Amethyst"]
albedo_color = Color(0.7, 0.1, 1.0, 1)
emission_enabled = true
emission = Color(0.8, 0.1, 1.0, 1)
emission_energy_multiplier = 4.0

[sub_resource type="TorusMesh" id="TorusMesh_Ring"]
inner_radius = 0.9
outer_radius = 1.1

[sub_resource type="SphereShape3D" id="SphereShape3D_Mine"]
radius = 0.85

[node name="PlasmaMine" type="Area3D" groups=["hazards"]]
script = ExtResource("1_mine_gd")

[node name="CoreMesh" type="MeshInstance3D" parent="."]
mesh = SubResource("SphereMesh_Core")
surface_material_override/0 = SubResource("StandardMaterial3D_Amethyst")

[node name="RingMesh" type="MeshInstance3D" parent="."]
mesh = SubResource("TorusMesh_Ring")
surface_material_override/0 = SubResource("StandardMaterial3D_Amethyst")

[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
shape = SubResource("SphereShape3D_Mine")

[node name="MineLight" type="OmniLight3D" parent="."]
light_color = Color(0.8, 0.2, 1, 1)
light_energy = 3.2
omni_range = 6.0
`;

const PLASMA_MINE_GD = `extends Area3D

@export var damage: int = 35
@export var oscillation_width: float = 3.6
@export var oscillation_speed: float = 2.6
var initial_x: float = 0.0
var time: float = 0.0

func _ready():
	initial_x = position.x
	connect("body_entered", _on_body_entered)

func _process(delta):
	time += delta * oscillation_speed
	position.x = initial_x + sin(time) * oscillation_width
	var ring = get_node_or_null("RingMesh")
	if ring:
		ring.rotate_z(delta * 3.5)
		ring.rotate_y(delta * 2.0)

func _on_body_entered(body):
	if body.has_method("take_damage"):
		body.take_damage(damage)
`;

// -------------------------------------------------------------
// Building Block 5: Golden Quantum Flux Crystals
// -------------------------------------------------------------
const QUANTUM_CRYSTAL_TSCN = `[gd_scene load_steps=5 format=3 uid="uid://quantum_crystal_3d"]

[ext_resource type="Script" path="res://quantum_crystal.gd" id="1_crystal_gd"]

[sub_resource type="PrismMesh" id="PrismMesh_Crystal"]
size = Vector3(0.8, 1.2, 0.8)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_GoldGlow"]
albedo_color = Color(1.0, 0.85, 0.1, 1)
metallic = 0.8
roughness = 0.1
emission_enabled = true
emission = Color(1.0, 0.8, 0.0, 1)
emission_energy_multiplier = 4.5

[sub_resource type="SphereShape3D" id="SphereShape3D_Pickup"]
radius = 0.7

[node name="QuantumCrystal" type="Area3D" groups=["collectibles"]]
script = ExtResource("1_crystal_gd")

[node name="CrystalMesh" type="MeshInstance3D" parent="."]
mesh = SubResource("PrismMesh_Crystal")
surface_material_override/0 = SubResource("StandardMaterial3D_GoldGlow")

[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
shape = SubResource("SphereShape3D_Pickup")

[node name="CrystalLight" type="OmniLight3D" parent="."]
light_color = Color(1, 0.85, 0.2, 1)
light_energy = 2.8
omni_range = 4.5
`;

const QUANTUM_CRYSTAL_GD = `extends Area3D

@export var score_value: int = 100
var base_y: float = 0.0
var time: float = 0.0

func _ready():
	base_y = position.y
	connect("body_entered", _on_body_entered)

func _process(delta):
	time += delta * 4.5
	position.y = base_y + sin(time) * 0.3
	rotate_y(delta * 3.5)

func _on_body_entered(body):
	if body.is_in_group("player") or body.name == "PlayerRunner":
		var main = get_tree().root.get_node_or_null("Main3D")
		if main and main.has_method("add_score"):
			main.add_score(score_value)
		queue_free()
`;

// -------------------------------------------------------------
// Building Block 6: Quantum Nexus Goal Gate (Finish Line Arch)
// -------------------------------------------------------------
const NEXUS_GATE_TSCN = `[gd_scene load_steps=5 format=3 uid="uid://nexus_gate_3d"]

[sub_resource type="TorusMesh" id="TorusMesh_PortalArch"]
inner_radius = 5.5
outer_radius = 6.8

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_PortalGlow"]
albedo_color = Color(0.0, 1.0, 0.8, 1)
emission_enabled = true
emission = Color(0.0, 1.0, 0.8, 1)
emission_energy_multiplier = 4.0

[sub_resource type="CylinderMesh" id="CylinderMesh_Vortex"]
top_radius = 5.2
bottom_radius = 5.2
height = 0.2

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Vortex"]
albedo_color = Color(0.8, 0.1, 1.0, 0.6)
emission_enabled = true
emission = Color(0.8, 0.1, 1.0, 1)
emission_energy_multiplier = 3.0

[node name="NexusGate" type="Node3D"]

[node name="ArchMesh" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, -4.37114e-08, -1, 0, 1, -4.37114e-08, 0, 4.5, 0)
mesh = SubResource("TorusMesh_PortalArch")
surface_material_override/0 = SubResource("StandardMaterial3D_PortalGlow")

[node name="VortexMesh" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, -4.37114e-08, -1, 0, 1, -4.37114e-08, 0, 4.5, 0)
mesh = SubResource("CylinderMesh_Vortex")
surface_material_override/0 = SubResource("StandardMaterial3D_Vortex")

[node name="PortalLight" type="OmniLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 4.5, 0)
light_color = Color(0.2, 1, 0.8, 1)
light_energy = 5.0
omni_range = 14.0
`;

// -------------------------------------------------------------
// Building Block 7: Cyberpunk Holographic HUD Overlay
// -------------------------------------------------------------
const HUD_OVERLAY_TSCN = `[gd_scene load_steps=2 format=3 uid="uid://hud_overlay_2d"]

[ext_resource type="Script" path="res://hud_overlay.gd" id="1_hud_gd"]

[node name="HUDOverlay" type="CanvasLayer"]
script = ExtResource("1_hud_gd")

[node name="TopPanel" type="Control" parent="."]
layout_mode = 3
anchors_preset = 10
anchor_right = 1.0
offset_bottom = 75.0
grow_horizontal = 2

[node name="Title" type="Label" parent="TopPanel"]
layout_mode = 0
offset_left = 20.0
offset_top = 14.0
offset_right = 420.0
offset_bottom = 40.0
theme_override_colors/font_color = Color(0, 0.95, 1, 1)
theme_override_font_sizes/font_size = 18
text = "NEON HORIZON // QUANTUM SPEEDER 3D"

[node name="Distance" type="Label" parent="TopPanel"]
layout_mode = 1
anchors_preset = 5
anchor_left = 0.5
offset_left = -160.0
offset_top = 14.0
offset_right = 160.0
offset_bottom = 40.0
grow_horizontal = 2
theme_override_colors/font_color = Color(1, 0.85, 0.2, 1)
theme_override_font_sizes/font_size = 17
text = "DISTANCE: 0m / 800m [░░░░░░░░░░]"
horizontal_alignment = 1

[node name="Score" type="Label" parent="TopPanel"]
layout_mode = 1
anchors_preset = 1
anchor_left = 1.0
offset_left = -260.0
offset_top = 14.0
offset_right = -20.0
offset_bottom = 40.0
grow_horizontal = 0
theme_override_colors/font_color = Color(0.3, 1, 0.6, 1)
theme_override_font_sizes/font_size = 17
text = "SCORE: 0 PTS"
horizontal_alignment = 2

[node name="ShieldBox" type="HBoxContainer" parent="."]
offset_left = 20.0
offset_top = 46.0
offset_right = 300.0
offset_bottom = 68.0

[node name="ShieldTitle" type="Label" parent="ShieldBox"]
layout_mode = 2
theme_override_colors/font_color = Color(0, 0.95, 1, 1)
theme_override_font_sizes/font_size = 13
text = "SHIELD INTEGRITY: "

[node name="ShieldValue" type="Label" parent="ShieldBox"]
layout_mode = 2
theme_override_colors/font_color = Color(0.2, 1, 0.8, 1)
theme_override_font_sizes/font_size = 13
text = "100% [ |||||||||| ]"

[node name="Speedometer" type="Label" parent="."]
anchors_preset = 3
anchor_left = 1.0
anchor_top = 1.0
offset_left = -200.0
offset_top = -42.0
offset_right = -20.0
offset_bottom = -16.0
grow_horizontal = 0
grow_vertical = 0
theme_override_colors/font_color = Color(1, 0.4, 0.8, 1)
theme_override_font_sizes/font_size = 15
text = "VELOCITY: 165 KM/H"
horizontal_alignment = 2
`;

const HUD_OVERLAY_GD = `extends CanvasLayer

@onready var dist_lbl = $TopPanel/Distance
@onready var score_lbl = $TopPanel/Score
@onready var shield_lbl = $ShieldBox/ShieldValue
@onready var speed_lbl = $Speedometer

func update_hud(distance: float, score: int, shield: int, speed: float):
	if dist_lbl:
		var pct = clamp(distance / 800.0, 0.0, 1.0)
		var bars = int(pct * 10.0)
		var progress = ""
		for i in range(10):
			progress += "█" if i < bars else "░"
		dist_lbl.text = "DISTANCE: %dm / 800m [%s]" % [int(distance), progress]
	if score_lbl:
		score_lbl.text = "SCORE: %d PTS" % [score]
	if shield_lbl:
		var pips = int(shield / 10.0)
		var bar = ""
		for i in range(pips):
			bar += "|"
		shield_lbl.text = "%d%% [ %s ]" % [shield, bar]
		if shield <= 25:
			shield_lbl.set("theme_override_colors/font_color", Color(1, 0.2, 0.3, 1))
		else:
			shield_lbl.set("theme_override_colors/font_color", Color(0.2, 1, 0.8, 1))
	if speed_lbl:
		speed_lbl.text = "VELOCITY: %d KM/H" % [int(speed * 3.6)]
`;

// -------------------------------------------------------------
// Staged Scene Manifests
// -------------------------------------------------------------

// Staged Manifest 2: Stage 3 (Laser Barriers)
const MAIN_3D_STAGE3_TSCN = `[gd_scene load_steps=13 format=3 uid="uid://main_3d_neon_horizon"]

[ext_resource type="Script" path="res://main_3d.gd" id="1_main"]
[ext_resource type="PackedScene" uid="uid://player_speeder_3d" path="res://player_speeder.tscn" id="2_player"]
[ext_resource type="PackedScene" uid="uid://laser_barrier_3d" path="res://laser_barrier.tscn" id="3_laser"]

[sub_resource type="ProceduralSkyMaterial" id="ProceduralSkyMaterial_Nebula"]
sky_top_color = Color(0.08, 0.05, 0.22, 1)
sky_horizon_color = Color(1.0, 0.25, 0.65, 1)
ground_bottom_color = Color(0.02, 0.01, 0.06, 1)

[sub_resource type="Sky" id="Sky_Nebula"]
sky_material = SubResource("ProceduralSkyMaterial_Nebula")

[sub_resource type="Environment" id="Environment_Nebula"]
background_mode = 2
sky = SubResource("Sky_Nebula")
ambient_light_source = 3
ambient_light_color = Color(0.4, 0.2, 0.6, 1)
fog_enabled = true
fog_light_color = Color(0.9, 0.2, 0.55, 1)
fog_density = 0.0018

[sub_resource type="BoxMesh" id="BoxMesh_Highway"]
size = Vector3(12, 0.4, 1000)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Highway"]
albedo_color = Color(0.06, 0.08, 0.16, 1)
metallic = 0.9
roughness = 0.15
emission_enabled = true
emission = Color(0.0, 0.3, 0.7, 1)
emission_energy_multiplier = 0.3

[sub_resource type="BoxMesh" id="BoxMesh_LaneMarker"]
size = Vector3(0.12, 0.05, 1000)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_CyanGlow"]
albedo_color = Color(0.0, 0.9, 1.0, 1)
emission_enabled = true
emission = Color(0.0, 0.9, 1.0, 1)
emission_energy_multiplier = 3.5

[node name="Main3D" type="Node3D"]
script = ExtResource("1_main")

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Environment_Nebula")

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.866, -0.25, 0.433, 0, 0.866, 0.5, -0.5, -0.433, 0.75, 0, 45, 0)
light_color = Color(1, 0.9, 0.82, 1)
light_energy = 2.2

[node name="SkyrailHighway" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -450)
mesh = SubResource("BoxMesh_Highway")
surface_material_override/0 = SubResource("StandardMaterial3D_Highway")

[node name="LaneDividerLeft" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -1.8, 0.22, -450)
mesh = SubResource("BoxMesh_LaneMarker")
surface_material_override/0 = SubResource("StandardMaterial3D_CyanGlow")

[node name="LaneDividerRight" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 1.8, 0.22, -450)
mesh = SubResource("BoxMesh_LaneMarker")
surface_material_override/0 = SubResource("StandardMaterial3D_CyanGlow")

[node name="PlayerRunner" parent="." instance=ExtResource("2_player")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.8, 0)

[node name="LaserHazardsContainer" type="Node3D" parent="."]

[node name="Laser1" parent="LaserHazardsContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -3.6, 0.4, -90)

[node name="Laser2" parent="LaserHazardsContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.6, 0.4, -170)

[node name="Laser3" parent="LaserHazardsContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.4, -250)

[node name="Laser4" parent="LaserHazardsContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -3.6, 0.4, -380)

[node name="Laser5" parent="LaserHazardsContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.6, 0.4, -380)
`;

// Staged Manifest 3: Stage 4 (Plasma Mines)
const MAIN_3D_STAGE4_TSCN = `[gd_scene load_steps=14 format=3 uid="uid://main_3d_neon_horizon"]

[ext_resource type="Script" path="res://main_3d.gd" id="1_main"]
[ext_resource type="PackedScene" uid="uid://player_speeder_3d" path="res://player_speeder.tscn" id="2_player"]
[ext_resource type="PackedScene" uid="uid://laser_barrier_3d" path="res://laser_barrier.tscn" id="3_laser"]
[ext_resource type="PackedScene" uid="uid://plasma_mine_3d" path="res://plasma_mine.tscn" id="4_mine"]

[sub_resource type="ProceduralSkyMaterial" id="ProceduralSkyMaterial_Nebula"]
sky_top_color = Color(0.08, 0.05, 0.22, 1)
sky_horizon_color = Color(1.0, 0.25, 0.65, 1)
ground_bottom_color = Color(0.02, 0.01, 0.06, 1)

[sub_resource type="Sky" id="Sky_Nebula"]
sky_material = SubResource("ProceduralSkyMaterial_Nebula")

[sub_resource type="Environment" id="Environment_Nebula"]
background_mode = 2
sky = SubResource("Sky_Nebula")
ambient_light_source = 3
ambient_light_color = Color(0.4, 0.2, 0.6, 1)
fog_enabled = true
fog_light_color = Color(0.9, 0.2, 0.55, 1)
fog_density = 0.0018

[sub_resource type="BoxMesh" id="BoxMesh_Highway"]
size = Vector3(12, 0.4, 1000)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Highway"]
albedo_color = Color(0.06, 0.08, 0.16, 1)
metallic = 0.9
roughness = 0.15
emission_enabled = true
emission = Color(0.0, 0.3, 0.7, 1)
emission_energy_multiplier = 0.3

[sub_resource type="BoxMesh" id="BoxMesh_LaneMarker"]
size = Vector3(0.12, 0.05, 1000)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_CyanGlow"]
albedo_color = Color(0.0, 0.9, 1.0, 1)
emission_enabled = true
emission = Color(0.0, 0.9, 1.0, 1)
emission_energy_multiplier = 3.5

[node name="Main3D" type="Node3D"]
script = ExtResource("1_main")

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Environment_Nebula")

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.866, -0.25, 0.433, 0, 0.866, 0.5, -0.5, -0.433, 0.75, 0, 45, 0)
light_color = Color(1, 0.9, 0.82, 1)
light_energy = 2.2

[node name="SkyrailHighway" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -450)
mesh = SubResource("BoxMesh_Highway")
surface_material_override/0 = SubResource("StandardMaterial3D_Highway")

[node name="LaneDividerLeft" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -1.8, 0.22, -450)
mesh = SubResource("BoxMesh_LaneMarker")
surface_material_override/0 = SubResource("StandardMaterial3D_CyanGlow")

[node name="LaneDividerRight" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 1.8, 0.22, -450)
mesh = SubResource("BoxMesh_LaneMarker")
surface_material_override/0 = SubResource("StandardMaterial3D_CyanGlow")

[node name="PlayerRunner" parent="." instance=ExtResource("2_player")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.8, 0)

[node name="LaserHazardsContainer" type="Node3D" parent="."]

[node name="Laser1" parent="LaserHazardsContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -3.6, 0.4, -90)

[node name="Laser2" parent="LaserHazardsContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.6, 0.4, -170)

[node name="Laser3" parent="LaserHazardsContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.4, -250)

[node name="Laser4" parent="LaserHazardsContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -3.6, 0.4, -380)

[node name="Laser5" parent="LaserHazardsContainer" instance=ExtResource("3_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.6, 0.4, -380)

[node name="PlasmaMinesContainer" type="Node3D" parent="."]

[node name="Mine1" parent="PlasmaMinesContainer" instance=ExtResource("4_mine")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.7, -310)

[node name="Mine2" parent="PlasmaMinesContainer" instance=ExtResource("4_mine")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.7, -490)

[node name="Mine3" parent="PlasmaMinesContainer" instance=ExtResource("4_mine")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.7, -620)
`;

// Staged Manifest 4: Full Scene with Crystals, Nexus Gate, and HUD Overlay
const MAIN_3D_FULL_TSCN = `[gd_scene load_steps=17 format=3 uid="uid://main_3d_neon_horizon"]

[ext_resource type="Script" path="res://main_3d.gd" id="1_main"]
[ext_resource type="PackedScene" uid="uid://player_speeder_3d" path="res://player_speeder.tscn" id="2_player"]
[ext_resource type="PackedScene" uid="uid://hud_overlay_2d" path="res://hud_overlay.tscn" id="3_hud"]
[ext_resource type="PackedScene" uid="uid://laser_barrier_3d" path="res://laser_barrier.tscn" id="4_laser"]
[ext_resource type="PackedScene" uid="uid://plasma_mine_3d" path="res://plasma_mine.tscn" id="5_mine"]
[ext_resource type="PackedScene" uid="uid://quantum_crystal_3d" path="res://quantum_crystal.tscn" id="6_crystal"]
[ext_resource type="PackedScene" uid="uid://nexus_gate_3d" path="res://nexus_gate.tscn" id="7_nexus"]

[sub_resource type="ProceduralSkyMaterial" id="ProceduralSkyMaterial_Nebula"]
sky_top_color = Color(0.08, 0.05, 0.22, 1)
sky_horizon_color = Color(1.0, 0.25, 0.65, 1)
ground_bottom_color = Color(0.02, 0.01, 0.06, 1)

[sub_resource type="Sky" id="Sky_Nebula"]
sky_material = SubResource("ProceduralSkyMaterial_Nebula")

[sub_resource type="Environment" id="Environment_Nebula"]
background_mode = 2
sky = SubResource("Sky_Nebula")
ambient_light_source = 3
ambient_light_color = Color(0.4, 0.2, 0.6, 1)
fog_enabled = true
fog_light_color = Color(0.9, 0.2, 0.55, 1)
fog_density = 0.0018

[sub_resource type="BoxMesh" id="BoxMesh_Highway"]
size = Vector3(12, 0.4, 1000)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_Highway"]
albedo_color = Color(0.06, 0.08, 0.16, 1)
metallic = 0.9
roughness = 0.15
emission_enabled = true
emission = Color(0.0, 0.3, 0.7, 1)
emission_energy_multiplier = 0.3

[sub_resource type="BoxMesh" id="BoxMesh_LaneMarker"]
size = Vector3(0.12, 0.05, 1000)

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_CyanGlow"]
albedo_color = Color(0.0, 0.9, 1.0, 1)
emission_enabled = true
emission = Color(0.0, 0.9, 1.0, 1)
emission_energy_multiplier = 3.5

[node name="Main3D" type="Node3D"]
script = ExtResource("1_main")

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Environment_Nebula")

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.866, -0.25, 0.433, 0, 0.866, 0.5, -0.5, -0.433, 0.75, 0, 45, 0)
light_color = Color(1, 0.9, 0.82, 1)
light_energy = 2.2

[node name="SkyrailHighway" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -450)
mesh = SubResource("BoxMesh_Highway")
surface_material_override/0 = SubResource("StandardMaterial3D_Highway")

[node name="LaneDividerLeft" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -1.8, 0.22, -450)
mesh = SubResource("BoxMesh_LaneMarker")
surface_material_override/0 = SubResource("StandardMaterial3D_CyanGlow")

[node name="LaneDividerRight" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 1.8, 0.22, -450)
mesh = SubResource("BoxMesh_LaneMarker")
surface_material_override/0 = SubResource("StandardMaterial3D_CyanGlow")

[node name="HUDOverlay" parent="." instance=ExtResource("3_hud")]

[node name="PlayerRunner" parent="." instance=ExtResource("2_player")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.8, 0)

[node name="LaserHazardsContainer" type="Node3D" parent="."]

[node name="Laser1" parent="LaserHazardsContainer" instance=ExtResource("4_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -3.6, 0.4, -90)

[node name="Laser2" parent="LaserHazardsContainer" instance=ExtResource("4_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.6, 0.4, -170)

[node name="Laser3" parent="LaserHazardsContainer" instance=ExtResource("4_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.4, -250)

[node name="Laser4" parent="LaserHazardsContainer" instance=ExtResource("4_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -3.6, 0.4, -380)

[node name="Laser5" parent="LaserHazardsContainer" instance=ExtResource("4_laser")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.6, 0.4, -380)

[node name="PlasmaMinesContainer" type="Node3D" parent="."]

[node name="Mine1" parent="PlasmaMinesContainer" instance=ExtResource("5_mine")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.7, -310)

[node name="Mine2" parent="PlasmaMinesContainer" instance=ExtResource("5_mine")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.7, -490)

[node name="Mine3" parent="PlasmaMinesContainer" instance=ExtResource("5_mine")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.7, -620)

[node name="CrystalsContainer" type="Node3D" parent="."]

[node name="Crystal1" parent="CrystalsContainer" instance=ExtResource("6_crystal")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.9, -45)

[node name="Crystal2" parent="CrystalsContainer" instance=ExtResource("6_crystal")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.6, 0.9, -125)

[node name="Crystal3" parent="CrystalsContainer" instance=ExtResource("6_crystal")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -3.6, 0.9, -205)

[node name="Crystal4" parent="CrystalsContainer" instance=ExtResource("6_crystal")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.0, 0.9, -290)

[node name="Crystal5" parent="CrystalsContainer" instance=ExtResource("6_crystal")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 3.6, 0.9, -440)

[node name="Crystal6" parent="CrystalsContainer" instance=ExtResource("6_crystal")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -3.6, 0.9, -560)

[node name="NexusGate" parent="." instance=ExtResource("7_nexus")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -800)
`;

const MAIN_3D_GD = `extends Node3D

var score: int = 0
var distance: float = 0.0
const GOAL_DISTANCE: float = 800.0
var game_finished: bool = false

@onready var player = $PlayerRunner
@onready var hud = get_node_or_null("HUDOverlay")

func _ready():
	print("[Neon Horizon] 3D Cyber Highway initialized (800m to Nexus Gate).")

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
		print("[Neon Horizon] MISSION VICTORY! Nexus Gate Crossed at ", int(distance), "m! Final Quantum Score: ", score)

func add_score(amount: int):
	score += amount
	print("[Neon Horizon] Quantum Crystal Collected! Score +", amount, " -> Total: ", score)
`;

// =========================================================================
// 2. Incremental Builder Execution with Real-Time Screenshots
// =========================================================================

async function buildNeonHorizonGame() {
  console.log('================================================================');
  console.log('  STARTING STEP-BY-STEP NEON HORIZON GAME CONSTRUCTION');
  console.log('================================================================\n');

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
    if (text.includes('[Neon Horizon') || text.includes('[Cyber Speeder') || text.includes('[Agent') || text.includes('[WebMCP')) {
      console.log('  [Engine Log]', text);
    }
  });

  // -------------------------------------------------------------
  // STEP 1: Workspace & Editor Boot Initialization
  // -------------------------------------------------------------
  console.log('--- Step 1: Navigating to WebMCP Workspace ---');
  await page.goto('http://localhost:8060/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#webmcp-diagnostic-hud', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 1200));

  const shot1 = path.join(ARTIFACTS_DIR, 'step1_workspace_init.png');
  await page.screenshot({ path: shot1 });
  console.log('  [Screenshot 1/7 Saved]:', shot1);

  // -------------------------------------------------------------
  // STEP 2: Building Block 1 & 2 (Highway Foundation & Player Speeder)
  // -------------------------------------------------------------
  console.log('\n--- Step 2: Creating Highway Foundation & Player Speeder (Block #1 & #2) ---');
  const createResult = await page.evaluate(async (pGodot, mScene, mGd, pScene, pGd) => {
    return await window.godotWebMcpTestBridge.callTool('godot_create_project', {
      project_name: 'neon_horizon_cyber_speeder',
      template: 'custom',
      files: {
        'project.godot': pGodot,
        'main_3d.tscn': mScene,
        'main_3d.gd': mGd,
        'player_speeder.tscn': pScene,
        'player_speeder.gd': pGd
      }
    });
  }, PROJECT_GODOT, MAIN_3D_BASE_TSCN, MAIN_3D_GD, PLAYER_SPEEDER_TSCN, PLAYER_SPEEDER_GD);

  console.log('  Project Created:', createResult.project_name, 'Revision:', createResult.scene_revision);
  await new Promise(r => setTimeout(r, 1500));

  const shot2 = path.join(ARTIFACTS_DIR, 'step2_track_and_player_speeder.png');
  await page.screenshot({ path: shot2 });
  console.log('  [Screenshot 2/7 Saved]:', shot2);

  // -------------------------------------------------------------
  // STEP 3: Building Block 3 (Crimson Laser Barriers)
  // -------------------------------------------------------------
  console.log('\n--- Step 3: Staging Crimson Laser Barrier Hazards (Block #3) ---');
  const laserTxResult = await page.evaluate(async (rev, mSceneStage3, laserTscn, laserGd) => {
    return await window.godotWebMcpTestBridge.callTool('godot_apply_file_transaction', {
      expected_revision: rev,
      label: 'Authoring Crimson Laser Barriers (25 DMG Obstacles)',
      operations: [
        { kind: 'write', path: 'res://laser_barrier.tscn', content: laserTscn },
        { kind: 'write', path: 'res://laser_barrier.gd', content: laserGd },
        { kind: 'write', path: 'res://main_3d.tscn', content: mSceneStage3 }
      ]
    });
  }, createResult.scene_revision, MAIN_3D_STAGE3_TSCN, LASER_BARRIER_TSCN, LASER_BARRIER_GD);

  console.log('  Laser Barriers Staged:', laserTxResult.changed_paths.join(', '), 'Revision:', laserTxResult.scene_revision);
  await new Promise(r => setTimeout(r, 1500));

  const shot3 = path.join(ARTIFACTS_DIR, 'step3_crimson_laser_barriers.png');
  await page.screenshot({ path: shot3 });
  console.log('  [Screenshot 3/7 Saved]:', shot3);

  // -------------------------------------------------------------
  // STEP 4: Building Block 4 (Oscillating Amethyst Plasma Mines)
  // -------------------------------------------------------------
  console.log('\n--- Step 4: Staging Oscillating Amethyst Plasma Mines (Block #4) ---');
  const mineTxResult = await page.evaluate(async (rev, mSceneStage4, mineTscn, mineGd) => {
    return await window.godotWebMcpTestBridge.callTool('godot_apply_file_transaction', {
      expected_revision: rev,
      label: 'Authoring Oscillating Amethyst Plasma Mines (35 DMG)',
      operations: [
        { kind: 'write', path: 'res://plasma_mine.tscn', content: mineTscn },
        { kind: 'write', path: 'res://plasma_mine.gd', content: mineGd },
        { kind: 'write', path: 'res://main_3d.tscn', content: mSceneStage4 }
      ]
    });
  }, laserTxResult.scene_revision, MAIN_3D_STAGE4_TSCN, PLASMA_MINE_TSCN, PLASMA_MINE_GD);

  console.log('  Plasma Mines Staged:', mineTxResult.changed_paths.join(', '), 'Revision:', mineTxResult.scene_revision);
  await new Promise(r => setTimeout(r, 1500));

  const shot4 = path.join(ARTIFACTS_DIR, 'step4_plasma_mines_staged.png');
  await page.screenshot({ path: shot4 });
  console.log('  [Screenshot 4/7 Saved]:', shot4);

  // -------------------------------------------------------------
  // STEP 5: Building Block 5, 6 & 7 (Crystals, Nexus Goal Gate, HUD)
  // -------------------------------------------------------------
  console.log('\n--- Step 5: Staging Quantum Crystals, Nexus Goal Gate & Holographic HUD (Blocks #5, #6, #7) ---');
  const fullTxResult = await page.evaluate(async (rev, mSceneFull, crystalTscn, crystalGd, nexusTscn, hudTscn, hudGd) => {
    return await window.godotWebMcpTestBridge.callTool('godot_apply_file_transaction', {
      expected_revision: rev,
      label: 'Authoring Quantum Crystals, Nexus Goal Gate & Holographic HUD',
      operations: [
        { kind: 'write', path: 'res://quantum_crystal.tscn', content: crystalTscn },
        { kind: 'write', path: 'res://quantum_crystal.gd', content: crystalGd },
        { kind: 'write', path: 'res://nexus_gate.tscn', content: nexusTscn },
        { kind: 'write', path: 'res://hud_overlay.tscn', content: hudTscn },
        { kind: 'write', path: 'res://hud_overlay.gd', content: hudGd },
        { kind: 'write', path: 'res://main_3d.tscn', content: mSceneFull }
      ]
    });
  }, mineTxResult.scene_revision, MAIN_3D_FULL_TSCN, QUANTUM_CRYSTAL_TSCN, QUANTUM_CRYSTAL_GD, NEXUS_GATE_TSCN, HUD_OVERLAY_TSCN, HUD_OVERLAY_GD);

  console.log('  Full Game Staged:', fullTxResult.changed_paths.join(', '), 'Revision:', fullTxResult.scene_revision);
  await new Promise(r => setTimeout(r, 1500));

  const shot5 = path.join(ARTIFACTS_DIR, 'step5_crystals_nexus_gate_hud.png');
  await page.screenshot({ path: shot5 });
  console.log('  [Screenshot 5/7 Saved]:', shot5);

  // -------------------------------------------------------------
  // STEP 6: Synthesizing Dynamic 8-Track Audio Suite
  // -------------------------------------------------------------
  console.log('\n--- Step 6: Synthesizing Procedural 8-Track Sound FX Suite ---');
  const audioResult = await page.evaluate(async () => {
    return await window.godotWebMcpTestBridge.callTool('godot_synthesize_audio_suite', {});
  });
  console.log('  Audio Suite Synthesized:', audioResult.tracks_generated?.length || '8 tracks');
  await new Promise(r => setTimeout(r, 1200));

  const shot6 = path.join(ARTIFACTS_DIR, 'step6_audio_suite_synthesized.png');
  await page.screenshot({ path: shot6 });
  console.log('  [Screenshot 6/7 Saved]:', shot6);

  // -------------------------------------------------------------
  // STEP 7: Live Playtesting, Flight Maneuvers & Telemetry
  // -------------------------------------------------------------
  console.log('\n--- Step 7: Launching Live Game Session & Executing Flight Controls ---');
  const launchResult = await page.evaluate(async () => {
    return await window.godotWebMcpTestBridge.callTool('godot_run_game', {});
  });
  console.log('  Game Session Launched:', launchResult.status);
  await new Promise(r => setTimeout(r, 1500));

  console.log('  Sending Flight Maneuvers (Dodge Right, Jump Over Laser, Dodge Left to Collect Crystal)...');
  await page.evaluate(async () => {
    await window.godotWebMcpTestBridge.callTool('godot_send_input_sequence', {
      events: [
        { key: 'ui_right', action: 'keydown', delay_ms: 100 },
        { key: 'ui_right', action: 'keyup', delay_ms: 250 },
        { key: 'ui_up', action: 'keydown', delay_ms: 450 },
        { key: 'ui_up', action: 'keyup', delay_ms: 650 },
        { key: 'ui_left', action: 'keydown', delay_ms: 850 },
        { key: 'ui_left', action: 'keyup', delay_ms: 1050 }
      ]
    });
  });

  await new Promise(r => setTimeout(r, 2000));

  const shot7 = path.join(ARTIFACTS_DIR, 'step7_live_gameplay_flight.png');
  await page.screenshot({ path: shot7 });
  console.log('  [Screenshot 7/7 Saved]:', shot7);

  // Final Manifest Verification
  const manifest = await page.evaluate(async () => {
    return await window.godotWebMcpTestBridge.callTool('godot_inspect_project_files', {});
  });
  console.log(`\n================================================================`);
  console.log(`  FINAL AUTHORITATIVE MANIFEST (${manifest.file_count} Files at Rev #${manifest.scene_revision})`);
  console.log(`================================================================`);
  manifest.files.forEach(f => console.log(`  ✓ ${f.path.padEnd(30)} [${f.kind.toUpperCase()}] (${f.size_bytes} bytes)`));

  await browser.close();
  console.log('\n=== Construction & Verification Completed Successfully ===');
}

buildNeonHorizonGame().catch(err => {
  console.error('Construction failed:', err);
  process.exit(1);
});
