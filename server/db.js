'use strict';
/**
 * Base de datos SQLite (módulo integrado node:sqlite).
 * - users: cuentas con contraseña y rol.
 * - records: almacén por colección (eventos, localizaciones, fichajes…) con el registro en JSON
 *   y columnas indexadas para filtrar por permisos.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'conectaso.db');

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin','dj','planner','user')),
  active INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ip TEXT
);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invite','reset','albaran')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL,
  id INTEGER NOT NULL,
  data TEXT NOT NULL,
  owner_id INTEGER,
  dj_id INTEGER,
  wp_id INTEGER,
  staff TEXT,
  date TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS rec_owner ON records(collection, owner_id);
CREATE INDEX IF NOT EXISTS rec_dj ON records(collection, dj_id);
CREATE INDEX IF NOT EXISTS rec_wp ON records(collection, wp_id);
CREATE INDEX IF NOT EXISTS rec_date ON records(collection, date);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL,
  uploaded_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS files_rec ON files(collection, record_id);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  action TEXT NOT NULL,
  collection TEXT,
  record_id INTEGER
);
`);

const COLLECTIONS = ['events', 'locations', 'extras', 'attendances', 'vacations', 'payments', 'vehicles',
  'usages', 'tacs', 'workers', 'history', 'extraRequests', 'events_trash', 'adjustments', 'maintenance'];

/** Columnas indexadas derivadas del registro, según la colección. */
function indexCols(collection, rec) {
  const out = { owner_id: null, dj_id: null, wp_id: null, staff: null, date: null };
  if (collection === 'events') {
    out.owner_id = rec.userId || null;
    out.dj_id = rec.djId || null;
    out.wp_id = rec.wpId || null;
    const ids = new Set();
    if (rec.djId) ids.add(+rec.djId);
    (rec.services || []).forEach(s => { if (s.resp) ids.add(+s.resp); if (s.resp2) ids.add(+s.resp2); });
    out.staff = ids.size ? ',' + [...ids].join(',') + ',' : null;
    out.date = rec.fecha || null;
  } else if (['attendances', 'vacations', 'payments', 'usages'].includes(collection)) {
    out.owner_id = rec.userId || null;
    out.date = rec.date || rec.start || null;
  } else if (collection === 'history' || collection === 'workers') {
    out.owner_id = rec.id;
  }
  return out;
}

const stmts = {
  get: db.prepare('SELECT data FROM records WHERE collection = ? AND id = ?'),
  all: db.prepare('SELECT data FROM records WHERE collection = ? ORDER BY id'),
  byOwner: db.prepare('SELECT data FROM records WHERE collection = ? AND owner_id = ? ORDER BY id'),
  byStaff: db.prepare("SELECT data FROM records WHERE collection = ? AND staff LIKE ? ORDER BY id"),
  byWp: db.prepare('SELECT data FROM records WHERE collection = ? AND wp_id = ? ORDER BY id'),
  upsert: db.prepare(`INSERT INTO records (collection, id, data, owner_id, dj_id, wp_id, staff, date, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, owner_id = excluded.owner_id, dj_id = excluded.dj_id,
      wp_id = excluded.wp_id, staff = excluded.staff, date = excluded.date, updated_at = excluded.updated_at`),
  del: db.prepare('DELETE FROM records WHERE collection = ? AND id = ?'),
  maxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM records WHERE collection = ?'),
  setting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  audit: db.prepare('INSERT INTO audit (user_id, action, collection, record_id) VALUES (?, ?, ?, ?)'),
};
const parse = r => (r ? JSON.parse(r.data) : null);

// Caché en memoria de colecciones enteras: store.all() parseaba todos los registros
// (p. ej. 2300+ eventos = ~140 ms) en cada llamada. Se invalida al escribir en esa colección.
const _allCache = {};
const invalidate = c => { delete _allCache[c]; };

