/**
 * @fileoverview Cities — deterministic procedural cities, from villages to
 * megacities with skylines.
 *
 * Siting: candidate cells on a jittered lattice pass a flatness + altitude
 * test. Size class comes from world-scale noise.
 *
 * Layout: rotated street grid clipped to city radius, ring roads for towns+,
 * concentric districts (downtown → commercial → residential → suburbs), with
 * an industrial wedge, parks, and parking lots. Buildings avoid all roads.
 */

import {
  hash2i, hash3i, mulberry32, vnoise1, clamp, lerp
} from '../core/Noise.js';
import { WORLD, ROAD } from '../core/Constants.js';

// ============================================================================
// Constants
// ============================================================================

const CITY_CONFIG = Object.freeze({
  BLOCK: 54,
  RING_PAD: 150,
  SPACING_JITTER: 0.7,
  FLATNESS_PROBE_RADIUS: 260,
  FLATNESS_TOLERANCE: 16,
  MIN_ELEVATION: 2.5,
  MAX_ELEVATION: 34,
  SPAWN_CLEARANCE: 900,
  SPAWN_MAX_SIZE: 1,          // town
  RING_ELEV_SAMPLES: 512,
  STREET_JITTER: 7,
  LAMP_SPACING: 42,
  LAMP_OFFSET: 7.2,
  BUILDING_ROAD_CLEARANCE: 11,
  RING_BUILDING_CLEARANCE: 15,
  MAX_ROAD_GRADE_SCALE: 1,    // multiplier for WORLD.maxRoadGrade
});

const CITY_SIZE = Object.freeze([
  { id: 0, radius: 250, label: 'village', hasRing: false },
  { id: 1, radius: 420, label: 'town', hasRing: true },
  { id: 2, radius: 660, label: 'city', hasRing: true },
  { id: 3, radius: 980, label: 'megacity', hasRing: true },
]);

const SIZE_THRESHOLDS = Object.freeze([0.52, 0.76, 0.93, 1.0]);
const SPAWN_PROBABILITY = 0.58; // 1 - 0.42

const DISTRICT = Object.freeze({
  DOWNTOWN: { maxNormDist: 0.34, kind: 'downtown' },
  COMMERCIAL: { maxNormDist: 0.62, kind: 'commercial' },
  RESIDENTIAL: { maxNormDist: 0.86, kind: 'residential' },
  SUBURBS: { maxNormDist: 1.00, kind: 'suburbs' },
});

const BUILDING_KIND = Object.freeze({
  TOWER: 0,
  COMMERCIAL: 1,
  INDUSTRIAL: 2,
  RESIDENTIAL: 3,
  PARKING: 4,
  PARK: 5,
  LANDMARK_TOWER: 6,
  LANDMARK_SPIRE: 7,
});

const BUILDING_COLORS = Object.freeze([
  0x8d9296, 0x7d8288, 0x9aa0a4, 0x6f747a, 0xa39e94, 0x8a8f95,
  0x9c8f7e, 0x767c82, 0xb0a99c, 0x84898f, 0x6a7076, 0x99a0a6
]);

const NAME_PARTS = Object.freeze({
  A: Object.freeze([
    'Ar','Bel','Cor','Dan','El','Fen','Gor','Hal','Iven','Jor',
    'Kel','Lor','Mar','Nex','Ord','Pra','Quel','Ryn','Sol','Tor',
    'Ulm','Vex','Wyn','Cal','Mis','Nor','Vel','Ash','Bren','Cael'
  ]),
  B: Object.freeze([
    'a','en','in','or','um','ara','eth','ia','ova','wick',
    'ton','burg','field','port','gate','mere','holm','vale','crest','reach'
  ]),
  COMPOUND_CHANCE: 0.45,
});

const INDUSTRIAL_CONFIG = Object.freeze({
  ANGLE_WIDTH: 0.55,
  MAX_NORM_DIST: 0.8,
  MIN_CITY_SIZE: 2,
});

const BLOCK_ROLLS = Object.freeze({
  VACANT: 0.07,
  PARKING: 0.13,
  PARK: 0.19,
});

