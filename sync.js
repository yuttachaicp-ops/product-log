/* ============================================================
   sync.js — ซิงก์ข้อมูลกับ Supabase (ตาราง pl_items)
   ทำงานแบบ offline-first: ใช้งานได้ปกติแม้เน็ตหลุด
   แล้วค่อยส่งขึ้นเมื่อกลับมาออนไลน์
   ============================================================ */

const SYNC = {
  on: true,
  state: 'idle',      // idle | syncing | ok | error | off
  lastAt: '',
  lastErr: '',
  pending: 0,
  timer: null,
};

const SB_H = () => ({
  apikey: SB.key,
  Authorization: 'Bearer ' + SB.key,
  'Content-Type': 'application/json',
});

const SB_URL = (path) => `${SB.url}/rest/v1/${path}`;

/* ---------- แปลงสินค้า → แถวในตาราง ---------- */
function toRow(p) {
  return {
    id: p.id,
    code: p.code || '',
    name: p.name || '',
    barcode: p.barcode || '',
    data: p,
    deleted: false,
    updated_at: p.updatedAt || nowISO(),
  };
}

function inboxRow(x) {
  return {
    id: x.id, code: x.barcode || '', name: 'inbox', barcode: x.barcode || '',
    data: x, deleted: false, updated_at: x.updatedAt || nowISO(),
  };
}

function settingsRow() {
  return {
    id: '__settings',
    code: '',
    name: 'settings',
    barcode: '',
    data: { settings: DB.settings, updatedAt: DB.meta.settingsAt || nowISO() },
    deleted: false,
    updated_at: DB.meta.settingsAt || nowISO(),
  };
}

/* ---------- ดึงข้อมูลลง ---------- */
async function sbPull() {
  const since = DB.meta.lastPull || '1970-01-01T00:00:00Z';
  const url = SB_URL(`${SB.table}?select=*&updated_at=gt.${encodeURIComponent(since)}&order=updated_at.asc&limit=1000`);
  const res = await fetch(url, { headers: SB_H() });
  if (!res.ok) throw new Error(`ดึงข้อมูลไม่สำเร็จ (${res.status})`);
  const rows = await res.json();
  if (!rows.length) return 0;

  let changed = 0;
  rows.forEach((r) => {
    if (r.id === '__settings') {
      const inAt = r.data?.updatedAt || r.updated_at;
      if (!DB.meta.settingsAt || inAt > DB.meta.settingsAt) {
        DB.settings = Object.assign({}, DB.settings, r.data?.settings || {});
        DB.meta.settingsAt = inAt;
        changed++;
      }
      return;
    }
    if (r.deleted) {
      const pi = DB.products.findIndex((p) => p.id === r.id);
      if (pi >= 0) { DB.products.splice(pi, 1); changed++; }
      const bi = DB.inbox.findIndex((x) => x.id === r.id);
      if (bi >= 0) { DB.inbox.splice(bi, 1); changed++; }
      return;
    }

    const incoming = r.data;
    if (!incoming || typeof incoming !== 'object') return;

    /* บาร์โค้ดค้าง */
    if (incoming.kind === 'inbox') {
      const bi = DB.inbox.findIndex((x) => x.id === r.id);
      if (bi < 0) { DB.inbox.unshift(incoming); changed++; }
      else if ((incoming.updatedAt || '') > (DB.inbox[bi].updatedAt || '')) {
        DB.inbox[bi] = incoming; changed++;
      }
      return;
    }

    const idx = DB.products.findIndex((p) => p.id === r.id);
    migrate(incoming);
    if (idx < 0) {
      DB.products.unshift(incoming);
      changed++;
    } else if ((incoming.updatedAt || '') > (DB.products[idx].updatedAt || '')) {
      DB.products[idx] = incoming;
      changed++;
    }
  });

  DB.meta.lastPull = rows[rows.length - 1].updated_at;
  return changed;
}

