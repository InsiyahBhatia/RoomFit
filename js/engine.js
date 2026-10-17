/*
 * ROOMFIT spatial engine — deterministic geometry. This is the source of truth for "does it fit".
 * Coordinates: centimetres. x runs along the room width (west → east), y along the length (north → south).
 * Items are axis-aligned; facing is the direction the item's usable front points: 'N' | 'E' | 'S' | 'W'.
 * Item (x, y) is the centre of its footprint.
 */
(function (RF) {
  'use strict';

  const EPS = 0.01;
  const OPP = { S: 'N', N: 'S', E: 'W', W: 'E' };
  const WALL_NAME = { N: 'north', S: 'south', E: 'east', W: 'west' };
  const FLOOR_LEVEL = 100; // items starting above this height don't block floor clearance or walking
  RF.OPP = OPP;
  RF.WALL_NAME = WALL_NAME;

  let seq = 0;
  RF.uid = () => 'i' + Date.now().toString(36).slice(-4) + (seq++).toString(36) + Math.random().toString(36).slice(2, 5);

  /* ---------- items ---------- */

  RF.instance = function (p, o) {
    return Object.assign({
      uid: RF.uid(), productId: p.id, name: p.name, category: p.category,
      w: p.width_cm, d: p.depth_cm, h: p.height_cm, elev: p.elevation_cm || 0,
      price: p.price_inr || 0, facing: 'S', x: 0, y: 0,
      front: p.clearance_front_cm || 0, side: p.clearance_side_cm || 0,
      door: p.door_clearance_cm || 0, drawer: p.drawer_clearance_cm || 0, back: p.clearance_back_cm || 0,
      wallMount: !!p.requires_wall_mount, style: p.style || [], tags: p.tags || [],
      pairedWith: null, existing: false, locked: false, sample: p.sample !== false
    }, o || {});
  };

  RF.rectOf = function (it) {
    const vertical = it.facing === 'S' || it.facing === 'N';
    const ex = vertical ? it.w : it.d, ey = vertical ? it.d : it.w;
    return { x0: it.x - ex / 2, x1: it.x + ex / 2, y0: it.y - ey / 2, y1: it.y + ey / 2 };
  };

  RF.requiredFront = (it, rules) => Math.round(Math.max(it.front || 0, it.door || 0, it.drawer || 0) * (rules.clearMult || 1));
  RF.requiredSide = (it, rules) => {
    if (it.category !== 'bed' || !it.side) return 0;
    const s = Math.round(it.side * (rules.clearMult || 1));
    return rules.accessibility ? Math.max(s, rules.accessibleMinSideCm) : s;
  };
  RF.perp = f => (f === 'S' || f === 'N') ? ['W', 'E'] : ['N', 'S'];

  /** Rectangle of `depth` extending from rect r in direction dir. */
  RF.zoneRect = function (r, dir, depth) {
    switch (dir) {
      case 'S': return { x0: r.x0, x1: r.x1, y0: r.y1, y1: r.y1 + depth };
      case 'N': return { x0: r.x0, x1: r.x1, y0: r.y0 - depth, y1: r.y0 };
      case 'E': return { x0: r.x1, x1: r.x1 + depth, y0: r.y0, y1: r.y1 };
      default: return { x0: r.x0 - depth, x1: r.x0, y0: r.y0, y1: r.y1 };
    }
  };

  /** Usage zones to visualise for an item. */
  RF.zonesOf = function (it, rules) {
    rules = rules || RF.effectiveRules();
    const r = RF.rectOf(it), z = [];
    if (it.elev >= FLOOR_LEVEL) return z;
    const f = RF.requiredFront(it, rules);
    if (f > 0) z.push({ kind: 'front', dir: it.facing, depth: f, rect: RF.zoneRect(r, it.facing, f) });
    const s = RF.requiredSide(it, rules);
    if (s > 0) RF.perp(it.facing).forEach(d => z.push({ kind: 'side', dir: d, depth: s, rect: RF.zoneRect(r, d, s) }));
    if (it.back > 0) z.push({ kind: 'back', dir: OPP[it.facing], depth: it.back, rect: RF.zoneRect(r, OPP[it.facing], it.back) });
    return z;
  };

  /* ---------- primitives ---------- */

  function overlap(a, b) {
    return { ox: Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy: Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) };
  }
  function intersects(a, b) { const o = overlap(a, b); return o.ox > EPS && o.oy > EPS; }
  function vOverlap(a0, a1, b0, b1) { return a0 < b1 - EPS && b0 < a1 - EPS; }
  function inset(r, k) { return { x0: r.x0 + k, y0: r.y0 + k, x1: r.x1 - k, y1: r.y1 - k }; }
  RF.distRectPoint = function (r, p) {
    const dx = Math.max(r.x0 - p[0], 0, p[0] - r.x1), dy = Math.max(r.y0 - p[1], 0, p[1] - r.y1);
    return Math.hypot(dx, dy);
  };
  RF.distRectRect = function (a, b) {
    const dx = Math.max(a.x0 - b.x1, 0, b.x0 - a.x1), dy = Math.max(a.y0 - b.y1, 0, b.y0 - a.y1);
    return Math.hypot(dx, dy);
  };

  // Liang–Barsky segment vs axis-aligned rectangle
  function segHitsRect(ax, ay, bx, by, r) {
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dy = by - ay;
    const pq = [[-dx, ax - r.x0], [dx, r.x1 - ax], [-dy, ay - r.y0], [dy, r.y1 - ay]];
    for (const [p, q] of pq) {
      if (Math.abs(p) < 1e-9) { if (q < 0) return false; }
      else {
        const t = q / p;
        if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
        else { if (t < t0) return false; if (t < t1) t1 = t; }
      }
    }
    return t0 <= t1;
  }

  /* ---------- openings ---------- */

  RF.wallFrame = function (room, wall) {
    const W = room.width, L = room.length;
    switch (wall) {
      case 'N': return { p0: [0, 0], a: [1, 0], n: [0, 1], len: W };
      case 'S': return { p0: [0, L], a: [1, 0], n: [0, -1], len: W };
      case 'W': return { p0: [0, 0], a: [0, 1], n: [1, 0], len: L };
      default: return { p0: [W, 0], a: [0, 1], n: [-1, 0], len: L };
    }
  };

  RF.openingGeom = function (room, op) {
    const f = RF.wallFrame(room, op.wall);
    const s = op.offset, e = op.offset + op.width;
    const pt = (t, k) => [f.p0[0] + f.a[0] * t + f.n[0] * (k || 0), f.p0[1] + f.a[1] * t + f.n[1] * (k || 0)];
    const hingeEnd = op.hinge === 'end';
    return {
      f, s, e, pt, n: f.n,
      hinge: pt(hingeEnd ? e : s),
      c: hingeEnd ? [-f.a[0], -f.a[1]] : [f.a[0], f.a[1]],
      mid: pt((s + e) / 2)
    };
  };

  RF.openingZone = function (room, op, depth) {
    const g = RF.openingGeom(room, op);
    const p = g.pt(g.s, 0), q = g.pt(g.e, depth);
    return { x0: Math.min(p[0], q[0]), x1: Math.max(p[0], q[0]), y0: Math.min(p[1], q[1]), y1: Math.max(p[1], q[1]) };
  };

  /** Sweep a door leaf from closed to 90°; returns the largest angle reached before hitting a rect. */
  RF.doorSweep = function (room, op, rects) {
    if (op.swing === 'out' || op.swing === 'slide') return { maxAngle: 90, interior: false, by: null };
    const g = RF.openingGeom(room, op), r = op.width;
    for (let th = 1; th <= 90; th++) {
      const a = th * Math.PI / 180;
      const dx = g.c[0] * Math.cos(a) + g.n[0] * Math.sin(a), dy = g.c[1] * Math.cos(a) + g.n[1] * Math.sin(a);
      const bx = g.hinge[0] + dx * r, by = g.hinge[1] + dy * r;
      for (const q of rects) {
        if (segHitsRect(g.hinge[0], g.hinge[1], bx, by, inset(q.r, 1))) return { maxAngle: th - 1, interior: true, by: q };
      }
    }
    return { maxAngle: 90, interior: true, by: null };
  };

  /* ---------- clearance measurement ---------- */

  /** Clear distance from rect r in direction dir to the nearest wall or blocker that overlaps its span. */
  RF.gapDir = function (r, dir, blockers, room) {
    const horiz = dir === 'E' || dir === 'W';
    const sign = (dir === 'S' || dir === 'E') ? 1 : -1;
    const lo = horiz ? r.y0 : r.x0, hi = horiz ? r.y1 : r.x1;
    const edge = horiz ? (sign > 0 ? r.x1 : r.x0) : (sign > 0 ? r.y1 : r.y0);
    const wallPos = horiz ? (sign > 0 ? room.width : 0) : (sign > 0 ? room.length : 0);
    let best = { gap: Math.max(0, (wallPos - edge) * sign), by: WALL_NAME[dir] + ' wall' };
    for (const b of blockers) {
      const blo = horiz ? b.r.y0 : b.r.x0, bhi = horiz ? b.r.y1 : b.r.x1;
      if (bhi <= lo + EPS || blo >= hi - EPS) continue;
      const near = horiz ? (sign > 0 ? b.r.x0 : b.r.x1) : (sign > 0 ? b.r.y0 : b.r.y1);
      const g = (near - edge) * sign;
      if (g < -EPS) continue;
      if (g < best.gap) best = { gap: Math.max(0, g), by: b.label };
    }
    best.gap = Math.round(best.gap);
    return best;
  };

  function paired(a, b) { return (a.pairedWith && a.pairedWith === b.uid) || (b.pairedWith && b.pairedWith === a.uid); }

  /* ---------- circulation ---------- */

  function circulation(room, rects, doors, targets, walkW, step) {
    const nx = Math.ceil(room.width / step), ny = Math.ceil(room.length / step), r = walkW / 2;
    const free = new Uint8Array(nx * ny), seen = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const cy = (j + 0.5) * step;
      for (let i = 0; i < nx; i++) {
        const cx = (i + 0.5) * step;
        let ok = cx >= r - EPS && cx <= room.width - r + EPS && cy >= r - EPS && cy <= room.length - r + EPS;
        if (ok) for (const q of rects) {
          const dx = Math.max(q.x0 - cx, 0, cx - q.x1), dy = Math.max(q.y0 - cy, 0, cy - q.y1);
          if (dx * dx + dy * dy < r * r - 1e-6) { ok = false; break; }
        }
        free[j * nx + i] = ok ? 1 : 0;
      }
    }
    const queue = new Int32Array(nx * ny); let qh = 0, qt = 0;
    const cellsIn = (z, fn) => {
      const i0 = Math.max(0, Math.floor(z.x0 / step)), i1 = Math.min(nx - 1, Math.ceil(z.x1 / step));
      const j0 = Math.max(0, Math.floor(z.y0 / step)), j1 = Math.min(ny - 1, Math.ceil(z.y1 / step));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * step, cy = (j + 0.5) * step;
        if (cx >= z.x0 - EPS && cx <= z.x1 + EPS && cy >= z.y0 - EPS && cy <= z.y1 + EPS) fn(j * nx + i);
      }
    };
    let seeded = 0;
    for (const d of doors) {
      cellsIn(RF.openingZone(room, d, r + step * 2), k => { if (free[k] && !seen[k]) { seen[k] = 1; queue[qt++] = k; seeded++; } });
    }
    while (qh < qt) {
      const k = queue[qh++], i = k % nx, j = (k / nx) | 0;
      const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
      for (const m of nb) if (m >= 0 && free[m] && !seen[m]) { seen[m] = 1; queue[qt++] = m; }
    }
    const reached = {};
    for (const t of targets) {
      let ok = false;
      for (const z of t.zones) { cellsIn(z, k => { if (seen[k]) ok = true; }); if (ok) break; }
      reached[t.uid] = ok;
    }
    return { doorBlocked: seeded === 0, reached };
  }

  function accessTargets(items, rules) {
    const step = rules.gridCm;
    const r = rules.walkWidthCm / 2;
    const out = [];
    for (const it of items) {
      if (it.elev >= FLOOR_LEVEL || it.category === 'chair' && it.pairedWith) continue;
      const rect = RF.rectOf(it), zones = [];
      const f = RF.requiredFront(it, rules);
      if (f > 0) zones.push(RF.zoneRect(rect, it.facing, Math.max(f, r + step * 1.5)));
      if (it.category === 'bed') RF.perp(it.facing).forEach(d => zones.push(RF.zoneRect(rect, d, Math.max(RF.requiredSide(it, rules), r + step * 1.5))));
      if (zones.length) out.push({ uid: it.uid, zones });
    }
    return out;
  }

  function floorRects(room, items) {
    return items.filter(i => i.elev < FLOOR_LEVEL).map(RF.rectOf)
      .concat((room.obstacles || []).map(o => ({ x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.d })));
  }

  /** Widest walkway (cm, 10 cm steps) that still connects the door to every usable zone. */
  RF.maxWalkWidth = function (room, items, rules) {
    rules = rules || RF.effectiveRules();
    const doors = (room.openings || []).filter(o => o.type === 'door');
    if (!doors.length) return null;
    const rects = floorRects(room, items);
    for (let w = 200; w >= 30; w -= 10) {
      const rr = Object.assign({}, rules, { walkWidthCm: w });
      const c = circulation(room, rects, doors, accessTargets(items, rr), w, rules.gridCm);
      if (!c.doorBlocked && Object.values(c.reached).every(Boolean)) return w;
    }
    return 0;
  };

  /* ---------- validation ---------- */

  /**
   * Validate an arrangement. ctx: { rules, constraints, budget, skipCirculation, computeMaxWidth, focus:Set<uid> }
   * Returns { ok, items: {uid: {status, checks[]}}, violations[], circulation, budget, rules }
   */
  RF.validate = function (room, items, ctx) {
    ctx = ctx || {};
    const rules = RF.effectiveRules(ctx.rules, ctx.constraints);
    const cons = ctx.constraints || {};
    const bodies = items.map(it => ({ id: it.uid, label: it.name, it, r: RF.rectOf(it), z0: it.elev || 0, z1: (it.elev || 0) + it.h }));
    const obst = (room.obstacles || []).map(o => ({ id: o.id, label: o.label || 'Fixed object', r: { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.d }, z0: 0, z1: o.h || 250, fixed: true }));
    const openings = room.openings || [];
    const doors = openings.filter(o => o.type === 'door'), wins = openings.filter(o => o.type === 'window');
    const focus = ctx.focus || null;
    const out = { items: {}, violations: [], ok: true, rules, circulation: { status: 'skipped' } };

    for (const b of bodies) {
      const it = b.it, r = b.r, checks = [];
      const full = !focus || focus.has(it.uid);
      const add = (id, label, status, detail, extra) => checks.push(Object.assign({ id, label, status, detail, sev: 0 }, extra || {}));

      if (full) {
        // A. fits inside the room
        const ov = { west: -r.x0, east: r.x1 - room.width, north: -r.y0, south: r.y1 - room.length };
        const past = Object.keys(ov).filter(k => ov[k] > EPS);
        if (past.length) add('inside', 'Fits inside room', 'fail', past.map(k => `Extends ${Math.round(ov[k])} cm past the ${k} wall`).join('; '), { sev: past.reduce((s, k) => s + ov[k], 0) * 3 });
        else add('inside', 'Fits inside room', 'pass', 'Inside the walls');

        // A. collisions with furniture and fixed objects
        const hits = [];
        for (const o of bodies.concat(obst)) {
          if (o === b || (o.it && paired(it, o.it))) continue;
          if (!vOverlap(b.z0, b.z1, o.z0, o.z1)) continue;
          const v = overlap(r, o.r);
          if (v.ox > EPS && v.oy > EPS) hits.push({ o, v });
        }
        if (hits.length) add('collision', 'No collisions', 'fail', hits.map(h => `Overlaps ${h.o.label} by ${Math.round(h.v.ox)} × ${Math.round(h.v.oy)} cm`).join('; '), { sev: hits.reduce((s, h) => s + h.v.ox * h.v.oy / 50, 0), with: hits.map(h => h.o.id) });
        else add('collision', 'No collisions', 'pass', 'Clear of walls, fixtures and furniture');

        // C. door swing + entrance landing
        let worst = null;
        for (const d of doors) {
          if (b.z0 >= (d.height || 210)) continue;
          const sw = RF.doorSweep(room, d, [b]);
          if (sw.maxAngle < rules.doorOpenAngleDeg && (!worst || sw.maxAngle < worst.a)) worst = { a: sw.maxAngle, d };
          if (rules.doorLandingCm > 0 && intersects(r, RF.openingZone(room, d, rules.doorLandingCm)) && !(worst && worst.d === d)) {
            const v = overlap(r, RF.openingZone(room, d, rules.doorLandingCm));
            add('landing', 'Entrance kept clear', 'fail', `Sits ${Math.round(Math.min(v.ox, v.oy))} cm into the ${rules.doorLandingCm} cm landing in front of ${d.label || 'the door'}`, { sev: v.ox * v.oy / 50 });
          }
        }
        if (worst) add('door', 'Door opens', 'fail', `Blocks ${worst.d.label || 'the door'}: it opens only ${worst.a}° of ${rules.doorOpenAngleDeg}°`, { sev: (rules.doorOpenAngleDeg - worst.a) * 3, required: rules.doorOpenAngleDeg, available: worst.a, unit: '°' });
        else if (doors.length) add('door', 'Door opens', 'pass', 'Door swing is clear');

        // A. windows: tall furniture may not cover them
        for (const w of wins) {
          const zone = RF.openingZone(room, w, rules.windowZoneDepthCm);
          if (!intersects(r, zone)) continue;
          const sill = w.sill != null ? w.sill : rules.windowSillCm, top = sill + (w.height || 120);
          if (vOverlap(b.z0, b.z1, sill, top)) add('window', 'Window kept clear', 'fail', `${Math.round(b.z1)} cm tall — covers ${w.label || 'the window'} (sill at ${sill} cm)`, { sev: 40 });
          else add('window', 'Window kept clear', 'pass', `Sits below the window sill (${Math.round(b.z1)} cm < ${sill} cm)`);
        }

        // wall mounting
        if (it.wallMount) {
          const dw = Math.min(r.x0, room.width - r.x1, r.y0, room.length - r.y1);
          if (cons.wall_mount_allowed === false) add('wallmount', 'Wall mounting', 'fail', 'Needs wall mounting, which you switched off', { sev: 30 });
          else if (dw > rules.wallMountToleranceCm) add('wallmount', 'Wall mounting', 'fail', `Must be fixed to a wall — currently ${Math.round(dw)} cm away`, { sev: dw });
          else add('wallmount', 'Wall mounting', 'pass', 'Against a wall for mounting');
        }
      }

      // D. usage clearances (always evaluated — new items can block existing ones)
      if (b.z0 < FLOOR_LEVEL) {
        const blockers = bodies.filter(o => o !== b && !paired(it, o.it) && o.z0 < FLOOR_LEVEL).concat(obst);
        const fr = RF.requiredFront(it, rules);
        if (fr > 0) {
          const g = RF.gapDir(r, it.facing, blockers, room);
          const what = it.door >= it.front && it.door >= it.drawer && it.door > 0 ? 'door opening' : it.drawer > it.front ? 'drawer opening' : it.category === 'bed' ? 'foot of the bed' : it.category === 'desk' ? 'seating' : 'front access';
          const avail = Math.min(g.gap, 999);
          if (g.gap + EPS < fr) add('front', 'Front clearance', 'fail', `Needs ${fr} cm for ${what}; ${avail} cm available (limited by ${g.by})`, { required: fr, available: avail, unit: 'cm', by: g.by, sev: (fr - g.gap) });
          else add('front', 'Front clearance', 'pass', `${fr} cm needed for ${what}; ${avail >= 300 ? '300+' : avail} cm available`, { required: fr, available: avail, unit: 'cm' });
        }
        const sr = RF.requiredSide(it, rules);
        if (sr > 0) {
          const need = rules.bedSides;
          const gs = RF.perp(it.facing).map(d => RF.gapDir(r, d, blockers, room));
          const okSides = gs.filter(g => g.gap + EPS >= sr).length;
          const best = Math.max(gs[0].gap, gs[1].gap);
          const txt = `${gs[0].gap} cm and ${gs[1].gap} cm beside the bed`;
          if (okSides < need) add('side', 'Bed access', 'fail', `Needs ${sr} cm on ${need === 2 ? 'both sides' : 'at least one side'}; ${txt}`, { required: sr, available: need === 2 ? Math.min(gs[0].gap, gs[1].gap) : best, unit: 'cm', sev: sr - (need === 2 ? Math.min(gs[0].gap, gs[1].gap) : best) });
          else add('side', 'Bed access', 'pass', `${sr} cm needed on ${need === 2 ? 'both sides' : 'one side'}; ${txt}`, { required: sr, available: best, unit: 'cm' });
        }
        if (it.back > 0) {
          const g = RF.gapDir(r, OPP[it.facing], blockers, room);
          if (g.gap + EPS < it.back) add('back', 'Room behind seat', 'fail', `Needs ${it.back} cm behind to move; ${g.gap} cm available (limited by ${g.by})`, { required: it.back, available: g.gap, unit: 'cm', sev: it.back - g.gap });
          else add('back', 'Room behind seat', 'pass', `${it.back} cm needed behind; ${Math.min(g.gap, 300)} cm available`, { required: it.back, available: g.gap, unit: 'cm' });
        }
      }

      out.items[it.uid] = { checks, status: 'pass' };
    }

    // E. circulation
    if (!ctx.skipCirculation) {
      if (!doors.length) out.circulation = { status: 'unknown', detail: 'Add a door to check walking paths' };
      else {
        const targets = accessTargets(items, rules);
        const c = circulation(room, floorRects(room, items), doors, targets, rules.walkWidthCm, rules.gridCm);
        const unreachable = c.doorBlocked ? targets.map(t => t.uid) : targets.filter(t => !c.reached[t.uid]).map(t => t.uid);
        out.circulation = { status: c.doorBlocked || unreachable.length ? 'fail' : 'pass', walkWidth: rules.walkWidthCm, doorBlocked: c.doorBlocked, unreachable };
        for (const t of targets) {
          const ok = !unreachable.includes(t.uid);
          out.items[t.uid].checks.push({ id: 'access', label: 'Walking path', status: ok ? 'pass' : 'fail', sev: ok ? 0 : 25,
            detail: ok ? `Reachable from the door by a ${rules.walkWidthCm} cm walkway` : c.doorBlocked ? `The entrance is blocked — no ${rules.walkWidthCm} cm path starts at the door` : `No ${rules.walkWidthCm} cm walkway from the door reaches it` });
        }
        if (ctx.computeMaxWidth) out.circulation.maxWidth = RF.maxWalkWidth(room, items, rules);
      }
    }

    for (const it of items) {
      const rec = out.items[it.uid];
      rec.status = rec.checks.some(c => c.status === 'fail') ? 'fail' : rec.checks.some(c => c.status === 'warn') ? 'warn' : 'pass';
      for (const c of rec.checks) if (c.status === 'fail') out.violations.push({ uid: it.uid, name: it.name, id: c.id, label: c.label, detail: c.detail, sev: c.sev });
    }
    if (out.circulation.status === 'fail' && out.circulation.doorBlocked && !out.violations.some(v => v.id === 'access')) {
      out.violations.push({ uid: null, name: 'Room', id: 'access', label: 'Walking path', detail: 'The entrance is blocked', sev: 25 });
    }
    out.ok = out.violations.length === 0;

    const total = items.filter(i => !i.existing).reduce((s, i) => s + (i.price || 0), 0);
    out.budget = { total, budget: ctx.budget || null };
    if (ctx.budget) { out.budget.remaining = ctx.budget - total; out.budget.over = Math.max(0, total - ctx.budget); }
    return out;
  };

  RF.severity = v => v.violations.reduce((s, x) => s + (x.sev || 1), 0);

  /** Group per-item checks into the headline rows shown for a layout. */
  RF.summarize = function (v) {
    const groups = [
      ['collision', 'No collisions', ['collision']],
      ['fits', 'Furniture fits inside the room', ['inside']],
      ['door', 'Door opens fully', ['door', 'landing']],
      ['clearance', 'Required clearance maintained', ['front', 'side', 'back']],
      ['window', 'Windows kept clear', ['window']],
      ['mount', 'Wall-mount rules respected', ['wallmount']],
      ['access', 'Walking path from the door', ['access']]
    ];
    const all = Object.values(v.items).flatMap(i => i.checks);
    const rows = [];
    for (const [id, label, ids] of groups) {
      const cs = all.filter(c => ids.includes(c.id));
      if (!cs.length && id !== 'access') continue;
      const fails = v.violations.filter(x => ids.includes(x.id));
      rows.push({ id, label, status: fails.length ? 'fail' : cs.length ? 'pass' : 'unknown', fails });
    }
    if (v.circulation.status === 'unknown') { const a = rows.find(r => r.id === 'access'); if (a) { a.status = 'unknown'; a.note = v.circulation.detail; } }
    if (v.budget && v.budget.budget) rows.push({ id: 'budget', label: 'Within budget', status: v.budget.over > 0 ? 'fail' : 'pass', fails: [], budget: v.budget });
    return rows;
  };

  /** Smallest straight move that makes this item valid without adding failures elsewhere. */
  RF.suggestFix = function (room, items, uid, ctx) {
    const idx = items.findIndex(i => i.uid === uid);
    if (idx < 0) return null;
    const focus = new Set([uid]);
    const vctx = Object.assign({}, ctx, { skipCirculation: true, focus });
    const base = RF.validate(room, items, vctx);
    if (base.items[uid].status !== 'fail') return null;
    const baseOthers = base.violations.filter(v => v.uid !== uid).length;
    const dirs = [['left', -1, 0, 'west'], ['right', 1, 0, 'east'], ['up', 0, -1, 'north'], ['down', 0, 1, 'south']];
    for (let s = 2; s <= 300; s += 2) {
      for (const [name, dx, dy, wall] of dirs) {
        const t = items.slice();
        t[idx] = Object.assign({}, items[idx], { x: items[idx].x + dx * s, y: items[idx].y + dy * s });
        const v = RF.validate(room, t, vctx);
        if (v.items[uid].status !== 'fail' && v.violations.filter(x => x.uid !== uid).length <= baseOthers) {
          return { dir: name, cm: s, x: t[idx].x, y: t[idx].y, text: `Move it ${s} cm ${name} (toward the ${wall} wall).` };
        }
      }
    }
    return null;
  };

  /* ---------- candidate placements ---------- */

  RF.candidatePositions = function (room, p, o) {
    o = o || {};
    const step = o.step || 10, out = [], W = room.width, L = room.length;
    const walls = [['N', 'S'], ['S', 'N'], ['W', 'E'], ['E', 'W']];
    for (const [wall, f] of walls) {
      const len = (wall === 'N' || wall === 'S') ? W : L;
      const lo = p.w / 2, hi = len - p.w / 2;
      if (hi < lo - EPS) continue;
      const pos = new Set([lo, hi]);
      for (let t = lo; t <= hi + EPS; t += step) pos.add(Math.round(t * 10) / 10);
      (room.openings || []).forEach(op => {
        if (op.wall !== wall) return;
        [op.offset - p.w / 2, op.offset + op.width + p.w / 2, op.offset + op.width / 2].forEach(t => { if (t >= lo - EPS && t <= hi + EPS) pos.add(Math.round(t * 10) / 10); });
      });
      for (const t of pos) {
        let x, y;
        if (wall === 'N') { x = t; y = p.d / 2; }
        else if (wall === 'S') { x = t; y = L - p.d / 2; }
        else if (wall === 'W') { x = p.d / 2; y = t; }
        else { x = W - p.d / 2; y = t; }
        out.push({ x, y, facing: f, wall });
      }
    }
    if (o.floating) {
      const fs = ['N', 'E', 'S', 'W'];
      for (let y = 40; y <= L - 40; y += 20) for (let x = 40; x <= W - 40; x += 20) for (const f of fs) out.push({ x, y, facing: f, wall: null });
    }
    return out;
  };

  /**
   * "Will it fit?" — search placements for one item among existing ones.
   * Returns { ok, item, validation, closest } — when it doesn't fit, item/validation describe the nearest miss.
   */
  RF.findPlacement = function (room, base, proto, ctx) {
    // ctx.placementFilter / ctx.extraCandidates let callers target one wall or an existing footprint
    let cands = RF.candidatePositions(room, proto, { floating: true, step: 5 });
    if (ctx && ctx.placementFilter) cands = cands.filter(ctx.placementFilter);
    if (ctx && ctx.extraCandidates) cands = ctx.extraCandidates.concat(cands);
    const focus = new Set([proto.uid]);
    const oks = [];
    let closest = null;
    for (const c of cands) {
      const it = Object.assign({}, proto, { x: c.x, y: c.y, facing: c.facing });
      const v = RF.validate(room, base.concat(it), Object.assign({}, ctx, { skipCirculation: true, focus }));
      const mine = v.violations.filter(x => x.uid === it.uid);
      if (!mine.length) oks.push(it);
      else {
        const sev = mine.reduce((s, x) => s + (x.sev || 1), 0);
        if (!closest || sev < closest.sev) closest = { sev, it };
      }
    }
    // among geometrically valid spots, keep those that also leave a walking path; prefer the widest path
    let best = null;
    const stride = Math.max(1, Math.floor(oks.length / 24));
    for (let i = 0; i < oks.length; i += stride) {
      const v = RF.validate(room, base.concat(oks[i]), Object.assign({}, ctx, { computeMaxWidth: true }));
      if (v.items[oks[i].uid].status === 'fail') { if (!closest) closest = { sev: 1, it: oks[i] }; continue; }
      const w = v.circulation.maxWidth || 0;
      if (!best || w > best.w) best = { w, it: oks[i], v };
    }
    // caller-seeded spots (e.g. the footprint being replaced) win when they pass every check
    const nExtra = ctx && ctx.extraCandidates ? ctx.extraCandidates.length : 0;
    for (let i = 0; i < nExtra; i++) {
      const c = cands[i], it = oks.find(o => o.x === c.x && o.y === c.y && o.facing === c.facing);
      if (!it) continue;
      const v = RF.validate(room, base.concat(it), Object.assign({}, ctx, { computeMaxWidth: true }));
      if (v.items[it.uid].status !== 'fail') return { ok: true, item: it, validation: v, tested: cands.length };
    }
    if (best) return { ok: true, item: best.it, validation: best.v, tested: cands.length };
    if (!closest) return { ok: false, item: null, validation: null, tested: cands.length };
    const v = RF.validate(room, base.concat(closest.it), Object.assign({}, ctx, { computeMaxWidth: true }));
    return { ok: false, item: closest.it, validation: v, tested: cands.length };
  };

  RF.wallOf = function (room, it) {
    const r = RF.rectOf(it);
    const d = { W: r.x0, E: room.width - r.x1, N: r.y0, S: room.length - r.y1 };
    const k = Object.keys(d).sort((a, b) => d[a] - d[b])[0];
    return d[k] <= 2 ? k : null;
  };
})(window.RF = window.RF || {});
