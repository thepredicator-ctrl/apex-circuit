/**
 * Settings — player preferences persisted in localStorage.
 * Transmission mode, camera mode, graphics quality, volumes, sensitivities.
 */

import { DEFAULT_SETTINGS } from './Constants.js';

const KEY = 'apex-circuit:settings';

/**
 * Pick a sensible default graphics quality based on the device.
 * iPads and phones get 'low' (3x screens + WebGL is brutal on fill-rate);
 * desktops / laptops get 'medium'. The user can still bump it up in Settings.
 */
function detectDefaultQuality() {
  try {
    const ua = navigator.userAgent;
    const isIOS = /ipad|iphone|ipod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 0);
    const isAndroid = /android/i.test(ua);
    const isMobileGPU = isIOS || isAndroid;
    if (isMobileGPU) return 'low';
    // cheap desktop heuristic: hardware concurrency < 8 or small screen -> medium
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    if (cores < 8 || mem < 8) return 'medium';
    return 'medium';
  } catch {
    return 'medium';
  }
}

export class Settings {
  constructor() {
    // detect device-appropriate default quality BEFORE we overlay saved prefs
    // so first-time visitors on iPad don't get stuck on the old 'medium' preset
    // (which was cratering the framerate).
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

