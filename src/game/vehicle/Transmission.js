/**
 * Transmission — a simplified but believable engine + gearbox simulation.
 *
 *  - Torque curve with peak around 5300 rpm, redline at 7600.
 *  - Six forward ratios + reverse, final drive, drivetrain efficiency.
 *  - rpm is derived from wheel speed while the clutch is locked; below the
 *    clutch lock speed (and on launch) the clutch slips: rpm follows the
 *    throttle instead and drive force is limited by clutch capacity.
 *  - Rev limiter bounces the torque at redline.
 *  - AUTOMATIC: upshifts near redline, downshifts when revs fall, kickdown
 *    on hard throttle, engages R when the brake is held at a standstill.
 *  - MANUAL: sequential shifter R-N-1-2-3-4-5-6 (Q down / E up). Shifts cut
 *    torque for ~0.22 s and blend rpm to the new gear. Impossible states are
 *    refused (no gear skipping, no downshift past the rev ceiling).
 *  - Exposes shifter animation state (x/z slot travel) for the cockpit model.
 */

import { CAR, TRANSMISSION as T } from '../core/Constants.js';

export const GEAR_LABEL = { '-1': 'R', '0': 'N' };

/** sequential shift pattern: index into this list */
const SEQ = ['R', 'N', '1', '2', '3', '4', '5', '6', '7', '8'];

/** shifter knob slot positions (x: -1 left..+1 right, z: 0 forward..1 back) */
const SHIFTER_SLOTS = {
  R: [-1.0, 0.9],
  N: [0, 0.45],
  1: [-1.0, 0.1],
  2: [-1.0, 0.9],
  3: [0, 0.1],
  4: [0, 0.9],
  5: [1.0, 0.1],
  6: [1.0, 0.9],
  7: [1.9, 0.1],
  8: [1.9, 0.9]
};

export class Transmission {
  constructor() {
    this.mode = 'auto';            // 'auto' | 'manual'
    this.seqIdx = 2;               // index into SEQ ('1') — internal state
    this.gear = 1;                 // -1 R, 0 N, 1..6
    this.rpm = T.idleRpm;
    this.rpmNorm = 0;
    this.driveForce = 0;           // N at the contact patch (signed, + = forward)
    this.shifting = false;
    this.shiftT = 0;               // counts down T.shiftTime
    this.pendingGear = 1;
    this.shiftCooldown = 0;        // anti-hunt for auto kickdown
    this.reverseHold = 0;          // brake-held-at-standstill timer (auto R)
    this.wheelspin = false;        // set by physics each step (traction cap hit)
    this.launching = false;
    this.limiterCut = false;

    // animation outputs
    this.shifterX = 0;
    this.shifterZ = 0.45;
    this.clutchPedal = 0;          // 0 released .. 1 fully pressed (visual)

    this._onShift = null;          // (gear, isUpshift) — audio cue
  }

  setMode(m) {
    if (m === this.mode) return;
    this.mode = m;
    // re-engage a sane gear for the current state
    this._syncGearFromSeq();
  }

  toggleMode() {
    this.setMode(this.mode === 'auto' ? 'manual' : 'auto');
  }

  get gearLabel() {
    return this.gear < 0 ? 'R' : this.gear === 0 ? 'N' : String(this.gear);
  }

  _syncGearFromSeq() {
    const label = SEQ[this.seqIdx];
    this.gear = label === 'R' ? -1 : label === 'N' ? 0 : parseInt(label, 10);
  }

  /** gear ratio including final drive (positive), 0 for neutral */
  _ratio(gear = this.gear) {
    if (gear === 0) return 0;
    const g = gear < 0 ? T.reverseRatio : T.gearRatios[gear - 1];
    return g * T.finalDrive;
  }

  /** crank rpm for a given forward wheel speed (signed) in the current gear */
  rpmForWheelSpeed(vF, gear = this.gear) {
    const ratio = this._ratio(gear);
    if (ratio === 0) return T.idleRpm;
    return Math.abs(vF / CAR.wheelRadius) * ratio * 60 / (2 * Math.PI) * (gear < 0 ? -1 : 1);
  }

  /** normalized engine torque 0..1 at a given rpm */
  torqueCurve(rpm) {
    const t = Math.max(0, rpm) / T.peakTorqueRpm;
    if (t <= 1) return 0.55 + 0.45 * Math.pow(t, 0.85);
    const over = Math.min(1, (rpm - T.peakTorqueRpm) / (T.redline - T.peakTorqueRpm));
    return 1.0 - 0.26 * over * over;
  }

