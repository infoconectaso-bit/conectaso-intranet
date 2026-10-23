'use strict';
/**
 * Conecta Seguros — app independiente de la intranet y de Préstamo Conecta.
 * Guarda todo en un JSON dentro de /data (volumen propio, fuera del repositorio).
 * Sin dependencias externas. Node 22+.
 *
 * IMPORTANTE: el repositorio es público. Los datos de las pólizas y sus PDF
 * viajan CIFRADOS (AES-256-GCM) en semilla/. Solo se pueden abrir con la
 * contraseña inicial; la primera vez que se entra con ella el servidor guarda
 * la clave en /data y descifra los datos. Después se puede cambiar la contraseña.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +(process.env.PORT || 8081);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'seguros.json');
const KEYFILE = path.join(DATA_DIR, 'clave-semilla.txt');
const PDF_DIR = path.join(DATA_DIR, 'pdf');
const SEED_DIR = path.join(__dirname, 'semilla');
const PUBLIC = path.join(__dirname, 'public');
const COOKIE = 'cs_sesion';
const SESSION_DAYS = 180;
const TITULARES = ['adri', 'alba', 'empresa'];
fs.mkdirSync(PDF_DIR, { recursive: true });

/* ---------- almacén JSON ---------- */
function load() {
  let d;
  try { d = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { d = {}; }
  d.passHash = d.passHash || null; d.sessions = d.sessions || {}; d.polizas = d.polizas || {}; d.seedVersion = d.seedVersion || 0;
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
    const copy = Object.assign({}, DB, { sessions: {} });
    fs.writeFileSync(path.join(bdir, `seguros-${day}.json`), JSON.stringify(copy, null, 2));
    fs.readdirSync(bdir).sort().slice(0, -30).forEach(f => fs.unlinkSync(path.join(bdir, f)));
  } catch (e) { /* la copia es opcional */ }
}

