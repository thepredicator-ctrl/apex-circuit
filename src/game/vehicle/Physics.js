/**
 * @fileoverview Vehicle physics — DYNAMIC bicycle model with real tire behavior.
 *
 * The car is a rigid body in the horizontal plane whose motion EMERGES from
 * tire forces:
 *   - per-axle slip angles + Pacejka-style magic formula with post-peak falloff
 *   - friction ellipse couples longitudinal/lateral grip
 *   - longitudinal + lateral load transfer, aero downforce, load-sensitive mu
 *   - ABS pumps each axle just below the friction peak
 *   - handbrake locks the rear axle with kinetic sliding friction
 *   - tire force relaxation length, rack-rate-limited steering
 *   - low-speed kinematic blend for parking / reverse
 *
 * Surfaces come from the World facade. Grip differs by surface type and
 * Weather.js applies a global wet-road multiplier.
 */

import * as THREE from 'three';
import { CAR, ROAD, ROAD_INFO } from '../core/Constants.js';

// ============================================================================
// Module-level utilities
// ============================================================================

const { clamp, damp, lerp } = THREE.MathUtils;

/**
 * Smoothstep with edge0 < edge1.
 * @param {number} e0
 * @param {number} e1
 * @param {number} x
 * @returns {number}
 */
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Pacejka magic formula (simplified).
 * @param {number} alpha — slip angle (rad)
 * @param {number} B — stiffness factor
 * @param {number} C — shape factor
 * @returns {number}
 */
function pacejka(alpha, B, C) {
  return Math.sin(C * Math.atan(B * alpha));
}

/**
 * Load-sensitive friction coefficient.
 * @param {number} mu — base coefficient
 * @param {number} Fz — current normal load
 * @param {number} Fz0 — reference normal load
 * @returns {number}
 */
function loadSensitiveMu(mu, Fz, Fz0) {
  return mu * clamp(1 - CAR.loadSens * (Fz - Fz0) / Fz0, 0.8, 1.15);
}

// ============================================================================
// Constants
// ============================================================================

const G = 9.81;

const CFG = Object.freeze({
  STEERING: Object.freeze({
    RACK_RATE_FACTOR: 4.2,      // full lock in ~0.24 s
    FADE_EXPONENT: 0.85,
  }),
  SLIP: Object.freeze({
    MIN_SPEED: 1.1,             // minimum longitudinal speed for slip calc
    REVERSE_THRESHOLD: -0.2,    // m/s, below this we treat velocity as reverse
    FALLOFF_START: 1,           // multiplier for peak angle
    FALLOFF_END: 3,             // multiplier for peak angle
  }),
  DRIVE: Object.freeze({
    WHEELSPIN_OSCILLATION_HZ: 30,
    WHEELSPIN_DRIVE_RETENTION: 0.95,
    WHEELSPIN_OSCILLATION_AMP: 0.05,
    REVERSE_LIMIT_FRAC: 0.92,
  }),
  BRAKE: Object.freeze({
    MIN_EFFECT_SPEED: 0.35,     // m/s, below this braking is ignored
    FLUTTER_BASE: 0.965,
    FLUTTER_AMP: 0.035,
  }),
  HANDBRAKE: Object.freeze({
    MU_FRACTION: 0.62,
    MIN_SLIDE_SPEED: 0.4,
  }),
  HOLD_STILL: Object.freeze({
    MAX_FORCE: 2000,
  }),
  FRICTION_ELLIPSE: Object.freeze({
    LONG_COUPLE: 0.94,
  }),
  GRAVITY_ROLL_COUPLING: 0.85,
  POSITION_DAMPING: 14,
  LAT_ACCEL_DAMPING: 8,
  LONG_ACCEL_DAMPING: 7,
  SUSPENSION: Object.freeze({
    BASE: 0.5,
    LONG_XFER: 0.38,
    LAT_XFER: 0.36,
    DAMPING: 10,
    BUMP_SCALE: 3.2,
    SHOULDER_BUMP_FREQ: 38,
    SHOULDER_BUMP_AMP: 0.35,
    GRASS_JITTER_FREQ: 15,
    GRASS_JITTER_AMP: 0.16,
    GRASS_JITTER_H1: 3.1,
    GRASS_JITTER_H2: 5.7,
    GRASS_JITTER_ASYM_FR: 0.8,
    GRASS_JITTER_ASYM_RL: 0.7,
  }),
  LOW_SPEED: Object.freeze({
    TIRE_DECAY: 0.9,
    STOP_THRESHOLD: 0.02,
  }),
  SURFACE_GRIP: Object.freeze({
    ASPHALT: CAR.muAsphalt,
    SHOULDER: CAR.muAsphalt * 0.86,
    DIRT: CAR.muAsphalt * 0.72,
    GRASS: CAR.muGrass,
  }),
});

