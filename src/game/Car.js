/**
 * Car — procedurally built low-poly sports car (no external assets).
 *
 * The model is authored with the nose along +X, then wrapped in a group
 * rotated -90° about Y so the nose points at +Z, matching the physics
 * convention forward = (sin h, 0, cos h).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function extrudeShape(points, depth, bevel) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 4
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

export class Car {
  constructor() {
    this.group = new THREE.Group();      // world transform (position + heading)
    this.model = new THREE.Group();      // visual-only roll/pitch/bounce
    this.model.rotation.y = -Math.PI / 2; // nose +X -> +Z
    this.group.add(this.model);

    this._buildMaterials();
    this._buildBody();
    this._buildWheels();

    this._prevVF = 0;
    this._accel = 0;
    this._bounce = 0;
    this._time = 0;
  }

  _buildMaterials() {
    this.mats = {
      paint: new THREE.MeshStandardMaterial({
        color: 0xd8342a, metalness: 0.55, roughness: 0.38, flatShading: true
      }),
      blackMatte: new THREE.MeshStandardMaterial({
        color: 0x14161a, metalness: 0.1, roughness: 0.9
      }),
      glass: new THREE.MeshStandardMaterial({
        color: 0x0d141b, metalness: 0.85, roughness: 0.12,
        transparent: true, opacity: 0.72, envMapIntensity: 1.4
      }),
      chrome: new THREE.MeshStandardMaterial({
        color: 0xd8dde2, metalness: 1.0, roughness: 0.28
      }),
      tire: new THREE.MeshStandardMaterial({
        color: 0x131313, roughness: 0.96, metalness: 0
      }),
      headlight: new THREE.MeshStandardMaterial({
        color: 0x998f77, emissive: 0xfff6da, emissiveIntensity: 1.6
      }),
      tail: new THREE.MeshStandardMaterial({
        color: 0x4a0805, emissive: 0xff2418, emissiveIntensity: 0.55
      }),
      reverse: new THREE.MeshStandardMaterial({
        color: 0x3a3a3a, emissive: 0xffffff, emissiveIntensity: 0.12
      }),
      helmet: new THREE.MeshStandardMaterial({
        color: 0xf2f4f6, roughness: 0.3, metalness: 0.1
      })
    };
  }

  _buildBody() {
    const M = this.mats;

    // main hull
    const bodyGeo = extrudeShape([
      [2.42, 0.30], [2.30, 0.44], [0.72, 0.60], [0.10, 1.00],
      [-0.72, 0.97], [-1.60, 0.66], [-2.30, 0.72], [-2.38, 0.34],
      [-1.20, 0.18], [1.60, 0.16]
    ], 1.64, 0.09);
    const body = new THREE.Mesh(bodyGeo, M.paint);
    this.model.add(body);

    // glass canopy (slightly wider than the hull so the side windows show)
    const glassGeo = extrudeShape([
      [0.66, 0.585], [0.16, 0.965], [-0.66, 0.935], [-0.60, 0.60]
    ], 1.76, 0.055);
    const glass = new THREE.Mesh(glassGeo, M.glass);
    this.model.add(glass);

    // driver helmet
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), M.helmet);
    helmet.position.set(-0.08, 0.88, 0);
    this.model.add(helmet);

    // front splitter + rear diffuser
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 1.72), M.blackMatte);
    splitter.position.set(2.2, 0.13, 0);
    this.model.add(splitter);

    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 1.6), M.blackMatte);
    diffuser.position.set(-2.22, 0.17, 0);
    this.model.add(diffuser);

    // rear wing
    const wingGeo = new THREE.BoxGeometry(0.36, 0.045, 1.78);
    const wing = new THREE.Mesh(wingGeo, M.blackMatte);
    wing.position.set(-2.16, 0.99, 0);
    wing.rotation.z = 0.1;
    this.model.add(wing);
    for (const side of [-0.55, 0.55]) {
      const stay = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.05), M.blackMatte);
      stay.position.set(-2.1, 0.86, side);
      this.model.add(stay);
    }

    // fender arches over the four wheels
    const fenderGeo = new THREE.CylinderGeometry(0.44, 0.44, 0.36, 12, 1, true, 0, Math.PI);
    fenderGeo.rotateX(Math.PI / 2);
    fenderGeo.rotateY(Math.PI / 2);
    for (const [fx, fz] of [[1.48, 0.8], [1.48, -0.8], [-1.48, 0.8], [-1.48, -0.8]]) {
      const fender = new THREE.Mesh(fenderGeo, M.paint);
      fender.position.set(fx, 0.33, fz);
      this.model.add(fender);
    }

    // lights
    for (const side of [-0.52, 0.52]) {
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.3), M.headlight);
      head.position.set(2.41, 0.45, side);
      this.model.add(head);

      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, 0.36), M.tail);
      tail.position.set(-2.4, 0.6, side);
      this.model.add(tail);
    }
    const reverseLight = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.16), M.reverse);
    reverseLight.position.set(-2.4, 0.45, 0);
    this.model.add(reverseLight);

    // exhausts
    for (const side of [-0.28, 0.28]) {
      const pipe = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 0.12, 8).rotateX(Math.PI / 2),
        M.chrome
      );
      pipe.position.set(-2.4, 0.3, side);
      this.model.add(pipe);
    }

    this.model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });
  }

  _buildWheels() {
    const R = 0.33;
    const tireGeo = new THREE.CylinderGeometry(R, R, 0.3, 18);
    tireGeo.rotateX(Math.PI / 2); // axle along Z (model space = car width)

    // merged rim: hub disc + five spokes
    const rimParts = [];
    rimParts.push(new THREE.CylinderGeometry(0.2, 0.2, 0.32, 12).rotateX(Math.PI / 2));
    rimParts.push(new THREE.CylinderGeometry(0.055, 0.055, 0.36, 8).rotateX(Math.PI / 2));
    for (let i = 0; i < 5; i++) {
      const spoke = new THREE.BoxGeometry(0.4, 0.055, 0.26);
      spoke.rotateZ((i / 5) * Math.PI * 2);
      rimParts.push(spoke);
    }
    const rimGeo = mergeGeometries(rimParts);

    this.wheels = [];
    const positions = [
      { x: 1.48, z: 0.8, front: true },
      { x: 1.48, z: -0.8, front: true },
      { x: -1.48, z: 0.8, front: false },
      { x: -1.48, z: -0.8, front: false }
    ];
    for (const pos of positions) {
      const steerGroup = new THREE.Group();
      steerGroup.position.set(pos.x, R, pos.z);

      const spinGroup = new THREE.Group();
      steerGroup.add(spinGroup);

      const tire = new THREE.Mesh(tireGeo, this.mats.tire);
      tire.castShadow = true;
      spinGroup.add(tire);

      const rim = new THREE.Mesh(rimGeo, this.mats.chrome);
      rim.castShadow = true;
      spinGroup.add(rim);

      this.model.add(steerGroup);
      this.wheels.push({ steerGroup, spinGroup, front: pos.front });
    }
  }

  /**
   * Sync visuals to physics state. Call once per rendered frame.
   */
  updateVisual(dt, phys) {
    this._time += dt;

    this.group.position.set(phys.position.x, 0.04, phys.position.z);
    this.group.rotation.y = phys.heading;

    // wheel spin + steering
    // (negative sign: the model is authored nose=+X and wrapped -90°, so a
    // positive physics steer (car-right) is a negative local yaw)
    const spinRate = phys.vF / 0.33;
    for (const w of this.wheels) {
      w.spinGroup.rotation.z -= spinRate * dt;
      if (w.front) w.steerGroup.rotation.y = -phys.steerAngle;
    }

    // smoothed longitudinal acceleration for pitch
    const rawAccel = dt > 0 ? (phys.vF - this._prevVF) / dt : 0;
    this._prevVF = phys.vF;
    this._accel = THREE.MathUtils.damp(this._accel, rawAccel, 4, dt);

    // body roll from lateral acceleration (lean outward), pitch from accel
    // (right turn -> yaw negative -> -latAccel positive -> leans left/outward)
    const roll = THREE.MathUtils.clamp(-phys.latAccel * 0.0042, -0.06, 0.06);
    const pitch = THREE.MathUtils.clamp(this._accel * 0.0035, -0.045, 0.045);
    this.model.rotation.x = THREE.MathUtils.damp(this.model.rotation.x, roll, 7, dt);
    this.model.rotation.z = THREE.MathUtils.damp(this.model.rotation.z, pitch, 7, dt);

    // curb rumble bounce
    const speed = Math.abs(phys.vF);
    const target = phys.onCurb && speed > 6 ? Math.sin(this._time * 52) * 0.022 : 0;
    this._bounce = THREE.MathUtils.damp(this._bounce, target, 20, dt);
    this.model.position.y = this._bounce;

    // brake + reverse lights
    const braking = phys.brakeOut > 0.15 && phys.vF > 0.4;
    this.mats.tail.emissiveIntensity = braking ? 3.4 : 0.55;
    this.mats.reverse.emissiveIntensity = phys.reversing ? 2.6 : 0.12;
  }
}
