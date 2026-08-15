/* ============================================================
   config.js — ค่าคงที่ / กติกาสถานะ / ตัวช่วยรูปแบบข้อมูล
   แยกออกจากตรรกะโปรแกรม (app.js) เพื่อให้แก้ไขง่าย
   ============================================================ */

const APP = {
  name: 'ระบบบันทึกสินค้าใหม่',
  short: 'บันทึกสินค้า',
  version: '1.0.0',
  dbName: 'product_log_db',
  storeName: 'kv',
  key: 'db',
  backupKey: 'backup',
};

/* ---------- ประเภทการบันทึกสินค้า ---------- */
const PRODUCT_TYPES = {
  new: { label: 'สินค้าใหม่', short: 'New', color: 'green', desc: 'สินค้าที่ไม่เคยมีในระบบมาก่อน' },
  replace: { label: 'เปลี่ยนแทนตัวเก่า', short: 'Replace', color: 'amber', desc: 'มาแทนสินค้าเดิมที่ยกเลิก' },
};

/* ---------- ช่องทางขายออนไลน์ ---------- */
const CHANNELS = {
  shopee: { label: 'Shopee', color: '#ee4d2d', icon: 'S' },
  lazada: { label: 'Lazada', color: '#0f156d', icon: 'L' },
};
const CHANNEL_KEYS = Object.keys(CHANNELS);

/* ---------- สถานะของแต่ละช่องทาง ----------
   off       = ไม่ลงขายช่องทางนี้
   pending   = รอคอนเฟิร์ม  (ค่าเริ่มต้นเมื่อเลือกว่าจะลงขาย)
   confirmed = คอนเฟิร์มแล้ว (พร้อมลงขาย)
   listed    = ลงขายแล้ว
   rejected  = ไม่อนุมัติ
   กติกา: จะไปสถานะ listed ได้ ต้องผ่าน confirmed เท่านั้น
------------------------------------------- */
const CH_STATUS = {
  off:       { label: 'ไม่ลงขาย',      tone: 'gray',  order: 0 },
  pending:   { label: 'รอคอนเฟิร์ม',   tone: 'amber', order: 1 },
  confirmed: { label: 'คอนเฟิร์มแล้ว', tone: 'blue',  order: 2 },
  listed:    { label: 'ลงขายแล้ว',     tone: 'green', order: 3 },
  rejected:  { label: 'ไม่อนุมัติ',     tone: 'red',   order: 4 },
};

/* การเปลี่ยนสถานะที่อนุญาต (กติกาหลักของระบบ) */
const CH_FLOW = {
  off:       ['pending'],
  pending:   ['confirmed', 'rejected', 'off'],
  confirmed: ['listed', 'pending', 'rejected'],
  listed:    ['confirmed'],
  rejected:  ['pending', 'off'],
};

function canMove(from, to) {
  return (CH_FLOW[from] || []).includes(to);
}

/* ปุ่มที่จะแสดงในแต่ละสถานะ */
const CH_ACTIONS = {
  off:       [{ to: 'pending',   text: 'ขอลงขาย',        kind: 'primary' }],
  pending:   [{ to: 'confirmed', text: 'คอนเฟิร์ม',       kind: 'primary' },
              { to: 'rejected',  text: 'ไม่อนุมัติ',       kind: 'danger'  },
              { to: 'off',       text: 'ยกเลิกคำขอ',      kind: 'ghost'   }],
  confirmed: [{ to: 'listed',    text: 'ลงขายแล้ว',       kind: 'primary' },
              { to: 'pending',   text: 'ถอนคอนเฟิร์ม',    kind: 'ghost'   }],
  listed:    [{ to: 'confirmed', text: 'ถอนออกจากการขาย', kind: 'ghost'   }],
  rejected:  [{ to: 'pending',   text: 'ขอใหม่อีกครั้ง',   kind: 'primary' },
              { to: 'off',       text: 'ปิดช่องทางนี้',    kind: 'ghost'   }],
};

