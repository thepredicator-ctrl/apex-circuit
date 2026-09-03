/**
 * Interior — Audi-inspired (RS / R8 style) cockpit, fully procedural.
 *
 * Layout is LHD (driver on the left), matching the German theme.
 * Body space: +X nose, +Y up, +Z car-right. DRIVER_Z = -0.33.
 *
 * Highlights:
 *  - High-poly flat-bottom sport steering wheel (extruded rounded rim with
 *    bevels, Audi four-rings hub, red 12 o'clock stripe, button pods,
 *    aluminum paddle shifters behind the rim).
 *  - "Virtual Cockpit" widescreen instrument display (live canvas texture:
 *    big tach, digital speed, gear, shift LEDs, Audi-style red graphics).
 *  - Center MMI touchscreen with a live minimap drawn from the actual track
 *    spline (car dot moves in real time).
 *  - Wrap-around dash with red ambient light strip, carbon + aluminum trim,
 *    RS bucket seats with red accents, aluminum sport pedals, dead pedal,
 *    aluminum shift knob, handbrake, interior mirror.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAR } from './Constants.js';

const DRIVER_Z = -0.33;
const _v = new THREE.Vector3();

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Orient a group so its local +Z axis points along `normal` (unit-ish). */
function faceAlong(group, normal) {
  _v.copy(group.position).add(normal);
  group.lookAt(_v);
}

// ===================================================================
// BUILD
// ===================================================================

export function buildInterior(car) {
  const M = car.mats;

  // extra cockpit materials --------------------------------------------------
  M.alu = new THREE.MeshStandardMaterial({
    color: 0xc7ccd3, metalness: 0.95, roughness: 0.34, envMapIntensity: 1.2
  });
  M.carbon = new THREE.MeshStandardMaterial({
    color: 0x10141a, metalness: 0.55, roughness: 0.38
  });
  M.redLeather = new THREE.MeshStandardMaterial({
    color: 0x8c1520, metalness: 0.15, roughness: 0.68
  });
  M.ambient = new THREE.MeshStandardMaterial({
    color: 0x2a060b, emissive: 0xff1e2d, emissiveIntensity: 1.6,
    roughness: 0.5
  });
  M.btnGlow = new THREE.MeshStandardMaterial({
    color: 0x200a0c, emissive: 0xff2434, emissiveIntensity: 1.4
  });
  // (M.well — wheel-well liner material — is created in Car._buildMaterials)

  // cockpit eye anchor (on the body, follows suspension) ----------------------
  car.cockpitAnchor = new THREE.Object3D();
  car.cockpitAnchor.position.set(-0.02, 1.03, DRIVER_Z);
  car.body.add(car.cockpitAnchor);

  _buildTub(car);
  _buildDash(car);
  _buildSteeringWheel(car);
  _buildScreens(car);
  _buildSeats(car);
  _buildControls(car);
  _buildDriver(car);

  // warm red cabin fill so the cockpit never goes pitch black at night —
  // subtle: the screens and the ambient light line do most of the work
  const cabin = new THREE.PointLight(0xff5544, 1.05, 2.6, 2);
  cabin.position.set(0.55, 1.08, 0.05);
  car.body.add(cabin);
  car.cabinLight = cabin;
}

// ------------------------------------------------------------------ tub
function _buildTub(car) {
  const M = car.mats;
  const dark = [], soft = [], carbon = [], ambient = [], red = [];

  // floor, tunnel, bulkhead, footwells
  dark.push(box(2.2, 0.06, 1.4, -0.2, 0.2, 0));
  dark.push(box(1.9, 0.3, 0.26, -0.25, 0.36, 0));
  dark.push(box(0.06, 0.62, 1.4, -1.28, 0.55, 0));
  dark.push(box(0.7, 0.5, 1.42, 0.72, 0.42, 0));
  // door cards + armrests (tall GT sill — hides the wheel arches from inside)
  for (const s of [1, -1]) {
    dark.push(box(1.7, 0.62, 0.05, -0.35, 0.60, s * 0.72));
    soft.push(box(1.5, 0.08, 0.09, -0.35, 0.62, s * 0.7));
    // door ambient strip (Audi-style light line)
    ambient.push(box(0.9, 0.012, 0.02, -0.3, 0.85, s * 0.695));
    // door pull handle in aluminum
    dark.push(box(0.16, 0.03, 0.05, -0.05, 0.68, s * 0.69));
  }
  // roof lining (set back so it never crowds the forward view)
  soft.push(box(1.2, 0.04, 1.3, -0.55, 1.19, 0));

  // interior mirror
  dark.push(box(0.03, 0.07, 0.26, 0.7, 1.08, 0));

  car._addMeshes(dark, M.interior, false, false);
  car._addMeshes(soft, M.interiorSoft, false, false);
  car._addMeshes(carbon, M.carbon, false, false);
  car._addMeshes(red, M.redLeather, false, false);
  const ambMesh = car._addMeshes(ambient, M.ambient, false, false);
  car._ambientMeshes = ambMesh ? [ambMesh] : [];
}

