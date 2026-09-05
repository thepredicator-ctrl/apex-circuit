/**
 * Vehicle physics — a DYNAMIC bicycle model with real tire behavior.
 *
 * This is a full rewrite of the old arcade/kinematic-yaw model. The car is
 * now a rigid body in the horizontal plane whose motion EMERGES from tire
 * forces, exactly like a real car:
 *
 *   - Slip angles are computed per axle from the velocity vector, yaw rate
 *     and steering angle.
 *   - Lateral tire force follows a Pacejka-style magic formula
 *     Fy = mu·Fz·sin(C·atan(B·slip)) — grip peaks around 6–8° of slip and
 *     falls off beyond it, so slides are progressive and catchable.
 *   - The friction ellipse couples longitudinal and lateral grip: flooring
 *     the throttle mid-corner shrinks available rear lateral grip (power
 *     oversteer), trail-braking shifts the balance, the handbrake locks the
 *     rear axle and kills its lateral grip (classic drift entry).
 *   - Load transfer (longitudinal from accel/braking + aero downforce)
 *     moves axle loads every step, and load sensitivity reduces peak mu on
 *     the more-loaded tire — weight transfer genuinely changes handling.
 *   - Yaw torque comes from the front/rear lateral force imbalance acting
 *     on the CG — understeer, oversteer and counter-steering all emerge
 *     from the model instead of being scripted.
 *   - Tire force build-up is delayed by a relaxation length (real tires
 *     need ~0.5 m of roll to develop force), which adds realism and damps
 *     high-frequency jitter.
 *
 * Below ~2.5 m/s the dynamic model is blended into a kinematic bicycle so
 * parking maneuvers and reverse stay stable (slip-angle math is singular
 * at zero speed).
 *
 * The engine/gearbox (Transmission.js) feeds real wheel torque into the
 * rear axle; everything downstream is honest physics.
 */

import * as THREE from 'three';
import { CAR, TRACK } from './Constants.js';

const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;
const lerp = THREE.MathUtils.lerp;

const G = 9.81;

export class VehiclePhysics {
  constructor(track, transmission) {
    this.track = track;
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

    // world-frame velocity (kept as a Vector3 for the camera rig / speed lines)
    this.velocity = new THREE.Vector3();

    // ---- telemetry (read by Car / Camera / Audio / HUD) --------------------
    this.vF = 0;                  // forward speed (signed)
    this.vL = 0;                  // lateral speed (+ = sliding toward car-right)
    this.slip = 0;                // combined slide measure — drives smoke & screech
    this.slipAngleFront = 0;      // rad
    this.slipAngleRear = 0;
    this.latAccel = 0;            // smoothed lateral accel (m/s²) — body roll
    this.aLongS = 0;              // smoothed longitudinal accel (m/s²)
    this.steerAngle = 0;          // actual front wheel angle (rad) — visuals
    this.throttleOut = 0;
    this.brakeOut = 0;
    this.reversing = false;
    this.wheelspin = false;
    this.rearLocked = false;      // handbrake slide
    this.engineForce = 0;         // post-cap drive force (telemetry, N)
    this.gForceLat = 0;           // instantaneous lateral g
    this.gForceLong = 0;

    // surface telemetry
    this.sampleIdx = 0;
    this.s = 0;                   // meters along the road
    this.lateral = 0;             // signed distance from centerline (+ = right)
    this.onGrass = false;
    this.onShoulder = false;
    this.onCurb = false;          // alias for shoulder (audio keeps using it)
    this.onRoad = true;
    this.surfaceY = 0;
    this.roadPitch = 0;
    this.roadRoll = 0;

    // per-wheel suspension compression targets (0..1), FL FR RL RR
    this.susp = [0.5, 0.5, 0.5, 0.5];
    this._suspSmooth = [0.5, 0.5, 0.5, 0.5];
    this._bumpPhase = 0;

    this.justHitWall = false;     // kept for API compatibility (never fires)
    this.hitImpact = 0;
    this._time = 0;
  }

