'use strict';
/**
 * Integración con Google Calendar (API, OAuth 2.0) — sincronización INSTANTÁNEA.
 * A diferencia de la suscripción ICS (que el calendario del DJ refresca cada varias horas), esto
 * empuja cada boda al Google Calendar del DJ en el momento (crear / actualizar / borrar).
 *
 * Sin librerías externas: todo con el módulo https de Node (igual que el resto de la intranet).
 *
 * REQUISITOS para encenderlo (se hace una vez, con el dominio ya en HTTPS):
 *  1) Un proyecto en Google Cloud con la API de Google Calendar activada.
 *  2) Credenciales OAuth (ID de cliente + secreto) de tipo "Aplicación web".
 *  3) Añadir como "URI de redirección autorizado":  https://TU-DOMINIO/api/gcal/callback
 *  4) Pegar el ID de cliente y el secreto en Ajustes → Google Calendar (en la intranet).
 * Google exige que la redirección sea HTTPS (no vale una IP ni http), por eso necesita el dominio.
 *
 * Config en el setting 'gcalConfig' = { enabled, clientId, clientSecret }.
 * Tokens por usuario en user.data.gcal = { access_token, refresh_token, expiry }.
 * El id del evento en el calendario del DJ se guarda en ev.gcalIds[uid] para poder actualizar/borrar.
 */
const https = require('https');
const { store, users } = require('./db');

const TOKEN_HOST = 'oauth2.googleapis.com';
const API_HOST = 'www.googleapis.com';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function getConfig() { return store.setting('gcalConfig') || {}; }
function enabled() { const c = getConfig(); return !!(c.enabled && c.clientId && c.clientSecret); }

