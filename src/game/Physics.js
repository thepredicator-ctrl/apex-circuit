/**
 * Arcade vehicle physics.
 *
 * Model summary:
 *  - The car body yaw is driven directly by steering (speed-dependent yaw rate,
 *    smoothed for weight/inertia feel).
 *  - World velocity is re-decomposed into the car frame every sub-step; the
 *    lateral component is pulled toward zero by a grip force limited to
 *    `grip` m/s^2. When the required lateral force exceeds grip (handbrake,
 *    full lock at speed, grass), the excess survives as slide velocity,
 *    which produces controllable drifting with counter-steer.
 *  - Longitudinal forces: engine (tapered power curve), brakes, reverse,
 *    rolling resistance, quadratic air drag, surface drag.
 *  - Track interaction: surface lookup (asphalt / curb / grass) from the
 *    track centerline samples + soft wall collision.
 */

import * as THREE from 'three';
import { CAR, TRACK, gearForSpeed, rpmNormForSpeed } from './Constants.js';

const _fwd0 = new THREE.Vector3();
const _right0 = new THREE.Vector3();
const _fwd1 = new THREE.Vector3();
const _right1 = new THREE.Vector3();
const _vel = new THREE.Vector3();

// right = forward x up (matches the on-screen camera convention:
// what appears to the right of the screen when the camera looks
// along the car's forward axis)
function rightOf(fwd, out) {
  return out.set(-fwd.z, 0, fwd.x);
}

export class VehiclePhysics {
  constructor(track) {
    this.track = track;

    this.position = new THREE.Vector3();
    this.heading = 0;            // rad, 0 = +Z, forward = (sin h, 0, cos h)
    this.velocity = new THREE.Vector3();

    // telemetry
    this.vF = 0;                 // forward speed (m/s, signed)
    this.vL = 0;                 // lateral speed (m/s, + = sliding toward car-right)
    this.slip = 0;               // |lateral speed| — drives smoke & screech
    this.latAccel = 0;           // smoothed lateral accel — drives body roll
    this.steerAngle = 0;         // visual front wheel angle (rad)
    this.gear = 1;
    this.rpmNorm = 0;
    this.throttleOut = 0;
    this.brakeOut = 0;
    this.reversing = false;

    // surface telemetry
    this.sampleIdx = 0;
    this.s = 0;                  // progress 0..1 around the circuit
    this.lateral = 0;            // signed distance from centerline (+ = right)
    this.onGrass = false;
    this.onCurb = false;
    this.onRoad = true;

    this._yaw = 0;
    this.justHitWall = false;    // one-frame flag for effects/audio
  }

  /** Place the car at track progress s (0..1), `lateralOffset` meters right of center. */
  placeAt(s, lateralOffset = 0) {
    const p = this.track.pointAt(s);
    const tan = this.track.tangentAt(s);
    this.position.set(p.x, 0, p.z);
    // right of travel = ( -tan.z, 0, tan.x )
    this.position.x += -tan.z * lateralOffset;
    this.position.z += tan.x * lateralOffset;
    this.heading = Math.atan2(tan.x, tan.z);
    this.velocity.set(0, 0, 0);
    this.vF = 0;
    this.vL = 0;
    this.slip = 0;
    this.latAccel = 0;
    this._yaw = 0;
    const loc = this.track.locate(this.position.x, this.position.z, null);
    this.sampleIdx = loc.idx;
    this.s = loc.s;
    this.lateral = loc.lateral;
    this.onGrass = false;
    this.onCurb = false;
    this.onRoad = true;
  }

