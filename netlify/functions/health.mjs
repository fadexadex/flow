export default async (req, context) => {
  return new Response(JSON.stringify({
    status: 'ok',
    engine: 'Godot Engine Web (4.7.2)',
    mcp_bridge: 'active',
    environment: 'Netlify Edge / Functions',
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
};
