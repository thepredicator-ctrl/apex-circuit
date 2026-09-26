/**
 * DriftMap — seeded procedural drift park (v2).
 *
 * From one text seed it derives a closed circuit whose character comes from
 * a RADIAL PROFILE applied to a ring of control points: seeded "notches"
 * pull the path inward into hairpin complexes, "bulges" push it out into
 * fast sweepers, and the jitter between them produces natural esses. The
 * result reads as a designed track (straight → sweeper → hairpin → esses →
 * back straight) instead of a random blob.
 *
 * Everything else is dressed for drifting: DRIFT ZONES painted on the sharp
 * corners with ×2 / ×3 score labels, a big central skidpad (×1.5) with
 * donut rings, chevron arrows on zone entries, light poles, a start gantry
 * plus a mid-track banner arch, a small grandstand, palm/oak scatter and an
 * OPEN low rail fence instead of solid walls (visibility = mobile comfort).
 *
 * Collision stays analytic against the track ribbon (nearest centerline
 * sample + lateral clamp) — no physics meshes, cheap on mobile, identical
 * map from the same seed on every device.
 */
import * as THREE from 'three';
import { makeRNG, range } from '../core/RNG.js';

const HALF_W = 8.5;          // road half width (17 m — generous for drift)
const FENCE_OFF = HALF_W + 1.6;
const COLLIDE_OFF = HALF_W + 1.45;
const N_POINTS = 16;         // control points around the ring
const N_SAMPLES = 680;       // centerline samples (~2.2 m apart)
const R0 = 215;              // base ring radius
const SKIDPAD_R = 54;

export class DriftMap {
  constructor(seed) {
    this.seed = String(seed);
    this.group = new THREE.Group();
    this._build();
  }

  // ============================================================ generation

