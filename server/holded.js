'use strict';
/**
 * Integración con Holded (API de facturación).
 * - La clave de API se guarda en el setting 'holdedConfig' (nunca se devuelve al navegador).
 * - Solo LECTURA: leemos facturas y contactos; jamás escribimos en Holded.
 * Autenticación: token v2 → 'Authorization: Bearer <apiKey>'. Base: https://api.holded.com/api/v2
 */
const { store } = require('./db');

const BASE = 'https://api.holded.com/api/v2';

function getConfig() { return store.setting('holdedConfig') || {}; }
function enabled() { const c = getConfig(); return !!(c.enabled && c.apiKey); }

/** Petición GET a la API de Holded. Devuelve el JSON, o lanza un error legible.
 * Acepta los DOS tipos de credencial: el token nuevo (v2 → 'Authorization: Bearer')
 * y la clave antigua (v1 → cabecera 'key'). Prueba Bearer y, si da error de auth, la cabecera key. */
async function apiGet(path) {
  const c = getConfig();
  if (!c.apiKey) throw new Error('Falta la clave de API de Holded.');
  const url = BASE + path;
  const attempts = [{ Authorization: 'Bearer ' + c.apiKey }, { key: c.apiKey }];
  let lastErr = 'desconocido';
  for (const h of attempts) {
    let r;
    try { r = await fetch(url, { headers: Object.assign({ 'Content-Type': 'application/json' }, h) }); }
    catch (e) { throw new Error('No se pudo conectar con Holded: ' + e.message); }
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (r.ok) return data;
    lastErr = (data && (data.message || data.error || data.info)) || ('HTTP ' + r.status);
    // Solo probamos el otro método si parece un problema de autenticación.
    if (!/invalid key|unauthor|forbidden/i.test(String(lastErr)) && r.status !== 401 && r.status !== 403) break;
  }
  throw new Error('Holded respondió con error: ' + lastErr);
}

/** Comprueba que la clave funciona (pide contactos). Devuelve {ok, info}. */
async function testConnection() {
  const data = await apiGet('/contacts');
  const n = Array.isArray(data) ? data.length : (data && (data.total || (data.data && data.data.length))) || 0;
  return { ok: true, sample: n };
}

/** Lista las facturas de venta (API v2). La respuesta es { items, cursor, has_more }
 * (paginación por cursor, igual que nóminas). */
async function listInvoices({ maxPages = 50, limit = 200, filters = {} } = {}) {
  const out = [];
  let cursor = null;
  for (let p = 0; p < maxPages; p++) {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (cursor) qs.set('cursor', cursor);
    for (const [k, v] of Object.entries(filters)) if (v != null && v !== '') qs.set(k, String(v));
    const page = await apiGet('/invoices?' + qs.toString());
    const arr = (page && Array.isArray(page.items)) ? page.items : (Array.isArray(page) ? page : (page && page.data) || []);
    out.push(...arr);
    cursor = page && page.cursor;
    if (!cursor || (page && page.has_more === false) || !arr.length) break;
  }
  return out;
}

/** Devuelve una factura concreta (para inspeccionar campos: base imponible, estado de pago…). */
function getInvoice(id) { return apiGet('/invoices/' + encodeURIComponent(id)); }

/** Lista TODOS los contactos (paginación por cursor). */
async function listContacts({ maxPages = 50, limit = 500 } = {}) {
  const out = [];
  let cursor = null;
  for (let p = 0; p < maxPages; p++) {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (cursor) qs.set('cursor', cursor);
    const page = await apiGet('/contacts?' + qs.toString());
    const arr = (page && Array.isArray(page.items)) ? page.items : (Array.isArray(page) ? page : []);
    out.push(...arr);
    cursor = page && page.cursor;
    if (!cursor || (page && page.has_more === false) || !arr.length) break;
  }
  return out;
}