/* ---------- หมวดสินค้า (แก้ไขได้ในหน้าตั้งค่า) ---------- */
const DEFAULT_CATEGORIES = [
  'ทั่วไป', 'อาหาร/เครื่องดื่ม', 'ของใช้ในบ้าน', 'เครื่องเขียน',
  'อุปกรณ์ไฟฟ้า', 'เครื่องมือช่าง', 'ความงาม/สุขภาพ', 'อื่น ๆ',
];

/* ---------- หน่วยนับ ---------- */
const DEFAULT_UNITS = ['ชิ้น', 'กล่อง', 'แพ็ค', 'โหล', 'ลัง', 'ชุด', 'เส้น', 'ม้วน'];

/* ---------- ประเภทเหตุการณ์ในประวัติ ---------- */
const EVENTS = {
  create:   'สร้างรายการ',
  edit:     'แก้ไขข้อมูล',
  channel:  'เปลี่ยนสถานะช่องทาง',
  note:     'บันทึกโน้ต',
  archive:  'เก็บเข้าคลัง',
  restore:  'นำกลับมาใช้งาน',
};

/* ============================================================
   ตัวช่วยทั่วไป
   ============================================================ */

const pad = (n) => String(n).padStart(2, '0');

function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowISO() {
  return new Date().toISOString();
}

const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return `${d.getDate()} ${TH_MONTH[d.getMonth()]} ${d.getFullYear() + 543}`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return `${fmtDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const day = Math.floor(diff / 86400000);
  if (day === 0) return 'วันนี้';
  if (day === 1) return 'เมื่อวาน';
  if (day < 30) return `${day} วันก่อน`;
  if (day < 365) return `${Math.floor(day / 30)} เดือนก่อน`;
  return `${Math.floor(day / 365)} ปีก่อน`;
}

function uid(prefix = 'p') {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/* หนีอักขระพิเศษก่อนใส่ลง innerHTML */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ตรวจความถูกต้องของบาร์โค้ด EAN-13 / EAN-8 / UPC-A (ถ้าความยาวตรงรูปแบบ) */
function barcodeCheck(code) {
  const c = String(code || '').trim();
  if (!c) return { ok: true, note: '' };
  if (!/^\d+$/.test(c)) return { ok: true, note: 'ไม่ใช่ตัวเลขล้วน — ข้ามการตรวจ check digit' };
  if (![8, 12, 13, 14].includes(c.length)) {
    return { ok: true, note: `ความยาว ${c.length} หลัก (ไม่ใช่มาตรฐาน EAN/UPC — ข้ามการตรวจ)` };
  }
  const digits = c.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  const calc = (10 - (sum % 10)) % 10;
  return calc === check
    ? { ok: true, note: `บาร์โค้ด ${c.length} หลัก ถูกต้อง ✓` }
    : { ok: false, note: `check digit ไม่ถูกต้อง (ควรเป็น ${calc})` };
}

/* สร้างโครงสินค้าเปล่า */
function blankProduct() {
  const ch = {};
  CHANNEL_KEYS.forEach((k) => {
    ch[k] = { status: 'off', requestedAt: '', confirmedBy: '', confirmedAt: '', listedAt: '', url: '', note: '' };
  });
  return {
    id: uid(),
    code: '', barcode: '', name: '',
    type: 'new',
    replaceOfId: '', replaceOfCode: '', replaceOfName: '',
    category: DEFAULT_CATEGORIES[0],
    unit: DEFAULT_UNITS[0],
    supplier: '', cost: '', price: '',
    note: '',
    createdBy: '',
    createdAt: nowISO(),
    updatedAt: nowISO(),
    recordDate: todayISO(),
    archived: false,
    channels: ch,
    history: [],
  };
}

/* สรุปสถานะรวมของสินค้า 1 รายการ (ใช้ในตาราง/Dashboard) */
function overallStatus(p) {
  const st = CHANNEL_KEYS.map((k) => p.channels?.[k]?.status || 'off');
  if (st.includes('pending')) return 'pending';
  if (st.includes('confirmed')) return 'confirmed';
  if (st.includes('listed')) return 'listed';
  if (st.includes('rejected')) return 'rejected';
  return 'off';
}
