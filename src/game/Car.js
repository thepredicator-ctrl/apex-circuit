/**
 * Car — fully procedural sporty wagon, built from Three.js primitives.
 *
 * No external GLB assets are loaded. The car body, cabin, wheels, lights,
 * spoiler, and interior are all generated from BoxGeometry, CylinderGeometry,
 * and other built-in shapes. This keeps the download tiny (~200 KB total
 * game bundle vs 70+ MB of GLB assets) and loads instantly.
 *
 * Model space: nose +X (wrapped -90° about Y so the nose points at +Z world).
 * `body` carries everything and receives suspension roll/pitch/bounce.
 *
 * Wheel rigs: steer → susp → spin pivots at the true wheel centers.
 *   - Front wheels steer around Y
 *   - All wheels spin around X (the axle)
 *   - Suspension travels along Y
 *
 * The interior (steering wheel + dashboard + instrument cluster) is built
 * by Interior.js which attaches to this car's body.
 */

import * as THREE from 'three';
import { CAR, SUSPENSION, HEADLIGHTS, PAINTS } from './Constants.js';
import { Interior } from './Interior.js';

// ---- procedural car dimensions (meters) -----------------------------------
const CAR_DIMS = {
  length: 4.9,       // overall length
  width: 1.95,       // overall width
  height: 1.45,      // overall height (to roof)
  wheelbase: 2.93,   // front-rear axle distance
  trackWidth: 1.62,  // left-right wheel distance
  wheelRadius: 0.365,
  wheelWidth: 0.30,
  rideHeight: 0.38,  // ground clearance at the body floor
  noseLength: 0.9,   // front overhang
  tailLength: 1.07,  // rear overhang
  cabinLength: 2.2,
  cabinHeight: 0.55,
  hoodHeight: 0.85,  // height of the hood line
  roofHeight: 1.40,
  windshieldAngle: 0.55,  // radians from vertical
  rearWindowAngle: 0.65,
};

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

    this.cockpitAnchor = new THREE.Object3D();
    this.body.add(this.cockpitAnchor);

    this.wheels = [];
    this._spinAngle = 0;
    this._steerVis = 0;
    this._time = 0;
    this._bodyY = 0;
    this._bodyYV = 0;
    this.cockpitMode = false;
    this.mats = {};
  }

  /** Build the entire car procedurally. No GLB loading. */
  async build(onProgress) {
    this._buildMaterials();
    this._buildBody();
    this._buildCabin();
    this._buildWheels();
    this._buildLights();
    this._buildSpoiler();

    // interior rig (steering wheel + dashboard + cockpit anchor)
    this.interior = new Interior(this);
    this.interior.buildProcedural(this.body, CAR_DIMS);
    if (this.interior.cockpitAnchor) {
      this.cockpitAnchor = this.interior.cockpitAnchor;
    }

    this.wheelRadius = CAR_DIMS.wheelRadius;
    this.ready = true;
    if (onProgress) onProgress(1);
  }

  // ----------------------------------------------------------- materials
  _buildMaterials() {
    this.mats = {
      paint: new THREE.MeshPhysicalMaterial({
        color: 0x1a3a5c, metalness: 0.6, roughness: 0.25,
        clearcoat: 1.0, clearcoatRoughness: 0.08, envMapIntensity: 1.4
      }),
      blackGloss: new THREE.MeshStandardMaterial({
        color: 0x0a0b0d, metalness: 0.5, roughness: 0.3
      }),
      blackMatte: new THREE.MeshStandardMaterial({
        color: 0x14161a, metalness: 0.1, roughness: 0.85
      }),
      glass: new THREE.MeshPhysicalMaterial({
        color: 0x0a1018, metalness: 0.1, roughness: 0.05,
        transparent: true, opacity: 0.35, envMapIntensity: 1.5,
        transmission: 0.5, clearcoat: 1.0
      }),
      chrome: new THREE.MeshStandardMaterial({
        color: 0xc0c4c8, metalness: 1.0, roughness: 0.15, envMapIntensity: 1.5
      }),
      tire: new THREE.MeshStandardMaterial({
        color: 0x0a0a0a, roughness: 0.95, metalness: 0.0
      }),
      rim: new THREE.MeshStandardMaterial({
        color: 0x8a8e95, metalness: 0.95, roughness: 0.2, envMapIntensity: 1.4
      }),
      headlight: new THREE.MeshStandardMaterial({
        color: 0xeef4ff, emissive: 0xcfe4ff, emissiveIntensity: 2.0,
        metalness: 0.2, roughness: 0.15
      }),
      taillight: new THREE.MeshStandardMaterial({
        color: 0x30040a, emissive: 0xff1a1a, emissiveIntensity: 1.5,
        roughness: 0.3, metalness: 0.2
      }),
      interior: new THREE.MeshStandardMaterial({
        color: 0x1a1d22, metalness: 0.05, roughness: 0.9
      }),
      interiorLight: new THREE.MeshStandardMaterial({
        color: 0x2a2d32, metalness: 0.1, roughness: 0.8
      }),
      needle: new THREE.MeshBasicMaterial({
        color: 0xff3b30, toneMapped: false
      }),
      screenGlow: new THREE.MeshBasicMaterial({ color: 0x0a0e14, toneMapped: false }),
      well: new THREE.MeshStandardMaterial({
        color: 0x060708, roughness: 0.97, metalness: 0.05, side: THREE.DoubleSide
      }),
      carbon: new THREE.MeshStandardMaterial({
        color: 0x0a0a0a, metalness: 0.5, roughness: 0.35
      })
    };
    this.setPaint('nightBlue');
  }

  setPaint(key) {
    const p = PAINTS[key] || PAINTS.nightBlue;
    this.paintKey = key in PAINTS ? key : 'nightBlue';
    this.mats.paint.color.setHex(p.color);
    const dark = (p.color >> 16 & 255) + (p.color >> 8 & 255) + (p.color & 255) < 180;
    this.mats.paint.metalness = dark ? 0.55 : 0.7;
    this.mats.paint.roughness = dark ? 0.3 : 0.22;
  }

  // ----------------------------------------------------------- body
  _buildBody() {
    const D = CAR_DIMS;
    const group = new THREE.Group();
    this.body.add(group);

    // ---- main body (lower section) --------------------------------------
    // Use a shaped box: the lower body is a box from the floor to the hood line
    const bodyGeo = new THREE.BoxGeometry(D.length, D.hoodHeight, D.width);
    // shape: taper the nose slightly (squeeze the front X-dimension at the top)
    const pos = bodyGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      // taper the front: if x > 0 (front), lower the top edge slightly
      if (x > 0 && y > 0) {
        pos.setY(i, y * 0.92);
      }
      // round the rear slightly
      if (x < 0 && y > 0) {
        pos.setY(i, y * 0.96);
      }
    }
    bodyGeo.computeVertexNormals();
    const bodyMesh = new THREE.Mesh(bodyGeo, this.mats.paint);
    bodyMesh.position.y = D.rideHeight + D.hoodHeight / 2;
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    group.add(bodyMesh);

    // ---- hood (front top surface, slightly sloped) ----------------------
    const hoodGeo = new THREE.BoxGeometry(D.noseLength, 0.08, D.width * 0.9);
    const hood = new THREE.Mesh(hoodGeo, this.mats.paint);
    hood.position.set(D.length / 2 - D.noseLength / 2, D.rideHeight + D.hoodHeight + 0.01, 0);
    hood.rotation.z = -0.04;  // slight slope down toward the nose
    hood.castShadow = true;
    group.add(hood);

    // ---- front bumper / splitter ----------------------------------------
    const bumperGeo = new THREE.BoxGeometry(0.15, 0.25, D.width);
    const bumper = new THREE.Mesh(bumperGeo, this.mats.blackMatte);
    bumper.position.set(D.length / 2, D.rideHeight + 0.15, 0);
    bumper.castShadow = true;
    group.add(bumper);

    // ---- rear bumper ----------------------------------------------------
    const rearBumper = new THREE.Mesh(bumperGeo, this.mats.blackMatte);
    rearBumper.position.set(-D.length / 2, D.rideHeight + 0.15, 0);
    rearBumper.castShadow = true;
    group.add(rearBumper);

    // ---- side skirts ----------------------------------------------------
    const skirtGeo = new THREE.BoxGeometry(D.length * 0.6, 0.12, 0.05);
    for (const side of [1, -1]) {
      const skirt = new THREE.Mesh(skirtGeo, this.mats.blackMatte);
      skirt.position.set(0, D.rideHeight - 0.02, side * D.width / 2);
      skirt.castShadow = true;
      group.add(skirt);
    }

    // ---- front grille ---------------------------------------------------
    const grilleGeo = new THREE.BoxGeometry(0.04, 0.18, D.width * 0.5);
    const grille = new THREE.Mesh(grilleGeo, this.mats.blackGloss);
    grille.position.set(D.length / 2 + 0.01, D.rideHeight + 0.35, 0);
    group.add(grille);

    // ---- wheel arches (dark recesses) ----------------------------------
    const archGeo = new THREE.CylinderGeometry(
      D.wheelRadius + 0.08, D.wheelRadius + 0.08, 0.12, 16, 1, true,
      Math.PI * 0.2, Math.PI * 0.6
    );
    archGeo.rotateZ(Math.PI / 2);
    const halfWB = D.wheelbase / 2;
    const halfTW = D.trackWidth / 2;
    for (const [fx, side] of [[halfWB, 1], [halfWB, -1], [-halfWB, 1], [-halfWB, -1]]) {
      const arch = new THREE.Mesh(archGeo, this.mats.blackMatte);
      arch.position.set(fx, D.rideHeight + D.wheelRadius * 0.5, side * halfTW);
      group.add(arch);
    }

    this.carRoot = group;
  }

  // ----------------------------------------------------------- cabin
  _buildCabin() {
    const D = CAR_DIMS;
    const group = new THREE.Group();

    // ---- greenhouse (the glass + roof section on top of the body) -------
    // Roof: a box from the top of the windshield to the top of the rear window
    const roofLength = D.cabinLength - 0.8;  // minus windshield + rear window
    const roofGeo = new THREE.BoxGeometry(roofLength, 0.06, D.width * 0.85);
    const roof = new THREE.Mesh(roofGeo, this.mats.paint);
    roof.position.set(-0.1, D.rideHeight + D.hoodHeight + D.cabinHeight, 0);
    roof.castShadow = true;
    group.add(roof);

    // ---- windshield (sloped glass panel) --------------------------------
    const wsGeo = new THREE.BoxGeometry(0.05, D.cabinHeight * 1.3, D.width * 0.82);
    const ws = new THREE.Mesh(wsGeo, this.mats.glass);
    const wsX = D.cabinLength / 2 - 0.2;
    ws.position.set(wsX, D.rideHeight + D.hoodHeight + D.cabinHeight * 0.6, 0);
    ws.rotation.z = D.windshieldAngle;
    group.add(ws);

    // ---- rear window ----------------------------------------------------
    const rwGeo = new THREE.BoxGeometry(0.05, D.cabinHeight * 1.2, D.width * 0.82);
    const rw = new THREE.Mesh(rwGeo, this.mats.glass);
    const rwX = -D.cabinLength / 2 + 0.15;
    rw.position.set(rwX, D.rideHeight + D.hoodHeight + D.cabinHeight * 0.55, 0);
    rw.rotation.z = -D.rearWindowAngle;
    group.add(rw);

    // ---- side windows ---------------------------------------------------
    const swGeo = new THREE.BoxGeometry(D.cabinLength * 0.85, D.cabinHeight * 0.7, 0.03);
    for (const side of [1, -1]) {
      const sw = new THREE.Mesh(swGeo, this.mats.glass);
      sw.position.set(-0.1, D.rideHeight + D.hoodHeight + D.cabinHeight * 0.55, side * D.width * 0.43);
      group.add(sw);
    }

    // ---- A-pillars + C-pillars (the black frames between windows) -------
    const pillarGeo = new THREE.BoxGeometry(0.06, D.cabinHeight * 1.2, 0.05);
    pillarGeo.rotateZ(D.windshieldAngle);
    for (const side of [1, -1]) {
      const aPillar = new THREE.Mesh(pillarGeo, this.mats.blackGloss);
      aPillar.position.set(wsX, D.rideHeight + D.hoodHeight + D.cabinHeight * 0.6, side * D.width * 0.42);
      group.add(aPillar);

      const cPillarGeo = new THREE.BoxGeometry(0.06, D.cabinHeight * 1.1, 0.05);
      cPillarGeo.rotateZ(-D.rearWindowAngle);
      const cPillar = new THREE.Mesh(cPillarGeo, this.mats.blackGloss);
      cPillar.position.set(rwX, D.rideHeight + D.hoodHeight + D.cabinHeight * 0.55, side * D.width * 0.42);
      group.add(cPillar);
    }

    // ---- B-pillar (middle) ----------------------------------------------
    const bPillarGeo = new THREE.BoxGeometry(0.06, D.cabinHeight * 0.7, 0.05);
    for (const side of [1, -1]) {
      const bPillar = new THREE.Mesh(bPillarGeo, this.mats.blackGloss);
      bPillar.position.set(-0.1, D.rideHeight + D.hoodHeight + D.cabinHeight * 0.55, side * D.width * 0.42);
      group.add(bPillar);
    }

    // ---- door handles (small chrome details) ----------------------------
    const handleGeo = new THREE.BoxGeometry(0.12, 0.025, 0.02);
    for (const side of [1, -1]) {
      for (const x of [0.3, -0.5]) {
        const handle = new THREE.Mesh(handleGeo, this.mats.chrome);
        handle.position.set(x, D.rideHeight + D.hoodHeight * 0.65, side * D.width / 2);
        group.add(handle);
      }
    }

    // ---- side mirrors ---------------------------------------------------
    const mirrorArmGeo = new THREE.BoxGeometry(0.08, 0.03, 0.1);
    const mirrorHeadGeo = new THREE.BoxGeometry(0.06, 0.08, 0.12);
    for (const side of [1, -1]) {
      const arm = new THREE.Mesh(mirrorArmGeo, this.mats.blackGloss);
      arm.position.set(0.6, D.rideHeight + D.hoodHeight * 0.75, side * D.width / 2);
      group.add(arm);
      const head = new THREE.Mesh(mirrorHeadGeo, this.mats.paint);
      head.position.set(0.6, D.rideHeight + D.hoodHeight * 0.75, side * (D.width / 2 + 0.08));
      head.castShadow = true;
      group.add(head);
    }

    this.body.add(group);
  }

  // ----------------------------------------------------------- wheels
  _buildWheels() {
    const D = CAR_DIMS;
    const halfWB = D.wheelbase / 2;
    const halfTW = D.trackWidth / 2;
    const wheelY = D.rideHeight + D.wheelRadius * 0.5;

    // wheel geometry: a cylinder oriented along X (the axle)
    const tireGeo = new THREE.CylinderGeometry(D.wheelRadius, D.wheelRadius, D.wheelWidth, 24);
    tireGeo.rotateZ(Math.PI / 2);  // axle along X

    // rim geometry: a slightly smaller, lighter-colored cylinder
    const rimGeo = new THREE.CylinderGeometry(D.wheelRadius * 0.65, D.wheelRadius * 0.65, D.wheelWidth + 0.01, 16);
    rimGeo.rotateZ(Math.PI / 2);

    // spoke geometry: 5 small boxes radiating from the hub
    const spokeGeo = new THREE.BoxGeometry(D.wheelWidth + 0.02, 0.04, D.wheelRadius * 0.55);

    const positions = [
      { x: halfWB, z: halfTW, front: true, side: 1 },    // FL
      { x: halfWB, z: -halfTW, front: true, side: -1 },   // FR
      { x: -halfWB, z: halfTW, front: false, side: 1 },   // RL
      { x: -halfWB, z: -halfTW, front: false, side: -1 }  // RR
    ];

    for (const p of positions) {
      const wheelRoot = new THREE.Group();
      const steer = new THREE.Group();
      const susp = new THREE.Group();
      const spin = new THREE.Group();
      wheelRoot.add(steer); steer.add(susp); susp.add(spin);

      wheelRoot.position.set(p.x, wheelY, p.z);

      // tire
      const tire = new THREE.Mesh(tireGeo, this.mats.tire);
      tire.castShadow = true;
      spin.add(tire);

      // rim
      const rim = new THREE.Mesh(rimGeo, this.mats.rim);
      spin.add(rim);

      // spokes
      for (let s = 0; s < 5; s++) {
        const spoke = new THREE.Mesh(spokeGeo, this.mats.rim);
        spoke.rotation.x = (s / 5) * Math.PI * 2;
        spin.add(spoke);
      }

      // brake caliper (small red box behind the wheel)
      const caliperGeo = new THREE.BoxGeometry(0.08, 0.12, 0.06);
      const caliper = new THREE.Mesh(caliperGeo, new THREE.MeshStandardMaterial({
        color: 0xd8480f, metalness: 0.35, roughness: 0.42,
        emissive: 0x551602, emissiveIntensity: 0.7
      }));
      caliper.position.set(0, -D.wheelRadius * 0.5, 0);
      steer.add(caliper);  // caliper doesn't spin

      this.body.add(wheelRoot);
      this.wheels.push({
        steerGroup: steer, suspGroup: susp, spinGroup: spin,
        spinAxis: 'x', front: p.front, side: p.side
      });
    }

    // sort FL, FR, RL, RR to match phys.suspSmooth indices
    this.wheels.sort((a, b) => (b.front - a.front) || (a.side - b.side));
  }

  // ----------------------------------------------------------- lights
  _buildLights() {
    const D = CAR_DIMS;

    // ---- headlights (emissive + spotlight) ------------------------------
    const headGeo = new THREE.BoxGeometry(0.04, 0.12, 0.22);
    for (const side of [1, -1]) {
      const head = new THREE.Mesh(headGeo, this.mats.headlight);
      head.position.set(D.length / 2 + 0.01, D.rideHeight + 0.45, side * 0.55);
      this.body.add(head);
    }

    // spotlight rigs
    const mk = (z) => {
      const light = new THREE.SpotLight(
        HEADLIGHTS.color, HEADLIGHTS.intensity,
        HEADLIGHTS.distance, HEADLIGHTS.angle, HEADLIGHTS.penumbra, HEADLIGHTS.decay
      );
      light.position.set(D.length / 2, D.rideHeight + 0.5, z);
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

    // headlight glow sprites
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.28)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
    const glowTex = new THREE.CanvasTexture(cv);
    glowTex.colorSpace = THREE.SRGBColorSpace;
    const headGlow = new THREE.SpriteMaterial({
      map: glowTex, color: 0xeaf4ff, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    for (const z of [0.55, -0.55]) {
      const sp = new THREE.Sprite(headGlow);
      sp.position.set(D.length / 2 + 0.05, D.rideHeight + 0.5, z);
      sp.scale.set(0.4, 0.25, 1);
      this.body.add(sp);
    }

    // ---- taillights (brake-reactive) ------------------------------------
    const tailGeo = new THREE.BoxGeometry(0.04, 0.08, 0.35);
    this.tailGlowMat = new THREE.SpriteMaterial({
      map: glowTex, color: 0xff2418, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    const tailBarMat = new THREE.MeshStandardMaterial({
      color: 0x30040a, emissive: 0xff1a1a, emissiveIntensity: 1.5,
      roughness: 0.3, metalness: 0.2
    });
    this.mats._tailBar = tailBarMat;
    const tail = new THREE.Mesh(tailGeo, tailBarMat);
    tail.position.set(-D.length / 2 - 0.01, D.rideHeight + 0.5, 0);
    this.body.add(tail);

    const tailSp = new THREE.Sprite(this.tailGlowMat);
    tailSp.position.set(-D.length / 2 - 0.1, D.rideHeight + 0.55, 0);
    tailSp.scale.set(1.4, 0.35, 1);
    this.body.add(tailSp);
  }

  // ----------------------------------------------------------- spoiler
  _buildSpoiler() {
    const D = CAR_DIMS;
    // a small wing at the rear (roof-height on a wagon)
    const wingGeo = new THREE.BoxGeometry(0.15, 0.03, D.width * 0.8);
    const wing = new THREE.Mesh(wingGeo, this.mats.blackGloss);
    wing.position.set(-D.length / 2 + 0.15, D.rideHeight + D.hoodHeight + D.cabinHeight + 0.02, 0);
    wing.castShadow = true;
    this.body.add(wing);

    // spoiler mounts
    const mountGeo = new THREE.BoxGeometry(0.04, 0.08, 0.03);
    for (const side of [1, -1]) {
      const mount = new THREE.Mesh(mountGeo, this.mats.blackMatte);
      mount.position.set(-D.length / 2 + 0.15, D.rideHeight + D.hoodHeight + D.cabinHeight - 0.04, side * 0.3);
      this.body.add(mount);
    }
  }

  // ----------------------------------------------------------- per-frame
  updateVisual(dt, phys, trans, race = null) {
    if (!this.ready) return;
    this._time += dt;

    this.group.position.set(phys.position.x, phys.position.y + 0.02, phys.position.z);
    this.group.rotation.y = phys.heading;

    // ---- wheels: spin, steer, suspension --------------------------------
    const R = this.wheelRadius || CAR.wheelRadius;
    const baseSpinRate = phys.vF / R;
    const rearSpinBoost = (phys.wheelspin && trans.gear > 0) ? 22 : 0;
    const rearSpinCut = (trans.wheelspin && trans.gear < 0) ? -12 : 0;
    this._spinAngle -= baseSpinRate * dt;

    const steerTarget = -phys.steerAngle;
    this._steerVis = THREE.MathUtils.damp(this._steerVis, steerTarget, 14, dt);

    const susp = phys.suspSmooth;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      let wheelSpin = this._spinAngle;
      if (!w.front) wheelSpin -= (rearSpinBoost + rearSpinCut) * dt;
      w.spinGroup.rotation.x = wheelSpin;
      if (w.front) w.steerGroup.rotation.y = this._steerVis;
      const travel = THREE.MathUtils.clamp(
        (susp[i] - 0.5) * 2 * SUSPENSION.travel,
        -SUSPENSION.travel * 0.9, SUSPENSION.travel * 0.9
      );
      w.suspGroup.position.y = travel;
    }

    // ---- body attitude -------------------------------------------------
    const roll = THREE.MathUtils.clamp(
      (susp[1] + susp[3] - susp[0] - susp[2]) * 0.5 * SUSPENSION.rollG * 6,
      -SUSPENSION.maxRoll, SUSPENSION.maxRoll
    );
    const pitch = THREE.MathUtils.clamp(
      (susp[2] + susp[3] - susp[0] - susp[1]) * 0.5 * SUSPENSION.accelPitch * 6,
      -SUSPENSION.maxPitch, SUSPENSION.maxPitch
    );
    this.body.rotation.z = THREE.MathUtils.damp(this.body.rotation.z, pitch + phys.roadPitch, 8, dt);
    this.body.rotation.x = THREE.MathUtils.damp(this.body.rotation.x, roll + phys.roadRoll, 8, dt);

    // spring-damper body bounce
    const avgComp = (susp[0] + susp[1] + susp[2] + susp[3]) / 4;
    const targetY = -(avgComp - 0.5) * SUSPENSION.travel * 1.6;
    const k = 90, cc = 13;
    const accel = (targetY - this._bodyY) * k - this._bodyYV * cc;
    this._bodyYV += accel * dt;
    this._bodyY += this._bodyYV * dt;
    let bounceY = this._bodyY;
    if (phys.onCurb && Math.abs(phys.vF) > 6) {
      bounceY += Math.sin(this._time * SUSPENSION.bumpCurbFreq) * 0.012 * SUSPENSION.bumpCurbAmp * 2;
    }
    this.body.position.y = THREE.MathUtils.clamp(bounceY, -0.1, 0.1);

    // ---- lights ---------------------------------------------------------
    const braking = phys.brakeOut > 0.15 && phys.vF > 0.4;
    if (this.mats._tailBar) this.mats._tailBar.emissiveIntensity = braking ? 4.6 : 1.5;
    if (this.tailGlowMat) this.tailGlowMat.opacity = braking ? 0.75 : 0.26;

    // ---- interior -------------------------------------------------------
    if (this.interior) this.interior.update(dt, phys, trans);
  }
}
