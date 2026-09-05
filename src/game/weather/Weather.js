/**
 * Weather — dynamic regional weather simulation.
 *
 * States: clear / cloudy / fog / rain / storm. Transition probabilities are
 * biased by the biome region under the player (deserts stay clear, coasts
 * get rain, mountains get fog). States blend in over ~8 s, hold 1–4 minutes.
 *
 * Rain is rendered as one LineSegments draw call of world-anchored streaks
 * recycled in a box around the camera. Storms add lightning: a sky/hemisphere
 * flash + a thunder callback. Wet roads darken the asphalt materials and cut
 * tire grip (Game reads `gripMul`).
 */

import * as THREE from 'three';
import { WEATHER_CONFIG } from '../core/Constants.js';
import { mulberry32, clamp, lerp } from '../core/Noise.js';

const RAIN_VERT = /* glsl */`
  attribute float aAlpha;
  varying float vAlpha;
  uniform float uOpacity;
  void main() {
    vAlpha = aAlpha * uOpacity;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const RAIN_FRAG = /* glsl */`
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    if (vAlpha < 0.01) discard;
    gl_FragColor = vec4(uColor, vAlpha);
  }
`;

const STATES = Object.keys(WEATHER_CONFIG.states);

export class Weather {
  constructor(scene, isMobile, seed = 1) {
    this.scene = scene;
    this.rng = mulberry32((seed ^ 0x8e77d) >>> 0);
    this.stateName = 'clear';
    this.active = WEATHER_CONFIG.states.clear;
    this.blendFactor = 1;        // how "in" the current state is
    this.stateTime = 0;
    this.nextRoll = 90 + this.rng() * 90;
    this.gripMul = 1;
    this.wetness = 0;            // 0..1 road wetness (visuals)
    this.rainIntensity = 0;      // 0..1 visual rain amount
    this.onThunder = null;

    // ---- rain streaks -------------------------------------------------------
    const maxDrops = isMobile ? 600 : 1600;
    this.maxDrops = maxDrops;
    this.dropCount = maxDrops;
    const pos = new Float32Array(maxDrops * 2 * 3);
    const alp = new Float32Array(maxDrops * 2);
    this.dropPos = new Float32Array(maxDrops * 3);
    for (let i = 0; i < maxDrops; i++) {
      this.dropPos[i * 3] = (Math.random() - 0.5) * 70;
      this.dropPos[i * 3 + 1] = Math.random() * 26;
      this.dropPos[i * 3 + 2] = (Math.random() - 0.5) * 70;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alp, 1).setUsage(THREE.DynamicDrawUsage));
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xa8c0d8) },
        uOpacity: { value: 0 }
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false
    });
    this.rain = new THREE.LineSegments(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.rain.renderOrder = 7;
    scene.add(this.rain);

    this._lightningT = 0;
  }

  /** region key from Terrain.region() */
  setRegion(region) {
    this._region = region;
  }

  _rollState() {
    const bias = WEATHER_CONFIG.regionBias[this._region || 'plains'];
    const r = this.rng();
    let acc = 0;
    for (const s of STATES) {
      acc += bias[s] ?? 0.1;
      if (r <= acc) return s;
    }
    return 'clear';
  }

  update(dt, camPos, terrainY, env, onThunder) {
    // ---- state machine ---------------------------------------------------
    this.stateTime += dt;
    if (this.stateTime > this.nextRoll) {
      const next = this._rollState();
      if (next !== this.stateName) {
        this.stateName = next;
        this.blendFactor = 0;
      }
      this.stateTime = 0;
      this.nextRoll = WEATHER_CONFIG.minStateTime +
        this.rng() * (WEATHER_CONFIG.maxStateTime - WEATHER_CONFIG.minStateTime);
    }
    this.active = WEATHER_CONFIG.states[this.stateName];
    this.blendFactor = clamp(this.blendFactor + dt / 8, 0, 1);

    // ---- outputs ------------------------------------------------------------
    const targetRain = this.active.rain * this.blendFactor;
    this.rainIntensity = lerp(this.rainIntensity, targetRain, Math.min(1, dt * 0.8));
    this.wetness = clamp(this.wetness + (this.rainIntensity > 0.05 ? dt * 0.15 : -dt * 0.05), 0, 1);
    this.gripMul = lerp(1, this.active.grip, this.blendFactor * (0.4 + 0.6 * this.wetness));

    // ---- rain rendering -------------------------------------------------------
    const targetDrops = Math.floor(this.maxDrops * this.rainIntensity);
    this.rain.visible = this.rainIntensity > 0.02;
    this.rainMat.uniforms.uOpacity.value = this.rainIntensity * 0.5;
    if (this.rain.visible) {
      const pos = this.rain.geometry.attributes.position.array;
      const alp = this.rain.geometry.attributes.aAlpha.array;
      const n = Math.max(targetDrops, 0);
      const fall = 34 * dt;
      for (let i = 0; i < this.maxDrops; i++) {
        this.dropPos[i * 3 + 1] -= fall * (0.8 + (i % 5) * 0.08);
        if (this.dropPos[i * 3 + 1] < -2) {
          // respawn above camera
          this.dropPos[i * 3] = (Math.random() - 0.5) * 70;
          this.dropPos[i * 3 + 1] = 24 + Math.random() * 8;
          this.dropPos[i * 3 + 2] = (Math.random() - 0.5) * 70;
        }
        const o = i * 6;
        const x = camPos.x + this.dropPos[i * 3];
        const y = camPos.y + this.dropPos[i * 3 + 1] - 8;
        const z = camPos.z + this.dropPos[i * 3 + 2];
        const slant = 2.2;
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
        pos[o + 3] = x + slant * 0.4; pos[o + 4] = y + 1.15; pos[o + 5] = z - slant;
        const a = i < n ? 0.5 : 0;
        alp[i * 2] = a;
        alp[i * 2 + 1] = 0;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
      this.rain.geometry.attributes.aAlpha.needsUpdate = true;
    }

    // ---- lightning ---------------------------------------------------------------
    if (this.stateName === 'storm' && this.blendFactor > 0.6) {
      this._lightningT -= dt;
      if (this._lightningT <= 0) {
        this._lightningT = 3 + this.rng() * 9;
        env.flash = 1.0;
        if (this.onThunder) this.onThunder();
      }
    }
  }

  get label() {
    return this.stateName.toUpperCase();
  }

  /** wet-road material modulation (Game calls once per state change frame) */
  applyRoadWetness(scenery) {
    const k = this.wetness;
    for (const key of Object.keys(scenery.roadMats)) {
      const m = scenery.roadMats[key];
      m.color.setScalar(lerp(1, 0.55, k));
      m.roughness = lerp(0.92, 0.35, k);
      m.metalness = lerp(0, 0.35, k);
    }
  }
}
