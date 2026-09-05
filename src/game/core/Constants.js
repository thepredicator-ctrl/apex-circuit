/**
 * Central tuning constants — APEX ROADS: OPEN WORLD.
 * Units: meters / seconds / radians unless noted.
 *
 * The car is a rear-drive sports coupe (the CARRERA GLB model) simulated with
 * a dynamic bicycle model (see vehicle/Physics.js): slip angles + Pacejka
 * tire curves + friction ellipse + yaw dynamics. The world is a seeded,
 * deterministic, streamed open world (see world/*).
 */

// ============================================================================
// VEHICLE — rear-drive sports coupe
// ============================================================================

export const CAR = {
  mass: 1470,               // kg
  inertiaYaw: 2200,         // kg·m² — compact, agile
  wheelbase: 2.47,
  aFront: 1.19,             // CG -> front axle (rear-biased ~48/52)
  bRear: 1.28,
  cgHeight: 0.44,
  weightDistFront: 0.482,
  wheelRadius: 0.335,
  trackWidth: 1.60,
  carHalfWidth: 0.92,

  // --- aerodynamics --------------------------------------------------------
  airDrag: 0.00040,
  downforce: 0.42,          // sports car — planted at speed
  downforceFront: 0.38,
  rollingResistance: 0.013,
  grassRollingResistance: 0.055,
  grassDrag: 3.4,

  // --- tires -----------------------------------------------------------------
  muAsphalt: 1.26,
  muGrass: 0.46,
  tireBFront: 10.8,
  tireCFront: 1.46,
  tireBRear: 11.6,
  tireCRear: 1.43,
  loadSens: 0.055,
  muLongScale: 1.08,
  slipFalloff: 0.36,
  relaxLength: 0.60,

  // --- brakes ----------------------------------------------------------------
  // Huge sports brakes + ABS. A full-stomp stop is short AND steerable.
  brakeMaxDecel: 19.0,      // m/s² demanded at full pedal, before tire limits
  brakeBiasFront: 0.62,
  absPeakFrac: 0.94,
  absFlutterHz: 46,
  handbrakeDecel: 7.0,
  handbrakeRearGrip: 0.40,

  // --- steering ---------------------------------------------------------------
  maxSteerRoad: 0.62,
  steerFastFrac: 0.32,
  steerFadeSpeed: 46,

  // --- powertrain ---------------------------------------------------------------
  maxSpeed: 89,             // m/s (~320 km/h theoretical)
  maxReverseSpeed: 11,
  maxYawLowSpeed: 2.7,
  minSteerSpeed: 1.2,
  yawDamping: 4.5
};

export const TRANSMISSION = {
  idleRpm: 850,
  redline: 7600,
  rpmMaxSafe: 7900,
  peakTorqueRpm: 5300,
  maxTorque: 470,           // Nm — naturally-aspirated flat-six feel
  efficiency: 0.92,
  gearRatios: [3.91, 2.29, 1.65, 1.28, 1.03, 0.84, 0.69],  // 7-speed
  reverseRatio: 4.2,
  finalDrive: 3.65,

  autoUpshiftRpm: 7250,
  autoDownshiftRpm: 2600,
  autoDownshiftThrottle: 0.6,
  shiftTime: 0.11,
  shiftRpmEase: 10,
  clutchLockSpeed: 5.0,
  clutchGrip: 30,
  clutchCapacityN: 12000,
  stallRpm: 520
};

export const SUSPENSION = {
  travel: 0.10,
  rate: 10,
  bumpCurbAmp: 0.5,
  bumpCurbFreq: 40,
  accelPitch: 0.05,
  rollG: 0.075,
  maxRoll: 0.09,
  maxPitch: 0.075,
  bumpScale: 3.2
};

// ============================================================================
// WORLD — layout, streaming, roads
// ============================================================================

