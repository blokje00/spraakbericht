/* ============================================================
   sw.js — service worker: offline shell voor de monteursapp.
   CACHE: voeg een nieuwe versie toe na elke wijziging.
   ============================================================ */
const CACHE = "sunshower-monteur-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icon.svg"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      return hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match("./index.html"));
    })
  );
});

// 2026-08-26: web push — toont een notificatie als de app op de achtergrond
// staat. De app.js stuurt {title, body, id}; id = verificatie-record zodat de
// monteur vanaf de notificatie direct bij de juiste verificatie komt.
self.addEventListener("push", (e) => {
  e.waitUntil(
    (async () => {
      let title = "Nieuwe melding";
      let body = "Er is een nieuwe melding voor je.";
      let id = null;
      try {
        const data = e.data.json(); // {title, body, id}
        if (data.title) title = data.title;
        if (data.body) body = data.body;
        if (data.id) id = data.id;
      } catch (err) {
        // e.data niet te parsen -> generieke melding (2026-08-26)
      }
      return self.registration.showNotification(title, {
        body,
        icon: "./icon.svg",
        badge: "./icon.svg",
        data: { id }
      });
    })()
  );
});

// 2026-08-26: klik op notificatie -> open de app met de verificatie-id als
// query-param; de app.js leest index.html?verificatie=<id> en springt naar die
// sectie. Eenvoudigste betrouwbare aanpak (openWindow), geen focus-logica.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const target = "index.html?verificatie=" + (e.notification.data?.id || "");
      for (const c of list) {
        if (c.url && c.url.includes("index.html")) {
          return c.navigate(target).then(() => c.focus());
        }
      }
      return clients.openWindow(target);
    })
  );
});
