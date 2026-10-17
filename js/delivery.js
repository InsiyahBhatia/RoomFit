/*
 * ROOMFIT Delivery Pathway & Entryway Fit Engine
 *
 * Checks if a furniture item can physically navigate through:
 * 1. Building Entrance
 * 2. Elevator / Lift (doorway + interior cab + standing/diagonal clearance)
 * 3. Staircase & Landing Turn (flight width, ceiling height, 90°/180° corner turning)
 * 4. Apartment Front Door
 * 5. Internal Room Door
 */
(function (RF) {
  'use strict';

  // Standard architectural defaults (all dimensions in centimetres)
  const DEFAULT_PATH = {
    buildingEntry: {
      label: 'Building Entrance',
      width: 95,
      height: 215,
      threshold: 0
    },
    lift: {
      label: 'Elevator / Lift',
      doorWidth: 80,
      doorHeight: 205,
      carWidth: 110,
      carDepth: 130,
      ceilingHeight: 220,
      available: true
    },
    stairs: {
      label: 'Staircase & Landing',
      flightWidth: 95,
      ceilingHeight: 220,
      landingWidth: 120,
      landingDepth: 120,
      turnAngleDeg: 90
    },
    frontDoor: {
      label: 'Apartment Front Door',
      width: 85,
      height: 205,
      corridorWidth: 110
    },
    roomDoor: {
      label: 'Room Doorway',
      width: 85,
      height: 210,
      approachWidth: 100
    }
  };

  /**
   * Checks if an item passes through a 2D rectangular opening (doorway).
   * Can pass:
   * 1. Upright (width x height, or depth x height)
   * 2. On-end (min dimension x max dimension upright, if height <= door height)
   * 3. Diagonal tilt (tilted through the door opening)
   */
  function checkDoorway(item, door) {
    const w = item.width_cm || item.w || 0;
    const d = item.depth_cm || item.d || 0;
    const h = item.height_cm || item.h || 0;

    const dims = [w, d, h].sort((a, b) => a - b);
    const minDim = dims[0];
    const midDim = dims[1];
    const maxDim = dims[2];

    const doorW = door.width || door.doorWidth || 80;
    const doorH = door.height || door.doorHeight || 205;

    // Upright straight pass
    const uprightPassW = (w <= doorW && h <= doorH) || (d <= doorW && h <= doorH);
    if (uprightPassW) {
      const margin = Math.min(doorW - Math.min(w, d), doorH - h);
      return {
        status: margin >= 10 ? 'pass' : 'tight',
        marginCm: Math.round(margin),
        orientation: 'Upright straight pass',
        note: `Carried upright with ${Math.round(margin)} cm clearance.`
      };
    }

    // Carried on side / on-end (e.g. sofa on its side)
    const onSidePass = (minDim <= doorW && midDim <= doorH) || (minDim <= doorW && maxDim <= doorH);
    if (onSidePass) {
      const margin = doorW - minDim;
      return {
        status: margin >= 8 ? 'pass' : 'tight',
        marginCm: Math.round(margin),
        orientation: 'Turned on side / on-end',
        note: `Turned on its side (narrowest edge ${minDim} cm vs door ${doorW} cm).`
      };
    }

    // Diagonal tilt check
    // If the item can be tilted diagonally through the door opening
    const doorDiag = Math.hypot(doorW, doorH);
    if (minDim <= doorW * 1.15 && midDim <= doorDiag - 15) {
      const margin = Math.round(doorDiag - Math.hypot(minDim, midDim));
      if (margin > 0) {
        return {
          status: 'tight',
          marginCm: margin,
          orientation: 'Tilted diagonally through door frame',
          note: `Tight squeeze. Requires tilting diagonally through the door frame (~${margin} cm margin).`
        };
      }
    }

    const deficit = Math.round(minDim - doorW);
    return {
      status: 'fail',
      marginCm: -deficit,
      orientation: 'Blocked',
      note: `Too large for doorway. Minimum cross-section (${minDim} cm) exceeds doorway (${doorW} cm) by ${deficit} cm.`
    };
  }

  /**
   * Checks if an item can enter and ride in the elevator car.
   */
  function checkElevator(item, lift) {
    if (!lift.available) {
      return {
        status: 'skipped',
        marginCm: 0,
        orientation: 'N/A',
        note: 'No elevator available — staircase route used.'
      };
    }

    // First check: can it pass the elevator doors?
    const doorCheck = checkDoorway(item, { width: lift.doorWidth, height: lift.doorHeight });
    if (doorCheck.status === 'fail') {
      return {
        status: 'fail',
        marginCm: doorCheck.marginCm,
        orientation: 'Blocked at lift doors',
        note: `Cannot enter elevator: ${doorCheck.note}`
      };
    }

    const w = item.width_cm || item.w || 0;
    const d = item.depth_cm || item.d || 0;
    const h = item.height_cm || item.h || 0;
    const dims = [w, d, h].sort((a, b) => a - b);
    const minDim = dims[0];
    const midDim = dims[1];
    const maxDim = dims[2];

    const carW = lift.carWidth || 110;
    const carD = lift.carDepth || 130;
    const carH = lift.ceilingHeight || 220;

    // Upright inside cab
    const uprightFit = ((w <= carW && d <= carD) || (d <= carW && w <= carD)) && (h <= carH);
    if (uprightFit) {
      const margin = Math.min(Math.max(carW, carD) - Math.max(w, d), carH - h);
      return {
        status: margin >= 10 ? 'pass' : 'tight',
        marginCm: Math.round(margin),
        orientation: 'Standing upright inside cab',
        note: `Fits comfortably inside elevator standing upright (+${Math.round(margin)} cm margin).`
      };
    }

    // Placed on floor or tilted
    const floorDiag = Math.hypot(carW, carD);
    if (minDim <= Math.min(carW, carD) && midDim <= floorDiag && h <= carH) {
      const margin = Math.round(floorDiag - midDim);
      return {
        status: margin >= 10 ? 'pass' : 'tight',
        marginCm: margin,
        orientation: 'Angled across cab floor',
        note: `Fits across elevator floor diagonally (+${margin} cm clearance).`
      };
    }

    // 3D diagonal tilt inside cab (standing diagonally from floor corner to ceiling corner)
    const cabSpaceDiag = Math.hypot(carW, carD, carH);
    if (maxDim <= cabSpaceDiag - 20 && minDim <= Math.min(carW, carD) * 1.1) {
      const margin = Math.round(cabSpaceDiag - maxDim);
      return {
        status: 'tight',
        marginCm: margin,
        orientation: 'Tilted corner-to-ceiling in cab',
        note: `Can fit tilted diagonally in elevator cab corner-to-ceiling (+${margin} cm clearance).`
      };
    }

    const deficit = Math.round(maxDim - floorDiag);
    return {
      status: 'fail',
      marginCm: -deficit,
      orientation: 'Exceeds elevator dimensions',
      note: `Item length (${maxDim} cm) exceeds elevator capacity. Must be moved via stairs.`
    };
  }

  /**
   * Checks if an item can navigate staircase flights and landing corners.
   */
  function checkStaircase(item, stairs) {
    const w = item.width_cm || item.w || 0;
    const d = item.depth_cm || item.d || 0;
    const h = item.height_cm || item.h || 0;
    const dims = [w, d, h].sort((a, b) => a - b);
    const minDim = dims[0];
    const midDim = dims[1];
    const maxDim = dims[2];

    const flightW = stairs.flightWidth || 95;
    const landingW = stairs.landingWidth || 120;
    const landingD = stairs.landingDepth || 120;
    const ceilH = stairs.ceilingHeight || 220;

    // Check flight width
    if (minDim > flightW) {
      const deficit = Math.round(minDim - flightW);
      return {
        status: 'fail',
        marginCm: -deficit,
        orientation: 'Blocked by stair width',
        note: `Stairway width (${flightW} cm) is too narrow for piece's smallest edge (${minDim} cm).`
      };
    }

    // Check ceiling clearance when carried on slant
    if (minDim > ceilH - 20) {
      return {
        status: 'fail',
        marginCm: Math.round(ceilH - minDim),
        orientation: 'Blocked by stair ceiling',
        note: `Stairwell ceiling height (${ceilH} cm) is too low.`
      };
    }

    // Check corner landing turn (L-turn or U-turn)
    // When pivoting horizontally or tilting upright:
    // If maxDim can stand upright (maxDim <= ceilH - 10), it can be pivoted standing on end on the landing!
    if (maxDim <= ceilH - 15 && minDim <= Math.min(landingW, landingD)) {
      const margin = Math.min(flightW - minDim, ceilH - maxDim);
      return {
        status: margin >= 10 ? 'pass' : 'tight',
        marginCm: Math.round(margin),
        orientation: 'Pivoted on-end at landing',
        note: `Can be carried up stairs and pivoted vertically on the landing (+${Math.round(margin)} cm clearance).`
      };
    }

    // Horizontal corner turn capacity:
    // For 90 degree turn with landing: max turnable length is approx hypot(landingW, landingD) + (flightW - minDim)
    const landingDiag = Math.hypot(landingW, landingD);
    const maxTurnLen = landingDiag * 1.15;
    if (maxDim <= maxTurnLen) {
      const margin = Math.round(maxTurnLen - maxDim);
      return {
        status: margin >= 15 ? 'pass' : 'tight',
        marginCm: margin,
        orientation: 'Turned horizontally on landing',
        note: `Fits around stair landing turn with ${margin} cm clearance.`
      };
    }

    const deficit = Math.round(maxDim - maxTurnLen);
    return {
      status: 'fail',
      marginCm: -deficit,
      orientation: 'Too long to turn staircase landing',
      note: `Piece length (${maxDim} cm) will get wedged at staircase turn (max clearance ~${Math.round(maxTurnLen)} cm).`
    };
  }

  /**
   * Runs the complete delivery check across all 5 checkpoints.
   */
  function checkDelivery(item, pathConfig) {
    const config = Object.assign({}, DEFAULT_PATH, pathConfig || {});

    const building = checkDoorway(item, config.buildingEntry);
    const lift = checkElevator(item, config.lift);
    const stairs = checkStaircase(item, config.stairs);
    const frontDoor = checkDoorway(item, config.frontDoor);
    const roomDoor = checkDoorway(item, config.roomDoor);

    const checks = [
      { id: 'building', name: config.buildingEntry.label, result: building, icon: '🏛️' },
      { id: 'lift', name: config.lift.label, result: lift, icon: '🛗' },
      { id: 'stairs', name: config.stairs.label, result: stairs, icon: '🪜' },
      { id: 'frontDoor', name: config.frontDoor.label, result: frontDoor, icon: '🚪' },
      { id: 'roomDoor', name: config.roomDoor.label, result: roomDoor, icon: '🏠' }
    ];

    // Determine overall status
    // Fatal if buildingEntry, frontDoor, or roomDoor fails
    // Or if BOTH lift and stairs fail
    const verticalTransitPass = (lift.status === 'pass' || lift.status === 'tight') ||
                               (stairs.status === 'pass' || stairs.status === 'tight');

    const entryPass = building.status !== 'fail';
    const frontPass = frontDoor.status !== 'fail';
    const roomPass = roomDoor.status !== 'fail';

    let overall = 'pass';
    let summary = '';
    let tips = [];

    if (!entryPass || !frontPass || !roomPass || !verticalTransitPass) {
      overall = 'fail';
      const blockedPoints = [];
      if (!entryPass) blockedPoints.push('Building Entry');
      if (!verticalTransitPass) blockedPoints.push('Elevator & Stairs');
      if (!frontPass) blockedPoints.push('Apartment Front Door');
      if (!roomPass) blockedPoints.push('Room Doorway');
      summary = `Delivery blocked at: ${blockedPoints.join(', ')}.`;
      tips.push('Check if legs, back cushions, or armrests can be detached before moving.');
      tips.push('Consider flat-pack / assemble-in-room alternatives.');
    } else if (building.status === 'tight' || frontDoor.status === 'tight' || roomDoor.status === 'tight' ||
               (lift.status === 'tight' && stairs.status !== 'pass')) {
      overall = 'tight';
      summary = 'Will fit with careful tilting, pivot maneuvers, and two handlers.';
      tips.push('Pad door frames with blankets or removal tape to prevent scuffs.');
      tips.push('Unbolt sofa legs or remove interior doors from hinges for an extra 4–6 cm clearance.');
    } else {
      overall = 'pass';
      summary = 'Clear delivery route! Fits smoothly through all building entryways and doors.';
      if (lift.status === 'fail' && stairs.status === 'pass') {
        summary = 'Passes via stairs (item is too long for elevator car).';
        tips.push('Notify movers in advance that delivery requires stair carry.');
      }
    }

    return {
      item,
      overall,
      summary,
      checks,
      tips,
      config
    };
  }

  RF.delivery = {
    DEFAULT_PATH,
    checkDoorway,
    checkElevator,
    checkStaircase,
    checkDelivery
  };

})(window.RF = window.RF || {});
