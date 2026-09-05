/**
 * HUD — DOM-based racing HUD:
 *  - canvas tachometer (needle, redline arc, shift lights) with big gear
 *    indicator and digital speed
 *  - lap counter with checkpoint pips, lap / total / best times
 *  - transmission + camera mode badges
 *  - reset / restart / sound / settings buttons
 *  - settings panel (persisted via game Settings)
 *  - countdown display, lap toasts, wrong-way warning, finish panel
 */

import { formatTime } from '../game/Race.js';

const TEMPLATE = `
<div class="hud" id="hud">
  <div class="hud-vignette" id="hud-vignette"></div>
  <div class="hud-panel hud-lap">
    <div class="hud-lap-row">
      <span class="hud-label">LAP</span>
      <span class="hud-lapnum"><b id="hud-lap">1</b><i>/3</i></span>
    </div>
    <div class="hud-pips" id="hud-pips"><i></i><i></i><i></i></div>
    <div class="hud-time-row"><span>TIME</span><b id="hud-laptime">0:00.000</b></div>
    <div class="hud-time-row"><span>TOTAL</span><b id="hud-total">0:00.000</b></div>
    <div class="hud-time-row"><span>BEST</span><b id="hud-best">--:--.---</b></div>
  </div>

  <div class="hud-buttons">
    <button class="hud-btn" id="hud-sound" type="button" title="Toggle sound">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l6 5V4L8 9H4z"/><path id="hud-sound-wave" fill="currentColor" d="M16.5 8.5a5 5 0 0 1 0 7l1.4 1.4a7 7 0 0 0 0-9.8l-1.4 1.4z"/></svg>
      <span id="hud-sound-label">ON</span>
    </button>
    <button class="hud-btn" id="hud-reset" type="button" title="Reset car to track (R)">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>
      <span>RESET</span>
    </button>
    <button class="hud-btn" id="hud-restart" type="button" title="Restart race">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6 13h4l-2 3h3v5l6-8h-4l2-4h-4l-5 4z"/></svg>
      <span>RESTART</span>
    </button>
    <button class="hud-btn" id="hud-settings" type="button" title="Settings (Esc)">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.6a.5.5 0 0 0 .1-.7l-2-3.4a.5.5 0 0 0-.6-.2l-2.5 1a7.7 7.7 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 0-.5.4l-.4 2.7a7.7 7.7 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.4a.5.5 0 0 0 .1.7L4.5 11a7.6 7.6 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.7l2 3.4c.1.2.4.3.6.2l2.5-1a7.7 7.7 0 0 0 1.7 1l.4 2.6c0 .3.2.5.5.5h4c.2 0 .5-.2.5-.4l.4-2.7a7.7 7.7 0 0 0 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.4a.5.5 0 0 0-.1-.7L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>
      <span>SETTINGS</span>
    </button>
  </div>

  <div class="hud-tach">
    <canvas id="hud-tach-canvas" width="170" height="170"></canvas>
    <div class="hud-modes">
      <span class="hud-mode" id="hud-mode-trans">AUTO</span>
      <span class="hud-mode" id="hud-mode-cam">CHASE</span>
    </div>
  </div>

  <div class="hud-center" id="hud-center"></div>
  <div class="hud-wrongway" id="hud-wrongway">WRONG WAY</div>
  <div class="hud-toast" id="hud-toast"></div>

  <div class="hud-hints" id="hud-hints">W/S drive &middot; A/D steer &middot; SPACE drift &middot; Q/E gears &middot; V camera &middot; M transmission &middot; R reset</div>

  <div class="settings-panel" id="settings-panel" style="display:none;">
    <div class="settings-title">SETTINGS</div>
    <div class="settings-row">
      <span class="settings-label">Transmission</span>
      <div class="settings-seg" id="set-trans">
        <button data-v="auto" type="button">AUTO</button>
        <button data-v="manual" type="button">MANUAL</button>
      </div>
    </div>
    <div class="settings-row">
      <span class="settings-label">Camera</span>
      <div class="settings-seg" id="set-cam">
        <button data-v="chase" type="button">CHASE</button>
        <button data-v="hood" type="button">HOOD</button>
        <button data-v="cockpit" type="button">COCKPIT</button>
      </div>
    </div>
    <div class="settings-row">
      <span class="settings-label">Graphics</span>
      <div class="settings-seg" id="set-quality">
        <button data-v="low" type="button">LOW</button>
        <button data-v="medium" type="button">MED</button>
        <button data-v="high" type="button">HIGH</button>
      </div>
    </div>
    <div class="settings-row">
      <span class="settings-label">Paint</span>
      <div class="settings-seg settings-paints" id="set-paint">
        <button data-v="guardsRed" type="button" title="Guards Red" style="--pc:#c00d1e"></button>
        <button data-v="gtSilver" type="button" title="GT Silver" style="--pc:#d6d8dc"></button>
        <button data-v="nightBlue" type="button" title="Night Blue" style="--pc:#12306e"></button>
        <button data-v="speedYellow" type="button" title="Speed Yellow" style="--pc:#e8c414"></button>
        <button data-v="jetBlack" type="button" title="Jet Black" style="--pc:#0a0b0d"></button>
        <button data-v="irishGreen" type="button" title="Irish Green" style="--pc:#0f5132"></button>
        <button data-v="arcticGrey" type="button" title="Arctic Grey" style="--pc:#8b9096"></button>
        <button data-v="orange" type="button" title="Lava Orange" style="--pc:#e05206"></button>
      </div>
    </div>
    <div class="settings-row">
      <span class="settings-label">Master volume</span>
      <input type="range" id="set-master" min="0" max="1" step="0.05">
    </div>
    <div class="settings-row">
      <span class="settings-label">Engine volume</span>
      <input type="range" id="set-engine" min="0" max="1" step="0.05">
    </div>
    <div class="settings-row">
      <span class="settings-label">Steering speed</span>
      <input type="range" id="set-steer" min="0.6" max="1.4" step="0.05">
    </div>
    <div class="settings-row">
      <span class="settings-label">Camera smoothing</span>
      <input type="range" id="set-camsmooth" min="0.6" max="1.4" step="0.05">
    </div>
    <button class="settings-close" id="set-close" type="button">CLOSE</button>
  </div>
</div>
`;

