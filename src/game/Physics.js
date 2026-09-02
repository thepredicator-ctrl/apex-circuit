/**
 * Vehicle physics — arcade/sim hybrid.
 *
 * Longitudinal: real engine torque flows through the Transmission (gear
 * ratios, final drive, clutch, rev limiter). Drive force is applied at the
 * rear axle and capped by rear traction; excess spins the wheels.
 *
 * Lateral: per-axle grip = mu * axle load. Longitudinal load transfer
 * (accel/brake), lateral load transfer (cornering), aerodynamic downforce
 * and surface type all shift axle loads, so braking deep into a corner
 * loosens the rear, power loosens it under throttle, and the handbrake
 * unglues it completely. When the demanded lateral force exceeds what the
 * tires can give, the surplus survives as slide velocity — controllable
 * drifting with counter-steer.
 *
 * Vertical: the track provides surface height (rolling hills + banking).
 * The body rides the surface; per-wheel suspension compression targets are
 * computed here and animated by Car with spring/damper smoothing.
 */

import * as THREE from 'three';
import { CAR, TRACK } from './Constants.js';

const _fwd0 = new THREE.Vector3();
const _right0 = new THREE.Vector3();
const _fwd1 = new THREE.Vector3();
const _right1 = new THREE.Vector3();
const _vel = new THREE.Vector3();

// right = forward x up (matches the on-screen camera convention)
function rightOf(fwd, out) {
  return out.set(-fwd.z, 0, fwd.x);
}

const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;

export class VehiclePhysics {
  constructor(track, transmission) {
    this.track = track;
    this.trans = transmission;

    this.position = new THREE.Vector3();
    this.heading = 0;            // rad, 0 = +Z, forward = (sin h, 0, cos h)
    this.velocity = new THREE.Vector3();

    // telemetry
    this.vF = 0;                 // forward speed (m/s, signed)
    this.vL = 0;                 // lateral speed (m/s, + = sliding toward car-right)
    this.slip = 0;               // |lateral speed| — drives smoke & screech
    this.latAccel = 0;           // smoothed lateral accel — drives body roll
    this.aLongS = 0;             // smoothed longitudinal accel (m/s^2)
    this.steerAngle = 0;         // visual front wheel angle (rad)
    this.throttleOut = 0;
    this.brakeOut = 0;
    this.reversing = false;
    this.wheelspin = false;      // rear traction exceeded this step
    this.engineForce = 0;        // post-traction-cap drive force (telemetry)

    // surface telemetry
    this.sampleIdx = 0;
    this.s = 0;                  // progress 0..1 around the circuit
    this.lateral = 0;            // signed distance from centerline (+ = right)
    this.onGrass = false;
    this.onCurb = false;
    this.onRoad = true;
    this.surfaceY = 0;           // road height under the car (incl. banking)
    this.roadPitch = 0;          // surface slope under the car (rad, + = uphill)
    this.roadRoll = 0;           // bank tilt in the car frame (rad, + = right low)

    // per-wheel suspension compression targets (0..1), FL FR RL RR
    this.susp = [0.5, 0.5, 0.5, 0.5];
    this._suspSmooth = [0.5, 0.5, 0.5, 0.5];
    this._bumpPhase = 0;

    this._yaw = 0;
    this.justHitWall = false;    // one-frame flag for effects/audio
    this._time = 0;
  }

  /** Place the car at track progress s (0..1), `lateralOffset` meters right of center. */
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
    this._yaw = 0;
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

  /** Compute surface height + attitude under the car from a located sample. */
  _applySurface(loc) {
    const surf = this.track.surfaceAt(loc.idx, this.lateral);
    this.surfaceY = surf.y;
    // project track-frame slope/bank into the car frame
    const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
    const along = fwdX * loc.tanX + fwdZ * loc.tanZ;      // ~1 when pointing down the track
    const across = fwdX * loc.rightX + fwdZ * loc.rightZ; // ~1 when pointing across
    this.roadPitch = Math.atan(surf.slope * along);
    this.roadRoll = Math.atan(surf.bankSlope) * across;
  }

