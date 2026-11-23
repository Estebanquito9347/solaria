self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open('solaria-cache-v1').then((cache) => {
      return cache.addAll([
        '/solaria/',
        '/solaria/index.html',
        '/solaria/styles.css',
        '/solaria/app.js',
        '/solaria/ia.js',
        '/solaria/config.js'
      ]);
    })
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request);
    })
  );
});
