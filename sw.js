// Kairos : cache hors ligne. Change VERSION (et version.json, et APP_VER dans app.js) à chaque mise à jour.
const VERSION = 'kairos-v9';
const CORE = ['./', './index.html', './config.js', './app.js', './money.js', './dash.js', './nights.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin || u.pathname.endsWith('/version.json')) return; // Supabase passe toujours par le réseau
  const fresh = r.mode === 'navigate' || /\/(config|app|money|dash|nights)\.js$/.test(u.pathname);
  if (fresh) { // réseau d'abord : les mises à jour arrivent dès qu'il y a du réseau
    const key = r.mode === 'navigate' ? './index.html' : r;
    e.respondWith(fetch(r.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then(res => { if (res.ok && res.type === 'basic') { const cp = res.clone(); caches.open(VERSION).then(c => c.put(key, cp)); } return res; })
      .catch(() => caches.match(key)));
    return;
  }
  e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(VERSION).then(c => c.put(r, cp)); } return res; })));
});

// Notifications « pause scroll »
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Kairos', {
    body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png',
    tag: d.tag || 'kairos-scroll', renotify: true, data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope);
  const m = url.searchParams.get('m'), t = url.searchParams.get('tab');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
        c.postMessage(t === 'argent' ? { type: 'tab', tab: 'money' } : t === 'nuits' ? { type: 'tab', tab: 'nights' } : { type: 'stop', m: m ? +m : '' });
        return c.focus();
      }
    }
    return self.clients.openWindow(url.href);
  }));
});
