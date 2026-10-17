/* ROOMFIT application controller: state, routing, and UI wiring. Geometry decisions are delegated to RF.validate. */
(function (RF) {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = RF.esc;
  const fmt = RF.fmt;
  const clone = o => JSON.parse(JSON.stringify(o));
  const FACING_CW = { S: 'W', W: 'N', N: 'E', E: 'S' };

  /* ================= state ================= */

  function sampleRoom() {
    return {
      width: 320, length: 410, height: 280, type: 'study',
      provenance: { width: 'verified', length: 'verified', height: 'verified' },
      openings: [
        { id: 'd1', type: 'door', label: 'the door', wall: 'S', offset: 20, width: 90, hinge: 'start', swing: 'in', height: 210 },
        { id: 'w1', type: 'window', label: 'the window', wall: 'N', offset: 85, width: 150, sill: 90, height: 120 }
      ],
      obstacles: [], existing: [],
      // delivery-path model: room → door → corridor → lift → building entry
      connections: [{ opening: 'd1', to: { kind: 'corridor', id: null } }]
    };
  }

  const ROOM_PRESETS = {
    study: {
      width: 280, length: 340, height: 280, type: 'study',
      provenance: { width: 'verified', length: 'verified', height: 'verified' },
      openings: [
        { id: 'd1', type: 'door', label: 'the door', wall: 'S', offset: 25, width: 85, hinge: 'start', swing: 'in', height: 210 },
        { id: 'w1', type: 'window', label: 'the window', wall: 'N', offset: 70, width: 140, sill: 90, height: 120 }
      ],
      obstacles: [], existing: [], connections: [{ opening: 'd1', to: { kind: 'corridor', id: null } }]
    },
    studio: {
      width: 320, length: 420, height: 280, type: 'bedroom',
      provenance: { width: 'verified', length: 'verified', height: 'verified' },
      openings: [
        { id: 'd1', type: 'door', label: 'the door', wall: 'S', offset: 20, width: 90, hinge: 'start', swing: 'in', height: 210 },
        { id: 'w1', type: 'window', label: 'the window', wall: 'N', offset: 85, width: 150, sill: 90, height: 120 }
      ],
      obstacles: [], existing: [], connections: [{ opening: 'd1', to: { kind: 'corridor', id: null } }]
    },
    bedroom: {
      width: 380, length: 480, height: 290, type: 'bedroom',
      provenance: { width: 'verified', length: 'verified', height: 'verified' },
      openings: [
        { id: 'd1', type: 'door', label: 'the door', wall: 'S', offset: 30, width: 90, hinge: 'start', swing: 'in', height: 210 },
        { id: 'w1', type: 'window', label: 'the window', wall: 'E', offset: 100, width: 180, sill: 85, height: 130 }
      ],
      obstacles: [], existing: [], connections: [{ opening: 'd1', to: { kind: 'corridor', id: null } }]
    },
    living: {
      width: 420, length: 520, height: 300, type: 'living',
      provenance: { width: 'verified', length: 'verified', height: 'verified' },
      openings: [
        { id: 'd1', type: 'door', label: 'the door', wall: 'W', offset: 30, width: 95, hinge: 'start', swing: 'in', height: 210 },
        { id: 'w1', type: 'window', label: 'the window', wall: 'N', offset: 80, width: 240, sill: 65, height: 160 }
      ],
      obstacles: [], existing: [], connections: [{ opening: 'd1', to: { kind: 'corridor', id: null } }]
    }
  };

  const state = {
    room: sampleRoom(), req: { required: [], style: [], people: null, purpose: null },
    constraints: {}, rules: {}, budget: null,
    layouts: [], active: null, items: [], edited: false, selected: null,
    validation: null, log: [], understood: [], understoodSrc: '', zones: 'selected',
    pendingFit: null, swap: null, why: null, fit: null
  };
  let photos = [];
  let view3d = null, roomSig = '';

  const ctx = extra => Object.assign({ rules: state.rules, constraints: state.constraints, budget: state.budget }, extra || {});

  function save() {
    clearTimeout(save.t);
    save.t = setTimeout(() => {
      try {
        localStorage.setItem('rf.project', JSON.stringify({ v: 1, room: state.room, req: state.req, constraints: state.constraints, rules: state.rules, budget: state.budget, items: state.items, active: state.active, edited: state.edited }));
      } catch (e) { /* storage unavailable: app keeps working in memory */ }
    }, 300);
  }
  function load() {
    try { const j = JSON.parse(localStorage.getItem('rf.project') || 'null'); return j && j.v === 1 ? j : null; } catch (e) { return null; }
  }

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('is-on');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('is-on'), 2600);
  }

  function existingItems() {
    return (state.room.existing || []).map(e => {
      const typical = RF.catalog.list().find(p => p.category === e.category) || {};
      return {
        uid: e.uid, productId: 'existing', name: e.name || 'Existing furniture', category: e.category || 'other',
        w: +e.w, d: +e.d, h: +e.h || 80, elev: 0, price: 0, facing: e.facing || 'S', x: +e.x, y: +e.y,
        front: typical.clearance_front_cm || 0, side: typical.clearance_side_cm || 0, door: typical.door_clearance_cm || 0, drawer: typical.drawer_clearance_cm || 0, back: 0,
        wallMount: false, style: [], tags: [], pairedWith: null, existing: true, locked: true, sample: false, estimated: !!e.estimated
      };
    });
  }

  function productFields(p) {
    return { productId: p.id, name: p.name, category: p.category, w: p.width_cm, d: p.depth_cm, h: p.height_cm, elev: p.elevation_cm || 0, price: p.price_inr,
      front: p.clearance_front_cm, side: p.clearance_side_cm, door: p.door_clearance_cm, drawer: p.drawer_clearance_cm, back: p.clearance_back_cm,
      wallMount: p.requires_wall_mount, tags: p.tags, style: p.style };
  }

  /* ================= routing ================= */

  function route() {
    const h = location.hash || '#/';
    const [path, query] = h.slice(1).split('?');
    let ask = null, check = null;
    if (query) {
      const qs = new URLSearchParams(query);
      const p = qs.get('p');
      if (p) openShared(p);
      ask = qs.get('ask');
      check = qs.get('check');
      history.replaceState(null, '', '#' + path);
    }
    const name = { '/': 'landing', '/setup': 'setup', '/design': 'design', '/fit': 'fit', '/delivery': 'delivery' }[path] || 'landing';
    $$('.view').forEach(v => { v.hidden = v.dataset.view !== name; });
    $$('[data-nav]').forEach(a => a.classList.toggle('is-on', a.dataset.nav === name));
    document.body.dataset.view = name;
    if (name === 'landing') renderHero();
    if (name === 'setup') renderSetup();
    if (name === 'design') enterDesign();
    if (name === 'fit') renderFitForm();
    if (name === 'delivery') renderDelivery();
    window.scrollTo(0, 0);
    // deep link: #/fit?check=<productId> or WxDxH (cm)
    if (check && name === 'fit') {
      const m = check.match(/^(\d+)x(\d+)x(\d+)$/);
      if (m) { $('#fitW').value = m[1]; $('#fitD').value = m[2]; $('#fitH').value = m[3]; $('#fitMode [data-v="dims"]').click(); }
      else if (RF.catalog.get(check)) { const p = RF.catalog.get(check); $('#fitCat').value = p.category; fillFitProducts(); $('#fitProduct').value = p.id; }
      runFit();
    }
    // deep link: #/design?ask=... runs a request (several separated by "|" run in order)
    if (ask && name === 'design') {
      $('#reqText').value = ask.split('|')[0];
      ask.split('|').reduce((pr, t, i) => pr.then(() => handleText(t, i === 0 ? 'ask' : 'cmd')), Promise.resolve());
    }
  }

  /* ================= landing hero ================= */

  const hero = { room: sampleRoom(), items: null, plan: null, selected: null };
  function heroItems() {
    const P = id => RF.catalog.get(id);
    const desk = RF.instance(P('desk_002'), { x: 160, y: 30, facing: 'S' });
    const chair = RF.instance(P('chair_001'), { facing: 'N', pairedWith: desk.uid });
    Object.assign(chair, RF.companionFor(desk, chair, RF.effectiveRules()), { uid: chair.uid });
    const bed = RF.instance(P('bed_single_001'), { x: 100, y: 210, facing: 'E' });
    const ward = RF.instance(P('ward_003'), { x: 292.5, y: 300, facing: 'W' });
    return [desk, chair, bed, ward];
  }
  function renderHero() {
    if (!hero.items) { hero.items = heroItems(); hero.selected = hero.items[3].uid; }
    if (!hero.plan) {
      hero.plan = RF.Plan2D($('#heroPlan'), {
        interactive: true,
        onSelect: uid => { if (uid) hero.selected = uid; drawHero(); },
        onDrag: (uid, x, y) => { moveItem(hero.items, uid, x, y); drawHero(); },
        onDrop: () => drawHero(true)
      });
      keyNudge($('#heroPlan'), () => hero.items, () => hero.selected, () => drawHero(true));
    }
    drawHero(true);
    measureTitle();
  }
  function drawHero(withFix) {
    const v = RF.validate(hero.room, hero.items, {});
    hero.plan.set({ room: hero.room, items: hero.items, validation: v, selected: hero.selected, zones: 'selected' });
    const it = hero.items.find(i => i.uid === hero.selected);
    if (!it) return;
    const rec = v.items[it.uid];
    const fails = v.violations.filter(x => x.uid === it.uid);
    const others = v.violations.filter(x => x.uid !== it.uid);
    const front = rec.checks.find(c => c.id === 'front' || c.id === 'side' || c.id === 'back');
    const door = rec.checks.find(c => c.id === 'door');
    const ok = !fails.length && !others.length;
    let fix = '';
    if (!ok && withFix) { const s = RF.suggestFix(hero.room, hero.items, fails.length ? it.uid : others[0].uid, {}); if (s) fix = `<p class="note">${esc(s.text)}</p>`; }
    $('#heroVerdict').innerHTML = `
      <div class="verdict-head"><span class="verdict-word ${ok ? 'ok' : 'bad'}">${ok ? '✓ Fits' : '✕ Does not fit'}</span><span class="verdict-name">${esc(it.name)} <span class="num">${it.w} × ${it.d} × ${it.h} cm</span></span></div>
      ${ok ? `<ul class="checks">${front ? `<li class="is-pass"><span class="ic">✓</span><span>${esc(front.label)} <span class="req-avail">needs <b>${front.required} cm</b> has <b>${front.available >= 300 ? '300+' : front.available} cm</b></span></span></li>` : ''}
        ${door ? `<li class="is-pass"><span class="ic">✓</span><span>Door opens fully</span></li>` : ''}</ul>`
        : `<ul class="checks">${fails.concat(others).slice(0, 2).map(f => `<li class="is-fail"><span class="ic">✕</span><span>${f.uid !== it.uid ? esc(f.name) + ': ' : ''}${esc(f.detail)}</span></li>`).join('')}</ul>${fix}`}`;
  }
  function measureTitle() {
    const h = $('#heroTitle'), m = $('#heroMeasure');
    if (!h || !m) return;
    const range = document.createRange(); range.selectNodeContents(h);
    const rects = Array.from(range.getClientRects());
    const box = h.getBoundingClientRect();
    const right = Math.max(...rects.map(r => r.right));
    m.style.setProperty('--mr', Math.max(0, box.right - right) + 'px');
  }

  /* shared drag helpers */
  function moveItem(items, uid, x, y) {
    const it = items.find(i => i.uid === uid);
    if (!it) return;
    const dx = x - it.x, dy = y - it.y;
    it.x = x; it.y = y;
    items.filter(i => i.pairedWith === uid).forEach(c => { c.x += dx; c.y += dy; });
  }
  function rotateItem(items, uid) {
    const it = items.find(i => i.uid === uid);
    if (!it) return;
    it.facing = FACING_CW[it.facing];
    items.filter(i => i.pairedWith === uid).forEach(c => {
      const pos = RF.companionFor(it, c, RF.effectiveRules(state.rules, state.constraints));
      c.x = pos.x; c.y = pos.y; c.facing = pos.facing;
    });
  }
  function keyNudge(el, getItems, getSel, after) {
    el.addEventListener('keydown', ev => {
      const uid = getSel(); if (!uid) return;
      const step = ev.shiftKey ? 10 : 1;
      const it = getItems().find(i => i.uid === uid); if (!it || it.locked) return;
      const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
      if (k) { moveItem(getItems(), uid, it.x + k[0], it.y + k[1]); after(); ev.preventDefault(); }
      else if (ev.key === 'r' || ev.key === 'R') { rotateItem(getItems(), uid); after(); ev.preventDefault(); }
    });
  }

  /* ================= setup ================= */

  let setupPlan = null;
  function provSet(key, v) { state.room.provenance = state.room.provenance || {}; state.room.provenance[key] = v; }
  function renderSetup() {
    const r = state.room;
    $('#dimW').value = r.width || ''; $('#dimL').value = r.length || ''; $('#dimH').value = r.height || '';
    $('#roomType').value = r.type || 'other';
    renderOpenings(); renderObstacles(); renderExisting(); renderProv(); renderPhotos();
    if (!setupPlan) setupPlan = RF.Plan2D($('#setupPlan'), {});
    drawSetupPlan();
  }
  function renderProv() {
    const pv = state.room.provenance || {};
    $$('[data-prov]').forEach(el => {
      const k = el.dataset.prov, v = state.room[k] ? (pv[k] || 'verified') : 'unknown';
      el.className = 'prov is-' + v;
      el.textContent = { verified: 'Verified (you measured)', estimated: 'Estimated from photo', unknown: 'Unknown' }[v];
    });
    const est = ['width', 'length', 'height'].filter(k => pv[k] === 'estimated');
    $('#knownBox').hidden = !est.length && !(state.room.openings || []).some(o => o.estimated);
    $('#estWarn').textContent = est.length ? `⚠ Room ${est.join(' and ')} ${est.length > 1 ? 'are' : 'is'} estimated from a photo. Add one measurement you've taken with a tape for accurate fit checking.` : 'Some openings are estimated from a photo. Add one measurement to rescale them.';
    const ok = state.room.width >= 100 && state.room.length >= 100;
    $('#btnToDesign').classList.toggle('is-disabled', !ok);
    $('#btnToDesign').setAttribute('aria-disabled', String(!ok));
  }
  function drawSetupPlan() {
    const r = state.room;
    if (!(r.width >= 100 && r.length >= 100)) { $('#setupPlan').innerHTML = ''; $('#setupSummary').textContent = 'Add the width and length to see your room.'; return; }
    const items = existingItems();
    const v = RF.validate(r, items, ctx());
    setupPlan.set({ room: r, items, validation: v, zones: 'all' });
    const doors = r.openings.filter(o => o.type === 'door').length, wins = r.openings.filter(o => o.type === 'window').length;
    $('#setupSummary').textContent = `${r.width} × ${r.length} cm · ${(r.width * r.length / 10000).toFixed(1)} m² · ${doors} door${doors === 1 ? '' : 's'}, ${wins} window${wins === 1 ? '' : 's'}`;
  }
  function roomChanged() {
    renderProv(); drawSetupPlan();
    state.layouts = []; state.validation = null;
    // keep the current design but re-check it against the new room
    save();
  }

  const WALLS = [['N', 'North'], ['E', 'East'], ['S', 'South'], ['W', 'West']];
  const opt = (pairs, v) => pairs.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`).join('');
  function numField(label, key, val, unit) {
    return `<label class="field"><span>${label}</span><span class="inp"><input type="number" data-k="${key}" value="${val == null ? '' : val}">${unit ? `<em>${unit}</em>` : ''}</span></label>`;
  }
  function renderOpenings() {
    $('#openingsList').innerHTML = state.room.openings.map((o, i) => `
      <div class="op-row" data-i="${i}">
        <label class="field"><span>${o.type === 'door' ? 'Door' : 'Window'}${o.estimated ? ' (est.)' : ''}</span><select data-k="wall" aria-label="Wall">${opt(WALLS, o.wall)}</select></label>
        ${o.type === 'door'
          ? `<label class="field"><span>Opens</span><select data-k="swing">${opt([['in', 'Inward'], ['out', 'Outward'], ['slide', 'Slides']], o.swing)}</select></label>`
          : `<label class="field"><span>Sill</span><span class="inp"><input type="number" data-k="sill" value="${o.sill}"><em>cm</em></span></label>`}
        ${numField('Offset', 'offset', o.offset, 'cm')}
        ${numField('Width', 'width', o.width, 'cm')}
        ${o.type === 'door' ? `<label class="field"><span>Hinge</span><select data-k="hinge">${opt([['start', o.wall === 'N' || o.wall === 'S' ? 'West' : 'North'], ['end', o.wall === 'N' || o.wall === 'S' ? 'East' : 'South']], o.hinge)}</select></label>` : `<label class="field"><span>Height</span><span class="inp"><input type="number" data-k="height" value="${o.height}"><em>cm</em></span></label>`}
        <button type="button" class="icon-btn" data-remove aria-label="Remove ${o.type}">×</button>
      </div>`).join('') || '<p class="note">No doors yet. Add one so ROOMFIT can check door swings and walking paths.</p>';
  }
  function renderObstacles() {
    $('#obstaclesList').innerHTML = (state.room.obstacles || []).map((o, i) => `
      <div class="op-row" data-i="${i}">
        <label class="field"><span>Fixed object</span><input data-k="label" value="${esc(o.label)}"></label>
        ${numField('X', 'x', o.x, '')}${numField('Y', 'y', o.y, '')}${numField('W', 'w', o.w, '')}${numField('D', 'd', o.d, '')}
        <button type="button" class="icon-btn" data-remove aria-label="Remove fixed object">×</button>
      </div>`).join('');
  }
  function renderExisting() {
    const cats = Object.entries(RF.CATEGORY_LABELS);
    $('#existingList').innerHTML = (state.room.existing || []).map((o, i) => `
      <div class="op-row" data-i="${i}">
        <label class="field"><span>Keeping${o.estimated ? ' (est.)' : ''}</span><select data-k="category">${opt(cats, o.category)}</select></label>
        ${numField('W', 'w', o.w, '')}${numField('D', 'd', o.d, '')}${numField('X', 'x', o.x, '')}${numField('Y', 'y', o.y, '')}
        <button type="button" class="icon-btn" data-remove aria-label="Remove">×</button>
      </div>`).join('');
  }
  function bindRows(listSel, getArr, rerender) {
    const el = $(listSel);
    el.addEventListener('input', ev => {
      const row = ev.target.closest('[data-i]'), k = ev.target.dataset.k; if (!row || !k) return;
      const o = getArr()[+row.dataset.i];
      o[k] = ev.target.type === 'number' ? (ev.target.value === '' ? null : +ev.target.value) : ev.target.value;
      if (k === 'category') o.name = RF.CATEGORY_LABELS[o.category] + ' (existing)';
      o.estimated = false;
      if (k === 'wall' || k === 'category') rerender();
      roomChanged();
    });
    el.addEventListener('click', ev => {
      if (!ev.target.closest('[data-remove]')) return;
      const row = ev.target.closest('[data-i]');
      getArr().splice(+row.dataset.i, 1);
      rerender(); roomChanged();
    });
  }

  function renderPhotos() {
    $('#photoThumbs').innerHTML = photos.map(p => `<img src="${p.url}" alt="Room photo">`).join('');
    $('#btnClearPhotos').hidden = !photos.length;
    const proxy = !!RF.ai.proxyUrl();
    $('#btnAnalyze').disabled = !photos.length || !proxy;
    $('#analyzeNote').textContent = !photos.length ? '' : proxy ? 'Photos are sent to Gemini through your proxy for this analysis only. Nothing is stored.' : 'Photo analysis needs the Gemini proxy (Settings). You can still enter measurements by hand.';
  }

  async function analyzePhotos() {
    const btn = $('#btnAnalyze'); btn.disabled = true; btn.textContent = 'Analysing…';
    try {
      const pv = state.room.provenance || {};
      const hints = { width: pv.width === 'verified' ? state.room.width : null, length: pv.length === 'verified' ? state.room.length : null };
      const a = await RF.ai.run('analyzeRoom', photos.map(p => ({ mime: p.mime, data: p.data })), hints);
      const r = state.room;
      for (const k of ['width', 'length', 'height']) {
        if (a[k] && pv[k] !== 'verified') { r[k] = a[k]; provSet(k, 'estimated'); }
        else if (!r[k]) provSet(k, 'unknown');
      }
      if (a.openings.length) r.openings = a.openings.map(o => Object.assign(o, { estimated: true }));
      r.existing = (r.existing || []).concat(a.existing.map(f => {
        const cat = Object.keys(RF.CATEGORY_LABELS).find(c => f.type.toLowerCase().includes(c.replace('_', ' '))) || 'other';
        return { uid: RF.uid(), name: (RF.CATEGORY_LABELS[cat] || f.type) + ' (existing)', category: cat, w: f.w, d: f.d, h: f.h, x: f.x != null ? f.x : f.w / 2, y: f.y != null ? f.y : f.d / 2, facing: 'S', estimated: true };
      }));
      if (a.roomType) r.type = ['bedroom', 'study', 'living'].find(t => a.roomType.toLowerCase().includes(t)) || r.type;
      renderSetup();
      $('#analyzeNote').textContent = `Gemini found ${a.openings.filter(o => o.type === 'door').length} door(s), ${a.openings.filter(o => o.type === 'window').length} window(s) and ${a.existing.length} piece(s) of furniture. Confidence: ${a.confidence}. These are estimates. Check them and add one measurement.${a.notes ? ' ' + a.notes : ''}`;
      roomChanged();
    } catch (e) {
      $('#analyzeNote').textContent = e.message;
    } finally { btn.textContent = 'Analyse photos'; renderPhotos(); }
  }

  function rescale() {
    const what = $('#knownWhat').value, val = +$('#knownVal').value;
    if (!(val > 0)) { toast('Enter the measurement in cm first.'); return; }
    const r = state.room, pv = r.provenance || {};
    let cur;
    if (what === 'width' || what === 'length') cur = r[what];
    else { const o = r.openings.find(x => x.type === what); cur = o && o.width; }
    if (!cur) { toast(`There's no ${what} to compare against.`); return; }
    const f = val / cur;
    for (const k of ['width', 'length', 'height']) if (pv[k] === 'estimated') r[k] = Math.round(r[k] * f);
    if (what === 'width' || what === 'length') { r[what] = val; provSet(what, 'verified'); }
    r.openings.forEach(o => { if (o.estimated) { o.offset = Math.round(o.offset * f); o.width = Math.round(o.width * f); } });
    if (what === 'door' || what === 'window') { const o = r.openings.find(x => x.type === what); o.width = val; }
    (r.existing || []).forEach(e => { if (e.estimated) { ['w', 'd', 'x', 'y'].forEach(k => e[k] = Math.round(e[k] * f)); } });
    renderSetup(); roomChanged();
    toast(`Rescaled estimates by ${f.toFixed(2)}×. Values you measured weren't changed.`);
  }

  /* ================= design ================= */

  function enterDesign() {
    if (!view3d) {
      view3d = RF.View3D($('#stage3d'), {
        onSelect: uid => select(uid),
        onDrag: (uid, x, y) => { moveItem(state.items, uid, x, y); markEdited(); revalidate(false); },
        onDrop: () => { revalidate(true); save(); }
      });
    }
    const sig = JSON.stringify(state.room);
    if (sig !== roomSig) {
      roomSig = sig;
      if (view3d) view3d.setRoom(state.room);
      if (state.req.required.length && !state.layouts.length) planNow({ keepItems: state.edited });
      else if (!state.items.length) state.items = existingItems();
    }
    renderPanel();
    renderChat();
    revalidate(true);
  }

  function markEdited() { if (!state.edited && state.active) state.edited = true; }

  let rafPending = false;
  function revalidate(full) {
    state.validation = RF.validate(state.room, state.items, ctx({ computeMaxWidth: full }));
    if (full) state.fixFor = null;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderStage(); renderDock(); });
  }

  function select(uid) {
    state.selected = uid; state.swap = null; state.pendingFit = null;
    renderStage(); renderDock();
  }

  function renderStage() {
    if (view3d) {
      view3d.setItems(state.items, state.validation, state.selected, RF.effectiveRules(state.rules, state.constraints));
      view3d.setZones(state.zones === 'none' ? 'off' : state.zones);
    }
    $('#stageEmpty').hidden = state.items.some(i => !i.existing);
    renderTabs();
  }

  function renderTabs() {
    $('#layoutTabs').innerHTML = state.layouts.map(L => {
      const on = L.id === state.active;
      const sub = L.ok ? `₹${fmt(L.metrics.total)} · ${L.metrics.floorFreePct}% floor free${L.sameAs ? ` · same as ${L.sameAs}` : ''}` : 'No valid layout';
      return `<button type="button" role="tab" aria-selected="${on}" class="ltab ${on ? 'is-on' : ''} ${L.ok ? '' : 'is-failed'}" data-layout="${L.id}">
        <span class="ltab-letter">${L.letter}</span><strong>${esc(L.title)}${on && state.edited ? ' (edited)' : ''}</strong><small>${esc(sub)}</small></button>`;
    }).join('');
  }

  function activate(id) {
    const L = state.layouts.find(l => l.id === id);
    if (!L) return;
    state.active = id;
    state.why = null;
    if (L.ok) { state.items = clone(L.items); state.edited = false; }
    state.selected = null; state.swap = null; state.pendingFit = null;
    revalidate(true); save();
  }

  function planNow(opts) {
    opts = opts || {};
    const base = existingItems();
    const wantCheap = opts.cheapest || state.layouts.some(l => l.id === 'cheapest');
    const t0 = performance.now();
    state.layouts = RF.generateLayouts(state.room, state.req, ctx(), { base, cheapest: wantCheap });
    state.planMs = Math.round(performance.now() - t0);
    const pref = opts.prefer || state.active;
    const L = state.layouts.find(l => l.id === pref && l.ok) || state.layouts.find(l => l.ok);
    if (opts.keepItems && state.items.length) { /* restored edited design */ }
    else if (L) { state.active = L.id; state.items = clone(L.items); state.edited = false; }
    else { state.active = pref || null; state.items = base; }
    state.selected = null; state.why = null; state.swap = null;
    revalidate(true); renderPanel(); save();
    return L;
  }
  let planTimer = null;
  function schedulePlan() {
    clearTimeout(planTimer);
    planTimer = setTimeout(() => { if (state.req.required.length) planNow(); else { state.layouts = []; state.items = existingItems(); state.active = null; revalidate(true); renderPanel(); save(); } }, 250);
  }

  /* ---------- panel ---------- */

  const STYLE_OPTIONS = ['minimal', 'modern', 'classic', 'industrial'];
  function renderPanel() {
    // AI badge
    $('#aiBadge').textContent = RF.ai.proxyUrl() ? 'Using Gemini for language' : 'Built-in parser, no AI key needed';
    // understood
    $('#understood').innerHTML = state.understood.map(u => `<li>${esc(u)}</li>`).join('') + (state.understoodSrc ? `<li class="is-src">via ${esc(state.understoodSrc)}</li>` : '');
    // furniture requirements
    const cats = Object.keys(RF.CATEGORY_LABELS).filter(c => c !== 'other');
    $('#reqList').innerHTML = state.req.required.map((r, i) => {
      const prods = RF.catalog.list().filter(p => p.category === r.category);
      return `<div class="req-row" data-i="${i}">
        <span class="req-name">${esc(RF.CATEGORY_LABELS[r.category])}${r.hint ? ` <small class="note">(${esc(r.hint)})</small>` : ''}
          <select data-k="pinnedId" aria-label="Product for ${esc(RF.CATEGORY_LABELS[r.category])}"><option value="">Let ROOMFIT choose</option>${prods.map(p => `<option value="${p.id}"${p.id === r.pinnedId ? ' selected' : ''}>${esc(p.name)}: ${p.width_cm}×${p.depth_cm}</option>`).join('')}</select></span>
        <input type="number" min="1" max="6" data-k="qty" value="${r.qty || 1}" aria-label="Quantity">
        <button type="button" class="icon-btn" data-remove aria-label="Remove ${esc(RF.CATEGORY_LABELS[r.category])}">×</button></div>`;
    }).join('') || '<p class="note">Nothing yet. Describe the room above or add furniture types.</p>';
    $('#reqAddCat').innerHTML = cats.map(c => `<option value="${c}">${RF.CATEGORY_LABELS[c]}</option>`).join('');
    // budget
    if (document.activeElement !== $('#budget')) $('#budget').value = state.budget || '';
    renderBudgetMeter();
    // prefs
    $('#styleChips').innerHTML = STYLE_OPTIONS.map(s => `<button type="button" class="chip ${state.req.style.includes(s) ? 'is-on' : ''}" data-style="${s}" aria-pressed="${state.req.style.includes(s)}">${s}</button>`).join('');
    $$('.seg[data-pref]').forEach(seg => {
      const v = state.constraints[seg.dataset.pref] || 'normal';
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('is-on', b.dataset.v === v));
    });
    $('#cAccess').checked = !!state.constraints.accessibility;
    $('#cWallMount').checked = state.constraints.wall_mount_allowed === false;
    $('#cDoor').checked = !!state.constraints.door_keep_clear;
    $('#cOpen').checked = state.constraints.openness === 'high';
    $('#cBedWin').checked = !!state.constraints.bed_avoid_window;
    // rules
    const R = Object.assign({}, RF.DEFAULT_RULES, state.rules);
    $('#rWalk').value = R.walkWidthCm; $('#rWalkV').textContent = R.walkWidthCm + ' cm';
    $('#rLand').value = R.doorLandingCm; $('#rLandV').textContent = R.doorLandingCm + ' cm';
    $('#rDoor').value = R.doorOpenAngleDeg; $('#rDoorV').textContent = R.doorOpenAngleDeg + '°';
    renderCatalog();
  }

  function renderBudgetMeter() {
    const total = state.items.filter(i => !i.existing).reduce((a, i) => a + i.price, 0);
    const m = $('#budgetMeter');
    if (!state.budget) { m.querySelector('span').style.width = '0'; m.querySelector('.meter-text').innerHTML = total ? `Current design: <span class="num">₹${fmt(total)}</span>` : 'Add a budget to treat cost as a constraint.'; m.classList.remove('is-over'); return; }
    const over = total > state.budget;
    m.classList.toggle('is-over', over);
    m.querySelector('span').style.width = Math.min(100, total / state.budget * 100) + '%';
    m.querySelector('.meter-text').innerHTML = over
      ? `<span class="num">₹${fmt(total)}</span> of ₹${fmt(state.budget)}: <strong>₹${fmt(total - state.budget)} over</strong>`
      : `<span class="num">₹${fmt(total)}</span> of ₹${fmt(state.budget)}: <span class="num">₹${fmt(state.budget - total)}</span> left`;
  }

  function renderCatalog() {
    const q = ($('#catSearch').value || '').toLowerCase();
    const list = RF.catalog.list().filter(p => !q || (p.name + ' ' + p.category + ' ' + p.tags.join(' ')).toLowerCase().includes(q));
    const groups = {};
    list.forEach(p => (groups[p.category] = groups[p.category] || []).push(p));
    $('#catList').innerHTML = Object.keys(groups).map(c => `<li class="cat-group">${RF.CATEGORY_LABELS[c]}</li>` + groups[c].map(p => `
      <li class="cat-item" style="--cat:${RF.CATEGORY_COLORS[p.category]}"><span class="cat-sw"></span>
        <span><strong>${esc(p.name)}</strong><small class="num">${p.width_cm} × ${p.depth_cm} × ${p.height_cm} cm · ₹${fmt(p.price_inr)}</small></span>
        <button type="button" class="btn-quiet btn-small" data-add="${p.id}" aria-label="Add ${esc(p.name)}">Add</button></li>`).join('')).join('') || '<li class="note">No matches.</li>';
  }

  /* ---------- dock ---------- */

  function activeLayout() { return state.layouts.find(l => l.id === state.active); }

  function renderDock() { renderChecks(); renderSelected(); renderWhy(); renderBudgetMeter(); }

  function renderChecks() {
    const v = state.validation, L = activeLayout();
    const el = $('#dockChecks');
    if (!v) { el.innerHTML = ''; return; }
    const real = state.items.filter(i => !i.existing);
    if (!real.length) {
      const failed = state.layouts.filter(l => !l.ok);
      el.innerHTML = `<h3>No layout yet</h3>${failed.length ? `<ul class="checks">${failed.map(l => `<li class="is-fail"><span class="ic">✕</span><span>Layout ${l.letter} (${esc(l.title)})<small>${esc(l.reason)}</small></span></li>`).join('')}</ul>` : '<p class="note">Describe what you need and ROOMFIT will generate layouts that pass every check.</p>'}`;
      return;
    }
    const rows = RF.summarize(v);
    const n = v.violations.length;
    const title = L ? `Layout ${L.letter}: ${esc(L.title)}${state.edited ? ' (edited)' : ''}` : 'Your arrangement';
    let html = `<h3>${title} <small>${n ? `${n} problem${n > 1 ? 's' : ''}` : 'passes every check'}</small></h3><ul class="checks">`;
    for (const r of rows) {
      if (r.id === 'budget') {
        const b = r.budget;
        html += `<li class="is-${r.status}"><span class="ic">${r.status === 'pass' ? '✓' : '✕'}</span><span>${b.over > 0 ? `This layout works spatially but exceeds your budget by <span class="num">₹${fmt(b.over)}</span>` : `Within budget: <span class="num">₹${fmt(b.total)}</span>, <span class="num">₹${fmt(b.remaining)}</span> left`}</span></li>`;
        continue;
      }
      const ic = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✕' : '–';
      const label = r.id === 'access' && r.status === 'pass' && v.circulation.maxWidth ? `Walking path from the door: up to <span class="num">${v.circulation.maxWidth} cm</span> wide` : r.label;
      html += `<li class="is-${r.status}"><span class="ic">${ic}</span><span>${label}${r.fails.slice(0, 3).map(f => `<small>${esc(f.name)}: ${esc(f.detail)}</small>`).join('')}${r.note ? `<small>${esc(r.note)}</small>` : ''}</span></li>`;
    }
    html += '</ul>';
    if (v.budget.over > 0) {
      const alts = RF.budgetAlternatives(state.room, state.items, ctx());
      html += alts.length ? `<div class="alt"><p class="note">Cheaper options that still pass every check. Nothing changes until you choose:</p>${alts.map((a, i) => `<button type="button" class="btn-quiet btn-small" data-alt="${i}">Swap ${esc(a.from.name)} for ${esc(a.to.name)}: save ₹${fmt(a.save)}</button>`).join('')}</div>` : '<p class="note">No single swap keeps this layout valid and cheaper. Try "Show me the cheapest layout".</p>';
      state.alts = alts;
    }
    if (L && L.notes && L.notes.length && !state.edited) html += `<details class="note" style="margin-top:8px"><summary>How products were chosen</summary>${L.notes.map(n => `<p>${esc(n)}</p>`).join('')}</details>`;
    el.innerHTML = html;
  }

  function dimsEditHtml(it) {
    const f = Math.max(it.front || 0, it.door || 0, it.drawer || 0);
    const field = (k, label, v, max) => `<label class="field"><span>${label}</span><span class="inp"><input type="number" data-dim="${k}" value="${v}" min="${k === 'front' ? 0 : 1}" max="${max}" step="1" inputmode="numeric" aria-label="${label} in cm"><em>cm</em></span></label>`;
    return `<div class="dims-edit" data-uid="${esc(it.uid)}">${field('w', 'Width', it.w, 600)}${field('d', 'Depth', it.d, 600)}${field('h', 'Height', it.h, 400)}${field('front', 'Front space', f, 300)}</div>
      <p class="note dims-note">${it.customDims ? 'Custom size: these are your measurements, not the listed product size.' : 'Edit any measurement to match the exact piece. Every check re-runs as you type.'}</p>`;
  }

  function renderSelected() {
    const el = $('#dockSelected');
    if (state.pendingFit) { el.innerHTML = pendingFitHtml(state.pendingFit); return; }
    const it = state.items.find(i => i.uid === state.selected);
    if (!it) { el.innerHTML = `<h3>Nothing selected</h3><p class="note">Select a piece to inspect and edit its measurements. Drag to move it, press R to rotate, Delete to remove. Hold Shift with the arrow keys for 10 cm steps.</p>`; return; }
    // while the user is typing a measurement, keep the inputs and only refresh the results below them
    const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('.dims-edit');
    if (typing && typing.dataset.uid === it.uid && el.contains(typing)) {
      el.querySelector('.sel-dims').textContent = `${it.w} × ${it.d} × ${it.h} cm${it.elev ? ` · mounted at ${it.elev} cm` : ''}`;
      el.querySelector('.dims-note').textContent = 'Custom size: these are your measurements, not the listed product size.';
      el.querySelector('#selBody').innerHTML = selectedBodyHtml(it);
      return;
    }
    el.innerHTML = selectedTopHtml(it) + `<div id="selBody">${selectedBodyHtml(it)}</div>`;
  }

  function selectedTopHtml(it) {
    const web = it.source && it.source.productUrl;
    const src = it.existing ? (it.estimated ? 'Existing furniture, size estimated from photo' : 'Existing furniture you measured')
      : web ? `${it.source.retailer || 'Retailer'} · ${it.price ? '₹' + fmt(it.price) + ' listed' : 'price not listed'}${it.source.dimensionsSource === 'user' ? ' · dimensions you entered' : ' · dimensions from the listing'}`
      : it.sample ? `Sample catalog · ₹${fmt(it.price)} (sample price)` : `Custom · ₹${fmt(it.price)}`;
    let html = '';
    if (it.preview) {
      const bad = state.validation.violations.filter(x => x.uid === it.uid);
      html += `<div class="preview-bar ${bad.length ? 'is-bad' : ''}"><div><strong>Product preview</strong> <span class="num">${it.w} × ${it.d} × ${it.h} cm</span>
        <p>${bad.length ? `× ${esc(bad[0].label === 'No collisions' ? 'Collision detected' : bad[0].label)}: ${esc(bad[0].detail)}` : '✓ Valid placement'}</p></div>
        <div class="row gap"><button type="button" class="btn btn-small btn-primary" data-act="confirmpreview"${bad.length ? ' title="Placing it anyway keeps the problems visible"' : ''}>Confirm placement</button><button type="button" class="btn-quiet btn-small" data-act="cancelpreview">Cancel</button></div></div>`;
    }
    html += `${web ? `<p class="note"><a href="${esc(it.source.productUrl)}" target="_blank" rel="noopener noreferrer">View product</a></p>` : ''}<div class="sel-head"><div><h3>${esc(it.name)}</h3><p class="sel-dims">${it.w} × ${it.d} × ${it.h} cm${it.elev ? ` · mounted at ${it.elev} cm` : ''}</p><p class="note">${esc(src)}</p></div>
      <div class="sel-actions">${it.locked ? '' : `<button type="button" class="btn-quiet" data-act="rotate">Rotate</button>${it.existing ? '' : `<button type="button" class="btn-quiet" data-act="swap">Swap</button>`}<button type="button" class="btn-quiet" data-act="remove">Remove</button>`}</div></div>`;
    html += dimsEditHtml(it);
    return html;
  }

  function selectedBodyHtml(it) {
    const rec = state.validation.items[it.uid] || { checks: [], status: 'pass' };
    let html = `<ul class="checks">${rec.checks.map(c => `<li class="is-${c.status}"><span class="ic">${c.status === 'pass' ? '✓' : '✕'}</span><span>${esc(c.label)}${c.required != null ? `<span class="req-avail" style="margin-left:8px">Required <b>${c.required}${c.unit === '°' ? '°' : ' cm'}</b> Available <b>${c.available >= 300 && c.unit !== '°' ? '300+' : c.available}${c.unit === '°' ? '°' : ' cm'}</b></span>` : ''}<small>${esc(c.detail)}</small></span></li>`).join('')}</ul>`;
    const othersBlocked = state.validation.violations.filter(x => x.uid !== it.uid && x.uid);
    if (rec.status === 'fail' && !it.locked) {
      if (state.fixFor !== it.uid + it.x + it.y + it.facing) { state.fix = RF.suggestFix(state.room, state.items, it.uid, ctx()); state.fixFor = it.uid + it.x + it.y + it.facing; }
      if (state.fix) html += `<div class="fix"><span>${esc(state.fix.text)}</span><button type="button" class="btn btn-small" data-act="applyfix">Move it</button></div>`;
      else html += `<p class="note">No straight move fixes this. Try rotating it, swapping it for a smaller piece, or removing something nearby.</p>`;
    } else if (othersBlocked.length) html += `<p class="note">Other pieces have problems; select them to see fixes.</p>`;
    if (state.swap && state.swap.uid === it.uid) html += swapHtml(state.swap);
    return html;
  }

  /* ---------- editing measurements ---------- */

  /** After a size change, shift the item so its back edge stays where it was (flush to the wall). */
  function anchorBack(it, before) {
    const n = RF.rectOf(it), back = RF.OPP[it.facing];
    if (back === 'N') it.y += before.y0 - n.y0; else if (back === 'S') it.y += before.y1 - n.y1;
    else if (back === 'W') it.x += before.x0 - n.x0; else it.x += before.x1 - n.x1;
    return it;
  }

  const DIM_LIMITS = { w: [1, 600], d: [1, 600], h: [1, 400], front: [0, 300] };
  /** Change an item's measurements, keeping its back edge where it was, then re-check everything. */
  function applyDims(it, patch) {
    const r = RF.rectOf(it);
    for (const k of Object.keys(patch)) {
      const [lo, hi] = DIM_LIMITS[k];
      const v = Math.min(hi, Math.max(lo, Math.round(+patch[k])));
      if (!isFinite(v)) continue;
      if (k === 'front') { it.front = v; it.door = Math.min(it.door || 0, v); it.drawer = Math.min(it.drawer || 0, v); }
      else it[k] = v;
    }
    anchorBack(it, r);
    // if it grew past a side wall, slide it back inside (only when it fits the room at all)
    const n = RF.rectOf(it);
    if (n.x1 - n.x0 <= state.room.width) { if (n.x0 < 0) it.x -= n.x0; else if (n.x1 > state.room.width) it.x -= n.x1 - state.room.width; }
    if (n.y1 - n.y0 <= state.room.length) { if (n.y0 < 0) it.y -= n.y0; else if (n.y1 > state.room.length) it.y -= n.y1 - state.room.length; }
    it.customDims = true;
    if (it.source) it.source.dimensionsSource = 'user';
    const rules = RF.effectiveRules(state.rules, state.constraints);
    state.items.filter(c => c.pairedWith === it.uid && c.category === 'chair').forEach(c => { const p = RF.companionFor(it, c, rules); c.x = p.x; c.y = p.y; c.facing = p.facing; });
    if (it.existing) {
      const e = (state.room.existing || []).find(x => x.uid === it.uid);
      if (e) Object.assign(e, { w: it.w, d: it.d, h: it.h, x: it.x, y: it.y });
      roomSig = JSON.stringify(state.room);
    }
    markEdited(); revalidate(true); save();
  }

  /* ---------- undo ---------- */

  function pushHistory() {
    state.history = state.history || [];
    state.history.push(clone(state.items));
    if (state.history.length > 30) state.history.shift();
  }
  function undo() {
    if (!state.history || !state.history.length) return false;
    state.items = state.history.pop();
    if (!state.items.some(i => i.uid === state.selected)) state.selected = null;
    markEdited(); revalidate(true); save();
    return true;
  }

  function swapHtml(sw) {
    if (sw.loading) return `<div class="swap"><p class="note">Checking every alternative in your room…</p></div>`;
    return `<div class="swap"><p class="note">Alternatives, checked against your room:</p>${sw.options.map((o, i) => `
      <button type="button" class="swap-row" data-swap="${i}"><span>${esc(o.p.name)} <span class="num">${o.p.width_cm}×${o.p.depth_cm}</span> · ₹${fmt(o.p.price_inr)}<small>${esc(o.why)}</small></span>
      <span class="${o.status === 'bad' ? 'bad' : 'ok'}">${o.status === 'here' ? '✓ Fits here' : o.status === 'moved' ? '✓ Fits if moved' : '✕ Does not fit'}</span></button>`).join('')}</div>`;
  }

  function computeSwap(it) {
    state.swap = { uid: it.uid, loading: true };
    renderSelected();
    setTimeout(() => {
      const others = state.items.filter(i => i.uid !== it.uid && i.pairedWith !== it.uid);
      const pairs = state.items.filter(i => i.pairedWith === it.uid);
      const opts = RF.catalog.list().filter(p => p.category === it.category && p.id !== it.productId).map(p => {
        const cand = Object.assign({}, it, productFields(p));
        const fixedPairs = pairs.map(c => Object.assign({}, c, RF.companionFor(cand, c, RF.effectiveRules(state.rules, state.constraints)), { uid: c.uid }));
        const v = RF.validate(state.room, others.concat([cand], fixedPairs), ctx());
        if (v.ok) return { p, status: 'here', why: 'Passes every check in the current position', item: cand };
        const res = RF.findPlacement(state.room, others, Object.assign({}, cand), ctx());
        if (res.ok) return { p, status: 'moved', why: `Valid against the ${res.item.facing ? RF.WALL_NAME[RF.OPP[res.item.facing]] : ''} wall`, item: res.item };
        const f = (res.validation && res.validation.violations.find(x => x.uid === cand.uid)) || v.violations[0];
        return { p, status: 'bad', why: f ? f.detail : 'No valid position', item: res.item || cand };
      });
      state.swap = { uid: it.uid, options: opts };
      renderSelected();
    }, 30);
  }

  function applySwap(o) {
    const idx = state.items.findIndex(i => i.uid === state.swap.uid);
    const old = state.items[idx];
    const nu = Object.assign({}, old, productFields(o.p), { x: o.item.x, y: o.item.y, facing: o.item.facing });
    state.items[idx] = nu;
    state.items.filter(i => i.pairedWith === nu.uid).forEach(c => Object.assign(c, RF.companionFor(nu, c, RF.effectiveRules(state.rules, state.constraints)), { uid: c.uid }));
    if (o.status !== 'bad') {
      const r = state.req.required.find(x => x.category === nu.category);
      if (r) r.pinnedId = o.p.id;
      pushLog('rf', `Swapped to ${o.p.name}. ✓ Fits. Future layouts will keep it.`);
    } else pushLog('rf', `${o.p.name}: ✕ Does not fit. ${o.why} Placed so you can inspect the problem.`);
    markEdited(); state.swap = null;
    revalidate(true); renderPanel(); save();
  }

  function pendingFitHtml(pf) {
    const { proto, res } = pf;
    const fails = res.validation ? res.validation.violations : [];
    const alt = RF.catalog.list().filter(p => p.category === proto.category && p.id !== proto.productId && p.width_cm * p.depth_cm < proto.w * proto.d)
      .filter(p => RF.findPlacement(state.room, state.items, RF.instance(p), ctx()).ok).slice(0, 3);
    return `<h3>${esc(proto.name)} <small class="num">${proto.w} × ${proto.d} × ${proto.h} cm</small></h3>
      <p class="verdict-word bad">✕ Does not fit</p>
      <ul class="checks">${fails.slice(0, 3).map(f => `<li class="is-fail"><span class="ic">✕</span><span>${f.uid !== proto.uid ? esc(f.name) + ': ' : ''}${esc(f.detail)}</span></li>`).join('') || '<li class="is-fail"><span class="ic">✕</span><span>No position in the room is valid.</span></li>'}</ul>
      <p class="note">That's the closest of every position and orientation ROOMFIT tried.</p>
      <div class="row gap wrap" style="margin-top:8px"><button type="button" class="btn-quiet btn-small" data-act="placeanyway">Place anyway to inspect</button>${alt.map(p => `<button type="button" class="btn-quiet btn-small" data-addp="${p.id}">Try ${esc(p.name)} (fits)</button>`).join('')}<button type="button" class="btn-quiet btn-small" data-act="cancelfit">Dismiss</button></div>`;
  }

  function addProduct(p) {
    const proto = RF.instance(p);
    const res = RF.findPlacement(state.room, state.items, proto, ctx());
    if (res.ok) {
      state.items.push(res.item);
      if (p.category === 'desk' && !state.items.some(i => i.category === 'chair' && !i.pairedWith)) { /* desks added alone stay alone; add a chair from the catalog if wanted */ }
      markEdited();
      state.selected = res.item.uid; state.pendingFit = null;
      const fr = res.validation.items[res.item.uid].checks.find(c => c.id === 'front');
      pushLog('rf', `${p.name}: ✓ Fits. Placed ${RF.wallOf(state.room, res.item) ? 'against the ' + RF.WALL_NAME[RF.wallOf(state.room, res.item)] + ' wall' : 'in the room'}${fr ? `; front clearance needs ${fr.required} cm, has ${fr.available >= 300 ? '300+' : fr.available} cm` : ''}.`);
      revalidate(true); save();
    } else {
      state.pendingFit = { proto, res };
      state.selected = null;
      pushLog('rf', `${p.name}: ✕ Does not fit. ${res.validation && res.validation.violations[0] ? res.validation.violations[0].detail : ''}`);
      renderDock();
    }
  }

  function renderWhy() {
    const el = $('#dockWhy');
    const hasItems = state.items.some(i => !i.existing);
    let html = `<div class="row between"><h3>Why this layout?</h3>${hasItems ? `<button type="button" class="btn-quiet btn-small" data-act="why">${state.why ? 'Refresh' : 'Explain'}</button>` : ''}</div>`;
    if (state.why) html += `<div class="why-text">${state.why.loading ? '<p class="note">Working from the computed facts…</p>' : state.why.text.map(t => `<p>${esc(t)}</p>`).join('') + `<p class="why-src">Source: ${esc(state.why.source)}</p>`}</div>`;
    else if (hasItems) html += `<p class="note">Every reason given is taken from ROOMFIT's own measurements of this layout.</p>`;
    if (state.log.length) html += `<ul class="log">${state.log.slice(-5).reverse().map(l => `<li class="${l.who}">${l.who === 'you' ? 'You: ' : ''}${esc(l.text)}</li>`).join('')}</ul>`;
    el.innerHTML = html;
  }

  async function explain() {
    const L = activeLayout();
    const facts = RF.layoutFacts(state.room, state.items, state.validation, ctx());
    const lines = RF.explainFromFacts(facts, L && !state.edited ? L : null);
    if (state.edited) lines.unshift('You have edited this layout; the facts below describe your current arrangement.');
    if (state.validation.violations.length) lines.push(`It currently fails ${state.validation.violations.length} check(s): ${state.validation.violations.slice(0, 2).map(v => v.name + ': ' + v.detail).join('; ')}.`);
    state.why = { loading: true }; renderWhy();
    const r = await RF.ai.run('explainLayout', facts, lines);
    state.why = { text: r.text, source: r.source };
    renderWhy();
  }

  function pushLog(who, text) { state.log.push({ who, text }); if (state.log.length > 60) state.log.shift(); renderWhy(); renderChat(); }

  /* ---------- chat: direct commands on the current arrangement ---------- */
  // These act on what's in the room now (no re-planning), and every reply quotes RF.validate's numbers.

  const TARGETS = [
    ['armchair', /\barm ?chairs?\b/], ['coffee_table', /\bcoffee tables?\b/], ['dressing_table', /\b(dressing tables?|vanity)\b/],
    ['bedside', /\b(bedside( tables?)?|night ?stands?)\b/], ['wall_shelf', /\bwall shel(f|ves)\b/], ['tv_unit', /\btv (unit|stand|cabinet)s?\b/],
    ['bed', /\b(beds?|cot)\b/], ['wardrobe', /\b(wardrobes?|almirahs?|closets?)\b/], ['desk', /\b(desks?|study table|work ?table|workstation)\b/],
    ['chair', /\bchairs?\b/], ['bookshelf', /\b(book ?shel(f|ves)|book ?cases?|shel(f|ves))\b/], ['storage', /\b(chest of drawers|drawers|cabinet|storage( unit)?)\b/],
    ['sofa', /\b(sofas?|couch|settee)\b/]
  ];
  const WALL_WORDS = { north: 'N', south: 'S', east: 'E', west: 'W', top: 'N', bottom: 'S', left: 'W', right: 'E', back: 'N', front: 'S' };
  const DIR_WORDS = { left: [-1, 0], west: [-1, 0], right: [1, 0], east: [1, 0], up: [0, -1], north: [0, -1], forward: [0, -1], down: [0, 1], south: [0, 1], back: [0, 1], backward: [0, 1] };
  const label = c => (RF.CATEGORY_LABELS[c] || c).toLowerCase();

  function mentionedCategory(t) { for (const [c, re] of TARGETS) if (re.test(t)) return c; return null; }
  function findTarget(t) {
    const live = state.items.filter(i => !i.preview);
    const cat = mentionedCategory(t);
    if (cat) {
      const list = live.filter(i => i.category === cat);
      if (!list.length) return { missing: cat };
      return { item: list.find(i => i.uid === state.selected) || list[0] };
    }
    const byName = live.find(i => t.includes(i.name.toLowerCase().replace(/\s*\(.*\)/, '')));
    if (byName) return { item: byName };
    const sel = live.find(i => i.uid === state.selected);
    if (sel && /\b(it|this|that|selected|the piece)\b/.test(t)) return { item: sel };
    return sel ? { item: sel, implicit: true } : {};
  }

  /** One-line status of an item straight from the engine. */
  function itemReport(it) {
    const v = state.validation, rec = v.items[it.uid];
    const mine = v.violations.filter(x => x.uid === it.uid);
    const others = v.violations.filter(x => x.uid && x.uid !== it.uid);
    const fr = rec && rec.checks.find(c => c.id === 'front');
    let s = `${it.name} is ${it.w} × ${it.d} × ${it.h} cm`;
    const wall = RF.wallOf(state.room, it);
    if (wall) s += `, against the ${RF.WALL_NAME[wall]} wall`;
    if (!mine.length) {
      s += `. ✓ Passes every check${fr ? ` (front space: needs ${fr.required} cm, has ${fr.available >= 300 ? '300+' : fr.available} cm)` : ''}.`;
      if (others.length) s += ` But ${others[0].name} now fails: ${others[0].detail}.`;
    } else {
      s += `. ✕ ${mine.slice(0, 2).map(m => m.detail).join('; ')}.`;
      const fix = RF.suggestFix(state.room, state.items, it.uid, ctx());
      if (fix) s += ` ${fix.text} Say "fix it" to apply.`;
    }
    return s;
  }

  function applyChair(it) {
    const rules = RF.effectiveRules(state.rules, state.constraints);
    state.items.filter(c => c.pairedWith === it.uid && c.category === 'chair').forEach(c => { const p = RF.companionFor(it, c, rules); c.x = p.x; c.y = p.y; c.facing = p.facing; });
  }

  /** Best valid spot for an item among `cands` (other items stay put). score: lower is better. */
  function bestSpot(it, cands, scoreFn) {
    const others = state.items.filter(i => i.uid !== it.uid && i.pairedWith !== it.uid);
    const pairs = state.items.filter(i => i.pairedWith === it.uid);
    const rules = RF.effectiveRules(state.rules, state.constraints);
    let best = null, closest = null;
    for (const c of cands) {
      const t = Object.assign({}, it, { x: c.x, y: c.y, facing: c.facing });
      const ps = pairs.map(p => Object.assign({}, p, (() => { const q = RF.companionFor(t, p, rules); return { x: q.x, y: q.y, facing: q.facing }; })()));
      const v = RF.validate(state.room, others.concat([t], ps), ctx({ skipCirculation: true, focus: new Set([t.uid].concat(ps.map(p => p.uid))) }));
      const sc = scoreFn(t);
      if (v.ok) { if (!best || sc < best.sc) best = { sc, c }; }
      else { const sev = RF.severity(v); if (!closest || sev < closest.sev) closest = { sev, v }; }
    }
    // confirm with circulation on the winner
    if (best) {
      const t = Object.assign({}, it, best.c);
      const v = RF.validate(state.room, others.concat([t]), ctx());
      if (!v.items[t.uid] || v.items[t.uid].status === 'fail') return { ok: false, why: (v.violations.find(x => x.uid === t.uid) || {}).detail };
    }
    return best ? { ok: true, spot: best.c } : { ok: false, why: closest && closest.v.violations[0] ? closest.v.violations[0].detail : 'no position passes' };
  }

  function moveTo(it, spot) { it.x = spot.x; it.y = spot.y; it.facing = spot.facing; applyChair(it); }

  function directCommand(raw) {
    const t = ' ' + raw.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim() + ' ';
    const done = msg => { markEdited(); revalidate(true); save(); return msg; };

    if (/^\s*(undo|go back|revert|undo that)\s*$/.test(t)) return undo() ? 'Undone. ' + summaryLine() : 'Nothing to undo.';
    if (/^\s*(help|what can you do|commands)\??\s*$/.test(t)) return 'Try: "make the desk 110 cm wide", "move the bed to the east wall", "put the desk near the window", "rotate the wardrobe", "move it 20 cm left", "remove the chair", "add a bookshelf", "does everything fit?", "how much space in front of the desk?", "what does it cost?", "undo". You can also type exact sizes like "make the wardrobe 120 x 55". Room-wide requests like "show me the cheapest layout" or "I don\'t want anything mounted to the wall" re-plan all layouts.';
    if (!state.items.some(i => !i.existing) && !/\badd\b/.test(t)) return null;

    // questions
    const question = /\?\s*$/.test(t) || /^\s*(does|do|is|are|will|can|how|what|which|where|any)\b/.test(t);
    if (question && !/\b(make|move|put|place|add|remove|delete|rotate|turn|swap|set|change)\b/.test(t)) {
      if (/\b(cost|price|total|spend|spent|budget|expensive)\b/.test(t)) {
        const b = state.validation.budget;
        return `The current design costs ₹${fmt(b.total)}${b.budget ? (b.over > 0 ? `, ₹${fmt(b.over)} over your ₹${fmt(b.budget)} budget` : `, leaving ₹${fmt(b.remaining)} of your ₹${fmt(b.budget)} budget`) : ''}. ${state.items.filter(i => !i.existing).map(i => `${i.name} ₹${fmt(i.price)}`).join(', ')}.`;
      }
      if (/\b(walk|walkway|path|circulation|move around|get around)\b/.test(t)) {
        const v = RF.validate(state.room, state.items, ctx({ computeMaxWidth: true }));
        return v.circulation.status === 'unknown' ? 'The room has no door, so walking paths can\'t be checked.' : v.circulation.maxWidth ? `The widest clear path from the door to every piece is ${v.circulation.maxWidth} cm (your minimum is ${v.circulation.walkWidth} cm).` : `✕ There's no ${v.circulation.walkWidth} cm path from the door to every piece.`;
      }
      if (/\broom\b.*\b(size|big|large|dimensions?|wide|long)\b/.test(t) || /\b(size|big|large|dimensions?|wide|long)\b.*\b(the|this|my) room\b/.test(t)) {
        const a = state.room.width * state.room.length / 10000;
        return `The room is ${state.room.width} × ${state.room.length} cm (${a.toFixed(1)} m²), ${state.room.height} cm high. ${RF.metrics(state.room, state.items, state.validation).floorFreePct}% of the floor is free.`;
      }
      const tg = findTarget(t);
      if (tg.missing) return `There's no ${label(tg.missing)} in the room right now. Say "add a ${label(tg.missing)}" to place one.`;
      if (tg.item && !tg.implicit || tg.item && /\b(space|clearance|room|gap)\b/.test(t)) {
        const it = tg.item, rec = state.validation.items[it.uid];
        if (/\b(space|clearance|room|gap)\b/.test(t)) {
          const cs = rec.checks.filter(c => c.required != null && c.unit !== '°');
          return cs.length ? `${it.name}: ` + cs.map(c => `${c.label.toLowerCase()} needs ${c.required} cm, has ${c.available >= 300 ? '300+' : c.available} cm ${c.status === 'pass' ? '✓' : '✕'}`).join('; ') + '.' : `${it.name} has no clearance requirement.`;
        }
        if (/\b(big|wide|deep|tall|high|size|dimensions?|measure)/.test(t) && !/\bfit/.test(t)) return `${it.name} is ${it.w} cm wide, ${it.d} cm deep and ${it.h} cm high.`;
        return itemReport(it);
      }
      if (/\b(fit|fits|ok|okay|problem|problems|issue|issues|valid|work|wrong|clash|block)\b/.test(t)) return summaryLine();
    }

    // add
    const addM = t.match(/\b(add|include|put in|i need|i want) (an?|another|one more|a second|some)?\s*/);
    if (addM && !/\b(more storage|space|light|less)\b/.test(t)) {
      const cat = mentionedCategory(t);
      if (cat) {
        pushHistory();
        const list = RF.catalog.list().filter(p => p.category === cat);
        const named = list.find(p => t.includes(p.name.toLowerCase())) || null;
        const opts = named ? [named] : list.slice().sort((a, b) => a.price_inr - b.price_inr);
        for (const p of opts) {
          const res = RF.findPlacement(state.room, state.items, RF.instance(p), ctx());
          if (res.ok) { state.items.push(res.item); state.selected = res.item.uid; const r = state.req.required.find(x => x.category === cat); if (r) r.qty = state.items.filter(i => i.category === cat).length; else state.req.required.push({ category: cat, qty: 1, hint: null, pinnedId: null }); done(); renderPanel(); return `Added ${p.name} (${p.width_cm} × ${p.depth_cm} cm, ₹${fmt(p.price_inr)} sample price). ` + itemReport(state.items.find(i => i.uid === res.item.uid)); }
          if (named) return `✕ ${p.name} doesn't fit anywhere: ${res.validation ? res.validation.violations[0].detail : 'no valid position'}.`;
        }
        state.history.pop();
        return `✕ No ${label(cat)} in the catalog fits with the current furniture. Remove or move something first.`;
      }
    }

    const tg = findTarget(t);
    if (tg.missing && /\b(make|move|put|place|rotate|turn|remove|delete|swap|set|change|resize|shift|push)\b/.test(t)) return `There's no ${label(tg.missing)} in the room. Say "add a ${label(tg.missing)}".`;
    const it = tg.item;
    if (!it) return null;
    const lockedMsg = `${it.name} is furniture you're keeping, so it can't be moved. You can still edit its measurements.`;

    // fix
    if (/\b(fix it|fix that|apply (the )?fix|fix (the )?problem)\b/.test(t)) {
      const fix = RF.suggestFix(state.room, state.items, it.uid, ctx());
      if (!fix) return state.validation.items[it.uid].status === 'fail' ? 'No straight move fixes it. Try rotating it, a smaller size, or removing something nearby.' : `${it.name} already passes every check.`;
      pushHistory(); moveItem(state.items, it.uid, fix.x, fix.y); done();
      return `Moved ${it.name} ${fix.cm} cm ${fix.dir}. ` + itemReport(it);
    }
    // remove
    if (/\b(remove|delete|get rid of|take out|drop)\b/.test(t)) {
      if (it.locked) return lockedMsg;
      pushHistory();
      state.items = state.items.filter(i => i.uid !== it.uid && i.pairedWith !== it.uid);
      const r = state.req.required.find(x => x.category === it.category);
      if (r) { r.qty = state.items.filter(i => i.category === it.category).length; if (!r.qty) state.req.required.splice(state.req.required.indexOf(r), 1); }
      if (state.selected === it.uid) state.selected = null;
      done(); renderPanel();
      return `Removed ${it.name}. ` + summaryLine();
    }
    // rotate
    if (/\b(rotate|turn|spin|flip)\b/.test(t)) {
      if (it.locked) return lockedMsg;
      pushHistory(); rotateItem(state.items, it.uid);
      if (/\b(around|180|flip)\b/.test(t)) rotateItem(state.items, it.uid);
      state.selected = it.uid; done();
      return `Rotated ${it.name}; it now faces ${RF.WALL_NAME[it.facing]}. ` + itemReport(it);
    }
    // measurements: "110 x 60", "110 cm wide", "width 110", "20 cm narrower"
    const patch = {};
    const box = t.match(/(\d{2,3})\s*(?:cm)?\s*(?:x|×|by|\*)\s*(\d{2,3})(?:\s*(?:cm)?\s*(?:x|×|by|\*)\s*(\d{2,3}))?/);
    if (box) { patch.w = +box[1]; patch.d = +box[2]; if (box[3]) patch.h = +box[3]; }
    const grab = (re) => { const m = t.match(re); return m ? +(m[1] || m[2]) : null; };
    const W = grab(/(\d{2,3})\s*cm\s*(?:wide|width)|width\s*(?:to|of|=|:|is)?\s*(\d{2,3})/), D = grab(/(\d{2,3})\s*cm\s*(?:deep|depth)|depth\s*(?:to|of|=|:|is)?\s*(\d{2,3})/), H = grab(/(\d{2,3})\s*cm\s*(?:tall|high|height)|height\s*(?:to|of|=|:|is)?\s*(\d{2,3})/);
    const F = grab(/(\d{2,3})\s*cm\s*(?:of )?(?:front|clearance)|(?:front|clearance)\s*(?:space|clearance)?\s*(?:to|of|=|:|is)?\s*(\d{2,3})/);
    if (W) patch.w = W; if (D) patch.d = D; if (H) patch.h = H; if (F != null) patch.front = F;
    const rel = t.match(/(\d{1,3})\s*cm\s*(narrower|wider|shallower|deeper|shorter|taller|lower|higher|smaller|bigger|larger)/);
    if (rel) {
      const n = +rel[1], k = { narrower: ['w', -1], wider: ['w', 1], smaller: ['w', -1], bigger: ['w', 1], larger: ['w', 1], shallower: ['d', -1], deeper: ['d', 1], shorter: ['h', -1], lower: ['h', -1], taller: ['h', 1], higher: ['h', 1] }[rel[2]];
      patch[k[0]] = it[k[0]] + k[1] * n;
    }
    if (Object.keys(patch).length && !/\b(move|shift|push|slide)\b/.test(t)) {
      pushHistory(); applyDims(it, patch); state.selected = it.uid;
      return `Resized. ` + itemReport(it);
    }
    // smaller / bigger product of the same type, kept in place if possible
    if (/\b(smaller|narrower|compact|more compact|bigger|larger|wider)\b/.test(t) && !/\b(room|less cramped|more space)\b/.test(t) && !it.existing) {
      const smaller = /\b(smaller|narrower|compact)\b/.test(t);
      // "smaller" means narrower first (that's what people measure against a wall), then shallower
      const key = p => p.width_cm * 1000 + p.depth_cm, cur = it.w * 1000 + it.d;
      const opts = RF.catalog.list().filter(p => p.category === it.category && p.id !== it.productId && (smaller ? key(p) < cur : key(p) > cur)).sort((a, b) => smaller ? key(b) - key(a) : key(a) - key(b));
      if (!opts.length) return `There's no ${smaller ? 'smaller' : 'bigger'} ${label(it.category)} in the catalog. You can type exact measurements instead, like "make the ${label(it.category)} 100 cm wide".`;
      pushHistory();
      for (const p of opts) {
        const cand = anchorBack(Object.assign({}, it, productFields(p), { customDims: false }), RF.rectOf(it));
        const here = RF.validate(state.room, state.items.map(i => i.uid === it.uid ? cand : i), ctx());
        let spot = null;
        if (here.items[it.uid].status === 'fail') {
          const res = bestSpot(cand, RF.candidatePositions(state.room, cand, { step: 5 }), s => Math.hypot(s.x - it.x, s.y - it.y));
          if (!res.ok) continue;
          spot = res.spot;
        }
        Object.assign(it, productFields(p), { customDims: false, x: cand.x, y: cand.y });
        if (spot) moveTo(it, spot); else applyChair(it);
        state.constraints[it.category + (smaller ? '_max_width_cm' : '_min_width_cm')] = smaller ? p.width_cm : p.width_cm;
        const r = state.req.required.find(x => x.category === it.category); if (r) r.pinnedId = p.id;
        state.selected = it.uid; done(); renderPanel();
        return `Swapped to ${p.name} (${p.width_cm} × ${p.depth_cm} cm, ₹${fmt(p.price_inr)})${spot ? ', moved so it fits' : ''}. ` + itemReport(it);
      }
      state.history.pop();
      return `✕ No ${smaller ? 'smaller' : 'bigger'} ${label(it.category)} fits with the current furniture.`;
    }
    // swap
    if (/\b(swap|replace|change|different|alternatives?)\b/.test(t) && !/\b(measure|size|width|depth)\b/.test(t)) {
      if (it.existing) return lockedMsg;
      state.selected = it.uid; computeSwap(it);
      return `Checking every ${label(it.category)} in the catalog against your room. Alternatives are listed in the selected panel.`;
    }
    // near / away from window or door
    const nearM = t.match(/\b(near|next to|by|beside|under|close to|facing|toward|towards|away from|far from|not near)\s+(?:the\s+)?(window|door)/);
    if (nearM && /\b(move|put|place|keep|want|shift|bring|set)\b/.test(t)) {
      if (it.locked) return lockedMsg;
      const op = state.room.openings.find(o => o.type === nearM[2]);
      if (!op) return `The room has no ${nearM[2]}.`;
      const away = /away|far|not near/.test(nearM[1]);
      const mid = RF.openingGeom(state.room, op).mid;
      const res = bestSpot(it, RF.candidatePositions(state.room, it, { step: 5 }), s => (away ? -1 : 1) * RF.distRectPoint(RF.rectOf(s), mid));
      if (!res.ok) return `✕ There's no valid spot for ${it.name} ${away ? 'farther from' : 'nearer to'} the ${nearM[2]}: ${res.why}.`;
      pushHistory(); moveTo(it, res.spot);
      if (nearM[2] === 'window') {   // remember it so future re-plans keep the preference
        state.constraints[it.category + (away ? '_avoid_window' : '_near_window')] = true;
        delete state.constraints[it.category + (away ? '_near_window' : '_avoid_window')];
      }
      state.selected = it.uid; done();
      return `Moved ${it.name}; it's now ${Math.round(RF.distRectPoint(RF.rectOf(it), mid))} cm from the ${nearM[2]}. ` + itemReport(it);
    }
    // move to a wall
    const wallM = t.match(/\b(north|south|east|west|top|bottom|left|right|window|door|opposite)\s+wall\b/) || t.match(/\b(?:to|against|on) the (north|south|east|west)\b/);
    if (wallM && /\b(move|put|place|shift|push|slide|against|on)\b/.test(t)) {
      if (it.locked) return lockedMsg;
      let w = WALL_WORDS[wallM[1]];
      if (wallM[1] === 'window' || wallM[1] === 'door') { const op = state.room.openings.find(o => o.type === wallM[1]); if (!op) return `The room has no ${wallM[1]}.`; w = op.wall; }
      if (wallM[1] === 'opposite') { const cur = RF.wallOf(state.room, it); if (!cur) return `${it.name} isn't against a wall yet.`; w = RF.OPP[cur]; }
      const cands = RF.candidatePositions(state.room, it, { step: 5 }).filter(c => c.wall === w);
      const res = bestSpot(it, cands, s => Math.hypot(s.x - it.x, s.y - it.y));
      if (!res.ok) return `✕ ${it.name} can't go on the ${RF.WALL_NAME[w]} wall: ${res.why}. Nothing moved.`;
      pushHistory(); moveTo(it, res.spot); state.selected = it.uid; done();
      return `Moved ${it.name} to the ${RF.WALL_NAME[w]} wall. ` + itemReport(it);
    }
    // relative move
    const relM = t.match(/(\d{1,3})\s*cm\s*(?:to the\s+)?(left|right|up|down|north|south|east|west|forward|back|backward)/) || t.match(/\b(?:move|shift|push|slide|nudge)\b.*?\b(left|right|up|down|north|south|east|west|forward|backward)\b/);
    if (relM && /\b(move|shift|push|slide|nudge)\b/.test(t)) {
      if (it.locked) return lockedMsg;
      const cm = relM[2] ? +relM[1] : 10, dir = DIR_WORDS[relM[2] || relM[1]];
      pushHistory(); moveItem(state.items, it.uid, it.x + dir[0] * cm, it.y + dir[1] * cm); state.selected = it.uid; done();
      return `Moved ${it.name} ${cm} cm ${relM[2] || relM[1]}. ` + itemReport(it);
    }
    if (/\b(cent(er|re)|middle)\b/.test(t) && /\b(move|put|place)\b/.test(t)) {
      if (it.locked) return lockedMsg;
      const c = { x: state.room.width / 2, y: state.room.length / 2 };
      const res = bestSpot(it, RF.candidatePositions(state.room, it, { floating: true, step: 10 }), s => Math.hypot(s.x - c.x, s.y - c.y));
      if (!res.ok) return `✕ No valid spot near the middle: ${res.why}.`;
      pushHistory(); moveTo(it, res.spot); state.selected = it.uid; done();
      return `Moved ${it.name} as close to the middle as the checks allow. ` + itemReport(it);
    }
    if (/^\s*(select|show|pick|highlight)\b/.test(t)) { select(it.uid); return itemReport(it); }
    return null;
  }

  function summaryLine() {
    const v = RF.validate(state.room, state.items, ctx({ computeMaxWidth: true }));
    const n = v.violations.length;
    if (!n) return `✓ Everything passes: no collisions, the door opens fully, every clearance is met${v.circulation.maxWidth ? ` and the widest walkway is ${v.circulation.maxWidth} cm` : ''}.`;
    return `✕ ${n} problem${n > 1 ? 's' : ''}: ` + v.violations.slice(0, 3).map(x => `${x.name}: ${x.detail}`).join('; ') + '.';
  }

  /* ---------- chat thread ---------- */

  function renderChat() {
    let el = $('#chatThread');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chatThread'; el.className = 'chat'; el.setAttribute('aria-live', 'polite');
      $('#cmdForm').before(el);
      const tog = document.createElement('button');
      tog.type = 'button'; tog.className = 'btn-quiet btn-small chat-toggle'; tog.id = 'chatToggle';
      tog.addEventListener('click', () => { state.chatOpen = !state.chatOpen; renderChat(); if (state.chatOpen) $('#cmdInput').focus(); });
      $('#cmdForm').prepend(tog);
    }
    const msgs = state.log.slice(-40);
    $('#chatToggle').textContent = state.chatOpen ? 'Hide chat' : `Chat${msgs.length ? ` (${msgs.filter(m => m.who === 'you').length})` : ''}`;
    $('#chatToggle').setAttribute('aria-expanded', String(!!state.chatOpen));
    el.hidden = !state.chatOpen;
    if (!state.chatOpen) return;
    el.innerHTML = `<div class="chat-head"><strong>ROOMFIT assistant</strong><span class="note">Answers come from the geometry engine</span><button type="button" class="icon-btn" aria-label="Close chat" data-chatclose>×</button></div>
      <ol class="chat-list">${msgs.length ? msgs.map(m => `<li class="chat-msg ${m.who === 'you' ? 'is-you' : 'is-rf'}${m.pending ? ' is-pending' : ''}">${esc(m.text)}</li>`).join('') : '<li class="chat-msg is-rf">Ask about the room or tell me what to change: "make the desk 110 cm wide", "move the bed to the east wall", "does everything fit?". Say "help" for more.</li>'}</ol>`;
    el.querySelector('[data-chatclose]').addEventListener('click', () => { state.chatOpen = false; renderChat(); });
    const list = el.querySelector('.chat-list'); list.scrollTop = list.scrollHeight;
  }

  /* ---------- natural language ---------- */

  async function handleText(text, from) {
    text = text.trim(); if (!text) return;
    pushLog('you', text);
    if (from === 'cmd') {
      state.chatOpen = true;
      let reply = null;
      try { reply = directCommand(text); } catch (e) { reply = null; console.error(e); }
      if (reply) { pushLog('rf', reply); return; }
    }
    const before = { items: clone(state.items) };
    let r;
    try { r = await RF.ai.run('parseRequirements', text, { items: state.items }); }
    catch (e) { r = RF.nl.parse(text, { items: state.items }); }
    if (r.fallback) toast(r.fallback);
    state.understood = r.understood || []; state.understoodSrc = r.source || '';
    if (r.unparsed && r.intent === 'update') {
      pushLog('rf', 'I couldn\'t map that to a change. Try "make the desk smaller", "keep the bed away from the window" or "show me the cheapest layout".');
      renderPanel(); return;
    }
    if (r.intent === 'explain' && !r.required.length && !Object.keys(r.constraints).length) { renderPanel(); await explain(); pushLog('rf', 'Explained in "Why this layout?" using the computed measurements.'); return; }

    if (r.budget) state.budget = r.budget;
    if (r.people) state.req.people = r.people;
    if (r.purpose) state.req.purpose = r.purpose;
    if (r.style && r.style.length) state.req.style = Array.from(new Set(state.req.style.concat(r.style)));
    if (r.required.length) {
      if (from === 'ask') {
        const pins = {}; state.req.required.forEach(x => { if (x.pinnedId) pins[x.category] = x.pinnedId; });
        state.req.required = r.required.map(x => ({ category: x.category, qty: x.qty || 1, hint: x.hint || null, pinnedId: pins[x.category] || null }));
      } else r.required.forEach(x => { if (!state.req.required.some(y => y.category === x.category)) state.req.required.push({ category: x.category, qty: x.qty || 1, hint: x.hint || null, pinnedId: null }); });
    }
    const c = r.constraints || {};
    if (c.avoid) { state.req.required = state.req.required.filter(x => !c.avoid.includes(x.category)); delete c.avoid; }
    Object.assign(state.constraints, c);
    Object.keys(c).forEach(k => { const m = k.match(/^(\w+?)_(max|min)_width_cm$/); if (m) state.req.required.filter(x => x.category === m[1]).forEach(x => { x.pinnedId = null; }); });
    if (c.desk_near_window) delete state.constraints.desk_avoid_window;

    if (!state.req.required.length) { pushLog('rf', 'Tell me what furniture you need, for example "a desk, chair and bookshelf".'); renderPanel(); return; }

    const hadEdits = state.edited && state.items.some(i => !i.existing);
    if (hadEdits) pushHistory();
    const L = planNow({ cheapest: r.intent === 'cheapest', prefer: r.intent === 'cheapest' ? 'cheapest' : null });
    pushLog('rf', describeResult(r, L, before) + (hadEdits ? ' This re-planned the room and replaced your manual changes. Say "undo" to get them back.' : ''));
    if (r.intent === 'explain') await explain();
  }

  function describeResult(r, L, before) {
    const okN = state.layouts.filter(l => l.ok).length, total = state.layouts.length;
    if (!L) {
      const why = state.layouts.find(l => !l.ok);
      return `✕ No layout passes every check. ${why ? why.reason : ''}`;
    }
    const parts = [];
    const desk = state.items.find(i => i.category === 'desk');
    const win = state.room.openings.find(o => o.type === 'window');
    if (r.intent === 'cheapest') {
      const others = state.layouts.filter(l => l.ok && l.id !== 'cheapest').map(l => l.metrics.total);
      parts.push(`Lowest-cost valid layout: ₹${fmt(L.metrics.total)}${others.length ? `, ₹${fmt(Math.min(...others) - L.metrics.total)} less than the next cheapest` : ''}.`);
    }
    if (r.constraints.desk_near_window && desk && win) parts.push(`The desk is now ${Math.round(RF.distRectPoint(RF.rectOf(desk), RF.openingGeom(state.room, win).mid))} cm from the window.`);
    if (r.constraints.desk_max_width_cm && desk) parts.push(`Desk is now ${desk.name}, ${desk.w} cm wide.`);
    if (r.constraints.door_keep_clear) parts.push(`A ${RF.effectiveRules(state.rules, state.constraints).doorLandingCm} cm entry zone at the door is kept free and the door opens fully.`);
    if (r.constraints.bed_avoid_window) { const bed = state.items.find(i => i.category === 'bed'); if (bed && win) parts.push(`The bed is ${Math.round(RF.distRectPoint(RF.rectOf(bed), RF.openingGeom(state.room, win).mid))} cm from the window.`); }
    if (r.constraints.wall_mount_allowed === false) parts.push('Wall-mounted pieces are excluded.');
    if (r.constraints.openness === 'high') parts.push(`Walkways are now at least ${RF.effectiveRules(state.rules, state.constraints).walkWidthCm} cm.`);
    if (r.constraints.storage_priority === 'high') parts.push(`Layout ${L.letter} has ${L.metrics.storageM3} m³ of storage.`);
    if (r.budget) parts.push(`Budget set to ₹${fmt(r.budget)}.`);
    parts.push(`${okN} of ${total} layouts pass every check. Showing Layout ${L.letter}.`);
    return parts.join(' ');
  }

  /* ---------- compare ---------- */

  function stars(n) { return `<span class="stars" aria-label="${n} of 5">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`; }
  function openCompare() {
    const grid = $('#compareGrid');
    if (!state.layouts.length) { toast('Plan some layouts first.'); return; }
    grid.innerHTML = state.layouts.map(L => {
      if (!L.ok) return `<div class="cmp-col"><div class="cmp-title"><b>${L.letter}</b><span>${esc(L.title)}</span></div><p class="cmp-fail">No valid layout. ${esc(L.reason)}</p></div>`;
      const m = L.metrics, b = L.validation.budget;
      return `<div class="cmp-col ${L.id === state.active ? 'is-on' : ''}"><div class="cmp-title"><b>${L.letter}</b><span>${esc(L.title)}</span></div>
        <svg data-mini="${L.id}" role="img" aria-label="Plan of layout ${L.letter}"></svg>
        <dl>
          <div><dt>Floor space free</dt><dd class="num">${m.floorFreePct}%</dd></div>
          <div><dt>Storage</dt><dd>${stars(m.storageStars)} <span class="num note">${m.storageM3} m³</span></dd></div>
          <div><dt>Workspace</dt><dd>${stars(m.workspaceStars)} <span class="num note">${m.deskCm} cm of desk</span></dd></div>
          <div><dt>Widest walkway</dt><dd class="num">${m.walkwayCm != null ? m.walkwayCm + ' cm' : '–'}</dd></div>
          <div><dt>Cost</dt><dd class="num">₹${fmt(m.total)}${b.budget ? (b.over > 0 ? ` <span style="color:var(--fail)">₹${fmt(b.over)} over</span>` : ` <span class="note">₹${fmt(b.remaining)} left</span>`) : ''}</dd></div>
          <div><dt>Clearance violations</dt><dd class="num">${m.violations}</dd></div>
        </dl>
        <button type="button" class="btn btn-small ${L.id === state.active ? 'btn-primary' : ''}" data-use="${L.id}">${L.id === state.active ? 'Showing' : 'Use this layout'}</button></div>`;
    }).join('');
    state.layouts.filter(l => l.ok).forEach(L => RF.Plan2D(grid.querySelector(`[data-mini="${L.id}"]`), { mini: true }).set({ room: state.room, items: L.items, validation: L.validation, zones: 'none' }));
    grid.insertAdjacentHTML('afterend', '');
    $('#dlgCompare').showModal();
  }

  /* ================= fit ================= */

  let fitPlan = null, fitMode = 'catalog';
  function renderFitForm() {
    const cats = Object.keys(RF.CATEGORY_LABELS).filter(c => RF.catalog.list().some(p => p.category === c));
    const sel = $('#fitCat');
    if (!sel.options.length) { sel.innerHTML = cats.map(c => `<option value="${c}">${RF.CATEGORY_LABELS[c]}</option>`).join(''); sel.value = 'desk'; fillFitProducts(); }
    const r = state.room, pv = r.provenance || {};
    const est = ['width', 'length'].filter(k => pv[k] === 'estimated');
    $('#fitRoom').innerHTML = r.width && r.length
      ? `<span>Checking in your room: <strong class="num">${r.width} × ${r.length} cm</strong> ${est.length ? '<span class="prov is-estimated">Estimated</span>' : '<span class="prov is-verified">Verified</span>'}</span><span class="note">${r.openings.length} openings · ${(r.existing || []).length} pieces you're keeping</span><a href="#/setup">Edit room</a>`
      : `<span class="note warn">Room size unknown. <a href="#/setup">Add the room's width and length</a> to check fit.</span>`;
    const hasDesign = state.items.some(i => !i.existing);
    $('#fitIncludeWrap').hidden = !hasDesign;
    if (!fitPlan) {
      fitPlan = RF.Plan2D($('#fitPlan'), {
        interactive: true,
        canDrag: it => state.fit && it.uid === state.fit.item.uid,
        onSelect: () => {},
        onDrag: (uid, x, y) => { if (!state.fit) return; state.fit.item.x = x; state.fit.item.y = y; checkFitCurrent(false); },
        onDrop: () => checkFitCurrent(true)
      });
      keyNudge($('#fitPlan'), () => state.fit ? [state.fit.item] : [], () => state.fit && state.fit.item.uid, () => checkFitCurrent(true));
    }
    if (state.fit) drawFit(); else { fitPlan.set({ room: r, items: fitBase(), validation: null }); $('#fitVerdict').innerHTML = `<p class="note">Choose a piece and press Check fit. ROOMFIT tries every wall position and orientation, then shows the best valid spot or the reason it fails.</p>`; }
  }
  function fillFitProducts() {
    const c = $('#fitCat').value;
    $('#fitProduct').innerHTML = RF.catalog.list().filter(p => p.category === c).map(p => `<option value="${p.id}">${esc(p.name)}: ${p.width_cm} × ${p.depth_cm} × ${p.height_cm} cm</option>`).join('');
  }
  function fitBase() {
    const include = !$('#fitIncludeWrap').hidden && $('#fitInclude').checked;
    return include ? clone(state.items) : existingItems();
  }
  function fitProto() {
    if (fitMode === 'catalog') return RF.instance(RF.catalog.get($('#fitProduct').value));
    const n = id => Math.max(0, +$(id).value || 0);
    const w = n('#fitW'), d = n('#fitD'), h = n('#fitH');
    if (!w || !d || !h) { toast('Enter width, depth and height.'); return null; }
    return RF.instance({ id: 'custom', name: $('#fitName').value || 'Custom item', category: 'other', width_cm: w, depth_cm: d, height_cm: h, price_inr: 0,
      clearance_front_cm: n('#fitFront'), door_clearance_cm: n('#fitDoor'), drawer_clearance_cm: n('#fitDrawer'), requires_wall_mount: $('#fitWall').checked, sample: false });
  }
  function runFit() {
    const r = state.room;
    if (!(r.width >= 100 && r.length >= 100)) { toast('Add the room size first.'); location.hash = '#/setup'; return; }
    const proto = fitProto(); if (!proto) return;
    const base = fitBase();
    $('#fitVerdict').innerHTML = '<p class="note">Testing positions…</p>';
    setTimeout(() => {
      const res = RF.findPlacement(r, base, proto, ctx());
      const tried = RF.candidatePositions(r, proto, { floating: true, step: 5 }).length;
      state.fit = { base, item: res.item || Object.assign(proto, { x: r.width / 2, y: r.length / 2 }), searched: true, tried, foundOk: res.ok };
      checkFitCurrent(true);
    }, 20);
  }
  function checkFitCurrent(full) {
    const f = state.fit;
    f.validation = RF.validate(state.room, f.base.concat(f.item), ctx({ computeMaxWidth: full }));
    if (full) f.fix = null;
    drawFit(full);
  }
  function drawFit(full) {
    const f = state.fit, v = f.validation, it = f.item, r = state.room;
    fitPlan.set({ room: r, items: f.base.concat(it), validation: v, selected: it.uid, zones: 'selected' });
    const mine = v.items[it.uid];
    const broken = v.violations.filter(x => x.uid !== it.uid);
    const preexisting = (f.preFails = f.preFails != null ? f.preFails : RF.validate(r, f.base, ctx({ skipCirculation: true })).violations.length);
    const ok = mine.status !== 'fail' && broken.length <= 0;
    const pv = r.provenance || {};
    const est = ['width', 'length'].filter(k => pv[k] === 'estimated');
    const ch = id => mine.checks.find(c => c.id === id);
    const rows = [];
    const push = (status, text, ra) => rows.push(`<li class="is-${status}"><span class="ic">${status === 'pass' ? '✓' : status === 'fail' ? '✕' : '–'}</span><span>${text}${ra || ''}</span></li>`);
    const inside = ch('inside'); push(inside.status, inside.status === 'pass' ? 'Fits inside room' : esc(inside.detail));
    const col = ch('collision'); push(col.status, col.status === 'pass' ? 'No collisions' : esc(col.detail));
    const door = ch('door'); if (door) push(door.status, door.status === 'pass' ? 'Door can open' : esc(door.detail));
    const land = ch('landing'); if (land) push('fail', esc(land.detail));
    const win = ch('window'); if (win) push(win.status, esc(win.detail));
    const acc = ch('access');
    if (v.circulation.status === 'unknown') push('unknown', 'Walking clearance unknown: the room has no door');
    else push(acc ? acc.status : v.circulation.status, acc && acc.status === 'fail' ? esc(acc.detail) : v.circulation.maxWidth != null ? `Walking clearance: <span class="num">${v.circulation.maxWidth} cm</span> <span class="note">(needs ${v.circulation.walkWidth})</span>` : 'Walking path from the door');
    ['front', 'side', 'back'].forEach(id => { const c = ch(id); if (c) push(c.status, `Furniture clearance (${c.label.toLowerCase()})`, `<div class="ra"><span>Required</span><span>Available</span><b>${c.required} cm</b><b>${c.available >= 300 ? '300+' : c.available} cm</b></div>`); });
    const wm = ch('wallmount'); if (wm) push(wm.status, esc(wm.detail));
    broken.slice(0, 3).forEach(b => push('fail', `${esc(b.name)}: ${esc(b.detail)}`));

    let problem = '';
    if (!ok) {
      const first = mine.checks.find(c => c.status === 'fail') || broken[0];
      problem = `<div class="problem"><strong>Problem:</strong> ${esc(first.detail)}${first.required != null ? `<div class="ra"><span>Required</span><span>Available</span><b>${first.required}${first.unit === '°' ? '°' : ' cm'}</b><b>${first.available}${first.unit === '°' ? '°' : ' cm'}</b></div>` : ''}</div>`;
      if (full && mine.status === 'fail' && !f.fix) f.fix = RF.suggestFix(r, f.base.concat(it), it.uid, ctx()) || false;
      if (f.fix) problem += `<div class="fix"><span>${esc(f.fix.text)}</span><button type="button" class="btn btn-small" data-fitfix>Move it</button></div>`;
      else if (f.foundOk === false) problem += `<p class="note">ROOMFIT tested ${fmt(f.tried)} positions and orientations; this is the closest. No position passes every check.</p>`;
    }
    $('#fitVerdict').innerHTML = `
      ${est.length ? `<p class="note warn">⚠ Room ${est.join(' and ')} estimated from image. Add one wall measurement for accurate fit checking.</p>` : ''}
      <p class="big ${ok ? 'ok' : 'bad'}">${ok ? 'FITS' : 'DOES NOT FIT'}</p>
      <p><strong>${esc(it.name)}</strong> <span class="num">${it.w} × ${it.d} × ${it.h} cm</span>${f.foundOk && f.searched ? ` <span class="note">· best of ${fmt(f.tried)} positions tested</span>` : ''}</p>
      <ul class="checks">${rows.join('')}</ul>
      ${problem}
      ${preexisting ? `<p class="note">Your room already has ${preexisting} problem(s) before adding this piece.</p>` : ''}
      ${ok && it.productId !== 'custom' ? `<div class="row gap"><button type="button" class="btn btn-small" data-fitadd>Add to my design</button></div>` : ''}`;
  }

  /* ================= delivery pathway calculator ================= */

  let deliverySource = 'design';

  function renderDelivery() {
    const desSelect = $('#delItemDesign');
    const layoutItems = (state.items || []).filter(i => !i.existing);
    if (layoutItems.length) {
      desSelect.innerHTML = layoutItems.map(i => `<option value="${i.uid}">${esc(i.name)}: ${i.w} × ${i.d} × ${i.h} cm</option>`).join('');
    } else {
      desSelect.innerHTML = `<option value="">No furniture in current layout</option>`;
      if (deliverySource === 'design') {
        deliverySource = 'catalog';
        $$('#delSourceSeg button').forEach(b => b.classList.toggle('is-on', b.dataset.v === 'catalog'));
        $('#delPaneDesign').hidden = true;
        $('#delPaneCatalog').hidden = false;
        $('#delPaneCustom').hidden = true;
      }
    }

    const catSelect = $('#delItemCatalog');
    catSelect.innerHTML = RF.catalog.list().map(p => `<option value="${p.id}">${esc(p.name)} (${RF.CATEGORY_LABELS[p.category] || p.category}): ${p.width_cm} × ${p.depth_cm} × ${p.height_cm} cm</option>`).join('');

    const roomDoors = (state.room.openings || []).filter(o => o.type === 'door');
    if (roomDoors.length) {
      $('#dpRoomW').value = roomDoors[0].width || 85;
      $('#dpRoomH').value = roomDoors[0].height || 210;
    }

    computeDelivery();
  }

  function getDeliveryItem() {
    if (deliverySource === 'design') {
      const uid = $('#delItemDesign').value;
      const it = (state.items || []).find(i => i.uid === uid);
      if (it) return { name: it.name, width_cm: it.w, depth_cm: it.d, height_cm: it.h };
    }
    if (deliverySource === 'catalog') {
      const pid = $('#delItemCatalog').value;
      const p = RF.catalog.get(pid);
      if (p) return { name: p.name, width_cm: p.width_cm, depth_cm: p.depth_cm, height_cm: p.height_cm };
    }
    const n = id => Math.max(1, +$(id).value || 1);
    return {
      name: $('#delCustomName').value.trim() || 'Custom Piece',
      width_cm: n('#delCustomW'),
      depth_cm: n('#delCustomD'),
      height_cm: n('#delCustomH')
    };
  }

  function getDeliveryPathConfig() {
    const num = (id, def) => Math.max(10, +$(id).value || def);
    return {
      buildingEntry: {
        label: 'Building Entrance',
        width: num('#dpBldW', 95),
        height: num('#dpBldH', 215)
      },
      lift: {
        label: 'Elevator / Lift',
        doorWidth: num('#dpLiftDoorW', 80),
        doorHeight: num('#dpLiftDoorH', 205),
        carWidth: num('#dpLiftCarW', 110),
        carDepth: num('#dpLiftCarD', 130),
        ceilingHeight: num('#dpLiftCeilH', 220),
        available: $('#dpLiftAvail').checked
      },
      stairs: {
        label: 'Staircase & Landing',
        flightWidth: num('#dpStairW', 95),
        landingWidth: num('#dpLandW', 120),
        landingDepth: num('#dpLandD', 120),
        ceilingHeight: num('#dpStairCeil', 220)
      },
      frontDoor: {
        label: 'Apartment Front Door',
        width: num('#dpFrontW', 85),
        height: num('#dpFrontH', 205)
      },
      roomDoor: {
        label: 'Room Doorway',
        width: num('#dpRoomW', 85),
        height: num('#dpRoomH', 210)
      }
    };
  }

  function computeDelivery() {
    const item = getDeliveryItem();
    if (!item || !item.width_cm) {
      $('#deliveryResults').innerHTML = `<p class="note">Select or enter a furniture piece to calculate delivery passability.</p>`;
      return;
    }

    $('#delCurDims').innerHTML = `Dimensions: <strong class="num">${item.width_cm} W × ${item.depth_cm} D × ${item.height_cm} H cm</strong> · Volume: <span class="num">${((item.width_cm * item.depth_cm * item.height_cm) / 1000000).toFixed(2)} m³</span>`;

    const config = getDeliveryPathConfig();
    const res = RF.delivery.checkDelivery(item, config);

    const verdictLabel = res.overall === 'pass' ? 'CLEAR ROUTE: FITS' : res.overall === 'tight' ? 'TIGHT FIT: REQUIRES PIVOT' : 'DELIVERY BLOCKED';
    const verdictCls = res.overall === 'pass' ? 'is-pass' : res.overall === 'tight' ? 'is-tight' : 'is-fail';

    let html = `
      <div class="del-verdict-card ${verdictCls}">
        <div class="del-verdict-title">
          <h3>${esc(item.name)}</h3>
          <span class="del-badge ${verdictCls}">${verdictLabel}</span>
        </div>
        <p><strong>${esc(res.summary)}</strong></p>
      </div>

      <div class="del-checklist-card">
        <h4 style="margin: 0 0 12px; font-size: 15px;">Route Checkpoint Breakdown</h4>
        <ul class="del-checklist">
    `;

    for (const c of res.checks) {
      const st = c.result.status;
      const badgeCls = st === 'pass' ? 'is-pass' : st === 'tight' ? 'is-tight' : 'is-fail';
      const marginText = st === 'skipped' ? 'N/A' : (c.result.marginCm >= 0 ? `+${c.result.marginCm} cm buffer` : `${c.result.marginCm} cm deficit`);
      html += `
        <li class="del-step-card">
          <span class="del-step-icon" aria-hidden="true">${c.icon}</span>
          <div class="del-step-info">
            <strong>${esc(c.name)}: <span class="num">${c.result.orientation}</span></strong>
            <p>${esc(c.result.note)}</p>
          </div>
          <span class="del-step-margin ${badgeCls}">${marginText}</span>
        </li>
      `;
    }

    html += `</ul></div>`;

    if (res.tips.length) {
      html += `
        <div class="del-tip-box">
          <h4>💡 Moving &amp; Delivery Recommendations</h4>
          <ul>
            ${res.tips.map(t => `<li>${esc(t)}</li>`).join('')}
          </ul>
        </div>
      `;
    }

    $('#deliveryResults').innerHTML = html;
  }

  /* ================= export & print report ================= */

  function openExport() {
    $('#dlgExport').showModal();
  }

  function downloadSvgPlan() {
    const div = document.createElement('div');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    div.appendChild(svg);
    const plan = RF.Plan2D(svg, { interactive: false });
    const v = RF.validate(state.room, state.items, ctx());
    plan.set({ room: state.room, items: state.items, validation: v, zones: 'none' });

    const svgData = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `RoomFit_FloorPlan_${state.room.width}x${state.room.length}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Floor plan SVG downloaded.');
    $('#dlgExport').close();
  }

  function printSpecSheet() {
    const r = state.room;
    const v = RF.validate(r, state.items, ctx());
    const areaSqM = ((r.width * r.length) / 10000).toFixed(1);
    const areaSqFt = (areaSqM * 10.7639).toFixed(1);
    const totalSpent = state.items.reduce((s, i) => s + (i.price || 0), 0);

    const div = document.createElement('div');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    div.appendChild(svg);
    const plan = RF.Plan2D(svg, { interactive: false });
    plan.set({ room: r, items: state.items, validation: v, zones: 'none' });
    const planSvgHtml = svg.outerHTML;

    const itemsTable = state.items.map(it => {
      const rec = v.items[it.uid];
      const ok = rec && rec.status === 'pass';
      return `
        <tr>
          <td><strong>${esc(it.name)}</strong></td>
          <td>${RF.CATEGORY_LABELS[it.category] || it.category}</td>
          <td class="num">${it.w} × ${it.d} × ${it.h} cm</td>
          <td class="num">${Math.round(it.x)}, ${Math.round(it.y)} (Facing ${it.facing})</td>
          <td class="num">${it.price ? '₹' + fmt(it.price) : '—'}</td>
          <td class="${ok ? 'print-badge-ok' : 'print-badge-fail'}">${ok ? 'VERIFIED PASS' : 'FLAGGED'}</td>
        </tr>
      `;
    }).join('');

    $('#printSheet').innerHTML = `
      <div class="print-head">
        <div>
          <h1>ROOMFIT Floor Plan &amp; Verification Report</h1>
          <p>Deterministic Spatial Geometry &amp; Architectural Clearance Audit</p>
        </div>
        <span>Generated: ${new Date().toLocaleDateString()}</span>
      </div>

      <div class="print-metrics">
        <div><span>Room Dimensions</span><strong>${r.width} × ${r.length} × ${r.height || 280} cm</strong></div>
        <div><span>Total Floor Area</span><strong>${areaSqM} m² (${areaSqFt} sq.ft)</strong></div>
        <div><span>Furniture Count</span><strong>${state.items.length} pieces</strong></div>
        <div><span>Total Budget Spend</span><strong>₹${fmt(totalSpent)}</strong></div>
      </div>

      <div class="print-plan-box">
        ${planSvgHtml}
      </div>

      <h3>Itemized Furniture Schedule &amp; Clearances</h3>
      <table class="print-table">
        <thead>
          <tr>
            <th>Item</th><th>Category</th><th>Dimensions (W×D×H)</th><th>Placement (X,Y)</th><th>Price</th><th>Geometry Fit</th>
          </tr>
        </thead>
        <tbody>
          ${itemsTable || '<tr><td colspan="6">No furniture placed</td></tr>'}
        </tbody>
      </table>

      <div class="print-foot">
        <span>ROOMFIT Geometry Engine · Deterministic Verification</span>
        <span>Clearance Rules: Walkway ${state.rules.walkWidthCm || 60} cm · Landing ${state.rules.doorLandingCm || 90} cm</span>
      </div>
    `;

    $('#dlgExport').close();
    window.print();
  }

  /* ================= share / save / settings ================= */

  function b64enc(s) { return btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64dec(s) { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); }
  function share() {
    const payload = { v: 1, room: state.room, req: state.req, constraints: state.constraints, rules: state.rules, budget: state.budget, items: state.items, active: state.active };
    const url = location.href.split('#')[0] + '#/design?p=' + b64enc(JSON.stringify(payload));
    const done = () => toast('Link copied. It contains this room and layout, never photos.');
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('Copy this link', url));
    else prompt('Copy this link', url);
  }
  function sanitizeProject(j) {
    const n = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : d;
    const r = j.room || {};
    const room = { width: n(r.width, 100, 2000, 320), length: n(r.length, 100, 2000, 410), height: n(r.height, 180, 600, 280), type: String(r.type || 'other').slice(0, 20),
      provenance: r.provenance || {}, openings: (r.openings || []).slice(0, 12).filter(o => ['door', 'window'].includes(o.type) && ['N', 'E', 'S', 'W'].includes(o.wall)).map(o => ({ id: String(o.id || RF.uid()).slice(0, 20), type: o.type, label: o.type === 'door' ? 'the door' : 'the window', wall: o.wall, offset: n(o.offset, 0, 2000, 0), width: n(o.width, 20, 500, 90), hinge: o.hinge === 'end' ? 'end' : 'start', swing: ['in', 'out', 'slide'].includes(o.swing) ? o.swing : 'in', sill: n(o.sill, 0, 300, 90), height: n(o.height, 50, 400, 120) })),
      obstacles: (r.obstacles || []).slice(0, 20).map(o => ({ id: String(o.id || RF.uid()).slice(0, 20), label: String(o.label || 'Fixed object').slice(0, 40), x: n(o.x, 0, 2000, 0), y: n(o.y, 0, 2000, 0), w: n(o.w, 1, 2000, 30), d: n(o.d, 1, 2000, 30), h: n(o.h, 1, 600, 100) })),
      existing: (r.existing || []).slice(0, 20).map(e => ({ uid: String(e.uid || RF.uid()).slice(0, 24), name: String(e.name || 'Existing').slice(0, 60), category: RF.CATEGORY_LABELS[e.category] ? e.category : 'other', w: n(e.w, 1, 600, 60), d: n(e.d, 1, 600, 60), h: n(e.h, 1, 400, 80), x: n(e.x, 0, 2000, 50), y: n(e.y, 0, 2000, 50), facing: ['N', 'E', 'S', 'W'].includes(e.facing) ? e.facing : 'S', estimated: !!e.estimated })),
      connections: r.connections || [] };
    const items = (j.items || []).slice(0, 40).map(i => Object.assign({}, i, { name: String(i.name || 'Item').slice(0, 60), category: RF.CATEGORY_LABELS[i.category] ? i.category : 'other', w: n(i.w, 1, 600, 60), d: n(i.d, 1, 600, 60), h: n(i.h, 1, 400, 80), x: n(i.x, -500, 2500, 50), y: n(i.y, -500, 2500, 50), elev: n(i.elev, 0, 300, 0), price: n(i.price, 0, 1e8, 0), facing: ['N', 'E', 'S', 'W'].includes(i.facing) ? i.facing : 'S', front: n(i.front, 0, 300, 0), side: n(i.side, 0, 300, 0), door: n(i.door, 0, 300, 0), drawer: n(i.drawer, 0, 300, 0), back: n(i.back, 0, 300, 0), uid: String(i.uid || RF.uid()).slice(0, 24), tags: Array.isArray(i.tags) ? i.tags.map(String) : [], style: Array.isArray(i.style) ? i.style.map(String) : [] }));
    const req = { required: ((j.req && j.req.required) || []).filter(x => RF.CATEGORY_LABELS[x.category]).slice(0, 15).map(x => ({ category: x.category, qty: n(x.qty, 1, 6, 1), hint: x.hint ? String(x.hint).slice(0, 20) : null, pinnedId: RF.catalog.get(x.pinnedId) ? x.pinnedId : null })), style: ((j.req && j.req.style) || []).map(String).slice(0, 6), people: null, purpose: null };
    return { room, items, req, constraints: typeof j.constraints === 'object' && j.constraints ? j.constraints : {}, rules: typeof j.rules === 'object' && j.rules ? j.rules : {}, budget: n(j.budget, 0, 1e9, null), active: typeof j.active === 'string' ? j.active : null };
  }
  function openShared(p) {
    try {
      const s = sanitizeProject(JSON.parse(b64dec(p)));
      Object.assign(state, s, { layouts: [], edited: true, selected: null, why: null });
      roomSig = '';
      planNow({ keepItems: true });
      toast('Opened a shared design.');
    } catch (e) { toast('That share link is damaged and could not be opened.'); }
  }

  function deleteAll() {
    if (!confirm('Delete every ROOMFIT room, design and setting saved in this browser? This cannot be undone.')) return;
    try { Object.keys(localStorage).filter(k => k.startsWith('rf.')).forEach(k => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
    photos = [];
    Object.assign(state, { room: sampleRoom(), req: { required: [], style: [], people: null, purpose: null }, constraints: {}, rules: {}, budget: null, layouts: [], active: null, items: [], edited: false, selected: null, log: [], understood: [], why: null, fit: null });
    roomSig = '';
    $('#dlgSettings').close();
    toast('All ROOMFIT data deleted from this browser.');
    route();
  }

  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('rf.theme', next); } catch (e) { /* ignore */ }
    if (view3d) view3d.retheme();
  }

  /* ================= wiring ================= */

  function bind() {
    window.addEventListener('hashchange', route);
    window.addEventListener('resize', () => { if (document.body.dataset.view === 'landing') measureTitle(); });
    $('#btnTheme').addEventListener('click', toggleTheme);
    $('#btnShare').addEventListener('click', share);
    $('#btnSave').addEventListener('click', () => {
      try {
        const list = JSON.parse(localStorage.getItem('rf.designs') || '[]');
        list.unshift({ at: new Date().toISOString(), room: state.room, req: state.req, constraints: state.constraints, budget: state.budget, items: state.items });
        localStorage.setItem('rf.designs', JSON.stringify(list.slice(0, 10)));
        save(); toast('Saved in this browser.');
      } catch (e) { toast('This browser blocked saving. Use Share to keep a link instead.'); }
    });
    $('#btnSettings').addEventListener('click', () => { $('#proxyUrl').value = RF.ai.proxyUrl(); $('#proxyStatus').textContent = ''; $('#dlgSettings').showModal(); });
    $$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
    $('#btnProxySave').addEventListener('click', async () => {
      RF.ai.setProxyUrl($('#proxyUrl').value.trim());
      if (!RF.ai.proxyUrl()) { $('#proxyStatus').textContent = 'Proxy removed. Using the built-in parser.'; renderPanel(); renderPhotos(); return; }
      $('#proxyStatus').textContent = 'Testing…';
      $('#proxyStatus').textContent = (await RF.ai.ping()) ? '✓ Connected' : '✕ No response. Is the proxy running?';
      renderPanel(); renderPhotos();
    });
    $('#btnDeleteAll').addEventListener('click', deleteAll);

    // setup
    const dim = (id, key) => $(id).addEventListener('input', e => { state.room[key] = e.target.value === '' ? null : +e.target.value; provSet(key, e.target.value === '' ? 'unknown' : 'verified'); roomChanged(); });
    dim('#dimW', 'width'); dim('#dimL', 'length'); dim('#dimH', 'height');
    $('#roomType').addEventListener('change', e => { state.room.type = e.target.value; save(); });
    bindRows('#openingsList', () => state.room.openings, renderOpenings);
    bindRows('#obstaclesList', () => state.room.obstacles, renderObstacles);
    bindRows('#existingList', () => state.room.existing, renderExisting);
    $('#btnAddDoor').addEventListener('click', () => { state.room.openings.push({ id: RF.uid(), type: 'door', label: 'the door', wall: 'S', offset: 20, width: 85, hinge: 'start', swing: 'in', height: 210 }); renderOpenings(); roomChanged(); });
    $('#btnAddWindow').addEventListener('click', () => { state.room.openings.push({ id: RF.uid(), type: 'window', label: 'the window', wall: 'N', offset: 60, width: 120, sill: 90, height: 120 }); renderOpenings(); roomChanged(); });
    $('#btnAddObstacle').addEventListener('click', () => { state.room.obstacles.push({ id: RF.uid(), label: 'Pillar', x: 0, y: 0, w: 30, d: 30, h: 280 }); renderObstacles(); roomChanged(); });
    $('#btnAddExisting').addEventListener('click', () => { state.room.existing.push({ uid: RF.uid(), name: 'Bed (existing)', category: 'bed', w: 150, d: 200, h: 90, x: 75, y: 100, facing: 'S' }); renderExisting(); roomChanged(); });
    $('#btnSampleRoom').addEventListener('click', () => { state.room = sampleRoom(); renderSetup(); roomChanged(); toast('Sample room loaded: 320 × 410 cm.'); });
    $('#presetChips').addEventListener('click', e => {
      const chip = e.target.closest('[data-preset]');
      if (!chip) return;
      const p = ROOM_PRESETS[chip.dataset.preset];
      if (p) {
        state.room = clone(p);
        renderSetup();
        roomChanged();
        toast(`Loaded ${p.type} preset: ${p.width} × ${p.length} cm.`);
      }
    });
    $('#btnToDesign').addEventListener('click', e => { if (!(state.room.width >= 100 && state.room.length >= 100)) { e.preventDefault(); toast('Add the room width and length first.'); } });
    $('#photoInput').addEventListener('change', e => {
      const files = Array.from(e.target.files || []).slice(0, 4);
      Promise.all(files.map(f => new Promise(res => { const fr = new FileReader(); fr.onload = () => res({ mime: f.type, url: fr.result, data: String(fr.result).split(',')[1] }); fr.readAsDataURL(f); })))
        .then(list => { photos = photos.concat(list).slice(0, 4); renderPhotos(); });
      e.target.value = '';
    });
    $('#btnClearPhotos').addEventListener('click', () => { photos = []; renderPhotos(); toast('Photos removed from this tab.'); });
    $('#btnAnalyze').addEventListener('click', analyzePhotos);
    $('#btnRescale').addEventListener('click', rescale);

    // design panel
    $('#askForm').addEventListener('submit', e => { e.preventDefault(); handleText($('#reqText').value, 'ask'); });
    $('#reqText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleText($('#reqText').value, 'ask'); } });
    $('#cmdForm').addEventListener('submit', e => { e.preventDefault(); const v = $('#cmdInput').value; $('#cmdInput').value = ''; handleText(v, 'cmd'); });
    $('#reqList').addEventListener('change', e => {
      const row = e.target.closest('[data-i]'); if (!row) return;
      const r = state.req.required[+row.dataset.i];
      if (e.target.dataset.k === 'qty') r.qty = Math.max(1, Math.min(6, +e.target.value || 1));
      if (e.target.dataset.k === 'pinnedId') r.pinnedId = e.target.value || null;
      schedulePlan();
    });
    $('#reqList').addEventListener('click', e => { if (!e.target.closest('[data-remove]')) return; state.req.required.splice(+e.target.closest('[data-i]').dataset.i, 1); renderPanel(); schedulePlan(); });
    $('#btnReqAdd').addEventListener('click', () => { state.req.required.push({ category: $('#reqAddCat').value, qty: 1, hint: null, pinnedId: null }); renderPanel(); schedulePlan(); });
    $('#budget').addEventListener('change', e => { state.budget = +e.target.value > 0 ? +e.target.value : null; schedulePlan(); });
    $('#styleChips').addEventListener('click', e => { const b = e.target.closest('[data-style]'); if (!b) return; const s = b.dataset.style; state.req.style = state.req.style.includes(s) ? state.req.style.filter(x => x !== s) : state.req.style.concat(s); renderPanel(); schedulePlan(); });
    $$('.seg[data-pref]').forEach(seg => seg.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.constraints[seg.dataset.pref] = b.dataset.v; renderPanel(); schedulePlan(); }));
    const tog = (id, fn) => $(id).addEventListener('change', e => { fn(e.target.checked); schedulePlan(); });
    tog('#cAccess', v => { state.constraints.accessibility = v; });
    tog('#cWallMount', v => { state.constraints.wall_mount_allowed = v ? false : true; });
    tog('#cDoor', v => { state.constraints.door_keep_clear = v; });
    tog('#cOpen', v => { state.constraints.openness = v ? 'high' : 'normal'; });
    tog('#cBedWin', v => { state.constraints.bed_avoid_window = v; });
    const rng = (id, key, out, unit) => $(id).addEventListener('input', e => { state.rules[key] = +e.target.value; $(out).textContent = e.target.value + unit; revalidate(true); schedulePlan(); });
    rng('#rWalk', 'walkWidthCm', '#rWalkV', ' cm'); rng('#rLand', 'doorLandingCm', '#rLandV', ' cm'); rng('#rDoor', 'doorOpenAngleDeg', '#rDoorV', '°');
    $('#btnRulesReset').addEventListener('click', () => { state.rules = {}; renderPanel(); schedulePlan(); });
    $('#catSearch').addEventListener('input', renderCatalog);
    $('#catList').addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b) addProduct(RF.catalog.get(b.dataset.add)); });

    // custom piece builder
    $('#btnAddCustomItem').addEventListener('click', () => {
      $('#customForm').reset();
      $('#dlgCustomFurniture').showModal();
    });
    $('#customForm').addEventListener('submit', e => {
      e.preventDefault();
      const name = $('#cfName').value.trim() || 'Custom Piece';
      const cat = $('#cfCategory').value;
      const w = +$('#cfW').value;
      const d = +$('#cfD').value;
      const h = +$('#cfH').value;
      const front = +$('#cfFront').value || 0;
      const door = +$('#cfDoor').value || 0;
      const side = +$('#cfSide').value || 0;
      const price = +$('#cfPrice').value || 0;
      const wall = $('#cfWall').checked;

      const newItem = RF.catalog.addCustom({
        name, category: cat,
        width_cm: w, depth_cm: d, height_cm: h,
        clearance_front_cm: front,
        door_clearance_cm: door,
        clearance_side_cm: side,
        price_inr: price,
        requires_wall_mount: wall
      });
      $('#dlgCustomFurniture').close();
      renderCatalog();
      toast(`Custom piece "${name}" saved to catalog.`);
      if (document.body.dataset.view === 'design') addProduct(newItem);
    });

    // export modal
    $('#btnExport').addEventListener('click', openExport);
    $('#btnExportPlan').addEventListener('click', openExport);
    $('#btnPrintReport').addEventListener('click', printSpecSheet);
    $('#btnDownloadSvg').addEventListener('click', downloadSvgPlan);

    // delivery controls
    $$('#delSourceSeg button').forEach(btn => {
      btn.addEventListener('click', () => {
        deliverySource = btn.dataset.v;
        $$('#delSourceSeg button').forEach(b => b.classList.toggle('is-on', b === btn));
        $('#delPaneDesign').hidden = deliverySource !== 'design';
        $('#delPaneCatalog').hidden = deliverySource !== 'catalog';
        $('#delPaneCustom').hidden = deliverySource !== 'custom';
        computeDelivery();
      });
    });
    $('#delItemDesign').addEventListener('change', computeDelivery);
    $('#delItemCatalog').addEventListener('change', computeDelivery);
    ['#delCustomName', '#delCustomW', '#delCustomD', '#delCustomH'].forEach(id => {
      $(id).addEventListener('input', computeDelivery);
    });
    ['#dpBldW', '#dpBldH', '#dpLiftAvail', '#dpLiftDoorW', '#dpLiftDoorH', '#dpLiftCarW', '#dpLiftCarD', '#dpLiftCeilH',
     '#dpStairW', '#dpLandW', '#dpLandD', '#dpStairCeil', '#dpFrontW', '#dpFrontH', '#dpRoomW', '#dpRoomH'].forEach(id => {
      const el = $(id);
      if (el) {
        el.addEventListener('input', computeDelivery);
        el.addEventListener('change', computeDelivery);
      }
    });

    // stage
    $('#layoutTabs').addEventListener('click', e => { const b = e.target.closest('[data-layout]'); if (b) activate(b.dataset.layout); });
    $('#viewSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || !view3d) return; view3d.setView(b.dataset.v); $$('#viewSeg button').forEach(x => x.classList.toggle('is-on', x === b)); });
    $('#zoneSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.zones = b.dataset.v; $$('#zoneSeg button').forEach(x => x.classList.toggle('is-on', x === b)); renderStage(); });
    $('#btnCompare').addEventListener('click', openCompare);
    $('#compareGrid').addEventListener('click', e => { const b = e.target.closest('[data-use]'); if (b) { activate(b.dataset.use); $('#dlgCompare').close(); } });

    // dock
    // editable measurements: live re-check while typing, one undo step per field edit
    const dockEl = document.querySelector('.dock');
    dockEl.addEventListener('focusin', e => { if (e.target.closest('[data-dim]')) pushHistory(); });
    dockEl.addEventListener('input', e => {
      const inp = e.target.closest('[data-dim]'); if (!inp) return;
      const it = state.items.find(i => i.uid === state.selected);
      const v = +inp.value;
      if (!it || inp.value === '' || !isFinite(v) || (inp.dataset.dim !== 'front' && v <= 0)) return;
      applyDims(it, { [inp.dataset.dim]: v });
    });
    dockEl.addEventListener('change', e => { if (e.target.closest('[data-dim]')) { const it = state.items.find(i => i.uid === state.selected); if (it) pushLog('rf', 'Measurements updated. ' + itemReport(it)); } });
    dockEl.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('[data-dim]')) e.target.blur(); });
    document.querySelector('.dock').addEventListener('click', e => {
      const t = e.target.closest('button'); if (!t) return;
      const it = state.items.find(i => i.uid === state.selected);
      const act = t.dataset.act;
      if (act === 'rotate' && it) { rotateItem(state.items, it.uid); markEdited(); revalidate(true); save(); }
      else if (act === 'remove' && it) removeSelected();
      else if (act === 'swap' && it) computeSwap(it);
      else if (act === 'applyfix' && it && state.fix) { moveItem(state.items, it.uid, state.fix.x, state.fix.y); markEdited(); revalidate(true); save(); }
      else if (act === 'why') explain();
      else if (act === 'confirmpreview') confirmPreview();
      else if (act === 'cancelpreview') cancelPreview();
      else if (act === 'placeanyway' && state.pendingFit) { const pf = state.pendingFit; state.items.push(pf.res.item || Object.assign(pf.proto, { x: state.room.width / 2, y: state.room.length / 2 })); state.selected = (pf.res.item || pf.proto).uid; state.pendingFit = null; markEdited(); revalidate(true); }
      else if (act === 'cancelfit') { state.pendingFit = null; renderDock(); }
      else if (t.dataset.addp) addProduct(RF.catalog.get(t.dataset.addp));
      else if (t.dataset.swap != null && state.swap) applySwap(state.swap.options[+t.dataset.swap]);
      else if (t.dataset.alt != null && state.alts) {
        const a = state.alts[+t.dataset.alt];
        const i = state.items.findIndex(x => x.uid === a.uid);
        state.items[i] = Object.assign({}, state.items[i], productFields(a.to));
        const r = state.req.required.find(x => x.category === a.to.category); if (r) r.pinnedId = a.to.id;
        pushLog('rf', `Swapped ${a.from.name} for ${a.to.name}, saving ₹${fmt(a.save)}. Still passes every check.`);
        markEdited(); revalidate(true); renderPanel(); save();
      }
    });
    document.addEventListener('keydown', e => {
      if (document.body.dataset.view !== 'design' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.querySelector('dialog[open]')) return;
      const it = state.items.find(i => i.uid === state.selected);
      if (e.key === 'Escape') { select(null); return; }
      if (!it || it.locked) return;
      const step = e.shiftKey ? 10 : 1;
      const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (k) { moveItem(state.items, it.uid, it.x + k[0], it.y + k[1]); markEdited(); revalidate(true); save(); e.preventDefault(); }
      else if (e.key === 'r' || e.key === 'R') { rotateItem(state.items, it.uid); markEdited(); revalidate(true); save(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { removeSelected(); e.preventDefault(); }
    });

    // fit
    $('#fitMode').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; fitMode = b.dataset.v === 'image' ? fitMode : b.dataset.v; $$('#fitMode button').forEach(x => x.classList.toggle('is-on', x === b)); $$('.fit-pane').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.v; }); if (b.dataset.v === 'image') fitMode = 'dims'; });
    $('#fitCat').addEventListener('change', fillFitProducts);
    $('#fitForm').addEventListener('submit', e => { e.preventDefault(); runFit(); });
    $('#fitVerdict').addEventListener('click', e => {
      if (e.target.closest('[data-fitfix]') && state.fit.fix) { state.fit.item.x = state.fit.fix.x; state.fit.item.y = state.fit.fix.y; checkFitCurrent(true); }
      if (e.target.closest('[data-fitadd]')) {
        const it = Object.assign({}, state.fit.item);
        if (!$('#fitIncludeWrap').hidden && $('#fitInclude').checked) state.items = state.fit.base.concat(it);
        else state.items.push(it);
        const r = state.req.required.find(x => x.category === it.category);
        if (!r && it.category !== 'other') state.req.required.push({ category: it.category, qty: 1, hint: null, pinnedId: it.productId });
        markEdited(); state.selected = it.uid; save();
        location.hash = '#/design';
      }
    });
    $('#fitImage').addEventListener('change', async e => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      const note = $('#fitImageNote');
      if (!RF.ai.proxyUrl()) { note.textContent = 'Reading dimensions from an image needs the Gemini proxy (Settings). Enter the dimensions instead.'; return; }
      note.textContent = 'Reading the printed dimensions…';
      const data = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(f); });
      try {
        const s = await RF.ai.run('readSpec', { mime: f.type, data });
        if (!s.w || !s.d || !s.h) { note.textContent = 'No complete set of printed dimensions found. Enter them from the product listing.'; return; }
        $('#fitW').value = s.w; $('#fitD').value = s.d; $('#fitH').value = s.h; if (s.name) $('#fitName').value = s.name;
        fitMode = 'dims';
        $$('#fitMode button').forEach(x => x.classList.toggle('is-on', x.dataset.v === 'dims'));
        $$('.fit-pane').forEach(p => { p.hidden = p.dataset.pane !== 'dims'; });
        toast('Dimensions read from the image. Check them against the listing.');
      } catch (err) { note.textContent = err.message; }
      e.target.value = '';
    });
  }

  function removeSelected() {
    const it = state.items.find(i => i.uid === state.selected);
    if (!it || it.locked) return;
    const pairs = state.items.filter(i => i.pairedWith === it.uid);
    state.items = state.items.filter(i => i.uid !== it.uid && i.pairedWith !== it.uid);
    pushLog('rf', `Removed ${it.name}${pairs.length ? ' and its ' + pairs.map(p => p.name).join(', ') : ''}.`);
    state.selected = null; markEdited(); revalidate(true); save();
  }

  /* ================= product placement (AI Shop) ================= */

  /** Put a real product into the room as a translucent preview. item uses the listing's dimensions. */
  function placeProduct(item, opts) {
    opts = opts || {};
    cancelPreview(true);
    const replaced = [], pairs = [];
    const it = Object.assign({}, item, { uid: RF.uid(), preview: !opts.commit, locked: false, existing: false });
    if (it.x == null || isNaN(it.x)) { it.x = state.room.width / 2; it.y = state.room.length / 2; }
    if (opts.replaceUid) {
      state.items.filter(i => i.uid === opts.replaceUid).forEach(i => replaced.push(i));
      state.items = state.items.filter(i => !replaced.includes(i));
      // a desk's chair stays and is re-paired to the new desk
      state.items.filter(i => i.pairedWith === opts.replaceUid).forEach(c => {
        pairs.push(clone(c));
        if (it.category === 'desk') Object.assign(c, RF.companionFor(it, c, RF.effectiveRules(state.rules, state.constraints)), { uid: c.uid, pairedWith: it.uid });
        else c.pairedWith = null;
      });
    }
    state.items.push(it);
    state.previewReplaced = opts.commit ? null : replaced;
    state.previewPairs = opts.commit ? null : pairs;
    state.selected = it.uid; state.pendingFit = null; state.swap = null;
    markEdited();
    if (opts.commit) pushLog('rf', `Placed ${it.name}${replaced.length ? ` in place of ${replaced[0].name}` : ''}.`);
    if (document.body.dataset.view !== 'design') location.hash = '#/design';
    revalidate(true); save();
    return it.uid;
  }
  function confirmPreview() {
    const it = state.items.find(i => i.preview);
    if (!it) return;
    delete it.preview;
    const was = state.previewReplaced && state.previewReplaced[0];
    state.previewReplaced = null;
    const v = RF.validate(state.room, state.items, ctx());
    pushLog('rf', `Placed ${it.name}${was ? ` in place of ${was.name}` : ''}. ${v.items[it.uid] && v.items[it.uid].status === 'fail' ? '✕ It still fails a check; see the selected panel.' : '✓ Passes every check.'}`);
    revalidate(true); save();
  }
  function cancelPreview(silent) {
    const it = state.items.find(i => i.preview);
    if (!it) return;
    const restore = state.previewPairs || [];
    state.items = state.items.filter(i => !i.preview).map(i => restore.find(p => p.uid === i.uid) || i).concat(state.previewReplaced || []);
    state.previewReplaced = null; state.previewPairs = null;
    if (state.selected === it.uid) state.selected = null;
    if (!silent) { pushLog('rf', `Cancelled placing ${it.name}.`); revalidate(true); save(); }
  }

  RF.app = {
    get state() { return state; },
    ctx,
    selected: () => state.items.find(i => i.uid === state.selected) || null,
    placeProduct, confirmPreview, cancelPreview,
    chat: text => handleText(text, 'cmd'), applyDims, undo,
    setBudget(b) { state.budget = b; renderPanel(); revalidate(true); save(); },
    toast
  };

  /* ================= boot ================= */

  function boot() {
    const saved = load();
    if (saved) {
      try { Object.assign(state, sanitizeProject(saved), { edited: !!saved.edited }); } catch (e) { /* start fresh */ }
    }
    if (!state.items.length) state.items = existingItems();
    bind();
    // demo shortcut under the requirement box
    const demo = document.createElement('button');
    demo.type = 'button'; demo.className = 'btn-quiet btn-small'; demo.textContent = 'Try: study + gaming room under ₹70,000';
    demo.addEventListener('click', () => { $('#reqText').value = 'I need a study + gaming room under ₹70,000'; handleText($('#reqText').value, 'ask'); });
    $('#askForm').appendChild(demo);
    if (state.req.required.length) {
      // regenerate layouts on load; keep any edited arrangement the user saved
      const keep = state.edited ? clone(state.items) : null;
      state.layouts = RF.generateLayouts(state.room, state.req, ctx(), { base: existingItems() });
      if (keep) state.items = keep;
      else { const L = state.layouts.find(l => l.id === state.active && l.ok) || state.layouts.find(l => l.ok); if (L) { state.active = L.id; state.items = clone(L.items); } }
      roomSig = '';
    }
    route();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window.RF = window.RF || {});