/** @type {ReadonlyArray<{fx:number, rx:number}>} */
const WHEEL_OFFSETS = Object.freeze([
  { fx: 1, rx: -1 }, // FL
  { fx: 1, rx: 1 },  // FR
  { fx: -1, rx: -1 }, // RL
  { fx: -1, rx: 1 },  // RR
]);

// ============================================================================
// JSDoc Types
// ============================================================================

/**
 * @typedef {Object} InputState
 * @property {number} throttle  — 0..1
 * @property {number} brake     — 0..1
 * @property {number} steer     — -1..1
 * @property {boolean} handbrake
 */

/**
 * @typedef {Object} InputBundle
 * @property {InputState} state
 */

/**
 * @typedef {Object} SurfaceSample
 * @property {number} y
 * @property {boolean} onRoad
 * @property {number} grade
 * @property {number} bank
 * @property {number} lateral
 * @property {number} halfWidth
 * @property {number} roadType
 * @property {boolean} bridge
 * @property {boolean} shoulder
 */

/**
 * @typedef {Object} AxleLoads
 * @property {number} FzF — front normal load (N)
 * @property {number} FzR — rear normal load (N)
 * @property {number} staticF
 * @property {number} staticR
 */

/**
 * @typedef {Object} TireForces
 * @property {number} fyF
 * @property {number} fyR
 * @property {number} alphaF
 * @property {number} alphaR
 */

/**
 * @typedef {Object} LongitudinalForces
 * @property {number} FxF
 * @property {number} FxR
 * @property {boolean} rearSliding
 * @property {number} fyRSlide
 * @property {boolean} wheelspin
 */

// ============================================================================
// VehiclePhysics
// ============================================================================

export class VehiclePhysics {
  /**
   * @param {import('./World').World} world
   * @param {Object} transmission
   */
  constructor(world, transmission) {
    if (!world || typeof world.surfaceAt !== 'function') {
      throw new TypeError('VehiclePhysics requires a valid World instance');
    }

    this.world = world;
    this.trans = transmission;

    // ---- kinematic state ----------------------------------------------------
    this.position = new THREE.Vector3();
    this.heading = 0;           // rad, 0 = +Z
    this.yawRate = 0;         // rad/s
    this.u = 0;               // forward velocity, body frame (m/s)
    this.v = 0;               // lateral velocity, body frame (+ = right)

    // axle tire force states (relaxation lag)
    this._fyF = 0;
    this._fyR = 0;
    this._delta = 0;          // current front-wheel angle (rack state)

    /** @type {THREE.Vector3} World-frame velocity (derived). */
    this.velocity = new THREE.Vector3();

    // ---- telemetry ----------------------------------------------------------
    this.vF = 0;
    this.vL = 0;
    this.slip = 0;
    this.slipAngleFront = 0;
    this.slipAngleRear = 0;
    this.latAccel = 0;
    this.aLongS = 0;
    this.steerAngle = 0;
    this.throttleOut = 0;
    this.brakeOut = 0;
    this.absActive = false;
    this.reversing = false;
    this.wheelspin = false;
    this.rearLocked = false;
    this.engineForce = 0;
    this.gForceLat = 0;
    this.gForceLong = 0;

    // surface telemetry
    this.lateral = 0;
    this.onGrass = false;
    this.onDirt = false;
    this.onShoulder = false;
    this.onCurb = false;
    this.onRoad = true;
    this.roadType = ROAD.HIGHWAY;
    this.surfaceY = 0;
    this.roadPitch = 0;
    this.roadRoll = 0;
    this.gripMul = 1.0;       // global weather multiplier (set by Game)

    // suspension targets (FL, FR, RL, RR) and smoothed outputs
    this.susp = [0.5, 0.5, 0.5, 0.5];
    this._suspSmooth = [0.5, 0.5, 0.5, 0.5];
    this._bumpPhase = 0;

    // per-wheel world ground heights — consumed by Car visuals
    /** @type {Float32Array} */
    this.wheelGroundY = new Float32Array(4);

    // transient state
    this.justHitWall = false;
    this.hitImpact = 0;
    this._time = 0;

    // pre-allocated temporaries to avoid GC during update()
    /** @private @type {Float32Array} */
    this._wheelHeights = new Float32Array(4);
    /** @private @type {THREE.Vector3} */
    this._tmpVec = new THREE.Vector3();
  }

