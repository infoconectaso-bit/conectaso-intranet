'use strict';
/**
 * Integración con Spotify para generar UNA playlist por boda (en una sola cuenta de empresa).
 * - OAuth Authorization Code: la cuenta Premium de empresa autoriza UNA vez; se guarda el refresh_token.
 * - La clave (Client ID / Secret / refresh_token) se guarda en el setting 'spotifyConfig' (nunca al navegador).
 * - Motor de emparejado portado de la herramienta del compañero (similitud por bigramas + tokens + penalización
 *   de versiones karaoke/cover/live/remix…), para elegir la mejor coincidencia de cada canción.
 */
const { store } = require('./db');

// Client ID por defecto (no es secreto). Se puede sobreescribir desde el panel.
const DEFAULT_CLIENT_ID = 'a5c8f1a344494988ad9d39187b040eb2';
const AUTH = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'playlist-modify-private playlist-modify-public user-read-email';

function getConfig() { const c = store.setting('spotifyConfig') || {}; return { enabled: !!c.enabled, clientId: c.clientId || DEFAULT_CLIENT_ID, clientSecret: c.clientSecret || '', refreshToken: c.refreshToken || '', account: c.account || '', accountId: c.accountId || '', redirect: c.redirect || '', scope: c.scope || '' }; }
function saveConfig(patch) { const c = store.setting('spotifyConfig') || {}; store.setSetting('spotifyConfig', Object.assign({}, c, patch)); }
// "configurado" = tiene ID y secreto; "conectado" = además tiene refresh_token (cuenta autorizada).
function configured() { const c = getConfig(); return !!(c.clientId && c.clientSecret); }
function connected() { const c = getConfig(); return !!(c.clientId && c.clientSecret && c.refreshToken); }

/* ---------- OAuth ---------- */
function authUrl(redirect, state) {
  const c = getConfig();
  // show_dialog=true fuerza a Spotify a volver a pedir el consentimiento (con los permisos actuales),
  // evitando que se reutilice una autorización antigua sin los permisos de crear playlists.
  const p = new URLSearchParams({ response_type: 'code', client_id: c.clientId, scope: SCOPES, redirect_uri: redirect, state: state || '', show_dialog: 'true' });
  return AUTH + '?' + p.toString();
}
async function tokenRequest(body) {
  const c = getConfig();
  const basic = Buffer.from(c.clientId + ':' + c.clientSecret).toString('base64');
  const r = await fetch(TOKEN, { method: 'POST', headers: { 'Authorization': 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const txt = await r.text(); let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (e) {}
  if (!r.ok) throw new Error((j.error_description || j.error || ('HTTP ' + r.status)));
  return j;
}
// Intercambia el 'code' del callback por tokens y guarda el refresh_token + el nombre de la cuenta.
async function exchangeCode(code, redirect) {
  const j = await tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect }));
  if (!j.refresh_token) throw new Error('Spotify no devolvió refresh_token.');
  _access = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  saveConfig({ refreshToken: j.refresh_token, enabled: true, scope: j.scope || '' });
  try { const me = await apiGet('/me'); saveConfig({ account: me.display_name || me.id || '', accountId: me.id || '' }); return me; } catch (e) { return null; }
}
let _access = null;   // { token, exp } en memoria
async function accessToken() {
  const c = getConfig();
  if (!c.refreshToken) throw new Error('Spotify no está conectado. Conecta la cuenta de empresa en Configuración avanzada.');
  if (_access && Date.now() < _access.exp) return _access.token;
  const j = await tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken }));
  _access = { token: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 60) * 1000 };
  if (j.refresh_token && j.refresh_token !== c.refreshToken) saveConfig({ refreshToken: j.refresh_token });
  if (j.scope != null) saveConfig({ scope: j.scope });   // el refresco también informa del scope real del token
  return _access.token;
}
function forceRefresh() { _access = null; }   // obliga a pedir un token nuevo (para diagnóstico)
function disconnect() { _access = null; saveConfig({ refreshToken: '', account: '', enabled: false }); }

