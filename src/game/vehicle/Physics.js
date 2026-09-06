/**
 * Vehicle physics — a DYNAMIC bicycle model with real tire behavior,
 * adapted to the open-world surface API.
 *
 * The car is a rigid body in the horizontal plane whose motion EMERGES from
 * tire forces:
 *   - per-axle slip angles + Pacejka-style magic formula with post-peak
 *     falloff (slides are progressive and catchable)
 *   - friction ellipse couples longitudinal/lateral grip (power oversteer,
 *     trail braking, handbrake entries all emerge)
 *   - longitudinal + lateral load transfer, aero downforce, load-sensitive mu
 *   - ABS pumps each axle just below the friction peak: full-stomp stops are
 *     SHORT and fully steerable (this is what fixed the old brakes)
 *   - handbrake locks the rear axle: kinetic sliding friction, classic drifts
 *   - tire force relaxation length, rack-rate-limited steering
 *   - low-speed kinematic blend for parking / reverse
 *
 * Surfaces come from the World facade: asphalt roads (by type), dirt
 * tracks, gravel shoulders, grass, and any terrain — grip differs by
 * surface, and Weather.js applies a global wet-road multiplier.
 */

import * as THREE from 'three';
import { CAR, ROAD, ROAD_INFO } from '../core/Constants.js';

const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;
const lerp = THREE.MathUtils.lerp;

const G = 9.81;

export class VehiclePhysics {
  constructor(world, transmission) {
    this.track = world;          // legacy name kept for camera rig compat
    this.world = world;
    this.trans = transmission;

    // ---- state -----------------------------------------------------------
    this.position = new THREE.Vector3();
    this.heading = 0;             // rad, 0 = +Z
    this.yawRate = 0;             // rad/s (body yaw)
    this.u = 0;                   // forward velocity, body frame (m/s)
    this.v = 0;                   // lateral velocity, body frame (+ = sliding right)

    // axle tire force states (relaxation lag)
    this._fyF = 0;
    this._fyR = 0;
    this._delta = 0;              // current front-wheel angle (rack state)

    this.velocity = new THREE.Vector3();

    // ---- telemetry ---------------------------------------------------------
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
    this.gripMul = 1.0;           // global weather multiplier (set by Game)

    // per-wheel suspension compression targets (0..1), FL FR RL RR
    this.susp = [0.5, 0.5, 0.5, 0.5];
    this._suspSmooth = [0.5, 0.5, 0.5, 0.5];
    this._bumpPhase = 0;
    // per-wheel world ground heights (FL FR RL RR) — consumed by Car visuals
    // so each wheel can stay planted on its own patch of terrain
    this.wheelGroundY = [0, 0, 0, 0];

    this.justHitWall = false;
    this.hitImpact = 0;
    this._time = 0;
  }

  // ------------------------------------------------------------------
  /** Place the car at a world pose (used by spawn / reset). */
  placeAtWorld(x, z, heading) {
    this.position.set(x, 0, z);
    this.heading = heading;
    this.u = 0; this.v = 0;
    this.yawRate = 0;
    this._delta = 0;
    this._fyF = 0; this._fyR = 0;
    this.velocity.set(0, 0, 0);
    this.vF = 0; this.vL = 0;
    this.latAccel = 0;
    this.aLongS = 0;
    this._applySurfaceAt(x, z);
    this.position.y = this.surfaceY;
    this._resetSurfaceFlags();
    this.susp = [0.5, 0.5, 0.5, 0.5];
    this._suspSmooth = [0.5, 0.5, 0.5, 0.5];
  }

  _resetSurfaceFlags() {
    this.onGrass = false;
    this.onShoulder = false;
    this.onCurb = false;
    this.onDirt = false;
    this.onRoad = true;
    this.roadType = ROAD.HIGHWAY;
  }

  /** project world slopes into the car frame */
  _applySurfaceAt(x, z) {
    const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
    const surf = this.world.surfaceAt(x, z, fwdX, fwdZ);
    this.surfaceY = surf.y;
    const along = 1;   // slopes sampled along the car's own axes already
    this.roadPitch = Math.atan(surf.grade) * along;
    this.roadRoll = Math.atan(surf.bank);
    return surf;
  }

