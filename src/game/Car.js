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
import { Interior } from './Interior.js';

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

    // ---- interior rig: steering wheel + instrument cluster + cockpit anchor
    this.interior = new Interior(this);
    this.interior.build(carScene);
    // the interior's cockpitAnchor replaces the fallback one
    if (this.interior.cockpitAnchor) {
      this.cockpitAnchor = this.interior.cockpitAnchor;
    }

    // fallback cockpit anchor (kept for backwards-compat)
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
   * Find wheel meshes and rig each one for spin + steer + suspension.
   *
   * The Audi model has 4 tire meshes whose positions are encoded in parent
   * node `matrix` properties (not `translation`). We find them by:
   *   1. Scanning for materials named "tire" or "wheel"
   *   2. Falling back to node names starting with "WHEEL_"
   *
   * CRITICAL: we must call this.group.updateMatrixWorld(true) BEFORE reading
   * any mesh.matrixWorld — otherwise the parent transforms (this.model's
   * -90° Y rotation + the scene's +90° Y rotation) haven't been composed
   * into matrixWorld, and all wheel positions come out as (0,0,0).
   */
  _rigWheelsFromMaterials(scene) {
    // ---- force-update the ENTIRE transform chain so matrixWorld is valid --
    // this.model has rotation.y = -PI/2 (set in constructor) but its
    // matrixWorld was never computed. Without this call, mesh.matrixWorld
    // is garbage and all wheel centers come out at (0,0,0).
    this.group.updateMatrixWorld(true);

    // ---- find tire meshes by material name OR node name -----------------
    const tireMeshes = [];
    const seen = new Set();
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry || seen.has(o)) return;
      const matName = (o.material && o.material.name || '').toLowerCase();
      const isTireByMat = matName === 'tire' || matName.includes('tyre');
      // also check the node name — the Audi has nodes named "WHEEL_RR_133"
      // etc. whose children include the tire mesh
      let isTireByNode = false;
      let parent = o.parent;
      while (parent && parent !== scene) {
        const pn = (parent.name || '').toUpperCase();
        if (pn.startsWith('WHEEL_')) {
          isTireByNode = true;
          break;
        }
        parent = parent.parent;
      }
      if (isTireByMat || (isTireByNode && matName.includes('tire'))) {
        tireMeshes.push(o);
        seen.add(o);
      }
    });

    console.log(`[Car] Found ${tireMeshes.length} tire meshes for wheel rigging`);
    if (tireMeshes.length < 4) {
      console.warn(`[Car] Expected 4 tire meshes, found ${tireMeshes.length}. ` +
        'Trying broader search...');
      // broader fallback: any mesh whose parent chain includes WHEEL_
      scene.traverse((o) => {
        if (!o.isMesh || !o.geometry || seen.has(o)) return;
        let parent = o.parent;
        while (parent && parent !== scene) {
          const pn = (parent.name || '').toUpperCase();
          if (pn.startsWith('WHEEL_') && o.geometry.attributes.position) {
            // check if this mesh looks like a wheel (roughly cylindrical)
            o.geometry.computeBoundingBox();
            const bb = o.geometry.boundingBox;
            if (bb) {
              const size = bb.getSize(new THREE.Vector3());
              // a wheel is wider in 2 dimensions than the 3rd (the axle)
              const sorted = [size.x, size.y, size.z].sort((a, b) => a - b);
              if (sorted[0] < sorted[1] * 0.6 && sorted[1] > 0.1) {
                tireMeshes.push(o);
                seen.add(o);
                break;
              }
            }
          }
          parent = parent.parent;
        }
      });
      console.log(`[Car] After broader search: ${tireMeshes.length} tire meshes`);
    }

    if (tireMeshes.length === 0) {
      console.error('[Car] No tire meshes found! Wheels will not be rigged.');
      return;
    }

    // ---- compute each tire's world-space center + radius ----------------
    // Use getWorldPosition + getWorldQuaternion for robust world-space reads
    const tireData = tireMeshes.map((mesh) => {
      // get the mesh's world position (this is the wheel hub center)
      const worldPos = new THREE.Vector3();
      mesh.getWorldPosition(worldPos);

      // compute the mesh's local-space bbox to find the radius
      mesh.geometry.computeBoundingBox();
      const localBB = mesh.geometry.boundingBox;
      const localSize = localBB.getSize(new THREE.Vector3());
      // the axle is the narrowest dimension; diameter = max of the other two
      const radius = Math.max(localSize.x, localSize.y, localSize.z) / 2;
      // actually, the radius should be the max of the two NON-axle dims.
      // But since we don't know which is the axle yet, take the max of all
      // three and divide by 2 — for a cylinder this gives the diameter/2.
      // For the Audi tires (0.299 x 0.729 x 0.729), max = 0.729, radius = 0.365.

      // Also get the world-space bbox by transforming the local bbox corners
      const worldCenter = worldPos.clone();
      // if the geometry is offset from the mesh origin, adjust
      const localCenter = localBB.getCenter(new THREE.Vector3());
      if (localCenter.lengthSq() > 0.001) {
        // geometry is offset from mesh origin — add the offset in world space
        worldCenter.add(localCenter);
      }

      return { mesh, center: worldCenter, size: localSize, radius };
    });

    // ---- determine front/rear and left/right ----------------------------
    // The wheel world positions are in the scene's local space (because
    // this.model's -90° and scene's +90° rotations cancel). In this space:
    //   +X = forward (nose), +Y = up, +Z = right
    // (This is the glTF's original coordinate system before the Y wrap.)
    const xs = tireData.map(t => t.center.x).sort((a, b) => a - b);
    const zs = tireData.map(t => t.center.z).sort((a, b) => a - b);
    const xMid = (xs[0] + xs[xs.length - 1]) / 2;
    const zMid = (zs[0] + zs[zs.length - 1]) / 2;

    for (const t of tireData) {
      t.front = t.center.x > xMid;
      t.left = t.center.z > zMid;
    }

    // ---- measure the canonical wheel radius -----------------------------
    this.wheelRadius = tireData.reduce((sum, t) => sum + t.radius, 0) / tireData.length;
    if (!this.wheelRadius || this.wheelRadius < 0.1) {
      this.wheelRadius = CAR.wheelRadius;
    }
    console.log(`[Car] Wheel radius: ${this.wheelRadius.toFixed(3)} m`);

    // ---- compute the scene lift so wheels rest on y=0 -------------------
    let lowestBottom = Infinity;
    for (const t of tireData) {
      const bottom = t.center.y - t.radius;
      if (bottom < lowestBottom) lowestBottom = bottom;
    }
    this._pendingLift = -lowestBottom;
    if (this.carRoot) this.carRoot.position.y = this._pendingLift;
    console.log(`[Car] Scene lift: ${this._pendingLift.toFixed(3)} m`);

    // ---- rig each wheel: steer → susp → spin ----------------------------
    // We need to convert the world-space center back to the scene's local
    // space (because wheelRoot is added to scene, which has rotation +90°).
    // Since this.model(-90°) * scene(+90°) = identity, the scene's local
    // space equals the world space (when group is at origin). So we can
    // use the world center directly.
    const sceneInv = new THREE.Matrix4().copy(scene.matrixWorld).invert();

    for (const t of tireData) {
      const wheelRoot = new THREE.Group();
      const steer = new THREE.Group();
      const susp = new THREE.Group();
      const spin = new THREE.Group();
      wheelRoot.add(steer); steer.add(susp); susp.add(spin);

      // Convert the world-space center to scene-local space
      const localCenter = t.center.clone().applyMatrix4(sceneInv);
      wheelRoot.position.copy(localCenter);

      // Re-parent the tire mesh under the spin group. The mesh's geometry
      // is in its own local space (centered at origin for the Audi tires),
      // so we just reset its transform and let the spin group's position
      // handle the placement.
      if (t.mesh.parent) t.mesh.parent.remove(t.mesh);
      spin.add(t.mesh);
      t.mesh.position.set(0, 0, 0);
      t.mesh.quaternion.identity();
      t.mesh.scale.set(1, 1, 1);

      scene.add(wheelRoot);

      // Determine the spin axis: the axle is the narrowest dimension of
      // the tire bbox. For the Audi, the tire is 0.299 (X) x 0.729 (Y) x
      // 0.729 (Z), so the axle is X → spin around X.
      const sortedDims = [
        { axis: 'x', val: t.size.x },
        { axis: 'y', val: t.size.y },
        { axis: 'z', val: t.size.z }
      ].sort((a, b) => a.val - b.val);
      const spinAxis = sortedDims[0].axis;

      this.wheels.push({
        steerGroup: steer,
        suspGroup: susp,
        spinGroup: spin,
        spinAxis: spinAxis,
        front: t.front,
        side: t.left ? 1 : -1,
        hubLocal: localCenter.clone()
      });

      console.log(`[Car] Wheel: ${t.front ? 'F' : 'R'}${t.left ? 'L' : 'R'} ` +
        `pos=(${localCenter.x.toFixed(2)}, ${localCenter.y.toFixed(2)}, ${localCenter.z.toFixed(2)}) ` +
        `spinAxis=${spinAxis}`);
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

    // ---- interior: steering wheel rotation + instrument cluster needles --
    if (this.interior) {
      this.interior.update(dt, phys, trans);
    }
  }
}
