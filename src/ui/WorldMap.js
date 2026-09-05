/**
 * WorldMap — full-screen map overlay (Tab / MAP button).
 * Draws the road network, cities, traffic, peers, player and waypoint over a
 * ~14 km window. Click sets a waypoint; TELEPORT jumps the car there; seed,
 * coordinates and city labels round it out.
 */

const VIEW = 7000;          // meters half-extent at zoom 1

export class WorldMap {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.callbacks = callbacks;
    this.open = false;
    this.zoom = 1;
    this._center = { x: 0, z: 0 };
    this._dirty = true;
    this._raf = null;
    this._onFrame = this._onFrame.bind(this);

    this.canvas.addEventListener('click', (e) => this._onClick(e));
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.min(3.2, Math.max(0.5, this.zoom * (e.deltaY > 0 ? 0.88 : 1.14)));
      this._dirty = true;
    }, { passive: false });
  }

  show() {
    this.open = true;
    this.canvas.style.display = '';
    this._resize();
    if (!this._raf) this._raf = requestAnimationFrame(this._onFrame);
  }

  hide() {
    this.open = false;
    this.canvas.style.display = 'none';
  }

  toggle() {
    this.open ? this.hide() : this.show();
  }

  _resize() {
    const w = Math.min(window.innerWidth - 60, 1100);
    const h = Math.min(window.innerHeight - 140, 720);
    this.canvas.width = w * 1;
    this.canvas.height = h * 1;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this._dirty = true;
  }

  update(playerPos, world, trafficVehicles, peers, waypoint, seed, force) {
    this.player = playerPos;
    this.world = world;
    this.trafficVehicles = trafficVehicles;
    this.peers = peers;
    this.waypoint = waypoint;
    this.seed = seed;
    if (force || !this.open) {
      this._center.x = playerPos.x;
      this._center.z = playerPos.z;
    }
    if (this.open) this._dirty = true;
  }

  _onFrame() {
    if (!this.open) { this._raf = null; return; }
    if (this._dirty) {
      this._dirty = false;
      this._draw();
    }
    this._raf = requestAnimationFrame(this._onFrame);
  }

  _screenToWorld(sx, sy) {
    const k = this._scale();
    return {
      x: this._center.x + (sx - this.canvas.width / 2) / k,
      z: this._center.z + (sy - this.canvas.height / 2) / k
    };
  }

  _scale() {
    const view = VIEW / this.zoom;
    return (this.canvas.width / 2) / view;
  }

  _onClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const w = this._screenToWorld(sx, sy);
    this.callbacks.onSetWaypoint && this.callbacks.onSetWaypoint(w.x, w.z);
    this._dirty = true;
  }

  teleportWaypoint() {
    if (this.waypoint && this.callbacks.onTeleport) {
      this.callbacks.onTeleport(this.waypoint.x, this.waypoint.z);
    }
  }

  _draw() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const k = this._scale();
    const cx = this._center.x, cz = this._center.z;
    const wx = (x) => W / 2 + (x - cx) * k;
    const wz = (z) => H / 2 + (z - cz) * k;
    const halfW = (W / 2) / k, halfH = (H / 2) / k;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(8, 11, 16, 0.94)';
    ctx.fillRect(0, 0, W, H);

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    const gridStep = 2000;
    for (let gx = Math.floor((cx - halfW) / gridStep) * gridStep; gx < cx + halfW; gx += gridStep) {
      ctx.beginPath();
      ctx.moveTo(wx(gx), 0); ctx.lineTo(wx(gx), H);
      ctx.stroke();
    }
    for (let gz = Math.floor((cz - halfH) / gridStep) * gridStep; gz < cz + halfH; gz += gridStep) {
      ctx.beginPath();
      ctx.moveTo(0, wz(gz)); ctx.lineTo(W, wz(gz));
      ctx.stroke();
    }

    const world = this.world;
    if (!world) return;
    const net = world.network;

    // ---- roads ----
    const routes = net.routesNearAABB(cx - halfW - 200, cz - halfH - 200, cx + halfW + 200, cz + halfH + 200);
    for (const r of routes) {
      const isHwy = r.type === 0;
      ctx.strokeStyle = isHwy ? 'rgba(240,200,90,0.85)' : 'rgba(210,218,226,0.5)';
      ctx.lineWidth = isHwy ? 2.6 : 1.4;
      if (r.kind === 'row' || r.kind === 'col') {
        const alongA = r.kind === 'row' ? cx - halfW - 100 : cz - halfH - 100;
        const alongB = r.kind === 'row' ? cx + halfW + 100 : cz + halfH + 100;
        ctx.beginPath();
        for (let u = alongA; u <= alongB; u += Math.max(30, 200 / this.zoom)) {
          const c = net.coordAt(r, u);
          const x = r.kind === 'row' ? u : c;
          const z = r.kind === 'row' ? c : u;
          if (u === alongA) ctx.moveTo(wx(x), wz(z));
          else ctx.lineTo(wx(x), wz(z));
        }
        ctx.stroke();
      } else if (r.kind === 'ring') {
        ctx.beginPath();
        for (let th = 0; th <= Math.PI * 2 + 0.05; th += 0.05) {
          const rr = world.cities.ringRadiusAt(r.city, th);
          const x = r.city.x + Math.cos(th) * rr;
          const z = r.city.z + Math.sin(th) * rr;
          if (th === 0) ctx.moveTo(wx(x), wz(z));
          else ctx.lineTo(wx(x), wz(z));
        }
        ctx.stroke();
      } else if (r.kind === 'street') {
        const city = r.city;
        const span = city.radius + 60;
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(210,218,226,0.3)';
        ctx.beginPath();
        const p1 = world.cities.streetPoint(city, r, -span);
        const p2 = world.cities.streetPoint(city, r, span);
        ctx.moveTo(wx(p1.x), wz(p1.z));
        ctx.lineTo(wx(p2.x), wz(p2.z));
        ctx.stroke();
      }
    }

    // ---- cities ----
    for (const c of world.cities.near(cx, cz, halfW + halfH + 1200)) {
      const rr = c.radius * k;
      ctx.strokeStyle = 'rgba(150,170,190,0.55)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(wx(c.x), wz(c.z), Math.max(3, rr), 0, Math.PI * 2);
      ctx.stroke();
      if (rr > 4 || c.size >= 2) {
        ctx.fillStyle = 'rgba(225,232,240,0.85)';
        ctx.font = '700 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        const label = c.name.toUpperCase() +
          (c.size === 3 ? ' ★' : c.size === 2 ? '' : '');
        ctx.fillText(label, wx(c.x), wz(c.z) - Math.max(3, rr) - 5);
      }
    }

    // ---- traffic ----
    ctx.fillStyle = 'rgba(255,205,110,0.9)';
    for (const v of this.trafficVehicles || []) {
      if (!v.userData.active) continue;
      ctx.fillRect(wx(v.position.x) - 1.2, wz(v.position.z) - 1.2, 2.4, 2.4);
    }

    // ---- peers ----
    ctx.fillStyle = '#48c8b8';
    for (const p of this.peers || []) {
      ctx.beginPath();
      ctx.arc(wx(p.x), wz(p.z), 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(72,200,184,0.8)';
      ctx.font = '600 9px system-ui, sans-serif';
      ctx.fillText(p.name, wx(p.x), wz(p.z) - 6);
      ctx.fillStyle = '#48c8b8';
    }

    // ---- waypoint ----
    if (this.waypoint) {
      ctx.strokeStyle = '#ff5f4a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(wx(this.waypoint.x), wz(this.waypoint.z), 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(wx(this.waypoint.x) - 10, wz(this.waypoint.z));
      ctx.lineTo(wx(this.waypoint.x) + 10, wz(this.waypoint.z));
      ctx.moveTo(wx(this.waypoint.x), wz(this.waypoint.z) - 10);
      ctx.lineTo(wx(this.waypoint.x), wz(this.waypoint.z) + 10);
      ctx.stroke();
    }

    // ---- player ----
    if (this.player) {
      ctx.save();
      ctx.translate(wx(this.player.x), wz(this.player.z));
      ctx.rotate(-this.player.heading + Math.PI);
      ctx.fillStyle = '#f2f6fa';
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(6, 8);
      ctx.lineTo(0, 4);
      ctx.lineTo(-6, 8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}