export const WORLD = {
  chunkSize: 192,           // meters per terrain chunk
  terrainQuads: 48,         // 4 m cells (49×49 verts)
  waterLevel: 0,

  // road lattice spacings
  highwaySpacing: 4200,     // major highways (both axes)
  avenueSpacing: 1500,      // rural roads (both axes)
  citySpacing: 2700,        // candidate city lattice

  highwayHalfWidth: 11.0,   // 4 lanes + shoulders
  avenueHalfWidth: 5.4,     // 2 lanes + shoulders
  streetHalfWidth: 4.6,     // city street, curb to curb
  dirtHalfWidth: 3.2,

  maxRoadGrade: 0.075,      // 7.5% — roads climb mountains at real gradients
  roadSampleSpacing: 6,     // m between route samples
  segmentLength: 1536,      // m of route generated per cache segment

  bridgeClearance: 2.4,     // road height above water when bridging
  viaductTrigger: 7.5,      // road-terrain gap that triggers a viaduct
  cutGalleryTrigger: 8.5,   // terrain-road gap that triggers a covered cut

  fogFarDay: 2200           // base far-fog; scaled by quality + weather
};

/** road type ids (also used by traffic + minimap) */
export const ROAD = {
  HIGHWAY: 0,
  AVENUE: 1,
  STREET: 2,
  RING: 3,
  RAMP: 4,
  DIRT: 5
};

export const ROAD_INFO = {
  [ROAD.HIGHWAY]: { label: 'HIGHWAY', laneW: 3.65, lanes: 4, speed: 33 },
  [ROAD.AVENUE]: { label: 'ROAD', laneW: 3.2, lanes: 2, speed: 22 },
  [ROAD.STREET]: { label: 'STREET', laneW: 3.0, lanes: 2, speed: 12 },
  [ROAD.RING]: { label: 'RING ROAD', laneW: 3.4, lanes: 2, speed: 25 },
  [ROAD.RAMP]: { label: 'RAMP', laneW: 3.4, lanes: 1, speed: 14 },
  [ROAD.DIRT]: { label: 'DIRT TRACK', laneW: 3.0, lanes: 1, speed: 9 }
};

// ============================================================================
// ATMOSPHERE — day-cycle keyframes (t: 0..1 of a full day)
// ============================================================================

/** keyframes of the continuous day/night cycle. t=0 is midnight. */
export const DAY_CYCLE = [
  {
    t: 0.0, label: 'MIDNIGHT',
    skyTop: 0x01030a, skyHorizon: 0x0c1526, skyGround: 0x03050b,
    glowColor: 0x241a20, glowStrength: 0.8,
    fogColor: 0x070b15, sunColor: 0xdfe9ff, sunIntensity: 0.42,
    hemiSky: 0x1a2742, hemiGround: 0x04060a, hemiIntensity: 0.16,
    envIntensity: 0.14, exposure: 1.05, stars: 1.0,
    cloudColor: 0x2a3446, cloudOpacity: 0.22, headlights: true,
    sunElevation: 0.9, sunAzimuth: 0.3
  },
  {
    t: 0.23, label: 'DAWN',
    skyTop: 0x35548c, skyHorizon: 0xf2b47e, skyGround: 0x4a4636,
    glowColor: 0xff9a56, glowStrength: 0.9,
    fogColor: 0xd8b494, sunColor: 0xffc98a, sunIntensity: 2.6,
    hemiSky: 0x9db4d8, hemiGround: 0x5a5040, hemiIntensity: 0.55,
    envIntensity: 0.55, exposure: 1.12, stars: 0.0,
    cloudColor: 0xffd9b8, cloudOpacity: 0.72, headlights: false,
    sunElevation: 0.06, sunAzimuth: 1.35
  },
  {
    t: 0.5, label: 'MIDDAY',
    skyTop: 0x2f6fc4, skyHorizon: 0xcfe3f2, skyGround: 0x8fa8b8,
    glowColor: 0xffffff, glowStrength: 0.12,
    fogColor: 0xcfe0ec, sunColor: 0xfff3e0, sunIntensity: 3.0,
    hemiSky: 0xbcd4ea, hemiGround: 0x6d7a62, hemiIntensity: 0.75,
    envIntensity: 0.8, exposure: 1.1, stars: 0.0,
    cloudColor: 0xffffff, cloudOpacity: 0.88, headlights: false,
    sunElevation: 1.05, sunAzimuth: 2.6
  },
  {
    t: 0.77, label: 'DUSK',
    skyTop: 0x1e2a52, skyHorizon: 0xf07a3c, skyGround: 0x33281e,
    glowColor: 0xff6a2a, glowStrength: 1.1,
    fogColor: 0x9a6a52, sunColor: 0xffa060, sunIntensity: 1.9,
    hemiSky: 0x6a6a9a, hemiGround: 0x3a2e26, hemiIntensity: 0.42,
    envIntensity: 0.4, exposure: 1.15, stars: 0.35,
    cloudColor: 0xf0a68a, cloudOpacity: 0.6, headlights: true,
    sunElevation: 0.05, sunAzimuth: 4.1
  },
  {
    t: 1.0, label: 'MIDNIGHT',
    skyTop: 0x01030a, skyHorizon: 0x0c1526, skyGround: 0x03050b,
    glowColor: 0x241a20, glowStrength: 0.8,
    fogColor: 0x070b15, sunColor: 0xdfe9ff, sunIntensity: 0.42,
    hemiSky: 0x1a2742, hemiGround: 0x04060a, hemiIntensity: 0.16,
    envIntensity: 0.14, exposure: 1.05, stars: 1.0,
    cloudColor: 0x2a3446, cloudOpacity: 0.22, headlights: true,
    sunElevation: 0.9, sunAzimuth: 5.6
  }
];

