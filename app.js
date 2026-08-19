/* ============================================================
   app.js — ตรรกะทั้งหมดของระบบบันทึกสินค้าใหม่
   ต้องโหลด config.js ก่อนไฟล์นี้
   ============================================================ */

/* ============================================================
   ส่วนที่ 1 — ชั้นข้อมูล IndexedDB (เก็บทั้งฐานเป็น 1 ก้อน)
   ============================================================ */
let _idb = null;

function openDB() {
  return new Promise((res, rej) => {
    if (_idb) return res(_idb);
    const rq = indexedDB.open(APP.dbName, 1);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains(APP.storeName)) d.createObjectStore(APP.storeName);
    };
    rq.onsuccess = () => { _idb = rq.result; res(_idb); };
    rq.onerror = () => rej(rq.error);
  });
}

function idbGet(key) {
  return openDB().then((d) => new Promise((res, rej) => {
    const rq = d.transaction(APP.storeName, 'readonly').objectStore(APP.storeName).get(key);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  }));
}

function idbSet(key, val) {
  return openDB().then((d) => new Promise((res, rej) => {
    const tx = d.transaction(APP.storeName, 'readwrite');
    tx.objectStore(APP.storeName).put(val, key);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  }));
}

/* ============================================================
   ส่วนที่ 2 — สถานะโปรแกรม
   ============================================================ */
const DEFAULT_DB = {
  products: [],
  inbox: [],   /* บาร์โค้ดที่จดไว้ก่อน ยังไม่ได้เพิ่มเป็นสินค้า */
  settings: {
    user: '',
    categories: [...DEFAULT_CATEGORIES],
    units: [...DEFAULT_UNITS],
    requireConfirmBy: true,   // ต้องกรอกชื่อผู้คอนเฟิร์ม
    autoArchiveOld: true,     // เปลี่ยนแทนตัวเก่า → เก็บตัวเก่าเข้าคลังอัตโนมัติ
  },
  meta: {
    createdAt: nowISO(), savedAt: '',
    lastPull: '', pushedAt: '', settingsAt: '', tombstones: [],
  },
};

let DB = JSON.parse(JSON.stringify(DEFAULT_DB));

const S = {
  tab: 'list',
  q: '',
  fType: 'all',
  fStatus: 'all',
  fChannel: 'all',
  fCategory: 'all',
  fArchived: 'active',
  sort: 'new',
  recentDays: 30,     // ช่วงเวลาของ "เพิ่งลงขาย" บน Dashboard
  bulk: false,        // โหมดเลือกหลายรายการในหน้ารอคอนเฟิร์ม
  sel: new Set(),
  draft: null,        // สินค้าที่กำลังกรอก/แก้ไข
  draftIsNew: true,
  viewId: null,       // สินค้าที่กำลังดูรายละเอียด
  saving: false,
};

const TABS = [
  { id: 'list',    label: 'รายการสินค้า', short: 'รายการ' },
  { id: 'form',    label: 'เพิ่มสินค้า',   short: 'เพิ่ม' },
  { id: 'pending', label: 'รอคอนเฟิร์ม',  short: 'คิวรอ' },
  { id: 'inbox',   label: 'บาร์โค้ดค้าง',  short: 'บาร์โค้ด' },
  { id: 'dash',    label: 'Dashboard',    short: 'ภาพรวม' },
  { id: 'set',     label: 'ตั้งค่า',       short: 'ตั้งค่า' },
];
/* ลำดับบนแถบเมนูล่างของมือถือ — ปุ่มเพิ่มสินค้าอยู่ตรงกลาง */
const BOTTOM_ORDER = ['list', 'pending', 'form', 'inbox', 'dash', 'set'];

/* ============================================================
   ขนาดหน้าจอ — ปรับหน้าตาตามอุปกรณ์
   มือถือ  <640px  : เมนูล่างแบบแอป · รายการเป็นการ์ด
   แท็บเล็ต 640–1023: เมนูบน · 2 คอลัมน์
   เดสก์ท็อป ≥1024px: เมนูข้าง · รายการเป็นตาราง · คีย์ลัด
   ============================================================ */
const MQ = {
  desk: window.matchMedia('(min-width:1024px)'),
  mob:  window.matchMedia('(max-width:639px)'),
};
const isDesk = () => MQ.desk.matches;
const isMob  = () => MQ.mob.matches;
[MQ.desk, MQ.mob].forEach((m) => m.addEventListener('change', () => render()));

/* ============================================================
   ส่วนที่ 3 — บันทึก / โหลด
   ============================================================ */
async function loadDB() {
  try {
    const d = await idbGet(APP.key);
    if (d && typeof d === 'object') {
      DB = Object.assign(JSON.parse(JSON.stringify(DEFAULT_DB)), d);
      DB.settings = Object.assign({}, DEFAULT_DB.settings, d.settings || {});
      DB.meta = Object.assign({}, DEFAULT_DB.meta, d.meta || {});
      if (!Array.isArray(DB.meta.tombstones)) DB.meta.tombstones = [];
      DB.products = Array.isArray(d.products) ? d.products : [];
      DB.inbox = Array.isArray(d.inbox) ? d.inbox : [];
      DB.products.forEach(migrate);
    }
  } catch (e) { console.warn('load failed', e); }
}

function migrate(p) {
  if (!p.channels) p.channels = {};
  CHANNEL_KEYS.forEach((k) => {
    if (!p.channels[k]) p.channels[k] = { status: 'off', requestedAt: '', confirmedBy: '', confirmedAt: '', listedAt: '', url: '', note: '' };
  });
  if (!Array.isArray(p.history)) p.history = [];
  if (typeof p.archived !== 'boolean') p.archived = false;
}

let _saveT = null;
async function save(immediate, noSync) {
  DB.meta.savedAt = nowISO();
  if (!noSync && typeof scheduleSync === 'function') scheduleSync();
  const doIt = async () => {
    try { await idbSet(APP.key, DB); }
    catch (e) { toast('บันทึกไม่สำเร็จ: ' + e.message, 'err'); }
  };
  if (immediate) return doIt();
  clearTimeout(_saveT);
  _saveT = setTimeout(doIt, 250);
}

/* สำรองก่อนการเปลี่ยนแปลงสำคัญ */
async function backup() {
  try { await idbSet(APP.backupKey, { at: nowISO(), db: JSON.parse(JSON.stringify(DB)) }); } catch (e) {}
}

/* ============================================================
   ส่วนที่ 4 — ตัวช่วย UI
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.3s'; }, 2200);
  setTimeout(() => el.remove(), 2600);
}

function closeModal() { $('#modal').innerHTML = ''; }

/* ============================================================
   ธีมสว่าง / มืด — เก็บไว้เฉพาะเครื่องนี้ (ไม่ซิงก์ข้ามเครื่อง)
   ค่า: 'auto' ตามเครื่อง · 'light' สว่าง · 'dark' มืด
   ============================================================ */
const THEME_KEY = 'pl_theme';

function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { return 'auto'; }
}

function isDark(t) {
  const v = t || getTheme();
  if (v === 'dark') return true;
  if (v === 'light') return false;
  return window.matchMedia && matchMedia('(prefers-color-scheme:dark)').matches;
}

function applyTheme() {
  const dark = isDark();
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const m = $('#metaTheme');
  if (m) m.setAttribute('content', dark ? '#0e1013' : '#f6f7f9');
  const b = $('#btnTheme');
  if (b) {
    b.textContent = dark ? '☀' : '☾';
    b.title = { auto: 'ธีม: ตามเครื่อง', light: 'ธีม: สว่าง', dark: 'ธีม: มืด' }[getTheme()];
  }
}

function setTheme(v) {
  try { localStorage.setItem(THEME_KEY, v); } catch (e) {}
  applyTheme();
}

/* ---------- ขนาดหน้าจอ (ย่อ/ขยายทั้งหน้า) — เก็บเฉพาะเครื่องนี้ ---------- */
const ZOOM_KEY = 'pl_zoom';
const ZOOMS = [['1', 'ปกติ'], ['1.15', 'ใหญ่'], ['1.3', 'ใหญ่มาก']];

function getZoom() {
  try { return localStorage.getItem(ZOOM_KEY) || '1'; } catch (e) { return '1'; }
}

function applyZoom() {
  const z = getZoom();
  document.documentElement.style.zoom = z === '1' ? '' : z;
}

function setZoom(v) {
  try { localStorage.setItem(ZOOM_KEY, v); } catch (e) {}
  applyZoom();
}

/* ปุ่มบนหัวเว็บ: สลับไปตรงข้ามกับที่เห็นอยู่ */
function toggleTheme() {
  setTheme(isDark() ? 'light' : 'dark');
  toast(isDark() ? 'ธีมมืด' : 'ธีมสว่าง');
  if (S.tab === 'set') render();
}

if (window.matchMedia) {
  matchMedia('(prefers-color-scheme:dark)').addEventListener('change', () => {
    if (getTheme() === 'auto') applyTheme();
  });
}

function modal(html) {
  $('#modal').innerHTML = `<div class="mask" data-mask="1"><div class="modal">${html}</div></div>`;
}

function confirmBox({ title, sub, ok = 'ตกลง', cancel = 'ยกเลิก', danger = false, fields = [] }) {
  return new Promise((res) => {
    const f = fields.map((x) => `
      <label class="f"><span>${esc(x.label)}${x.required ? ' <em>*</em>' : ''}</span>
      ${x.type === 'textarea'
        ? `<textarea class="inp" data-cf="${x.key}" placeholder="${esc(x.placeholder || '')}">${esc(x.value || '')}</textarea>`
        : `<input class="inp" data-cf="${x.key}" type="${x.type || 'text'}" value="${esc(x.value || '')}" placeholder="${esc(x.placeholder || '')}">`}
      </label>`).join('');
    modal(`
      <h3>${esc(title)}</h3>
      ${sub ? `<p class="sub">${sub}</p>` : ''}
      ${f}
      <div class="row end" style="margin-top:8px">
        <button class="btn" data-cf-no>${esc(cancel)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-cf-yes>${esc(ok)}</button>
      </div>`);
    const done = (v) => { closeModal(); res(v); };
    $('[data-cf-no]').onclick = () => done(null);
    $('[data-cf-yes]').onclick = () => {
      const out = {};
      let bad = false;
      $$('[data-cf]').forEach((i) => {
        out[i.dataset.cf] = i.value.trim();
        const spec = fields.find((x) => x.key === i.dataset.cf);
        if (spec && spec.required && !i.value.trim()) { i.classList.add('bad'); bad = true; }
      });
      if (bad) return toast('กรอกข้อมูลที่จำเป็นให้ครบ', 'err');
      done(out);
    };
    const first = $('[data-cf]');
    if (first) first.focus();
  });
}

