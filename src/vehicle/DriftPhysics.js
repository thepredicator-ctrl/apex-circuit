/**
 * DriftPhysics — ARCADE drift model in the spirit of CarX Drift Racing.
 *
 * Instead of simulating four tire contact patches, this model tracks two
 * things that actually matter for drift feel:
 *
 *   1. the HEADING (where the nose points, rotated by a directly-controlled
 *      yaw rate), and
 *   2. the VELOCITY DIRECTION (where the car actually travels), which is
 *      pulled toward the heading by a "traction" rate.
 *
 * The angle between the two IS the drift angle. Grip is a curve over that
 * angle: strong when nearly straight (planted cornering), weak inside the
 * "hold zone" (slides sustain at big angles), rising again near the cap
 * (impossible to spin). Throttle feeds the slide, handbrake dumps traction
 * instantly, and the steering in a slide sets the rotation rate — so the
 * driver controls drift ANGLE with the throttle and drift RADIUS with the
 * wheel, exactly like CarX. With assist on, hands-off slides hold a clean
 * angle by themselves (the game does the counter-steering).
 *
 * Coordinate conventions (Three.js, y-up, 2D on the x/z plane):
 *  - heading θ: forward = (sinθ, cosθ); object rotation.y = θ (GLB nose = +Z)
 *  - yaw ω > 0 = nose swings left; steer δ > 0 = wheels right → ω < 0
 *  - β (beta) > 0 = velocity is left of the nose = right-hand drift
 *  - world velocity kept as vxW/vzW; velocity direction angle φ = atan2(vx, vz)
 *
 * This module is DOM-free so it can be unit-simulated in Node.
 */

