/**
 * HUD — DOM-based racing HUD: speed & gear, lap counter with checkpoint
 * pips, lap / total / best times, reset-restart-sound buttons, countdown
 * display, lap toasts, wrong-way warning and the finish panel binding.
 */

import { formatTime } from '../game/Race.js';

const TEMPLATE = `
<div class="hud" id="hud">
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
  </div>

  <div class="hud-speed">
    <div class="hud-speed-num" id="hud-speed">0</div>
    <div class="hud-speed-unit">KM/H &middot; GEAR <b id="hud-gear">N</b></div>
  </div>

  <div class="hud-center" id="hud-center"></div>
  <div class="hud-wrongway" id="hud-wrongway">WRONG WAY</div>
  <div class="hud-toast" id="hud-toast"></div>

  <div class="hud-hints" id="hud-hints">W / S throttle &amp; brake &middot; A / D steer &middot; SPACE drift &middot; R reset</div>
</div>
`;

export class HUD {
  constructor(callbacks = {}) {
    this.root = document.getElementById('hud-root');
    this.root.innerHTML = TEMPLATE;
    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('hud'),
      lap: $('hud-lap'),
      pips: $('hud-pips'),
      laptime: $('hud-laptime'),
      total: $('hud-total'),
      best: $('hud-best'),
      speed: $('hud-speed'),
      gear: $('hud-gear'),
      center: $('hud-center'),
      wrongway: $('hud-wrongway'),
      toast: $('hud-toast'),
      soundLabel: $('hud-sound-label'),
      soundWave: $('hud-sound-wave')
    };
    this.root.style.display = 'none';

    $('hud-reset').addEventListener('click', () => callbacks.onReset && callbacks.onReset());
    $('hud-restart').addEventListener('click', () => callbacks.onRestart && callbacks.onRestart());
    $('hud-sound').addEventListener('click', () => callbacks.onMuteToggle && callbacks.onMuteToggle());

    this._toastTimer = null;
  }

  show() {
    this.root.style.display = '';
  }

  markTouch() {
    this.el.hud.classList.add('hud--touch');
    this.el.hud.classList.add('hud--hide-hints');
  }

  update(phys, race) {
    this.el.speed.textContent = String(Math.round(phys.speedKmh));
    this.el.gear.textContent = phys.reversing ? 'R' : (Math.abs(phys.vF) < 0.5 ? 'N' : String(phys.gear));
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
