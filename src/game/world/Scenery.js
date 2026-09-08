/**
 * Scenery — shared geometry factories, canvas textures and materials for the
 * streamed world. Everything is built ONCE and reused by every chunk via
 * instancing, so the whole open world costs a handful of draw calls per
 * chunk and near-zero memory duplication.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/Noise.js';

// ------------------------------------------------------------ canvas utils

export function canvasTexture(w, h, draw, opts = {}) {
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

function speckle(ctx, w, h, count, alpha, dark, light, rng = Math.random) {
  for (let i = 0; i < count; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const s = 1 + rng() * 2;
    ctx.fillStyle = rng() < 0.5 ? dark : light;
    ctx.globalAlpha = alpha * rng();
    ctx.fillRect(x, y, s, s);
  }
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------ road textures

/**
 * Road cross-section texture. u runs across the road, v along it.
 * hwSpan = half-width in meters the texture spans (cross-section repeats
 * symmetric); we paint: shoulder | edge line | lanes | center | lanes | edge | shoulder
 */
export function buildRoadTexture(kind, aniso, rng = Math.random) {
  const W = 512, H = 512;
  const tex = canvasTexture(W, H, (ctx) => {
    // Gravel shoulder — slightly warmer tone with stone aggregate speckle
    ctx.fillStyle = '#605a50';
    ctx.fillRect(0, 0, W, H);
    speckle(ctx, W, H, 3200, 0.45, '#4d483e', '#746e62', rng);
    speckle(ctx, W, H, 800, 0.18, '#3a3630', '#858074', rng);

    const asphalt = (x0, x1) => {
      ctx.fillStyle = '#35373c';
      ctx.fillRect(x0, 0, x1 - x0, H);
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, H); ctx.clip();
      speckle(ctx, W, H, 3400, 0.20, '#2a2c30', '#414550', rng);
      speckle(ctx, W, H, 600, 0.08, '#1e2024', '#4d5058', rng);
      ctx.restore();
    };
    const line = (x, w, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(x - w / 2, 0, w, H);
    };
    const dash = (x, w, color, dashH = H * 0.28, gapH = H * 0.22) => {
      ctx.fillStyle = color;
      for (let y = 0; y < H; y += dashH + gapH) ctx.fillRect(x - w / 2, y, w, dashH);
    };

    if (kind === 'highway') {
      // 4 lanes: asphalt from 12%..88%
      const ax0 = W * 0.115, ax1 = W * 0.885;
      asphalt(ax0, ax1);
      // reflective edge strips (slightly wider, brighter)
      line(ax0 + 18, 6, 'rgba(230,234,240,0.88)');
      line(ax1 - 18, 6, 'rgba(230,234,240,0.88)');
      // reflective edge strip shadow (subtle depth)
      line(ax0 + 23, 2, 'rgba(20,20,20,0.25)');
      line(ax1 - 23, 2, 'rgba(20,20,20,0.25)');
      // double yellow center (wider, warm amber)
      line(W * 0.5, 7, 'rgba(224,200,110,0.92)');
      line(W * 0.5 - 11, 5, 'rgba(224,200,110,0.92)');
      line(W * 0.5 + 11, 5, 'rgba(224,200,110,0.92)');
      // lane dividers — white dashed, good contrast
      dash(W * 0.27, 4.5, 'rgba(230,234,240,0.8)');
      dash(W * 0.73, 4.5, 'rgba(230,234,240,0.8)');
      // rumble strip at edge (very faint texture)
      speckle(ctx, W, H, 200, 0.12, '#50545c', '#282c30', rng);
    } else if (kind === 'rural') {
      const ax0 = W * 0.10, ax1 = W * 0.90;
      asphalt(ax0, ax1);
      line(ax0 + 16, 5, 'rgba(228,232,238,0.82)');
      line(ax1 - 16, 5, 'rgba(228,232,238,0.82)');
      dash(W * 0.5, 5, 'rgba(226,220,170,0.82)');
    } else if (kind === 'street') {
      const ax0 = W * 0.06, ax1 = W * 0.94;
      asphalt(ax0, ax1);
      // concrete curbs with shadow
      ctx.fillStyle = '#98958e';
      ctx.fillRect(ax0 - 10, 0, 10, H);
      ctx.fillRect(ax1, 0, 10, H);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(ax0, 0, 2, H);
      ctx.fillRect(ax1 - 2, 0, 2, H);
      dash(W * 0.5, 4, 'rgba(228,232,238,0.6)', H * 0.2, H * 0.28);
    } else if (kind === 'dirt') {
      ctx.fillStyle = '#7a6748';
      ctx.fillRect(W * 0.12, 0, W * 0.76, H);
      speckle(ctx, W, H, 2800, 0.38, '#5f5038', '#8f7c58', rng);
      speckle(ctx, W, H, 400, 0.12, '#443628', '#a08d68', rng);
      // wheel ruts
      ctx.fillStyle = 'rgba(66,54,38,0.5)';
      ctx.fillRect(W * 0.30, 0, W * 0.09, H);
      ctx.fillRect(W * 0.61, 0, W * 0.09, H);
    } else {
      // plain asphalt (ramps) — slightly darker to distinguish from rural
      const ax0 = W * 0.12, ax1 = W * 0.88;
      asphalt(ax0, ax1);
      line(ax0 + 14, 5, 'rgba(228,232,238,0.82)');
      line(ax1 - 14, 5, 'rgba(228,232,238,0.82)');
    }
  }, { anisotropy: aniso });
  return tex;
}

