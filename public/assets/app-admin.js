'use strict';
/* ============================================================================
   Páginas de administración y de equipo (usuarios, localizaciones, control
   horario, vacaciones, facturación, vehículos, TYC) y la cuenta del usuario.
   ============================================================================ */
(function () {
const CS = window.__CS;
const { S, api, shell, pageHead, table, bindTable, toast, modal, copyText, esc, fmtEur, dmy, slash, ymd, pad, TODAY, MONTHS, hm, toMin,
  userName, dot, svg, on, loading, $, $$ } = CS;
const { fg, inp, sel, ta, collectForm } = CS.momentHelpers;
const isAdmin = () => S.user.role === 'admin';
const requireAdmin = () => { if (!isAdmin()) { shell('<div class="empty">Sin acceso.</div>', ['Sin acceso']); return false; } return true; };

/* helpers de colección */
const coll = {
  list: c => api('collections/' + c).then(r => r.items),
  save: (c, item) => api('collections/' + c + (item.id ? '/' + item.id : ''), { method: item.id ? 'PUT' : 'POST', body: { item } }),
  del: (c, id) => api('collections/' + c + '/' + id, { method: 'DELETE' }),
};

/* =========================================================================
   SERVICIOS EXTRAS (admin)
   ========================================================================= */
// === SOLICITUD DE EXTRAS: solicitudes de los novios, con aceptar / declinar ===
const RESERVA_EUR = 50 * 1.21; // 60,50 €
const exName = k => ((CS.momentHelpers.EXTRAS_CLIENTE || []).find(e => e[0] === k) || [])[1] || k;
const EX_STATE = { solicitado: ['⏳ Pendiente de confirmación', 'tag--yellow'], pendiente_pago: ['💳 Pendiente de pago', 'tag--blue'], reservado: ['✓ Reservado', 'tag--green'] };
on(/^#\/extras$/, () => solicitudesExtras());
on(/^#\/extras-catalogo$/, () => extrasCatalogo());
on(/^#\/papelera$/, () => papeleraEventos());
async function papeleraEventos() {
  if (!requireAdmin()) return;
  if (!benefOk()) return benefGate('Papelera');   // protegida por Configuración avanzada
  loading(['Papelera']);
  const { events } = await api('events/trash');
  shell(`${pageHead('Papelera de eventos', 'Eventos borrados. Puedes restaurarlos o eliminarlos definitivamente.')}
    <div class="panel"><div class="panel__body">
      <p class="hint" style="margin-bottom:12px">Al borrar un evento se guarda aquí (no se pierde). <b>Restaurar</b> lo devuelve a su listado con todos sus datos y archivos. <b>Eliminar definitivamente</b> sí lo borra para siempre.</p>
      ${table('dtTrash', { rows: events, order: [3, 'desc'], filters: true, empty: 'La papelera está vacía.', cols: [
        { t: 'Nº', get: e => e.id },
        { t: 'Tipo', get: e => e.tipo || '' },
        { t: 'Evento', get: e => e.conyuges || e.tipo || '', html: e => `<b>${esc(e.conyuges || e.tipo || '—')}</b>` },
        { t: 'Fecha boda', get: e => e.fecha || '', html: e => e.fecha ? dmy(e.fecha) : '—' },
        { t: 'Lugar', get: e => e.lugar || '' },
        { t: 'Borrado', get: e => e.deletedAt || '', html: e => e.deletedAt ? (dmy(e.deletedAt.slice(0,10)) + (e.deletedBy ? ' · ' + esc(e.deletedBy) : '')) : '—' },
        { t: '', nosort: true, nofilter: true, html: e => `<div class="row-actions"><button class="btn btn--sm btn--primary" data-restore="${e.id}">Restaurar</button><button class="btn btn--icon" data-purge="${e.id}" title="Eliminar definitivamente">🗑</button></div>` },
      ] })}
    </div></div>`, ['Papelera']);
  bindTable('dtTrash', () => {
    $$('[data-restore]').forEach(b => b.onclick = async () => {
      try { await api('events/trash/' + b.dataset.restore + '/restore', { method: 'POST' }); toast('Evento restaurado', 'ok'); papeleraEventos(); }
      catch (e) { toast(e.message || 'No se pudo restaurar', 'err'); }
    });
    $$('[data-purge]').forEach(b => b.onclick = () => modal('Eliminar definitivamente', `¿Eliminar para siempre el evento #${b.dataset.purge}? Esta acción <b>no se puede deshacer</b>.`, { okText: 'Eliminar definitivamente', danger: true, onOk: async () => { await api('events/trash/' + b.dataset.purge, { method: 'DELETE' }); toast('Eliminado definitivamente', 'ok'); papeleraEventos(); } }));
  });
}
async function solicitudesExtras() {
  if (!requireAdmin()) return; loading(['Solicitud de extras']);
  const { requests, pending } = await api('extra-requests');
  shell(`${pageHead('Solicitud de extras', 'Servicios que los novios quieren reservar. Confírmalos y copia el WhatsApp para enviarlo a la pareja, o declínalos.', `<button class="btn" id="catBtn">Ver catálogo de servicios</button>`)}
    <div class="panel"><div class="panel__body">
      <p class="hint" style="margin-bottom:12px">${pending} pendiente${pending === 1 ? '' : 's'} de confirmar. Al <b>aceptar</b> podrás <b>copiar el texto de WhatsApp</b> (con el total de la reserva) para pegarlo en el grupo de la pareja.</p>
      ${table('dtReq', { rows: requests.map((r, i) => Object.assign({ _i: i }, r)), order: [2, 'asc'], filters: true, cols: [
        { t: 'Evento', get: r => r.evId, html: r => `<a href="#/eventos/${r.evId}">#${r.evId}</a>${r.conyuges ? ' · ' + esc(r.conyuges) : ''}` },
        { t: 'Servicio', get: r => exName(r.extraKey), html: r => `<b>${esc(exName(r.extraKey))}</b>` },
        { t: 'Fecha', get: r => r.fecha || '', html: r => r.fecha ? dmy(r.fecha) : '—' },
        { t: 'Lugar', get: r => r.lugar || '' },
        { t: 'Estado', get: r => r.estado, html: r => { const s = EX_STATE[r.estado] || [r.estado, 'tag--grey']; return `<span class="tag ${s[1]}">${s[0]}</span>`; } },
        { t: '', nosort: true, nofilter: true, html: r => {
          if (r.estado === 'solicitado') return `<div class="row-actions"><button class="btn btn--sm btn--primary" data-acc="${r.evId}:${r.extraKey}">Aceptar</button><button class="btn btn--sm btn--red" data-dec="${r.evId}:${r.extraKey}">Declinar</button></div>`;
          if (r.estado === 'pendiente_pago') return `<div class="row-actions"><button class="btn btn--sm" data-paid="${r.evId}:${r.extraKey}">Marcar pagado</button></div>`;
          return '<span class="muted">—</span>';
        } },
      ] })}
    </div></div>`, ['Solicitud de extras']);
  el('catBtn').onclick = () => location.hash = '#/extras-catalogo';
  const splitD = v => { const i = v.indexOf(':'); return [v.slice(0, i), v.slice(i + 1)]; };
  bindTable('dtReq', () => {
    $$('[data-acc]').forEach(b => b.onclick = async () => { const [ev, k] = splitD(b.dataset.acc);
      let evObj; try { evObj = (await api('events/' + ev)).event; } catch (e) { toast('No se pudo cargar el evento', 'err'); return; }
      const waTxt = CS.reservaWhatsappText(evObj);
      modal('Reserva de extras · Boda #' + ev, `<p>Copia este mensaje y pégalo en el grupo de WhatsApp de la pareja:</p>
        <pre class="msg-preview">${esc(waTxt)}</pre>
        <div class="btn-row" style="margin-top:10px"><button type="button" class="btn btn--sm btn--primary" id="waCopyA">📋 Copiar texto</button></div>`,
        { okText: 'Mensaje enviado', onOk: async () => { await api('events/' + ev + '/extra-confirm', { method: 'POST', body: { key: k } }); toast('Mensaje enviado · pendiente de pago', 'ok'); solicitudesExtras(); } });
      setTimeout(() => { const c = document.getElementById('waCopyA'); if (c) c.onclick = () => copyText(waTxt).then(ok => toast(ok ? 'Texto copiado' : 'No se pudo copiar, selecciónalo a mano', ok ? 'ok' : 'err')); }, 60); });
    $$('[data-dec]').forEach(b => b.onclick = () => { const [ev, k] = splitD(b.dataset.dec);
      modal('Declinar solicitud', `¿Declinar <b>${esc(exName(k))}</b> de la boda #${ev}? Se quitará de su evento.`, { okText: 'Declinar', danger: true, onOk: async () => { await api('events/' + ev + '/extra-decline', { method: 'POST', body: { key: k } }); toast('Solicitud declinada', 'ok'); solicitudesExtras(); } }); });
    $$('[data-paid]').forEach(b => b.onclick = async () => { const [ev, k] = splitD(b.dataset.paid); await api('events/' + ev + '/extra-pay', { method: 'POST', body: { key: k } }); toast('Marcado como pagado · reservado', 'ok'); solicitudesExtras(); });
  });
}
async function extrasCatalogo() {
  if (!requireAdmin()) return; loading(['Catálogo de servicios']);
  const items = await coll.list('extras');
  shell(`${pageHead('Catálogo de servicios', 'Servicios extra que se asignan a los eventos.', `<button class="btn btn--primary" id="newExtra">+ Crear servicio</button> <button class="btn" id="reqBtn">Ver solicitudes</button>`)}
    <div class="panel"><div class="panel__body">${table('dtExtras', { rows: items, order: [1, 'asc'], cols: [
      { t: 'Id', get: x => x.id },
      { t: 'Nombre', get: x => x.name },
      { t: 'Admite horas extra', get: x => x.allows_overtime ? 'Sí' : 'No' },
      { t: '', nosort: true, html: x => `<div class="row-actions"><button class="btn btn--sm" data-edit="${x.id}">Editar</button><button class="btn btn--icon" data-del="${x.id}">🗑</button></div>` },
    ] })}</div></div>`, ['Catálogo de servicios']);
  el('newExtra').onclick = () => extraForm({});
  el('reqBtn').onclick = () => location.hash = '#/extras';
  bindTable('dtExtras', () => {
    $$('[data-edit]').forEach(b => b.onclick = () => extraForm(items.find(x => x.id == b.dataset.edit)));
    $$('[data-del]').forEach(b => b.onclick = () => modal('Borrar', '¿Eliminar este servicio extra?', { okText: 'Eliminar', danger: true, onOk: async () => { await coll.del('extras', b.dataset.del); toast('Eliminado', 'ok'); location.reload(); } }));
  });
}
function extraForm(x) {
  const bg = modal(x.id ? 'Editar servicio extra' : 'Nuevo servicio extra', `<form id="exForm"><div class="field"><label>Nombre del servicio extra</label>${inp('name', x.name)}</div>
    <label class="switch"><input type="checkbox" name="allows_overtime" ${x.allows_overtime ? 'checked' : ''}><span class="track"></span> Admite horas extras</label></form>`,
    { okText: 'Guardar Extra', onOk: async () => { const d = collectForm($('#exForm')); if (!d.name) { toast('Pon un nombre', 'err'); return true; } await coll.save('extras', { id: x.id, name: d.name, allows_overtime: d.allows_overtime }); toast('Guardado', 'ok'); CS.loadContext().then(() => location.hash = '#/extras-catalogo'); } });
}
const el = id => document.getElementById(id);

/* =========================================================================
   USUARIOS (admin)
   ========================================================================= */
on(/^#\/usuarios$/, () => usuariosPage());
on(/^#\/usuario\/(\d+)$/, m => usuariosPage(+m[1]));  // ficha directa de un cliente (desde el listado de bodas)
on(/^#\/trabajadores$/, () => trabajadoresPage());
on(/^#\/desplazamientos$/, () => desplazamientosPage());
// Extrae coordenadas de un enlace de Google Maps (largo) o de "lat,lng".
function parseLatLng(s) {
  s = decodeURIComponent(s || '');
  let m = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/); if (m) return [+m[1], +m[2]];
  m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/); if (m) return [+m[1], +m[2]];
  m = s.match(/[?&](?:q|query|ll|sll|daddr)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/); if (m) return [+m[1], +m[2]];
  m = s.match(/coordinate=(-?\d+\.\d+)(?:%2C|,)(-?\d+\.\d+)/); if (m) return [+m[1], +m[2]];
  m = s.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/); if (m) return [+m[1], +m[2]];
  return null;
}
async function desplazamientosPage() {
  if (!requireAdmin()) return; loading(['Desplazamientos']);
  const { items } = await api('collections/locations');
  const locs = items.slice().sort((a, b) => (a.travelMin ? 1 : 0) - (b.travelMin ? 1 : 0) || (a.name || '').localeCompare(b.name || '', 'es'));
  const pend = locs.filter(l => !l.travelMin).length;
  const row = l => `<tr data-loc="${l.id}">
    <td><span class="color-dot" style="background:${l.colorHex || colorOf(l.id)}"></span> <b>${esc(l.name)}</b></td>
    <td class="dw-time">${l.travelMin ? `🚗 ${l.travelApprox ? '~' : ''}${l.travelMin} min · ${l.travelKm || '?'} km${l.travelApprox ? ' <span class="muted">(aprox.)</span>' : ''}` : '<span class="tag tag--yellow">Pendiente</span>'}</td>
    <td><input class="control dw-link" placeholder="Pega el enlace de Google Maps (o: lat,long)" value="${esc(l.directionLink || '')}"></td>
    <td><button class="btn btn--sm btn--primary" data-calc="${l.id}">Calcular</button> ${l.lat ? `<a class="btn btn--sm" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent('Carrer del Comerç, Martorelles')}&destination=${l.lat},${l.lng}&travelmode=driving">Ver ruta</a>` : ''}</td></tr>`;
  shell(`${pageHead('Desplazamientos', 'Tiempo desde Martorelles (C/ Comerç) a cada finca. Pega el enlace de Google Maps de las que faltan y se calcula solo.')}
    <div class="panel"><div class="panel__body">
      <p class="hint" style="margin-bottom:12px">${pend} finca${pend === 1 ? '' : 's'} por ubicar. Pega el <b>enlace largo de Google Maps</b> (el que contiene las coordenadas) o escribe <code>latitud,longitud</code>, y pulsa <b>Calcular</b>.</p>
      <div class="table-wrap"><table class="dt"><thead><tr><th>Finca</th><th>Desplazamiento</th><th>Enlace Google Maps</th><th></th></tr></thead>
      <tbody>${locs.map(row).join('')}</tbody></table></div>
    </div></div>`, ['Desplazamientos']);
  $$('[data-calc]').forEach(btn => btn.onclick = async () => {
    const id = +btn.dataset.calc; const tr = btn.closest('tr'); const link = tr.querySelector('.dw-link').value.trim();
    const name = (locs.find(l => l.id == id) || {}).name || '';
    const ll = parseLatLng(link);
    if (!ll) {
      if (/maps\.app\.goo\.gl|g\.co\/|goo\.gl\//.test(link)) { modal('Enlace corto de Google Maps', `<p>Ese es un <b>enlace corto</b> y no lleva las coordenadas dentro, así que el navegador no puede leerlas.</p>
        <p><b>Cómo obtener el enlace bueno:</b></p>
        <ol style="margin:6px 0 0;padding-left:18px"><li>Abre el enlace en Google Maps.</li><li>Cuando cargue, copia la dirección de la barra del navegador (la que empieza por <code>https://www.google.com/maps/place/…@41.5,2.3…</code>).</li><li>Pégala aquí.</li></ol>
        <p class="hint" style="margin-top:8px">También puedes escribir directamente <code>latitud,longitud</code> (por ejemplo <code>41.50025,2.252335</code>).</p>`, { okText: 'Entendido' }); return; }
      toast('No encuentro coordenadas. Pega el enlace largo de Google Maps (con @lat,long) o escribe "lat,long".', 'err'); return;
    }
    btn.disabled = true; tr.querySelector('.dw-time').innerHTML = 'Calculando…';
    let min, km, approx = false;
    try {
      const r = await fetch(`https://router.project-osrm.org/route/v1/driving/2.2440,41.5293;${ll[1]},${ll[0]}?overview=false`);
      const j = await r.json(); const rt = j.routes && j.routes[0];
      if (!rt) throw new Error('sin ruta');
      min = Math.round(rt.duration / 60); km = Math.round(rt.distance / 100) / 10;
    } catch (e) {
      // sin servicio de rutas: estimación por distancia en línea recta (×1.3) a ~50 km/h
      const toRad = d => d * Math.PI / 180, R = 6371;
      const dLat = toRad(ll[0] - 41.5293), dLng = toRad(ll[1] - 2.2440);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(41.5293)) * Math.cos(toRad(ll[0])) * Math.sin(dLng / 2) ** 2;
      km = Math.round(2 * R * Math.asin(Math.sqrt(a)) * 1.3 * 10) / 10; min = Math.round(km / 50 * 60); approx = true;
    }
    try {
      await coll.save('locations', { id, lat: ll[0], lng: ll[1], travelMin: min, travelKm: km, directionLink: link, travelApprox: approx });
      await CS.loadContext();
      tr.querySelector('.dw-time').innerHTML = `🚗 ${approx ? '~' : ''}${min} min · ${km} km${approx ? ' <span class="muted">(aprox.)</span>' : ''}`;
      toast(`${name}: ${approx ? '≈ ' : ''}${min} min · ${km} km`, 'ok');
    } catch (e) { tr.querySelector('.dw-time').innerHTML = '<span class="tag tag--red">Error al guardar</span>'; }
    finally { btn.disabled = false; }
  });
}
// Directorio del equipo (DJs, técnicos, wedding planners): más ordenado que mezclarlo con los clientes.
async function trabajadoresPage() {
  if (!requireAdmin()) return; loading(['Trabajadores']);
  const { users } = await api('users');
  const staff = users.filter(u => u.role && u.role !== 'user');
  const WT = { 0: '—', 1: 'Trabajador', 2: 'Autónomo', 3: 'Otros' };
  shell(`${pageHead('Trabajadores', 'Directorio del equipo: DJs, técnicos y wedding planners.', `<button class="btn btn--primary" id="newWorker">+ Crear trabajador</button>`)}
    <div class="panel"><div class="panel__body">${table('dtWorkers', { rows: staff, order: [1, 'asc'], filters: true, cols: [
      { t: '', nosort: true, nofilter: true, html: u => `<span class="color-dot" style="background:${u.color || colorOf(u.id)}"></span>` },
      { t: 'Nombre', get: u => u.name, html: u => `<a data-edit="${u.id}">${esc(u.name || '—')}</a>` },
      { t: 'Rol', get: u => CS.roleLabel(u.role) },
      { t: 'Tipo', get: u => WT[u.worker_type || 0] || '—' },
      { t: 'Email', get: u => u.email, html: u => esc(u.email || '') },
      { t: 'Vehículo', get: u => u.vehicle_allowed ? 'Sí' : 'No', html: u => u.vehicle_allowed ? '<span class="tag tag--green">Puede</span>' : '<span class="muted">No</span>' },
      { t: 'Acceso', get: u => u.hasPassword ? 'Activo' : 'Sin activar', html: u => u.hasPassword ? '<span class="tag tag--green">Activo</span>' : '<span class="tag tag--grey">Sin activar</span>' },
      { t: '', nosort: true, nofilter: true, html: u => `<div class="row-actions"><button class="btn btn--sm" data-edit="${u.id}">Editar</button></div>` },
    ] })}</div></div>`, ['Trabajadores']);
  el('newWorker').onclick = () => userForm({ role: 'dj' }, users);
  bindTable('dtWorkers', () => { $$('[data-edit]').forEach(b => b.onclick = () => userForm(staff.find(u => u.id == b.dataset.edit) || users.find(u => u.id == b.dataset.edit), users)); });
}
async function usuariosPage(openId) {
  if (!requireAdmin()) return; loading(['Usuarios']);
  const { users } = await api('users');
  shell(`${pageHead('Usuarios', 'Cuentas con acceso al gestor. Invita, edita o da de baja.', `<button class="btn btn--primary" id="newUser">+ Crear usuario</button>`)}
    <div class="panel"><div class="panel__body">${table('dtUsers', { rows: users, order: [0, 'desc'], len: 25, filters: true, cols: [
      { t: 'Id', get: u => u.id },
      { t: 'Rol', get: u => CS.roleLabel(u.role) },
      { t: 'Nombre', get: u => u.name, html: u => `<a data-edit="${u.id}">${esc(u.name || '—')}</a>` },
      { t: 'Email', get: u => u.email, html: u => esc((u.emailDuplicado ? u.emailOriginal : u.email) || '') },
      { t: 'Acceso', get: u => u.hasPassword ? 'Activo' : 'Sin activar', html: u => u.hasPassword ? '<span class="tag tag--green">Activo</span>' : '<span class="tag tag--grey">Sin activar</span>' },
      { t: 'TYC', get: u => u.role !== 'user' ? '—' : (u.tycSigned ? 'Firmado' : (u.tycExempt ? 'Firma no necesaria' : 'No firmado')), html: u => u.role !== 'user' ? '<span class="muted">—</span>' : (u.tycSigned ? `<a class="tyc-status tyc-status--ok" href="#/tyc-firma/${u.id}" title="Ver / descargar PDF firmado">✓ Firmado</a>` : (u.tycExempt ? '<span class="tyc-status tyc-status--na" title="Es el segundo acceso de la boda; ya firmó su pareja">Firma no necesaria</span>' : '<span class="tyc-status tyc-status--no">✕ No firmado</span>')) },
      { t: '', nosort: true, nofilter: true, html: u => `<div class="row-actions">${u.role === 'user' ? `<button class="btn btn--icon" data-cal="${u.id}" title="${u.eventId ? 'Ver su boda' : 'Crear boda para este cliente'}">📅</button>` : ''}<button class="btn btn--icon" data-edit="${u.id}" title="Editar">${svg('edit')}</button><button class="btn btn--icon" data-magic="${u.id}" title="Entrar como este usuario (enlace de acceso directo, sin contraseña)">🔑</button><button class="btn btn--icon" data-invite="${u.id}" title="Reenviar mensaje de bienvenida">✉</button><button class="btn btn--icon" data-del="${u.id}" title="Dar de baja">🗑</button></div>` },
    ] })}</div></div>`, ['Usuarios']);
  el('newUser').onclick = () => userForm({}, users);
  bindTable('dtUsers', () => {
    $$('[data-edit]').forEach(b => b.onclick = () => userForm(users.find(u => u.id == b.dataset.edit), users));
    $$('[data-invite]').forEach(b => b.onclick = async () => { const r = await api('users/' + b.dataset.invite + '/invite', { method: 'POST' }); showInvite(r.invite); });
    $$('[data-magic]').forEach(b => b.onclick = async () => { try { const r = await api('users/' + b.dataset.magic + '/magic-link'); showMagicLink(r); } catch (e) { toast(e.message || 'No se pudo generar el enlace', 'err'); } });
    $$('[data-cal]').forEach(b => b.onclick = () => calForUser(users.find(u => u.id == b.dataset.cal)));
    $$('[data-del]').forEach(b => b.onclick = () => {
      const u = users.find(x => x.id == b.dataset.del) || {};
      const ev = u.ownedEvent;
      const body = ev
        ? `<div class="alert alert--warn" style="margin-bottom:10px">⚠ <b>Ojo:</b> este usuario es el <b>titular</b> de la boda <b>#${ev.id}${ev.conyuges ? ' · ' + esc(ev.conyuges) : ''}</b>${ev.fecha ? ' (' + esc(slash(ev.fecha)) + ')' : ''}. Si lo eliminas, esa boda se quedará sin titular. Quizá quieras <b>eliminar antes el evento</b>.</div><div class="btn-row" style="margin-bottom:4px"><a class="btn btn--sm" href="#/eventos/${ev.id}">Ver el evento</a></div>`
        : '¿Eliminar esta cuenta? El usuario perderá el acceso.';
      modal('Dar de baja', body, { okText: ev ? 'Eliminar usuario igualmente' : 'Eliminar', danger: true, onOk: async () => { await api('users/' + b.dataset.del, { method: 'DELETE' }); toast('Usuario eliminado', 'ok'); usuariosPage(); } });
    });
  });
  if (openId) { const u = users.find(x => x.id == openId); if (u) userForm(u, users); }
}
// botón calendario: ver la boda del cliente, o crearla y entrar directamente al evento
// (la fecha, lugar, tipo, horario y demás se rellenan dentro del propio evento y se guardan)
function calForUser(u) {
  if (!u) return;
  if (u.eventId) { location.hash = '#/eventos/' + u.eventId; return; }
  api('events', { method: 'POST', body: { userId: u.id } })
    .then(async r => { await CS.loadContext(); toast('Boda creada · completa los datos y guarda', 'ok'); location.hash = '#/eventos/' + r.event.id; })
    .catch(e => toast(e.message || 'No se pudo crear la boda', 'err'));
}
function showInvite(invite) {
  if (invite.sent) { modal('Enlace de acceso', `<p>✅ Hemos enviado un correo con el enlace de acceso a <b>${esc(invite.to || '')}</b>.</p>`); return; }
  const note = invite.reason === 'allowlist'
      ? `<p class="hint">⚠ El correo <b>NO</b> se envió: <b>${esc(invite.to || 'esa dirección')}</b> no está en la lista blanca de pruebas. Añádela en <b>Ajustes → Correo</b> (campo "Lista blanca") o comparte el enlace de abajo a mano.</p>`
    : invite.reason === 'disabled'
      ? `<p class="hint">⚠ El envío de correo está desactivado. Comparte el enlace de abajo a mano.</p>`
    : invite.reason === 'error'
      ? `<p class="hint">⚠ No se pudo enviar el correo. Comparte el enlace de abajo a mano.</p>`
    : '';
  modal('Enlace de acceso', `${note}<p>Comparte este enlace con la persona para que cree su contraseña (caduca en 14 días):</p><input class="control" readonly value="${esc(invite.link)}" onclick="this.select()">`);
}
// "Entrar como": enlace de autologin (sin contraseña) para revisar la intranet como ese usuario.
function showMagicLink(r) {
  const who = r.user ? `<b>${esc(r.user.name || '')}</b>${r.user.role ? ` <span class="muted">(${esc(CS.roleLabel(r.user.role))})</span>` : ''}` : 'este usuario';
  modal('Entrar como ' + (r.user ? esc(r.user.name || '') : 'usuario'),
    `<p>Enlace de acceso directo (sin contraseña) para entrar como ${who} y ver la intranet tal como la ve${r.eventId ? ' — abre directamente su boda #' + r.eventId : ''}. Caduca en 7 días.</p>
     <p class="hint">⚠ Ábrelo preferiblemente en una ventana de incógnito para no cerrar tu sesión de administración en esta pestaña.</p>
     <input class="control" readonly value="${esc(r.link)}" onclick="this.select()">
     <div class="btn-row" style="margin-top:12px"><a class="btn btn--primary" href="${esc(r.link)}" target="_blank" rel="noopener">Abrir en pestaña nueva</a></div>`);
}
// Tras cambiar la tarifa de un DJ: ofrece aplicarla también a bodas ya realizadas (selector de IDs,
// se pueden marcar varias y/o añadir IDs a mano). Por defecto el cambio solo afecta a las futuras.
async function offerApplyToRealized(uid, name) {
  let list = [];
  try { const r = await api('finance/dj-realized/' + uid); list = r.events || []; } catch (e) {}
  const rowsHtml = list.length
    ? list.map(e => `<label style="display:flex;gap:8px;align-items:center;padding:6px 2px;border-bottom:1px solid var(--line)"><input type="checkbox" class="reapply-id" value="${e.id}"> <span>#${e.id} · ${esc(e.lugar || '—')} · ${dmy(e.fecha)} · <b>${fmtEur(e.amount)}</b></span></label>`).join('')
    : '<p class="hint">Este DJ no tiene bodas realizadas recientes.</p>';
  modal('¿Aplicar la nueva tarifa a bodas ya realizadas?',
    `<p class="hint" style="margin-bottom:10px">Por defecto el cambio solo afecta a las bodas <b>futuras</b>. Marca las bodas ya realizadas de <b>${esc(name || '')}</b> a las que también quieras aplicar la nueva tarifa:</p>
     <div style="max-height:260px;overflow:auto;border:2px solid var(--line);border-radius:8px;padding:2px 10px;margin-bottom:10px">${rowsHtml}</div>
     <div class="field"><label>Añadir otros IDs de boda (separados por comas)</label><input class="control" id="reapplyExtra" placeholder="Ej: 1660, 1702"></div>
     <p class="hint">Si cierras sin aplicar, el cambio solo afectará a las bodas futuras.</p>`,
    { okText: 'Aplicar a las marcadas', onOk: async () => {
        const ids = [...document.querySelectorAll('.reapply-id:checked')].map(c => +c.value);
        const extra = String((document.getElementById('reapplyExtra') || {}).value || '').split(/[^0-9]+/).map(x => +x).filter(Boolean);
        const all = [...new Set(ids.concat(extra))];
        if (!all.length) { toast('No has marcado ninguna boda', 'err'); return true; }
        try { const r = await api('facturacion/reapply', { method: 'POST', body: { eventIds: all } }); toast('Tarifa aplicada a ' + r.n + ' boda(s)', 'ok'); }
        catch (e) { toast(e.message || 'No se pudo aplicar', 'err'); return true; }
      } });
}
function userForm(u, all) {
  const creating = !u.id;
  const roles = [['user', 'Cliente'], ['dj', 'DJ / Técnico'], ['planner', 'Wedding planner'], ['admin', 'Administración']];
  const p = (u.prices) || {};
  const locs = (S.meta.locations || []);
  const extras = (S.meta.extras || []);
  const locOpts = [['', 'Selecciona finca…']].concat(locs.map(l => [l.id, l.name]));
  const extraOpts = [['', 'Selecciona servicio…']].concat(extras.map(x => [x.id, x.name]));
  const fincas = u.djFincas || [];
  const svcs = u.djServices || [];
  // fila de condiciones por finca: finca + precio boda/evento/h.extra/discomóvil/ceremonia
  const fincaRow = (c = {}) => `<div class="pr-row" data-finca>
    ${sel('', locOpts, c.l, 'data-f="l" data-search')}
    <input class="control" data-f="b" type="number" placeholder="Boda" value="${c.b != null ? c.b : ''}">
    <input class="control" data-f="e" type="number" placeholder="Evento" value="${c.e != null ? c.e : ''}">
    <input class="control" data-f="h" type="number" placeholder="H.extra" value="${c.h != null ? c.h : ''}">
    <input class="control" data-f="d" type="number" placeholder="Discomóvil" value="${c.d != null ? c.d : ''}">
    <input class="control" data-f="c" type="number" placeholder="Ceremonia" value="${c.c != null ? c.c : ''}">
    <button type="button" class="btn btn--icon" data-del-row>✕</button></div>`;
  // fila de precio de servicio extra: servicio + precio + precio hora extra
  const svcRow = (s = {}) => `<div class="pr-row pr-row--svc" data-svc>
    ${sel('', extraOpts, s.s, 'data-s="s" data-search')}
    <input class="control" data-s="p" type="number" placeholder="Precio €" value="${s.p != null ? s.p : ''}">
    <input class="control" data-s="h" type="number" placeholder="H.extra €" value="${s.h != null ? s.h : ''}">
    <button type="button" class="btn btn--icon" data-del-row>✕</button></div>`;
  const bg = modal(creating ? 'Nuevo usuario' : 'Editar usuario', `<form id="uForm">
    <div class="field"><label>Nombre</label>${inp('name', u.name)}</div>
    <div class="field"><label>Email</label>${inp('mail', u.emailDuplicado ? u.emailOriginal : u.email, { type: 'email' })}</div>
    ${!creating ? `<div class="field"><button type="button" class="btn btn--blue btn--sm" id="resendWelcome">✉ Reenviar mensaje de bienvenida</button> <span class="hint">El cliente recibe el enlace para crear su contraseña y entrar al gestor.</span></div>` : ''}
    <div class="field"><label>Rol</label>${sel('role', roles, u.role || 'user', 'id="uRole"')}</div>
    <div class="field" id="colorBox" style="display:${(!creating && ['dj', 'planner', 'admin'].includes(u.role)) ? 'block' : 'none'}"><label>Color (agenda) <span class="hint">solo trabajadores</span></label>${inp('color', u.color, { ph: '#E82C88' })}</div>
    <div id="workerBox" style="display:${['dj', 'admin'].includes(u.role) ? 'block' : 'none'}">
      <div class="grid-2"><div class="field"><label>Tipo de trabajador</label>${sel('worker_type', [[0, 'Selecciona'], [1, 'Trabajador'], [2, 'Autónomo'], [3, 'Otros']], u.worker_type || 0)}</div>
      <div class="field"><label><input type="checkbox" name="vehicle_allowed" ${u.vehicle_allowed ? 'checked' : ''}> Puede coger vehículo</label>
        <label style="margin-top:6px"><input type="checkbox" name="time_tracking" ${u.time_tracking ? 'checked' : ''}> Tiene control horario (fichaje)</label></div></div>
      <h4 class="form-sub">Tarifas base por tipo de evento</h4>
      <div class="grid-2"><div class="field"><label>Recomendado</label>${inp('recomendado', p.recomendado, { ph: '€' })}</div>
      <div class="field"><label>Fiesta</label>${inp('fiesta', p.fiesta, { ph: '€' })}</div></div>
      <div class="grid-2"><div class="field"><label>Bodorrio</label>${inp('bodorrio', p.bodorrio, { ph: '€' })}</div>
      <div class="field"><label>Tinglado</label>${inp('tinglado', p.tinglado, { ph: '€' })}</div></div>
      <div class="grid-3"><div class="field"><label>Hora extra Fiesta</label>${inp('fiesta_precio_extra', p.fiesta_precio_extra, { ph: '€' })}</div>
      <div class="field"><label>Hora extra Bodorrio</label>${inp('bodorrio_precio_extra', p.bodorrio_precio_extra, { ph: '€' })}</div>
      <div class="field"><label>Hora extra Tinglado</label>${inp('tinglado_precio_extra', p.tinglado_precio_extra, { ph: '€' })}</div></div>
      <h4 class="form-sub">Precios de servicios extra <span class="hint">(lo que cobra este técnico por cada servicio)</span></h4>
      <div class="pr-head pr-head--svc"><span>Servicio</span><span>Precio</span><span>Precio h.extra</span><span></span></div>
      <div id="svcBox">${svcs.map(svcRow).join('')}</div>
      <button type="button" class="btn btn--sm" id="addSvc">+ Añadir servicio</button>
      <h4 class="form-sub">Condiciones por finca <span class="hint">(precio según la finca de la boda)</span></h4>
      <div class="pr-head"><span>Finca</span><span>Boda</span><span>Evento</span><span>H.extra</span><span>Discomóvil</span><span>Ceremonia</span><span></span></div>
      <div id="fincaBox">${fincas.map(fincaRow).join('')}</div>
      <button type="button" class="btn btn--sm" id="addFinca">+ Añadir finca</button>
    </div></form>`,
    { okText: creating ? 'Crear e invitar' : 'Guardar', onOk: async () => {
      const d = collectForm($('#uForm'));
      if (!d.mail) { toast('El email es obligatorio', 'err'); return true; }
      const prices = {}; Object.keys(p).forEach(k => { if (!/^loc\d+_/.test(k)) prices[k] = p[k]; });
      ['recomendado', 'fiesta', 'bodorrio', 'tinglado', 'fiesta_precio_extra', 'bodorrio_precio_extra', 'tinglado_precio_extra'].forEach(k => { if (d[k] !== undefined && d[k] !== '') prices[k] = d[k]; else delete prices[k]; });
      const djFincas = []; $$('[data-finca]', bg).forEach(r => { const g = k => r.querySelector('[data-f="' + k + '"]').value; const l = g('l'); if (!l) return; djFincas.push({ l: +l, b: g('b'), e: g('e'), h: g('h'), d: g('d'), c: g('c') }); });
      const djServices = []; $$('[data-svc]', bg).forEach(r => { const g = k => r.querySelector('[data-s="' + k + '"]').value; const s = g('s'), pp = g('p'); if (!s || pp === '') return; djServices.push({ s: +s, p: pp, h: g('h') || undefined }); });
      const data = { color: d.color, worker_type: +d.worker_type || 0, vehicle_allowed: d.vehicle_allowed, time_tracking: d.time_tracking, prices, djFincas, djServices };
      // ¿han cambiado las tarifas (condiciones por finca o tarifas base)? Para ofrecer aplicarlas a bodas realizadas.
      const nrm = v => (v == null || v === '') ? '' : String(v);
      const packKeys = ['recomendado', 'fiesta', 'bodorrio', 'tinglado', 'fiesta_precio_extra', 'bodorrio_precio_extra', 'tinglado_precio_extra'];
      const sig = (fx, pr) => JSON.stringify({ f: (fx || []).map(f => [+f.l || 0, nrm(f.b), nrm(f.e), nrm(f.h), nrm(f.d), nrm(f.c)]).sort(), p: packKeys.map(k => nrm(pr[k])) });
      const ratesChanged = !creating && ['dj', 'admin'].includes(d.role) && sig(u.djFincas, p) !== sig(djFincas, prices);
      try {
        if (creating) { const r = await api('users', { method: 'POST', body: { email: d.mail, name: d.name, role: d.role, data } }); await CS.loadContext(); showInvite(r.invite); }
        else { await api('users/' + u.id, { method: 'PUT', body: { email: d.mail, name: d.name, role: d.role, data } }); await CS.loadContext(); toast('Guardado', 'ok'); if (ratesChanged) setTimeout(() => offerApplyToRealized(u.id, d.name || u.name), 80); }
        if (location.hash === '#/usuarios') usuariosPage(); else location.hash = '#/usuarios';
      } catch (e) { toast(e.message, 'err'); return true; }
    } });
  const rw = $('#resendWelcome', bg); if (rw) rw.onclick = async () => { try { const r = await api('users/' + u.id + '/invite', { method: 'POST' }); toast('Mensaje de bienvenida reenviado', 'ok'); showInvite(r.invite); } catch (e) { toast(e.message || 'No se pudo reenviar', 'err'); } };
  const roleSel = $('#uRole', bg); roleSel.onchange = () => {
    $('#workerBox', bg).style.display = ['dj', 'admin'].includes(roleSel.value) ? 'block' : 'none';
    const cb = $('#colorBox', bg); if (cb) cb.style.display = (!creating && ['dj', 'planner', 'admin'].includes(roleSel.value)) ? 'block' : 'none';
  };
  CS.momentHelpers.enhanceSearchSelects(bg);
  $('#addFinca', bg).onclick = () => { const box = $('#fincaBox', bg); box.insertAdjacentHTML('beforeend', fincaRow()); CS.momentHelpers.enhanceSearchSelects(box); };
  $('#addSvc', bg).onclick = () => { const box = $('#svcBox', bg); box.insertAdjacentHTML('beforeend', svcRow()); CS.momentHelpers.enhanceSearchSelects(box); };
  bg.addEventListener('click', e => { if (e.target.closest('[data-del-row]')) e.target.closest('[data-finca],[data-svc]').remove(); });
}

/* =========================================================================
   LOCALIZACIONES (admin)
   ========================================================================= */
on(/^#\/localizaciones$/, async () => {
  if (!requireAdmin()) return; loading(['Localizaciones']);
  const items = await coll.list('locations');
  shell(`${pageHead('Localizaciones', 'Lugares de celebración con sus precios y color de agenda.', `<button class="btn btn--primary" id="newLoc">+ Crear localización</button>`)}
    <div class="panel"><div class="panel__body">${table('dtLocs', { rows: items, order: [1, 'asc'], filters: true, cols: [
      { t: 'Id', get: l => l.id }, { t: 'Nombre', get: l => l.name, html: l => `<a data-edit="${l.id}">${esc(l.name)}</a>` },
      { t: 'Dirección', get: l => l.direction || '' }, { t: 'Responsable', get: l => l.responsable || '' },
      { t: 'Precio boda', get: l => l.weddingPrice ? l.weddingPrice + ' €' : '—', nofilter: true }, { t: 'Precio ceremonia', get: l => l.ceremonyPrice ? l.ceremonyPrice + ' €' : '—', nofilter: true }, { t: 'Hora extra', get: l => l.extraPrice ? l.extraPrice + ' €' : '—', nofilter: true },
      { t: 'Color', get: l => l.colorHex || '', html: l => `<span class="loc-badge" style="background:${esc(l.colorHex || '#777')}">${esc(l.colorHex || '')}</span>`, nofilter: true },
      { t: '', nosort: true, nofilter: true, html: l => `<div class="row-actions"><a class="btn btn--sm" href="#/plano/${l.id}">Plano</a><button class="btn btn--sm" data-edit="${l.id}">Editar</button><button class="btn btn--icon" data-del="${l.id}">🗑</button></div>` },
    ] })}</div></div>`, ['Localizaciones']);
  el('newLoc').onclick = () => locForm({});
  bindTable('dtLocs', () => {
    $$('[data-edit]').forEach(b => b.onclick = () => locForm(items.find(l => l.id == b.dataset.edit)));
    $$('[data-del]').forEach(b => b.onclick = () => modal('Borrar', '¿Eliminar esta localización?', { okText: 'Eliminar', danger: true, onOk: async () => { await coll.del('locations', b.dataset.del); toast('Eliminada', 'ok'); location.reload(); } }));
  });
});
function locForm(l) {
  const f = (lab, n, t) => `<div class="field"><label>${lab}</label>${inp(n, l[n], { type: t || 'text' })}</div>`;
  modal(l.id ? 'Editar localización' : 'Nueva localización', `<form id="locForm">
    ${f('Nombre', 'name')}${f('Dirección', 'direction')}${f('Enlace a maps', 'directionLink')}
    <div class="grid-2">${f('Responsable', 'responsable')}${f('Teléfono', 'phone')}</div>
    ${f('Color (hex)', 'colorHex')}
    <h4 class="form-sub">Información económica de la finca</h4>
    <div class="grid-2">${f('Precio boda', 'weddingPrice', 'number')}${f('Precio evento', 'eventPrice', 'number')}</div>
    <div class="grid-2">${f('Precio ceremonia', 'ceremonyPrice', 'number')}${f('Precio hora extra', 'extraPrice', 'number')}</div>
    <p class="hint">El precio de hora extra de la finca se usa automáticamente en la facturación cuando el evento tiene horas extra.</p>
    <div class="field"><label>Comentarios</label>${ta('comments', l.comments)}</div></form>`,
    { okText: 'Guardar', onOk: async () => { const d = collectForm($('#locForm')); if (!d.name || !d.name.trim()) { toast('Pon un nombre a la localización', 'err'); return true; } await coll.save('locations', Object.assign({ id: l.id }, d)); await CS.loadContext(); toast('Guardada', 'ok'); location.hash = '#/localizaciones'; } });
}

