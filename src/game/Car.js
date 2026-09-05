/**
 * Car — a low-poly mid-size sedan built from simple Three.js primitives.
 *
 * Design goals (per user request):
 *   - Simple low-poly graphics (boxes + cylinders, flat shading)
 *   - INSANE suspension travel (way more than realistic — bouncy + visible)
 *   - INSANE turning (huge steer angle, tight turning radius)
 *
 * The car is a generic mid-size sedan: 4.6m long, 1.8m wide, 1.4m tall.
 * Wheels are simple cylinders. The body is a shaped box with a cabin.
 */

import * as THREE from 'three';
import { CAR, SUSPENSION, HEADLIGHTS, PAINTS } from './Constants.js';
import { Interior } from './Interior.js';

const D = {
  length: 4.6,
  width: 1.8,
  height: 1.45,
  wheelbase: 2.7,
  trackWidth: 1.55,
  wheelRadius: 0.33,
  wheelWidth: 0.22,
  rideHeight: 0.35,
  cabinLength: 2.0,
  cabinHeight: 0.7,
  hoodHeight: 0.85,
};

export class Car {
  constructor(track = null) {
    this.track = track;
    this.ready = false;

    this.group = new THREE.Group();
    this.model = new THREE.Group();
    this.model.rotation.y = -Math.PI / 2;
    this.group.add(this.model);

    this.body = new THREE.Group();
    this.model.add(this.body);

    this.cockpitAnchor = new THREE.Object3D();
    this.body.add(this.cockpitAnchor);

    this.wheels = [];
    this._spinAngle = 0;
    this._steerVis = 0;
    this._time = 0;
    this._bodyY = 0;
    this._bodyYV = 0;
    this.cockpitMode = false;
    this.mats = {};
  }

  async build(onProgress) {
    this._buildMaterials();
    this._buildBody();
    this._buildCabin();
    this._buildWheels();
    this._buildLights();

    this.interior = new Interior(this);
    this.interior.buildProcedural(this.body, D);
    if (this.interior.cockpitAnchor) {
      this.cockpitAnchor = this.interior.cockpitAnchor;
    }

    this.wheelRadius = D.wheelRadius;
    this.ready = true;
    if (onProgress) onProgress(1);
  }

  _buildMaterials() {
    this.mats = {
      paint: new THREE.MeshStandardMaterial({
        color: 0x2a4d6e, metalness: 0.3, roughness: 0.5, flatShading: true
      }),
      glass: new THREE.MeshStandardMaterial({
        color: 0x0a1018, metalness: 0.2, roughness: 0.1,
        transparent: true, opacity: 0.4
      }),
      black: new THREE.MeshStandardMaterial({
        color: 0x141414, roughness: 0.7, flatShading: true
      }),
      chrome: new THREE.MeshStandardMaterial({
        color: 0xb0b4b8, metalness: 0.95, roughness: 0.2
      }),
      tire: new THREE.MeshStandardMaterial({
        color: 0x0a0a0a, roughness: 0.95, flatShading: true
      }),
      rim: new THREE.MeshStandardMaterial({
        color: 0x6a6e75, metalness: 0.9, roughness: 0.3, flatShading: true
      }),
      headlight: new THREE.MeshStandardMaterial({
        color: 0xeef4ff, emissive: 0xcfe4ff, emissiveIntensity: 1.5
      }),
      taillight: new THREE.MeshStandardMaterial({
        color: 0x30040a, emissive: 0xff1a1a, emissiveIntensity: 1.2
      }),
      interior: new THREE.MeshStandardMaterial({
        color: 0x1a1d22, roughness: 0.9
      }),
      needle: new THREE.MeshBasicMaterial({ color: 0xff3b30, toneMapped: false }),
      screenGlow: new THREE.MeshBasicMaterial({ color: 0x0a0e14, toneMapped: false }),
    };
  }

  setPaint(key) {
    const p = PAINTS[key] || PAINTS.nightBlue;
    this.mats.paint.color.setHex(p.color);
  }