export function buildGroundTexture(aniso, rng = Math.random) {
  const tex = canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#7a8862';
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, 2000, 0.30, '#6a7852', '#8e9c70', rng);
    speckle(ctx, w, h, 400, 0.15, '#5e6c48', '#a0b080', rng);
  }, { anisotropy: aniso });
  return tex;
}

/** building facade with window grid — used as map + emissiveMap (night) */
export function buildFacadeTexture() {
  const W = 256, H = 256;
  const tex = canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = '#b5b9be';
    ctx.fillRect(0, 0, W, H);
    // concrete banding with subtle horizontal grooves
    for (let y = 0; y < H; y += 32) {
      ctx.fillStyle = 'rgba(0,0,0,0.05)';
      ctx.fillRect(0, y, W, 2);
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, y + 2, W, 1);
    }
    // vertical grooves on facade (floor separation)
    for (let x = 0; x < W; x += 32) {
      ctx.fillStyle = 'rgba(0,0,0,0.04)';
      ctx.fillRect(x, 0, 1, H);
    }
    // windows: 6 cols x 8 rows
    const cols = 6, rows = 8;
    const mx = 10, my = 8;
    const cw = (W - mx * 2) / cols, ch = (H - my * 2) / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = mx + c * cw + cw * 0.16;
        const y = my + r * ch + ch * 0.18;
        const w = cw * 0.68, h = ch * 0.52;
        // window frame (dark concrete)
        ctx.fillStyle = '#1a2028';
        ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
        // glass pane (dark blue-grey)
        ctx.fillStyle = '#192532';
        ctx.fillRect(x, y, w, h);
        // sky reflection (subtle gradient at top of pane)
        ctx.fillStyle = 'rgba(100,150,200,0.22)';
        ctx.fillRect(x, y, w, h * 0.4);
        // window mullion (vertical split)
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(x + w * 0.49, y, w * 0.02, h);
      }
    }
  });
  return tex;
}

export function buildWindowsEmissive(rng = Math.random) {
  const W = 256, H = 256;
  return canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);
    const cols = 6, rows = 8;
    const mx = 10, my = 8;
    const cw = (W - mx * 2) / cols, ch = (H - my * 2) / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // some windows dark (unoccupied, curtains, etc.)
        if (rng() < 0.42) continue;
        const x = mx + c * cw + cw * 0.16;
        const y = my + r * ch + ch * 0.18;
        const w = cw * 0.68, h = ch * 0.52;
        const light = rng();
        const color = light < 0.6
          ? `rgba(255,220,155,${0.7 + light * 0.3})`   // warm incandescent
          : `rgba(190,220,255,${0.6 + light * 0.2})`;  // cool fluorescent
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);
        // light spill (subtle glow outside frame)
        if (rng() < 0.18) {
          ctx.fillStyle = 'rgba(255,220,155,0.08)';
          ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
        }
      }
    }
  });
}

