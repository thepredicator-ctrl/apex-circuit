/**
 * Settings — player preferences persisted in localStorage.
 * Transmission mode, camera mode, graphics quality, volumes, sensitivities.
 */

import { DEFAULT_SETTINGS } from './Constants.js';

const KEY = 'apex-circuit:settings';

export class Settings {
  constructor() {
    this.data = { ...DEFAULT_SETTINGS };
    this._load();
  }

  _load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (saved && k in saved) {
          const v = saved[k];
          // only accept values of the same primitive type
          if (typeof v === typeof DEFAULT_SETTINGS[k]) this.data[k] = v;
        }
      }
    } catch { /* private mode / corrupt data -> defaults */ }
  }

  get transmission() { return this.data.transmission; }
  get camera() { return this.data.camera; }
  get quality() { return this.data.quality; }
  get masterVolume() { return this.data.masterVolume; }
  get engineVolume() { return this.data.engineVolume; }
  get steerSensitivity() { return this.data.steerSensitivity; }
  get cameraSmoothing() { return this.data.cameraSmoothing; }

  set(key, value) {
    if (!(key in this.data)) return;
    this.data[key] = value;
    this._save();
  }

  _save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch { /* storage unavailable — session-only settings */ }
  }
}
