'use strict';
/**
 * Copias de seguridad automáticas de la base de datos (SQLite).
 * - Snapshot consistente con `VACUUM INTO` (incluye lo confirmado del WAL).
 * - Automático: una copia al arrancar (a los 30 s) y luego cada 30 minutos.
 * - Retención: TODAS las de las últimas 48 h; para más antiguas, 1 por día hasta 30 días.
 * - Avisos: si una copia AUTOMÁTICA falla, se avisa por email a los administradores
 *   (como máximo 1 aviso cada 3 h) y se marca el estado para enseñarlo en el panel.
 * Nota: esto respalda la base de datos (bodas, usuarios, tarifas, etc.). Los archivos subidos
 * (nóminas en disco) deben incluirse además en la copia de la carpeta de datos del servidor.
 */
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR, users } = require('./db');
const mail = require('./mail');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

let lastOk = null;      // { name, date }
let lastError = null;   // { message, date }
let lastAlert = 0;      // control antispam de avisos

const pad = n => String(n).padStart(2, '0');
function stamp(d) { d = d || new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); }
const RE = /^conectaso-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;

function listFiles() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR); } catch (e) { return []; }
  return names.filter(f => RE.test(f)).map(f => {
    const m = RE.exec(f); let size = 0;
    try { size = fs.statSync(path.join(BACKUP_DIR, f)).size; } catch (e) {}
    const dt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return { name: f, size, time: dt.getTime(), day: m[1] + m[2] + m[3] };
  }).sort((a, b) => b.time - a.time);
}

// Política de retención (escalonada) para no acumular copias sin parar:
//   - últimas 2 h: TODAS (grano de 5 min, para recuperar un error muy reciente al minuto)
//   - de 2 h a 48 h: 1 cada 30 min (máxima pérdida posible de datos: 30 min)
//   - de 48 h a 30 días: 1 por día
//   - más de 30 días: se borran
// Además, un TOPE DURO de tamaño total: si aún se pasara, se borran las más antiguas
// (sin tocar nunca las MIN_KEEP más recientes). Con una BD de ~14 MB esto ocupa ~2 GB.
const KEEP_ALL_H = +(process.env.BACKUP_KEEP_ALL_H || 2);        // horas con todas las copias (grano 5 min)
const KEEP_HALF_H = +(process.env.BACKUP_KEEP_HALF_H || 48);     // horas con 1 cada 30 min
const KEEP_DAILY_D = +(process.env.BACKUP_KEEP_DAILY_D || 30);   // días con 1/día
const MAX_TOTAL_BYTES = Math.round(+(process.env.BACKUP_MAX_GB || 15) * 1024 * 1024 * 1024); // tope duro
const MIN_KEEP = 12;   // nunca se borran las 12 copias más recientes, pase lo que pase
const HALF = 30 * 60 * 1000;   // media hora
function totalBytes() { return listFiles().reduce((s, f) => s + (f.size || 0), 0); }
function prune() {
  const now = Date.now(), H = 3600000, DAY = 86400000;
  const files = listFiles(); const keep = new Set(); const halfKept = {}, dayKept = {};
  files.forEach(f => {
    const age = now - f.time;
    if (age <= KEEP_ALL_H * H) { keep.add(f.name); return; }
    if (age <= KEEP_HALF_H * H) { const hk = Math.floor(f.time / HALF); if (!halfKept[hk]) { halfKept[hk] = 1; keep.add(f.name); } return; }
    if (age <= KEEP_DAILY_D * DAY) { if (!dayKept[f.day]) { dayKept[f.day] = 1; keep.add(f.name); } return; }
    // más de 30 días: no se guarda
  });
  files.forEach(f => { if (!keep.has(f.name)) { try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch (e) {} } });
  // Tope duro de tamaño: si tras la poda aún se pasa, se borran de la más vieja a la más nueva.
  let remaining = listFiles();   // ordenadas de más nueva a más vieja
  let total = remaining.reduce((s, f) => s + (f.size || 0), 0);
  for (let i = remaining.length - 1; i >= MIN_KEEP && total > MAX_TOTAL_BYTES; i--) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, remaining[i].name)); total -= remaining[i].size || 0; } catch (e) {}
  }
}

