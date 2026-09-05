/**
 * Net — multiplayer client.
 *
 * Joins the room for the CURRENT world seed, streams the local vehicle state
 * at 12 Hz, and renders remote players by interpolating between buffered
 * snapshots (rendered ~120 ms in the past for smoothness under jitter).
 *
 * Remote cars are lightweight procedural proxies with name tags. If the
 * relay is unreachable the game silently runs offline.
 */

import * as THREE from 'three';
import { io } from 'socket.io-client';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function proxyCarGeo() {
  const body = new THREE.BoxGeometry(1.8, 0.55, 4.2);
  body.translate(0, 0.62, 0);
  const cabin = new THREE.BoxGeometry(1.6, 0.5, 2.0);
  cabin.translate(0, 1.12, -0.3);
  return mergeGeometries([body, cabin], false);
}

const INTERP_DELAY = 120;   // ms

export class Net {
  constructor(scene) {
    this.scene = scene;
    this.socket = null;
    this.connected = false;
    this.myId = null;
    this.playerName = 'DRIVER';
    this.seed = 0;
    this.peers = new Map();       // id -> { group, label, buf: [], color }
    this.onlineCount = 1;
    this.ping = 0;
    this._sendAcc = 0;
    this._lastState = { x: 0, y: 0, z: 0, h: 0, s: 0, st: 0 };
    this._geo = proxyCarGeo();

    this.colors = [0xe8483c, 0x3ca4e8, 0x48c860, 0xe8b83c, 0xa048c8, 0x48c8b8];
  }

  connect(seed, playerName) {
    this.disconnect();
    this.seed = seed;
    this.playerName = (playerName || 'DRIVER').slice(0, 14).toUpperCase();
    try {
      this.socket = io('/?XTransformPort=3033', {
        path: '/',
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 4,
        timeout: 5000
      });
      const s = this.socket;
      s.on('connect', () => {
        this.connected = true;
        s.emit('join', { seed: String(seed), name: this.playerName });
      });
      s.on('joined', (msg) => {
        this.myId = msg.id;
        this.onlineCount = msg.roster ? msg.roster.length : 1;
      });
      s.on('snapshot', (msg) => this._onSnapshot(msg));
      s.on('peer-joined', () => { this.onlineCount++; });
      s.on('peer-left', (msg) => this._removePeer(msg.id));
      s.on('disconnect', () => {
        this.connected = false;
        this.onlineCount = 1;
        for (const id of [...this.peers.keys()]) this._removePeer(id);
      });
      s.on('connect_error', () => {
        this.connected = false;
      });
    } catch (e) {
      console.warn('[net] multiplayer unavailable:', e && e.message);
      this.connected = false;
    }
  }

  disconnect() {
    if (this.socket) {
      try { this.socket.emit('leave'); this.socket.disconnect(); } catch { /* */ }
      this.socket = null;
    }
    this.connected = false;
    for (const id of [...this.peers.keys()]) this._removePeer(id);
  }

  _removePeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.scene.remove(p.group);
    p.group.traverse((o) => { if (o.geometry && o.geometry !== this._geo) o.geometry.dispose(); });
    this.peers.delete(id);
    this.onlineCount = Math.max(1, this.onlineCount - 1);
  }

  _onSnapshot(msg) {
    if (!msg || !msg.players) return;
    const now = performance.now();
    this.ping = Math.max(0, Math.min(999, Date.now() - msg.t));
    const seen = new Set();
    for (const q of msg.players) {
      if (q.i === this.myId) continue;
      seen.add(q.i);
      let p = this.peers.get(q.i);
      if (!p) p = this._addPeer(q.i, q.n);
      p.buf.push({ t: now, x: q.x, y: q.y, z: q.z, h: q.h, s: q.s, st: q.st });
      if (p.buf.length > 30) p.buf.shift();
    }
    for (const id of [...this.peers.keys()]) {
      if (!seen.has(id)) {
        const p = this.peers.get(id);
        // grace period so a dropped frame doesn't blink players out
        if (p.buf.length && now - p.buf[p.buf.length - 1].t > 3000) this._removePeer(id);
      }
    }
  }

  _addPeer(id, name) {
    const group = new THREE.Group();
    const idx = Math.abs([...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0)) % this.colors.length;
    const mat = new THREE.MeshStandardMaterial({
      color: this.colors[idx], roughness: 0.45, metalness: 0.4
    });
    const body = new THREE.Mesh(this._geo, mat);
    body.castShadow = true;
    group.add(body);

    // name tag sprite
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(8,12,18,0.7)';
    ctx.roundRect(4, 8, 248, 48, 12);
    ctx.fill();
    ctx.fillStyle = '#f2f6fa';
    ctx.font = '700 28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(name || 'DRIVER').slice(0, 14), 128, 33);
    const tex = new THREE.CanvasTexture(cv);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.set(4.4, 1.1, 1);
    sprite.position.y = 2.6;
    group.add(sprite);

    this.scene.add(group);
    const p = { group, buf: [], name, color: this.colors[idx] };
    this.peers.set(id, p);
    return p;
  }

  /** stream local state + advance remote interpolation */
  update(dt, phys, carGroup) {
    if (!this.connected || !this.socket) return;

    // send at 12 Hz
    this._sendAcc += dt;
    if (this._sendAcc > 1 / 12) {
      this._sendAcc = 0;
      this.socket.emit('state', {
        x: +phys.position.x.toFixed(2),
        y: +phys.position.y.toFixed(2),
        z: +phys.position.z.toFixed(2),
        h: +phys.heading.toFixed(3),
        s: +Math.abs(phys.vF).toFixed(1),
        st: 0
      });
    }

    // interpolate remotes
    const now = performance.now();
    const target = now - INTERP_DELAY;
    for (const p of this.peers.values()) {
      const buf = p.buf;
      if (!buf.length) continue;
      let a = buf[0], b = buf[buf.length - 1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].t <= target && buf[i + 1].t >= target) {
          a = buf[i]; b = buf[i + 1];
          break;
        }
      }
      const span = Math.max(1, b.t - a.t);
      const t = Math.min(1, Math.max(0, (target - a.t) / span));
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t;
      let dh = b.h - a.h;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      const h = a.h + dh * t;
      p.group.position.set(x, y + 0.02, z);
      p.group.rotation.y = h;
    }
  }

  /** minimap/world map dots (world space) */
  peerPositions() {
    const out = [];
    for (const p of this.peers.values()) {
      out.push({ x: p.group.position.x, z: p.group.position.z, name: p.name });
    }
    return out;
  }
}
