/**
 * Car — Audi RS6 GT Avant, rigged for the game.
 *
 * The model comes from a Sketchfab export (vecarz.com) with 271 meshes,
 * 44 materials, and 293k triangles. The wheels are separate meshes (not
 * merged axles like the old Porsche), so we find them by material name
 * ("tire") and rig each one individually.
 *
 * Model space: the Audi GLB is authored with forward = +X, up = +Z
 * (Sketchfab FBX convention). We wrap it -90° about Y so forward = +Z
 * world (matching the game's convention). After the wrap:
 *   - forward = +Z (world)
 *   - up = +Y (world)
 *   - right = +X (world)
 *   - axle = X (wheel spin axis)
 *
 * The model is already in meters (tire diameter ~0.73m ≈ real RS6 22"
 * wheels). No scale correction needed.
 *
 * Wheel rigging:
 *   - Each wheel mesh is found by scanning for materials named "tire".
 *   - The mesh's world-space center (from its bounding box) determines
 *     whether it's front/rear and left/right.
 *   - Each wheel is re-parented under: steerGroup → suspGroup → spinGroup
 *     so front wheels can steer, all wheels can spin, and suspension
 *     travels independently per wheel.
 */

import * as THREE from 'three';
import { CAR, SUSPENSION, HEADLIGHTS, PAINTS } from './Constants.js';
import { loadGLB, toFloat32Geometry, keepTriangles, stripExtras } from './ModelKit.js';

export class Car {
  constructor(track = null) {
    this.track = track;
    this.ready = false;

    this.group = new THREE.Group();      // world transform (position + heading)
    this.model = new THREE.Group();      // static wrap: nose +X -> +Z
    this.model.rotation.y = -Math.PI / 2;
    this.group.add(this.model);

    this.body = new THREE.Group();       // suspension roll/pitch/bounce
    this.model.add(this.body);

    // defensive cockpit anchor (kept for backwards-compat with HUD code)
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

    // materials (built in _buildBaseMaterials)
    this.mats = {};
  }

  /**
   * Load + rig the Audi RS6. Call once; resolves after the car is rigged
   * and `ready` is true.
   */
  async build(onProgress) {
    const carScene = await loadGLB('./models/audi_rs6.glb',
      (t) => onProgress && onProgress(t));

    this._buildBaseMaterials();
    this._prepareExterior(carScene);
    this._rigWheelsFromMaterials(carScene);
    this._buildLights();

    // fallback cockpit anchor (the hood cam doesn't need a real interior)
    this._buildFallbackCockpit();

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
    // Note: the Audi model has its own materials, so setPaint only affects
    // the fallback paint material. The Audi's body material is kept as-is
    // from the GLB.
    this.mats.paint.color.setHex(p.color);
    const dark = (p.color >> 16 & 255) + (p.color >> 8 & 255) + (p.color & 255) < 180;
    this.mats.paint.metalness = dark ? 0.55 : 0.78;
    this.mats.paint.roughness = dark ? 0.34 : 0.27;
  }

