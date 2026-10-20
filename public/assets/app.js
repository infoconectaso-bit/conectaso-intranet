'use strict';
/* ============================================================================
   Gestor de eventos · Conecta So — aplicación de cliente (SPA)
   Habla con la API del servidor. La interfaz se adapta al perfil del usuario;
   el servidor es siempre quien decide qué datos se entregan y qué se puede guardar.
   ============================================================================ */
(function () {
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (id) => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = el('app');

/* ---------- cliente de API ---------- */
async function api(path, { method = 'GET', body, form } = {}) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (form) opt.body = form;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch('/api/' + path, opt);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error((data && data.error) || ('Error ' + res.status)), { status: res.status, data });
  return data;
}

/* ---------- estado global ---------- */
const S = { user: null, meta: null, brand: null, mailEnabled: false, locById: {}, extraById: {}, staffById: {} };
function rebuildMaps() {
  S.locById = {}; (S.meta.locations || []).forEach(l => S.locById[l.id] = l);
  S.extraById = {}; (S.meta.extras || []).forEach(x => S.extraById[x.id] = x);
  S.staffById = {}; [...(S.meta.staff || []), ...(S.meta.djs || []), ...(S.meta.planners || [])].forEach(u => S.staffById[u.id] = u.name);
}

/* ---------- utilidades de formato ---------- */
const pad = n => String(n).padStart(2, '0');
const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const fmtEur = n => (Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const dmy = s => { if (!s) return ''; const p = String(s).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s; };
const slash = s => (s ? String(s).replace(/-/g, '/') : '');
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const hm = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const toMin = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const estado = i => (S.meta.estados && S.meta.estados[i]) || { n: '', c: '#999' };
const locName = ev => { const l = S.locById[ev.lugar]; return l ? l.name : (ev.lugarOtro ? 'Otro (' + ev.lugarOtro + ')' : ''); };
const extraName = id => (S.extraById[id] || {}).name || '';
const userName = id => S.staffById[id] || '';
const djOf = ev => ev.djId ? userName(ev.djId) : ((ev.services || []).find(s => extraName(s.servicio) === 'Servicio de Dj') ? userName((ev.services.find(s => extraName(s.servicio) === 'Servicio de Dj')).resp) : '');

function toast(msg, kind) {
  const t = document.createElement('div'); t.className = 'toast' + (kind ? ' toast--' + kind : '');
  t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3000);
}
function modal(title, bodyHtml, { okText, onOk, danger } = {}) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><div class="mb">${bodyHtml}</div>
    <div class="mf">${onOk ? `<button class="btn btn--ghost" data-x>Cancelar</button><button class="btn ${danger ? 'btn--primary' : 'btn--dark'}" data-ok>${esc(okText || 'Aceptar')}</button>` : '<button class="btn btn--dark" data-x>Cerrar</button>'}</div></div>`;
  document.body.appendChild(bg);
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-x]')) bg.remove(); if (e.target.closest('[data-ok]')) { const keep = onOk(bg); if (keep !== true) bg.remove(); } });
  return bg;
}
const ICON = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10', events: 'M7 2v4M17 2v4M3 9h18M5 5h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z',
  extras: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4', users: 'M17 20v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2M12 10a4 4 0 100-8 4 4 0 000 8m9 10v-2a4 4 0 00-3-3.87',
  loc: 'M12 21s-7-5.5-7-11a7 7 0 0114 0c0 5.5-7 11-7 11zM12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5z', clock: 'M12 7v5l3 2M12 22a10 10 0 100-20 10 10 0 000 20z',
  plane: 'M2 12l20-8-8 20-2.5-9L2 12z', euro: 'M18 6a7 7 0 100 12M4 10h9M4 14h8', car: 'M5 13l2-6h10l2 6M5 13h14v5H5v-5zm2 5v2m10-2v2M7 16h.01M17 16h.01',
  doc: 'M14 3v5h5M8 13h8M8 17h8M8 9h3M7 3h8l5 5v11a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9', key: 'M15 7a4 4 0 11-5.6 3.6L3 17v4h4l1-1h2v-2h2l1.4-1.4A4 4 0 0015 7z',
};
const svg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[k]}"/></svg>`;