document.addEventListener('click', (e) => {
  if (e.target.dataset && e.target.dataset.mask) closeModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/* ============================================================
   ส่วนที่ 5 — ตัวช่วยเกี่ยวกับข้อมูลสินค้า
   ============================================================ */
function byId(id) { return DB.products.find((p) => p.id === id); }

function addHistory(p, type, text) {
  p.history.unshift({ at: nowISO(), type, text, by: DB.settings.user || '' });
  if (p.history.length > 200) p.history.length = 200;
}

function dupCheck(p) {
  const errs = {};
  const code = (p.code || '').trim().toLowerCase();
  const bc = (p.barcode || '').trim();
  if (code && DB.products.some((x) => x.id !== p.id && (x.code || '').trim().toLowerCase() === code))
    errs.code = 'รหัสสินค้านี้มีอยู่แล้วในระบบ';
  if (bc && DB.products.some((x) => x.id !== p.id && (x.barcode || '').trim() === bc))
    errs.barcode = 'บาร์โค้ดนี้ถูกใช้กับสินค้าอื่นแล้ว';
  return errs;
}

function filtered() {
  const q = S.q.trim().toLowerCase();
  let list = DB.products.filter((p) => {
    if (S.fArchived === 'active' && p.archived) return false;
    if (S.fArchived === 'archived' && !p.archived) return false;
    if (S.fType !== 'all' && p.type !== S.fType) return false;
    if (S.fCategory !== 'all' && p.category !== S.fCategory) return false;
    if (S.fChannel !== 'all') {
      const st = p.channels?.[S.fChannel]?.status || 'off';
      if (st === 'off') return false;
    }
    if (S.fStatus !== 'all') {
      if (S.fChannel !== 'all') {
        if ((p.channels?.[S.fChannel]?.status || 'off') !== S.fStatus) return false;
      } else {
        const any = CHANNEL_KEYS.some((k) => (p.channels?.[k]?.status || 'off') === S.fStatus);
        if (!any) return false;
      }
    }
    if (q) {
      const hay = [p.code, p.barcode, p.name, p.supplier, p.note, p.replaceOfCode, p.replaceOfName]
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const s = S.sort;
  list.sort((a, b) => {
    if (s === 'new') return (b.createdAt || '').localeCompare(a.createdAt || '');
    if (s === 'old') return (a.createdAt || '').localeCompare(b.createdAt || '');
    if (s === 'code') return (a.code || '').localeCompare(b.code || '', 'th');
    if (s === 'name') return (a.name || '').localeCompare(b.name || '', 'th');
    return 0;
  });
  return list;
}

function pendingList() {
  const out = [];
  DB.products.forEach((p) => {
    if (p.archived) return;
    CHANNEL_KEYS.forEach((k) => {
      const c = p.channels[k];
      if (c && c.status === 'pending') out.push({ p, k, c });
    });
  });
  out.sort((a, b) => (a.c.requestedAt || '').localeCompare(b.c.requestedAt || ''));
  return out;
}

/* ============================================================
   ส่วนที่ 6 — เปลี่ยนสถานะช่องทาง (กติกาหลัก)
   ============================================================ */
async function moveChannel(pid, key, to) {
  const p = byId(pid);
  if (!p) return;
  const c = p.channels[key];
  const from = c.status || 'off';

  if (!canMove(from, to)) {
    toast(`เปลี่ยนจาก "${CH_STATUS[from].label}" ไป "${CH_STATUS[to].label}" ไม่ได้`, 'err');
    return;
  }
  /* กติกา: ลงขายได้ต่อเมื่อคอนเฟิร์มแล้วเท่านั้น */
  if (to === 'listed' && from !== 'confirmed') {
    toast('ต้องคอนเฟิร์มก่อนจึงจะลงขายได้', 'err');
    return;
  }

  let extra = {};
  if (to === 'confirmed') {
    const r = await confirmBox({
      title: `คอนเฟิร์ม ${CHANNELS[key].label}`,
      sub: `<b>${esc(p.name || p.code)}</b><br>คอนเฟิร์มแล้วจึงจะกด "ลงขายแล้ว" ได้`,
      ok: 'คอนเฟิร์ม',
      fields: [
        { key: 'by', label: 'ผู้คอนเฟิร์ม', required: !!DB.settings.requireConfirmBy, value: DB.settings.user, placeholder: 'ชื่อผู้อนุมัติ' },
        { key: 'note', label: 'หมายเหตุ', type: 'textarea', placeholder: 'ไม่บังคับ' },
      ],
    });
    if (!r) return;
    extra = { confirmedBy: r.by, confirmedAt: nowISO(), note: r.note || c.note };
  } else if (to === 'listed') {
    const r = await confirmBox({
      title: `บันทึกว่าลงขายแล้วบน ${CHANNELS[key].label}`,
      sub: `<b>${esc(p.name || p.code)}</b>`,
      ok: 'บันทึก',
      fields: [{ key: 'url', label: 'ลิงก์สินค้า', value: c.url, placeholder: 'https:// (ไม่บังคับ)' }],
    });
    if (!r) return;
    extra = { listedAt: nowISO(), url: r.url };
  } else if (to === 'rejected') {
    const r = await confirmBox({
      title: `ไม่อนุมัติ ${CHANNELS[key].label}`,
      sub: `<b>${esc(p.name || p.code)}</b>`,
      ok: 'ยืนยันไม่อนุมัติ', danger: true,
      fields: [{ key: 'note', label: 'เหตุผล', required: true, type: 'textarea', placeholder: 'เช่น รอรูปสินค้า / ราคายังไม่นิ่ง' }],
    });
    if (!r) return;
    extra = { note: r.note, confirmedBy: '', confirmedAt: '' };
  } else if (to === 'pending') {
    extra = { requestedAt: nowISO(), confirmedBy: '', confirmedAt: '', listedAt: '' };
  } else if (to === 'off') {
    extra = { requestedAt: '', confirmedBy: '', confirmedAt: '', listedAt: '' };
  }

  Object.assign(c, extra, { status: to });
  p.updatedAt = nowISO();
  addHistory(p, 'channel', `${CHANNELS[key].label}: ${CH_STATUS[from].label} → ${CH_STATUS[to].label}`);
  await save(true);
  toast(`${CHANNELS[key].label} · ${CH_STATUS[to].label}`, 'ok');
  render();
}

/* ---------- คอนเฟิร์มหลายรายการพร้อมกัน ---------- */
async function bulkConfirm() {
  const keys = [...S.sel];
  if (!keys.length) return;
  const r = await confirmBox({
    title: `คอนเฟิร์ม ${keys.length} รายการ`,
    sub: 'ทุกรายการที่เลือกจะเปลี่ยนเป็น <b>คอนเฟิร์มแล้ว</b> พร้อมกัน',
    ok: `คอนเฟิร์ม ${keys.length} รายการ`,
    fields: [
      { key: 'by', label: 'ผู้คอนเฟิร์ม', required: !!DB.settings.requireConfirmBy, value: DB.settings.user },
      { key: 'note', label: 'หมายเหตุ (ใส่ให้ทุกรายการ)', type: 'textarea', placeholder: 'ไม่บังคับ' },
    ],
  });
  if (!r) return;

  await backup();
  let n = 0;
  keys.forEach((key) => {
    const [pid, k] = key.split('|');
    const p = byId(pid);
    if (!p) return;
    const c = p.channels[k];
    if (!canMove(c.status || 'off', 'confirmed')) return;
    Object.assign(c, {
      status: 'confirmed', confirmedBy: r.by, confirmedAt: nowISO(), note: r.note || c.note,
    });
    p.updatedAt = nowISO();
    addHistory(p, 'channel', `${CHANNELS[k].label}: รอคอนเฟิร์ม → คอนเฟิร์มแล้ว (คอนเฟิร์มหลายรายการ)`);
    n++;
  });
  await save(true);
  S.sel.clear();
  S.bulk = false;
  toast(`คอนเฟิร์มแล้ว ${n} รายการ`, 'ok');
  render();
}

/* ============================================================
   ส่วนที่ 7 — บันทึกสินค้า
   ============================================================ */
function validateDraft(d) {
  const e = {};
  if (!(d.code || '').trim()) e.code = 'กรอกรหัสสินค้า';
  if (!(d.name || '').trim()) e.name = 'กรอกชื่อสินค้า';
  if (d.type === 'replace' && !(d.replaceOfCode || '').trim() && !d.replaceOfId)
    e.replaceOfCode = 'ระบุรหัสสินค้าเดิมที่ถูกแทนที่';
  const bc = barcodeCheck(d.barcode);
  if (bc.level === 'error') e.barcode = bc.note;
  Object.assign(e, dupCheck(d));
  return e;
}

async function saveDraft() {
  const d = S.draft;
  const errs = validateDraft(d);
  $$('[data-field]').forEach((i) => i.classList.remove('bad'));
  $$('[data-err]').forEach((i) => { i.textContent = ''; i.className = 'hint'; });
  if (Object.keys(errs).length) {
    Object.entries(errs).forEach(([k, msg]) => {
      const i = $(`[data-field="${k}"]`);
      if (i) i.classList.add('bad');
      const h = $(`[data-err="${k}"]`);
      if (h) { h.textContent = msg; h.className = 'hint err'; }
    });
    toast('ตรวจสอบข้อมูลที่ทำเครื่องหมายไว้', 'err');
    const firstBad = $('.inp.bad');
    if (firstBad) firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  await backup();
  d.code = d.code.trim();
  d.barcode = (d.barcode || '').trim();
  d.name = d.name.trim();
  d.updatedAt = nowISO();
  if (!d.createdBy) d.createdBy = DB.settings.user || '';

  /* ตั้งสถานะ "รอคอนเฟิร์ม" ให้ช่องทางที่เลือกไว้แต่ยังไม่มีวันที่ขอ */
  CHANNEL_KEYS.forEach((k) => {
    const c = d.channels[k];
    if (c.status === 'pending' && !c.requestedAt) c.requestedAt = nowISO();
  });

  if (S.draftIsNew) {
    addHistory(d, 'create', `สร้างรายการ · ${PRODUCT_TYPES[d.type].label}`);
    DB.products.unshift(d);
  } else {
    const i = DB.products.findIndex((x) => x.id === d.id);
    addHistory(d, 'edit', 'แก้ไขข้อมูลสินค้า');
    if (i >= 0) DB.products[i] = d; else DB.products.unshift(d);
  }

  /* ผูกกับสินค้าเดิม: เก็บตัวเก่าเข้าคลังอัตโนมัติ */
  if (d.type === 'replace' && d.replaceOfId) {
    const old = byId(d.replaceOfId);
    if (old && DB.settings.autoArchiveOld && !old.archived) {
      old.archived = true;
      old.replacedById = d.id;
      old.updatedAt = nowISO();
      addHistory(old, 'archive', `ถูกแทนที่ด้วย ${d.code} — ${d.name}`);
    }
  }

  /* ถ้ามาจากสมุดบาร์โค้ดค้าง ปิดรายการนั้นให้เลย */
  const ib = DB.inbox.find((x) => x.id === S.fromInbox) ||
             DB.inbox.find((x) => !x.done && x.barcode && x.barcode === d.barcode);
  if (ib) { ib.done = true; ib.productId = d.id; ib.updatedAt = nowISO(); }
  S.fromInbox = null;

  await save(true);
  toast(S.draftIsNew
    ? (ib ? 'บันทึกสินค้าใหม่ และปิดรายการในสมุดบาร์โค้ดแล้ว' : 'บันทึกสินค้าใหม่แล้ว')
    : 'อัปเดตข้อมูลแล้ว', 'ok');
  S.viewId = d.id;
  S.draft = null;
  S.tab = 'detail';
  render();
}

function newDraft() {
  S.draft = blankProduct();
  S.draft.createdBy = DB.settings.user || '';
  S.draftIsNew = true;
  S.tab = 'form';
  render();
}

function editDraft(id) {
  const p = byId(id);
  if (!p) return;
  S.draft = JSON.parse(JSON.stringify(p));
  S.draftIsNew = false;
  S.tab = 'form';
  render();
}

/* ============================================================
   ส่วนที่ 8 — ชิ้นส่วน HTML ที่ใช้ซ้ำ
   ============================================================ */
function hintCls(level) {
  return level === 'ok' ? 'ok' : (level === 'error' || level === 'warn') ? 'err' : '';
}

function statusPill(st) {
  const s = CH_STATUS[st] || CH_STATUS.off;
  return `<span class="pill t-${s.tone}"><i class="dot"></i>${s.label}</span>`;
}

function typePill(p) {
  const t = PRODUCT_TYPES[p.type] || PRODUCT_TYPES.new;
  return `<span class="pill ${p.type === 'new' ? 't-green' : 't-amber'}">${t.label}</span>`;
}

function chBadge(p, k) {
  const st = p.channels?.[k]?.status || 'off';
  if (st === 'off') return '';
  const s = CH_STATUS[st];
  return `<span class="pill t-${s.tone}" title="${CHANNELS[k].label} · ${s.label}">
    <b class="ch-${k}">${CHANNELS[k].label}</b> · ${s.label}</span>`;
}

function productRow(p) {
  const chs = CHANNEL_KEYS.map((k) => chBadge(p, k)).filter(Boolean).join('');
  return `<div class="item" data-open="${p.id}">
    <div class="item-main">
      <b>${esc(p.name || '(ไม่มีชื่อ)')} ${p.archived ? '<span class="pill t-gray">เก็บเข้าคลัง</span>' : ''}</b>
      <small class="mono">${esc(p.code)}${p.barcode ? ' · ' + esc(p.barcode) : ''}</small>
      <div class="chips" style="margin-top:6px">${typePill(p)}${chs || '<span class="pill t-gray">ไม่ลงขายออนไลน์</span>'}</div>
    </div>
    <div style="text-align:right;flex:none">
      <small style="color:var(--ink-4);font-size:11.5px">${fmtAgo(p.createdAt)}</small>
    </div>
  </div>`;
}

/* ============================================================
   ส่วนที่ 9 — หน้าจอ: รายการสินค้า
   ============================================================ */
function viewList() {
  const cats = ['all', ...DB.settings.categories];
  /* มือถือ: ซ่อนตัวกรองไว้หลังปุ่ม ให้เหลือช่องค้นหาอย่างเดียว จอจะไม่แน่น */
  const nF = [S.fType !== 'all', S.fStatus !== 'all', S.fChannel !== 'all',
    S.fCategory !== 'all', S.fArchived !== 'active', S.sort !== 'new'].filter(Boolean).length;
  const hideF = isMob() && !S.showFilters;

  return `
  <div class="sec-title">ค้นหาและกรอง</div>
  <div class="card pad">
    <div class="filters" style="margin-bottom:${hideF ? '0' : '10px'}">
      <div class="search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="q" placeholder="ค้นหา รหัส / บาร์โค้ด / ชื่อ" value="${esc(S.q)}">
      </div>
      ${isMob() ? `<button class="btn sm" id="btnFilters" style="flex:none">
        ตัวกรอง${nF ? ` <span class="pill t-amber">${nF}</span>` : ''}</button>` : ''}
    </div>
    <div class="filters"${hideF ? ' style="display:none"' : ''}>
      <select id="fType">
        <option value="all"${S.fType === 'all' ? ' selected' : ''}>ทุกประเภท</option>
        ${Object.entries(PRODUCT_TYPES).map(([k, v]) => `<option value="${k}"${S.fType === k ? ' selected' : ''}>${v.label}</option>`).join('')}
      </select>
      <select id="fChannel">
        <option value="all"${S.fChannel === 'all' ? ' selected' : ''}>ทุกช่องทาง</option>
        ${CHANNEL_KEYS.map((k) => `<option value="${k}"${S.fChannel === k ? ' selected' : ''}>${CHANNELS[k].label}</option>`).join('')}
      </select>
      <select id="fStatus">
        <option value="all"${S.fStatus === 'all' ? ' selected' : ''}>ทุกสถานะ</option>
        ${Object.entries(CH_STATUS).map(([k, v]) => `<option value="${k}"${S.fStatus === k ? ' selected' : ''}>${v.label}</option>`).join('')}
      </select>
      <select id="fCategory">
        ${cats.map((c) => `<option value="${esc(c)}"${S.fCategory === c ? ' selected' : ''}>${c === 'all' ? 'ทุกหมวด' : esc(c)}</option>`).join('')}
      </select>
      <select id="fArchived">
        <option value="active"${S.fArchived === 'active' ? ' selected' : ''}>ใช้งานอยู่</option>
        <option value="archived"${S.fArchived === 'archived' ? ' selected' : ''}>เก็บเข้าคลัง</option>
        <option value="all"${S.fArchived === 'all' ? ' selected' : ''}>ทั้งหมด</option>
      </select>
      <select id="sort">
        <option value="new"${S.sort === 'new' ? ' selected' : ''}>ใหม่สุดก่อน</option>
        <option value="old"${S.sort === 'old' ? ' selected' : ''}>เก่าสุดก่อน</option>
        <option value="code"${S.sort === 'code' ? ' selected' : ''}>เรียงตามรหัส</option>
        <option value="name"${S.sort === 'name' ? ' selected' : ''}>เรียงตามชื่อ</option>
      </select>
      <div class="sp"></div>
      <button class="btn sm" id="btnReset">ล้างตัวกรอง</button>
      <button class="btn sm" id="btnExport">ส่งออก Excel/CSV</button>
    </div>
  </div>
  <div id="listWrap">${listBody()}</div>`;
}

function listBody() {
  const list = filtered();
  if (!list.length) {
    return `<div class="sec-title">ผลลัพธ์</div><div class="card"><div class="empty">
      <b>ไม่พบสินค้าที่ตรงเงื่อนไข</b>ลองล้างตัวกรอง หรือกดปุ่ม “＋ เพิ่มสินค้า”</div></div>`;
  }
  const head = `<div class="sec-title">ผลลัพธ์ · ${list.length} รายการ</div>`;

  /* เดสก์ท็อป: ตารางคอลัมน์ อ่านทีละหลายรายการได้เร็วกว่า */
  if (isDesk()) {
    return head + `<div class="card" style="overflow:hidden"><table class="tbl">
      <thead><tr>
        <th style="width:130px">รหัสสินค้า</th><th>ชื่อสินค้า</th>
        <th style="width:120px">บาร์โค้ด</th><th style="width:120px">ประเภท</th>
        ${CHANNEL_KEYS.map((k) => `<th style="width:120px">${CHANNELS[k].label}</th>`).join('')}
        <th style="width:110px" class="num">บันทึกเมื่อ</th>
      </tr></thead><tbody>
      ${list.map((p) => `<tr data-open="${p.id}">
        <td class="mono">${esc(p.code)}</td>
        <td class="nm">${esc(p.name || '(ไม่มีชื่อ)')}
          ${p.archived ? ' <span class="pill t-gray">เก็บเข้าคลัง</span>' : ''}</td>
        <td class="mono" style="color:var(--ink-3)">${esc(p.barcode || '—')}</td>
        <td>${typePill(p)}</td>
        ${CHANNEL_KEYS.map((k) => {
          const st = p.channels?.[k]?.status || 'off';
          return `<td>${st === 'off' ? '<span style="color:var(--ink-4)">—</span>' : statusPill(st)}</td>`;
        }).join('')}
        <td class="num">${fmtAgo(p.createdAt)}</td>
      </tr>`).join('')}
      </tbody></table></div>`;
  }

  return head + `<div class="card">${list.map(productRow).join('')}</div>`;
}

/* ============================================================
   ส่วนที่ 10 — หน้าจอ: ฟอร์มเพิ่ม/แก้ไข
   ============================================================ */
function viewForm() {
  const d = S.draft || (S.draft = blankProduct());
  const bc = barcodeCheck(d.barcode);
  return `
  <div class="sec-title">${S.draftIsNew ? 'บันทึกสินค้าใหม่' : 'แก้ไขสินค้า'}</div>

  <div class="card pad">
    <div class="grid g2">
      <label class="f"><span>รหัสสินค้า <em>*</em></span>
        <input class="inp mono" data-field="code" value="${esc(d.code)}" placeholder="เช่น P-00123" autocomplete="off">
        <div class="hint" data-err="code"></div></label>
      <label class="f"><span>เลขบาร์โค้ด <i>(ถ้ามี · ไม่เกิน ${BARCODE_MAX} หลัก)</i></span>
        <input class="inp mono" data-field="barcode" inputmode="numeric" maxlength="${BARCODE_MAX}"
          value="${esc(d.barcode)}" placeholder="ไม่เกิน ${BARCODE_MAX} หลัก" autocomplete="off">
        <div class="hint ${hintCls(bc.level)}" data-err="barcode">${d.barcode ? esc(bc.note) : ''}</div></label>
    </div>
    <label class="f"><span>ชื่อสินค้า <em>*</em></span>
      <input class="inp" data-field="name" value="${esc(d.name)}" placeholder="ชื่อเต็มที่ใช้ในระบบ">
      <div class="hint" data-err="name"></div></label>
    <div class="grid g3">
      <label class="f"><span>หมวดสินค้า</span>
        <select class="inp" data-field="category">
          ${DB.settings.categories.map((c) => `<option${d.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
        </select></label>
      <label class="f"><span>หน่วยนับ</span>
        <select class="inp" data-field="unit">
          ${DB.settings.units.map((c) => `<option${d.unit === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
        </select></label>
      <label class="f"><span>วันที่บันทึก</span>
        <input class="inp" type="date" data-field="recordDate" value="${esc(d.recordDate)}"></label>
    </div>
  </div>

  <div class="sec-title">สถานะสินค้า</div>
  <div class="card pad">
    <div class="grid g2" style="gap:10px">
      ${Object.entries(PRODUCT_TYPES).map(([k, v]) => `
        <button class="btn" data-type="${k}" style="flex-direction:column;align-items:flex-start;padding:14px;
          ${d.type === k ? 'border-color:var(--ink);box-shadow:0 0 0 2px rgba(17,19,24,.09)' : ''}">
          <b style="font-size:14.5px">${v.label} <span style="color:var(--ink-4);font-weight:500">· ${v.short}</span></b>
          <small style="color:var(--ink-3);font-weight:400">${v.desc}</small>
        </button>`).join('')}
    </div>
    <div id="typeExtra">${typeExtra()}</div>
  </div>

  <div class="sec-title">ลงขายออนไลน์</div>
  <div class="card pad">
    <p style="margin:0 0 12px;font-size:13px;color:var(--ink-3)">
      เลือกช่องทางที่ต้องการลงขาย ระบบจะตั้งสถานะเป็น <b>รอคอนเฟิร์ม</b> ทันที
      และจะกด “ลงขายแล้ว” ได้ก็ต่อเมื่อคอนเฟิร์มเรียบร้อยแล้วเท่านั้น
    </p>
    <div id="chWrap" class="grid g2">${chForm()}</div>
  </div>

  <div class="sec-title">ข้อมูลเพิ่มเติม</div>
  <div class="card pad">
    <div class="grid g3">
      <label class="f"><span>ผู้ขาย / ซัพพลายเออร์</span>
        <input class="inp" data-field="supplier" value="${esc(d.supplier)}" placeholder="ไม่บังคับ"></label>
      <label class="f"><span>ราคาทุน</span>
        <input class="inp" type="number" step="0.01" data-field="cost" value="${esc(d.cost)}" placeholder="0.00"></label>
      <label class="f"><span>ราคาขาย</span>
        <input class="inp" type="number" step="0.01" data-field="price" value="${esc(d.price)}" placeholder="0.00"></label>
    </div>
    <label class="f" style="margin-bottom:0"><span>หมายเหตุ</span>
      <textarea class="inp" data-field="note" placeholder="รายละเอียดอื่น ๆ">${esc(d.note)}</textarea></label>
  </div>

  <div class="row end actions" style="margin-top:18px;gap:8px">
    ${!S.draftIsNew ? '<button class="btn danger" id="btnDel">ลบรายการนี้</button>' : ''}
    <div class="sp"></div>
    <button class="btn" id="btnCancel">ยกเลิก</button>
    <button class="btn primary" id="btnSave">${S.draftIsNew ? 'บันทึกสินค้า' : 'บันทึกการแก้ไข'}</button>
  </div>`;
}

function typeExtra() {
  const d = S.draft;
  if (d.type !== 'replace') {
    return `<div class="hint" style="margin-top:12px">สินค้าใหม่ที่ยังไม่เคยมีในระบบ</div>`;
  }
  const opts = DB.products.filter((p) => p.id !== d.id);
  return `
    <div class="hr"></div>
    <label class="f"><span>สินค้าเดิมที่ถูกแทนที่ <em>*</em></span>
      <input class="inp mono" list="oldList" data-field="replaceOfCode" value="${esc(d.replaceOfCode)}"
        placeholder="พิมพ์รหัสสินค้าเดิม หรือเลือกจากรายการ" autocomplete="off">
      <datalist id="oldList">
        ${opts.map((p) => `<option value="${esc(p.code)}">${esc(p.name)}</option>`).join('')}
      </datalist>
      <div class="hint" data-err="replaceOfCode">${d.replaceOfId
        ? `<span style="color:var(--green)">ผูกกับ: ${esc(d.replaceOfName)}</span>`
        : 'พิมพ์รหัสให้ตรงกับสินค้าในระบบเพื่อผูกอัตโนมัติ (ถ้าไม่มีในระบบก็พิมพ์เป็นข้อความได้)'}</div>
    </label>
    <label class="f" style="margin-bottom:0"><span>ชื่อสินค้าเดิม <i>(กรอกเองได้ถ้าไม่มีในระบบ)</i></span>
      <input class="inp" data-field="replaceOfName" value="${esc(d.replaceOfName)}" placeholder="ชื่อสินค้าตัวเก่า">
    </label>
    ${DB.settings.autoArchiveOld ? `<div class="lock"><b>ℹ</b><div>เมื่อบันทึก ระบบจะเก็บสินค้าเดิมเข้าคลังให้อัตโนมัติ (ปิดได้ในหน้าตั้งค่า)</div></div>` : ''}`;
}

function chForm() {
  const d = S.draft;
  return CHANNEL_KEYS.map((k) => {
    const c = d.channels[k];
    const on = c.status !== 'off';
    return `<div class="ch-box">
      <div class="ch-head">
        <div class="ch-logo" style="background:var(--${k})">${CHANNELS[k].icon}</div>
        <div class="ch-name">${CHANNELS[k].label}</div>
        <div class="sp"></div>
        <label class="sw"><input type="checkbox" data-ch="${k}"${on ? ' checked' : ''}><i></i></label>
      </div>
      <div>${statusPill(c.status)}</div>
      ${on ? `<div class="lock"><b>⏳</b><div>ต้องได้รับการคอนเฟิร์มก่อน จึงจะเปลี่ยนเป็น “ลงขายแล้ว” ได้
        ${S.draftIsNew ? '' : '<br>ไปคอนเฟิร์มได้ที่หน้ารายละเอียดสินค้า'}</div></div>` : ''}
    </div>`;
  }).join('');
}

/* ============================================================
   ส่วนที่ 11 — หน้าจอ: รายละเอียดสินค้า
   ============================================================ */
function viewDetail() {
  const p = byId(S.viewId);
  if (!p) return `<div class="card"><div class="empty"><b>ไม่พบสินค้า</b></div></div>`;
  const rep = p.replaceOfId ? byId(p.replaceOfId) : null;
  const by = p.replacedById ? byId(p.replacedById) : null;

  return `
  <div class="row" style="margin:20px 0 12px">
    <button class="btn sm ghost" id="btnBack">← กลับ</button>
    <div class="sp"></div>
    <button class="btn sm" id="btnEdit">แก้ไข</button>
    <button class="btn sm" id="btnArchive">${p.archived ? 'นำกลับมาใช้งาน' : 'เก็บเข้าคลัง'}</button>
  </div>

  <div class="card pad">
    <div class="chips" style="margin-bottom:8px">${typePill(p)}${p.archived ? '<span class="pill t-gray">เก็บเข้าคลัง</span>' : ''}</div>
    <h2 style="margin:0 0 4px;font-size:21px;letter-spacing:-.01em">${esc(p.name)}</h2>
    <div class="mono" style="color:var(--ink-3);font-size:13.5px">${esc(p.code)}${p.barcode ? ' · ' + esc(p.barcode) : ''}</div>
    <div class="hr"></div>
    <div class="kv"><span>หมวด</span><b>${esc(p.category || '—')}</b></div>
    <div class="kv"><span>หน่วยนับ</span><b>${esc(p.unit || '—')}</b></div>
    <div class="kv"><span>ผู้ขาย</span><b>${esc(p.supplier || '—')}</b></div>
    <div class="kv"><span>ราคาทุน / ขาย</span><b>${p.cost || '—'} / ${p.price || '—'}</b></div>
    <div class="kv"><span>วันที่บันทึก</span><b>${fmtDate(p.recordDate || p.createdAt)}</b></div>
    <div class="kv"><span>ผู้บันทึก</span><b>${esc(p.createdBy || '—')}</b></div>
    ${rep || p.replaceOfCode ? `<div class="kv"><span>แทนสินค้าเดิม</span><b>${esc((rep && rep.code) || p.replaceOfCode)} ${esc((rep && rep.name) || p.replaceOfName || '')}</b></div>` : ''}
    ${by ? `<div class="kv"><span>ถูกแทนที่ด้วย</span><b>${esc(by.code)} ${esc(by.name)}</b></div>` : ''}
    ${p.note ? `<div class="hr"></div><div style="font-size:13.5px;white-space:pre-wrap">${esc(p.note)}</div>` : ''}
  </div>

  <div class="sec-title">ช่องทางขายออนไลน์</div>
  <div class="grid g2">${CHANNEL_KEYS.map((k) => chDetail(p, k)).join('')}</div>

  <div class="sec-title">ประวัติการเปลี่ยนแปลง</div>
  <div class="card pad">
    ${p.history.length ? `<div class="tl">${p.history.map((h, i) => `
      <div class="tl-i${i === 0 ? ' hi' : ''}">
        <b>${esc(h.text)}</b>
        <small>${fmtDateTime(h.at)}${h.by ? ' · ' + esc(h.by) : ''}</small>
      </div>`).join('')}</div>` : '<div class="empty">ยังไม่มีประวัติ</div>'}
  </div>`;
}

function chDetail(p, k) {
  const c = p.channels[k];
  const acts = CH_ACTIONS[c.status] || [];
  return `<div class="ch-box">
    <div class="ch-head">
      <div class="ch-logo" style="background:var(--${k})">${CHANNELS[k].icon}</div>
      <div><div class="ch-name">${CHANNELS[k].label}</div>
        <div style="margin-top:2px">${statusPill(c.status)}</div></div>
    </div>
    ${c.requestedAt ? `<div class="kv"><span>ขอลงขายเมื่อ</span><b>${fmtDateTime(c.requestedAt)}</b></div>` : ''}
    ${c.confirmedAt ? `<div class="kv"><span>คอนเฟิร์มโดย</span><b>${esc(c.confirmedBy || '—')}</b></div>
      <div class="kv"><span>คอนเฟิร์มเมื่อ</span><b>${fmtDateTime(c.confirmedAt)}</b></div>` : ''}
    ${c.listedAt ? `<div class="kv"><span>ลงขายเมื่อ</span><b>${fmtDateTime(c.listedAt)}</b></div>` : ''}
    ${c.url ? `<div class="kv"><span>ลิงก์</span><b><a href="${esc(c.url)}" target="_blank" rel="noopener">เปิดดู</a></b></div>` : ''}
    ${c.note ? `<div class="hint" style="margin-top:8px">📝 ${esc(c.note)}</div>` : ''}
    ${c.status === 'pending' ? `<div class="lock"><b>⏳</b><div>ยังลงขายไม่ได้ — รอการคอนเฟิร์ม</div></div>` : ''}
    <div class="ch-acts">
      ${acts.map((a) => `<button class="btn sm ${a.kind}" data-move="${p.id}|${k}|${a.to}">${a.text}</button>`).join('')}
    </div>
  </div>`;
}

/* ============================================================
   ส่วนที่ 12 — หน้าจอ: รอคอนเฟิร์ม
   ============================================================ */
function viewPending() {
  const list = pendingList();
  if (!list.length) {
    return `<div class="sec-title">คิวรอคอนเฟิร์ม</div>
      <div class="card"><div class="empty"><b>ไม่มีรายการรอคอนเฟิร์ม</b>ทุกช่องทางได้รับการอนุมัติเรียบร้อย</div></div>`;
  }
  const ready = DB.products.filter((p) => !p.archived &&
    CHANNEL_KEYS.some((k) => p.channels[k].status === 'confirmed'));

  const sel = S.sel;
  const nSel = list.filter(({ p, k }) => sel.has(p.id + '|' + k)).length;

  return `
  <div class="row" style="margin:22px 0 10px">
    <div class="sec-title" style="margin:0">คิวรอคอนเฟิร์ม · ${list.length} รายการ</div>
    <div class="sp"></div>
    ${list.length > 1 ? `<button class="btn sm" id="btnBulk">${S.bulk ? 'ยกเลิกการเลือก' : 'เลือกหลายรายการ'}</button>` : ''}
  </div>

  ${S.bulk ? `<div class="card pad" style="margin-bottom:12px;position:sticky;top:64px;z-index:20">
    <div class="row">
      <button class="btn sm" id="btnSelAll">${nSel === list.length ? 'ไม่เลือกเลย' : 'เลือกทั้งหมด'}</button>
      <div class="sp"></div>
      <b style="font-size:13.5px">เลือกแล้ว ${nSel}</b>
      <button class="btn sm primary" id="btnBulkOk"${nSel ? '' : ' disabled'}>คอนเฟิร์มที่เลือก</button>
    </div>
  </div>` : ''}

  <div class="card">
    ${list.map(({ p, k, c }) => {
      const key = p.id + '|' + k;
      return `<div class="item">
      ${S.bulk ? `<label class="sw" style="width:22px;height:22px;flex:none">
        <input type="checkbox" data-sel="${key}"${sel.has(key) ? ' checked' : ''}
          style="opacity:1;width:20px;height:20px;accent-color:var(--ink)"></label>` : ''}
      <div class="ch-logo" style="background:var(--${k})">${CHANNELS[k].icon}</div>
      <div class="item-main" data-open="${p.id}">
        <b>${esc(p.name)}</b>
        <small class="mono">${esc(p.code)} · ${CHANNELS[k].label} · ขอเมื่อ ${fmtAgo(c.requestedAt)}</small>
      </div>
      ${S.bulk ? '' : `<div class="row" style="flex:none;gap:6px">
        <button class="btn sm primary" data-move="${p.id}|${k}|confirmed">คอนเฟิร์ม</button>
        <button class="btn sm danger" data-move="${p.id}|${k}|rejected">ไม่อนุมัติ</button>
      </div>`}
    </div>`; }).join('')}
  </div>

  ${ready.length ? `<div class="sec-title">คอนเฟิร์มแล้ว · พร้อมลงขาย</div>
  <div class="card">${ready.map((p) => `<div class="item">
    <div class="item-main" data-open="${p.id}">
      <b>${esc(p.name)}</b><small class="mono">${esc(p.code)}</small>
    </div>
    <div class="row" style="flex:none;gap:6px">
      ${CHANNEL_KEYS.filter((k) => p.channels[k].status === 'confirmed')
        .map((k) => `<button class="btn sm bd-${k}" data-move="${p.id}|${k}|listed"
          style="">ลง ${CHANNELS[k].label} แล้ว</button>`).join('')}
    </div>
  </div>`).join('')}</div>` : ''}`;
}

/* ============================================================
   ส่วนที่ 12.5 — หน้าจอ: สมุดบาร์โค้ดค้าง
   จดบาร์โค้ดที่เจอไว้ก่อน ยังไม่ต้องมีข้อมูลสินค้า
   แล้วค่อยกดแปลงเป็นสินค้าเต็มทีหลัง
   ============================================================ */
function inboxOpen() { return DB.inbox.filter((x) => !x.done); }

function findByBarcode(bc) {
  const b = String(bc || '').trim();
  if (!b) return null;
  return DB.products.find((p) => (p.barcode || '').trim() === b) || null;
}

function viewInbox() {
  const open = inboxOpen();
  const done = DB.inbox.filter((x) => x.done);

  return `
  <div class="sec-title">จดบาร์โค้ดไว้ก่อน</div>
  <div class="card pad">
    <p style="margin:0 0 12px;font-size:13px;color:var(--ink-3)">
      เจอบาร์โค้ดที่ยังไม่มีในระบบ — ยิงเครื่องสแกนหรือพิมพ์ลงช่องนี้ได้เลย
      ยังไม่ต้องรู้ชื่อหรือรหัสสินค้า ไว้ค่อยมากดแปลงเป็นสินค้าเต็มทีหลัง
    </p>
    <div class="grid g2" style="gap:10px">
      <label class="f" style="margin:0"><span>เลขบาร์โค้ด <em>*</em></span>
        <input class="inp mono" id="ibCode" inputmode="numeric" maxlength="${BARCODE_MAX}"
          placeholder="ยิงสแกนหรือพิมพ์ แล้วกด Enter" autocomplete="off">
        <div class="hint" id="ibHint"></div></label>
      <label class="f" style="margin:0"><span>โน้ตสั้น ๆ <i>(ไม่บังคับ)</i></span>
        <input class="inp" id="ibNote" placeholder="เช่น เจอที่ชั้น A3 / ของ supplier X"></label>
    </div>
    <div class="row" style="margin-top:12px">
      <button class="btn primary" id="ibAdd">เพิ่มเข้าสมุด</button>
      <div class="hint" style="margin:0">กด <b>Enter</b> ในช่องบาร์โค้ดก็ได้ — ยิงติดกันหลายตัวได้เลย</div>
    </div>
  </div>

  <div class="sec-title">ค้างอยู่ · ${open.length} รายการ</div>
  ${open.length ? `<div class="card">${open.map((x) => {
    const hit = findByBarcode(x.barcode);
    return `<div class="item" style="cursor:default">
      <div class="item-main">
        <b class="mono" style="font-size:16px">${esc(x.barcode)}</b>
        <small>${x.note ? esc(x.note) + ' · ' : ''}จดเมื่อ ${fmtAgo(x.createdAt)}${x.by ? ' · ' + esc(x.by) : ''}</small>
        ${hit ? `<div class="chips" style="margin-top:6px">
          <span class="pill t-green">มีในระบบแล้ว: ${esc(hit.code)}</span></div>` : ''}
      </div>
      <div class="row" style="flex:none;gap:6px">
        ${hit ? `<button class="btn sm" data-open="${hit.id}">ดูสินค้า</button>
                 <button class="btn sm" data-ibdone="${x.id}">ปิดรายการ</button>`
              : `<button class="btn sm primary" data-ibnew="${x.id}">สร้างสินค้า</button>`}
        <button class="btn sm ghost" data-ibdel="${x.id}">ลบ</button>
      </div>
    </div>`; }).join('')}</div>`
    : `<div class="card"><div class="empty"><b>ไม่มีบาร์โค้ดค้าง</b>
        ยิงบาร์โค้ดที่ยังไม่มีในระบบเก็บไว้ที่ช่องด้านบนได้เลย</div></div>`}

  ${done.length ? `<div class="sec-title">จัดการแล้ว · ${done.length} รายการ</div>
  <div class="card">${done.slice(0, 20).map((x) => {
    const p = x.productId ? byId(x.productId) : null;
    return `<div class="item"${p ? ` data-open="${p.id}"` : ' style="cursor:default"'}>
      <div class="item-main">
        <b class="mono" style="color:var(--ink-3)">${esc(x.barcode)}</b>
        <small>${p ? 'เพิ่มเป็น ' + esc(p.code) + ' — ' + esc(p.name) : 'ปิดรายการแล้ว'}
          · ${fmtAgo(x.updatedAt)}</small>
      </div>
      <button class="btn sm ghost" data-ibdel="${x.id}">ลบ</button>
    </div>`; }).join('')}</div>` : ''}`;
}

async function ibAdd() {
  const el = $('#ibCode');
  const bc = (el.value || '').trim();
  const hint = $('#ibHint');
  if (!bc) { el.classList.add('bad'); return; }

  const chk = barcodeCheck(bc);
  if (chk.level === 'error') {
    el.classList.add('bad');
    hint.textContent = chk.note;
    hint.className = 'hint err';
    return;
  }
  if (DB.inbox.some((x) => !x.done && x.barcode === bc)) {
    hint.textContent = 'บาร์โค้ดนี้จดไว้แล้ว';
    hint.className = 'hint err';
    return;
  }

  const item = blankInbox(bc, ($('#ibNote').value || '').trim());
  item.by = DB.settings.user || '';
  DB.inbox.unshift(item);
  await save(true);

  const hit = findByBarcode(bc);
  toast(hit ? `จดแล้ว — บาร์โค้ดนี้มีในระบบ (${hit.code})` : 'จดบาร์โค้ดแล้ว', 'ok');
  render();
  setTimeout(() => { const i = $('#ibCode'); if (i) i.focus(); }, 50);
}

/* ============================================================
   ส่วนที่ 13 — หน้าจอ: Dashboard
   ============================================================ */
function viewDash() {
  const act = DB.products.filter((p) => !p.archived);
  const total = act.length;
  const nNew = act.filter((p) => p.type === 'new').length;
  const nRep = act.filter((p) => p.type === 'replace').length;
  const nPend = pendingList().length;

  const chStats = {};
  CHANNEL_KEYS.forEach((k) => {
    chStats[k] = { off: 0, pending: 0, confirmed: 0, listed: 0, rejected: 0 };
    act.forEach((p) => { chStats[k][p.channels[k].status || 'off']++; });
  });

  /* จำนวนสินค้าใหม่ราย 6 เดือนล่าสุด */
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    months.push({ key, label: TH_MONTH[d.getMonth()], n: 0 });
  }
  act.forEach((p) => {
    const key = (p.recordDate || p.createdAt || '').slice(0, 7);
    const m = months.find((x) => x.key === key);
    if (m) m.n++;
  });
  const maxN = Math.max(1, ...months.map((m) => m.n));

  const toneColor = { off: '#c9ced6', pending: '#e0a63f', confirmed: '#4b7bea', listed: '#2ea86a', rejected: '#e0685c' };

  return `
  <div class="sec-title">ภาพรวม</div>
  <div class="grid g4" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
    <div class="stat"><div class="n">${total}</div><div class="l">สินค้าที่ใช้งานอยู่</div></div>
    <div class="stat"><div class="n" style="color:var(--green)">${nNew}</div><div class="l">สินค้าใหม่</div></div>
    <div class="stat"><div class="n" style="color:var(--amber)">${nRep}</div><div class="l">เปลี่ยนแทนตัวเก่า</div></div>
    <div class="stat"><div class="n" style="color:${nPend ? 'var(--amber)' : 'var(--ink)'}">${nPend}</div><div class="l">รอคอนเฟิร์ม</div></div>
    <div class="stat" data-tab="inbox" style="cursor:pointer"><div class="n" style="color:${
      inboxOpen().length ? 'var(--blue)' : 'var(--ink)'}">${inboxOpen().length}</div>
      <div class="l">บาร์โค้ดค้าง</div></div>
  </div>

  <div class="sec-title">สถานะรายช่องทาง</div>
  <div class="grid g2">
    ${CHANNEL_KEYS.map((k) => {
      const s = chStats[k];
      const sum = Math.max(1, s.pending + s.confirmed + s.listed + s.rejected);
      return `<div class="card pad">
        <div class="ch-head">
          <div class="ch-logo" style="background:var(--${k})">${CHANNELS[k].icon}</div>
          <div class="ch-name">${CHANNELS[k].label}</div>
          <div class="sp"></div>
          <b style="font-size:19px">${s.listed}</b>
          <small style="color:var(--ink-3)">ลงขายแล้ว</small>
        </div>
        <div class="bar">
          ${['pending', 'confirmed', 'listed', 'rejected'].map((st) =>
            s[st] ? `<i style="width:${(s[st] / sum * 100).toFixed(1)}%;background:${toneColor[st]}"></i>` : '').join('')}
        </div>
        <div class="chips" style="margin-top:10px">
          ${['pending', 'confirmed', 'listed', 'rejected'].map((st) =>
            `<span class="pill t-${CH_STATUS[st].tone}">${CH_STATUS[st].label} ${s[st]}</span>`).join('')}
        </div>
      </div>`;
    }).join('')}
  </div>

  <div class="sec-title">สินค้าที่บันทึกย้อนหลัง 6 เดือน</div>
  <div class="card pad">
    <div style="display:flex;align-items:flex-end;gap:10px;height:150px">
      ${months.map((m) => `<div style="flex:1;text-align:center;display:flex;flex-direction:column;justify-content:flex-end;height:100%">
        <div style="font-size:12px;font-weight:600;margin-bottom:5px;color:${m.n ? 'var(--ink)' : 'var(--ink-4)'}">${m.n}</div>
        <div style="background:${m.n ? 'var(--ink)' : 'var(--line)'};border-radius:6px 6px 0 0;
          height:${Math.max(4, m.n / maxN * 100)}%"></div>
        <div style="font-size:11px;color:var(--ink-3);margin-top:6px">${m.label}</div>
      </div>`).join('')}
    </div>
  </div>

  ${viewRecent()}

  <div class="sec-title">บันทึกล่าสุด</div>
  <div class="card">
    ${act.slice(0, 8).length ? act.slice()
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 8)
      .map(productRow).join('') : '<div class="empty">ยังไม่มีข้อมูล</div>'}
  </div>`;
}

/* ============================================================
   ส่วนที่ 13.5 — สินค้าที่เพิ่งลงขาย
   ดึงจากวันที่กด "ลงขายแล้ว" ของแต่ละช่องทาง
   ============================================================ */
const RECENT_RANGES = [[7, '7 วัน'], [30, '30 วัน'], [90, '90 วัน'], [0, 'ทั้งหมด']];

function recentListed(days) {
  const cut = days ? Date.now() - days * 86400000 : 0;
  const out = [];

  DB.products.forEach((p) => {
    const chans = CHANNEL_KEYS
      .filter((k) => (p.channels?.[k]?.status || '') === 'listed')
      .map((k) => ({ k, at: p.channels[k].listedAt || '', url: p.channels[k].url || '' }));
    if (!chans.length) return;

    /* ลงขายช่องทางล่าสุดเมื่อไหร่ */
    const last = chans.reduce((m, c) => (c.at > m ? c.at : m), '');
    if (cut && (!last || new Date(last).getTime() < cut)) return;
    out.push({ p, chans, last });
  });

  out.sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  return out;
}

function chanTag(c) {
  return `<span class="pill t-green" title="ลงขาย ${fmtDateTime(c.at)}">
    <b class="ch-${c.k}">${CHANNELS[c.k].label}</b> · ${fmtDate(c.at)}</span>`;
}

function viewRecent() {
  const days = S.recentDays;
  const rows = recentListed(days);
  const label = (RECENT_RANGES.find(([d]) => d === days) || [, ''])[1];

  return `
  <div class="row" style="margin:26px 0 10px;align-items:flex-end">
    <div class="sec-title" style="margin:0">เพิ่งลงขาย · ${rows.length} รายการ</div>
    <div class="sp"></div>
    <div class="seg">
      ${RECENT_RANGES.map(([d, t]) =>
        `<button data-recent="${d}" class="${days === d ? 'on' : ''}">${t}</button>`).join('')}
    </div>
    ${rows.length ? '<button class="btn sm" id="btnExpRecent">ส่งออก CSV</button>' : ''}
  </div>

  ${!rows.length ? `<div class="card"><div class="empty">
      <b>ยังไม่มีสินค้าที่ลงขายใน ${esc(label)}</b>
      รายการจะขึ้นที่นี่เมื่อกดปุ่ม “ลงขายแล้ว” ในหน้าสินค้า</div></div>`
  : isDesk() ? `<div class="card" style="overflow:hidden"><table class="tbl">
      <thead><tr>
        <th style="width:140px">รหัสสินค้า</th>
        <th style="width:140px">บาร์โค้ด</th>
        <th>ชื่อสินค้า</th>
        <th style="width:340px">ลงขายในแพลตฟอร์ม</th>
        <th style="width:110px" class="num">ล่าสุด</th>
      </tr></thead><tbody>
      ${rows.map(({ p, chans, last }) => `<tr data-open="${p.id}">
        <td class="mono">${esc(p.code)}</td>
        <td class="mono" style="color:var(--ink-3)">${esc(p.barcode || '—')}</td>
        <td class="nm">${esc(p.name)}</td>
        <td><div class="chips">${chans.map(chanTag).join('')}</div></td>
        <td class="num">${fmtAgo(last)}</td>
      </tr>`).join('')}
      </tbody></table></div>`
  : `<div class="card">${rows.map(({ p, chans, last }) => `<div class="item" data-open="${p.id}">
      <div class="item-main">
        <b>${esc(p.name)}</b>
        <small class="mono">${esc(p.code)}${p.barcode ? ' · ' + esc(p.barcode) : ' · ไม่มีบาร์โค้ด'}</small>
        <div class="chips" style="margin-top:6px">${chans.map(chanTag).join('')}</div>
      </div>
      <small style="color:var(--ink-4);font-size:11.5px;flex:none">${fmtAgo(last)}</small>
    </div>`).join('')}</div>`}`;
}

function exportRecent() {
  const rows = recentListed(S.recentDays);
  if (!rows.length) return toast('ไม่มีข้อมูลให้ส่งออก', 'err');
  const head = ['รหัสสินค้า', 'บาร์โค้ด', 'ชื่อสินค้า', 'ลงขายในแพลตฟอร์ม',
    ...CHANNEL_KEYS.map((k) => `วันที่ลง ${CHANNELS[k].label}`),
    ...CHANNEL_KEYS.map((k) => `ลิงก์ ${CHANNELS[k].label}`), 'ลงขายล่าสุด'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const body = rows.map(({ p, chans, last }) => [
    p.code, p.barcode, p.name,
    chans.map((c) => CHANNELS[c.k].label).join(' + '),
    ...CHANNEL_KEYS.map((k) => {
      const c = chans.find((x) => x.k === k);
      return c ? fmtDate(c.at) : '';
    }),
    ...CHANNEL_KEYS.map((k) => {
      const c = chans.find((x) => x.k === k);
      return c ? c.url : '';
    }),
    fmtDate(last),
  ].map(q).join(','));

  const tag = S.recentDays ? `${S.recentDays}d` : 'all';
  download(`listed-${tag}-${todayISO()}.csv`, [head.map(q).join(','), ...body].join('\r\n'),
    'text/csv;charset=utf-8');
  toast(`ส่งออก ${rows.length} รายการแล้ว`, 'ok');
}

/* ============================================================
   ส่วนที่ 14 — หน้าจอ: ตั้งค่า
   ============================================================ */
function viewSet() {
  return `
  <div class="sec-title">หน้าตา</div>
  <div class="card pad">
    <div class="row" style="justify-content:space-between">
      <div><b style="font-size:14px">ธีม</b>
        <div class="hint">ตั้งแยกแต่ละเครื่อง ไม่ซิงก์ข้ามเครื่อง</div></div>
      <div class="seg">
        ${[['auto', 'ตามเครื่อง'], ['light', 'สว่าง'], ['dark', 'มืด']].map(([v, t]) =>
          `<button data-theme-set="${v}" class="${getTheme() === v ? 'on' : ''}">${t}</button>`).join('')}
      </div>
    </div>
    <div class="hr"></div>
    <div class="row" style="justify-content:space-between">
      <div><b style="font-size:14px">ขนาดตัวอักษรและปุ่ม</b>
        <div class="hint">ขยายทั้งหน้าจอ เหมาะกับจอใหญ่หรือเวลามองไกล</div></div>
      <div class="seg">
        ${ZOOMS.map(([v, t]) =>
          `<button data-zoom-set="${v}" class="${getZoom() === v ? 'on' : ''}">${t}</button>`).join('')}
      </div>
    </div>
  </div>

  <div class="sec-title">ผู้ใช้งาน</div>
  <div class="card pad">
    <label class="f" style="margin-bottom:0"><span>ชื่อผู้บันทึก <i>(ใช้เป็นค่าเริ่มต้นเวลาคอนเฟิร์ม)</i></span>
      <input class="inp" id="setUser" value="${esc(DB.settings.user)}" placeholder="ชื่อของคุณ"></label>
  </div>

  <div class="sec-title">กติกาการทำงาน</div>
  <div class="card pad">
    <div class="row" style="justify-content:space-between;padding:6px 0">
      <div><b style="font-size:14px">ต้องระบุชื่อผู้คอนเฟิร์ม</b>
        <div class="hint">บังคับกรอกชื่อทุกครั้งที่กดคอนเฟิร์มช่องทางขาย</div></div>
      <label class="sw"><input type="checkbox" id="setReq"${DB.settings.requireConfirmBy ? ' checked' : ''}><i></i></label>
    </div>
    <div class="hr"></div>
    <div class="row" style="justify-content:space-between;padding:6px 0">
      <div><b style="font-size:14px">เก็บสินค้าเดิมเข้าคลังอัตโนมัติ</b>
        <div class="hint">เมื่อบันทึกสินค้าที่ “เปลี่ยนแทนตัวเก่า” และผูกรหัสเดิมไว้</div></div>
      <label class="sw"><input type="checkbox" id="setArc"${DB.settings.autoArchiveOld ? ' checked' : ''}><i></i></label>
    </div>
  </div>

  <div class="sec-title">หมวดสินค้า</div>
  <div class="card pad">
    <div class="chips" style="margin-bottom:12px">
      ${DB.settings.categories.map((c, i) => `<span class="pill t-gray">${esc(c)}
        <b data-delcat="${i}" style="cursor:pointer;margin-left:2px">✕</b></span>`).join('')}
    </div>
    <div class="row">
      <input class="inp" id="newCat" placeholder="เพิ่มหมวดใหม่" style="flex:1">
      <button class="btn" id="btnAddCat">เพิ่ม</button>
    </div>
  </div>

  <div class="sec-title">ฐานข้อมูลกลาง (ซิงก์ทุกเครื่อง)</div>
  <div class="card pad">
    <div class="row" style="justify-content:space-between;padding:6px 0">
      <div><b style="font-size:14px">เปิดการซิงก์</b>
        <div class="hint">ข้อมูลจะตรงกันทุกเครื่องที่เปิดลิงก์นี้ ปิดไว้ = เก็บเฉพาะในเครื่องนี้</div></div>
      <label class="sw"><input type="checkbox" id="setSync"${SYNC.on ? ' checked' : ''}><i></i></label>
    </div>
    <div class="hr"></div>
    <div class="kv"><span>สถานะ</span><b>${SYNC.state === 'ok' ? 'ซิงก์แล้ว ' + fmtAgo(SYNC.lastAt)
      : SYNC.state === 'syncing' ? 'กำลังซิงก์…'
      : SYNC.state === 'off' ? 'ปิดอยู่'
      : SYNC.state === 'error' ? '<span style="color:var(--red)">' + esc(SYNC.lastErr) + '</span>'
      : 'ยังไม่ได้ซิงก์'}</b></div>
    <div class="kv"><span>ซิงก์ล่าสุด</span><b>${fmtDateTime(SYNC.lastAt)}</b></div>
    <div class="row" style="margin-top:12px">
      <button class="btn primary" id="btnSyncNow">ซิงก์เดี๋ยวนี้</button>
    </div>
    <div class="hint" style="margin-top:12px">
      ซิงก์อัตโนมัติทุกครั้งที่บันทึก · ทุก 1 นาที · และตอนกลับมาเปิดหน้าเว็บ<br>
      ถ้าแก้รายการเดียวกันพร้อมกันจากสองเครื่อง ระบบจะยึด<b>ฉบับที่แก้ล่าสุด</b>
    </div>
  </div>

  <div class="sec-title">ข้อมูล</div>
  <div class="card pad">
    <div class="grid g2">
      <button class="btn" id="btnExport2">ส่งออก Excel / CSV</button>
      <button class="btn" id="btnJson">สำรองข้อมูล (.json)</button>
      <button class="btn" id="btnImport">นำเข้าไฟล์สำรอง</button>
      <button class="btn danger" id="btnWipe">ล้างข้อมูลทั้งหมด</button>
    </div>
    <div class="hint" style="margin-top:12px">
      ข้อมูลทั้งหมดเก็บอยู่ในเครื่องนี้ (IndexedDB · ฐาน ${APP.dbName}) ไม่ถูกส่งออกไปที่ใด
      · บันทึกล่าสุด ${fmtDateTime(DB.meta.savedAt)} · ทั้งหมด ${DB.products.length} รายการ
    </div>
  </div>

  <div class="sec-title">เกี่ยวกับ</div>
  <div class="card pad">
    <div class="kv"><span>เวอร์ชัน</span><b>${APP.version}</b></div>
    <div class="kv"><span>ช่องทางที่รองรับ</span><b>${CHANNEL_KEYS.map((k) => CHANNELS[k].label).join(' · ')}</b></div>
    <div class="kv"><span>ลำดับสถานะ</span><b>รอคอนเฟิร์ม → คอนเฟิร์มแล้ว → ลงขายแล้ว</b></div>
  </div>`;
}

/* ============================================================
   ส่วนที่ 15 — ส่งออกข้อมูล
   ============================================================ */
function download(name, text, mime) {
  const blob = new Blob(['﻿' + text], { type: mime || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function exportCSV() {
  const list = filtered();
  if (!list.length) return toast('ไม่มีข้อมูลให้ส่งออก', 'err');
  const head = ['รหัสสินค้า', 'บาร์โค้ด', 'ชื่อสินค้า', 'สถานะสินค้า', 'รหัสตัวเก่า', 'ชื่อตัวเก่า',
    'หมวด', 'หน่วย', 'ผู้ขาย', 'ราคาทุน', 'ราคาขาย',
    'Shopee', 'Shopee ผู้คอนเฟิร์ม', 'Shopee วันคอนเฟิร์ม', 'Shopee วันลงขาย',
    'Lazada', 'Lazada ผู้คอนเฟิร์ม', 'Lazada วันคอนเฟิร์ม', 'Lazada วันลงขาย',
    'วันที่บันทึก', 'ผู้บันทึก', 'เก็บเข้าคลัง', 'หมายเหตุ'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = list.map((p) => {
    const s = p.channels.shopee, l = p.channels.lazada;
    return [p.code, p.barcode, p.name, PRODUCT_TYPES[p.type].label, p.replaceOfCode, p.replaceOfName,
      p.category, p.unit, p.supplier, p.cost, p.price,
      CH_STATUS[s.status].label, s.confirmedBy, fmtDate(s.confirmedAt), fmtDate(s.listedAt),
      CH_STATUS[l.status].label, l.confirmedBy, fmtDate(l.confirmedAt), fmtDate(l.listedAt),
      fmtDate(p.recordDate || p.createdAt), p.createdBy, p.archived ? 'ใช่' : '', p.note].map(q).join(',');
  });
  download(`products-${todayISO()}.csv`, [head.map(q).join(','), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
  toast(`ส่งออก ${list.length} รายการแล้ว`, 'ok');
}

function exportJSON() {
  download(`backup-${todayISO()}.json`, JSON.stringify(DB, null, 2), 'application/json');
  toast('สำรองข้อมูลแล้ว', 'ok');
}

function importJSON() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = () => {
    const f = inp.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      try {
        const d = JSON.parse(r.result);
        if (!d || !Array.isArray(d.products)) throw new Error('รูปแบบไฟล์ไม่ถูกต้อง');
        const ok = await confirmBox({
          title: 'นำเข้าข้อมูล',
          sub: `พบ <b>${d.products.length}</b> รายการ<br>ข้อมูลเดิมทั้งหมดจะถูกแทนที่ (ระบบสำรองไว้ให้ก่อนแล้ว)`,
          ok: 'นำเข้า', danger: true,
        });
        if (!ok) return;
        await backup();
        DB = Object.assign(JSON.parse(JSON.stringify(DEFAULT_DB)), d);
        DB.settings = Object.assign({}, DEFAULT_DB.settings, d.settings || {});
        DB.products.forEach(migrate);
        await save(true);
        toast('นำเข้าสำเร็จ', 'ok');
        S.tab = 'list';
        render();
      } catch (e) { toast('นำเข้าไม่สำเร็จ: ' + e.message, 'err'); }
    };
    r.readAsText(f);
  };
  inp.click();
}

/* ============================================================
   ส่วนที่ 16 — วาดหน้าจอ + ผูกเหตุการณ์
   ============================================================ */
/* ---------- เมนู 3 รูปแบบ จากรายการเดียวกัน ---------- */
function navItem(t, kind) {
  const pend = t.id === 'pending' ? pendingList().length
    : t.id === 'inbox' ? DB.inbox.filter((x) => !x.done).length : 0;
  const on = S.tab === t.id || (S.tab === 'detail' && t.id === 'list');
  const mid = kind === 'bottom' && t.id === 'form';
  const label = kind === 'side' ? t.label : (t.short || t.label);
  return `<button class="nav-i${on && !mid ? ' on' : ''}${mid ? ' mid' : ''}" data-tab="${t.id}"
    title="${esc(t.label)}">${ICONS[t.id]}<span>${label}</span>${
    pend ? `<span class="bdg">${pend}</span>` : ''}</button>`;
}

function render() {
  /* แท็บบน — ใช้บนแท็บเล็ต */
  $('#tabs').innerHTML = TABS.map((t) => {
    const pend = t.id === 'pending' ? pendingList().length
    : t.id === 'inbox' ? DB.inbox.filter((x) => !x.done).length : 0;
    return `<button data-tab="${t.id}" class="${S.tab === t.id || (S.tab === 'detail' && t.id === 'list') ? 'on' : ''}">
      ${t.label}${pend ? ` <span class="pill t-amber" style="margin-left:2px">${pend}</span>` : ''}</button>`;
  }).join('');

  /* เมนูข้าง — เดสก์ท็อป */
  $('#sidebar').innerHTML = TABS.map((t) => navItem(t, 'side')).join('') + `
    <div class="side-t">คีย์ลัด</div>
    <div class="side-box">
      <div style="display:flex;justify-content:space-between;padding:3px 0">
        <span>เพิ่มสินค้า</span><span class="kbd">N</span></div>
      <div style="display:flex;justify-content:space-between;padding:3px 0">
        <span>ค้นหา</span><span class="kbd">/</span></div>
      <div style="display:flex;justify-content:space-between;padding:3px 0">
        <span>ย้อนกลับ</span><span class="kbd">Esc</span></div>
    </div>`;

  /* เมนูล่าง — มือถือ */
  $('#bottomNav').innerHTML = BOTTOM_ORDER
    .map((id) => navItem(TABS.find((t) => t.id === id), 'bottom')).join('');

  const nPend = pendingList().length;
  $('#subline').textContent = `${DB.products.filter((p) => !p.archived).length} รายการ` +
    (nPend ? ` · รอคอนเฟิร์ม ${nPend}` : '');

  const v = $('#view');
  if (S.tab === 'list') v.innerHTML = viewList();
  else if (S.tab === 'form') v.innerHTML = viewForm();
  else if (S.tab === 'detail') v.innerHTML = viewDetail();
  else if (S.tab === 'pending') v.innerHTML = viewPending();
  else if (S.tab === 'inbox') v.innerHTML = viewInbox();
  else if (S.tab === 'dash') v.innerHTML = viewDash();
  else if (S.tab === 'set') v.innerHTML = viewSet();

  $('#fab').style.display = (S.tab === 'form') ? 'none' : 'flex';
  bind();
  if (typeof paintSync === 'function') paintSync();
  window.scrollTo({ top: 0 });
}

function bind() {
  /* ---- รายการ ---- */
  const q = $('#q');
  if (q) {
    q.oninput = () => {
      S.q = q.value;
      $('#listWrap').innerHTML = listBody();
    };
  }
  [['fType', 'fType'], ['fStatus', 'fStatus'], ['fChannel', 'fChannel'],
   ['fCategory', 'fCategory'], ['fArchived', 'fArchived'], ['sort', 'sort']].forEach(([id, key]) => {
    const el = $('#' + id);
    if (el) el.onchange = () => { S[key] = el.value; $('#listWrap').innerHTML = listBody(); };
  });
  const bf = $('#btnFilters');
  if (bf) bf.onclick = () => { S.showFilters = !S.showFilters; render(); };
  const rst = $('#btnReset');
  if (rst) rst.onclick = () => {
    Object.assign(S, { q: '', fType: 'all', fStatus: 'all', fChannel: 'all', fCategory: 'all', fArchived: 'active', sort: 'new' });
    render();
  };
  const ex = $('#btnExport'); if (ex) ex.onclick = exportCSV;
  const ex2 = $('#btnExport2'); if (ex2) ex2.onclick = exportCSV;

  /* ---- ฟอร์ม ---- */
  $$('[data-field]').forEach((el) => {
    const f = el.dataset.field;
    const h = () => {
      S.draft[f] = el.value;
      if (f === 'barcode') {
        const r = barcodeCheck(el.value);
        const hint = $('[data-err="barcode"]');
        if (hint) { hint.textContent = el.value ? r.note : ''; hint.className = 'hint ' + hintCls(r.level); }
        el.classList.toggle('bad', r.level === 'error');
      }
      if (f === 'replaceOfCode') {
        const m = DB.products.find((p) => p.id !== S.draft.id &&
          (p.code || '').trim().toLowerCase() === el.value.trim().toLowerCase());
        S.draft.replaceOfId = m ? m.id : '';
        if (m) {
          S.draft.replaceOfName = m.name;
          const n = $('[data-field="replaceOfName"]');
          if (n) n.value = m.name;
        }
        const hint = $('[data-err="replaceOfCode"]');
        if (hint) {
          hint.innerHTML = m ? `<span style="color:var(--green)">ผูกกับ: ${esc(m.name)}</span>`
            : 'ไม่พบรหัสนี้ในระบบ — จะบันทึกเป็นข้อความ';
          hint.className = 'hint';
        }
      }
    };
    el.oninput = h;
    el.onchange = h;
  });
  $$('[data-type]').forEach((b) => {
    b.onclick = () => {
      S.draft.type = b.dataset.type;
      render();
    };
  });
  $$('[data-ch]').forEach((c) => {
    c.onchange = () => {
      const k = c.dataset.ch;
      const ch = S.draft.channels[k];
      if (c.checked) {
        if (ch.status === 'off') { ch.status = 'pending'; ch.requestedAt = nowISO(); }
      } else {
        ch.status = 'off'; ch.requestedAt = ''; ch.confirmedAt = ''; ch.confirmedBy = ''; ch.listedAt = '';
      }
      $('#chWrap').innerHTML = chForm();
      bind();
    };
  });
  const bs = $('#btnSave'); if (bs) bs.onclick = saveDraft;
  const bc = $('#btnCancel');
  if (bc) bc.onclick = () => { S.draft = null; S.tab = S.viewId ? 'detail' : 'list'; render(); };
  const bd = $('#btnDel');
  if (bd) bd.onclick = async () => {
    const ok = await confirmBox({ title: 'ลบรายการนี้?', sub: `<b>${esc(S.draft.name)}</b><br>ลบแล้วกู้คืนไม่ได้`, ok: 'ลบ', danger: true });
    if (!ok) return;
    await backup();
    DB.meta.tombstones.push({ id: S.draft.id, code: S.draft.code, name: S.draft.name, at: nowISO() });
    DB.products = DB.products.filter((p) => p.id !== S.draft.id);
    await save(true);
    S.draft = null; S.viewId = null; S.tab = 'list';
    toast('ลบแล้ว'); render();
  };

  /* ---- รายละเอียด ---- */
  const bb = $('#btnBack'); if (bb) bb.onclick = () => { S.tab = 'list'; render(); };
  const be = $('#btnEdit'); if (be) be.onclick = () => editDraft(S.viewId);
  const ba = $('#btnArchive');
  if (ba) ba.onclick = async () => {
    const p = byId(S.viewId);
    p.archived = !p.archived;
    p.updatedAt = nowISO();
    addHistory(p, p.archived ? 'archive' : 'restore', p.archived ? 'เก็บเข้าคลัง' : 'นำกลับมาใช้งาน');
    await save(true);
    toast(p.archived ? 'เก็บเข้าคลังแล้ว' : 'นำกลับมาใช้งานแล้ว', 'ok');
    render();
  };

  /* ---- เปิดรายละเอียด / เปลี่ยนสถานะ ---- */
  $$('[data-open]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('[data-move]')) return;
      S.viewId = el.dataset.open; S.tab = 'detail'; render();
    };
  });
  $$('[data-move]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const [pid, k, to] = b.dataset.move.split('|');
      moveChannel(pid, k, to);
    };
  });

  /* ---- ตั้งค่า ---- */
  const saveSet = () => { DB.meta.settingsAt = nowISO(); save(); };
  const su = $('#setUser');
  if (su) su.oninput = () => { DB.settings.user = su.value; saveSet(); };
  const sr = $('#setReq');
  if (sr) sr.onchange = () => { DB.settings.requireConfirmBy = sr.checked; saveSet(); };
  const sa = $('#setArc');
  if (sa) sa.onchange = () => { DB.settings.autoArchiveOld = sa.checked; saveSet(); };
  const ac = $('#btnAddCat');
  if (ac) ac.onclick = () => {
    const v = $('#newCat').value.trim();
    if (!v) return;
    if (DB.settings.categories.includes(v)) return toast('มีหมวดนี้แล้ว', 'err');
    DB.settings.categories.push(v); saveSet(); render();
  };
  $$('[data-delcat]').forEach((b) => {
    b.onclick = () => {
      DB.settings.categories.splice(+b.dataset.delcat, 1);
      if (!DB.settings.categories.length) DB.settings.categories.push('ทั่วไป');
      saveSet(); render();
    };
  });

  /* ---- เพิ่งลงขาย ---- */
  $$('[data-recent]').forEach((b) => {
    b.onclick = () => { S.recentDays = +b.dataset.recent; render(); };
  });
  const ber = $('#btnExpRecent'); if (ber) ber.onclick = exportRecent;

  /* ---- สมุดบาร์โค้ดค้าง ---- */
  const ibc = $('#ibCode');
  if (ibc) {
    ibc.focus();
    ibc.oninput = () => {
      ibc.classList.remove('bad');
      const r = barcodeCheck(ibc.value);
      const h = $('#ibHint');
      h.textContent = r.note;
      h.className = 'hint ' + (r.level === 'error' || r.level === 'warn' ? 'err' : r.level === 'ok' ? 'ok' : '');
    };
    ibc.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ibAdd(); } };
    const nt = $('#ibNote');
    if (nt) nt.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ibAdd(); } };
  }
  const iba = $('#ibAdd'); if (iba) iba.onclick = ibAdd;

  $$('[data-ibnew]').forEach((b) => {
    b.onclick = () => {
      const x = DB.inbox.find((i) => i.id === b.dataset.ibnew);
      if (!x) return;
      newDraft();
      S.draft.barcode = x.barcode;
      S.draft.note = x.note ? `จากสมุดบาร์โค้ด: ${x.note}` : '';
      S.fromInbox = x.id;
      render();
      toast('เติมบาร์โค้ดให้แล้ว — กรอกรหัสกับชื่อสินค้าต่อได้เลย');
    };
  });
  $$('[data-ibdone]').forEach((b) => {
    b.onclick = async () => {
      const x = DB.inbox.find((i) => i.id === b.dataset.ibdone);
      if (!x) return;
      const hit = findByBarcode(x.barcode);
      x.done = true;
      x.productId = hit ? hit.id : '';
      x.updatedAt = nowISO();
      await save(true);
      toast('ปิดรายการแล้ว', 'ok');
      render();
    };
  });
  $$('[data-ibdel]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.ibdel;
      const x = DB.inbox.find((i) => i.id === id);
      DB.meta.tombstones.push({ id, code: x ? x.barcode : '', name: 'inbox', at: nowISO() });
      DB.inbox = DB.inbox.filter((i) => i.id !== id);
      await save(true);
      toast('ลบแล้ว');
      render();
    };
  });

  /* ---- เลือกหลายรายการ ---- */
  const bb2 = $('#btnBulk');
  if (bb2) bb2.onclick = () => { S.bulk = !S.bulk; S.sel.clear(); render(); };
  const bsa = $('#btnSelAll');
  if (bsa) bsa.onclick = () => {
    const all = pendingList();
    if (S.sel.size === all.length) S.sel.clear();
    else all.forEach(({ p, k }) => S.sel.add(p.id + '|' + k));
    render();
  };
  const bok = $('#btnBulkOk'); if (bok) bok.onclick = bulkConfirm;
  $$('[data-sel]').forEach((c) => {
    c.onchange = () => {
      if (c.checked) S.sel.add(c.dataset.sel); else S.sel.delete(c.dataset.sel);
      render();
    };
  });

  /* ---- ธีม ---- */
  $$('[data-theme-set]').forEach((b) => {
    b.onclick = () => { setTheme(b.dataset.themeSet); render(); };
  });
  $$('[data-zoom-set]').forEach((b) => {
    b.onclick = () => {
      setZoom(b.dataset.zoomSet);
      toast('ขนาด: ' + (ZOOMS.find((z) => z[0] === b.dataset.zoomSet) || [, ''])[1]);
      render();
    };
  });

  /* ---- ซิงก์ ---- */
  const sy = $('#btnSyncNow'); if (sy) sy.onclick = () => syncNow(false);
  const so = $('#setSync');
  if (so) so.onchange = () => {
    SYNC.on = so.checked;
    DB.settings.syncOn = so.checked;
    SYNC.state = so.checked ? 'idle' : 'off';
    save(true, true);
    if (so.checked) syncNow(false); else { paintSync(); render(); }
  };
  const bj = $('#btnJson'); if (bj) bj.onclick = exportJSON;
  const bi = $('#btnImport'); if (bi) bi.onclick = importJSON;
  const bw = $('#btnWipe');
  if (bw) bw.onclick = async () => {
    const r = await confirmBox({
      title: 'ล้างข้อมูลทั้งหมด?', danger: true, ok: 'ล้างข้อมูล',
      sub: `จะลบสินค้าทั้ง <b>${DB.products.length}</b> รายการ<br>พิมพ์คำว่า <b>ลบ</b> เพื่อยืนยัน`,
      fields: [{ key: 'c', label: 'พิมพ์ “ลบ”', required: true }],
    });
    if (!r) return;
    if (r.c !== 'ลบ') return toast('ข้อความยืนยันไม่ถูกต้อง', 'err');
    await backup();
    DB = JSON.parse(JSON.stringify(DEFAULT_DB));
    await save(true);
    toast('ล้างข้อมูลแล้ว'); S.tab = 'list'; render();
  };
}

/* ---- ปุ่มระดับหน้า ---- */
document.addEventListener('DOMContentLoaded', () => {
  $('#fab').onclick = newDraft;
  $('#btnTheme').onclick = toggleTheme;
  applyZoom();
  $('#syncChip').onclick = () => syncNow(false);
  applyTheme();
  $('#btnQuickSearch').onclick = () => {
    S.tab = 'list'; render();
    setTimeout(() => { const q = $('#q'); if (q) q.focus(); }, 60);
  };
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { S.tab = t.dataset.tab; if (t.dataset.tab === 'form') newDraft(); else render(); }
  });

  /* ---- คีย์ลัด (เดสก์ท็อป) ---- */
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') {
      if ($('#modal').innerHTML) return;          /* ให้ตัวปิด modal จัดการก่อน */
      if (S.tab === 'detail' || S.tab === 'form') { S.draft = null; S.tab = 'list'; render(); }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); S.tab = 'list'; render(); setTimeout(() => $('#q')?.focus(), 60); }
    if (e.key === 'n' || e.key === 'N' || e.key === 'ๆ') { e.preventDefault(); newDraft(); }
  });
});

/* ============================================================
   ส่วนที่ 17 — เริ่มทำงาน
   ============================================================ */
(async function boot() {
  applyTheme();
  applyZoom();
  await loadDB();
  if (typeof DB.settings.syncOn === 'boolean') SYNC.on = DB.settings.syncOn;
  SYNC.state = SYNC.on ? 'idle' : 'off';
  render();
  if (SYNC.on) syncNow(true);
})();
