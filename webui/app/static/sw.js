/* Service Worker for Wallpaper WebUI
 * - Cache preview thumbnails (/media/preview/...) persistently via Cache Storage
 * - Strategy: stale-while-revalidate
 */

const CACHE_NAME = "wwui-preview-v1";

function isPreviewRequest(req) {
  try {
    const url = new URL(req.url);
    return url.origin === self.location.origin && url.pathname.startsWith("/media/preview/");
  } catch {
    return false;
  }
}

self.addEventListener("install", (event) => {
  // Activate immediately
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Clean old caches
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k === CACHE_NAME ? null : caches.delete(k))));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (!isPreviewRequest(req)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: false });

    const fetchAndUpdate = fetch(req).then(async (resp) => {
      // Only cache successful basic/cors responses
      try {
        if (resp && resp.ok) {
          await cache.put(req, resp.clone());
        }
      } catch {}
      return resp;
    }).catch(() => null);

    // stale-while-revalidate: return cached immediately, update in background
    if (cached) {
      event.waitUntil(fetchAndUpdate);
      return cached;
    }

    const net = await fetchAndUpdate;
    return net || new Response("", { status: 504, statusText: "SW cache miss & network error" });
  })());
});

