'use strict';
/**
 * Crea un DJ DE PRUEBA para verificar el flujo de VACACIONES.
 * Uso:  node scripts/crear-dj-vacaciones.js   (dentro del contenedor: docker compose exec gestor node scripts/crear-dj-vacaciones.js)
 * Es idempotente. Para borrarlo todo: node scripts/borrar-dj-vacaciones.js
 *
 * Crea:
 *  - Un DJ "DJ Prueba Vacaciones" (con login, puede conducir y tiene control horario).
 *  - Una SOLICITUD de vacaciones PENDIENTE (para que administración la vea y la acepte/deniegue).
 *  - Un EVENTO asignado a ese DJ DENTRO de esas vacaciones (para probar el aviso de conflicto en Inicio).
 */
const { store, users } = require('../server/db');
const auth = require('../server/auth');

const EMAIL = 'dj.prueba.vacaciones@conectaso-demo.es';
const PASSWORD = 'PruebaVac2026';
const EVENT_ID = 9002;
const FINCA_TOUS = 9;

const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const vacStart = d(3), vacEnd = d(9), evDate = d(5);

// 1) DJ de prueba
let dj = users.byEmail(EMAIL);
const data = { vehicle_allowed: true, time_tracking: true };
if (!dj) dj = users.create({ email: EMAIL, name: 'DJ Prueba Vacaciones', role: 'dj', active: true, data }, auth.hashPassword(PASSWORD));
else { users.update(dj.id, { name: 'DJ Prueba Vacaciones', role: 'dj', active: true, data }); users.setPassword(dj.id, auth.hashPassword(PASSWORD)); }
dj = users.get(dj.id);

// 2) Solicitud de vacaciones PENDIENTE (si no existe ya una suya)
const yaVac = store.all('vacations').find(v => v.userId == dj.id);
if (!yaVac) store.put('vacations', { userId: dj.id, start: vacStart, end: vacEnd, status: 'Solicitado' });

// 3) Evento asignado a ese DJ dentro de las vacaciones
store.put('events', {
  id: EVENT_ID, tipo: 'Recomendado', conyuges: 'Boda de prueba vacaciones', fecha: evDate, hora: '18:00',
  lugar: FINCA_TOUS, lugarOtro: '', ceremoniaFuera: false, estado: 0, metodo: '',
  pagoCliente: 0, pagado: 0, pagoRestaurante: 0, userId: null, djId: dj.id,
  services: [], music: {}, extras: {}, spouses: [],
  obsPriv: 'EVENTO DE PRUEBA para el aviso de conflicto de vacaciones. Se puede borrar.',
});

console.log('✓ DJ de prueba creado/actualizado:');
console.log('    Email:      ' + EMAIL);
console.log('    Contraseña: ' + PASSWORD);
console.log('✓ Solicitud de vacaciones PENDIENTE: ' + vacStart + ' → ' + vacEnd + ' (apruébala en Vacaciones).');
console.log('✓ Evento #' + EVENT_ID + ' asignado a ese DJ el ' + evDate + ' (dentro de las vacaciones).');
console.log('');
console.log('CÓMO PROBAR:');
console.log(' 1) Entra como admin → Vacaciones: verás la solicitud PENDIENTE. Pulsa Aprobar.');
console.log(' 2) Vuelve a Inicio: aparecerá el aviso de conflicto (DJ en vacaciones con evento asignado).');
console.log(' 3) (Opcional) Entra como el DJ de prueba con el email/contraseña de arriba para pedir otras vacaciones.');
console.log(' 4) Cuando acabes: node scripts/borrar-dj-vacaciones.js');