// ------------------------------------------------------------------ dash
function _buildDash(car) {
  const M = car.mats;
  const dark = [], soft = [], carbon = [], ambient = [], alu = [];

  // wrap-around dash: knee panel + upper block + top pad + face
  dark.push(box(0.44, 0.30, 1.42, 0.79, 0.40, 0));    // knee panel
  dark.push(box(0.40, 0.26, 1.42, 0.76, 0.66, 0));    // upper block
  dark.push(box(0.06, 0.50, 1.42, 0.545, 0.55, 0));   // vertical face
  const pad = box(0.46, 0.045, 1.44, 0.73, 0.785, 0); // top pad, sloping away
  soft.push(pad);

  // carbon trim band across the dash face
  carbon.push(box(0.02, 0.055, 1.34, 0.505, 0.755, 0));
  // red ambient light line just under the trim (Audi signature)
  ambient.push(box(0.016, 0.014, 1.36, 0.502, 0.712, 0));
  // thin aluminum vent strips
  alu.push(box(0.012, 0.018, 0.30, 0.502, 0.62, -0.46));
  alu.push(box(0.012, 0.018, 0.30, 0.502, 0.62, 0.46));

  car._addMeshes(dark, M.interior, false, false);
  if (pad.rotation) pad.rotateZ(-0.085);              // nose-down slope
  car._addMeshes(soft, M.interiorSoft, false, false);
  car._addMeshes(carbon, M.carbon, false, false);
  car._addMeshes(alu, M.alu, false, false);
  const amb = car._addMeshes(ambient, M.ambient, false, false);
  if (amb && car._ambientMeshes) car._ambientMeshes.push(amb);
}

