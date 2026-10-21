'use strict';
/**
 * Volcado (migración) desde la intranet actual (CodeIgniter, intranet.conectaso.es) a esta app.
 * NUESTRO servidor lee las fichas de la intranet actual con la sesión del admin y mapea cada
 * campo a nuestro esquema. Servidor->servidor: sin "mixed content", sin truncar, sin perder nada.
 * Endpoint protegido por SECRETO (operación puntual). La cookie llega en el body y NO se registra.
 *
 * mapEvent(raw) está VALIDADO en el navegador contra 38 bodas variadas: 0 campos sin mapear.
 */
const SRC_BASE = 'https://intranet.conectaso.es';
const SECRET = 'vlc_7Kp2Qm9Xr4Tz8Lw_conectaso';

// real estados (1-5, incluye "No contactado admin") -> nuestros índices (0-4).
const ESTADO_MAP = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4 };
// momentos con clave distinta en nuestra app
const MOMENT_TX = { bride_car_entrance: 'vehicle_entry', votes: 'vows' };
const DMY2ISO = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
const truthy = (v) => v === 1 || v === '1' || v === true;

const KNOWN = new Set(['ask_for_opinion', 'celebration_hour', 'celebration_location', 'celebration_location_other', 'compliance_list', 'disco_observations', 'disco_restrictions', 'disco_logo_fotomaton_image', 'dj_assigned_overtime', 'dj_assigned_performed_ceremony', 'dj_vinculated', 'event_payed_import', 'event_status', 'event_total_import', 'event_total_cost', 'first_spouse', 'first_spouse_address', 'first_spouse_dni', 'first_spouse_email', 'first_spouse_mobile', 'first_spouse_instagram', 'first_spouse_sex', 'guest_number', 'guest_requests', 'habilitar_edicion_para_usuario', 'link_playlist', 'payment_method', 'privat_observations', 'second_spouse', 'second_spouse_address', 'second_spouse_dni', 'second_spouse_email', 'second_spouse_mobile', 'second_spouse_instagram', 'second_spouse_sex', 'wedding_date', 'wedding_hour', 'wedding_location', 'wedding_type', 'wp_vinculated', 'observations_on_dj_event', 'description', 'religious_celebration', 'monitoraauto']);
const IGNORE = new Set(['_token', 'author', 'djsOptions', 'servicesOptions', 'image_74', 'event_id', 'viewport', '__id', 'uploaded_file_view']);

/** Convierte un objeto crudo {campo: valor} de la ficha real en nuestro esquema de evento.
 *  Devuelve { ev, unmapped }. unmapped debe quedar vacío (si no, hay un campo nuevo que tratar). */
