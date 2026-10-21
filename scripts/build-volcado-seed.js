'use strict';
/**
 * Construye data/volcado-seed.json a partir de los 3 export crudos del navegador:
 *   - eventos (full)   -> 2724 fichas crudas
 *   - usuarios (full)  -> 2068 fichas crudas
 *   - small            -> localizaciones / vehículos / extras / tacs
 *
 * Reglas acordadas con Adrià:
 *   - El titular (userId) NO viene en la ficha del evento: se recupera del seed actual
 *     (que ya tenía los titulares correctos). Para los eventos nuevos que no están en el
 *     seed, no hay titular recuperable -> userId null.
 *   - De los eventos que NO están en el seed (ocultos, no salen en las listas):
 *       · se MIGRAN los futuros (fecha >= hoy) y los de pipeline activo (estado 1-4 sin fecha)
 *       · se DESCARTAN los pasados (fecha < hoy) y los borradores vacíos (estado 0 sin fecha)
 *   - Corporativo y Extras no tienen cónyuges/música: es correcto que salgan "(sin nombre)".
 *
 * Uso: node scripts/build-volcado-seed.js <eventos.json> <usuarios.json> <small.json> [YYYY-MM-DD]
 */
const fs = require('fs');
const path = require('path');
const V = require('../server/volcado');

const [, , fEvents, fUsers, fSmall, todayArg] = process.argv;
if (!fEvents || !fUsers || !fSmall) {
  console.error('Uso: node scripts/build-volcado-seed.js <eventos.json> <usuarios.json> <small.json> [YYYY-MM-DD]');
  process.exit(1);
}
const TODAY = todayArg || new Date().toISOString().slice(0, 10);
const rd = f => JSON.parse(fs.readFileSync(f, 'utf8'));

const rawEvents = rd(fEvents).events;
const rawUsers = rd(fUsers).users;
const small = rd(fSmall);
const seedPath = path.join(__dirname, '..', 'data', 'seed.json');
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

// titular por id de evento, recuperado del seed actual
const ownerById = {};
seed.events.forEach(e => { if (e.userId != null && e.userId !== '') ownerById[e.id] = e.userId; });
const seedEventIds = new Set(seed.events.map(e => e.id));

// --- USUARIOS (se construyen primero para poder recuperar titulares por email) ---
const users = rawUsers.map(r => { const u = V.mapUser(r); u.id = r.__id; return u; });
const userByEmail = {};
users.forEach(u => { if (u.mail) userByEmail[u.mail.trim().toLowerCase()] = u.id; });
// raw de evento por id (para leer emails de cónyuge si falta titular)
const rawEvById = {};
rawEvents.forEach(r => { rawEvById[r.__id] = r; });

// ¿tiene el evento contenido real? (pago 1/1 = bola verde por defecto, NO cuenta; filas de opcionales vacías tampoco)
function hasContent(e) {
  if (e.conyuges && e.conyuges.trim().length > 2) return true;
  if (e.music && Object.values(e.music).some(m => m && m.song && String(m.song).trim())) return true;
  if (e.services && e.services.length) return true;
  if (e.extras && Object.keys(e.extras).length) return true;
  if (e.optionals && e.optionals.some(o => (o.title && String(o.title).trim()) || (o.value && String(o.value).trim()))) return true;
  if (+e.pagoCliente > 1 || +e.pagado > 1) return true;
  if ((e.obsPriv && e.obsPriv.trim()) || (e.obsDj && e.obsDj.trim())) return true;
  if (e.disco && Object.values(e.disco).some(v => v && String(v).trim())) return true;
  if (e.files && e.files.length) return true;
  if (e.description && e.description.trim()) return true;
  return false;
}
function ownerBySpouseEmail(id) {
  const r = rawEvById[id]; if (!r) return null;
  for (const em of [r.first_spouse_email, r.second_spouse_email]) {
    const k = (em || '').trim().toLowerCase();
    if (k && userByEmail[k]) return userByEmail[k];
  }
  return null;
}