/* ---------- API con reintentos (rate-limit 429, 5xx) ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function spFetch(method, path, body) {
  const token = await accessToken();
  for (let attempt = 0; attempt < 6; attempt++) {
    let r;
    try { r = await fetch(API + path, { method, headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body != null ? JSON.stringify(body) : undefined }); }
    catch (e) { throw new Error('No se pudo contactar con Spotify: ' + e.message); }
    if (r.status === 429) { const s = parseFloat(r.headers.get('Retry-After')) || (2 + attempt * 2); await sleep(s * 1000 + 300); continue; }
    if (r.status === 401 && attempt === 0) { _access = null; await accessToken(); continue; }
    if (r.status >= 500 && attempt < 5) { await sleep(800 * (attempt + 1)); continue; }
    const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
    if (!r.ok) {
      let base = (j && j.error && (j.error.message || j.error)) || r.statusText || ('HTTP ' + r.status);
      const e = new Error(base + ' (HTTP ' + r.status + ')'); e.status = r.status; e.raw = txt; throw e;
    }
    return j;
  }
  throw new Error('Spotify está limitando las peticiones; inténtalo en un minuto.');
}
const apiGet = p => spFetch('GET', p);
const apiPost = (p, b) => spFetch('POST', p, b);
const apiPut = (p, b) => spFetch('PUT', p, b);

async function me() { return apiGet('/me'); }
async function search(q) { const p = new URLSearchParams({ q, type: 'track', limit: '10', market: 'ES' }); const j = await apiGet('/search?' + p.toString()); return (j && j.tracks && j.tracks.items || []).filter(Boolean); }
async function getTrack(id) { return apiGet('/tracks/' + id + '?market=ES'); }

/* ---------- Motor de emparejado (portado de la herramienta del compañero) ---------- */
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s-\s.*$/, ' ')
    .replace(/\b(feat|ft|featuring|con|with)\b\.?.*$/, ' ')
    .replace(/&/g, ' and ').replace(/\by\b/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function bigrams(s) { s = ' ' + s + ' '; const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; }
function dice(a, b) {
  if (!a || !b) return 0; if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b); let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [g, v] of A) if (B.has(g)) inter += Math.min(v, B.get(g));
  return 2 * inter / (na + nb);
}
function toks(q, c) { const qt = q.split(' ').filter(Boolean); if (!qt.length) return 0; const ct = new Set(c.split(' ')); return qt.filter(t => ct.has(t)).length / qt.length; }
const sim = (q, c) => 0.6 * dice(q, c) + 0.4 * toks(q, c);
const FLAGS = [['karaoke', .45], ['tribute', .4], ['cover', .35], ['instrumental', .3], ['remix', .2], ['live', .2], ['en vivo', .2], ['en directo', .2], ['acoustic', .15], ['acustic', .15], ['sped up', .4], ['slowed', .4], ['8d', .3]];
function flagPenalty(qRaw, cRaw) {
  const q = String(qRaw).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''), c = String(cRaw).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let p = 0; for (const [f, w] of FLAGS) if (c.includes(f) && !q.includes(f)) p += w; return p;
}
function score(item, t) {
  const title = norm(t.name), artists = (t.artists || []).map(a => norm(a.name));
  const allA = artists.join(' ');
  const aSim = x => Math.max(sim(x, allA), ...artists.map(a => sim(x, a)));
  let s;
  if (item.a && item.b) {
    const s1 = 0.55 * sim(norm(item.b), title) + 0.45 * aSim(norm(item.a));
    const s2 = 0.55 * sim(norm(item.a), title) + 0.45 * aSim(norm(item.b));
    s = Math.max(s1, s2);
  } else {
    const q = norm(item.q);
    s = Math.max(sim(q, title + ' ' + allA), sim(q, allA + ' ' + title), toks(q, title + ' ' + allA) * 0.9);
  }
  const candRaw = t.name + ' ' + ((t.album && t.album.name) || '') + ' ' + (t.artists || []).map(a => a.name).join(' ');
  return Math.max(0, Math.min(1, s - flagPenalty(item.pq || item.q || '', candRaw)));
}

/* ---------- Parseo de una canción de la intranet (nombre + enlace) ---------- */
const TRACK_RE = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/;
const YT_RE = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;
const SEPS = ['\t', ' - ', ' – ', ' — ', ' | ', ' / ', ' by '];
function splitArtistTitle(s) {
  for (const sep of SEPS) { const i = s.toLowerCase().indexOf(sep.toLowerCase()); if (i > 0) return { a: s.slice(0, i).trim(), b: s.slice(i + sep.length).trim() }; }
  return { a: '', b: '' };
}
// Convierte {title, song, url} en un item para resolver: {kind, id|ytId|q|a|b, title}
function toItem(m) {
  const song = String(m.song || '').trim();
  const url = String(m.url || m.link || '').trim();
  const base = { title: m.title || '', song, url };
  if (url) {
    const mt = url.match(TRACK_RE); if (mt) return Object.assign(base, { kind: 'id', id: mt[1] });
    const yt = url.match(YT_RE); if (yt) return Object.assign(base, { kind: 'yt', ytId: yt[1] });
  }
  if (song) { const { a, b } = splitArtistTitle(song); return Object.assign(base, { kind: 'text', a, b, q: song, pq: song }); }
  return Object.assign(base, { kind: 'none' });
}

