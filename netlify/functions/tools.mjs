export const MCP_TOOL_CATALOG = [
  {
    name: 'godot_get_session_status',
    description: 'Returns live diagnostics for Godot WebEditor runtime, WebMCP native discovery, session revision, and WebGL health',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_restore_project_session',
    description: 'Restores the persisted authoritative project into a fresh Godot Editor process after a page reload without changing scene revision or undo history',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
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
    description: 'Packages the active project and an explicit per-file provenance manifest into a standard downloadable ZIP archive',
    input_schema: { type: 'object', properties: { project_name: { type: 'string' }, provenance: { type: 'object' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_begin_project_upload',
    description: 'Begins a transport-safe staged custom-project upload',
    input_schema: { type: 'object', properties: { project_name: { type: 'string' } }, required: ['project_name'], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_upload_project_file_chunk',
    description: 'Appends one bounded UTF-8 or base64 chunk to a staged project file using an exact decoded-byte offset',
    input_schema: {
      type: 'object',
      properties: {
        upload_id: { type: 'string' }, path: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
        offset: { type: 'integer', minimum: 0 }, content: { type: 'string', maxLength: 700000 },
        final: { type: 'boolean', default: false }
      },
      required: ['upload_id', 'path', 'offset', 'content'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_upload_project_chunk_batch',
    description: 'Atomically appends up to four transport-safe project chunks in one call',
    input_schema: {
      type: 'object',
      properties: {
        upload_id: { type: 'string' },
        chunks: {
          type: 'array', minItems: 1, maxItems: 4,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
              offset: { type: 'integer', minimum: 0 }, content: { type: 'string', maxLength: 700000 }, final: { type: 'boolean', default: false }
            },
            required: ['path', 'offset', 'content'], additionalProperties: false
          }
        }
      },
      required: ['upload_id', 'chunks'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_get_project_upload_status',
    description: 'Inspects staged project upload progress without returning uploaded contents',
    input_schema: { type: 'object', properties: { upload_id: { type: 'string' } }, required: ['upload_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_abort_project_upload',
    description: 'Removes one staged project upload and all persisted chunks without changing the active project',
    input_schema: { type: 'object', properties: { upload_id: { type: 'string' } }, required: ['upload_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_commit_project_upload',
    description: 'Validates and transactionally boots a completed staged project',
    input_schema: { type: 'object', properties: { upload_id: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['upload_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
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
    input_schema: { type: 'object', properties: { node_path: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_transform_node_live',
    description: 'Requests a native Godot node transform and fails explicitly without editor acknowledgement',
    input_schema: { type: 'object', properties: { node_path: { type: 'string' }, translation: { type: 'array' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_connect_signal_live',
    description: 'Requests a native Godot signal connection and fails explicitly without editor acknowledgement',
    input_schema: { type: 'object', properties: { from_node: { type: 'string' }, signal: { type: 'string' }, to_node: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_resize_gizmo_live',
    description: 'Requests a native collision-gizmo resize and fails explicitly without editor acknowledgement',
    input_schema: { type: 'object', properties: { node_path: { type: 'string' }, radius: { type: 'number' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_live_code_diff',
    description: 'Legacy diff request that fails explicitly; use revision-checked file transactions',
    input_schema: { type: 'object', properties: { script_path: { type: 'string' }, diff: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_inspect_property_live',
    description: 'Requests a native Inspector property read and fails explicitly without editor acknowledgement',
    input_schema: { type: 'object', properties: { property: { type: 'string' }, value: {} }, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_generate_audio_fx',
    description: 'Synthesizes procedural 16-bit WAV sound effects (laser, explosion, pickup) and writes them to res://<filename>.wav',
    input_schema: { type: 'object', properties: { type: { type: 'string' }, duration: { type: 'number' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_switch_mode',
    description: 'Requests a native Godot workspace switch and fails explicitly without editor acknowledgement',
    input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['2D', '3D', 'Script', 'Game'] } }, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_open_scene',
    description: 'Requests a native scene-open operation and fails explicitly without editor acknowledgement',
    input_schema: { type: 'object', properties: { scene_path: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_hot_reload_property',
    description: 'Legacy property hot reload that fails explicitly; use revision-checked file transactions',
    input_schema: { type: 'object', properties: { property_name: { type: 'string' }, value: {} }, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_run_game',
    description: 'Runs the project in the WebGL Game viewport',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_stop_game',
    description: 'Stops the running game and returns to the editor',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_send_input',
    description: 'Dispatches a keyboard event and reports subsequent project telemetry without claiming unverified gameplay acknowledgement',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' }, pressed: { type: 'boolean' }, duration_ms: { type: 'integer', minimum: 20, maximum: 5000 }, await_telemetry: { type: 'boolean', default: true } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_capture_viewport',
    description: 'Captures the WebGL canvas pixel buffer directly as base64 PNG data URL',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_send_pointer',
    description: 'Dispatches pointer input at Godot canvas coordinates without claiming unverified gameplay acknowledgement',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'down', 'up', 'click', 'wheel'] },
        x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 },
        button: { type: 'string', enum: ['left', 'middle', 'right'], default: 'left' },
        delta_y: { type: 'number', default: 0 }
      },
      required: ['action', 'x', 'y'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_start_recording',
    description: 'Starts a real MediaRecorder capture of the visible Godot game canvas',
    input_schema: {
      type: 'object',
      properties: {
        fps: { type: 'integer', minimum: 10, maximum: 60, default: 30 },
        mime_type: { type: 'string' }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_stop_recording',
    description: 'Stops the active canvas recording, persists it in IndexedDB, and exposes a download link',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_list_recordings',
    description: 'Lists recordings persisted for this deployed origin and restores the newest download link',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_get_logs',
    description: 'Retrieves engine logs and stdout telemetry',
    input_schema: { type: 'object', properties: { limit: { type: 'number', default: 50 } }, additionalProperties: false },
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
