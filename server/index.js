'use strict';
/**
 * Gestor de eventos de Conecta So — servidor HTTP sin dependencias externas.
 * Node 22+ (usa node:sqlite integrado). Arranque: npm start
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { store, users, DATA_DIR } = require('./db');
const auth = require('./auth');
const mail = require('./mail');
const perm = require('./permissions');
const fact = require('./facturacion');
const { evFinished } = require('./time');

const PORT = +(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, '..', 'public');
const UPLOADS = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
const MAX_UPLOAD = +(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024;
const APP_URL = () => (process.env.APP_URL || '').replace(/\/$/, '');

/* ---------- utilidades HTTP ---------- */
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }, headers));
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
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon', '.pdf': 'application/pdf' };

/* ---------- servir ficheros estáticos ---------- */
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const full = path.normalize(path.join(PUBLIC, rel));
  if (!full.startsWith(PUBLIC)) return fail(res, 403, 'Prohibido');
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA: rutas del cliente devuelven index.html
      if (!path.extname(rel)) return fs.readFile(path.join(PUBLIC, 'index.html'), (e, d) => e ? fail(res, 404, 'No encontrado') : send(res, 200, d, { 'Content-Type': 'text/html; charset=utf-8' }));
      return fail(res, 404, 'No encontrado');
    }
    const ext = path.extname(full).toLowerCase();
    const cache = /\/assets\//.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache';
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
  const user = auth.sessionUser(req);

  // --- autenticación pública ---
  if (seg[0] === 'auth') {
    if (seg[1] === 'login' && method === 'POST') return login(req, res);
    if (seg[1] === 'logout' && method === 'POST') { auth.destroySession(req, res); return ok(res, { ok: true }); }
    if (seg[1] === 'me' && method === 'GET') return ok(res, { user: user ? meView(user) : null, mailEnabled: mail.enabled() });
    if (seg[1] === 'invite-info' && method === 'GET') return inviteInfo(req, res, url);
    if (seg[1] === 'activate' && method === 'POST') return activate(req, res);
    if (seg[1] === 'forgot' && method === 'POST') return forgot(req, res);
    if (seg[1] === 'change-password' && method === 'POST') return changePassword(req, res, user);
    return fail(res, 404, 'Ruta no encontrada');
  }

  if (!user) return fail(res, 401, 'Necesitas iniciar sesión');

  // --- metadatos (catálogos para la interfaz) ---
  if (seg[0] === 'meta' && method === 'GET') return ok(res, meta(user));
  if (seg[0] === 'brand' && method === 'GET') return ok(res, store.setting('brand') || {});

  // --- eventos ---
  if (seg[0] === 'events') return events(req, res, user, seg, method, url);

  // --- usuarios ---
  if (seg[0] === 'users') return usersApi(req, res, user, seg, method);

  // --- facturación / beneficios ---
  if (seg[0] === 'finance') return finance(req, res, user, seg, method);

  // --- contrato TyC (firma del cliente) ---
  if (seg[0] === 'tyc') return tycApi(req, res, user, seg, method);

  // --- avisos del panel de inicio (admin) ---
  if (['price-alerts', 'vacation-conflicts', 'itv-alerts', 'staff-conflicts', 'price-fix', 'dup-ack'].includes(seg[0])) return dashboardAlerts(req, res, user, seg, method);

  // --- control horario (resúmenes) ---
  if (seg[0] === 'attendance-summary') return attendanceSummary(req, res, user, seg);

  // --- archivos ---
  if (seg[0] === 'files') return filesApi(req, res, user, seg, method, url);

  // --- colecciones genéricas ---
  if (seg[0] === 'collections') return collection(req, res, user, seg, method);

  return fail(res, 404, 'Ruta no encontrada');
}

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
  out.tycSigned = tycSignedBy(u);
  return out;
}

/* ---------- contrato TyC ---------- */
const DEFAULT_TYC = '<p><strong>Términos y condiciones de servicio</strong></p>'
  + '<p>El presente documento regula la prestación de servicios de Conecta So (DJ, sonorización, iluminación y animación) para el evento indicado.</p>';
