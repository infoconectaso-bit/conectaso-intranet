'use strict';
/**
 * Gestor de eventos de Conecta So — servidor HTTP sin dependencias externas.
 * Node 22+ (usa node:sqlite integrado). Arranque: npm start
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { store, users, DATA_DIR } = require('./db');
const auth = require('./auth');
const mail = require('./mail');
const emails = require('./emails');
const perm = require('./permissions');
const fact = require('./facturacion');
const { evFinished, evRealized } = require('./time');
const volcado = require('./volcado');
const holded = require('./holded');
const backup = require('./backup');
const cloudBackup = require('./cloud-backup');

const PORT = +(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, '..', 'public');
const UPLOADS = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
const MAX_UPLOAD = +(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024;
// La URL base de los enlaces de email/magic links. Prioriza el ajuste guardado en la app
// (store 'appUrl'), que el admin puede cambiar sin tocar el servidor (útil para el cutover al dominio).
const APP_URL = () => String(store.setting('appUrl') || process.env.APP_URL || '').replace(/\/$/, '');

/* ---------- utilidades HTTP ---------- */
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  // 'no-store': las respuestas de la API nunca se cachean en el navegador. Sin esto, algunos
  // navegadores servían un listado antiguo (p. ej. un evento recién asignado no aparecía).
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }, headers);
  // Compresión gzip: los listados (eventos, usuarios) ocupan cientos de KB en JSON y se
  // reducen ~85% comprimidos, acelerando mucho la carga. Solo si el navegador lo acepta
  // y la respuesta es grande (umbral 1KB); el coste de CPU es mínimo para este tráfico.
  const ae = (res.req && res.req.headers['accept-encoding']) || '';
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (/\bgzip\b/.test(ae) && buf.length >= 1024 && !h['Content-Encoding']) {
    try {
      const gz = zlib.gzipSync(buf);
      h['Content-Encoding'] = 'gzip';
      h['Vary'] = 'Accept-Encoding';
      res.writeHead(status, h);
      return res.end(gz);
    } catch (e) { /* si falla, se envía sin comprimir */ }
  }
  res.writeHead(status, h);
  res.end(data);
}
const ok = (res, body) => send(res, 200, body);
const fail = (res, status, message) => send(res, status, { error: message });
function readBody(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(perm.httpError(413, 'Cuerpo demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const b = Buffer.concat(chunks); if (!b.length) return resolve({}); try { resolve(JSON.parse(b.toString('utf8'))); } catch (e) { reject(perm.httpError(400, 'JSON no válido')); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json; charset=utf-8' };

/* ---------- versión automática de assets (cache-busting sin tocar nada a mano) ----------
   Cada /assets/… lleva ?v=<hash de su contenido>. El servidor reescribe index.html al
   servirlo, así que al cambiar un JS/CSS su hash cambia solo y el navegador pide el nuevo.
   Ya NO hay que subir el número de versión a mano (antes olvidarlo dejaba la app "rota"). */
const _assetVer = new Map();
function assetVersion(rel) {
  try {
    const full = path.join(PUBLIC, rel);
    const st = fs.statSync(full);
    const c = _assetVer.get(rel);
    if (c && c.m === st.mtimeMs) return c.v;
    const v = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex').slice(0, 10);
    _assetVer.set(rel, { m: st.mtimeMs, v });
    return v;
  } catch (e) { return String(Date.now()); }
}
function serveIndexHtml(res) {
  fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8', (e, html) => {
    if (e) return fail(res, 404, 'No encontrado');
    const out = html.replace(/(\/?assets\/[^"'?\s]+)\?v=[^"'\s]*/g, (m, p) => p + '?v=' + assetVersion(p.replace(/^\/+/, '')));
    // index.html NUNCA se cachea (no-store): así cada carga pide la última versión y los móviles no
    // se quedan con una copia vieja. Los assets (con ?v=<hash>) sí se cachean, pero su URL cambia al cambiar.
    send(res, 200, out, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
  });
}

/* ---------- servir ficheros estáticos ---------- */
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  if (rel === 'index.html') return serveIndexHtml(res);
  const full = path.normalize(path.join(PUBLIC, rel));
  if (!full.startsWith(PUBLIC)) return fail(res, 403, 'Prohibido');
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA: rutas del cliente devuelven index.html (con versiones reescritas)
      if (!path.extname(rel)) return serveIndexHtml(res);
      return fail(res, 404, 'No encontrado');
    }
    const ext = path.extname(full).toLowerCase();
    // Caché larga SOLO si la URL trae ?v=<hash> (versión automática): la URL cambia al cambiar
    // el archivo, así que es seguro. Sin ?v (p. ej. un logo referido directo) → revalidar siempre.
    const cache = /[?&]v=/.test(req.url || '') ? 'public, max-age=31536000, immutable' : 'no-cache';
    const ae = (req.headers['accept-encoding'] || '');
    const textAsset = /\.(js|css|svg|json|html|webmanifest|map|txt)$/i.test(ext);
    // Comprimir JS/CSS/SVG: el bundle pesa bastante y en la primera carga se nota.
    if (textAsset && /\bgzip\b/.test(ae)) {
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      return fs.createReadStream(full).pipe(zlib.createGzip()).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache, 'Content-Length': stat.size });
    fs.createReadStream(full).pipe(res);
  });
}

