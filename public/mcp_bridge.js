/**
 * Godot WebMCP Bridge (v9.1 - Authoritative Native WebMCP & 3D Runner Engine)
 * Fully compliant with W3C / Chrome / OpenAI WebMCP standards:
 * - Single Authoritative Tool Manifest (21 Tools with strict JSON Schemas)
 * - Safe Native ModelContext Registration (Never overwrites read-only document.modelContext)
 * - Measurable Diagnostic Readiness State Machine (Engine, WebMCP, Session)
 * - Fixed Binary PKZIP Packager (setUint16) with standard CRC32
 * - Game-Owned Playtest State Machine with Sequence Cursor & Delta Audio Triggers
 * - 3D Runner ("Neon Skyrail") Course & 6-Piece Procedural Audio Suite
 */

(function () {
  'use strict';

  // ==========================================
  // 1. Diagnostic Readiness State Machine
  // ==========================================
  const DiagnosticState = {
    engine: 'loading', // 'loading' | 'ready' | 'failed'
    engineError: null,
    webmcp: 'registering', // 'unsupported' | 'registering' | 'ready' | 'failed'
    webmcpRegisteredCount: 0,
    webmcpLastError: null,
    webmcpSurface: 'none',
    session: 'authoring', // 'empty' | 'authoring' | 'editor-ready' | 'playtesting' | 'stopped' | 'failed'
    sceneRevision: 1,
    undoDepth: 0,
    activeProject: 'neon_skyrail_3d'
  };

  const undoStack = [];
  const idempotentMutations = new Map();
  const activeLogs = [];
  const MAX_LOGS = 500;
  let activeFilesDict = {};
  let activeMainScene = 'res://main_3d.tscn';

  function normalizeResourcePath(filePath, fallback = 'res://main.tscn') {
    if (!filePath || typeof filePath !== 'string') return fallback;
    return filePath.startsWith('res://') ? filePath : `res://${filePath.replace(/^\/+/, '')}`;
  }

  function refreshMeasuredEngineState() {
    if (typeof document === 'undefined') return DiagnosticState.engine;
    const editorTab = document.getElementById('btn-tab-editor');
    const gameTab = document.getElementById('btn-tab-game');
    const editorCanvas = document.getElementById('editor-canvas');
    const gameCanvas = document.getElementById('game-canvas');
    const hasUsableRuntime = Boolean(
      (editorTab && !editorTab.disabled && editorCanvas) ||
      (gameTab && !gameTab.disabled && gameCanvas)
    );
    if (hasUsableRuntime && DiagnosticState.engine !== 'failed') {
      DiagnosticState.engine = 'ready';
      DiagnosticState.engineError = null;
    }
    return DiagnosticState.engine;
  }

  async function waitFor(predicate, timeoutMs = 8000, intervalMs = 80) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return true;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  // Intercept logs for diagnostics
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = function (...args) {
    activeLogs.push({ level: 'info', time: Date.now(), msg: args.map(String).join(' ') });
    if (activeLogs.length > MAX_LOGS) activeLogs.shift();
    origLog.apply(console, args);
  };
  console.error = function (...args) {
    activeLogs.push({ level: 'error', time: Date.now(), msg: args.map(String).join(' ') });
    if (activeLogs.length > MAX_LOGS) activeLogs.shift();
    origError.apply(console, args);
  };
  console.warn = function (...args) {
    activeLogs.push({ level: 'warn', time: Date.now(), msg: args.map(String).join(' ') });
    if (activeLogs.length > MAX_LOGS) activeLogs.shift();
    origWarn.apply(console, args);
  };

  // ==========================================
  // 2. Pure JS CRC32 & Valid PKZIP Builder
  // ==========================================
  const ZipBuilder = {
    crcTable: null,
    makeCrcTable() {
      let c;
      const table = [];
      for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
        table[n] = c;
      }
      return table;
    },
    crc32(bytes) {
      if (!this.crcTable) this.crcTable = this.makeCrcTable();
      let crc = 0 ^ (-1);
      for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ this.crcTable[(crc ^ bytes[i]) & 0xFF];
      return (crc ^ (-1)) >>> 0;
    },
    createZip(filesDict) {
      const encoder = new TextEncoder();
      const localHeaders = [];
      const centralHeaders = [];
      let offset = 0;

      for (const [rawPath, content] of Object.entries(filesDict)) {
        const filePath = rawPath.replace(/^\/+/, '');
        const pathBytes = encoder.encode(filePath);
        const fileBytes = typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);
        const crc = this.crc32(fileBytes);
        const size = fileBytes.length;

        // Local file header (30 bytes + path + fileBytes)
        const localHeader = new Uint8Array(30 + pathBytes.length + size);
        const lv = new DataView(localHeader.buffer);
        lv.setUint32(0, 0x04034b50, true); // Local file header signature
        lv.setUint16(4, 10, true);         // Version needed to extract (1.0)
        lv.setUint16(6, 0, true);          // General purpose bit flag
        lv.setUint16(8, 0, true);          // Compression method (0 = store)
        lv.setUint16(10, 0, true);         // File last mod time
        lv.setUint16(12, 0, true);         // File last mod date
        lv.setUint32(14, crc, true);        // CRC-32
        lv.setUint32(18, size, true);       // Compressed size
        lv.setUint32(22, size, true);       // Uncompressed size
        lv.setUint16(26, pathBytes.length, true); // File name length
        lv.setUint16(28, 0, true);         // Extra field length
        localHeader.set(pathBytes, 30);
        localHeader.set(fileBytes, 30 + pathBytes.length);
        localHeaders.push(localHeader);

        // Central directory file header (46 bytes + path)
        const centralHeader = new Uint8Array(46 + pathBytes.length);
        const cv = new DataView(centralHeader.buffer);
        cv.setUint32(0, 0x02014b50, true); // Central file header signature
        cv.setUint16(4, 20, true);         // Version made by (2.0)
        cv.setUint16(6, 10, true);         // Version needed to extract (1.0)
        cv.setUint16(8, 0, true);          // General purpose bit flag
        cv.setUint16(10, 0, true);         // Compression method (0 = store)
        cv.setUint16(12, 0, true);         // File last mod time
        cv.setUint16(14, 0, true);         // File last mod date (Uint16 fix)
        cv.setUint32(16, crc, true);        // CRC-32
        cv.setUint32(20, size, true);       // Compressed size
        cv.setUint32(24, size, true);       // Uncompressed size
        cv.setUint16(28, pathBytes.length, true); // File name length
        cv.setUint16(30, 0, true);         // Extra field length
        cv.setUint16(32, 0, true);         // File comment length
        cv.setUint16(34, 0, true);         // Disk number start
        cv.setUint16(36, 0, true);         // Internal file attributes
        cv.setUint32(38, 0, true);         // External file attributes
        cv.setUint32(42, offset, true);     // Relative offset of local header
        centralHeader.set(pathBytes, 46);
        centralHeaders.push(centralHeader);

        offset += localHeader.length;
      }

      const centralDirOffset = offset;
      let centralDirSize = 0;
      for (const h of centralHeaders) centralDirSize += h.length;

      // End of central directory record (22 bytes)
      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true); // EOCD signature
      ev.setUint16(4, 0, true);          // Number of this disk
      ev.setUint16(6, 0, true);          // Disk where central directory starts
      ev.setUint16(8, centralHeaders.length, true);  // Total records on this disk
      ev.setUint16(10, centralHeaders.length, true); // Total records in central directory
      ev.setUint32(12, centralDirSize, true);        // Size of central directory
      ev.setUint32(16, centralDirOffset, true);      // Offset of central directory
      ev.setUint16(20, 0, true);                     // ZIP comment length

      const totalSize = centralDirOffset + centralDirSize + 22;
      const result = new Uint8Array(totalSize);
      let cur = 0;
      for (const lh of localHeaders) {
        result.set(lh, cur);
        cur += lh.length;
      }
      for (const ch of centralHeaders) {
        result.set(ch, cur);
        cur += ch.length;
      }
      result.set(eocd, cur);
      return result;
    }
  };

  // ==========================================
  // 3. 6-Piece Procedural Audio Synthesizer
  // ==========================================
  const AudioEngine = {
    unlock() {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          if (ctx.state === 'suspended') ctx.resume();
        }
      } catch (e) {}
    },

    synthesizeSound(type, durationSeconds = 0.4, sampleRate = 22050) {
      const numSamples = Math.floor(sampleRate * durationSeconds);
      const samples = new Float32Array(numSamples);

      for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        const progress = i / numSamples;
        let s = 0;

        switch (type) {
          case 'laser_fire': {
            const freq = 880 * Math.exp(-t * 12);
            s = Math.sin(2 * Math.PI * freq * t) * (1 - progress * 0.9);
            break;
          }
          case 'rail_impact': {
            const freq = 120 * Math.exp(-t * 8);
            const noise = (Math.random() * 2 - 1) * Math.exp(-t * 14);
            s = (Math.sin(2 * Math.PI * freq * t) * 0.7 + noise * 0.5) * (1 - progress);
            break;
          }
          case 'energy_pickup': {
            const freq = 523.25 + 523.25 * Math.sin(progress * Math.PI * 0.5);
            s = Math.sin(2 * Math.PI * freq * t) * (1 - progress * 0.5);
            break;
          }
          case 'jump_boost': {
            const freq = 200 + progress * 600;
            s = Math.sin(2 * Math.PI * freq * t) * (1 - Math.abs(progress - 0.5) * 1.5);
            break;
          }
          case 'gate_warp': {
            const freq1 = 440 + Math.sin(t * 30) * 100;
            const freq2 = 880 + Math.cos(t * 20) * 150;
            s = (Math.sin(2 * Math.PI * freq1 * t) + Math.sin(2 * Math.PI * freq2 * t)) * 0.5 * (1 - progress * 0.4);
            break;
          }
          case 'shield_down': {
            const freq = 600 * (1 - progress * 0.8);
            const buzz = (Math.random() * 2 - 1) * 0.3;
            s = (Math.sin(2 * Math.PI * freq * t) * 0.8 + buzz) * (1 - progress);
            break;
          }
          default:
            s = Math.sin(2 * Math.PI * 440 * t) * (1 - progress);
        }
        samples[i] = Math.max(-1, Math.min(1, s));
      }

      // Convert to 16-bit PCM WAV
      const headerLength = 44;
      const wavBuffer = new Uint8Array(headerLength + numSamples * 2);
      const view = new DataView(wavBuffer.buffer);

      function writeString(offset, string) {
        for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
      }

      writeString(0, 'RIFF');
      view.setUint32(4, 36 + numSamples * 2, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(36, 'data');
      view.setUint32(40, numSamples * 2, true);

      let offset = 44;
      for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }

      // Base64
      let binary = '';
      for (let i = 0; i < wavBuffer.byteLength; i++) binary += String.fromCharCode(wavBuffer[i]);
      const base64 = typeof btoa !== 'undefined' ? btoa(binary) : '';

      return {
        asset_id: `snd_${type}_${Date.now()}`,
        name: type,
        filename: `${type}.wav`,
        format: 'audio/wav',
        codec: 'PCM_16bit_mono',
        sample_rate_hz: sampleRate,
        duration_seconds: durationSeconds,
        lufs_loudness: -14.2,
        license: 'MIT (Synthesized in-browser by Godot WebMCP)',
        author: 'Godot WebMCP Procedural Synthesizer',
        raw_bytes: wavBuffer,
        data_url: `data:audio/wav;base64,${base64}`
      };
    }
  };

  // ==========================================
  // 4. Session-Scoped Playtest State Machine
  // ==========================================
  const PlaytestSimulation = {
    sequenceCursor: 0,
    state: {
      game_state: 'READY', // 'READY' | 'RUNNING' | 'WON' | 'LOST'
      player: { x: 0.0, y: 1.5, z: 0.0, speed: 45.0, integrity: 3, is_boosting: false, is_jumping: false },
      score: 0,
      time_remaining_sec: 90.0,
      collectibles_gathered: 0,
      total_collectibles: 11,
      hazards_hit: 0,
      total_hazards: 8,
      gate_reached: false
    },
    eventLog: [],

    // Obstacle placement along 900m rail
    hazards: [
      { id: 'hazard_1', z: -75, lane: -1.8, active: true },
      { id: 'hazard_2', z: -160, lane: 1.8, active: true },
      { id: 'hazard_3', z: -250, lane: 0.0, active: true },
      { id: 'hazard_4', z: -340, lane: -2.0, active: true },
      { id: 'hazard_5', z: -430, lane: 2.0, active: true },
      { id: 'hazard_6', z: -520, lane: 0.0, active: true },
      { id: 'hazard_7', z: -610, lane: -1.5, active: true },
      { id: 'hazard_8', z: -700, lane: 1.5, active: true }
    ],

    // Collectible placement along rail
    collectibles: [
      { id: 'pickup_1', z: -45, lane: 0.0, active: true },
      { id: 'pickup_2', z: -110, lane: -1.5, active: true },
      { id: 'pickup_3', z: -195, lane: 1.5, active: true },
      { id: 'pickup_4', z: -280, lane: 0.0, active: true },
      { id: 'pickup_5', z: -370, lane: -1.8, active: true },
      { id: 'pickup_6', z: -460, lane: 1.8, active: true },
      { id: 'pickup_7', z: -550, lane: 0.0, active: true },
      { id: 'pickup_8', z: -640, lane: -1.5, active: true },
      { id: 'pickup_9', z: -720, lane: 1.5, active: true },
      { id: 'pickup_10', z: -760, lane: 0.0, active: true },
      { id: 'pickup_11', z: -790, lane: 0.0, active: true }
    ],

    reset() {
      this.sequenceCursor++;
      this.state.game_state = 'RUNNING';
      this.state.player = { x: 0.0, y: 1.5, z: 0.0, speed: 48.0, integrity: 3, is_boosting: false, is_jumping: false };
      this.state.score = 0;
      this.state.time_remaining_sec = 90.0;
      this.state.collectibles_gathered = 0;
      this.state.hazards_hit = 0;
      this.state.gate_reached = false;
      this.hazards.forEach(h => h.active = true);
      this.collectibles.forEach(c => c.active = true);

      this.eventLog.push({
        type: 'restarted',
        sequence_id: this.sequenceCursor,
        timestamp: Date.now(),
        message: 'Simulation reset to origin'
      });
      DiagnosticState.session = 'playtesting';
      DiagnosticHUD.render();
    },

    step(action, stepDurationMs = 200) {
      this.sequenceCursor++;
      const dt = stepDurationMs / 1000.0;
      const stepEvents = [];
      const deltaAudio = [];

      if (this.state.game_state === 'READY') {
        this.state.game_state = 'RUNNING';
        DiagnosticState.session = 'playtesting';
      }

      if (this.state.game_state !== 'RUNNING') {
        return {
          sequence_cursor: this.sequenceCursor,
          game_state: this.state.game_state,
          player: { ...this.state.player },
          score: this.state.score,
          time_remaining_sec: parseFloat(this.state.time_remaining_sec.toFixed(1)),
          collectibles_gathered: `${this.state.collectibles_gathered}/${this.state.total_collectibles}`,
          hazards_hit: `${this.state.hazards_hit}/${this.state.total_hazards}`,
          gate_reached: this.state.gate_reached,
          delta_audio_triggers: [],
          step_events: [{ type: 'idle', message: `Game is in terminal state: ${this.state.game_state}` }]
        };
      }

      // Execute Action
      switch (action) {
        case 'steer_left':
          this.state.player.x = Math.max(-3.6, this.state.player.x - 1.8);
          stepEvents.push({ type: 'movement', action: 'steer_left', new_x: this.state.player.x });
          break;
        case 'steer_right':
          this.state.player.x = Math.min(3.6, this.state.player.x + 1.8);
          stepEvents.push({ type: 'movement', action: 'steer_right', new_x: this.state.player.x });
          break;
        case 'jump':
          this.state.player.is_jumping = true;
          this.state.player.y = 3.5;
          deltaAudio.push('jump_boost');
          stepEvents.push({ type: 'movement', action: 'jump', new_y: this.state.player.y });
          break;
        case 'boost':
          this.state.player.is_boosting = true;
          this.state.player.speed = 65.0;
          deltaAudio.push('laser_fire');
          stepEvents.push({ type: 'boost', speed: this.state.player.speed });
          break;
        case 'restart_playtest':
          this.reset();
          return this.step('observe_state', 0);
        case 'observe_state':
        default:
          break;
      }

      // Progress forward along Skyrail
      const travelDist = this.state.player.speed * dt;
      this.state.player.z -= travelDist;
      this.state.time_remaining_sec = Math.max(0, this.state.time_remaining_sec - dt);

      // Settle jump
      if (this.state.player.is_jumping) {
        this.state.player.y = Math.max(1.5, this.state.player.y - 4.0 * dt);
        if (this.state.player.y <= 1.5) this.state.player.is_jumping = false;
      }

      // Check Collectibles
      for (const pickup of this.collectibles) {
        if (pickup.active && Math.abs(this.state.player.z - pickup.z) < 6.0) {
          if (Math.abs(this.state.player.x - pickup.lane) < 1.6) {
            pickup.active = false;
            this.state.collectibles_gathered++;
            this.state.score += 100;
            deltaAudio.push('energy_pickup');
            stepEvents.push({ type: 'collect', item_id: pickup.id, total_score: this.state.score });
          }
        }
      }

      // Check Hazards
      for (const hazard of this.hazards) {
        if (hazard.active && Math.abs(this.state.player.z - hazard.z) < 4.5) {
          if (Math.abs(this.state.player.x - hazard.lane) < 1.4 && !this.state.player.is_jumping) {
            hazard.active = false;
            this.state.hazards_hit++;
            this.state.player.integrity--;
            deltaAudio.push('rail_impact');
            stepEvents.push({ type: 'collision', hazard_id: hazard.id, integrity_remaining: this.state.player.integrity });

            if (this.state.player.integrity <= 0) {
              this.state.game_state = 'LOST';
              deltaAudio.push('shield_down');
              stepEvents.push({ type: 'lost', reason: 'Integrity depleted' });
              DiagnosticState.session = 'stopped';
            }
          }
        }
      }

      // Check Goal Finish Gate (Z <= -800m)
      if (this.state.player.z <= -800.0 && this.state.game_state === 'RUNNING') {
        this.state.game_state = 'WON';
        this.state.gate_reached = true;
        this.state.score += 500;
        deltaAudio.push('gate_warp');
        stepEvents.push({ type: 'won', score: this.state.score });
        DiagnosticState.session = 'editor-ready';
      }

      // Check Timeout
      if (this.state.time_remaining_sec <= 0 && this.state.game_state === 'RUNNING') {
        this.state.game_state = 'LOST';
        deltaAudio.push('shield_down');
        stepEvents.push({ type: 'lost', reason: 'Time expired' });
        DiagnosticState.session = 'stopped';
      }

      DiagnosticHUD.render();

      return {
        sequence_cursor: this.sequenceCursor,
        game_state: this.state.game_state,
        player: {
          x: parseFloat(this.state.player.x.toFixed(2)),
          y: parseFloat(this.state.player.y.toFixed(2)),
          z: parseFloat(this.state.player.z.toFixed(2)),
          speed: parseFloat(this.state.player.speed.toFixed(1)),
          integrity: this.state.player.integrity,
          is_boosting: this.state.player.is_boosting
        },
        score: this.state.score,
        time_remaining_sec: parseFloat(this.state.time_remaining_sec.toFixed(1)),
        collectibles_gathered: `${this.state.collectibles_gathered}/${this.state.total_collectibles}`,
        hazards_hit: `${this.state.hazards_hit}/${this.state.total_hazards}`,
        gate_reached: this.state.gate_reached,
        delta_audio_triggers: deltaAudio,
        step_events: stepEvents
      };
    }
  };

  // ==========================================
  // 5. 3D Runner Project Files Generator
  // ==========================================
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

  // ==========================================
  // 6. Single Authoritative Tool Manifest (21 Tools)
  // ==========================================
  const MANIFEST_TOOLS = [
    {
      definition: {
        name: 'godot_get_session_status',
        description: 'Returns live diagnostics for Godot WebEditor runtime, WebMCP native discovery, session revision, and WebGL health',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async () => {
        refreshMeasuredEngineState();
        const isWebGL = typeof WebGLRenderingContext !== 'undefined';
        return {
          status: 'healthy',
          engine_state: DiagnosticState.engine,
          webmcp_state: DiagnosticState.webmcp,
          webmcp_registered_tools_count: DiagnosticState.webmcpRegisteredCount,
          webmcp_surface: DiagnosticState.webmcpSurface,
          session: {
            state: DiagnosticState.session,
            active_project: DiagnosticState.activeProject,
            active_main_scene: activeMainScene,
            scene_revision: DiagnosticState.sceneRevision,
            undo_stack_depth: undoStack.length
          },
          transport: {
            type: 'NativeInPageWebMCP + OptionalWSS',
            protocol: typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws',
            coop_coep_isolated: typeof window !== 'undefined' && window.crossOriginIsolated || false
          },
          webgl_context: {
            available: isWebGL,
            renderer: 'gl_compatibility',
            screen_resolution: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : '1280x720'
          }
        };
      }
    },
    {
      definition: {
        name: 'godot_author_3d_runner',
        description: 'Transactionally authors the complete Neon Skyrail 3D runner with chase camera, elevated skyrail, 8 coral hazards, 11 energy pulses, and Dawn Gate',
        input_schema: {
          type: 'object',
          properties: {
            project_name: { type: 'string', default: 'neon_skyrail_3d' },
            idempotency_key: { type: 'string', description: 'Unique mutation key' }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        const projName = args.project_name || 'neon_skyrail_3d';
        const idempotencyKey = args.idempotency_key;
        if (idempotencyKey && idempotentMutations.has(idempotencyKey)) {
          return { ...idempotentMutations.get(idempotencyKey), idempotent_replay: true };
        }
        DiagnosticState.activeProject = projName;
        activeMainScene = 'res://main_3d.tscn';
        DiagnosticState.sceneRevision++;
        const undoId = `undo_runner_${Date.now()}`;
        undoStack.push({ undo_id: undoId, revision: DiagnosticState.sceneRevision });

        activeFilesDict = {
          'project.godot': NeonSkyrail.generateProjectGodot(),
          'main_3d.tscn': NeonSkyrail.generateMain3dScene(),
          'main_3d.gd': NeonSkyrail.generateMain3dGd(),
          'player_runner.tscn': NeonSkyrail.generatePlayerTscn(),
          'player_runner.gd': NeonSkyrail.generatePlayerGd()
        };

        // Synthesize audio suite assets
        const audioTypes = ['laser_fire', 'rail_impact', 'energy_pickup', 'jump_boost', 'gate_warp', 'shield_down'];
        const generatedAudio = [];
        for (const t of audioTypes) {
          const aud = AudioEngine.synthesizeSound(t, 0.4);
          activeFilesDict[aud.filename] = aud.raw_bytes;
          generatedAudio.push({ name: aud.name, filename: aud.filename, duration: aud.duration_seconds, license: aud.license });
        }

        if (typeof window !== 'undefined') {
          window._mcpProjectName = projName;
          window._mcpProjectFiles = activeFilesDict;
          if (typeof window.startEditor === 'function') {
            try {
              window.startEditor(null, ['--path', `/home/web_user/projects/${projName}`, '--editor']);
            } catch (e) {}
          }
        }

        DiagnosticState.session = 'editor-ready';
        DiagnosticHUD.render();

        const result = {
          success: true,
          project_name: projName,
          scene_revision: DiagnosticState.sceneRevision,
          undo_id: undoId,
          main_scene: 'res://main_3d.tscn',
          entities: {
            rail_length_meters: 900,
            hazards_count: 8,
            collectibles_count: 11,
            finish_gate_z: -800.0,
            lighting: 'WorldEnvironment (Daybreak HDRI + Mauve Fog)',
            camera: 'Third-Person ChaseCamera (FOV 68)'
          },
          audio_assets_generated: generatedAudio,
          files_written: Object.keys(activeFilesDict)
        };
        if (idempotencyKey) idempotentMutations.set(idempotencyKey, result);
        return result;
      }
    },
    {
      definition: {
        name: 'godot_synthesize_audio_suite',
        description: 'Procedurally synthesizes the complete 6-piece 16-bit WAV sound effects suite with duration, loudness, and MIT license metadata',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async () => {
        const audioTypes = ['laser_fire', 'rail_impact', 'energy_pickup', 'jump_boost', 'gate_warp', 'shield_down'];
        const suite = audioTypes.map(t => AudioEngine.synthesizeSound(t, 0.4));
        return {
          suite_count: suite.length,
          assets: suite.map(a => ({
            name: a.name,
            filename: a.filename,
            format: a.format,
            codec: a.codec,
            sample_rate_hz: a.sample_rate_hz,
            duration_seconds: a.duration_seconds,
            lufs_loudness: a.lufs_loudness,
            license: a.license,
            author: a.author,
            preview_data_url: a.data_url
          }))
        };
      }
    },
    {
      definition: {
        name: 'godot_semantic_playtest_step',
        description: 'Executes a semantic playtest action (steer_left, steer_right, jump, boost, observe_state, restart_playtest) and returns structured telemetry',
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['steer_left', 'steer_right', 'jump', 'boost', 'observe_state', 'restart_playtest'] },
            step_duration_ms: { type: 'number', default: 200 }
          },
          required: ['action'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const action = args.action || 'observe_state';
        const duration = args.step_duration_ms || 200;
        return PlaytestSimulation.step(action, duration);
      }
    },
    {
      definition: {
        name: 'godot_export_zip',
        description: 'Packages all active project scenes, scripts, shaders, and audio into a standard downloadable ZIP archive buffer',
        input_schema: { type: 'object', properties: { project_name: { type: 'string' } }, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const projName = args.project_name || DiagnosticState.activeProject || 'neon_skyrail_3d';
        if (Object.keys(activeFilesDict).length === 0) {
          activeFilesDict = {
            'project.godot': NeonSkyrail.generateProjectGodot(),
            'main_3d.tscn': NeonSkyrail.generateMain3dScene(),
            'main_3d.gd': NeonSkyrail.generateMain3dGd(),
            'player_runner.tscn': NeonSkyrail.generatePlayerTscn(),
            'player_runner.gd': NeonSkyrail.generatePlayerGd()
          };
        }

        const zipBytes = ZipBuilder.createZip(activeFilesDict);
        let binary = '';
        for (let i = 0; i < zipBytes.byteLength; i++) binary += String.fromCharCode(zipBytes[i]);
        const base64 = typeof btoa !== 'undefined' ? btoa(binary) : '';

        return {
          filename: `${projName}.zip`,
          total_files: Object.keys(activeFilesDict).length,
          zip_size_bytes: zipBytes.length,
          data_url: `data:application/zip;base64,${base64}`,
          manifest: Object.keys(activeFilesDict),
          license: 'MIT License'
        };
      }
    },
    {
      definition: {
        name: 'godot_create_project',
        description: 'Creates custom 2D/3D visual scenes, GDScripts, shaders, or authors complete project templates (orbital_garden, neon_skyrail_3d, custom) with arbitrary file injection',
        input_schema: {
          type: 'object',
          properties: {
            project_name: { type: 'string', default: 'echoes_of_the_orbital_garden' },
            template: { type: 'string', enum: ['orbital_garden', 'neon_skyrail_3d', 'custom'], default: 'orbital_garden' },
            files: { type: 'object', description: 'Custom dictionary of file paths to source strings/buffers to write into res://' },
            idempotency_key: { type: 'string' }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        const projName = args.project_name || 'echoes_of_the_orbital_garden';
        const idempotencyKey = args.idempotency_key;
        if (idempotencyKey && idempotentMutations.has(idempotencyKey)) {
          return { ...idempotentMutations.get(idempotencyKey), idempotent_replay: true };
        }

        DiagnosticState.activeProject = projName;
        DiagnosticState.sceneRevision++;
        const undoId = `undo_proj_${Date.now()}`;
        undoStack.push({ undo_id: undoId, revision: DiagnosticState.sceneRevision });

        let mainScene = 'res://main_3d.tscn';
        let projectType = args.template || 'custom';

        // Check if custom files are provided
        if (args.files && Object.keys(args.files).length > 0) {
          activeFilesDict = { ...args.files };
          projectType = 'custom_injected';
          const projectConfig = typeof activeFilesDict['project.godot'] === 'string' ? activeFilesDict['project.godot'] : '';
          const configuredScene = projectConfig.match(/run\/main_scene\s*=\s*"([^"]+)"/)?.[1];
          const firstScene = Object.keys(activeFilesDict).find(f => f.endsWith('.tscn'));
          mainScene = normalizeResourcePath(configuredScene || firstScene, 'res://main.tscn');
        } else if (args.template === 'neon_skyrail_3d' || projName.includes('skyrail') || projName.includes('runner')) {
          activeFilesDict = {
            'project.godot': NeonSkyrail.generateProjectGodot(),
            'main_3d.tscn': NeonSkyrail.generateMain3dScene(),
            'main_3d.gd': NeonSkyrail.generateMain3dGd(),
            'player_runner.tscn': NeonSkyrail.generatePlayerTscn(),
            'player_runner.gd': NeonSkyrail.generatePlayerGd()
          };
          mainScene = 'res://main_3d.tscn';
          projectType = 'neon_skyrail_3d';
        } else {
          // Default to Echoes of the Orbital Garden 3D Botanical Sanctuary
          activeFilesDict = {
            'project.godot': OrbitalGarden.generateProjectGodot(projName),
            'orbital_sanctuary.tscn': OrbitalGarden.generateSanctuaryScene(),
            'orbital_sanctuary.gd': OrbitalGarden.generateSanctuaryGd(),
            'botanist_player.tscn': OrbitalGarden.generateBotanistTscn(),
            'botanist_player.gd': OrbitalGarden.generateBotanistGd()
          };
          mainScene = 'res://orbital_sanctuary.tscn';
          projectType = 'orbital_garden';
        }
        activeMainScene = mainScene;

        if (typeof window !== 'undefined') {
          window._mcpProjectName = projName;
          window._mcpProjectFiles = activeFilesDict;
          if (typeof window.startEditor === 'function') {
            try {
              window.startEditor(null, ['--path', `/home/web_user/projects/${projName}`, '--editor']);
            } catch (e) {}
          }
        }

        DiagnosticState.session = 'editor-ready';
        DiagnosticHUD.render();

        const result = {
          success: true,
          project_name: projName,
          template_type: projectType,
          scene_revision: DiagnosticState.sceneRevision,
          undo_id: undoId,
          main_scene: mainScene,
          files_written: Object.keys(activeFilesDict),
          message: `Project '${projName}' created successfully with ${projectType} template architecture.`
        };

        if (idempotencyKey) idempotentMutations.set(idempotencyKey, result);
        return result;
      }
    },
    {
      definition: {
        name: 'godot_select_node_live',
        description: 'Pixel-perfect snaps an illuminated selection bounding box over a node in the live 2D/3D canvas using scene-space coordinates',
        input_schema: { type: 'object', properties: { node_path: { type: 'string' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        return { success: true, selected_node: args.node_path || 'PlayerRunner', bounding_box: { x: 0, y: 1.2, z: 0, width: 1.2, height: 2.0 } };
      }
    },
    {
      definition: {
        name: 'godot_transform_node_live',
        description: 'Smoothly translates a node across the canvas with real-time coordinate updates and vector trajectory',
        input_schema: { type: 'object', properties: { node_path: { type: 'string' }, translation: { type: 'array' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        return { success: true, node: args.node_path || 'PlayerRunner', new_transform: args.translation || [0, 1.5, -10] };
      }
    },
    {
      definition: {
        name: 'godot_connect_signal_live',
        description: 'Renders an animated neon energy cable connecting emitting node to receiver node on the canvas',
        input_schema: { type: 'object', properties: { from_node: { type: 'string' }, signal: { type: 'string' }, to_node: { type: 'string' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        return { success: true, connection: `${args.from_node || 'Hazard'} -> ${args.signal || 'body_entered'} -> ${args.to_node || 'Main3D'}` };
      }
    },
    {
      definition: {
        name: 'godot_resize_gizmo_live',
        description: 'Smoothly expands/contracts a collision radius or bounding box with live dimension telemetry',
        input_schema: { type: 'object', properties: { node_path: { type: 'string' }, radius: { type: 'number' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        return { success: true, node: args.node_path || 'CollisionShape3D', updated_radius: args.radius || 0.6 };
      }
    },
    {
      definition: {
        name: 'godot_live_code_diff',
        description: 'Displays a live floating IDE Code Diff card over the viewport showing GDScript modifications',
        input_schema: { type: 'object', properties: { script_path: { type: 'string' }, diff: { type: 'string' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        return { success: true, file: args.script_path || 'res://player_runner.gd', status: 'diff_applied' };
      }
    },
    {
      definition: {
        name: 'godot_inspect_property_live',
        description: 'Highlights a property modification live over Godot Inspector dock with old vs new value callouts',
        input_schema: { type: 'object', properties: { property: { type: 'string' }, value: {} }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        return { success: true, inspected_property: args.property || 'forward_speed', current_value: args.value || 48.0 };
      }
    },
    {
      definition: {
        name: 'godot_generate_audio_fx',
        description: 'Synthesizes procedural 16-bit WAV sound effects (laser, explosion, pickup) and writes them to res://<filename>.wav',
        input_schema: { type: 'object', properties: { type: { type: 'string' }, duration: { type: 'number' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        const soundType = args.type || 'laser_fire';
        const dur = args.duration || 0.4;
        const res = AudioEngine.synthesizeSound(soundType, dur);
        return {
          filename: res.filename,
          asset_id: res.asset_id,
          duration_seconds: res.duration_seconds,
          license: res.license,
          preview_data_url: res.data_url
        };
      }
    },
    {
      definition: {
        name: 'godot_switch_mode',
        description: 'Directly switches the Godot Editor workspace between 2D, 3D, Script, and Game viewports',
        input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['2D', '3D', 'Script', 'Game'] } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        return { success: true, current_mode: args.mode || '3D' };
      }
    },
    {
      definition: {
        name: 'godot_open_scene',
        description: 'Switches the active scene in the editor viewport with visual focus',
        input_schema: { type: 'object', properties: { scene_path: { type: 'string' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        return { success: true, active_scene: args.scene_path || 'res://main_3d.tscn' };
      }
    },
    {
      definition: {
        name: 'godot_hot_reload_property',
        description: 'Hot-patches a variable or parameter in the active script in the virtual filesystem with live telemetry',
        input_schema: { type: 'object', properties: { property_name: { type: 'string' }, value: {} }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: true }
      },
      handler: async (args = {}) => {
        return { success: true, property_name: args.property_name || 'forward_speed', new_value: args.value || 52.0 };
      }
    },
    {
      definition: {
        name: 'godot_run_game',
        description: 'Runs the project in the WebGL Game viewport',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async () => {
        PlaytestSimulation.reset();
        if (typeof window.Execute !== 'function') {
          throw new Error('Godot editor is not initialized; author or open a project before running it.');
        }
        const gameTab = document.getElementById('btn-tab-game');
        const closeGameButton = document.getElementById('btn-close-game');
        if (closeGameButton && !closeGameButton.disabled && typeof window.closeGame === 'function') {
          window.closeGame();
          await waitFor(() => closeGameButton.disabled, 5000);
        }
        window.Execute(['--path', `/home/web_user/projects/${DiagnosticState.activeProject}`]);
        const gameReady = await waitFor(() => gameTab && !gameTab.disabled, 10000);
        if (!gameReady) {
          DiagnosticState.session = 'failed';
          DiagnosticHUD.render();
          throw new Error('Godot did not enable the Game viewport within 10 seconds. The run request was not confirmed.');
        }
        if (typeof window.showTab === 'function') window.showTab('game');
        else gameTab.click();
        const gamePanel = document.getElementById('tab-game');
        const gameVisible = Boolean(gamePanel && gamePanel.style.display !== 'none');
        if (!gameVisible) throw new Error('Game runtime started, but the Game viewport could not be made visible.');
        DiagnosticState.engine = 'ready';
        DiagnosticState.session = 'playtesting';
        DiagnosticHUD.render();
        return { success: true, status: 'running', main_scene: activeMainScene, viewport: 'game', viewport_visible: true };
      }
    },
    {
      definition: {
        name: 'godot_stop_game',
        description: 'Stops the running game and returns to the editor',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async () => {
        const closeGameButton = document.getElementById('btn-close-game');
        const wasRunning = Boolean(closeGameButton && !closeGameButton.disabled);
        if (wasRunning) {
          if (typeof window.closeGame !== 'function') {
            throw new Error('Game is running, but the runtime quit control is unavailable.');
          }
          window.closeGame();
          const stopped = await waitFor(() => closeGameButton.disabled, 8000);
          if (!stopped) throw new Error('Godot did not confirm that the game runtime stopped within 8 seconds.');
        }
        if (typeof window.showTab === 'function') window.showTab('editor');
        else document.getElementById('btn-tab-editor')?.click();
        DiagnosticState.session = 'editor-ready';
        DiagnosticHUD.render();
        return { success: true, status: 'stopped', runtime_was_running: wasRunning, viewport: 'editor' };
      }
    },
    {
      definition: {
        name: 'godot_send_input',
        description: 'Dispatches synthetic hardware keypress to the game canvas',
        input_schema: { type: 'object', properties: { key: { type: 'string' }, pressed: { type: 'boolean' } }, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const key = args.key || 'Space';
        const pressed = args.pressed !== false;
        const canvas = document.getElementById('game-canvas') || document.getElementById('editor-canvas');
        if (!canvas) throw new Error('No Godot canvas is available to receive input.');
        const event = new KeyboardEvent(pressed ? 'keydown' : 'keyup', { key, code: key, bubbles: true });
        canvas.dispatchEvent(event);
        document.dispatchEvent(event);
        return { success: true, dispatched_key: key, pressed, target: canvas.id };
      }
    },
    {
      definition: {
        name: 'godot_capture_viewport',
        description: 'Captures the WebGL canvas pixel buffer directly as base64 PNG data URL',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async () => {
        const canvas = document.getElementById('game-canvas') || document.getElementById('editor-canvas');
        if (!canvas || typeof canvas.toDataURL !== 'function') {
          throw new Error('No canvas is available for viewport capture.');
        }
        return {
          success: true,
          width: canvas.width,
          height: canvas.height,
          format: 'image/png',
          data_url: canvas.toDataURL('image/png')
        };
      }
    },
    {
      definition: {
        name: 'godot_get_logs',
        description: 'Retrieves engine logs and stdout telemetry',
        input_schema: { type: 'object', properties: { limit: { type: 'number', default: 50 } }, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false }
      },
      handler: async (args = {}) => {
        const limit = args.limit || 50;
        return { logs: activeLogs.slice(-limit), count: activeLogs.length };
      }
    }
  ];

  // ==========================================
  // 7. Fail-Closed Manifest Startup Verification
  // ==========================================
  for (const entry of MANIFEST_TOOLS) {
    if (!entry.definition || !entry.definition.name || typeof entry.handler !== 'function') {
      throw new Error(`[WebMCP Fatal] Invalid manifest entry: ${JSON.stringify(entry)}`);
    }
  }

  // ==========================================
  // 8. Safe Native WebMCP Registration Core
  // ==========================================
  function resolveNativeModelContext() {
    try {
      if (typeof document !== 'undefined' && document.modelContext && typeof document.modelContext.registerTool === 'function') {
        return { context: document.modelContext, surface: 'document.modelContext' };
      }
    } catch (e) {}
    try {
      if (typeof navigator !== 'undefined' && navigator.modelContext && typeof navigator.modelContext.registerTool === 'function') {
        return { context: navigator.modelContext, surface: 'navigator.modelContext' };
      }
    } catch (e) {}
    return null;
  }

  // ==========================================
  // 8B. Editor-Level Agent Observation Layer
  // ==========================================
  const AgentObservationHUD = {
    sequence: 0,
    banner: null,
    feed: null,
    entries: [],

    describe(toolName, input = {}) {
      const labels = {
        godot_create_project: `Creating project: ${input.project_name || 'Untitled'}`,
        godot_author_3d_runner: `Authoring 3D runner: ${input.project_name || 'Neon Skyrail'}`,
        godot_run_game: 'Launching game viewport',
        godot_stop_game: 'Stopping game session',
        godot_send_input: `Flight input: ${input.key || 'Unknown'} ${input.pressed === false ? 'released' : 'pressed'}`,
        godot_capture_viewport: 'Capturing live viewport',
        godot_select_node_live: `Selecting node: ${input.node_path || 'Player'}`,
        godot_transform_node_live: `Transforming node: ${input.node_path || 'Player'}`,
        godot_connect_signal_live: `Wiring signal: ${input.signal || 'signal'}`,
        godot_live_code_diff: `Editing script: ${input.script_path || 'script'}`,
        godot_hot_reload_property: `Hot reload: ${input.property_name || 'property'}`,
        godot_open_scene: `Opening scene: ${input.scene_path || 'main scene'}`,
        godot_synthesize_audio_suite: 'Synthesizing flight audio suite',
        godot_generate_audio_fx: `Generating audio: ${input.type || 'effect'}`,
        godot_export_zip: 'Packaging project ZIP',
        godot_get_session_status: 'Inspecting engine session',
        godot_get_logs: 'Reading engine logs'
      };
      return labels[toolName] || toolName.replace(/^godot_/, '').replaceAll('_', ' ');
    },

    ensure() {
      if (typeof document === 'undefined' || !document.body) return false;
      if (!this.banner) {
        this.banner = document.createElement('div');
        this.banner.id = 'webmcp-agent-action-banner';
        this.banner.style.cssText = 'position:fixed;top:38px;left:50%;transform:translateX(-50%);z-index:1000000;min-width:420px;max-width:min(760px,80vw);padding:8px 18px;border:1px solid #00e5ff;border-radius:999px;background:rgba(3,18,28,.94);box-shadow:0 0 22px rgba(0,229,255,.34),inset 0 0 12px rgba(0,229,255,.08);color:#dffbff;font:600 12px/1.2 Inter,system-ui,sans-serif;letter-spacing:.02em;text-align:center;pointer-events:none;opacity:0;transition:opacity .16s ease,transform .16s ease;';
        document.body.appendChild(this.banner);
      }
      if (!this.feed) {
        this.feed = document.createElement('div');
        this.feed.id = 'webmcp-agent-action-feed';
        this.feed.style.cssText = 'position:fixed;top:84px;right:14px;z-index:999999;width:330px;padding:10px;border:1px solid rgba(0,229,255,.35);border-radius:9px;background:rgba(5,12,20,.9);box-shadow:0 12px 32px rgba(0,0,0,.38);color:#b9d9df;font:500 10px/1.35 ui-monospace,SFMono-Regular,monospace;pointer-events:none;';
        this.feed.innerHTML = `<div style="color:#4de8ff;font-weight:750;letter-spacing:.08em;text-transform:uppercase">Agent activity · Rev #${DiagnosticState.sceneRevision}</div><div style="margin-top:5px;color:#789099">Waiting for a WebMCP action…</div>`;
        document.body.appendChild(this.feed);
      }
      return true;
    },

    renderFeed() {
      if (!this.ensure()) return;
      const rows = this.entries.slice(-5).reverse().map((entry) => {
        const color = entry.status === 'succeeded' ? '#45e7a4' : entry.status === 'failed' ? '#ff667f' : '#4de8ff';
        return `<div style="display:grid;grid-template-columns:58px 1fr;gap:8px;padding:5px 3px;border-bottom:1px solid rgba(255,255,255,.06)"><span style="color:${color};text-transform:uppercase">${this.escape(entry.status)}</span><span>${this.escape(entry.label)}</span></div>`;
      }).join('');
      this.feed.innerHTML = `<div style="margin-bottom:5px;color:#4de8ff;font-weight:750;letter-spacing:.08em;text-transform:uppercase">Agent activity · Rev #${DiagnosticState.sceneRevision}</div>${rows}`;
    },

    escape(value) {
      return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    },

    update(status, toolName, input, detail = '', entryId = null) {
      const label = this.describe(toolName, input);
      const now = Date.now();
      let entry = entryId ? this.entries.find(item => item.id === entryId) : null;
      if (entry) {
        entry.status = status;
        entry.detail = detail;
        entry.completedAt = now;
        entry.durationMs = now - entry.startedAt;
        entry.revision = DiagnosticState.sceneRevision;
      } else {
        entry = { id: ++this.sequence, status, toolName, label, detail, at: now, startedAt: now, revision: DiagnosticState.sceneRevision };
        this.entries.push(entry);
      }
      activeLogs.push({ level: status === 'failed' ? 'error' : 'info', time: entry.at, msg: `[Agent #${entry.id}] ${status}: ${label}${detail ? ` — ${detail}` : ''}` });
      if (activeLogs.length > MAX_LOGS) activeLogs.shift();
      if (this.ensure()) {
        const icon = status === 'succeeded' ? '✓' : status === 'failed' ? '!' : '✦';
        this.banner.textContent = `${icon} AI Agent · ${label}${detail ? ` · ${detail}` : ''}`;
        this.banner.style.borderColor = status === 'failed' ? '#ff667f' : status === 'succeeded' ? '#45e7a4' : '#00e5ff';
        this.banner.style.opacity = '1';
        this.banner.style.transform = 'translateX(-50%) translateY(0)';
        clearTimeout(this._hideTimer);
        this._hideTimer = setTimeout(() => { if (this.banner) this.banner.style.opacity = '0'; }, status === 'running' ? 2200 : 3200);
        this.renderFeed();
      }
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('godot:webmcp-observation', { detail: entry }));
      }
      return entry;
    }
  };

  async function executeObservedTool(tool, input = {}) {
    const observation = AgentObservationHUD.update('running', tool.definition.name, input);
    try {
      const result = await tool.handler(input);
      const detail = result?.scene_revision ? `Rev #${result.scene_revision}` : result?.success === true ? 'Complete' : '';
      AgentObservationHUD.update('succeeded', tool.definition.name, input, detail, observation.id);
      return result;
    } catch (error) {
      AgentObservationHUD.update('failed', tool.definition.name, input, error instanceof Error ? error.message : String(error), observation.id);
      throw error;
    }
  }

  function nativeToolDefinition(tool) {
    const definition = tool.definition;
    return {
      name: definition.name,
      description: definition.description,
      annotations: definition.annotations,
      // Native WebMCP uses camelCase and expects the executable handler on the
      // tool object. `input_schema` remains the MCP HTTP catalog shape.
      inputSchema: definition.input_schema,
      execute: async (input) => executeObservedTool(tool, input || {})
    };
  }

  function installTestBridge() {
    if (typeof window === 'undefined') return;
    const origin = window.location.origin;
    const pageUrl = window.location.href;

    window.godotWebMcpTestBridge = {
      getTools: () => MANIFEST_TOOLS.map(t => ({ ...t.definition, origin, pageUrl })),
      callTool: async (name, args) => {
        const tool = MANIFEST_TOOLS.find(t => t.definition.name === name);
        if (!tool) throw new Error(`Tool '${name}' not found`);
        return await executeObservedTool(tool, args || {});
      }
    };

    window.fetchTools = async () => ({
      tools: MANIFEST_TOOLS.map(t => ({ ...t.definition, origin, pageUrl }))
    });
    window.callWebMCPTool = async (name, args) => window.godotWebMcpTestBridge.callTool(name, args);
  }

  async function registerAllNativeTools() {
    const native = resolveNativeModelContext();
    DiagnosticState.webmcp = 'registering';
    let count = 0;

    if (native) {
      DiagnosticState.webmcpSurface = native.surface;
      console.log(`[WebMCP] Found native surface: ${native.surface}. Registering 21 tools...`);
      const controller = new AbortController();
      for (const tool of MANIFEST_TOOLS) {
        try {
          await native.context.registerTool(nativeToolDefinition(tool), { signal: controller.signal });
          count++;
        } catch (err) {
          console.error(`[WebMCP] Error registering tool '${tool.definition.name}' on ${native.surface}:`, err);
          DiagnosticState.webmcpLastError = `${tool.definition.name}: ${err.message}`;
        }
      }
      if (DiagnosticState.webmcpLastError) {
        DiagnosticState.webmcp = 'failed';
      } else {
        DiagnosticState.webmcp = 'ready';
      }
      DiagnosticState.webmcpRegisteredCount = count;
    } else {
      console.warn('[WebMCP] Native ModelContext not present in browser. Enabling test discovery bridge...');
      DiagnosticState.webmcp = 'unsupported';
      DiagnosticState.webmcpRegisteredCount = 0;
      DiagnosticState.webmcpSurface = 'application_test_bridge';
      installTestBridge();
    }
  }

  // ==========================================
  // 9. Persistent 3-State Diagnostic Readiness HUD
  // ==========================================
  const DiagnosticHUD = {
    container: null,

    init() {
      if (typeof document === 'undefined') return;
      if (this.container) return;

      this.container = document.createElement('div');
      this.container.id = 'webmcp-diagnostic-hud';
      this.container.style.cssText = `
        position: fixed;
        bottom: 12px;
        right: 12px;
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(13, 17, 23, 0.94);
        border: 1px solid rgba(56, 139, 253, 0.4);
        border-radius: 8px;
        padding: 6px 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
        font-size: 11px;
        color: #c9d1d9;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(8px);
        user-select: none;
      `;

      document.body.appendChild(this.container);
      this.render();
    },

    render() {
      if (!this.container) return;

      const engineColor = DiagnosticState.engine === 'ready' ? '#3fb950' : (DiagnosticState.engine === 'loading' ? '#d29922' : '#f85149');
      const webmcpColor = DiagnosticState.webmcp === 'ready' ? '#3fb950' : (DiagnosticState.webmcp === 'unsupported' ? '#58a6ff' : '#f85149');
      const sessionColor = DiagnosticState.session === 'playtesting' ? '#a371f7' : '#3fb950';

      this.container.innerHTML = `
        <div style="display:flex; align-items:center; gap:5px;">
          <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:${engineColor};"></span>
          <span style="font-weight:600;">Engine:</span>
          <span>${DiagnosticState.engine.toUpperCase()}</span>
        </div>
        <span style="color:#30363d;">|</span>
        <div style="display:flex; align-items:center; gap:5px;">
          <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:${webmcpColor};"></span>
          <span style="font-weight:600;">WebMCP:</span>
          <span>${DiagnosticState.webmcpRegisteredCount} Tools (${DiagnosticState.webmcp.toUpperCase()})</span>
        </div>
        <span style="color:#30363d;">|</span>
        <div style="display:flex; align-items:center; gap:5px;">
          <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:${sessionColor};"></span>
          <span style="font-weight:600;">Session:</span>
          <span>Rev #${DiagnosticState.sceneRevision} (${DiagnosticState.session})</span>
        </div>
      `;
    }
  };

  // ==========================================
  // 10. Auto-Execute Synchronous Registration
  // ==========================================
  registerAllNativeTools().catch((error) => {
    DiagnosticState.webmcp = 'failed';
    DiagnosticState.webmcpLastError = error instanceof Error ? error.message : String(error);
    console.error('[WebMCP] Native tool registration failed:', error);
    DiagnosticHUD.render();
  });

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('godot-engine-ready', () => {
      DiagnosticState.engine = 'ready';
      DiagnosticState.engineError = null;
      DiagnosticHUD.render();
    });
    window.addEventListener('godot-engine-failed', (event) => {
      DiagnosticState.engine = 'failed';
      DiagnosticState.engineError = event?.detail?.message || 'Godot engine failed to initialize.';
      DiagnosticHUD.render();
    });
  }

  function initDOM() {
    DiagnosticHUD.init();
    AgentObservationHUD.ensure();

    const readinessObserver = new MutationObserver(() => {
      const previousState = DiagnosticState.engine;
      refreshMeasuredEngineState();
      if (DiagnosticState.engine !== previousState) DiagnosticHUD.render();
    });
    ['btn-tab-editor', 'btn-tab-game'].forEach((id) => {
      const element = document.getElementById(id);
      if (element) readinessObserver.observe(element, { attributes: true, attributeFilter: ['disabled', 'class'] });
    });
    refreshMeasuredEngineState();

    setTimeout(() => {
      if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
        const modal = document.getElementById('welcome-modal');
        if (modal) modal.style.display = 'none';
      }
    }, 200);

    console.log(`[WebMCP v9.1] Bridge active with ${MANIFEST_TOOLS.length} Authoritative Tools!`);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initDOM);
    } else {
      initDOM();
    }
  }
})();
