/**
 * DriftMap — seeded procedural drift park.
 *
 * From one text seed it derives: a closed circuit (jittered ring of control
 * points smoothed by a centripetal Catmull-Rom spline), painted DRIFT ZONES
 * on the sharp corners (2x / 3x score multipliers by corner sharpness), a
 * central skidpad for donut practice (1.5x), tire walls, curbs, cones, tree
 * scatter and a start gantry.
 *
 * Collision is analytic against the track ribbon (nearest centerline sample
 * + lateral clamp), so no physics meshes are ever needed — cheap on mobile.
 * Same seed in, identical map out on every device.
 */
import * as THREE from 'three';
import { makeRNG, range, chance } from '../core/RNG.js';

const HALF_W = 7.5;          // road half width (15 m — generous for drift)
const WALL_OFF = HALF_W + 1.5;
const COLLIDE_OFF = HALF_W + 1.35;
const N_POINTS = 12;         // control points around the ring
const N_SAMPLES = 640;       // centerline samples (~2 m apart)
const R0 = 205;              // base ring radius
const SKIDPAD_R = 48;

export class DriftMap {
  constructor(seed) {
    this.seed = String(seed);
    this.group = new THREE.Group();
    this._build();
  }

  // ============================================================ generation

  _build() {
    const rng = makeRNG(this.seed);

    // ---- control points: jittered ring ---------------------------------
    const pts = [];
    for (let i = 0; i < N_POINTS; i++) {
      const ang = (i / N_POINTS) * Math.PI * 2 + range(rng, -0.16, 0.16);
      const r = R0 * (1 + range(rng, -0.34, 0.34));
      pts.push(new THREE.Vector3(Math.sin(ang) * r, 0, Math.cos(ang) * r));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    const raw = curve.getSpacedPoints(N_SAMPLES); // even arc spacing

    // ---- centerline samples with tangents / normals / curvature --------
    const S = this.samples = [];
    let dist = 0;
    for (let i = 0; i < N_SAMPLES; i++) {
      const p = raw[i];
      const pn = raw[(i + 1) % N_SAMPLES];
      const pp = raw[(i - 1 + N_SAMPLES) % N_SAMPLES];
      let tx = pn.x - pp.x, tz = pn.z - pp.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const seg = Math.hypot(pn.x - p.x, pn.z - p.z);
      dist += seg;
      S.push({
        x: p.x, z: p.z, tx, tz,
        nx: tz, nz: -tx,          // left of travel (facing +Z, left = +X-ish)
        dist, curv: 0, zone: 0,   // zone: 0 none | 2 | 3
      });
    }
    // signed curvature: heading change per arc length (+ = left turn)
    for (let i = 0; i < N_SAMPLES; i++) {
      const a = S[(i - 1 + N_SAMPLES) % N_SAMPLES];
      const b = S[(i + 1) % N_SAMPLES];
      const ha = Math.atan2(a.tx, a.tz);
      const hb = Math.atan2(b.tx, b.tz);
      let dh = hb - ha;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      const arc = b.dist - a.dist;
      S[i].curv = dh / Math.max(arc, 0.5);
    }
    // smooth curvature (box filter) to avoid spline noise
    const sm = S.map((s, i) => {
      let acc = 0;
      for (let k = -5; k <= 5; k++) acc += S[(i + k + N_SAMPLES) % N_SAMPLES].curv;
      return acc / 11;
    });
    S.forEach((s, i) => { s.curv = sm[i]; });

    // ---- drift zones on sharp corners -----------------------------------
    let i = 0;
    while (i < N_SAMPLES) {
      const k = Math.abs(S[i].curv);
      if (k > 1 / 70) {
        const mult = k > 1 / 40 ? 3 : 2;
        let j = i;
        while (j < N_SAMPLES && Math.abs(S[j].curv) > 1 / 70) j++;
        if (j - i >= 8) for (let q = i; q < j; q++) S[q].zone = mult;
        i = j;
      } else i++;
    }

    // ---- skidpad center: ring centroid ----------------------------------
    let cx = 0, cz = 0;
    for (const s of S) { cx += s.x; cz += s.z; }
    this.skidpad = { x: cx / N_SAMPLES, z: cz / N_SAMPLES, r: SKIDPAD_R, mult: 1.5 };

    this.trackLength = S[S.length - 1].dist;
    this.spawnIdx = 8; // slightly past the gantry
    this._trackIdx = 0;

    // ---- meshes ----------------------------------------------------------
    this._buildRoad();
    this._buildCurbsAndWalls();
    this._buildZones();
    this._buildSkidpad();
    this._buildProps(rng);
    this._buildGantry();
  }

  // ================================================================ meshes

  _buildRoad() {
    const S = this.samples;
    const n = N_SAMPLES;
    const pos = new Float32Array((n + 1) * 2 * 3);
    const uv = new Float32Array((n + 1) * 2 * 2);
    const idx = [];
    for (let i = 0; i <= n; i++) {
      const s = S[i % n];
      const v = s.dist / 12;
      const l = i * 2, r = i * 2 + 1;
      pos[l * 3] = s.x + s.nx * HALF_W; pos[l * 3 + 1] = 0.02; pos[l * 3 + 2] = s.z + s.nz * HALF_W;
      pos[r * 3] = s.x - s.nx * HALF_W; pos[r * 3 + 1] = 0.02; pos[r * 3 + 2] = s.z - s.nz * HALF_W;
      uv[l * 2] = 0; uv[l * 2 + 1] = v;
      uv[r * 2] = 1; uv[r * 2 + 1] = v;
      if (i < n) {
        const a = l, b = r, c = l + 2, d = r + 2;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const tex = makeAsphaltTexture();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex }));
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildCurbsAndWalls() {
    const S = this.samples;
    const n = N_SAMPLES;

    // curbs: red/white strips hugging the road inside drift zones
    const cPos = [], cUV = [], cIdx = [];
    let vc = 0;
    for (let i = 0; i < n; i++) {
      if (!S[i].zone) continue;
      const s = S[i], s2 = S[(i + 1) % n];
      for (const side of [1, -1]) {
        const v0 = s.dist / 4, v1 = s2.dist / 4;
        cPos.push(
          s.x + s.nx * (HALF_W + 1.2) * side, 0.05, s.z + s.nz * (HALF_W + 1.2) * side,
          s.x + s.nx * HALF_W * side, 0.05, s.z + s.nz * HALF_W * side,
          s2.x + s2.nx * (HALF_W + 1.2) * side, 0.05, s2.z + s2.nz * (HALF_W + 1.2) * side,
          s2.x + s2.nx * HALF_W * side, 0.05, s2.z + s2.nz * HALF_W * side,
        );
        cUV.push(0, v0, 1, v0, 0, v1, 1, v1);
        cIdx.push(vc, vc + 2, vc + 1, vc + 1, vc + 2, vc + 3);
        vc += 4;
      }
    }
    if (vc) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cPos), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(cUV), 2));
      g.setIndex(cIdx);
      g.computeVertexNormals();
      this.group.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: makeCurbTexture() })));
    }

    // walls: continuous low barriers both sides, vertex-colored stripes
    const wPos = [], wCol = [], wIdx = [];
    let vw = 0;
    const cA = new THREE.Color(0x2c2f36), cB = new THREE.Color(0xb33028);
    for (let i = 0; i < n; i++) {
      const s = S[i], s2 = S[(i + 1) % n];
      for (const side of [1, -1]) {
        const stripe = Math.floor(s.dist / 8) % 2 === 0 ? cA : cB;
        wPos.push(
          s.x + s.nx * WALL_OFF * side, 0, s.z + s.nz * WALL_OFF * side,
          s.x + s.nx * WALL_OFF * side, 0.95, s.z + s.nz * WALL_OFF * side,
          s2.x + s2.nx * WALL_OFF * side, 0, s2.z + s2.nz * WALL_OFF * side,
          s2.x + s2.nx * WALL_OFF * side, 0.95, s2.z + s2.nz * WALL_OFF * side,
        );
        for (let k = 0; k < 4; k++) wCol.push(stripe.r, stripe.g, stripe.b);
        wIdx.push(vw, vw + 2, vw + 1, vw + 1, vw + 2, vw + 3);
        vw += 4;
      }
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wPos), 3));
    wg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(wCol), 3));
    wg.setIndex(wIdx);
    wg.computeVertexNormals();
    const walls = new THREE.Mesh(wg, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    walls.castShadow = false;
    this.group.add(walls);
  }

  _buildZones() {
    // translucent overlays on the road surface marking drift zones
    const S = this.samples;
    const n = N_SAMPLES;
    for (const mult of [2, 3]) {
      const pos = [], idxArr = [];
      let v = 0;
      for (let i = 0; i < n; i++) {
        if (S[i].zone !== mult) continue;
        const s = S[i], s2 = S[(i + 1) % n];
        const inset = 0.7;
        pos.push(
          s.x + s.nx * (HALF_W - inset), 0.06, s.z + s.nz * (HALF_W - inset),
          s.x - s.nx * (HALF_W - inset), 0.06, s.z - s.nz * (HALF_W - inset),
          s2.x + s2.nx * (HALF_W - inset), 0.06, s2.z + s2.nz * (HALF_W - inset),
          s2.x - s2.nx * (HALF_W - inset), 0.06, s2.z - s2.nz * (HALF_W - inset),
        );
        idxArr.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
        v += 4;
      }
      if (!v) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      g.setIndex(idxArr);
      g.computeVertexNormals();
      const color = mult === 3 ? 0xff3b30 : 0xff9d14;
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.16, depthWrite: false,
      }));
      this.group.add(mesh);
    }
  }

  _buildSkidpad() {
    const sp = this.skidpad;
    const tex = makeSkidpadTexture();
    const circle = new THREE.Mesh(
      new THREE.CircleGeometry(sp.r, 56),
      new THREE.MeshLambertMaterial({ map: tex }),
    );
    circle.rotation.x = -Math.PI / 2;
    circle.position.set(sp.x, 0.015, sp.z);
    circle.receiveShadow = true;
    this.group.add(circle);

    // painted outer ring + center donut marker
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(sp.r - 2.2, sp.r - 0.9, 56),
      new THREE.MeshBasicMaterial({ color: 0xffd75e, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(sp.x, 0.05, sp.z);
    this.group.add(ring);
  }

  _buildProps(rng) {
    const S = this.samples;
    const n = N_SAMPLES;
    const sp = this.skidpad;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const scl = new THREE.Vector3();

    // --- cones marking the outside of drift zones
    const coneSpots = [];
    for (let i = 0; i < n; i += 5) {
      if (!S[i].zone) continue;
      const s = S[i];
      const side = s.curv > 0 ? -1 : 1; // outside of the corner
      coneSpots.push([s.x + s.nx * (HALF_W + 2.6) * side, s.z + s.nz * (HALF_W + 2.6) * side]);
    }
    const cones = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.22, 0.62, 8),
      new THREE.MeshLambertMaterial({ color: 0xff7a1a }), Math.max(coneSpots.length, 1));
    coneSpots.forEach(([x, z], k) => {
      m4.compose(new THREE.Vector3(x, 0.31, z), q, scl.set(1, 1, 1));
      cones.setMatrixAt(k, m4);
    });
    cones.count = coneSpots.length;
    cones.instanceMatrix.needsUpdate = true;
    this.group.add(cones);

    // --- tire stacks at zone entries (inside edge)
    const stackSpots = [];
    for (let i = 0; i < n; i += 26) {
      if (!S[i].zone) continue;
      const s = S[i];
      const side = s.curv > 0 ? 1 : -1; // inside of the corner
      for (let k = -1; k <= 1; k++) {
        const s2 = S[(i + k * 3 + n) % n];
        stackSpots.push([s2.x + s2.nx * (WALL_OFF + 1.4) * side, s2.z + s2.nz * (WALL_OFF + 1.4) * side, range(rng, 0, Math.PI * 2)]);
      }
    }
    const stacks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.5, 0.55, 0.95, 10),
      new THREE.MeshLambertMaterial({ color: 0x1d1f24 }), Math.max(stackSpots.length, 1));
    stackSpots.forEach(([x, z, rot], k) => {
      q.setFromAxisAngle(up, rot);
      m4.compose(new THREE.Vector3(x, 0.48, z), q, scl.set(1, 1, 1));
      stacks.setMatrixAt(k, m4);
    });
    stacks.count = stackSpots.length;
    stacks.instanceMatrix.needsUpdate = true;
    q.identity();
    this.group.add(stacks);

    // --- trees scattered away from the track
    const treeSpots = [];
    let guard = 0;
    while (treeSpots.length < 110 && guard++ < 900) {
      const x = range(rng, -420, 420), z = range(rng, -420, 420);
      let dMin = Infinity;
      for (let i = 0; i < n; i += 4) {
        const d = Math.hypot(S[i].x - x, S[i].z - z);
        if (d < dMin) dMin = d;
      }
      const dp = Math.hypot(sp.x - x, sp.z - z);
      if (dMin > 27 && dp > sp.r + 9) treeSpots.push([x, z, range(rng, 0.7, 1.5), range(rng, 0, Math.PI * 2)]);
    }
    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.24, 0.34, 2.8, 6),
      new THREE.MeshLambertMaterial({ color: 0x6b4a32 }), treeSpots.length);
    const crowns = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1.9, 0),
      new THREE.MeshLambertMaterial({ color: 0xffffff }), treeSpots.length);
    const crownColor = new THREE.Color();
    treeSpots.forEach(([x, z, s, rot], k) => {
      q.setFromAxisAngle(up, rot);
      m4.compose(new THREE.Vector3(x, 1.4 * s, z), q, scl.set(s, s, s));
      trunks.setMatrixAt(k, m4);
      m4.compose(new THREE.Vector3(x, (2.8 + 1.2) * s, z), q, scl.set(s, s * range(rng, 0.85, 1.25), s));
      crowns.setMatrixAt(k, m4);
      crownColor.setHSL(range(rng, 0.24, 0.33), range(rng, 0.42, 0.6), range(rng, 0.3, 0.42));
      crowns.setColorAt(k, crownColor);
    });
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    crowns.castShadow = true;
    this.group.add(trunks, crowns);
  }

  _buildGantry() {
    const s = this.samples[0];
    const g = new THREE.Group();
    const postMat = new THREE.MeshLambertMaterial({ color: 0x30343c });
    const postGeo = new THREE.BoxGeometry(0.6, 5.4, 0.6);
    for (const side of [1, -1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(s.nx * (HALF_W + 2) * side, 2.7, s.nz * (HALF_W + 2) * side);
      post.castShadow = true;
      g.add(post);
    }
    const bannerTex = makeBannerTexture();
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(HALF_W * 2 + 4.4, 1.15, 0.25),
      new THREE.MeshLambertMaterial({ map: bannerTex }),
    );
    banner.position.set(0, 5.1, 0);
    g.add(banner);
    g.position.set(s.x, 0, s.z);
    g.rotation.y = Math.atan2(s.tx, s.tz);
    this.group.add(g);

    // checkered start line
    const lineGeo = new THREE.PlaneGeometry(HALF_W * 2, 1.6);
    lineGeo.rotateX(-Math.PI / 2);
    const line = new THREE.Mesh(
      lineGeo,
      new THREE.MeshBasicMaterial({ map: makeCheckerTexture() }),
    );
    const s2 = this.samples[2];
    line.position.set(s2.x, 0.045, s2.z);
    line.rotation.y = Math.atan2(s2.tx, s2.tz);
    this.group.add(line);
  }

  // ============================================================== queries

  /** Nearest centerline sample index, searching a window around a hint. */
  nearestIdx(x, z, hint = this._trackIdx) {
    const S = this.samples;
    const n = N_SAMPLES;
    let best = hint, bestD = Infinity;
    for (let k = -16; k <= 16; k++) {
      const i = (hint + k + n) % n;
      const d = (S[i].x - x) ** 2 + (S[i].z - z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    // if the car is far from the hint window (reset, teleports) — full scan
    if (bestD > 90 * 90) {
      for (let i = 0; i < n; i += 2) {
        const d = (S[i].x - x) ** 2 + (S[i].z - z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    this._trackIdx = best;
    return best;
  }

  /** Lateral offset from the centerline (+ = left of travel). */
  lateralOffset(x, z, idx) {
    const s = this.samples[idx];
    return (x - s.x) * s.nx + (z - s.z) * s.nz;
  }

  /**
   * Push the car back inside the tire walls. Returns impact speed (m/s) or 0.
   */
  resolveCollision(phys, hintIdx) {
    const idx = this.nearestIdx(phys.x, phys.z, hintIdx);
    const s = this.samples[idx];
    const lat = (phys.x - s.x) * s.nx + (phys.z - s.z) * s.nz;
    if (Math.abs(lat) <= COLLIDE_OFF) return 0;
    const sgn = Math.sign(lat);
    // push back inside
    const corr = (Math.abs(lat) - COLLIDE_OFF) * sgn;
    phys.x -= s.nx * corr;
    phys.z -= s.nz * corr;
    // reflect the into-wall velocity component (restitution 0.45)
    const vn = phys.vxW * s.nx + phys.vzW * s.nz;
    if (vn * sgn > 0) {
      phys.vxW -= s.nx * vn * 1.45;
      phys.vzW -= s.nz * vn * 1.45;
      phys.vxW *= 0.92; phys.vzW *= 0.92; // tangential scrub
      return Math.abs(vn);
    }
    return 0.01;
  }

  /** Score multiplier at a position: drift zone or skidpad. */
  zoneMultAt(x, z, idx) {
    const sp = this.skidpad;
    if ((sp.x - x) ** 2 + (sp.z - z) ** 2 < sp.r * sp.r) return sp.mult;
    return this.samples[idx].zone;
  }

  /** Spawn pose { x, z, heading }. */
  spawnPose() {
    const s = this.samples[this.spawnIdx];
    return { x: s.x, z: s.z, heading: Math.atan2(s.tx, s.tz) };
  }

  /** Safe reset pose: nearest sample, facing along the track. */
  resetPose(x, z) {
    const idx = this.nearestIdx(x, z, this._trackIdx);
    const s = this.samples[idx];
    return { x: s.x, z: s.z, heading: Math.atan2(s.tx, s.tz) };
  }
}

// ============================================================ textures

function canvasTex(size, draw, repX = 1, repY = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repX, repY);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function makeAsphaltTexture() {
  return canvasTex(256, (ctx, s) => {
    ctx.fillStyle = '#3a3d43';
    ctx.fillRect(0, 0, s, s);
    // speckle
    for (let i = 0; i < 1500; i++) {
      const g = 40 + Math.random() * 46;
      ctx.fillStyle = `rgba(${g},${g},${g + 6},${0.12 + Math.random() * 0.2})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1.6, 1.6);
    }
    // edge lines
    ctx.fillStyle = 'rgba(240,240,235,0.92)';
    ctx.fillRect(s * 0.022, 0, s * 0.02, s);
    ctx.fillRect(s * 0.958, 0, s * 0.02, s);
    // center dash (yellow): half tile painted
    ctx.fillStyle = 'rgba(255,214,90,0.85)';
    ctx.fillRect(s / 2 - s * 0.012, 0, s * 0.024, s * 0.5);
  });
}

function makeSkidpadTexture() {
  return canvasTex(256, (ctx, s) => {
    ctx.fillStyle = '#33363c';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 1200; i++) {
      const g = 36 + Math.random() * 40;
      ctx.fillStyle = `rgba(${g},${g},${g + 5},${0.1 + Math.random() * 0.18})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1.6, 1.6);
    }
    // concentric guide rings
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 3;
    for (const r of [0.72, 0.45]) {
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, s * r / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
}

function makeCurbTexture() {
  return canvasTex(64, (ctx, s) => {
    ctx.fillStyle = '#d8d8d2';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(0, 0, s, s / 2);
  });
}

function makeCheckerTexture() {
  return canvasTex(128, (ctx, s) => {
    const cell = s / 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#111318' : '#e8e8e2';
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  });
}

function makeBannerTexture() {
  return canvasTex(512, (ctx, s) => {
    ctx.fillStyle = '#14171d';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#ff3b30';
    ctx.fillRect(0, 0, s, 14);
    ctx.fillRect(0, s - 14, s, 14);
    ctx.fillStyle = '#f2f4f8';
    ctx.font = 'bold 108px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('APEX DRIFT', s / 2, s / 2 + 4);
  }, 1, 1);
}
