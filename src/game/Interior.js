/**
 * Interior — Jaguar XJ220 cockpit (Gerhald, CC-BY-4.0) from
 * `public/models/interior.glb`, fitted into the Porsche cabin and rigged:
 *
 *  - the model's separate "weel" (steering wheel) node is re-pivoted around
 *    its own column axis so it rotates with the steering input;
 *  - a live instrument cluster is built behind it: canvas dial faces with
 *    PHYSICAL 3D needles (rpm + speed) that sweep with the drivetrain state,
 *    plus shift LEDs, gear indicator and lap timing drawn into the texture;
 *  - an MMI-style center screen shows the live track minimap;
 *  - sport pedals, shifter and handbrake are placed to match the wheel.
 *
 * The cabin mesh is re-skinned to a dark night-trim (the source material is
 * tan plastic) and lit by a dim red ambient rig so the cockpit reads at
 * night without breaking the atmosphere.
 */

import * as THREE from 'three';
import { loadGLB, stripExtras, toFloat32Geometry, keepTriangles } from './ModelKit.js';

// cabin fitting (model space: nose +X, Y up, +Z right)
const CABIN = {
  rotationY: -Math.PI / 2,   // interior is authored nose -X -> rotate to nose +X
  mirrorX: true,             // source is right-hand-drive -> flip to LHD
  targetWidth: 1.42,         // fitted cabin width (m) — matches 911 beltline
  scale: 1.0,                // extra trim factor (source is already metric)
  posX: 0.42,                // dash toward the nose
  posY: -0.55,               // drop so the sill hides under the beltline
  posZ: 0.0
};

// Where the steering wheel must end up in BODY SPACE (meters).
// 911 driver position: wheel center ~1.05 m above ground (beltline ~0.95,
// seat hip ~0.42, wheel diameter 0.38 → hub at 0.42+0.63). The previous
// value 0.36 placed the wheel roughly at floor level after the cabin
// offset (-0.55) was applied.
const WHEEL_TARGET = new THREE.Vector3(-0.24, 1.05, -0.37);

/** Give the steering wheel rim its own leather material. */
function weelLeather(scene, mat) {
  scene.traverse((o) => {
    if (o.isMesh && o.name.toLowerCase().includes('weel')) o.material = mat;
  });
}

