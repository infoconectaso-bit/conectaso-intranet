'use strict';
/**
 * Reglas de acceso por perfil. El servidor es quien decide: la interfaz solo oculta lo que no se puede usar.
 *  admin   → todo
 *  dj      → sus eventos (asignado o responsable de un servicio), sus fichajes, vacaciones, pagos y uso de vehículos
 *  planner → las bodas donde está asignado (solo lectura)
 *  user    → sus propios eventos; edita música, momentos, extras y datos personales solo si el admin lo habilita
 */

// Campos que nunca ve el personal (DJ/planner) en una ficha de evento
const STAFF_HIDDEN = ['pagoCliente', 'pagado', 'pagoRestaurante', 'metodo', 'factRows', 'plus', 'obsPriv', 'totalCost'];
// Campos ocultos al cliente. 'djId' se oculta: el cliente solo ve a su DJ (por nombre,
// vía enrichEvent → djName) cuando faltan menos de 60 días, que es la asignación final.
const CLIENT_HIDDEN = ['factRows', 'plus', 'obsPriv', 'obsDj', 'totalCost', 'djOvertime', 'opinion', 'pagoRestaurante', 'djId'];
// Campos que el cliente puede modificar cuando la edición está habilitada
const CLIENT_EDITABLE = ['music', 'optionals', 'disco', 'extras', 'spouses', 'guests', 'celebrationHour', 'lugarCeremonia', 'ceremoniaFuera', 'hora'];
// El wedding planner puede modificar lo mismo que el cliente (música, extras, horarios,
// datos de la boda) EXCEPTO la fecha y el lugar, y sin el bloqueo de 7 días del cliente.
const PLANNER_EDITABLE = CLIENT_EDITABLE;
// Campos que el DJ puede modificar: música, momentos opcionales, disco, títulos y estado de
// contacto SIEMPRE; y su "parte de trabajo" (observaciones, horas extra, opinión) solo tras
// celebrarse la boda. El detalle de qué y cuándo se decide en mergeEventUpdate.
const DJ_EDITABLE = ['estado', 'music', 'optionals', 'disco', 'labels', 'obsDj', 'djOvertime', 'opinion'];
const { evRealized } = require('./time');

// Días hasta la boda (0 = hoy). La edición del cliente se cierra 7 días antes,
// salvo que administración la reabra con el toggle (editUser/editUnlock).
function daysUntilEvent(ev) {
  if (!ev || !ev.fecha) return 9999;
  const p = String(ev.fecha).slice(0, 10).split('-'); if (p.length < 3) return 9999;
  const ed = new Date(+p[0], +p[1] - 1, +p[2]); ed.setHours(0, 0, 0, 0);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((ed - t) / 86400000);
}
function clientEditOpen(ev) { return daysUntilEvent(ev) > 7 ? true : (!!ev && (ev.editUser === true || ev.editUnlock === true)); }

function canSeeEvent(user, ev) {
  if (!ev) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'user') return +ev.userId === +user.id || (ev.coUsers || []).some(x => +x === +user.id);
  if (user.role === 'planner') return +ev.wpId === +user.id;
  if (user.role === 'dj') return +ev.djId === +user.id || (ev.services || []).some(s => +s.resp === +user.id || +s.resp2 === +user.id);
  return false;
}

function sanitizeEvent(user, ev) {
  if (!ev || user.role === 'admin') return ev;
  const out = JSON.parse(JSON.stringify(ev));
  const hide = user.role === 'user' ? CLIENT_HIDDEN : STAFF_HIDDEN;
  hide.forEach(k => delete out[k]);
  // El wedding planner NO ve los servicios ni quién los lleva (solo admin y DJ).
  if (user.role === 'planner') delete out.services;
  if (user.role !== 'user' && Array.isArray(out.spouses)) out.spouses.forEach(s => { delete s.dni; delete s.address; });
  return out;
}

const EVENT_SUMMARY = ['id', 'tipo', 'conyuges', 'fecha', 'hora', 'lugar', 'lugarOtro', 'estado', 'metodo', 'pagoCliente', 'pagado',
  'userId', 'coUsers', 'services', 'djId', 'wpId', 'editUser', 'guests', 'vehicleId'];
function summarizeEvent(user, ev) {
  const s = {};
  EVENT_SUMMARY.forEach(k => { if (ev[k] !== undefined) s[k] = ev[k]; });
  s.canEdit = clientEditOpen(ev);
  return user.role === 'admin' ? s : sanitizeEvent(user, s);
}

