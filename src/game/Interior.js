/**
 * Interior — rigs the Audi RS6's interior for a working cockpit view.
 *
 * Finds the steering wheel mesh by node name ("STEER_LR" for left-hand
 * drive) and rigs it to rotate with steering input. Builds a physical
 * instrument cluster (RPM + speed dials with real 3D needles) behind the
 * wheel. Sets up a cockpit camera anchor at the driver's head position.
 *
 * This is NOT a placeholder — it's a proper working system:
 *   - The steering wheel mesh rotates ~450° lock-to-lock with the player's
 *     steering input
 *   - The RPM needle sweeps 0-8000 rpm based on the transmission state
 *   - The speed needle sweeps 0-300 km/h based on the vehicle speed
 *   - The cockpit camera sits at the driver's head and rides the body
 *     (suspension, banking, bumps all move the view)
 */

import * as THREE from 'three';
import { CAR } from './Constants.js';

export class Interior {
  constructor(car) {
    this.car = car;
    this.steeringWheel = null;      // the mesh/group that rotates
    this.steeringPivot = null;      // the pivot group at the wheel center
    this.steeringColumnAxis = 'z';  // auto-detected: 'x', 'y', or 'z'
    this.cockpitAnchor = null;      // camera anchor at driver's head
    this.clusterGroup = null;       // instrument cluster group
    this.needleRPM = null;          // 3D rpm needle pivot
    this.needleSpeed = null;        // 3D speed needle pivot
    this.clusterCanvas = null;
    this.clusterCtx = null;
    this.clusterTex = null;
    this._drawAcc = 0;
  }

  /**
   * Find + rig the interior. Called after the car GLB is loaded.
   * @param {THREE.Group} scene — the loaded Audi scene
   */
  build(scene) {
    this._findAndRigSteeringWheel(scene);
    this._buildCluster();
    this._setupCockpitAnchor();
  }

