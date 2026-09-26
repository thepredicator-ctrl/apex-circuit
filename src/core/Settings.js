/**
 * Settings — tiny localStorage-backed preference store.
 *
 * Mobile comfort options live here (tilt steering, auto-throttle, haptics,
 * sound, drift assist) plus the per-seed best score. Everything degrades
 * gracefully when storage is unavailable (private mode etc).
 */

const KEY = 'apex-drift.settings.v1';

const DEFAULTS = {
  muted: false,
  tilt: false,          // tilt-to-steer instead of buttons
  autoThrottle: false,  // one-thumb mode: throttle always on, tap BRAKE to slow
  haptics: true,
  driftAssist: true,    // auto counter-steer when not touching steering
  quality: 'auto',      // 'auto' | 'high'
  cam: 'chase',         // 'chase' | 'far' | 'hood'
};

function safeGet() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function safeSet(obj) {
  try {
    localStorage.setItem(KEY, JSON.stringify(obj));
  } catch {
    /* private mode — settings just won't persist */
  }
}

export const Settings = {
  data: { ...DEFAULTS, ...safeGet() },

  get(name) {
    return this.data[name];
  },

  set(name, value) {
    this.data[name] = value;
    safeSet(this.data);
  },

  toggle(name) {
    this.set(name, !this.data[name]);
    return this.data[name];
  },

  /** Best banked score for a map seed. */
  bestFor(seed) {
    try {
      return Number(localStorage.getItem(`apex-drift.best.${seed}`) || 0) || 0;
    } catch {
      return 0;
    }
  },

  recordBest(seed, score) {
    try {
      const cur = this.bestFor(seed);
      if (score > cur) {
        localStorage.setItem(`apex-drift.best.${seed}`, String(Math.round(score)));
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  },
};