export const TUNE = {
  // ---- engine / brakes (arcade strong) ----------------------------------
  accel: 12.5,          // m/s² full throttle at low speed
  vMax: 57,             // m/s top speed
  accelCurve: 0.72,     // falloff exponent toward vMax
  driftThrust: 4.8,     // extra push while drifting so slides keep flow
  brakeDecel: 26,       // m/s²
  reverseAccel: 8.5,
  vRevMax: 10,
  handbrakeDecel: 6.0,  // m/s² while handbrake held
  dragK: 0.0016,        // quadratic aero
  rollK: 0.08,          // linear rolling resistance

  // ---- steering ----------------------------------------------------------
  steerMax: 0.66,       // rad wheel lock at zero speed
  steerFade: 0.013,     // lock reduction per m/s (gentle — big flicks stay possible)
  steerRateIn: 8.0,     // rad/s toward target
  steerRateOut: 10.5,
  wheelbase: 2.55,

  // ---- traction: rate (1/s) the velocity direction aligns to the nose ----
  gripHold: 6.4,        // ordinary grip — lateral velocity dies fast
  gripHoldLo: 4.6,      // grip when nearly stopped (avoid jitter)
  driftHold: 0.92,      // hold zone WITH full throttle — big angles sustain
  driftHoldNoT: 2.9,    // hold zone with no throttle — slide tucks & ends
  handbrakeHold: 1.05,  // while handbrake is held — near-free rotation
  spinCatch: 15,        // extra alignment rate per rad past the soft cap

  // ---- yaw control -------------------------------------------------------
  yawGrip: 7.5,         // how fast yaw chases the kinematic target (grip)
  yawDrift: 6.2,        // chase rate while sliding (snappy but not twitchy)
  yawDriftGain: 1.85,   // ω = -gain · δ · speedFactor while sliding
  yawHandbrakeGain: 3.0,// stronger authority during handbrake initiation
  yawPowerKick: 0.55,   // throttle yaw kick deepening the slide (rad/s)
  aLatMax: 10.5,        // grip-cornering ceiling (m/s²) — keeps grip planted

  // ---- drift comfort nets (mobile) ---------------------------------------
  assistHold: 0.42,     // hands-off assist steer angle (rad, into the slide)
  assistRate: 2.6,      // blend rate of the assist steer
  betaCap: 1.19,        // 68° — the physical spin wall
  betaCapPull: 5.5,     // nose pull rate past the cap
  yawCeil0: 0.55,       // yaw ceiling: ceil = yawCeil0 + yawCeilK·g/speed
  yawCeilK: 1.45,
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapAngle = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const lerp = (a, b, t) => a + (b - a) * t;

export class DriftPhysics {
  constructor() {
    this.x = 0; this.z = 0;
    this.heading = 0;               // θ
    this.vxW = 0; this.vzW = 0;     // world velocity
    this.omega = 0;                 // yaw rate

    this.steer = 0;                 // road-wheel angle δ (rad, right+)
    this.driftBlend = 0;            // 0 grip ↔ 1 full slide (smoothed)
    this.handbrakeBlend = 0;        // smoothed handbrake traction dump

    // read-only telemetry for FX / scoring / HUD
    this.beta = 0;                  // drift angle (rad, right-hand drift+)
    this.speed = 0;
    this.slipFront = 0;
    this.slipRear = 0;
    this.drifting = false;
    this.latG = 0;
    this.ax = 0;
    this.reversing = false;

    this._prevSpeed = 0;
  }

  /** Place the car and reset all motion. */
  teleport(x, z, heading) {
    this.x = x; this.z = z; this.heading = heading;
    this.vxW = 0; this.vzW = 0; this.omega = 0;
    this.steer = 0; this.driftBlend = 0; this.handbrakeBlend = 0;
    this.beta = 0; this.speed = 0; this.drifting = false;
    this._prevSpeed = 0;
  }

  /** Push/pull the world velocity (used by wall collisions). */
  addImpulse(dvx, dvz) {
    this.vxW += dvx; this.vzW += dvz;
  }

  /**
   * Advance one fixed substep.
   * @param {number} dt substep length (s), keep <= 1/60
   * @param {object} input { steer -1..1, throttle 0..1, brake 0..1, handbrake bool, driftAssist bool }
   */
  step(dt, input) {
    const T = TUNE;

    // ---------------- body-frame state ------------------------------------
    const sinH = Math.sin(this.heading), cosH = Math.cos(this.heading);
    const vFwd = this.vxW * sinH + this.vzW * cosH;
    const speed = Math.hypot(this.vxW, this.vzW);
    this.speed = speed;

    // Reversing regime: moving backward, or commanding reverse from rest.
    // Decided FIRST because the slip reference axis depends on it.
    const reversingNow = vFwd < -0.4 || (speed < 0.5 && input.brake > 0.5);
    this.reversing = reversingNow;

    // velocity direction angle φ and slip β measured against the motion axis
    // (backward while reversing — so backing up straight reads β≈0 instead
    // of ±π, which would false-trigger the spin wall).
    const refAngle = this.heading + (reversingNow ? Math.PI : 0);
    const phi = (speed > 0.25)
      ? Math.atan2(this.vxW, this.vzW)
      : refAngle;
    let beta = wrapAngle(phi - refAngle);
    this.beta = reversingNow ? 0 : beta;

    // ---------------- steering --------------------------------------------
    const fade = 1 / (1 + Math.abs(vFwd) * T.steerFade);
    const lock = T.steerMax * fade;
    let steerTarget = input.steer * lock;

    // CARX ASSIST: while sliding with small steering input, the game holds
    // the wheel near the sustain angle (into the slide) so hands-off drifts
    // keep a clean, controllable angle instead of snapping back or spinning.
    const assist = input.driftAssist !== false;
    const sliding = Math.abs(beta) > 0.12 && speed > 6;
    if (assist && sliding && Math.abs(input.steer) < 0.2) {
      const holdAngle = Math.sign(beta) * T.assistHold * fade;
      const w = clamp(Math.abs(beta) * 4, 0, 1) * clamp(speed / 10, 0, 1) * 0.85;
      steerTarget = clamp(lerp(steerTarget, holdAngle, w), -lock, lock);
    }

    // faster wheel while sliding — counter-steer snaps
    const slideRate = 1 + 1.3 * clamp(Math.abs(beta) * 1.8, 0, 1);
    const rate = (input.steer === 0 ? T.steerRateOut : T.steerRateIn) * slideRate * dt;
    const dSteer = steerTarget - this.steer;
    this.steer += Math.abs(dSteer) <= rate ? dSteer : Math.sign(dSteer) * rate;
    const delta = this.steer;

    // ---------------- drift state machine ---------------------------------
    // Blend toward "slide" when the slip angle leaves the grip band OR when
    // grip cornering demands more lateral accel than the tires can give
    // (full lock at speed = CarX power-over initiation). The demand path is
    // gentler + capped so cornering at the grip limit wobbles loose instead
    // of snapping between modes.
    const kin = Math.abs(vFwd) * Math.tan(Math.abs(delta)) / T.wheelbase;
    const demandExcess = kin - T.aLatMax / Math.max(Math.abs(vFwd), 2.5);
    const angleOver = Math.abs(beta) - 0.1;
    let blendTarget = 0;
    if (angleOver > 0) blendTarget = clamp(angleOver / 0.12, 0, 1);
    if (demandExcess > 0.2 && speed > 8 && !reversingNow) {
      blendTarget = Math.max(blendTarget, clamp(demandExcess / 0.8, 0, 0.8));
    }
    if (input.handbrake && speed > 3.5) blendTarget = 1;
    // hysteresis: once sliding, stay sliding until nearly straight
    if (this.driftBlend > 0.5 && Math.abs(beta) > 0.08 && speed > 5) {
      blendTarget = Math.max(blendTarget, 0.85);
    }
    const blendRate = (blendTarget > this.driftBlend ? 7.5 : 4.5) * dt;
    this.driftBlend += clamp(blendTarget - this.driftBlend, -blendRate, blendRate);

    // handbrake traction dump (fast in, moderate out)
    this.handbrakeBlend = clamp(
      this.handbrakeBlend + (input.handbrake ? 10 : -5) * dt, 0, 1);

    // ---------------- traction curve --------------------------------------
    // Alignment rate k: huge when straight (grip), low in the hold zone
    // (throttle feeds the slide), rising again near the cap (no spins).
    const throttle = input.throttle;
    const kHold = lerp(T.driftHoldNoT, T.driftHold, clamp(throttle * 1.25, 0, 1));
    let k = lerp(T.gripHold, kHold, this.driftBlend);
    if (speed < 2.5) k = lerp(T.gripHoldLo, k, speed / 2.5);
    k = lerp(k, T.handbrakeHold, this.handbrakeBlend * 0.85);
    const over = Math.abs(beta) - 0.98;
    if (over > 0) k += over * T.spinCatch;          // soft wall near the cap
    this._k = k;

    // ---------------- yaw control ------------------------------------------
    // grip: kinematic bicycle capped by lateral accel (planted cornering)
    const omegaKin = -clamp(vFwd * Math.tan(delta) / T.wheelbase,
      -T.aLatMax / Math.max(Math.abs(vFwd), 2.5), T.aLatMax / Math.max(Math.abs(vFwd), 2.5));
    // slide: steering sets rotation rate directly; throttle kicks the tail
    const spdF = 0.4 + 0.6 * clamp(speed / 15, 0, 1);
    const gain = lerp(T.yawDriftGain, T.yawHandbrakeGain, this.handbrakeBlend);
    // throttle kick follows the DRIFT direction (−sign β) so power sustains
    // and deepens an existing slide — the CarX "throttle = angle" rule
    let omegaSlide = -gain * delta * spdF
      - Math.sign(beta || delta || 1) * throttle * T.yawPowerKick * this.driftBlend * spdF;
    // while sliding, keep some of the current rotation (momentum feel)
    omegaSlide = lerp(this.omega, omegaSlide, 0.75);
    const omegaTarget = lerp(omegaKin, omegaSlide, this.driftBlend);

    const yawRate = lerp(T.yawGrip, T.yawDrift, this.driftBlend);
    this.omega += (omegaTarget - this.omega) * (1 - Math.exp(-yawRate * dt));

    // yaw ceiling — the nose can never out-rotate what traction can bend
    const ceil = T.yawCeil0 + (T.yawCeilK * 9.81) / Math.max(speed, 6);
    if (Math.abs(this.omega) > ceil) {
      const excess = Math.abs(this.omega) - ceil;
      this.omega -= Math.sign(this.omega) * Math.min(excess, (2.5 + excess * 6) * dt);
    }
    // natural damping at speed
    this.omega -= this.omega * 0.1 * dt * clamp(speed / 18, 0, 1);

    // ---------------- longitudinal -----------------------------------------
    let aFwd = 0;
    const coast = Math.pow(clamp(1 - Math.max(vFwd, 0) / T.vMax, 0, 1), T.accelCurve);
    // handbrake locks the rear: engine push and drift thrust collapse
    const powerCut = 1 - 0.8 * this.handbrakeBlend;
    if (throttle > 0.01 && vFwd > -0.5) {
      aFwd += throttle * T.accel * coast * powerCut;
      // drift thrust: full-lock slides keep their speed (arcade cheat)
      if (this.driftBlend > 0.3) {
        aFwd += throttle * T.driftThrust * this.driftBlend
          * clamp(Math.abs(beta) * 1.3, 0, 1) * clamp(speed / 8, 0, 1) * powerCut;
      }
    }
    if (input.brake > 0.01) {
      if (vFwd > 0.4) aFwd -= input.brake * T.brakeDecel;
      else if (input.brake > 0.5 && vFwd > -T.vRevMax) aFwd -= T.reverseAccel;
    }
    if (input.handbrake && speed > 0.5) {
      // throttle fights the anchor (clutch-kick feel) so a fed donut keeps
      // rolling instead of decaying to a standstill burnout
      aFwd -= Math.sign(vFwd || 1) * T.handbrakeDecel * (1 - 0.55 * throttle);
    }
    aFwd -= T.dragK * vFwd * Math.abs(vFwd) + T.rollK * vFwd;
    // tire scrub while sliding (small — slides should flow, not stall)
    aFwd -= this.driftBlend * 2.3 * Math.abs(beta) * clamp(speed / 9, 0, 1) * Math.sign(vFwd || 1);

    // ---------------- integrate --------------------------------------------
    // heading
    this.heading += this.omega * dt;

    // traction: rotate the velocity direction toward the motion axis by k·β
    const align = clamp(-k * beta * dt, -Math.PI / 3, Math.PI / 3);
    let newPhi = wrapAngle(phi + align);
    // Regime flip (forward ↔ reverse) happens only near a stop, where the
    // velocity direction is meaningless — SNAP it to the new motion axis
    // instead of letting traction swing it through 180°.
    if (speed < 1.2 && Math.abs(beta) > 1.0) newPhi = refAngle;
    // BETA CAP — soft wall: past it the nose is pulled back toward the path
    // (skipped in reverse — backing up is never a spin)
    beta = wrapAngle(newPhi - refAngle);
    const capOver = Math.abs(beta) - T.betaCap;
    if (capOver > 0 && speed > 4 && !reversingNow) {
      const pull = Math.min(capOver * T.betaCapPull, 6) * dt;
      this.heading += Math.sign(beta) * pull;   // nose back toward velocity
      this.omega *= Math.max(0, 1 - 4 * dt);
      beta = wrapAngle(newPhi - refAngle);
    }
    this.beta = reversingNow ? 0 : beta;
    this.slipFront = beta;
    this.slipRear = beta * 1.08;

    // rebuild world velocity: speed grows along the MOTION axis (forward, or
    // backward while reversing) so brake-from-rest actually reverses
    const aAlong = reversingNow ? -aFwd : aFwd;
    let newSpeed = speed + aAlong * dt;
    if (reversingNow) {
      if (newSpeed > T.vRevMax) newSpeed = T.vRevMax;
      if (newSpeed < 0) newSpeed = 0;            // gas finished the reverse roll
    } else {
      if (newSpeed < 0) newSpeed = 0;            // braked to a stop
      if (newSpeed > T.vMax) newSpeed = T.vMax;
    }
    this.ax = (newSpeed - this._prevSpeed) / dt;
    this._prevSpeed = newSpeed;
    this.vxW = Math.sin(newPhi) * newSpeed;
    this.vzW = Math.cos(newPhi) * newSpeed;

    this.x += this.vxW * dt;
    this.z += this.vzW * dt;

    // hard stop for crawling speeds (prevents micro-drift at rest)
    const pedalsActive = throttle > 0.02 || input.brake > 0.02 || input.handbrake;
    if (!pedalsActive && newSpeed < 0.15) {
      this.vxW *= 0.82; this.vzW *= 0.82;
    }

    // hands-off auto-straighten at low speed (driver catches the car)
    const handsOff = Math.abs(input.steer) < 0.05 && throttle < 0.05
      && input.brake < 0.05 && !input.handbrake;
    if (handsOff && speed < 13 && Math.abs(this.beta) > 0.05) {
      this.heading -= Math.sign(this.beta)
        * Math.min(Math.abs(this.beta), 1) * 0.7 * dt;
    }

    // lateral accel for body roll (right turn → positive, matches old model)
    this.latG = -speed * this.omega / 9.81;
    this.drifting = !this.reversing
      && Math.abs(this.beta) > 0.16 && speed > 7.5 && Math.abs(this.beta) < 1.5;
  }

  _fwdVel() {
    const sinH = Math.sin(this.heading), cosH = Math.cos(this.heading);
    return this.vxW * sinH + this.vzW * cosH;
  }

  /** Front-axle / rear-axle world positions (into out objects). */
  axlePositions(outF, outR) {
    const sinH = Math.sin(this.heading), cosH = Math.cos(this.heading);
    outF.x = this.x + TUNE.wheelbase * 0.485 * sinH;
    outF.z = this.z + TUNE.wheelbase * 0.485 * cosH;
    outR.x = this.x - TUNE.wheelbase * 0.515 * sinH;
    outR.z = this.z - TUNE.wheelbase * 0.515 * cosH;
  }
}
