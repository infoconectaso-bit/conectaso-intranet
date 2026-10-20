'use strict';
/**
 * Importa seed.json (la extracción convertida) a la base de datos.
 * Uso: node scripts/import.js [ruta/seed.json]
 * Es idempotente: vuelve a escribir cada registro con su id original.
 */
const fs = require('fs');
const path = require('path');
const { store, users, transaction, db } = require('../server/db');

const SEED = process.argv[2] || path.join(__dirname, '..', 'data', 'seed.json');
if (!fs.existsSync(SEED)) { console.error('No se encuentra', SEED); process.exit(1); }
const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));

const COLS = ['locations', 'extras', 'events', 'attendances', 'vacations', 'payments', 'vehicles', 'usages', 'tacs', 'workers', 'extraRequests'];

let counts = {};
transaction(() => {
  // Usuarios (sin contraseña: se invitan después). Se conserva el id original.
  const uIns = db.prepare('INSERT INTO users (id, email, name, role, active, password_hash, data) VALUES (?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, role=excluded.role, data=excluded.data');
  let nu = 0, dupes = 0;
  const seen = new Map(); // email en minúsculas -> id que lo usó primero
  for (const u of seed.users) {
    const data = {};
    for (const k of ['worker_type', 'color', 'vehicle_allowed', 'sending', 'prices', 'tyc']) if (u[k] !== undefined) data[k] = u[k];
    let email = (u.mail || '').trim() || `sin-email-${u.id}@conectaso.local`;
    const key = email.toLowerCase();
    if (seen.has(key)) {
      // Email repetido en el origen: se conserva el real y se marca el duplicado con el id para no perder la cuenta.
      data.emailOriginal = email;
      data.emailDuplicado = true;
      const at = email.indexOf('@');
      email = at > 0 ? `${email.slice(0, at)}+u${u.id}${email.slice(at)}` : `dup-${u.id}@conectaso.local`;
      dupes++;
    } else seen.set(key, u.id);
    uIns.run(u.id, email, u.name || '', ['admin', 'dj', 'planner', 'user'].includes(u.role) ? u.role : 'user', 1, JSON.stringify(data));
    nu++;
  }
  counts.users = nu;
  counts['(emails duplicados renombrados)'] = dupes;

  // Colecciones
  for (const c of COLS) {
    const list = seed[c] || [];
    for (const rec of list) store.put(c, rec);
    counts[c] = list.length;
  }
  // Históricos de pago (objeto id->datos)
  if (seed.historico) {
    let n = 0;
    for (const [id, h] of Object.entries(seed.historico)) { store.put('history', Object.assign({ id: +id }, h)); n++; }
    counts.history = n;
  }
  // Ajustes y catálogos
  store.setSetting('estados', [
    { n: 'No contactado admin', c: '#D50000' }, { n: 'No contactado dj', c: '#8E24AA' },
    { n: 'Contactado', c: '#F6BF26' }, { n: 'Meeting realizado', c: '#FF7800' }, { n: 'Completado', c: '#0B8043' }]);
  store.setSetting('tipos', ['Recomendado', 'Fiesta', 'Bodorrio', 'Tinglado', 'Corporativo', 'Extras']);
  if (seed.beneficios) store.setSetting('beneficios', seed.beneficios);
  store.setSetting('staffIds', seed.staffIds || []);
  store.setSetting('importedAt', new Date().toISOString());
});

console.log('Importación completada:');
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
console.log('\nLos usuarios se han importado SIN contraseña. Crea el primer administrador con:  npm run create-admin');
