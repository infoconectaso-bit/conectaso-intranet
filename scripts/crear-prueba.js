'use strict';
/**
 * Crea (o actualiza) un EVENTO DE PRUEBA y un USUARIO CLIENTE de prueba.
 * Uso:  node scripts/crear-prueba.js
 * Es idempotente: se puede ejecutar varias veces sin duplicar.
 *
 * Evento: hoy a las 19:00 en Castell de Tous, DJ Juanma, servicios de fotomatón
 * (Marc + Sara Beltrán) y humo bajo (Marc). Cliente con contrato TyC ya firmado
 * (datos falsos). Pensado para pruebas; se puede borrar luego desde la intranet.
 */
const { store, users } = require('../server/db');
const auth = require('../server/auth');
const { bizToday } = require('../server/time');

const EVENT_ID = 9001;
const EMAIL = 'prueba.novios@conectaso-demo.es';
const PASSWORD = 'Prueba2026';

// --- IDs reales en la base de datos ---
const DJ_JUANMA = 229;      // Juanma DJ
const W_MARC = 234;         // Mark Polo (técnico "Marc")
const W_SARA = 287;         // Sara Beltran
const FINCA_TOUS = 9;       // Castell de tous
const SVC_FOTOMATON = 9;    // Fotomatón
const SVC_HUMO_BAJO = 15;   // Humo Bajo

const hoy = bizToday();

// 1) Usuario cliente de prueba (con contrato ya firmado, datos falsos)
let cli = users.byEmail(EMAIL) ? users.get(users.byEmail(EMAIL).id) : null;
const tacs = store.all('tacs');
const version = String((tacs[tacs.length - 1] || {}).date || (tacs[tacs.length - 1] || {}).version || '2027');
const tycSign = { version, name: 'Laia Soler Puig', dni: '12345678Z', dni2: '87654321X', date: new Date().toISOString() };
if (!cli) {
  cli = users.create({ email: EMAIL, name: 'Laia y Pau (PRUEBA)', role: 'user', active: true, data: { tycSign } }, auth.hashPassword(PASSWORD));
} else {
  users.update(cli.id, { name: 'Laia y Pau (PRUEBA)', role: 'user', active: true, data: { tycSign } });
  users.setPassword(cli.id, auth.hashPassword(PASSWORD));
}

// 2) Evento de prueba
const ev = {
  id: EVENT_ID,
  tipo: 'Recomendado',
  conyuges: 'Laia Soler y Pau Martí (PRUEBA)',
  fecha: hoy,
  hora: '19:00',
  lugar: FINCA_TOUS,
  lugarOtro: '',
  ceremoniaFuera: false,
  estado: 0,
  metodo: '',
  pagoRestaurante: 0,
  pagoCliente: 0,
  pagado: 0,
  userId: cli.id,
  editUser: true,      // edición del cliente habilitada (es de hoy, si no estaría cerrada)
  editUnlock: true,
  djId: DJ_JUANMA,
  spouses: [
    { name: 'Laia Soler Puig', dni: '12345678Z', phone: '600111222' },
    { name: 'Pau Martí Roca', dni: '87654321X', phone: '600333444' },
  ],
  services: [
    { servicio: SVC_FOTOMATON, resp: W_MARC, resp2: W_SARA, horas: '' },  // fotomatón: Marc + Sara
    { servicio: SVC_HUMO_BAJO, resp: W_MARC, resp2: '', horas: '' },       // humo bajo: Marc
  ],
  music: {},
  extras: {},
  obsPriv: 'EVENTO DE PRUEBA — se puede borrar. Creado para test de facturación, servicios con dos personas y contrato.',
};
store.put('events', ev);

console.log('✓ Evento de prueba creado/actualizado: #' + EVENT_ID + ' (' + ev.conyuges + ') · ' + hoy + ' 19:00 · Castell de Tous');
console.log('✓ Cliente de prueba (contrato ya firmado):');
console.log('    Email:      ' + EMAIL);
console.log('    Contraseña: ' + PASSWORD);
console.log('  DJ: Juanma · Fotomatón: Marc + Sara Beltrán · Humo bajo: Marc');
console.log('  La facturación mostrará PENDIENTE hasta las 19:00 y luego generará los cobros.');
