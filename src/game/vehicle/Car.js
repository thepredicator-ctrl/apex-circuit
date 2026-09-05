/**
 * Car — the player's vehicle: the CARRERA GLB sports coupe.
 *
 * The model ships with separate wheel assemblies (brakes → rim → tyre),
 * doors, mirrors, spoiler, steering wheel and lamp meshes. At load time we:
 *   - normalize orientation (nose = +Z, up = +Y) and scale (~4.35 m length)
 *   - drop to the ground plane so the tyres touch y = 0
 *   - wrap each wheel in susp → steer → spin pivots (centered on the wheel
 *     bounding box) so suspension travel, steering and rolling all read
 *     correctly
 *   - wire headlight spotlights + emissive lamp materials for night driving
 *   - expose a cockpit anchor for the cockpit camera
 *
 * The proven suspension/body-motion layer (roll, pitch, per-wheel travel,
 * brake-reactive lights) from the previous sedan is preserved on top.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CAR, SUSPENSION, HEADLIGHTS, PAINTS } from '../core/Constants.js';

const MODEL_URL = '/models/cartoon_sports_car.glb';
const TARGET_LENGTH = 4.35;

export class Car {
  constructor(world = null) {
    this.track = world;
    this.ready = false;

    this.group = new THREE.Group();
    this.body = new THREE.Group();
    this.group.add(this.body);

    this.cockpitAnchor = new THREE.Object3D();
    this.cockpitAnchor.position.set(0, 1.02, -0.3);
    this.body.add(this.cockpitAnchor);

    this.wheels = [];
    this._spinAngle = 0;
    this._steerVis = 0;
    this._time = 0;
    this._bodyY = 0;
    this._bodyYV = 0;
    this.cockpitMode = false;
    this.mats = {};
    this.headlightsTarget = true;
  }

  async build(onProgress) {
    const gltf = await new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.load(MODEL_URL,
        (g) => resolve(g),
        (evt) => {
          if (onProgress && evt.total) onProgress(Math.min(0.98, evt.loaded / evt.total));
        },
        (err) => reject(err)
      );
    });

    const raw = gltf.scene;
    raw.updateMatrixWorld(true);

    // ---- normalize orientation + scale ------------------------------------
    const box = new THREE.Box3().setFromObject(raw);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const correction = new THREE.Group();
    if (size.x > size.z) {
      // model is X-long — rotate so length lies along Z
      raw.rotation.y = -Math.PI / 2;
      raw.updateMatrixWorld(true);
      const box2 = new THREE.Box3().setFromObject(raw);
      const c2 = box2.getCenter(new THREE.Vector3());
      raw.position.sub(c2);
    } else {
      raw.position.sub(center);
    }
    raw.updateMatrixWorld(true);

    // nose = +Z: use the front-lamp node as the nose reference
    let noseZ = 1;
    raw.traverse((o) => {
      if (noseZ === 1 && /front.*lamp/i.test(o.name || '')) {
        const p = new THREE.Vector3();
        o.getWorldPosition(p);
        // in raw-local frame after centering: compare z of lamps via bbox test
      }
    });
    const boxC = new THREE.Box3().setFromObject(raw);
    let frontMinZ = null;
    raw.traverse((o) => {
      const n = (o.name || '').toLowerCase();
      if (/front.*lamp/.test(n) || /rear.*lamp/.test(n)) {
        const b = new THREE.Box3().setFromObject(o);
        if (b.isEmpty()) return;
        const zc = (b.min.z + b.max.z) / 2;
        if (/front/.test(n)) {
          frontMinZ = frontMinZ === null ? zc : Math.max(frontMinZ, zc * 0 + zc);
          if (frontMinZ === null) frontMinZ = zc;
          frontMinZ = zc;
        }
      }
    });
    if (frontMinZ !== null && frontMinZ < 0) noseZ = -1;
    if (noseZ < 0) {
      raw.rotation.y += Math.PI;
      raw.updateMatrixWorld(true);
    }

    const box2 = new THREE.Box3().setFromObject(raw);
    const size2 = box2.getSize(new THREE.Vector3());
    const scale = TARGET_LENGTH / Math.max(size2.z, size2.x);
    const inner = new THREE.Group();
    inner.add(raw);
    inner.scale.setScalar(scale);
    // drop to ground: wheels touch y = 0
    const box3 = new THREE.Box3().setFromObject(inner);
    inner.position.y -= box3.min.y;

    correction.add(inner);
    this.body.add(correction);
    this.model = correction;

    // ---- collect materials -------------------------------------------------
    this.mats.paint = null;
    raw.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const m = o.material;
      const n = (m.name || '');
      if (/CARRERA_4096$/.test(n) && !this.mats.paint) this.mats.paint = m;
      if (/HEADLIGHTS|front lamp/i.test(n)) {
        this.mats.headlamp = m;
        m.emissive = new THREE.Color(0xfff6d8);
        m.emissiveIntensity = 0.25;
      }
      if (/lamps/i.test(n) && !/HEADLIGHTS/i.test(n) && !this.mats.tail) {
        this.mats.tail = m;
        m.emissive = new THREE.Color(0xff1a1a);
        m.emissiveIntensity = 0.15;
      }
      if (/glass/i.test(n)) {
        m.transparent = true;
        m.opacity = 0.72;
        m.roughness = 0.12;
        m.metalness = 0.3;
        m.envMapIntensity = 1.4;
      }
      if (m.map) m.anisotropy = 8;
      if (m.isMeshStandardMaterial || m.isMeshPhongMaterial) {
        m.envMapIntensity = m.envMapIntensity ?? 0.9;
      }
    });

    // ---- rig wheels ----------------------------------------------------------
    this._rigWheels(raw);
    this.wheelRadius = CAR.wheelRadius;

    // ---- headlight spotlights -------------------------------------------------
    const mk = (z) => {
      const light = new THREE.SpotLight(
        HEADLIGHTS.color, HEADLIGHTS.intensity,
        HEADLIGHTS.distance, HEADLIGHTS.angle, HEADLIGHTS.penumbra, HEADLIGHTS.decay
      );
      light.position.set(z * 0.55, 0.72, TARGET_LENGTH * 0.48);
      const target = new THREE.Object3D();
      target.position.set(z * 1.6, -1.1, 30);
      this.body.add(light, target);
      light.target = target;
      return light;
    };
    this.headlightL = mk(0.55);
    this.headlightR = mk(-0.55);

    this.ready = true;
    if (onProgress) onProgress(1);
  }

  _rigWheels(root) {
    // wheel roots are the 'brakes' nodes (each contains rim + tyre)
    const found = [];
    root.traverse((o) => {
      if (/node_brakes/i.test(o.name || '')) found.push(o);
    });
    // update world matrices AFTER the normalization transforms above
    this.body.updateMatrixWorld(true);

    const wheels = [];
    for (const wRoot of found) {
      const b = new THREE.Box3().setFromObject(wRoot);
      if (b.isEmpty()) continue;
      const centerW = b.getCenter(new THREE.Vector3());

      // to body-local space
      const inv = new THREE.Matrix4().copy(this.body.matrixWorld).invert();
      const centerLocal = centerW.clone().applyMatrix4(inv);

      const susp = new THREE.Group();
      const steer = new THREE.Group();
      const spin = new THREE.Group();
      susp.add(steer);
      steer.add(spin);
      susp.position.copy(centerLocal);
      this.body.add(susp);
      // attach preserves the wheel's world transform under the new pivot
      susp.attach(wRoot);

      wheels.push({
        steerGroup: steer,
        suspGroup: susp,
        spinGroup: spin,
        front: centerLocal.z > 0,
        side: centerLocal.x > 0 ? 1 : -1,
        centerY: centerLocal.y
      });
    }
    // order FL FR RL RR (legacy contract)
    wheels.sort((a, b) => (b.front - a.front) || (a.side - b.side));
    this.wheels = wheels;
  }

  setPaint(key) {
    const p = PAINTS[key] || PAINTS.guardsRed;
    if (this.mats.paint) {
      // tint the textured body — white base takes the lacquer hue
      this.mats.paint.color.setHex(p.color).lerp(new THREE.Color(0xffffff), 0.35);
      this.mats.paint.roughness = 0.38;
      this.mats.paint.metalness = 0.25;
      if ('clearcoat' in this.mats.paint) {
        this.mats.paint.clearcoat = 0.6;
        this.mats.paint.clearcoatRoughness = 0.3;
      }
    }
  }

  setHeadlights(on) {
    this.headlightsTarget = !!on;
  }

  // ================================================================ update

  updateVisual(dt, phys, trans, race = null) {
    if (!this.ready) return;
    this._time += dt;

    this.group.position.set(phys.position.x, phys.position.y + 0.02, phys.position.z);
    this.group.rotation.y = phys.heading;

    // ---- wheels: spin + steer + suspension travel -------------------------
    const R = this.wheelRadius || CAR.wheelRadius;
    this._spinAngle -= (phys.vF / R) * dt;

    const steerTarget = -phys.steerAngle;
    this._steerVis = THREE.MathUtils.damp(this._steerVis, steerTarget, 14, dt);

    const susp = phys.suspSmooth;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.spinGroup.rotation.x = this._spinAngle;
      if (w.front) w.steerGroup.rotation.y = this._steerVis;
      const travel = THREE.MathUtils.clamp(
        (susp[i] - 0.5) * 2 * SUSPENSION.travel,
        -SUSPENSION.travel * 1.2, SUSPENSION.travel * 1.2
      );
      w.suspGroup.position.y = w.centerY + travel;
    }

    // ---- body roll + pitch -------------------------------------------------
    const roll = THREE.MathUtils.clamp(
      (susp[1] + susp[3] - susp[0] - susp[2]) * 0.5 * SUSPENSION.rollG * 6,
      -SUSPENSION.maxRoll, SUSPENSION.maxRoll
    );
    const pitch = THREE.MathUtils.clamp(
      (susp[2] + susp[3] - susp[0] - susp[1]) * 0.5 * SUSPENSION.accelPitch * 6,
      -SUSPENSION.maxPitch, SUSPENSION.maxPitch
    );
    this.body.rotation.z = THREE.MathUtils.damp(this.body.rotation.z, pitch + phys.roadPitch, 8, dt);
    this.body.rotation.x = THREE.MathUtils.damp(this.body.rotation.x, roll + phys.roadRoll, 8, dt);

    // body bounce
    const avgComp = (susp[0] + susp[1] + susp[2] + susp[3]) / 4;
    const targetY = -(avgComp - 0.5) * SUSPENSION.travel * 1.6;
    const k = 90, c = 13;
    const accel = (targetY - this._bodyY) * k - this._bodyYV * c;
    this._bodyYV += accel * dt;
    this._bodyY += this._bodyYV * dt;
    this.body.position.y = THREE.MathUtils.clamp(this._bodyY, -0.12, 0.12);

    // ---- brake / tail lights ----------------------------------------------
    if (this.mats.tail) {
      const braking = phys.brakeOut > 0.15 && phys.vF > 0.4;
      this.mats.tail.emissiveIntensity = THREE.MathUtils.damp(
        this.mats.tail.emissiveIntensity, braking ? 3.2 : (phys.reversing ? 1.6 : 0.15), 18, dt
      );
    }

    // ---- headlights ----------------------------------------------------------
    if (this._headlightsOn === undefined) this._headlightsOn = true;
    if (this._headlightsOn !== this.headlightsTarget) {
      this._headlightsOn = this.headlightsTarget;
      const on = this._headlightsOn;
      this.headlightL.intensity = on ? HEADLIGHTS.intensity : 0;
      this.headlightR.intensity = on ? HEADLIGHTS.intensity : 0;
      if (this.mats.headlamp) this.mats.headlamp.emissiveIntensity = on ? 1.6 : 0.05;
    }
  }
}