/* ---------- ส่งข้อมูลขึ้น ---------- */
async function sbPush() {
  const since = DB.meta.pushedAt || '';
  const dirty = DB.products.filter((p) => (p.updatedAt || '') > since);
  const rows = dirty.map(toRow);

  /* บาร์โค้ดค้างที่เพิ่ง เพิ่ม/แก้ */
  (DB.inbox || []).filter((x) => (x.updatedAt || '') > since).forEach((x) => rows.push(inboxRow(x)));

  /* ตั้งค่า (หมวดสินค้า ฯลฯ) */
  if ((DB.meta.settingsAt || '') > since) rows.push(settingsRow());

  /* รายการที่ถูกลบ — ส่งเป็น tombstone (ลบจริงบนเซิร์ฟเวอร์ทำไม่ได้ตามกติกา RLS) */
  const tombs = (DB.meta.tombstones || []).filter((t) => t.at > since);
  tombs.forEach((t) => rows.push({
    id: t.id, code: t.code || '', name: t.name || '', barcode: '',
    data: {}, deleted: true, updated_at: t.at,
  }));

  if (!rows.length) return 0;

  const res = await fetch(SB_URL(SB.table), {
    method: 'POST',
    headers: Object.assign(SB_H(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`ส่งข้อมูลไม่สำเร็จ (${res.status}) ${t.slice(0, 120)}`);
  }
  DB.meta.pushedAt = nowISO();
  return rows.length;
}

/* ---------- ซิงก์รอบเดียว ---------- */
let _syncing = false;
async function syncNow(silent) {
  if (!SYNC.on) { SYNC.state = 'off'; paintSync(); return; }
  if (_syncing) return;
  if (!navigator.onLine) {
    SYNC.state = 'error';
    SYNC.lastErr = 'ออฟไลน์ — จะซิงก์ให้อัตโนมัติเมื่อกลับมาออนไลน์';
    paintSync();
    return;
  }
  _syncing = true;
  SYNC.state = 'syncing';
  paintSync();
  try {
    const up = await sbPush();
    const down = await sbPull();
    SYNC.state = 'ok';
    SYNC.lastAt = nowISO();
    SYNC.lastErr = '';
    await save(true, true);   /* true ตัวที่สอง = อย่าเรียกซิงก์ซ้ำ */
    if (down) render();
    if (!silent && (up || down)) toast(`ซิงก์แล้ว · ส่งขึ้น ${up} · ดึงลง ${down}`, 'ok');
    else if (!silent) toast('ข้อมูลตรงกันแล้ว', 'ok');
  } catch (e) {
    SYNC.state = 'error';
    SYNC.lastErr = e.message;
    if (!silent) toast(e.message, 'err');
  } finally {
    _syncing = false;
    paintSync();
  }
}

function scheduleSync() {
  if (!SYNC.on) return;
  clearTimeout(SYNC.timer);
  SYNC.timer = setTimeout(() => syncNow(true), 1500);
}

/* ---------- ตัวแสดงสถานะบนหัวเว็บ ---------- */
function paintSync() {
  const el = document.getElementById('syncChip');
  if (!el) return;
  const map = {
    idle:    { t: 'gray',  s: '···',  x: 'ยังไม่ได้ซิงก์' },
    syncing: { t: 'blue',  s: '⟳',    x: 'กำลังซิงก์…' },
    ok:      { t: 'green', s: '✓',    x: 'ซิงก์แล้ว ' + fmtAgo(SYNC.lastAt) },
    error:   { t: 'red',   s: '!',    x: SYNC.lastErr || 'ซิงก์ไม่สำเร็จ' },
    off:     { t: 'gray',  s: '⊘',    x: 'ปิดการซิงก์' },
  };
  const m = map[SYNC.state] || map.idle;
  el.className = 'pill t-' + m.t;
  el.style.cursor = 'pointer';
  el.title = m.x;
  el.innerHTML = `${m.s} <span class="sync-txt">${SYNC.state === 'ok' ? 'ซิงก์แล้ว' : m.x}</span>`;
}

/* ---------- ตัวกระตุ้นการซิงก์ ---------- */
window.addEventListener('online', () => syncNow(true));
window.addEventListener('focus', () => { if (SYNC.on) syncNow(true); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && SYNC.on) syncNow(true);
});
setInterval(() => { if (SYNC.on && navigator.onLine) syncNow(true); }, 60000);
