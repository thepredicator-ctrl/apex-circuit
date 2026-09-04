/**
 * Car — Porsche 911 Carrera 4S (Karol Miklas, CC-BY-SA-4.0), rigged for the
 * game. The exterior comes from `public/models/porsche_911.glb`; the merged
 * axle meshes are split into four independent wheels so every corner can
 * spin, steer and travel on its suspension like the real car.
 *
 * Model space: nose +X (wrapped -90° about Y so the nose points at +Z world).
 * `body` carries everything and receives suspension roll/pitch/bounce.
 *
 * The glTF scene is authored nose +Z, so it is mounted inside `body` with a
 * +90° Y wrap. Wheel rigs are built in the glTF scene's own frame (axle = X,
 * up = Y, nose = +Z): spin about X, steer about Y, suspension along Y.
 *
 * Extras rigged on top of the model: physically-based headlight spotlights +
 * additive lens halos, brake-reactive rear light bar, clearcoat paint presets
 * (see PAINTS) and upgraded glass/chrome/rubber materials.
 */

import * as THREE from 'three';
import { CAR, SUSPENSION, HEADLIGHTS, PAINTS } from './Constants.js';
import { loadGLB, toFloat32Geometry, keepTriangles, stripExtras } from './ModelKit.js';
import { buildInterior } from './Interior.js';

export class Car {
  constructor(track = null) {
    this.track = track;
    this.ready = false;         // flips true once the GLBs are rigged

    this.group = new THREE.Group();      // world transform (position + heading)
    this.model = new THREE.Group();      // static wrap: nose +X -> +Z
    this.model.rotation.y = -Math.PI / 2;
    this.group.add(this.model);

    this.body = new THREE.Group();       // suspension roll/pitch/bounce
    this.model.add(this.body);

    // ---- defensive cockpit anchor -----------------------------------------
    // A default eye position so the camera rig never reads `undefined` before
    // the Interior GLB finishes loading (or if it fails entirely on iPad
    // Safari). buildInterior() / _buildFallbackCockpit() will overwrite this
    // with the proper anchor once assets are rigged.
    this.cockpitAnchor = new THREE.Object3D();
    this.cockpitAnchor.position.set(-0.05, 1.02, -0.33);
    this.body.add(this.cockpitAnchor);

    this.wheels = [];
    this._prevVF = 0;
    this._spinAngle = 0;
    this._steerVis = 0;
    this._time = 0;
    this._clusterAcc = 1;
    this._mmiAcc = 1;
    this._indicatorT = 0;

    // spring-damper body bounce state
    this._bodyY = 0;
    this._bodyYV = 0;

    this.cockpitMode = false;
  }

  /**
   * Load + rig everything. Call once; resolves after the car, interior and
   * cockpit systems are attached and `ready` is true.
   */
  async build(onProgress) {
    // progress: car is the big one (~75% of the wait), interior the rest
    const carScene = await loadGLB('./models/porsche_911.glb',
      (t) => onProgress && onProgress(t * 0.8));

    this._buildBaseMaterials();
    this._prepareExterior(carScene);
    this._rigWheels(carScene);
    this._buildLights();

    // interior (own GLB) — attaches cockpit, screens, animated steering wheel
    try {
      await buildInterior(this, onProgress);
    } catch (err) {
      console.warn('[ApexCircuit] Interior model failed, continuing without it:', err);
      this._buildFallbackCockpit();
    }

    this.ready = true;
    if (onProgress) onProgress(1);
  }

