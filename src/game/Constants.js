/**
 * Central tuning constants for Apex Circuit.
 * All units are meters / seconds / radians unless noted.
 */

export const WORLD = {
  fogColor: 0xc3dcea,
  fogNear: 170,
  fogFar: 1250,
  skyTop: 0x3a7bd5,
  skyHorizon: 0xcfe8f7,
  skyGround: 0xb9cfd8,
  sunColor: 0xfff1d6,
  sunIntensity: 2.8,
  hemiSky: 0xbdd9ff,
  hemiGround: 0x557a3e,
  hemiIntensity: 1.0,
  // direction the sun shines FROM (normalized in code)
  sunDirection: [0.42, 0.62, 0.3]
};

export const CAR = {
  maxSpeed: 62,            // m/s  (~223 km/h)
  maxReverseSpeed: 12,
  engineAccel: 26,         // m/s^2 at standstill
  engineTaper: 2.1,        // exponent of the power curve
  brakeDecel: 34,
  reverseAccel: 11,
  rollingResistance: 0.9,
  airDrag: 0.00072,        // * v^2
  wheelbase: 2.6,

  // lateral grip
  gripAsphalt: 26,         // max lateral acceleration m/s^2
  gripGrass: 9,
  handbrakeGripFactor: 0.3,
  highSteerGripFactor: 0.82,   // traction loss at full lock + speed
  powerOversteerFactor: 0.86,  // traction loss at full throttle + steer
  lateralDamp: 2.0,            // extra decay so slides settle

  // yaw rate limits (speed dependent steering)
  maxYawLowSpeed: 2.7,     // rad/s cap when slow
  yawGripMultiplier: 1.16, // how close commanded yaw is to the grip circle
  minSteerSpeed: 1.6,      // m/s below which steering fades out

  grassEngineFactor: 0.55,
  grassDrag: 5.0,

  // collision
  wallOffset: 3.4,         // wall distance beyond road half width
  carHalfWidth: 0.95,
  wallBounce: 0.25,        // how much lateral velocity survives a hit
  wallSpeedScrub: 0.86     // forward speed kept when scraping the wall
};

export const TRACK = {
  roadHalfWidth: 7,
  sampleCount: 1000,
  checkpoints: [0.3, 0.62, 0.85], // progress s of the 3 gates
  totalLaps: 3
};

export const GEARS = [0, 9, 17, 26, 36, 48, 63]; // m/s boundaries, 6 gears

export const CAMERA = {
  fovBase: 62,
  fovSpeedBoost: 11,
  distanceBase: 7.4,
  distanceSpeed: 3.4,
  heightBase: 3.1,
  heightSpeed: 0.6,
  posDamping: 5.2,
  lookDamping: 9.0,
  lookAhead: 7.5,
  rollMax: 0.045
};

export function gearForSpeed(v) {
  for (let i = GEARS.length - 1; i >= 0; i--) {
    if (v >= GEARS[i]) return Math.min(i + 1, GEARS.length - 1);
  }
  return 1;
}

/** normalized rpm 0..1 inside the current gear band (for engine audio) */
export function rpmNormForSpeed(v) {
  const g = gearForSpeed(v);
  const lo = GEARS[g - 1] ?? 0;
  const hi = GEARS[g] ?? CAR.maxSpeed;
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}
