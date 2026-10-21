'use strict';
/**
 * Importador con MERGE para el volcado.
 * Fusiona data/volcado-seed.json con la base de datos SIN perder nada de lo que añadimos
 * en la réplica y SIN borrar ningún registro.
 *
 * Principio: los campos que vienen de la intranet oficial son autoritativos (la intranet es la
 * fuente de verdad hasta el cambio final). Los campos que son NUESTROS (no existen en la intranet)
 * se conservan tal cual estaban:
 *   - eventos:  ceremoniaFuera, pagoRestaurante, labels, entregas, y cualquier clave extra nuestra
 *   - usuarios: time_tracking y cualquier otra clave de user.data que la intranet no trae
 *   - fincas:   lat, lng, travelMin, travelKm, files y cualquier clave extra nuestra
 *
 * Colecciones que NO se tocan (no están en el volcado-seed): attendances, vacations, payments,
 * usages, extraRequests, workers, historico, planos (colección aparte), maintenance.
 */

// Claves de evento que son NUESTRAS (la ficha de la intranet no las expone). Si ya existían en la
// réplica, ganan ellas; el volcado nunca las machaca con su valor por defecto.
const EVENT_OURS = ['ceremoniaFuera', 'pagoRestaurante', 'labels', 'entregas'];

function mergeRecord(existing, incoming, ours) {
  if (!existing) return incoming;
  const merged = Object.assign({}, incoming);
  // 1) campos nuestros: si existían, se conservan
  (ours || []).forEach(k => { if (existing[k] !== undefined) merged[k] = existing[k]; });
  // 2) cualquier otra clave que tuviera la réplica y el volcado no traiga, se conserva
  for (const k of Object.keys(existing)) if (!(k in merged)) merged[k] = existing[k];
  return merged;
}

/** Ejecuta el volcado con merge. db = { store, users, transaction }. Devuelve un informe. */
function run(seed, db) {
  const { store, users, transaction } = db;
  const counts = { events: { nuevos: 0, actualizados: 0 }, users: { nuevos: 0, actualizados: 0 }, locations: 0, vehicles: 0, extras: 0, tacs: 0, preservados: { time_tracking: 0, latlng: 0, ourEventFields: 0 } };

  transaction(() => {
    // ---- EVENTOS (merge) ----
    for (const ev of seed.events) {
      const prev = store.get('events', ev.id);
      const merged = mergeRecord(prev, ev, EVENT_OURS);
      if (prev) { counts.events.actualizados++; if (EVENT_OURS.some(k => prev[k] !== undefined)) counts.preservados.ourEventFields++; }
      else counts.events.nuevos++;
      store.put('events', merged);
    }

    // ---- USUARIOS (merge de user.data, conserva time_tracking y demás) ----
    for (const u of seed.users) {
      const row = users.getRow(u.id);
      const dataIncoming = {};
      ['worker_type', 'color', 'vehicle_allowed', 'sending', 'prices', 'tyc', 'djFincas', 'djServices'].forEach(k => { if (u[k] !== undefined) dataIncoming[k] = u[k]; });
      const email = (u.mail || '').trim() || `sin-email-${u.id}@conectaso.local`;
      if (row) {
        const cur = JSON.parse(row.data || '{}');
        if (cur.time_tracking !== undefined) counts.preservados.time_tracking++;
        // users.update hace Object.assign(cur, data): pasando solo dataIncoming se conserva el resto
        users.update(u.id, { email, name: u.name || row.name, role: u.role || row.role, data: dataIncoming });
        counts.users.actualizados++;
      } else {
        users.create({ id: u.id, email, name: u.name || '', role: u.role || 'user', active: true, data: dataIncoming }, null);
        counts.users.nuevos++;
      }
    }

    // ---- LOCALIZACIONES (merge: conserva lat/lng/tiempos/archivos) ----
    for (const loc of seed.locations) {
      const prev = store.get('locations', loc.id);
      if (prev && (prev.lat !== undefined || prev.lng !== undefined)) counts.preservados.latlng++;
      store.put('locations', mergeRecord(prev, loc));
      counts.locations++;
    }
    // ---- VEHÍCULOS / EXTRAS / TACS (merge simple) ----
    for (const v of seed.vehicles) { store.put('vehicles', mergeRecord(store.get('vehicles', v.id), v)); counts.vehicles++; }
    for (const e of seed.extras) { store.put('extras', mergeRecord(store.get('extras', e.id), e)); counts.extras++; }
    for (const t of seed.tacs) { store.put('tacs', mergeRecord(store.get('tacs', t.id), t)); counts.tacs++; }

    // ---- Ajustes (catálogos). No pisar staffIds/beneficios si ya existen. ----
    store.setSetting('estados', [
      { n: 'No contactado admin', c: '#D50000' }, { n: 'No contactado dj', c: '#8E24AA' },
      { n: 'Contactado', c: '#F6BF26' }, { n: 'Meeting realizado', c: '#FF7800' }, { n: 'Completado', c: '#0B8043' }]);
    store.setSetting('tipos', ['Recomendado', 'Fiesta', 'Bodorrio', 'Tinglado', 'Corporativo', 'Extras']);
    if (store.setting('staffIds') == null && seed.staffIds) store.setSetting('staffIds', seed.staffIds);
    if (store.setting('beneficios') == null && seed.beneficios) store.setSetting('beneficios', seed.beneficios);
    store.setSetting('volcadoAt', new Date().toISOString());
  });

  return counts;
}

module.exports = { run, mergeRecord, EVENT_OURS };
