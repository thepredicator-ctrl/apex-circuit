/**
 * main.js — bootstrap for APEX ROADS: WebGL capability check, global error
 * handling, service-worker registration, PWA install / offline-download
 * prompt, and start-screen wiring. Everything else lives in src/game + src/ui.
 *
 * APEX ROADS is an endless procedural driving game — no race, no timers,
 * no downloadable assets. The service worker still precaches the app shell
 * so the whole game installs and plays offline.
 */

import './styles/main.css';
import { Game } from './game/Game.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const loadingScreen = $('loading-screen');
const loadingLabel = $('loading-label');
const loadingBar = $('loading-bar');
const startScreen = $('start-screen');
const errorOverlay = $('error-overlay');
const installBtn = $('install-button');
let booted = false;
let fatalShown = false;
let assetsReady = false;

function showFatal(message, hint = '') {
  if (fatalShown) return;
  fatalShown = true;
  console.error('[ApexRoads] FATAL:', message, hint);
  $('error-message').textContent = message;
  $('error-hint').textContent = hint;
  errorOverlay.style.display = '';
  loadingScreen.style.display = 'none';
  startScreen.style.display = 'none';
}

function showRuntimeWarning(message) {
  console.error('[ApexRoads] Runtime error:', message);
}

// global error nets — a blank screen is never acceptable
window.addEventListener('error', (e) => {
  if (e.error && e.error.stack) console.error('[ApexRoads] stack:', e.error.stack);
  if (!booted || fatalShown) showFatal(e.message || 'Unknown error', 'The game hit an unexpected error. Reload the page to try again.');
  else showRuntimeWarning(e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e && e.reason;
  if (reason && reason.stack) console.error('[ApexRoads] stack:', reason.stack);
  const msg = reason ? (reason.message || String(reason)) : 'Unknown promise rejection';
  if (!booted || fatalShown) showFatal(msg, 'The game hit an unexpected error. Reload the page to try again.');
  else showRuntimeWarning(msg);
});

// ---- WebGL capability check -------------------------------------------------
function checkWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return !!(window.WebGLRenderingContext &&
      (canvas.getContext('webgl2') || canvas.getContext('webgl')));
  } catch {
    return false;
  }
}

// ---- PWA: service worker (precaches the whole game onto the device) ----------
let swRegistration = null;
let precacheReportedDone = false;
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      swRegistration = reg;
      navigator.serviceWorker.addEventListener('message', (ev) => {
        const d = ev.data || {};
        if (d.type === 'precache-progress' && !assetsReady) {
          const pct = Math.round((d.done / Math.max(1, d.total)) * 100);
          if (loadingLabel) loadingLabel.textContent = `DOWNLOADING GAME TO DEVICE — ${pct}%`;
          if (loadingBar) loadingBar.style.width = `${pct}%`;
        }
        if (d.type === 'precache-done') {
          precacheReportedDone = true;
          markDownloaded();
          refreshDownloadButton();
        }
      });
      if (reg.active) {
        reg.active.postMessage({ type: 'precache-status' });
      }
    }).catch(() => { /* SW unavailable (dev server, old browser) — fine */ });
  });
}

function isStandalone() {
  return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true;
}

function isIOS() {
  return /ipad|iphone|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 0);
}

async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      const already = await navigator.storage.persisted();
      if (already) return true;
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}

function markDownloaded() {
  const el = $('download-state');
  if (el) el.textContent = 'GAME DOWNLOADED — PLAYS OFFLINE';
}

function refreshDownloadButton() {
  const btn = $('download-button');
  if (!btn) return;
  const standalone = isStandalone();
  if (standalone || precacheReportedDone) {
    btn.style.display = 'none';
    if (precacheReportedDone) markDownloaded();
    return;
  }
  btn.style.display = '';
  btn.textContent = isIOS()
    ? 'PRE-DOWNLOAD GAME (WORKS OFFLINE)'
    : 'PRE-DOWNLOAD GAME TO DEVICE';
}

