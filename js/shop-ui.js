/* ROOMFIT AI Shop panel — a contextual layer over the 3D workspace. Every verdict shown comes from RF.shop / RF.validate. */
(function (RF) {
  'use strict';

  const $ = s => document.querySelector(s);
  const esc = RF.esc, fmt = RF.fmt;
  const STATUS = {
    fits: { ic: '✓', text: 'Fits your room', cls: 'fits' },
    does_not_fit: { ic: '×', text: 'Does not fit', cls: 'nofit' },
    unknown: { ic: '?', text: 'Cannot verify', cls: 'unknown' },
    partial: { ic: '!', text: 'Some dimensions could not be verified', cls: 'partial' }
  };
  const STEPS = { understand: 'Understanding your request', space: 'Measuring your space', search: 'Searching products', dims: 'Checking dimensions', fit: 'Validating fit' };

  const S = { request: null, items: [], meta: null, area: null, open: null, hover: null, enter: null, filters: {}, steps: [], busy: false, room: null, optimize: null };

  function env(extra) {
    const app = RF.app, st = app.state, c = app.ctx();
    return Object.assign({ room: st.room, items: st.items.filter(i => !i.preview), rules: c.rules, constraints: c.constraints, selected: app.selected(), purpose: st.req.purpose }, extra || {});
  }
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(iso).toLocaleDateString();
  }
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  const dimsText = d => d && d.widthCm && d.depthCm ? `${d.widthCm} × ${d.depthCm} × ${d.heightCm || '?'} cm` : null;
  const usable = p => p.dimensionsVerified || p.dimensionsSource === 'user' || p.dimensionsSource === 'sample';

  /* ---------- panel open/close ---------- */

  function openPanel(tab) {
    $('#shopPanel').hidden = false;
    $('#btnFind').setAttribute('aria-expanded', 'true');
    if (tab) setTab(tab);
    const sel = RF.app.selected();
    const where = $('#shopWhere');
    where.querySelector('[value="replace"]').disabled = !sel || sel.existing;
    where.querySelector('[value="replace"]').textContent = sel && !sel.existing ? `Replace the ${sel.name}` : 'Replace the selected piece (select one first)';
    if (S.budgetSync !== RF.app.state.budget) { $('#shopBudget').value = RF.app.state.budget || ''; S.budgetSync = RF.app.state.budget; }
    $('#shopQuery').focus();
  }
  function closePanel() {
    $('#shopPanel').hidden = true;
    $('#btnFind').setAttribute('aria-expanded', 'false');
    $('#btnFind').textContent = S.items.length ? `Find furniture (${S.items.length})` : 'Find furniture';
  }
  function setTab(v) {
    document.querySelectorAll('#shopTabs button').forEach(b => b.classList.toggle('is-on', b.dataset.v === v));
    document.querySelectorAll('[data-shop]').forEach(s => { s.hidden = s.dataset.shop !== v; });
  }

  /* ---------- steps (only real stages, shown as they happen) ---------- */

  function step(id, st, note) {
    let s = S.steps.find(x => x.id === id);
    if (!s) { s = { id }; S.steps.push(s); }
    s.state = st; if (note) s.note = note;
    $('#shopSteps').innerHTML = S.steps.map(x => `<li class="is-${x.state}"><span class="ic">${x.state === 'done' ? '✓' : x.state === 'error' ? '×' : ''}</span>${STEPS[x.id]}${x.note ? ` <small>${esc(x.note)}</small>` : ''}</li>`).join('');
  }

  /* ---------- search ---------- */

  async function runSearch(text, preset) {
    if (S.busy) return;
    S.busy = true; S.steps = []; S.open = null; S.enter = null;
    $('#shopMsg').innerHTML = '';
    const where = $('#shopWhere').value;
    try {
      let req = preset;
      if (!req) {
        step('understand', 'run');
        req = await RF.shop.parseRequest(text, S.request);
        step('understand', 'done', req.parsedBy ? 'via ' + req.parsedBy : '');
      }
      if (!req.category) { msg('note', 'Say what kind of furniture to look for, for example "a desk under ₹15,000".'); return; }
      const e = env();
      if (where === 'replace') req.placement = 'replace_selected';
      else if (where) { req.placement = 'selected_wall'; e.wall = where; }
      if (req.placement === 'replace_selected' && (!e.selected || e.selected.existing)) { msg('warn', 'Select a piece in the room first, then search to replace it.'); req.placement = null; }
      if (req.placement === 'selected_wall' && !e.wall && !e.selected) req.placement = null;
      renderState(req);
      const res = await RF.shop.search(req, e, (id, st) => step(id, st, id === 'search' && st === 'run' ? RF.shop.provider().name : ''));
      S.request = req; S.items = res.products.map((p, i) => ({ p, f: res.fitResults[i] })); S.meta = res.metadata; S.area = res.area; S.searchReq = res.request;
      resetFilters();
      render();
    } catch (err) {
      ['understand', 'space', 'search', 'dims', 'fit'].forEach(id => { const s = S.steps.find(x => x.id === id); if (s && s.state === 'run') step(id, 'error'); });
      msg('bad', `We couldn't complete the furniture search. <button type="button" class="btn-quiet btn-small" data-retry>Try again</button><small>${esc(err.message || '')}</small>`);
    } finally { S.busy = false; }
  }

  function msg(kind, html) { $('#shopMsg').innerHTML = `<div class="shop-msg is-${kind}">${html}</div>`; }

  function renderState(req) {
    req = req || S.request;
    if (!req) { $('#shopState').innerHTML = ''; return; }
    const chips = RF.shop.describeRequest(req);
    $('#shopState').innerHTML = `<ul class="understood">${chips.map(c => `<li>${esc(c)}</li>`).join('')}</ul>${S.request ? '<button type="button" class="btn-quiet btn-small" data-newsearch>New search</button>' : ''}`;
  }

  /* ---------- filters ---------- */

  function resetFilters() {
    const prices = S.items.map(x => x.p.price).filter(Boolean), ws = S.items.map(x => x.p.dimensions.widthCm).filter(Boolean), ds = S.items.map(x => x.p.dimensions.depthCm).filter(Boolean);
    const set = (id, vals, fallback) => { const el = $(id); const mx = vals.length ? Math.max(...vals) : fallback; el.max = Math.max(+el.min + 1, Math.ceil(mx / +el.step) * +el.step); el.value = el.max; };
    set('#fPrice', prices, 100000); set('#fWidth', ws, 400); set('#fDepth', ds, 250);
    $('#fFit').value = ''; $('#fAvail').value = ''; $('#fText').value = ''; $('#fSort').value = 'relevance';
    const retailers = Array.from(new Set(S.items.map(x => x.p.retailer).filter(Boolean)));
    $('#fRetailer').innerHTML = '<option value="">All</option>' + retailers.map(r => `<option>${esc(r)}</option>`).join('');
    labels();
  }

  function filtered() {
    const pMax = +$('#fPrice').value, wMax = +$('#fWidth').value, dMax = +$('#fDepth').value;
    const atMax = el => +el.value >= +el.max;
    const fit = $('#fFit').value, ret = $('#fRetailer').value, av = $('#fAvail').value, txt = $('#fText').value.trim().toLowerCase();
    let list = S.items.filter(({ p, f }) => {
      if (!atMax($('#fPrice')) && p.price && p.price > pMax) return false;
      if (!atMax($('#fWidth')) && p.dimensions.widthCm && p.dimensions.widthCm > wMax) return false;
      if (!atMax($('#fDepth')) && p.dimensions.depthCm && p.dimensions.depthCm > dMax) return false;
      if (fit === 'fits' && f.status !== 'fits') return false;
      if (fit === 'checkable' && f.status === 'unknown') return false;
      if (fit === 'unknown' && f.status !== 'unknown') return false;
      if (ret && p.retailer !== ret) return false;
      if (av === 'reported' && !p.availability) return false;
      if (txt && !(p.name + ' ' + (p.material || '') + ' ' + (p.color || '') + ' ' + (p.features || []).join(' ') + ' ' + (p.description || '')).toLowerCase().includes(txt)) return false;
      return true;
    });
    const order = { fits: 0, partial: 1, does_not_fit: 2, unknown: 3 };
    const sorts = {
      relevance: (a, b) => a.p.relevance - b.p.relevance,
      'price-asc': (a, b) => (a.p.price || Infinity) - (b.p.price || Infinity),
      'price-desc': (a, b) => (b.p.price || -1) - (a.p.price || -1),
      'width-asc': (a, b) => (a.p.dimensions.widthCm || Infinity) - (b.p.dimensions.widthCm || Infinity),
      fit: (a, b) => order[a.f.status] - order[b.f.status] || a.p.relevance - b.p.relevance
    };
    return list.slice().sort(sorts[$('#fSort').value] || sorts.relevance);
  }

  /* ---------- results ---------- */

  function render() {
    renderState();
    const m = S.meta;
    const n = S.items.length;
    const counts = { fits: 0, partial: 0, does_not_fit: 0, unknown: 0 };
    S.items.forEach(x => counts[x.f.status]++);
    const cat = (S.request && S.request.category) || 'furniture';
    let head = '';
    if (!n) {
      head = `<div class="shop-msg is-note"><strong>No matching furniture was found.</strong> Try:<ul><li>increasing your budget</li><li>allowing a wider ${esc(cat)}</li><li>removing a style restriction</li></ul></div>`;
    } else {
      head = `<p class="shop-summary">Found ${n} ${esc(cat)} option${n > 1 ? 's' : ''} for ${esc(S.area ? S.area.label : 'your room')}: <b>${counts.fits}</b> fit${counts.partial ? `, <b>${counts.partial}</b> provisional` : ''}, <b>${counts.does_not_fit}</b> don't${counts.unknown ? `, <b>${counts.unknown}</b> can't be verified` : ''}.</p>`;
      if (counts.unknown === n) head += `<div class="shop-msg is-warn">We found products, but their dimensions could not be verified. These products cannot be marked as "Fits" yet.</div>`;
      if (S.area && S.area.availableWidthCm) head += `<p class="note">Measured space: <span class="num">${S.area.availableWidthCm} cm</span> wide, <span class="num">${S.area.availableDepthCm} cm</span> deep (from ROOMFIT's room model).</p>`;
    }
    if (m) {
      if (m.cached) head += `<p class="note">Showing saved results from ${ago(m.searchedAt)}. Prices and availability may have changed. <button type="button" class="btn-quiet btn-small" data-refresh>Search again</button></p>`;
      m.warnings.forEach(w => { head += `<p class="note warn">${esc(w)}</p>`; });
    }
    $('#shopMsg').innerHTML = head;
    $('#shopFilters').hidden = !n;
    const list = filtered();
    $('#shopCount').textContent = n ? `${list.length} of ${n}` : '';
    $('#shopResults').innerHTML = list.map(card).join('');
    list.forEach(x => { if (S.open === x.p.id || S.hover === x.p.id) drawMiniPlan(x); });
    const src = m && m.sources && m.sources.length ? `<details><summary>Search sources (${m.sources.length})</summary><ul>${m.sources.map(s => `<li><a href="${esc(s.uri)}" target="_blank" rel="noopener noreferrer">${esc(s.title || host(s.uri))}</a></li>`).join('')}</ul>${m.queries && m.queries.length ? `<p class="note">Gemini searched: ${m.queries.map(esc).join('; ')}</p>` : ''}</details>` : '';
    $('#shopSources').innerHTML = src;
  }

  function card({ p, f }) {
    const s = STATUS[f.status];
    const open = S.open === p.id;
    const canPlace = usable(p) && f.item;
    const dt = dimsText(p.dimensions);
    let quick = '';
    if (f.status === 'fits' || f.status === 'partial') {
      quick = `<li class="is-pass"><span class="ic">✓</span><span>Fits available space</span></li>
        <li class="is-pass"><span class="ic">✓</span><span><span class="num">${f.remainingWidthCm} cm</span> remaining width</span></li>
        ${f.facts.find(x => x.label === 'Required front clearance') ? `<li class="is-pass"><span class="ic">✓</span><span>Front clearance available</span></li>` : ''}`;
    } else if (f.status === 'does_not_fit') {
      const sf = f.shortfalls && f.shortfalls[0];
      quick = sf ? `<li class="is-fail"><span class="ic">×</span><span>${esc(sf.label)}: short by <span class="num">${sf.short} cm</span></span></li>` : `<li class="is-fail"><span class="ic">×</span><span>${esc(f.reasons[0] || 'Fails a check')}</span></li>`;
    } else quick = `<li class="is-unknown"><span class="ic">?</span><span>Dimensions unavailable. Cannot verify physical fit.</span></li>`;
    const img = p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('is-noimg');this.remove()">` : '';
    return `<li class="pcard is-${s.cls} ${open ? 'is-open' : ''}" data-id="${esc(p.id)}">
      <div class="pimg ${img ? '' : 'is-noimg'}" style="--cat:${RF.CATEGORY_COLORS[RF.shopCategory(p.category + ' ' + p.name)] || RF.CATEGORY_COLORS.other}">${img}</div>
      <div class="pmain">
        <p class="pstatus"><span class="ic">${s.ic}</span>${s.text}${f.status === 'fits' && f.confidence === 'verified' ? '' : ''}</p>
        <h4>${esc(p.name)}</h4>
        <p class="note">${esc([p.brand, p.retailer].filter(Boolean).join(' · ') || 'Retailer not stated')}${p.sample ? ' · <strong>sample data, not a real listing</strong>' : ''}</p>
        <p class="pprice">${p.price ? `<span class="num">${p.currency === 'INR' || !p.currency ? '₹' + fmt(p.price) : esc(p.currency) + ' ' + fmt(p.price)}</span>` : '<span class="note">Price not listed</span>'}${p.retrievedAt && !p.sample ? ` <small>price checked ${ago(p.retrievedAt)}</small>` : ''}</p>
        <p class="pdims">${dt ? `<span class="num">${dt}</span>${p.dimensionsSource === 'user' ? ' <small>you entered these</small>' : !p.dimensionsVerified && !p.sample ? ' <small>incomplete on listing</small>' : ''}` : '<span class="note">Dimensions unavailable</span>'}</p>
        <ul class="checks">${quick}</ul>
        <div class="pactions">
          ${canPlace ? `<button type="button" class="btn btn-small btn-primary" data-place="${esc(p.id)}">Place in room</button>` : ''}
          ${p.productUrl ? `<a class="btn btn-small" href="${esc(p.productUrl)}" target="_blank" rel="noopener noreferrer">View product</a>` : ''}
          ${!usable(p) ? `<button type="button" class="btn-quiet btn-small" data-enter="${esc(p.id)}">Enter dimensions</button>` : ''}
          ${f.status !== 'unknown' ? `<button type="button" class="btn-quiet btn-small" data-why="${esc(p.id)}">${open ? 'Hide details' : f.status === 'does_not_fit' ? "Why it doesn't fit" : 'Why it fits'}</button>` : ''}
          ${f.status === 'does_not_fit' ? `<button type="button" class="btn-quiet btn-small" data-derive="alternatives" data-pid="${esc(p.id)}">Find alternatives</button>` : ''}
          <button type="button" class="btn-quiet btn-small" data-derive="cheaper" data-pid="${esc(p.id)}">Cheaper</button>
          <button type="button" class="btn-quiet btn-small" data-derive="similar" data-pid="${esc(p.id)}">Similar</button>
        </div>
        ${S.enter === p.id ? enterForm(p) : ''}
        ${S.hover === p.id && !open ? '<svg class="pplan" role="img" aria-label="Proposed placement"></svg>' : ''}
        ${open ? details(p, f) : ''}
      </div></li>`;
  }

  function enterForm(p) {
    const d = p.dimensions || {};
    return `<form class="enterdims" data-enterform="${esc(p.id)}"><p class="note">Copy the dimensions from the product page. ROOMFIT then checks fit with them.</p>
      <div class="dims">${['widthCm', 'depthCm', 'heightCm'].map((k, i) => `<label class="field"><span>${['Width', 'Depth', 'Height'][i]}</span><span class="inp"><input type="number" min="5" max="600" name="${k}" value="${d[k] || ''}" required><em>cm</em></span></label>`).join('')}</div>
      <button type="submit" class="btn btn-small">Check fit</button></form>`;
  }

  function details(p, f) {
    const rows = f.status === 'does_not_fit'
      ? (f.shortfalls.length ? f.shortfalls : []).map(s => `<tr><th>${esc(s.label)}</th><td></td></tr><tr><td>Required</td><td class="num">${s.required} cm</td></tr><tr><td>Available</td><td class="num">${s.available} cm</td></tr><tr class="short"><td>Short by</td><td class="num">${s.short} cm</td></tr>`).join('')
        + f.reasons.slice(0, 4).map(r => `<tr><td colspan="2" class="reason">× ${esc(r)}</td></tr>`).join('')
      : f.facts.map(x => `<tr><td>${esc(x.label)}</td><td class="${x.text ? '' : 'num'}">${x.text ? esc(x.text) : x.value + (x.plus ? '+' : '') + ' ' + x.unit}</td></tr>`).join('')
        + (f.status === 'partial' ? f.reasons.slice(0, 2).map(r => `<tr><td colspan="2" class="reason">! ${esc(r)}</td></tr>`).join('') : '');
    return `<div class="pdetails">
      ${p.imageUrl ? `<img class="pbig" src="${esc(p.imageUrl)}" alt="${esc(p.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"><p class="note">Image is for reference only. ROOMFIT uses the listed dimensions, not the picture.</p>` : ''}
      <h5>${f.status === 'does_not_fit' ? "Why this doesn't fit" : 'Why this fits'}</h5>
      <table class="why">${rows}</table>
      <p class="note">Numbers come from ROOMFIT's geometry engine${f.positionsTested ? `, which tested ${fmt(f.positionsTested)} positions and orientations` : ''}.</p>
      <svg class="pplan" role="img" aria-label="Proposed placement"></svg>
      <div class="psource"><h5>Source</h5>
        ${p.productUrl ? `<p><a href="${esc(p.productUrl)}" target="_blank" rel="noopener noreferrer">${esc(host(p.productUrl))}</a> · ${p.linkStatus === 'ok' ? 'link confirmed live' : p.grounded ? 'found in search results; link not confirmed live' : 'link not checked'}</p>` : `<p>${esc(p.provider || '')}</p>`}
        ${p.dimensionsText ? `<p>Dimensions as listed: “${esc(p.dimensionsText)}”</p>` : '<p>No dimensions stated on the listing.</p>'}
        ${p.availability ? `<p>Availability reported by the listing: ${esc(p.availability)}. Not guaranteed.</p>` : ''}
        ${p.retrievedAt ? `<p>Retrieved ${new Date(p.retrievedAt).toLocaleString()}. Prices can change; check the retailer before buying.</p>` : ''}
      </div></div>`;
  }

  function drawMiniPlan(x) {
    const el = document.querySelector(`.pcard[data-id="${CSS.escape(x.p.id)}"] .pplan`);
    if (!el || !x.f.item) return;
    const st = RF.app.state;
    const ex = new Set((S.area && S.area.excludeUids) || []);
    const items = st.items.filter(i => !i.preview && !ex.has(i.uid)).concat(x.f.item);
    RF.Plan2D(el, { mini: true }).set({ room: st.room, items, validation: x.f.validation, selected: x.f.item.uid, highlight: x.f.item.uid, zones: 'selected' });
  }

  function find(id) { return S.items.find(x => x.p.id === id); }

  function place(id) {
    const x = find(id);
    if (!x || !x.f.item) return;
    const item = Object.assign({}, x.f.item);
    item.source = Object.assign({}, item.source, { productUrl: x.p.productUrl, retailer: x.p.retailer, retrievedAt: x.p.retrievedAt, dimensionsSource: x.p.dimensionsSource });
    RF.app.placeProduct(item, { replaceUid: S.area && S.area.kind === 'replace' ? S.area.uid : null });
    closePanel();
    RF.app.toast(`Previewing ${x.p.name}. Drag or rotate it, then confirm.`);
  }

  function revalidateOne(x) {
    x.f = RF.shop.validateProductAgainstRoom(x.p, RF.app.state.room, Object.assign(env(), { area: S.area }));
  }

  /* ---------- shop this room ---------- */

  async function shopRoom() {
    if (S.busy) return;
    const e = env();
    if (!e.items.some(i => !i.existing)) { $('#shopRoomOut').innerHTML = '<p class="shop-msg is-note">Add furniture to the design first. ROOMFIT shops for each piece it contains.</p>'; return; }
    S.busy = true; S.optimize = null;
    const progress = {};
    const draw = () => { $('#shopRoomOut').innerHTML = `<ol class="shop-steps">${Object.values(progress).map(l => `<li class="is-${l.state === 'done' ? 'done' : l.state === 'error' ? 'error' : 'run'}"><span class="ic">${l.state === 'done' ? '✓' : l.state === 'error' ? '×' : ''}</span>Searching for ${esc(l.name)}</li>`).join('')}</ol>`; };
    try {
      S.room = await RF.shop.shopRoom(e, l => { progress[l.uid] = l; draw(); });
      renderRoom();
    } catch (err) {
      $('#shopRoomOut').innerHTML = `<div class="shop-msg is-bad">We couldn't complete the furniture search. Try again.<small>${esc(err.message)}</small></div>`;
    } finally { S.busy = false; }
  }

  function roomTotal() { return (S.room || []).reduce((a, l) => a + (l.choice ? l.choice.p.price : 0), 0); }

  function renderRoom() {
    const lines = S.room || [];
    const budget = RF.app.state.budget;
    const total = roomTotal();
    const missing = lines.filter(l => !l.choice).length;
    let html = `<ul class="room-lines">${lines.map((l, i) => {
      const c = l.choice;
      return `<li><div><strong>${esc(l.label.replace(/^\w/, s => s.toUpperCase()))}</strong><small>replacing ${esc(l.name)}</small></div>
        ${c ? `<div class="rl-pick"><span>${esc(c.p.name)}</span><small>${esc(c.p.retailer || '')} · <span class="num">${dimsText(c.p.dimensions)}</span></small></div><div class="rl-price"><span class="num">₹${fmt(c.p.price)}</span><small class="ok">✓ Fits</small></div>`
          : `<div class="rl-pick"><span class="note">${l.error ? "Search failed" : 'No fitting product with a listed price found'}</span><small>${l.options ? l.options.length : 0} result(s) checked</small></div><div></div>`}
        <div class="rl-act">${l.options && l.options.length ? `<button type="button" class="btn-quiet btn-small" data-lineopts="${i}">See ${l.options.length} options</button>` : ''}${c && c.p.productUrl ? `<a class="btn-quiet btn-small" href="${esc(c.p.productUrl)}" target="_blank" rel="noopener noreferrer">View</a>` : ''}</div></li>`;
    }).join('')}</ul>
      <div class="room-total"><span>Estimated total</span><span class="num">₹${fmt(total)}</span></div>
      <p class="note">Sum of listed prices retrieved ${lines[0] && lines[0].meta ? ago(lines[0].meta.searchedAt) : 'now'}${missing ? `; ${missing} piece(s) without a fitting priced result are not included` : ''}. Prices can change.</p>`;
    if (budget) {
      const over = total - budget;
      html += over > 0
        ? `<div class="room-budget is-over"><p>Current total <span class="num">₹${fmt(total)}</span> · Over budget <span class="num">₹${fmt(over)}</span></p><button type="button" class="btn btn-small" id="btnOptimize">Optimize budget</button></div>`
        : `<div class="room-budget"><p>Within your <span class="num">₹${fmt(budget)}</span> budget · <span class="num">₹${fmt(budget - total)}</span> left</p></div>`;
    }
    if (S.optimize) {
      const o = S.optimize;
      html += o.changes.length
        ? `<div class="changes"><h5>Proposed changes</h5>${o.changes.map(c => `<div class="change"><strong>${esc(c.label.replace(/^\w/, s => s.toUpperCase()))}</strong><span class="num">₹${fmt(c.from.p.price)} → ₹${fmt(c.to.p.price)}</span><small>${esc(c.from.p.name)} → ${esc(c.to.p.name)} · saved ₹${fmt(c.saved)} · ✓ fits</small></div>`).join('')}
            <p>New total <span class="num">₹${fmt(o.newTotal)}</span></p><button type="button" class="btn btn-small btn-primary" id="btnApplyChanges">Apply these changes</button></div>`
        : `<p class="shop-msg is-note">No cheaper products that fit were found for these pieces.</p>`;
    }
    if (lines.some(l => l.choice)) html += `<div class="row gap"><button type="button" class="btn btn-small btn-primary" id="btnPlaceAll">Place all in room</button></div>`;
    $('#shopRoomOut').innerHTML = html;
  }

  /* ---------- wiring ---------- */

  function bind() {
    $('#btnFind').addEventListener('click', () => $('#shopPanel').hidden ? openPanel() : closePanel());
    $('#shopClose').addEventListener('click', closePanel);
    $('#shopTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTab(b.dataset.v); });
    $('#shopForm').addEventListener('submit', e => { e.preventDefault(); const t = $('#shopQuery').value.trim(); if (t) { runSearch(t); $('#shopQuery').value = ''; } });
    $('#shopQuery').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#shopForm').requestSubmit(); } });
    ['#fPrice', '#fWidth', '#fDepth'].forEach(id => $(id).addEventListener('input', () => { labels(); render(); }));
    ['#fFit', '#fRetailer', '#fAvail', '#fSort'].forEach(id => $(id).addEventListener('change', render));
    $('#fText').addEventListener('input', render);

    $('#shopPanel').addEventListener('click', e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.place) place(t.dataset.place);
      else if (t.dataset.why) { S.open = S.open === t.dataset.why ? null : t.dataset.why; render(); }
      else if (t.dataset.enter) { S.enter = S.enter === t.dataset.enter ? null : t.dataset.enter; render(); }
      else if (t.dataset.derive) {
        const x = find(t.dataset.pid);
        const req = RF.shop.derive(t.dataset.derive, S.request, x && x.p, x && x.f);
        runSearch(null, req);
      }
      else if (t.hasAttribute('data-newsearch')) { S.request = null; S.items = []; S.meta = null; S.steps = []; $('#shopSteps').innerHTML = ''; $('#shopResults').innerHTML = ''; $('#shopSources').innerHTML = ''; $('#shopFilters').hidden = true; renderState(); $('#shopMsg').innerHTML = ''; }
      else if (t.hasAttribute('data-retry') || t.hasAttribute('data-refresh')) { if (S.request) { const r = JSON.parse(JSON.stringify(S.request)); runSearchNoCache(r); } }
      else if (t.id === 'btnShopRoom') shopRoom();
      else if (t.id === 'btnOptimize') optimize();
      else if (t.id === 'btnApplyChanges') { S.optimize.changes.forEach(c => { const l = S.room.find(x => x.uid === c.uid); if (l) l.choice = c.to; }); RF.app.toast(`Applied ${S.optimize.changes.length} change(s). Saved ₹${fmt(S.optimize.changes.reduce((a, c) => a + c.saved, 0))}.`); S.optimize = null; renderRoom(); }
      else if (t.id === 'btnPlaceAll') placeAll();
      else if (t.dataset.lineopts != null) {
        const l = S.room[+t.dataset.lineopts];
        S.items = l.options; S.area = l.area; S.request = l.request; S.meta = l.meta; S.open = null;
        setTab('find'); resetFilters(); render();
      }
    });
    $('#shopPanel').addEventListener('submit', e => {
      const f = e.target.closest('[data-enterform]'); if (!f) return;
      e.preventDefault();
      const x = find(f.dataset.enterform);
      const d = Object.fromEntries(['widthCm', 'depthCm', 'heightCm'].map(k => [k, Math.round(+f.elements[k].value) || null]));
      if (!d.widthCm || !d.depthCm || !d.heightCm) return;
      x.p = Object.assign({}, x.p, { dimensions: d, dimensionsSource: 'user', dimensionsText: x.p.dimensionsText });
      revalidateOne(x);
      S.enter = null; S.open = x.p.id;
      render();
    });
    $('#shopResults').addEventListener('mouseover', e => {
      const b = e.target.closest('[data-place]');
      const id = b ? b.dataset.place : null;
      if (id !== S.hover && (id || !e.target.closest('.pcard'))) { S.hover = id; if (id) { const x = find(id); const card = b.closest('.pcard'); if (!card.querySelector('.pplan')) { card.querySelector('.pactions').insertAdjacentHTML('afterend', '<svg class="pplan" role="img" aria-label="Proposed placement"></svg>'); } drawMiniPlan(x); } }
    });
    $('#shopBudget').addEventListener('change', e => { const v = +e.target.value > 0 ? +e.target.value : null; RF.app.setBudget(v); S.budgetSync = v; S.optimize = null; if (S.room) renderRoom(); });
  }

  async function runSearchNoCache(req) {
    if (S.busy) return;
    S.busy = true; S.steps = [];
    try {
      const res = await RF.shop.search(req, Object.assign(env(), { noCache: true, wall: S.area && S.area.wall }), (id, st) => step(id, st));
      S.items = res.products.map((p, i) => ({ p, f: res.fitResults[i] })); S.meta = res.metadata; S.area = res.area;
      resetFilters(); render();
    } catch (err) { msg('bad', `We couldn't complete the furniture search. Try again.<small>${esc(err.message)}</small>`); }
    finally { S.busy = false; }
  }

  async function optimize() {
    const b = $('#btnOptimize'); if (b) { b.disabled = true; b.textContent = 'Searching for lower-cost options…'; }
    S.optimize = await RF.shop.optimizeBudget(S.room, RF.app.state.budget, env());
    renderRoom();
  }

  function placeAll() {
    let n = 0;
    for (const l of S.room) {
      if (!l.choice || !l.choice.f.item) continue;
      const st = RF.app.state;
      if (!st.items.some(i => i.uid === l.uid)) continue;
      // re-check against the room as it is now (earlier replacements may have changed it)
      const area = RF.shop.targetArea(st.room, st.items, { category: l.label, placement: 'replace_selected' }, st.items.find(i => i.uid === l.uid), env());
      const f = RF.shop.validateProductAgainstRoom(l.choice.p, st.room, Object.assign(env(), { area }));
      if (!f.item) continue;
      const item = Object.assign({}, f.item, { source: Object.assign({}, f.item.source, { productUrl: l.choice.p.productUrl, retailer: l.choice.p.retailer, retrievedAt: l.choice.p.retrievedAt }) });
      RF.app.placeProduct(item, { replaceUid: l.uid, commit: true });
      n++;
    }
    closePanel();
    RF.app.toast(`Placed ${n} product(s). The checks panel shows the result.`);
  }

  function labels() {
    const at = el => +el.value >= +el.max;
    $('#fPriceV').textContent = at($('#fPrice')) ? 'any' : '₹' + fmt(+$('#fPrice').value);
    $('#fWidthV').textContent = at($('#fWidth')) ? 'any' : $('#fWidth').value + ' cm';
    $('#fDepthV').textContent = at($('#fDepth')) ? 'any' : $('#fDepth').value + ' cm';
  }
  RF.shopUI = { open: openPanel, close: closePanel, search: runSearch, state: S };

  // deep link: #/design?find=<request> opens the panel and runs the search (read before the router strips the query)
  const findQ = new URLSearchParams((location.hash.split('?')[1] || '')).get('find');
  function start() {
    bind();
    if (findQ) setTimeout(() => { openPanel('find'); runSearch(findQ); }, 50);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})(window.RF = window.RF || {});