/* =========================================================================
   PLANO DE MONTAJE POR FINCA  (admin + dj/técnico)
   Vista aérea + símbolos arrastrables (altavoces, truss, cables, luces…).
   Se guarda por finca y por zona en IndexedDB. Online, sin instalar nada.
   ========================================================================= */
// Los planos se guardan por PACK (el montaje depende del tipo de servicio), no por momento.
const PLAN_ZONAS = [['recomendado', 'Recomendado'], ['fiesta', 'Pack fiesta'], ['bodorrio', 'Pack bodorrio'], ['tinglado', 'Pack tinglado']];
// En RECOMENDADO el plano va por zonas del día; los packs de servicio llevan plano único.
const RECO_ZONAS = [['ceremonia', 'Ceremonia'], ['aperitivo', 'Aperitivo'], ['banquete', 'Banquete'], ['fiesta', 'Fiesta']];
const zonasForPack = pack => pack === 'recomendado' ? RECO_ZONAS : null;
// Fincas que son la misma y comparten plano (Can Ribas: Oliveres 15 y Cirerers 14 usan el de Exclusivo 16)
const PLANO_ALIAS = { '14': '16', '15': '16' };
const planoLoc = id => PLANO_ALIAS[String(id)] || String(id);
// Fincas recomendadas: su plano va solo por zonas (ceremonia/aperitivo/banquete/fiesta), nunca packs.
const RECO_FINCAS = { '1': 1, '5': 1, '8': 1, '9': 1, '10': 1, '14': 1, '15': 1, '16': 1, '17': 1, '18': 1, '20': 1, '22': 1, '25': 1, '26': 1, '27': 1 };
const isRecoFinca = id => !!RECO_FINCAS[String(id)];
const zonaLabel = (pack, zona) => pack === 'recomendado' ? ((RECO_ZONAS.find(z => z[0] === zona) || [, zona])[1]) : ((PLAN_ZONAS.find(z => z[0] === pack) || [, pack])[1]);
// Fincas que NO llevan plano en el pack Recomendado (el montaje es siempre el mismo).
const NO_PLANO = { '9_recomendado': 1, '10_recomendado': 1, '12_recomendado': 1, '18_recomendado': 1 };
const planoBlocked = (locId, pack) => !!NO_PLANO[locId + '_' + pack];
const tipoToPack = tipo => { const t = (tipo || '').toLowerCase(); return /recomendad/.test(t) ? 'recomendado' : /fiesta/.test(t) ? 'fiesta' : /bodorrio/.test(t) ? 'bodorrio' : /tinglado/.test(t) ? 'tinglado' : null; };
const PLAN_SYMS = {
  ctrl:   { g: 'Sonido', lab: 'Mesa de control', cls: 'pm-ctrl', txt: 'CTRL', rot: 1 },
  speaker:{ g: 'Sonido', lab: 'Altavoz', cls: 'pm-speaker', txt: '▶', rot: 1 },
  mic:    { g: 'Sonido', lab: 'Micro', cls: 'pm-mic' },
  stage:  { g: 'Escenario', lab: 'Escenario', cls: 'pm-stage', txt: 'Escenario', rot: 1 },
  dj:     { g: 'Escenario', lab: 'Cabina DJ', cls: 'pm-dj', txt: 'DJ', rot: 1 },
  truss:  { g: 'Estructura', lab: 'Truss', cls: 'pm-truss', txt: '✕', rot: 1 },
  power:  { g: 'Corriente', lab: 'Punto de corriente', cls: 'pm-power' },
  garland:{ g: 'Luz', lab: 'Guirnalda', cls: 'pm-garland', txt: '∿' },
};
const PLAN_LINES = {
  cableSound: { lab: 'Cable sonido', col: '#31B9CB' },
  cablePower: { lab: 'Cable corriente', col: '#F0E85A' },
};
let PLAN = null, DRAGP = null;
// Almacén de planos EN EL SERVIDOR (imagen en disco + símbolos). Se comparte entre
// todos los usuarios y persiste. keyBase: "<locId>_<pack>" o "ev_<eventId>".
const planoSrv = {
  async get(keyBase) { try { return await api('planos/' + encodeURIComponent(keyBase)); } catch (e) { return { marks: [], hasImg: false }; } },
  async putMarks(keyBase, marks) { try { await api('planos/' + encodeURIComponent(keyBase) + '/marks', { method: 'PUT', body: { marks } }); } catch (e) {} },
  imgUrl: (keyBase, bust) => '/api/planos/' + encodeURIComponent(keyBase) + '/img' + (bust ? ('?t=' + Date.now()) : ''),
  async uploadImg(keyBase, file) { const fd = new FormData(); fd.append('file', file, file.name); await api('planos/' + encodeURIComponent(keyBase) + '/img', { method: 'POST', form: fd }); },
  async delImg(keyBase) { try { await api('planos/' + encodeURIComponent(keyBase) + '/img', { method: 'DELETE' }); } catch (e) {} },
  async delAll(keyBase) { try { await api('planos/' + encodeURIComponent(keyBase), { method: 'DELETE' }); } catch (e) {} },
};
const uidp = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clampp = v => Math.max(0, Math.min(100, v));

