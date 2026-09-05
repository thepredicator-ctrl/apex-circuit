/**
 * Minimap — north-up canvas radar of the world around the player:
 * roads by class, city outlines + names, traffic dots, multiplayer peers,
 * the waypoint marker and the player's heading arrow. Redrawn at ~8 Hz.
 */

const SIZE = 210;
const RANGE = 620;          // meters from center to edge

export class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    this.ctx = canvas.getContext('2d');
    this.scale = (SIZE / 2) / RANGE;
    this._acc = 0;
  }

  update(dt, world, player, trafficVehicles, peers, waypoint) {
    this._acc += dt;
    if (this._acc < 0.12) return;
    this._acc = 0;
    this.draw(world, player, trafficVehicles, peers, waypoint);
  }

  draw(world, player, trafficVehicles, peers, waypoint) {
    const ctx = this.ctx;
    const S = SIZE, H = S / 2;
    const px = player.x, pz = player.z;
    const k = this.scale;
    const wx = (x) => H + (x - px) * k;
    const wz = (z) => H + (z - pz) * k;

    ctx.clearRect(0, 0, S, S);

    // backdrop
    ctx.save();
    ctx.beginPath();
    ctx.arc(H, H, H - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(10, 14, 20, 0.72)';
    ctx.fillRect(0, 0, S, S);

    // ---- roads ----
    const net = world.network;
    const R = RANGE + 100;
    const routes = world.routesNear(px, pz, R);
    ctx.lineWidth = 3;
    for (const r of routes) {
      const isHwy = r.type === 0;
      ctx.strokeStyle = isHwy ? 'rgba(240,200,90,0.9)' : 'rgba(220,226,232,0.55)';
      ctx.lineWidth = isHwy ? 3.4 : 2;
      if (r.kind === 'row' || r.kind === 'col') {
        ctx.beginPath();
        const a0 = r.kind === 'row' ? px - R : pz - R;
        const a1 = r.kind === 'row' ? px + R : pz + R;
        for (let u = a0; u <= a1; u += 24) {
          const c = net.coordAt(r, u);
          const x = r.kind === 'row' ? u : c;
          const z = r.kind === 'row' ? c : u;
          if (u === a0) ctx.moveTo(wx(x), wz(z));
          else ctx.lineTo(wx(x), wz(z));
        }
        ctx.stroke();
      } else if (r.kind === 'ring') {
        ctx.beginPath();
        for (let th = 0; th <= Math.PI * 2 + 0.05; th += 0.09) {
          const rr = world.cities.ringRadiusAt(r.city, th);
          const x = r.city.x + Math.cos(th) * rr;
          const z = r.city.z + Math.sin(th) * rr;
          if (th === 0) ctx.moveTo(wx(x), wz(z));
          else ctx.lineTo(wx(x), wz(z));
        }
        ctx.stroke();
      } else if (r.kind === 'street') {
        const city = r.city;
        const ca = Math.cos(city.angle), sa = Math.sin(city.angle);
        const span = city.radius + 60;
        ctx.beginPath();
        if (r.axis === 'row') {
          const p1 = world.cities.streetPoint(city, r, -span);
          const p2 = world.cities.streetPoint(city, r, span);
          ctx.moveTo(wx(p1.x), wz(p1.z));
          ctx.lineTo(wx(p2.x), wz(p2.z));
        } else {
          const p1 = world.cities.streetPoint(city, r, -span);
          const p2 = world.cities.streetPoint(city, r, span);
          ctx.moveTo(wx(p1.x), wz(p1.z));
          ctx.lineTo(wx(p2.x), wz(p2.z));
        }
        ctx.stroke();
      }
    }

    // ---- cities ----
    ctx.font = '700 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const c of world.cities.near(px, pz, RANGE + 500)) {
      const rr = c.radius * k;
      ctx.strokeStyle = 'rgba(140,160,180,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(wx(c.x), wz(c.z), Math.max(3, rr), 0, Math.PI * 2);
      ctx.stroke();
      if (rr > 6) {
        ctx.fillStyle = 'rgba(220,230,240,0.8)';
        ctx.fillText(c.name.toUpperCase(), wx(c.x), wz(c.z) - rr - 4);
      }
    }

    // ---- traffic ----
    ctx.fillStyle = 'rgba(255,210,120,0.9)';
    for (const v of trafficVehicles) {
      if (!v.userData.active) continue;
      ctx.beginPath();
      ctx.arc(wx(v.position.x), wz(v.position.z), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- peers ----
    ctx.fillStyle = '#48c8b8';
    for (const p of peers) {
      ctx.beginPath();
      ctx.arc(wx(p.x), wz(p.z), 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- waypoint ----
    if (waypoint) {
      ctx.fillStyle = '#ff5f4a';
      ctx.strokeStyle = 'rgba(255,95,74,0.5)';
      ctx.lineWidth = 1.5;
      const wxp = wx(waypoint.x), wzp = wz(waypoint.z);
      ctx.beginPath();
      ctx.arc(wxp, wzp, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // ---- player arrow ----
    ctx.save();
    ctx.translate(H, H);
    ctx.rotate(-player.heading + Math.PI);
    ctx.fillStyle = '#f2f6fa';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.restore();

    // ring bezel
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(H, H, H - 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(242,246,250,0.85)';
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', H, 12);
  }
}
