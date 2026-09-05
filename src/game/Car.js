/**
 * Car — a detailed low-poly RWD sports coupe built from Three.js primitives.
 *
 * Design goals:
 *   - Detailed but still stylized: tapered body panels, fender arches,
 *     5-spoke alloys with brake discs + calipers, dual exhausts, lip
 *     spoiler, grille with slats, DRL strips, mirrors, wipers, shark fin.
 *   - INSANE suspension travel (way more than realistic — bouncy + visible)
 *   - INSANE turning (huge steer angle, tight turning radius)
 *
 * Model space convention: +X = nose, +Y = up, +Z = right side.
 * The whole model group is rotated -90° around Y so the nose points along
 * the road tangent (world +Z at heading 0).
 */

import * as THREE from 'three';
import { CAR, SUSPENSION, HEADLIGHTS, PAINTS } from './Constants.js';
import { Interior } from './Interior.js';

const D = {
  length: 4.62,
  width: 1.86,
  height: 1.78,
  wheelbase: 2.72,
  trackWidth: 1.66,
  wheelRadius: 0.345,
  wheelWidth: 0.2,
  rideHeight: 0.3,        // ground -> rocker panel bottom
  beltline: 1.15,         // top of the lower body (rideHeight + hoodHeight)
  cabinLength: 2.05,
  cabinHeight: 0.62,
  hoodHeight: 0.85,
};
D.roofY = D.rideHeight + D.hoodHeight + D.cabinHeight;

/**
 * A box whose top face is scaled/shifted — the workhorse for sculpted
 * low-poly car volumes (tapered hulls, sloped decks, cabin glass).
 */
