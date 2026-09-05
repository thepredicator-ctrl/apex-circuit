/**
 * Terrain — the pure-function ground of the open world.
 *
 * terrainBase(x,z): low-frequency shape (continents, mountain massifs) that
 *   ROADS follow — no detail bumps, so routes can grade over it smoothly.
 * height(x,z): base + hills + detail — what the player actually sees.
 * Rivers are carved as noise bands (water-filled in lowlands where the
 * channel floor drops below sea level; dry washes higher up). Lakes / seas
 * are everything below waterLevel — the global water plane renders them.
 *
 * Biomes drive vertex colors + scenery selection: ocean, beach, plains,
 * forest, desert, mountain, snow — all deterministic from the world seed.
 */

import { vnoise1, vnoise2, fbm2, ridged2, smoothstep, clamp, lerp } from '../core/Noise.js';
import { WORLD } from '../core/Constants.js';

export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, MOUNTAIN: 5, SNOW: 6
};

export const BIOME_NAME = [
  'OCEAN', 'COAST', 'PLAINS', 'FOREST', 'DESERT', 'MOUNTAINS', 'HIGHLANDS'
];

export class Terrain {
  constructor(seed) {
    this.seed = seed >>> 0;
    const s = this.seed;
    this.sCont = s ^ 0x1a2b3c;
    this.sMountMask = s ^ 0x2b3c4d;
    this.sMount = s ^ 0x3c4d5e;
    this.sHills = s ^ 0x4d5e6f;
    this.sDetail = s ^ 0x5e6f70;
    this.sRiver = s ^ 0x6f7081;
    this.sTemp = s ^ 0x7a8b92;
    this.sMoist = s ^ 0x8b9c03;
    this.sTint = s ^ 0x9cad14;
  }

  /** continent shape: -1..1 */
  _continent(x, z) {
    const c = fbm2(x / 2600, z / 2600, this.sCont, 3) * 2 - 1;
    return c;
  }

  /** mountain massif mask 0..1 */
  _mountainMask(x, z) {
    return smoothstep(0.52, 0.8, fbm2(x / 5400, z / 5400, this.sMountMask, 2));
  }

  /** river band factor: 0 = no river, >0 = channel strength (0..1+) */
  riverAt(x, z) {
    const rn = fbm2(x / 2100, z / 2100, this.sRiver, 3);
    const band = Math.abs(rn - 0.5);
    const RIVER_W = 0.021;
    if (band > RIVER_W) return 0;
    const f = 1 - band / RIVER_W;             // 0..1 toward center
    return f * f;
  }

  /** LOW-FREQUENCY terrain — what roads grade over (no detail) */
  base(x, z) {
    const cont = this._continent(x, z);
    let y = cont * 52 - 7;                        // sea in the low third
    const mm = this._mountainMask(x, z);
    if (mm > 0.001) {
      const m = ridged2(x / 1750, z / 1750, this.sMount, 4);
      y += m * m * 130 * mm;
    }
    // wide rolling swell
    y += (fbm2(x / 900, z / 900, this.sHills, 2) - 0.5) * 18;
    // river valley carving in the BASE so roads bridge/grade over it
    const rv = this.riverAt(x, z);
    if (rv > 0 && y > -6) {
      const depth = Math.min(y + 4, 7 + rv * 6);
      y -= depth * rv;
    }
    return y;
  }

  /** full-detail terrain height (no roads) */
  height(x, z) {
    let y = this.base(x, z);
    // medium hills — roads cut through these
    y += (fbm2(x / 240, z / 240, this.sHills ^ 0x77aa, 3) - 0.5) * 2 * 9;
    // fine detail
    y += (vnoise2(x / 42, z / 42, this.sDetail) - 0.5) * 2 * 1.8;
    y += (vnoise2(x / 13, z / 13, this.sDetail ^ 0x3311) - 0.5) * 2 * 0.45;
    return y;
  }

  /** temperature 0..1 (falls with altitude) */
  tempAt(x, z, y) {
    const t = fbm2(x / 3400, z / 3400, this.sTemp, 2);
    return clamp(t - Math.max(0, y) * 0.004, 0, 1);
  }