const store = {
  get: (c, id) => parse(stmts.get.get(c, +id)),
  all: c => { if (!_allCache[c]) _allCache[c] = stmts.all.all(c).map(parse); return _allCache[c].slice(); },
  byOwner: (c, uid) => stmts.byOwner.all(c, +uid).map(parse),
  byStaff: (c, uid) => stmts.byStaff.all(c, `%,${+uid},%`).map(parse),
  byWp: (c, uid) => stmts.byWp.all(c, +uid).map(parse),
  nextId: c => stmts.maxId.get(c).m + 1,
  put(c, rec) {
    if (!COLLECTIONS.includes(c)) throw new Error('Colección desconocida: ' + c);
    if (!rec.id) rec.id = store.nextId(c);
    const ix = indexCols(c, rec);
    stmts.upsert.run(c, +rec.id, JSON.stringify(rec), ix.owner_id, ix.dj_id, ix.wp_id, ix.staff, ix.date);
    invalidate(c);
    return rec;
  },
  del: (c, id) => { const r = stmts.del.run(c, +id).changes > 0; invalidate(c); return r; },
  setting: k => { const r = stmts.setting.get(k); return r ? JSON.parse(r.value) : null; },
  setSetting: (k, v) => stmts.setSetting.run(k, JSON.stringify(v)),
  audit: (uid, action, c, id) => { try { stmts.audit.run(uid || null, action, c || null, id ? +id : null); } catch (e) { /* no bloquear */ } },
};

