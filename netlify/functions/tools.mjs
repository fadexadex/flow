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
      properties: {
        operation_id: { type: 'string', description: 'Specific operation ID; omit to inspect the active and recent operations' },
        after_sequence: { type: 'integer', description: 'Return immediately if operation sequence is newer than this value' },
        wait_ms: { type: 'integer', minimum: 0, maximum: 15000, default: 5000, description: 'Max ms to wait for a change before returning' }
      },
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
    name: 'godot_inspect_scene_graph',
    description: 'Returns durable authored scene nodes so collaborators can distinguish editable 3D objects from runtime-only script output',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
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
    name: 'godot_apply_script_patch',
    description: "Revision-checked GDScript creation or exact-patch editing applied to the RUNNING Godot editor without replacing it. Copies candidate bytes into the live editor filesystem, has Godot refresh and recompile the script on a deferred editor frame, and publishes only after Godot acknowledges the path, source hash, and compilation. A compile failure restores the previous bytes and leaves the revision untouched. Never restarts the editor, never switches workspace or launches the game; with Follow off it only reveals the file in the FileSystem dock. Reports changed line ranges, before/after hashes, compilation result, diagnostics, persistence, and preview freshness as independent facts.",
    input_schema: {
      type: 'object',
      properties: {
        expected_revision: { type: 'integer', minimum: 1 },
        path: { type: 'string', description: 'res:// path of the .gd script to create or edit.' },
        content: { type: 'string', description: 'Complete script source. Use for creation or full replacement; mutually exclusive with patches.' },
        patches: {
          type: 'array', minItems: 1, maxItems: 32,
          description: 'Exact search/replace patches applied to the existing script source.',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', minLength: 1 },
              replace: { type: 'string' },
              expected_occurrences: { type: 'integer', minimum: 1, maximum: 100, default: 1 }
            },
            required: ['find', 'replace'],
            additionalProperties: false
          }
        },
        attach_to_node_path: { type: 'string', description: 'Optional scene-relative node path to attach the script to through the editor UndoRedo stack.' },
        attach_scene_path: { type: 'string', description: 'Scene whose authoritative .tscn source records the attachment. Defaults to the main scene.' },
        label: { type: 'string' },
        idempotency_key: { type: 'string' }
      },
      required: ['expected_revision', 'path'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_apply_text_patch',
    description: 'Applies exact revision-checked search/replace patches and validates them through the acknowledged editor/runtime transaction path',
    input_schema: {
      type: 'object',
      properties: {
        expected_revision: { type: 'integer', minimum: 1 },
        label: { type: 'string' },
        patches: {
          type: 'array', minItems: 1, maxItems: 32,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              find: { type: 'string', minLength: 1 },
              replace: { type: 'string' },
              expected_occurrences: { type: 'integer', minimum: 1, maximum: 100, default: 1 }
            },
            required: ['path', 'find', 'replace'],
            additionalProperties: false
          }
        },
        idempotency_key: { type: 'string' }
      },
      required: ['expected_revision', 'patches'],
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
    description: 'Selects a node in the live Godot Editor scene dock through the WebMCP editor command channel; fails explicitly when the channel is unavailable',
    input_schema: { type: 'object', properties: { node_path: { type: 'string' } }, required: ['node_path'], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_transform_node_live',
    description: 'Transforms a node in the live Godot Editor through the editor command channel and its UndoRedo stack; viewport-only, use godot_node_transform to persist to source',
    input_schema: {
      type: 'object',
      properties: {
        node_path: { type: 'string' },
        translation: { type: 'array', items: { type: 'number' }, description: 'Absolute position [X, Y, Z]' },
        rotation: { type: 'array', items: { type: 'number' }, description: 'Rotation in degrees [Pitch, Yaw, Roll]' },
        scale: { type: 'array', items: { type: 'number' } },
        relative: { type: 'boolean', default: false }
      },
      required: ['node_path'], additionalProperties: false
    },
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
    description: 'Reads a live Inspector property from the edited scene through the editor command channel; omit property to list the editable property names',
    input_schema: { type: 'object', properties: { node_path: { type: 'string' }, property: { type: 'string' } }, required: ['node_path'], additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false }
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
    description: 'Opens a res:// scene in the live Godot Editor through the editor command channel; changes the edited scene only, not project.godot run/main_scene',
    input_schema: { type: 'object', properties: { scene_path: { type: 'string' } }, required: ['scene_path'], additionalProperties: false },
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
      properties: { key: { type: 'string' }, pressed: { type: 'boolean' }, duration_ms: { type: 'integer', minimum: 20, maximum: 5000 }, await_telemetry: { type: 'boolean', default: true }, target: { type: 'string', enum: ['auto', 'editor', 'game'], default: 'auto', description: "Which Godot canvas to address. 'auto' follows the visible tab." } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_send_input_sequence',
    description: 'Schedules a bounded keyboard timeline for coordinated controls',
    input_schema: {
      type: 'object',
      properties: {
        events: {
          type: 'array', minItems: 1, maxItems: 32,
          items: {
            type: 'object',
            properties: { at_ms: { type: 'integer', minimum: 0, maximum: 10000 }, key: { type: 'string' }, pressed: { type: 'boolean' } },
            required: ['at_ms', 'key', 'pressed'], additionalProperties: false
          }
        },
        target: { type: 'string', enum: ['auto', 'editor', 'game'], default: 'auto', description: "Which Godot canvas to address. 'auto' follows the visible tab." }
      },
      required: ['events'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_get_input_sequence_status',
    description: 'Returns planned and actual dispatch timing for coordinated keyboard sequences',
    input_schema: { type: 'object', properties: { sequence_id: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_capture_viewport',
    description: 'Captures the pixel buffer of the editor viewport or the running playtest canvas as a base64 PNG data URL',
    input_schema: { type: 'object', properties: { target: { type: 'string', enum: ['auto', 'editor', 'game'], default: 'auto', description: "Which Godot canvas to address. 'auto' follows the visible tab." } }, additionalProperties: false },
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
        delta_y: { type: 'number', default: 0 },
        target: { type: 'string', enum: ['auto', 'editor', 'game'], default: 'auto', description: "Which Godot canvas to address. 'auto' follows the visible tab." }
      },
      required: ['action', 'x', 'y'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_start_recording',
    description: 'Starts a real MediaRecorder capture of the visible Godot game canvas with optional in-page auto-stop persistence',
    input_schema: {
      type: 'object',
      properties: {
        fps: { type: 'integer', minimum: 10, maximum: 60, default: 30 },
        mime_type: { type: 'string' },
        duration_ms: { type: 'integer', minimum: 500, maximum: 60000 }
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
  },
  {
    name: 'godot_diagnose_session',
    description: 'Diagnoses current-generation Godot logs and recovery state into structured platform, project-source, persistence, lifecycle, and fatal-engine issues. Reports ownership, impact, evidence, and only remedies the agent can safely perform; read-only and never mutates the project.',
    input_schema: {
      type: 'object',
      properties: {
        since_ms: { type: 'number', minimum: 0, description: 'Optional lookback window in milliseconds. Omit to inspect the full current editor generation.' }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_camera_focus',
    description: "Transient viewport-only framing: selects a node, dispatches Godot's own spatial_editor/focus_selection so the editor camera eases to it, and anchors the on-page focus reticle to the node's projected screen position. Reports what it measured, not what it attempted: status is 'framed' only when the viewport pose actually changed, 'dispatched_unconfirmed' when the shortcut was delivered but the camera did not move (Godot only advances camera interpolation while rendering, so a backgrounded tab reports this), 'overlay_only' without the editor plugin, or 'yielded' during the 750 ms cooldown after user input. target_reached additionally requires the node to project inside the frame. Never mutates scene JSON, advances scene_revision, creates an undo entry, triggers autosave, or survives a project reload.",
    input_schema: {
      type: 'object',
      properties: { node_path: { type: 'string', description: 'Node name or scene-relative path to frame' } },
      required: ['node_path'], additionalProperties: false
    },
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_camera_follow',
    description: 'Enables or disables automatic camera follow for this browser session. A geometry change queues exactly one coalesced framing move; material-only changes never move the camera.',
    input_schema: {
      type: 'object',
      properties: { enabled: { type: 'boolean', description: 'Omit to read the current preference without changing it' } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_workspace_follow',
    description: 'Enables or disables visible workspace following for this browser tab. Script changes open at their changed lines; 3D node changes switch to 3D and select the edited node.',
    input_schema: {
      type: 'object',
      properties: { enabled: { type: 'boolean', description: 'Omit to read the current preference without changing it' } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_node_spawn',
    description: 'Adds a 3D mesh node with position, rotation, scale, and material to the live scene. Applied through the editor command channel without restarting the engine when the WebMCP editor plugin is present; otherwise falls back to a full editor restart. Reports the measured elapsed time and which channel was used.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique name of the 3D node' },
        parent_path: { type: 'string', default: '.', description: 'Parent node path (defaults to root .)' },
        mesh_type: { type: 'string', enum: ['box', 'cylinder', 'sphere', 'torus', 'prism', 'capsule', 'plane'], default: 'box' },
        size: { type: 'array', items: { type: 'number' }, description: 'Vector3 dimensions [x, y, z] for box/prism' },
        radius: { type: 'number', description: 'Radius for sphere/cylinder/capsule' },
        height: { type: 'number', description: 'Height for cylinder/capsule/prism' },
        inner_radius: { type: 'number', description: 'Inner radius for torus' },
        outer_radius: { type: 'number', description: 'Outer radius for torus' },
        position: { type: 'array', items: { type: 'number' }, description: '3D position coordinates [X, Y, Z]' },
        rotation: { type: 'array', items: { type: 'number' }, description: '3D rotation in degrees [Pitch, Yaw, Roll]' },
        scale: { type: 'array', items: { type: 'number' }, description: '3D scale factors [sx, sy, sz]' },
        material: {
          type: 'object',
          properties: {
            albedo_color: { type: 'string', description: 'Hex color (e.g. #00e5ff) or rgba string' },
            metallic: { type: 'number', minimum: 0, maximum: 1 },
            roughness: { type: 'number', minimum: 0, maximum: 1 },
            emission: { type: 'string', description: 'Hex emissive color' },
            emission_energy: { type: 'number', description: 'Emissive energy multiplier' }
          },
          additionalProperties: false
        }
      },
      required: ['name'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_node_transform',
    description: 'Translates, rotates, or scales a 3D node in the live editor scene. Applied through the editor command channel without restarting the engine when the WebMCP editor plugin is present; otherwise falls back to a full editor restart.',
    input_schema: {
      type: 'object',
      properties: {
        node_path: { type: 'string', description: 'Path or name of the node in the scene tree' },
        position: { type: 'array', items: { type: 'number' }, description: 'New position coordinates [X, Y, Z]' },
        rotation: { type: 'array', items: { type: 'number' }, description: 'New rotation angles in degrees [Pitch, Yaw, Roll]' },
        scale: { type: 'array', items: { type: 'number' }, description: 'New scale factors [sx, sy, sz]' },
        relative: { type: 'boolean', default: false, description: 'If true, offsets existing transform instead of setting absolute values' }
      },
      required: ['node_path'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_node_material',
    description: 'Updates the albedo, metallic, roughness, and emissive properties of a 3D node material. Applied through the editor command channel without restarting the engine when the WebMCP editor plugin is present; otherwise falls back to a full editor restart. Material changes never move the camera.',
    input_schema: {
      type: 'object',
      properties: {
        node_path: { type: 'string', description: 'Path or name of the node' },
        albedo_color: { type: 'string', description: 'Albedo color hex or rgb' },
        metallic: { type: 'number', minimum: 0, maximum: 1 },
        roughness: { type: 'number', minimum: 0, maximum: 1 },
        emission: { type: 'string', description: 'Emission color hex' },
        emission_energy: { type: 'number', description: 'Emission energy multiplier' }
      },
      required: ['node_path'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_node_delete',
    description: 'Removes a 3D node from the live scene tree. Applied through the editor command channel without restarting the engine when the WebMCP editor plugin is present; otherwise falls back to a full editor restart.',
    input_schema: {
      type: 'object',
      properties: {
        node_path: { type: 'string', description: 'Path or name of the node to remove' }
      },
      required: ['node_path'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true }
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