on(/^#\/plano\/(\d+)(?:\/([a-z]+))?$/, m => planoPage(+m[1], m[2]));
async function planoPage(locId, packArg) {
  const canEdit = isAdmin() || S.user.role === 'dj';
  if (!canEdit) { shell('<div class="empty">Sin acceso.</div>', ['Plano']); return; }
  loading(['Localizaciones', 'Plano']);
  const loc = (S.meta.locations || []).find(l => l.id == locId) || { id: locId, name: 'Finca #' + locId };
  let pack = PLAN_ZONAS.some(z => z[0] === packArg) ? packArg : 'recomendado';
  if (isRecoFinca(locId)) pack = 'recomendado';   // finca recomendada: nunca packs de servicio
  const zona = pack === 'recomendado' ? 'ceremonia' : pack;
  PLAN = { locId, pack, zona, sel: null, img: null, marks: [], readOnly: false, loc, crumbs: ['Localizaciones', 'Plano · ' + loc.name] };
  shell(planoShell(loc), PLAN.crumbs);
  planoBindStatic();
  await planoLoadZona();
}
on(/^#\/plano-ev\/(\d+)$/, m => planoPageEvent(+m[1]));
async function planoPageEvent(eventId) {
  const canEdit = isAdmin() || S.user.role === 'dj';
  if (!canEdit) { shell('<div class="empty">Sin acceso.</div>', ['Plano']); return; }
  loading(['Eventos', '#' + eventId, 'Plano']);
  let ev; try { ev = (await api('events/' + eventId)).event; } catch (e) { ev = null; }
  if (!ev) { shell('<div class="empty">Evento no encontrado.</div>', ['Plano']); return; }
  const pack = tipoToPack(ev.tipo);
  if (!ev.lugar || !pack) { shell('<div class="empty">Este evento necesita una finca y un pack (tipo) con plano de montaje.</div>', ['Plano']); return; }
  if (planoBlocked(ev.lugar, pack)) { shell(`<div class="empty"><span class="script">Sin plano</span>El pack <b>${esc(ev.tipo || '')}</b> no lleva plano de montaje en esta finca.</div>`, ['Plano']); return; }
  const loc = (S.meta.locations || []).find(l => l.id == ev.lugar) || { id: ev.lugar, name: 'Finca' };
  const zona0 = pack === 'recomendado' ? 'ceremonia' : pack;
  PLAN = { locId: ev.lugar, eventId, pack, zona: zona0, mode: 'event', sel: null, img: null, marks: [], readOnly: false, loc, crumbs: ['Eventos', '#' + eventId, 'Plano'] };
  shell(planoShell(loc), PLAN.crumbs);
  planoBindStatic();
  await planoLoadZona();
}
function planoShell(loc) {
  const isEv = PLAN.mode === 'event';
  const isReco = PLAN.pack === 'recomendado';
  const curLabel = zonaLabel(PLAN.pack, PLAN.zona);
  const recoOnly = !isEv && isRecoFinca(PLAN.locId); // finca recomendada → solo zonas, sin packs
  const zoneTabs = isReco ? `<div class="plan-tabs plan-tabs--zonas">${RECO_ZONAS.map(z => `<button class="plan-tab${z[0] === PLAN.zona ? ' on' : ''}" data-z="${z[0]}">${z[1]}</button>`).join('')}</div>` : '';
  const packTabs = recoOnly ? '' : `<div class="plan-tabs">${PLAN_ZONAS.map(z => `<button class="plan-tab${z[0] === PLAN.pack ? ' on' : ''}" data-pack="${z[0]}">${z[1]}</button>`).join('')}</div>`;
  const topBar = isEv
    ? `<div class="plan-evbanner">✎ Estás editando una <b>copia para el evento #${PLAN.eventId}</b> (${esc(curLabel)}). Los cambios <b>no afectan</b> a la plantilla de la finca. <button class="btn btn--sm" id="planUseTemplate" type="button">Descartar copia y usar la plantilla</button></div>${zoneTabs}`
    : `${packTabs}${zoneTabs}`;
  const backLink = isEv ? `<a class="btn btn--sm" href="#/eventos/${PLAN.eventId}">← Volver al evento</a>` : `<a class="btn btn--sm" href="#/localizaciones">← Localizaciones</a>`;
  const title = isEv ? ('Plano · ' + esc(loc.name) + ' · copia del evento #' + PLAN.eventId) : ('Plano de montaje · ' + esc(loc.name));
  const sub = isEv ? 'Copia de montaje solo para este evento (parte de la plantilla de la finca; edítala a tu gusto).' : 'Un montaje predefinido por pack de servicio. Coloca altavoces, truss, cables e iluminación sobre la vista aérea; se guarda por pack y por finca.';
  const sym = t => `<span class="pm ${PLAN_SYMS[t].cls}" style="position:static;transform:none">${PLAN_SYMS[t].txt ? `<span>${PLAN_SYMS[t].txt}</span>` : ''}</span>`;
  const pal = Object.keys(PLAN_SYMS).map(t => `<button class="pal-item" data-t="${t}"><span class="pal-ico">${sym(t)}</span>${PLAN_SYMS[t].lab}</button>`).join('');
  const palLines = Object.keys(PLAN_LINES).map(l => `<button class="pal-line" data-l="${l}"><span class="pal-ico"><span class="pal-cable" style="background:${PLAN_LINES[l].col}"></span></span>${PLAN_LINES[l].lab}</button>`).join('');
  return `${pageHead(title, sub, backLink)}
  <div class="panel"><div class="panel__body">
    ${topBar}
    <div class="plan-wrap">
      <div class="plan-pal">
        <input id="planUp" type="file" accept="image/*" hidden>
        <div class="plan-pal-actions">
          <button class="btn btn--sm btn--primary" id="planImgBtn">Subir / cambiar imagen</button>
          <button class="btn btn--sm" id="planImgDel">Quitar imagen</button>
        </div>
        <div class="pal-group">Símbolos — toca para añadir</div>
        ${pal}
        <div class="pal-group">Cables</div>
        ${palLines}
      </div>
      <div>
        <div class="plan-stage" id="planStage"></div>
        <div class="plan-toolbar">
          <span class="hint">Toca un símbolo para añadirlo y <b>arrástralo</b> sobre el plano. Los cables tienen dos extremos que puedes mover.</span>
          <span class="plan-tb-right">
            <button class="btn btn--sm" id="planRotL" title="Girar a la izquierda">⟲</button>
            <button class="btn btn--sm" id="planRotR" title="Girar a la derecha">⟳</button>
            <button class="btn btn--sm" id="planLbl" title="Poner etiqueta">🏷</button>
            <button class="btn btn--sm btn--red" id="planDelSel">Borrar selección</button>
            <button class="btn btn--sm" id="planClear">Vaciar zona</button>
          </span>
        </div>
      </div>
    </div>
  </div></div>`;
}
async function planoLoadZona() {
  PLAN.sel = null;
  const isReco = PLAN.pack === 'recomendado';
  // plantilla de finca (con alias: Can Ribas Oliveres/Cirerers comparten el de Exclusivo)
  const tplBase = isReco ? (planoLoc(PLAN.locId) + '_recomendado_' + PLAN.zona) : (planoLoc(PLAN.locId) + '_' + PLAN.pack);
  PLAN.keyBase = PLAN.mode === 'event' ? ('ev_' + PLAN.eventId + (isReco ? ('_' + PLAN.zona) : '')) : tplBase;
  const d = await planoSrv.get(PLAN.keyBase);
  PLAN.marks = d.marks || [];
  let imgKey = d.hasImg ? PLAN.keyBase : null;
  // evento sin copia propia de esta zona: muestra la plantilla de la finca
  if (PLAN.mode === 'event' && !imgKey && !PLAN.marks.length) {
    const t = await planoSrv.get(tplBase);
    PLAN.marks = t.marks || [];
    if (t.hasImg) imgKey = tplBase;
  }
  PLAN.img = imgKey ? planoSrv.imgUrl(imgKey, true) : null;
  $$('.plan-tab[data-z]').forEach(b => b.classList.toggle('on', b.dataset.z === PLAN.zona));
  $$('.plan-tab[data-pack]').forEach(b => b.classList.toggle('on', b.dataset.pack === PLAN.pack));
  planoRenderStage();
}
async function planoSaveMarks() { await planoSrv.putMarks(PLAN.keyBase, PLAN.marks.map(m => Object.assign({}, m))); }
function planoMarkHTML(m) {
  const s = PLAN_SYMS[m.t] || { cls: '' };
  const sel = m.id === PLAN.sel ? ' sel' : '';
  const inner = s.txt ? `<span>${s.txt}</span>` : '';
  return `<div class="pm ${s.cls}${sel}" data-id="${m.id}" style="left:${m.x}%;top:${m.y}%;transform:translate(-50%,-50%) rotate(${m.rot || 0}deg)">${inner}${m.label ? `<span class="pm-lbl" style="transform:translateX(-50%) rotate(${-(m.rot || 0)}deg)">${esc(m.label)}</span>` : ''}</div>`;
}
function planoRenderStage() {
  const st = el('planStage'); if (!st) return;
  if (PLAN && PLAN.mode !== 'event' && planoBlocked(PLAN.locId, PLAN.pack)) {
    st.innerHTML = '<div class="plan-drop"><div style="font-size:34px">🚫</div><div><b>Este pack no lleva plano en esta finca</b></div><div class="hint" style="max-width:36ch">El montaje del pack Recomendado es siempre el mismo aquí, así que no se define un plano propio.</div></div>';
    return;
  }
  const ro = PLAN.readOnly;
  let html = '';
  if (PLAN.img) html += `<img class="plan-img" src="${PLAN.img}" alt="">`;
  else html += `<div class="plan-drop"><div style="font-size:34px">🛰️</div><div><b>Sin plano aéreo</b> en esta zona</div><div class="hint" style="max-width:34ch">Sube una captura de la vista satélite de la finca (Google Maps → captura de pantalla).</div>${ro ? '' : `<button class="btn btn--primary" id="planDropBtn" type="button">Subir imagen</button>`}</div>`;
  const lines = PLAN.marks.filter(m => m.t === 'line');
  html += `<svg class="plan-lines" viewBox="0 0 100 100" preserveAspectRatio="none">` + lines.map(l => {
    const col = (PLAN_LINES[l.sub] || {}).col || '#fff';
    return `<line class="pl-hit" data-id="${l.id}" x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}"/>` +
           `<line data-id="${l.id}" x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="${col}" stroke-width="${l.id === PLAN.sel ? 1.2 : 0.9}" stroke-linecap="round"/>`;
  }).join('') + `</svg>`;
  html += PLAN.marks.filter(m => m.t !== 'line').map(planoMarkHTML).join('');
  const sl = lines.find(l => l.id === PLAN.sel);
  if (sl && !ro) html += `<div class="pm-h" data-h="1" style="left:${sl.x1}%;top:${sl.y1}%"></div><div class="pm-h" data-h="2" style="left:${sl.x2}%;top:${sl.y2}%"></div>`;
  st.innerHTML = html;
}
function planoPct(e) { const st = el('planStage'); const r = st.getBoundingClientRect(); return { x: clampp((e.clientX - r.left) / r.width * 100), y: clampp((e.clientY - r.top) / r.height * 100) }; }
function planoRotate(d) { if (!PLAN.sel) return; const m = PLAN.marks.find(x => x.id === PLAN.sel); if (!m || m.t === 'line') return; m.rot = ((m.rot || 0) + d) % 360; planoRenderStage(); planoSaveMarks(); }
function planoRerender() { shell(planoShell(PLAN.loc), PLAN.crumbs || ['Plano']); planoBindStatic(); return planoLoadZona(); }
function planoBindStatic() {
  $$('.plan-tab[data-z]').forEach(b => b.onclick = async () => { PLAN.zona = b.dataset.z; await planoLoadZona(); });
  $$('.plan-tab[data-pack]').forEach(b => b.onclick = async () => { PLAN.pack = b.dataset.pack; PLAN.zona = PLAN.pack === 'recomendado' ? 'ceremonia' : PLAN.pack; await planoRerender(); });
  if (!PLAN.readOnly) {
    $$('.pal-item').forEach(b => b.onclick = () => { const n = PLAN.marks.filter(x => x.t !== 'line').length; const m = { id: uidp(), t: b.dataset.t, x: 44 + (n % 6) * 3, y: 40 + (n % 6) * 4, rot: 0 }; PLAN.marks.push(m); PLAN.sel = m.id; planoRenderStage(); planoSaveMarks(); });
    $$('.pal-line').forEach(b => b.onclick = () => { const m = { id: uidp(), t: 'line', sub: b.dataset.l, x1: 38, y1: 50, x2: 62, y2: 50 }; PLAN.marks.push(m); PLAN.sel = m.id; planoRenderStage(); planoSaveMarks(); });
    el('planImgBtn').onclick = () => el('planUp').click();
    el('planUp').onchange = async e => { const f = e.target.files[0]; if (!f) return; if (f.size > 60 * 1048576) { toast('La imagen supera 60 MB', 'err'); e.target.value = ''; return; } toast('Subiendo imagen…'); try { await planoSrv.uploadImg(PLAN.keyBase, f); PLAN.img = planoSrv.imgUrl(PLAN.keyBase, true); planoRenderStage(); toast('Imagen guardada', 'ok'); } catch (err) { toast('No se pudo subir la imagen', 'err'); } e.target.value = ''; };
    el('planImgDel').onclick = () => { if (!PLAN.img) return toast('No hay imagen', 'warn'); modal('Quitar imagen', '¿Quitar la imagen de esta zona? Los símbolos se mantienen.', { okText: 'Quitar', danger: true, onOk: async () => { await planoSrv.delImg(PLAN.keyBase); PLAN.img = null; planoRenderStage(); } }); };
    el('planRotL').onclick = () => planoRotate(-15);
    el('planRotR').onclick = () => planoRotate(15);
    el('planLbl').onclick = () => { if (!PLAN.sel) return toast('Selecciona un símbolo', 'warn'); const m = PLAN.marks.find(x => x.id === PLAN.sel); if (!m || m.t === 'line') return toast('Los cables no llevan etiqueta', 'warn'); modal('Etiqueta', `<div class="field"><label>Texto (p. ej. "Control en el suelo")</label><input class="control" id="lblIn" value="${esc(m.label || '')}"></div>`, { okText: 'Guardar', onOk: () => { m.label = (el('lblIn').value || '').trim(); planoRenderStage(); planoSaveMarks(); } }); };
    el('planDelSel').onclick = () => { if (!PLAN.sel) return; PLAN.marks = PLAN.marks.filter(m => m.id !== PLAN.sel); PLAN.sel = null; planoRenderStage(); planoSaveMarks(); };
    el('planClear').onclick = () => modal('Vaciar', '¿Quitar todos los símbolos?', { okText: 'Vaciar', danger: true, onOk: () => { PLAN.marks = []; PLAN.sel = null; planoRenderStage(); planoSaveMarks(); } });
    const ut = el('planUseTemplate'); if (ut) ut.onclick = () => modal('Usar la plantilla de la finca', '¿Descartar esta copia del evento y volver a usar la plantilla de la finca? Se perderán los cambios de la copia.', { okText: 'Descartar copia', danger: true, onOk: async () => { await planoSrv.delAll('ev_' + PLAN.eventId); location.hash = '#/eventos/' + PLAN.eventId; } });
    const st = el('planStage');
    st.addEventListener('click', e => { if (e.target.closest('#planDropBtn')) el('planUp').click(); });
    st.addEventListener('pointerdown', planoDown);
  }
  if (!window._planMoveBound) { window.addEventListener('pointermove', planoMove); window.addEventListener('pointerup', planoUp); window._planMoveBound = 1; }
}
function planoDown(e) {
  if (!PLAN || PLAN.readOnly) return;
  const h = e.target.closest('.pm-h');
  if (h) { DRAGP = { mode: 'end', which: h.dataset.h }; e.preventDefault(); return; }
  const pm = e.target.closest('.pm');
  if (pm) { PLAN.sel = pm.dataset.id; const m = PLAN.marks.find(x => x.id === PLAN.sel); const p = planoPct(e); DRAGP = { mode: 'move', id: m.id, ox: p.x - m.x, oy: p.y - m.y }; planoRenderStage(); e.preventDefault(); return; }
  const ln = e.target.closest('.pl-hit');
  if (ln) { PLAN.sel = ln.dataset.id; const l = PLAN.marks.find(x => x.id === PLAN.sel); const p = planoPct(e); DRAGP = { mode: 'lineMove', sx: p.x, sy: p.y, o: { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 } }; planoRenderStage(); e.preventDefault(); return; }
  if (PLAN.sel) { PLAN.sel = null; planoRenderStage(); }
}
function planoMove(e) {
  if (!DRAGP || !el('planStage')) return;
  const p = planoPct(e); const sel = PLAN.marks.find(x => x.id === PLAN.sel); if (!sel) return;
  if (DRAGP.mode === 'move') { sel.x = clampp(p.x - DRAGP.ox); sel.y = clampp(p.y - DRAGP.oy); }
  else if (DRAGP.mode === 'end') { if (DRAGP.which === '1') { sel.x1 = p.x; sel.y1 = p.y; } else { sel.x2 = p.x; sel.y2 = p.y; } }
  else if (DRAGP.mode === 'lineMove') { const dx = p.x - DRAGP.sx, dy = p.y - DRAGP.sy; sel.x1 = clampp(DRAGP.o.x1 + dx); sel.y1 = clampp(DRAGP.o.y1 + dy); sel.x2 = clampp(DRAGP.o.x2 + dx); sel.y2 = clampp(DRAGP.o.y2 + dy); }
  planoRenderStage();
}
function planoUp() { if (DRAGP) { DRAGP = null; planoSaveMarks(); } }

/* --- Render de solo lectura del plano (para la pestaña Ruta y el PDF) --- */
function planoMarkHTML2(m) {
  const s = PLAN_SYMS[m.t] || { cls: '' };
  const inner = s.txt ? `<span>${s.txt}</span>` : '';
  return `<div class="pm ${s.cls}" style="left:${m.x}%;top:${m.y}%;transform:translate(-50%,-50%) rotate(${m.rot || 0}deg)">${inner}${m.label ? `<span class="pm-lbl" style="transform:translateX(-50%) rotate(${-(m.rot || 0)}deg)">${esc(m.label)}</span>` : ''}</div>`;
}
async function planoPreviewHTML(locId, zona) { return planoPreviewByKey(locId + '_' + zona); }
async function planoPreviewByKey(keyBase) {
  const d = await planoSrv.get(keyBase);
  const marks = d.marks || [];
  const img = d.hasImg ? planoSrv.imgUrl(keyBase) : null;
  if (!img && !marks.length) return '';
  const lines = marks.filter(m => m.t === 'line');
  let h = `<div class="plan-view">`;
  if (img) h += `<img src="${img}" alt="">`; else h += `<div class="plan-view-noimg">Croquis sin imagen de fondo</div>`;
  h += `<svg class="plan-lines" viewBox="0 0 100 100" preserveAspectRatio="none">` + lines.map(l => {
    const c = (PLAN_LINES[l.sub] || {}).col || '#fff';
    return `<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="${c}" stroke-width="0.9" stroke-linecap="round"/>`;
  }).join('') + `</svg>`;
  h += marks.filter(m => m.t !== 'line').map(planoMarkHTML2).join('');
  h += `</div>`;
  return h;
}
// Planos de un evento, por zonas (recomendado) o único (packs). Usado por la hoja de ruta (deck).
async function planoZonesForEvent(ev) {
  const pack = tipoToPack(ev.tipo);
  if (!ev.lugar || !pack || planoBlocked(ev.lugar, pack)) return [];
  const out = [];
  if (pack === 'recomendado') {
    for (const z of RECO_ZONAS) {
      let html = await planoPreviewByKey('ev_' + ev.id + '_' + z[0]);
      if (!html) html = await planoPreviewByKey(planoLoc(ev.lugar) + '_recomendado_' + z[0]);
      if (!html && z[0] === 'ceremonia') html = await planoPreviewByKey(planoLoc(ev.lugar) + '_recomendado');
      if (html) out.push({ label: z[1], html });
    }
  } else {
    let html = await planoPreviewByKey('ev_' + ev.id);
    if (!html) html = await planoPreviewByKey(planoLoc(ev.lugar) + '_' + pack);
    if (html) out.push({ label: zonaLabel(pack, pack), html });
  }
  return out;
}
async function loadRutaPlano(ev) {
  const box = el('rutaPlano'); if (!box) return;
  if (!ev.lugar) { box.innerHTML = ''; return; }
  const pack = tipoToPack(ev.tipo);
  if (!pack) { box.innerHTML = `<div class="panel ruta-plano-empty"><div class="panel__body"><p class="hint">El tipo "<b>${esc(ev.tipo || '—')}</b>" no tiene pack de montaje predefinido. <a href="#/plano/${ev.lugar}">Ver planos de la finca →</a></p></div></div>`; return; }
  if (planoBlocked(ev.lugar, pack)) { box.innerHTML = ''; return; }
  const editBtn = `<a class="btn btn--sm btn--primary" href="#/plano-ev/${ev.id}">Editar plano del evento</a>`;
  const zones = await planoZonesForEvent(ev);
  if (!zones.length) { box.innerHTML = `<div class="panel ruta-plano-empty"><div class="panel__body"><p class="hint">Aún no hay plano de montaje para esta boda. ${editBtn} · o define la <a href="#/plano/${ev.lugar}">plantilla de la finca →</a></p></div></div>`; return; }
  box.innerHTML = `<div class="panel ruta-plano-panel"><div class="panel__head"><h3>🗺️ Plano de montaje${zones.length > 1 ? ' · por zonas' : ''}</h3>${editBtn}</div><div class="panel__body">${zones.map(z => `<div class="ruta-plano-zone"><div class="rpz-lbl">${esc(z.label)}</div><div class="ruta-plano-single">${z.html}</div></div>`).join('')}</div></div>`;
}
window.loadRutaPlano = loadRutaPlano; // para que lo invoque app-pages.js al abrir la pestaña Ruta
window.planoPreviewHTML = planoPreviewHTML;
window.planoPreviewByKey = planoPreviewByKey;
window.planoZonesForEvent = planoZonesForEvent; // lo usa la hoja de ruta (deck) en app-pages
window.tipoToPack = tipoToPack;

/* =========================================================================
   CONTROL HORARIO  (admin: todos · dj: lo suyo)
   ========================================================================= */
const slotsTxt = a => (a.slots || []).map(s => `Entrada: ${s.in} · Salida: ${s.out}`).join('<br>');
const attMin = a => (a.slots || []).reduce((t, s) => { let d = toMin(s.out) - toMin(s.in); if (d < 0) d += 1440; return t + d; }, 0);
on(/^#\/horario$/, async () => {
  if (S.user.role === 'dj' && !S.user.time_tracking) { shell('<div class="empty">No tienes control horario habilitado.</div>', ['Control horario']); return; }
  loading(['Control horario']);
  const items = await coll.list('attendances');
  const admin = isAdmin();
  const cols = [
    { t: 'Id', get: a => a.id },
    ...(admin ? [{ t: 'Usuario', get: a => a.userName || userName(a.userId) }] : []),
    { t: 'Fecha', get: a => a.date || '' },
    { t: 'Franja horaria', get: a => slotsTxt(a).replace(/<br>/g, ' '), html: a => slotsTxt(a) },
    { t: 'Horas', get: a => attMin(a), html: a => hm(attMin(a)) },
    { t: 'Comentario', get: a => a.comment || '' },
    { t: '', nosort: true, html: a => `<div class="row-actions"><button class="btn btn--sm" data-edit="${a.id}">Editar</button><button class="btn btn--icon" data-del="${a.id}">🗑</button></div>` },
  ];
  const links = admin ? `<div class="btn-row"><button class="btn" id="newAtt">+ Fichaje</button><a class="btn" href="#/horario/calendario">Calendario</a><a class="btn" href="#/horario/resumen">Resumen</a></div>`
    : `<div class="btn-row"><button class="btn btn--primary" id="newAtt">+ Registrar jornada</button></div>`;
  shell(`${pageHead('Control horario', admin ? 'Fichajes de todo el equipo.' : 'Tus jornadas registradas.', links)}
    <div class="panel"><div class="panel__body">${table('dtAtt', { rows: items, order: [admin ? 2 : 1, 'desc'], cols, empty: 'Sin fichajes.' })}</div></div>`, ['Control horario']);
  el('newAtt').onclick = () => attForm({ date: ymd(TODAY), slots: [{ in: '09:00', out: '14:00' }] });
  bindTable('dtAtt', () => {
    $$('[data-edit]').forEach(b => b.onclick = () => attForm(items.find(a => a.id == b.dataset.edit)));
    $$('[data-del]').forEach(b => b.onclick = () => modal('Borrar', '¿Eliminar este fichaje?', { okText: 'Eliminar', danger: true, onOk: async () => { await coll.del('attendances', b.dataset.del); toast('Eliminado', 'ok'); location.hash = '#/horario'; CS.route ? location.reload() : location.reload(); } }));
  });
});
function attForm(a) {
  const slotHtml = s => `<div class="svc-row" data-slot style="grid-template-columns:1fr 1fr auto"><input class="control" type="time" data-in value="${esc(s.in || '')}"><input class="control" type="time" data-out value="${esc(s.out || '')}"><button type="button" class="btn btn--icon" data-del-slot>✕</button></div>`;
  const workerOpts = [['', 'Selecciona trabajador']].concat((S.meta.staff || []).map(u => [u.id, u.name]));
  const bg = modal(a.id ? 'Editar jornada' : 'Registrar jornada', `<form id="attForm">
    ${isAdmin() && !a.id ? `<div class="field"><label>Trabajador</label>${sel('userId', workerOpts, '')}</div>` : ''}
    <div class="field"><label>Fecha</label>${inp('date', a.date, { type: 'date' })}</div>
    <label style="font-weight:700;font-size:13px">Franjas horarias</label><div id="slotBox" style="margin:8px 0">${(a.slots || []).map(slotHtml).join('')}</div>
    <button type="button" class="btn btn--sm" id="addSlot">+ Añadir franja</button>
    <div class="field" style="margin-top:14px"><label>Comentario</label>${ta('comment', a.comment)}</div></form>`,
    { okText: 'Guardar', onOk: async () => {
      const d = collectForm($('#attForm'));
      const slots = $$('[data-slot]', bg).map(r => ({ in: $('[data-in]', r).value, out: $('[data-out]', r).value })).filter(s => s.in && s.out);
      const rec = Object.assign({ id: a.id }, { date: d.date, comment: d.comment, slots });
      if (isAdmin()) { const uid = a.userId || +d.userId || 0; if (uid) { rec.userId = uid; rec.userName = a.userName || userName(uid); } }
      await coll.save('attendances', rec); toast('Guardado', 'ok'); location.hash = '#/horario'; location.reload();
    } });
  $('#addSlot', bg).onclick = () => $('#slotBox', bg).insertAdjacentHTML('beforeend', slotHtml({}));
  bg.addEventListener('click', e => { if (e.target.closest('[data-del-slot]')) e.target.closest('[data-slot]').remove(); });
}

/* calendario (admin) */
let calCursor = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
// color por trabajador para el calendario (su color de agenda, o uno estable por id)
function colorOf(id) { const u = (S.meta.staff || []).find(x => x.id == id); if (u && u.color) return u.color; return 'hsl(' + (((+id || 0) * 47) % 360) + ',62%,45%)'; }
function renderCalendar(evsForDay) {
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  const first = new Date(y, m, 1), offset = (first.getDay() + 6) % 7;
  const start = new Date(y, m, 1 - offset);
  const dows = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  let cells = dows.map(d => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); const k = ymd(d);
    cells += `<div class="cell ${d.getMonth() !== m ? 'other' : ''} ${k === ymd(TODAY) ? 'today' : ''}"><div class="n">${d.getDate()}</div>${evsForDay(k).map(e => `<div class="cal-ev" style="background:${e.c}">${esc(e.t)}</div>`).join('')}</div>`; }
  return `<div class="cal-head"><h3>${MONTHS[m]} ${y}</h3><div class="btn-row"><button class="btn btn--sm" data-cal="-1">‹</button><button class="btn btn--sm" data-cal="0">Hoy</button><button class="btn btn--sm" data-cal="1">›</button></div></div><div class="cal-grid">${cells}</div>`;
}
on(/^#\/horario\/calendario$/, async () => {
  if (!requireAdmin()) return; loading(['Control horario', 'Calendario']);
  const items = await coll.list('attendances');
  function draw() {
    const y = calCursor.getFullYear(), m = calCursor.getMonth(); const pre = y + '-' + pad(m + 1);
    const inMonth = items.filter(a => (a.date || '').startsWith(pre));
    const totals = {}; inMonth.forEach(a => totals[a.userName || a.userId] = (totals[a.userName || a.userId] || 0) + attMin(a));
    shell(`${pageHead('Calendario de fichajes', 'Vista mensual del equipo.', `<a class="btn" href="#/horario">Listado</a>`)}
      <div class="panel"><div class="panel__body">${renderCalendar(k => inMonth.filter(a => a.date === k).map(a => ({ t: (a.userName || userName(a.userId)) + ' · ' + hm(attMin(a)) + 'h', c: colorOf(a.userId) })))}
        <div class="legend">${Object.entries(totals).map(([n, t]) => `<div style="background:#130F17">${esc(n)} — ${hm(t)} h</div>`).join('') || '<p>Sin fichajes este mes.</p>'}</div></div></div>`, ['Control horario', 'Calendario']);
    $$('[data-cal]').forEach(b => b.onclick = () => { const n = +b.dataset.cal; calCursor = n === 0 ? new Date(TODAY.getFullYear(), TODAY.getMonth(), 1) : new Date(calCursor.getFullYear(), calCursor.getMonth() + n, 1); draw(); });
  }
  draw();
});
on(/^#\/horario\/resumen$/, async () => {
  if (!requireAdmin()) return;
  let end = '';
  const draw = async () => {
    loading(['Control horario', 'Resumen']);
    const res = await api('attendance-summary' + (end ? '?end=' + encodeURIComponent(end) : ''));
    end = res.end;
    shell(`${pageHead('Resumen de horas (últimos 4 meses)', 'Horas por trabajador. Las vacaciones aprobadas cuentan como 8 h por día laborable, una vez llega el día. Puedes retroceder los meses que quieras.')}
      <div class="panel"><div class="panel__head"><h3>${esc(res.months[3])} — ${esc(res.months[0])}</h3>
        <div class="btn-row"><button class="btn btn--sm" id="mPrev">‹ Meses anteriores</button><button class="btn btn--sm" id="mNext" ${res.next ? '' : 'disabled'}>Meses siguientes ›</button></div></div>
      <div class="panel__body">${table('dtSum', { rows: res.rows, order: [2, 'desc'], filters: true, cols: [
        { t: 'Id', get: w => w.id }, { t: 'Usuario', get: w => w.name },
        { t: res.months[0], get: w => w.m0, html: w => hm(w.m0) + ' h' },
        { t: res.months[1], get: w => w.m1, html: w => hm(w.m1) + ' h' },
        { t: res.months[2], get: w => w.m2, html: w => hm(w.m2) + ' h' },
        { t: res.months[3], get: w => w.m3, html: w => hm(w.m3) + ' h' },
      ] })}</div></div>`, ['Control horario', 'Resumen']);
    el('mPrev').onclick = () => { end = res.prev; draw(); };
    const nx = el('mNext'); if (nx && res.next) nx.onclick = () => { end = res.next; draw(); };
  };
  draw();
});

/* =========================================================================
   VACACIONES
   ========================================================================= */
on(/^#\/vacaciones$/, async () => {
  // Las vacaciones solo las ven/gestionan admin y trabajadores con control horario (fichaje).
  if (!isAdmin() && !(S.user && S.user.time_tracking)) { shell('<div class="empty">Las vacaciones solo están disponibles para el personal con control horario.</div>', ['Vacaciones']); return; }
  loading(['Vacaciones']);
  const items = await coll.list('vacations');
  const admin = isAdmin();
  const stTag = s => s === 'Aprobado' ? '<span class="tag tag--green">Aprobado</span>' : s === 'Denegado' ? '<span class="tag tag--red">Denegado</span>' : '<span class="tag tag--yellow">Solicitado</span>';
  const rows = items.slice().sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  const stColor = s => s === 'Aprobado' ? '#2e7d32' : s === 'Denegado' ? '#d9534f' : '#f0ad4e';
  shell(`${pageHead('Vacaciones', admin ? 'Solicitudes de todo el equipo.' : 'Tus solicitudes de vacaciones.', `<button class="btn btn--primary" id="newVac">+ Solicitar</button>`)}
    <div class="panel"><div class="panel__head"><h3>Solicitudes</h3></div><div class="panel__body"><div class="table-wrap"><table class="dt"><thead><tr>${admin ? '<th>Usuario</th>' : ''}<th>Inicio</th><th>Fin</th><th>Estado</th><th></th></tr></thead><tbody>
      ${rows.length ? rows.map(v => `<tr>${admin ? `<td>${esc(userName(v.userId))}</td>` : ''}<td>${dmy(v.start)}</td><td>${dmy(v.end)}</td><td>${stTag(v.status)}</td>
        <td class="row-actions">${admin ? `${v.status !== 'Aprobado' ? `<button class="btn btn--sm btn--blue" data-set="${v.id}" data-st="Aprobado">Aprobar</button>` : ''}${v.status !== 'Denegado' ? `<button class="btn btn--xs btn--red" data-set="${v.id}" data-st="Denegado">Denegar</button>` : ''}` : ''}<button class="btn btn--icon" data-del="${v.id}">🗑</button></td></tr>`).join('') : `<tr><td class="td-empty" colspan="${admin ? 5 : 4}">Sin solicitudes.</td></tr>`}
    </tbody></table></div></div></div>
    <div class="panel"><div class="panel__head"><h3>Calendario de vacaciones</h3></div><div class="panel__body" id="vacCal"></div></div>`, ['Vacaciones']);
  const dayFn = k => items.filter(v => v.start && v.end && k >= v.start && k <= v.end).map(v => ({ t: admin ? userName(v.userId) : 'Vacaciones', c: stColor(v.status) }));
  const drawVacCal = () => {
    const box = el('vacCal'); if (!box) return;
    box.innerHTML = renderCalendar(dayFn) + `<div class="legend"><div style="background:#2e7d32">Aprobadas</div><div style="background:#f0ad4e">Solicitadas</div><div style="background:#d9534f">Denegadas</div></div>`;
    $$('[data-cal]', box).forEach(b => b.onclick = () => { const n = +b.dataset.cal; calCursor = n === 0 ? new Date(TODAY.getFullYear(), TODAY.getMonth(), 1) : new Date(calCursor.getFullYear(), calCursor.getMonth() + n, 1); drawVacCal(); });
  };
  drawVacCal();
  el('newVac').onclick = () => {
    const bg = modal('Solicitar vacaciones', `<form id="vForm"><div class="grid-2"><div class="field"><label>Desde</label>${inp('start', '', { type: 'date' })}</div><div class="field"><label>Hasta</label>${inp('end', '', { type: 'date' })}</div></div></form>`,
      { okText: 'Enviar solicitud', onOk: async () => { const d = collectForm($('#vForm')); if (!d.start || !d.end) { toast('Indica las fechas', 'err'); return true; } await coll.save('vacations', { start: d.start, end: d.end, status: isAdmin() ? 'Aprobado' : 'Solicitado' }); toast('Solicitud enviada', 'ok'); location.reload(); } });
  };
  $$('[data-set]').forEach(b => b.onclick = async () => { const v = items.find(x => x.id == b.dataset.set); await coll.save('vacations', Object.assign({}, v, { status: b.dataset.st })); toast('Actualizado', 'ok'); location.reload(); });
  $$('[data-del]').forEach(b => b.onclick = () => modal('Borrar', '¿Eliminar esta solicitud?', { okText: 'Eliminar', danger: true, onOk: async () => { await coll.del('vacations', b.dataset.del); location.reload(); } }));
});

/* =========================================================================
   FACTURACIÓN DE EQUIPO (admin) + MIS PAGOS (dj)
   ========================================================================= */
