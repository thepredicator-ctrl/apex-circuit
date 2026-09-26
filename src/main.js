/**
 * APEX DRIFT — bootstrap.
 * Wires Game ↔ UI (menu / HUD / touch), owns global error display and the
 * audio-unlock gesture chain (mobile browsers require a gesture for sound).
 */
import { Game } from './game/Game.js';
import { Menu } from './ui/Menu.js';
import { HUD } from './ui/HUD.js';
import { TouchControls } from './ui/TouchControls.js';
import { Settings } from './core/Settings.js';
import './styles/main.css';

const app = document.getElementById('app');
const hudRoot = document.getElementById('hud-root');
const touchRoot = document.getElementById('touch-root');
const menuRoot = document.getElementById('menu-root');
const loading = document.getElementById('loading-screen');
const loadingBar = document.getElementById('loading-bar');
const loadingLabel = document.getElementById('loading-label');
const errorOverlay = document.getElementById('error-overlay');
const errorMessage = document.getElementById('error-message');
const errorHint = document.getElementById('error-hint');

function showError(message, hint) {
  errorMessage.textContent = message;
  errorHint.textContent = hint || '';
  errorOverlay.style.display = 'flex';
}

function hideLoading() {
  loading.style.display = 'none';
}

// ------------------------------------------------------------------ boot
let game;
try {
  game = new Game({ container: app });
} catch (err) {
  showError('WebGL could not start on this device.', String(err?.message || err));
  throw err;
}

const hud = new HUD(hudRoot);
game.ui.hud = hud;

const menu = new Menu(menuRoot, {
  onPlay: (seed) => {
    unlockAudio();
    game.startMap(seed);
    touch.show();
  },
  onResume: () => game.resume(),
  onRestart: () => game.restart(),
});
game.ui.menu = menu;

const touch = new TouchControls(touchRoot, game.input, {
  onPause: () => game.pause(),
  onCamera: () => game.input.queueCamera(),
  onReset: () => game.input.queueReset(),
  onMuteToggle: (muted) => {
    if (muted !== Settings.get('muted')) Settings.set('muted', muted);
    game.audio.setMuted(muted);
  },
});

// pause when the tab/app goes to background
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.state === 'playing') game.pause();
});

// audio unlock on first gesture (mobile requirement)
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  game.audio.unlock();
}
window.addEventListener('pointerdown', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });

// dev/qa hook (harmless in production, used by headless smoke tests)
window.__apex = game;

// PWA service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline install optional */ });
  });
}

// ---------------------------------------------------------------- start
(async () => {
  try {
    await game.boot((p) => {
      loadingBar.style.width = `${Math.round(p * 100)}%`;
      if (p >= 1) loadingLabel.textContent = 'READY';
    });
    hideLoading();
    menu.showStart();
  } catch (err) {
    showError('The car failed to load.', String(err?.message || err));
  }
})();
