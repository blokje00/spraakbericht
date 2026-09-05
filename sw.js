/* ============================================================
   sw.js — service worker: offline schil + push voor de monteursapp.
   CACHE: nieuwe versie na elke wijziging (config.js APP_V).
   Strategie: netwerk eerst, alles wat binnenkomt in de cache; zonder
   netwerk het laatst bekende bestand. Zo hoeft hier geen lijst van
   bestanden bijgehouden te worden. API-verzoeken gaan nooit via de cache.
   ============================================================ */
const CACHE = "sunshower-monteur-v3";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "./index.html"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
  );
});

/* Push: {title, body, id}. De tekst komt in de taal van de monteur van de API. */
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data.json(); } catch (err) { /* geen JSON */ }
  e.waitUntil(self.registration.showNotification(data.title || "Sunshower", {
    body: data.body || "", icon: "./icon.svg", badge: "./icon.svg", data: { id: data.id || null },
  }));
});

/* Klik op de notificatie → open de app bij die memo (index.html?verificatie=<id>). */
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = (e.notification.data && e.notification.data.id) || "";
  const target = new URL("./index.html?verificatie=" + encodeURIComponent(id), self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("navigate" in c) return c.navigate(target).then((w) => w && w.focus());
    return clients.openWindow(target);
  }));
});
