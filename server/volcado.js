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
const IGNORE = new Set(['_token', 'author', 'djsOptions', 'servicesOptions', 'image_74', 'event_id', 'viewport', '__id', '__files', 'uploaded_file_view']);

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
      case 'dj_assigned_overtime': { const t = (raw['dj_assigned_overtime__text'] || '').trim(); ev.djOvertime = (!t || /^Selecciona/i.test(t)) ? '' : t; break; }
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

  // MIGRAR ARCHIVOS: descarga los ficheros de la intranet (/public/uploads/{id}/files/*) y los
  // guarda en la réplica (tabla files + disco). Server->server con la cookie del admin.
  if (action === 'migrate-files') {
    const dbm = require('./db'); const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
    const UP = path.join(dbm.DATA_DIR, 'uploads');
    const ids = (body.ids || []).map(Number);
    const uploadedBy = +body.adminId || null;
    const MAXB = 120 * 1024 * 1024; // tope por archivo 120MB
    const safe = n => String(n || 'archivo').normalize('NFKD').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'archivo';
    const mimeOf = n => ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp3: 'audio/mpeg', mp4: 'video/mp4', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }[(n.split('.').pop() || '').toLowerCase()] || 'application/octet-stream');
    const existsStmt = dbm.db.prepare('SELECT COUNT(*) AS n FROM files WHERE collection = ? AND record_id = ? AND name = ?');
    const insStmt = dbm.db.prepare('INSERT INTO files (id, collection, record_id, name, description, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const out = [];
    for (const id of ids) {
      const rep = { id, files: [], skipped: [], errors: [] };
      try {
        let items; // [{name, momento}]
        const provided = (body.fileMap || {})[id] || (body.fileMap || {})[String(id)];
        if (provided) { items = provided.map(x => (typeof x === 'string') ? { name: decodeURIComponent(x), momento: '' } : { name: decodeURIComponent(String(x.name)), momento: String(x.momento || '') }); }
        else { // si no se pasa la lista, se saca del HTML de la ficha (requiere cookie)
          const page = await srcFetch('/admin/events/update/' + id, cookie, ua);
          const re = new RegExp('/public/uploads/' + id + '/files/([^"\'\\s>]+)', 'g');
          items = [...new Set([...page.text.matchAll(re)].map(m => decodeURIComponent(m[1])))].map(n => ({ name: n, momento: '' }));
        }
        const seenN = {}; items = items.filter(it => it.name && !seenN[it.name] && (seenN[it.name] = 1));
        for (const it of items) {
          const name = it.name;
          try {
            if (existsStmt.get('events', id, name).n > 0) { rep.skipped.push(name); continue; }
            const url = SRC_BASE + '/public/uploads/' + id + '/files/' + encodeURIComponent(name);
            const r = await fetch(url, { headers: { cookie, 'user-agent': ua || 'Mozilla/5.0' } });
            if (!r.ok) { rep.errors.push(name + ' (http ' + r.status + ')'); continue; }
            const buf = Buffer.from(await r.arrayBuffer());
            if (!buf.length) { rep.errors.push(name + ' (vacío)'); continue; }
            if (buf.length > MAXB) { rep.errors.push(name + ' (demasiado grande ' + Math.round(buf.length / 1048576) + 'MB)'); continue; }
            const fid = crypto.randomBytes(12).toString('hex');
            const dir = path.join(UP, 'boda-' + id); fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, fid + '-' + safe(name)), buf);
            insStmt.run(fid, 'events', id, name, it.momento || '', mimeOf(name), buf.length, uploadedBy);
            rep.files.push({ name, momento: it.momento || '', size: buf.length });
          } catch (e) { rep.errors.push(name + ' (' + e.message + ')'); }
        }
      } catch (e) { rep.errors.push('PAGE: ' + e.message); }
      out.push(rep);
    }
    return send(res, 200, { ok: true, results: out });
  }

  // Migrar los logos de fotomatón: descarga cada logo de /public/uploads/{id}/{fn} (público) y lo
  // guarda en la tabla files (colección 'events'), dejando ev.disco.fotoLogo = /api/files/{fid}
  // para que se muestre en la ficha. Idempotente: si ya apunta a /api/files/ no se repite.
  if (action === 'migrate-fotologos') {
    const dbm = require('./db'); const store = dbm.store; const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
    const UP = path.join(dbm.DATA_DIR, 'uploads');
    const MAXB = 20 * 1024 * 1024;
    const safe = n => String(n || 'logo').normalize('NFKD').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'logo';
    const mimeOf = n => ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[(n.split('.').pop() || '').toLowerCase()] || 'application/octet-stream');
    const insStmt = dbm.db.prepare('INSERT INTO files (id, collection, record_id, name, description, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const logos = body.logos || []; // [{id, fn}]
    let done = 0, skipped = 0; const errors = [];
    for (const it of logos) {
      const id = +it.id, fn = String(it.fn || '');
      try {
        const ev = store.get('events', id);
        if (!ev) { errors.push(id + ' (evento no existe)'); continue; }
        if (ev.disco && typeof ev.disco.fotoLogo === 'string' && ev.disco.fotoLogo.indexOf('/api/files/') === 0) { skipped++; continue; }
        const url = SRC_BASE + '/public/uploads/' + id + '/' + encodeURIComponent(fn);
        const r = await fetch(url);
        if (!r.ok) { errors.push(id + ' (http ' + r.status + ')'); continue; }
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length || buf.length > MAXB) { errors.push(id + ' (tamaño ' + buf.length + ')'); continue; }
        const ext = (fn.split('.').pop() || 'png').toLowerCase();
        const name = 'Logo fotomatón.' + ext;
        const fid = crypto.randomBytes(12).toString('hex');
        const dir = path.join(UP, 'boda-' + id); fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, fid + '-' + safe(name)), buf);
        insStmt.run(fid, 'events', id, name, 'Logo fotomatón', mimeOf(fn), buf.length, +body.adminId || null);
        ev.disco = ev.disco || {}; ev.disco.fotoLogo = '/api/files/' + fid;
        store.put('events', ev);
        done++;
      } catch (e) { errors.push(id + ' (' + e.message + ')'); }
    }
    return send(res, 200, { ok: true, done, skipped, errors });
  }

  // ============ REFRESCO (recorrido en el navegador -> servidor) ============
  // El navegador, con la sesión abierta en la intranet real, lee cada ficha CRUDA y la envía por
  // lotes a /ingest (no-cors, text/plain). El servidor las acumula en un staging y luego las mapea
  // con el mismo mapEvent validado, compara con la réplica y, con el OK, importa con MERGE. Así los
  // datos personales van de servidor a servidor y nunca pasan por el canal de herramientas.
  {
    const path = require('path'); const fs = require('fs');
    const dbm0 = require('./db');
    const STAGE = path.join(dbm0.DATA_DIR, 'volcado-refresh.ndjson');
    const FILEMAP = path.join(dbm0.DATA_DIR, 'volcado-refresh-files.json');

    if (action === 'ingest-reset') { try { fs.writeFileSync(STAGE, ''); } catch (e) { } return send(res, 200, { ok: true, count: 0 }); }

    if (action === 'ingest') {
      const batch = Array.isArray(body.batch) ? body.batch : [];
      let out = ''; for (const r of batch) { try { out += JSON.stringify(r) + '\n'; } catch (e) { } }
      try { fs.appendFileSync(STAGE, out); } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      return send(res, 200, { ok: true, added: batch.length });
    }

    if (action === 'ingest-status') {
      let n = 0, bytes = 0; try { const s = fs.readFileSync(STAGE, 'utf8'); n = s ? s.split('\n').filter(Boolean).length : 0; bytes = Buffer.byteLength(s); } catch (e) { }
      return send(res, 200, { ok: true, count: n, bytes });
    }

    if (action === 'refresh') {
      const store = dbm0.store, users = dbm0.users;
      const TODAY = require('./time').bizToday();
      const mode = body.mode || 'diff';
      let raws;
      try { raws = fs.readFileSync(STAGE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
      catch (e) { return send(res, 200, { ok: false, error: 'staging: ' + e.message }); }
      // email -> uid (para recuperar titular de eventos NUEVOS; normaliza el +uID de deduplicados)
      const emailToUid = {};
      (users.all() || []).forEach(u => { if (u.email) { const k = String(u.email).toLowerCase().replace(/\+u\d+@/, '@'); if (!(k in emailToUid)) emailToUid[k] = u.id; } });
      const hasContent = (e) => {
        if (e.conyuges && e.conyuges.trim().length > 2) return true;
        if (e.music && Object.values(e.music).some(m => m && m.song && String(m.song).trim())) return true;
        if (e.services && e.services.length) return true;
        if (e.extras && Object.keys(e.extras).length) return true;
        if (e.optionals && e.optionals.some(o => (o.title && String(o.title).trim()) || (o.value && String(o.value).trim()))) return true;
        if (+e.pagoCliente > 1 || +e.pagado > 1) return true;
        if ((e.obsPriv && e.obsPriv.trim()) || (e.obsDj && e.obsDj.trim())) return true;
        if (e.disco && Object.values(e.disco).some(v => v && String(v).trim())) return true;
        if (e.files && e.files.length) return true;
        if (e.description && e.description.trim()) return true;
        return false;
      };
      const DIFF = ['fecha', 'hora', 'estado', 'pagado', 'pagoCliente', 'totalCost', 'metodo', 'djId', 'wpId'];
      const S = v => String(v == null ? '' : v);
      const unmapped = new Set();
      const built = []; const fileMap = {};
      const nuevos = [], nuevosPasados = [], descartados = [], cambios = [];
      const seenIds = new Set();
      for (const raw of raws) {
        let m; try { m = mapEvent(raw); } catch (e) { continue; }
        const ev = m.ev; ev.id = +raw.__id; if (!ev.id || seenIds.has(ev.id)) continue; seenIds.add(ev.id);
        m.unmapped.forEach(u => unmapped.add(u));
        if (Array.isArray(raw.__files) && raw.__files.length) fileMap[ev.id] = raw.__files;
        const prev = store.get('events', ev.id);
        if (!prev) {
          for (const em of [raw.first_spouse_email, raw.second_spouse_email]) { const k = (em || '').trim().toLowerCase(); if (k && emailToUid[k]) { ev.userId = emailToUid[k]; break; } }
          const f = ev.fecha, est = ev.estado;
          if (f && f >= TODAY) { nuevos.push({ id: ev.id, fecha: f, estado: est, conyuges: (ev.conyuges || '').slice(0, 36), pagado: ev.pagado, pagoCliente: ev.pagoCliente }); built.push(ev); }
          else if (!f && est >= 1 && est <= 4 && hasContent(ev)) { nuevos.push({ id: ev.id, fecha: '', estado: est, conyuges: (ev.conyuges || '').slice(0, 36), pagado: ev.pagado, pagoCliente: ev.pagoCliente }); built.push(ev); }
          else if (f && f < TODAY && hasContent(ev)) { nuevosPasados.push({ id: ev.id, fecha: f, estado: est, conyuges: (ev.conyuges || '').slice(0, 36), pagado: ev.pagado, pagoCliente: ev.pagoCliente }); } // NO se importan: se enseñan para decidir
          else { descartados.push({ id: ev.id, fecha: f || '', estado: est, conyuges: (ev.conyuges || '').slice(0, 36) }); }
        } else {
          const ch = {};
          DIFF.forEach(k => { if (S(prev[k]) !== S(ev[k])) ch[k] = { de: S(prev[k]), a: S(ev[k]) }; });
          if (Object.keys(ch).length) cambios.push({ id: ev.id, conyuges: (ev.conyuges || prev.conyuges || '').slice(0, 36), fecha: ev.fecha || prev.fecha || '', ch });
          built.push(ev);
        }
      }
      // eventos que YA están en la réplica pero NO aparecieron en el recorrido (no se tocan; se informan)
      const noVistos = [];
      store.all('events').forEach(e => { if (!seenIds.has(e.id)) noVistos.push({ id: e.id, fecha: e.fecha || '', conyuges: (e.conyuges || '').slice(0, 36) }); });
      const summary = {
        staged: raws.length, aImportar: built.length,
        existentesConCambios: cambios.length, nuevosMantenidos: nuevos.length,
        nuevosPasadosParaRevisar: nuevosPasados.length, nuevosDescartadosVacios: descartados.length,
        enReplicaNoVistos: noVistos.length, conAdjuntos: Object.keys(fileMap).length,
        unmapped: [...unmapped],
        cambios: cambios.slice(0, 100), nuevos: nuevos.slice(0, 100), nuevosPasados: nuevosPasados.slice(0, 60), noVistos: noVistos.slice(0, 60), descartados: descartados.slice(0, 40),
      };
      if (mode === 'diff') { try { fs.writeFileSync(FILEMAP, JSON.stringify(fileMap)); } catch (e) { } return send(res, 200, { ok: true, mode, summary }); }
      if (mode === 'import') {
        const seed = { type: 'volcado-refresh', events: built, users: [], locations: [], vehicles: [], extras: [], tacs: [], staffIds: store.setting('staffIds') || [], beneficios: store.setting('beneficios') || null };
        const counts = require('./volcado-import').run(seed, { store, users, transaction: dbm0.transaction });
        try { fs.writeFileSync(FILEMAP, JSON.stringify(fileMap)); } catch (e) { }
        return send(res, 200, { ok: true, mode, counts, summary });
      }
      return send(res, 400, { error: 'mode? (diff|import)' });
    }

    if (action === 'refresh-attachments') {
      const crypto = require('crypto');
      const UP = path.join(dbm0.DATA_DIR, 'uploads');
      let fileMap = {}; try { fileMap = JSON.parse(fs.readFileSync(FILEMAP, 'utf8')); } catch (e) { return send(res, 200, { ok: false, error: 'sin fileMap (ejecuta refresh antes)' }); }
      const MAXB = 120 * 1024 * 1024;
      const safe = n => String(n || 'archivo').normalize('NFKD').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'archivo';
      const mimeOf = n => ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp3: 'audio/mpeg', mp4: 'video/mp4', mov: 'video/quicktime', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }[(n.split('.').pop() || '').toLowerCase()] || 'application/octet-stream');
      const existsStmt = dbm0.db.prepare('SELECT COUNT(*) AS n FROM files WHERE collection = ? AND record_id = ? AND name = ?');
      const insStmt = dbm0.db.prepare('INSERT INTO files (id, collection, record_id, name, description, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const uploadedBy = +body.adminId || null;
      const only = body.ids ? new Set(body.ids.map(Number)) : null;
      let traidos = 0, saltados = 0, fallos = 0; const errs = [];
      const ids = Object.keys(fileMap).map(Number).filter(id => !only || only.has(id));
      for (const id of ids) {
        for (const nameRaw of (fileMap[id] || [])) {
          const name = decodeURIComponent(String(nameRaw));
          try {
            if (existsStmt.get('events', id, name).n > 0) { saltados++; continue; }
            const r = await fetch(SRC_BASE + '/public/uploads/' + id + '/files/' + encodeURIComponent(name));
            if (!r.ok) { fallos++; if (errs.length < 25) errs.push(id + '/' + name + ' http ' + r.status); continue; }
            const buf = Buffer.from(await r.arrayBuffer());
            if (!buf.length || buf.length > MAXB) { fallos++; if (errs.length < 25) errs.push(id + '/' + name + ' tam ' + buf.length); continue; }
            const fid = crypto.randomBytes(12).toString('hex');
            const dir = path.join(UP, 'boda-' + id); fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, fid + '-' + safe(name)), buf);
            insStmt.run(fid, 'events', id, name, '', mimeOf(name), buf.length, uploadedBy);
            traidos++;
          } catch (e) { fallos++; if (errs.length < 25) errs.push(id + '/' + name + ' ' + e.message); }
        }
      }
      return send(res, 200, { ok: true, traidos, saltados, fallos, eventos: ids.length, errs });
    }
  }

  // RECOLOCAR momentos personalizados en su sección real, leyendo cada ficha original.
  // El volcado guardó TODOS los optionals como 'ceremony'; la sección verdadera viene de la
  // POSICIÓN del campo en el formulario original (los personalizados se renderizan dentro de
  // la sección a la que pertenecen, aunque el nombre del campo sea ceremony_optionals_).
  // Empareja por id de optional (se conservó en la réplica). Body: { ids, cookie, ua }.
  if (action === 'resection-optionals') {
    const dbm = require('./db'); const store = dbm.store;
    const ids = (body.ids || []).map(Number);
    const SM = { ceremony: 'C', aperitif: 'A', banquet: 'B', disco: 'D' };
    const AREA = { C: 'ceremony', A: 'aperitif', B: 'banquet', D: 'disco' };
    const sectionsFromHtml = (html) => {
      const names = (html.match(/name=["'][^"']+["']/g) || []).map(s => s.slice(6, -1));
      const out = {}; let curSec = null; const idx = {};
      for (const n of names) {
        let m;
        if ((m = n.match(/^(ceremony|aperitif|banquet|disco)_([a-z_]+)$/)) && !/_optionals_|^(check|order|link|comment)_/.test(n) && !/_(restrictions|observations|logo_fotomaton_image|logo_fotomato|logo)/.test(n)) {
          curSec = SM[m[1]]; idx[curSec] = (idx[curSec] || 0) + 1;
        } else if (m = n.match(/^(ceremony|aperitif|banquet|disco)_optionals_(\d+)_title$/)) {
          const sec = curSec || 'C'; idx[sec] = (idx[sec] || 0) + 1; out[m[2]] = { sec, order: idx[sec] };
        }
      }
      return out;
    };
    let processed = 0, changedEv = 0, changedOpt = 0, noFicha = 0; const errors = [];
    const queue = ids.slice();
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          const ev = store.get('events', id);
          if (!ev || !Array.isArray(ev.optionals) || !ev.optionals.length) { processed++; continue; }
          const r = await srcFetch('/admin/events/update/' + id, cookie, ua);
          processed++;
          const html = r.text || '';
          if (!/name=["']wedding_date["']/.test(html)) { noFicha++; continue; } // sesión caducada o ficha no accesible
          const map = sectionsFromHtml(html);
          let ch = false;
          ev.optionals.forEach(o => {
            const mm = map[String(o.id)];
            if (!mm || !AREA[mm.sec]) return;
            o.sec = mm.sec; o.area = AREA[mm.sec]; o.order = String(mm.order);
            ch = true; changedOpt++;
          });
          if (ch) { store.put('events', ev); changedEv++; }
        } catch (e) { errors.push(id + ':' + e.message); processed++; }
      }
    };
    const N = Math.min(8, ids.length || 1);
    await Promise.all(Array.from({ length: N }, worker));
    return send(res, 200, { ok: true, processed, changedEv, changedOpt, noFicha, errors: errors.slice(0, 15), errorCount: errors.length });
  }

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
      if (cmd === 'setting') { const v = store.setting(body.key); return send(res, 200, { ok: true, key: body.key, value: v, keys: v && typeof v === 'object' ? Object.keys(v).length : null }); }
      if (cmd === 'build-djrates') { // convierte djFincas/djServices de cada DJ en el setting djRates (tarifas de facturación)
        const num = x => (x === '' || x == null) ? null : (isNaN(+x) ? null : +x);
        const rates = store.setting('djRates') || {}; let n = 0;
        users.all().filter(u => u.role === 'dj').forEach(u => {
          if (!((u.djFincas || []).length || (u.djServices || []).length)) return;
          const r = rates[String(u.id)] || (rates[String(u.id)] = {}); r.fincas = r.fincas || {}; r.services = r.services || {}; r.packs = r.packs || {};
          (u.djFincas || []).forEach(f => { if (f.l != null) r.fincas[f.l] = { boda: num(f.b), he: num(f.h), evento: num(f.e), ceremonia: num(f.c), disco: num(f.d) }; });
          (u.djServices || []).forEach(s => { if (s.s != null && num(s.p) != null) r.services[s.s] = num(s.p); });
          n++;
        });
        // Re-aplica los ajustes MANUALES de tarifas (setting 'djRatesManual') para que el rebuild
        // desde la intranet no machaque las correcciones hechas a mano.
        const man = store.setting('djRatesManual') || {};
        Object.keys(man).forEach(uid => {
          if (uid[0] === '_') return; const o = man[uid]; if (!o || typeof o !== 'object') return;
          const r = rates[uid] || (rates[uid] = { packs: {}, fincas: {}, services: {} });
          r.fincas = r.fincas || {}; r.packs = r.packs || {}; r.services = r.services || {};
          if (o.zeroAll) { Object.keys(r.fincas).forEach(k => { const f = r.fincas[k] || {}; ['boda', 'he', 'evento', 'ceremonia', 'disco'].forEach(x => { if (f[x] != null) f[x] = 0; }); }); Object.keys(r.packs).forEach(k => r.packs[k] = 0); Object.keys(r.services).forEach(k => r.services[k] = 0); }
          if (o.fincas) Object.keys(o.fincas).forEach(fid => { r.fincas[fid] = Object.assign({}, r.fincas[fid] || {}, o.fincas[fid]); });
          if (o.packs) Object.assign(r.packs, o.packs);
          if (o.services) Object.assign(r.services, o.services);
        });
        store.setSetting('djRates', rates);
        return send(res, 200, { ok: true, djsConRate: n, manualAplicados: Object.keys(man).filter(k => k[0] !== '_').length });
      }
      if (cmd === 'mark-tyc') { // marca usuarios como TYC firmado (data.tyc=true) desde los firmados de la intranet
        const ids = (body.ids || []).map(Number); const val = body.value !== false; let n = 0;
        ids.forEach(id => { const row = users.getRow(id); if (row) { users.update(id, { data: { tyc: val } }); n++; } });
        return send(res, 200, { ok: true, marked: n });
      }
      if (cmd === 'fix-overtime') { // convierte djOvertime numérico ("1") a su etiqueta ("1 Hora") en eventos ya importados
        const V2L = { '0': '', '0.5': 'Media Hora', '1': '1 Hora', '1.5': '1 hora y media', '2': '2 Horas', '2.5': '2 hora y media', '3': '3 Horas', '3.5': '3 hora y media', '4': '4 Horas', '4.5': '4 hora y media', '5': '5 Horas' };
        let n = 0, cleared = 0; store.all('events').forEach(e => { let v = e.djOvertime, ch = false;
          if (v != null && V2L[String(v)] !== undefined) { v = V2L[String(v)]; ch = true; n++; }
          if (v != null && /^Selecciona/i.test(String(v).trim())) { v = ''; ch = true; cleared++; }  // placeholder "Selecciona hora extra" = sin seleccionar
          if (ch) { e.djOvertime = v; store.put('events', e); } });
        return send(res, 200, { ok: true, fixed: n, cleared });
      }
      if (cmd === 'clean-fotologos') { // borra la referencia de logo cuando NO es una imagen ya subida (/api/files/): rotos y formatos corruptos pasados
        let cleared = 0; store.all('events').forEach(e => {
          const v = e.disco && e.disco.fotoLogo;
          if (typeof v === 'string' && v.trim() && v.indexOf('/api/files/') !== 0) { e.disco.fotoLogo = ''; store.put('events', e); cleared++; }
        });
        return send(res, 200, { ok: true, cleared });
      }
      if (cmd === 'set-tyc-dates') { // fija la fecha/hora de firma real (de la intranet) en cada usuario firmado
        const dates = body.dates || {}; let n = 0;
        const toISO = s => { const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/.exec(String(s || '')); return m ? (`${m[3]}-${m[2]}-${m[1]}` + (m[4] ? `T${m[4]}:${m[5]}:${m[6]}` : 'T00:00:00')) : null; };
        // Firma LIMPIA (solo versión + fecha real): el nombre/DNI se reconstruyen del evento, así no
        // arrastra datos de pruebas antiguas (p.ej. 'adrian y alba prueba').
        Object.keys(dates).forEach(id => { const iso = toISO(dates[id]); if (!iso) return; const row = users.getRow(+id); if (!row) return; users.update(+id, { data: { tycSign: { version: '2027', date: iso } } }); n++; });
        return send(res, 200, { ok: true, set: n });
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
