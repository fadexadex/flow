export const MCP_TOOL_CATALOG = [
  {
    name: 'godot_get_session_status',
    description: 'Returns live diagnostics for Godot WebEditor runtime, WebMCP native discovery, session revision, and WebGL health',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
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
  {
    name: 'godot_synthesize_audio_suite',
    description: 'Procedurally synthesizes the complete 6-piece 16-bit WAV sound effects suite with duration, loudness, and MIT license metadata',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_semantic_playtest_step',
    description: 'Executes a semantic playtest action (steer_left, steer_right, jump, boost, observe_state) and returns structured telemetry',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['steer_left', 'steer_right', 'jump', 'boost', 'observe_state'] },
        step_duration_ms: { type: 'number', default: 200 }
      },
      required: ['action'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_export_zip',
    description: 'Packages all active project scenes, scripts, shaders, and audio into a standard downloadable ZIP archive buffer',
    input_schema: { type: 'object', properties: { project_name: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_create_project',
    description: 'Injects complete 2D/3D visual scenes (.tscn), GDScripts, shaders, and audio into Godot virtual FS and boots Godot Viewport',
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_select_node_live',
    description: 'Pixel-perfect snaps an illuminated selection bounding box over a node in the live 2D/3D canvas using scene-space coordinates',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_transform_node_live',
    description: 'Smoothly translates a node across the canvas with real-time coordinate updates and vector trajectory',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_connect_signal_live',
    description: 'Renders an animated neon energy cable connecting emitting node to receiver node on the canvas',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_resize_gizmo_live',
    description: 'Smoothly expands/contracts a collision radius or bounding box with live dimension telemetry',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_live_code_diff',
    description: 'Displays a live floating IDE Code Diff card over the viewport showing GDScript modifications',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_inspect_property_live',
    description: 'Highlights a property modification live over Godot Inspector dock with old vs new value callouts',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_generate_audio_fx',
    description: 'Synthesizes procedural 16-bit WAV sound effects (laser, explosion, pickup) and writes them to res://<filename>.wav',
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_switch_mode',
    description: 'Directly switches the Godot Editor workspace between 2D, 3D, Script, and Game viewports',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_open_scene',
    description: 'Switches the active scene in the editor viewport with visual focus',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_hot_reload_property',
    description: 'Hot-patches a variable or parameter in the active script in the virtual filesystem with live telemetry',
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_run_game',
    description: 'Runs the project in the WebGL Game viewport',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_stop_game',
    description: 'Stops the running game and returns to the editor',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_send_input',
    description: 'Dispatches synthetic hardware keypress to the game canvas',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_capture_viewport',
    description: 'Captures the WebGL canvas pixel buffer directly as base64 PNG data URL',
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_get_logs',
    description: 'Retrieves engine logs and stdout telemetry',
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  }
];

export default async (req, context) => {
  return new Response(JSON.stringify({ tools: MCP_TOOL_CATALOG }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
};