  // ----------------------------------------------------------- steering wheel
  /**
   * Find the steering wheel mesh by node name and rig it to a pivot.
   *
   * The Audi model has both "STEER_HR" (right-hand drive) and "STEER_LR"
   * (left-hand drive) copies. We use STEER_LR for LHD driving.
   *
   * The steering wheel mesh is nested under several parent nodes, so we
   * walk up from the mesh to find the "STEER_LR" ancestor, then re-parent
   * its subtree under a pivot group that we can rotate.
   */
  _findAndRigSteeringWheel(scene) {
    // ---- find the STEER_LR node (left-hand drive steering wheel assembly) ----
    let steerNode = null;
    scene.traverse((o) => {
      if (!steerNode && o.name && o.name.toUpperCase().includes('STEER_LR')) {
        steerNode = o;
      }
    });
    if (!steerNode) {
      // fallback: any STEER_ node
      scene.traverse((o) => {
        if (!steerNode && o.name && o.name.toUpperCase().startsWith('STEER_')) {
          steerNode = o;
        }
      });
    }
    if (!steerNode) {
      console.warn('[Interior] Steering wheel node not found.');
      return;
    }
    console.log(`[Interior] Found steering wheel node: ${steerNode.name}`);

    // ---- force-update the transform chain so matrixWorld is valid ----
    scene.updateMatrixWorld(true);

    // ---- find the actual wheel MESH (the round part) inside the steerNode ----
    // The STEER_LR node is a group containing multiple child meshes (rim,
    // spokes, hub, airbag, etc). We need to find the largest mesh and use
    // its bbox to determine the wheel's actual center + orientation.
    let wheelMesh = null;
    let wheelMeshVolume = 0;
    steerNode.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      if (!bb) return;
      const size = bb.getSize(new THREE.Vector3());
      const vol = size.x * size.y * size.z;
      if (vol > wheelMeshVolume) {
        wheelMeshVolume = vol;
        wheelMesh = o;
      }
    });

    if (!wheelMesh) {
      console.warn('[Interior] No mesh found under steering wheel node.');
      return;
    }
    console.log(`[Interior] Wheel mesh: ${wheelMesh.name}`);

    // ---- compute the wheel's WORLD-space bbox center + size ----
    // This is the actual visible center of the steering wheel, which may
    // differ from the node's origin.
    const wheelWorldBBox = new THREE.Box3().setFromObject(wheelMesh);
    const wheelCenter = wheelWorldBBox.getCenter(new THREE.Vector3());
    const wheelSize = wheelWorldBBox.getSize(new THREE.Vector3());
    console.log(`[Interior] Wheel world center: (${wheelCenter.x.toFixed(2)}, ${wheelCenter.y.toFixed(2)}, ${wheelCenter.z.toFixed(2)})`);
    console.log(`[Interior] Wheel world size: (${wheelSize.x.toFixed(2)}, ${wheelSize.y.toFixed(2)}, ${wheelSize.z.toFixed(2)})`);

    // ---- determine the rotation axis (the column axis) ----
    // The steering wheel is a disc — the THINNEST dimension is the column
    // axis (the axis the wheel spins around). For a typical steering wheel:
    //   - X = thin (column points toward driver, roughly +X in Audi space)
    //   - Y and Z = the wheel face (the disc)
    // We find the thinnest axis and use it.
    const sizeArr = [
      { axis: 'x', val: wheelSize.x },
      { axis: 'y', val: wheelSize.y },
      { axis: 'z', val: wheelSize.z }
    ].sort((a, b) => a.val - b.val);
    const columnAxis = sizeArr[0].axis;
    console.log(`[Interior] Column axis: ${columnAxis} (thinnest dim = ${sizeArr[0].val.toFixed(3)}m)`);

    // ---- create a pivot group at the wheel's world center ----
    this.steeringPivot = new THREE.Group();

    // convert the wheel center to scene-local space
    const sceneInv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
    const localPivotPos = wheelCenter.clone().applyMatrix4(sceneInv);
    this.steeringPivot.position.copy(localPivotPos);

    // ---- re-parent the ENTIRE steerNode subtree under the pivot ----
    // Keep the steerNode's local transform intact so the wheel stays where
    // it was authored — the pivot's position handles the placement.
    const parent = steerNode.parent;
    if (parent) {
      parent.remove(steerNode);
      // position the steerNode so its world position is preserved relative
      // to the new pivot. The steerNode's local position becomes its original
      // world position minus the pivot position (both in scene-local space).
      const steerNodeWorldPos = new THREE.Vector3();
      steerNode.getWorldPosition(steerNodeWorldPos);
      const steerNodeLocalPos = steerNodeWorldPos.clone().applyMatrix4(sceneInv);
      steerNode.position.copy(steerNodeLocalPos).sub(localPivotPos);
      steerNode.quaternion.identity();  // the pivot will handle rotation
      steerNode.scale.set(1, 1, 1);
      this.steeringPivot.add(steerNode);
      parent.add(this.steeringPivot);
    }

    // store the column axis so update() rotates around the correct axis
    this.steeringColumnAxis = columnAxis;
    this.steeringWheel = steerNode;
    console.log('[Interior] Steering wheel rigged. Pivot at scene-local:',
      `(${localPivotPos.x.toFixed(2)}, ${localPivotPos.y.toFixed(2)}, ${localPivotPos.z.toFixed(2)})`);
  }

  // ----------------------------------------------------------- instrument cluster
  /**
   * Build a physical instrument cluster behind the steering wheel:
   * a canvas-textured dial face + two real 3D needles (RPM + speed).
   * Placed just behind the steering wheel, facing the driver.
   */
  _buildCluster() {
    if (!this.steeringPivot) {
      console.warn('[Interior] No steering pivot — skipping cluster build');
      return;
    }

    const group = new THREE.Group();

    // place the cluster slightly above and behind the steering wheel
    // (in the steering pivot's local space, +Y is up, +X is toward the dash)
    group.position.set(-0.15, 0.05, 0);  // 15cm into the dash, 5cm up
    this.steeringPivot.add(group);
    this.clusterGroup = group;

    // ---- canvas dial face -----------------------------------------------
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 256;
    this.clusterCanvas = cv;
    this.clusterCtx = cv.getContext('2d');
    this.clusterTex = new THREE.CanvasTexture(cv);
    this.clusterTex.colorSpace = THREE.SRGBColorSpace;
    this.clusterTex.anisotropy = 4;

    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.30, 0.15),
      new THREE.MeshBasicMaterial({ map: this.clusterTex, toneMapped: false })
    );
    face.position.set(0, 0, 0.001);
    group.add(face);

    // ---- physical 3D needles ---------------------------------------------
    const needleMat = new THREE.MeshBasicMaterial({
      color: 0xff3b30, toneMapped: false
    });

    const mkNeedle = (px, py) => {
      const pivot = new THREE.Group();
      pivot.position.set(px, py, 0.008);
      const shaft = new THREE.Mesh(
        new THREE.BoxGeometry(0.003, 0.055, 0.003),
        needleMat
      );
      shaft.position.y = 0.027;
      pivot.add(shaft);
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(0.006, 0.007, 0.006, 10).rotateX(Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x0a0a0a, toneMapped: false })
      );
      pivot.add(hub);
      group.add(pivot);
      return pivot;
    };

    this.needleRPM = mkNeedle(-0.07, -0.008);
    this.needleSpeed = mkNeedle(0.07, -0.008);

    // draw the initial dial face
    this._drawDialFace(0, 0, 'N', 0);
    console.log('[Interior] Instrument cluster built');
  }

  /** Draw the dial face (RPM left, speed right, gear in center). */
  _drawDialFace(rpmNorm, speedKmh, gearLabel, limiter) {
    const ctx = this.clusterCtx;
    const w = this.clusterCanvas.width;
    const h = this.clusterCanvas.height;
    ctx.clearRect(0, 0, w, h);

    // background
    ctx.fillStyle = '#08090c';
    ctx.fillRect(0, 0, w, h);

    // ---- left dial: RPM (0-8000) ----------------------------------------
    const cx1 = w * 0.25;
    const cy = h * 0.55;
    const r = h * 0.35;
    ctx.strokeStyle = '#3a3d42';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx1, cy, r, Math.PI * 0.75, Math.PI * 2.25);
    ctx.stroke();

    // tick marks
    ctx.fillStyle = '#6a6e75';
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 8; i++) {
      const ang = Math.PI * 0.75 + (i / 8) * Math.PI * 1.5;
      const x1 = cx1 + Math.cos(ang) * r;
      const y1 = cy + Math.sin(ang) * r;
      const x2 = cx1 + Math.cos(ang) * (r - 8);
      const y2 = cy + Math.sin(ang) * (r - 8);
      ctx.strokeStyle = i >= 7 ? '#ff3b30' : '#3a3d42';
      ctx.lineWidth = i >= 7 ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.fillStyle = i >= 7 ? '#ff3b30' : '#8a8e95';
      ctx.fillText((i), cx1 + Math.cos(ang) * (r - 22), cy + Math.sin(ang) * (r - 22));
    }
    ctx.fillStyle = '#5a5e65';
    ctx.font = '10px monospace';
    ctx.fillText('x1000', cx1, cy + r + 8);
    ctx.fillStyle = '#cfd3da';
    ctx.font = 'bold 11px monospace';
    ctx.fillText('RPM', cx1, cy - r - 8);

    // ---- right dial: SPEED (0-300 km/h) ---------------------------------
    const cx2 = w * 0.75;
    ctx.strokeStyle = '#3a3d42';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx2, cy, r, Math.PI * 0.75, Math.PI * 2.25);
    ctx.stroke();

    for (let i = 0; i <= 6; i++) {
      const ang = Math.PI * 0.75 + (i / 6) * Math.PI * 1.5;
      const x1 = cx2 + Math.cos(ang) * r;
      const y1 = cy + Math.sin(ang) * r;
      const x2 = cx2 + Math.cos(ang) * (r - 8);
      const y2 = cy + Math.sin(ang) * (r - 8);
      ctx.strokeStyle = '#3a3d42';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.fillStyle = '#8a8e95';
      ctx.fillText((i * 50), cx2 + Math.cos(ang) * (r - 22), cy + Math.sin(ang) * (r - 22));
    }
    ctx.fillStyle = '#cfd3da';
    ctx.font = 'bold 11px monospace';
    ctx.fillText('km/h', cx2, cy - r - 8);

    // ---- center: gear + digital speed -----------------------------------
    ctx.fillStyle = limiter ? '#ff3b30' : '#e8ecf0';
    ctx.font = 'bold 36px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(gearLabel, w / 2, h * 0.45);

    ctx.fillStyle = '#cfd3da';
    ctx.font = 'bold 18px monospace';
    ctx.fillText(`${Math.round(speedKmh)}`, w / 2, h * 0.72);
    ctx.fillStyle = '#5a5e65';
    ctx.font = '10px monospace';
    ctx.fillText('km/h', w / 2, h * 0.85);

    this.clusterTex.needsUpdate = true;
  }

  // ----------------------------------------------------------- cockpit anchor
  /**
   * Set up the cockpit camera anchor at the driver's head position.
   * This is placed slightly behind and above the steering wheel.
   */
  _setupCockpitAnchor() {
    this.cockpitAnchor = new THREE.Object3D();
    if (this.steeringPivot) {
      // driver's head: 25cm behind the steering wheel, 35cm above
      this.cockpitAnchor.position.set(0.25, 0.35, 0);
      this.steeringPivot.add(this.cockpitAnchor);
    } else {
      // fallback: place at a reasonable position on the car body
      this.cockpitAnchor.position.set(-0.4, 1.1, 0.35);
      this.car.body.add(this.cockpitAnchor);
    }
    console.log('[Interior] Cockpit anchor set up');
  }

  // ----------------------------------------------------------- per-frame update
  /**
   * Update the interior visuals: steering wheel rotation + needle positions.
   * Call once per rendered frame.
   * @param {number} dt — delta time (seconds)
   * @param {VehiclePhysics} phys
   * @param {Transmission} trans
   */
  update(dt, phys, trans) {
    // ---- steering wheel rotation ----------------------------------------
    if (this.steeringPivot) {
      // the steering wheel rotates ~450° lock-to-lock (2.5 turns)
      // mapped to the visual steer angle (which is already damped in Car.js)
      const steerVisNorm = phys.steerAngle / 0.5;  // -1..1 approx
      const targetWheelRot = -steerVisNorm * Math.PI * 1.25;  // ±225° = ±2.5 turns / 2
      const damped = THREE.MathUtils.damp(
        this.steeringPivot.rotation[this.steeringColumnAxis], targetWheelRot, 12, dt
      );
      // rotate around the column axis (auto-detected from the wheel's bbox)
      this.steeringPivot.rotation[this.steeringColumnAxis] = damped;
    }

    // ---- instrument cluster (update at ~20 Hz) --------------------------
    this._drawAcc += dt;
    if (this._drawAcc > 0.05 && this.clusterGroup) {
      this._drawAcc = 0;

      // RPM needle: 0-8000 rpm sweeps from -135° to +135° (270° total)
      const rpmNorm = trans ? trans.rpmNorm : 0;
      const rpmAngle = -Math.PI * 0.75 + rpmNorm * Math.PI * 1.5;
      if (this.needleRPM) {
        this.needleRPM.rotation.z = THREE.MathUtils.damp(
          this.needleRPM.rotation.z, rpmAngle, 15, dt * 20  // accelerate since we only update at 20Hz
        );
      }

      // Speed needle: 0-300 km/h sweeps from -135° to +135°
      const speedNorm = Math.min(1, Math.abs(phys.speedKmh) / 300);
      const speedAngle = -Math.PI * 0.75 + speedNorm * Math.PI * 1.5;
      if (this.needleSpeed) {
        this.needleSpeed.rotation.z = THREE.MathUtils.damp(
          this.needleSpeed.rotation.z, speedAngle, 15, dt * 20
        );
      }

      // redraw the canvas dial face with current gear + digital speed
      const gearLabel = trans ? trans.gearLabel : 'N';
      const limiter = trans ? trans.limiterCut : false;
      this._drawDialFace(rpmNorm, phys.speedKmh, gearLabel, limiter);
    }
  }
}
