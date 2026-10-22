'use strict';
/**
 * Préstamo Conecta — app independiente de la intranet.
 * No comparte código, usuarios ni base de datos con el gestor de eventos.
 * Guarda todo en un único archivo JSON dentro de /data (volumen propio).
 * Sin dependencias externas. Node 22+.
 *
 * IMPORTANTE: este repositorio es público. Aquí NO va ningún dato del préstamo:
 * importes, nombres y adelantos se guardan solo en el servidor (data-prestamo/).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'prestamo.json');
const PUBLIC = path.join(__dirname, 'public');
const COOKIE = 'pc_sesion';
const SESSION_DAYS = 180;
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- almacén JSON ---------- */
function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { return { passHash: null, sessions: {}, config: null, adelantos: [] }; }
}
let DB = load();
function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
  fs.renameSync(tmp, FILE);
  // copia de seguridad diaria (se conservan las 30 últimas)
  try {
    const bdir = path.join(DATA_DIR, 'copias');
    fs.mkdirSync(bdir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(bdir, `prestamo-${day}.json`), JSON.stringify(DB, null, 2));
    const old = fs.readdirSync(bdir).sort().slice(0, -30);
    old.forEach(f => fs.unlinkSync(path.join(bdir, f)));
  } catch (e) { /* la copia es opcional */ }
}

/* ---------- contraseña y sesiones ---------- */
function hash(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verify(pw, stored) {
  if (!stored) return false;
  const [, s, k] = stored.split('$');
  const key = Buffer.from(k, 'base64');
  const test = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), key.length);
  return crypto.timingSafeEqual(key, test);
}
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function logged(req) {
  const t = cookies(req)[COOKIE];
  if (!t) return false;
  const s = DB.sessions[sha(t)];
  return !!s && s > Date.now();
}
function newSession(res) {
  const t = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  for (const k of Object.keys(DB.sessions)) if (DB.sessions[k] < now) delete DB.sessions[k];
  DB.sessions[sha(t)] = now + SESSION_DAYS * 864e5;
  save();
  res.setHeader('Set-Cookie', `${COOKIE}=${t}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`);
}
function endSession(req, res) {
  const t = cookies(req)[COOKIE];
  if (t) { delete DB.sessions[sha(t)]; save(); }
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}
// límite de intentos: 8 fallos cada 15 minutos por IP
const tries = new Map();
function ip(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || ''; }
function limited(req) { const r = tries.get(ip(req)); return r && r.n >= 8 && Date.now() - r.t < 15 * 60e3; }
function failTry(req) { const k = ip(req); const r = tries.get(k); if (!r || Date.now() - r.t > 15 * 60e3) tries.set(k, { n: 1, t: Date.now() }); else r.n++; }

/* ---------- validación ---------- */
const isDate = s => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s);
function cleanConfig(c) {
  if (!c || typeof c !== 'object') return null;
  const total = +c.total, tasa = +c.tasa, anos = +c.anos;
  if (!(total > 0 && total < 1e8) || !(tasa >= 0 && tasa < 50) || !(anos >= 1 && anos <= 60 && Number.isInteger(anos))) return null;
  if (!isDate(c.primeraCuota) || !isDate(c.firma)) return null;
  const datos = Array.isArray(c.datos) ? c.datos.slice(0, 20).filter(d => Array.isArray(d) && d.length === 2)
    .map(([a, b]) => [String(a).slice(0, 60), String(b).slice(0, 200)]) : [];
  return { total: Math.round(total * 100) / 100, tasa, anos, primeraCuota: c.primeraCuota, firma: c.firma, datos };
}

/* ---------- HTTP ---------- */
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
};
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, SEC));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > 64 * 1024) { reject(new Error('grande')); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { resolve(ch.length ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json; charset=utf-8' };
const STATIC = new Set(['index.html', 'manifest.webmanifest', 'icon-512.png', 'icon-192.png', 'icon-180.png', 'icon-32.png',
  'fonts/lacquer.ttf', 'fonts/outer-sans-black.woff2', 'fonts/evolve-sans.woff2']);

async function api(req, res, p) {
  const m = req.method;
  if (p === '/api/estado' && m === 'GET') return send(res, 200, { tieneClave: !!DB.passHash, dentro: logged(req) });

  if (p === '/api/crear-clave' && m === 'POST') {
    if (DB.passHash) return send(res, 409, { error: 'La contraseña ya está creada.' });
    const b = await body(req);
    if (String(b.clave || '').length < 6) return send(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' });
    DB.passHash = hash(b.clave); newSession(res);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/entrar' && m === 'POST') {
    if (limited(req)) return send(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
    const b = await body(req);
    if (!verify(b.clave || '', DB.passHash)) { failTry(req); return send(res, 401, { error: 'Contraseña incorrecta.' }); }
    tries.delete(ip(req)); newSession(res);
    return send(res, 200, { ok: true });
  }

  if (!logged(req)) return send(res, 401, { error: 'Entra con tu contraseña.' });

  if (p === '/api/salir' && m === 'POST') { endSession(req, res); return send(res, 200, { ok: true }); }
  if (p === '/api/datos' && m === 'GET') return send(res, 200, { config: DB.config, adelantos: DB.adelantos });
  if (p === '/api/config' && m === 'PUT') {
    const c = cleanConfig((await body(req)).config);
    if (!c) return send(res, 400, { error: 'Revisa los datos: importe, interés, años y fechas.' });
    DB.config = c; save();
    return send(res, 200, { ok: true, config: c });
  }
  if (p === '/api/adelantos' && m === 'POST') {
    const b = await body(req);
    const importe = Math.round(+b.importe * 100) / 100;
    if (!(importe > 0) || !isDate(b.fecha)) return send(res, 400, { error: 'Pon un importe y una fecha válidos.' });
    const a = { id: crypto.randomBytes(6).toString('hex'), importe, fecha: b.fecha, modo: b.modo === 'cuota' ? 'cuota' : 'plazo',
      nota: String(b.nota || '').slice(0, 80), creado: new Date().toISOString() };
    DB.adelantos.push(a); save();
    return send(res, 200, { ok: true, adelanto: a });
  }
  const del = /^\/api\/adelantos\/([a-f0-9]{12})$/.exec(p);
  if (del && m === 'DELETE') {
    DB.adelantos = DB.adelantos.filter(a => a.id !== del[1]); save();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/cambiar-clave' && m === 'POST') {
    const b = await body(req);
    if (!verify(b.actual || '', DB.passHash)) return send(res, 401, { error: 'La contraseña actual no es correcta.' });
    if (String(b.nueva || '').length < 6) return send(res, 400, { error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    DB.passHash = hash(b.nueva); DB.sessions = {}; newSession(res);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'No encontrado' });
}

http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/')) return await api(req, res, p);
    let rel = p.replace(/^\/+/, '') || 'index.html';
    if (!STATIC.has(rel)) rel = 'index.html';
    const data = fs.readFileSync(path.join(PUBLIC, rel));
    const ext = path.extname(rel);
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || ext === '.webmanifest' ? 'no-store' : 'public, max-age=86400' }, SEC));
    res.end(data);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Error del servidor' });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`Préstamo Conecta en el puerto ${PORT}`));