// Nóminas: subida/consulta de nóminas (PDF) por trabajador, agrupadas por año y mes. Admin ve a todos
// (selector de trabajador) y puede subir; cada trabajador ve y sube las suyas. Se guardan en el servidor.
const NOM_MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
// IMPAGOS: facturas de Holded con importe pendiente, para localizar y cobrar sin ir a Holded.
on(/^#\/impagos$/, async () => {
  if (!isAdmin()) { location.hash = '#/'; return; }
  const eur = n => (Math.round((+n || 0) * 100) / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const ignoreImp = async (invId, ignore) => { try { await api('holded-unpaid/ignore', { method: 'POST', body: { invId, ignore } }); toast(ignore ? 'Quitada de impagos' : 'Restaurada a impagos', 'ok'); draw(); } catch (e) { toast(e.message || 'Error', 'err'); } };
  async function draw() {
    loading(['Impagos']);
    const r = await api('holded-unpaid').catch(() => ({ invoices: [] }));
    if (r.enabled === false) { shell(`${pageHead('Impagos', 'Facturas pendientes de cobro.')}<div class="empty">La integración de Holded no está activada.</div>`, ['Impagos']); return; }
    const invs = r.invoices || [];
    const totalPend = invs.reduce((s, i) => s + (+i.pending || 0), 0);
    const overdueN = invs.filter(i => i.overdue).length;
    const cols = [
      { t: 'Vence', get: i => i.dueDate || i.date || '', html: i => `<span style="${i.overdue ? 'color:var(--danger,#D50000);font-weight:700' : ''}">${esc(slash(i.dueDate || i.date) || '—')}${i.overdue ? ' ⚠' : ''}</span>` },
      { t: 'Nº', get: i => i.number || '' },
      { t: 'Cliente', get: i => i.contactName || '', html: i => `<b>${esc(i.contactName || '—')}</b>` },
      { t: 'Concepto', get: i => i.desc || '' },
      { t: 'Total', get: i => i.total || 0, num: true, html: i => eur(i.total) },
      { t: 'Pendiente', get: i => i.pending || 0, num: true, html: i => `<b>${eur(i.pending)}</b>` },
      { t: 'Boda', nosort: true, nofilter: true, html: i => i.event ? `<a href="#/eventos/${i.event.id}" title="${esc(i.event.conyuges || '')}${i.event.fecha ? ' · ' + slash(i.event.fecha) : ''}">#${i.event.id}</a>` : '<span class="muted">—</span>' },
      { t: '', nosort: true, nofilter: true, html: i => `<a class="btn btn--icon" href="/api/holded-pdf?inv=${encodeURIComponent(i.id)}" target="_blank" rel="noopener" title="Ver / descargar factura">📄</a> <button class="btn btn--icon" data-ignore-imp="${esc(i.id)}" title="Quitar de impagos (ya pagada / error en Holded)">🚫</button>` },
    ];
    const ign = r.ignoradas || [];
    const igPanel = ign.length ? `<details style="margin-top:18px"><summary class="hint" style="cursor:pointer">🚫 Quitadas de impagos (${ign.length}) — ver / restaurar</summary><div class="panel" style="margin-top:8px"><div class="panel__body">${table('dtImpIgn', { rows: ign, order: [0, 'asc'], filters: false, dense: true, len: 50, empty: '', cols: [
      { t: 'Nº', get: i => i.number || '' },
      { t: 'Cliente', get: i => i.contactName || '', html: i => `<b>${esc(i.contactName || '—')}</b>` },
      { t: 'Pendiente', get: i => i.pending || 0, num: true, html: i => eur(i.pending) },
      { t: '', nosort: true, nofilter: true, html: i => `<button class="btn btn--xs" data-restore-imp="${esc(i.id)}">↩ Restaurar</button>` },
    ] })}</div></div></details>` : '';
    shell(`${pageHead('Impagos', `${invs.length} factura(s) pendiente(s)${overdueN ? ` · ${overdueN} vencida(s)` : ''} · ${eur(totalPend)} por cobrar`)}
      <div class="panel"><div class="panel__body">${table('dtImpagos', { rows: invs, order: [0, 'asc'], filters: true, dense: true, len: 50, cols, empty: 'No hay facturas pendientes. 🎉' })}</div></div>
      ${igPanel}`, ['Impagos']);
    bindTable('dtImpagos', () => { $$('[data-ignore-imp]').forEach(b => b.onclick = () => ignoreImp(b.dataset.ignoreImp, true)); });
    bindTable('dtImpIgn', () => { $$('[data-restore-imp]').forEach(b => b.onclick = () => ignoreImp(b.dataset.restoreImp, false)); });
  }
  draw();
});
on(/^#\/descuadres$/, async () => {
  if (!isAdmin()) { location.hash = '#/'; return; }
  const eur = n => (Math.round((+n || 0) * 100) / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  async function draw(refresh) {
    loading(['Descuadres']);
    const r = await api('holded-descuadres' + (refresh ? '?refresh=1' : '')).catch(() => ({ sinVincular: [] }));
    if (r.enabled === false) { shell(`${pageHead('Descuadre facturas', 'Facturas de Holded sin vincular a un evento.')}<div class="empty">La integración de Holded no está activada.</div>`, ['Descuadres']); return; }
    const sv = r.sinVincular || [];
    const cols = [
      { t: 'Fecha', get: i => i.date || '', html: i => esc(slash(i.date) || '—') },
      { t: 'Nº', get: i => i.number || '' },
      { t: 'Cliente', get: i => i.contact || '', html: i => `<b>${esc(i.contact || '—')}</b>` },
      { t: 'Base', get: i => i.total || 0, num: true, html: i => eur(i.total) },
      { t: 'Pendiente', get: i => i.pending || 0, num: true, html: i => eur(i.pending) },
      { t: 'Boda sugerida (por el PDF)', nosort: true, nofilter: true, html: i => i.suggestedEventId
        ? `<button class="btn btn--xs btn--primary" data-link-sug="${esc(i.invId)}" data-ev="${i.suggestedEventId}" title="Vincular a la boda detectada por la fecha y el lugar del concepto">↩ Vincular ${esc(i.suggestedLabel || ('#' + i.suggestedEventId))}</button>${i.catWarn ? `<div class="hint" style="color:#D50000;margin-top:3px">⚠ ${esc(i.catWarn)}</div>` : ''}`
        : (i.options && i.options.length
          ? `<div class="hint" style="margin-bottom:3px">Varias posibles ese día, ¿cuál?</div>${i.options.map(o => `<button class="btn btn--xs" data-link-sug="${esc(i.invId)}" data-ev="${o.id}" style="margin:0 3px 3px 0" title="Vincular a esta boda">↩ ${esc(o.label)}</button>`).join('')}`
          : (i.catWarn ? `<span class="hint" style="color:#D50000">⚠ ${esc(i.catWarn)}</span>` : `<span class="hint" title="${esc(i.concept || '')}">${i.why ? esc(i.why) : '—'}</span>`)) },
      { t: '', nosort: true, nofilter: true, html: i => `${i.invId ? `<button class="btn btn--icon" data-link-inv="${esc(i.invId)}" title="Vincular a mano a otra boda">🔗</button> <a class="btn btn--icon" href="/api/holded-pdf?inv=${encodeURIComponent(i.invId)}" target="_blank" rel="noopener" title="Ver / descargar factura">📄</a> <button class="btn btn--icon" data-ignore-inv="${esc(i.invId)}" title="Obviar (quitar de la lista)">🚫</button>` : ''}` },
    ];
    const sw = (r.serviceWarnings || []).map(w => Object.assign({}, w, { svc: (w.services || []).join(', ') }));
    const swPanel = sw.length ? `
      <h3 class="form-sub" style="margin-top:24px">⚠ Servicios reservados y pagados sin crear en Servicios (${sw.length})</h3>
      <p class="hint" style="margin-bottom:10px">Facturas <b>pagadas</b> de <b>bodas por celebrar (a futuro)</b> cuyo concepto menciona un servicio (fotomatón, fuego frío…) que <b>no existe en la pestaña Servicios</b>. Conviene crearlo para gestionarlo bien. Las <b>no pagadas</b> y las de bodas ya pasadas no salen.</p>
      <div class="panel"><div class="panel__body">${table('dtSvcWarn', { rows: sw, order: [0, 'desc'], filters: true, dense: true, len: 50, empty: '', cols: [
        { t: 'Fecha', get: i => i.date || '', html: i => esc(slash(i.date) || '—') },
        { t: 'Nº', get: i => i.number || '' },
        { t: 'Cliente', get: i => i.contact || '', html: i => `<b>${esc(i.contact || '—')}</b>` },
        { t: 'Servicio detectado', get: i => i.svc, html: i => `<b style="color:#D50000">${esc(i.svc)}</b>` },
        { t: 'Importe', get: i => i.total || 0, num: true, html: i => eur(i.total) },
        { t: '', nosort: true, nofilter: true, html: i => `<a class="btn btn--icon" href="/api/holded-pdf?inv=${encodeURIComponent(i.invId)}" target="_blank" rel="noopener" title="Ver factura">📄</a>` },
      ] })}</div></div>` : '';
    const pm = r.payMismatches || [];
    const pmPanel = pm.length ? `
      <h3 class="form-sub" style="margin-top:24px">⚠ Descuadre pagado (Holded vs apuntado) (${pm.length})</h3>
      <p class="hint" style="margin-bottom:10px">Bodas donde <b>lo pagado según Holded</b> no coincide con el <b>pagado apuntado a mano</b> en el evento. <b>Diferencia positiva</b> = han pagado más de lo apuntado (falta apuntarlo). Las <b>rectificativas (CN)</b> ya se restan aquí (una CN de −150 baja el pagado de Holded en 150). Solo es para <b>verificar</b>: no cambia nada automáticamente.</p>
      <div class="panel"><div class="panel__body">${table('dtPayMis', { rows: pm, order: [0, 'desc'], filters: true, dense: true, len: 50, empty: '', cols: [
        { t: 'Fecha', get: i => i.fecha || '', html: i => esc(slash(i.fecha) || '—') },
        { t: 'Boda', nosort: true, nofilter: true, html: i => `<a href="#/eventos/${i.eventId}" title="${esc(i.conyuges || '')}">#${i.eventId}</a>` },
        { t: 'Lugar', get: i => i.lugar || '', html: i => esc(i.lugar || '—') },
        { t: 'Pagado en Holded', get: i => i.paidHolded || 0, num: true, html: i => eur(i.paidHolded) },
        { t: 'Apuntado (evento)', get: i => i.pagado || 0, num: true, html: i => eur(i.pagado) },
        { t: 'Diferencia', get: i => i.diff || 0, num: true, html: i => `<b style="color:#D50000">${(i.diff > 0 ? '+' : '')}${eur(i.diff)}</b>` },
      ] })}</div></div>` : '';
    const cs = r.conceptStats || {};
    const csLine = cs.total ? `<p class="hint" style="margin-bottom:12px">📄 Concepto leído de Holded en <b>${cs.withConcept || 0}/${cs.total}</b> facturas · fecha detectada en <b>${cs.withDate || 0}</b>.${cs.sample ? ` <span class="muted">Ejemplo de concepto: "${esc(String(cs.sample).slice(0, 120))}"</span>` : ''}</p>` : '';
    const ig = r.ignoradas || [];
    const igPanel = ig.length ? `<details style="margin-top:18px"><summary class="hint" style="cursor:pointer">🚫 Obviadas (${ig.length}) — ver / restaurar</summary><div class="panel" style="margin-top:8px"><div class="panel__body">${table('dtIgnoradas', { rows: ig, order: [0, 'desc'], filters: false, dense: true, len: 50, empty: '', cols: [
      { t: 'Fecha', get: i => i.date || '', html: i => esc(slash(i.date) || '—') },
      { t: 'Nº', get: i => i.number || '' },
      { t: 'Cliente', get: i => i.contact || '', html: i => `<b>${esc(i.contact || '—')}</b>` },
      { t: 'Importe', get: i => i.total || 0, num: true, html: i => eur(i.total) },
      { t: '', nosort: true, nofilter: true, html: i => `<button class="btn btn--xs" data-restore-inv="${esc(i.invId)}">↩ Restaurar</button> <a class="btn btn--icon" href="/api/holded-pdf?inv=${encodeURIComponent(i.invId)}" target="_blank" rel="noopener" title="Ver factura">📄</a>` },
    ] })}</div></div></details>` : '';
    const sugList = sv.filter(i => i.suggestedEventId && !i.catWarn);
    shell(`${pageHead('Descuadre facturas / eventos', 'Facturas de Holded que NO están vinculadas a ningún evento (posible falta de vinculación).')}
      <div class="btn-row" style="margin-bottom:12px"><button class="btn btn--sm" id="descRefresh" title="Vuelve a leer contactos y facturas de Holded (gasta llamadas de la API; úsalo solo cuando hayas cambiado algo en Holded)">↻ Actualizar desde Holded</button> <span class="hint">Los datos se guardan 1 hora para no gastar llamadas; pulsa aquí si acabas de cambiar algo en Holded.</span></div>
      <div class="grid-3" style="margin-bottom:14px">
        <div class="stat stat--pink"><div class="k">Facturas sin vincular</div><div class="v">${r.sinVincularN || 0}</div></div>
        <div class="stat stat--blue"><div class="k">Facturas vinculadas a boda</div><div class="v">${r.linkedInv || 0}</div></div>
        <div class="stat"><div class="k">Excluidas (empresas + pasadas + sin pagar)</div><div class="v">${(r.empresaInv || 0) + (r.antiguasInv || 0) + (r.pasadasInv || 0) + (r.sinPagarInv || 0)}</div></div>
      </div>
      <p class="hint" style="margin-bottom:8px">Salen facturas a <b>personas</b>, de <b>bodas por celebrar</b> y <b>con algún pago</b> (las <b>sin pagar</b> no salen: la reserva no está confirmada y aún no hay evento). Cuando el concepto trae la <b>fecha y el lugar</b>, te propongo la boda y la vinculas con un clic (↩). Si el <b>pack</b> no coincide, sale un aviso. También puedes vincular a mano (🔗).</p>
      ${csLine}
      ${sugList.length ? `<div class="btn-row" style="margin-bottom:12px"><button class="btn btn--primary" id="linkAllSug">↩ Vincular todas las sugeridas sin aviso (${sugList.length})</button> <span class="hint">Las que tienen aviso ⚠ se quedan sin vincular para que las revises.</span></div>` : ''}
      <div class="panel"><div class="panel__body">${table('dtDescuadres', { rows: sv, order: [0, 'desc'], filters: true, dense: true, len: 50, cols, empty: 'No hay facturas sin vincular. 🎉' })}</div></div>
      ${swPanel}
      ${pmPanel}
      ${igPanel}`, ['Descuadres']);
    const linkInv = async (invId, id) => { try { const res = await api('holded-descuadres/link', { method: 'POST', body: { invId, eventId: id } }); toast('✅ Factura vinculada' + (res.conyuges ? ' a ' + res.conyuges : ' a la boda #' + id), 'ok'); draw(); } catch (e) { toast(e.message || 'Error', 'err'); } };
    // Se re-enganchan tras cada orden/filtro/paginación de la tabla (si no, al re-dibujarse se perdían los clicks).
    const ignoreInv = async (invId, ignore) => { try { await api('holded-descuadres/ignore', { method: 'POST', body: { invId, ignore } }); toast(ignore ? 'Factura obviada' : 'Factura restaurada', 'ok'); draw(); } catch (e) { toast(e.message || 'Error', 'err'); } };
    function wireLinks() {
      $$('[data-link-sug]').forEach(b => b.onclick = () => linkInv(b.dataset.linkSug, +b.dataset.ev));
      $$('[data-ignore-inv]').forEach(b => b.onclick = () => ignoreInv(b.dataset.ignoreInv, true));
      $$('[data-link-inv]').forEach(b => b.onclick = () => {
        const invId = b.dataset.linkInv;
        modal('Vincular factura a una boda', `<p class="hint" style="margin-bottom:10px">Escribe el <b>número de la boda</b> (evento) al que pertenece esta factura. Lo ves en el listado de eventos o con el buscador.</p><div class="field"><label>Nº de boda</label><input class="control" id="linkEvId" type="number" inputmode="numeric" placeholder="p. ej. 1234"></div>`, {
          okText: 'Vincular', onOk: async () => {
            const id = +(el('linkEvId') || {}).value; if (!id) { toast('Pon un número de boda', 'err'); return true; }
            try { const res = await api('holded-descuadres/link', { method: 'POST', body: { invId, eventId: id } }); toast('✅ Factura vinculada' + (res.conyuges ? ' a ' + res.conyuges : ' a la boda #' + id), 'ok'); } catch (e) { toast(e.message || 'Error', 'err'); return true; }
            draw();
          }
        });
      });
    }
    bindTable('dtDescuadres', wireLinks);
    bindTable('dtIgnoradas', () => { $$('[data-restore-inv]').forEach(b => b.onclick = () => ignoreInv(b.dataset.restoreInv, false)); });
    const lab = el('linkAllSug'); if (lab) lab.onclick = () => {
      modal('Vincular todas las sugeridas', `<p>Se vincularán <b>${sugList.length}</b> facturas a la boda que propone su concepto (fecha + lugar). Las que tienen aviso ⚠ se dejan sin vincular para que las revises. <b>No cambia ningún importe pagado.</b></p>`, {
        okText: 'Vincular ' + sugList.length, onOk: async () => {
          let okN = 0, failN = 0;
          for (const i of sugList) { try { await api('holded-descuadres/link', { method: 'POST', body: { invId: i.invId, eventId: i.suggestedEventId } }); okN++; } catch (e) { failN++; } }
          toast('✅ Vinculadas ' + okN + (failN ? ' · ' + failN + ' con error' : ''), 'ok');
          draw();
        }
      });
    };
    const rfb = el('descRefresh'); if (rfb) rfb.onclick = () => { rfb.disabled = true; rfb.textContent = 'Actualizando…'; draw(true); };
  }
  draw();
});

/* =========================================================================
   FOTOMATÓN (admin): dos sub-pestañas — Realizadas (línea entera VERDE = fotos
   subidas o ya entregadas; ROJO = pendiente de subir) y Próximas (aún sin
   celebrar). Las bodas de sept. 2026 hacia atrás se dan por entregadas (verde).
   ========================================================================= */
on(/^#\/fotomaton$/, async () => {
  if (!isAdmin()) { location.hash = '#/'; return; }
  let tab = 'real';
  async function draw() {
    loading(['Fotomatón']);
    const r = await api('fotomaton').catch(() => ({ events: [], cutoff: '' }));
    const rows = r.events || [];
    const real = rows.filter(e => e.realized);
    const prox = rows.filter(e => !e.realized);
    const pendReal = real.filter(e => !e.uploaded).length;
    const subidas = real.filter(e => e.uploaded).length;

    const estadoReal = e => e.hasLink ? '<span class="tag tag--green">✓ Fotos subidas</span>'
      : (e.legacy ? '<span class="tag tag--green">✓ Ya entregadas</span>'
        : '<span class="tag tag--red">⬆ Pendiente de subir</span>');
    const colFecha = { t: 'Fecha', get: i => i.fecha || '', html: i => `<b>${esc(slash(i.fecha) || '—')}</b>` };
    const colBoda = { t: 'Boda', get: i => i.conyuges || '', html: i => `<a href="#/eventos/${i.id}" title="Abrir la boda">${esc(i.conyuges || '—')}</a><div class="hint">#${i.id}</div>` };
    const colLugar = { t: 'Lugar', get: i => i.lugar || '', html: i => esc(i.lugar || '—') };
    const colDj = { t: 'DJ', get: i => i.djName || '', html: i => esc(i.djName || '—') };
    const colsReal = [
      colFecha, colBoda, colLugar, colDj,
      { t: 'Estado', get: i => i.hasLink ? 2 : (i.legacy ? 1 : 0), html: estadoReal },
      { t: 'Galería', nosort: true, nofilter: true, html: i => i.fotosLink
        ? `<a class="btn btn--xs" href="${esc(i.fotosLink)}" target="_blank" rel="noopener" title="Abrir la galería de fotos">🔗 Abrir</a>`
        : (i.legacy ? '<span class="hint">entregada a mano</span>' : '<span class="hint">— sin enlace —</span>') },
      { t: 'Email enviado', get: i => i.fotosSentAt || '', html: i => i.fotosSentAt
        ? `<span class="tag tag--green" title="${esc(i.fotosSentAt)}">✓ ${esc(slash(i.fotosSentAt.slice(0, 10)))}</span>`
        : '<span class="hint">—</span>' },
      { t: 'Acciones', nosort: true, nofilter: true, html: i => {
        if (i.legacy && !i.hasLink) return `<button class="btn btn--xs" data-setlink="${i.id}" title="Si quieres, puedes subir también el enlace de esta boda antigua">➕ Enlace</button>`;
        const emails = (i.emails || []).length;
        return `<button class="btn btn--xs ${i.hasLink ? '' : 'btn--primary'}" data-setlink="${i.id}" title="Pegar o cambiar el enlace de la galería de Google Drive">${i.hasLink ? '✏️ Enlace' : '➕ Añadir enlace'}</button>`
          + (i.hasLink ? ` <button class="btn btn--xs btn--primary" data-sendmail="${i.id}" title="Enviar el email de fotos listas a los novios"${emails ? '' : ' disabled'}>📧 Enviar aviso${emails ? ` (${emails})` : ''}</button>` : '');
      } },
    ];
    const colsProx = [
      colFecha, colBoda, colLugar, colDj,
      { t: '', nosort: true, nofilter: true, html: i => '<span class="tag tag--blue">Próxima</span>' },
    ];
    const tabs = `<div class="tabs" style="margin-bottom:16px">
      <button type="button" data-ftab="real" class="${tab === 'real' ? 'on' : ''}">Realizadas (${real.length})</button>
      <button type="button" data-ftab="prox" class="${tab === 'prox' ? 'on' : ''}">Próximas (${prox.length})</button></div>`;
    const realHtml = `
      <div class="grid-3" style="margin-bottom:14px">
        <div class="stat stat--pink"><div class="k"><span class="foto-stat-dot" style="background:#c62828"></span>Pendientes de subir</div><div class="v">${pendReal}</div></div>
        <div class="stat"><div class="k"><span class="foto-stat-dot" style="background:#138a3e"></span>Subidas / entregadas</div><div class="v">${subidas}</div></div>
        <div class="stat"><div class="k">Total realizadas</div><div class="v">${real.length}</div></div>
      </div>
      <p class="hint" style="margin-bottom:12px">Tras la boda, subes las fotos a una carpeta de Google Drive y pegas aquí el <b>enlace para compartir</b> (➕). La boda pasa a <b>verde</b> y la pareja ya puede descargarlas desde su evento. Con <b>📧 Enviar aviso</b> les llega el email a <b>todos los correos de la boda</b> (titular y pareja invitada); es siempre manual. Las bodas de <b>sept. 2026 hacia atrás</b> se dan por <b>ya entregadas</b> (verde) y no hay que subirlas.</p>
      <div class="panel"><div class="panel__body">${table('dtFotoReal', { rows: real, order: [0, 'desc'], filters: true, dense: true, len: 50, cols: colsReal, rowClass: i => i.uploaded ? 'row-ok' : 'row-no', empty: 'Todavía no hay bodas realizadas con fotomatón.' })}</div></div>`;
    const proxHtml = `
      <p class="hint" style="margin-bottom:12px">Bodas con fotomatón <b>aún sin celebrar</b>. Cuando pase la fecha, pasarán a <b>Realizadas</b> para subir sus fotos.</p>
      <div class="panel"><div class="panel__body">${table('dtFotoProx', { rows: prox, order: [0, 'asc'], filters: true, dense: true, len: 50, cols: colsProx, empty: 'No hay próximas bodas con fotomatón.' })}</div></div>`;
    shell(`${pageHead('Fotomatón', 'Bodas con fotomatón (servicio, extra o con logo en discoteca) y estado de sus fotos.')}
      ${tabs}
      <div id="ftReal" style="display:${tab === 'real' ? 'block' : 'none'}">${realHtml}</div>
      <div id="ftProx" style="display:${tab === 'prox' ? 'block' : 'none'}">${proxHtml}</div>`, ['Fotomatón']);

    $$('[data-ftab]').forEach(b => b.onclick = () => {
      tab = b.dataset.ftab;
      const rr = el('ftReal'), pp = el('ftProx');
      if (rr) rr.style.display = tab === 'real' ? 'block' : 'none';
      if (pp) pp.style.display = tab === 'prox' ? 'block' : 'none';
      $$('[data-ftab]').forEach(x => x.classList.toggle('on', x.dataset.ftab === tab));
    });

    const setLink = id => {
      const ev = rows.find(x => x.id === id) || {};
      modal('Enlace de la galería de fotos', `
        <p class="hint" style="margin-bottom:10px">Pega el <b>enlace para compartir</b> de la carpeta de Google Drive con las fotos del fotomatón de <b>${esc(ev.conyuges || ('la boda #' + id))}</b>. Asegúrate de que la carpeta está compartida como <b>"cualquiera con el enlace"</b> para que la pareja pueda abrirla.</p>
        <div class="field"><label>Enlace (https://…)</label><input class="control" id="fotoLinkInput" type="url" placeholder="https://drive.google.com/drive/folders/…" value="${esc(ev.fotosLink || '')}"></div>
        ${ev.fotosLink ? '<p class="hint">Deja el campo vacío y guarda para quitar el enlace.</p>' : ''}`, {
        okText: 'Guardar enlace', onOk: async () => {
          const link = ((el('fotoLinkInput') || {}).value || '').trim();
          if (link && !/^https?:\/\//i.test(link)) { toast('El enlace debe empezar por http:// o https://', 'err'); return true; }
          try { await api('events/' + id + '/fotos', { method: 'POST', body: { link } }); toast(link ? '✅ Enlace guardado' : 'Enlace quitado', 'ok'); } catch (e) { toast(e.message || 'Error', 'err'); return true; }
          draw();
        }
      });
    };
    const sendMail = id => {
      const ev = rows.find(x => x.id === id) || {};
      const emails = ev.emails || [];
      modal('Enviar email de fotos a los novios', `
        <p style="margin-bottom:10px">Se enviará el email <b>"vuestras fotos ya están listas"</b> (solo el enlace de descarga, sin reseña de Google) a <b>todos los correos de la boda</b> de <b>${esc(ev.conyuges || ('#' + id))}</b>:</p>
        <ul style="margin:0 0 10px 18px">${emails.length ? emails.map(e => `<li><b>${esc(e)}</b></li>`).join('') : '<li class="hint">No hay ningún correo asociado a esta boda.</li>'}</ul>
        ${ev.fotosSentAt ? `<p class="hint" style="color:#b26a00">⚠ Ya se envió una vez el ${esc(slash(ev.fotosSentAt.slice(0, 10)))}. Si lo vuelves a enviar, les llegará de nuevo.</p>` : ''}
        <div class="field" style="margin-top:8px"><label>¿Prefieres una prueba primero? Envíatela a ti</label><input class="control" id="fotoTestTo" type="email" placeholder="tu-email@conectaso.es (opcional)"></div>
        <p class="hint">Si rellenas tu email, se envía <b>solo a ti</b> como prueba (con [PRUEBA] en el asunto) y no se marca como enviado.</p>`, {
        okText: '📧 Enviar', onOk: async () => {
          const testTo = ((el('fotoTestTo') || {}).value || '').trim();
          if (!testTo && !emails.length) { toast('No hay correos a los que enviar.', 'err'); return true; }
          try {
            const res = await api('events/' + id + '/fotos-email', { method: 'POST', body: testTo ? { testTo } : {} });
            if (res.disabled) { toast('El envío de emails está desactivado en la configuración.', 'err'); return; }
            if (res.test) { toast('✅ Prueba enviada a ' + testTo, 'ok'); return; }
            const sent = (res.recipients || []).filter(x => x.status === 'sent').length;
            const bad = (res.recipients || []).filter(x => x.status === 'error' || x.status === 'skipped').length;
            toast('✅ Email enviado a ' + sent + ' destinatario' + (sent === 1 ? '' : 's') + (bad ? ' · ' + bad + ' no enviados' : ''), 'ok');
          } catch (e) { toast(e.message || 'Error', 'err'); return true; }
          draw();
        }
      });
    };
    const wireFoto = () => {
      $$('[data-setlink]').forEach(b => b.onclick = () => setLink(+b.dataset.setlink));
      $$('[data-sendmail]').forEach(b => b.onclick = () => sendMail(+b.dataset.sendmail));
    };
    bindTable('dtFotoReal', wireFoto);
    bindTable('dtFotoProx', () => {});
  }
  draw();
});

