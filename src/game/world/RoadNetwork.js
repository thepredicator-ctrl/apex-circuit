/**
 * RoadNetwork — a world-scale, deterministic road graph.
 *
 * Roads are ANALYTIC function-shaped routes on seeded lattices, so they are
 * perfectly coherent across chunks and infinite in extent:
 *
 *   row route j:  position(x) = (x, base_j + meander(x))
 *   col route i:  position(z) = (base_i + meander(z), z)
 *
 * Elevation is engineered like real road design: a segment-cached marcher
 * follows the low-frequency terrain with a 7.5% grade limiter, never dips
 * below water+clearance (causeways/bridges over rivers & lakes), and climbs
 * actual mountains at realistic gradients.
 *
 * Highway × highway crossings become grade-separated interchanges with four
 * straight diamond ramps; the lower route passes under, the upper gets a
 * local hump. Where the road floats above terrain, chunk builders add
 * viaduct pylons + rails; where terrain walls the road in, covered cut
 * galleries with portals (tunnel-style) are generated.
 *
 * Cities (Cities.js) contribute street grids + ring roads to the same query
 * interface, so terrain carving, physics, traffic and the minimap all share
 * ONE source of truth for "where are the roads".
 */

import * as THREE from 'three';
import { vnoise1, hash2i, mulberry32, clamp, lerp, smoothstep } from '../core/Noise.js';
import { WORLD, ROAD } from '../core/Constants.js';
import { Terrain } from './Terrain.js';
import { Cities } from './Cities.js';

const SS = WORLD.roadSampleSpacing;          // 6 m
const SEG = WORLD.segmentLength;             // 1536 m
const SEG_SAMPLES = Math.ceil(SEG / SS);     // 256

export class RoadNetwork {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.terrain = new Terrain(seed);
    this.cities = new Cities(seed, this.terrain, this);

    this._segCache = new Map();        // "r:id:seg" -> { y: Float32Array, flags: Uint8Array }
    this._segOrder = [];               // LRU
    this._crossingCache = new Map();   // "j:i" -> crossing record
    this._rampCache = new Map();