export async function buildInterior(car, onProgress) {
  const scene = await loadGLB('./models/interior.glb',
    (t) => onProgress && onProgress(0.8 + t * 0.2));
  stripExtras(scene);
  const M = car.mats;

  // ---- re-skin to dark trim -------------------------------------------------
  const trim = new THREE.MeshStandardMaterial({
    color: 0x22252b, metalness: 0.16, roughness: 0.78, envMapIntensity: 0.55,
    side: THREE.DoubleSide
  });
  const trimSoft = new THREE.MeshStandardMaterial({
    color: 0x2a2d34, metalness: 0.08, roughness: 0.88, envMapIntensity: 0.45,
    side: THREE.DoubleSide
  });
  // the wheel rim gets its own lighter leather so it reads at night
  const wheelLeather = new THREE.MeshStandardMaterial({
    color: 0x31343c, metalness: 0.1, roughness: 0.72, envMapIntensity: 0.7,
    side: THREE.DoubleSide
  });
  M.cabinTrim = trim;
  M.cabinTrimSoft = trimSoft;
  M.wheelLeather = wheelLeather;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    const n = (o.material && o.material.name) || '';
    o.material = n === 'default_0' ? trimSoft : trim;
  });
  weelLeather(scene, wheelLeather);

  // ---- fit into the car ------------------------------------------------------
  // measure, then place with the tuned transform
  scene.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(scene);
  const size = bb.getSize(new THREE.Vector3());
  const fitScale = CABIN.scale * (CABIN.targetWidth / Math.max(0.001, size.x));
  const cabin = new THREE.Group();
  cabin.add(scene);
  scene.scale.setScalar(fitScale);
  scene.rotation.y = CABIN.rotationY;
  if (CABIN.mirrorX) scene.scale.x *= -1;

  // after scaling, re-measure to anchor: dash face toward +X, floor near y=0.25
  scene.updateMatrixWorld(true);
  const bb2 = new THREE.Box3().setFromObject(scene);
  const c2 = bb2.getCenter(new THREE.Vector3());
  scene.position.x -= c2.x;
  scene.position.z -= c2.z;
  scene.position.y -= bb2.min.y;

  cabin.position.set(CABIN.posX, CABIN.posY, CABIN.posZ);
  car.body.add(cabin);
  car.cabinGroup = cabin;

  // ---- bake the whole cabin into body space + cut the greenhouse -------------
  // The XJ220 cabin is one merged mesh including its own roof; the 911 has
  // its own glass canopy, so everything above the beltline/eye line goes.
  // Every mesh (incl. the steering wheel) ends up with identity transforms
  // and body-space geometry — no nested transform surprises afterwards.
  {
    car.body.updateMatrixWorld(true);
    const bodyInv = new THREE.Matrix4().copy(car.body.matrixWorld).invert();
    const cut = 0.82;                    // model-space meters — removes the
                                         // donor's windshield header entirely
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = toFloat32Geometry(o.geometry);
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(bodyInv, o.matrixWorld));
      const pos = g.attributes.position;
      const keep = new Array(pos.count);
      for (let i = 0; i < pos.count; i++) keep[i] = pos.getY(i) <= cut;
      const kept = keepTriangles(g, keep);
      if (kept) {
        o.geometry = kept;
        o.position.set(0, 0, 0);
        o.quaternion.identity();
        o.scale.set(1, 1, 1);
      } else {
        o.visible = false;
      }
      g.dispose();
    });
    scene.position.set(0, 0, 0);
    scene.rotation.set(0, 0, 0);
    scene.scale.set(1, 1, 1);
    cabin.position.set(0, 0, 0);
  }

  // ---- snap the cabin to a known-good anchor ---------------------------------
  // Whatever the upstream transforms did, the steering wheel must sit at
  // WHEEL_TARGET in BODY SPACE (not cabin-local). The cabin group was added
  // to car.body at CABIN.posX/posY/posZ; the previous code added an *extra*
  // (WHEEL_TARGET.y - wc.y) offset which left the wheel ~0.5 m too low.
  // We now compute the body-space position of the wheel center under the
  // current cabin transform, then move the cabin by the difference so the
  // wheel ends up exactly at WHEEL_TARGET.
  let weel = null;
  scene.traverse((o) => { if (!weel && o.isMesh && o.name.toLowerCase().includes('weel')) weel = o; });
  if (!weel) throw new Error('steering wheel node not found');
  {
    weel.geometry.computeBoundingBox();
    const wb = weel.geometry.boundingBox;
    const wcLocal = new THREE.Vector3(
      (wb.min.x + wb.max.x) / 2, (wb.min.y + wb.max.y) / 2, (wb.min.z + wb.max.z) / 2
    );
    // body-space position of the wheel center under the current cabin transform
    car.body.updateMatrixWorld(true);
    const wheelBody = wcLocal.clone().applyMatrix4(cabin.matrixWorld);
    // shift the cabin so the wheel lands at WHEEL_TARGET in body space
    cabin.position.add(WHEEL_TARGET.clone().sub(wheelBody));
  }

  rigSteeringWheel(car, weel, cabin.position);

  // ---- instrument cluster with physical needles ------------------------------
  buildCluster(car);

  // ---- MMI screen ------------------------------------------------------------
  buildMMI(car);

  // ---- controls: pedals + shifter + handbrake --------------------------------
  buildControls(car);

  // ---- ambience ---------------------------------------------------------------
  const cabin1 = new THREE.PointLight(0xff6a55, 2.2, 3.4, 1.5);
  cabin1.position.set(0.30, 1.06, 0.05);
  car.body.add(cabin1);
  car.cabinLight = cabin1;
  // soft cool fill over the cluster + wheel so they read at night
  const clusterFill = new THREE.PointLight(0xcfe0ff, 1.5, 1.7, 1.6);
  clusterFill.position.set(0.05, 0.95, -0.30);
  car.body.add(clusterFill);

  // cockpit eye anchor — natural seated position; the donor cabin shell is
  // hidden in cockpit view so nothing occludes the wheel + cluster + road
  car.cockpitAnchor = new THREE.Object3D();
  car.cockpitAnchor.position.set(
    (car.wheelModelPos ? car.wheelModelPos.x - 0.62 : -0.05),
    (car.wheelModelPos ? car.wheelModelPos.y + 0.46 : 1.02),
    (car.wheelModelPos ? car.wheelModelPos.z : -0.33)
  );
  car.body.add(car.cockpitAnchor);
}

