/**
 * Fx — drift presentation effects, built for mobile budgets.
 *
 * Smoke: ONE THREE.Points draw call with a tiny shader (per-particle size,
 * alpha and life in attributes; soft radial sprite in the fragment shader).
 * SkidMarks: a preallocated ring buffer of quads written as the rear wheels
 * slide — no geometry churn, no allocations per frame.
 */
import * as THREE from 'three';

const SMOKE_MAX = 220;

export class SmokeSystem {
  constructor(scene) {
    this.pos = new Float32Array(SMOKE_MAX * 3);
    this.data = new Float32Array(SMOKE_MAX * 4); // size, life, maxLife, seed
    this.vel = new Float32Array(SMOKE_MAX * 3);
    this.head = 0;
    this.alive = 0;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aData', new THREE.BufferAttribute(this.data, 4));
    // dead particles parked below ground
    for (let i = 0; i < SMOKE_MAX; i++) this.pos[i * 3 + 1] = -5;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uMap: { value: makeSmokeTexture() } },
      vertexShader: /* glsl */`
        attribute vec4 aData;
        varying float vLife;
        varying float vSeed;
        void main() {
          vLife = aData.y / max(aData.z, 0.001);
          vSeed = aData.w;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aData.x * (240.0 / max(-mv.z, 1.0));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying float vLife;
        varying float vSeed;
        void main() {
          if (vLife >= 1.0 || vLife < 0.0) discard;
          vec4 tex = texture2D(uMap, gl_PointCoord);
          float a = tex.a * (1.0 - vLife) * 0.52;
          vec3 col = mix(vec3(0.93, 0.93, 0.95), vec3(0.75, 0.75, 0.78), vSeed);
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  /** Emit one puff. */
  emit(x, y, z, vx, vz, intensity) {
    const i = this.head;
    this.head = (this.head + 1) % SMOKE_MAX;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = 0.7 + Math.random() * 0.9;
    this.vel[i * 3 + 2] = vz;
    const life = 0.85 + Math.random() * 0.7;
    this.data[i * 4] = 0.85 + intensity * 1.3;   // size
    this.data[i * 4 + 1] = 0;                    // life
    this.data[i * 4 + 2] = life;                 // maxLife
    this.data[i * 4 + 3] = Math.random();        // seed
  }

  update(dt) {
    const d = this.data, p = this.pos, v = this.vel;
    for (let i = 0; i < SMOKE_MAX; i++) {
      const maxLife = d[i * 4 + 2];
      if (maxLife <= 0) continue;
      let life = d[i * 4 + 1] + dt;
      if (life >= maxLife) {
        d[i * 4 + 2] = 0;
        p[i * 3 + 1] = -5;
        continue;
      }
      d[i * 4 + 1] = life;
      p[i * 3] += v[i * 3] * dt;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      p[i * 3 + 2] += v[i * 3 + 2] * dt;
      v[i * 3] *= (1 - dt * 1.6);
      v[i * 3 + 2] *= (1 - dt * 1.6);
      d[i * 4] += dt * 3.2; // grows as it fades
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aData.needsUpdate = true;
  }
}

export class SkidMarks {
  /**
   * Ring buffer of quads: two emitters (rear wheels) × MAX quads.
   * Each drop connects the previous edge pair to the new one.
   */
  constructor(scene, maxPerWheel = 260) {
    this.max = maxPerWheel;
    this.heads = [0, 0];
    this.last = [null, null]; // {x,z} per wheel
    const totalQuads = maxPerWheel * 2;
    this.pos = new Float32Array(totalQuads * 4 * 3);
    this.idx = new Uint16Array(totalQuads * 6);
    for (let q = 0; q < totalQuads; q++) {
      const b = q * 4;
      this.idx[q * 6] = b; this.idx[q * 6 + 1] = b + 2; this.idx[q * 6 + 2] = b + 1;
      this.idx[q * 6 + 3] = b + 1; this.idx[q * 6 + 4] = b + 2; this.idx[q * 6 + 5] = b + 3;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setIndex(new THREE.BufferAttribute(this.idx, 1));
    const mat = new THREE.MeshBasicMaterial({
      color: 0x101114, transparent: true, opacity: 0.42,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Drop a segment if the wheel moved enough while sliding. */
  drop(wheelIdx, x, z, dirX, dirZ, width = 0.24) {
    const last = this.last[wheelIdx];
    if (!last) {
      this.last[wheelIdx] = { x, z };
      return;
    }
    const dx = x - last.x, dz = z - last.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.45) return;
    // perpendicular to motion
    const px = -dz / d * width, pz = dx / d * width;
    const q = (this.heads[wheelIdx] * 2 + wheelIdx * this.max) % (this.max * 2);
    const b = q * 4;
    // y sits just ABOVE the road surface (0.10) — marks under it are hidden
    const y = 0.13;
    const P = this.pos;
    P[b * 3] = last.x - px; P[b * 3 + 1] = y; P[b * 3 + 2] = last.z - pz;
    P[b * 3 + 3] = last.x + px; P[b * 3 + 4] = y; P[b * 3 + 5] = last.z + pz;
    P[b * 3 + 6] = x - px; P[b * 3 + 7] = y; P[b * 3 + 8] = z - pz;
    P[b * 3 + 9] = x + px; P[b * 3 + 10] = y; P[b * 3 + 11] = z + pz;
    this.heads[wheelIdx] = (this.heads[wheelIdx] + 1) % this.max;
    this.last[wheelIdx] = { x, z };
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }

  /** Called when not drifting: reset the segment anchors. */
  lift(wheelIdx) {
    this.last[wheelIdx] = null;
  }

  clear() {
    this.pos.fill(0);
    this.last[0] = this.last[1] = null;
    this.heads[0] = this.heads[1] = 0;
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }
}

function makeSmokeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}
