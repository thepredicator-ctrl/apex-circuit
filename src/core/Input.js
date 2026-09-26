/**
 * Input — unified control state for keyboard + touch (+ optional tilt).
 *
 * Touch UI writes analog values directly via setTouch*(); keyboard ramps a
 * digital steer toward ±1 for smooth feel. Physics only ever reads
 * this.steer / throttle / brake / handbrake, so control schemes are
 * hot-swappable (that's what makes tilt + auto-throttle cheap).
 */
import { Settings } from './Settings.js';

const STEER_ATTACK = 6.5;   // ramp to full lock (rad-equivalent per second)
const STEER_RELEASE = 9.5;  // return to center

export class Input {
  constructor() {
    this.steer = 0;        // -1 (left) .. +1 (right), smoothed
    this.throttle = 0;     // 0..1
    this.brake = 0;        // 0..1
    this.handbrake = false;

    this._touch = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    this._key = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    this._tilt = 0;        // -1..1 from DeviceOrientation
    this._tiltActive = false;

    this.resetQueued = false;
    this.cameraQueued = false;

    this._bindKeyboard();
    this._bindTilt();
  }

  // ------------------------------------------------------------ touch side
  setTouchSteer(v) { this._touch.steer = Math.max(-1, Math.min(1, v)); }
  setTouchThrottle(v) { this._touch.throttle = Math.max(0, Math.min(1, v)); }
  setTouchBrake(v) { this._touch.brake = Math.max(0, Math.min(1, v)); }
  setTouchHandbrake(on) { this._touch.handbrake = !!on; }
  setTilt(v) { this._tilt = Math.max(-1, Math.min(1, v)); }
  queueReset() { this.resetQueued = true; }
  queueCamera() { this.cameraQueued = true; }

  // --------------------------------------------------------------- keyboard
  _bindKeyboard() {
    const down = new Set();
    // some synthetic/headless keyboards send empty e.code — fall back to e.key
    const norm = (e) => {
      if (e.code) return e.code;
      const k = (e.key || '').toLowerCase();
      if (k === ' ') return 'Space';
      return { arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight' }[k] || k;
    };
    const apply = () => {
      const left = down.has('ArrowLeft') || down.has('KeyA') || down.has('a');
      const right = down.has('ArrowRight') || down.has('KeyD') || down.has('d');
      this._key.steer = (right ? 1 : 0) - (left ? 1 : 0);
      this._key.throttle = (down.has('ArrowUp') || down.has('KeyW') || down.has('w')) ? 1 : 0;
      this._key.brake = (down.has('ArrowDown') || down.has('KeyS') || down.has('s')) ? 1 : 0;
      this._key.handbrake = down.has('Space');
    };
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const code = norm(e);
      if (code === 'KeyR' || code === 'r') this.resetQueued = true;
      if (code === 'KeyC' || code === 'c') this.cameraQueued = true;
      if (code === 'Space' || code.startsWith('Arrow')) e.preventDefault();
      down.add(code);
      apply();
    });
    window.addEventListener('keyup', (e) => {
      down.delete(norm(e));
      apply();
    });
    window.addEventListener('blur', () => {
      down.clear();
      apply();
    });
  }

  // ------------------------------------------------------------------- tilt
  _bindTilt() {
    window.addEventListener('deviceorientation', (e) => {
      if (e.gamma == null) return;
      // landscape-primary: gamma rotates around the phone's long axis
      const g = Math.max(-38, Math.min(38, e.gamma));
      this._tilt = g / 38;
      this._tiltActive = true;
    });
  }

  // ------------------------------------------------------------------ frame
  /** Smooth toward the frame's target values. Call once per render frame. */
  update(dt) {
    const tiltOn = Settings.get('tilt') && this._tiltActive;
    const autoT = Settings.get('autoThrottle');

    // --- steering source priority: tilt > touch > keyboard
    let target;
    if (tiltOn) {
      target = this._tilt;
    } else if (Math.abs(this._touch.steer) > 0.01) {
      target = this._touch.steer;
    } else if (this._key.steer !== 0) {
      target = this._key.steer;
    } else {
      target = 0;
    }

    const rate = (target === 0 ? STEER_RELEASE : STEER_ATTACK) * dt;
    const d = target - this.steer;
    this.steer = Math.abs(d) <= rate ? target : this.steer + Math.sign(d) * rate;

    // --- pedals: touch wins, else keyboard, else auto-throttle
    let throttle = this._touch.throttle > 0.01 ? this._touch.throttle : this._key.throttle;
    let brake = this._touch.brake > 0.01 ? this._touch.brake : this._key.brake;
    if (autoT && this._touch.throttle <= 0.01 && this._key.throttle <= 0.01 && !brake) {
      throttle = 1;
    }
    this.throttle = throttle;
    this.brake = brake;

    this.handbrake = this._touch.handbrake || this._key.handbrake;
  }

  consumeReset() {
    const r = this.resetQueued;
    this.resetQueued = false;
    return r;
  }

  consumeCamera() {
    const c = this.cameraQueued;
    this.cameraQueued = false;
    return c;
  }
}
