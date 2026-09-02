/**
 * RaceSystem — countdown, 3-lap race with checkpoint validation, lap /
 * total timing, best-lap persistence, wrong-way detection and finish.
 *
 * Anti-cheat design:
 *  - 3 gates must be crossed IN ORDER during a lap (0.3, 0.62, 0.85 of the
 *    circuit) and only then does a forward crossing of s=0 count a lap.
 *  - A gate is only collected when the car is near the centerline, so
 *    cutting across the infield does not register.
 *  - Backwards crossings of the finish line never count: only positive
 *    wrapped progress deltas across s=0 are evaluated.
 */

import { TRACK } from './Constants.js';

const BEST_KEY = 'apex-circuit:best-lap';

export function formatTime(t) {
  if (t == null || !isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function loadBest() {
  try {
    const v = parseFloat(localStorage.getItem(BEST_KEY));
    return isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function saveBest(t) {
  try {
    localStorage.setItem(BEST_KEY, String(t));
  } catch { /* private mode etc. */ }
}

export class RaceSystem {
  constructor() {
    this.totalLaps = TRACK.totalLaps;
    this.reset();
    this.savedBest = loadBest();
    this.bestLap = this.savedBest;

    // callbacks (wired by Game)
    this.onCountdown = null;     // (text) => void, text in {'3','2','1','GO!'}
    this.onLapComplete = null;   // (lapTime, lapNumber, isBest) => void
    this.onFinished = null;      // (summary) => void
    this.onWrongWay = null;      // (showBool) => void
  }

  reset() {
    this.state = 'idle';         // idle | countdown | racing | finished
    this.lap = 1;
    this.lapTime = 0;
    this.totalTime = 0;
    this.lapTimes = [];
    this.checkpoints = [false, false, false];
    this.nextCp = 0;
    this.prevS = 0;
    this.countdownT = 0;
    this._lastCountdownStep = null;
    this.wrongWayT = 0;
    this.wrongWayShown = false;
    this.backAccum = 0;   // leaked accumulator of signed progress (quantization-proof)
    this.finishSummary = null;
  }

  startCountdown() {
    this.reset();
    this.bestLap = this.savedBest;
    this.state = 'countdown';
    this.countdownT = 3.0;
    this._lastCountdownStep = null;
  }

  /** progress delta wrapped to (-0.5, 0.5] */
  static wrapDelta(d) {
    while (d > 0.5) d -= 1;
    while (d < -0.5) d += 1;
    return d;
  }

  /**
   * @param {number} dt
   * @param {VehiclePhysics} phys
   */
  update(dt, phys) {
    if (this.state === 'countdown') {
      this.countdownT -= dt;
      const step = this.countdownT > 2 ? '3'
        : this.countdownT > 1 ? '2'
        : this.countdownT > 0 ? '1'
        : 'GO!';

      if (step !== this._lastCountdownStep && step !== null) {
        this._lastCountdownStep = step;
        if (this.onCountdown) this.onCountdown(step);
      }
      if (this.countdownT <= 0) {
        this.state = 'racing';
        this.totalTime = 0;
        this.lapTime = 0;
        this.prevS = phys.s;
      }
      return;
    }

    if (this.state !== 'racing') return;

    // ------- timing ------------------------------------------------------
    this.totalTime += dt;
    this.lapTime += dt;

    // ------- progress / checkpoints ----------------------------------------
    const s = phys.s;
    const delta = RaceSystem.wrapDelta(s - this.prevS);

    // wrong-way detection.
    // phys.s is quantized to sample steps (1/1000), so a per-frame delta
    // threshold would never fire; accumulate signed progress with a slow
    // leak instead and trigger when the car has genuinely travelled
    // ~4m backwards while moving fast.
    this.backAccum = Math.max(-0.02, Math.min(0.02,
      (this.backAccum + delta) * Math.exp(-0.3 * dt)
    ));
    if (this.backAccum < -0.003 && Math.abs(phys.vF) > 4) {
      this.wrongWayT += dt;
    } else {
      this.wrongWayT = Math.max(0, this.wrongWayT - dt * 2);
    }
    const wrongWay = this.wrongWayT > 0.7;
    if (wrongWay !== this.wrongWayShown) {
      this.wrongWayShown = wrongWay;
      if (this.onWrongWay) this.onWrongWay(wrongWay);
    }

    // gate collection (in order, near the centerline)
    if (this.nextCp < TRACK.checkpoints.length) {
      const gateS = TRACK.checkpoints[this.nextCp];
      const near = Math.abs(RaceSystem.wrapDelta(s - gateS)) < 0.012;
      if (near && Math.abs(phys.lateral) < TRACK.roadHalfWidth + 2.5) {
        this.checkpoints[this.nextCp] = true;
        this.nextCp++;
      }
    }

    // finish-line crossing (forward only, all gates collected)
    const crossedForward = delta > 0 && this.prevS > 0.9 && s < 0.1;
    if (crossedForward && this.nextCp >= TRACK.checkpoints.length) {
      const lapTime = this.lapTime;
      this.lapTimes.push(lapTime);
      const isBest = this.bestLap == null || lapTime < this.bestLap;
      if (isBest) {
        this.bestLap = lapTime;
        this.savedBest = lapTime;
        saveBest(lapTime);
      }
      if (this.onLapComplete) this.onLapComplete(lapTime, this.lap, isBest);

      if (this.lap >= this.totalLaps) {
        this.state = 'finished';
        this.finishSummary = {
          totalTime: this.totalTime,
          bestLap: this.bestLap,
          lapTimes: [...this.lapTimes],
          newRecord: isBest
        };
        if (this.onFinished) this.onFinished(this.finishSummary);
        return;
      }
      this.lap++;
      this.lapTime = 0;
      this.checkpoints = [false, false, false];
      this.nextCp = 0;
    }

    this.prevS = s;
  }

  /** teleport-verified checkpoint fill for debugging/testing */
  _debugCollectAll() {
    this.checkpoints = [true, true, true];
    this.nextCp = 3;
  }
}
