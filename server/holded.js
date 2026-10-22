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

/** Lista las facturas de venta (API v2). Holded pagina; traemos varias páginas. */
async function listInvoices({ maxPages = 10 } = {}) {
  const out = [];
  for (let p = 1; p <= maxPages; p++) {
    const page = await apiGet('/invoices?page=' + p);
    const arr = Array.isArray(page) ? page : (page && page.data) || [];
    if (!arr.length) break;
    out.push(...arr);
    if (arr.length < 50) break; // última página
  }
  return out;
}

/** Devuelve una factura concreta (para inspeccionar campos: base imponible, estado de pago…). */
function getInvoice(id) { return apiGet('/invoices/' + encodeURIComponent(id)); }

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

module.exports = { BASE, getConfig, enabled, apiGet, testConnection, listInvoices, getInvoice, listPayslips, getPayslipPdf, testPayslips };