// --- petición HTTPS JSON genérica (POST form o GET/method con body JSON) ---
function request(host, method, path, { form, json, headers } = {}) {
  return new Promise((resolve, reject) => {
    let body = '';
    const h = Object.assign({}, headers);
    if (form) { body = new URLSearchParams(form).toString(); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
    else if (json !== undefined) { body = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ host, method, path, headers: h }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        let parsed = null; try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = data; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error('Google ' + res.statusCode + ': ' + (parsed && parsed.error_description || parsed && parsed.error && parsed.error.message || parsed && parsed.error || data).toString().slice(0, 200)));
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- OAuth ---
/** URL a la que mandamos al DJ para que autorice (state lleva su id de usuario). */
function authUrl(userId, redirectUri) {
  const c = getConfig();
  const qs = new URLSearchParams({
    client_id: c.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: String(userId)
  });
  return AUTH_URL + '?' + qs.toString();
}
/** Intercambia el 'code' del callback por tokens (incluye refresh_token con access_type=offline). */
async function exchangeCode(code, redirectUri) {
  const c = getConfig();
  const t = await request(TOKEN_HOST, 'POST', '/token', { form: { code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' } });
  return t; // { access_token, refresh_token, expires_in, ... }
}
async function refreshAccess(refresh_token) {
  const c = getConfig();
  return request(TOKEN_HOST, 'POST', '/token', { form: { client_id: c.clientId, client_secret: c.clientSecret, refresh_token, grant_type: 'refresh_token' } });
}

/** Los tokens se guardan en el setting 'gcalTokens' (NO en la ficha del usuario), para que nunca
 * lleguen al navegador. Clave = id de usuario → { access_token, refresh_token, expiry }. */
function allTokens() { return store.setting('gcalTokens') || {}; }
function getUserTokens(uid) { return allTokens()[uid] || null; }
function saveUserTokens(uid, tok) {
  const all = allTokens(); const cur = all[uid] || {};
  const gcal = Object.assign({}, cur, tok);
  if (tok.expires_in) gcal.expiry = Date.now() + (tok.expires_in - 60) * 1000;   // margen de 60 s
  if (!gcal.refresh_token && cur.refresh_token) gcal.refresh_token = cur.refresh_token;   // conserva el refresh_token
  all[uid] = gcal; store.setSetting('gcalTokens', all);
}
function clearUserTokens(uid) { const all = allTokens(); delete all[uid]; store.setSetting('gcalTokens', all); }
function connected(uid) { const t = getUserTokens(uid); return !!(t && t.refresh_token); }

/** Devuelve un access_token válido (lo refresca si ha caducado). */
async function validToken(uid) {
  const t = getUserTokens(uid); if (!t || !t.refresh_token) throw new Error('El DJ no tiene Google Calendar conectado.');
  if (t.access_token && t.expiry && Date.now() < t.expiry) return t.access_token;
  const r = await refreshAccess(t.refresh_token);
  saveUserTokens(uid, r);
  return r.access_token;
}

// --- Colores: mapea el color (hex) de la masía en la intranet al color de Google Calendar ---
// Google solo admite 11 colores fijos para eventos; elegimos el más parecido al de la masía.
// Hex de referencia = los colores tal y como se ven en Google Calendar (paleta vistosa).
const GCAL_COLORS = { 1: '7986CB', 2: '33B679', 3: '8E24AA', 4: 'E67C73', 5: 'F6BF26', 6: 'F4511E', 7: '039BE5', 8: '616161', 9: '3F51B5', 10: '0B8043', 11: 'D50000' };
function nearestColorId(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim()); if (!m) return null;
  const n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  let best = null, bd = Infinity;
  for (const id in GCAL_COLORS) { const c = parseInt(GCAL_COLORS[id], 16); const dr = r - ((c >> 16) & 255), dg = g - ((c >> 8) & 255), db = b - (c & 255); const d = dr * dr + dg * dg + db * db; if (d < bd) { bd = d; best = id; } }
  return best;
}

// --- Mapea una boda de la intranet a un evento de Google Calendar ---
function pad(n) { return String(n).padStart(2, '0'); }
function eventBody(ev, loc) {
  // loc puede ser el registro de la localización {name,colorHex} o, por compatibilidad, solo el nombre.
  const locName = loc && typeof loc === 'object' ? loc.name : loc;
  const colorHex = loc && typeof loc === 'object' ? loc.colorHex : null;
  const hm = /^(\d{1,2}):(\d{2})/.exec(ev.hora || '');
  const summary = (ev.tipo || 'Boda') + (ev.conyuges ? ' · ' + ev.conyuges : '') + ' #' + ev.id;
  const ymd = String(ev.fecha || '').slice(0, 10);
  const body = { summary, location: locName || ev.lugarOtro || '', description: 'Conecta So · Boda #' + ev.id + (ev.conyuges ? ' · ' + ev.conyuges : ''), source: { title: 'Conecta So', url: 'https://intranet.conectaso.es/#/eventos/' + ev.id } };
  const cid = nearestColorId(colorHex); if (cid) body.colorId = String(cid);
  if (hm) {
    const start = ymd + 'T' + pad(+hm[1]) + ':' + hm[2] + ':00';
    // Inicio = hora de la ceremonia. Damos 1 h de duración por defecto (Google exige fin).
    const endH = pad((+hm[1] + 1) % 24);
    const end = ymd + 'T' + endH + ':' + hm[2] + ':00';
    body.start = { dateTime: start, timeZone: 'Europe/Madrid' };
    body.end = { dateTime: end, timeZone: 'Europe/Madrid' };
  } else {
    body.start = { date: ymd };
    body.end = { date: ymd };
  }
  return body;
}

/** Crea o actualiza la boda en el calendario del DJ. Guarda el id del evento de Google en ev.gcalIds[uid].
 * Devuelve true si hizo algo. NO lanza hacia fuera (el llamador no debe romperse si Google falla). */
async function upsertForUser(ev, uid, loc) {
  if (!enabled() || !connected(uid)) return false;
  const token = await validToken(uid);
  const headers = { Authorization: 'Bearer ' + token };
  const body = eventBody(ev, loc);
  const gid = ev.gcalIds && ev.gcalIds[uid];
  let resp;
  if (gid) {
    try { resp = await request(API_HOST, 'PUT', '/calendar/v3/calendars/primary/events/' + encodeURIComponent(gid), { json: body, headers }); }
    catch (e) { if (/ 404|410/.test(e.message)) resp = await request(API_HOST, 'POST', '/calendar/v3/calendars/primary/events', { json: body, headers }); else throw e; }
  } else {
    resp = await request(API_HOST, 'POST', '/calendar/v3/calendars/primary/events', { json: body, headers });
  }
  if (resp && resp.id) { ev.gcalIds = ev.gcalIds || {}; ev.gcalIds[uid] = resp.id; }
  return true;
}
/** Borra la boda del calendario del DJ (si existía). */
async function deleteForUser(ev, uid) {
  if (!enabled() || !connected(uid)) return false;
  const gid = ev.gcalIds && ev.gcalIds[uid]; if (!gid) return false;
  const token = await validToken(uid);
  try { await request(API_HOST, 'DELETE', '/calendar/v3/calendars/primary/events/' + encodeURIComponent(gid), { headers: { Authorization: 'Bearer ' + token } }); } catch (e) { if (!/ 404|410/.test(e.message)) throw e; }
  if (ev.gcalIds) delete ev.gcalIds[uid];
  return true;
}

module.exports = { getConfig, enabled, authUrl, exchangeCode, refreshAccess, getUserTokens, saveUserTokens, clearUserTokens, connected, validToken, upsertForUser, deleteForUser, eventBody };
