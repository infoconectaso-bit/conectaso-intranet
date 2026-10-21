'use strict';
/**
 * Volcado (migración) desde la intranet actual (CodeIgniter en intranet.conectaso.es) a esta app.
 * Estrategia: NUESTRO servidor (que tiene salida a internet) lee las fichas de la intranet actual
 * usando la cookie de sesión del admin (pasada desde el navegador) y mapea cada campo a nuestro
 * esquema. Así el dato va servidor->servidor, sin pasar por el navegador ni truncarse, sin perder nada.
 *
 * Endpoint protegido por SECRETO (no por sesión), porque es una operación puntual de migración.
 * Acciones: 'probe' (comprobar que la sesión sirve), más adelante 'dry-run' y 'run'.
 * SEGURIDAD: la cookie llega en el body y NO se registra en logs ni se guarda en disco.
 */
const SRC_BASE = 'https://intranet.conectaso.es';
// Secreto temporal solo para la migración; se retira el endpoint al terminar.
const SECRET = 'vlc_7Kp2Qm9Xr4Tz8Lw_conectaso';

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let d = ''; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('body demasiado grande')); req.destroy(); } else d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

// Trae una URL de la intranet actual con la sesión del admin (cookie + user-agent).
async function srcFetch(path, cookie, ua) {
  const r = await fetch(SRC_BASE + path, {
    headers: { 'cookie': cookie, 'user-agent': ua || 'Mozilla/5.0', 'accept': 'text/html' },
    redirect: 'follow',
  });
  const text = await r.text();
  return { status: r.status, finalUrl: r.url, text };
}

async function handle(req, res, seg, method) {
  if (method !== 'POST') return send(res, 405, { error: 'Método no permitido' });
  let body; try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'Body inválido' }); }
  if (body.secret !== SECRET) return send(res, 403, { error: 'Secreto incorrecto' });
  const action = seg[1] || body.action;
  const cookie = body.cookie || '';
  const ua = body.ua || '';

  if (action === 'probe') {
    // Lee una ficha de evento conocida y comprueba si la sesión está autenticada.
    const id = body.id || 2029;
    try {
      const r = await srcFetch('/admin/events/update/' + id, cookie, ua);
      const authed = /name="wedding_date"/.test(r.text) || /name=['"]dj_vinculated['"]/.test(r.text);
      const isLogin = /name=['"]password['"]/.test(r.text) && /login/i.test(r.finalUrl + r.text.slice(0, 500));
      const title = (r.text.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].trim();
      return send(res, 200, { ok: true, status: r.status, finalUrl: r.finalUrl, authed, isLogin, title, bytes: r.text.length });
    } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }

  return send(res, 404, { error: 'Acción desconocida' });
}

module.exports = { handle, SECRET, SRC_BASE };
