/**
 * Track — a procedurally generated city with a road grid, buildings,
 * guardrails, streetlights, intersections, and roadside detail.
 *
 * The layout is a GRID of city blocks separated by roads. Each block
 * contains 1-6 buildings of varying height/color. Roads intersect at
 * regular intervals. The driving surface is the road grid — physics
 * samples a height function that returns 0 on roads, with small curb
 * bumps at road edges.
 *
 * No external assets. Everything is built from Three.js primitives +
 * InstancedMesh for buildings/streetlights/guardrails.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BLOCK_SIZE = 60;       // size of each city block (m)
const ROAD_WIDTH = 14;       // road width between blocks (m)
const GRID_W = 5;            // grid blocks east-west (total ~300m)
const GRID_H = 5;            // grid blocks north-south
const CELL = BLOCK_SIZE + ROAD_WIDTH;

// center the grid on origin
const OFFSET_X = -(GRID_W * CELL) / 2;
const OFFSET_Z = -(GRID_H * CELL) / 2;

/** smooth global terrain height — almost flat with gentle rolling */
function terrainH(x, z) {
  return 0.5 * Math.sin(x * 0.004) * Math.cos(z * 0.005)
    + 0.3 * Math.sin(x * 0.011 + 1.2);
}

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

export class Track {
  constructor(maxAnisotropy = 4) {
    this.group = new THREE.Group();
    this.roadHalfWidth = ROAD_WIDTH / 2;
    this.sampleCount = 200;     // sampled for physics (not really used for the grid)
    // startS + totalLength are plain properties (NOT getters) so they can
    // be assigned in the constructor without "read only property" errors.
    this._startS = 0;
    this._totalLength = CELL * GRID_W;

    // sample arrays (kept for Physics compatibility, though the city is a grid)
    this.px = []; this.pz = []; this.py = [];
    this.rightX = []; this.rightZ = [];
    this.tanX = []; this.tanZ = [];
    this._curv = new Array(this.sampleCount).fill(0);
    this.bank = [];
    this.curbFlag = [];

    this._buildTextures(maxAnisotropy);
    this._buildGround();
    this._buildRoads();
    this._buildBuildings();
    this._buildGuardrails();
    this._buildStreetlights();
    this._buildIntersections();
    this._buildSkyline();
  }

