/**
 * @fileoverview BiomeSystem — 12-biome world ecology using domain warping.
 *
 * Instead of rigid temperature/moisture grids, we warp the sample space with
 * low-frequency noise so biome boundaries feel organic (ecotones). Each biome
 * carries terrain tint, vegetation rules, and city-architecture hints.
 */

import { vnoise2, clamp } from '../core/Noise.js';

// ============================================================================
// Biome Registry
// ============================================================================

const BIOME = Object.freeze({
  OCEAN:      { id: 0,  tint: 0x1a3c5a, rough: 0.1, fertility: 0.0, treeLine: -10, label: 'Ocean' },
  BEACH:      { id: 1,  tint: 0xc2b280, rough: 0.3, fertility: 0.2, treeLine: -10, label: 'Beach' },
  DESERT:     { id: 2,  tint: 0xd4a574, rough: 0.6, fertility: 0.1, treeLine: -10, label: 'Desert' },
  SAVANNA:    { id: 3,  tint: 0x8faa5c, rough: 0.4, fertility: 0.5, treeLine: 12,  label: 'Savanna' },
  GRASSLAND:  { id: 4,  tint: 0x6b8c42, rough: 0.3, fertility: 0.7, treeLine: 18,  label: 'Grassland' },
  FOREST:     { id: 5,  tint: 0x2d5a27, rough: 0.5, fertility: 0.9, treeLine: 40,  label: 'Forest' },
  RAINFOREST: { id: 6,  tint: 0x1a3d18, rough: 0.7, fertility: 1.0, treeLine: 50,  label: 'Rainforest' },
  TAIGA:      { id: 7,  tint: 0x3a5a3a, rough: 0.5, fertility: 0.6, treeLine: 25,  label: 'Taiga' },
  TUNDRA:     { id: 8,  tint: 0x8fa38f, rough: 0.3, fertility: 0.3, treeLine: 5,   label: 'Tundra' },
  SNOW:       { id: 9,  tint: 0xeef3f8, rough: 0.4, fertility: 0.0, treeLine: -10, label: 'Snow' },
  MOUNTAIN:   { id: 10, tint: 0x5a5a5a, rough: 1.0, fertility: 0.1, treeLine: 20,  label: 'Mountain' },
  VOLCANIC:   { id: 11, tint: 0x3a2a2a, rough: 0.9, fertility: 0.0, treeLine: -10, label: 'Volcanic' },
});

const BIOME_LIST = Object.values(BIOME);

// ============================================================================
// Domain Warping
// ============================================================================

class DomainWarp {
  constructor(seed, scale = 0.0008, amp = 120) {
    this._seed = seed;
    this._scale = scale;
    this._amp = amp;
  }

  warp(x, z) {
    const dx = vnoise2(x * this._scale, z * this._scale, this._seed) * this._amp;
    const dz = vnoise2(x * this._scale + 137, z * this._scale + 293, this._seed ^ 0x1234) * this._amp;
    return { x: x + dx, z: z + dz };
  }
}

// ============================================================================
// BiomeSystem
// ============================================================================

export class BiomeSystem {
  constructor(seed, terrain) {
    this._seed = seed >>> 0;
    this._terrain = terrain;
    this._warp = new DomainWarp(this._seed);
  }

  /**
   * Sample the biome at world position (x, z).
   * @returns {{biome:Object, temp:number, moisture:number, fertility:number, roughness:number, tint:number, treeLine:number}}
   */
  sample(x, z) {
    const y = this._terrain.base(x, z);

    // Domain warp for organic boundaries
    const w = this._warp.warp(x, z);

    // Base climate gradients
    const latEffect = Math.abs(z) / 8000; // pseudo-latitude
    const tempBase = 1.0 - latEffect - y * 0.012;
    const moistBase = vnoise2(w.x * 0.001, w.z * 0.001, this._seed ^ 0xabcd);

    // Chaos layer: micro-variation
    const chaos = vnoise2(x * 0.003, z * 0.003, this._seed ^ 0xbeef);

    const temp = clamp(tempBase + chaos * 0.08, 0, 1);
    const moisture = clamp(moistBase + chaos * 0.06, 0, 1);

    // Select biome from climate coordinates
    const biome = this._pickBiome(y, temp, moisture, chaos);
    const fertility = clamp(biome.fertility + (moisture - 0.5) * 0.3, 0, 1);

    return {
      biome,
      temp,
      moisture,
      fertility,
      roughness: biome.rough,
      tint: biome.tint,
      treeLine: biome.treeLine,
    };
  }

  _pickBiome(y, temp, moisture, chaos) {
    if (y < 1.2) return BIOME.OCEAN;
    if (y < 3.5) return BIOME.BEACH;

    // Elevation overrides
    if (y > 55) {
      if (chaos > 0.75 && temp > 0.6) return BIOME.VOLCANIC;
      return BIOME.MOUNTAIN;
    }
    if (y > 40 && temp < 0.35) return BIOME.SNOW;
    if (y > 30 && temp < 0.5) return BIOME.TUNDRA;

    // Whittaker diagram approximation
    if (temp > 0.75) {
      if (moisture < 0.25) return BIOME.DESERT;
      if (moisture < 0.5) return BIOME.SAVANNA;
      if (moisture < 0.8) return BIOME.GRASSLAND;
      return BIOME.RAINFOREST;
    }
    if (temp > 0.45) {
      if (moisture < 0.3) return BIOME.GRASSLAND;
      if (moisture < 0.7) return BIOME.FOREST;
      return BIOME.RAINFOREST;
    }
    if (temp > 0.2) {
      if (moisture < 0.3) return BIOME.TUNDRA;
      return BIOME.TAIGA;
    }
    return BIOME.SNOW;
  }

  /**
   * Blend two biome tints for smooth color transitions.
   */
  blendedTint(x, z, sampleSize = 8) {
    const c0 = this.sample(x, z);
    const c1 = this.sample(x + sampleSize, z);
    const c2 = this.sample(x, z + sampleSize);
    const r = (c0.tint >> 16 & 0xff) + (c1.tint >> 16 & 0xff) + (c2.tint >> 16 & 0xff);
    const g = (c0.tint >> 8 & 0xff) + (c1.tint >> 8 & 0xff) + (c2.tint >> 8 & 0xff);
    const b = (c0.tint & 0xff) + (c1.tint & 0xff) + (c2.tint & 0xff);
    return (Math.round(r / 3) << 16) | (Math.round(g / 3) << 8) | Math.round(b / 3);
  }
}

export { BIOME };
