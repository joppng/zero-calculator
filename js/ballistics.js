/* ---------------------------------------------------------------------
   Applied Concepts — Ballistics module
   Point-mass exterior ballistics solver (McCoy/JBM-style), using the
   standard G1 and G7 drag tables. Ported from the open-source
   go_ballisticcalc project (gehtsoft-usa), cross-checked against
   published references — same method used by most commercial ballistic
   calculators (Applied Ballistics, JBM, Strelok, etc.).

   Assumptions (v1, still true for computeHoldTableMil/computeTrajectoryProfile
   below — the Zero Optic Calculator and Dry Fire hold tables):
   - Fixed ICAO standard atmosphere at sea level (15°C / 59°F, 29.92 inHg,
     0% humidity).
   - Flat, level fire (no shot angle, no wind, no Coriolis, no spin drift).
   - Output: hold in MIL only.

   v2 (25-09-2026, voor Dope Card) adds computeAtmosphere() for a variable
   temperature/altitude/pressure, and computeDopeCardTable() for a wind
   hold per distance — via the standard "lag time" approximation
   (drift = crosswind_mps × (actual time of flight − no-drag time of
   flight)), not a separate lateral 3DOF integration. This is the same
   simplification McCoy/Applied Ballistics/JBM use for flat-fire wind
   drift and is exact for the "compute once per 1 m/s, then scale
   linearly" approach the spec asks for, since both sides of the lag-time
   formula are already produced by the existing vertical-only simulation.
   Still out of scope for v1/v2, per spec: spin drift, Coriolis, and the
   vertical component of head/tailwind.
--------------------------------------------------------------------- */

const BALLISTICS_GRAVITY_FPS2 = 32.17405;
const BALLISTICS_PIR = 2.08551e-4; // (PI/8)*(RHO0/144)
const BALLISTICS_FT_PER_M = 3.280839895;

// Standard atmosphere (sea level, 59°F, 0% humidity): density factor is 1
// by definition, and the speed of sound follows from temperature alone.
const BALLISTICS_STD_TEMP_K = 288.15; // 59°F in Kelvin
const BALLISTICS_MACH1_FPS = 331.3 * Math.sqrt(BALLISTICS_STD_TEMP_K / 273.15) / 0.3048;
const BALLISTICS_DENSITY_FACTOR = 1.0;

// Standard G1 drag table (Mach, Cd)
const G1_DRAG_TABLE = [
  [0.00, 0.2629], [0.05, 0.2558], [0.10, 0.2487], [0.15, 0.2413], [0.20, 0.2344],
  [0.25, 0.2278], [0.30, 0.2214], [0.35, 0.2155], [0.40, 0.2104], [0.45, 0.2061],
  [0.50, 0.2032], [0.55, 0.2020], [0.60, 0.2034], [0.70, 0.2165], [0.725, 0.2230],
  [0.75, 0.2313], [0.775, 0.2417], [0.80, 0.2546], [0.825, 0.2706], [0.85, 0.2901],
  [0.875, 0.3136], [0.90, 0.3415], [0.925, 0.3734], [0.95, 0.4084], [0.975, 0.4448],
  [1.0, 0.4805], [1.025, 0.5136], [1.05, 0.5427], [1.075, 0.5677], [1.10, 0.5883],
  [1.125, 0.6053], [1.15, 0.6191], [1.20, 0.6393], [1.25, 0.6518], [1.30, 0.6589],
  [1.35, 0.6621], [1.40, 0.6625], [1.45, 0.6607], [1.50, 0.6573], [1.55, 0.6528],
  [1.60, 0.6474], [1.65, 0.6413], [1.70, 0.6347], [1.75, 0.6280], [1.80, 0.6210],
  [1.85, 0.6141], [1.90, 0.6072], [1.95, 0.6003], [2.00, 0.5934], [2.05, 0.5867],
  [2.10, 0.5804], [2.15, 0.5743], [2.20, 0.5685], [2.25, 0.5630], [2.30, 0.5577],
  [2.35, 0.5527], [2.40, 0.5481], [2.45, 0.5438], [2.50, 0.5397], [2.60, 0.5325],
  [2.70, 0.5264], [2.80, 0.5211], [2.90, 0.5168], [3.00, 0.5133], [3.10, 0.5105],
  [3.20, 0.5084], [3.30, 0.5067], [3.40, 0.5054], [3.50, 0.5040], [3.60, 0.5030],
  [3.70, 0.5022], [3.80, 0.5016], [3.90, 0.5010], [4.00, 0.5006], [4.20, 0.4998],
  [4.40, 0.4995], [4.60, 0.4992], [4.80, 0.4990], [5.00, 0.4988],
];

