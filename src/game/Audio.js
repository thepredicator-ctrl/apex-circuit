/**
 * GameAudio — procedural flat-six engine + environment audio (Web Audio).
 * No samples; every sound is synthesized. All entry points are guarded so
 * the game runs silently if audio is unavailable.
 *
 * Design notes — why this sounds like a car and not a vacuum cleaner:
 *  - Real engines are streams of COMBUSTION PULSES: impulsive, uneven,
 *    ringing events. The core is a baked 1.2 s loop of ~240 cylinder pulses
 *    (1 ms pressure spike + exponential body decay + damped low-frequency
 *    exhaust "bark" + combustion snap) with uneven firing intervals, per-
 *    cycle amplitude jitter and a slow lope wobble.
 *  - A second, brighter pulse layer (band-passed 1.2–3.4 kHz) fades in with
 *    revs — the mechanical "scream" over the low bark.
 *  - Timbre is shaped by throttle-driven waveshaper drive + lowpass, a
 *    130 Hz exhaust body resonance, a sine sub octave and a combustion-roar
 *    noise band locked to the firing rate. A random walk on playback rate
 *    kills the "sampled" feel.
 *  - On start: starter-motor whirr → catch → idle flare → settle. Gear whine,
 *    intake plenum hiss, dual-band tire screech, speed wind, cabin rumble,
 *    upshift clack + pressure release, downshift afterfire pops and crash
 *    impacts round out the mix.
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
    this._starting = false;
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

      // engine bus: pulse loop + sub + roar + scream all meet here
      this.engineBus = this.ctx.createGain();
      this.engineBus.gain.value = 0.9;

      this.engineSrc.connect(this.preDrive);
      this.preDrive.connect(this.engineBus);

      // --- top-end scream layer: bright pulses through a moving bandpass ---
      this.screamBP = this.ctx.createBiquadFilter();
      this.screamBP.type = 'bandpass';
      this.screamBP.frequency.value = 1600;
      this.screamBP.Q.value = 1.1;
      this.screamGain = this.ctx.createGain();
      this.screamGain.gain.value = 0;
      const screamSrc = this.ctx.createBufferSource();
      screamSrc.buffer = this.engineLoop;
      screamSrc.loop = true;
      screamSrc.playbackRate.value = 0.4;
      screamSrc.connect(this.screamBP);
      this.screamBP.connect(this.screamGain);
      this.screamGain.connect(this.engineBus);
      screamSrc.start();
      this.screamSrc = screamSrc;

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

      // exhaust body resonances (the "chest" of the car) — two stacked peaks
      this.bodyPeak = this.ctx.createBiquadFilter();
      this.bodyPeak.type = 'peaking';
      this.bodyPeak.frequency.value = 132;
      this.bodyPeak.Q.value = 0.9;
      this.bodyPeak.gain.value = 6;
      this.shaper.connect(this.bodyPeak);

      this.bodyPeak2 = this.ctx.createBiquadFilter();
      this.bodyPeak2.type = 'peaking';
      this.bodyPeak2.frequency.value = 214;
      this.bodyPeak2.Q.value = 1.4;
      this.bodyPeak2.gain.value = 3.5;
      this.bodyPeak.connect(this.bodyPeak2);

      // load-dependent lowpass: wide open under throttle, muted on lift
      this.engineLP = this.ctx.createBiquadFilter();
      this.engineLP.type = 'lowpass';
      this.engineLP.frequency.value = 900;
      this.engineLP.Q.value = 0.7;
      this.bodyPeak2.connect(this.engineLP);

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

      // intake plenum resonance (hollow roar behind the throttle)
      this.plenumBP = this.ctx.createBiquadFilter();
      this.plenumBP.type = 'bandpass';
      this.plenumBP.frequency.value = 240;
      this.plenumBP.Q.value = 2.4;
      this.plenumGain = this._noiseChannel(this.plenumBP, 0);

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

      // tire screech — squeal band + low growl band
      this.screechFilter = this.ctx.createBiquadFilter();
      this.screechFilter.type = 'bandpass';
      this.screechFilter.frequency.value = 1150;
      this.screechFilter.Q.value = 2.2;
      this.screechGain = this._noiseChannel(this.screechFilter, 0);

      this.squealFilter = this.ctx.createBiquadFilter();
      this.squealFilter.type = 'bandpass';
      this.squealFilter.frequency.value = 2300;
      this.squealFilter.Q.value = 3.5;
      this.squealGain = this._noiseChannel(this.squealFilter, 0);

      this.started = true;
      this.available = true;
      this._starting = true;
      // starter motor -> catch -> idle flare -> settle
      this._starterSequence();
      console.log('[ApexCircuit] Audio initialized (flat-six combustion synthesis v2)');
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
   * The buffer represents one flat-six at 2400 rpm: firing rate = 2400/60*3
   * = 120 Hz => 144 pulses over 1.2 s (the boxer six takes a deep, even
   * breath with slight unevenness for character).
   */
  _makeEngineLoop() {
    const SR = this.ctx.sampleRate;
    const seconds = 1.2;
    const len = Math.floor(SR * seconds);
    const buf = this.ctx.createBuffer(1, len, SR);
    const d = buf.getChannelData(0);

    const nPulses = 144;
    const step = len / nPulses;                 // nominal interval
    const tail = Math.floor(0.034 * SR);        // pulse tail (34 ms)
    // deterministic RNG so the loop always sounds the same
    let seed = 987654321;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    for (let k = 0; k < nPulses; k++) {
      // boxer uneven firing: alternating interval bias + per-cycle jitter
      const uneven = (k % 2 === 0 ? 0.085 : -0.085) * step * (0.7 + rnd() * 0.6);
      const start = Math.floor(k * step + uneven) % len;
      // amplitude: per-cycle jitter + slow ~4 Hz lope wobble
      const wobble = 0.85 + 0.15 * Math.sin(k * 0.72);
      const amp = (0.72 + rnd() * 0.56) * wobble;
      const ringF = 88 + rnd() * 24;            // per-cylinder exhaust bark
      const ringF2 = ringF * 1.9;
      const decay = 0.009 + rnd() * 0.0035;     // body decay time constant

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
   * Starter sequence: whirring starter motor, the catch, an idle flare and
   * settle. The main engine loop fades in under it so the handoff is seamless.
   */
  _starterSequence() {
    try {
      const t0 = this.ctx.currentTime;
      const SR = this.ctx.sampleRate;

      // --- starter motor: whirring PM motor + meshing gear teeth ------------
      const dur = 0.85;
      const len = Math.floor(SR * dur);
      const buf = this.ctx.createBuffer(1, len, SR);
      const d = buf.getChannelData(0);
      let phase = 0, gearPhase = 0;
      for (let i = 0; i < len; i++) {
        const t = i / SR;
        // motor spins up 14 -> 26 Hz over the crank; gear mesh at 9x
        const f = 14 + 14 * Math.min(1, t / 0.5);
        phase += 2 * Math.PI * f / SR;
        gearPhase += 2 * Math.PI * f * 8.5 / SR;
        const crank = Math.sin(phase) * 0.5 + Math.sin(phase * 2) * 0.25;
        const teeth = (Math.sin(gearPhase) > 0.2 ? 1 : 0.35) * 0.4;
        const brush = (Math.random() * 2 - 1) * 0.16;
        // amplitude envelope: rise, hold, fade as the engine catches
        const env = Math.min(1, t / 0.06) * (t < 0.62 ? 1 : Math.max(0, 1 - (t - 0.62) / 0.2));
        d[i] = (crank * 0.5 + teeth * 0.4 + brush) * env * 0.5;
      }
      const starter = this.ctx.createBufferSource();
      starter.buffer = buf;
      const starterBP = this.ctx.createBiquadFilter();
      starterBP.type = 'bandpass';
      starterBP.frequency.value = 700;
      starterBP.Q.value = 0.8;
      const starterGain = this.ctx.createGain();
      starterGain.gain.value = 0.5;
      starter.connect(starterBP); starterBP.connect(starterGain);
      starterGain.connect(this.master);
      starter.start(t0);

      // --- the catch: engine cranks at ~250 rpm then fires ------------------
      // pulse loop rate ramps 250 -> 1100 rpm, gain fades in from 0.55 s
      this.engineSrc.playbackRate.setValueAtTime(0.1, t0);
      this.engineSrc.playbackRate.linearRampToValueAtTime(0.30, t0 + 0.55);
      this.engineSrc.playbackRate.linearRampToValueAtTime(0.55, t0 + 0.78);
      this.screamSrc.playbackRate.setValueAtTime(0.1, t0);
      this.screamSrc.playbackRate.linearRampToValueAtTime(0.30, t0 + 0.55);
      this.screamSrc.playbackRate.linearRampToValueAtTime(0.55, t0 + 0.78);
      this.engineGain.gain.setValueAtTime(0, t0);
      this.engineGain.gain.linearRampToValueAtTime(0.16, t0 + 0.62);

      // first fire pop at ~0.6 s
      this._pop(0.62, 0.34, 130);
      this._pop(0.72, 0.28, 150);

      // idle flare handled by update() via this._starting flag
      this._startT = t0;
    } catch { /* never crash the game from audio */ }
  }

  /** single exhaust pop (used by the starter catch and afterfire) */
  _pop(delayS, vol = 0.3, freq = 140) {
    if (!this.started || !this.available) return;
    try {
      const t = this.ctx.currentTime + delayS;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq * 1.6, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.09);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      const shaper = this.ctx.createWaveShaper();
      const c = new Float32Array(256);
      for (let i = 0; i < 256; i++) c[i] = Math.tanh(((i / 255) * 2 - 1) * 3) * 0.9;
      shaper.curve = c;
      osc.connect(shaper); shaper.connect(g); g.connect(this.master);
      osc.start(t); osc.stop(t + 0.14);
    } catch { /* ignore */ }
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

    // starter sequence handoff: idle flare 1400 -> 900 rpm over ~1.6 s
    let rpm = p.rpm;
    if (this._starting) {
      const dt0 = t - this._startT;
      if (dt0 < 2.0) {
        const flare = Math.max(p.rpm, 900 + 500 * Math.exp(-dt0 * 2.2));
        rpm = Math.max(rpm * Math.min(1, dt0 / 1.2), flare);
      } else {
        this._starting = false;
      }
    }

    // flat-six four-stroke firing frequency: rpm/60 * 3
    const f = Math.max(20, (rpm / 60) * 3);
    const rn = Math.min(1, Math.max(0, p.rpmNorm));
    const thr = Math.min(1, Math.max(0, p.throttle));

    // --- pulse loop playback: rpm ratio + tiny organic rate drift -----------
    this._jit += (Math.random() - 0.5) * 0.9 * dt;
    this._jit = Math.max(-0.02, Math.min(0.02, this._jit));
    const rate = Math.max(0.1, (rpm / 2400)) * (1 + this._jit);
    this.engineSrc.playbackRate.setTargetAtTime(rate, t, 0.03);
    this.screamSrc.playbackRate.setTargetAtTime(rate, t, 0.03);

    // --- timbre: drive + filter follow load and revs ------------------------
    this.preDrive.gain.setTargetAtTime(0.7 + thr * 0.85, t, 0.05);
    this.engineLP.frequency.setTargetAtTime(
      300 + thr * 1900 + rn * 2600, t, 0.05
    );
    this.bodyPeak.frequency.setTargetAtTime(120 + rn * 46, t, 0.1);
    this.bodyPeak2.frequency.setTargetAtTime(196 + rn * 64, t, 0.1);

    // sub octave: strong low, fades as the scream takes over
    this.subOsc.frequency.setTargetAtTime(f * 0.5, t, 0.02);
    this.subGain.gain.setTargetAtTime(0.16 * (1 - rn * 0.5) * (0.5 + thr * 0.5), t, 0.05);

    // top-end scream: bandpass tracks 1.1x firing, fades in past 4k rpm
    this.screamBP.frequency.setTargetAtTime(Math.min(3400, 480 + f * 1.1), t, 0.04);
    this.screamGain.gain.setTargetAtTime(
      Math.pow(rn, 1.6) * (0.05 + thr * 0.12), t, 0.06
    );

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

    // exhaust crackles on hard lift-off at high revs + afterfire pops
    if (this._lastThrottle > 0.45 && thr < 0.12 && rn > 0.42) {
      this._crackleBurst(2 + Math.floor(Math.random() * 4));
      if (rn > 0.62) this._pop(0.05, 0.22, 120);
    }
    this._lastThrottle = thr;

    // environment layers
    this.intakeGain.gain.setTargetAtTime(thr * thr * rn * 0.07, t, 0.06);
    this.plenumBP.frequency.setTargetAtTime(190 + rn * 180, t, 0.08);
    this.plenumGain.gain.setTargetAtTime(thr * (0.02 + rn * 0.05), t, 0.07);
    this.windGain.gain.setTargetAtTime(p.speedN * p.speedN * 0.22, t, 0.10);
    this.windFilter.frequency.setTargetAtTime(420 + p.speedN * 700, t, 0.1);
    this.cabinGain.gain.setTargetAtTime(
      p.speedN * p.speedN * 0.10 + (p.onCurb ? 0.06 : 0), t, 0.08
    );
    const slide = Math.min(1, Math.max(0, (p.slip - 3) / 7));
    const surfaceMul = p.onGrass ? 0.25 : 1;
    this.screechGain.gain.setTargetAtTime(slide * 0.24 * surfaceMul, t, 0.05);
    this.screechFilter.frequency.setTargetAtTime(900 + slide * 500, t, 0.06);
    this.squealGain.gain.setTargetAtTime(slide * slide * 0.12 * surfaceMul, t, 0.05);
    this.squealFilter.frequency.setTargetAtTime(1900 + slide * 900, t, 0.06);
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

  /**
   * Mechanical shift clack + pressure release; downshifts get a rev-match
   * blip and afterfire pop like the exhaust bypass valve opened.
   */
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
      else {
        this._crackleBurst(2);
        this._pop(0.06, 0.16, 130);
      }
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

  /** wall impact: low thud + metallic ring + debris scatter */
  crashThud(intensity = 1) {
    if (!this.started || !this.available || this.muted) return;
    try {
      const t = this.ctx.currentTime;
      const amp = Math.min(1, Math.max(0.25, intensity));
      // body thud
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120 * amp + 40, t);
      osc.frequency.exponentialRampToValueAtTime(38, t + 0.16);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.5 * amp, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(g); g.connect(this.master);
      osc.start(t); osc.stop(t + 0.26);
      // metallic ring + debris
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900 + Math.random() * 700;
      bp.Q.value = 1.1;
      const g2 = this.ctx.createGain();
      g2.gain.setValueAtTime(0.22 * amp, t);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      src.connect(bp); bp.connect(g2); g2.connect(this.master);
      src.start(t); src.stop(t + 0.34);
      // screech burst (tires protest)
      this._crackleBurst(2);
    } catch { /* ignore */ }
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
