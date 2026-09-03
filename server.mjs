import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { MCP_TOOL_CATALOG } from './netlify/functions/tools.mjs';
import { headersForPath } from './deploy/policy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/mcp' });

const PORT = process.env.PORT || 8060;

// One policy for all three deployment targets, in deploy/policy.mjs. Serving different
// headers locally than in production is how a caching bug reaches a user first.
app.use((req, res, next) => {
  for (const [key, value] of Object.entries(headersForPath(req.path))) res.setHeader(key, value);
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
