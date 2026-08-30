export const MCP_TOOL_CATALOG = [
  {
    name: 'godot_get_session_status',
    description: 'Returns live diagnostics for Godot WebEditor runtime, WebMCP native discovery, session revision, and WebGL health',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_get_operation_status',
    description: 'Returns status and final results for long-running authoring operations that outlive a browser tool-call deadline',
    input_schema: {
      type: 'object',
      properties: { operation_id: { type: 'string' } },
      additionalProperties: false
    },
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
    description: 'Executes a Neon Skyrail-only semantic playtest action and rejects custom projects instead of returning simulated runner state',
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
    name: 'godot_get_game_telemetry',
    description: 'Reads project-owned runtime telemetry emitted as godot-game-telemetry events; never substitutes simulated state for custom games',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true }
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
    input_schema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', default: 'echoes_of_the_orbital_garden' },
        template: { type: 'string', enum: ['orbital_garden', 'neon_skyrail_3d', 'custom'], default: 'orbital_garden' },
        files: { type: 'object', description: 'Custom dictionary of normalized file paths to source strings or binary buffers' },
        idempotency_key: { type: 'string' }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_inspect_project_files',
    description: 'Inspects the authoritative in-memory project manifest and optionally returns selected text source files for revision-safe editing',
    input_schema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, maxItems: 64 },
        include_content: { type: 'boolean', default: false }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_apply_file_transaction',
    description: 'Revision-checked atomic project edit that restarts the real Godot Editor and records an undo snapshot',
    input_schema: {
      type: 'object',
      properties: {
        expected_revision: { type: 'integer', minimum: 1 },
        label: { type: 'string' },
        operations: {
          type: 'array', minItems: 1, maxItems: 64,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['write', 'delete'] },
              path: { type: 'string' },
              content: { type: 'string' }
            },
            required: ['kind', 'path'],
            additionalProperties: false
          }
        },
        idempotency_key: { type: 'string' }
      },
      required: ['expected_revision', 'operations'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_undo_transaction',
    description: 'Restores the exact project snapshot captured by the most recent acknowledged authoring transaction',
    input_schema: { type: 'object', properties: { undo_id: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_select_node_live',
    description: 'Requests native Godot Editor node selection and fails explicitly when no acknowledged editor command channel is installed',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_transform_node_live',
    description: 'Requests a native Godot node transform and fails explicitly without editor acknowledgement',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_connect_signal_live',
    description: 'Requests a native Godot signal connection and fails explicitly without editor acknowledgement',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_resize_gizmo_live',
    description: 'Requests a native collision-gizmo resize and fails explicitly without editor acknowledgement',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_live_code_diff',
    description: 'Legacy diff request that fails explicitly; use revision-checked file transactions',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_inspect_property_live',
    description: 'Requests a native Inspector property read and fails explicitly without editor acknowledgement',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_generate_audio_fx',
    description: 'Synthesizes procedural 16-bit WAV sound effects (laser, explosion, pickup) and writes them to res://<filename>.wav',
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_switch_mode',
    description: 'Requests a native Godot workspace switch and fails explicitly without editor acknowledgement',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_open_scene',
    description: 'Requests a native scene-open operation and fails explicitly without editor acknowledgement',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_hot_reload_property',
    description: 'Legacy property hot reload that fails explicitly; use revision-checked file transactions',
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
    description: 'Dispatches a keyboard event and reports subsequent project telemetry without claiming unverified gameplay acknowledgement',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' }, pressed: { type: 'boolean' }, await_telemetry: { type: 'boolean', default: true } },
      additionalProperties: false
    },
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
