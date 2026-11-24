'use strict';
/* Fuel Bills — scan fuel receipts with Gemini, store on-device, export for reimbursement. */

const $ = (s, r = document) => r.querySelector(s);
const DEFAULT_MODEL = 'gemini-2.5-flash';

/* ---------- IndexedDB ---------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('fuelbills', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('receipts', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction('receipts', mode);
    const rq = fn(t.objectStore('receipts'));
    t.oncomplete = () => res(rq && rq.result);
    t.onerror = () => rej(t.error);
  });
}
const dbAll = () => tx('readonly', s => s.getAll());
const dbPut = r => tx('readwrite', s => s.put(r));
const dbDel = id => tx('readwrite', s => s.delete(id));

/* ---------- helpers ---------- */
const settings = {
  get key() { return localStorage.getItem('gemini_key') || ''; },
  get model() { return localStorage.getItem('gemini_model') || DEFAULT_MODEL; },
};
const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = n => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]}-${y}`;
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3500);
}
function busy(text) { $('#busy-text').textContent = text || ''; $('#busy').classList.toggle('hidden', !text); }
function show(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + name));
}

/* ---------- image compression ---------- */
async function loadBitmap(file) {
  try { return await createImageBitmap(file); } catch (_) {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
  }
}
async function compress(file, max = 1600, quality = 0.72) {
  const bmp = await loadBitmap(file);
  const w0 = bmp.width, h0 = bmp.height;
  const k = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
}
const blobToB64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = rej; r.readAsDataURL(blob);
});

/* ---------- Gemini extraction ---------- */
const PROMPT = `You are reading a photo of a fuel (petrol/diesel/CNG) pump receipt or invoice from India (Indian Oil, Bharat Petroleum, HPCL, Reliance, Nayara, Shell etc.).
Extract these fields exactly as printed:
- invoice_no: the receipt / invoice / bill number (may be labelled "Bill No", "Invoice No", "Receipt No", "Inv No", "Trans ID"). Prefer the invoice/bill number over machine/nozzle/vehicle numbers. Keep letters, digits and separators as printed.
- date: date of the receipt as YYYY-MM-DD. Indian receipts use DD/MM/YYYY or DD-MM-YY (day first). Two-digit years are 20xx.
- total_amount: total amount paid in INR as a number (labelled "Amount", "Sale", "Total", "Net Amount").
- volume_litres: quantity of fuel in litres as a number (labelled "Volume", "Qty", "Quantity", "Ltr").
- rate_per_litre: price per litre in INR as a number (labelled "Rate", "Rate/Ltr", "Price").
- vendor: the fuel station / outlet name, if visible.
Important: ignore "Atot"/"Vtot" (pump lifetime totaliser counters, huge numbers), "FCC ID", "FIP No", "Nozzle No", vehicle number and phone numbers. Take Amount/Volume/Rate only from the lines labelled "Amount(Rs)", "Volume(L)" and "Rate(Rs/L)". Bank names printed vertically along the paper edge (SBI Payments, HDFC Bank) are background watermarks, not receipt data. Leading zeros in numbers like 00023.31 are padding.
Use null for anything not legible. Never guess or calculate a value that is not printed. Return only JSON.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    invoice_no: { type: 'STRING', nullable: true },
    date: { type: 'STRING', nullable: true },
    total_amount: { type: 'NUMBER', nullable: true },
    volume_litres: { type: 'NUMBER', nullable: true },
    rate_per_litre: { type: 'NUMBER', nullable: true },
    vendor: { type: 'STRING', nullable: true },
  },
};

async function extract(blob) {
  if (!settings.key) throw new Error('No Gemini API key set. Add it in Settings (⚙).');
  const body = {
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: await blobToB64(blob) } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.key },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      if (!text) throw new Error('Gemini returned no text (image may have been blocked).');
      return JSON.parse(text);
    }
    const detail = (await r.json().catch(() => ({})))?.error?.message || r.statusText;
    lastErr = new Error(`Gemini error ${r.status}: ${detail}`);
    if (r.status !== 429 && r.status !== 503) break;
    await new Promise(s => setTimeout(s, 1500 * (attempt + 1)));
  }
  throw lastErr;
}