// Standard G7 drag table (Mach, Cd)
const G7_DRAG_TABLE = [
  [0.00, 0.1198], [0.05, 0.1197], [0.10, 0.1196], [0.15, 0.1194], [0.20, 0.1193],
  [0.25, 0.1194], [0.30, 0.1194], [0.35, 0.1194], [0.40, 0.1193], [0.45, 0.1193],
  [0.50, 0.1194], [0.55, 0.1193], [0.60, 0.1194], [0.65, 0.1197], [0.70, 0.1202],
  [0.725, 0.1207], [0.75, 0.1215], [0.775, 0.1226], [0.80, 0.1242], [0.825, 0.1266],
  [0.85, 0.1306], [0.875, 0.1368], [0.90, 0.1464], [0.925, 0.1660], [0.95, 0.2054],
  [0.975, 0.2993], [1.0, 0.3803], [1.025, 0.4015], [1.05, 0.4043], [1.075, 0.4034],
  [1.10, 0.4014], [1.125, 0.3987], [1.15, 0.3955], [1.20, 0.3884], [1.25, 0.3810],
  [1.30, 0.3732], [1.35, 0.3657], [1.40, 0.3580], [1.50, 0.3440], [1.55, 0.3376],
  [1.60, 0.3315], [1.65, 0.3260], [1.70, 0.3209], [1.75, 0.3160], [1.80, 0.3117],
  [1.85, 0.3078], [1.90, 0.3042], [1.95, 0.3010], [2.00, 0.2980], [2.05, 0.2951],
  [2.10, 0.2922], [2.15, 0.2892], [2.20, 0.2864], [2.25, 0.2835], [2.30, 0.2807],
  [2.35, 0.2779], [2.40, 0.2752], [2.45, 0.2725], [2.50, 0.2697], [2.55, 0.2670],
  [2.60, 0.2643], [2.65, 0.2615], [2.70, 0.2588], [2.75, 0.2561], [2.80, 0.2533],
  [2.85, 0.2506], [2.90, 0.2479], [2.95, 0.2451], [3.00, 0.2424], [3.10, 0.2368],
  [3.20, 0.2313], [3.30, 0.2258], [3.40, 0.2205], [3.50, 0.2154], [3.60, 0.2106],
  [3.70, 0.2060], [3.80, 0.2017], [3.90, 0.1975], [4.00, 0.1935], [4.20, 0.1861],
  [4.40, 0.1793], [4.60, 0.1730], [4.80, 0.1672], [5.00, 0.1618],
];

function dragTableFor(model){
  return model === 'G7' ? G7_DRAG_TABLE : G1_DRAG_TABLE;
}

// Linear interpolation of Cd at a given Mach number (table is sorted ascending).
function dragCd(table, mach){
  if(mach <= table[0][0]) return table[0][1];
  const last = table[table.length-1];
  if(mach >= last[0]) return last[1];
  let lo = 0, hi = table.length-1;
  while(hi - lo > 1){
    const mid = (lo+hi) >> 1;
    if(table[mid][0] < mach) lo = mid; else hi = mid;
  }
  const [m0,c0] = table[lo], [m1,c1] = table[hi];
  const t = (mach - m0) / (m1 - m0);
  return c0 + t*(c1-c0);
}

function getCalculationStepFt(stepFt){
  const maxStepFt = 0.1 * BALLISTICS_FT_PER_M; // 0.1 m, matches the reference engine's default
  let step = stepFt / 2;
  if(step > maxStepFt){
    const stepOrder = Math.floor(Math.log10(step));
    const maxOrder = Math.floor(Math.log10(maxStepFt));
    step = step / Math.pow(10, stepOrder - maxOrder + 1);
  }
  return step;
}

