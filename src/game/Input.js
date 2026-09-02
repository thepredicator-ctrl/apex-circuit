/**
 * Input — unified keyboard + touch control state.
 * Produces a smoothed analog control vector regardless of input source.
 */

const KEY_ACTIONS = {
  KeyW: 'throttle',
  ArrowUp: 'throttle',
  KeyS: 'brake',
  ArrowDown: 'brake',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'handbrake'
};

export class Input {
  constructor() {
    this.keys = new Set();
    this.touch = {
      throttle: 0,
      brake: 0,
      left: 0,
      right: 0,
      handbrake: 0
    };

    // smoothed output
    this.state = {
      throttle: 0,
      brake: 0,
      steer: 0,       // -1 left .. +1 right
      handbrake: false
    };

    this._steerTarget = 0;

    // edge callbacks (set by Game)
    this.onResetKey = null;      // R pressed
    this.onStartGesture = null;  // any key / tap — used for start screen
    this._enabled = true;

    window.addEventListener('keydown', (e) => this._onKeyDown(e));
    window.addEventListener('keyup', (e) => this._onKeyUp(e));
    window.addEventListener('blur', () => this._releaseAll());
  }

  _onKeyDown(e) {
    // let the browser handle modifier combos (devtools refresh etc.)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (this.onStartGesture) {
      this.onStartGesture(e);
    }

    if (e.code === 'KeyR' && !e.repeat) {
      if (this.onResetKey) this.onResetKey();
    }

    const action = KEY_ACTIONS[e.code];
    if (action) {
      e.preventDefault(); // stop page scrolling on arrows/space
      this.keys.add(action);
    }
  }

  _onKeyUp(e) {
    const action = KEY_ACTIONS[e.code];
    if (action) this.keys.delete(action);
  }

  _releaseAll() {
    this.keys.clear();
    this.touch.throttle = 0;
    this.touch.brake = 0;
    this.touch.left = 0;
    this.touch.right = 0;
    this.touch.handbrake = 0;
  }

  /** called by TouchControls */
  setTouch(action, value) {
    if (action in this.touch) this.touch[action] = value;
  }

  /** enable/disable driving input (used outside of racing states) */
  setEnabled(v) {
    this._enabled = v;
    if (!v) this._releaseAll();
  }

  /**
   * Advance smoothing; call once per frame.
   * Steering uses an attack/release ramp so digital keys feel analog.
   */
  update(dt) {
    const kThrottle = (this.keys.has('throttle') ? 1 : 0) || this.touch.throttle;
    const kBrake = (this.keys.has('brake') ? 1 : 0) || this.touch.brake;
    const kLeft = (this.keys.has('left') ? 1 : 0) || this.touch.left;
    const kRight = (this.keys.has('right') ? 1 : 0) || this.touch.right;
    const kHand = this.keys.has('handbrake') || this.touch.handbrake > 0;

    this._steerTarget = kRight - kLeft;

    // steer ramp: quick to engage, quicker to center
    const rate = this._steerTarget === 0 ? 7.5 : 5.2;
    const diff = this._steerTarget - this.state.steer;
    const step = rate * dt;
    if (Math.abs(diff) <= step) this.state.steer = this._steerTarget;
    else this.state.steer += Math.sign(diff) * step;

    const t = this._enabled ? 1 : 0;
    this.state.throttle = Math.min(1, kThrottle) * t;
    this.state.brake = Math.min(1, kBrake) * t;
    this.state.handbrake = kHand && this._enabled;
    return this.state;
  }
}
