/**
 * HUD — the finished-game interface layer:
 *  - canvas tachometer (needle, redline, shift lights) + big gear + speed
 *  - status panel: road, region/city, world clock, weather, distance, seed
 *  - minimap radar (top-right)
 *  - waypoint strip with live distance + bearing
 *  - world map overlay (Tab) with click-to-waypoint + teleport
 *  - settings panel (graphics, bloom, traffic, weather, multiplayer…)
 *  - toasts + connection badge
 */

import { Minimap } from './Minimap.js';
import { WorldMap } from './WorldMap.js';

const TEMPLATE = `
<div class="hud" id="hud">
  <div class="hud-vignette" id="hud-vignette"></div>

  <div class="hud-panel hud-status">
    <div class="hud-status-top">
      <span class="hud-road" id="hud-road">HIGHWAY</span>
      <span class="hud-region" id="hud-region">PLAINS</span>
    </div>
    <div class="hud-stat-row"><span>POS</span><b id="hud-pos">0, 0</b></div>
    <div class="hud-stat-row"><span>ALT</span><b id="hud-alt">0 m</b></div>
    <div class="hud-stat-row"><span>TRIP</span><b id="hud-odo">0.0 km</b></div>
    <div class="hud-stat-row"><span>CLOCK</span><b id="hud-clock">12:00</b></div>
    <div class="hud-stat-row"><span>SKY</span><b id="hud-weather">CLEAR</b></div>
    <div class="hud-stat-row"><span>SEED</span><b id="hud-seed">—</b></div>
    <div class="hud-stat-row" id="hud-netrow"><span>ONLINE</span><b id="hud-net">OFF</b></div>
  </div>

  <div class="hud-buttons">
    <button class="hud-btn" id="hud-sound" type="button" title="Toggle sound">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l6 5V4L8 9H4z"/><path id="hud-sound-wave" fill="currentColor" d="M16.5 8.5a5 5 0 0 1 0 7l1.4 1.4a7 7 0 0 0 0-9.8l-1.4 1.4z"/></svg>
      <span id="hud-sound-label">ON</span>
    </button>
    <button class="hud-btn" id="hud-map" type="button" title="World map (Tab)">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M20.5 3l-6 2-5-2-6 2v16l6-2 5 2 6-2V3zm-11 2.3l3 1.2v12.4l-3-1.2V5.3zM5 6.6l2.5-.8v12.4L5 18.9V6.6zm14 10.8l-2.5.8V5.9l2.5-.8v12.3z"/></svg>
      <span>MAP</span>
    </button>
    <button class="hud-btn" id="hud-recenter" type="button" title="Back on the road (R)">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>
      <span>RECENTER</span>
    </button>
    <button class="hud-btn" id="hud-newroad" type="button" title="Generate a new world (N)">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2zm1 0v6.6l2.6-2.6L17 7.4 12.4 12 17 16.6 15.6 18l-2.6-2.6V22h-2v-2.6L8.4 22 7 20.6 11.6 16 7 11.4 8.4 10l2.6 2.6V2h2z" opacity=".0"/><path fill="currentColor" d="M6.2 3c-.5 0-.9.4-.9.9v3.2c0 .5.4.9.9.9h4.4v3.4c-2.6.6-4.6 2.9-4.6 5.7 0 3.2 2.6 5.8 5.8 5.8s5.8-2.6 5.8-5.8c0-2.8-2-5.1-4.6-5.7V8h1.6c.5 0 .9-.4.9-.9V3.9c0-.5-.4-.9-.9-.9H6.2z"/></svg>
      <span>NEW WORLD</span>
    </button>
    <button class="hud-btn" id="hud-settings" type="button" title="Settings (Esc)">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.6a.5.5 0 0 0 .1-.7l-2-3.4a.5.5 0 0 0-.6-.2l-2.5 1a7.7 7.7 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 0-.5.4l-.4 2.7a7.7 7.7 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.4a.5.5 0 0 0 .1.7L4.5 11a7.6 7.6 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.7l2 3.4c.1.2.4.3.6.2l2.5-1a7.7 7.7 0 0 0 1.7 1l.4 2.6c0 .3.2.5.5.5h4c.2 0 .5-.2.5-.4l.4-2.7a7.7 7.7 0 0 0 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.4a.5.5 0 0 0-.1-.7L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>
      <span>SETTINGS</span>
    </button>
  </div>

  <div class="hud-minimap">
    <canvas id="hud-minimap-canvas" width="210" height="210"></canvas>
  </div>

  <div class="hud-waypoint" id="hud-waypoint" style="display:none;">
    <svg id="hud-waypoint-arrow" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2l6 18-6-4-6 4z"/></svg>
    <span id="hud-waypoint-dist">—</span>
    <button id="hud-waypoint-clear" type="button">CLEAR</button>
  </div>

  <div class="hud-tach">
    <canvas id="hud-tach-canvas" width="180" height="180"></canvas>
    <div class="hud-modes">
      <span class="hud-mode" id="hud-mode-trans">AUTO</span>
      <span class="hud-mode" id="hud-mode-cam">CHASE</span>
      <span class="hud-mode hud-abs" id="hud-mode-abs">ABS</span>
    </div>
  </div>

  <div class="hud-toast" id="hud-toast"></div>

  <div class="hud-hints" id="hud-hints">W/S drive &middot; A/D steer &middot; SPACE handbrake &middot; Q/E gears &middot; V camera &middot; TAB map &middot; R recenter &middot; N new world</div>

  <div class="worldmap-overlay" id="worldmap-overlay" style="display:none;">
    <div class="worldmap-head">
      <span>WORLD MAP</span>
      <span class="worldmap-sub" id="worldmap-info">click to set waypoint &middot; scroll to zoom</span>
      <button class="worldmap-btn" id="worldmap-teleport" type="button">TELEPORT TO WAYPOINT</button>
      <button class="worldmap-btn" id="worldmap-close" type="button">CLOSE (TAB)</button>
    </div>
    <canvas id="worldmap-canvas"></canvas>
  </div>

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
      <span class="settings-label">Bloom</span>
      <div class="settings-seg" id="set-bloom">
        <button data-v="on" type="button">ON</button>
        <button data-v="off" type="button">OFF</button>
      </div>
    </div>
    <div class="settings-row">
      <span class="settings-label">Traffic</span>
      <div class="settings-seg" id="set-traffic">
        <button data-v="on" type="button">ON</button>
        <button data-v="off" type="button">OFF</button>
      </div>
    </div>
    <div class="settings-row">
      <span class="settings-label">Weather</span>
      <div class="settings-seg" id="set-weather">
        <button data-v="on" type="button">DYNAMIC</button>
        <button data-v="off" type="button">CALM</button>
      </div>
    </div>
    <div class="settings-row">
      <span class="settings-label">Day cycle</span>
      <div class="settings-seg" id="set-cycle">
        <button data-v="on" type="button">ON</button>
        <button data-v="off" type="button">FROZEN</button>
      </div>
    </div>
    <div class="settings-row">
      <span class="settings-label">Day length</span>
      <input type="range" id="set-daylen" min="240" max="3600" step="60">
    </div>
    <div class="settings-row">
      <span class="settings-label">Multiplayer</span>
      <div class="settings-seg" id="set-mp">
        <button data-v="on" type="button">ON</button>
        <button data-v="off" type="button">OFF</button>
      </div>
    </div>
    <div class="settings-row">
      <span class="settings-label">Driver name</span>
      <input type="text" id="set-name" maxlength="14" placeholder="DRIVER" autocomplete="off">
    </div>
    <div class="settings-row">
      <span class="settings-label">Paint</span>
      <div class="settings-seg settings-paints" id="set-paint">
        <button data-v="guardsRed" type="button" title="Guards Red" style="--pc:#bb0a1e"></button>
        <button data-v="gtSilver" type="button" title="GT Silver" style="--pc:#d4d7d9"></button>
        <button data-v="navarraBlue" type="button" title="Navarra Blue" style="--pc:#0e3a5c"></button>
        <button data-v="speedYellow" type="button" title="Racing Yellow" style="--pc:#f0c020"></button>
        <button data-v="jetBlack" type="button" title="Jet Black" style="--pc:#0c0d0f"></button>
        <button data-v="irishGreen" type="button" title="Oak Green" style="--pc:#11402e"></button>
        <button data-v="arcticGrey" type="button" title="Arctic Grey" style="--pc:#565b61"></button>
        <button data-v="orange" type="button" title="Lava Orange" style="--pc:#d84a1b"></button>
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
    <div class="settings-row settings-seedline">
      <span class="settings-label">World seed</span>
      <b id="set-seed">—</b>
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
      road: $('hud-road'),
      region: $('hud-region'),
      pos: $('hud-pos'),
      alt: $('hud-alt'),
      odo: $('hud-odo'),
      clock: $('hud-clock'),
      weather: $('hud-weather'),
      seed: $('hud-seed'),
      net: $('hud-net'),
      toast: $('hud-toast'),
      soundLabel: $('hud-sound-label'),
      soundWave: $('hud-sound-wave'),
      modeTrans: $('hud-mode-trans'),
      modeCam: $('hud-mode-cam'),
      abs: $('hud-mode-abs'),
      tach: $('hud-tach-canvas'),
      waypoint: $('hud-waypoint'),
      waypointDist: $('hud-waypoint-dist'),
      waypointArrow: $('hud-waypoint-arrow'),
      worldmapInfo: $('worldmap-info')
    };
    this.root.style.display = 'none';

    $('hud-recenter').addEventListener('click', () => callbacks.onRecenter && callbacks.onRecenter());
    $('hud-newroad').addEventListener('click', () => callbacks.onNewRoad && callbacks.onNewRoad());
    $('hud-sound').addEventListener('click', () => callbacks.onMuteToggle && callbacks.onMuteToggle());
    $('hud-settings').addEventListener('click', () => this.toggleSettings());
    $('hud-map').addEventListener('click', () => this.toggleMap());
    $('hud-waypoint-clear').addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onClearWaypoint && callbacks.onClearWaypoint();
      this.el.waypoint.style.display = 'none';
    });

    // ---- world map ---------------------------------------------------------
    this.worldMap = new WorldMap($('worldmap-canvas'), {
      onSetWaypoint: (x, z) => callbacks.onSetWaypoint && callbacks.onSetWaypoint(x, z),
      onTeleport: (x, z) => callbacks.onTeleport && callbacks.onTeleport(x, z)
    });
    $('worldmap-close').addEventListener('click', () => this.toggleMap(false));
    $('worldmap-teleport').addEventListener('click', () => {
      this.worldMap.teleportWaypoint();
      this.toggleMap(false);
    });

    // ---- settings panel --------------------------------------------------
    this.settingsCb = callbacks.onSettingsChange || (() => {});
    this._wireSeg('set-trans', (v) => this.settingsCb('transmission', v));
    this._wireSeg('set-cam', (v) => this.settingsCb('camera', v));
    this._wireSeg('set-quality', (v) => this.settingsCb('quality', v));
    this._wireSeg('set-bloom', (v) => this.settingsCb('bloom', v === 'on'));
    this._wireSeg('set-traffic', (v) => this.settingsCb('traffic', v === 'on'));
    this._wireSeg('set-weather', (v) => this.settingsCb('weather', v === 'on'));
    this._wireSeg('set-cycle', (v) => this.settingsCb('dayCycle', v === 'on'));
    this._wireSeg('set-mp', (v) => this.settingsCb('multiplayer', v === 'on'));
    this._wireSeg('set-paint', (v) => this.settingsCb('paint', v));
    const wireRange = (id, key, cast = parseFloat) => {
      const el = $(id);
      el.addEventListener('input', () => this.settingsCb(key, cast(el.value)));
    };
    wireRange('set-master', 'masterVolume');
    wireRange('set-engine', 'engineVolume');
    wireRange('set-steer', 'steerSensitivity');
    wireRange('set-camsmooth', 'cameraSmoothing');
    wireRange('set-daylen', 'dayLength');
    const nameEl = $('set-name');
    nameEl.addEventListener('change', () => this.settingsCb('playerName', nameEl.value.slice(0, 14)));
    $('set-close').addEventListener('click', () => this.toggleSettings(false));

    this._toastTimer = null;
    this._tachCtx = this.el.tach.getContext('2d');
    this._tachState = { rpmNorm: 0, speed: 0, gear: 'N', limiter: false };
    this.minimap = new Minimap($('hud-minimap-canvas'));
    this._statusAcc = 0;
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
    const mark = (id, v, map = (x) => String(x)) => {
      const seg = document.getElementById(id);
      if (!seg) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === map(v)));
    };
    mark('set-trans', data.transmission);
    mark('set-cam', data.camera);
    mark('set-quality', data.quality);
    mark('set-bloom', data.bloom, (x) => (x ? 'on' : 'off'));
    mark('set-traffic', data.traffic, (x) => (x ? 'on' : 'off'));
    mark('set-weather', data.weather, (x) => (x ? 'on' : 'off'));
    mark('set-cycle', data.dayCycle, (x) => (x ? 'on' : 'off'));
    mark('set-mp', data.multiplayer, (x) => (x ? 'on' : 'off'));
    if (data.paint) mark('set-paint', data.paint);
    document.getElementById('set-master').value = data.masterVolume;
    document.getElementById('set-engine').value = data.engineVolume;
    document.getElementById('set-steer').value = data.steerSensitivity;
    document.getElementById('set-camsmooth').value = data.cameraSmoothing;
    document.getElementById('set-daylen').value = data.dayLength;
    document.getElementById('set-name').value = data.playerName || '';
  }

  toggleSettings(force) {
    const panel = document.getElementById('settings-panel');
    const show = force !== undefined ? force : panel.style.display === 'none';
    panel.style.display = show ? '' : 'none';
    if (show) this.toggleMap(false);
  }

  get settingsOpen() {
    return document.getElementById('settings-panel').style.display !== 'none';
  }

  toggleMap(force) {
    const overlay = document.getElementById('worldmap-overlay');
    const show = force !== undefined ? force : overlay.style.display === 'none';
    if (show) {
      this.worldMap.show();
      overlay.style.display = '';
      this.toggleSettings(false);
    } else {
      this.worldMap.hide();
      overlay.style.display = 'none';
    }
  }

  get mapOpen() {
    return document.getElementById('worldmap-overlay').style.display !== 'none';
  }

  show() {
    this.root.style.display = '';
  }

  markTouch() {
    this.el.hud.classList.add('hud--touch');
    this.el.hud.classList.add('hud--hide-hints');
  }

  setCockpitMode(on) {
    // reserved for cockpit-specific HUD tweaks
  }

  setModes(trans, cam) {
    this.el.modeTrans.textContent = trans === 'manual' ? 'MANUAL' : 'AUTO';
    this.el.modeTrans.classList.toggle('manual', trans === 'manual');
    const camLabel = cam === 'cockpit' ? 'COCKPIT' : cam === 'hood' ? 'HOOD' : 'CHASE';
    this.el.modeCam.textContent = camLabel;
  }

  /**
   * Per-frame update. `ctx` carries world/weather/net/waypoint context.
   * Heavy status text refreshes at 4 Hz; tach + minimap run on their own
   * cadences.
   */
  update(phys, journey, trans, ctx = {}) {
    const s = this._tachState;
    s.rpmNorm = trans ? trans.rpmNorm : 0;
    s.speed = phys.speedKmh;
    s.gear = trans ? trans.gearLabel : (phys.reversing ? 'R' : 'N');
    s.limiter = trans ? trans.limiterCut : false;
    if (this.el.abs) this.el.abs.classList.toggle('on', !!phys.absActive);
    this._drawTach();

    // vignette: closes in with speed
    const speedN = Math.min(1, Math.abs(phys.vF || 0) / 66);
    this.el.vignette.style.opacity = (0.22 + speedN * 0.38).toFixed(3);

    // minimap (~8 Hz internally)
    this.minimap.update(1 / 60, ctx.world, phys.position,
      ctx.trafficVehicles || [],
      ctx.net ? ctx.net.peerPositions() : [],
      ctx.waypoint);

    // map data (only when open)
    if (this.mapOpen && ctx.world) {
      this.worldMap.update(phys.position, ctx.world,
        ctx.trafficVehicles || [],
        ctx.net ? ctx.net.peerPositions() : [],
        ctx.waypoint, journey.seed);
    }

    // waypoint strip
    if (ctx.waypoint) {
      this.el.waypoint.style.display = '';
      const dx = ctx.waypoint.x - phys.position.x;
      const dz = ctx.waypoint.z - phys.position.z;
      const dist = Math.hypot(dx, dz);
      this.el.waypointDist.textContent =
        dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m';
      // arrow: screen-space bearing relative to car heading
      const bearing = Math.atan2(dx, dz) - phys.heading;
      this.el.waypointArrow.style.transform = `rotate(${-bearing}rad)`;
    } else {
      this.el.waypoint.style.display = 'none';
    }

    // ---- status text at 4 Hz -------------------------------------------------
    this._statusAcc += 1 / 60;
    if (this._statusAcc < 0.25) return;
    this._statusAcc = 0;

    this.el.odo.textContent = (journey.distance / 1000).toFixed(1) + ' km';
    this.el.alt.textContent = `${Math.round(journey.altitude)} m`;
    this.el.seed.textContent = String(journey.seed).slice(0, 8);
    this.el.pos.textContent =
      `${Math.round(phys.position.x)}, ${Math.round(phys.position.z)}`;

    // road + region
    let region = 'WILDERNESS';
    const q = ctx.world ? ctx.world.locate(phys.position.x, phys.position.z) : null;
    this.el.road.textContent = phys.roadLabel || 'OFF-ROAD';
    if (ctx.world) {
      const city = ctx.world.cities.nearest(phys.position.x, phys.position.z, 1800);
      if (city && Math.hypot(city.x - phys.position.x, city.z - phys.position.z) < city.radius + 120) {
        region = city.name.toUpperCase();
      } else {
        const b = ctx.world.terrain.biome(phys.position.x, phys.position.z);
        region = ['OCEAN', 'COAST', 'PLAINS', 'FOREST', 'DESERT', 'MOUNTAINS', 'HIGHLANDS'][b] || 'PLAINS';
        if (ctx.world.mystery.intensity(phys.position.x, phys.position.z) > 0.45) {
          region = 'THE DEEP — ' + region;
        }
      }
    }
    this.el.region.textContent = region;

    // clock
    const hours = journey.clock * 24;
    const hh = Math.floor(hours);
    const mm = Math.floor((hours - hh) * 60);
    this.el.clock.textContent =
      `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

    // weather + net
    if (ctx.weather) this.el.weather.textContent = ctx.weather.label;
    if (ctx.net) {
      this.el.net.textContent = ctx.net.connected
        ? `${ctx.net.onlineCount} · ${ctx.net.ping}ms`
        : 'OFF';
      this.el.net.style.color = ctx.net.connected ? '#3ddc84' : '';
    }
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
