/**
 * Settings — player preferences persisted in localStorage.
 * Transmission, camera, quality, world clock, weather, traffic, bloom,
 * multiplayer identity, volumes, sensitivities, paint.
 */

import { DEFAULT_SETTINGS } from './core/Constants.js';

const KEY = 'apex-roads:settings:v2';

function detectDefaultQuality() {
  try {
    const ua = navigator.userAgent;
    const isIOS = /ipad|iphone|ipod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 0);
    const isAndroid = /android/i.test(ua);
    if (isIOS || isAndroid) return 'low';
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    if (cores < 8 || mem < 8) return 'low';
    return 'medium';
  } catch {
    return 'medium';
  }
}

export class Settings {
  constructor() {
    this.data = { ...DEFAULT_SETTINGS, quality: detectDefaultQuality() };
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
          if (typeof v === typeof DEFAULT_SETTINGS[k]) this.data[k] = v;
        }
      }
    } catch { /* private mode / corrupt data -> defaults */ }
  }

  get transmission() { return this.data.transmission; }
  get camera() { return this.data.camera; }
  get quality() { return this.data.quality; }
  get timeOfDay() { return this.data.timeOfDay; }
  get dayCycle() { return this.data.dayCycle; }
  get dayLength() { return this.data.dayLength; }
  get weather() { return this.data.weather; }
  get masterVolume() { return this.data.masterVolume; }
  get engineVolume() { return this.data.engineVolume; }
  get steerSensitivity() { return this.data.steerSensitivity; }
  get cameraSmoothing() { return this.data.cameraSmoothing; }
  get paint() { return this.data.paint; }
  get traffic() { return this.data.traffic; }
  get bloom() { return this.data.bloom; }
  get multiplayer() { return this.data.multiplayer; }
  get playerName() { return this.data.playerName; }

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
