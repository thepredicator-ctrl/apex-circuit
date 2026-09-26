/**
 * Car — visual layer for the drift physics body.
 *
 * Loads the kept cartoon_sports_car.glb asset (with a procedural low-poly
 * fallback if it fails), normalizes it to nose=+Z / length 4.35 m, and rigs
 * the four 'node_brakes' wheel roots onto susp → steer → spin pivot chains
 * under an unsprung group while the sprung body handles roll/pitch.
 *
 * Also owns drift presentation: front-wheel steer visuals, body roll,
 * brake-light emissive, and two rear skidmark trail emitters.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TUNE } from './DriftPhysics.js';

const TARGET_LENGTH = 4.35;

export class Car {
  constructor() {
    this.group = new THREE.Group();   // unsprung frame (position + yaw)
    this.body = new THREE.Group();    // sprung body (roll/pitch/bounce)
    this.group.add(this.body);
    this.wheels = [];
    this.wheelRadius = TUNE.wheelRadius ?? 0.33;
    this.mats = { paint: null, tail: null };
    this.ready = false;
    this.modelSource = 'none';
    this._spin = 0;
    this._steerVis = 0;

    this.skid = { FL: null, FR: null, RL: null, RR: null };
  }

  /** GLB URL relative to base (works from any static host subpath). */
  static modelURL() {
    return new URL('models/cartoon_sports_car.glb', document.baseURI).href;
  }

  build(onProgress) {
    return new Promise((resolve) => {
      const loader = new GLTFLoader();
      loader.load(Car.modelURL(),
        (gltf) => {
          try {
            this._buildFromGLTF(gltf);
            this.modelSource = 'glb';
          } catch (err) {
            console.warn('GLB rig failed, using fallback car', err);
            this._buildFallback();
            this.modelSource = 'procedural';
          }
          this.ready = true;
          if (onProgress) onProgress(1);
          resolve(this);
        },
        (ev) => {
          if (onProgress && ev.total) onProgress(Math.min(0.99, ev.loaded / ev.total));
        },
        () => {
          this._buildFallback();
          this.modelSource = 'procedural';
          this.ready = true;
          if (onProgress) onProgress(1);
          resolve(this);
        });
    });
  }

  // ============================================================= GLB path

  _buildFromGLTF(gltf) {
    const raw = gltf.scene;
    raw.updateMatrixWorld(true);

    // normalize orientation + scale
    const box = new THREE.Box3().setFromObject(raw);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    if (size.x > size.z) {
      raw.rotation.y = -Math.PI / 2;
      raw.updateMatrixWorld(true);
      const c2 = new THREE.Box3().setFromObject(raw).getCenter(new THREE.Vector3());
      raw.position.sub(c2);
    } else {
      raw.position.sub(center);
    }
    raw.updateMatrixWorld(true);

    // nose = +Z: use the front-lamp node as reference
    let frontMinZ = null;
    raw.traverse((o) => {
      if (/front.*lamp/i.test(o.name || '')) {
        const b = new THREE.Box3().setFromObject(o);
        if (!b.isEmpty()) frontMinZ = (b.min.z + b.max.z) / 2;
      }
    });
    if (frontMinZ !== null && frontMinZ < 0) {
      raw.rotation.y += Math.PI;
      raw.updateMatrixWorld(true);
    }

    const size2 = new THREE.Box3().setFromObject(raw).getSize(new THREE.Vector3());
    const scale = TARGET_LENGTH / Math.max(size2.z, size2.x);
    const inner = new THREE.Group();
    inner.add(raw);
    inner.scale.setScalar(scale);
    const box3 = new THREE.Box3().setFromObject(inner);
    inner.position.y -= box3.min.y;

    this.body.add(inner);

    // materials: paint / tail lights
    raw.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const m = o.material;
      const n = m.name || '';
      if (/CARRERA_4096$/.test(n) && !this.mats.paint) this.mats.paint = m;
      if (/lamps/i.test(n) && !/HEADLIGHTS/i.test(n) && !this.mats.tail) {
        this.mats.tail = m;
        m.emissive = new THREE.Color(0xff1a1a);
        m.emissiveIntensity = 0.12;
      }
      if (/glass/i.test(n)) {
        m.transparent = true;
        m.opacity = 0.72;
        m.roughness = 0.12;
      }
      if (m.map) m.anisotropy = 4;
    });

    this._rigWheels(raw);
  }

  /** Rig the four GLB 'node_brakes' roots onto susp→steer→spin pivots. */
  _rigWheels(root) {
    const found = [];
    root.traverse((o) => {
      if (/node_brakes/i.test(o.name || '')) found.push(o);
    });
    this.group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.group.matrixWorld).invert();
    const wheels = [];
    let radius = 0;
    for (const wRoot of found) {
      const b = new THREE.Box3().setFromObject(wRoot);
      if (b.isEmpty()) continue;
      const cLocal = b.getCenter(new THREE.Vector3()).applyMatrix4(inv);
      const s = b.getSize(new THREE.Vector3());
      const r = Math.min(s.y, s.z) / 2;
      if (r > radius) radius = r;

      const susp = new THREE.Group();
      const steer = new THREE.Group();
      const spin = new THREE.Group();
      susp.add(steer);
      steer.add(spin);
      susp.position.copy(cLocal);
      this.group.add(susp);
      spin.attach(wRoot);
      wheels.push({ steerGroup: steer, suspGroup: susp, spinGroup: spin, front: cLocal.z > 0, side: cLocal.x > 0 ? 1 : -1 });
    }
    wheels.sort((a, b) => (b.front - a.front) || (a.side - b.side));
    this.wheels = wheels;
    if (radius > 0.15 && Number.isFinite(radius)) this.wheelRadius = radius;
  }

  // ========================================================= fallback car

  _buildFallback() {
    const paint = new THREE.MeshStandardMaterial({ color: 0xe8562a, roughness: 0.35, metalness: 0.15 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.6 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fc7e8, roughness: 0.1, metalness: 0.4, transparent: true, opacity: 0.7 });

    const hull = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.5, 4.2), paint);
    hull.position.y = 0.55;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.42, 1.9), glass);
    cabin.position.set(0, 0.98, -0.25);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.28, 0.9), paint);
    nose.position.set(0, 0.42, 1.95);
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.42), dark);
    spoiler.position.set(0, 1.02, -2.0);
    for (const m of [hull, cabin, nose, spoiler]) { m.castShadow = true; this.body.add(m); }

    const tireGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.26, 14);
    tireGeo.rotateZ(Math.PI / 2);
    for (const [x, z] of [[-0.82, 1.28], [0.82, 1.28], [-0.85, -1.35], [0.85, -1.35]]) {
      const susp = new THREE.Group();
      const steer = new THREE.Group();
      const spin = new THREE.Group();
      susp.add(steer); steer.add(spin);
      susp.position.set(x, 0.33, z);
      const tire = new THREE.Mesh(tireGeo, dark);
      tire.castShadow = true;
      spin.add(tire);
      this.group.add(susp);
      this.wheels.push({ steerGroup: steer, suspGroup: susp, spinGroup: spin, front: z > 0, side: x > 0 ? 1 : -1 });
    }
    this.wheels.sort((a, b) => (b.front - a.front) || (a.side - b.side));
    this.mats.paint = paint;
  }

  // ============================================================== update

  /**
   * @param {object} phys DriftPhysics state
   * @param {number} dt frame dt
   * @param {number} steerInput -1..1 (for steering-wheel-speed visuals)
   * @param {number} brake 0..1 (brake lights)
   */
  update(phys, dt, steerInput, brake) {
    this.group.position.set(phys.x, 0, phys.z);
    this.group.rotation.y = phys.heading;

    // body articulation — subtle, tuned for readability on a small screen
    const roll = THREE.MathUtils.clamp(phys.latG * 0.05, -0.1, 0.1);
    const pitch = THREE.MathUtils.clamp(-phys.ax * 0.012, -0.05, 0.05);
    this.body.rotation.z += (roll - this.body.rotation.z) * Math.min(1, dt * 8);
    this.body.rotation.x += (pitch - this.body.rotation.x) * Math.min(1, dt * 8);

    // wheels: steer (front), spin (all)
    this._steerVis += (steerInput * 0.5 - this._steerVis) * Math.min(1, dt * 10);
    const spinRate = phys._fwdVel() / this.wheelRadius;
    this._spin += spinRate * dt;
    for (const w of this.wheels) {
      if (w.front) w.steerGroup.rotation.y = this._steerVis;
      w.spinGroup.rotation.x = this._spin;
    }

    // brake lights
    if (this.mats.tail) {
      this.mats.tail.emissiveIntensity += ((brake > 0.1 ? 1.4 : 0.12) - this.mats.tail.emissiveIntensity) * Math.min(1, dt * 12);
    }
  }

  /** World positions of the two rear wheels (smoke / skid emit points). */
  rearWheelWorld(outL, outR) {
    const sinH = Math.sin(this.group.rotation.y);
    const cosH = Math.cos(this.group.rotation.y);
    const bx = -TUNE.b * sinH, bz = -TUNE.b * cosH;   // rear axle center
    const rx = -cosH, rz = sinH;                      // right vector
    const half = 0.8;
    outL.x = this.group.position.x + bx - rx * half;
    outL.z = this.group.position.z + bz - rz * half;
    outR.x = this.group.position.x + bx + rx * half;
    outR.z = this.group.position.z + bz + rz * half;
  }
}