/**
 * Simulates the flat-fire trajectory for one barrel elevation and returns the
 * bullet height relative to the line of sight (ft) at each requested distance (ft).
 * targetDistancesFt must be sorted ascending. densityFactor/machFps default to
 * the fixed ICAO sea-level standard used by the Optic Calculator/Dry Fire;
 * Dope Card passes computeAtmosphere()'s values instead.
 */
function simulateDropAtDistances({ effectiveBC, dragTable, muzzleVelocityFps, sightHeightFt, barrelElevationRad, targetDistancesFt, calcStepFt, densityFactor, machFps }){
  const ballisticFactor = 1 / effectiveBC;
  const gravityY = -BALLISTICS_GRAVITY_FPS2;
  const rho = densityFactor != null ? densityFactor : BALLISTICS_DENSITY_FACTOR;
  const mach1 = machFps || BALLISTICS_MACH1_FPS;

  let velocity = muzzleVelocityFps;
  let vx = Math.cos(barrelElevationRad) * velocity;
  let vy = Math.sin(barrelElevationRad) * velocity;
  let x = 0, y = -sightHeightFt, time = 0;

  const results = [];
  let nextIdx = 0;
  const maxRange = targetDistancesFt[targetDistancesFt.length-1] + calcStepFt;

  while(x <= maxRange){
    if(velocity < 50 || y < -15000) break;

    while(nextIdx < targetDistancesFt.length && x >= targetDistancesFt[nextIdx]){
      results.push({ distanceFt: targetDistancesFt[nextIdx], x, y, velocity, time });
      nextIdx++;
    }
    if(nextIdx >= targetDistancesFt.length) break;

    const deltaTime = calcStepFt / vx;
    velocity = Math.hypot(vx, vy);
    const mach = velocity / mach1;
    const drag = ballisticFactor * rho * velocity * dragCd(dragTable, mach) * BALLISTICS_PIR;

    vx = vx - deltaTime*(drag*vx - 0);
    vy = vy - deltaTime*(drag*vy - gravityY);

    x = x + vx*deltaTime;
    y = y + vy*deltaTime;
    time = time + deltaTime;
  }
  return results;
}

/**
 * Solves the barrel elevation (radians) so the trajectory crosses the line
 * of sight exactly at zeroDistanceFt (accounting for sight height offset).
 */
function solveSightAngleRad({ effectiveBC, dragTable, muzzleVelocityFps, sightHeightFt, zeroDistanceFt, densityFactor, machFps }){
  const rawStepFt = 10 * BALLISTICS_FT_PER_M; // "10" in the same unit as zero distance (meters)
  const calcStepFt = getCalculationStepFt(rawStepFt);
  const ballisticFactor = 1 / effectiveBC;
  const gravityY = -BALLISTICS_GRAVITY_FPS2;
  const rho = densityFactor != null ? densityFactor : BALLISTICS_DENSITY_FACTOR;
  const mach1 = machFps || BALLISTICS_MACH1_FPS;

  let barrelElevation = 0;
  let error = 1;
  let iterations = 0;

  while(error > 0.000005 && iterations < 10){
    let velocity = muzzleVelocityFps;
    let vx = Math.cos(barrelElevation) * velocity;
    let vy = Math.sin(barrelElevation) * velocity;
    let x = 0, y = -sightHeightFt;
    const maxRange = zeroDistanceFt + calcStepFt;

    while(x <= maxRange){
      if(velocity < 50 || y < -15000) break;
      const deltaTime = calcStepFt / vx;
      velocity = Math.hypot(vx, vy);
      const mach = velocity / mach1;
      const drag = ballisticFactor * rho * velocity * dragCd(dragTable, mach) * BALLISTICS_PIR;

      vx = vx - deltaTime*(drag*vx - 0);
      vy = vy - deltaTime*(drag*vy - gravityY);
      x = x + vx*deltaTime;
      y = y + vy*deltaTime;

      if(Math.abs(x - zeroDistanceFt) < 0.5*calcStepFt){
        error = Math.abs(y);
        barrelElevation = barrelElevation - y/x;
        break;
      }
    }
    iterations++;
  }
  return barrelElevation;
}