on(/^#\/nominas$/, async () => {
  // Acceso a nóminas: SOLO administración y DJ/técnicos (sus propias). Wedding planner y
  // cliente NUNCA tienen acceso a nóminas.
  if (!(S.user.role === 'admin' || S.user.role === 'dj')) { toast('No tienes acceso a nóminas', 'err'); location.hash = '#/'; return; }
  const admin = isAdmin(); loading(['Nóminas']);
  let targetId = S.user.id, workers = [];
  if (admin) {
    const us = await api('users').catch(() => ({ users: [] }));
    // Solo trabajadores con control horario (fichaje) + estos dos por id: Iván Candela DJ (723) y Josué Lights (292).
    const NOM_EXTRA_IDS = [723, 292];
    workers = (us.users || []).filter(u => u.time_tracking || NOM_EXTRA_IDS.includes(u.id)).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es'));
    targetId = workers.length ? workers[0].id : S.user.id;
  }
  return renderNominas(targetId, admin, workers);
});
async function renderNominas(uid, admin, workers) {
  loading(['Nóminas']);
  const r = await api('files/payslip-list/' + uid).catch(() => ({ files: [] }));
  const files = r.files || [];
  const byYear = {};
  files.forEach(f => { const y = (f.period || '').slice(0, 4) || '—'; (byYear[y] = byYear[y] || []).push(f); });
  const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
  const now = new Date(), curY = now.getFullYear(), curM = now.getMonth() + 1;
  const yearOpts = []; for (let y = curY + 1; y >= 2018; y--) yearOpts.push(y);
  const workerSel = admin ? `<div class="field" style="max-width:360px"><label>Trabajador</label><select class="control" id="nomWorker">${workers.map(w => `<option value="${w.id}" ${w.id == uid ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>` : '';
  // El formulario de subida es SOLO para administración. Los DJ/técnicos solo ven y descargan.
  const uploadForm = admin ? `<div class="panel"><div class="panel__head"><h3>Subir nómina</h3></div><div class="panel__body">
    <form id="nomUpload" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <div class="field"><label>Año</label><select class="control" name="year">${yearOpts.map(y => `<option ${y == curY ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
      <div class="field"><label>Mes</label><select class="control" name="month">${NOM_MESES.map((m, i) => `<option value="${String(i + 1).padStart(2, '0')}" ${(i + 1) == curM ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
      <div class="field"><label>Archivo (PDF)</label><input type="file" class="control" id="nomFile" accept="application/pdf,image/*"></div>
      <button type="submit" class="btn btn--primary">Subir</button>
    </form><div id="nomMsg" style="margin-top:8px;display:none;font-size:13px"></div>
  </div></div>` : '';
  const list = years.length ? years.map(y => `<div class="panel"><div class="panel__head"><h3>${esc(y)}</h3></div><div class="panel__body">
      <table class="dt"><thead><tr><th>Mes</th><th>Archivo</th><th></th></tr></thead><tbody>
      ${byYear[y].sort((a, b) => (b.period || '').localeCompare(a.period || '')).map(f => { const mm = +(f.period || '').slice(5, 7); const mn = mm ? NOM_MESES[mm - 1] : (f.period || '—'); return `<tr><td>${esc(mn)}</td><td>${esc(f.name)}</td><td style="text-align:right"><a class="btn btn--sm" href="/api/files/${f.id}" target="_blank">Ver / descargar</a>${admin ? ` <button class="btn btn--sm btn--red" data-delnom="${f.id}">Borrar</button>` : ''}</td></tr>`; }).join('')}
      </tbody></table></div></div>`).join('') : '<div class="empty"><span class="script">Sin nóminas</span>Aún no hay nóminas subidas.</div>';
  const holdedSync = admin ? `<div class="btn-row" style="margin-bottom:14px"><a class="btn" href="/api/holded-payslip-sync" target="_blank" rel="noopener">⬇ Sincronizar nóminas desde Holded</a> <span class="hint">Trae de Holded las nóminas que falten (p. ej. la de Damaris de julio). Primero te muestra una <b>prueba</b> con lo que cuadra; luego confirmas la descarga. Las que ya están no se duplican.</span></div>` : '';
  shell(`${pageHead('Nóminas', admin ? 'Sube y consulta las nóminas del equipo (PDF), por año y mes.' : 'Tus nóminas, por año y mes. Puedes verlas y descargarlas.')}
    ${holdedSync}${workerSel}${uploadForm}${list}`, ['Nóminas']);
  const ws = el('nomWorker'); if (ws) ws.onchange = () => renderNominas(+ws.value, admin, workers);
  const uf = el('nomUpload');
  if (uf) uf.onsubmit = async e => {
    e.preventDefault();
    const fi = el('nomFile'); const f = fi && fi.files && fi.files[0]; const m = el('nomMsg'); m.style.display = 'block';
    if (!f) { m.textContent = 'Elige un archivo.'; return; }
    const d = collectForm(uf); const period = d.year + '-' + d.month;
    const fd = new FormData(); fd.append('file', f, f.name); fd.append('momento', period);
    m.textContent = 'Subiendo…';
    try { await api('files/payslip/' + uid, { method: 'POST', form: fd }); toast('Nómina subida', 'ok'); renderNominas(uid, admin, workers); }
    catch (err) { m.innerHTML = '<span style="color:#d9534f;font-weight:700">' + esc(err.message || 'Error al subir') + '</span>'; }
  };
  $$('[data-delnom]').forEach(b => b.onclick = () => modal('Borrar nómina', '¿Seguro que quieres borrar esta nómina?', { okText: 'Borrar', danger: true, onOk: async () => { await api('files/' + b.dataset.delnom, { method: 'DELETE' }); toast('Nómina borrada', 'ok'); renderNominas(uid, admin, workers); } }));
}
// Cobros pendientes de las bodas de la SEMANA EN VIGOR (lunes a domingo): de un vistazo, a quién
// hay que cobrar esta semana. Incluye tanto las bodas próximas como las ya realizadas de la semana.
on(/^#\/cobros$/, async () => {
  if (!requireAdmin()) return; loading(['Cobros de la semana']);
  const [up, done] = await Promise.all([api('events'), api('events?status=done')]);
  const all = (up.events || []).concat(done.events || []);
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;                 // 0 = lunes
  const mon = new Date(now); mon.setHours(0, 0, 0, 0); mon.setDate(now.getDate() - dow);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const from = iso(mon), to = iso(sun);
  const seen = {};
  const rows = all
    .filter(e => e.fecha && e.fecha >= from && e.fecha <= to && !seen[e.id] && (seen[e.id] = 1) && ((+e.pagoCliente || 0) - (+e.pagado || 0)) > 0.5)
    .map(e => Object.assign({}, e, { pend: (+e.pagoCliente || 0) - (+e.pagado || 0) }))
    .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
  const totalPend = rows.reduce((t, r) => t + r.pend, 0);
  shell(`${pageHead('Cobros de la semana', `Bodas de esta semana (${dmy(from)} – ${dmy(to)}) con importe pendiente de cobro.`)}
    <div class="grid-2" style="margin-bottom:14px">
      <div class="stat stat--pink"><div class="k">Pendiente de cobro esta semana</div><div class="v">${fmtEur(totalPend)}</div></div>
      <div class="stat"><div class="k">Bodas con cobro pendiente</div><div class="v">${rows.length}</div></div></div>
    <div class="panel"><div class="panel__body">${rows.length ? table('dtCobros', { rows, order: [0, 'asc'], filters: true, cols: [
      { t: 'Fecha', get: r => r.fecha || '', html: r => dmy(r.fecha) },
      { t: 'Pareja', get: r => r.conyuges || '', html: r => `<a href="#/eventos/${r.id}">${esc(r.conyuges || '(sin nombre)')}</a>` },
      { t: 'Lugar', get: r => CS.locName(r) },
      { t: 'Total', get: r => +r.pagoCliente || 0, html: r => fmtEur(+r.pagoCliente || 0) },
      { t: 'Pagado', get: r => +r.pagado || 0, html: r => fmtEur(+r.pagado || 0) },
      { t: 'Pendiente', get: r => r.pend, html: r => `<b>${fmtEur(r.pend)}</b>` },
    ] }) : '<div class="empty"><span class="script">Sin cobros</span>No hay bodas con pago pendiente esta semana.</div>'}</div></div>`, ['Cobros de la semana']);
});
on(/^#\/facturacion$/, async () => {
  if (!requireAdmin()) return; loading(['Facturación']);
  const { workers } = await api('finance/workers');
  const totalPend = (workers || []).reduce((t, w) => t + (+w.pend || 0), 0);
  const nPend = (workers || []).filter(w => (+w.pend || 0) > 0).length;
  shell(`${pageHead('Facturación del equipo', 'Pendiente de pago por trabajador.')}
    <div class="grid-3" style="margin-bottom:14px">
      <div class="stat stat--pink"><div class="k">Total pendiente de pago</div><div class="v">${fmtEur(totalPend)}</div></div>
      <div class="stat stat--blue"><div class="k">Trabajadores con pendiente</div><div class="v">${nPend}</div></div>
      <div class="stat"><div class="k">Trabajadores en la lista</div><div class="v">${(workers || []).length}</div></div>
    </div>
    <div class="panel"><div class="panel__body">${table('dtWork', { rows: workers, order: [2, 'desc'], filters: true, cols: [
      { t: 'Id', get: w => w.id }, { t: 'Nombre', get: w => w.name, html: w => `<a href="#/facturacion/${w.id}">${esc(w.name)}</a>` },
      { t: 'Pendiente de pago', get: w => w.pend, html: w => fmtEur(w.pend) },
      { t: 'Último movimiento', get: w => w.last || '', html: w => w.last ? dmy(w.last) : '—' },
      { t: '', nosort: true, nofilter: true, html: w => `<a class="btn btn--sm" href="#/facturacion/${w.id}">Ver histórico</a>` },
    ] })}</div></div>`, ['Facturación']);
});
on(/^#\/facturacion\/(\d+)$/, async m => { if (!requireAdmin()) return; return historyView(+m[1], true); });
on(/^#\/mis-pagos$/, async () => { if (S.user.role !== 'dj') { shell('<div class="empty">Sin acceso.</div>', ['Pagos']); return; } return historyView(S.user.id, false); });
async function historyView(uid, admin) {
  loading(['Facturación']);
  const r = admin ? await api('finance/history/' + uid) : await api('finance/me');
  const H = r.history; const pays = r.payments || [];
  if (!H) return shell('<div class="empty"><span class="script">Sin histórico</span>No hay datos para este usuario.</div>', ['Facturación']);
  const paid = pays.reduce((t, p) => t + (+p.amount || 0), 0);
  const e2 = s => fmtEur(s);
  // fusionar eventos del histórico (snapshot) + pagos locales nuevos
  const locals = pays.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(p => ({ type: 'pay', date: p.date, amount: +p.amount, description: p.description, bal: 0 }));
  { let run = H.rest; locals.slice().reverse().forEach(it => { run -= it.amount; it.bal = run; }); }
  // Lista en "Z" estilo burbuja: GENERADO pegado a la IZQUIERDA, PAGOS a la DERECHA. Funciona en móvil.
  const card = i => {
    const left = (i.type !== 'pay');
    const bg = left ? 'rgba(11,128,67,.07)' : 'rgba(232,44,136,.10)';
    const bord = left ? '#0B8043' : '#E82C88';
    let inner;
    if (i.type === 'adj') inner = `<div style="font-weight:700">${esc(i.title)}${admin ? ` <button class="btn btn--icon" data-del-adj="${i.adjId}" title="Quitar ajuste">🗑</button>` : ''}</div>${(i.body || []).map(b => `<div>${esc(b)}</div>`).join('')}<div style="font-size:12px;color:#667;margin-top:3px">${dmy(i.date)} · <b style="color:${i.amount < 0 ? '#D50000' : '#0B8043'}">${i.amount > 0 ? '+' : ''}${e2(i.amount)}</b></div>`;
    else if (i.type === 'ev') inner = `<div style="font-weight:700">${i.evId && admin ? `<a href="#/eventos/${i.evId}">${esc(i.title)}</a>` : esc(i.title)}</div>${(i.body || []).map(b => { const mt = b.match(/^([^:]+):\s*(.*)$/); return mt ? `<div><b>${esc(mt[1])}:</b> ${esc(mt[2])}</div>` : `<div>${esc(b)}</div>`; }).join('')}<div style="font-size:12px;color:#667;margin-top:3px">${dmy(i.date)} · <b style="color:#0B8043">${e2(i.amount)}</b>${admin ? ` <button class="btn btn--xs" data-saldar="${i.evId}" title="Marcar esta boda como ya pagada a este trabajador (deja de contar)">✓ Pagada</button>` : ''}</div>`;
    else inner = `<div style="font-weight:700">🧾 Pago realizado</div><div><b>Cantidad:</b> ${e2(i.amount)}</div>${i.description ? `<div><b>Concepto:</b> ${esc(i.description)}</div>` : ''}<div style="font-size:12px;color:#667;margin-top:3px">${dmy(i.date)} · saldo ${fmtEur(i.bal)}</div>`;
    return `<div data-year="${String(i.date || '').slice(0, 4)}" style="position:relative;display:flex;justify-content:${left ? 'flex-start' : 'flex-end'};margin-bottom:10px">`
      + `<div style="width:calc(50% - 8px);min-width:0;background:${bg};border-${left ? 'left' : 'right'}:3px solid ${bord};border-radius:10px;padding:10px 13px;font-size:14px;line-height:1.38">${inner}</div>`
      + `<span style="position:absolute;top:15px;left:50%;transform:translate(-50%,-50%);width:11px;height:11px;border-radius:50%;background:${bord};box-shadow:0 0 0 3px rgba(255,255,255,.65)"></span>`
      + `</div>`;
  };
  // Orden cronológico robusto (más recientes primero) válido para TODOS los años:
  // compara las fechas ISO directamente y manda al final las que no tengan fecha.
  const byDateDesc = (a, b) => { const da = String(a.date || ''), db = String(b.date || ''); if (!da && !db) return 0; if (!da) return 1; if (!db) return -1; return db < da ? -1 : (db > da ? 1 : 0); };
  const allMov = (H.items || []).filter(i => i.type === 'ev' || i.type === 'adj').concat(locals, (H.items || []).filter(i => i.type === 'pay')).sort(byDateDesc);
  const fyears = [...new Set(allMov.map(i => String(i.date || '').slice(0, 4)).filter(y => /^\d{4}$/.test(y)))].sort().reverse();
  const bal = H.rest - paid;
  // Admin ve el total; el trabajador NO ve su histórico total, solo su saldo, sus importes generados y sus pagos.
  const statsHtml = admin
    ? `<div class="grid-3"><div class="stat stat--blue"><div class="k">Total a cobrar</div><div class="v">${e2(H.cobrar)}</div></div>
        <div class="stat"><div class="k">Total cobrado</div><div class="v">${e2(H.cobrado + paid)}</div></div>
        <div class="stat stat--pink"><div class="k">Pendiente</div><div class="v">${e2(H.rest - paid)}</div></div></div>`
    : `<div class="grid-2"><div class="stat"><div class="k">Total que te he pagado</div><div class="v">${e2(H.cobrado + paid)}</div></div>
        <div class="stat stat--pink"><div class="k">${bal >= 0 ? 'Pendiente (te debo)' : 'Me debes'}</div><div class="v">${e2(Math.abs(bal))}</div></div></div>`;
  const yearBtns = fyears.length > 1 ? `<div class="btn-row ff-years" style="margin:4px 0 12px;flex-wrap:wrap;gap:6px"><button class="btn btn--sm btn--primary" data-fy="all">Todos</button>${fyears.map(y => `<button class="btn btn--sm" data-fy="${y}">${y}</button>`).join('')}</div>` : '';
  const legend = '<p class="hint" style="margin:2px 0 10px">💶 <b>Izquierda</b>: lo que genera · 🧾 <b>derecha</b>: lo que le pagas · ordenado por fecha.</p>';
  const bodyLists = `${legend}${yearBtns}<div class="panel"><div class="panel__body"><div class="ff-list">${allMov.map(card).join('') || '<div class="empty">Sin movimientos.</div>'}</div></div></div>`;
  shell(`${pageHead(admin ? 'Histórico · ' + userName(uid) : 'Mis pagos', admin ? 'Eventos realizados y pagos.' : 'Tu saldo, tus importes generados y tus pagos.')}
    ${statsHtml}
    ${admin ? `<div class="panel"><div class="panel__head"><h3>Registrar pago</h3></div><div class="panel__body"><form id="payForm" class="btn-row" style="align-items:flex-end">
      <div class="field" style="margin:0"><label>Cantidad (€)</label><input class="control" type="number" step="0.01" name="amount" required></div>
      <div class="field" style="margin:0"><label>Fecha</label><input class="control" type="date" name="date" value="${ymd(TODAY)}"></div>
      <div class="field" style="margin:0;flex:1;min-width:180px"><label>Descripción</label><input class="control" name="description"></div>
      <button class="btn btn--primary" type="submit">Registrar pago</button></form></div></div>
    <div class="panel"><div class="panel__head"><h3>Añadir ajuste / plus</h3></div><div class="panel__body">
      <p class="hint" style="margin-bottom:10px">Suma o resta un importe al saldo de este trabajador (gasolina, comidas, dietas…). Usa un importe <b>negativo</b> para descontar.</p>
      <form id="adjForm" class="btn-row" style="align-items:flex-end">
        <div class="field" style="margin:0"><label>Importe (€)</label><input class="control" type="number" step="0.01" name="amount" placeholder="p. ej. 25 o -10" required></div>
        <div class="field" style="margin:0"><label>Fecha</label><input class="control" type="date" name="date" value="${ymd(TODAY)}"></div>
        <div class="field" style="margin:0;flex:1;min-width:180px"><label>Concepto</label><input class="control" name="concept" placeholder="Gasolina, comida…"></div>
        <button class="btn btn--blue" type="submit">Añadir ajuste</button></form></div></div>` : ''}
    ${bodyLists}`, ['Facturación']);
  if (admin) {
    el('payForm').onsubmit = async e => { e.preventDefault(); const d = collectForm(e.target); await api('finance/pay', { method: 'POST', body: { userId: uid, amount: d.amount, date: d.date, description: d.description } }); toast('Pago registrado', 'ok'); historyView(uid, admin); };
    el('adjForm').onsubmit = async e => { e.preventDefault(); const d = collectForm(e.target); try { await api('finance/adjust', { method: 'POST', body: { userId: uid, amount: d.amount, date: d.date, concept: d.concept } }); toast('Ajuste añadido', 'ok'); historyView(uid, admin); } catch (x) { toast(x.message || 'Error', 'err'); } };
    $$('[data-del-adj]').forEach(b => b.onclick = () => modal('Quitar ajuste', '¿Eliminar este ajuste del saldo?', { okText: 'Eliminar', danger: true, onOk: async () => { await api('finance/adjust/' + b.dataset.delAdj, { method: 'DELETE' }); toast('Ajuste eliminado', 'ok'); historyView(uid, admin); } }));
    $$('[data-saldar]').forEach(b => b.onclick = () => modal('Marcar como pagada', '¿Marcar esta boda como <b>ya pagada</b> a este trabajador? Dejará de contar en su saldo (podrás revertirlo luego).', { okText: 'Marcar pagada', onOk: async () => { try { await api('finance/saldar', { method: 'POST', body: { eventId: +b.dataset.saldar, userId: uid, saldar: true } }); toast('Boda marcada como pagada', 'ok'); historyView(uid, admin); } catch (e) { toast(e.message || 'Error', 'err'); return true; } } }));
  }
  $$('.ff-years [data-fy]').forEach(b => b.onclick = () => {
    const y = b.dataset.fy;
    $$('.ff-years [data-fy]').forEach(x => x.classList.toggle('btn--primary', x.dataset.fy === y));
    $$('.ff-list > [data-year]').forEach(li => { li.style.display = (y === 'all' || li.getAttribute('data-year') === y) ? '' : 'none'; });
  });
}

/* beneficios (admin) — protegida con contraseña fija, solo administración */
const BENEF_PASS = 'lamusica20';
const benefOk = () => { try { return sessionStorage.getItem('conecta_benef_ok') === '1'; } catch (e) { return false; } };
function benefGate(label) {
  label = label || 'Beneficios';
  shell(`${pageHead(label, 'Sección protegida (Configuración avanzada).')}
    <div class="panel" style="max-width:480px"><div class="panel__body">
      <p class="hint" style="margin-bottom:14px">🔒 Esta sección está protegida. Introduce la contraseña (la encuentras también en <a href="#/cuenta">Mi cuenta → Configuración avanzada</a>).</p>
      <form id="benefForm"><div class="field"><label>Contraseña</label><input class="control" type="password" id="benefPass" autocomplete="off"></div>
        <div class="btn-row" style="margin-top:12px"><button type="submit" class="btn btn--primary">Entrar</button>
          <button type="button" class="btn btn--sm" id="benefForgot">¿Olvidaste la contraseña?</button></div></form>
      <p id="benefMsg" style="margin-top:12px;display:none;font-size:13px"></p>
    </div></div>`, [label]);
  $('#benefForm').onsubmit = e => { e.preventDefault(); const v = ($('#benefPass') || {}).value || ''; if (v === BENEF_PASS) { try { sessionStorage.setItem('conecta_benef_ok', '1'); } catch (x) {} if (CS.route) CS.route(); else location.reload(); } else { const m = $('#benefMsg'); m.style.display = 'block'; m.innerHTML = '<span style="color:#d9534f;font-weight:700">Contraseña incorrecta.</span>'; } };
  $('#benefForgot').onclick = () => { const m = $('#benefMsg'); m.style.display = 'block'; m.innerHTML = 'Te hemos enviado la contraseña a tu email de administración (<b>' + esc(S.user.email || 'tu email') + '</b>).<br><span class="muted">Nota demo: aún no hay envío de correo real. La contraseña es <b>lamusica20</b>.</span>'; };
}
// Gráfico de quesito (donut) con porcentajes por color. rows: [{label, value}]. Agrupa el resto en "Otros".
const PIE_COLORS = ['#E82C88', '#31B9CB', '#0B8043', '#F5A623', '#7B61FF', '#FF6B6B', '#2D9CDB', '#9B51E0', '#27AE60', '#F2994A', '#56CCF2', '#EB5757', '#6FCF97', '#BB6BD9', '#F2C94C', '#8E8E93'];
function pieChart(rows, { topN = 12, unit = '' } = {}) {
  rows = (rows || []).filter(r => r.value > 0).sort((a, b) => b.value - a.value);
  if (!rows.length) return '<div class="empty">Sin datos.</div>';
  if (rows.length > topN) {
    const head = rows.slice(0, topN), rest = rows.slice(topN);
    const otros = rest.reduce((s, r) => s + r.value, 0);
    rows = head.concat([{ label: 'Otros (' + rest.length + ')', value: Math.round(otros * 10) / 10 }]);
  }
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  const R = 95, cx = 105, cy = 105; let ang = -90;
  const p = a => [cx + R * Math.cos(a * Math.PI / 180), cy + R * Math.sin(a * Math.PI / 180)];
  const segs = rows.map((r, i) => {
    const frac = r.value / total, col = PIE_COLORS[i % PIE_COLORS.length];
    if (frac >= 0.999) return `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${col}"><title>${esc(r.label)}: ${r.value}${unit} (100%)</title></circle>`;
    const a0 = ang, a1 = ang + frac * 360; ang = a1;
    const [x0, y0] = p(a0), [x1, y1] = p(a1), large = (a1 - a0) > 180 ? 1 : 0;
    return `<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${R},${R} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${col}"><title>${esc(r.label)}: ${r.value}${unit} (${Math.round(frac * 100)}%)</title></path>`;
  }).join('');
  const legend = rows.map((r, i) => `<div class="pie-leg-row"><span class="pie-dot" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span><span class="pie-leg-name" title="${esc(r.label)}">${esc(r.label)}</span><b>${r.value}${unit}</b> <span class="muted">${Math.round(r.value / total * 100)}%</span></div>`).join('');
  return `<div class="pie-wrap"><svg viewBox="0 0 210 210" class="pie-svg">${segs}<circle class="pie-hole" cx="${cx}" cy="${cy}" r="48"/></svg><div class="pie-leg">${legend}</div></div>`;
}
// Gráfico de líneas multi-serie (evolución por año). xLabels: años; series: [{label, values[], color}].
function lineChartMulti(xLabels, series, opts) {
  opts = opts || {};
  series = (series || []).filter(s => s.values.some(v => v > 0));
  if (!series.length || !xLabels.length) return '<div class="empty">Sin datos.</div>';
  const showValues = !!opts.showValues;
  const bottomVals = (opts.bottomValues && opts.bottomValues.length === xLabels.length) ? opts.bottomValues : null;
  const W = 840, H = 340, padL = 34, padR = 16, padT = showValues ? 26 : 14, padB = bottomVals ? 60 : 44;
  const maxV = Math.max(1, ...series.flatMap(s => s.values));
  const n = xLabels.length;
  const X = i => padL + (n <= 1 ? (W - padL - padR) / 2 : i * (W - padL - padR) / (n - 1));
  const Y = v => H - padB - (v / maxV) * (H - padT - padB);
  const ticks = 4; let grid = '';
  for (let t = 0; t <= ticks; t++) { const v = Math.round(maxV * t / ticks); const yy = Y(v); grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--line,#eee)" stroke-width="1"/><text x="${padL - 6}" y="${yy + 3}" font-size="10" text-anchor="end" fill="#8a8390">${v}</text>`; }
  // Líneas verticales en cada año, para que cada punto quede "cuadrado" con su año.
  let vgrid = '';
  xLabels.forEach((l, i) => { vgrid += `<line x1="${X(i)}" y1="${padT}" x2="${X(i)}" y2="${H - padB}" stroke="var(--line,#eee)" stroke-width="1" stroke-dasharray="2 3"/>`; });
  const xlab = xLabels.map((l, i) => {
    let t = `<text x="${X(i)}" y="${H - padB + 18}" font-size="11" text-anchor="middle" fill="#8a8390">${esc(l)}</text>`;
    if (bottomVals) t += `<text x="${X(i)}" y="${H - padB + 37}" font-size="14" font-weight="700" text-anchor="middle" fill="var(--ink,#2b2430)">${esc(String(bottomVals[i]))}</text>`;
    return t;
  }).join('');
  const lines = series.map(s => `<polyline fill="none" stroke="${s.color}" stroke-width="2.5" points="${s.values.map((v, i) => X(i) + ',' + Y(v)).join(' ')}"/>` + s.values.map((v, i) => `<circle cx="${X(i)}" cy="${Y(v)}" r="3.6" fill="#fff" stroke="${s.color}" stroke-width="2"><title>${esc(s.label)} · ${esc(xLabels[i])}: ${v}</title></circle>`).join('') + (showValues ? s.values.map((v, i) => `<text x="${X(i)}" y="${Y(v) - 9}" font-size="12" font-weight="700" text-anchor="middle" fill="${s.color}">${v}</text>`).join('') : '')).join('');
  const legend = series.map(s => `<span class="ln-leg"><span class="ln-dot" style="background:${s.color}"></span>${esc(s.label)}</span>`).join('');
  return `<div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" class="line-svg" style="width:100%;min-width:560px">${vgrid}${grid}${lines}${xlab}</svg></div><div class="ln-legend">${legend}</div>`;
}
// ANÁLISIS (admin, bajo contraseña): ventas, facturación de masías, económico y horas extra.
on(/^#\/analisis$/, async () => {
  if (!requireAdmin()) return;
  if (!benefOk()) return benefGate('Análisis');
  loading(['Análisis']);
  const a = await api('analisis').catch(() => ({}));
  const years = a.years || [];
  const eur = n => (Math.round(+n || 0)).toLocaleString('es-ES') + ' €';
  const sum = o => Object.values(o || {}).reduce((s, v) => s + v, 0);
  const crossTable = (obj, firstHdr, fmt, minTotal) => {
    let keys = Object.keys(obj || {}).sort((x, y) => sum(obj[y]) - sum(obj[x]));
    if (minTotal) keys = keys.filter(k => sum(obj[k]) >= minTotal);
    if (!keys.length) return '<div class="empty">Sin datos.</div>';
    const f = fmt || (v => v || 0);
    return `<div class="table-wrap"><table class="dt"><thead><tr><th>${esc(firstHdr)}</th>${years.map(y => `<th style="text-align:right">${y}</th>`).join('')}<th style="text-align:right">Total</th></tr></thead><tbody>${keys.map(k => `<tr><td><b>${esc(k)}</b></td>${years.map(y => `<td style="text-align:right">${f(obj[k][y] || 0)}</td>`).join('')}<td style="text-align:right"><b>${f(sum(obj[k]))}</b></td></tr>`).join('')}</tbody></table></div>`;
  };
  const bars = (rows, fmt) => {
    if (!rows || !rows.length) return '<div class="empty">Sin datos.</div>';
    const max = Math.max(1, ...rows.map(r => r.value));
    return `<div class="bars">${rows.map(r => `<div class="bar-row"><div class="bar-lbl" title="${esc(r.label)}">${esc(r.label)}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, Math.round(r.value / max * 100))}%"></div></div><div class="bar-val">${fmt ? fmt(r.value) : r.value}${r.sub ? ` <span class="muted">${esc(r.sub)}</span>` : ''}</div></div>`).join('')}</div>`;
  };
  const sect = (title, body, sub) => `<div class="panel"><div class="panel__head"><h3>${esc(title)}</h3>${sub ? `<span class="muted" style="font-size:12px">${esc(sub)}</span>` : ''}</div><div class="panel__body">${body}</div></div>`;
  const econ = a.economico || [];
  const econRows = econ.slice(-18).reverse();
  // --- Contenido agrupado por pestañas ---
  const tabBodas = [
    sect('Bodas por pack y año', crossTable(a.ventasPack, 'Pack')),
    (() => {
      // Total de bodas por año = solo packs de boda (Recomendado, Fiesta, Bodorrio, Tinglado); sin Extras ni Corporativos.
      const vp = a.ventasPack || {}; const isWed = p => /recomendad|fiesta|bodorri|tinglado/i.test(p);
      const totYear = {}; years.forEach(y => { totYear[y] = Object.keys(vp).filter(isWed).reduce((s, p) => s + ((vp[p] || {})[y] || 0), 0); });
      const gran = Object.values(totYear).reduce((s, v) => s + v, 0);
      const tbl = `<div class="table-wrap"><table class="dt"><thead><tr><th>Concepto</th>${years.map(y => `<th style="text-align:right">${y}</th>`).join('')}<th style="text-align:right">Total</th></tr></thead><tbody><tr><td><b>Total bodas</b></td>${years.map(y => `<td style="text-align:right"><b>${totYear[y]}</b></td>`).join('')}<td style="text-align:right"><b>${gran}</b></td></tr></tbody></table></div>`;
      const chart = lineChartMulti(years, [{ label: 'Total bodas', color: '#E82C88', values: years.map(y => totYear[y]) }], { bottomValues: years.map(y => totYear[y]) });
      return sect('Total de bodas por año', tbl + chart, 'Recomendado + Fiesta + Bodorrio + Tinglado (sin extras ni corporativos)');
    })(),
    (() => { const vp = a.ventasPack || {}; const keys = Object.keys(vp); const series = keys.map((k, i) => ({ label: k, color: PIE_COLORS[i % PIE_COLORS.length], values: years.map(y => vp[k][y] || 0) })); return sect('Evolución de bodas por pack (por año)', lineChartMulti(years, series)); })(),
    (() => { const dw = a.bodasDow || {}; const cats = Object.keys(dw); if (!cats.length) return ''; const pieRows = cats.map(c => ({ label: c, value: sum(dw[c]) })); return sect('Bodas por día de la semana', crossTable(dw, 'Día') + pieChart(pieRows, { unit: ' bodas' }), 'Viernes, sábado, domingo y entre semana (lunes a jueves)'); })(),
  ].join('');
  const tabMasias = [
    sect('Bodas por masía y año', crossTable(a.ventasMasia, 'Masía', null, 2), 'Solo masías con 2 o más bodas'),
    (() => { const vm = a.ventasMasia || {}; const top = Object.keys(vm).map(k => [k, sum(vm[k])]).sort((x, y) => y[1] - x[1]).slice(0, 8); const series = top.map((t, i) => ({ label: t[0], color: PIE_COLORS[i % PIE_COLORS.length], values: years.map(y => vm[t[0]][y] || 0) })); return sect('Evolución de bodas por masía (por año)', lineChartMulti(years, series), 'Top 8 masías por volumen'); })(),
    a.holdedOk ? sect('Facturación de masías por año', crossTable(a.masiaAnual, 'Masía', eur), 'Importe facturado (sin IVA) desde Holded') : sect('Facturación de masías', '<div class="empty">Holded no está activado.</div>'),
    a.holdedOk ? sect('Media económica por boda y mes', `<div class="table-wrap"><table class="dt"><thead><tr><th>Mes</th><th style="text-align:right">Facturado masías</th><th style="text-align:right">Bodas</th><th style="text-align:right">Media / boda</th></tr></thead><tbody>${econRows.map(m => `<tr><td><b>${esc(m.mes)}</b></td><td style="text-align:right">${eur(m.facturado)}</td><td style="text-align:right">${m.bodas}</td><td style="text-align:right"><b>${eur(m.media)}</b></td></tr>`).join('')}</tbody></table></div>`, 'Facturación de masías ÷ nº de bodas realizadas cada mes') : '',
  ].join('');
  const tabHoras = [
    sect('Horas extra por masía', bars((a.horasMasia || []).map(r => ({ label: r.masia, value: r.horas, sub: `${r.horas} h · media ${r.media} h/boda` })), v => ''), 'Total de horas extra realizadas en cada finca'),
    (() => {
      const hy = a.horasYears || []; const rows = a.horasMasiaYear || [];
      if (!hy.length || !rows.length) return sect('Horas extra por masía y año', '<div class="empty">Sin datos.</div>', 'Desde 2025');
      const tbl = `<div class="table-wrap"><table class="dt"><thead><tr><th>Masía</th>${hy.map(y => `<th style="text-align:right">${y}</th>`).join('')}<th style="text-align:right">Total</th></tr></thead><tbody>${rows.map(r => `<tr><td><b>${esc(r.masia)}</b></td>${hy.map(y => `<td style="text-align:right">${r.byYear[y] || 0} h</td>`).join('')}<td style="text-align:right"><b>${r.total} h</b></td></tr>`).join('')}</tbody></table></div>`;
      return sect('Horas extra por masía y año', tbl, 'Horas extra realizadas en cada finca, desglosadas por año (desde 2025)');
    })(),
    sect('DJs con más horas extra (total)', pieChart((a.djPorTotal || []).map(r => ({ label: r.dj, value: r.horas })), { unit: 'h' }), 'Reparto del total de horas extra entre DJs'),
    sect('DJs con más horas extra por boda (media)', bars((a.djPorBoda || []).slice(0, 20).map(r => ({ label: r.dj, value: r.media, sub: `${r.media} h/boda · ${r.horas} h en ${r.bodas} bodas` })), v => ''), 'Mínimo 3 bodas para la media'),
    sect('Cobrado por horas extra, por DJ y año', crossTable(a.heEarnDj, 'DJ', eur), 'Horas extra × tarifa de cada DJ (según finca o pack), en bodas realizadas'),
  ].join('');
  const tabExtras = [
    sect('Extras más contratados', bars((a.extrasTop || []).map(r => ({ label: r.label, value: r.n, sub: `${r.n} bodas · ${r.pct}%` })), v => ''), `Sobre ${a.extrasTotalBodas || 0} bodas. Por SERVICIO asignado (lo real). Solo los contratados 10 o más veces`),
    sect('Extras por año', crossTable(a.extrasByYear, 'Extra'), 'Cuántas veces se ha contratado cada extra, por año y total'),
    (() => { const eb = a.extrasByYear || {}; const top = Object.keys(eb).map(k => [k, sum(eb[k])]).sort((x, y) => y[1] - x[1]).slice(0, 8); if (!top.length) return ''; const series = top.map((t, i) => ({ label: t[0], color: PIE_COLORS[i % PIE_COLORS.length], values: years.map(y => eb[t[0]][y] || 0) })); return sect('Evolución de extras por año', lineChartMulti(years, series), 'Si cada extra se vende más o menos cada año (top 8)'); })(),
    sect('Reparto de extras (% de cada tipo)', pieChart((a.extrasTop || []).map(r => ({ label: r.label, value: r.n })), { topN: 16 }), 'Proporción de cada tipo de extra entre todos los contratados'),
  ].join('');
  const tabTecnicos = sect('Bodas por técnico (DJ) y año', crossTable(a.bodasDj, 'Técnico / DJ'), 'Número de bodas realizadas por cada DJ, por año');
  const tabPlanners = sect('Wedding planners con los que más trabajamos', pieChart((a.plannersTop || []).map(r => ({ label: r.name, value: r.n })), { unit: ' bodas', topN: 14 }), 'Excluye planners ligados a finca: UAUU (Castell de Tous / Mas Vivencs), Edelweiss, Can Ribas y Mas la Boella');
  const tabs = [
    { id: 'bodas', label: '💍 Bodas', html: tabBodas },
    { id: 'masias', label: '🏡 Masías', html: tabMasias },
    { id: 'horas', label: '⏱ Horas extra', html: tabHoras },
    { id: 'extras', label: '🎉 Extras', html: tabExtras },
    { id: 'tecnicos', label: '👥 Técnicos', html: tabTecnicos },
    { id: 'planners', label: '📋 Wedding planners', html: tabPlanners },
  ];
  let active = 'bodas'; try { const s = localStorage.getItem('anaTab'); if (s && tabs.some(t => t.id === s)) active = s; } catch (e) {}
  const tabBar = `<div class="btn-row ana-tabs" style="margin-bottom:14px;flex-wrap:wrap;gap:8px">${tabs.map(t => `<button class="btn ${t.id === active ? 'btn--primary' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}</div>`;
  const panes = tabs.map(t => `<div class="ana-pane" data-pane="${t.id}" style="display:${t.id === active ? 'block' : 'none'}">${t.html}</div>`).join('');
  shell(`${pageHead('Análisis', 'Ventas, facturación de masías, económico por boda y horas extra. Datos de bodas realizadas.')}
    <div class="btn-row" style="margin-bottom:12px"><button class="btn btn--sm" id="anaRefresh" title="Recargar datos de Holded">↻ Actualizar desde Holded</button></div>
    ${tabBar}${panes}`, ['Análisis']);
  const rf = el('anaRefresh'); if (rf) rf.onclick = async () => { rf.disabled = true; rf.textContent = 'Actualizando…'; try { await api('analisis?refresh=1'); } catch (e) {} location.reload(); };
  $$('.ana-tabs [data-tab]').forEach(b => b.onclick = () => {
    const id = b.dataset.tab;
    try { localStorage.setItem('anaTab', id); } catch (e) {}
    $$('.ana-tabs [data-tab]').forEach(x => x.classList.toggle('btn--primary', x.dataset.tab === id));
    $$('.ana-pane').forEach(p => p.style.display = (p.dataset.pane === id ? 'block' : 'none'));
  });
});
on(/^#\/beneficios$/, async () => {
  if (!requireAdmin()) return;
  if (!benefOk()) return benefGate();
  loading(['Beneficios']);
  const b = await api('finance/beneficios');
  const y = b.year || [], chart = b.chart || [], monthly = b.monthly || [], anio = b.anio || new Date().getFullYear();
  const stat = (k, v, cls) => `<div class="stat ${cls || ''}"><div class="k">${k}</div><div class="v">${v != null ? fmtEur(v) : '—'}</div></div>`;
  const curMes = monthly[new Date().getMonth()] || { facturado: 0, gastos: 0, beneficio: 0 };
  const MESNOM = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'][new Date().getMonth()];
  shell(`${pageHead('Beneficios', 'Facturado, gastos y beneficio del negocio (bodas realizadas).')}
    <h3 class="form-sub" style="margin:4px 0 10px">Año ${anio}</h3>
    <div class="grid-3">${stat('Facturado del año', y[0], 'stat--blue')}${stat('Gastos del año', y[1], 'stat--yellow')}${stat('Beneficio del año', y[2], 'stat--pink')}</div>
    <h3 class="form-sub" style="margin:18px 0 10px">${MESNOM} (mes actual)</h3>
    <div class="grid-3">${stat('Facturado del mes', curMes.facturado, 'stat--blue')}${stat('Gastos del mes', curMes.gastos, 'stat--yellow')}${stat('Beneficio del mes', curMes.beneficio, 'stat--pink')}</div>
    <div class="panel"><div class="panel__head"><h3>Evolución · últimos 12 meses</h3></div><div class="panel__body">${chartSvg(chart)}</div></div>
    <div class="panel"><div class="panel__head"><h3>Desglose mensual ${anio}</h3></div><div class="panel__body"><div class="table-wrap"><table class="dt"><thead><tr><th>Mes</th><th style="text-align:right">Facturado</th><th style="text-align:right">Gastos</th><th style="text-align:right">Beneficio</th></tr></thead><tbody>
      ${monthly.map(m => `<tr><td><b>${esc(m.mes)}</b></td><td style="text-align:right">${fmtEur(m.facturado)}</td><td style="text-align:right;color:#c77">${m.gastos ? '−' + fmtEur(m.gastos) : fmtEur(0)}</td><td style="text-align:right;font-weight:700;color:${m.beneficio >= 0 ? '#0B8043' : '#D50000'}">${fmtEur(m.beneficio)}</td></tr>`).join('')}
      <tr style="border-top:2px solid var(--onyx)"><td><b>TOTAL ${anio}</b></td><td style="text-align:right"><b>${fmtEur(y[0] || 0)}</b></td><td style="text-align:right;color:#c77"><b>−${fmtEur(y[1] || 0)}</b></td><td style="text-align:right;font-weight:800;color:${(y[2] || 0) >= 0 ? '#0B8043' : '#D50000'}">${fmtEur(y[2] || 0)}</b></td></tr>
    </tbody></table></div></div></div>`, ['Beneficios']);
});
on(/^#\/backups$/, async () => {
  if (!requireAdmin()) return;
  loading(['Copias de seguridad']);
  const fmtSize = b => { b = +b || 0; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(2) + ' GB'; };
  const fmtDate = s => { try { return new Date(s).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return s; } };
  async function render() {
    const r = await api('backups').catch(() => ({ backups: [] }));
    const cc = await api('cloud-backup-config').catch(() => ({ config: {} }));
    const cfg = cc.config || {};
    const cloud = r.cloud || {};
    const ac = await api('attachment-cleanup').catch(() => ({ config: { enabled: false, months: 3 }, preview: {} }));
    const acc = ac.config || { enabled: false, months: 3 }; const acp = ac.preview || {};
    const list = r.backups || [], last = r.lastBackup;
    const st = r.status || {};
    let banner = '';
    if (st.lastError && !st.healthy) banner = `<div class="banner banner--err" style="margin-bottom:12px;padding:12px 14px;border-radius:10px;background:#FDECEA;color:#B71C1C;border:1px solid #F5C6CB"><b>⚠ La última copia automática falló</b> (${fmtDate(st.lastError.date)}). ${esc(st.lastError.message || '')}. Se ha avisado por email a administración. Revisa el servidor (espacio en disco).</div>`;
    else if (st.stale) banner = `<div class="banner" style="margin-bottom:12px;padding:12px 14px;border-radius:10px;background:#FFF8E1;color:#8a6d00;border:1px solid #FFE49A"><b>⚠ Hace más de 30 minutos que no se hace una copia correcta.</b> Comprueba que el servidor está funcionando.</div>`;
    else banner = `<div class="banner" style="margin-bottom:12px;padding:10px 14px;border-radius:10px;background:#E8F5E9;color:#1B5E20;border:1px solid #BEE3C2">✅ Copias funcionando correctamente.</div>`;
    const locBytes = st.totalBytes || 0, locMax = st.maxBytes || 0;
    const locPct = locMax ? Math.min(100, Math.round(locBytes / locMax * 100)) : 0;
    const locCol = locPct >= 90 ? '#B71C1C' : (locPct >= 70 ? '#C77700' : '#1B5E20');
    const localBar = locMax ? `<div style="max-width:560px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px"><span>Copias en el servidor${st.count != null ? ' (' + st.count + ')' : ''}</span><span><b>${fmtSize(locBytes)}</b> de ${fmtSize(locMax)} máx · ${locPct}%</span></div>
      <div style="height:12px;border-radius:999px;background:rgba(0,0,0,.08);overflow:hidden"><div style="height:100%;width:${Math.max(2, locPct)}%;background:${locCol};transition:width .3s"></div></div>
      <p class="hint" style="margin-top:6px">Se guardan escalonadas (2 h al minuto · 48 h cada 30 min · 30 días por día; de 02:00 a 06:00 menos copias) y las antiguas se borran solas. Nunca superan el máximo.</p>
    </div>` : '';
    let cloudBanner = '';
    if (!cfg.enabled) cloudBanner = `<div class="banner" style="margin-bottom:12px;padding:10px 14px;border-radius:10px;background:#EEF2F7;color:#334;border:1px solid #D6DEE8">La copia en la nube está <b>desactivada</b>. Rellena los datos y marca «Activar».</div>`;
    else if (cloud.reachError) cloudBanner = `<div class="banner banner--err" style="margin-bottom:12px;padding:12px 14px;border-radius:10px;background:#FDECEA;color:#B71C1C;border:1px solid #F5C6CB"><b>⚠ No se pudo contactar con la nube.</b> ${esc(cloud.reachError)}. Revisa el endpoint, la región y las claves.</div>`;
    else if (cloud.lastError && (!cloud.lastOk || new Date(cloud.lastError.date) > new Date(cloud.lastOk.date))) cloudBanner = `<div class="banner" style="margin-bottom:12px;padding:12px 14px;border-radius:10px;background:#FFF8E1;color:#8a6d00;border:1px solid #FFE49A"><b>⚠ La última subida a la nube falló</b> (${fmtDate(cloud.lastError.date)}). ${esc(cloud.lastError.message || '')}</div>`;
    else cloudBanner = `<div class="banner" style="margin-bottom:12px;padding:10px 14px;border-radius:10px;background:#E8F5E9;color:#1B5E20;border:1px solid #BEE3C2">✅ Copia en la nube activa. ${cloud.remoteCount != null ? cloud.remoteCount + ' copias de la base de datos' : ''}${cloud.remoteLast ? ' (última: ' + fmtDate(cloud.remoteLast) + ')' : ''}${cloud.filesCount != null ? ' · ' + cloud.filesCount + ' copias de archivos' : ''}${cloud.filesLast ? ' (última: ' + fmtDate(cloud.filesLast) + ')' : ''}.</div>`;
    let storageBar = '';
    if (cfg.enabled && cloud.bytes != null && cloud.freeLimit) {
      const pct = Math.min(100, Math.round(cloud.bytes / cloud.freeLimit * 100));
      const col = pct >= 90 ? '#B71C1C' : (pct >= 70 ? '#C77700' : '#1B5E20');
      storageBar = `<div style="max-width:560px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px"><span>Almacenamiento usado en la nube</span><span><b>${fmtSize(cloud.bytes)}</b> de 10 GB gratis · ${pct}%</span></div>
        <div style="height:12px;border-radius:999px;background:rgba(0,0,0,.08);overflow:hidden"><div style="height:100%;width:${Math.max(2, pct)}%;background:${col};transition:width .3s"></div></div>
        ${pct >= 80 ? '<p class="hint" style="color:#B71C1C;margin-top:6px">⚠ Te acercas al límite gratuito de 10 GB. Revisa el ciclo de vida del bucket (que borre versiones antiguas) o valora ampliar.</p>' : ''}
      </div>`;
    }
    const tagLabel = t => t === 'pre' ? 'previa a mantenimiento' : t === 'prr' ? 'previa a restauración' : '';
    const rows = list.map(b => {
      const lbl = tagLabel(b.tag);
      const tr = b.pre ? ' style="background:#eafaf0"' : '';
      const nameCell = `<b>${esc(b.name)}</b>${lbl ? ` <span class="tag tag--green" style="margin-left:6px;white-space:nowrap">🛡 ${esc(lbl)}</span>` : ''}`;
      return `<tr${tr}><td>${nameCell}</td><td>${fmtDate(b.date)}</td><td style="text-align:right">${fmtSize(b.size)}</td><td style="text-align:right;white-space:nowrap"><button class="btn btn--sm" data-restore="${esc(b.name)}" title="Restaurar la intranet a este punto">↩ Restaurar</button> <a class="btn btn--sm" href="/api/backups/download?name=${encodeURIComponent(b.name)}" download>⬇ Descargar</a></td></tr>`;
    }).join('');
    shell(`${pageHead('Copias de seguridad', 'Copias automáticas de la base de datos (bodas, usuarios, tarifas…).')}
      ${banner}
      ${localBar}
      <div class="grid-3" style="margin-bottom:14px">
        <div class="stat stat--blue"><div class="k">Última copia</div><div class="v" style="font-size:18px">${last ? fmtDate(last.date) : '—'}</div></div>
        <div class="stat"><div class="k">Copias guardadas</div><div class="v">${r.count || 0}</div></div>
        <div class="stat stat--yellow"><div class="k">Espacio ocupado</div><div class="v" style="font-size:18px">${fmtSize(r.totalSize || 0)}</div></div>
      </div>
      <div class="btn-row" style="margin-bottom:12px"><button class="btn btn--primary" id="bkNow">💾 Crear copia ahora</button> <button class="btn" id="bkPre">🛡 Crear copia previa a mantenimiento</button></div>
      <p class="hint" style="margin-bottom:12px">Copia automática al arrancar y <b>cada 5 minutos</b> (de 02:00 a 06:00, menos a menudo). Se guardan escalonadas (2 h al minuto · 48 h cada 30 min · 30 días por día) y las antiguas se borran solas. Las <b>🛡 protegidas</b> (previas a mantenimiento o restauración) <b>no se borran nunca</b>. Con <b>↩ Restaurar</b> vuelves la intranet a ese punto: antes se guarda sola una copia del estado actual (reversible) y el servicio se reinicia solo (~1 min).</p>
      <div class="table-wrap"><table class="dt"><thead><tr><th>Archivo</th><th>Fecha</th><th style="text-align:right">Tamaño</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">Aún no hay copias (se creará una en breve).</td></tr>'}</tbody></table></div>

      <h2 style="margin:26px 0 6px">☁️ Copia en la nube (fuera del servidor)</h2>
      <p class="hint" style="margin-bottom:12px">Segunda copia automática en <b>Backblaze B2</b> (región Europa). Si el servidor se estropeara, los datos seguirían a salvo aquí. Cada copia local (cada 7 min) se sube también a la nube, y las antiguas se borran solas. La clave secreta se guarda <b>solo en tu servidor</b>; no se muestra una vez guardada.</p>
      ${cloudBanner}
      ${storageBar}
      <div class="card" style="padding:16px;border:1px solid var(--line,#e5e7eb);border-radius:12px;max-width:560px">
        <div style="display:grid;gap:10px">
          <label>Endpoint (Punto final)<input id="cbEndpoint" class="inp" value="${esc(cfg.endpoint || '')}" placeholder="s3.eu-central-003.backblazeb2.com"></label>
          <label>Bucket<input id="cbBucket" class="inp" value="${esc(cfg.bucket || '')}" placeholder="conectaso-backups"></label>
          <label>Región<input id="cbRegion" class="inp" value="${esc(cfg.region || '')}" placeholder="eu-central-003"></label>
          <label>keyID<input id="cbKeyId" class="inp" value="${esc(cfg.keyId || '')}" placeholder="000..."></label>
          <label>applicationKey (clave secreta)<input id="cbAppKey" class="inp" type="password" autocomplete="new-password" placeholder="${cfg.hasAppKey ? '•••••••• (guardada — déjalo en blanco para no cambiarla)' : 'pega aquí tu clave'}"></label>
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="cbEnabled" ${cfg.enabled ? 'checked' : ''}> <span>Activar copia automática en la nube</span></label>
        </div>
        <div class="btn-row" style="margin-top:14px;flex-wrap:wrap;gap:8px">
          <button class="btn btn--primary" id="cbSave">Guardar</button>
          <button class="btn" id="cbTest">🔌 Probar conexión</button>
          <button class="btn" id="cbSync">⬆ Subir base de datos ahora</button>
          <button class="btn" id="cbSyncFiles">🗂 Subir archivos ahora</button>
        </div>
        <p class="hint" style="margin-top:10px">La copia incluye <b>la base de datos</b> (bodas, pagos, facturas, tarifas, observaciones…) <b>y todos los archivos subidos</b> (nóminas, planos, adjuntos y fotos de eventos, logos de fotomatón). Los archivos solo se vuelven a subir cuando cambian.</p>
      </div>

      <h2 style="margin:26px 0 6px">💽 Copia local en tu NAS (Synology)</h2>
      <p class="hint" style="margin-bottom:12px">El NAS de la nave puede descargar <b>cada noche</b> una copia completa (base de datos + archivos) desde aquí, sin exponer el NAS a internet. Pulsa el botón para obtener el enlace seguro y el script que hay que pegar en el <b>Programador de tareas</b> del NAS.</p>
      <div class="card" style="padding:16px;border:1px solid var(--line,#e5e7eb);border-radius:12px;max-width:680px">
        <div class="btn-row" style="flex-wrap:wrap;gap:8px"><button class="btn btn--primary" id="nasGet">🔑 Preparar enlace para el NAS</button> <button class="btn" id="nasRegen">♻ Regenerar clave</button></div>
        <div id="nasOut" style="margin-top:12px"></div>
      </div>

      <h2 style="margin:26px 0 6px">🧹 Liberar espacio (bodas antiguas)</h2>
      <p class="hint" style="margin-bottom:12px">Borra los archivos adjuntos (fotos, documentos) y el logo de fotomatón de las bodas que ya pasaron hace más de los meses indicados, para no acumular peso. <b>Nunca toca nóminas.</b> Es irreversible en el servidor, aunque los archivos siguen en la copia de la nube durante su retención (hasta ~90 días).</p>
      <div class="card" style="padding:16px;border:1px solid var(--line,#e5e7eb);border-radius:12px;max-width:560px">
        <div class="grid-3" style="margin-bottom:12px">
          <div class="stat stat--blue"><div class="k">Bodas antiguas</div><div class="v">${acp.oldEvents || 0}</div></div>
          <div class="stat"><div class="k">Archivos a liberar</div><div class="v">${acp.files || 0}${acp.logos ? ' + ' + acp.logos + ' logos' : ''}</div></div>
          <div class="stat stat--yellow"><div class="k">Espacio liberable</div><div class="v" style="font-size:18px">${fmtSize(acp.totalBytes || 0)}</div></div>
        </div>
        <div style="display:grid;gap:10px">
          <label>Borrar adjuntos de bodas de hace más de
            <select id="acMonths" class="inp">${[2, 3, 4, 6, 9, 12].map(m => `<option value="${m}" ${(+acc.months === m) ? 'selected' : ''}>${m} meses</option>`).join('')}</select>
          </label>
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="acEnabled" ${acc.enabled ? 'checked' : ''}> <span>Activar limpieza automática (se ejecuta una vez al día)</span></label>
        </div>
        <div class="btn-row" style="margin-top:14px;flex-wrap:wrap;gap:8px">
          <button class="btn btn--primary" id="acSave">Guardar</button>
          <button class="btn btn--red" id="acRun">🧹 Limpiar ahora</button>
        </div>
      </div>`, ['Copias de seguridad']);
    const bn = el('bkNow');
    if (bn) bn.onclick = async () => { bn.disabled = true; bn.textContent = 'Creando…'; try { await api('backups/create', { method: 'POST' }); toast('Copia creada', 'ok'); } catch (e) { toast(e.message || 'Error', 'err'); } render(); };
    const bp = el('bkPre');
    if (bp) bp.onclick = async () => { bp.disabled = true; bp.textContent = 'Creando…'; try { await api('backups/create', { method: 'POST', body: { pre: true } }); toast('Copia previa a mantenimiento creada', 'ok'); } catch (e) { toast(e.message || 'Error', 'err'); } render(); };
    // Copia local al NAS: obtener el enlace seguro + el script para el Programador de tareas.
    const showNas = (d) => {
      const full = d.url + '?token=' + d.token;
      const script = ['#!/bin/sh',
        'DEST="/volume1/copias-intranet"',
        'mkdir -p "$DEST"',
        'OUT="$DEST/conectaso-$(date +%Y%m%d-%H%M).tar.gz"',
        'if command -v curl >/dev/null 2>&1; then curl -fsS "' + full + '" -o "$OUT"; else wget -q "' + full + '" -O "$OUT"; fi',
        '# conserva las ultimas 30 copias (~15 dias con 2 al dia) y borra las mas viejas',
        'ls -1t "$DEST"/conectaso-*.tar.gz 2>/dev/null | tail -n +31 | while read f; do rm -f "$f"; done'].join('\n');
      const out = el('nasOut'); if (!out) return;
      out.innerHTML = `<p style="margin:0 0 6px"><b>Enlace seguro</b> (no lo compartas, da acceso a las copias):</p>
        <textarea class="inp" rows="2" readonly style="width:100%;font-family:monospace;font-size:12px" onclick="this.select()">${esc(full)}</textarea>
        <p style="margin:12px 0 6px"><b>Script para el NAS</b> (Programador de tareas → Tarea programada → Script definido por el usuario):</p>
        <textarea class="inp" rows="6" readonly style="width:100%;font-family:monospace;font-size:12px" onclick="this.select()">${esc(script)}</textarea>
        <p class="hint" style="margin-top:8px">Crea en el NAS una carpeta compartida llamada <b>copias-intranet</b> y una tarea programada que ejecute este script <b>2 veces al día</b> (p. ej. primera a las 03:30 y repetir cada 12 h). Mantendrá las <b>últimas 30</b> copias (~15 días).</p>`;
    };
    const nasGet = el('nasGet');
    if (nasGet) nasGet.onclick = async () => { nasGet.disabled = true; try { const d = await api('backups/nas-config'); showNas(d); } catch (e) { toast(e.message || 'Error', 'err'); } nasGet.disabled = false; };
    const nasRegen = el('nasRegen');
    if (nasRegen) nasRegen.onclick = () => modal('♻ Regenerar clave', '<p>Se creará una clave nueva y <b>el script anterior dejará de funcionar</b>. Tendrás que pegar el nuevo script en el NAS.</p><p class="hint">¿Seguro?</p>', { okText: 'Regenerar', onOk: async () => { try { const d = await api('backups/nas-token', { method: 'POST' }); showNas(d); toast('Clave regenerada', 'ok'); } catch (e) { toast(e.message || 'Error', 'err'); } } });
    // Restaurar desde una copia: doble confirmación (es una acción fuerte) y reinicio automático.
    $$('[data-restore]').forEach(btn => btn.onclick = () => {
      const name = btn.dataset.restore;
      modal('↩ Restaurar desde copia', `
        <p style="margin-bottom:10px">Vas a <b>restaurar toda la intranet</b> al estado de la copia:</p>
        <p style="margin:0 0 10px"><b>${esc(name)}</b></p>
        <p class="hint" style="margin-bottom:10px">Se <b>sobrescriben</b> todos los datos actuales (bodas, pagos, tarifas…) con los de esa copia. Antes, el sistema guarda <b>automáticamente</b> una copia del estado actual ("previa a restauración"), por si necesitas volver atrás. El servicio se <b>reiniciará solo</b> y estará disponible en ~1 minuto.</p>
        <div class="field"><label>Para confirmar, escribe <b>RESTAURAR</b></label><input class="control" id="rstConfirm" autocomplete="off" placeholder="RESTAURAR"></div>`, {
        okText: '↩ Restaurar ahora', danger: true, onOk: async () => {
          if (((el('rstConfirm') || {}).value || '').trim().toUpperCase() !== 'RESTAURAR') { toast('Escribe RESTAURAR para confirmar', 'err'); return true; }
          try {
            await api('backups/restore', { method: 'POST', body: { name } });
            shell(`${pageHead('Restaurando…', 'La intranet se está restaurando y reiniciando.')}<div class="panel"><div class="panel__body"><p>⏳ <b>Restaurando desde ${esc(name)}…</b></p><p class="hint">El servicio se está reiniciando. Esta página se recargará sola en unos segundos. Si no, recárgala a mano en ~1 minuto.</p></div></div>`, ['Copias de seguridad']);
            setTimeout(() => location.reload(), 45000);
          } catch (e) { toast(e.message || 'Error', 'err'); return true; }
        }
      });
    });
    const cbSave = el('cbSave');
    if (cbSave) cbSave.onclick = async () => {
      const body = { endpoint: el('cbEndpoint').value, bucket: el('cbBucket').value, region: el('cbRegion').value, keyId: el('cbKeyId').value, enabled: el('cbEnabled').checked };
      const ak = el('cbAppKey').value; if (ak) body.appKey = ak;   // en blanco = conservar la guardada
      cbSave.disabled = true; cbSave.textContent = 'Guardando…';
      try { await api('cloud-backup-config', { method: 'POST', body }); toast('Configuración guardada', 'ok'); } catch (e) { toast(e.message || 'Error', 'err'); }
      render();
    };
    const cbTest = el('cbTest');
    if (cbTest) cbTest.onclick = async () => { cbTest.disabled = true; cbTest.textContent = 'Probando…'; try { await api('cloud-backup-test', { method: 'POST' }); toast('✅ Conexión correcta con la nube', 'ok'); } catch (e) { toast(e.message || 'Error', 'err'); } cbTest.disabled = false; cbTest.textContent = '🔌 Probar conexión'; };
    const cbSync = el('cbSync');
    if (cbSync) cbSync.onclick = async () => { cbSync.disabled = true; cbSync.textContent = 'Subiendo…'; try { await api('cloud-backup-sync', { method: 'POST' }); toast('✅ Base de datos subida a la nube', 'ok'); } catch (e) { toast(e.message || 'Error', 'err'); } render(); };
    const cbSyncFiles = el('cbSyncFiles');
    if (cbSyncFiles) cbSyncFiles.onclick = async () => { cbSyncFiles.disabled = true; cbSyncFiles.textContent = 'Subiendo…'; try { await api('cloud-backup-sync-files', { method: 'POST' }); toast('✅ Archivos subidos a la nube', 'ok'); } catch (e) { toast(e.message || 'Error', 'err'); } render(); };
    const acSave = el('acSave');
    if (acSave) acSave.onclick = async () => { acSave.disabled = true; acSave.textContent = 'Guardando…'; try { await api('attachment-cleanup', { method: 'POST', body: { enabled: el('acEnabled').checked, months: +el('acMonths').value } }); toast('Guardado', 'ok'); } catch (e) { toast(e.message || 'Error', 'err'); } render(); };
    const acRun = el('acRun');
    if (acRun) acRun.onclick = () => {
      const m = +el('acMonths').value;
      modal('Liberar espacio', `Se borrarán <b>definitivamente del servidor</b> los adjuntos y logos de las bodas de hace más de <b>${m} meses</b> (${acp.files || 0} archivos${acp.logos ? ' + ' + acp.logos + ' logos' : ''}, ${fmtSize(acp.totalBytes || 0)}).<br><br>Las nóminas no se tocan. Los archivos seguirán en la copia de la nube durante su retención. ¿Continuar?`, {
        okText: 'Sí, liberar espacio', danger: true, onOk: async () => {
          try { const r = await api('attachment-cleanup/run', { method: 'POST' }); const rr = r.result || {}; toast(`✅ Liberados ${rr.files || 0} archivos y ${rr.logos || 0} logos`, 'ok'); } catch (e) { toast(e.message || 'Error', 'err'); } render();
        }
      });
    };
  }
  render();
});

