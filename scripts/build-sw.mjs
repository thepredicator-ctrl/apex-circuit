/**
 * build-sw — post-build step: stamp the service worker with the full list of
 * emitted files (app shell + hashed bundles + GLB models + icons) so the
 * first visit downloads the complete game onto the device.
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

function walk(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

const files = walk(dist);
// every static file except the SW itself; './index.html' handles navigations
const urls = ['./'];
for (const f of files) {
  if (f === 'sw.js' || f.endsWith('.map')) continue;
  urls.push(`./${f.split(sep).join('/')}`);
}

const swPath = join(dist, 'sw.js');
let sw = readFileSync(swPath, 'utf8');
sw = sw.replace('__SW_VERSION__', Date.now().toString(36));
sw = sw.replace('__PRECACHE_URLS__', JSON.stringify(urls, null, 2));
writeFileSync(swPath, sw);

console.log(`[build-sw] precache manifest: ${urls.length} files stamped into dist/sw.js`);
if (process.env.VERBOSE) console.log(urls.join('\n'));
