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
const fs = require('fs');
const path = require('path');
const { store, users } = require('./db');
const { evRealized, bizToday } = require('./time');

// --- Fecha de corte del volcado ---------------------------------------------
// El histórico congelado ('history') cubre TODO lo anterior al volcado. Los eventos
// creados en la intranet nueva (fecha posterior al corte) deben contar SIEMPRE en la
// facturación, aunque su día ya haya pasado; antes se usaba "hoy" como frontera y por eso
// un evento desaparecía al pasar su fecha. El corte es FIJO (la fecha del volcado), así no
// se duplica con el histórico ni se pierde nada. Se cachea en un setting tras calcularlo.
let _cutoff = null;
function volcadoCutoff() {
  if (_cutoff) return _cutoff;
  let c = null;
  try { c = store.setting('volcadoCutoff'); } catch (e) {}
  if (!c) {
    // 1) fecha de construcción del volcado (data/volcado-seed.json → "today"), si está
    try {
      const p = path.join(__dirname, '..', 'data', 'volcado-seed.json');
      if (fs.existsSync(p)) { const seed = JSON.parse(fs.readFileSync(p, 'utf8')); if (seed && seed.today) c = String(seed.today).slice(0, 10); }
    } catch (e) {}
    // 2) si no, la última fecha que aparece en el histórico congelado
    if (!c) { let mx = ''; try { store.all('history').forEach(h => (h.items || []).forEach(i => { if (i && i.date && i.date > mx) mx = i.date; })); } catch (e) {} c = mx || '2000-01-01'; }
    try { store.setSetting('volcadoCutoff', c); } catch (e) {}
  }
  _cutoff = c;
  return c;
}

// "Arranque limpio" de facturación: ignora el saldo del histórico congelado (que traía
// pendientes antiguos ya pagados por fuera) y cuenta SOLO desde el corte del volcado en
// adelante (bodas nuevas, ajustes y pagos con fecha >= corte). Así administración revisa
// partiendo de cero hasta el volcado general. Reversible: poner el setting a false.
function freshStart() { const v = store.setting('facturacionFreshStart'); return v == null ? true : !!v; }

