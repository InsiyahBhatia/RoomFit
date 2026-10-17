/*
 * ROOMFIT Gemini proxy for Cloudflare Workers.
 *   wrangler secret put GEMINI_API_KEY
 *   wrangler deploy proxy/worker.js --name roomfit-proxy
 * Set ALLOWED_ORIGIN (e.g. https://roomfit.example) to restrict who can call it.
 * Requests are forwarded once and never stored. Images are not logged or retained.
 *
 * Routes
 *   GET  /health
 *   POST /gemini                 { task, body }           → raw Gemini generateContent response
 *   POST /api/products/search    { query, request, roomContext }
 *        → { searchedAt, linkChecks: {url: 'ok'|'missing'|'unknown'}, gemini: <grounded response> }
 */
const TASKS = new Set(['analyzeRoom', 'parseRequirements', 'explainLayout', 'readSpec', 'parseProductRequest']);

export function productSearchPrompt(request, roomContext) {
  return `You are the product-retrieval step of ROOMFIT, a furniture fit checker for homes in India.
Use Google Search to find furniture currently listed for sale (prefer Indian retailers and INR prices) that matches the request.

Rules — follow exactly:
- Only include products from pages you actually found in search results. productUrl must be the exact product page URL from those results.
- Never invent or estimate a value. If the page doesn't state it, use null.
- Dimensions in centimetres as printed on the listing (convert inches/mm/feet exactly). Copy the printed text into dimensionsText.
- dimensionsVerified = true only if the listing explicitly states width, depth and height.
- price = listed selling price in INR as a number. availability only if the page states it.
- Prefer products whose listed width/depth respect spatialConstraints, but list what you find; ROOMFIT checks fit itself.
- Do not include products named in excludeNames. Return at most 8 products.

Return ONLY a JSON object, no prose:
{"products":[{"name":"","brand":null,"retailer":"","category":"","price":null,"currency":"INR","dimensions":{"widthCm":null,"depthCm":null,"heightCm":null},"dimensionsText":null,"dimensionsVerified":false,"productUrl":"","sourceUrl":"","imageUrl":null,"description":null,"features":[],"material":null,"color":null,"availability":null}]}

Request: ${JSON.stringify(request).slice(0, 4000)}
Room (dimensions only): ${JSON.stringify(roomContext).slice(0, 4000)}`;
}

function extractJson(text) {
  const s = String(text || '').replace(/```json|```/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  return a >= 0 && b > a ? s.slice(a, b + 1) : '{}';
}

async function checkLink(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return 'unknown';
    let r = await fetch(u, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(4000) });
    if (r.status === 405 || r.status === 403) r = await fetch(u, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(5000) });
    if (r.status === 404 || r.status === 410) return 'missing';
    return r.ok ? 'ok' : 'unknown';
  } catch { return 'unknown'; }
}

export default {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Cache-Control': 'no-store' };
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') return Response.json({ ok: true }, { headers: cors });
    if (req.method !== 'POST') return new Response('not found', { status: 404, headers: cors });
    if (origin !== '*' && req.headers.get('Origin') !== origin) return new Response('forbidden', { status: 403, headers: cors });
    if (Number(req.headers.get('Content-Length') || 0) > 20e6) return new Response('too large', { status: 413, headers: cors });

    let input;
    try { input = await req.json(); } catch { return new Response('bad json', { status: 400, headers: cors }); }
    const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
    const call = body => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(body)
    });

    if (url.pathname === '/gemini') {
      if (!TASKS.has(input.task) || !input.body) return new Response('unknown task', { status: 400, headers: cors });
      const upstream = await call(input.body);
      return new Response(upstream.body, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/api/products/search') {
      if (!input.request || typeof input.request !== 'object') return new Response('missing request', { status: 400, headers: cors });
      const upstream = await call({
        contents: [{ role: 'user', parts: [{ text: productSearchPrompt(input.request, input.roomContext || {}) }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1 }
      });
      if (!upstream.ok) return Response.json({ error: 'upstream ' + upstream.status }, { status: 502, headers: cors });
      const gemini = await upstream.json();
      let products = [];
      try {
        const text = gemini.candidates[0].content.parts.map(p => p.text || '').join('');
        products = (JSON.parse(extractJson(text)).products || []).slice(0, 10);
      } catch { /* client reports unreadable result */ }
      const urls = [...new Set(products.map(p => p && p.productUrl).filter(Boolean))];
      const statuses = await Promise.all(urls.map(checkLink));
      const linkChecks = Object.fromEntries(urls.map((u, i) => [u, statuses[i]]));
      return Response.json({ searchedAt: new Date().toISOString(), linkChecks, gemini }, { headers: cors });
    }
    return new Response('not found', { status: 404, headers: cors });
  }
};
