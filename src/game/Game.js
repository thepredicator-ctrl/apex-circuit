/**
 * Game — engine orchestrator. Owns the renderer, scene graph, fixed-step
 * physics loop, transmission, camera rig, race state machine, settings,
 * quality application and all subsystem wiring.
 */

import * as THREE from 'three';
import { Track } from './Track.js';
import { Environment } from './Environment.js';
import { Car } from './Car.js';
import { VehiclePhysics } from './Physics.js';
import { Transmission } from './Transmission.js';
import { CameraRig } from './Camera.js';
import { Input } from './Input.js';
import { GameAudio } from './Audio.js';
import { Effects, SpeedLines } from './Effects.js';
import { RaceSystem, formatTime } from './Race.js';
import { Settings } from './Settings.js';
import { HUD } from '../ui/HUD.js';
import { TouchControls } from '../ui/TouchControls.js';
import { AssetManager } from './AssetManager.js';
import { QUALITY, WORLD, CAR } from './Constants.js';
import { loadGLB } from './ModelKit.js';

const PHYS_STEP = 1 / 120;

export class Game {
  constructor({ container, onReady, onError }) {
    this.container = container;
    this.onReady = onReady;
    this.onError = onError;

    this.state = 'booting'; // booting | loading | idle | racing | finished
    this._raf = null;
    this._clock = new THREE.Clock();
    this._accum = 0;
    this._idleAngle = 0;
    this._emitAcc = 0;
    this._lastFrameTime = 0;
    this.particleFactor = 1;
    this._startLightTimer = null;
    this.onProgress = null;   // set by main.js: (frac, label) => ...
    this._cameraReapplied = false;
  }

  // ------------------------------------------------------------------ setup
  init() {
    const isMobile =
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
      (navigator.maxTouchPoints || 0) > 0;
    this.isMobile = isMobile;
    // iPad detection — modern iPadOS reports as MacIntel, so we have to also
    // check for touch support. Used by the renderer + audio + PWA prompts.
    this.isIPad = (
      /ipad/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 0)
    );
    this.isIPhone = /iphone/i.test(navigator.userAgent);
    this.isIOS = this.isIPad || this.isIPhone;

    // ---- settings ---------------------------------------------------------
    this.settings = new Settings();

