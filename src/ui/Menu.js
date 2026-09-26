/**
 * Menu — start screen, settings and pause overlay.
 *
 * Start: seed box + DRIFT button + comfort toggles (tilt steer, auto-throttle,
 * drift assist, haptics, sound) + PWA install button when available.
 * Pause: resume / restart / new map + session summary.
 */
import { Settings } from '../core/Settings.js';
import { randomSeed } from '../core/RNG.js';

export class Menu {
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this._build();
  }

  _build() {
    this.root.innerHTML = `
      <div class="menu-backdrop" id="menu-start">
        <div class="menu-lightbar"></div>
        <h1 class="menu-title">APEX <span>DRIFT</span></h1>
        <div class="menu-tag">seeded drift park · touch first</div>
        <div class="menu-seedbox">
          <label class="menu-label">MAP SEED</label>
          <div class="menu-seedrow">
            <input id="menu-seed" class="menu-seed-input" maxlength="24" autocomplete="off" spellcheck="false" />
            <button id="menu-dice" class="menu-mini" title="Random seed">⟳</button>
          </div>
          <div class="menu-bestline" id="menu-best"></div>
        </div>
        <button id="menu-play" class="menu-play">DRIFT ▶</button>
        <div class="menu-toggles" id="menu-toggles"></div>
        <div class="menu-hint" id="menu-hint"></div>
        <button id="menu-install" class="menu-install" style="display:none">⤓ INSTALL ON DEVICE</button>
        <div class="menu-lightbar low"></div>
      </div>

      <div class="menu-backdrop" id="menu-pause" style="display:none">
        <h2 class="menu-paused">PAUSED</h2>
        <div class="menu-session" id="menu-session"></div>
        <div class="menu-col">
          <button id="menu-resume" class="menu-play small">RESUME</button>
          <button id="menu-restart" class="menu-second">RESTART MAP</button>
          <button id="menu-newmap" class="menu-second">NEW RANDOM MAP</button>
          <button id="menu-pause-install" class="menu-install" style="display:none">⤓ INSTALL ON DEVICE</button>
        </div>
      </div>
    `;

    this.startEl = this.root.querySelector('#menu-start');
    this.pauseEl = this.root.querySelector('#menu-pause');
    this.seedInput = this.root.querySelector('#menu-seed');
    this.bestEl = this.root.querySelector('#menu-best');

    // seed box
    this.seedInput.value = randomSeed();
    this.root.querySelector('#menu-dice').addEventListener('click', () => {
      this.seedInput.value = randomSeed();
      this._refreshBest();
    });
    this.seedInput.addEventListener('input', () => this._refreshBest());

    // play
    this.root.querySelector('#menu-play').addEventListener('click', () => {
      const seed = (this.seedInput.value.trim() || randomSeed()).toLowerCase();
      this.seedInput.value = seed;
      this.hooks.onPlay(seed);
    });
    this.root.querySelector('#menu-resume').addEventListener('click', () => this.hooks.onResume?.());
    this.root.querySelector('#menu-restart').addEventListener('click', () => this.hooks.onRestart?.());
    this.root.querySelector('#menu-newmap').addEventListener('click', () => {
      const seed = randomSeed();
      this.seedInput.value = seed;
      this.hooks.onPlay(seed);
    });

    // comfort toggles
    this._toggle('tilt', 'Tilt steering');
    this._toggle('autoThrottle', 'Auto-throttle (one thumb)');
    this._toggle('driftAssist', 'Drift assist');
    this._toggle('haptics', 'Vibration');
    this._toggle('muted', 'Mute sound');

    // install prompt
    this._installEvent = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this._installEvent = e;
      this.root.querySelector('#menu-install').style.display = 'inline-block';
    });
    const doInstall = () => {
      if (!this._installEvent) return;
      this._installEvent.prompt();
      this._installEvent = null;
      this.root.querySelector('#menu-install').style.display = 'none';
    };
    this.root.querySelector('#menu-install').addEventListener('click', doInstall);
    this.root.querySelector('#menu-pause-install').addEventListener('click', doInstall);

    // hint text
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.root.querySelector('#menu-hint').textContent = isTouch
      ? 'Left thumb steers · GAS + tap DRIFT to slide · hold to keep sliding'
      : 'Keyboard: WASD / arrows · SPACE = drift · R = reset · C = camera';

    this._refreshBest();
  }

  _toggle(key, label) {
    const row = document.createElement('button');
    row.className = 'menu-toggle';
    row.type = 'button';
    const render = () => {
      row.innerHTML = `<span class="menu-toggle-label">${label}</span><span class="menu-switch ${Settings.get(key) ? 'on' : ''}"></span>`;
    };
    row.addEventListener('click', () => {
      Settings.toggle(key);
      render();
    });
    render();
    this.root.querySelector('#menu-toggles').appendChild(row);
  }

  _refreshBest() {
    const seed = this.seedInput.value.trim().toLowerCase();
    const best = seed ? Settings.bestFor(seed) : 0;
    this.bestEl.textContent = best > 0 ? `best on this map: ${best.toLocaleString('en-US')}` : 'fresh map — no score yet';
  }

  showStart() {
    this.hideAll();
    this.startEl.style.display = 'flex';
    this._refreshBest();
  }

  showPause(total, seed) {
    this.hideAll();
    this.pauseEl.style.display = 'flex';
    const best = Settings.bestFor(seed);
    const isBest = total >= best && total > 0;
    this.root.querySelector('#menu-session').innerHTML = `
      <div class="menu-stat"><span>SCORE</span><b>${Math.round(total).toLocaleString('en-US')}</b></div>
      <div class="menu-stat"><span>MAP</span><b>${seed}</b></div>
      <div class="menu-stat"><span>BEST</span><b>${Math.max(best, total).toLocaleString('en-US')}${isBest ? ' ★ new' : ''}</b></div>
    `;
    if (this._installEvent) this.root.querySelector('#menu-pause-install').style.display = 'inline-block';
  }

  hideAll() {
    this.startEl.style.display = 'none';
    this.pauseEl.style.display = 'none';
  }
}
