/* db.js — ชั้นเก็บข้อมูล (IndexedDB บนเครื่อง)
 *
 * ออกแบบให้ต่อ backend ทีหลังได้: ทุกเรคคอร์ดมี id (UUID), updatedAt, rev, deleted
 * ซึ่งเพียงพอต่อการทำ two-way sync กับ Supabase / Firebase / Google Sheets ในอนาคต
 * โดยไม่ต้องแก้ไฟล์ UI (ดู DB.remote ด้านล่าง)
 */
window.DB = (function () {
  'use strict';

  const DB_NAME = 'prathan-product-log';
  const DB_VERSION = 1;
  const S_PRODUCTS = 'products';
  const S_IMAGES = 'images';
  const S_META = 'meta';

  let _db = null;

  function uid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(S_PRODUCTS)) {
          const s = db.createObjectStore(S_PRODUCTS, { keyPath: 'id' });
          s.createIndex('photoStatus', 'photoStatus');
          s.createIndex('updatedAt', 'updatedAt');
          s.createIndex('arrivalDate', 'arrivalDate');
          s.createIndex('code', 'code');
        }
        if (!db.objectStoreNames.contains(S_IMAGES)) {
          const s = db.createObjectStore(S_IMAGES, { keyPath: 'id' });
          s.createIndex('productId', 'productId');
        }
        if (!db.objectStoreNames.contains(S_META)) {
          db.createObjectStore(S_META, { keyPath: 'key' });
        }
        void e;
      };
      req.onsuccess = () => {
        _db = req.result;
        _db.onversionchange = () => { _db.close(); _db = null; };
        resolve(_db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(stores, mode) {
    return open().then((db) => db.transaction(stores, mode));
  }
  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function done(t) {
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    });
  }

  /* ================= PRODUCTS ================= */

  async function listProducts(opts) {
    opts = opts || {};
    const t = await tx([S_PRODUCTS], 'readonly');
    const all = await wrap(t.objectStore(S_PRODUCTS).getAll());
    return all.filter((d) => (opts.includeDeleted ? true : !d.deleted));
  }

  async function getProduct(id) {
    const t = await tx([S_PRODUCTS], 'readonly');
    return wrap(t.objectStore(S_PRODUCTS).get(id));
  }

  async function saveProduct(doc) {
    const now = new Date().toISOString();
    const rec = Object.assign({}, doc);
    if (!rec.id) { rec.id = uid(); rec.createdAt = now; }
    if (!rec.createdAt) rec.createdAt = now;
    rec.updatedAt = now;
    rec.rev = (rec.rev || 0) + 1;
    rec.deleted = !!rec.deleted;
    rec.dirty = true; // ยังไม่ได้ซิงก์ขึ้น backend
    const t = await tx([S_PRODUCTS], 'readwrite');
    t.objectStore(S_PRODUCTS).put(rec);
    await done(t);
    return rec;
  }

  /** ลบแบบ soft (เก็บ tombstone ไว้เพื่อให้ซิงก์ทีหลังรู้ว่าถูกลบ) */
  async function deleteProduct(id) {
    const cur = await getProduct(id);
    if (!cur) return;
    const imgs = await listImages(id);
    const t = await tx([S_PRODUCTS, S_IMAGES], 'readwrite');
    imgs.forEach((im) => t.objectStore(S_IMAGES).delete(im.id));
    t.objectStore(S_PRODUCTS).put(
      Object.assign({}, cur, {
        deleted: true,
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rev: (cur.rev || 0) + 1,
        dirty: true,
        imageCount: 0,
      })
    );
    await done(t);
  }

  /** ล้าง tombstone ทั้งหมดออกจริง */
  async function purgeDeleted() {
    const all = await listProducts({ includeDeleted: true });
    const gone = all.filter((d) => d.deleted);
    const t = await tx([S_PRODUCTS], 'readwrite');
    gone.forEach((d) => t.objectStore(S_PRODUCTS).delete(d.id));
    await done(t);
    return gone.length;
  }

  async function setPhotoStatus(id, status) {
    const cur = await getProduct(id);
    if (!cur) return null;
    return saveProduct(Object.assign({}, cur, { photoStatus: status }));
  }

  /* ================= IMAGES ================= */

  async function listImages(productId) {
    const t = await tx([S_IMAGES], 'readonly');
    const rows = await wrap(t.objectStore(S_IMAGES).index('productId').getAll(productId));
    return rows.sort((a, b) => (a.order || 0) - (b.order || 0) ||
      String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  async function listAllImages() {
    const t = await tx([S_IMAGES], 'readonly');
    return wrap(t.objectStore(S_IMAGES).getAll());
  }

  async function addImages(productId, items) {
    const now = new Date().toISOString();
    const existing = await listImages(productId);
    let order = existing.length;
    const recs = items.map((it) =>
      Object.assign({}, it, { id: uid(), productId, order: order++, createdAt: now, dirty: true })
    );
    const t = await tx([S_IMAGES], 'readwrite');
    recs.forEach((r) => t.objectStore(S_IMAGES).put(r));
    await done(t);
    await refreshImageCount(productId);
    return recs;
  }

  async function deleteImage(id) {
    const t0 = await tx([S_IMAGES], 'readonly');
    const im = await wrap(t0.objectStore(S_IMAGES).get(id));
    if (!im) return;
    const t = await tx([S_IMAGES], 'readwrite');
    t.objectStore(S_IMAGES).delete(id);
    await done(t);
    await refreshImageCount(im.productId);
  }

  async function setCover(id) {
    const t0 = await tx([S_IMAGES], 'readonly');
    const im = await wrap(t0.objectStore(S_IMAGES).get(id));
    if (!im) return;
    const list = await listImages(im.productId);
    const reordered = [im].concat(list.filter((x) => x.id !== id));
    const t = await tx([S_IMAGES], 'readwrite');
    reordered.forEach((x, i) => t.objectStore(S_IMAGES).put(Object.assign({}, x, { order: i, dirty: true })));
    await done(t);
  }

  /** เก็บจำนวนรูปไว้ที่ตัวสินค้า เพื่อให้แสดงรายการได้เร็วโดยไม่ต้องอ่านรูปทั้งหมด */
  async function refreshImageCount(productId) {
    const imgs = await listImages(productId);
    const cur = await getProduct(productId);
    if (!cur) return;
    const t = await tx([S_PRODUCTS], 'readwrite');
    t.objectStore(S_PRODUCTS).put(
      Object.assign({}, cur, {
        imageCount: imgs.length,
        updatedAt: new Date().toISOString(),
        rev: (cur.rev || 0) + 1,
        dirty: true,
      })
    );
    await done(t);
  }

  async function coverThumb(productId) {
    const imgs = await listImages(productId);
    return imgs.length ? imgs[0] : null;
  }

  /* ================= META ================= */

  async function getMeta(key, fallback) {
    const t = await tx([S_META], 'readonly');
    const r = await wrap(t.objectStore(S_META).get(key));
    return r ? r.value : fallback;
  }
  async function setMeta(key, value) {
    const t = await tx([S_META], 'readwrite');
    t.objectStore(S_META).put({ key, value });
    return done(t);
  }

  /* ================= EXPORT / IMPORT ================= */

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }
  function dataURLToBlob(dataURL) {
    const [head, b64] = String(dataURL).split(',');
    const mime = (head.match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime });
  }

  /** ส่งออกทั้งฐาน (รูปแปลงเป็น base64) — ใช้เป็นไฟล์สำรองข้อมูล */
  async function exportAll(opts) {
    opts = opts || {};
    const products = await listProducts({ includeDeleted: true });
    const images = await listAllImages();
    const outImages = [];
    for (const im of images) {
      outImages.push({
        id: im.id,
        productId: im.productId,
        order: im.order,
        createdAt: im.createdAt,
        name: im.name,
        w: im.w, h: im.h, bytes: im.bytes,
        full: opts.withFullImages === false ? null : await blobToDataURL(im.blob),
        thumb: await blobToDataURL(im.thumb),
      });
    }
    return {
      app: 'prathan-product-log',
      version: 1,
      exportedAt: new Date().toISOString(),
      counts: { products: products.length, images: outImages.length },
      products,
      images: outImages,
    };
  }

  /** นำเข้า: mode 'merge' (ค่าเริ่มต้น, ทับด้วยตัวที่ updatedAt ใหม่กว่า) หรือ 'replace' */
  async function importAll(data, mode) {
    if (!data || data.app !== 'prathan-product-log') throw new Error('ไฟล์ไม่ใช่ไฟล์สำรองของระบบนี้');
    mode = mode || 'merge';

    if (mode === 'replace') {
      const t = await tx([S_PRODUCTS, S_IMAGES], 'readwrite');
      t.objectStore(S_PRODUCTS).clear();
      t.objectStore(S_IMAGES).clear();
      await done(t);
    }

    const existing = {};
    (await listProducts({ includeDeleted: true })).forEach((d) => (existing[d.id] = d));

    let added = 0, updated = 0, skipped = 0;
    const t1 = await tx([S_PRODUCTS], 'readwrite');
    (data.products || []).forEach((p) => {
      const cur = existing[p.id];
      if (!cur) { t1.objectStore(S_PRODUCTS).put(p); added++; return; }
      if (String(p.updatedAt || '') > String(cur.updatedAt || '')) {
        t1.objectStore(S_PRODUCTS).put(p); updated++;
      } else skipped++;
    });
    await done(t1);

    const haveImg = {};
    (await listAllImages()).forEach((im) => (haveImg[im.id] = true));
    const t2 = await tx([S_IMAGES], 'readwrite');
    let imgAdded = 0;
    (data.images || []).forEach((im) => {
      if (haveImg[im.id]) return;
      if (!im.thumb) return;
      t2.objectStore(S_IMAGES).put({
        id: im.id, productId: im.productId, order: im.order || 0,
        createdAt: im.createdAt, name: im.name, w: im.w, h: im.h, bytes: im.bytes,
        blob: dataURLToBlob(im.full || im.thumb),
        thumb: dataURLToBlob(im.thumb),
        dirty: true,
      });
      imgAdded++;
    });
    await done(t2);

    const ids = {};
    (await listAllImages()).forEach((im) => (ids[im.productId] = true));
    for (const pid of Object.keys(ids)) await refreshImageCount(pid);

    return { added, updated, skipped, images: imgAdded };
  }

  async function stats() {
    const products = await listProducts();
    const images = await listAllImages();
    let bytes = 0;
    images.forEach((im) => (bytes += (im.bytes || 0)));
    let quota = null;
    try {
      if (navigator.storage && navigator.storage.estimate) quota = await navigator.storage.estimate();
    } catch (e) { void e; }
    return { products: products.length, images: images.length, bytes, quota };
  }

  async function wipeAll() {
    const t = await tx([S_PRODUCTS, S_IMAGES, S_META], 'readwrite');
    t.objectStore(S_PRODUCTS).clear();
    t.objectStore(S_IMAGES).clear();
    t.objectStore(S_META).clear();
    return done(t);
  }

  /* ================= จุดต่อ backend (ยังไม่เปิดใช้) =================
   * เมื่อจะให้ทีมหลายคนแชร์ข้อมูลกัน: implement 3 ฟังก์ชันนี้แล้วเรียก DB.remote.sync()
   * ข้อมูลทุกเรคคอร์ดมี id/updatedAt/rev/deleted/dirty ครบสำหรับ last-write-wins อยู่แล้ว
   */
  const remote = {
    enabled: false,
    endpoint: null,
    async push(/* records */) { throw new Error('ยังไม่ได้ต่อ backend'); },
    async pull(/* sinceISO */) { throw new Error('ยังไม่ได้ต่อ backend'); },
    async sync() {
      if (!remote.enabled) return { skipped: true, reason: 'โหมดเครื่องเดียว' };
      throw new Error('ยังไม่ได้ต่อ backend');
    },
  };

  return {
    uid, open,
    listProducts, getProduct, saveProduct, deleteProduct, purgeDeleted, setPhotoStatus,
    listImages, listAllImages, addImages, deleteImage, setCover, coverThumb,
    getMeta, setMeta,
    exportAll, importAll, stats, wipeAll,
    blobToDataURL, dataURLToBlob,
    remote,
  };
})();
