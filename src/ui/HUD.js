/**
 * HUD — DOM-based driving HUD for endless journey mode:
 *  - canvas tachometer (needle, redline arc, shift lights) with big gear
 *    indicator and digital speed
 *  - journey panel: distance odometer, altitude, road seed (no timers —
 *    this is a relaxing drive, not a race)
 *  - transmission + camera mode badges
 *  - recenter / new road / sound / settings buttons
 *  - settings panel (persisted via game Settings)
 *  - toasts
 */

const TEMPLATE = `
<div class="hud" id="hud">
  <div class="hud-vignette" id="hud-vignette"></div>
  <div class="hud-panel hud-journey">
    <div class="hud-journey-row">
      <span class="hud-label">JOURNEY</span>
      <span class="hud-odo"><b id="hud-odo">0.0</b><i>km</i></span>
    </div>
    <div class="hud-stat-row"><span>ALT</span><b id="hud-alt">0 m</b></div>
    <div class="hud-stat-row"><span>SEED</span><b id="hud-seed">—</b></div>
  </div>

  <div class="hud-buttons">
    <button class="hud-btn" id="hud-sound" type="button" title="Toggle sound">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l6 5V4L8 9H4z"/><path id="hud-sound-wave" fill="currentColor" d="M16.5 8.5a5 5 0 0 1 0 7l1.4 1.4a7 7 0 0 0 0-9.8l-1.4 1.4z"/></svg>
      <span id="hud-sound-label">ON</span>
    </button>
    <button class="hud-btn" id="hud-recenter" type="button" title="Back on the road (R)">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>
      <span>RECENTER</span>
    </button>
    <button class="hud-btn" id="hud-newroad" type="button" title="Generate a new road (N)">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.2 3c-.5 0-.9.4-.9.9v3.2c0 .5.4.9.9.9h4.4v3.4c-2.6.6-4.6 2.9-4.6 5.7 0 3.2 2.6 5.8 5.8 5.8s5.8-2.6 5.8-5.8c0-2.8-2-5.1-4.6-5.7V8h1.6c.5 0 .9-.4.9-.9V3.9c0-.5-.4-.9-.9-.9H6.2z"/></svg>
      <span>NEW ROAD</span>
    </button>
    <button class="hud-btn" id="hud-settings" type="button" title="Settings (Esc)">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.6a.5.5 0 0 0 .1-.7l-2-3.4a.5.5 0 0 0-.6-.2l-2.5 1a7.7 7.7 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 0-.5.4l-.4 2.7a7.7 7.7 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.4a.5.5 0 0 0 .1.7L4.5 11a7.6 7.6 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.7l2 3.4c.1.2.4.3.6.2l2.5-1a7.7 7.7 0 0 0 1.7 1l.4 2.6c0 .3.2.5.5.5h4c.2 0 .5-.2.5-.4l.4-2.7a7.7 7.7 0 0 0 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.4a.5.5 0 0 0-.1-.7L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>
      <span>SETTINGS</span>
    </button>
  </div>

  <div class="hud-tach">
    <canvas id="hud-tach-canvas" width="180" height="180"></canvas>
    <div class="hud-modes">
      <span class="hud-mode" id="hud-mode-trans">AUTO</span>
      <span class="hud-mode" id="hud-mode-cam">CHASE</span>
    </div>
  </div>

  <div class="hud-toast" id="hud-toast"></div>

  <div class="hud-hints" id="hud-hints">W/S drive &middot; A/D steer &middot; SPACE handbrake &middot; Q/E gears &middot; V camera &middot; M transmission &middot; R recenter &middot; N new road</div>

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
      <span class="settings-label">Time of day</span>
      <div class="settings-seg" id="set-tod">
        <button data-v="dawn" type="button">DAWN</button>
        <button data-v="day" type="button">DAY</button>
        <button data-v="dusk" type="button">DUSK</button>
        <button data-v="night" type="button">NIGHT</button>
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
      odo: $('hud-odo'),
      alt: $('hud-alt'),
      seed: $('hud-seed'),
      toast: $('hud-toast'),
      soundLabel: $('hud-sound-label'),
      soundWave: $('hud-sound-wave'),
      modeTrans: $('hud-mode-trans'),
      modeCam: $('hud-mode-cam'),
      tach: $('hud-tach-canvas')
    };
    this.root.style.display = 'none';

    $('hud-recenter').addEventListener('click', () => callbacks.onRecenter && callbacks.onRecenter());
    $('hud-newroad').addEventListener('click', () => callbacks.onNewRoad && callbacks.onNewRoad());
    $('hud-sound').addEventListener('click', () => callbacks.onMuteToggle && callbacks.onMuteToggle());
    $('hud-settings').addEventListener('click', () => this.toggleSettings());

    // ---- settings panel --------------------------------------------------
    this.settingsCb = callbacks.onSettingsChange || (() => {});
    this._wireSeg('set-trans', (v) => this.settingsCb('transmission', v));
    this._wireSeg('set-cam', (v) => this.settingsCb('camera', v));
    this._wireSeg('set-tod', (v) => this.settingsCb('timeOfDay', v));
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
    this._tachState = { rpmNorm: 0, speed: 0, gear: 'N', limiter: false };
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
      if (!seg) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === v));
    };
    mark('set-trans', data.transmission);
    mark('set-cam', data.camera);
    mark('set-tod', data.timeOfDay);
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
    // the hood cam doesn't need HUD class toggles — kept for API compat
  }

  setModes(trans, cam) {
    this.el.modeTrans.textContent = trans === 'manual' ? 'MANUAL' : 'AUTO';
    this.el.modeTrans.classList.toggle('manual', trans === 'manual');
    const camLabel = cam === 'cockpit' ? 'COCKPIT' : cam === 'hood' ? 'HOOD' : 'CHASE';
    this.el.modeCam.textContent = camLabel;
  }

  update(phys, journey, trans) {
    const s = this._tachState;
    s.rpmNorm = trans ? trans.rpmNorm : 0;
    s.speed = phys.speedKmh;
    s.gear = trans ? trans.gearLabel : (phys.reversing ? 'R' : 'N');
    s.limiter = trans ? trans.limiterCut : false;
    this._drawTach();

    // vignette: closes in with speed
    const speedN = Math.min(1, Math.abs(phys.vF || 0) / 66);
    this.el.vignette.style.opacity = (0.22 + speedN * 0.38).toFixed(3);

    this.el.odo.textContent = (journey.distance / 1000).toFixed(1);
    this.el.alt.textContent = `${Math.round(journey.altitude)} m`;
    this.el.seed.textContent = String(journey.seed).slice(0, 6);
  }

  /** canvas tachometer: arc gauge + needle + shift lights + speed + gear */
  _drawTach() {
    const ctx = this._tachCtx;
    const s = this._tachState;
    const W = 180, H = 180;
    const cx = W / 2, cy = H / 2 + 5;
    const r = 66;

    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.arc(cx, cy, r + 17, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8, 12, 18, 0.58)';
    ctx.fill();

    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;

    // redline zone
    ctx.lineWidth = 9;
    ctx.strokeStyle = 'rgba(216, 52, 42, 0.9)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0 + (a1 - a0) * 0.88, a1);
    ctx.stroke();

    // base track
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
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
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (a1 - a0) * (i / 8);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r - 11), cy + Math.sin(a) * (r - 11));
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.stroke();
    }
    ctx.lineCap = 'round';

    // needle
    const na = a0 + (a1 - a0) * Math.min(1.02, Math.max(0, s.rpmNorm));
    ctx.strokeStyle = '#f2f6fa';
    ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(na) * 10, cy - Math.sin(na) * 10);
    ctx.lineTo(cx + Math.cos(na) * (r - 13), cy + Math.sin(na) * (r - 13));
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
      ctx.arc(cx + Math.cos(a) * (r - 23), cy + Math.sin(a) * (r - 23), 3.2, 0, Math.PI * 2);
      ctx.fillStyle = i < lit ? (i >= 4 ? '#ff5040' : '#3ddc84') : 'rgba(255,255,255,0.12)';
      ctx.fill();
    }

    // gear (center-bottom)
    ctx.textAlign = 'center';
    ctx.fillStyle = s.gear === 'R' ? '#ffb014' : s.gear === 'N' ? '#8b96a3' : '#f2f6fa';
    ctx.font = '900 44px system-ui, sans-serif';
    ctx.fillText(s.gear, cx, cy + 38);

    // speed (below gear)
    ctx.fillStyle = '#eef3f8';
    ctx.font = '800 21px system-ui, sans-serif';
    ctx.fillText(String(Math.round(s.speed)), cx, cy + 59);
    ctx.fillStyle = '#8b96a3';
    ctx.font = '700 9px system-ui, sans-serif';
    ctx.fillText('KM/H', cx, cy + 71);
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
}
