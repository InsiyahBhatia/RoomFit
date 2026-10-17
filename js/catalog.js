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

    // Living room
    P('sofa_002', '2-Seater Sofa', 'sofa', 150, 85, 80, 18999, ['modern', 'minimal'], { clearance_front_cm: 90, tags: ['2-seat'] }),
    P('sofa_003', '3-Seater Sofa', 'sofa', 200, 90, 80, 27999, ['modern', 'classic'], { clearance_front_cm: 90, tags: ['3-seat'] }),
    P('sofa_L_001', 'L-Shaped Sofa (bounding box)', 'sofa', 260, 160, 80, 49999, ['modern'], { clearance_front_cm: 90, tags: ['5-seat'] }),
    P('arm_001', 'Armchair', 'armchair', 75, 80, 85, 9999, ['classic', 'modern'], { clearance_front_cm: 60 }),
    P('coffee_001', 'Coffee Table', 'coffee_table', 90, 50, 42, 4999, ['minimal', 'modern'], {}),
    P('tv_001', 'TV Unit', 'tv_unit', 150, 40, 50, 8999, ['modern', 'minimal'], { drawer_clearance_cm: 45 })
  ];

  const sources = [() => SAMPLE];

  RF.catalog = {
    /** Plug in a real catalog: fn returns an array of products in the shape above. */
    registerSource(fn) { sources.push(fn); },
    list() { return sources.flatMap(s => s()); },
    get(id) { return this.list().find(p => p.id === id) || null; },
    categories() { return Array.from(new Set(this.list().map(p => p.category))); }
  };

  RF.CATEGORY_LABELS = {
    bed: 'Bed', wardrobe: 'Wardrobe', bedside: 'Bedside table', dressing_table: 'Dressing table',
    desk: 'Desk', chair: 'Chair', bookshelf: 'Bookshelf', storage: 'Storage', wall_shelf: 'Wall shelf',
    sofa: 'Sofa', armchair: 'Armchair', coffee_table: 'Coffee table', tv_unit: 'TV unit', other: 'Custom item'
  };

  RF.CATEGORY_COLORS = {
    bed: '#8FA3B8', wardrobe: '#A58E74', bedside: '#B9A98F', dressing_table: '#C2A3A3', desk: '#7FA39A',
    chair: '#6E7F8C', bookshelf: '#9C8B6B', storage: '#A39A82', wall_shelf: '#B5AE9A', sofa: '#8894A8',
    armchair: '#9A8FA8', coffee_table: '#B6A27F', tv_unit: '#75808A', other: '#9AA3A8'
  };

  RF.STORAGE_CATEGORIES = ['wardrobe', 'bookshelf', 'storage', 'dressing_table'];
})(window.RF = window.RF || {});
