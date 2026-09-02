/**
 * TouchControls — large, multi-touch-safe on-screen controls for phones,
 * tablets and iPads (landscape). Built on pointer events with pointer
 * capture, so sliding a finger slightly off a button keeps it pressed
 * until release, and simultaneous buttons all register independently.
 */

const SVG_LEFT = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M15.5 4.5 8 12l7.5 7.5z"/></svg>';
const SVG_RIGHT = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8.5 4.5 16 12l-7.5 7.5z"/></svg>';
const SVG_RESET = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>';

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
          <button class="tc-btn tc-small" data-action="handbrake" aria-label="Drift">DRIFT</button>
          <button class="tc-btn tc-pedal" data-action="brake" aria-label="Brake / reverse">BRAKE</button>
          <button class="tc-btn tc-pedal tc-gas" data-action="throttle" aria-label="Throttle">GAS</button>
        </div>
        <button class="tc-btn tc-reset" data-action="__reset" aria-label="Reset car">${SVG_RESET}</button>
      </div>`;

    this.root.querySelectorAll('.tc-btn').forEach((btn) => {
      const action = btn.dataset.action;
      const isReset = action === '__reset';
      const press = (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { btn.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
        btn.classList.add('active');
        if (isReset) {
          if (this.callbacks.onReset) this.callbacks.onReset();
        } else {
          this.input.setTouch(action, 1);
        }
      };
      const release = (e) => {
        e.preventDefault();
        btn.classList.remove('active');
        if (!isReset) this.input.setTouch(action, 0);
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
