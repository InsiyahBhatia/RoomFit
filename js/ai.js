/*
 * ROOMFIT AI provider layer.
 *
 * interface AIProvider {
 *   analyzeRoom(images, hints): Promise<RoomAnalysis>
 *   parseRequirements(text, context): Promise<DesignRequirements>
 *   explainLayout(facts, deterministicLines): Promise<LayoutExplanation>
 * }
 *
 * The AI proposes; RF.validate verifies. Nothing returned here is trusted as geometry:
 * room analysis is marked "estimated" and every number is clamped; explanations are rejected
 * if they contain any number that isn't in the computed facts.
 *
 * The Gemini key never reaches the browser. GeminiProxyProvider talks to a small proxy
 * (proxy/dev-proxy.ps1 locally, or proxy/worker.js on Cloudflare) that holds GEMINI_API_KEY.
 */
(function (RF) {
  'use strict';

  class AIUnavailable extends Error {}
  RF.AIUnavailable = AIUnavailable;

  /* ---------- schemas (Gemini structured output) ---------- */

  const ROOM_SCHEMA = {
    type: 'OBJECT',
    properties: {
      room_type: { type: 'STRING' },
      width_cm: { type: 'NUMBER', nullable: true },
      length_cm: { type: 'NUMBER', nullable: true },
      height_cm: { type: 'NUMBER', nullable: true },
      confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
      perspective: { type: 'STRING' },
      openings: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        type: { type: 'STRING', enum: ['door', 'window'] }, wall: { type: 'STRING', enum: ['N', 'E', 'S', 'W'] },
        offset_cm: { type: 'NUMBER' }, width_cm: { type: 'NUMBER' }, sill_cm: { type: 'NUMBER', nullable: true }
      }, required: ['type', 'wall', 'width_cm'] } },
      existing_furniture: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        type: { type: 'STRING' }, width_cm: { type: 'NUMBER' }, depth_cm: { type: 'NUMBER' }, height_cm: { type: 'NUMBER' },
        x_cm: { type: 'NUMBER' }, y_cm: { type: 'NUMBER' }
      }, required: ['type', 'width_cm', 'depth_cm'] } },
      fixtures: { type: 'ARRAY', items: { type: 'STRING' } },
      notes: { type: 'STRING' }
    },
    required: ['room_type', 'confidence', 'openings', 'existing_furniture']
  };

  const REQ_SCHEMA = {
    type: 'OBJECT',
    properties: {
      intent: { type: 'STRING', enum: ['update', 'cheapest', 'explain'] },
      budget_inr: { type: 'NUMBER', nullable: true },
      people: { type: 'NUMBER', nullable: true },
      purpose: { type: 'STRING', nullable: true },
      required: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        category: { type: 'STRING', enum: Object.keys(RF.CATEGORY_LABELS) }, qty: { type: 'NUMBER' }, hint: { type: 'STRING', nullable: true }
      }, required: ['category', 'qty'] } },
      constraints: { type: 'OBJECT', properties: {
        desk_max_width_cm: { type: 'NUMBER', nullable: true }, desk_min_width_cm: { type: 'NUMBER', nullable: true },
        storage_priority: { type: 'STRING', enum: ['low', 'normal', 'high'], nullable: true },
        natural_light_priority: { type: 'STRING', enum: ['low', 'normal', 'high'], nullable: true },
        desk_near_window: { type: 'BOOLEAN', nullable: true }, bed_avoid_window: { type: 'BOOLEAN', nullable: true },
        wall_mount_allowed: { type: 'BOOLEAN', nullable: true }, door_keep_clear: { type: 'BOOLEAN', nullable: true },
        openness: { type: 'STRING', enum: ['normal', 'high'], nullable: true }, accessibility: { type: 'BOOLEAN', nullable: true }
      } },
      style: { type: 'ARRAY', items: { type: 'STRING' } },
      understood: { type: 'ARRAY', items: { type: 'STRING' } }
    },
    required: ['intent', 'required', 'constraints', 'understood']
  };

  /* ---------- sanitizers: AI output → trusted shapes ---------- */

  const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, Math.round(v))) : null;

  function sanitizeRoom(a) {
    const out = { roomType: String(a.room_type || 'room').slice(0, 40), confidence: ['low', 'medium', 'high'].includes(a.confidence) ? a.confidence : 'low',
      width: num(a.width_cm, 150, 1500), length: num(a.length_cm, 150, 1500), height: num(a.height_cm, 200, 500),
      openings: [], existing: [], fixtures: (a.fixtures || []).slice(0, 10).map(s => String(s).slice(0, 60)), notes: String(a.notes || '').slice(0, 400) };
    (a.openings || []).slice(0, 8).forEach((o, i) => {
      if (!['door', 'window'].includes(o.type) || !['N', 'E', 'S', 'W'].includes(o.wall)) return;
      out.openings.push({ id: 'ai_op' + i, type: o.type, wall: o.wall, offset: num(o.offset_cm, 0, 1500) || 20, width: num(o.width_cm, 40, 400) || (o.type === 'door' ? 90 : 120),
        sill: o.type === 'window' ? (num(o.sill_cm, 0, 200) ?? 90) : undefined, hinge: 'start', swing: 'in', height: o.type === 'door' ? 210 : 120, label: o.type === 'door' ? 'the door' : 'the window' });
    });
    (a.existing_furniture || []).slice(0, 12).forEach(f => {
      const w = num(f.width_cm, 20, 400), d = num(f.depth_cm, 20, 400);
      if (!w || !d) return;
      out.existing.push({ type: String(f.type).slice(0, 30), w, d, h: num(f.height_cm, 10, 300) || 80, x: num(f.x_cm, 0, 1500), y: num(f.y_cm, 0, 1500) });
    });
    return out;
  }

  function sanitizeReq(a) {
    const r = { intent: ['update', 'cheapest', 'explain'].includes(a.intent) ? a.intent : 'update', required: [], constraints: {}, style: [], understood: [] };
    const b = num(a.budget_inr, 1000, 1e8); if (b) r.budget = b;
    const p = num(a.people, 1, 20); if (p) r.people = p;
    if (a.purpose) r.purpose = String(a.purpose).slice(0, 40);
    (a.required || []).forEach(x => { if (RF.CATEGORY_LABELS[x.category]) r.required.push({ category: x.category, qty: num(x.qty, 1, 6) || 1, hint: x.hint ? String(x.hint).toLowerCase().slice(0, 20) : null }); });
    const c = a.constraints || {};
    for (const k of ['desk_max_width_cm', 'desk_min_width_cm']) { const v = num(c[k], 40, 400); if (v) r.constraints[k] = v; }
    for (const k of ['desk_near_window', 'bed_avoid_window', 'wall_mount_allowed', 'door_keep_clear', 'accessibility']) if (typeof c[k] === 'boolean') r.constraints[k] = c[k];
    if (['low', 'normal', 'high'].includes(c.storage_priority)) r.constraints.storage_priority = c.storage_priority;
    if (['low', 'normal', 'high'].includes(c.natural_light_priority)) r.constraints.natural_light_priority = c.natural_light_priority;
    if (c.openness === 'high') r.constraints.openness = 'high';
    r.style = (a.style || []).map(s => String(s).toLowerCase()).slice(0, 4);
    r.understood = (a.understood || []).map(s => String(s).slice(0, 80)).slice(0, 8);
    return r;
  }

  /** Reject any explanation containing numbers that aren't in the computed facts. */
  function numbersAreGrounded(text, facts) {
    const allowed = new Set((JSON.stringify(facts).match(/\d+(\.\d+)?/g) || []).map(Number));
    const used = (text.replace(/,(\d{3})/g, '$1').match(/\d+(\.\d+)?/g) || []).map(Number);
    return used.every(n => allowed.has(n) || n <= 4);
  }

  /* ---------- providers ---------- */

  class LocalProvider {
    get name() { return 'Built-in'; }
    get canSee() { return false; }
    async analyzeRoom() { throw new AIUnavailable('Photo analysis needs the Gemini proxy. Enter dimensions manually, or set the proxy URL in Settings.'); }
    async parseRequirements(text, ctx) { return Object.assign(RF.nl.parse(text, ctx), { source: 'built-in parser' }); }
    async explainLayout(facts, lines) { return { text: lines, source: 'computed facts' }; }
    async readSpec() { throw new AIUnavailable('Reading dimensions from a product image needs the Gemini proxy. Enter the dimensions manually.'); }
  }

  class GeminiProxyProvider {
    constructor(url) { this.url = url.replace(/\/$/, ''); }
    get name() { return 'Gemini'; }
    get canSee() { return true; }

    async call(task, parts, schema) {
      const body = { contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 } };
      const res = await fetch(this.url + '/gemini', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task, body }) });
      if (!res.ok) throw new AIUnavailable(`Gemini proxy returned ${res.status}`);
      const j = await res.json();
      const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content.parts.map(p => p.text || '').join('');
      if (!txt) throw new AIUnavailable('Gemini returned no content');
      return JSON.parse(txt);
    }

    async analyzeRoom(images, hints) {
      const prompt = `You are the perception step of a furniture-fit tool. Analyse the room photo(s).
Return estimates only — they will be shown as "estimated" and checked by a geometry engine.
Use a top-down frame: the wall the camera faces is N; E is to its right, W to its left, S behind the camera.
Offsets are cm from the west end (N/S walls) or north end (E/W walls). Positions x_cm (from west) y_cm (from north) are furniture centres.
If you cannot estimate a dimension, return null — do not guess precise numbers from a single photo.
${hints && hints.width ? `The user measured the room width as ${hints.width} cm.` : ''}${hints && hints.length ? ` Length ${hints.length} cm.` : ''}`;
      const parts = [{ text: prompt }].concat(images.map(i => ({ inline_data: { mime_type: i.mime, data: i.data } })));
      return sanitizeRoom(await this.call('analyzeRoom', parts, ROOM_SCHEMA));
    }

    async parseRequirements(text, ctx) {
      const prompt = `Convert the user's furniture-planning request into structured constraints. Only include what they said or clearly implied.
Categories: ${Object.keys(RF.CATEGORY_LABELS).join(', ')}. Hints are size/use words such as queen, king, single, double, gaming, 5-seat.
"make the desk smaller" → desk_max_width_cm one less than the current desk width (${(ctx.items || []).filter(i => i.category === 'desk').map(i => i.w + ' cm').join(', ') || 'unknown'}).
"cheapest" → intent cheapest. "why" → intent explain. Budget in INR.
User: """${String(text).slice(0, 600)}"""`;
      const r = sanitizeReq(await this.call('parseRequirements', [{ text: prompt }], REQ_SCHEMA));
      // keep parity with the built-in parser for generic per-category keys
      const local = RF.nl.parse(text, ctx);
      for (const k in local.constraints) if (!(k in r.constraints) && /_(near|avoid)_window$|_max_width_cm$|_min_width_cm$/.test(k)) r.constraints[k] = local.constraints[k];
      if (!r.understood.length) r.understood = local.understood;
      r.source = 'Gemini';
      return r;
    }

    async explainLayout(facts, lines) {
      const prompt = `Rewrite these computed facts about a furniture layout as 3–5 short, plain sentences for a homeowner.
Use ONLY numbers that appear in the facts. Do not add measurements, prices, or claims. No marketing language.
Facts JSON: ${JSON.stringify(facts)}
Reference wording: ${lines.join(' ')}`;
      try {
        const out = await this.call('explainLayout', [{ text: prompt }], { type: 'OBJECT', properties: { sentences: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['sentences'] });
        const s = (out.sentences || []).map(x => String(x).slice(0, 300)).slice(0, 6);
        if (s.length && numbersAreGrounded(s.join(' '), facts)) return { text: s, source: 'Gemini, checked against computed facts' };
        return { text: lines, source: 'computed facts (AI wording rejected: it used numbers not in the facts)' };
      } catch (e) { return { text: lines, source: 'computed facts' }; }
    }

    async readSpec(image) {
      const out = await this.call('readSpec', [{ text: 'Read the furniture product dimensions from this image or spec sheet. Return null for anything not printed. Do not estimate from the picture.' }, { inline_data: { mime_type: image.mime, data: image.data } }],
        { type: 'OBJECT', properties: { name: { type: 'STRING', nullable: true }, width_cm: { type: 'NUMBER', nullable: true }, depth_cm: { type: 'NUMBER', nullable: true }, height_cm: { type: 'NUMBER', nullable: true }, category: { type: 'STRING', nullable: true } } });
      return { name: out.name ? String(out.name).slice(0, 60) : null, w: num(out.width_cm, 10, 600), d: num(out.depth_cm, 10, 600), h: num(out.height_cm, 5, 300), category: RF.CATEGORY_LABELS[out.category] ? out.category : 'other' };
    }
  }

  RF.ai = {
    local: new LocalProvider(),
    proxyUrl() { try { return localStorage.getItem('rf.proxyUrl') || 'http://localhost:8787'; } catch (e) { return 'http://localhost:8787'; } },
    setProxyUrl(u) { try { u ? localStorage.setItem('rf.proxyUrl', u) : localStorage.removeItem('rf.proxyUrl'); } catch (e) { /* ignore */ } },
    provider() { const u = this.proxyUrl(); return u ? new GeminiProxyProvider(u) : this.local; },
    /** Run with the configured provider; fall back to the built-in one for text tasks. */
    async run(method, ...args) {
      const p = this.provider();
      try { return await p[method](...args); }
      catch (e) {
        if (p === this.local || method === 'analyzeRoom' || method === 'readSpec') throw e;
        const r = await this.local[method](...args);
        if (r && typeof r === 'object') r.fallback = `Gemini unavailable (${e.message}) — used the built-in parser.`;
        return r;
      }
    },
    async ping() {
      const u = this.proxyUrl(); if (!u) return false;
      try { const r = await fetch(u.replace(/\/$/, '') + '/health'); return r.ok; } catch (e) { return false; }
    }
  };
})(window.RF = window.RF || {});
