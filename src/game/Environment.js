/**
 * Environment — renderer-friendly scene dressing that is not part of the
 * circuit itself: gradient sky dome with sun glow, fog, hemisphere + sun
 * lights (with a car-following shadow frustum) and an environment probe
 * for material reflections.
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
  uniform vec3 sunDir;
  uniform vec3 sunColor;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col;
    if (h >= 0.0) {
      col = mix(horizonColor, topColor, pow(min(h, 1.0), 0.55));
    } else {
      col = mix(horizonColor, groundColor, pow(min(-h, 1.0), 0.5));
    }
    float s = max(dot(d, normalize(sunDir)), 0.0);
    col += sunColor * (pow(s, 700.0) * 1.4 + pow(s, 10.0) * 0.14);
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
    this._buildLights();

    // one-time environment probe for nice metal reflections (safe to fail)
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new RoomEnvironment();
      scene.environment = pmrem.fromScene(envScene, 0.04).texture;
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
        sunDir: { value: sunDir },
        sunColor: { value: new THREE.Color(0xffe9c4) }
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

  _buildLights() {
    const hemi = new THREE.HemisphereLight(WORLD.hemiSky, WORLD.hemiGround, WORLD.hemiIntensity);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(WORLD.sunColor, WORLD.sunIntensity);
    sun.position.set(...WORLD.sunDirection).multiplyScalar(150);
    sun.castShadow = true;
    const shadowSize = this.isMobile ? 1024 : 2048;
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    sun.shadow.camera.left = -60;
    sun.shadow.camera.right = 60;
    sun.shadow.camera.top = 60;
    sun.shadow.camera.bottom = -60;
    sun.shadow.camera.near = 30;
    sun.shadow.camera.far = 340;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
  }

  /** Keep the shadow frustum and sky dome glued to the camera/car. */
  update(focusPoint, camera) {
    this.sun.position.copy(focusPoint).addScaledVector(this.sunDir, 160);
    this.sun.target.position.copy(focusPoint);
    this.sun.target.updateMatrixWorld();
    if (camera) this.skyDome.position.set(camera.position.x, 0, camera.position.z);
  }
}
