/**
 * shell — browser bootstrap for the game inside the Next.js page.
 * Ported from the original Vite main.js: WebGL capability check, global
 * error handling, start-screen wiring. (The PWA/service-worker layer is
 * intentionally omitted — the game runs fully client-side here.)
 */

export function bootGame() {
  const $ = (id) => document.getElementById(id);
  const loadingScreen = $('loading-screen');
  const loadingLabel = $('loading-label');
  const loadingBar = $('loading-bar');
  const startScreen = $('start-screen');
  const errorOverlay = $('error-overlay');
  let booted = false;
  let fatalShown = false;

  function showFatal(message, hint = '') {
    if (fatalShown) return;
    fatalShown = true;
    console.error('[ApexRoads] FATAL:', message, hint);
    const msg = $('error-message');
    const hintEl = $('error-hint');
    if (msg) msg.textContent = message;
    if (hintEl) hintEl.textContent = hint;
    errorOverlay.style.display = '';
    if (loadingScreen) loadingScreen.style.display = 'none';
    if (startScreen) startScreen.style.display = 'none';
  }

  window.addEventListener('error', (e) => {
    const stack = e.error && e.error.stack;
    if (stack) console.error('[ApexRoads] stack:', stack);
    if (!booted) showFatal(e.message || 'Unknown error', 'The game hit an unexpected error. Reload the page to try again.');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e && e.reason;
    if (reason && reason.stack) console.error('[ApexRoads] stack:', reason.stack);
    const msg = reason ? (reason.message || String(reason)) : 'Unknown promise rejection';
    if (!booted) showFatal(msg, 'The game hit an unexpected error. Reload the page to try again.');
  });

  function checkWebGL() {
    try {
      const canvas = document.createElement('canvas');
      return !!(window.WebGLRenderingContext &&
        (canvas.getContext('webgl2') || canvas.getContext('webgl')));
    } catch {
      return false;
    }
  }

  if (!checkWebGL()) {
    showFatal(
      'WebGL is not available in this browser.',
      'Apex Roads needs WebGL to render its 3D graphics. Try a recent version of Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.'
    );
    return;
  }

  // iOS audio unlock (Safari blocks AudioContext outside a user gesture)
  const isIOS = /ipad|iphone|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 0);
  if (isIOS) {
    const unlock = () => {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
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

  // safety net: if the first frame never arrives, explain instead of hanging
  const bootTimeout = setTimeout(() => {
    if (!booted) {
      showFatal(
        'The game is taking unusually long to start.',
        'Your device or connection may be too slow for this game\u2019s graphics. Try reloading, updating your browser, or enabling hardware acceleration.'
      );
    }
  }, 60000);

  import('./Game.js').then(({ Game }) => {
    let game;
    try {
      game = new Game({
        container: $('app'),
        onReady: () => {
          booted = true;
          clearTimeout(bootTimeout);
          const check = setInterval(() => {
            if (game.state === 'idle' || game.state === 'driving') {
              clearInterval(check);
              loadingScreen.style.display = 'none';
              startScreen.style.display = '';
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
    } catch (err) {
      clearTimeout(bootTimeout);
      if (err && err.stack) console.error('[ApexRoads] init stack:', err.stack);
      showFatal(
        err && err.message ? err.message : 'Failed to initialize the game',
        'Possible causes: WebGL disabled, outdated browser, or insufficient GPU memory. Reload the page to try again.'
      );
      return;
    }

    // ---- menu: black screen, flickering light, PLAY + SETTINGS -------------
    let started = false;
    const hudRoot = document.getElementById('hud-root');
    const settingsOpenOnMenu = () => !!(game.hud && game.hud.settingsOpen);

    const toggleMenuSettings = () => {
      if (!game.hud) return;
      game.hud.toggleSettings();
      const open = game.hud.settingsOpen;
      if (hudRoot) {
        hudRoot.classList.toggle('menu-mode', open);
        // the HUD root carries an inline display:none until play starts —
        // the CSS class alone cannot lift it
        hudRoot.style.display = open ? '' : 'none';
      }
    };

    // keep menu-mode in sync when the panel closes itself (CLOSE / Esc)
    const panelEl = document.getElementById('settings-panel');
    if (panelEl && typeof MutationObserver !== 'undefined') {
      new MutationObserver(() => {
        if (started || !game.hud) return;
        const open = game.hud.settingsOpen;
        hudRoot.classList.toggle('menu-mode', open);
        hudRoot.style.display = open ? '' : 'none';
      }).observe(panelEl, { attributes: true, attributeFilter: ['style'] });
    }

    const begin = () => {
      if (started || fatalShown) return;
      if (game.state === 'loading' || !game.car || !game.car.ready) return;
      if (settingsOpenOnMenu()) return;
      started = true;
      loadingScreen.style.display = 'none';
      startScreen.style.display = 'none';
      if (hudRoot) hudRoot.classList.remove('menu-mode');
      game.startDriving();
    };

    const startBtn = $('start-button');
    if (startBtn) startBtn.addEventListener('click', begin);
    const settingsBtn = $('menu-settings');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMenuSettings();
      });
    }
    startScreen.addEventListener('touchstart', (e) => {
      // taps land on the black screen itself — only start when the settings
      // panel is closed, otherwise let the panel handle the touch
      if (settingsOpenOnMenu()) return;
      if (e.target === startScreen) begin();
    }, { passive: true });
    window.addEventListener('keydown', function onKey(e) {
      if (started) {
        window.removeEventListener('keydown', onKey);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        toggleMenuSettings();
        return;
      }
      if (e.code === 'Tab') { e.preventDefault(); return; }
      if (settingsOpenOnMenu()) return;
      begin();
    });
  }).catch((err) => {
    clearTimeout(bootTimeout);
    showFatal(err && err.message ? err.message : 'Failed to load the game module');
  });
}