  /** @deprecated Use `this.world` instead. */
  get track() {
    return this.world;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Place the car at a world pose (used by spawn / reset).
   *
   * @param {number} x
   * @param {number} z
   * @param {number} heading — radians, 0 = +Z
   */
  placeAtWorld(x, z, heading) {
    if (!Number.isFinite(x)) throw new TypeError(`x must be finite, got ${x}`);
    if (!Number.isFinite(z)) throw new TypeError(`z must be finite, got ${z}`);
    if (!Number.isFinite(heading)) throw new TypeError(`heading must be finite, got ${heading}`);

    this.position.set(x, 0, z);
    this.heading = heading;
    this.u = 0;
    this.v = 0;
    this.yawRate = 0;
    this._delta = 0;
    this._fyF = 0;
    this._fyR = 0;
    this.velocity.set(0, 0, 0);
    this.vF = 0;
    this.vL = 0;
    this.latAccel = 0;
    this.aLongS = 0;

    const surf = this._sampleSurfaceAt(x, z);
    this.position.y = surf.y;
    this._resetSurfaceFlags();
    this.susp.fill(0.5);
    this._suspSmooth.fill(0.5);
  }

  /**
   * Main physics tick.
   *
   * @param {number} dt — delta time in seconds
   * @param {InputBundle} input
   * @param {boolean} controlsActive
   */
  update(dt, input, controlsActive) {
    if (!Number.isFinite(dt) || dt < 0) {
      throw new TypeError(`dt must be a finite non-negative number, got ${dt}`);
    }
    if (!input || !input.state) {
      throw new TypeError('input.state is required');
    }

    this.justHitWall = false;
    this._time += dt;

    // ---- unpack inputs ------------------------------------------------------
    const throttle = controlsActive ? clamp(input.state.throttle, 0, 1) : 0;
    const driverBrake = controlsActive ? clamp(input.state.brake, 0, 1) : 0;
    const steerInput = controlsActive ? clamp(input.state.steer, -1, 1) : 0;
    const handbrake = controlsActive && !!input.state.handbrake;
    const holdStill = !controlsActive;

    this.throttleOut = throttle;
    this.brakeOut = driverBrake;

    // ---- geometry shortcuts -------------------------------------------------
    const m = CAR.mass;
    const L = CAR.wheelbase;
    const a = CAR.aFront;
    const b = CAR.bRear;

    // ---- steering ---------------------------------------------------------
    const delta = this._updateSteering(dt, steerInput);

    // ---- surface & transmission ---------------------------------------------
    const surf = this._sampleSurfaceAt(this.position.x, this.position.z);
    this._updateSurfaceFlags(surf);

    this.trans.update(dt, {
      wheelSpeed: this.u,
      throttle,
      brake: driverBrake,
      controlsActive,
    });

    // ---- axle loads ---------------------------------------------------------
    const loads = this._computeAxleLoads();
    const { FzF, FzR, staticF, staticR } = loads;

    // ---- surface grip -------------------------------------------------------
    const muBase = this._computeSurfaceGrip();
    const muLong = muBase * CAR.muLongScale;

    const muFeff = loadSensitiveMu(muBase, FzF, staticF);
    const muReff = loadSensitiveMu(muBase, FzR, staticR);

    // ---- slip angles & lateral forces ---------------------------------------
    const vAbsU = Math.abs(this.u);
    const ux = Math.max(vAbsU, CFG.SLIP.MIN_SPEED);
    const sgn = this.u < CFG.SLIP.REVERSE_THRESHOLD ? -1 : 1;

    const tireResult = this._computeLateralForces(delta, ux, sgn, FzF, FzR, muFeff, muReff);
    const { fyF, fyR, alphaF, alphaR } = tireResult;

    // ---- longitudinal forces ------------------------------------------------
    const longResult = this._computeLongitudinalForces(
      driverBrake, handbrake, muBase, FzF, FzR, muFeff, muReff, delta, holdStill
    );
    let { FxF, FxR, rearSliding, fyRSlide } = longResult;
    this.wheelspin = longResult.wheelspin;
    this.rearLocked = handbrake;
    this.engineForce = this.trans.driveForce;

    // ---- friction ellipse (combined slip) ---------------------------------
    const capped = this._applyFrictionEllipse(
      FxF, FxR, fyF, fyR, rearSliding, FzF, FzR, muFeff, muReff, muLong
    );
    FxF = capped.FxF;
    FxR = capped.FxR;
    const fyFfinal = capped.fyF;
    const fyRfinal = capped.fyR;

    // ---- resistances --------------------------------------------------------
    const crr = this.onGrass ? CAR.grassRollingResistance
      : (this.onDirt ? 0.03 : CAR.rollingResistance);
    const Fres = this._computeResistances(crr, vAbsU, throttle, driverBrake, holdStill);

    // ---- forces in body frame ---------------------------------------------
    const cosD = Math.cos(delta);
    const sinD = Math.sin(delta);
    const fyFw = fyFfinal * cosD + FxF * sinD;

    let Fx = FxR + FxF * cosD - fyFfinal * sinD + Fres;
    let Fy = fyRfinal + fyFw;
    Fy += -m * G * Math.sin(this.roadRoll) * CFG.GRAVITY_ROLL_COUPLING;
    const Mz = -a * fyFw + b * fyRfinal;

    // ---- debug telemetry ----------------------------------------------------
    this.dbgFx = Fx;
    this.dbgFy = Fy;
    this.dbgDrive = FxR;
    this.dbgBrake = FxF;
    this.dbgFyF = fyFfinal;
    this.dbgFyR = fyRfinal;
    this.dbgFres = Fres;

    // ---- integration --------------------------------------------------------
    this._integrateState(dt, Fx, Fy, Mz, delta);

    // ---- post-movement surface sample & position damping --------------------
    const surf2 = this._sampleSurfaceAt(this.position.x, this.position.z);
    this._finalizeFrame(dt, surf2);

    // ---- suspension ---------------------------------------------------------
    this._updateSuspension(dt);

    // ---- low-speed tire decay -----------------------------------------------
    if (vAbsU < 0.1) {
      this._fyF *= CFG.LOW_SPEED.TIRE_DECAY;
      this._fyR *= CFG.LOW_SPEED.TIRE_DECAY;
    }

    // ---- final telemetry ----------------------------------------------------
    this._updateTelemetry(Fx, alphaF, alphaR);
  }

  // ------------------------------------------------------------------
  // Getters
  // ------------------------------------------------------------------

  get suspSmooth() {
    return this._suspSmooth;
  }

  get speedKmh() {
    return Math.abs(this.vF) * 3.6;
  }

  /** @returns {string} Road label for the HUD. */
  get roadLabel() {
    return ROAD_INFO[this.roadType]?.label ?? 'OFF-ROAD';
  }

  // ------------------------------------------------------------------
  // Private: Surface
  // ------------------------------------------------------------------

  /**
   * Samples the world surface at (x,z) using the car's current heading.
   * @param {number} x
   * @param {number} z
   * @returns {SurfaceSample}
   */
  _sampleSurfaceAt(x, z) {
    const fwdX = Math.sin(this.heading);
    const fwdZ = Math.cos(this.heading);
    return this.world.surfaceAt(x, z, fwdX, fwdZ);
  }

  _resetSurfaceFlags() {
    this.onGrass = false;
    this.onShoulder = false;
    this.onCurb = false;
    this.onDirt = false;
    this.onRoad = true;
    this.roadType = ROAD.HIGHWAY;
  }

  /**
   * Updates surface telemetry flags from a surface sample.
   * @param {SurfaceSample} surf
   */
  _updateSurfaceFlags(surf) {
    this.surfaceY = surf.y;
    this.roadPitch = Math.atan(surf.grade);
    this.roadRoll = Math.atan(surf.bank);
    this.lateral = surf.lateral;
    this.roadType = surf.roadType;

    this.onRoad = surf.onRoad;
    this.onShoulder = !surf.onRoad && surf.shoulder;
    this.onCurb = false; // TODO: derive from curb surface flag when available
    this.onDirt = surf.roadType === ROAD.DIRT;
    this.onGrass = !surf.onRoad && !surf.shoulder && !surf.bridge;
  }

  // ------------------------------------------------------------------
  // Private: Steering
  // ------------------------------------------------------------------

  /**
   * @param {number} dt
   * @param {number} steerInput — clamped -1..1
   * @returns {number} delta (front wheel angle)
   */
  _updateSteering(dt, steerInput) {
    const vAbsU = Math.abs(this.u);
    const fadeT = Math.pow(clamp(vAbsU / CAR.steerFadeSpeed, 0, 1), CFG.STEERING.FADE_EXPONENT);
    const maxSteer = CAR.maxSteerRoad * lerp(1, CAR.steerFastFrac, fadeT);
    const targetDelta = steerInput * maxSteer;
    const rackRate = CFG.STEERING.RACK_RATE_FACTOR * maxSteer;
    const dDelta = clamp(targetDelta - this._delta, -rackRate * dt, rackRate * dt);
    this._delta += dDelta;
    return this._delta;
  }

  // ------------------------------------------------------------------
  // Private: Loads & Grip
  // ------------------------------------------------------------------

  /**
   * @returns {AxleLoads}
   */
  _computeAxleLoads() {
    const m = CAR.mass;
    const L = CAR.wheelbase;
    const a = CAR.aFront;
    const b = CAR.bRear;
    const df = CAR.downforce * this.u * this.u;

    const staticF = m * G * b / L;
    const staticR = m * G * a / L;
    const longXfer = m * this.aLongS * CAR.cgHeight / L;

    return {
      FzF: Math.max(m * G * 0.06, staticF - longXfer + df * CAR.downforceFront),
      FzR: Math.max(m * G * 0.06, staticR + longXfer + df * (1 - CAR.downforceFront)),
      staticF,
      staticR,
    };
  }

  /**
   * @returns {number} muBase
   */
  _computeSurfaceGrip() {
    let surfMu;
    if (this.onGrass) {
      surfMu = CFG.SURFACE_GRIP.GRASS;
    } else if (this.onDirt) {
      surfMu = CFG.SURFACE_GRIP.DIRT;
    } else if (this.onShoulder) {
      surfMu = CFG.SURFACE_GRIP.SHOULDER;
    } else {
      surfMu = CFG.SURFACE_GRIP.ASPHALT;
    }
    return surfMu * this.gripMul;
  }

  // ------------------------------------------------------------------
  // Private: Lateral Forces
  // ------------------------------------------------------------------

  /**
   * @returns {TireForces}
   */
  _computeLateralForces(delta, ux, sgn, FzF, FzR, muFeff, muReff) {
    const alphaF = Math.atan2(this.v - this.yawRate * CAR.aFront, ux) - delta * sgn;
    const alphaR = Math.atan2(this.v + this.yawRate * CAR.bRear, ux);

    const peakF = Math.tan(Math.PI / (2 * CAR.tireCFront)) / CAR.tireBFront;
    const peakR = Math.tan(Math.PI / (2 * CAR.tireCRear)) / CAR.tireBRear;

    const fallF = 1 - CAR.slipFalloff * smoothstep(
      peakF * CFG.SLIP.FALLOFF_START,
      peakF * CFG.SLIP.FALLOFF_END,
      Math.abs(alphaF)
    );
    const fallR = 1 - CAR.slipFalloff * smoothstep(
      peakR * CFG.SLIP.FALLOFF_START,
      peakR * CFG.SLIP.FALLOFF_END,
      Math.abs(alphaR)
    );

    let fyFTarget = -muFeff * FzF * pacejka(alphaF, CAR.tireBFront, CAR.tireCFront) * fallF;
    let fyRTarget = -muReff * FzR * pacejka(alphaR, CAR.tireBRear, CAR.tireCRear) * fallR;

    // relaxation length lag
    const vAbsU = Math.abs(this.u);
    const relaxK = clamp(vAbsU * dt / CAR.relaxLength, 0, CFG.SLIP.MIN_SPEED);
    this._fyF += (fyFTarget - this._fyF) * relaxK;
    this._fyR += (fyRTarget - this._fyR) * relaxK;

    return {
      fyF: this._fyF,
      fyR: this._fyR,
      alphaF,
      alphaR,
    };
  }

  // ------------------------------------------------------------------
  // Private: Longitudinal Forces
  // ------------------------------------------------------------------

  /**
   * @returns {LongitudinalForces}
   */
  _computeLongitudinalForces(driverBrake, handbrake, muBase, FzF, FzR, muFeff, muReff, delta, holdStill) {
    let driveF = this.trans.driveForce;
    const muLong = muBase * CAR.muLongScale;
    const FmaxR = muLong * FzR;
    let wheelspin = false;

    // Handbrake kills drive torque
    if (handbrake) driveF = 0;

    // Clamp drive force to rear friction circle
    if (driveF > FmaxR) {
      const osc = CFG.DRIVE.WHEELSPIN_OSCILLATION_AMP *
        Math.sin(this._time * CFG.DRIVE.WHEELSPIN_OSCILLATION_HZ);
      driveF = FmaxR * (CFG.DRIVE.WHEELSPIN_DRIVE_RETENTION + osc);
      wheelspin = true;
      this.trans.wheelspin = true;
    } else if (driveF < -FmaxR * CFG.DRIVE.REVERSE_LIMIT_FRAC) {
      driveF = -FmaxR * CFG.DRIVE.REVERSE_LIMIT_FRAC;
      wheelspin = true;
      this.trans.wheelspin = true;
    } else {
      this.trans.wheelspin = false;
    }

    // Brakes
    const vAbsU = Math.abs(this.u);
    const braking = driverBrake > 0 && vAbsU > CFG.BRAKE.MIN_EFFECT_SPEED;
    const reverseDrive = this.trans.mode === 'auto' && this.trans.gear === -1;
    let FxF = 0;
    let FxR = driveF;
    this.absActive = false;

    if (braking && !(reverseDrive && this.u < CFG.BRAKE.MIN_EFFECT_SPEED)) {
      const demand = CAR.brakeMaxDecel * CAR.mass * driverBrake;
      const dir = Math.sign(this.u) || 1;

      let frontBrake = demand * CAR.brakeBiasFront;
      let rearBrake = demand * (1 - CAR.brakeBiasFront);

      const flutter = CFG.BRAKE.FLUTTER_BASE +
        CFG.BRAKE.FLUTTER_AMP * Math.sin(this._time * CAR.absFlutterHz * Math.PI * 2);

      const absF = muFeff * FzF * CAR.absPeakFrac;
      const absR = muReff * FzR * CAR.absPeakFrac;

      if (frontBrake > absF) {
        frontBrake = absF * flutter;
        this.absActive = true;
      }
      if (rearBrake > absR) {
        rearBrake = absR * flutter;
        this.absActive = true;
      }

      FxF = -dir * frontBrake;
      FxR += -dir * rearBrake;
    }

    // Handbrake: rear axle locks — kinetic sliding friction
    let rearSliding = false;
    let fyRSlide = 0;

    if (handbrake) {
      rearSliding = true;
      const vRx = this.u;
      const vRy = this.v + this.yawRate * CAR.bRear;
      const vRs = Math.hypot(vRx, vRy);

      if (vRs > CFG.HANDBRAKE.MIN_SLIDE_SPEED) {
        const muSlide = muBase * CFG.HANDBRAKE.MU_FRACTION;
        FxR = -muSlide * FzR * (vRx / vRs);
        fyRSlide = -muSlide * FzR * (vRy / vRs);
      } else {
        FxR = 0;
        fyRSlide = 0;
      }
    }

    // Hold-still auto-brake when AI / menu takes over
    if (holdStill) {
      FxR += -Math.sign(this.u || 1) * Math.min(CFG.HOLD_STILL.MAX_FORCE, Math.abs(this.u) * CAR.mass);
    }

    return { FxF, FxR, rearSliding, fyRSlide, wheelspin };
  }

  // ------------------------------------------------------------------
  // Private: Friction Ellipse
  // ------------------------------------------------------------------

  _applyFrictionEllipse(FxF, FxR, fyF, fyR, rearSliding, FzF, FzR, muFeff, muReff, muLong) {
    const FmaxF = muLong * FzF;
    const FmaxR = muLong * FzR;

    if (Math.abs(FxR) > FmaxR) FxR = Math.sign(FxR) * FmaxR;
    if (Math.abs(FxF) > FmaxF) FxF = Math.sign(FxF) * FmaxF;

    const capF = Math.sqrt(Math.max(0, (muFeff * FzF) ** 2 - (FxF * CFG.FRICTION_ELLIPSE.LONG_COUPLE) ** 2));
    const capR = Math.sqrt(Math.max(0, (muReff * FzR) ** 2 - (FxR * CFG.FRICTION_ELLIPSE.LONG_COUPLE) ** 2));

    const fyFcapped = clamp(fyF, -capF, capF);
    const fyRcapped = rearSliding ? fyR : clamp(fyR, -capR, capR);

    if (!rearSliding && Math.abs(fyR) > capR && this.trans.driveForce > 0) {
      this.trans.wheelspin = true;
    }

    return { FxF, FxR, fyF: fyFcapped, fyR: fyRcapped };
  }

  // ------------------------------------------------------------------
  // Private: Resistances
  // ------------------------------------------------------------------

  _computeResistances(crr, vAbsU, throttle, driverBrake, holdStill) {
    let Fres = -CAR.airDrag * this.u * vAbsU - crr * CAR.mass * G * Math.sign(this.u || 0);

    if (this.onGrass && vAbsU > 0.5) {
      Fres -= CAR.grassDrag * CAR.mass * Math.sign(this.u) * Math.min(1, vAbsU / 6);
    }

    // Auto-stop at very low speed to prevent infinite creeping
    if (vAbsU < CFG.LOW_SPEED.STOP_THRESHOLD && throttle === 0 && driverBrake === 0 && !holdStill) {
      Fres = 0;
    }

    return Fres;
  }

  // ------------------------------------------------------------------
  // Private: Integration
  // ------------------------------------------------------------------

  _integrateState(dt, Fx, Fy, Mz, delta) {
    const m = CAR.mass;
    const L = CAR.wheelbase;

    const du = Fx / m - this.v * this.yawRate;
    const dv = Fy / m + this.u * this.yawRate;
    const dw = Mz / CAR.inertiaYaw;

    const vAbsU = Math.abs(this.u);
    const w = smoothstep(CAR.minSteerSpeed * 0.4, CAR.minSteerSpeed * 1.6, vAbsU);

    const uDyn = this.u + du * dt;
    const vDyn = this.v + dv * dt;
    const wDyn = this.yawRate + dw * dt;

    let omegaK = -(this.u * Math.tan(delta)) / L;
    omegaK = clamp(omegaK, -CAR.maxYawLowSpeed, CAR.maxYawLowSpeed);

    this.u = uDyn;
    this.v = lerp(0, vDyn, w);
    this.yawRate = lerp(omegaK, wDyn, w);
    this.heading += this.yawRate * dt;

    // World-frame velocity
    const nfX = Math.sin(this.heading);
    const nfZ = Math.cos(this.heading);
    const rgtX = -nfZ;
    const rgtZ = nfX;

    this.position.x += (nfX * this.u + rgtX * this.v) * dt;
    this.position.z += (nfZ * this.u + rgtZ * this.v) * dt;

    this.velocity.set(
      nfX * this.u + rgtX * this.v,
      0,
      nfZ * this.u + rgtZ * this.v
    );

    // Reverse gear limiter
    if (this.trans.gear === -1 && this.u < -CAR.maxReverseSpeed) {
      this.u = -CAR.maxReverseSpeed;
    }
  }

  // ------------------------------------------------------------------
  // Private: Frame Finalization
  // ------------------------------------------------------------------

  _finalizeFrame(dt, surf) {
    this.surfaceY = surf.y;
    this.roadPitch = Math.atan(surf.grade);
    this.roadRoll = Math.atan(surf.bank);
    this.lateral = surf.lateral;
    this.roadType = surf.roadType;

    this.position.y = damp(this.position.y, this.surfaceY, CFG.POSITION_DAMPING, dt);

    this.latAccel = damp(this.latAccel, this.u * this.yawRate, CFG.LAT_ACCEL_DAMPING, dt);
    this.aLongS = damp(this.aLongS, this.dbgFx / CAR.mass, CFG.LONG_ACCEL_DAMPING, dt);

    this.steerAngle = this._delta;
  }

  // ------------------------------------------------------------------
  // Private: Telemetry
  // ------------------------------------------------------------------

  _updateTelemetry(Fx, alphaF, alphaR) {
    const aLongInst = Fx / CAR.mass;
    const vAbsU = Math.abs(this.u);

    this.vF = this.u;
    this.vL = this.v;
    this.slipAngleFront = alphaF;
    this.slipAngleRear = alphaR;
    this.reversing = this.u < -0.5;
    this.gForceLat = (this.u * this.yawRate) / G;
    this.gForceLong = aLongInst / G;

    this.slip = Math.abs(this.v)
      + (this.wheelspin ? 2.8 : 0)
      + (this.rearLocked && vAbsU > 4 ? 3.0 : 0);
  }

  // ------------------------------------------------------------------
  // Private: Suspension
  // ------------------------------------------------------------------

  _updateSuspension(dt) {
    const { BASE, LONG_XFER, LAT_XFER, DAMPING, BUMP_SCALE } = CFG.SUSPENSION;
    const longF = clamp(this.aLongS / 10, -1, 1);
    const leanR = clamp((this.u * this.yawRate) / 10, -1, 1);

    let fl = BASE - longF * LONG_XFER - leanR * LAT_XFER;
    let fr = BASE - longF * LONG_XFER + leanR * LAT_XFER;
    let rl = BASE + longF * LONG_XFER - leanR * LAT_XFER;
    let rr = BASE + longF * LONG_XFER + leanR * LAT_XFER;

    // Per-wheel ground height sampling (independent suspension)
    const halfWB = CAR.wheelbase * 0.5;
    const halfTW = CAR.trackWidth * 0.5;
    const fwdX = Math.sin(this.heading);
    const fwdZ = Math.cos(this.heading);
    const rgtX = -fwdZ;
    const rgtZ = fwdX;

    let avgH = 0;
    for (let i = 0; i < 4; i++) {
      const off = WHEEL_OFFSETS[i];
      const wx = this.position.x + fwdX * off.fx * halfWB + rgtX * off.rx * halfTW;
      const wz = this.position.z + fwdZ * off.fx * halfWB + rgtZ * off.rx * halfTW;
      const h = this.world.groundAt(wx, wz).y;
      this.wheelGroundY[i] = h;
      avgH += h;
    }
    avgH *= 0.25;

    for (let i = 0; i < 4; i++) {
      const dev = this.wheelGroundY[i] - avgH;
      switch (i) {
        case 0: fl += dev * BUMP_SCALE; break;
        case 1: fr += dev * BUMP_SCALE; break;
        case 2: rl += dev * BUMP_SCALE; break;
        case 3: rr += dev * BUMP_SCALE; break;
      }
    }

    // Shoulder rumble strips
    if (this.onShoulder && Math.abs(this.vF) > 5) {
      this._bumpPhase += dt * CFG.SUSPENSION.SHOULDER_BUMP_FREQ;
      const bump = Math.sin(this._bumpPhase) * CFG.SUSPENSION.SHOULDER_BUMP_AMP;
      if (this.lateral > 0) {
        fr += bump;
        rr += bump;
      } else {
        fl += bump;
        rl += bump;
      }
    }

    // Grass / dirt jitter
    if ((this.onGrass || this.onDirt) && Math.abs(this.vF) > 4) {
      this._bumpPhase += dt * CFG.SUSPENSION.GRASS_JITTER_FREQ;
      const p = this._bumpPhase;
      const j = CFG.SUSPENSION.GRASS_JITTER_AMP *
        (Math.sin(p * CFG.SUSPENSION.GRASS_JITTER_H1) +
         Math.sin(p * CFG.SUSPENSION.GRASS_JITTER_H2));

      fl += j;
      fr -= j * CFG.SUSPENSION.GRASS_JITTER_ASYM_FR;
      rl -= j * CFG.SUSPENSION.GRASS_JITTER_ASYM_RL;
      rr += j;
    }

    this.susp[0] = clamp(fl, 0, 1);
    this.susp[1] = clamp(fr, 0, 1);
    this.susp[2] = clamp(rl, 0, 1);
    this.susp[3] = clamp(rr, 0, 1);

    for (let i = 0; i < 4; i++) {
      this._suspSmooth[i] = damp(this._suspSmooth[i], this.susp[i], DAMPING, dt);
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  destroy() {
    this.world = null;
    this.trans = null;
    this.position = null;
    this.velocity = null;
    this.susp = null;
    this._suspSmooth = null;
    this.wheelGroundY = null;
    this._wheelHeights = null;
    this._tmpVec = null;
  }
}