/** legacy named presets (start-screen quick choice) */
export const WORLD_PRESETS = {
  dawn: DAY_CYCLE[1],
  day: DAY_CYCLE[2],
  dusk: DAY_CYCLE[3],
  night: DAY_CYCLE[0]
};

export const HEADLIGHTS = {
  color: 0xd9e8ff,
  intensity: 520,
  distance: 160,
  angle: 0.46,
  penumbra: 0.6,
  decay: 1.55
};

// ============================================================================
// GRAPHICS QUALITY
// ============================================================================

export const QUALITY = {
  low: {
    label: 'LOW',
    pixelRatio: 1.0,
    shadows: false,
    shadowMapSize: 512,
    viewRadius: 5,          // chunks (192 m each)
    sceneryRadius: 4,
    grassRadius: 2,
    detailRadius: 3,        // radius that gets flowers/ferns/small props
    fogScale: 0.55,
    particles: 0.4,
    bloom: false,
    rainCount: 500
  },
  medium: {
    label: 'MEDIUM',
    pixelRatio: 1.25,
    shadows: true,
    shadowMapSize: 1024,
    viewRadius: 7,
    sceneryRadius: 6,
    grassRadius: 3,
    detailRadius: 4,
    fogScale: 0.8,
    particles: 0.7,
    bloom: false,
    rainCount: 900
  },
  high: {
    label: 'HIGH',
    pixelRatio: 1.6,
    shadows: true,
    shadowMapSize: 2048,
    viewRadius: 9,
    sceneryRadius: 8,
    grassRadius: 4,
    detailRadius: 5,
    fogScale: 1.0,
    particles: 1.0,
    bloom: true,
    rainCount: 1400
  }
};

// ============================================================================
// WEATHER
// ============================================================================