  // ------------------------------------------------------------------
  /** Place the car at road progress `s` (meters), `lateralOffset` m right. */
  placeAt(s, lateralOffset = 0) {
    const p = this.track.pointAt(s);
    const tan = this.track.tangentAt(s);
    this.position.set(p.x, 0, p.z);
    this.position.x += -tan.z * lateralOffset;
    this.position.z += tan.x * lateralOffset;
    this.heading = Math.atan2(tan.x, tan.z);
    this.u = 0; this.v = 0;
    this.yawRate = 0;
    this._delta = 0;
    this._fyF = 0; this._fyR = 0;
    this.velocity.set(0, 0, 0);
    this.vF = 0; this.vL = 0;
    this.latAccel = 0;
    this.aLongS = 0;
    const loc = this.track.locate(this.position.x, this.position.z, null);
    this.sampleIdx = loc.idx;
    this.s = loc.s;
    this.lateral = loc.lateral;
    this._applySurface(loc);
    this.position.y = this.surfaceY;
    this.onGrass = false;
    this.onShoulder = false;
    this.onCurb = false;
    this.onRoad = true;
    this.susp = [0.5, 0.5, 0.5, 0.5];
    this._suspSmooth = [0.5, 0.5, 0.5, 0.5];
  }

  /** Project track-frame slope/bank into the car frame. */
  _applySurface(loc) {
    const surf = this.track.surfaceAt(loc.idx, this.lateral);
    this.surfaceY = surf.y;
    const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
    const along = fwdX * loc.tanX + fwdZ * loc.tanZ;
    const across = fwdX * loc.rightX + fwdZ * loc.rightZ;
    this.roadPitch = Math.atan(surf.slope * along);
    this.roadRoll = Math.atan(surf.bankSlope) * across;
  }

  // ------------------------------------------------------------------
  /**
   * Advance one physics sub-step (dt = 1/120 s).
   * @param {number} dt
   * @param {Input} input  provider with `.state`
   * @param {boolean} controlsActive
   */
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
    const a = CAR.aFront;          // CG -> front axle
    const b = CAR.bRear;           // CG -> rear axle

    // ---- steering: input maps to a real front-wheel angle -----------------
    const vAbsU = Math.abs(this.u);
    const fadeT = Math.pow(clamp(vAbsU / CAR.steerFadeSpeed, 0, 1), 0.85);
    const maxSteer = CAR.maxSteerRoad * lerp(1, CAR.steerFastFrac, fadeT);
    // steering rate limit — the wheels can only turn so fast (rack speed)
    const targetDelta = steerInput * maxSteer;
    const rackRate = 3.6 * maxSteer;   // full lock in ~0.28 s
    const dDelta = clamp(targetDelta - this._delta, -rackRate * dt, rackRate * dt);
    this._delta += dDelta;
    const delta = this._delta;

    // ---- surface lookup ------------------------------------------------------
    const HW = TRACK.roadHalfWidth;
    const laneHW = TRACK.laneHalfWidth;
    const loc = this.track.locate(this.position.x, this.position.z, this.sampleIdx);
    this.sampleIdx = loc.idx;
    this.s = loc.s;
    this.lateral = loc.lateral;
    const absLat = Math.abs(loc.lateral);
    this.onShoulder = absLat > laneHW && absLat <= HW + 0.4;
    this.onGrass = absLat > HW + 0.4;
    this.onCurb = this.onShoulder;
    this.onRoad = !this.onGrass;
    this._applySurface(loc);

    // surface grip multipliers
    let surfMu = 1.0;
    if (this.onShoulder) surfMu = 0.86;
    if (this.onGrass) surfMu = 0.0;      // replaced below by grass mu

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
    const muBase = this.onGrass ? CAR.muGrass : CAR.muAsphalt * (surfMu || 1);
    let muF = muBase, muR = muBase;
    this.rearLocked = handbrake;             // rear axle is locked while handbraking
    // load sensitivity: peak mu drops as a tire is loaded harder
    const loadSens = (mu, Fz, Fz0) =>
      mu * clamp(1 - CAR.loadSens * (Fz - Fz0) / Fz0, 0.8, 1.15);
    const muFeff = loadSens(muF, FzF, staticF);
    const muReff = loadSens(muR, FzR, staticR);

