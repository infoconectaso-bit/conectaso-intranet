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
      // Conservar la SECCIÓN ya recolocada de cada momento (sec/area/order). El volcado trae todos
      // los opcionales como 'ceremony' (el nombre del campo no lleva la sección real), así que sin
      // esto un re-volcado vuelve a meterlos todos en ceremonia. Se empareja por id de momento;
      // los momentos nuevos (que no existían en la réplica) quedan en ceremony hasta la próxima
      // recolocación (resection-bg).
      if (prev && Array.isArray(prev.optionals) && Array.isArray(merged.optionals)) {
        const pb = {}; prev.optionals.forEach(o => { if (o && o.id != null) pb[o.id] = o; });
        merged.optionals.forEach(o => { const p = pb[o.id]; if (p && p.sec) { o.area = p.area; o.sec = p.sec; o.order = p.order; } });
      }
      if (prev) { counts.events.actualizados++; if (EVENT_OURS.some(k => prev[k] !== undefined)) counts.preservados.ourEventFields++; }
      else counts.events.nuevos++;
      store.put('events', merged);
    }

    // ---- USUARIOS (merge de user.data, conserva time_tracking y demás) ----
    // La intranet tiene usuarios que COMPARTEN email. El UNIQUE de users.email obliga a:
    //   Pasada 1: escribir cada usuario con un email TEMPORAL único (sin colisiones) + sus datos.
    //   Pasada 2: asignar el email final; los repetidos se renombran (local+uID@dominio).
    // Dos pasadas evitan choques transitorios del UNIQUE al reescribir filas existentes.
    const dataFor = u => { const d = {}; ['worker_type', 'color', 'vehicle_allowed', 'sending', 'prices', 'tyc', 'djFincas', 'djServices'].forEach(k => { if (u[k] !== undefined) d[k] = u[k]; }); return d; };
    // Usuarios eliminados a mano que NO deben re-crearse en el volcado (setting 'importExclude').
    const exclude = new Set(((store.setting && store.setting('importExclude')) || []).map(Number));
    counts.users.excluidos = 0;
    for (const u of seed.users) {
      if (exclude.has(u.id)) { counts.users.excluidos++; continue; }
      const row = users.getRow(u.id);
      const tmp = `volcado-tmp-${u.id}@conectaso.local`;
      if (row) {
        const cur = JSON.parse(row.data || '{}');
        if (cur.time_tracking !== undefined) counts.preservados.time_tracking++;
        users.update(u.id, { email: tmp, name: u.name || row.name, role: u.role || row.role, data: dataFor(u) });
        counts.users.actualizados++;
      } else {
        users.create({ id: u.id, email: tmp, name: u.name || '', role: u.role || 'user', active: true, data: dataFor(u) }, null);
        counts.users.nuevos++;
      }
    }
    // Pasada 2: email final deduplicado. Reservamos primero los emails de usuarios existentes que
    // NO están en el volcado (p. ej. el admin de desarrollo) para no chocar con ellos.
    const volcadoIds = new Set(seed.users.filter(u => !exclude.has(u.id)).map(u => u.id));
    const seen = new Map();
    if (typeof users.all === 'function') users.all().forEach(x => { if (!volcadoIds.has(x.id) && x.email) seen.set(String(x.email).toLowerCase(), x.id); });
    counts.emailDuplicados = 0;
    for (const u of seed.users) {
      if (exclude.has(u.id)) continue;
      let email = (u.mail || '').trim() || `sin-email-${u.id}@conectaso.local`;
      const key = email.toLowerCase();
      let extra = null;
      if (seen.has(key)) {
        const at = email.indexOf('@');
        email = at > 0 ? `${email.slice(0, at)}+u${u.id}${email.slice(at)}` : `dup-${u.id}@conectaso.local`;
        extra = { emailOriginal: (u.mail || '').trim(), emailDuplicado: true };
        counts.emailDuplicados++;
      } else seen.set(key, u.id);
      users.update(u.id, extra ? { email, data: extra } : { email });
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
    // OJO: NO se reescribe la lista de estados si ya existe. Antes se ponía la de 5 estados (con
    // "No contactado admin") y al reiniciar la migración volvía a bajar un índice TODOS los eventos
    // (Completado acababa como "Meeting realizado"). La réplica usa 4 estados.
    if (!store.setting('estados')) store.setSetting('estados', [
      { n: 'No contactado dj', c: '#8E24AA' }, { n: 'Contactado', c: '#F6BF26' }, { n: 'Meeting realizado', c: '#FF7800' }, { n: 'Completado', c: '#0B8043' }]);
    if (!store.setting('tipos')) store.setSetting('tipos', ['Recomendado', 'Fiesta', 'Bodorrio', 'Tinglado', 'Corporativo', 'Extras']);
    if (store.setting('staffIds') == null && seed.staffIds) store.setSetting('staffIds', seed.staffIds);
    if (store.setting('beneficios') == null && seed.beneficios) store.setSetting('beneficios', seed.beneficios);
    store.setSetting('volcadoAt', new Date().toISOString());
  });

  return counts;
}

module.exports = { run, mergeRecord, EVENT_OURS };