function normDate(s) {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!m) return '';
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/* ---------- list view ---------- */
let receipts = [];
const thumbURLs = [];

async function refresh() {
  receipts = (await dbAll()).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id);
  renderList();
}
const monthOf = r => (r.date || '').slice(0, 7);
function renderList() {
  const sel = $('#month-filter');
  const prev = sel.value || 'all';
  const months = [...new Set(receipts.map(monthOf).filter(Boolean))];
  sel.innerHTML = '<option value="all">All receipts</option>' + months.map(m => {
    const [y, mo] = m.split('-');
    return `<option value="${m}">${['January','February','March','April','May','June','July','August','September','October','November','December'][mo - 1]} ${y}</option>`;
  }).join('');
  sel.value = months.includes(prev) ? prev : 'all';

  const shown = sel.value === 'all' ? receipts : receipts.filter(r => monthOf(r) === sel.value);
  const tot = sum(shown);
  $('#totals').innerHTML = `<span><b>${shown.length}</b> receipts</span><span><b>${fmtINR(tot.amount)}</b></span><span><b>${fmtNum(tot.litres)}</b> L</span>`;

  thumbURLs.splice(0).forEach(URL.revokeObjectURL);
  $('#empty').classList.toggle('hidden', receipts.length > 0);
  $('#list').innerHTML = '';
  for (const r of shown) {
    const u = URL.createObjectURL(r.image); thumbURLs.push(u);
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<img src="${u}" alt=""><div class="m"><div class="t"><span>${fmtDate(r.date)}</span><span>${fmtINR(r.amount)}</span></div>
      <div class="s">#${esc(r.invoice || '—')} · ${r.litres != null ? fmtNum(r.litres) + ' L' : '— L'} @ ${r.rate != null ? '₹' + fmtNum(r.rate) : '—'}</div>
      <div class="s">${esc(r.vendor || '')}</div></div>`;
    el.onclick = () => openEdit(r);
    $('#list').appendChild(el);
  }
}
const sum = list => list.reduce((a, r) => ({ amount: a.amount + (r.amount || 0), litres: a.litres + (r.litres || 0) }), { amount: 0, litres: 0 });
$('#month-filter').onchange = renderList;

/* ---------- add / edit ---------- */
let cur = null, curURL = null;
const form = $('#edit-form');

async function onPick(file) {
  if (!file) return;
  busy('Compressing photo…');
  let blob;
  try { blob = await compress(file); } catch (e) { busy(''); return toast('Could not read that image.'); }
  cur = { image: blob };
  openEdit(cur, true);
  busy('');
  await runExtract();
}
$('#in-camera').onchange = e => { onPick(e.target.files[0]); e.target.value = ''; };
$('#in-file').onchange = e => { onPick(e.target.files[0]); e.target.value = ''; };

function openEdit(r, isNew = false) {
  cur = r;
  if (curURL) URL.revokeObjectURL(curURL);
  curURL = URL.createObjectURL(r.image);
  $('#edit-img').src = curURL;
  $('#edit-title').textContent = isNew ? 'New receipt' : 'Edit receipt';
  form.invoice.value = r.invoice || '';
  form.date.value = r.date || '';
  form.amount.value = r.amount ?? '';
  form.litres.value = r.litres ?? '';
  form.rate.value = r.rate ?? '';
  form.vendor.value = r.vendor || '';
  $('#edit-delete').classList.toggle('hidden', isNew || r.id == null);
  $('#edit-status').textContent = '';
  checkMath();
  show('edit');
}

async function runExtract() {
  const status = $('#edit-status');
  status.textContent = '🔍 Reading receipt with Gemini…';
  try {
    const d = await extract(cur.image);
    form.invoice.value = d.invoice_no ?? '';
    form.date.value = normDate(d.date);
    form.amount.value = d.total_amount ?? '';
    form.litres.value = d.volume_litres ?? '';
    form.rate.value = d.rate_per_litre ?? '';
    form.vendor.value = d.vendor ?? '';
    status.textContent = '✅ Read complete — please verify against the photo, then Save.';
  } catch (e) {
    status.textContent = '⚠ ' + e.message + ' You can still enter the details by hand.';
  }
  checkMath();
}
$('#edit-rescan').onclick = runExtract;

function checkMath() {
  const a = num(form.amount.value), l = num(form.litres.value), r = num(form.rate.value);
  const w = $('#edit-warn');
  if (a != null && l != null && r != null && Math.abs(l * r - a) > Math.max(2, a * 0.02)) {
    w.textContent = `Check values: ${fmtNum(l)} L × ₹${fmtNum(r)} = ${fmtINR(l * r)}, but total is ${fmtINR(a)}.`;
    w.classList.remove('hidden');
  } else w.classList.add('hidden');
}
['amount', 'litres', 'rate'].forEach(n => form[n].addEventListener('input', checkMath));

form.onsubmit = async e => {
  e.preventDefault();
  const rec = {
    ...(cur.id != null ? { id: cur.id } : {}),
    image: cur.image,
    createdAt: cur.createdAt || Date.now(),
    invoice: form.invoice.value.trim(),
    date: form.date.value,
    amount: num(form.amount.value),
    litres: num(form.litres.value),
    rate: num(form.rate.value),
    vendor: form.vendor.value.trim(),
  };
  const dup = receipts.find(r => r.id !== rec.id && rec.invoice && r.invoice === rec.invoice && r.date === rec.date);
  if (dup && !confirm('A receipt with the same invoice number and date is already saved. Save anyway?')) return;
  await dbPut(rec);
  await refresh();
  show('list');
  toast('Saved');
};
$('#edit-delete').onclick = async () => {
  if (!confirm('Delete this receipt and its photo?')) return;
  await dbDel(cur.id); await refresh(); show('list');
};
$('#edit-back').onclick = () => show('list');

/* ---------- export ---------- */
function exportSet() {
  const from = $('#ex-from').value, to = $('#ex-to').value;
  return receipts.filter(r => (!from || r.date >= from) && (!to || r.date <= to)).sort((a, b) => a.date.localeCompare(b.date));
}
function updateExSummary() {
  const l = exportSet(), t = sum(l);
  $('#ex-summary').textContent = `${l.length} receipts · ${fmtINR(t.amount)} · ${fmtNum(t.litres)} L`;
}
$('#btn-export').onclick = () => {
  const sel = $('#month-filter').value;
  const ds = receipts.map(r => r.date).filter(Boolean).sort();
  let from = ds[0] || '', to = ds[ds.length - 1] || '';
  if (sel !== 'all') {
    const [y, m] = sel.split('-').map(Number);
    from = `${sel}-01`; to = `${sel}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  }
  $('#ex-from').value = from; $('#ex-to').value = to;
  updateExSummary(); show('export');
};
$('#ex-from').onchange = $('#ex-to').onchange = updateExSummary;
$('#export-back').onclick = () => show('list');