    // ---- slip angles -------------------------------------------------------------
    // Frame convention: v is measured along car-RIGHT, positive yaw turns LEFT.
    // Lateral velocity of each axle point (rightward +):
    //   v_F = v - omega·a    v_R = v + omega·b
    // atan2 guards the low-speed singularity; the kinematic blend below
    // takes over before these matter.
    const ux = Math.max(vAbsU, 1.1);
    const sgn = this.u < -0.2 ? -1 : 1;    // reverse flips steering geometry
    const alphaF = Math.atan2(this.v - this.yawRate * a, ux) - delta * sgn;
    const alphaR = Math.atan2(this.v + this.yawRate * b, ux);

    // ---- raw lateral forces (Pacejka-style + post-peak falloff) ----------------
    const pacejka = (alpha, B, C) => Math.sin(C * Math.atan(B * alpha));
    // peak slip angle for each axle: tan(pi/(2C))/B
    const peakF = Math.tan(Math.PI / (2 * CAR.tireCFront)) / CAR.tireBFront;
    const peakR = Math.tan(Math.PI / (2 * CAR.tireCRear)) / CAR.tireBRear;
    // beyond the peak, grip decays — this is what makes big slides catchable
    const fallF = 1 - CAR.slipFalloff * smoothstep2(peakF, peakF * 3, Math.abs(alphaF));
    const fallR = 1 - CAR.slipFalloff * smoothstep2(peakR, peakR * 3, Math.abs(alphaR));
    let fyFTarget = -muFeff * FzF * pacejka(alphaF, CAR.tireBFront, CAR.tireCFront) * fallF;
    let fyRTarget = -muReff * FzR * pacejka(alphaR, CAR.tireBRear, CAR.tireCRear) * fallR;

    // tire force build-up: relaxation length (needs distance to develop force)
    const relaxK = clamp(vAbsU * dt / CAR.relaxLength, 0, 1);
    this._fyF += (fyFTarget - this._fyF) * relaxK;
    this._fyR += (fyRTarget - this._fyR) * relaxK;

    // ---- longitudinal forces -------------------------------------------------------
    // drive (rear axle)
    let driveF = this.trans.driveForce;   // N, signed
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

    // brakes — split by bias, traction-limited per axle
    const braking = driverBrake > 0 && vAbsU > 0.35;
    const reverseDrive = this.trans.mode === 'auto' && this.trans.gear === -1;
    let FxF = 0;
    let FxR = driveF;
    if (braking && !(reverseDrive && this.u < 0.35)) {
      const demand = CAR.brakeMaxDecel * m * driverBrake;
      const dir = Math.sign(this.u) || 1;
      FxF = -dir * demand * CAR.brakeBiasFront;
      FxR += -dir * demand * (1 - CAR.brakeBiasFront);
    }
    // handbrake: the rear axle LOCKS. A locked wheel cannot produce the
    // Pacejka lateral/ellipse response at all — it slides with kinetic
    // friction opposing the rear axle's actual velocity direction. That
    // sliding vector naturally contains both a braking component and a
    // lateral component, which is exactly how real handbrake entries feel.
    let rearSliding = false;
    let fyRSlide = 0;
    if (handbrake) {
      const vRx = this.u;
      const vRy = this.v + this.yawRate * b;      // rear-axle lateral velocity
      const vRs = Math.hypot(vRx, vRy);
      rearSliding = true;
      if (vRs > 0.4) {
        const muSlide = muBase * 0.62;             // kinetic rubber
        FxR = -muSlide * FzR * (vRx / vRs);
        fyRSlide = -muSlide * FzR * (vRy / vRs);
      } else {
        FxR = 0;
        fyRSlide = 0;
      }
    }
    // parking brake when controls are locked
    if (holdStill) FxR += -Math.sign(this.u || 1) * Math.min(2000, Math.abs(this.u) * m);

