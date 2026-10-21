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
  // Servicios extra: cada FILA (id arbitrario) enlaza tres campos por ese id de fila:
  //   event_service_{fila}   = id del servicio del CATÁLOGO (1-53)  [el VALOR, no el id de fila]
  //   event_user_{fila}      = id del trabajador RESPONSABLE de ese servicio
  //   horas_extras_servicio_{fila} = horas extra de ese servicio
  const svcRows = {};
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
    let sm;
    // servicio del catálogo elegido en esta fila (el VALOR es el id de catálogo)
    if (sm = key.match(/^event_service_(\d+)$/)) { if (v !== '' && v != null) (svcRows[sm[1]] = svcRows[sm[1]] || {}).servicio = +v; continue; }
    // trabajador RESPONSABLE de esta fila de servicio (NO es el titular del evento)
    if (sm = key.match(/^event_user_(\d+)$/)) { if (v !== '' && v != null) (svcRows[sm[1]] = svcRows[sm[1]] || {}).resp = +v || ''; continue; }
    // horas extra de esta fila de servicio
    if (sm = key.match(/^horas_extras_servicio_(\d+)$/)) { if (v !== '' && v != null) (svcRows[sm[1]] = svcRows[sm[1]] || {}).horas = v; continue; }
    // co-titular: el id del cliente está en el VALOR (no en el id de fila)
    if (sm = key.match(/^event_second_user_(\d+)$/)) { if (v && v !== '0' && v !== '') ev.coUsers.push(+v); continue; }
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
  // servicios extra: una entrada por fila con servicio de catálogo, con su responsable y horas.
  ev.services = Object.values(svcRows).filter(r => r.servicio != null && r.servicio !== '').map(r => ({ servicio: +r.servicio, resp: (r.resp == null ? '' : r.resp), resp2: '', horas: (r.horas == null ? '' : r.horas) }));
  // co-titulares únicos
  ev.coUsers = [...new Set(ev.coUsers)];
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

