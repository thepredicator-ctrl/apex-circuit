/**
 * GameAudio — procedural V10-style engine / tire / wind audio (Web Audio).
 * No external audio files; every entry point is guarded so the game runs
 * silently if audio is unavailable.
 *
 * Engine synthesis (why it doesn't sound like a vacuum cleaner):
 *  - Firing frequency of a V10 four-stroke: f = rpm/60 * 5. At idle that is
 *    a deep 75 Hz rumble; at 7600 rpm it screams at ~630 Hz.
 *  - FOUR oscillator layers: a harmonic-rich PeriodicWave fundamental, a
 *    half-order sub (square through a lowpass — the uneven-firing rumble),
 *    a double-frequency saw that becomes the high-rpm "scream", and a
 *    1.5-order saw for exhaust rasp. Each layer has its own gain curve so
 *    the timbre SHAPES with rpm instead of just getting higher.
 *  - Formant filters: a bandpass "exhaust body" that moves with revs, plus
 *    a load-dependent lowpass — wide open under throttle, muted on lift.
 *  - Combustion texture: bandpass-filtered noise locked to ~2x the firing
 *    frequency, so the tone has roar instead of pure synth tones.
 *  - Soft-clip waveshaper + dynamics compressor: dense, not buzzy.
 *  - Idle burble: slow gain wobble layered in below ~1500 rpm.
 *  - Exhaust crackles: randomized noise bursts on throttle lift at high
 *    revs and on downshifts.
 *  - Intake hiss, speed wind, cabin rumble, tire screech and curb rumble
 *    round out the mix.
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

      // --- harmonic-rich periodic wave (the fundamental voice) ------------
      const H = 20;
      const real = new Float32Array(H);
      const imag = new Float32Array(H);
      for (let n = 1; n < H; n++) {
        // decaying harmonics with a mild formant bump around n=4..6 —
        // reads as "engine" rather than "buzzer"
        const decay = 1 / Math.pow(n, 1.25);
        const bump = 1 + 0.55 * Math.exp(-Math.pow((n - 5) / 2.4, 2));
        const oddBoost = n % 2 === 1 ? 1.22 : 0.92;
        imag[n] = decay * bump * oddBoost;
      }
      this.waveEngine = this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });

      // --- layer nodes ------------------------------------------------------
      const mk = (type, freq) => {
        const o = this.ctx.createOscillator();
        if (type === 'wave') o.setPeriodicWave(this.waveEngine);
        else o.type = type;
        o.frequency.value = freq;
        o.start();
        return o;
      };

      // fundamental
      this.oscA = mk('wave', 60);
      this.gainA = this.ctx.createGain();
      this.gainA.gain.value = 0.5;
      this.oscA.connect(this.gainA);

      // half-order sub rumble (uneven firing character)
      this.oscB = mk('square', 30);
      this.subLP = this.ctx.createBiquadFilter();
      this.subLP.type = 'lowpass';
      this.subLP.frequency.value = 240;
      this.subLP.Q.value = 0.7;
      this.gainB = this.ctx.createGain();
      this.gainB.gain.value = 0.3;
      this.oscB.connect(this.subLP);
      this.subLP.connect(this.gainB);

      // double-frequency scream layer
      this.oscC = mk('sawtooth', 120);
      this.oscC.detune.value = 5;
      this.screamHP = this.ctx.createBiquadFilter();
      this.screamHP.type = 'highpass';
      this.screamHP.frequency.value = 700;
      this.screamHP.Q.value = 0.8;
      this.gainC = this.ctx.createGain();
      this.gainC.gain.value = 0.08;
      this.oscC.connect(this.screamHP);
      this.screamHP.connect(this.gainC);

      // 1.5-order exhaust rasp
      this.oscD = mk('sawtooth', 90);
      this.oscD.detune.value = -7;
      this.gainD = this.ctx.createGain();
      this.gainD.gain.value = 0.16;
      this.oscD.connect(this.gainD);

      // formant body filter for A + D (exhaust resonance)
      this.formant = this.ctx.createBiquadFilter();
      this.formant.type = 'bandpass';
      this.formant.frequency.value = 150;
      this.formant.Q.value = 1.0;
      this.gainA.connect(this.formant);
      this.gainD.connect(this.formant);

      // combustion roar texture (noise locked to the firing rate)
      const noiseBuf = this._makeNoise(2);
      this.noiseSrc = this.ctx.createBufferSource();
      this.noiseSrc.buffer = noiseBuf;
      this.noiseSrc.loop = true;
      this.roarBP = this.ctx.createBiquadFilter();
      this.roarBP.type = 'bandpass';
      this.roarBP.frequency.value = 260;
      this.roarBP.Q.value = 2.4;
      this.gainRoar = this.ctx.createGain();
      this.gainRoar.gain.value = 0.12;
      this.noiseSrc.connect(this.roarBP);
      this.roarBP.connect(this.gainRoar);
      this.noiseSrc.start();

      // --- engine sum -> soft clip -> load lowpass -> gain -----------------
      this.engineSum = this.ctx.createGain();
      this.engineSum.gain.value = 0.9;
      this.gainB.connect(this.engineSum);
      this.gainC.connect(this.engineSum);
      this.formant.connect(this.engineSum);
      this.gainRoar.connect(this.engineSum);

      this.shaper = this.ctx.createWaveShaper();
      const n = 512;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 1.7) * 0.92;
      }
      this.shaper.curve = curve;
      this.shaper.oversample = '2x';
      this.engineSum.connect(this.shaper);

      this.engineLP = this.ctx.createBiquadFilter();
      this.engineLP.type = 'lowpass';
      this.engineLP.frequency.value = 900;
      this.engineLP.Q.value = 0.8;
      this.shaper.connect(this.engineLP);

      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0;
      this.engineLP.connect(this.engineGain);
      this.engineGain.connect(this.master);

      // --- shared noise helpers ---------------------------------------------
      this.noiseBuffer = noiseBuf;

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
      console.log('[ApexCircuit] Audio initialized (V10 synthesis)');
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

    // V10 four-stroke firing frequency: rpm/60 * 5 cylinders fire per rev
    const f = Math.max(20, (p.rpm / 60) * 5);
    const rn = Math.min(1, Math.max(0, p.rpmNorm));
    const thr = Math.min(1, Math.max(0, p.throttle));
    const load = 0.35 + thr * 0.65;

    // layer frequencies (slight detune on the scream keeps it alive)
    this.oscA.frequency.setTargetAtTime(f, t, 0.02);
    this.oscB.frequency.setTargetAtTime(f * 0.5, t, 0.02);
    this.oscC.frequency.setTargetAtTime(f * 2, t, 0.02);
    this.oscD.frequency.setTargetAtTime(f * 1.5 + 1.5, t, 0.02);
    this.roarBP.frequency.setTargetAtTime(Math.min(3800, f * 2.2), t, 0.03);

    // timbre shaping with revs + load
    this.formant.frequency.setTargetAtTime(135 + rn * 230, t, 0.05);
    this.screamHP.frequency.setTargetAtTime(600 + rn * 1500, t, 0.05);
    this.gainC.gain.setTargetAtTime(0.05 + 0.26 * Math.pow(rn, 1.7), t, 0.05);
    this.gainB.gain.setTargetAtTime(
      Math.min(0.4, Math.max(0.10, 0.34 * (1.25 - rn))), t, 0.05
    );
    this.gainRoar.gain.setTargetAtTime(0.08 + 0.20 * thr * (0.4 + 0.6 * rn), t, 0.05);
    this.engineLP.frequency.setTargetAtTime(
      380 + thr * 2000 + rn * 2400, t, 0.05
    );

    // master engine loudness (burble at low revs, limiter chop at redline)
    let vol = 0.10 + thr * 0.14 + rn * 0.11 + (p.launching ? 0.03 : 0);
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
    this.windGain.gain.setTargetAtTime(p.speedN * p.speedN * 0.22 * load, t, 0.10);
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
