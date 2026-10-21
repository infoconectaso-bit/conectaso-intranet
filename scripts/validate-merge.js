'use strict';
/**
 * Valida la lógica de merge SIN tocar la base de datos real.
 * Simula la BD actual con data/seed.json, inyecta añadidos "nuestros" y comprueba que el
 * volcado los preserva y que los campos de la intranet se actualizan.
 */
const fs = require('fs');
const path = require('path');
const importer = require('../server/volcado-import');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed.json'), 'utf8'));
const vs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'volcado-seed.json'), 'utf8'));

// ---- BD simulada en memoria ----
const mem = { events: {}, locations: {}, vehicles: {}, extras: {}, tacs: {} };
seed.events.forEach(e => mem.events[e.id] = JSON.parse(JSON.stringify(e)));
seed.locations.forEach(e => mem.locations[e.id] = JSON.parse(JSON.stringify(e)));
seed.vehicles.forEach(e => mem.vehicles[e.id] = JSON.parse(JSON.stringify(e)));
seed.extras.forEach(e => mem.extras[e.id] = JSON.parse(JSON.stringify(e)));
seed.tacs.forEach(e => mem.tacs[e.id] = JSON.parse(JSON.stringify(e)));
const memUsers = {};
seed.users.forEach(u => { const d = {}; ['worker_type', 'color', 'vehicle_allowed', 'sending', 'prices', 'tyc'].forEach(k => { if (u[k] !== undefined) d[k] = u[k]; }); memUsers[u.id] = { id: u.id, email: u.mail || '', name: u.name || '', role: u.role, data: JSON.stringify(d) }; });
const settings = {};

// ---- INYECTAR añadidos NUESTROS para probar preservación ----
// evento existente: campos nuestros
const EV_TEST = seed.events[0].id;
mem.events[EV_TEST].ceremoniaFuera = true;
mem.events[EV_TEST].labels = { rojo: true };
mem.events[EV_TEST].entregas = [{ fecha: '2026-01-01', nota: 'prueba' }];
mem.events[EV_TEST].pagoRestaurante = 999;
mem.events[EV_TEST].campoInventado = 'NO BORRAR';
// finca existente: geocodificación nuestra
const LOC_TEST = seed.locations[0].id;
mem.locations[LOC_TEST].lat = 41.5; mem.locations[LOC_TEST].lng = 2.2; mem.locations[LOC_TEST].travelMin = 33;
// usuario DJ existente: time_tracking nuestro
const DJ_TEST = seed.users.find(u => u.role === 'dj').id;
{ const d = JSON.parse(memUsers[DJ_TEST].data); d.time_tracking = true; d.algoNuestro = 'X'; memUsers[DJ_TEST].data = JSON.stringify(d); }

// valor intranet que DEBE actualizarse: cambiamos el estado del evento de prueba a algo falso
const estadoFalso = 42; mem.events[EV_TEST].estado = estadoFalso;
const estadoVolcado = vs.events.find(e => e.id === EV_TEST).estado;

// ---- stubs store/users/transaction ----
const store = {
  get: (c, id) => mem[c][id] ? JSON.parse(JSON.stringify(mem[c][id])) : null,
  put: (c, rec) => { mem[c][rec.id] = JSON.parse(JSON.stringify(rec)); return rec; },
  setting: k => (k in settings ? settings[k] : null),
  setSetting: (k, v) => { settings[k] = v; },
};
const users = {
  all: () => Object.values(memUsers).map(r => ({ id: r.id, email: r.email, name: r.name, role: r.role })),
  getRow: id => memUsers[id] ? Object.assign({}, memUsers[id]) : null,
  update: (id, { email, name, role, data }) => { const r = memUsers[id]; const cur = JSON.parse(r.data || '{}'); r.email = email != null ? email : r.email; r.name = name != null ? name : r.name; r.role = role || r.role; r.data = JSON.stringify(data ? Object.assign(cur, data) : cur); },
  create: ({ id, email, name, role, data }) => { memUsers[id] = { id, email, name, role, data: JSON.stringify(data || {}) }; },
};
const transaction = fn => fn();

// ---- EJECUTAR ----
const counts = importer.run(vs, { store, users, transaction });
console.log('=== RECUENTOS MERGE ===');
console.log(JSON.stringify(counts, null, 2));

// ---- COMPROBACIONES ----
let ok = true; const fail = (m) => { ok = false; console.log('  ❌', m); };
const pass = (m) => console.log('  ✅', m);

const ev = mem.events[EV_TEST];
ev.ceremoniaFuera === true ? pass('evento: ceremoniaFuera preservado') : fail('ceremoniaFuera perdido -> ' + ev.ceremoniaFuera);
ev.labels && ev.labels.rojo === true ? pass('evento: labels preservados') : fail('labels perdidos');
ev.entregas && ev.entregas.length === 1 ? pass('evento: entregas preservadas') : fail('entregas perdidas');
ev.pagoRestaurante === 999 ? pass('evento: pagoRestaurante preservado') : fail('pagoRestaurante perdido');
ev.campoInventado === 'NO BORRAR' ? pass('evento: clave extra nuestra preservada') : fail('clave extra perdida');
ev.estado === estadoVolcado && ev.estado !== estadoFalso ? pass('evento: estado ACTUALIZADO desde intranet (' + estadoFalso + ' -> ' + ev.estado + ')') : fail('estado no actualizado: ' + ev.estado);

const loc = mem.locations[LOC_TEST];
loc.lat === 41.5 && loc.lng === 2.2 && loc.travelMin === 33 ? pass('finca: lat/lng/travelMin preservados') : fail('geocodificación perdida');
loc.name === vs.locations.find(l => l.id === LOC_TEST).name ? pass('finca: nombre actualizado desde intranet') : fail('nombre finca no actualizado');

const dj = JSON.parse(memUsers[DJ_TEST].data);
dj.time_tracking === true ? pass('usuario: time_tracking preservado') : fail('time_tracking PERDIDO');
dj.algoNuestro === 'X' ? pass('usuario: clave extra en data preservada') : fail('clave extra en data perdida');

// recuentos esperados
counts.events.actualizados === 2328 && counts.events.nuevos === 22 ? pass('eventos: 2328 actualizados + 22 nuevos = ' + (counts.events.actualizados + counts.events.nuevos)) : fail('recuento eventos: act=' + counts.events.actualizados + ' nuevos=' + counts.events.nuevos);
Object.keys(mem.events).length === 2350 ? pass('total eventos en BD = 2350') : fail('total eventos = ' + Object.keys(mem.events).length);
counts.users.nuevos === 88 && counts.users.actualizados === 1980 ? pass('usuarios: 1980 actualizados + 88 nuevos') : fail('usuarios: act=' + counts.users.actualizados + ' nuevos=' + counts.users.nuevos);
Object.keys(memUsers).length === 2069 ? pass('total usuarios = 2069 (2068 intranet + 1 solo-seed conservado)') : fail('total usuarios = ' + Object.keys(memUsers).length);

console.log('\n' + (ok ? '✅ TODAS LAS COMPROBACIONES OK' : '❌ HAY FALLOS'));
process.exit(ok ? 0 : 1);
