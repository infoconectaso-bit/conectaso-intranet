'use strict';
/**
 * Copia 2 (fuera del servidor): sube las copias de seguridad a Backblaze B2.
 * - Usa la API S3 de B2 firmada con AWS SigV4 (sin dependencias externas, solo 'crypto' + fetch de Node 22).
 * - Configuración (endpoint, bucket, región y claves) guardada en el setting 'cloudBackup'.
 *   Las claves NUNCA se devuelven al navegador; solo se indica si hay una guardada.
 * - Se dispara después de cada snapshot local (ver backup.js): sube el .db y, de vez en cuando,
 *   limpia en la nube las copias antiguas con el mismo criterio que en local.
 * - Si una subida falla, se avisa por email a administración (máx. 1 cada 3 h) y se marca el estado.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { store, users, DATA_DIR } = require('./db');
const mail = require('./mail');

const PREFIX = 'conectaso/';                 // carpeta dentro del bucket (base de datos)
const FILES_PREFIX = 'conectaso-archivos/';  // carpeta dentro del bucket (archivos subidos: nóminas, planos…)
// Retención en la nube. La base de datos es pequeña (~14 MB), así que guardamos bastante historial.
// Los archivos (paquete con TODA la carpeta) son pesados: se SOBRESCRIBE siempre el mismo nombre,
// así en la nube solo queda la última copia (y el ajuste "keep only last version" del bucket la mantiene
// sola, sin acumular) — ni siquiera hace falta que la app borre nada para que deje de crecer.
// BBDD: se sube a una ranura por DÍA DEL MES (conectaso-db-dNN.db) que se sobrescribe → ~1 mes de
// historial diario, autolimitado (máx. 31 copias de ~14 MB ≈ 0,4 GB), sin depender de borrar nada.
const FILES_FIXED = 'conectaso-archivos-actual.tar';  // nombre FIJO del paquete de archivos (se sobrescribe)
const UPLOADS = path.join(DATA_DIR, 'uploads');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
let lastFilesOk = null;                       // { date, skipped? }
let lastFilesError = null;
let lastOk = null;                            // { key, date }
let lastError = null;                         // { message, date }
let lastAlert = 0;
let pruneCheck = 0;                           // control de cada cuánto limpiamos en la nube

function cfg() { return store.setting('cloudBackup') || {}; }
function enabled() { const c = cfg(); return !!(c.enabled && c.endpoint && c.bucket && c.region && c.keyId && c.appKey); }

function hostOf(c) { return String(c.endpoint || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''); }
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
function amzDates(d) {
  const p = n => String(n).padStart(2, '0');
  const amz = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return { amz, day: amz.slice(0, 8) };
}
// Codifica un segmento de ruta como exige AWS (encodeURIComponent + los caracteres que deja fuera).
function enc(s) { return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }

/**
 * Petición S3 firmada (SigV4), estilo path: https://<host>/<bucket>/<key>?<query>.
 * method: GET|PUT|DELETE. key: ruta del objeto (sin bucket) o ''. query: objeto de parámetros.
 */
async function s3(method, key, { query = {}, body = null, contentType } = {}) {
  const c = cfg();
  const host = hostOf(c);
  const region = String(c.region || '').trim();
  const service = 's3';
  const payload = body == null ? Buffer.alloc(0) : (Buffer.isBuffer(body) ? body : Buffer.from(body));
  const payloadHash = sha256(payload);
  const { amz, day } = amzDates(new Date());

  const keyPath = key ? '/' + String(key).split('/').map(enc).join('/') : '';
  const canonicalUri = '/' + enc(c.bucket) + keyPath;
  const qKeys = Object.keys(query).sort();
  const canonicalQuery = qKeys.map(k => enc(k) + '=' + enc(query[k])).join('&');

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amz}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${sha256(Buffer.from(canonicalRequest))}`;
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + c.appKey, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${c.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const qs = canonicalQuery ? '?' + canonicalQuery : '';
  const headers = { 'x-amz-date': amz, 'x-amz-content-sha256': payloadHash, 'Authorization': authorization };
  if (method === 'PUT') headers['Content-Type'] = contentType || 'application/octet-stream';

  const resp = await fetch(`https://${host}${canonicalUri}${qs}`, { method, headers, body: (method === 'PUT' ? payload : undefined) });
  const text = await resp.text();
  if (!resp.ok) throw new Error('B2 ' + resp.status + ': ' + text.slice(0, 400).replace(/\s+/g, ' '));
  return text;
}