export const WEATHER_CONFIG = {
  states: {
    clear: { fogMul: 1.0, sunMul: 1.0, grip: 1.0, cloudOp: 0.55, rain: 0 },
    cloudy: { fogMul: 0.9, sunMul: 0.62, grip: 1.0, cloudOp: 0.95, rain: 0 },
    fog: { fogMul: 0.30, sunMul: 0.55, grip: 0.96, cloudOp: 0.85, rain: 0 },
    rain: { fogMul: 0.55, sunMul: 0.38, grip: 0.82, cloudOp: 1.0, rain: 0.6 },
    storm: { fogMul: 0.42, sunMul: 0.24, grip: 0.74, cloudOp: 1.0, rain: 1.0 }
  },
  // per-biome weights for weather selection
  regionBias: {
    desert: { clear: 0.75, cloudy: 0.15, fog: 0.05, rain: 0.05, storm: 0.0 },
    coast: { clear: 0.35, cloudy: 0.25, fog: 0.12, rain: 0.2, storm: 0.08 },
    mountain: { clear: 0.3, cloudy: 0.25, fog: 0.3, rain: 0.1, storm: 0.05 },
    forest: { clear: 0.35, cloudy: 0.25, fog: 0.15, rain: 0.18, storm: 0.07 },
    plains: { clear: 0.5, cloudy: 0.25, fog: 0.08, rain: 0.12, storm: 0.05 }
  },
  minStateTime: 70,        // seconds before a transition may roll
  maxStateTime: 240
};

// ============================================================================
// TRAFFIC
// ============================================================================

export const TRAFFIC = {
  maxActive: 40,            // hard cap
  spawnMin: 130,            // m from player
  spawnMax: 420,
  despawnDist: 620,
  updateHz: 15,             // AI tick
  lengthAggressiveness: 1.6 // overtake eagerness
};

// ============================================================================
// MYSTERY — the world grows stranger with distance
// ============================================================================

export const MYSTERY = {
  onset: 6000,              // m from origin: first hints
  full: 26000,              // m: full strangeness
  discoverRadius: 70
};

// ============================================================================
// CAMERA
// ============================================================================

export const CAMERA = {
  fovBase: 62,
  fovSpeedBoost: 12,
  distanceBase: 7.6,
  distanceSpeed: 1.7,
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
  hoodFov: 70,
  hoodFovBoost: 8,
  hoodLookAhead: 25,
  hoodDamping: 14,
  hoodLookDamping: 16,
  hoodShake: 0.02,
  cockpitFov: 72,
  cockpitFovBoost: 8,
  cockpitShake: 0.015,
  // GLB car offsets (nose +Z): hood cam sits above the front deck
  hoodForward: 0.55,
  hoodHeight: 1.02,
  cockpitForward: -0.25,
  cockpitHeight: 0.95,
  cockpitLateral: 0.0
};

// ============================================================================
// PAINTS + SETTINGS
// ============================================================================

/** Paint presets applied to the GLB car's body material (hue-tinted lacquer). */
export const PAINTS = {
  guardsRed:   { label: 'GUARDS RED',    color: 0xbb0a1e },
  gtSilver:    { label: 'GT SILVER',     color: 0xd4d7d9 },
  navarraBlue: { label: 'NAVARRA BLUE',  color: 0x0e3a5c },
  speedYellow: { label: 'RACING YELLOW', color: 0xf0c020 },
  jetBlack:    { label: 'JET BLACK',     color: 0x0c0d0f },
  irishGreen:  { label: 'OAK GREEN',     color: 0x11402e },
  arcticGrey:  { label: 'ARCTIC GREY',   color: 0x565b61 },
  orange:      { label: 'LAVA ORANGE',   color: 0xd84a1b }
};

export const DEFAULT_SETTINGS = {
  transmission: 'auto',
  camera: 'chase',
  quality: 'high',
  timeOfDay: 'day',        // initial phase of the day cycle
  dayCycle: true,          // continuous day/night cycle on/off
  dayLength: 1200,         // seconds per full 24h cycle
  weather: true,           // dynamic weather on/off
  masterVolume: 0.9,
  engineVolume: 0.8,
  steerSensitivity: 1.0,
  cameraSmoothing: 1.0,
  paint: 'guardsRed',
  traffic: true,
  bloom: true,
  multiplayer: true,
  playerName: ''
};
