/**
 * Central tuning constants for Apex Circuit.
 * All units are meters / seconds / radians unless noted.
 */

/**
 * Night-race atmosphere: cold moonlight, deep fog, faint city glow on the
 * horizon. Everything beyond the floodlight pools falls into darkness —
 * that is what makes the circuit feel fast and dangerous.
 */
export const WORLD = {
  fogColor: 0x070b15,
  fogNear: 34,
  fogFar: 1000,
  skyTop: 0x01030a,
  skyHorizon: 0x0c1526,
  skyGround: 0x03050b,
  cityGlow: 0x241a20,        // faint warm haze on the horizon (distant city)
  sunColor: 0xdfe9ff,        // the "sun" is the moon now
  sunIntensity: 0.62,
  hemiSky: 0x1a2742,
  hemiGround: 0x04060a,
  hemiIntensity: 0.32,
  // direction the moon shines FROM (normalized in code)
  sunDirection: [0.38, 0.72, -0.32],
  envIntensity: 0.25,        // RoomEnvironment probe strength (night-dimmed)
  stars: { count: 1300, mobile: 600 }
};

/** Car headlight rig (night race — always on). */
export const HEADLIGHTS = {
  color: 0xd9e8ff,
  intensity: 480,            // candela (physically-based spot)
  distance: 150,
  angle: 0.46,
  penumbra: 0.6,
  decay: 1.55
};

export const CAR = {
  mass: 2025,               // kg — Audi RS6 Avant (was 1180 for Porsche 911)
  wheelbase: 2.93,          // m — RS6 wheelbase (was 2.96)
  cgHeight: 0.50,           // m — taller car (wagon body) = higher CG
  weightDistFront: 0.55,    // RS6 is nose-heavy ~55/45 F/R (was 0.42 for rear-engine 911)
  wheelRadius: 0.365,       // m — RS6 22" wheels (was 0.34)

  maxSpeed: 70,             // m/s (~250 km/h, limited)
  maxReverseSpeed: 11,
  brakeDecel: 28,           // m/s^2 at full load
  rollingResistance: 0.35,
  airDrag: 0.00042,
  downforce: 1.2,           // wagon body = less downforce than a low sports car

  // lateral grip — planted feel
  gripAsphalt: 1.30,        // RS6 has wide performance tires
  gripGrass: 0.45,
  handbrakeRearGrip: 0.28,
  powerOversteerFactor: 0.82, // AWD = less power oversteer than RWD 911
  highSteerGripFactor: 0.88,
  lateralDamp: 1.4,
  yawDamping: 7.0,

  // yaw rate limits — RS6 is heavier, turns less sharply than a 911
  maxYawLowSpeed: 1.75,     // was 1.85 — slightly less rotation for the heavier car
  yawGripMultiplier: 0.98,  // was 0.96 — more responsive (AWD helps rotation)
  minSteerSpeed: 1.4,

  grassDrag: 6.5,

  // collision
  wallOffset: 3.4,
  carHalfWidth: 0.98,       // RS6 is wider (1.95m vs 1.85m for 911)
  wallBounce: 0.20,
  wallSpeedScrub: 0.82
};

/**
 * Transmission / engine. Torque flows:
 *   Fwheel = torque(rpm) * gearRatio * finalDrive * 0.9 / wheelRadius
 * rpm = vF / wheelRadius * gearRatio * finalDrive * 60 / (2 pi)
 */
export const TRANSMISSION = {
  idleRpm: 700,
  redline: 6800,           // RS6 V8 redline (~6800 rpm)
  rpmMaxSafe: 7200,
  peakTorqueRpm: 3500,     // twin-turbo V8 peaks low
  maxTorque: 800,          // Nm — RS6 4.0TT V8 (was 420 for Porsche flat-six)
  efficiency: 0.92,        // AWD drivetrain
  gearRatios: [4.71, 3.14, 2.31, 1.81, 1.46, 1.23, 1.02, 0.84], // 8-speed ZF
  reverseRatio: 3.32,
  finalDrive: 3.56,

  autoUpshiftRpm: 6400,
  autoDownshiftRpm: 2200,
  autoDownshiftThrottle: 0.65,
  shiftTime: 0.18,         // ZF 8-speed shifts fast
  shiftRpmEase: 9,
  clutchLockSpeed: 5.5,
  clutchGrip: 38,          // more clutch capacity for the heavier car
  stallRpm: 500
};

