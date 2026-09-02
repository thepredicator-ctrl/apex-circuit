/**
 * TouchControls — large, multi-touch-safe on-screen controls for phones,
 * tablets and iPads (landscape). Built on pointer events with pointer
 * capture, so sliding a finger slightly off a button keeps it pressed
 * until release, and simultaneous buttons all register independently.
 *
 * Layout (landscape):
 *   left edge: steer left / right
 *   right edge: DRIFT above BRAKE above GAS, gear - / + stacked left of pedals
 *   top right (below HUD): CAM / TRANS / RESET system buttons
 */

const SVG_LEFT = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M15.5 4.5 8 12l7.5 7.5z"/></svg>';
const SVG_RIGHT = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8.5 4.5 16 12l-7.5 7.5z"/></svg>';
const SVG_RESET = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>';
const SVG_CAM = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm8 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0-2a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>';
const SVG_TRANS = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 4h2v6h6V4h2v16h-2v-8H9v8H7V4z"/></svg>';

export class TouchControls {
  constructor(input, callbacks = {}) {
    this.input = input;
    this.callbacks = callbacks;
    this.enabled = false;
    this.root = document.getElementById('touch-root');

    const force = new URLSearchParams(window.location.search).has('touch');
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const hasTouch = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;

    if (force || coarse || hasTouch) {
      this._build();
    } else {
      // maybe a hybrid device: enable on first real touch
      const once = () => {
        window.removeEventListener('touchstart', once);
        if (!this.enabled) this._build();
      };
      window.addEventListener('touchstart', once, { passive: true });
    }
  }

  _build() {
    if (this.enabled) return;
    this.enabled = true;
    this.root.innerHTML = `
      <div class="tc">
        <div class="tc-cluster tc-left">
          <button class="tc-btn tc-steer" data-action="left" aria-label="Steer left">${SVG_LEFT}</button>
          <button class="tc-btn tc-steer" data-action="right" aria-label="Steer right">${SVG_RIGHT}</button>
        </div>
        <div class="tc-cluster tc-right">
          <div class="tc-gearcol">
            <button class="tc-btn tc-gear" data-edge="gearDown" aria-label="Gear down">&minus;</button>
            <button class="tc-btn tc-gear" data-edge="gearUp" aria-label="Gear up">+</button>
          </div>
          <div class="tc-pedals">
            <button class="tc-btn tc-small" data-action="handbrake" aria-label="Drift">DRIFT</button>
            <button class="tc-btn tc-pedal" data-action="brake" aria-label="Brake / reverse">BRAKE</button>
            <button class="tc-btn tc-pedal tc-gas" data-action="throttle" aria-label="Throttle">GAS</button>
          </div>
        </div>
        <div class="tc-cluster tc-sys">
          <button class="tc-btn tc-sysbtn" data-edge="camera" aria-label="Switch camera">${SVG_CAM}</button>
          <button class="tc-btn tc-sysbtn" data-edge="transmission" aria-label="Transmission mode">${SVG_TRANS}</button>
          <button class="tc-btn tc-sysbtn" data-edge="reset" aria-label="Reset car">${SVG_RESET}</button>
        </div>
      </div>`;

    this.root.querySelectorAll('.tc-btn').forEach((btn) => {
      const action = btn.dataset.action;
      const edge = btn.dataset.edge;
      const press = (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { btn.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
        btn.classList.add('active');
        if (edge) {
          const cb = this.callbacks;
          if (edge === 'gearUp' && cb.onGearUp) cb.onGearUp();
          else if (edge === 'gearDown' && cb.onGearDown) cb.onGearDown();
          else if (edge === 'camera' && cb.onCamera) cb.onCamera();
          else if (edge === 'transmission' && cb.onTransmission) cb.onTransmission();
          else if (edge === 'reset' && cb.onReset) cb.onReset();
        } else {
          this.input.setTouch(action, 1);
        }
      };
      const release = (e) => {
        e.preventDefault();
        btn.classList.remove('active');
        if (!edge && action) this.input.setTouch(action, 0);
      };
      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('lostpointercapture', release);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    // block double-tap zoom / scroll gestures over the control area
    this.root.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    this.root.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  setCallbacks(cb) {
    this.callbacks = cb;
  }
}
