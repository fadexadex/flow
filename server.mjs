import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/mcp' });

const PORT = process.env.PORT || 8060;

// Middleware for COOP, COEP, and CORS (Critical for SharedArrayBuffer & WebAssembly Multi-threading)
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// JSON body parsing middleware
app.use(express.json());

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'Godot Engine Web (4.7.2)',
    mcp_bridge: 'active',
    editors_connected: editorClients.size,
    agents_connected: agentClients.size,
    timestamp: new Date().toISOString()
  });
});

// Production WebMCP Tool Catalog
const MCP_TOOL_CATALOG = [
  {
    name: 'godot_get_session_status',
    description: 'Returns live diagnostics for Godot WebEditor runtime, WebMCP native discovery, session revision, and WebGL health',
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_get_operation_status',
    description: 'Returns status and final results for long-running authoring operations that outlive a browser tool-call deadline',
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_author_3d_runner',
    description: 'Transactionally authors the complete Neon Skyrail 3D runner with chase camera, elevated skyrail, 8 coral hazards, 11 energy pulses, and Dawn Gate',
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_synthesize_audio_suite',
    description: 'Procedurally synthesizes the complete 6-piece 16-bit WAV sound effects suite with duration, loudness, and MIT license metadata',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_semantic_playtest_step',
    description: 'Executes a Neon Skyrail-only semantic playtest action and rejects custom projects instead of returning simulated runner state',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_get_game_telemetry',
    description: 'Reads project-owned runtime telemetry emitted as godot-game-telemetry events; never substitutes simulated state for custom games',
    annotations: { readOnlyHint: true, untrustedContentHint: true }
  },
  {
    name: 'godot_create_project',
    description: 'Injects complete 2D/3D visual scenes (.tscn), GDScripts, shaders, and audio into Godot virtual FS and boots Godot Viewport',
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_export_zip',
    description: 'Packages the active project and an explicit per-file provenance manifest into a standard downloadable ZIP archive',
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_inspect_project_files',
    description: 'Inspects the authoritative in-memory project manifest and optionally returns selected text source files for revision-safe editing',
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_apply_file_transaction',
    description: 'Revision-checked atomic project edit that restarts the real Godot Editor and records an undo snapshot',
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_undo_transaction',
    description: 'Restores the exact project snapshot captured by the most recent acknowledged authoring transaction',
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
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_capture_viewport',
    description: 'Captures the WebGL canvas pixel buffer directly as base64 PNG data URL',
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_start_recording',
    description: 'Starts a real MediaRecorder capture of the visible Godot game canvas',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_stop_recording',
    description: 'Stops the active canvas recording, persists it in IndexedDB, and exposes a download link',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_list_recordings',
    description: 'Lists recordings persisted for this deployed origin and restores the newest download link',
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  },
  {
    name: 'godot_get_logs',
    description: 'Retrieves engine logs and stdout telemetry',
    annotations: { readOnlyHint: true, untrustedContentHint: false }
  }
];

// MCP discovery & tool list endpoint
app.get('/api/mcp/tools', (req, res) => {
  res.json({ tools: MCP_TOOL_CATALOG });
});

// MCP JSON-RPC 2.0 POST dispatcher endpoint
app.post('/api/mcp/rpc', (req, res) => {
  const body = req.body;
  if (!body) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  if (body.method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id: body.id,
      result: { tools: MCP_TOOL_CATALOG }
    });
  }
  return res.status(400).json({
    jsonrpc: '2.0',
    id: body.id,
    error: {
      code: -32601,
      message: 'This stateless HTTP endpoint supports tools/list only. Execute tools through native in-page WebMCP so they can reach the active Godot runtime.'
    }
  });
});

// WebSocket MCP message broker (Agent <-> Godot Web Editor)
const editorClients = new Set();
const agentClients = new Set();
const requestRouter = new Map(); // requestId -> agentWs

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientType = url.searchParams.get('type') || 'agent';

  if (clientType === 'editor') {
    editorClients.add(ws);
    console.log(`[MCP Bridge] Godot Web Editor client connected (total editors: ${editorClients.size})`);
  } else {
    agentClients.add(ws);
    console.log(`[MCP Bridge] AI Agent client connected (total agents: ${agentClients.size})`);
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (clientType === 'agent') {
        // Track request origin
        if (data.id !== undefined) {
          requestRouter.set(data.id, ws);
        }

        // Pre-boot protection: check if editor is ready
        if (editorClients.size === 0) {
          if (data.id !== undefined) {
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: data.id,
              error: {
                code: -32001,
                message: 'Godot Web Editor is not yet connected or initializing'
              }
            }));
            requestRouter.delete(data.id);
          }
          return;
        }

        // Forward to connected editor instances
        for (const editor of editorClients) {
          if (editor.readyState === WebSocket.OPEN) {
            editor.send(JSON.stringify(data));
          }
        }
      } else if (clientType === 'editor') {
        // Route response specifically to the agent that issued the request
        if (data.id !== undefined && requestRouter.has(data.id)) {
          const targetAgent = requestRouter.get(data.id);
          if (targetAgent && targetAgent.readyState === WebSocket.OPEN) {
            targetAgent.send(JSON.stringify(data));
          }
          requestRouter.delete(data.id);
        } else {
          // Broadcast general notifications / telemetry to all connected agents
          for (const agent of agentClients) {
            if (agent.readyState === WebSocket.OPEN) {
              agent.send(JSON.stringify(data));
            }
          }
        }
      }
    } catch (err) {
      console.error('[MCP Bridge] Error parsing message:', err.message);
    }
  });

  ws.on('close', () => {
    editorClients.delete(ws);
    agentClients.delete(ws);
    // Cleanup any orphaned requests
    for (const [id, agentWs] of requestRouter.entries()) {
      if (agentWs === ws) requestRouter.delete(id);
    }
    console.log(`[MCP Bridge] Client disconnected (${clientType})`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`  🎮 Godot Web MCP Server running locally!`);
  console.log(`  🌐 Editor URL: http://localhost:${PORT}`);
  console.log(`  🔌 MCP WebSocket Bridge: ws://localhost:${PORT}/mcp`);
  console.log(`  🩺 Health API: http://localhost:${PORT}/api/health`);
  console.log(`====================================================`);
});