export const SUSPENSION = {
  travel: 0.11,              // m of visual wheel travel (was 0.085 — more visible)
  // per-wheel compression inputs (fractions of travel), targets are damped
  rate: 9,                   // spring responsiveness (damp constant)
  bumpCurbAmp: 0.55,         // curb rumble amplitude (fraction of travel)
  bumpCurbFreq: 46,
  accelPitch: 0.035,         // was 0.02 — more visible pitch on accel/brake
  rollG: 0.05,               // was 0.032 — more visible body roll in corners
  maxRoll: 0.085,            // was 0.06 — allow more roll for sim feel
  maxPitch: 0.07             // was 0.05 — allow more pitch
};

export const TRACK = {
  roadHalfWidth: 7,
  sampleCount: 1000,
  checkpoints: [0.3, 0.62, 0.85], // progress s of the 3 gates
  totalLaps: 3
};

export const CAMERA = {
  // --- chase ---------------------------------------------------------------
  fovBase: 60,
  fovSpeedBoost: 14,        // wider FOV at top speed (60 -> ~74) for speed feel
  distanceBase: 6.8,        // consistent comfortable distance
  distanceSpeed: 0.6,       // VERY small pull-back at speed (was 2.7 — too much)
  heightBase: 2.6,
  heightSpeed: 0.15,        // camera barely rises at speed
  posDamping: 7.0,          // tighter follow (was 5.0 — less lag)
  lookDamping: 11.0,        // tighter look (was 9.5)
  lookAhead: 7.0,
  rollMax: 0.04,
  chaseShake: 0.035,        // m of high-speed camera vibration
  // velocity prediction: how far ahead of the *velocity vector* the rig aims
  velocityLead: 0.18,       // less lead = camera doesn't swing wildly
  accelLift: 0.0,           // NO backward motion on accel (was 0.55 — the bug)
  brakeDive: 0.18,          // small dive closer under braking (was 0.45)
  // --- hood ----------------------------------------------------------------
  // Replaces the old cockpit mode. Sits on the hood, no interior needed.
  hoodFov: 68,
  hoodFovBoost: 8,          // hood FOV widens slightly with speed
  hoodLookAhead: 25,        // m forward to look
  hoodDamping: 14,          // tight follow — feels like you're in the car
  hoodLookDamping: 16,
  hoodShake: 0.022,         // cabin vibration amplitude
  // --- cockpit (driver view) -----------------------------------------------
  cockpitFov: 72,
  cockpitFovBoost: 8,       // cockpit FOV widens slightly with speed
  cockpitShake: 0.015       // subtle vibration inside the cabin
};

/** Graphics quality presets. */
export const QUALITY = {
  low: {
    label: 'LOW',
    pixelRatio: 1.0,
    shadows: false,
    shadowMapSize: 512,
    fogFar: 620,
    particles: 0.35,
    aniso: 2
  },
  medium: {
    label: 'MEDIUM',
    pixelRatio: 1.25,
    shadows: true,
    shadowMapSize: 1024,
    fogFar: 850,
    particles: 0.6,
    aniso: 4
  },
  high: {
    label: 'HIGH',
    pixelRatio: 1.6,
    shadows: true,
    shadowMapSize: 1536,
    fogFar: 1100,
    particles: 1.0,
    aniso: 8
  }
};

export const DEFAULT_SETTINGS = {
  transmission: 'auto',    // 'auto' | 'manual'
  camera: 'chase',         // 'chase' | 'cockpit'
  quality: 'medium',       // 'low' | 'medium' | 'high'
  masterVolume: 0.9,       // 0..1
  engineVolume: 0.8,       // 0..1
  steerSensitivity: 1.0,   // 0.6..1.4 multiplier on steering ramp rate
  cameraSmoothing: 1.0,    // 0.6..1.4 multiplier on chase damping
  paint: 'guardsRed'       // key into PAINTS
};

/**
 * GLB assets (pre-optimized with gltf-transform, quantized).
 * All three are fetched up-front and precached by the service worker so the
 * whole game lives on the device after the first visit.
 */
export const MODELS = {
  car: './models/porsche_911.glb',
  interior: './models/interior.glb',
  tree: './models/tree.glb'
};

/**
 * Porsche 911 exterior paint presets — applied to the car's "paint" material
 * as deep clearcoat lacquer. Hex values tuned for the night lighting rig.
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
