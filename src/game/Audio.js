/**
 * GameAudio — fully procedural engine / tire / wind audio via Web Audio API.
 * No external audio files, so there is nothing to load and nothing to fail
 * except Web Audio itself — and every entry point is guarded so the game
 * runs silently if audio is unavailable.
 *
 * Engine: two detuned oscillators through a lowpass; pitch follows a fake
 * gearbox (rpmNorm + gear from physics), gain follows the throttle.
 */

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.muted = false;
    this.available = false;
  }

  /** Must be called from a user gesture (tap / key press). */
  init() {
    if (this.started) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio API not available');
      this.ctx = new Ctx();

      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);

      // --- engine -----------------------------------------------------
      this.engineFilter = this.ctx.createBiquadFilter();
      this.engineFilter.type = 'lowpass';
      this.engineFilter.frequency.value = 500;
      this.engineFilter.Q.value = 0.8;

      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0;

      this.osc1 = this.ctx.createOscillator();
      this.osc1.type = 'sawtooth';
      this.osc1.frequency.value = 50;

      this.osc2 = this.ctx.createOscillator();
      this.osc2.type = 'square';
      this.osc2.frequency.value = 25;
      const osc2Gain = this.ctx.createGain();
      osc2Gain.gain.value = 0.45;

      this.osc1.connect(this.engineFilter);
      this.osc2.connect(osc2Gain);
      osc2Gain.connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.master);
      this.osc1.start();
      this.osc2.start();

      // --- shared noise buffer ----------------------------------------
      const len = this.ctx.sampleRate * 2;
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      // wind (speed rush)
      this.windGain = this._noiseChannel('lowpass', 420, 0.7, 0);
      // tire screech
      this.screechFilter = this.ctx.createBiquadFilter();
      this.screechFilter.type = 'bandpass';
      this.screechFilter.frequency.value = 1150;
      this.screechFilter.Q.value = 2.2;
      this.screechGain = this._noiseChannel(this.screechFilter, 0);
      // curb rumble
      this.rumbleFilter = this.ctx.createBiquadFilter();
      this.rumbleFilter.type = 'lowpass';
      this.rumbleFilter.frequency.value = 95;
      this.rumbleGain = this._noiseChannel(this.rumbleFilter, 0);

      this.started = true;
      this.available = true;
      console.log('[ApexCircuit] Audio initialized');
    } catch (err) {
      console.warn('[ApexCircuit] Audio disabled:', err);
      this.available = false;
    }
  }

  /** helper: looping noise source through an optional filter into a gain */
  _noiseChannel(filterOrType, freqOrGain, q, gain0) {
    // flexible signature: (filterNode, gain) or (type, freq, q, gain)
    let filter = null, gainVal = 0;
    if (typeof filterOrType === 'object' && filterOrType !== null) {
      filter = filterOrType;
      gainVal = freqOrGain;
    } else {
      filter = this.ctx.createBiquadFilter();
      filter.type = filterOrType;
      filter.frequency.value = freqOrGain;
      filter.Q.value = q;
      gainVal = gain0;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = gainVal;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start();
    return gain;
  }

  /**
   * Per-frame audio update. All params smoothed with setTargetAtTime.
   */
  update(dt, { rpmNorm, gear, throttle, speedN, slip, onGrass, onCurb, reversing }) {
    if (!this.started || !this.available) return;
    const t = this.ctx.currentTime;

    // resume after iOS interruptions
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    const gearIdx = gear < 0 ? 0 : gear;
    const freq = 44 + gearIdx * 7 + rpmNorm * 92;
    this.osc1.frequency.setTargetAtTime(freq, t, 0.04);
    this.osc2.frequency.setTargetAtTime(freq * 0.5, t, 0.04);
    this.engineFilter.frequency.setTargetAtTime(340 + throttle * 850 + rpmNorm * 650, t, 0.06);
    const engineVol = 0.045 + throttle * 0.075 + rpmNorm * 0.05 + (reversing ? 0.02 : 0);
    this.engineGain.gain.setTargetAtTime(engineVol, t, 0.08);

    this.windGain.gain.setTargetAtTime(speedN * speedN * 0.16, t, 0.12);
    const screech = Math.min(1, Math.max(0, (slip - 3) / 7)) * (onGrass ? 0.06 : 0.24);
    this.screechGain.gain.setTargetAtTime(screech, t, 0.05);
    this.rumbleGain.gain.setTargetAtTime(onCurb ? 0.16 + speedN * 0.12 : 0, t, 0.05);
  }

  /** short beep used by the countdown / lap dings */
  beep(freq = 440, dur = 0.14, vol = 0.22, type = 'square') {
    if (!this.started || !this.available || this.muted) return;
    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(vol, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    } catch { /* audio must never crash the game */ }
  }

  countdownBeep(step) {
    // step: 3, 2, 1 -> low; GO -> high
    if (step === 'GO') this.beep(880, 0.5, 0.26);
    else this.beep(440, 0.16, 0.2);
  }

  lapDing() {
    this.beep(660, 0.12, 0.18, 'sine');
    setTimeout(() => this.beep(990, 0.18, 0.18, 'sine'), 110);
  }

  finishJingle() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => setTimeout(() => this.beep(f, 0.22, 0.2, 'triangle'), i * 140));
  }

  crashThud() {
    this.beep(70, 0.18, 0.3, 'sawtooth');
  }

  setMuted(m) {
    this.muted = m;
    if (this.started && this.available) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
    }
  }
}
