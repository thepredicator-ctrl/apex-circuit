/**
 * CameraRig — third-person chase camera + first-person cockpit camera.
 *
 * Chase: damped follow with velocity prediction (aims where the car is
 * GOING), rises/pulls back under acceleration, dives closer under braking,
 * swings to the outside of corners, subtle roll, FOV widens with speed,
 * never clips below the road surface.
 *
 * Cockpit: rides the car's body (so suspension, banking and bumps all move
 * the head), with a small counter-inertia dip under accel/brake and lean in
 * corners. Damped hard to avoid shake.
 */

import * as THREE from 'three';
import { CAMERA, CAR } from './Constants.js';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _world = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';              // 'chase' | 'cockpit'
    this.curPos = new THREE.Vector3();
    this.curLook = new THREE.Vector3();
    this.roll = 0;
    this.fov = CAMERA.fovBase;
    this._headOffset = new THREE.Vector3(); // cockpit head inertia offset
    this._first = true;
    this.smoothing = 1.0;             // settings multiplier
  }

  setSmoothing(mult) {
    this.smoothing = mult;
  }

  setMode(mode, car, phys) {
    if (mode !== 'chase' && mode !== 'cockpit') return;
    this.mode = mode;
    this._first = true;
    if (this.mode === 'cockpit') {
      this.camera.near = 0.06;
      this.camera.fov = CAMERA.cockpitFov;
    } else {
      this.camera.near = 0.3;
      this.camera.fov = CAMERA.fovBase;
    }
    this.camera.updateProjectionMatrix();
    if (car && phys) this.snap(car, phys);
  }

  toggle(car, phys) {
    this.setMode(this.mode === 'chase' ? 'cockpit' : 'chase', car, phys);
  }

  /** Jump instantly to the correct pose (race start / reset / mode switch). */
  snap(car, phys) {
    this._first = true;
    if (this.mode === 'cockpit') {
      car.cockpitAnchor.getWorldPosition(this.curPos);
      const fwd = _fwd.set(Math.sin(phys.heading), 0, Math.cos(phys.heading));
      this.curLook.copy(this.curPos).addScaledVector(fwd, CAMERA.cockpitLookAhead);
    } else {
      this._chaseDesired(phys, _tmp, _tmp);
      // recompute properly (desired + look)
      this._snapChase(phys);
    }
    this.apply(phys, null);
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

  update(dt, phys, inputState, car) {
    if (this.mode === 'cockpit') {
      this._updateCockpit(dt, phys, car);
    } else {
      this._updateChase(dt, phys, inputState);
    }
    this.apply(phys, car);
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
    const targetFov = CAMERA.fovBase + CAMERA.fovSpeedBoost * speedN;
    this.fov = THREE.MathUtils.damp(this.fov, targetFov, 4, dt);
  }

  _updateCockpit(dt, phys, car) {
    // eye position rides the body (suspension, bank, bumps)
    car.cockpitAnchor.getWorldPosition(_world);
    // counter-inertia: head dips opposite to accel, leans opposite to cornering
    const fwd = _fwd.set(Math.sin(phys.heading), 0, Math.cos(phys.heading));
    const right = _right.set(-fwd.z, 0, fwd.x);   // screen-right (matches Physics)
    _tmp.copy(_world)
      .addScaledVector(fwd, -phys.aLongS * CAMERA.cockpitAccelDip)
      .addScaledVector(right, phys.latAccel * 0.0022);

    const k = 1 - Math.exp(-CAMERA.cockpitDamping * this.smoothing * dt);
    if (this._first) {
      this.curPos.copy(_tmp);
      this._first = false;
    } else {
      this.curPos.lerp(_tmp, k);
    }

    // look ahead along the heading, slightly into the steering
    _look.copy(this.curPos).addScaledVector(fwd, CAMERA.cockpitLookAhead)
      .addScaledVector(right, phys.steerAngle / 0.5 * 2.2);
    _look.y = this.curPos.y + phys.roadPitch * 12 + 0.1;

    this.curLook.lerp(_look, Math.min(1, dt * 12));

    // roll with the car (bank + body roll, damped hard)
    const targetRoll = phys.roadRoll * CAMERA.cockpitRollInfluence +
      THREE.MathUtils.clamp(-phys.latAccel * 0.001, -0.03, 0.03);
    this.roll = THREE.MathUtils.damp(this.roll, targetRoll, 6, dt);

    this.fov = CAMERA.cockpitFov;
  }

  apply(phys, car) {
    this.camera.position.copy(this.curPos);
    this.camera.lookAt(this.curLook);
    this.camera.rotateZ(this.roll);
    if (Math.abs(this.camera.fov - this.fov) > 0.02) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