/** Descarga el PDF de una factura. Devuelve un Buffer o lanza error. */
async function getInvoicePdf(id) {
  const c = getConfig();
  if (!c.apiKey) throw new Error('Falta la clave de API de Holded.');
  const url = BASE + '/invoices/' + encodeURIComponent(id) + '/pdf';
  const attempts = [{ Authorization: 'Bearer ' + c.apiKey }, { key: c.apiKey }];
  let lastErr = 'desconocido';
  for (const h of attempts) {
    let r;
    try { r = await fetch(url, { headers: Object.assign({ Accept: 'application/pdf' }, h) }); }
    catch (e) { throw new Error('No se pudo conectar con Holded: ' + e.message); }
    if (r.ok) {
      const ct = r.headers.get('content-type') || '';
      if (/application\/json/i.test(ct)) {
        // Algunas cuentas devuelven { data: "<base64>" } en vez del binario.
        const j = await r.json().catch(() => null);
        const b64 = j && (j.data || j.pdf || j.base64);
        if (b64) return Buffer.from(String(b64), 'base64');
      }
      const ab = await r.arrayBuffer(); return Buffer.from(ab);
    }
    let t = ''; try { t = await r.text(); } catch (e) {}
    lastErr = t || ('HTTP ' + r.status);
    if (r.status !== 401 && r.status !== 403) break;
  }
  throw new Error('Holded respondió con error al descargar el PDF: ' + lastErr);
}

