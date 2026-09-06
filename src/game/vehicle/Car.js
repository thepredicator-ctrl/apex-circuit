/**
 * Car — the player's vehicle: the CARRERA GLB sports coupe.
 *
 * Resilience contract (the game must NEVER fail to boot because of the
 * model): build() tries the GLB three times (relative URL, so it works on
 * root hosts and GitHub-Pages-style subpaths alike) and, if the fetch or
 * the rigging still fails, falls back to a fully procedural sculpted coupe
 * built from Three.js primitives. Both paths produce the same public
 * surface: this.wheels[] with susp → steer → spin pivots, mats.paint /
 * mats.tail / mats.headlamp, headlight spotlights, cockpit anchor.
 *
 * Visual feedback layer (roll, pitch, per-wheel travel, brake-reactive
 * lights, headlight toggle) is shared by both model sources.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CAR, SUSPENSION, HEADLIGHTS, PAINTS } from '../core/Constants.js';

const TARGET_LENGTH = 4.35;

/** Resolve the model URL against the document base so subpath hosts work. */
function modelURL() {
  try {
    return new URL('models/cartoon_sports_car.glb', document.baseURI).href;
  } catch {
    return '/models/cartoon_sports_car.glb';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Car {
  constructor(world = null) {
    this.track = world;
    this.ready = false;
    this.modelSource = null;   // 'glb' | 'procedural'

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
    this.steerWheelPivot = null;   // GLB cockpit steering wheel (optional)
    this._steerWheelAxis = null;
  }

  // ================================================================ build

  async build(onProgress) {
    let gltf = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3 && !gltf; attempt++) {
      try {
        gltf = await new Promise((resolve, reject) => {
          const loader = new GLTFLoader();
          loader.load(modelURL(),
            (g) => resolve(g),
            (evt) => {
              if (onProgress && evt.total) onProgress(Math.min(0.98, evt.loaded / evt.total));
            },
            (err) => reject(err)
          );
        });
      } catch (err) {
        lastErr = err;
        console.warn(`[ApexRoads] car GLB fetch failed (attempt ${attempt}/3):`, err && err.message ? err.message : err);
        if (attempt < 3) await sleep(700);
      }
    }

    if (gltf) {
      try {
        this._buildFromGLTF(gltf);
        this.modelSource = 'glb';
        this._finishBuild(onProgress);
        return;
      } catch (err) {
        console.warn('[ApexRoads] GLB rigging failed — using procedural coupe:', err && err.message ? err.message : err);
      }
    } else if (lastErr) {
      console.warn('[ApexRoads] car GLB unavailable — using procedural coupe.');
    }

    this._buildFallback();
    this.modelSource = 'procedural';
    this._finishBuild(onProgress);
  }

  /** Emergency path: force the procedural coupe (used if build() itself threw). */
  async buildFallbackOnly() {
    if (this.ready) return;
    this._buildFallback();
    this.modelSource = 'procedural';
    this._finishBuild(null);
  }

  _finishBuild(onProgress) {
    this.ready = true;
    if (onProgress) onProgress(1);
  }

  // ============================================================= GLB path

  _buildFromGLTF(gltf) {
    const raw = gltf.scene;
    raw.updateMatrixWorld(true);

    // ---- normalize orientation + scale ------------------------------------
    const box = new THREE.Box3().setFromObject(raw);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

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
    let frontMinZ = null;
    raw.traverse((o) => {
      const n = (o.name || '').toLowerCase();
      if (/front.*lamp/.test(n)) {
        const b = new THREE.Box3().setFromObject(o);
        if (b.isEmpty()) return;
        frontMinZ = (b.min.z + b.max.z) / 2;
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

    const correction = new THREE.Group();
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

    // ---- rig wheels + cockpit steering wheel --------------------------------
    this._rigWheels(raw);
    this._rigSteeringWheel(raw);

    this._addHeadlights();
  }

  /**
   * Rig the four GLB wheels onto susp → steer → spin pivot chains.
   *
   * Pivots live under this.group (the UNSPRUNG frame: yaw + position only),
   * while the body mesh stays under this.body (SPRUNG: roll/pitch/bounce).
   * That keeps wheels planted on the road while the body articulates.
   *
   * The wheel node itself must ride the SPIN pivot — attaching it to susp
   * (the old bug) leaves steer/spin empty, so wheels never turned or rolled.
   */
  _rigWheels(root) {
    // wheel roots are the 'brakes' nodes (each contains disc + rim + tyre)
    const found = [];
    root.traverse((o) => {
      if (/node_brakes/i.test(o.name || '')) found.push(o);
    });
    // update world matrices AFTER the normalization transforms above
    this.group.updateMatrixWorld(true);
    this.body.updateMatrixWorld(true);

    const inv = new THREE.Matrix4().copy(this.group.matrixWorld).invert();
    const wheels = [];
    let radius = 0;

    for (const wRoot of found) {
      const b = new THREE.Box3().setFromObject(wRoot);
      if (b.isEmpty()) continue;
      const centerW = b.getCenter(new THREE.Vector3());
      const centerLocal = centerW.clone().applyMatrix4(inv);

      // measure the real wheel so the spin rate matches the model
      const s = b.getSize(new THREE.Vector3());
      const r = Math.min(s.y, s.z) / 2;
      if (r > radius) radius = r;

      const susp = new THREE.Group();
      const steer = new THREE.Group();
      const spin = new THREE.Group();
      susp.add(steer);
      steer.add(spin);
      susp.position.copy(centerLocal);
      this.group.add(susp);
      // attach preserves the wheel's world transform under the SPIN pivot
      spin.attach(wRoot);

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
    if (radius > 0.15 && Number.isFinite(radius)) this.wheelRadius = radius;
  }

  /**
   * Cockpit steering wheel rotates with the rack (visual sugar — skipped
   * silently when the model has no steering-wheel node).
   */
  _rigSteeringWheel(root) {
    let node = null;
    root.traverse((o) => {
      if (!node && /steering.?wheel/i.test(o.name || '')) node = o;
    });
    if (!node) return;
    this.body.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(node);
    if (b.isEmpty()) return;

    const inv = new THREE.Matrix4().copy(this.body.matrixWorld).invert();
    const local = b.getCenter(new THREE.Vector3()).applyMatrix4(inv);

    const pivot = new THREE.Group();
    pivot.position.copy(local);
    this.body.add(pivot);
    pivot.attach(node);

    this.steerWheelPivot = pivot;
    // column axis: up and tilted back toward the driver's chest
    this._steerWheelAxis = new THREE.Vector3(0, 0.94, -0.34).normalize();
  }

  // ======================================================== procedural path

  /** A box whose top face is scaled/shifted — sculpted low-poly volumes. */
  _taperBox(w, h, d, { topW = 1, topD = 1, topShiftZ = 0 } = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) {
        pos.setX(i, pos.getX(i) * topW);
        pos.setZ(i, pos.getZ(i) * topD + topShiftZ);
      }
    }
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Sculpted procedural coupe — only used when the GLB cannot be fetched.
   * Nose = +Z, wheels touch y = 0, pivot layout identical to the GLB rig.
   */
  _buildFallback() {
    // remove any partially-built model first (safe re-entry)
    if (this.model) {
      this.body.remove(this.model);
      this.model = null;
    }
    for (const w of this.wheels) {
      this.group.remove(w.suspGroup);
      this.body.remove(w.suspGroup);
    }
    this.wheels = [];
    if (this.steerWheelPivot) {
      this.body.remove(this.steerWheelPivot);
      this.steerWheelPivot = null;
      this._steerWheelAxis = null;
    }

    const D = {
      length: 4.55, width: 1.84,
      wheelbase: CAR.wheelbase, track: CAR.trackWidth,
      wheelR: CAR.wheelRadius, wheelW: 0.24,
      ride: 0.30, belt: 0.72
    };
    const g = new THREE.Group();

    const paint = new THREE.MeshPhysicalMaterial({
      color: 0xbb0a1e, roughness: 0.38, metalness: 0.25,
      clearcoat: 0.6, clearcoatRoughness: 0.3
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.55, metalness: 0.35 });
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x9fb6c4, roughness: 0.12, metalness: 0.3,
      transparent: true, opacity: 0.72, envMapIntensity: 1.4
    });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dadd, roughness: 0.25, metalness: 0.9 });
    this.mats.paint = paint;

    // main hull (sculpted, tapered toward nose + tail)
    const hull = new THREE.Mesh(this._taperBox(D.width, D.belt, D.length * 0.97,
      { topW: 0.94, topD: 0.985 }), paint);
    hull.position.y = D.ride + D.belt / 2;
    g.add(hull);

    // nose wedge + tail taper
    const nose = new THREE.Mesh(this._taperBox(D.width * 0.9, 0.30, 0.9, { topW: 0.82, topD: 0.7 }), paint);
    nose.position.set(0, D.ride + 0.16, D.length / 2 - 0.48);
    g.add(nose);

    // greenhouse (glass) + roof
    const cabin = new THREE.Mesh(this._taperBox(D.width * 0.86, 0.5, 2.0, { topW: 0.7, topD: 0.62, topShiftZ: -0.12 }), glass);
    cabin.position.set(0, D.ride + D.belt + 0.24, -0.28);
    g.add(cabin);
    const roof = new THREE.Mesh(this._taperBox(D.width * 0.62, 0.07, 1.28, { topW: 0.96, topD: 0.9 }), paint);
    roof.position.set(0, D.ride + D.belt + 0.5, -0.4);
    g.add(roof);

    // grille + splitter + rear diffuser
    const grille = new THREE.Mesh(this._taperBox(D.width * 0.44, 0.16, 0.08), dark);
    grille.position.set(0, D.ride + 0.2, D.length / 2 + 0.005);
    g.add(grille);
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(D.width * 0.96, 0.05, 0.3), dark);
    splitter.position.set(0, D.ride + 0.02, D.length / 2 - 0.12);
    g.add(splitter);
    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(D.width * 0.9, 0.1, 0.24), dark);
    diffuser.position.set(0, D.ride + 0.05, -D.length / 2 + 0.1);
    g.add(diffuser);

    // lip spoiler
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(D.width * 0.82, 0.05, 0.22), paint);
    spoiler.position.set(0, D.ride + D.belt + 0.1, -D.length / 2 + 0.12);
    g.add(spoiler);

    // light bars (emissive, brake-reactive)
    const headlamp = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff6d8, emissiveIntensity: 0.25, roughness: 0.3 });
    const tail = new THREE.MeshStandardMaterial({ color: 0x330505, emissive: 0xff1a1a, emissiveIntensity: 0.15, roughness: 0.4 });
    this.mats.headlamp = headlamp;
    this.mats.tail = tail;
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.09, 0.06), headlamp);
    hl.position.set(D.width * 0.30, D.ride + 0.30, D.length / 2 + 0.01);
    const hr = hl.clone(); hr.position.x *= -1;
    g.add(hl, hr);
    const tlBar = new THREE.Mesh(new THREE.BoxGeometry(D.width * 0.74, 0.08, 0.05), tail);
    tlBar.position.set(0, D.ride + 0.42, -D.length / 2 - 0.005);
    g.add(tlBar);

    // mirrors
    for (const s of [1, -1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.1), paint);
      m.position.set(s * (D.width / 2 + 0.09), D.ride + D.belt + 0.08, 0.62);
      g.add(m);
    }

    this.model = g;
    this.body.add(g);

    // ---- wheels: susp → steer → spin pivots, contract identical to GLB ----
    const tire = new THREE.CylinderGeometry(D.wheelR, D.wheelR, D.wheelW, 20);
    tire.rotateZ(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(D.wheelR * 0.58, D.wheelR * 0.58, D.wheelW * 1.02, 16);
    rim.rotateZ(Math.PI / 2);
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 0.9 });
    const rimMat = chrome;

    const positions = [
      { x: D.track / 2, z: D.wheelbase / 2 },   // FL
      { x: -D.track / 2, z: D.wheelbase / 2 },  // FR
      { x: D.track / 2, z: -D.wheelbase / 2 },  // RL
      { x: -D.track / 2, z: -D.wheelbase / 2 }  // RR
    ];
    const wheels = [];
    for (const p of positions) {
      // geometry is hub-centered, so all pivots sit at the hub: susp holds the
      // hub position (updateVisual rewrites its y each frame), steer spins
      // around Y, spin rolls around X.
      const susp = new THREE.Group();
      const steer = new THREE.Group();
      const spin = new THREE.Group();
      susp.add(steer);
      steer.add(spin);

      const t = new THREE.Mesh(tire, tireMat);
      const r = new THREE.Mesh(rim, rimMat);
      t.castShadow = true;
      spin.add(t, r);

      susp.position.set(p.x, D.wheelR, p.z);
      this.group.add(susp);   // unsprung frame — same contract as the GLB rig

      wheels.push({
        steerGroup: steer,
        suspGroup: susp,
        spinGroup: spin,
        front: p.z > 0,
        side: p.x > 0 ? 1 : -1,
        centerY: D.wheelR
      });
    }
    this.wheels = wheels;
    this.wheelRadius = D.wheelR;

    this._addHeadlights();
  }

  // =============================================================== shared

  _addHeadlights() {
    const mk = (x) => {
      const light = new THREE.SpotLight(
        HEADLIGHTS.color, HEADLIGHTS.intensity,
        HEADLIGHTS.distance, HEADLIGHTS.angle, HEADLIGHTS.penumbra, HEADLIGHTS.decay
      );
      light.position.set(x, 0.72, TARGET_LENGTH * 0.48);
      const target = new THREE.Object3D();
      target.position.set(x * 2.9, -1.1, 30);
      this.body.add(light, target);
      light.target = target;
      return light;
    };
    this.headlightL = mk(0.55);
    this.headlightR = mk(-0.55);
  }

  setPaint(key) {
    const p = PAINTS[key] || PAINTS.guardsRed;
    if (this.mats.paint) {
      if (this.modelSource === 'procedural') {
        // opaque painted body — take the lacquer hue directly
        this.mats.paint.color.setHex(p.color);
      } else {
        // tint the textured body — white base takes the lacquer hue
        this.mats.paint.color.setHex(p.color).lerp(new THREE.Color(0xffffff), 0.35);
      }
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

    // ---- unsprung mass: wheels spin, steer, and stay planted ---------------
    const R = this.wheelRadius || CAR.wheelRadius;
    this._spinAngle += (phys.vF / R) * dt;   // + spin rolls forward

    const steerTarget = -phys.steerAngle;
    this._steerVis = THREE.MathUtils.damp(this._steerVis, steerTarget, 14, dt);

    // each wheel follows ITS ground patch (phys.wheelGroundY, FL FR RL RR);
    // legacy phys (remote cars) falls back to the susp-compression contract
    const gY = phys.wheelGroundY || null;
    const legacy = phys.suspSmooth || null;
    let avgDev = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.spinGroup.rotation.x = this._spinAngle;
      if (w.front) w.steerGroup.rotation.y = this._steerVis;

      let dev = 0;
      if (gY && gY[i] !== undefined && phys.surfaceY !== undefined) {
        dev = gY[i] - phys.surfaceY;           // wheel's ground vs CG ground
      } else if (legacy) {
        dev = (legacy[i] - 0.5) * 2 * SUSPENSION.travel;
      }
      w._dev = (w._dev === undefined)
        ? dev
        : THREE.MathUtils.damp(w._dev, dev, 16, dt);
      const travel = THREE.MathUtils.clamp(w._dev, -0.28, 0.28);
      w.suspGroup.position.y = w.centerY + travel;
      avgDev += travel / (this.wheels.length || 1);
    }

    // ---- sprung mass: body articulates over planted wheels ------------------
    // nose = +Z, so PITCH is rotation.x (brake dive = positive) and ROLL is
    // rotation.z (right side down = positive).
    const grade = phys.roadPitch || 0;   // + = ground rises ahead -> nose up
    const bank  = phys.roadRoll || 0;    // + = ground rises to the right
    const dive  = THREE.MathUtils.clamp(-(phys.aLongS || 0) * 0.006, -0.055, 0.055);
    const lean  = THREE.MathUtils.clamp((phys.latAccel || 0) * 0.0065, -0.09, 0.09);
    const targetPitch = THREE.MathUtils.clamp(-grade + dive, -0.2, 0.2);
    const targetRoll  = THREE.MathUtils.clamp(-bank + lean, -0.14, 0.14);
    this.body.rotation.x = THREE.MathUtils.damp(this.body.rotation.x, targetPitch, 8, dt);
    this.body.rotation.z = THREE.MathUtils.damp(this.body.rotation.z, targetRoll, 8, dt);

    // body bounce — sprung mass answers the average suspension deviation
    const targetY = THREE.MathUtils.clamp(-avgDev * 0.9, -0.13, 0.13);
    const k = 90, c = 13;
    const accel = (targetY - this._bodyY) * k - this._bodyYV * c;
    this._bodyYV += accel * dt;
    this._bodyY += this._bodyYV * dt;
    this.body.position.y = THREE.MathUtils.clamp(this._bodyY, -0.14, 0.14);

    // cockpit steering wheel follows the rack
    if (this.steerWheelPivot && this._steerWheelAxis) {
      this.steerWheelPivot.quaternion.setFromAxisAngle(
        this._steerWheelAxis, this._steerVis * 7
      );
    }

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
