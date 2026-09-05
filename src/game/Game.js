/**
 * Game — engine orchestrator for APEX ROADS: OPEN WORLD.
 *
 * Owns the renderer, scene graph, fixed-step physics, transmission, camera
 * rig, world streaming, day/night clock, weather, traffic, multiplayer,
 * post-processing, journey state and all subsystem wiring.
 *
 * The world is a seeded, deterministic, infinite open world streamed in
 * chunks; everything (terrain, roads, cities, traffic, weather regions,
 * mystery zones) derives from the seed.
 */

import * as THREE from 'three';
import { World } from './World.js';
import { Environment } from './Environment.js';
import { Car } from './vehicle/Car.js';
import { VehiclePhysics } from './vehicle/Physics.js';
import { Transmission } from './vehicle/Transmission.js';
import { CameraRig } from './Camera.js';
import { Input } from './Input.js';
import { GameAudio } from './Audio.js';
import { Effects, SpeedLines } from './Effects.js';
import { Weather } from './weather/Weather.js';
import { Traffic } from './traffic/Traffic.js';
import { Net } from './multiplayer/Net.js';
import { PostFX } from './rendering/PostFX.js';
import { Settings } from './Settings.js';
import { HUD } from '../ui/HUD.js';
import { TouchControls } from '../ui/TouchControls.js';
import { QUALITY, CAR, WORLD as W } from './core/Constants.js';

const PHYS_STEP = 1 / 120;

export class Game {
  constructor({ container, onReady, onError }) {
    this.container = container;
    this.onReady = onReady;
    this.onError = onError;

    this.state = 'booting';   // booting | loading | idle | driving
    this._raf = null;
    this._clock = new THREE.Clock();
    this._accum = 0;
    this._idleAngle = 0;
    this._emitAcc = 0;
    this._skidAcc = 0;
    this.particleFactor = 1;
    this.onProgress = null;
    this._cameraReapplied = false;

    // journey state
    this.journey = {
      distance: 0,
      time: 0,
      altitude: 0,
      seed: 0,
      clock: 0.5          // world clock phase (0..1 of a day)
    };
    this._milestone = 0;
    this._waypoint = null;
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
      62, window.innerWidth / window.innerHeight, 0.3, 5200
    );
    this.camera.position.set(0, 12, -20);

    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    // ---- world seed: ?seed= in the URL, else random ----------------------
    let seed = 1337;
    try {
      const qp = new URLSearchParams(window.location.search).get('seed');
      if (qp && /^\d+$/.test(qp)) seed = parseInt(qp, 10) >>> 0;
      else seed = (Math.random() * 0xffffffff) >>> 0;
    } catch { seed = 1337; }
    this.journey.seed = seed;
    this.journey.clock = this.settings.dayStart !== undefined ? this.settings.dayStart : 0.42;

    // ---- world ------------------------------------------------------------
    this.world = new World(seed, aniso, this.settings.quality);
    this.track = this.world;                 // legacy alias
    this.scene.add(this.world.group);

    // ---- atmosphere ---------------------------------------------------------
    this.environment = new Environment(this.scene, this.renderer, isMobile);
    this.weather = new Weather(this.scene, isMobile, seed);
    this.weather.onThunder = () => {
      this.audio && this.audio.beep(70, 0.5, 0.12, 'sawtooth');
    };

    // ---- car + physics + transmission --------------------------------------
    this.transmission = new Transmission();
    this.transmission._onShift = (gear, isUp) => this.audio && this.audio.shiftBlip(isUp);

    this.car = new Car(this.world);
    this.scene.add(this.car.group);

    this.phys = new VehiclePhysics(this.world, this.transmission);
    const sp = this.world.spawn();
    this.phys.placeAtWorld(sp.x, sp.z, sp.heading);

    this.world.chunks.prime(this.phys.position.x, this.phys.position.z);

    this.cameraRig = new CameraRig(this.camera);
    this.effects = new Effects(this.scene);
    this.speedLines = new SpeedLines(this.scene);

    // ---- postfx ---------------------------------------------------------------
    this.postfx = new PostFX(this.renderer, this.scene, this.camera,
      !isMobile && this.settings.bloom);

    // ---- subsystems --------------------------------------------------------
    this.audio = new GameAudio();
    this.input = new Input();
    this.traffic = new Traffic(this.scene, this.world, isMobile);
    this.net = new Net(this.scene);

