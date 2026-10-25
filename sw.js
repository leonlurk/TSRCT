// TSRCT - Tesseract Service Worker
// Enables PWA installation and offline caching

const CACHE_NAME = 'tsrct-v428';

// Keep this list in sync with the <link> and <script> tags in src/index.html.
// It used to hold only the LAZY room assets, so `/` was cached but nothing `/`
// links to -- the offline shell appeared to work purely because the fetch
// handler below caches responses at runtime. A genuine cold offline start gave
// an unstyled, non-functional page. The core shell is precached now.
// (Audit 2026-08-14.)
//
// NOT cached, deliberately: the Google Fonts stylesheet and the tesseract.js CDN
// bundle (external origins), and /src/js/sf-cli.js has no script tag -- it is
// lazy-injected by loadSfCli(), which is why it is listed with the room assets.
const ASSETS_TO_CACHE = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  // Core stylesheets -- hard-linked from index.html, needed for a usable page
  '/src/css/variables.css',
  '/src/css/base.css',
  '/src/css/layout.css',
  '/src/css/terminal.css',
  '/src/css/permissions.css',
  '/src/css/hands-free.css',
  '/src/css/main.css',
  '/src/css/components.css',
  '/src/css/desktop.css',
  '/src/css/desktop-runners.css',
  '/src/css/desktop-attach.css',
  '/src/css/desktop-notes.css',
  '/src/css/desktop-git.css',
  '/src/css/desktop-sessions.css',
  '/src/css/restart.css',
  '/src/css/assistant.css',
  '/src/css/tesla-full.css',
  '/src/css/tour.css',
  // Room CSS (lazy loaded, cached for offline)
  '/src/css/rooms/rooms-base.css',
  '/src/css/rooms/room-remote.css',
  '/src/css/rooms/room-runners.css',
  '/src/css/rooms/room-sfcli.css',
  '/src/css/rooms/room-codemap.css',
  '/src/css/rooms/room-automations.css',
  '/src/css/rooms/room-notifs.css',
  '/src/css/rooms/room-handson.css',
  '/src/css/rooms/room-morning.css',
  // Core scripts -- in index.html load order
  '/src/js/app.js',
  '/src/js/utils.js',
  '/src/js/terminal-focus.js',
  '/src/js/terminal-images.js',
  '/src/js/world-manager.js',
  '/src/js/hands-free.js',
  '/src/js/sessions.js',
  '/src/js/attachments.js',
  '/src/js/remote-desktop.js',
  '/src/js/remote-desktop-vr.js',
  '/src/js/sf-cli.js',
  '/src/js/runners.js',
  '/src/js/codemap.js',
  '/src/js/automations.js',
  '/src/js/notifications.js',
  '/src/js/omni.js',
  '/src/js/handson.js',
  '/src/js/morning.js',
  '/src/js/session-voice.js',
  '/src/js/session-weight.js',
  '/src/js/usage.js',
  '/src/js/sound.js',
  '/src/js/auto-accept.js',
  '/src/js/abbreviations.js',
  '/src/js/main.js',
  '/src/js/webauthn.js',
  '/src/js/restart.js',
  '/src/js/layout-memory.js',
  '/src/js/desktop-git.js',
  '/src/js/desktop-runners.js',
  '/src/js/desktop-attach.js',
  '/src/js/desktop-notes.js',
  '/src/js/desktop-sessions.js',
  '/src/js/desktop.js',
  '/src/js/projector.js',
  '/src/js/tour.js',
  '/src/js/ui-actions.js',
  '/src/js/tesla-sphere.js',
  '/src/js/tesla-plan.js',
  '/src/js/tesla-center.js',
  '/src/js/tesla-full.js',
  '/src/js/assistant.js',
  '/src/js/windows.js'
];

// Install - cache essential assets.
// cache.addAll() is ATOMIC: a single 404 rejects the whole install, the worker
// never activates, and skipWaiting() below fires regardless -- so deleting one
// cached file silently costs the entire offline shell, with nothing logged and
// nothing broken in the foreground. Cache per-asset and report what failed
// instead, so a stale entry degrades to "that one file is not offline".
// (Audit 2026-08-14 -- this is what made every future deletion a coin flip.)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const results = await Promise.allSettled(
        ASSETS_TO_CACHE.map((url) => cache.add(url))
      );
      const failed = ASSETS_TO_CACHE.filter((_, i) => results[i].status === 'rejected');
      if (failed.length) {
        console.warn(
          `[sw] ${CACHE_NAME}: ${failed.length}/${ASSETS_TO_CACHE.length} asset(s) not precached`,
          failed
        );
      }
    })
  );
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Push - this is the ONE thing that runs with the app fully closed.
// The payload is encrypted end to end (lib/push.js, RFC 8291) and kept thin on
// purpose: a title, a line, and where to go. The content itself is fetched over
// Tailscale after the tap, so nothing of substance ever passes through the push
// service. requireInteraction keeps it on screen instead of vanishing in 5s,
// which for a 6am brief is the whole point.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: (event.data && event.data.text()) || '' }; }
  const title = d.title || 'TSRCT';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: d.body || '',
      tag: d.tag || 'tsrct',
      renotify: true,
      requireInteraction: true,
      vibrate: [200, 100, 200, 100, 400],
      data: { tsrct: true, url: d.url || '/', kind: d.kind || '' },
    })
  );
});

// Notification click - a push knows where it wants to go; anything else is the
// old remote-desktop return.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = data.tsrct ? (data.url || '/') : '/?room=remote';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          // The tap IS the gesture that lets the page play audio, so the page
          // is told to start speaking rather than being merely focused.
          client.postMessage(data.tsrct
            ? { type: 'tsrct-push-open', kind: data.kind, url: data.url }
            : { type: 'rd-return' });
          return;
        }
      }
      return clients.openWindow(target);
    })
  );
});

// Fetch - network first, fallback to cache for UI
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always go to network for API calls
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // For UI assets, try network first, fallback to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Network failed, try cache
        return caches.match(event.request).then(cached => cached || Response.error());
      })
  );
});