/* =========================================================================
   ARRANQUE
   ========================================================================= */
async function boot() {
  try {
    const me = await api('auth/me');
    S.user = me.user; S.mailEnabled = me.mailEnabled;
  } catch (e) { S.user = null; }
  window.addEventListener('hashchange', route);
  if (!S.user) return renderAuth();
  await loadContext();
  route();
}
async function loadContext() {
  const [meta, brand] = await Promise.all([api('meta'), api('brand').catch(() => ({}))]);
  S.meta = meta; S.brand = brand; rebuildMaps();
}

/* =========================================================================
   AUTENTICACIÓN
   ========================================================================= */
function authShell(inner) {
  return `<div class="auth"><div class="auth__brand">
    <img class="logo-wordmark" src="/assets/brand/logo-principal-blanco.svg" alt="Conecta So">
    <img class="el el--vinilo" src="/assets/brand/el-vinilo.svg" alt="">
    <div><div class="auth__hero script">Montamos el tinglado</div>
      <p>El gestor de eventos de Conecta So: bodas, música, equipo y facturación en un mismo sitio.</p></div>
    <div style="color:#8a8494;font-size:12px">Conecta So · soylallorona.com</div>
  </div><div class="auth__form"><div class="auth__card">${inner}</div></div></div>`;
}
function renderAuth() {
  const h = location.hash;
  if (h.startsWith('#/activar')) return renderActivate();
  if (h.startsWith('#/recuperar')) return renderForgot();
  app.innerHTML = authShell(`
    <h1>Hola de nuevo</h1>
    <div class="sub">Entra con tu cuenta de Conecta So.</div>
    <form id="loginForm">
      <div class="field"><label>Email</label><div class="input-icon"><input class="control" name="email" type="email" autocomplete="username" required>${svg('users')}</div></div>
      <div class="field"><label>Contraseña</label><div class="input-icon"><input class="control" name="password" type="password" autocomplete="current-password" required>${svg('key')}</div></div>
      <div id="loginErr" class="field-error" style="display:none"></div>
      <button class="btn btn--primary btn--block" type="submit">Entrar</button>
      <div style="margin-top:16px;text-align:center"><a href="#/recuperar">¿Olvidaste tu contraseña?</a></div>
    </form>`);
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target; const btn = $('button', f); btn.disabled = true;
    const errEl = el('loginErr'); errEl.style.display = 'none';
    try {
      await api('auth/login', { method: 'POST', body: { email: f.email.value.trim(), password: f.password.value } });
      location.hash = '#/'; await afterLogin();
    } catch (err) { errEl.textContent = err.message; errEl.style.display = 'block'; btn.disabled = false; }
  });
}
async function afterLogin() {
  const me = await api('auth/me'); S.user = me.user; S.mailEnabled = me.mailEnabled;
  await loadContext(); if (!location.hash || location.hash === '#/recuperar') location.hash = '#/'; route();
}
function renderForgot() {
  app.innerHTML = authShell(`
    <h1>Recuperar acceso</h1>
    <div class="sub">Te enviaremos un enlace para crear una contraseña nueva.</div>
    <form id="fForm">
      <div class="field"><label>Email</label><input class="control" name="email" type="email" required></div>
      <button class="btn btn--primary btn--block" type="submit">Enviar enlace</button>
      <div style="margin-top:16px;text-align:center"><a href="#/">Volver a entrar</a></div>
    </form>`);
  $('#fForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('auth/forgot', { method: 'POST', body: { email: e.target.email.value.trim() } }); } catch (x) {}
    app.innerHTML = authShell(`<h1>Revisa tu correo</h1><div class="sub">Si ese email tiene una cuenta activa, le hemos enviado un enlace para restablecer la contraseña. ${S.mailEnabled ? '' : '<br><br><b>Nota:</b> el envío de correo no está configurado todavía; pide el enlace a administración.'}</div><a class="btn btn--dark btn--block" href="#/">Volver</a>`);
  });
}
async function renderActivate() {
  const token = new URLSearchParams(location.hash.split('?')[1] || '').get('token');
  let info; try { info = await api('auth/invite-info?token=' + encodeURIComponent(token || '')); }
  catch (e) { app.innerHTML = authShell(`<h1>Enlace no válido</h1><div class="sub">Este enlace no es válido o ha caducado. Pide uno nuevo a administración.</div><a class="btn btn--dark btn--block" href="#/">Ir al inicio</a>`); return; }
  app.innerHTML = authShell(`
    <h1>${info.kind === 'invite' ? '¡Bienvenido/a!' : 'Nueva contraseña'}</h1>
    <div class="sub">${esc(info.email)} — crea tu contraseña para ${info.kind === 'invite' ? 'activar tu cuenta' : 'volver a entrar'}.</div>
    <form id="aForm">
      <div class="field"><label>Contraseña nueva</label><input class="control" name="password" type="password" autocomplete="new-password" required></div>
      <div class="field"><label>Repite la contraseña</label><input class="control" name="password2" type="password" required></div>
      <div class="hint">Mínimo 10 caracteres, con letras y números.</div>
      <div id="aErr" class="field-error" style="display:none"></div>
      <button class="btn btn--primary btn--block" type="submit" style="margin-top:14px">Guardar y entrar</button>
    </form>`);
  $('#aForm').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target; const errEl = el('aErr'); errEl.style.display = 'none';
    if (f.password.value !== f.password2.value) { errEl.textContent = 'Las contraseñas no coinciden.'; errEl.style.display = 'block'; return; }
    try { await api('auth/activate', { method: 'POST', body: { token, password: f.password.value } }); location.hash = '#/'; await afterLogin(); }
    catch (err) { errEl.textContent = err.message; errEl.style.display = 'block'; }
  });
}

