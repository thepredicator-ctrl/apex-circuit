/**
 * Game — engine orchestrator for APEX DRIFT.
 *
 * Owns the renderer, the fixed-step physics loop, the seeded map, the car,
 * FX, scoring, camera, audio and the adaptive quality governor. States:
 * loading → menu → playing ⇄ paused. Everything visual is rebuilt per map
 * seed; the GLB asset and the renderer persist across restarts.
 */
import * as THREE from 'three';
import { DriftPhysics } from '../vehicle/DriftPhysics.js';
import { Car } from '../vehicle/Car.js';
import { SmokeSystem, SkidMarks } from '../vehicle/Fx.js';
import { DriftMap } from '../world/DriftMap.js';
import { Environment } from '../world/Environment.js';
import { DriftScore } from './DriftScore.js';
import { CameraRig } from './CameraRig.js';
import { Input } from '../core/Input.js';
import { DriftAudio } from '../core/Audio.js';
import { Settings } from '../core/Settings.js';

const PHYS_STEP = 1 / 120;

export class Game {
  constructor({ container }) {
    this.container = container;
    this.state = 'booting';

    // ---- renderer -------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 1800);

    this.input = new Input();
    this.audio = new DriftAudio();
    this.env = new Environment(this.scene);
    this.rig = new CameraRig(this.camera);

    this.phys = new DriftPhysics();
    this.map = null;
    this.car = null;
    this.score = null;
    this.smoke = null;
    this.skids = null;
    this.seed = null;

    // fx throttles
    this._smokeAcc = 0;
    this._emitRate = 0;
    this._hudAcc = 0;

    // quality governor
    this._fpsEMA = 60;
    this._playTime = 0;
    this._quality = 2;

    this._accum = 0;
    this._clock = new THREE.Clock();
    this._raf = null;
    this._running = false;

    // ui hooks (assigned by main.js)
    this.ui = {};

    window.addEventListener('resize', () => this._resize());
    this._resize();
  }

  // ------------------------------------------------------------ lifecycle

  /** Load the car asset once, then show the menu. */
  async boot(onProgress) {
    this.car = new Car();
    await this.car.build(onProgress);
    this.scene.add(this.car.group);
    this.smoke = new SmokeSystem(this.scene);
    this.skids = new SkidMarks(this.scene);
    this.score = new DriftScore(this.audio, (type, value) => this._onScoreEvent(type, value));
    this.state = 'menu';
    this._startLoop();
  }

