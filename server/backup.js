'use strict';
/**
 * Copias de seguridad automáticas de la base de datos (SQLite).
 * - Snapshot consistente con `VACUUM INTO` (incluye lo confirmado del WAL).
 * - Automático: una copia al arrancar (a los 30 s) y luego cada hora.
 * - Retención: TODAS las de las últimas 48 h; para más antiguas, 1 por día hasta 30 días.
 * Nota: esto respalda la base de datos (bodas, usuarios, tarifas, etc.). Los archivos subidos
 * (nóminas en disco) deben incluirse además en la copia de la carpeta de datos del servidor.
 */
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

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
    if (now - f.time <= 2 * DAY) { keep.add(f.name); return; }                 // últimas 48 h: todas
    if (now - f.time <= 30 * DAY) { if (!dailyKept[f.day]) { dailyKept[f.day] = 1; keep.add(f.name); } return; } // 1/día, 30 días
    // > 30 días: se borra
  });
  files.forEach(f => { if (!keep.has(f.name)) { try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch (e) {} } });
}

function snapshot(reason) {
  const name = 'conectaso-' + stamp() + '.db';
  const dest = path.join(BACKUP_DIR, name);
  db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
  let size = 0; try { size = fs.statSync(dest).size; } catch (e) {}
  prune();
  return { name, size, reason: reason || 'auto', date: new Date().toISOString() };
}

function list() { return listFiles().map(f => ({ name: f.name, size: f.size, date: new Date(f.time).toISOString() })); }
function fileFor(name) { if (!RE.test(String(name || ''))) return null; const p = path.join(BACKUP_DIR, name); return fs.existsSync(p) ? p : null; }

let timer = null;
function start() {
  if (timer) return;
  setTimeout(() => { try { snapshot('startup'); } catch (e) { console.error('[backup] arranque:', e.message); } }, 30000);
  timer = setInterval(() => { try { snapshot('hourly'); } catch (e) { console.error('[backup] hora:', e.message); } }, 60 * 60 * 1000);
  console.log('[backup] copias automáticas activas (horaria). Carpeta:', BACKUP_DIR);
}

module.exports = { snapshot, list, fileFor, start, BACKUP_DIR };