const BUILDING_DIMS = Object.freeze({
  TOWER_MEGA: { w: [18, 34], d: [18, 34], h: [30, 115] },
  TOWER_CITY: { w: [16, 30], d: [16, 30], h: [18, 52] },
  TOWER_SECONDARY: { w: [12, 20], d: [12, 20], h: [14, 34] },
  COMMERCIAL: { w: [10, 22], d: [10, 22], h: [7, 21] },
  INDUSTRIAL: { w: [26, 40], d: [16, 28], h: [7, 12] },
  INDUSTRIAL_SMALL: { w: [14, 24], d: [10, 22], h: [5, 10] },
  RESIDENTIAL: { w: [7, 14], d: [7, 14], h: [4, 8.5] },
  SUBURB: { w: [8, 14], d: [8, 14], h: [3.6, 6.6] },
  PARKING: { w: 38, d: 26, h: 0.1, color: 0x2a2c30 },
  PARK: { w: 40, d: 40, h: 0, color: 0 },
  LANDMARK_TOWER: { w: 26, d: 26, h: 165, color: 0x38404a },
  LANDMARK_SPIRE: { w: 4, d: 4, h: 48, color: 0xb0392e },
});

// ============================================================================
// Utilities
// ============================================================================

/**
 * Normalizes an angle difference to [-π, π].
 * @param {number} delta
 * @returns {number}
 */
function angleDiff(delta) {
  return Math.abs(((delta + Math.PI) % (Math.PI * 2)) - Math.PI);
}

/**
 * @param {number} value
 * @param {string} name
 * @throws {TypeError}
 */