/* ---------- usuarios ---------- */
const u = {
  get: db.prepare('SELECT * FROM users WHERE id = ?'),
  byEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
  all: db.prepare('SELECT * FROM users ORDER BY id'),
  insert: db.prepare('INSERT INTO users (id, email, name, role, active, password_hash, data) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  update: db.prepare('UPDATE users SET email = ?, name = ?, role = ?, active = ?, data = ? WHERE id = ?'),
  setPass: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM users WHERE id = ?'),
  maxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM users'),
  touch: db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?"),
};
/** Vista pública de un usuario (sin hash de contraseña). */
function publicUser(row) {
  if (!row) return null;
  const data = JSON.parse(row.data || '{}');
  return Object.assign({}, data, {
    id: row.id, email: row.email, mail: row.email, name: row.name, role: row.role, active: !!row.active,
    hasPassword: !!row.password_hash, lastLogin: row.last_login,
  });
}
const users = {
  getRow: id => u.get.get(+id),
  byEmail: email => u.byEmail.get(String(email || '').trim()),
  get: id => publicUser(u.get.get(+id)),
  all: () => u.all.all().map(publicUser),
  create({ id, email, name, role, active = true, data = {} }, passwordHash = null) {
    const nid = id || u.maxId.get().m + 1;
    u.insert.run(nid, String(email).trim(), name || '', role, active ? 1 : 0, passwordHash, JSON.stringify(data));
    return users.get(nid);
  },
  update(id, { email, name, role, active, data }) {
    const row = u.get.get(+id); if (!row) return null;
    const cur = JSON.parse(row.data || '{}');
    u.update.run(email != null ? String(email).trim() : row.email, name != null ? name : row.name, role || row.role,
      active == null ? row.active : (active ? 1 : 0), JSON.stringify(data ? Object.assign(cur, data) : cur), +id);
    return users.get(id);
  },
  setPassword: (id, hash) => u.setPass.run(hash, +id),
  del: id => u.del.run(+id).changes > 0,
  touch: id => u.touch.run(+id),
};

function transaction(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---------- migración: tiempos/km de desplazamiento de las fincas ----------
 * Rellena travelMin/travelKm/lat/lng/directionLink en las fincas que aún no los
 * tengan (valores de referencia desde Martorelles). Es idempotente: solo toca la
 * finca a la que le falten los datos, así que respeta cualquier edición manual.
 */
function migrateFincasTravel() {
  let data;
  try { data = require('./fincas-travel.json'); } catch (e) { return; }
  let n = 0;
  for (const t of data) {
    const loc = store.get('locations', t.id);
    if (!loc) continue;
    if (loc.travelKm != null && loc.travelMin != null && loc.lat != null) continue; // ya está
    loc.travelMin = (loc.travelMin != null ? loc.travelMin : t.travelMin);
    loc.travelKm = (loc.travelKm != null ? loc.travelKm : t.travelKm);
    if (loc.travelApprox == null) loc.travelApprox = !!t.travelApprox;
    if (loc.lat == null) loc.lat = t.lat;
    if (loc.lng == null) loc.lng = t.lng;
    if (!loc.directionLink && t.directionLink) loc.directionLink = t.directionLink;
    store.put('locations', loc);
    n++;
  }
  if (n) console.log('[migración] Desplazamientos de fincas rellenados en', n, 'fincas.');
}
try { migrateFincasTravel(); } catch (e) { console.error('[migración] fincas-travel:', e.message); }

/* ---------- migración: tarifas de DJ por finca (djRates) ----------
 * El motor de facturación necesita las tarifas base/hora-extra/servicios por DJ.
 * Se guardan como setting 'djRates' si aún no existe.
 */
function migrateDjRates() {
  if (stmts.setting.get('djRates')) return; // ya está
  let data;
  try { data = require('./djRates.json'); } catch (e) { return; }
  store.setSetting('djRates', data);
  console.log('[migración] Tarifas de DJ (djRates) cargadas:', Object.keys(data).length, 'DJs.');
}
try { migrateDjRates(); } catch (e) { console.error('[migración] djRates:', e.message); }

// Amplía el CHECK de 'tokens.kind' para permitir 'albaran' (enlace de autologin del DJ).
function migrateTokensKind() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tokens'").get();
  if (!row || !row.sql || row.sql.includes('albaran')) return; // ya migrada o nueva
  db.exec(`
    CREATE TABLE tokens_new (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('invite','reset','albaran')),
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    INSERT INTO tokens_new (token_hash,user_id,kind,expires_at,used_at) SELECT token_hash,user_id,kind,expires_at,used_at FROM tokens;
    DROP TABLE tokens;
    ALTER TABLE tokens_new RENAME TO tokens;
  `);
  console.log('[migración] tabla tokens: CHECK de kind ampliado con albaran.');
}
try { migrateTokensKind(); } catch (e) { console.error('[migración] tokens-kind:', e.message); }

// Elimina el estado "No contactado admin" (índice 0): los eventos que lo tenían pasan a
// "No contactado dj". El resto de estados bajan un índice. Idempotente (solo corre si existe).
function migrateRemoveAdminState() {
  const estados = store.setting('estados');
  if (!Array.isArray(estados) || !estados.length) return;
  if (!/no\s+contactad[oa]\s+admin/i.test(estados[0].n || '')) return; // ya migrado
  let n = 0;
  ['events', 'events_trash'].forEach(col => {
    store.all(col).forEach(ev => {
      const old = +ev.estado || 0;
      const neu = Math.max(0, old - 1);
      if (neu !== old) { ev.estado = neu; store.put(col, ev); n++; }
    });
  });
  store.setSetting('estados', estados.slice(1));
  console.log('[migración] estado "No contactado admin" eliminado; ' + n + ' eventos remapeados a "No contactado dj".');
}
try { migrateRemoveAdminState(); } catch (e) { console.error('[migración] estados:', e.message); }

// Activa el control horario (fichaje) a los DJs/técnicos que YA tienen fichajes registrados,
// para que lo conserven. A partir de ahí lo decide el interruptor de su ficha. Idempotente.
function migrateTimeTracking() {
  if (store.setting('mig_time_tracking')) return;
  const ids = [...new Set(store.all('attendances').map(a => +a.userId).filter(Boolean))];
  let n = 0;
  ids.forEach(id => { const uu = users.get(id); if (uu && uu.role === 'dj' && !uu.time_tracking) { users.update(id, { data: { time_tracking: true } }); n++; } });
  store.setSetting('mig_time_tracking', true);
  console.log('[migración] control horario habilitado para ' + n + ' DJs con fichajes previos.');
}
try { migrateTimeTracking(); } catch (e) { console.error('[migración] time-tracking:', e.message); }

module.exports = { db, store, users, transaction, COLLECTIONS, DATA_DIR, DB_PATH };