  _build() {
    const rng = makeRNG(this.seed);

    // ---- radial profile: notches (hairpins) + bulges (sweepers) ---------
    const gauss = (d, s) => Math.exp(-(d * d) / (2 * s * s));
    const notches = [];
    const nCount = 2 + Math.floor(range(rng, 0, 1.6));   // 2..3 notches
    let ang = range(rng, 0.5, 1.0);
    for (let i = 0; i < nCount; i++) {
      notches.push({ ang, width: range(rng, 0.16, 0.23), depth: range(rng, 0.3, 0.4) });
      ang += (Math.PI * 2) / nCount + range(rng, -0.5, 0.5);
    }
    const bulges = [];
    for (let i = 0; i < notches.length; i++) {
      const mid = notches[i].ang + ((notches[(i + 1) % notches.length].ang - notches[i].ang
        + (i + 1 < notches.length ? 0 : Math.PI * 2)) % (Math.PI * 2)) / 2;
      bulges.push({ ang: mid % (Math.PI * 2), width: range(rng, 0.3, 0.45), depth: range(rng, 0.16, 0.26) });
    }

    // ---- control points --------------------------------------------------
    const pts = [];
    for (let i = 0; i < N_POINTS; i++) {
      const a = (i / N_POINTS) * Math.PI * 2;
      let r = R0;
      for (const n of notches) {
        let d = Math.abs(a - n.ang); d = Math.min(d, Math.PI * 2 - d);
        r *= 1 - n.depth * gauss(d, n.width);
      }
      for (const b of bulges) {
        let d = Math.abs(a - b.ang); d = Math.min(d, Math.PI * 2 - d);
        r *= 1 + b.depth * gauss(d, b.width);
      }
      r *= 1 + range(rng, -0.05, 0.05);
      pts.push(new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r));
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
      dist += Math.hypot(pn.x - p.x, pn.z - p.z);
      S.push({
        x: p.x, z: p.z, tx, tz,
        nx: tz, nz: -tx,          // left of travel
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
      S[i].curv = dh / Math.max(b.dist - a.dist, 0.5);
    }
    const sm = S.map((s, i) => {
      let acc = 0;
      for (let k = -5; k <= 5; k++) acc += S[(i + k + N_SAMPLES) % N_SAMPLES].curv;
      return acc / 11;
    });
    S.forEach((s, i) => { s.curv = sm[i]; });

    // ---- drift zones on sharp corners (auto-lower threshold if sparse) ---
    let thr2 = 1 / 75, thr3 = 1 / 44;
    for (let attempt = 0; attempt < 3; attempt++) {
      S.forEach((s) => { s.zone = 0; });
      let i = 0, zones = 0;
      while (i < N_SAMPLES) {
        const k = Math.abs(S[i].curv);
        if (k > thr2) {
          const mult = k > thr3 ? 3 : 2;
          let j = i;
          while (j < N_SAMPLES && Math.abs(S[j].curv) > thr2) j++;
          if (j - i >= 8) { for (let q = i; q < j; q++) S[q].zone = mult; zones++; }
          i = j;
        } else i++;
      }
      if (zones >= 4) break;
      thr2 /= 1.18; thr3 /= 1.18;
    }

    // ---- skidpad center: ring centroid ----------------------------------
    let cx = 0, cz = 0;
    for (const s of S) { cx += s.x; cz += s.z; }
    this.skidpad = { x: cx / N_SAMPLES, z: cz / N_SAMPLES, r: SKIDPAD_R, mult: 1.5 };

    this.trackLength = S[S.length - 1].dist;
    this.spawnIdx = 8;
    this._trackIdx = 0;

    // ---- meshes ----------------------------------------------------------
    this._buildRoad();
    this._buildCurbsAndFence();
    this._buildZones();
    this._buildSkidpad();
    this._buildProps(rng);
    this._buildGantry(0, 'APEX DRIFT');
    const far = S.reduce((best, s, i) =>
      Math.hypot(s.x - S[0].x, s.z - S[0].z) > Math.hypot(S[best].x - S[0].x, S[best].z - S[0].z) ? i : best, 0);
    this._buildGantry(far, 'KEEP SLIDING');
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
      const v = s.dist / 14;
      const l = i * 2, r = i * 2 + 1;
      pos[l * 3] = s.x + s.nx * HALF_W; pos[l * 3 + 1] = 0.10; pos[l * 3 + 2] = s.z + s.nz * HALF_W;
      pos[r * 3] = s.x - s.nx * HALF_W; pos[r * 3 + 1] = 0.10; pos[r * 3 + 2] = s.z - s.nz * HALF_W;
      uv[l * 2] = 0; uv[l * 2 + 1] = v;
      uv[r * 2] = 1; uv[r * 2 + 1] = v;
      if (i < n) {
        const a = l, b = r, c = l + 2, d = r + 2;
        // winding chosen so face normals point UP (+Y) — the previous order
        // faced down and FrontSide culling made the road invisible
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: makeAsphaltTexture() }));
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildCurbsAndFence() {
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
          s.x + s.nx * (HALF_W + 1.1) * side, 0.14, s.z + s.nz * (HALF_W + 1.1) * side,
          s.x + s.nx * HALF_W * side, 0.12, s.z + s.nz * HALF_W * side,
          s2.x + s2.nx * (HALF_W + 1.1) * side, 0.14, s2.z + s2.nz * (HALF_W + 1.1) * side,
          s2.x + s2.nx * HALF_W * side, 0.12, s2.z + s2.nz * HALF_W * side,
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
      this.group.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({
        map: makeCurbTexture(), side: THREE.DoubleSide, // mirrored sides flip winding
      })));
    }

    // OPEN fence: thin white posts every ~13 m + one low rail — the park
    // stays visible (mobile comfort: no tall solid walls blocking view)
    const postGeo = new THREE.BoxGeometry(0.14, 1.0, 0.14);
    const postMat = new THREE.MeshLambertMaterial({ color: 0xe8e6df });
    const postCount = Math.floor(n / 6);
    const posts = new THREE.InstancedMesh(postGeo, postMat, postCount * 2);
    const m4 = new THREE.Matrix4();
    let pi = 0;
    for (let i = 0; i < n; i += 6) {
      const s = S[i];
      for (const side of [1, -1]) {
        m4.makeTranslation(s.x + s.nx * FENCE_OFF * side, 0.5, s.z + s.nz * FENCE_OFF * side);
        posts.setMatrixAt(pi++, m4);
      }
    }
    posts.count = pi;
    posts.instanceMatrix.needsUpdate = true;
    this.group.add(posts);

    const rPos = [], rIdx = [];
    let vr = 0;
    for (let i = 0; i < n; i++) {
      const s = S[i], s2 = S[(i + 1) % n];
      for (const side of [1, -1]) {
        rPos.push(
          s.x + s.nx * FENCE_OFF * side, 0.78, s.z + s.nz * FENCE_OFF * side,
          s.x + s.nx * FENCE_OFF * side, 0.62, s.z + s.nz * FENCE_OFF * side,
          s2.x + s2.nx * FENCE_OFF * side, 0.78, s2.z + s2.nz * FENCE_OFF * side,
          s2.x + s2.nx * FENCE_OFF * side, 0.62, s2.z + s2.nz * FENCE_OFF * side,
        );
        rIdx.push(vr, vr + 2, vr + 1, vr + 1, vr + 2, vr + 3);
        vr += 4;
      }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rPos), 3));
    rg.setIndex(rIdx);
    rg.computeVertexNormals();
    this.group.add(new THREE.Mesh(rg, new THREE.MeshLambertMaterial({
      color: 0xf2f0e8, side: THREE.DoubleSide,
    })));
  }

  _buildZones() {
    const S = this.samples;
    const n = N_SAMPLES;
    for (const mult of [2, 3]) {
      const pos = [], idxArr = [], uvArr = [];
      let v = 0;
      for (let i = 0; i < n; i++) {
        if (S[i].zone !== mult) continue;
        const s = S[i], s2 = S[(i + 1) % n];
        const inset = 0.7;
        const v0 = s.dist / 9, v1 = s2.dist / 9;
        pos.push(
          s.x + s.nx * (HALF_W - inset), 0.16, s.z + s.nz * (HALF_W - inset),
          s.x - s.nx * (HALF_W - inset), 0.16, s.z - s.nz * (HALF_W - inset),
          s2.x + s2.nx * (HALF_W - inset), 0.16, s2.z + s2.nz * (HALF_W - inset),
          s2.x - s2.nx * (HALF_W - inset), 0.16, s2.z - s2.nz * (HALF_W - inset),
        );
        uvArr.push(0, v0, 1, v0, 0, v1, 1, v1);
        // normals up (same fix as the road ribbon)
        idxArr.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        v += 4;
      }
      if (!v) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvArr), 2));
      g.setIndex(idxArr);
      g.computeVertexNormals();
      const color = mult === 3 ? 0xff3b30 : 0xff9d14;
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.14, depthWrite: false,
      }));
      this.group.add(mesh);

      // painted ×2 / ×3 labels: one at each contiguous zone run's midpoint,
      // plus a second one on long runs
      const labelTex = makeZoneLabelTexture(mult);
      const runs = [];
      let i = 0;
      while (i < n) {
        if (S[i].zone !== mult) { i++; continue; }
        let j = i;
        while (j < n && S[j].zone === mult) j++;
        runs.push([i, j]);
        i = j;
      }
      for (const [a, b] of runs) {
        const spots = b - a > 56 ? [Math.round((a + b) / 2), (a + 26) % n] : [Math.round((a + b) / 2)];
        for (const si of spots) {
          const s = S[si];
          const lbl = new THREE.Mesh(
            new THREE.PlaneGeometry(6.5, 6.5),
            new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthWrite: false, opacity: 0.85 }),
          );
          lbl.rotation.x = -Math.PI / 2;
          lbl.rotation.z = -Math.atan2(s.tx, s.tz);
          lbl.position.set(s.x, 0.18, s.z);
          this.group.add(lbl);
        }
      }
    }

    // chevron arrows on the approach into each zone (point the way in)
    const chevTex = makeChevronTexture();
    for (let i = 0; i < n; i++) {
      const s = S[i], nxt = S[(i + 14) % n];
      if (!nxt.zone || s.zone) continue;
      if ((i % 12) !== 0) continue;
      const arr = new THREE.Mesh(
        new THREE.PlaneGeometry(3.4, 5),
        new THREE.MeshBasicMaterial({ map: chevTex, transparent: true, depthWrite: false, opacity: 0.7 }),
      );
      arr.rotation.x = -Math.PI / 2;
      arr.rotation.z = -Math.atan2(s.tx, s.tz);
      arr.position.set(s.x, 0.18, s.z);
      this.group.add(arr);
    }
  }

  _buildSkidpad() {
    const sp = this.skidpad;
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(sp.r, 56),
      new THREE.MeshLambertMaterial({ map: makeSkidpadTexture() }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(sp.x, 0.12, sp.z);
    pad.receiveShadow = true;
    this.group.add(pad);

    // painted outer ring + donut guide rings + ×1.5 badge
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(sp.r - 2.4, sp.r - 0.9, 56),
      new THREE.MeshBasicMaterial({ color: 0xffd75e, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(sp.x, 0.16, sp.z);
    this.group.add(ring);

    const guide = new THREE.Mesh(
      new THREE.RingGeometry(sp.r * 0.46 - 0.4, sp.r * 0.46, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    guide.rotation.x = -Math.PI / 2;
    guide.position.set(sp.x, 0.16, sp.z);
    this.group.add(guide);

    const badge = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      new THREE.MeshBasicMaterial({ map: makeZoneLabelTexture('×1.5'), transparent: true, depthWrite: false, opacity: 0.8 }),
    );
    badge.rotation.x = -Math.PI / 2;
    badge.position.set(sp.x, 0.18, sp.z);
    this.group.add(badge);
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
      coneSpots.push([s.x + s.nx * (HALF_W + 2.4) * side, s.z + s.nz * (HALF_W + 2.4) * side]);
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
    for (let i = 0; i < n; i += 22) {
      if (!S[i].zone) continue;
      const s = S[i];
      const side = s.curv > 0 ? 1 : -1; // inside of the corner
      for (let k = -1; k <= 1; k++) {
        const s2 = S[(i + k * 3 + n) % n];
        stackSpots.push([s2.x + s2.nx * (FENCE_OFF + 1.2) * side, s2.z + s2.nz * (FENCE_OFF + 1.2) * side, range(rng, 0, Math.PI * 2)]);
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

    // --- light poles along the track, alternating sides
    const poleSpots = [];
    for (let i = 0; i < n; i += 44) {
      const s = S[i];
      const side = (i / 44) % 2 === 0 ? 1 : -1;
      poleSpots.push([s.x + s.nx * (FENCE_OFF + 2.2) * side, s.z + s.nz * (FENCE_OFF + 2.2) * side, Math.atan2(s.tx, s.tz)]);
    }
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 6.4, 6);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x4a4f58 });
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, poleSpots.length);
    const headGeo = new THREE.BoxGeometry(1.5, 0.22, 0.5);
    const headMat = new THREE.MeshLambertMaterial({ color: 0xd8dde5, emissive: 0x8a7a40, emissiveIntensity: 0.55 });
    const heads = new THREE.InstancedMesh(headGeo, headMat, poleSpots.length);
    poleSpots.forEach(([x, z, rot], k) => {
      m4.compose(new THREE.Vector3(x, 3.2, z), q.identity(), scl.set(1, 1, 1));
      poles.setMatrixAt(k, m4);
      q.setFromAxisAngle(up, rot);
      m4.compose(new THREE.Vector3(x - Math.sin(rot) * 0.8, 6.3, z - Math.cos(rot) * 0.8), q, scl.set(1, 1, 1));
      heads.setMatrixAt(k, m4);
    });
    poles.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    this.group.add(poles, heads);

    // --- grandstand near the start straight (outside the fence)
    const s0 = S[4];
    const gSide = 1;
    const gx = s0.x + s0.nx * (FENCE_OFF + 9) * gSide;
    const gz = s0.z + s0.nz * (FENCE_OFF + 9) * gSide;
    const rot = Math.atan2(s0.tx, s0.tz);
    const stand = new THREE.Group();
    const concrete = new THREE.MeshLambertMaterial({ color: 0x9aa0a8 });
    const seatColors = [0xc74a3c, 0x3c74c7, 0xd8b13c];
    for (let tier = 0; tier < 3; tier++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(26, 0.8 + tier * 0.9, 2.2), concrete);
      step.position.set(0, (0.8 + tier * 0.9) / 2, tier * 2.1);
      step.castShadow = true;
      stand.add(step);
      const crowd = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.26, 6, 5),
        new THREE.MeshLambertMaterial({ color: seatColors[tier % 3] }), 34);
      for (let c = 0; c < 34; c++) {
        m4.compose(new THREE.Vector3(-12 + c * 0.72 + range(rng, -0.2, 0.2), 0.8 + tier * 0.9 + 0.5, tier * 2.1 + range(rng, -0.5, 0.5)),
          q.identity(), scl.set(1, 1, 1));
        crowd.setMatrixAt(c, m4);
      }
      crowd.instanceMatrix.needsUpdate = true;
      stand.add(crowd);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(27, 0.25, 8), new THREE.MeshLambertMaterial({ color: 0x2c3038 }));
    roof.position.set(0, 4.6, 2.0);
    stand.add(roof);
    for (const px of [-12.5, 12.5]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4.6, 0.3), concrete);
      leg.position.set(px, 2.3, 5.4);
      stand.add(leg);
    }
    stand.position.set(gx, 0, gz);
    stand.rotation.y = rot + (gSide > 0 ? Math.PI : 0);
    this.group.add(stand);

    // --- trees: palms near the fence, oaks scattered wide
    const palmSpots = [], oakSpots = [];
    let guard = 0;
    while (palmSpots.length + oakSpots.length < 130 && guard++ < 1200) {
      const x = range(rng, -430, 430), z = range(rng, -430, 430);
      let dMin = Infinity;
      for (let i = 0; i < n; i += 4) {
        const d = Math.hypot(S[i].x - x, S[i].z - z);
        if (d < dMin) dMin = d;
      }
      const dp = Math.hypot(sp.x - x, sp.z - z);
      if (dMin <= 24 || dp <= sp.r + 8) continue;
      const spot = [x, z, range(rng, 0.75, 1.4), range(rng, 0, Math.PI * 2)];
      if (dMin < 44 && palmSpots.length < 46) palmSpots.push(spot);
      else oakSpots.push(spot);
    }

    const palmTrunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.14, 0.24, 4.4, 6),
      new THREE.MeshLambertMaterial({ color: 0x8a6a45 }), Math.max(palmSpots.length, 1));
    const palmCrowns = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1.7, 1.1, 7),
      new THREE.MeshLambertMaterial({ color: 0x3f9a4d }), Math.max(palmSpots.length, 1));
    palmSpots.forEach(([x, z, s, rot2], k) => {
      m4.compose(new THREE.Vector3(x, 2.2 * s, z), q.setFromAxisAngle(up, rot2), scl.set(s, s, s));
      palmTrunks.setMatrixAt(k, m4);
      m4.compose(new THREE.Vector3(x, 4.5 * s, z), q, scl.set(s, s * 0.6, s));
      palmCrowns.setMatrixAt(k, m4);
    });
    palmTrunks.instanceMatrix.needsUpdate = true;
    palmCrowns.instanceMatrix.needsUpdate = true;
    this.group.add(palmTrunks, palmCrowns);

    const oakTrunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.24, 0.34, 2.8, 6),
      new THREE.MeshLambertMaterial({ color: 0x6b4a32 }), Math.max(oakSpots.length, 1));
    const crowns = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1.9, 0),
      new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(oakSpots.length, 1));
    const crownColor = new THREE.Color();
    oakSpots.forEach(([x, z, s, rot2], k) => {
      m4.compose(new THREE.Vector3(x, 1.4 * s, z), q.setFromAxisAngle(up, rot2), scl.set(s, s, s));
      oakTrunks.setMatrixAt(k, m4);
      m4.compose(new THREE.Vector3(x, (2.8 + 1.2) * s, z), q, scl.set(s, s * range(rng, 0.85, 1.25), s));
      crowns.setMatrixAt(k, m4);
      crownColor.setHSL(range(rng, 0.26, 0.36), range(rng, 0.38, 0.58), range(rng, 0.3, 0.44));
      crowns.setColorAt(k, crownColor);
    });
    oakTrunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    crowns.castShadow = true;
    this.group.add(oakTrunks, crowns);
  }

  _buildGantry(idx, text) {
    const S = this.samples;
    const s = S[idx];
    const g = new THREE.Group();
    const postMat = new THREE.MeshLambertMaterial({ color: 0x30343c });
    const postGeo = new THREE.BoxGeometry(0.6, 5.4, 0.6);
    for (const side of [1, -1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(s.nx * (HALF_W + 2) * side, 2.7, s.nz * (HALF_W + 2) * side);
      post.castShadow = true;
      g.add(post);
    }
    const bannerTex = makeBannerTexture(text);
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(HALF_W * 2 + 4.4, 1.15, 0.25),
      new THREE.MeshLambertMaterial({ map: bannerTex }),
    );
    banner.position.set(0, 5.1, 0);
    g.add(banner);
    g.position.set(s.x, 0, s.z);
    g.rotation.y = Math.atan2(s.tx, s.tz);
    this.group.add(g);

    if (text === 'APEX DRIFT') {
      // checkered start line under the main gantry
      const lineGeo = new THREE.PlaneGeometry(HALF_W * 2, 1.6);
      lineGeo.rotateX(-Math.PI / 2);
      const line = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ map: makeCheckerTexture() }));
      const s2 = S[(idx + 2) % N_SAMPLES];
      line.position.set(s2.x, 0.12, s2.z);
      line.rotation.y = Math.atan2(s2.tx, s2.tz);
      this.group.add(line);
    }
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

  /**
   * Push the car back inside the fence. Returns impact speed (m/s) or 0.
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
    // reflect the into-fence velocity component (restitution 0.45)
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

function makeBannerTexture(text) {
  return canvasTex(512, (ctx, s) => {
    ctx.fillStyle = '#14171d';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#ff3b30';
    ctx.fillRect(0, 0, s, 14);
    ctx.fillRect(0, s - 14, s, 14);
    ctx.fillStyle = '#f2f4f8';
    ctx.font = 'bold 96px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, s / 2, s / 2 + 4);
  }, 1, 1);
}

function makeZoneLabelTexture(mult) {
  return canvasTex(256, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = 'bold 150px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 10;
    const label = typeof mult === 'number' ? `×${mult}` : mult;
    ctx.strokeText(label, s / 2, s / 2);
    ctx.fillText(label, s / 2, s / 2);
  }, 1, 1);
}

function makeChevronTexture() {
  return canvasTex(128, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(255,214,90,0.9)';
    // two chevrons pointing +v (travel direction after rotation)
    for (const yOff of [0.18, 0.62]) {
      ctx.beginPath();
      ctx.moveTo(s * 0.2, s * (yOff + 0.22));
      ctx.lineTo(s * 0.5, s * yOff);
      ctx.lineTo(s * 0.8, s * (yOff + 0.22));
      ctx.lineTo(s * 0.8, s * (yOff + 0.05));
      ctx.lineTo(s * 0.5, s * (yOff - 0.18));
      ctx.lineTo(s * 0.2, s * (yOff + 0.05));
      ctx.closePath();
      ctx.fill();
    }
  }, 1, 1);
}
