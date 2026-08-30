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
    description: 'Executes a semantic playtest action (steer_left, steer_right, jump, boost, observe_state) and returns structured telemetry',
    annotations: { readOnlyHint: false, untrustedContentHint: false }
  },
  {
    name: 'godot_create_project',
    description: 'Injects complete 2D/3D visual scenes (.tscn), GDScripts, shaders, and audio into Godot virtual FS and boots Godot Viewport',
    annotations: { readOnlyHint: false, untrustedContentHint: true }
  },
  {
    name: 'godot_export_zip',
    description: 'Packages all active project scenes, scripts, shaders, and audio into a standard downloadable ZIP archive buffer',
    annotations: { readOnlyHint: true, untrustedContentHint: false }
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
  return res.json({
    jsonrpc: '2.0',
    id: body.id,
    result: { status: 'received', method: body.method, params: body.params }
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
