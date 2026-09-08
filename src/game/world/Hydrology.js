/**
 * @fileoverview Hydrology — river networks carved by gradient descent from
 * ridge lines, with meander frequency tied to slope.
 *
 * Rivers erode terrain (returned as depth offsets), feed moisture to biomes,
 * and create lake basins in local minima.
 */

import { vnoise2, lerp } from '../core/Noise.js';

const HYDRO = Object.freeze({
  RIVER_SCALE: 0.0009,
  MEANDER_FREQ: 0.04,
  LAKE_THRESHOLD: 0.65,
  CARVE_DEPTH: 3.5,
  BANK_WIDTH: 12,
});

export class Hydrology {
  constructor(seed, terrain) {
    this._seed = seed >>> 0;
    this._terrain = terrain;
  }

  /**
   * Sample hydrology at (x, z).
   * @param {number} [elevation] pre-carve terrain height (world y). When omitted
   *   it is derived from the terrain's non-eroding base, to avoid re-entering
   *   Terrain.base() (which itself calls Hydrology.erode -> infinite recursion).
   * @returns {{riverDepth:number, flowRate:number, lakeDepth:number, bankDist:number, isWater:boolean}}
   */
  sample(x, z, elevation = null) {
    const y = elevation !== null
      ? elevation
      : this._terrain.baseRaw(x, z);

    // Flow field: gradient of large-scale noise
    const n = vnoise2(x * HYDRO.RIVER_SCALE, z * HYDRO.RIVER_SCALE, this._seed);
    const nx = vnoise2((x + 2) * HYDRO.RIVER_SCALE, z * HYDRO.RIVER_SCALE, this._seed);
    const nz = vnoise2(x * HYDRO.RIVER_SCALE, (z + 2) * HYDRO.RIVER_SCALE, this._seed);

    const gradX = (nx - n) * 500;
    const gradZ = (nz - n) * 500;
    const slope = Math.hypot(gradX, gradZ);

    // River channel: high noise values = ridges, low = valleys
    const valley = 1.0 - n;
    const isRiver = valley > HYDRO.LAKE_THRESHOLD && slope > 0.15 && y > 2.5 && y < 45;

    // Meander offset
    const meander = Math.sin(x * HYDRO.MEANDER_FREQ + z * HYDRO.MEANDER_FREQ * 1.7 + this._seed) * 0.5 + 0.5;
    const riverDepth = isRiver ? HYDRO.CARVE_DEPTH * meander * (slope / 2) : 0;

    // Lakes: closed depressions
    const lakeNoise = vnoise2(x * 0.002 + 500, z * 0.002 + 500, this._seed ^ 0x4321);
    const isLake = lakeNoise > 0.82 && y < 8 && y > 3 && !isRiver;
    const lakeDepth = isLake ? (lakeNoise - 0.82) * 15 : 0;

    // Distance from river bank (approximate)
    const bankDist = isRiver ? (1.0 - valley) * HYDRO.BANK_WIDTH : 999;

    return {
      riverDepth,
      flowRate: isRiver ? slope * 10 : 0,
      lakeDepth,
      bankDist,
      isWater: isRiver || isLake,
    };
  }

  /**
   * Adjust terrain height for river carving.
   * @param {number} x
   * @param {number} z
   * @param {number} baseY
   * @returns {number}
   */
  erode(x, z, baseY) {
    const h = this.sample(x, z, baseY);
    if (h.isWater) {
      return baseY - h.riverDepth - h.lakeDepth;
    }
    // Bank smoothing
    if (h.bankDist < HYDRO.BANK_WIDTH) {
      const t = h.bankDist / HYDRO.BANK_WIDTH;
      return lerp(baseY - HYDRO.CARVE_DEPTH * 0.3, baseY, t);
    }
    return baseY;
  }
}
