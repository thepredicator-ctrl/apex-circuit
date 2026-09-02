/**
 * Track — a complete procedural race circuit with rolling elevation and
 * banked corners: asphalt ribbon with painted edge lines, red/white curbs,
 * gravel runoff, concrete walls, grass terrain that follows the road,
 * trees, tire stacks, distance boards, sponsor boards, light poles,
 * start/finish gantry with a 5-light start tree, checkpoint gates,
 * grandstand, distant mountains and clouds.
 *
 * The circuit is a closed Catmull-Rom spline sampled into ~1000 points.
 * Sample heights come from a smooth global terrain function; corners get
 * progressive banking. Those samples power physics surface lookup, car
 * attitude (pitch/bank) and race progress.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TRACK } from './Constants.js';

// Circuit layout (x, z). s=0 sits on the start/finish straight.
const CONTROL_POINTS = [
  [-52, 132], [60, 134], [128, 122],
  [182, 74], [188, 8],
  [160, -44], [178, -104], [128, -146],
  [30, -158], [-48, -128], [-118, -148],
  [-186, -108], [-196, -34], [-162, 30],
  [-196, 88], [-148, 128]
];

/** smooth global terrain height (drives track elevation + landscape) */
function terrainH(x, z) {
  return 2.1 * Math.sin(x * 0.0082 + 1.7) * Math.cos(z * 0.0074 + 0.4)
    + 1.15 * Math.sin(x * 0.017 + 0.6) * Math.sin(z * 0.015 + 2.0)
    + 0.55 * Math.cos(z * 0.031 + 0.8);
}

const BANK_GAIN = 5.2;        // banking slope per unit curvature
const BANK_MAX = 0.105;       // ~6 deg

function canvasTexture(w, h, draw, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = opts.wrapS ?? THREE.RepeatWrapping;
  tex.wrapT = opts.wrapT ?? THREE.RepeatWrapping;
  tex.anisotropy = opts.anisotropy ?? 4;
  return tex;
}

function noise(ctx, w, h, count, alpha, dark, light) {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const s = 1 + Math.random() * 2;
    ctx.fillStyle = Math.random() < 0.5 ? dark : light;
    ctx.globalAlpha = alpha * Math.random();
    ctx.fillRect(x, y, s, s);
  }
  ctx.globalAlpha = 1;
}