  // ------------------------------------------------------------------
  update(dt, input, controlsActive) {
    this.justHitWall = false;
    this._time += dt;

    const throttle = controlsActive ? input.state.throttle : 0;
    const driverBrake = controlsActive ? input.state.brake : 0;
    const holdStill = !controlsActive;
    const steerInput = controlsActive ? input.state.steer : 0;
    const handbrake = controlsActive && input.state.handbrake;
    this.throttleOut = throttle;
    this.brakeOut = driverBrake;

    const m = CAR.mass;
    const L = CAR.wheelbase;
    const a = CAR.aFront;
    const b = CAR.bRear;

    // ---- steering ----------------------------------------------------------
    const vAbsU = Math.abs(this.u);
    const fadeT = Math.pow(clamp(vAbsU / CAR.steerFadeSpeed, 0, 1), 0.85);
    const maxSteer = CAR.maxSteerRoad * lerp(1, CAR.steerFastFrac, fadeT);
    const targetDelta = steerInput * maxSteer;
    const rackRate = 4.2 * maxSteer;   // full lock in ~0.24 s
    const dDelta = clamp(targetDelta - this._delta, -rackRate * dt, rackRate * dt);
    this._delta += dDelta;
    const delta = this._delta;

    // ---- surface lookup -----------------------------------------------------
    const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
    const surf = this.world.surfaceAt(this.position.x, this.position.z, fwdX, fwdZ);
    this.surfaceY = surf.y;
    this.roadPitch = Math.atan(surf.grade);
    this.roadRoll = Math.atan(surf.bank);
    this.lateral = surf.lateral;
    this.roadType = surf.roadType;

    const absLat = Math.abs(surf.lateral);
    this.onRoad = surf.onRoad;
    this.onShoulder = !surf.onRoad && surf.shoulder;
    this.onCurb = this.onShoulder;
    this.onDirt = surf.roadType === ROAD.DIRT;
    this.onGrass = !surf.onRoad && !surf.shoulder && !surf.bridge;

    // surface grip multipliers
    let surfMu = 1.0;
    if (this.onShoulder) surfMu = 0.86;
    if (this.onDirt) surfMu = 0.72;
    if (this.onGrass) surfMu = 0.0;      // replaced by grass mu below

    // ---- transmission ----------------------------------------------------------
    this.trans.update(dt, {
      wheelSpeed: this.u,
      throttle,
      brake: driverBrake,
      controlsActive
    });

    // ---- axle loads ----------------------------------------------------------
    const df = CAR.downforce * this.u * this.u;
    const staticF = m * G * b / L;
    const staticR = m * G * a / L;
    const longXfer = m * this.aLongS * CAR.cgHeight / L;
    const FzF = Math.max(m * G * 0.06, staticF - longXfer + df * CAR.downforceFront);
    const FzR = Math.max(m * G * 0.06, staticR + longXfer + df * (1 - CAR.downforceFront));

    // ---- tire parameters --------------------------------------------------------
    const muBase = (this.onGrass ? CAR.muGrass : CAR.muAsphalt * (surfMu || 1)) * this.gripMul;
    let muF = muBase, muR = muBase;
    this.rearLocked = handbrake;
    const loadSens = (mu, Fz, Fz0) =>
      mu * clamp(1 - CAR.loadSens * (Fz - Fz0) / Fz0, 0.8, 1.15);
    const muFeff = loadSens(muF, FzF, staticF);
    const muReff = loadSens(muR, FzR, staticR);

    // ---- slip angles -------------------------------------------------------------
    const ux = Math.max(vAbsU, 1.1);
    const sgn = this.u < -0.2 ? -1 : 1;
    const alphaF = Math.atan2(this.v - this.yawRate * a, ux) - delta * sgn;
    const alphaR = Math.atan2(this.v + this.yawRate * b, ux);

    // ---- raw lateral forces (Pacejka-style + post-peak falloff) ----------------
    const pacejka = (alpha, B, C) => Math.sin(C * Math.atan(B * alpha));
    const peakF = Math.tan(Math.PI / (2 * CAR.tireCFront)) / CAR.tireBFront;
    const peakR = Math.tan(Math.PI / (2 * CAR.tireCRear)) / CAR.tireBRear;
    const fallF = 1 - CAR.slipFalloff * smoothstep2(peakF, peakF * 3, Math.abs(alphaF));
    const fallR = 1 - CAR.slipFalloff * smoothstep2(peakR, peakR * 3, Math.abs(alphaR));
    let fyFTarget = -muFeff * FzF * pacejka(alphaF, CAR.tireBFront, CAR.tireCFront) * fallF;
    let fyRTarget = -muReff * FzR * pacejka(alphaR, CAR.tireBRear, CAR.tireCRear) * fallR;

    // tire force build-up: relaxation length
    const relaxK = clamp(vAbsU * dt / CAR.relaxLength, 0, 1);
    this._fyF += (fyFTarget - this._fyF) * relaxK;
    this._fyR += (fyRTarget - this._fyR) * relaxK;

    // ---- longitudinal forces -------------------------------------------------------
    let driveF = this.trans.driveForce;
    const muLong = muBase * CAR.muLongScale;
    const FmaxR = muLong * FzR;
    this.wheelspin = false;
    if (handbrake) driveF = 0;
    if (driveF > FmaxR) {
      driveF = FmaxR * (0.95 + 0.05 * Math.sin(this._time * 30));
      this.wheelspin = true;
      this.trans.wheelspin = true;
    } else if (driveF < -FmaxR * 0.92) {
      driveF = -FmaxR * 0.92;
      this.wheelspin = true;
      this.trans.wheelspin = true;
    }
    this.engineForce = driveF;

    // brakes — split by bias, ABS-modulated per axle
    const braking = driverBrake > 0 && vAbsU > 0.35;
    const reverseDrive = this.trans.mode === 'auto' && this.trans.gear === -1;
    let FxF = 0;
    let FxR = driveF;
    this.absActive = false;
    if (braking && !(reverseDrive && this.u < 0.35)) {
      const demand = CAR.brakeMaxDecel * m * driverBrake;
      const dir = Math.sign(this.u) || 1;
      let frontBrake = demand * CAR.brakeBiasFront;
      let rearBrake = demand * (1 - CAR.brakeBiasFront);
      const flutter =
        0.965 + 0.035 * Math.sin(this._time * CAR.absFlutterHz * Math.PI * 2);
      const absF = muFeff * FzF * CAR.absPeakFrac;
      const absR = muReff * FzR * CAR.absPeakFrac;
      if (frontBrake > absF) { frontBrake = absF * flutter; this.absActive = true; }
      if (rearBrake > absR) { rearBrake = absR * flutter; this.absActive = true; }
      FxF = -dir * frontBrake;
      FxR += -dir * rearBrake;
    }
    // handbrake: rear axle LOCKS — kinetic sliding friction
    let rearSliding = false;
    let fyRSlide = 0;
    if (handbrake) {
      const vRx = this.u;
      const vRy = this.v + this.yawRate * b;
      const vRs = Math.hypot(vRx, vRy);
      rearSliding = true;
      if (vRs > 0.4) {
        const muSlide = muBase * 0.62;
        FxR = -muSlide * FzR * (vRx / vRs);
        fyRSlide = -muSlide * FzR * (vRy / vRs);
      } else {
        FxR = 0;
        fyRSlide = 0;
      }
    }
    if (holdStill) FxR += -Math.sign(this.u || 1) * Math.min(2000, Math.abs(this.u) * m);

    // ---- friction ellipse (combined slip) ------------------------------------------
    const FmaxF = muLong * FzF;
    if (Math.abs(FxR) > FmaxR) FxR = Math.sign(FxR) * FmaxR;
    if (Math.abs(FxF) > FmaxF) FxF = Math.sign(FxF) * FmaxF;
    const capF = Math.sqrt(Math.max(0, Math.pow(muFeff * FzF, 2) - Math.pow(FxF * 0.94, 2)));
    const capR = Math.sqrt(Math.max(0, Math.pow(muReff * FzR, 2) - Math.pow(FxR * 0.94, 2)));
    const fyF = clamp(this._fyF, -capF, capF);
    const fyR = rearSliding ? fyRSlide : clamp(this._fyR, -capR, capR);
    if (!rearSliding && Math.abs(this._fyR) > capR && driveF > 0) {
      this.wheelspin = true;
      this.trans.wheelspin = true;
    }

    // ---- resistances ------------------------------------------------------------------
    const crr = this.onGrass ? CAR.grassRollingResistance
      : (this.onDirt ? 0.03 : CAR.rollingResistance);
    let Fres = -CAR.airDrag * this.u * vAbsU - crr * m * G * Math.sign(this.u || 0);
    if (this.onGrass && vAbsU > 0.5) {
      Fres -= CAR.grassDrag * m * Math.sign(this.u) * Math.min(1, vAbsU / 6);
    }
    if (vAbsU < 0.02 && throttle === 0 && driverBrake === 0 && !holdStill) {
      Fres = 0;
    }

    // ---- forces in body frame ----------------------------------------------------------
    const cosD = Math.cos(delta), sinD = Math.sin(delta);
    const fyFw = fyF * cosD + FxF * sinD;
    let Fx = FxR + FxF * cosD - fyF * sinD + Fres;
    let Fy = fyR + fyFw;
    Fy += -m * G * Math.sin(this.roadRoll) * 0.85;
    const Mz = -a * fyFw + b * fyR;

    // ---- dynamic model integration -------------------------------------------------
    const du = Fx / m - this.v * this.yawRate;
    const dv = Fy / m + this.u * this.yawRate;
    const dw = Mz / CAR.inertiaYaw;

    this.dbgFx = Fx; this.dbgFy = Fy; this.dbgDrive = FxR; this.dbgBrake = FxF;
    this.dbgFyF = fyF; this.dbgFyR = fyR; this.dbgFres = Fres;

    // ---- low-speed kinematic blend --------------------------------------------------
    const w = smoothstep2(CAR.minSteerSpeed * 0.4, CAR.minSteerSpeed * 1.6, vAbsU);
    const uDyn = this.u + du * dt;
    const vDyn = this.v + dv * dt;
    const wDyn = this.yawRate + dw * dt;

    let omegaK = -(this.u * Math.tan(delta)) / L;
    omegaK = clamp(omegaK, -CAR.maxYawLowSpeed, CAR.maxYawLowSpeed);

    this.u = uDyn;
    this.v = lerp(0, vDyn, w);
    this.yawRate = lerp(omegaK, wDyn, w);
    this.heading += this.yawRate * dt;

    const nfX = Math.sin(this.heading), nfZ = Math.cos(this.heading);
    const rgtX = -nfZ, rgtZ = nfX;
    this.position.x += (nfX * this.u + rgtX * this.v) * dt;
    this.position.z += (nfZ * this.u + rgtZ * this.v) * dt;
    this.velocity.set(
      nfX * this.u + rgtX * this.v, 0,
      nfZ * this.u + rgtZ * this.v
    );

    if (this.trans.gear === -1 && this.u < -CAR.maxReverseSpeed) {
      this.u = -CAR.maxReverseSpeed;
    }

    // ---- telemetry -------------------------------------------------------------------
    const aLongInst = Fx / m;
    this.vF = this.u;
    this.vL = this.v;
    this.slip = Math.abs(this.v) + (this.wheelspin ? 2.8 : 0) + (this.rearLocked && vAbsU > 4 ? 3.0 : 0);
    this.slipAngleFront = alphaF;
    this.slipAngleRear = alphaR;
    this.reversing = this.u < -0.5;
    this.gForceLat = this.u * this.yawRate / G;
    this.gForceLong = aLongInst / G;

    // ---- post telemetry (re-locate after moving) -------------------------------------
    const nf2X = Math.sin(this.heading), nf2Z = Math.cos(this.heading);
    const surf2 = this.world.surfaceAt(this.position.x, this.position.z, nf2X, nf2Z);
    this.surfaceY = surf2.y;
    this.roadPitch = Math.atan(surf2.grade);
    this.roadRoll = Math.atan(surf2.bank);
    this.lateral = surf2.lateral;
    this.roadType = surf2.roadType;
    this.position.y = damp(this.position.y, this.surfaceY, 14, dt);

    this.latAccel = damp(this.latAccel, this.u * this.yawRate, 8, dt);
    this.aLongS = damp(this.aLongS, aLongInst, 7, dt);

    this.steerAngle = delta;

    // ---- suspension targets -------------------------------------------------------------
    this._updateSuspensionTargets(dt);

    if (vAbsU < 0.1) {
      this._fyF *= 0.9;
      this._fyR *= 0.9;
    }
  }

