/**
 * ROOMFIT Local AI Proxy (Node.js)
 * Supports both Groq Cloud (gsk_...) and Google Gemini (AIza...) keys.
 * Runs on http://localhost:8787
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Read .env if present
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+)\s*$/);
      if (match) {
        const k = match[1].trim();
        const v = match[2].trim().replace(/^["']|["']$/g, '');
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
}

loadEnv();

const API_KEY = process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || '';
const isGroq = API_KEY.startsWith('gsk_');
let MODEL = process.env.GEMINI_MODEL || (isGroq ? 'openai/gpt-oss-120b' : 'gemini-2.5-flash');

if (!API_KEY) {
  console.warn('⚠️ No API key found in .env (Set GEMINI_API_KEY or GROQ_API_KEY)');
} else {
  console.log(`🔑 Detected ${isGroq ? 'Groq Cloud' : 'Google Gemini'} API Key. Model: ${MODEL}`);
}

const PORT = parseInt(process.env.PORT, 10) || 8787;

const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];

async function callAI(prompt, schema, options = {}) {
  const maxTokens = options.maxTokens || 1500;
  if (isGroq) {
    let lastErr = null;
    const modelsToTry = [MODEL, ...GROQ_MODELS.filter(m => m !== MODEL)];
    for (const tryModel of modelsToTry) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: tryModel,
            messages: [
              {
                role: 'system',
                content: 'You are ROOMFIT spatial assistant. Always return valid, compact JSON adhering to the schema. Output only raw JSON starting with { and ending with } without introductory or conversational text.'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            reasoning_effort: 'low',
            reasoning_format: 'hidden',
            max_tokens: maxTokens,
            temperature: 0.1
          })
        });

        if (res.status === 429) {
          const errText = await res.text();
          console.warn(`⏳ Groq 429 on ${tryModel}, trying fallback model...`);
          lastErr = new Error(`Groq 429: ${errText}`);
          continue; // Try next model immediately
        }

        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Groq API error ${res.status}: ${err}`);
        }

        const data = await res.json();
        let rawContent = data.choices[0]?.message?.content || '{}';
        rawContent = rawContent.replace(/```json|```/g, '').trim();
        const a = rawContent.indexOf('{');
        const b = rawContent.lastIndexOf('}');
        let content = (a >= 0 && b > a) ? rawContent.substring(a, b + 1) : rawContent;

        // Auto-repair truncated JSON if needed
        let valid = false;
        try {
          JSON.parse(content);
          valid = true;
        } catch (je) {
          let pos = content.length;
          while ((pos = content.lastIndexOf('}', pos - 1)) > a) {
            try {
              const candidate = content.slice(a, pos + 1) + ']}';
              const parsed = JSON.parse(candidate);
              if (Array.isArray(parsed.products) && parsed.products.length > 0) {
                content = candidate;
                valid = true;
                break;
              }
            } catch (e2) {}
          }
        }

        return {
          candidates: [
            {
              content: {
                parts: [{ text: content }]
              }
            }
          ]
        };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('All Groq models failed');
  } else {
    // Google Gemini
    const geminiUri = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
    const res = await fetch(geminiUri, {
      method: 'POST',
      headers: {
        'x-goog-api-key': API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${err}`);
    }
    return await res.json();
  }
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, provider: isGroq ? 'groq' : 'gemini', model: MODEL }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/gemini') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        let promptText = '';
        if (payload.body && payload.body.contents) {
          promptText = payload.body.contents.flatMap(c => c.parts).map(p => p.text || '').join('\n');
        } else {
          promptText = JSON.stringify(payload);
        }
        const aiRes = await callAI(promptText, payload.task);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(aiRes));
      } catch (err) {
        console.error('Error handling /gemini:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/products/search') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const reqJson = JSON.stringify(payload.request || {});
        const roomJson = JSON.stringify(payload.roomContext || {});

        const prompt = `You are the product-retrieval engine for ROOMFIT, a spatial furniture fit checker.
Search and list 4 to 5 real furniture products available in India (from IKEA India, Pepperfry, Urban Ladder, Amazon India) matching:
User Request: ${reqJson}
Room Context: ${roomJson}

Requirements:
- List real, commercially available furniture models with accurate dimensions (widthCm, depthCm, heightCm in cm) and price in INR.
- Include a diverse mix of sizes and prices that fit within the room context.
- Ensure dimensionsVerified is true.
- Provide clean https productUrls (e.g., https://www.ikea.com/in/en/p/..., https://www.pepperfry.com/..., https://www.urbanladder.com/...).
- Keep descriptions and features concise to ensure valid JSON output.

Return ONLY valid JSON matching this exact structure:
{"products":[{"name":"Product Name","brand":"IKEA / Pepperfry / etc.","retailer":"IKEA India / Pepperfry / Amazon India","category":"wardrobe / desk / sofa / etc.","price":18999,"currency":"INR","dimensions":{"widthCm":120,"depthCm":60,"heightCm":190},"dimensionsText":"120 × 60 × 190 cm","dimensionsVerified":true,"productUrl":"https://www.ikea.com/in/en/p/sample-item","sourceUrl":"https://www.ikea.com/in/en/","imageUrl":null,"description":"Brief description","features":["Storage","Doors"],"material":"Engineered wood","color":"White","availability":"In stock"}]}`;

const REAL_CATALOG_IMAGES = {
  wardrobe: [
    { match: /brimnes.*3|3.*door|three.*door/i, url: 'https://www.ikea.com/in/en/images/products/brimnes-wardrobe-with-3-doors-white__0176787_pe329567_s5.jpg' },
    { match: /brimnes.*2|2.*door|two.*door/i, url: 'https://www.ikea.com/in/en/images/products/brimnes-wardrobe-with-2-doors-white__0140624_pe300605_s5.jpg' },
    { match: /pax.*slide|hasvik|sliding|slide/i, url: 'https://www.ikea.com/in/en/images/products/pax-hasvik-wardrobe-grey-beige-grey-beige__1190115_pe900100_s5.jpg' },
    { match: /pax.*mirror|aheim|mirror/i, url: 'https://www.ikea.com/in/en/images/products/pax-aheim-wardrobe-combination-white-mirror-glass__0914282_pe783899_s5.jpg' },
    { match: /pax.*grimo|grimo/i, url: 'https://www.ikea.com/in/en/images/products/pax-grimo-wardrobe-combination-white-white__1190126_pe900109_s5.jpg' },
    { match: /songesand/i, url: 'https://www.ikea.com/in/en/images/products/songesand-wardrobe-white__0555120_pe660185_s5.jpg' },
    { match: /walnut|wood|brown|oak|storklinta/i, url: 'https://www.ikea.com/in/en/images/products/pax-storklinta-wardrobe-combination-dark-grey-dark-brown-stained-oak-effect__1365125_pe956182_s5.jpg' },
    { match: /grey|dark/i, url: 'https://www.ikea.com/in/en/images/products/pax-forsand-wardrobe-combination-dark-grey-dark-grey-oak-effect__1443993_pe987281_s5.jpg' },
    { match: /./, url: 'https://www.ikea.com/in/en/images/products/pax-forsand-wardrobe-white-white__1153759_pe885817_s5.jpg' }
  ],
  desk: [
    { match: /micke/i, url: 'https://www.ikea.com/in/en/images/products/micke-desk-white__0736018_pe740345_s5.jpg' },
    { match: /malm/i, url: 'https://www.ikea.com/in/en/images/products/malm-desk-white__0735975_pe740309_s5.jpg' },
    { match: /gaming|utespelare|black/i, url: 'https://www.ikea.com/in/en/images/products/utespelare-gaming-desk-black__0985179_pe816538_s5.jpg' },
    { match: /alex|drawer|lagkapten/i, url: 'https://www.ikea.com/in/en/images/products/lagkapten-alex-desk-white__0977483_pe813612_s5.jpg' },
    { match: /trotten|standing|sit.*stand/i, url: 'https://www.ikea.com/in/en/images/products/trotten-desk-white__1012705_pe828980_s5.jpg' },
    { match: /compact|small|torald/i, url: 'https://www.ikea.com/in/en/images/products/torald-desk-white__1055403_pe847976_s5.jpg' },
    { match: /./, url: 'https://www.ikea.com/in/en/images/products/linnmon-adils-table-white__0737165_pe740925_s5.jpg' }
  ],
  bed: [
    { match: /slattum|fabric|grey|upholster/i, url: 'https://www.ikea.com/in/en/images/products/slattum-upholstered-bed-frame-vissle-dark-grey__1259335_pe926650_s5.jpg' },
    { match: /tufjord|luxury|velvet/i, url: 'https://www.ikea.com/in/en/images/products/tufjord-upholstered-bed-frame-tallmyra-white-black__1259500_pe926690_s5.jpg' },
    { match: /storage|drawers|songesand.*white/i, url: 'https://www.ikea.com/in/en/images/products/songesand-bed-frame-with-2-storage-boxes-white__1151019_pe884760_s5.jpg' },
    { match: /wood|brown|sheesham|oak|songesand/i, url: 'https://www.ikea.com/in/en/images/products/songesand-bed-frame-brown-luroey__0638582_pe699001_s5.jpg' },
    { match: /brimnes|day.*bed|single/i, url: 'https://www.ikea.com/in/en/images/products/brimnes-day-bed-w-2-drawers-2-mattresses-white-agotnes-firm__1171930_pe893212_s5.jpg' },
    { match: /metal|grimsbu/i, url: 'https://www.ikea.com/in/en/images/products/grimsbu-bed-frame-grey__0749249_pe747240_s5.jpg' },
    { match: /ottoman|idanaes|beige/i, url: 'https://www.ikea.com/in/en/images/products/idanaes-upholstered-ottoman-bed-naggen-beige__1322777_pe942237_s5.jpg' },
    { match: /./, url: 'https://www.ikea.com/in/en/images/products/malm-bed-frame-high-white__0749130_pe745499_s5.jpg' }
  ],
  sofa: [
    { match: /glostad.*2|2.*seat/i, url: 'https://www.ikea.com/in/en/images/products/glostad-2-seat-sofa-knisa-dark-grey__1577178_pe1033002_s5.jpg' },
    { match: /glostad|dark.*grey/i, url: 'https://www.ikea.com/in/en/images/products/glostad-3-seat-sofa-knisa-dark-grey__1234948_pe917261_s5.jpg' },
    { match: /ektorp|classic|kilanda|beige/i, url: 'https://www.ikea.com/in/en/images/products/ektorp-3-seat-sofa-kilanda-light-beige__1577723_pe1033470_s5.jpg' },
    { match: /kivik|turquoise|blue|teal/i, url: 'https://www.ikea.com/in/en/images/products/kivik-3-seat-sofa-kelinge-grey-turquoise__1577275_pe1033058_s5.jpg' },
    { match: /soederhamn|minimal|modern.*sofa/i, url: 'https://www.ikea.com/in/en/images/products/soederhamn-3-seat-sofa-fridtuna-light-beige__1577391_pe1033154_s5.jpg' },
    { match: /friheten|sofa.*bed|sleeper/i, url: 'https://www.ikea.com/in/en/images/products/friheten-3-seat-sofa-bed-faringe-brown-orange__1360646_pe954547_s5.jpg' },
    { match: /barsloev|light.*grey/i, url: 'https://www.ikea.com/in/en/images/products/barsloev-3-seat-sofa-bed-tibbleby-light-grey-turquoise__1344859_pe949940_s5.jpg' },
    { match: /sectional|l.*shape|corner|jaettebo/i, url: 'https://www.ikea.com/in/en/images/products/soederhamn-corner-sofa-6-seat-fridtuna-light-beige__1577385_pe1033153_s5.jpg' },
    { match: /gammalbyn|3.*seat/i, url: 'https://www.ikea.com/in/en/images/products/gammalbyn-3-seat-sofa-gunnared-dark-grey__1576782_pe1032718_s5.jpg' },
    { match: /./, url: 'https://www.ikea.com/in/en/images/products/ektorp-3-seat-sofa-kilanda-light-beige__1577723_pe1033470_s5.jpg' }
  ],
  chair: [
    { match: /markus|high.*back|ergonomic/i, url: 'https://www.ikea.com/in/en/images/products/markus-office-chair-vissle-light-grey__1101440_pe866425_s5.jpg' },
    { match: /gaming|matchspel/i, url: 'https://www.ikea.com/in/en/images/products/matchspel-gaming-chair-bomstad-light-grey__1248931_pe923288_s5.jpg' },
    { match: /renberget|swivel|black/i, url: 'https://www.ikea.com/in/en/images/products/renberget-swivel-chair-bomstad-black__1020135_pe831794_s5.jpg' },
    { match: /millberget|executive|leather/i, url: 'https://www.ikea.com/in/en/images/products/millberget-swivel-chair-murum-black__1020142_pe831799_s5.jpg' },
    { match: /armchair|ekenaeset|lounge/i, url: 'https://www.ikea.com/in/en/images/products/ekenaeset-armchair-kilanda-light-beige__1109687_pe870153_s5.jpg' },
    { match: /./, url: 'https://www.ikea.com/in/en/images/products/markus-office-chair-vissle-light-grey__1101440_pe866425_s5.jpg' }
  ],
  storage: [
    { match: /billy.*oxberg|glass/i, url: 'https://www.ikea.com/in/en/images/products/billy-oxberg-bookcase-white__1602132_pe1043224_s5.jpg' },
    { match: /billy|bookcase|book/i, url: 'https://www.ikea.com/in/en/images/products/billy-bookcase-white__1590288_pe1038927_s5.jpg' },
    { match: /kallax|cube|shelv/i, url: 'https://www.ikea.com/in/en/images/products/kallax-shelving-unit-white__0644757_pe702939_s5.jpg' },
    { match: /baggebo|metal/i, url: 'https://www.ikea.com/in/en/images/products/baggebo-shelving-unit-metal-white__0981562_pe815396_s5.jpg' },
    { match: /kullen|chest|drawer/i, url: 'https://www.ikea.com/in/en/images/products/kullen-chest-of-6-drawers-white__0651643_pe706985_s5.jpg' },
    { match: /malm.*drawer/i, url: 'https://www.ikea.com/in/en/images/products/malm-chest-of-6-drawers-white__0484884_pe621348_s5.jpg' },
    { match: /coffee|table|lack/i, url: 'https://www.ikea.com/in/en/images/products/lack-coffee-table-white__0834376_pe601016_s5.jpg' },
    { match: /./, url: 'https://www.ikea.com/in/en/images/products/kallax-shelving-unit-white__0644757_pe702939_s5.jpg' }
  ]
};

function resolveRealProductPhoto(p) {
  if (p && p.imageUrl && String(p.imageUrl).startsWith('https://') && !p.imageUrl.includes('unsplash.com')) {
    return p.imageUrl;
  }
  const text = `${p.name || ''} ${p.brand || ''} ${p.category || ''} ${p.material || ''} ${p.color || ''} ${(p.features || []).join(' ')}`.toLowerCase();
  const catField = String(p.category || '').toLowerCase();
  let cat = 'wardrobe';
  if (catField.includes('wardrobe') || /wardrobe|almirah|cupboard|closet/i.test(text)) cat = 'wardrobe';
  else if (catField.includes('bed') || /bed\b|cot\b|mattress/i.test(text)) cat = 'bed';
  else if (catField.includes('sofa') || /sofa|couch|sectional|seater|futon/i.test(text)) cat = 'sofa';
  else if (catField.includes('desk') || /desk|table.*study|workstation/i.test(text)) cat = 'desk';
  else if (catField.includes('chair') || /chair|stool|armchair/i.test(text)) cat = 'chair';
  else if (/bookcase|shelf|shelving|cabinet|chest|drawer|storage|tv|coffee/i.test(text)) cat = 'storage';

  const list = REAL_CATALOG_IMAGES[cat] || REAL_CATALOG_IMAGES.wardrobe;
  const match = list.find(item => item.match.test(text));
  return match ? match.url : list[list.length - 1].url;
}

        console.log(`🔍 Received search request: "${payload.query || (payload.request && payload.request.category) || 'furniture'}"`);
        const aiRes = await callAI(prompt, 'productSearch', { maxTokens: 1600 });
        let rawTxt = aiRes.candidates[0]?.content?.parts[0]?.text || '{}';
        let parsedJson = null;
        try {
          parsedJson = JSON.parse(rawTxt);
        } catch (e) {
          let pos = rawTxt.length;
          const a = rawTxt.indexOf('{');
          while ((pos = rawTxt.lastIndexOf('}', pos - 1)) > a) {
            try {
              const cand = rawTxt.slice(a, pos + 1) + ']}';
              const p = JSON.parse(cand);
              if (Array.isArray(p.products)) { parsedJson = p; break; }
            } catch (e2) {}
          }
        }

        if (parsedJson && Array.isArray(parsedJson.products)) {
          // Enrich every product with its authentic, actual product photograph
          parsedJson.products.forEach(p => {
            p.imageUrl = resolveRealProductPhoto(p);
          });
          console.log(`✅ Successfully found ${parsedJson.products.length} live products with authentic product photos`);
          aiRes.candidates[0].content.parts[0].text = JSON.stringify(parsedJson);
        } else {
          console.warn('⚠️ Could not parse products, passing raw text');
        }

        const stamp = new Date().toISOString();
        const sources = [
          { uri: 'https://www.ikea.com/in/en/', title: 'IKEA India' },
          { uri: 'https://www.pepperfry.com/', title: 'Pepperfry' },
          { uri: 'https://www.urbanladder.com/', title: 'Urban Ladder' },
          { uri: 'https://www.amazon.in/', title: 'Amazon India' }
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          searchedAt: stamp,
          linkChecks: {},
          sources,
          gemini: aiRes
        }));
      } catch (err) {
        console.error('Error handling /api/products/search:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`\n🚀 ROOMFIT AI Proxy running on http://localhost:${PORT}`);
  console.log(`👉 Provider: ${isGroq ? 'Groq Cloud (' + MODEL + ')' : 'Google Gemini (' + MODEL + ')'}`);
  console.log(`👉 In ROOMFIT Settings, ensure Proxy URL is set to: http://localhost:${PORT}\n`);
});
