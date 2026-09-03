/**
 * Car — Audi-inspired GT racing car, fully procedural (no external assets).
 *
 * The model is authored with the nose along +X inside `model` (wrapped -90°
 * about Y so the nose points at +Z world). `body` carries the hull + interior
 * and receives suspension roll/pitch/bounce; the four wheel assemblies hang
 * off `model` directly so they track the road while the body leans.
 *
 * Exterior: sculpted hull, Audi singleframe grille + four-rings badges,
 * front/rear bumpers with intake & diffuser, hood bulge, side skirts, doors,
 * mirrors, big racing wing with endplates, quad exhaust tips, LED lights,
 * and proper wheel arches: body-coloured flares + dark wheel-well liners so
 * the tires never visually intersect the painted bodywork.
 * Interior (Interior.js): Audi RS/R8-style cockpit — high-poly flat-bottom
 * steering wheel with four-rings hub + paddles, live Virtual Cockpit display,
 * MMI touchscreen minimap, RS bucket seats, aluminum pedals, ambient light.
 * Wheels: tire / 5-spoke rim / brake disc (spins) / caliper (steers, not spin).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAR, SUSPENSION, HEADLIGHTS } from './Constants.js';
import { buildInterior, drawCluster, drawMMI } from './Interior.js';

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

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

export class Car {
  constructor(track = null) {
    this.track = track;

    this.group = new THREE.Group();      // world transform (position + heading)
    this.model = new THREE.Group();      // static wrap: nose +X -> +Z
    this.model.rotation.y = -Math.PI / 2;
    this.group.add(this.model);

    this.body = new THREE.Group();       // suspension roll/pitch/bounce
    this.model.add(this.body);

    this._buildMaterials();
    this._buildExterior();
    this._buildArches();
    this._buildWheels();
    this._buildHeadlights();

    // Audi RS/R8 cockpit: dash, screens, high-poly steering wheel, seats,
    // pedals, driver — sets cockpitAnchor / steering refs / helmet too.
    buildInterior(this);

    this._prevVF = 0;
    this._spinAngle = 0;
    this._steerVis = 0;
    this._time = 0;
    this._clusterAcc = 1;
    this._indicatorT = 0;

    // spring-damper body bounce state
    this._bodyY = 0;
    this._bodyYV = 0;

    this.cockpitMode = false;
  }

  // ------------------------------------------------------------------ mats
  _buildMaterials() {
    this.mats = {
      // clearcoat paint — deep Audi red with a lacquer layer that catches
      // the floodlights and moonlight
      paint: new THREE.MeshPhysicalMaterial({
        color: 0xb0121a, metalness: 0.62, roughness: 0.34, flatShading: true,
        clearcoat: 1.0, clearcoatRoughness: 0.14, envMapIntensity: 1.15
      }),
      paintDark: new THREE.MeshStandardMaterial({
        color: 0x5c0d0d, metalness: 0.7, roughness: 0.42, flatShading: true
      }),
      blackMatte: new THREE.MeshStandardMaterial({
        color: 0x14161a, metalness: 0.12, roughness: 0.88
      }),
      blackGloss: new THREE.MeshStandardMaterial({
        color: 0x0c0e11, metalness: 0.4, roughness: 0.35
      }),
      glass: new THREE.MeshStandardMaterial({
        color: 0x0d141b, metalness: 0.9, roughness: 0.08,
        transparent: true, opacity: 0.5, envMapIntensity: 1.6,
        depthWrite: false
      }),
      chrome: new THREE.MeshStandardMaterial({
        color: 0xd8dde2, metalness: 1.0, roughness: 0.22, envMapIntensity: 1.3
      }),
      rim: new THREE.MeshStandardMaterial({
        color: 0xb7bec7, metalness: 0.9, roughness: 0.32, envMapIntensity: 1.1
      }),
      tire: new THREE.MeshStandardMaterial({
        color: 0x121212, roughness: 0.97, metalness: 0
      }),
      disc: new THREE.MeshStandardMaterial({
        color: 0x8f979e, metalness: 1.0, roughness: 0.42
      }),
      caliper: new THREE.MeshStandardMaterial({
        color: 0xd23a1e, metalness: 0.3, roughness: 0.5
      }),
      interior: new THREE.MeshStandardMaterial({
        color: 0x191c21, metalness: 0.05, roughness: 0.94
      }),
      interiorSoft: new THREE.MeshStandardMaterial({
        color: 0x23262c, metalness: 0.05, roughness: 0.9
      }),
      accent: new THREE.MeshStandardMaterial({
        color: 0xd23a1e, metalness: 0.4, roughness: 0.5
      }),
      headlight: new THREE.MeshStandardMaterial({
        color: 0xaeb49e, emissive: 0xf2f8ff, emissiveIntensity: 3.6,
        metalness: 0.2, roughness: 0.3
      }),
      tail: new THREE.MeshStandardMaterial({
        color: 0x400704, emissive: 0xff2016, emissiveIntensity: 1.6,
        roughness: 0.4
      }),
      reverse: new THREE.MeshStandardMaterial({
        color: 0x3a3a3a, emissive: 0xffffff, emissiveIntensity: 0.12
      }),
      indicator: new THREE.MeshStandardMaterial({
        color: 0x6b4408, emissive: 0xffa114, emissiveIntensity: 0.15,
        roughness: 0.4
      }),
      helmet: new THREE.MeshStandardMaterial({
        color: 0xf2f4f6, roughness: 0.28, metalness: 0.08
      }),
      helmetVisor: new THREE.MeshStandardMaterial({
        color: 0x101418, metalness: 0.8, roughness: 0.15
      }),
      well: new THREE.MeshStandardMaterial({
        color: 0x0b0c0e, roughness: 0.95, metalness: 0.05,
        side: THREE.DoubleSide
      })
    };
  }

  // -------------------------------------------------------------- exterior
  _buildExterior() {
    const M = this.mats;
    const paint = [], trim = [], gloss = [], glass = [];

    // main hull — side profile (x: nose -> tail, y: up)
    paint.push(extrudeShape([
      [2.18, 0.16], [2.26, 0.34], [2.24, 0.56], [2.02, 0.64],
      [1.06, 0.74], [0.26, 1.15], [-0.58, 1.21], [-1.32, 1.03],
      [-1.97, 0.94], [-2.2, 0.8], [-2.24, 0.44], [-2.16, 0.17],
      [-1.0, 0.13], [1.0, 0.13]
    ], 1.48, 0.05));

    // hood power bulge
    paint.push(box(0.9, 0.05, 0.62, 1.45, 0.775, 0));

    // doors: seam lines + handles (thin dark strips slightly proud)
    trim.push(box(0.02, 0.42, 0.015, 0.52, 0.56, 0.755));
    trim.push(box(0.02, 0.42, 0.015, 0.52, 0.56, -0.755));
    trim.push(box(0.02, 0.4, 0.015, -0.62, 0.55, 0.755));
    trim.push(box(0.02, 0.4, 0.015, -0.62, 0.55, -0.755));
    trim.push(box(0.16, 0.035, 0.03, 0.28, 0.7, 0.765));
    trim.push(box(0.16, 0.035, 0.03, 0.28, 0.7, -0.765));

    // side skirts
    trim.push(box(2.3, 0.12, 0.14, 0.0, 0.17, 0.83));
    trim.push(box(2.3, 0.12, 0.14, 0.0, 0.17, -0.83));

    // front bumper: intake + slats + splitter
    trim.push(box(0.3, 0.34, 1.72, 2.2, 0.34, 0));
    for (const z of [-0.5, 0, 0.5]) trim.push(box(0.24, 0.2, 0.05, 2.32, 0.3, z));
    trim.push(box(0.42, 0.05, 1.86, 2.24, 0.13, 0));
    // rear bumper + diffuser shell
    trim.push(box(0.26, 0.4, 1.76, -2.24, 0.36, 0));
    trim.push(box(0.3, 0.16, 1.66, -2.26, 0.2, 0));
    for (let i = -3; i <= 3; i++) {
      trim.push(box(0.3, 0.16, 0.03, -2.24, 0.18, i * 0.22));
    }

    // racing wing: blade, endplates, stanchions
    trim.push(box(0.4, 0.045, 1.86, -2.06, 1.13, 0));
    trim.push(box(0.06, 0.24, 0.3, -2.06, 1.06, 0.93));
    trim.push(box(0.06, 0.24, 0.3, -2.06, 1.06, -0.93));
    trim.push(box(0.16, 0.26, 0.05, -1.98, 0.98, 0.5));
    trim.push(box(0.16, 0.26, 0.05, -1.98, 0.98, -0.5));

    // ducktail lip
    trim.push(box(0.18, 0.05, 1.5, -2.06, 0.98, 0));

    // glass canopy: windshield band + side windows + rear window
    glass.push(extrudeShape([
      [1.0, 0.755], [0.24, 1.17], [-0.56, 1.225], [-1.3, 1.045],
      [-1.34, 0.83], [-0.5, 0.75]
    ], 1.56, 0.03));
    // opaque dark side-glass panels just outside the hull wall — from the
    // cabin they read as tinted windows instead of showing the red hull side
    gloss.push(box(1.9, 0.30, 0.03, -0.45, 0.99, 0.752));
    gloss.push(box(1.9, 0.30, 0.03, -0.45, 0.99, -0.752));
    // cowl side panels (inside the hull, visible only from the cabin —
    // block the red fender tops past the dash edges)
    gloss.push(box(0.95, 0.22, 0.03, 1.02, 0.91, 0.72));
    gloss.push(box(0.95, 0.22, 0.03, 1.02, 0.91, -0.72));

    // mirrors
    for (const side of [1, -1]) {
      trim.push(box(0.05, 0.03, 0.14, 0.78, 0.86, side * 0.82));
      paint.push(box(0.10, 0.07, 0.13, 0.76, 0.9, side * 0.95));
      trim.push(box(0.02, 0.07, 0.12, 0.695, 0.9, side * 0.95));
    }

    // exhausts: quad tips
    for (const z of [-0.34, -0.22, 0.22, 0.34]) {
      const pipe = new THREE.CylinderGeometry(0.045, 0.05, 0.16, 8).rotateX(Math.PI / 2);
      pipe.translate(-2.32, 0.28, z);
      gloss.push(pipe);
      const inner = new THREE.CylinderGeometry(0.032, 0.032, 0.17, 8).rotateX(Math.PI / 2);
      inner.translate(-2.325, 0.28, z);
      trim.push(inner);
    }

    // lights
    for (const side of [-1, 1]) {
      trim.push(box(0.1, 0.13, 0.34, 2.18, 0.56, side * 0.6));
      gloss.push(box(0.04, 0.1, 0.28, 2.235, 0.56, side * 0.6));
      gloss.push(box(0.03, 0.06, 0.1, 2.24, 0.4, side * 0.8));
      gloss.push(box(0.03, 0.06, 0.1, -2.3, 0.52, side * 0.84));
    }
    // full-width tail bar + reverse light
    gloss.push(box(0.04, 0.09, 1.6, -2.345, 0.68, 0));
    gloss.push(box(0.03, 0.06, 0.14, -2.34, 0.4, 0));

    // --- Audi singleframe grille + four rings badges -------------------------
    gloss.push(box(0.03, 0.05, 0.74, 2.30, 0.665, 0));      // top bar
    gloss.push(box(0.03, 0.05, 0.74, 2.30, 0.415, 0));      // bottom bar
    gloss.push(box(0.03, 0.30, 0.05, 2.30, 0.54, 0.355));   // right post
    gloss.push(box(0.03, 0.30, 0.05, 2.30, 0.54, -0.355));  // left post
    trim.push(box(0.02, 0.22, 0.68, 2.285, 0.54, 0));       // grille insert

    const ringsF = [], ringsR = [];
    for (let i = 0; i < 4; i++) {
      const rf = new THREE.TorusGeometry(0.034, 0.005, 8, 24);
      rf.rotateY(Math.PI / 2);
      rf.translate(2.30, 0.745, (i - 1.5) * 0.052);
      ringsF.push(rf);
      const rr = new THREE.TorusGeometry(0.026, 0.0045, 8, 24);
      rr.rotateY(Math.PI / 2);
      rr.translate(-2.30, 0.585, (i - 1.5) * 0.040);
      ringsR.push(rr);
    }
    this.body.add(new THREE.Mesh(mergeGeometries(ringsF.map((g) => g.toNonIndexed()), false), M.chrome));
    this.body.add(new THREE.Mesh(mergeGeometries(ringsR.map((g) => g.toNonIndexed()), false), M.chrome));

    this._addMeshes(paint, M.paint, true, true);
    this._addMeshes(trim, M.blackMatte, true, false);
    this._addMeshes(gloss, M.blackGloss, true, false);
    this._addMeshes(glass, M.glass, false, false);
  }

  /**
   * Wheel arches: body-coloured flares wrapped over each wheel + dark
   * wheel-well liners. The liner hides the hull side wall behind the tire so
   * the tire can never look like it is overlapping/bleeding into the body.
   */
  _buildArches() {
    const M = this.mats;
    const R = CAR.wheelRadius;
    const archOuter = R + 0.20;   // capped so the flare stays below the window sill
    const archInner = R + 0.065;
    const flare = [], liners = [];

    for (const [cx, cz] of [[1.48, 0.82], [1.48, -0.82], [-1.48, 0.82], [-1.48, -0.82]]) {
      // flare: annulus sector over the top of the wheel, extruded across it.
      // The extrude starts AT the hull side wall (z = ±0.74) and goes outward
      // so no flare surface pokes into the cabin (visible through windows).
      const shape = new THREE.Shape();
      const a0 = THREE.MathUtils.degToRad(8);
      const a1 = Math.PI - a0;
      shape.absarc(0, 0, archOuter, a0, a1, false);
      shape.absarc(0, 0, archInner, a1, a0, true);
      shape.closePath();
      const g = new THREE.ExtrudeGeometry(shape, {
        depth: 0.34, bevelEnabled: true,
        bevelThickness: 0.025, bevelSize: 0.02, bevelSegments: 2,
        curveSegments: 26
      });
      // translate to the wheel: X = front/rear position (cx!), Y over the
      // wheel centre, Z starts at the hull side wall and extrudes outward.
      // (Missing cx here used to pile all four flares at x=0 — a stray arch
      // across the doors — leaving the real wheels bare: the "overlapping
      // tire" bug.)
      g.translate(cx, R, cz > 0 ? 0.74 : -1.08);
      flare.push(g);

      // dark well liner: open half-cylinder over the top of the tire
      const lg = new THREE.CylinderGeometry(
        R + 0.055, R + 0.055, 0.34, 16, 1, true, Math.PI / 2, Math.PI
      );
      lg.rotateX(Math.PI / 2);
      lg.translate(cx, R, cz + Math.sign(cz) * 0.07);
      liners.push(lg);
    }

    this._addMeshes(flare, M.paint, true, false);
    const linerMesh = new THREE.Mesh(mergeGeometries(liners.map((g) => g.toNonIndexed()), false), M.well);
    this.body.add(linerMesh);
  }

  // ---------------------------------------------------------- headlights
  /**
   * Real headlight rig: two spotlights aimed down the road (no shadows —
   * cheap) plus emissive lenses. This is what makes the night track readable
   * and dangerous: the world ahead only exists as far as the beams reach.
   */
  _buildHeadlights() {
    const mk = (z) => {
      const light = new THREE.SpotLight(
        HEADLIGHTS.color, HEADLIGHTS.intensity,
        HEADLIGHTS.distance, HEADLIGHTS.angle, HEADLIGHTS.penumbra, HEADLIGHTS.decay
      );
      light.position.set(2.05, 0.62, z);
      light.castShadow = false;
      const target = new THREE.Object3D();
      target.position.set(34, -1.4, z * 1.35);
      this.body.add(light);
      this.body.add(target);
      light.target = target;
      return light;
    };
    this.headlightL = mk(0.62);
    this.headlightR = mk(-0.62);

    // lens halos (fake bloom — additive sprites, cheap on every GPU)
    if (!this.mats.glowTex) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      const c = cv.getContext('2d');
      const g = c.createRadialGradient(64, 64, 4, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.4, 'rgba(255,255,255,0.28)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 128, 128);
      this.mats.glowTex = new THREE.CanvasTexture(cv);
      this.mats.glowTex.colorSpace = THREE.SRGBColorSpace;
    }
    const headGlow = new THREE.SpriteMaterial({
      map: this.mats.glowTex, color: 0xeaf4ff, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    for (const z of [0.6, -0.6]) {
      const sp = new THREE.Sprite(headGlow);
      sp.position.set(2.28, 0.56, z);
      sp.scale.set(0.55, 0.35, 1);
      this.body.add(sp);
    }
    // tail bar halo — brightness driven by braking in updateVisual
    this.tailGlowMat = new THREE.SpriteMaterial({
      map: this.mats.glowTex, color: 0xff2418, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    const tailSp = new THREE.Sprite(this.tailGlowMat);
    tailSp.position.set(-2.4, 0.68, 0);
    tailSp.scale.set(1.7, 0.55, 1);
    this.body.add(tailSp);
  }

  _addMeshes(geos, mat, castShadow, receive) {
    if (!geos.length) return null;
    // ExtrudeGeometry is non-indexed while primitives are indexed —
    // normalize everything so mergeGeometries never refuses the batch
    const normalized = geos.map((g) => (g.index ? g.toNonIndexed() : g));
    const merged = mergeGeometries(normalized, false);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
    this.body.add(mesh);
    return mesh;
  }

  // -------------------------------------------------------------- wheels
  _buildWheels() {
    const M = this.mats;
    const R = CAR.wheelRadius;

    // tire: cylinder + shoulder tori
    // (wheel axle is model Z: cylinder rotated Y->Z; tori keep their default
    //  Z axis so they lie flat in the wheel plane)
    const tireGeo = new THREE.CylinderGeometry(R, R, 0.27, 24);
    tireGeo.rotateX(Math.PI / 2);
    const shoulderGeo = new THREE.TorusGeometry(R - 0.012, 0.024, 8, 24);

    // rim: outer ring + hub + 5 spokes (merged) — all in the XY wheel plane
    const rimParts = [];
    rimParts.push(new THREE.TorusGeometry(0.195, 0.03, 8, 24));
    const hub = new THREE.CylinderGeometry(0.062, 0.062, 0.24, 12);
    hub.rotateX(Math.PI / 2);
    rimParts.push(hub);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spoke = new THREE.BoxGeometry(0.03, 0.3, 0.05);
      spoke.rotateZ(a);
      rimParts.push(spoke);
    }
    const rimGeo = mergeGeometries(rimParts, false);

    const discGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.028, 18);
    discGeo.rotateX(Math.PI / 2);
    const caliperGeo = box(0.1, 0.16, 0.05, 0, 0.02, 0);

    this.wheels = [];
    const positions = [
      { x: 1.48, z: 0.82, front: true },
      { x: 1.48, z: -0.82, front: true },
      { x: -1.48, z: 0.82, front: false },
      { x: -1.48, z: -0.82, front: false }
    ];
    for (const pos of positions) {
      const steerGroup = new THREE.Group();
      steerGroup.position.set(pos.x, R, pos.z);

      const suspGroup = new THREE.Group();
      steerGroup.add(suspGroup);

      const spinGroup = new THREE.Group();
      suspGroup.add(spinGroup);

      const tire = new THREE.Mesh(tireGeo, M.tire);
      tire.castShadow = true;
      spinGroup.add(tire);
      const shoulder = new THREE.Mesh(shoulderGeo, M.tire);
      shoulder.position.z = 0.135;
      spinGroup.add(shoulder);
      const shoulder2 = new THREE.Mesh(shoulderGeo, M.tire);
      shoulder2.position.z = -0.135;
      spinGroup.add(shoulder2);

      const rimMesh = new THREE.Mesh(rimGeo, M.rim);
      rimMesh.castShadow = true;
      spinGroup.add(rimMesh);

      const disc = new THREE.Mesh(discGeo, M.disc);
      disc.position.z = pos.z > 0 ? 0.09 : -0.09;
      spinGroup.add(disc);

      // caliper does not spin — hangs off the upright (steer group)
      const caliper = new THREE.Mesh(caliperGeo, M.caliper);
      caliper.position.z = (pos.z > 0 ? 0.09 : -0.09);
      steerGroup.add(caliper);

      this.model.add(steerGroup);
      this.wheels.push({ steerGroup, suspGroup, spinGroup, front: pos.front, side: Math.sign(pos.z) });
    }
  }

  // ------------------------------------------------------------ per-frame
  /**
   * Sync visuals to physics state. Call once per rendered frame.
   * @param {number} dt
   * @param {VehiclePhysics} phys
   * @param {Transmission} trans
   * @param {RaceSystem} [race] — optional, feeds the Virtual Cockpit lap info
   */
  updateVisual(dt, phys, trans, race = null) {
    this._time += dt;

    this.group.position.set(phys.position.x, phys.position.y + 0.02, phys.position.z);
    this.group.rotation.y = phys.heading;

    // ---- wheels: spin (physically vF/R), steer, suspension travel ----------
    const R = CAR.wheelRadius;
    let spinRate = phys.vF / R;
    if (phys.wheelspin && trans.gear > 0) spinRate += 26;   // flare
    if (trans.wheelspin && trans.gear < 0) spinRate -= 14;
    this._spinAngle -= spinRate * dt;

    const steerTarget = -phys.steerAngle;
    this._steerVis = THREE.MathUtils.damp(this._steerVis, steerTarget, 12, dt);

    const susp = phys.suspSmooth;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.spinGroup.rotation.z = this._spinAngle;
      if (w.front) w.steerGroup.rotation.y = this._steerVis;
      const travel = (susp[i] - 0.5) * 2 * SUSPENSION.travel;
      w.suspGroup.position.y = travel;
    }

    // ---- body attitude: road slope + suspension roll/pitch + bounce --------
    const roll = THREE.MathUtils.clamp(
      (susp[1] + susp[3] - susp[0] - susp[2]) * 0.5 * SUSPENSION.rollG * 6,
      -SUSPENSION.maxRoll, SUSPENSION.maxRoll
    );
    const pitch = THREE.MathUtils.clamp(
      (susp[2] + susp[3] - susp[0] - susp[1]) * 0.5 * SUSPENSION.accelPitch * 6,
      -SUSPENSION.maxPitch, SUSPENSION.maxPitch
    );
    // model frame (nose +X): pitch about Z, roll about X
    this.body.rotation.z = THREE.MathUtils.damp(
      this.body.rotation.z, pitch + phys.roadPitch, 8, dt);
    this.body.rotation.x = THREE.MathUtils.damp(
      this.body.rotation.x, roll + phys.roadRoll, 8, dt);

    // spring-damper body bounce (curbs / bumps settle naturally)
    const avgComp = (susp[0] + susp[1] + susp[2] + susp[3]) / 4;
    const targetY = -(avgComp - 0.5) * SUSPENSION.travel * 1.6;
    const k = 90, c = 13;                                   // ~1.5 Hz, slightly underdamped
    const accel = (targetY - this._bodyY) * k - this._bodyYV * c;
    this._bodyYV += accel * dt;
    this._bodyY += this._bodyYV * dt;
    let bounceY = this._bodyY;
    if (phys.onCurb && Math.abs(phys.vF) > 6) {
      bounceY += Math.sin(this._time * SUSPENSION.bumpCurbFreq) * 0.012 * SUSPENSION.bumpCurbAmp * 2;
    }
    this.body.position.y = THREE.MathUtils.clamp(bounceY, -0.1, 0.1);

    // ---- steering wheel + shifter + pedals ---------------------------------
    const steerVisNorm = this._steerVis / 0.5;
    this.steeringSpin.rotation.x = -steerVisNorm * 2.4;      // ~137° lock-to-lock feel
    this.shifterGroup.rotation.z = -trans.shifterX * 0.3;
    this.shifterGroup.rotation.x = trans.shifterZ * 0.24;
    this.pedalThrottle.rotation.z = -0.35 + phys.throttleOut * 0.25;
    this.pedalBrake.rotation.z = -0.35 + phys.brakeOut * 0.3;
    this.handbrakeLever.rotation.z = phys.brakeOut > 0 && phys.vF < 1 ? 0.5 : 0.9;

    // ---- lights -------------------------------------------------------------
    const braking = phys.brakeOut > 0.15 && phys.vF > 0.4;
    this.mats.tail.emissiveIntensity = braking ? 4.4 : 1.7;
    this.mats.reverse.emissiveIntensity = phys.reversing ? 2.8 : 0.12;
    if (this.tailGlowMat) this.tailGlowMat.opacity = braking ? 0.8 : 0.32;

    // turn indicators: blink toward steering input
    this._indicatorT += dt;
    const blinkOn = Math.sin(this._indicatorT * 7) > 0;
    const steerNorm = phys.steerAngle / 0.5;
    const blink = (steerNorm < -0.3 || steerNorm > 0.3) && blinkOn;
    this.mats.indicator.emissiveIntensity = blink ? 3.2 : 0.15;

    // ---- ambient light line: slow breathing pulse ----------------------------
    if (this.mats.ambient) {
      this.mats.ambient.emissiveIntensity = 1.5 + Math.sin(this._time * 2.1) * 0.35;
    }

    // ---- cockpit visibility -------------------------------------------------
    this.helmet.visible = !this.cockpitMode;

    // ---- live Virtual Cockpit (~20 Hz) ----------------------------------------
    this._clusterAcc += dt;
    if (this._clusterAcc > 0.05) {
      this._clusterAcc = 0;
      drawCluster(this, trans.rpmNorm, phys.speedKmh, trans.gearLabel, trans.limiterCut, race);
    }
    // ---- MMI minimap (~4 Hz) ---------------------------------------------------
    this._mmiAcc += dt;
    if (this._mmiAcc > 0.25) {
      this._mmiAcc = 0;
      drawMMI(this, ((phys.s % 1) + 1) % 1);
    }
  }
}
