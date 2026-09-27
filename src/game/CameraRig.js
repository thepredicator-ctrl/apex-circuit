/**
 * CameraRig — drift-aware chase camera.
 *
 * The camera anchors behind the CAR but looks along a blend of heading and
 * velocity, so the drift angle reads clearly on a small screen. FOV widens
 * with speed, portrait screens get a wider default, collisions add a short
 * shake, and three modes (chase / far / hood) cycle with a button.
 */
import * as THREE from 'three';
import { Settings } from '../core/Settings.js';

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = Settings.get('cam') || 'chase';
    this.shake = 0;
    this._pos = new THREE.Vector3(0, 4, -10);
    this._look = new THREE.Vector3();
    this._init = false;
    this._vDir = new THREE.Vector3(0, 0, 1);
    this._fov = camera.fov; // smoothed speed-FOV (no visible zoom pumping)
  }

  cycleMode() {
    this.mode = this.mode === 'chase' ? 'far' : this.mode === 'far' ? 'hood' : 'chase';
    Settings.set('cam', this.mode);
  }

  addShake(amount) {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  /** Portrait phones need a wider view. */
  aspectChanged(aspect) {
    this._portrait = aspect < 0.9;
  }

  update(dt, phys, crashed) {
    const p = this.camera.position;

    // velocity direction (smoothed) — shows the drift on screen. At crawl
    // speeds it follows the heading so the camera never skews off-center
    // right after spawning.
    const fx0 = Math.sin(phys.heading), fz0 = Math.cos(phys.heading);
    if (phys.speed > 2) {
      const vx = phys.vxW / phys.speed, vz = phys.vzW / phys.speed;
      this._vDir.x += (vx - this._vDir.x) * Math.min(1, dt * 3);
      this._vDir.z += (vz - this._vDir.z) * Math.min(1, dt * 3);
      this._vDir.normalize();
    } else {
      this._vDir.x += (fx0 - this._vDir.x) * Math.min(1, dt * 4);
      this._vDir.z += (fz0 - this._vDir.z) * Math.min(1, dt * 4);
      this._vDir.normalize();
    }

    const fx = fx0, fz = fz0;
    let dist = 7.8, height = 3.1, fovBase = 62;
    if (this.mode === 'far') { dist = 11.5; height = 4.6; fovBase = 58; }
    if (this.mode === 'hood') { dist = -0.4; height = 1.15; fovBase = 70; }
    if (this._portrait) { dist += 0.7; height += 0.3; fovBase += 9; }

    // desired position: behind the car, biased toward the slide direction
    const bias = this._portrait ? 0.22 : 0.32;
    const bx = fx + this._vDir.x * bias;
    const bz = fz + this._vDir.z * bias;
    const bl = Math.hypot(bx, bz) || 1;
    const dx = phys.x - (bx / bl) * dist;
    const dz = phys.z - (bz / bl) * dist;
    const dy = height;

    if (!this._init) {
      this._pos.set(dx, dy, dz);
      this._init = true;
    }
    const k = 1 - Math.exp(-dt * (this.mode === 'hood' ? 14 : 5.2));
    this._pos.x += (dx - this._pos.x) * k;
    this._pos.y += (dy - this._pos.y) * k;
    this._pos.z += (dz - this._pos.z) * k;

    // look target: ahead of the car along velocity (higher in portrait so
    // the car stays comfortably in frame on tall screens)
    const lookY = this._portrait ? 1.7 : 1.15;
    const lead = this.mode === 'hood' ? 6 : 4.5;
    this._look.set(
      phys.x + this._vDir.x * lead + fx * (this.mode === 'hood' ? 4 : 0),
      lookY,
      phys.z + this._vDir.z * lead + fz * (this.mode === 'hood' ? 4 : 0),
    );

    // shake on impacts
    let sx = 0, sy = 0;
    if (this.shake > 0.01) {
      this.shake *= Math.exp(-dt * 5);
      sx = (Math.random() - 0.5) * this.shake * 0.55;
      sy = (Math.random() - 0.5) * this.shake * 0.4;
    }

    if (crashed) this.addShake(Math.min(0.8, crashed * 0.08));

    p.set(this._pos.x + sx, this._pos.y + sy, this._pos.z);
    this.camera.lookAt(this._look);

    // speed FOV — gently widened with speed (halved range + smoothed so
    // slowing down never reads as an unwanted zoom-in)
    const speedNorm = Math.min(1, phys.speed / T_MAX);
    this._fov += (fovBase + speedNorm * 9 - this._fov) * Math.min(1, dt * 3.5);
    if (Math.abs(this._fov - this.camera.fov) > 0.05) {
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

const T_MAX = 52; // m/s — speed at which FOV tops out
