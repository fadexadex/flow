// Netlify's copy of the asset proxy. The logic lives in deploy/fetch_asset.mjs so the Node
// server and this cannot drift on the SSRF guards.
import { fetchAsset } from '../../deploy/fetch_asset.mjs';

export default async (request) => {
  const url = new URL(request.url).searchParams.get('url') || '';
  try {
    const asset = await fetchAsset(url);
    return new Response(asset.bytes, {
      headers: {
        'Content-Type': asset.content_type,
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Access-Control-Allow-Origin': '*',
        'X-Asset-Source': asset.url
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: error.status || 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};
