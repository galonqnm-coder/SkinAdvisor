/* SkinAdvisor — service worker minimal
   Rend le site consultable hors ligne : la routine reste lisible dans une salle de bain sans réseau.
   Déposez ce fichier à la racine, à côté de skinadvisor-site.html renommé index.html. */

const CACHE = "skinadvisor-v1";
const FICHIERS = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(noms => Promise.all(noms.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  // Les polices Google : on sert le cache d'abord, on rafraîchit en arrière-plan.
  if (req.url.includes("fonts.googleapis.com") || req.url.includes("fonts.gstatic.com")){
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(rep => {
        const copie = rep.clone();
        caches.open(CACHE).then(c => c.put(req, copie));
        return rep;
      }).catch(() => hit))
    );
    return;
  }

  // Le site lui-même : réseau d'abord, cache en secours (donc toujours à jour quand il y a du réseau).
  e.respondWith(
    fetch(req)
      .then(rep => {
        const copie = rep.clone();
        caches.open(CACHE).then(c => c.put(req, copie));
        return rep;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match("./index.html")))
  );
});
