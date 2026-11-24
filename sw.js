// Service worker: guarda la aplicación completa para que funcione sin conexión y sin depender de ningún servidor.
const CACHE = "seguimiento-medico-v17";
const ASSETS = [
  "./", "./index.html", "./manifest.webmanifest", "./css/app.css",
  "./js/app.js", "./js/crypto.js", "./js/parser.js", "./js/composition.js", "./js/systems.js", "./js/cycle.js", "./js/progress.js", "./js/publish.js", "./js/zip.js", "./js/pdftext.js", "./js/db.js", "./js/charts.js",
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

// Primero la red (para que las actualizaciones se vean de inmediato); sin conexión, la copia guardada.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/data/")) return;   // los resultados publicados siempre se piden a la red, nunca se guardan
  e.respondWith(
    fetch(req, { cache: "no-cache" }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html")))
  );
});