/* ---------- multipart (subida de archivos) sin dependencias ---------- */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    if (!m) return reject(perm.httpError(400, 'No es multipart'));
    const boundary = Buffer.from('--' + (m[1] || m[2]));
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_UPLOAD + 65536) { reject(perm.httpError(413, 'Archivo demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('error', reject);
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const parts = []; let start = buf.indexOf(boundary);
      while (start >= 0) {
        const next = buf.indexOf(boundary, start + boundary.length);
        if (next < 0) break;
        const seg = buf.slice(start + boundary.length + 2, next - 2); // salta CRLF
        const hEnd = seg.indexOf('\r\n\r\n');
        if (hEnd >= 0) {
          const header = seg.slice(0, hEnd).toString('utf8');
          const content = seg.slice(hEnd + 4);
          const name = /name="([^"]*)"/.exec(header);
          const filename = /filename="([^"]*)"/.exec(header);
          const type = /Content-Type:\s*([^\r\n]+)/i.exec(header);
          parts.push({ name: name && name[1], filename: filename && filename[1], type: type && type[1].trim(), content });
        }
        start = next;
      }
      resolve(parts);
    });
  });
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const seg = parts.slice(1);
  const method = req.method;
  let user = auth.sessionUser(req);

  // Acceso temporal por clave en la URL (sin sesión) SOLO para las páginas puntuales de nóminas,
  // porque abrirlas desde el móvil/otro navegador no lleva la cookie de sesión. Se quitarán al terminar.
  const TMP_KEY = 'cstmp4e76f701be27bbfab821487e8f44caa2';
  if (!user && method === 'GET' && (seg[0] === 'payslip-gaps' || seg[0] === 'holded-payslip-sync') && url.searchParams.get('k') === TMP_KEY) {
    user = { id: null, role: 'admin', name: 'acceso temporal' };
  }

  // --- autenticación pública ---
  if (seg[0] === 'auth') {
    if (seg[1] === 'login' && method === 'POST') return login(req, res);
    if (seg[1] === 'logout' && method === 'POST') { auth.destroySession(req, res); return ok(res, { ok: true }); }
    if (seg[1] === 'me' && method === 'GET') return ok(res, { user: user ? meView(user) : null, mailEnabled: mail.enabled() });
    if (seg[1] === 'invite-info' && method === 'GET') return inviteInfo(req, res, url);
    if (seg[1] === 'activate' && method === 'POST') return activate(req, res);
    if (seg[1] === 'albaran-login' && method === 'POST') return albaranLogin(req, res);
    if (seg[1] === 'forgot' && method === 'POST') return forgot(req, res);
    if (seg[1] === 'change-password' && method === 'POST') return changePassword(req, res, user);
    return fail(res, 404, 'Ruta no encontrada');
  }

  // --- volcado/migración (protegido por secreto, NO por sesión): operación puntual ---
  if (seg[0] === 'volcado') return volcado.handle(req, res, seg, method, url);

  if (!user) return fail(res, 401, 'Necesitas iniciar sesión');

  // --- metadatos (catálogos para la interfaz) ---
  if (seg[0] === 'meta' && method === 'GET') return ok(res, meta(user));
  if (seg[0] === 'brand' && method === 'GET') return ok(res, store.setting('brand') || {});

  // --- eventos ---
  if (seg[0] === 'events') return events(req, res, user, seg, method, url);

  // --- Ajustes MANUALES de tarifas de DJ (overrides) que sobreviven al volcado ---
  // Se guardan en el setting 'djRatesManual' y se re-aplican sobre djRates tras cada import/build.
  if (seg[0] === 'dj-rates-manual') {
    if (!user || user.role !== 'admin') return fail(res, 403, 'Sin acceso');
    if (method === 'GET') return ok(res, { overrides: store.setting('djRatesManual') || {} });
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.overrides || typeof body.overrides !== 'object') return fail(res, 400, 'Falta overrides');
      store.setSetting('djRatesManual', body.overrides);
      const n = applyManualRates();
      store.audit(user.id, 'dj-rates-manual');
      return ok(res, { ok: true, djsAfectados: n });
    }
  }

  // --- Usuarios excluidos del volcado (no re-crearlos al reimportar) ---
  if (seg[0] === 'import-exclude') {
    if (!user || user.role !== 'admin') return fail(res, 403, 'Sin acceso');
    if (method === 'GET') return ok(res, { ids: store.setting('importExclude') || [] });
    if (method === 'POST') {
      const body = await readBody(req);
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean);
      store.setSetting('importExclude', ids);
      store.audit(user.id, 'import-exclude');
      return ok(res, { ok: true, ids });
    }
  }

  // --- URL base de la app (para enlaces de email / magic links) ---
  if (seg[0] === 'app-url') {
    if (!user || user.role !== 'admin') return fail(res, 403, 'Sin acceso');
    if (method === 'GET') return ok(res, { appUrl: APP_URL() });
    if (method === 'PUT') {
      const body = await readBody(req);
      const u = String(body.url || '').trim().replace(/\/$/, '');
      store.setSetting('appUrl', u);
      store.audit(user.id, 'set-app-url');
      return ok(res, { ok: true, appUrl: u });
    }
  }

  // --- usuarios ---
  if (seg[0] === 'users') return usersApi(req, res, user, seg, method);

  // --- facturación / beneficios ---
  if (seg[0] === 'finance') return finance(req, res, user, seg, method);

  // --- contrato TyC (firma del cliente) ---
  if (seg[0] === 'tyc') return tycApi(req, res, user, seg, method);

  // --- avisos del panel de inicio (admin) ---
  if (['price-alerts', 'vacation-conflicts', 'itv-alerts', 'staff-conflicts', 'price-fix', 'dup-ack', 'salary-matrix'].includes(seg[0])) return dashboardAlerts(req, res, user, seg, method);

  // --- solicitudes de servicios extras (admin) ---
  if (seg[0] === 'extra-requests') return extraRequestsApi(req, res, user);

  // --- control horario (resúmenes) ---
  if (seg[0] === 'attendance-summary') return attendanceSummary(req, res, user, url);

  // --- archivos ---
  if (seg[0] === 'files') return filesApi(req, res, user, seg, method, url);

  // --- planos de montaje (imagen en disco + símbolos) ---
  if (seg[0] === 'planos') return planosApi(req, res, user, seg, method);

  // --- colecciones genéricas ---
  if (seg[0] === 'collections') return collection(req, res, user, seg, method);

  // --- correos de prueba (admin · Configuración avanzada) ---
  if (seg[0] === 'test-emails') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    if (method === 'POST') return testEmails(req, res, user);
    if (method === 'GET') return ok(res, lastTestRun || { running: false, results: [] });
  }

  // --- configuración del correo (admin · Configuración avanzada) ---
  if (seg[0] === 'mail-config') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    if (method === 'GET') {
      const c = store.setting('mailConfig') || {};
      // Nunca se devuelven las claves; solo si hay una guardada.
      return ok(res, { config: { host: c.host || '', port: c.port || 587, user: c.user || '', from: c.from || '', allowlist: c.allowlist || '', enabled: !!c.enabled, hasPass: !!c.pass, hasApiKey: !!c.apiKey }, enabledNow: mail.enabled() });
    }
    if (method === 'POST') {
      const b = await readBody(req);
      const cur = store.setting('mailConfig') || {};
      const next = {
        host: String(b.host || '').trim(),
        port: +b.port || 587,
        user: String(b.user || '').trim(),
        from: String(b.from || '').trim(),
        allowlist: String(b.allowlist || '').trim(),
        enabled: !!b.enabled,
        // Conserva las claves guardadas si el formulario las deja en blanco (no se reescriben).
        pass: (b.pass != null && b.pass !== '') ? b.pass : cur.pass,
        apiKey: (b.apiKey != null && b.apiKey !== '') ? String(b.apiKey).trim() : cur.apiKey,
      };
      store.setSetting('mailConfig', next);
      store.audit(user.id, 'mail-config-save');
      return ok(res, { ok: true, enabledNow: mail.enabled() });
    }
  }

  // --- configuración de Holded (admin · Configuración avanzada) ---
  if (seg[0] === 'holded-config') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    if (method === 'GET') {
      const c = holded.getConfig();
      // Nunca se devuelve la clave; solo si hay una guardada.
      return ok(res, { config: { enabled: !!c.enabled, hasApiKey: !!c.apiKey } });
    }
    if (method === 'POST') {
      const b = await readBody(req);
      const cur = holded.getConfig();
      const next = {
        enabled: !!b.enabled,
        // Conserva la clave guardada si el formulario la deja en blanco (no se reescribe).
        apiKey: (b.apiKey != null && b.apiKey !== '') ? String(b.apiKey).trim() : cur.apiKey,
      };
      store.setSetting('holdedConfig', next);
      store.audit(user.id, 'holded-config-save');
      return ok(res, { ok: true, hasApiKey: !!next.apiKey });
    }
  }
  // --- probar la conexión con Holded (admin) ---
  if (seg[0] === 'holded-test' && method === 'POST') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    try { const r = await holded.testConnection(); return ok(res, { ok: true, sample: r.sample }); }
    catch (e) { return ok(res, { ok: false, error: e.message }); }
  }
  // --- probar el acceso a NÓMINAS de Holded (admin · scope Contabilidad) ---
  if (seg[0] === 'holded-payslips-test' && (method === 'POST' || method === 'GET')) {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    try { const r = await holded.testPayslips(); return ok(res, r); }
    catch (e) { return ok(res, { ok: false, error: e.message }); }
  }
  // --- diagnóstico: buscar contacto/factura por texto (admin) ---
  if (seg[0] === 'holded-find' && method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    try { return ok(res, await holded.findByText(url.searchParams.get('q') || '')); }
    catch (e) { return ok(res, { ok: false, error: e.message }); }
  }
  // --- IMPAGOS: facturas con importe pendiente, con cliente, concepto y enlace a su boda (admin) ---
  if (seg[0] === 'holded-unpaid' && method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    if (!holded.enabled()) return ok(res, { enabled: false, invoices: [] });
    try {
      const list = await holded.allUnpaid(url.searchParams.get('refresh') === '1');
      const normE = s => String(s || '').trim().toLowerCase();
      const normN = s => String(s || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
      const normNm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const evByKey = {};
      store.all('events').forEach(e => {
        const ev = { id: e.id, conyuges: e.conyuges || '', fecha: e.fecha || '' };
        (e.spouses || []).forEach(s => { if (s) { if (s.email) evByKey['e:' + normE(s.email)] = ev; if (s.dni) evByKey['n:' + normN(s.dni)] = ev; if (s.name) evByKey['m:' + normNm(s.name)] = ev; } });
        const u = users.get(e.userId); if (u && u.email) evByKey['e:' + normE(u.email)] = ev;
      });
      const today = bizToday();
      const out = list.map(inv => {
        let evp = null;
        (inv.contactEmails || []).forEach(em => { if (!evp) evp = evByKey['e:' + normE(em)]; });
        if (!evp && inv.contactCode) evp = evByKey['n:' + normN(inv.contactCode)];
        if (!evp && inv.contactName) evp = evByKey['m:' + normNm(inv.contactName)];
        return Object.assign({}, inv, { event: evp || null, overdue: !!(inv.dueDate && inv.dueDate < today) });
      });
      return ok(res, { enabled: true, count: out.length, invoices: out });
    } catch (e) { return ok(res, { enabled: true, error: e.message, invoices: [] }); }
  }
  // --- CUADRE (admin): compara lo apuntado en cada evento (pagado / total cliente) con las facturas de Holded ---
  if (seg[0] === 'holded-cuadre' && method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    if (!holded.enabled()) return ok(res, { enabled: false, rows: [] });
    try {
      await holded.buildIndex(url.searchParams.get('refresh') === '1');
      const tol = 1; // tolerancia en € para ignorar redondeos
      const rows = [];
      let conFactura = 0;
      for (const ev of store.all('events')) {
        const emails = [], nifs = [], names = [];
        const u = users.get(ev.userId); if (u && u.email) emails.push(u.email);
        (ev.coUsers || []).forEach(id => { const c = users.get(id); if (c && c.email) emails.push(c.email); });
        (ev.spouses || []).forEach(s => { if (s) { if (s.email) emails.push(s.email); if (s.dni) nifs.push(s.dni); if (s.name) names.push(s.name); } });
        if (ev.conyuges) String(ev.conyuges).split(/\s+y\s+|&/i).forEach(n => { const t = n.trim(); if (t) names.push(t); });
        if (!emails.length && !nifs.length && !names.length) continue;
        const r = await holded.invoicesForClient({ emails, nifs, names }, false, { includeName: true });
        if (!r.invoices.length) continue;
        conFactura++;
        const t = r.invoices.reduce((a, i) => ({ total: a.total + i.total, paid: a.paid + i.paid, pending: a.pending + i.pending }), { total: 0, paid: 0, pending: 0 });
        const pagado = +ev.pagado || 0, pagoCliente = +ev.pagoCliente || 0;
        const dPaid = Math.round((t.paid - pagado) * 100) / 100;
        const dTotal = Math.round((t.total - pagoCliente) * 100) / 100;
        if (Math.abs(dPaid) > tol || Math.abs(dTotal) > tol) {
          rows.push({ id: ev.id, conyuges: ev.conyuges || '', fecha: ev.fecha || '', matchedBy: r.matchedBy, nInv: r.invoices.length,
            ev_pagado: pagado, hd_paid: Math.round(t.paid * 100) / 100, dPaid,
            ev_total: pagoCliente, hd_total: Math.round(t.total * 100) / 100, dTotal,
            hd_pending: Math.round(t.pending * 100) / 100 });
        }
      }
      rows.sort((a, b) => Math.abs(b.dPaid) - Math.abs(a.dPaid));
      return ok(res, { enabled: true, conFactura, descuadres: rows.length, tol, rows });
    } catch (e) { return ok(res, { enabled: true, error: e.message, rows: [] }); }
  }
  // --- COPIAS DE SEGURIDAD (admin): listar, crear al momento y descargar ---
  if (seg[0] === 'backups' && method === 'GET' && !seg[1]) {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    const items = backup.list();
    const totalSize = items.reduce((s, b) => s + b.size, 0);
    let cloud = { configured: false };
    try { cloud = await cloudBackup.statusAsync(); } catch (e) { cloud = { configured: cloudBackup.enabled(), reachError: e.message }; }
    return ok(res, { count: items.length, lastBackup: items[0] || null, totalSize, dir: backup.BACKUP_DIR, status: backup.status(), cloud, backups: items });
  }
  // --- COPIA EN LA NUBE (admin): configuración de Backblaze B2 (claves nunca se devuelven) ---
  if (seg[0] === 'cloud-backup-config') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    if (method === 'GET') {
      const c = store.setting('cloudBackup') || {};
      return ok(res, { config: { endpoint: c.endpoint || '', bucket: c.bucket || '', region: c.region || '', keyId: c.keyId || '', enabled: !!c.enabled, hasAppKey: !!c.appKey } });
    }
    if (method === 'POST') {
      const b = await readBody(req);
      const cur = store.setting('cloudBackup') || {};
      const next = {
        endpoint: String(b.endpoint || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
        bucket: String(b.bucket || '').trim(),
        region: String(b.region || '').trim(),
        keyId: String(b.keyId || '').trim(),
        enabled: !!b.enabled,
        // Conserva la clave guardada si el formulario la deja en blanco (no se reescribe).
        appKey: (b.appKey != null && b.appKey !== '') ? String(b.appKey).trim() : cur.appKey,
      };
      store.setSetting('cloudBackup', next);
      store.audit(user.id, 'cloud-backup-config-save');
      return ok(res, { ok: true, enabled: cloudBackup.enabled(), hasAppKey: !!next.appKey });
    }
  }
  // --- probar la copia en la nube (admin): sube y borra un objeto de prueba ---
  if (seg[0] === 'cloud-backup-test' && method === 'POST') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    try { await cloudBackup.test(); store.audit(user.id, 'cloud-backup-test'); return ok(res, { ok: true }); }
    catch (e) { return fail(res, 400, 'No se pudo conectar con la nube: ' + e.message); }
  }
  // --- subir ahora mismo la última copia a la nube (admin) ---
  if (seg[0] === 'cloud-backup-sync' && method === 'POST') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    if (!cloudBackup.enabled()) return fail(res, 400, 'La copia en la nube no está configurada o activada.');
    try {
      const r = backup.snapshot('manual');
      const p = backup.fileFor(r.name);
      await cloudBackup.uploadFile(p, cloudBackup.PREFIX + r.name);
      store.audit(user.id, 'cloud-backup-sync');
      return ok(res, { ok: true, name: r.name });
    } catch (e) { return fail(res, 400, 'No se pudo subir a la nube: ' + e.message); }
  }
  // --- subir ahora mismo los ARCHIVOS subidos (nóminas, planos, adjuntos…) a la nube (admin) ---
  if (seg[0] === 'cloud-backup-sync-files' && method === 'POST') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    if (!cloudBackup.enabled()) return fail(res, 400, 'La copia en la nube no está configurada o activada.');
    try { store.setSetting('filesBackupSig', ''); await cloudBackup.syncFiles(); store.audit(user.id, 'cloud-backup-sync-files'); return ok(res, { ok: true }); }
    catch (e) { return fail(res, 400, 'No se pudieron subir los archivos: ' + e.message); }
  }
  // --- LIBERAR ESPACIO: limpieza de adjuntos de bodas pasadas (admin). Config + vista previa + ejecutar ---
  if (seg[0] === 'attachment-cleanup') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    const curCfg = () => { const c = store.setting('attachmentCleanup') || {}; return { enabled: !!c.enabled, months: Math.min(60, Math.max(1, +c.months || 3)) }; };
    if (method === 'GET') { const cfg = curCfg(); return ok(res, { config: cfg, preview: cleanupPreview(cfg.months) }); }
    if (seg[1] === 'run' && method === 'POST') {
      const cfg = curCfg();
      try { const r = cleanupRun(cfg.months, user.id); return ok(res, { ok: true, result: r }); }
      catch (e) { return fail(res, 500, 'No se pudo limpiar: ' + e.message); }
    }
    if (method === 'POST') {
      const b = await readBody(req);
      const next = { enabled: !!b.enabled, months: Math.min(60, Math.max(1, +b.months || 3)) };
      store.setSetting('attachmentCleanup', next);
      store.audit(user.id, 'attachment-cleanup-config:' + (next.enabled ? 'on' : 'off') + '/' + next.months + 'm');
      return ok(res, { ok: true, config: next, preview: cleanupPreview(next.months) });
    }
  }
  // --- NÓMINAS QUE FALTAN (admin): huecos de meses entre la 1ª y la última nómina de cada trabajador.
  //     Lee de HOLDED (fuente real donde están subidas) y, si no hay, cae a las subidas en la intranet. ---
  if (seg[0] === 'payslip-gaps' && method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    const monthsBetween = (a, b) => { let [y, mo] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number); const out = []; while (y < by || (y === by && mo <= bm)) { out.push(y + '-' + String(mo).padStart(2, '0')); mo++; if (mo > 12) { mo = 1; y++; } } return out; };
    const monthOf = v => {
      if (v == null || v === '') return null;
      if (typeof v === 'number') { const d = new Date(v < 1e12 ? v * 1000 : v); return isNaN(d) ? null : d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
      const m = String(v).match(/(\d{4})-(\d{2})/); if (m) return m[1] + '-' + m[2];
      const d = new Date(v); return isNaN(d) ? null : d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    };
    const byUser = {}, nameOf = {};
    let source = 'intranet';
    try {
      if (holded.enabled()) {
        const items = await holded.listPayslips();
        items.forEach(it => {
          if (it.is_draft || it.isDraft || it.draft) return;                 // ignora borradores
          const eid = it.employee_id || it.employeeId || (it.employee && it.employee.id) || it.employee_name || it.employeeName;
          if (!eid) return;
          const mo = monthOf(it.period_start || it.periodStart || it.date || it.period_end || it.periodEnd);
          if (!mo) return;
          (byUser[eid] = byUser[eid] || new Set()).add(mo);
          nameOf[eid] = it.employee_name || it.employeeName || (it.employee && it.employee.name) || nameOf[eid] || String(eid);
        });
        if (Object.keys(byUser).length) source = 'holded';
      }
    } catch (e) { /* si Holded falla, se usa lo subido en la intranet */ }
    if (source !== 'holded') {
      const rows = db().prepare("SELECT record_id, description FROM files WHERE collection='payslip'").all();
      rows.forEach(r => { const m = String(r.description || '').match(/(\d{4})-(\d{2})/); if (!m) return; const k = 'u' + r.record_id; (byUser[k] = byUser[k] || new Set()).add(m[1] + '-' + m[2]); nameOf[k] = (users.get(+r.record_id) || {}).name || ('#' + r.record_id); });
    }
    // Iván es temporal (se le da de baja a fin de año y se le recontrata sobre marzo/abril),
    // así que sus huecos (ene-feb…) son normales y NO cuentan como nóminas que faltan.
    const SEASONAL = /iv[aá]n/i;
    const workers = [];
    Object.entries(byUser).forEach(([eid, set]) => {
      const nm = nameOf[eid] || String(eid);
      if (SEASONAL.test(nm)) return;
      const have = [...set].sort(); if (have.length < 2) return;
      const missing = monthsBetween(have[0], have[have.length - 1]).filter(m => !set.has(m));
      if (missing.length) workers.push({ name: nm, from: have[0], to: have[have.length - 1], have: have.length, missing });
    });
    workers.sort((a, b) => b.missing.length - a.missing.length || String(a.name).localeCompare(b.name));
    const totalMissing = workers.reduce((s, w) => s + w.missing.length, 0);
    if (url.searchParams.get('json') === '1') return ok(res, { source, count: workers.length, totalMissing, workers });
    // Página temporal, legible en el móvil, para ponerse al día. No está enlazada en ningún menú.
    const fmtM = s => { const p = String(s || '').split('-'); return p[1] ? p[1] + '/' + p[0] : s; };
    const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const srcTxt = source === 'holded' ? 'según Holded' : 'según las nóminas subidas a la intranet';
    const rowsHtml = workers.map(w => `<tr><td><b>${esc(w.name)}</b></td><td>${fmtM(w.from)} – ${fmtM(w.to)}</td><td style="text-align:center">${w.have}</td><td style="text-align:center;color:#b00020"><b>${w.missing.length}</b></td><td>${w.missing.map(fmtM).join(', ')}</td></tr>`).join('');
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nóminas que faltan</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;background:#f6f7f9;color:#1b2430}h1{font-size:20px;margin:0 0 4px}p.sub{color:#5a6472;margin:0 0 16px;font-size:14px}.k{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px}.card .n{font-size:22px;font-weight:700}.card .t{font-size:12px;color:#5a6472}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #eef0f3;font-size:14px;vertical-align:top}th{background:#f0f3f7;font-size:12px;text-transform:uppercase;letter-spacing:.3px;color:#5a6472}tr:last-child td{border-bottom:none}.empty{padding:24px;text-align:center;color:#5a6472}</style></head>
<body><h1>Nóminas que faltan</h1><p class="sub">Meses sin nómina entre la primera y la última de cada trabajador (${srcTxt}). Para reclamar al gestor o al administrativo. Iván queda excluido (es temporal, sus huecos son normales).</p>
<div class="k"><div class="card"><div class="n">${workers.length}</div><div class="t">Trabajadores con huecos</div></div><div class="card"><div class="n">${totalMissing}</div><div class="t">Nóminas que faltan</div></div></div>
${workers.length ? `<table><thead><tr><th>Trabajador</th><th>Periodo</th><th style="text-align:center">Tiene</th><th style="text-align:center">Faltan</th><th>Meses que faltan</th></tr></thead><tbody>${rowsHtml}</tbody></table>` : '<div class="card empty">No se detectan huecos. 🎉</div>'}
<p class="sub" style="margin-top:16px">Fuente: ${srcTxt}. Página temporal (no guardada en el menú).</p></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  // --- SINCRONIZAR NÓMINAS DESDE HOLDED a la intranet (admin, temporal). Dry-run por defecto; ?go=1 descarga de verdad. ---
  if (seg[0] === 'holded-payslip-sync' && method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    if (!holded.enabled()) return fail(res, 400, 'Holded no está activado.');
    const go = url.searchParams.get('go') === '1';
    const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const monthOf = v => { if (v == null || v === '') return null; if (typeof v === 'number') { const d = new Date(v < 1e12 ? v * 1000 : v); return isNaN(d) ? null : d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); } const m = String(v).match(/(\d{4})-(\d{2})/); if (m) return m[1] + '-' + m[2]; const d = new Date(v); return isNaN(d) ? null : d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
    const workers = users.all().filter(u => u.name && ['dj', 'admin', 'planner'].includes(u.role));
    const byNorm = {}; workers.forEach(u => { byNorm[norm(u.name)] = u; });
    // Equivalencias manuales Holded (nombre legal) → trabajador de la intranet (nombre artístico).
    // Se prueban sobre el nombre normalizado (sin acentos/mayúsculas). Se van ampliando según vayan saliendo.
    const NAME_MAP = [
      { holded: /adrian\s+fernandez\s+martinez/, intranet: /adri.*(deejay|dj)/ },
    ];
    const matchUser = name => {
      const n = norm(name); if (!n) return null;
      for (const map of NAME_MAP) { if (map.holded.test(n)) { const w = workers.find(u => map.intranet.test(norm(u.name))); if (w) return w; } }
      if (byNorm[n]) return byNorm[n];
      const nt = n.split(' ').filter(Boolean); if (nt.length < 2) return null;
      let best = null; workers.forEach(u => { const ut = norm(u.name).split(' ').filter(Boolean); if (ut.length < 2) return; const aInB = nt.every(t => ut.includes(t)); const bInA = ut.every(t => nt.includes(t)); if ((aInB || bInA) && !best) best = u; }); return best;
    };
    let items = []; try { items = await holded.listPayslips(); } catch (e) { return fail(res, 502, 'No se pudieron leer las nóminas de Holded: ' + e.message); }
    const existsStmt = db().prepare("SELECT COUNT(*) c FROM files WHERE collection='payslip' AND record_id=? AND description LIKE ?");
    const insStmt = db().prepare('INSERT INTO files (id, collection, record_id, name, description, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const matched = {}, unmatched = {}; let willSync = 0, skipped = 0, done = 0; const errors = [];
    for (const it of items) {
      if (it.is_draft || it.isDraft || it.draft) continue;
      const ename = it.employee_name || it.employeeName || (it.employee && it.employee.name) || '(sin nombre)';
      const period = monthOf(it.period_start || it.periodStart || it.date || it.period_end || it.periodEnd);
      if (!period) continue;
      const u = matchUser(ename);
      if (!u) { (unmatched[ename] = unmatched[ename] || new Set()).add(period); continue; }
      const key = u.name; const M = matched[key] = matched[key] || { uid: u.id, holdedName: ename, months: new Set(), toSync: 0, skip: 0 };
      M.months.add(period);
      if (existsStmt.get(u.id, period + '%').c > 0) { skipped++; M.skip++; continue; }
      if (!go) { willSync++; M.toSync++; continue; }
      try {
        const buf = await holded.getPayslipPdf(it.id);
        const fname = 'Nomina ' + period + '.pdf';
        const fid = crypto.randomBytes(12).toString('hex');
        const dir = payslipDir(u.id, period); fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, fid + '-' + safeName(fname)), buf);
        insStmt.run(fid, 'payslip', u.id, fname, period, 'application/pdf', buf.length, user.id);
        done++; M.toSync++;
      } catch (e) { errors.push(ename + ' ' + period + ': ' + String(e.message).slice(0, 120)); }
    }
    store.audit(user.id, go ? 'holded-payslip-sync' : 'holded-payslip-sync-dryrun');
    const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const mRows = Object.keys(matched).sort().map(k => { const M = matched[k]; return `<tr><td><b>${esc(k)}</b>${norm(k) !== norm(M.holdedName) ? `<br><span style="color:#5a6472;font-size:12px">Holded: ${esc(M.holdedName)}</span>` : ''}</td><td style="text-align:center">${M.months.size}</td><td style="text-align:center;color:#1B5E20">${M.toSync}</td><td style="text-align:center;color:#5a6472">${M.skip}</td></tr>`; }).join('');
    const uRows = Object.keys(unmatched).sort().map(n => `<tr><td><b>${esc(n)}</b></td><td>${[...unmatched[n]].sort().length} nóminas</td></tr>`).join('');
    const totalHolded = items.length;
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sincronizar nóminas de Holded</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;background:#f6f7f9;color:#1b2430}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 8px}p.sub{color:#5a6472;margin:0 0 12px;font-size:14px}.k{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px}.card .n{font-size:22px;font-weight:700}.card .t{font-size:12px;color:#5a6472}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;margin-bottom:8px}th,td{padding:9px 12px;text-align:left;border-bottom:1px solid #eef0f3;font-size:14px}th{background:#f0f3f7;font-size:12px;text-transform:uppercase;color:#5a6472}tr:last-child td{border-bottom:none}.btn{display:inline-block;background:#E82C88;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;margin-top:8px}.warn{background:#FFF8E1;border:1px solid #FFE49A;color:#8a6d00;border-radius:10px;padding:12px 14px;margin-bottom:12px;font-size:14px}.ok{background:#E8F5E9;border:1px solid #BEE3C2;color:#1B5E20;border-radius:10px;padding:12px 14px;margin-bottom:12px;font-size:14px}</style></head>
<body><h1>Sincronizar nóminas de Holded → intranet</h1>
<p class="sub">${go ? 'Descarga REALIZADA.' : 'Modo PRUEBA (no se ha descargado nada todavía).'} Nóminas leídas de Holded: ${totalHolded}.</p>
${go ? `<div class="ok"><b>✅ Descargadas ${done} nóminas</b> a la intranet.${skipped ? ' ' + skipped + ' ya estaban.' : ''}${errors.length ? ' ' + errors.length + ' con error.' : ''}</div>` : `<div class="warn"><b>Esto es una prueba.</b> Revisa abajo que los nombres cuadran. Si está bien, pulsa el botón del final para descargar de verdad.</div>`}
<div class="k"><div class="card"><div class="n">${Object.keys(matched).length}</div><div class="t">Trabajadores reconocidos</div></div><div class="card"><div class="n">${go ? done : willSync}</div><div class="t">${go ? 'Descargadas' : 'Se descargarían'}</div></div><div class="card"><div class="n">${skipped}</div><div class="t">Ya estaban</div></div><div class="card"><div class="n">${Object.keys(unmatched).length}</div><div class="t">Sin reconocer</div></div></div>
<h2>✅ Reconocidos</h2>
${mRows ? `<table><thead><tr><th>Trabajador (intranet)</th><th style="text-align:center">Nóminas en Holded</th><th style="text-align:center">${go ? 'Descargadas' : 'A descargar'}</th><th style="text-align:center">Ya estaban</th></tr></thead><tbody>${mRows}</tbody></table>` : '<div class="card">Ninguno reconocido automáticamente.</div>'}
${Object.keys(unmatched).length ? `<h2>⚠️ Sin reconocer (nombre de Holded que no cuadra con ningún trabajador)</h2><p class="sub">Estos no se tocan. Si alguno es un trabajador tuyo con otro nombre, dímelo y lo enlazo a mano.</p><table><thead><tr><th>Nombre en Holded</th><th>Nóminas</th></tr></thead><tbody>${uRows}</tbody></table>` : ''}
${errors.length ? `<h2>Errores</h2><table><tbody>${errors.map(e => `<tr><td>${esc(e)}</td></tr>`).join('')}</tbody></table>` : ''}
${(!go && willSync) ? `<a class="btn" href="/api/holded-payslip-sync?go=1">⬇ Descargar de verdad las ${willSync} nóminas reconocidas</a>` : ''}
<h2>Trabajadores de la intranet</h2><p class="sub">Para que me digas los emparejamientos tal cual están escritos aquí.</p>
<div class="card">${workers.map(u => esc(u.name)).sort().join(' · ')}</div>
<p class="sub" style="margin-top:16px">Página temporal (no guardada en el menú).</p></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  if (seg[0] === 'backups' && seg[1] === 'create' && method === 'POST') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    try { const r = backup.snapshot('manual'); store.audit(user.id, 'backup-create'); return ok(res, { ok: true, backup: r }); }
    catch (e) { return fail(res, 500, 'No se pudo crear la copia: ' + e.message); }
  }
  if (seg[0] === 'backups' && seg[1] === 'download' && method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    const p = backup.fileFor(url.searchParams.get('name'));
    if (!p) return fail(res, 404, 'Copia no encontrada.');
    const stat = fs.statSync(p);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(p)}"`, 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(p).pipe(res);
    return;
  }
  // --- DESCUADRES facturas/eventos (admin): facturas de Holded SIN vincular a un evento + descuadres de importe ---
  if (seg[0] === 'holded-descuadres' && method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    if (!holded.enabled()) return ok(res, { enabled: false, sinVincular: [], descuadres: [] });
    try {
      const idx = await holded.buildIndex(url.searchParams.get('refresh') === '1');
      const normE = s => String(s || '').trim().toLowerCase();
      const normN = s => String(s || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
      const normNm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      // Mapa de claves de evento -> evento (por email/DNI/nombre de cónyuges y email del titular).
      const evByKey = {};
      store.all('events').forEach(e => {
        const ev = { id: e.id, conyuges: e.conyuges || '', fecha: e.fecha || '' };
        (e.spouses || []).forEach(s => { if (s) { if (s.email) evByKey['e:' + normE(s.email)] = ev; if (s.dni) evByKey['n:' + normN(s.dni)] = ev; if (s.name) evByKey['m:' + normNm(s.name)] = ev; } });
        const u = users.get(e.userId); if (u && u.email) evByKey['e:' + normE(u.email)] = ev;
      });
      // Facturas a EMPRESAS/FINCAS: es NORMAL que no tengan evento, así que se excluyen.
      // Se detecta empresa por el CIF (empieza por letra) o por el nombre (termina en SL/SA/… o
      // contiene palabras de negocio: hotel, restaurant, masía, catering, sociedad, etc.).
      const CIF = s => /^[A-W]\d{7}[0-9A-J]$/.test(normN(s));
      const COMPANY_NAME = /(,?\s*s\.?\s?[laup]\.?\s?[un]?\.?|s\.?\s?c\.?\s?p?\.?|c\.?\s?b\.?|\bcoop)\s*$/i;
      const VENUE_NAME = /\b(hotel|restaurant|masia|mas |colonies|colonias|ajuntament|catering|gastronom|finca|celler|castell|hospitality|sinso|edelweiss|broquetas|boella|nou coberts|vents)/i;
      const isCompany = c => CIF(c.code) || CIF(c.vat_number) || COMPANY_NAME.test(c.name || '') || VENUE_NAME.test(c.name || '');
      const sinVincular = []; let totalInv = 0, linkedInv = 0, empresaInv = 0;
      Object.values(idx.byId).forEach(c => {
        let ev = null;
        (c.emails || []).forEach(em => { if (!ev) ev = evByKey['e:' + normE(em)]; });
        if (!ev && c.code) ev = evByKey['n:' + normN(c.code)];
        if (!ev && c.vat_number) ev = evByKey['n:' + normN(c.vat_number)];
        if (!ev && c.name) ev = evByKey['m:' + normNm(c.name)];
        const company = isCompany(c);
        (c.invoices || []).forEach(raw => {
          totalInv++;
          if (ev) { linkedInv++; return; }
          if (company) { empresaInv++; return; }              // factura a empresa/finca: no es un descuadre
          const inv = holded.mapInvoice(raw);
          sinVincular.push({ number: inv.number, date: inv.date, total: inv.total, paid: inv.paid, pending: inv.pending, status: inv.status, contact: c.name || '', code: c.code || c.vat_number || '', invId: inv.id });
        });
      });
      sinVincular.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return ok(res, { enabled: true, totalInv, linkedInv, empresaInv, sinVincularN: sinVincular.length, sinVincular });
    } catch (e) { return ok(res, { enabled: true, error: e.message, sinVincular: [] }); }
  }
  // --- ANÁLISIS (admin): ventas por masía/pack, horas extra por masía/DJ, facturación masías y económico ---
  if (seg[0] === 'analisis' && method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Sin acceso');
    const OT = { 'sin horas extra': 0, 'media hora': 0.5, '1 hora': 1, '1 hora y media': 1.5, '2 horas': 2, '2 hora y media': 2.5, '3 horas': 3, '3 hora y media': 3.5, '4 horas': 4, '4 hora y media': 4.5, '5 horas': 5 };
    const otH = s => OT[String(s || '').trim().toLowerCase()] || 0;
    const locName = id => (store.get('locations', id) || {}).name || '';
    // Agrupa las fincas que son la misma masía con varios espacios (Can Oliver 200/400/Carpa/Rústico,
    // Can Ribas Cirerers/Exclusivo/Oliveres, etc.) en un único nombre de masía.
    const vnorm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const prefixGroup = s => { if (/can\s*oliver/i.test(s)) return 'Can Oliver'; if (/can\s*ribas/i.test(s)) return 'Can Ribas'; if (/mas\s*bad[oó]/i.test(s)) return 'Mas Badó'; return null; };
    const rawVenue = e => locName(e.lugar) || e.lugarOtro || '';
    // Clave de agrupación: grupo de prefijo (Can Oliver/Ribas…) o nombre normalizado (sin acentos/
    // mayúsculas), para que "Masia Piguillem", "Masia piguillem" y "Masía Piguillem" sean la misma.
    const vkey = s => { const g = prefixGroup(s); return g ? ('G:' + g) : (vnorm(s) || 'otros'); };
    const allEv = store.all('events');
    // Nombre a mostrar por clave: finca oficial si existe; si no, la grafía más frecuente.
    const spellCount = {};
    allEv.forEach(e => { const raw = rawVenue(e).trim(); if (!raw) return; const k = vkey(raw); (spellCount[k] = spellCount[k] || {})[raw] = (spellCount[k][raw] || 0) + 1; });
    const officialByKey = {}; store.all('locations').forEach(l => { if (l.name) { const k = vkey(l.name); if (!officialByKey[k]) officialByKey[k] = prefixGroup(l.name) || l.name.trim(); } });
    const displayByKey = {};
    Object.keys(spellCount).forEach(k => {
      if (k.indexOf('G:') === 0) { displayByKey[k] = k.slice(2); return; }
      if (officialByKey[k]) { displayByKey[k] = officialByKey[k]; return; }
      const sp = spellCount[k]; displayByKey[k] = Object.keys(sp).sort((a, b) => sp[b] - sp[a])[0];
    });
    const masiaOf = e => { const raw = rawVenue(e).trim(); if (!raw) return 'Otros'; return displayByKey[vkey(raw)] || raw || 'Otros'; };
    const realized = allEv.filter(e => evFinished(e));
    // Ventas por masía/pack: TODAS las bodas (pasadas y futuras ya previstas), no solo las realizadas.
    const ventasMasia = {}, ventasPack = {}, years = new Set();
    allEv.forEach(e => {
      const y = (e.fecha || '').slice(0, 4); if (!y) return; years.add(y);
      const m = masiaOf(e); (ventasMasia[m] = ventasMasia[m] || {})[y] = (ventasMasia[m][y] || 0) + 1;
      const p = e.tipo || '—'; (ventasPack[p] = ventasPack[p] || {})[y] = (ventasPack[p][y] || 0) + 1;
    });
    const heM = {};
    realized.forEach(e => { const h = otH(e.djOvertime); const m = masiaOf(e); const x = heM[m] = heM[m] || { h: 0, ev: 0 }; x.h += h; x.ev++; });
    const horasMasia = Object.entries(heM).map(([m, x]) => ({ masia: m, horas: Math.round(x.h * 10) / 10, eventos: x.ev, media: x.ev ? Math.round(x.h / x.ev * 100) / 100 : 0 })).filter(r => r.horas >= 3).sort((a, b) => b.horas - a.horas);
    // Horas extra por masía desglosadas por año, desde 2025.
    const heMY = {}, heYears = new Set();
    realized.forEach(e => { const y = (e.fecha || '').slice(0, 4); if (!y || y < '2025') return; heYears.add(y); const h = otH(e.djOvertime); const m = masiaOf(e); ((heMY[m] = heMY[m] || {})[y] = (heMY[m][y] || 0) + h); });
    const horasYears = [...heYears].sort();
    const horasMasiaYear = Object.entries(heMY).map(([masia, by]) => {
      const byYear = {}; let total = 0;
      horasYears.forEach(y => { const v = Math.round((by[y] || 0) * 10) / 10; byYear[y] = v; total += v; });
      return { masia, byYear, total: Math.round(total * 10) / 10 };
    }).filter(r => r.total >= 3).sort((a, b) => b.total - a.total);
    const heD = {};
    realized.forEach(e => { if (!e.djId) return; const h = otH(e.djOvertime); const x = heD[e.djId] = heD[e.djId] || { h: 0, n: 0 }; x.h += h; x.n++; });
    const horasDj = Object.entries(heD).map(([id, x]) => ({ dj: (users.get(+id) || {}).name || ('#' + id), horas: Math.round(x.h * 10) / 10, bodas: x.n, media: x.n ? Math.round(x.h / x.n * 100) / 100 : 0 })).filter(d => d.horas > 0);
    const djPorTotal = horasDj.slice().sort((a, b) => b.horas - a.horas);
    const djPorBoda = horasDj.slice().filter(d => d.bodas >= 3).sort((a, b) => b.media - a.media);
    // Wedding planners con los que más trabajamos. Excluimos los "de la casa"/finca: UAUU (Castell de
    // Tous + Mas Vivencs), Edelweiss, Can Ribas y Mas la Boaella.
    const EXCL_WP = /uauu|edelwe|can\s*ribas|boaella|bodas\s*rv|can\s*cuch|dalmau/i;
    // Varios planners pueden ser la MISMA empresa: se agrupan en un único trozo del quesito.
    // Entretornos (Patricia, Ana, Claudia…) cuentan juntas.
    const wpGroup = nm => /entre\s*tonos|entretornos/i.test(nm) ? 'Entretonos Pastel' : nm;
    const wpCnt = {};
    allEv.forEach(e => { if (!e.wpId) return; const nm = (users.get(+e.wpId) || {}).name || ''; if (!nm || EXCL_WP.test(nm)) return; const g = wpGroup(nm); wpCnt[g] = (wpCnt[g] || 0) + 1; });
    const plannersTop = Object.entries(wpCnt).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);

    // --- EXTRAS: se cuentan por SERVICIOS asignados (lo que manda), NO por la pestaña de extras,
    //     porque muchas veces el servicio se hace pero no se marca en extras. Si el servicio está, cuenta. ---
    const isWedPack = p => /recomendad|fiesta|bodorri|tinglado/i.test(p || '');
    const weddings = allEv.filter(e => isWedPack(e.tipo));
    const svcCat = {}; store.all('extras').forEach(x => { if (x && x.id != null) svcCat[x.id] = x.name || ('Servicio ' + x.id); });
    const svcCnt = {};
    weddings.forEach(e => { const seen = new Set(); (e.services || []).forEach(s => { const id = s && s.servicio; if (id == null || id === '' || seen.has(id)) return; seen.add(id); svcCnt[id] = (svcCnt[id] || 0) + 1; }); });
    const extrasTotalBodas = weddings.length;
    const extrasTop = Object.entries(svcCnt).map(([id, n]) => ({ label: svcCat[id] || ('Servicio ' + id), n, pct: extrasTotalBodas ? Math.round(n / extrasTotalBodas * 1000) / 10 : 0 })).sort((a, b) => b.n - a.n);

    // --- Bodas por técnico (DJ) y año ---
    const bodasDj = {};
    weddings.forEach(e => { if (!e.djId) return; const y = (e.fecha || '').slice(0, 4); if (!y) return; const nm = (users.get(+e.djId) || {}).name || ('#' + e.djId); (bodasDj[nm] = bodasDj[nm] || {})[y] = (bodasDj[nm][y] || 0) + 1; });

    // --- Día de la semana (viernes / sábado / domingo / entre semana L-J), por año ---
    const dowCat = f => { const d = String(f || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null; const wd = new Date(d + 'T12:00:00Z').getUTCDay(); return wd === 5 ? 'Viernes' : wd === 6 ? 'Sábado' : wd === 0 ? 'Domingo' : 'Entre semana (L-J)'; };
    const bodasDow = {};
    weddings.forEach(e => { const c = dowCat(e.fecha); const y = (e.fecha || '').slice(0, 4); if (!c || !y) return; (bodasDow[c] = bodasDow[c] || {})[y] = (bodasDow[c][y] || 0) + 1; });

    // --- Cuánto cobra cada DJ por HORAS EXTRA al año (horas × tarifa HE según finca o pack, mismo criterio que facturación) ---
    const djRates = store.setting('djRates') || {};
    const packKeyHe = tipo => { const mm = { Fiesta: 'fiesta', Bodorrio: 'bodorrio', Tinglado: 'tinglado' }; const k = mm[tipo]; return k ? k + '_he' : null; };
    const heEarnDj = {};
    realized.forEach(e => {
      const h = otH(e.djOvertime); if (!h || !e.djId) return;
      const dj = String(e.djId); if (dj === '227') return;             // Adrià (dueño): no cobra base/HE como trabajador
      const r = djRates[dj]; let he = null;
      if (r) { const fr = r.fincas && r.fincas[e.lugar]; if (fr && fr.he != null) he = fr.he; else { const pk = packKeyHe(e.tipo); if (pk && r.packs && r.packs[pk] != null) he = r.packs[pk]; } }
      if (he == null) { const loc = store.get('locations', e.lugar); if (loc && loc.extraPrice != null && loc.extraPrice !== '') he = parseFloat(loc.extraPrice) || 0; }
      const amt = h * (+he || 0); if (!amt) return;
      const y = (e.fecha || '').slice(0, 4); if (!y) return;
      const nm = (users.get(+e.djId) || {}).name || ('#' + e.djId);
      (heEarnDj[nm] = heEarnDj[nm] || {})[y] = Math.round(((heEarnDj[nm] || {})[y] || 0) + amt);
    });

    const out = { years: [...years].sort(), ventasMasia, ventasPack, horasMasia, horasMasiaYear, horasYears, djPorTotal, djPorBoda, plannersTop, extrasTop, extrasTotalBodas, bodasDj, bodasDow, heEarnDj };
    if (holded.enabled()) {
      try {
        const idx = await holded.buildIndex(url.searchParams.get('refresh') === '1');
        const GROUPS = [
          { name: 'Can Ribas', codes: ['B59998286'] },
          { name: 'Mas Llombart', codes: ['B67342568'] }, // SINSOFOOD 1996 S.L.
          { name: 'Hotel Edelweiss', codes: ['B55215800'] },
          { name: 'Rosa dels Vents / Broquetas', codes: ['B82573338'] }, // RV Hotels (Mas Badó, Broquetas)
          { name: 'Mas Can Ferrer', codes: ['J55059406'] },
          { name: 'Can Oliver', codes: ['B08758468'] },
          { name: 'Carol Gastronomía', codes: ['B66216946'] },
          { name: 'Ajuntament de Sant Fost', codes: ['P0820800A'] },
          { name: 'Mas Corts', codes: ['B66001959'] }, // Grup Nou Coberts, S.L.
          { name: 'Mas la Boella', codes: ['B08231581'] }, // La Siesta Hospitality SL
        ];
        const nz = s => String(s || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
        const codeToGroup = {}; GROUPS.forEach(g => g.codes.forEach(c => codeToGroup[nz(c)] = g.name));
        const masiaMensual = {}, masiaAnual = {};
        GROUPS.forEach(g => { masiaMensual[g.name] = {}; masiaAnual[g.name] = {}; });
        Object.values(idx.byId).forEach(c => {
          const g = codeToGroup[nz(c.code)]; if (!g) return;
          (c.invoices || []).forEach(inv => { const m = holded.mapInvoice(inv); const mm = (m.date || '').slice(0, 7), yy = (m.date || '').slice(0, 4); if (!mm) return; masiaMensual[g][mm] = (masiaMensual[g][mm] || 0) + m.total; masiaAnual[g][yy] = (masiaAnual[g][yy] || 0) + m.total; });
        });
        const bodasMes = {}; realized.forEach(e => { const mm = (e.fecha || '').slice(0, 7); if (mm) bodasMes[mm] = (bodasMes[mm] || 0) + 1; });
        const factMes = {}; GROUPS.forEach(g => Object.entries(masiaMensual[g.name]).forEach(([mm, v]) => factMes[mm] = (factMes[mm] || 0) + v));
        const economico = Object.keys(factMes).sort().map(mm => ({ mes: mm, facturado: Math.round(factMes[mm]), bodas: bodasMes[mm] || 0, media: bodasMes[mm] ? Math.round(factMes[mm] / bodasMes[mm]) : 0 }));
        Object.keys(masiaMensual).forEach(g => { const o = {}; Object.keys(masiaMensual[g]).forEach(mm => o[mm] = Math.round(masiaMensual[g][mm])); masiaMensual[g] = o; });
        Object.keys(masiaAnual).forEach(g => { const o = {}; Object.keys(masiaAnual[g]).forEach(yy => o[yy] = Math.round(masiaAnual[g][yy])); masiaAnual[g] = o; });
        Object.assign(out, { masiaMensual, masiaAnual, economico, holdedOk: true });
      } catch (e) { out.holdedError = e.message; }
    }
    return ok(res, out);
  }
  // --- furgonetas ocupadas en una fecha (para avisar de conflicto al asignar) ---
  if (seg[0] === 'vehicle-usage' && method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Sin acceso');
    const date = url.searchParams.get('date'); const exclude = +url.searchParams.get('exclude') || 0;
    const used = {};
    if (date) store.all('events').forEach(e => {
      if (e.fecha === date && e.vehicleId && +e.id !== exclude) {
        used[e.vehicleId] = { eventId: e.id, conyuges: e.conyuges || '', lugar: (store.get('locations', e.lugar) || {}).name || e.lugarOtro || '' };
      }
    });
    return ok(res, { date, used });
  }
  // --- PDF de cualquier factura de Holded (admin, para el apartado de impagos) ---
  if (seg[0] === 'holded-pdf' && method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    const invId = url.searchParams.get('inv'); if (!invId) return fail(res, 400, 'Falta la factura.');
    try {
      const buf = await holded.getInvoicePdf(invId);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="factura-${invId}.pdf"`, 'Content-Length': buf.length });
      return res.end(buf);
    } catch (e) { return fail(res, 502, 'No se pudo obtener el PDF: ' + e.message); }
  }
  // --- diagnóstico: muestra de FACTURAS de Holded para entender su forma (admin) ---
  if (seg[0] === 'holded-invoices-test' && (method === 'POST' || method === 'GET')) {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    try {
      const cpage = await holded.apiGet('/contacts?limit=3');
      const citems = (cpage && cpage.items) || [];
      const cFirst = citems[0] || null;
      const cSample = citems.map(c => ({ id: c.id, name: c.name, email: c.email, emails: c.emails, phone: c.phone, code: c.code, nif: c.nif || c.vat_number || c.tax_id }));
      return ok(res, { ok: true, contactKeys: cFirst ? Object.keys(cFirst) : [], contactsSample: cSample });
    } catch (e) { return ok(res, { ok: false, error: e.message }); }
  }

  // --- recolocación de momentos personalizados en su sección real (admin) ---
  // El volcado perdió la sección de los momentos personalizados (todos quedaron como
  // 'ceremony'). Estos dos endpoints permiten recuperarla leyendo la intranet original:
  //   GET  optionals-dump       -> eventos que tienen momentos personalizados (id + sec/area/order)
  //   POST optionals-resection  -> aplica {mappings:{eventId:{optId:{sec,order}}}}
  if (seg[0] === 'optionals-dump' && method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    const out = [];
    store.all('events').forEach(e => {
      const opts = e.optionals || [];
      if (opts.length) out.push({ id: e.id, optionals: opts.map(o => ({ id: o.id, sec: o.sec || '', area: o.area || '', order: o.order || '' })) });
    });
    return ok(res, { events: out });
  }
  if (seg[0] === 'optionals-resection' && method === 'POST') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    const body = await readBody(req);
    const map = body.mappings || {};
    const AREA = { C: 'ceremony', A: 'aperitif', B: 'banquet', D: 'disco' };
    let evN = 0, optN = 0;
    Object.keys(map).forEach(eid => {
      const ev = store.get('events', +eid);
      if (!ev || !Array.isArray(ev.optionals)) return;
      let changed = false;
      ev.optionals.forEach(o => {
        const m = map[eid][String(o.id)];
        if (!m) return;
        if (m.sec && AREA[m.sec]) { o.sec = m.sec; o.area = AREA[m.sec]; }
        if (m.order != null && m.order !== '') o.order = String(m.order);
        changed = true; optN++;
      });
      if (changed) { store.put('events', ev); evN++; }
    });
    store.audit(user.id, 'optionals-resection');
    return ok(res, { ok: true, events: evN, optionals: optN });
  }

  return fail(res, 404, 'Ruta no encontrada');
}

// Envía a UNA dirección una muestra de cada correo de la intranet, con datos de ejemplo.
// No crea usuarios ni toca eventos: solo manda emails (pensado para revisarlos en la bandeja de pruebas).
async function testEmails(req, res, user) {
  if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
  if (!mail.enabled()) return fail(res, 400, 'El correo no está activo todavía. Actívalo en el servidor (MAIL_DISABLED=false + SMTP) para poder enviar pruebas.');
  const body = await readBody(req).catch(() => ({}));
  const to = String((body && body.to) || user.email || '').trim();
  if (!to || to.indexOf('@') < 0) return fail(res, 400, 'Indica un email de destino válido.');
  const base = APP_URL();
  const link = (base || '') + '/#/activar?token=DEMO-TOKEN';
  const resetLink = (base || '') + '/#/activar?token=DEMO-TOKEN';
  const evLink = (base || '') + '/#/eventos/0';
  const demoMagic = (base || '') + '/#/albaran?token=DEMO-TOKEN&ev=0';   // autologin de ejemplo
  const ev = { id: 0, conyuges: 'Laura & Marc (prueba)', fecha: '2026-11-08', lugar: 0, hora: '17:30' };
  const uUser = { name: 'Laura & Marc', email: to, role: 'user' };
  const uPlanner = { name: 'Wedding Planner (prueba)', email: to, role: 'planner' };
  const uDj = { name: 'Carlos (DJ, prueba)', email: to, role: 'dj' };
  const uAdmin = { name: 'Administración (prueba)', email: to, role: 'admin' };
  const jobs = [
    ['Alta · novios', () => emails.inviteEmail(uUser, link, base)],
    ['Alta · wedding planner', () => emails.inviteEmail(uPlanner, link, base)],
    ['Alta · DJ', () => emails.inviteEmail(uDj, link, base)],
    ['Alta · administración', () => emails.inviteEmail(uAdmin, link, base)],
    ['Restablecer contraseña', () => emails.resetEmail(uUser, resetLink, base)],
    ['Recordatorio 15 días', () => emails.coupleReminderEmail(ev, demoMagic, base)],
    ['Recordatorio 7 días (música)', () => emails.coupleMusicEmail(ev, demoMagic, base)],
    ['Parte del DJ (boda finalizada)', () => emails.djAlbaranEmail(uDj, ev, demoMagic, base)],
    ['Aviso de solicitud de extra', () => emails.extraRequestEmail(ev, ['Máquina de humo', 'Sparklers / chispas frías'], 'Can Oliver Carpa', demoMagic, base)],
  ];

  // El proveedor de correo suele limitar los correos por segundo. Se envían ESPACIADOS y
  // EN SEGUNDO PLANO, con REINTENTOS si el proveedor frena ("too many per second").
  // El progreso se guarda en lastTestRun para que la pantalla lo muestre en vivo (GET).
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const GAP = +(process.env.TEST_MAIL_GAP_MS || 6000);
  // Reintenta solo errores transitorios (límite por segundo), NO cupo agotado / cuenta.
  const retryable = msg => { msg = String(msg || ''); return /too many|per second|rate limit|\b421\b|timeout|tiempo de espera/i.test(msg) && !/limit is reached|upgrade|quota|\b535\b/i.test(msg); };
  lastTestRun = { to, total: jobs.length, startedAt: Date.now(), running: true, results: jobs.map(j => ({ label: j[0], status: 'pendiente' })) };
  const run = lastTestRun;
  store.audit(user.id, 'test-emails');

  (async () => {
    for (let i = 0; i < jobs.length; i++) {
      if (i > 0) await sleep(GAP);
      const [label, build] = jobs[i];
      run.results[i].status = 'enviando';
      let sent = false, lastErr = '';
      for (let t = 1; t <= 4 && !sent; t++) {
        try { const em = build(); await mail.sendMail({ to, subject: '[PRUEBA] ' + em.subject, text: em.text, html: em.html }); sent = true; }
        catch (e) { lastErr = e.message || 'error'; if (t < 4 && retryable(lastErr)) await sleep(GAP * t); else break; }
      }
      run.results[i].status = sent ? 'ok' : 'error';
      if (!sent) run.results[i].error = lastErr;
      console.log('[correo-prueba]', sent ? '✓' : '✗', label, sent ? '' : '- ' + lastErr);
    }
    run.running = false; run.finishedAt = Date.now();
    console.log('[correo-prueba] terminado →', to, '·', run.results.filter(r => r.status === 'ok').length + '/' + run.total);
  })();

  const etaSeconds = Math.round((jobs.length - 1) * GAP / 1000);
  return ok(res, { to, count: jobs.length, etaSeconds });
}
// Estado del último envío de prueba (para que la pantalla muestre el progreso en vivo).
let lastTestRun = null;

/* ---------- login / cuenta ---------- */
async function login(req, res) {
  const ip = auth.clientIp(req);
  if (auth.rateLimited('login:' + ip)) return fail(res, 429, 'Demasiados intentos. Espera unos minutos.');
  const { email, password } = await readBody(req);
  auth.noteAttempt('login:' + ip);
  const row = users.byEmail(email);
  if (!row || !row.active || !auth.verifyPassword(password || '', row.password_hash)) return fail(res, 401, 'Email o contraseña incorrectos.');
  auth.clearAttempts('login:' + ip);
  users.touch(row.id);
  auth.createSession(req, res, row.id);
  store.audit(row.id, 'login');
  return ok(res, { user: meView(users.get(row.id)) });
}
function meView(u) {
  const out = { id: u.id, name: u.name, email: u.email, role: u.role };
  if (u.role === 'dj' || u.role === 'admin') out.color = u.color;
  // Flags que controlan qué apartados ve el DJ/técnico en su menú.
  if (u.role === 'dj') { out.vehicle_allowed = !!u.vehicle_allowed; out.time_tracking = !!u.time_tracking; }
  out.tycSigned = tycSignedBy(u);
  // Bodas de 2026 y anteriores (o sin fecha): no necesitan firmar, no se les muestra el gate.
  out.tycNotNeeded = u.role === 'user' && !out.tycSigned && !tycNeeded(u);
  return out;
}

/* ---------- contrato TyC ---------- */
const DEFAULT_TYC = '<p><strong>Términos y condiciones de servicio</strong></p>'
  + '<p>El presente documento regula la prestación de servicios de Conecta So (DJ, sonorización, iluminación y animación) para el evento indicado.</p>';
// Política de privacidad (RGPD). Se acepta JUNTO con el contrato, en el mismo acto de firma.
// Solo aplica a las parejas (clientes): los planners y DJs no firman ni ven este flujo.
const DEFAULT_PRIVACY = '<p><strong>Política de privacidad</strong></p>'
  + '<p><strong>Responsable:</strong> Conecta Sonido e Iluminación, S.L. (Conecta So), con domicilio en C/ Indústria 9, 08107 Martorelles (Barcelona). Contacto: info@conectaso.es.</p>'
  + '<p><strong>Qué datos tratamos:</strong> datos identificativos y de contacto (nombre, DNI, teléfono y correo electrónico), datos del evento y datos de facturación que nos facilitas para contratar y recibir el servicio.</p>'
  + '<p><strong>Con qué finalidad:</strong> gestionar y ejecutar el contrato de servicios (DJ, sonorización, iluminación y animación), emitir las facturas correspondientes y comunicarnos contigo sobre tu evento.</p>'
  + '<p><strong>Base legal:</strong> la ejecución del contrato que nos vincula, el cumplimiento de nuestras obligaciones legales (por ejemplo, fiscales y de facturación) y tu consentimiento para las comunicaciones relativas al servicio.</p>'
  + '<p><strong>Conservación:</strong> conservamos tus datos mientras dure la relación y, después, durante los plazos exigidos legalmente (fiscales y mercantiles). Transcurridos, se suprimen o se bloquean.</p>'
  + '<p><strong>Destinatarios:</strong> no cedemos tus datos a terceros, salvo obligación legal o a los proveedores necesarios para prestar el servicio (por ejemplo, la plataforma de facturación), que los tratan por cuenta nuestra.</p>'
  + '<p><strong>Tus derechos:</strong> puedes ejercer los derechos de acceso, rectificación, supresión, oposición, limitación y portabilidad escribiendo a info@conectaso.es. También puedes reclamar ante la Agencia Española de Protección de Datos (www.aepd.es).</p>'
  + '<p>No se toman decisiones automatizadas ni se realizan transferencias internacionales de datos.</p>';
function privacyCurrent() { const p = store.setting('privacyPolicy') || {}; return { version: String(p.version || '2027'), title: p.title || 'Política de privacidad', text: p.text || DEFAULT_PRIVACY }; }
function tycRec(t) { t = t || {}; return { id: t.id || 1, version: String(t.date || t.version || '1'), title: t.title || ('Términos y condiciones de servicio ' + (t.date || '')).trim(), text: t.text || DEFAULT_TYC }; }
function tycCurrent() { const list = store.all('tacs'); return tycRec(list[list.length - 1] || {}); }
function tycByVersion(v) { const t = store.all('tacs').find(x => String(x.date || x.version) === String(v)); return tycRec(t || store.all('tacs').slice(-1)[0] || {}); }
function eventOfUser(u) {
  if (!u || u.role !== 'user') return null;
  return store.all('events').find(e => e.userId == u.id || (e.coUsers || []).map(String).indexOf(String(u.id)) >= 0) || null;
}
// Heurística de género por nombre (castellano/catalán) para ordenar los cónyuges.
// Devuelve 'f', 'm' o '?'. Conservadora: solo clasifica lo evidente.
function guessGender(name) {
  const n = String(name || '').trim().toLowerCase().split(/\s+/)[0].normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!n) return '?';
  const FEM = new Set(['carmen', 'isabel', 'pilar', 'mar', 'nuria', 'meritxell', 'montserrat', 'beatriz', 'raquel', 'ruth', 'esther', 'ines', 'iris', 'lydia', 'ainhoa', 'abril', 'dolors', 'nerea', 'maribel']);
  const MASC = new Set(['pau', 'marc', 'jordi', 'pol', 'pere', 'oriol', 'aleix', 'guillem', 'arnau', 'biel', 'nil', 'roger', 'gerard', 'adria', 'joan', 'josep', 'david', 'daniel', 'sergi', 'albert', 'ferran', 'xavier', 'xavi', 'victor', 'hector', 'ivan', 'ruben', 'noel', 'isaac', 'abel', 'izan', 'aaron', 'luca', 'elias', 'joshua', 'jose', 'andres', 'matias', 'tobias', 'lucas', 'jonas', 'bruno', 'hugo', 'pablo', 'alvaro', 'nicolas', 'unai', 'eric', 'cesc']);
  if (FEM.has(n)) return 'f';
  if (MASC.has(n)) return 'm';
  if (n.endsWith('a')) return 'f';
  if (n.endsWith('o')) return 'm';
  return '?';
}
// Al firmar el contrato, autorrellena los cónyuges del evento (nombres + DNIs) si aún no están.
function autofillSpousesFromTyc(user, sign) {
  const ev = eventOfUser(user); if (!ev) return;
  const cur = ev.spouses || [];
  // Si el cliente ha indicado los nombres completos en la firma, se usan directamente
  // y se fija con ellos el nombre del evento (conyuges).
  const n1 = String(sign.name1 || '').trim(), n2 = String(sign.name2 || '').trim();
  if (n1 || n2) {
    ev.spouses = [
      Object.assign({}, cur[0] || {}, { name: n1 || (cur[0] || {}).name || '', dni: String(sign.dni || '').trim() || (cur[0] || {}).dni || '' }),
      Object.assign({}, cur[1] || {}, { name: n2 || (cur[1] || {}).name || '', dni: String(sign.dni2 || '').trim() || (cur[1] || {}).dni || '' }),
    ];
    const nm = ev.spouses.map(s => s.name).filter(Boolean).join(' y ');
    if (nm) ev.conyuges = nm;
    store.put('events', ev); return;
  }
  const names = String(ev.conyuges || '').split(/\s+y\s+/i).map(s => s.trim()).filter(Boolean);
  const hasData = cur.some(s => s && (s.name || s.dni));
  if (hasData) {
    // Ya hay datos (p. ej. admin): solo rellena DNIs que falten, sin reordenar ni pisar nombres.
    const next = [0, 1].map(i => Object.assign({}, cur[i] || {}));
    if (!next[0].dni && sign.dni) next[0].dni = sign.dni;
    if (!next[1].dni && sign.dni2) next[1].dni = sign.dni2;
    if (!next[0].name && names[0]) next[0].name = names[0];
    if (!next[1].name && names[1]) next[1].name = names[1];
    ev.spouses = next; store.put('events', ev); return;
  }
  if (!names.length) return;
  let pairs = [{ name: names[0] || '', dni: sign.dni || '' }, { name: names[1] || '', dni: sign.dni2 || '' }];
  // Usa el nombre completo del firmante para el cónyuge cuyo nombre de pila coincide.
  const full = String(sign.name || '').trim();
  if (full) pairs.forEach(p => { if (p.name && full.toLowerCase().startsWith(p.name.toLowerCase())) p.name = full; });
  // Orden: masculino primero SOLO si el otro es claramente femenino; si no, se mantiene como está.
  const g0 = guessGender(pairs[0].name), g1 = guessGender(pairs[1].name);
  if (g0 === 'f' && g1 === 'm') pairs = [pairs[1], pairs[0]];
  ev.spouses = pairs.map((p, i) => Object.assign({}, cur[i] || {}, { name: p.name, dni: p.dni }));
  ev.conyuges = ev.spouses.map(s => s.name).filter(Boolean).join(' y ') || ev.conyuges;
  store.put('events', ev);
}
function tycSignedBy(u) {
  if (!u || u.role !== 'user') return false;
  const ev = eventOfUser(u);
  // El cotitular (segundo cónyuge invitado) NUNCA firma: entra directo. El titular ya rellena
  // y firma los datos de ambos. Solo el titular (owner) del evento firma el contrato.
  if (ev && +ev.userId !== +u.id) return true;
  if (u.tycSign && u.tycSign.date) return true;           // firma hecha en la intranet nueva
  if (u.tyc === true) return true;                        // firma del sistema anterior (booleano "tyc")
  return !!(ev && ev.tycSigned);                          // firma ya registrada en los datos reales
}
// El TYC se implantó para la temporada 2027: las bodas de 2026 y anteriores (o sin fecha) NO firman.
function tycNeeded(u) {
  if (!u || u.role !== 'user') return false;
  const ev = eventOfUser(u);
  return !!(ev && ev.fecha && ev.fecha >= '2027-01-01');
}
function tycAutofill(u) {
  if (!u || u.role !== 'user') return { novios: '', finca: '', fecha: '', dnis: '', evId: null };
  const ev = eventOfUser(u) || {};
  const bad = s => !s || ['no indicado', 'no indicada', '-'].includes(String(s).trim().toLowerCase());
  const sp = ev.spouses || [];
  const names = sp.map(s => s.name).filter(s => !bad(s)).join(' y ');
  const dnis = sp.map(s => s.dni).filter(Boolean).join(' · ');
  const loc = (store.get('locations', ev.lugar) || {}).name || ev.lugarOtro || '';
  const novios = names || (!bad(u.name) ? u.name : '') || (!bad(ev.conyuges) ? ev.conyuges : '') || ev.tycSigner || '';
  return { novios, finca: loc, fecha: ev.fecha || '', dnis, evId: ev.id || null };
}
function tycSignatureFor(u) {
  // Si hay firma con fecha (p.ej. importada de la intranet), se usa; el nombre/DNI se
  // completan con los datos del evento si la firma no los trae.
  if (u.tycSign && u.tycSign.date) { const a = tycAutofill(u); return Object.assign({ version: '2027', name: a.novios || u.name || '', dni: a.dnis || '' }, u.tycSign); }
  const ev = eventOfUser(u);
  if (ev && ev.tycSigned) { const a = tycAutofill(u); return { name: ev.tycSigner || a.novios || '', dni: a.dnis || '', date: ev.tycSignedAt || '', version: String(ev.tycVersion || '2027') }; }
  // Firma del sistema anterior (booleano "tyc"): no guardaba fecha ni firmante, se reconstruye
  // a partir de los datos del evento para poder visualizar/descargar el contrato.
  if (u.tyc === true) { const a = tycAutofill(u); return { name: a.novios || u.name || '', dni: a.dnis || '', date: '', legacy: true, version: '2027' }; }
  return null;
}
async function tycApi(req, res, user, seg, method) {
  if (!user) return fail(res, 401, 'Necesitas iniciar sesión');
  const c = tycCurrent();
  if (seg[1] === 'current' && method === 'GET') {
    return ok(res, { tyc: c, privacy: privacyCurrent(), signed: tycSignedBy(user), signature: tycSignatureFor(user), autofill: tycAutofill(user) });
  }
  if (seg[1] === 'privacy' && method === 'GET') { return ok(res, { privacy: privacyCurrent() }); }
  if (seg[1] === 'privacy' && method === 'PUT') {
    if (user.role !== 'admin') return fail(res, 403, 'Sin acceso');
    const body = await readBody(req);
    const cur = privacyCurrent();
    store.setSetting('privacyPolicy', { version: String(body.version || cur.version), title: body.title || cur.title, text: body.text != null ? body.text : cur.text });
    store.audit(user.id, 'privacy-edit');
    return ok(res, { ok: true, privacy: privacyCurrent() });
  }
  if (seg[1] === 'sign' && method === 'POST') {
    if (user.role !== 'user') return fail(res, 403, 'Solo los clientes firman el contrato.');
    const body = await readBody(req);
    // Al firmar el contrato se acepta también la política de privacidad (mismo acto, misma fecha).
    const sign = { version: c.version, privacyVersion: privacyCurrent().version, name: (body.name1 || body.name || user.name || '').trim(), name2: String(body.name2 || '').trim(), dni: body.dni || '', dni2: body.dni2 || '', date: new Date().toISOString() };
    users.update(user.id, { data: { tycSign: sign } });
    try { autofillSpousesFromTyc(user, sign); } catch (e) { /* no bloquear la firma */ }
    store.audit(user.id, 'tyc-sign');
    return ok(res, { ok: true, user: meView(users.get(user.id)) });
  }
  if (seg[1] === 'signature' && method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Sin acceso');
    const u = users.get(+seg[2]); if (!u) return fail(res, 404, 'Usuario no encontrado');
    const sig = tycSignatureFor(u); const rec = tycByVersion(sig ? sig.version : c.version);
    return ok(res, { tyc: rec, signature: sig, autofill: tycAutofill(u), user: { id: u.id, name: u.name, role: u.role, email: u.email } });
  }
  if (method === 'PUT') {
    if (user.role !== 'admin') return fail(res, 403, 'Sin acceso');
    const body = await readBody(req);
    const list = store.all('tacs');
    const ver = String(body.date || body.version || c.version);
    let rec = list.find(x => String(x.date || x.version) === ver);
    if (rec) { rec.title = body.title || rec.title; rec.text = body.text != null ? body.text : rec.text; rec.date = ver; }
    else { rec = { id: store.nextId('tacs'), date: ver, title: body.title || ('Términos y condiciones de servicio ' + ver).trim(), text: body.text || DEFAULT_TYC }; }
    store.put('tacs', rec);
    store.audit(user.id, 'tyc-edit', 'tacs', rec.id);
    return ok(res, { ok: true, tyc: tycRec(rec) });
  }
  return fail(res, 404, 'Ruta TyC no encontrada');
}
async function inviteInfo(req, res, url) {
  const t = auth.checkToken(url.searchParams.get('token'));
  if (!t) return fail(res, 404, 'El enlace no es válido o ha caducado.');
  const u = users.get(t.user_id);
  return ok(res, { email: u.email, name: u.name, kind: t.kind });
}
async function activate(req, res) {
  const { token, password } = await readBody(req);
  const t = auth.checkToken(token);
  if (!t) return fail(res, 404, 'El enlace no es válido o ha caducado.');
  const problem = auth.passwordProblem(password);
  if (problem) return fail(res, 400, problem);
  users.setPassword(t.user_id, auth.hashPassword(password));
  auth.useToken(token);
  auth.endAllSessions(t.user_id);
  auth.createSession(req, res, t.user_id);
  store.audit(t.user_id, t.kind === 'invite' ? 'activate' : 'reset-password');
  return ok(res, { user: meView(users.get(t.user_id)) });
}
// Autologin del DJ por enlace mágico para rellenar su albarán (no requiere contraseña).
// El token NO se consume: el enlace sirve durante sus 7 días de validez.
async function albaranLogin(req, res) {
  const { token } = await readBody(req);
  const t = auth.checkToken(token);
  // 'albaran' = DJ/técnico para su parte; 'magic' = autologin de los novios desde sus correos.
  if (!t || (t.kind !== 'albaran' && t.kind !== 'magic')) return fail(res, 404, 'El enlace no es válido o ha caducado.');
  const u = users.get(t.user_id);
  if (!u || !u.active) return fail(res, 403, 'La cuenta no está activa.');
  auth.createSession(req, res, t.user_id);
  store.audit(t.user_id, 'albaran-login');
  return ok(res, { user: meView(u), mailEnabled: mail.enabled() });
}
async function forgot(req, res) {
  const ip = auth.clientIp(req);
  const { email } = await readBody(req);
  const row = users.byEmail(email);
  // Respuesta uniforme para no revelar qué correos existen
  if (row && row.active && !auth.rateLimited('forgot:' + ip, 5)) {
    auth.noteAttempt('forgot:' + ip);
    const token = auth.createToken(row.id, 'reset');
    const link = `${APP_URL() || ''}/#/activar?token=${token}`;
    if (mail.enabled()) {
      const em = emails.resetEmail(row, link, APP_URL());
      mail.sendMail({ to: row.email, subject: em.subject, text: em.text, html: em.html }).catch(() => {});
    }
  }
  return ok(res, { ok: true });
}
async function changePassword(req, res, user) {
  if (!user) return fail(res, 401, 'Necesitas iniciar sesión');
  const { current, password } = await readBody(req);
  const row = users.getRow(user.id);
  if (!auth.verifyPassword(current || '', row.password_hash)) return fail(res, 400, 'La contraseña actual no es correcta.');
  const problem = auth.passwordProblem(password);
  if (problem) return fail(res, 400, problem);
  users.setPassword(user.id, auth.hashPassword(password));
  store.audit(user.id, 'change-password');
  return ok(res, { ok: true });
}

/* ---------- avisos del panel de inicio (solo admin) ---------- */
// Trabajadores que SÍ pueden hacer 2 bodas el mismo día (no se marcan como duplicado).
// Nandez (713) y DJ Gallego (850). (Ampliable; Corcoy NO es excepción.)
const MULTI_SAMEDAY_OK = { '713': 1, '850': 1 };
// Trabajadores que no se revisan en "precios por revisar" (gerencia / por horas / etc.).
const PRICE_ALERT_SKIP = [226, 227, 1095, 234, 292, 1813, 276, 713];  // 226/227 = Adria DJ (nunca lleva precio)
const uName = id => (users.get(id) || {}).name || ('#' + id);
function onVacation(workerId, date) {
  if (!workerId || !date) return null;
  // Solo cuentan las vacaciones APROBADAS para los avisos de conflicto (las pendientes no).
  return store.all('vacations').find(v => v.userId == workerId && v.status === 'Aprobado' && v.start && v.end && date >= v.start && date <= v.end) || null;
}
const dupAckKey = (w, date) => String(w) + '@' + date;
function staffConflicts() {
  const TODAY = bizToday(); const byDay = {};
  const acked = new Set(store.setting('dupAck') || []);  // casos puntuales marcados como "ya avisado"
  store.all('events').forEach(e => {
    if (!(e.fecha && e.fecha >= TODAY)) return;
    const ws = new Set(); if (e.djId) ws.add(+e.djId);
    (e.services || []).forEach(s => { if (s.resp) ws.add(+s.resp); if (s.resp2) ws.add(+s.resp2); });
    ws.forEach(w => { (byDay[e.fecha] = byDay[e.fecha] || {}); (byDay[e.fecha][w] = byDay[e.fecha][w] || []).push({ id: e.id, conyuges: e.conyuges || '' }); });
  });
  const out = [];
  Object.keys(byDay).forEach(date => Object.keys(byDay[date]).forEach(w => {
    if (MULTI_SAMEDAY_OK[String(w)]) return;              // puede hacer 2/día siempre
    { const wu = users.get(+w); if (wu && wu.role === 'planner') return; }  // las wedding planners sí pueden 2/día
    if (acked.has(dupAckKey(w, date))) return;            // caso puntual ya avisado
    const evs = byDay[date][w]; if (evs.length >= 2) out.push({ date, workerId: +w, workerName: uName(+w), events: evs });
  }));
  out.sort((a, b) => a.date.localeCompare(b.date));
  return { conflicts: out, total: out.length };
}
function vacationConflicts() {
  const TODAY = bizToday(); const out = [];
  store.all('events').forEach(e => {
    if (!(e.fecha && e.fecha >= TODAY)) return;
    const assigned = new Set();
    if (e.djId) assigned.add(+e.djId);
    (e.services || []).forEach(s => { if (s.resp) assigned.add(+s.resp); if (s.resp2) assigned.add(+s.resp2); });
    assigned.forEach(wid => { const v = onVacation(wid, e.fecha); if (v) out.push({ evId: e.id, fecha: e.fecha, conyuges: e.conyuges || '', workerId: wid, workerName: uName(wid), vacStart: v.start, vacEnd: v.end, status: v.status }); });
  });
  out.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return { conflicts: out, total: out.length };
}
function itvAlerts() {
  const TODAY = bizToday();
  const addDaysStr = (ds, n) => { const d = new Date(ds + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const limit = addDaysStr(TODAY, 15), now = new Date(TODAY + 'T00:00:00');
  const list = store.all('vehicles').filter(v => v.itvDate && v.itvDate <= limit).map(v => ({
    id: v.id, plate: v.license_plate, brand: v.brand, model: v.model, itvDate: v.itvDate,
    days: Math.round((new Date(v.itvDate + 'T00:00:00') - now) / 86400000)
  })).sort((a, b) => a.itvDate.localeCompare(b.itvDate));
  return { vehicles: list, total: list.length, email: 'facturacion@conectaso.es' };
}
// Técnicos/DJs asignados a servicios (de hoy en adelante) sin precio configurado en sus tarifas.
function priceAlerts() {
  const TODAY = bizToday(); const rates = store.setting('djRates') || {}; const groups = {};
  store.all('events').forEach(e => {
    if (!(e.fecha && e.fecha >= TODAY)) return;
    (e.services || []).forEach(s => {
      [s.resp, s.resp2].forEach(r => {
        if (!r || PRICE_ALERT_SKIP.includes(+r)) return;
        const svc = (rates[String(r)] || {}).services || {};
        if (svc[s.servicio] != null) return;                 // ya tiene precio (aunque sea 0)
        const g = groups[r] || (groups[r] = { workerId: +r, name: uName(r), services: {} });
        const sv = g.services[s.servicio] || (g.services[s.servicio] = { serviceId: +s.servicio, name: extraNameOf(s.servicio), count: 0 });
        sv.count++;
      });
    });
  });
  const tot = g => g.services.reduce((t, s) => t + s.count, 0);
  const list = Object.values(groups).map(g => ({ workerId: g.workerId, name: g.name, services: Object.values(g.services).sort((a, b) => b.count - a.count) })).sort((a, b) => tot(b) - tot(a));
  return { groups: list, totalCombos: list.reduce((t, g) => t + g.services.length, 0), totalWorkers: list.length };
}
function extraNameOf(id) { const e = store.get('extras', id); return (e && e.name) || ('Servicio ' + id); }
// Aplica los ajustes manuales de tarifas (setting 'djRatesManual') SOBRE el djRates calculado.
// Se llama tras cualquier build/volcado para que las correcciones a mano no se pierdan.
function applyManualRates() {
  const man = store.setting('djRatesManual') || {};
  const rates = store.setting('djRates') || {};
  let n = 0;
  Object.keys(man).forEach(uid => {
    if (uid[0] === '_') return;                       // claves de comentario
    const o = man[uid]; if (!o || typeof o !== 'object') return;
    const r = rates[uid] || (rates[uid] = { packs: {}, fincas: {}, services: {} });
    r.fincas = r.fincas || {}; r.packs = r.packs || {}; r.services = r.services || {};
    if (o.zeroAll) {
      Object.keys(r.fincas).forEach(k => { const f = r.fincas[k] || {}; ['boda', 'he', 'evento', 'ceremonia', 'disco'].forEach(x => { if (f[x] != null) f[x] = 0; }); });
      Object.keys(r.packs).forEach(k => { r.packs[k] = 0; });
      Object.keys(r.services).forEach(k => { r.services[k] = 0; });
    }
    if (o.fincas) Object.keys(o.fincas).forEach(fid => { r.fincas[fid] = Object.assign({}, r.fincas[fid] || {}, o.fincas[fid]); });
    if (o.packs) Object.assign(r.packs, o.packs);
    if (o.services) Object.assign(r.services, o.services);
    n++;
  });
  store.setSetting('djRates', rates);
  return n;
}
// Matriz de sueldos (solo lectura, admin): tarifas por trabajador × finca/pack/servicio + uso real
// (cuántas veces ha trabajado cada uno en cada finca/servicio) para ver qué datos faltan.
function salaryMatrix() {
  const rates = store.setting('djRates') || {};
  const workers = users.all().filter(u => u.role === 'dj' || u.worker_type || rates[String(u.id)])
    .map(u => ({ id: u.id, name: u.name, role: u.role, worker_type: u.worker_type || '' }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const fincas = store.all('locations').map(l => ({ id: l.id, name: l.name })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const services = store.all('extras').map(e => ({ id: e.id, name: e.name })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const packs = ['fiesta', 'bodorrio', 'tinglado'];
  const usageFinca = {}, usageSvc = {}, usagePack = {};
  store.all('events').forEach(e => {
    if (e.djId) {
      const w = String(e.djId);
      if (e.lugar) (usageFinca[w] = usageFinca[w] || {})[e.lugar] = ((usageFinca[w] || {})[e.lugar] || 0) + 1;
      const pk = ({ Fiesta: 'fiesta', Bodorrio: 'bodorrio', Tinglado: 'tinglado' })[e.tipo];
      if (pk && !e.lugar) (usagePack[w] = usagePack[w] || {})[pk] = ((usagePack[w] || {})[pk] || 0) + 1;
    }
    (e.services || []).forEach(s => { [s.resp, s.resp2].forEach(r => { if (!r) return; const w = String(r); (usageSvc[w] = usageSvc[w] || {})[s.servicio] = (((usageSvc[w] || {})[s.servicio]) || 0) + 1; }); });
  });
  return { workers, fincas, services, packs, rates, usageFinca, usageSvc, usagePack };
}
async function dashboardAlerts(req, res, user, seg, method) {
  if (!user || user.role !== 'admin') return fail(res, 403, 'Sin acceso');
  if (seg[0] === 'staff-conflicts') return ok(res, staffConflicts());
  if (seg[0] === 'vacation-conflicts') return ok(res, vacationConflicts());
  if (seg[0] === 'itv-alerts') return ok(res, itvAlerts());
  if (seg[0] === 'price-alerts') return ok(res, priceAlerts());
  if (seg[0] === 'salary-matrix') return ok(res, salaryMatrix());
  if (seg[0] === 'price-fix' && method === 'POST') {
    const body = await readBody(req);
    const wid = +body.workerId, sid = +body.serviceId, amt = Math.round(+body.amount || 0);
    if (!wid || !sid) return fail(res, 400, 'Faltan datos');
    const rates = store.setting('djRates') || {};
    const r = rates[String(wid)] || (rates[String(wid)] = { packs: {}, fincas: {}, services: {} });
    r.services = r.services || {};
    r.services[sid] = amt;
    store.setSetting('djRates', rates);
    store.audit(user.id, 'price-fix');
    return ok(res, { ok: true });
  }
  if (seg[0] === 'dup-ack' && method === 'POST') {
    const body = await readBody(req);
    if (!body.workerId || !body.date) return fail(res, 400, 'Faltan datos');
    const acked = store.setting('dupAck') || [];
    const key = dupAckKey(body.workerId, body.date);
    if (!acked.includes(key)) acked.push(key);
    store.setSetting('dupAck', acked);
    store.audit(user.id, 'dup-ack');
    return ok(res, { ok: true });
  }
  return fail(res, 404, 'No encontrado');
}

/* ---------- metadatos para la interfaz ---------- */
function staffList() {
  return users.all().filter(u => ['dj', 'admin', 'planner'].includes(u.role) && (u.role !== 'admin' || u.worker_type))
    .map(u => ({ id: u.id, name: u.name, role: u.role }));
}
function meta(user) {
  const staffView = (user.role === 'admin' || user.role === 'dj');
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' });
  const m = {
    role: user.role,
    estados: store.setting('estados'),
    tipos: store.setting('tipos'),
    // admin/DJ reciben también los datos de desplazamiento (min/km/coordenadas) y la
    // dirección, que la hoja de ruta y el cálculo de kilómetros necesitan.
    // Fincas, servicios, DJs/técnicos y planners van ORDENADOS alfabéticamente.
    locations: store.all('locations').map(l => staffView
      ? { id: l.id, name: l.name, colorHex: l.colorHex, direction: l.direction, directionLink: l.directionLink, lat: l.lat, lng: l.lng, travelMin: l.travelMin, travelKm: l.travelKm, travelApprox: l.travelApprox }
      : { id: l.id, name: l.name, colorHex: l.colorHex }).sort(byName),
    extras: store.all('extras').slice().sort(byName),
    // Furgonetas disponibles (para asignarlas a eventos fiesta/bodorrio/tinglado/extras).
    vehicles: store.all('vehicles').map(v => ({ id: v.id, brand: v.brand || '', model: v.model || '', plate: v.license_plate || '' })),
  };
  if (staffView) {
    m.staff = staffList().slice().sort(byName);
    m.djs = users.all().filter(u => u.role === 'dj').map(u => ({ id: u.id, name: u.name })).sort(byName);
    m.planners = users.all().filter(u => u.role === 'planner').map(u => ({ id: u.id, name: u.name })).sort(byName);
  }
  return m;
}

/* ---------- eventos ---------- */
function listEventsFor(user) {
  if (user.role === 'admin') return store.all('events');
  // IMPORTANTE: filtramos por los DATOS REALES del evento, no por los índices denormalizados
  // (staff/owner_id/wp_id). Esos índices pueden quedar vacíos en eventos importados o creados
  // fuera del flujo normal, lo que haría que una boda no apareciera en el listado del DJ, del
  // planner o del cotitular. Escanear ~2000 eventos es instantáneo y es correcto para TODAS las
  // bodas (actuales e importadas), no solo las guardadas de nuevo.
  const all = store.all('events');
  const uid = +user.id;
  if (user.role === 'user') return all.filter(e => +e.userId === uid || (e.coUsers || []).some(x => +x === uid));
  if (user.role === 'planner') return all.filter(e => +e.wpId === uid);
  if (user.role === 'dj') return all.filter(e => +e.djId === uid || (e.services || []).some(s => +s.resp === uid || +s.resp2 === uid));
  return [];
}
// Listado global de solicitudes de extras (para la pestaña "Servicios extras" y el aviso de inicio).
function extraRequestsApi(req, res, user) {
  if (!user || user.role !== 'admin') return fail(res, 403, 'Sin acceso');
  const out = [];
  store.all('events').forEach(e => {
    if (evRealized(e)) return;  // boda ya celebrada: sus solicitudes de extras ya no tienen sentido
    const st = e.extraStatus || {};
    Object.keys(st).forEach(k => out.push({ evId: e.id, conyuges: e.conyuges || '', fecha: e.fecha || '', lugar: (store.get('locations', e.lugar) || {}).name || '', extraKey: k, estado: st[k] }));
  });
  const rank = { solicitado: 0, pendiente_pago: 1, reservado: 2 };
  out.sort((a, b) => (rank[a.estado] - rank[b.estado]) || (a.fecha || '').localeCompare(b.fecha || ''));
  return ok(res, { requests: out, total: out.length, pending: out.filter(x => x.estado === 'solicitado').length });
}
// Añade al evento saneado los campos que calcula el servidor: si el cliente puede
// editar (canEdit), días hasta la boda, personas con acceso y, para el cliente, su pago.
function enrichEvent(out, ev, user) {
  if (!out) return out;
  out.canEdit = perm.clientEditOpen(ev);
  out.daysToEvent = perm.daysUntilEvent(ev);
  const ids = [ev.userId].concat(ev.coUsers || []).filter(Boolean).filter(id => id == ev.userId || users.get(id));
  out.accessUsers = ids.map(id => { const au = users.get(id) || {}; return { id: +id, name: au.name || '', email: au.email || '', owner: id == ev.userId }; });
  if (user.role === 'user') {
    const tot = +ev.pagoCliente || 0, pg = +ev.pagado || 0; out.pago = { total: tot, pagado: pg, pendiente: tot - pg, metodo: ev.metodo || '' };
    // El cliente ve el DJ (solo por nombre) cuando faltan menos de 60 días: la asignación final.
    if (out.daysToEvent != null && out.daysToEvent < 60 && ev.djId) { const dj = users.get(ev.djId); if (dj && dj.name) out.djName = dj.name; }
  }
  return out;
}

// --- Aviso por email a facturación cuando los novios solicitan un extra ---
const FACT_EMAIL = 'facturacion@conectaso.es';
const EXTRA_LABELS = {
  extra_fotomaton: 'Fotomatón', extra_videomaton: 'Videomatón 360 grados', extra_hora_loca_animacion: 'Hora loca animación',
  extra_pistola_co2: 'Pistolas CO₂', extra_maquinas_fuego_frio: '2 máquinas fuego frío', extra_maquinas_humo_vertical_led: '2 máquinas de humo vertical con led',
  extra_photocall_sofa_chester_letras_led: 'Photocall sofá chester + letras led', extra_iluminacion_ambiental_led: 'Iluminación ambiental fachadas led colores',
  extra_burbujas_humo_interior: 'Burbujas con humo en su interior', extra_confeti: 'Servicio de confeti', extra_servicio_de_tarima: 'Servicio de tarima',
  extra_servicio_de_suelo_led: 'Servicio de suelo led', extra_servicio_de_proyeccion: 'Servicio de proyección', extra_humo_bajo: 'Humo bajo',
  extra_lanzadores_humo_aereo: 'Lanzadores de humo aéreo',
};
const extraLabel = key => EXTRA_LABELS[key] || String(key).replace(/^extra_/, '').replace(/_/g, ' ');
const slashDate = f => { const p = String(f || '').slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : (f || '—'); };
// Compara el estado anterior y el nuevo del evento; si hay extras recién puestos en "solicitado"
// (por un novio o wedding planner), avisa por email a facturación. Si el SMTP está apagado no envía nada.
function notifyNewExtraRequests(user, oldEv, newEv) {
  if (user.role !== 'user' && user.role !== 'planner') return;
  const before = oldEv.extraStatus || {}, after = newEv.extraStatus || {};
  const nuevos = Object.keys(after).filter(k => after[k] === 'solicitado' && before[k] !== 'solicitado');
  if (!nuevos.length) return;
  const finca = (store.get('locations', newEv.lugar) || {}).name || newEv.lugarOtro || '—';
  const items = nuevos.map(k => extraLabel(k));
  store.audit(user.id, 'extra-request', 'events', newEv.id);
  if (!mail.enabled()) return;
  // Se avisa a administración. Cada admin recibe un enlace que le AUTOLOGUEA como admin y
  // le lleva a la boda (aunque tuviera otra cuenta abierta). A facturación va un enlace normal.
  const admins = users.all().filter(u => u.role === 'admin' && u.email);
  const sendExtra = (to, uid) => {
    const link = uid ? (APP_URL() + '/#/albaran?token=' + auth.createToken(uid, 'magic') + '&ev=' + newEv.id) : (APP_URL() + '/#/eventos/' + newEv.id);
    const em = emails.extraRequestEmail(newEv, items, finca, link, APP_URL());
    try { mail.sendMail({ to, subject: em.subject, text: em.text, html: em.html }); } catch (e) { console.error('[aviso extra] email:', e.message); }
  };
  const seen = new Set();
  admins.forEach(a => { seen.add(a.email.toLowerCase()); sendExtra(a.email, a.id); });
  // A facturación (posible buzón compartido) un enlace normal: evita dar sesión de admin a quien lo lea.
  if (FACT_EMAIL && !seen.has(FACT_EMAIL.toLowerCase())) sendExtra(FACT_EMAIL, null);
}

async function events(req, res, user, seg, method, url) {
  // /api/events  (listado)
  if (seg.length === 1 && method === 'GET') {
    const done = url.searchParams.get('status') === 'done';
    // Un evento pasa a "realizadas" a las 05:00 del día siguiente (hora de Madrid).
    let list = listEventsFor(user).filter(e => (done ? evFinished(e) : !evFinished(e)));
    return ok(res, { events: list.map(e => perm.summarizeEvent(user, e)) });
  }
  // /api/events  (crear una boda nueva; solo admin)
  if (seg.length === 1 && method === 'POST') {
    if (user.role !== 'admin') return fail(res, 403, 'Sin acceso');
    const body = await readBody(req);
    const rec = {
      id: store.nextId('events'),
      tipo: body.tipo || 'Recomendado',
      conyuges: body.conyuges || '',
      fecha: body.fecha || '',
      hora: '00:01',            // hora de inicio por defecto en eventos nuevos
      lugar: body.lugar || 0,
      lugarOtro: '', ceremoniaFuera: false, estado: 0, metodo: '',
      pagoCliente: 0, pagado: 0, pagoRestaurante: 0,
      userId: body.userId ? +body.userId : null,
      services: [], music: {}, extras: {}, spouses: [], labels: {},
    };
    store.put('events', rec);
    store.audit(user.id, 'event-create', 'events', rec.id);
    return ok(res, { event: rec });
  }
  // /api/events/trash  (papelera de eventos borrados; solo admin)
  if (seg[1] === 'trash') {
    if (user.role !== 'admin') return fail(res, 403, 'Sin acceso');
    // GET /api/events/trash → listado de la papelera
    if (seg.length === 2 && method === 'GET') {
      const list = store.all('events_trash').sort((a, b) => String(b._deletedAt || '').localeCompare(String(a._deletedAt || '')))
        .map(e => ({ id: e.id, tipo: e.tipo, conyuges: e.conyuges || '', fecha: e.fecha || '', lugar: (store.get('locations', e.lugar) || {}).name || e.lugarOtro || '', deletedAt: e._deletedAt || '', deletedBy: e._deletedByName || '' }));
      return ok(res, { events: list, total: list.length });
    }
    // POST /api/events/trash/:id/restore → devuelve el evento a la lista
    const tid = +seg[2];
    if (tid && seg[3] === 'restore' && method === 'POST') {
      const t = store.get('events_trash', tid);
      if (!t) return fail(res, 404, 'No está en la papelera');
      if (store.get('events', tid)) return fail(res, 409, 'Ya existe un evento con ese número; no se puede restaurar.');
      const ev2 = Object.assign({}, t); delete ev2._deletedAt; delete ev2._deletedBy; delete ev2._deletedByName;
      store.put('events', ev2); store.del('events_trash', tid);
      store.audit(user.id, 'event-restore', 'events', tid);
      return ok(res, { ok: true, event: perm.sanitizeEvent(user, ev2) });
    }
    // DELETE /api/events/trash/:id → purga definitiva (borra de la papelera)
    if (tid && seg.length === 3 && method === 'DELETE') {
      store.del('events_trash', tid); store.audit(user.id, 'event-purge', 'events', tid);
      return ok(res, { ok: true, purged: true });
    }
    return fail(res, 404, 'Ruta de papelera no válida');
  }
  // /api/events/:id
  const id = +seg[1];
  if (!id) return fail(res, 404, 'Evento no encontrado');
  const ev = store.get('events', id);
  if (!ev || !perm.canSeeEvent(user, ev)) return fail(res, 404, 'Evento no encontrado');

  // --- solicitudes de extras: aceptar (confirmar) / marcar pagado / declinar (solo admin) ---
  if (seg[2] && method === 'POST' && ['extra-confirm', 'extra-pay', 'extra-decline'].includes(seg[2])) {
    if (user.role !== 'admin') return fail(res, 403, 'Sin acceso');
    const body = await readBody(req); const k = body.key;
    const st = ev.extraStatus || (ev.extraStatus = {});
    if (seg[2] === 'extra-confirm') { if (st[k] === 'solicitado') st[k] = 'pendiente_pago'; }
    else if (seg[2] === 'extra-pay') { if (st[k] === 'pendiente_pago') st[k] = 'reservado'; }
    else if (seg[2] === 'extra-decline') { if (ev.extras) delete ev.extras[k]; delete st[k]; }
    store.put('events', ev); store.audit(user.id, seg[2], 'events', id);
    return ok(res, { ok: true, extraStatus: ev.extraStatus });
  }

  // --- acceso de la pareja: invitar a un segundo usuario (novio/novia) ---
  if (seg[2] === 'invite-user' && method === 'POST') {
    const owner = user.role === 'user' && (+ev.userId === +user.id || (ev.coUsers || []).some(x => +x === +user.id));
    if (user.role !== 'admin' && !owner) return fail(res, 403, 'Sin acceso');
    const body = await readBody(req);
    const email = String(body.email || '').trim();
    if (!email || email.indexOf('@') < 0) return fail(res, 400, 'Indica un email válido');
    let u = users.byEmail(email);
    // Límite: los novios pueden dar acceso a 2 personas como máximo (titular + 1). Para más, admin.
    if (user.role !== 'admin') {
      const access = new Set([ev.userId].concat(ev.coUsers || []).map(Number).filter(Boolean));
      const alreadyIn = u && access.has(+u.id);
      if (!alreadyIn && access.size >= 2) return fail(res, 400, 'Solo podéis dar acceso a 2 personas como máximo. Para añadir a más, escribidnos y lo gestionamos nosotros.');
    }
    if (!u) u = users.create({ email, name: body.name || email.split('@')[0], role: 'user', data: {} });
    if (u.role !== 'user') return fail(res, 400, 'Ese email ya pertenece a una cuenta del equipo.');
    ev.coUsers = ev.coUsers || [];
    if (+ev.userId !== +u.id && ev.coUsers.indexOf(u.id) < 0) ev.coUsers.push(u.id);
    store.put('events', ev); store.audit(user.id, 'invite-user', 'events', id);
    // Se envía el correo de activación (si el correo está activo y el destinatario pasa la lista
    // blanca); 'invite' indica si se envió de verdad o hay que compartir el enlace a mano.
    const invite = await makeInvite(u);
    return ok(res, { ok: true, user: { id: u.id, name: u.name, email: u.email }, invite });
  }
  if (seg[2] === 'remove-user' && method === 'POST') {
    const owner = user.role === 'user' && (+ev.userId === +user.id || (ev.coUsers || []).some(x => +x === +user.id));
    if (user.role !== 'admin' && !owner) return fail(res, 403, 'Sin acceso');
    const body = await readBody(req); const rid = +body.userId;
    if (rid === +ev.userId) return fail(res, 400, 'No se puede quitar al titular de la boda.');
    ev.coUsers = (ev.coUsers || []).filter(x => +x !== rid);
    store.put('events', ev); store.audit(user.id, 'remove-user', 'events', id);
    return ok(res, { ok: true });
  }
  // --- PRUEBA: enviar una copia del email "parte de trabajo del DJ" (el recordatorio que
  // se dispara el día después de la boda) a una dirección de prueba, con aviso de a quién
  // iría de verdad. No marca el recordatorio como enviado ni toca el evento. Solo admin. ---
  if (seg[2] === 'test-albaran' && method === 'POST') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    const body = await readBody(req);
    const to = String(body.to || user.email || '').trim();
    if (!to || to.indexOf('@') < 0) return fail(res, 400, 'Indica una dirección de destino válida.');
    const djId = +ev.djId || 0;
    const dj = djId ? users.get(djId) : null;
    if (!dj) return fail(res, 400, 'Este evento no tiene DJ asignado.');
    const base = APP_URL();
    const link = `${base || ''}/#/albaran?token=${auth.createToken(dj.id, 'albaran')}&ev=${ev.id}`;
    const em = emails.djAlbaranEmail(dj, ev, link, base);
    const subject = `[PRUEBA · iría a ${dj.name || 'DJ'} <${dj.email || 'sin email'}>] ${em.subject}`;
    let result;
    try { result = await mail.sendMail({ to, subject, text: em.text, html: em.html }); }
    catch (e) { return ok(res, { ok: false, error: e.message, dj: { id: dj.id, name: dj.name, email: dj.email } }); }
    const status = (result && result.skipped) ? 'skipped-allowlist' : (result && result.disabled) ? 'disabled' : 'sent';
    return ok(res, { ok: true, status, to, dj: { id: dj.id, name: dj.name, email: dj.email } });
  }

  // --- trabajador por horas (Josep): indica las horas realizadas tras la boda ---
  if (seg[2] === 'mis-horas' && method === 'POST') {
    if (fact.HOURLY_RATE[String(user.id)] == null) return fail(res, 403, 'Este apartado es solo para trabajadores por horas.');
    if (fact.assignedWorkers(ev).indexOf(String(user.id)) < 0) return fail(res, 403, 'No estás asignado a esta boda.');
    if (!evRealized(ev)) return fail(res, 400, 'Podrás indicar tus horas cuando se haya celebrado la boda.');
    const body = await readBody(req); const hrs = parseFloat(body.hours);
    if (isNaN(hrs) || hrs < 0) return fail(res, 400, 'Indica un número de horas válido.');
    ev.helperHours = ev.helperHours || {}; ev.helperHours[String(user.id)] = hrs;
    store.put('events', ev); store.audit(user.id, 'mis-horas', 'events', id);
    return ok(res, { ok: true, hours: hrs });
  }

  // --- plus de facturación (admin, boda finalizada) ---
  if (seg[2] === 'plus' && method === 'POST') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
    if (!evRealized(ev)) return fail(res, 400, 'Solo se pueden añadir pluses una vez celebrada la boda.');
    const body = await readBody(req); const amount = Math.round(+body.amount || 0);
    if (!amount) return fail(res, 400, 'Indica un importe (puede ser positivo o negativo).');
    ev.plus = ev.plus || [];
    ev.plus.push({ userId: body.userId ? +body.userId : null, amount, concept: body.concept || '', date: bizToday() });
    store.put('events', ev); store.audit(user.id, 'plus', 'events', id);
    const out = perm.sanitizeEvent(user, ev); enrichEvent(out, ev, user);
    out.factRows = fact.computeFact(ev); out.revRows = fact.computeRevenue(ev);
    return ok(res, { event: out });
  }

  // --- enlace de autologin para que el DJ (o trabajador por horas) rellene su parte (admin) ---
  if (seg[2] === 'albaran-link' && method === 'GET') {
    if (user.role !== 'admin') return fail(res, 403, 'Sin acceso');
    const wid = +(url.searchParams.get('worker')) || +ev.djId;
    if (!wid) return fail(res, 400, 'Este evento no tiene DJ asignado.');
    const w = users.get(wid);
    if (!w) return fail(res, 404, 'Trabajador no encontrado.');
    const token = auth.createToken(wid, 'albaran');
    return ok(res, { token, eventId: ev.id, workerId: wid, workerName: w.name || '', hourly: !!fact.HOURLY_RATE[String(wid)] });
  }

  // --- facturas de Holded del cliente de esta boda (admin y los propios novios) ---
  if (seg[2] === 'holded-invoices' && method === 'GET') {
    // Pueden verlas: administración, la pareja (titular/cónyuges) y el wedding planner asignado.
    // El DJ NO. (canSeeEvent ya garantiza que un planner solo llega a sus eventos asignados.)
    const owner = +ev.userId === +user.id || (ev.coUsers || []).some(x => +x === +user.id);
    if (user.role !== 'admin' && user.role !== 'planner' && !owner) return fail(res, 403, 'Sin acceso a la facturación de esta boda.');
    if (!holded.enabled()) return ok(res, { enabled: false, invoices: [] });
    const emails = [], nifs = [], names = [];
    const pushU = uid => { const u = users.get(uid); if (u && u.email) emails.push(u.email); };
    if (ev.userId) pushU(ev.userId);
    (ev.coUsers || []).forEach(pushU);
    (ev.spouses || []).forEach(s => { if (s && s.email) emails.push(s.email); if (s && s.dni) nifs.push(s.dni); if (s && s.name) names.push(s.name); });
    if (ev.conyuges) String(ev.conyuges).split(/\s+y\s+|&/i).forEach(n => { const t = n.trim(); if (t) names.push(t); });
    try {
      const force = url.searchParams.get('refresh') === '1' && user.role === 'admin';
      // Un novio solo ve facturas conciliadas por email o NIF (identificadores únicos), nunca solo por
      // nombre (posible homónimo). Admin incluye también las coincidencias por nombre.
      const r = await holded.invoicesForClient({ emails, nifs, names }, force, { includeName: user.role === 'admin' });
      const totals = r.invoices.reduce((a, i) => ({ total: a.total + i.total, paid: a.paid + i.paid, pending: a.pending + i.pending }), { total: 0, paid: 0, pending: 0 });
      return ok(res, { enabled: true, matchedBy: r.matchedBy, contact: r.contact, contacts: user.role === 'admin' ? r.contacts : undefined, invoices: r.invoices, totals, indexInfo: user.role === 'admin' ? r.indexInfo : undefined });
    } catch (e) { return ok(res, { enabled: true, error: e.message, invoices: [] }); }
  }

  // --- PDF de una factura de Holded (verifica que es del cliente de esta boda) ---
  if (seg[2] === 'holded-invoice-pdf' && method === 'GET') {
    const owner = +ev.userId === +user.id || (ev.coUsers || []).some(x => +x === +user.id);
    if (user.role !== 'admin' && user.role !== 'planner' && !owner) return fail(res, 403, 'Sin acceso');
    const invId = url.searchParams.get('inv');
    if (!invId) return fail(res, 400, 'Falta la factura.');
    const emails = [], nifs = [], names = [];
    const pushU = uid => { const u = users.get(uid); if (u && u.email) emails.push(u.email); };
    if (ev.userId) pushU(ev.userId);
    (ev.coUsers || []).forEach(pushU);
    (ev.spouses || []).forEach(s => { if (s && s.email) emails.push(s.email); if (s && s.dni) nifs.push(s.dni); if (s && s.name) names.push(s.name); });
    if (ev.conyuges) String(ev.conyuges).split(/\s+y\s+|&/i).forEach(n => { const t = n.trim(); if (t) names.push(t); });
    try {
      const r = await holded.invoicesForClient({ emails, nifs, names });
      if (!r.invoices.some(i => i.id === invId)) return fail(res, 403, 'Esa factura no pertenece a esta boda.');
      const buf = await holded.getInvoicePdf(invId);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="factura-${invId}.pdf"`, 'Content-Length': buf.length });
      return res.end(buf);
    } catch (e) { return fail(res, 502, 'No se pudo obtener el PDF: ' + e.message); }
  }

  if (method === 'GET') {
    const out = perm.sanitizeEvent(user, ev);
    enrichEvent(out, ev, user);
    // El coste de personal y el beneficio se calculan al vuelo (solo admin).
    if (user.role === 'admin') { out.factRows = fact.computeFact(ev); out.revRows = fact.computeRevenue(ev); }
    return ok(res, { event: out });
  }
  if (method === 'PUT') {
    const body = await readBody(req);
    let next;
    try { next = perm.mergeEventUpdate(user, ev, body.event || body); }
    catch (e) { return fail(res, e.status || 400, e.message); }
    store.put('events', next);
    // Reasignar furgoneta ("cambiarla de ubicación"): si el admin lo confirma, se la quitamos a las
    // demás bodas del mismo día que la tuvieran asignada (una furgoneta solo puede estar en un sitio).
    if (user.role === 'admin' && (body.reassignVehicle || (body.event && body.event.reassignVehicle)) && next.vehicleId && next.fecha) {
      store.all('events').forEach(e => { if (+e.id !== id && e.fecha === next.fecha && +e.vehicleId === +next.vehicleId) { const e2 = Object.assign({}, e); delete e2.vehicleId; store.put('events', e2); } });
    }
    try { notifyNewExtraRequests(user, ev, next); } catch (e) { /* no bloquear el guardado */ }
    store.audit(user.id, 'event-update', 'events', id);
    const saved = store.get('events', id);
    const out = perm.sanitizeEvent(user, saved);
    enrichEvent(out, saved, user);
    if (user.role === 'admin') { out.factRows = fact.computeFact(saved); out.revRows = fact.computeRevenue(saved); }
    return ok(res, { event: out });
  }
  if (method === 'DELETE') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración puede borrar eventos.');
    // Borrado reversible: el evento se mueve a la papelera (events_trash) en vez de eliminarse.
    // Los archivos subidos NO se tocan, así que al restaurar vuelven con el evento.
    const trashed = Object.assign({}, ev, { _deletedAt: new Date().toISOString(), _deletedBy: user.id, _deletedByName: (users.get(user.id) || {}).name || '' });
    store.put('events_trash', trashed);
    store.del('events', id);
    store.audit(user.id, 'event-delete', 'events', id);
    return ok(res, { ok: true, trashed: true });
  }
  return fail(res, 405, 'Método no permitido');
}

/* ---------- usuarios ---------- */
async function usersApi(req, res, user, seg, method) {
  if (user.role !== 'admin') {
    // Un no-admin solo puede ver/editar su propio perfil básico
    if (seg[1] === 'me' && method === 'GET') return ok(res, { user: users.get(user.id) });
    return fail(res, 403, 'No tienes acceso a la gestión de usuarios.');
  }
  if (seg.length === 1 && method === 'GET') {
    // Índice de firmas por evento calculado UNA sola vez (antes se recorrían todos los
    // eventos por cada usuario → O(usuarios×eventos), con ~2000 usuarios dejaba la página colgada).
    const signedUserIds = new Set();
    const coUserIds = new Set();  // cotitulares (segundo/tercer acceso): su firma no es necesaria, ya firma el titular
    const ownerEvent = {};        // userId del titular -> datos mínimos de su boda (para avisar al borrar)
    store.all('events').forEach(e => {
      if (e.tycSigned) { if (e.userId) signedUserIds.add(+e.userId); (e.coUsers || []).forEach(x => signedUserIds.add(+x)); }
      (e.coUsers || []).forEach(x => { if (+x !== +e.userId) coUserIds.add(+x); });
      if (e.userId) ownerEvent[+e.userId] = { id: e.id, conyuges: e.conyuges || '', fecha: e.fecha || '' };
    });
    const list = users.all().map(u => {
      // Firmado si: firmó en la intranet nueva (tycSign), o en los datos del evento (ev.tycSigned),
      // o tiene el booleano "tyc" del sistema anterior puesto a true (así es como se guardaban las firmas antiguas).
      const signed = u.role === 'user' && (!!(u.tycSign && u.tycSign.date) || u.tyc === true || signedUserIds.has(+u.id));
      // El cotitular (no es el titular de su evento) no firma: su pareja ya firmó por ambos.
      // Tampoco firman las bodas de 2026 y anteriores (o sin fecha): el TYC es desde 2027.
      const evFecha = (ownerEvent[+u.id] || {}).fecha || '';
      const needsYear = evFecha && evFecha >= '2027-01-01';
      const tycExempt = u.role === 'user' && !signed && (coUserIds.has(+u.id) || !needsYear);
      return Object.assign({}, u, { tycSigned: signed, tycExempt, ownedEvent: ownerEvent[+u.id] || null });
    });
    return ok(res, { users: list });
  }
  if (seg.length === 1 && method === 'POST') {
    const body = await readBody(req);
    if (!body.email) return fail(res, 400, 'El email es obligatorio.');
    if (users.byEmail(body.email)) return fail(res, 409, 'Ya existe un usuario con ese email.');
    const u = users.create({ email: body.email, name: body.name || '', role: body.role || 'user', data: body.data || {} });
    const invite = await makeInvite(u);
    store.audit(user.id, 'user-create', 'users', u.id);
    return ok(res, { user: u, invite });
  }
  const id = +seg[1];
  if (!id || !users.get(id)) return fail(res, 404, 'Usuario no encontrado');
  if (method === 'PUT') {
    const body = await readBody(req);
    if (body.email && users.byEmail(body.email) && users.byEmail(body.email).id !== id) return fail(res, 409, 'Ese email ya está en uso.');
    const u = users.update(id, body);
    store.audit(user.id, 'user-update', 'users', id);
    return ok(res, { user: u });
  }
  if (method === 'DELETE') {
    if (id === user.id) return fail(res, 400, 'No puedes eliminar tu propia cuenta.');
    users.del(id); auth.endAllSessions(id);
    // Quitar al usuario borrado de los accesos (coUsers) de cualquier boda, para que no quede
    // una entrada "fantasma" con botón de quitar en "Acceso a la boda".
    store.all('events').forEach(e => { if ((e.coUsers || []).some(x => +x === id)) { e.coUsers = e.coUsers.filter(x => +x !== id); store.put('events', e); } });
    store.audit(user.id, 'user-delete', 'users', id);
    return ok(res, { ok: true });
  }
  if (seg[2] === 'invite' && method === 'POST') { const u = users.get(id); return ok(res, { invite: await makeInvite(u) }); }
  // Enlace de autologin ("entrar como") para administración: abre la sesión de ese usuario SIN
  // enviar ningún correo. Útil para revisar la intranet tal como la ve el novio/planner/DJ.
  if (seg[2] === 'magic-link' && method === 'GET') {
    try {
      if (user.role !== 'admin') return fail(res, 403, 'Solo administración.');
      const u = users.get(id);
      if (!u) return fail(res, 404, 'Usuario no encontrado');
      // La tabla tokens solo permite kind IN ('invite','reset','albaran'); 'albaran' sirve de
      // autologin (albaranLogin lo acepta) y dura 7 días, ideal para "entrar como".
      const token = auth.createToken(id, 'albaran');
      const ownEv = store.all('events').find(e => +e.userId === id);
      const evId = (u.eventId || (ownEv && ownEv.id)) || '';
      const base = (APP_URL() || '') || ('http://' + (req.headers.host || '200.234.226.246'));
      const link = `${base}/#/albaran?token=${token}${evId ? '&ev=' + evId : ''}`;
      store.audit(user.id, 'magic-link', 'users', id);
      return ok(res, { link, user: { id: u.id, name: u.name, role: u.role }, eventId: evId });
    } catch (e) { return fail(res, 500, 'magic-link: ' + (e && e.message || e)); }
  }
  return fail(res, 405, 'Método no permitido');
}
async function makeInvite(u) {
  const token = auth.createToken(u.id, 'invite');
  const link = `${APP_URL() || ''}/#/activar?token=${token}`;
  const out = { link, sent: false, to: (u && u.email) || '' };
  if (!u || !u.email) { out.reason = 'no-email'; return out; }
  if (!mail.enabled()) { out.reason = 'disabled'; return out; }
  try {
    const em = emails.inviteEmail(u, link, APP_URL());   // email HTML bonito, con texto según el rol
    const r = await mail.sendMail({ to: u.email, subject: em.subject, text: em.text, html: em.html });
    // sendMail devuelve {skipped} si el destinatario no está en la lista blanca, {disabled} si el
    // correo está apagado, o nada/ok si se envió. Reflejamos el resultado real para no mentir en la UI.
    if (r && r.skipped) out.reason = 'allowlist';
    else if (r && r.disabled) out.reason = 'disabled';
    else out.sent = true;
  } catch (e) { out.reason = 'error'; out.error = e.message; console.error('[invitación] email:', e.message); }
  return out;
}

/* ---------- facturación ---------- */
// Calcula los beneficios del negocio (facturado, gastos, beneficio) por mes y año,
// a partir de las bodas ya realizadas. Facturado = ingresos finca + cliente.
const BEN_MN = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
function computeBeneficios() {
  const now = new Date(); const curY = now.getFullYear();
  const months = {};
  let yIng = 0, yCost = 0, yBen = 0;
  fact.prime();  // precarga cachés una sola vez (evita refrescar por cada boda)
  store.all('events').forEach(ev => {
    if (!evRealized(ev)) return;
    const ym = String(ev.fecha || '').slice(0, 7); if (!/^\d{4}-\d{2}$/.test(ym)) return;
    let t; try { t = fact.eventTotals(ev, true); } catch (e) { return; }
    const m = months[ym] || (months[ym] = { ing: 0, cost: 0, ben: 0 });
    m.ing += t.ingresos; m.cost += t.coste; m.ben += t.beneficio;
    if (ym.slice(0, 4) === String(curY)) { yIng += t.ingresos; yCost += t.coste; yBen += t.beneficio; }
  });
  const chart = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(curY, now.getMonth() - i, 1);
    const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const m = months[ym] || { ing: 0, cost: 0, ben: 0 };
    chart.push([BEN_MN[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2), Math.round(m.ing), Math.round(m.cost), Math.round(m.ben)]);
  }
  const monthly = [];
  for (let mo = 0; mo < 12; mo++) {
    const ym = curY + '-' + String(mo + 1).padStart(2, '0');
    const m = months[ym] || { ing: 0, cost: 0, ben: 0 };
    monthly.push({ mes: BEN_MN[mo], facturado: Math.round(m.ing), gastos: Math.round(m.cost), beneficio: Math.round(m.ben) });
  }
  return { year: [Math.round(yIng), Math.round(yCost), Math.round(yBen)], chart, monthly, anio: curY };
}
function finance(req, res, user, seg, method) {
  if (user.role === 'admin') {
    if (seg[1] === 'workers' && method === 'GET') {
      // Saldo pendiente REAL de cada trabajador (histórico + eventos realizados + ajustes − pagos),
      // en vivo y en una sola pasada. Antes dependía de la colección 'workers' (podía estar vacía).
      const bals = fact.allBalances();
      const workers = Object.keys(bals).filter(id => +id).map(id => {
        const b = bals[id]; const pays = store.byOwner('payments', +id);
        const paid = pays.reduce((t, p) => t + (+p.amount || 0), 0);
        let last = b.last; pays.forEach(p => { if (p.date && p.date > last) last = p.date; });
        return { id: +id, name: userName(+id), pend: Math.round((b.rest - paid) * 100) / 100, last };
      }).filter(w => w.pend !== 0 || w.last);
      workers.sort((a, b) => b.pend - a.pend);
      return ok(res, { workers });
    }
    if (seg[1] === 'beneficios' && method === 'GET') return ok(res, computeBeneficios());
    if (seg[1] === 'history') {
      const id = +seg[2];
      // facturación en vivo: histórico + eventos ya realizados (incluye precios recién puestos)
      const h = fact.aggregateFor(id);
      if (method === 'GET') return ok(res, { history: h, payments: store.byOwner('payments', id) });
    }
    if (seg[1] === 'pay' && method === 'POST') return addPayment(req, res, user);
    if (seg[1] === 'adjust' && method === 'POST') return addAdjust(req, res, user);
    if (seg[1] === 'adjust' && method === 'DELETE') { const aid = +seg[2]; store.del('adjustments', aid); store.audit(user.id, 'adjust-del', 'adjustments', aid); return ok(res, { ok: true }); }
    return fail(res, 404, 'Ruta no encontrada');
  }
  // DJ: solo su propio balance (histórico + eventos realizados)
  if (user.role === 'dj') {
    if (seg[1] === 'me' && method === 'GET') {
      return ok(res, { history: fact.aggregateFor(user.id), payments: store.byOwner('payments', user.id) });
    }
  }
  return fail(res, 403, 'Sin acceso');
}
async function addAdjust(req, res, user) {
  const body = await readBody(req);
  const uid = +body.userId, amt = Math.round((+body.amount || 0) * 100) / 100;
  if (!uid) return fail(res, 400, 'Falta el trabajador.');
  if (!amt) return fail(res, 400, 'Indica un importe distinto de cero (positivo o negativo).');
  const rec = { id: store.nextId('adjustments'), userId: uid, amount: amt, concept: String(body.concept || '').slice(0, 120), date: body.date || bizToday() };
  store.put('adjustments', rec);
  store.audit(user.id, 'adjust-add', 'adjustments', rec.id);
  return ok(res, { ok: true, adjustment: rec });
}
async function addPayment(req, res, user) {
  const body = await readBody(req);
  const rec = store.put('payments', { userId: +body.userId, date: body.date || bizToday(),
    amount: +body.amount || 0, description: body.description || '-' });
  store.audit(user.id, 'payment', 'payments', rec.id);
  return ok(res, { payment: rec });
}

/* ---------- resúmenes de control horario ---------- */
function minutesOf(a) {
  return (a.slots || []).reduce((t, s) => { let d = toMin(s.out) - toMin(s.in); if (d < 0) d += 1440; return t + d; }, 0);
}
const toMin = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
// Fecha de "hoy" en España (Europe/Madrid) como 'YYYY-MM-DD'. Se usa para no contar
// como realizados/vencidos los eventos o vacaciones futuros. (Antes se llamaba en varios
// sitios sin estar definida, lo que hacía fallar resumen, vehículos y las alertas del panel.)
function bizToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }); }
const ES_MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
function ymShift(ym, delta) { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + delta, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function ymLabel(ym) { const [y, m] = ym.split('-').map(Number); return ES_MONTHS[m - 1] + ' ' + y; }
// Minutos fichados de un trabajador en un mes concreto (YYYY-MM). No se toca (iba bien).
function fichajeMinutesAt(uid, ym) {
  return store.byOwner('attendances', uid).filter(a => (a.date || '').startsWith(ym)).reduce((t, a) => t + minutesOf(a), 0);
}
// Minutos de vacaciones en un mes: cada día laborable (L-V) de una vacación APROBADA cuenta
// como 8 h, pero SOLO una vez ha llegado ese día (no por adelantado aunque esté confirmada).
function vacationMinutesAt(uid, ym) {
  const today = bizToday();
  let mins = 0;
  store.all('vacations').forEach(v => {
    if (v.userId != uid || v.status !== 'Aprobado' || !v.start || !v.end) return;
    const end = new Date(v.end + 'T00:00:00');
    let d = new Date(v.start + 'T00:00:00');
    while (d <= end) {
      const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const dow = d.getDay();
      if (ds.startsWith(ym) && ds <= today && dow >= 1 && dow <= 5) mins += 480;
      d.setDate(d.getDate() + 1);
    }
  });
  return mins;
}
function attendanceSummary(req, res, user, url) {
  const curYm = new Date().toISOString().slice(0, 7);
  let endYm = (url && url.searchParams && url.searchParams.get('end')) || curYm;
  if (!/^\d{4}-\d{2}$/.test(endYm) || endYm > curYm) endYm = curYm;
  const yms = [0, 1, 2, 3].map(i => ymShift(endYm, -i)); // m0 (reciente) .. m3 (antiguo)
  const months = yms.map(ymLabel);
  const total = (id, ym) => fichajeMinutesAt(id, ym) + vacationMinutesAt(id, ym);
  const rowFor = id => ({ id, name: userName(id), m0: total(id, yms[0]), m1: total(id, yms[1]), m2: total(id, yms[2]), m3: total(id, yms[3]) });
  const prev = ymShift(endYm, -4);
  const next = endYm < curYm ? (ymShift(endYm, 4) > curYm ? curYm : ymShift(endYm, 4)) : null;
  if (user.role === 'admin') {
    const ids = [...new Set([].concat(store.all('attendances').map(a => a.userId), store.all('vacations').filter(v => v.status === 'Aprobado').map(v => v.userId)).filter(Boolean))];
    const rows = ids.map(rowFor).filter(r => r.m0 || r.m1 || r.m2 || r.m3);
    rows.sort((a, b) => (b.m0 + b.m1 + b.m2 + b.m3) - (a.m0 + a.m1 + a.m2 + a.m3));
    return ok(res, { end: endYm, months, rows, prev, next });
  }
  if (user.role === 'dj') return ok(res, { end: endYm, months, rows: [rowFor(user.id)], prev, next });
  return fail(res, 403, 'Sin acceso');
}
const userName = id => (users.get(id) || {}).name || '';

/* ---------- archivos ---------- */
// Nombre seguro para disco y ruta organizada por boda: uploads/boda-<id>/<fileid>-<nombre>
const safeName = n => String(n || 'archivo').normalize('NFKD').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'archivo';
const colPrefix = c => (c === 'maintenance' ? 'mant-' : c === 'payslip' ? 'nomina-' : 'boda-');
// Carpeta en disco de una nómina: nomina-<trabajador>/<año>/<mes> (organizado por trabajador, año y mes).
const payslipDir = (uid, period) => { const m = String(period || '').match(/^(\d{4})-(\d{2})/); return path.join(UPLOADS, 'nomina-' + uid, m ? path.join(m[1], m[2]) : 'sin-fecha'); };
const fileFull = f => (f.collection === 'payslip')
  ? path.join(payslipDir(f.record_id, f.description), f.id + '-' + safeName(f.name))
  : path.join(UPLOADS, colPrefix(f.collection) + f.record_id, f.id + '-' + safeName(f.name));

/* ---------- Liberar espacio: adjuntos de bodas pasadas hace más de N meses ----------
 * SOLO toca archivos de EVENTOS (collection='events': fotos y adjuntos de la boda) y el logo de
 * fotomatón (dataURL que pesa en la BD). NUNCA toca nóminas (collection='payslip') ni mantenimiento.
 * Es irreversible en el servidor, pero los archivos siguen en la copia de la nube durante su retención. */
function cleanupCutoff(months) { const d = new Date(); d.setMonth(d.getMonth() - (+months || 3)); return d.toISOString().slice(0, 10); }
function cleanupOldEvents(months) { const cut = cleanupCutoff(months); return store.all('events').filter(e => { const f = (e.fecha || '').slice(0, 10); return f && f < cut; }); }
function cleanupPreview(months) {
  const evs = cleanupOldEvents(months);
  const sel = db().prepare("SELECT size FROM files WHERE collection='events' AND record_id=?");
  let files = 0, bytes = 0, logos = 0, logoBytes = 0; const evSet = new Set();
  evs.forEach(e => {
    sel.all(+e.id).forEach(r => { files++; bytes += (+r.size || 0); evSet.add(e.id); });
    const fl = e.disco && e.disco.fotoLogo;
    if (typeof fl === 'string' && fl.slice(0, 5) === 'data:') { logos++; logoBytes += fl.length; evSet.add(e.id); }
  });
  return { months: +months || 3, cutoff: cleanupCutoff(months), oldEvents: evs.length, events: evSet.size, files, bytes, logos, logoBytes, totalBytes: bytes + logoBytes };
}
function cleanupRun(months, uid) {
  const evs = cleanupOldEvents(months);
  const sel = db().prepare("SELECT * FROM files WHERE collection='events' AND record_id=?");
  const del = db().prepare('DELETE FROM files WHERE id = ?');
  let files = 0, bytes = 0, logos = 0;
  evs.forEach(e => {
    sel.all(+e.id).forEach(f => {
      try { fs.unlinkSync(fileFull(f)); } catch (err) { try { fs.unlinkSync(path.join(UPLOADS, f.id)); } catch (e2) {} }
      del.run(f.id); files++; bytes += (+f.size || 0);
    });
    try { fs.rmdirSync(path.join(UPLOADS, 'boda-' + e.id)); } catch (err) {}
    if (e.disco && typeof e.disco.fotoLogo === 'string' && e.disco.fotoLogo.slice(0, 5) === 'data:') { e.disco.fotoLogo = ''; store.put('events', e); logos++; }
  });
  if (files || logos) store.audit(uid, 'cleanup-attachments:' + files + 'f/' + logos + 'logos/' + bytes + 'b', 'events', null);
  return { months: +months || 3, oldEvents: evs.length, files, bytes, logos };
}
/* ---------- planos de montaje ----------
 * Imagen (vista aérea) guardada en disco; símbolos ("marks") en un setting.
 * Clave = keyBase: plantilla de finca "<locId>_<pack>" o copia de evento "ev_<id>".
 * Solo admin y DJ/técnico.
 */
const PLANO_DIR = path.join(UPLOADS, 'planos');
fs.mkdirSync(PLANO_DIR, { recursive: true });
const planoSafe = k => String(k || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
async function planosApi(req, res, user, seg, method) {
  if (!user || !(user.role === 'admin' || user.role === 'dj')) return fail(res, 403, 'Sin acceso');
  const key = planoSafe(seg[1]);
  if (!key) return fail(res, 400, 'Falta la clave del plano');
  const full = path.join(PLANO_DIR, key);
  if (seg[2] === 'img' && method === 'GET') {
    const mimes = store.setting('planoImgMime') || {};
    if (!mimes[key] || !fs.existsSync(full)) return fail(res, 404, 'Sin imagen');
    res.writeHead(200, { 'Content-Type': mimes[key], 'Cache-Control': 'no-cache' });
    return fs.createReadStream(full).pipe(res);
  }
  if (seg[2] === 'img' && method === 'POST') {
    const parts = await parseMultipart(req);
    const p = parts.find(x => x.filename && x.content.length);
    if (!p) return fail(res, 400, 'Sin imagen');
    if (p.content.length > MAX_UPLOAD) return fail(res, 413, 'Imagen demasiado grande');
    fs.writeFileSync(full, p.content);
    const mimes = store.setting('planoImgMime') || {}; mimes[key] = p.type || 'image/png'; store.setSetting('planoImgMime', mimes);
    store.audit(user.id, 'plano-img');
    return ok(res, { ok: true });
  }
  if (seg[2] === 'img' && method === 'DELETE') {
    try { fs.unlinkSync(full); } catch (e) {}
    const mimes = store.setting('planoImgMime') || {}; delete mimes[key]; store.setSetting('planoImgMime', mimes);
    return ok(res, { ok: true });
  }
  if (seg[2] === 'marks' && method === 'PUT') {
    const body = await readBody(req);
    const all = store.setting('planoMarks') || {}; all[key] = body.marks || []; store.setSetting('planoMarks', all);
    return ok(res, { ok: true });
  }
  if (!seg[2] && method === 'GET') {
    const all = store.setting('planoMarks') || {}; const mimes = store.setting('planoImgMime') || {};
    return ok(res, { marks: all[key] || [], hasImg: !!mimes[key] });
  }
  if (!seg[2] && method === 'DELETE') {
    try { fs.unlinkSync(full); } catch (e) {}
    const all = store.setting('planoMarks') || {}; delete all[key]; store.setSetting('planoMarks', all);
    const mimes = store.setting('planoImgMime') || {}; delete mimes[key]; store.setSetting('planoImgMime', mimes);
    return ok(res, { ok: true });
  }
  return fail(res, 404, 'No encontrado');
}
async function filesApi(req, res, user, seg, method, url) {
  if (method === 'POST') {
    const col = seg[1], rid = +seg[2];
    if (col === 'events') {
      const ev = store.get('events', rid);
      if (!ev || !perm.canSeeEvent(user, ev)) return fail(res, 404, 'Evento no encontrado');
      if (user.role === 'user' && !ev.editUser) return fail(res, 403, 'La edición no está habilitada.');
    } else if (col === 'maintenance') {
      const m = store.get('maintenance', rid);
      if (!m) return fail(res, 404, 'Parte no encontrado');
      if (user.role !== 'admin' && +m.userId !== +user.id) return fail(res, 403, 'Sin acceso');
    } else if (col === 'payslip') {
      // Nóminas: rid = id del trabajador. SOLO administración puede subir nóminas; el DJ/técnico
      // únicamente las ve y descarga. Wedding planner y cliente no tienen acceso.
      if (user.role !== 'admin') return fail(res, 403, 'Solo administración puede subir nóminas.');
      if (!users.get(rid)) return fail(res, 404, 'Trabajador no encontrado');
    } else return fail(res, 400, 'Colección no admitida');
    const parts = await parseMultipart(req);
    const momPart = parts.find(p => p.name === 'momento' && !p.filename);
    const momento = momPart ? momPart.content.toString('utf8').trim().slice(0, 120) : '';
    const saved = [];
    for (const p of parts.filter(p => p.filename && p.content.length)) {
      if (p.content.length > MAX_UPLOAD) return fail(res, 413, 'Archivo demasiado grande');
      const id = crypto.randomBytes(12).toString('hex');
      const dir = (col === 'payslip') ? payslipDir(rid, momento) : path.join(UPLOADS, colPrefix(col) + rid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id + '-' + safeName(p.filename)), p.content);
      db().prepare('INSERT INTO files (id, collection, record_id, name, description, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, col, rid, p.filename, momento, p.type || 'application/octet-stream', p.content.length, user.id);
      saved.push({ id, name: p.filename, size: p.content.length, momento });
    }
    store.audit(user.id, 'file-upload', col, rid);
    return ok(res, { files: saved });
  }
  if (method === 'GET' && seg[1] === 'list') {
    const ev = store.get('events', +seg[2]);
    if (!ev || !perm.canSeeEvent(user, ev)) return fail(res, 404, 'No encontrado');
    const rows = db().prepare('SELECT id, name, description AS momento, mime, size, created_at FROM files WHERE collection = ? AND record_id = ? ORDER BY created_at').all('events', +seg[2]);
    return ok(res, { files: rows });
  }
  if (method === 'GET' && seg[1] === 'mant-list') {
    const m = store.get('maintenance', +seg[2]);
    if (!m) return fail(res, 404, 'No encontrado');
    if (user.role !== 'admin' && +m.userId !== +user.id) return fail(res, 403, 'Sin acceso');
    const rows = db().prepare('SELECT id, name, mime, size, created_at FROM files WHERE collection = ? AND record_id = ? ORDER BY created_at').all('maintenance', +seg[2]);
    return ok(res, { files: rows });
  }
  if (method === 'GET' && seg[1] === 'payslip-list') {
    // Nóminas de un trabajador: admin cualquiera; un trabajador solo las suyas. description = periodo "YYYY-MM".
    const uid = +seg[2];
    // Solo admin (cualquiera) o un DJ/técnico (las suyas). Wedding planner y cliente: nunca.
    if (user.role !== 'admin' && !(user.role === 'dj' && uid === +user.id)) return fail(res, 403, 'Sin acceso');
    const rows = db().prepare('SELECT id, name, description AS period, mime, size, created_at FROM files WHERE collection = ? AND record_id = ? ORDER BY description DESC, created_at DESC').all('payslip', uid);
    return ok(res, { files: rows });
  }
  if (method === 'GET') {
    const fid = seg[1];
    const f = db().prepare('SELECT * FROM files WHERE id = ?').get(fid);
    if (!f) return fail(res, 404, 'Archivo no encontrado');
    let allowed;
    if (f.collection === 'maintenance') { const m = store.get('maintenance', f.record_id); allowed = !!m && (user.role === 'admin' || +m.userId === +user.id); }
    else if (f.collection === 'payslip') { allowed = (user.role === 'admin' || (user.role === 'dj' && +f.record_id === +user.id)); }
    else { const ev = store.get(f.collection, f.record_id); allowed = !!ev && perm.canSeeEvent(user, ev); }
    if (!allowed) return fail(res, 403, 'Sin acceso');
    let full = fileFull(f);
    if (!fs.existsSync(full)) full = path.join(UPLOADS, fid); // compatibilidad con archivos antiguos (planos)
    if (!fs.existsSync(full)) return fail(res, 404, 'Archivo no disponible');
    res.writeHead(200, { 'Content-Type': f.mime, 'Content-Disposition': `inline; filename="${encodeURIComponent(f.name)}"`, 'Content-Length': f.size });
    return fs.createReadStream(full).pipe(res);
  }
  if (method === 'DELETE') {
    const fid = seg[1];
    const f = db().prepare('SELECT * FROM files WHERE id = ?').get(fid);
    // Solo administración puede borrar archivos (incluidas nóminas). Un DJ/técnico no borra sus nóminas.
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración puede borrar archivos.');
    if (f) { try { fs.unlinkSync(fileFull(f)); } catch (e) { try { fs.unlinkSync(path.join(UPLOADS, fid)); } catch (e2) {} } db().prepare('DELETE FROM files WHERE id = ?').run(fid); }
    return ok(res, { ok: true });
  }
  return fail(res, 405, 'Método no permitido');
}
const db = () => require('./db').db;

/* ---------- colecciones genéricas ---------- */
async function collection(req, res, user, seg, method) {
  const col = seg[1];
  const policy = perm.POLICY[col];
  if (!policy) return fail(res, 404, 'Colección no encontrada');

  if (method === 'GET' && seg.length === 2) {
    let list;
    if (policy.read === 'all' || user.role === 'admin') list = store.all(col);
    else if (policy.read === 'own') list = store.byOwner(col, user.id);
    else if (Array.isArray(policy.read)) list = policy.read.includes(user.role) ? store.all(col) : null;
    else list = null;
    if (!list) return fail(res, 403, 'Sin acceso');
    return ok(res, { items: list });
  }
  const canWrite = policy.write.includes(user.role);
  if ((method === 'POST' || method === 'PUT') && canWrite) {
    const body = await readBody(req);
    let rec = body.item || body;
    if (method === 'PUT') {
      // Fusiona con el registro existente: un guardado parcial (p. ej. solo los datos de
      // desplazamiento de una finca, sin el nombre) ya NO borra el resto de campos.
      const cur = store.get(col, +seg[2]);
      rec = Object.assign({}, cur || {}, rec, { id: +seg[2] });
    }
    if (policy.ownWrite && policy.ownWrite.includes(user.role)) rec.userId = user.id; // el DJ solo escribe lo suyo
    if (col === 'maintenance' && user.role !== 'admin') {
      // El DJ no decide urgencia ni estado: los fija administración. Un parte nuevo nace pendiente.
      const prev = (method === 'PUT') ? store.get(col, rec.id) : null;
      rec.urgency = prev ? prev.urgency : 'media';
      rec.status = prev ? prev.status : 'pendiente';
      rec.fixedAt = prev ? prev.fixedAt : null;
      if (method === 'POST') rec.date = bizToday();
    }
    if (col === 'maintenance' && user.role === 'admin' && method === 'PUT' && rec.status === 'completado' && !rec.fixedAt) rec.fixedAt = bizToday();
    if (method === 'PUT' && policy.read === 'own' && user.role !== 'admin') {
      const cur = store.get(col, rec.id);
      if (!cur || +cur.userId !== +user.id) return fail(res, 403, 'Sin acceso');
    }
    const saved = store.put(col, rec);
    store.audit(user.id, col + '-save', col, saved.id);
    return ok(res, { item: saved });
  }
  if (method === 'DELETE' && canWrite) {
    const id = +seg[2];
    if (policy.read === 'own' && user.role !== 'admin') {
      const cur = store.get(col, id);
      if (!cur || +cur.userId !== +user.id) return fail(res, 403, 'Sin acceso');
    }
    store.del(col, id); store.audit(user.id, col + '-delete', col, id);
    return ok(res, { ok: true });
  }
  return fail(res, 403, 'Sin permiso para esta acción');
}

/* ---------- paracaídas: un error inesperado en segundo plano NO debe tumbar el servidor ----------
   Cada petición ya va protegida; esto cubre lo demás (temporizadores, streams, promesas sueltas):
   se registra el error en el log y el servidor sigue en pie en vez de caerse. */
process.on('uncaughtException', (e) => { console.error('[uncaughtException] el servidor sigue en pie:', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection] el servidor sigue en pie:', e && e.stack || e); });

/* ---------- servidor ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/uploads/')) return fail(res, 403, 'Prohibido'); // los archivos van por /api/files
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e && e.status) return fail(res, e.status, e.message);
    console.error('Error:', e);
    return fail(res, 500, 'Error interno del servidor');
  }
});
server.listen(PORT, HOST, () => {
  console.log(`Gestor Conecta So escuchando en http://${HOST}:${PORT}`);
  if (!mail.enabled()) console.log('Aviso: SMTP no configurado — los enlaces de invitación se mostrarán en pantalla al administrador.');
  try { require('./reminders').startReminders(); } catch (e) { console.error('[recordatorios] no se pudo iniciar:', e.message); }
  try { backup.start(); } catch (e) { console.error('[backup] no se pudo iniciar:', e.message); }
  // Limpieza automática de adjuntos de bodas antiguas: una vez al día, solo si está activada.
  const runCleanupIfOn = () => {
    try { const c = store.setting('attachmentCleanup'); if (c && c.enabled) { const r = cleanupRun(c.months, null); if (r.files || r.logos) console.log('[cleanup] liberados', r.files, 'archivos y', r.logos, 'logos de', r.oldEvents, 'bodas antiguas'); } }
    catch (e) { console.error('[cleanup] error:', e.message); }
  };
  setTimeout(runCleanupIfOn, 90 * 1000);              // al arrancar (tras margen)
  setInterval(runCleanupIfOn, 24 * 60 * 60 * 1000);   // y cada 24 h
});
