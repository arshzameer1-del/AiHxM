/* AiHxM service worker.
 * Purpose: make the installed app open instantly and show a friendly page when there is no connection.
 * It never touches the API or any other site: only requests to this same origin are handled, and only static files are stored.
 * Company data is never cached here. Bump VERSION to drop old caches. */
const VERSION = "v1";
const SHELL_CACHE = `aihxm-shell-${VERSION}`;
const ASSET_CACHE = `aihxm-assets-${VERSION}`;
const SHELL_KEY = "/__app-shell";
const PRECACHE = ["/offline.html", "/icons/icon-192.png", "/icons/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("aihxm-") && k !== SHELL_CACHE && k !== ASSET_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // the API (api.aihxm.com) and everything else is left alone

  // Opening a page: always try the network first so a new release is picked up; fall back to the last page shell, then the offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_KEY, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(SHELL_KEY)) || (await caches.match("/offline.html")) || Response.error())
    );
    return;
  }

  // Built files have a hash in their name and never change: keep them after first use.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // Icons, manifest and other small static files: show the stored copy and refresh it in the background.
  if (/\.(?:png|svg|ico|webmanifest|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        const refresh = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => hit);
        return hit || refresh;
      })
    );
  }
});