  // ------------------------------------------------------------- exterior
  /**
   * Mount the glTF scene on the body. The Audi model already has good
   * materials (44 PBR materials with textures), so we keep them as-is.
   * We only strip lights/cameras from the FBX export and enable shadows.
   */
  _prepareExterior(scene) {
    stripExtras(scene);

    // ---- strip junk meshes that are way bigger than the car -------------
    // The Sketchfab export of the Audi RS6 includes a "hud1" material mesh
    // (mesh 217) that's 338 meters across — it's a HUD/overlay element that
    // should never appear in the game. It throws off the overall bounding
    // box and would render as a giant invisible plane. Strip any mesh whose
    // bounding box exceeds 8m in any dimension (the car itself is ~5m).
    const junk = [];
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      // compute the mesh's local-space bounding box
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      if (!bb) return;
      const size = bb.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 8) {
        const matName = (o.material && o.material.name) || '';
        console.warn(`[Car] Stripping junk mesh "${o.name}" (mat: ${matName}) — ${maxDim.toFixed(1)}m max dim`);
        junk.push(o);
      }
    });
    for (const o of junk) o.parent && o.parent.remove(o);

    // enable shadows on all remaining meshes
    scene.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });

    // The Audi GLB is authored nose +X. Mount it so nose -> +Z world.
    scene.rotation.y = Math.PI / 2;

    // The model is already in meters (tire diameter ~0.73m). No scale needed.
    // The scene's Y position will be set by _rigWheelsFromMaterials after
    // measuring the wheel positions so the tires rest on y=0.
    this._pendingLift = 0;
    scene.position.y = 0;
    this.carRoot = scene;
    this.body.add(scene);
  }

  // ---------------------------------------------------------- headlights
  _buildLights() {
    // Real spotlights down the road (no shadows — cheap)
    const mk = (z) => {
      const light = new THREE.SpotLight(
        HEADLIGHTS.color, HEADLIGHTS.intensity,
        HEADLIGHTS.distance, HEADLIGHTS.angle, HEADLIGHTS.penumbra, HEADLIGHTS.decay
      );
      // RS6 headlight positions (approximate, in body space after the +90° Y wrap)
      light.position.set(2.2, 0.6, z);
      light.castShadow = false;
      const target = new THREE.Object3D();
      target.position.set(34, -1.5, z * 1.4);
      this.body.add(light);
      this.body.add(target);
      light.target = target;
      return light;
    };
    this.headlightL = mk(0.75);
    this.headlightR = mk(-0.75);

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
    for (const z of [0.75, -0.75]) {
      const sp = new THREE.Sprite(headGlow);
      sp.position.set(2.3, 0.6, z);
      sp.scale.set(0.5, 0.3, 1);
      this.body.add(sp);
    }
    // tail bar halo — brightness driven by braking in updateVisual
    this.tailGlowMat = new THREE.SpriteMaterial({
      map: this.mats.glowTex, color: 0xff2418, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    const tailSp = new THREE.Sprite(this.tailGlowMat);
    tailSp.position.set(-2.4, 0.7, 0);
    tailSp.scale.set(1.55, 0.4, 1);
    this.body.add(tailSp);
  }

  // -------------------------------------------------------------- wheels
  /**
   * Find wheel meshes by material name and rig each one.
   *
   * The Audi model has 4 tire meshes (material name = "tire") + 4 brake/rim
   * detail meshes (material name = "WHEEL"). We use the "tire" meshes as
   * the primary wheels and attach the "WHEEL" meshes to the same spin group
   * if they're close to a tire.
   *
   * Each tire mesh's world-space center (from its bounding box) determines
   * its position: front/rear (Z axis) and left/right (X axis).
   */
  _rigWheelsFromMaterials(scene) {
    // ---- find all meshes with "tire" material ---------------------------
    const tireMeshes = [];
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const matName = (o.material.name || '').toLowerCase();
      if (matName === 'tire' || matName.includes('tyre')) {
        tireMeshes.push(o);
      }
    });

    if (tireMeshes.length < 4) {
      console.warn(`[Car] Found only ${tireMeshes.length} tire meshes (expected 4). ` +
        'Wheel rigging may be incomplete.');
    }

    // ---- compute each tire's world-space center + radius ----------------
    const tireData = tireMeshes.map((mesh) => {
      const g = toFloat32Geometry(mesh.geometry);
      g.applyMatrix4(mesh.matrixWorld);  // bake world transform into geometry
      g.computeBoundingBox();
      const bb = g.boundingBox;
      const center = bb.getCenter(new THREE.Vector3());
      const size = bb.getSize(new THREE.Vector3());
      // wheel diameter = max of the two non-axle dimensions
      // (the axle is the narrowest dimension = wheel width)
      const radius = Math.max(size.y, size.z) / 2;
      g.dispose();
      return { mesh, center, size, radius, worldMatrix: mesh.matrixWorld.clone() };
    });

    // ---- determine front/rear and left/right ----------------------------
    // After the +90° Y wrap in _prepareExterior, the model's +X (original
    // forward) becomes +Z (world forward). The wheel centers are in the
    // scene's local space (pre-wrap), so +X = forward, +Y = up, +Z = right.
    // We need to classify by the scene-local coordinates.
    //
    // Front vs rear: sort by X (forward axis in scene-local space)
    // Left vs right: sort by Z (lateral axis in scene-local space)

    // find the midpoints to split front/rear and left/right
    const xs = tireData.map(t => t.center.x).sort((a, b) => a - b);
    const zs = tireData.map(t => t.center.z).sort((a, b) => a - b);
    const xMid = (xs[0] + xs[xs.length - 1]) / 2;
    const zMid = (zs[0] + zs[zs.length - 1]) / 2;

    // classify each tire
    for (const t of tireData) {
      t.front = t.center.x > xMid;   // +X = front (nose)
      t.left = t.center.z > zMid;    // +Z = left (after wrap, this becomes -X = left)
    }

    // ---- measure the canonical wheel radius -----------------------------
    // Use the average of all tire radii
    this.wheelRadius = tireData.reduce((sum, t) => sum + t.radius, 0) / tireData.length;
    if (!this.wheelRadius || this.wheelRadius < 0.1) {
      this.wheelRadius = CAR.wheelRadius;
    }

    // ---- compute the scene lift so wheels rest on y=0 -------------------
    // The lowest tire center Y minus its radius = the lowest wheel bottom.
    // Lift = -(lowest bottom) so the wheel bottoms sit at y=0.
    let lowestBottom = Infinity;
    for (const t of tireData) {
      const bottom = t.center.y - t.radius;
      if (bottom < lowestBottom) lowestBottom = bottom;
    }
    this._pendingLift = -lowestBottom;
    if (this.carRoot) this.carRoot.position.y = this._pendingLift;

    // ---- rig each wheel: steer → susp → spin ----------------------------
    for (const t of tireData) {
      const wheelRoot = new THREE.Group();
      const steer = new THREE.Group();
      const susp = new THREE.Group();
      const spin = new THREE.Group();
      wheelRoot.add(steer); steer.add(susp); susp.add(spin);

      // place the wheel root at the tire's world center
      wheelRoot.position.copy(t.center);

      // re-parent the tire mesh under the spin group, offsetting so the
      // mesh's center sits at the spin group's origin
      const meshWorldPos = new THREE.Vector3().setFromMatrixPosition(t.mesh.matrixWorld);
      t.mesh.parent.remove(t.mesh);
      spin.add(t.mesh);
      // position the mesh so its geometry center is at the wheel root
      t.mesh.position.copy(t.center).sub(meshWorldPos);
      t.mesh.quaternion.identity();
      t.mesh.scale.set(1, 1, 1);

      scene.add(wheelRoot);

      this.wheels.push({
        steerGroup: steer,
        suspGroup: susp,
        spinGroup: spin,
        spinAxis: 'x',       // axle along X in scene space
        front: t.front,
        side: t.left ? 1 : -1,
        hubLocal: t.center.clone()
      });
    }

    // ---- sort wheels FL, FR, RL, RR to match phys.suspSmooth indices ----
    this.wheels.sort((a, b) => (b.front - a.front) || (a.side - b.side));

    // ---- build wheel well liners (visual polish) ------------------------
    this._buildWellLiners();
  }

  /** Dark liner half-cylinders behind each wheel (visual polish). */
  _buildWellLiners() {
    const liners = [];
    for (const w of this.wheels) {
      const c = w.steerGroup.parent.position;
      const R = this.wheelRadius;
      const lg = new THREE.CylinderGeometry(R + 0.05, R + 0.05, 0.30, 14, 1, true, Math.PI / 2, Math.PI);
      lg.rotateX(Math.PI / 2);
      lg.translate(c.x, c.y + 0.02, c.z);
      liners.push(toFloat32Geometry(lg));
    }
    if (liners.length) {
      let merged;
      try {
        // merge geometries manually (simple concatenation of position arrays)
        const totalVerts = liners.reduce((s, g) => s + g.attributes.position.count, 0);
        const arr = new Float32Array(totalVerts * 3);
        let o = 0;
        for (const g of liners) {
          arr.set(g.attributes.position.array, o);
          o += g.attributes.position.array.length;
        }
        const mergedGeo = new THREE.BufferGeometry();
        mergedGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        mergedGeo.computeVertexNormals();
        const linerMesh = new THREE.Mesh(mergedGeo, this.mats.well);
        this.carRoot.add(linerMesh);
      } catch (e) {
        console.warn('[Car] Well liner merge failed:', e);
      }
    }
  }

  /** Minimal cockpit so the game stays playable. */
  _buildFallbackCockpit() {
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
   * @param {RaceSystem} [race]
   */
  updateVisual(dt, phys, trans, race = null) {
    if (!this.ready) return;
    this._time += dt;

    this.group.position.set(phys.position.x, phys.position.y + 0.02, phys.position.z);
    this.group.rotation.y = phys.heading;

    // ---- wheels: spin (vF / true radius), steer, suspension travel --------
    const R = this.wheelRadius || CAR.wheelRadius;
    let baseSpinRate = phys.vF / R;
    const rearSpinBoost = (phys.wheelspin && trans.gear > 0) ? 22 : 0;
    const rearSpinCut  = (trans.wheelspin && trans.gear < 0) ? -12 : 0;
    this._spinAngle -= baseSpinRate * dt;

    const steerTarget = -phys.steerAngle;
    this._steerVis = THREE.MathUtils.damp(this._steerVis, steerTarget, 14, dt);

    const susp = phys.suspSmooth;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      let wheelSpin = this._spinAngle;
      if (!w.front) {
        wheelSpin -= (rearSpinBoost + rearSpinCut) * dt;
      }
      if (w.spinAxis === 'x') w.spinGroup.rotation.x = wheelSpin;
      else w.spinGroup.rotation.z = wheelSpin;
      if (w.front) w.steerGroup.rotation.y = this._steerVis;
      const travel = THREE.MathUtils.clamp(
        (susp[i] - 0.5) * 2 * SUSPENSION.travel,
        -SUSPENSION.travel * 0.9,
        SUSPENSION.travel * 0.9
      );
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

    // ---- lights -------------------------------------------------------------
    const braking = phys.brakeOut > 0.15 && phys.vF > 0.4;
    if (this.tailGlowMat) this.tailGlowMat.opacity = braking ? 0.75 : 0.26;
  }
}