const imgName = (r, used) => {
  let base = `${r.date}_${(r.invoice || 'receipt').replace(/[^\w.-]+/g, '_')}`, n = base, i = 2;
  while (used.has(n)) n = `${base}_${i++}`;
  used.add(n); return n + '.jpg';
};
function buildCSV(list, names) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Receipt/Invoice No', 'Vendor', 'Amount (INR)', 'Volume (L)', 'Rate (INR/L)', 'Photo file']];
  list.forEach((r, i) => rows.push([r.date, r.invoice, r.vendor, r.amount ?? '', r.litres ?? '', r.rate ?? '', names ? names[i] : '']));
  const t = sum(list);
  rows.push(['TOTAL', '', '', t.amount.toFixed(2), t.litres.toFixed(2), '', '']);
  return '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n');
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const rangeTag = () => `${$('#ex-from').value || 'start'}_to_${$('#ex-to').value || 'end'}`;

$('#ex-csv').onclick = () => {
  const l = exportSet(); if (!l.length) return toast('No receipts in range.');
  download(new Blob([buildCSV(l)], { type: 'text/csv' }), `fuel-report_${rangeTag()}.csv`);
};
$('#ex-zip').onclick = async () => {
  const l = exportSet(); if (!l.length) return toast('No receipts in range.');
  busy('Building ZIP…');
  try {
    const used = new Set(), names = l.map(r => imgName(r, used));
    const enc = new TextEncoder();
    const files = [{ name: 'report.csv', data: enc.encode(buildCSV(l, names.map(n => 'receipts/' + n))) }];
    for (let i = 0; i < l.length; i++) files.push({ name: 'receipts/' + names[i], data: new Uint8Array(await l[i].image.arrayBuffer()) });
    const zip = new Blob(makeZip(files),{ type: 'application/zip' });
    const fname = `fuel-receipts_${rangeTag()}.zip`;
    const file = new File([zip], fname, { type: 'application/zip' });
    busy('');
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Fuel receipts' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    download(zip, fname);
  } finally { busy(''); }
};
$('#ex-print').onclick = () => {
  const l = exportSet(); if (!l.length) return toast('No receipts in range.');
  const urls = l.map(r => URL.createObjectURL(r.image)), t = sum(l);
  $('#printArea').innerHTML = `<h2>Fuel expense report</h2>
    <p>${fmtDate($('#ex-from').value)} to ${fmtDate($('#ex-to').value)} · ${l.length} receipts</p>
    <table><thead><tr><th>#</th><th>Date</th><th>Receipt / Invoice No</th><th>Vendor</th><th class="n">Volume (L)</th><th class="n">Rate (₹/L)</th><th class="n">Amount (₹)</th></tr></thead><tbody>
    ${l.map((r, i) => `<tr><td>${i + 1}</td><td>${fmtDate(r.date)}</td><td>${esc(r.invoice)}</td><td>${esc(r.vendor)}</td><td class="n">${r.litres != null ? fmtNum(r.litres) : ''}</td><td class="n">${r.rate != null ? fmtNum(r.rate) : ''}</td><td class="n">${fmtNum(r.amount)}</td></tr>`).join('')}
    <tr><th colspan="4">Total</th><th class="n">${fmtNum(t.litres)}</th><th></th><th class="n">${fmtINR(t.amount)}</th></tr></tbody></table>
    <div class="photos">${l.map((r, i) => `<figure><img src="${urls[i]}"><figcaption>${i + 1}. ${fmtDate(r.date)} · #${esc(r.invoice)} · ${fmtINR(r.amount)}</figcaption></figure>`).join('')}</div>`;
  const done = () => { $('#printArea').innerHTML = ''; urls.forEach(URL.revokeObjectURL); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 300); // let images decode
};

