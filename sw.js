/* sw.js — ทำให้เปิดใช้ออฟไลน์ได้ และดึงเวอร์ชันใหม่ให้อัตโนมัติ
 * เวลาแก้โค้ด: เปลี่ยนเลข CACHE ด้านล่างทุกครั้ง แล้วผู้ใช้จะได้ของใหม่
 */
const CACHE = 'prathan-product-log-v3';
const SHELL = [
  './',
  './index.html',
  './schema.js',
  './db.js',
  './app.js',
  './manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // ฟอนต์ Google ฯลฯ ปล่อยผ่าน

  // ไฟล์แอป: network-first แล้วเก็บลง cache (ได้ของใหม่เสมอเมื่อออนไลน์, ออฟไลน์ใช้ของเก่า)
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