/* =========================================================================
   NAVEGACIÓN POR PERFIL
   ========================================================================= */
function navFor(role) {
  if (role === 'admin') return [
    { s: 'Principal' }, { t: 'Inicio', i: 'home', h: '#/' },
    { s: 'Eventos' }, { t: 'Bodas pendientes', i: 'events', h: '#/eventos' }, { t: 'Bodas realizadas', i: 'events', h: '#/eventos/realizados' },
    { t: 'Servicios extras', i: 'extras', h: '#/extras' },
    { s: 'Equipo' }, { t: 'Usuarios', i: 'users', h: '#/usuarios' }, { t: 'Localizaciones', i: 'loc', h: '#/localizaciones' },
    { t: 'Control horario', i: 'clock', h: '#/horario' }, { t: 'Vacaciones', i: 'plane', h: '#/vacaciones' },
    { s: 'Negocio' }, { t: 'Facturación equipo', i: 'euro', h: '#/facturacion' }, { t: 'Beneficios', i: 'euro', h: '#/beneficios' },
    { t: 'Vehículos', i: 'car', h: '#/vehiculos' }, { t: 'Términos (TYC)', i: 'doc', h: '#/tyc' },
  ];
  if (role === 'dj') return [
    { s: 'Mi trabajo' }, { t: 'Inicio', i: 'home', h: '#/' }, { t: 'Mis eventos', i: 'events', h: '#/eventos' },
    { t: 'Realizados', i: 'events', h: '#/eventos/realizados' },
    { s: 'Tiempo' }, { t: 'Mi control horario', i: 'clock', h: '#/horario' }, { t: 'Mis vacaciones', i: 'plane', h: '#/vacaciones' },
    { s: 'Otros' }, { t: 'Mis pagos', i: 'euro', h: '#/mis-pagos' }, { t: 'Vehículos', i: 'car', h: '#/vehiculos' },
  ];
  if (role === 'planner') return [
    { s: 'Principal' }, { t: 'Inicio', i: 'home', h: '#/' }, { t: 'Mis bodas', i: 'events', h: '#/eventos' },
    { t: 'Realizadas', i: 'events', h: '#/eventos/realizados' },
  ];
  return [ // user / cliente
    { s: 'Mi boda' }, { t: 'Inicio', i: 'home', h: '#/' }, { t: 'Mi evento', i: 'events', h: '#/eventos' },
  ];
}
function shell(bodyHtml, crumbs) {
  const u = S.user;
  const nav = navFor(u.role).map(n => n.s
    ? `<div class="nav__section">${esc(n.s)}</div>`
    : `<a href="${n.h}" data-nav="${n.h}">${svg(n.i)}<span>${esc(n.t)}</span></a>`).join('');
  app.innerHTML = `<div class="app">
    <aside class="sidebar">
      <div class="sidebar__logo"><img src="/assets/brand/logo-reducido-azul.svg" alt="">
        <div class="wm">CONECTA<small>Gestor de eventos</small></div></div>
      <nav class="nav">${nav}</nav>
      <div class="nav__foot"><a href="#/cuenta" data-nav="#/cuenta">${svg('key')}<span>Mi cuenta</span></a>
        <a href="#" id="logoutLink">${svg('logout')}<span>Cerrar sesión</span></a></div>
    </aside>
    <div class="main">
      <header class="topbar">
        <div class="topbar__left"><button class="burger" id="burger">☰</button>
          <div class="crumbs">${(crumbs || []).map((c, i, a) => i === a.length - 1 ? `<b>${esc(c)}</b>` : `${esc(c)} <span>›</span>`).join(' ')}</div></div>
        <div class="userchip" id="userchip"><span class="avatar">${esc((u.name || '?').trim().charAt(0).toUpperCase())}</span>
          <span class="who">${esc(u.name || u.email)}<small>${esc(roleLabel(u.role))}</small></span></div>
      </header>
      <div class="content">${bodyHtml}</div>
    </div></div>`;
  markActive();
  el('burger').onclick = () => document.body.classList.toggle('nav-open');
  $$('.nav a[data-nav], .nav__foot a[data-nav]').forEach(a => a.onclick = () => document.body.classList.remove('nav-open'));
  el('logoutLink').onclick = async e => { e.preventDefault(); await api('auth/logout', { method: 'POST' }); S.user = null; location.hash = '#/'; renderAuth(); };
  el('userchip').onclick = () => {
    if ($('.menu')) return $('.menu').remove();
    const m = document.createElement('div'); m.className = 'menu';
    m.innerHTML = `<a href="#/cuenta">${svg('key')} Mi cuenta</a><button id="mLogout">${svg('logout')} Cerrar sesión</button>`;
    el('userchip').after(m);
    $('#mLogout', m).onclick = () => el('logoutLink').click();
    setTimeout(() => document.addEventListener('click', function h(ev) { if (!ev.target.closest('.menu,#userchip')) { m.remove(); document.removeEventListener('click', h); } }), 0);
  };
}
const roleLabel = r => ({ admin: 'Administración', dj: 'DJ / Técnico', planner: 'Wedding planner', user: 'Cliente' }[r] || r);
function markActive() {
  const h = location.hash || '#/';
  $$('.nav a[data-nav]').forEach(a => {
    const t = a.getAttribute('data-nav');
    a.classList.toggle('active', t === h || (t !== '#/' && h.startsWith(t)));
  });
}
function pageHead(title, lead, right) {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${lead ? `<div class="lead">${esc(lead)}</div>` : ''}<div class="page-head__accent"></div></div>${right || ''}</div>`;
}

/* =========================================================================
   TABLA (ordenar, filtrar, paginar) — en cliente sobre un array ya cargado
   ========================================================================= */
const TBL = {};
function table(id, cfg) {
  const st = TBL[id] || (TBL[id] = { page: 0, len: cfg.len || 50, q: '', order: cfg.order || [0, 'asc'], f: {} });
  st.cfg = cfg;
  return `<div class="dt" id="${id}"><div class="dt-mount">${renderTable(id)}</div></div>`;
}
function renderTable(id) {
  const st = TBL[id], cfg = st.cfg;
  let rows = cfg.rows.slice();
  const txt = (c, r) => String(c.get ? c.get(r) : '').toLowerCase();
  if (st.q) { const q = st.q.toLowerCase(); rows = rows.filter(r => cfg.cols.some(c => txt(c, r).includes(q))); }
  Object.entries(st.f).forEach(([ci, v]) => { if (v) rows = rows.filter(r => txt(cfg.cols[ci], r).includes(v.toLowerCase())); });
  const [oc, od] = st.order, col = cfg.cols[oc];
  if (col && col.get) rows.sort((a, b) => { const x = col.get(a), y = col.get(b); const r = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x).localeCompare(String(y), 'es', { numeric: true }); return od === 'asc' ? r : -r; });
  const total = rows.length, pages = Math.max(1, Math.ceil(total / st.len));
  if (st.page >= pages) st.page = pages - 1;
  const slice = rows.slice(st.page * st.len, st.page * st.len + st.len);
  const from = total ? st.page * st.len + 1 : 0, to = Math.min(total, (st.page + 1) * st.len);
  const ths = cfg.cols.map((c, i) => `<th data-sort="${c.nosort ? '' : i}" class="${c.nosort ? 'nosort' : ''}">${esc(c.t)}${c.nosort ? '' : `<span class="caret">${oc === i ? (od === 'asc' ? '▲' : '▼') : '⇅'}</span>`}</th>`).join('');
  const filt = cfg.filters ? `<tr class="filters">${cfg.cols.map((c, i) => `<th>${c.nofilter || c.nosort ? '' : `<input data-cf="${i}" value="${esc(st.f[i] || '')}" placeholder="Buscar">`}</th>`).join('')}</tr>` : '';
  const body = slice.length ? slice.map(r => `<tr>${cfg.cols.map(c => `<td>${c.html ? c.html(r) : esc(c.get(r))}</td>`).join('')}</tr>`).join('')
    : `<tr><td class="td-empty" colspan="${cfg.cols.length}">${esc(cfg.empty || 'No hay registros.')}</td></tr>`;
  const start = Math.max(0, Math.min(st.page - 2, pages - 5)); const pb = [];
  for (let p = start; p < Math.min(pages, start + 5); p++) pb.push(`<button data-pg="${p}" class="${p === st.page ? 'cur' : ''}">${p + 1}</button>`);
  return `<div class="dt-top"><label>Mostrar <select class="control control--sm" data-len style="width:auto">${[25, 50, 100].map(n => `<option ${n === st.len ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Buscar <input class="control control--sm dt-search" data-q value="${esc(st.q)}"></label></div>
    <div class="table-wrap"><table class="dt"><thead><tr>${ths}</tr>${filt}</thead><tbody>${body}</tbody></table></div>
    <div class="dt-foot"><div>${total ? `${from}–${to} de ${total.toLocaleString('es-ES')}` : '0 registros'}</div>
      <div class="pager"><button data-pg="0" ${st.page === 0 ? 'disabled' : ''}>«</button>${pb.join('')}<button data-pg="${pages - 1}" ${st.page >= pages - 1 ? 'disabled' : ''}>»</button></div></div>`;
}
function refreshTable(id, focus) {
  const w = el(id); if (!w) return; const act = document.activeElement;
  const sel = act && (act.dataset.q !== undefined ? '[data-q]' : act.dataset.cf !== undefined ? `[data-cf="${act.dataset.cf}"]` : null);
  const pos = act && act.selectionStart;
  $('.dt-mount', w).innerHTML = renderTable(id);
  if (focus && sel) { const e2 = $(sel, w); if (e2) { e2.focus(); try { e2.setSelectionRange(pos, pos); } catch (x) {} } }
}
document.addEventListener('input', e => {
  const w = e.target.closest('.dt'); if (!w || !TBL[w.id]) return; const st = TBL[w.id];
  if (e.target.dataset.q !== undefined) { st.q = e.target.value; st.page = 0; refreshTable(w.id, true); }
  if (e.target.dataset.cf !== undefined) { st.f[e.target.dataset.cf] = e.target.value; st.page = 0; refreshTable(w.id, true); }
});
document.addEventListener('change', e => { const w = e.target.closest('.dt'); if (w && TBL[w.id] && e.target.dataset.len !== undefined) { TBL[w.id].len = +e.target.value; TBL[w.id].page = 0; refreshTable(w.id); } });
document.addEventListener('click', e => {
  const w = e.target.closest('.dt'); if (!w || !TBL[w.id]) return; const st = TBL[w.id];
  const th = e.target.closest('th[data-sort]'); if (th && th.dataset.sort !== '') { const c = +th.dataset.sort; st.order = [c, st.order[0] === c && st.order[1] === 'asc' ? 'desc' : 'asc']; refreshTable(w.id); }
  const pg = e.target.closest('[data-pg]'); if (pg && !pg.disabled) { st.page = +pg.dataset.pg; refreshTable(w.id); }
});

/* chips reutilizables */
const dot = (color, title) => `<span class="dot" style="background:${color}" title="${esc(title || '')}"></span>`;
const locBadge = ev => { const l = S.locById[ev.lugar]; return l ? `<span class="loc-badge" style="background:${esc(l.colorHex || '#777')}">${esc(l.name)}</span>` : (ev.lugarOtro ? `Otro (${esc(ev.lugarOtro)})` : '—'); };
function pagoChip(ev) {
  if (ev.pagoCliente === undefined) return '—'; // perfil sin acceso a importes
  const pend = (+ev.pagoCliente || 0) - (+ev.pagado || 0);
  if (!ev.pagoCliente) return dot('#F6BF26', 'Importe no indicado');
  if (pend <= 0) return ev.metodo === 'Efectivo' ? `<span class="dot dot--e" style="background:#0B8043" title="Abonado (efectivo)">E</span>` : dot('#0B8043', 'Abonado');
  return dot('#D50000', 'Pendiente: ' + pend + ' €');
}

/* =========================================================================
   ROUTER
   ========================================================================= */
const routes = [];
const on = (re, fn) => routes.push([re, fn]);
function route() {
  if (!S.user) return renderAuth();
  const h = (location.hash || '#/').split('?')[0];
  const r = routes.find(([re]) => re.test(h));
  markActive();
  if (!r) return shell(`<div class="empty"><span class="script">Nada por aquí</span>Esa página no existe. <a href="#/">Volver al inicio</a></div>`, ['No encontrado']);
  Promise.resolve(r[1](h.match(r[0]))).catch(err => {
    if (err.status === 401) { S.user = null; return renderAuth(); }
    shell(`<div class="empty"><span class="script">Ups</span>${esc(err.message || 'Error')}</div>`, ['Error']);
  });
  window.scrollTo(0, 0);
}
const loading = (crumbs) => shell('<div class="loading">Cargando…</div>', crumbs);

/* ---- Inicio / dashboard por rol ---- */
on(/^#\/$/, async () => {
  loading(['Inicio']);
  if (S.user.role === 'admin') return dashboardAdmin();
  if (S.user.role === 'dj') return dashboardDj();
  return dashboardSimple();
});
async function dashboardAdmin() {
  const pend = await api('events');
  const upcoming = pend.events.filter(e => e.fecha >= ymd(TODAY)).sort((a, b) => a.fecha.localeCompare(b.fecha));
  const next = upcoming.slice(0, 8);
  const in7 = upcoming.filter(e => e.fecha <= ymd(addDays(TODAY, 7))).length;
  const sinDj = pend.events.filter(e => !djOf(e)).length;
  shell(`${pageHead('Hola, ' + (S.user.name || '').split(' ')[0], 'Tus próximas bodas de un vistazo.')}
    <div class="grid-3">
      <div class="stat stat--pink"><div class="k">Bodas pendientes</div><div class="v">${pend.events.length}</div></div>
      <div class="stat stat--blue"><div class="k">En los próximos 7 días</div><div class="v">${in7}</div></div>
      <div class="stat stat--yellow"><div class="k">Sin DJ asignado</div><div class="v">${sinDj}</div></div>
    </div>
    <div class="panel"><div class="panel__head"><h2>Próximas bodas</h2><a class="btn btn--sm" href="#/eventos">Ver todas</a></div>
      <div class="panel__body" style="padding:0">${eventMiniList(next)}</div></div>`, ['Inicio']);
}
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
async function dashboardDj() {
  const [ev, bal] = await Promise.all([api('events'), api('finance/me').catch(() => ({}))]);
  const next = ev.events.sort((a, b) => a.fecha.localeCompare(b.fecha)).slice(0, 8);
  shell(`${pageHead('Hola, ' + (S.user.name || '').split(' ')[0], 'Tus próximos eventos y tu actividad.')}
    <div class="grid-3">
      <div class="stat stat--pink"><div class="k">Eventos próximos</div><div class="v">${ev.events.length}</div></div>
      <div class="stat stat--blue"><div class="k">Pendiente de cobro</div><div class="v">${bal.history ? fmtEur(bal.history.rest - (bal.payments || []).reduce((t, p) => t + (+p.amount || 0), 0)) : '—'}</div></div>
      <div class="stat stat--yellow"><div class="k">Horas este mes</div><div class="v" id="hMes">—</div></div>
    </div>
    <div class="panel"><div class="panel__head"><h2>Tus próximos eventos</h2></div><div class="panel__body" style="padding:0">${eventMiniList(next)}</div></div>`, ['Inicio']);
  api('attendance-summary').then(s => { const r = (s.rows || [])[0]; if (r && el('hMes')) el('hMes').textContent = hm(r.m0) + ' h'; }).catch(() => {});
}
async function dashboardSimple() {
  const ev = await api('events');
  const list = ev.events;
  if (S.user.role === 'user' && list.length === 1) { location.hash = '#/eventos/' + list[0].id; return; }
  shell(`${pageHead('Hola, ' + (S.user.name || '').split(' ')[0], S.user.role === 'planner' ? 'Las bodas en las que estás asignado/a.' : 'Tu evento con Conecta So.')}
    <div class="panel"><div class="panel__head"><h2>${S.user.role === 'planner' ? 'Mis bodas' : 'Mi evento'}</h2></div><div class="panel__body" style="padding:0">${eventMiniList(list)}</div></div>`, ['Inicio']);
}
function eventMiniList(list) {
  if (!list.length) return `<div class="empty"><span class="script">Nada aún</span>No hay eventos para mostrar.</div>`;
  return `<div class="table-wrap" style="border:0"><table class="dt"><tbody>${list.map(e => `<tr onclick="location.hash='#/eventos/${e.id}'" style="cursor:pointer">
    <td><b>${esc(e.conyuges || e.tipo)}</b><br><span style="color:var(--muted)">#${e.id} · ${esc(e.tipo)}</span></td>
    <td>${dmy(e.fecha)}<br><span style="color:var(--muted)">${esc(e.hora || '')}</span></td>
    <td>${locBadge(e)}</td>
    <td>${djOf(e) ? esc(djOf(e)) : '<span style="color:var(--muted)">Sin DJ</span>'}</td>
    ${S.user.role === 'admin' ? `<td>${dot(estado(e.estado).c, estado(e.estado).n)}</td><td>${pagoChip(e)}</td>` : ''}
  </tr>`).join('')}</tbody></table></div>`;
}

/* El resto de páginas se cargan desde módulos añadidos abajo */
window.__CS = { S, api, shell, pageHead, table, refreshTable, toast, modal, esc, fmtEur, dmy, slash, ymd, pad, TODAY, MONTHS, hm, toMin,
  estado, locName, locBadge, extraName, userName, djOf, dot, pagoChip, svg, roleLabel, on, loading, eventMiniList, rebuildMaps, loadContext, $, $$ };

boot();
})();
