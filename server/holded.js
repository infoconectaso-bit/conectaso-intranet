'use strict';
/**
 * Integración con Holded (API de facturación).
 * - La clave de API se guarda en el setting 'holdedConfig' (nunca se devuelve al navegador).
 * - Solo LECTURA: leemos facturas y contactos; jamás escribimos en Holded.
 * Autenticación: cabecera 'key: <apiKey>'. Base: https://api.holded.com/api/invoicing/v1
 */
const { store } = require('./db');

const BASE = 'https://api.holded.com/api/invoicing/v1';

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

/** Comprueba que la clave funciona (pide 1 contacto). Devuelve {ok, info}. */
async function testConnection() {
  const data = await apiGet('/contacts?page=1');
  const n = Array.isArray(data) ? data.length : (data && data.total) || 0;
  return { ok: true, sample: n };
}

/** Lista las facturas (documentos tipo invoice). Holded pagina; traemos varias páginas. */
async function listInvoices({ maxPages = 10 } = {}) {
  const out = [];
  for (let p = 1; p <= maxPages; p++) {
    const page = await apiGet('/documents/invoice?page=' + p);
    const arr = Array.isArray(page) ? page : (page && page.data) || [];
    if (!arr.length) break;
    out.push(...arr);
    if (arr.length < 50) break; // última página
  }
  return out;
}

/** Devuelve una factura concreta (para inspeccionar campos: base imponible, estado de pago…). */
function getInvoice(id) { return apiGet('/documents/invoice/' + encodeURIComponent(id)); }

module.exports = { BASE, getConfig, enabled, apiGet, testConnection, listInvoices, getInvoice };
