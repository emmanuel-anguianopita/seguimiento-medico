// Service worker: guarda la aplicación completa para que funcione sin conexión y sin depender de ningún servidor.
const CACHE = "seguimiento-medico-v6";
const ASSETS = [
  "./", "./index.html", "./manifest.webmanifest", "./css/app.css",
  "./js/app.js", "./js/crypto.js", "./js/parser.js", "./js/composition.js", "./js/systems.js", "./js/cycle.js", "./js/pdftext.js", "./js/db.js", "./js/charts.js",
  "./vendor/pdf.min.mjs", "./vendor/pdf.worker.min.mjs",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Primero la copia guardada; si no existe, la red. Se actualiza en segundo plano.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net.then((r) => r || caches.match("./index.html"));
    })
  );
});
