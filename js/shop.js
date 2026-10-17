/*
 * ROOMFIT AI Shop — real-world furniture discovery.
 *
 *   request text → Gemini (intent → ProductSearchRequest) → product search provider
 *   → structured products (sanitized, links confirmed) → RF.findPlacement / RF.validate → ProductFitResult
 *
 * Nothing in this file decides fit on its own: every fit verdict and every number shown comes from the
 * geometry engine. Products with missing dimensions are "unknown", never "fits".
 *
 * interface ProductSearchProvider {
 *   searchProducts(request: ProductSearchRequest, roomContext: RoomContext): Promise<{
 *     products: Product[], sources: {uri,title}[], searchedAt: string, provider: string, warnings: string[] }>
 * }
 */
(function (RF) {
  'use strict';

  const CACHE_KEY = 'rf.shopCache.v1';
  const CACHE_TTL_MS = 6 * 3600 * 1000;
  const FLOOR = 100;

  /* ---------- category mapping (product text → engine category) ---------- */

  const CAT_MAP = [
    [/gaming (desk|table)|study (desk|table)|computer (desk|table)|office (desk|table)|writing (desk|table)|work ?station|\bdesk\b|laptop table/, 'desk'],
    [/dressing table|vanity/, 'dressing_table'],
    [/coffee table|centre table|center table/, 'coffee_table'],
    [/bedside|night ?stand|side table/, 'bedside'],
    [/tv (unit|stand|cabinet)|entertainment unit/, 'tv_unit'],
    [/arm ?chair|accent chair/, 'armchair'],
    [/chair|stool/, 'chair'],
    [/sofa|couch|settee|sectional/, 'sofa'],
    [/\bbed\b|bed frame|cot/, 'bed'],
    [/wardrobe|almirah|closet/, 'wardrobe'],
    [/book ?(shelf|case)|shelving unit/, 'bookshelf'],
    [/wall shelf|floating shelf/, 'wall_shelf'],
    [/chest of drawers|drawer|cabinet|storage|shoe rack/, 'storage']
  ];
  RF.shopCategory = function (text) {
    const t = String(text || '').toLowerCase();
    for (const [re, c] of CAT_MAP) if (re.test(t)) return c;
    return 'other';
  };

  /* ---------- schemas ---------- */

  // ProductSearchRequest (sanitized shape)
  function emptyRequest() {
    return { category: null, budget: { min: null, max: null, currency: 'INR' }, requiredDimensions: {}, style: [], features: [], color: [], material: null,
      roomType: null, purpose: null, quantity: 1, spatialConstraints: {}, excludeNames: [], intent: 'search' };
  }

  const REQ_SCHEMA = {
    type: 'OBJECT',
    properties: {
      intent: { type: 'STRING', enum: ['search', 'refine', 'cheaper', 'similar', 'alternatives'] },
      category: { type: 'STRING', nullable: true },
      budget_min_inr: { type: 'NUMBER', nullable: true }, budget_max_inr: { type: 'NUMBER', nullable: true },
      min_width_cm: { type: 'NUMBER', nullable: true }, max_width_cm: { type: 'NUMBER', nullable: true },
      min_depth_cm: { type: 'NUMBER', nullable: true }, max_depth_cm: { type: 'NUMBER', nullable: true },
      max_height_cm: { type: 'NUMBER', nullable: true },
      style: { type: 'ARRAY', items: { type: 'STRING' } }, features: { type: 'ARRAY', items: { type: 'STRING' } },
      color: { type: 'ARRAY', items: { type: 'STRING' } }, material: { type: 'STRING', nullable: true },
      purpose: { type: 'STRING', nullable: true },
      placement: { type: 'STRING', enum: ['anywhere', 'window_wall', 'selected_wall', 'replace_selected'], nullable: true }
    },
    required: ['intent']
  };

  const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi) ? Math.round(v) : null;
  const str = (v, n) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, n) : null;
  const arr = (v, n) => Array.isArray(v) ? v.map(x => str(String(x), 40)).filter(Boolean).slice(0, n) : [];

  /* ---------- request parsing (Gemini with local fallback; follow-ups modify state) ---------- */

  const CATEGORY_WORDS = [
    [/gaming (desk|table)/, 'gaming desk'], [/study (desk|table)/, 'study desk'], [/computer (desk|table)/, 'computer desk'], [/\bdesk\b|work ?table/, 'desk'],
    [/gaming chair/, 'gaming chair'], [/office chair|desk chair/, 'office chair'], [/arm ?chair/, 'armchair'], [/\bchairs?\b/, 'chair'],
    [/queen (size )?bed/, 'queen bed'], [/king (size )?bed/, 'king bed'], [/single bed/, 'single bed'], [/double bed/, 'double bed'], [/\bbeds?\b/, 'bed'],
    [/sliding wardrobe/, 'sliding wardrobe'], [/wardrobe|almirah/, 'wardrobe'], [/book ?(shelf|shelves|case)/, 'bookshelf'],
    [/l[- ]shaped sofa|sectional/, 'L-shaped sofa'], [/sofa|couch/, 'sofa'], [/coffee table/, 'coffee table'], [/tv (unit|stand)/, 'TV unit'],
    [/bedside|night ?stand|side table/, 'bedside table'], [/dressing table/, 'dressing table'], [/floor lamp/, 'floor lamp'], [/\blamp\b/, 'lamp'],
    [/chest of drawers/, 'chest of drawers'], [/shoe rack/, 'shoe rack'], [/storage (unit|cabinet)|cabinet/, 'storage cabinet']
  ];

  function parseLocal(text, prev) {
    const t = ' ' + String(text).toLowerCase().replace(/[’']/g, "'") + ' ';
    let cat = null;
    for (const [re, label] of CATEGORY_WORDS) if (re.test(t)) { cat = label; break; }
    const followUp = prev && prev.category && (!cat || RF.shopCategory(cat) === RF.shopCategory(prev.category));
    const r = followUp ? JSON.parse(JSON.stringify(prev)) : emptyRequest();
    r.intent = followUp ? 'refine' : 'search';
    if (cat && !(followUp && cat === 'desk' && /desk/.test(prev.category))) r.category = cat;
    if (!r.category && cat) r.category = cat;

    if (/cheaper|less expensive|lower (price|cost)|budget option/.test(t)) r.intent = 'cheaper';
    else if (/similar|like this|same kind/.test(t)) r.intent = 'similar';
    else if (/alternative/.test(t)) r.intent = 'alternatives';

    const between = t.match(/between\s*(?:₹|rs\.?)?\s*([\d,]+)\s*(k)?\s*(?:and|-|to)\s*(?:₹|rs\.?)?\s*([\d,]+)\s*(k)?/);
    if (between) {
      const v = (s, k) => parseFloat(s.replace(/,/g, '')) * (k ? 1000 : 1);
      r.budget.min = Math.round(v(between[1], between[2])); r.budget.max = Math.round(v(between[3], between[4]));
    } else {
      const mt = t.replace(/(\d+)\s*cm/g, ' '); // keep centimetres out of the money parser
      const nl = RF.nl.parse(mt);
      if (nl.budget) r.budget.max = nl.budget;
    }
    const W = '(?:wide|width|in width)', D = '(?:deep|depth|in depth)';
    const cmMin = (unit) => t.match(new RegExp(`(?:at least|minimum|min\\.?|more than|over|wider than|deeper than)\\s*(\\d{2,3})\\s*cm\\s*${unit}?`));
    const cmMax = (unit) => t.match(new RegExp(`(?:less than|under|below|max(?:imum)?\\.?|at most|up to|no (?:wider|deeper|more) than|narrower than|shallower than)\\s*(\\d{2,3})\\s*cm\\s*${unit}`));
    let m;
    if ((m = cmMin(W)) && (/wid/.test(m[0]) || !/deep/.test(m[0]))) r.requiredDimensions.minWidthCm = +m[1];
    if ((m = cmMax(W))) r.requiredDimensions.maxWidthCm = +m[1];
    if ((m = t.match(new RegExp(`(\\d{2,3})\\s*cm\\s*${W}\\s*(?:or less|max)`)))) r.requiredDimensions.maxWidthCm = +m[1];
    if ((m = cmMax(D))) r.requiredDimensions.maxDepthCm = +m[1];
    if ((m = t.match(/(?:at least|minimum)\s*(\d{2,3})\s*cm\s*(?:deep|depth)/))) r.requiredDimensions.minDepthCm = +m[1];
    if ((m = t.match(/(?:under|less than|below|max)\s*(\d{2,3})\s*cm\s*(?:tall|high|height)/))) r.requiredDimensions.maxHeightCm = +m[1];

    const mats = ['solid wood', 'engineered wood', 'sheesham', 'teak', 'wooden', 'wood', 'metal', 'steel', 'glass', 'rattan', 'fabric', 'leather'];
    const mat = mats.find(x => t.includes(x));
    if (mat) r.material = mat === 'wooden' ? 'wood' : mat;
    const colors = ['white', 'black', 'brown', 'walnut', 'oak', 'grey', 'gray', 'beige', 'blue', 'green'];
    colors.forEach(c => { if (new RegExp('\\b' + c + '\\b').test(t) && !r.color.includes(c)) r.color.push(c); });
    ['minimal', 'modern', 'industrial', 'scandinavian', 'classic', 'traditional', 'rustic', 'mid-century', 'contemporary'].forEach(s => { if (t.includes(s) && !r.style.includes(s)) r.style.push(s); });
    const feats = [['drawer', 'drawers'], ['storage', 'built-in storage'], ['monitor', 'monitor space'], ['laptop', 'laptop space'], ['foldable', 'foldable'], ['folding', 'foldable'],
      ['sliding', 'sliding doors'], ['mirror', 'mirror'], ['cable', 'cable management'], ['height adjustable', 'height adjustable'], ['adjustable height', 'height adjustable'], ['compact', 'compact']];
    feats.forEach(([k, f]) => { if (t.includes(k) && !r.features.includes(f)) r.features.push(f); });
    if (/compact|small|narrow/.test(t) && !r.features.includes('compact')) r.features.push('compact');
    if (/gaming/.test(t)) r.purpose = 'gaming';
    else if (/study|homework|work from home|wfh|office/.test(t)) r.purpose = 'study and computer work';

    if (/replace (this|the selected|it)|instead of (this|the selected)/.test(t)) r.placement = 'replace_selected';
    else if (/window wall|by the window|near the window|under the window/.test(t)) r.placement = 'window_wall';
    else if (/this wall|along (this|the) wall|for this wall/.test(t)) r.placement = 'selected_wall';
    if (/no (wall )?(mount|drill)|without drilling/.test(t)) r.spatialConstraints.wallMountAllowed = false;
    r.understood = describeRequest(r);
    return r;
  }

  function fromGemini(a, prev) {
    const followUp = a.intent && a.intent !== 'search' && prev;
    const r = followUp ? JSON.parse(JSON.stringify(prev)) : emptyRequest();
    r.intent = ['search', 'refine', 'cheaper', 'similar', 'alternatives'].includes(a.intent) ? a.intent : 'search';
    const c = str(a.category, 40); if (c) r.category = c.toLowerCase();
    const bmin = num(a.budget_min_inr, 100, 1e7), bmax = num(a.budget_max_inr, 100, 1e7);
    if (bmin) r.budget.min = bmin; if (bmax) r.budget.max = bmax;
    const set = (k, v) => { const n = num(v, 10, 600); if (n) r.requiredDimensions[k] = n; };
    set('minWidthCm', a.min_width_cm); set('maxWidthCm', a.max_width_cm); set('minDepthCm', a.min_depth_cm); set('maxDepthCm', a.max_depth_cm); set('maxHeightCm', a.max_height_cm);
    const merge = (k, v) => { arr(v, 6).forEach(x => { if (!r[k].includes(x.toLowerCase())) r[k].push(x.toLowerCase()); }); };
    merge('style', a.style); merge('features', a.features); merge('color', a.color);
    if (str(a.material, 30)) r.material = str(a.material, 30).toLowerCase();
    if (str(a.purpose, 60)) r.purpose = str(a.purpose, 60);
    if (a.placement && a.placement !== 'anywhere') r.placement = a.placement;
    r.understood = describeRequest(r);
    return r;
  }

  function describeRequest(r) {
    const out = [];
    if (r.category) out.push(r.category);
    if (r.budget.max) out.push(`under ₹${RF.fmt(r.budget.max)}`);
    if (r.budget.min) out.push(`over ₹${RF.fmt(r.budget.min)}`);
    const d = r.requiredDimensions;
    if (d.minWidthCm) out.push(`at least ${d.minWidthCm} cm wide`);
    if (d.maxWidthCm) out.push(`at most ${d.maxWidthCm} cm wide`);
    if (d.maxDepthCm) out.push(`at most ${d.maxDepthCm} cm deep`);
    if (d.minDepthCm) out.push(`at least ${d.minDepthCm} cm deep`);
    if (d.maxHeightCm) out.push(`under ${d.maxHeightCm} cm tall`);
    if (r.material) out.push(r.material);
    r.color.forEach(c => out.push(c));
    r.style.forEach(s => out.push(s));
    r.features.forEach(f => out.push(f));
    if (r.placement === 'window_wall') out.push('for the window wall');
    if (r.placement === 'selected_wall') out.push('for the selected wall');
    if (r.placement === 'replace_selected') out.push('replacing the selected piece');
    if (r.intent === 'cheaper') out.push('cheaper than before');
    if (r.intent === 'similar') out.push('similar, different products');
    return out;
  }

  async function parseRequest(text, prev) {
    const url = RF.ai.proxyUrl();
    if (url) {
      try {
        const prompt = `Convert a furniture shopping request into structured search filters. Indian market, prices in INR.
Previous search state (null if none): ${prev ? JSON.stringify({ category: prev.category, budget: prev.budget, requiredDimensions: prev.requiredDimensions, style: prev.style, features: prev.features, material: prev.material }) : 'null'}
If the message only adjusts the previous search ("only wooden ones", "less than 130 cm wide", "cheaper"), use intent refine/cheaper/similar/alternatives and return ONLY the changed fields.
If it names a different kind of furniture, use intent search.
Only include dimensions the user stated. Do not invent sizes.
Message: """${String(text).slice(0, 500)}"""`;
        const res = await fetch(url.replace(/\/$/, '') + '/gemini', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task: 'parseProductRequest', body: { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: REQ_SCHEMA, temperature: 0.1 } } }) });
        if (!res.ok) throw new Error('proxy ' + res.status);
        const j = await res.json();
        const txt = j.candidates[0].content.parts.map(p => p.text || '').join('');
        const r = fromGemini(JSON.parse(txt), prev);
        if (!r.category) throw new Error('no category');
        r.parsedBy = 'Gemini';
        return r;
      } catch (e) { /* fall through to the built-in parser */ }
    }
    const r = parseLocal(text, prev);
    r.parsedBy = 'built-in parser';
    return r;
  }

  /* ---------- room context (only geometry — never photos) ---------- */

  function blockersFor(room, items, excludeUids) {
    const bs = items.filter(i => (i.elev || 0) < FLOOR && !excludeUids.has(i.uid) && !i.preview).map(i => ({ r: RF.rectOf(i), label: i.name }));
    (room.obstacles || []).forEach(o => bs.push({ r: { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.d }, label: o.label || 'Fixed object' }));
    (room.openings || []).filter(o => o.type === 'door' && o.swing !== 'out' && o.swing !== 'slide').forEach(d => bs.push({ r: RF.openingZone(room, d, d.width), label: 'door swing' }));
    return bs;
  }

  /** Free stretches along each wall: width of the run and the clear depth from the wall. Descriptive only. */
  function wallSpaces(room, items, excludeUids) {
    const bs = blockersFor(room, items, excludeUids || new Set());
    const out = [];
    const step = 5;
    for (const wall of ['N', 'E', 'S', 'W']) {
      const horiz = wall === 'N' || wall === 'S', len = horiz ? room.width : room.length, far = horiz ? room.length : room.width;
      const depths = [];
      for (let t = 0; t < len; t += step) {
        let dep = far;
        for (const b of bs) {
          const lo = horiz ? b.r.x0 : b.r.y0, hi = horiz ? b.r.x1 : b.r.y1;
          if (hi <= t + 0.01 || lo >= t + step - 0.01) continue;
          const dist = wall === 'N' ? b.r.y0 : wall === 'S' ? room.length - b.r.y1 : wall === 'W' ? b.r.x0 : room.width - b.r.x1;
          dep = Math.min(dep, Math.max(0, dist));
        }
        depths.push(dep);
      }
      const win = (room.openings || []).filter(o => o.wall === wall && o.type === 'window');
      let i = 0;
      while (i < depths.length) {
        if (depths[i] < 45) { i++; continue; }
        let j = i, minD = depths[i];
        while (j < depths.length && depths[j] >= 45) { minD = Math.min(minD, depths[j]); j++; }
        const start = i * step, width = Math.min(len, j * step) - start;
        if (width >= 40) {
          const underWin = win.find(w => w.offset < start + width && w.offset + w.width > start);
          out.push({ wall, startCm: start, widthCm: width, depthCm: Math.round(minD),
            location: `${RF.WALL_NAME[wall]} wall${underWin ? ', window wall' : ''}`, windowSillCm: underWin ? (underWin.sill != null ? underWin.sill : 90) : null });
        }
        i = j;
      }
    }
    return out.sort((a, b) => b.widthCm * b.depthCm - a.widthCm * a.depthCm);
  }

  function roomContext(room, items, opts) {
    opts = opts || {};
    const rules = RF.effectiveRules(opts.rules, opts.constraints);
    const exclude = new Set(opts.excludeUids || []);
    return {
      roomWidthCm: room.width, roomDepthCm: room.length, roomHeightCm: room.height || null,
      dimensionsVerified: ['width', 'length'].every(k => ((room.provenance || {})[k] || 'verified') === 'verified'),
      roomType: room.type || null,
      availableSpaces: wallSpaces(room, items, exclude).slice(0, 6).map(s => ({ widthCm: s.widthCm, depthCm: s.depthCm, location: s.location, windowSillCm: s.windowSillCm })),
      existingFurniture: items.filter(i => !exclude.has(i.uid) && !i.preview).map(i => ({ category: i.category, widthCm: i.w, depthCm: i.d, heightCm: i.h, wall: RF.wallOf(room, i) ? RF.WALL_NAME[RF.wallOf(room, i)] : null })),
      doors: (room.openings || []).filter(o => o.type === 'door').map(o => ({ wall: RF.WALL_NAME[o.wall], widthCm: o.width, swing: o.swing })),
      windows: (room.openings || []).filter(o => o.type === 'window').map(o => ({ wall: RF.WALL_NAME[o.wall], widthCm: o.width, sillCm: o.sill })),
      constraints: { walkWidthCm: rules.walkWidthCm, wallMountAllowed: !(opts.constraints && opts.constraints.wall_mount_allowed === false), accessibility: !!rules.accessibility }
    };
  }

  /** Target area for a request → spatial constraints derived from actual room geometry. */
  function targetArea(room, items, request, sel, opts) {
    const rules = RF.effectiveRules(opts.rules, opts.constraints);
    const rfCat = RF.shopCategory(request.category);
    const typical = RF.catalog.list().find(p => p.category === rfCat) || {};
    const front = Math.round(Math.max(typical.clearance_front_cm || 0, typical.door_clearance_cm || 0, typical.drawer_clearance_cm || 0) * (rules.clearMult || 1));
    if (request.placement === 'replace_selected' && sel) {
      const ex = new Set([sel.uid].concat(items.filter(i => i.pairedWith === sel.uid).map(i => i.uid)));
      const others = items.filter(i => !ex.has(i.uid));
      const r = RF.rectOf(sel);
      const bs = others.filter(i => (i.elev || 0) < FLOOR).map(i => ({ r: RF.rectOf(i), label: i.name }))
        .concat((room.obstacles || []).map(o => ({ r: { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.d }, label: o.label })));
      const [a, b] = RF.perp(sel.facing).map(d => RF.gapDir(r, d, bs, room).gap);
      const fg = RF.gapDir(r, sel.facing, bs, room).gap;
      // the paired chair is left out while measuring; it is re-paired to the new desk on placement
      return { kind: 'replace', uid: sel.uid, label: `where the ${sel.name} is`, availableWidthCm: Math.round(sel.w + a + b), availableDepthCm: Math.round(sel.d + fg), frontClearanceCm: front, wall: RF.wallOf(room, sel), excludeUids: Array.from(ex), item: sel };
    }
    const spaces = wallSpaces(room, items, new Set());
    let wall = null;
    if (request.placement === 'window_wall') { const w = (room.openings || []).find(o => o.type === 'window'); if (w) wall = w.wall; }
    if (request.placement === 'selected_wall') wall = opts.wall || (sel && RF.wallOf(room, sel)) || null;
    if (opts.wall && !request.placement) wall = opts.wall;
    const pool = wall ? spaces.filter(s => s.wall === wall) : spaces;
    const best = pool.slice().sort((x, y) => y.widthCm - x.widthCm)[0];
    if (!best) return { kind: wall ? 'wall' : 'room', wall, label: wall ? `the ${RF.WALL_NAME[wall]} wall` : 'anywhere in the room', availableWidthCm: null, availableDepthCm: null, frontClearanceCm: front, excludeUids: [] };
    return { kind: wall ? 'wall' : 'room', wall, label: wall ? `the ${RF.WALL_NAME[wall]} wall` : 'anywhere in the room', availableWidthCm: best.widthCm, availableDepthCm: best.depthCm, frontClearanceCm: front, excludeUids: [], space: best };
  }

  function withSpatial(request, area) {
    const r = JSON.parse(JSON.stringify(request));
    r.spatialConstraints = Object.assign({}, r.spatialConstraints);
    if (area.availableWidthCm) r.spatialConstraints.maxWidthCm = area.availableWidthCm;
    if (area.availableDepthCm) r.spatialConstraints.maxDepthCm = Math.max(30, area.availableDepthCm - area.frontClearanceCm);
    if (area.frontClearanceCm) r.spatialConstraints.requiredClearanceFrontCm = area.frontClearanceCm;
    return r;
  }

  /* ---------- product sanitization ---------- */

  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return null; } }
  function httpsUrl(u) { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch (e) { return null; } }

  /**
   * Turn a Gemini search response into trusted Product objects.
   * Rules: name + https productUrl required; the link must be confirmed live by the proxy or its domain must be
   * among the grounding sources; links the proxy found missing are dropped. Dimensions are verified only when the
   * listing states all three and quotes them.
   */
  function sanitizeProducts(raw, ctx) {
    const groundedHosts = new Set((ctx.sources || []).map(s => (s.title || '').toLowerCase().replace(/^www\./, '')).concat((ctx.sources || []).map(s => hostOf(s.uri))).filter(Boolean));
    const checks = ctx.linkChecks || {};
    const kept = [], dropped = [];
    (Array.isArray(raw) ? raw : []).slice(0, 12).forEach((p, i) => {
      const name = str(p && p.name, 140), url = httpsUrl(p && p.productUrl);
      if (!name || !url) { dropped.push({ name: name || '(unnamed)', why: 'missing name or link' }); return; }
      const host = hostOf(url), check = checks[p.productUrl] || checks[url];
      const grounded = [...groundedHosts].some(h => host === h || host.endsWith('.' + h) || h.endsWith('.' + host));
      if (check === 'missing') { dropped.push({ name, why: 'link returned not-found' }); return; }
      if (check !== 'ok' && !grounded) { dropped.push({ name, why: 'link could not be confirmed against search sources' }); return; }
      const dimsIn = p.dimensions || {};
      const w = num(dimsIn.widthCm, 5, 600), d = num(dimsIn.depthCm, 5, 600), h = num(dimsIn.heightCm, 3, 400);
      const quoted = str(p.dimensionsText, 160);
      const currency = str(p.currency, 4) ? p.currency.toUpperCase() : (p.price != null ? 'INR' : null);
      kept.push({
        id: 'web_' + (host || 'x').replace(/[^a-z0-9]/g, '') + '_' + i + '_' + Math.abs(hash(url)),
        name, brand: str(p.brand, 60), retailer: str(p.retailer, 60) || host, category: str(p.category, 40) || ctx.request.category || 'furniture',
        price: num(p.price, 1, 1e8), currency,
        dimensions: { widthCm: w, depthCm: d, heightCm: h },
        dimensionsText: quoted,
        dimensionsVerified: !!(p.dimensionsVerified && w && d && h && quoted),
        dimensionsSource: (p.dimensionsVerified && w && d && h && quoted) ? 'listing' : (w || d || h) ? 'partial-listing' : 'none',
        imageUrl: httpsUrl(p.imageUrl), productUrl: url, sourceUrl: httpsUrl(p.sourceUrl) || url,
        description: str(p.description, 280), features: arr(p.features, 6), material: str(p.material, 40), color: str(p.color, 30),
        availability: str(p.availability, 40), linkStatus: check || 'unchecked', grounded,
        retrievedAt: ctx.searchedAt, provider: ctx.provider, relevance: i
      });
    });
    return { products: kept, dropped };
  }
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

  /* ---------- providers ---------- */

  class GeminiProductSearchProvider {
    constructor(url) { this.url = url.replace(/\/$/, ''); }
    get name() { return 'Gemini web search'; }
    async searchProducts(request, roomContext) {
      const res = await fetch(this.url + '/api/products/search', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: request.query || '', request: publicRequest(request), roomContext }) });
      if (!res.ok) throw new Error('search service returned ' + res.status);
      const j = await res.json();
      const cand = j.gemini && j.gemini.candidates && j.gemini.candidates[0];
      if (!cand) throw new Error('no response from Gemini');
      const text = (cand.content && cand.content.parts || []).map(p => p.text || '').join('');
      const gm = cand.groundingMetadata || {};
      const sources = (gm.groundingChunks || []).map(c => c.web).filter(Boolean).map(w => ({ uri: w.uri, title: w.title }));
      let parsed;
      try { parsed = JSON.parse(extractJson(text)); } catch (e) { throw new Error('Gemini returned results in an unreadable format'); }
      const searchedAt = j.searchedAt || new Date().toISOString();
      const s = sanitizeProducts(parsed.products, { sources, linkChecks: j.linkChecks || {}, searchedAt, provider: this.name, request });
      const warnings = [];
      if (s.dropped.length) warnings.push(`${s.dropped.length} result${s.dropped.length > 1 ? 's were' : ' was'} discarded because ${s.dropped.length > 1 ? 'their links' : 'its link'} couldn't be confirmed.`);
      if (!sources.length) warnings.push('Gemini returned no search sources for this answer.');
      return { products: s.products, dropped: s.dropped, sources, searchedAt, provider: this.name, warnings, queries: gm.webSearchQueries || [] };
    }
  }

  /** The bundled sample catalog — clearly labelled, never presented as live listings. */
  class InternalCatalogProvider {
    get name() { return 'ROOMFIT sample catalog'; }
    async searchProducts(request) {
      const cat = RF.shopCategory(request.category);
      const d = request.requiredDimensions || {};
      const list = RF.catalog.list().filter(p => (cat === 'other' || p.category === cat)
        && (!request.budget.max || p.price_inr <= request.budget.max) && (!request.budget.min || p.price_inr >= request.budget.min)
        && (!d.maxWidthCm || p.width_cm <= d.maxWidthCm) && (!d.minWidthCm || p.width_cm >= d.minWidthCm) && (!d.maxDepthCm || p.depth_cm <= d.maxDepthCm)
        && !(request.excludeNames || []).includes(p.name));
      const now = new Date().toISOString();
      return { provider: this.name, sources: [], searchedAt: now, warnings: ['These are ROOMFIT sample products, not live listings. Connect the Gemini proxy in Settings to search real retailers.'],
        products: list.map((p, i) => ({ id: p.id, name: p.name, brand: null, retailer: 'Sample catalog', category: p.category, price: p.price_inr, currency: 'INR',
          dimensions: { widthCm: p.width_cm, depthCm: p.depth_cm, heightCm: p.height_cm }, dimensionsText: `${p.width_cm} × ${p.depth_cm} × ${p.height_cm} cm (sample data)`,
          dimensionsVerified: true, dimensionsSource: 'sample', imageUrl: null, productUrl: null, sourceUrl: null, features: p.tags, material: null, color: null, availability: null,
          linkStatus: 'none', sample: true, retrievedAt: now, provider: this.name, relevance: i, catalogProduct: p })) };
    }
  }

  /** Placeholder for official retailer / affiliate feeds. Not configured in this build. */
  class RetailerAPIProvider {
    get name() { return 'Retailer API'; }
    async searchProducts() { throw new Error('No retailer API is configured.'); }
  }

  function publicRequest(r) {
    return { category: r.category, budget: r.budget, requiredDimensions: r.requiredDimensions, style: r.style, features: r.features, color: r.color, material: r.material,
      roomType: r.roomType, purpose: r.purpose, quantity: r.quantity, spatialConstraints: r.spatialConstraints, excludeNames: (r.excludeNames || []).slice(0, 20), intent: r.intent };
  }
  function extractJson(text) {
    const s = String(text).replace(/```json|```/g, '');
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('no json');
    return s.slice(a, b + 1);
  }

  /* ---------- cache (keyed by the structured request; prices never treated as permanent) ---------- */

  function cacheKey(request, ctx) {
    return JSON.stringify([RF.shopCategory(request.category), request.category, request.budget, request.requiredDimensions, request.spatialConstraints, request.style, request.features, request.color, request.material, request.excludeNames, ctx.roomWidthCm, ctx.roomDepthCm]);
  }
  function cacheGet(k) {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      const e = c[k];
      if (e && Date.now() - e.at < CACHE_TTL_MS) return e.v;
    } catch (e) { /* ignore */ }
    return null;
  }
  function cachePut(k, v) {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      c[k] = { at: Date.now(), v };
      const keys = Object.keys(c).sort((a, b) => c[b].at - c[a].at).slice(0, 20);
      const out = {}; keys.forEach(x => { out[x] = c[x]; });
      localStorage.setItem(CACHE_KEY, JSON.stringify(out));
    } catch (e) { /* storage full or blocked: skip caching */ }
  }

  /* ---------- geometry validation (delegates to the engine) ---------- */

  function productToItem(product, opts) {
    const cat = product.catalogProduct ? product.catalogProduct.category : RF.shopCategory(product.category + ' ' + product.name);
    const typical = RF.catalog.list().find(p => p.category === cat) || {};
    const dm = product.dimensions || {};
    const heightAssumed = !dm.heightCm;
    const it = RF.instance({
      id: product.id, name: product.name, category: cat,
      width_cm: dm.widthCm, depth_cm: dm.depthCm, height_cm: dm.heightCm || (cat === 'other' ? 80 : typical.height_cm || 80),
      price_inr: product.currency === 'INR' && product.price ? product.price : 0,
      clearance_front_cm: typical.clearance_front_cm || 0, clearance_side_cm: typical.clearance_side_cm || 0, clearance_back_cm: typical.clearance_back_cm || 0,
      door_clearance_cm: typical.door_clearance_cm || 0, drawer_clearance_cm: typical.drawer_clearance_cm || 0,
      requires_wall_mount: false, elevation_cm: 0, style: [], tags: [], sample: !!product.sample
    });
    it.sample = !!product.sample;
    it.source = { productUrl: product.productUrl, retailer: product.retailer, retrievedAt: product.retrievedAt, dimensionsSource: product.dimensionsSource, heightAssumed };
    return Object.assign(it, opts || {});
  }

  /**
   * validateProductAgainstRoom(product, room, placementContext) → ProductFitResult.
   * placementContext: { items, rules, constraints, area }
   */
  function validateProductAgainstRoom(product, room, pc) {
    const dm = product.dimensions || {};
    const base = { productId: product.id, fits: false, confidence: 'unknown', status: 'unknown', collisions: [], clearanceViolations: [], doorViolations: [], windowViolations: [], circulationViolations: [], reasons: [], facts: [] };
    const usable = product.dimensionsVerified || product.dimensionsSource === 'user' || product.dimensionsSource === 'sample';
    if (!dm.widthCm || !dm.depthCm) {
      base.reasons.push('The listing does not give width and depth, so physical fit cannot be checked.');
      return base;
    }
    const area = pc.area || {};
    const ex = new Set(area.excludeUids || []);
    const items = (pc.items || []).filter(i => !ex.has(i.uid) && !i.preview);
    const proto = productToItem(product);
    const ctx = { rules: pc.rules, constraints: pc.constraints };
    if (area.kind === 'replace' && area.item) {
      const t = area.item, tr = RF.rectOf(t), back = RF.OPP[t.facing];
      const backGap = { N: tr.y0, S: room.length - tr.y1, W: tr.x0, E: room.width - tr.x1 }[back];
      const wall = backGap <= 2 ? back : null;
      const flush = { x: t.x, y: t.y, facing: t.facing, wall };
      // keep the back against the same wall as the piece being replaced
      if (wall === 'N') flush.y = dm.depthCm / 2; else if (wall === 'S') flush.y = room.length - dm.depthCm / 2;
      else if (wall === 'W') flush.x = dm.depthCm / 2; else if (wall === 'E') flush.x = room.width - dm.depthCm / 2;
      ctx.extraCandidates = wall ? [flush, { x: t.x, y: t.y, facing: t.facing }] : [{ x: t.x, y: t.y, facing: t.facing }];
      ctx.placementFilter = c => Math.hypot(c.x - t.x, c.y - t.y) <= 90;
    } else if (area.wall) {
      ctx.placementFilter = c => c.wall === area.wall;
    }
    const res = RF.findPlacement(room, items, proto, ctx);
    if (!res.item || !res.validation) { base.status = 'does_not_fit'; base.reasons.push('No position could be tested in the target area.'); return base; }
    const v = res.validation, it = res.item, rec = v.items[it.uid];
    const rules = v.rules;
    const pick = ids => v.violations.filter(x => ids.includes(x.id));
    base.collisions = pick(['collision', 'inside']).map(x => ({ item: x.name, detail: x.detail }));
    base.clearanceViolations = pick(['front', 'side', 'back']).map(x => ({ item: x.name, detail: x.detail }));
    base.doorViolations = pick(['door', 'landing']).map(x => ({ item: x.name, detail: x.detail }));
    base.windowViolations = pick(['window']).map(x => ({ item: x.name, detail: x.detail }));
    base.circulationViolations = pick(['access', 'wallmount']).map(x => ({ item: x.name, detail: x.detail }));

    // measured space around the best (or closest) position — all from engine primitives
    const r = RF.rectOf(it);
    const bs = items.filter(i => (i.elev || 0) < FLOOR).map(i => ({ r: RF.rectOf(i), label: i.name }))
      .concat((room.obstacles || []).map(o => ({ r: { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.d }, label: o.label })));
    const lat = RF.perp(it.facing).map(d => RF.gapDir(r, d, bs, room).gap);
    const frontGap = RF.gapDir(r, it.facing, bs, room).gap;
    const fr = RF.requiredFront(it, rules);
    // lateral span is clipped to the room so an oversize product can't report more space than the wall has
    const along = (it.facing === 'S' || it.facing === 'N') ? room.width : room.length;
    const latLo = (it.facing === 'S' || it.facing === 'N') ? Math.max(0, r.x0) : Math.max(0, r.y0);
    const latHi = (it.facing === 'S' || it.facing === 'N') ? Math.min(room.width, r.x1) : Math.min(room.length, r.y1);
    base.availableWidthCm = Math.round(Math.min(along, Math.max(0, latHi - latLo) + lat[0] + lat[1]));
    base.remainingWidthCm = Math.round(base.availableWidthCm - it.w);
    base.availableDepthCm = Math.round(it.d + Math.min(frontGap, 999));
    base.remainingDepthCm = Math.round(frontGap - fr);
    base.placement = { x: it.x, y: it.y, facing: it.facing, wall: RF.wallOf(room, it) };
    base.item = it;
    base.validation = v;
    base.positionsTested = res.tested;

    const fc = rec.checks.find(c => c.id === 'front');
    const door = rec.checks.find(c => c.id === 'door');
    base.facts.push({ label: area.kind === 'replace' ? 'Available width at this spot' : 'Available wall width', value: base.availableWidthCm, unit: 'cm' });
    base.facts.push({ label: 'Product width', value: it.w, unit: 'cm' });
    base.facts.push({ label: 'Remaining', value: base.remainingWidthCm, unit: 'cm' });
    if (fc) { base.facts.push({ label: 'Required front clearance', value: fc.required, unit: 'cm' }); base.facts.push({ label: 'Available', value: Math.min(fc.available, 300), unit: 'cm', plus: fc.available >= 300 }); }
    if (door) base.facts.push({ label: 'Door clearance', text: door.status === 'pass' ? '✓ Clear' : '✕ ' + door.detail });
    base.facts.push({ label: 'Furniture collision', text: base.collisions.length ? '✕ ' + base.collisions[0].detail : '✓ None' });
    if (v.circulation && v.circulation.maxWidth != null) base.facts.push({ label: 'Widest walkway left', value: v.circulation.maxWidth, unit: 'cm' });

    // shortfalls for "why it doesn't fit"
    base.shortfalls = [];
    rec.checks.filter(c => c.status === 'fail' && c.required != null && c.unit === 'cm').forEach(c => base.shortfalls.push({ label: c.label, required: c.required, available: c.available, short: c.required - c.available }));
    if (!res.ok) {
      const room0 = Math.max(room.width, room.length);
      if (it.w > room0) base.shortfalls.unshift({ label: 'Product width vs longest wall', required: it.w, available: room0, short: it.w - room0 });
      else if (area.availableWidthCm && it.w > area.availableWidthCm) base.shortfalls.unshift({ label: 'Product width vs available width', required: it.w, available: area.availableWidthCm, short: it.w - area.availableWidthCm });
    }
    base.reasons = res.ok ? rec.checks.filter(c => c.status === 'pass').map(c => c.detail) : v.violations.map(x => (x.uid === it.uid ? '' : x.name + ': ') + x.detail);

    const roomVerified = ['width', 'length'].every(k => ((room.provenance || {})[k] || 'verified') === 'verified');
    base.fits = !!res.ok;
    if (!res.ok) { base.status = 'does_not_fit'; base.confidence = usable && roomVerified ? 'verified' : 'partial'; }
    else if (usable && !proto.source.heightAssumed && roomVerified) { base.status = 'fits'; base.confidence = 'verified'; }
    else {
      base.status = 'partial'; base.confidence = 'partial';
      if (!usable) base.reasons.unshift('Some dimensions on the listing are incomplete or not clearly stated.');
      if (proto.source.heightAssumed) base.reasons.unshift(`Height isn't listed; window and height checks assumed ${it.h} cm.`);
      if (!roomVerified) base.reasons.unshift('Your room size is estimated, so this result is provisional.');
    }
    return base;
  }

  /* ---------- search orchestration ---------- */

  function provider() {
    const u = RF.ai.proxyUrl();
    return u ? new GeminiProductSearchProvider(u) : new InternalCatalogProvider();
  }

  /**
   * Run one search. onStep(stepId, state) is called as each real stage starts/finishes.
   * Returns { request, products, fitResults, metadata }.
   */
  async function search(request, env, onStep) {
    onStep = onStep || (() => {});
    onStep('space', 'run');
    const area = targetArea(env.room, env.items, request, env.selected, env);
    const req = withSpatial(request, area);
    const ctxRoom = roomContext(env.room, env.items, { rules: env.rules, constraints: env.constraints, excludeUids: area.excludeUids });
    onStep('space', 'done');

    const p = provider();
    const key = cacheKey(req, ctxRoom) + p.name;
    let result = env.noCache ? null : cacheGet(key), cached = !!result;
    onStep('search', 'run');
    if (!result) { result = await p.searchProducts(req, ctxRoom); cachePut(key, result); }
    onStep('search', 'done');

    onStep('dims', 'run');
    let products = result.products.filter(x => !(req.excludeNames || []).includes(x.name));
    // apply the user's explicit limits to listed numbers only; unknown values stay in (shown as unknown)
    const d = req.requiredDimensions || {};
    products = products.filter(x => {
      const dm = x.dimensions || {};
      if (req.budget.max && x.price && x.currency === 'INR' && x.price > req.budget.max) return false;
      if (req.budget.min && x.price && x.currency === 'INR' && x.price < req.budget.min) return false;
      if (d.maxWidthCm && dm.widthCm && dm.widthCm > d.maxWidthCm) return false;
      if (d.minWidthCm && dm.widthCm && dm.widthCm < d.minWidthCm) return false;
      if (d.maxDepthCm && dm.depthCm && dm.depthCm > d.maxDepthCm) return false;
      if (d.minDepthCm && dm.depthCm && dm.depthCm < d.minDepthCm) return false;
      if (d.maxHeightCm && dm.heightCm && dm.heightCm > d.maxHeightCm) return false;
      return true;
    });
    onStep('dims', 'done');

    onStep('fit', 'run');
    const fitResults = products.map(x => validateProductAgainstRoom(x, env.room, { items: env.items, rules: env.rules, constraints: env.constraints, area }));
    onStep('fit', 'done');
    return { request: req, area, products, fitResults, metadata: { searchedAt: result.searchedAt, provider: result.provider, sources: result.sources || [], warnings: result.warnings || [], cached, dropped: result.dropped || [], queries: result.queries || [] } };
  }

  /** Follow-up request for alternatives / cheaper / similar, built from structured state. */
  function derive(kind, request, product, fit) {
    const r = JSON.parse(JSON.stringify(request));
    r.excludeNames = Array.from(new Set((r.excludeNames || []).concat(product ? [product.name] : [])));
    if (kind === 'alternatives' && fit) {
      r.intent = 'alternatives';
      if (fit.availableWidthCm) r.requiredDimensions.maxWidthCm = Math.min(r.requiredDimensions.maxWidthCm || 9999, fit.availableWidthCm);
      const fs = (fit.shortfalls || []).find(s => /front/i.test(s.label));
      if (fs && product && product.dimensions.depthCm) r.requiredDimensions.maxDepthCm = Math.max(25, product.dimensions.depthCm - fs.short);
      delete r.requiredDimensions.minWidthCm;
    }
    if (kind === 'cheaper') {
      r.intent = 'cheaper';
      const p = product && product.price ? product.price : request.budget.max;
      if (p) r.budget.max = Math.max(500, Math.round(p * 0.9));
    }
    if (kind === 'similar' && product) {
      r.intent = 'similar';
      const dm = product.dimensions || {};
      if (dm.widthCm) { r.requiredDimensions.minWidthCm = Math.round(dm.widthCm * 0.9); r.requiredDimensions.maxWidthCm = Math.round(dm.widthCm * 1.1); }
      if (dm.depthCm) r.requiredDimensions.maxDepthCm = Math.round(dm.depthCm * 1.15);
      if (product.price) { r.budget.max = Math.round(product.price * 1.25); r.budget.min = null; }
      if (product.material && !r.material) r.material = product.material;
    }
    r.understood = describeRequest(r);
    return r;
  }

  /** Shop this room: one search per non-existing piece, constrained to that piece's footprint. */
  async function shopRoom(env, onLine) {
    const pieces = env.items.filter(i => !i.existing && !i.preview && !(i.category === 'chair' && i.pairedWith && false));
    const lines = [];
    for (const it of pieces) {
      const label = categoryQuery(it);
      const req = Object.assign(emptyRequest(), { category: label, placement: 'replace_selected', purpose: env.purpose || null, roomType: env.room.type || null });
      onLine && onLine({ uid: it.uid, name: it.name, state: 'searching' });
      try {
        const res = await search(req, Object.assign({}, env, { selected: it }), () => {});
        const options = res.products.map((p, k) => ({ p, f: res.fitResults[k] }));
        const fitting = options.filter(o => o.f.status === 'fits' && o.p.price && o.p.currency === 'INR').sort((a, b) => a.p.price - b.p.price);
        const line = { uid: it.uid, name: it.name, label, options, choice: fitting[Math.floor((fitting.length - 1) / 2)] || null, meta: res.metadata, request: res.request, area: res.area };
        lines.push(line); onLine && onLine(Object.assign({ state: 'done' }, line));
      } catch (e) {
        const line = { uid: it.uid, name: it.name, label, options: [], choice: null, error: e.message };
        lines.push(line); onLine && onLine(Object.assign({ state: 'error' }, line));
      }
    }
    return lines;
  }
  function categoryQuery(it) {
    const base = { bed: 'bed frame', desk: 'desk', chair: 'chair', wardrobe: 'wardrobe', bookshelf: 'bookshelf', storage: 'storage cabinet', sofa: 'sofa', armchair: 'armchair',
      coffee_table: 'coffee table', tv_unit: 'TV unit', bedside: 'bedside table', dressing_table: 'dressing table', wall_shelf: 'wall shelf' }[it.category] || it.name;
    if (it.category === 'bed' && it.tags && it.tags.length) return it.tags[0] + ' ' + base;
    if ((it.category === 'desk' || it.category === 'chair') && it.tags && it.tags.includes('gaming')) return 'gaming ' + base;
    return base;
  }

  /** Budget optimisation: propose cheaper fitting options; never applies them itself. */
  async function optimizeBudget(lines, budget, env) {
    const total = () => lines.reduce((a, l) => a + (l.choice ? l.choice.p.price : 0), 0);
    const changes = [];
    const order = lines.filter(l => l.choice).sort((a, b) => b.choice.p.price - a.choice.p.price);
    let running = total();
    for (const l of order) {
      if (running <= budget) break;
      let cheaper = l.options.filter(o => o.f.status === 'fits' && o.p.price && o.p.currency === 'INR' && o.p.price < l.choice.p.price).sort((a, b) => a.p.price - b.p.price)[0];
      if (!cheaper && l.request) {
        try {
          const res = await search(derive('cheaper', l.request, l.choice.p), Object.assign({}, env, { selected: env.items.find(i => i.uid === l.uid) }), () => {});
          const opts = res.products.map((p, k) => ({ p, f: res.fitResults[k] }));
          l.options = l.options.concat(opts);
          cheaper = opts.filter(o => o.f.status === 'fits' && o.p.price && o.p.currency === 'INR' && o.p.price < l.choice.p.price).sort((a, b) => a.p.price - b.p.price)[0];
        } catch (e) { /* keep current choice */ }
      }
      if (cheaper) { changes.push({ uid: l.uid, label: l.label, from: l.choice, to: cheaper, saved: l.choice.p.price - cheaper.p.price }); running -= l.choice.p.price - cheaper.p.price; }
    }
    return { changes, newTotal: running };
  }

  RF.shop = { parseRequest, parseLocal, emptyRequest, describeRequest, roomContext, wallSpaces, targetArea, sanitizeProducts, validateProductAgainstRoom, productToItem,
    search, derive, shopRoom, optimizeBudget, providers: { GeminiProductSearchProvider, InternalCatalogProvider, RetailerAPIProvider }, provider, publicRequest };
})(window.RF = window.RF || {});