export class HUD {
  constructor(callbacks = {}) {
    this.root = document.getElementById('hud-root');
    this.root.innerHTML = TEMPLATE;
    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('hud'),
      vignette: $('hud-vignette'),
      lap: $('hud-lap'),
      pips: $('hud-pips'),
      laptime: $('hud-laptime'),
      total: $('hud-total'),
      best: $('hud-best'),
      center: $('hud-center'),
      wrongway: $('hud-wrongway'),
      toast: $('hud-toast'),
      soundLabel: $('hud-sound-label'),
      soundWave: $('hud-sound-wave'),
      modeTrans: $('hud-mode-trans'),
      modeCam: $('hud-mode-cam'),
      tach: $('hud-tach-canvas')
    };
    this.root.style.display = 'none';

    $('hud-reset').addEventListener('click', () => callbacks.onReset && callbacks.onReset());
    $('hud-restart').addEventListener('click', () => callbacks.onRestart && callbacks.onRestart());
    $('hud-sound').addEventListener('click', () => callbacks.onMuteToggle && callbacks.onMuteToggle());
    $('hud-settings').addEventListener('click', () => this.toggleSettings());

    // ---- settings panel --------------------------------------------------
    this.settingsCb = callbacks.onSettingsChange || (() => {});
    this._wireSeg('set-trans', (v) => this.settingsCb('transmission', v));
    this._wireSeg('set-cam', (v) => this.settingsCb('camera', v));
    this._wireSeg('set-quality', (v) => this.settingsCb('quality', v));
    this._wireSeg('set-paint', (v) => this.settingsCb('paint', v));
    const wireRange = (id, key) => {
      const el = $(id);
      el.addEventListener('input', () => this.settingsCb(key, parseFloat(el.value)));
    };
    wireRange('set-master', 'masterVolume');
    wireRange('set-engine', 'engineVolume');
    wireRange('set-steer', 'steerSensitivity');
    wireRange('set-camsmooth', 'cameraSmoothing');
    $('set-close').addEventListener('click', () => this.toggleSettings(false));

