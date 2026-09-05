/**
 * Interior — fully procedural steering wheel + dashboard + instrument cluster.
 *
 * No GLB assets are loaded. The steering wheel is built from a TorusGeometry
 * (the rim) + BoxGeometry (the spokes + hub). The dashboard is a shaped box.
 * The instrument cluster is a canvas-textured plane + two 3D needles.
 *
 * Everything is positioned relative to the car body using the CAR_DIMS
 * passed in from Car.js.
 */

import * as THREE from 'three';

export class Interior {
  constructor(car) {
    this.car = car;
    this.steeringPivot = null;
    this.steeringColumnAxis = 'z';  // procedural wheel spins around Z
    this.cockpitAnchor = null;
    this.clusterGroup = null;
    this.needleRPM = null;
    this.needleSpeed = null;
    this.clusterCanvas = null;
    this.clusterCtx = null;
    this.clusterTex = null;
    this._drawAcc = 0;
  }

  /**
   * Build the interior procedurally.
   * @param {THREE.Group} body — the car body group to attach to
   * @param {object} dims — car dimensions (from Car.js CAR_DIMS)
   */
  buildProcedural(body, dims) {
    const D = dims;

    // ---- materials -------------------------------------------------------
    const leatherMat = new THREE.MeshStandardMaterial({
      color: 0x1a1d22, roughness: 0.82, metalness: 0.05
    });
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0x0a0b0d, roughness: 0.7, metalness: 0.1
    });
    const spokeMat = new THREE.MeshStandardMaterial({
      color: 0x2a2d32, roughness: 0.5, metalness: 0.3
    });
    const dashMat = new THREE.MeshStandardMaterial({
      color: 0x14161a, roughness: 0.85, metalness: 0.05
    });
    const carbonMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a, roughness: 0.35, metalness: 0.5
    });

    // ---- dashboard (a shaped box across the cabin) ----------------------
    const dashGeo = new THREE.BoxGeometry(0.3, 0.25, D.width * 0.85);
    const dash = new THREE.Mesh(dashGeo, dashMat);
    dash.position.set(D.length / 2 - D.cabinLength / 2 - 0.2, D.rideHeight + D.hoodHeight + 0.15, 0);
    dash.castShadow = true;
    body.add(dash);

    // ---- steering wheel -------------------------------------------------
    // The wheel sits in front of the driver (left side = LHD).
    // In model space: +X = forward (nose), +Y = up, +Z = right.
    // The steering column points toward the driver (roughly -X + up).
    // The wheel face is in the Y-Z plane (spins around X).
    //
    // We create a pivot at the wheel center, then add:
    //   - rim (torus)
    //   - hub (cylinder)
    //   - 3 spokes (boxes)
    const swX = D.length / 2 - D.cabinLength / 2 - 0.05;  // just behind the dash face
    const swY = D.rideHeight + D.hoodHeight + 0.35;
    const swZ = -D.width * 0.18;  // LHD: driver sits on the left (-Z side)

    this.steeringPivot = new THREE.Group();
    this.steeringPivot.position.set(swX, swY, swZ);
    // tilt the wheel so it faces the driver (column goes down toward the dash)
    this.steeringPivot.rotation.y = Math.PI / 2;  // face the driver
    this.steeringPivot.rotation.z = 0.35;          // tilt back ~20°
    body.add(this.steeringPivot);

    // rim (torus in the Y-Z plane → spin around X)
    const rimRadius = 0.18;
    const rimGeo = new THREE.TorusGeometry(rimRadius, 0.018, 12, 32);
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.castShadow = true;
    this.steeringPivot.add(rim);

    // hub (small cylinder at the center)
    const hubGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.03, 16);
    hubGeo.rotateY(Math.PI / 2);  // axle along X
    const hub = new THREE.Mesh(hubGeo, spokeMat);
    this.steeringPivot.add(hub);

    // 3 spokes (boxes radiating from the hub)
    const spokeGeo = new THREE.BoxGeometry(0.02, rimRadius * 0.9, 0.02);
    for (let i = 0; i < 3; i++) {
      const spoke = new THREE.Mesh(spokeGeo, spokeMat);
      // rotate around X (the spin axis) so spokes radiate in the Y-Z plane
      spoke.rotation.x = (i / 3) * Math.PI * 2;
      spoke.position.y = Math.cos(spoke.rotation.x) * rimRadius * 0.5;
      spoke.position.z = Math.sin(spoke.rotation.x) * rimRadius * 0.5;
      this.steeringPivot.add(spoke);
    }

    // center badge (small red circle on the hub)
    const badgeGeo = new THREE.CircleGeometry(0.03, 16);
    const badgeMat = new THREE.MeshBasicMaterial({ color: 0xff3b30, toneMapped: false });
    const badge = new THREE.Mesh(badgeGeo, badgeMat);
    badge.position.x = 0.016;
    badge.rotation.y = Math.PI / 2;
    this.steeringPivot.add(badge);

    // ---- instrument cluster (behind the steering wheel) ----------------
    this._buildCluster(this.steeringPivot);

    // ---- cockpit camera anchor (at the driver's head) ------------------
    this.cockpitAnchor = new THREE.Object3D();
    this.cockpitAnchor.position.set(swX - 0.25, swY + 0.15, swZ);
    body.add(this.cockpitAnchor);

    // ---- driver's seat (simple box) ------------------------------------
    const seatBaseGeo = new THREE.BoxGeometry(0.4, 0.1, 0.45);
    const seatBase = new THREE.Mesh(seatBaseGeo, leatherMat);
    seatBase.position.set(swX - 0.15, D.rideHeight + 0.25, swZ);
    seatBase.castShadow = true;
    body.add(seatBase);

    const seatBackGeo = new THREE.BoxGeometry(0.08, 0.5, 0.45);
    const seatBack = new THREE.Mesh(seatBackGeo, leatherMat);
    seatBack.position.set(swX - 0.32, D.rideHeight + 0.5, swZ);
    seatBack.castShadow = true;
    body.add(seatBack);

    console.log('[Interior] Procedural interior built (steering wheel + cluster + seat)');
  }

  // ----------------------------------------------------------- instrument cluster
  _buildCluster(parentPivot) {
    const group = new THREE.Group();
    // place the cluster slightly above and behind the steering wheel
    group.position.set(0, 0.08, 0);
    group.rotation.y = 0;  // face the driver (same as the pivot)
    parentPivot.add(group);
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
      new THREE.PlaneGeometry(0.28, 0.14),
      new THREE.MeshBasicMaterial({ map: this.clusterTex, toneMapped: false })
    );
    face.position.set(0.02, 0, -0.001);
    face.rotation.y = Math.PI / 2;  // face the driver
    group.add(face);

    // ---- physical 3D needles --------------------------------------------
    const needleMat = new THREE.MeshBasicMaterial({
      color: 0xff3b30, toneMapped: false
    });

    const mkNeedle = (px, py) => {
      const pivot = new THREE.Group();
      pivot.position.set(0.015, py, px);
      const shaft = new THREE.Mesh(
        new THREE.BoxGeometry(0.003, 0.05, 0.003),
        needleMat
      );
      shaft.position.y = 0.024;
      pivot.add(shaft);
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(0.005, 0.006, 0.005, 10).rotateZ(Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x0a0a0a, toneMapped: false })
      );
      pivot.add(hub);
      group.add(pivot);
      return pivot;
    };

    // needles rotate around X (the spin axis of the cluster plane)
    this.needleRPM = mkNeedle(-0.06, -0.008);
    this.needleSpeed = mkNeedle(0.06, -0.008);

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
    ctx.fillText(gearLabel, w / 2, h * 0.45);

    ctx.fillStyle = '#cfd3da';
    ctx.font = 'bold 18px monospace';
    ctx.fillText(`${Math.round(speedKmh)}`, w / 2, h * 0.72);
    ctx.fillStyle = '#5a5e65';
    ctx.font = '10px monospace';
    ctx.fillText('km/h', w / 2, h * 0.85);

    this.clusterTex.needsUpdate = true;
  }

  // ----------------------------------------------------------- per-frame
  update(dt, phys, trans) {
    // ---- steering wheel rotation (around X = the column axis) -----------
    if (this.steeringPivot) {
      const steerVisNorm = phys.steerAngle / 0.5;
      const targetWheelRot = -steerVisNorm * Math.PI * 1.25;  // ±225°
      // preserve the initial tilt (rotation.y and rotation.z) and only
      // animate rotation.x (the spin axis)
      this.steeringPivot.rotation.x = THREE.MathUtils.damp(
        this.steeringPivot.rotation.x, targetWheelRot, 12, dt
      );
    }

    // ---- instrument cluster (update at ~20 Hz) --------------------------
    this._drawAcc += dt;
    if (this._drawAcc > 0.05 && this.clusterGroup) {
      this._drawAcc = 0;

      const rpmNorm = trans ? trans.rpmNorm : 0;
      const rpmAngle = -Math.PI * 0.75 + rpmNorm * Math.PI * 1.5;
      if (this.needleRPM) {
        this.needleRPM.rotation.x = THREE.MathUtils.damp(
          this.needleRPM.rotation.x, rpmAngle, 15, dt * 20
        );
      }

      const speedNorm = Math.min(1, Math.abs(phys.speedKmh) / 300);
      const speedAngle = -Math.PI * 0.75 + speedNorm * Math.PI * 1.5;
      if (this.needleSpeed) {
        this.needleSpeed.rotation.x = THREE.MathUtils.damp(
          this.needleSpeed.rotation.x, speedAngle, 15, dt * 20
        );
      }

      const gearLabel = trans ? trans.gearLabel : 'N';
      const limiter = trans ? trans.limiterCut : false;
      this._drawDialFace(rpmNorm, phys.speedKmh, gearLabel, limiter);
    }
  }
}