  // ------------------------------------------------------------------ mats
  _buildBaseMaterials() {
    this.mats = {
      blackMatte: new THREE.MeshStandardMaterial({
        color: 0x14161a, metalness: 0.12, roughness: 0.88
      }),
      blackGloss: new THREE.MeshStandardMaterial({
        color: 0x0c0e11, metalness: 0.4, roughness: 0.35
      }),
      glassDark: new THREE.MeshStandardMaterial({
        color: 0x0d1420, metalness: 0.08, roughness: 0.10,
        transparent: true, opacity: 0.10, envMapIntensity: 1.2,
        depthWrite: false
      }),
      chrome: new THREE.MeshStandardMaterial({
        color: 0xd8dde2, metalness: 1.0, roughness: 0.2, envMapIntensity: 1.35
      }),
      interior: new THREE.MeshStandardMaterial({
        color: 0x191c21, metalness: 0.05, roughness: 0.94
      }),
      interiorSoft: new THREE.MeshStandardMaterial({
        color: 0x23262c, metalness: 0.05, roughness: 0.9
      }),
      accent: new THREE.MeshStandardMaterial({
        color: 0xd23a1e, metalness: 0.4, roughness: 0.5
      }),
      alu: new THREE.MeshStandardMaterial({
        color: 0xc7ccd3, metalness: 0.95, roughness: 0.34, envMapIntensity: 1.2
      }),
      needle: new THREE.MeshBasicMaterial({
        color: 0xff3b30, toneMapped: false
      }),
      screenGlow: new THREE.MeshBasicMaterial({ color: 0x0a0e14, toneMapped: false }),
      well: new THREE.MeshStandardMaterial({
        color: 0x060708, roughness: 0.97, metalness: 0.05,
        side: THREE.DoubleSide
      })
    };

    // body paint — deep clearcoat lacquer (color set by setPaint)
    this.mats.paint = new THREE.MeshPhysicalMaterial({
      color: 0xc00d1e, metalness: 0.72, roughness: 0.30,
      clearcoat: 1.0, clearcoatRoughness: 0.08, envMapIntensity: 1.35
    });
    this.setPaint('guardsRed');
  }

  /** Select a factory paint preset (key of PAINTS). */
  setPaint(key) {
    const p = PAINTS[key] || PAINTS.guardsRed;
    this.paintKey = key in PAINTS ? key : 'guardsRed';
    this.mats.paint.color.setHex(p.color);
    // flake sparkle: metalness/roughness shift per paint family
    const dark = (p.color >> 16 & 255) + (p.color >> 8 & 255) + (p.color & 255) < 180;
    this.mats.paint.metalness = dark ? 0.55 : 0.78;
    this.mats.paint.roughness = dark ? 0.34 : 0.27;
  }

