/**
 * Environment — night-race atmosphere: gradient night sky dome with a moon
 * disc, faint warm city glow on the horizon, a field of stars, cold fog,
 * dim hemisphere + moon lights (with a car-following shadow frustum) and a
 * night-dimmed environment probe for material reflections.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { WORLD } from './Constants.js';

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
  uniform vec3 cityColor;
  uniform vec3 sunDir;
  uniform vec3 sunColor;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col;
    if (h >= 0.0) {
      col = mix(horizonColor, topColor, pow(min(h, 1.0), 0.42));
      // warm haze of a distant city sitting on the horizon
      float glow = exp(-max(h, 0.0) * 26.0);
      col += cityColor * glow * 0.85;
    } else {
      col = mix(horizonColor, groundColor, pow(min(-h, 1.0), 0.5));
    }
    // moon: sharp disc + soft cold halo
    float s = max(dot(d, normalize(sunDir)), 0.0);
    col += sunColor * (pow(s, 1500.0) * 1.5 + pow(s, 14.0) * 0.06 + pow(s, 4.0) * 0.012);
    gl_FragColor = vec4(col, 1.0);
    // apply the renderer's tone mapping + output color space (custom
    // ShaderMaterials do not get these automatically)
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Environment {
  constructor(scene, renderer, isMobile) {
    this.scene = scene;
    this.isMobile = isMobile;

    scene.fog = new THREE.Fog(WORLD.fogColor, WORLD.fogNear, WORLD.fogFar);

    this._buildSky();
    this._buildStars();
    this._buildLights();

    // one-time environment probe for metal/clearcoat reflections (dimmed for
    // night so paints don't glow like daylight). Safe to fail.
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new RoomEnvironment();
      scene.environment = pmrem.fromScene(envScene, 0.04).texture;
      if ('environmentIntensity' in scene) scene.environmentIntensity = WORLD.envIntensity;
      pmrem.dispose();
    } catch (err) {
      console.warn('[ApexCircuit] Environment probe unavailable, continuing without reflections:', err);
    }
  }

  _buildSky() {
    const sunDir = new THREE.Vector3(...WORLD.sunDirection).normalize();
    this.sunDir = sunDir;

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(WORLD.skyTop) },
        horizonColor: { value: new THREE.Color(WORLD.skyHorizon) },
        groundColor: { value: new THREE.Color(WORLD.skyGround) },
        cityColor: { value: new THREE.Color(WORLD.cityGlow) },
        sunDir: { value: sunDir },
        sunColor: { value: new THREE.Color(WORLD.sunColor) }
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    });
    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(1500, 24, 14), mat);
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);
  }

  /** Star field on the upper sky dome (slow drift for life). */
  _buildStars() {
    const count = this.isMobile ? WORLD.stars.mobile : WORLD.stars.count;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // random direction, upper hemisphere mostly, radius just inside the dome
      const u = Math.random() * Math.PI * 2;
      const v = Math.pow(Math.random(), 0.65); // bias toward the zenith a bit
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
      opacity: 0.8,
      depthWrite: false,
      fog: false
    });
    this.stars = new THREE.Points(geo, mat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(WORLD.hemiSky, WORLD.hemiGround, WORLD.hemiIntensity);
    this.scene.add(hemi);

    // moonlight — the single shadow caster, cold and hard.
    // Shadow map size scales with the QUALITY preset (set in Game._applyQuality),
    // but the cap here is also lowered for mobile / iPad so the shadow pass
    // doesn't dominate frame time on 3x retina screens.
    const sun = new THREE.DirectionalLight(WORLD.sunColor, WORLD.sunIntensity);
    sun.position.set(...WORLD.sunDirection).multiplyScalar(150);
    sun.castShadow = true;
    const shadowSize = this.isMobile ? 1024 : 1536;
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    // tighten the shadow frustum — 120 m was overkill; 80 m still covers the
    // visible track ahead and roughly halves shadow-pass fill rate.
    const FRUST = this.isMobile ? 50 : 70;
    sun.shadow.camera.left = -FRUST;
    sun.shadow.camera.right = FRUST;
    sun.shadow.camera.top = FRUST;
    sun.shadow.camera.bottom = -FRUST;
    sun.shadow.camera.near = 30;
    sun.shadow.camera.far = 340;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
  }

  /** Keep the shadow frustum and sky dome glued to the camera/car. */
  update(focusPoint, camera, dt = 0) {
    this.sun.position.copy(focusPoint).addScaledVector(this.sunDir, 160);
    this.sun.target.position.copy(focusPoint);
    this.sun.target.updateMatrixWorld();
    if (camera) {
      this.skyDome.position.set(camera.position.x, 0, camera.position.z);
      this.stars.position.set(camera.position.x, 0, camera.position.z);
    }
    if (dt > 0) this.stars.rotation.y += dt * 0.004;
  }
}
