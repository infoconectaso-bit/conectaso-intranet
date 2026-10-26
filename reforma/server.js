'use strict';
/**
 * Reforma — app independiente para apuntar los gastos de la reforma de casa.
 * Dos apartados (pagado por la empresa / pagado por nosotros), fotos de tickets
 * y lectura automática con Tesseract (gratis, dentro del propio servidor).
 * Guarda todo en /data (volumen propio, fuera del repositorio). Sin dependencias npm.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { leerTicket, CATS } = require('./ticket');

const PORT = +(process.env.PORT || 8082);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'reforma.json');
const FOTOS = path.join(DATA_DIR, 'fotos');
const PUBLIC = path.join(__dirname, 'public');
const COOKIE = 'rf_sesion';
const SESSION_DAYS = 365;
fs.mkdirSync(FOTOS, { recursive: true });

/* ---------- almacén JSON ---------- */
function load() {
  let d;
  try { d = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { d = {}; }
  d.usuarios = d.usuarios || {}; d.sessions = d.sessions || {}; d.gastos = d.gastos || {};
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
    fs.writeFileSync(path.join(bdir, `reforma-${day}.json`), JSON.stringify(Object.assign({}, DB, { sessions: {} }), null, 2));
    fs.readdirSync(bdir).sort().slice(0, -30).forEach(f => fs.unlinkSync(path.join(bdir, f)));
  } catch (e) { /* la copia es opcional */ }
}
const nid = () => crypto.randomBytes(9).toString('base64url');

/* ---------- usuarios y sesiones ---------- */
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
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 30);
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function quien(req) {
  const t = cookies(req)[COOKIE];
  if (!t) return null;
  const s = DB.sessions[sha(t)];
  if (!s || s.hasta < Date.now() || !DB.usuarios[s.u]) return null;
  return DB.usuarios[s.u];
}
function newSession(res, uid, req) {
  const t = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  for (const k of Object.keys(DB.sessions)) if (DB.sessions[k].hasta < now) delete DB.sessions[k];
  DB.sessions[sha(t)] = { u: uid, hasta: now + SESSION_DAYS * 864e5 };
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
const publico = u => ({ id: u.id, nombre: u.nombre });

/* ---------- HTTP ---------- */
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, SEC));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function raw(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > max) { reject(Object.assign(new Error('grande'), { grande: true })); req.destroy(); } else ch.push(c); });
    req.on('end', () => resolve(Buffer.concat(ch)));
    req.on('error', reject);
  });
}
async function body(req) {
  const b = await raw(req, 64 * 1024);
  if (!b.length) return {};
  if (/application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) return Object.fromEntries(new URLSearchParams(b.toString('utf8')));
  return JSON.parse(b.toString('utf8'));
}
// Respuesta de la entrada: si viene del formulario (para que el iPhone ofrezca guardar la contraseña), redirige.
function respEntrar(req, res, status, data, nombre) {
  if (!/application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) return send(res, status, data);
  const loc = status === 200 ? '../' : '../?e=' + encodeURIComponent(data.error || 'Error') + '&n=' + encodeURIComponent(nombre || '');
  res.writeHead(303, Object.assign({ Location: loc, 'Cache-Control': 'no-store' }, SEC));
  res.end();
}

const isDate = s => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s);
const num = v => { const x = Math.round(Math.abs(+v || 0) * 100) / 100; return x < 1e7 ? x : 0; };
function limpiarGasto(b, prev, u) {
  const g = Object.assign({}, prev || {});
  g.pagador = b.pagador === 'empresa' ? 'empresa' : 'nosotros';
  g.tipo = ['gasto', 'descuento', 'devolucion'].includes(b.tipo) ? b.tipo : 'gasto';
  g.concepto = String(b.concepto || '').trim().slice(0, 120);
  g.comercio = String(b.comercio || '').trim().slice(0, 80);
  g.fecha = isDate(b.fecha) ? b.fecha : new Date().toISOString().slice(0, 10);
  g.categoria = CATS.includes(b.categoria) ? b.categoria : 'Otros';
  g.importe = num(b.importe); g.descuento = num(b.descuento); g.iva = num(b.iva);
  g.nota = String(b.nota || '').trim().slice(0, 600);
  g.lineas = Array.isArray(b.lineas) ? b.lineas.slice(0, 10).map(l => ({ d: String(l && l.d || '').slice(0, 60), i: num(l && l.i) })) : (g.lineas || []);
  if ('foto' in b) g.foto = (typeof b.foto === 'string' && /^[A-Za-z0-9_-]{8,20}\.jpg$/.test(b.foto) && fs.existsSync(path.join(FOTOS, b.foto))) ? b.foto : null;
  if (!g.concepto) g.concepto = g.comercio ? `${g.categoria} – ${g.comercio}` : g.categoria;
  if (!prev) { g.id = nid(); g.creadoPor = u.id; g.creadoEn = Date.now(); }
  g.editadoPor = u.id; g.editadoEn = Date.now();
  return g;
}

