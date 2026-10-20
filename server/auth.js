'use strict';
/** Contraseñas (scrypt), sesiones con cookie httpOnly, enlaces de invitación/restablecimiento y límite de intentos. */
const crypto = require('crypto');
const { db, users } = require('./db');

const SESSION_DAYS = +(process.env.SESSION_DAYS || 14);
const COOKIE = 'cs_session';
const SECURE_COOKIE = (process.env.COOKIE_SECURE || 'auto');

/* ---------- contraseñas ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, N, r, p, saltB64, keyB64] = stored.split('$');
  const key = Buffer.from(keyB64, 'base64');
  const test = crypto.scryptSync(String(pw), Buffer.from(saltB64, 'base64'), key.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(key, test);
}
function passwordProblem(pw) {
  pw = String(pw || '');
  if (pw.length < 10) return 'La contraseña debe tener al menos 10 caracteres.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'La contraseña debe combinar letras y números.';
  return null;
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- sesiones ---------- */
const st = {
  ins: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, ip) VALUES (?, ?, ?, ?, ?)'),
  get: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
  del: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  delUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  tokIns: db.prepare('INSERT INTO tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)'),
  tokGet: db.prepare('SELECT * FROM tokens WHERE token_hash = ?'),
  tokUse: db.prepare('UPDATE tokens SET used_at = ? WHERE token_hash = ?'),
  tokDelUser: db.prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ? AND used_at IS NULL'),
};

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function isSecure(req) {
  if (SECURE_COOKIE === 'true') return true;
  if (SECURE_COOKIE === 'false') return false;
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}
function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  st.ins.run(sha(token), userId, now + SESSION_DAYS * 864e5, now, clientIp(req));
  st.purge.run(now);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isSecure(req) ? '; Secure' : ''}`);
}
function destroySession(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) st.del.run(sha(t));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? '; Secure' : ''}`);
}
/** Devuelve el usuario de la sesión o null. */
function sessionUser(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const s = st.get.get(sha(t));
  if (!s || s.expires_at < Date.now()) return null;
  const row = users.getRow(s.user_id);
  if (!row || !row.active) return null;
  return users.get(row.id);
}
const endAllSessions = uid => st.delUser.run(uid);

/* ---------- enlaces de invitación / restablecimiento ---------- */
function createToken(userId, kind) {
  st.tokDelUser.run(userId, kind);
  const token = crypto.randomBytes(24).toString('base64url');
  const days = kind === 'invite' ? 14 : 1;
  st.tokIns.run(sha(token), userId, kind, Date.now() + days * 864e5);
  return token;
}
function checkToken(token) {
  const t = st.tokGet.get(sha(String(token || '')));
  if (!t || t.used_at || t.expires_at < Date.now()) return null;
  return t;
}
const useToken = token => st.tokUse.run(Date.now(), sha(String(token)));

/* ---------- límite de intentos (en memoria) ---------- */
const attempts = new Map();
function clientIp(req) {
  const xf = process.env.TRUST_PROXY === 'true' ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return xf || req.socket.remoteAddress || '';
}
function rateLimited(key, max = 8, windowMs = 15 * 60e3) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter(t => now - t < windowMs);
  attempts.set(key, a);
  return a.length >= max;
}
function noteAttempt(key) { const a = attempts.get(key) || []; a.push(Date.now()); attempts.set(key, a); }
function clearAttempts(key) { attempts.delete(key); }

module.exports = { hashPassword, verifyPassword, passwordProblem, createSession, destroySession, sessionUser, endAllSessions,
  createToken, checkToken, useToken, rateLimited, noteAttempt, clearAttempts, clientIp, parseCookies };
