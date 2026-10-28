'use strict';
/**
 * Cuentas — app independiente con las cuentas mensuales de la vivienda
 * (cuenta casa / cuenta piso): ingresos y gastos fijos que se repiten solos.
 * Un único usuario y contraseña compartidos por la pareja.
 * Guarda todo en /data (volumen propio, fuera del repositorio). Sin dependencias npm.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +(process.env.PORT || 8083);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'cuentas.json');
const PUBLIC = path.join(__dirname, 'public');
const COOKIE = 'ct_sesion';
const SESSION_DAYS = 365;
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- almacén JSON ---------- */
function load() {
  let d;
  try { d = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { d = {}; }
  d.acceso = d.acceso || null; d.sessions = d.sessions || {}; d.movimientos = d.movimientos || {};
  return d;
}
let DB = load();
function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
  fs.renameSync(tmp, FILE);
  try {
    const bdir = path.join(DATA_DIR, 'copias');
    fs.mkdirSync(bdir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(bdir, `cuentas-${day}.json`), JSON.stringify(Object.assign({}, DB, { sessions: {} }), null, 2));
    fs.readdirSync(bdir).sort().slice(0, -30).forEach(f => fs.unlinkSync(path.join(bdir, f)));
  } catch (e) { /* la copia es opcional */ }
}
const nid = () => crypto.randomBytes(9).toString('base64url');

