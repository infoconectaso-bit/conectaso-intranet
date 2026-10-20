'use strict';
/**
 * Fechas/horas en horario de Madrid (el servidor corre en UTC).
 * Regla de negocio: un evento pasa a "finalizado/realizado" a las 05:00 del día
 * siguiente al evento. La facturación del equipo se genera al llegar la hora del evento.
 */
const TZ = 'Europe/Madrid';
function madridDate() { return new Date(new Date().toLocaleString('en-US', { timeZone: TZ })); }
function fmtYmd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
// "hoy" de negocio: la fecha de Madrid restándole 5 h (corte a las 05:00).
function bizToday() { const d = madridDate(); d.setHours(d.getHours() - 5); return fmtYmd(d); }
// momento actual en Madrid como 'YYYY-MM-DDTHH:MM' (para comparar con fecha+hora del evento).
function nowMadridISO() { const d = madridDate(); return fmtYmd(d) + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
// finalizado: a partir de las 05:00 del día siguiente al evento.
function evFinished(ev) { return !!(ev && ev.fecha && ev.fecha < bizToday()); }
// realizado: ya ha llegado (o pasado) la fecha+hora del evento.
function evRealized(ev) {
  if (!ev || !ev.fecha) return false;
  const h = /^(\d{1,2}):(\d{2})/.exec(ev.hora || '');
  const hhmm = h ? (('0' + h[1]).slice(-2) + ':' + h[2]) : '00:00';
  return (ev.fecha + 'T' + hhmm) <= nowMadridISO();
}
module.exports = { bizToday, nowMadridISO, evFinished, evRealized };
