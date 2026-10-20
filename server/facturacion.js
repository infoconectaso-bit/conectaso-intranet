'use strict';
/**
 * Motor de facturación / costes de personal de Conecta So (portado de la demo).
 * Calcula, para cada evento ya realizado:
 *   - factRows  : coste del personal (base DJ + hora extra + servicios + plus + Josep por horas)
 *   - revRows   : ingresos (pago finca + pago cliente) y BENEFICIO
 * Reglas de Conecta So:
 *   - Adrià (227) y Sergi Corcoy (276): nunca base (solo hora extra / servicios).
 *   - Mark Polo (234): base solo en DOMINGO.
 *   - Josep ayudante (1251): cobra 10 €/h según las horas que él indique.
 *   - Servicios sin tarifa configurada para ese trabajador = 0 €.
 * Depende de las tarifas por DJ/finca (setting 'djRates') y del histórico (colección 'history').
 */
const { store, users } = require('./db');
const { evRealized, bizToday } = require('./time');

const money = n => (Math.round((+n || 0) * 100) / 100).toFixed(2) + ' €';
const OVERTIME = { 'Media Hora': 0.5, '1 Hora': 1, '1 hora y media': 1.5, '2 Horas': 2, '2 hora y media': 2.5, '3 Horas': 3, '3 hora y media': 3.5, '4 Horas': 4 };
const FIX_STAFF_NO_BASE = { '227': true, '276': true };
const SUNDAY_ONLY_BASE = { '234': true };
const HOURLY_RATE = { '1251': 10 };

function isSunday(fecha) { const p = String(fecha || '').slice(0, 10).split('-'); if (p.length < 3) return false; const d = new Date(+p[0], +p[1] - 1, +p[2]); return !isNaN(d) && d.getDay() === 0; }
function evStartTime(ev) { const h = /^(\d{1,2}):(\d{2})/.exec(ev.hora || ''); const hhmm = h ? (('0' + h[1]).slice(-2) + ':' + h[2]) : '00:00'; return new Date((ev.fecha || '1970-01-01') + 'T' + hhmm + ':00'); }

// --- búsquedas (cacheadas por llamada de alto nivel) ---
let _loc = null, _ext = null, _usr = null, _rates = null;
function refresh() {
  _loc = {}; store.all('locations').forEach(l => { _loc[l.id] = l; });
  _ext = {}; store.all('extras').forEach(e => { _ext[e.id] = e.name; });
  _usr = {}; users.all().forEach(u => { _usr[u.id] = u.name; });
  _rates = store.setting('djRates') || {};
}
const locById = id => (_loc && _loc[id]) || null;
const extraName = id => (_ext && _ext[id]) || ('Servicio ' + id);
const userName = id => (_usr && _usr[id]) || ('#' + id);
const djRate = djId => _rates[String(djId)] || null;