  /**
   * Advance one physics sub-step.
   * @param {number} dt      sub-step delta (small, e.g. 1/120)
   * @param {Input}  input   input provider with `.state`
   * @param {boolean} controlsActive  false during countdown / after finish
   */
  update(dt, input, controlsActive) {
    this.justHitWall = false;

    const throttle = controlsActive ? input.state.throttle : 0;
    // outside racing states a virtual parking brake holds the car
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

    // --- longitudinal forces --------------------------------------------------
    const surfaceEngine = this.onGrass ? CAR.grassEngineFactor : 1;
    if (throttle > 0) {
      const taper = Math.max(0, 1 - Math.pow(Math.max(vF, 0) / CAR.maxSpeed, CAR.engineTaper));
      vF += CAR.engineAccel * throttle * taper * surfaceEngine * dt;
    }

    if (driverBrake > 0) {
      if (vF > 0.4) {
        vF = Math.max(0, vF - CAR.brakeDecel * driverBrake * dt);
      } else if (vF > -CAR.maxReverseSpeed) {
        // reverse gear
        vF = Math.max(-CAR.maxReverseSpeed, vF - CAR.reverseAccel * driverBrake * dt);
      }
    } else if (holdStill) {
      // parking brake: pull to a stop, never creep into reverse
      vF -= Math.sign(vF) * Math.min(Math.abs(vF), 14 * dt);
    }

    // rolling resistance + quadratic air drag
    const rollRes = CAR.rollingResistance * (this.onGrass ? 3.2 : 1);
    const vAbs = Math.abs(vF);
    if (vAbs > 0.0001) {
      const drag = CAR.airDrag * vF * vAbs + rollRes * Math.min(1, vAbs / 0.5) * Math.sign(vF);
      vF -= drag * dt;
      if (this.onGrass) vF -= CAR.grassDrag * dt * Math.sign(vF) * Math.min(1, vAbs / 2);
      if (handbrake) vF -= 7 * dt * Math.sign(vF) * Math.min(1, vAbs / 2);
      if (vAbs < 0.02 && throttle === 0 && driverBrake === 0 && !holdStill) vF = 0;
    }

    // --- steering / yaw -----------------------------------------------------
    let grip = this.onGrass ? CAR.gripGrass : CAR.gripAsphalt;
    if (handbrake) {
      grip *= CAR.handbrakeGripFactor;
    } else {
      // traction loss at high steering angle + speed
      if (Math.abs(steer) > 0.85 && Math.abs(vF) > 24) grip *= CAR.highSteerGripFactor;
      // gentle power oversteer
      if (throttle > 0.9 && Math.abs(steer) > 0.6 && Math.abs(vF) > 15) grip *= CAR.powerOversteerFactor;
    }

    const speedSteerFade = Math.min(1, Math.abs(vF) / CAR.minSteerSpeed);
    const maxYaw = Math.min(
      CAR.maxYawLowSpeed,
      (grip * CAR.yawGripMultiplier) / Math.max(Math.abs(vF), 6)
    ) * (this.onGrass ? 0.72 : 1) * (handbrake ? 1.35 : 1);

    // NOTE: with fwd = (sin h, 0, cos h), increasing h rotates the car to
    // the LEFT on screen, so a positive steer input (right) needs a
    // negative heading change.
    const targetYaw = -steer * maxYaw * speedSteerFade * (vF < 0 ? -1 : 1);
    const yaw = THREE.MathUtils.damp(this._yaw, targetYaw, 8, dt);
    this._yaw = yaw;
    this.heading += yaw * dt;

    // --- re-decompose in the rotated frame (this builds the slide) ------------
    _fwd1.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    rightOf(_fwd1, _right1);
    _vel.copy(_fwd0).multiplyScalar(vF).addScaledVector(_right0, vL0);

    let nF = _vel.dot(_fwd1);
    let nL = _vel.dot(_right1);

    // --- lateral grip ----------------------------------------------------------
    // Coulomb-limited decay: at most `grip` m/s^2 of lateral correction…
    nL -= Math.sign(nL) * Math.min(Math.abs(nL), grip * dt);
    // …plus a small exponential settle so slides do not linger forever
    nL *= Math.exp(-CAR.lateralDamp * dt);

    // --- recompose & integrate ---------------------------------------------------
    this.velocity.copy(_fwd1).multiplyScalar(nF).addScaledVector(_right1, nL);
    this.position.addScaledVector(this.velocity, dt);

    this.vF = nF;
    this.vL = nL;
    this.slip = Math.abs(nL);
    this.reversing = nF < -0.5;

    // --- soft wall collision -------------------------------------------------------
    // IMPORTANT: push back along the TRACK normal (loc.rightX/Z), not the car's
    // own right vector — the two differ once the car spins relative to the road,
    // and using the car frame here would feed an explosion.
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
        // moving outward: reflect the normal component with damping
        const impact = Math.abs(vNormal);
        this.velocity.x -= rX * vNormal * (1 + CAR.wallBounce);
        this.velocity.z -= rZ * vNormal * (1 + CAR.wallBounce);
        // scrub speed only on real impacts — gentle contact lets the car
        // slide along the wall instead of sticking to it
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

    this.gear = this.reversing ? -1 : gearForSpeed(Math.abs(this.vF));
    this.rpmNorm = rpmNormForSpeed(Math.abs(this.vF));
    if (Math.abs(this.vF) < 0.6 && throttle > 0) {
      // revving at standstill (also gives the countdown some drama)
      this.rpmNorm = Math.max(this.rpmNorm, 0.35 + throttle * 0.45);
    }

    this.latAccel = THREE.MathUtils.damp(this.latAccel, yaw * Math.abs(nF), 6, dt);

    // visual front wheel angle
    this.steerAngle = steer * THREE.MathUtils.lerp(0.52, 0.16, Math.min(1, Math.abs(nF) / 45));
  }

  get speedKmh() {
    return Math.abs(this.vF) * 3.6;
  }
}
