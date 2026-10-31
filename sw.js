// Service worker: deixa o app abrir sem internet.
// Arquivos do app: tenta a rede primeiro (pega atualização) e cai no cache se estiver offline.
const CACHE = "musica-v9";
const CORE = [
  "./",
  "index.html",
  "style.css",
  "script.js",
  "manifest.json",
  "icon-192.png",
  "icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const external = /fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/.test(url.hostname);

  if (sameOrigin) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match("index.html"))
        )
    );
    return;
  }

  if (external) {
    // fontes e biblioteca de tags: usa o que já está guardado e atualiza por trás
    event.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req)
          .then(res => {
            const copy = res.clone();
            caches.open(CACHE).then(cache => cache.put(req, copy));
            return res;
          })
          .catch(() => hit);
        return hit || net;
      })
    );
  }
});
