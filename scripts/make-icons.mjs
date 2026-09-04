// Generate PWA icons (pure Node, no deps): a racing flag "A" emblem.
// PNG encoding by hand: IHDR + IDAT (zlib deflate of raw scanlines) + IEND.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- draw the emblem: dark disc, red ring, checkered chevron "A" -----------
function drawIcon(size, maskable = false) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const R = maskable ? size * 0.42 : size * 0.46;
  const bg = [11, 15, 20];
  const red = [255, 59, 48];
  const white = [242, 244, 246];

  const set = (x, y, c, a = 255) => {
    const i = (y * size + x) * 4;
    const inv = 255 - a;
    rgba[i] = (c[0] * a + rgba[i] * inv) / 255;
    rgba[i + 1] = (c[1] * a + rgba[i + 1] * inv) / 255;
    rgba[i + 2] = (c[2] * a + rgba[i + 2] * inv) / 255;
    rgba[i + 3] = Math.max(rgba[i + 3], a);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d > R) {
        if (maskable) set(x, y, bg);
        continue;
      }
      // disc
      set(x, y, bg, 255);
      // outer red ring
      if (d > R * 0.86 && d <= R) set(x, y, red, 255);
      // checkered "A" — apex at top, legs splay downward, crossbar low
      const nx = (x - cx) / R, ny = (y - cy) / R;
      const inLeftBar = ny > -0.62 && ny < 0.52 && Math.abs(nx + (ny + 0.62) * 0.40) < 0.155;
      const inRightBar = ny > -0.62 && ny < 0.52 && Math.abs(nx - (ny + 0.62) * 0.40) < 0.155;
      const inCross = ny > 0.10 && ny < 0.32 && Math.abs(nx) < 0.36;
      // inner notch between the legs below the crossbar
      const notch = ny > 0.32 && Math.abs(nx) < (ny - 0.24) * 0.62;
      if ((inLeftBar || inRightBar || inCross) && !notch && d < R * 0.8) {
        // checker: 4px cells alternating white/dark
        const cell = Math.floor((x - cx) / (R * 0.11)) + Math.floor((y - cy) / (R * 0.11));
        set(x, y, cell % 2 === 0 ? white : [30, 34, 40], 255);
      }
    }
  }
  return encodePNG(size, size, rgba);
}

writeFileSync(join(outDir, 'icon-192.png'), drawIcon(192));
writeFileSync(join(outDir, 'icon-512.png'), drawIcon(512));
writeFileSync(join(outDir, 'icon-512-maskable.png'), drawIcon(512, true));
console.log('icons written to', outDir);