function chartSvg(data) {
  if (!data.length) return '<div class="empty">Sin datos.</div>';
  const W = 900, H = 320, pad = 40;
  const max = Math.max(...data.flatMap(r => [r[1], r[2], r[3]]), 1);
  const x = i => pad + i * (W - 2 * pad) / (data.length - 1);
  const yv = v => H - pad - v / max * (H - 2 * pad);
  const line = (idx, col) => `<polyline fill="none" stroke="${col}" stroke-width="3" points="${data.map((r, i) => x(i) + ',' + yv(r[idx])).join(' ')}"/>` + data.map((r, i) => `<circle cx="${x(i)}" cy="${yv(r[idx])}" r="4" fill="#fff" stroke="${col}" stroke-width="2"/>`).join('');
  const labels = data.map((r, i) => `<text x="${x(i)}" y="${H - 12}" font-size="10" text-anchor="middle" fill="#6a6472">${esc(r[0].slice(0, 3))}</text>`).join('');
  return `<div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:640px;font-family:var(--body)">
    ${line(1, '#31B9CB')}${line(2, '#E82C88')}${line(3, '#0B8043')}${labels}
    <g transform="translate(${pad},12)" font-size="12"><rect width="12" height="12" fill="#31B9CB"/><text x="18" y="11">Facturado</text>
      <rect x="110" width="12" height="12" fill="#E82C88"/><text x="128" y="11">Gastos</text>
      <rect x="210" width="12" height="12" fill="#0B8043"/><text x="228" y="11">Beneficio</text></g></svg></div>`;
}