const money = n => (Math.round((+n || 0) * 100) / 100).toFixed(2) + ' €';
const OVERTIME = { 'Media Hora': 0.5, '1 Hora': 1, '1 hora y media': 1.5, '2 Horas': 2, '2 hora y media': 2.5, '3 Horas': 3, '3 hora y media': 3.5, '4 Horas': 4, '4 hora y media': 4.5, '5 Horas': 5 };
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
  if (ev.ratesFrozen && ev.ratesFrozen.base != null) return ev.ratesFrozen.base || 0;   // tarifa congelada
  const r = djRate(dj); if (!r) return 0;
  const fr = r.fincas && r.fincas[ev.lugar];
  let base = (fr && fr.boda != null) ? fr.boda : null;
  if (base == null) { const pk = packKey(ev.tipo); base = (pk && r.packs && r.packs[pk] != null) ? r.packs[pk] : 0; }
  if (SUNDAY_ONLY_BASE[dj] && !isSunday(ev.fecha)) return 0;
  return base || 0;
}
function workerOvertime(ev) {
  const oh = OVERTIME[ev.djOvertime] || 0; if (!oh) return 0;   // CANTIDAD de horas: siempre viva (parte tardío)
  const dj = String(ev.djId); if (dj === '227') return 0;
  if (ev.ratesFrozen && ev.ratesFrozen.he != null) return oh * (ev.ratesFrozen.he || 0);   // tarifa/hora congelada
  const r = djRate(dj); let he = null;
  if (r) { const fr = r.fincas && r.fincas[ev.lugar]; if (fr && fr.he != null) he = fr.he; else { const pk = packKey(ev.tipo, '_he'); if (r.packs && r.packs[pk] != null) he = r.packs[pk]; } }
  if (he == null) { const loc = locById(ev.lugar); if (loc && loc.extraPrice != null && loc.extraPrice !== '') he = parseFloat(loc.extraPrice) || 0; }
  return oh * (he || 0);
}
// ¿Se realizó la ceremonia? Se intuye si hay MÚSICA de ceremonia rellenada; y si el DJ lo marca en
// el parte es una confirmación añadida. El coste se suma UNA sola vez (nunca se duplica).
function ceremonyHasMusic(ev) {
  const m = ev.music || {};
  return Object.keys(m).some(k => /^ceremony_/.test(k) && m[k] && (m[k].song || m[k].link));
}
function workerCeremony(ev) {
  const dj = String(ev.djId); if (dj === '227') return 0;
  const performed = ev.djCeremony === true || (ev.djCeremony !== false && ceremonyHasMusic(ev));
  if (!performed) return 0;   // "realizada" sigue vivo (música o marca del DJ)
  if (ev.ratesFrozen && ev.ratesFrozen.ceremonia != null) return ev.ratesFrozen.ceremonia || 0;   // tarifa congelada
  const r = djRate(dj); if (!r) return 0;
  const fr = r.fincas && r.fincas[ev.lugar];
  const c = (fr && fr.ceremonia != null) ? parseFloat(fr.ceremonia) : 0;
  return isNaN(c) ? 0 : c;   // se devuelve una sola vez, aunque se cumplan ambas condiciones
}
// Congela las TARIFAS (no los importes) de un evento con las tarifas ACTUALES: base, hora extra
// (por hora), ceremonia, precios de la finca y precios de servicios de los asignados. Las CANTIDADES
// (horas extra, ceremonia realizada, servicios, pluses, pagos) siguen vivas. Cambiar luego una tarifa
// o un precio de masía NO afecta a los eventos ya congelados (no es retroactivo).
function freezeRates(ev) {
  const dj = String(ev.djId);
  const r = djRate(dj) || {};
  const fr = (r.fincas && r.fincas[ev.lugar]) || {};
  let base = (fr.boda != null) ? fr.boda : null;
  if (base == null) { const pk = packKey(ev.tipo); base = (pk && r.packs && r.packs[pk] != null) ? r.packs[pk] : 0; }
  if (dj === '227' || FIX_STAFF_NO_BASE[dj]) base = 0;
  if (SUNDAY_ONLY_BASE[dj] && !isSunday(ev.fecha)) base = 0;
  let he = (fr.he != null) ? fr.he : null;
  if (he == null) { const pk = packKey(ev.tipo, '_he'); if (r.packs && r.packs[pk] != null) he = r.packs[pk]; }
  if (he == null) { const loc = locById(ev.lugar); if (loc && loc.extraPrice != null && loc.extraPrice !== '') he = parseFloat(loc.extraPrice) || 0; }
  if (dj === '227') he = 0;
  let ceremonia = (fr.ceremonia != null) ? (parseFloat(fr.ceremonia) || 0) : 0; if (isNaN(ceremonia)) ceremonia = 0;
  const loc = locById(ev.lugar) || {};
  const finca = { wp: parseFloat(loc.weddingPrice) || 0, cpr: parseFloat(loc.ceremonyPrice) || 0, xp: parseFloat(loc.extraPrice) || 0 };
  const services = {};
  (ev.services || []).forEach(s => { [s.resp, s.resp2].forEach(wid => { if (!wid) return; const rr = djRate(wid); if (rr && rr.services && rr.services[s.servicio] != null) services[wid + ':' + s.servicio] = rr.services[s.servicio]; }); });
  return { base: base || 0, he: he || 0, ceremonia: ceremonia || 0, finca, services, at: bizToday() };
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
    const cer = workerCeremony(ev); if (cer) { lines.push(['Ceremonia', money(cer)]); sub += cer; }
  }
  workerServices(ev, wid).forEach(s => {
    const fzs = ev.ratesFrozen && ev.ratesFrozen.services;
    let price = (fzs && fzs[wid + ':' + s.servicio] != null) ? fzs[wid + ':' + s.servicio] : null;   // tarifa congelada
    if (price == null) { const rr = djRate(wid); price = (rr && rr.services && rr.services[s.servicio] != null) ? rr.services[s.servicio] : 0; }
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
    rows.push([name + (e.isDj ? ' (DJ asignado)' : ' (servicios)'), money(e.amount), 'w']);
    e.lines.forEach(l => rows.push([l[0], l[1], 'sub']));
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
  // PAGO FINCA = lo que paga el restaurante. Dos fuentes, que se suman:
  //  1) tarifas configuradas de la masía (caché + ceremonia + hora extra),
  //  2) importe manual que administración apunte en la ficha (ev.pagoRestaurante),
  //     útil para fincas sin tarifas configuradas o pagos puntuales.
  const pagoRest = parseFloat(ev.pagoRestaurante) || 0;
  rows.push(['PAGO FINCA', '', 'h']);
  if (isMasia) {
    const fz = ev.ratesFrozen && ev.ratesFrozen.finca;
    const wp = fz ? (fz.wp || 0) : (parseFloat(loc.weddingPrice) || 0), cpr = fz ? (fz.cpr || 0) : (parseFloat(loc.ceremonyPrice) || 0), xp = fz ? (fz.xp || 0) : (parseFloat(loc.extraPrice) || 0), oh = OVERTIME[ev.djOvertime] || 0;
    if (wp) { rows.push(['Caché de la finca', money(wp)]); fincaTot += wp; }
    if (!ev.ceremoniaFuera && cpr > 0) { rows.push(['Ceremonia en la finca', money(cpr)]); fincaTot += cpr; }
    if (oh > 0 && xp > 0) { const he = oh * xp; rows.push([oh + ' h extra (finca)', money(he)]); fincaTot += he; }
  }
  if (pagoRest) { rows.push(['Pago finca (manual)', money(pagoRest)]); fincaTot += pagoRest; }
  if (!fincaTot) rows.push([isMasia ? 'La finca no paga en este evento' : 'Cliente externo · la finca no nos paga', '—']);
  rows.push(['Subtotal finca', money(fincaTot), 's']);
  // PAGO CLIENTE = lo que pagan los novios. Fuente principal: ev.pagoCliente (importe pactado
  // con la pareja). Se suman además los servicios extra con precio y los "plus cliente".
  const pagoNovios = parseFloat(ev.pagoCliente) || 0;   // ojo: "1" es el marcador antiguo de "sin importe", no un pago real
  rows.push(['PAGO CLIENTE', '', 'h']);
  if (pagoNovios > 1) { rows.push(['Pago novios', money(pagoNovios)]); cliTot += pagoNovios; }
  (ev.services || []).forEach(s => {
    if (s.servicio == 42) return; const p = parseFloat(s.precio), nm = extraName(s.servicio);
    if (isNaN(p)) { rows.push([nm, 'precio a indicar']); } else { rows.push([nm, money(p)]); cliTot += p; }
  });
  const cliPlus = (ev.plus || []).filter(p => !p.userId).reduce((t, p) => t + (parseFloat(p.amount) || 0), 0);
  if (cliPlus) { rows.push(['Plus cliente', money(cliPlus)]); cliTot += cliPlus; }
  if (cliTot === 0) rows.push(['Los novios no pagan en este evento', '—']);
  rows.push(['Subtotal cliente', money(cliTot), 's']);
  const ingresos = fincaTot + cliTot, coste = factTotal(ev);
  rows.push(['Ingresos (finca + cliente)', money(ingresos), 't']);
  rows.push(['Coste de personal', '− ' + money(coste)]);
  rows.push(['BENEFICIO', money(ingresos - coste), 't']);
  return rows;
}
/** Precarga las cachés (locations, extras, users, tarifas) una sola vez. Útil para
 * bucles grandes (p. ej. beneficios) que llaman a eventTotals muchas veces. */
function prime() { refresh(); }
/** Totales numéricos de un evento: facturado (ingresos), coste de personal y beneficio.
 * Pasa skipRefresh=true cuando ya has llamado a prime() en un bucle. */
function eventTotals(ev, skipRefresh) {
  if (!skipRefresh) refresh();
  const loc = locById(ev.lugar) || {};
  const isMasia = !!(ev.lugar && loc.id);
  let fincaTot = 0, cliTot = 0;
  if (isMasia) {
    const fz = ev.ratesFrozen && ev.ratesFrozen.finca;
    const wp = fz ? (fz.wp || 0) : (parseFloat(loc.weddingPrice) || 0), cpr = fz ? (fz.cpr || 0) : (parseFloat(loc.ceremonyPrice) || 0), xp = fz ? (fz.xp || 0) : (parseFloat(loc.extraPrice) || 0), oh = OVERTIME[ev.djOvertime] || 0;
    fincaTot += wp;
    if (!ev.ceremoniaFuera && cpr > 0) fincaTot += cpr;
    if (oh > 0) fincaTot += oh * xp;
  }
  fincaTot += parseFloat(ev.pagoRestaurante) || 0;         // pago finca manual
  { const pn = parseFloat(ev.pagoCliente) || 0; if (pn > 1) cliTot += pn; }   // novios ("1" = marcador de sin importe)
  (ev.services || []).forEach(s => { if (s.servicio == 42) return; const p = parseFloat(s.precio); if (!isNaN(p)) cliTot += p; });
  const cliPlus = (ev.plus || []).filter(p => !p.userId).reduce((t, p) => t + (parseFloat(p.amount) || 0), 0);
  cliTot += cliPlus;
  const ingresos = fincaTot + cliTot, coste = factTotal(ev);
  return { ingresos, coste, beneficio: ingresos - coste };
}
/** Saldo pendiente de TODOS los trabajadores en UNA sola pasada (para la lista de facturación equipo).
 * Devuelve { id: { rest, last } }. Mucho más rápido que llamar aggregateFor por cada trabajador. */
function allBalances() {
  refresh();
  const CUT = volcadoCutoff();
  const FS = freshStart();
  const out = {};
  const saldados = new Set((store.setting('factSaldados') || []).map(String));   // bodas marcadas como pagadas por trabajador ("evId:uid")
  const get = id => out[id] || (out[id] = { rest: 0, last: '' });
  if (!FS) store.all('history').forEach(h => { const b = get(h.id); b.rest += (h.rest || 0); (h.items || []).forEach(i => { if (i.date && i.date > b.last) b.last = i.date; }); });
  store.all('events').forEach(ev => {
    if (!(ev.fecha && ev.fecha >= CUT) || !evRealized(ev)) return;
    assignedWorkers(ev).forEach(wid => { if (saldados.has(ev.id + ':' + wid)) return; const b = get(wid); b.rest += workerEarning(ev, wid).amount; if (ev.fecha > b.last) b.last = ev.fecha; });
  });
  store.all('adjustments').forEach(a => { if (FS) return; const b = get(a.userId); b.rest += (parseFloat(a.amount) || 0); if (a.date && a.date > b.last) b.last = a.date; });
  return out;
}
/** Rellena ev.factRows y ev.revRows (solo para vista de admin). No persiste. */
function withFacturacion(ev) {
  try { ev.factRows = computeFact(ev); ev.revRows = computeRevenue(ev); } catch (e) { /* no romper la ficha */ }
  return ev;
}
/** Facturación agregada por trabajador: histórico + eventos realizados de hoy en adelante.
 * skipRefresh=true cuando ya se llamó a prime() en un bucle grande (p. ej. facturación equipo). */
function aggregateFor(uid, skipRefresh) {
  if (!skipRefresh) refresh();
  const CUT = volcadoCutoff();
  const FS = freshStart();
  const histById = {}; if (!FS) store.all('history').forEach(h => { histById[h.id] = h; });
  const snap = (FS ? null : histById[uid]) || { cobrar: 0, cobrado: 0, rest: 0, items: [] };
  const saldados = new Set((store.setting('factSaldados') || []).map(String));   // bodas marcadas como pagadas ("evId:uid")
  const extraItems = []; let extra = 0;
  store.all('events').forEach(ev => {
    if (!(ev.fecha && ev.fecha >= CUT)) return;
    if (!evRealized(ev)) return;
    if (assignedWorkers(ev).indexOf(String(uid)) < 0) return;
    if (saldados.has(ev.id + ':' + uid)) return;   // marcada como pagada para este trabajador
    const e = workerEarning(ev, uid);
    const locN = (locById(ev.lugar) || {}).name || ev.lugarOtro || '';
    extraItems.push({ type: 'ev', evId: ev.id, lugar: locN, title: 'Boda #' + ev.id + (locN ? ' · ' + locN : ''), date: ev.fecha, amount: e.amount,
      body: ['Fecha del evento: ' + (ev.fecha || '')].concat(e.lines.map(l => l[0] + ': ' + l[1])) });
    extra += e.amount;
  });
  // Ajustes manuales del trabajador (gasolina, comidas…): positivos o negativos, no ligados a un evento.
  const adjItems = []; let adj = 0;
  store.all('adjustments').forEach(a => {
    if (+a.userId !== +uid) return;
    if (FS) return;   // arranque limpio: solo cuenta lo GENERADO esta semana (ni ajustes ni pagos viejos)
    const amt = parseFloat(a.amount) || 0;
    adjItems.push({ type: 'adj', adjId: a.id, title: 'Ajuste · ' + (a.concept || 'Plus'), date: a.date || '', amount: amt,
      body: ['Ajuste manual de administración', a.concept ? ('Concepto: ' + a.concept) : '', 'Importe: ' + (amt > 0 ? '+' : '') + amt + ' €'].filter(Boolean) });
    adj += amt;
  });
  const bonus = extra + adj;
  if (!extraItems.length && !adjItems.length) return snap;
  const items = adjItems.sort((a, b) => String(b.date).localeCompare(String(a.date))).concat(extraItems, snap.items || []);
  return { cobrar: (snap.cobrar || 0) + bonus, cobrado: (snap.cobrado || 0), rest: (snap.rest || 0) + bonus, items };
}

// Congela automáticamente las tarifas de las bodas nuevas ya pasadas con un MARGEN de días
// (por defecto 3) para dar tiempo a corregir tarifas antes de que se bloqueen. A partir de ahí,
// cambiar tarifas o precios de masía no las afecta. Las horas extra del parte siguen vivas.
function freezeRealized(graceDays) {
  refresh();
  const CUT = volcadoCutoff();
  const g = (graceDays == null) ? 0 : graceDays;   // 0 = se congela en cuanto la boda está realizada
  const lim = new Date(bizToday() + 'T00:00:00'); lim.setDate(lim.getDate() - g);
  const ymd = lim.getFullYear() + '-' + String(lim.getMonth() + 1).padStart(2, '0') + '-' + String(lim.getDate()).padStart(2, '0');
  let n = 0;
  store.all('events').forEach(ev => {
    if (ev.ratesFrozen) return;
    if (!(ev.fecha && ev.fecha >= CUT)) return;   // solo bodas nuevas (post-volcado)
    if (!(ev.fecha <= ymd)) return;               // aún dentro del margen de corrección
    if (!evRealized(ev)) return;
    ev.ratesFrozen = freezeRates(ev);
    store.put('events', ev); n++;
  });
  return n;
}

// Re-aplica la tarifa ACTUAL a bodas concretas (por id): recalcula su congelado. Se usa cuando el
// admin cambia la tarifa de un DJ y elige aplicarla a bodas ya realizadas.
function reapplyRateToEvents(eventIds) {
  refresh();
  const set = new Set((eventIds || []).map(x => +x));
  let n = 0;
  store.all('events').forEach(ev => {
    if (!set.has(+ev.id)) return;
    ev.ratesFrozen = freezeRates(ev);
    store.put('events', ev); n++;
  });
  return n;
}

module.exports = { computeFact, computeRevenue, factTotal, eventTotals, prime, workerEarning, assignedWorkers, withFacturacion, aggregateFor, allBalances, volcadoCutoff, freshStart, freezeRates, freezeRealized, reapplyRateToEvents, HOURLY_RATE, OVERTIME };