  _buildBody() {
    const g = new THREE.Group();
    this.body.add(g);

    // ---- lower body (single box, flat-shaded) --------------------------
    const bodyGeo = new THREE.BoxGeometry(D.length, D.hoodHeight, D.width);
    const body = new THREE.Mesh(bodyGeo, this.mats.paint);
    body.position.y = D.rideHeight + D.hoodHeight / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // ---- hood slope (front top tapered down) ----------------------------
    const hoodGeo = new THREE.BoxGeometry(0.9, 0.05, D.width * 0.95);
    const hood = new THREE.Mesh(hoodGeo, this.mats.paint);
    hood.position.set(D.length / 2 - 0.5, D.rideHeight + D.hoodHeight + 0.01, 0);
    hood.rotation.z = -0.06;
    hood.castShadow = true;
    g.add(hood);

    // ---- trunk (rear, slightly raised) ----------------------------------
    const trunkGeo = new THREE.BoxGeometry(0.8, 0.05, D.width * 0.95);
    const trunk = new THREE.Mesh(trunkGeo, this.mats.paint);
    trunk.position.set(-D.length / 2 + 0.5, D.rideHeight + D.hoodHeight + 0.01, 0);
    trunk.rotation.z = 0.03;
    g.add(trunk);

    // ---- bumpers --------------------------------------------------------
    const bumperGeo = new THREE.BoxGeometry(0.12, 0.22, D.width);
    for (const [x, _] of [[D.length / 2, 1], [-D.length / 2, -1]]) {
      const b = new THREE.Mesh(bumperGeo, this.mats.black);
      b.position.set(x, D.rideHeight + 0.15, 0);
      b.castShadow = true;
      g.add(b);
    }

    // ---- side skirts ----------------------------------------------------
    const skirtGeo = new THREE.BoxGeometry(D.length * 0.65, 0.1, 0.04);
    for (const side of [1, -1]) {
      const s = new THREE.Mesh(skirtGeo, this.mats.black);
      s.position.set(0, D.rideHeight - 0.02, side * D.width / 2);
      g.add(s);
    }

    // ---- front grille ---------------------------------------------------
    const grille = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.15, D.width * 0.5),
      this.mats.black
    );
    grille.position.set(D.length / 2 + 0.01, D.rideHeight + 0.3, 0);
    g.add(grille);

    this.carRoot = g;
  }

  _buildCabin() {
    const g = new THREE.Group();

    // ---- roof -----------------------------------------------------------
    const roofGeo = new THREE.BoxGeometry(D.cabinLength * 0.7, 0.05, D.width * 0.85);
    const roof = new THREE.Mesh(roofGeo, this.mats.paint);
    roof.position.set(-0.1, D.rideHeight + D.hoodHeight + D.cabinHeight, 0);
    roof.castShadow = true;
    g.add(roof);

    // ---- windshield -----------------------------------------------------
    const wsGeo = new THREE.BoxGeometry(0.04, D.cabinHeight * 1.2, D.width * 0.8);
    const ws = new THREE.Mesh(wsGeo, this.mats.glass);
    ws.position.set(D.cabinLength / 2, D.rideHeight + D.hoodHeight + D.cabinHeight * 0.55, 0);
    ws.rotation.z = 0.5;
    g.add(ws);

    // ---- rear window ----------------------------------------------------
    const rwGeo = new THREE.BoxGeometry(0.04, D.cabinHeight * 1.1, D.width * 0.8);
    const rw = new THREE.Mesh(rwGeo, this.mats.glass);
    rw.position.set(-D.cabinLength / 2, D.rideHeight + D.hoodHeight + D.cabinHeight * 0.5, 0);
    rw.rotation.z = -0.55;
    g.add(rw);

    // ---- side windows ---------------------------------------------------
    const swGeo = new THREE.BoxGeometry(D.cabinLength * 0.8, D.cabinHeight * 0.65, 0.02);
    for (const side of [1, -1]) {
      const sw = new THREE.Mesh(swGeo, this.mats.glass);
      sw.position.set(-0.1, D.rideHeight + D.hoodHeight + D.cabinHeight * 0.5, side * D.width * 0.42);
      g.add(sw);
    }

    // ---- door handles ---------------------------------------------------
    const handleGeo = new THREE.BoxGeometry(0.1, 0.02, 0.02);
    for (const side of [1, -1]) {
      for (const x of [0.3, -0.4]) {
        const h = new THREE.Mesh(handleGeo, this.mats.chrome);
        h.position.set(x, D.rideHeight + D.hoodHeight * 0.6, side * D.width / 2);
        g.add(h);
      }
    }

    // ---- side mirrors ---------------------------------------------------
    const mirrorGeo = new THREE.BoxGeometry(0.05, 0.06, 0.1);
    for (const side of [1, -1]) {
      const m = new THREE.Mesh(mirrorGeo, this.mats.paint);
      m.position.set(0.5, D.rideHeight + D.hoodHeight * 0.7, side * (D.width / 2 + 0.06));
      g.add(m);
    }

    this.body.add(g);
  }

  _buildWheels() {
    const halfWB = D.wheelbase / 2;
    const halfTW = D.trackWidth / 2;
    const wheelY = D.rideHeight + D.wheelRadius * 0.5;

    // simple cylinder wheel (tire) + smaller cylinder (rim) + 4 spokes
    const tireGeo = new THREE.CylinderGeometry(D.wheelRadius, D.wheelRadius, D.wheelWidth, 16);
    tireGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(D.wheelRadius * 0.55, D.wheelRadius * 0.55, D.wheelWidth + 0.01, 12);
    rimGeo.rotateZ(Math.PI / 2);
    const spokeGeo = new THREE.BoxGeometry(D.wheelWidth + 0.02, 0.035, D.wheelRadius * 0.5);

    const positions = [
      { x: halfWB, z: halfTW, front: true, side: 1 },
      { x: halfWB, z: -halfTW, front: true, side: -1 },
      { x: -halfWB, z: halfTW, front: false, side: 1 },
      { x: -halfWB, z: -halfTW, front: false, side: -1 }
    ];

    for (const p of positions) {
      const wheelRoot = new THREE.Group();
      const steer = new THREE.Group();
      const susp = new THREE.Group();
      const spin = new THREE.Group();
      wheelRoot.add(steer); steer.add(susp); susp.add(spin);
      wheelRoot.position.set(p.x, wheelY, p.z);

      const tire = new THREE.Mesh(tireGeo, this.mats.tire);
      tire.castShadow = true;
      spin.add(tire);

      const rim = new THREE.Mesh(rimGeo, this.mats.rim);
      spin.add(rim);

      for (let s = 0; s < 4; s++) {
        const spoke = new THREE.Mesh(spokeGeo, this.mats.rim);
        spoke.rotation.x = (s / 4) * Math.PI * 2;
        spin.add(spoke);
      }

      this.body.add(wheelRoot);
      this.wheels.push({
        steerGroup: steer, suspGroup: susp, spinGroup: spin,
        spinAxis: 'x', front: p.front, side: p.side
      });
    }

    this.wheels.sort((a, b) => (b.front - a.front) || (a.side - b.side));
  }

  _buildLights() {
    // headlights
    const headGeo = new THREE.BoxGeometry(0.03, 0.1, 0.18);
    for (const side of [1, -1]) {
      const h = new THREE.Mesh(headGeo, this.mats.headlight);
      h.position.set(D.length / 2 + 0.01, D.rideHeight + 0.4, side * 0.55);
      this.body.add(h);
    }
    // spotlight rigs
    const mk = (z) => {
      const light = new THREE.SpotLight(
        HEADLIGHTS.color, HEADLIGHTS.intensity,
        HEADLIGHTS.distance, HEADLIGHTS.angle, HEADLIGHTS.penumbra, HEADLIGHTS.decay
      );
      light.position.set(D.length / 2, D.rideHeight + 0.45, z);
      const target = new THREE.Object3D();
      target.position.set(30, -1, z * 1.4);
      this.body.add(light, target);
      light.target = target;
      return light;
    };
    this.headlightL = mk(0.55);
    this.headlightR = mk(-0.55);

    // taillights
    const tailGeo = new THREE.BoxGeometry(0.03, 0.08, 0.3);
    this.mats._tail = new THREE.MeshStandardMaterial({
      color: 0x30040a, emissive: 0xff1a1a, emissiveIntensity: 1.2, roughness: 0.3
    });
    const tail = new THREE.Mesh(tailGeo, this.mats._tail);
    tail.position.set(-D.length / 2 - 0.01, D.rideHeight + 0.45, 0);
    this.body.add(tail);
  }

  updateVisual(dt, phys, trans, race = null) {
    if (!this.ready) return;
    this._time += dt;

    this.group.position.set(phys.position.x, phys.position.y + 0.02, phys.position.z);
    this.group.rotation.y = phys.heading;

    // ---- wheels: spin + steer + INSANE suspension travel ----------------
    const R = this.wheelRadius || CAR.wheelRadius;
    this._spinAngle -= (phys.vF / R) * dt;

    const steerTarget = -phys.steerAngle;
    this._steerVis = THREE.MathUtils.damp(this._steerVis, steerTarget, 14, dt);

    const susp = phys.suspSmooth;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.spinGroup.rotation.x = this._spinAngle;
      if (w.front) w.steerGroup.rotation.y = this._steerVis;
      // INSANE suspension travel — way more than realistic, very visible
      const travel = THREE.MathUtils.clamp(
        (susp[i] - 0.5) * 2 * SUSPENSION.travel,
        -SUSPENSION.travel * 1.2, SUSPENSION.travel * 1.2
      );
      w.suspGroup.position.y = travel;
    }

    // ---- body roll + pitch (exaggerated for visible weight transfer) ---
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
    this.body.position.y = THREE.MathUtils.clamp(this._bodyY, -0.15, 0.15);

    // ---- lights ---------------------------------------------------------
    const braking = phys.brakeOut > 0.15 && phys.vF > 0.4;
    if (this.mats._tail) this.mats._tail.emissiveIntensity = braking ? 4.0 : 1.2;

    // ---- interior -------------------------------------------------------
    if (this.interior) this.interior.update(dt, phys, trans);
  }
}