/* ---------- acceso y sesiones ---------- */
function hash(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(String(pw), salt, 64).toString('base64')}`;
}
function verify(pw, stored) {
  if (!stored) return false;
  const [, s, k] = stored.split('$');
  const key = Buffer.from(k, 'base64');
  return crypto.timingSafeEqual(key, crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), key.length));
}
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
// El usuario no distingue mayúsculas, acentos ni espacios.
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 30);
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function dentro(req) {
  const t = cookies(req)[COOKIE];
  if (!t || !DB.acceso) return false;
  const s = DB.sessions[sha(t)];
  return !!(s && s.hasta > Date.now());
}
function newSession(res, req) {
  const t = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  for (const k of Object.keys(DB.sessions)) if (DB.sessions[k].hasta < now) delete DB.sessions[k];
  DB.sessions[sha(t)] = { hasta: now + SESSION_DAYS * 864e5 };
  save();
  const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
function endSession(req, res) {
  const t = cookies(req)[COOKIE];
  if (t) { delete DB.sessions[sha(t)]; save(); }
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
const tries = new Map();
function ip(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || ''; }
function limited(req) { const r = tries.get(ip(req)); return r && r.n >= 8 && Date.now() - r.t < 15 * 60e3; }
function failTry(req) { const k = ip(req); const r = tries.get(k); if (!r || Date.now() - r.t > 15 * 60e3) tries.set(k, { n: 1, t: Date.now() }); else r.n++; }

/* ---------- HTTP ---------- */
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, SEC));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > 64 * 1024) { reject(new SyntaxError('grande')); req.destroy(); } else ch.push(c); });
    req.on('end', () => {
      const b = Buffer.concat(ch).toString('utf8');
      try {
        if (!b) return resolve({});
        if (/application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) return resolve(Object.fromEntries(new URLSearchParams(b)));
        resolve(JSON.parse(b));
      } catch (e) { reject(new SyntaxError('json')); }
    });
    req.on('error', reject);
  });
}
// La entrada llega desde un formulario normal (así el iPhone ofrece guardar la contraseña) y redirige.
function respEntrar(req, res, ok, error, usuario) {
  if (!/application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) return send(res, ok ? 200 : 400, ok ? { ok: true } : { error });
  const loc = ok ? '../' : '../?e=' + encodeURIComponent(error) + '&n=' + encodeURIComponent(usuario || '');
  res.writeHead(303, Object.assign({ Location: loc, 'Cache-Control': 'no-store' }, SEC));
  res.end();
}

const FREQ = ['mensual', 'bimestral', 'trimestral', 'semestral', 'anual', 'puntual'];
const CATS = ['Vivienda', 'Suministros', 'Telefonía e internet', 'Seguros', 'Impuestos y comunidad', 'Alimentación', 'Transporte', 'Nómina', 'Alquiler', 'Otros'];
const QUIEN = ['Los dos', 'Adrià', 'Alba'];
const isYm = s => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
function limpiar(b, prev) {
  const m = Object.assign({}, prev || {});
  m.cuenta = b.cuenta === 'piso' ? 'piso' : 'casa';
  m.tipo = b.tipo === 'ingreso' ? 'ingreso' : 'gasto';
  m.concepto = String(b.concepto || '').trim().slice(0, 80);
  const imp = Math.round(Math.abs(+b.importe || 0) * 100) / 100;
  m.importe = imp < 1e7 ? imp : 0;
  m.frecuencia = FREQ.includes(b.frecuencia) ? b.frecuencia : 'mensual';
  m.desde = isYm(b.desde) ? b.desde : new Date().toISOString().slice(0, 7);
  m.hasta = isYm(b.hasta) && b.hasta >= m.desde ? b.hasta : null;
  m.categoria = CATS.includes(b.categoria) ? b.categoria : 'Otros';
  m.quien = QUIEN.includes(b.quien) ? b.quien : 'Los dos';
  m.nota = String(b.nota || '').trim().slice(0, 300);
  if (!prev) { m.id = nid(); m.creadoEn = Date.now(); }
  m.editadoEn = Date.now();
  return m;
}
const version = () => Math.max(0, ...Object.values(DB.movimientos).map(m => m.editadoEn || 0), DB.borrado || 0);

async function api(req, res, p) {
  const m = req.method;
  if (p === '/api/estado' && m === 'GET') return send(res, 200, { dentro: dentro(req), primeraVez: !DB.acceso });

  if (p === '/api/entrar' && m === 'POST') {
    const b = await body(req);
    const usuario = String(b.usuario || b.username || '').trim().slice(0, 40), clave = String(b.clave || b.password || '');
    if (limited(req)) return respEntrar(req, res, false, 'Demasiados intentos. Espera 15 minutos.', usuario);
    if (!DB.acceso) {
      // Primera vez: se crea el acceso compartido.
      if (!slug(usuario)) return respEntrar(req, res, false, 'Escribe un nombre de usuario.', usuario);
      if (clave.length < 6) return respEntrar(req, res, false, 'La contraseña debe tener al menos 6 caracteres.', usuario);
      DB.acceso = { usuario: slug(usuario), passHash: hash(clave), creado: Date.now() };
      save(); newSession(res, req);
      return respEntrar(req, res, true);
    }
    if (slug(usuario) !== DB.acceso.usuario || !verify(clave, DB.acceso.passHash)) { failTry(req); return respEntrar(req, res, false, 'Usuario o contraseña incorrectos.', usuario); }
    tries.delete(ip(req)); newSession(res, req);
    return respEntrar(req, res, true);
  }

  if (!dentro(req)) return send(res, 401, { error: 'Entra con el usuario y la contraseña.' });

  if (p === '/api/salir' && m === 'POST') { endSession(req, res); return send(res, 200, { ok: true }); }
  if (p === '/api/datos' && m === 'GET') return send(res, 200, { version: version(), movimientos: Object.values(DB.movimientos), categorias: CATS, quien: QUIEN });
  if (p === '/api/version' && m === 'GET') return send(res, 200, { version: version() });

  if (p === '/api/movimientos' && m === 'POST') {
    const x = limpiar(await body(req), null);
    if (!x.concepto) return send(res, 400, { error: 'Escribe un concepto.' });
    if (!(x.importe > 0)) return send(res, 400, { error: 'Escribe un importe mayor que 0, por ejemplo 45,90.' });
    DB.movimientos[x.id] = x; save();
    return send(res, 200, { ok: true, movimiento: x });
  }
  const mm = /^\/api\/movimientos\/([A-Za-z0-9_-]{6,20})$/.exec(p);
  if (mm && m === 'PUT') {
    const prev = DB.movimientos[mm[1]];
    if (!prev) return send(res, 404, { error: 'Ese movimiento ya no existe. Recarga la página.' });
    const x = limpiar(await body(req), prev);
    if (!x.concepto) return send(res, 400, { error: 'Escribe un concepto.' });
    if (!(x.importe > 0)) return send(res, 400, { error: 'Escribe un importe mayor que 0, por ejemplo 45,90.' });
    DB.movimientos[x.id] = x; save();
    return send(res, 200, { ok: true, movimiento: x });
  }
  if (mm && m === 'DELETE') {
    if (DB.movimientos[mm[1]]) { delete DB.movimientos[mm[1]]; DB.borrado = Date.now(); save(); }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/cambiar-clave' && m === 'POST') {
    const b = await body(req);
    if (!verify(b.actual || '', DB.acceso.passHash)) return send(res, 400, { error: 'La contraseña actual no es correcta.' });
    if (String(b.nueva || '').length < 6) return send(res, 400, { error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    DB.acceso.passHash = hash(b.nueva);
    DB.sessions = {}; // cierra la sesión en todos los móviles; se vuelve a entrar con la nueva
    newSession(res, req);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/exportar.csv' && m === 'GET') {
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['Cuenta', 'Tipo', 'Concepto', 'Importe', 'Se repite', 'Desde', 'Hasta', 'Categoría', 'De quién', 'Nota'];
    const rows = Object.values(DB.movimientos).sort((a, b) => (a.cuenta + a.tipo).localeCompare(b.cuenta + b.tipo)).map(x => [
      esc(x.cuenta === 'casa' ? 'Casa' : 'Piso'), esc(x.tipo === 'ingreso' ? 'Ingreso' : 'Gasto'), esc(x.concepto), String(x.importe).replace('.', ','),
      esc(x.frecuencia), esc(x.desde), esc(x.hasta || ''), esc(x.categoria), esc(x.quien), esc(x.nota)].join(';'));
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="cuentas-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' }, SEC));
    return res.end('﻿' + [head.join(';')].concat(rows).join('\r\n'));
  }
  return send(res, 404, { error: 'No encontrado' });
}

const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8' };
const STATIC = new Set(['index.html', 'manifest.webmanifest', 'sw.js', 'icon-512.png', 'icon-192.png', 'icon-180.png', 'icon-32.png']);

http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/')) return await api(req, res, p);
    let rel = p.replace(/^\/+/, '') || 'index.html';
    if (!STATIC.has(rel)) rel = 'index.html';
    const data = fs.readFileSync(path.join(PUBLIC, rel));
    const ext = path.extname(rel);
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ['.html', '.webmanifest', '.js'].includes(ext) ? 'no-cache' : 'public, max-age=86400' }, SEC));
    res.end(data);
  } catch (e) {
    if (e instanceof SyntaxError) return send(res, 400, { error: 'Datos no válidos.' });
    console.error(e);
    send(res, 500, { error: 'Error del servidor' });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`Cuentas en el puerto ${PORT}`));
