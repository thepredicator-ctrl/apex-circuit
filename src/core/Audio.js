/**
 * Audio — tiny WebAudio synth: engine, tire screech, wind, UI blips.
 *
 * Zero assets: two detuned oscillators + filtered noise cover the whole
 * soundscape, which keeps the bundle lean and avoids any licensing. The
 * context is created lazily on the first user gesture (mobile requirement)
 * and everything routes through one master gain for the mute toggle.
 */
import { Settings } from './Settings.js';

export class DriftAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this._unlocked = false;
  }

  /** Must be called from a user gesture handler (tap). Safe to call often. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this._build();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this._unlocked = true;
    this.setMuted(Settings.get('muted'));
  }

  _build() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    // ---- engine: saw + detuned square through a lowpass
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 900;
    this.engFilter.Q.value = 1.2;
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc1.frequency.value = 60;
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    this.osc2.frequency.value = 91;
    const osc2g = ctx.createGain();
    osc2g.gain.value = 0.35;
    this.osc1.connect(this.engFilter);
    this.osc2.connect(osc2g).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.master);
    this.osc1.start();
    this.osc2.start();

    // ---- shared looped noise buffer for screech + wind
    const len = ctx.sampleRate * 1.5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.04 * w) / 1.04; // slight brown-lean, softer than white
      data[i] = last * 3.2;
    }

    // ---- tire screech: bandpass noise
    this.screechGain = ctx.createGain();
    this.screechGain.gain.value = 0;
    const screechSrc = ctx.createBufferSource();
    screechSrc.buffer = buf;
    screechSrc.loop = true;
    this.screechFilter = ctx.createBiquadFilter();
    this.screechFilter.type = 'bandpass';
    this.screechFilter.frequency.value = 1150;
    this.screechFilter.Q.value = 2.4;
    screechSrc.connect(this.screechFilter).connect(this.screechGain).connect(this.master);
    screechSrc.start();

    // ---- wind: lowpass noise
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = buf;
    windSrc.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 420;
    windSrc.connect(windFilter).connect(this.windGain).connect(this.master);
    windSrc.start();

    this.ready = true;
  }

  setMuted(m) {
    if (!this.master) return;
    this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  /**
   * Per-frame mix.
   * @param {object} s { speedNorm 0..1, throttle 0..1, slip 0..1 (drift intensity), drifting bool }
   */
  update(s) {
    if (!this.ready || !this._unlocked) return;
    const t = this.ctx.currentTime;

    // engine pitch: idle 58Hz to ~240Hz
    const rpm = Math.min(1, s.speedNorm * 0.82 + s.throttle * 0.28);
    const f = 58 + rpm * 185;
    this.osc1.frequency.setTargetAtTime(f, t, 0.06);
    this.osc2.frequency.setTargetAtTime(f * 1.52, t, 0.06);
    this.engFilter.frequency.setTargetAtTime(500 + rpm * 2100, t, 0.08);
    this.engGain.gain.setTargetAtTime(0.035 + s.throttle * 0.075 + s.speedNorm * 0.02, t, 0.08);

    // screech: loud while sliding
    const scr = s.drifting ? Math.min(0.17, s.slip * 0.19) : 0;
    this.screechGain.gain.setTargetAtTime(scr, t, 0.05);
    this.screechFilter.frequency.setTargetAtTime(900 + s.slip * 900, t, 0.08);

    // wind
    this.windGain.gain.setTargetAtTime(s.speedNorm * s.speedNorm * 0.05, t, 0.15);
  }

  /** Short confirmation blip when points bank. */
  chime(step = 0) {
    if (!this.ready || !this._unlocked) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.14, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
    g.connect(this.master);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(760 + step * 60, t0);
    o.frequency.exponentialRampToValueAtTime(1240 + step * 90, t0 + 0.22);
    o.connect(g);
    o.start(t0);
    o.stop(t0 + 0.3);
  }

  /** Low thud for wall contact. */
  thud(strength = 1) {
    if (!this.ready || !this._unlocked) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.4, 0.12 + strength * 0.3), t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    g.connect(this.master);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(120, t0);
    o.frequency.exponentialRampToValueAtTime(46, t0 + 0.2);
    o.connect(g);
    o.start(t0);
    o.stop(t0 + 0.25);
  }
}
