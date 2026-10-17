/* ROOMFIT rules layer — every clearance number the engine uses lives here and is user-configurable. */
(function (RF) {
  'use strict';

  RF.DEFAULT_RULES = {
    walkWidthCm: 60,                 // minimum clear walkway between door and usable zones
    accessibleWalkWidthCm: 90,       // used when accessibility mode is on
    accessibilityClearanceMultiplier: 1.25,
    accessibleMinSideCm: 90,         // bed side clearance in accessibility mode
    doorOpenAngleDeg: 90,            // door must open at least this far
    doorLandingCm: 40,               // keep this depth free in front of the door opening
    windowSillCm: 90,                // default sill height when a window does not specify one
    windowZoneDepthCm: 30,           // tall furniture closer than this to a window covers it
    wallMountToleranceCm: 2,
    bedSidesRequired: 1,
    gridCm: 5,
    tuckCm: 15                       // how far a paired chair tucks under its desk
  };

  /** Merge base rules with the user's constraints into the rules actually applied. */
  RF.effectiveRules = function (rules, c) {
    const r = Object.assign({}, RF.DEFAULT_RULES, rules || {});
    c = c || {};
    r.accessibility = !!c.accessibility;
    r.walkWidthCm = c.accessibility ? Math.max(r.walkWidthCm, r.accessibleWalkWidthCm) : r.walkWidthCm;
    if (c.openness === 'high') r.walkWidthCm += 15;
    r.clearMult = c.accessibility ? r.accessibilityClearanceMultiplier : 1;
    r.bedSides = c.accessibility ? 2 : r.bedSidesRequired;
    if (c.door_keep_clear) r.doorLandingCm = Math.max(r.doorLandingCm, 100);
    return r;
  };
})(window.RF = window.RF || {});