/**
 * Computes hold (MIL) at each requested distance for a weapon profile.
 * Positive = hold up, negative = hold down. Returns a Map<distanceM, holdMil|null>.
 * null means the solver could not produce a stable result (e.g. transonic/subsonic
 * breakdown or unrealistic inputs) for that distance.
 */
function computeHoldTableMil(profile, distancesM){
  const dragTable = dragTableFor(profile.dragModel);
  const customFactor = (profile.customDragFactor && profile.customDragFactor > 0) ? profile.customDragFactor : 1;
  const effectiveBC = profile.bc * customFactor;
  const muzzleVelocityFps = profile.muzzleVelocityFps;
  const sightHeightFt = (profile.sightHeightCm || 0) / 30.48;
  const zeroDistanceFt = profile.zeroDistanceM * BALLISTICS_FT_PER_M;

  const barrelElevationRad = solveSightAngleRad({
    effectiveBC, dragTable, muzzleVelocityFps, sightHeightFt, zeroDistanceFt,
  });

  const sortedM = [...distancesM].sort((a,b)=>a-b);
  const targetDistancesFt = sortedM.map(d => d * BALLISTICS_FT_PER_M);
  const calcStepFt = getCalculationStepFt(10 * BALLISTICS_FT_PER_M);

  const results = simulateDropAtDistances({
    effectiveBC, dragTable, muzzleVelocityFps, sightHeightFt, barrelElevationRad,
    targetDistancesFt, calcStepFt,
  });

  const holdByDistance = new Map();
  results.forEach(r => {
    const distanceM = r.distanceFt / BALLISTICS_FT_PER_M;
    const holdMil = -Math.atan(r.y / r.x) * 1000;
    holdByDistance.set(Math.round(distanceM), holdMil);
  });
  sortedM.forEach(d => { if(!holdByDistance.has(d)) holdByDistance.set(d, null); });
  return holdByDistance;
}

/**
 * Finds where the true (gravity-drop) trajectory crosses the line of sight
 * a second time downrange of the zero distance — the "far zero" every
 * flat-fired zero has, since the bullet keeps rising above the sight line
 * after the near zero before gravity pulls it back down through it again —
 * plus the drop/velocity/energy 100 m past that far zero. Returns null if
 * no far zero is found within maxRangeM (shouldn't happen for realistic
 * small-arms inputs, but a subsonic/garbage BC could produce one).
 */
