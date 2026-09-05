/**
 * Central tuning constants for APEX ROADS — endless procedural driving.
 * All units are meters / seconds / radians unless noted.
 *
 * The car is now simulated with a dynamic bicycle model (see Physics.js):
 * slip angles + Pacejka-style tire curves + friction ellipse + yaw dynamics.
 * Every constant here directly shapes how the car feels.
 */

/**
 * World / atmosphere presets — one per time of day. The Environment module
 * lerps its sky shader, fog, lights and star field to the active preset.
 */
export const WORLD_PRESETS = {
  dawn: {
    label: 'DAWN',
    skyTop: 0x35548c,
    skyHorizon: 0xf2b47e,
    skyGround: 0x4a4636,
    glowColor: 0xff9a56,       // warm band on the horizon
    glowStrength: 0.9,
    fogColor: 0xd8b494,
    fogNear: 60,
    fogFar: 950,
    sunColor: 0xffc98a,
    sunIntensity: 2.6,
    sunDirection: [0.78, 0.30, 0.55],   // low sun = long shadows
    hemiSky: 0x9db4d8,
    hemiGround: 0x5a5040,
    hemiIntensity: 0.55,
    envIntensity: 0.55,
    exposure: 1.12,
    stars: 0.0,
    cloudColor: 0xffd9b8,
    cloudOpacity: 0.72,
    headlights: false
  },
  day: {
    label: 'DAY',
    skyTop: 0x2f6fc4,
    skyHorizon: 0xcfe3f2,
    skyGround: 0x8fa8b8,
    glowColor: 0xffffff,
    glowStrength: 0.12,
    fogColor: 0xcfe0ec,
    fogNear: 80,
    fogFar: 1250,
    sunColor: 0xfff3e0,
    sunIntensity: 3.0,
    sunDirection: [0.42, 0.82, -0.38],
    hemiSky: 0xbcd4ea,
    hemiGround: 0x6d7a62,
    hemiIntensity: 0.75,
    envIntensity: 0.8,
    exposure: 1.1,
    stars: 0.0,
    cloudColor: 0xffffff,
    cloudOpacity: 0.88,
    headlights: false
  },
  dusk: {
    label: 'DUSK',
    skyTop: 0x1e2a52,
    skyHorizon: 0xf07a3c,
    skyGround: 0x33281e,
    glowColor: 0xff6a2a,
    glowStrength: 1.1,
    fogColor: 0x9a6a52,
    fogNear: 50,
    fogFar: 850,
    sunColor: 0xffa060,
    sunIntensity: 1.9,
    sunDirection: [-0.82, 0.16, -0.5],
    hemiSky: 0x6a6a9a,
    hemiGround: 0x3a2e26,
    hemiIntensity: 0.42,
    envIntensity: 0.4,
    exposure: 1.15,
    stars: 0.35,
    cloudColor: 0xf0a68a,
    cloudOpacity: 0.6,
    headlights: true
  },
  night: {
    label: 'NIGHT',
    skyTop: 0x01030a,
    skyHorizon: 0x0c1526,
    skyGround: 0x03050b,
    glowColor: 0x241a20,
    glowStrength: 0.8,
    fogColor: 0x070b15,
    fogNear: 30,
    fogFar: 800,
    sunColor: 0xdfe9ff,        // the "sun" is the moon now
    sunIntensity: 0.42,
    sunDirection: [0.38, 0.72, -0.32],
    hemiSky: 0x1a2742,
    hemiGround: 0x04060a,
    hemiIntensity: 0.16,
    envIntensity: 0.14,
    exposure: 1.05,
    stars: 1.0,
    cloudColor: 0x2a3446,
    cloudOpacity: 0.22,
    headlights: true
  }
};

/** Legacy single-object world constant (some modules reference WORLD.fogColor). */
export const WORLD = {
  get fogColor() { return WORLD_PRESETS.day.fogColor; }
};

/** Car headlight rig (auto-on at dusk / night). */
export const HEADLIGHTS = {
  color: 0xd9e8ff,
  intensity: 480,            // candela (physically-based spot)
  distance: 150,
  angle: 0.46,
  penumbra: 0.6,
  decay: 1.55
};

/**
 * Vehicle dynamics constants — a ~1420 kg RWD sports coupe.
 *
 * Layout (bicycle model):
 *   a = CG -> front axle, b = CG -> rear axle, wheelbase L = a + b.
 *   Static front load fraction = b / L.
 */