    // ---- friction ellipse (combined slip) ------------------------------------------
    // longitudinal forces are capped per-axle by the tire friction limit…
    const FmaxF = muLong * FzF;
    if (Math.abs(FxR) > FmaxR) FxR = Math.sign(FxR) * FmaxR;
    if (Math.abs(FxF) > FmaxF) FxF = Math.sign(FxF) * FmaxF;
    // …and lateral capacity shrinks by whatever longitudinal force uses the pad
    const capF = Math.sqrt(Math.max(0, Math.pow(muFeff * FzF, 2) - Math.pow(FxF * 0.94, 2)));
    const capR = Math.sqrt(Math.max(0, Math.pow(muReff * FzR, 2) - Math.pow(FxR * 0.94, 2)));
    const fyF = clamp(this._fyF, -capF, capF);
    // a LOCKED rear axle bypasses the ellipse entirely — it slides kinetically
    const fyR = rearSliding ? fyRSlide : clamp(this._fyR, -capR, capR);
    if (!rearSliding && Math.abs(this._fyR) > capR && driveF > 0) {
      this.wheelspin = true;               // throttle stealing rear grip
      this.trans.wheelspin = true;
    }

    // ---- resistances ------------------------------------------------------------------
    const crr = this.onGrass ? CAR.grassRollingResistance : CAR.rollingResistance;
    let Fres = -CAR.airDrag * this.u * vAbsU - crr * m * G * Math.sign(this.u || 0);
    if (this.onGrass && vAbsU > 0.5) {
      Fres -= CAR.grassDrag * m * Math.sign(this.u) * Math.min(1, vAbsU / 6);
    }
    if (vAbsU < 0.02 && throttle === 0 && driverBrake === 0 && !holdStill) {
      Fres = 0;
    }

    // ---- forces in body frame ----------------------------------------------------------
    // (all forces measured along car-right; positive yaw = LEFT turn)
    const cosD = Math.cos(delta), sinD = Math.sin(delta);
    const fyFw = fyF * cosD + FxF * sinD;   // front force, along car-right
    let Fx = FxR + FxF * cosD - fyF * sinD + Fres;
    let Fy = fyR + fyFw;
    // superelevation: gravity pulls the car down the bank (0.85 softens the
    // projection since roadRoll already includes the along-road alignment)
    Fy += -m * G * Math.sin(this.roadRoll) * 0.85;
    // yaw moment: rightward force at the front turns the nose RIGHT
    const Mz = -a * fyFw + b * fyR;

    // ---- dynamic model integration -------------------------------------------------
    const du = Fx / m - this.v * this.yawRate;
    const dv = Fy / m + this.u * this.yawRate;
    const dw = Mz / CAR.inertiaYaw;

    // debug telemetry (force breakdown for tuning)
    this.dbgFx = Fx; this.dbgFy = Fy; this.dbgDrive = FxR; this.dbgBrake = FxF;
    this.dbgFyF = fyF; this.dbgFyR = fyR; this.dbgFres = Fres;

    // ---- low-speed kinematic blend --------------------------------------------------
    // The bicycle model is singular at u = 0. Below ~2.5 m/s we blend toward
    // the kinematic bicycle (wheels define the path) so parking and reverse
    // feel precise.
    const w = smoothstep2(CAR.minSteerSpeed * 0.4, CAR.minSteerSpeed * 1.6, vAbsU);
    let uDyn = this.u + du * dt;
    let vDyn = this.v + dv * dt;
    let wDyn = this.yawRate + dw * dt;

    let omegaK = -(this.u * Math.tan(delta)) / L;
    omegaK = clamp(omegaK, -CAR.maxYawLowSpeed, CAR.maxYawLowSpeed);

    const uNew = uDyn;
    const vNew = lerp(0, vDyn, w);
    const wNew = lerp(omegaK, wDyn, w);

    // integrate pose
    this.u = uNew;
    this.v = vNew;
    this.yawRate = wNew;
    this.heading += this.yawRate * dt;

    const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
    const rgtX = -fwdZ, rgtZ = fwdX;
    this.position.x += (fwdX * this.u + rgtX * this.v) * dt;
    this.position.z += (fwdZ * this.u + rgtZ * this.v) * dt;
    // world-frame velocity for the camera rig / speed lines / particles
    this.velocity.set(
      fwdX * this.u + rgtX * this.v, 0,
      fwdZ * this.u + rgtZ * this.v
    );

