/**
 * HUD — minimal, glanceable, thumb-safe.
 *
 * Top-center: banked score + best. Below it: the live chain (combo × pending)
 * which pops while drifting. Top-right: speed + a drift-angle needle bar.
 * Center: transient popups (BANKED / CRASHED / SPIN OUT / zone multipliers).
 * Everything sits in the safe-area insets and never overlaps the controls.
 */
export class HUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="hud-top">
        <div class="hud-score-block">
          <div class="hud-score" id="hud-score">0</div>
          <div class="hud-best" id="hud-best"></div>
        </div>
        <div class="hud-chain" id="hud-chain">
          <span class="hud-combo" id="hud-combo">×1.0</span>
          <span class="hud-pending" id="hud-pending">+0</span>
        </div>
      </div>
      <div class="hud-right">
        <div class="hud-speed" id="hud-speed">0</div>
        <div class="hud-kmh">km/h</div>
        <div class="hud-angle-wrap" id="hud-angle-wrap">
          <div class="hud-angle-track"><div class="hud-angle-needle" id="hud-needle"></div></div>
          <div class="hud-angle-label" id="hud-angle">0°</div>
        </div>
      </div>
      <div class="hud-zone" id="hud-zone"></div>
      <div class="hud-popup" id="hud-popup"></div>
      <div class="hud-toast" id="hud-toast"></div>
    `;
    this.elScore = root.querySelector('#hud-score');
    this.elBest = root.querySelector('#hud-best');
    this.elChain = root.querySelector('#hud-chain');
    this.elCombo = root.querySelector('#hud-combo');
    this.elPending = root.querySelector('#hud-pending');
    this.elSpeed = root.querySelector('#hud-speed');
    this.elAngleWrap = root.querySelector('#hud-angle-wrap');
    this.elNeedle = root.querySelector('#hud-needle');
    this.elAngle = root.querySelector('#hud-angle');
    this.elZone = root.querySelector('#hud-zone');
    this.elPopup = root.querySelector('#hud-popup');
    this.elToast = root.querySelector('#hud-toast');
    this._lastScore = -1;
    this._lastSpeed = -1;
    this._zoneLast = -1;
    this._popupTimer = null;
    this._toastTimer = null;
  }

  show() { this.root.style.display = 'block'; }
  hide() { this.root.style.display = 'none'; }

  setSeed(seed, best) {
    this.setBest(best || 0);
  }

  setBest(best) {
    this.elBest.textContent = best > 0 ? `BEST ${fmt(best)}` : '';
  }

  update(phys, sc, zoneMult) {
    // score (only touch DOM on change)
    const total = Math.round(sc.total);
    if (total !== this._lastScore) {
      this._lastScore = total;
      this.elScore.textContent = fmt(total);
    }

    // live chain
    const pending = Math.round(sc.pending);
    if (sc.pending > 0) {
      this.elChain.classList.add('hud-live');
      this.elCombo.textContent = `×${sc.combo.toFixed(1)}`;
      this.elPending.textContent = `+${fmt(pending)}`;
      this.elCombo.style.transform = `scale(${1 + Math.min(0.5, (sc.combo - 1) * 0.06)})`;
    } else {
      this.elChain.classList.remove('hud-live');
    }

    // speed
    const kmh = Math.round(phys.speed * 3.6);
    if (kmh !== this._lastSpeed) {
      this._lastSpeed = kmh;
      this.elSpeed.textContent = kmh;
    }

    // drift angle needle (±90°)
    const deg = phys.beta * 180 / Math.PI;
    if (Math.abs(deg) > 3) {
      this.elAngleWrap.classList.add('hud-live');
      const clamped = Math.max(-90, Math.min(90, deg));
      this.elNeedle.style.left = `${50 + clamped / 2}%`;
      this.elAngle.textContent = `${Math.abs(Math.round(deg))}°`;
      this.elNeedle.style.background = Math.abs(deg) > 45 ? '#ff3b30' : '#ffd75e';
    } else {
      this.elAngleWrap.classList.remove('hud-live');
    }

    // zone chip
    const z = zoneMult >= 2 ? zoneMult : 0;
    if (z !== this._zoneLast) {
      this._zoneLast = z;
      if (z) {
        this.elZone.textContent = `DRIFT ZONE ×${z === 3 ? '3' : '2'}`;
        this.elZone.classList.add('hud-live');
        this.elZone.classList.toggle('zone-3', z === 3);
      } else {
        this.elZone.classList.remove('hud-live');
      }
    }
  }

  popup(type, value, best) {
    let html = '';
    if (type === 'bank') {
      html = `<div class="pop pop-bank">+${fmt(value)}</div><div class="pop-sub">BANKED</div>`;
    } else if (type === 'crash') {
      html = `<div class="pop pop-bad">CRASHED</div><div class="pop-sub">chain lost</div>`;
    } else if (type === 'spinout') {
      html = `<div class="pop pop-bad">SPIN OUT</div><div class="pop-sub">chain lost</div>`;
    }
    this.elPopup.innerHTML = html;
    this.elPopup.classList.remove('pop-anim');
    void this.elPopup.offsetWidth; // restart CSS animation
    this.elPopup.classList.add('pop-anim');
    clearTimeout(this._popupTimer);
    this._popupTimer = setTimeout(() => { this.elPopup.innerHTML = ''; }, 1400);
  }

  toast(text) {
    this.elToast.textContent = text;
    this.elToast.classList.add('hud-live');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.elToast.classList.remove('hud-live'), 2200);
  }
}

function fmt(n) {
  return Math.round(n).toLocaleString('en-US');
}
