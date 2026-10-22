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
let _idx = null, _idxAt = 0;
const IDX_TTL = 10 * 60 * 1000;
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

async function buildIndex(force) {
  if (!force && _idx && (Date.now() - _idxAt) < IDX_TTL) return _idx;
  const [contacts, invoices] = await Promise.all([listContacts(), listInvoices()]);
  const byId = {}, byEmail = {}, byNif = {}, byName = {};
  contacts.forEach(c => {
    const emails = [c.email].concat(Array.isArray(c.extra_emails) ? c.extra_emails : []).filter(Boolean);
    const entry = { id: c.id, name: c.name || '', emails, code: c.code || c.vat_number || '', invoices: [] };
    byId[c.id] = entry;
    emails.forEach(e => { byEmail[normEmail(e)] = c.id; });
    [c.code, c.vat_number].filter(Boolean).forEach(n => { byNif[normNif(n)] = c.id; });
    if (c.name) byName[normName(c.name)] = c.id;
  });
  invoices.forEach(inv => { const e = byId[inv.contact_id]; if (e) e.invoices.push(inv); });
  _idx = { byId, byEmail, byNif, byName, contactsN: contacts.length, invoicesN: invoices.length, builtAt: Date.now() };
  _idxAt = Date.now();
  return _idx;
}

/** Mapea una factura de Holded a la forma que usa la intranet (importes numéricos). */
function mapInvoice(inv) {
  const total = parseAmount(inv.total);
  const paid = parseAmount(inv.payments_total);
  const pending = inv.payments_pending != null ? parseAmount(inv.payments_pending) : Math.max(0, total - paid);
  return {
    id: inv.id, number: inv.document_number || '', date: inv.date || '', dueDate: inv.due_date || '',
    desc: inv.description || '', total, paid, pending, status: inv.status || '',
    paidFull: pending <= 0.009 && total > 0,
  };
}

/** Dado un conjunto de candidatos (emails, nifs, nombres) del cliente de una boda,
 * resuelve su contacto en Holded y devuelve { contact, invoices[], matchedBy }. */
async function invoicesForClient({ emails = [], nifs = [], names = [] } = {}, force) {
  const idx = await buildIndex(force);
  let cid = null, matchedBy = null;
  for (const e of emails) { const id = idx.byEmail[normEmail(e)]; if (id) { cid = id; matchedBy = 'email'; break; } }
  if (!cid) for (const n of nifs) { const id = idx.byNif[normNif(n)]; if (id) { cid = id; matchedBy = 'nif'; break; } }
  if (!cid) for (const nm of names) { const id = idx.byName[normName(nm)]; if (id) { cid = id; matchedBy = 'name'; break; } }
  if (!cid) return { contact: null, invoices: [], matchedBy: null, indexInfo: { contactsN: idx.contactsN, invoicesN: idx.invoicesN } };
  const c = idx.byId[cid];
  const invoices = (c.invoices || []).map(mapInvoice).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { contact: { id: c.id, name: c.name, emails: c.emails, code: c.code }, invoices, matchedBy, indexInfo: { contactsN: idx.contactsN, invoicesN: idx.invoicesN } };
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

module.exports = { BASE, getConfig, enabled, apiGet, testConnection, listInvoices, getInvoice, listContacts, getInvoicePdf, buildIndex, mapInvoice, invoicesForClient, parseAmount, listPayslips, getPayslipPdf, testPayslips };