/**
 * Re-parent the wheel mesh under a pivot whose +Z axis is the wheel's own
 * column axis. The column axis is whichever of the node's local axes maps
 * most rearward (−X) in body space — FBX pipelines bake arbitrary rotations,
 * so the natural wheel axis may be local X, Y or Z.
 */
function rigSteeringWheel(car, weel, cabinOffset) {
  // after the bake the wheel's node transform is identity; its body-space
  // position is geometry bbox center + the cabin's snap offset
  weel.geometry.computeBoundingBox();
  const wb = weel.geometry.boundingBox;
  const worldPos = new THREE.Vector3(
    (wb.min.x + wb.max.x) / 2, (wb.min.y + wb.max.y) / 2, (wb.min.z + wb.max.z) / 2
  ).add(cabinOffset);

  // body-space axes of the node (identity after the bake): the column axis is
  // whichever local axis points most rearward (-X)
  const rearward = new THREE.Vector3(-1, 0, 0); // toward the driver
  let best = null, bestDot = -Infinity;
  ['x', 'y', 'z'].forEach((a, i) => {
    const axis = new THREE.Vector3().setComponent(i, 1);
    const d = axis.dot(rearward);
    if (d > bestDot) { bestDot = d; best = axis.clone(); }
  });
  const axis = best.normalize();
  if (axis.dot(rearward) < 0) axis.negate();

  const pivot = new THREE.Group();
  pivot.position.copy(worldPos);
  pivot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);

  // re-parent: weel carries only the cabin offset — express it relative to
  // the pivot so the geometry stays exactly where it was
  weel.parent.remove(weel);
  pivot.add(weel);
  weel.position.copy(cabinOffset).sub(pivot.position);
  weel.quaternion.identity();
  weel.scale.set(1, 1, 1);
  car.body.add(pivot);

  car.steeringSpin = pivot;

  // remember where the wheel sits (model space) for cluster placement
  car.wheelModelPos = worldPos.clone();
  car.wheelAxis = axis.clone();
}

/**
 * Instrument cluster: canvas-textured dial faces + REAL 3D needles.
 * Positioned just beyond the steering wheel along its column axis.
 */
function buildCluster(car) {
  const wp = car.wheelModelPos;
  const axis = car.wheelAxis;
  if (!wp || !axis) return;

  const group = new THREE.Group();
  group.position.copy(wp).addScaledVector(axis, -0.36); // into the dash (axis points to the driver)
  group.position.y += 0.08;                            // peek over the cowl
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone());
  car.body.add(group);

  // binnacle hood so it reads as a physical unit
  const hood = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.24, 0.06),
    car.mats.blackGloss
  );
  hood.position.set(0, 0, -0.035);
  group.add(hood);

  // canvas dial faces
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 480;
  car._clusterCanvas = cv;
  car._clusterCtx = cv.getContext('2d');
  car._clusterTex = new THREE.CanvasTexture(cv);
  car._clusterTex.colorSpace = THREE.SRGBColorSpace;
  car._clusterTex.anisotropy = 4;

  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(0.44, 0.206),
    new THREE.MeshBasicMaterial({ map: car._clusterTex, toneMapped: false })
  );
  face.position.z = 0.002;
  group.add(face);

  // ---- physical needles (rpm left dial, speed right dial) -------------------
  const mkNeedle = (px, py) => {
    const pivot = new THREE.Group();
    pivot.position.set(px, py, 0.012);
    const shaft = new THREE.Mesh(
      new THREE.BoxGeometry(0.0026, 0.086, 0.0035),
      car.mats.needle
    );
    shaft.position.y = 0.043;                       // pivot at the base
    pivot.add(shaft);
    const tail = new THREE.Mesh(
      new THREE.BoxGeometry(0.0034, 0.018, 0.0035),
      car.mats.needle
    );
    tail.position.y = -0.009;
    pivot.add(tail);
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0075, 0.009, 0.008, 12).rotateX(Math.PI / 2),
      car.mats.blackGloss
    );
    pivot.add(hub);
    group.add(pivot);
    return pivot;
  };
  car.needleRPM = mkNeedle(-0.108, -0.012);
  car.needleSpeed = mkNeedle(0.108, -0.012);
  car.clusterGroup = group;

  car.drawCluster = drawCluster;
}

