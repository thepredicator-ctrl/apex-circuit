/**
 * Game — engine orchestrator. Owns the renderer, scene graph, fixed-step
 * physics loop, race state machine and all subsystem wiring.
 */

import * as THREE from 'three';
import { Track } from './Track.js';
import { Environment } from './Environment.js';
import { Car } from './Car.js';
import { VehiclePhysics } from './Physics.js';
import { ChaseCamera } from './Camera.js';
import { Input } from './Input.js';
import { GameAudio } from './Audio.js';
import { Effects } from './Effects.js';
import { RaceSystem, formatTime } from './Race.js';
import { HUD } from '../ui/HUD.js';
import { TouchControls } from '../ui/TouchControls.js';

const PHYS_STEP = 1 / 120;

export class Game {
  constructor({ container, onReady, onError }) {
    this.container = container;
    this.onReady = onReady;
    this.onError = onError;

    this.state = 'booting'; // booting | idle | racing | finished
    this._raf = null;
    this._clock = new THREE.Clock();
    this._accum = 0;
    this._idleAngle = 0;
    this._emitAcc = 0;
    this._lastFrameTime = 0;
  }

  // ------------------------------------------------------------------ setup
  init() {
    const isMobile =
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
      (navigator.maxTouchPoints || 0) > 0;
    this.isMobile = isMobile;

    // ---- renderer --------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.8 : 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.container.appendChild(this.renderer.domElement);

    // ---- scene -----------------------------------------------------------
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      62, window.innerWidth / window.innerHeight, 0.3, 2200
    );
    this.camera.position.set(0, 12, -20);

    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.track = new Track(aniso);
    this.scene.add(this.track.group);

    this.environment = new Environment(this.scene, this.renderer, isMobile);

    this.car = new Car();
    this.scene.add(this.car.group);

    this.phys = new VehiclePhysics(this.track);
    this.phys.placeAt(this.track.startS, 0);

    this.chaseCamera = new ChaseCamera(this.camera);
    this.chaseCamera.snapBehind(this.phys);

    this.effects = new Effects(this.scene);

    // ---- subsystems --------------------------------------------------------
    this.audio = new GameAudio();
    this.input = new Input();
    this.race = new RaceSystem();

    this.hud = new HUD({
      onReset: () => this.resetCar(),
      onRestart: () => this.restartRace(),
      onMuteToggle: () => {
        this.audio.setMuted(!this.audio.muted);
        this.hud.setMuted(this.audio.muted);
      }
    });

    this.touch = new TouchControls(this.input, {
      onReset: () => this.resetCar()
    });
    if (this.touch.enabled) this.hud.markTouch();

    this._wireRaceCallbacks();

    this.input.onResetKey = () => {
      if (this.state === 'racing') this.resetCar();
      else if (this.state === 'finished') this.restartRace();
    };

