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
const { evFinished, evRealized } = require('./time');

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
    if (seg[1] === 'albaran-login' && method === 'POST') return albaranLogin(req, res);
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
  // Flags que controlan qué apartados ve el DJ/técnico en su menú.
  if (u.role === 'dj') { out.vehicle_allowed = !!u.vehicle_allowed; out.time_tracking = !!u.time_tracking; }
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
  const names = String(ev.conyuges || '').split(/\s+y\s+/i).map(s => s.trim()).filter(Boolean);
  const cur = ev.spouses || [];
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
  if (!t || t.kind !== 'albaran') return fail(res, 404, 'El enlace no es válido o ha caducado.');
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
  if (user.role === 'user') return store.byOwner('events', user.id);
  if (user.role === 'planner') return store.byWp('events', user.id);
  if (user.role === 'dj') return store.byStaff('events', user.id);
  return [];
}
// Listado global de solicitudes de extras (para la pestaña "Servicios extras" y el aviso de inicio).
function extraRequestsApi(req, res, user) {
  if (!user || user.role !== 'admin') return fail(res, 403, 'Sin acceso');
  const out = [];
  store.all('events').forEach(e => { const st = e.extraStatus || {}; Object.keys(st).forEach(k => out.push({ evId: e.id, conyuges: e.conyuges || '', fecha: e.fecha || '', lugar: (store.get('locations', e.lugar) || {}).name || '', extraKey: k, estado: st[k] })); });
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
  const ids = [ev.userId].concat(ev.coUsers || []).filter(Boolean);
  out.accessUsers = ids.map(id => { const au = users.get(id) || {}; return { id: +id, name: au.name || '', email: au.email || '', owner: id == ev.userId }; });
  if (user.role === 'user') { const tot = +ev.pagoCliente || 0, pg = +ev.pagado || 0; out.pago = { total: tot, pagado: pg, pendiente: tot - pg, metodo: ev.metodo || '' }; }
  return out;
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
    if (!u) u = users.create({ email, name: body.name || email.split('@')[0], role: 'user', data: {} });
    if (u.role !== 'user') return fail(res, 400, 'Ese email ya pertenece a una cuenta del equipo.');
    ev.coUsers = ev.coUsers || [];
    if (+ev.userId !== +u.id && ev.coUsers.indexOf(u.id) < 0) ev.coUsers.push(u.id);
    store.put('events', ev); store.audit(user.id, 'invite-user', 'events', id);
    // El correo está desactivado: se genera el enlace de activación para compartir manualmente.
    const invite = makeInvite(u);
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
    ev.plus.push({ userId: body.userId ? +body.userId : null, amount, concept: body.concept || '', date: new Date().toISOString().slice(0, 10) });
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
    store.all('events').forEach(e => { if (e.tycSigned) { if (e.userId) signedUserIds.add(+e.userId); (e.coUsers || []).forEach(x => signedUserIds.add(+x)); } });
    const list = users.all().map(u => {
      const signed = u.role === 'user' && (!!(u.tycSign && u.tycSign.date) || signedUserIds.has(+u.id));
      return Object.assign({}, u, { tycSigned: signed });
    });
    return ok(res, { users: list });
  }
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
  const rec = { id: store.nextId('adjustments'), userId: uid, amount: amt, concept: String(body.concept || '').slice(0, 120), date: body.date || new Date().toISOString().slice(0, 10) };
  store.put('adjustments', rec);
  store.audit(user.id, 'adjust-add', 'adjustments', rec.id);
  return ok(res, { ok: true, adjustment: rec });
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
const fileFull = f => path.join(UPLOADS, 'boda-' + f.record_id, f.id + '-' + safeName(f.name));
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
    if (col !== 'events') return fail(res, 400, 'Colección no admitida');
    const ev = store.get('events', rid);
    if (!ev || !perm.canSeeEvent(user, ev)) return fail(res, 404, 'Evento no encontrado');
    if (user.role === 'user' && !ev.editUser) return fail(res, 403, 'La edición no está habilitada.');
    const parts = await parseMultipart(req);
    const momPart = parts.find(p => p.name === 'momento' && !p.filename);
    const momento = momPart ? momPart.content.toString('utf8').trim().slice(0, 120) : '';
    const saved = [];
    for (const p of parts.filter(p => p.filename && p.content.length)) {
      if (p.content.length > MAX_UPLOAD) return fail(res, 413, 'Archivo demasiado grande');
      const id = crypto.randomBytes(12).toString('hex');
      const dir = path.join(UPLOADS, 'boda-' + rid);
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
