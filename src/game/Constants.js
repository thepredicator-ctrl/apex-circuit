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
  mass: 1180,               // kg
  wheelbase: 2.96,          // m (track 1.6 wide)
  cgHeight: 0.52,           // m — drives longitudinal load transfer
  weightDistFront: 0.52,    // static load fraction on the front axle
  wheelRadius: 0.34,        // m — also used for wheel spin / rpm math

  maxSpeed: 66,             // m/s (~238 km/h) achieved at redline in 6th
  maxReverseSpeed: 11,
  brakeDecel: 30,           // m/s^2 at full load
  rollingResistance: 0.35,  // * g — radial tires
  airDrag: 0.00042,         // * v^2 (Cd*A/rho folded in)
  downforce: 1.9,           // * v^2 -> added vertical load (N)

  // lateral grip (per-axle mu * load handles the rest)
  gripAsphalt: 1.35,        // tire friction coefficient (dry asphalt, arcade-ish)
  gripGrass: 0.55,
  handbrakeRearGrip: 0.34,  // rear mu multiplier with handbrake
  powerOversteerFactor: 0.80, // rear mu multiplier at high throttle + steer
  highSteerGripFactor: 0.88,  // front mu loss at full lock + speed
  lateralDamp: 1.6,         // extra slide settle
  yawDamping: 7.5,          // yaw-rate response smoothing

  // yaw rate limits (speed dependent steering)
  maxYawLowSpeed: 2.6,      // rad/s cap when slow
  yawGripMultiplier: 1.05,  // how close commanded yaw may hug the grip circle
  minSteerSpeed: 1.4,       // m/s below which steering fades out

  grassDrag: 6.5,

  // collision
  wallOffset: 3.4,          // wall distance beyond road half width
  carHalfWidth: 0.95,
  wallBounce: 0.25,         // how much lateral velocity survives a hit
  wallSpeedScrub: 0.86      // forward speed kept when scraping the wall
};

/**
 * Transmission / engine. Torque flows:
 *   Fwheel = torque(rpm) * gearRatio * finalDrive * 0.9 / wheelRadius
 * rpm = vF / wheelRadius * gearRatio * finalDrive * 60 / (2 pi)
 */
export const TRANSMISSION = {
  idleRpm: 900,
  redline: 7600,
  rpmMaxSafe: 8000,        // hard cut
  peakTorqueRpm: 5300,
  maxTorque: 420,          // Nm at the crank
  efficiency: 0.9,         // drivetrain
  gearRatios: [3.55, 2.36, 1.85, 1.47, 1.2, 0.99], // 1..6
  reverseRatio: 3.2,
  finalDrive: 3.7,

  autoUpshiftRpm: 7150,
  autoDownshiftRpm: 2450,
  autoDownshiftThrottle: 0.65, // kickdown below this shifts earlier (rpm<5k)
  shiftTime: 0.22,         // s of torque cut between gears
  shiftRpmEase: 9,         // rpm blend speed during a shift
  clutchLockSpeed: 5.5,    // m/s below which the clutch slips on launch
  clutchGrip: 34,          // max launch force m/s^2 while slipping
  stallRpm: 500            // below this in-gear with clutch locked => slip too
};

export const SUSPENSION = {
  travel: 0.085,           // m of visual wheel travel
  // per-wheel compression inputs (fractions of travel), targets are damped
  rate: 9,                 // spring responsiveness (damp constant)
  bumpCurbAmp: 0.55,       // curb rumble amplitude (fraction of travel)
  bumpCurbFreq: 46,
  accelPitch: 0.02,        // rad at ~1g braking/accel
  rollG: 0.032,            // rad per g lateral
  maxRoll: 0.06,
  maxPitch: 0.05
};

export const TRACK = {
  roadHalfWidth: 7,
  sampleCount: 1000,
  checkpoints: [0.3, 0.62, 0.85], // progress s of the 3 gates
  totalLaps: 3
};

export const CAMERA = {
  // --- chase ---------------------------------------------------------------
  fovBase: 62,
  fovSpeedBoost: 17,        // wide-angle rush at top speed (62 -> ~79)
  distanceBase: 7.2,
  distanceSpeed: 2.7,       // pulls IN slightly less than before (tighter = faster feel)
  heightBase: 2.95,
  heightSpeed: 0.45,        // camera stays lower at speed
  posDamping: 5.0,
  lookDamping: 9.5,
  lookAhead: 8.5,
  rollMax: 0.05,
  chaseShake: 0.05,         // m of high-speed camera vibration
  // velocity prediction: how far ahead of the *velocity vector* the rig aims
  velocityLead: 0.28,
  accelLift: 0.55,          // camera rises back under acceleration (m)
  brakeDive: 0.45,          // drops closer under braking (m)
  // --- cockpit -------------------------------------------------------------
  cockpitFov: 70,
  cockpitFovBoost: 7,       // cockpit FOV also widens with speed
  cockpitPos: [-0.13, 1.06, 0.14], // local to car model space (nose=+Z)
  cockpitLookAhead: 30,
  cockpitDamping: 10,
  cockpitAccelDip: 0.028,   // m of head travel per g
  cockpitRollInfluence: 0.5,
  cockpitShake: 0.02        // cabin vibration amplitude
};

/** Graphics quality presets. */
export const QUALITY = {
  low: {
    label: 'LOW',
    pixelRatio: 1.0,
    shadows: false,
    shadowMapSize: 512,
    fogFar: 620,
    particles: 0.45,
    aniso: 2
  },
  medium: {
    label: 'MEDIUM',
    pixelRatio: 1.6,
    shadows: true,
    shadowMapSize: 1024,
    fogFar: 900,
    particles: 0.8,
    aniso: 4
  },
  high: {
    label: 'HIGH',
    pixelRatio: 1.9,
    shadows: true,
    shadowMapSize: 2048,
    fogFar: 1200,
    particles: 1.2,
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