  /** moisture 0..1 */
  moistAt(x, z) {
    return fbm2(x / 2600, z / 2600, this.sMoist, 2);
  }

  biome(x, z, y = null, slope = 0) {
    if (y === null) y = this.height(x, z);
    if (y < WORLD.waterLevel - 0.6) return BIOME.OCEAN;
    if (y < WORLD.waterLevel + 1.6) return BIOME.BEACH;
    const temp = this.tempAt(x, z, y);
    if (y > 108 || (temp < 0.22 && y > 40)) return BIOME.SNOW;
    if (y > 62 || slope > 0.55) return BIOME.MOUNTAIN;
    const moist = this.moistAt(x, z);
    if (temp > 0.62 && moist < 0.42) return BIOME.DESERT;
    if (moist > 0.54) return BIOME.FOREST;
    return BIOME.PLAINS;
  }

  /** weather-region key for Weather.js */
  region(x, z, y = null) {
    if (y === null) y = this.base(x, z);
    if (y < WORLD.waterLevel + 4) return 'coast';
    const b = this.biome(x, z, y);
    if (b === BIOME.DESERT) return 'desert';
    if (b === BIOME.MOUNTAIN || b === BIOME.SNOW) return 'mountain';
    if (b === BIOME.FOREST) return 'forest';
    return 'plains';
  }

  /**
   * Ground vertex color (linear-ish sRGB floats 0..1) for a terrain point.
   * slope: 0..1 approximate steepness. mystery: 0..1 eerie desaturation.
   */
  colorAt(x, z, y, slope, mystery, out) {
    const b = this.biome(x, z, y, slope);
    let r, g, bl;
    // base colors per biome with 2-octave patchiness
    const p1 = vnoise2(x / 60, z / 60, this.sTint);
    const p2 = vnoise2(x / 17, z / 17, this.sTint ^ 0x5157);
    const v = p1 * 0.7 + p2 * 0.3;
    switch (b) {
      case BIOME.OCEAN: {
        const d = clamp((-y) / 14, 0, 1);
        r = lerp(0.52, 0.16, d); g = lerp(0.56, 0.30, d); bl = lerp(0.42, 0.42, d);
        break;
      }
      case BIOME.BEACH: {
        r = 0.78 + v * 0.06; g = 0.71 + v * 0.06; bl = 0.52 + v * 0.05;
        break;
      }
      case BIOME.DESERT: {
        r = 0.76 + v * 0.12; g = 0.62 + v * 0.10; bl = 0.38 + v * 0.07;
        break;
      }
      case BIOME.MOUNTAIN: {
        const rock = clamp(slope * 1.2, 0, 1);
        const grass = 0.36 + v * 0.1;
        r = lerp(grass * 0.9, 0.46 + v * 0.1, rock);
        g = lerp(grass, 0.43 + v * 0.08, rock);
        bl = lerp(grass * 0.7, 0.40 + v * 0.06, rock);
        break;
      }
      case BIOME.SNOW: {
        const rock = clamp(slope * 1.4 - 0.2, 0, 1) * clamp((y - 96) / 30, 0, 1);
        r = lerp(0.93, 0.44, rock); g = lerp(0.95, 0.42, rock); bl = lerp(0.98, 0.40, rock);
        break;
      }
      case BIOME.FOREST: {
        r = 0.16 + v * 0.10; g = 0.30 + v * 0.12; bl = 0.12 + v * 0.06;
        break;
      }
      default: { // PLAINS
        const dry = smoothstep(0.4, 0.75, v);
        r = lerp(0.30, 0.55, dry); g = lerp(0.46, 0.50, dry); bl = lerp(0.16, 0.22, dry);
        break;
      }
    }
    // mystery tint: ashen, slightly violet desaturation
    if (mystery > 0) {
      const lum = (r + g + bl) / 3;
      const k = mystery * 0.55;
      r = lerp(r, lum * 0.92 + 0.04, k);
      g = lerp(g, lum * 0.88, k);
      bl = lerp(bl, lum * 1.05, k);
    }
    out[0] = r; out[1] = g; out[2] = bl;
    return b;
  }
}
