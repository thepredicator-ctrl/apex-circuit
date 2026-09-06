/**
 * @fileoverview Vehicle Physics — Full 4-wheel dynamics with Pacejka MF5.2,
 * combined slip, wheel rotational inertia, open/LSD differential, load transfer,
 * spring-damper suspension, and aerodynamics.
 *
 * Surfaces are sampled per-wheel. Each tire produces longitudinal/lateral forces
 * that are summed at the CG and integrated.
 */

import * as THREE from 'three';
import { CAR, ROAD, ROAD_INFO } from '../core/Constants.js';

const { clamp, damp, lerp } = THREE.MathUtils;

// ============================================================================
// Math Utilities
// ============================================================================

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Full Pacejka Magic Formula 5.2.
 * y = D * sin(C * atan(B*x - E*(B*x - atan(B*x))))
 */
function pacejka(x, B, C, D, E, Sh = 0, Sv = 0) {
  const x1 = B * (x + Sh);
  return D * Math.sin(C * Math.atan(x1 - E * (x1 - Math.atan(x1)))) + Sv;
}

/**
 * Combined slip weighting function.
 * G = cos(C * atan(B * x))
 */
function combinedWeight(x, B, C) {
  return Math.cos(C * Math.atan(B * x));
}

// ============================================================================
// Physics Constants
// ============================================================================

const G = 9.81;
const EPS_V = 0.5;          // minimum speed for slip calculations
const EPS_KAPPA = 0.001;    // slip ratio epsilon

const TIRE = Object.freeze({
  RADIUS: 0.34,
  INERTIA: 1.15,
  ROLL_RESISTANCE: 0.014,
  RELAX_LENGTH: 0.08,

  FRONT: Object.freeze({
    B_LAT: 11.0, C_LAT: 1.85, D_LAT: 1.02, E_LAT: 0.97,
    B_LONG: 10.5, C_LONG: 1.68, D_LONG: 1.05, E_LONG: 0.97,
    COMB_B: 8.0, COMB_C: 1.6,
    SELF_ALIGN: 0.018,
  }),
  REAR: Object.freeze({
    B_LAT: 10.5, C_LAT: 1.85, D_LAT: 1.05, E_LAT: 0.97,
    B_LONG: 10.0, C_LONG: 1.68, D_LONG: 1.08, E_LONG: 0.97,
    COMB_B: 8.0, COMB_C: 1.6,
    SELF_ALIGN: 0.014,
  }),
});

const AERO = Object.freeze({
  RHO: 1.225,
  AREA: 2.15,
  CD: 0.32,
  CL: 0.30,
  FRONT_DIST: 0.45,
});

const SUSP = Object.freeze({
  RIDE_HEIGHT: 0.32,
  TRAVEL: 0.14,
  K_FRONT: 42000,
  K_REAR: 38000,
  C_BUMP: 2600,
  C_REBOUND: 3400,
  ROLL_FRONT: 0.56,
  ANTI_SQUAT: 0.10,
  ANTI_DIVE: 0.12,
  CG_HEIGHT: 0.55,
});

const DIFF = Object.freeze({
  TYPE: 'open',
  LOCK_RATIO: 0.35,
  PRELOAD: 40,
});

const BRAKE = Object.freeze({
  MAX_TORQUE: 3200,
  BIAS_FRONT: 0.62,
  ABS_THRESHOLD: 0.12,
  ABS_RELEASE: 0.08,
  FLUTTER_HZ: 18,
});

const STEER = Object.freeze({
  RACK_RATE: 4.5,
  FADE_EXP: 0.85,
  ACKERMANN: 0.18,
});

const SURFACE_MU = Object.freeze({
  ASPHALT: 1.0,
  SHOULDER: 0.84,
  DIRT: 0.68,
  GRASS: 0.42,
  WET_SCALE: 0.78,
});

const LOW_SPEED = Object.freeze({
  KINEMATIC_BLEND_LOW: 1.2,
  KINEMATIC_BLEND_HIGH: 4.8,
  STOP_THRESHOLD: 0.03,
  TIRE_DECAY: 0.92,
});

// ============================================================================
// Wheel Layout
// ============================================================================

const W = Object.freeze({ FL: 0, FR: 1, RL: 2, RR: 3 });
const FRONT_AXLE = [W.FL, W.FR];
const REAR_AXLE = [W.RL, W.RR];

