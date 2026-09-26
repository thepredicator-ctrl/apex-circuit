/**
 * RNG — deterministic seeded random utilities.
 *
 * Every drift map is fully derived from a short text seed: same seed in,
 * same map out, on every device. mulberry32 gives a fast, high-quality
 * 32-bit stream; xmur3 hashes the text seed into the initial state.
 */

/** Hash a string into a 32-bit state generator (xmur3). */
export function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** Create a seeded PRNG function returning floats in [0, 1). */
export function makeRNG(str) {
  const seed = hashSeed(String(str))();
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Float in [a, b). */
export function range(rng, a, b) {
  return a + rng() * (b - a);
}

/** Integer in [a, b] inclusive. */
export function int(rng, a, b) {
  return Math.floor(range(rng, a, b + 1));
}

/** Random element of an array. */
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** True with probability p. */
export function chance(rng, p) {
  return rng() < p;
}

const ADJ = ['ember', 'midnight', 'cobra', 'tokyo', 'smoke', 'velvet', 'thunder', 'sakura', 'neon', 'ghost', 'royal', 'delta', 'onyx', 'cyber', 'harbor', 'sunset'];
const NOUN = ['circuit', 'drift', 'apex', 'slide', 'tire', 'turbo', 'angle', 'counter', 'clutch', 'feather', 'gesture', 'zone', 'loop', 'kanjo', 'touge', 'park'];

/** A random human-friendly seed like "neon-touge-482". */
export function randomSeed() {
  const r = makeRNG(String(Date.now() ^ (Math.random() * 0xffffffff)));
  return `${pick(r, ADJ)}-${pick(r, NOUN)}-${int(r, 100, 999)}`;
}