  // ------------------------------------------------------------- exterior
  /**
   * Mount the glTF scene on the body, remove studio props, upgrade the
   * model's materials to game-quality PBR.
   */
  _prepareExterior(scene) {
    stripExtras(scene);

    // remove studio props: paint buckets, backdrop cube + hemi gizmo shells
    const PROP_EXACT = new Set(['Plane', 'Plane002', 'Plane003', 'Plane004', 'Cube001']);
    const PROP_PREFIX = ['Hemi', 'Cube001', 'Plane002', 'Plane003', 'Plane004'];
    const doomed = [];
    scene.traverse((o) => {
      const n = o.name;
      if (PROP_EXACT.has(n) || PROP_PREFIX.some((p) => n.startsWith(p))) doomed.push(o);
    });
    for (const o of doomed) o.parent && o.parent.remove(o);

    // material upgrades by the author's material names
    let tailBar = null;
    scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = false;
      const m = o.material;
      if (!m) return;
      const name = m.name || '';
      if (name === 'paint') {
        o.material = this.mats.paint;
      } else if (name === 'coat') {
        // the author's clearcoat shell — keep it subtle
        if (!this.mats.coat) {
          this.mats.coat = new THREE.MeshPhysicalMaterial({
            color: 0x0b0d10, metalness: 0.9, roughness: 0.05,
            transparent: true, opacity: 0.16, envMapIntensity: 2.2,
            depthWrite: false
          });
        }
        o.material = this.mats.coat;
        o.castShadow = false;
      } else if (name === 'window') {
        o.material = this.mats.glassDark;
        o.castShadow = false;
      } else if (name === 'glass') {
        o.material = this.mats.glassDark;
        o.castShadow = false;
      } else if (name === 'lights') {
        if (!this.mats.headlightLens) {
          this.mats.headlightLens = new THREE.MeshStandardMaterial({
            color: 0xd8e4f0, emissive: 0xcfe4ff, emissiveIntensity: 2.6,
            metalness: 0.2, roughness: 0.18, envMapIntensity: 1.4
          });
        }
        o.material = this.mats.headlightLens;
      } else if (name === 'rubber') {
        if (!this.mats.tire) {
          this.mats.tire = new THREE.MeshStandardMaterial({
            color: 0x151515, roughness: 0.96, metalness: 0.0
          });
          this.mats.tire.name = 'rubber';
        }
        o.material = this.mats.tire;
      } else if (name === 'silver') {
        o.material = this.mats.chrome;
      } else if (name === 'plastic') {
        o.material = this.mats.blackMatte;
      } else if (name === 'full_black') {
        o.material = this.mats.blackGloss;
      } else if (name === 'Material.001') {
        // brake calipers — racing orange, faint glow under the moonlight
        if (!this.mats.caliper) {
          this.mats.caliper = new THREE.MeshStandardMaterial({
            color: 0xd8480f, metalness: 0.35, roughness: 0.42,
            emissive: 0x551602, emissiveIntensity: 0.7
          });
          this.mats.caliper.name = 'Material.001';
        }
        o.material = this.mats.caliper;
      } else if (name === 'tex_shiny' && o.name.startsWith('boot003')) {
        // rear light bar — brake reactive
        if (!this.mats.tailBar) {
          this.mats.tailBar = new THREE.MeshStandardMaterial({
            color: 0x30040a, emissive: 0xff1a1a, emissiveIntensity: 1.5,
            roughness: 0.3, metalness: 0.2
          });
        }
        o.material = this.mats.tailBar;
        tailBar = this.mats.tailBar;
      }
    });

    // wheel-well liners are added by _rigWheels once the wheel centers are known

    // mount: glTF nose +Z -> model space nose +X
    scene.rotation.y = Math.PI / 2;
    // raise so the tires rest on y = 0 (measured from the wheel pivots)
    const lift = 0.565;
    scene.position.y = lift;
    this.carRoot = scene;
    this.body.add(scene);

    this.tailBarMat = tailBar;
  }

  /** Dark liner half-cylinders behind each wheel (visual polish). — built in _rigWheels */

  // ---------------------------------------------------------- headlights
  _buildLights() {
    // real spotlights down the road (no shadows — cheap)
    const mk = (z) => {
      const light = new THREE.SpotLight(
        HEADLIGHTS.color, HEADLIGHTS.intensity,
        HEADLIGHTS.distance, HEADLIGHTS.angle, HEADLIGHTS.penumbra, HEADLIGHTS.decay
      );
      light.position.set(1.95, 0.52, z);
      light.castShadow = false;
      const target = new THREE.Object3D();
      target.position.set(34, -1.5, z * 1.4);
      this.body.add(light);
      this.body.add(target);
      light.target = target;
      return light;
    };
    this.headlightL = mk(0.55);
    this.headlightR = mk(-0.55);

    // lens halos (fake bloom)
    if (!this.mats.glowTex) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      const c = cv.getContext('2d');
      const g = c.createRadialGradient(64, 64, 4, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.4, 'rgba(255,255,255,0.28)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 128, 128);
      this.mats.glowTex = new THREE.CanvasTexture(cv);
      this.mats.glowTex.colorSpace = THREE.SRGBColorSpace;
    }
    const headGlow = new THREE.SpriteMaterial({
      map: this.mats.glowTex, color: 0xeaf4ff, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    for (const z of [0.55, -0.55]) {
      const sp = new THREE.Sprite(headGlow);
      sp.position.set(2.05, 0.5, z);
      sp.scale.set(0.5, 0.3, 1);
      this.body.add(sp);
    }
    // tail bar halo — brightness driven by braking in updateVisual
    this.tailGlowMat = new THREE.SpriteMaterial({
      map: this.mats.glowTex, color: 0xff2418, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    const tailSp = new THREE.Sprite(this.tailGlowMat);
    tailSp.position.set(-2.12, 0.62, 0);
    tailSp.scale.set(1.55, 0.4, 1);
    this.body.add(tailSp);
  }

  // -------------------------------------------------------------- wheels
  /**
   * The model merges each axle's four wheels into two meshes (tire/rim/disc
   * per material + caliper), both halves sharing one mesh per material.
   * This splits every part down the x = 0 plane and builds proper per-wheel
   * rigs: steer -> susp -> spin pivots at the true wheel centers.
   */
  _rigWheels(scene) {
    const axles = { rear: null, front: null };
    scene.traverse((o) => {
      if (o.isMesh) return;
      if (o.name.startsWith('Cylinder000')) axles.rear = o;
      else if (o.name.startsWith('Cylinder001')) axles.front = o;
    });

    const inv = new THREE.Matrix4();
    scene.updateMatrixWorld(true);
    inv.copy(scene.matrixWorld).invert();

    this.wheelRadius = CAR.wheelRadius;

    for (const [key, axle] of Object.entries(axles)) {
      if (!axle) continue;
      const meshes = [];
      axle.updateMatrixWorld(true);
      axle.traverse((o) => { if (o.isMesh) meshes.push(o); });

      // axle center from the tire mesh's world origin
      let tireMesh = null;
      for (const o of meshes) {
        if (o.material && o.material.name === 'rubber') tireMesh = o;
      }
      const centerLocal = new THREE.Vector3()
        .setFromMatrixPosition(tireMesh.matrixWorld)
        .applyMatrix4(inv);

      // tire radius (visual) from the full tire bbox
      {
        const g = toFloat32Geometry(tireMesh.geometry);
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, tireMesh.matrixWorld));
        g.computeBoundingBox();
        const size = g.boundingBox.getSize(new THREE.Vector3());
        this.wheelRadius = Math.max(0.2, (size.y + size.z) / 4);
        g.dispose();
      }

      for (const side of [1, -1]) {
        const wheelRoot = new THREE.Group();
        const steer = new THREE.Group();
        const susp = new THREE.Group();
        const spin = new THREE.Group();
        wheelRoot.add(steer); steer.add(susp); susp.add(spin);

        // split every part down the x = 0 plane (bake scene-space transforms)
        const halves = [];
        for (const mesh of meshes) {
          const g = toFloat32Geometry(mesh.geometry);
          g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
          const pos = g.attributes.position;
          const keep = new Array(pos.count);
          for (let i = 0; i < pos.count; i++) keep[i] = (pos.getX(i) * side) > -0.001;
          const g2 = keepTriangles(g, keep);
          if (g2) halves.push({ geometry: g2, material: mesh.material, isCaliper: mesh.material.name === 'Material.001' });
          g.dispose();
        }

        // wheel center x = centroid of this side's tire half
        let xHalf = centerLocal.x;
        const rub = halves.find((h) => h.material.name === 'rubber');
        if (rub) {
          rub.geometry.computeBoundingBox();
          xHalf = (rub.geometry.boundingBox.min.x + rub.geometry.boundingBox.max.x) / 2;
        }
        wheelRoot.position.set(xHalf, centerLocal.y, centerLocal.z);

        for (const h of halves) {
          const mm = new THREE.Mesh(h.geometry, h.material);
          mm.castShadow = true;
          mm.position.set(-xHalf, -centerLocal.y, -centerLocal.z);
          if (h.isCaliper) steer.add(mm);   // caliper steers, never spins
          else spin.add(mm);
        }

        scene.add(wheelRoot);
        this.wheels.push({
          steerGroup: steer, suspGroup: susp, spinGroup: spin,
          spinAxis: 'x',                     // glTF frame: axle along X
          front: key === 'front',
          side
        });
      }

      axle.visible = false;
    }

    // order wheels FL, FR, RL, RR to match phys.suspSmooth indices
    this.wheels.sort((a, b) => (b.front - a.front) || (a.side - b.side));

    // well liners behind each wheel
    const liners = [];
    for (const w of this.wheels) {
      const c = w.steerGroup.parent.position; // wheelRoot position (scene space)
      const R = this.wheelRadius;
      const lg = new THREE.CylinderGeometry(R + 0.05, R + 0.05, 0.30, 14, 1, true, Math.PI / 2, Math.PI);
      lg.rotateX(Math.PI / 2);              // axle along X in scene space
      lg.translate(c.x, c.y + 0.02, c.z);
      liners.push(toFloat32Geometry(lg));
    }
    if (liners.length) {
      const merged = mergeGeometriesFloat(liners);
      const linerMesh = new THREE.Mesh(merged, this.mats.well);
      this.carRoot.add(linerMesh);
    }
  }

  /** Minimal cockpit so the game stays playable if the interior GLB fails. */
  _buildFallbackCockpit() {
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.3, 1.3),
      this.mats.blackGloss
    );
    box.position.set(0.75, 0.75, 0);
    this.body.add(box);
    this.cockpitAnchor = new THREE.Object3D();
    this.cockpitAnchor.position.set(-0.05, 1.02, -0.33);
    this.body.add(this.cockpitAnchor);
    this.steeringSpin = new THREE.Group();
    this.body.add(this.steeringSpin);
    this.shifterGroup = new THREE.Group();
    this.body.add(this.shifterGroup);
    this.pedalThrottle = new THREE.Group();
    this.pedalBrake = new THREE.Group();
    this.handbrakeLever = new THREE.Group();
    this.helmet = new THREE.Group();
  }

  // ------------------------------------------------------------ per-frame
  /**
   * Sync visuals to physics state. Call once per rendered frame.
   * @param {number} dt
   * @param {VehiclePhysics} phys
   * @param {Transmission} trans
   * @param {RaceSystem} [race] — optional, feeds the Virtual Cockpit lap info
   */
  updateVisual(dt, phys, trans, race = null) {
    if (!this.ready) return;
    this._time += dt;

    this.group.position.set(phys.position.x, phys.position.y + 0.02, phys.position.z);
    this.group.rotation.y = phys.heading;

    // ---- wheels: spin (vF / true radius), steer, suspension travel --------
    const R = this.wheelRadius || CAR.wheelRadius;
    let spinRate = phys.vF / R;
    if (phys.wheelspin && trans.gear > 0) spinRate += 26;
    if (trans.wheelspin && trans.gear < 0) spinRate -= 14;
    this._spinAngle -= spinRate * dt;

    const steerTarget = -phys.steerAngle;
    this._steerVis = THREE.MathUtils.damp(this._steerVis, steerTarget, 12, dt);

    const susp = phys.suspSmooth;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      if (w.spinAxis === 'x') w.spinGroup.rotation.x = this._spinAngle;
      else w.spinGroup.rotation.z = this._spinAngle;
      if (w.front) w.steerGroup.rotation.y = this._steerVis;
      const travel = (susp[i] - 0.5) * 2 * SUSPENSION.travel;
      w.suspGroup.position.y = travel;
    }

    // ---- body attitude: road slope + suspension roll/pitch + bounce --------
    const roll = THREE.MathUtils.clamp(
      (susp[1] + susp[3] - susp[0] - susp[2]) * 0.5 * SUSPENSION.rollG * 6,
      -SUSPENSION.maxRoll, SUSPENSION.maxRoll
    );
    const pitch = THREE.MathUtils.clamp(
      (susp[2] + susp[3] - susp[0] - susp[1]) * 0.5 * SUSPENSION.accelPitch * 6,
      -SUSPENSION.maxPitch, SUSPENSION.maxPitch
    );
    // model frame (nose +X): pitch about Z, roll about X
    this.body.rotation.z = THREE.MathUtils.damp(
      this.body.rotation.z, pitch + phys.roadPitch, 8, dt);
    this.body.rotation.x = THREE.MathUtils.damp(
      this.body.rotation.x, roll + phys.roadRoll, 8, dt);

    // spring-damper body bounce (curbs / bumps settle naturally)
    const avgComp = (susp[0] + susp[1] + susp[2] + susp[3]) / 4;
    const targetY = -(avgComp - 0.5) * SUSPENSION.travel * 1.6;
    const k = 90, c = 13;
    const accel = (targetY - this._bodyY) * k - this._bodyYV * c;
    this._bodyYV += accel * dt;
    this._bodyY += this._bodyYV * dt;
    let bounceY = this._bodyY;
    if (phys.onCurb && Math.abs(phys.vF) > 6) {
      bounceY += Math.sin(this._time * SUSPENSION.bumpCurbFreq) * 0.012 * SUSPENSION.bumpCurbAmp * 2;
    }
    this.body.position.y = THREE.MathUtils.clamp(bounceY, -0.1, 0.1);

    // ---- steering wheel + shifter + pedals (interior rig) ------------------
    const steerVisNorm = this._steerVis / 0.5;
    if (this.steeringSpin) this.steeringSpin.rotation.z = -steerVisNorm * 2.4;
    if (this.shifterGroup) {
      this.shifterGroup.rotation.z = -trans.shifterX * 0.3;
      this.shifterGroup.rotation.x = trans.shifterZ * 0.24;
    }
    if (this.pedalThrottle) this.pedalThrottle.rotation.z = -0.35 + phys.throttleOut * 0.25;
    if (this.pedalBrake) this.pedalBrake.rotation.z = -0.35 + phys.brakeOut * 0.3;
    if (this.handbrakeLever) {
      this.handbrakeLever.rotation.z = phys.brakeOut > 0 && phys.vF < 1 ? 0.5 : 0.9;
    }

    // ---- lights -------------------------------------------------------------
    const braking = phys.brakeOut > 0.15 && phys.vF > 0.4;
    if (this.mats.tailBar) this.mats.tailBar.emissiveIntensity = braking ? 4.6 : 1.6;
    if (this.tailGlowMat) this.tailGlowMat.opacity = braking ? 0.75 : 0.26;

    // ---- ambient light line: slow breathing pulse ----------------------------
    if (this.mats.ambient) {
      this.mats.ambient.emissiveIntensity = 1.5 + Math.sin(this._time * 2.1) * 0.35;
    }

    // ---- cockpit visibility -------------------------------------------------
    if (this.helmet) this.helmet.visible = !this.cockpitMode && this.helmet.children.length > 0;
    // in cockpit view the donor cabin shell is switched off — the rigged
    // wheel, cluster and MMI are separate and stay; this keeps the sight line
    // to the road clean
    if (this.cabinGroup) this.cabinGroup.visible = !this.cockpitMode;

    // ---- live Virtual Cockpit (~20 Hz) ----------------------------------------
    this._clusterAcc += dt;
    if (this._clusterAcc > 0.05) {
      this._clusterAcc = 0;
      if (this.drawCluster) {
        this.drawCluster(this, trans.rpmNorm, phys.speedKmh, trans.gearLabel, trans.limiterCut, race);
      }
    }
    // ---- MMI minimap (~4 Hz) ---------------------------------------------------
    this._mmiAcc += dt;
    if (this._mmiAcc > 0.25) {
      this._mmiAcc = 0;
      if (this.drawMMI) this.drawMMI(this, ((phys.s % 1) + 1) % 1);
    }
  }
}

/** Merge plain float32 geometries (positions/normals/uvs must all exist or all not). */
function mergeGeometriesFloat(geos) {
  const out = new THREE.BufferGeometry();
  const names = Object.keys(geos[0].attributes);
  for (const name of names) {
    const item = geos[0].attributes[name].itemSize;
    let total = 0;
    for (const g of geos) total += g.attributes[name].array.length;
    const arr = new Float32Array(total);
    let o = 0;
    for (const g of geos) {
      arr.set(g.attributes[name].array, o);
      o += g.attributes[name].array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, item));
  }
  return out;
}