/* =========================================================================
   VEHÍCULOS
   ========================================================================= */
const fmtDT = iso => { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
on(/^#\/vehiculos$/, async () => {
  if (S.user.role === 'dj' && !S.user.vehicle_allowed) { shell('<div class="empty">No tienes vehículo habilitado.</div>', ['Vehículos']); return; }
  loading(['Vehículos']);
  const [vehicles, usages] = await Promise.all([coll.list('vehicles'), coll.list('usages')]);
  const admin = isAdmin();
  const openUse = vid => usages.find(u => u.vehicleId == vid && !u.end);
  const openUsages = usages.filter(u => !u.end);
  shell(`${pageHead('Vehículos', admin ? 'Flota y su historial de uso.' : 'Flota disponible y tu historial de uso.', admin ? `${openUsages.length ? `<button class="btn btn--blue" id="endAllUse">Terminar usos activos (${openUsages.length})</button> ` : ''}<button class="btn btn--primary" id="newVeh">+ Añadir vehículo</button>` : '')}
    <div class="panel"><div class="panel__head"><h3>Vehículos</h3></div><div class="panel__body"><div class="table-wrap"><table class="dt"><thead><tr><th>Matrícula</th><th>Marca</th><th>Modelo</th><th>Color</th><th>Disponible</th><th>ITV</th><th>Seguro</th><th></th></tr></thead><tbody>
      ${vehicles.map(v => { const u = openUse(v.id); return `<tr><td><b>${esc(v.license_plate)}</b></td><td>${esc(v.brand)}</td><td>${esc(v.model)}</td><td>${esc(v.color)}</td><td>${u ? dot('#D50000', 'En uso') : dot('#0B8043', 'Disponible')}</td><td>${slash(v.itvDate)}</td><td>${slash(v.insuranceRenewal)}</td>
        <td class="row-actions">${u ? `<button class="btn btn--sm" data-end="${u.id}">Terminar uso</button>` : `<button class="btn btn--sm btn--blue" data-start="${v.id}">Iniciar uso</button>`}${admin ? `<button class="btn btn--sm" data-edit="${v.id}">Editar</button>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div></div></div>
    <div class="panel"><div class="panel__head"><h3>Historial de uso</h3></div><div class="panel__body">${table('dtUse', { rows: usages, order: [0, 'desc'], cols: [
      { t: 'Matrícula', get: u => (vehicles.find(v => v.id == u.vehicleId) || {}).license_plate || '' },
      { t: 'Trabajador', get: u => userName(u.userId) },
      { t: 'Inicio', get: u => u.start || '', html: u => fmtDT(u.start) }, { t: 'Fin', get: u => u.end || '', html: u => u.end ? fmtDT(u.end) : '<span class="tag tag--yellow">En uso</span>' },
    ] })}</div></div>`, ['Vehículos']);
  if (admin) { el('newVeh').onclick = () => vehForm({}); $$('[data-edit]').forEach(b => b.onclick = () => vehForm(vehicles.find(v => v.id == b.dataset.edit)));
    const endAll = el('endAllUse'); if (endAll) endAll.onclick = () => modal('Terminar usos activos', `¿Terminar los <b>${openUsages.length}</b> usos de furgoneta que siguen abiertos? Se cerrarán con la fecha y hora actuales.`, { okText: 'Terminar todos', onOk: async () => { const now = new Date().toISOString(); for (const u of openUsages) { try { await coll.save('usages', Object.assign({}, u, { end: now })); } catch (e) {} } toast('Usos terminados', 'ok'); location.reload(); } }); }
  $$('[data-start]').forEach(b => b.onclick = async () => { await coll.save('usages', { vehicleId: +b.dataset.start, userId: S.user.id, start: new Date().toISOString(), end: null }); toast('Uso iniciado', 'ok'); location.reload(); });
  $$('[data-end]').forEach(b => b.onclick = async () => { const u = usages.find(x => x.id == b.dataset.end); await coll.save('usages', Object.assign({}, u, { end: new Date().toISOString() })); toast('Uso terminado', 'ok'); location.reload(); });
});
function vehForm(v) {
  const f = (lab, n, t) => `<div class="field"><label>${lab}</label>${inp(n, v[n], { type: t || 'text' })}</div>`;
  modal(v.id ? 'Editar vehículo' : 'Nuevo vehículo', `<form id="vehForm"><div class="grid-2">${f('Marca', 'brand')}${f('Modelo', 'model')}</div><div class="grid-2">${f('Color', 'color')}${f('Matrícula', 'license_plate')}</div><div class="grid-2">${f('Próxima ITV', 'itvDate', 'date')}${f('Renovación seguro', 'insuranceRenewal', 'date')}</div><div class="field"><label>Observaciones</label>${ta('observations', v.observations)}</div></form>`,
    { okText: 'Guardar', onOk: async () => { const d = collectForm($('#vehForm')); await coll.save('vehicles', Object.assign({ id: v.id }, d)); toast('Guardado', 'ok'); location.reload(); } });
}

/* =========================================================================
   MANTENIMIENTO — el DJ crea un parte (con fotos) y administración lo gestiona
   ========================================================================= */
const URG = { baja: ['Baja', 'tag--green'], media: ['Media', 'tag--yellow'], alta: ['Alta', 'tag--red'] };
on(/^#\/mantenimiento$/, () => mantenimientoPage());
async function mantenimientoPage() {
  loading(['Mantenimiento']);
  const admin = isAdmin();
  const items = await coll.list('maintenance');
  // cargar las imágenes de cada parte
  const imgs = {};
  await Promise.all(items.map(async m => { try { const r = await api('files/mant-list/' + m.id); imgs[m.id] = r.files || []; } catch (e) { imgs[m.id] = []; } }));
  const urgRank = { alta: 0, media: 1, baja: 2 };
  const pend = items.filter(m => m.status !== 'completado').sort((a, b) => (urgRank[a.urgency] - urgRank[b.urgency]) || (b.date || '').localeCompare(a.date || ''));
  const done = items.filter(m => m.status === 'completado').sort((a, b) => (b.fixedAt || '').localeCompare(a.fixedAt || ''));
  const thumbs = m => (imgs[m.id] || []).length ? `<div class="mant-imgs">${imgs[m.id].map(f => `<img class="mant-thumb" src="/api/files/${f.id}" data-zoom="/api/files/${f.id}" alt="foto" title="Clic para ampliar" loading="lazy">`).join('')}</div>` : '';
  const card = (m, isDone) => `<div class="panel mant-card mant-card--${m.urgency || 'media'}"><div class="panel__body">
      <div class="mant-top"><div><b class="mant-subj">${esc(m.subject || 'Parte de mantenimiento')}</b>
        <div class="mant-meta">${esc(userName(m.userId))} · ${m.date ? dmy(m.date) : ''}${isDone && m.fixedAt ? ' · <b>Arreglado el ' + dmy(m.fixedAt) + '</b>' : ''}</div></div>
        <span class="tag ${(URG[m.urgency] || URG.media)[1]}">Urgencia: ${(URG[m.urgency] || URG.media)[0]}</span></div>
      ${m.desc ? `<p class="mant-desc">${esc(m.desc)}</p>` : ''}
      ${thumbs(m)}
      ${admin && !isDone ? `<div class="mant-actions">
        <label>Urgencia ${sel('', [['baja', 'Baja'], ['media', 'Media'], ['alta', 'Alta']], m.urgency || 'media', 'data-urg="' + m.id + '"')}</label>
        <button class="btn btn--sm btn--primary" data-fix="${m.id}">✓ Marcar arreglado</button>
        <button class="btn btn--icon" data-delm="${m.id}" title="Eliminar">🗑</button></div>` : ''}
      ${!admin && !isDone ? `<div class="mant-actions"><span class="muted">Pendiente de revisar por administración.</span><button class="btn btn--icon" data-delm="${m.id}" title="Eliminar">🗑</button></div>` : ''}
    </div></div>`;
  shell(`${pageHead('Mantenimiento', admin ? 'Partes de avería del equipo.' : 'Crea un parte cuando algo falle (con fotos).', `<button class="btn btn--primary" id="newMant">+ Nuevo parte</button>`)}
    <h3 class="form-sub" style="margin:4px 0 10px">Pendientes (${pend.length})</h3>
    ${pend.length ? pend.map(m => card(m, false)).join('') : '<div class="empty">No hay partes pendientes.</div>'}
    <div class="btn-row" style="margin:22px 0 10px"><button class="btn btn--sm" id="toggleDone">✅ Ver completados (${done.length})</button></div>
    <div id="doneWrap" style="display:none">${done.length ? done.map(m => card(m, true)).join('') : '<div class="empty">Sin partes completados.</div>'}</div>`, ['Mantenimiento']);
  el('newMant').onclick = () => mantForm();
  { const td = el('toggleDone'); if (td) td.onclick = () => { const w = el('doneWrap'); const open = w.style.display !== 'none'; w.style.display = open ? 'none' : 'block'; td.textContent = (open ? '✅ Ver completados (' : '🔽 Ocultar completados (') + done.length + ')'; }; }
  if (admin) {
    $$('[data-urg]').forEach(s => s.onchange = async () => { const m = items.find(x => x.id == s.dataset.urg); await coll.save('maintenance', Object.assign({}, m, { urgency: s.value })); toast('Urgencia actualizada', 'ok'); mantenimientoPage(); });
    $$('[data-fix]').forEach(b => b.onclick = async () => { const m = items.find(x => x.id == b.dataset.fix); await coll.save('maintenance', Object.assign({}, m, { status: 'completado' })); toast('Parte marcado como arreglado', 'ok'); mantenimientoPage(); });
  }
  $$('[data-delm]').forEach(b => b.onclick = () => modal('Eliminar parte', '¿Eliminar este parte de mantenimiento?', { okText: 'Eliminar', danger: true, onOk: async () => { await coll.del('maintenance', b.dataset.delm); toast('Eliminado', 'ok'); mantenimientoPage(); } }));
}
function mantForm() {
  const bg = modal('Nuevo parte de mantenimiento', `<form id="mForm">
    <div class="field"><label>¿Qué falla?</label>${inp('subject', '', { ph: 'Ej. Altavoz derecho no suena' })}</div>
    <div class="field"><label>Explicación</label>${ta('desc', '', 'Describe el problema con detalle…')}</div>
    <div class="field"><label>Fotos (opcional)</label><input type="file" id="mImgs" class="control" accept="image/*" multiple><p class="hint">Puedes adjuntar varias fotos del problema.</p></div>
  </form>`, { okText: 'Enviar parte', onOk: async () => {
    const d = collectForm($('#mForm'));
    if (!d.subject || !d.subject.trim()) { toast('Indica qué falla', 'err'); return true; }
    try {
      const r = await coll.save('maintenance', { subject: d.subject.trim(), desc: d.desc || '' });
      const id = r.item.id;
      const files = ($('#mImgs', bg) || {}).files;
      if (files && files.length) { const fd = new FormData(); for (const f of files) fd.append('file', f, f.name); await api('files/maintenance/' + id, { method: 'POST', form: fd }); }
      toast('Parte enviado', 'ok'); mantenimientoPage();
    } catch (e) { toast(e.message || 'No se pudo enviar', 'err'); return true; }
  } });
}

/* =========================================================================
   TYC (admin)
   ========================================================================= */
on(/^#\/tyc$/, async () => {
  if (!requireAdmin()) return; loading(['TYC']);
  const r = await api('tyc/current');
  const t = r.tyc;
  shell(`${pageHead('Términos y condiciones de servicio', 'Contrato que cada boda acepta y firma electrónicamente. El estado de cada firma y su PDF descargable están en la lista de Usuarios.')}
    <div class="panel"><div class="panel__head"><h3>${esc((t.title || 'Contrato').replace(/\s*\b(19|20)\d{2}\b\s*$/, ''))}</h3><button class="btn btn--sm btn--primary" id="editTac">Editar contrato</button></div>
      <div class="panel__body">
        <div class="pdf-grid" style="margin-bottom:12px"><div>Versión del contrato: <b>${esc(t.version || '—')}</b></div></div>
        <p class="hint"><b>El año de la boda se añade solo</b> al título de cada contrato (p. ej. "…de servicio 2026" para una boda de 2026). La "versión" de arriba es solo un identificador interno para saber qué texto firmó cada pareja. Al aceptar, en el PDF de cada boda se rellenan automáticamente los contratantes, DNI, lugar y fecha del evento.</p>
        <div class="readbox tyc-body" style="max-height:none">${t.text || ''}</div>
      </div></div>
    <div class="panel"><div class="panel__head"><h3>Política de privacidad</h3><button class="btn btn--sm btn--primary" id="editPriv">Editar política</button></div>
      <div class="panel__body">
        <p class="hint">Las <b>parejas</b> la aceptan <b>a la vez que firman el contrato</b> (un solo check, sin volver a pedir nombre ni DNI). No aplica a wedding planners ni a DJs. Texto base RGPD — revísalo con tu gestoría si quieres.</p>
        <div class="readbox tyc-body" style="max-height:none">${(r.privacy && r.privacy.text) || ''}</div>
      </div></div>`, ['TYC']);
  el('editTac').onclick = () => tacForm(t);
  el('editPriv').onclick = () => privForm(r.privacy || {});
});
function privForm(p) {
  modal('Editar política de privacidad', `<form id="privForm">
    <div class="field"><label>Contenido (HTML)</label><textarea class="control" name="text" style="min-height:300px;font-family:monospace;font-size:12px">${esc(p.text || '')}</textarea></div></form>`,
    { okText: 'Guardar', onOk: async () => { const d = collectForm($('#privForm')); await api('tyc/privacy', { method: 'PUT', body: { text: d.text } }); toast('Política de privacidad guardada', 'ok'); location.hash = '#/tyc'; CS.route ? CS.route() : location.reload(); } });
}
function tacForm(t) {
  modal('Editar términos y condiciones', `<form id="tacForm">
    <div class="field"><label>Título</label>${inp('title', t.title)}</div>
    <div class="field"><label>Versión (año)</label>${inp('date', t.version || t.date, { ph: 'Ej: 2027' })}<p class="hint">Si cambias la versión, las bodas de ese año vuelven a firmar.</p></div>
    <div class="field"><label>Contenido (HTML)</label><textarea class="control" name="text" style="min-height:240px;font-family:monospace;font-size:12px">${esc(t.text || '')}</textarea></div></form>`,
    { okText: 'Guardar', onOk: async () => { const d = collectForm($('#tacForm')); await api('tyc', { method: 'PUT', body: { id: t.id, title: d.title, date: d.date, text: d.text } }); toast('Contrato guardado', 'ok'); location.hash = '#/tyc'; CS.route ? CS.route() : location.reload(); } });
}
/* PDF del contrato firmado por un usuario (o aviso de no firmado) */
on(/^#\/tyc-firma\/(\d+)$/, async m => {
  if (!requireAdmin()) return; loading(['Usuarios', 'TYC']);
  const r = await api('tyc/signature/' + m[1]);
  const a = r.autofill || {}, s = r.signature, u = r.user;
  const fecha = a.fecha ? dmy(a.fecha) : '';
  const text = (r.tyc.text || '').replace(/\{novios\}/g, `<b>${esc(a.novios || '—')}</b>`).replace(/\{finca\}/g, `<b>${esc(a.finca || '—')}</b>`).replace(/\{fecha\}/g, `<b>${esc(fecha || '—')}</b>`);
  const head = `<div class="pdf-head"><img src="assets/brand/logo-principal-azul.svg" alt="Conecta So"><div style="text-align:right;color:#777;font-size:10px">Contrato interno<br>${esc(u.name)}</div></div>`;
  const firma = s
    ? `<div class="pdf-sign"><h3>Firma</h3><div class="pdf-grid">
         <div>Firmado por: <b>${esc(s.name)}</b>${s.name2 ? ` y <b>${esc(s.name2)}</b>` : ''}</div><div>Fecha de firma: <b>${esc(dmy((s.date || '').slice(0, 10)))}</b></div>
         <div>DNI: <b>${esc(s.dni || a.dnis || '—')}</b></div>${s.dni2 ? `<div>DNI 2: <b>${esc(s.dni2)}</b></div>` : ''}
         <div>Hora de aceptación: <b>${esc(((s.date || '').slice(11, 16)) || '—')}</b></div><div>Versión aceptada: <b>${esc(s.version || r.tyc.version || '—')}</b></div></div>
       <p class="pdf-signline">✓ Documento aceptado y firmado electrónicamente por los contratantes.</p></div>`
    : `<div class="pdf-notice">Esta boda <b>todavía no ha firmado</b> los términos y condiciones del servicio.</div>`;
  shell(`${pageHead('Contrato · ' + u.name, s ? 'Firmado' : 'No firmado')}
    <div class="pdf-toolbar"><a class="btn" href="#/usuarios">← Usuarios</a>${s ? '<button class="btn btn--primary" onclick="window.print()">Descargar / Imprimir PDF</button>' : ''}</div>
    <div class="pdf-page">${head}<h2>${esc(CS.tycTitleYear(r.tyc.title, a.fecha))}</h2>
      ${u.role === 'user' ? `<div class="pdf-grid" style="margin-bottom:12px">
        <div>Contratantes: <b>${esc(a.novios || '—')}</b></div><div>DNI: <b>${esc(a.dnis || '—')}</b></div>
        <div>Lugar de celebración: <b>${esc(a.finca || '—')}</b></div><div>Fecha del evento: <b>${esc(fecha || '—')}</b></div>
        <div>Versión del contrato: <b>${esc(r.tyc.version || '—')}</b></div></div>` : ''}
      <div class="tyc-body" style="font-size:12px">${text}</div>${firma}</div>`, ['Usuarios', u.name]);
});

/* El cliente ve su propio contrato firmado (o el aviso de pendiente de firmar) */
on(/^#\/mi-contrato$/, async () => {
  if (S.user.role !== 'user') { shell('<div class="empty">Sin acceso.</div>', ['Contrato']); return; }
  loading(['Mi contrato']);
  const r = await api('tyc/current');
  const a = r.autofill || {}, s = r.signature;
  const fecha = a.fecha ? dmy(a.fecha) : '';
  const text = (r.tyc.text || '').replace(/\{novios\}/g, `<b>${esc(a.novios || '—')}</b>`).replace(/\{finca\}/g, `<b>${esc(a.finca || '—')}</b>`).replace(/\{fecha\}/g, `<b>${esc(fecha || '—')}</b>`);
  const head = `<div class="pdf-head"><img src="/assets/brand/logo-principal-azul.svg" alt="Conecta So"><div style="text-align:right;color:#777;font-size:10px">Contrato de servicio<br>${esc(a.novios || S.user.name || '')}</div></div>`;
  const firma = s
    ? `<div class="pdf-sign"><h3>Firma</h3><div class="pdf-grid">
         <div>Firmado por: <b>${esc(s.name)}</b>${s.name2 ? ` y <b>${esc(s.name2)}</b>` : ''}</div><div>Fecha de firma: <b>${esc(dmy((s.date || '').slice(0, 10)))}</b></div>
         <div>DNI: <b>${esc(s.dni || a.dnis || '—')}</b></div>${s.dni2 ? `<div>DNI 2: <b>${esc(s.dni2)}</b></div>` : ''}
         <div>Versión aceptada: <b>${esc(s.version || r.tyc.version || '—')}</b></div></div>
       <p class="pdf-signline">✓ Documento aceptado y firmado electrónicamente por los contratantes.</p></div>`
    : `<div class="pdf-notice">Todavía no has firmado el contrato.</div>`;
  shell(`${pageHead('Mi contrato', s ? 'Contrato firmado' : 'Pendiente de firma')}
    <div class="pdf-toolbar">${s ? '<button class="btn btn--primary" onclick="window.print()">Descargar / Imprimir PDF</button>' : ''}</div>
    <div class="pdf-page">${head}<h2>${esc(CS.tycTitleYear(r.tyc.title, a.fecha))}</h2>
      <div class="pdf-grid" style="margin-bottom:12px">
        <div>Contratantes: <b>${esc(a.novios || '—')}</b></div><div>DNI: <b>${esc(a.dnis || '—')}</b></div>
        <div>Lugar de celebración: <b>${esc(a.finca || '—')}</b></div><div>Fecha del evento: <b>${esc(fecha || '—')}</b></div></div>
      <div class="tyc-body" style="font-size:12px">${text}</div>${firma}</div>`, ['Mi contrato']);
});

/* =========================================================================
   MI CUENTA (todos)
   ========================================================================= */