// ------------------------------------------------------- steering wheel
function _buildSteeringWheel(car) {
  const M = car.mats;

  car.steeringTilt = new THREE.Group();
  car.steeringTilt.position.set(0.47, 0.80, DRIVER_Z);
  car.steeringTilt.rotation.z = -0.42;      // column rake
  car.body.add(car.steeringTilt);

  car.steeringSpin = new THREE.Group();
  car.steeringTilt.add(car.steeringSpin);

  // --- flat-bottom rim: rounded extruded ring with bevels (high poly) -----
  const rOut = 0.165, rIn = 0.128;
  const flatY = -0.118, flatIn = -0.085;
  const t1 = Math.asin(flatY / rOut);
  const t2 = Math.PI - t1;
  const t1i = Math.asin(flatIn / rIn);
  const t2i = Math.PI - t1i;

  const shape = new THREE.Shape();
  shape.absarc(0, 0, rOut, t1, t2, false);          // over the top
  shape.lineTo(rOut * Math.cos(t1), flatY);         // flat bottom chord
  const hole = new THREE.Path();
  hole.absarc(0, 0, rIn, t1i, t2i, false);
  hole.lineTo(rIn * Math.cos(t1i), flatIn);
  shape.holes.push(hole);

  const rimGeo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.026, bevelEnabled: true,
    bevelThickness: 0.011, bevelSize: 0.010, bevelSegments: 3,
    curveSegments: 56
  });
  rimGeo.translate(0, 0, -0.013);
  rimGeo.rotateY(Math.PI / 2);                      // wheel plane YZ, axis X
  const rim = new THREE.Mesh(rimGeo, M.interiorSoft);
  rim.castShadow = false;
  car.steeringSpin.add(rim);

  // --- spokes + pods (merged) ---------------------------------------------
  const spokes = [];
  spokes.push(box(0.024, 0.045, 0.16, 0, 0.004, 0.085));   // right spoke
  spokes.push(box(0.024, 0.045, 0.16, 0, 0.004, -0.085));  // left spoke
  spokes.push(box(0.024, 0.11, 0.05, 0, -0.078, 0));       // lower spoke
  spokes.push(box(0.030, 0.058, 0.078, 0, 0.012, 0.095));  // right button pod
  spokes.push(box(0.030, 0.058, 0.078, 0, 0.012, -0.095)); // left button pod
  const spokeMesh = new THREE.Mesh(mergeGeometries(spokes, false), M.interior);
  car.steeringSpin.add(spokeMesh);

  // button glow dots
  const dots = [];
  for (const zs of [0.075, 0.115, -0.075, -0.115]) {
    dots.push(box(0.008, 0.010, 0.010, -0.020, 0.022, zs));
  }
  car.steeringSpin.add(new THREE.Mesh(mergeGeometries(dots, false), M.btnGlow));

  // --- hub: aluminum boss + Audi four rings --------------------------------
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.048, 0.052, 0.045, 24).rotateZ(Math.PI / 2),
    M.alu
  );
  car.steeringSpin.add(hub);

  const rings = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.TorusGeometry(0.0125, 0.0028, 8, 24);
    g.rotateY(Math.PI / 2);
    g.translate(0.028, 0, (i - 1.5) * 0.013);
    rings.push(g);
  }
  car.steeringSpin.add(new THREE.Mesh(mergeGeometries(rings, false), M.chrome));

  // red 12 o'clock center stripe (racing marker)
  const stripe = new THREE.Mesh(box(0.020, 0.014, 0.05, 0, 0.160, 0), M.accent);
  car.steeringSpin.add(stripe);

  // column shroud
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(0.036, 0.046, 0.14, 12).rotateZ(Math.PI / 2),
    M.interior
  );
  column.position.set(0.075, 0.03, 0);
  car.steeringTilt.add(column);

  // --- paddle shifters (column-mounted, do not spin) -----------------------
  for (const side of [1, -1]) {
    const paddle = new THREE.Mesh(box(0.014, 0.115, 0.048, 0, 0, 0), M.alu);
    paddle.position.set(0.055, 0.012, side * 0.125);
    paddle.rotation.x = side * -0.16;
    car.steeringTilt.add(paddle);
  }

  // red "ENGINE START" button on the dash face
  const startBtn = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 0.014, 12).rotateZ(Math.PI / 2),
    M.btnGlow
  );
  startBtn.position.set(0.498, 0.585, 0.10);
  car.body.add(startBtn);
}

// ------------------------------------------------------------------ screens
function _buildScreens(car) {
  const M = car.mats;

  // === Virtual Cockpit (behind the wheel) =================================
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 256;
  car._clusterCanvas = cv;
  car._clusterCtx = cv.getContext('2d');
  car._clusterTex = new THREE.CanvasTexture(cv);
  car._clusterTex.colorSpace = THREE.SRGBColorSpace;
  car._clusterTex.anisotropy = 4;

  const vcGroup = new THREE.Group();
  vcGroup.position.set(0.70, 0.965, DRIVER_Z);
  car.body.add(vcGroup);
  faceAlong(vcGroup, new THREE.Vector3(-1, 0.15, 0));

  // bezel doubles as the binnacle (deep surround, no floating hood)
  const vcBezel = new THREE.Mesh(box(0.055, 0.235, 0.46, 0.020, 0, 0), M.blackGloss);
  vcGroup.add(vcBezel);
  const vcFace = new THREE.Mesh(new THREE.PlaneGeometry(0.40, 0.19),
    new THREE.MeshBasicMaterial({ map: car._clusterTex, toneMapped: false }));
  vcFace.position.set(-0.006, 0, 0);
  vcGroup.add(vcFace);
  const pod = new THREE.Mesh(box(0.34, 0.10, 0.42, 0.74, 0.855, DRIVER_Z), M.interior);
  car.body.add(pod);

  // === MMI touchscreen (center console) ===================================
  const mm = document.createElement('canvas');
  mm.width = 320; mm.height = 208;
  car._mmiCanvas = mm;
  car._mmiCtx = mm.getContext('2d');
  car._mmiTex = new THREE.CanvasTexture(mm);
  car._mmiTex.colorSpace = THREE.SRGBColorSpace;
  car._mmiTex.anisotropy = 2;

  const mmiGroup = new THREE.Group();
  mmiGroup.position.set(0.565, 0.87, 0.05);
  car.body.add(mmiGroup);
  faceAlong(mmiGroup, new THREE.Vector3(-0.95, 0.15, -0.28).normalize());

  const mmiBezel = new THREE.Mesh(box(0.020, 0.185, 0.29, 0.010, 0, 0), M.blackGloss);
  mmiGroup.add(mmiBezel);
  const mmiFace = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.165),
    new THREE.MeshBasicMaterial({ map: car._mmiTex, toneMapped: false }));
  mmiFace.position.set(-0.003, 0, 0);
  mmiGroup.add(mmiFace);

  // cache a simplified track polyline for the minimap
  car._mmiPts = null;
  if (car.track) {
    const N = 96;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const p = car.track.pointAt(i / N);
      pts.push([p.x, p.z]);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const pad = 26;
    const w = mm.width - pad * 2, h = mm.height - 22 - pad;
    const spanX = Math.max(1, maxX - minX), spanZ = Math.max(1, maxZ - minZ);
    const scale = Math.min(w / spanX, h / spanZ);
    const ox = mm.width / 2 - ((minX + maxX) / 2) * scale;
    const oz = 22 + h / 2 + pad / 2 - ((minZ + maxZ) / 2) * scale;
    car._mmiPts = pts.map(([x, z]) => [ox + x * scale, oz + z * scale]);
  }
  car._mmiAcc = 1;
}