function ocr(file) {
  return new Promise(resolve => {
    execFile('tesseract', [file, 'stdout', '-l', 'spa+cat+eng', '--psm', '4'], { timeout: 60000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err && !out) {
        // si falta algún idioma, intenta solo con castellano
        execFile('tesseract', [file, 'stdout', '-l', 'spa', '--psm', '4'], { timeout: 60000, maxBuffer: 4 << 20 }, (e2, o2) => resolve(e2 && !o2 ? null : String(o2 || '')));
      } else resolve(String(out || ''));
    });
  });
}

function csv() {
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const n = v => String(v || 0).replace('.', ',');
  const head = ['Fecha', 'Pagado por', 'Tipo', 'Concepto', 'Tienda', 'Categoría', 'Importe', 'Descuento', 'IVA', 'Nota', 'Subido por'];
  const rows = Object.values(DB.gastos).sort((a, b) => a.fecha.localeCompare(b.fecha)).map(g => [
    esc(g.fecha), esc(g.pagador === 'empresa' ? 'Empresa' : 'Nosotros'), esc(g.tipo === 'gasto' ? 'Gasto' : g.tipo === 'descuento' ? 'Descuento' : 'Devolución'),
    esc(g.concepto), esc(g.comercio), esc(g.categoria), n(g.tipo === 'gasto' ? g.importe : -g.importe), n(g.descuento), n(g.iva), esc(g.nota),
    esc((DB.usuarios[g.creadoPor] || {}).nombre || '')].join(';'));
  return '﻿' + [head.join(';')].concat(rows).join('\r\n');
}