async function triggerExplicitDownload() {
  const btn = $('download-button');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'ASKING FOR PERMISSION…';
  }
  const persisted = await requestPersistentStorage();
  if (btn) {
    btn.disabled = false;
    btn.textContent = persisted
      ? 'PERMISSION GRANTED — CACHING…'
      : 'CACHING GAME (PERMISSION NOT GRANTED)…';
  }
  if (swRegistration && swRegistration.active) {
    swRegistration.active.postMessage({ type: 'precache-status' });
  }
}

// ---- PWA: custom install button ---------------------------------------------
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  if (installBtn) installBtn.style.display = '';
});
window.addEventListener('appinstalled', () => {
  if (installBtn) installBtn.style.display = 'none';
  markDownloaded();
});
if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    installBtn.style.display = 'none';
  });
}
if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
  if (installBtn) installBtn.style.display = 'none';
  if (document.readyState !== 'loading') markDownloaded();
  else window.addEventListener('DOMContentLoaded', markDownloaded);
}

window.addEventListener('DOMContentLoaded', () => {
  const dlBtn = $('download-button');
  if (dlBtn) {
    dlBtn.addEventListener('click', () => {
      triggerExplicitDownload();
    });
  }
  refreshDownloadButton();
});

// ---- iOS audio unlock -------------------------------------------------------
function unlockIOSAudio() {
  if (!isIOS()) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const unlock = () => {
    try {
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.001);
      osc.frequency.value = 1;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.02);
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch { /* ignore */ }
    window.removeEventListener('touchend', unlock);
    window.removeEventListener('click', unlock);
  };
  window.addEventListener('touchend', unlock, { once: true, passive: true });
  window.addEventListener('click', unlock, { once: true });
}
unlockIOSAudio();

// ---- boot --------------------------------------------------------------------
async function boot() {
  if (!checkWebGL()) {
    showFatal(
      'WebGL is not available in this browser.',
      'Apex Roads needs WebGL to render its 3D graphics. Try a recent version of Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.'
    );
    return;
  }

  // safety net: if the first frame never arrives, explain instead of hanging
  const bootTimeout = setTimeout(() => {
    if (!booted) {
      showFatal(
        'The game is taking unusually long to start.',
        'Your device or connection may be too slow for this game\u2019s graphics. Try reloading, updating your browser, or enabling hardware acceleration.'
      );
    }
  }, 60000);

  try {
    const game = new Game({
      container: app,
      onReady: () => {
        booted = true;
        clearTimeout(bootTimeout);
        // everything is procedural — the world is ready as soon as state=idle
        const check = setInterval(() => {
          if (game.state === 'idle' || game.state === 'driving') {
            clearInterval(check);
            assetsReady = true;
            loadingScreen.style.display = 'none';
            startScreen.style.display = '';
            const seedEl = $('start-seed');
            if (seedEl) {
              seedEl.textContent = `ROAD SEED — ${game.journey.seed}`;
              seedEl.style.display = '';
            }
          }
        }, 120);
      },
      onError: (err) => showFatal(err.message || 'Initialization failed')
    });
    game.onProgress = (frac, label) => {
      if (loadingBar) loadingBar.style.width = `${Math.round(frac * 100)}%`;
      if (loadingLabel && label) loadingLabel.textContent = label;
    };
    game.init();
    wireStartScreen(game);
  } catch (err) {
    clearTimeout(bootTimeout);
    if (err && err.stack) console.error('[ApexRoads] init stack:', err.stack);
    showFatal(
      err && err.message ? err.message : 'Failed to initialize the game',
      'Possible causes: WebGL disabled, outdated browser, or insufficient GPU memory. Reload the page to try again.'
    );
  }
}

function wireStartScreen(game) {
  let started = false;
  const begin = () => {
    if (started || fatalShown) return;
    if (game.state === 'loading' || !game.car.ready) return;
    started = true;
    loadingScreen.style.display = 'none';
    startScreen.style.display = 'none';
    game.startDriving();
  };

  const startBtn = $('start-button');
  if (startBtn) startBtn.addEventListener('click', begin);
  startScreen.addEventListener('touchstart', begin, { passive: true });
  window.addEventListener('keydown', function onKey(e) {
    if (started) {
      window.removeEventListener('keydown', onKey);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    begin();
  });
}

boot();