// --- EVENTOS ---
const events = [];
const report = { futurosMigrados: [], activosSinFechaMigrados: [], pasadosDescartados: [], vaciosDescartados: 0, deListaMigrados: 0, sinTitular: 0, unmapped: new Set() };
for (const raw of rawEvents) {
  const { ev, unmapped } = V.mapEvent(raw);
  unmapped.forEach(u => report.unmapped.add(u));
  ev.id = raw.__id;
  // titular: 1º del seed (listas), 2º por email de cónyuge
  if (ownerById[ev.id] != null) ev.userId = ownerById[ev.id];
  if (ev.userId == null) { const uid = ownerBySpouseEmail(ev.id); if (uid != null) { ev.userId = uid; report.titularPorEmail = (report.titularPorEmail || 0) + 1; } }
  const enLista = seedEventIds.has(ev.id);

  if (enLista) {
    report.deListaMigrados++;
    if (ev.userId == null) report.sinTitular++;
    events.push(ev);
    continue;
  }
  // evento oculto (no está en el seed / listas): aplicar regla de Adrià
  const f = ev.fecha;
  const est = ev.estado;
  if (f && f >= TODAY) { report.futurosMigrados.push({ id: ev.id, fecha: f, tipo: ev.tipo, conyuges: ev.conyuges }); events.push(ev); if (ev.userId == null) report.sinTitular++; }
  else if (f && f < TODAY) { report.pasadosDescartados.push({ id: ev.id, fecha: f, tipo: ev.tipo, conyuges: ev.conyuges }); }
  else if (est >= 1 && est <= 4 && hasContent(ev)) { report.activosSinFechaMigrados.push({ id: ev.id, estado: est, tipo: ev.tipo, conyuges: ev.conyuges, dj: ev.djId }); events.push(ev); if (ev.userId == null) report.sinTitular++; }
  else if (est >= 1 && est <= 4) { (report.vaciosActivosDescartados = report.vaciosActivosDescartados || []).push(ev.id); }  // concha vacía sin contenido
  else { report.vaciosDescartados++; }
}

// --- COLECCIONES PEQUEÑAS ---
const locations = (small.locations || []).map(V.mapLocation);
const vehicles = (small.vehicles || []).map(V.mapVehicle);
const extras = (small.extras || []).map(V.mapExtra);
const tacs = (small.tacs || []).map(r => ({ id: +r.__id || undefined, date: r.date || '', text: r.text || '', deposit_amount: r.deposit_amount || '' }));

// settings a conservar del seed actual (para que el import no los pise con vacío)
const out = {
  type: 'volcado-seed',
  builtAt: new Date().toISOString(),
  today: TODAY,
  events, users, locations, vehicles, extras, tacs,
  staffIds: seed.staffIds || [],
  beneficios: seed.beneficios || null,
};

const outPath = path.join(__dirname, '..', 'data', 'volcado-seed.json');
fs.writeFileSync(outPath, JSON.stringify(out));

// --- INFORME ---
console.log('=== VOLCADO SEED CONSTRUIDO ===');
console.log('fecha corte (hoy):', TODAY);
console.log('eventos crudos:', rawEvents.length);
console.log('  en listas (migrados):', report.deListaMigrados);
console.log('  ocultos FUTUROS migrados:', report.futurosMigrados.length);
console.log('  ocultos ACTIVOS sin fecha CON contenido migrados:', report.activosSinFechaMigrados.length);
console.log('  ocultos ACTIVOS sin fecha VACÍOS descartados:', (report.vaciosActivosDescartados || []).length, report.vaciosActivosDescartados || []);
console.log('  ocultos PASADOS descartados:', report.pasadosDescartados.length);
console.log('  ocultos VACÍOS descartados:', report.vaciosDescartados);
console.log('  --> EVENTOS FINALES:', events.length);
console.log('  titulares recuperados por email de cónyuge:', report.titularPorEmail || 0);
console.log('  eventos sin titular recuperable:', report.sinTitular);
console.log('usuarios:', users.length, '| localizaciones:', locations.length, '| vehículos:', vehicles.length, '| extras:', extras.length, '| tacs:', tacs.length);
console.log('CAMPOS SIN MAPEAR (debe ser 0):', [...report.unmapped]);
console.log('\nPASADOS descartados:');
report.pasadosDescartados.forEach(x => console.log('   id', x.id, '|', x.fecha, '|', x.tipo, '|', (x.conyuges || '(sin nombre)')));
console.log('\narchivo:', outPath, '(', (fs.statSync(outPath).size / 1048576).toFixed(1), 'MB )');
