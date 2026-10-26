// Reforma: service worker mínimo para poder instalarla como app. Siempre va a la red (los datos son en vivo).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