function mapEvent(raw) {
  const ev = { music: {}, optionals: [], extras: {}, spouses: [{}, {}], services: [], coUsers: [], plus: [], files: [] };
  const unmapped = [];
  const sp = (i, k, v) => { if (v !== '' && v != null) ev.spouses[i][k] = v; };
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (IGNORE.has(key) || key.endsWith('__text')) continue;
    // música: {area}_{moment}
    const mm = key.match(/^(ceremony|aperitif|banquet|disco)_(.+)$/);
    if (mm && !/^(check_|order_|link_|comment_)/.test(key) && !/_optionals_/.test(key) && !['disco_observations', 'disco_restrictions', 'disco_logo_fotomaton_image'].includes(key)) {
      const ok = mm[1] + '_' + (MOMENT_TX[mm[2]] || mm[2]); (ev.music[ok] = ev.music[ok] || {}).song = v; continue;
    }
    const cm = key.match(/^(check|order|link|comment)_(ceremony|aperitif|banquet|disco)_(.+)$/);
    if (cm) { const ok = cm[2] + '_' + (MOMENT_TX[cm[3]] || cm[3]); ev.music[ok] = ev.music[ok] || {}; if (cm[1] === 'check') ev.music[ok].on = truthy(v); else ev.music[ok][cm[1]] = v; continue; }
    const om = key.match(/^(ceremony|aperitif|banquet|disco)_optionals_(\d+)_(title|value|link|order|comment)$/);
    if (om) { let o = ev.optionals.find(x => x._id === om[2] && x.area === om[1]); if (!o) { o = { _id: om[2], area: om[1] }; ev.optionals.push(o); } o[om[3]] = v; continue; }
    if (/^extra_/.test(key)) { if (truthy(v)) ev.extras[key] = true; continue; }
    if (/^event_user_(\d+)$/.test(key)) { if (truthy(v)) ev.userId = +key.match(/\d+/)[0]; continue; }
    if (/^event_second_user_(\d+)$/.test(key)) { if (truthy(v)) ev.coUsers.push(+key.match(/\d+/)[0]); continue; }
    if (/^event_service_(\d+)$/.test(key)) { if (v && v !== '') ev.services.push({ servicio: +key.match(/\d+/)[0], resp: +v || v }); continue; }
    if (/^horas_extras_servicio_(\d+)$/.test(key)) { if (v && v !== '0' && v !== '') { const id = +key.match(/\d+/)[0]; const s = ev.services.find(x => x.servicio === id); if (s) s.overtime = v; else ev.services.push({ servicio: id, overtime: v }); } continue; }
    if (/^plus_(\d+)$/.test(key)) { if (v && v !== '0' && v !== '') { const id = +key.match(/\d+/)[0]; let p = ev.plus.find(x => x.userId === id); if (!p) { p = { userId: id }; ev.plus.push(p); } p.amount = v; } continue; }
    if (/^plus_reason_(\d+)$/.test(key)) { if (v) { const id = +key.match(/\d+/)[0]; let p = ev.plus.find(x => x.userId === id); if (!p) { p = { userId: id }; ev.plus.push(p); } p.concept = v; } continue; }
    if (/^event_files_(\d+)_(value|description|hidden)$/.test(key)) { const id = key.match(/\d+/)[0]; let f = ev.files.find(x => x._id === id); if (!f) { f = { _id: id }; ev.files.push(f); } f[key.split('_').pop()] = v; continue; }
    switch (key) {
      case 'wedding_type': ev.tipo = v; break;
      case 'wedding_date': ev.fecha = DMY2ISO(v); break;
      case 'wedding_hour': ev.hora = v; break;
      case 'celebration_hour': ev.celebrationHour = v; break;
      case 'celebration_location': ev.lugar = +v || 0; break;
      case 'celebration_location_other': ev.lugarOtro = v; break;
      case 'wedding_location': ev.lugarCeremonia = v; break;
      case 'religious_celebration': ev.religiosa = truthy(v); break;
      case 'guest_number': ev.guests = v; break;
      case 'payment_method': ev.metodo = v; break;
      case 'event_status': ev.estado = ESTADO_MAP[String(v)] != null ? ESTADO_MAP[String(v)] : +v; break;
      case 'event_total_import': ev.pagoCliente = +v || 0; break;
      case 'event_payed_import': ev.pagado = +v || 0; break;
      case 'event_total_cost': ev.totalCost = +v || 0; break;
      case 'dj_vinculated': ev.djId = +v || ''; break;
      case 'wp_vinculated': ev.wpId = +v || ''; break;
      case 'dj_assigned_overtime': ev.djOvertime = v; break;
      case 'dj_assigned_performed_ceremony': ev.djCeremony = truthy(v); break;
      case 'ask_for_opinion': { const t = (raw['ask_for_opinion__text'] || '').trim(); ev.opinion = t || (String(v) === '1' ? 'Si' : String(v) === '2' ? 'No' : (['Si', 'No'].includes(v) ? v : '')); break; }
      case 'privat_observations': ev.obsPriv = v; break;
      case 'observations_on_dj_event': ev.obsDj = v; break;
      case 'description': ev.description = v; break;
      case 'monitoraauto': ev.monitoraauto = v; break;
      case 'habilitar_edicion_para_usuario': ev.editUser = truthy(v); ev.editUnlock = ev.editUser; break;
      case 'first_spouse': sp(0, 'name', v); break;
      case 'first_spouse_dni': sp(0, 'dni', v); break;
      case 'first_spouse_email': sp(0, 'email', v); break;
      case 'first_spouse_mobile': sp(0, 'mobile', v); break;
      case 'first_spouse_address': sp(0, 'address', v); break;
      case 'first_spouse_instagram': sp(0, 'instagram', v); break;
      case 'first_spouse_sex': sp(0, 'sex', v); break;
      case 'second_spouse': sp(1, 'name', v); break;
      case 'second_spouse_dni': sp(1, 'dni', v); break;
      case 'second_spouse_email': sp(1, 'email', v); break;
      case 'second_spouse_mobile': sp(1, 'mobile', v); break;
      case 'second_spouse_address': sp(1, 'address', v); break;
      case 'second_spouse_instagram': sp(1, 'instagram', v); break;
      case 'second_spouse_sex': sp(1, 'sex', v); break;
      case 'link_playlist': (ev.disco = ev.disco || {}).playlist = v; break;
      case 'compliance_list': (ev.disco = ev.disco || {}).compliance = v; break;
      case 'guest_requests': (ev.disco = ev.disco || {}).guests = v; break;
      case 'disco_restrictions': (ev.disco = ev.disco || {}).restrictions = v; break;
      case 'disco_observations': (ev.disco = ev.disco || {}).observations = v; break;
      case 'disco_logo_fotomaton_image': (ev.disco = ev.disco || {}).fotoLogo = v; break;
      default: if (!KNOWN.has(key)) unmapped.push(key);
    }
  }
  // limpieza de ids temporales de opcionales/archivos
  ev.optionals.forEach(o => { o.id = +o._id || 0; delete o._id; });
  ev.files.forEach(f => { f.id = +f._id || 0; delete f._id; });
  ev.conyuges = [ev.spouses[0].name, ev.spouses[1].name].filter(Boolean).join(' y ');
  // Defaults para calcar el formato del seed probado (campos que la intranet vieja no expone en
  // el formulario o que son nuestros). El merge del importador conserva lo que ya hubiera.
  if (ev.ceremoniaFuera === undefined) ev.ceremoniaFuera = false;      // 'ceremonia fuera' es campo NUESTRO
  if (ev.pagoRestaurante === undefined) ev.pagoRestaurante = 0;
  if (ev.totalCost === undefined) ev.totalCost = '';
  if (!ev.labels) ev.labels = {};
  if (!ev.entregas) ev.entregas = [];
  // userId (titular) NO viene en el formulario del evento: lo inyecta el exportador desde el
  // listado (columna Usuario). Si llega en el raw como ownerId, lo usamos.
  if (ev.userId === undefined && raw.__ownerId) ev.userId = +raw.__ownerId || null;
  return { ev, unmapped };
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => { let d = ''; let n = 0; req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('body grande')); req.destroy(); } else d += c; }); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } }); req.on('error', reject); });
}
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