/** MMI-style center screen with the live minimap. */
function buildMMI(car) {
  const wp = car.wheelModelPos;
  const axis = car.wheelAxis;
  if (!wp || !axis) return;

  const group = new THREE.Group();
  // right of the wheel, slightly further into the dash, angled to the driver
  const right = new THREE.Vector3(axis.z, 0, -axis.x).normalize(); // lateral, car-right
  group.position.copy(wp).addScaledVector(axis, -0.30).addScaledVector(right, 0.38);
  group.position.y += 0.10;
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1),
    axis.clone().addScaledVector(right, -0.3).normalize());
  car.body.add(group);

  const bezel = new THREE.Mesh(
    new THREE.BoxGeometry(0.30, 0.20, 0.025),
    car.mats.blackGloss
  );
  bezel.position.set(0, 0, -0.014);
  group.add(bezel);

  const mm = document.createElement('canvas');
  mm.width = 320; mm.height = 208;
  car._mmiCanvas = mm;
  car._mmiCtx = mm.getContext('2d');
  car._mmiTex = new THREE.CanvasTexture(mm);
  car._mmiTex.colorSpace = THREE.SRGBColorSpace;
  car._mmiTex.anisotropy = 2;

  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(0.28, 0.182),
    new THREE.MeshBasicMaterial({ map: car._mmiTex, toneMapped: false })
  );
  face.position.z = 0.002;
  group.add(face);

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
  car.drawMMI = drawMMI;
}

/** Pedals, shifter and handbrake placed relative to the steering wheel. */
function buildControls(car) {
  const M = car.mats;
  const wp = car.wheelModelPos || new THREE.Vector3(0.47, 0.80, -0.33);
  const dz = wp.z;                                  // driver lateral position

  car.pedalThrottle = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.13, 0.07), M.interiorSoft);
  car.pedalThrottle.position.set(1.02, 0.34, dz + 0.10);
  car.pedalThrottle.rotation.z = -0.35;
  car.body.add(car.pedalThrottle);

  car.pedalBrake = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.15, 0.09), M.interiorSoft);
  car.pedalBrake.position.set(1.02, 0.37, dz - 0.05);
  car.pedalBrake.rotation.z = -0.35;
  car.body.add(car.pedalBrake);

  // gear shifter on the tunnel
  car.shifterGroup = new THREE.Group();
  car.shifterGroup.position.set(0.05, 0.46, dz + 0.30);
  car.body.add(car.shifterGroup);
  const boot = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.075, 0.09, 10), M.interior);
  boot.position.y = 0.03;
  car.shifterGroup.add(boot);
  const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.22, 8), M.interiorSoft);
  lever.position.y = 0.16;
  car.shifterGroup.add(lever);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.034, 16, 12), M.alu);
  knob.position.y = 0.28;
  car.shifterGroup.add(knob);

  // handbrake
  car.handbrakeLever = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.24, 8), M.alu);
  car.handbrakeLever.position.set(-0.02, 0.56, dz + 0.34);
  car.handbrakeLever.rotation.z = 0.9;
  car.body.add(car.handbrakeLever);
}

