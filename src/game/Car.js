/**
 * Car — detailed low-poly GT racing car, fully procedural (no external assets).
 *
 * The model is authored with the nose along +X inside `model` (wrapped -90°
 * about Y so the nose points at +Z world). `body` carries the hull + interior
 * and receives suspension roll/pitch/bounce; the four wheel assemblies hang
 * off `model` directly so they track the road while the body leans.
 *
 * Exterior: sculpted hull, front/rear bumpers with intake & diffuser, hood
 * bulge, side skirts, doors with seams + handles, mirrors, big racing wing
 * with endplates, quad exhaust tips, headlight lenses, full-width tail bar,
 * turn indicators, splitter.
 * Interior: dash with live canvas instrument cluster, steering wheel that
 * rotates with input, animated gear shifter, pedals, bucket seats, tunnel,
 * handbrake, mirror — everything the cockpit camera needs.
 * Wheels: tire / 5-spoke rim / brake disc (spins) / caliper (steers, not spin).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAR, SUSPENSION } from './Constants.js';

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
  constructor() {
    this.group = new THREE.Group();      // world transform (position + heading)
    this.model = new THREE.Group();      // static wrap: nose +X -> +Z
    this.model.rotation.y = -Math.PI / 2;
    this.group.add(this.model);

    this.body = new THREE.Group();       // suspension roll/pitch/bounce
    this.model.add(this.body);

    this._buildMaterials();
    this._buildExterior();
    this._buildInterior();
    this._buildCluster();
    this._buildWheels();

    // cockpit eye anchor (lives on body so it follows suspension)
    // body space: +X nose, +Y up, +Z car-left (driver side)
    this.cockpitAnchor = new THREE.Object3D();
    this.cockpitAnchor.position.set(-0.55, 1.03, 0.325);
    this.body.add(this.cockpitAnchor);

    this.helmet = this._buildDriver();

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
      paint: new THREE.MeshStandardMaterial({
        color: 0xc4271e, metalness: 0.72, roughness: 0.3, flatShading: true,
        envMapIntensity: 1.25
      }),
      paintDark: new THREE.MeshStandardMaterial({
        color: 0x7e1812, metalness: 0.7, roughness: 0.42, flatShading: true
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
        color: 0xaeb49e, emissive: 0xfff3d8, emissiveIntensity: 1.8,
        metalness: 0.2, roughness: 0.3
      }),
      tail: new THREE.MeshStandardMaterial({
        color: 0x400704, emissive: 0xff2016, emissiveIntensity: 0.6,
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

    // fender volumes widen the body over the wheels
    for (const [fx, fz] of [[1.48, 0.72], [1.48, -0.72], [-1.48, 0.72], [-1.48, -0.72]]) {
      const g = extrudeShape([
        [fx + 0.78, 0.3], [fx + 0.86, 0.52], [fx + 0.6, 0.68],
        [fx - 0.6, 0.68], [fx - 0.86, 0.5], [fx - 0.78, 0.3]
      ], 0.46, 0.05);
      g.translate(0, 0, fz > 0 ? fz - 0.23 : fz + 0.23);
      // keep the arches from poking through the nose/tail
      paint.push(g);
    }

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
      const fin = box(0.3, 0.16, 0.03, -2.24, 0.18, i * 0.22);
      fin.rotateZ ? fin.rotateZ(0) : null;
      trim.push(fin);
    }

    // racing wing: blade, endplates, stanchions
    const blade = box(0.4, 0.045, 1.86, -2.06, 1.13, 0);
    trim.push(blade);
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

    // mirrors
    for (const side of [1, -1]) {
      trim.push(box(0.05, 0.03, 0.14, 0.78, 0.86, side * 0.82));
      const shell = box(0.12, 0.09, 0.16, 0.76, 0.9, side * 0.95);
      paint.push(shell);
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
      // headlight housing + lens
      trim.push(box(0.1, 0.13, 0.34, 2.18, 0.56, side * 0.6));
      gloss.push(box(0.04, 0.1, 0.28, 2.235, 0.56, side * 0.6));
      // tail light bar handled below (full width)
      // indicators
      gloss.push(box(0.03, 0.06, 0.1, 2.24, 0.4, side * 0.8));
      gloss.push(box(0.03, 0.06, 0.1, -2.3, 0.52, side * 0.84));
    }
    // full-width tail bar + reverse light
    gloss.push(box(0.04, 0.09, 1.6, -2.345, 0.68, 0));
    gloss.push(box(0.03, 0.06, 0.14, -2.34, 0.4, 0));

    this._addMeshes(paint, M.paint, true, true);
    this._addMeshes(trim, M.blackMatte, true, false);
    this._addMeshes(gloss, M.blackGloss, true, false);
    this._addMeshes(glass, M.glass, false, false);
  }

  _addMeshes(geos, mat, castShadow, receive) {
    if (!geos.length) return;
    // ExtrudeGeometry is non-indexed while primitives are indexed —
    // normalize everything so mergeGeometries never refuses the batch
    const normalized = geos.map((g) => (g.index ? g.toNonIndexed() : g));
    const merged = mergeGeometries(normalized, false);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
    this.body.add(mesh);
  }

  // -------------------------------------------------------------- interior
  _buildInterior() {
    const M = this.mats;
    const dark = [], soft = [];

    // tub: floor, tunnel, rear bulkhead, footwells
    dark.push(box(2.2, 0.06, 1.4, -0.2, 0.2, 0));
    dark.push(box(1.9, 0.3, 0.26, -0.25, 0.36, 0));          // tunnel
    dark.push(box(0.06, 0.62, 1.4, -1.28, 0.55, 0));         // bulkhead
    dark.push(box(0.7, 0.5, 1.42, 0.72, 0.42, 0));           // dash block
    dark.push(box(0.16, 0.6, 1.42, 0.42, 0.55, 0));          // dash face
    // dash top pad
    soft.push(box(0.3, 0.05, 1.42, 0.56, 0.845, 0));
    // door cards
    for (const s of [1, -1]) {
      dark.push(box(1.7, 0.5, 0.05, -0.35, 0.5, s * 0.72));
      soft.push(box(1.5, 0.08, 0.09, -0.35, 0.62, s * 0.7));  // armrest
    }
    // roof lining
    soft.push(box(1.4, 0.04, 1.3, -0.4, 1.17, 0));

    // bucket seats (driver z +0.33, passenger z -0.33)
    for (const z of [0.33, -0.33]) {
      soft.push(box(0.5, 0.12, 0.52, -0.55, 0.32, z));        // cushion
      const back = box(0.14, 0.62, 0.5, -0.85, 0.68, z);
      soft.push(back);
      soft.push(box(0.12, 0.2, 0.3, -0.86, 1.06, z));         // headrest
      dark.push(box(0.02, 0.56, 0.36, -0.77, 0.68, z));       // accent panel
    }

    // pedals (throttle + brake) — visible looking down from the seat
    this.pedalThrottle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.14, 0.07), M.interiorSoft);
    this.pedalThrottle.position.set(0.98, 0.33, 0.4);
    this.pedalThrottle.rotation.z = -0.35;
    this.body.add(this.pedalThrottle);
    this.pedalBrake = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.09), M.interiorSoft);
    this.pedalBrake.position.set(0.98, 0.36, 0.26);
    this.pedalBrake.rotation.z = -0.35;
    this.body.add(this.pedalBrake);

    // handbrake lever
    const hbBase = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.06), M.interior);
    hbBase.position.set(-0.05, 0.52, 0.16);
    this.body.add(hbBase);
    this.handbrakeLever = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.26, 6), M.interiorSoft);
    this.handbrakeLever.position.set(-0.14, 0.63, 0.16);
    this.handbrakeLever.rotation.z = 0.9;
    this.body.add(this.handbrakeLever);

    // center screen (small infotainment, faces driver)
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.24, 0.13),
      new THREE.MeshStandardMaterial({ color: 0x0a2a3a, emissive: 0x0d3a52, emissiveIntensity: 0.7 })
    );
    screen.position.set(0.42, 0.82, 0.05);
    screen.rotation.y = Math.PI / 2 + 0.18;
    screen.rotation.x = -0.1;
    this.body.add(screen);

    this._addMeshes(dark, M.interior, false, false);
    this._addMeshes(soft, M.interiorSoft, false, false);

    // ---- steering wheel (rotates with input) --------------------------------
    this.steeringTilt = new THREE.Group();
    this.steeringTilt.position.set(0.58, 0.85, 0.33);
    this.steeringTilt.rotation.z = -0.42;   // column rake
    this.body.add(this.steeringTilt);

    this.steeringSpin = new THREE.Group();
    this.steeringTilt.add(this.steeringSpin);

    const rimGeo = new THREE.TorusGeometry(0.155, 0.027, 8, 20);
    rimGeo.rotateY(Math.PI / 2);
    const rim = new THREE.Mesh(rimGeo, M.interiorSoft);
    this.steeringSpin.add(rim);

    const spokes = [];
    spokes.push(box(0.02, 0.03, 0.3, 0, 0, 0));       // horizontal
    spokes.push(box(0.02, 0.15, 0.03, 0, -0.07, 0));  // lower stem
    const spokeMesh = new THREE.Mesh(mergeGeometries(spokes, false), M.interiorSoft);
    this.steeringSpin.add(spokeMesh);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.04, 10).rotateZ(Math.PI / 2), M.accent);
    this.steeringSpin.add(hub);
    // top-center marker
    const marker = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.02, 0.05), M.accent);
    marker.position.set(0, 0.145, 0);
    this.steeringSpin.add(marker);
    // column
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.3, 8).rotateZ(Math.PI / 2), M.interior);
    column.position.set(0.14, 0.04, 0);
    this.steeringTilt.add(column);

    // ---- gear shifter (animates) --------------------------------------------
    this.shifterGroup = new THREE.Group();
    this.shifterGroup.position.set(-0.1, 0.5, 0.02);
    this.body.add(this.shifterGroup);
    const boot = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.075, 0.09, 8), M.interior);
    boot.position.y = 0.03;
    this.shifterGroup.add(boot);
    const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.24, 6), M.interiorSoft);
    lever.position.y = 0.17;
    this.shifterGroup.add(lever);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.036, 10, 8), M.accent);
    knob.position.y = 0.3;
    this.shifterGroup.add(knob);

    // interior mirror
    const imirror = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.26), M.blackGloss);
    imirror.position.set(0.7, 1.08, 0);
    this.body.add(imirror);
  }

  // ------------------------------------------------- instrument cluster
  _buildCluster() {
    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 128;
    this._clusterCanvas = cv;
    this._clusterCtx = cv.getContext('2d');
    this._clusterTex = new THREE.CanvasTexture(cv);
    this._clusterTex.colorSpace = THREE.SRGBColorSpace;
    this._clusterTex.anisotropy = 4;

    this._drawCluster(0, 0, '0', 'N', false);

    const mat = new THREE.MeshBasicMaterial({ map: this._clusterTex, toneMapped: false });
    const pod = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.38), this.mats.interior);
    pod.position.set(0.83, 0.92, 0.33);
    this.body.add(pod);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.18), mat);
    face.position.set(0.808, 0.93, 0.33);
    face.rotation.y = -Math.PI / 2; // normal toward -X (driver side)
    this.body.add(face);
    // small hood/binnacle over the cluster
    const binnacle = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.4), this.mats.interiorSoft);
    binnacle.position.set(0.85, 1.03, 0.33);
    binnacle.rotation.z = 0.3;
    this.body.add(binnacle);
  }

  /** Redraw the 3D dash cluster (called ~25 Hz from Game). */
  _drawCluster(rpmNorm, speedKmh, gearLabel, limiter) {
    const ctx = this._clusterCtx;
    const w = 256, h = 128;
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, 0, w, h);

    // --- tach dial (left) ---
    const cx = 62, cy = 66, r = 48;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#232a33';
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.stroke();
    // redline zone
    ctx.strokeStyle = '#d8342a';
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0 + (a1 - a0) * 0.88, a1);
    ctx.stroke();
    // active arc
    const warn = rpmNorm > 0.88;
    ctx.strokeStyle = limiter || warn ? '#ff5040' : '#35e0ff';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * Math.min(1, rpmNorm));
    ctx.stroke();
    // ticks
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#5a6572';
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (a1 - a0) * (i / 8);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r - 12), cy + Math.sin(a) * (r - 12));
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.stroke();
    }
    // needle
    const na = a0 + (a1 - a0) * Math.min(1, rpmNorm);
    ctx.strokeStyle = '#f2f6fa';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(na) * 8, cy - Math.sin(na) * 8);
    ctx.lineTo(cx + Math.cos(na) * (r - 10), cy + Math.sin(na) * (r - 10));
    ctx.stroke();
    ctx.fillStyle = '#f2f6fa';
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8b96a3';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('RPM x1000', cx, cy + 26);

    // --- digital speed + gear (right) ---
    ctx.fillStyle = '#f2f6fa';
    ctx.font = '900 44px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(speedKmh)), 218, 66);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillStyle = '#8b96a3';
    ctx.textAlign = 'left';
    ctx.fillText('KM/H', 224, 66);
    // gear box
    ctx.fillStyle = gearLabel === 'R' ? '#ff9d14' : '#d8342a';
    ctx.fillRect(170, 78, 36, 36);
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(gearLabel, 188, 106);
    // shift light strip
    const lit = Math.min(5, Math.floor(rpmNorm * 6));
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i < lit ? (i >= 4 ? '#ff5040' : '#3ddc84') : '#1c222b';
      ctx.fillRect(12 + i * 16, 8, 12, 8);
    }

    this._clusterTex.needsUpdate = true;
  }

  updateCluster(rpmNorm, speedKmh, gearLabel, limiter) {
    this._drawCluster(rpmNorm, speedKmh, gearLabel, limiter);
  }

  // ------------------------------------------------------------- driver
  _buildDriver() {
    const g = new THREE.Group();
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 12, 9), this.mats.helmet);
    helmet.position.set(-0.72, 1.02, 0.33);
    g.add(helmet);
    const visor = new THREE.Mesh(
      new THREE.SphereGeometry(0.127, 12, 6, 0.6, 1.9, 1.1, 0.7),
      this.mats.helmetVisor
    );
    visor.position.set(-0.72, 1.02, 0.33);
    visor.rotation.y = Math.PI / 2;
    g.add(visor);
    const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.44), this.mats.interiorSoft);
    shoulders.position.set(-0.88, 0.82, 0.33);
    g.add(shoulders);
    g.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    this.body.add(g);
    return g;
  }

  // -------------------------------------------------------------- wheels
  _buildWheels() {
    const M = this.mats;
    const R = CAR.wheelRadius;

    // tire: cylinder + shoulder tori
    // (wheel axle is model Z: cylinder rotated Y->Z; tori keep their default
    //  Z axis so they lie flat in the wheel plane — rotating them would stand
    //  them perpendicular to the tire like a gyroscope hoop)
    const tireGeo = new THREE.CylinderGeometry(R, R, 0.27, 20);
    tireGeo.rotateX(Math.PI / 2);
    const shoulderGeo = new THREE.TorusGeometry(R - 0.012, 0.024, 6, 20);

    // rim: outer ring + hub + 5 spokes (merged) — all in the XY wheel plane
    const rimParts = [];
    const ring = new THREE.TorusGeometry(0.195, 0.03, 6, 18);   // default axis Z = axle
    rimParts.push(ring);
    const hub = new THREE.CylinderGeometry(0.062, 0.062, 0.24, 10);
    hub.rotateX(Math.PI / 2);
    rimParts.push(hub);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spoke = new THREE.BoxGeometry(0.03, 0.3, 0.05);
      spoke.rotateZ(a);            // fan spokes within the wheel plane
      rimParts.push(spoke);
    }
    const rimGeo = mergeGeometries(rimParts, false);

    const discGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.028, 16);
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
   */
  updateVisual(dt, phys, trans) {
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
    this.mats.tail.emissiveIntensity = braking ? 3.6 : 0.6;
    this.mats.reverse.emissiveIntensity = phys.reversing ? 2.8 : 0.12;

    // turn indicators: blink toward steering input
    this._indicatorT += dt;
    const blinkOn = Math.sin(this._indicatorT * 7) > 0;
    const steerNorm = phys.steerAngle / 0.5;
    const leftBlink = steerNorm < -0.3 && blinkOn;
    const rightBlink = steerNorm > 0.3 && blinkOn;
    // indicators share one material; swap emissive per direction
    this.mats.indicator.emissiveIntensity = (leftBlink || rightBlink) ? 3.2 : 0.15;
    // (per-side glow: shift the material color slightly so both sides pulse
    // together — separate materials would double draw calls for little gain)

    // ---- cockpit visibility -------------------------------------------------
    this.helmet.visible = !this.cockpitMode;

    // ---- live cluster (~25 Hz) ------------------------------------------------
    this._clusterAcc += dt;
    if (this._clusterAcc > 0.04) {
      this._clusterAcc = 0;
      this.updateCluster(trans.rpmNorm, phys.speedKmh, trans.gearLabel, trans.limiterCut);
    }
  }
}