// ---------------------------------------------------------------------------
// Índice cacheado: contactos + facturas agrupadas por contacto. Evita pedir
// todo a Holded en cada apertura de evento. TTL corto (se puede forzar refresco).
// ---------------------------------------------------------------------------
let _idx = null, _idxAt = 0, _idxRefreshing = null;
const IDX_TTL = 5 * 60 * 1000;
const normEmail = s => String(s || '').trim().toLowerCase();
const normNif = s => String(s || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
const normName = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// Convierte importes de Holded ("3.629,00" o "220,00" o número) a Number.
function parseAmount(v) {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  let s = String(v).trim();
  if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.'); // formato europeo
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

async function _rebuildIndex() {
  const [contacts, invoices] = await Promise.all([listContacts(), listInvoices()]);
  // Un mismo NIF/email/nombre puede estar en VARIOS contactos (Holded permite duplicados), así que
  // cada clave apunta a una LISTA de contactos y luego se unen sus facturas.
  const byId = {}, byEmail = {}, byNif = {}, byName = {};
  const push = (map, k, cid) => { if (!k) return; (map[k] = map[k] || []); if (!map[k].includes(cid)) map[k].push(cid); };
  contacts.forEach(c => {
    const emails = [c.email].concat(Array.isArray(c.extra_emails) ? c.extra_emails : []).filter(Boolean);
    const entry = { id: c.id, name: c.name || '', emails, code: c.code || c.vat_number || '', invoices: [] };
    byId[c.id] = entry;
    emails.forEach(e => push(byEmail, normEmail(e), c.id));
    [c.code, c.vat_number].filter(Boolean).forEach(n => push(byNif, normNif(n), c.id));
    if (c.name) push(byName, normName(c.name), c.id);
  });
  invoices.forEach(inv => { const e = byId[inv.contact_id]; if (e) e.invoices.push(inv); });
  _idx = { byId, byEmail, byNif, byName, contactsN: contacts.length, invoicesN: invoices.length, builtAt: Date.now() };
  _idxAt = Date.now();
  return _idx;
}

// Índice con "stale-while-revalidate": si ya hay uno (aunque esté caducado) y no se fuerza, se devuelve
// al INSTANTE y se refresca en segundo plano. Así abrir Análisis/Impagos no espera a Holded.
async function buildIndex(force) {
  if (!force && _idx && (Date.now() - _idxAt) < IDX_TTL) return _idx;   // fresco
  if (!_idxRefreshing) _idxRefreshing = _rebuildIndex().finally(() => { _idxRefreshing = null; });
  if (_idx && !force) { _idxRefreshing.catch(() => {}); return _idx; }  // caducado: devuelve lo que hay y refresca detrás
  return _idxRefreshing;                                                // primera vez o refresco forzado: espera
}

/** Mapea una factura de Holded a la forma que usa la intranet.
 * IMPORTANTE: en la intranet los importes del evento van SIN IVA. Holded da el total y
 * los pagos CON IVA, así que calculamos la parte sin IVA de forma proporcional:
 *   base   = subtotal (base imponible, sin IVA)
 *   pagado = pagado_con_iva · base/total   (quita el IVA del importe pagado)
 *   pendiente = base − pagado
 * Se conservan también los importes con IVA (totalConIva, paidConIva) por si hacen falta. */
function mapInvoice(inv) {
  const totalConIva = parseAmount(inv.total);
  const base = parseAmount(inv.subtotal);
  const tax = parseAmount(inv.tax);
  const paidConIva = parseAmount(inv.payments_total);
  const ratio = totalConIva > 0 ? base / totalConIva : 1; // proporción sin IVA
  const paid = Math.round(paidConIva * ratio * 100) / 100; // pagado SIN IVA
  const pending = Math.max(0, Math.round((base - paid) * 100) / 100); // pendiente SIN IVA
  return {
    id: inv.id, number: inv.document_number || '', date: inv.date || '', dueDate: inv.due_date || '',
    desc: inv.description || '', total: base, paid, pending, tax, totalConIva, paidConIva, status: inv.status || '',
    paidFull: pending <= 0.009 && base > 0,
  };
}

/** Dado un conjunto de candidatos (emails, nifs, nombres) del cliente de una boda,
 * busca TODOS sus contactos en Holded (cada cónyuge puede tener el suyo) y UNE sus facturas.
 * opts.includeName=false ignora las coincidencias solo por nombre (para la vista de novios). */
async function invoicesForClient({ emails = [], nifs = [], names = [] } = {}, force, opts = {}) {
  const includeName = opts.includeName !== false;
  const idx = await buildIndex(force);
  const hits = []; const seen = new Set();
  const add = (ids, by) => { (ids || []).forEach(cid => { if (cid && !seen.has(cid)) { seen.add(cid); hits.push({ cid, by }); } }); };
  emails.forEach(e => add(idx.byEmail[normEmail(e)], 'email'));
  nifs.forEach(n => add(idx.byNif[normNif(n)], 'nif'));
  if (includeName) names.forEach(nm => add(idx.byName[normName(nm)], 'name'));
  const invMap = {}; const methods = new Set(); const contacts = [];
  hits.forEach(h => {
    const c = idx.byId[h.cid]; if (!c) return;
    methods.add(h.by);
    contacts.push({ id: c.id, name: c.name, by: h.by, nInv: (c.invoices || []).length });
    (c.invoices || []).forEach(inv => { invMap[inv.id] = inv; });
  });
  const invoices = Object.values(invMap).map(mapInvoice).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const matchedBy = methods.has('email') ? 'email' : methods.has('nif') ? 'nif' : (methods.has('name') ? 'name' : null);
  const primary = contacts.find(c => c.nInv > 0) || contacts[0] || null;
  return { contact: primary ? { id: primary.id, name: primary.name } : null, contacts, invoices, matchedBy, indexInfo: { contactsN: idx.contactsN, invoicesN: idx.invoicesN } };
}

/** Todas las facturas con importe pendiente (impagos), enriquecidas con el contacto.
 * El pendiente se da CON IVA (lo que realmente se debe). Ordenadas por vencimiento. */
async function allUnpaid(force) {
  const idx = await buildIndex(force);
  const out = [];
  Object.values(idx.byId).forEach(c => {
    (c.invoices || []).forEach(inv => {
      const m = mapInvoice(inv);
      const pending = Math.max(0, Math.round((m.totalConIva - m.paidConIva) * 100) / 100);
      if (pending > 0.009) out.push({
        id: m.id, number: m.number, date: m.date, dueDate: m.dueDate, desc: m.desc,
        base: m.total, iva: m.tax, total: m.totalConIva, paid: m.paidConIva, pending, status: m.status,
        contactId: c.id, contactName: c.name, contactEmails: c.emails, contactCode: c.code,
      });
    });
  });
  out.sort((a, b) => String(a.dueDate || a.date || '').localeCompare(String(b.dueDate || b.date || '')));
  return out;
}

/** Diagnóstico: busca en contactos y facturas por subcadena (nombre/NIF/email). Admin. */
async function findByText(q, force) {
  const idx = await buildIndex(force);
  const needle = String(q || '').toLowerCase();
  const contacts = Object.values(idx.byId).filter(c =>
    (c.name || '').toLowerCase().includes(needle) ||
    (c.code || '').toLowerCase().includes(needle) ||
    (c.emails || []).some(e => String(e).toLowerCase().includes(needle)) ||
    (c.invoices || []).some(i => String(i.description || '').toLowerCase().includes(needle))
  ).map(c => ({ id: c.id, name: c.name, code: c.code, emails: c.emails, nInv: (c.invoices || []).length,
    invoices: (c.invoices || []).map(i => ({ number: i.document_number, date: i.date, total: i.total, paid: i.payments_total, desc: i.description })).slice(0, 8) }));
  return { contactsN: idx.contactsN, invoicesN: idx.invoicesN, matches: contacts.slice(0, 20) };
}

/* =========================================================================
   NÓMINAS (Holded · Contabilidad → Nóminas · scope accounting:payrolls.read)
   GET /api/v2/payslips  → { items:[...], cursor, has_more }
   GET /api/v2/payslips/{id}/pdf → PDF binario
   ========================================================================= */

/** Lista TODAS las nóminas (pagina con cursor). Devuelve el array de items.
 * Cada item: { id, employee_id, employee_name, payslip_kind, date, period_start,
 *   period_end, payment_status, net_salary, ... }. */
async function listPayslips({ maxPages = 50, limit = 200, filters = {} } = {}) {
  const out = [];
  let cursor = null;
  for (let p = 0; p < maxPages; p++) {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (cursor) qs.set('cursor', cursor);
    for (const [k, v] of Object.entries(filters)) if (v != null && v !== '') qs.set(k, String(v));
    const page = await apiGet('/payslips?' + qs.toString());
    const arr = (page && Array.isArray(page.items)) ? page.items : (Array.isArray(page) ? page : []);
    out.push(...arr);
    cursor = page && page.cursor;
    if (!cursor || (page && page.has_more === false) || !arr.length) break;
  }
  return out;
}

/** Descarga el PDF de una nómina. Devuelve un Buffer (application/pdf) o lanza error. */
async function getPayslipPdf(id) {
  const c = getConfig();
  if (!c.apiKey) throw new Error('Falta la clave de API de Holded.');
  const url = BASE + '/payslips/' + encodeURIComponent(id) + '/pdf';
  const attempts = [{ Authorization: 'Bearer ' + c.apiKey }, { key: c.apiKey }];
  let lastErr = 'desconocido';
  for (const h of attempts) {
    let r;
    try { r = await fetch(url, { headers: Object.assign({ Accept: 'application/pdf' }, h) }); }
    catch (e) { throw new Error('No se pudo conectar con Holded: ' + e.message); }
    if (r.ok) { const ab = await r.arrayBuffer(); return Buffer.from(ab); }
    let t = ''; try { t = await r.text(); } catch (e) {}
    lastErr = t || ('HTTP ' + r.status);
    if (r.status !== 401 && r.status !== 403) break;
  }
  throw new Error('Holded respondió con error al descargar el PDF: ' + lastErr);
}

/** Comprueba/depura el acceso a nóminas. Prueba varias rutas y filtros y devuelve lo que ve. */
async function testPayslips() {
  const probes = {};
  const tryGet = async (label, path) => {
    try {
      const d = await apiGet(path);
      let shape;
      if (Array.isArray(d)) shape = { type: 'array', n: d.length, keys0: d[0] ? Object.keys(d[0]).slice(0, 12) : [] };
      else if (d && typeof d === 'object') shape = { type: 'object', keys: Object.keys(d).slice(0, 12), itemsN: Array.isArray(d.items) ? d.items.length : (Array.isArray(d.data) ? d.data.length : null) };
      else shape = { type: typeof d, value: String(d).slice(0, 80) };
      probes[label] = shape;
    } catch (e) { probes[label] = { error: String(e.message).slice(0, 120) }; }
  };
  await tryGet('payslips_draftTrue', '/payslips?limit=5&is_draft=true');
  let empId = null;
  try {
    const e = await apiGet('/employees?limit=50');
    const items = (e && (e.items || e.data)) || (Array.isArray(e) ? e : []);
    empId = items[0] && (items[0].id || items[0]._id);
    probes.firstEmp = { count: items.length, id: empId, keys: items[0] ? Object.keys(items[0]).slice(0, 25) : [] };
  } catch (e) { probes.firstEmp = { error: String(e.message).slice(0, 120) }; }
  if (empId) {
    await tryGet('emp_full', '/employees/' + empId);
    await tryGet('emp_documents', '/employees/' + empId + '/documents');
    await tryGet('emp_payslips', '/employees/' + empId + '/payslips');
    await tryGet('emp_files', '/employees/' + empId + '/files');
  }
  await tryGet('documents', '/documents?limit=5');
  return { ok: true, probes };
}

module.exports = { BASE, getConfig, enabled, apiGet, testConnection, listInvoices, getInvoice, listContacts, getInvoicePdf, buildIndex, mapInvoice, invoicesForClient, allUnpaid, findByText, parseAmount, listPayslips, getPayslipPdf, testPayslips };
