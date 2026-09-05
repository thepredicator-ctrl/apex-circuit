/**
 * Environment — time-of-day atmosphere system.
 *
 * Four presets (dawn / day / dusk / night) drive a gradient sky dome with a
 * sun (or moon) disc, horizon glow, fog, hemisphere + directional light with
 * a car-following shadow frustum, an environment probe for reflections, and
 * a star field that fades in for night driving. Presets can be switched at
 * runtime from the settings menu.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { WORLD_PRESETS } from './Constants.js';

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
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col;
    if (h >= 0.0) {
      col = mix(horizonColor, topColor, pow(min(h, 1.0), 0.42));
      // warm band where the sky meets the horizon
      float glow = exp(-max(h, 0.0) * 22.0);
      col += glowColor * glow * glowStrength;
    } else {
      col = mix(horizonColor, groundColor, pow(min(-h, 1.0), 0.5));
    }
    // sun / moon: sharp disc + soft halo
    float s = max(dot(d, normalize(sunDir)), 0.0);
    col += sunColor * (pow(s, 1600.0) * 1.6 + pow(s, 16.0) * 0.08 + pow(s, 4.0) * 0.015);
    gl_FragColor = vec4(col, 1.0);
    // apply the renderer's tone mapping + output color space (custom
    // ShaderMaterials do not get these automatically)
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Environment {
  constructor(scene, renderer, isMobile, presetName = 'day') {
    this.scene = scene;
    this.isMobile = isMobile;
    this.presetName = presetName;

    scene.fog = new THREE.Fog(
      WORLD_PRESETS[presetName].fogColor,
      WORLD_PRESETS[presetName].fogNear,
      WORLD_PRESETS[presetName].fogFar
    );

    this._buildSky();
    this._buildStars();
    this._buildClouds();
    this._buildBirds();
    this._buildLights();

    // one-time environment probe for metal/clearcoat reflections. Safe to fail.
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new RoomEnvironment();
      scene.environment = pmrem.fromScene(envScene, 0.04).texture;
      if ('environmentIntensity' in scene) {
        scene.environmentIntensity = WORLD_PRESETS[presetName].envIntensity;
      }
      pmrem.dispose();
    } catch (err) {
      console.warn('[ApexRoads] Environment probe unavailable, continuing without reflections:', err);
    }

    this.applyPreset(presetName);
  }

  _buildSky() {
    this.sunDir = new THREE.Vector3(...WORLD_PRESETS.day.sunDirection).normalize();

    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color() },
        horizonColor: { value: new THREE.Color() },
        groundColor: { value: new THREE.Color() },
        glowColor: { value: new THREE.Color() },
        glowStrength: { value: 0.2 },
        sunDir: { value: this.sunDir },
        sunColor: { value: new THREE.Color() }
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    });
    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(1500, 24, 14), this.skyMat);
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);
  }

  /** Star field on the upper sky dome (slow drift for life). */
  _buildStars() {
    const count = this.isMobile ? 500 : 1300;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = Math.random() * Math.PI * 2;
      const v = Math.pow(Math.random(), 0.65);
      const y = 0.05 + 0.95 * v;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const R = 1420;
      positions[i * 3] = Math.cos(u) * r * R;
      positions[i * 3 + 1] = y * R;
      positions[i * 3 + 2] = Math.sin(u) * r * R;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xcdd8f2,
      size: 2.1,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      fog: false
    });
    this.stars = new THREE.Points(geo, mat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  /** Puffy billboard clouds that drift with the wind and wrap around the camera. */
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

    const count = this.isMobile ? 9 : 16;
    this.clouds = [];
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0.9,
      depthWrite: false, fog: false
    });
    this.cloudMat = mat;
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(mat);
      const w = 130 + Math.random() * 240;
      s.scale.set(w, w * 0.42, 1);
      const c = {
        sprite: s,
        speed: 2.2 + Math.random() * 3.4,
        baseY: 140 + Math.random() * 190
      };
      this._placeCloud(c, 0, 0, true);
      this.scene.add(s);
      this.clouds.push(c);
    }
  }

  _placeCloud(c, camX, camZ, anywhere = false) {
    const RANGE = 1000;
    const a = Math.random() * Math.PI * 2;
    const r = anywhere ? Math.random() * RANGE : 650 + Math.random() * 350;
    c.sprite.position.set(
      camX + Math.cos(a) * r,
      c.baseY,
      camZ + Math.sin(a) * r
    );
  }

  /** A small flock of birds that circles lazily near the camera. */
  _buildBirds() {
    if (this.isMobile) return;   // skip on phones — pure garnish
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
      wl.rotation.x = 0; wr.rotation.x = 0;
      b.add(wl, wr);
      this.flock.add(b);
      this.birds.push({
        g: b, wl, wr,
        phase: Math.random() * Math.PI * 2,
        off: new THREE.Vector3(
          (Math.random() - 0.5) * 26,
          (Math.random() - 0.5) * 9,
          (Math.random() - 0.5) * 26
        ),
        wobble: 0.6 + Math.random() * 0.9
      });
    }
    this.scene.add(this.flock);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x445544, 0.7);
    this.scene.add(this.hemi);

    // sun/moon — the single shadow caster
    const sun = new THREE.DirectionalLight(0xffffff, 2.5);
    sun.position.set(60, 100, -40);
    sun.castShadow = true;
    const shadowSize = this.isMobile ? 1024 : 1536;
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    const FRUST = this.isMobile ? 55 : 80;
    sun.shadow.camera.left = -FRUST;
    sun.shadow.camera.right = FRUST;
    sun.shadow.camera.top = FRUST;
    sun.shadow.camera.bottom = -FRUST;
    sun.shadow.camera.near = 30;
    sun.shadow.camera.far = 360;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
  }

  /** Switch atmosphere to a named preset (dawn | day | dusk | night). */
  applyPreset(name) {
    const p = WORLD_PRESETS[name] || WORLD_PRESETS.day;
    this.presetName = name;
    this.preset = p;

    const u = this.skyMat.uniforms;
    u.topColor.value.setHex(p.skyTop);
    u.horizonColor.value.setHex(p.skyHorizon);
    u.groundColor.value.setHex(p.skyGround);
    u.glowColor.value.setHex(p.glowColor);
    u.glowStrength.value = p.glowStrength;
    u.sunColor.value.setHex(p.sunColor);

    this.sunDir.set(...p.sunDirection).normalize();
    this.sun.color.setHex(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    this.hemi.color.setHex(p.hemiSky);
    this.hemi.groundColor.setHex(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;

    this.scene.fog.color.setHex(p.fogColor);
    this.scene.fog.near = p.fogNear;
    this.scene.fog.far = p.fogFar;

    if ('environmentIntensity' in this.scene) {
      this.scene.environmentIntensity = p.envIntensity;
    }
    this.stars.material.opacity = p.stars * 0.8;
    // clouds: tint + density follow the preset
    if (this.cloudMat) {
      this.cloudMat.color.setHex(p.cloudColor);
      this.cloudMat.opacity = p.cloudOpacity;
    }
    this.headlightsOn = p.headlights;
    this.exposure = p.exposure;
  }

  /** Keep the shadow frustum, sky dome, clouds and birds glued to the camera. */
  update(focusPoint, camera, dt = 0) {
    this.sun.position.copy(focusPoint).addScaledVector(this.sunDir, 170);
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

    // clouds drift + wrap around the camera
    if (this.clouds) {
      for (const c of this.clouds) {
        c.sprite.position.x += c.speed * dt;
        const dx = c.sprite.position.x - camX;
        const dz = c.sprite.position.z - camZ;
        if (Math.abs(dx) > 1050 || Math.abs(dz) > 1050) {
          this._placeCloud(c, camX, camZ);
        }
      }
    }

    // birds: a lazy orbit near the camera with flapping wings
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
      this.flock.visible = this.presetName !== 'night';
    }
  }
}
