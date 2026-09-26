/**
 * DriftScore — the loop that makes drifting a game.
 *
 * While the car slides, points accrue from slip angle × speed × zone
 * multiplier × combo. The combo grows the longer the chain lives. When the
 * slide ends there is a short grace window to re-hook the car; run out of
 * grace and the pending points BANK into the total. Crashes and spin-outs
 * (slip past the beta cap) drop the chain.
 */
import { Settings } from '../core/Settings.js';

const GRACE = 1.15;         // seconds of grace before banking
const COMBO_RATE = 0.32;    // combo per second of chain
const COMBO_MAX = 10;
const POINTS_K = 0.024;     // deg·kmh → points per second scale

export class DriftScore {
  constructor(audio, onEvent) {
    this.audio = audio;
    this.onEvent = onEvent || (() => {});
    this.reset();
  }

  reset() {
    this.total = 0;
    this.pending = 0;
    this.combo = 1;
    this.chainTime = 0;
    this.grace = 0;
    this.drifting = false;
    this.chainBest = 0;
    this._milestone = 1;
    this._wasDrifting = false;
  }

  /**
   * @param {object} phys physics state
   * @param {number} zoneMult 0/1.5/2/3 for the current position
   * @param {boolean} crashed impact this frame
   */
  update(phys, zoneMult, crashed) {
    const deg = Math.abs(phys.beta) * 180 / Math.PI;
    const kmh = phys.speed * 3.6;
    const sliding = phys.drifting;

    if (sliding) {
      this.grace = GRACE;
      this.chainTime += 0; // advanced below only when actually counting
      if (!this._wasDrifting) this.onEvent('driftStart');

      const combo = Math.min(COMBO_MAX, 1 + this.chainTime * COMBO_RATE);
      this.combo = combo;
      const mult = Math.max(zoneMult, 1);
      this.pending += deg * kmh * POINTS_K * mult * combo * (1 / 60);
      this.chainTime += 1 / 60;

      const ms = Math.floor(combo);
      if (ms > this._milestone) {
        this._milestone = ms;
        this.onEvent('combo', ms);
      }
    } else if (this.pending > 0) {
      this.grace -= 1 / 60;
      if (this.grace <= 0) this._bank();
    }

    // chain breakers
    if (crashed && this.pending > 0) {
      this.onEvent('crash');
      this._drop();
    } else if (Math.abs(phys.beta) > 1.35 && this.pending > 0) {
      this.onEvent('spinout');
      this._drop();
    }

    this.drifting = sliding;
    this._wasDrifting = sliding;
    return { pending: this.pending, combo: this.combo, total: this.total };
  }

  _bank() {
    const banked = Math.round(this.pending);
    if (banked >= 10) {
      this.total += banked;
      this.chainBest = Math.max(this.chainBest, banked);
      this.onEvent('bank', banked);
    }
    this._drop();
  }

  _drop() {
    this.pending = 0;
    this.combo = 1;
    this.chainTime = 0;
    this.grace = 0;
    this._milestone = 1;
  }

  /** Call when the player resets the car: the chain is lost (kept total). */
  hardReset() {
    if (this.pending > 0) this.onEvent('crash');
    this._drop();
  }
}