export const CAR = {
  mass: 1420,               // kg
  inertiaYaw: 2600,         // kg·m² (typical for this class)
  wheelbase: 2.70,
  aFront: 1.30,             // CG -> front axle  (FzF = m·g·b/L)
  bRear: 1.40,              // CG -> rear axle   (FzR = m·g·a/L)
  cgHeight: 0.50,           // m — drives longitudinal load transfer
  weightDistFront: 0.52,    // = b/L (informational)
  wheelRadius: 0.33,
  trackWidth: 1.55,
  carHalfWidth: 0.85,

  // --- aerodynamics / resistances -----------------------------------------
  airDrag: 0.00042,         // F = airDrag · v²  (≈0.42 · 1/2 · ρ · CdA · sign conv)
  downforce: 0.28,          // N per (m/s)² — mild high-speed stability
  downforceFront: 0.42,     // fraction of downforce on the front axle
  rollingResistance: 0.014, // Crr — F = Crr · m · g
  grassRollingResistance: 0.055,
  grassDrag: 3.4,           // extra deceleration (m/s²) fully on grass at speed

  // --- tires (Pacejka-style magic formula, per axle) ------------------------
  // Fy = mu · Fz · sin(C · atan(B · slipAngle))  — normalized so the peak
  // sits around 6–8° of slip and falls off gently beyond it (slides are
  // progressive, catchable, and fun rather than snappy).
  muAsphalt: 1.14,
  muGrass: 0.46,
  // front axle: quicker to saturate (understeer on entry)
  tireBFront: 10.5,
  tireCFront: 1.45,
  // rear axle: slightly more progressive (catchable slides)
  tireBRear: 11.5,
  tireCRear: 1.42,
  // load sensitivity: peak mu drops as the tire is loaded more (makes weight
  // transfer actually matter — loaded outside tires give less than linear gain)
  loadSens: 0.06,
  // longitudinal peak scales the friction ellipse (brakes grip slightly more
  // than peak lateral, like real tires)
  muLongScale: 1.06,
  // grip decay past the peak slip angle: at 3x peak slip the tire holds
  // (1 - slipFalloff) of its peak force. This is what gives counter-steering
  // real authority once a slide goes big — without it the front tire never
  // lets go and every slide turns into an unstoppable spin.
  slipFalloff: 0.34,
  // lateral force relaxation length (m) — tires need a little distance to
  // build force; adds realism and damps high-frequency yaw oscillation
  relaxLength: 0.68,

  // --- brakes ----------------------------------------------------------------
  brakeMaxDecel: 12.5,      // m/s² at full pedal, before tire limits
  brakeBiasFront: 0.62,     // front brake share
  handbrakeDecel: 7.0,      // rear lock decel contribution
  handbrakeRearGrip: 0.40,  // rear lateral mu multiplier while handbraking

  // --- steering --------------------------------------------------------------
  maxSteerRoad: 0.60,       // rad, front wheel angle at standstill
  steerFastFrac: 0.34,      // fraction of max steer at highway speed (~21° of
                            // counter-steer authority — enough to catch slides)
  steerFadeSpeed: 42,       // m/s where fade reaches its fast fraction
  steerSpeedRate: 0.16,     // how quickly fade engages per m/s

  // --- powertrain ------------------------------------------------------------
  maxSpeed: 68,             // m/s (~245 km/h theoretical top speed)
  maxReverseSpeed: 11,
  maxYawLowSpeed: 2.6,      // rad/s cap for the low-speed kinematic blend
  minSteerSpeed: 1.2,       // kinematic blend zone (m/s) — parking maneuvers
  yawDamping: 4.5,

  // --- world collision (soft — off-road is legal, ditches are not) ----------
  ditchDepthLimit: 9.0      // unused placeholder for future terrain limits
};

/**
 * Transmission / engine — naturally aspirated 3.0L flat-six feel.
 * Torque curve, 6 ratios + reverse, clutch slip on launch, rev limiter,
 * engine braking, automatic + sequential manual modes.
 */
export const TRANSMISSION = {
  idleRpm: 800,
  redline: 7200,
  rpmMaxSafe: 7500,
  peakTorqueRpm: 4800,
  maxTorque: 340,           // Nm — ~280 hp coupe
  efficiency: 0.9,
  gearRatios: [3.45, 2.10, 1.52, 1.16, 0.94, 0.78],  // 6-speed
  reverseRatio: 3.6,
  finalDrive: 3.64,

  autoUpshiftRpm: 6700,
  autoDownshiftRpm: 2300,
  autoDownshiftThrottle: 0.65,
  shiftTime: 0.12,
  shiftRpmEase: 9,
  clutchLockSpeed: 5.2,
  clutchGrip: 28,
  clutchCapacityN: 10500,   // N at the contact patch while slipping
  stallRpm: 550
};

