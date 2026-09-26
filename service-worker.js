const CACHE = 'ac-zero-calc-v65';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './css/fonts.css',
  './fonts/oswald-500-700-latin.woff2',
  './fonts/oswald-500-700-latin-ext.woff2',
  './fonts/work-sans-400-600-latin.woff2',
  './fonts/work-sans-400-600-latin-ext.woff2',
  './fonts/ibm-plex-mono-400-latin.woff2',
  './fonts/ibm-plex-mono-400-latin-ext.woff2',
  './fonts/ibm-plex-mono-500-latin.woff2',
  './fonts/ibm-plex-mono-500-latin-ext.woff2',
  './fonts/ibm-plex-mono-600-latin.woff2',
  './fonts/ibm-plex-mono-600-latin-ext.woff2',
  './js/app.js',
  './js/qr-app.js',
  './js/ballistics.js',
  './js/profiles.js',
  './js/dryfire.js',
  './js/shop.js',
  './js/contact.js',
  './js/train.js',
  './js/turret.js',
  './js/shottimer.js',
  './js/shottimer-worklet.js',
  './js/dopecard.js',
  './assets/background.jpg',
  './icons/logo.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  ...Array.from({length:56}, (_,i) => `./assets/shop/custom-grip-360-nobg/frame-${String(i+1).padStart(2,'0')}.png`),
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
