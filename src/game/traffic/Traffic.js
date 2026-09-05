/**
 * Traffic — procedural AI vehicles that understand the road network.
 *
 * Vehicles follow route lanes (right-hand traffic), keep car-length gaps,
 * brake for the player and each other, overtake slow traffic on the left
 * when the oncoming lane is clear, and yield near junctions. Spawn rate and
 * speed targets depend on the location (highways flow fast, city streets
 * crawl, wilderness stays lonely).
 *
 * Fleet: pooled low-poly vehicles (sedan / van / truck) with per-instance
 * color, emissive head/tail lights at night. Far vehicles despawn; the pool
 * recycles them near the player.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TRAFFIC, WORLD, ROAD } from '../core/Constants.js';
import { mulberry32, clamp } from '../core/Noise.js';

// ------------------------------------------------------------ fleet geometry

function sedanGeo() {
  const body = new THREE.BoxGeometry(1.78, 0.55, 4.1);
  body.translate(0, 0.62, 0);
  const cabin = new THREE.BoxGeometry(1.6, 0.5, 2.1);
  cabin.translate(0, 1.1, -0.25);
  const nose = new THREE.BoxGeometry(1.72, 0.3, 0.7);
  nose.translate(0, 0.5, 2.0);
  return mergeGeometries([body, cabin, nose], false);
}
function vanGeo() {
  const body = new THREE.BoxGeometry(1.9, 1.5, 4.6);
  body.translate(0, 1.05, 0);
  const nose = new THREE.BoxGeometry(1.86, 0.8, 0.9);
  nose.translate(0, 0.62, 2.5);
  return mergeGeometries([body, nose], false);
}
function truckGeo() {
  const cab = new THREE.BoxGeometry(2.2, 2.0, 2.2);
  cab.translate(0, 1.45, 2.6);
  const box = new THREE.BoxGeometry(2.3, 2.4, 5.6);
  box.translate(0, 1.7, -0.9);
  return mergeGeometries([cab, box], false);
}

const FLEET_COLORS = [
  0xb8bcc2, 0x2c3038, 0x8c1f28, 0x1f3a5c, 0x7a7f86, 0xc9c5ba,
  0x3f4c42, 0x5b3a5e, 0x9c6a1f, 0x384248
];

export class Traffic {
  constructor(scene, world, isMobile) {
    this.scene = scene;
    this.world = world;
    this.enabled = true;
    this.vehicles = [];
    this.rng = mulberry32(world.seed ^ 0x7422);

    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.5, metalness: 0.35
    });
    this.mat = mat;
    this.matNightTail = new THREE.MeshBasicMaterial({ color: 0x300408, toneMapped: false });

    this.geos = [sedanGeo(), vanGeo(), truckGeo()];
    this.weights = [0.62, 0.24, 0.14];

    // pooled meshes: each vehicle = one mesh (switch geometry per recycle)
    const max = isMobile ? 18 : TRAFFIC.maxActive;
    this.max = max;
    for (let i = 0; i < max; i++) {
      const m = new THREE.Mesh(this.geos[0], mat.clone());
      m.castShadow = false;
      m.receiveShadow = false;
      m.visible = false;
      m.userData = {
        active: false,
        route: null, kind: 'row', u: 0, dir: 1, lane: 0,
        speed: 0, targetSpeed: 20, type: 0,
        brakeT: 0, overtakeT: 0,
        pos: new THREE.Vector3(),
        color: 0xffffff
      };
      scene.add(m);
      this.vehicles.push(m);
    }

    this._accum = 0;
    this._updateInterval = 1 / TRAFFIC.updateHz;
    this._tmp = new THREE.Vector3();
    this._night = false;
  }

  setNight(night) {
    if (this._night === night) return;
    this._night = night;
    for (const v of this.vehicles) {
      v.material.emissive = new THREE.Color(night ? 0x101418 : 0x000000);
      v.material.emissiveIntensity = night ? 0.35 : 0;
    }
  }

  // -------------------------------------------------------------- spawning

  _pickRoute(px, pz) {
    const routes = this.world.routesNear(px, pz, TRAFFIC.spawnMax + 150);
    if (!routes.length) return null;
    // weight: highways/busy roads near the player first
    for (let tries = 0; tries < 6; tries++) {
      const r = routes[Math.floor(this.rng() * routes.length)];
      // choose a param near the player
      let u;
      if (r.kind === 'row') u = px + (this.rng() - 0.5) * TRAFFIC.spawnMax * 2;
      else if (r.kind === 'col') u = pz + (this.rng() - 0.5) * TRAFFIC.spawnMax * 2;
      else if (r.kind === 'ring') u = (this.rng() * 2 - 1) * Math.PI;
      else continue;
      const s = this._sample(r, u);
      if (!s) continue;
      const d = Math.hypot(s.x - px, s.z - pz);
      if (d < TRAFFIC.spawnMin || d > TRAFFIC.spawnMax + 150) continue;
      return { route: r, u };
    }
    return null;
  }

  _sample(route, u) {
    const net = this.world.network;
    try {
      if (route.kind === 'row' || route.kind === 'col') return net.sampleAt(route, u);
      if (route.kind === 'ring') {
        const city = route.city;
        const cities = this.world.cities;
        const r = cities.ringRadiusAt(city, u);
        const e = cities._ringElevation(city);
        const N = 512;
        const fi = ((u / (Math.PI * 2)) * N + N) % N;
        const i0 = Math.floor(fi) % N, i1 = (i0 + 1) % N;
        const t = fi - Math.floor(fi);
        const y = e[i0] + (e[i1] - e[i0]) * t;
        return {
          x: city.x + Math.cos(u) * r,
          y: y,
          z: city.z + Math.sin(u) * r,
          tx: -Math.sin(u), tz: Math.cos(u)
        };
      }
      if (route.kind === 'street') {
        return this.world.cities.streetPoint(route.city, route.st, u);
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  _laneOffset(type, dir) {
    // right-hand traffic: right side of travel dir
    const hw = type === ROAD.HIGHWAY ? 5.4 : 2.6;
    return -dir * hw; // lateral sign: dir +1 → drive on +lateral (right side)
  }

  _spawnOne(px, pz) {
    const slot = this.vehicles.find((v) => !v.userData.active);
    if (!slot) return;
    const pick = this._pickRoute(px, pz);
    if (!pick) return;

    const d = this.world.network.groundAt(pick.route.kind === 'ring' ? 1e9 : 0, 0);
    const dir = this.rng() < 0.5 ? 1 : -1;
    const ud = slot.userData;
    ud.active = true;
    ud.route = pick.route;
    ud.u = pick.u;
    ud.dir = dir;
    ud.lane = this._laneOffset(pick.route.type ?? ROAD.HIGHWAY, dir);
    ud.type = this._weightedType();
    ud.speed = 8 + this.rng() * 8;
    ud.targetSpeed = this._speedFor(pick.route);
    ud.overtakeT = 0;
    slot.geometry = this.geos[ud.type];
    slot.material.color.setHex(FLEET_COLORS[Math.floor(this.rng() * FLEET_COLORS.length)]);
    slot.visible = true;
  }

  _weightedType() {
    const r = this.rng();
    if (r < this.weights[0]) return 0;
    if (r < this.weights[0] + this.weights[1]) return 1;
    return 2;
  }

  _speedFor(route) {
    const type = route.type ?? ROAD.HIGHWAY;
    if (type === ROAD.HIGHWAY) return 26 + this.rng() * 9;
    if (type === ROAD.AVENUE) return 17 + this.rng() * 6;
    if (type === ROAD.RING) return 20 + this.rng() * 6;
    if (type === ROAD.STREET) return 9 + this.rng() * 4;
    return 12;
  }

  // -------------------------------------------------------------- update

  update(dt, playerPos, playerVel, night) {
    this.setNight(night);
    if (!this.enabled) {
      for (const v of this.vehicles) v.visible = false;
      return;
    }

    // spawn pacing
    this._accum += dt;
    const activeCount = this.vehicles.reduce((a, v) => a + (v.userData.active ? 1 : 0), 0);
    if (this._accum > 0.25 && activeCount < this.max) {
      this._accum = 0;
      // density by location: cities & highways busier, wilderness empty
      const q = this.world.locate(playerPos.x, playerPos.z);
      const cityNear = this.world.cities.near(playerPos.x, playerPos.z, 900).length > 0;
      const want = cityNear ? this.max : (q && q.type === ROAD.HIGHWAY ? Math.floor(this.max * 0.7) : Math.floor(this.max * 0.35));
      if (activeCount < want) this._spawnOne(playerPos.x, playerPos.z);
    }

    // AI tick (staggered)
    this._aiAccum = (this._aiAccum || 0) + dt;
    const doAI = this._aiAccum >= this._updateInterval;
    if (doAI) this._aiAccum = 0;

    for (const v of this.vehicles) {
      const ud = v.userData;
      if (!ud.active) continue;

      if (doAI) this._think(v, playerPos);

      // integrate along route
      const speed = ud.speed * ud.dir;
      ud.u += speed * dt;

      const s = this._sample(ud.route, ud.u);
      if (!s) { ud.active = false; v.visible = false; continue; }

      // world position with lane offset (right of travel = (-tz, tx))
      const rx = -s.tz, rz = s.tx;
      const px = s.x + rx * ud.lane * (ud.dir > 0 ? 1 : 1);
      const pz = s.z + rz * ud.lane;
      v.position.set(px, s.y + 0.05, pz);
      const heading = Math.atan2(s.tx * ud.dir, s.tz * ud.dir);
      v.rotation.set(0, heading, 0);

      // despawn far
      const d = Math.hypot(px - playerPos.x, pz - playerPos.z);
      if (d > TRAFFIC.despawnDist) {
        ud.active = false;
        v.visible = false;
      }
    }
  }

  _think(v, playerPos) {
    const ud = v.userData;
    const s = this._sample(ud.route, ud.u);
    if (!s) return;

    // ---- gap keeping vs player ------------------------------------------
    const toPlayerX = playerPos.x - s.x;
    const toPlayerZ = playerPos.z - s.z;
    const along = toPlayerX * s.tx * ud.dir + toPlayerZ * s.tz * ud.dir;
    const across = Math.abs(toPlayerX * -s.tz + toPlayerZ * s.tx - ud.lane);
    let target = ud.targetSpeed;

    if (along > 0 && along < 55 && across < 3.2) {
      // player ahead in my lane
      const closing = ud.speed * ud.dir - 0;   // player speed unknown here; assume slow
      target = Math.min(target, Math.max(0, (along - 8) * 0.9));
      ud.overtakeT += this._updateInterval;
    } else {
      ud.overtakeT = Math.max(0, ud.overtakeT - this._updateInterval * 0.5);
    }

    // ---- gap keeping vs other traffic (same route + direction, O(n²) but n≤40) ----
    for (const o of this.vehicles) {
      if (o === v || !o.userData.active) continue;
      const od = o.userData;
      if (od.route !== ud.route || od.dir !== ud.dir) continue;
      const du = (od.u - ud.u) * ud.dir;
      if (du > 0 && du < 30) {
        const gap = du - 7;
        target = Math.min(target, Math.max(0, od.speed + gap * 0.6));
      }
    }

    // ---- yield near crossings (avenues crossing highways) ------------------
    if (ud.route.type === ROAD.AVENUE) {
      const HS = WORLD.highwaySpacing;
      const nearCross = ud.route.kind === 'row'
        ? Math.abs((ud.u % HS) - 0) < 55 || Math.abs((ud.u % HS) - HS) < 55
        : Math.abs((ud.u % HS) - 0) < 55 || Math.abs((ud.u % HS) - HS) < 55;
      if (nearCross) target = Math.min(target, 9);
    }

    // ---- overtaking ---------------------------------------------------------
    const highwayLike = ud.route.type === ROAD.HIGHWAY || ud.route.type === ROAD.AVENUE ||
      ud.route.type === ROAD.RING;
    if (ud.overtakeT > 2.2 && highwayLike && ud.lane === this._laneOffset(ud.route.type ?? ROAD.HIGHWAY, ud.dir)) {
      // check oncoming lane clear
      let clear = true;
      const otherLane = -ud.lane;
      for (const o of this.vehicles) {
        if (o === v || !o.userData.active) continue;
        const od = o.userData;
        if (od.route !== ud.route) continue;
        const du = (od.u - ud.u) * ud.dir;
        if (Math.abs(du) < 42 && Math.abs(od.lane - otherLane) < 2) { clear = false; break; }
      }
      if (clear) {
        ud.lane = otherLane;
        ud._returnT = 2.6;
      }
    }
    if (ud._returnT !== undefined && ud._returnT > 0) {
      ud._returnT -= this._updateInterval;
      if (ud._returnT <= 0) ud.lane = this._laneOffset(ud.route.type ?? ROAD.HIGHWAY, ud.dir);
    }

    // ---- speed integration -----------------------------------------------------
    const accel = target > ud.speed ? 4.5 : 9.0;
    const dv = clamp(target - ud.speed, -accel * this._updateInterval, 4.5 * this._updateInterval);
    ud.speed = Math.max(0, ud.speed + dv);
  }

  dispose() {
    for (const v of this.vehicles) {
      this.scene.remove(v);
    }
  }
}
