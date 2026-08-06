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
    { key: 'barcode',   label: 'บาร์โค้ด',          type: 'text',     required: false, placeholder: 'สแกนหรือพิมพ์ตัวเลข',
      col: 1, scan: true, inputMode: 'numeric' },
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

  return { FIELDS, byKey, PHOTO_STATUS, ENTRY_TYPE, blank, validate, label, shortLabel, tone };
})();