async function api(req, res, p) {
  const m = req.method;
  if (p === '/api/estado' && m === 'GET') {
    const u = quien(req);
    return send(res, 200, { dentro: !!u, yo: u ? publico(u) : null, primeraVez: !Object.keys(DB.usuarios).length });
  }

  if (p === '/api/entrar' && m === 'POST') {
    const b = await body(req);
    const nombre = String(b.nombre || b.username || '').trim().slice(0, 40), clave = String(b.clave || b.password || '');
    if (limited(req)) return respEntrar(req, res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' }, nombre);
    if (!Object.keys(DB.usuarios).length) {
      // Primera vez: se crea la primera cuenta.
      if (!slug(nombre)) return respEntrar(req, res, 400, { error: 'Escribe tu nombre.' }, nombre);
      if (clave.length < 6) return respEntrar(req, res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' }, nombre);
      const u = { id: nid(), nombre, usuario: slug(nombre), passHash: hash(clave), creado: Date.now() };
      DB.usuarios[u.id] = u; save();
      newSession(res, u.id, req);
      return respEntrar(req, res, 200, { ok: true, yo: publico(u) });
    }
    const u = Object.values(DB.usuarios).find(x => x.usuario === slug(nombre));
    if (!u || !verify(clave, u.passHash)) { failTry(req); return respEntrar(req, res, 401, { error: 'Nombre o contraseña incorrectos.' }, nombre); }
    tries.delete(ip(req)); newSession(res, u.id, req);
    return respEntrar(req, res, 200, { ok: true, yo: publico(u) });
  }

  const yo = quien(req);
  if (!yo) return send(res, 401, { error: 'Entra con tu nombre y contraseña.' });

  if (p === '/api/salir' && m === 'POST') { endSession(req, res); return send(res, 200, { ok: true }); }

  if (p === '/api/datos' && m === 'GET') {
    return send(res, 200, { yo: publico(yo), usuarios: Object.values(DB.usuarios).map(publico), gastos: Object.values(DB.gastos), categorias: CATS });
  }

  if (p === '/api/gastos' && m === 'POST') {
    const g = limpiarGasto(await body(req), null, yo);
    if (!(g.importe > 0)) return send(res, 400, { error: 'Pon el importe total, por ejemplo 45,90.' });
    DB.gastos[g.id] = g; save();
    return send(res, 200, { ok: true, gasto: g });
  }
  const mg = /^\/api\/gastos\/([A-Za-z0-9_-]{6,20})$/.exec(p);
  if (mg && m === 'PUT') {
    const prev = DB.gastos[mg[1]];
    if (!prev) return send(res, 404, { error: 'Ese gasto ya no existe.' });
    const b = await body(req);
    const g = limpiarGasto(b, prev, yo);
    if (!(g.importe > 0)) return send(res, 400, { error: 'Pon el importe total, por ejemplo 45,90.' });
    if (prev.foto && prev.foto !== g.foto) borrarFoto(prev.foto, g.id);
    DB.gastos[g.id] = g; save();
    return send(res, 200, { ok: true, gasto: g });
  }
  if (mg && m === 'DELETE') {
    const prev = DB.gastos[mg[1]];
    if (!prev) return send(res, 200, { ok: true });
    delete DB.gastos[mg[1]]; save();
    if (prev.foto) borrarFoto(prev.foto, null);
    return send(res, 200, { ok: true });
  }

  // Subir foto: el cuerpo es la imagen JPEG (la app ya la reduce). Devuelve lo leído del ticket.
  if (p === '/api/foto' && m === 'POST') {
    let buf;
    try { buf = await raw(req, 12 * 1024 * 1024); } catch (e) { return send(res, 413, { error: 'La foto es demasiado grande.' }); }
    const jpg = buf[0] === 0xff && buf[1] === 0xd8, png = buf[0] === 0x89 && buf[1] === 0x50;
    if (!jpg && !png) return send(res, 400, { error: 'Eso no parece una foto (JPG o PNG).' });
    const name = nid() + '.jpg';
    const f = path.join(FOTOS, name);
    fs.writeFileSync(f, buf);
    const leer = new URL(req.url, 'http://x').searchParams.get('leer') !== '0';
    let lectura = null;
    if (leer) {
      const texto = await ocr(f);
      lectura = texto == null ? { error: 'El lector de tickets no está disponible ahora. Rellénalo a mano.' } : leerTicket(texto);
    }
    return send(res, 200, { ok: true, foto: name, lectura });
  }

  const mf = /^\/api\/fotos\/([A-Za-z0-9_-]{8,20}\.jpg)$/.exec(p);
  if (mf && m === 'GET') {
    const f = path.join(FOTOS, mf[1]);
    if (!fs.existsSync(f)) return send(res, 404, { error: 'No está la foto.' });
    const b = fs.readFileSync(f);
    res.writeHead(200, Object.assign({ 'Content-Type': b[0] === 0x89 ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' }, SEC));
    return res.end(b);
  }

  if (p === '/api/exportar.csv' && m === 'GET') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="reforma-gastos-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' }, SEC));
    return res.end(csv());
  }

  if (p === '/api/usuarios' && m === 'POST') {
    const b = await body(req);
    const nombre = String(b.nombre || '').trim().slice(0, 40), clave = String(b.clave || '');
    if (!slug(nombre)) return send(res, 400, { error: 'Escribe el nombre.' });
    if (Object.values(DB.usuarios).some(x => x.usuario === slug(nombre))) return send(res, 400, { error: 'Ya hay alguien con ese nombre.' });
    if (clave.length < 6) return send(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' });
    const u = { id: nid(), nombre, usuario: slug(nombre), passHash: hash(clave), creado: Date.now(), creadoPor: yo.id };
    DB.usuarios[u.id] = u; save();
    return send(res, 200, { ok: true, usuario: publico(u) });
  }
  if (p === '/api/cambiar-clave' && m === 'POST') {
    const b = await body(req);
    if (!verify(b.actual || '', yo.passHash)) return send(res, 401, { error: 'La contraseña actual no es correcta.' });
    if (String(b.nueva || '').length < 6) return send(res, 400, { error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    yo.passHash = hash(b.nueva);
    for (const k of Object.keys(DB.sessions)) if (DB.sessions[k].u === yo.id) delete DB.sessions[k];
    newSession(res, yo.id, req);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'No encontrado' });
}

function borrarFoto(name, exceptId) {
  if (Object.values(DB.gastos).some(g => g.foto === name && g.id !== exceptId)) return;
  try { fs.unlinkSync(path.join(FOTOS, name)); } catch (e) { /* ya no estaba */ }
}
// Fotos subidas pero nunca guardadas en un gasto: se borran al cabo de un día.
setInterval(() => {
  const usadas = new Set(Object.values(DB.gastos).map(g => g.foto).filter(Boolean));
  for (const f of fs.readdirSync(FOTOS)) {
    if (usadas.has(f)) continue;
    try { const st = fs.statSync(path.join(FOTOS, f)); if (Date.now() - st.mtimeMs > 864e5) fs.unlinkSync(path.join(FOTOS, f)); } catch (e) { }
  }
}, 6 * 3600e3).unref();

const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8' };
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
}).listen(PORT, '0.0.0.0', () => console.log(`Reforma en el puerto ${PORT}`));
