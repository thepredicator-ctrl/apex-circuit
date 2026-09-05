/**
 * Game — engine orchestrator. Owns the renderer, scene graph, fixed-step
 * physics loop, transmission, camera rig, journey state, settings, quality
 * application and all subsystem wiring.
 *
 * APEX ROADS: no laps, no countdown — an endless procedural drive. The
 * World streams road chunks around the car as it travels; the journey HUD
 * tracks distance, time and altitude.
 */

import * as THREE from 'three';
import { World } from './World.js';
import { Environment } from './Environment.js';
import { Car } from './Car.js';
import { VehiclePhysics } from './Physics.js';
import { Transmission } from './Transmission.js';
import { CameraRig } from './Camera.js';
import { Input } from './Input.js';
import { GameAudio } from './Audio.js';
import { Effects, SpeedLines } from './Effects.js';
import { Settings } from './Settings.js';
import { HUD } from '../ui/HUD.js';
import { TouchControls } from '../ui/TouchControls.js';
import { QUALITY, CAR } from './Constants.js';

const PHYS_STEP = 1 / 120;

export class Game {
  constructor({ container, onReady, onError }) {
    this.container = container;
    this.onReady = onReady;
    this.onError = onError;

    this.state = 'booting'; // booting | loading | idle | driving
    this._raf = null;
    this._clock = new THREE.Clock();
    this._accum = 0;
    this._idleAngle = 0;
    this._emitAcc = 0;
    this.particleFactor = 1;
    this.onProgress = null;
    this._cameraReapplied = false;

    // journey state
    this.journey = {
      distance: 0,        // meters driven
      time: 0,            // seconds since start
      altitude: 0,        // current road elevation (m)
      seed: 0
    };
    this._milestone = 0;  // every 5 km chime
  }

  // ------------------------------------------------------------------ setup
  init() {
    const isMobile =
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
      (navigator.maxTouchPoints || 0) > 0;
    this.isMobile = isMobile;
    this.isIPad = (
      /ipad/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 0)
    );
    this.isIPhone = /iphone/i.test(navigator.userAgent);
    this.isIOS = this.isIPad || this.isIPhone;

    // ---- settings ---------------------------------------------------------
    this.settings = new Settings();