// Página mínima de subida del volcado-seed (mismo origen, sin "mixed content", sin límite de tamaño).
// El secreto lo inyecta el servidor tras validar la query, así no queda escrito en el cliente de serie.
function uploadPage(secret) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Volcado · Conecta Só</title><style>body{font-family:system-ui,Arial,sans-serif;max-width:620px;margin:40px auto;padding:0 16px;color:#1b1b1f}
h1{font-size:20px}.box{border:2px dashed #bbb;border-radius:12px;padding:24px;text-align:center}
button{font-size:16px;padding:12px 20px;border:0;border-radius:10px;background:#0B8043;color:#fff;cursor:pointer;margin-top:14px}
button:disabled{opacity:.5;cursor:default}#log{white-space:pre-wrap;background:#f6f6f8;border-radius:10px;padding:14px;margin-top:18px;font-size:14px;min-height:40px}
.ok{color:#0B8043;font-weight:600}.err{color:#D50000;font-weight:600}</style></head>
<body><h1>Volcado de la intranet → réplica</h1>
<p>Selecciona el archivo <b>volcado-seed.json</b> que te ha pasado Claude y pulsa <b>Importar</b>. Se fusiona sin borrar nada.</p>
<div class="box"><input type="file" id="f" accept="application/json,.json"><br><button id="go" disabled>Importar</button></div>
<div id="log">Esperando archivo…</div>
<script>
var S=${JSON.stringify(secret)},f=document.getElementById('f'),go=document.getElementById('go'),log=document.getElementById('log');
f.onchange=function(){go.disabled=!f.files.length;log.textContent=f.files.length?('Archivo: '+f.files[0].name+' ('+(f.files[0].size/1048576).toFixed(1)+' MB). Pulsa Importar.'):'Esperando archivo…';};
go.onclick=function(){
  if(!f.files.length)return;go.disabled=true;log.textContent='Leyendo archivo…';
  var r=new FileReader();
  r.onload=function(){
    var seed;try{seed=JSON.parse(r.result);}catch(e){log.innerHTML='<span class=err>El archivo no es un JSON válido.</span>';go.disabled=false;return;}
    log.textContent='Importando '+(seed.events?seed.events.length:'?')+' eventos y '+(seed.users?seed.users.length:'?')+' usuarios… (puede tardar unos segundos)';
    fetch('/api/volcado/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:S,seed:seed})})
      .then(function(x){return x.json();})
      .then(function(j){ if(j.ok){log.innerHTML='<span class=ok>✅ Volcado completado.</span>\\n'+JSON.stringify(j.counts,null,2);}else{log.innerHTML='<span class=err>Error: '+(j.error||'desconocido')+'</span>';go.disabled=false;} })
      .catch(function(e){log.innerHTML='<span class=err>Error de red: '+e.message+'</span>';go.disabled=false;});
  };
  r.onerror=function(){log.innerHTML='<span class=err>No se pudo leer el archivo.</span>';go.disabled=false;};
  r.readAsText(f.files[0]);
};
</script></body></html>`;
}

async function handle(req, res, seg, method, url) {
  const action0 = seg[1] || '';
  // GET: página de subida (secreto en la query, validado aquí). url es un objeto URL (WHATWG).
  if (method === 'GET' && action0 === 'upload') {
    const qsec = (url && url.searchParams && url.searchParams.get('secret')) || '';
    if (qsec !== SECRET) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Secreto incorrecto'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(uploadPage(SECRET));
  }
  if (method !== 'POST') return send(res, 405, { error: 'Método no permitido' });
  // el seed del volcado puede pesar ~12 MB
  const limit = (action0 === 'import') ? 48 * 1024 * 1024 : 4 * 1024 * 1024;
  let body; try { body = await readBody(req, limit); } catch (e) { return send(res, 400, { error: 'Body inválido' }); }
  if (body.secret !== SECRET) return send(res, 403, { error: 'Secreto incorrecto' });
  const action = seg[1] || body.action;
  const cookie = body.cookie || ''; const ua = body.ua || '';

  // QA (protegido por secreto): utilidades puntuales para limpiar pruebas y verificar el volcado.
  if (action === 'qa') {
    const dbm = require('./db'); const store = dbm.store, users = dbm.users; const authm = require('./auth');
    const cmd = body.cmd;
    try {
      if (cmd === 'stats') {
        const keepE = new Set(body.keepE || []); const keepU = new Set(body.keepU || []);
        const allE = store.all('events'); const allU = users.all();
        const t0 = Date.now(); store.all('events'); const msAll = Date.now() - t0;
        return send(res, 200, {
          ok: true,
          counts: { events: allE.length, users: allU.length, locations: store.all('locations').length, extras: store.all('extras').length, vehicles: store.all('vehicles').length, tacs: store.all('tacs').length },
          extraEvents: allE.filter(e => !keepE.has(e.id)).map(e => ({ id: e.id, tipo: e.tipo, fecha: e.fecha || '', estado: e.estado, conyuges: (e.conyuges || '').slice(0, 30), dj: e.djId || '', userId: e.userId == null ? null : e.userId })),
          extraUsers: allU.filter(u => !keepU.has(u.id)).map(u => ({ id: u.id, role: u.role, name: (u.name || '').slice(0, 30), email: u.email })),
          msAllEvents: msAll,
        });
      }
      if (cmd === 'inspect') { return send(res, 200, { ok: true, events: (body.ids || []).map(id => store.get('events', +id)) }); }
      if (cmd === 'fakes') { // eventos/usuarios por encima del id real máximo (los que creamos nosotros)
        const evMax = body.evMax || 2726; const uMax = body.uMax || 2078;
        return send(res, 200, { ok: true,
          fakeEvents: store.all('events').filter(e => e.id > evMax).map(e => ({ id: e.id, tipo: e.tipo, fecha: e.fecha || '', conyuges: (e.conyuges || '').slice(0, 30), dj: e.djId || '' })),
          fakeUsers: users.all().filter(u => u.id > uMax).map(u => ({ id: u.id, role: u.role, name: (u.name || '').slice(0, 30), email: u.email })) });
      }
      if (cmd === 'find-users') { // buscar usuarios por nombre/email (para localizar cuentas de Jordi/Dowhile)
        const q = String(body.q || '').toLowerCase();
        return send(res, 200, { ok: true, users: users.all().filter(u => ((u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))).map(u => ({ id: u.id, role: u.role, name: u.name, email: u.email })) });
      }
      if (cmd === 'patch-events') { // corrige services/coUsers/userId de eventos ya importados (fix del bug de mapeo)
        const list = body.patch || []; let n = 0;
        dbm.transaction(() => { list.forEach(p => { const e = store.get('events', +p.id); if (!e) return; if (p.services !== undefined) e.services = p.services; if (p.coUsers !== undefined) e.coUsers = p.coUsers; if (p.userId !== undefined) e.userId = p.userId; store.put('events', e); n++; }); });
        return send(res, 200, { ok: true, patched: n });
      }
      if (cmd === 'years') { // eventos por año (de la fecha)
        const by = {}; store.all('events').forEach(e => { const y = (e.fecha || '').slice(0, 4) || '(sin)'; by[y] = (by[y] || 0) + 1; }); return send(res, 200, { ok: true, years: by });
      }
      if (cmd === 'mkuser') {
        if (authm.passwordProblem(body.password)) return send(res, 200, { ok: false, error: 'pw' });
        const u = users.create({ email: String(body.email).trim(), name: body.name || 'QA', role: body.role || 'user', active: true, data: {} }, authm.hashPassword(body.password));
        return send(res, 200, { ok: true, id: u.id });
      }
      if (cmd === 'delete') {
        const evs = (body.events || []).map(Number); const us = (body.users || []).map(Number);
        let de = 0, du = 0;
        dbm.transaction(() => { evs.forEach(id => { if (store.del('events', id)) de++; }); us.forEach(id => { authm.endAllSessions(id); if (users.del(id)) du++; }); });
        return send(res, 200, { ok: true, deletedEvents: de, deletedUsers: du });
      }
      return send(res, 400, { error: 'cmd desconocido' });
    } catch (e) { return send(res, 200, { ok: false, error: e.message, stack: String(e.stack || '').split('\n').slice(0, 4) }); }
  }

  // IMPORTAR el volcado-seed con MERGE (preserva añadidos, no borra).
  if (action === 'import') {
    const seed = body.seed;
    if (!seed || !Array.isArray(seed.events) || !Array.isArray(seed.users)) return send(res, 400, { error: 'seed inválido' });
    try {
      const dbm = require('./db');
      const imp = require('./volcado-import');
      const counts = imp.run(seed, { store: dbm.store, users: dbm.users, transaction: dbm.transaction });
      return send(res, 200, { ok: true, counts });
    } catch (e) { return send(res, 200, { ok: false, error: e.message, stack: String(e.stack || '').split('\n').slice(0, 4) }); }
  }

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

// Normaliza fechas a ISO YYYY-MM-DD desde DD/MM/YYYY, YYYY/MM/DD o ISO.
function normDate(s) {
  s = String(s || '').trim(); if (!s) return '';
  let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})[/-](\d{2})[/-](\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s;
}

/** Vehículo real -> nuestro esquema (casi 1:1). */
function mapVehicle(raw) {
  return {
    id: +raw.vehicle_id || +raw.__id || undefined,
    license_plate: raw.license_plate || '', brand: raw.brand || '', model: raw.model || '', color: raw.color || '',
    itvDate: normDate(raw.itvDate || raw.itv), insuranceRenewal: normDate(raw.insuranceRenewal || raw.insurance_renewal),
    observations: raw.observations || '',
  };
}

/** Localización real -> nuestro esquema. MERGE conserva nuestros planos (se guardan aparte). */
function mapLocation(raw) {
  return {
    id: +raw.location_id || +raw.__id || undefined,
    name: raw.name || '', direction: raw.direction || '', directionLink: raw.directionLink || '',
    responsable: raw.responsable || '', phone: raw.phone || '', colorHex: raw.colorHex || '', comments: raw.comments || '',
    weddingPrice: raw.weddingPrice || '', eventPrice: raw.eventPrice || '', extraPrice: raw.extraPrice || '', ceremonyPrice: raw.ceremonyPrice || '',
  };
}

/** Extra real -> nuestro esquema. */
function mapExtra(raw) {
  return { id: +raw.service_id || +raw.extra_id || +raw.__id || undefined, name: raw.name || '', allows_overtime: truthy(raw.allows_overtime) };
}

/** Usuario real -> nuestro esquema (shape del seed + pricing de DJ, que el seed original no traía). */
function mapUser(raw) {
  const roleRaw = raw.role__text || raw.role || 'user';
  const role = ['admin', 'dj', 'planner', 'user'].includes(String(roleRaw).toLowerCase()) ? String(roleRaw).toLowerCase() : 'user';
  const prices = {};
  ['recomendado', 'fiesta', 'bodorrio', 'tinglado', 'fiesta_precio_extra', 'bodorrio_precio_extra', 'tinglado_precio_extra',
    'precio_dos_serv_ext_dia', 'precio_tres_serv_ext_dia', 'precio_varios_serv_ext_dia'].forEach(k => { if (raw[k] !== undefined && raw[k] !== '') prices[k] = raw[k]; });
  if (truthy(raw.checkbox_serv_ext_dia)) prices.checkbox_serv_ext_dia = true;
  // Precios por finca (djFincas) y por servicio (djServices): se extraen de los campos numerados.
  const djFincas = [], djServices = [];
  for (const key of Object.keys(raw)) {
    let m = key.match(/^location_(\d+)$/); if (m && raw[key]) { const i = m[1]; djFincas.push({ l: +raw['location_' + i] || +i, b: raw['precio_boda_' + i] || '', e: raw['precio_evento_' + i] || '', h: raw['precio_hora_extra_' + i] || '', d: raw['precio_discomovil_' + i] || '', c: raw['precio_ceremonia_' + i] || '' }); continue; }
    m = key.match(/^extra_service_(\d+)$/); if (m && raw[key]) { const i = m[1]; djServices.push({ s: +raw['extra_service_' + i] || +i, p: raw['extra_price_' + i] || '', h: raw['extra_price_extra_' + i] || '' }); }
  }
  const u = {
    id: +raw.__id || undefined, role, mail: raw.mail || '', name: raw.name || '',
    tyc: truthy(raw.tyc), sending: raw.sending || 'Si', worker_type: +raw.worker_type || 0,
    color: raw.color || '', vehicle_allowed: truthy(raw.vehicle_allowed), prices,
  };
  if (djFincas.length) u.djFincas = djFincas;
  if (djServices.length) u.djServices = djServices;
  return u;
}

module.exports = { handle, mapEvent, mapVehicle, mapLocation, mapExtra, mapUser, normDate, SECRET, SRC_BASE, ESTADO_MAP };