  /** Build a map from a seed and drop the car on the start line. */
  startMap(seed) {
    this.seed = String(seed);
    if (this.map) {
      this.scene.remove(this.map.group);
      this.map.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (o.material.map) o.material.map.dispose();
          o.material.dispose();
        }
      });
    }
    this.map = new DriftMap(this.seed);
    this.scene.add(this.map.group);

    const pose = this.map.spawnPose();
    this.phys.teleport(pose.x, pose.z, pose.heading);
    this.score.reset();
    this.skids.clear();
    this.rig._init = false;
    this.state = 'playing';
    this._playTime = 0;
    this.ui.hud?.show();
    this.ui.hud?.setSeed(this.seed, Settings.bestFor(this.seed));
    this.ui.menu?.hideAll();
  }

  pause() {
    if (this.state === 'playing') {
      this.state = 'paused';
      this.ui.menu?.showPause(this.score.total, this.seed);
      this.ui.hud?.hide();
    }
  }

  resume() {
    if (this.state === 'paused') {
      this.state = 'playing';
      this.ui.menu?.hideAll();
      this.ui.hud?.show();
    }
  }

  restart() {
    if (this.seed) this.startMap(this.seed);
  }

  /** Reset the car on the track (chain lost). */
  resetCar() {
    if (this.state !== 'playing') return;
    const pose = this.map.resetPose(this.phys.x, this.phys.z);
    this.phys.teleport(pose.x, pose.z, pose.heading);
    this.score.hardReset();
    this.skids.clear();
    this.haptic(30);
  }

  // ------------------------------------------------------------------ loop

  _startLoop() {
    if (this._running) return;
    this._running = true;
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      this._frame();
    };
    tick();
  }

  _frame() {
    const dt = Math.min(this._clock.getDelta(), 0.05);
    const playing = this.state === 'playing';

    if (this.state === 'menu') {
      // idle orbit showcase while the menu is up
      this._menuTime = (this._menuTime || 0) + dt;
      const t = this._menuTime * 0.12;
      const r = 9;
      this.camera.position.set(Math.sin(t) * r, 2.6 + Math.sin(t * 0.7) * 0.6, Math.cos(t) * r);
      this.camera.lookAt(0, 0.7, 0);
      this.env.update(dt, this.camera.position);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    if (playing) {
      this.input.update(dt);
      if (this.input.consumeReset()) this.resetCar();
      if (this.input.consumeCamera()) this.rig.cycleMode();

      // fixed-step physics with wall collisions
      this._accum += dt;
      let crashed = 0;
      let guard = 0;
      while (this._accum >= PHYS_STEP && guard++ < 6) {
        this._accum -= PHYS_STEP;
        this.phys.step(PHYS_STEP, {
          steer: this.input.steer,
          throttle: this.input.throttle,
          brake: this.input.brake,
          handbrake: this.input.handbrake,
          driftAssist: Settings.get('driftAssist'),
        });
        const impact = this.map.resolveCollision(this.phys, this.map._trackIdx);
        if (impact > 2) {
          crashed = impact;
          this.audio.thud(Math.min(1, impact / 8));
          this.haptic(60);
        }
      }

      const idx = this.map.nearestIdx(this.phys.x, this.phys.z, this.map._trackIdx);
      const zoneMult = this.map.zoneMultAt(this.phys.x, this.phys.z, idx);
      const sc = this.score.update(this.phys, zoneMult, crashed > 4);

      this.car.update(this.phys, dt, this.input.steer, this.input.brake);
      this._updateFx(dt);
      this.rig.update(dt, this.phys, crashed);
      this.env.update(dt, this.phys);

      this.audio.update({
        speedNorm: Math.min(1, this.phys.speed / 45),
        throttle: this.input.throttle,
        slip: Math.min(1, Math.abs(this.phys.beta) * 1.6),
        drifting: this.phys.drifting,
      });

      // HUD at ~15 Hz
      this._hudAcc += dt;
      if (this._hudAcc > 0.066) {
        this._hudAcc = 0;
        this.ui.hud?.update(this.phys, sc, zoneMult);
      }

      // quality governor (after 6 s of play, drop tiers if struggling)
      this._playTime += dt;
      this._fpsEMA += (1 / Math.max(dt, 1e-3) - this._fpsEMA) * 0.02;
      if (Settings.get('quality') === 'auto' && this._playTime > 6) {
        if (this._fpsEMA < 40 && this._quality > 0) this._applyQuality(this._quality - 1);
      }
    } else {
      this.audio.update({ speedNorm: 0, throttle: 0, slip: 0, drifting: false });
    }

    this.smoke?.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  // -------------------------------------------------------------------- fx

  _updateFx(dt) {
    const p = this.phys;
    const slip = Math.min(1, Math.abs(p.beta) * 1.8);
    const onAsphalt = true; // whole park is tarmac

    // smoke: rate scales with slip × speed
    const want = p.drifting ? (6 + slip * 26) * Math.min(1, p.speed / 12) : 0;
    this._emitRate += (want - this._emitRate) * Math.min(1, dt * 6);
    this._smokeAcc += this._emitRate * dt;
    if (this._smokeAcc >= 1) {
      this.car.rearWheelWorld(_wl, _wr);
      while (this._smokeAcc >= 1) {
        this._smokeAcc -= 1;
        const src = Math.random() < 0.5 ? _wl : _wr;
        this.smoke.emit(
          src.x + (Math.random() - 0.5) * 0.3, 0.18, src.z + (Math.random() - 0.5) * 0.3,
          p.vxW * 0.22 + (Math.random() - 0.5), 0, Math.min(1, slip),
        );
      }
    }

    // skid marks
    if (p.drifting && onAsphalt) {
      this.car.rearWheelWorld(_wl, _wr);
      this.skids.drop(0, _wl.x, _wl.z, p.vxW, p.vzW);
      this.skids.drop(1, _wr.x, _wr.z, p.vxW, p.vzW);
    } else {
      this.skids.lift(0);
      this.skids.lift(1);
    }
  }

  // ---------------------------------------------------------------- events

  _onScoreEvent(type, value) {
    switch (type) {
      case 'driftStart':
        this.haptic(18);
        break;
      case 'combo':
        this.haptic(24);
        this.audio.chime(Math.min(4, value));
        break;
      case 'bank': {
        this.haptic([20, 40, 30]);
        this.audio.chime(4);
        const best = Settings.recordBest(this.seed, this.score.total);
        this.ui.hud?.popup('bank', value, best);
        this.ui.hud?.setBest(this.score.total);
        break;
      }
      case 'crash':
        this.ui.hud?.popup('crash');
        break;
      case 'spinout':
        this.ui.hud?.popup('spinout');
        break;
    }
  }

  haptic(pattern) {
    if (!Settings.get('haptics')) return;
    try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
  }

  _applyQuality(level) {
    this._quality = level;
    if (level === 1) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
      this.env.disableShadows();
      this.ui.hud?.toast('Performance mode');
    } else if (level === 0) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1) * 0.8);
      this.env.disableShadows();
      this.scene.fog.far = 430;
      this.ui.hud?.toast('Battery saver mode');
    }
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.rig.aspectChanged(this.camera.aspect);
  }
}

const _wl = { x: 0, z: 0 };
const _wr = { x: 0, z: 0 };
