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
  mass: 1450,               // kg — mid-size sedan
  wheelbase: 2.7,           // m
  cgHeight: 0.55,           // m — taller sedan = higher CG = more roll
  weightDistFront: 0.58,    // nose-heavy FWD layout
  wheelRadius: 0.33,        // m — 17" wheels

  maxSpeed: 62,             // m/s (~220 km/h)
  maxReverseSpeed: 12,
  brakeDecel: 26,           // m/s^2
  rollingResistance: 0.35,
  airDrag: 0.00045,
  downforce: 0.6,           // sedan = minimal downforce

  // lateral grip — moderate, breakable for fun slides
  gripAsphalt: 1.05,        // modest street tires
  gripGrass: 0.40,
  handbrakeRearGrip: 0.25,
  powerOversteerFactor: 0.70,
  highSteerGripFactor: 0.80,
  lateralDamp: 1.6,
  yawDamping: 5.5,          // less damped = more rotational feel

  // INSANE turning — way more yaw authority than realistic
  maxYawLowSpeed: 3.2,      // was 1.75 — nearly twice the rotation rate
  yawGripMultiplier: 1.15,  // was 0.98 — over-rotate past the grip circle
  minSteerSpeed: 1.0,       // earlier steering response

  grassDrag: 6.5,

  // collision
  wallOffset: 3.4,
  carHalfWidth: 0.92,
  wallBounce: 0.25,
  wallSpeedScrub: 0.85
};

/**
 * Transmission / engine — mid-size sedan naturally aspirated 2.5L 4-cyl.
 */
export const TRANSMISSION = {
  idleRpm: 750,
  redline: 6500,
  rpmMaxSafe: 6800,
  peakTorqueRpm: 4000,
  maxTorque: 250,           // Nm — modest 4-cyl
  efficiency: 0.88,
  gearRatios: [3.62, 2.04, 1.34, 0.97, 0.78],  // 5-speed manual
  reverseRatio: 3.31,
  finalDrive: 3.94,

  autoUpshiftRpm: 6000,
  autoDownshiftRpm: 2200,
  autoDownshiftThrottle: 0.65,
  shiftTime: 0.20,
  shiftRpmEase: 9,
  clutchLockSpeed: 5.0,
  clutchGrip: 28,
  stallRpm: 500
};

export const SUSPENSION = {
  travel: 0.28,             // INSANE — was 0.11. 28cm of wheel travel!
  rate: 6,                  // softer spring = more bounce
  bumpCurbAmp: 0.8,         // huge curb rumble
  bumpCurbFreq: 40,
  accelPitch: 0.08,         // was 0.035 — huge pitch on accel/brake
  rollG: 0.09,              // was 0.05 — huge body roll
  maxRoll: 0.18,            // was 0.085 — allow 10° of roll
  maxPitch: 0.15            // was 0.07 — allow 8.5° of pitch
};

export const TRACK = {
  roadHalfWidth: 7,
  sampleCount: 200,
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