function ribbonGeometry(A, B, vArr) {
  const M = A.length;
  const positions = new Float32Array(M * 6);
  const uvs = new Float32Array(M * 4);
  const indices = [];
  for (let i = 0; i < M; i++) {
    positions[i * 6 + 0] = A[i].x; positions[i * 6 + 1] = A[i].y; positions[i * 6 + 2] = A[i].z;
    positions[i * 6 + 3] = B[i].x; positions[i * 6 + 4] = B[i].y; positions[i * 6 + 5] = B[i].z;
    uvs[i * 4 + 0] = 0; uvs[i * 4 + 1] = vArr[i];
    uvs[i * 4 + 2] = 1; uvs[i * 4 + 3] = vArr[i];
  }
  for (let i = 0; i < M - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    indices.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export class Track {
  constructor(maxAnisotropy = 4) {
    this.group = new THREE.Group();
    this.roadHalfWidth = TRACK.roadHalfWidth;
    this._buildTextures(maxAnisotropy);
    this._buildCurveAndSamples();
    this._buildRoad();
    this._buildRunoff();
    this._buildCurbs();
    this._buildWalls();
    this._buildGround();
    this._buildStartLine();
    this._buildGantry();
    this._buildGates();
    this._buildGrandstand();
    this._buildBoards();
    this._buildLightPoles();
    this._buildTrees();
    this._buildTireStacks();
    this._buildMountains();
    this._buildClouds();
  }

  // ---------------------------------------------------------------- textures
  _buildTextures(aniso) {
    this.texAsphalt = canvasTexture(256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#3b3e43';
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 2200, 0.16, '#2e3136', '#4a4e55');
      // tire wear bands
      ctx.fillStyle = '#33363b';
      ctx.globalAlpha = 0.5;
      ctx.fillRect(w * 0.32, 0, w * 0.09, h);
      ctx.fillRect(w * 0.59, 0, w * 0.09, h);
      ctx.globalAlpha = 1;
      // edge lines
      ctx.fillStyle = '#e9ecef';
      ctx.fillRect(w * 0.035, 0, w * 0.028, h);
      ctx.fillRect(w * 0.937, 0, w * 0.028, h);
    }, { anisotropy: aniso });

    this.texCurb = canvasTexture(32, 64, (ctx, w, h) => {
      ctx.fillStyle = '#d8402f';
      ctx.fillRect(0, 0, w, h / 2);
      ctx.fillStyle = '#eceff2';
      ctx.fillRect(0, h / 2, w, h / 2);
      noise(ctx, w, h, 60, 0.1, '#00000022', '#ffffff22');
    }, { anisotropy: aniso });

    this.texRunoff = canvasTexture(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#8a8474';
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 900, 0.22, '#6e685a', '#a49d8c');
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = '#75705f';
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.arc(Math.random() * w, Math.random() * h, 3 + Math.random() * 8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }, { anisotropy: aniso });
    this.texRunoff.repeat.set(2, 1);

    this.texWall = canvasTexture(64, 64, (ctx, w, h) => {
      // u axis = wall height (bottom -> top)
      ctx.fillStyle = '#9aa0a6';
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 350, 0.12, '#7c8288', '#b8bec4');
      ctx.fillStyle = '#7c8288';
      ctx.globalAlpha = 0.5;
      for (let y = 0; y < h; y += 16) ctx.fillRect(0, y, w * 0.7, 1);
      ctx.globalAlpha = 1;
      // red/white band on top
      for (let y = 0; y < h; y += 16) {
        ctx.fillStyle = (y / 16) % 2 === 0 ? '#d8402f' : '#eceff2';
        ctx.fillRect(w * 0.72, y, w * 0.28, 16);
      }
    }, { anisotropy: aniso });

    this.texGrass = canvasTexture(256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#55873f';
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 2600, 0.2, '#41702f', '#6b9c50');
      // large soft blotches to break tiling
      for (let i = 0; i < 24; i++) {
        ctx.fillStyle = Math.random() < 0.5 ? '#4a7a35' : '#5f9247';
        ctx.globalAlpha = 0.16;
        ctx.beginPath();
        ctx.arc(Math.random() * w, Math.random() * h, 14 + Math.random() * 26, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }, { anisotropy: aniso });
    this.texGrass.repeat.set(96, 96);

    this.texChecker = canvasTexture(160, 48, (ctx, w, h) => {
      const cw = w / 10, ch = h / 3;
      for (let x = 0; x < 10; x++) {
        for (let y = 0; y < 3; y++) {
          ctx.fillStyle = (x + y) % 2 === 0 ? '#f2f4f6' : '#121418';
          ctx.fillRect(x * cw, y * ch, cw, ch);
        }
      }
    }, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, anisotropy: aniso });

    this.texBanner = canvasTexture(1024, 128, (ctx, w, h) => {
      ctx.fillStyle = '#101418';
      ctx.fillRect(0, 0, w, h);
      for (let x = 0; x < w / 16; x++) {
        ctx.fillStyle = x % 2 === 0 ? '#f2f4f6' : '#121418';
        ctx.fillRect(x * 16, 0, 16, 12);
        ctx.fillStyle = x % 2 === 0 ? '#121418' : '#f2f4f6';
        ctx.fillRect(x * 16, h - 12, 16, 12);
      }
      ctx.fillStyle = '#f2f4f6';
      ctx.font = 'italic 900 64px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('APEX CIRCUIT', w / 2, h / 2 + 2);
      ctx.fillStyle = '#ff3b30';
      ctx.fillRect(w / 2 - 190, h / 2 + 34, 380, 5);
    }, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, anisotropy: aniso });

    this.texBoard = canvasTexture(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#f2f4f6';
      ctx.fillRect(0, 0, w, h);
      const stripes = 3;
      for (let i = 0; i < stripes; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#d8402f' : '#121418';
        ctx.fillRect(14, 18 + i * 34, w - 28, 26);
      }
      ctx.strokeStyle = '#121418';
      ctx.lineWidth = 6;
      ctx.strokeRect(3, 3, w - 6, h - 6);
    }, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, anisotropy: aniso });

    this.texSponsor = canvasTexture(512, 96, (ctx, w, h) => {
      ctx.fillStyle = '#f2f4f6';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#121418';
      ctx.font = 'italic 900 52px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('APEX CIRCUIT', w / 2, h / 2);
      ctx.fillStyle = '#d8342a';
      ctx.fillRect(0, h - 10, w, 10);
    }, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, anisotropy: aniso });
  }

  // ------------------------------------------------------------- centerline
  _buildCurveAndSamples() {
    const pts = CONTROL_POINTS.map(([x, z]) => new THREE.Vector3(x, terrainH(x, z), z));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');

    const N = TRACK.sampleCount;
    this.sampleCount = N;
    const spaced = this.curve.getSpacedPoints(N); // N+1, last == first
    this.px = new Float32Array(N);
    this.py = new Float32Array(N);
    this.pz = new Float32Array(N);
    this.tanX = new Float32Array(N);
    this.tanZ = new Float32Array(N);
    this.rightX = new Float32Array(N);
    this.rightZ = new Float32Array(N);
    this.curbFlag = new Uint8Array(N);

    for (let i = 0; i < N; i++) {
      this.px[i] = spaced[i].x;
      this.py[i] = spaced[i].y;
      this.pz[i] = spaced[i].z;
    }
    // arc length (uniform spacing thanks to getSpacedPoints)
    this.spacing = this.curve.getLength() / N;
    this.totalLength = this.curve.getLength();

    let maxCurv = 0;
    for (let i = 0; i < N; i++) {
      const prev = (i - 1 + N) % N;
      const next = (i + 1) % N;
      let tx = this.px[next] - this.px[prev];
      let tz = this.pz[next] - this.pz[prev];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      this.tanX[i] = tx;
      this.tanZ[i] = tz;
      // right = tangent x up  ->  ( -tz, 0, tx )
      // matches physics/camera convention: positive lateral = right of travel
      this.rightX[i] = -tz;
      this.rightZ[i] = tx;

      // signed curvature: + = turning toward the right vector
      const t0x = this.tanX[prev], t0z = this.tanZ[prev];
      const cross = t0z * tx - t0x * tz; // y component of t0 x t1
      const angle = Math.asin(THREE.MathUtils.clamp(cross, -1, 1));
      this.curv = this.curv || new Float32Array(N);
      this.curv[i] = angle / (2 * this.spacing);
      maxCurv = Math.max(maxCurv, Math.abs(this.curv[i]));
    }
    // mark curb samples (corners), padded by 6 samples
    for (let i = 0; i < N; i++) {
      if (Math.abs(this.curv[i]) > 0.011) {
        for (let k = -6; k <= 6; k++) this.curbFlag[(i + k + N) % N] = 1;
      }
    }

    // banking: raise the OUTER edge of corners (positive bank = right low)
    const rawBank = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      rawBank[i] = THREE.MathUtils.clamp(-this.curv[i] * BANK_GAIN, -BANK_MAX, BANK_MAX);
    }
    // wide smoothing so banking eases in/out progressively
    this.bank = new Float32Array(N);
    const W = 30;
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let k = -W; k <= W; k++) sum += rawBank[(i + k + N) % N];
      this.bank[i] = sum / (2 * W + 1);
    }

    // slope along the tangent (for car pitch)
    this.slope = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const prev = (i - 1 + N) % N;
      const next = (i + 1) % N;
      this.slope[i] = (this.py[next] - this.py[prev]) / (2 * this.spacing);
    }
  }

  // -------------------------------------------------- surface height API
  /**
   * Road-surface height, slope and bank at a sample + lateral offset.
   * Banking fades out through the runoff so the grass meets the terrain.
   */
  surfaceAt(idx, lateral) {
    const half = this.roadHalfWidth;
    const absLat = Math.abs(lateral);
    let bankScale = 1;
    const inner = half + 1.5;
    if (absLat > inner) {
      bankScale = Math.max(0, 1 - (absLat - inner) / 3.5);
    }
    const y = this.py[idx] + lateral * this.bank[idx] * bankScale;
    return {
      y,
      slope: this.slope[idx],
      bankSlope: this.bank[idx] * bankScale
    };
  }

  /** world height for props / terrain blending (x, z) */
  heightAtWorld(x, z) {
    const N = this.sampleCount;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < N; i += 5) {
      const dx = x - this.px[i], dz = z - this.pz[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    const dist = Math.sqrt(bestD);
    const lateral = (x - this.px[best]) * this.rightX[best] + (z - this.pz[best]) * this.rightZ[best];
    const surf = this.surfaceAt(best, lateral);
    const t = THREE.MathUtils.clamp((dist - (this.roadHalfWidth + 5.5)) / 45, 0, 1);
    const tS = t * t * (3 - 2 * t);
    return surf.y * (1 - tS) + terrainH(x, z) * tS;
  }

  // ------------------------------------------------------------------- road
  _buildRoad() {
    const N = this.sampleCount;
    const half = this.roadHalfWidth;
    const A = [], B = [], vArr = [];
    for (let i = 0; i <= N; i++) {
      const j = i % N;
      const x = this.px[j], z = this.pz[j];
      const rx = this.rightX[j], rz = this.rightZ[j];
      const bank = this.bank[j];
      A.push(new THREE.Vector3(x + rx * half, this.py[j] + bank * half, z + rz * half));
      B.push(new THREE.Vector3(x - rx * half, this.py[j] - bank * half, z - rz * half));
      vArr.push((i * this.spacing) / 9);
    }
    const geo = ribbonGeometry(A, B, vArr);
    const mat = new THREE.MeshStandardMaterial({
      map: this.texAsphalt, roughness: 0.94, metalness: 0, side: THREE.DoubleSide
    });
    const road = new THREE.Mesh(geo, mat);
    road.receiveShadow = true;
    this.group.add(road);
  }

  // ----------------------------------------------------------------- runoff
  _buildRunoff() {
    const N = this.sampleCount;
    const half = this.roadHalfWidth;
    const inner = half + 1.5;
    const outer = half + 5.0;
    const geos = [];
    for (const side of [1, -1]) {
      const A = [], B = [], vArr = [];
      for (let i = 0; i <= N; i++) {
        const j = i % N;
        const x = this.px[j], z = this.pz[j];
        const rx = this.rightX[j] * side, rz = this.rightZ[j] * side;
        const yIn = this.py[j] + this.bank[j] * inner * side;
        const yOut = this.py[j] + this.bank[j] * outer * Math.max(0, 1 - (outer - inner) / 3.5)
          - 0.12; // drain gently toward the grass
        A.push(new THREE.Vector3(x + rx * inner, yIn, z + rz * inner));
        B.push(new THREE.Vector3(x + rx * outer, yOut, z + rz * outer));
        vArr.push(i * this.spacing / 5);
      }
      geos.push(ribbonGeometry(A, B, vArr));
    }
    const runoff = new THREE.Mesh(
      mergeGeometries(geos),
      new THREE.MeshStandardMaterial({ map: this.texRunoff, roughness: 0.96, metalness: 0, side: THREE.DoubleSide })
    );
    runoff.receiveShadow = true;
    this.group.add(runoff);
  }

  // ------------------------------------------------------------------ curbs
  _buildCurbs() {
    const N = this.sampleCount;
    const half = this.roadHalfWidth;
    const geos = [];

    const runs = [];
    let start = -1;
    for (let i = 0; i < N; i++) {
      if (this.curbFlag[i] && start < 0) start = i;
      if ((!this.curbFlag[i] || i === N - 1) && start >= 0) {
        runs.push([start, i]);
        start = -1;
      }
    }
    if (runs.length && runs[0][0] === 0 && runs[runs.length - 1][1] === N - 1 && runs.length > 1) {
      // merge wrap-around run
      const first = runs.shift();
      runs[runs.length - 1][1] = N + first[1];
    }

    for (const [a0, b0] of runs) {
      for (const side of [1, -1]) {
        const A = [], B = [], vArr = [];
        const len = b0 - a0;
        for (let k = 0; k <= len; k++) {
          const j = (a0 + k + N) % N;
          const x = this.px[j], z = this.pz[j];
          const rx = this.rightX[j] * side, rz = this.rightZ[j] * side;
          const yIn = this.py[j] + this.bank[j] * (half - 0.05) * side + 0.03;
          const yOut = this.py[j] + this.bank[j] * (half + 1.35) * side + 0.09;
          A.push(new THREE.Vector3(x + rx * (half - 0.05), yIn, z + rz * (half - 0.05)));
          B.push(new THREE.Vector3(x + rx * (half + 1.35), yOut, z + rz * (half + 1.35)));
          vArr.push((k * this.spacing) / 3);
        }
        geos.push(ribbonGeometry(A, B, vArr));
      }
    }

    if (geos.length) {
      const merged = mergeGeometries(geos);
      const curbs = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
        map: this.texCurb, roughness: 0.85, metalness: 0, side: THREE.DoubleSide
      }));
      curbs.receiveShadow = true;
      this.group.add(curbs);
    }
  }

  // ------------------------------------------------------------------ walls
  _buildWalls() {
    const N = this.sampleCount;
    const dist = this.roadHalfWidth + 3.4;
    const geos = [];
    for (const side of [1, -1]) {
      const A = [], B = [], vArr = [];
      for (let i = 0; i <= N; i++) {
        const j = i % N;
        const x = this.px[j], z = this.pz[j];
        const rx = this.rightX[j] * side, rz = this.rightZ[j] * side;
        // wall base sits on the runoff surface
        const yBase = this.py[j] + this.bank[j] * dist * side * Math.max(0, 1 - (dist - (this.roadHalfWidth + 1.5)) / 3.5) - 0.05;
        A.push(new THREE.Vector3(x + rx * dist, yBase, z + rz * dist));
        B.push(new THREE.Vector3(x + rx * dist, yBase + 1.15, z + rz * dist));
        vArr.push((i * this.spacing) / 4);
      }
      geos.push(ribbonGeometry(A, B, vArr));
    }
    const walls = new THREE.Mesh(
      mergeGeometries(geos),
      new THREE.MeshStandardMaterial({
        map: this.texWall, roughness: 0.9, metalness: 0.05, side: THREE.DoubleSide
      })
    );
    walls.receiveShadow = true;
    this.group.add(walls);
  }

  // ------------------------------------------------------------------ grass
  _buildGround() {
    const SIZE = 2400;
    const SEG = 140;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, this.heightAtWorld(x, z) - 0.06);
    }
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ map: this.texGrass, roughness: 1, metalness: 0 })
    );
    ground.receiveShadow = true;
    this.group.add(ground);
  }

  // ------------------------------------------------------------- start line
  _startPose() {
    const tan = this.tangentAt(0);
    return {
      pos: new THREE.Vector3(this.px[0], this.py[0], this.pz[0]),
      heading: Math.atan2(tan.x, tan.z),
      right: new THREE.Vector3(tan.z, 0, -tan.x)
    };
  }

  _buildStartLine() {
    const { pos, heading } = this._startPose();
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(this.roadHalfWidth * 2, 3),
      new THREE.MeshStandardMaterial({ map: this.texChecker, roughness: 0.85 })
    );
    // lay the plane flat, then spin it about world-up to align with the road
    line.rotation.order = 'YXZ';
    line.rotation.y = heading;
    line.rotation.x = -Math.PI / 2;
    line.position.set(pos.x, pos.y + 0.06, pos.z);
    line.receiveShadow = true;
    this.group.add(line);
  }

  _buildGantry() {
    const { pos, heading } = this._startPose();
    const g = new THREE.Group();
    // inside this group: local +X = track right, local +Z = track tangent
    g.position.set(pos.x, pos.y, pos.z);
    g.rotation.y = heading;
    const mat = new THREE.MeshStandardMaterial({ color: 0x2c313a, roughness: 0.6, metalness: 0.5 });

    for (const side of [1, -1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 8.5, 0.7), mat);
      pillar.position.set((this.roadHalfWidth + 2) * side, 3.2, 0); // sunk 1m into the ground
      pillar.castShadow = true;
      g.add(pillar);
    }
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry((this.roadHalfWidth + 2) * 2 + 0.7, 1.1, 0.8), mat
    );
    beam.position.y = 6.4;
    beam.castShadow = true;
    g.add(beam);

    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(this.roadHalfWidth * 2, 1.7),
      new THREE.MeshStandardMaterial({ map: this.texBanner, side: THREE.DoubleSide, roughness: 0.8 })
    );
    // flip so the readable face greets oncoming cars
    banner.rotation.y = Math.PI;
    banner.position.y = 5.25;
    g.add(banner);

    // ---- start lights (5 lamps, driven by Game via setState) --------------
    const lampPanel = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.9, 0.3), mat);
    lampPanel.position.set(0, 7.15, 0.1);
    g.add(lampPanel);
    this.startLamps = [];
    for (let i = 0; i < 5; i++) {
      const lampMat = new THREE.MeshStandardMaterial({
        color: 0x1a1d22, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.4
      });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), lampMat);
      lamp.position.set((i - 2) * 0.68, 7.15, -0.08); // facing oncoming cars (-tangent)
      g.add(lamp);
      this.startLamps.push(lampMat);
    }

    this.group.add(g);
  }

  /**
   * Start-light states: 0 = off, 1..5 = red lamps lit, 6 = all green,
   * 7 = dark again.
   */
  setStartLights(state) {
    if (!this.startLamps) return;
    for (let i = 0; i < 5; i++) {
      const mat = this.startLamps[i];
      if (state >= 1 && state <= 5) {
        const on = i < state;
        mat.color.setHex(on ? 0x7a0d08 : 0x1a1d22);
        mat.emissive.setHex(on ? 0xff2418 : 0x000000);
        mat.emissiveIntensity = on ? 2.6 : 0;
      } else if (state === 6) {
        mat.color.setHex(0x0c5c26);
        mat.emissive.setHex(0x2bff64);
        mat.emissiveIntensity = 2.8;
      } else {
        mat.color.setHex(0x1a1d22);
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
      }
    }
  }

  // ------------------------------------------------------------------ gates
  _buildGates() {
    const gateMat = new THREE.MeshStandardMaterial({
      color: 0x1d2b33, emissive: 0x35e0ff, emissiveIntensity: 1.5, roughness: 0.5
    });
    const beamMat = new THREE.MeshStandardMaterial({
      color: 0x1d2b33, emissive: 0x35e0ff, emissiveIntensity: 1.2,
      transparent: true, opacity: 0.45
    });

    for (const s of TRACK.checkpoints) {
      const tan = this.tangentAt(s);
      const p = this.pointAt(s);
      const heading = Math.atan2(tan.x, tan.z);
      const g = new THREE.Group();
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = heading;

      for (const side of [1, -1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.8, 8), gateMat);
        post.position.set((this.roadHalfWidth + 0.5) * side, 1.7, 0);
        g.add(post);
      }
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry(this.roadHalfWidth * 2 + 1, 0.08, 0.08), beamMat
      );
      beam.position.y = 3.4;
      g.add(beam);

      this.group.add(g);
    }
  }

  // ------------------------------------------------------------ grandstand
  _buildGrandstand() {
    const s = 10 / this.totalLength; // a little down the road from the line
    const tan = this.tangentAt(s);
    const p = this.pointAt(s);
    const heading = Math.atan2(tan.x, tan.z);
    const g = new THREE.Group();
    // local +X = track right (stand sits on the -X side), local +Z = along track
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = heading;

    // platform base sinks into the terrain so the stand never floats
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(11, 3.4, 24.4),
      new THREE.MeshStandardMaterial({ color: 0x3c4148, roughness: 0.95 })
    );
    base.position.set(-(this.roadHalfWidth + 7.4), -1.5, 0);
    g.add(base);

    const stepMatA = new THREE.MeshStandardMaterial({ color: 0x565d66, roughness: 0.9 });
    const stepMatB = new THREE.MeshStandardMaterial({ color: 0x494f57, roughness: 0.9 });
    for (let i = 0; i < 4; i++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.9, 24), i % 2 ? stepMatA : stepMatB);
      step.position.set(-(this.roadHalfWidth + 5.5 + i * 1.7), 0.45 + i * 0.9, 0);
      step.castShadow = true;
      step.receiveShadow = true;
      g.add(step);
    }
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(8, 0.18, 24),
      new THREE.MeshStandardMaterial({ color: 0xd8342a, roughness: 0.5, metalness: 0.3 })
    );
    roof.position.set(-(this.roadHalfWidth + 8), 4.6, 0);
    roof.castShadow = true;
    g.add(roof);
    for (const x of [-(this.roadHalfWidth + 5), -(this.roadHalfWidth + 11)]) {
      for (const z of [-11, 11]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4.4, 6), stepMatB);
        post.position.set(x, 2.3, z);
        g.add(post);
      }
    }

    // sponsor boards along the wall in front of the stand
    for (const z of [-8, 0, 8]) {
      const board = new THREE.Mesh(
        new THREE.PlaneGeometry(6, 0.9),
        new THREE.MeshStandardMaterial({ map: this.texSponsor, roughness: 0.7, side: THREE.DoubleSide })
      );
      board.position.set(-(this.roadHalfWidth + 3.2), 0.75, z);
      board.rotation.y = Math.PI / 2;
      g.add(board);
    }

    this.group.add(g);
  }

  // ------------------------------------------------- boards (brake markers)
  _buildBoards() {
    const N = this.sampleCount;
    const half = this.roadHalfWidth;
    const spacingM = this.spacing;
    const boardMat = new THREE.MeshStandardMaterial({ map: this.texBoard, roughness: 0.7, side: THREE.DoubleSide });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.8 });

    // find corner entries: curvature rising past threshold
    const entries = [];
    for (let i = 2; i < N; i++) {
      if (Math.abs(this.curv[i]) > 0.012 && Math.abs(this.curv[i - 1]) <= 0.012) {
        entries.push(i);
      }
    }

    for (const e of entries) {
      for (const backM of [90, 50]) {
        const i = (e - Math.round(backM / spacingM) + N) % N;
        const side = this.curv[e] > 0 ? -1 : 1; // boards on the outside of the corner
        const x = this.px[i] + this.rightX[i] * (half + 2.6) * side;
        const z = this.pz[i] + this.rightZ[i] * (half + 2.6) * side;
        const y = this.heightAtWorld(x, z);
        const g = new THREE.Group();
        g.position.set(x, y, z);
        g.rotation.y = Math.atan2(this.tanX[i], this.tanZ[i]);
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6), postMat);
        post.position.y = 0.7;
        g.add(post);
        const board = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), boardMat);
        board.position.y = 1.55;
        board.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        g.add(board);
        this.group.add(g);
      }
    }
  }

  // ------------------------------------------------------------ light poles
  _buildLightPoles() {
    const N = this.sampleCount;
    const half = this.roadHalfWidth;
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x48505a, roughness: 0.6, metalness: 0.6 });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xdde3ea, emissive: 0xfff3d0, emissiveIntensity: 0.35, roughness: 0.4
    });
    const geos = [];
    const lampHeads = [];
    for (let k = 0; k < 8; k++) {
      const i = Math.round((k / 8) * N);
      const side = k % 2 === 0 ? 1 : -1;
      const x = this.px[i] + this.rightX[i] * (half + 7.5) * side;
      const z = this.pz[i] + this.rightZ[i] * (half + 7.5) * side;
      const y = this.heightAtWorld(x, z);
      const pole = new THREE.CylinderGeometry(0.09, 0.14, 9, 8);
      pole.translate(x, y + 4.5, z);
      geos.push(pole);
      const armDir = -side;
      const arm = new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6).rotateZ(Math.PI / 2);
      arm.translate(x + this.rightX[i] * 0.8 * armDir, y + 9, z + this.rightZ[i] * 0.8 * armDir);
      geos.push(arm);
      const head = new THREE.BoxGeometry(0.7, 0.14, 0.3);
      head.translate(x + this.rightX[i] * 1.5 * armDir, y + 8.95, z + this.rightZ[i] * 1.5 * armDir);
      lampHeads.push(head);
    }
    const polesMesh = new THREE.Mesh(mergeGeometries(geos, false), poleMat);
    polesMesh.castShadow = true;
    this.group.add(polesMesh);
    const headsMesh = new THREE.Mesh(mergeGeometries(lampHeads, false), lampMat);
    this.group.add(headsMesh);
  }

  // ------------------------------------------------------------------ trees
  _buildTrees() {
    const half = this.roadHalfWidth;
    const positions = [];
    let attempts = 0;
    while (positions.length < 150 && attempts < 900) {
      attempts++;
      const x = -300 + Math.random() * 600;
      const z = -280 + Math.random() * 540;
      let minD = Infinity;
      for (let i = 0; i < this.sampleCount; i += 6) {
        const dx = x - this.px[i], dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < minD) minD = d;
      }
      minD = Math.sqrt(minD);
      if (minD > half + 10 && minD < 170) positions.push([x, z]);
    }

    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1.5, 6);
    const pineGeo = new THREE.ConeGeometry(1.05, 2.7, 7);
    const blobGeo = new THREE.IcosahedronGeometry(1.15, 0);
    blobGeo.scale(1, 1.25, 1);

    const pines = [], blobs = [];
    for (const [x, z] of positions) {
      (Math.random() < 0.55 ? pines : blobs).push([x, z]);
    }

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.95 });
    const crownMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    const crownColors = [0x2f6b33, 0x3a7a3d, 0x2c5f30, 0x4d8a3f, 0x467a38];

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, positions.length);
    const pinesMesh = new THREE.InstancedMesh(pineGeo, crownMat, Math.max(1, pines.length));
    const blobsMesh = new THREE.InstancedMesh(blobGeo, crownMat.clone(), Math.max(1, blobs.length));

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    positions.forEach(([x, z], i) => {
      const s = 0.75 + Math.random() * 0.9;
      const y = this.heightAtWorld(x, z);
      dummy.position.set(x, y + 0.7 * s, z);
      dummy.scale.setScalar(s);
      dummy.rotation.y = Math.random() * Math.PI * 2;
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
    });
    const fill = (mesh, list, baseY) => {
      list.forEach(([x, z], i) => {
        const s = 0.75 + Math.random() * 0.9;
        const y = this.heightAtWorld(x, z);
        dummy.position.set(x, y + baseY * s, z);
        dummy.scale.setScalar(s);
        dummy.rotation.y = Math.random() * Math.PI * 2;
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, color.setHex(crownColors[(Math.random() * crownColors.length) | 0]));
      });
      mesh.count = list.length;
    };
    fill(pinesMesh, pines, 2.35);
    fill(blobsMesh, blobs, 2.15);

    for (const m of [trunks, pinesMesh, blobsMesh]) {
      m.castShadow = true;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      this.group.add(m);
    }
  }

  // ------------------------------------------------------------ tire stacks
  _buildTireStacks() {
    const N = this.sampleCount;
    const half = this.roadHalfWidth;
    const list = [];
    for (let i = 0; i < N; i += 8) {
      if (Math.abs(this.curv[i]) > 0.02) {
        for (const side of [1, -1]) {
          const x = this.px[i] + this.rightX[i] * (half + 2.7) * side;
          const z = this.pz[i] + this.rightZ[i] * (half + 2.7) * side;
          list.push([x, z, i, side]);
        }
      }
    }
    if (!list.length) return;

    const geo = new THREE.CylinderGeometry(0.44, 0.44, 0.85, 10);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const palette = [0xd8402f, 0xe8eaec, 0x22252a];
    list.forEach(([x, z, i, side], k) => {
      const y = this.heightAtWorld(x, z);
      dummy.position.set(x, y + 0.43, z);
      dummy.scale.setScalar(1);
      dummy.rotation.y = Math.random() * Math.PI;
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
      mesh.setColorAt(k, color.setHex(palette[k % 3]));
    });
    mesh.castShadow = true;
    this.group.add(mesh);
  }

  // -------------------------------------------------------------- mountains
  _buildMountains() {
    const geos = [];
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 780 + Math.random() * 200;
      const r = 100 + Math.random() * 130;
      const h = 80 + Math.random() * 100;
      const cone = new THREE.ConeGeometry(r, h, 6, 1);
      cone.translate(Math.cos(ang) * dist, h / 2 - 6, Math.sin(ang) * dist);
      geos.push(cone);
    }
    const mesh = new THREE.Mesh(
      mergeGeometries(geos),
      new THREE.MeshLambertMaterial({ color: 0x7d93ac, flatShading: true })
    );
    this.group.add(mesh);
  }

  // ----------------------------------------------------------------- clouds
  _buildClouds() {
    const parts = [];
    for (let c = 0; c < 8; c++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 260 + Math.random() * 300;
      const cx = Math.cos(ang) * dist;
      const cz = Math.sin(ang) * dist;
      const cy = 130 + Math.random() * 55;
      const puffs = 3 + (Math.random() * 3 | 0);
      for (let p = 0; p < puffs; p++) {
        const s = new THREE.IcosahedronGeometry(1, 1);
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(
            cx + (Math.random() - 0.5) * 34,
            cy + (Math.random() - 0.5) * 6,
            cz + (Math.random() - 0.5) * 30
          ),
          new THREE.Quaternion(),
          new THREE.Vector3(9 + Math.random() * 13, 3 + Math.random() * 2.5, 7 + Math.random() * 10)
        );
        s.applyMatrix4(m);
        parts.push(s);
      }
    }
    const mesh = new THREE.Mesh(
      mergeGeometries(parts),
      new THREE.MeshLambertMaterial({
        color: 0xffffff, transparent: true, opacity: 0.92,
        emissive: 0xbfd4e2, emissiveIntensity: 0.55
      })
    );
    this.group.add(mesh);
  }

  // ------------------------------------------------------------- sampling API
  /**
   * Locate a world position relative to the circuit.
   * @returns {{idx:number, s:number, lateral:number, rightX:number, rightZ:number, tanX:number, tanZ:number, curb:boolean}}
   */
  locate(x, z, hintIdx = null) {
    const N = this.sampleCount;
    let best = -1;
    let bestD = Infinity;
    if (hintIdx == null) {
      for (let i = 0; i < N; i += 4) {
        const dx = x - this.px[i], dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      // refine around best
      const c = best;
      for (let k = -4; k <= 4; k++) {
        const i = (c + k + N) % N;
        const dx = x - this.px[i], dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    } else {
      for (let k = -34; k <= 34; k++) {
        const i = (hintIdx + k + N) % N;
        const dx = x - this.px[i], dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      // robustness: if the car is far from the hinted window (teleport,
      // chaos), fall back to a full scan
      if (bestD > 1600) return this.locate(x, z, null);
    }
    const lateral = (x - this.px[best]) * this.rightX[best] + (z - this.pz[best]) * this.rightZ[best];
    return {
      idx: best,
      s: best / N,
      lateral,
      rightX: this.rightX[best],
      rightZ: this.rightZ[best],
      tanX: this.tanX[best],
      tanZ: this.tanZ[best],
      curb: this.curbFlag[best] === 1
    };
  }

  pointAt(s) {
    const N = this.sampleCount;
    const f = ((s % 1) + 1) % 1 * N;
    const i = Math.floor(f) % N;
    const t = f - Math.floor(f);
    const j = (i + 1) % N;
    return new THREE.Vector3(
      THREE.MathUtils.lerp(this.px[i], this.px[j], t),
      THREE.MathUtils.lerp(this.py[i], this.py[j], t),
      THREE.MathUtils.lerp(this.pz[i], this.pz[j], t)
    );
  }

  tangentAt(s) {
    const N = this.sampleCount;
    const i = Math.floor((((s % 1) + 1) % 1) * N) % N;
    const v = new THREE.Vector3(this.tanX[i], 0, this.tanZ[i]);
    return v.normalize();
  }

  /** Car start: ~12 m before the start/finish line, facing down the straight. */
  get startS() {
    return 1 - 12 / this.totalLength;
  }
}
