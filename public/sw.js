const OFFLINE_CACHE_PREFIX = 'clideck-offline-';
const OFFLINE_CACHE = `${OFFLINE_CACHE_PREFIX}v2`;
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', event => {
  event.waitUntil(cacheOfflinePage());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(OFFLINE_CACHE_PREFIX) && name !== OFFLINE_CACHE)
      .map(name => caches.delete(name)));
  })());
});

async function cacheOfflinePage() {
  const response = await fetch(new Request(OFFLINE_URL, {
    cache: 'reload',
    credentials: 'same-origin',
    redirect: 'error',
  }));
  if (!response.ok || !String(response.headers.get('content-type') || '').includes('text/html')) {
    throw new Error('CliDeck offline fallback was not available.');
  }
  const cache = await caches.open(OFFLINE_CACHE);
  await cache.put(OFFLINE_URL, response);
}

self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
  // offline.html can change without a service worker byte change, which
  // means no new install ever re-caches it. The page asks for a refresh on
  // every load instead.
  if (event.data?.type === 'REFRESH_OFFLINE') event.waitUntil?.(cacheOfflinePage().catch(() => {}));
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // A real HTTP response, including an authentication redirect or denial,
  // always wins. The fallback is only for a rejected network request.
  event.respondWith(fetch(request).catch(async () => {
    return (await caches.match(OFFLINE_URL))
      || new Response('CliDeck is offline.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
  }));
});
