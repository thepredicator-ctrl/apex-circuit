/**
 * @fileoverview World — facade of the open world.
 * Owns the road network, terrain field, cities, mystery system, shared scenery
 * and the chunk streamer. Exposes the unified surface API consumed by vehicle
 * physics.
 */

import * as THREE from 'three';
import { WORLD, QUALITY } from './core/Constants.js';
import { mulberry32 } from './core/Noise.js';
import { RoadNetwork } from './world/RoadNetwork.js';
import { ChunkManager } from './world/ChunkManager.js';
import { Mystery } from './world/Mystery.js';
import { Scenery } from './world/Scenery.js';

// ============================================================================
// Constants
// ============================================================================

const WORLD_DEFAULTS = Object.freeze({
  SEED: 1337,
  ANISOTROPY: 4,
  QUALITY: 'medium',
});

const WATER_CONFIG = Object.freeze({
  SIZE: 9000,
  SEGMENTS: 1,
  RECEIVE_SHADOWS: false,
  NAME: 'Water',
});

const RIDGE_CONFIG = Object.freeze({
  RADIUS: 2650,
  SEGMENTS: 96,
  MIN_HEIGHT: 60,
  MAX_HEIGHT: 270,
  SNOW_LINE: 150,
  SNOW_BLEND_RANGE: 110,
  SNOW_COLOR: 0xeef3f8,
  BASE_HUE: 0.58,
  BASE_SATURATION: 0.14,
  BASE_LIGHTNESS_MIN: 0.30,
  BASE_LIGHTNESS_MAX: 0.37,
  RENDER_ORDER: -1,
  NAME: 'FarRidge',
});

const SURFACE_SAMPLE = Object.freeze({
  FINITE_DIFFERENCE_DELTA: 1.6,
});

const SPAWN_CONFIG = Object.freeze({
  HIGHWAY_ROW: 0,
  STEP: 10,
  MAX_DISTANCE: 900,
  MIN_DISTANCE: 10,
  INTERCHANGE_SPACING: 4200,
  INTERCHANGE_CLEARANCE: 220,
  LANE_OFFSET: 5.5,
  MAX_LATERAL: 2,
  MIN_ELEVATION: 3,
  FALLBACK_DISTANCE: 12,
});

const UPDATE_CONFIG = Object.freeze({
  RIDGE_HEIGHT_OFFSET: 30,
  RIDGE_MAX_HEIGHT_OFFSET: 30,
});

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * @typedef {Object} GroundSample
 * @property {number} y
 * @property {boolean} onRoad
 * @property {Object|null} road
 * @property {number} [lateral]
 */

/**
 * @typedef {Object} SurfaceSample
 * @property {number} y
 * @property {boolean} onRoad
 * @property {number} grade
 * @property {number} bank
 * @property {number} lateral
 * @property {number} halfWidth
 * @property {number} roadType
 * @property {boolean} bridge
 * @property {boolean} shoulder
 */

/**
 * @typedef {Object} SpawnPose
 * @property {number} x
 * @property {number} z
 * @property {number} y
 * @property {number} heading
 */

/**
 * @typedef {Object} Vector3Like
 * @property {number} x
 * @property {number} y
 * @property {number} z
 */