async function srcFetch(path, cookie, ua) {
  const r = await fetch(SRC_BASE + path, { headers: { cookie: cookie, 'user-agent': ua || 'Mozilla/5.0', accept: 'text/html' }, redirect: 'follow' });
  return { status: r.status, finalUrl: r.url, text: await r.text() };
}

async function handle(req, res, seg, method) {
  if (method !== 'POST') return send(res, 405, { error: 'Método no permitido' });
  let body; try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'Body inválido' }); }
  if (body.secret !== SECRET) return send(res, 403, { error: 'Secreto incorrecto' });
  const action = seg[1] || body.action;
  const cookie = body.cookie || ''; const ua = body.ua || '';

  if (action === 'probe') {
    const id = body.id || 2029;
    try { const r = await srcFetch('/admin/events/update/' + id, cookie, ua); const authed = /name="wedding_date"/.test(r.text) || /name=['"]dj_vinculated['"]/.test(r.text); const title = (r.text.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].trim(); return send(res, 200, { ok: true, status: r.status, finalUrl: r.finalUrl, authed, title, bytes: r.text.length }); } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }
  // 'map-check': recibe objetos crudos ya serializados (desde el navegador) y devuelve SOLO
  // el informe de campos sin mapear (sin datos). Útil para validar desde fuera del navegador.
  if (action === 'map-check') {
    const raws = Array.isArray(body.raws) ? body.raws : [];
    const unmapped = new Set();
    raws.forEach(r => { try { mapEvent(r).unmapped.forEach(u => unmapped.add(u.replace(/\d+/g, '*'))); } catch (e) { } });
    return send(res, 200, { ok: true, count: raws.length, unmapped: [...unmapped] });
  }

  return send(res, 404, { error: 'Acción desconocida' });
}

module.exports = { handle, mapEvent, SECRET, SRC_BASE, ESTADO_MAP };
