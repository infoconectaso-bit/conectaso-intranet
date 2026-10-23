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

function prune() {
  const now = Date.now(), DAY = 86400000;
  const files = listFiles(); const keep = new Set(); const dailyKept = {};
  files.forEach(f => {
    if (now - f.time <= 1 * DAY) { keep.add(f.name); return; }                 // últimas 24 h: todas
    if (now - f.time <= 30 * DAY) { if (!dailyKept[f.day]) { dailyKept[f.day] = 1; keep.add(f.name); } return; } // 1/día, 30 días
  });
  files.forEach(f => { if (!keep.has(f.name)) { try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch (e) {} } });
}

function snapshot(reason) {
  const name = 'conectaso-' + stamp() + '.db';
  const dest = path.join(BACKUP_DIR, name);
  db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
  let size = 0; try { size = fs.statSync(dest).size; } catch (e) {}
  prune();
  lastOk = { name, date: new Date().toISOString() };
  // Copia 2 (fuera del servidor): subida a la nube en segundo plano. No bloquea ni rompe la copia local.
  try {
    const cloud = require('./cloud-backup');
    if (cloud.enabled()) cloud.syncSnapshot(dest, name).catch(() => {});
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
  return { healthy, stale, lastOk: lastOk || (files[0] ? { name: files[0].name, date: new Date(files[0].time).toISOString() } : null), lastError };
}

function list() { return listFiles().map(f => ({ name: f.name, size: f.size, date: new Date(f.time).toISOString() })); }
function fileFor(name) { if (!RE.test(String(name || ''))) return null; const p = path.join(BACKUP_DIR, name); return fs.existsSync(p) ? p : null; }

let timer = null;
const INTERVAL_MIN = 5;   // cada cuántos minutos se hace copia (local + subida a la nube)
function start() {
  if (timer) return;
  setTimeout(() => { safeSnapshot('startup'); }, 30000);
  timer = setInterval(() => { safeSnapshot('auto'); }, INTERVAL_MIN * 60 * 1000);
  console.log('[backup] copias automáticas activas (cada ' + INTERVAL_MIN + ' min). Carpeta:', BACKUP_DIR);
}

module.exports = { snapshot, safeSnapshot, list, fileFor, status, start, BACKUP_DIR };
