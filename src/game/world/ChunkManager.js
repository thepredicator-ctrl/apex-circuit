/**
 * ChunkManager — streams the open world in 192 m chunks around the camera.
 *
 * Each chunk builds, fully deterministic from the seed:
 *   - road-carved terrain mesh (vertex-colored by biome)
 *   - road ribbons per texture kind (highway / rural / street / ramp),
 *     viaduct rails + pylons where roads fly, cut galleries + portals where
 *     mountains close over them
 *   - city buildings / warehouses / houses / landmarks / streetlamps / parks
 *   - dense biome-aware scenery (conifers, broadleafs, palms, cacti, bushes,
 *     rocks, grass, flowers, ferns)
 *   - mystery structures that only appear far from the origin
 *
 * Building is time-budgeted: a prioritized queue spends a few ms per frame
 * so streaming never hitches the car, and chunks that fall out of range are
 * fully disposed (geometry + instance buffers) — no leaks, no unbounded
 * memory.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD, ROAD, ROAD_INFO } from '../core/Constants.js';
import { mulberry32, hash2i, clamp } from '../core/Noise.js';

const CS = WORLD.chunkSize;
const Q = WORLD.terrainQuads;
const CELL = CS / Q;

export class ChunkManager {
  constructor(scene, world, quality) {
    this.scene = scene;
    this.world = world;                 // World facade (network, terrain, mystery, scenery)
    this.q = quality;
    this.chunks = new Map();            // "cx:cz" -> record
    this.queue = [];
    this._lastCenter = { cx: 1e9, cz: 1e9 };
    this.group = new THREE.Group();
    scene.add(this.group);

    this._tmpMat4 = new THREE.Matrix4();
    this._tmpPos = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
    this._tmpScale = new THREE.Vector3();
    this._tmpEuler = new THREE.Euler();
    this._tmpColor = new THREE.Color();
  }

  setQuality(q) {
    this.q = q;
  }

  // ==================================================================
  // streaming
  // ==================================================================

  update(px, pz, budgetMs = 5) {
    const ccx = Math.floor(px / CS);
    const ccz = Math.floor(pz / CS);

    if (ccx !== this._lastCenter.cx || ccz !== this._lastCenter.cz) {
      this._lastCenter = { cx: ccx, cz: ccz };
      this._rebuildQueue(ccx, ccz);
      this._disposeFar(ccx, ccz);
    }

    // time-budgeted building
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) {
      const job = this.queue.shift();
      const key = job.cx + ':' + job.cz;
      if (this.chunks.has(key)) continue;
      // skip jobs that drifted out of range while queued
      const dx = job.cx - ccx, dz = job.cz - ccz;
      if (dx * dx + dz * dz > (this.q.viewRadius + 1) * (this.q.viewRadius + 1)) continue;
      this.buildChunk(job.cx, job.cz);
    }
  }

  get pendingCount() { return this.queue.length; }

  _rebuildQueue(ccx, ccz) {
    this.queue.length = 0;
    const R = this.q.viewRadius;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > (R + 0.5) * (R + 0.5)) continue;      // circular view
        const cx = ccx + dx, cz = ccz + dz;
        if (!this.chunks.has(cx + ':' + cz)) {
          this.queue.push({ cx, cz, d2 });
        }
      }
    }
    this.queue.sort((a, b) => a.d2 - b.d2);
  }

  _disposeFar(ccx, ccz) {
    const R = this.q.viewRadius + 1.5;
    for (const [key, rec] of this.chunks) {
      const dx = rec.cx - ccx, dz = rec.cz - ccz;
      if (dx * dx + dz * dz > R * R) {
        this._disposeChunk(rec);
        this.chunks.delete(key);
      }
    }
  }

  /** synchronous initial ring so spawn is instant */
  prime(px, pz) {
    const ccx = Math.floor(px / CS);
    const ccz = Math.floor(pz / CS);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = (ccx + dx) + ':' + (ccz + dz);
        if (!this.chunks.has(key)) this.buildChunk(ccx + dx, ccz + dz);
      }
    }
    this._lastCenter = { cx: ccx, cz: ccz };
    this._rebuildQueue(ccx, ccz);
  }

  clear() {
    for (const rec of this.chunks.values()) this._disposeChunk(rec);
    this.chunks.clear();
    this.queue.length = 0;
    this._lastCenter = { cx: 1e9, cz: 1e9 };
  }

  _disposeChunk(rec) {
    this.group.remove(rec.group);
    rec.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      // materials are shared — never disposed here
    });
  }

  // ==================================================================
  // chunk construction
  // ==================================================================

  buildChunk(cx, cz) {
    const key = cx + ':' + cz;
    if (this.chunks.has(key)) return;
    const rec = { cx, cz, group: new THREE.Group() };
    this.chunks.set(key, rec);
    const x0 = cx * CS, z0 = cz * CS;

    this._buildTerrain(cx, cz, rec);
    this._buildRoads(x0, z0, rec);
    this._buildCity(x0, z0, rec);
    this._buildScatter(cx, cz, x0, z0, rec);
    this._buildMystery(cx, cz, x0, z0, rec);

    this.group.add(rec.group);
    return rec;
  }

  // ---------------------------------------------------------------- terrain
  _buildTerrain(cx, cz, rec) {
    const { network, terrain, mystery } = this.world;
    const x0 = cx * CS, z0 = cz * CS;
    const n = Q + 1;
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    const col = new Float32Array(n * n * 3);
    const rgb = [0, 0, 0];

    // heights first (shared by slope calc)
    const H = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      const z = z0 + j * CELL;
      for (let i = 0; i < n; i++) {
        const x = x0 + i * CELL;
        const g = network.groundAt(x, z);
        let y = g.y;
        // sink the terrain slightly below the road deck so the asphalt
        // ribbon always renders on top (no z-fighting, no grass-over-road)
        if (g.road && g.road.absPerp < g.road.halfWidth + 13) {
          const t = 1 - Math.min(1, Math.max(0,
            (g.road.absPerp - g.road.halfWidth) / 13));
          // never lower terrain below a bridge deck's air gap
          if (!(g.road.flags & 1)) y -= 0.10 * t;
        }
        H[j * n + i] = y;
      }
    }
    for (let j = 0; j < n; j++) {
      const z = z0 + j * CELL;
      for (let i = 0; i < n; i++) {
        const idx = (j * n + i) * 3;
        const x = x0 + i * CELL;
        const y = H[j * n + i];
        pos[idx] = x; pos[idx + 1] = y; pos[idx + 2] = z;
        uv[(j * n + i) * 2] = x * 0.09;
        uv[(j * n + i) * 2 + 1] = z * 0.09;
        // slope from neighbors
        const hx = H[j * n + Math.min(n - 1, i + 1)] - H[j * n + Math.max(0, i - 1)];
        const hz = H[Math.min(n - 1, j + 1) * n + i] - H[Math.max(0, j - 1) * n + i];
        const slope = Math.min(1, Math.hypot(hx, hz) / (2 * CELL) * 0.9);
        const w = mystery.intensity(x, z);
        terrain.colorAt(x, z, y, slope, w, rgb);
        const cidx = (j * n + i) * 3;
        col[cidx] = rgb[0]; col[cidx + 1] = rgb[1]; col[cidx + 2] = rgb[2];
      }
    }
    const index = [];
    for (let j = 0; j < Q; j++) {
      for (let i = 0; i < Q; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.world.scenery.matTerrain);
    mesh.receiveShadow = true;
    rec.group.add(mesh);
  }

  // ---------------------------------------------------------------- roads
  /** build one ribbon from centerline points; returns geometry */
  _ribbonGeo(pts, hw, texWorldLen, kind) {
    if (pts.length < 2) return null;
    const n = pts.length;
    const pos = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);
    const idx = [];
    let s = 0;
    for (let k = 0; k < n; k++) {
      const p = pts[k];
      if (k > 0) {
        s += Math.hypot(p.x - pts[k - 1].x, p.z - pts[k - 1].z);
      }
      const v = s / texWorldLen;
      // right of travel = (-tz, tx)
      const rx = -p.tz, rz = p.tx;
      pos[k * 6] = p.x - rx * hw; pos[k * 6 + 1] = p.y - 0.07; pos[k * 6 + 2] = p.z - rz * hw;
      pos[k * 6 + 3] = p.x + rx * hw; pos[k * 6 + 4] = p.y - 0.07; pos[k * 6 + 5] = p.z + rz * hw;
      uv[k * 4] = 0; uv[k * 4 + 1] = v;
      uv[k * 4 + 2] = 1; uv[k * 4 + 3] = v;
      if (k < n - 1) {
        const a = k * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  _buildRoads(x0, z0, rec) {
    const net = this.world.network;
    const M = 16;                       // margin so ribbons overlap chunk seams
    const minX = x0 - M, maxX = x0 + CS + M;
    const minZ = z0 - M, maxZ = z0 + CS + M;

    const geosByKind = new Map();       // texKind -> [geometry]
    const structParts = [];             // rails/pylons/arch geometries (vertex-colored)
    const bridgeInfo = [];              // for pylons

    const addRibbon = (pts, hw, kind, flagsFn) => {
      if (pts.length < 2) return;
      const geo = this._ribbonGeo(pts, hw, 13, kind);
      if (!geo) return;
      if (!geosByKind.has(kind)) geosByKind.set(kind, []);
      geosByKind.get(kind).push(geo);

      // ---- bridge / gallery structures from flags
      if (flagsFn) {
        for (let k = 0; k < pts.length; k++) {
          const f = flagsFn(k, pts[k]);
          if (f & 1) {
            // rails along bridge edges (sample spacing ≈ 6 m = rail length)
            const p = pts[k];
            const rx = -p.tz, rz = p.tx;
              for (const side of [-1, 1]) {
                const g = railGeoCache.clone();
                g.applyMatrix4(new THREE.Matrix4().compose(
                  new THREE.Vector3(p.x + rx * side * (hw + 0.4), p.y + 0.02, p.z + rz * side * (hw + 0.4)),
                  new THREE.Quaternion().setFromUnitVectors(
                    new THREE.Vector3(1, 0, 0),
                    new THREE.Vector3(p.tx, 0, p.tz).normalize()),
                  new THREE.Vector3(1, 1, 1)
                ));
                structParts.push(g);
              }
            // pylons every 24 m (at segment starts)
            const prev = k > 0 ? (flagsFn(k - 1, pts[k - 1]) & 1) : 0;
            if ((k % 4) === 0 && !prev) {
              const th = this.world.terrain.height(p.x, p.z);
              const drop = p.y - th - 0.4;
              if (drop > 2.5) {
                const g = pylonGeoCache.clone();
                g.applyMatrix4(new THREE.Matrix4().compose(
                  new THREE.Vector3(p.x, p.y - drop / 2 - 0.5, p.z),
                  new THREE.Quaternion().setFromUnitVectors(
                    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)),
                  new THREE.Vector3(1, drop, 1)
                ));
                structParts.push(g);
              }
            }
          } else if (f & 2) {
            // covered cut gallery: arch ceiling over the road
            const p = pts[k];
            const prev = k > 0 ? (flagsFn(k - 1, pts[k - 1]) & 2) : 0;
            if (!prev) {
              // portal at gallery entrance
              const pg = portalGeoCache.clone();
              pg.applyMatrix4(new THREE.Matrix4().compose(
                new THREE.Vector3(p.x, p.y - 0.1, p.z),
                new THREE.Quaternion().setFromUnitVectors(
                  new THREE.Vector3(1, 0, 0),
                  new THREE.Vector3(p.tx, 0, p.tz).normalize()),
                new THREE.Vector3(1, 1, 1)
              ));
              structParts.push(pg);
            }
            const g = archGeoCache.clone();
            g.applyMatrix4(new THREE.Matrix4().compose(
              new THREE.Vector3(p.x, p.y - 0.1, p.z),
              new THREE.Quaternion().setFromUnitVectors(
                new THREE.Vector3(1, 0, 0),
                new THREE.Vector3(p.tx, 0, p.tz).normalize()),
              new THREE.Vector3(1, 1, 1)
            ));
            structParts.push(g);
          }
        }
      }
    };

    // ---- main lattice routes
    const routes = net.routesNearAABB(minX, minZ, maxX, maxZ);
    for (const r of routes) {
      if (r.kind === 'row' || r.kind === 'col') {
        const along = r.kind === 'row' ? [minX, maxX] : [minZ, maxZ];
        const acrossMid = r.kind === 'row'
          ? net.coordAt(r, (minX + maxX) / 2)
          : net.coordAt(r, (minZ + maxZ) / 2);
        const midA = r.kind === 'row' ? (minZ + maxZ) / 2 : (minX + maxX) / 2;
        if (Math.abs(acrossMid - midA) > CS / 2 + r.halfWidth + 40) continue;
        const pts = net.sampleRange(r, along[0], along[1], WORLD.roadSampleSpacing);
        const kind = r.type === ROAD.HIGHWAY ? 'highway' : 'rural';
        // collect flags alongside
        const flagsArr = pts.map((p) => net.elevAt(r, p.u).flags);
        addRibbon(pts, r.halfWidth, kind, (k) => flagsArr[k]);
      } else if (r.kind === 'ring') {
        this._buildRing(r, minX, minZ, maxX, maxZ, addRibbon);
      } else if (r.kind === 'street') {
        this._buildStreet(r, minX, minZ, maxX, maxZ, addRibbon);
      }
    }

    // ---- interchange ramps
    const crossings = net.crossingsNearAABB(minX, minZ, maxX, maxZ);
    for (const c of crossings) {
      for (const rp of net.rampsFor(c.rowJ, c.colI)) {
        const pts = [];
        const N = 10;
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          const x = rp.x1 + (rp.x2 - rp.x1) * t;
          const z = rp.z1 + (rp.z2 - rp.z1) * t;
          const dx = rp.x2 - rp.x1, dz = rp.z2 - rp.z1;
          const nl = Math.hypot(dx, dz);
          pts.push({ x, y: rp.y1 + (rp.y2 - rp.y1) * t, z, tx: dx / nl, tz: dz / nl });
        }
        addRibbon(pts, rp.hw, 'ramp', null);
      }
    }

    // ---- merge ribbons per kind
    for (const [kind, list] of geosByKind) {
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      const mat = this.world.scenery.roadMats[kind] || this.world.scenery.roadMats.rural;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.receiveShadow = true;
      rec.group.add(mesh);
    }

    // ---- merge structure parts
    if (structParts.length) {
      const merged = mergeGeometries(
        structParts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
      const mesh = new THREE.Mesh(merged, this.world.scenery.matStructure);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      rec.group.add(mesh);
    }
  }

  _buildRing(ring, minX, minZ, maxX, maxZ, addRibbon) {
    const city = ring.city;
    const net = this.world.network;
    const cx = city.x, cz = city.z;
    const R = city.ringR * 1.35;
    // angular span of chunk
    const corners = [
      [minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ]
    ];
    let thMin = Infinity, thMax = -Infinity;
    for (const [x, z] of corners) {
      const d = Math.hypot(x - cx, z - cz);
      if (d > R + 60) continue;
      let th = Math.atan2(z - cz, x - cx);
      thMin = Math.min(thMin, th);
      thMax = Math.max(thMax, th);
    }
    if (thMin === Infinity) return;
    if (thMax - thMin < 0.1) return;
    const arcStep = 2.5 / city.ringR;
    const pts = [];
    for (let th = thMin - arcStep; th <= thMax + arcStep; th += arcStep) {
      const r = this.world.cities.ringRadiusAt(city, th);
      const x = cx + Math.cos(th) * r;
      const z = cz + Math.sin(th) * r;
      if (x < minX - 10 || x > maxX + 10 || z < minZ - 10 || z > maxZ + 10) continue;
      const e = this.world.cities._ringElevation(city);
      const N = 512;
      const fi = ((th / (Math.PI * 2)) * N + N) % N;
      const i0 = Math.floor(fi) % N, i1 = (i0 + 1) % N;
      const y = e[i0] + (e[i1] - e[i0]) * (fi - Math.floor(fi));
      const tx = -Math.sin(th), tz = Math.cos(th);
      pts.push({ x, y: y - 0.02, z, tx, tz });
    }
    if (pts.length > 1) addRibbon(pts, 5.6, 'rural', null);
  }

  _buildStreet(st, minX, minZ, maxX, maxZ, addRibbon) {
    const cities = this.world.cities;
    const city = st.city;
    // chunk corners in city frame -> along-axis range
    const ca = Math.cos(-city.angle), sa = Math.sin(-city.angle);
    let uMin = Infinity, uMax = -Infinity;
    for (const [x, z] of [[minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ]]) {
      const dx = x - city.x, dz = z - city.z;
      const lx = dx * ca - dz * sa;
      const lz = dx * sa + dz * ca;
      const u = st.axis === 'row' ? lx : lz;
      const across = st.axis === 'row' ? lz : lx;
      if (Math.abs(across - st.coord) > st.halfWidth + 10) continue;
      uMin = Math.min(uMin, u);
      uMax = Math.max(uMax, u);
    }
    if (uMin === Infinity) return;
    uMin -= 8; uMax += 8;
    const pts = [];
    for (let u = uMin; u <= uMax; u += 4) {
      const p = cities.streetPoint(city, st, u);
      const y = cities.streetY(city, st, u);
      let tx, tz;
      if (st.axis === 'row') { tx = Math.cos(city.angle); tz = Math.sin(city.angle); }
      else { tx = Math.sin(city.angle); tz = Math.cos(city.angle); }
      pts.push({ x: p.x, y: y - 0.05, z: p.z, tx, tz });
    }
    if (pts.length > 1) addRibbon(pts, st.halfWidth, 'street', null);
  }

  // ---------------------------------------------------------------- city
  _buildCity(x0, z0, rec) {
    const cities = this.world.cities;
    const scenery = this.world.scenery;
    const minX = x0 - 20, maxX = x0 + CS + 20;
    const minZ = z0 - 20, maxZ = z0 + CS + 20;

    const nearCities = cities.near((x0 + CS / 2), (z0 + CS / 2), CS + 1100);
    const buildings = [];
    const warehouses = [];
    const houses = [];
    const parks = [];
    const lots = [];
    const lamps = [];

    for (const city of nearCities) {
      const list = cities.buildingsIn(city);
      for (const b of list) {
        if (b.x < minX || b.x > maxX || b.z < minZ || b.z > maxZ) continue;
        if (b.kind === 0) buildings.push(b);
        else if (b.kind === 1) buildings.push(b);
        else if (b.kind === 2) warehouses.push(b);
        else if (b.kind === 3) houses.push(b);
        else if (b.kind === 4) lots.push(b);
        else if (b.kind === 5) parks.push(b);
        else if (b.kind === 6) this._buildLandmarkTower(b, rec);
        else if (b.kind === 7) this._buildRadioMast(b, rec);
      }
      for (const l of cities.lampsIn(city)) {
        if (l.x >= minX && l.x <= maxX && l.z >= minZ && l.z <= maxZ) lamps.push(l);
      }
    }

    const mkInstanced = (geo, mat, list, yScaleFromH, colorFn, cast) => {
      if (!list.length) return null;
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      mesh.castShadow = !!cast;
      mesh.receiveShadow = true;
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        this._tmpEuler.set(0, b.rot, 0);
        this._tmpQuat.setFromEuler(this._tmpEuler);
        this._tmpPos.set(b.x, b.y - 0.15, b.z);
        this._tmpScale.set(b.w, yScaleFromH ? b.h : 1, b.d);
        this._tmpMat4.compose(this._tmpPos, this._tmpQuat, this._tmpScale);
        mesh.setMatrixAt(i, this._tmpMat4);
        if (colorFn) {
          this._tmpColor.setHex(b.color);
          mesh.setColorAt(i, this._tmpColor);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      rec.group.add(mesh);
      return mesh;
    };

    mkInstanced(scenery.buildingGeo, scenery.matBuilding, buildings, true, true, true);
    mkInstanced(scenery.warehouseGeo, scenery.matWarehouse, warehouses, true, true, true);
    mkInstanced(scenery.buildingRoofGeo, scenery.matRoof, buildings.concat(houses), false, false, false);
    // houses use the facade too
    mkInstanced(scenery.buildingGeo, scenery.matBuilding, houses, true, true, true);
    // parking lots: flat dark slabs
    mkInstanced(scenery.buildingGeo, scenery.matParking, lots, true, false, false);
    // pocket parks: trees
    for (const p of parks) {
      const rng = mulberry32(Math.round(p.x * 31 + p.z * 57));
      const geo = scenery.broadleafGeo;
      const mesh = new THREE.InstancedMesh(geo, scenery.matTree, 7);
      for (let i = 0; i < 7; i++) {
        const px = p.x + (rng() - 0.5) * p.w;
        const pz = p.z + (rng() - 0.5) * p.d;
        const y = this.world.network.groundAt(px, pz).y;
        this._tmpEuler.set(0, rng() * Math.PI * 2, 0);
        this._tmpQuat.setFromEuler(this._tmpEuler);
        this._tmpPos.set(px, y - 0.1, pz);
        const s = 0.9 + rng() * 0.7;
        this._tmpScale.set(s, s, s);
        this._tmpMat4.compose(this._tmpPos, this._tmpQuat, this._tmpScale);
        mesh.setMatrixAt(i, this._tmpMat4);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      rec.group.add(mesh);
    }
    // street lamps + glow
    if (lamps.length) {
      const mesh = new THREE.InstancedMesh(scenery.lampGeo, scenery.matLamp, lamps.length);
      const glow = new THREE.InstancedMesh(scenery.lampGlowGeo, scenery.matLampGlow, lamps.length);
      lamps.forEach((l, i) => {
        this._tmpQuat.setFromEuler(this._tmpEuler.set(0, 0, 0));
        this._tmpPos.set(l.x, l.y, l.z);
        this._tmpScale.set(1, 1, 1);
        this._tmpMat4.compose(this._tmpPos, this._tmpQuat, this._tmpScale);
        mesh.setMatrixAt(i, this._tmpMat4);
        glow.setMatrixAt(i, this._tmpMat4);
      });
      mesh.instanceMatrix.needsUpdate = true;
      glow.instanceMatrix.needsUpdate = true;
      rec.group.add(mesh, glow);
    }
  }

  _buildLandmarkTower(b, rec) {
    const g = new THREE.Group();
    const mat = this.world.scenery.matTower;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(b.w * 0.55, b.w * 0.7, b.h * 0.72, 10), mat);
    base.position.y = b.h * 0.36;
    const mid = new THREE.Mesh(new THREE.CylinderGeometry(b.w * 0.3, b.w * 0.55, b.h * 0.22, 10), mat);
    mid.position.y = b.h * 0.82;
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.4, b.w * 0.3, b.h * 0.1, 8), mat);
    spire.position.y = b.h * 0.98;
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 8, 6),
      this.world.scenery.matLampGlow
    );
    light.position.y = b.h * 1.04;
    base.castShadow = mid.castShadow = spire.castShadow = true;
    g.add(base, mid, spire, light);
    g.position.set(b.x, b.y, b.z);
    rec.group.add(g);
  }

  _buildRadioMast(b, rec) {
    const g = new THREE.Group();
    const mat = this.world.scenery.matLamp;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.9, b.h, 6), mat);
    mast.position.y = b.h / 2;
    mast.castShadow = true;
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 8, 6),
      this.world.scenery.matBeacon
    );
    beacon.position.y = b.h + 0.4;
    g.add(mast, beacon);
    g.position.set(b.x, b.y, b.z);
    rec.group.add(g);
  }

  // ---------------------------------------------------------------- scatter
  _buildScatter(cx, cz, x0, z0, rec) {
    const { network, terrain, mystery, scenery, cities } = this.world;
    const q = this.q;
    const rng = mulberry32((this.world.seed ^ (cx * 2654435761) ^ (cz * 40503)) >>> 0);
    const sDet = this.world.seed ^ 0x5ca7;

    const buckets = new Map();   // geoKey -> { geo, mat, items: [] }
    const push = (geoKey, geo, mat, x, y, z, s, ry, tilt = 0, color = null) => {
      if (!buckets.has(geoKey)) buckets.set(geoKey, { geo, mat, items: [] });
      buckets.get(geoKey).items.push([x, y, z, s, ry, tilt, color]);
    };

    const tryPos = () => ({
      x: x0 + rng() * CS,
      z: z0 + rng() * CS
    });
    const okForScatter = (x, z) => {
      const g = network.groundAt(x, z);
      if (g.y < WORLD.waterLevel + 0.3) return null;
      if (g.road && g.road.absPerp < g.road.halfWidth + 3.5) return null;
      return g;
    };

    // determine biome mix by sampling
    const samples = [];
    for (let i = 0; i < 9; i++) {
      const x = x0 + (i % 3) * CS * 0.5 + CS * 0.25;
      const z = z0 + Math.floor(i / 3) * CS * 0.5 + CS * 0.25;
      samples.push(terrain.biome(x, z));
    }
    const forest = samples.filter((b) => b === 3).length;
    const desert = samples.filter((b) => b === 4).length;
    const mountain = samples.filter((b) => b >= 5).length;
    const beach = samples.filter((b) => b === 1).length;
    const w = mystery.intensity(x0 + CS / 2, z0 + CS / 2);

    // no scatter inside city cores
    const nearCity = cities.near(x0 + CS / 2, z0 + CS / 2, CS);
    let inCity = 0;
    for (const c of nearCity) {
      const d = Math.hypot(c.x - (x0 + CS / 2), c.z - (z0 + CS / 2));
      if (d < c.radius + 60) inCity = Math.max(inCity, 1 - Math.max(0, (d - c.radius) / 160));
    }

    // ---- trees ----
    const treeCount = Math.round(
      (forest / 9) * 60 + (mountain / 9) * 10 + (beach / 9) * 4 + (1 - inCity) * 6
    );
    for (let i = 0; i < treeCount; i++) {
      const p = tryPos();
      const g = okForScatter(p.x, p.z);
      if (!g) continue;
      if (rng() < inCity * 0.85) continue;
      const biome = terrain.biome(p.x, p.z, g.y);
      const ry = rng() * Math.PI * 2;
      const s = 0.7 + rng() * 0.9;
      const y = g.y - 0.15;
      if (biome === 3 || biome === 5 || biome === 6) {
        if (w > 0.35 && rng() < w * 0.45) push('dead', scenery.deadTreeGeo, scenery.matTree, p.x, y, p.z, s * 1.2, ry, 0);
        else push('conifer', scenery.coniferGeo, scenery.matTree, p.x, y, p.z, s, ry, (rng() - 0.5) * 0.05);
      } else if (biome === 1) {
        push('palm', scenery.palmGeo, scenery.matTree, p.x, y, p.z, 0.8 + rng() * 0.5, ry);
      } else if (biome === 4) {
        push('cactus', scenery.cactusGeo, scenery.matTree, p.x, y, p.z, 0.7 + rng() * 0.6, ry);
      } else if (biome === 2 && rng() < 0.4) {
        push('broad', scenery.broadleafGeo, scenery.matTree, p.x, y, p.z, s, ry);
      }
    }

    // ---- bushes / rocks ----
    const bushCount = 26;
    for (let i = 0; i < bushCount; i++) {
      const p = tryPos();
      const g = okForScatter(p.x, p.z);
      if (!g) continue;
      push('bush', scenery.bushGeo, scenery.matTree, p.x, g.y - 0.08, p.z, 0.5 + rng() * 1.1, rng() * Math.PI * 2);
    }
    const rockCount = 9;
    for (let i = 0; i < rockCount; i++) {
      const p = tryPos();
      const g = okForScatter(p.x, p.z);
      if (!g) continue;
      push('rock', scenery.rockGeo, scenery.matTree, p.x, g.y - 0.1, p.z, 0.4 + rng() * 1.4, rng() * Math.PI * 2);
    }

    // ---- grass + flowers (near field only) ----
    const dcx = Math.abs(cx - this._lastCenter.cx);
    const dcz = Math.abs(cz - this._lastCenter.cz);
    if (Math.max(dcx, dcz) <= q.grassRadius) {
      const grassCount = 130;
      for (let i = 0; i < grassCount; i++) {
        const p = tryPos();
        const g = okForScatter(p.x, p.z);
        if (!g) continue;
        push('grass', scenery.grassGeo, scenery.matTree, p.x, g.y - 0.04, p.z, 0.6 + rng() * 1.1, rng() * Math.PI * 2);
      }
    }
    if (Math.max(dcx, dcz) <= q.detailRadius && desert < 5 && forest < 6) {
      const FLOWER_TINTS = [
        [0.98, 0.96, 0.82], [0.99, 0.82, 0.18], [0.92, 0.28, 0.22],
        [0.62, 0.42, 0.92], [0.32, 0.55, 0.95], [0.98, 0.62, 0.16]
      ];
      const flowerCount = 55;
      for (let i = 0; i < flowerCount; i++) {
        const p = tryPos();
        const g = okForScatter(p.x, p.z);
        if (!g) continue;
        const tint = FLOWER_TINTS[Math.floor(rng() * FLOWER_TINTS.length)];
        push('flower', scenery.flowerGeo, scenery.matTree, p.x, g.y - 0.02, p.z, 0.8 + rng() * 0.9, rng() * Math.PI * 2, 0, tint);
      }
      if (forest >= 5) {
        for (let i = 0; i < 40; i++) {
          const p = tryPos();
          const g = okForScatter(p.x, p.z);
          if (!g) continue;
          push('fern', scenery.fernGeo, scenery.matTree, p.x, g.y - 0.02, p.z, 0.7 + rng() * 1.2, rng() * Math.PI * 2);
        }
      }
    }

    // ---- reflector posts along highways ----
    // cheap: sample along highway rows/cols crossing this chunk
    const routes = this.world.network.routesNearAABB(x0 - 8, z0 - 8, x0 + CS + 8, z0 + CS + 8);
    for (const r of routes) {
      if (r.type !== ROAD.HIGHWAY) continue;
      if (r.kind !== 'row' && r.kind !== 'col') continue;
      const along = r.kind === 'row' ? [x0, x0 + CS] : [z0, z0 + CS];
      const acrossMid = r.kind === 'row'
        ? this.world.network.coordAt(r, x0 + CS / 2)
        : this.world.network.coordAt(r, z0 + CS / 2);
      const midA = r.kind === 'row' ? z0 + CS / 2 : x0 + CS / 2;
      if (Math.abs(acrossMid - midA) > CS / 2 + r.halfWidth + 30) continue;
      for (let u = Math.ceil(along[0] / 32) * 32; u < along[1]; u += 32) {
        const s = this.world.network.sampleAt(r, u);
        const rx = -s.tz, rz = s.tx;
        for (const side of [-1, 1]) {
          const px = s.x + rx * side * (r.halfWidth + 0.9);
          const pz = s.z + rz * side * (r.halfWidth + 0.9);
          const g = this.world.network.groundAt(px, pz);
          push('post', this.world.scenery.postGeo, this.world.scenery.matPost, px, g.y, pz, 1, Math.atan2(s.tx, s.tz));
        }
      }
    }

    // ---- instantiate buckets ----
    for (const [key, bucket] of buckets) {
      const n = bucket.items.length;
      if (!n) continue;
      const mesh = new THREE.InstancedMesh(bucket.geo, bucket.mat, n);
      const cast = key === 'conifer' || key === 'broad' || key === 'palm' || key === 'dead';
      mesh.castShadow = cast;
      for (let i = 0; i < n; i++) {
        const [x, y, z, s, ry, tilt, color] = bucket.items[i];
        this._tmpEuler.set(tilt, ry, tilt * 0.7);
        this._tmpQuat.setFromEuler(this._tmpEuler);
        this._tmpPos.set(x, y, z);
        this._tmpScale.set(s, s, s);
        this._tmpMat4.compose(this._tmpPos, this._tmpQuat, this._tmpScale);
        mesh.setMatrixAt(i, this._tmpMat4);
        if (color) {
          this._tmpColor.setRGB(color[0], color[1], color[2]);
          mesh.setColorAt(i, this._tmpColor);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      rec.group.add(mesh);
    }
  }

  // ---------------------------------------------------------------- mystery
  _buildMystery(cx, cz, x0, z0, rec) {
    const structure = this.world.mystery.structureForChunk(cx, cz);
    if (!structure) return;
    const g = this.world.mystery.buildStructure(structure, this.world.scenery);
    if (g) rec.group.add(g);
  }
}

// pre-transformed template geometries for bridge / gallery structures
let railGeoCache, pylonGeoCache, archGeoCache, portalGeoCache;
{
  const railPost1 = new THREE.BoxGeometry(0.08, 0.75, 0.08);
  railPost1.translate(-3.0, 0.375, 0);
  const railPost2 = new THREE.BoxGeometry(0.08, 0.75, 0.08);
  railPost2.translate(3.0, 0.375, 0);
  const railBeam = new THREE.BoxGeometry(6.4, 0.3, 0.05);
  railBeam.translate(0, 0.62, 0);
  railGeoCache = mergeGeometries([railPost1, railPost2, railBeam], false);

  const py = new THREE.BoxGeometry(2.4, 1, 1.8);
  py.translate(0, 0.5, 0);
  pylonGeoCache = py;

  // gallery arch: half-tube of segments spanning ~30 m of road
  const archParts = [];
  const SEGS = 14;
  for (let i = 0; i < SEGS; i++) {
    const a0 = Math.PI * (i / SEGS);
    const a1 = Math.PI * ((i + 1) / SEGS);
    const w = 13.5;
    const h = 5.6;
    const x0 = -Math.cos(a0) * w, y0 = Math.sin(a0) * h;
    const x1 = -Math.cos(a1) * w, y1 = Math.sin(a1) * h;
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([
      x0, y0, 0, x0, y0, 1.4, x1, y1, 0,
      x1, y1, 0, x0, y0, 1.4, x1, y1, 1.4
    ], 3));
    quad.setAttribute('uv', new THREE.Float32BufferAttribute([
      0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1
    ], 2));
    quad.computeVertexNormals();
    archParts.push(quad);
  }
  archGeoCache = mergeGeometries(archParts, false);

  // portal: two legs + lintel
  const leg1 = new THREE.BoxGeometry(1.4, 7.2, 2.2);
  leg1.translate(-14.4, 3.6, 0);
  const leg2 = new THREE.BoxGeometry(1.4, 7.2, 2.2);
  leg2.translate(14.4, 3.6, 0);
  const lintel = new THREE.BoxGeometry(30.4, 1.6, 2.4);
  lintel.translate(0, 7.0, 0);
  portalGeoCache = mergeGeometries([leg1, leg2, lintel], false);
}