    // ---- renderer --------------------------------------------------------
    const isPhone = this.isMobile && !this.isIPad;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false
    });
    const dprCap = isPhone ? 1.4 : (this.isIPad ? 1.6 : 2.0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.container.appendChild(this.renderer.domElement);

    // ---- scene -----------------------------------------------------------
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      62, window.innerWidth / window.innerHeight, 0.3, 2600
    );
    this.camera.position.set(0, 12, -20);

    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    // world seed: ?seed= in the URL, else random
    let seed = 1337;
    try {
      const qp = new URLSearchParams(window.location.search).get('seed');
      if (qp && /^\d+$/.test(qp)) seed = parseInt(qp, 10) >>> 0;
      else seed = (Math.random() * 0xffffffff) >>> 0;
    } catch { seed = 1337; }
    this.journey.seed = seed;

    this.track = new World(seed, aniso, this.settings.quality);
    this.scene.add(this.track.group);

    this.environment = new Environment(this.scene, this.renderer, isMobile, this.settings.timeOfDay);
    this._applyExposure(this.settings.timeOfDay);

    // ---- car + physics + transmission --------------------------------------
    this.transmission = new Transmission();
    this.transmission._onShift = (gear, isUp) => this.audio && this.audio.shiftBlip(isUp);

    this.car = new Car(this.track);
    this.scene.add(this.car.group);

    this.phys = new VehiclePhysics(this.track, this.transmission);
    this.phys.placeAt(this.track.startS, 0);

    this.cameraRig = new CameraRig(this.camera);

    this.effects = new Effects(this.scene);
    this.speedLines = new SpeedLines(this.scene);

    // ---- subsystems --------------------------------------------------------
    this.audio = new GameAudio();
    this.input = new Input();

    this.hud = new HUD({
      onRecenter: () => this.recenterCar(),
      onNewRoad: () => this.newRoad(),
      onMuteToggle: () => {
        this.audio.setMuted(!this.audio.muted);
        this.hud.setMuted(this.audio.muted);
      },
      onSettingsChange: (key, value) => this.changeSetting(key, value)
    });

    this.touch = new TouchControls(this.input, {
      onReset: () => this.recenterCar(),
      onGearUp: () => this._shift(1),
      onGearDown: () => this._shift(-1),
      onCamera: () => this.toggleCamera(),
      onTransmission: () => this.toggleTransmission()
    });
    if (this.touch.enabled) this.hud.markTouch();

    this._wireInput();
    this._applyAllSettings();

    // ---- events -------------------------------------------------------------
    window.addEventListener('resize', () => this._onResize());
    window.addEventListener('orientationchange', () => setTimeout(() => this._onResize(), 250));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.audio.started) {
        this.audio.ctx && this.audio.ctx.resume().catch(() => {});
      }
    });

    // ---- debug hooks ----------------------------------------------------------
    window.__game = this;

    this.state = 'loading';
    this._clock.start();
    this._loop();

    this._loadAssets();
  }

  /** Re-apply the persisted camera mode once the car's cockpit anchor is ready. */
  _reapplyCameraWhenReady() {
    if (this._cameraReapplied) return;
    if (!this.car || !this.car.ready || !this.car.cockpitAnchor) return;
    this._cameraReapplied = true;
    this.cameraRig.setMode(this.settings.camera, this.car, this.phys);
    this.car.cockpitMode = this.settings.camera === 'cockpit';
    this.hud.setCockpitMode(this.settings.camera === 'cockpit');
  }

  /** Build everything procedurally — no network assets. */
  async _loadAssets() {
    const progress = (frac, label) => {
      if (this.onProgress) this.onProgress(frac, label);
    };
    try {
      progress(0.05, 'GENERATING WORLD…');
      await this.car.build((t) => progress(0.05 + t * 0.85, 'BUILDING CAR…'));
      progress(1, 'READY');
      this._reapplyCameraWhenReady();
    } catch (err) {
      console.error('[ApexRoads] Setup failed:', err);
      if (this.onError) this.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.state = 'idle';
  }

  _wireInput() {
    this.input.onResetKey = () => {
      if (this.hud.settingsOpen) return;
      if (this.state === 'driving') this.recenterCar();
    };
    this.input.onNewRoadKey = () => {
      if (this.hud.settingsOpen) return;
      if (this.state === 'driving' || this.state === 'idle') this.newRoad();
    };
    this.input.onShiftUp = () => this._shift(1);
    this.input.onShiftDown = () => this._shift(-1);
    this.input.onCameraToggle = () => this.toggleCamera();
    this.input.onTransmissionToggle = () => this.toggleTransmission();
    this.input.onSettingsKey = () => {
      if (this.state === 'driving') this.hud.toggleSettings();
    };
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const q = QUALITY[this.settings.quality] || QUALITY.medium;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.setSize(w, h);
  }

  // ------------------------------------------------------------- settings
  _applyAllSettings() {
    const s = this.settings;
    this.transmission.setMode(s.transmission);
    if (this.car && this.car.cockpitAnchor) {
      this.cameraRig.setMode(s.camera, this.car, this.phys);
    } else {
      this.cameraRig.setMode('chase', this.car, this.phys);
    }
    this.cameraRig.setSmoothing(s.cameraSmoothing);
    this.input.sensitivity = s.steerSensitivity;
    this.audio.setVolumes(s.masterVolume, s.engineVolume);
    this._applyQuality(s.quality);
    this.environment.applyPreset(s.timeOfDay);
    this._applyExposure(s.timeOfDay);
    if (this.car) this.car.setHeadlights(this.environment.headlightsOn);
    this.hud.syncSettings(s.data);
    this.hud.setModes(s.transmission, s.camera);
    this.car.cockpitMode = s.camera === 'cockpit' && this.car.cockpitAnchor;
    this.hud.setCockpitMode(s.camera === 'cockpit');
    if (this.car.ready) this.car.setPaint(s.paint);
  }

  _applyExposure(tod) {
    const p = { dawn: 1.12, day: 1.1, dusk: 1.15, night: 1.18 }[tod] || 1.1;
    this.renderer.toneMappingExposure = p;
  }

  changeSetting(key, value) {
    this.settings.set(key, value);
    switch (key) {
      case 'transmission':
        this.transmission.setMode(value);
        this.hud.setModes(value, this.settings.camera);
        break;
      case 'camera':
        this.cameraRig.setMode(value, this.car, this.phys);
        this.car.cockpitMode = value === 'cockpit';
        this.hud.setCockpitMode(value === 'cockpit');
        this.hud.setModes(this.settings.transmission, value);
        break;
      case 'quality':
        this._applyQuality(value);
        this.hud.showLapToast('GRAPHICS: ' + (QUALITY[value]?.label || value) + ' — TAKES EFFECT ON NEW ROAD');
        break;
      case 'timeOfDay':
        this.environment.applyPreset(value);
        this._applyExposure(value);
        this.car.setHeadlights(this.environment.headlightsOn);
        break;
      case 'masterVolume':
      case 'engineVolume':
        this.audio.setVolumes(this.settings.masterVolume, this.settings.engineVolume);
        break;
      case 'steerSensitivity':
        this.input.sensitivity = value;
        break;
      case 'cameraSmoothing':
        this.cameraRig.setSmoothing(value);
        break;
      case 'paint':
        if (this.car.ready) this.car.setPaint(value);
        break;
    }
    this.hud.syncSettings(this.settings.data);
  }

  _applyQuality(name) {
    const q = QUALITY[name] || QUALITY.medium;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    const sun = this.environment.sun;
    if (q.shadows) {
      if (sun.shadow.mapSize.x !== q.shadowMapSize) {
        sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
        if (sun.shadow.map) {
          sun.shadow.map.dispose();
          sun.shadow.map = null;
        }
      }
    }
    // scale fog range with the quality preset (keeps the horizon believable
    // on low-end devices without revealing the streaming edge)
    const tod = this.settings.timeOfDay;
    const base = { dawn: 950, day: 1250, dusk: 850, night: 800 }[tod] || 1250;
    this.scene.fog.far = Math.round(base * q.fogScale);
    this.particleFactor = q.particles;
    this.scene.traverse((o) => {
      if (o.isMesh && o.material) o.material.needsUpdate = true;
    });
  }

  // ------------------------------------------------- transmission / camera
  _shift(dir) {
    if (this.hud.settingsOpen) return;
    if (this.transmission.mode !== 'manual') {
      if (this.state === 'driving') {
        this.changeSetting('transmission', 'manual');
        this.hud.showLapToast('MANUAL MODE — Q/E TO SHIFT');
      }
      return;
    }
    const ok = this.transmission.shift(dir);
    if (!ok) this.audio.beep(160, 0.06, 0.06, 'square');
  }

  toggleCamera() {
    if (this.hud.settingsOpen) return;
    const cur = this.settings.camera;
    let next;
    if (cur === 'chase') next = 'hood';
    else if (cur === 'hood') next = 'cockpit';
    else next = 'chase';
    this.changeSetting('camera', next);
    const label = next === 'chase' ? 'CHASE VIEW'
      : next === 'hood' ? 'HOOD VIEW'
        : 'COCKPIT VIEW';
    this.hud.showLapToast(label);
  }

  toggleTransmission() {
    if (this.hud.settingsOpen) return;
    const next = this.settings.transmission === 'auto' ? 'manual' : 'auto';
    this.changeSetting('transmission', next);
    this.hud.showLapToast(next === 'manual' ? 'MANUAL (Q/E)' : 'AUTOMATIC');
  }

  // ------------------------------------------------------------- journey flow
  /** called from the start screen (user gesture — unlocks audio) */
  startDriving() {
    if (this.state === 'loading' || !this.car.ready) return;
    this.audio.init();
    this.audio.setVolumes(this.settings.masterVolume, this.settings.engineVolume);
    this.hud.show();
    this._beginDrive();
  }

  _beginDrive() {
    this.hud.toggleSettings(false);
    this.input.setEnabled(true);
    this.phys.placeAt(this.track.startS, 0);
    this.journey.distance = 0;
    this.journey.time = 0;
    this._milestone = 0;
    this.state = 'driving';
    this.cameraRig.snap(this.car, this.phys);
  }

  /** drop the car back onto the road ahead of the current position */
  recenterCar() {
    if (this.state !== 'driving') return;
    const s = this.phys.s + 15;
    this.phys.placeAt(s, 0);
    this.cameraRig.snap(this.car, this.phys);
    this.hud.showLapToast('BACK ON THE ROAD');
  }

  /** tear the world down and generate a fresh road from a new seed */
  newRoad() {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.journey.seed = seed;
    this.track.regenerate(seed);
    this._beginDrive();
    this.cameraRig.snap(this.car, this.phys);
    this.hud.showLapToast('NEW ROAD — SEED ' + seed);
  }

  // -------------------------------------------------------------- main loop
  _loop = () => {
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.min(this._clock.getDelta(), 0.1);
    if (dt <= 0) return;

    const controlsActive = this.state === 'driving';

    this.input.update(dt);

    // fixed-step physics
    if (!this._simLock) {
      this._accum += dt;
      let steps = 0;
      while (this._accum >= PHYS_STEP && steps < 8) {
        this.phys.update(PHYS_STEP, this.input, controlsActive);
        this._accum -= PHYS_STEP;
        steps++;
      }
      if (steps === 8) this._accum = 0;
    }

    // journey stats
    if (this.state === 'driving') {
      const ds = Math.abs(this.phys.vF) * dt;
      this.journey.distance += ds;
      this.journey.time += dt;
      this.journey.altitude = this.phys.surfaceY;
      const km = this.journey.distance / 1000;
      if (km >= this._milestone + 5) {
        this._milestone = Math.floor(km / 5) * 5;
        this.audio.lapDing();
        this.hud.showLapToast(`${this._milestone} KM DRIVEN`);
      }
    }

    // world streaming (road chunks + scenery around the car)
    this.track.update(this.phys.position, this.particleFactor >= 0.6 ? 1 : 0.5, dt);

    // visuals
    this.car.updateVisual(dt, this.phys, this.transmission);
    this._updateEffects(dt);

    // camera
    if (this.state === 'idle' || this.state === 'loading') {
      this._updateIdleCamera(dt);
    } else {
      this.cameraRig.update(dt, this.phys, this.input.state, this.car);
    }

    this.environment.update(this.phys.position, this.camera, dt);

    this.speedLines.update(
      dt, this.camera, this.phys.velocity,
      Math.min(1, Math.abs(this.phys.vF) / CAR.maxSpeed)
    );

    this.audio.update(dt, {
      rpm: this.transmission.rpm,
      rpmNorm: this.transmission.rpmNorm,
      throttle: this.phys.throttleOut,
      speedN: Math.min(1, Math.abs(this.phys.vF) / CAR.maxSpeed),
      slip: this.phys.slip,
      onGrass: this.phys.onGrass,
      onCurb: this.phys.onCurb,
      reversing: this.phys.reversing,
      launching: this.transmission.launching,
      limiter: this.transmission.limiterCut
    });

    this.hud.update(this.phys, this.journey, this.transmission);

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
    const spinning = phys.wheelspin && speed < 30;

    if (!(drifting || offroad || spinning)) {
      this.effects.update(dt);
      return;
    }

    this._emitAcc += dt * this.particleFactor;
    const interval = 0.03;
    if (this._emitAcc > interval) {
      this._emitAcc = 0;
      const fwd = new THREE.Vector3(Math.sin(phys.heading), 0, Math.cos(phys.heading));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const rear = phys.position.clone().addScaledVector(fwd, -1.4);
      const p1 = rear.clone().addScaledVector(right, 0.8);
      const p2 = rear.clone().addScaledVector(right, -0.8);
      p1.y = phys.surfaceY + 0.22;
      p2.y = phys.surfaceY + 0.22;
      const color = offroad ? 0x9c8a5e : 0xd9d9d9;
      const size = spinning ? 1.3 : 1;
      this.effects.emit(p1, phys.velocity, size, color);
      this.effects.emit(p2, phys.velocity, size, color);
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
    this.camera.position.set(x, c.y + 7.5, z);
    this.camera.lookAt(c.x, c.y + 1.0, c.z);
  }

  // --------------------------------------------------------------- testing
  /**
   * Test hook: run the fixed-step physics loop synchronously for `seconds`
   * with a given input vector — deterministic, used by automated checks.
   */
  debugSim(seconds, { throttle = 0, brake = 0, steer = 0, handbrake = false } = {}) {
    const inputProxy = {
      state: { throttle, brake, steer, handbrake }
    };
    const steps = Math.round(seconds / PHYS_STEP);
    this._simLock = true;
    for (let i = 0; i < steps; i++) {
      this.phys.update(PHYS_STEP, inputProxy, true);
    }
    this._simLock = false;
    return {
      speedKmh: Math.round(this.phys.speedKmh),
      vF: +this.phys.vF.toFixed(2),
      gear: this.transmission.gearLabel,
      rpm: Math.round(this.transmission.rpm),
      slip: +this.phys.slip.toFixed(2),
      aLongS: +this.phys.aLongS.toFixed(2),
      s: Math.round(this.phys.s),
      lateral: +this.phys.lateral.toFixed(1),
      surfaceY: +this.phys.surfaceY.toFixed(2),
      yawRate: +this.phys.yawRate.toFixed(3)
    };
  }

  /**
   * Test hook: drive the endless road with a simple lookahead autopilot to
   * exercise the full physics + streaming stack.
   */
  debugAutopilot(seconds) {
    const p = this.phys;
    const t = this.track;
    let maxKmh = 0, offroadSteps = 0;
    const steps = Math.round(seconds / PHYS_STEP);
    this._simLock = true;
    for (let i = 0; i < steps; i++) {
      // target speed from upcoming curvature (grip-limited)
      let maxCurv = 0;
      const idxNow = p.sampleIdx;
      for (let k = 4; k <= 90; k += 4) {
        const si = idxNow + k;
        const smp = t.samples[Math.min(si, t.samples.length - 1)];
        if (smp) maxCurv = Math.max(maxCurv, Math.abs(smp.curv));
      }
      const vT = Math.min(52, Math.sqrt(0.82 * 9.81 / Math.max(maxCurv, 0.0004)));
      const lookM = Math.min(55, Math.max(8, p.vF * 1.35));
      const ahead = t.pointAt(p.s + lookM);
      const dx = ahead.x - p.position.x, dz = ahead.z - p.position.z;
      const desired = Math.atan2(dx, dz);
      let err = desired - p.heading;
      while (err > Math.PI) err -= 2 * Math.PI;
      while (err < -Math.PI) err += 2 * Math.PI;
      const steer = Math.max(-1, Math.min(1, -err * 2.6));
      const throttle = p.vF < vT ? 1 : 0;
      const brake = p.vF > vT * 1.1 ? Math.min(1, (p.vF - vT) * 0.25) : 0;
      p.update(PHYS_STEP, { state: { throttle, brake, steer, handbrake: false } }, true);
      if (Math.abs(p.lateral) > t.roadHalfWidth) offroadSteps++;
      maxKmh = Math.max(maxKmh, p.speedKmh);
    }
    this._simLock = false;
    return {
      maxKmh: Math.round(maxKmh),
      offroadSteps,
      s: Math.round(p.s),
      lateral: +p.lateral.toFixed(1),
      kmh: Math.round(p.speedKmh)
    };
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this.renderer.dispose();
  }
}
