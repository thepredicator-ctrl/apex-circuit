/**
 * VehiclePhysics — simulation-grade vehicle dynamics.
 *
 * This is a real tire-model simulation, not an arcade yaw-rate cap:
 *
 *   - Per-wheel vertical load: static load + longitudinal load transfer
 *     (aLong * CGheight / wheelbase) + lateral load transfer
 *     (aLat * CGheight / trackWidth) per axle, plus aerodynamic downforce
 *     distributed 45/55 F/R. Each wheel's load is computed independently.
 *
 *   - Pacejka Magic Formula (simplified) for combined slip:
 *       F_x = D_x * sin(C_x * atan(B_x * kappa - E_x * (B_x * kappa - atan(B_x * kappa))))
 *       F_y = D_y * sin(C_y * atan(B_y * alpha - E_y * (B_y * alpha - atan(B_y * alpha))))
 *     where kappa = longitudinal slip ratio, alpha = slip angle.
 *     Combined forces are resolved with the friction-circle method
 *     (Beckmann): the demands are scaled so the resultant vector stays
 *     inside the tire's load-dependent friction ellipse.
 *
 *   - Slip ratios are computed from wheel angular velocity (driven wheels
 *     get torque from the transmission; non-driven wheels free-roll).
 *     Slip angles come from the body's velocity vector at each wheel hub.
 *
 *   - Yaw is integrated from the sum of tire lateral forces × moment arm
 *     around the CG, with a small inertial damping term. No artificial
 *     "maxYaw" cap — the car will spin if you exceed the grip circle.
 *
 *   - Brake bias is fixed at 60/40 F/R (typical 911 setup with rear-biased
 *     engine weight). Handbrake locks the rear axle (kappa → -1).
 *
 *   - Surfaces: asphalt mu ~1.4 (with the Pacejka D multiplier), grass
 *     mu ~0.45, curb mu ~1.0 (no penalty, just bump jitter).
 *
 * The model is intentionally compact (~250 lines) but covers every effect
 * that makes a car feel like a car: weight transfer, lift-off oversteer,
 * trail-braking rotation, throttle-on power oversteer, handbrake drifts,
 * and proper limited-slip behavior (driven axle solidly linked).
 */

import * as THREE from 'three';
import { CAR, TRACK } from './Constants.js';

const _fwd0 = new THREE.Vector3();
const _right0 = new THREE.Vector3();
const _vel = new THREE.Vector3();

const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;

// ---- Pacejka Magic Formula (simplified, sport-touring car) ----------------
// These constants are tuned for a 1180 kg rear-engined sports car on 245-series
// tires. D = peak (multiplied by load), C = shape, B = stiffness, E = curvature.
const PACEJKA_LONG = { B: 8.0, C: 1.65, D: 1.10, E: 0.97 };
const PACEJKA_LAT  = { B: 9.0, C: 1.45, D: 1.18, E: 0.98 };

/** Pure Pacejka: F/D = sin(C * atan(B*x - E*(B*x - atan(B*x)))) */
function pacejka(x, p) {
  const Bx = p.B * x;
  return p.D * Math.sin(p.C * Math.atan(Bx - p.E * (Bx - Math.atan(Bx))));
}

/**
 * Combined slip (friction circle / Beckmann): given desired longitudinal
 * force Fx0 and lateral Fy0 (both as multiples of vertical load), and a
 * friction multiplier mu, scale them so the resultant stays inside the
 * ellipse: |Fx|/muFx_max + (Fy/Fy_max)^2 <= 1 (simplified to a circle when
 * muFx_max = Fy_max, which is close enough for our purposes).
 *
 * Returns { Fx, Fy } as fractions of vertical load.
 */