// ------------------------------------------------------------ geometry factory

function paintVerts(geo, hexTop, hexBottom) {
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
  return geo;
}

export class Scenery {
  constructor(seed = 0, aniso = 4) {
    this._rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    this.buildTextures(aniso);
    this.buildMaterials();
    this.buildGeometries();
  }

  buildTextures(aniso) {
    const rng = this._rng;
    this.texHighway = buildRoadTexture('highway', aniso, rng);
    this.texRural = buildRoadTexture('rural', aniso, rng);
    this.texStreet = buildRoadTexture('street', aniso, rng);
    this.texDirt = buildRoadTexture('dirt', aniso, rng);
    this.texRamp = buildRoadTexture('ramp', aniso, rng);
    this.texFacade = buildFacadeTexture();
    this.texWindows = buildWindowsEmissive(rng);
    this.groundTex = buildGroundTexture(aniso, rng);
    this.groundTex.repeat.set(1, 1);
  }

  buildMaterials() {
    this.matTerrain = new THREE.MeshStandardMaterial({
      map: this.groundTex, roughness: 1.0, metalness: 0, vertexColors: true
    });
    this.roadMats = {
      highway: new THREE.MeshStandardMaterial({ map: this.texHighway, roughness: 0.88, metalness: 0.02 }),
      rural: new THREE.MeshStandardMaterial({ map: this.texRural, roughness: 0.90, metalness: 0.01 }),
      street: new THREE.MeshStandardMaterial({ map: this.texStreet, roughness: 0.92, metalness: 0.01 }),
      dirt: new THREE.MeshStandardMaterial({ map: this.texDirt, roughness: 1.0, metalness: 0 }),
      ramp: new THREE.MeshStandardMaterial({ map: this.texRamp, roughness: 0.88, metalness: 0.02 })
    };
    this.matStructure = new THREE.MeshStandardMaterial({ color: 0x8b8981, roughness: 0.92, vertexColors: false });
    this.matTree = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true
    });
    this.matPost = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.6 });
    this.matConcrete = new THREE.MeshStandardMaterial({ color: 0x9a988f, roughness: 0.9 });
    this.matDarkConcrete = new THREE.MeshStandardMaterial({ color: 0x63615c, roughness: 0.95 });
    this.matBuilding = new THREE.MeshStandardMaterial({
      map: this.texFacade, roughness: 0.85, metalness: 0.05,
      emissiveMap: this.texWindows, emissive: 0xffc878, emissiveIntensity: 0.0
    });
    this.matWarehouse = new THREE.MeshStandardMaterial({ color: 0x7d8288, roughness: 0.8, metalness: 0.2 });
    this.matRoof = new THREE.MeshStandardMaterial({ color: 0x4c4f54, roughness: 0.9 });
    this.matParking = new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.96 });
    this.matTower = new THREE.MeshStandardMaterial({ color: 0x3a4148, roughness: 0.5, metalness: 0.5 });
    this.matBeacon = new THREE.MeshBasicMaterial({ color: 0xff2020, toneMapped: false });
    this.matLamp = new THREE.MeshStandardMaterial({ color: 0x3c4046, roughness: 0.6, metalness: 0.4 });
    this.matLampGlow = new THREE.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false });
    this.matWater = new THREE.MeshStandardMaterial({
      color: 0x1f5876, roughness: 0.14, metalness: 0.6,
      transparent: true, opacity: 0.86
    });
    this.matRail = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.5, metalness: 0.6 });
    this.matMystery = new THREE.MeshStandardMaterial({
      color: 0x14161c, roughness: 0.55, metalness: 0.5,
      emissive: 0x0a2412, emissiveIntensity: 0.6
    });
  }

  buildGeometries() {
    // ---- conifer --------------------------------------------------------
    const trunk = new THREE.CylinderGeometry(0.14, 0.22, 1.6, 6);
    trunk.translate(0, 0.8, 0);
    const cone1 = new THREE.ConeGeometry(1.55, 2.6, 7);
    cone1.translate(0, 2.6, 0);
    const cone2 = new THREE.ConeGeometry(1.05, 1.9, 7);
    cone2.translate(0, 4.15, 0);
    paintVerts(trunk, 0x5a4632, 0x4a3828);
    paintVerts(cone1, 0x3f6d33, 0x2e5226);
    paintVerts(cone2, 0x487a3a, 0x35592b);
    this.coniferGeo = mergeGeometries([trunk, cone1, cone2], false);
    this.coniferGeo.computeVertexNormals();

    // ---- broadleaf ------------------------------------------------------
    const t2trunk = new THREE.CylinderGeometry(0.16, 0.26, 1.9, 6);
    t2trunk.translate(0, 0.95, 0);
    paintVerts(t2trunk, 0x63513c, 0x4e3e2c);
    const blobs = [
      { r: 1.45, x: 0, y: 2.9, z: 0, top: 0x6f9a45, bot: 0x4e7030 },
      { r: 1.0, x: 0.68, y: 2.35, z: 0.4, top: 0x7ca44e, bot: 0x547838 },
      { r: 0.9, x: -0.6, y: 2.5, z: -0.35, top: 0x63903e, bot: 0x48682e },
      { r: 0.72, x: 0.15, y: 3.55, z: 0.1, top: 0x82ab54, bot: 0x5a7c3c }
    ];
    const parts = [t2trunk];
    for (const b of blobs) {
      const blob = new THREE.IcosahedronGeometry(b.r, 1);
      blob.scale(1.05, 0.85, 1.05);
      blob.translate(b.x, b.y, b.z);
      paintVerts(blob, b.top, b.bot);
      parts.push(blob);
    }
    this.broadleafGeo = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false);
    this.broadleafGeo.computeVertexNormals();

    // ---- palm (coast) ------------------------------------------------------
    const ptrunk = new THREE.CylinderGeometry(0.13, 0.22, 4.4, 6);
    ptrunk.translate(0, 2.2, 0);
    ptrunk.rotateZ(0.1);
    paintVerts(ptrunk, 0x7a6248, 0x5e4a34);
    const fronds = [];
    for (let i = 0; i < 6; i++) {
      const f = new THREE.ConeGeometry(0.34, 2.6, 4);
      f.translate(0, 1.3, 0);
      f.rotateX(Math.PI * 0.62);
      f.rotateY((i / 6) * Math.PI * 2);
      f.translate(0, 4.3, 0.2);
      paintVerts(f, 0x5d9848, 0x3e6e2e);
      fronds.push(f);
    }
    this.palmGeo = mergeGeometries([ptrunk, ...fronds].map((p) => (p.index ? p.toNonIndexed() : p)), false);
    this.palmGeo.computeVertexNormals();

    // ---- cactus (desert) ---------------------------------------------------
    const cbody = new THREE.CylinderGeometry(0.32, 0.4, 2.4, 7);
    cbody.translate(0, 1.2, 0);
    paintVerts(cbody, 0x3f7a44, 0x2e5c33);
    const cparts = [cbody];
    for (const side of [-1, 1]) {
      const arm = new THREE.CylinderGeometry(0.16, 0.2, 1.0, 6);
      arm.translate(side * 0.5, 1.45, 0);
      arm.rotateZ(side * 0.9);
      paintVerts(arm, 0x3f7a44, 0x2e5c33);
      cparts.push(arm);
    }
    this.cactusGeo = mergeGeometries(cparts.map((p) => (p.index ? p.toNonIndexed() : p)), false);
    this.cactusGeo.computeVertexNormals();

    // ---- dead tree (mystery zones) ----------------------------------------
    const dtrunk = new THREE.CylinderGeometry(0.10, 0.20, 2.6, 5);
    dtrunk.translate(0, 1.3, 0);
    paintVerts(dtrunk, 0x4a4238, 0x332c24);
    const dparts = [dtrunk];
    for (let i = 0; i < 4; i++) {
      const br = new THREE.CylinderGeometry(0.04, 0.08, 1.2, 4);
      br.translate(0, 0.6, 0);
      br.rotateZ(0.7 + this._rng() * 0.5);
      br.rotateY((i / 4) * Math.PI * 2);
      br.translate(0, 1.2 + i * 0.3, 0);
      paintVerts(br, 0x4a4238, 0x332c24);
      dparts.push(br);
    }
    this.deadTreeGeo = mergeGeometries(dparts.map((p) => (p.index ? p.toNonIndexed() : p)), false);

    // ---- bush / rock / grass / flower --------------------------------------
    const bush = new THREE.IcosahedronGeometry(1.0, 0);
    bush.scale(1.25, 0.75, 1.1);
    bush.translate(0, 0.55, 0);
    this.bushGeo = paintVerts(bush, 0x557a38, 0x3c5a28);

    const rock = new THREE.DodecahedronGeometry(0.9, 0);
    rock.scale(1.3, 0.8, 1.0);
    rock.translate(0, 0.35, 0);
    this.rockGeo = paintVerts(rock, 0x94948f, 0x7c7c76);

    const g1 = new THREE.ConeGeometry(0.3, 0.55, 5);
    g1.translate(0, 0.26, 0);
    const g2 = new THREE.ConeGeometry(0.2, 0.38, 5);
    g2.translate(0.14, 0.18, 0.1);
    this.grassGeo = paintVerts(mergeGeometries([g1, g2], false), 0x6d9444, 0x4c6c30);

    const f1 = new THREE.IcosahedronGeometry(0.075, 0);
    f1.scale(1, 0.75, 1);
    f1.translate(0, 0.09, 0);
    const f2 = new THREE.IcosahedronGeometry(0.055, 0);
    f2.scale(1, 0.7, 1);
    f2.translate(0.09, 0.07, 0.04);
    this.flowerGeo = paintVerts(mergeGeometries([f1, f2], false), 0xf2f2ee, 0xdcdcd4);

    const fernParts = [];
    for (let i = 0; i < 5; i++) {
      const blade = new THREE.ConeGeometry(0.05, 0.52, 4);
      blade.translate(0, 0.26, 0);
      blade.rotateX(0.95);
      blade.rotateY((i / 5) * Math.PI * 2);
      fernParts.push(blade);
    }
    this.fernGeo = paintVerts(mergeGeometries(fernParts, false), 0x3f6d33, 0x2a4a22);

    // ---- reflector post + guardrail ---------------------------------------
    const post = new THREE.BoxGeometry(0.09, 1.05, 0.09);
    post.translate(0, 0.52, 0);
    const cap = new THREE.BoxGeometry(0.11, 0.16, 0.02);
    cap.translate(0, 0.95, 0.045);
    this.postGeo = mergeGeometries([post, cap], false);

    // ---- street lamp --------------------------------------------------------
    const pole = new THREE.CylinderGeometry(0.07, 0.1, 6.4, 6);
    pole.translate(0, 3.2, 0);
    // tapered top section
    const poleTop = new THREE.CylinderGeometry(0.055, 0.075, 1.1, 6);
    poleTop.translate(0, 6.1, 0);
    // curved arm (approximated with a bent cylinder)
    const arm = new THREE.CylinderGeometry(0.06, 0.06, 1.7, 6);
    arm.translate(0.82, 6.35, 0);
    arm.rotateZ(0.12);
    // lamp head housing
    const head = new THREE.BoxGeometry(0.62, 0.12, 0.28);
    head.translate(1.5, 6.3, 0);
    head.rotateZ(0.1);
    // base plate
    const base = new THREE.CylinderGeometry(0.16, 0.2, 0.16, 6);
    base.translate(0, 0.08, 0);
    const glow = new THREE.BoxGeometry(0.5, 0.05, 0.2);
    glow.translate(1.5, 6.2, 0);
    glow.rotateZ(0.1);
    this.lampGeo = mergeGeometries([pole, poleTop, base, arm, head], false);
    this.lampGlowGeo = glow;

    // ---- building block (unit footprint, scaled per instance) --------------
    const bld = new THREE.BoxGeometry(1, 1, 1);
    bld.translate(0, 0.5, 0);
    const uv = bld.attributes.uv;
    // per-face UV scale so windows keep aspect — simple approach: keep uv
    this.buildingGeo = bld;
    const roof = new THREE.BoxGeometry(1.06, 0.06, 1.06);
    roof.translate(0, 1.02, 0);
    const roofGeo = roof;
    this.buildingRoofGeo = roofGeo;

    // ---- warehouse (sawtooth roof) -----------------------------------------
    const wbox = new THREE.BoxGeometry(1, 1, 1);
    wbox.translate(0, 0.5, 0);
    this.warehouseGeo = wbox;

    // ---- viaduct pylon ------------------------------------------------------
    const py = new THREE.BoxGeometry(2.2, 1, 1.6);
    py.translate(0, 0.5, 0);
    this.pylonGeo = py;

    // ---- guardrail segment (spans local X, 4 m) -----------------------------
    const rpost1 = new THREE.BoxGeometry(0.08, 0.8, 0.08);
    rpost1.translate(-1.9, 0.4, 0);
    const rpost2 = new THREE.BoxGeometry(0.08, 0.8, 0.08);
    rpost2.translate(1.9, 0.4, 0);
    // upper beam — wide face
    const rbeam = new THREE.BoxGeometry(4.0, 0.22, 0.04);
    rbeam.translate(0, 0.66, 0);
    // lower beam — adds visual depth and shadow
    const rbeam2 = new THREE.BoxGeometry(4.0, 0.12, 0.04);
    rbeam2.translate(0, 0.36, 0.02);
    this.railGeo = mergeGeometries([rpost1, rpost2, rbeam, rbeam2], false);

    // ---- mystery monolith ---------------------------------------------------
    const mono = new THREE.BoxGeometry(1.6, 9.0, 0.8);
    mono.translate(0, 4.5, 0);
    mono.rotateZ(0.03);
    this.monolithGeo = paintVerts(mono, 0x1a1d26, 0x0c0e12);

    // ---- mystery arch pair --------------------------------------------------
    const leg = new THREE.BoxGeometry(1.1, 6.0, 1.1);
    const l1 = leg.clone(); l1.translate(-3, 3, 0);
    const l2 = leg.clone(); l2.translate(3, 3, 0);
    const top = new THREE.BoxGeometry(7.6, 1.0, 1.3);
    top.translate(0, 6.4, 0);
    this.archGeo = mergeGeometries([l1, l2, top], false);
    paintVerts(this.archGeo, 0x262a30, 0x101215);

    // ---- wrecked car (mystery) ---------------------------------------------
    const wreckBody = new THREE.BoxGeometry(4.2, 0.9, 1.8);
    wreckBody.translate(0, 0.75, 0);
    const wreckCab = new THREE.BoxGeometry(2.2, 0.7, 1.6);
    wreckCab.translate(-0.3, 1.5, 0);
    this.wreckGeo = mergeGeometries([wreckBody, wreckCab], false);
    paintVerts(this.wreckGeo, 0x5c4a3a, 0x3a2f24);

    // ---- stone circle rock --------------------------------------------------
    const stone = new THREE.BoxGeometry(1.0, 3.4, 0.7);
    stone.translate(0, 1.7, 0);
    stone.rotateZ((this._rng() - 0.5) * 0.12);
    this.stoneGeo = paintVerts(stone, 0x6b6d70, 0x47494c);
  }
}

/** shared vertex-color helper for ad-hoc geometry */
export { paintVerts };
