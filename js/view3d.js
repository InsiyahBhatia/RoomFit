/* ROOMFIT 3D room (Three.js r147, 1 unit = 1 cm). Plan (x, y) maps to world (x, z); height is world y. */
(function (RF) {
  'use strict';

  const ROT = { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 };

  function css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  RF.View3D = function (container, cb) {
    cb = cb || {};
    if (!window.THREE) { container.innerHTML = '<p class="stage-error">The 3D view needs Three.js, which could not load. Check your connection — the 2D checks still work.</p>'; return null; }
    const THREE = window.THREE;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    container.appendChild(renderer.domElement);

    const label = document.createElement('div');
    label.className = 'stage-label';
    label.hidden = true;
    container.appendChild(label);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 5, 20000);
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.minDistance = 150;
    controls.maxDistance = 3000;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a96a0, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 0.55);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);
    scene.add(sun.target);

    const roomG = new THREE.Group(), itemsG = new THREE.Group(), zonesG = new THREE.Group();
    scene.add(roomG, itemsG, zonesG);

    let room = null, items = [], validation = null, selected = null, zonesMode = 'selected', rules = RF.effectiveRules();
    let walls = [];
    const meshes = {};
    let camAnim = null, view = 'persp';
    const center = new THREE.Vector3();

    const mats = {};
    function mat(color, o) {
      const k = color + JSON.stringify(o || {});
      if (!mats[k]) mats[k] = new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.82, metalness: 0.02 }, o || {}));
      return mats[k];
    }

    /* ---------- room ---------- */

    function box(w, h, d, m, x, y, z) {
      const me = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      me.position.set(x, y, z); me.castShadow = true; me.receiveShadow = true;
      return me;
    }

    function buildRoom() {
      roomG.clear(); walls = [];
      if (!room) return;
      const W = room.width, L = room.length, H = room.height || 270, T = 10;
      center.set(W / 2, 0, L / 2);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, L), new THREE.MeshStandardMaterial({ color: css('--floor-3d', '#cdbb9b'), roughness: 0.9 }));
      floor.rotation.x = -Math.PI / 2; floor.position.set(W / 2, 0, L / 2); floor.receiveShadow = true;
      roomG.add(floor);
      const gp = [];
      for (let x = 50; x < W; x += 50) gp.push(x, 0.3, 0, x, 0.3, L);
      for (let z = 50; z < L; z += 50) gp.push(0, 0.3, z, W, 0.3, z);
      const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
      roomG.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: css('--grid-3d', '#b09f80'), transparent: true, opacity: 0.35 })));

      const wallColor = css('--wall-3d', '#e9ecee');
      for (const wall of ['N', 'E', 'S', 'W']) {
        const m = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.95, transparent: true, opacity: 1 });
        const g = new THREE.Group();
        const len = (wall === 'N' || wall === 'S') ? W : L;
        const ops = (room.openings || []).filter(o => o.wall === wall).sort((a, b) => a.offset - b.offset);
        const seg = (a, b, y0, y1) => {
          if (b - a < 0.5 || y1 - y0 < 0.5) return;
          const mid = (a + b) / 2, h = y1 - y0, cy = (y0 + y1) / 2;
          let me;
          if (wall === 'N') me = box(b - a, h, T, m, mid, cy, -T / 2);
          else if (wall === 'S') me = box(b - a, h, T, m, mid, cy, L + T / 2);
          else if (wall === 'W') me = box(T, h, b - a, m, -T / 2, cy, mid);
          else me = box(T, h, b - a, m, W + T / 2, cy, mid);
          me.castShadow = false;
          g.add(me);
        };
        let t = 0;
        for (const op of ops) {
          seg(t, op.offset, 0, H);
          if (op.type === 'door') seg(op.offset, op.offset + op.width, op.height || 210, H);
          else {
            const sill = op.sill != null ? op.sill : 90, top = sill + (op.height || 120);
            seg(op.offset, op.offset + op.width, 0, sill);
            seg(op.offset, op.offset + op.width, top, H);
            const glass = new THREE.MeshStandardMaterial({ color: 0x9fc4dc, transparent: true, opacity: 0.35, roughness: 0.1 });
            const mid = op.offset + op.width / 2;
            const gl = (wall === 'N' || wall === 'S') ? box(op.width, top - sill, 1.5, glass, mid, (sill + top) / 2, wall === 'N' ? -T / 2 : L + T / 2) : box(1.5, top - sill, op.width, glass, wall === 'W' ? -T / 2 : W + T / 2, (sill + top) / 2, mid);
            gl.castShadow = false; g.add(gl);
          }
          t = op.offset + op.width;
        }
        seg(t, len, 0, H);
        roomG.add(g);
        const n = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] }[wall];
        walls.push({ wall, g, m, n });
      }
      // door swings on the floor
      for (const op of (room.openings || []).filter(o => o.type === 'door' && o.swing !== 'out' && o.swing !== 'slide')) {
        const geo = RF.openingGeom(room, op);
        const th = v => Math.atan2(-v[1], v[0]);
        const a1 = th(geo.c), a2 = th(geo.n);
        let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        const start = d > 0 ? a1 : a2;
        const arc = new THREE.Mesh(new THREE.CircleGeometry(op.width, 32, start, Math.PI / 2), new THREE.MeshBasicMaterial({ color: css('--ink', '#14222c'), transparent: true, opacity: 0.07, depthWrite: false }));
        arc.rotation.x = -Math.PI / 2; arc.position.set(geo.hinge[0], 0.6, geo.hinge[1]);
        arc.userData.doorId = op.id;
        roomG.add(arc);
        const leaf = box(op.width, op.height || 210, 3.5, mat('#c9b48f'), 0, (op.height || 210) / 2, 0);
        const pivot = new THREE.Group(); pivot.position.set(geo.hinge[0], 0, geo.hinge[1]);
        leaf.position.x = op.width / 2;
        pivot.add(leaf);
        pivot.rotation.y = Math.atan2(-geo.n[1], geo.n[0]);
        roomG.add(pivot);
      }
      for (const ob of room.obstacles || []) roomG.add(box(ob.w, ob.h || 100, ob.d, mat('#8d969c'), ob.x + ob.w / 2, (ob.h || 100) / 2, ob.y + ob.d / 2));

      const S = Math.max(W, L);
      sun.position.set(W * 0.2, S * 1.6, -S * 0.4);
      sun.target.position.copy(center);
      const sc = sun.shadow.camera; sc.left = -S; sc.right = S; sc.top = S; sc.bottom = -S; sc.near = 10; sc.far = S * 5; sc.updateProjectionMatrix();
      setView(view, true);
    }

    /* ---------- furniture shapes ---------- */

    function shape(it) {
      const g = new THREE.Group();
      let c = RF.CATEGORY_COLORS[it.category] || RF.CATEGORY_COLORS.other;
      const desc = ((it.color || '') + ' ' + (it.material || '') + ' ' + (it.name || '')).toLowerCase();
      if (desc.includes('white') || desc.includes('ivory')) c = '#eaecee';
      else if (desc.includes('black') || desc.includes('charcoal')) c = '#2c3035';
      else if (desc.includes('walnut') || desc.includes('dark wood')) c = '#594030';
      else if (desc.includes('oak') || desc.includes('teak') || desc.includes('wood') || desc.includes('brown')) c = '#9e7550';

      const m = mat(c);
      const dark = mat(new THREE.Color(c).multiplyScalar(0.70).getStyle(), { metalness: 0.1, roughness: 0.7 });
      const light = mat(new THREE.Color(c).lerp(new THREE.Color('#ffffff'), 0.40).getStyle());
      const w = it.w, d = it.d, h = it.h;
      const add = (bw, bh, bd, mm, x, y, z) => { g.add(box(bw, bh, bd, mm, x, y, z)); };

      switch (it.category) {
        case 'bed':
          // 4 wooden/metal corner legs
          add(8, 14, 8, dark, -w / 2 + 6, 7, -d / 2 + 6);
          add(8, 14, 8, dark, w / 2 - 6, 7, -d / 2 + 6);
          add(8, 14, 8, dark, -w / 2 + 6, 7, d / 2 - 6);
          add(8, 14, 8, dark, w / 2 - 6, 7, d / 2 - 6);
          // Bed base / frame
          add(w, 18, d, dark, 0, 14 + 9, 0);
          // High cushioned headboard
          add(w, h, 10, m, 0, h / 2, -d / 2 + 5);
          // Headboard subtle quilted accent
          add(w - 6, h - 22, 2, light, 0, h / 2 + 6, -d / 2 + 10.5);
          // Mattress
          add(w - 6, 22, d - 12, mat('#ffffff'), 0, 23 + 11, 4);
          // Dual plush pillows
          add(Math.min(60, (w - 16) / 2), 12, 38, mat('#f4f4f0'), -w / 4, 38 + 10, -d / 2 + 32);
          if (w > 110) add(Math.min(60, (w - 16) / 2), 12, 38, mat('#f4f4f0'), w / 4, 38 + 10, -d / 2 + 32);
          // Folded throw blanket / duvet over bottom half of bed
          add(w - 4, 3, d * 0.45, light, 0, 45, d / 4 + 4);
          break;
        case 'sofa': {
          // 4 sofa legs
          add(6, 10, 6, dark, -w / 2 + 8, 5, -d / 2 + 8);
          add(6, 10, 6, dark, w / 2 - 8, 5, -d / 2 + 8);
          add(6, 10, 6, dark, -w / 2 + 8, 5, d / 2 - 8);
          add(6, 10, 6, dark, w / 2 - 8, 5, d / 2 - 8);
          // Base deck
          add(w, 16, d, dark, 0, 10 + 8, 0);
          // Armrests on left and right
          const armW = Math.min(18, Math.max(12, w * 0.1));
          add(armW, h * 0.65, d, m, -w / 2 + armW / 2, (h * 0.65) / 2 + 10, 0);
          add(armW, h * 0.65, d, m, w / 2 - armW / 2, (h * 0.65) / 2 + 10, 0);
          // Backrest
          add(w - armW * 2, h - 18, 18, m, 0, 18 + (h - 18) / 2, -d / 2 + 9);
          // Seat cushions (split into 2 or 3 depending on width)
          const seatW = w - armW * 2;
          const numCushions = w >= 175 ? 3 : 2;
          const cW = seatW / numCushions;
          for (let i = 0; i < numCushions; i++) {
            const cx = -seatW / 2 + cW * i + cW / 2;
            add(cW - 2, 14, d - 18, light, cx, 26 + 7, 7);
          }
          break;
        }
        case 'desk':
          add(w, 4, d, light, 0, h - 2, 0);
          add(4, h - 4, d - 4, dark, -w / 2 + 3, (h - 4) / 2, 0); add(4, h - 4, d - 4, dark, w / 2 - 3, (h - 4) / 2, 0);
          if (it.elev < 1) add(w - 10, 30, 2, dark, 0, h - 20, -d / 2 + 4);
          if (it.tags && it.tags.includes('gaming')) add(Math.min(70, w * 0.5), 38, 4, mat('#1f2a33'), 0, h + 24, -d / 2 + 14);
          break;
        case 'chair':
          add(w * 0.8, 8, d * 0.8, dark, 0, 46, 0);
          add(w * 0.8, h - 50, 8, m, 0, 50 + (h - 50) / 2, -d / 2 + 6);
          add(6, 42, 6, mat('#3a444c'), 0, 21, 0);
          add(w * 0.8, 3, d * 0.8, mat('#3a444c'), 0, 2, 0);
          break;
        case 'wardrobe': {
          // Recessed plinth base
          add(w - 2, 8, d - 2, dark, 0, 4, -1);
          // Main carcass
          add(w, h - 12, d, m, 0, 8 + (h - 12) / 2, 0);
          // Top cornice trim
          add(w + 2, 4, d + 2, dark, 0, h - 2, 0);
          // Dynamic doors matching the width
          const n = w <= 110 ? 2 : w <= 165 ? 3 : 4;
          const doorW = w / n;
          for (let i = 1; i < n; i++) {
            add(1.2, h - 16, 1.2, dark, -w / 2 + doorW * i, (h + 4) / 2, d / 2 + 0.6);
          }
          // Ergonomic handles for each door
          for (let i = 0; i < n; i++) {
            const handleX = -w / 2 + doorW * i + (i % 2 === 0 ? doorW - 5 : 5);
            add(1.6, 22, 2.5, dark, handleX, h * 0.48, d / 2 + 1.2);
          }
          break;
        }
        case 'bookshelf': {
          add(w, h, d, m, 0, h / 2, 0);
          const lines = Math.max(3, Math.round(h / 38));
          for (let i = 1; i < lines; i++) add(w - 4, 2.5, 3, dark, 0, (h / lines) * i, d / 2 + 0.6);
          break;
        }
        case 'storage': case 'dressing_table': case 'tv_unit': {
          add(w, h, d, m, 0, h / 2, 0);
          if (it.drawer) for (let i = 1; i < 4; i++) add(w - 6, 1.4, 1.6, dark, 0, (h / 4) * i, d / 2 + 0.6);
          break;
        }
        case 'coffee_table':
          add(w, 4, d, light, 0, h - 2, 0);
          add(w - 10, 2, d - 10, dark, 0, 12, 0);
          break;
        default:
          add(w, h, d, m, 0, h / 2, 0);
      }
      return g;
    }

    function itemSig(it) { return [it.uid, it.productId, it.w, it.d, it.h, it.category, it.color, it.material].join('|'); }

    function syncItems() {
      const keep = new Set();
      for (const it of items) {
        keep.add(it.uid);
        let e = meshes[it.uid];
        if (!e || e.sig !== itemSig(it)) {
          if (e) itemsG.remove(e.g);
          const g = new THREE.Group();
          const body = shape(it);
          g.add(body);
          g.userData.uid = it.uid;
          const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(it.w + 2, it.h + 2, it.d + 2)), new THREE.LineBasicMaterial({ color: css('--tape', '#f2c12e') }));
          edges.position.y = it.h / 2; edges.visible = false;
          g.add(edges);
          itemsG.add(g);
          e = meshes[it.uid] = { g, body, edges, sig: itemSig(it) };
        }
        e.g.position.set(it.x, it.elev || 0, it.y);
        e.g.rotation.y = ROT[it.facing] || 0;
        const status = validation && validation.items[it.uid] ? validation.items[it.uid].status : 'pass';
        e.body.traverse(o => {
          if (!o.isMesh) return;
          if (!o.userData.base) o.userData.base = o.material;
          const base = o.userData.base;
          const m = status === 'fail' ? mat('#d1574b', { emissive: 0x3a0804, transparent: !!it.preview, opacity: it.preview ? 0.6 : 1 })
            : it.preview ? mat('#' + base.color.getHexString(), { transparent: true, opacity: 0.55, emissive: 0x2a2000 }) : base;
          o.material = m;
        });
        e.edges.visible = it.uid === selected;
        e.edges.material.color.set(status === 'fail' ? css('--fail', '#c23b2e') : css('--tape', '#f2c12e'));
      }
      for (const k of Object.keys(meshes)) if (!keep.has(k)) { itemsG.remove(meshes[k].g); delete meshes[k]; }
      syncZones();
    }

    function syncZones() {
      zonesG.clear();
      const ok = css('--tape', '#f2c12e'), bad = css('--fail', '#c23b2e');
      for (const it of items) {
        if (!(zonesMode === 'all' || (zonesMode === 'selected' && it.uid === selected))) continue;
        const rec = validation && validation.items[it.uid];
        for (const z of RF.zonesOf(it, rules)) {
          const fail = rec && rec.checks.some(c => c.status === 'fail' && c.id === z.kind);
          const r = z.rect, w = r.x1 - r.x0, d = r.y1 - r.y0;
          const pl = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: fail ? bad : ok, transparent: true, opacity: fail ? 0.32 : 0.22, depthWrite: false }));
          pl.rotation.x = -Math.PI / 2; pl.position.set(r.x0 + w / 2, 0.8, r.y0 + d / 2);
          zonesG.add(pl);
          const ed = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, d)), new THREE.LineDashedMaterial({ color: fail ? bad : ok, dashSize: 6, gapSize: 4 }));
          ed.rotation.x = -Math.PI / 2; ed.position.copy(pl.position); ed.computeLineDistances();
          zonesG.add(ed);
        }
      }
      const doorFail = validation && validation.violations.some(v => v.id === 'door');
      roomG.children.forEach(ch => { if (ch.userData.doorId) { ch.material.color.set(doorFail ? bad : css('--ink', '#14222c')); ch.material.opacity = doorFail ? 0.28 : 0.07; } });
    }

    /* ---------- camera ---------- */

    function camTargets(v) {
      const W = room ? room.width : 320, L = room ? room.length : 410, S = Math.max(W, L);
      const aspect = Math.max(0.5, (container.clientWidth || 1) / (container.clientHeight || 1));
      const k = aspect < 1 ? 1.35 / aspect : 1.15;
      if (v === 'top') return { pos: new THREE.Vector3(W / 2, S * 2.3 * k, L / 2 + 0.5), target: new THREE.Vector3(W / 2, 0, L / 2) };
      return { pos: new THREE.Vector3(W / 2 + S * 0.8, S * 1.45 * k, L + S * 1.25 * k), target: new THREE.Vector3(W / 2, 40, L / 2) };
    }

    function setView(v, instant) {
      view = v;
      const t = camTargets(v);
      if (instant || reduced) { camera.position.copy(t.pos); controls.target.copy(t.target); controls.update(); camAnim = null; return; }
      camAnim = { from: camera.position.clone(), fromT: controls.target.clone(), to: t.pos, toT: t.target, t0: performance.now(), dur: 650 };
    }

    /* ---------- picking + dragging ---------- */

    const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let drag = null, down = null;

    function setMouse(ev) {
      const r = renderer.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
      mouse.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(mouse, camera);
    }
    function pickItem() {
      const hits = ray.intersectObjects(itemsG.children, true);
      for (const h of hits) { let o = h.object; while (o && !o.userData.uid) o = o.parent; if (o) return o.userData.uid; }
      return null;
    }
    function floorPoint() { const p = new THREE.Vector3(); return ray.ray.intersectPlane(floorPlane, p) ? p : null; }

    const el = renderer.domElement;
    el.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      setMouse(ev);
      down = { x: ev.clientX, y: ev.clientY };
      const uid = pickItem();
      if (!uid) return;
      const it = items.find(i => i.uid === uid);
      if (cb.onSelect) cb.onSelect(uid);
      if (!it || it.locked) return;
      const p = floorPoint(); if (!p) return;
      drag = { uid, dx: p.x - it.x, dz: p.z - it.y, moved: false };
      controls.enabled = false;
      el.setPointerCapture(ev.pointerId);
      el.style.cursor = 'grabbing';
    });
    el.addEventListener('pointermove', ev => {
      setMouse(ev);
      if (drag) {
        const p = floorPoint(); if (!p) return;
        drag.moved = true;
        if (cb.onDrag) cb.onDrag(drag.uid, Math.round(p.x - drag.dx), Math.round(p.z - drag.dz));
        return;
      }
      el.style.cursor = pickItem() ? 'grab' : '';
    });
    const end = ev => {
      if (drag) {
        const d = drag; drag = null; controls.enabled = true; el.style.cursor = '';
        try { el.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        if (d.moved && cb.onDrop) cb.onDrop(d.uid);
        return;
      }
      if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 4) {
        setMouse(ev);
        if (!pickItem() && cb.onSelect) cb.onSelect(null);
      }
      down = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    /* ---------- loop ---------- */

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(container);
    resize();

    const tmp = new THREE.Vector3();
    function tick(now) {
      requestAnimationFrame(tick);
      if (document.hidden || !container.offsetParent) return;
      if (camAnim) {
        const k = Math.min(1, (now - camAnim.t0) / camAnim.dur), e = 1 - Math.pow(1 - k, 3);
        camera.position.lerpVectors(camAnim.from, camAnim.to, e);
        controls.target.lerpVectors(camAnim.fromT, camAnim.toT, e);
        if (k >= 1) camAnim = null;
      }
      controls.update();
      // cut away walls between the camera and the room
      const top = camera.position.y > Math.max(room ? room.width : 0, room ? room.length : 0) * 1.4 && Math.abs(camera.position.x - center.x) < 60 && Math.abs(camera.position.z - center.z) < 60;
      for (const w of walls) {
        const out = (camera.position.x - center.x) * w.n[0] + (camera.position.z - center.z) * w.n[1];
        const target = top ? 1 : out > 0 ? 0.1 : 1;
        w.m.opacity += (target - w.m.opacity) * 0.2;
        w.m.depthWrite = w.m.opacity > 0.9;
      }
      // floating dimension label for the selected item
      const it = selected && items.find(i => i.uid === selected);
      if (it) {
        tmp.set(it.x, (it.elev || 0) + it.h + 18, it.y).project(camera);
        const x = (tmp.x * 0.5 + 0.5) * container.clientWidth, y = (-tmp.y * 0.5 + 0.5) * container.clientHeight;
        label.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
        label.hidden = tmp.z > 1;
      } else label.hidden = true;
      renderer.render(scene, camera);
    }
    requestAnimationFrame(tick);

    return {
      setRoom(r) { room = r; Object.keys(meshes).forEach(k => { itemsG.remove(meshes[k].g); delete meshes[k]; }); buildRoom(); syncItems(); },
      setItems(list, v, sel, rl) {
        items = list; validation = v; selected = sel; if (rl) rules = rl;
        syncItems();
        const it = sel && items.find(i => i.uid === sel);
        if (it) {
          const st = v && v.items[it.uid] ? v.items[it.uid].status : 'pass';
          label.innerHTML = `<span class="num">${it.w} × ${it.d} × ${it.h} cm</span>${st === 'fail' ? '<span class="lbl-bad">Invalid placement</span>' : '<span class="lbl-ok">Position valid</span>'}`;
        }
      },
      setView,
      get view() { return view; },
      setZones(m) { zonesMode = m; syncZones(); },
      retheme() { Object.keys(mats).forEach(k => delete mats[k]); buildRoom(); Object.keys(meshes).forEach(k => { itemsG.remove(meshes[k].g); delete meshes[k]; }); syncItems(); },
      snapshot() { return renderer.domElement.toDataURL('image/png'); }
    };
  };
})(window.RF = window.RF || {});