  /**
   * Advance one physics sub-step.
   * @param {number} dt      sub-step delta (e.g. 1/120)
   * @param {Input}  input   input provider with `.state`
   * @param {boolean} controlsActive  false during countdown / after finish
   */
  update(dt, input, controlsActive) {
    this.justHitWall = false;
    this._time += dt;

    const throttle = controlsActive ? input.state.throttle : 0;
    const driverBrake = controlsActive ? input.state.brake : 0;
    const holdStill = !controlsActive;
    const steer = controlsActive ? input.state.steer : 0;
    const handbrake = controlsActive && input.state.handbrake;
    this.throttleOut = throttle;
    this.brakeOut = driverBrake;

    // --- current frame ---------------------------------------------------
    _fwd0.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    rightOf(_fwd0, _right0);

    // --- decompose ---------------------------------------------------------
    let vF = this.velocity.dot(_fwd0);
    let vL0 = this.velocity.dot(_right0);
    const vF0 = vF;   // speed at step start — used for the acceleration estimate

    // --- surface lookup -----------------------------------------------------
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

    // --- transmission ----------------------------------------------------------
    this.trans.update(dt, {
      wheelSpeed: vF,
      throttle,
      brake: driverBrake,
      controlsActive
    });

    // --- axle loads (weight transfer + downforce) -----------------------------
    const m = CAR.mass;
    const g = 9.81;
    const vAbs = Math.abs(vF);
    const df = CAR.downforce * vF * vF;              // downforce N
    const staticF = m * g * CAR.weightDistFront;
    const staticR = m * g * (1 - CAR.weightDistFront);
    // aLongS from last step drives the transfer (stable one-step lag)
    const longXfer = m * this.aLongS * CAR.cgHeight / CAR.wheelbase;
    const loadF = Math.max(m * g * 0.18, staticF - longXfer + df * 0.45);
    const loadR = Math.max(m * g * 0.18, staticR + longXfer + df * 0.55);

    // --- per-axle mu -----------------------------------------------------------
    const muBase = this.onGrass ? CAR.gripGrass : CAR.gripAsphalt;
    let muF = muBase;
    let muR = muBase;
    // traction loss at high steering angle + speed (front washout)
    if (Math.abs(steer) > 0.85 && vAbs > 24) muF *= CAR.highSteerGripFactor;
    // power oversteer: hard throttle mid-corner loosens the rear
    if (throttle > 0.85 && Math.abs(steer) > 0.55 && vAbs > 13) muR *= CAR.powerOversteerFactor;
    if (handbrake) muR *= CAR.handbrakeRearGrip;
    if (this.onGrass) { muF *= 0.8; muR *= 0.8; }

    const gripFront = muF * loadF / m;   // m/s^2 the front axle can support
    const gripRear = muR * loadR / m;
    // Total lateral capability of the CAR (both axles share the cornering
    // force): mu * effective gravity incl. downforce. Using only the weaker
    // axle here would halve real grip and cause massive understeer.
    const gEff = g + (CAR.downforce * vF * vF) / m;
    const lateralCap = Math.min(muF, muR) * gEff;
    // Yaw authority stays at NOMINAL grip: a slide happens because the body
    // rotates faster than the (degraded) tires can follow — limiting yaw by
    // the degraded grip would make handbrake drifts impossible.
    const yawGrip = (this.onGrass ? CAR.gripGrass : CAR.gripAsphalt) * gEff;

    // --- longitudinal: drive force with rear traction cap -----------------------
    let driveF = this.trans.driveForce;   // N, signed
    const muLong = muBase * 1.05;
    const rearTractionMax = muLong * loadR;   // N
    this.wheelspin = false;
    if (driveF > rearTractionMax) {
      driveF = rearTractionMax * (0.94 + 0.06 * Math.sin(this._time * 30));
      this.wheelspin = true;
      this.trans.wheelspin = true;
    } else if (driveF < -rearTractionMax * 0.9) {
      driveF = -rearTractionMax * 0.9;
      this.wheelspin = true;
      this.trans.wheelspin = true;
    }
    this.engineForce = driveF / m; // m/s^2 (telemetry)

    // --- brakes (traction-limited; in auto+R the brake pedal is reverse) --------
    const brakeDrivesReverse = this.trans.mode === 'auto' && this.trans.gear === -1;
    let brakeF = 0;
    if (driverBrake > 0 && vF > 0.4) {
      const capTotal = muLong * (loadF + loadR) / m;
      brakeF = Math.min(CAR.brakeDecel * driverBrake, capTotal);
    } else if (driverBrake > 0 && vF < -0.4 && !brakeDrivesReverse) {
      // braking while rolling backwards (manual mode)
      const capTotal = muLong * (loadF + loadR) / m;
      brakeF = Math.min(CAR.brakeDecel * driverBrake, capTotal);
    }
    if (handbrake && vAbs > 0.3) {
      brakeF = Math.max(brakeF, muLong * loadR / m * 0.75);
    }
    // parking brake outside racing states
    if (holdStill) brakeF = Math.max(brakeF, 14);

    // --- longitudinal integration ------------------------------------------------
    vF += driveF / m * dt;
    if (brakeF > 0) {
      const dv = brakeF * dt;
      if (Math.abs(vF) <= dv) {
        if (!this.trans.launching && this.trans.gear >= 0) vF = 0;
        else vF = Math.sign(vF) * Math.max(0, Math.abs(vF) - dv);
      } else {
        vF -= Math.sign(vF) * dv;
      }
    }

    // rolling resistance + quadratic air drag
    const rollRes = CAR.rollingResistance * g * (this.onGrass ? 3.2 : 1) / 9.81; // m/s^2
    if (vAbs > 0.0001) {
      const drag = CAR.airDrag * vF * vAbs + rollRes * Math.min(1, vAbs / 0.5) * Math.sign(vF);
      vF -= drag * dt;
      if (this.onGrass) vF -= CAR.grassDrag * dt * Math.sign(vF) * Math.min(1, vAbs / 2);
      if (vAbs < 0.02 && throttle === 0 && driverBrake === 0 && !holdStill) vF = 0;
    }
    // reverse speed limiter
    if (this.trans.gear === -1 && vF < -CAR.maxReverseSpeed) vF = -CAR.maxReverseSpeed;

    // --- steering / yaw ------------------------------------------------------------
    // commanded yaw is limited by the car's grip circle (kinematic: a = v·ω)
    const speedSteerFade = Math.min(1, vAbs / CAR.minSteerSpeed);
    const yawKinematic = yawGrip * CAR.yawGripMultiplier / Math.max(vAbs, 5);
    const maxYaw = Math.min(CAR.maxYawLowSpeed, yawKinematic) *
      (this.onGrass ? 0.72 : 1) * (handbrake ? 1.3 : 1);

    // NOTE: with fwd = (sin h, 0, cos h), increasing h rotates the car LEFT,
    // so a positive steer input (right) needs a negative heading change.
    const targetYaw = -steer * maxYaw * speedSteerFade * (vF < 0 ? -1 : 1);
    const yaw = damp(this._yaw, targetYaw, CAR.yawDamping, dt);
    this._yaw = yaw;
    this.heading += yaw * dt;

    // --- re-decompose in the rotated frame (this builds the slide) ------------
    _fwd1.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    rightOf(_fwd1, _right1);
    _vel.copy(_fwd0).multiplyScalar(vF).addScaledVector(_right0, vL0);

    let nF = _vel.dot(_fwd1);
    let nL = _vel.dot(_right1);

    // --- lateral grip ----------------------------------------------------------
    // Coulomb-limited decay: at most the tire cap of lateral correction…
    nL -= Math.sign(nL) * Math.min(Math.abs(nL), lateralCap * dt);
    // …plus a small exponential settle so slides do not linger forever
    nL *= Math.exp(-CAR.lateralDamp * dt);

    // banking pulls the car gently toward the low side of the corners
    nL += 9.81 * Math.sin(this.roadRoll) * dt * 0.9;

    // --- recompose & integrate ---------------------------------------------------
    this.velocity.copy(_fwd1).multiplyScalar(nF).addScaledVector(_right1, nL);
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    const aLong = dt > 0 ? (nF - vF0) / dt : 0;
    vF = nF;
    this.vF = nF;
    this.vL = nL;
    this.slip = Math.abs(nL);
    this.reversing = nF < -0.5;

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
      }
      this.vF = this.velocity.dot(_fwd1);
      this.vL = this.velocity.dot(_right1);
    }

    // --- post telemetry ---------------------------------------------------------------
    const loc2 = this.track.locate(this.position.x, this.position.z, this.sampleIdx);
    this.sampleIdx = loc2.idx;
    this.s = loc2.s;
    this.lateral = loc2.lateral;
    this._applySurface(loc2);
    this.position.y = damp(this.position.y, this.surfaceY, 14, dt);

    this.latAccel = damp(this.latAccel, this._yaw * Math.abs(this.vF), 6, dt);
    this.aLongS = damp(this.aLongS, aLong, 5, dt);

    // visual front wheel angle
    this.steerAngle = steer * THREE.MathUtils.lerp(0.5, 0.15, Math.min(1, vAbs / 45));

    // --- suspension targets ------------------------------------------------------------
    this._updateSuspensionTargets(dt, loc2);
  }

  _updateSuspensionTargets(dt, loc) {
    const longF = clamp(this.aLongS / 11, -1, 1);          // + = accelerating
    const leanR = clamp(this._yaw * Math.abs(this.vF) / 11, -1, 1); // + = turning left
    const base = 0.5;

    let fl = base - longF * 0.42 - leanR * 0.4;
    let fr = base - longF * 0.42 + leanR * 0.4;
    let rl = base + longF * 0.42 - leanR * 0.4;
    let rr = base + longF * 0.42 + leanR * 0.4;

    // curb / bump excitation — alternate knock per wheel pair
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

  /** smoothed suspension compression (0..1) per wheel — read by Car */
  get suspSmooth() {
    return this._suspSmooth;
  }

  get speedKmh() {
    return Math.abs(this.vF) * 3.6;
  }
}

const SUSPENSION_FREQ = 46;
const SUSP_RATE = 10;
