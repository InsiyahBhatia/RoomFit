/*
 * ROOMFIT furniture catalog.
 *
 * SAMPLE DATA: dimensions are typical market sizes and prices are illustrative placeholders in INR.
 * They are NOT verified listings. product_url is null on purpose — no real links are fabricated.
 * To connect a real catalog, implement a CatalogSource (see RF.catalog.registerSource) that returns
 * objects with the same shape as the entries below.
 */
(function (RF) {
  'use strict';

  function P(id, name, category, w, d, h, price, style, o) {
    return Object.assign({
      id, name, category,
      width_cm: w, depth_cm: d, height_cm: h,
      price_inr: price, style,
      requires_wall_mount: false,
      elevation_cm: 0,
      clearance_front_cm: 0, clearance_side_cm: 0,
      door_clearance_cm: 0, drawer_clearance_cm: 0, clearance_back_cm: 0,
      tags: [],
      image: null, product_url: null,
      sample: true, source: 'roomfit-sample-catalog'
    }, o || {});
  }

  const SAMPLE = [
    // Beds — front clearance is the foot of the bed, side clearance is for getting in/out
    P('bed_single_001', 'Single Bed Frame', 'bed', 100, 200, 90, 14999, ['minimal', 'modern'], { clearance_front_cm: 50, clearance_side_cm: 60, tags: ['single'] }),
    P('bed_double_001', 'Double Bed Frame', 'bed', 150, 205, 95, 21999, ['modern', 'classic'], { clearance_front_cm: 50, clearance_side_cm: 60, tags: ['double'] }),
    P('bed_queen_001', 'Queen Bed Frame', 'bed', 165, 210, 95, 25999, ['modern', 'classic'], { clearance_front_cm: 50, clearance_side_cm: 60, tags: ['queen'] }),
    P('bed_king_001', 'King Bed Frame', 'bed', 190, 215, 100, 32999, ['modern', 'classic'], { clearance_front_cm: 50, clearance_side_cm: 60, tags: ['king'] }),

    // Wardrobes — hinged doors need their swing; sliding doors need almost none
    P('ward_002', '2-Door Wardrobe', 'wardrobe', 100, 55, 200, 14500, ['modern', 'classic'], { door_clearance_cm: 52 }),
    P('ward_003', '3-Door Wardrobe', 'wardrobe', 150, 55, 200, 21000, ['modern', 'classic'], { door_clearance_cm: 52 }),
    P('ward_slide_001', 'Sliding Wardrobe', 'wardrobe', 180, 60, 210, 28500, ['modern', 'minimal'], { door_clearance_cm: 10, drawer_clearance_cm: 45 }),

    P('bedside_001', 'Bedside Table', 'bedside', 45, 40, 50, 2999, ['minimal', 'modern'], { drawer_clearance_cm: 35 }),
    P('dress_001', 'Dressing Table', 'dressing_table', 90, 45, 140, 7999, ['classic', 'modern'], { clearance_front_cm: 70, drawer_clearance_cm: 45 }),

    // Desks — front clearance covers pulling out a chair
    P('desk_001', 'Compact Study Desk', 'desk', 100, 50, 75, 5999, ['minimal', 'modern'], { clearance_front_cm: 80, tags: ['study'] }),
    P('desk_002', 'Study Desk', 'desk', 120, 60, 75, 8999, ['minimal', 'modern'], { clearance_front_cm: 80, tags: ['study'] }),
    P('desk_003', 'Gaming Desk', 'desk', 140, 70, 75, 13999, ['modern', 'industrial'], { clearance_front_cm: 90, tags: ['gaming'] }),
    P('desk_004', 'Executive Desk', 'desk', 200, 90, 76, 21999, ['classic', 'modern'], { clearance_front_cm: 90, tags: ['study'] }),
    P('desk_005', 'Corner L-Desk (bounding box)', 'desk', 160, 140, 75, 16999, ['modern', 'industrial'], { clearance_front_cm: 90, tags: ['gaming', 'study'] }),
    P('desk_wm_001', 'Floating Wall Desk', 'desk', 100, 45, 5, 6499, ['minimal', 'modern'], { requires_wall_mount: true, elevation_cm: 72, clearance_front_cm: 80, tags: ['study'] }),

    // Chairs — clearance_back_cm is the room a person needs behind the seat
    P('chair_001', 'Office Chair', 'chair', 60, 58, 95, 5499, ['minimal', 'modern'], { clearance_back_cm: 35 }),
    P('chair_002', 'Gaming Chair', 'chair', 68, 68, 125, 9999, ['modern', 'industrial'], { clearance_back_cm: 35, tags: ['gaming'] }),

    // Storage
    P('shelf_001', 'Bookshelf 80', 'bookshelf', 80, 30, 180, 5499, ['minimal', 'modern'], { clearance_front_cm: 60 }),
    P('shelf_002', 'Bookshelf 100', 'bookshelf', 100, 35, 200, 8499, ['classic', 'modern'], { clearance_front_cm: 60 }),
    P('cube_001', 'Cube Storage Unit', 'storage', 80, 35, 110, 4299, ['minimal', 'modern'], { clearance_front_cm: 50 }),
    P('chest_001', 'Chest of Drawers', 'storage', 90, 45, 85, 7999, ['classic', 'modern'], { drawer_clearance_cm: 55 }),
    P('wallshelf_001', 'Wall Shelf Set', 'wall_shelf', 80, 25, 25, 1499, ['minimal', 'modern'], { requires_wall_mount: true, elevation_cm: 130 }),

    // Living room & dining
    P('sofa_002', '2-Seater Sofa', 'sofa', 150, 85, 80, 18999, ['modern', 'minimal'], { clearance_front_cm: 90, tags: ['2-seat'] }),
    P('sofa_003', '3-Seater Sofa', 'sofa', 200, 90, 80, 27999, ['modern', 'classic'], { clearance_front_cm: 90, tags: ['3-seat'] }),
    P('sofa_L_001', 'L-Shaped Sectional', 'sofa', 240, 160, 82, 44999, ['modern'], { clearance_front_cm: 90, tags: ['5-seat', 'sectional'] }),
    P('arm_001', 'Armchair', 'armchair', 75, 80, 85, 9999, ['classic', 'modern'], { clearance_front_cm: 60 }),
    P('coffee_001', 'Coffee Table', 'coffee_table', 90, 50, 42, 4999, ['minimal', 'modern'], {}),
    P('tv_001', 'TV Console Unit', 'tv_unit', 160, 40, 50, 9499, ['modern', 'minimal'], { drawer_clearance_cm: 45 }),
    P('dining_001', '4-Seater Dining Table', 'dining', 120, 80, 75, 12999, ['modern', 'minimal'], { clearance_front_cm: 75, clearance_side_cm: 60 }),
    P('shoe_001', 'Entryway Shoe Cabinet', 'storage', 80, 32, 95, 4999, ['minimal'], { door_clearance_cm: 32 })
  ];

  function getCustomItems() {
    try {
      const raw = localStorage.getItem('rf.custom_items');
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveCustomItems(list) {
    try {
      localStorage.setItem('rf.custom_items', JSON.stringify(list));
    } catch (e) {}
  }

  const sources = [() => SAMPLE, () => getCustomItems()];

  RF.catalog = {
    /** Plug in a real catalog: fn returns an array of products in the shape above. */
    registerSource(fn) { sources.push(fn); },
    list() { return sources.flatMap(s => s()); },
    get(id) { return this.list().find(p => p.id === id) || null; },
    categories() { return Array.from(new Set(this.list().map(p => p.category))); },
    getCustomList() { return getCustomItems(); },
    addCustom(p) {
      const list = getCustomItems();
      const id = p.id || ('custom_' + Date.now());
      const item = P(id, p.name || 'Custom Piece', p.category || 'other', +p.width_cm, +p.depth_cm, +p.height_cm, +p.price_inr || 0, p.style || ['modern'], {
        clearance_front_cm: +p.clearance_front_cm || 0,
        clearance_side_cm: +p.clearance_side_cm || 0,
        door_clearance_cm: +p.door_clearance_cm || 0,
        drawer_clearance_cm: +p.drawer_clearance_cm || 0,
        requires_wall_mount: !!p.requires_wall_mount,
        sample: false,
        custom: true,
        source: 'user-custom'
      });
      list.unshift(item);
      saveCustomItems(list);
      return item;
    },
    removeCustom(id) {
      const list = getCustomItems().filter(x => x.id !== id);
      saveCustomItems(list);
    }
  };

  RF.CATEGORY_LABELS = {
    bed: 'Bed', wardrobe: 'Wardrobe', bedside: 'Bedside table', dressing_table: 'Dressing table',
    desk: 'Desk', chair: 'Chair', bookshelf: 'Bookshelf', storage: 'Storage', wall_shelf: 'Wall shelf',
    sofa: 'Sofa', armchair: 'Armchair', coffee_table: 'Coffee table', tv_unit: 'TV unit',
    dining: 'Dining table', other: 'Custom item'
  };

  RF.CATEGORY_COLORS = {
    bed: '#8FA3B8', wardrobe: '#A58E74', bedside: '#B9A98F', dressing_table: '#C2A3A3', desk: '#7FA39A',
    chair: '#6E7F8C', bookshelf: '#9C8B6B', storage: '#A39A82', wall_shelf: '#B5AE9A', sofa: '#8894A8',
    armchair: '#9A8FA8', coffee_table: '#B6A27F', tv_unit: '#75808A', dining: '#93A47A', other: '#9AA3A8'
  };

  RF.STORAGE_CATEGORIES = ['wardrobe', 'bookshelf', 'storage', 'dressing_table'];

  const REAL_PRODUCT_IMAGES = {
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

  RF.furnitureImage = function (p) {
    if (p && p.imageUrl && String(p.imageUrl).startsWith('https://') && !p.imageUrl.includes('unsplash.com')) {
      return p.imageUrl;
    }
    const name = String((p && p.name) || '');
    const cat = RF.shopCategory ? RF.shopCategory(((p && p.category) || '') + ' ' + name) : ((p && p.category) || 'sofa');
    const text = `${name} ${(p && p.brand) || ''} ${(p && p.category) || ''} ${(p && p.material) || ''} ${(p && p.color) || ''}`.toLowerCase();
    let bucket = 'storage';
    if (cat === 'wardrobe') bucket = 'wardrobe';
    else if (cat === 'desk') bucket = 'desk';
    else if (cat === 'bed') bucket = 'bed';
    else if (cat === 'sofa') bucket = 'sofa';
    else if (cat === 'chair' || cat === 'armchair') bucket = 'chair';
    const list = REAL_PRODUCT_IMAGES[bucket] || REAL_PRODUCT_IMAGES.wardrobe;
    const item = list.find(x => x.match.test(text));
    return item ? item.url : list[list.length - 1].url;
  };
})(window.RF = window.RF || {});