/* ---------- minimal ZIP writer (store, no compression: JPEGs are already compressed) ---------- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let offset = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, nm, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, nm.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, nm);
    offset += 30 + nm.length + size;
  }
  const cdSize = central.reduce((a, b) => a + (b.byteLength ?? b.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return [...parts, ...central, end.buffer];
}

/* ---------- settings ---------- */
$('#btn-settings').onclick = async () => {
  $('#set-key').value = settings.key;
  $('#set-model').value = localStorage.getItem('gemini_model') || '';
  $('#set-storage').textContent = '…';
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    $('#set-storage').textContent = `${(e.usage / 1048576).toFixed(1)} MB used of ${(e.quota / 1048576).toFixed(0)} MB available`;
  } else $('#set-storage').textContent = 'n/a';
  show('settings');
};
$('#set-save').onclick = () => {
  localStorage.setItem('gemini_key', $('#set-key').value.trim());
  localStorage.setItem('gemini_model', $('#set-model').value.trim());
  toast('Settings saved'); show('list');
};
$('#set-back').onclick = () => show('list');

/* ---------- init ---------- */
(async () => {
  db = await openDB();
  if (navigator.storage?.persist) navigator.storage.persist(); // ask browser not to evict receipts
  await refresh();
  if (!settings.key) toast('Add your Gemini API key in Settings (⚙) to enable scanning.');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