/* ---------- semilla cifrada ---------- */
// Formato: { v, salt } en semilla/indice.json; cada archivo .enc = iv(12) + tag(16) + datos.
function seedIndex() { try { return JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'indice.json'), 'utf8')); } catch (e) { return null; } }
function deriveKey(pw, idx) { return crypto.scryptSync(String(pw), Buffer.from(idx.salt, 'base64'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
function decrypt(buf, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}
function readSeed(key) {
  return JSON.parse(decrypt(fs.readFileSync(path.join(SEED_DIR, 'datos.enc')), key).toString('utf8'));
}
function storedKey() { try { return Buffer.from(fs.readFileSync(KEYFILE, 'utf8').trim(), 'base64'); } catch (e) { return null; } }

// Campos que la persona puede tocar desde la app: si los ha cambiado, la semilla no los pisa.
const EDITABLES = ['prima', 'periodicidad', 'vencimiento', 'notas', 'titular'];
function applySeed(key) {
  const idx = seedIndex();
  if (!idx || !key || idx.v <= DB.seedVersion) return false;
  let seed;
  try { seed = readSeed(key); } catch (e) { console.error('No se pudo descifrar la semilla'); return false; }
  for (const p of seed.polizas || []) {
    const old = DB.polizas[p.id];
    const next = Object.assign({}, p);
    if (old && old.editado) { for (const k of old.editado) if (k in old) next[k] = old[k]; next.editado = old.editado; }
    DB.polizas[p.id] = next;
  }
  for (const id of seed.borrar || []) delete DB.polizas[id];
  // PDFs: se descifran al disco del servidor
  for (const f of fs.readdirSync(SEED_DIR)) {
    if (!f.endsWith('.pdf.enc')) continue;
    try { fs.writeFileSync(path.join(PDF_DIR, f.slice(0, -4)), decrypt(fs.readFileSync(path.join(SEED_DIR, f)), key)); }
    catch (e) { console.error('PDF no descifrado', f); }
  }
  DB.seedVersion = idx.v; save();
  console.log('Semilla aplicada, versión', idx.v);
  return true;
}
// Al arrancar: si ya tenemos la clave guardada, aplica la semilla nueva (si la hay).
applySeed(storedKey());

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
    req.on('data', c => { n += c.length; if (n > 64 * 1024) { reject(new Error('grande')); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { resolve(ch.length ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const isDate = s => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s);
const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json; charset=utf-8' };
const STATIC = new Set(['index.html', 'manifest.webmanifest', 'logo.svg', 'icon-512.png', 'icon-192.png', 'icon-180.png', 'icon-32.png',
  'fonts/lacquer.ttf', 'fonts/outer-sans-black.woff2', 'fonts/evolve-sans.woff2']);

async function api(req, res, p) {
  const m = req.method;
  if (p === '/api/estado' && m === 'GET') return send(res, 200, { dentro: logged(req) });

  if (p === '/api/entrar' && m === 'POST') {
    if (limited(req)) return send(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
    const b = await body(req);
    const clave = String(b.clave || '');
    if (DB.passHash) {
      if (!verify(clave, DB.passHash)) { failTry(req); return send(res, 401, { error: 'Contraseña incorrecta.' }); }
    } else {
      // Primera vez: la contraseña inicial es la que abre la semilla cifrada.
      const idx = seedIndex();
      let key = null;
      try { key = deriveKey(clave, idx); readSeed(key); } catch (e) { key = null; }
      if (!key) { failTry(req); return send(res, 401, { error: 'Contraseña incorrecta.' }); }
      fs.writeFileSync(KEYFILE, key.toString('base64'), { mode: 0o600 });
      DB.passHash = hash(clave); save();
      applySeed(key);
    }
    tries.delete(ip(req)); newSession(res);
    return send(res, 200, { ok: true });
  }

  if (!logged(req)) return send(res, 401, { error: 'Entra con tu contraseña.' });

  if (p === '/api/salir' && m === 'POST') { endSession(req, res); return send(res, 200, { ok: true }); }
  if (p === '/api/datos' && m === 'GET') {
    applySeed(storedKey());
    return send(res, 200, { polizas: Object.values(DB.polizas) });
  }
  const mp = /^\/api\/polizas\/([a-z0-9-]{1,40})$/.exec(p);
  if (mp && m === 'PATCH') {
    const P = DB.polizas[mp[1]];
    if (!P) return send(res, 404, { error: 'Esa póliza no existe.' });
    const b = await body(req);
    const ed = new Set(P.editado || []);
    if ('prima' in b) { const x = +b.prima; if (!(x >= 0 && x < 1e6)) return send(res, 400, { error: 'Importe no válido.' }); P.prima = Math.round(x * 100) / 100; ed.add('prima'); P.primaNota = ''; }
    if ('periodicidad' in b) { if (!['anual', 'semestral', 'trimestral', 'mensual'].includes(b.periodicidad)) return send(res, 400, { error: 'Periodicidad no válida.' }); P.periodicidad = b.periodicidad; ed.add('periodicidad'); }
    if ('vencimiento' in b) { if (!isDate(b.vencimiento)) return send(res, 400, { error: 'Fecha no válida.' }); P.vencimiento = b.vencimiento; ed.add('vencimiento'); }
    if ('notas' in b) { P.notas = String(b.notas || '').slice(0, 2000); ed.add('notas'); }
    if ('titular' in b) { if (!TITULARES.includes(b.titular)) return send(res, 400, { error: 'Titular no válido.' }); P.titular = b.titular; ed.add('titular'); }
    P.editado = [...ed].filter(k => EDITABLES.includes(k)); save();
    return send(res, 200, { ok: true, poliza: P });
  }
  const mf = /^\/api\/pdf\/([a-z0-9-]{1,60}\.pdf)$/.exec(p);
  if (mf && m === 'GET') {
    const f = path.join(PDF_DIR, mf[1]);
    if (!fs.existsSync(f)) return send(res, 404, { error: 'No está el PDF.' });
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${mf[1]}"`, 'Cache-Control': 'private, no-store' }, SEC));
    return fs.createReadStream(f).pipe(res);
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
}).listen(PORT, '0.0.0.0', () => console.log(`Conecta Seguros en el puerto ${PORT}`));
