/**
 * Environment — golden-hour sky, lighting, ground and horizon dressing.
 *
 * Deliberately cheap for mobile: one gradient sky dome (shader), one
 * directional sun with a compact shadow frustum that follows the car, one
 * hemisphere fill, billboard clouds and a fogged mountain ring. No dynamic
 * weather, no day cycle — a single beautiful frozen moment.
 */
import * as THREE from 'three';

export class Environment {
  constructor(scene) {
    this.scene = scene;

    scene.fog = new THREE.Fog(0xecc18a, 150, 560);

    // ---- lights --------------------------------------------------------
    this.hemi = new THREE.HemisphereLight(0xffe0b0, 0x354636, 0.85);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffcf9a, 2.3);
    this.sun.position.set(-90, 60, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 260;
    this.sun.shadow.camera.left = -55;
    this.sun.shadow.camera.right = 55;
    this.sun.shadow.camera.top = 55;
    this.sun.shadow.camera.bottom = -55;
    this.sun.shadow.bias = -0.0004;
    scene.add(this.sun);
    scene.add(this.sun.target);

    // ---- gradient sky dome with baked sun glow --------------------------
    const skyGeo = new THREE.SphereGeometry(850, 24, 14);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x2c5a9e) },
        midColor: { value: new THREE.Color(0x86aed6) },
        botColor: { value: new THREE.Color(0xffc684) },
        sunDir: { value: new THREE.Vector3(-0.75, 0.28, 0.6).normalize() },
        sunColor: { value: new THREE.Color(0xffdf9e) },
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vDir;
        uniform vec3 topColor, midColor, botColor, sunColor, sunDir;
        void main() {
          float h = clamp(vDir.y * 1.35 + 0.08, 0.0, 1.0);
          vec3 col = h < 0.32
            ? mix(botColor, midColor, h / 0.32)
            : mix(midColor, topColor, (h - 0.32) / 0.68);
          float sunAmt = pow(max(dot(vDir, sunDir), 0.0), 180.0);
          float glow = pow(max(dot(vDir, sunDir), 0.0), 6.0);
          col += sunColor * (sunAmt * 1.1 + glow * 0.28);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    scene.add(this.sky);

    // ---- ground ---------------------------------------------------------
    const groundGeo = new THREE.CircleGeometry(760, 48);
    groundGeo.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ color: 0x5d7a4a }));
    this.ground.receiveShadow = true;
    scene.add(this.ground);

    // ---- mountains ring (fog silhouettes) -------------------------------
    const rngMul = 1;
    const mounts = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x6a7f72 });
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2 + Math.sin(i * 7.3) * 0.2;
      const r = 520 + Math.sin(i * 3.1) * 60;
      const h = 55 + Math.abs(Math.sin(i * 5.7)) * 75;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(70 + Math.abs(Math.sin(i * 2.2)) * 60, h, 5), mat);
      cone.position.set(Math.sin(ang) * r, h / 2 - 6, Math.cos(ang) * r);
      mounts.add(cone);
    }
    scene.add(mounts);

    // ---- clouds ---------------------------------------------------------
    const cloudTex = makeCloudTexture();
    this.clouds = [];
    for (let i = 0; i < 9; i++) {
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cloudTex, transparent: true, opacity: 0.5, depthWrite: false, fog: false,
      }));
      const ang = (i / 9) * Math.PI * 2;
      spr.position.set(Math.sin(ang) * (200 + (i * 53) % 220), 120 + (i * 37) % 90, Math.cos(ang) * (200 + (i * 71) % 220));
      const s = 70 + (i * 29) % 70;
      spr.scale.set(s, s * 0.42, 1);
      scene.add(spr);
      this.clouds.push(spr);
    }
  }

  /** Keep the shadow frustum and sky centered on the action. */
  update(dt, focusPos) {
    this.sun.position.set(focusPos.x - 90, 60, focusPos.z + 40);
    this.sun.target.position.set(focusPos.x, 0, focusPos.z);
    this.sky.position.set(focusPos.x, 0, focusPos.z);
    for (const c of this.clouds) {
      c.position.x += dt * 1.2;
      if (c.position.x > 480) c.position.x = -480;
    }
  }

  /** Reduce quality: drop shadows entirely. */
  disableShadows() {
    this.sun.castShadow = false;
  }
}

function makeCloudTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const ctx = c.getContext('2d');
  for (let i = 0; i < 5; i++) {
    const x = 24 + i * 20, y = 30 + Math.sin(i * 2.1) * 8, r = 14 + (i % 3) * 6;
    const g = ctx.createRadialGradient(x, y, 2, x, y, r);
    g.addColorStop(0, 'rgba(255,250,242,0.9)');
    g.addColorStop(1, 'rgba(255,250,242,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
