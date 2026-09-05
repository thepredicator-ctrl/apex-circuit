/**
 * Cities — deterministic procedural cities, from lonely villages to
 * megacities with skylines.
 *
 * Siting: candidate cells on a jittered lattice pass a flatness + altitude
 * test (no cities in the sea or on mountain walls). Size class comes from
 * world-scale noise: village < town < city < megacity.
 *
 * Layout: a rotated street grid (54 m blocks) clipped to the city radius,
 * a ring road for towns and up, districts by radius + angle:
 *   downtown (towers) → commercial (mid-rise) → residential (houses) →
 *   suburbs, with an industrial warehouse wedge on big cities, parks and
 *   parking lots sprinkled in. Buildings are placed per-block, avoiding
 *   every road, so nothing ever intersects the street network.
 */

import { hash2i, hash3i, mulberry32, vnoise1, clamp, lerp, smoothstep } from '../core/Noise.js';
import { WORLD, ROAD } from '../core/Constants.js';

const BLOCK = 54;
const RING_PAD = 150;

const NAME_A = ['Ar', 'Bel', 'Cor', 'Dan', 'El', 'Fen', 'Gor', 'Hal', 'Iven', 'Jor',
  'Kel', 'Lor', 'Mar', 'Nex', 'Ord', 'Pra', 'Quel', 'Ryn', 'Sol', 'Tor',
  'Ulm', 'Vex', 'Wyn', 'Cal', 'Mis', 'Nor', 'Vel', 'Ash', 'Bren', 'Cael'];
const NAME_B = ['a', 'en', 'in', 'or', 'um', 'ara', 'eth', 'ia', 'ova', 'wick',
  'ton', 'burg', 'field', 'port', 'gate', 'mere', 'holm', 'vale', 'crest', 'reach'];

export const BUILDING_COLORS = [
  0x8d9296, 0x7d8288, 0x9aa0a4, 0x6f747a, 0xa39e94, 0x8a8f95,
  0x9c8f7e, 0x767c82, 0xb0a99c, 0x84898f, 0x6a7076, 0x99a0a6
];

export class Cities {
  constructor(seed, terrain, network) {
    this.seed = seed >>> 0;
    this.terrain = terrain;
    this.network = network;
    this._cache = new Map();        // "ix:iz" -> city | null
    this._nearCache = new Map();
    this._buildCache = new Map();   // cityId -> building list
    this._ringElev = new Map();     // cityId -> Float32Array
  }

  // ------------------------------------------------------------- siting
  _make(ix, iz) {
    const s = this.seed ^ 0x7117;
    const S = WORLD.citySpacing;
    const jx = (hash2i(ix, iz, s) - 0.5) * S * 0.7;
    const jz = (hash2i(ix, iz, s ^ 0x99) - 0.5) * S * 0.7;
    const x = ix * S + jx;
    const z = iz * S + jz;

    // keep the immediate spawn area readable — no megacity on the player's head
    const distOrigin = Math.hypot(x, z);

    const y0 = this.terrain.base(x, z);
    if (y0 < 2.5 || y0 > 34) return null;      // no cities in water / cliffs
    // flatness probe
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const yy = this.terrain.base(x + Math.cos(a) * 260, z + Math.sin(a) * 260);
      if (Math.abs(yy - y0) > 16) return null;
    }
    const rn = hash2i(ix * 3 + 7, iz * 5 + 1, s ^ 0x1234);
    if (rn < 0.42) return null;                // ~58% of cells have a settlement

    const r = hash2i(ix, iz, s ^ 0x4321);
    let size, radius;
    if (r < 0.52) { size = 0; radius = 250; }        // village
    else if (r < 0.76) { size = 1; radius = 420; }   // town
    else if (r < 0.93) { size = 2; radius = 660; }   // city
    else { size = 3; radius = 980; }                 // megacity
    if (distOrigin < 900 && size >= 2) { size = 1; radius = 420; }

