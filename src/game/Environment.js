/**
 * @fileoverview Environment — atmosphere for the open world.
 *
 * Continuous day/night cycle (sun arc, stars, headlights) plus weather
 * modulation (rain, fog, storm dimming) fed by Weather.js each frame.
 *
 * Sky presets are keyframed in DAY_CYCLE and smoothly interpolated by the
 * world clock. All atmospheric effects are deterministic from the world seed.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DAY_CYCLE } from './core/Constants.js';

// ============================================================================
// Seeded RNG for deterministic atmospheric effects
// ============================================================================

class SeededRNG {
  constructor(seed = 12345) {
    this._s = seed >>> 0;
  }
  next() {
    this._s = (this._s * 16807 + 0) % 2147483647;
    return (this._s - 1) / 2147483646;
  }
  range(min, max) {
    return min + this.next() * (max - min);
  }
  rangeInt(min, max) {
    return Math.floor(this.range(min, max + 1));
  }
}

// ============================================================================
// Constants
// ============================================================================

const CFG = Object.freeze({
  SKY: Object.freeze({
    RADIUS: 2400,
    SEGMENTS_H: 28,
    SEGMENTS_V: 16,
    GAMMA: 0.42,
    GROUND_GAMMA: 0.5,
    GLOW_DECAY: 22.0,
    SUN_SPECULAR_POW: 1600.0,
    SUN_HALO_POW: 16.0,
    SUN_DIFFUSE_POW: 4.0,
    SUN_SPECULAR_INT: 1.6,
    SUN_HALO_INT: 0.08,
    SUN_DIFFUSE_INT: 0.015,
    FLASH_COLOR: 0x7fbfff,
  }),
  STARS: Object.freeze({
    RADIUS: 2300,
    MOBILE_COUNT: 600,
    DESKTOP_COUNT: 1500,
    SIZE: 2.1,
    COLOR: 0xcdd8f2,
    ROTATION_SPEED: 0.004,
    OPACITY_BASE: 0.85,
    WEATHER_DAMPING: 0.7,
    DISTRIBUTION_EXP: 0.65,
    MIN_ELEVATION: 0.05,
  }),
  CLOUDS: Object.freeze({
    MOBILE_COUNT: 12,
    DESKTOP_COUNT: 20,
    CANVAS_W: 128,
    CANVAS_H: 64,
    BASE_Y_MIN: 160,
    BASE_Y_MAX: 390,
    SPEED_MIN: 2.2,
    SPEED_MAX: 5.6,
    SCALE_W_MIN: 160,
    SCALE_W_MAX: 460,
    SCALE_H_FRAC: 0.42,
    SPAWN_RANGE: 1700,
    SPAWN_INNER: 900,
    SPAWN_BAND: 500,
    WRAP_DIST: 1750,
    OPACITY_BASE: 0.9,
    COLOR_LERP: 0.5,
    COLOR_BRIGHTNESS: 0.4,
  }),
  BIRDS: Object.freeze({
    COUNT: 7,
    WING_W: 0.62,
    WING_H: 0.16,
    COLOR: 0x1e2226,
    FLOCK_ORBIT_X: 120,
    FLOCK_ORBIT_Z: 120,
    FLOCK_ALTITUDE: 46,
    FLOCK_ALT_WOBBLE: 6,
    FLAP_SPEED: 9.0,
    FLAP_AMP: 0.55,
    ORBIT_SPEED_X: 0.043,
    ORBIT_SPEED_Z: 0.031,
    ALT_SPEED: 0.11,
    BIRD_ORBIT_SPEED: 0.32,
    BIRD_ORBIT_R: 9,
    BIRD_ORBIT_R_VAR: 5,
    WING_OFFSET: 0.31,
    MIN_SUN_ELEV: 0.05,
  }),
  LIGHTS: Object.freeze({
    HEMI_SKY: 0xffffff,
    HEMI_GROUND: 0x445544,
    HEMI_INT: 0.7,
    SUN_COLOR: 0xffffff,
    SUN_INT: 2.5,
    SUN_DIST: 190,
    SHADOW_MOBILE: 1024,
    SHADOW_DESKTOP: 2048,
    FRUST_MOBILE: 55,
    FRUST_DESKTOP: 80,
    SHADOW_NEAR: 30,
    SHADOW_FAR: 380,
    SHADOW_BIAS: -0.0004,
    SHADOW_NORMAL_BIAS: 0.03,
    ENV_INTENSITY: 0.8,
    ENV_BLUR: 0.04,
  }),
  FOG: Object.freeze({
    COLOR: 0xcfe0ec,
    NEAR: 60,
    FAR: 2100,
    FAR_BASE: 2100,
    WEATHER_DAMPING: 0.75,
  }),
  FLASH: Object.freeze({
    DECAY_RATE: 3.2,
  }),
  WEATHER: Object.freeze({
    RAIN_DIM: 1.0,
    CLOUD_DIM: 0.4,
    GREEN_TINT: 1.04,
    FOG_MUL_DEFAULT: 1.0,
    SUN_MUL_DEFAULT: 1.0,
    CLOUD_OP_MIN: 0.0,
    ENV_DAMPING: 0.75,
  }),
});

// ============================================================================
// Shaders
// ============================================================================

const SKY_VERT = /* glsl */`
  varying vec3 vWorldDir;
  void main() {
    vWorldDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */`
  uniform vec3 uTopColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uGroundColor;
  uniform vec3 uGlowColor;
  uniform float uGlowStrength;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uFlash;
  varying vec3 vWorldDir;

  void main() {
    vec3 d = normalize(vWorldDir);
    float h = d.y;
    vec3 col;

    if (h >= 0.0) {
      col = mix(uHorizonColor, uTopColor, pow(min(h, 1.0), 0.42));
      float glow = exp(-max(h, 0.0) * 22.0);
      col += uGlowColor * glow * uGlowStrength;
    } else {
      col = mix(uHorizonColor, uGroundColor, pow(min(-h, 1.0), 0.5));
    }

    float sunDot = max(dot(d, normalize(uSunDir)), 0.0);
    col += uSunColor * (
      pow(sunDot, 1600.0) * 1.6 +
      pow(sunDot, 16.0) * 0.08 +
      pow(sunDot, 4.0) * 0.015
    );

    col += vec3(0.7, 0.75, 0.9) * uFlash;
    gl_FragColor = vec4(col, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Linearly interpolate between two hex colors into an existing Color.
 * @param {THREE.Color} out
 * @param {number} a — hex
 * @param {number} b — hex
 * @param {number} t — 0..1
 * @returns {THREE.Color}
 */
function lerpHex(out, a, b, t) {
  _cA.setHex(a);
  _cB.setHex(b);
  return out.copy(_cA).lerp(_cB, t);
}

const _cA = new THREE.Color();
const _cB = new THREE.Color();
const _cTemp = new THREE.Color();

// ============================================================================
// Subsystems
// ============================================================================

/**
 * Owns the sky dome mesh and its shader uniforms.
 */
class SkyDome {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.sunDir = new THREE.Vector3(0.42, 0.82, -0.38).normalize();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTopColor: { value: new THREE.Color() },
        uHorizonColor: { value: new THREE.Color() },
        uGroundColor: { value: new THREE.Color() },
        uGlowColor: { value: new THREE.Color() },
        uGlowStrength: { value: 0.2 },
        uSunDir: { value: this.sunDir },
        uSunColor: { value: new THREE.Color() },
        uFlash: { value: 0 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(CFG.SKY.RADIUS, CFG.SKY.SEGMENTS_H, CFG.SKY.SEGMENTS_V),
      this.material
    );
    this.mesh.frustumCulled = false;
    this.mesh.name = 'SkyDome';
    scene.add(this.mesh);
  }

  /**
   * @param {THREE.Vector3} cameraPos
   */
  updatePosition(cameraPos) {
    this.mesh.position.set(cameraPos.x, 0, cameraPos.z);
  }

  dispose() {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

/**
 * Star field using Points with deterministic placement.
 */
class StarField {
  /**
   * @param {THREE.Scene} scene
   * @param {boolean} isMobile
   * @param {number} seed
   */
  constructor(scene, isMobile, seed) {
    const count = isMobile ? CFG.STARS.MOBILE_COUNT : CFG.STARS.DESKTOP_COUNT;
    const rng = new SeededRNG(seed ^ 0x1234);

    const positions = new Float32Array(count * 3);
    const R = CFG.STARS.RADIUS;

    for (let i = 0; i < count; i++) {
      const u = rng.next() * Math.PI * 2;
      const v = Math.pow(rng.next(), CFG.STARS.DISTRIBUTION_EXP);
      const y = CFG.STARS.MIN_ELEVATION + (1 - CFG.STARS.MIN_ELEVATION) * v;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      positions[i * 3] = Math.cos(u) * r * R;
      positions[i * 3 + 1] = y * R;
      positions[i * 3 + 2] = Math.sin(u) * r * R;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    this.material = new THREE.PointsMaterial({
      color: CFG.STARS.COLOR,
      size: CFG.STARS.SIZE,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new THREE.Points(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'StarField';
    scene.add(this.mesh);
  }

  /**
   * @param {THREE.Vector3} cameraPos
   * @param {number} opacity
   * @param {number} dt
   */
  update(cameraPos, opacity, dt) {
    this.mesh.position.set(cameraPos.x, 0, cameraPos.z);
    this.material.opacity = opacity;
    if (dt > 0 && opacity > 0.01) {
      this.mesh.rotation.y += dt * CFG.STARS.ROTATION_SPEED;
    }
  }

  dispose() {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

/**
 * Procedural cloud sprites with seeded placement.
 */
class CloudSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {boolean} isMobile
   * @param {number} seed
   */
  constructor(scene, isMobile, seed) {
    this._scene = scene;
    this._rng = new SeededRNG(seed ^ 0x5678);
    this._clouds = [];

    const tex = this._buildTexture();
    this.material = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: CFG.CLOUDS.OPACITY_BASE,
      depthWrite: false,
      fog: false,
    });

    const count = isMobile ? CFG.CLOUDS.MOBILE_COUNT : CFG.CLOUDS.DESKTOP_COUNT;

    for (let i = 0; i < count; i++) {
      const sprite = new THREE.Sprite(this.material);
      const w = this._rng.range(CFG.CLOUDS.SCALE_W_MIN, CFG.CLOUDS.SCALE_W_MAX);
      sprite.scale.set(w, w * CFG.CLOUDS.SCALE_H_FRAC, 1);
      sprite.name = `Cloud_${i}`;

      const cloud = {
        sprite,
        speed: this._rng.range(CFG.CLOUDS.SPEED_MIN, CFG.CLOUDS.SPEED_MAX),
        baseY: this._rng.range(CFG.CLOUDS.BASE_Y_MIN, CFG.CLOUDS.BASE_Y_MAX),
      };

      this._placeCloud(cloud, 0, 0, true);
      scene.add(sprite);
      this._clouds.push(cloud);
    }
  }

  _buildTexture() {
    const cv = document.createElement('canvas');
    cv.width = CFG.CLOUDS.CANVAS_W;
    cv.height = CFG.CLOUDS.CANVAS_H;
    const ctx = cv.getContext('2d');

    const puff = (x, y, r, a) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };

    puff(64, 38, 26, 0.9);
    puff(42, 40, 18, 0.8);
    puff(86, 40, 19, 0.8);
    puff(64, 28, 16, 0.7);
    puff(30, 44, 12, 0.6);
    puff(98, 44, 12, 0.6);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.name = 'CloudPuff';
    return tex;
  }

  _placeCloud(c, camX, camZ, anywhere = false) {
    const a = this._rng.next() * Math.PI * 2;
    const r = anywhere
      ? this._rng.next() * CFG.CLOUDS.SPAWN_RANGE
      : CFG.CLOUDS.SPAWN_INNER + this._rng.next() * CFG.CLOUDS.SPAWN_BAND;
    c.sprite.position.set(camX + Math.cos(a) * r, c.baseY, camZ + Math.sin(a) * r);
  }

  /**
   * @param {number} camX
   * @param {number} camZ
   * @param {number} dt
   */
  update(camX, camZ, dt) {
    for (const c of this._clouds) {
      c.sprite.position.x += c.speed * dt;
      const dx = c.sprite.position.x - camX;
      const dz = c.sprite.position.z - camZ;
      if (Math.abs(dx) > CFG.CLOUDS.WRAP_DIST || Math.abs(dz) > CFG.CLOUDS.WRAP_DIST) {
        this._placeCloud(c, camX, camZ);
      }
    }
  }

  setColorFromSky(horizonColor, weatherFactor) {
    _cTemp.copy(horizonColor).lerp(_cA.setRGB(1, 1, 1), CFG.CLOUDS.COLOR_LERP);
    const brightness = CFG.CLOUDS.COLOR_BRIGHTNESS + 0.6 * (1 - weatherFactor * 0.5);
    this.material.color.copy(_cTemp).multiplyScalar(brightness);
  }

  setOpacity(v) {
    this.material.opacity = v;
  }

  dispose() {
    this.material.map?.dispose();
    this.material.dispose();
    for (const c of this._clouds) {
      this._scene.remove(c.sprite);
    }
    this._clouds.length = 0;
  }
}

/**
 * Simple bird flock using instanced-like Group meshes.
 */
class BirdFlock {
  /**
   * @param {THREE.Scene} scene
   * @param {number} seed
   */
  constructor(scene, seed) {
    this._scene = scene;
    this._rng = new SeededRNG(seed ^ 0x9abc);
    this.time = this._rng.next() * 100;
    this.group = new THREE.Group();
    this.group.name = 'BirdFlock';
    this.birds = [];

    const mat = new THREE.MeshBasicMaterial({
      color: CFG.BIRDS.COLOR,
      side: THREE.DoubleSide,
    });

    const wingGeo = new THREE.PlaneGeometry(CFG.BIRDS.WING_W, CFG.BIRDS.WING_H);
    wingGeo.translate(CFG.BIRDS.WING_OFFSET, 0, 0);

    for (let i = 0; i < CFG.BIRDS.COUNT; i++) {
      const b = new THREE.Group();
      const wl = new THREE.Mesh(wingGeo, mat);
      const wr = new THREE.Mesh(wingGeo, mat);
      wr.rotation.y = Math.PI;
      b.add(wl, wr);
      this.group.add(b);

      this.birds.push({
        group: b,
        wl,
        wr,
        phase: this._rng.next() * Math.PI * 2,
        off: new THREE.Vector3(
          (this._rng.next() - 0.5) * 26,
          (this._rng.next() - 0.5) * 9,
          (this._rng.next() - 0.5) * 26
        ),
        wobble: this._rng.range(0.6, 1.5),
      });
    }

    scene.add(this.group);
  }

  /**
   * @param {THREE.Vector3} focus
   * @param {number} dt
   * @param {number} sunElevation
   */
  update(focus, dt, sunElevation) {
    this.time += dt;
    const t = this.time;

    const ax = focus.x + Math.sin(t * CFG.BIRDS.ORBIT_SPEED_X) * CFG.BIRDS.FLOCK_ORBIT_X;
    const az = focus.z + Math.cos(t * CFG.BIRDS.ORBIT_SPEED_Z) * CFG.BIRDS.FLOCK_ORBIT_Z;
    const ay = focus.y + CFG.BIRDS.FLOCK_ALTITUDE + Math.sin(t * CFG.BIRDS.ALT_SPEED) * CFG.BIRDS.FLOCK_ALT_WOBBLE;

    for (const b of this.birds) {
      const a = t * CFG.BIRDS.BIRD_ORBIT_SPEED * b.wobble + b.phase;
      const r = CFG.BIRDS.BIRD_ORBIT_R + Math.sin(b.phase * 3.1) * CFG.BIRDS.BIRD_ORBIT_R_VAR;

      b.group.position.set(
        ax + b.off.x + Math.cos(a) * r,
        ay + b.off.y + Math.sin(t * 0.9 + b.phase) * 1.6,
        az + b.off.z + Math.sin(a) * r
      );
      b.group.rotation.y = -a - Math.PI / 2;

      const flap = Math.sin(t * CFG.BIRDS.FLAP_SPEED + b.phase * 2.2) * CFG.BIRDS.FLAP_AMP;
      b.wl.rotation.z = flap;
      b.wr.rotation.z = -flap;
    }

    this.group.visible = sunElevation > CFG.BIRDS.MIN_SUN_ELEV;
  }

  dispose() {
    this._scene.remove(this.group);
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
  }
}

/**
 * Sun + hemisphere light rig with shadow camera.
 */
class LightRig {
  /**
   * @param {THREE.Scene} scene
   * @param {boolean} isMobile
   */
  constructor(scene, isMobile) {
    this.scene = scene;

    this.hemi = new THREE.HemisphereLight(
      CFG.LIGHTS.HEMI_SKY,
      CFG.LIGHTS.HEMI_GROUND,
      CFG.LIGHTS.HEMI_INT
    );
    this.hemi.name = 'HemiLight';
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(CFG.LIGHTS.SUN_COLOR, CFG.LIGHTS.SUN_INT);
    this.sun.name = 'SunLight';
    this.sun.position.set(60, 100, -40);
    this.sun.castShadow = true;

    const shadowSize = isMobile ? CFG.LIGHTS.SHADOW_MOBILE : CFG.LIGHTS.SHADOW_DESKTOP;
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);

    const FRUST = isMobile ? CFG.LIGHTS.FRUST_MOBILE : CFG.LIGHTS.FRUST_DESKTOP;
    const cam = this.sun.shadow.camera;
    cam.left = -FRUST;
    cam.right = FRUST;
    cam.top = FRUST;
    cam.bottom = -FRUST;
    cam.near = CFG.LIGHTS.SHADOW_NEAR;
    cam.far = CFG.LIGHTS.SHADOW_FAR;

    this.sun.shadow.bias = CFG.LIGHTS.SHADOW_BIAS;
    this.sun.shadow.normalBias = CFG.LIGHTS.SHADOW_NORMAL_BIAS;

    scene.add(this.sun);
    scene.add(this.sun.target);
  }

  /**
   * @param {THREE.Vector3} focus
   * @param {THREE.Vector3} sunDir
   */
  updatePosition(focus, sunDir) {
    this.sun.position.copy(focus).addScaledVector(sunDir, CFG.LIGHTS.SUN_DIST);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
  }

  dispose() {
    this.scene.remove(this.hemi);
    this.scene.remove(this.sun);
    this.scene.remove(this.sun.target);
    this.hemi.dispose();
    this.sun.dispose();
  }
}

// ============================================================================
// Environment
// ============================================================================

/**
 * @typedef {Object} WeatherState
 * @property {number} blendFactor 0..1
 * @property {Object|null} active
 * @property {number} [fogMul]
 * @property {number} [sunMul]
 * @property {number} [cloudOp]
 * @property {number} [rain]
 */

export class Environment {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {boolean} isMobile
   * @param {number} [seed=1337]
   */
  constructor(scene, renderer, isMobile, seed = 1337) {
    if (!scene || !scene.isScene) {
      throw new TypeError('Environment requires a valid THREE.Scene');
    }
    if (!renderer || !renderer.isWebGLRenderer) {
      throw new TypeError('Environment requires a valid THREE.WebGLRenderer');
    }

    this._scene = scene;
    this._isMobile = isMobile;
    this._seed = seed >>> 0;

    // State
    this.timeOfDay = 0.5;
    this.flash = 0;
    this.headlightsOn = false;
    this.exposure = 1.1;
    this.sunElevation = 0;

    // Pre-allocated working colors
    this._cSky = new THREE.Color();
    this._cFog = new THREE.Color();
    this._cSun = new THREE.Color();
    this._cHemi = new THREE.Color();
    this._cHemiGround = new THREE.Color();

    // Fog
    scene.fog = new THREE.Fog(CFG.FOG.COLOR, CFG.FOG.NEAR, CFG.FOG.FAR);

    // Subsystems
    this._sky = new SkyDome(scene);
    this._stars = new StarField(scene, isMobile, this._seed);
    this._clouds = new CloudSystem(scene, isMobile, this._seed);
    if (!isMobile) {
      this._birds = new BirdFlock(scene, this._seed);
    }

    this._lights = new LightRig(scene, isMobile);

    // Environment map
    this._buildEnvironmentMap(renderer);

    // Labels
    this.label = 'Day';
  }

  _buildEnvironmentMap(renderer) {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new RoomEnvironment();
      this._scene.environment = pmrem.fromScene(envScene, CFG.LIGHTS.ENV_BLUR).texture;

      if ('environmentIntensity' in this._scene) {
        this._scene.environmentIntensity = CFG.LIGHTS.ENV_INTENSITY;
      }

      pmrem.dispose();
      envScene.dispose?.();
    } catch (err) {
      console.warn('[Environment] PMREM probe unavailable:', err);
    }
  }

  // ------------------------------------------------------------------
  // Atmosphere
  // ------------------------------------------------------------------

  /**
   * Interpolate DAY_CYCLE keyframes at phase t plus weather modifiers.
   * @param {number} t — 0..1 world-clock phase
   * @param {WeatherState} [weather]
   */
  applyAtmosphere(t, weather) {
    if (!Number.isFinite(t)) {
      console.warn('Environment.applyAtmosphere: bad t', t);
      t = 0.5;
    }

    this.timeOfDay = t;

    const { a, b, f } = this._findKeyframes(t);
    this._applySkyColors(a, b, f);
    this._applySun(a, b, f, weather);
    this._applyFog(a, b, f, weather);
    this._applyHemi(a, b, f, weather);
    this._applyStars(a, b, f, weather);
    this._applyClouds(a, b, f, weather);

    // Headlights: keyframe flags or heavy rain
    const hlA = a.headlights ? 1 : 0;
    const hlB = b.headlights ? 1 : 0;
    const hlBlend = THREE.MathUtils.lerp(hlA, hlB, f);
    const rainHl = weather?.active && weather.active.rain > 0.5 && weather.blendFactor > 0.5;
    this.headlightsOn = hlBlend > 0.5 || rainHl;

    this.exposure = THREE.MathUtils.lerp(a.exposure, b.exposure, f);
    this.label = f < 0.5 ? a.label : b.label;
  }

  /**
   * @param {number} t
   * @returns {{a:Object, b:Object, f:number}}
   */
  _findKeyframes(t) {
    const C = DAY_CYCLE;
    let i0 = 0;
    for (let i = 0; i < C.length - 1; i++) {
      if (t >= C[i].t && t <= C[i + 1].t) {
        i0 = i;
        break;
      }
    }
    const a = C[i0];
    const b = C[i0 + 1];
    const denom = Math.max(1e-5, b.t - a.t);
    const f = (t - a.t) / denom;
    return { a, b, f };
  }

  _applySkyColors(a, b, f) {
    const u = this._sky.material.uniforms;
    lerpHex(u.uTopColor.value, a.skyTop, b.skyTop, f);
    lerpHex(u.uHorizonColor.value, a.skyHorizon, b.skyHorizon, f);
    lerpHex(u.uGroundColor.value, a.skyGround, b.skyGround, f);
    lerpHex(u.uGlowColor.value, a.glowColor, b.glowColor, f);
    u.uGlowStrength.value = THREE.MathUtils.lerp(a.glowStrength, b.glowStrength, f);
    lerpHex(u.uSunColor.value, a.sunColor, b.sunColor, f);
  }

  _applySun(a, b, f, weather) {
    const wf = weather ? weather.blendFactor : 0;
    const state = weather ? weather.active : null;

    let sunMul = CFG.WEATHER.SUN_MUL_DEFAULT;
    let dimR = 1, dimG = 1, dimB = 1;

    if (state) {
      sunMul = THREE.MathUtils.lerp(CFG.WEATHER.SUN_MUL_DEFAULT, state.sunMul, wf);
      const g = THREE.MathUtils.lerp(1, 0.72, wf * (state.rain > 0 ? 1 : 0.4));
      dimR = g;
      dimG = g;
      dimB = g * CFG.WEATHER.GREEN_TINT;
    }

    const sunInt = THREE.MathUtils.lerp(a.sunIntensity, b.sunIntensity, f) * sunMul;
    this._cSun.copy(this._sky.material.uniforms.uSunColor.value).multiplyScalar(dimR);
    this._lights.sun.color.copy(this._cSun);
    this._lights.sun.intensity = sunInt;

    // Sun direction from elevation/azimuth
    const el = THREE.MathUtils.lerp(a.sunElevation, b.sunElevation, f);
    const az = THREE.MathUtils.lerp(a.sunAzimuth, b.sunAzimuth, f);
    this._sky.sunDir.set(
      Math.cos(az) * Math.cos(el),
      Math.sin(el),
      Math.sin(az) * Math.cos(el)
    ).normalize();

    this.sunElevation = Math.sin(el);
  }

  _applyFog(a, b, f, weather) {
    const wf = weather ? weather.blendFactor : 0;
    const state = weather ? weather.active : null;

    let fogMul = CFG.WEATHER.FOG_MUL_DEFAULT;
    let dimR = 1, dimG = 1, dimB = 1;

    if (state) {
      fogMul = THREE.MathUtils.lerp(CFG.WEATHER.FOG_MUL_DEFAULT, state.fogMul, wf);
      const g = THREE.MathUtils.lerp(1, 0.72, wf * (state.rain > 0 ? 1 : 0.4));
      dimR = g; dimG = g; dimB = g * CFG.WEATHER.GREEN_TINT;
    }

    lerpHex(this._cFog, a.fogColor, b.fogColor, f);
    this._scene.fog.color.copy(this._cFog).multiply(_cTemp.setRGB(dimR, dimG, dimB));

    this._scene.fog.near = CFG.FOG.NEAR * fogMul;
    this._scene.fog.far = CFG.FOG.FAR_BASE * fogMul;
  }

  _applyHemi(a, b, f, weather) {
    const wf = weather ? weather.blendFactor : 0;
    const hemiInt = THREE.MathUtils.lerp(a.hemiIntensity, b.hemiIntensity, f)
      * THREE.MathUtils.lerp(1, CFG.WEATHER.ENV_DAMPING, wf);

    this._lights.hemi.color.copy(this._sky.material.uniforms.uHorizonColor.value);
    lerpHex(this._cHemiGround, a.hemiGround, b.hemiGround, f);
    this._lights.hemi.groundColor.copy(this._cHemiGround);
    this._lights.hemi.intensity = hemiInt;

    if ('environmentIntensity' in this._scene) {
      const sunInt = THREE.MathUtils.lerp(a.envIntensity, b.envIntensity, f)
        * (weather?.active ? THREE.MathUtils.lerp(1, weather.active.sunMul, weather.blendFactor) : 1);
      this._scene.environmentIntensity = sunInt;
    }
  }

  _applyStars(a, b, f, weather) {
    const wf = weather ? weather.blendFactor : 0;
    const stars = THREE.MathUtils.lerp(a.stars, b.stars, f);
    const opacity = stars * CFG.STARS.OPACITY_BASE * (1 - wf * CFG.STARS.WEATHER_DAMPING);
    this._stars.update(new THREE.Vector3(), opacity, 0);
  }

  _applyClouds(a, b, f, weather) {
    const wf = weather ? weather.blendFactor : 0;
    const state = weather ? weather.active : null;

    let cloudOp = THREE.MathUtils.lerp(a.cloudOpacity, b.cloudOpacity, f);
    if (state) {
      cloudOp = Math.max(cloudOp, state.cloudOp);
    }

    this._clouds.setColorFromSky(this._sky.material.uniforms.uHorizonColor.value, wf);
    this._clouds.setOpacity(cloudOp);
  }

  // ------------------------------------------------------------------
  // Per-frame update
  // ------------------------------------------------------------------

  /**
   * @param {THREE.Vector3} focusPoint
   * @param {THREE.Camera} camera
   * @param {number} [dt=0]
   */
  update(focusPoint, camera, dt = 0) {
    if (!focusPoint) return;

    // Lightning flash decay
    this._sky.material.uniforms.uFlash.value = this.flash;
    if (this.flash > 0.001) {
      this.flash = Math.max(0, this.flash - dt * CFG.FLASH.DECAY_RATE);
    }

    // Light rig follows focus
    this._lights.updatePosition(focusPoint, this._sky.sunDir);

    // Sky dome follows camera
    const camPos = camera ? camera.position : focusPoint;
    this._sky.updatePosition(camPos);

    // Stars
    const starsOpacity = this._stars.material.opacity;
    this._stars.update(camPos, starsOpacity, dt);

    // Clouds
    this._clouds.update(camPos.x, camPos.z, dt);

    // Birds
    if (this._birds) {
      this._birds.update(focusPoint, dt, this.sunElevation);
    }
  }

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------

  /**
   * Snap the clock to a named preset.
   * @param {string} name — 'dawn' | 'day' | 'dusk' | 'night'
   */
  applyPreset(name) {
    const map = { dawn: 0.23, day: 0.5, dusk: 0.77, night: 0.0 };
    this.timeOfDay = map[name] ?? 0.5;
  }

  /**
   * Trigger a lightning flash.
   * @param {number} intensity 0..1
   */
  triggerFlash(intensity = 1.0) {
    this.flash = clamp(intensity, 0, 1);
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  destroy() {
    this._sky.dispose();
    this._stars.dispose();
    this._clouds.dispose();
    this._birds?.dispose();
    this._lights.dispose();

    if (this._scene.fog) {
      this._scene.fog = null;
    }

    this._scene = null;
  }
}