on(/^#\/cuenta$/, async () => {
  loading(['Mi cuenta']);
  // Configuración avanzada: solo administración. Agrupa secciones de uso puntual (Papelera y
  // Beneficios), protegidas con la contraseña de siempre. Se desbloquean una vez por sesión.
  const adv = S.user.role === 'admin' ? `
    <div class="panel" style="margin-top:4px"><div class="panel__head"><h3>⚙ Configuración avanzada</h3></div><div class="panel__body">
      <p class="hint" style="margin-bottom:12px">Secciones de uso puntual, protegidas con contraseña.</p>
      ${benefOk()
      ? `<div class="btn-row"><a class="btn btn--primary" href="#/beneficios">€ Beneficios</a> <a class="btn" href="#/analisis">📊 Análisis</a> <a class="btn" href="#/papelera">🗑 Papelera de eventos</a></div>
         <p class="hint" style="margin-top:10px">Desbloqueado en este dispositivo durante esta sesión.</p>
         <hr style="border:none;border-top:1px solid var(--line,#eee);margin:18px 0">
         <h4 style="margin:0 0 6px">📧 Configuración del correo</h4>
         <p class="hint" style="margin-bottom:12px">Datos de tu proveedor de correo (Brevo, Gmail…). Se guardan aquí, en la intranet — <b>no hace falta tocar el servidor</b>.</p>
         <form id="mailCfgForm" style="max-width:520px">
           <label class="chk" style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><input type="checkbox" id="mcEnabled"> <span>Correo <b>activado</b> (si lo desactivas, no se envía ningún email)</span></label>
           <div class="field"><label>Servidor SMTP</label><input class="control" id="mcHost" placeholder="smtp-relay.brevo.com"></div>
           <div class="field"><label>Puerto</label><input class="control" id="mcPort" placeholder="587"></div>
           <div class="field"><label>Usuario / Login</label><input class="control" id="mcUser" placeholder="xxxxx@smtp-brevo.com"></div>
           <div class="field"><label>Contraseña / clave SMTP</label><input class="control" type="password" id="mcPass" autocomplete="off" placeholder="(pega aquí tu clave)"></div>
           <div class="field"><label>Clave API de Brevo <span class="muted">(recomendado: envía por internet normal, evita bloqueos del servidor)</span></label><input class="control" type="password" id="mcApiKey" autocomplete="off" placeholder="(pega aquí tu clave API, empieza por xkeysib-)"></div>
           <div class="field"><label>Remitente — email del "De"</label><input class="control" id="mcFrom" placeholder="adriadeejay@gmail.com"></div>
           <div class="field"><label>Lista blanca de destinatarios <span class="muted">(solo estos reciben correos; déjalo vacío para enviar a todos — ¡úsalo en pruebas!)</span></label><input class="control" id="mcAllow" placeholder="correo1@x.com, correo2@y.com"></div>
           <div class="btn-row" style="margin-top:12px"><button type="submit" class="btn btn--primary">Guardar configuración</button></div>
         </form>
         <div id="mailCfgMsg" style="margin-top:10px;display:none;font-size:13px"></div>
         <hr style="border:none;border-top:1px solid var(--line,#eee);margin:18px 0">
         <h4 style="margin:0 0 6px">✉️ Correos de prueba</h4>
         <p class="hint" style="margin-bottom:12px">Envía una muestra de <b>todos</b> los correos de la intranet (alta, contraseña, aviso de extra y los 3 recordatorios) a una dirección, con datos de ejemplo. <b>No crea usuarios ni toca eventos</b>: solo sirve para revisarlos (p. ej. en tu bandeja de correo de pruebas).</p>
         <form id="testMailForm" style="max-width:460px"><div class="field"><label>Enviar a</label><input class="control" type="email" id="testMailTo" value="${esc(S.user.email || '')}" placeholder="tu-email@ejemplo.com"></div>
           <div class="btn-row" style="margin-top:12px"><button type="submit" class="btn btn--primary">Enviar correos de prueba</button></div></form>
         <div id="testMailMsg" style="margin-top:12px;display:none;font-size:13px"></div>
         <hr style="border:none;border-top:1px solid var(--line,#eee);margin:18px 0">
         <h4 style="margin:0 0 6px">🧾 Conexión con Holded</h4>
         <p class="hint" style="margin-bottom:12px">Pega aquí el <b>token de API de Holded</b> (solo lectura). Con él, los novios podrán ver sus facturas y el importe pagado se sincronizará desde Holded. La clave se guarda aquí, en la intranet.</p>
         <form id="holdedCfgForm" style="max-width:520px">
           <label class="chk" style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><input type="checkbox" id="hdEnabled"> <span>Conexión con Holded <b>activada</b></span></label>
           <div class="field"><label>Token de API de Holded</label><input class="control" type="password" id="hdApiKey" autocomplete="off" placeholder="(pega aquí el token)"></div>
           <div class="btn-row" style="margin-top:12px"><button type="submit" class="btn btn--primary">Guardar</button> <button type="button" class="btn" id="hdTest">Probar conexión</button></div>
         </form>
         <div id="holdedCfgMsg" style="margin-top:10px;display:none;font-size:13px"></div>
         <hr style="border:none;border-top:1px solid var(--line,#eee);margin:18px 0">
         <h4 style="margin:0 0 6px">🎵 Conexión con Spotify</h4>
         <p class="hint" style="margin-bottom:10px">Para generar las playlists de las bodas en <b>una cuenta de empresa</b> (Premium). El Client ID lo coges de developer.spotify.com; el Secret se guarda aquí, en la intranet.</p>
         <div id="spStatus" style="margin-bottom:10px"></div>
         <form id="spotifyCfgForm" style="max-width:520px">
           <div class="field"><label>Client ID</label><input class="control" id="spClientId" autocomplete="off"></div>
           <div class="field"><label>Client Secret</label><input class="control" type="password" id="spSecret" autocomplete="new-password" placeholder="(pega aquí el Client Secret)"></div>
           <div class="field"><label>Redirect URI <span class="muted">(debe coincidir EXACTA con la de tu app de Spotify)</span></label><input class="control" id="spRedir" placeholder="https://prueba.lol/api/spotify/callback"></div>
           <div class="btn-row" style="margin-top:12px"><button type="submit" class="btn btn--primary">Guardar</button> <button type="button" class="btn" id="spConnect">🎵 Conectar con Spotify</button> <button type="button" class="btn btn--sm" id="spDisconnect" hidden>Desconectar</button></div>
         </form>
         <div id="spotifyCfgMsg" style="margin-top:10px;display:none;font-size:13px"></div>
         <hr style="border:none;border-top:1px solid var(--line,#eee);margin:18px 0">
         <h4 style="margin:0 0 6px">🛠 Modo mantenimiento</h4>
         <p class="hint" style="margin-bottom:12px">Al activarlo, <b>todos</b> (novios, DJs y wedding planners) ven la pantalla de "En mantenimiento". <b>Tú y el resto de administración seguís entrando con normalidad</b> para hacer los cambios. Actívalo antes de una actualización y desactívalo al terminar.</p>
         <div style="background:#f6f3ff;border:1px solid #e2daf7;border-left:4px solid #E82C88;border-radius:10px;padding:14px 16px 14px 18px;margin-bottom:16px;max-width:620px">
           <div style="font-weight:800;margin-bottom:8px">📋 Pasos recomendados</div>
           <ol style="margin:0;padding-left:20px;line-height:1.9;font-size:14px">
             <li>🛡 <b>Crea una copia previa a mantenimiento</b> (punto seguro, abajo).</li>
             <li>✅ <b>Activa el modo mantenimiento</b> (tu email ya está permitido) → se cierra la sesión de los demás.</li>
             <li>🔧 <b>Haz los cambios</b> con calma; tú sigues entrando con normalidad.</li>
             <li>👁 <b>Comprueba</b> que todo funciona bien.</li>
             <li>🔓 <b>Desactiva el modo mantenimiento</b> al terminar.</li>
             <li>↩ ¿Algo salió mal? <b>Restaura</b> desde la copia previa en <a href="#/backups">Copias de seguridad</a>.</li>
           </ol>
         </div>
         <div id="mntState" style="margin-bottom:12px"></div>
         <div class="btn-row" style="margin-bottom:8px"><button type="button" class="btn" id="mntBackup">💾 Crear copia previa a mantenimiento</button></div>
         <p class="hint" style="margin-bottom:14px">Guarda un <b>punto de restauración conocido-bueno</b> justo antes de tocar nada. Sale <b>resaltada</b> en la lista de copias como "previa a mantenimiento" y <b>no se borra nunca</b>. Recomendado antes de cada cambio importante.</p>
         <div id="mntBackupOut" style="margin-bottom:12px;display:none;font-size:13px"></div>
         <form id="mntForm" style="max-width:520px">
           <label class="chk" style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><input type="checkbox" id="mntOn"> <span>Modo mantenimiento <b>activado</b></span></label>
           <div class="field"><label>Mensaje para el cliente <span class="muted">(opcional; si lo dejas vacío, sale el mensaje por defecto)</span></label><textarea class="control" id="mntMsg" rows="2" maxlength="300" placeholder="Estamos pinchando los últimos ajustes para que todo suene perfecto. Dale al play en un momento. 🎧"></textarea></div>
           <div class="field"><label>Permitir el acceso solo a estos emails <span class="muted">(separados por coma; vacío = entra toda la administración)</span></label><input class="control" id="mntAllow" placeholder="infoconectaso@gmail.com"></div>
           <p class="hint" style="color:#b26a00;margin-top:-6px">⚠ Si pones un email aquí, <b>solo ese</b> podrá entrar (ni siquiera el resto de administración) y al activar se cerrará la sesión de todos los demás. Escribe bien el tuyo. Si te quedaras fuera, en la propia pantalla de mantenimiento tienes un botón de administración para desactivarlo.</p>
           <div class="btn-row" style="margin-top:12px"><button type="submit" class="btn btn--primary">Guardar</button> <button type="button" class="btn" id="mntPreview">👁 Previsualizar pantalla</button></div>
         </form>
         <div id="mntMsgOut" style="margin-top:10px;display:none;font-size:13px"></div>`
      : `<form id="advForm" style="max-width:420px"><div class="field"><label>Contraseña</label><input class="control" type="password" id="advPass" autocomplete="off"></div>
          <div class="btn-row" style="margin-top:12px"><button type="submit" class="btn btn--primary">Desbloquear</button>
          <button type="button" class="btn btn--sm" id="advForgot">¿Olvidaste la contraseña?</button></div></form>
         <p id="advMsg" style="margin-top:12px;display:none;font-size:13px"></p>`}
    </div></div>` : '';
  shell(`${pageHead('Mi cuenta', 'Tus datos de acceso.')}
    <div class="grid-2">
      <div class="panel"><div class="panel__head"><h3>Datos</h3></div><div class="panel__body"><div class="form-grid">
        <label>Nombre</label><div>${esc(S.user.name || '—')}</div>
        <label>Email</label><div>${esc(S.user.email)}</div>
        <label>Perfil</label><div>${esc(CS.roleLabel(S.user.role))}</div>
      </div></div></div>
      <div class="panel"><div class="panel__head"><h3>Cambiar contraseña</h3></div><div class="panel__body"><form id="pwForm">
        <div class="field"><label>Contraseña actual</label><input class="control" type="password" name="current" required></div>
        <div class="field"><label>Nueva contraseña</label><input class="control" type="password" name="password" required></div>
        <div class="hint">Mínimo 10 caracteres, con letras y números.</div>
        <div id="pwErr" class="field-error" style="display:none"></div>
        <button class="btn btn--primary" type="submit" style="margin-top:12px">Actualizar</button>
      </form></div></div>
    </div>
    ${['dj', 'admin'].includes(S.user.role) ? `
      <div class="panel" style="margin-top:4px"><div class="panel__head"><h3>📅 Mis bodas en tu calendario</h3></div><div class="panel__body">
        <p class="hint" style="margin-bottom:12px">Suscríbete y tus bodas asignadas aparecerán en tu calendario (Google o iPhone) y se <b>actualizarán solas</b>: cuando te asignen una nueva, aparece sin que tengas que entrar. Es de <b>solo lectura</b> — no borra ni duplica tus propios eventos.</p>
        <div id="calBox"><p class="hint">Cargando enlace…</p></div>
      </div></div>` : ''}
    <div class="panel" style="margin-top:4px" id="faceIdPanel" hidden><div class="panel__head"><h3>🔒 Acceso con Face ID</h3></div><div class="panel__body">
      <p class="hint" style="margin-bottom:12px">Entra con tu cara o huella, sin escribir la contraseña. Se guarda de forma segura en este dispositivo (la contraseña sigue funcionando igual).</p>
      <div id="faceIdBox"><p class="hint">Comprobando…</p></div>
    </div></div>
    ${adv}`, ['Mi cuenta']);
  // --- Face ID / passkeys ---
  (() => {
    const panel = el('faceIdPanel'), box = el('faceIdBox');
    if (!panel || !box || !CS.waSupported()) return;   // navegador sin soporte → oculto
    panel.hidden = false;
    const render = () => {
      if (S.user.hasPasskey) {
        box.innerHTML = '<p class="hint" style="margin-bottom:12px"><b style="color:#2e7d32">✓ Activado.</b> En este u otros dispositivos puedes entrar con Face ID.</p><div class="btn-row"><button class="btn" id="fiOff">Desactivar</button> <button class="btn" id="fiAdd">Añadir otro dispositivo</button></div>';
        const off = el('fiOff'); if (off) off.onclick = async () => { off.disabled = true; try { await api('webauthn/remove', { method: 'POST', body: {} }); S.user.hasPasskey = false; toast('Face ID desactivado', 'ok'); render(); } catch (e) { off.disabled = false; toast('No se pudo desactivar', 'err'); } };
        const add = el('fiAdd'); if (add) add.onclick = doRegister;
      } else {
        box.innerHTML = '<div class="btn-row"><button class="btn btn--primary" id="fiOn">Activar Face ID</button></div>';
        const on = el('fiOn'); if (on) on.onclick = doRegister;
      }
    };
    async function doRegister(e) {
      const btn = e && e.target; if (btn) btn.disabled = true;
      try { await CS.passkeyRegister('Face ID'); S.user.hasPasskey = true; toast('Face ID activado 🔒', 'ok'); render(); }
      catch (err) { if (btn) btn.disabled = false; toast((err && err.message) || 'No se pudo activar Face ID', 'err'); }
    }
    render();
  })();
  (async () => {
    const box = el('calBox'); if (!box) return;
    let d; try { d = await api('my-calendar'); } catch (e) { box.innerHTML = '<p class="hint">No se pudo generar el enlace.</p>'; return; }
    box.innerHTML = `
      <div class="field"><label>Tu enlace de suscripción</label><input class="control" id="calUrl" readonly value="${esc(d.url)}"></div>
      <div class="btn-row" style="flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <a class="btn btn--primary" href="${esc(d.webcal)}">📱 Añadir al iPhone</a>
        <button class="btn" id="calCopy">📋 Copiar enlace</button>
        <a class="btn" href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl" target="_blank" rel="noopener">➕ Añadir a Google Calendar</a>
      </div>
      <p class="hint"><b>iPhone:</b> pulsa «Añadir al iPhone» y confirma. <b>Google Calendar (desde el ordenador):</b> pulsa «Añadir a Google Calendar», pega el enlace en «Desde URL» y Añadir. Se actualiza solo cada pocas horas.</p>`;
    const u = el('calUrl'); if (u) u.onclick = () => u.select();
    const c = el('calCopy'); if (c) c.onclick = async () => { try { await navigator.clipboard.writeText(d.url); toast('Enlace copiado', 'ok'); } catch (e) { const i = el('calUrl'); if (i) { i.select(); } } };
  })();
  el('pwForm').onsubmit = async e => {
    e.preventDefault(); const d = collectForm(e.target); const errEl = el('pwErr'); errEl.style.display = 'none';
    try { await api('auth/change-password', { method: 'POST', body: { current: d.current, password: d.password } }); toast('Contraseña actualizada', 'ok'); e.target.reset(); }
    catch (err) { errEl.textContent = err.message; errEl.style.display = 'block'; }
  };
  const advForm = el('advForm');
  if (advForm) advForm.onsubmit = e => {
    e.preventDefault(); const v = (el('advPass') || {}).value || '';
    if (v === BENEF_PASS) { try { sessionStorage.setItem('conecta_benef_ok', '1'); } catch (x) {} toast('Configuración avanzada desbloqueada', 'ok'); if (CS.route) CS.route(); else location.reload(); }
    else { const m = el('advMsg'); m.style.display = 'block'; m.innerHTML = '<span style="color:#d9534f;font-weight:700">Contraseña incorrecta.</span>'; }
  };
  const advForgot = el('advForgot');
  if (advForgot) advForgot.onclick = () => { const m = el('advMsg'); m.style.display = 'block'; m.innerHTML = 'Te hemos enviado la contraseña a tu email de administración (<b>' + esc(S.user.email || 'tu email') + '</b>).<br><span class="muted">Nota: aún no hay envío de correo real. La contraseña es <b>lamusica20</b>.</span>'; };
  const mcForm = el('mailCfgForm');
  if (mcForm) {
    api('mail-config').then(r => {
      const c = (r && r.config) || {};
      if (el('mcEnabled')) el('mcEnabled').checked = !!c.enabled;
      if (el('mcHost')) el('mcHost').value = c.host || '';
      if (el('mcPort')) el('mcPort').value = c.port || 587;
      if (el('mcUser')) el('mcUser').value = c.user || '';
      if (el('mcPass')) el('mcPass').placeholder = c.hasPass ? '•••••••• (guardada — déjalo vacío para no cambiarla)' : '(pega aquí tu clave)';
      if (el('mcApiKey')) el('mcApiKey').placeholder = c.hasApiKey ? '•••••••• (guardada — déjalo vacío para no cambiarla)' : '(pega aquí tu clave API, empieza por xkeysib-)';
      if (el('mcFrom')) el('mcFrom').value = c.from || '';
      if (el('mcAllow')) el('mcAllow').value = c.allowlist || '';
    }).catch(() => {});
    mcForm.onsubmit = async e => {
      e.preventDefault();
      const m = el('mailCfgMsg'); m.style.display = 'block'; m.textContent = 'Guardando…';
      try {
        const r = await api('mail-config', { method: 'POST', body: {
          enabled: el('mcEnabled').checked, host: el('mcHost').value, port: el('mcPort').value,
          user: el('mcUser').value, pass: el('mcPass').value, apiKey: el('mcApiKey').value, from: el('mcFrom').value, allowlist: el('mcAllow').value,
        } });
        el('mcPass').value = ''; el('mcPass').placeholder = '•••••••• (guardada — déjalo vacío para no cambiarla)';
        if (el('mcApiKey')) { el('mcApiKey').value = ''; el('mcApiKey').placeholder = '•••••••• (guardada — déjalo vacío para no cambiarla)'; }
        m.innerHTML = '✅ Guardado. El correo está ahora <b>' + (r.enabledNow ? 'activado' : 'desactivado') + '</b>.';
        toast('Configuración guardada', 'ok');
      } catch (err) { m.innerHTML = '<span style="color:#d9534f;font-weight:700">' + esc(err.message) + '</span>'; toast('No se pudo guardar', 'err'); }
    };
  }
  const hdForm = el('holdedCfgForm');
  if (hdForm) {
    api('holded-config').then(r => {
      const c = (r && r.config) || {};
      if (el('hdEnabled')) el('hdEnabled').checked = !!c.enabled;
      if (el('hdApiKey')) el('hdApiKey').placeholder = c.hasApiKey ? '•••••••• (guardado — déjalo vacío para no cambiarlo)' : '(pega aquí el token)';
    }).catch(() => {});
    hdForm.onsubmit = async e => {
      e.preventDefault();
      const m = el('holdedCfgMsg'); m.style.display = 'block'; m.textContent = 'Guardando…';
      try {
        const r = await api('holded-config', { method: 'POST', body: { enabled: el('hdEnabled').checked, apiKey: el('hdApiKey').value } });
        el('hdApiKey').value = ''; el('hdApiKey').placeholder = '•••••••• (guardado — déjalo vacío para no cambiarlo)';
        m.innerHTML = '✅ Guardado' + (r.hasApiKey ? ' (token almacenado).' : '.') + ' Pulsa <b>Probar conexión</b> para comprobarlo.';
        toast('Holded guardado', 'ok');
      } catch (err) { m.innerHTML = '<span style="color:#d9534f;font-weight:700">' + esc(err.message) + '</span>'; }
    };
    const hdTest = el('hdTest');
    if (hdTest) hdTest.onclick = async () => {
      const m = el('holdedCfgMsg'); m.style.display = 'block'; m.textContent = 'Probando conexión con Holded…';
      try {
        const r = await api('holded-test', { method: 'POST', body: {} });
        m.innerHTML = r.ok ? '✅ Conexión correcta con Holded.' : '<span style="color:#d9534f;font-weight:700">No conecta: ' + esc(r.error || '') + '</span>';
      } catch (err) { m.innerHTML = '<span style="color:#d9534f;font-weight:700">' + esc(err.message) + '</span>'; }
    };
  }
  const spForm = el('spotifyCfgForm');
  if (spForm) {
    const paintSp = st => {
      const sb = el('spStatus'); if (el('spClientId') && st.clientId != null) el('spClientId').value = st.clientId || '';
      if (el('spRedir') && !el('spRedir').value) el('spRedir').value = st.redirect || '';
      const dc = el('spDisconnect'); if (dc) dc.hidden = !st.connected;
      if (!sb) return;
      sb.innerHTML = st.connected
        ? `<div class="banner" style="padding:10px 14px;border-radius:10px;background:#E8F5E9;color:#1B5E20;border:1px solid #BEE3C2">✅ Conectado${st.account ? ' como <b>' + esc(st.account) + '</b>' : ''}. Ya se pueden generar playlists.</div>`
        : (st.configured
          ? `<div class="banner" style="padding:10px 14px;border-radius:10px;background:#FFF8E1;color:#8a6d00;border:1px solid #FFE49A">⚠ Falta <b>conectar la cuenta</b>: pulsa «Conectar con Spotify» y autoriza con la cuenta Premium de empresa.</div>`
          : `<div class="banner" style="padding:10px 14px;border-radius:10px;background:#EEF2F7;color:#334;border:1px solid #D6DEE8">Pega el <b>Client ID</b> y el <b>Client Secret</b>, Guarda, y luego «Conectar con Spotify».</div>`);
    };
    const loadSp = () => api('spotify-config').then(paintSp).catch(() => {});
    loadSp();
    spForm.onsubmit = async e => {
      e.preventDefault();
      const out = el('spotifyCfgMsg'); if (out) { out.style.display = 'block'; out.textContent = 'Guardando…'; }
      try { await api('spotify-config', { method: 'POST', body: { clientId: (el('spClientId') || {}).value || '', clientSecret: (el('spSecret') || {}).value || '', redirect: (el('spRedir') || {}).value || '' } }); if (el('spSecret')) el('spSecret').value = ''; if (out) out.innerHTML = '✅ Guardado. Ahora pulsa «Conectar con Spotify».'; toast('Configuración de Spotify guardada', 'ok'); loadSp(); }
      catch (err) { if (out) out.innerHTML = '<span style="color:#d9534f;font-weight:700">' + esc(err.message) + '</span>'; }
    };
    const scn = el('spConnect');
    if (scn) scn.onclick = async () => {
      try { const st = await api('spotify-config'); if (!st.hasSecret) { toast('Guarda primero el Client ID y el Secret', 'err'); return; } } catch (e) {}
      window.open('/api/spotify/auth', '_blank', 'noopener');
      const out = el('spotifyCfgMsg'); if (out) { out.style.display = 'block'; out.innerHTML = 'Se ha abierto Spotify en otra pestaña. Autoriza con la cuenta de empresa y vuelve aquí; luego pulsa <a href="#/cuenta">recargar</a> para ver el estado.'; }
    };
    const sdc = el('spDisconnect');
    if (sdc) sdc.onclick = async () => { if (!confirm('¿Desconectar la cuenta de Spotify? Las playlists ya creadas no se borran.')) return; try { await api('spotify/disconnect', { method: 'POST' }); toast('Spotify desconectado', 'ok'); loadSp(); } catch (e) { toast(e.message || 'Error', 'err'); } };
  }
  const mntForm = el('mntForm');
  if (mntForm) {
    const stateBox = el('mntState'), onBox = el('mntOn'), msgBox = el('mntMsg'), allowBox = el('mntAllow');
    const paint = st => { if (!stateBox) return; stateBox.innerHTML = (st && st.on)
      ? '<div class="banner" style="padding:10px 14px;border-radius:10px;background:#FDECEA;color:#B71C1C;border:1px solid #F5C6CB"><b>🛠 Modo mantenimiento ACTIVO ahora mismo.</b> Los clientes ven la pantalla; administración entra con normalidad.</div>'
      : '<div class="banner" style="padding:10px 14px;border-radius:10px;background:#E8F5E9;color:#1B5E20;border:1px solid #BEE3C2">✅ Intranet abierta con normalidad (mantenimiento desactivado).</div>'; };
    const DEFAULT_ALLOW = 'infoconectaso@gmail.com';   // email que queda puesto por defecto
    api('maintenance').then(st => { if (onBox) onBox.checked = !!st.on; if (msgBox && st.msg) msgBox.value = st.msg; if (allowBox) allowBox.value = (st.allow && st.allow.length) ? st.allow.join(', ') : DEFAULT_ALLOW; paint(st); }).catch(() => { if (allowBox) allowBox.value = DEFAULT_ALLOW; });
    mntForm.onsubmit = async e => {
      e.preventDefault();
      const on = !!(onBox && onBox.checked); const msg = ((msgBox && msgBox.value) || '').trim();
      const allow = ((allowBox && allowBox.value) || '').trim();
      if (on && allow) { const ok = allow.split(',').map(s => s.trim().toLowerCase()).filter(Boolean); if (!ok.some(e2 => e2 === String(S.user.email || '').toLowerCase())) { if (!confirm('El email con el que has entrado (' + S.user.email + ') NO está en la lista de permitidos. Si continúas, al activar se te cerrará la sesión y verás la pantalla de mantenimiento (con un botón de administración para desactivarlo). ¿Seguir?')) return; } }
      const out = el('mntMsgOut'); if (out) { out.style.display = 'block'; out.textContent = 'Guardando…'; }
      try {
        const st = await api('maintenance', { method: 'POST', body: { on, msg, allow } });
        paint(st);
        if (out) out.innerHTML = st.on ? '🛠 <b>Mantenimiento activado.</b> Ahora los clientes ven la pantalla; tú sigues entrando con normalidad.' : '✅ <b>Mantenimiento desactivado.</b> Todo vuelve a la normalidad.';
        toast(st.on ? 'Modo mantenimiento activado' : 'Modo mantenimiento desactivado', 'ok');
      } catch (err) { if (out) out.innerHTML = '<span style="color:#d9534f;font-weight:700">' + esc(err.message) + '</span>'; }
    };
    const prev = el('mntPreview');
    if (prev) prev.onclick = () => {
      const msg = ((msgBox && msgBox.value) || '').trim();
      const holder = document.createElement('div'); holder.innerHTML = CS.maintenanceMarkup(msg);
      const root = holder.firstElementChild; if (!root) return;
      const close = document.createElement('button'); close.textContent = '✕ Cerrar vista previa';
      close.style.cssText = 'position:fixed;top:16px;right:16px;z-index:100000;background:#fff;color:#130F17;border:0;border-radius:999px;padding:10px 16px;font-weight:800;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35)';
      document.body.appendChild(root); document.body.appendChild(close);
      const done = () => { root.remove(); close.remove(); };
      close.onclick = done;
      const btn = root.querySelector('#mReload'); if (btn) btn.onclick = done;
    };
    const bkBtn = el('mntBackup');
    if (bkBtn) bkBtn.onclick = async () => {
      const out = el('mntBackupOut'); const t0 = bkBtn.textContent; bkBtn.disabled = true; bkBtn.textContent = 'Creando copia…';
      if (out) { out.style.display = 'block'; out.textContent = 'Creando copia previa a mantenimiento…'; }
      try { await api('backups/create', { method: 'POST', body: { pre: true } }); if (out) out.innerHTML = '✅ <b>Copia previa a mantenimiento creada.</b> La verás resaltada en <a href="#/backups">Copias de seguridad</a> y no se borra nunca.'; toast('Copia previa a mantenimiento creada', 'ok'); }
      catch (e) { if (out) out.innerHTML = '<span style="color:#d9534f;font-weight:700">' + esc(e.message) + '</span>'; }
      bkBtn.disabled = false; bkBtn.textContent = t0;
    };
  }
  const tmForm = el('testMailForm');
  if (tmForm) {
    const icon = s => s === 'ok' ? '✅' : s === 'error' ? '❌' : s === 'enviando' ? '⏳' : '◻️';
    const render = (run, head) => {
      const m = el('testMailMsg'); if (!m) return;
      const rows = (run.results || []).map(r => icon(r.status) + ' ' + esc(r.label) + (r.status === 'error' ? ' <span style="color:#d9534f">— ' + esc(r.error || 'error') + '</span>' : '')).join('<br>');
      const okN = (run.results || []).filter(r => r.status === 'ok').length;
      m.innerHTML = head + '<br><span class="muted">' + okN + '/' + (run.total || (run.results || []).length) + ' enviados · buscan el prefijo <b>[PRUEBA]</b> en tu bandeja.</span><br><br>' + rows;
    };
    tmForm.onsubmit = async e => {
      e.preventDefault();
      const to = (el('testMailTo') || {}).value || '';
      const m = el('testMailMsg'); const btn = tmForm.querySelector('button[type=submit]');
      m.style.display = 'block'; m.innerHTML = 'Enviando…'; if (btn) btn.disabled = true;
      try {
        const r = await api('test-emails', { method: 'POST', body: { to } });
        toast('Enviando correos de prueba…', 'ok');
        const head = '📨 <b>Enviando ' + r.count + ' correos</b> a <b>' + esc(r.to) + '</b> (espaciados para no saturar el proveedor de correo, ~' + r.etaSeconds + ' s).';
        let tries = 0;
        const poll = async () => {
          try {
            const st = await api('test-emails');
            render(st, head);
            if (st.running && tries++ < 60) return setTimeout(poll, 3000);
            if (btn) btn.disabled = false;
          } catch (x) { if (btn) btn.disabled = false; }
        };
        poll();
      } catch (err) {
        m.innerHTML = '<span style="color:#d9534f;font-weight:700">' + esc(err.message) + '</span>';
        toast('No se pudieron enviar', 'err'); if (btn) btn.disabled = false;
      }
    };
  }
});
})();