  // ------------------------------------------------------------------
  _updateSuspensionTargets(dt) {
    const longF = clamp(this.aLongS / 10, -1, 1);
    const leanR = clamp((this.u * this.yawRate) / 10, -1, 1);
    const base = 0.5;

    let fl = base - longF * 0.38 - leanR * 0.36;
    let fr = base - longF * 0.38 + leanR * 0.36;
    let rl = base + longF * 0.38 - leanR * 0.36;
    let rr = base + longF * 0.38 + leanR * 0.36;

    // per-wheel road height sampling (independent suspension feel).
    // Index order MUST match the fl/fr/rl/rr targets below: front axle first.
    // (fx along forward, rx along right; right = -X at heading 0, so a
    // negative rx offset is the LEFT wheel.)
    const halfWB = CAR.wheelbase / 2;
    const halfTW = CAR.trackWidth / 2;
    const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
    const rgtX = -fwdZ, rgtZ = fwdX;

    const wheelOffsets = [
      [halfWB, -halfTW],    // FL — front, left
      [halfWB, halfTW],     // FR — front, right
      [-halfWB, -halfTW],   // RL — rear, left
      [-halfWB, halfTW]     // RR — rear, right
    ];
    const wheelHeights = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const [fx, rx] = wheelOffsets[i];
      const wx = this.position.x + fwdX * fx + rgtX * rx;
      const wz = this.position.z + fwdZ * fx + rgtZ * rx;
      wheelHeights[i] = this.world.groundAt(wx, wz).y;
    }
    // exposed for the car visuals: each wheel tracks its own ground patch
    this.wheelGroundY = wheelHeights;
    const avgH = (wheelHeights[0] + wheelHeights[1] + wheelHeights[2] + wheelHeights[3]) / 4;
    const dev = wheelHeights.map((h) => h - avgH);
    fl += dev[0] * SUSP_BUMP;
    fr += dev[1] * SUSP_BUMP;
    rl += dev[2] * SUSP_BUMP;
    rr += dev[3] * SUSP_BUMP;

