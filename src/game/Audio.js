/**
 * GameAudio — procedural V10 engine / tire / wind audio (Web Audio).
 * No external audio files; every entry point is guarded so the game runs
 * silently if audio is unavailable.
 *
 * Why this does NOT sound like a vacuum cleaner (design notes):
 *  - Vacuum-cleaner sound = a steady oscillator drone: perfectly periodic,
 *    perfectly even, all energy in one narrow band. Real engines are a
 *    stream of COMBUSTION PULSES: impulsive, uneven, ringing events.
 *  - So the core of this synth is a procedurally baked engine loop: a
 *    1.2 s buffer containing ~240 individual cylinder pulses, each with a
 *    1 ms pressure spike, an exponential body decay, a damped low-frequency
 *    ring (the exhaust "bark") and a short combustion snap. Firing intervals
 *    alternate ±10 % (uneven V-firing) with per-cycle amplitude jitter and a
 *    slow lope wobble — the organic "potato-potato" texture.
 *  - At runtime the loop plays back at rate = rpm / bakeRpm, so the pulse
 *    density scales exactly like a real engine. Timbre is shaped by a
 *    throttle-driven waveshaper drive + lowpass (wide open under load,
 *    muted on lift), a 130 Hz body resonance, a sine sub octave, and a
 *    combustion-roar noise band that tracks the firing rate.
 *  - A tiny random walk on the playback rate kills the "sampled" feel.
 *  - Exhaust crackles on lift-off, intake hiss, speed wind, cabin rumble,
 *    tire screech and curb rumble round out the mix.
 */

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.muted = false;
    this.available = false;
    this.masterVolume = 0.9;
    this.engineVolume = 0.8;
    this._lastThrottle = 0;
    this._t = 0;
    this._jit = 0;
  }

  /** Must be called from a user gesture (tap / key press). */
  init() {
    if (this.started) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio API not available');
      this.ctx = new Ctx();

      // --- master chain: gain -> compressor -> out ------------------------
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterVolume;

      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -14;
      this.comp.knee.value = 22;
      this.comp.ratio.value = 4;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.16;
      this.master.connect(this.comp);
      this.comp.connect(this.ctx.destination);

      // shared noise buffer (intake / wind / cabin / screech / crackles)
      this.noiseBuffer = this._makeNoise(2);

      // ================= ENGINE VOICE =================
      // combustion pulse loop baked at 2400 rpm
      this.engineLoop = this._makeEngineLoop();
      this.engineSrc = this.ctx.createBufferSource();
      this.engineSrc.buffer = this.engineLoop;
      this.engineSrc.loop = true;
      this.engineSrc.playbackRate.value = 0.4;

      // throttle-driven pre-drive into the soft clipper
      this.preDrive = this.ctx.createGain();
      this.preDrive.gain.value = 0.8;

      // engine bus: pulse loop + sub + roar all meet here
      this.engineBus = this.ctx.createGain();
      this.engineBus.gain.value = 0.9;

      this.engineSrc.connect(this.preDrive);
      this.preDrive.connect(this.engineBus);

      // sine sub octave — the weight you feel in your chest (crank order)
      this.subOsc = this.ctx.createOscillator();
      this.subOsc.type = 'sine';
      this.subOsc.frequency.value = 40;
      this.subGain = this.ctx.createGain();
      this.subGain.gain.value = 0.14;
      this.subOsc.connect(this.subGain);
      this.subGain.connect(this.engineBus);
      this.subOsc.start();

      // combustion roar: noise band locked to ~2x the firing rate
      this.roarBP = this.ctx.createBiquadFilter();
      this.roarBP.type = 'bandpass';
      this.roarBP.frequency.value = 420;
      this.roarBP.Q.value = 1.6;
      this.gainRoar = this.ctx.createGain();
      this.gainRoar.gain.value = 0.1;
      const roarSrc = this.ctx.createBufferSource();
      roarSrc.buffer = this.noiseBuffer;
      roarSrc.loop = true;
      roarSrc.connect(this.roarBP);
      this.roarBP.connect(this.gainRoar);
      this.gainRoar.connect(this.engineBus);
      roarSrc.start();

      // soft clipper — dense growl instead of buzzy buzz
      this.shaper = this.ctx.createWaveShaper();
      const n = 512;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 2.6) * 0.9;
      }
      this.shaper.curve = curve;
      this.shaper.oversample = '2x';
      this.engineBus.connect(this.shaper);

      // exhaust body resonance ~130 Hz (the "chest" of the car)
      this.bodyPeak = this.ctx.createBiquadFilter();
      this.bodyPeak.type = 'peaking';
      this.bodyPeak.frequency.value = 132;
      this.bodyPeak.Q.value = 0.9;
      this.bodyPeak.gain.value = 6;
      this.shaper.connect(this.bodyPeak);

      // load-dependent lowpass: wide open under throttle, muted on lift
      this.engineLP = this.ctx.createBiquadFilter();
      this.engineLP.type = 'lowpass';
      this.engineLP.frequency.value = 900;
      this.engineLP.Q.value = 0.7;
      this.bodyPeak.connect(this.engineLP);

      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0;
      this.engineLP.connect(this.engineGain);
      this.engineGain.connect(this.master);

      // --- environment layers ----------------------------------------------
      // intake hiss (rises with throttle x revs)
      this.intakeFilter = this.ctx.createBiquadFilter();
      this.intakeFilter.type = 'highpass';
      this.intakeFilter.frequency.value = 1700;
      this.intakeGain = this._noiseChannel(this.intakeFilter, 0);

      // wind (speed rush)
      this.windFilter = this.ctx.createBiquadFilter();
      this.windFilter.type = 'lowpass';
      this.windFilter.frequency.value = 520;
      this.windGain = this._noiseChannel(this.windFilter, 0);

      // cabin rumble (speed pressure + curb knock)
      this.cabinFilter = this.ctx.createBiquadFilter();
      this.cabinFilter.type = 'lowpass';
      this.cabinFilter.frequency.value = 82;
      this.cabinGain = this._noiseChannel(this.cabinFilter, 0);

      // tire screech
      this.screechFilter = this.ctx.createBiquadFilter();
      this.screechFilter.type = 'bandpass';
      this.screechFilter.frequency.value = 1150;
      this.screechFilter.Q.value = 2.2;
      this.screechGain = this._noiseChannel(this.screechFilter, 0);

      this.started = true;
      this.available = true;
      console.log('[ApexCircuit] Audio initialized (combustion-pulse V10 synthesis)');
    } catch (err) {
      console.warn('[ApexCircuit] Audio disabled:', err);
      this.available = false;
    }
  }

  _makeNoise(seconds = 2) {
    const len = this.ctx.sampleRate * seconds;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /**
   * Bake the seamless combustion-pulse engine loop.
   * The buffer represents one V10 at 2400 rpm: firing rate = 2400/60*5 =
   * 200 Hz => 240 pulses over 1.2 s. Every pulse contribution is wrapped
   * modulo the buffer length, so the loop is seamless by construction.
   */
  _makeEngineLoop() {
    const SR = this.ctx.sampleRate;
    const seconds = 1.2;
    const len = Math.floor(SR * seconds);
    const buf = this.ctx.createBuffer(1, len, SR);
    const d = buf.getChannelData(0);

    const nPulses = 240;
    const step = len / nPulses;                 // nominal interval
    const tail = Math.floor(0.032 * SR);        // pulse tail (32 ms)
    // deterministic RNG so the loop always sounds the same
    let seed = 987654321;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    for (let k = 0; k < nPulses; k++) {
      // uneven firing: alternating interval bias + per-cycle jitter
      const uneven = (k % 2 === 0 ? 0.10 : -0.10) * step * (0.7 + rnd() * 0.6);
      const start = Math.floor(k * step + uneven) % len;
      // amplitude: per-cycle jitter + slow ~4 Hz lope wobble
      const wobble = 0.85 + 0.15 * Math.sin(k * 0.72);
      const amp = (0.72 + rnd() * 0.56) * wobble;
      const ringF = 96 + rnd() * 22;            // per-cylinder exhaust bark
      const ringF2 = ringF * 1.9;
      const decay = 0.0085 + rnd() * 0.003;     // body decay time constant

      for (let i = 0; i < tail; i++) {
        const t = i / SR;
        const attack = Math.min(1, t / 0.0012);
        const env = Math.exp(-t / decay);
        const ring = 0.8 * Math.sin(2 * Math.PI * ringF * t)
          + 0.25 * Math.sin(2 * Math.PI * ringF2 * t + 0.6);
        // short combustion snap (bright pressure spike)
        const snap = t < 0.0035
          ? (rnd() * 2 - 1) * Math.exp(-t / 0.0012) * 0.85
          : 0;
        const idx = (start + i) % len;          // wrap => seamless loop
        d[idx] += amp * attack * env * (ring * 0.55 + snap);
      }
    }

    // normalize
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    const norm = peak > 0 ? 0.85 / peak : 1;
    for (let i = 0; i < len; i++) d[i] *= norm;
    return buf;
  }

  /** helper: looping noise source through a filter node into a gain */
  _noiseChannel(filter, gainVal) {
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
    this._t += dt;

    // resume after iOS interruptions
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    // V10 four-stroke firing frequency: rpm/60 * 5
    const f = Math.max(20, (p.rpm / 60) * 5);
    const rn = Math.min(1, Math.max(0, p.rpmNorm));
    const thr = Math.min(1, Math.max(0, p.throttle));

    // --- pulse loop playback: rpm ratio + tiny organic rate drift -----------
    this._jit += (Math.random() - 0.5) * 0.9 * dt;
    this._jit = Math.max(-0.02, Math.min(0.02, this._jit));
    const rate = Math.max(0.1, (p.rpm / 2400)) * (1 + this._jit);
    this.engineSrc.playbackRate.setTargetAtTime(rate, t, 0.03);

    // --- timbre: drive + filter follow load and revs ------------------------
    this.preDrive.gain.setTargetAtTime(0.7 + thr * 0.85, t, 0.05);
    this.engineLP.frequency.setTargetAtTime(
      300 + thr * 1900 + rn * 2600, t, 0.05
    );
    this.bodyPeak.frequency.setTargetAtTime(120 + rn * 46, t, 0.1);

    // sub octave: strong low, fades as the scream takes over
    this.subOsc.frequency.setTargetAtTime(f * 0.5, t, 0.02);
    this.subGain.gain.setTargetAtTime(0.16 * (1 - rn * 0.5) * (0.5 + thr * 0.5), t, 0.05);

    // combustion roar tracks the firing rate
    this.roarBP.frequency.setTargetAtTime(Math.min(3800, f * 2.2), t, 0.03);
    this.gainRoar.gain.setTargetAtTime(0.07 + 0.17 * thr * (0.4 + 0.6 * rn), t, 0.05);

    // master engine loudness (burble at low revs, limiter chop at redline)
    let vol = 0.13 + thr * 0.2 + rn * 0.15 + (p.launching ? 0.04 : 0);
    if (rn < 0.22) {
      const burble =
        0.86 + 0.10 * Math.sin(this._t * 11.3) + 0.06 * Math.sin(this._t * 17.7);
      vol *= Math.max(0.62, burble);
    }
    if (p.limiter) vol *= 0.55 + 0.45 * Math.sin(t * 55);
    vol *= this.engineVolume;
    this.engineGain.gain.setTargetAtTime(vol, t, 0.05);

    // exhaust crackles on hard lift-off at high revs
    if (this._lastThrottle > 0.45 && thr < 0.12 && rn > 0.42) {
      this._crackleBurst(2 + Math.floor(Math.random() * 4));
    }
    this._lastThrottle = thr;

    // environment layers
    this.intakeGain.gain.setTargetAtTime(thr * thr * rn * 0.07, t, 0.06);
    this.windGain.gain.setTargetAtTime(p.speedN * p.speedN * 0.22, t, 0.10);
    this.windFilter.frequency.setTargetAtTime(420 + p.speedN * 700, t, 0.1);
    this.cabinGain.gain.setTargetAtTime(
      p.speedN * p.speedN * 0.10 + (p.onCurb ? 0.06 : 0), t, 0.08
    );
    const screech = Math.min(1, Math.max(0, (p.slip - 3) / 7)) * (p.onGrass ? 0.06 : 0.24);
    this.screechGain.gain.setTargetAtTime(screech, t, 0.05);
  }

  /** randomized exhaust crackle burst (lift-off / downshift) */
  _crackleBurst(count) {
    if (!this.started || !this.available || this.muted) return;
    try {
      const t0 = this.ctx.currentTime;
      for (let i = 0; i < count; i++) {
        const at = t0 + i * (0.025 + Math.random() * 0.07);
        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        src.loop = true;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 650 + Math.random() * 1200;
        bp.Q.value = 1.6 + Math.random();
        const g = this.ctx.createGain();
        const peak = 0.05 + Math.random() * 0.10;
        g.gain.setValueAtTime(peak, at);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.045 + Math.random() * 0.07);
        src.connect(bp); bp.connect(g); g.connect(this.master);
        src.start(at);
        src.stop(at + 0.22);
      }
    } catch { /* audio must never crash the game */ }
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

  /** mechanical shift clack + pressure release; downshifts also crackle */
  shiftBlip(isUpshift) {
    if (!this.started || !this.available || this.muted) return;
    try {
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(isUpshift ? 2800 : 1900, t);
      bp.frequency.exponentialRampToValueAtTime(isUpshift ? 1500 : 900, t + 0.12);
      bp.Q.value = 1.3;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.13, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      src.connect(bp); bp.connect(g); g.connect(this.master);
      src.start(t);
      src.stop(t + 0.15);
      if (isUpshift) this.beep(210, 0.06, 0.05, 'sawtooth');
      else this._crackleBurst(2);
    } catch { /* ignore */ }
  }

  countdownBeep(step) {
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
