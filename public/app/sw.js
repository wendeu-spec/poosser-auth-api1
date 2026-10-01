// Service worker minimal pour POOSSER — sert uniquement à rendre l'app
// installable (critère PWA) et à mettre en cache le "shell" statique
// (index.html, manifest, icônes) pour un démarrage rapide hors-ligne.
//
// Important : les appels /auth/* et /api/* ne sont JAMAIS mis en cache ici
// (ils passent toujours par le réseau) — mettre en cache des données
// financières ou des jetons d'authentification serait dangereux et source
// de données obsolètes. Seul le "squelette" de l'appli (HTML/CSS/JS/icônes)
// bénéficie du cache.

const CACHE_NAME = 'poosser-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Jamais de cache pour l'API ou l'authentification : toujours le réseau.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    return; // laisse la requête suivre son cours normal (réseau)
  }

  // Seulement nos propres fichiers statiques (même origine, sous /app/).
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached); // hors-ligne : retombe sur le cache
      return cached || network;
    })
  );
});