function assertFinite(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite, got ${value}`);
  }
}

/**
 * Deterministic RNG wrapper that isolates city state.
 */
class CityRNG {
  /**
   * @param {number} seed
   * @param {number} ix
   * @param {number} iz
   */
  constructor(seed, ix, iz) {
    this._rng = mulberry32(seed ^ (ix * 2654435761) ^ (iz * 340573321));
  }

  /** @returns {number} 0..1 */
  next() {
    return this._rng();
  }

  /**
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  range(min, max) {
    return min + this._rng() * (max - min);
  }

  /**
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  rangeInt(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  /**
   * @template T
   * @param {ReadonlyArray<T>} arr
   * @returns {T}
   */
  pick(arr) {
    return arr[Math.floor(this._rng() * arr.length)];
  }

  /**
   * @param {number} chance 0..1
   * @returns {boolean}
   */
  chance(chance) {
    return this._rng() < chance;
  }
}

// ============================================================================
// City Transform — precomputes rotation matrix
// ============================================================================

class CityTransform {
  /**
   * @param {number} x
   * @param {number} z
   * @param {number} angle
   */
  constructor(x, z, angle) {
    this.x = x;
    this.z = z;
    this.angle = angle;
    this.cos = Math.cos(angle);
    this.sin = Math.sin(angle);
    this.cosN = Math.cos(-angle);
    this.sinN = Math.sin(-angle);
  }

  /**
   * Local → world
   * @param {number} lx
   * @param {number} lz
   * @returns {{x:number, z:number}}
   */
  toWorld(lx, lz) {
    return {
      x: this.x + lx * this.cos - lz * this.sin,
      z: this.z + lx * this.sin + lz * this.cos,
    };
  }

  /**
   * World → local
   * @param {number} wx
   * @param {number} wz
   * @returns {{lx:number, lz:number}}
   */
  toLocal(wx, wz) {
    const dx = wx - this.x;
    const dz = wz - this.z;
    return {
      lx: dx * this.cosN - dz * this.sinN,
      lz: dx * this.sinN + dz * this.cosN,
    };
  }

  /**
   * Rotate a local vector to world space.
   * @param {number} lx
   * @param {number} lz
   * @returns {{x:number, z:number}}
   */
  rotate(lx, lz) {
    return {
      x: lx * this.cos - lz * this.sin,
      z: lx * this.sin + lz * this.cos,
    };
  }
}

// ============================================================================
// LRU Cache with size bound
// ============================================================================

class BoundedCache {
  /**
   * @param {number} maxSize
   */
  constructor(maxSize = 256) {
    this._max = maxSize;
    /** @type {Map<string, any>} */
    this._map = new Map();
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this._map.has(key);
  }

  /**
   * @param {string} key
   * @returns {any}
   */
  get(key) {
    const v = this._map.get(key);
    if (v !== undefined) {
      // LRU: touch entry
      this._map.delete(key);
      this._map.set(key, v);
    }
    return v;
  }

  /**
   * @param {string} key
   * @param {any} value
   */
  set(key, value) {
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this._max) {
      const first = this._map.keys().next().value;
      this._map.delete(first);
    }
    this._map.set(key, value);
  }

  clear() {
    this._map.clear();
  }
}

// ============================================================================
// Cities
// ============================================================================

/**
 * @typedef {Object} City
 * @property {string} id
 * @property {number} ix
 * @property {number} iz
 * @property {number} x
 * @property {number} z
 * @property {number} baseY
 * @property {number} size 0..3
 * @property {number} radius
 * @property {number} angle
 * @property {string} name
 * @property {boolean} hasRing
 * @property {number} ringR
 * @property {number} indAngle
 */

/**
 * @typedef {Object} Building
 * @property {number} x
 * @property {number} z
 * @property {number} y
 * @property {number} w
 * @property {number} d
 * @property {number} h
 * @property {number} rot
 * @property {number} color
 * @property {number} kind
 */

export class Cities {
  /**
   * @param {number} seed — 32-bit unsigned integer
   * @param {Object} terrain — must expose `.base(x, z)`
   * @param {Object} network — must expose `.query(x, z)`
   */
  constructor(seed, terrain, network) {
    assertFinite(seed, 'seed');
    if (!terrain || typeof terrain.base !== 'function') {
      throw new TypeError('terrain must expose .base(x, z)');
    }
    if (!network || typeof network.query !== 'function') {
      throw new TypeError('network must expose .query(x, z)');
    }

    this._seed = seed >>> 0;
    this._terrain = terrain;
    this._network = network;

    // Caches with bounds to prevent unbounded growth
    this._cityCache = new BoundedCache(512);
    this._buildCache = new BoundedCache(128);
    this._ringElevCache = new BoundedCache(64);

    // Precomputed hash salts
    this._saltSiting = this._seed ^ 0x7117;
    this._saltSize = this._saltSiting ^ 0x4321;
    this._saltAngle = this._saltSiting ^ 0x5555;
    this._saltInd = this._saltSiting ^ 0x6666;
    this._saltName = this._saltSiting ^ 0xa1;
  }

  // ------------------------------------------------------------------
  // Siting
  // ------------------------------------------------------------------

  /**
   * Attempts to generate a city at lattice cell (ix, iz).
   * @param {number} ix
   * @param {number} iz
   * @returns {City|null}
   */
  _make(ix, iz) {
    const S = WORLD.citySpacing;
    const s = this._saltSiting;

    const jx = (hash2i(ix, iz, s) - 0.5) * S * CITY_CONFIG.SPACING_JITTER;
    const jz = (hash2i(ix, iz, s ^ 0x99) - 0.5) * S * CITY_CONFIG.SPACING_JITTER;
    const x = ix * S + jx;
    const z = iz * S + jz;

    const distOrigin = Math.hypot(x, z);

    // Altitude test
    const y0 = this._terrain.base(x, z);
    if (y0 < CITY_CONFIG.MIN_ELEVATION || y0 > CITY_CONFIG.MAX_ELEVATION) {
      return null;
    }

    // Flatness probe
    const probeR = CITY_CONFIG.FLATNESS_PROBE_RADIUS;
    const probeTol = CITY_CONFIG.FLATNESS_TOLERANCE;
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const yy = this._terrain.base(
        x + Math.cos(a) * probeR,
        z + Math.sin(a) * probeR
      );
      if (Math.abs(yy - y0) > probeTol) return null;
    }

    // Spawn probability
    const rn = hash2i(ix * 3 + 7, iz * 5 + 1, s ^ 0x1234);
    if (rn > SPAWN_PROBABILITY) return null;

    // Size class
    const r = hash2i(ix, iz, this._saltSize);
    let size = 0;
    for (let i = 0; i < SIZE_THRESHOLDS.length; i++) {
      if (r < SIZE_THRESHOLDS[i]) { size = i; break; }
    }

    const sizeInfo = CITY_SIZE[size];
    let radius = sizeInfo.radius;

    // Cap size near spawn
    if (distOrigin < CITY_CONFIG.SPAWN_CLEARANCE && size >= 2) {
      size = CITY_SIZE[1].id;
      radius = CITY_SIZE[1].radius;
    }

    const angle = hash2i(ix, iz, this._saltAngle) * Math.PI;
    const name = this._generateName(ix, iz);

    return Object.freeze({
      id: `${ix}:${iz}`,
      ix, iz, x, z, baseY: y0,
      size,
      radius,
      angle,
      name,
      hasRing: size >= 1,
      ringR: radius + CITY_CONFIG.RING_PAD,
      indAngle: hash2i(ix, iz, this._saltInd) * Math.PI * 2,
    });
  }

  /**
   * @param {number} ix
   * @param {number} iz
   * @returns {string}
   */
  _generateName(ix, iz) {
    const s = this._saltName;
    const a = NAME_PARTS.A[Math.floor(hash2i(ix, iz, s) * NAME_PARTS.A.length)];
    const b = NAME_PARTS.B[Math.floor(hash2i(ix, iz, s ^ 0xb2) * NAME_PARTS.B.length)];

    if (hash2i(ix, iz, s ^ 0xc3) < NAME_PARTS.COMPOUND_CHANCE) {
      const c = NAME_PARTS.B[Math.floor(hash2i(ix, iz, s ^ 0xd4) * NAME_PARTS.B.length)];
      return a + b + c;
    }
    return a + b;
  }

  /**
   * @param {number} ix
   * @param {number} iz
   * @returns {City|null}
   */
  cityAt(ix, iz) {
    const key = `${ix}:${iz}`;
    let c = this._cityCache.get(key);
    if (c === undefined) {
      c = this._make(ix, iz);
      this._cityCache.set(key, c);
    }
    return c;
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  /**
   * Returns all cities within reach of (x, z).
   * @param {number} x
   * @param {number} z
   * @param {number} reach
   * @returns {City[]}
   */
  near(x, z, reach) {
    assertFinite(x, 'x');
    assertFinite(z, 'z');
    assertFinite(reach, 'reach');

    const S = WORLD.citySpacing;
    const lo = Math.floor((x - reach) / S);
    const hi = Math.ceil((x + reach) / S);
    const lo2 = Math.floor((z - reach) / S);
    const hi2 = Math.ceil((z + reach) / S);

    const out = [];
    for (let ix = lo; ix <= hi; ix++) {
      for (let iz = lo2; iz <= hi2; iz++) {
        const c = this.cityAt(ix, iz);
        if (c && Math.hypot(c.x - x, c.z - z) < reach + c.radius) {
          out.push(c);
        }
      }
    }
    return out;
  }

  /**
   * Nearest city for HUD region labels.
   * @param {number} x
   * @param {number} z
   * @param {number} [maxDist=2600]
   * @returns {City|null}
   */
  nearest(x, z, maxDist = 2600) {
    assertFinite(x, 'x');
    assertFinite(z, 'z');

    let best = null;
    let bestDist = maxDist;

    for (const c of this.near(x, z, maxDist)) {
      const d = Math.hypot(c.x - x, c.z - z) - c.radius;
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------
  // Ring Road
  // ------------------------------------------------------------------

  /**
   * @param {City} city
   * @returns {{kind:string, city:City, type:number, halfWidth:number, id:string}|null}
   */
  ringRoute(city) {
    if (!city.hasRing) return null;
    return {
      kind: 'ring',
      city,
      type: ROAD.RING,
      halfWidth: 5.6,
      id: `ring:${city.id}`,
    };
  }

  /**
   * @param {City} city
   * @param {number} th
   * @returns {number}
   */
  _ringNoise(city, th) {
    const s = this._seed;
    return (vnoise1(th * 3.1, s ^ city.ix ^ (city.iz << 8)) * 2 - 1) * 0.10
      + (vnoise1(th * 9.7, s ^ city.iz ^ (city.ix << 4)) * 2 - 1) * 0.035;
  }

  /**
   * @param {City} city
   * @param {number} th
   * @returns {number}
   */
  ringRadiusAt(city, th) {
    return city.ringR * (1 + this._ringNoise(city, th));
  }

  /**
   * @param {City} city
   * @param {number} th
   * @returns {{x:number, z:number, th:number, r:number}}
   */
  _ringSample(city, th) {
    const r = this.ringRadiusAt(city, th);
    return {
      x: city.x + Math.cos(th) * r,
      z: city.z + Math.sin(th) * r,
      th,
      r,
    };
  }

  /**
   * @param {City} city
   * @returns {Float32Array}
   */
  _ringElevation(city) {
    let e = this._ringElevCache.get(city.id);
    if (e) return e;

    const N = CITY_CONFIG.RING_ELEV_SAMPLES;
    e = new Float32Array(N);
    const maxStep = WORLD.maxRoadGrade * ((Math.PI * 2 * city.ringR) / N);

    const p0 = this._ringSample(city, 0);
    e[0] = Math.max(
      this._terrain.base(p0.x, p0.z),
      WORLD.waterLevel + WORLD.bridgeClearance
    );

    for (let i = 1; i < N; i++) {
      const th = (i / N) * Math.PI * 2;
      const p = this._ringSample(city, th);
      const t = Math.max(
        this._terrain.base(p.x, p.z),
        WORLD.waterLevel + WORLD.bridgeClearance
      );
      e[i] = e[i - 1] + clamp(t - e[i - 1], -maxStep, maxStep);
    }

    this._ringElevCache.set(city.id, e);
    return e;
  }

  /**
   * @param {City} city
   * @param {number} x
   * @param {number} z
   * @returns {Object|null}
   */
  ringQuery(city, x, z) {
    if (!city.hasRing) return null;

    const dx = x - city.x;
    const dz = z - city.z;
    const rho = Math.hypot(dx, dz);
    const rLo = city.ringR * 0.7 - 20;
    const rHi = city.ringR * 1.3 + 20;

    if (rho > rHi || rho < rLo) return null;

    const th = Math.atan2(dz, dx);
    const r = this.ringRadiusAt(city, th);
    const dist = rho - r;

    const e = this._ringElevation(city);
    const N = CITY_CONFIG.RING_ELEV_SAMPLES;
    const fi = ((th / (Math.PI * 2)) * N + N) % N;
    const i0 = Math.floor(fi) % N;
    const i1 = (i0 + 1) % N;
    const t = fi - i0;
    const y = lerp(e[i0], e[i1], t);

    const dr = this.ringRadiusAt(city, th + 0.01) - r;
    const tx = -Math.sin(th) * r + Math.cos(th) * dr;
    const tz = Math.cos(th) * r + Math.sin(th) * dr;
    const nl = Math.hypot(tx, tz) || 1;

    const isBridge = y - this._terrain.height(x, z) > WORLD.viaductTrigger;

    return {
      type: ROAD.RING,
      route: this.ringRoute(city),
      s: th * r,
      lateral: dist,
      absPerp: Math.abs(dist),
      score: Math.abs(dist) - 5.6,
      halfWidth: 5.6,
      y,
      flags: isBridge ? 1 : 0,
      tx: tx / nl,
      tz: tz / nl,
      rightX: -tz / nl,
      rightZ: tx / nl,
    };
  }

  // ------------------------------------------------------------------
  // Street Grid
  // ------------------------------------------------------------------

  /**
   * @param {City} city
   * @returns {Object[]}
   */
  streetRoutes(city) {
    if (city._streets) return city._streets;

    const out = [];
    const n = Math.ceil((city.radius + 80) / CITY_CONFIG.BLOCK);
    const rng = mulberry32(this._seed ^ (city.ix * 7919) ^ (city.iz * 104729));

    for (let k = -n; k <= n; k++) {
      const jit = (rng() - 0.5) * CITY_CONFIG.STREET_JITTER;
      const coord = k * CITY_CONFIG.BLOCK + jit;
      const isMain = k === 0;
      const hw = isMain ? 5.6 : 4.4;

      out.push({
        kind: 'street',
        axis: 'row',
        city,
        k,
        coord,
        type: ROAD.STREET,
        main: isMain,
        halfWidth: hw,
        id: `st:${city.id}:r${k}`,
      });

      out.push({
        kind: 'street',
        axis: 'col',
        city,
        k,
        coord: coord + (rng() - 0.5) * CITY_CONFIG.STREET_JITTER,
        type: ROAD.STREET,
        main: isMain,
        halfWidth: hw,
        id: `st:${city.id}:c${k}`,
      });
    }

    city._streets = out;
    return out;
  }

  /**
   * @param {City} city
   * @param {Object} st
   * @param {number} u
   * @returns {{x:number, z:number}}
   */
  streetPoint(city, st, u) {
    const xf = new CityTransform(city.x, city.z, city.angle);
    if (st.axis === 'row') {
      return xf.toWorld(u, st.coord);
    }
    return xf.toWorld(st.coord, u);
  }

  /**
   * @param {City} city
   * @param {Object} st
   * @param {number} u
   * @returns {number}
   */
  streetY(city, st, u) {
    const p = this.streetPoint(city, st, u);
    return Math.max(
      this._terrain.base(p.x, p.z),
      WORLD.waterLevel + WORLD.bridgeClearance
    ) + 0.05;
  }

  /**
   * @param {City} city
   * @param {Object} st
   * @param {number} x
   * @param {number} z
   * @returns {Object|null}
   */
  streetQuery(city, st, x, z) {
    const xf = new CityTransform(city.x, city.z, city.angle);
    const local = xf.toLocal(x, z);

    const u = st.axis === 'row' ? local.lx : local.lz;
    const across = st.axis === 'row'
      ? local.lz - st.coord
      : local.lx - st.coord;

    const nd = Math.hypot(local.lx, local.lz);
    if (nd > city.radius + 70) return null;

    const p = this.streetPoint(city, st, u);
    const y = this.streetY(city, st, u);

    const dir = xf.rotate(
      st.axis === 'row' ? 1 : 0,
      st.axis === 'row' ? 0 : 1
    );

    return {
      type: ROAD.STREET,
      route: { kind: 'street', st },
      s: u,
      lateral: across,
      absPerp: Math.abs(across),
      score: Math.abs(across) - st.halfWidth,
      halfWidth: st.halfWidth,
      y,
      flags: 0,
      tx: dir.x,
      tz: dir.z,
      rightX: -dir.z,
      rightZ: dir.x,
    };
  }

  /**
   * @param {City} city
   * @returns {{r:Map<number, Object>, c:Map<number, Object>}}
   */
  _streetMaps(city) {
    if (city._stMaps) return city._stMaps;

    const r = new Map();
    const c = new Map();

    for (const st of this.streetRoutes(city)) {
      if (st.axis === 'row') r.set(st.k, st);
      else c.set(st.k, st);
    }

    city._stMaps = { r, c };
    return city._stMaps;
  }

  /**
   * Best street in the city for (x, z).
   * @param {City} city
   * @param {number} x
   * @param {number} z
   * @returns {Object|null}
   */
  streetQueryBest(city, x, z) {
    const xf = new CityTransform(city.x, city.z, city.angle);
    const local = xf.toLocal(x, z);

    if (Math.hypot(local.lx, local.lz) > city.radius + 70) return null;

    const maps = this._streetMaps(city);
    const kr = Math.round(local.lz / CITY_CONFIG.BLOCK);
    const kc = Math.round(local.lx / CITY_CONFIG.BLOCK);

    let best = null;

    const sr = maps.r.get(kr);
    if (sr) {
      const q = this.streetQuery(city, sr, x, z);
      if (q) best = q;
    }

    const sc = maps.c.get(kc);
    if (sc) {
      const q = this.streetQuery(city, sc, x, z);
      if (q && (!best || q.score < best.score)) best = q;
    }

    return best;
  }

  // ------------------------------------------------------------------
  // Buildings
  // ------------------------------------------------------------------

  /**
   * @param {City} city
   * @returns {Building[]}
   */
  buildingsIn(city) {
    let list = this._buildCache.get(city.id);
    if (list) return list;

    list = this._generateBuildings(city);
    this._buildCache.set(city.id, list);
    return list;
  }

  /**
   * @param {City} city
   * @returns {Building[]}
   */
  _generateBuildings(city) {
    const rng = new CityRNG(this._seed, city.ix, city.iz);
    const xf = new CityTransform(city.x, city.z, city.angle);
    const n = Math.ceil((city.radius + 60) / CITY_CONFIG.BLOCK);

    /** @type {Building[]} */
    const list = [];

    /**
     * @param {number} lx
     * @param {number} lz
     * @param {number} w
     * @param {number} d
     * @param {number} h
     * @param {number} kind
     * @param {number} [color]
     */
    const putB = (lx, lz, w, d, h, kind, color) => {
      const world = xf.toWorld(lx, lz);

      // Ring road clearance
      if (city.hasRing) {
        const rho = Math.hypot(world.x - city.x, world.z - city.z);
        const th = Math.atan2(world.z - city.z, world.x - city.x);
        if (Math.abs(rho - this.ringRadiusAt(city, th)) < CITY_CONFIG.RING_BUILDING_CLEARANCE) {
          return;
        }
      }

      // Road network clearance
      const q = this._network.query(world.x, world.z);
      if (q && q.absPerp < q.halfWidth + CITY_CONFIG.BUILDING_ROAD_CLEARANCE) {
        return;
      }

      const y = Math.max(
        this._terrain.base(world.x, world.z),
        WORLD.waterLevel + 1
      ) + 0.05;

      list.push({
        x: world.x,
        z: world.z,
        y,
        w,
        d,
        h,
        rot: city.angle + (rng.chance(0.12) ? rng.range(-0.1, 0.1) : 0),
        color: color ?? BUILDING_COLORS[rng.rangeInt(0, BUILDING_COLORS.length - 1)],
        kind,
      });
    };

    for (let bx = -n; bx <= n; bx++) {
      for (let bz = -n; bz <= n; bz++) {
        const lx = bx * CITY_CONFIG.BLOCK + CITY_CONFIG.BLOCK / 2 + rng.range(-3, 3);
        const lz = bz * CITY_CONFIG.BLOCK + CITY_CONFIG.BLOCK / 2 + rng.range(-3, 3);
        const nd = Math.hypot(lx, lz) / city.radius;

        if (nd > 1.0) continue;

        const ang = Math.atan2(lz, lx);
        const dAng = angleDiff(ang - city.indAngle);
        const isIndustrial = city.size >= INDUSTRIAL_CONFIG.MIN_CITY_SIZE
          && dAng < INDUSTRIAL_CONFIG.ANGLE_WIDTH
          && nd < INDUSTRIAL_CONFIG.MAX_NORM_DIST;

        const roll = rng.next();

        // Vacant lot
        if (roll < BLOCK_ROLLS.VACANT) continue;

        // Parking lot
        if (roll < BLOCK_ROLLS.PARKING && city.size >= 1) {
          const world = xf.toWorld(lx, lz);
          const y = Math.max(
            this._terrain.base(world.x, world.z),
            WORLD.waterLevel + 1
          ) + 0.08;
          list.push({
            x: world.x, z: world.z, y,
            w: BUILDING_DIMS.PARKING.w,
            d: BUILDING_DIMS.PARKING.d,
            h: BUILDING_DIMS.PARKING.h,
            rot: city.angle,
            color: BUILDING_DIMS.PARKING.color,
            kind: BUILDING_KIND.PARKING,
          });
          continue;
        }

        // Park
        if (roll < BLOCK_ROLLS.PARK) {
          const world = xf.toWorld(lx, lz);
          list.push({
            x: world.x, z: world.z, y: 0,
            w: BUILDING_DIMS.PARK.w,
            d: BUILDING_DIMS.PARK.d,
            h: BUILDING_DIMS.PARK.h,
            rot: 0,
            color: BUILDING_DIMS.PARK.color,
            kind: BUILDING_KIND.PARK,
          });
          continue;
        }

        // District-based generation
        if (isIndustrial) {
          this._placeIndustrial(putB, rng, lx, lz);
        } else if (nd < DISTRICT.DOWNTOWN.maxNormDist && city.size >= 1) {
          this._placeDowntown(putB, rng, lx, lz, city.size);
        } else if (nd < DISTRICT.COMMERCIAL.maxNormDist) {
          this._placeCommercial(putB, rng, lx, lz);
        } else if (nd < DISTRICT.RESIDENTIAL.maxNormDist) {
          this._placeResidential(putB, rng, lx, lz);
        } else {
          this._placeSuburban(putB, rng, lx, lz);
        }
      }
    }

    // Landmarks
    this._placeLandmarks(list, city, xf, rng);

    return Object.freeze(list);
  }

  /**
   * @param {Function} putB
   * @param {CityRNG} rng
   * @param {number} lx
   * @param {number} lz
   */
  _placeIndustrial(putB, rng, lx, lz) {
    const d = BUILDING_DIMS.INDUSTRIAL;
    putB(lx, lz, rng.range(d.w[0], d.w[1]), rng.range(d.d[0], d.d[1]), rng.range(d.h[0], d.h[1]), BUILDING_KIND.INDUSTRIAL);
    if (rng.chance(0.5)) {
      const ds = BUILDING_DIMS.INDUSTRIAL_SMALL;
      putB(lx + rng.range(-15, 15), lz + rng.range(-15, 15), rng.range(ds.w[0], ds.w[1]), rng.range(ds.d[0], ds.d[1]), rng.range(ds.h[0], ds.h[1]), BUILDING_KIND.INDUSTRIAL);
    }
  }

  /**
   * @param {Function} putB
   * @param {CityRNG} rng
   * @param {number} lx
   * @param {number} lz
   * @param {number} citySize
   */
  _placeDowntown(putB, rng, lx, lz, citySize) {
    if (citySize === 3) {
      const d = BUILDING_DIMS.TOWER_MEGA;
      putB(lx, lz, rng.range(d.w[0], d.w[1]), rng.range(d.d[0], d.d[1]), rng.range(d.h[0], d.h[1]), BUILDING_KIND.TOWER);
    } else {
      const d = BUILDING_DIMS.TOWER_CITY;
      putB(lx, lz, rng.range(d.w[0], d.w[1]), rng.range(d.d[0], d.d[1]), rng.range(d.h[0], d.h[1]), BUILDING_KIND.TOWER);
    }
    if (rng.chance(0.4)) {
      const d = BUILDING_DIMS.TOWER_SECONDARY;
      putB(lx + rng.range(-22, 22), lz + rng.range(-22, 22), rng.range(d.w[0], d.w[1]), rng.range(d.d[0], d.d[1]), rng.range(d.h[0], d.h[1]), BUILDING_KIND.TOWER);
    }
  }

  /**
   * @param {Function} putB
   * @param {CityRNG} rng
   * @param {number} lx
   * @param {number} lz
   */
  _placeCommercial(putB, rng, lx, lz) {
    const count = rng.rangeInt(2, 3);
    const d = BUILDING_DIMS.COMMERCIAL;
    for (let i = 0; i < count; i++) {
      putB(lx + rng.range(-18, 18), lz + rng.range(-18, 18), rng.range(d.w[0], d.w[1]), rng.range(d.d[0], d.d[1]), rng.range(d.h[0], d.h[1]), BUILDING_KIND.COMMERCIAL);
    }
  }

  /**
   * @param {Function} putB
   * @param {CityRNG} rng
   * @param {number} lx
   * @param {number} lz
   */
  _placeResidential(putB, rng, lx, lz) {
    const count = rng.rangeInt(3, 5);
    const d = BUILDING_DIMS.RESIDENTIAL;
    for (let i = 0; i < count; i++) {
      putB(lx + rng.range(-20, 20), lz + rng.range(-20, 20), rng.range(d.w[0], d.w[1]), rng.range(d.d[0], d.d[1]), rng.range(d.h[0], d.h[1]), BUILDING_KIND.RESIDENTIAL);
    }
  }

  /**
   * @param {Function} putB
   * @param {CityRNG} rng
   * @param {number} lx
   * @param {number} lz
   */
  _placeSuburban(putB, rng, lx, lz) {
    if (rng.chance(0.75)) {
      const d = BUILDING_DIMS.SUBURB;
      putB(lx + rng.range(-15, 15), lz + rng.range(-15, 15), rng.range(d.w[0], d.w[1]), rng.range(d.d[0], d.d[1]), rng.range(d.h[0], d.h[1]), BUILDING_KIND.RESIDENTIAL);
    }
  }

  /**
   * @param {Building[]} list
   * @param {City} city
   * @param {CityTransform} xf
   * @param {CityRNG} rng
   */
  _placeLandmarks(list, city, xf, rng) {
    if (city.size === 3) {
      const d = BUILDING_DIMS.LANDMARK_TOWER;
      list.push({
        x: city.x, z: city.z, y: city.baseY,
        w: d.w, d: d.d, h: d.h,
        rot: city.angle,
        color: d.color,
        kind: BUILDING_KIND.LANDMARK_TOWER,
      });
    } else if (city.size === 2) {
      const d = BUILDING_DIMS.LANDMARK_SPIRE;
      const offset = 2.6;
      const lx = Math.cos(city.indAngle + offset) * city.radius * 0.4;
      const lz = Math.sin(city.indAngle + offset) * city.radius * 0.4;
      const world = xf.toWorld(lx, lz);
      list.push({
        x: world.x, z: world.z, y: city.baseY,
        w: d.w, d: d.d, h: d.h,
        rot: 0,
        color: d.color,
        kind: BUILDING_KIND.LANDMARK_SPIRE,
      });
    }
  }

  // ------------------------------------------------------------------
  // Streetlamps
  // ------------------------------------------------------------------

  /**
   * @param {City} city
   * @returns {Object[]}
   */
  lampsIn(city) {
    if (city._lamps) return city._lamps;

    const out = [];
    const xf = new CityTransform(city.x, city.z, city.angle);

    for (const st of this.streetRoutes(city)) {
      if (!st.main) continue;

      const span = city.radius + 60;
      for (let u = -span; u <= span; u += CITY_CONFIG.LAMP_SPACING) {
        const p = this.streetPoint(city, st, u);
        if (Math.hypot(p.x - city.x, p.z - city.z) > city.radius + 50) continue;

        const perp = st.axis === 'row' ? CITY_CONFIG.LAMP_OFFSET : -CITY_CONFIG.LAMP_OFFSET;
        const lx = st.axis === 'row' ? u : st.coord + perp;
        const lz = st.axis === 'row' ? st.coord + perp : u;

        out.push({
          x: xf.toWorld(lx, lz).x,
          z: xf.toWorld(lx, lz).z,
          y: this.streetY(city, st, u),
        });
      }
    }

    city._lamps = out;
    return out;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  destroy() {
    this._cityCache.clear();
    this._buildCache.clear();
    this._ringElevCache.clear();
    this._terrain = null;
    this._network = null;
  }
}

// Re-export for consumers
export { BUILDING_KIND, BUILDING_COLORS, CITY_SIZE };
