/**
 * CameraRig — third-person chase camera + hood-cam (no interior).
 *
 * Chase: damped follow with velocity prediction (aims where the car is
 * GOING), rises/pulls back under acceleration, dives closer under braking,
 * swings to the outside of corners, subtle roll, FOV widens with speed,
 * never clips below the road surface.
 *
 * Hood: a low, forward-looking camera glued to the car body just above the
 * hood line — gives the "driver" feel without rendering the interior cabin
 * (which was tanking the framerate on iPad). Rides the body so suspension,
 * banking and bumps all move the view; small counter-inertia dip under
 * accel/brake and lean in corners; damped hard to avoid shake.
 *
 * The old `cockpit` mode (which rode the interior GLB's cockpitAnchor) is
 * GONE — the Interior GLB is no longer loaded, so the anchor doesn't exist.
 * The Settings 'camera' field still accepts 'chase' | 'cockpit' for
 * backwards-compatible localStorage, but 'cockpit' is silently mapped to
 * 'hood' in setMode().
 */

import * as THREE from 'three';
import { CAMERA, CAR } from './Constants.js';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';              // 'chase' | 'hood'
    this.curPos = new THREE.Vector3();
    this.curLook = new THREE.Vector3();
    this.roll = 0;
    this.fov = CAMERA.fovBase;
    this._first = true;
    this.smoothing = 1.0;             // settings multiplier
    this._t = 0;                      // shake clock
  }

  setSmoothing(mult) {
    this.smoothing = mult;
  }

  setMode(mode, car, phys) {
    // Backwards-compat: persisted 'cockpit' setting maps to 'hood' now
    // that the interior view is removed.
    if (mode === 'cockpit') mode = 'hood';
    if (mode !== 'chase' && mode !== 'hood') return;
    this.mode = mode;
    this._first = true;
    if (this.mode === 'hood') {
      this.camera.near = 0.1;
      this.camera.fov = CAMERA.hoodFov;
    } else {
      this.camera.near = 0.3;
      this.camera.fov = CAMERA.fovBase;
    }
    this.camera.updateProjectionMatrix();
    if (car && phys) this.snap(car, phys);
  }

  toggle(car, phys) {
    this.setMode(this.mode === 'chase' ? 'hood' : 'chase', car, phys);
  }

  /**
   * Jump instantly to the correct pose (race start / reset / mode switch).
   * No cockpit anchor is needed anymore — the hood cam reads only the
   * car's body position + heading.
   */
  snap(car, phys) {
    this._first = true;
    if (this.mode === 'hood') {
      this._hoodDesired(phys, this.curPos, this.curLook);
    } else {
      this._snapChase(phys);
    }
    this.apply(phys);
  }

  _snapChase(phys) {
    const fwd = _fwd.set(Math.sin(phys.heading), 0, Math.cos(phys.heading));
    const speedN = Math.min(1, Math.abs(phys.vF) / CAR.maxSpeed);
    const dist = CAMERA.distanceBase + CAMERA.distanceSpeed * speedN;
    const height = CAMERA.heightBase + CAMERA.heightSpeed * speedN;
    this.curPos.copy(phys.position).addScaledVector(fwd, -dist)
      .add(new THREE.Vector3(0, height, 0));
    this.curLook.copy(phys.position).addScaledVector(fwd, CAMERA.lookAhead)
      .add(new THREE.Vector3(0, 1.2, 0));
  }

  /** chase camera desired position + look target */
  _chaseDesired(phys, outPos, outLook) {
    const fwd = _fwd.set(Math.sin(phys.heading), 0, Math.cos(phys.heading));
    // screen-right for a viewer looking along fwd (matches Physics.rightOf —
    // the previous inverted vector swung the camera to the inside of corners)
    const right = _right.set(-fwd.z, 0, fwd.x);
    const speedN = Math.min(1, Math.abs(phys.vF) / CAR.maxSpeed);

    const dist = CAMERA.distanceBase + CAMERA.distanceSpeed * speedN;
    const height = CAMERA.heightBase + CAMERA.heightSpeed * speedN;

    // acceleration / braking reactions
    const aN = THREE.MathUtils.clamp(phys.aLongS / 9, -1, 1);
    const accelLift = Math.max(0, aN) * CAMERA.accelLift;
    const brakeDive = Math.max(0, -aN) * CAMERA.brakeDive;

    outPos.copy(phys.position)
      .addScaledVector(fwd, -dist + accelLift - brakeDive)
      .addScaledVector(right, phys.steerAngle / 0.5 * -0.5)
      .add(new THREE.Vector3(0, height, 0));

    // never sink below the road
    const minY = phys.surfaceY + 0.9;
    if (outPos.y < minY) outPos.y = minY;

    // look where the car is heading AND moving (velocity prediction)
    outLook.copy(phys.position)
      .addScaledVector(fwd, CAMERA.lookAhead)
      .addScaledVector(_tmp.copy(phys.velocity), CAMERA.velocityLead)
      .add(new THREE.Vector3(0, 1.15, 0));
  }

  /**
   * Hood camera desired position + look target.
   * Sits just above the hood line, looking forward along the heading.
   * Rides the body so suspension/banking all move the view.
   */
  _hoodDesired(phys, outPos, outLook) {
    const fwd = _fwd.set(Math.sin(phys.heading), 0, Math.cos(phys.heading));
    const right = _right.set(-fwd.z, 0, fwd.x);

    // hood position: 1.1 m forward of the CG (roughly above the windshield
    // base on a 911), 1.25 m above the road (just above the roof line for
    // a low sportscar POV)
    const HOOD_FORWARD = 1.1;
    const HOOD_HEIGHT = 1.25;

    outPos.copy(phys.position)
      .addScaledVector(fwd, HOOD_FORWARD)
      .add(new THREE.Vector3(0, HOOD_HEIGHT, 0));

    // small counter-inertia: dip under braking, rise under accel; lean
    // opposite to cornering (matches what a driver's head does)
    const aN = THREE.MathUtils.clamp(phys.aLongS / 9, -1, 1);
    outPos.y += -aN * 0.05;                // 5 cm dip under hard braking
    outPos.addScaledVector(right, phys.latAccel * 0.0022);  // tiny lean

    // look forward along the heading, with a slight bias into the steering
    // so the view previews where the car is pointing
    outLook.copy(outPos)
      .addScaledVector(fwd, CAMERA.hoodLookAhead)
      .addScaledVector(right, phys.steerAngle / 0.5 * 1.6);
    // aim slightly down the road slope
    outLook.y = outPos.y + phys.roadPitch * 8 + 0.05;
  }

  update(dt, phys, inputState, car) {
    this._t += dt;
    if (this.mode === 'hood') {
      this._updateHood(dt, phys);
    } else {
      this._updateChase(dt, phys, inputState);
    }
    this.apply(phys);
  }

  _updateChase(dt, phys, inputState) {
    this._chaseDesired(phys, _desired, _look);

    const kPos = 1 - Math.exp(-CAMERA.posDamping * this.smoothing * dt);
    const kLook = 1 - Math.exp(-CAMERA.lookDamping * this.smoothing * dt);
    if (this._first) {
      this.curPos.copy(_desired);
      this.curLook.copy(_look);
      this._first = false;
    } else {
      this.curPos.lerp(_desired, kPos);
      this.curLook.lerp(_look, kLook);
    }

    // roll: steering + lateral g influence
    const targetRoll = THREE.MathUtils.clamp(
      inputState.steer * -CAMERA.rollMax - phys.latAccel * 0.0016,
      -0.08, 0.08
    );
    this.roll = THREE.MathUtils.damp(this.roll, targetRoll, 6, dt);

    const speedN = Math.min(1, Math.abs(phys.vF) / CAR.maxSpeed);
    const targetFov = CAMERA.fovBase + CAMERA.fovSpeedBoost * Math.pow(speedN, 1.25);
    this.fov = THREE.MathUtils.damp(this.fov, targetFov, 4, dt);
  }

  _updateHood(dt, phys) {
    this._hoodDesired(phys, _desired, _look);

    // hood cam is tighter than chase — less lag, more "you are there"
    const kPos = 1 - Math.exp(-CAMERA.hoodDamping * this.smoothing * dt);
    const kLook = 1 - Math.exp(-CAMERA.hoodLookDamping * this.smoothing * dt);
    if (this._first) {
      this.curPos.copy(_desired);
      this.curLook.copy(_look);
      this._first = false;
    } else {
      this.curPos.lerp(_desired, kPos);
      this.curLook.lerp(_look, kLook);
    }

    // roll with the car (bank + body roll, damped hard)
    const targetRoll = phys.roadRoll * 0.6 +
      THREE.MathUtils.clamp(-phys.latAccel * 0.0008, -0.025, 0.025);
    this.roll = THREE.MathUtils.damp(this.roll, targetRoll, 6, dt);

    // hood FOV widens with speed (slightly less than chase to avoid nausea)
    const speedN = Math.min(1, Math.abs(phys.vF) / CAR.maxSpeed);
    this.fov = CAMERA.hoodFov + CAMERA.hoodFovBoost * Math.pow(speedN, 1.2);
  }

  apply(phys) {
    this.camera.position.copy(this.curPos);

    // high-speed shake: smooth pseudo-noise, scales with speed²
    const sN = Math.min(1, Math.abs(phys.vF) / CAR.maxSpeed);
    const amp = this.mode === 'chase'
      ? CAMERA.chaseShake * Math.pow(sN, 2.2)
      : CAMERA.hoodShake * (0.25 + Math.pow(sN, 2));
    if (amp > 0.0005) {
      const t = this._t;
      this.camera.position.x +=
        (Math.sin(t * 31.7) * 0.55 + Math.sin(t * 47.3) * 0.3 + Math.sin(t * 13.1) * 0.15) * amp;
      this.camera.position.y +=
        (Math.sin(t * 39.1 + 1.7) * 0.5 + Math.sin(t * 53.7) * 0.3) * amp * 0.7;
    }

    this.camera.lookAt(this.curLook);
    this.camera.rotateZ(this.roll);
    if (Math.abs(this.camera.fov - this.fov) > 0.02) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