async function ytMeta(id) {
  const url = 'https://www.youtube.com/watch?v=' + id;
  try {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url));
    if (!r.ok) throw 0; const j = await r.json(); if (!j || !j.title) throw 0;
    return { title: j.title, author: j.author_name || '' };
  } catch (e) {
    try { const r = await fetch('https://noembed.com/embed?url=' + encodeURIComponent(url)); const j = await r.json(); if (j && j.title) return { title: j.title, author: j.author_name || '' }; } catch (e2) {}
    throw new Error('yt');
  }
}
function ytClean(title, author) {
  let t = String(title)
    .replace(/[(\[][^)\]]*\b(official|oficial|video|v[ií]deo|videoclip|lyrics?|letra|audio|visuali[sz]er|hd|hq|4k|mv|clip|remaster(ed)?)\b[^)\]]*[)\]]/gi, ' ')
    .replace(/\b(official|oficial)\s+(music\s+)?(video|v[ií]deo|audio|videoclip|lyric video)\b/gi, ' ')
    .replace(/[|•]\s*$/, '').replace(/\s+/g, ' ').trim();
  const a0 = String(author).replace(/\s*-\s*Topic$/i, '').replace(/\s*VEVO$/i, '').replace(/\s*(official|oficial)$/i, '').trim();
  const sp = splitArtistTitle(t);
  if (sp.a) return { a: sp.a, b: sp.b, q: t, pq: title };
  return { a: a0, b: t, q: (a0 + ' ' + t).trim(), pq: title };
}

// Resuelve UN item a una pista de Spotify. Devuelve { status:'ok'|'warn'|'bad', track, score, candidates, error }.
async function resolveItem(it) {
  if (it.kind === 'none') return { status: 'bad', error: 'Sin canción ni enlace' };
  if (it.kind === 'id') {
    try { const t = await getTrack(it.id); return { status: 'ok', track: t, score: 1, candidates: [t] }; }
    catch (e) { return { status: 'bad', error: 'El enlace de Spotify no es válido' }; }
  }
  if (it.kind === 'yt') {
    try { const m = await ytMeta(it.ytId); Object.assign(it, ytClean(m.title, m.author)); }
    catch (e) { return { status: 'bad', error: 'No se pudo leer el vídeo de YouTube' }; }
  }
  const pool = new Map();
  const add = list => list.forEach(t => { if (t && t.id && !pool.has(t.id)) pool.set(t.id, { t, s: score(it, t) }); });
  try {
    add(await search(it.a && it.b ? (it.a + ' ' + it.b) : it.q));
    let best = Math.max(0, ...[...pool.values()].map(c => c.s));
    if (best < 0.8 && it.a && it.b) {
      add(await search('track:' + it.b + ' artist:' + it.a));
      best = Math.max(0, ...[...pool.values()].map(c => c.s));
      if (best < 0.8) add(await search('track:' + it.a + ' artist:' + it.b));
    }
  } catch (e) { return { status: 'bad', error: e.message }; }
  const cands = [...pool.values()].sort((x, y) => y.s - x.s).slice(0, 6);
  if (!cands.length) return { status: 'bad', error: 'Sin resultados en Spotify' };
  const s = cands[0].s;
  const status = s >= 0.8 ? 'ok' : s >= 0.55 ? 'warn' : 'bad';
  return { status: (it.kind === 'yt' && status === 'ok') ? 'warn' : status, track: cands[0].t, score: s, candidates: cands.map(c => c.t) };
}

/* ---------- Playlists ---------- */
async function createPlaylist(userId, name, description, isPublic) {
  return apiPost('/users/' + encodeURIComponent(userId) + '/playlists', { name: String(name).slice(0, 100), description: String(description || '').slice(0, 300), public: !!isPublic });
}
async function updateDetails(playlistId, patch) { return apiPut('/playlists/' + playlistId, patch); }
// Reemplaza TODAS las pistas de la playlist por las indicadas (hasta 100 por llamada).
async function replaceTracks(playlistId, uris) {
  const first = uris.slice(0, 100);
  await apiPut('/playlists/' + playlistId + '/tracks', { uris: first });
  for (let i = 100; i < uris.length; i += 100) await apiPost('/playlists/' + playlistId + '/tracks', { uris: uris.slice(i, i + 100) });
}
async function playlistExists(id) { try { await apiGet('/playlists/' + id + '?fields=id'); return true; } catch (e) { return false; } }
async function unfollowPlaylist(id) { return spFetch('DELETE', '/playlists/' + id + '/followers'); }

module.exports = {
  DEFAULT_CLIENT_ID, SCOPES, getConfig, saveConfig, configured, connected,
  authUrl, exchangeCode, accessToken, disconnect, forceRefresh,
  me, search, getTrack, toItem, resolveItem, score, norm,
  createPlaylist, updateDetails, replaceTracks, playlistExists, unfollowPlaylist,
};
