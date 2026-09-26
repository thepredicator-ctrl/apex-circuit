/**
 * TouchControls — thumb-first driving controls.
 *
 * Layout (landscape phone):
 *   bottom-left:  big LEFT / RIGHT steer pads (slide your thumb between them)
 *   bottom-right: GAS (large circle), BRAKE (smaller), DRIFT pill on top
 *   small utility cluster top-right: reset / camera / mute
 *
 * Comfort details: pointer capture per control (multi-touch safe), thumb
 * sliding between steer pads, ≥ 76 px targets, safe-area padding, no
 * double-tap zoom, haptic hook, and the whole layer only mounts on touch
 * devices (desktop gets keyboard).
 */
import { Settings } from '../core/Settings.js';

export class TouchControls {
  /**
   * @param {HTMLElement} root #touch-root
   * @param {object} input  Input instance
   * @param {object} hooks  { onPause, onCamera, onReset, onMuteToggle }
   */
  constructor(root, input, hooks) {
    this.root = root;
    this.input = input;
    this.hooks = hooks;
    this.visible = false;

    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
      || new URLSearchParams(location.search).has('touch'); // QA override
    this.enabled = isTouch;
    if (!isTouch) {
      // keyboard hint only
      root.innerHTML = '';
      return;
    }
    this._build();
  }

  _build() {
    const mk = (cls, html) => {
      const el = document.createElement('div');
      el.className = cls;
      if (html !== undefined) el.innerHTML = html;
      return el;
    };

    // ---- steer pads -----------------------------------------------------
    const steer = mk('tc-steer-wrap');
    this.left = mk('tc-pad tc-steer-left', '<span>◀</span>');
    this.right = mk('tc-pad tc-steer-right', '<span>▶</span>');
    steer.append(this.left, this.right);

    // ---- pedals ---------------------------------------------------------
    this.drift = mk('tc-pad tc-btn tc-drift', '<span>DRIFT</span>');
    this.gas = mk('tc-pad tc-btn tc-gas', '<span>GAS</span>');
    this.brake = mk('tc-pad tc-btn tc-brake', '<span>BRAKE</span>');
    const pedals = mk('tc-pedal-wrap');
    pedals.append(this.drift, this.brake, this.gas);

    // ---- utilities ------------------------------------------------------
    const util = mk('tc-util');
    this.resetBtn = mk('tc-mini', '⟲');
    this.camBtn = mk('tc-mini', '🎥'.replace('🎥', '◎'));
    this.muteBtn = mk('tc-mini', Settings.get('muted') ? '🔇' : '🔊');
    this.pauseBtn = mk('tc-mini', '❚❚');
    util.append(this.pauseBtn, this.camBtn, this.resetBtn, this.muteBtn);

    this.root.append(util, steer, pedals);

    // ---- wiring ----------------------------------------------------------
    this._bindHold(this.left, { steer: -1 });
    this._bindHold(this.right, { steer: 1 });
    this._bindHold(this.gas, { throttle: 1 });
    this._bindHold(this.brake, { brake: 1 });
    this._bindHold(this.drift, { handbrake: true });

    this._tap(this.resetBtn, () => this.hooks.onReset?.());
    this._tap(this.camBtn, () => this.hooks.onCamera?.());
    this._tap(this.pauseBtn, () => this.hooks.onPause?.());
    this._tap(this.muteBtn, () => {
      const muted = Settings.toggle('muted');
      this.muteBtn.textContent = muted ? '🔇' : '🔊';
      this.hooks.onMuteToggle?.(muted);
    });
  }

  /** Multi-touch safe press-and-hold with thumb sliding for steer pads. */
  _bindHold(el, action) {
    const active = new Set();

    const apply = () => {
      const on = active.size > 0;
      el.classList.toggle('tc-active', on);
      if (action.steer !== undefined) {
        // sliding between the two steer pads: recompute from both
        const l = this.left._down, r = this.right._down;
        this.input.setTouchSteer((r ? 1 : 0) - (l ? 1 : 0));
      }
      if (action.throttle !== undefined) this.input.setTouchThrottle(on ? 1 : 0);
      if (action.brake !== undefined) this.input.setTouchBrake(on ? 1 : 0);
      if (action.handbrake !== undefined) this.input.setTouchHandbrake(on);
    };

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture?.(e.pointerId); } catch { /* synthetic events have no id */ }
      active.add(e.pointerId);
      el._down = true;
      apply();
    });
    const release = (e) => {
      active.delete(e.pointerId);
      el._down = active.size > 0;
      apply();
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    // prevent context menu on long press
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _tap(el, fn) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
      try { navigator.vibrate?.(12); } catch { /* noop */ }
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  show() {
    this.root.style.display = this.enabled ? 'block' : 'none';
    this.visible = true;
  }

  hide() {
    if (!this.enabled) return;
    this.root.style.display = 'none';
    this.visible = false;
    // safety: release everything
    this.input.setTouchSteer(0);
    this.input.setTouchThrottle(0);
    this.input.setTouchBrake(0);
    this.input.setTouchHandbrake(false);
  }
}
