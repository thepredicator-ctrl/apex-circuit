/**
 * main.js — bootstrap, WebGL capability check, global error handling,
 * service-worker registration, PWA install prompt and start/finish screen
 * wiring. Everything else lives in src/game + src/ui.
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
  console.error('[ApexCircuit] FATAL:', message, hint);
  $('error-message').textContent = message;
  $('error-hint').textContent = hint;
  errorOverlay.style.display = '';
  loadingScreen.style.display = 'none';
  startScreen.style.display = 'none';
}

function showRuntimeWarning(message) {
  console.error('[ApexCircuit] Runtime error:', message);
}

// global error nets — a blank screen is never acceptable
window.addEventListener('error', (e) => {
  if (!booted || fatalShown) showFatal(e.message || 'Unknown error', 'The game hit an unexpected error. Reload the page to try again.');
  else showRuntimeWarning(e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e && e.reason ? (e.reason.message || String(e.reason)) : 'Unknown promise rejection';
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
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      // surface the SW's precache progress on the loading screen
      navigator.serviceWorker.addEventListener('message', (ev) => {
        const d = ev.data || {};
        if (d.type === 'precache-progress' && !assetsReady) {
          const pct = Math.round((d.done / Math.max(1, d.total)) * 100);
          if (loadingLabel) loadingLabel.textContent = `DOWNLOADING GAME TO DEVICE — ${pct}%`;
          if (loadingBar) loadingBar.style.width = `${pct}%`;
        }
        if (d.type === 'precache-done') {
          markDownloaded();
        }
      });
      if (reg.active) {
        reg.active.postMessage({ type: 'precache-status' });
      }
    }).catch(() => { /* SW unavailable (dev server, old browser) — fine */ });
  });
}

function markDownloaded() {
  const el = $('download-state');
  if (el) el.textContent = 'GAME DOWNLOADED — PLAYS OFFLINE';
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
// already installed (standalone)?
if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
  if (installBtn) installBtn.style.display = 'none';
  if (document.readyState !== 'loading') markDownloaded();
  else window.addEventListener('DOMContentLoaded', markDownloaded);
}

// ---- boot --------------------------------------------------------------------
async function boot() {
  if (!checkWebGL()) {
    showFatal(
      'WebGL is not available in this browser.',
      'Apex Circuit needs WebGL to render its 3D graphics. Try a recent version of Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.'
    );
    return;
  }

  // safety net: if the first frame never arrives, explain instead of hanging
  const bootTimeout = setTimeout(() => {
    if (!booted) {
      showFatal(
        'The game is taking unusually long to start.',
        'Your device or connection may be too slow for this game\u2019s graphics assets. Try reloading, updating your browser, or enabling hardware acceleration.'
      );
    }
  }, 90000);

  try {
    const game = new Game({
      container: app,
      onReady: () => {
        booted = true;
        clearTimeout(bootTimeout);
        // the start screen unlocks after the GLB assets finish loading
        const check = setInterval(() => {
          if (game.state === 'idle' || game.state === 'finished') {
            clearInterval(check);
            assetsReady = true;
            loadingScreen.style.display = 'none';
            startScreen.style.display = '';
            updateStartBest();
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
    showFatal(
      err && err.message ? err.message : 'Failed to initialize the game',
      'Possible causes: WebGL disabled, outdated browser, or insufficient GPU memory. Reload the page to try again.'
    );
  }
}

function updateStartBest() {
  try {
    const v = parseFloat(localStorage.getItem('apex-circuit:best-lap'));
    if (isFinite(v) && v > 0) {
      const m = Math.floor(v / 60);
      const s = Math.floor(v % 60);
      const ms = Math.floor((v % 1) * 1000);
      $('start-best').textContent = `YOUR BEST LAP — ${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
      $('start-best').style.display = '';
    }
  } catch { /* no storage, no problem */ }
}

function wireStartScreen(game) {
  let started = false;
  const begin = () => {
    if (started || fatalShown) return;
    if (game.state === 'loading' || !game.car.ready) return; // still streaming
    started = true;
    startScreen.style.display = 'none';
    game.startRace();
  };

  $('start-button').addEventListener('click', begin);
  startScreen.addEventListener('touchstart', begin, { passive: true });
  window.addEventListener('keydown', function onKey(e) {
    if (started) {
      window.removeEventListener('keydown', onKey);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    begin();
  });

  $('restart-button').addEventListener('click', () => {
    $('finish-screen').style.display = 'none';
    game.restartRace();
  });

  // any key on the finish screen restarts (after a small delay to avoid skips)
  let finishedAt = 0;
  const observer = new MutationObserver(() => {
    const finishVisible = $('finish-screen').style.display !== 'none';
    if (finishVisible) {
      finishedAt = performance.now();
      window.addEventListener('keydown', function onFinishKey(e) {
        if ($('finish-screen').style.display === 'none') {
          window.removeEventListener('keydown', onFinishKey);
          return;
        }
        if (performance.now() - finishedAt < 900) return;
        if (e.code === 'Escape') return;
        window.removeEventListener('keydown', onFinishKey);
        $('finish-screen').style.display = 'none';
        game.restartRace();
      });
    }
  });
  observer.observe($('finish-screen'), { attributes: true, attributeFilter: ['style'] });
}

boot();