    // route definitions are derived analytically — build the param tables
    this._makeRoutes();
  }

  // =====================================================================
  // route lattice
  // =====================================================================

  _makeRoutes() {
    const s = this.seed;
    this.rows = new Map();   // j -> route
    this.cols = new Map();
    const HS = WORLD.highwaySpacing;
    const AS = WORLD.avenueSpacing;
    // highways: every highwaySpacing on both axes
    // avenues: skip cells with a noise mask (~55% exist) for variety
    for (let j = -64; j <= 64; j++) {
      this.rows.set(j, this._defRoute('row', ROAD.HIGHWAY, j, j * HS, s ^ 0xa1));
      this.cols.set(j, this._defRoute('col', ROAD.HIGHWAY, j, j * HS, s ^ 0xb2));
    }
    for (let j = -160; j <= 160; j++) {
      if (hash2i(j, 17, s ^ 0xc3) < 0.52) continue;   // rural gaps
      if (((j % 3) + 3) % 3 === 0) continue;           // keep off highway lanes
      this.rows.set(1000 + j, this._defRoute('row', ROAD.AVENUE, j, j * AS, s ^ 0xd4));
      if (hash2i(j, 91, s ^ 0xe5) < 0.86) {
        this.cols.set(1000 + j, this._defRoute('col', ROAD.AVENUE, j, j * AS, s ^ 0xf6));
      }
    }
  }

  _defRoute(kind, type, index, base, seedMix) {
    const highway = type === ROAD.HIGHWAY;
    return {
      kind, type, index, base,
      id: kind[0] + type + ':' + index,
      halfWidth: highway ? WORLD.highwayHalfWidth
        : WORLD.avenueHalfWidth,
      amp1: highway ? 560 : 175,
      f1: highway ? 1 / 2500 : 1 / 1300,
      amp2: highway ? 90 : 32,
      f2: highway ? 1 / 340 : 1 / 250,
      s1: seedMix ^ 0x1111,
      s2: seedMix ^ 0x2222,
      sE: seedMix ^ 0x3333
    };
  }

  /** meander offset along the route axis */
  _meander(r, u) {
    return (vnoise1(u * r.f1, r.s1) * 2 - 1) * r.amp1
      + (vnoise1(u * r.f2, r.s2) * 2 - 1) * r.amp2;
  }

  /** centerline coordinate across the axis at param u */
  coordAt(r, u) { return r.base + this._meander(r, u); }

  /** derivative of meander (numeric) */
  _meanderD(r, u) {
    return (this._meander(r, u + 3) - this._meander(r, u - 3)) / 6;
  }

  /** world position at param u (x param for rows, z param for cols) */
  posAt(r, u, out) {
    const c = this.coordAt(r, u);
    if (r.kind === 'row') { out.x = u; out.z = c; }
    else { out.x = c; out.z = u; }
    return out;
  }

  // =====================================================================
  // elevation marching (grade-limited, cached segments)
  // =====================================================================

  _targetY(r, u) {
    const c = this.coordAt(r, u);
    const x = r.kind === 'row' ? u : c;
    const z = r.kind === 'row' ? c : u;
    const t = this.terrain.base(x, z);
    return Math.max(t, WORLD.waterLevel + WORLD.bridgeClearance);
  }

  _segKey(r, seg) { return r.id + ':' + seg; }

  _getSegment(r, seg) {
    const key = this._segKey(r, seg);
    let s = this._segCache.get(key);
    if (s) return s;
    s = this._marchSegment(r, seg);
    this._segCache.set(key, s);
    this._segOrder.push(key);
    // LRU cap: ~700 segments ≈ 1 M samples
    while (this._segOrder.length > 700) {
      const evict = this._segOrder.shift();
      if (evict !== key) this._segCache.delete(evict);
    }
    return s;
  }

  _marchSegment(r, seg) {
    const n = SEG_SAMPLES + 1;
    const y = new Float32Array(n);
    const flags = new Uint8Array(n);   // bit1 bridge, bit2 gallery
    const u0 = seg * SEG;
    // anchor: start from the nearest already-built neighbor or the route origin
    let startY;
    if (seg === 0) {
      startY = this._targetY(r, 0);
    } else {
      const prev = this._segCache.get(this._segKey(r, seg - 1));
      if (prev) startY = prev.y[SEG_SAMPLES];
      else {
        const next = this._segCache.get(this._segKey(r, seg + 1));
        startY = next ? next.y[0] : this._targetY(r, u0);
      }
    }
    y[0] = startY;
    const maxStep = WORLD.maxRoadGrade * SS;
    // march forward (or backward from the far end if only the next seg exists)
    const backwardOnly = seg !== 0 && !this._segCache.get(this._segKey(r, seg - 1)) && this._segCache.get(this._segKey(r, seg + 1));
    if (backwardOnly) {
      y[SEG_SAMPLES] = startY;
      for (let i = SEG_SAMPLES - 1; i >= 0; i--) {
        const u = u0 + i * SS;
        const t = this._targetY(r, u);
        const d = clamp(t - y[i + 1], -maxStep, maxStep);
        y[i] = y[i + 1] + d;
      }
    } else {
      for (let i = 1; i <= SEG_SAMPLES; i++) {
        const u = u0 + i * SS;
        const t = this._targetY(r, u);
        const d = clamp(t - y[i - 1], -maxStep, maxStep);
        y[i] = y[i - 1] + d;
      }
    }
    // bridge / gallery flags
    for (let i = 0; i <= SEG_SAMPLES; i++) {
      const u = u0 + i * SS;
      const c = this.coordAt(r, u);
      const x = r.kind === 'row' ? u : c;
      const z = r.kind === 'row' ? c : u;
      const th = this.terrain.height(x, z);
      const gap = y[i] - th;
      if (gap > WORLD.viaductTrigger) flags[i] |= 1;
      else if (th - y[i] > WORLD.cutGalleryTrigger) flags[i] |= 2;
    }
    return { y, flags, u0 };
  }

  /** elevation + flags at param u */
  elevAt(r, u) {
    const seg = Math.floor(u / SEG);
    const s = this._getSegment(r, seg);
    const f = (u - s.u0) / SS;
    const i = clamp(Math.floor(f), 0, SEG_SAMPLES - 1);
    const t = f - i;
    const y = lerp(s.y[i], s.y[i + 1], t);
    const fl = t < 0.5 ? s.flags[i] : s.flags[i + 1];
    return { y, flags: fl };
  }

  // =====================================================================
  // interchanges + ramps
  // =====================================================================

  /** highway crossing between row j and col i (deterministic, cached) */
  crossing(rowJ, colI) {
    const key = rowJ + ':' + colI;
    let c = this._crossingCache.get(key);
    if (c) return c;
    const row = this.rows.get(rowJ);
    const col = this.cols.get(colI);
    if (!row || !col) return null;
    // iterate the crossing point (contraction for gentle meanders)
    let z = row.base;
    let x = 0;
    for (let k = 0; k < 6; k++) {
      x = this.coordAt(col, z);
      z = this.coordAt(row, x);
    }
    const rowOver = ((rowJ + colI) & 1) === 0;
    const rowY = this.elevAt(row, x).y;
    const colY = this.elevAt(col, z).y;
    c = { x, z, row, col, rowY, colY, rowOver, rowJ, colI };
    this._crossingCache.set(key, c);
    return c;
  }

  /** the 4 diamond ramps of a crossing */
  rampsFor(rowJ, colI) {
    const key = 'r' + rowJ + ':' + colI;
    let rs = this._rampCache.get(key);
    if (rs) return rs;
    const c = this.crossing(rowJ, colI);
    if (!c) return [];
    rs = [];
    const OFF = 62;
    const row = c.row, col = c.col;
    for (let side = -1; side <= 1; side += 2) {
      for (let side2 = -1; side2 <= 1; side2 += 2) {
        const uRow = c.x + side * OFF;
        const zRow = this.coordAt(row, uRow);
        const yRow = this.elevAt(row, uRow).y;
        const vCol = c.z + side2 * OFF;
        const xCol = this.coordAt(col, vCol);
        const yCol = this.elevAt(col, vCol).y;
        rs.push({
          x1: uRow, z1: zRow, y1: yRow + 0.1,
          x2: xCol, z2: vCol, y2: yCol + 0.1,
          hw: 3.4, type: ROAD.RAMP
        });
      }
    }
    this._rampCache.set(key, rs);
    return rs;
  }

  /** upper-route hump so the over-pass clears the under-pass */
  _crossHump(r, u) {
    if (r.type !== ROAD.HIGHWAY) return 0;
    const CROSS = 95;
    const HS = WORLD.highwaySpacing;
    let hump = 0;
    if (r.kind === 'row') {
      // crossing cols near param u (= x)
      const iLo = Math.floor((u - 110) / HS), iHi = Math.ceil((u + 110) / HS);
      for (let i = iLo; i <= iHi; i++) {
        const col = this.cols.get(i);
        if (!col) continue;
        const c = this.crossing(r.index, i);
        if (!c || !c.rowOver) continue;
        const d = Math.abs(u - c.x);
        if (d > CROSS) continue;
        const need = c.colY + 6.2 - this.elevAt(r, u).y;
        if (need > 0) hump = Math.max(hump, need * smoothstep(CROSS, CROSS * 0.25, d));
      }
    } else {
      const jLo = Math.floor((u - 110) / HS), jHi = Math.ceil((u + 110) / HS);
      for (let j = jLo; j <= jHi; j++) {
        const row = this.rows.get(j);
        if (!row) continue;
        const c = this.crossing(j, r.index);
        if (!c || c.rowOver) continue;
        const d = Math.abs(u - c.z);
        if (d > CROSS) continue;
        const need = c.rowY + 6.2 - this.elevAt(r, u).y;
        if (need > 0) hump = Math.max(hump, need * smoothstep(CROSS, CROSS * 0.25, d));
      }
    }
    return hump;
  }

  // =====================================================================
  // queries
  // =====================================================================

  /**
   * Best road feature at (x, z).
   * Returns null if far from any road, else:
   * { type, route, s (param), lateral (signed, + = right of travel dir),
   *   absPerp, halfWidth, y, tx, tz, flags, ramp? }
   */
  query(x, z) {
    const HS = WORLD.highwaySpacing;
    const AS = WORLD.avenueSpacing;
    let best = null;

    const consider = (res) => {
      if (!res) return;
      if (!best || res.score < best.score) best = res;
    };

    // --- rows near z ---
    {
      const reach = 620;
      const lo = Math.floor((z - reach) / HS), hi = Math.ceil((z + reach) / HS);
      for (let j = lo; j <= hi; j++) consider(this._queryRowCol(this.rows.get(j), x, z));
      const lo2 = Math.floor((z - 260) / AS), hi2 = Math.ceil((z + 260) / AS);
      for (let j = lo2; j <= hi2; j++) consider(this._queryRowCol(this.rows.get(1000 + j), x, z));
    }
    // --- cols near x ---
    {
      const reach = 620;
      const lo = Math.floor((x - reach) / HS), hi = Math.ceil((x + reach) / HS);
      for (let i = lo; i <= hi; i++) consider(this._queryRowCol(this.cols.get(i), x, z));
      const lo2 = Math.floor((x - 260) / AS), hi2 = Math.ceil((x + 260) / AS);
      for (let i = lo2; i <= hi2; i++) consider(this._queryRowCol(this.cols.get(1000 + i), x, z));
    }
    // --- rings + streets via cities ---
    const nearCities = this.cities.near(x, z, 1150);
    for (const city of nearCities) {
      consider(this.cities.ringQuery(city, x, z));
      consider(this.cities.streetQueryBest(city, x, z));
    }
    // --- ramps near interchanges ---
    const hiLo = Math.floor((x - 80) / HS), hiHi = Math.ceil((x + 80) / HS);
    const hjLo = Math.floor((z - 80) / HS), hjHi = Math.ceil((z + 80) / HS);
    for (let i = hiLo; i <= hiHi; i++) {
      for (let j = hjLo; j <= hjHi; j++) {
        for (const r of this.rampsFor(j, i)) {
          const q = this._queryRamp(r, x, z);
          if (q) consider(q);
        }
      }
    }
    return best;
  }

  _queryRowCol(r, x, z) {
    if (!r) return null;
    if (r.kind === 'row') {
      const cz = this.coordAt(r, x);
      const d = this._meanderD(r, x);
      const norm = Math.sqrt(1 + d * d);
      const perp = (z - cz) / norm;              // + = +z side
      const { y, flags } = this.elevAt(r, x);
      const hump = this._crossHump(r, x);
      const yF = y + hump;
      return {
        type: r.type, route: r, s: x, lateral: perp,
        absPerp: Math.abs(perp), score: Math.abs(perp) - r.halfWidth,
        halfWidth: r.halfWidth, y: yF, flags,
        tx: 1 / norm, tz: d / norm,
        rightX: -d / norm, rightZ: 1 / norm
      };
    }
    const cx = this.coordAt(r, z);
    const d = this._meanderD(r, z);
    const norm = Math.sqrt(1 + d * d);
    const perp = (cx - x) / norm;                // + = -x side (right of +z dir)
    const { y, flags } = this.elevAt(r, z);
    const hump = this._crossHump(r, z);
    return {
      type: r.type, route: r, s: z, lateral: perp,
      absPerp: Math.abs(perp), score: Math.abs(perp) - r.halfWidth,
      halfWidth: r.halfWidth, y: y + hump, flags,
      tx: d / norm, tz: 1 / norm,
      rightX: -1 / norm, rightZ: d / norm
    };
  }

  _queryRamp(r, x, z) {
    const dx = r.x2 - r.x1, dz = r.z2 - r.z1;
    const len2 = dx * dx + dz * dz;
    const t = clamp(((x - r.x1) * dx + (z - r.z1) * dz) / len2, 0, 1);
    const px = r.x1 + dx * t, pz = r.z1 + dz * t;
    const dist = Math.hypot(x - px, z - pz);
    if (dist > r.hw + 14) return null;
    const norm = Math.hypot(dx, dz);
    return {
      type: ROAD.RAMP, ramp: r, s: t * norm, lateral: dist,
      absPerp: dist, score: dist - r.hw,
      halfWidth: r.hw, y: lerp(r.y1, r.y2, t), flags: 0,
      tx: dx / norm, tz: dz / norm,
      rightX: -dz / norm, rightZ: dx / norm
    };
  }

  /** combined ground sample used by physics: road surface if close, else terrain */
  groundAt(x, z) {
    const q = this.query(x, z);
    if (q && q.absPerp <= q.halfWidth + 0.01) {
      return { y: q.y, onRoad: true, road: q, lateral: q.lateral };
    }
    let y = this.terrain.height(x, z);
    let blend = null;
    if (q && q.absPerp < q.halfWidth + 13) {
      const t = smoothstep(q.halfWidth, q.halfWidth + 13, q.absPerp);
      const yRoad = q.absPerp <= q.halfWidth
        ? q.y
        : q.y; // road y just beyond edge — blend handles the skirt
      // never pull terrain ABOVE the road deck near a bridge
      const gap = q.y - this.terrain.height(x, z);
      if (gap < WORLD.viaductTrigger) {
        y = lerp(yRoad, y, t);
        blend = t;
      }
      return { y, onRoad: false, road: q, lateral: q.lateral, blend };
    }
    return { y, onRoad: false, road: q, lateral: q ? q.lateral : 0 };
  }

  // =====================================================================
  // sampling for builders / traffic
  // =====================================================================

  /** walkable sample list of route r within param range [u0, u1] */
  sampleRange(r, u0, u1, step = SS) {
    const out = [];
    const tmp = {};
    for (let u = Math.floor(u0 / step) * step; u <= u1; u += step) {
      this.posAt(r, u, tmp);
      const { y, flags } = this.elevAt(r, u);
      const hump = this._crossHump(r, u);
      const d = this._meanderD(r, u);
      const norm = Math.sqrt(1 + d * d);
      out.push({
        x: tmp.x, y: y + hump, z: tmp.z,
        tx: r.kind === 'row' ? 1 / norm : d / norm,
        tz: r.kind === 'row' ? d / norm : 1 / norm,
        u, flags
      });
    }
    return out;
  }

  /** sample at param u (point + tangent + elevation) */
  sampleAt(r, u) {
    const tmp = {};
    this.posAt(r, u, tmp);
    const { y } = this.elevAt(r, u);
    const hump = this._crossHump(r, u);
    const d = this._meanderD(r, u);
    const norm = Math.sqrt(1 + d * d);
    return {
      x: tmp.x, y: y + hump, z: tmp.z,
      tx: r.kind === 'row' ? 1 / norm : d / norm,
      tz: r.kind === 'row' ? d / norm : 1 / norm
    };
  }

  /** enumerate main routes near a world AABB (for chunk building / maps) */
  routesNearAABB(minX, minZ, maxX, maxZ) {
    const out = [];
    const HS = WORLD.highwaySpacing, AS = WORLD.avenueSpacing;
    const M = 650;
    const jLo = Math.floor((minZ - M) / HS), jHi = Math.ceil((maxZ + M) / HS);
    for (let j = jLo; j <= jHi; j++) {
      const r = this.rows.get(j); if (r) out.push(r);
    }
    const iLo = Math.floor((minX - M) / HS), iHi = Math.ceil((maxX + M) / HS);
    for (let i = iLo; i <= iHi; i++) {
      const r = this.cols.get(i); if (r) out.push(r);
    }
    const aLo = Math.floor((minZ - 300) / AS), aHi = Math.ceil((maxZ + 300) / AS);
    for (let j = aLo; j <= aHi; j++) {
      const r = this.rows.get(1000 + j); if (r) out.push(r);
    }
    const bLo = Math.floor((minX - 300) / AS), bHi = Math.ceil((maxX + 300) / AS);
    for (let i = bLo; i <= bHi; i++) {
      const r = this.cols.get(1000 + i); if (r) out.push(r);
    }
    for (const city of this.cities.near((minX + maxX) / 2, (minZ + maxZ) / 2, (maxX - minX) + 1300)) {
      const ring = this.cities.ringRoute(city);
      if (ring) out.push(ring);
      for (const st of this.cities.streetRoutes(city)) out.push(st);
    }
    return out;
  }

  /** interchange crossing points within an AABB (for ramp building) */
  crossingsNearAABB(minX, minZ, maxX, maxZ) {
    const out = [];
    const HS = WORLD.highwaySpacing;
    const iLo = Math.floor((minX - 120) / HS), iHi = Math.ceil((maxX + 120) / HS);
    const jLo = Math.floor((minZ - 120) / HS), jHi = Math.ceil((maxZ + 120) / HS);
    for (let i = iLo; i <= iHi; i++) {
      for (let j = jLo; j <= jHi; j++) {
        const c = this.crossing(j, i);
        if (c && c.x > minX - 140 && c.x < maxX + 140 && c.z > minZ - 140 && c.z < maxZ + 140) {
          out.push(c);
        }
      }
    }
    return out;
  }
}