    this._toastTimer = null;
    this._tachCtx = this.el.tach.getContext('2d');
    this._tachState = { rpmNorm: 0, speed: 0, gear: 'N', limiter: false, mode: 'auto' };
  }

  _wireSeg(id, cb) {
    const seg = document.getElementById(id);
    seg.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        cb(b.dataset.v);
      });
    });
  }

  /** reflect current settings into the panel controls */
  syncSettings(data) {
    const mark = (id, v) => {
      const seg = document.getElementById(id);
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === v));
    };
    mark('set-trans', data.transmission);
    mark('set-cam', data.camera);
    mark('set-quality', data.quality);
    if (data.paint) mark('set-paint', data.paint);
    document.getElementById('set-master').value = data.masterVolume;
    document.getElementById('set-engine').value = data.engineVolume;
    document.getElementById('set-steer').value = data.steerSensitivity;
    document.getElementById('set-camsmooth').value = data.cameraSmoothing;
  }

  toggleSettings(force) {
    const panel = document.getElementById('settings-panel');
    const show = force !== undefined ? force : panel.style.display === 'none';
    panel.style.display = show ? '' : 'none';
  }

  get settingsOpen() {
    return document.getElementById('settings-panel').style.display !== 'none';
  }

  show() {
    this.root.style.display = '';
  }

  markTouch() {
    this.el.hud.classList.add('hud--touch');
    this.el.hud.classList.add('hud--hide-hints');
  }

  setCockpitMode(on) {
    // Kept for backwards-compat with Game.js calls; the hood cam doesn't
    // need any HUD class toggles so this is a no-op now.
  }

  setModes(trans, cam) {
    this.el.modeTrans.textContent = trans === 'manual' ? 'MANUAL' : 'AUTO';
    this.el.modeTrans.classList.toggle('manual', trans === 'manual');
    const camLabel = cam === 'cockpit' ? 'COCKPIT' : cam === 'hood' ? 'HOOD' : 'CHASE';
    this.el.modeCam.textContent = camLabel;
  }

  update(phys, race, trans) {
    const s = this._tachState;
    s.rpmNorm = trans ? trans.rpmNorm : 0;
    s.speed = phys.speedKmh;
    s.gear = trans ? trans.gearLabel : (phys.reversing ? 'R' : 'N');
    s.limiter = trans ? trans.limiterCut : false;
    this._drawTach();

    // night vignette: closes in with speed — tunnel-vision rush
    const speedN = Math.min(1, Math.abs(phys.vF || 0) / 66);
    this.el.vignette.style.opacity = (0.32 + speedN * 0.42).toFixed(3);

    this.el.lap.textContent = String(race.lap);
    this.el.laptime.textContent = formatTime(race.state === 'racing' ? race.lapTime : 0);
    this.el.total.textContent = formatTime(race.state === 'racing' || race.state === 'finished' ? race.totalTime : 0);
    this.el.best.textContent = formatTime(race.bestLap);

    const pips = this.el.pips.children;
    for (let i = 0; i < pips.length; i++) {
      pips[i].classList.toggle('done', race.checkpoints[i]);
      pips[i].classList.toggle('next', i === race.nextCp && race.state === 'racing');
    }
  }

  /** canvas tachometer: arc gauge + needle + shift lights + speed + gear */
  _drawTach() {
    const ctx = this._tachCtx;
    const s = this._tachState;
    const W = 170, H = 170;
    const cx = W / 2, cy = H / 2 + 6;
    const r = 62;

    ctx.clearRect(0, 0, W, H);

    // dial face
    ctx.beginPath();
    ctx.arc(cx, cy, r + 16, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10, 14, 20, 0.72)';
    ctx.fill();

    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;

    // redline zone
    ctx.lineWidth = 9;
    ctx.strokeStyle = 'rgba(216, 52, 42, 0.85)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0 + (a1 - a0) * 0.88, a1);
    ctx.stroke();

    // base track
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.stroke();

    // active arc
    const hot = s.limiter || s.rpmNorm > 0.88;
    ctx.strokeStyle = hot ? '#ff5040' : (s.rpmNorm > 0.7 ? '#ffb014' : '#35e0ff');
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * Math.min(1, s.rpmNorm));
    ctx.stroke();

    // ticks
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (a1 - a0) * (i / 8);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r - 11), cy + Math.sin(a) * (r - 11));
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.stroke();
    }

    // needle
    const na = a0 + (a1 - a0) * Math.min(1.02, Math.max(0, s.rpmNorm));
    ctx.strokeStyle = '#f2f6fa';
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(na) * 10, cy - Math.sin(na) * 10);
    ctx.lineTo(cx + Math.cos(na) * (r - 12), cy + Math.sin(na) * (r - 12));
    ctx.stroke();
    ctx.fillStyle = '#f2f6fa';
    ctx.beginPath();
    ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // shift lights (top)
    const lit = Math.min(6, Math.floor(s.rpmNorm * 6.5));
    for (let i = 0; i < 6; i++) {
      const a = Math.PI * 1.22 + i * 0.095;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * (r - 22), cy + Math.sin(a) * (r - 22), 3.2, 0, Math.PI * 2);
      ctx.fillStyle = i < lit ? (i >= 4 ? '#ff5040' : '#3ddc84') : 'rgba(255,255,255,0.12)';
      ctx.fill();
    }

    // gear (center-bottom)
    ctx.textAlign = 'center';
    ctx.fillStyle = s.gear === 'R' ? '#ffb014' : s.gear === 'N' ? '#8b96a3' : '#f2f6fa';
    ctx.font = '900 46px system-ui, sans-serif';
    ctx.fillText(s.gear, cx, cy + 40);

    // speed (below gear)
    ctx.fillStyle = '#8b96a3';
    ctx.font = '700 15px system-ui, sans-serif';
    ctx.fillText(String(Math.round(s.speed)), cx, cy + 60);
    ctx.font = '600 8px system-ui, sans-serif';
    ctx.fillText('KM/H', cx, cy + 70);
  }

  showCountdown(text) {
    const el = this.el.center;
    el.textContent = text;
    el.classList.toggle('go', text === 'GO!');
    el.classList.remove('pop');
    void el.offsetWidth; // restart CSS animation
    el.classList.add('pop');
    if (text === 'GO!') {
      setTimeout(() => { if (el.textContent === 'GO!') el.textContent = ''; }, 900);
    }
  }

  setWrongWay(show) {
    this.el.wrongway.classList.toggle('visible', show);
  }

  showLapToast(text) {
    const el = this.el.toast;
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  setMuted(muted) {
    this.el.soundLabel.textContent = muted ? 'OFF' : 'ON';
    if (this.el.soundWave) this.el.soundWave.style.opacity = muted ? '0.15' : '1';
  }

  showFinish(summary) {
    const $ = (id) => document.getElementById(id);
    $('finish-total').textContent = formatTime(summary.totalTime);
    $('finish-best').textContent = formatTime(summary.bestLap);
    $('finish-newbest').style.display = summary.newRecord ? '' : 'none';
    const laps = $('finish-laps');
    laps.innerHTML = '';
    summary.lapTimes.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'finish-lap-row';
      const isBest = t === summary.bestLap;
      row.innerHTML = `<span>LAP ${i + 1}${isBest ? ' · BEST' : ''}</span><b>${formatTime(t)}</b>`;
      laps.appendChild(row);
    });
    $('finish-screen').style.display = '';
  }

  hideFinish() {
    document.getElementById('finish-screen').style.display = 'none';
  }
}
