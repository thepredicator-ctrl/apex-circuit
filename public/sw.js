/* eslint-disable no-restricted-globals */
/**
 * APEX ROADS service worker — downloads the ENTIRE game onto the device
 * on the first visit (app shell + all Three.js bundles
 * models), then serves everything cache-first so the game launches instantly
 * and plays fully offline.
 */

const VERSION = '__SW_VERSION__';
const CACHE = `apex-roads-${VERSION}`;

// replaced at build time by scripts/build-sw.mjs
self.__PRECACHE_MANIFEST = __PRECACHE_URLS__;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const urls = self.__PRECACHE_MANIFEST || [];
    const cache = await caches.open(CACHE);
    let done = 0;
    const total = urls.length;
    const notify = (extra = {}) => {
      self.clients.matchAll({ includeUncontrolled: true }).then((cs) => {
        for (const c of cs) {
          c.postMessage({ type: 'precache-progress', done, total, ...extra });
        }
      }).catch(() => {});
    };
    notify();
    // small concurrency so the download saturates a bit but stays gentle
    const CONC = 4;
    let i = 0;
    const failed = [];
    async function worker() {
      while (i < urls.length) {
        const idx = i++;
        const url = urls[idx];
        try {
          await cache.add(new Request(url, { cache: 'reload' }));
        } catch (err) {
          failed.push(url);
        }
        done++;
        if (done % 2 === 0 || done === total) notify();
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    await self.skipWaiting();
    self.clients.matchAll({ includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        c.postMessage({ type: 'precache-done', failed, total });
      }
    }).catch(() => {});
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('apex-roads-') && k !== CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'precache-status') {
    // let the page know whether this SW instance already has the assets
    caches.open(CACHE).then((cache) => {
      const urls = self.__PRECACHE_MANIFEST || [];
      Promise.all(urls.map((u) => cache.match(u)))
        .then((hits) => {
          const done = hits.filter(Boolean).length;
          const client = event.source;
          if (client) {
            client.postMessage(done >= urls.length
              ? { type: 'precache-done', total: urls.length, failed: [] }
              : { type: 'precache-progress', done, total: urls.length });
          }
        });
    }).catch(() => {});
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // navigations: serve the app shell from the cache when offline
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        return fresh;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // everything else: cache-first, then network (and back-fill the cache)
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.status === 200 && fresh.type === 'basic') {
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (err) {
      return Response.error();
    }
  })());
});