function snapshot(reason) {
  const name = 'conectaso-' + stamp() + '.db';
  const dest = path.join(BACKUP_DIR, name);
  db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
  let size = 0; try { size = fs.statSync(dest).size; } catch (e) {}
  prune();
  lastOk = { name, date: new Date().toISOString() };
  // Copia 2 (fuera del servidor): subida a la nube en segundo plano. No bloquea ni rompe la copia local.
  // Sube la base de datos y, si han cambiado, también los archivos subidos (nóminas, planos, adjuntos…).
  try {
    const cloud = require('./cloud-backup');
    if (cloud.enabled()) { cloud.syncSnapshot(dest, name).catch(() => {}); cloud.syncFiles().catch(() => {}); }
  } catch (e) {}
  return { name, size, reason: reason || 'auto', date: lastOk.date };
}

function alertFail(err) {
  const now = Date.now();
  if (now - lastAlert < 3 * 60 * 60 * 1000) return;   // máx. 1 aviso cada 3 h
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
      subject: '⚠ Fallo en la copia de seguridad — Conecta So',
      text: 'La copia de seguridad automática de la intranet ha FALLADO el ' + when + '.\n\nError: ' + msg + '\n\nConviene revisar el servidor (espacio en disco).',
      html: '<p>La copia de seguridad automática de la intranet <b>ha fallado</b>.</p><p>Fecha: ' + when + '<br>Error: ' + msg.replace(/</g, '&lt;') + '</p><p>Conviene revisar el servidor (sobre todo el espacio en disco).</p>'
    });
  } catch (e) {}
}

// Para las copias AUTOMÁTICAS: no lanza; registra el error y avisa.
function safeSnapshot(reason) {
  try { return snapshot(reason); }
  catch (e) {
    lastError = { message: e.message, date: new Date().toISOString() };
    console.error('[backup] fallo:', e.message);
    alertFail(e);
    return null;
  }
}

function status() {
  const files = listFiles();
  const okT = lastOk ? new Date(lastOk.date).getTime() : (files[0] ? files[0].time : 0);
  const errT = lastError ? new Date(lastError.date).getTime() : 0;
  const healthy = okT >= errT;                               // el último intento fue correcto
  const stale = !okT || (Date.now() - okT > 30 * 60 * 1000); // sin copia correcta en > 30 min
  const totBytes = files.reduce((s, f) => s + (f.size || 0), 0);
  return { healthy, stale, lastOk: lastOk || (files[0] ? { name: files[0].name, date: new Date(files[0].time).toISOString() } : null), lastError,
    count: files.length, totalBytes: totBytes, maxBytes: MAX_TOTAL_BYTES };
}

function list() { return listFiles().map(f => ({ name: f.name, size: f.size, date: new Date(f.time).toISOString() })); }
function fileFor(name) { if (!RE.test(String(name || ''))) return null; const p = path.join(BACKUP_DIR, name); return fs.existsSync(p) ? p : null; }

let timer = null;
const INTERVAL_MIN = 5;   // cada cuántos minutos se hace copia local (la nube se sube como mucho cada 15 min)
function start() {
  if (timer) return;
  setTimeout(() => { safeSnapshot('startup'); }, 30000);
  // Limpieza inmediata en la nube al arrancar: borra las copias sobrantes enseguida tras un despliegue,
  // sin esperar al ciclo horario (así el espacio baja cuanto antes y no se llega al límite de 10 GB).
  setTimeout(() => { try { const cloud = require('./cloud-backup'); if (cloud.enabled()) cloud.pruneAll().then(r => { if (r) console.log('[cloud-backup] limpieza al arrancar:', JSON.stringify(r)); }).catch(() => {}); } catch (e) {} }, 90000);
  timer = setInterval(() => {
    // De madrugada (02:00–06:00) hay poca actividad: copia solo cada ~30 min en vez de cada 5.
    const h = new Date().getHours();
    if (h >= 2 && h < 6) {
      const lastT = lastOk ? new Date(lastOk.date).getTime() : 0;
      if (Date.now() - lastT < 29 * 60 * 1000) return;   // ya hay una copia de hace menos de 30 min
    }
    safeSnapshot('auto');
  }, INTERVAL_MIN * 60 * 1000);
  console.log('[backup] copias automáticas activas (cada ' + INTERVAL_MIN + ' min; de 02:00 a 06:00 cada ~30 min). Carpeta:', BACKUP_DIR);
}

module.exports = { snapshot, safeSnapshot, list, fileFor, status, start, BACKUP_DIR };