async function uploadFile(localPath, objectKey) {
  const body = fs.readFileSync(localPath);
  await s3('PUT', objectKey, { body, contentType: 'application/octet-stream' });
  lastOk = { key: objectKey, date: new Date().toISOString() };
  return true;
}

// Lista objetos bajo un prefijo. Devuelve [{ key, time }] (time deducido del nombre -YYYYMMDD-HHMMSS.ext).
const RE = /conectaso-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;
const FILE_RE = /conectaso-archivos-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.tar$/;
async function listRemote(prefix = PREFIX, re = RE) {
  const out = [];
  let token = null;
  do {
    const query = { 'list-type': '2', 'prefix': prefix, 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const xml = await s3('GET', '', { query });
    const blocks = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
    blocks.forEach(bl => {
      const k = (bl.match(/<Key>([^<]+)<\/Key>/) || [])[1]; if (!k) return;
      const m = re.exec(k); if (!m) return;
      const size = +((bl.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
      out.push({ key: k, time: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(), size });
    });
    const t = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    token = truncated && t ? t[1] : null;
  } while (token);
  return out.sort((a, b) => b.time - a.time);
}

// Limpieza remota: todas las de <allDays> días; 1/día hasta <dailyDays> días; el resto se borra.
// Si keepN > 0, se ignoran las fechas y se conservan solo las <keepN> más recientes (por nº).
// Registra el resultado en lastPrune (cuántas borró / cuántas fallaron) para poder diagnosticar
// si la clave de Backblaze NO tiene permiso de borrado (en ese caso 'failed' saldría > 0).
let lastPrune = null;   // { prefix, candidates, deleted, failed, error, date }
async function pruneRemote(prefix = PREFIX, re = RE, allDays = 1, dailyDays = 30, keepN = 0) {
  const files = await listRemote(prefix, re);   // ya vienen de más reciente a más antigua
  let toDelete;
  if (keepN > 0) {
    toDelete = files.slice(keepN);
  } else {
    const now = Date.now(), DAY = 86400000, keep = new Set(), daily = {};
    files.forEach(f => {
      if (now - f.time <= allDays * DAY) { keep.add(f.key); return; }
      if (now - f.time <= dailyDays * DAY) { const d = new Date(f.time).toISOString().slice(0, 10); if (!daily[d]) { daily[d] = 1; keep.add(f.key); } return; }
    });
    toDelete = files.filter(f => !keep.has(f.key));
  }
  let deleted = 0, failed = 0, firstErr = null;
  for (const f of toDelete) { try { await s3('DELETE', f.key); deleted++; } catch (e) { failed++; if (!firstErr) firstErr = e.message; } }
  lastPrune = { prefix, candidates: toDelete.length, deleted, failed, error: firstErr, date: new Date().toISOString() };
  return lastPrune;
}
// Borra TODOS los paquetes de archivos con nombre de fecha (esquema anterior). El paquete fijo
// (FILES_FIXED) no coincide con FILE_RE, así que se conserva. Devuelve cuántos borró/fallaron.
async function deleteLegacyFilesTars() {
  const files = await listRemote(FILES_PREFIX, FILE_RE);   // solo los antiguos (con fecha) coinciden
  let deleted = 0, failed = 0, firstErr = null;
  for (const f of files) { try { await s3('DELETE', f.key); deleted++; } catch (e) { failed++; if (!firstErr) firstErr = e.message; } }
  lastPrune = { prefix: FILES_PREFIX, candidates: files.length, deleted, failed, error: firstErr, date: new Date().toISOString() };
  return lastPrune;
}
// Borra las copias de BBDD del esquema anterior (conectaso-YYYYMMDD-HHMMSS.db). Las ranuras nuevas
// (conectaso-db-dNN.db) NO coinciden con RE, así que se conservan. Devuelve cuántas borró/fallaron.
async function deleteLegacyDbSnapshots() {
  const files = await listRemote(PREFIX, RE);              // solo los antiguos (con fecha) coinciden
  let deleted = 0, failed = 0, firstErr = null;
  for (const f of files) { try { await s3('DELETE', f.key); deleted++; } catch (e) { failed++; if (!firstErr) firstErr = e.message; } }
  lastPrune = { prefix: PREFIX, candidates: files.length, deleted, failed, error: firstErr, date: new Date().toISOString() };
  return lastPrune;
}
// Cuenta los objetos .db bajo PREFIX (ranuras + lo que quede) y la fecha de la más reciente.
async function countDb() {
  let count = 0, last = null, bytes = 0, token = null;
  do {
    const query = { 'list-type': '2', 'prefix': PREFIX, 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const xml = await s3('GET', '', { query });
    (xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []).forEach(bl => {
      const k = (bl.match(/<Key>([^<]+)<\/Key>/) || [])[1]; if (!k || !/\.db$/.test(k)) return;
      count++; bytes += +((bl.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
      const lm = (bl.match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1]; if (lm && (!last || lm > last)) last = lm;
    });
    const t = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && t ? t[1] : null;
  } while (token);
  return { count, last, bytes };
}
// Limpieza inmediata de las DOS carpetas (base de datos + archivos antiguos). Se llama al arrancar el
// servidor para liberar espacio enseguida tras un despliegue, sin esperar al ciclo horario.
async function pruneAll() {
  if (!enabled()) return null;
  pruneCheck = Date.now(); filesPruneCheck = Date.now();
  const dbRes = await deleteLegacyDbSnapshots().catch(e => ({ error: e.message }));
  const fRes = await deleteLegacyFilesTars().catch(e => ({ error: e.message }));
  return { db: dbRes, files: fRes };
}
// Tamaño TOTAL del bucket (todos los objetos), para que coincida con lo que muestra Backblaze.
async function bucketBytes() {
  let bytes = 0, count = 0, token = null;
  do {
    const query = { 'list-type': '2', 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const xml = await s3('GET', '', { query });
    (xml.match(/<Size>(\d+)<\/Size>/g) || []).forEach(m => { bytes += +(m.match(/\d+/)[0]); count++; });
    const t = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && t ? t[1] : null;
  } while (token);
  return { bytes, count };
}

// --- Copia de los ARCHIVOS subidos (/data/uploads): nóminas, planos, adjuntos de eventos, logos de fotomatón… ---
const pad2 = n => String(n).padStart(2, '0');
function stamp(d) { d = d || new Date(); return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()); }
// Firma barata de la carpeta: nº de archivos + bytes + mtime más reciente. Si no cambia, no se vuelve a subir.
function filesSignature() {
  let count = 0, bytes = 0, maxM = 0;
  const walk = d => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { const s = fs.statSync(p); count++; bytes += s.size; if (s.mtimeMs > maxM) maxM = s.mtimeMs; } catch (_) {} } }
  };
  walk(UPLOADS);
  return count + ':' + bytes + ':' + Math.round(maxM);
}
function makeTar(dest) {
  // tar sin comprimir (los PDF/imágenes ya están comprimidos); busybox tar lo soporta siempre.
  return new Promise((resolve, reject) => { execFile('tar', ['-cf', dest, '-C', UPLOADS, '.'], { maxBuffer: 4 * 1024 * 1024 }, err => err ? reject(err) : resolve()); });
}
let filesPruneCheck = 0;
// Sube la carpeta de archivos SOLO si ha cambiado desde la última copia. No lanza; registra y avisa.
async function syncFiles() {
  if (!enabled()) return;
  try {
    if (!fs.existsSync(UPLOADS)) return;
    const sig = filesSignature();
    if (sig === '0:0:0') return;                         // no hay nada subido todavía
    if (store.setting('filesBackupSig') === sig) { lastFilesOk = { date: new Date().toISOString(), skipped: true }; return; } // sin cambios
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = FILES_FIXED;                            // nombre fijo: sobrescribe la copia anterior en la nube
    const tmp = path.join(BACKUP_DIR, 'conectaso-archivos.tmp.tar');
    await makeTar(tmp);
    try {
      await uploadFile(tmp, FILES_PREFIX + name);
      store.setSetting('filesBackupSig', sig);
      lastFilesOk = { date: new Date().toISOString(), name };
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) {}           // el tar local es redundante (los archivos ya están en disco)
    }
    // Borra los paquetes antiguos con nombre de fecha (esquema anterior); el fijo ya no se acumula.
    if (Date.now() - filesPruneCheck > 60 * 60 * 1000) { filesPruneCheck = Date.now(); try { await deleteLegacyFilesTars(); } catch (e) {} }
  } catch (e) {
    lastFilesError = { message: e.message, date: new Date().toISOString() };
    console.error('[cloud-backup] fallo al subir archivos:', e.message);
    alertFail(e);
  }
}

// Se llama tras cada snapshot local correcto. No lanza: registra y avisa. No bloquea el backup local.
// La BBDD se sube a una RANURA POR DÍA DEL MES (conectaso-db-dNN.db) que se sobrescribe: así hay ~1 mes
// de historial diario en la nube y el nº de copias se autolimita solo (con "keep only last version" del
// bucket), SIN depender de que la app borre nada. La subida se limita a ~1/hora (la copia local va cada
// 10 min y es la de recuperación rápida; la nube es la copia externa de seguridad).
let lastCloudDb = 0;
async function syncSnapshot(localPath, name) {
  if (!enabled()) return;
  try {
    const now = Date.now();
    if (now - lastCloudDb < 55 * 60 * 1000) return;     // como mucho una subida a la nube por hora
    lastCloudDb = now;
    const dd = String(new Date().getDate()).padStart(2, '0');
    await uploadFile(localPath, PREFIX + 'conectaso-db-d' + dd + '.db');
    // De vez en cuando, borra las copias del esquema anterior (con fecha y hora en el nombre).
    if (now - pruneCheck > 60 * 60 * 1000) { pruneCheck = now; try { await deleteLegacyDbSnapshots(); } catch (e) {} }
  } catch (e) {
    lastError = { message: e.message, date: new Date().toISOString() };
    console.error('[cloud-backup] fallo al subir:', e.message);
    alertFail(e);
  }
}

function alertFail(err) {
  const now = Date.now();
  if (now - lastAlert < 3 * 60 * 60 * 1000) return;
  lastAlert = now;
  if (!mail.enabled()) return;
  let to = '';
  try { to = users.all().filter(u => u.role === 'admin' && u.email && u.active).map(u => u.email).join(','); } catch (e) {}
  if (!to) return;
  const when = new Date().toLocaleString('es-ES');
  const msg = String(err && err.message || err);
  try {
    mail.sendMail({
      to,
      subject: '⚠ Fallo en la copia en la nube — Conecta So',
      text: 'La subida de la copia de seguridad a la nube (Backblaze) ha FALLADO el ' + when + '.\n\nError: ' + msg + '\n\nLa copia local del servidor sigue funcionando; conviene revisar la configuración de la nube en Admin → Copias de seguridad.',
      html: '<p>La subida de la copia de seguridad <b>a la nube</b> (Backblaze) ha fallado el ' + when + '.</p><p>Error: ' + msg.replace(/</g, '&lt;') + '</p><p>La copia local del servidor sigue funcionando. Conviene revisar la configuración en <b>Admin → Copias de seguridad</b>.</p>'
    });
  } catch (e) {}
}

// Prueba de conexión: sube un pequeño objeto y lo borra. Devuelve { ok } o lanza con el motivo.
async function test() {
  if (!enabled()) throw new Error('Faltan datos de configuración (endpoint, bucket, región o claves).');
  const key = PREFIX + '_test-' + Date.now() + '.txt';
  await s3('PUT', key, { body: Buffer.from('conecta-so cloud backup test ' + new Date().toISOString()), contentType: 'text/plain' });
  try { await s3('DELETE', key); } catch (e) {}
  return { ok: true };
}

async function statusAsync() {
  const base = { configured: enabled(), lastOk, lastError, filesOk: lastFilesOk, filesError: lastFilesError };
  if (!enabled()) return base;
  try { const d = await countDb(); base.remoteCount = d.count; base.remoteLast = d.last; }
  catch (e) { base.reachError = e.message; }
  try {
    const xml = await s3('GET', '', { query: { 'list-type': '2', 'prefix': FILES_PREFIX + FILES_FIXED, 'max-keys': '1' } });
    const bl = (xml.match(/<Contents>[\s\S]*?<\/Contents>/) || [])[0];
    base.filesCount = bl ? 1 : 0;
    base.filesLast = bl ? ((bl.match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1] || (lastFilesOk && lastFilesOk.date) || null) : (lastFilesOk && lastFilesOk.date) || null;
  } catch (e) { if (!base.reachError) base.reachError = e.message; }
  // Tamaño TOTAL del bucket (todos los objetos) para que coincida con lo que ves en Backblaze.
  try { const b = await bucketBytes(); base.bytes = b.bytes; base.objects = b.count; } catch (e) { if (!base.reachError) base.reachError = e.message; }
  base.freeLimit = 10 * 1024 * 1024 * 1024;   // 10 GB gratis de Backblaze B2
  base.lastPrune = lastPrune;                 // resultado de la última limpieza (deleted/failed)
  return base;
}

module.exports = { enabled, uploadFile, syncSnapshot, syncFiles, test, listRemote, pruneRemote, deleteLegacyFilesTars, pruneAll, statusAsync, PREFIX, FILES_PREFIX };
