/**
 * Mystery — the far-field strangeness system.
 *
 * The farther the player drives from the origin, the less civilized and the
 * more unusual the world becomes. There is no meter and no UI: changes are
 * environmental (ashen terrain tints, dead vegetation, abandoned structures,
 * rare impossible landmarks) and the player discovers them naturally.
 *
 * Everything is deterministic per-chunk from the world seed, so structures
 * persist across sessions and are identical for every player of that world.
 */

import * as THREE from 'three';
import { mulberry32, hash2i, clamp, smoothstep } from '../core/Noise.js';
import { MYSTERY } from '../core/Constants.js';

const CS = 192;

const TYPES = ['monolith', 'arches', 'wrecks', 'stones', 'grove', 'obelisk'];

export class Mystery {
  constructor(seed, terrain, network) {
    this.seed = seed >>> 0;
    this.terrain = terrain;
    this.network = network;
    this._chunkCache = new Map();
    this.discovered = new Set();
    this.onDiscover = null;
  }

  /** strangeness 0..1 at a world position (subtle near, strong far) */
  intensity(x, z) {
    const d = Math.hypot(x, z);
    return smoothstep(MYSTERY.onset, MYSTERY.full, d);
  }

  /** deterministic structure slot for a chunk — null most of the time */
  structureForChunk(cx, cz) {
    const key = cx + ':' + cz;
    if (this._chunkCache.has(key)) return this._chunkCache.get(key);
    let out = null;
    const x = cx * CS + CS / 2;
    const z = cz * CS + CS / 2;
    const w = this.intensity(x, z);
    if (w > 0.04) {
      const rng = mulberry32((this.seed ^ Math.imul(cx, 374761393) ^ Math.imul(cz, 668265263)) >>> 0);
      const chance = 0.002 + w * 0.028;
      if (rng() < chance) {
        // position inside chunk, off-road
        for (let tries = 0; tries < 8; tries++) {
          const px = cx * CS + 20 + rng() * (CS - 40);
          const pz = cz * CS + 20 + rng() * (CS - 40);
          const q = this.network.query(px, pz);
          if (q && q.absPerp < q.halfWidth + 12) continue;
          const y = this.terrain.height(px, pz);
          if (y < 1 || y > 110) continue;
          const type = TYPES[Math.floor(rng() * TYPES.length * clamp(0.4 + w, 0, 1)) % TYPES.length];
          out = {
            type, x: px, z: pz, y,
            rot: rng() * Math.PI * 2,
            scale: 0.8 + rng() * 1.2,
            seed: Math.floor(rng() * 1e9)
          };
          break;
        }
      }
    }
    this._chunkCache.set(key, out);
    if (this._chunkCache.size > 2000) this._chunkCache.clear();
    return out;
  }

  /** build the structure as a THREE.Group (chunk builder consumes) */
  buildStructure(s, scenery) {
    const g = new THREE.Group();
    const rng = mulberry32(s.seed);
    const M = scenery.matMystery;

    const add = (mesh, x, y, z, ry, sc = 1) => {
      mesh.position.set(x, y, z);
      mesh.rotation.y = ry;
      mesh.scale.setScalar(sc);
      mesh.castShadow = true;
      g.add(mesh);
    };

    switch (s.type) {
      case 'monolith': {
        // ring of leaning slabs around a center
        const n = 5 + Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const r = 7 + rng() * 5;
          const m = new THREE.Mesh(scenery.monolithGeo, M);
          m.rotation.z = (rng() - 0.5) * 0.22;
          add(m, Math.cos(a) * r, 0, Math.sin(a) * r, rng() * Math.PI * 2, s.scale * (0.7 + rng() * 0.8));
        }
        break;
      }
      case 'arches': {
        for (let i = 0; i < 2 + Math.floor(rng() * 2); i++) {
          const m = new THREE.Mesh(scenery.archGeo, M);
          add(m, (rng() - 0.5) * 14, 0, (rng() - 0.5) * 14, s.rot + rng() * 0.6, s.scale);
        }
        break;
      }
      case 'wrecks': {
        // abandoned pile-up
        const n = 3 + Math.floor(rng() * 4);
        for (let i = 0; i < n; i++) {
          const mat = new THREE.MeshStandardMaterial({
            color: [0x6b3a2a, 0x4a4a50, 0x57603e, 0x3c4650][Math.floor(rng() * 4)],
            roughness: 0.9, metalness: 0.25, flatShading: true
          });
          const m = new THREE.Mesh(scenery.wreckGeo, mat);
          m.rotation.z = (rng() - 0.5) * 0.3;
          add(m, (rng() - 0.5) * 18, 0, (rng() - 0.5) * 18, rng() * Math.PI * 2, 0.9 + rng() * 0.4);
        }
        break;
      }
      case 'stones': {
        const n = 7 + Math.floor(rng() * 4);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const r = 9;
          const m = new THREE.Mesh(scenery.stoneGeo, M);
          m.rotation.z = (rng() - 0.5) * 0.1;
          add(m, Math.cos(a) * r, -0.3, Math.sin(a) * r, a, 1 + rng() * 0.4);
        }
        break;
      }
      case 'grove': {
        for (let i = 0; i < 10; i++) {
          const m = new THREE.Mesh(scenery.deadTreeGeo, scenery.matTree);
          add(m, (rng() - 0.5) * 30, -0.1, (rng() - 0.5) * 30, rng() * Math.PI * 2, 0.9 + rng() * 0.9);
        }
        break;
      }
      case 'obelisk': {
        // the rare impossible thing: a black monolith that hums with light
        const core = new THREE.Mesh(new THREE.BoxGeometry(2.2, 16, 1.1), M);
        core.position.y = 8;
        core.castShadow = true;
        const halo = new THREE.Mesh(
          new THREE.BoxGeometry(2.5, 16.3, 1.35),
          new THREE.MeshBasicMaterial({ color: 0x113322, transparent: true, opacity: 0.25, toneMapped: false })
        );
        halo.position.y = 8;
        g.add(core, halo);
        g.position.set(s.x, s.y, s.z);
        g.rotation.y = s.rot;
        g.userData.pulse = true;
        return g;
      }
    }
    g.position.set(s.x, s.y - 0.2, s.z);
    return g;
  }

  /** returns a discovery label when the player first nears a structure */
  checkDiscovery(x, z) {
    const ccx = Math.floor(x / CS), ccz = Math.floor(z / CS);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const s = this.structureForChunk(ccx + dx, ccz + dz);
        if (!s) continue;
        const key = (ccx + dx) + ':' + (ccz + dz);
        if (this.discovered.has(key)) continue;
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < MYSTERY.discoverRadius) {
          this.discovered.add(key);
          const labels = {
            monolith: 'A RING OF STANDING SLABS',
            arches: 'ARCHES WITH NO BUILDING',
            wrecks: 'AN ABANDONED PILE-UP',
            stones: 'A CIRCLE OF ANCIENT STONES',
            grove: 'A GROVE OF DEAD TREES',
            obelisk: 'SOMETHING IMPOSSIBLE'
          };
          if (this.onDiscover) this.onDiscover(labels[s.type] || 'SOMETHING STRANGE');
          return true;
        }
      }
    }
    return false;
  }
}