    // reverse limiter
    if (this.trans.gear === -1 && this.u < -CAR.maxReverseSpeed) {
      this.u = -CAR.maxReverseSpeed;
    }

    // ---- telemetry -------------------------------------------------------------------
    // TRUE longitudinal acceleration of the CG (world-consistent). NOTE: du
    // alone includes the -v·omega frame-rotation coupling, which is NOT real
    // deceleration — feeding it into load transfer would drain the rear axle
    // every time the car rotates (killing drive force mid-drift). Use Fx/m.
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
    const loc2 = this.track.locate(this.position.x, this.position.z, this.sampleIdx);
    this.sampleIdx = loc2.idx;
    this.s = loc2.s;
    this.lateral = loc2.lateral;
    this._applySurface(loc2);
    this.position.y = damp(this.position.y, this.surfaceY, 14, dt);

    this.latAccel = damp(this.latAccel, this.u * this.yawRate, 8, dt);
    this.aLongS = damp(this.aLongS, aLongInst, 7, dt);

    // visual wheel angle = the actual steered angle
    this.steerAngle = delta;

    // ---- suspension targets -------------------------------------------------------------
    this._updateSuspensionTargets(dt, loc2);

    // decay tire force states when nearly stopped
    if (vAbsU < 0.1) {
      this._fyF *= 0.9;
      this._fyR *= 0.9;
    }
  }

  // ------------------------------------------------------------------
  _updateSuspensionTargets(dt, loc) {
    // weight transfer (drives body roll + pitch)
    const longF = clamp(this.aLongS / 10, -1, 1);
    const leanR = clamp((this.u * this.yawRate) / 10, -1, 1);
    const base = 0.5;

    let fl = base - longF * 0.38 - leanR * 0.36;
    let fr = base - longF * 0.38 + leanR * 0.36;
    let rl = base + longF * 0.38 - leanR * 0.36;
    let rr = base + longF * 0.38 + leanR * 0.36;

    // per-wheel road height sampling (independent suspension feel)
    const halfWB = CAR.wheelbase / 2;
    const halfTW = CAR.trackWidth / 2;
    const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
    const rgtX = -fwdZ, rgtZ = fwdX;

    const wheelOffsets = [
      [-halfWB, -halfTW],  // FL
      [-halfWB,  halfTW],  // FR
      [ halfWB, -halfTW],  // RL
      [ halfWB,  halfTW]   // RR
    ];
    const wheelHeights = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const [fx, rx] = wheelOffsets[i];
      const wx = this.position.x + fwdX * fx + rgtX * rx;
      const wz = this.position.z + fwdZ * fx + rgtZ * rx;
      const wloc = this.track.locate(wx, wz, loc.idx);
      const wsurf = this.track.surfaceAt(wloc.idx, wloc.lateral);
      wheelHeights[i] = wsurf.y;
    }
    const avgH = (wheelHeights[0] + wheelHeights[1] + wheelHeights[2] + wheelHeights[3]) / 4;
    const dev = wheelHeights.map((h) => h - avgH);
    fl += dev[0] * SUSP_BUMP;
    fr += dev[1] * SUSP_BUMP;
    rl += dev[2] * SUSP_BUMP;
    rr += dev[3] * SUSP_BUMP;

    // shoulder rumble / grass jitter
    if (this.onShoulder && Math.abs(this.vF) > 5) {
      this._bumpPhase += dt * 38;
      const bump = Math.sin(this._bumpPhase) * 0.35;
      if (this.lateral > 0) { fr += bump; rr += bump; }
      else { fl += bump; rl += bump; }
    }
    if (this.onGrass && Math.abs(this.vF) > 4) {
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

  /** smoothed suspension compression (0..1) per wheel — read by Car */
  get suspSmooth() {
    return this._suspSmooth;
  }

  get speedKmh() {
    return Math.abs(this.vF) * 3.6;
  }
}

const SUSP_BUMP = 3.2;   // road-height deviation (m) -> compression units

/** smootherstep-ish blend used for the kinematic transition */
function smoothstep2(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