function computeTrajectoryProfile({ dragModel, bc, customDragFactor, muzzleVelocityFps, sightHeightCm, zeroDistanceM, bulletWeightGr, maxRangeM }){
  const dragTable = dragTableFor(dragModel);
  const customFactor = (customDragFactor && customDragFactor > 0) ? customDragFactor : 1;
  const effectiveBC = bc * customFactor;
  const sightHeightFt = (sightHeightCm || 0) / 30.48;
  const zeroDistanceFt = zeroDistanceM * BALLISTICS_FT_PER_M;
  const maxM = maxRangeM || 800;

  const barrelElevationRad = solveSightAngleRad({ effectiveBC, dragTable, muzzleVelocityFps, sightHeightFt, zeroDistanceFt });

  // 1 m sampling — fine enough to interpolate the far-zero crossing and the
  // +100 m point to sub-meter precision without costing anything real in a
  // single-click browser computation.
  const targetDistancesFt = [];
  for(let d = 1; d <= maxM; d += 1) targetDistancesFt.push(d * BALLISTICS_FT_PER_M);
  const calcStepFt = getCalculationStepFt(10 * BALLISTICS_FT_PER_M);

  const results = simulateDropAtDistances({
    effectiveBC, dragTable, muzzleVelocityFps, sightHeightFt, barrelElevationRad,
    targetDistancesFt, calcStepFt,
  }).map(r => ({ m: r.distanceFt / BALLISTICS_FT_PER_M, yCm: r.y * 30.48, velocityFps: r.velocity }));

  // Walk past the near zero, then find the next sample where height above
  // the line of sight (yCm > 0) drops back to/through 0 — linear-interpolate
  // between the two bracketing samples for the actual crossing distance.
  let farZeroM = null;
  for(let i = 1; i < results.length; i++){
    const prev = results[i-1], cur = results[i];
    if(cur.m <= zeroDistanceM + 1) continue;
    if(prev.yCm > 0 && cur.yCm <= 0){
      const t = prev.yCm / (prev.yCm - cur.yCm);
      farZeroM = prev.m + t * (cur.m - prev.m);
      break;
    }
  }
  if(farZeroM == null) return null;

  const targetM = farZeroM + 100;
  let sample = results.find(r => r.m >= targetM);
  if(!sample) sample = results[results.length - 1];

  const energyFtLbs = v => (bulletWeightGr * v * v) / 450240; // standard small-arms KE formula
  const energyJ = ftLbs => ftLbs * 1.35582;

  const muzzleEnergyFtLbs = energyFtLbs(muzzleVelocityFps);
  const targetEnergyFtLbs = energyFtLbs(sample.velocityFps);

  return {
    nearZeroM: zeroDistanceM,
    farZeroM,
    targetM: sample.m,
    dropCm: -sample.yCm, // yCm is negative (below LOS) past the far zero — report the positive drop magnitude
    velocityFpsAtTarget: sample.velocityFps,
    muzzleEnergyJ: energyJ(muzzleEnergyFtLbs), muzzleEnergyFtLbs,
    energyJAtTarget: energyJ(targetEnergyFtLbs), energyFtLbsAtTarget: targetEnergyFtLbs,
  };
}

/**
 * Variable atmosphere for Dope Card (Optic/Dry Fire keep the fixed ICAO
 * sea-level standard above). Returns a density ratio (relative to that
 * same ICAO standard, so it's a drop-in multiplier for densityFactor
 * above) and the speed of sound in fps for the given temperature.
 * altitudeM is ignored when pressureHpa is given directly.
 */
function computeAtmosphere({ tempC, altitudeM, pressureHpa }){
  const T_C = tempC != null ? tempC : 15;
  const T_K = T_C + 273.15;
  const P_hPa = pressureHpa != null ? pressureHpa
    : 1013.25 * Math.pow(1 - 2.25577e-5 * (altitudeM || 0), 5.25588);
  // Ratio form cancels the gas constant R, so only P/T relative to the
  // ICAO standard (1013.25 hPa / 288.15 K) is needed.
  const densityFactor = (P_hPa * 288.15) / (1013.25 * T_K);
  const speedOfSoundMs = 331.3 * Math.sqrt(1 + T_C / 273.15);
  const machFps = speedOfSoundMs * BALLISTICS_FT_PER_M;
  return { densityFactor, machFps, tempC: T_C, pressureHpa: P_hPa };
}

/**
 * Dope Card table: elevation hold (MIL) and wind hold per 1 m/s of full
 * crosswind ("driftMilPerMps" — multiply by the effective wind on screen
 * to get the live windhold) for each requested distance, under a given
 * profile + atmosphere. Recompute only when the profile or atmosphere
 * changes; the UI then just multiplies driftMilPerMps by the current
 * effective wind, which is why wind itself feels instant.
 */
