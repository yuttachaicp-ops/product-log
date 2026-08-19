/* ============================================================
   importer.js — อ่านไฟล์สินค้าจาก Shopee / Lazada
   รองรับ .xlsx (อ่านเอง ไม่ใช้ไลบรารีภายนอก) และ .csv / .txt

   .xlsx = ไฟล์ ZIP ที่ข้างในเป็น XML
   ใช้ DecompressionStream ที่เบราว์เซอร์มีให้อยู่แล้วในการคลายซิป
   ============================================================ */

/* ---------- 1. คลายซิป ---------- */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('เบราว์เซอร์นี้อ่าน .xlsx ไม่ได้ — กรุณาบันทึกไฟล์เป็น .csv แล้วลองใหม่');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* อ่านโครงสร้าง ZIP แล้วคืนเฉพาะไฟล์ที่ต้องการ */
async function zipRead(buf, wanted) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  /* หา End of Central Directory (ท้ายไฟล์) */
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ไฟล์ .xlsx เสียหรือไม่ใช่ไฟล์ Excel');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  const dec = new TextDecoder('utf-8');

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize  = dv.getUint32(p + 20, true);
    const nlen   = dv.getUint16(p + 28, true);
    const elen   = dv.getUint16(p + 30, true);
    const clen   = dv.getUint16(p + 32, true);
    const lho    = dv.getUint32(p + 42, true);
    const name   = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;

    if (!wanted(name)) continue;

    /* ข้าม local file header เพื่อไปยังตัวข้อมูล */
    const lnlen = dv.getUint16(lho + 26, true);
    const lelen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lelen;
    const raw = u8.subarray(start, start + csize);
    out[name] = method === 0 ? raw : await inflateRaw(raw);
  }
  return out;
}

/* ---------- 2. แปลง .xlsx เป็นตาราง ---------- */
function colToIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function readXlsx(file) {
  const buf = await file.arrayBuffer();
  const files = await zipRead(buf, (n) =>
    n === 'xl/workbook.xml' || n === 'xl/sharedStrings.xml' || n.startsWith('xl/worksheets/sheet'));

  const dec = new TextDecoder('utf-8');
  const parse = (name) => {
    if (!files[name]) return null;
    return new DOMParser().parseFromString(dec.decode(files[name]), 'application/xml');
  };

  /* ตารางคำที่ใช้ซ้ำ */
  const shared = [];
  const ss = parse('xl/sharedStrings.xml');
  if (ss) {
    ss.querySelectorAll('si').forEach((si) => {
      let s = '';
      si.querySelectorAll('t').forEach((t) => { s += t.textContent; });
      shared.push(s);
    });
  }

  /* ใช้ชีตแรก */
  const sheetName = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  const sh = parse(sheetName);
  if (!sh) throw new Error('ไม่พบชีตข้อมูลในไฟล์');

  const rows = [];
  sh.querySelectorAll('row').forEach((r) => {
    const cells = [];
    r.querySelectorAll('c').forEach((c) => {
      const idx = colToIndex(c.getAttribute('r'));
      const t = c.getAttribute('t');
      let v = '';
      if (t === 's') {
        const i = +(c.querySelector('v')?.textContent || -1);
        v = shared[i] ?? '';
      } else if (t === 'inlineStr') {
        c.querySelectorAll('is t').forEach((n) => { v += n.textContent; });
      } else {
        v = c.querySelector('v')?.textContent ?? '';
      }
      cells[idx] = String(v).trim();
    });
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  });
  return rows;
}

/* ---------- 3. แปลง CSV เป็นตาราง ---------- */
function readCsvText(text) {
  let s = text.replace(/^﻿/, '');

  /* เดาตัวคั่นจากบรรทัดแรก */
  const head = s.slice(0, s.indexOf('\n') < 0 ? s.length : s.indexOf('\n'));
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let q = false;
  for (const ch of head) {
    if (ch === '"') q = !q;
    else if (!q && counts[ch] !== undefined) counts[ch]++;
  }
  const D = Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a), ',');

  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { inQ = true; continue; }
    if (ch === D) { row.push(cell.trim()); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

async function readTable(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return readXlsx(file);
  if (name.endsWith('.xls')) {
    throw new Error('ไฟล์ .xls รุ่นเก่ายังอ่านไม่ได้ — เปิดใน Excel แล้ว Save As เป็น .xlsx หรือ .csv');
  }
  return readCsvText(await file.text());
}

/* ---------- 4. เดาว่าคอลัมน์ไหนคืออะไร ----------
   ครอบคลุมหัวตารางของ Shopee / Lazada ทั้งไทยและอังกฤษ
------------------------------------------------- */
const FIELD_HINTS = {
  code: [
    'sku', 'seller sku', 'sellersku', 'รหัสสินค้า', 'รหัส sku', 'sku ผู้ขาย', 'รหัสสินค้าผู้ขาย',
    'variation sku', 'sku ตัวเลือก', 'รหัสตัวเลือก', 'item sku', 'product sku', 'รหัส',
    'seller_sku', 'sku สินค้า',
  ],
  barcode: [
    'barcode', 'บาร์โค้ด', 'บาร์โค้ต', 'ean', 'upc', 'gtin', 'รหัสบาร์โค้ด',
    'product barcode', 'รหัสสากล',
  ],
  name: [
    'product name', 'ชื่อสินค้า', 'name', 'ชื่อ', 'item name', 'product_name',
    'ชื่อผลิตภัณฑ์', 'title', 'variation name', 'ชื่อตัวเลือก',
  ],
  price: [
    'price', 'ราคา', 'ราคาขาย', 'selling price', 'variation price', 'ราคาตัวเลือก', 'retail price',
  ],
};

const norm = (s) => String(s || '').toLowerCase()
  .replace(/[\s_\-*()[\]{}."']/g, '').trim();

function guessColumns(header) {
  const hs = header.map(norm);
  const map = { code: -1, barcode: -1, name: -1, price: -1 };

  Object.entries(FIELD_HINTS).forEach(([field, hints]) => {
    /* ตรงเป๊ะก่อน */
    for (const h of hints) {
      const i = hs.indexOf(norm(h));
      if (i >= 0 && !Object.values(map).includes(i)) { map[field] = i; return; }
    }
    /* ไม่เจอค่อยหาแบบมีคำนั้นอยู่ */
    for (const h of hints) {
      const nh = norm(h);
      const i = hs.findIndex((x, j) => x.includes(nh) && !Object.values(map).includes(j));
      if (i >= 0) { map[field] = i; return; }
    }
  });
  return map;
}

/* หาแถวที่เป็นหัวตารางจริง (ไฟล์ Shopee มักมีคำอธิบายอยู่ 1-5 บรรทัดแรก) */
function findHeaderRow(rows) {
  let best = 0, bestScore = -1;
  const limit = Math.min(rows.length, 12);
  for (let i = 0; i < limit; i++) {
    const g = guessColumns(rows[i] || []);
    const score = [g.code, g.barcode, g.name].filter((x) => x >= 0).length * 10
      + (rows[i] || []).filter(Boolean).length;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}
