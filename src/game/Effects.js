/**
 * Effects — lightweight pooled tire smoke / grass dust particles.
 * One THREE.Points draw call, custom point shader for per-particle
 * size and alpha. Spawned on drifts, grass driving and wall hits.
 */

import * as THREE from 'three';

const MAX = 90;

const VERT = /* glsl */`
  attribute float aScale;
  attribute float aAlpha;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aScale * (240.0 / max(-mv.z, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float mask = smoothstep(0.5, 0.12, d);
    if (mask <= 0.001) discard;
    gl_FragColor = vec4(uColor, vAlpha * mask);
  }
`;

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.positions = new Float32Array(MAX * 3);
    this.scales = new Float32Array(MAX);
    this.alphas = new Float32Array(MAX);
    this.life = new Float32Array(MAX);
    this.maxLife = new Float32Array(MAX);
    this.vel = new Float32Array(MAX * 3);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aScale', new THREE.BufferAttribute(this.scales, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, MAX);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xd9d9d9) } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);

    this.cursor = 0;
    this._alive = 0;
  }

  /**
   * Spawn a puff.
   * @param {THREE.Vector3} pos  world position
   * @param {THREE.Vector3} baseVel  carrier velocity (car speed * 0.25)
   * @param {number} size 0.5..2
   * @param {number} colorHex
   */
  emit(pos, baseVel, size = 1, colorHex = null) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX;

    this.positions[i * 3] = pos.x;
    this.positions[i * 3 + 1] = pos.y;
    this.positions[i * 3 + 2] = pos.z;
    this.vel[i * 3] = baseVel.x * 0.2 + (Math.random() - 0.5) * 1.6;
    this.vel[i * 3 + 1] = 0.9 + Math.random() * 1.2;
    this.vel[i * 3 + 2] = baseVel.z * 0.2 + (Math.random() - 0.5) * 1.6;
    this.scales[i] = size * (0.7 + Math.random() * 0.6);
    this.alphas[i] = 0.34;
    this.maxLife[i] = 0.7 + Math.random() * 0.5;
    this.life[i] = this.maxLife[i];
    if (colorHex !== null) {
      this.mat.uniforms.uColor.value.setHex(colorHex);
    }
  }

  update(dt) {
    let alive = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        this.alphas[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alphas[i] = 0.34 * k;
      this.scales[i] += dt * 2.2;
      this.positions[i * 3] += this.vel[i * 3] * dt;
      this.positions[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3] *= 0.96;
      this.vel[i * 3 + 2] *= 0.96;
      alive++;
    }
    this._alive = alive;
    if (alive > 0 || this._dirty) {
      const g = this.points.geometry;
      g.attributes.position.needsUpdate = true;
      g.attributes.aScale.needsUpdate = true;
      g.attributes.aAlpha.needsUpdate = true;
    }
    this._dirty = alive > 0;
  }

  get activeCount() {
    return this._alive;
  }
}