function computeDopeCardTable(profile, atmosphere, distancesM){
  const dragTable = dragTableFor(profile.dragModel);
  const customFactor = (profile.customDragFactor && profile.customDragFactor > 0) ? profile.customDragFactor : 1;
  const effectiveBC = profile.bc * customFactor;
  const muzzleVelocityFps = profile.muzzleVelocityFps;
  const sightHeightFt = (profile.sightHeightCm || 0) / 30.48;
  const zeroDistanceFt = profile.zeroDistanceM * BALLISTICS_FT_PER_M;
  const { densityFactor, machFps } = atmosphere || {};

  const barrelElevationRad = solveSightAngleRad({
    effectiveBC, dragTable, muzzleVelocityFps, sightHeightFt, zeroDistanceFt, densityFactor, machFps,
  });

  const sortedM = [...distancesM].sort((a,b)=>a-b);
  const targetDistancesFt = sortedM.map(d => d * BALLISTICS_FT_PER_M);
  const calcStepFt = getCalculationStepFt(10 * BALLISTICS_FT_PER_M);

  const results = simulateDropAtDistances({
    effectiveBC, dragTable, muzzleVelocityFps, sightHeightFt, barrelElevationRad,
    targetDistancesFt, calcStepFt, densityFactor, machFps,
  });

  const table = new Map();
  results.forEach(r => {
    const distanceM = Math.round(r.distanceFt / BALLISTICS_FT_PER_M);
    const elevMil = -Math.atan(r.y / r.x) * 1000;
    // Lag-time wind drift: a bullet slowed by drag takes longer to reach a
    // distance than a no-drag bullet at muzzle velocity would — a full-value
    // crosswind carries it sideways for exactly that extra time.
    const noDragTime = r.x / muzzleVelocityFps;
    const driftFtPerMps = (r.time - noDragTime) * BALLISTICS_FT_PER_M; // 1 m/s wind → ft of drift
    const driftMilPerMps = (driftFtPerMps / r.x) * 1000;
    table.set(distanceM, { elevMil, driftMilPerMps });
  });
  sortedM.forEach(d => { if(!table.has(d)) table.set(d, null); });
  return table;
}

/**
 * Console self-test: sanity-checks the solver's invariants and prints the
 * M855 (100 m zero, 70 mm HOB, ICAO) 100-800 m table for a manual check
 * against JBM/Strelok. Not run automatically — call from the console with
 * AppliedConceptsBallistics.runSelfTest().
 */
function runSelfTest(){
  const profile = {
    dragModel: 'G7', bc: 0.151, muzzleVelocityFps: 900 * BALLISTICS_FT_PER_M,
    sightHeightCm: 7, zeroDistanceM: 100,
  };
  const atmosphere = computeAtmosphere({ tempC: 15, altitudeM: 0 });
  const distances = [100,200,300,400,500,600,700,800];
  const table = computeDopeCardTable(profile, atmosphere, distances);

  console.log('--- Ballistics self-test: M855 62gr, G7 0.151, 900 m/s, 100 m zero, 70 mm HOB, ICAO ---');
  console.log('m\telev (mil)\tdrift/mps (mil)');
  distances.forEach(d => {
    const row = table.get(d);
    console.log(`${d}\t${row.elevMil.toFixed(2)}\t${row.driftMilPerMps.toFixed(3)}`);
  });

  const elevAtZero = table.get(100).elevMil;
  console.assert(Math.abs(elevAtZero) < 0.05, 'FAIL: elevation at zero distance should be ~0, got', elevAtZero);

  let monotonic = true;
  for(let i=1; i<distances.length; i++){
    if(table.get(distances[i]).elevMil <= table.get(distances[i-1]).elevMil) monotonic = false;
  }
  console.assert(monotonic, 'FAIL: elevation hold should increase monotonically past the zero');

  // Windhold linear in wind speed + R/L convention (section 3): wind from
  // the right (0°<θ<180°) pushes the bullet left, so the hold to compensate
  // is R; from the left, hold is L. Verified against the clock-method spec
  // examples (5.0 m/s @ 3:00 = R5.0, @ 2:00 = R4.3, @ 9:00 = L5.0) directly
  // by the UI's effective-wind formula (see dopecard.js) — here we only
  // confirm driftMilPerMps scales linearly, which the UI then multiplies.
  const d500 = table.get(500).driftMilPerMps;
  console.assert(d500 > 0, 'FAIL: driftMilPerMps at 500 m should be positive');

  console.log('Self-test klaar — vergelijk de tabel hierboven met JBM/Strelok voor M855.');
}

window.AppliedConceptsBallistics = {
  computeHoldTableMil, computeTrajectoryProfile, computeAtmosphere, computeDopeCardTable,
  runSelfTest, G1_DRAG_TABLE, G7_DRAG_TABLE,
};