    const angle = hash2i(ix, iz, s ^ 0x5555) * Math.PI;
    const name = this._name(ix, iz, s);
    return {
      id: ix + ':' + iz, ix, iz, x, z, baseY: y0,
      size, radius, angle, name,
      hasRing: size >= 1,
      ringR: radius + RING_PAD,
      indAngle: hash2i(ix, iz, s ^ 0x6666) * Math.PI * 2
    };
  }

  _name(ix, iz, s) {
    const a = NAME_A[Math.floor(hash2i(ix, iz, s ^ 0xa1) * NAME_A.length)];
    const b = NAME_B[Math.floor(hash2i(ix, iz, s ^ 0xb2) * NAME_B.length)];
    if (hash2i(ix, iz, s ^ 0xc3) < 0.45) {
      const c = NAME_B[Math.floor(hash2i(ix, iz, s ^ 0xd4) * NAME_B.length)];
      return a + b + c;
    }
    return a + b;
  }

  cityAt(ix, iz) {
    const key = ix + ':' + iz;
    if (this._cache.has(key)) return this._cache.get(key);
    const c = this._make(ix, iz);
    this._cache.set(key, c);
    return c;
  }

  near(x, z, reach) {
    const S = WORLD.citySpacing;
    const lo = Math.floor((x - reach) / S), hi = Math.ceil((x + reach) / S);
    const lo2 = Math.floor((z - reach) / S), hi2 = Math.ceil((z + reach) / S);
    const out = [];
    for (let ix = lo; ix <= hi; ix++) {
      for (let iz = lo2; iz <= hi2; iz++) {
        const c = this.cityAt(ix, iz);
        if (c && Math.hypot(c.x - x, c.z - z) < reach + c.radius) out.push(c);
      }
    }
    return out;
  }

  /** nearest city (for HUD region label) */
  nearest(x, z, maxDist = 2600) {
    let best = null, bd = maxDist;
    for (const c of this.near(x, z, maxDist)) {
      const d = Math.hypot(c.x - x, c.z - z) - c.radius;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  // ------------------------------------------------------------- ring road
  ringRoute(city) {
    if (!city.hasRing) return null;
    return { kind: 'ring', city, type: ROAD.RING, halfWidth: 5.6, id: 'ring:' + city.id };
  }

  _ringNoise(city, th) {
    return (vnoise1(th * 3.1, this.seed ^ city.ix ^ (city.iz << 8)) * 2 - 1) * 0.10
      + (vnoise1(th * 9.7, this.seed ^ city.iz ^ (city.ix << 4)) * 2 - 1) * 0.035;
  }

  ringRadiusAt(city, th) {
    return city.ringR * (1 + this._ringNoise(city, th));
  }

  _ringSample(city, th) {
    const r = this.ringRadiusAt(city, th);
    const x = city.x + Math.cos(th) * r;
    const z = city.z + Math.sin(th) * r;
    return { x, z, th, r };
  }

  _ringElevation(city) {
    let e = this._ringElev.get(city.id);
    if (e) return e;
    const N = 512;
    e = new Float32Array(N);
    const maxStep = WORLD.maxRoadGrade * ((Math.PI * 2 * city.ringR) / N);
    e[0] = Math.max(this.terrain.base(city.x + city.ringR, city.z), WORLD.waterLevel + WORLD.bridgeClearance);
    for (let i = 1; i < N; i++) {
      const th = (i / N) * Math.PI * 2;
      const p = this._ringSample(city, th);
      const t = Math.max(this.terrain.base(p.x, p.z), WORLD.waterLevel + WORLD.bridgeClearance);
      e[i] = e[i - 1] + clamp(t - e[i - 1], -maxStep, maxStep);
    }
    this._ringElev.set(city.id, e);
    return e;
  }

  ringQuery(city, x, z) {
    if (!city.hasRing) return null;
    const dx = x - city.x, dz = z - city.z;
    const rho = Math.hypot(dx, dz);
    if (rho > city.ringR * 1.3 + 20 || rho < city.ringR * 0.7 - 20) return null;
    const th = Math.atan2(dz, dx);
    const r = this.ringRadiusAt(city, th);
    const dist = rho - r;    // + = outside
    const e = this._ringElevation(city);
    const N = 512;
    const fi = ((th / (Math.PI * 2)) * N + N) % N;
    const i0 = Math.floor(fi) % N, i1 = (i0 + 1) % N;
    const t = fi - Math.floor(fi);
    const y = lerp(e[i0], e[i1], t);
    // tangent
    const dr = this.ringRadiusAt(city, th + 0.01) - r;
    const tx = -Math.sin(th) * r + Math.cos(th) * dr;
    const tz = Math.cos(th) * r + Math.sin(th) * dr;
    const nl = Math.hypot(tx, tz) || 1;
    return {
      type: ROAD.RING, route: this.ringRoute(city), s: th * r,
      lateral: dist, absPerp: Math.abs(dist),
      score: Math.abs(dist) - 5.6, halfWidth: 5.6, y, flags: y - this.terrain.height(x, z) > WORLD.viaductTrigger ? 1 : 0,
      tx: tx / nl, tz: tz / nl,
      rightX: -tz / nl, rightZ: tx / nl
    };
  }

  // ------------------------------------------------------------- streets
  /** grid street lines: axis 'row' = constant local z, 'col' = constant local x */
  streetRoutes(city) {
    if (city._streets) return city._streets;
    const out = [];
    const n = Math.ceil((city.radius + 80) / BLOCK);
    const rng = mulberry32(this.seed ^ (city.ix * 7919) ^ (city.iz * 104729));
    for (let k = -n; k <= n; k++) {
      const jit = (rng() - 0.5) * 7;
      out.push({ kind: 'street', axis: 'row', city, k, coord: k * BLOCK + jit, type: ROAD.STREET, main: k === 0, halfWidth: k === 0 ? 5.6 : 4.4, id: 'st:' + city.id + ':r' + k });
      out.push({ kind: 'street', axis: 'col', city, k, coord: k * BLOCK + (rng() - 0.5) * 7, type: ROAD.STREET, main: k === 0, halfWidth: k === 0 ? 5.6 : 4.4, id: 'st:' + city.id + ':c' + k });
    }
    city._streets = out;
    return out;
  }

  /** world position of a point on street st at along-axis local coord u */
  streetPoint(city, st, u) {
    const ca = Math.cos(city.angle), sa = Math.sin(city.angle);
    let lx, lz;
    if (st.axis === 'row') { lx = u; lz = st.coord; }
    else { lx = st.coord; lz = u; }
    return {
      x: city.x + lx * ca - lz * sa,
      z: city.z + lx * sa + lz * ca
    };
  }

  streetY(city, st, u) {
    const p = this.streetPoint(city, st, u);
    return Math.max(this.terrain.base(p.x, p.z), WORLD.waterLevel + WORLD.bridgeClearance) + 0.05;
  }

  streetQuery(city, st, x, z) {
    // world -> city frame
    const ca = Math.cos(-city.angle), sa = Math.sin(-city.angle);
    const dx = x - city.x, dz = z - city.z;
    const lx = dx * ca - dz * sa;
    const lz = dx * sa + dz * ca;
    const u = st.axis === 'row' ? lx : lz;
    const across = st.axis === 'row' ? lz - st.coord : lx - st.coord;
    // street only exists inside the city disc
    const nd = Math.hypot(lx, lz);
    if (nd > city.radius + 70) return null;
    const p = this.streetPoint(city, st, u);
    const y = this.streetY(city, st, u);
    // direction in world space
    let tx, tz;
    if (st.axis === 'row') { tx = ca; tz = sa; }
    else { tx = sa; tz = ca; }
    return {
      type: ROAD.STREET, route: { kind: 'street', st }, s: u,
      lateral: across, absPerp: Math.abs(across),
      score: Math.abs(across) - st.halfWidth, halfWidth: st.halfWidth,
      y, flags: 0, tx, tz, rightX: -tz, rightZ: tx
    };
  }

  _streetMaps(city) {
    if (city._stMaps) return city._stMaps;
    const r = new Map(), c = new Map();
    for (const st of this.streetRoutes(city)) {
      if (st.axis === 'row') r.set(st.k, st);
      else c.set(st.k, st);
    }
    city._stMaps = { r, c };
    return city._stMaps;
  }

  /** best street in the city for (x, z) — called by network query */
  streetQueryBest(city, x, z) {
    const ca = Math.cos(-city.angle), sa = Math.sin(-city.angle);
    const dx = x - city.x, dz = z - city.z;
    const lx = dx * ca - dz * sa;
    const lz = dx * sa + dz * ca;
    if (Math.hypot(lx, lz) > city.radius + 70) return null;
    const maps = this._streetMaps(city);
    const kr = Math.round(lz / BLOCK);
    const kc = Math.round(lx / BLOCK);
    let best = null;
    const sr = maps.r.get(kr);
    const sc = maps.c.get(kc);
    if (sr) {
      const q = this.streetQuery(city, sr, x, z);
      if (q) best = q;
    }
    if (sc) {
      const q = this.streetQuery(city, sc, x, z);
      if (q && (!best || q.score < best.score)) best = q;
    }
    return best;
  }

  // ------------------------------------------------------------- buildings
  buildingsIn(city) {
    let list = this._buildCache.get(city.id);
    if (list) return list;
    list = [];
    const rng = mulberry32(this.seed ^ (city.ix * 2654435761) ^ (city.iz * 340573321));
    const n = Math.ceil((city.radius + 60) / BLOCK);
    const ca = Math.cos(city.angle), sa = Math.sin(city.angle);
    const putB = (lx, lz, w, d, h, kind) => {
      const wx = city.x + lx * ca - lz * sa;
      const wz = city.z + lx * sa + lz * ca;
      // clearance from ring + outside roads
      if (city.hasRing) {
        const rho = Math.hypot(wx - city.x, wz - city.z);
        const th = Math.atan2(wz - city.z, wx - city.x);
        if (Math.abs(rho - this.ringRadiusAt(city, th)) < 15) return;
      }
      const q = this.network.query(wx, wz);
      if (q && q.absPerp < q.halfWidth + 11) return;
      const y = Math.max(this.terrain.base(wx, wz), WORLD.waterLevel + 1) + 0.05;
      list.push({
        x: wx, z: wz, y, w, d, h,
        rot: city.angle + (rng() < 0.12 ? (rng() - 0.5) * 0.2 : 0),
        color: BUILDING_COLORS[Math.floor(rng() * BUILDING_COLORS.length)],
        kind
      });
    };

    for (let bx = -n; bx <= n; bx++) {
      for (let bz = -n; bz <= n; bz++) {
        const lx = bx * BLOCK + BLOCK / 2 + (rng() - 0.5) * 6;
        const lz = bz * BLOCK + BLOCK / 2 + (rng() - 0.5) * 6;
        const nd = Math.hypot(lx, lz) / city.radius;
        if (nd > 1.0) continue;
        const ang = Math.atan2(lz, lx);
        let dAng = Math.abs(ang - city.indAngle);
        while (dAng > Math.PI) dAng = Math.abs(dAng - Math.PI * 2);
        const industrial = city.size >= 2 && dAng < 0.55 && nd < 0.8;

        const roll = rng();
        if (roll < 0.07) continue;                       // vacant block
        if (roll < 0.13 && city.size >= 1) {
          // parking lot block
          list.push({ x: city.x + lx * ca - lz * sa, z: city.z + lx * sa + lz * ca, y: this.terrain.base(city.x + lx * ca - lz * sa, city.z + lx * sa + lz * ca) + 0.08, w: 38, d: 26, h: 0.1, rot: city.angle, color: 0x2a2c30, kind: 4 });
          continue;
        }
        if (roll < 0.19) {
          // pocket park — the chunk builder turns this into trees
          list.push({ x: city.x + lx * ca - lz * sa, z: city.z + lx * sa + lz * ca, y: 0, w: 40, d: 40, h: 0, rot: 0, color: 0, kind: 5 });
          continue;
        }

        if (industrial) {
          putB(lx, lz, 26 + rng() * 14, 16 + rng() * 12, 7 + rng() * 5, 2);
          if (rng() < 0.5) putB(lx + (rng() - 0.5) * 30, lz + (rng() - 0.5) * 30, 14, 10, 5, 2);
        } else if (nd < 0.34 && city.size >= 1) {
          // downtown
          if (city.size === 3) {
            putB(lx, lz, 18 + rng() * 16, 18 + rng() * 16, 30 + rng() * 85, 0);
          } else {
            putB(lx, lz, 16 + rng() * 14, 16 + rng() * 14, 18 + rng() * 34, 0);
          }
          if (rng() < 0.4) putB(lx + (rng() - 0.5) * 44, lz + (rng() - 0.5) * 44, 12 + rng() * 8, 12 + rng() * 8, 14 + rng() * 20, 0);
        } else if (nd < 0.62) {
          // commercial mid-rise
          const count = 2 + Math.floor(rng() * 2);
          for (let i = 0; i < count; i++) {
            putB(lx + (rng() - 0.5) * 36, lz + (rng() - 0.5) * 36, 10 + rng() * 12, 10 + rng() * 12, 7 + rng() * 14, 1);
          }
        } else if (nd < 0.86) {
          // residential
          const count = 3 + Math.floor(rng() * 3);
          for (let i = 0; i < count; i++) {
            putB(lx + (rng() - 0.5) * 40, lz + (rng() - 0.5) * 40, 7 + rng() * 7, 7 + rng() * 7, 4 + rng() * 4.5, 3);
          }
        } else {
          // suburbs
          if (rng() < 0.75) {
            putB(lx + (rng() - 0.5) * 30, lz + (rng() - 0.5) * 30, 8 + rng() * 6, 8 + rng() * 6, 3.6 + rng() * 3, 3);
          }
        }
      }
    }
    // landmarks
    if (city.size === 3) {
      list.push({ x: city.x, z: city.z, y: city.baseY, w: 26, d: 26, h: 165, rot: city.angle, color: 0x38404a, kind: 6 });
    } else if (city.size === 2) {
      list.push({ x: city.x + Math.cos(city.indAngle + 2.6) * city.radius * 0.4, z: city.z + Math.sin(city.indAngle + 2.6) * city.radius * 0.4, y: city.baseY, w: 4, d: 4, h: 48, rot: 0, color: 0xb0392e, kind: 7 });
    }
    this._buildCache.set(city.id, list);
    return list;
  }

  /** streetlamp positions along main streets (chunk builder consumes) */
  lampsIn(city) {
    if (city._lamps) return city._lamps;
    const out = [];
    for (const st of this.streetRoutes(city)) {
      if (!st.main) continue;
      const span = city.radius + 60;
      for (let u = -span; u <= span; u += 42) {
        const p = this.streetPoint(city, st, u);
        if (Math.hypot(p.x - city.x, p.z - city.z) > city.radius + 50) continue;
        const perp = st.axis === 'row' ? 7.2 : -7.2;
        const ca = Math.cos(city.angle), sa = Math.sin(city.angle);
        let lx, lz;
        if (st.axis === 'row') { lx = u; lz = st.coord + perp; }
        else { lx = st.coord + perp; lz = u; }
        out.push({
          x: city.x + lx * ca - lz * sa,
          z: city.z + lx * sa + lz * ca,
          y: this.streetY(city, st, u)
        });
      }
    }
    city._lamps = out;
    return out;
  }
}
