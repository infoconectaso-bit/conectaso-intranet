'use strict';
/**
 * Recordatorios por email, basados en la fecha de cada evento. Se envían UNA sola vez
 * (se marca en ev.reminders) y SOLO si el correo está activo (mail.enabled()).
 *  - 15 días antes de la boda  → recordatorio general a los novios
 *  - 7 días antes              → si la música no está al 100%, recordatorio a los novios
 *  - boda finalizada (1–7 días) → aviso al DJ/técnicos para rellenar su parte de trabajo
 */
const { store, users } = require('./db');
const mail = require('./mail');
const emails = require('./emails');

const APP_URL = () => (process.env.APP_URL || '').replace(/\/$/, '');
const bizToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });

// --- estructuras de momentos musicales (espejo de las del cliente, para medir el progreso) ---
const MUSIC_AREAS = [
  { key: 'ceremony', moments: ['first_spouse_entry', 'second_spouse_entry', 'rings', 'signatures', 'exit', 'readings'] },
  { key: 'aperitif', moments: ['entry'] },
  { key: 'banquet', moments: ['entry', 'first', 'second', 'sorbet', 'dessert', 'cake_presentation', 'cake'] },
];
const RIBAS_AREAS = [
  { key: 'ceremony', moments: ['first_spouse_entry', 'second_spouse_entry', 'rings', 'signatures', 'exit', 'readings', 'vehicle_entry', 'vows'] },
  { key: 'aperitif', moments: ['entry'] },
  { key: 'banquet', moments: ['entry', 'first', 'first_tasting', 'second_tasting', 'cake'] },
];
const OLIVER_AREAS = [
  { key: 'ceremony', moments: ['first_spouse_entry', 'second_spouse_entry', 'rings', 'signatures', 'exit', 'readings'] },
  { key: 'aperitif', moments: ['entry'] },
  { key: 'banquet', moments: ['entry', 'wine_white', 'first', 'sorbet', 'wine_red', 'second', 'cake'] },
];
const DISCO_MOMENTS = ['dance', 'last_song'];
const RIBAS_IDS = [14, 15, 16], OLIVER_IDS = [8, 25, 26, 27];
const areasFor = ev => { const l = +((ev && ev.lugar) || 0); return RIBAS_IDS.includes(l) ? RIBAS_AREAS : (OLIVER_IDS.includes(l) ? OLIVER_AREAS : MUSIC_AREAS); };

// % de música rellenada (mismo cálculo que el cliente: solo campos musicales activos).
function musicProgress(ev) {
  const music = ev.music || {};
  const active = k => !(music[k] && music[k].on);
  const keys = [];
  areasFor(ev).forEach(a => { if (a.key === 'ceremony' && ev.ceremoniaFuera) return; a.moments.forEach(m => keys.push(a.key + '_' + m)); });
  DISCO_MOMENTS.forEach(m => keys.push('disco_' + m));
  let total = 0, filled = 0;
  keys.forEach(k => { if (!active(k)) return; total++; if (music[k] && music[k].song) filled++; });
  (ev.optionals || []).forEach(o => { if (o.on) return; total++; if (o.value) filled++; });
  total++; if ((ev.disco || {}).playlist) filled++;
  return total <= 0 ? 0 : Math.round(filled / total * 100);
}

function daysUntil(fecha, today) {
  const p = String(fecha).slice(0, 10).split('-'); if (p.length < 3) return 9999;
  const ed = new Date(+p[0], +p[1] - 1, +p[2]); ed.setHours(0, 0, 0, 0);
  const t = new Date(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)); t.setHours(0, 0, 0, 0);
  return Math.round((ed - t) / 86400000);
}
function assignedStaff(ev) {
  const ids = new Set();
  if (ev.djId) ids.add(+ev.djId);
  (ev.services || []).forEach(s => { if (s.resp) ids.add(+s.resp); if (s.resp2) ids.add(+s.resp2); });
  return [...ids];
}
// Correos de los titulares de la boda (titular + co-titulares), sin repetir.
function coupleEmails(ev) {
  const ids = [ev.userId].concat(ev.coUsers || []).filter(Boolean);
  const seen = new Set(), out = [];
  ids.forEach(id => { const u = users.get(id); if (u && u.email && !seen.has(u.email.toLowerCase())) { seen.add(u.email.toLowerCase()); out.push(u.email); } });
  return out;
}
const sent = (ev, key) => !!(ev.reminders && ev.reminders[key]);
function markSent(ev, key) { ev.reminders = ev.reminders || {}; ev.reminders[key] = new Date().toISOString(); store.put('events', ev); }
const send = (to, em) => { try { mail.sendMail({ to, subject: em.subject, text: em.text, html: em.html }).catch(() => {}); } catch (e) {} };

function runReminders() {
  if (!mail.enabled()) return;                 // sin correo activo, no se envía nada
  const today = bizToday(), base = APP_URL();
  let n = 0;
  store.all('events').forEach(ev => {
    if (!ev.fecha) return;
    const d = daysUntil(ev.fecha, today);
    const link = base + '/#/eventos/' + ev.id;
    // 15 días antes → recordatorio general a los novios
    if (d === 15 && !sent(ev, 'd15')) {
      coupleEmails(ev).forEach(to => send(to, emails.coupleReminderEmail(ev, link, base)));
      markSent(ev, 'd15'); n++;
    }
    // 7 días antes → solo si la música no está al 100%
    if (d === 7 && !sent(ev, 'd7')) {
      if (musicProgress(ev) < 100) coupleEmails(ev).forEach(to => send(to, emails.coupleMusicEmail(ev, link, base)));
      markSent(ev, 'd7'); n++;
    }
    // boda finalizada en los últimos 7 días → aviso al DJ/técnicos (parte de trabajo)
    if (d <= -1 && d >= -7 && !sent(ev, 'albaran')) {
      assignedStaff(ev).forEach(id => { const u = users.get(id); if (u && u.email) send(u.email, emails.djAlbaranEmail(u, ev, link, base)); });
      markSent(ev, 'albaran'); n++;
    }
  });
  if (n) console.log('[recordatorios] ' + n + ' eventos procesados (' + today + ').');
}

// Arranca tras un pequeño retraso y luego cada 6 horas.
function startReminders() {
  setTimeout(() => { try { runReminders(); } catch (e) { console.error('[recordatorios]', e.message); } }, 20000);
  setInterval(() => { try { runReminders(); } catch (e) { console.error('[recordatorios]', e.message); } }, 6 * 60 * 60 * 1000);
}

module.exports = { runReminders, startReminders, musicProgress };
