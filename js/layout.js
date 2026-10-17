/*
 * ROOMFIT layout optimizer. Generates arrangements by beam search over wall-aligned placements;
 * every candidate is checked by RF.validate, and only fully valid layouts are returned as recommendations.
 */
(function (RF) {
  'use strict';

  RF.STRATEGIES = [
    { id: 'floor', letter: 'A', title: 'Most floor space' },
    { id: 'storage', letter: 'B', title: 'Most storage' },
    { id: 'workspace', letter: 'C', title: 'Most workspace' },
    { id: 'balanced', letter: 'D', title: 'Balanced' }
  ];
  RF.CHEAPEST = { id: 'cheapest', letter: 'E', title: 'Lowest cost' };

  const PRIORITY = { bed: 1, wardrobe: 2, sofa: 2, desk: 3, tv_unit: 4, dressing_table: 5, bookshelf: 5, storage: 5, armchair: 6, bedside: 7, coffee_table: 8, chair: 8, wall_shelf: 9, other: 6 };
  const FLOATING = ['sofa', 'armchair', 'coffee_table'];
  const BEAM = 5;

  const volume = p => (p.width_cm * p.depth_cm * p.height_cm) / 1e6;
  const footprint = p => p.width_cm * p.depth_cm;

  /* ---------- product choice ---------- */

  function productOptions(slot, strat, req, cons) {
    let list = RF.catalog.list().filter(p => p.category === slot.category);
    if (slot.pinned) return list.filter(p => p.id === slot.pinned);
    if (cons.wall_mount_allowed === false) list = list.filter(p => !p.requires_wall_mount);
    const maxW = cons[slot.category + '_max_width_cm'], minW = cons[slot.category + '_min_width_cm'];
    if (maxW) list = list.filter(p => p.width_cm <= maxW);
    if (minW) list = list.filter(p => p.width_cm >= minW);
    if (slot.hint) { const m = list.filter(p => p.tags.includes(slot.hint)); if (m.length) list = m; }
    if (req.style && req.style.length && strat !== 'cheapest') {
      const m = list.filter(p => p.style.some(s => req.style.includes(s)));
      if (m.length) list = m;
    }
    const isStore = RF.STORAGE_CATEGORIES.includes(slot.category);
    const med = list.map(footprint).sort((a, b) => a - b)[Math.floor(list.length / 2)] || 0;
    const key = {
      floor: p => footprint(p),
      storage: p => isStore ? -volume(p) : footprint(p),
      workspace: p => slot.category === 'desk' ? -p.width_cm : footprint(p),
      balanced: p => Math.abs(footprint(p) - med) + p.price_inr / 1e5,
      cheapest: p => p.price_inr
    }[strat] || footprint;
    return list.slice().sort((a, b) => key(a) - key(b));
  }

  function buildSlots(req) {
    const slots = [];
    (req.required || []).forEach(r => { for (let i = 0; i < (r.qty || 1); i++) slots.push({ category: r.category, pinned: r.pinnedId || null, hint: r.hint || null }); });
    const chairs = slots.filter(s => s.category === 'chair');
    const rest = slots.filter(s => s.category !== 'chair');
    rest.filter(s => s.category === 'desk').forEach(d => {
      d.companion = chairs.length ? chairs.shift() : { category: 'chair', auto: true, hint: d.hint === 'gaming' ? 'gaming' : null };
    });
    return rest.concat(chairs).sort((a, b) => (PRIORITY[a.category] || 6) - (PRIORITY[b.category] || 6));
  }

  /* ---------- placement search ---------- */

  function companionFor(desk, chairProto, rules) {
    const r = RF.rectOf(desk), off = chairProto.d / 2 - rules.tuckCm;
    const c = Object.assign({}, chairProto, { uid: RF.uid(), facing: RF.OPP[desk.facing], pairedWith: desk.uid });
    if (desk.facing === 'S') { c.x = desk.x; c.y = r.y1 + off; }
    else if (desk.facing === 'N') { c.x = desk.x; c.y = r.y0 - off; }
    else if (desk.facing === 'E') { c.y = desk.y; c.x = r.x1 + off; }
    else { c.y = desk.y; c.x = r.x0 - off; }
    return c;
  }

  RF.companionFor = companionFor;

  function candidatesFor(room, slot, placed, rules) {
    const proto = slot.proto, out = [];
    if (proto.category === 'coffee_table') {
      const sofa = placed.find(i => i.category === 'sofa');
      if (sofa) {
        const r = RF.rectOf(sofa), gap = 40, f = sofa.facing, t = Object.assign({}, proto, { uid: RF.uid(), facing: f, pairedWith: sofa.uid });
        const vert = f === 'S' || f === 'N', half = vert ? proto.d / 2 : proto.d / 2;
        if (f === 'S') { t.x = sofa.x; t.y = r.y1 + gap + half; } else if (f === 'N') { t.x = sofa.x; t.y = r.y0 - gap - half; }
        else if (f === 'E') { t.y = sofa.y; t.x = r.x1 + gap + half; } else { t.y = sofa.y; t.x = r.x0 - gap - half; }
        return [[t]];
      }
    }
    const pos = RF.candidatePositions(room, proto, { step: 10, floating: FLOATING.includes(proto.category) && proto.category !== 'coffee_table' });
    for (const c of pos) {
      const it = Object.assign({}, proto, { uid: RF.uid(), x: c.x, y: c.y, facing: c.facing });
      if (slot.companionProto) out.push([it, companionFor(it, slot.companionProto, rules)]);
      else out.push([it]);
    }
    return out;
  }

  function score(room, group, placed, strat, cons) {
    const it = group[0], r = RF.rectOf(it), cat = it.category;
    const ops = room.openings || [];
    let s = 0;
    for (const d of ops.filter(o => o.type === 'door')) {
      const dist = RF.distRectPoint(r, RF.openingGeom(room, d).mid);
      const zone = cons.door_keep_clear ? 220 : 130;
      if (dist < zone) s -= (zone - dist) * (cons.door_keep_clear ? 1.2 : 0.4);
    }
    let wantsWindow = false;
    for (const w of ops.filter(o => o.type === 'window')) {
      const dist = RF.distRectPoint(r, RF.openingGeom(room, w).mid);
      const near = cons[cat + '_near_window'] || (cat === 'desk' && cons.natural_light_priority === 'high');
      if (near) { s -= dist * 2.5; wantsWindow = true; }
      else if (cat === 'desk' && strat === 'workspace') s -= dist * 0.15;
      if (cons[cat + '_avoid_window'] && dist < 160) s -= (160 - dist) * 3;
      if (it.h > 120 && dist < 100) s -= (100 - dist) * 0.3;
    }
    const walls = ['W', 'E', 'N', 'S'].filter(k => ({ W: r.x0, E: room.width - r.x1, N: r.y0, S: room.length - r.y1 })[k] < 2).length;
    const others = placed.filter(p => !p.existing);
    const avgDist = others.length ? others.reduce((a, p) => a + RF.distRectRect(r, RF.rectOf(p)), 0) / others.length : 0;
    if (wantsWindow) { /* the user's light preference outranks tucking into a corner */ }
    else if (strat === 'floor' || strat === 'cheapest' || cons.openness === 'high') { s += walls >= 2 ? 30 : 0; s -= avgDist * 0.1; }
    else if (strat === 'storage') { s += walls >= 2 ? 15 : 0; s -= avgDist * 0.05; }
    else if (strat === 'balanced') { s += Math.min(avgDist, 150) * 0.05; }
    if (cat === 'tv_unit') {
      const sofa = placed.find(p => p.category === 'sofa');
      if (sofa && sofa.facing === RF.OPP[it.facing]) s += 80;
    }
    if (FLOATING.includes(cat) && walls === 0) s -= 20;
    return s;
  }

  function signature(items) { return items.map(i => `${i.productId}@${Math.round(i.x)},${Math.round(i.y)},${i.facing}`).sort().join('|'); }

  /** Place all slots after `base`. Returns {ok, items, validation} or {ok:false, failedSlot, reason}. */
  /** Keep the best states but spread them across walls/positions so one greedy choice can't starve later slots. */
  function diverse(next, n) {
    const buckets = {};
    for (const st of next) {
      const last = st.placed[st.placed.length - 1];
      const r = RF.rectOf(last);
      const k = `${last.facing}:${Math.round(r.x0 / 60)}:${Math.round(r.y0 / 60)}`;
      (buckets[k] = buckets[k] || []).push(st);
    }
    const lists = Object.values(buckets).sort((a, b) => b[0].score - a[0].score);
    const out = [];
    for (let round = 0; out.length < n && round < 50; round++) {
      for (const l of lists) { if (l[round]) out.push(l[round]); if (out.length >= n) break; }
    }
    return out;
  }

  function placeAll(room, slots, base, strat, ctx) {
    const first = placeBeam(room, slots, base, strat, ctx, BEAM);
    if (first.ok || first.reason === 'circulation' && slots.length < 2) return first;
    const wide = placeBeam(room, slots, base, strat, ctx, BEAM * 6);
    return wide.ok ? wide : first;
  }

  function placeBeam(room, slots, base, strat, ctx, beam) {
    const rules = RF.effectiveRules(ctx.rules, ctx.constraints);
    let states = [{ placed: base.slice(), score: 0 }];
    for (let i = 0; i < slots.length; i++) {
      const next = [], seen = new Set();
      for (const st of states) {
        for (const group of candidatesFor(room, slots[i], st.placed, rules)) {
          const items = st.placed.concat(group);
          const v = RF.validate(room, items, Object.assign({}, ctx, { skipCirculation: true, focus: new Set(group.map(g => g.uid)) }));
          if (!v.ok) continue;
          const sig = signature(items);
          if (seen.has(sig)) continue;
          seen.add(sig);
          next.push({ placed: items, score: st.score + score(room, group, st.placed, strat, ctx.constraints || {}) });
        }
      }
      if (!next.length) return { ok: false, failedSlot: i, reason: 'space' };
      next.sort((a, b) => b.score - a.score);
      states = i === slots.length - 1 ? next.slice(0, beam) : diverse(next, beam);
    }
    for (const st of states) {
      const v = RF.validate(room, st.placed, Object.assign({}, ctx, { computeMaxWidth: true }));
      if (v.ok || (v.violations.every(x => x.id === 'budget'))) return { ok: true, items: st.placed, validation: v };
    }
    const v = RF.validate(room, states[0].placed, ctx);
    return { ok: false, failedSlot: slots.length - 1, reason: 'circulation', validation: v };
  }

  function instanceFor(p) { return RF.instance(p); }

  function withProtos(slots, picks, chairPicks) {
    return slots.map((s, i) => Object.assign({}, s, { proto: instanceFor(picks[i]), companionProto: chairPicks[i] ? instanceFor(chairPicks[i]) : null }));
  }

  function total(items) { return items.filter(i => !i.existing).reduce((a, i) => a + i.price, 0); }

  /**
   * Generate one layout for a strategy.
   * ctx: { rules, constraints, budget }
   */
  RF.generateLayout = function (room, req, strat, ctx, base) {
    const cons = ctx.constraints || {};
    base = base || [];
    const slots = buildSlots(req);
    const notes = [];
    if (!slots.length) return { ok: false, strategy: strat, reason: 'Add at least one furniture item to plan a layout.' };

    const opts = slots.map(s => productOptions(s, strat, req, cons));
    const chairOpts = slots.map(s => s.companion ? productOptions(s.companion, strat === 'workspace' ? 'balanced' : strat, req, cons) : null);
    for (let i = 0; i < slots.length; i++) {
      if (!opts[i].length) {
        const why = slots[i].pinned ? 'the chosen product is unavailable' : cons[slots[i].category + '_max_width_cm'] ? `no ${RF.CATEGORY_LABELS[slots[i].category].toLowerCase()} in the catalog is ${cons[slots[i].category + '_max_width_cm']} cm wide or less` : cons.wall_mount_allowed === false ? 'every option needs wall mounting' : 'the catalog has none';
        return { ok: false, strategy: strat, reason: `No ${RF.CATEGORY_LABELS[slots[i].category] || slots[i].category} available: ${why}.` };
      }
    }
    const idx = slots.map(() => 0);
    let res = null, attempts = 0;
    while (attempts++ < 30) {
      const picks = idx.map((k, i) => opts[i][k]);
      const chairPicks = chairOpts.map(o => o ? o[0] : null);
      res = placeAll(room, withProtos(slots, picks, chairPicks), base, strat, ctx);
      if (res.ok) break;
      // try the next option for the slot that couldn't be placed (or the largest flexible item)
      let k = res.failedSlot;
      const flexible = i => idx[i] + 1 < opts[i].length;
      if (!flexible(k)) {
        const cand = slots.map((s, i) => i).filter(flexible).sort((a, b) => footprint(opts[b][idx[b]]) - footprint(opts[a][idx[a]]));
        if (!cand.length) break;
        k = cand[0];
      }
      const from = opts[k][idx[k]];
      idx[k]++;
      notes.push(`${from.name} (${from.width_cm} × ${from.depth_cm} cm) didn't fit with the rest — tried ${opts[k][idx[k]].name} instead.`);
    }
    if (!res || !res.ok) {
      const s = slots[res ? res.failedSlot : 0];
      const p = opts[res ? res.failedSlot : 0][0];
      return { ok: false, strategy: strat, reason: res && res.reason === 'circulation' ? 'Everything can be placed, but no arrangement leaves a walkway from the door to every item.' : `There is no valid spot for the ${(RF.CATEGORY_LABELS[s.category] || s.category).toLowerCase()}${s.pinned ? ` (${p.name}, ${p.width_cm} × ${p.depth_cm} cm)` : ''} once the other items are placed.`, validation: res && res.validation };
    }

    let items = res.items, validation = res.validation;

    // budget: pick cheaper options visibly, never silently
    if (ctx.budget && total(items) > ctx.budget && strat !== 'cheapest') {
      const tries = slots.map((s, i) => i).filter(i => !slots[i].pinned);
      for (let round = 0; round < 6 && total(items) > ctx.budget; round++) {
        let bestSwap = null;
        for (const i of tries) {
          const cur = opts[i][idx[i]];
          const cheaper = opts[i].map((p, k) => ({ p, k })).filter(o => o.p.price_inr < cur.price_inr).sort((a, b) => a.p.price_inr - b.p.price_inr)[0];
          if (cheaper && (!bestSwap || cur.price_inr - cheaper.p.price_inr > bestSwap.save)) bestSwap = { i, k: cheaper.k, save: cur.price_inr - cheaper.p.price_inr, from: cur, to: cheaper.p };
        }
        if (!bestSwap) break;
        const idx2 = idx.slice(); idx2[bestSwap.i] = bestSwap.k;
        const r2 = placeAll(room, withProtos(slots, idx2.map((k, i) => opts[i][k]), chairOpts.map(o => o ? o[0] : null)), base, strat, ctx);
        tries.splice(tries.indexOf(bestSwap.i), 1);
        if (r2.ok) {
          idx[bestSwap.i] = bestSwap.k; items = r2.items; validation = r2.validation;
          notes.push(`Chose ${bestSwap.to.name} (₹${RF.fmt(bestSwap.to.price_inr)}) over ${bestSwap.from.name} (₹${RF.fmt(bestSwap.from.price_inr)}) to stay within budget.`);
        }
      }
    }

    // storage extras
    const extraCount = strat === 'storage' ? (cons.storage_priority === 'low' ? 0 : 2) : (cons.storage_priority === 'high' && strat !== 'floor' ? 1 : 0);
    if (extraCount) {
      const pool = RF.catalog.list().filter(p => ['bookshelf', 'storage'].includes(p.category) && !(cons.wall_mount_allowed === false && p.requires_wall_mount)).sort((a, b) => volume(b) - volume(a));
      let added = 0;
      for (const p of pool) {
        if (added >= extraCount) break;
        if (ctx.budget && total(items) + p.price_inr > ctx.budget) continue;
        const r2 = placeAll(room, [{ category: p.category, proto: RF.instance(p) }], items, strat, ctx);
        if (r2.ok) { items = r2.items; validation = r2.validation; added++; notes.push(`Added ${p.name} for extra storage.`); }
      }
    }

    validation = RF.validate(room, items, Object.assign({}, ctx, { computeMaxWidth: true }));
    return { ok: true, strategy: strat, items, validation, notes, metrics: RF.metrics(room, items, validation) };
  };

  RF.generateLayouts = function (room, req, ctx, opts) {
    opts = opts || {};
    const base = (opts.base || []).map(i => Object.assign({}, i));
    const strats = RF.STRATEGIES.slice();
    if (opts.cheapest) strats.push(RF.CHEAPEST);
    const out = [], sigs = {};
    for (const s of strats) {
      const L = RF.generateLayout(room, req, s.id, ctx, base);
      L.id = s.id; L.letter = s.letter; L.title = s.title;
      if (L.ok) {
        const sig = signature(L.items);
        if (sigs[sig]) L.sameAs = sigs[sig];
        else sigs[sig] = s.letter;
      }
      out.push(L);
    }
    return out;
  };

  /* ---------- metrics (measurable, no overall score) ---------- */

  const STORAGE_STARS = [0.4, 0.9, 1.5, 2.2];   // m³ of storage volume
  const WORK_STARS = [70, 100, 130, 160];       // cm of desk width
  RF.STAR_THRESHOLDS = { storage: STORAGE_STARS, workspace: WORK_STARS };
  const stars = (v, t) => v <= 0 ? 0 : 1 + t.filter(x => v >= x).length;

  RF.metrics = function (room, items, v) {
    const area = room.width * room.length;
    const used = items.filter(i => i.elev < 100).reduce((a, i) => a + i.w * i.d, 0) + (room.obstacles || []).reduce((a, o) => a + o.w * o.d, 0);
    const storageM3 = items.filter(i => RF.STORAGE_CATEGORIES.includes(i.category)).reduce((a, i) => a + i.w * i.d * i.h / 1e6, 0);
    const deskCm = items.filter(i => i.category === 'desk').reduce((a, i) => a + i.w, 0);
    return {
      floorFreePct: Math.round((1 - used / area) * 100),
      storageM3: Math.round(storageM3 * 100) / 100, storageStars: stars(storageM3, STORAGE_STARS),
      deskCm, workspaceStars: stars(deskCm, WORK_STARS),
      walkwayCm: v && v.circulation ? v.circulation.maxWidth : null,
      total: total(items), violations: v ? v.violations.length : null
    };
  };

  /* ---------- facts for explanations ---------- */

  RF.layoutFacts = function (room, items, v, ctx) {
    const cons = (ctx && ctx.constraints) || {};
    const rules = RF.effectiveRules(ctx && ctx.rules, cons);
    const win = (room.openings || []).filter(o => o.type === 'window');
    const doors = (room.openings || []).filter(o => o.type === 'door');
    const facts = { room: { width: room.width, length: room.length }, walkWidth: rules.walkWidthCm, items: [], constraints: cons, budget: v.budget, maxWalkway: v.circulation && v.circulation.maxWidth };
    for (const it of items) {
      const r = RF.rectOf(it), wall = RF.wallOf(room, it);
      const f = { name: it.name, category: it.category, w: it.w, d: it.d, h: it.h, price: it.price, wall: wall ? RF.WALL_NAME[wall] : null, existing: it.existing };
      if (win.length) f.windowCm = Math.round(Math.min(...win.map(w => RF.distRectPoint(r, RF.openingGeom(room, w).mid))));
      if (doors.length) f.doorCm = Math.round(Math.min(...doors.map(d => RF.distRectPoint(r, RF.openingGeom(room, d).mid))));
      const rec = v.items[it.uid];
      f.checks = rec ? rec.checks.filter(c => c.required != null).map(c => ({ label: c.label, required: c.required, available: c.available, unit: c.unit, status: c.status })) : [];
      if (it.pairedWith) f.pairedWith = (items.find(x => x.uid === it.pairedWith) || {}).name;
      facts.items.push(f);
    }
    return facts;
  };

  /** Deterministic explanation built only from computed facts. */
  RF.explainFromFacts = function (facts, layout) {
    const lines = [];
    const cons = facts.constraints || {};
    if (layout) lines.push(`Layout ${layout.letter} (${layout.title.toLowerCase()}) uses ${facts.items.filter(i => !i.existing).length} items in a ${facts.room.width} × ${facts.room.length} cm room.`);
    for (const f of facts.items) {
      if (f.category === 'chair' && f.pairedWith) continue;
      const bits = [];
      if (f.wall) bits.push(`against the ${f.wall} wall`);
      if (f.category === 'desk' && f.windowCm != null && (cons.desk_near_window || cons.natural_light_priority === 'high')) bits.push(`${f.windowCm} cm from the window because you asked for natural light`);
      else if (f.category === 'bed' && cons.bed_avoid_window && f.windowCm != null) bits.push(`${f.windowCm} cm from the window, which you asked to keep away from`);
      const c = f.checks.find(x => x.label === 'Front clearance');
      if (c) bits.push(`its front needs ${c.required} cm and has ${c.available >= 300 ? '300+' : c.available} cm`);
      const sd = f.checks.find(x => x.label === 'Bed access');
      if (sd) bits.push(`bed access needs ${sd.required} cm at the side and has ${sd.available} cm`);
      if (f.doorCm != null && f.doorCm < 150 && cons.door_keep_clear) bits.push(`kept ${f.doorCm} cm from the door`);
      lines.push(`${f.name} (${f.w} × ${f.d} cm) sits ${bits.join('; ') || 'where it passes every check'}.`);
    }
    lines.push(facts.maxWalkway ? `The widest clear path from the door to every item is ${facts.maxWalkway} cm (minimum required: ${facts.walkWidth} cm).` : `Walking paths need at least ${facts.walkWidth} cm.`);
    if (facts.budget && facts.budget.budget) {
      lines.push(facts.budget.over > 0
        ? `It works spatially but costs ₹${RF.fmt(facts.budget.total)}, ₹${RF.fmt(facts.budget.over)} over your ₹${RF.fmt(facts.budget.budget)} budget.`
        : `It costs ₹${RF.fmt(facts.budget.total)} of your ₹${RF.fmt(facts.budget.budget)} budget, leaving ₹${RF.fmt(facts.budget.remaining)}.`);
    }
    return lines;
  };

  RF.fmt = n => Math.round(n).toLocaleString('en-IN');

  /** Cheaper alternatives for an over-budget arrangement — each one re-validated in place. */
  RF.budgetAlternatives = function (room, items, ctx) {
    const out = [];
    items.forEach((it, i) => {
      if (it.existing || it.locked) return;
      RF.catalog.list().filter(p => p.category === it.category && p.price_inr < it.price).forEach(p => {
        if (ctx.constraints && ctx.constraints.wall_mount_allowed === false && p.requires_wall_mount) return;
        const t = items.slice();
        t[i] = Object.assign({}, it, { productId: p.id, name: p.name, w: p.width_cm, d: p.depth_cm, h: p.height_cm, price: p.price_inr, front: p.clearance_front_cm, side: p.clearance_side_cm, door: p.door_clearance_cm, drawer: p.drawer_clearance_cm, back: p.clearance_back_cm, wallMount: p.requires_wall_mount, elev: p.elevation_cm });
        const v = RF.validate(room, t, ctx);
        if (v.ok) out.push({ uid: it.uid, from: it, to: p, save: it.price - p.price_inr });
      });
    });
    return out.sort((a, b) => b.save - a.save).slice(0, 4);
  };
})(window.RF = window.RF || {});