    // ---- events -------------------------------------------------------------
    window.addEventListener('resize', () => this._onResize());
    window.addEventListener('orientationchange', () => setTimeout(() => this._onResize(), 250));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.audio.started) {
        this.audio.ctx && this.audio.ctx.resume().catch(() => {});
      }
    });

    // ---- debug hooks (used by automated tests, handy in devtools) ----------
    window.__game = this;

    this.state = 'idle';
    this._clock.start();
    this._loop();
  }

  _wireRaceCallbacks() {
    this.race.onCountdown = (text) => {
      this.hud.showCountdown(text);
      this.audio.countdownBeep(text);
    };
    this.race.onLapComplete = (lapTime, lap, isBest) => {
      const bestText = isBest ? '  ·  BEST LAP' : '';
      this.hud.showLapToast(`LAP ${lap} — ${formatTime(lapTime)}${bestText}`);
      this.audio.lapDing();
    };
    this.race.onFinished = (summary) => {
      this.state = 'finished';
      this.hud.showFinish(summary);
      this.audio.finishJingle();
    };
    this.race.onWrongWay = (show) => this.hud.setWrongWay(show);
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.isMobile ? 1.8 : 2));
    this.renderer.setSize(w, h);
  }

  // ------------------------------------------------------------- race flow
  /** called from the start screen (user gesture — unlocks audio) */
  startRace() {
    this.audio.init();
    this.hud.show();
    this._beginRace();
  }

  _beginRace() {
    this.hud.hideFinish();
    this.hud.setWrongWay(false);
    this.input.setEnabled(true);
    this.phys.placeAt(this.track.startS, 0);
    this.race.startCountdown();
    this.state = 'racing';
    this.chaseCamera.snapBehind(this.phys);
  }

  restartRace() {
    this._beginRace();
  }

  resetCar() {
    if (this.state !== 'racing') return;
    this.phys.placeAt(this.phys.s, 0);
    this.chaseCamera.snapBehind(this.phys);
    this.hud.showLapToast('CAR RESET');
  }

  // -------------------------------------------------------------- main loop
  _loop = () => {
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.min(this._clock.getDelta(), 0.1);
    if (dt <= 0) return;

    const racing = this.state === 'racing' && this.race.state !== 'finished';
    const controlsActive = this.state === 'racing' && this.race.state === 'racing';

    // input smoothing
    this.input.update(dt);

    // fixed-step physics
    this._accum += dt;
    let steps = 0;
    while (this._accum >= PHYS_STEP && steps < 8) {
      this.phys.update(PHYS_STEP, this.input, controlsActive);
      this._accum -= PHYS_STEP;
      steps++;
    }
    if (steps === 8) this._accum = 0; // avoid spiral of death

    // race logic
    if (racing) this.race.update(dt, this.phys);

    // visuals
    this.car.updateVisual(dt, this.phys);
    this._updateEffects(dt);

    // camera
    if (this.state === 'idle') {
      this._updateIdleCamera(dt);
    } else {
      this.chaseCamera.update(dt, this.phys, this.input.state);
    }

    this.environment.update(this.phys.position, this.camera);

    // audio
    this.audio.update(dt, {
      rpmNorm: this.phys.rpmNorm,
      gear: this.phys.gear,
      throttle: this.phys.throttleOut,
      speedN: Math.min(1, Math.abs(this.phys.vF) / 62),
      slip: this.phys.slip,
      onGrass: this.phys.onGrass,
      onCurb: this.phys.onCurb,
      reversing: this.phys.reversing
    });

    this.hud.update(this.phys, this.race);

    this.renderer.render(this.scene, this.camera);

    if (this.onReady) {
      this.onReady();
      this.onReady = null;
    }
  };

  // ---------------------------------------------------------------- effects
  _updateEffects(dt) {
    const phys = this.phys;
    const speed = Math.abs(phys.vF);
    const drifting = phys.slip > 3.2 && speed > 4;
    const offroad = phys.onGrass && speed > 8;

    this._emitAcc += dt;
    if ((drifting || offroad || phys.justHitWall) && this._emitAcc > 0.03) {
      this._emitAcc = 0;
      const fwd = new THREE.Vector3(Math.sin(phys.heading), 0, Math.cos(phys.heading));
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
      const rear = phys.position.clone().addScaledVector(fwd, -1.4);
      const p1 = rear.clone().addScaledVector(right, 0.8);
      const p2 = rear.clone().addScaledVector(right, -0.8);
      p1.y = 0.25;
      p2.y = 0.25;
      const color = offroad ? 0x9c8a5e : 0xd9d9d9;
      this.effects.emit(p1, phys.velocity, offroad ? 1.4 : 1, color);
      this.effects.emit(p2, phys.velocity, offroad ? 1.4 : 1, color);
    }
    this.effects.update(dt);
  }

  // ---------------------------------------------------------- idle camera
  _updateIdleCamera(dt) {
    this._idleAngle += dt * 0.22;
    const c = this.phys.position;
    const r = 22;
    const x = c.x + Math.cos(this._idleAngle) * r;
    const z = c.z + Math.sin(this._idleAngle) * r;
    this.camera.position.set(x, 7.5, z);
    this.camera.lookAt(c.x, 1.0, c.z);
  }

  // --------------------------------------------------------------- testing
  /** debug helper used by automated tests: teleport to progress s */
  debugTeleportToProgress(s, lateral = 0) {
    this.phys.placeAt(s, lateral);
    this.chaseCamera.snapBehind(this.phys);
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this.renderer.dispose();
  }
}
