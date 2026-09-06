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
});

const RIDGE_CONFIG = Object.freeze({
  RADIUS: 2650,
  SEGMENTS: 96,
  MIN_HEIGHT: 60,
  MAX_HEIGHT: 270,        // 60 + 210
  SNOW_LINE: 150,
  SNOW_BLEND_RANGE: 110,
  SNOW_COLOR: 0xeef3f8,
  BASE_HUE: 0.58,
  BASE_SATURATION: 0.14,
  BASE_LIGHTNESS_MIN: 0.30,
  BASE_LIGHTNESS_MAX: 0.37,
  RENDER_ORDER: -1,
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
// Type Definitions (JSDoc)
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
 * @property {number} grade     - dy per meter along forward
 * @property {number} bank      - dy per meter along right
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
// Utility Functions
// ============================================================================

/**
 * Clamps a value between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Validates that a value is a finite number.
 * @param {*} value
 * @param {string} name
 * @throws {TypeError}
 */
const assertFinite = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got ${value}`);
  }
};

/**
 * Validates that a value is a non-negative integer.
 * @param {*} value
 * @param {string} name
 * @throws {TypeError}
 */
const assertUint32 = (value, name) => {
  if (typeof value !== 'number' || value < 0 || value > 0xFFFFFFFF || (value | 0) !== value) {
    throw new TypeError(`${name} must be a uint32, got ${value}`);
  }
};

// ============================================================================
// Helper Classes
// ============================================================================

/**
 * Builds the far mountain ridge geometry. Extracted from World to keep the
 * facade class focused on orchestration, not vertex math.
 */
class RidgeBuilder {
  /**
   * @param {number} seed
   * @returns {THREE.BufferGeometry}
   */
  static build(seed) {
    const { RADIUS, SEGMENTS, MIN_HEIGHT, MAX_HEIGHT, SNOW_LINE, SNOW_BLEND_RANGE, SNOW_COLOR } = RIDGE_CONFIG;
    const rng = mulberry32(seed ^ 0xbeef);

    const vertexCount = SEGMENTS * 6; // 2 triangles per segment
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);

    const baseColor = new THREE.Color();
    const snowColor = new THREE.Color(SNOW_COLOR);
    const c0 = new THREE.Color();
    const c1 = new THREE.Color();
    let writeIndex = 0;

    const writeVertex = (x, y, z, r, g, b) => {
      positions[writeIndex * 3 + 0] = x;
      positions[writeIndex * 3 + 1] = y;
      positions[writeIndex * 3 + 2] = z;
      colors[writeIndex * 3 + 0] = r;
      colors[writeIndex * 3 + 1] = g;
      colors[writeIndex * 3 + 2] = b;
      writeIndex++;
    };

    for (let i = 0; i < SEGMENTS; i++) {
      const a0 = (i / SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;

      const h0 = MIN_HEIGHT + rng() * (MAX_HEIGHT - MIN_HEIGHT);
      const h1 = MIN_HEIGHT + rng() * (MAX_HEIGHT - MIN_HEIGHT);

      const x0 = Math.cos(a0) * RADIUS;
      const z0 = Math.sin(a0) * RADIUS;
      const x1 = Math.cos(a1) * RADIUS;
      const z1 = Math.sin(a1) * RADIUS;

      // Compute colors with snow blending
      const lightness = RIDGE_CONFIG.BASE_LIGHTNESS_MIN + rng() * (RIDGE_CONFIG.BASE_LIGHTNESS_MAX - RIDGE_CONFIG.BASE_LIGHTNESS_MIN);
      baseColor.setHSL(RIDGE_CONFIG.BASE_HUE, RIDGE_CONFIG.BASE_SATURATION, lightness);

      const snowFactor0 = clamp((h0 - SNOW_LINE) / SNOW_BLEND_RANGE, 0, 0.5);
      const snowFactor1 = clamp((h1 - SNOW_LINE) / SNOW_BLEND_RANGE, 0, 0.5);

      c0.copy(baseColor).lerp(snowColor, snowFactor0);
      c1.copy(baseColor).lerp(snowColor, snowFactor1);

      // Triangle 1: (x0,0,z0), (x0,h0,z0), (x1,0,z1)
      writeVertex(x0, 0, z0, baseColor.r, baseColor.g, baseColor.b);
      writeVertex(x0, h0, z0, c0.r, c0.g, c0.b);
      writeVertex(x1, 0, z1, baseColor.r, baseColor.g, baseColor.b);

      // Triangle 2: (x1,0,z1), (x0,h0,z0), (x1,h1,z1)
      writeVertex(x1, 0, z1, baseColor.r, baseColor.g, baseColor.b);
      writeVertex(x0, h0, z0, c0.r, c0.g, c0.b);
      writeVertex(x1, h1, z1, c1.r, c1.g, c1.b);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    return geometry;
  }
}

// ============================================================================
// World
// ============================================================================

export class World extends THREE.EventDispatcher {
  /**
   * Creates a new World instance.
   *
   * @param {Object} [options={}]
   * @param {number} [options.seed=1337]          - 32-bit unsigned integer seed
   * @param {number} [options.anisotropy=4]       - Texture anisotropy level
   * @param {string} [options.quality='medium']   - Quality preset name
   * @throws {TypeError} On invalid parameters
   */
  constructor(options = {}) {
    super(); // Enable event dispatching for lifecycle hooks

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

    // Chunk streaming
    this.chunks = new ChunkManager(this.group, this, this._quality);

    // Disposable geometry/material references for cleanup
    /** @type {THREE.Mesh[]} */
    this._disposables = [];

    // Build static scenery
    this._buildWater();
    this._buildFarRidge();
  }

  // ------------------------------------------------------------------
  // Accessors
  // ------------------------------------------------------------------

  /** @returns {number} The current world seed. */
  get seed() { return this._seed; }

  /** @returns {string} The current quality preset name. */
  get qualityName() { return this._qualityName; }

  /** @returns {Object} The current quality configuration object. */
  get quality() { return this._quality; }

  // ------------------------------------------------------------------
  // Construction
  // ------------------------------------------------------------------

  /**
   * Builds the global water plane.
   * @private
   */
  _buildWater() {
    const { SIZE, SEGMENTS, RECEIVE_SHADOWS } = WATER_CONFIG;

    const geometry = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
    geometry.rotateX(-Math.PI / 2);

    this.water = new THREE.Mesh(geometry, this.scenery.matWater);
    this.water.name = 'Water';
    this.water.position.y = WORLD.waterLevel;
    this.water.receiveShadow = RECEIVE_SHADOWS;

    this.group.add(this.water);
    this._disposables.push(this.water);
  }

  /**
   * Builds the far mountain silhouette ring.
   * @private
   */
  _buildFarRidge() {
    const geometry = RidgeBuilder.build(this._seed);

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      fog: true,
      depthWrite: false,
    });

    this.ridge = new THREE.Mesh(geometry, material);
    this.ridge.name = 'FarRidge';
    this.ridge.frustumCulled = false;
    this.ridge.renderOrder = RIDGE_CONFIG.RENDER_ORDER;

    this.group.add(this.ridge);
    this._disposables.push(this.ridge);
  }

  // ------------------------------------------------------------------
  // Surface API
  // ------------------------------------------------------------------

  /**
   * Returns the road-aware ground height at any world position.
   *
   * @param {number} x - World X coordinate
   * @param {number} z - World Z coordinate
   * @returns {GroundSample}
   * @throws {TypeError} If coordinates are not finite numbers
   */
  groundAt(x, z) {
    assertFinite(x, 'x');
    assertFinite(z, 'z');
    return this.network.groundAt(x, z);
  }

  /**
   * Samples the physics surface at a point, computing grade and bank relative
   * to the vehicle's forward direction using central finite differences.
   *
   * @param {number} x - World X coordinate
   * @param {number} z - World Z coordinate
   * @param {number} fwdX - Forward vector X component (should be normalized)
   * @param {number} fwdZ - Forward vector Z component (should be normalized)
   * @returns {SurfaceSample}
   * @throws {TypeError} If inputs are not finite numbers
   */
  surfaceAt(x, z, fwdX, fwdZ) {
    assertFinite(x, 'x');
    assertFinite(z, 'z');
    assertFinite(fwdX, 'fwdX');
    assertFinite(fwdZ, 'fwdZ');

    const D = SURFACE_SAMPLE.FINITE_DIFFERENCE_DELTA;

    // Sample center, forward, and right offsets
    const g0 = this.network.groundAt(x, z);
    const gA = this.network.groundAt(x + fwdX * D, z + fwdZ * D);
    const gR = this.network.groundAt(x - fwdZ * D, z + fwdX * D);

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

  /**
   * Finds the nearest road to a world position.
   * Useful for HUD road names, minimap anchors, and spawn search.
   *
   * @param {number} x - World X coordinate
   * @param {number} z - World Z coordinate
   * @returns {Object|null} Road query result or null
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
   * Computes a deterministic spawn pose on a highway, clear of interchanges.
   * Searches along highway row 0 for a suitable lane position.
   *
   * @returns {SpawnPose}
   */
  spawn() {
    const {
      HIGHWAY_ROW, STEP, MAX_DISTANCE, MIN_DISTANCE,
      INTERCHANGE_SPACING, INTERCHANGE_CLEARANCE,
      LANE_OFFSET, MAX_LATERAL, MIN_ELEVATION, FALLBACK_DISTANCE,
    } = SPAWN_CONFIG;

    const row = this.network.rows.get(HIGHWAY_ROW);
    if (!row) {
      console.warn('World.spawn: Highway row 0 not found, using fallback');
      return this._fallbackSpawn(row, FALLBACK_DISTANCE);
    }

    // Search forward in steps, skipping interchange zones
    for (let u = MIN_DISTANCE; u < MAX_DISTANCE; u += STEP) {
      const crossIndexLow = Math.floor(u / INTERCHANGE_SPACING);
      const crossIndexHigh = Math.ceil(u / INTERCHANGE_SPACING);

      const nearCross = [crossIndexLow, crossIndexHigh].some((i) => {
        const crossing = this.network.crossing(HIGHWAY_ROW, i);
        return crossing && Math.abs(crossing.x - u) < INTERCHANGE_CLEARANCE;
      });

      if (nearCross) continue;

      const sample = this.network.sampleAt(row, u);
      const query = this.network.query(sample.x, sample.z);

      // Valid spawn: on highway, centered in lane, above water
      const isValid = query &&
        query.type === 0 &&
        Math.abs(query.lateral) < MAX_LATERAL &&
        sample.y > MIN_ELEVATION;

      if (isValid) {
        // Right-hand traffic: offset to right lane
        return {
          x: sample.x + (-sample.tz) * LANE_OFFSET,
          z: sample.z + (sample.tx) * LANE_OFFSET,
          y: sample.y,
          heading: Math.atan2(sample.tx, sample.tz),
        };
      }
    }

    // Fallback: return a safe position near the start
    console.warn('World.spawn: No valid spawn found in search range, using fallback');
    return this._fallbackSpawn(row, FALLBACK_DISTANCE);
  }

  /**
   * Emergency fallback spawn when primary search fails.
   * @param {Object} row - Highway row
   * @param {number} distance - Distance along the row
   * @returns {SpawnPose}
   * @private
   */
  _fallbackSpawn(row, distance) {
    const sample = this.network.sampleAt(row, distance);
    return {
      x: sample.x,
      z: sample.z,
      y: sample.y,
      heading: Math.atan2(sample.tx, sample.tz),
    };
  }

  // ------------------------------------------------------------------
  // Update Loop
  // ------------------------------------------------------------------

  /**
   * Updates the world state for the current frame.
   *
   * @param {Vector3Like} carPos - Current vehicle position
   * @param {number} [dt=0] - Delta time in seconds
   * @param {number} [budgetMs=5] - Chunk generation budget per frame
   */
  update(carPos, dt = 0, budgetMs = 5) {
    if (!carPos || typeof carPos.x !== 'number') {
      throw new TypeError('carPos must be an object with numeric x, y, z properties');
    }

    // Stream chunks around the camera
    this.chunks.update(carPos.x, carPos.z, budgetMs);

    // Glue water and ridge to camera for infinite horizon illusion
    this.water.position.set(carPos.x, WORLD.waterLevel, carPos.z);

    const ridgeY = Math.min(
      carPos.y - UPDATE_CONFIG.RIDGE_HEIGHT_OFFSET,
      WORLD.waterLevel - UPDATE_CONFIG.RIDGE_MAX_HEIGHT_OFFSET
    );
    this.ridge.position.set(carPos.x, ridgeY, carPos.z);

    // Mystery obelisk night pulse is handled via cheap global material uniform
  }

  // ------------------------------------------------------------------
  // Quality Management
  // ------------------------------------------------------------------

  /**
   * Changes the rendering quality preset at runtime.
   *
   * @param {string} name - Quality preset name (e.g. 'low', 'medium', 'high')
   * @returns {boolean} True if the quality was changed, false if unchanged
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
   * Tears down the current world and rebuilds from a new seed.
   * Properly disposes Three.js geometry and materials to prevent leaks.
   *
   * @param {number} seed - New 32-bit unsigned integer seed
   */
  regenerate(seed) {
    assertUint32(seed, 'seed');

    // Dispose old geometry/materials to prevent GPU memory leaks
    this._disposeScenery();

    // Clear chunk streaming state
    this.chunks.clear();

    // Re-seed
    this._seed = seed >>> 0;

    // Rebuild subsystems
    this.network = new RoadNetwork(this._seed);
    this.terrain = this.network.terrain;
    this.cities = this.network.cities;
    this.mystery = new Mystery(this._seed, this.terrain, this.network);

    // Re-link chunk manager
    this.chunks.world = this;
    this.chunks._lastCenter = { cx: Infinity, cz: Infinity };

    // Rebuild scenery
    this._buildWater();
    this._buildFarRidge();

    this.dispatchEvent({ type: 'regenerated', seed: this._seed });
  }

  /**
   * Disposes all tracked disposable meshes and their geometries/materials.
   * @private
   */
  _disposeScenery() {
    for (const mesh of this._disposables) {
      if (!mesh) continue;

      if (mesh.geometry) {
        mesh.geometry.dispose();
      }

      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(m => m.dispose());
      } else if (mesh.material) {
        mesh.material.dispose();
      }

      if (mesh.parent) {
        mesh.parent.remove(mesh);
      }
    }
    this._disposables.length = 0;
  }

  // ------------------------------------------------------------------
  // Traffic / Routing
  // ------------------------------------------------------------------

  /**
   * Returns routes near a point, used by traffic spawning systems.
   *
   * @param {number} x - World X coordinate
   * @param {number} z - World Z coordinate
   * @param {number} [reach=700] - Search radius / half-extent
   * @returns {Array} Array of route objects
   */
  routesNear(x, z, reach = 700) {
    assertFinite(x, 'x');
    assertFinite(z, 'z');
    assertFinite(reach, 'reach');

    return this.network.routesNearAABB(
      x - reach,
      z - reach,
      x + reach,
      z + reach
    );
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Fully destroys the world, releasing all GPU and CPU resources.
   * The instance should not be used after calling this.
   */
  destroy() {
    this._disposeScenery();
    this.chunks.clear();
    this.chunks.destroy?.();

    // Null out references to help GC
    this.network = null;
    this.terrain = null;
    this.cities = null;
    this.mystery = null;
    this.scenery = null;
    this.chunks = null;

    this.dispatchEvent({ type: 'destroyed' });
  }
}
