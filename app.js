/* app.js — ตรรกะทั้งหมดของหน้าจอ */
window.APP = (function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  /* ================= state ================= */
  const S = {
    view: 'items',
    products: [],
    covers: {},          // productId -> {id, thumb}
    query: '',
    fEntry: 'all',
    fPhoto: 'all',
    fBarcode: 'all',
    sort: 'updated',
    // ฟอร์มที่กำลังแก้
    edit: null,          // เอกสารสินค้า (null = ปิดฟอร์ม)
    editImages: [],      // รูปที่มีอยู่แล้วของสินค้านี้
    pendingImages: [],   // รูปใหม่ที่ยังไม่บันทึก [{blob,thumb,w,h,bytes,name}]
    dirty: false,
    lb: { list: [], i: 0 },
  };

  const urlCache = new Map();
  function urlFor(key, blob) {
    if (urlCache.has(key)) return urlCache.get(key);
    const u = URL.createObjectURL(blob);
    urlCache.set(key, u);
    return u;
  }
  function dropUrl(key) {
    if (urlCache.has(key)) { URL.revokeObjectURL(urlCache.get(key)); urlCache.delete(key); }
  }

  /* ================= utils ================= */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (n) => new Intl.NumberFormat('th-TH').format(n);

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
  }
  function daysSince(iso) {
    if (!iso) return null;
    const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
    if (isNaN(d)) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }
  function fmtBytes(b) {
    if (!b) return '0 KB';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function toast(msg, bad) {
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.25s'; }, 2200);
    setTimeout(() => el.remove(), 2600);
  }

  /* ================= รูปภาพ: ย่อขนาดอัตโนมัติ ================= */
  const IMG = {
    MAX: 1600,        // ด้านยาวสุดของรูปที่เก็บ
    THUMB: 420,       // ด้านยาวสุดของรูปย่อ
    Q: 0.82,
    Q_THUMB: 0.72,
  };

  async function decode(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file); } catch (e) { void e; }
    }
    return await new Promise((resolve, reject) => {
      const img = new Image();
      const u = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(u); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('decode failed')); };
      img.src = u;
    });
  }

  function drawTo(src, maxSide, quality) {
    const w0 = src.width, h0 = src.height;
    const scale = Math.min(1, maxSide / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    return new Promise((resolve) => {
      c.toBlob((blob) => resolve({ blob, w, h }), 'image/jpeg', quality);
    });
  }

  /** รับ File → คืน {blob, thumb, w, h, bytes, name} (ย่อขนาด + บีบอัดแล้ว) */
  async function processImage(file) {
    let bmp;
    try {
      bmp = await decode(file);
    } catch (e) {
      void e;
      const heic = /heic|heif/i.test(file.type + ' ' + file.name);
      throw new Error(heic
        ? 'เบราว์เซอร์เปิดไฟล์ HEIC จาก iPhone ไม่ได้ — ตั้งกล้อง iPhone เป็น "Most Compatible" หรือแชร์รูปเป็น JPEG ก่อน'
        : 'อ่านไฟล์รูปไม่ได้: ' + file.name);
    }
    const full = await drawTo(bmp, IMG.MAX, IMG.Q);
    const thumb = await drawTo(bmp, IMG.THUMB, IMG.Q_THUMB);
    if (bmp.close) bmp.close();
    return {
      blob: full.blob, thumb: thumb.blob,
      w: full.w, h: full.h,
      bytes: full.blob.size + thumb.blob.size,
      name: file.name || 'image.jpg',
      srcBytes: file.size,
    };
  }

  /* ================= สแกนบาร์โค้ดด้วยกล้อง =================
   * ใช้ BarcodeDetector ที่ติดมากับเบราว์เซอร์ (Chrome บน Android / ChromeOS / macOS)
   * ถ้าเครื่องไม่รองรับ จะอธิบายให้ผู้ใช้ทราบและให้พิมพ์เองแทน — ไม่โหลดไลบรารีจากภายนอก
   */
  const SCAN = {
    FORMATS: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar', 'qr_code'],
    stream: null, timer: null, onResult: null, running: false,

    supported() { return typeof window.BarcodeDetector === 'function'; },

    async open(title, onResult) {
      SCAN.onResult = onResult;
      const ov = $('#scanOv');
      $('#scanTitle').textContent = title || 'สแกนบาร์โค้ด';
      ov.classList.remove('err');
      $('#scanErr').innerHTML = '';
      ov.classList.add('on');

      if (!SCAN.supported()) {
        return SCAN.fail('เครื่องนี้ยังสแกนด้วยกล้องไม่ได้',
          'เบราว์เซอร์ที่ใช้อยู่ไม่มีตัวอ่านบาร์โค้ดในตัว (ปกติใช้ได้บน <b>Chrome บนมือถือ Android</b>)<br>' +
          'บนคอมพิวเตอร์แนะนำใช้เครื่องสแกนบาร์โค้ดแบบ USB — มันทำงานเหมือนคีย์บอร์ด คลิกที่ช่องบาร์โค้ดแล้วยิงได้เลย');
      }
      try {
        SCAN.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (e) {
        const denied = /NotAllowed|Permission/i.test(e.name + e.message);
        return SCAN.fail(denied ? 'ยังไม่ได้อนุญาตให้ใช้กล้อง' : 'เปิดกล้องไม่ได้',
          denied
            ? 'กดไอคอนกล้อง (หรือรูปแม่กุญแจ) ที่แถบที่อยู่เว็บ → อนุญาตกล้อง → แล้วลองสแกนอีกครั้ง'
            : 'ข้อความจากเบราว์เซอร์: ' + esc(e.message));
      }
      const vid = $('#scanVid');
      vid.srcObject = SCAN.stream;
      try { await vid.play(); } catch (e) { void e; }

      let det;
      try {
        let formats = SCAN.FORMATS;
        if (window.BarcodeDetector.getSupportedFormats) {
          const avail = await window.BarcodeDetector.getSupportedFormats();
          const hit = SCAN.FORMATS.filter((f) => avail.includes(f));
          if (hit.length) formats = hit;
        }
        det = new window.BarcodeDetector({ formats });
      } catch (e) {
        return SCAN.fail('เริ่มตัวอ่านบาร์โค้ดไม่สำเร็จ', esc(e.message));
      }

      SCAN.running = true;
      let misses = 0;
      SCAN.timer = setInterval(async () => {
        if (!SCAN.running) return;
        try {
          const hits = await det.detect(vid);
          if (hits && hits.length) {
            const value = String(hits[0].rawValue || '').trim();
            if (value) {
              if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) { void e; } }
              const cb = SCAN.onResult;
              SCAN.close();
              if (cb) cb(value, hits[0].format);
            }
          } else if (++misses === 60) {
            toast('ยังอ่านไม่ได้ — ลองขยับระยะหรือเพิ่มแสงดูครับ');
          }
        } catch (e) { void e; }
      }, 220);
    },

    fail(title, html) {
      const ov = $('#scanOv');
      ov.classList.add('err');
      $('#scanErr').innerHTML =
        `<b>${esc(title)}</b>${html}<div class="row">
           <button class="btn btn-primary btn-sm" data-s="manual">พิมพ์เองแทน</button>
           <button class="btn btn-sm" data-s="close">ปิด</button></div>`;
    },

    close() {
      SCAN.running = false;
      if (SCAN.timer) { clearInterval(SCAN.timer); SCAN.timer = null; }
      if (SCAN.stream) { SCAN.stream.getTracks().forEach((t) => t.stop()); SCAN.stream = null; }
      const vid = $('#scanVid');
      if (vid) vid.srcObject = null;
      $('#scanOv').classList.remove('on', 'err');
      SCAN.onResult = null;
    },
  };

  /** เปิดสแกนเพื่อกรอกลงช่องบาร์โค้ดในฟอร์ม */
  function scanIntoField() {
    SCAN.open('สแกนบาร์โค้ดสินค้า', async (value) => {
      const cur = String(S.edit.barcode || '').trim();

      // เคส "สินค้าเปลี่ยนเลขบาร์โค้ดใหม่" — มีเลขเดิมอยู่แล้วและเลขที่สแกนไม่เหมือนกัน
      if (cur && cur !== value) {
        const keep = confirm(
          `เลขที่สแกนได้ไม่ตรงกับเลขเดิมในรายการนี้\n\n` +
          `เลขเดิม: ${cur}\nเลขใหม่: ${value}\n\n` +
          `กด "ตกลง" = เปลี่ยนเป็นเลขใหม่ และเก็บเลขเดิมไว้ให้ยิงหาเจอได้\n` +
          `กด "ยกเลิก" = ไม่เปลี่ยนอะไร`
        );
        if (!keep) return;
        const olds = SCHEMA.codes(S.edit.barcodeOld);
        if (!olds.includes(cur)) olds.push(cur);
        S.edit.barcodeOld = olds.join(', ');
        S.edit.barcodeStatus = 'changed';
        S.edit.barcode = value;
        S.dirty = true;
        renderForm(null);
        toast(`เปลี่ยนเป็น ${value} · เก็บเลขเดิม ${cur} ไว้แล้ว`);
        return;
      }

      S.edit.barcode = value;
      if (S.edit.barcodeStatus === 'pending') S.edit.barcodeStatus = 'ok';
      S.dirty = true;
      renderForm(null);
      const hit = findByCode(value);
      if (hit && hit.product.id !== S.edit.id) {
        toast(`⚠ เลขนี้ใช้อยู่กับ ${hit.product.code || ''} ${hit.product.name || ''}${hit.viaOld ? ' (เป็นเลขเดิมของรายการนั้น)' : ''}`, true);
      } else toast('อ่านได้: ' + value);
    });
  }

  /** เปิดสแกนเพื่อค้นหาสินค้าที่บันทึกไว้แล้ว */
  function scanToSearch() {
    SCAN.open('สแกนเพื่อค้นหาสินค้า', (value) => {
      const hit = findByCode(value);
      if (hit) {
        S.view = 'items'; S.fEntry = 'all'; S.fPhoto = 'all'; S.fBarcode = 'all'; S.query = value;
        render();
        if (hit.viaOld) {
          toast(`นี่คือบาร์โค้ดเดิมของ ${hit.product.name || hit.product.code} · เลขที่ใช้อยู่ตอนนี้คือ ${hit.product.barcode || '(ยังไม่มี)'}`);
        } else toast('พบแล้ว: ' + (hit.product.name || hit.product.code));
        openForm(hit.product);
      } else {
        const d = SCHEMA.blank();
        d.barcode = value;
        openForm(d);
        toast('ยังไม่มีในระบบ — สร้างรายการใหม่ให้แล้ว');
      }
    });
  }

  /* ================= โหลดข้อมูล ================= */
  async function reload() {
    S.products = await DB.listProducts();
    const imgs = await DB.listAllImages();
    const covers = {};
    imgs.sort((a, b) => (a.order || 0) - (b.order || 0));
    imgs.forEach((im) => { if (!covers[im.productId]) covers[im.productId] = im; });
    S.covers = covers;
    // datalist แบรนด์
    const brands = Array.from(new Set(S.products.map((p) => (p.brand || '').trim()).filter(Boolean))).sort();
    $('#brands').innerHTML = brands.map((b) => `<option value="${esc(b)}">`).join('');
    render();
  }

  function counts() {
    const c = {
      all: S.products.length, pending: 0, shot: 0, uploaded: 0, na: 0, noimg: 0,
      replace: 0, new: 0, restock: 0,
      bcOk: 0, bcChanged: 0, bcNolabel: 0, bcPending: 0, bcTodo: 0,
    };
    S.products.forEach((p) => {
      c[p.photoStatus] = (c[p.photoStatus] || 0) + 1;
      c[p.entryType] = (c[p.entryType] || 0) + 1;
      if (!p.imageCount) c.noimg++;
      const bs = p.barcodeStatus || 'ok';
      if (bs === 'changed') c.bcChanged++;
      else if (bs === 'nolabel') c.bcNolabel++;
      else if (bs === 'pending') c.bcPending++;
      else c.bcOk++;
      if (SCHEMA.barcodeTodo(p)) c.bcTodo++;
    });
    return c;
  }

  /** หาสินค้าจากเลขบาร์โค้ด — เจอทั้งเลขที่ใช้อยู่และเลขเดิม */
  function findByCode(value) {
    const v = String(value || '').trim();
    if (!v) return null;
    const exact = S.products.find((p) => String(p.barcode || '').trim() === v);
    if (exact) return { product: exact, viaOld: false };
    const old = S.products.find((p) => SCHEMA.codes(p.barcodeOld).includes(v));
    if (old) return { product: old, viaOld: true };
    return null;
  }

  function filtered() {
    const q = S.query.trim().toLowerCase();
    let list = S.products.filter((p) => {
      if (S.fEntry !== 'all' && p.entryType !== S.fEntry) return false;
      if (S.fPhoto === 'noimg') { if (p.imageCount) return false; }
      else if (S.fPhoto !== 'all' && p.photoStatus !== S.fPhoto) return false;
      if (S.fBarcode === 'todo') { if (!SCHEMA.barcodeTodo(p)) return false; }
      else if (S.fBarcode !== 'all' && (p.barcodeStatus || 'ok') !== S.fBarcode) return false;
      if (!q) return true;
      return ['code', 'barcode', 'barcodeOld', 'barcodeNote', 'name', 'brand', 'model', 'replaces', 'note']
        .map((k) => String(p[k] || '')).join(' ').toLowerCase().includes(q);
    });
    const cmp = {
      updated: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
      arrivalDesc: (a, b) => String(b.arrivalDate || '').localeCompare(String(a.arrivalDate || '')),
      arrivalAsc: (a, b) => String(a.arrivalDate || '9999').localeCompare(String(b.arrivalDate || '9999')),
      name: (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'th'),
      code: (a, b) => String(a.code || '').localeCompare(String(b.code || ''), 'th', { numeric: true }),
    }[S.sort] || cmp_updated;
    function cmp_updated(a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); }
    return list.sort(cmp);
  }

  /* ================= render ================= */
  function render() {
    const c = counts();
    $('#pillItems').textContent = nf(c.all);
    $('#pillQueue').textContent = nf(c.pending);
    const pb = $('#pillBarcode');
    if (pb) {
      const n = c.bcTodo + c.bcChanged + c.bcNolabel;
      pb.textContent = nf(n);
      pb.classList.toggle('hot', c.bcTodo > 0);
    }
    $$('#nav button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.view === S.view)));
    const m = $('#main');
    if (S.view === 'overview') m.innerHTML = viewOverview(c);
    else if (S.view === 'items') m.innerHTML = viewItems();
    else if (S.view === 'queue') m.innerHTML = viewQueue();
    else if (S.view === 'barcode') m.innerHTML = viewBarcode();
    else m.innerHTML = viewData();
    if (S.view === 'data') fillDataStats();
    bindMain();
  }

  function statusTag(p) {
    const t = SCHEMA.tone(p.photoStatus);
    return `<span class="tag ${t}">${esc(SCHEMA.label(SCHEMA.PHOTO_STATUS, p.photoStatus))}</span>`;
  }
  function barcodeTag(p) {
    const bs = p.barcodeStatus || 'ok';
    if (bs === 'ok') {
      return SCHEMA.barcodeTodo(p) ? `<span class="tag warn">ยังไม่มีบาร์โค้ด</span>` : '';
    }
    return `<span class="tag ${SCHEMA.toneIn(SCHEMA.BARCODE_STATUS, bs)}">${esc(SCHEMA.label(SCHEMA.BARCODE_STATUS, bs))}</span>`;
  }
  function entryTag(p) {
    if (p.entryType === 'replace') return `<span class="tag dark">แทนรุ่นเดิม</span>`;
    if (p.entryType === 'restock') return `<span class="tag">เข้าเพิ่ม</span>`;
    return `<span class="tag">เข้าใหม่</span>`;
  }

  function cardHTML(p) {
    const cov = S.covers[p.id];
    const thumb = cov
      ? `<img loading="lazy" src="${urlFor('t' + cov.id, cov.thumb)}" alt="${esc(p.name)}">`
      : `<div class="none"><span style="font-size:22px">📷</span><span>ยังไม่มีรูป</span></div>`;
    return `
    <article class="card" data-id="${p.id}">
      <div class="thumb${cov ? '' : ' no-img'}" data-act="open" title="${cov ? 'ดูรูปทั้งหมด' : 'แนบรูป'}">${thumb}${p.imageCount > 1 ? `<span class="count">${p.imageCount} รูป</span>` : ''}</div>
      <div class="body">
        <div>
          <div class="code">${esc(p.code || '—')}</div>
          <h3>${esc(p.name || '(ไม่มีชื่อ)')}</h3>
        </div>
        <div class="meta">
          ${p.brand ? `<span>${esc(p.brand)}</span>` : ''}
          ${p.model ? `<span>รุ่น ${esc(p.model)}</span>` : ''}
          <span>เข้า ${fmtDate(p.arrivalDate)}</span>
        </div>
        ${p.barcode || p.barcodeOld ? `<div class="meta bc-line">
          ${p.barcode ? `<span title="บาร์โค้ดที่ใช้อยู่">▍▍▎ ${esc(p.barcode)}</span>` : ''}
          ${SCHEMA.codes(p.barcodeOld).length ? `<span class="bc-old" title="บาร์โค้ดเดิม ยิงแล้วยังหาเจอ">เดิม ${esc(SCHEMA.codes(p.barcodeOld).join(', '))}</span>` : ''}
        </div>` : ''}
        ${p.barcodeNote ? `<div class="repl">บาร์โค้ด: ${esc(p.barcodeNote)}</div>` : ''}
        ${p.entryType === 'replace' && p.replaces ? `<div class="repl">แทนรุ่นเดิม → <b>${esc(p.replaces)}</b></div>` : ''}
        ${p.note ? `<div class="meta" style="color:var(--muted)">${esc(p.note.slice(0, 90))}${p.note.length > 90 ? '…' : ''}</div>` : ''}
        <div class="foot">
          ${entryTag(p)}${statusTag(p)}${barcodeTag(p)}
          <span style="flex:1"></span>
          <button class="btn btn-sm" data-act="edit">แก้ไข</button>
        </div>
      </div>
    </article>`;
  }

  function viewItems() {
    const list = filtered();
    const c = counts();
    const cur = { entry: S.fEntry, photo: S.fPhoto, barcode: S.fBarcode };
    const chip = (group, key, label, n) =>
      `<button class="chip" data-chip="${group}" data-key="${key}" aria-pressed="${cur[group] === key}">${label}${n !== undefined ? ` · ${nf(n)}` : ''}</button>`;
    return `
    <p class="sec-label">สินค้าที่บันทึกไว้ (${nf(c.all)} รายการ)</p>
    <div class="toolbar">
      <div class="search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="q" type="search" placeholder="ค้นหา รหัส / บาร์โค้ด / ชื่อ / แบรนด์ / รุ่นเดิม" value="${esc(S.query)}">
      </div>
      <button class="btn btn-scan" id="btnScanSearch" title="สแกนบาร์โค้ดเพื่อค้นหา">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">
          <path d="M3 8V5a2 2 0 012-2h3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M21 16v3a2 2 0 01-2 2h-3M7 8v8M11 8v8M15 8v8M18 8v8"/>
        </svg>สแกน</button>
      <select class="sortsel" id="sort">
        <option value="updated"${S.sort === 'updated' ? ' selected' : ''}>แก้ไขล่าสุด</option>
        <option value="arrivalDesc"${S.sort === 'arrivalDesc' ? ' selected' : ''}>วันที่เข้า ใหม่→เก่า</option>
        <option value="arrivalAsc"${S.sort === 'arrivalAsc' ? ' selected' : ''}>วันที่เข้า เก่า→ใหม่</option>
        <option value="code"${S.sort === 'code' ? ' selected' : ''}>รหัสสินค้า</option>
        <option value="name"${S.sort === 'name' ? ' selected' : ''}>ชื่อสินค้า</option>
      </select>
    </div>
    <div class="chips">
      ${chip('entry', 'all', 'ทุกประเภท')}
      ${chip('entry', 'new', 'เข้าใหม่', c.new)}
      ${chip('entry', 'replace', 'แทนรุ่นเดิม', c.replace)}
      ${chip('entry', 'restock', 'เข้าเพิ่ม', c.restock)}
      <span style="width:10px"></span>
      ${chip('photo', 'all', 'ทุกสถานะรูป')}
      ${chip('photo', 'pending', 'รอถ่ายรูป', c.pending)}
      ${chip('photo', 'shot', 'ถ่ายแล้ว', c.shot)}
      ${chip('photo', 'uploaded', 'อัปโหลดแล้ว', c.uploaded)}
      ${chip('photo', 'noimg', 'ยังไม่มีรูปแนบ', c.noimg)}
    </div>
    <div class="chips">
      ${chip('barcode', 'all', 'ทุกสถานะบาร์โค้ด')}
      ${chip('barcode', 'changed', 'เปลี่ยนเลขใหม่', c.bcChanged)}
      ${chip('barcode', 'nolabel', 'ติดบาร์โค้ดไม่ได้', c.bcNolabel)}
      ${chip('barcode', 'todo', 'ยังไม่มีเลข', c.bcTodo)}
    </div>
    ${list.length
        ? `<div class="list">${list.map(cardHTML).join('')}</div>`
        : `<div class="empty"><b>ยังไม่มีรายการที่ตรงเงื่อนไข</b>${S.products.length ? 'ลองล้างตัวกรองหรือคำค้นหา' : 'กด “เพิ่มสินค้า” เพื่อบันทึกรายการแรก'}</div>`}
    `;
  }

  function qrowHTML(p, actions) {
    const cov = S.covers[p.id];
    const d = daysSince(p.arrivalDate);
    return `
    <div class="qrow" data-id="${p.id}">
      <div class="q-thumb" data-act="open">${cov ? `<img loading="lazy" src="${urlFor('t' + cov.id, cov.thumb)}">` : '📷'}</div>
      <div class="q-main">
        <h4>${esc(p.name || '(ไม่มีชื่อ)')} <span style="color:var(--muted);font-weight:600;font-size:12.5px">${esc(p.code || '')}</span></h4>
        <p>${[p.brand, p.model && 'รุ่น ' + p.model, 'เข้า ' + fmtDate(p.arrivalDate), p.imageCount ? p.imageCount + ' รูป' : 'ไม่มีรูป'].filter(Boolean).map(esc).join(' · ')}</p>
      </div>
      ${d !== null ? `<span class="age ${d >= 7 ? 'old' : ''}">${d <= 0 ? 'วันนี้' : d + ' วัน'}</span>` : ''}
      <div class="q-act">${actions}</div>
    </div>`;
  }

  function viewQueue() {
    const pending = S.products.filter((p) => p.photoStatus === 'pending')
      .sort((a, b) => String(a.arrivalDate || '9999').localeCompare(String(b.arrivalDate || '9999')));
    const shot = S.products.filter((p) => p.photoStatus === 'shot')
      .sort((a, b) => String(a.arrivalDate || '9999').localeCompare(String(b.arrivalDate || '9999')));
    return `
    <p class="sec-label">รอถ่ายรูป (${nf(pending.length)} รายการ · เรียงตามค้างนานที่สุด)</p>
    ${pending.length ? `<div class="qlist">${pending.map((p) => qrowHTML(p,
      `<button class="btn btn-primary btn-sm" data-act="addphoto">แนบรูป</button>
       <button class="btn btn-sm" data-act="mark" data-status="shot">ถ่ายแล้ว</button>`)).join('')}</div>`
      : `<div class="empty"><b>ไม่มีของค้างถ่าย 🎉</b>ทุกอย่างในคิวถูกจัดการเรียบร้อย</div>`}

    <p class="sec-label" style="margin-top:30px">ถ่ายแล้ว รออัปโหลดขึ้นระบบ (${nf(shot.length)})</p>
    ${shot.length ? `<div class="qlist">${shot.map((p) => qrowHTML(p,
      `<button class="btn btn-sm" data-act="addphoto">แนบรูป</button>
       <button class="btn btn-primary btn-sm" data-act="mark" data-status="uploaded">อัปโหลดแล้ว</button>`)).join('')}</div>`
      : `<div class="empty">ไม่มีรายการรออัปโหลด</div>`}
    `;
  }

  function brow(p, extra, actions) {
    const cov = S.covers[p.id];
    return `
    <div class="qrow" data-id="${p.id}">
      <div class="q-thumb" data-act="open">${cov ? `<img loading="lazy" src="${urlFor('t' + cov.id, cov.thumb)}">` : '📷'}</div>
      <div class="q-main">
        <h4>${esc(p.name || '(ไม่มีชื่อ)')} <span style="color:var(--muted);font-weight:600;font-size:12.5px">${esc(p.code || '')}</span></h4>
        <p>${extra}</p>
      </div>
      <div class="q-act">${actions}</div>
    </div>`;
  }

  function viewBarcode() {
    const changed = S.products.filter((p) => (p.barcodeStatus || 'ok') === 'changed' || SCHEMA.codes(p.barcodeOld).length)
      .sort((a, b) => String(b.barcodeChangedAt || b.updatedAt).localeCompare(String(a.barcodeChangedAt || a.updatedAt)));
    const nolabel = S.products.filter((p) => p.barcodeStatus === 'nolabel')
      .sort((a, b) => String(a.code || '').localeCompare(String(b.code || ''), 'th', { numeric: true }));
    const todo = S.products.filter((p) => SCHEMA.barcodeTodo(p))
      .sort((a, b) => String(a.arrivalDate || '9999').localeCompare(String(b.arrivalDate || '9999')));
    const edit = `<button class="btn btn-sm" data-act="edit">แก้ไข</button>`;
    const scanBtn = `<button class="btn btn-primary btn-sm" data-act="rescan">สแกนเลขใหม่</button>`;

    return `
    <p class="sec-label">เปลี่ยนเลขบาร์โค้ดใหม่ (${nf(changed.length)}) — ยิงเลขเดิมก็ยังหาเจอ</p>
    ${changed.length ? `<div class="qlist">${changed.map((p) => brow(p,
      `<span class="bc-flow"><b>เดิม ${esc(SCHEMA.codes(p.barcodeOld).join(', ') || '—')}</b> → <b class="now">${esc(p.barcode || '(ยังไม่มี)')}</b></span>` +
      (p.barcodeChangedAt ? ` · เปลี่ยน ${fmtDate(p.barcodeChangedAt)}` : ''),
      scanBtn + edit)).join('')}</div>`
      : `<div class="empty">ยังไม่มีรายการที่เปลี่ยนเลขบาร์โค้ด</div>`}

    <p class="sec-label" style="margin-top:30px">ติดบาร์โค้ดไม่ได้ (${nf(nolabel.length)}) — ต้องใช้วิธีอื่น</p>
    ${nolabel.length ? `<div class="qlist">${nolabel.map((p) => brow(p,
      (p.barcodeNote ? esc(p.barcodeNote) : '<span style="color:var(--warn)">ยังไม่ได้ระบุวิธีจัดการ — กดแก้ไขเพื่อใส่</span>') +
      (p.barcode ? ` · เลขที่ใช้ ${esc(p.barcode)}` : ' · ไม่มีเลข'),
      edit)).join('')}</div>`
      : `<div class="empty">ไม่มีรายการที่ติดบาร์โค้ดไม่ได้</div>`}

    <p class="sec-label" style="margin-top:30px">ยังไม่มีเลขบาร์โค้ด (${nf(todo.length)})</p>
    ${todo.length ? `<div class="qlist">${todo.map((p) => brow(p,
      `${[p.brand, p.model && 'รุ่น ' + p.model, 'เข้า ' + fmtDate(p.arrivalDate)].filter(Boolean).map(esc).join(' · ')}`,
      `<button class="btn btn-primary btn-sm" data-act="rescan">สแกนใส่เลข</button>
       <button class="btn btn-sm" data-act="nolabel">ติดไม่ได้</button>`)).join('')}</div>`
      : `<div class="empty">ทุกรายการมีเลขบาร์โค้ดครบแล้ว 🎉</div>`}
    `;
  }

  function viewOverview(c) {
    const recent = S.products.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 6);
    const oldest = S.products.filter((p) => p.photoStatus === 'pending')
      .sort((a, b) => String(a.arrivalDate || '9999').localeCompare(String(b.arrivalDate || '9999')))[0];
    const od = oldest ? daysSince(oldest.arrivalDate) : null;
    return `
    <p class="sec-label">ภาพรวมวันนี้</p>
    <div class="stats">
      <div class="stat clickable" data-go="items" data-entry="all" data-photo="all"><b>${nf(c.all)}</b><span>สินค้าทั้งหมด</span></div>
      <div class="stat clickable" data-go="queue"><b>${nf(c.pending)}</b><span>รอถ่ายรูป</span></div>
      <div class="stat light clickable" data-go="items" data-entry="all" data-photo="shot"><b>${nf(c.shot)}</b><span>ถ่ายแล้ว รออัปโหลด</span></div>
      <div class="stat light clickable" data-go="items" data-entry="replace" data-photo="all"><b>${nf(c.replace)}</b><span>มาแทนรุ่นเดิม</span></div>
      <div class="stat light clickable" data-go="items" data-entry="all" data-photo="noimg"><b>${nf(c.noimg)}</b><span>ยังไม่มีรูปแนบ</span></div>
      <div class="stat light clickable" data-go="barcode"><b>${nf(c.bcTodo)}</b><span>ยังไม่มีบาร์โค้ด</span></div>
      <div class="stat light clickable" data-go="barcode"><b>${nf(c.bcChanged)}</b><span>เปลี่ยนเลขบาร์โค้ด</span></div>
      <div class="stat light clickable" data-go="barcode"><b>${nf(c.bcNolabel)}</b><span>ติดบาร์โค้ดไม่ได้</span></div>
    </div>
    ${od !== null && od >= 7 ? `<div class="dark-note" style="margin-bottom:22px"><span class="t">มีของค้างถ่ายนาน ${od} วัน</span>${esc(oldest.code || '')} · ${esc(oldest.name || '')} — เข้ามาตั้งแต่ ${fmtDate(oldest.arrivalDate)} <button class="btn btn-sm" data-go="queue" style="margin-left:8px">ดูคิวถ่ายรูป</button></div>` : ''}

    <p class="sec-label">แก้ไขล่าสุด</p>
    ${recent.length ? `<div class="list">${recent.map(cardHTML).join('')}</div>`
        : `<div class="empty"><b>ยังไม่มีข้อมูล</b>กด “เพิ่มสินค้า” เพื่อเริ่มบันทึกรายการแรก</div>`}
    `;
  }

  function viewData() {
    return `
    <p class="sec-label">ข้อมูลของคุณ</p>
    <div class="panel">
      <h3>สรุปพื้นที่จัดเก็บ</h3>
      <p>ข้อมูลทั้งหมดเก็บอยู่ใน IndexedDB ของเบราว์เซอร์เครื่องนี้ ไม่ได้ส่งออกไปที่ไหน</p>
      <dl class="kv" id="dataStats"><dt>กำลังคำนวณ…</dt><dd></dd></dl>
    </div>
    <div class="panel">
      <h3>สำรอง / ย้ายเครื่อง</h3>
      <p>ส่งออกเป็นไฟล์เดียว (รูปภาพถูกฝังเป็น base64) เก็บไว้ใน Google Drive หรือส่งเข้าเครื่องอื่นแล้วนำเข้าได้</p>
      <div class="row">
        <button class="btn btn-primary" data-act="export">ส่งออกไฟล์สำรอง (.json)</button>
        <button class="btn" data-act="exportcsv">ส่งออกตาราง (.csv)</button>
        <button class="btn" data-act="import">นำเข้าไฟล์สำรอง</button>
      </div>
      <p class="hint" style="margin-top:10px">การนำเข้าเป็นแบบรวมข้อมูล (merge) — รายการเดียวกันจะใช้เวอร์ชันที่แก้ไขใหม่กว่า</p>
    </div>
    <div class="panel">
      <h3>ล้างข้อมูล</h3>
      <p>ลบทุกอย่างในเครื่องนี้ กู้คืนไม่ได้ — แนะนำให้ส่งออกไฟล์สำรองก่อน</p>
      <div class="row">
        <button class="btn" data-act="purge">ล้างรายการที่ลบแล้วออกจริง</button>
        <button class="btn btn-danger" data-act="wipe">ลบข้อมูลทั้งหมด</button>
      </div>
    </div>
    <div class="dark-note">
      <span class="t">อยากให้ทีมเห็นข้อมูลชุดเดียวกัน?</span>
      ระบบนี้ออกแบบเผื่อไว้แล้ว — ทุกเรคคอร์ดมี <b>id · updatedAt · rev · deleted</b> ครบสำหรับการซิงก์
      เมื่อพร้อมต่อ Supabase / Firebase / Google Sheets แก้เพียง <b>DB.remote</b> ในไฟล์ db.js โดยไม่ต้องแก้หน้าจอ
    </div>
    <footer>แก้ไฟล์ → push ขึ้น GitHub → Pages เผยแพร่เองใน 1–2 นาที → Service Worker ดึงเวอร์ชันใหม่ให้ผู้ใช้</footer>
    `;
  }

  async function fillDataStats() {
    const st = await DB.stats();
    const el = $('#dataStats');
    if (!el) return;
    const used = st.quota && st.quota.usage ? fmtBytes(st.quota.usage) : '—';
    const quota = st.quota && st.quota.quota ? fmtBytes(st.quota.quota) : '—';
    el.innerHTML = `
      <dt>สินค้า</dt><dd>${nf(st.products)} รายการ</dd>
      <dt>รูปภาพ</dt><dd>${nf(st.images)} รูป (${fmtBytes(st.bytes)})</dd>
      <dt>เบราว์เซอร์ใช้ไป</dt><dd>${used} จากโควตา ${quota}</dd>`;
  }

  /* ================= ฟอร์ม (drawer) ================= */
  function fieldHTML(f, d, errors) {
    if (f.showIf && !f.showIf(d)) return '';
    const v = d[f.key] ?? '';
    const err = errors && errors[f.key];
    const req = f.required ? ' <span class="req">*</span>' : '';
    let input;
    if (f.type === 'select') {
      input = `<select data-k="${f.key}">${f.options.map((o) =>
        `<option value="${o.key}"${v === o.key ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea data-k="${f.key}" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
    } else {
      input = `<input data-k="${f.key}" type="${f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}"
        value="${esc(v)}" placeholder="${esc(f.placeholder || '')}"${f.datalist ? ` list="${f.datalist}"` : ''}${f.inputMode ? ` inputmode="${f.inputMode}"` : ''}>`;
      if (f.scan) input = `<div class="with-btn">${input}
        <button type="button" class="scan" data-scan="1" title="สแกนด้วยกล้อง">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">
            <path d="M3 8V5a2 2 0 012-2h3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M21 16v3a2 2 0 01-2 2h-3M7 8v8M11 8v8M15 8v8M18 8v8"/>
          </svg>สแกน</button></div>`;
    }
    return `<div class="field${f.col === 2 ? ' col2' : ''}${err ? ' invalid' : ''}">
      <label>${esc(f.label)}${req}</label>${input}${err ? `<span class="err">${esc(err)}</span>` : ''}</div>`;
  }

  function renderForm(errors) {
    const d = S.edit;
    $('#dTitle').textContent = d.id ? 'แก้ไขสินค้า' : 'เพิ่มสินค้า';
    $('#dDelete').style.display = d.id ? '' : 'none';
    $('#dBody').innerHTML = `
      <div class="grid2">${SCHEMA.FIELDS.map((f) => fieldHTML(f, d, errors)).join('')}</div>
      <p class="sec-label" style="margin:18px 0 10px">รูปภาพ</p>
      <div class="drop" id="drop">
        <b>เลือกรูป หรือลากไฟล์มาวาง</b>
        เลือกได้หลายรูปพร้อมกัน · ระบบย่อเป็น JPEG ด้านยาว ${IMG.MAX}px ให้อัตโนมัติ
        <input type="file" id="file" accept="image/*" multiple hidden>
      </div>
      <div class="prog" id="prog"><i></i></div>
      <div class="imgs" id="imgs"></div>
      ${(d.barcodeHistory || []).length ? `
        <p class="sec-label" style="margin:18px 0 8px">ประวัติการเปลี่ยนเลขบาร์โค้ด</p>
        <ul class="bc-hist">${d.barcodeHistory.slice().reverse().map((h) =>
        `<li><span>${esc(h.from)}</span> → <b>${esc(h.to)}</b><em>${fmtDate(h.at)}</em></li>`).join('')}</ul>` : ''}
      ${d.id ? `<p class="hint" style="margin-top:16px">สร้างเมื่อ ${fmtDate(d.createdAt)} · แก้ไขล่าสุด ${fmtDate(d.updatedAt)}</p>` : ''}
    `;
    renderImages();
    bindForm();
  }

  function renderImages() {
    const box = $('#imgs');
    if (!box) return;
    const rows = []
      .concat(S.editImages.map((im, i) => ({ kind: 'saved', id: im.id, blob: im.thumb, key: 't' + im.id, i })))
      .concat(S.pendingImages.map((im, i) => ({ kind: 'new', blob: im.thumb, key: 'p' + i + '-' + (im.name || '') + im.bytes, i })));
    if (!rows.length) { box.innerHTML = ''; return; }
    box.innerHTML = rows.map((r, idx) => `
      <figure data-kind="${r.kind}" data-i="${r.i}"${r.id ? ` data-id="${r.id}"` : ''}>
        <img src="${urlFor(r.key, r.blob)}" data-act="zoom" alt="">
        <button class="x" data-act="rm" title="ลบรูป">✕</button>
        ${idx === 0 ? `<span class="cover">รูปหลัก</span>`
        : r.kind === 'saved' ? `<button class="star" data-act="cover">ตั้งเป็นหลัก</button>` : ''}
      </figure>`).join('');
  }

  function openForm(doc, focusImages) {
    S.edit = doc ? Object.assign({}, doc) : SCHEMA.blank();
    S.pendingImages = [];
    S.dirty = false;
    S.editImages = [];
    renderForm(null);
    $('#drawer').classList.add('on');
    $('#scrim').classList.add('on');
    document.body.style.overflow = 'hidden';
    if (doc && doc.id) {
      DB.listImages(doc.id).then((imgs) => { S.editImages = imgs; renderImages(); });
    }
    if (focusImages) setTimeout(() => { const f = $('#file'); if (f) f.click(); }, 260);
    else setTimeout(() => { const el = $('#dBody input'); if (el) el.focus(); }, 260);
  }

  function closeForm(force) {
    if (!force && S.dirty && !confirm('ยังไม่ได้บันทึก ปิดฟอร์มเลยไหม?')) return;
    $('#drawer').classList.remove('on');
    $('#scrim').classList.remove('on');
    document.body.style.overflow = '';
    S.edit = null; S.pendingImages = []; S.editImages = []; S.dirty = false;
  }

  async function saveForm() {
    const d = S.edit;
    const errors = SCHEMA.validate(d);
    if (Object.keys(errors).length) { renderForm(errors); toast('กรอกข้อมูลที่จำเป็นให้ครบ', true); return; }
    const bc = String(d.barcode || '').trim();

    // ถ้าเลขบาร์โค้ดเปลี่ยนจากที่บันทึกไว้ → เก็บเลขเดิม + จดประวัติให้อัตโนมัติ
    const prev = d.id ? S.products.find((p) => p.id === d.id) : null;
    const prevBc = prev ? String(prev.barcode || '').trim() : '';
    if (prevBc && bc && prevBc !== bc) {
      const olds = SCHEMA.codes(d.barcodeOld);
      if (!olds.includes(prevBc)) olds.push(prevBc);
      d.barcodeOld = olds.join(', ');
      d.barcodeHistory = (prev.barcodeHistory || []).concat([{ from: prevBc, to: bc, at: new Date().toISOString() }]);
      d.barcodeChangedAt = new Date().toISOString();
      if (!d.barcodeStatus || d.barcodeStatus === 'ok') d.barcodeStatus = 'changed';
    }

    // เตือนถ้าบาร์โค้ดซ้ำกับรายการอื่น (ยังบันทึกได้ถ้ายืนยัน — บางร้านใช้บาร์โค้ดเดียวหลายไซซ์)
    if (bc) {
      const hit = findByCode(bc);
      if (hit && hit.product.id !== d.id) {
        const dup = hit.product;
        if (!confirm(`บาร์โค้ด ${bc} ${hit.viaOld ? 'เป็นเลขเดิมของ' : 'ถูกใช้กับ'} "${dup.code || ''} ${dup.name || ''}" อยู่แล้ว\nบันทึกซ้ำต่อไหม?`)) return;
      }
    }
    const btn = $('#dSave'); btn.disabled = true; btn.textContent = 'กำลังบันทึก…';
    try {
      const rec = await DB.saveProduct(d);
      if (S.pendingImages.length) {
        await DB.addImages(rec.id, S.pendingImages.map((im) => ({
          blob: im.blob, thumb: im.thumb, w: im.w, h: im.h, bytes: im.bytes, name: im.name,
        })));
        // แนบรูปแล้วยังอยู่สถานะ "รอถ่ายรูป" → เลื่อนเป็น "ถ่ายแล้ว" ให้เอง
        if (rec.photoStatus === 'pending') await DB.setPhotoStatus(rec.id, 'shot');
      }
      closeForm(true);
      await reload();
      toast('บันทึกแล้ว');
    } catch (e) {
      console.error(e);
      toast('บันทึกไม่สำเร็จ: ' + e.message, true);
    } finally {
      btn.disabled = false; btn.textContent = 'บันทึก';
    }
  }

  async function addFiles(files) {
    const list = Array.from(files || []).filter((f) => f && (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i.test(f.name)));
    if (!list.length) return;
    const prog = $('#prog'); const bar = prog ? prog.firstElementChild : null;
    if (prog) { prog.classList.add('on'); bar.style.width = '0%'; }
    let ok = 0, saved = 0;
    for (let i = 0; i < list.length; i++) {
      try {
        const im = await processImage(list[i]);
        S.pendingImages.push(im);
        saved += Math.max(0, (im.srcBytes || 0) - im.bytes);
        ok++;
      } catch (e) { toast(e.message, true); }
      if (bar) bar.style.width = Math.round(((i + 1) / list.length) * 100) + '%';
      renderImages();
    }
    if (prog) setTimeout(() => prog.classList.remove('on'), 400);
    if (ok) {
      S.dirty = true;
      toast(`เพิ่ม ${ok} รูป${saved > 200000 ? ` · ประหยัดพื้นที่ ${fmtBytes(saved)}` : ''}`);
    }
  }

  /* ================= lightbox ================= */
  function openLB(list, i) {
    S.lb = { list, i: i || 0 };
    showLB();
    $('#lb').classList.add('on');
  }
  function showLB() {
    const it = S.lb.list[S.lb.i];
    if (!it) return;
    $('#lbImg').src = urlFor('f' + (it.id || 'p' + S.lb.i), it.blob);
    $('#lbCap').textContent = `${S.lb.i + 1}/${S.lb.list.length}` + (it.w ? ` · ${it.w}×${it.h} · ${fmtBytes(it.bytes || 0)}` : '');
    const multi = S.lb.list.length > 1;
    $('#lbPrev').style.display = multi ? '' : 'none';
    $('#lbNext').style.display = multi ? '' : 'none';
  }
  function stepLB(n) {
    if (!S.lb.list.length) return;
    S.lb.i = (S.lb.i + n + S.lb.list.length) % S.lb.list.length;
    showLB();
  }
  function closeLB() { $('#lb').classList.remove('on'); }

  /* ================= export / import ================= */
  function download(name, blob) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

  async function doExport() {
    toast('กำลังเตรียมไฟล์…');
    const data = await DB.exportAll();
    download(`prathan-product-log-${stamp()}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
    toast(`ส่งออก ${nf(data.counts.products)} รายการ · ${nf(data.counts.images)} รูป`);
  }

  async function doExportCSV() {
    const rows = [SCHEMA.FIELDS.map((f) => f.label).concat(['จำนวนรูป', 'แก้ไขล่าสุด'])];
    filtered().forEach((p) => {
      rows.push(SCHEMA.FIELDS.map((f) => {
        const v = p[f.key] ?? '';
        if (f.type === 'select') return SCHEMA.label(f.options, v);
        return v;
      }).concat([p.imageCount || 0, p.updatedAt || '']));
    });
    const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    download(`prathan-product-log-${stamp()}.csv`, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    toast('ส่งออก CSV แล้ว');
  }

  function doImport() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const r = await DB.importAll(data, 'merge');
        await reload();
        toast(`นำเข้าแล้ว · เพิ่ม ${r.added} อัปเดต ${r.updated} รูป ${r.images}`);
      } catch (e) { toast('นำเข้าไม่สำเร็จ: ' + e.message, true); }
    };
    inp.click();
  }

  /* ================= bindings ================= */
  function bindMain() {
    const q = $('#q');
    if (q) {
      let t;
      q.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => { S.query = q.value; const p = q.selectionStart; render(); const nq = $('#q'); if (nq) { nq.focus(); nq.setSelectionRange(p, p); } }, 220);
      });
    }
    const sort = $('#sort');
    if (sort) sort.addEventListener('change', () => { S.sort = sort.value; render(); });
    const bss = $('#btnScanSearch');
    if (bss) bss.addEventListener('click', scanToSearch);

    $$('#main [data-chip]').forEach((b) => b.addEventListener('click', () => {
      const g = b.dataset.chip;
      if (g === 'entry') S.fEntry = b.dataset.key;
      else if (g === 'barcode') S.fBarcode = b.dataset.key;
      else S.fPhoto = b.dataset.key;
      render();
    }));

    $$('#main [data-go]').forEach((el) => el.addEventListener('click', () => {
      S.view = el.dataset.go;
      if (el.dataset.entry) S.fEntry = el.dataset.entry;
      if (el.dataset.photo) S.fPhoto = el.dataset.photo;
      render(); window.scrollTo({ top: 0 });
    }));

    // ผูก delegation ครั้งเดียวต่ออายุหน้า (กัน listener ซ้อนกันทุกครั้งที่ render)
    const mainEl = $('#main');
    if (!mainEl.dataset.bound) {
      mainEl.dataset.bound = '1';
      mainEl.addEventListener('click', async (e) => {
        const actEl = e.target.closest('[data-act]');
        const host = e.target.closest('[data-id]');
        if (!actEl || !host) return;
        const id = host.dataset.id;
        const p = S.products.find((x) => x.id === id);
        if (!p) return;
        const act = actEl.dataset.act;
        if (act === 'edit') openForm(p);
        else if (act === 'addphoto') openForm(p, true);
        else if (act === 'rescan') { openForm(p); setTimeout(scanIntoField, 320); }
        else if (act === 'nolabel') {
          const note = prompt(`"${p.name || p.code}" ติดบาร์โค้ดไม่ได้\nจะจัดการยังไง? (เว้นว่างได้)`,
            p.barcodeNote || 'ติดที่กล่องแทน');
          if (note === null) return;
          await DB.saveProduct(Object.assign({}, p, { barcodeStatus: 'nolabel', barcodeNote: note }));
          await reload();
          toast('บันทึกว่าติดบาร์โค้ดไม่ได้แล้ว');
        }
        else if (act === 'mark') {
          await DB.setPhotoStatus(id, actEl.dataset.status);
          await reload();
          toast('อัปเดตสถานะแล้ว');
        } else if (act === 'open') {
          const imgs = await DB.listImages(id);
          if (imgs.length) openLB(imgs, 0); else openForm(p, true);
        }
      });
    }

    $$('#main [data-act]').forEach((b) => {
      if (b.closest('[data-id]')) return;
      const act = b.dataset.act;
      b.addEventListener('click', async () => {
        if (act === 'export') doExport();
        else if (act === 'exportcsv') doExportCSV();
        else if (act === 'import') doImport();
        else if (act === 'purge') {
          const n = await DB.purgeDeleted(); await reload(); toast(`ล้างออกจริง ${n} รายการ`);
        } else if (act === 'wipe') {
          if (!confirm('ลบข้อมูลทั้งหมดในเครื่องนี้? กู้คืนไม่ได้')) return;
          if (!confirm('ยืนยันอีกครั้ง — ส่งออกไฟล์สำรองไว้แล้วใช่ไหม?')) return;
          urlCache.forEach((u) => URL.revokeObjectURL(u)); urlCache.clear();
          await DB.wipeAll(); await reload(); toast('ลบข้อมูลทั้งหมดแล้ว');
        }
      });
    });
  }

  function bindForm() {
    $$('#dBody [data-k]').forEach((el) => {
      el.addEventListener('input', () => {
        const k = el.dataset.k;
        S.edit[k] = el.value;
        S.dirty = true;
        if (k === 'entryType') { const cur = S.edit; renderForm(null); void cur; }
      });
    });

    const sb = $('#dBody [data-scan]');
    if (sb) sb.addEventListener('click', scanIntoField);

    const drop = $('#drop'), file = $('#file');
    if (drop) {
      drop.addEventListener('click', (e) => { if (e.target !== file) file.click(); });
      ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
      file.addEventListener('change', () => { addFiles(file.files); file.value = ''; });
    }

    const imgs = $('#imgs');
    if (imgs) imgs.addEventListener('click', async (e) => {
      const fig = e.target.closest('figure'); if (!fig) return;
      const act = e.target.dataset.act;
      const kind = fig.dataset.kind, i = +fig.dataset.i;
      if (act === 'rm') {
        if (kind === 'new') { S.pendingImages.splice(i, 1); renderImages(); }
        else {
          const im = S.editImages[i];
          if (!im || !confirm('ลบรูปนี้?')) return;
          await DB.deleteImage(im.id);
          dropUrl('t' + im.id); dropUrl('f' + im.id);
          S.editImages = await DB.listImages(S.edit.id);
          renderImages();
          toast('ลบรูปแล้ว');
        }
      } else if (act === 'cover') {
        const im = S.editImages[i]; if (!im) return;
        await DB.setCover(im.id);
        S.editImages = await DB.listImages(S.edit.id);
        renderImages(); toast('ตั้งเป็นรูปหลักแล้ว');
      } else if (act === 'zoom') {
        const list = S.editImages.concat(S.pendingImages);
        openLB(list, kind === 'new' ? S.editImages.length + i : i);
      }
    });
  }

  function bindShell() {
    $$('#nav button').forEach((b) => b.addEventListener('click', () => {
      S.view = b.dataset.view; render(); window.scrollTo({ top: 0 });
    }));
    $('#btnAdd').addEventListener('click', () => openForm(null));
    $('#fab').addEventListener('click', () => openForm(null));
    $('#dClose').addEventListener('click', () => closeForm());
    $('#dCancel').addEventListener('click', () => closeForm());
    $('#scrim').addEventListener('click', () => closeForm());
    $('#dSave').addEventListener('click', saveForm);
    $('#dDelete').addEventListener('click', async () => {
      if (!S.edit || !S.edit.id) return;
      if (!confirm('ลบรายการนี้และรูปทั้งหมด?')) return;
      await DB.deleteProduct(S.edit.id);
      closeForm(true); await reload(); toast('ลบรายการแล้ว');
    });

    // สแกนบาร์โค้ด
    const focusBarcode = () => {
      const el = $('#dBody [data-k="barcode"]');
      if (el) { el.focus(); el.select(); }
      else toast('เปิดฟอร์มสินค้าแล้วพิมพ์ในช่องบาร์โค้ดได้เลย');
    };
    $('#scanClose').addEventListener('click', () => SCAN.close());
    $('#scanManual').addEventListener('click', () => { SCAN.close(); focusBarcode(); });
    $('#scanErr').addEventListener('click', (e) => {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      SCAN.close();
      if (b.dataset.s === 'manual') {
        if (!S.edit) openForm(null);
        setTimeout(focusBarcode, 300);
      }
    });

    $('#lbClose').addEventListener('click', closeLB);
    $('#lbPrev').addEventListener('click', () => stepLB(-1));
    $('#lbNext').addEventListener('click', () => stepLB(1));
    $('#lb').addEventListener('click', (e) => { if (e.target.id === 'lb') closeLB(); });
    $('#lbDl').addEventListener('click', () => {
      const it = S.lb.list[S.lb.i]; if (!it) return;
      download(it.name || 'photo.jpg', it.blob);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if ($('#scanOv').classList.contains('on')) SCAN.close();
        else if ($('#lb').classList.contains('on')) closeLB();
        else if (S.edit) closeForm();
      }
      if ($('#lb').classList.contains('on')) {
        if (e.key === 'ArrowLeft') stepLB(-1);
        if (e.key === 'ArrowRight') stepLB(1);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && S.edit) { e.preventDefault(); saveForm(); }
      if (e.key === 'n' && !S.edit && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) openForm(null);
    });

    window.addEventListener('beforeunload', (e) => {
      if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ================= start ================= */
  async function start() {
    bindShell();
    // รองรับ shortcut จาก manifest: ?view=queue / ?add=1
    try {
      const sp = new URLSearchParams(location.search);
      const v = sp.get('view');
      if (v && ['overview', 'items', 'queue', 'data'].includes(v)) S.view = v;
      if (sp.get('add')) setTimeout(() => openForm(null), 300);
    } catch (e) { void e; }
    try {
      await DB.open();
      if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { void e; } }
      await reload();
    } catch (e) {
      console.error(e);
      $('#main').innerHTML = `<div class="empty"><b>เปิดฐานข้อมูลไม่ได้</b>${esc(e.message)}<br>ถ้าใช้โหมดไม่บันทึกประวัติ (Private) เบราว์เซอร์อาจปิด IndexedDB</div>`;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  return { toast, reload, S, processImage, openForm, SCAN, scanToSearch, scanIntoField, get state() { return S; } };
})();
