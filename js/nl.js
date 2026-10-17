/*
 * ROOMFIT built-in requirement parser. Deterministic, offline. Converts plain language into the same
 * structured shape the Gemini provider returns:
 * { intent, budget, people, purpose, required[], constraints{}, style[], understood[] }
 */
(function (RF) {
  'use strict';

  const NUM = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2 };
  const FURN = [
    [/\b(queen|king|single|double|twin)?\s*(size\s*)?(bed|cot)s?\b(?!\s*side)/, 'bed'],
    [/\bwardrobes?|almirahs?|closets?\b/, 'wardrobe'],
    [/\bdressing table|vanity\b/, 'dressing_table'],
    [/\b(bedside|night ?stand)s?( table)?\b/, 'bedside'],
    [/\b(desk|study table|work ?table|workstation)s?\b/, 'desk'],
    [/\b(gaming|office|desk)?\s*chairs?\b/, 'chair'],
    [/\b(book ?shel(f|ves)|book ?cases?)\b/, 'bookshelf'],
    [/\b(chest of drawers|drawers|cabinet|storage unit|cube storage)\b/, 'storage'],
    [/\b(sofa|couch|settee)s?\b/, 'sofa'],
    [/\barm ?chairs?\b/, 'armchair'],
    [/\bcoffee tables?\b/, 'coffee_table'],
    [/\btv (unit|stand|cabinet)\b/, 'tv_unit'],
    [/\bwall shel(f|ves)\b/, 'wall_shelf']
  ];
  const STYLES = ['minimal', 'modern', 'industrial', 'classic', 'scandinavian', 'traditional', 'rustic', 'contemporary'];
  const CAT_WORDS = { desk: /\b(desk|study|gaming|workspace|work)\b/, bed: /\bbed\b/, wardrobe: /\bwardrobe\b/, sofa: /\b(sofa|couch)\b/, bookshelf: /\bbook ?shel/ };

  function money(t) {
    const re = /(?:₹|rs\.?|inr|rupees)\s*([\d,]+(?:\.\d+)?)\s*(k|lakh|lakhs|l)?\b|(?:under|within|budget(?: of| is)?|up ?to|max(?:imum)?|have|spend|about|around)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*(k|lakh|lakhs|l)?\b|\b([\d,]+(?:\.\d+)?)\s*(k|lakh|lakhs)\b/i;
    const m = t.match(re);
    if (!m) return null;
    const raw = (m[1] || m[3] || m[5]).replace(/,/g, '');
    const unit = (m[2] || m[4] || m[6] || '').toLowerCase();
    let v = parseFloat(raw);
    if (unit === 'k') v *= 1000; else if (unit.startsWith('l')) v *= 100000;
    if (!unit && v < 1000) return null;
    return Math.round(v);
  }

  function qtyBefore(t, idx) {
    const pre = t.slice(Math.max(0, idx - 12), idx).trim().split(/\s+/).pop();
    if (/^\d+$/.test(pre)) return Math.min(6, +pre);
    return NUM[pre] && pre !== 'a' && pre !== 'an' ? NUM[pre] : 1;
  }

  RF.nl = {
    parse(text, ctx) {
      ctx = ctx || {};
      const t = ' ' + text.toLowerCase().replace(/[’']/g, "'") + ' ';
      const r = { intent: 'update', required: [], constraints: {}, style: [], understood: [] };
      const say = s => r.understood.push(s);

      if (/\bwhy\b|\bexplain\b|reason/.test(t)) { r.intent = 'explain'; say('Explain the current layout'); }
      if (/cheap|lowest (cost|price)|least expensive|budget[- ]friendly|save money/.test(t)) { r.intent = 'cheapest'; say('Show the lowest-cost valid layout'); }

      const b = money(t);
      if (b) { r.budget = b; say(`Budget ₹${RF.fmt(b)}`); }

      const pm = t.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(people|persons|guests|members|adults|of us)\b/);
      if (pm) { r.people = /\d/.test(pm[1]) ? +pm[1] : NUM[pm[1]]; say(`${r.people} people`); }

      // purposes
      const purposes = [];
      if (/\bstudy\b|\bwork from home\b|\bhome office\b|\bwfh\b/.test(t)) purposes.push('study');
      if (/\bgaming\b|\bgamer\b/.test(t)) purposes.push('gaming');
      if (/\bliving( room)?\b|\blounge\b/.test(t)) purposes.push('living');
      if (/\bbedroom\b|\bsleep\b/.test(t)) purposes.push('bedroom');
      if (purposes.length) { r.purpose = purposes.join('+'); say(`Room for ${purposes.join(' + ')}`); }

      // explicit furniture
      const found = {};
      for (const [re, cat] of FURN) {
        const g = new RegExp(re.source, 'g');
        let m;
        while ((m = g.exec(t))) {
          if (cat === 'chair' && /arm ?chair/.test(t.slice(m.index - 4, m.index + m[0].length))) continue;
          if (cat === 'storage' && /chest of drawers/.test(t) && m[0] === 'drawers') continue;
          if (found[cat]) continue;
          found[cat] = { category: cat, qty: qtyBefore(t, m.index) };
          if (cat === 'bed' && m[1]) found[cat].hint = m[1] === 'twin' ? 'single' : m[1];
          if ((cat === 'desk' || cat === 'chair') && /gaming/.test(t)) found[cat].hint = 'gaming';
        }
      }
      // purpose → implied furniture (only if not stated explicitly)
      const want = c => { if (!found[c]) found[c] = { category: c, qty: 1, implied: true }; };
      if (purposes.includes('study') || purposes.includes('gaming')) { want('desk'); if (/gaming/.test(t)) found.desk.hint = 'gaming'; want('bookshelf'); }
      if (purposes.includes('bedroom')) { want('bed'); want('wardrobe'); }
      if (purposes.includes('living') || r.people >= 3) {
        want('sofa'); want('coffee_table'); want('tv_unit');
        if (r.people >= 5) { found.sofa.hint = '5-seat'; }
        else if (r.people >= 3) found.sofa.hint = '3-seat';
      }
      const isEdit = /\b(make|move|keep|put|place|change|swap|smaller|bigger|larger|more|less|remove)\b/.test(t) && !/\bi (need|want) (a|an|two|three)\b/.test(t);
      r.required = Object.values(found).filter(f => !(isEdit && f.implied));
      if (isEdit && r.required.length && !/\b(add|include|(need|want) (a|an|another|two|three|some))\b/.test(t)) r.required = [];
      if (r.required.length) say('Furniture: ' + r.required.map(f => (f.qty > 1 ? f.qty + '× ' : '') + (f.hint ? f.hint + ' ' : '') + (RF.CATEGORY_LABELS[f.category] || f.category).toLowerCase()).join(', '));

      const c = r.constraints;
      // size changes
      for (const cat of Object.keys(CAT_WORDS)) {
        if (!CAT_WORDS[cat].test(t)) continue;
        const cur = (ctx.items || []).find(i => i.category === cat);
        if (/\b(smaller|narrower|compact|less wide)\b/.test(t) && !/storage/.test(t)) {
          c[cat + '_max_width_cm'] = cur ? cur.w - 1 : (cat === 'desk' ? 120 : 150);
          say(`${RF.CATEGORY_LABELS[cat]} narrower than ${cur ? cur.w + ' cm' : c[cat + '_max_width_cm'] + ' cm'}`);
          r.resize = cat;
        } else if (/\b(bigger|larger|wider)\b/.test(t)) {
          c[cat + '_min_width_cm'] = cur ? cur.w + 1 : 140;
          say(`${RF.CATEGORY_LABELS[cat]} wider than ${cur ? cur.w : 139} cm`);
          r.resize = cat;
        }
        const mw = t.match(new RegExp(cat + '[^.]*?(?:under|max(?:imum)?|at most|up to|no (?:wider|bigger) than)\\s*(\\d{2,3})\\s*cm'));
        if (mw) { c[cat + '_max_width_cm'] = +mw[1]; say(`${RF.CATEGORY_LABELS[cat]} at most ${mw[1]} cm wide`); }
      }
      // windows / light
      const nearWin = /(near|next to|by|beside|under|facing|close to) (the )?(window|natural light|daylight|sunlight)|natural light|daylight/.test(t);
      const awayWin = /(away from|not near|far from|not under|avoid) (the )?window/.test(t);
      for (const cat of Object.keys(CAT_WORDS)) {
        if (!CAT_WORDS[cat].test(t)) continue;
        if (awayWin) { c[cat + '_avoid_window'] = true; say(`Keep the ${RF.CATEGORY_LABELS[cat].toLowerCase()} away from the window`); }
        else if (nearWin && (cat === 'desk' || /(near|next to|by|beside|under|close to) (the )?window/.test(t))) { c[cat + '_near_window'] = true; say(`Put the ${RF.CATEGORY_LABELS[cat].toLowerCase()} near the window`); }
      }
      if (/natural light|daylight|sunlight/.test(t)) { c.natural_light_priority = 'high'; }
      // storage
      if (/more storage|maximum storage|max storage|lots of storage|extra storage|storage priority/.test(t)) { c.storage_priority = 'high'; say('Storage priority: high'); }
      else if (/less storage|no (extra )?storage/.test(t)) { c.storage_priority = 'low'; say('Storage priority: low'); }
      // wall mounting
      if (/(no|don'?t|do not|not|nothing|without)[^.]{0,25}(mount|drill|wall-mounted|on the wall)|can'?t drill|rented|renting/.test(t)) { c.wall_mount_allowed = false; say('No wall mounting'); }
      else if (/wall[- ]mount(ing)? (is )?(ok|fine|allowed)|can drill/.test(t)) { c.wall_mount_allowed = true; say('Wall mounting allowed'); }
      // openness
      if (/cramped|more open|spacious|airy|more (floor )?space|breathing room|less cluttered/.test(t)) { c.openness = 'high'; say('Wider walkways (less cramped)'); }
      // door
      if (/(don'?t|do not|never|not|without) block(ing)? the door|keep the door (clear|free)|door clear|block the door/.test(t)) { c.door_keep_clear = true; say('Keep a 100 cm entry zone at the door'); }
      // accessibility
      if (/wheelchair|accessib|mobility|walker|elderly|disab/.test(t)) { c.accessibility = true; say('Accessibility clearances'); }
      // avoid
      const av = t.match(/(?:no|avoid|without|don'?t want (?:a |an |any )?)\s*(sofa|bookshelf|wardrobe|tv unit|coffee table|armchair)s?\b/);
      if (av && !/mount/.test(av[0])) { const cat = FURN.find(([re]) => re.test(av[1])); if (cat) { c.avoid = [cat[1]]; say(`Avoid ${av[1]}`); } }
      // style
      for (const s of STYLES) if (t.includes(s)) r.style.push(s);
      if (r.style.length) say('Style: ' + r.style.join(', '));

      if (!r.understood.length) r.unparsed = true;
      return r;
    }
  };
})(window.RF = window.RF || {});
