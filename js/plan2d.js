/* ROOMFIT 2D plan renderer (SVG, centimetre coordinates). Pure view — geometry comes from RF.validate. */
(function (RF) {
  'use strict';

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  RF.esc = esc;
  let nextId = 0;

  RF.Plan2D = function (svg, opts) {
    opts = opts || {};
    const id = 'p' + (nextId++);
    const st = { room: null, items: [], validation: null, selected: null, rules: null, zones: 'selected', highlight: null };
    let drag = null;

    function dims(room) {
      const p = opts.mini ? 14 : 46;
      return { p, vb: `${-p} ${-p} ${room.width + p * 2} ${room.length + p * 2}` };
    }

    function wallSegments(room, wall) {
      const len = (wall === 'N' || wall === 'S') ? room.width : room.length;
      const gaps = (room.openings || []).filter(o => o.wall === wall).map(o => [o.offset, o.offset + o.width]).sort((a, b) => a[0] - b[0]);
      const segs = []; let t = 0;
      for (const [a, b] of gaps) { if (a > t) segs.push([t, a]); t = Math.max(t, b); }
      if (t < len) segs.push([t, len]);
      return segs;
    }

    function wallRect(room, wall, a, b, T) {
      const W = room.width, L = room.length;
      if (wall === 'N') return [a, -T, b - a, T];
      if (wall === 'S') return [a, L, b - a, T];
      if (wall === 'W') return [-T, a, T, b - a];
      return [W, a, T, b - a];
    }

    function render() {
      const room = st.room;
      if (!room) { svg.innerHTML = ''; return; }
      const { vb } = dims(room);
      svg.setAttribute('viewBox', vb);
      const W = room.width, L = room.length, T = opts.mini ? 5 : 9;
      const rules = st.rules || RF.effectiveRules();
      const v = st.validation;
      const o = [];
      o.push(`<defs><pattern id="${id}h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="rf-hatch"/></pattern></defs>`);
      o.push(`<rect class="rf-floor" x="0" y="0" width="${W}" height="${L}"/>`);
      if (!opts.mini) {
        let g = '';
        for (let x = 50; x < W; x += 50) g += `M${x} 0V${L}`;
        for (let y = 50; y < L; y += 50) g += `M0 ${y}H${W}`;
        o.push(`<path class="rf-grid" d="${g}"/>`);
      }
      // obstacles
      for (const ob of room.obstacles || []) o.push(`<rect class="rf-obstacle" x="${ob.x}" y="${ob.y}" width="${ob.w}" height="${ob.d}" fill="url(#${id}h)"/>${opts.mini ? '' : `<text class="rf-label rf-label-sm" x="${ob.x + ob.w / 2}" y="${ob.y + ob.d / 2}">${esc(ob.label || 'Fixed')}</text>`}`);

      // door swings + openings
      const doorFail = v && v.violations.some(x => x.id === 'door');
      for (const op of room.openings || []) {
        const g = RF.openingGeom(room, op);
        const p1 = g.pt(g.s, 0), p2 = g.pt(g.e, 0);
        if (op.type === 'window') {
          const q1 = g.pt(g.s, -T), q2 = g.pt(g.e, -T);
          o.push(`<path class="rf-window" d="M${p1}L${p2}M${q1}L${q2}M${g.pt(g.s, -T / 2)}L${g.pt(g.e, -T / 2)}"/>`);
        } else {
          const r = op.width;
          const sgn = op.swing === 'out' ? -1 : 1;
          const n = [g.n[0] * sgn, g.n[1] * sgn];
          const tipClosed = [g.hinge[0] + g.c[0] * r, g.hinge[1] + g.c[1] * r];
          const tipOpen = [g.hinge[0] + n[0] * r, g.hinge[1] + n[1] * r];
          const cross = g.c[0] * n[1] - g.c[1] * n[0];
          const sweep = cross > 0 ? 1 : 0;
          if (op.swing !== 'slide') {
            o.push(`<path class="rf-swing ${doorFail && sgn > 0 ? 'is-fail' : ''}" d="M${g.hinge}L${tipClosed}A${r} ${r} 0 0 ${sweep} ${tipOpen}Z"/>`);
            o.push(`<path class="rf-door" d="M${g.hinge}L${tipOpen}"/>`);
          }
          o.push(`<path class="rf-threshold" d="M${p1}L${p2}"/>`);
        }
      }
      // walls
      for (const wall of ['N', 'E', 'S', 'W']) for (const [a, b] of wallSegments(room, wall)) {
        const [x, y, w, h] = wallRect(room, wall, a, b, T);
        o.push(`<rect class="rf-wall" x="${x}" y="${y}" width="${w}" height="${h}"/>`);
      }
      // corner fills
      o.push(`<rect class="rf-wall" x="${-T}" y="${-T}" width="${T}" height="${T}"/><rect class="rf-wall" x="${W}" y="${-T}" width="${T}" height="${T}"/><rect class="rf-wall" x="${-T}" y="${L}" width="${T}" height="${T}"/><rect class="rf-wall" x="${W}" y="${L}" width="${T}" height="${T}"/>`);

      // clearance zones (clipped to the room so they never paint over walls)
      o.push(`<clipPath id="${id}c"><rect x="0" y="0" width="${W}" height="${L}"/></clipPath><g clip-path="url(#${id}c)">`);
      for (const it of st.items) {
        const show = st.zones === 'all' || (st.zones === 'selected' && it.uid === st.selected);
        if (!show) continue;
        const rec = v && v.items[it.uid];
        for (const z of RF.zonesOf(it, rules)) {
          const fail = rec && rec.checks.some(c => c.status === 'fail' && c.id === z.kind);
          const r = z.rect;
          o.push(`<rect class="rf-zone ${fail ? 'is-fail' : ''}" x="${r.x0}" y="${r.y0}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}"/>`);
          if (!opts.mini && it.uid === st.selected) {
            const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
            o.push(`<text class="rf-zone-label ${fail ? 'is-fail' : ''}" x="${cx}" y="${cy}">${z.depth}</text>`);
          }
        }
      }
      o.push('</g>');

      // items
      for (const it of st.items) {
        const r = RF.rectOf(it), rec = v && v.items[it.uid];
        const status = rec ? rec.status : 'pass';
        const w = r.x1 - r.x0, h = r.y1 - r.y0;
        const sel = it.uid === st.selected;
        const hl = st.highlight === it.uid;
        const fe = { S: `M${r.x0 + 3} ${r.y1 - 2.5}H${r.x1 - 3}`, N: `M${r.x0 + 3} ${r.y0 + 2.5}H${r.x1 - 3}`, E: `M${r.x1 - 2.5} ${r.y0 + 3}V${r.y1 - 3}`, W: `M${r.x0 + 2.5} ${r.y0 + 3}V${r.y1 - 3}` }[it.facing];
        const high = it.elev >= 100;
        o.push(`<g class="rf-item cat-${esc(it.category)} is-${status} ${sel ? 'is-selected' : ''} ${hl ? 'is-highlight' : ''} ${it.existing ? 'is-existing' : ''} ${high ? 'is-high' : ''}" data-uid="${esc(it.uid)}" style="--cat:${RF.CATEGORY_COLORS[it.category] || RF.CATEGORY_COLORS.other}">`);
        o.push(`<rect class="rf-body" x="${r.x0}" y="${r.y0}" width="${w}" height="${h}" rx="2.5"/>`);
        if (status === 'fail') o.push(`<rect class="rf-failfill" x="${r.x0}" y="${r.y0}" width="${w}" height="${h}" rx="2.5" fill="url(#${id}h)"/>`);
        o.push(`<path class="rf-front" d="${fe}"/>`);
        if (!opts.mini && Math.min(w, h) >= 28) {
          const long = Math.max(w, h), name = shortName(it);
          const fs = Math.max(6.5, Math.min(11, long / (name.length * 0.62), Math.min(w, h) / 2.2));
          const rot = h > w * 1.3 ? ` transform="rotate(-90 ${it.x} ${it.y})"` : '';
          o.push(`<text class="rf-label" x="${it.x}" y="${it.y}" style="font-size:${fs.toFixed(1)}px"${rot}>${esc(name)}</text>`);
        }
        o.push(`</g>`);
        if (sel && !opts.mini) {
          o.push(`<rect class="rf-sel" x="${r.x0 - 3}" y="${r.y0 - 3}" width="${w + 6}" height="${h + 6}" rx="4"/>`);
          o.push(dimLine(r.x0, r.y0 - 14, r.x1, r.y0 - 14, `${Math.round(w)}`));
          o.push(dimLineV(r.x1 + 14, r.y0, r.y1, `${Math.round(h)}`));
        }
      }

      // room dimensions
      if (!opts.mini) {
        const pv = room.provenance || {};
        o.push(dimLine(0, -28, W, -28, `${W} cm${pv.width === 'estimated' ? ' (est.)' : ''}`, 'rf-roomdim', pv.width));
        o.push(dimLineV(-28, 0, L, `${L} cm${pv.length === 'estimated' ? ' (est.)' : ''}`, 'rf-roomdim', pv.length));
        o.push(`<text class="rf-compass" x="${W + 22}" y="-18">N</text><path class="rf-compass-arrow" d="M${W + 22} -10 l-4 8 h8z"/>`);
      }
      svg.innerHTML = o.join('');
    }

    function shortName(it) {
      const n = it.name.replace(/\s*\(.*\)/, '');
      return n.length > 18 ? n.split(' ').slice(-1)[0] : n;
    }
    function dimLine(x0, y, x1, _y, text, cls, prov) {
      const k = prov === 'estimated' ? 'is-est' : prov === 'unknown' ? 'is-unknown' : '';
      return `<g class="rf-dim ${cls || ''} ${k}"><path d="M${x0} ${y}H${x1}M${x0} ${y - 4}V${y + 4}M${x1} ${y - 4}V${y + 4}"/><text x="${(x0 + x1) / 2}" y="${y - 5}">${esc(text)}</text></g>`;
    }
    function dimLineV(x, y0, y1, text, cls, prov) {
      const k = prov === 'estimated' ? 'is-est' : prov === 'unknown' ? 'is-unknown' : '';
      const cy = (y0 + y1) / 2;
      return `<g class="rf-dim ${cls || ''} ${k}"><path d="M${x} ${y0}V${y1}M${x - 4} ${y0}H${x + 4}M${x - 4} ${y1}H${x + 4}"/><text x="${x - 5}" y="${cy}" transform="rotate(-90 ${x - 5} ${cy})">${esc(text)}</text></g>`;
    }

    function toCm(ev) {
      const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
      const m = svg.getScreenCTM(); if (!m) return { x: 0, y: 0 };
      const p = pt.matrixTransform(m.inverse());
      return { x: p.x, y: p.y };
    }

    if (opts.interactive) {
      svg.addEventListener('pointerdown', ev => {
        const g = ev.target.closest('[data-uid]');
        if (!g) { if (opts.onSelect) opts.onSelect(null); return; }
        const uid = g.getAttribute('data-uid');
        const it = st.items.find(i => i.uid === uid);
        if (opts.onSelect) opts.onSelect(uid);
        if (!it || it.locked || (opts.canDrag && !opts.canDrag(it))) return;
        const p = toCm(ev);
        drag = { uid, dx: p.x - it.x, dy: p.y - it.y, moved: false };
        svg.setPointerCapture(ev.pointerId);
        svg.classList.add('is-dragging');
        ev.preventDefault();
      });
      svg.addEventListener('pointermove', ev => {
        if (!drag) return;
        const p = toCm(ev);
        drag.moved = true;
        if (opts.onDrag) opts.onDrag(drag.uid, Math.round(p.x - drag.dx), Math.round(p.y - drag.dy));
      });
      const end = ev => {
        if (!drag) return;
        const d = drag; drag = null;
        svg.classList.remove('is-dragging');
        try { svg.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        if (d.moved && opts.onDrop) opts.onDrop(d.uid);
      };
      svg.addEventListener('pointerup', end);
      svg.addEventListener('pointercancel', end);
    }

    return {
      set(p) { Object.assign(st, p); render(); },
      get state() { return st; }
    };
  };
})(window.RF = window.RF || {});
