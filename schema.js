/* schema.js — นิยามข้อมูลกลางของระบบ
 * แก้ไฟล์นี้เพียงที่เดียว แล้วฟอร์ม / ตาราง / export จะเปลี่ยนตามทั้งหมด
 */
window.SCHEMA = (function () {
  'use strict';

  /* ---------- สถานะรูปภาพ (คิวถ่ายรูป) ---------- */
  const PHOTO_STATUS = [
    { key: 'pending',  label: 'รอถ่ายรูป',   short: 'รอถ่าย',   tone: 'warn' },
    { key: 'shot',     label: 'ถ่ายแล้ว',    short: 'ถ่ายแล้ว', tone: 'info' },
    { key: 'uploaded', label: 'อัปโหลดแล้ว', short: 'ขึ้นแล้ว', tone: 'ok'   },
    { key: 'na',       label: 'ไม่ต้องถ่าย',  short: 'ไม่ต้อง',  tone: 'mute' },
  ];

  /* ---------- สถานะบาร์โค้ด ---------- */
  const BARCODE_STATUS = [
    { key: 'ok',      label: 'ใช้งานได้ปกติ',      short: 'ปกติ',        tone: 'mute' },
    { key: 'changed', label: 'เปลี่ยนเลขใหม่',      short: 'เปลี่ยนเลข',  tone: 'info' },
    { key: 'nolabel', label: 'ติดบาร์โค้ดไม่ได้',   short: 'ติดไม่ได้',   tone: 'warn' },
    { key: 'pending', label: 'รอทำ/รอเลขบาร์โค้ด',  short: 'รอเลข',       tone: 'warn' },
  ];

  /* ---------- ประเภทการเข้าสินค้า ---------- */
  const ENTRY_TYPE = [
    { key: 'new',     label: 'สินค้าเข้าใหม่',        short: 'เข้าใหม่' },
    { key: 'replace', label: 'มาแทนรุ่นเดิม',         short: 'แทนรุ่นเดิม' },
    { key: 'restock', label: 'เข้าเพิ่ม (รุ่นเดิม)',   short: 'เข้าเพิ่ม' },
  ];

  /* ---------- ฟิลด์ของสินค้า 1 รายการ ---------- */
  // type: text | textarea | date | select | number
  const FIELDS = [
    { key: 'code',      label: 'รหัสสินค้า / SKU', type: 'text',     required: true,  placeholder: 'เช่น PRT-1042', col: 1 },
    { key: 'barcode',   label: 'บาร์โค้ด (เลขที่ใช้อยู่)', type: 'text', required: false, placeholder: 'สแกนหรือพิมพ์ตัวเลข',
      col: 1, scan: true, inputMode: 'numeric' },
    { key: 'barcodeStatus', label: 'สถานะบาร์โค้ด', type: 'select', required: true, options: BARCODE_STATUS, default: 'ok', col: 1 },
    { key: 'barcodeOld', label: 'บาร์โค้ดเดิม (ยิงแล้วยังหาเจอ)', type: 'text', required: false,
      placeholder: 'ใส่ได้หลายเลข คั่นด้วยจุลภาค ,', col: 2, inputMode: 'numeric',
      showIf: (d) => d.barcodeStatus === 'changed' || String(d.barcodeOld || '').trim() !== '' },
    { key: 'barcodeNote', label: 'หมายเหตุบาร์โค้ด', type: 'text', required: false,
      placeholder: 'เช่น ติดที่กล่องแทน / ใช้ป้ายแขวน / ยิงจากใบราคา', col: 2,
      showIf: (d) => d.barcodeStatus === 'nolabel' || d.barcodeStatus === 'pending' || String(d.barcodeNote || '').trim() !== '' },
    { key: 'name',      label: 'ชื่อสินค้า',        type: 'text',     required: true,  placeholder: 'ชื่อที่ใช้เรียกในร้าน', col: 2 },
    { key: 'brand',     label: 'แบรนด์',           type: 'text',     required: false, placeholder: '', col: 1, datalist: 'brands' },
    { key: 'model',     label: 'รุ่น',              type: 'text',     required: false, placeholder: '', col: 1 },
    { key: 'entryType', label: 'ประเภทการเข้า',     type: 'select',   required: true,  options: ENTRY_TYPE, default: 'new', col: 1 },
    { key: 'replaces',  label: 'มาแทนรุ่นเดิม',      type: 'text',     required: false, placeholder: 'รุ่น/รหัสเดิมที่ถูกแทน',
      showIf: (d) => d.entryType === 'replace', col: 1 },
    { key: 'arrivalDate', label: 'วันที่เข้า',        type: 'date',     required: false, col: 1 },
    { key: 'photoStatus', label: 'สถานะรูป',         type: 'select',   required: true,  options: PHOTO_STATUS, default: 'pending', col: 1 },
    { key: 'note',      label: 'หมายเหตุ',          type: 'textarea', required: false, placeholder: 'รายละเอียดเพิ่มเติม เช่น จุดต่างจากรุ่นเดิม', col: 2 },
  ];

  const byKey = {};
  FIELDS.forEach((f) => (byKey[f.key] = f));

  function label(list, key) {
    const hit = list.find((x) => x.key === key);
    return hit ? hit.label : (key || '—');
  }
  function shortLabel(list, key) {
    const hit = list.find((x) => x.key === key);
    return hit ? (hit.short || hit.label) : (key || '—');
  }
  function tone(key) {
    const hit = PHOTO_STATUS.find((x) => x.key === key);
    return hit ? hit.tone : 'mute';
  }
  function toneIn(list, key) {
    const hit = list.find((x) => x.key === key);
    return hit ? (hit.tone || 'mute') : 'mute';
  }

  /* ---------- เอกสารเปล่า ---------- */
  function blank() {
    const d = {};
    FIELDS.forEach((f) => (d[f.key] = f.default !== undefined ? f.default : ''));
    if (!d.arrivalDate) d.arrivalDate = new Date().toISOString().slice(0, 10);
    return d;
  }

  /* ---------- ตรวจความถูกต้อง ---------- */
  function validate(d) {
    const errors = {};
    FIELDS.forEach((f) => {
      if (f.showIf && !f.showIf(d)) return;
      if (f.required && !String(d[f.key] ?? '').trim()) errors[f.key] = 'จำเป็นต้องกรอก';
    });
    return errors;
  }

  /* ---------- แยกเลขบาร์โค้ดหลายเลขออกเป็นลิสต์ ---------- */
  function codes(str) {
    return String(str || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  }

  /** ทุกเลขที่ยิงแล้วควรเจอสินค้านี้ (เลขที่ใช้อยู่ + เลขเดิมทั้งหมด) */
  function allCodes(d) {
    const out = [];
    const cur = String(d.barcode || '').trim();
    if (cur) out.push(cur);
    codes(d.barcodeOld).forEach((c) => { if (!out.includes(c)) out.push(c); });
    return out;
  }

  /** ต้องจัดการเรื่องบาร์โค้ดไหม (ยังไม่มีเลข และไม่ได้ระบุว่าติดไม่ได้) */
  function barcodeTodo(d) {
    if (d.barcodeStatus === 'pending') return true;
    if (d.barcodeStatus === 'nolabel') return false;
    return !String(d.barcode || '').trim();
  }

  return { FIELDS, byKey, PHOTO_STATUS, ENTRY_TYPE, BARCODE_STATUS, blank, validate, label, shortLabel, tone, toneIn, codes, allCodes, barcodeTodo };
})();