function packKey(tipo, suf) { const m = { Fiesta: 'fiesta', Bodorrio: 'bodorrio', Tinglado: 'tinglado' }; const k = m[tipo]; return k ? (k + (suf || '')) : null; }
function workerBase(ev) {
  const dj = String(ev.djId);
  if (dj === '227') return 0;
  if (FIX_STAFF_NO_BASE[dj]) return 0;
  const r = djRate(dj); if (!r) return 0;
  const fr = r.fincas && r.fincas[ev.lugar];
  let base = (fr && fr.boda != null) ? fr.boda : null;
  if (base == null) { const pk = packKey(ev.tipo); base = (pk && r.packs && r.packs[pk] != null) ? r.packs[pk] : 0; }
  if (SUNDAY_ONLY_BASE[dj] && !isSunday(ev.fecha)) return 0;
  return base || 0;
}
function workerOvertime(ev) {
  const oh = OVERTIME[ev.djOvertime] || 0; if (!oh) return 0;
  const dj = String(ev.djId); if (dj === '227') return 0;
  const r = djRate(dj); let he = null;
  if (r) { const fr = r.fincas && r.fincas[ev.lugar]; if (fr && fr.he != null) he = fr.he; else { const pk = packKey(ev.tipo, '_he'); if (r.packs && r.packs[pk] != null) he = r.packs[pk]; } }
  if (he == null) { const loc = locById(ev.lugar); if (loc && loc.extraPrice != null && loc.extraPrice !== '') he = parseFloat(loc.extraPrice) || 0; }
  return oh * (he || 0);
}
function workerPlus(ev, wid) { return (ev.plus || []).filter(p => String(p.userId) === String(wid)).reduce((t, p) => t + (parseFloat(p.amount) || 0), 0); }
function assignedWorkers(ev) {
  const ids = []; if (ev.djId) ids.push(String(ev.djId));
  (ev.services || []).forEach(s => { [s.resp, s.resp2].forEach(rr => { if (rr && ids.indexOf(String(rr)) < 0) ids.push(String(rr)); }); });
  return ids;
}
function workerServices(ev, wid) { return (ev.services || []).filter(s => String(s.resp) === String(wid) || String(s.resp2) === String(wid)); }
function workerEarning(ev, wid) {
  const isDj = String(ev.djId) === String(wid);
  const loc = locById(ev.lugar) || {};
  let sub = 0; const lines = [];
  if (HOURLY_RATE[String(wid)] != null) {
    const rate = HOURLY_RATE[String(wid)];
    const hrs = (ev.helperHours && ev.helperHours[String(wid)] != null) ? parseFloat(ev.helperHours[String(wid)]) : null;
    if (hrs != null && !isNaN(hrs)) { const amt = rate * hrs; lines.push([hrs + ' h × ' + money(rate) + '/h', money(amt)]); sub += amt; }
    else { lines.push(['Horas pendientes de indicar por el trabajador', money(0)]); }
    const plusH = workerPlus(ev, wid); if (plusH) { lines.push(['Plus', money(plusH)]); sub += plusH; }
    return { isDj, amount: sub, lines, hourly: true, hoursSet: (hrs != null && !isNaN(hrs)) };
  }
  if (isDj) {
    const base = workerBase(ev); lines.push(['Base' + (loc.name ? (' · ' + loc.name) : ''), money(base)]); sub += base;
    const ot = workerOvertime(ev); if (ot) { lines.push([(ev.djOvertime || '') + ' h extra', money(ot)]); sub += ot; }
  }
  workerServices(ev, wid).forEach(s => {
    const rr = djRate(wid); const price = (rr && rr.services && rr.services[s.servicio] != null) ? rr.services[s.servicio] : 0;
    lines.push([extraName(s.servicio), money(price)]); sub += price;
  });
  const plus = workerPlus(ev, wid); if (plus) { lines.push(['Plus', money(plus)]); sub += plus; }
  return { isDj, amount: sub, lines };
}
function computeFact(ev) {
  refresh();
  if (!evRealized(ev)) return [['PENDIENTE', 'La facturación del equipo se genera cuando llega la hora de la boda (' + (ev.hora || '') + ').', 'note']];
  const rows = [['Usuario', 'Costes', 'h']];
  let grand = 0;
  const ws = assignedWorkers(ev);
  ws.forEach(wid => {
    const name = userName(wid);
    const e = workerEarning(ev, wid);
    rows.push([name + (e.isDj ? ' (DJ asignado)' : ' (servicios)'), money(e.amount)]);
    e.lines.forEach(l => rows.push(l));
    grand += e.amount;
  });
  if (ws.length === 0) rows.push(['Sin personal asignado', '—']);
  rows.push(['Coste total Final', money(grand), 't']);
  return rows;
}
function factTotal(ev) { let t = 0; assignedWorkers(ev).forEach(wid => { t += workerEarning(ev, wid).amount; }); return t; }
function computeRevenue(ev) {
  refresh();
  const loc = locById(ev.lugar) || {};
  const isMasia = !!(ev.lugar && loc.id);
  const rows = []; let fincaTot = 0, cliTot = 0;
  rows.push(['PAGO FINCA', '', 'h']);
  if (isMasia) {
    const wp = parseFloat(loc.weddingPrice) || 0, cpr = parseFloat(loc.ceremonyPrice) || 0, xp = parseFloat(loc.extraPrice) || 0, oh = OVERTIME[ev.djOvertime] || 0;
    if (wp) { rows.push(['Caché de la finca', money(wp)]); fincaTot += wp; }
    if (!ev.ceremoniaFuera && cpr > 0) { rows.push(['Ceremonia en la finca', money(cpr)]); fincaTot += cpr; }
    if (oh > 0) { const he = oh * xp; rows.push([oh + ' h extra (finca)', money(he)]); fincaTot += he; }
    if (!fincaTot) rows.push(['Finca sin importes configurados', '—']);
  } else { rows.push(['Cliente externo · la finca no nos paga', '—']); }
  rows.push(['Subtotal finca', money(fincaTot), 's']);
  rows.push(['PAGO CLIENTE', '', 'h']);
  if (!isMasia) { rows.push(['Pack ' + (ev.tipo || '') + ' (cliente externo)', 'precio a indicar']); }
  (ev.services || []).forEach(s => {
    if (s.servicio == 42) return; const p = parseFloat(s.precio), nm = extraName(s.servicio);
    if (isNaN(p)) { rows.push([nm, 'precio a indicar']); } else { rows.push([nm, money(p)]); cliTot += p; }
  });
  const cliPlus = (ev.plus || []).filter(p => !p.userId).reduce((t, p) => t + (parseFloat(p.amount) || 0), 0);
  if (cliPlus) { rows.push(['Plus cliente', money(cliPlus)]); cliTot += cliPlus; }
  if (cliTot === 0 && isMasia) rows.push(['Sin extras contratados', '—']);
  rows.push(['Subtotal cliente', money(cliTot), 's']);
  const ingresos = fincaTot + cliTot, coste = factTotal(ev);
  rows.push(['Ingresos (finca + cliente)', money(ingresos), 't']);
  rows.push(['Coste de personal', '− ' + money(coste)]);
  rows.push(['BENEFICIO', money(ingresos - coste), 't']);
  return rows;
}
/** Rellena ev.factRows y ev.revRows (solo para vista de admin). No persiste. */
function withFacturacion(ev) {
  try { ev.factRows = computeFact(ev); ev.revRows = computeRevenue(ev); } catch (e) { /* no romper la ficha */ }
  return ev;
}
/** Facturación agregada por trabajador: histórico + eventos realizados de hoy en adelante. */
function aggregateFor(uid) {
  refresh();
  const TODAY = bizToday();
  const histById = {}; store.all('history').forEach(h => { histById[h.id] = h; });
  const snap = histById[uid] || { cobrar: 0, cobrado: 0, rest: 0, items: [] };
  const extraItems = []; let extra = 0;
  store.all('events').forEach(ev => {
    if (!(ev.fecha && ev.fecha >= TODAY)) return;
    if (!evRealized(ev)) return;
    if (assignedWorkers(ev).indexOf(String(uid)) < 0) return;
    const e = workerEarning(ev, uid);
    extraItems.push({ type: 'ev', evId: ev.id, title: 'Evento ' + ev.id + ' · ' + (ev.tipo || ''), date: ev.fecha, amount: e.amount,
      body: ['Fecha del evento: ' + (ev.fecha || '')].concat(e.lines.map(l => l[0] + ': ' + l[1])) });
    extra += e.amount;
  });
  if (!extraItems.length) return snap;
  return { cobrar: (snap.cobrar || 0) + extra, cobrado: (snap.cobrado || 0), rest: (snap.rest || 0) + extra, items: extraItems.concat(snap.items || []) };
}

module.exports = { computeFact, computeRevenue, factTotal, workerEarning, assignedWorkers, withFacturacion, aggregateFor, HOURLY_RATE, OVERTIME };