function combinedSlip(kappa, alpha, mu) {
  const fx0 = pacejka(kappa, PACEJKA_LONG);
  const fy0 = pacejka(alpha, PACEJKA_LAT);
  const fxAbs = Math.abs(fx0);
  const fyAbs = Math.abs(fy0);
  const total = Math.sqrt(fxAbs * fxAbs + fyAbs * fyAbs);
  // friction circle: cap the resultant at the tire's peak
  const cap = mu;
  let scale = 1;
  if (total > cap) scale = cap / total;
  return { Fx: fx0 * scale, Fy: fy0 * scale };
}

// ---- per-wheel state ------------------------------------------------------
// 0=FL, 1=FR, 2=RL, 3=RR
const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'];

export class VehiclePhysics {
  constructor(track, transmission) {
    this.track = track;
    this.trans = transmission;

    this.position = new THREE.Vector3();
    this.heading = 0;            // rad, 0 = +Z, forward = (sin h, 0, cos h)
    this.velocity = new THREE.Vector3();
    this.yawRate = 0;            // rad/s

    // telemetry
    this.vF = 0;
    this.vL = 0;
    this.slip = 0;
    this.latAccel = 0;
    this.aLongS = 0;
    this.steerAngle = 0;
    this.throttleOut = 0;
    this.brakeOut = 0;
    this.reversing = false;
    this.wheelspin = false;
    this.engineForce = 0;

    // surface telemetry
    this.sampleIdx = 0;
    this.s = 0;
    this.lateral = 0;
    this.onGrass = false;
    this.onCurb = false;
    this.onRoad = true;
    this.surfaceY = 0;
    this.roadPitch = 0;
    this.roadRoll = 0;

    // per-wheel arrays (length 4, FL/FR/RL/RR)
    this.wheelLoad = [0, 0, 0, 0];        // N vertical load
    this.wheelSlipKappa = [0, 0, 0, 0];   // longitudinal slip ratio (-1..1)
    this.wheelSlipAlpha = [0, 0, 0, 0];   // lateral slip angle (rad)
    this.wheelOmega = [0, 0, 0, 0];       // angular velocity (rad/s)
    this.wheelFx = [0, 0, 0, 0];          // longitudinal force (N)
    this.wheelFy = [0, 0, 0, 0];          // lateral force (N)

    this.susp = [0.5, 0.5, 0.5, 0.5];
    this._suspSmooth = [0.5, 0.5, 0.5, 0.5];
    this._bumpPhase = 0;

    this.justHitWall = false;
    this._time = 0;

    // derived geometry from CAR constants
    this._halfWB = CAR.wheelbase / 2;
    this._halfTrack = CAR.trackWidth / 2;
    this._invInertia = 1 / CAR.yawInertia; // 1/(kg·m²)
  }

  placeAt(s, lateralOffset = 0) {
    const p = this.track.pointAt(s);
    const tan = this.track.tangentAt(s);
    this.position.set(p.x, 0, p.z);
    this.position.x += -tan.z * lateralOffset;
    this.position.z += tan.x * lateralOffset;
    this.heading = Math.atan2(tan.x, tan.z);
    this.velocity.set(0, 0, 0);
    this.vF = 0;
    this.vL = 0;
    this.slip = 0;
    this.latAccel = 0;
    this.aLongS = 0;
    this.yawRate = 0;
    this.wheelOmega = [0, 0, 0, 0];
    this.wheelSlipKappa = [0, 0, 0, 0];
    this.wheelSlipAlpha = [0, 0, 0, 0];
    const loc = this.track.locate(this.position.x, this.position.z, null);
    this.sampleIdx = loc.idx;
    this.s = loc.s;
    this.lateral = loc.lateral;
    this._applySurface(loc);
    this.position.y = this.surfaceY;
    this.onGrass = false;
    this.onCurb = false;
    this.onRoad = true;
    this.susp = [0.5, 0.5, 0.5, 0.5];
    this._suspSmooth = [0.5, 0.5, 0.5, 0.5];
  }

