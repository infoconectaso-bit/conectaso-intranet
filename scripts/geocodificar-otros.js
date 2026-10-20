'use strict';
/**
 * Geolocaliza las fincas "Otro" de los eventos PENDIENTES y calcula el tiempo/distancia
 * de desplazamiento desde Martorelles. Solo eventos pendientes (las realizadas se omiten).
 *
 * Uso (en el VPS):  docker compose exec gestor node scripts/geocodificar-otros.js
 *   - Añade  --force  para recalcular también las que ya tengan tiempo.
 *
 * Qué hace:
 *  - Busca cada dirección en OpenStreetMap (Nominatim), restringido a Catalunya/España.
 *  - Calcula la ruta en coche real (OSRM) desde Martorelles (base).
 *  - Guarda en el evento: otroLat, otroLng, otroTravelMin, otroTravelKm.
 *  - Las que NO resuelve con seguridad (sin resultado, ambiguas o claramente de prueba)
 *    las DEJA SIN TOCAR y las imprime al final para que las revises y envíes la dirección.
 *
 * Respeta el límite de Nominatim (1 petición/seg) y usa User-Agent propio.
 */
const { store } = require('../server/db');
const { evFinished } = require('../server/time');

const FORCE = process.argv.includes('--force');
const BASE = { lat: 41.5293, lng: 2.2440 }; // Martorelles (misma base que la intranet)
// Caja aproximada de Catalunya (lat/lng) para descartar resultados fuera de zona.
const CAT = { latMin: 40.5, latMax: 42.9, lngMin: 0.1, lngMax: 3.4 };
const UA = 'ConectaSo-Intranet/1.0 (geocodificacion interna de fincas)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Entradas que NO son una finca real (pruebas o descripciones vagas): se dejan para revisar.
const SKIP_RE = /(evento falso|se casan en|casa privada|cerca de|a concretar|por confirmar|pendiente)/i;

async function geocode(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=es&q=' + encodeURIComponent(q + ', Catalunya, España');
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ca,es' } });
  if (!r.ok) throw new Error('Nominatim ' + r.status);
  const j = await r.json();
  if (!j || !j.length) return null;
  const lat = parseFloat(j[0].lat), lng = parseFloat(j[0].lon);
  if (isNaN(lat) || isNaN(lng)) return null;
  if (lat < CAT.latMin || lat > CAT.latMax || lng < CAT.lngMin || lng > CAT.lngMax) return null; // fuera de Catalunya
  return { lat, lng, label: j[0].display_name };
}
async function route(to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${BASE.lng},${BASE.lat};${to.lng},${to.lat}?overview=false`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('OSRM ' + r.status);
  const j = await r.json();
  const rt = j.routes && j.routes[0];
  if (!rt) return null;
  return { min: Math.round(rt.duration / 60), km: Math.round(rt.distance / 100) / 10 };
}

(async () => {
  const pend = store.all('events').filter(e => !evFinished(e));
  const otros = pend.filter(e => (!e.lugar || e.lugar === 0) && e.lugarOtro && String(e.lugarOtro).trim());
  // agrupar por dirección para geolocalizar cada una una sola vez
  const byDir = {};
  otros.forEach(e => { const d = String(e.lugarOtro).trim(); (byDir[d] = byDir[d] || []).push(e); });
  const dirs = Object.keys(byDir);
  console.log('Eventos pendientes con lugar "Otro": ' + otros.length + ' · direcciones distintas: ' + dirs.length + (FORCE ? ' · (--force)' : ''));

  const ok = [], pendientes = [];
  for (const d of dirs) {
    const sample = byDir[d][0];
    if (!FORCE && sample.otroTravelKm) { continue; } // ya calculada
    if (SKIP_RE.test(d)) { pendientes.push(d + '  → parece prueba / dirección imprecisa'); continue; }
    try {
      await sleep(1100); // respetar límite de Nominatim
      const g = await geocode(d);
      if (!g) { pendientes.push(d + '  → sin resultado claro'); continue; }
      const rt = await route(g);
      if (!rt) { pendientes.push(d + '  → geolocalizada pero sin ruta'); continue; }
      byDir[d].forEach(e => { e.otroLat = g.lat; e.otroLng = g.lng; e.otroTravelMin = rt.min; e.otroTravelKm = rt.km; store.put('events', e); });
      ok.push(`${d}  → ${rt.min} min · ${rt.km} km   (${g.label.slice(0, 60)})`);
    } catch (err) { pendientes.push(d + '  → error: ' + err.message); }
  }

  console.log('\n=== RESUELTAS (' + ok.length + ') ===');
  ok.forEach(x => console.log('  ✓ ' + x));
  console.log('\n=== PARA REVISAR / ENVIAR DIRECCIÓN (' + pendientes.length + ') ===');
  pendientes.forEach(x => console.log('  ⚠ ' + x));
  console.log('\nRevisa las resueltas (el nombre entre paréntesis es dónde las ha situado). Si alguna está mal,');
  console.log('o para las de "revisar", envíame la dirección exacta y las corrijo.');
})();
