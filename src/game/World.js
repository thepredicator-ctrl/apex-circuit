/**
 * World — an ENDLESS, seeded, procedurally generated road through rolling
 * terrain (slowroads-style), streamed in chunks around the car.
 *
 * Generation model
 * ----------------
 * The road is a centerline sampled every 4 m. Sample `i` is derived from
 * seeded value-noise lookups on the ABSOLUTE sample index, so the world is
 * deterministic for a given seed and can be extended incrementally in any
 * direction of travel:
 *
 *   curvature(i) = maxCurv · noise(i·f1) · twistMask(i·f2)   → heading
 *   slope(i)     = 0.065 · noise(i·f3)                        → elevation
 *   bank(i)      = smoothed clamp(curvature · gain, ±maxBank) → superelevation
 *
 * Chunks of 32 samples (128 m) own their slice of road ribbon, two terrain
 * strips (L/R) that blend road height into noise-driven hills, and instanced
 * scenery (trees / bushes / rocks / reflector posts) allocated from global
 * pools and recycled as chunks stream in and out.
 *
 * Physics API (mirrors the old Track class):
 *   locate(x, z, hintIdx)  → nearest centerline sample + signed lateral
 *   surfaceAt(idx, lateral) → { y, slope, bankSlope }
 *   pointAt(s) / tangentAt(s) (s in meters along the road)
 *   heightAtWorld(x, z)    → terrain height incl. road blend
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TRACK, QUALITY } from './Constants.js';

// ------------------------------------------------------------- seeded noise

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2i(x, y, seed) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** seeded 1D value noise, C1-continuous (smoothstep blend) */
function vnoise1(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash2i(i, 0, seed);
  const b = hash2i(i + 1, 0, seed);
  return a + (b - a) * u;
}

/** seeded 2D value noise */
function vnoise2(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2i(ix, iz, seed);
  const b = hash2i(ix + 1, iz, seed);
  const c = hash2i(ix, iz + 1, seed);
  const d = hash2i(ix + 1, iz + 1, seed);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uz;
}

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smoothstep = THREE.MathUtils.smoothstep;

// ----------------------------------------------------------------- textures

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