    this.hud = new HUD({
      onRecenter: () => this.recenterCar(),
      onNewRoad: () => this.newWorld(),
      onMuteToggle: () => {
        this.audio.setMuted(!this.audio.muted);
        this.hud.setMuted(this.audio.muted);
      },
      onSettingsChange: (key, value) => this.changeSetting(key, value),
      onSetWaypoint: (wx, wz) => this.setWaypoint(wx, wz),
      onClearWaypoint: () => this.clearWaypoint(),
      onTeleport: (wx, wz) => this.teleportTo(wx, wz)
    });

    this.touch = new TouchControls(this.input, {
      onReset: () => this.recenterCar(),
      onGearUp: () => this._shift(1),
      onGearDown: () => this._shift(-1),
      onCamera: () => this.toggleCamera(),
      onTransmission: () => this.toggleTransmission()
    });
    if (this.touch.enabled) this.hud.markTouch();

    this.world.mystery.onDiscover = (label) => {
      this.hud.showLapToast('YOU FOUND ' + label);
      this.audio && this.audio.lapDing();
    };

    this._wireInput();
    this._applyAllSettings();

    // ---- events -------------------------------------------------------------
    this._onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      const q = QUALITY[this.settings.quality] || QUALITY.medium;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
      this.renderer.setSize(w, h);
      this.postfx && this.postfx.setSize(w, h, Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    };
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', () => setTimeout(() => this._onResize(), 250));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.audio.started) {
        this.audio.ctx && this.audio.ctx.resume().catch(() => {});
      }
    });

    window.__game = this;

    this.state = 'loading';
    this._clock.start();
    this._loop();

    this._loadAssets();
  }

  _reapplyCameraWhenReady() {
    if (this._cameraReapplied) return;
    if (!this.car || !this.car.ready || !this.car.cockpitAnchor) return;
    this._cameraReapplied = true;
    this.cameraRig.setMode(this.settings.camera, this.car, this.phys);
    this.car.cockpitMode = this.settings.camera === 'cockpit';
    this.hud.setCockpitMode(this.settings.camera === 'cockpit');
  }

  /** Load the GLB car + prime streaming */
  async _loadAssets() {
    const progress = (frac, label) => {
      if (this.onProgress) this.onProgress(frac, label);
    };
    try {
      progress(0.05, 'LOADING CAR…');
      await this.car.build((t) => progress(0.05 + t * 0.8, 'LOADING CAR…'));
      this.car.setPaint(this.settings.paint);
      progress(0.9, 'STREAMING WORLD…');
      // let a few frames of chunk streaming happen before revealing
      await new Promise((r) => setTimeout(r, 120));
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
      if (this.hud.settingsOpen || this.hud.mapOpen) return;
      if (this.state === 'driving') this.recenterCar();
    };
    this.input.onNewRoadKey = () => {
      if (this.hud.settingsOpen || this.hud.mapOpen) return;
      if (this.state === 'driving' || this.state === 'idle') this.newWorld();
    };
    this.input.onShiftUp = () => this._shift(1);
    this.input.onShiftDown = () => this._shift(-1);
    this.input.onCameraToggle = () => this.toggleCamera();
    this.input.onTransmissionToggle = () => this.toggleTransmission();
    this.input.onSettingsKey = () => {
      if (this.state === 'driving') this.hud.toggleSettings();
    };
    this.input.onMapKey = () => {
      if (this.state === 'driving' || this.state === 'idle') this.hud.toggleMap();
    };
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
    if (this.car && this.car.ready) this.car.setPaint(s.paint);
    this.traffic.enabled = !!s.traffic;
    if (s.multiplayer) {
      this.net.connect(this.journey.seed, s.playerName);
    }
    this.hud.syncSettings(s.data);
    this.hud.setModes(s.transmission, s.camera);
    this.car.cockpitMode = s.camera === 'cockpit' && this.car.cockpitAnchor;
    this.hud.setCockpitMode(s.camera === 'cockpit');
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
    this.world.setQuality(name);
    this.particleFactor = q.particles;
    this.postfx && this.postfx.setEnabled(!this.isMobile && this.settings.bloom && q.bloom);
    this._onResize && this._onResize();
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
        this.hud.showLapToast('GRAPHICS: ' + (QUALITY[value]?.label || value));
        break;
      case 'paint':
        if (this.car.ready) this.car.setPaint(value);
        break;
      case 'traffic':
        this.traffic.enabled = !!value;
        break;
      case 'bloom':
        this.postfx && this.postfx.setEnabled(!this.isMobile && !!value &&
          (QUALITY[this.settings.quality] || QUALITY.medium).bloom);
        break;
      case 'multiplayer':
        if (value) this.net.connect(this.journey.seed, this.settings.playerName);
        else this.net.disconnect();
        break;
      case 'playerName':
        if (this.settings.multiplayer) this.net.connect(this.journey.seed, value);
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
    }
    this.hud.syncSettings(this.settings.data);
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

  // ------------------------------------------------------------- flow
  startDriving() {
    if (this.state === 'loading' || !this.car.ready) return;
    this.audio.init();
    this.audio.setVolumes(this.settings.masterVolume, this.settings.engineVolume);
    this.hud.show();
    this._beginDrive();
  }

  _beginDrive() {
    this.hud.toggleSettings(false);
    this.hud.toggleMap(false);
    this.input.setEnabled(true);
    this.journey.distance = 0;
    this.journey.time = 0;
    this._milestone = 0;
    this.state = 'driving';
    this.cameraRig.snap(this.car, this.phys);
  }

  recenterCar() {
    if (this.state !== 'driving') return;
    // snap back onto the nearest road, facing along it
    const q = this.world.locate(this.phys.position.x, this.phys.position.z);
    if (q) {
      const px = q.route && q.route.kind === 'col'
        ? (q.route ? this.world.network.coordAt(q.route, this.phys.position.z) : 0)
        : this.phys.position.x;
      const targetX = this.phys.position.x - q.rightX * q.lateral;
      const targetZ = this.phys.position.z - q.rightZ * q.lateral;
      const heading = Math.atan2(q.tx, q.tz);
      this.phys.placeAtWorld(targetX, targetZ, heading);
    } else {
      const sp = this.world.spawn();
      this.phys.placeAtWorld(sp.x, sp.z, sp.heading);
    }
    this.cameraRig.snap(this.car, this.phys);
    this.hud.showLapToast('BACK ON THE ROAD');
  }

  newWorld() {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.journey.seed = seed;
    this.world.regenerate(seed);
    const sp = this.world.spawn();
    this.phys.placeAtWorld(sp.x, sp.z, sp.heading);
    this.world.chunks.prime(this.phys.position.x, this.phys.position.z);
    this._beginDrive();
    this.cameraRig.snap(this.car, this.phys);
    this.hud.showLapToast('NEW WORLD — SEED ' + seed);
    if (this.net.connected) this.net.connect(seed, this.settings.playerName);
  }

  setWaypoint(x, z) {
    this._waypoint = { x, z };
    this.hud.showLapToast('WAYPOINT SET');
  }

  clearWaypoint() {
    this._waypoint = null;
  }

  teleportTo(x, z) {
    if (this.state !== 'driving' && this.state !== 'idle') return;
    const y = this.world.groundAt(x, z).y;
    this.phys.placeAtWorld(x, z, this.phys.heading);
    this.cameraRig.snap(this.car, this.phys);
    this.hud.showLapToast('TELEPORTED');
  }

  // -------------------------------------------------------------- main loop
  _loop = () => {
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.min(this._clock.getDelta(), 0.1);
    if (dt <= 0) return;

    const controlsActive = this.state === 'driving' && !this.hud.mapOpen;

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

    // world clock + journey stats
    const dayLen = this.settings.dayLength || 1200;
    if (this.settings.dayCycle) {
      this.journey.clock = (this.journey.clock + dt / dayLen) % 1;
    }
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

    // weather region (throttled)
    this._regionAcc = (this._regionAcc || 0) + dt;
    if (this._regionAcc > 2) {
      this._regionAcc = 0;
      const region = this.world.terrain.region(this.phys.position.x, this.phys.position.z);
      this.weather.setRegion(region);
    }
    if (this.settings.weather) {
      this.weather.update(dt, this.camera.position, 0, this.environment);
      this.phys.gripMul = this.weather.gripMul;
      if ((this._wetAcc = (this._wetAcc || 0) + dt) > 0.5) {
        this._wetAcc = 0;
        this.weather.applyRoadWetness(this.world.scenery);
      }
    }

    // atmosphere
    this.environment.applyAtmosphere(this.journey.clock, this.weather);
    this.renderer.toneMappingExposure = this.environment.exposure;
    this.car.setHeadlights(this.environment.headlightsOn);
    this.world.scenery.matBuilding.emissiveIntensity =
      this.environment.sunElevation < 0.1 ? 0.9 : 0.0;
    this.world.scenery.matLampGlow.color.setHex(
      this.environment.sunElevation < 0.12 ? 0xffd9a0 : 0x777168
    );
    this.world.scenery.matBeacon.visible = true;

    // world streaming — budget grows when frames are slow (weak GPUs) so
    // the queue still drains, and stays small at high frame rates
    const streamBudget = dt > 0.2 ? 22 : 4.5;
    this.world.update(this.phys.position, dt, streamBudget);
    if (this.state === 'driving') {
      this.world.mystery.checkDiscovery(this.phys.position.x, this.phys.position.z);
    }

    // visuals
    this.car.updateVisual(dt, this.phys, this.transmission);
    this._updateEffects(dt);

    // traffic
    this.traffic.update(dt, this.phys.position, this.phys.velocity, this.environment.sunElevation < 0.12);

    // multiplayer
    this.net.update(dt, this.phys, this.car.group);

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
      onGrass: this.phys.onGrass || this.phys.onDirt,
      onCurb: this.phys.onCurb,
      reversing: this.phys.reversing,
      launching: this.transmission.launching,
      limiter: this.transmission.limiterCut
    });

    // HUD (throttled canvas work happens inside)
    this.hud.update(this.phys, this.journey, this.transmission, {
      world: this.world,
      weather: this.weather,
      trafficVehicles: this.traffic.vehicles,
      net: this.net,
      waypoint: this._waypoint,
      chunksPending: this.world.chunks.pendingCount
    });

    this.postfx.render(this.renderer, this.scene, this.camera);

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
    const offroad = (phys.onGrass || phys.onDirt) && speed > 8;
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
    const r = 12;
    const x = c.x + Math.cos(this._idleAngle) * r;
    const z = c.z + Math.sin(this._idleAngle) * r;
    this.camera.position.set(x, c.y + 4.2, z);
    this.camera.lookAt(c.x, c.y + 0.9, c.z);
  }

  // --------------------------------------------------------------- testing
  debugSim(seconds, { throttle = 0, brake = 0, steer = 0, handbrake = false } = {}) {
    const inputProxy = { state: { throttle, brake, steer, handbrake } };
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
      surfaceY: +this.phys.surfaceY.toFixed(2),
      yawRate: +this.phys.yawRate.toFixed(3),
      pos: { x: Math.round(this.phys.position.x), z: Math.round(this.phys.position.z) }
    };
  }

  debugAutopilot(seconds) {
    const p = this.phys;
    const w = this.world;
    let maxKmh = 0, offroadSteps = 0;
    const steps = Math.round(seconds / PHYS_STEP);
    this._simLock = true;
    for (let i = 0; i < steps; i++) {
      const fwdX = Math.sin(p.heading), fwdZ = Math.cos(p.heading);
      const look = Math.min(60, Math.max(10, p.vF * 1.4));
      const ahead = w.groundAt(p.position.x + fwdX * look, p.position.z + fwdZ * look);
      const q = w.locate(p.position.x, p.position.z);
      let steer = 0, throttle = 0.7, brake = 0;
      if (q) {
        // aim at the road centerline ahead (steer = -err, matching Input's
        // +1 = right convention against yaw-positive-left headings)
        const aheadQ = w.locate(p.position.x + fwdX * look, p.position.z + fwdZ * look);
        const targetX = p.position.x + fwdX * look + (aheadQ ? -aheadQ.rightX * aheadQ.lateral : 0);
        const targetZ = p.position.z + fwdZ * look + (aheadQ ? -aheadQ.rightZ * aheadQ.lateral : 0);
        const desired = Math.atan2(targetX - p.position.x, targetZ - p.position.z);
        let err = desired - p.heading;
        while (err > Math.PI) err -= 2 * Math.PI;
        while (err < -Math.PI) err += 2 * Math.PI;
        steer = Math.max(-1, Math.min(1, -err * 2.6));
      }
      const vT = q && q.type === 0 ? 40 : 24;
      if (p.vF < vT) throttle = 1;
      if (p.vF > vT * 1.08) { throttle = 0; brake = Math.min(1, (p.vF - vT) * 0.2); }
      p.update(PHYS_STEP, { state: { throttle, brake, steer, handbrake: false } }, true);
      if (!p.onRoad) offroadSteps++;
      maxKmh = Math.max(maxKmh, p.speedKmh);
    }
    this._simLock = false;
    return {
      maxKmh: Math.round(maxKmh),
      offroadSteps,
      kmh: Math.round(p.speedKmh),
      pos: { x: Math.round(p.position.x), z: Math.round(p.position.z) }
    };
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this.renderer.dispose();
  }
}