    // ---- renderer --------------------------------------------------------
    // iOS Safari (iPadOS 16+) can refuse WebGL contexts that demand a real
    // GPU, so we DO NOT set failIfMajorPerformanceCaveat. We also keep
    // antialias off on phones AND on iPads (iPad Pros have 3x screens —
    // 2 Mpix at 1.6 DPR + MSAA is what was killing the framerate).
    const isPhone = this.isMobile && !this.isIPad;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,                      // FX via DPR, not MSAA — much cheaper
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false
    });
    // cap the device pixel ratio aggressively — the previous 1.6+ cap meant
    // rendering 4+ MP per frame on iPad Pro, which the GPU couldn't sustain
    // alongside shadow mapping + the instanced tree forest.
    const dprCap = isPhone ? 1.4 : (this.isIPad ? 1.6 : 2.0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;       // cheaper than PCFSoft
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
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

    // ---- car + physics + transmission --------------------------------------
    this.transmission = new Transmission();
    this.transmission._onShift = (gear, isUp) => this.audio && this.audio.shiftBlip(isUp);

    this.car = new Car(this.track);   // track -> live minimap on the MMI screen
    this.scene.add(this.car.group);

    this.phys = new VehiclePhysics(this.track, this.transmission);
    this.phys.placeAt(this.track.startS, 0);

    this.cameraRig = new CameraRig(this.camera);

    this.effects = new Effects(this.scene);
    this.speedLines = new SpeedLines(this.scene);

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
      },
      onSettingsChange: (key, value) => this.changeSetting(key, value)
    });

    this.touch = new TouchControls(this.input, {
      onReset: () => this.resetCar(),
      onGearUp: () => this._shift(1),
      onGearDown: () => this._shift(-1),
      onCamera: () => this.toggleCamera(),
      onTransmission: () => this.toggleTransmission()
    });
    if (this.touch.enabled) this.hud.markTouch();

    this._wireRaceCallbacks();
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

    // ---- debug hooks (used by automated tests, handy in devtools) ----------
    window.__game = this;

    this.state = 'loading';
    this._clock.start();
    this._loop();

    // ---- async world dressing: GLB car + interior + GLB tree field ----------
    this._loadAssets();
  }

  /** Re-apply the persisted camera mode once the car's cockpit anchor is ready. */
  _reapplyCameraWhenReady() {
    if (this._cameraReapplied) return;
    if (!this.car || !this.car.ready || !this.car.cockpitAnchor) return;
    this._cameraReapplied = true;
    // the persisted setting may be 'cockpit' — safe to apply now that the
    // anchor exists. This must run AFTER buildInterior() resolved.
    this.cameraRig.setMode(this.settings.camera, this.car, this.phys);
    this.car.cockpitMode = this.settings.camera === 'cockpit';
    this.hud.setCockpitMode(this.settings.camera === 'cockpit');
  }

  /** Load the GLB assets (car/track/trees/bushes) and dress the world. */
  async _loadAssets() {
    const progress = (frac, label) => {
      if (this.onProgress) this.onProgress(frac, label);
    };
    try {
      // ---- asset manager (validates + normalizes every asset) ------------
      this.assets = new AssetManager();

      // ---- car (uses the existing car.build which loads porsche_911.glb) ----
      progress(0.02, 'LOADING AUDI RS6…');
      await this.car.build((t) => progress(0.02 + t * 0.60, 'LOADING AUDI RS6…'));

      // ---- track: use the PROCEDURAL track (physics-aligned) -------------
      // The GLB track (drift_race_track_free.glb) has a completely different
      // layout from the procedural Track.js spline that drives physics. Using
      // both at once means the car drives on an invisible road while the
      // visible GLB track is elsewhere — which looks broken.
      //
      // For now we use ONLY the procedural track (which the car physics is
      // aligned with). The GLB track can be integrated later by extracting
      // its centerline and rebuilding the physics spline to match.
      //
      // The procedural track already has: asphalt, curbs, walls, tire stacks,
      // signs, fences, trees, grandstands, start/finish gantry, etc.
      progress(0.35, 'BUILDING TRACK…');

      // ---- environment: trees + bushes (instanced) -----------------------
      progress(0.72, 'PLANTING THE FOREST…');
      try {
        await this.assets.load('tree',
          (t) => progress(0.72 + t * 0.10, 'LOADING TREES…'));
        await this.assets.load('bushSmall',
          (t) => progress(0.82 + t * 0.05, 'LOADING BUSHES…'));
        // bushLarge is 129k tris — only load on desktop, use sparingly
        if (!this.isMobile && !this.isIPad) {
          await this.assets.load('bushLarge',
            (t) => progress(0.87 + t * 0.05, 'LOADING SCENERY…'));
        }
        // build the instanced environment
        this._buildEnvironment();
      } catch (err) {
        console.warn('[ApexCircuit] Environment models failed, using procedural fallback:', err);
        this.track.buildTrees(null, this.isMobile);
      }

      progress(1, 'READY');
    } catch (err) {
      console.error('[ApexCircuit] Asset loading failed:', err);
      // fall back to the procedural forest so the game still works
      this.track.buildTrees(null, this.isMobile);
      if (this.onError) this.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // The car is rigged (with the fallback cockpit anchor since we skipped
    // the Interior GLB). Reapply the persisted camera mode if the user had
    // selected 'cockpit' — it now silently maps to 'hood'.
    this._reapplyCameraWhenReady();
    this.state = 'idle';
  }

  /**
   * Build the instanced environment: trees + bushes scattered around the
   * track using deterministic randomization (same every run). Uses the
   * AssetManager's createInstancedFromGLB to merge each model into a single
   * InstancedMesh for efficient rendering.
   */
  _buildEnvironment() {
    const N = this.track.sampleCount;
    const half = this.track.roadHalfWidth;

    // ---- deterministic PRNG (same seed every run) -----------------------
    let seed = 1337;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    // ---- tree positions: scattered in the grass, avoiding the racing line
    const treePositions = [];
    const treeCount = this.isMobile ? 30 : (this.isIPad ? 50 : 80);
    for (let i = 0; i < treeCount; i++) {
      const s = rnd();  // progress around track
      const idx = Math.floor(s * N) % N;
      const side = rnd() < 0.5 ? 1 : -1;
      const dist = half + 8 + rnd() * 40;  // 8-48 m from centerline
      const x = this.track.px[idx] + this.track.rightX[idx] * dist * side;
      const z = this.track.pz[idx] + this.track.rightZ[idx] * dist * side;
      treePositions.push({ x, z, scale: 0.25 + rnd() * 0.35, rot: rnd() * Math.PI * 2 });
    }

    // ---- bush positions: denser, closer to the track --------------------
    const bushPositions = [];
    const bushCount = this.isMobile ? 40 : (this.isIPad ? 80 : 120);
    for (let i = 0; i < bushCount; i++) {
      const s = rnd();
      const idx = Math.floor(s * N) % N;
      const side = rnd() < 0.5 ? 1 : -1;
      const dist = half + 3 + rnd() * 15;  // 3-18 m from centerline
      const x = this.track.px[idx] + this.track.rightX[idx] * dist * side;
      const z = this.track.pz[idx] + this.track.rightZ[idx] * dist * side;
      bushPositions.push({ x, z, scale: 0.5 + rnd() * 0.8, rot: rnd() * Math.PI * 2 });
    }

    // ---- create instanced meshes -----------------------------------------
    const dummy = new THREE.Object3D();

    // Trees
    if (this.assets.cache.has('tree')) {
      try {
        const { mesh: treeMesh } = this.assets.createInstancedFromGLB('tree', treePositions.length);
        treePositions.forEach((p, i) => {
          const y = this.track.heightAtWorld(p.x, p.z);
          dummy.position.set(p.x, y, p.z);
          dummy.scale.setScalar(p.scale);
          dummy.rotation.y = p.rot;
          dummy.updateMatrix();
          treeMesh.setMatrixAt(i, dummy.matrix);
        });
        treeMesh.count = treePositions.length;
        treeMesh.instanceMatrix.needsUpdate = true;
        // trees are big — cast shadows on desktop only
        treeMesh.castShadow = !this.isMobile;
        this.scene.add(treeMesh);
      } catch (err) {
        console.warn('[ApexCircuit] Tree instancing failed:', err);
      }
    }

    // Small bushes (plant_bush.glb — 756 tris, very light)
    if (this.assets.cache.has('bushSmall')) {
      try {
        const { mesh: bushMesh } = this.assets.createInstancedFromGLB('bushSmall', bushPositions.length);
        bushPositions.forEach((p, i) => {
          const y = this.track.heightAtWorld(p.x, p.z);
          dummy.position.set(p.x, y, p.z);
          dummy.scale.setScalar(p.scale);
          dummy.rotation.y = p.rot;
          dummy.updateMatrix();
          bushMesh.setMatrixAt(i, dummy.matrix);
        });
        bushMesh.count = bushPositions.length;
        bushMesh.instanceMatrix.needsUpdate = true;
        bushMesh.castShadow = false;  // too small for shadows
        bushMesh.receiveShadow = true;
        this.scene.add(bushMesh);
      } catch (err) {
        console.warn('[ApexCircuit] Bush instancing failed:', err);
      }
    }

    // Large bushes (bush.glb — 129k tris, desktop only, few instances)
    if (this.assets.cache.has('bushLarge') && !this.isMobile && !this.isIPad) {
      try {
        const largeCount = 15;
        const largePositions = [];
        for (let i = 0; i < largeCount; i++) {
          const s = rnd();
          const idx = Math.floor(s * N) % N;
          const side = rnd() < 0.5 ? 1 : -1;
          const dist = half + 15 + rnd() * 30;
          const x = this.track.px[idx] + this.track.rightX[idx] * dist * side;
          const z = this.track.pz[idx] + this.track.rightZ[idx] * dist * side;
          largePositions.push({ x, z, scale: 0.8 + rnd() * 0.6, rot: rnd() * Math.PI * 2 });
        }
        const { mesh: largeBushMesh } = this.assets.createInstancedFromGLB('bushLarge', largeCount);
        largePositions.forEach((p, i) => {
          const y = this.track.heightAtWorld(p.x, p.z);
          dummy.position.set(p.x, y, p.z);
          dummy.scale.setScalar(p.scale);
          dummy.rotation.y = p.rot;
          dummy.updateMatrix();
          largeBushMesh.setMatrixAt(i, dummy.matrix);
        });
        largeBushMesh.count = largeCount;
        largeBushMesh.instanceMatrix.needsUpdate = true;
        largeBushMesh.castShadow = true;
        this.scene.add(largeBushMesh);
      } catch (err) {
        console.warn('[ApexCircuit] Large bush instancing failed:', err);
      }
    }

    // Note: we do NOT call this.track.buildTrees() here — the GLB trees/bushes
    // above replace the procedural trees. The procedural trackside details
    // (curbs, walls, tire stacks, signs, fences, rocks) were already built
    // in the Track constructor and remain visible.
  }

  _wireInput() {
    this.input.onResetKey = () => {
      if (this.hud.settingsOpen) return;
      if (this.state === 'racing') this.resetCar();
      else if (this.state === 'finished') this.restartRace();
    };
    this.input.onShiftUp = () => this._shift(1);
    this.input.onShiftDown = () => this._shift(-1);
    this.input.onCameraToggle = () => this.toggleCamera();
    this.input.onTransmissionToggle = () => this.toggleTransmission();
    this.input.onSettingsKey = () => {
      if (this.state === 'racing' || this.state === 'finished') {
        this.hud.toggleSettings();
      }
    };
  }

  _wireRaceCallbacks() {
    this.race.onCountdown = (text) => {
      this.hud.showCountdown(text);
      this.audio.countdownBeep(text);
      // start-light tree: 3 -> two lamps, 2 -> four, 1 -> five, GO -> green
      if (text === '3') this.track.setStartLights(2);
      else if (text === '2') this.track.setStartLights(4);
      else if (text === '1') this.track.setStartLights(5);
      else if (text === 'GO!') {
        this.track.setStartLights(6);
        clearTimeout(this._startLightTimer);
        this._startLightTimer = setTimeout(() => this.track.setStartLights(0), 3000);
      }
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
    const q = QUALITY[this.settings.quality] || QUALITY.medium;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.setSize(w, h);
  }

  // ------------------------------------------------------------- settings
  _applyAllSettings() {
    const s = this.settings;
    this.transmission.setMode(s.transmission);
    // Don't snap into cockpit mode before the car's interior is rigged — on
    // iPad Safari this was the path that read `car.cockpitAnchor` before the
    // GLB finished streaming and threw the runtime crash. The CameraRig is
    // now guarded, but we also defer applying the persisted camera mode
    // until _loadAssets() finishes, then _reapplyCameraWhenReady() runs.
    if (this.car && this.car.cockpitAnchor) {
      this.cameraRig.setMode(s.camera, this.car, this.phys);
    } else {
      // safe placeholder: chase mode; the persisted mode is reapplied later
      this.cameraRig.setMode('chase', this.car, this.phys);
    }
    this.cameraRig.setSmoothing(s.cameraSmoothing);
    this.input.sensitivity = s.steerSensitivity;
    this.audio.setVolumes(s.masterVolume, s.engineVolume);
    this._applyQuality(s.quality);
    this.hud.syncSettings(s.data);
    this.hud.setModes(s.transmission, s.camera);
    this.car.cockpitMode = s.camera === 'cockpit' && this.car.cockpitAnchor;
    this.hud.setCockpitMode(s.camera === 'cockpit');
    if (this.car.ready) this.car.setPaint(s.paint);
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
    this.scene.fog.far = q.fogFar;
    this.particleFactor = q.particles;
    // force material recompile when the shadow state flips
    this.scene.traverse((o) => {
      if (o.isMesh && o.material) o.material.needsUpdate = true;
    });
  }

  // ------------------------------------------------- transmission / camera
  _shift(dir) {
    if (this.hud.settingsOpen) return;
    if (this.transmission.mode !== 'manual') {
      // pressing shift keys in auto mode flips the box to manual — handy
      if (this.state === 'racing' && this.race.state === 'racing') {
        this.changeSetting('transmission', 'manual');
        this.hud.showLapToast('MANUAL MODE — Q/E TO SHIFT');
      }
      return;
    }
    const ok = this.transmission.shift(dir);
    if (!ok) this.audio.beep(160, 0.06, 0.06, 'square'); // refused shift
  }

  toggleCamera() {
    if (this.hud.settingsOpen) return;
    // toggle between 'chase' and 'hood'. 'cockpit' is the legacy persisted
    // value from older builds — it's mapped to 'hood' in CameraRig.setMode,
    // so we treat it as 'hood' for the toggle logic.
    const isHood = this.settings.camera === 'hood' || this.settings.camera === 'cockpit';
    const next = isHood ? 'chase' : 'hood';
    this.changeSetting('camera', next);
    this.hud.showLapToast(next === 'hood' ? 'HOOD VIEW' : 'CHASE VIEW');
  }

  toggleTransmission() {
    if (this.hud.settingsOpen) return;
    const next = this.settings.transmission === 'auto' ? 'manual' : 'auto';
    this.changeSetting('transmission', next);
    this.hud.showLapToast(next === 'manual' ? 'MANUAL (Q/E)' : 'AUTOMATIC');
  }

  // ------------------------------------------------------------- race flow
  /** called from the start screen (user gesture — unlocks audio) */
  startRace() {
    if (this.state === 'loading' || !this.car.ready) return; // assets still streaming
    this.audio.init();
    this.audio.setVolumes(this.settings.masterVolume, this.settings.engineVolume);
    this.hud.show();
    this._beginRace();
  }

  _beginRace() {
    this.hud.hideFinish();
    this.hud.setWrongWay(false);
    this.hud.toggleSettings(false);
    this.input.setEnabled(true);
    this.phys.placeAt(this.track.startS, 0);
    this.race.startCountdown();
    this.state = 'racing';
    this.cameraRig.snap(this.car, this.phys);
  }

  restartRace() {
    this._beginRace();
  }

  resetCar() {
    if (this.state !== 'racing') return;
    this.phys.placeAt(this.phys.s, 0);
    this.cameraRig.snap(this.car, this.phys);
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

    // fixed-step physics (locked while a synchronous debug sim is running)
    if (!this._simLock) {
      this._accum += dt;
      let steps = 0;
      while (this._accum >= PHYS_STEP && steps < 8) {
        this.phys.update(PHYS_STEP, this.input, controlsActive);
        this._accum -= PHYS_STEP;
        steps++;
      }
      if (steps === 8) this._accum = 0; // avoid spiral of death
    }

    // race logic
    if (racing) this.race.update(dt, this.phys);

    // visuals
    this.car.updateVisual(dt, this.phys, this.transmission, this.race);
    this._updateEffects(dt);

    // camera
    if (this.state === 'idle' || this.state === 'loading') {
      this._updateIdleCamera(dt);
    } else {
      this.cameraRig.update(dt, this.phys, this.input.state, this.car);
    }

    this.environment.update(this.phys.position, this.camera, dt);

    // speed streaks (sense of speed)
    this.speedLines.update(
      dt, this.camera, this.phys.velocity,
      Math.min(1, Math.abs(this.phys.vF) / CAR.maxSpeed)
    );

    // audio
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

    this.hud.update(this.phys, this.race, this.transmission);

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
    const hit = phys.justHitWall;

    // wall impact: crash audio scaled by the closing speed + camera shake
    if (hit) {
      const impactStrength = Math.min(1, (phys.hitImpact || 6) / 12);
      this.audio.crashThud(impactStrength);
      // trigger a camera impact shake proportional to the closing speed
      this.cameraRig.impact(impactStrength * 1.2);
    }

    if (!(drifting || offroad || spinning || hit)) {
      this.effects.update(dt);
      return;
    }

    this._emitAcc += dt * this.particleFactor * (hit ? 3 : 1);
    const interval = 0.03;
    if (this._emitAcc > interval) {
      this._emitAcc = 0;
      const fwd = new THREE.Vector3(Math.sin(phys.heading), 0, Math.cos(phys.heading));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);   // matches Physics.rightOf
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
  /** debug helper used by automated tests: teleport to progress s */
  debugTeleportToProgress(s, lateral = 0) {
    this.phys.placeAt(s, lateral);
    this.cameraRig.snap(this.car, this.phys);
  }

  /**
   * Test hook: run the fixed-step physics loop synchronously for `seconds`
   * of simulated time with a given input vector — bypasses rAF throttling
   * so headless/CI runs are deterministic.
   * @returns summary of the final state
   */
  debugSim(seconds, { throttle = 0, brake = 0, steer = 0, handbrake = false } = {}) {
    const inputProxy = {
      state: { throttle, brake, steer, handbrake }
    };
    const steps = Math.round(seconds / PHYS_STEP);
    this._simLock = true;
    for (let i = 0; i < steps; i++) {
      this.phys.update(PHYS_STEP, inputProxy, this.state === 'racing' && this.race.state === 'racing');
    }
    this._simLock = false;
    return {
      speedKmh: Math.round(this.phys.speedKmh),
      vF: +this.phys.vF.toFixed(2),
      gear: this.transmission.gearLabel,
      rpm: Math.round(this.transmission.rpm),
      rpmNorm: +this.transmission.rpmNorm.toFixed(2),
      shifting: this.transmission.shifting,
      limiter: this.transmission.limiterCut,
      wheelspin: this.phys.wheelspin,
      slip: +this.phys.slip.toFixed(2),
      aLongS: +this.phys.aLongS.toFixed(2),
      susp: this.phys.suspSmooth.map((v) => +v.toFixed(2)),
      s: +this.phys.s.toFixed(3),
      lateral: +this.phys.lateral.toFixed(1),
      surfaceY: +this.phys.surfaceY.toFixed(2)
    };
  }

  /**
   * Test hook: drive laps with a simple autopilot (centerline follow +
   * curvature-based braking) to exercise the full physics/race stack.
   */
  debugAutopilot(seconds, lapCallback = null) {
    const p = this.phys;
    const t = this.track;
    const N = t.sampleCount;
    const samples = [];
    let maxKmh = 0, hitWall = 0, maxGear = 0;
    const steps = Math.round(seconds / PHYS_STEP);
    this._simLock = true;
    for (let i = 0; i < steps; i++) {
      // corner speed target from curvature over the next ~90 m (0.92g margin
      // keeps the P-controller inside the grip circle at corner entry)
      let maxCurv = 0;
      for (let k = 1; k <= 30; k++) {
        const si = Math.round(((p.s + (k * 3) / t.totalLength) % 1) * N) % N;
        maxCurv = Math.max(maxCurv, Math.abs(t.curv[si]));
      }
      const vT = Math.min(62, Math.sqrt(0.92 * 9.81 / Math.max(maxCurv, 0.0005)));
      const lookM = Math.min(50, Math.max(6, p.vF));
      const ahead = t.pointAt((p.s + lookM / t.totalLength + 1) % 1);
      const dx = ahead.x - p.position.x, dz = ahead.z - p.position.z;
      const desired = Math.atan2(dx, dz);
      let err = desired - p.heading;
      while (err > Math.PI) err -= 2 * Math.PI;
      while (err < -Math.PI) err += 2 * Math.PI;
      const speedN = Math.min(1, Math.abs(p.vF) / CAR.maxSpeed);
      const steer = Math.max(-1, Math.min(1, -err * (2.9 - 1.5 * speedN)));
      const throttle = p.vF < vT ? 1 : 0;
      const brake = p.vF > vT * 1.08 ? 1 : 0;
      p.update(PHYS_STEP, { state: { throttle, brake, steer, handbrake: false } },
        this.state === 'racing' && this.race.state === 'racing');
      // drive the real race flow too (checkpoints, laps, finish) so this
      // harness validates the full stack, not just physics
      if (this.race.state === 'racing') this.race.update(PHYS_STEP, p);
      if (p.justHitWall) {
        hitWall++;
        if (this._apHits && this._apHits.length < 16) {
          this._apHits.push({
            t: +(i / 120).toFixed(1), kmh: Math.round(p.speedKmh),
            lat: +p.lateral.toFixed(1), gear: this.transmission.gearLabel,
            s: +p.s.toFixed(2), slip: +p.slip.toFixed(1)
          });
        }
      }
      maxKmh = Math.max(maxKmh, p.speedKmh);
      maxGear = Math.max(maxGear, this.transmission.gear);
      if (lapCallback && i % 120 === 0) lapCallback(i / 120, p, this.transmission);
    }
    this._simLock = false;
    return { maxKmh: Math.round(maxKmh), maxGear, hitWall, laps: this.race.lapTimes.length, s: +p.s.toFixed(2) };
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    clearTimeout(this._startLightTimer);
    this.renderer.dispose();
  }
}