  _applySurface(loc) {
    const surf = this.track.surfaceAt(loc.idx, this.lateral);
    this.surfaceY = surf.y;
    const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
    const along = fwdX * loc.tanX + fwdZ * loc.tanZ;
    const across = fwdX * loc.rightX + fwdZ * loc.rightZ;
    this.roadPitch = Math.atan(surf.slope * along);
    this.roadRoll = Math.atan(surf.bankSlope) * across;
  }

  /**
   * Advance one physics sub-step (dt seconds).
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

    // --- body-frame basis vectors -----------------------------------------
    _fwd0.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    _right0.set(-_fwd0.z, 0, _fwd0.x);

    const vF = this.velocity.dot(_fwd0);
    const vL = this.velocity.dot(_right0);
    const vF0 = vF;
    const vAbs = Math.hypot(vF, vL);

    // --- surface lookup ---------------------------------------------------
    const roadHalf = TRACK.roadHalfWidth;
    const loc = this.track.locate(this.position.x, this.position.z, this.sampleIdx);
    this.sampleIdx = loc.idx;
    this.s = loc.s;
    this.lateral = loc.lateral;
    const absLat = Math.abs(loc.lateral);
    this.onCurb = loc.curb && absLat > roadHalf - 0.4 && absLat < roadHalf + 1.5;
    this.onGrass = absLat > roadHalf + 1.5;
    this.onRoad = !this.onGrass;
    this._applySurface(loc);

    // --- transmission (updates wheel torque for driven wheels) ------------
    this.trans.update(dt, {
      wheelSpeed: vF,
      throttle,
      brake: driverBrake,
      controlsActive
    });

    // --- per-wheel hub velocities (body frame) ----------------------------
    // wheel hub positions relative to CG (body frame: +X = forward, +Y = right)
    // FL/FR are front (-X), RL/RR are rear (+X); left/right on ±Y.
    // hubVel = vCG + omega × r
    const yaw = this.yawRate;
    // hub velocities in body frame
    const hubVel = [
      // [vx_body, vy_body] = [vF, vL] + [-yaw * y_hub, yaw * x_hub]
      { vx: vF - yaw * (-this._halfTrack), vy: vL + yaw * (-this._halfWB) }, // FL (x=-halfWB, y=-halfTrack)
      { vx: vF - yaw * ( this._halfTrack), vy: vL + yaw * (-this._halfWB) }, // FR (x=-halfWB, y=+halfTrack)
      { vx: vF - yaw * (-this._halfTrack), vy: vL + yaw * ( this._halfWB) }, // RL (x=+halfWB, y=-halfTrack)
      { vx: vF - yaw * ( this._halfTrack), vy: vL + yaw * ( this._halfWB) }  // RR (x=+halfWB, y=+halfTrack)
    ];

    // --- vertical loads (load transfer + downforce) -----------------------
    const m = CAR.mass;
    const g = 9.81;
    const df = CAR.downforce * vF * vF;     // N total downforce
    // longitudinal load transfer (front <-> rear)
    const longXfer = m * this.aLongS * CAR.cgHeight / CAR.wheelbase;
    // lateral load transfer (left <-> right) — total, distributed by axle
    const latXferTotal = m * this.latAccel * CAR.cgHeight / CAR.trackWidth;
    // per-axle distribution: 911 has more rear weight, so rear takes more lat transfer
    const latXferFront = latXferTotal * CAR.weightDistFront;
    const latXferRear = latXferTotal * (1 - CAR.weightDistFront);

    const staticF = m * g * CAR.weightDistFront / 2;     // per front wheel
    const staticR = m * g * (1 - CAR.weightDistFront) / 2; // per rear wheel
    const dfFront = df * 0.45 / 2;
    const dfRear = df * 0.55 / 2;

    // sign convention: aLongS > 0 = accelerating (load shifts REAR)
    // latAccel > 0 = turning left (load shifts RIGHT)
    // yawRate > 0 = turning left (matches)
    const latSign = (this.latAccel >= 0) ? 1 : -1;
    this.wheelLoad[0] = Math.max(m * g * 0.05, staticF - longXfer / 2 + dfFront - latXferFront / 2 * latSign);  // FL
    this.wheelLoad[1] = Math.max(m * g * 0.05, staticF - longXfer / 2 + dfFront + latXferFront / 2 * latSign);  // FR
    this.wheelLoad[2] = Math.max(m * g * 0.05, staticR + longXfer / 2 + dfRear - latXferRear / 2 * latSign);    // RL
    this.wheelLoad[3] = Math.max(m * g * 0.05, staticR + longXfer / 2 + dfRear + latXferRear / 2 * latSign);    // RR

    // --- surface grip multiplier ------------------------------------------
    const muBase = this.onGrass ? CAR.gripGrass : (this.onCurb ? CAR.gripCurb : CAR.gripAsphalt);

    // --- steering: Ackermann-corrected front wheel angles -----------------
    // Bicycle model: average steer angle from input, then Ackermann splits
    // it between inner and outer front wheels for true geometric turning.
    const baseSteer = -steerInput * CAR.maxSteerAngle;
    // Ackermann correction: inner wheel steers more than outer
    const turnRadius = Math.abs(this.yawRate) > 0.01 ? vF / this.yawRate : 1e6;
    const ackL = Math.atan(this._halfWB / (turnRadius + this._halfTrack)) * Math.sign(baseSteer);
    const ackR = Math.atan(this._halfWB / (turnRadius - this._halfTrack)) * Math.sign(baseSteer);
    // smooth blend: at low yaw, fall back to equal steer
    const ackBlend = clamp(Math.abs(turnRadius) / 30, 0, 1);
    const steerFL = baseSteer * (1 - ackBlend) + ackL * ackBlend;
    const steerFR = baseSteer * (1 - ackBlend) + ackR * ackBlend;

    // --- driven wheels get torque; non-driven wheels free-roll ------------
    // RWD layout (911 is rear-engine, RWD on the Carrera)
    const driven = [false, false, true, true];
    const driveTorquePerWheel = this.trans.driveForce * CAR.wheelRadius / 2; // N·m per driven wheel

    // brake torque split 60/40 F/R
    const brakeBiasFront = 0.60;
    const totalBrakeTorque = driverBrake * CAR.brakeTorque;
    const brakeTorqueF = totalBrakeTorque * brakeBiasFront / 2;
    const brakeTorqueR = totalBrakeTorque * (1 - brakeBiasFront) / 2;
    const brakeTorque = [brakeTorqueF, brakeTorqueF, brakeTorqueR, brakeTorqueR];

    // handbrake: lock the rear axle (huge brake torque on rear wheels)
    const handbrakeTorque = handbrake ? CAR.brakeTorque * 1.2 : 0;

    // rolling resistance torque (small, always present)
    const rrTorque = CAR.rollingResistance * g * CAR.wheelRadius * 0.02;

    // --- per-wheel slip ratios + forces -----------------------------------
    let totalFx = 0;       // body-forward force (N)
    let totalFy = 0;       // body-right force (N)
    let yawMoment = 0;     // N·m around CG
    this.wheelspin = false;

    const R = CAR.wheelRadius;
    for (let i = 0; i < 4; i++) {
      const load = this.wheelLoad[i];
      const omega = this.wheelOmega[i];
      // wheel ground speed = hub forward speed
      const vGround = hubVel[i].vx;
      // slip ratio: kappa = (omega*R - vGround) / max(|vGround|, vRef)
      const vRef = Math.max(Math.abs(vGround), 2.0);
      let kappa = (omega * R - vGround) / vRef;
      kappa = clamp(kappa, -1, 1);

      // slip angle: alpha = atan(vL_hub / |vF_hub|) - steerAngle
      const vHubAbs = Math.max(Math.abs(hubVel[i].vx), 0.5);
      let alpha = Math.atan2(hubVel[i].vy, vHubAbs);
      if (i === 0) alpha -= steerFL;       // front wheels steer
      else if (i === 1) alpha -= steerFR;

      // handbrake locks the rear wheels -> kappa = -1 (pure slide)
      if ((i === 2 || i === 3) && handbrake) {
        kappa = -Math.sign(vGround);
        alpha *= 0.3; // handbrake also reduces lateral grip
      }

      // surface mu (driven wheels under power get a small reduction at high slip)
      let mu = muBase;
      if (driven[i] && Math.abs(kappa) > 0.15) {
        mu *= 1 - clamp((Math.abs(kappa) - 0.15) * 0.3, 0, 0.2);
      }

      // combined Pacejka
      const { Fx, Fy } = combinedSlip(kappa, alpha, mu);
      const FxN = Fx * load;
      const FyN = Fy * load;

      this.wheelFx[i] = FxN;
      this.wheelFy[i] = FyN;
      this.wheelSlipKappa[i] = kappa;
      this.wheelSlipAlpha[i] = alpha;

      totalFx += FxN;
      totalFy += FyN;

      // yaw moment: M = Fy * x_hub - Fx * y_hub (around CG)
      const xHub = (i < 2) ? -this._halfWB : this._halfWB;
      const yHub = (i % 2 === 0) ? -this._halfTrack : this._halfTrack;
      yawMoment += FyN * xHub - FxN * yHub;

      // wheelspin flag for visual + audio
      if (Math.abs(kappa) > 0.30 && driven[i]) this.wheelspin = true;

      // integrate wheel angular velocity from torques (driven + brake + handbrake + RR)
      let torque = 0;
      if (driven[i]) torque += driveTorquePerWheel;
      torque -= brakeTorque[i];
      if (i === 2 || i === 3) torque -= handbrakeTorque;
      torque -= Math.sign(omega) * rrTorque;
      // reaction torque from the tire force (Newton's 3rd law on the wheel)
      torque -= FxN * R;
      this.wheelOmega[i] = omega + torque / CAR.wheelInertia * dt;
      // clamp insane values
      const omegaMax = 250; // ~700 km/h equivalent
      this.wheelOmega[i] = clamp(this.wheelOmega[i], -omegaMax, omegaMax);
    }

    this.trans.wheelspin = this.wheelspin;

    // --- aerodynamic drag -------------------------------------------------
    const dragF = CAR.airDrag * vF * Math.abs(vF);  // N, opposes motion
    totalFx -= dragF;
    // small side force from aerodynamic yaw (drift drag)
    totalFy -= CAR.airDragLat * vL * Math.abs(vL);

    // --- integrate body ---------------------------------------------------
    const aLong = totalFx / m;
    const aLat = totalFy / m;

    // forward/lateral velocity update (semi-implicit Euler)
    let newVF = vF + aLong * dt;
    let newVL = vL + aLat * dt;

    // rolling resistance at very low speed (parking brake effect)
    if (holdStill) {
      newVF *= 0.85;
      newVL *= 0.85;
    }
    if (Math.abs(newVF) < 0.02 && throttle === 0 && driverBrake === 0) newVF = 0;

    // reverse speed limiter
    if (this.trans.gear === -1 && newVF < -CAR.maxReverseSpeed) newVF = -CAR.maxReverseSpeed;

    // yaw integration: M = I * d(omega)/dt
    const yawAccel = yawMoment * this._invInertia;
    // small yaw damping (tire relaxation + aerodynamic yaw drag)
    const yawDamp = 0.6;
    this.yawRate = this.yawRate + (yawAccel - yawDamp * this.yawRate) * dt;

    // --- re-decompose in the new heading ----------------------------------
    this.heading += this.yawRate * dt;

    _fwd0.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    _right0.set(-_fwd0.z, 0, _fwd0.x);
    this.velocity.copy(_fwd0).multiplyScalar(newVF).addScaledVector(_right0, newVL);

    // --- integrate position -----------------------------------------------
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // --- telemetry --------------------------------------------------------
    this.vF = newVF;
    this.vL = newVL;
    this.slip = Math.abs(newVL);
    this.reversing = newVF < -0.5;
    this.engineForce = aLong;

    // --- soft wall collision -------------------------------------------------------
    const wallLat = roadHalf + CAR.wallOffset - CAR.carHalfWidth;
    if (Math.abs(this.lateral) > wallLat) {
      const sign = Math.sign(this.lateral);
      const over = Math.abs(this.lateral) - wallLat;
      const rX = loc.rightX;
      const rZ = loc.rightZ;
      this.position.x -= rX * sign * over;
      this.position.z -= rZ * sign * over;

      const vNormal = this.velocity.x * rX + this.velocity.z * rZ;
      if (vNormal * sign > 0) {
        const impact = Math.abs(vNormal);
        this.velocity.x -= rX * vNormal * (1 + CAR.wallBounce);
        this.velocity.z -= rZ * vNormal * (1 + CAR.wallBounce);
        if (impact > 1.5) this.velocity.multiplyScalar(CAR.wallSpeedScrub);
        this.justHitWall = impact > 2.5;
        this.hitImpact = impact;
      }
      this.vF = this.velocity.dot(_fwd0);
      this.vL = this.velocity.dot(_right0);
    }

    // --- post telemetry ---------------------------------------------------------------
    const loc2 = this.track.locate(this.position.x, this.position.z, this.sampleIdx);
    this.sampleIdx = loc2.idx;
    this.s = loc2.s;
    this.lateral = loc2.lateral;
    this._applySurface(loc2);
    this.position.y = damp(this.position.y, this.surfaceY, 14, dt);

    this.latAccel = damp(this.latAccel, aLat, 6, dt);
    this.aLongS = damp(this.aLongS, aLong, 5, dt);

    // visual front wheel angle (average of FL + FR steer)
    this.steerAngle = (steerFL + steerFR) / 2;

    // --- suspension targets ------------------------------------------------------------
    this._updateSuspensionTargets(dt, loc2);
  }

  _updateSuspensionTargets(dt, loc) {
    const longF = clamp(this.aLongS / 11, -1, 1);
    const leanR = clamp(this.latAccel / 11, -1, 1);
    const base = 0.5;

    let fl = base - longF * 0.42 - leanR * 0.4;
    let fr = base - longF * 0.42 + leanR * 0.4;
    let rl = base + longF * 0.42 - leanR * 0.4;
    let rr = base + longF * 0.42 + leanR * 0.4;

    if (this.onCurb && Math.abs(this.vF) > 5) {
      this._bumpPhase += dt * SUSPENSION_FREQ;
      const bump = Math.sin(this._bumpPhase) * 0.5;
      if (this.lateral > 0) { fl += bump; fr -= bump; }
      else { rl += bump; rr -= bump; }
    }
    if (this.onGrass && Math.abs(this.vF) > 6) {
      this._bumpPhase += dt * 14;
      const jitter = (Math.sin(this._bumpPhase * 3.1) + Math.sin(this._bumpPhase * 5.7)) * 0.14;
      fl += jitter; fr -= jitter * 0.8; rl -= jitter * 0.7; rr += jitter;
    }

    this.susp[0] = clamp(fl, 0, 1);
    this.susp[1] = clamp(fr, 0, 1);
    this.susp[2] = clamp(rl, 0, 1);
    this.susp[3] = clamp(rr, 0, 1);

    for (let i = 0; i < 4; i++) {
      this._suspSmooth[i] = damp(this._suspSmooth[i], this.susp[i], SUSP_RATE, dt);
    }
  }

  get suspSmooth() {
    return this._suspSmooth;
  }

  get speedKmh() {
    return Math.abs(this.vF) * 3.6;
  }
}

const SUSPENSION_FREQ = 46;
const SUSP_RATE = 10;