// ============================================================================
// Validation
// ============================================================================

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const assertFinite = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got ${value}`);
  }
};

const assertUint32 = (value, name) => {
  if (typeof value !== 'number' || value < 0 || value > 0xFFFFFFFF || (value | 0) !== value) {
    throw new TypeError(`${name} must be a uint32, got ${value}`);
  }
};

// ============================================================================
// Subsystem: Water Plane
// ============================================================================

class WaterPlane {
  /**
   * @param {THREE.Material} material
   * @returns {THREE.Mesh}
   */
  static create(material) {
    const { SIZE, SEGMENTS } = WATER_CONFIG;
    const geometry = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
    geometry.rotateX(-Math.PI / 2);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = WATER_CONFIG.NAME;
    mesh.position.y = WORLD.waterLevel;
    mesh.receiveShadow = WATER_CONFIG.RECEIVE_SHADOWS;
    mesh.frustumCulled = false;

    return mesh;
  }

  /**
   * @param {THREE.Mesh} mesh
   * @param {Vector3Like} pos
   */
  static updatePosition(mesh, pos) {
    mesh.position.set(pos.x, WORLD.waterLevel, pos.z);
  }

  /**
   * @param {THREE.Mesh} mesh
   */
  static dispose(mesh) {
    mesh.geometry?.dispose();
    // material is owned by Scenery, don't dispose here
    if (mesh.parent) mesh.parent.remove(mesh);
  }
}

// ============================================================================
// Subsystem: Far Ridge
// ============================================================================

class FarRidge {
  /**
   * @param {number} seed
   * @returns {THREE.BufferGeometry}
   */
  static buildGeometry(seed) {
    const {
      RADIUS, SEGMENTS, MIN_HEIGHT, MAX_HEIGHT,
      SNOW_LINE, SNOW_BLEND_RANGE, SNOW_COLOR,
      BASE_HUE, BASE_SATURATION, BASE_LIGHTNESS_MIN, BASE_LIGHTNESS_MAX,
    } = RIDGE_CONFIG;

    const rng = mulberry32(seed ^ 0xbeef);
    const vertexCount = SEGMENTS * 6;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);

    const baseColor = new THREE.Color();
    const snowColor = new THREE.Color(SNOW_COLOR);
    const cTop0 = new THREE.Color();
    const cTop1 = new THREE.Color();
    let idx = 0;

    const write = (x, y, z, r, g, b) => {
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;
      colors[idx * 3] = r;
      colors[idx * 3 + 1] = g;
      colors[idx * 3 + 2] = b;
      idx++;
    };

    for (let i = 0; i < SEGMENTS; i++) {
      const a0 = (i / SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;

      const h0 = MIN_HEIGHT + rng() * (MAX_HEIGHT - MIN_HEIGHT);
      const h1 = MIN_HEIGHT + rng() * (MAX_HEIGHT - MIN_HEIGHT);

      const x0 = Math.cos(a0) * RADIUS, z0 = Math.sin(a0) * RADIUS;
      const x1 = Math.cos(a1) * RADIUS, z1 = Math.sin(a1) * RADIUS;

      const lightness = BASE_LIGHTNESS_MIN + rng() * (BASE_LIGHTNESS_MAX - BASE_LIGHTNESS_MIN);
      baseColor.setHSL(BASE_HUE, BASE_SATURATION, lightness);

      const sf0 = clamp((h0 - SNOW_LINE) / SNOW_BLEND_RANGE, 0, 0.5);
      const sf1 = clamp((h1 - SNOW_LINE) / SNOW_BLEND_RANGE, 0, 0.5);

      cTop0.copy(baseColor).lerp(snowColor, sf0);
      cTop1.copy(baseColor).lerp(snowColor, sf1);

      // Tri 1
      write(x0, 0, z0, baseColor.r, baseColor.g, baseColor.b);
      write(x0, h0, z0, cTop0.r, cTop0.g, cTop0.b);
      write(x1, 0, z1, baseColor.r, baseColor.g, baseColor.b);

      // Tri 2
      write(x1, 0, z1, baseColor.r, baseColor.g, baseColor.b);
      write(x0, h0, z0, cTop0.r, cTop0.g, cTop0.b);
      write(x1, h1, z1, cTop1.r, cTop1.g, cTop1.b);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * @param {number} seed
   * @returns {THREE.Mesh}
   */
  static create(seed) {
    const geometry = FarRidge.buildGeometry(seed);
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      fog: true,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = RIDGE_CONFIG.NAME;
    mesh.frustumCulled = false;
    mesh.renderOrder = RIDGE_CONFIG.RENDER_ORDER;
    return mesh;
  }

  /**
   * @param {THREE.Mesh} mesh
   * @param {Vector3Like} pos
   */
  static updatePosition(mesh, pos) {
    const ridgeY = Math.min(
      pos.y - UPDATE_CONFIG.RIDGE_HEIGHT_OFFSET,
      WORLD.waterLevel - UPDATE_CONFIG.RIDGE_MAX_HEIGHT_OFFSET
    );
    mesh.position.set(pos.x, ridgeY, pos.z);
  }

  /**
   * @param {THREE.Mesh} mesh
   */
  static dispose(mesh) {
    mesh.geometry?.dispose();
    mesh.material?.dispose();
    if (mesh.parent) mesh.parent.remove(mesh);
  }
}

// ============================================================================
// Subsystem: Surface Sampler
// ============================================================================

class SurfaceSampler {
  /**
   * @param {Object} network — RoadNetwork instance
   */
  constructor(network) {
    this._network = network;
    this._D = SURFACE_SAMPLE.FINITE_DIFFERENCE_DELTA;
  }

  /**
   * @param {number} x
   * @param {number} z
   * @returns {GroundSample}
   */
  groundAt(x, z) {
    return this._network.groundAt(x, z);
  }

  /**
   * @param {number} x
   * @param {number} z
   * @param {number} fwdX
   * @param {number} fwdZ
   * @returns {SurfaceSample}
   */
  surfaceAt(x, z, fwdX, fwdZ) {
    const D = this._D;
    const g0 = this._network.groundAt(x, z);
    const gA = this._network.groundAt(x + fwdX * D, z + fwdZ * D);
    const gR = this._network.groundAt(x - fwdZ * D, z + fwdX * D);

    const grade = (gA.y - g0.y) / D;
    const bank = (gR.y - g0.y) / D;
    const road = g0.road;

    return {
      y: g0.y,
      onRoad: g0.onRoad,
      grade,
      bank,
      lateral: road?.lateral ?? 0,
      halfWidth: road?.halfWidth ?? 5,
      roadType: road?.type ?? -1,
      bridge: road ? !!(road.flags & 1) : false,
      shoulder: road
        ? (Math.abs(road.lateral) > road.halfWidth - 1.2 &&
           Math.abs(road.lateral) <= road.halfWidth + 0.4)
        : false,
    };
  }
}

// ============================================================================
// Subsystem: Spawn Finder
// ============================================================================

class SpawnFinder {
  /**
   * @param {Object} network — RoadNetwork instance
   */
  constructor(network) {
    this._network = network;
  }

  /**
   * @returns {SpawnPose}
   */
  find() {
    const {
      HIGHWAY_ROW, STEP, MAX_DISTANCE, MIN_DISTANCE,
      INTERCHANGE_SPACING, INTERCHANGE_CLEARANCE,
      LANE_OFFSET, MAX_LATERAL, MIN_ELEVATION, FALLBACK_DISTANCE,
    } = SPAWN_CONFIG;

    const row = this._network.rows.get(HIGHWAY_ROW);
    if (!row) {
      console.warn('SpawnFinder: Highway row 0 not found, using fallback');
      return this._fallback(row, FALLBACK_DISTANCE);
    }

    for (let u = MIN_DISTANCE; u < MAX_DISTANCE; u += STEP) {
      if (this._nearInterchange(HIGHWAY_ROW, u)) continue;

      const sample = this._network.sampleAt(row, u);
      const query = this._network.query(sample.x, sample.z);

      if (query &&
          query.type === 0 &&
          Math.abs(query.lateral) < MAX_LATERAL &&
          sample.y > MIN_ELEVATION) {
        return {
          x: sample.x + (-sample.tz) * LANE_OFFSET,
          z: sample.z + (sample.tx) * LANE_OFFSET,
          y: sample.y,
          heading: Math.atan2(sample.tx, sample.tz),
        };
      }
    }

    console.warn('SpawnFinder: No valid spawn found in search range, using fallback');
    return this._fallback(row, FALLBACK_DISTANCE);
  }

  /**
   * @param {number} rowIdx
   * @param {number} u
   * @returns {boolean}
   */
  _nearInterchange(rowIdx, u) {
    const { INTERCHANGE_SPACING, INTERCHANGE_CLEARANCE } = SPAWN_CONFIG;
    const low = Math.floor(u / INTERCHANGE_SPACING);
    const high = Math.ceil(u / INTERCHANGE_SPACING);

    return [low, high].some((i) => {
      const c = this._network.crossing(rowIdx, i);
      return c && Math.abs(c.x - u) < INTERCHANGE_CLEARANCE;
    });
  }

  /**
   * @param {Object} row
   * @param {number} distance
   * @returns {SpawnPose}
   */
  _fallback(row, distance) {
    const sample = this._network.sampleAt(row, distance);
    return {
      x: sample.x,
      z: sample.z,
      y: sample.y,
      heading: Math.atan2(sample.tx, sample.tz),
    };
  }
}

// ============================================================================
// World
// ============================================================================

export class World extends THREE.EventDispatcher {
  /**
   * @param {Object} [options={}]
   * @param {number} [options.seed=1337]
   * @param {number} [options.anisotropy=4]
   * @param {string} [options.quality='medium']
   */
  constructor(options = {}) {
    super();

    const {
      seed = WORLD_DEFAULTS.SEED,
      anisotropy = WORLD_DEFAULTS.ANISOTROPY,
      quality: qualityName = WORLD_DEFAULTS.QUALITY,
    } = options;

    assertUint32(seed, 'seed');
    assertFinite(anisotropy, 'anisotropy');
    if (typeof qualityName !== 'string') {
      throw new TypeError(`quality must be a string, got ${typeof qualityName}`);
    }

    this._seed = seed >>> 0;
    this._qualityName = qualityName;
    this._quality = QUALITY[qualityName] || QUALITY.medium;

    // Scene graph root
    this.group = new THREE.Group();
    this.group.name = 'World';

    // Subsystems
    this.scenery = new Scenery(anisotropy);
    this.network = new RoadNetwork(this._seed);
    this.terrain = this.network.terrain;
    this.cities = this.network.cities;
    this.mystery = new Mystery(this._seed, this.terrain, this.network);

    this._sampler = new SurfaceSampler(this.network);
    this._spawner = new SpawnFinder(this.network);

    // Chunk streaming
    this.chunks = new ChunkManager(this.group, this, this._quality);

    // Scenery meshes
    this._water = WaterPlane.create(this.scenery.matWater);
    this._ridge = FarRidge.create(this._seed);

    this.group.add(this._water);
    this.group.add(this._ridge);
  }

  // ------------------------------------------------------------------
  // Accessors
  // ------------------------------------------------------------------

  get seed() { return this._seed; }
  get qualityName() { return this._qualityName; }
  get quality() { return this._quality; }

  // ------------------------------------------------------------------
  // Surface API
  // ------------------------------------------------------------------

  /**
   * @param {number} x
   * @param {number} z
   * @returns {GroundSample}
   */
  groundAt(x, z) {
    assertFinite(x, 'x');
    assertFinite(z, 'z');
    return this._sampler.groundAt(x, z);
  }

  /**
   * @param {number} x
   * @param {number} z
   * @param {number} fwdX
   * @param {number} fwdZ
   * @returns {SurfaceSample}
   */
  surfaceAt(x, z, fwdX, fwdZ) {
    assertFinite(x, 'x');
    assertFinite(z, 'z');
    assertFinite(fwdX, 'fwdX');
    assertFinite(fwdZ, 'fwdZ');
    return this._sampler.surfaceAt(x, z, fwdX, fwdZ);
  }

  /**
   * @param {number} x
   * @param {number} z
   * @returns {Object|null}
   */
  locate(x, z) {
    assertFinite(x, 'x');
    assertFinite(z, 'z');
    return this.network.query(x, z);
  }

  // ------------------------------------------------------------------
  // Spawning
  // ------------------------------------------------------------------

  /**
   * @returns {SpawnPose}
   */
  spawn() {
    return this._spawner.find();
  }

  // ------------------------------------------------------------------
  // Update
  // ------------------------------------------------------------------

  /**
   * @param {Vector3Like} carPos
   * @param {number} [dt=0]
   * @param {number} [budgetMs=5]
   */
  update(carPos, dt = 0, budgetMs = 5) {
    if (!carPos || typeof carPos.x !== 'number') {
      throw new TypeError('carPos must have numeric x, y, z properties');
    }

    this.chunks.update(carPos.x, carPos.z, budgetMs);

    WaterPlane.updatePosition(this._water, carPos);
    FarRidge.updatePosition(this._ridge, carPos);
  }

  // ------------------------------------------------------------------
  // Quality
  // ------------------------------------------------------------------

  /**
   * @param {string} name
   * @returns {boolean}
   */
  setQuality(name) {
    if (typeof name !== 'string') {
      console.warn(`World.setQuality: expected string, got ${typeof name}`);
      return false;
    }
    const next = QUALITY[name];
    if (!next) {
      console.warn(`World.setQuality: unknown quality "${name}"`);
      return false;
    }
    if (next === this._quality) return false;

    this._qualityName = name;
    this._quality = next;
    this.chunks.setQuality(this._quality);

    this.dispatchEvent({ type: 'qualitychanged', quality: name, config: next });
    return true;
  }

  // ------------------------------------------------------------------
  // Regeneration
  // ------------------------------------------------------------------

  /**
   * @param {number} seed
   */
  regenerate(seed) {
    assertUint32(seed, 'seed');

    this._disposeScenery();

    if (this.chunks) {
      this.chunks.clear();
    }

    this._seed = seed >>> 0;

    this.network = new RoadNetwork(this._seed);
    this.terrain = this.network.terrain;
    this.cities = this.network.cities;
    this.mystery = new Mystery(this._seed, this.terrain, this.network);

    this._sampler = new SurfaceSampler(this.network);
    this._spawner = new SpawnFinder(this.network);

    if (this.chunks) {
      this.chunks.world = this;
      this.chunks.reset?.();
    }

    this._water = WaterPlane.create(this.scenery.matWater);
    this._ridge = FarRidge.create(this._seed);
    this.group.add(this._water);
    this.group.add(this._ridge);

    this.dispatchEvent({ type: 'regenerated', seed: this._seed });
  }

  // ------------------------------------------------------------------
  // Routing
  // ------------------------------------------------------------------

  /**
   * @param {number} x
   * @param {number} z
   * @param {number} [reach=700]
   * @returns {Array}
   */
  routesNear(x, z, reach = 700) {
    assertFinite(x, 'x');
    assertFinite(z, 'z');
    assertFinite(reach, 'reach');
    return this.network.routesNearAABB(x - reach, z - reach, x + reach, z + reach);
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  destroy() {
    this._disposeScenery();

    if (this.chunks) {
      this.chunks.clear();
      if (typeof this.chunks.destroy === 'function') {
        this.chunks.destroy();
      }
    }

    this.network = null;
    this.terrain = null;
    this.cities = null;
    this.mystery = null;
    this.scenery = null;
    this.chunks = null;
    this._sampler = null;
    this._spawner = null;

    this.dispatchEvent({ type: 'destroyed' });
  }

  /**
   * @private
   */
  _disposeScenery() {
    if (this._water) {
      WaterPlane.dispose(this._water);
      this._water = null;
    }
    if (this._ridge) {
      FarRidge.dispose(this._ridge);
      this._ridge = null;
    }
  }
}
