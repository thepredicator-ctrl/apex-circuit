/**
 * World — facade of the open world. Owns the road network, terrain field,
 * cities, mystery system, shared scenery and the chunk streamer, and exposes
 * the unified surface API the vehicle physics consumes.
 *
 *   groundAt(x, z)                 -> { y, onRoad, road, lateral }
 *   surfaceAt(x, z, fwdX, fwdZ)    -> { y, onRoad, grade, bank, ... }
 *   spawn()                        -> deterministic spawn pose on a highway
 *
 * Also renders the global water plane and the far mountain silhouette that
 * glue the horizon together.
 */

import * as THREE from 'three';

import { WORLD, QUALITY } from './core/Constants.js';
import { mulberry32 } from './core/Noise.js';
import { RoadNetwork } from './world/RoadNetwork.js';
import { ChunkManager } from './world/ChunkManager.js';
import { Mystery } from './world/Mystery.js';
import { Scenery } from './world/Scenery.js';

export class World {
  constructor(seed = 1337, aniso = 4, qualityName = 'medium') {
    this.seed = seed >>> 0;
    this.group = new THREE.Group();
    this.quality = QUALITY[qualityName] || QUALITY.medium;

    this.scenery = new Scenery(aniso);
    this.network = new RoadNetwork(this.seed);
    this.terrain = this.network.terrain;
    this.cities = this.network.cities;
    this.mystery = new Mystery(this.seed, this.terrain, this.network);

    this.chunks = new ChunkManager(this.group, this, this.quality);

    this._buildWater();
    this._buildFarRidge();
  }

  // ------------------------------------------------------------------ setup
  _buildWater() {
    const geo = new THREE.PlaneGeometry(9000, 9000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(geo, this.scenery.matWater);
    this.water.position.y = WORLD.waterLevel;
    this.water.receiveShadow = false;
    this.group.add(this.water);
  }

  _buildFarRidge() {
    // low-poly mountain silhouette ring that follows the camera — sells the
    // horizon beyond the streamed chunks
    const R = 2650;
    const seg = 96;
    const positions = [];
    const colors = [];
    const rng = mulberry32(this.seed ^ 0xbeef);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const h0 = 60 + rng() * 210;
      const h1 = 60 + rng() * 210;
      const x0 = Math.cos(a0) * R, z0 = Math.sin(a0) * R;
      const x1 = Math.cos(a1) * R, z1 = Math.sin(a1) * R;
      positions.push(x0, 0, z0, x0, h0, z0, x1, 0, z1);
      positions.push(x1, 0, z1, x0, h0, z0, x1, h1, z1);
      const c = new THREE.Color().setHSL(0.58, 0.14, 0.30 + rng() * 0.07);
      const snow0 = Math.max(0, (h0 - 150) / 110) * 0.5;
      const snow1 = Math.max(0, (h1 - 150) / 110) * 0.5;
      const cTop0 = c.clone().lerp(new THREE.Color(0xeef3f8), snow0);
      const cTop1 = c.clone().lerp(new THREE.Color(0xeef3f8), snow1);
      colors.push(c.r, c.g, c.b, cTop0.r, cTop0.g, cTop0.b, c.r, c.g, c.b);
      colors.push(c.r, c.g, c.b, cTop0.r, cTop0.g, cTop0.b, cTop1.r, cTop1.g, cTop1.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide, fog: true, depthWrite: false
    });
    this.ridge = new THREE.Mesh(geo, mat);
    this.ridge.frustumCulled = false;
    this.ridge.renderOrder = -1;
    this.group.add(this.ridge);
  }

  // -------------------------------------------------------------- surface API

  /** road-aware ground height at any world position */
  groundAt(x, z) {
    return this.network.groundAt(x, z);
  }

  /**
   * Physics surface sample: ground height + slopes projected on the car's
   * axes (finite differences), plus road context for grip decisions.
   */
  surfaceAt(x, z, fwdX, fwdZ) {
    const g0 = this.network.groundAt(x, z);
    const D = 1.6;
    const gA = this.network.groundAt(x + fwdX * D, z + fwdZ * D);
    const gR = this.network.groundAt(x - fwdZ * D, z + fwdX * D);
    const grade = (gA.y - g0.y) / D;             // dy per meter along forward
    const bank = (gR.y - g0.y) / D;              // dy per meter along right
    const road = g0.road;
    return {
      y: g0.y,
      onRoad: g0.onRoad,
      grade, bank,
      lateral: road ? road.lateral : 0,
      halfWidth: road ? road.halfWidth : 5,
      roadType: road ? road.type : -1,
      bridge: road ? !!(road.flags & 1) : false,
      shoulder: road ? (Math.abs(road.lateral) > road.halfWidth - 1.2 && Math.abs(road.lateral) <= road.halfWidth + 0.4) : false
    };
  }

  /** nearest road query (HUD road name, minimap anchor, spawn search) */
  locate(x, z) {
    return this.network.query(x, z);
  }

  /** deterministic spawn: on highway row 0, clear of interchanges */
  spawn() {
    const r = this.network.rows.get(0);
    const HS = 4200;
    for (let u = 10; u < 900; u += 10) {
      // skip interchange zones (crossings + ramps every ~4.2 km)
      const nearCross = [Math.floor(u / HS), Math.ceil(u / HS)]
        .some((i) => {
          const c = this.network.crossing(0, i);
          return c && Math.abs(c.x - u) < 220;
        });
      if (nearCross) continue;
      const s = this.network.sampleAt(r, u);
      const q = this.network.query(s.x, s.z);
      if (q && q.type === 0 && Math.abs(q.lateral) < 2 && s.y > 3) {
        // spawn in the right-hand lane (right-hand traffic)
        const off = 5.5;
        return {
          x: s.x + (-s.tz) * off,
          z: s.z + (s.tx) * off,
          y: s.y, heading: Math.atan2(s.tx, s.tz)
        };
      }
    }
    const s = this.network.sampleAt(r, 12);
    return { x: s.x, z: s.z, y: s.y, heading: Math.atan2(s.tx, s.tz) };
  }

  // ------------------------------------------------------------------ update

  update(carPos, dt = 0, budgetMs = 5) {
    this.chunks.update(carPos.x, carPos.z, budgetMs);
    // water + far ridge glue to the camera
    this.water.position.set(carPos.x, WORLD.waterLevel, carPos.z);
    this.ridge.position.set(carPos.x, Math.min(carPos.y - 30, WORLD.waterLevel - 30), carPos.z);
    // night pulse for mystery obelisks is handled via material — cheap global
  }

  setQuality(name) {
    this.quality = QUALITY[name] || QUALITY.medium;
    this.chunks.setQuality(this.quality);
  }

  /** tear everything down and rebuild from a new seed */
  regenerate(seed) {
    this.chunks.clear();
    this.seed = seed >>> 0;
    this.network = new RoadNetwork(this.seed);
    this.terrain = this.network.terrain;
    this.cities = this.network.cities;
    this.mystery = new Mystery(this.seed, this.terrain, this.network);
    this.chunks.world = this;
    this.chunks._lastCenter = { cx: 1e9, cz: 1e9 };
  }

  /** routes near a point — used by traffic spawning */
  routesNear(x, z, reach = 700) {
    return this.network.routesNearAABB(x - reach, z - reach, x + reach, z + reach);
  }
}
