'use strict';
/**
 * Borra el DJ DE PRUEBA de vacaciones y todo lo que creó (solicitud + evento).
 * Uso:  node scripts/borrar-dj-vacaciones.js
 */
const { store, users } = require('../server/db');

const EMAIL = 'dj.prueba.vacaciones@conectaso-demo.es';
const EVENT_ID = 9002;

const dj = users.byEmail(EMAIL);
let n = 0;
if (dj) {
  store.all('vacations').filter(v => v.userId == dj.id).forEach(v => { store.del('vacations', v.id); n++; });
  users.del(dj.id);
}
if (store.get('events', EVENT_ID)) store.del('events', EVENT_ID);
if (store.get('events_trash', EVENT_ID)) store.del('events_trash', EVENT_ID);

console.log('✓ DJ de prueba de vacaciones ' + (dj ? 'eliminado' : 'no existía') + '. Vacaciones borradas: ' + n + '. Evento #' + EVENT_ID + ' eliminado.');