    if (this.onShoulder && Math.abs(this.vF) > 5) {
      this._bumpPhase += dt * 38;
      const bump = Math.sin(this._bumpPhase) * 0.35;
      if (this.lateral > 0) { fr += bump; rr += bump; }
      else { fl += bump; rl += bump; }
    }
    if ((this.onGrass || this.onDirt) && Math.abs(this.vF) > 4) {
      this._bumpPhase += dt * 15;
      const jitter = (Math.sin(this._bumpPhase * 3.1) + Math.sin(this._bumpPhase * 5.7)) * 0.16;
      fl += jitter; fr -= jitter * 0.8; rl -= jitter * 0.7; rr += jitter;
    }

    this.susp[0] = clamp(fl, 0, 1);
    this.susp[1] = clamp(fr, 0, 1);
    this.susp[2] = clamp(rl, 0, 1);
    this.susp[3] = clamp(rr, 0, 1);

    for (let i = 0; i < 4; i++) {
      this._suspSmooth[i] = damp(this._suspSmooth[i], this.susp[i], 10, dt);
    }
  }

  get suspSmooth() {
    return this._suspSmooth;
  }

  get speedKmh() {
    return Math.abs(this.vF) * 3.6;
  }

  /** road label for the HUD */
  get roadLabel() {
    return ROAD_INFO[this.roadType] ? ROAD_INFO[this.roadType].label : 'OFF-ROAD';
  }
}

const SUSP_BUMP = 3.2;

function smoothstep2(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