function speckle(ctx, w, h, count, alpha, dark, light) {
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

/**
 * Road cross-section texture. One texture width = one cross-section of the
 * 10.4 m road: gravel shoulder | asphalt | painted lines | asphalt | shoulder.
 * v runs ALONG the road (dashes repeat naturally).
 * Returns { tex, uAsphaltIn, uAsphaltOut } — u fractions of the asphalt span.
 */
function buildRoadTexture(aniso) {
  const W = 512, H = 512;
  const shoulderW = 0.10;                    // fraction of width per side
  const tex = canvasTexture(W, H, (ctx) => {
    // gravel shoulder
    ctx.fillStyle = '#5e5a50';
    ctx.fillRect(0, 0, W, H);
    speckle(ctx, W, H, 2600, 0.5, '#4a463e', '#6e6a5e');
    // asphalt span
    const ax0 = W * shoulderW, ax1 = W * (1 - shoulderW);
    ctx.fillStyle = '#31343a';
    ctx.fillRect(ax0, 0, ax1 - ax0, H);
    // save clip for asphalt details
    ctx.save();
    ctx.beginPath();
    ctx.rect(ax0, 0, ax1 - ax0, H);
    ctx.clip();
    speckle(ctx, W, H, 3200, 0.24, '#26282d', '#3c4046');
    // repair seams (tar snakes)
    ctx.strokeStyle = 'rgba(18,18,20,0.5)';
    for (let i = 0; i < 7; i++) {
      ctx.lineWidth = 2 + Math.random() * 3;
      ctx.beginPath();
      let x = ax0 + Math.random() * (ax1 - ax0);
      ctx.moveTo(x, 0);
      for (let y = 0; y < H; y += 32) {
        x += (Math.random() - 0.5) * 18;
        ctx.lineTo(clamp(x, ax0, ax1), y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // painted solid edge lines (white, slightly worn)
    const lineW = 5;
    ctx.fillStyle = 'rgba(226,230,236,0.82)';
    ctx.fillRect(ax0 + 14, 0, lineW, H);
    ctx.fillRect(ax1 - 14 - lineW, 0, lineW, H);

    // dashed center line
    ctx.fillStyle = 'rgba(230,225,180,0.85)';
    const dashH = H * 0.28, gapH = H * 0.22;
    for (let y = 0; y < H; y += dashH + gapH) {
      ctx.fillRect(W / 2 - lineW / 2, y, lineW, dashH);
    }
  }, { anisotropy: aniso });
  tex.repeat.set(1, 1);
  return { tex, shoulderW };
}

function buildGrassTexture(aniso) {
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#4a6b34';
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, 2800, 0.3, '#3a5528', '#5c7f40');
    speckle(ctx, w, h, 900, 0.2, '#324a22', '#6d8f4c');
  }, { anisotropy: aniso });
}

// ------------------------------------------------------------ instance pools

class InstancePool {
  constructor(geo, mat, capacity, castShadow = false) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, zero);
    this.freeList = [];
    for (let i = capacity - 1; i >= 0; i--) this.freeList.push(i);
    this._zero = zero;
  }

  alloc() {
    return this.freeList.length ? this.freeList.pop() : -1;
  }

  setMatrix(slot, m) {
    this.mesh.setMatrixAt(slot, m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  release(slot) {
    if (slot < 0) return;
    this.mesh.setMatrixAt(slot, this._zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.freeList.push(slot);
  }

  releaseAll(slots) {
    for (const s of slots) this.release(s);
    slots.length = 0;
  }
}

// ------------------------------------------------------------------ the world

const SPACING = TRACK.sampleSpacing;
const CHUNK = TRACK.chunkSamples;
const MAX_SAMPLES = 60000;          // 240 km hard cap — plenty for a drive
const MAX_CURV = 0.0185;            // rad/m → min radius ≈ 54 m
const MAX_BANK = 0.085;             // rad ≈ 4.9° superelevation

export class World {
  constructor(seed = 1337, aniso = 4, qualityName = 'medium') {
    this.seed = seed >>> 0;
    this.group = new THREE.Group();
    this.roadHalfWidth = TRACK.roadHalfWidth;
    this.quality = QUALITY[qualityName] || QUALITY.medium;

    // --- generation state ---------------------------------------------------
    this.samples = [];               // { x,y,z, h(heading), curv, bank, rx,rz, tx,tz }
    this._curvSmooth = 0;
    this._bankSmooth = 0;
    this.chunkMeshes = new Map();    // chunkIdx -> record

    // seeds for each noise channel (derived, deterministic)
    const base = this.seed;
    this.seedCurvA = base ^ 0x1a2b3c;
    this.seedCurvB = base ^ 0x2b3c4d;
    this.seedSlopeA = base ^ 0x3c4d5e;
    this.seedSlopeB = base ^ 0x4d5e6f;
    this.seedTerrain = base ^ 0x5e6f70;
    this.seedTerrain2 = base ^ 0x6f7081;
    this.seedScatter = base ^ 0x708192;

    // --- meshes / textures ----------------------------------------------------
    this._buildTextures(aniso);
    this._buildSceneryGeometries();
    this._buildPools();
    this._buildDistantRidge();

    // initial road: generate + stream the first chunks
    this._generateSamples(CHUNK * 20 + 8);
    // raise the very start above any terrain dip so spawn feels right
    this.chunksBuiltMin = 0;
    this.chunksBuiltMax = -1;
    this._stream(0, this.quality.sceneryScale);
  }

  // ------------------------------------------------------------- textures
  _buildTextures(aniso) {
    const { tex, shoulderW } = buildRoadTexture(aniso);
    this.texRoad = tex;
    this.roadShoulderU = shoulderW;
    this.texGrass = buildGrassTexture(aniso);
    this.texGrass.repeat.set(26, 26);

    this.matRoad = new THREE.MeshStandardMaterial({
      map: this.texRoad, roughness: 0.94, metalness: 0
    });
    this.matTerrain = new THREE.MeshStandardMaterial({
      map: this.texGrass, roughness: 1.0, metalness: 0,
      vertexColors: true
    });
  }

  // ------------------------------------------------------- scenery shapes
  _buildSceneryGeometries() {
    this.matTree = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true
    });

    // ---- bush: squashed icosahedron, vertex colored
    const bush = new THREE.IcosahedronGeometry(1.0, 0);
    bush.scale(1.25, 0.75, 1.1);
    bush.translate(0, 0.55, 0);
    this._paintVerts(bush, 0x557a38, 0x3c5a28);
    this.bushGeo = bush;

    // ---- rock: dodecahedron
    const rock = new THREE.DodecahedronGeometry(0.9, 0);
    rock.scale(1.3, 0.8, 1.0);
    rock.translate(0, 0.35, 0);
    this._paintVerts(rock, 0x94948f, 0x7c7c76);
    this.rockGeo = rock;

    // ---- reflector post: white post + dark cap
    const post = new THREE.BoxGeometry(0.09, 1.05, 0.09);
    post.translate(0, 0.52, 0);
    const cap = new THREE.BoxGeometry(0.11, 0.16, 0.02);
    cap.translate(0, 0.95, 0.045);
    this.postGeo = mergeGeometries([post, cap], false);
    this.matPost = new THREE.MeshStandardMaterial({
      vertexColors: false, color: 0xe8e8e2, roughness: 0.6
    });

    // ---- broadleaf tree: trunk + 3 offset canopy blobs -------------------
    if (!this._tree2Geometry) {
      const t2trunk = new THREE.CylinderGeometry(0.16, 0.26, 1.9, 6);
      t2trunk.translate(0, 0.95, 0);
      this._paintVerts(t2trunk, 0x63513c, 0x4e3e2c);
      const blobs = [
        { r: 1.3, x: 0, y: 2.75, z: 0, top: 0x6f9a45, bot: 0x4e7030 },
        { r: 0.95, x: 0.62, y: 2.25, z: 0.35, top: 0x7ca44e, bot: 0x547838 },
        { r: 0.85, x: -0.55, y: 2.4, z: -0.3, top: 0x63903e, bot: 0x48682e }
      ];
      const parts = [t2trunk.index ? t2trunk.toNonIndexed() : t2trunk];
      for (const b of blobs) {
        const blob = new THREE.IcosahedronGeometry(b.r, 1);
        blob.scale(1.05, 0.85, 1.05);
        blob.translate(b.x, b.y, b.z);
        this._paintVerts(blob, b.top, b.bot);
        parts.push(blob.index ? blob.toNonIndexed() : blob);
      }
      this._tree2Geometry = mergeGeometries(parts, false);
      this._tree2Geometry.computeVertexNormals();
    }
    this.tree2Geo = this._tree2Geometry;

    // ---- power pole: mast + two crossarms ---------------------------------
    const pole = new THREE.CylinderGeometry(0.09, 0.13, 8.2, 6);
    pole.translate(0, 4.1, 0);
    const cross1 = new THREE.BoxGeometry(0.09, 0.09, 2.1);
    cross1.translate(0, 7.6, 0);
    const cross2 = new THREE.BoxGeometry(0.08, 0.08, 1.5);
    cross2.translate(0, 6.9, 0);
    const poleParts = [pole, cross1, cross2];
    for (const zz of [-0.85, 0.85, -0.6, 0.6]) {
      const insul = new THREE.CylinderGeometry(0.035, 0.05, 0.16, 5);
      insul.translate(0, 7.72, zz);
      poleParts.push(insul);
    }
    this.poleGeo = mergeGeometries(poleParts, false);
    this._paintVerts(this.poleGeo, 0x71604a, 0x544634);

    // ---- fence section: 2 posts + 2 rails (spans local X, ~2.6 m) ---------
    const fp1 = new THREE.BoxGeometry(0.085, 1.15, 0.085);
    fp1.translate(-1.3, 0.575, 0);
    const fp2 = new THREE.BoxGeometry(0.085, 1.2, 0.085);
    fp2.translate(1.3, 0.6, 0);
    const rail1 = new THREE.BoxGeometry(2.62, 0.075, 0.035);
    rail1.translate(0, 0.98, 0);
    const rail2 = new THREE.BoxGeometry(2.62, 0.06, 0.03);
    rail2.translate(0, 0.58, 0);
    this.fenceGeo = mergeGeometries([fp1, fp2, rail1, rail2], false);
    this._paintVerts(this.fenceGeo, 0x8a7a5e, 0x655640);

    // ---- barn: red body + gabled roof + door + trim ------------------------
    const bb = new THREE.BoxGeometry(4.2, 2.7, 6.0);
    bb.translate(0, 1.35, 0);
    const roofL = new THREE.BoxGeometry(2.65, 0.14, 6.3);
    roofL.rotateZ(0.62);
    roofL.translate(-1.02, 3.28, 0);
    const roofR = new THREE.BoxGeometry(2.65, 0.14, 6.3);
    roofR.rotateZ(-0.62);
    roofR.translate(1.02, 3.28, 0);
    const gable1 = new THREE.BoxGeometry(2.9, 1.5, 0.12);
    gable1.translate(0, 3.3, 2.95);
    const gable2 = new THREE.BoxGeometry(2.9, 1.5, 0.12);
    gable2.translate(0, 3.3, -2.95);
    const barnDoor = new THREE.BoxGeometry(1.7, 2.1, 0.08);
    barnDoor.translate(0, 1.05, 3.02);
    const barnTrim = new THREE.BoxGeometry(4.3, 0.22, 6.1);
    barnTrim.translate(0, 2.72, 0);
    this.barnGeo = mergeGeometries([bb, gable1, gable2, barnTrim], false);
    this._paintVerts(this.barnGeo, 0x9c4136, 0x6e2c24);
    const roofParts = [roofL, roofR, barnDoor];
    this._barnRoofGeo = mergeGeometries(roofParts, false);
    this._paintVerts(this._barnRoofGeo, 0x574c40, 0x3c342b);
    this.barnGeo = mergeGeometries([this.barnGeo, this._barnRoofGeo], false);

    // ---- hay bale -----------------------------------------------------------
    const hay = new THREE.CylinderGeometry(0.85, 0.9, 1.3, 9);
    hay.rotateZ(Math.PI / 2);
    hay.translate(0, 0.85, 0);
    this.hayGeo = hay;
    this._paintVerts(this.hayGeo, 0xd2b058, 0xa8863a);

    // ---- grass tuft: two crossed low cones ---------------------------------
    const g1 = new THREE.ConeGeometry(0.3, 0.55, 5);
    g1.translate(0, 0.26, 0);
    const g2 = new THREE.ConeGeometry(0.2, 0.38, 5);
    g2.translate(0.14, 0.18, 0.1);
    this.grassGeo = mergeGeometries([g1, g2], false);
    this._paintVerts(this.grassGeo, 0x6d9444, 0x4c6c30);
  }

  /** add a vertical top->bottom vertex-color gradient to a geometry */
  _paintVerts(geo, hexTop, hexBottom) {
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cTop = new THREE.Color(hexTop);
    const cBot = new THREE.Color(hexBottom);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i));
      maxY = Math.max(maxY, pos.getY(i));
    }
    for (let i = 0; i < pos.count; i++) {
      const t = (pos.getY(i) - minY) / Math.max(0.001, maxY - minY);
      const c = cBot.clone().lerp(cTop, t);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  _buildPools() {
    const scale = this.quality.sceneryScale;
    this.poolTrees = new InstancePool(this._treeGeo(), this.matTree, Math.ceil(900 * scale) + 60, true);
    this.poolTrees2 = new InstancePool(this.tree2Geo, this.matTree, Math.ceil(620 * scale) + 50, true);
    this.poolBushes = new InstancePool(this.bushGeo, this.matTree, Math.ceil(480 * scale) + 40, false);
    this.poolRocks = new InstancePool(this.rockGeo, this.matTree, Math.ceil(220 * scale) + 30, false);
    this.poolPosts = new InstancePool(this.postGeo, this.matPost, 400, false);
    this.poolPoles = new InstancePool(this.poleGeo, this.matTree, 90, false);
    this.poolFence = new InstancePool(this.fenceGeo, this.matTree, 300, false);
    this.poolBarns = new InstancePool(this.barnGeo, this.matTree, 18, true);
    this.poolHay = new InstancePool(this.hayGeo, this.matTree, 90, false);
    this.poolGrass = new InstancePool(this.grassGeo, this.matTree, Math.ceil(1300 * scale) + 80, false);
    this.group.add(
      this.poolTrees.mesh, this.poolTrees2.mesh, this.poolBushes.mesh,
      this.poolRocks.mesh, this.poolPosts.mesh, this.poolPoles.mesh,
      this.poolFence.mesh, this.poolBarns.mesh, this.poolHay.mesh,
      this.poolGrass.mesh
    );
  }

  /** wind turbine: tower + nacelle + 3-blade rotor (returns dynamic group) */
  _turbineGeo() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xdfe4e8, roughness: 0.5, metalness: 0.15, flatShading: true
    });
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.85, 26, 8), mat);
    tower.position.y = 13;
    tower.castShadow = true;
    g.add(tower);
    const nacelle = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 1.1), mat);
    nacelle.position.set(0.4, 26, 0);
    g.add(nacelle);
    const rotor = new THREE.Group();
    rotor.position.set(1.7, 26, 0);
    const bladeGeo = new THREE.BoxGeometry(0.14, 9.2, 0.5);
    bladeGeo.translate(0, 4.9, 0);
    for (let k = 0; k < 3; k++) {
      const blade = new THREE.Mesh(bladeGeo, mat);
      blade.rotation.x = (k / 3) * Math.PI * 2;
      blade.castShadow = true;
      rotor.add(blade);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.7, 8).rotateZ(Math.PI / 2), mat);
    rotor.add(hub);
    g.add(rotor);
    g.userData.rotor = rotor;
    return g;
  }

  _treeGeo() {
    // cached tree geometry (built once): trunk + 2 stacked cones
    if (!this._treeGeometry) {
      const trunk = new THREE.CylinderGeometry(0.14, 0.22, 1.6, 6);
      trunk.translate(0, 0.8, 0);
      const cone1 = new THREE.ConeGeometry(1.55, 2.6, 7);
      cone1.translate(0, 2.6, 0);
      const cone2 = new THREE.ConeGeometry(1.05, 1.9, 7);
      cone2.translate(0, 4.15, 0);
      this._paintVerts(trunk, 0x5a4632, 0x4a3828);
      this._paintVerts(cone1, 0x3f6d33, 0x2e5226);
      this._paintVerts(cone2, 0x487a3a, 0x35592b);
      this._treeGeometry = mergeGeometries([trunk, cone1, cone2], false);
      this._treeGeometry.computeVertexNormals();
    }
    return this._treeGeometry;
  }

  // ------------------------------------------------------- distant ridge
  _buildDistantRidge() {
    // a ring of low-poly mountains that follows the camera — sells the horizon
    const R = 780;
    const seg = 72;
    const positions = [];
    const colors = [];
    const rng = mulberry32(this.seed ^ 0xbeef);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const h0 = 40 + rng() * 130;
      const h1 = 40 + rng() * 130;
      const x0 = Math.cos(a0) * R, z0 = Math.sin(a0) * R;
      const x1 = Math.cos(a1) * R, z1 = Math.sin(a1) * R;
      // peak points (jagged); high peaks get a snow dusting
      positions.push(x0, 0, z0, x0, h0, z0, x1, 0, z1);
      positions.push(x1, 0, z1, x0, h0, z0, x1, h1, z1);
      const c = new THREE.Color().setHSL(0.58, 0.18, 0.34 + rng() * 0.08);
      const snow0 = Math.max(0, (h0 - 95) / 75) * 0.55;
      const snow1 = Math.max(0, (h1 - 95) / 75) * 0.55;
      const cTop0 = c.clone().lerp(new THREE.Color(0xf2f6fa), snow0);
      const cTop1 = c.clone().lerp(new THREE.Color(0xf2f6fa), snow1);
      colors.push(c.r, c.g, c.b, cTop0.r, cTop0.g, cTop0.b, c.r, c.g, c.b);
      colors.push(c.r, c.g, c.b, cTop0.r, cTop0.g, cTop0.b, cTop1.r, cTop1.g, cTop1.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide,
      fog: true, depthWrite: false
    });
    this.ridge = new THREE.Mesh(geo, mat);
    this.ridge.frustumCulled = false;
    this.ridge.renderOrder = -1;
    this.group.add(this.ridge);
  }

  // =========================================================== generation

  /** road shape for absolute sample index i */
  _shapeCurv(i) {
    const twistMask = smoothstep(0.34, 0.62, vnoise1(i * 0.0085, this.seedCurvB));
    const n = vnoise1(i * 0.032, this.seedCurvA) * 2 - 1;
    // occasionally flip into S-curves harder by shaping the noise
    const shaped = Math.sign(n) * Math.pow(Math.abs(n), 1.35);
    return shaped * MAX_CURV * (0.25 + 0.75 * twistMask);
  }

  _shapeSlope(i) {
    const long = vnoise1(i * 0.006, this.seedSlopeB) * 2 - 1;   // rolling tide
    const local = vnoise1(i * 0.024, this.seedSlopeA) * 2 - 1;  // crests & dips
    return clamp(local * 0.055 + long * 0.03, -0.075, 0.075);
  }

  _generateSamples(count) {
    const S = this.samples;
    const need = Math.min(count, MAX_SAMPLES);
    // resume from wherever generation stopped
    if (S.length === 0) {
      S.push({
        x: 0, y: 0, z: 0, h: 0, curv: 0, bank: 0,
        rx: -1, rz: 0, tx: 0, tz: 1
      });
      this._genPos = { x: 0, z: 0 };
      this._genH = 0;
      this._genY = 0;
      this._genI = 1;
      this._curvSmooth = 0;
      this._bankSmooth = 0;
    }
    while (S.length < need) {
      const i = this._genI;
      const curv = this._shapeCurv(i);
      // ease curvature in/out (steering wheel, not a teleport)
      this._curvSmooth += (curv - this._curvSmooth) * 0.10;
      const c = this._curvSmooth;
      this._genH += c * SPACING;
      const h = this._genH;
      // superelevation: raise the outside edge (left turn → right side up)
      const bankTarget = clamp(c * 150, -MAX_BANK, MAX_BANK);
      this._bankSmooth += (bankTarget - this._bankSmooth) * 0.05;
      const bank = this._bankSmooth;
      this._genY += this._shapeSlope(i) * SPACING;
      const px = this._genPos.x + Math.sin(h) * SPACING;
      const pz = this._genPos.z + Math.cos(h) * SPACING;
      this._genPos.x = px;
      this._genPos.z = pz;
      S.push({
        x: px, y: this._genY, z: pz,
        h, curv: c, bank,
        tx: Math.sin(h), tz: Math.cos(h),
        rx: -Math.cos(h), rz: Math.sin(h)
      });
      this._genI++;
    }
  }

  // ============================================================ terrain

  /**
   * Pure noise hills for world position (x, z) — the "far field" the road
   * blends into. Returned relative to `roadY` so terrain tracks the road's
   * elevation window.
   */
  _terrainNoise(x, z, roadY) {
    const n1 = vnoise2(x * 0.011, z * 0.011, this.seedTerrain) * 2 - 1;   // hills
    const n2 = vnoise2(x * 0.033, z * 0.033, this.seedTerrain2) * 2 - 1;  // detail
    const n3 = vnoise2(x * 0.004, z * 0.004, this.seedTerrain) * 2 - 1;   // wide swell
    return roadY + n1 * 10 + n2 * 3.2 + n3 * 20;
  }

  /**
   * Ground height at (x, z) given a nearby sample index hint — road height
   * inside the road, blended into hills over ~12..70 m.
   */
  _groundBlend(x, z, idx) {
    const S = this.samples;
    const i = clamp(idx, 0, S.length - 1);
    const s = S[i];
    const dx = x - s.x, dz = z - s.z;
    const lateral = dx * s.rx + dz * s.rz;
    const absLat = Math.abs(lateral);
    const roadY = s.y + lateral * s.bank;
    if (absLat <= TRACK.roadHalfWidth) return roadY;
    const hills = this._terrainNoise(x, z, s.y);
    const t = smoothstep(TRACK.roadHalfWidth + 4, 70, absLat);
    return lerp(roadY - 0.12, hills, t);
  }

  // ============================================================ chunks

  _stream(carIdx, sceneryScale) {
    const minC = Math.max(0, Math.floor((carIdx - TRACK.chunksBehind * CHUNK) / CHUNK));
    const maxC = Math.min(
      Math.floor((Math.min(MAX_SAMPLES, this.samples.length - 1) - 1) / CHUNK),
      Math.floor((carIdx + TRACK.chunksAhead * CHUNK) / CHUNK)
    );
    // ensure samples exist for the whole build range (+1 margin)
    this._generateSamples((maxC + 2) * CHUNK + 2);

    for (let c = Math.min(this.chunksBuiltMin, minC); c <= maxC; c++) {
      if (c < minC) continue;
      if (!this.chunkMeshes.has(c) && c >= minC && c <= maxC) {
        this._buildChunk(c, sceneryScale);
      }
    }
    // dispose chunks that fell behind
    for (const [c, rec] of this.chunkMeshes) {
      if (c < minC) {
        this._disposeChunk(rec);
        this.chunkMeshes.delete(c);
      }
    }
    this.chunksBuiltMin = minC;
    this.chunksBuiltMax = maxC;
  }

  _buildChunk(ci, sceneryScale) {
    const S = this.samples;
    const i0 = ci * CHUNK;
    const i1 = i0 + CHUNK;
    if (S.length < i1 + 2) this._generateSamples(i1 + 2);

    const rec = {
      idx: ci,
      slots: { tree: [], tree2: [], bush: [], rock: [], post: [], fence: [], pole: [], barn: [], hay: [], grass: [] },
      meshes: [],
      turbine: null
    };

    // ---------------- road ribbon (with 1-sample overlap each side) -------
    const rs = Math.max(0, i0 - 1);
    const re = Math.min(S.length - 1, i1 + 1);
    const n = re - rs;
    const roadPos = new Float32Array((n + 1) * 2 * 3);
    const roadUv = new Float32Array((n + 1) * 2 * 2);
    const roadIdx = [];
    const HW = TRACK.roadHalfWidth;
    for (let k = 0; k <= n; k++) {
      const s = S[rs + k];
      const v = (rs + k) * SPACING / 10.4;
      // left edge (lat = -HW) and right edge (lat = +HW), bank applied
      const ly = s.y - HW * s.bank;
      const ry = s.y + HW * s.bank;
      roadPos[(k * 2) * 3] = s.x + s.rx * -HW;
      roadPos[(k * 2) * 3 + 1] = ly - 0.02;
      roadPos[(k * 2) * 3 + 2] = s.z + s.rz * -HW;
      roadPos[(k * 2 + 1) * 3] = s.x + s.rx * HW;
      roadPos[(k * 2 + 1) * 3 + 1] = ry - 0.02;
      roadPos[(k * 2 + 1) * 3 + 2] = s.z + s.rz * HW;
      roadUv[(k * 2) * 2] = 0; roadUv[(k * 2) * 2 + 1] = v;
      roadUv[(k * 2 + 1) * 2] = 1; roadUv[(k * 2 + 1) * 2 + 1] = v;
      if (k < n) {
        const a = k * 2, b = k * 2 + 1, c = k * 2 + 2, d = k * 2 + 3;
        roadIdx.push(a, b, c, b, d, c);
      }
    }
    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute('position', new THREE.BufferAttribute(roadPos, 3));
    roadGeo.setAttribute('uv', new THREE.BufferAttribute(roadUv, 2));
    roadGeo.setIndex(roadIdx);
    roadGeo.computeVertexNormals();
    const roadMesh = new THREE.Mesh(roadGeo, this.matRoad);
    roadMesh.receiveShadow = true;
    this.group.add(roadMesh);
    rec.meshes.push(roadMesh);

    // ---------------- terrain strips (L/R) --------------------------------
    const offs = [HW, HW + 3, HW + 7, HW + 13, HW + 21, HW + 33, HW + 50, HW + 75, HW + 110, HW + 150];
    for (const side of [-1, 1]) {
      const tPos = [];
      const tCol = [];
      const tUv = [];
      const tIdx = [];
      for (let k = 0; k <= n; k++) {
        const si = rs + k;
        const s = S[si];
        for (let o = 0; o < offs.length; o++) {
          const lat = side * offs[o];
          const x = s.x + s.rx * lat;
          const z = s.z + s.rz * lat;
          const absLat = Math.abs(lat);
          let y;
          if (absLat <= HW + 0.01) {
            y = s.y + lat * s.bank - 0.06;
          } else {
            const roadEdgeY = s.y + side * HW * s.bank - 0.12;
            const hills = this._terrainNoise(x, z, s.y);
            const t = smoothstep(HW + 4, 70, absLat);
            y = lerp(roadEdgeY, hills, t);
          }
          tPos.push(x, y, z);
          tUv.push(x * 0.13, z * 0.13);
          // subtle per-vertex color variation (dry patches / rich grass) plus
          // a large-scale field tint — patchwork farmland from above
          const v = vnoise2(x * 0.05, z * 0.05, this.seedScatter);
          const dry = v * 0.22 + vnoise2(x * 0.013, z * 0.013, si) * 0.14;
          const field = vnoise2(x * 0.0045, z * 0.0045, this.seedScatter ^ 0x5157);
          const warm = (smoothstep(0.58, 0.85, field) * 0.42) - smoothstep(0.42, 0.12, field) * 0.16;
          tCol.push(
            1 - dry * 0.5 + warm * 0.3,
            1 - dry * 0.25 + warm * 0.02,
            1 - dry * 0.65 - warm * 0.22
          );
        }
      }
      const cols = offs.length;
      for (let k = 0; k < n; k++) {
        for (let o = 0; o < cols - 1; o++) {
          const a = k * cols + o;
          const b = a + 1;
          const c = a + cols;
          const d = c + 1;
          // winding chosen so faces point UP (normals +Y) on both sides
          if (side === 1) tIdx.push(a, b, c, b, d, c);
          else tIdx.push(a, c, b, b, c, d);
        }
      }
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.Float32BufferAttribute(tPos, 3));
      tg.setAttribute('uv', new THREE.Float32BufferAttribute(tUv, 2));
      tg.setAttribute('color', new THREE.Float32BufferAttribute(tCol, 3));
      tg.setIndex(tIdx);
      tg.computeVertexNormals();
      const tm = new THREE.Mesh(tg, this.matTerrain);
      tm.receiveShadow = true;
      this.group.add(tm);
      rec.meshes.push(tm);
    }

    // ---------------- scenery scatter --------------------------------------
    const rng = mulberry32((this.seedScatter ^ (ci * 2654435761)) >>> 0);
    const dummy = new THREE.Object3D();

    const placeOnGround = (latAbs, i) => {
      const s = S[i];
      const side = rng() < 0.5 ? -1 : 1;
      const lat = side * latAbs;
      const x = s.x + s.rx * lat + (rng() - 0.5) * SPACING;
      const z = s.z + s.rz * lat + (rng() - 0.5) * SPACING;
      return { x, z, y: this._groundBlend(x, z, i) };
    };

    const put = (pool, list, x, y, z, scale, rotY, tilt = 0) => {
      const slot = pool.alloc();
      if (slot < 0) return;
      dummy.position.set(x, y, z);
      dummy.rotation.set(tilt, rotY, tilt * 0.7);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      pool.setMatrix(slot, dummy.matrix);
      list.push(slot);
    };

    // trees — mixed forest: conifers + broadleafs
    const treeCount = Math.round(TRACK.treeDensity * sceneryScale);
    for (let t = 0; t < treeCount; t++) {
      const i = i0 + Math.floor(rng() * CHUNK);
      if (i >= S.length - 1) break;
      const latAbs = 16 + Math.pow(rng(), 1.6) * 115;
      const p = placeOnGround(latAbs, i);
      const sc = 0.75 + rng() * 0.95;
      put(this.poolTrees, rec.slots.tree, p.x, p.y - 0.15, p.z, sc, rng() * Math.PI * 2, (rng() - 0.5) * 0.06);
    }
    const tree2Count = Math.round(TRACK.tree2Density * sceneryScale);
    for (let t = 0; t < tree2Count; t++) {
      const i = i0 + Math.floor(rng() * CHUNK);
      if (i >= S.length - 1) break;
      const latAbs = 13 + Math.pow(rng(), 1.4) * 105;
      const p = placeOnGround(latAbs, i);
      const sc = 0.8 + rng() * 1.0;
      put(this.poolTrees2, rec.slots.tree2, p.x, p.y - 0.12, p.z, sc, rng() * Math.PI * 2, (rng() - 0.5) * 0.05);
    }
    // grass tufts — near-road dressing
    const grassCount = Math.round(TRACK.grassDensity * sceneryScale);
    for (let t = 0; t < grassCount; t++) {
      const i = i0 + Math.floor(rng() * CHUNK);
      if (i >= S.length - 1) break;
      const latAbs = HW + 1.6 + rng() * 26;
      const p = placeOnGround(latAbs, i);
      put(this.poolGrass, rec.slots.grass, p.x, p.y - 0.04, p.z, 0.6 + rng() * 1.0, rng() * Math.PI * 2);
    }
    // bushes
    const bushCount = Math.round(TRACK.bushDensity * sceneryScale);
    for (let t = 0; t < bushCount; t++) {
      const i = i0 + Math.floor(rng() * CHUNK);
      if (i >= S.length - 1) break;
      const latAbs = HW + 2.5 + rng() * 42;
      const p = placeOnGround(latAbs, i);
      put(this.poolBushes, rec.slots.bush, p.x, p.y - 0.08, p.z, 0.5 + rng() * 1.1, rng() * Math.PI * 2);
    }
    // rocks
    const rockCount = Math.round(TRACK.rockDensity * sceneryScale);
    for (let t = 0; t < rockCount; t++) {
      const i = i0 + Math.floor(rng() * CHUNK);
      if (i >= S.length - 1) break;
      const latAbs = HW + 4 + rng() * 60;
      const p = placeOnGround(latAbs, i);
      put(this.poolRocks, rec.slots.rock, p.x, p.y - 0.1, p.z, 0.4 + rng() * 1.3, rng() * Math.PI * 2);
    }
    // reflector posts, evenly spaced both sides
    const postEvery = TRACK.postSpacing / SPACING;
    for (let k = 0; k < CHUNK; k += postEvery) {
      const i = i0 + k;
      if (i >= S.length - 1) break;
      const s = S[i];
      for (const side of [-1, 1]) {
        const lat = side * (HW + 0.85);
        const x = s.x + s.rx * lat;
        const z = s.z + s.rz * lat;
        const y = s.y + lat * s.bank - 0.05;
        put(this.poolPosts, rec.slots.post, x, y, z, 1, Math.atan2(s.tx, s.tz));
      }
    }

    // power poles along one side (deterministic side per chunk)
    const poleEvery = TRACK.poleSpacing / SPACING;
    const poleSide = (Math.floor(ci / 2) % 2 === 0) ? 1 : -1;
    for (let k = 0; k < CHUNK; k += poleEvery) {
      const i = i0 + k;
      if (i >= S.length - 1) break;
      const s = S[i];
      const lat = poleSide * (HW + 4.4);
      const x = s.x + s.rx * lat;
      const z = s.z + s.rz * lat;
      const y = this._groundBlend(x, z, i) - 0.1;
      put(this.poolPoles, rec.slots.pole, x, y, z, 1, Math.atan2(s.tx, s.tz));
    }

    // ranch fences hugging the road on farm chunks
    if (ci % TRACK.fenceEvery !== 0) {
      const fenceSide = (ci % 2 === 0) ? 1 : -1;
      const fenceEvery = Math.max(1, Math.round(TRACK.fenceSpacing / SPACING));
      for (let k = 0; k < CHUNK; k += fenceEvery) {
        const i = i0 + Math.floor(k);
        if (i >= S.length - 1) break;
        const s = S[i];
        const lat = fenceSide * (HW + 2.6 + (ci % 3) * 0.9);
        const x = s.x + s.rx * lat;
        const z = s.z + s.rz * lat;
        const y = this._groundBlend(x, z, i) - 0.06;
        put(this.poolFence, rec.slots.fence, x, y, z, 1, Math.atan2(s.tx, s.tz) - Math.PI / 2);
      }
      // hay bales in the fields
      const hayCount = Math.round(TRACK.hayDensity * sceneryScale);
      for (let t = 0; t < hayCount; t++) {
        const i = i0 + Math.floor(rng() * CHUNK);
        if (i >= S.length - 1) break;
        const latAbs = HW + 8 + rng() * 34;
        const p = placeOnGround(latAbs, i);
        put(this.poolHay, rec.slots.hay, p.x, p.y - 0.05, p.z, 0.8 + rng() * 0.5, rng() * Math.PI);
      }
    }

    // a barn now and then — the anchor of each farm stretch
    if (ci % TRACK.barnEvery === 2) {
      const i = i0 + Math.floor(CHUNK * 0.4);
      if (i < S.length - 1) {
        const s = S[i];
        const side = (Math.floor(ci / TRACK.barnEvery) % 2 === 0) ? 1 : -1;
        const lat = side * (48 + rng() * 26);
        const x = s.x + s.rx * lat;
        const z = s.z + s.rz * lat;
        const y = this._groundBlend(x, z, i) - 0.25;
        const rot = Math.atan2(s.tx, s.tz) + Math.PI / 2 + (rng() - 0.5) * 0.4;
        put(this.poolBarns, rec.slots.barn, x, y, z, 0.95 + rng() * 0.45, rot);
      }
    }

    // wind turbines on the far hills (animated in update())
    if (ci % TRACK.turbineEvery === 4 && ci > 1) {
      const i = i0 + Math.floor(CHUNK * 0.55);
      if (i < S.length - 1) {
        const s = S[i];
        const side = (Math.floor(ci / TRACK.turbineEvery) % 2 === 0) ? 1 : -1;
        const lat = side * (95 + rng() * 45);
        const x = s.x + s.rx * lat;
        const z = s.z + s.rz * lat;
        const y = this._groundBlend(x, z, i) - 0.4;
        const turbine = this._turbineGeo();
        turbine.position.set(x, y, z);
        turbine.rotation.y = Math.atan2(s.tx, s.tz) + Math.PI / 2;
        turbine.userData.spin = 0.55 + rng() * 0.55;
        this.group.add(turbine);
        rec.turbine = turbine;
      }
    }

    this.chunkMeshes.set(ci, rec);
  }

  _disposeChunk(rec) {
    for (const m of rec.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.poolTrees.releaseAll(rec.slots.tree);
    this.poolTrees2.releaseAll(rec.slots.tree2);
    this.poolBushes.releaseAll(rec.slots.bush);
    this.poolRocks.releaseAll(rec.slots.rock);
    this.poolPosts.releaseAll(rec.slots.post);
    this.poolPoles.releaseAll(rec.slots.pole);
    this.poolFence.releaseAll(rec.slots.fence);
    this.poolBarns.releaseAll(rec.slots.barn);
    this.poolHay.releaseAll(rec.slots.hay);
    this.poolGrass.releaseAll(rec.slots.grass);
    if (rec.turbine) {
      this.group.remove(rec.turbine);
      rec.turbine = null;
    }
  }

  // ============================================================== public API

  /**
   * Nearest centerline lookup — windowed search around `hintIdx`.
   * Returns { idx, s (m), lateral (signed, + = right of centerline),
   *           rightX, rightZ, tanX, tanZ, curb }
   */
  locate(x, z, hintIdx = null) {
    const S = this.samples;
    let lo, hi;
    if (hintIdx == null) {
      lo = 0; hi = S.length - 1;             // full scan (spawn / reset)
    } else {
      lo = Math.max(0, hintIdx - 90);
      hi = Math.min(S.length - 1, hintIdx + 180);
    }
    let bestI = lo, bestD = Infinity;
    for (let i = lo; i <= hi; i++) {
      const s = S[i];
      const dx = x - s.x, dz = z - s.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; bestI = i; }
    }
    const s = S[bestI];
    const dx = x - s.x, dz = z - s.z;
    const along = dx * s.tx + dz * s.tz;
    const lateral = dx * s.rx + dz * s.rz;
    const absLat = Math.abs(lateral);
    const HW = TRACK.roadHalfWidth;
    return {
      idx: bestI,
      s: bestI * SPACING + along,
      lateral,
      rightX: s.rx, rightZ: s.rz,
      tanX: s.tx, tanZ: s.tz,
      curb: absLat > HW - 0.55 && absLat < HW + 1.4
    };
  }

  /**
   * Surface under a point `lateral` meters right of sample `idx`.
   * y includes superelevation; slope is longitudinal; bankSlope is the
   * lateral gradient (dy/dlateral).
   */
  surfaceAt(idx, lateral) {
    const S = this.samples;
    const i = clamp(idx, 0, S.length - 1);
    const s = S[i];
    const y = s.y + lateral * s.bank;
    const i0 = Math.max(0, i - 1), i1 = Math.min(S.length - 1, i + 1);
    const slope = (S[i1].y - S[i0].y) / ((i1 - i0) * SPACING);
    return { y, slope, bankSlope: s.bank };
  }

  /** world position at s meters along the road (with lateral offset) */
  pointAt(s) {
    const S = this.samples;
    const f = clamp(s / SPACING, 0, S.length - 1.001);
    const i = Math.floor(f);
    const t = f - i;
    const a = S[i], b = S[Math.min(S.length - 1, i + 1)];
    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
      bank: lerp(a.bank, b.bank, t)
    };
  }

  tangentAt(s) {
    const S = this.samples;
    const i = clamp(Math.round(s / SPACING), 0, S.length - 1);
    const t = S[i];
    return { x: t.tx, y: 0, z: t.tz };
  }

  /** ground height at an arbitrary world position (road-aware) */
  heightAtWorld(x, z, hintIdx = null) {
    const loc = this.locate(x, z, hintIdx);
    return this._groundBlend(x, z, loc.idx);
  }

  /**
   * Per-frame streaming. Generates road ahead of the car and frees chunks
   * behind. `sceneryScale` from the graphics quality preset; `dt` drives
   * wind-turbine animation.
   */
  update(carPos, sceneryScale = 1, dt = 0) {
    const loc = this.locate(carPos.x, carPos.z, this._lastIdx ?? null);
    this._lastIdx = loc.idx;
    this._stream(loc.idx, sceneryScale);
    // glue the distant ridge to the car
    this.ridge.position.set(carPos.x, Math.min(carPos.y, 0) - 6, carPos.z);
    // spin the wind turbines
    if (dt > 0) {
      for (const rec of this.chunkMeshes.values()) {
        if (rec.turbine) {
          rec.turbine.userData.rotor.rotation.x += dt * rec.turbine.userData.spin;
        }
      }
    }
    return loc;
  }

  /** tear everything down and rebuild from a new seed */
  regenerate(seed) {
    for (const rec of this.chunkMeshes.values()) this._disposeChunk(rec);
    this.chunkMeshes.clear();
    this.samples.length = 0;
    this._genI = 1;
    this._curvSmooth = 0;
    this._bankSmooth = 0;
    this.seed = seed >>> 0;
    const b = this.seed;
    this.seedCurvA = b ^ 0x1a2b3c;
    this.seedCurvB = b ^ 0x2b3c4d;
    this.seedSlopeA = b ^ 0x3c4d5e;
    this.seedSlopeB = b ^ 0x4d5e6f;
    this.seedTerrain = b ^ 0x5e6f70;
    this.seedTerrain2 = b ^ 0x6f7081;
    this.seedScatter = b ^ 0x708192;
    this._lastIdx = null;
    this._generateSamples(CHUNK * 20 + 8);
    this._stream(0, this.quality.sceneryScale);
  }

  get sampleCount() { return this.samples.length; }
  get startS() { return 8 * SPACING; }

  /** compatibility no-ops (old Track API used by nothing critical now) */
  hideProceduralSurface() {}
  buildTrees() {}
}