// ------------------------------------------------------------------ seats
function _buildSeats(car) {
  const M = car.mats;
  const soft = [], dark = [], red = [];

  for (const dz of [DRIVER_Z, -DRIVER_Z]) {
    // cushion + bolsters
    soft.push(box(0.52, 0.11, 0.50, -0.30, 0.30, dz));
    soft.push(box(0.44, 0.08, 0.06, -0.30, 0.365, dz + 0.235));
    soft.push(box(0.44, 0.08, 0.06, -0.30, 0.365, dz - 0.235));
    // backrest (reclined) + bolsters + headrest
    const back = box(0.13, 0.62, 0.48, -0.60, 0.645, dz);
    soft.push(back);
    soft.push(box(0.13, 0.52, 0.07, -0.60, 0.65, dz + 0.245));
    soft.push(box(0.13, 0.52, 0.07, -0.60, 0.65, dz - 0.245));
    soft.push(box(0.10, 0.18, 0.26, -0.68, 1.02, dz));
    // RS red accent: center stripe + cushion stitch line
    red.push(box(0.135, 0.48, 0.11, -0.585, 0.63, dz));
    red.push(box(0.47, 0.025, 0.05, -0.30, 0.358, dz));
    // seat side airbag tag
    dark.push(box(0.02, 0.10, 0.06, -0.52, 0.72, dz + 0.26));
  }

  car._addMeshes(soft, M.interiorSoft, false, false);
  car._addMeshes(dark, M.interior, false, false);
  car._addMeshes(red, M.redLeather, false, false);
}

// ------------------------------------------------------------------ controls
function _buildControls(car) {
  const M = car.mats;
  const alu = [], dark = [];

  // aluminum sport pedals (driver footwell)
  car.pedalThrottle = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.13, 0.07), M.interiorSoft);
  car.pedalThrottle.position.set(0.92, 0.34, DRIVER_Z + 0.10);
  car.pedalThrottle.rotation.z = -0.35;
  car.body.add(car.pedalThrottle);

  car.pedalBrake = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.15, 0.09), M.interiorSoft);
  car.pedalBrake.position.set(0.92, 0.37, DRIVER_Z - 0.05);
  car.pedalBrake.rotation.z = -0.35;
  car.body.add(car.pedalBrake);

  // dead pedal + footrest
  const dead = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.10, 0.06), M.alu);
  dead.position.set(0.95, 0.33, DRIVER_Z - 0.19);
  car.body.add(dead);
  alu.push(box(0.10, 0.02, 0.05, 0.78, 0.245, DRIVER_Z + 0.10));

  // gear shifter (animated by Car.updateVisual)
  car.shifterGroup = new THREE.Group();
  car.shifterGroup.position.set(-0.10, 0.50, -0.02);
  car.body.add(car.shifterGroup);
  const boot = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.075, 0.09, 10), M.interior);
  boot.position.y = 0.03;
  car.shifterGroup.add(boot);
  const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.24, 8), M.interiorSoft);
  lever.position.y = 0.17;
  car.shifterGroup.add(lever);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.036, 16, 12), M.alu);
  knob.position.y = 0.30;
  car.shifterGroup.add(knob);
  const knobRing = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.005, 6, 16).rotateX(Math.PI / 2), M.accent);
  knobRing.position.y = 0.288;
  car.shifterGroup.add(knobRing);

  // handbrake
  const hbBase = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.06), M.interior);
  hbBase.position.set(-0.05, 0.52, 0.13);
  car.body.add(hbBase);
  car.handbrakeLever = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.26, 8), M.alu);
  car.handbrakeLever.position.set(-0.14, 0.63, 0.13);
  car.handbrakeLever.rotation.z = 0.9;
  car.body.add(car.handbrakeLever);

  car._addMeshes(alu, M.alu, false, false);
  car._addMeshes(dark, M.interior, false, false);
}