/** @type {ReadonlyArray<{fx:number, rx:number, axle:'front'|'rear'}>} */
const WHEEL_GEOMETRY = Object.freeze([
  { fx: 1, rx: -1, axle: 'front' },
  { fx: 1, rx: 1, axle: 'front' },
  { fx: -1, rx: -1, axle: 'rear' },
  { fx: -1, rx: 1, axle: 'rear' },
]);

// ============================================================================
// JSDoc Types
// ============================================================================

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
 * @typedef {Object} InputBundle
 * @property {{throttle:number, brake:number, steer:number, handbrake:boolean}} state
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

    // ---- Chassis state ------------------------------------------------------
    this.position = new THREE.Vector3();
    this.heading = 0;
    this.pitch = 0;
    this.roll = 0;
    this.yawRate = 0;
    this.pitchRate = 0;
    this.rollRate = 0;

    // Body-frame velocities
    this.u = 0;
    this.v = 0;

    /** @type {THREE.Vector3} World-frame velocity */
    this.velocity = new THREE.Vector3();

    // ---- Steering -----------------------------------------------------------
    this._delta = 0;
    this._deltaL = 0;
    this._deltaR = 0;

    // ---- Wheel rotational state ---------------------------------------------
    /** @type {Float64Array} Angular velocity (rad/s) for each wheel */
    this.wheelOmega = new Float64Array(4);
    /** @type {Float64Array} Slip ratio per wheel */
    this.wheelSlipRatio = new Float64Array(4);
    /** @type {Float64Array} Slip angle (rad) per wheel */
    this.wheelSlipAngle = new Float64Array(4);
    /** @type {Float64Array} Longitudinal force (N) per wheel */
    this.wheelFx = new Float64Array(4);
    /** @type {Float64Array} Lateral force (N) per wheel */
    this.wheelFy = new Float64Array(4);
    /** @type {Float64Array} Normal load (N) per wheel */
    this.wheelFz = new Float64Array(4);
    /** @type {Float64Array} Self-aligning torque (Nm) per wheel */
    this.wheelMz = new Float64Array(4);
    /** @type {Float64Array} Brake torque (Nm) per wheel */
    this.wheelBrakeTq = new Float64Array(4);
    /** @type {Float64Array} Drive torque (Nm) per wheel */
    this.wheelDriveTq = new Float64Array(4);

    // ---- Suspension state ---------------------------------------------------
    /** @type {Float64Array} Suspension deflection (m, positive = compressed) */
    this.suspZ = new Float64Array(4);
    /** @type {Float64Array} Suspension velocity (m/s, positive = extending) */
    this.suspV = new Float64Array(4);
    /** @type {number[]} Visual suspension target (0..1) */
    this.susp = [0.5, 0.5, 0.5, 0.5];
    /** @type {number[]} Smoothed visual suspension */
    this._suspSmooth = [0.5, 0.5, 0.5, 0.5];
    this._bumpPhase = 0;

    // ---- Surface & telemetry ----------------------------------------------
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
    this.gripMul = 1.0;

    // Per-wheel ground heights for visuals
    /** @type {Float64Array} */
    this.wheelGroundY = new Float64Array(4);

    // ---- Telemetry ----------------------------------------------------------
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

    // ---- Transient ----------------------------------------------------------
    this.justHitWall = false;
    this.hitImpact = 0;
    this._time = 0;

    // ---- Pre-allocated temporaries -----------------------------------------
    this._wheelSurf = [null, null, null, null];
    this._tmpAx = 0;
    this._tmpAy = 0;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Place the car at a world pose.
   * @param {number} x
   * @param {number} z
   * @param {number} heading
   */
  placeAtWorld(x, z, heading) {
    if (!Number.isFinite(x)) throw new TypeError(`x must be finite, got ${x}`);
    if (!Number.isFinite(z)) throw new TypeError(`z must be finite, got ${z}`);
    if (!Number.isFinite(heading)) throw new TypeError(`heading must be finite, got ${heading}`);

    this.position.set(x, 0, z);
    this.heading = heading;
    this.pitch = 0;
    this.roll = 0;
    this.yawRate = 0;
    this.pitchRate = 0;
    this.rollRate = 0;
    this.u = 0;
    this.v = 0;
    this._delta = 0;
    this._deltaL = 0;
    this._deltaR = 0;

    this.wheelOmega.fill(0);
    this.wheelSlipRatio.fill(0);
    this.wheelSlipAngle.fill(0);
    this.wheelFx.fill(0);
    this.wheelFy.fill(0);
    this.wheelFz.fill(0);
    this.wheelMz.fill(0);
    this.wheelBrakeTq.fill(0);
    this.wheelDriveTq.fill(0);

    this.suspZ.fill(0);
    this.suspV.fill(0);
    this.susp.fill(0.5);
    this._suspSmooth.fill(0.5);

    this.velocity.set(0, 0, 0);
    this.vF = 0;
    this.vL = 0;
    this.latAccel = 0;
    this.aLongS = 0;

    const surf = this._sampleSurfaceAt(x, z);
    this.position.y = surf.y;
    this._resetSurfaceFlags();
  }

  /**
   * Main physics tick.
   * @param {number} dt
   * @param {InputBundle} input
   * @param {boolean} controlsActive
   */
  update(dt, input, controlsActive) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 0.1) {
      console.warn(`VehiclePhysics: clamping bad dt ${dt}`);
      dt = clamp(dt, 0.001, 0.1);
    }
    if (!input || !input.state) throw new TypeError('input.state is required');

    this.justHitWall = false;
    this._time += dt;

    // ---- Unpack inputs ------------------------------------------------------
    const throttle = controlsActive ? clamp(input.state.throttle, 0, 1) : 0;
    const driverBrake = controlsActive ? clamp(input.state.brake, 0, 1) : 0;
    const steerInput = controlsActive ? clamp(input.state.steer, -1, 1) : 0;
    const handbrake = controlsActive && !!input.state.handbrake;
    const holdStill = !controlsActive;

    this.throttleOut = throttle;
    this.brakeOut = driverBrake;

    // ---- Geometry shortcuts -------------------------------------------------
    const m = CAR.mass;
    const L = CAR.wheelbase;
    const a = CAR.aFront;
    const b = CAR.bRear;
    const halfTW = CAR.trackWidth / 2;
    const cgH = CAR.cgHeight || SUSP.CG_HEIGHT;

    // ---- Steering (with Ackermann) -----------------------------------------
    this._updateSteering(dt, steerInput);

    // ---- Per-wheel surface sampling -----------------------------------------
    this._sampleAllWheels();

    // ---- Transmission -------------------------------------------------------
    this.trans.update(dt, {
      wheelSpeed: this.u,
      throttle,
      brake: driverBrake,
      controlsActive,
    });

    // ---- Suspension & load transfer -----------------------------------------
    const axPrev = this.aLongS;
    const ayPrev = this.u * this.yawRate;

    this._computeWheelLoads(dt, m, L, a, b, halfTW, cgH, axPrev, ayPrev);

    // ---- Slip angles & ratios -----------------------------------------------
    this._computeSlip(dt, a, b, halfTW);

    // ---- Tire forces (Pacejka + combined slip) -----------------------------
    this._computeTireForces();

    // ---- Differential -------------------------------------------------------
    this._applyDifferential();

    // ---- Brakes -------------------------------------------------------------
    this._applyBrakes(dt, driverBrake, handbrake);

    // ---- Wheel rotational dynamics -------------------------------------------
    this._integrateWheels(dt);

    // ---- Aerodynamics -------------------------------------------------------
    const aero = this._computeAerodynamics();

    // ---- Sum forces at CG ---------------------------------------------------
    const forces = this._sumForcesAtCG(a, b, halfTW, aero);

    // ---- Chassis integration -------------------------------------------------
    this._integrateChassis(dt, forces.Fx, forces.Fy, forces.Mz, forces.Mx, forces.My);

    // ---- Post-movement surface & damping ------------------------------------
    this._finalizeFrame(dt);

    // ---- Visual suspension --------------------------------------------------
    this._updateSuspensionVisuals(dt, a, b, halfTW);

    // ---- Telemetry ----------------------------------------------------------
    this._updateTelemetry(forces.Fx);

    // ---- Low-speed decay ----------------------------------------------------
    if (Math.abs(this.u) < 0.15) {
      for (let i = 0; i < 4; i++) {
        this.wheelOmega[i] *= LOW_SPEED.TIRE_DECAY;
      }
    }
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

  get roadLabel() {
    return ROAD_INFO[this.roadType]?.label ?? 'OFF-ROAD';
  }

  // ------------------------------------------------------------------
  // Private: Surface
  // ------------------------------------------------------------------

  _resetSurfaceFlags() {
    this.onGrass = false;
    this.onShoulder = false;
    this.onCurb = false;
    this.onDirt = false;
    this.onRoad = true;
    this.roadType = ROAD.HIGHWAY;
  }

  _sampleSurfaceAt(x, z) {
    const fwdX = Math.sin(this.heading);
    const fwdZ = Math.cos(this.heading);
    return this.world.surfaceAt(x, z, fwdX, fwdZ);
  }

  /**
   * Sample ground height and surface at each wheel position.
   */
  _sampleAllWheels() {
    const halfWB = CAR.wheelbase / 2;
    const halfTW = CAR.trackWidth / 2;
    const fwdX = Math.sin(this.heading);
    const fwdZ = Math.cos(this.heading);
    const rgtX = -fwdZ;
    const rgtZ = fwdX;

    for (let i = 0; i < 4; i++) {
      const g = WHEEL_GEOMETRY[i];
      const wx = this.position.x + fwdX * g.fx * halfWB + rgtX * g.rx * halfTW;
      const wz = this.position.z + fwdZ * g.fx * halfWB + rgtZ * g.rx * halfTW;

      const gh = this.world.groundAt(wx, wz);
      this.wheelGroundY[i] = gh.y;

      if (i === 0) {
        const surf = this.world.surfaceAt(wx, wz, fwdX, fwdZ);
        this._wheelSurf[i] = surf;
        this._updateTelemetrySurface(surf);
      } else {
        this._wheelSurf[i] = this._wheelSurf[0];
      }
    }
  }

  _updateTelemetrySurface(surf) {
    this.surfaceY = surf.y;
    this.roadPitch = Math.atan(surf.grade);
    this.roadRoll = Math.atan(surf.bank);
    this.lateral = surf.lateral;
    this.roadType = surf.roadType;
    this.onRoad = surf.onRoad;
    this.onShoulder = !surf.onRoad && surf.shoulder;
    this.onCurb = false;
    this.onDirt = surf.roadType === ROAD.DIRT;
    this.onGrass = !surf.onRoad && !surf.shoulder && !surf.bridge;
  }

  // ------------------------------------------------------------------
  // Private: Steering
  // ------------------------------------------------------------------

  _updateSteering(dt, steerInput) {
    const vAbsU = Math.abs(this.u);
    const fadeT = Math.pow(clamp(vAbsU / CAR.steerFadeSpeed, 0, 1), STEER.FADE_EXP);
    const maxSteer = CAR.maxSteerRoad * lerp(1, CAR.steerFastFrac, fadeT);
    const targetDelta = steerInput * maxSteer;

    const rackRate = STEER.RACK_RATE * maxSteer;
    const dDelta = clamp(targetDelta - this._delta, -rackRate * dt, rackRate * dt);
    this._delta += dDelta;

    // Ackermann geometry
    if (this._delta > 0.001) {
      this._deltaL = this._delta + STEER.ACKERMANN * (this._delta / maxSteer);
      this._deltaR = this._delta;
    } else if (this._delta < -0.001) {
      this._deltaL = this._delta;
      this._deltaR = this._delta - STEER.ACKERMANN * (this._delta / maxSteer);
    } else {
      this._deltaL = this._delta;
      this._deltaR = this._delta;
    }

    this.steerAngle = this._delta;
  }

  // ------------------------------------------------------------------
  // Private: Loads & Suspension
  // ------------------------------------------------------------------

  _computeWheelLoads(dt, m, L, a, b, halfTW, cgH, axPrev, ayPrev) {
    const staticF = m * G * b / L;
    const staticR = m * G * a / L;

    const vSq = this.u * this.u;
    const FzAero = 0.5 * AERO.RHO * AERO.CL * AERO.AREA * vSq;
    const FzAeroF = FzAero * AERO.FRONT_DIST;
    const FzAeroR = FzAero * (1 - AERO.FRONT_DIST);

    const ax = this.aLongS || 0;
    const dFzLong = m * ax * cgH / L;
    const dFzLongF = -dFzLong * (1 - SUSP.ANTI_DIVE);
    const dFzLongR = dFzLong * (1 - SUSP.ANTI_SQUAT);

    const ay = ayPrev || 0;
    const dFzLatTotal = Math.abs(ay) * m * cgH / (2 * halfTW);
    const dFzLatF = dFzLatTotal * SUSP.ROLL_FRONT;
    const dFzLatR = dFzLatTotal * (1 - SUSP.ROLL_FRONT);
    const latDir = Math.sign(ay) || 1;

    const targets = new Float64Array(4);
    targets[W.FL] = staticF / 2 + FzAeroF / 2 + dFzLongF / 2 - dFzLatF / 2 * latDir;
    targets[W.FR] = staticF / 2 + FzAeroF / 2 + dFzLongF / 2 + dFzLatF / 2 * latDir;
    targets[W.RL] = staticR / 2 + FzAeroR / 2 + dFzLongR / 2 - dFzLatR / 2 * latDir;
    targets[W.RR] = staticR / 2 + FzAeroR / 2 + dFzLongR / 2 + dFzLatR / 2 * latDir;

    for (let i = 0; i < 4; i++) {
      targets[i] = clamp(targets[i], m * G * 0.02, m * G * 0.8);
    }

    const kFront = SUSP.K_FRONT;
    const kRear = SUSP.K_REAR;
    const cBump = SUSP.C_BUMP;
    const cRebound = SUSP.C_REBOUND;

    for (let i = 0; i < 4; i++) {
      const isFront = i < 2;
      const k = isFront ? kFront : kRear;
      const staticLoad = isFront ? staticF / 2 : staticR / 2;

      const deflection = this.suspZ[i];
      const springForce = k * deflection;

      const vel = this.suspV[i];
      const c = vel > 0 ? cRebound : cBump;
      const damperForce = c * vel;

      const Fz = staticLoad + springForce + damperForce;

      const targetDeflection = (targets[i] - staticLoad) / k;
      const accel = (targetDeflection - deflection) * k / staticLoad;
      this.suspV[i] += accel * dt;
      this.suspV[i] *= 0.98; // numerical damping
      this.suspZ[i] += this.suspV[i] * dt;

      this.wheelFz[i] = Fz;
    }
  }

  // ------------------------------------------------------------------
  // Private: Slip
  // ------------------------------------------------------------------

  _computeSlip(dt, a, b, halfTW) {
    const vAbsU = Math.abs(this.u);
    const ux = Math.max(vAbsU, EPS_V);

    const cosH = Math.cos(this.heading);
    const sinH = Math.sin(this.heading);

    for (let i = 0; i < 4; i++) {
      const g = WHEEL_GEOMETRY[i];
      const isFront = g.axle === 'front';
      const delta = isFront ? (g.rx < 0 ? this._deltaL : this._deltaR) : 0;

      // Wheel position relative to CG
      const wx = g.fx * (isFront ? a : -b);
      const wy = g.rx * halfTW;

      // Velocity at wheel contact patch (body frame)
      const vx = this.u - this.yawRate * wy;
      const vy = this.v + this.yawRate * wx;

      // Rotate by steer angle for front wheels
      const vxT = vx * Math.cos(delta) + vy * Math.sin(delta);
      const vyT = -vx * Math.sin(delta) + vy * Math.cos(delta);

      // Slip ratio: (omega*R - Vx) / max(|Vx|, eps)
      const vWheel = this.wheelOmega[i] * TIRE.RADIUS;
      const denom = Math.max(Math.abs(vxT), EPS_V);
      this.wheelSlipRatio[i] = (vWheel - vxT) / denom;

      // Slip angle: atan2(Vy, |Vx|)
      this.wheelSlipAngle[i] = Math.atan2(vyT, Math.abs(vxT));

      // Relaxation length lag on slip angle (first-order filter)
      const relaxK = clamp(vAbsU * dt / TIRE.RELAX_LENGTH, 0, 1);
      this.wheelSlipAngle[i] = lerp(this.wheelSlipAngle[i], Math.atan2(vyT, Math.abs(vxT)), relaxK);
    }

    this.slipAngleFront = (this.wheelSlipAngle[W.FL] + this.wheelSlipAngle[W.FR]) * 0.5;
    this.slipAngleRear = (this.wheelSlipAngle[W.RL] + this.wheelSlipAngle[W.RR]) * 0.5;
  }

  // ------------------------------------------------------------------
  // Private: Tire Forces
  // ------------------------------------------------------------------

  _computeTireForces() {
    for (let i = 0; i < 4; i++) {
      const isFront = i < 2;
      const tire = isFront ? TIRE.FRONT : TIRE.REAR;

      const muScale = this._getSurfaceMu(i);
      const Fz = this.wheelFz[i];
      const kappa = this.wheelSlipRatio[i];
      const alpha = this.wheelSlipAngle[i];

      // Pure longitudinal
      const Fx0 = muScale * Fz * pacejka(kappa, tire.B_LONG, tire.C_LONG, tire.D_LONG, tire.E_LONG);

      // Pure lateral
      const Fy0 = muScale * Fz * pacejka(alpha, tire.B_LAT, tire.C_LAT, tire.D_LAT, tire.E_LAT);

      // Combined slip weighting
      const Gx = combinedWeight(kappa, tire.COMB_B, tire.COMB_C);
      const Gy = combinedWeight(alpha, tire.COMB_B, tire.COMB_C);

      const Fx = Fx0 * Gy;
      const Fy = Fy0 * Gx;

      this.wheelFx[i] = Fx;
      this.wheelFy[i] = Fy;

      // Self-aligning torque (simplified pneumatic trail)
      const trail = tire.SELF_ALIGN * Math.exp(-0.5 * alpha * alpha);
      this.wheelMz[i] = -Fy * trail;
    }
  }

  _getSurfaceMu(wheelIndex) {
    let baseMu;
    if (this.onGrass) baseMu = SURFACE_MU.GRASS;
    else if (this.onDirt) baseMu = SURFACE_MU.DIRT;
    else if (this.onShoulder) baseMu = SURFACE_MU.SHOULDER;
    else baseMu = SURFACE_MU.ASPHALT;

    return baseMu * this.gripMul;
  }

  // ------------------------------------------------------------------
  // Private: Differential
  // ------------------------------------------------------------------

  _applyDifferential() {
    const driveTq = this.trans.driveForce * TIRE.RADIUS;
    if (Math.abs(driveTq) < 1) {
      this.wheelDriveTq.fill(0);
      return;
    }

    if (DIFF.TYPE === 'open') {
      // Equal torque split
      const tq = driveTq * 0.5;
      this.wheelDriveTq[W.RL] = tq;
      this.wheelDriveTq[W.RR] = tq;
    } else {
      // Limited slip: torque bias to slower wheel
      const wL = this.wheelOmega[W.RL];
      const wR = this.wheelOmega[W.RR];
      const dw = wL - wR;
      const bias = clamp(dw * DIFF.LOCK_RATIO, -0.5, 0.5);
      const tqBase = driveTq * 0.5;
      this.wheelDriveTq[W.RL] = tqBase * (1 + bias) + Math.sign(dw) * DIFF.PRELOAD;
      this.wheelDriveTq[W.RR] = tqBase * (1 - bias) - Math.sign(dw) * DIFF.PRELOAD;
    }

    this.wheelDriveTq[W.FL] = 0;
    this.wheelDriveTq[W.FR] = 0;
  }

  // ------------------------------------------------------------------
  // Private: Brakes
  // ------------------------------------------------------------------

  _applyBrakes(dt, driverBrake, handbrake) {
    const vAbsU = Math.abs(this.u);
    const braking = driverBrake > 0 && vAbsU > 0.35;
    this.absActive = false;
    this.rearLocked = handbrake;

    if (handbrake) {
      // Handbrake locks rear axle
      const muSlide = this._getSurfaceMu(W.RL) * 0.62;
      for (const i of REAR_AXLE) {
        this.wheelBrakeTq[i] = muSlide * this.wheelFz[i] * TIRE.RADIUS * 2.0;
      }
      this.wheelBrakeTq[W.FL] = 0;
      this.wheelBrakeTq[W.FR] = 0;
      return;
    }

    if (!braking) {
      this.wheelBrakeTq.fill(0);
      return;
    }

    const demand = BRAKE.MAX_TORQUE * driverBrake;
    const dir = Math.sign(this.u) || 1;

    for (let i = 0; i < 4; i++) {
      const isFront = i < 2;
      const bias = isFront ? BRAKE.BIAS_FRONT : (1 - BRAKE.BIAS_FRONT);
      const tq = demand * bias;

      // ABS
      const slip = Math.abs(this.wheelSlipRatio[i]);
      const mu = this._getSurfaceMu(i);
      const peakSlip = 0.12;
      const maxTq = mu * this.wheelFz[i] * TIRE.RADIUS;

      let applied = Math.min(tq, maxTq);

      if (slip > BRAKE.ABS_THRESHOLD) {
        const flutter = 0.94 + 0.06 * Math.sin(this._time * BRAKE.FLUTTER_HZ * Math.PI * 2);
        applied = maxTq * flutter * 0.85;
        this.absActive = true;
      }

      this.wheelBrakeTq[i] = -dir * applied;
    }
  }

  // ------------------------------------------------------------------
  // Private: Wheel Integration
  // ------------------------------------------------------------------

  _integrateWheels(dt) {
    for (let i = 0; i < 4; i++) {
      const netTq = this.wheelDriveTq[i] + this.wheelBrakeTq[i] - this.wheelFx[i] * TIRE.RADIUS;
      const alpha = netTq / TIRE.INERTIA;
      this.wheelOmega[i] += alpha * dt;

      // Rolling resistance
      const rollTq = -TIRE.ROLL_RESISTANCE * this.wheelFz[i] * TIRE.RADIUS * Math.sign(this.wheelOmega[i]);
      this.wheelOmega[i] += rollTq / TIRE.INERTIA * dt;

      // Wheelspin detection
      const vWheel = Math.abs(this.wheelOmega[i] * TIRE.RADIUS);
      const vChassis = Math.abs(this.u);
      if (i >= 2 && vWheel > vChassis * 1.3 && this.wheelDriveTq[i] > 100) {
        this.wheelspin = true;
      }
    }
  }

  // ------------------------------------------------------------------
  // Private: Aerodynamics
  // ------------------------------------------------------------------

  _computeAerodynamics() {
    const vSq = this.u * this.u;
    const drag = 0.5 * AERO.RHO * AERO.CD * AERO.AREA * vSq * Math.sign(-this.u);
    const downforce = 0.5 * AERO.RHO * AERO.CL * AERO.AREA * vSq;

    return { drag, downforce };
  }

  // ------------------------------------------------------------------
  // Private: Force Summation
  // ------------------------------------------------------------------

  _sumForcesAtCG(a, b, halfTW, aero) {
    let Fx = 0;
    let Fy = 0;
    let Mz = 0;
    let Mx = 0;
    let My = 0;

    // Add aero drag
    Fx += aero.drag;

    // Gravity component from road slope
    const m = CAR.mass;
    Fx += -m * G * Math.sin(this.roadPitch);
    Fy += -m * G * Math.sin(this.roadRoll) * 0.85;

    for (let i = 0; i < 4; i++) {
      const g = WHEEL_GEOMETRY[i];
      const isFront = g.axle === 'front';
      const delta = isFront ? (g.rx < 0 ? this._deltaL : this._deltaR) : 0;

      // Transform tire forces to body frame
      const fx = this.wheelFx[i] * Math.cos(delta) - this.wheelFy[i] * Math.sin(delta);
      const fy = this.wheelFx[i] * Math.sin(delta) + this.wheelFy[i] * Math.cos(delta);

      Fx += fx;
      Fy += fy;

      // Moment arms
      const wx = g.fx * (isFront ? a : -b);
      const wy = g.rx * halfTW;

      Mz += wx * fy - wy * fx;
      Mz += this.wheelMz[i]; // self-aligning torque

      // Pitch/roll moments from suspension
      My += wx * this.wheelFz[i] * 0.01;
      Mx += wy * this.wheelFz[i] * 0.01;
    }

    return { Fx, Fy, Mz, Mx, My };
  }

  // ------------------------------------------------------------------
  // Private: Chassis Integration
  // ------------------------------------------------------------------

  _integrateChassis(dt, Fx, Fy, Mz, Mx, My) {
    const m = CAR.mass;
    const L = CAR.wheelbase;

    // Dynamic equations
    const du = Fx / m - this.v * this.yawRate;
    const dv = Fy / m + this.u * this.yawRate;
    const dw = Mz / CAR.inertiaYaw;

    const dp = Mx / (CAR.inertiaPitch || m * 0.25);
    const dr = My / (CAR.inertiaRoll || m * 0.12);

    const vAbsU = Math.abs(this.u);

    // Low-speed kinematic blend
    const wBlend = smoothstep(LOW_SPEED.KINEMATIC_BLEND_LOW, LOW_SPEED.KINEMATIC_BLEND_HIGH, vAbsU);

    const uDyn = this.u + du * dt;
    const vDyn = this.v + dv * dt;
    const wDyn = this.yawRate + dw * dt;

    let omegaK = -(this.u * Math.tan(this._delta)) / L;
    omegaK = clamp(omegaK, -CAR.maxYawLowSpeed, CAR.maxYawLowSpeed);

    this.u = uDyn;
    this.v = lerp(0, vDyn, wBlend);
    this.yawRate = lerp(omegaK, wDyn, wBlend);

    this.pitchRate += dp * dt;
    this.rollRate += dr * dt;
    this.pitchRate *= 0.95;
    this.rollRate *= 0.95;

    this.pitch += this.pitchRate * dt;
    this.roll += this.rollRate * dt;
    this.pitch = clamp(this.pitch, -0.18, 0.18);
    this.roll = clamp(this.roll, -0.22, 0.22);

    this.heading += this.yawRate * dt;

    // World-frame integration
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

    // Reverse limiter
    if (this.trans.gear === -1 && this.u < -CAR.maxReverseSpeed) {
      this.u = -CAR.maxReverseSpeed;
    }

    // Auto-stop
    if (vAbsU < LOW_SPEED.STOP_THRESHOLD && this.throttleOut === 0 && this.brakeOut === 0) {
      this.u = 0;
      this.v = 0;
      this.yawRate = 0;
    }
  }

  // ------------------------------------------------------------------
  // Private: Frame Finalization
  // ------------------------------------------------------------------

  _finalizeFrame(dt) {
    const surf = this._sampleSurfaceAt(this.position.x, this.position.z);
    this.surfaceY = surf.y;
    this.roadPitch = Math.atan(surf.grade);
    this.roadRoll = Math.atan(surf.bank);
    this.lateral = surf.lateral;
    this.roadType = surf.roadType;

    this.position.y = damp(this.position.y, this.surfaceY, 14, dt);

    this.latAccel = damp(this.latAccel, this.u * this.yawRate, 8, dt);
    this.aLongS = damp(this.aLongS, this._tmpAx || 0, 7, dt);
  }

  // ------------------------------------------------------------------
  // Private: Visual Suspension
  // ------------------------------------------------------------------

  _updateSuspensionVisuals(dt, a, b, halfTW) {
    const BASE = 0.5;
    const LONG_XFER = 0.38;
    const LAT_XFER = 0.36;
    const DAMPING = 10;
    const BUMP_SCALE = 3.2;

    const longF = clamp(this.aLongS / 10, -1, 1);
    const leanR = clamp((this.u * this.yawRate) / 10, -1, 1);

    let fl = BASE - longF * LONG_XFER - leanR * LAT_XFER;
    let fr = BASE - longF * LONG_XFER + leanR * LAT_XFER;
    let rl = BASE + longF * LONG_XFER - leanR * LAT_XFER;
    let rr = BASE + longF * LONG_XFER + leanR * LAT_XFER;

    const avgH = (this.wheelGroundY[0] + this.wheelGroundY[1] + this.wheelGroundY[2] + this.wheelGroundY[3]) / 4;
    fl += (this.wheelGroundY[0] - avgH) * BUMP_SCALE;
    fr += (this.wheelGroundY[1] - avgH) * BUMP_SCALE;
    rl += (this.wheelGroundY[2] - avgH) * BUMP_SCALE;
    rr += (this.wheelGroundY[3] - avgH) * BUMP_SCALE;

    if (this.onShoulder && Math.abs(this.vF) > 5) {
      this._bumpPhase += dt * 38;
      const bump = Math.sin(this._bumpPhase) * 0.35;
      if (this.lateral > 0) { fr += bump; rr += bump; }
      else { fl += bump; rl += bump; }
    }

    if ((this.onGrass || this.onDirt) && Math.abs(this.vF) > 4) {
      this._bumpPhase += dt * 15;
      const j = (Math.sin(this._bumpPhase * 3.1) + Math.sin(this._bumpPhase * 5.7)) * 0.16;
      fl += j; fr -= j * 0.8; rl -= j * 0.7; rr += j;
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
  // Private: Telemetry
  // ------------------------------------------------------------------

  _updateTelemetry(Fx) {
    const aLongInst = Fx / CAR.mass;
    const vAbsU = Math.abs(this.u);

    this.vF = this.u;
    this.vL = this.v;
    this.slipAngleFront = this.wheelSlipAngle[W.FL];
    this.slipAngleRear = this.wheelSlipAngle[W.RL];
    this.reversing = this.u < -0.5;
    this.gForceLat = (this.u * this.yawRate) / G;
    this.gForceLong = aLongInst / G;

    this.slip = Math.abs(this.v)
      + (this.wheelspin ? 2.8 : 0)
      + (this.rearLocked && vAbsU > 4 ? 3.0 : 0);

    this._tmpAx = aLongInst;
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
    this.wheelOmega = null;
    this.wheelSlipRatio = null;
    this.wheelSlipAngle = null;
    this.wheelFx = null;
    this.wheelFy = null;
    this.wheelFz = null;
    this.wheelMz = null;
    this.wheelBrakeTq = null;
    this.wheelDriveTq = null;
    this.suspZ = null;
    this.suspV = null;
    this._wheelSurf = null;
  }
}