function taperBox(w, h, d, { topW = 1, topD = 1, topShiftX = 0, topShiftZ = 0 } = {}) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) {
      pos.setX(i, pos.getX(i) * topW + topShiftX);
      pos.setZ(i, pos.getZ(i) * topD + topShiftZ);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

export class Car {
  constructor(track = null) {
    this.track = track;
    this.ready = false;

    this.group = new THREE.Group();
    this.model = new THREE.Group();
    this.model.rotation.y = -Math.PI / 2;
    this.group.add(this.model);

    this.body = new THREE.Group();
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

  async build(onProgress) {
    this._buildMaterials();
    this._buildBody();
    this._buildCabin();
    this._buildWheels();
    this._buildLights();

    this.interior = new Interior(this);
    this.interior.buildProcedural(this.body, D);
    if (this.interior.cockpitAnchor) {
      this.cockpitAnchor = this.interior.cockpitAnchor;
    }

    this.wheelRadius = D.wheelRadius;
    this.ready = true;
    if (onProgress) onProgress(1);
  }

  _buildMaterials() {
    this.mats = {
      paint: new THREE.MeshPhysicalMaterial({
        color: 0x2a4d6e, metalness: 0.32, roughness: 0.46,
        clearcoat: 0.4, clearcoatRoughness: 0.5, envMapIntensity: 0.38
      }),
      glass: new THREE.MeshStandardMaterial({
        color: 0x0d1420, metalness: 0.35, roughness: 0.08,
        transparent: true, opacity: 0.55, envMapIntensity: 1.3
      }),
      black: new THREE.MeshStandardMaterial({
        color: 0x121316, roughness: 0.72, metalness: 0.1
      }),
      darkTrim: new THREE.MeshStandardMaterial({
        color: 0x1b1d21, roughness: 0.5, metalness: 0.25
      }),
      chrome: new THREE.MeshStandardMaterial({
        color: 0xc8ccd2, metalness: 1.0, roughness: 0.18, envMapIntensity: 1.2
      }),
      tire: new THREE.MeshStandardMaterial({
        color: 0x0b0b0c, roughness: 0.96, metalness: 0
      }),
      rim: new THREE.MeshStandardMaterial({
        color: 0x9ba1a9, metalness: 0.9, roughness: 0.34, envMapIntensity: 0.9
      }),
      rimDark: new THREE.MeshStandardMaterial({
        color: 0x2a2d33, metalness: 0.8, roughness: 0.45
      }),
      disc: new THREE.MeshStandardMaterial({
        color: 0x9aa0a8, metalness: 0.95, roughness: 0.38
      }),
      caliper: new THREE.MeshStandardMaterial({
        color: 0xc41020, metalness: 0.35, roughness: 0.42,
        emissive: 0x40030a, emissiveIntensity: 0.35
      }),
      headlight: new THREE.MeshStandardMaterial({
        color: 0xeef4ff, emissive: 0xcfe4ff, emissiveIntensity: 1.5
      }),
      drl: new THREE.MeshBasicMaterial({ color: 0xbfe2ff, toneMapped: false }),
      interior: new THREE.MeshStandardMaterial({
        color: 0x1a1d22, roughness: 0.9
      }),
      needle: new THREE.MeshBasicMaterial({ color: 0xff3b30, toneMapped: false }),
      screenGlow: new THREE.MeshBasicMaterial({ color: 0x0a0e14, toneMapped: false }),
      plate: new THREE.MeshStandardMaterial({ color: 0xd8dade, roughness: 0.5 }),
    };
    this.mats._tail = new THREE.MeshStandardMaterial({
      color: 0x30040a, emissive: 0xff1a1a, emissiveIntensity: 1.2, roughness: 0.3
    });
    this.mats._reverse = new THREE.MeshStandardMaterial({
      color: 0xd8dde2, emissive: 0xffffff, emissiveIntensity: 0.12, roughness: 0.3
    });
  }

  setPaint(key) {
    const p = PAINTS[key] || PAINTS.nightBlue;
    this.mats.paint.color.setHex(p.color);
  }

  /** turn the headlight rig on/off (time of day) */
  setHeadlights(on) {
    this.headlightsTarget = !!on;
  }

  // ================================================================ body

  _buildBody() {
    const g = new THREE.Group();
    const R = D.rideHeight, L = D.length, W = D.width;

    // ---- underbody (dark, blocks light gaps) ----------------------------
    const under = new THREE.Mesh(
      taperBox(L * 0.86, 0.24, W * 0.84, { topW: 0.94, topD: 0.9 }),
      this.mats.black
    );
    under.position.set(0, R + 0.02, 0);
    g.add(under);

    // ---- lower hull -------------------------------------------------------
    const hull = new THREE.Mesh(
      taperBox(L * 0.985, 0.52, W, { topW: 0.975, topD: 0.98 }),
      this.mats.paint
    );
    hull.position.set(0, R + 0.26, 0);
    hull.castShadow = true;
    hull.receiveShadow = true;
    g.add(hull);

    // ---- upper hull (shoulder line, tumbles inward) ----------------------
    const upper = new THREE.Mesh(
      taperBox(L * 0.955, 0.33, W * 0.955, { topW: 0.9, topD: 0.945, topShiftX: -0.06 }),
      this.mats.paint
    );
    upper.position.set(-0.02, R + 0.685, 0);
    upper.castShadow = true;
    g.add(upper);

    // ---- hood (sloped, with power bulge) ---------------------------------
    const hood = new THREE.Mesh(
      taperBox(1.52, 0.1, W * 0.9, { topW: 0.74, topD: 0.84 }),
      this.mats.paint
    );
    hood.position.set(1.42, R + D.hoodHeight + 0.035, 0);
    hood.rotation.z = -0.055;
    hood.castShadow = true;
    g.add(hood);

    const bulge = new THREE.Mesh(
      taperBox(0.72, 0.05, 0.52, { topW: 0.7, topD: 0.7 }),
      this.mats.paint
    );
    bulge.position.set(1.52, R + D.hoodHeight + 0.1, 0);
    bulge.rotation.z = -0.055;
    g.add(bulge);

    // ---- trunk deck + lip spoiler ----------------------------------------
    const deck = new THREE.Mesh(
      taperBox(1.02, 0.09, W * 0.9, { topW: 0.86, topD: 0.92 }),
      this.mats.paint
    );
    deck.position.set(-1.62, R + D.hoodHeight + 0.03, 0);
    deck.rotation.z = 0.028;
    deck.castShadow = true;
    g.add(deck);

    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, W * 0.82), this.mats.paint);
    spoiler.position.set(-2.14, R + D.hoodHeight + 0.1, 0);
    spoiler.rotation.z = 0.1;
    g.add(spoiler);
    for (const z of [0.45, -0.45]) {
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.05), this.mats.black);
      stand.position.set(-2.12, R + D.hoodHeight + 0.05, z);
      g.add(stand);
    }

    // ---- front fascia: bumper, splitter, grille, plate --------------------
    const fbumper = new THREE.Mesh(
      taperBox(0.26, 0.3, W * 0.99, { topW: 0.92, topD: 0.96 }),
      this.mats.black
    );
    fbumper.position.set(2.2, R + 0.18, 0);
    fbumper.castShadow = true;
    g.add(fbumper);

    const splitter = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.05, W * 0.92), this.mats.darkTrim);
    splitter.position.set(2.08, R - 0.015, 0);
    g.add(splitter);

    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, W * 0.52), this.mats.black);
    grille.position.set(2.32, R + 0.42, 0);
    g.add(grille);
    for (let i = 0; i < 3; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.028, W * 0.5), this.mats.chrome);
      slat.position.set(2.345, R + 0.355 + i * 0.065, 0);
      g.add(slat);
    }

    const plateF = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.14, 0.46), this.mats.plate);
    plateF.position.set(2.33, R + 0.16, 0);
    g.add(plateF);

    // ---- rear fascia: diffuser, exhausts, reverse lights, plate ----------
    const rbumper = new THREE.Mesh(
      taperBox(0.24, 0.3, W * 0.99, { topW: 0.92, topD: 0.96 }),
      this.mats.black
    );
    rbumper.position.set(-2.2, R + 0.18, 0);
    rbumper.castShadow = true;
    g.add(rbumper);

    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, W * 0.8), this.mats.darkTrim);
    diffuser.position.set(-2.12, R + 0.06, 0);
    g.add(diffuser);
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.022), this.mats.black);
      fin.position.set(-2.13, R + 0.05, -0.51 + i * 0.34);
      g.add(fin);
    }

    const exhGeo = new THREE.CylinderGeometry(0.052, 0.058, 0.2, 10);
    exhGeo.rotateZ(Math.PI / 2);
    for (const z of [0.44, -0.44]) {
      const tip = new THREE.Mesh(exhGeo, this.mats.chrome);
      tip.position.set(-2.32, R + 0.14, z);
      g.add(tip);
      const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.21, 8).rotateZ(Math.PI / 2), this.mats.black);
      inner.position.set(-2.325, R + 0.14, z);
      g.add(inner);
    }

    const plateR = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.13, 0.44), this.mats.plate);
    plateR.position.set(-2.33, R + 0.42, -0.35);
    g.add(plateR);
    for (const z of [0.3, 0.4]) {
      const rev = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.07), this.mats._reverse);
      rev.position.set(-2.325, R + 0.28, z);
      g.add(rev);
    }

    // ---- side skirts + shutlines + handles --------------------------------
    const skirtGeo = new THREE.BoxGeometry(2.35, 0.1, 0.06);
    const shutGeo = new THREE.BoxGeometry(0.016, 0.44, 0.014);
    const handleGeo = new THREE.BoxGeometry(0.17, 0.034, 0.024);
    for (const side of [1, -1]) {
      const skirt = new THREE.Mesh(skirtGeo, this.mats.darkTrim);
      skirt.position.set(-0.05, R + 0.05, side * (W / 2 - 0.02));
      g.add(skirt);

      for (const x of [0.52, -0.62]) {
        const line = new THREE.Mesh(shutGeo, this.mats.black);
        line.position.set(x, R + 0.52, side * (W / 2 + 0.005));
        g.add(line);
      }
      for (const x of [0.3, -0.4]) {
        const h = new THREE.Mesh(handleGeo, this.mats.chrome);
        h.position.set(x, R + 0.72, side * (W / 2 + 0.012));
        g.add(h);
      }
    }

    // ---- fender arches (half-torus flares over each wheel) ----------------
    const halfWB = D.wheelbase / 2;
    const archGeo = new THREE.TorusGeometry(0.5, 0.072, 6, 12, Math.PI);
    for (const x of [halfWB, -halfWB]) {
      for (const side of [1, -1]) {
        const arch = new THREE.Mesh(archGeo, this.mats.paint);
        arch.position.set(x, D.wheelRadius + 0.03, side * (W / 2 - 0.055));
        arch.castShadow = true;
        g.add(arch);
      }
    }

    // ---- mirrors (stalk + shell + glass) ----------------------------------
    for (const side of [1, -1]) {
      const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.024, 0.1), this.mats.black);
      stalk.position.set(0.72, R + D.hoodHeight + 0.09, side * 0.97);
      g.add(stalk);
      const shell = new THREE.Mesh(taperBox(0.09, 0.075, 0.15, { topW: 0.82, topD: 0.86 }), this.mats.paint);
      shell.position.set(0.72, R + D.hoodHeight + 0.13, side * 1.04);
      g.add(shell);
      const mglass = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.06, 0.12), this.mats.chrome);
      mglass.position.set(0.72, R + D.hoodHeight + 0.13, side * 1.115);
      g.add(mglass);
    }

    // ---- wipers ------------------------------------------------------------
    for (const z of [0.26, -0.2]) {
      const wiper = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.015, 0.4), this.mats.black);
      wiper.position.set(1.02, R + D.hoodHeight + 0.045, z);
      wiper.rotation.x = 0.06;
      g.add(wiper);
    }

    this.carRoot = g;
    this.body.add(g);
  }

  // ================================================================ cabin

  _buildCabin() {
    const g = new THREE.Group();
    const R = D.rideHeight, W = D.width;
    const belt = R + D.hoodHeight;             // 1.15
    const roofTop = D.roofY;                   // 1.77
    const roofY = roofTop - 0.02;

    // ---- roof panel + sunroof ---------------------------------------------
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.06, 1.46), this.mats.paint);
    roof.position.set(-0.33, roofY, 0);
    roof.castShadow = true;
    g.add(roof);

    const sunroof = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.022, 0.78), this.mats.glass);
    sunroof.position.set(-0.4, roofTop + 0.015, 0);
    g.add(sunroof);

    // ---- shark fin antenna --------------------------------------------------
    const fin = new THREE.Mesh(taperBox(0.2, 0.075, 0.055, { topW: 0.15, topD: 0.3 }), this.mats.black);
    fin.position.set(-1.22, roofTop + 0.035, 0);
    g.add(fin);

    // ---- windshield (raked slab, Y-long axis tilted back) --------------------
    const ws = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.92, W * 0.78), this.mats.glass);
    ws.position.set(0.78, belt + 0.3, 0);
    ws.rotation.z = 0.72;
    g.add(ws);

    // ---- rear window ----------------------------------------------------------
    const rw = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.84, W * 0.73), this.mats.glass);
    rw.position.set(-1.42, belt + 0.32, 0);
    rw.rotation.z = -0.75;
    g.add(rw);

    // ---- side glass + chrome trim + B-pillars -------------------------------
    const swGeo = new THREE.BoxGeometry(1.66, 0.42, 0.03);
    const trimGeo = new THREE.BoxGeometry(1.85, 0.035, 0.045);
    const bPillarGeo = new THREE.BoxGeometry(0.06, 0.44, 0.045);
    for (const side of [1, -1]) {
      const sw = new THREE.Mesh(swGeo, this.mats.glass);
      sw.position.set(-0.36, belt + 0.35, side * 0.71);
      g.add(sw);

      const trim = new THREE.Mesh(trimGeo, this.mats.chrome);
      trim.position.set(-0.36, belt + 0.11, side * 0.725);
      g.add(trim);

      const bp = new THREE.Mesh(bPillarGeo, this.mats.black);
      bp.position.set(-0.52, belt + 0.34, side * 0.715);
      g.add(bp);
    }

    // ---- A / C pillars (follow the glass rake) ---------------------------------
    const aPillarGeo = new THREE.BoxGeometry(0.08, 0.96, 0.09);
    const cPillarGeo = new THREE.BoxGeometry(0.1, 0.88, 0.1);
    for (const side of [1, -1]) {
      const ap = new THREE.Mesh(aPillarGeo, this.mats.paint);
      ap.position.set(0.78, belt + 0.3, side * 0.735);
      ap.rotation.z = 0.72;
      g.add(ap);

      const cp = new THREE.Mesh(cPillarGeo, this.mats.paint);
      cp.position.set(-1.42, belt + 0.32, side * 0.72);
      cp.rotation.z = -0.75;
      g.add(cp);
    }

    this.body.add(g);
  }

  // ================================================================ wheels

  _buildWheels() {
    const halfWB = D.wheelbase / 2;
    const halfTW = D.trackWidth / 2;
    const R = D.wheelRadius;
    const wheelY = R;                     // axle at hub height — tire touches ground

    // torus tire (axis = Z, lateral) with an open center so the rim shows
    const tireGeo = new THREE.TorusGeometry(R - 0.088, 0.094, 8, 20);
    const barrelGeo = new THREE.CylinderGeometry(R * 0.56, R * 0.56, 0.2, 16, 1, true);
    barrelGeo.rotateX(Math.PI / 2);
    const faceGeo = new THREE.CylinderGeometry(R * 0.565, R * 0.565, 0.028, 16);
    faceGeo.rotateX(Math.PI / 2);
    const spokeGeo = new THREE.BoxGeometry(0.06, 0.16, 0.05);
    spokeGeo.translate(0, 0.14, 0);
    const capGeo = new THREE.CylinderGeometry(0.068, 0.074, 0.045, 10);
    capGeo.rotateX(Math.PI / 2);
    const discGeo = new THREE.CylinderGeometry(R * 0.5, R * 0.5, 0.024, 16);
    discGeo.rotateX(Math.PI / 2);
    const caliperGeo = new THREE.BoxGeometry(0.07, 0.14, 0.07);

    const positions = [
      { x: halfWB, z: halfTW, front: true, side: 1 },
      { x: halfWB, z: -halfTW, front: true, side: -1 },
      { x: -halfWB, z: halfTW, front: false, side: 1 },
      { x: -halfWB, z: -halfTW, front: false, side: -1 }
    ];

    for (const p of positions) {
      const wheelRoot = new THREE.Group();
      const steer = new THREE.Group();
      const susp = new THREE.Group();
      const spin = new THREE.Group();
      wheelRoot.add(steer); steer.add(susp); susp.add(spin);
      wheelRoot.position.set(p.x, wheelY, p.z);

      const tire = new THREE.Mesh(tireGeo, this.mats.tire);
      tire.castShadow = true;
      spin.add(tire);

      const barrel = new THREE.Mesh(barrelGeo, this.mats.rimDark);
      spin.add(barrel);

      const face = new THREE.Mesh(faceGeo, this.mats.rim);
      face.position.z = p.side * 0.055;
      spin.add(face);

      // 5 spokes on the outer face
      for (let s = 0; s < 5; s++) {
        const spoke = new THREE.Mesh(spokeGeo, this.mats.rim);
        spoke.rotation.z = (s / 5) * Math.PI * 2;
        spoke.position.z = p.side * 0.095;
        spin.add(spoke);
      }
      const cap = new THREE.Mesh(capGeo, this.mats.rimDark);
      cap.position.z = p.side * 0.115;
      spin.add(cap);

      // brake disc spins with the wheel; caliper is fixed to the suspension
      const disc = new THREE.Mesh(discGeo, this.mats.disc);
      disc.position.z = p.side * 0.015;
      spin.add(disc);

      const caliper = new THREE.Mesh(caliperGeo, this.mats.caliper);
      caliper.position.set(0.1, 0.12, p.side * 0.015);
      susp.add(caliper);

      this.body.add(wheelRoot);
      this.wheels.push({
        steerGroup: steer, suspGroup: susp, spinGroup: spin,
        spinAxis: 'z', front: p.front, side: p.side
      });
    }

    this.wheels.sort((a, b) => (b.front - a.front) || (a.side - b.side));
  }

  // ================================================================ lights

  _buildLights() {
    const R = D.rideHeight;

    // headlight housings + lenses + DRL strips
    const housingGeo = new THREE.BoxGeometry(0.08, 0.13, 0.42);
    const lensGeo = new THREE.BoxGeometry(0.02, 0.095, 0.36);
    const drlGeo = new THREE.BoxGeometry(0.018, 0.024, 0.4);
    for (const side of [1, -1]) {
      const housing = new THREE.Mesh(housingGeo, this.mats.black);
      housing.position.set(2.27, R + 0.66, side * 0.6);
      housing.rotation.z = -0.18;
      this.body.add(housing);

      const lens = new THREE.Mesh(lensGeo, this.mats.headlight);
      lens.position.set(2.315, R + 0.67, side * 0.6);
      lens.rotation.z = -0.18;
      this.body.add(lens);

      const drl = new THREE.Mesh(drlGeo, this.mats.drl);
      drl.position.set(2.315, R + 0.575, side * 0.6);
      drl.rotation.z = -0.18;
      this.body.add(drl);
    }

    // full-width taillight bar
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.095, W_BAR), this.mats._tail);
    tail.position.set(-2.325, R + 0.62, 0);
    this.body.add(tail);

    // spotlight rigs
    const mk = (z) => {
      const light = new THREE.SpotLight(
        HEADLIGHTS.color, HEADLIGHTS.intensity,
        HEADLIGHTS.distance, HEADLIGHTS.angle, HEADLIGHTS.penumbra, HEADLIGHTS.decay
      );
      light.position.set(D.length / 2 - 0.1, R + 0.67, z);
      const target = new THREE.Object3D();
      target.position.set(30, -1.2, z * 1.5);
      this.body.add(light, target);
      light.target = target;
      return light;
    };
    this.headlightL = mk(0.6);
    this.headlightR = mk(-0.6);
  }

  // ================================================================ update

  updateVisual(dt, phys, trans, race = null) {
    if (!this.ready) return;
    this._time += dt;

    this.group.position.set(phys.position.x, phys.position.y + 0.02, phys.position.z);
    this.group.rotation.y = phys.heading;

    // ---- wheels: spin + steer + INSANE suspension travel ----------------
    const R = this.wheelRadius || CAR.wheelRadius;
    this._spinAngle -= (phys.vF / R) * dt;

    const steerTarget = -phys.steerAngle;
    this._steerVis = THREE.MathUtils.damp(this._steerVis, steerTarget, 14, dt);

    const susp = phys.suspSmooth;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.spinGroup.rotation.z = this._spinAngle;
      if (w.front) w.steerGroup.rotation.y = this._steerVis;
      // INSANE suspension travel — way more than realistic, very visible
      const travel = THREE.MathUtils.clamp(
        (susp[i] - 0.5) * 2 * SUSPENSION.travel,
        -SUSPENSION.travel * 1.2, SUSPENSION.travel * 1.2
      );
      w.suspGroup.position.y = travel;
    }

    // ---- body roll + pitch (exaggerated for visible weight transfer) ---
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

    // body bounce
    const avgComp = (susp[0] + susp[1] + susp[2] + susp[3]) / 4;
    const targetY = -(avgComp - 0.5) * SUSPENSION.travel * 1.6;
    const k = 90, c = 13;
    const accel = (targetY - this._bodyY) * k - this._bodyYV * c;
    this._bodyYV += accel * dt;
    this._bodyY += this._bodyYV * dt;
    this.body.position.y = THREE.MathUtils.clamp(this._bodyY, -0.15, 0.15);

    // ---- lights ---------------------------------------------------------
    const braking = phys.brakeOut > 0.15 && phys.vF > 0.4;
    this.mats._tail.emissiveIntensity = braking ? 4.0 : 1.2;
    this.mats._reverse.emissiveIntensity = phys.reversing ? 2.2 : 0.12;

    // ---- headlights (auto: dusk / night presets) --------------------------
    if (this._headlightsOn === undefined) this._headlightsOn = true;
    if (this._headlightsOn !== this.headlightsTarget) {
      this._headlightsOn = this.headlightsTarget;
      const on = this._headlightsOn;
      this.headlightL.intensity = on ? HEADLIGHTS.intensity : 0;
      this.headlightR.intensity = on ? HEADLIGHTS.intensity : 0;
      this.mats.headlight.emissiveIntensity = on ? 1.5 : 0.08;
      this.mats.drl.color.setHex(on ? 0xbfe2ff : 0x3a4652);
    }

    // ---- interior -------------------------------------------------------
    if (this.interior) this.interior.update(dt, phys, trans);
  }
}

const W_BAR = 1.58; // taillight bar width
