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
// Campos ocultos al cliente
const CLIENT_HIDDEN = ['factRows', 'plus', 'obsPriv', 'obsDj', 'totalCost', 'djOvertime', 'opinion', 'pagoRestaurante'];
// Campos que el cliente puede modificar cuando la edición está habilitada
const CLIENT_EDITABLE = ['music', 'optionals', 'disco', 'extras', 'spouses', 'guests', 'celebrationHour', 'lugarCeremonia', 'ceremoniaFuera', 'hora'];
// Campos que el DJ puede modificar en sus eventos
const DJ_EDITABLE = ['obsDj'];

function canSeeEvent(user, ev) {
  if (!ev) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'user') return +ev.userId === +user.id;
  if (user.role === 'planner') return +ev.wpId === +user.id;
  if (user.role === 'dj') return +ev.djId === +user.id || (ev.services || []).some(s => +s.resp === +user.id || +s.resp2 === +user.id);
  return false;
}

function sanitizeEvent(user, ev) {
  if (!ev || user.role === 'admin') return ev;
  const out = JSON.parse(JSON.stringify(ev));
  const hide = user.role === 'user' ? CLIENT_HIDDEN : STAFF_HIDDEN;
  hide.forEach(k => delete out[k]);
  if (user.role !== 'user' && Array.isArray(out.spouses)) out.spouses.forEach(s => { delete s.dni; delete s.address; });
  return out;
}

const EVENT_SUMMARY = ['id', 'tipo', 'conyuges', 'fecha', 'hora', 'lugar', 'lugarOtro', 'estado', 'metodo', 'pagoCliente', 'pagado',
  'userId', 'services', 'djId', 'wpId', 'editUser', 'guests'];
function summarizeEvent(user, ev) {
  const s = {};
  EVENT_SUMMARY.forEach(k => { if (ev[k] !== undefined) s[k] = ev[k]; });
  return user.role === 'admin' ? s : sanitizeEvent(user, s);
}

/** Aplica los cambios permitidos de un no-admin sobre el evento actual. Devuelve el registro final o lanza error. */
function mergeEventUpdate(user, current, incoming) {
  if (user.role === 'admin') return Object.assign({}, current, incoming, { id: current.id });
  let allowed = [];
  if (user.role === 'user') {
    if (!current.editUser) throw httpError(403, 'La edición de este evento no está habilitada. Contacta con Conecta So.');
    allowed = CLIENT_EDITABLE;
  } else if (user.role === 'dj') allowed = DJ_EDITABLE;
  else throw httpError(403, 'Tu perfil solo puede consultar este evento.');
  const next = Object.assign({}, current);
  allowed.forEach(k => { if (incoming[k] !== undefined) next[k] = incoming[k]; });
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
  payments:      { read: 'own',   write: ['admin'] },
  workers:       { read: 'own',   write: ['admin'] },
  history:       { read: 'own',   write: ['admin'] },
  extraRequests: { read: 'admin', write: ['admin'] },
};

module.exports = { canSeeEvent, sanitizeEvent, summarizeEvent, mergeEventUpdate, httpError, POLICY };
