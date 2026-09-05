/**
 * Environment — atmosphere for the open world: a CONTINUOUS day/night cycle
 * (sun arcs across the sky, stars, headlights) plus weather modulation
 * (rain, fog, storm dimming) fed in by Weather.js each frame.
 *
 * Sky presets are keyframed in DAY_CYCLE (midnight → dawn → midday → dusk →
 * midnight) and smoothly interpolated by the world clock.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DAY_CYCLE } from './core/Constants.js';

const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const SKY_FRAG = /* glsl */`
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 groundColor;
  uniform vec3 glowColor;
  uniform float glowStrength;
  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform float flash;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col;
    if (h >= 0.0) {
      col = mix(horizonColor, topColor, pow(min(h, 1.0), 0.42));
      float glow = exp(-max(h, 0.0) * 22.0);
      col += glowColor * glow * glowStrength;
    } else {
      col = mix(horizonColor, groundColor, pow(min(-h, 1.0), 0.5));
    }
    float s = max(dot(d, normalize(sunDir)), 0.0);
    col += sunColor * (pow(s, 1600.0) * 1.6 + pow(s, 16.0) * 0.08 + pow(s, 4.0) * 0.015);
    col += vec3(0.7, 0.75, 0.9) * flash;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const _cA = new THREE.Color();
const _cB = new THREE.Color();
const _lerpHex = (out, a, b, t) => {
  _cA.setHex(a); _cB.setHex(b);
  out.copy(_cA).lerp(_cB, t);
  return out;
};

export class Environment {
  constructor(scene, renderer, isMobile) {
    this.scene = scene;
    this.isMobile = isMobile;
    this.timeOfDay = 0.5;        // 0..1 world-clock phase
    this.flash = 0;              // lightning flash 0..1
    this.headlightsOn = false;
    this.exposure = 1.1;

    scene.fog = new THREE.Fog(0xcfe0ec, 80, 2000);

    this._buildSky();
    this._buildStars();
    this._buildClouds();
    this._buildBirds();
    this._buildLights();

    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new RoomEnvironment();
      scene.environment = pmrem.fromScene(envScene, 0.04).texture;
      if ('environmentIntensity' in scene) scene.environmentIntensity = 0.8;
      pmrem.dispose();
    } catch (err) {
      console.warn('[ApexRoads] Environment probe unavailable:', err);
    }
  }

  _buildSky() {
    this.sunDir = new THREE.Vector3(0.42, 0.82, -0.38).normalize();
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color() },
        horizonColor: { value: new THREE.Color() },
        groundColor: { value: new THREE.Color() },
        glowColor: { value: new THREE.Color() },
        glowStrength: { value: 0.2 },
        sunDir: { value: this.sunDir },
        sunColor: { value: new THREE.Color() },
        flash: { value: 0 }
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    });
    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(2400, 28, 16), this.skyMat);
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);
  }

  _buildStars() {
    const count = this.isMobile ? 600 : 1500;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = Math.random() * Math.PI * 2;
      const v = Math.pow(Math.random(), 0.65);
      const y = 0.05 + 0.95 * v;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const R = 2300;
      positions[i * 3] = Math.cos(u) * r * R;
      positions[i * 3 + 1] = y * R;
      positions[i * 3 + 2] = Math.sin(u) * r * R;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xcdd8f2, size: 2.1, sizeAttenuation: false,
      transparent: true, opacity: 0.0, depthWrite: false, fog: false
    });
    this.stars = new THREE.Points(geo, mat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  _buildClouds() {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 64;
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

    const count = this.isMobile ? 12 : 20;
    this.clouds = [];
    this.cloudMat = new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0.9, depthWrite: false, fog: false
    });
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(this.cloudMat);
      const w = 160 + Math.random() * 300;
      s.scale.set(w, w * 0.42, 1);
      const c = { sprite: s, speed: 2.2 + Math.random() * 3.4, baseY: 160 + Math.random() * 230 };
      this._placeCloud(c, 0, 0, true);
      this.scene.add(s);
      this.clouds.push(c);
    }
  }

  _placeCloud(c, camX, camZ, anywhere = false) {
    const RANGE = 1700;
    const a = Math.random() * Math.PI * 2;
    const r = anywhere ? Math.random() * RANGE : 900 + Math.random() * 500;
    c.sprite.position.set(camX + Math.cos(a) * r, c.baseY, camZ + Math.sin(a) * r);
  }

  _buildBirds() {
    if (this.isMobile) return;
    this.birdTime = Math.random() * 100;
    this.flock = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x1e2226, side: THREE.DoubleSide });
    this.birds = [];
    const wingGeo = new THREE.PlaneGeometry(0.62, 0.16);
    wingGeo.translate(0.31, 0, 0);
    for (let i = 0; i < 7; i++) {
      const b = new THREE.Group();
      const wl = new THREE.Mesh(wingGeo, mat);
      const wr = new THREE.Mesh(wingGeo, mat);
      wr.rotation.y = Math.PI;
      b.add(wl, wr);
      this.flock.add(b);
      this.birds.push({
        g: b, wl, wr,
        phase: Math.random() * Math.PI * 2,
        off: new THREE.Vector3((Math.random() - 0.5) * 26, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 26),
        wobble: 0.6 + Math.random() * 0.9
      });
    }
    this.scene.add(this.flock);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x445544, 0.7);
    this.scene.add(this.hemi);

    const sun = new THREE.DirectionalLight(0xffffff, 2.5);
    sun.position.set(60, 100, -40);
    sun.castShadow = true;
    const shadowSize = this.isMobile ? 1024 : 2048;
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    const FRUST = this.isMobile ? 55 : 80;
    sun.shadow.camera.left = -FRUST;
    sun.shadow.camera.right = FRUST;
    sun.shadow.camera.top = FRUST;
    sun.shadow.camera.bottom = -FRUST;
    sun.shadow.camera.near = 30;
    sun.shadow.camera.far = 380;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
  }

  /** interpolate DAY_CYCLE keyframes at phase t plus weather modifiers */
  applyAtmosphere(t, weather) {
    this.timeOfDay = t;
    const C = DAY_CYCLE;
    let i0 = 0;
    for (let i = 0; i < C.length - 1; i++) {
      if (t >= C[i].t && t <= C[i + 1].t) { i0 = i; break; }
    }
    const a = C[i0], b = C[i0 + 1];
    const f = (t - a.t) / Math.max(1e-5, b.t - a.t);

    const u = this.skyMat.uniforms;
    _lerpHex(u.topColor.value, a.skyTop, b.skyTop, f);
    _lerpHex(u.horizonColor.value, a.skyHorizon, b.skyHorizon, f);
    _lerpHex(u.groundColor.value, a.skyGround, b.skyGround, f);
    _lerpHex(u.glowColor.value, a.glowColor, b.glowColor, f);
    u.glowStrength.value = THREE.MathUtils.lerp(a.glowStrength, b.glowStrength, f);
    _lerpHex(u.sunColor.value, a.sunColor, b.sunColor, f);

    // sun elevation/azimuth from keyframes
    const el = THREE.MathUtils.lerp(a.sunElevation, b.sunElevation, f);
    const az = THREE.MathUtils.lerp(a.sunAzimuth, b.sunAzimuth, f);
    this.sunDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();

    // weather modulation
    const wf = weather ? weather.blendFactor : 0;      // 0..1 how settled the state is
    const state = weather ? weather.active : null;
    let sunMul = 1, fogMul = 1, cloudOp = THREE.MathUtils.lerp(a.cloudOpacity, b.cloudOpacity, f);
    let dimR = 1, dimG = 1, dimB = 1;
    if (state) {
      const fogMulT = state.fogMul;
      const sunMulT = state.sunMul;
      cloudOp = Math.max(cloudOp, state.cloudOp);
      // blend in over wf
      sunMul = THREE.MathUtils.lerp(1, sunMulT, wf);
      fogMul = THREE.MathUtils.lerp(1, fogMulT, wf);
      const g = THREE.MathUtils.lerp(1, 0.72, wf * (state.rain > 0 ? 1 : 0.4));
      dimR = g; dimG = g; dimB = g * 1.04;
    }

    this.sun.color.copy(u.sunColor.value).multiplyScalar(dimR);
    this.sun.intensity = THREE.MathUtils.lerp(a.sunIntensity, b.sunIntensity, f) * sunMul;
    this.hemi.color.copy(u.horizonColor.value).multiplyScalar(dimR);
    _lerpHex(_cA, a.hemiGround, b.hemiGround, f);
    this.hemi.groundColor.copy(_cA).multiplyScalar(dimG);
    this.hemi.intensity = THREE.MathUtils.lerp(a.hemiIntensity, b.hemiIntensity, f) * THREE.MathUtils.lerp(1, 0.75, wf);

    const fogC = _lerpHex(_cA, a.fogColor, b.fogColor, f);
    this.scene.fog.color.copy(fogC).multiply(_cB.setRGB(dimR, dimG, dimB));
    this.baseFogFar = 2100 * THREE.MathUtils.lerp(a.fogFar / 1250, 1, 0.5) || 2100;
    this.baseFogFar = 2100;
    this.scene.fog.near = 60 * fogMul;
    this.scene.fog.far = this.baseFogFar * fogMul;

    if ('environmentIntensity' in this.scene) {
      this.scene.environmentIntensity =
        THREE.MathUtils.lerp(a.envIntensity, b.envIntensity, f) * sunMul;
    }
    const stars = THREE.MathUtils.lerp(a.stars, b.stars, f);
    this.stars.material.opacity = stars * 0.85 * (1 - wf * 0.7);
    this.cloudMat.color.copy(u.horizonColor.value).lerp(_cB.setRGB(1, 1, 1), 0.5).multiplyScalar(0.4 + 0.6 * (1 - wf * 0.5));
    this.cloudMat.opacity = cloudOp;

    // headlights: keyframe flags (dusk/night true), or heavy rain
    const hlA = a.headlights ? 1 : 0, hlB = b.headlights ? 1 : 0;
    this.headlightsOn = THREE.MathUtils.lerp(hlA, hlB, f) > 0.5 ||
      (state && state.rain > 0.5 && wf > 0.5);
    this.exposure = THREE.MathUtils.lerp(a.exposure, b.exposure, f);
    this.sunElevation = Math.sin(el);
    this.label = f < 0.5 ? a.label : b.label;
  }

  update(focusPoint, camera, dt = 0) {
    this.skyMat.uniforms.flash.value = this.flash;
    if (this.flash > 0.001) this.flash = Math.max(0, this.flash - dt * 3.2);

    this.sun.position.copy(focusPoint).addScaledVector(this.sunDir, 190);
    this.sun.target.position.copy(focusPoint);
    this.sun.target.updateMatrixWorld();
    if (camera) {
      this.skyDome.position.set(camera.position.x, 0, camera.position.z);
      this.stars.position.set(camera.position.x, 0, camera.position.z);
    }
    if (dt > 0 && this.stars.material.opacity > 0.01) {
      this.stars.rotation.y += dt * 0.004;
    }

    const camX = camera ? camera.position.x : focusPoint.x;
    const camZ = camera ? camera.position.z : focusPoint.z;

    if (this.clouds) {
      for (const c of this.clouds) {
        c.sprite.position.x += c.speed * dt;
        const dx = c.sprite.position.x - camX;
        const dz = c.sprite.position.z - camZ;
        if (Math.abs(dx) > 1750 || Math.abs(dz) > 1750) {
          this._placeCloud(c, camX, camZ);
        }
      }
    }

    if (this.birds && this.birds.length) {
      this.birdTime += dt;
      const t = this.birdTime;
      const ax = camX + Math.sin(t * 0.043) * 120;
      const az = camZ + Math.cos(t * 0.031) * 120;
      const ay = focusPoint.y + 46 + Math.sin(t * 0.11) * 6;
      for (const b of this.birds) {
        const a = t * 0.32 * b.wobble + b.phase;
        const r = 9 + Math.sin(b.phase * 3.1) * 5;
        b.g.position.set(
          ax + b.off.x + Math.cos(a) * r,
          ay + b.off.y + Math.sin(t * 0.9 + b.phase) * 1.6,
          az + b.off.z + Math.sin(a) * r
        );
        b.g.rotation.y = -a - Math.PI / 2;
        const flap = Math.sin(t * 9 + b.phase * 2.2) * 0.55;
        b.wl.rotation.z = flap;
        b.wr.rotation.z = -flap;
      }
      this.flock.visible = this.sunElevation > 0.05;
    }
  }

  /** legacy preset switch — snaps the clock to a keyframe */
  applyPreset(name) {
    const map = { dawn: 0.23, day: 0.5, dusk: 0.77, night: 0.0 };
    this.timeOfDay = map[name] ?? 0.5;
  }
}