  // ---------------------------------------------------------------- shifting
  /** manual shift request: dir = +1 up / -1 down */
  shift(dir) {
    if (this.mode !== 'manual' || this.shifting) return false;
    const target = THREEclamp(this.seqIdx + dir, 0, SEQ.length - 1);
    if (target === this.seqIdx) return false;

    // refuse a downshift that would blow far past the rev ceiling
    const label = SEQ[target];
    const g = label === 'R' ? -1 : label === 'N' ? 0 : parseInt(label, 10);
    if (g > 0 || g === -1) {
      const projected = Math.abs(this.rpmForWheelSpeed(this._lastVF ?? 0, g));
      if (projected > T.rpmMaxSafe + 600) return false;
    }
    // refuse reverse while rolling forward fast (and vice versa)
    if (g === -1 && (this._lastVF ?? 0) > 2.5) return false;
    if (g >= 1 && (this._lastVF ?? 0) < -2.5) return false;

    this.seqIdx = target;
    this._syncGearFromSeq();
    this.shifting = true;
    this.shiftT = T.shiftTime;
    this.pendingGear = this.gear;
    if (this._onShift) this._onShift(this.gear, dir > 0);
    return true;
  }

  // ------------------------------------------------------------------ update
  /**
   * @param dt sub-step delta
   * @param p  { wheelSpeed (signed m/s), throttle, brake, controlsActive }
   */
  update(dt, p) {
    const { throttle, brake, controlsActive } = p;
    const vF = p.wheelSpeed;
    this._lastVF = vF;
    this.wheelspin = false; // physics re-sets it if traction is capped

    const ratio = this._ratio();
    const absVF = Math.abs(vF);

    // Pedal remapping (automatic mode): while the box is in R the BRAKE
    // pedal drives the car backwards — the classic arcade scheme — so R is
    // actually usable. The throttle returns to drive only once nearly still.
    let fwdThrottle = throttle;
    let revThrottle = 0;
    if (this.mode === 'auto' && this.gear === -1) {
      revThrottle = brake;
      if (absVF < 0.6 && throttle > 0.05) {
        // driver wants drive again -> handled by the selection logic below
      } else {
        fwdThrottle = 0;
      }
    }

    // ---------- gear selection (automatic) --------------------------------
    if (this.mode === 'auto' && !this.shifting && controlsActive) {
      if (absVF < 0.6) {
        // at (near) standstill the box decides from the pedals
        if (brake > 0.4 && throttle < 0.2 && vF > -0.5) {
          this.reverseHold += dt;
          if (this.reverseHold > 0.3 && this.gear !== -1) {
            this.gear = -1;
            this.shifting = true;
            this.shiftT = T.shiftTime * 0.6;
            this.pendingGear = -1;
            if (this._onShift) this._onShift(-1, false);
          }
        } else {
          this.reverseHold = 0;
          if (throttle > 0.05 && this.gear <= 0 && vF > -0.6) {
            this.gear = 1;
            this.shifting = true;
            this.shiftT = T.shiftTime * 0.6;
            this.pendingGear = 1;
            if (this._onShift) this._onShift(1, true);
          } else if (throttle < 0.02 && brake < 0.02 && this.gear === -1 && absVF < 0.15) {
            this.gear = 0; // idle in neutral
          }
        }
      } else if (this.gear > 0) {
        // forward driving: rpm-based up/down shifts
        const topGear = T.gearRatios.length;
        const rpmNow = this.rpmForWheelSpeed(vF, this.gear);
        const wantUp = rpmNow > T.autoUpshiftRpm && this.gear < topGear;
        const wantDown = rpmNow < T.autoDownshiftRpm && this.gear > 1;
        const kick = throttle > T.autoDownshiftThrottle && rpmNow < 5200 &&
          this.gear > 1 && this.shiftCooldown <= 0;
        // luxury 8-speed: upshift early and lazily under light throttle,
        // so the tallest gears actually engage at cruising speeds
        const cruise = throttle < 0.35 && rpmNow > 2350 && this.gear > 1 &&
          this.gear < topGear && this.shiftCooldown <= 0;
        if (wantUp || wantDown || kick || cruise) {
          const next = (wantUp || cruise) ? this.gear + 1 : this.gear - 1;
          const rpmNext = this.rpmForWheelSpeed(vF, next);
          if (rpmNext < T.rpmMaxSafe) {
            const isUp = next > this.gear;
            this.gear = next;
            this.shifting = true;
            this.shiftT = T.shiftTime;
            this.pendingGear = next;
            this.shiftCooldown = wantUp ? 0.5 : cruise ? 0.9 : 0.35;
            if (this._onShift) this._onShift(next, isUp);
          }
        }
      }
    }
    if (this.shiftCooldown > 0) this.shiftCooldown -= dt;

    // ---------- shift progress --------------------------------------------
    let torqueCut = 1;
    if (this.shifting) {
      this.shiftT -= dt;
      if (this.shiftT <= 0) this.shifting = false;
      else torqueCut = 0;
    }

    // ---------- rpm ---------------------------------------------------------
    const ratioNow = this._ratio(this.shifting ? this.pendingGear : this.gear);
    this.launching = false;
    const pedal = this.gear < 0 ? Math.max(revThrottle, fwdThrottle) : throttle;

    if (ratioNow === 0) {
      // neutral: revs follow the throttle freely
      const target = T.idleRpm + throttle * (T.redline - T.idleRpm) * 0.9;
      this.rpm += (target - this.rpm) * Math.min(1, dt * 6);
      this.clutchPedal += ((throttle > 0.05 ? 1 : 0) - this.clutchPedal) * Math.min(1, dt * 8);
    } else {
      const rpmFromWheels = this.rpmForWheelSpeed(vF, this.shifting ? this.pendingGear : this.gear);
      const slipping = absVF < T.clutchLockSpeed ||
        (ratioNow > 0 && rpmFromWheels < T.stallRpm && this.gear > 0);

      if (slipping && pedal > 0.02) {
        // clutch slips: engine revs with the pedal, force limited by clutch
        this.launching = true;
        const target = T.idleRpm + pedal * (4300 - T.idleRpm);
        this.rpm += (target - this.rpm) * Math.min(1, dt * 5);
        this.clutchPedal += ((1 - Math.min(1, absVF / T.clutchLockSpeed)) - this.clutchPedal) * Math.min(1, dt * 8);
      } else {
        // locked: rpm tracks the wheels; blend during a shift
        const ease = this.shifting ? Math.min(1, dt * T.shiftRpmEase) : 1;
        this.rpm += (Math.max(rpmFromWheels, 0) - this.rpm) * (this.shifting ? ease : Math.min(1, dt * 14));
        this.clutchPedal += (0 - this.clutchPedal) * Math.min(1, dt * 8);
        if (rpmFromWheels < T.stallRpm && absVF > 0.2 && this.gear > 0) {
          // lugging / stall protection: treat like a slipping clutch at idle
          this.rpm += (T.idleRpm - this.rpm) * Math.min(1, dt * 6);
        }
      }
    }

    // idle flutter + keep rpm inside [idle-ish, hard cut]
    const flutter = throttle < 0.02 ? Math.sin(performance.now() * 0.013) * 40 : 0;
    this.rpm = Math.max(T.idleRpm + flutter, Math.min(T.rpmMaxSafe, this.rpm));

    // ---------- rev limiter ---------------------------------------------------
    this.limiterCut = false;
    let torque = this.torqueCurve(this.rpm) * T.maxTorque;
    if (this.rpm >= T.redline) {
      // hard bounce: intermittent cut so the limiter "scratches"
      const scratch = Math.sin(performance.now() * 0.06) > -0.2;
      if (scratch) { torque *= 0.12; this.limiterCut = true; }
    }

    // ---------- drive force ------------------------------------------------------
    this.driveForce = 0;
    if (ratioNow !== 0 && !this.shifting) {
      const effThrottle = this.gear < 0 ? Math.max(revThrottle, fwdThrottle) : fwdThrottle;
      const Nm = torque * effThrottle * torqueCut;
      const wheelN = Nm * ratioNow * T.efficiency / CAR.wheelRadius;
      const dir = this.gear < 0 ? -1 : 1;
      this.driveForce = wheelN * dir;

      // clutch capacity clamp while slipping
      if (this.launching) {
        const cap = 9200;
        this.driveForce = THREEclamp(this.driveForce, -cap, cap);
      }

      // engine braking when coasting in gear — always opposes the motion
      if (throttle < 0.05 && !this.launching && absVF > 0.3) {
        const brakeN = 30 * ratioNow / T.finalDrive * (0.4 + 0.6 * this.rpm / T.redline);
        this.driveForce -= Math.sign(vF) * brakeN;
      }
    }

    this.rpmNorm = THREEclamp((this.rpm - T.idleRpm) / (T.redline - T.idleRpm), 0, 1.04);

    // ---------- shifter animation ---------------------------------------------
    const label = this.gearLabel;
    const slot = SHIFTER_SLOTS[label] || SHIFTER_SLOTS.N;
    const k = Math.min(1, dt * 10);
    this.shifterX += (slot[0] - this.shifterX) * k;
    this.shifterZ += (slot[1] - this.shifterZ) * k;
  }
}

function THREEclamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
