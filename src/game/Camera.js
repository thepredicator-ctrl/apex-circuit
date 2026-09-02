/**
 * ChaseCamera — smooth third-person chase camera.
 *
 * - exponentially damped follow (frame-rate independent, no jitter)
 * - pulls back and rises slightly with speed, widens FOV for a sense of pace
 * - swings a little to the outside of turns and rolls a few degrees
 * - look target sits ahead of the car so you can see the road
 */

import * as THREE from 'three';
import { CAMERA, CAR } from './Constants.js';

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.curPos = new THREE.Vector3();
    this.curLook = new THREE.Vector3();
    this.roll = 0;
    this.fov = CAMERA.fovBase;
    this._first = true;
  }

  /** Jump instantly behind the car (used on race start / reset). */
  snapBehind(phys) {
    const fwd = new THREE.Vector3(Math.sin(phys.heading), 0, Math.cos(phys.heading));
    this.curPos.copy(phys.position).addScaledVector(fwd, -CAMERA.distanceBase)
      .add(new THREE.Vector3(0, CAMERA.heightBase, 0));
    this.curLook.copy(phys.position).addScaledVector(fwd, CAMERA.lookAhead)
      .add(new THREE.Vector3(0, 1.2, 0));
    this._first = true;
    this.apply();
  }

  /**
   * @param {number} dt
   * @param {VehiclePhysics} phys
   * @param {{steer:number}} inputState
   */
  update(dt, phys, inputState) {
    const speedN = Math.min(1, Math.abs(phys.vF) / CAR.maxSpeed);
    const fwd = new THREE.Vector3(Math.sin(phys.heading), 0, Math.cos(phys.heading));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);

    const dist = CAMERA.distanceBase + CAMERA.distanceSpeed * speedN;
    const height = CAMERA.heightBase + CAMERA.heightSpeed * speedN;

    const desired = phys.position.clone()
      .addScaledVector(fwd, -dist)
      .addScaledVector(right, inputState.steer * -0.45)
      .add(new THREE.Vector3(0, height, 0));
    desired.y = Math.max(desired.y, 1.2);

    const look = phys.position.clone()
      .addScaledVector(fwd, CAMERA.lookAhead)
      .add(new THREE.Vector3(0, 1.2, 0));

    if (this._first) {
      this.curPos.copy(desired);
      this.curLook.copy(look);
      this._first = false;
    } else {
      const kPos = 1 - Math.exp(-CAMERA.posDamping * dt);
      const kLook = 1 - Math.exp(-CAMERA.lookDamping * dt);
      this.curPos.lerp(desired, kPos);
      this.curLook.lerp(look, kLook);
    }

    // roll & fov
    const targetRoll = THREE.MathUtils.clamp(
      inputState.steer * -CAMERA.rollMax - phys.latAccel * 0.0012,
      -0.07, 0.07
    );
    this.roll = THREE.MathUtils.damp(this.roll, targetRoll, 6, dt);
    const targetFov = CAMERA.fovBase + CAMERA.fovSpeedBoost * speedN;
    this.fov = THREE.MathUtils.damp(this.fov, targetFov, 4, dt);

    this.apply();
  }

  apply() {
    this.camera.position.copy(this.curPos);
    this.camera.lookAt(this.curLook);
    this.camera.rotateZ(this.roll);
    if (Math.abs(this.camera.fov - this.fov) > 0.02) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
