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
import { stripExtras as stripTreeExtras, toFloat32Geometry } from './ModelKit.js';

/** Merge float32 geometries keeping only attributes present in every part. */
function mergeTreeGeos(geos) {
  if (geos.length === 1) return geos[0];
  const common = Object.keys(geos[0].attributes).filter((name) =>
    geos.every((g) => g.attributes[name])
  );
  const clean = geos.map((g) => {
    const out = new THREE.BufferGeometry();
    for (const name of common) out.setAttribute(name, g.attributes[name]);
    return out;
  });
  const merged = mergeGeometries(clean, false);
  return merged || clean[0];
}

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
    this._buildWallTops();
    this._buildTunnel();
    this._buildGround();
    this._buildStartLine();
    this._buildGantry();
    this._buildGates();
    this._buildGrandstand();
    this._buildBoards();
    this._buildLightPoles();
    this._buildTireStacks();
    this._buildBushes();          // NEW: low bushes scattered in the grass
    this._buildRocks();           // NEW: rocks of varying sizes
    this._buildDistanceSigns();   // NEW: roadside distance/corner signs
    this._buildFence();           // NEW: chain-link fence along straights
    this._buildMountains();
    this._buildClouds();
    // References to the procedural surface meshes so they can be hidden
    // when a GLB track model is loaded as the visible surface.
    this._proceduralSurfaceMeshes = [
      this.roadMesh, this.runoffMesh, this.groundMesh,
      this.curbsMesh, this.wallMesh, this.wallTopsMesh
    ].filter(Boolean);
  }

  /**
   * Hide the procedural road/runoff/ground meshes — called when a GLB track
   * model is loaded as the visible racing surface. The physics spline + curbs
   * + tire stacks + signs + fences remain because they're either physics
   * collision geometry or trackside details that complement the GLB track.
   */
  hideProceduralSurface() {
    for (const m of this._proceduralSurfaceMeshes) {
      if (m) m.visible = false;
    }
  }

  // ---------------------------------------------------------------- textures
  _buildTextures(aniso) {
    this.texAsphalt = canvasTexture(256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#1e2126';
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 2400, 0.2, '#15171b', '#2b2f36');
      // tire wear bands (slightly polished = a touch darker)
      ctx.fillStyle = '#1a1d22';
      ctx.globalAlpha = 0.55;
      ctx.fillRect(w * 0.32, 0, w * 0.09, h);
      ctx.fillRect(w * 0.59, 0, w * 0.09, h);
      ctx.globalAlpha = 1;
      // edge lines
      ctx.fillStyle = '#b9bfc8';
      ctx.fillRect(w * 0.035, 0, w * 0.028, h);
      ctx.fillRect(w * 0.937, 0, w * 0.028, h);
      // faint dashed center line
      ctx.fillStyle = '#79818c';
      ctx.globalAlpha = 0.5;
      for (let y = 0; y < h; y += 48) ctx.fillRect(w / 2 - 2, y, 4, 22);
      ctx.globalAlpha = 1;
    }, { anisotropy: aniso });

    this.texCurb = canvasTexture(32, 64, (ctx, w, h) => {
      ctx.fillStyle = '#93261a';
      ctx.fillRect(0, 0, w, h / 2);
      ctx.fillStyle = '#c9cfd7';
      ctx.fillRect(0, h / 2, w, h / 2);
      noise(ctx, w, h, 60, 0.1, '#00000022', '#ffffff22');
    }, { anisotropy: aniso });

    this.texRunoff = canvasTexture(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#45423a';
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 900, 0.22, '#312e27', '#57534a');
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = '#39362f';
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
      ctx.fillStyle = '#3d4148';
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 350, 0.12, '#2b2e34', '#4d525a');
      ctx.fillStyle = '#2b2e34';
      ctx.globalAlpha = 0.5;
      for (let y = 0; y < h; y += 16) ctx.fillRect(0, y, w * 0.7, 1);
      ctx.globalAlpha = 1;
      // red/white band on top
      for (let y = 0; y < h; y += 16) {
        ctx.fillStyle = (y / 16) % 2 === 0 ? '#8f2418' : '#c6ccd4';
        ctx.fillRect(w * 0.72, y, w * 0.28, 16);
      }
    }, { anisotropy: aniso });

    this.texGrass = canvasTexture(256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#1a2718';
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 2600, 0.2, '#121c12', '#24351f');
      // large soft blotches to break tiling
      for (let i = 0; i < 24; i++) {
        ctx.fillStyle = Math.random() < 0.5 ? '#152114' : '#1f2f1b';
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

    // light-box texture pool shared by the emissive trackside panels
    this.texLightBox = canvasTexture(256, 256, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 8, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(255,241,214,0.85)');
      g.addColorStop(0.55, 'rgba(255,225,170,0.35)');
      g.addColorStop(1, 'rgba(255,220,160,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });

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
    this.roadMesh = road;
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
    this.runoffMesh = runoff;
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
        map: this.texCurb, roughness: 0.8, metalness: 0, side: THREE.DoubleSide,
        // faint self-lit strip so the racing line stays readable at night
        emissive: 0xffffff, emissiveMap: this.texCurb, emissiveIntensity: 0.33
      }));
      curbs.receiveShadow = true;
      this.group.add(curbs);
      this.curbsMesh = curbs;
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
    this.wallMesh = walls;
  }

  /**
   * Retro-reflective marker strip along the top of both walls — a thin
   * emissive line that traces the whole circuit at night and reads as the
   * dangerous edge of the track.
   */
  _buildWallTops() {
    const N = this.sampleCount;
    const dist = this.roadHalfWidth + 3.4;
    const geos = [];
    for (const side of [1, -1]) {
      const A = [], B = [], vArr = [];
      for (let i = 0; i <= N; i++) {
        const j = i % N;
        const x = this.px[j], z = this.pz[j];
        const rx = this.rightX[j] * side, rz = this.rightZ[j] * side;
        const yBase = this.py[j] + this.bank[j] * dist * side * Math.max(0, 1 - (dist - (this.roadHalfWidth + 1.5)) / 3.5) - 0.05;
        A.push(new THREE.Vector3(x + rx * (dist - 0.02), yBase + 1.16, z + rz * (dist - 0.02)));
        B.push(new THREE.Vector3(x + rx * (dist + 0.16), yBase + 1.16, z + rz * (dist + 0.16)));
        vArr.push(i * this.spacing / 4);
      }
      geos.push(ribbonGeometry(A, B, vArr));
    }
    const strip = new THREE.Mesh(
      mergeGeometries(geos),
      new THREE.MeshBasicMaterial({ color: 0x8fa3bd, toneMapped: false })
    );
    strip.renderOrder = 2;
    this.group.add(strip);
    this.wallTopsMesh = strip;
  }

  /**
   * Night tunnel: a ~70 m concrete tube over the fast sweeper after the
   * start straight. Ribs follow the centerline; cool-white light strips run
   * across the ceiling, amber portals mark both entrances.
   */
  _buildTunnel() {
    const N = this.sampleCount;
    const W = this.roadHalfWidth + 3.6;   // tunnel half width (outside physics walls)
    const H = 5.6;                        // tunnel inner height
    const ribEvery = Math.max(4, Math.round(7 / this.spacing));
    const s0 = 0.13, s1 = 0.19;
    const i0 = Math.round(s0 * N), i1 = Math.round(s1 * N);
    const span = (i1 - i0 + N) % N;
    if (span < ribEvery * 4) return;      // curve too short — skip quietly

    const dummy = new THREE.Object3D();
    const concrete = [], strips = [], portals = [];
    const stripPts = [];
    const ribs = Math.floor(span / ribEvery);

    for (let r = 0; r <= ribs; r++) {
      const j = (i0 + r * ribEvery) % N;
      const x = this.px[j], z = this.pz[j];
      const heading = Math.atan2(this.tanX[j], this.tanZ[j]);
      dummy.position.set(x, this.py[j] + 0.02, z);
      dummy.rotation.set(0, heading, 0);
      dummy.updateMatrix();

      // side walls (both sides)
      for (const side of [1, -1]) {
        const wall = new THREE.BoxGeometry(0.55, H + 1.2, 7.4);
        wall.translate(0, (H + 1.2) / 2 - 0.4, 0);
        wall.applyMatrix4(dummy.matrix.clone()
          .multiply(new THREE.Matrix4().makeTranslation(W * side, 0, 0)));
        concrete.push(wall);
      }
      // ceiling slab
      const ceil = new THREE.BoxGeometry(W * 2 + 0.55, 0.55, 7.4);
      ceil.translate(0, H + 0.35, 0);
      ceil.applyMatrix4(dummy.matrix);
      concrete.push(ceil);

      // cool light strips across the ceiling every other rib
      if (r % 2 === 0) {
        const stripGeo = new THREE.BoxGeometry(W * 1.42, 0.07, 0.5);
        stripGeo.translate(0, H - 0.02, 0);
        stripGeo.applyMatrix4(dummy.matrix);
        strips.push(stripGeo);
        stripPts.push([x, this.py[j] + H - 0.06, z]);
      }
      // amber portal frames at both ends
      if (r === 0 || r === ribs) {
        for (const side of [1, -1]) {
          const post = new THREE.BoxGeometry(0.75, H + 0.6, 0.75);
          post.translate(0, (H + 0.6) / 2 - 0.4, 0);
          post.applyMatrix4(dummy.matrix.clone()
            .multiply(new THREE.Matrix4().makeTranslation((W + 0.2) * side, 0, 0)));
          portals.push(post);
        }
        const lintel = new THREE.BoxGeometry((W + 0.2) * 2 + 0.75, 0.75, 0.75);
        lintel.translate(0, H + 0.85, 0);
        lintel.applyMatrix4(dummy.matrix);
        portals.push(lintel);
      }
    }

    const merge = (arr) => mergeGeometries(arr.map((g) => (g.index ? g.toNonIndexed() : g)), false);
    this.group.add(new THREE.Mesh(merge(concrete), new THREE.MeshStandardMaterial({
      color: 0x2a2d33, roughness: 0.95, metalness: 0.05, side: THREE.DoubleSide
    })));
    this.group.add(new THREE.Mesh(merge(strips), new THREE.MeshStandardMaterial({
      color: 0xd9ecff, emissive: 0xcfe6ff, emissiveIntensity: 3.2, roughness: 0.4
    })));

    // additive glow sprites along the strips — reads as bloom on any GPU
    const stripGlowMat = new THREE.SpriteMaterial({
      map: this.texLightBox, color: 0xcfe6ff, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    for (const [gx, gy, gz] of stripPts) {
      const sp = new THREE.Sprite(stripGlowMat);
      sp.position.set(gx, gy, gz);
      sp.scale.set(W * 1.5, 2.4, 1);
      this.group.add(sp);
    }
    this.group.add(new THREE.Mesh(merge(portals), new THREE.MeshStandardMaterial({
      color: 0x33240f, emissive: 0xff9d14, emissiveIntensity: 1.6, roughness: 0.6
    })));
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
    this.groundMesh = ground;
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
      new THREE.MeshStandardMaterial({
        map: this.texBanner, side: THREE.DoubleSide, roughness: 0.7,
        emissive: 0xffffff, emissiveMap: this.texBanner, emissiveIntensity: 0.5
      })
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
    const lampGlowMat = new THREE.SpriteMaterial({
      map: this.texLightBox, color: 0xff5040, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    for (let i = 0; i < 5; i++) {
      const lampMat = new THREE.MeshStandardMaterial({
        color: 0x1a1d22, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.4
      });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), lampMat);
      lamp.position.set((i - 2) * 0.68, 7.15, -0.08); // facing oncoming cars (-tangent)
      g.add(lamp);
      this.startLamps.push(lampMat);
      const glow = new THREE.Sprite(lampGlowMat);
      glow.position.set((i - 2) * 0.68, 7.15, -0.14);
      glow.scale.set(1.15, 1.15, 1);
      g.add(glow);
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
      color: 0x1d2b33, emissive: 0x35e0ff, emissiveIntensity: 2.6, roughness: 0.5
    });
    const beamMat = new THREE.MeshStandardMaterial({
      color: 0x1d2b33, emissive: 0x35e0ff, emissiveIntensity: 2.0,
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
      new THREE.MeshStandardMaterial({ color: 0x38100c, roughness: 0.5, metalness: 0.3 })
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
        new THREE.MeshStandardMaterial({
          map: this.texSponsor, roughness: 0.6, side: THREE.DoubleSide,
          emissive: 0xffffff, emissiveMap: this.texSponsor, emissiveIntensity: 0.85
        })
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
    const boardMat = new THREE.MeshStandardMaterial({
      map: this.texBoard, roughness: 0.7, side: THREE.DoubleSide,
      emissive: 0xffffff, emissiveMap: this.texBoard, emissiveIntensity: 0.55
    });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.8 });

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
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.55, metalness: 0.7 });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xfff6e0, emissive: 0xffe9b8, emissiveIntensity: 4.2, roughness: 0.3
    });
    const poolMat = new THREE.MeshBasicMaterial({
      map: this.texLightBox, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      color: 0xffe9b8
    });
    const geos = [];
    const lampHeads = [];
    const pools = [];
    const count = 13;
    for (let k = 0; k < count; k++) {
      const i = Math.round((k / count) * N);
      const side = k % 2 === 0 ? 1 : -1;
      const x = this.px[i] + this.rightX[i] * (half + 7.5) * side;
      const z = this.pz[i] + this.rightZ[i] * (half + 7.5) * side;
      const y = this.heightAtWorld(x, z);
      const pole = new THREE.CylinderGeometry(0.09, 0.16, 11, 8);
      pole.translate(x, y + 5.5, z);
      geos.push(pole);
      const armDir = -side;
      const arm = new THREE.CylinderGeometry(0.05, 0.05, 2.0, 6).rotateZ(Math.PI / 2);
      arm.translate(x + this.rightX[i] * 1.0 * armDir, y + 10.9, z + this.rightZ[i] * 1.0 * armDir);
      geos.push(arm);
      const head = new THREE.BoxGeometry(1.1, 0.16, 0.45);
      head.translate(x + this.rightX[i] * 1.9 * armDir, y + 10.82, z + this.rightZ[i] * 1.9 * armDir);
      lampHeads.push(head);
      // warm pool of light on the ground under the head
      const hx = x + this.rightX[i] * 1.9 * armDir;
      const hz = z + this.rightZ[i] * 1.9 * armDir;
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), poolMat);
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(hx, this.heightAtWorld(hx, hz) + 0.09, hz);
      pool.renderOrder = 1;
      pools.push(pool);
    }
    const polesMesh = new THREE.Mesh(mergeGeometries(geos, false), poleMat);
    polesMesh.castShadow = true;
    this.group.add(polesMesh);
    const headsMesh = new THREE.Mesh(mergeGeometries(lampHeads, false), lampMat);
    this.group.add(headsMesh);
    for (const p of pools) this.group.add(p);

    // halo around every floodlight head
    const headGlowMat = new THREE.SpriteMaterial({
      map: this.texLightBox, color: 0xffe9b8, transparent: true, opacity: 0.45,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    for (let k = 0; k < count; k++) {
      const i = Math.round((k / count) * N);
      const side = k % 2 === 0 ? 1 : -1;
      const armDir = -side;
      const hx = this.px[i] + this.rightX[i] * (half + 7.5) * side + this.rightX[i] * 1.9 * armDir;
      const hz = this.pz[i] + this.rightZ[i] * (half + 7.5) * side + this.rightZ[i] * 1.9 * armDir;
      const sp = new THREE.Sprite(headGlowMat);
      sp.position.set(hx, this.heightAtWorld(hx, hz) + 10.78, hz);
      sp.scale.set(5.5, 3.2, 1);
      this.group.add(sp);
    }
  }

  // ------------------------------------------------------------------ trees
  /**
   * Field of trees along the circuit. When `treeScene` (the Tree GN glTF) is
   * provided the real model is instanced — every material of the source tree
   * becomes one InstancedMesh sharing identical per-instance transforms, so
   * the whole forest costs one draw call per material. Falls back to the old
   * procedural pines when no model is available.
   */
  buildTrees(treeScene = null, isMobile = false) {
    if (this._treesBuilt) return;
    this._treesBuilt = true;
    if (treeScene) this._buildGLBTrees(treeScene, isMobile);
    else this._buildProceduralTrees();
  }

  /** Scatter positions with clearance from the track (shared by both paths). */
  _treePositions(count = 150) {
    const half = this.roadHalfWidth;
    const positions = [];
    let attempts = 0;
    while (positions.length < count && attempts < 900) {
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
    return positions;
  }

  _buildGLBTrees(treeScene, isMobile) {
    stripTreeExtras(treeScene);

    // bake world transforms + collect one bucket per material
    const inv = new THREE.Matrix4().copy(treeScene.matrixWorld).invert();
    treeScene.updateMatrixWorld(true);
    const buckets = new Map();
    const allGeos = [];
    treeScene.traverse((o) => {
      if (!o.isMesh) return;
      const g = toFloat32Geometry(o.geometry);
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      const key = o.material.uuid;
      if (!buckets.has(key)) buckets.set(key, { material: o.material, geos: [] });
      buckets.get(key).geos.push(g);
      allGeos.push(g);
    });
    if (!buckets.size) return;

    // normalize over the WHOLE tree so all parts stay assembled
    const whole = mergeTreeGeos(allGeos);
    whole.computeBoundingBox();
    const bb = whole.boundingBox;
    const height = Math.max(0.001, bb.getSize(new THREE.Vector3()).y);
    const hScale = 11.5 / height;
    const offX = -(bb.min.x + bb.max.x) / 2;
    const offZ = -(bb.min.z + bb.max.z) / 2;
    const offY = -bb.min.y;
    whole.dispose();

    // one shared set of per-instance transforms (all buckets reuse it)
    const positions = this._treePositions(isMobile ? 90 : 150);
    const dummy = new THREE.Object3D();
    const transforms = positions.map(([x, z]) => {
      const s = 0.62 + Math.random() * 0.55;   // geometry already normalized
      dummy.position.set(x, this.heightAtWorld(x, z) - 0.25, z);
      dummy.scale.setScalar(s);
      dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
      dummy.updateMatrix();
      return dummy.matrix.clone();
    });

    for (const { material, geos } of buckets.values()) {
      const merged = mergeTreeGeos(geos);
      merged.translate(offX, offY, offZ);
      merged.scale(hScale, hScale, hScale);

      const inst = new THREE.InstancedMesh(merged, material, transforms.length);
      transforms.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = !isMobile;
      inst.frustumCulled = false;
      this.group.add(inst);
    }

    // moonlit tint on the shared source materials
    treeScene.traverse((o) => {
      if (o.isMesh && o.material) {
        o.material.color = new THREE.Color(o.material.map ? 0xb8c4d8 : 0x9aa6ba);
      }
    });
  }

  _buildProceduralTrees() {
    const positions = this._treePositions(150);

    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1.5, 6);
    const pineGeo = new THREE.ConeGeometry(1.05, 2.7, 7);
    const blobGeo = new THREE.IcosahedronGeometry(1.15, 0);
    blobGeo.scale(1, 1.25, 1);

    const pines = [], blobs = [];
    for (const [x, z] of positions) {
      (Math.random() < 0.55 ? pines : blobs).push([x, z]);
    }

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 0.95 });
    const crownMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    const crownColors = [0x14261a, 0x182e1f, 0x112318, 0x1c3322, 0x0f1e14];

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
    const palette = [0x4a1a13, 0x43464c, 0x101216];
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
      new THREE.MeshLambertMaterial({ color: 0x11192a, flatShading: true })
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
        color: 0x0d1322, transparent: true, opacity: 0.42
      })
    );
    this.group.add(mesh);
  }

  // ---------------------------------------------------------- NEW SCENERY ---
  /**
   * Low bushes scattered in the grass — instanced, varied scale/rotation/color.
   * Uses a flattened icosahedron so each bush reads as a distinct clump, not
   * a copy of the trees. Cheap: one draw call for ~120 instances.
   */
  _buildBushes() {
    const N = this.sampleCount;
    const half = this.roadHalfWidth;
    const positions = [];
    // scatter bushes in the grass, biased toward the inner side of curves
    // (where the runoff is) and along straights
    for (let i = 0; i < N; i += 5) {
      for (const side of [1, -1]) {
        if (Math.random() < 0.35) {
          const dist = half + 3 + Math.random() * 14;
          const x = this.px[i] + this.rightX[i] * dist * side;
          const z = this.pz[i] + this.rightZ[i] * dist * side;
          positions.push([x, z]);
        }
      }
    }
    if (!positions.length) return;

    const bushGeo = new THREE.IcosahedronGeometry(0.5, 0);
    bushGeo.scale(1.4, 0.7, 1.4); // flattened — reads as a low shrub
    const bushMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.95, flatShading: true
    });
    const mesh = new THREE.InstancedMesh(bushGeo, bushMat, positions.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const palette = [0x1a2a18, 0x1f3020, 0x16241a, 0x243a22, 0x121e15];

    positions.forEach(([x, z], i) => {
      const s = 0.5 + Math.random() * 0.9;
      const y = this.heightAtWorld(x, z);
      dummy.position.set(x, y + 0.25 * s, z);
      dummy.scale.setScalar(s);
      dummy.rotation.y = Math.random() * Math.PI * 2;
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.setHex(palette[(Math.random() * palette.length) | 0]));
    });
    mesh.castShadow = false;       // bushes are too low to need shadows
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
  }

  /**
   * Rocks of varying sizes — instanced dodecahedrons with random rotation +
   * scale + grey-tone color variation. Placed near the runoff areas and
   * scattered on distant hills. One draw call for ~40 rocks.
   */
  _buildRocks() {
    const N = this.sampleCount;
    const half = this.roadHalfWidth;
    const positions = [];
    for (let i = 0; i < N; i += 12) {
      for (const side of [1, -1]) {
        if (Math.random() < 0.4) {
          const dist = half + 5 + Math.random() * 20;
          const x = this.px[i] + this.rightX[i] * dist * side;
          const z = this.pz[i] + this.rightZ[i] * dist * side;
          positions.push([x, z]);
        }
      }
      // a few distant rocks on the hills
      if (Math.random() < 0.15) {
        const ang = Math.random() * Math.PI * 2;
        const dist = 120 + Math.random() * 80;
        positions.push([this.px[i] + Math.cos(ang) * dist,
                        this.pz[i] + Math.sin(ang) * dist]);
      }
    }
    if (!positions.length) return;

    const rockGeo = new THREE.DodecahedronGeometry(0.6, 0);
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.92, metalness: 0.05, flatShading: true
    });
    const mesh = new THREE.InstancedMesh(rockGeo, rockMat, positions.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const palette = [0x3a3d42, 0x2e3035, 0x44474d, 0x252629, 0x4a4d52];

    positions.forEach(([x, z], i) => {
      const s = 0.4 + Math.random() * 1.4;
      const y = this.heightAtWorld(x, z);
      dummy.position.set(x, y + 0.3 * s, z);
      dummy.scale.set(s, s * (0.7 + Math.random() * 0.5), s);
      dummy.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI
      );
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.setHex(palette[(Math.random() * palette.length) | 0]));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
  }

  /**
   * Roadside distance/corner signs — small posts with a colored sign face.
   * Placed at intervals along the track, facing oncoming traffic. Instanced
   * posts + instanced sign faces = 2 draw calls for ~30 signs.
   */
  _buildDistanceSigns() {
    const N = this.sampleCount;
    const half = this.roadHalfWidth;
    const posts = [];
    const signs = [];
    const signColors = [];
    let signIdx = 0;
    for (let i = 0; i < N; i += 40) {
      const side = (i % 80 === 0) ? 1 : -1;
      const dist = half + 1.8;
      const x = this.px[i] + this.rightX[i] * dist * side;
      const z = this.pz[i] + this.rightZ[i] * dist * side;
      const y = this.heightAtWorld(x, z);
      posts.push([x, y, z]);
      // sign face 1.6 m up, angled toward the track
      signs.push([x, y + 1.6, z, this.tanX[i], this.tanZ[i], side]);
      // alternate sign colors: yellow (warning), white (info), red (stop)
      signColors.push(signIdx % 3 === 0 ? 0xe8c414 : (signIdx % 3 === 1 ? 0xf2f4f6 : 0xc62828));
      signIdx++;
    }
    if (!posts.length) return;

    const postGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x6a6e75, roughness: 0.8, metalness: 0.6 });
    const postMesh = new THREE.InstancedMesh(postGeo, postMat, posts.length);
    const signGeo = new THREE.BoxGeometry(0.6, 0.45, 0.04);
    const signMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.1 });
    const signMesh = new THREE.InstancedMesh(signGeo, signMat, signs.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    posts.forEach(([x, y, z], i) => {
      dummy.position.set(x, y + 0.8, z);
      dummy.scale.setScalar(1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      postMesh.setMatrixAt(i, dummy.matrix);
    });
    signs.forEach(([x, y, z, tx, tz, side], i) => {
      dummy.position.set(x, y, z);
      // face the sign toward the track (opposite of the tangent direction)
      dummy.rotation.y = Math.atan2(tx, tz) + Math.PI / 2 * side;
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      signMesh.setMatrixAt(i, dummy.matrix);
      signMesh.setColorAt(i, color.setHex(signColors[i]));
    });
    for (const m of [postMesh, signMesh]) {
      m.castShadow = true;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      this.group.add(m);
    }
  }

  /**
   * Chain-link fence along long straights — a grid-textured plane repeated
   * along the track. Cheap: one mesh per straight. Fences are placed BEHIND
   * the tire stacks / walls so they don't interfere with collision.
   */
  _buildFence() {
    const N = this.sampleCount;
    const half = this.roadHalfWidth;
    const segments = [];
    let runStart = -1;
    // find long straights (low curvature for >40 samples = ~50 m)
    for (let i = 0; i < N; i++) {
      const isStraight = Math.abs(this.curv[i]) < 0.015;
      if (isStraight && runStart < 0) runStart = i;
      else if (!isStraight && runStart >= 0) {
        if (i - runStart > 30) segments.push([runStart, i]);
        runStart = -1;
      }
    }
    if (runStart >= 0 && N - runStart > 30) segments.push([runStart, N]);
    if (!segments.length) return;

    // build a fence canvas texture (chain-link pattern)
    const fenceTex = canvasTexture(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#1a1d22';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#5a6068';
      ctx.lineWidth = 1.5;
      // diamond chain-link pattern
      for (let y = 0; y < h; y += 12) {
        for (let x = 0; x < w; x += 12) {
          ctx.beginPath();
          ctx.moveTo(x, y + 6);
          ctx.lineTo(x + 6, y);
          ctx.lineTo(x + 12, y + 6);
          ctx.lineTo(x + 6, y + 12);
          ctx.closePath();
          ctx.stroke();
        }
      }
    }, { repeat: [THREE.RepeatWrapping, THREE.RepeatWrapping] });

    const fenceMat = new THREE.MeshStandardMaterial({
      map: fenceTex,
      color: 0x8a9098,
      roughness: 0.7,
      metalness: 0.4,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85
    });

    const dummy = new THREE.Object3D();
    for (const [start, end] of segments) {
      for (const side of [1, -1]) {
        // build a fence rail along this straight on this side
        const positions = [];
        for (let i = start; i < end; i++) {
          const dist = half + 4.5; // behind the tire stacks
          const x = this.px[i] + this.rightX[i] * dist * side;
          const z = this.pz[i] + this.rightZ[i] * dist * side;
          const y = this.heightAtWorld(x, z);
          positions.push([x, y, z, this.tanX[i], this.tanZ[i]]);
        }
        if (positions.length < 2) continue;
        // build a BufferGeometry strip: 2 verts per sample (bottom + top)
        const verts = [];
        const uvs = [];
        const indices = [];
        const FENCE_HEIGHT = 1.8;
        for (let i = 0; i < positions.length; i++) {
          const [x, y, z, tx, tz] = positions[i];
          // bottom
          verts.push(x, y, z);
          // top
          verts.push(x, y + FENCE_HEIGHT, z);
          uvs.push(i / positions.length * 8, 0);
          uvs.push(i / positions.length * 8, 1);
          if (i < positions.length - 1) {
            const v0 = i * 2, v1 = i * 2 + 1, v2 = (i + 1) * 2, v3 = (i + 1) * 2 + 1;
            indices.push(v0, v1, v2, v1, v3, v2);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, fenceMat);
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    }
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
