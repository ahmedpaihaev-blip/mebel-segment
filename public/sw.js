// Mebel Segment: работа как приложение.
// Страница и оформление — сначала из сети, при отсутствии связи — из сохранённой копии.
// Фото товаров — из сохранённой копии (они не меняются). Каталог — из сети, без связи — последняя копия.
// Личные данные (кабинеты, заказы) не сохраняются никогда.
const VERSION = 'ms-v2';
const SHELL = ['/', '/logo.png', '/logo-light.png', '/hero-hinge.jpg', '/icon-192.png', '/favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // каталог — публичный: при отсутствии связи показываем последнюю сохранённую версию
  if (url.pathname === '/api/catalog') {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req)));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/uploads/')) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req.mode === 'navigate' ? '/' : req, copy)); }
    return res;
  }).catch(() => caches.match(req.mode === 'navigate' ? '/' : req)));
});