export const SUSPENSION = {
  travel: 0.12,             // m of visible per-wheel travel (realistic GT)
  rate: 10,
  bumpCurbAmp: 0.5,
  bumpCurbFreq: 40,
  accelPitch: 0.05,
  rollG: 0.075,
  maxRoll: 0.10,
  maxPitch: 0.09,
  bumpScale: 3.2            // road-height deviation -> compression multiplier
};

export const TRACK = {
  // cross-section (meters, from centerline)
  roadHalfWidth: 5.2,       // asphalt + painted shoulder edge (10.4 m wide)
  laneHalfWidth: 3.6,       // pure asphalt — beyond this is gravel shoulder
  sampleSpacing: 4,         // meters between centerline samples
  chunkSamples: 32,         // 128 m per chunk
  chunksAhead: 11,          // ~1.4 km of road generated ahead
  chunksBehind: 2,
  // scenery
  treeDensity: 26,          // conifers per chunk (both sides combined)
  tree2Density: 17,         // broadleaf trees per chunk
  bushDensity: 14,
  rockDensity: 6,
  grassDensity: 90,         // grass tufts per chunk (near-road dressing)
  hayDensity: 3,            // hay bales per farm chunk
  postSpacing: 32,          // meters between reflector posts
  poleSpacing: 84,          // meters between power poles
  fenceSpacing: 11,         // meters between fence sections
  barnEvery: 7,             // one barn every N chunks
  turbineEvery: 9,          // one wind turbine every N chunks
  fenceEvery: 3             // fence zone: chunks where ci % fenceEvery !== 0
};

export const CAMERA = {
  // --- chase ---------------------------------------------------------------
  fovBase: 62,
  fovSpeedBoost: 12,
  distanceBase: 7.2,
  distanceSpeed: 1.6,
  heightBase: 2.7,
  heightSpeed: 0.5,
  posDamping: 7.0,
  lookDamping: 11.0,
  lookAhead: 8.0,
  rollMax: 0.035,
  chaseShake: 0.03,
  velocityLead: 0.18,
  accelLift: 0.0,
  brakeDive: 0.18,
  // --- hood ----------------------------------------------------------------
  hoodFov: 70,
  hoodFovBoost: 8,
  hoodLookAhead: 25,
  hoodDamping: 14,
  hoodLookDamping: 16,
  hoodShake: 0.02,
  // --- cockpit (driver view) -----------------------------------------------
  cockpitFov: 72,
  cockpitFovBoost: 8,
  cockpitShake: 0.015
};

/** Graphics quality presets. */
export const QUALITY = {
  low: {
    label: 'LOW',
    pixelRatio: 1.0,
    shadows: false,
    shadowMapSize: 512,
    fogScale: 0.55,
    particles: 0.35,
    aniso: 2,
    sceneryScale: 0.45
  },
  medium: {
    label: 'MEDIUM',
    pixelRatio: 1.25,
    shadows: true,
    shadowMapSize: 1024,
    fogScale: 0.8,
    particles: 0.6,
    aniso: 4,
    sceneryScale: 0.7
  },
  high: {
    label: 'HIGH',
    pixelRatio: 1.6,
    shadows: true,
    shadowMapSize: 1536,
    fogScale: 1.0,
    particles: 1.0,
    aniso: 8,
    sceneryScale: 1.0
  }
};

export const DEFAULT_SETTINGS = {
  transmission: 'auto',    // 'auto' | 'manual'
  camera: 'chase',         // 'chase' | 'hood' | 'cockpit'
  quality: 'medium',       // 'low' | 'medium' | 'high'
  timeOfDay: 'day',        // 'dawn' | 'day' | 'dusk' | 'night'
  masterVolume: 0.9,
  engineVolume: 0.8,
  steerSensitivity: 1.0,
  cameraSmoothing: 1.0,
  paint: 'guardsRed'
};

/**
 * Paint presets — applied to the car's paint material as clearcoat lacquer.
 */
export const PAINTS = {
  guardsRed:   { label: 'GUARDS RED',   color: 0xc00d1e },
  gtSilver:    { label: 'GT SILVER',    color: 0xd6d8dc },
  nightBlue:   { label: 'NIGHT BLUE',   color: 0x12306e },
  speedYellow: { label: 'SPEED YELLOW', color: 0xe8c414 },
  jetBlack:    { label: 'JET BLACK',    color: 0x0a0b0d },
  irishGreen:  { label: 'IRISH GREEN',  color: 0x0f5132 },
  arcticGrey:  { label: 'ARCTIC GREY',  color: 0x8b9096 },
  orange:      { label: 'LAVA ORANGE',  color: 0xe05206 }
};