function tycRec(t) { t = t || {}; return { id: t.id || 1, version: String(t.date || t.version || '1'), title: t.title || ('Términos y condiciones de servicio ' + (t.date || '')).trim(), text: t.text || DEFAULT_TYC }; }
function tycCurrent() { const list = store.all('tacs'); return tycRec(list[list.length - 1] || {}); }
function tycByVersion(v) { const t = store.all('tacs').find(x => String(x.date || x.version) === String(v)); return tycRec(t || store.all('tacs').slice(-1)[0] || {}); }
function eventOfUser(u) {
  if (!u || u.role !== 'user') return null;
  return store.all('events').find(e => e.userId == u.id || (e.coUsers || []).map(String).indexOf(String(u.id)) >= 0) || null;
}
function tycSignedBy(u) {
  if (!u || u.role !== 'user') return false;
  if (u.tycSign && u.tycSign.date) return true;           // firma hecha en la intranet nueva
  const ev = eventOfUser(u); return !!(ev && ev.tycSigned); // firma ya registrada en los datos reales
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
  if (u.tycSign && u.tycSign.date) return u.tycSign;
  const ev = eventOfUser(u);
  if (ev && ev.tycSigned) { const a = tycAutofill(u); return { name: ev.tycSigner || a.novios || '', dni: a.dnis || '', date: ev.tycSignedAt || '', version: String(ev.tycVersion || '2027') }; }
  return null;
}
async function tycApi(req, res, user, seg, method) {
  if (!user) return fail(res, 401, 'Necesitas iniciar sesión');
  const c = tycCurrent();
  if (seg[1] === 'current' && method === 'GET') {
    return ok(res, { tyc: c, signed: tycSignedBy(user), signature: tycSignatureFor(user), autofill: tycAutofill(user) });
  }
  if (seg[1] === 'sign' && method === 'POST') {
    if (user.role !== 'user') return fail(res, 403, 'Solo los clientes firman el contrato.');
    const body = await readBody(req);
    const sign = { version: c.version, name: body.name || user.name, dni: body.dni || '', dni2: body.dni2 || '', date: new Date().toISOString() };
    users.update(user.id, { data: { tycSign: sign } });
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
async function forgot(req, res) {
  const ip = auth.clientIp(req);
  const { email } = await readBody(req);
  const row = users.byEmail(email);
  // Respuesta uniforme para no revelar qué correos existen
  if (row && row.active && !auth.rateLimited('forgot:' + ip, 5)) {
    auth.noteAttempt('forgot:' + ip);
    const token = auth.createToken(row.id, 'reset');
    const link = `${APP_URL() || ''}/activar?token=${token}`;
    if (mail.enabled()) {
      mail.sendMail({ to: row.email, subject: 'Restablece tu contraseña · Conecta So',
        text: `Hola,\n\nPara crear una nueva contraseña entra en:\n${link}\n\nEl enlace caduca en 24 horas. Si no lo has pedido, ignora este mensaje.` }).catch(() => {});
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
const PRICE_ALERT_SKIP = [227, 1095, 234, 292, 1813, 276, 713];
const uName = id => (users.get(id) || {}).name || ('#' + id);
function onVacation(workerId, date) {
  if (!workerId || !date) return null;
  return store.all('vacations').find(v => v.userId == workerId && v.status !== 'Denegado' && v.start && v.end && date >= v.start && date <= v.end) || null;
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
async function dashboardAlerts(req, res, user, seg, method) {
  if (!user || user.role !== 'admin') return fail(res, 403, 'Sin acceso');
  if (seg[0] === 'staff-conflicts') return ok(res, staffConflicts());
  if (seg[0] === 'vacation-conflicts') return ok(res, vacationConflicts());
  if (seg[0] === 'itv-alerts') return ok(res, itvAlerts());
  if (seg[0] === 'price-alerts') return ok(res, priceAlerts());
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
  const m = {
    role: user.role,
    estados: store.setting('estados'),
    tipos: store.setting('tipos'),
    // admin/DJ reciben también los datos de desplazamiento (min/km/coordenadas) y la
    // dirección, que la hoja de ruta y el cálculo de kilómetros necesitan.
    locations: store.all('locations').map(l => staffView
      ? { id: l.id, name: l.name, colorHex: l.colorHex, direction: l.direction, directionLink: l.directionLink, lat: l.lat, lng: l.lng, travelMin: l.travelMin, travelKm: l.travelKm, travelApprox: l.travelApprox }
      : { id: l.id, name: l.name, colorHex: l.colorHex }),
    extras: store.all('extras'),
  };
  if (staffView) {
    m.staff = staffList();
    m.djs = users.all().filter(u => u.role === 'dj').map(u => ({ id: u.id, name: u.name }));
    m.planners = users.all().filter(u => u.role === 'planner').map(u => ({ id: u.id, name: u.name }));
  }
  return m;
}

/* ---------- eventos ---------- */
function listEventsFor(user) {
  if (user.role === 'admin') return store.all('events');
  if (user.role === 'user') return store.byOwner('events', user.id);
  if (user.role === 'planner') return store.byWp('events', user.id);
  if (user.role === 'dj') return store.byStaff('events', user.id);
  return [];
}
async function events(req, res, user, seg, method, url) {
  // /api/events  (listado)
  if (seg.length === 1 && method === 'GET') {
    const done = url.searchParams.get('status') === 'done';
    // Un evento pasa a "realizadas" a las 05:00 del día siguiente (hora de Madrid).
    let list = listEventsFor(user).filter(e => (done ? evFinished(e) : !evFinished(e)));
    return ok(res, { events: list.map(e => perm.summarizeEvent(user, e)) });
  }
  // /api/events/:id
  const id = +seg[1];
  if (!id) return fail(res, 404, 'Evento no encontrado');
  const ev = store.get('events', id);
  if (!ev || !perm.canSeeEvent(user, ev)) return fail(res, 404, 'Evento no encontrado');

  if (method === 'GET') {
    const out = perm.sanitizeEvent(user, ev);
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
    store.audit(user.id, 'event-update', 'events', id);
    const saved = store.get('events', id);
    const out = perm.sanitizeEvent(user, saved);
    if (user.role === 'admin') { out.factRows = fact.computeFact(saved); out.revRows = fact.computeRevenue(saved); }
    return ok(res, { event: out });
  }
  if (method === 'DELETE') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración puede borrar eventos.');
    store.del('events', id); store.audit(user.id, 'event-delete', 'events', id);
    return ok(res, { ok: true });
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
  if (seg.length === 1 && method === 'GET') return ok(res, { users: users.all().map(u => Object.assign({}, u, { tycSigned: tycSignedBy(u) })) });
  if (seg.length === 1 && method === 'POST') {
    const body = await readBody(req);
    if (!body.email) return fail(res, 400, 'El email es obligatorio.');
    if (users.byEmail(body.email)) return fail(res, 409, 'Ya existe un usuario con ese email.');
    const u = users.create({ email: body.email, name: body.name || '', role: body.role || 'user', data: body.data || {} });
    const invite = makeInvite(u);
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
    users.del(id); auth.endAllSessions(id); store.audit(user.id, 'user-delete', 'users', id);
    return ok(res, { ok: true });
  }
  if (seg[2] === 'invite' && method === 'POST') { const u = users.get(id); return ok(res, { invite: makeInvite(u) }); }
  return fail(res, 405, 'Método no permitido');
}
function makeInvite(u) {
  const token = auth.createToken(u.id, 'invite');
  const link = `${APP_URL() || ''}/activar?token=${token}`;
  const out = { link, sent: false };
  if (mail.enabled() && u.email) {
    mail.sendMail({ to: u.email, subject: 'Tu acceso al gestor de Conecta So',
      text: `Hola ${u.name || ''},\n\nTienes acceso al gestor de eventos de Conecta So. Crea tu contraseña aquí:\n${link}\n\nEl enlace caduca en 14 días.` })
      .then(() => {}).catch(() => {});
    out.sent = true;
  }
  return out;
}

/* ---------- facturación ---------- */
function finance(req, res, user, seg, method) {
  if (user.role === 'admin') {
    if (seg[1] === 'workers' && method === 'GET') return ok(res, { workers: store.all('workers') });
    if (seg[1] === 'beneficios' && method === 'GET') return ok(res, store.setting('beneficios') || {});
    if (seg[1] === 'history') {
      const id = +seg[2];
      const h = store.get('history', id);
      if (method === 'GET') return ok(res, { history: h, payments: store.byOwner('payments', id) });
    }
    if (seg[1] === 'pay' && method === 'POST') return addPayment(req, res, user);
    return fail(res, 404, 'Ruta no encontrada');
  }
  // DJ: solo su propio balance
  if (user.role === 'dj') {
    if (seg[1] === 'me' && method === 'GET') {
      return ok(res, { history: store.get('history', user.id), payments: store.byOwner('payments', user.id) });
    }
  }
  return fail(res, 403, 'Sin acceso');
}
async function addPayment(req, res, user) {
  const body = await readBody(req);
  const rec = store.put('payments', { userId: +body.userId, date: body.date || new Date().toISOString().slice(0, 10),
    amount: +body.amount || 0, description: body.description || '-' });
  store.audit(user.id, 'payment', 'payments', rec.id);
  return ok(res, { payment: rec });
}

/* ---------- resúmenes de control horario ---------- */
function minutesOf(a) {
  return (a.slots || []).reduce((t, s) => { let d = toMin(s.out) - toMin(s.in); if (d < 0) d += 1440; return t + d; }, 0);
}
const toMin = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
function monthMinutes(uid, back) {
  const d = new Date(); d.setMonth(d.getMonth() - back);
  const pre = d.toISOString().slice(0, 7);
  return store.byOwner('attendances', uid).filter(a => (a.date || '').startsWith(pre)).reduce((t, a) => t + minutesOf(a), 0);
}
function attendanceSummary(req, res, user, seg) {
  if (user.role === 'admin') {
    const ids = [...new Set(store.all('attendances').map(a => a.userId).filter(Boolean))];
    const rows = ids.map(id => ({ id, name: userName(id), m0: monthMinutes(id, 0), m1: monthMinutes(id, 1), m2: monthMinutes(id, 2) }));
    return ok(res, { rows });
  }
  if (user.role === 'dj') return ok(res, { rows: [{ id: user.id, name: user.name, m0: monthMinutes(user.id, 0), m1: monthMinutes(user.id, 1), m2: monthMinutes(user.id, 2) }] });
  return fail(res, 403, 'Sin acceso');
}
const userName = id => (users.get(id) || {}).name || '';

/* ---------- archivos ---------- */
// Nombre seguro para disco y ruta organizada por boda: uploads/boda-<id>/<fileid>-<nombre>
const safeName = n => String(n || 'archivo').normalize('NFKD').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'archivo';
const fileFull = f => path.join(UPLOADS, 'boda-' + f.record_id, f.id + '-' + safeName(f.name));
async function filesApi(req, res, user, seg, method, url) {
  if (method === 'POST') {
    const col = seg[1], rid = +seg[2];
    if (col !== 'events') return fail(res, 400, 'Colección no admitida');
    const ev = store.get('events', rid);
    if (!ev || !perm.canSeeEvent(user, ev)) return fail(res, 404, 'Evento no encontrado');
    if (user.role === 'user' && !ev.editUser) return fail(res, 403, 'La edición no está habilitada.');
    const parts = await parseMultipart(req);
    const saved = [];
    for (const p of parts.filter(p => p.filename && p.content.length)) {
      if (p.content.length > MAX_UPLOAD) return fail(res, 413, 'Archivo demasiado grande');
      const id = crypto.randomBytes(12).toString('hex');
      const dir = path.join(UPLOADS, 'boda-' + rid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id + '-' + safeName(p.filename)), p.content);
      db().prepare('INSERT INTO files (id, collection, record_id, name, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, col, rid, p.filename, p.type || 'application/octet-stream', p.content.length, user.id);
      saved.push({ id, name: p.filename, size: p.content.length });
    }
    store.audit(user.id, 'file-upload', col, rid);
    return ok(res, { files: saved });
  }
  if (method === 'GET' && seg[1] === 'list') {
    const ev = store.get('events', +seg[2]);
    if (!ev || !perm.canSeeEvent(user, ev)) return fail(res, 404, 'No encontrado');
    const rows = db().prepare('SELECT id, name, mime, size, created_at FROM files WHERE collection = ? AND record_id = ? ORDER BY created_at').all('events', +seg[2]);
    return ok(res, { files: rows });
  }
  if (method === 'GET') {
    const fid = seg[1];
    const f = db().prepare('SELECT * FROM files WHERE id = ?').get(fid);
    if (!f) return fail(res, 404, 'Archivo no encontrado');
    const ev = store.get(f.collection, f.record_id);
    if (!ev || !perm.canSeeEvent(user, ev)) return fail(res, 403, 'Sin acceso');
    let full = fileFull(f);
    if (!fs.existsSync(full)) full = path.join(UPLOADS, fid); // compatibilidad con archivos antiguos (planos)
    if (!fs.existsSync(full)) return fail(res, 404, 'Archivo no disponible');
    res.writeHead(200, { 'Content-Type': f.mime, 'Content-Disposition': `inline; filename="${encodeURIComponent(f.name)}"`, 'Content-Length': f.size });
    return fs.createReadStream(full).pipe(res);
  }
  if (method === 'DELETE') {
    if (user.role !== 'admin') return fail(res, 403, 'Solo administración puede borrar archivos.');
    const fid = seg[1];
    const f = db().prepare('SELECT * FROM files WHERE id = ?').get(fid);
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
    const rec = body.item || body;
    if (method === 'PUT') rec.id = +seg[2];
    if (policy.ownWrite && policy.ownWrite.includes(user.role)) rec.userId = user.id; // el DJ solo escribe lo suyo
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
});