  // ----------------------------------------------------------- textures
  _buildTextures(aniso) {
    // asphalt
    this.texAsphalt = canvasTexture(256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#2a2d33';
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 2400, 0.2, '#1f2228', '#363a40');
      // lane line down the middle
      ctx.fillStyle = '#c9cdd4';
      ctx.globalAlpha = 0.6;
      for (let y = 0; y < h; y += 48) ctx.fillRect(w / 2 - 2, y, 4, 24);
      ctx.globalAlpha = 1;
    }, { anisotropy: aniso });
    this.texAsphalt.repeat.set(1, 8);

    // grass / ground
    this.texGrass = canvasTexture(256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#1e2a18';
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 2600, 0.2, '#142012', '#2a3820');
    }, { anisotropy: aniso });
    this.texGrass.repeat.set(80, 80);

    // building facade
    this.texBuilding = canvasTexture(128, 256, (ctx, w, h) => {
      ctx.fillStyle = '#3a3d44';
      ctx.fillRect(0, 0, w, h);
      noise(ctx, w, h, 200, 0.1, '#2e3036', '#46494f');
      // windows
      for (let y = 8; y < h - 8; y += 20) {
        for (let x = 8; x < w - 8; x += 22) {
          const lit = Math.random() < 0.35;
          ctx.fillStyle = lit ? '#ffe9a8' : '#1a2a3a';
          ctx.globalAlpha = 0.85;
          ctx.fillRect(x, y, 14, 12);
        }
      }
      ctx.globalAlpha = 1;
    }, { anisotropy: aniso });
  }

  // ----------------------------------------------------------- ground
  _buildGround() {
    const totalW = GRID_W * CELL + 200;
    const totalH = GRID_H * CELL + 200;
    const geo = new THREE.PlaneGeometry(totalW, totalH, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      map: this.texGrass, roughness: 1, metalness: 0
    });
    const ground = new THREE.Mesh(geo, mat);
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    this.group.add(ground);
    this.groundMesh = ground;
  }

  // ----------------------------------------------------------- roads
  _buildRoads() {
    // build the road grid as one merged geometry
    const roadGeos = [];
    const totalW = GRID_W * CELL;
    const totalH = GRID_H * CELL;

    // horizontal roads (run east-west, at the south edge of each block row)
    for (let j = 0; j <= GRID_H; j++) {
      const z = OFFSET_Z + j * CELL - ROAD_WIDTH / 2;
      const geo = new THREE.PlaneGeometry(totalW + ROAD_WIDTH, ROAD_WIDTH, 1, 1);
      geo.rotateX(-Math.PI / 2);
      geo.translate(OFFSET_X + totalW / 2, 0.01, z);
      roadGeos.push(geo);
    }
    // vertical roads (run north-south)
    for (let i = 0; i <= GRID_W; i++) {
      const x = OFFSET_X + i * CELL - ROAD_WIDTH / 2;
      const geo = new THREE.PlaneGeometry(ROAD_WIDTH, totalH + ROAD_WIDTH, 1, 1);
      geo.rotateX(-Math.PI / 2);
      geo.translate(x, 0.01, OFFSET_Z + totalH / 2);
      roadGeos.push(geo);
    }

    const merged = mergeGeometries(roadGeos, false);
    const mat = new THREE.MeshStandardMaterial({
      map: this.texAsphalt, roughness: 0.92, metalness: 0
    });
    const roadMesh = new THREE.Mesh(merged, mat);
    roadMesh.receiveShadow = true;
    this.group.add(roadMesh);
    this.roadMesh = roadMesh;

    // road markings — dashed center lines along each road segment
    const markGeos = [];
    const markMat = new THREE.MeshBasicMaterial({ color: 0xf2f4f6, toneMapped: false });
    for (let j = 0; j <= GRID_H; j++) {
      const z = OFFSET_Z + j * CELL - ROAD_WIDTH / 2;
      for (let x = OFFSET_X; x < OFFSET_X + totalW; x += 6) {
        const g = new THREE.BoxGeometry(3, 0.02, 0.15);
        g.translate(x + 3, 0.02, z);
        markGeos.push(g);
      }
    }
    for (let i = 0; i <= GRID_W; i++) {
      const x = OFFSET_X + i * CELL - ROAD_WIDTH / 2;
      for (let z = OFFSET_Z; z < OFFSET_Z + totalH; z += 6) {
        const g = new THREE.BoxGeometry(0.15, 0.02, 3);
        g.translate(x, 0.02, z + 3);
        markGeos.push(g);
      }
    }
    if (markGeos.length) {
      const marks = new THREE.Mesh(mergeGeometries(markGeos, false), markMat);
      this.group.add(marks);
    }

    // curbs at road edges (small raised strips)
    const curbGeos = [];
    const curbMat = new THREE.MeshStandardMaterial({
      color: 0x8a8e95, roughness: 0.8, metalness: 0.1
    });
    const curbH = 0.12;
    for (let j = 0; j <= GRID_H; j++) {
      const zCenter = OFFSET_Z + j * CELL - ROAD_WIDTH / 2;
      for (const side of [1, -1]) {
        const z = zCenter + side * (ROAD_WIDTH / 2 - 0.15);
        const g = new THREE.BoxGeometry(totalW + ROAD_WIDTH, curbH, 0.3);
        g.translate(OFFSET_X + totalW / 2, curbH / 2, z);
        curbGeos.push(g);
      }
    }
    for (let i = 0; i <= GRID_W; i++) {
      const xCenter = OFFSET_X + i * CELL - ROAD_WIDTH / 2;
      for (const side of [1, -1]) {
        const x = xCenter + side * (ROAD_WIDTH / 2 - 0.15);
        const g = new THREE.BoxGeometry(0.3, curbH, totalH + ROAD_WIDTH);
        g.translate(x, curbH / 2, OFFSET_Z + totalH / 2);
        curbGeos.push(g);
      }
    }
    if (curbGeos.length) {
      const curbs = new THREE.Mesh(mergeGeometries(curbGeos, false), curbMat);
      curbs.receiveShadow = true;
      this.group.add(curbs);
    }
  }

  // ----------------------------------------------------------- buildings
  _buildBuildings() {
    const buildingGeos = [];
    const buildingColors = [];
    const palette = [
      0x3a3d44, 0x4a4d54, 0x2e3036, 0x404349, 0x363a40,
      0x48484e, 0x3a3a3e, 0x50545a, 0x2a2d33
    ];

    for (let i = 0; i < GRID_W; i++) {
      for (let j = 0; j < GRID_H; j++) {
        const blockX = OFFSET_X + i * CELL + ROAD_WIDTH / 2;
        const blockZ = OFFSET_Z + j * CELL + ROAD_WIDTH / 2;
        // each block has 1-4 buildings
        const count = 1 + Math.floor(Math.random() * 4);
        for (let b = 0; b < count; b++) {
          const w = 8 + Math.random() * 18;
          const d = 8 + Math.random() * 18;
          const h = 6 + Math.random() * 40;
          const x = blockX + (Math.random() - 0.5) * (BLOCK_SIZE - w - 4);
          const z = blockZ + (Math.random() - 0.5) * (BLOCK_SIZE - d - 4);
          const geo = new THREE.BoxGeometry(w, h, d);
          geo.translate(x, h / 2, z);
          buildingGeos.push(geo);
          buildingColors.push(palette[Math.floor(Math.random() * palette.length)]);
        }
      }
    }

    // we can't easily merge boxes with different materials, so use one
    // InstancedMesh per building. Actually — merge into one geometry and
    // use vertex colors, OR just add each as a separate mesh. For perf,
    // merge into one geometry and use a single material with vertex colors.
    if (buildingGeos.length) {
      const merged = mergeGeometries(buildingGeos, true);
      // add vertex colors per building
      const colorAttr = new Float32Array(merged.attributes.position.count * 3);
      let offset = 0;
      for (let bi = 0; bi < buildingGeos.length; bi++) {
        const verts = buildingGeos[bi].attributes.position.count;
        const c = new THREE.Color(buildingColors[bi]);
        for (let v = 0; v < verts; v++) {
          colorAttr[(offset + v) * 3] = c.r;
          colorAttr[(offset + v) * 3 + 1] = c.g;
          colorAttr[(offset + v) * 3 + 2] = c.b;
        }
        offset += verts;
      }
      merged.setAttribute('color', new THREE.BufferAttribute(colorAttr, 3));
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.85, metalness: 0.1,
        map: this.texBuilding
      });
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  // ----------------------------------------------------------- guardrails
  _buildGuardrails() {
    // guardrails along the road edges on top of the curbs — metal barriers
    const railGeos = [];
    const railMat = new THREE.MeshStandardMaterial({
      color: 0x8a9098, roughness: 0.5, metalness: 0.7
    });
    const railH = 0.6;
    const totalW = GRID_W * CELL;
    const totalH = GRID_H * CELL;

    for (let j = 0; j <= GRID_H; j++) {
      const zCenter = OFFSET_Z + j * CELL - ROAD_WIDTH / 2;
      for (const side of [1, -1]) {
        const z = zCenter + side * (ROAD_WIDTH / 2 + 0.15);
        // top rail
        const g = new THREE.BoxGeometry(totalW + ROAD_WIDTH, 0.08, 0.05);
        g.translate(OFFSET_X + totalW / 2, railH, z);
        railGeos.push(g);
        // mid rail
        const g2 = new THREE.BoxGeometry(totalW + ROAD_WIDTH, 0.08, 0.05);
        g2.translate(OFFSET_X + totalW / 2, railH * 0.55, z);
        railGeos.push(g2);
        // posts every 8m
        for (let x = OFFSET_X; x < OFFSET_X + totalW; x += 8) {
          const p = new THREE.BoxGeometry(0.06, railH, 0.06);
          p.translate(x + 4, railH / 2, z);
          railGeos.push(p);
        }
      }
    }
    for (let i = 0; i <= GRID_W; i++) {
      const xCenter = OFFSET_X + i * CELL - ROAD_WIDTH / 2;
      for (const side of [1, -1]) {
        const x = xCenter + side * (ROAD_WIDTH / 2 + 0.15);
        const g = new THREE.BoxGeometry(0.05, 0.08, totalH + ROAD_WIDTH);
        g.translate(x, railH, OFFSET_Z + totalH / 2);
        railGeos.push(g);
        const g2 = new THREE.BoxGeometry(0.05, 0.08, totalH + ROAD_WIDTH);
        g2.translate(x, railH * 0.55, OFFSET_Z + totalH / 2);
        railGeos.push(g2);
        for (let z = OFFSET_Z; z < OFFSET_Z + totalH; z += 8) {
          const p = new THREE.BoxGeometry(0.06, railH, 0.06);
          p.translate(x, railH / 2, z + 4);
          railGeos.push(p);
        }
      }
    }
    if (railGeos.length) {
      const rails = new THREE.Mesh(mergeGeometries(railGeos, false), railMat);
      rails.castShadow = true;
      this.group.add(rails);
    }
  }

  // ----------------------------------------------------------- streetlights
  _buildStreetlights() {
    // streetlights at each intersection corner
    const positions = [];
    for (let i = 0; i <= GRID_W; i++) {
      for (let j = 0; j <= GRID_H; j++) {
        const x = OFFSET_X + i * CELL - ROAD_WIDTH / 2;
        const z = OFFSET_Z + j * CELL - ROAD_WIDTH / 2;
        for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          positions.push([
            x + dx * (ROAD_WIDTH / 2 + 0.5),
            z + dz * (ROAD_WIDTH / 2 + 0.5)
          ]);
        }
      }
    }

    // pole + arm + lamp head as instanced meshes (3 InstancedMeshes)
    const poleGeo = new THREE.CylinderGeometry(0.08, 0.1, 7, 8);
    const armGeo = new THREE.BoxGeometry(1.2, 0.06, 0.06);
    armGeo.translate(0.6, 0, 0);
    const headGeo = new THREE.BoxGeometry(0.4, 0.1, 0.25);

    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x2a2d33, roughness: 0.6, metalness: 0.7
    });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xfff4d0, emissive: 0xffe9a8, emissiveIntensity: 1.5,
      roughness: 0.4
    });

    const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, positions.length);
    const armMesh = new THREE.InstancedMesh(armGeo, poleMat, positions.length);
    const headMesh = new THREE.InstancedMesh(headGeo, headMat, positions.length);

    const dummy = new THREE.Object3D();
    positions.forEach(([x, z], i) => {
      // pole
      dummy.position.set(x, 3.5, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      poleMesh.setMatrixAt(i, dummy.matrix);
      // arm — points toward the road center
      const towardCenterX = (OFFSET_X + GRID_W * CELL / 2) - x;
      const towardCenterZ = (OFFSET_Z + GRID_H * CELL / 2) - z;
      const ang = Math.atan2(towardCenterX, towardCenterZ);
      dummy.position.set(x, 7, z);
      dummy.rotation.set(0, ang, 0);
      dummy.updateMatrix();
      armMesh.setMatrixAt(i, dummy.matrix);
      // head
      dummy.position.set(x + Math.sin(ang) * 1.2, 6.95, z + Math.cos(ang) * 1.2);
      dummy.rotation.set(0, ang, 0);
      dummy.updateMatrix();
      headMesh.setMatrixAt(i, dummy.matrix);
    });
    poleMesh.castShadow = true;
    poleMesh.instanceMatrix.needsUpdate = true;
    armMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
    this.group.add(poleMesh, armMesh, headMesh);
  }

  // ----------------------------------------------------------- intersections
  _buildIntersections() {
    // crosswalk stripes at each intersection
    const stripeGeos = [];
    const stripeMat = new THREE.MeshBasicMaterial({
      color: 0xe8ecf0, toneMapped: false
    });
    for (let i = 0; i <= GRID_W; i++) {
      for (let j = 0; j <= GRID_H; j++) {
        const x = OFFSET_X + i * CELL - ROAD_WIDTH / 2;
        const z = OFFSET_Z + j * CELL - ROAD_WIDTH / 2;
        // 4 crosswalks (one per road approach)
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          for (let s = 0; s < 5; s++) {
            const off = (s - 2) * 0.5;
            let g;
            if (dx !== 0) {
              g = new THREE.BoxGeometry(0.3, 0.02, 1.2);
              g.translate(x + dx * (ROAD_WIDTH / 2 - 0.5), 0.02, z + off * 1.4);
            } else {
              g = new THREE.BoxGeometry(1.2, 0.02, 0.3);
              g.translate(x + off * 1.4, 0.02, z + dz * (ROAD_WIDTH / 2 - 0.5));
            }
            stripeGeos.push(g);
          }
        }
      }
    }
    if (stripeGeos.length) {
      const stripes = new THREE.Mesh(mergeGeometries(stripeGeos, false), stripeMat);
      this.group.add(stripes);
    }
  }

  // ----------------------------------------------------------- skyline
  _buildSkyline() {
    // distant skyscrapers on the horizon for depth
    const geos = [];
    const colors = [];
    const palette = [0x2a2d33, 0x363a40, 0x1e2024];
    for (let i = 0; i < 40; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 400 + Math.random() * 200;
      const x = Math.cos(ang) * dist;
      const z = Math.sin(ang) * dist;
      const w = 20 + Math.random() * 40;
      const h = 80 + Math.random() * 120;
      const g = new THREE.BoxGeometry(w, h, w);
      g.translate(x, h / 2, z);
      geos.push(g);
      colors.push(palette[Math.floor(Math.random() * palette.length)]);
    }
    if (geos.length) {
      const merged = mergeGeometries(geos, true);
      const colorAttr = new Float32Array(merged.attributes.position.count * 3);
      let offset = 0;
      for (let bi = 0; bi < geos.length; bi++) {
        const verts = geos[bi].attributes.position.count;
        const c = new THREE.Color(colors[bi]);
        for (let v = 0; v < verts; v++) {
          colorAttr[(offset + v) * 3] = c.r;
          colorAttr[(offset + v) * 3 + 1] = c.g;
          colorAttr[(offset + v) * 3 + 2] = c.b;
        }
        offset += verts;
      }
      merged.setAttribute('color', new THREE.BufferAttribute(colorAttr, 3));
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.9, metalness: 0.05
      });
      const mesh = new THREE.Mesh(merged, mat);
      this.group.add(mesh);
    }
  }

  // ----------------------------------------------------------- surface API (physics)
  /** road height at world (x,z) — almost flat with tiny terrain rolling */
  surfaceAt(idx, lateral) {
    return { y: 0, slope: 0, bankSlope: 0 };
  }

  heightAtWorld(x, z) {
    return terrainH(x, z);
  }

  /** find the nearest road sample — for the city we just clamp to grid */
  locate(x, z, hintIdx = null) {
    // lateral = distance from the nearest road centerline
    // for the city, we compute lateral as the distance to the nearest
    // road center (either horizontal or vertical)
    const localX = x - OFFSET_X;
    const localZ = z - OFFSET_Z;
    const cellX = localX % CELL;
    const cellZ = localZ % CELL;
    // distance to nearest road centerline
    const distToVert = Math.abs(cellX - (CELL - ROAD_WIDTH / 2));
    const distToHoriz = Math.abs(cellZ - (CELL - ROAD_WIDTH / 2));
    const onVertRoad = distToVert < ROAD_WIDTH / 2;
    const onHorizRoad = distToHoriz < ROAD_WIDTH / 2;
    const lateral = onVertRoad ? distToVert : (onHorizRoad ? distToHoriz : Math.min(distToVert, distToHoriz));
    return {
      idx: 0, s: 0, lateral,
      rightX: 1, rightZ: 0, tanX: 0, tanZ: 1,
      curb: Math.abs(lateral) > ROAD_WIDTH / 2 - 0.4 && Math.abs(lateral) < ROAD_WIDTH / 2 + 1.5
    };
  }

  pointAt(s) {
    // return a point on the "start road" for spawn purposes
    return new THREE.Vector3(OFFSET_X + CELL / 2, 0, OFFSET_Z + CELL / 2);
  }

  tangentAt(s) {
    return new THREE.Vector3(0, 0, 1);
  }

  /** plain properties (not getters) — assignable in the constructor */
  get startS() { return this._startS; }
  set startS(v) { this._startS = v; }
  get totalLength() { return this._totalLength; }
  set totalLength(v) { this._totalLength = v; }

  /** not used in city mode but kept for compat */
  hideProceduralSurface() {}
  buildTrees() {}

  get curv() { return this._curv; }
  set curv(v) { this._curv = v; }
}