// ------------------------------------------------------------------ driver
function _buildDriver(car) {
  const g = new THREE.Group();
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 16, 12), car.mats.helmet);
  helmet.position.set(-0.12, 1.005, DRIVER_Z);
  g.add(helmet);
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(0.127, 16, 8, 0.6, 1.9, 1.1, 0.7),
    car.mats.helmetVisor
  );
  visor.position.set(-0.12, 1.005, DRIVER_Z);
  visor.rotation.y = Math.PI / 2;
  g.add(visor);
  const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.16, 0.44), car.mats.interiorSoft);
  shoulders.position.set(-0.30, 0.82, DRIVER_Z);
  g.add(shoulders);
  g.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  car.body.add(g);
  car.helmet = g;
}

// ===================================================================
// VIRTUAL COCKPIT (instrument cluster canvas)
// ===================================================================

export function drawCluster(car, rpmNorm, speedKmh, gearLabel, limiter, race = null) {
  const ctx = car._clusterCtx;
  if (!ctx) return;
  const W = 512, H = 256;

  const fmtLap = (t) => {
    if (t == null) return '--:--.---';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
  };

  // background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0a0e14');
  bg.addColorStop(1, '#04060a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const RED = '#e6001e';
  const WHITE = '#f2f4f6';
  const GREY = '#8a939e';
  const TRACK = '#242b34';

  // --- shift LEDs (top center) ---------------------------------------------
  const ledN = 7;
  const lit = Math.min(ledN, Math.round(rpmNorm * ledN));
  for (let i = 0; i < ledN; i++) {
    const x = W / 2 - (ledN * 22) / 2 + i * 22;
    let c = '#161b22';
    if (i < lit) c = i < 4 ? '#2ecc71' : i < 6 ? RED : '#3f7bff';
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x + 8, 20, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- tach dial (left) ------------------------------------------------------
  const cx = 122, cy = 138, r = 92;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  ctx.lineWidth = 10;
  ctx.strokeStyle = TRACK;
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
  // redline zone
  ctx.strokeStyle = RED;
  ctx.beginPath(); ctx.arc(cx, cy, r, a0 + (a1 - a0) * 0.90, a1); ctx.stroke();
  // active arc
  const hot = limiter || rpmNorm > 0.88;
  ctx.strokeStyle = hot ? RED : WHITE;
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * Math.min(1, rpmNorm));
  ctx.stroke();
  // ticks + numbers
  ctx.lineWidth = 2;
  for (let i = 0; i <= 8; i++) {
    const a = a0 + (a1 - a0) * (i / 8);
    ctx.strokeStyle = GREY;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - 12), cy + Math.sin(a) * (r - 12));
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
    ctx.fillStyle = GREY;
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i), cx + Math.cos(a) * (r - 24), cy + Math.sin(a) * (r - 24));
  }
  // needle
  const na = a0 + (a1 - a0) * Math.min(1, rpmNorm);
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(na) * 10, cy - Math.sin(na) * 10);
  ctx.lineTo(cx + Math.cos(na) * (r - 14), cy + Math.sin(na) * (r - 14));
  ctx.stroke();
  ctx.fillStyle = '#11151b';
  ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = GREY;
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.fillText('1/min ×1000', cx, cy + 34);

  // --- speed dial (right) ------------------------------------------------------
  const sx = 394, sy = 138;
  // progress arc around the number
  const spN = Math.min(1, speedKmh / 260);
  ctx.lineWidth = 6;
  ctx.strokeStyle = TRACK;
  ctx.beginPath(); ctx.arc(sx, sy, 74, a0, a1); ctx.stroke();
  ctx.strokeStyle = spN > 0.82 ? RED : WHITE;
  ctx.beginPath(); ctx.arc(sx, sy, 74, a0, a0 + (a1 - a0) * spN); ctx.stroke();
  // big speed number
  ctx.fillStyle = WHITE;
  ctx.font = '800 62px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(speedKmh)), sx, sy - 4);
  ctx.fillStyle = GREY;
  ctx.font = '600 14px system-ui, sans-serif';
  ctx.fillText('km/h', sx, sy + 34);

  // --- gear (center) ------------------------------------------------------------
  ctx.strokeStyle = '#1d242d';
  ctx.lineWidth = 2;
  ctx.strokeRect(W / 2 - 27, 118, 54, 54);
  ctx.fillStyle = gearLabel === 'R' ? '#ff9d14' : gearLabel === 'N' ? '#c8ced6' : RED;
  ctx.font = '800 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(gearLabel, W / 2, 146);
  ctx.fillStyle = GREY;
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.fillText(limiter ? 'SHIFT' : 'S TRONIC', W / 2, 196);

  // wordmark
  ctx.fillStyle = '#4a545f';
  ctx.font = '700 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('APEX  R8', 16, H - 16);
  ctx.textAlign = 'right';
  ctx.fillText('QUATTRO', W - 16, H - 16);

  // --- lap info (top corners, needs the race system) -----------------------
  if (race) {
    ctx.textAlign = 'left';
    ctx.fillStyle = GREY;
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.fillText(`LAP ${Math.min(race.lap, race.totalLaps)}/${race.totalLaps}`, 16, 44);
    ctx.fillStyle = WHITE;
    ctx.font = '600 15px system-ui, sans-serif';
    const last = race.lapTimes.length ? race.lapTimes[race.lapTimes.length - 1] : null;
    ctx.fillText(fmtLap(last), 16, 66);
    ctx.fillStyle = GREY;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillText('BEST ' + fmtLap(race.bestLap), 16, 86);
    ctx.textAlign = 'right';
    ctx.fillStyle = limiter ? RED : '#6fd06f';
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.fillText('D ' + gearLabel, W - 16, 44);
    ctx.fillStyle = GREY;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillText('S TRONIC', W - 16, 66);
  }

  // limiter border pulse
  if (limiter) {
    ctx.strokeStyle = 'rgba(230,0,30,0.8)';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, W - 4, H - 4);
  }

  car._clusterTex.needsUpdate = true;
}