/** Aplica los cambios permitidos de un no-admin sobre el evento actual. Devuelve el registro final o lanza error. */
function mergeEventUpdate(user, current, incoming) {
  if (user.role === 'admin') return Object.assign({}, current, incoming, { id: current.id });
  let allowed = [];
  if (user.role === 'user') {
    if (!clientEditOpen(current)) throw httpError(403, 'La edición de este evento no está habilitada. Contacta con Conecta So.');
    allowed = CLIENT_EDITABLE;
  } else if (user.role === 'planner') {
    // El planner, como el cliente, NO puede editar dentro de los últimos 7 días (edición cerrada).
    if (!clientEditOpen(current)) throw httpError(403, 'La edición de esta boda está cerrada (últimos 7 días). Ahora solo pueden cambiarla administración o el DJ.');
    allowed = PLANNER_EDITABLE;
  } else if (user.role === 'dj') {
    // El DJ (y admin) puede editar la MÚSICA y el ESTADO de contacto SIEMPRE, incluso en los
    // últimos 7 días. El PARTE (observaciones, horas extra, opinión) solo tras celebrarse la boda.
    const realized = evRealized(current);
    if (!realized && ['obsDj', 'djOvertime', 'opinion', 'djCeremony'].some(k => incoming[k] !== undefined))
      throw httpError(403, 'Podrás rellenar el parte de trabajo cuando se haya celebrado la boda.');
    allowed = ['estado', 'music', 'optionals', 'disco', 'labels'].concat(realized ? ['obsDj', 'djOvertime', 'opinion', 'djCeremony'] : []);
  }
  else throw httpError(403, 'Tu perfil solo puede consultar este evento.');
  const next = Object.assign({}, current);
  allowed.forEach(k => { if (incoming[k] !== undefined) next[k] = incoming[k]; });
  // Al marcar un extra (novios o planner) se crea una solicitud: estado "solicitado".
  // Si lo desmarca antes de confirmarse, se retira la solicitud.
  if ((user.role === 'user' || user.role === 'planner') && incoming.extras !== undefined) {
    const nx = incoming.extras || {}, st = Object.assign({}, current.extraStatus || {});
    Object.keys(nx).forEach(k => { if (nx[k] && !st[k]) st[k] = 'solicitado'; });
    Object.keys(st).forEach(k => { if (st[k] === 'solicitado' && !nx[k]) delete st[k]; });
    next.extraStatus = st;
  }
  if (user.role === 'user' && Array.isArray(incoming.spouses)) {
    // El cliente no puede borrar datos que no ve; se fusionan por posición
    next.spouses = incoming.spouses.slice(0, 2).map((s, i) => Object.assign({}, (current.spouses || [])[i] || {}, s));
    next.conyuges = next.spouses.map(s => s.name).filter(Boolean).join(' y ') || current.conyuges;
  }
  return next;
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

/**
 * Política por colección para las rutas genéricas.
 * read: 'all' (cualquiera con sesión), 'admin', 'own' (owner_id = usuario) o función.
 * write: roles que pueden crear/editar; ownWrite: el registro se fuerza al propio usuario.
 */
const POLICY = {
  locations:     { read: 'all',   write: ['admin'] },
  extras:        { read: 'all',   write: ['admin'] },
  tacs:          { read: 'all',   write: ['admin'] },
  vehicles:      { read: ['admin', 'dj'], write: ['admin'] },
  attendances:   { read: 'own',   write: ['admin', 'dj'], ownWrite: ['dj'] },
  vacations:     { read: 'own',   write: ['admin', 'dj'], ownWrite: ['dj'] },
  usages:        { read: 'own',   write: ['admin', 'dj'], ownWrite: ['dj'] },
  maintenance:   { read: 'own',   write: ['admin', 'dj'], ownWrite: ['dj'] },
  payments:      { read: 'own',   write: ['admin'] },
  workers:       { read: 'own',   write: ['admin'] },
  history:       { read: 'own',   write: ['admin'] },
  extraRequests: { read: 'admin', write: ['admin'] },
};

module.exports = { canSeeEvent, sanitizeEvent, summarizeEvent, mergeEventUpdate, httpError, POLICY, clientEditOpen, daysUntilEvent };
