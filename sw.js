/* ============================================================
   Service Worker — ใช้งานออฟไลน์ได้ และได้โค้ดใหม่เสมอเมื่อออนไลน์

   กลยุทธ์: network-first
   - ออนไลน์  → ดึงจากเน็ตก่อนเสมอ แล้วอัปเดตแคชไว้เงียบ ๆ
                (อัปเดตเว็บแล้วเห็นทันที ไม่ต้องรีเฟรชซ้ำ)
   - ออฟไลน์ หรือเน็ตช้าเกิน 4 วิ → ใช้ของในแคชแทน
   ============================================================ */
const CACHE = 'product-log-v8';
const FILES = [
  './', './index.html', './config.js', './sync.js', './app.js', './manifest.json',
  './icon-192.png', './icon-512.png',
];
const TIMEOUT = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(FILES.map((f) =>
        fetch(f, { cache: 'reload' }).then((r) => (r.ok ? c.put(f, r) : null)).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (!req.url.startsWith(self.location.origin)) return;   /* ข้ามคำขอที่ยิงไป Supabase */

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const net = await Promise.race([
        fetch(req),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT)),
      ]);
      if (net && net.ok) cache.put(req, net.clone()).catch(() => {});
      return net;
    } catch (err) {
      const hit = await cache.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
