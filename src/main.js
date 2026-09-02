/**
 * main.js — bootstrap, WebGL capability check, global error handling and
 * start/finish screen wiring. Everything else lives in src/game + src/ui.
 */

import './styles/main.css';
import { Game } from './game/Game.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const loadingScreen = $('loading-screen');
const startScreen = $('start-screen');
const errorOverlay = $('error-overlay');
let booted = false;
let fatalShown = false;

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
        'Your device or browser may not support this game\u2019s graphics features. Try reloading, updating your browser, or enabling hardware acceleration.'
      );
    }
  }, 15000);

  try {
    const game = new Game({
      container: app,
      onReady: () => {
        booted = true;
        clearTimeout(bootTimeout);
        loadingScreen.style.display = 'none';
        startScreen.style.display = '';
        updateStartBest();
      },
      onError: (err) => showFatal(err.message || 'Initialization failed')
    });
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