// ===================================================================
// VIRTUAL COCKPIT (instrument cluster canvas)
// ===================================================================

export function drawCluster(car, rpmNorm, speedKmh, gearLabel, limiter, race = null) {
  const ctx = car._clusterCtx;
  if (!ctx) return;
  const W = 1024, H = 480;

  const fmtLap = (t) => {
    if (t == null) return '--:--.---';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
  };

  // background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#07090d');
  bg.addColorStop(1, '#020304');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const RED = '#e6001e';
  const AMBER = '#ff9d14';
  const WHITE = '#f2f4f6';
  const GREY = '#8a939e';
  const TRACK = '#232a33';

  // --- shift LEDs (top center) ---------------------------------------------
  const ledN = 9;
  const lit = Math.min(ledN, Math.round(rpmNorm * ledN));
  for (let i = 0; i < ledN; i++) {
    const x = W / 2 - (ledN * 30) / 2 + i * 30;
    let c = '#141a21';
    if (i < lit) c = i < 5 ? '#2ecc71' : i < 7 ? RED : '#3f7bff';
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x + 10, 32, 9, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- tach dial (left) — needle is a real 3D mesh, canvas draws the face ---
  const cx = 262, cy = 262, r = 178;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  ctx.lineWidth = 18;
  ctx.strokeStyle = TRACK;
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
  ctx.strokeStyle = RED;
  ctx.beginPath(); ctx.arc(cx, cy, r, a0 + (a1 - a0) * 0.88, a1); ctx.stroke();
  const hot = limiter || rpmNorm > 0.88;
  ctx.strokeStyle = hot ? RED : WHITE;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * Math.min(1, rpmNorm));
  ctx.stroke();
  // ticks + numbers
  ctx.lineWidth = 3;
  for (let i = 0; i <= 8; i++) {
    const a = a0 + (a1 - a0) * (i / 8);
    ctx.strokeStyle = GREY;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - 22), cy + Math.sin(a) * (r - 22));
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
    ctx.fillStyle = GREY;
    ctx.font = '600 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i), cx + Math.cos(a) * (r - 48), cy + Math.sin(a) * (r - 48));
  }
  // the canvas keeps a faint ghost needle; the 3D needle does the real sweep
  const na = a0 + (a1 - a0) * Math.min(1, rpmNorm);
  ctx.strokeStyle = hot ? 'rgba(230,0,30,0.35)' : 'rgba(242,244,246,0.28)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(na) * 18, cy - Math.sin(na) * 18);
  ctx.lineTo(cx + Math.cos(na) * (r - 20), cy + Math.sin(na) * (r - 20));
  ctx.stroke();
  ctx.fillStyle = '#0c0f14';
  ctx.beginPath(); ctx.arc(cx, cy, 17, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = GREY;
  ctx.font = '600 20px system-ui, sans-serif';
  ctx.fillText('1/min ×1000', cx, cy + 62);

  // --- speed dial (right) — same split: face here, 3D needle in space ------
  const sx = W - 262, sy = 262;
  const spN = Math.min(1, speedKmh / 280);
  ctx.lineWidth = 14;
  ctx.strokeStyle = TRACK;
  ctx.beginPath(); ctx.arc(sx, sy, r, a0, a1); ctx.stroke();
  ctx.strokeStyle = spN > 0.82 ? RED : WHITE;
  ctx.lineWidth = 6;
  ctx.beginPath(); ctx.arc(sx, sy, r, a0, a0 + (a1 - a0) * spN); ctx.stroke();
  ctx.lineWidth = 3;
  for (let i = 0; i <= 14; i++) {
    const a = a0 + (a1 - a0) * (i / 14);
    ctx.strokeStyle = GREY;
    ctx.beginPath();
    ctx.moveTo(sx + Math.cos(a) * (r - 16), sy + Math.sin(a) * (r - 16));
    ctx.lineTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r);
    ctx.stroke();
    if (i % 2 === 0) {
      ctx.fillStyle = GREY;
      ctx.font = '600 22px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i * 20), sx + Math.cos(a) * (r - 44), sy + Math.sin(a) * (r - 44));
    }
  }
  const nsa = a0 + (a1 - a0) * spN;
  ctx.strokeStyle = 'rgba(242,244,246,0.28)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(sx - Math.cos(nsa) * 18, sy - Math.sin(nsa) * 18);
  ctx.lineTo(sx + Math.cos(nsa) * (r - 20), sy + Math.sin(nsa) * (r - 20));
  ctx.stroke();
  ctx.fillStyle = '#0c0f14';
  ctx.beginPath(); ctx.arc(sx, sy, 17, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = WHITE;
  ctx.font = '800 58px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(Math.round(speedKmh)), sx, sy + 92);
  ctx.fillStyle = GREY;
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.fillText('km/h', sx, sy + 122);

  // --- gear (center) ------------------------------------------------------------
  ctx.strokeStyle = '#1d242d';
  ctx.lineWidth = 3;
  ctx.strokeRect(W / 2 - 52, 218, 104, 104);
  ctx.fillStyle = gearLabel === 'R' ? AMBER : gearLabel === 'N' ? '#c8ced6' : RED;
  ctx.font = '800 86px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(gearLabel, W / 2, 272);
  ctx.fillStyle = GREY;
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.fillText(limiter ? 'SHIFT NOW' : 'PDK', W / 2, 356);

  // wordmark
  ctx.fillStyle = '#4a545f';
  ctx.font = '700 24px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('APEX 911', 30, H - 28);
  ctx.textAlign = 'right';
  ctx.fillText('CARRERA 4S', W - 30, H - 28);

  // --- lap info (top corners) ------------------------------------------------
  if (race) {
    ctx.textAlign = 'left';
    ctx.fillStyle = GREY;
    ctx.font = '700 24px system-ui, sans-serif';
    ctx.fillText(`LAP ${Math.min(race.lap, race.totalLaps)}/${race.totalLaps}`, 30, 74);
    ctx.fillStyle = WHITE;
    ctx.font = '600 28px system-ui, sans-serif';
    const last = race.lapTimes.length ? race.lapTimes[race.lapTimes.length - 1] : null;
    ctx.fillText(fmtLap(last), 30, 116);
    ctx.fillStyle = GREY;
    ctx.font = '600 21px system-ui, sans-serif';
    ctx.fillText('BEST ' + fmtLap(race.bestLap), 30, 152);
    ctx.textAlign = 'right';
    ctx.fillStyle = limiter ? RED : '#6fd06f';
    ctx.font = '700 24px system-ui, sans-serif';
    ctx.fillText('D ' + gearLabel, W - 30, 74);
    ctx.fillStyle = GREY;
    ctx.font = '600 21px system-ui, sans-serif';
    ctx.fillText('PDK AUTO', W - 30, 116);
  }

  // limiter border pulse
  if (limiter) {
    ctx.strokeStyle = 'rgba(230,0,30,0.85)';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, W - 8, H - 8);
  }

  car._clusterTex.needsUpdate = true;

  // ---- physical needles -------------------------------------------------------
  if (car.needleRPM) {
    car.needleRPM.rotation.z = -a0 - (a1 - a0) * Math.min(1, rpmNorm);
  }
  if (car.needleSpeed) {
    car.needleSpeed.rotation.z = -a0 - (a1 - a0) * Math.min(1, speedKmh / 280);
  }
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

  ctx.fillStyle = '#0d1218';
  ctx.fillRect(0, 0, W, 24);
  ctx.fillStyle = '#c8ced6';
  ctx.font = '700 12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('NAVIGATION', 10, 12);
  ctx.fillStyle = '#e6001e';
  ctx.fillText('● REC', W - 52, 12);

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

    ctx.strokeStyle = '#e8ecef';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pts[0][0] - 5, pts[0][1] - 5);
    ctx.lineTo(pts[0][0] + 5, pts[0][1] + 5);
    ctx.stroke();

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

  ctx.fillStyle = '#5a6570';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('3 LAPS · CHECKPOINTS ON', 10, H - 10);

  car._mmiTex.needsUpdate = true;
}