// ===================================================================
// MMI MINIMAP
// ===================================================================

export function drawMMI(car, progress) {
  const ctx = car._mmiCtx;
  if (!ctx) return;
  const W = 320, H = 208;

  ctx.fillStyle = '#070a0e';
  ctx.fillRect(0, 0, W, H);

  // header
  ctx.fillStyle = '#0d1218';
  ctx.fillRect(0, 0, W, 24);
  ctx.fillStyle = '#c8ced6';
  ctx.font = '700 12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('NAVIGATION', 10, 12);
  ctx.fillStyle = '#e6001e';
  ctx.fillText('● REC', W - 52, 12);

  // map grid
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 32) {
    ctx.beginPath(); ctx.moveTo(x, 24); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 24; y < H; y += 32) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  const pts = car._mmiPts;
  if (pts && pts.length > 2) {
    // track ribbon
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#2c343e';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = '#aeb8c2';
    ctx.lineWidth = 4;
    ctx.stroke();

    // start/finish tick
    ctx.strokeStyle = '#e8ecef';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pts[0][0] - 5, pts[0][1] - 5);
    ctx.lineTo(pts[0][0] + 5, pts[0][1] + 5);
    ctx.stroke();

    // car dot (interpolate along the cached polyline by progress)
    const fi = progress * pts.length;
    const i0 = Math.floor(fi) % pts.length;
    const i1 = (i0 + 1) % pts.length;
    const f = fi - Math.floor(fi);
    const px = pts[i0][0] + (pts[i1][0] - pts[i0][0]) * f;
    const py = pts[i0][1] + (pts[i1][1] - pts[i0][1]) * f;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e6001e';
    ctx.beginPath(); ctx.arc(px, py, 4.2, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = '#3a444f';
    ctx.font = '700 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('APEX CIRCUIT', W / 2, H / 2);
  }

  // footer
  ctx.fillStyle = '#5a6570';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('3 LAPS · CHECKPOINTS ON', 10, H - 10);

  car._mmiTex.needsUpdate = true;
}
