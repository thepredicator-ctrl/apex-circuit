/**
 * DriftPhysics — single-track (bicycle) model tuned FOR DRIFTING.
 *
 * Design goals (different from a grip-focused sim):
 *  - Rear grip is intentionally below front grip (drift setup)
 *  - Handbrake dumps rear grip to ~30% so a tap instantly breaks traction
 *  - Rear grip recovers gradually -> slides are holdable, not spin-outs
 *  - Power-on keeps the rear loose (friction-circle) so throttle sustains drifts
 *  - Mobile comfort assists: auto counter-steer when idle-handed, yaw assist
 *    while sliding, automatic spin recovery
 *
 * Coordinate conventions (Three.js, y-up, 2D on the x/z plane):
 *  - heading θ: forward = (sinθ, cosθ); object rotation.y = θ (GLB nose = +Z)
 *  - right vector = (-cosθ, sinθ); steer δ > 0 = wheels to the RIGHT
 *  - yaw ω > 0 = nose swings left (θ increases); steering right → ω < 0
 *  - body-frame velocity: vx = forward speed, vz = lateral speed (right+)
 *
 * This module is DOM-free so it can be unit-simulated in Node.
 */

const G = 9.81;

export const TUNE = {
  mass: 1470,
  Iz: 2100,
  a: 1.19,            // CG -> front axle
  b: 1.28,            // CG -> rear axle
  h: 0.44,            // CG height
  L: 2.47,

  Cf: 105000,         // front cornering stiffness N/rad (stiff)
  Cr: 82000,          // rear cornering stiffness (softer = drift-happy)

  muF: 1.18,          // front friction coefficient (grippy nose)
  muR: 0.94,          // rear friction coefficient (loose tail)
  muRHandbrake: 0.30, // rear grip while handbrake held
  muRecover: 1.7,     // rear grip recovery rate per second while sliding
  muRecoverAligned: 4.2, // fast recovery once nearly straight again
  muPowerOver: 0.86,  // grip multiplier under heavy throttle while sliding

  driveForce: 9000,   // N at the rear wheels (RWD)
  vMax: 62,           // m/s top speed
  reverseForce: 3000,
  vRevMax: 9,

  brakeForce: 12800,
  handbrakeForce: 5600,
  dragK: 0.40,        // quadratic aero drag
  rollK: 16,          // linear rolling resistance

  steerMax: 0.62,     // rad at zero speed
  steerFade: 0.026,   // lock reduction per m/s
  steerRateIn: 6.2,   // rad/s toward target
  steerRateOut: 9.0,

  // mobile comfort assists
  assistCounterSteer: 1.12, // auto counter-steer gain (× slip angle)
  assistYaw: 1800,          // extra yaw torque while sliding, N·m at full effect
  spinRecover: 2.3,         // yaw damping kick past 86° of slip
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class DriftPhysics {
  constructor() {
    this.x = 0; this.z = 0;          // world position
    this.heading = 0;                // θ
    this.vxW = 0; this.vzW = 0;      // world-frame velocity
    this.omega = 0;                  // yaw rate

    this.steer = 0;                  // current road-wheel angle δ
    this.rearGrip = 1;               // multiplier on muR (handbrake dips it)
    this.axPrev = 0;                 // longitudinal accel (weight transfer)

    // read-only telemetry for FX / scoring / HUD
    this.beta = 0;                   // body slip angle (rad, right+)
    this.speed = 0;
    this.slipFront = 0;
    this.slipRear = 0;
    this.drifting = false;
    this.latG = 0;
    this.ax = 0;
    this.reversing = false;
  }

  /** Place the car and reset all motion. */
  teleport(x, z, heading) {
    this.x = x; this.z = z; this.heading = heading;
    this.vxW = 0; this.vzW = 0; this.omega = 0;
    this.steer = 0; this.rearGrip = 1; this.axPrev = 0; this.ax = 0;
    this.beta = 0; this.speed = 0; this.drifting = false;
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
    const m = T.mass;

    // ---------------- steering: rate-limited, speed-faded ----------------
    const fade = 1 / (1 + Math.abs(this._fwdVel() * T.steerFade));
    let steerTarget = input.steer * T.steerMax * fade;

    // comfort assist: while sliding, blend the driver's steering toward the
    // counter-steer equilibrium. This is the touch-comfort core: whether the
    // player holds steer INTO the slide (novice), taps nothing (panic), or
    // counter-steers (pro — input already matches, zero fight), the wheels
    // end up near where a drifter would put them.
    const assist = input.driftAssist !== false;
    if (assist && this.speed > 8 && Math.abs(this.beta) > 0.14) {
      const ideal = clamp(this.beta * T.assistCounterSteer, -0.55, 0.55);
      // fades out at low speed so idle slides self-straighten instead of
      // being held in an artificial equilibrium by the assist itself
      const w = clamp((Math.abs(this.beta) - 0.14) / 0.1, 0, 1) * 0.62
        * clamp((this.speed - 6) / 8, 0, 1);
      steerTarget = clamp(steerTarget * (1 - w) + ideal * w, -T.steerMax * fade, T.steerMax * fade);
    }

    // steering is faster while sliding — real drifters snap the wheel, and
    // the shorter transition window keeps saturated front grip from pumping
    // the spin while the wheels swing from lock to countersteer
    const slideRate = 1 + 1.6 * clamp(Math.abs(this.beta) * 2.2, 0, 1);
    const rate = (input.steer === 0 ? T.steerRateOut : T.steerRateIn) * slideRate * dt;
    const dSteer = steerTarget - this.steer;
    this.steer += Math.abs(dSteer) <= rate ? dSteer : Math.sign(dSteer) * rate;
    const d = this.steer;

    // ---------------- body-frame velocity --------------------------------
    const sinH = Math.sin(this.heading), cosH = Math.cos(this.heading);
    const vx = this.vxW * sinH + this.vzW * cosH;    // forward
    const vz = -this.vxW * cosH + this.vzW * sinH;   // right (lateral)
    const speed = Math.hypot(vx, vz);
    this.speed = speed;
    this.reversing = vx < -0.4;

    // ---------------- slip angles ----------------------------------------
    const u = Math.max(Math.abs(vx), 1.35);
    const lowSpeedFade = clamp(speed / 2.6, 0, 1); // kills parking-speed jitter
    const aF = Math.atan2((vz - T.a * this.omega) / u, 1) * lowSpeedFade - d * (vx < -0.5 ? -1 : 1);
    const aR = Math.atan2((vz + T.b * this.omega) / u, 1) * lowSpeedFade;
    this.slipFront = aF; this.slipRear = aR;
    this.beta = Math.atan2(vz, Math.max(Math.abs(vx), 0.4)) * (vx < 0 ? -1 : 1);

    // ---------------- vertical loads (with longitudinal transfer) --------
    const W = m * G;
    const Wf = clamp(W * (T.b / T.L) - m * this.axPrev * (T.h / T.L), 0.18 * W, 0.82 * W);
    const Wr = W - Wf;

    // ---------------- rear grip state -------------------------------------
    if (input.handbrake) {
      this.rearGrip = T.muRHandbrake;
    } else {
      // fast recovery once the body is nearly straight, slow while sideways
      const rec = Math.abs(this.beta) < 0.22 ? T.muRecoverAligned : T.muRecover;
      this.rearGrip = Math.min(1, this.rearGrip + rec * dt);
    }
    let muR = T.muR * this.rearGrip;
    // power-over: only sustains EXISTING drifts — normal (even hard)
    // cornering must stay planted or every fast corner would loop into a slide
    if (Math.abs(this.beta) > 0.3 && Math.abs(aR) > 0.2) {
      muR *= 1 - 0.18 * clamp((input.throttle - 0.45) / 0.4, 0, 1);
    }
    // mobile comfort: during handbrake slides the front washes out —
    // strong immediate fade at speed (so steer+handbrake is a controlled
    // initiator, not a spin button), deepening as the slide grows
    const muF = T.muF * (1 - (input.handbrake
      ? clamp(speed / 20, 0, 1) * (0.45 + 0.25 * clamp((Math.abs(this.beta) - 0.5) / 0.4, 0, 1))
      : 0));

    // ---------------- longitudinal forces ---------------------------------
    let Fx = 0;
    if (input.throttle > 0.01 && vx > -0.5) {
      const curve = Math.pow(clamp(1 - Math.max(vx, 0) / T.vMax, 0, 1), 0.9);
      Fx += input.throttle * T.driveForce * curve;
      // drift momentum retention: full-lock slides normally scrub ~1g of
      // speed; a compensating force along the nose keeps held drifts flowing
      // (arcade cheat #2 — comfort over realism). Gated on steering intent:
      // recovery slides with idle hands get no subsidy and settle naturally.
      if (Math.abs(input.steer) > 0.08 && Math.abs(this.beta) > 0.35 && Math.abs(this.beta) < 1.15 && !input.handbrake) {
        Fx += input.throttle * 8500 * clamp(Math.abs(this.beta) * 1.5, 0, 1);
      }
    }
    if (input.brake > 0.01) {
      if (vx > 0.4) Fx -= input.brake * T.brakeForce;
      else if (input.brake > 0.55 && vx > -T.vRevMax) Fx -= T.reverseForce; // brake = reverse at standstill
    }
    if (input.handbrake && speed > 0.5) {
      Fx -= Math.sign(vx || vz || 1) * T.handbrakeForce;
    }
    Fx -= T.dragK * vx * Math.abs(vx) + T.rollK * vx;

    // rear longitudinal share (for the friction circle)
    const FxRear = Math.max(0, input.throttle * T.driveForce * Math.pow(clamp(1 - Math.max(vx, 0) / T.vMax, 0, 1), 0.9))
      + (input.handbrake && speed > 0.5 ? Math.sign(vx || 1) * T.handbrakeForce : 0);
    const rearCap = muR * Wr;
    const usedRear = clamp(Math.abs(FxRear) / Math.max(rearCap, 1), 0, 1);
    const rearLatScale = Math.sqrt(Math.max(0.1, 1 - usedRear * usedRear));

    // ---------------- lateral forces (saturated) --------------------------
    const FyF = -clamp(T.Cf * aF, -muF * Wf, muF * Wf);
    const FyR = -clamp(T.Cr * aR, -rearCap * rearLatScale, rearCap * rearLatScale);

    // ---------------- yaw moment ------------------------------------------
    let N = T.b * FyR - T.a * FyF * Math.cos(d);

    // comfort assist: steering authority boost while sliding. Sign follows
    // the physical steering moment (steer right => N negative) so it always
    // amplifies what the driver asked for: sharper initiation on flicks,
    // stronger stabilization on counter-steer. Fades out past ~52° so it
    // cannot spin the car on its own.
    if (Math.abs(this.beta) > 0.12 && speed > 7) {
      const slide = clamp(Math.abs(this.beta) * 1.3, 0, 1);
      const fade = 1 - clamp((Math.abs(this.beta) - 0.9) / 0.3, 0, 1);
      const hbDamp = input.handbrake ? 0.35 : 1; // handbrake is an initiator, not a spinner
      N -= input.steer * T.assistYaw * slide * fade * hbDamp * clamp(speed / 22, 0, 1);
    }
    // handbrake governor: cap the yaw RATE itself while the button is held
    // (beta stays low during the tap, so a beta threshold alone fires too
    // late) — holding the button too long then holds a big slide, not a spin
    if (input.handbrake) {
      if (Math.abs(this.omega) > 1.5) this.omega = clamp(this.omega, -1.5, 1.5);
      if (Math.abs(this.beta) > 0.9) this.omega -= this.omega * 5.0 * dt;
    }
    // spin recovery: yank the yaw rate down past ~86° of slip
    if (Math.abs(this.beta) > 1.5) {
      this.omega -= this.omega * T.spinRecover * dt;
    }
    // YAW CEILING — the one rule that kills spins: the nose can never
    // out-rotate the path the tires can bend. A held drift runs at
    // |omega| ≈ path rotation (mu*g/v ≈ 0.5..1.0 rad/s); anything far above
    // is a spin-in-progress, so excess yaw bleeds off smoothly. Legitimate
    // slides never touch it; wall-of-death rotation does.
    const ceiling = 0.55 + (1.45 * G) / Math.max(speed, 6);
    if (Math.abs(this.omega) > ceiling) {
      const excess = Math.abs(this.omega) - ceiling;
      this.omega -= Math.sign(this.omega) * Math.min(excess, (2.5 + excess * 6) * dt);
    }
    // mild natural yaw damping (stability at speed)
    this.omega -= this.omega * 0.18 * dt * clamp(speed / 18, 0, 1);

    // ---------------- integrate (world frame: no cross-term bookkeeping) --
    const ax = (Fx + FyF * -Math.sin(d)) / m;              // forward accel
    const az = (FyF * Math.cos(d) + FyR) / m;              // right accel
    this.ax = ax;
    this.latG = az / G;

    // BETA CAP — the authoritative comfort net. Past the cap the nose is
    // pulled back toward the velocity vector and the rotation fuel is bled:
    // the car physically refuses to spin past ~52-66°. Below the cap the
    // tire physics are untouched, so legitimate big drifts still feel real.
    const betaCap = (input.handbrake || this.rearGrip < 0.55) ? 0.9 : 1.15;
    if (speed > 4) {
      const over = Math.abs(this.beta) - betaCap;
      if (over > 0) {
        const pull = Math.min(over * 6, 6) * dt;
        this.heading -= Math.sign(this.beta) * pull;
        this.omega *= Math.max(0, 1 - 4 * dt);
      }
    }

    this.omega += (N / T.Iz) * dt;
    this.heading += this.omega * dt;

    // hands-off auto-straighten: with no input the car worms back to center
    // (models the driver catching the wheel) so recovery slides always end
    const handsOff = Math.abs(input.steer) < 0.05 && input.throttle < 0.05
      && input.brake < 0.05 && !input.handbrake;
    if (handsOff && speed < 14 && Math.abs(this.beta) > 0.05) {
      this.heading -= Math.sign(this.beta) * Math.min(Math.abs(this.beta), 1) * 0.8 * dt;
    }

    const s2 = Math.sin(this.heading), c2 = Math.cos(this.heading);
    const axW = ax * s2 + az * -c2;
    const azW = ax * c2 + az * s2;
    this.vxW += axW * dt;
    this.vzW += azW * dt;

    this.x += this.vxW * dt;
    this.z += this.vzW * dt;

    // hard stop for crawling speeds (prevents micro-drift at rest) —
    // skipped while any pedal is active so reverse/launch are not fought
    const pedalsActive = input.throttle > 0.02 || input.brake > 0.02 || input.handbrake;
    if (!pedalsActive && Math.hypot(this.vxW, this.vzW) < 0.12) {
      this.vxW *= 0.82; this.vzW *= 0.82;
    }

    this.axPrev = clamp(ax, -12, 12);
    this.drifting = Math.abs(this.beta) > 0.16 && speed > 7.5 && Math.abs(this.beta) < 1.5;
  }

  _fwdVel() {
    const sinH = Math.sin(this.heading), cosH = Math.cos(this.heading);
    return this.vxW * sinH + this.vzW * cosH;
  }

  /** Front-axle / rear-axle world positions (into out objects). */
  axlePositions(outF, outR) {
    const sinH = Math.sin(this.heading), cosH = Math.cos(this.heading);
    outF.x = this.x + TUNE.a * sinH; outF.z = this.z + TUNE.a * cosH;
    outR.x = this.x - TUNE.b * sinH; outR.z = this.z - TUNE.b * cosH;
  }
}
