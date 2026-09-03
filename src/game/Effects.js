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

/**
 * SpeedLines — one LineSegments draw call of world-anchored motion streaks
 * that fade in above ~45% of top speed. They spawn in a tube around the
 * car's velocity ahead of the camera and stream past, which sells the
 * sense of speed far better than FOV alone.
 */
const SL_VERT = /* glsl */`
  attribute float aAlpha;
  varying float vAlpha;
  uniform float uOpacity;
  void main() {
    vAlpha = aAlpha * uOpacity;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SL_FRAG = /* glsl */`
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(uColor, vAlpha);
  }
`;

export class SpeedLines {
  constructor(scene) {
    this.N = 64;
    this.positions = new Float32Array(this.N * 2 * 3);
    this.alphas = new Float32Array(this.N * 2);
    this.pts = [];          // world anchor per streak
    for (let i = 0; i < this.N; i++) this.pts.push(new THREE.Vector3());
    this.live = new Array(this.N).fill(false);
    this.opacity = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xcfe4ff) },
        uOpacity: { value: 0 }
      },
      vertexShader: SL_VERT,
      fragmentShader: SL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    this.lines = new THREE.LineSegments(geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 6;
    this.lines.visible = false;
    scene.add(this.lines);

    this._fwd = new THREE.Vector3();
    this._rel = new THREE.Vector3();
    this._side = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /** respawn streak i somewhere ahead of the camera, off to the side */
  _spawn(i, camPos, fwd, speed) {
    // random perpendicular offset (radius 3..11 m), biased outward+up
    this._side.set(-fwd.z, 0, fwd.x);
    const ang = Math.random() * Math.PI * 2;
    const rad = 3.5 + Math.random() * 7.5;
    const p = this.pts[i];
    p.copy(camPos)
      .addScaledVector(fwd, 10 + Math.random() * 34)
      .addScaledVector(this._side, Math.cos(ang) * rad)
      .addScaledVector(this._up, Math.abs(Math.sin(ang)) * rad * 0.55 + 0.5);
    this.len = Math.min(4.5, Math.max(1.4, speed * 0.085));
    this.alphas[i * 2] = 0.16 + Math.random() * 0.5;
    this.alphas[i * 2 + 1] = 0;
    this.live[i] = true;
  }

  update(dt, camera, velocity, speedN) {
    // fade in from ~100 km/h, fully on by ~160 km/h (of a ~238 top speed)
    const target = THREE.MathUtils.smoothstep(speedN, 0.30, 0.68);
    // ease the master opacity
    this.opacity += (target - this.opacity) * Math.min(1, dt * 3);
    this.mat.uniforms.uOpacity.value = this.opacity;
    this.lines.visible = this.opacity > 0.015;
    if (!this.lines.visible) return;

    const speed = velocity.length();
    if (speed < 4) return;
    this._fwd.copy(velocity).normalize();

    const camPos = camera.position;
    const seg = this.len || 2.5;

    for (let i = 0; i < this.N; i++) {
      const p = this.pts[i];
      this._rel.copy(p).sub(camPos);
      const along = this._rel.dot(this._fwd);
      if (!this.live[i] || along < -4 || along > 60) {
        this._spawn(i, camPos, this._fwd, speed);
        continue;
      }
      // streak is world-anchored; draw a short segment along the velocity
      const o = i * 6;
      this.positions[o] = p.x;
      this.positions[o + 1] = p.y;
      this.positions[o + 2] = p.z;
      this.positions[o + 3] = p.x - this._fwd.x * seg;
      this.positions[o + 4] = p.y - this._fwd.y * seg;
      this.positions[o + 5] = p.z - this._fwd.z * seg;
    }

    const g = this.lines.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }
}
