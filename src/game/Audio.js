/**
 * GameAudio — fully procedural engine / tire / wind audio via Web Audio API.
 * No external audio files, so there is nothing to load and nothing to fail
 * except Web Audio itself — and every entry point is guarded so the game
 * runs silently if audio is unavailable.
 *
 * Engine: the pitch tracks the TRANSMISSION's real rpm (firing frequency =
 * rpm/60 * 2 for a 4-stroke four), through a waveshaper for grit. Gains
 * split into master + engine channels so the settings menu can balance them.
 * Shifts add a short mechanical blip.
 */

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.muted = false;
    this.available = false;
    this.masterVolume = 0.9;
    this.engineVolume = 0.8;
  }

  /** Must be called from a user gesture (tap / key press). */
  init() {
    if (this.started) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio API not available');
      this.ctx = new Ctx();

      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterVolume;
      this.master.connect(this.ctx.destination);

      // --- engine -----------------------------------------------------
      // gentle saturation so the raw oscillators sound less buzzy
      this.engineShaper = this.ctx.createWaveShaper();
      const n = 256;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 2.2) * 0.85;
      }
      this.engineShaper.curve = curve;

      this.engineFilter = this.ctx.createBiquadFilter();
      this.engineFilter.type = 'lowpass';
      this.engineFilter.frequency.value = 900;
      this.engineFilter.Q.value = 0.9;

      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0;

      this.osc1 = this.ctx.createOscillator();
      this.osc1.type = 'sawtooth';
      this.osc1.frequency.value = 30;

      this.osc2 = this.ctx.createOscillator();
      this.osc2.type = 'square';
      this.osc2.frequency.value = 60;
      const osc2Gain = this.ctx.createGain();
      osc2Gain.gain.value = 0.35;

      this.osc3 = this.ctx.createOscillator();
      this.osc3.type = 'sawtooth';
      this.osc3.frequency.value = 90;
      this.osc3.detune.value = 8;
      const osc3Gain = this.ctx.createGain();
      osc3Gain.gain.value = 0.22;

      this.osc1.connect(this.engineFilter);
      this.osc2.connect(osc2Gain);
      osc2Gain.connect(this.engineFilter);
      this.osc3.connect(osc3Gain);
      osc3Gain.connect(this.engineFilter);
      this.engineFilter.connect(this.engineShaper);
      this.engineShaper.connect(this.engineGain);
      this.engineGain.connect(this.master);
      this.osc1.start();
      this.osc2.start();
      this.osc3.start();

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
   * @param {object} p { rpm (absolute), rpmNorm, throttle, speedN, slip,
   *                     onGrass, onCurb, reversing, launching, limiter }
   */
  update(dt, p) {
    if (!this.started || !this.available) return;
    const t = this.ctx.currentTime;

    // resume after iOS interruptions
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    // firing frequency of a 4-stroke four: rpm / 60 * 2
    const base = Math.max(18, (p.rpm / 60) * 2);
    const revving = p.throttle > 0.02 && Math.abs(p.rpmNorm) > 0;
    const load = 0.4 + p.throttle * 0.6;

    this.osc1.frequency.setTargetAtTime(base, t, 0.03);
    this.osc2.frequency.setTargetAtTime(base * 2, t, 0.03);
    this.osc3.frequency.setTargetAtTime(base * 3.02, t, 0.03);
    this.engineFilter.frequency.setTargetAtTime(
      300 + p.throttle * 900 + p.rpmNorm * 1400, t, 0.05
    );
    const engineVol = (0.05 + p.throttle * 0.075 + p.rpmNorm * 0.06 +
      (p.reversing ? 0.02 : 0)) * this.engineVolume;
    this.engineGain.gain.setTargetAtTime(
      engineVol * (p.limiter ? 0.6 + 0.4 * Math.sin(t * 55) : 1), t, 0.06
    );

    this.windGain.gain.setTargetAtTime(p.speedN * p.speedN * 0.16 * load, t, 0.12);
    const screech = Math.min(1, Math.max(0, (p.slip - 3) / 7)) * (p.onGrass ? 0.06 : 0.24);
    this.screechGain.gain.setTargetAtTime(screech, t, 0.05);
    this.rumbleGain.gain.setTargetAtTime(p.onCurb ? 0.16 + p.speedN * 0.12 : 0, t, 0.05);
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

  /** mechanical shift clack + brief throttle blip */
  shiftBlip(isUpshift) {
    if (!this.started || !this.available || this.muted) return;
    try {
      const t = this.ctx.currentTime;
      // short filtered noise burst = "clack"
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2400;
      bp.Q.value = 1.4;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      src.connect(bp); bp.connect(g); g.connect(this.master);
      src.start(t);
      src.stop(t + 0.12);
      // pressure-release whoosh on upshifts
      if (isUpshift) this.beep(190, 0.07, 0.05, 'sawtooth');
    } catch { /* ignore */ }
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
      this.master.gain.setTargetAtTime(m ? 0 : this.masterVolume, this.ctx.currentTime, 0.05);
    }
  }

  /** settings — volumes live in 0..1 */
  setVolumes(master, engine) {
    this.masterVolume = master;
    this.engineVolume = engine;
    if (this.started && this.available && !this.muted) {
      this.master.gain.setTargetAtTime(master, this.ctx.currentTime, 0.05);
    }
  }
}
