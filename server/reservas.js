'use strict';
/**
 * RESERVAS (venta directa: comerciales → enlace para los novios → factura de reserva → boda).
 *
 * Flujo:
 *  1. Un COMERCIAL (usuario con la casilla "comercial") genera una venta: pack + extras (+ "otros"
 *     escritos a mano, preguntando si suman 50 €) + observaciones internas. Se crea un enlace corto
 *     y limpio:  https://<app>/r/K7M2QX
 *  2. Los novios abren el enlace (página pública con el logo), ven su pack/extras (no editables) y
 *     rellenan nombres, DNI, email, móvil, fecha, lugar (texto libre) y WP. Antes de enviar, una
 *     pantalla les pide RECONFIRMAR fecha y lugar. Llega un aviso a comercial@ y facturacion@.
 *  3. Administración emite la factura en Holded (de momento a mano) y apunta su número aquí. La
 *     intranet comprueba en Holded (SOLO LECTURA) si está pagada; los novios pueden descargarla.
 *  4. Pagada → botón "Crear boda" (solo administración): crea el evento + usuario titular e invita.
 *
 * Importe de reserva: 50 € (Fiesta/Bodorrio) o 100 € (Tinglado) + 50 € por extra (los "otros" solo si
 * se marcó que suman). Siempre + 10 % de IVA. En la factura va TODO en una sola línea "Reserva Pack DJ …".
 */
const crypto = require('crypto');

const PACKS = ['Fiesta', 'Bodorrio', 'Tinglado'];
const PACK_BASE = { Fiesta: 50, Bodorrio: 50, Tinglado: 100 };
const EXTRA_BASE = 50;
const IVA = 0.10;
const NOTIFY_TO = ['comercial@conectaso.es', 'facturacion@conectaso.es'];
// Precios de TARIFA por defecto (2026/27, sin IVA). Solo se usan si se marca "Aplicar precio de tarifa".
const DEFAULT_TARIFA = {
  packs: { Fiesta: 899, Bodorrio: 1579, Tinglado: 2799 },
  // por id del catálogo de servicios (los que no salen aquí se rellenan en Configuración)
  extras: { 9: 440, 10: 450, 1: 450, 6: 999, 15: 220, 2: 320, 11: 180, 38: 1250, 16: 150, 29: 520, 30: 740, 32: 500 },
};

const r2 = n => Math.round((+n || 0) * 100) / 100;
// Servicios internos/de prueba que por defecto no se ofrecen al vender (se cambia en Configuración).
const HIDE_RE = /aprendizaje|prueba|probando|revisar observ/i;
const deac = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // sin 0/O/1/I/L: no se confunden al leerlo
const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MON = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fechaLarga = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); if (!m) return iso || ''; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return `${DOW[d.getUTCDay()]} ${+m[3]} de ${MON[+m[2] - 1]} de ${m[1]}`; };
const fechaCorta = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); };
const eur = n => (r2(n)).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

const CHECKS = [
  ['factura_emitida', 'Factura de reserva emitida'],
  ['factura_enviada', 'Factura enviada por WhatsApp'],
  ['pago', 'Pago recibido (marcado en Holded)'],
  ['boda_creada', 'Boda y usuarios creados en la intranet'],
  ['whatsapp', 'Grupo de WhatsApp creado (novios + WP si hay)'],
  ['calendario', 'Añadida a Google Calendar'],
];

module.exports = function makeReservas(deps) {
  const { store, users, mail, holded, ok, fail, readBody, send, APP_URL, makeInvite } = deps;

  const DEFAULT_HIDDEN = () => store.all('extras').filter(x => HIDE_RE.test(String(x.name || ''))).map(x => +x.id);
  const cfg = () => {
    const c = store.setting('reservasConfig') || {};
    const t = c.tarifa || {};
    return {
      welcome: Object.assign({ Fiesta: '', Bodorrio: '', Tinglado: '' }, c.welcome || {}),
      hiddenExtras: Array.isArray(c.hiddenExtras) ? c.hiddenExtras.map(Number) : DEFAULT_HIDDEN(),
      tarifa: { packs: Object.assign({}, DEFAULT_TARIFA.packs, t.packs || {}), extras: Object.assign({}, DEFAULT_TARIFA.extras, t.extras || {}) },
    };
  };
  const isComercial = u => !!u && (u.role === 'admin' || !!(users.get(u.id) || {}).comercial);
  const isAdmin = u => !!u && u.role === 'admin';
  const sellerLabel = u => (u && (u.comercialName || u.name)) || '—';
  const extraName = id => { const x = store.get('extras', +id); return x ? String(x.name || '').trim() : ''; };

  // Importe calculado (50/100 € + 50 € por extra). Se puede AJUSTAR a mano (r.importeManual, base sin IVA):
  // p. ej. 2 cabezas móviles extra van en la factura pero no suman 50 € de reserva.
  const importeAuto = r => r2((PACK_BASE[r.pack] || 0) + EXTRA_BASE * ((r.extras || []).length + (r.otros || []).filter(o => o.suma).length));
  function importe(r) {
    const auto = importeAuto(r);
    const manual = r.importeManual != null && r.importeManual !== '' && isFinite(+r.importeManual);
    const base = manual ? r2(+r.importeManual) : auto;
    return { base, iva: r2(base * IVA), total: r2(base * (1 + IVA)), auto, manual };
  }
  const parseManual = v => { if (v == null || v === '') return null; const n = +String(v).replace(',', '.'); return isFinite(n) && n >= 0 ? r2(n) : null; };
  // Todos los extras como texto (catálogo + otros), en orden.
  const extrasTxt = r => (r.extras || []).map(e => e.name).concat((r.otros || []).map(o => o.name)).filter(Boolean);
  // Concepto de la factura: SIEMPRE una sola línea como pack de DJ (IVA cultural 10 %).
  function concepto(r) {
    const ex = extrasTxt(r);
    const n = r.novios || {};
    const lugar = (r.loc && (r.loc.lugarOtro || (r.loc.lugar && (store.get('locations', +r.loc.lugar) || {}).name))) || n.lugar || '';
    const linea = `Reserva Pack DJ ${r.pack}${ex.length ? ' + ' + ex.join(' + ') : ''}${lugar || n.fecha ? ' — ' + [lugar, fechaCorta(n.fecha)].filter(Boolean).join(', ') : ''}`;
    return { linea, lugar, fecha: n.fecha || '', obs: `Fecha: ${fechaLarga(n.fecha)} · Lugar: ${lugar}` };
  }

  // ---- coincidencia del lugar escrito por los novios con las fincas (palabras clave) ----
  const STOP = new Set(['mas', 'can', 'cal', 'el', 'la', 'els', 'les', 'los', 'las', 'de', 'del', 'd', 'l', 'i', 'y', 'finca', 'masia', 'hotel', 'restaurant', 'restaurante', 'castell', 'castillo', 'espai', 'espacio', 'the', 'en', 'a']);
  const toks = s => deac(s).replace(/[^a-z0-9ñ]+/g, ' ').split(' ').map(t => t.replace(/v/g, 'b')).filter(t => t.length > 1);
  function matchLoc(text) {
    const q = toks(text); if (!q.length) return null;
    const qs = new Set(q);
    let best = null;
    store.all('locations').forEach(l => {
      const name = String(l.name || ''); if (!name) return;
      const lt = toks(name); if (!lt.length) return;
      const sig = lt.filter(t => !STOP.has(t)); const use = sig.length ? sig : lt;
      const hit = use.filter(t => qs.has(t)).length;
      if (!hit) return;
      const score = hit / use.length + (deac(text).includes(deac(name)) ? 1 : 0) - Math.abs(lt.length - q.length) * 0.01;
      if (!best || score > best.score) best = { id: l.id, name, score };
    });
    return best && best.score >= 0.5 ? best : null;
  }

  function newCode() {
    const used = new Set(store.all('reservas').map(r => r.code));
    for (let k = 0; k < 50; k++) {
      let c = ''; const b = crypto.randomBytes(6);
      for (let i = 0; i < 6; i++) c += CODE_CHARS[b[i] % CODE_CHARS.length];
      if (!used.has(c)) return c;
    }
    throw new Error('No se pudo generar el código');
  }
  const linkOf = r => (APP_URL() || '') + '/r/' + r.code;
  const byCode = code => store.all('reservas').find(r => r.code === String(code || '').toUpperCase());

  function status(r) {
    if (r.cancelled) return 'cancelada';
    if (r.eventId) return 'creada';
    if (r.invoice && r.invoice.paid) return 'pagada';
    if (r.invoice && r.invoice.number) return 'facturada';
    if (r.submittedAt) return 'pendiente';
    return 'enlace';
  }
  // Vista para el equipo
  function view(r, user) {
    const u = users.get(r.sellerId) || {};
    const out = Object.assign({}, r, {
      status: status(r), link: linkOf(r), importe: importe(r), concepto: concepto(r),
      sellerName: sellerLabel(u), sellerColor: u.color || '',
      checks: CHECKS.map(([k, t]) => Object.assign({ key: k, label: t }, (r.checklist || {})[k] || {})),
    });
    if (r.novios && r.novios.lugar && !r.loc) out.locSuggest = matchLoc(r.novios.lugar);
    out.welcome = (() => {
      const t = cfg().welcome[r.pack] || ''; if (!t.trim()) return '';
      const n = r.novios || {}; const first = s => String(s || '').trim().split(/\s+/)[0] || '';
      const novios = [first(n.s1 && n.s1.name), first(n.s2 && n.s2.name)].filter(Boolean).join(' y ');
      return t.replace(/\{novios\}/g, novios).replace(/\{fecha\}/g, fechaLarga(n.fecha)).replace(/\{lugar\}/g, out.concepto.lugar).replace(/\{pack\}/g, r.pack);
    })();
    if (!isAdmin(user)) delete out.audit;
    return out;
  }

  // ---- comprobar pago en Holded (solo lectura) ----
  async function checkHolded(r, force) {
    if (!r.invoice || !r.invoice.number) return r;
    if (!holded.enabled()) { r.invoice.error = 'Holded no está configurado'; return r; }
    try {
      let hits = await holded.findInvoicesByNumber(r.invoice.number, !!force);
      if (!hits.length && !force) hits = await holded.findInvoicesByNumber(r.invoice.number, true);
      const inv = hits.find(h => !h.credit) || hits[0];
      if (!inv) { r.invoice.found = false; r.invoice.error = 'No se encuentra esa factura en Holded'; }
      else {
        r.invoice.found = true; delete r.invoice.error;
        r.invoice.holdedId = inv.id; r.invoice.totalConIva = inv.totalConIva; r.invoice.contact = inv.contact || '';
        const wasPaid = !!r.invoice.paid;
        r.invoice.paid = !!inv.paidFull;
        if (r.invoice.paid && !wasPaid) { r.checklist = r.checklist || {}; if (!r.checklist.pago) r.checklist.pago = { at: new Date().toISOString(), by: 'Holded (automático)' }; }
      }
      r.invoice.checkedAt = new Date().toISOString();
    } catch (e) { r.invoice.error = 'Holded: ' + e.message; }
    store.put('reservas', r);
    return r;
  }
  // Revisión periódica de las facturas pendientes de pago (cada 15 min).
  setInterval(() => {
    store.all('reservas').filter(r => !r.cancelled && !r.eventId && r.invoice && r.invoice.number && !r.invoice.paid)
      .reduce((p, r) => p.then(() => checkHolded(r, false)).catch(() => {}), Promise.resolve());
  }, 15 * 60 * 1000).unref();

  function notifyNew(r) {
    const n = r.novios || {}; const c = concepto(r); const imp = importe(r);
    const seller = sellerLabel(users.get(r.sellerId));
    const url = (APP_URL() || '') + '/#/reservas?id=' + r.id;
    const rows = [
      ['Comercial', seller], ['Pack', r.pack], ['Extras', extrasTxt(r).join(', ') || '—'],
      ['Novios', [n.s1 && n.s1.name, n.s2 && n.s2.name].filter(Boolean).join(' y ')], ['Fecha', fechaLarga(n.fecha)], ['Lugar (escrito por los novios)', n.lugar],
      ['Email / móvil', [n.s1 && n.s1.email, n.s1 && n.s1.mobile].filter(Boolean).join(' · ')],
      ['Wedding planner', n.wp && n.wp.name ? [n.wp.name, n.wp.email, n.wp.phone].filter(Boolean).join(' · ') : 'No'],
      ['Concepto factura', c.linea], ['Observaciones factura', c.obs], ['Importe reserva', `${eur(imp.base)} + 10 % IVA = ${eur(imp.total)}`],
      ['Observaciones internas', r.obs || '—'],
    ];
    const text = 'Nueva venta (reserva ' + r.code + ')\n\n' + rows.map(x => x[0] + ': ' + x[1]).join('\n') + '\n\nGestionar: ' + url;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#130F17"><h2 style="margin:0 0 12px">🎉 ¡Nueva venta! Reserva ${escH(r.code)}</h2>
      <table cellpadding="6" style="border-collapse:collapse">${rows.map(x => `<tr><td style="color:#6a6472;vertical-align:top">${escH(x[0])}</td><td><b>${escH(x[1])}</b></td></tr>`).join('')}</table>
      <p style="margin-top:16px"><a href="${escH(url)}" style="background:#E82C88;color:#fff;padding:10px 16px;text-decoration:none;font-weight:bold">Abrir la reserva</a></p></div>`;
    NOTIFY_TO.forEach(to => { try { mail.sendMail({ to, subject: `🎉 Nueva venta · ${r.pack} · ${fechaCorta(n.fecha)} · ${seller}`, text, html }).catch(() => {}); } catch (e) {} });
  }

  // ---- crear la boda a partir de la reserva (solo administración) ----
  async function crearBoda(r, body, user) {
    if (r.eventId) throw Object.assign(new Error('Esta reserva ya tiene boda creada (#' + r.eventId + ').'), { status: 409 });
    const n = r.novios || {}; const s1 = n.s1 || {}, s2 = n.s2 || {};
    if (!s1.email) throw Object.assign(new Error('Falta el email de los novios.'), { status: 400 });
    if (users.byEmail(s1.email)) throw Object.assign(new Error('Ya existe un usuario con el email ' + s1.email + '. Revisa si esta boda ya está creada.'), { status: 409 });
    const lugar = +body.lugar || 0;
    const lugarOtro = lugar ? '' : String(body.lugarOtro || n.lugar || '').trim();
    const first = s => String(s || '').trim().split(/\s+/)[0] || '';
    const seller = sellerLabel(users.get(r.sellerId));
    // Observaciones ocultas: lo escrito en la reserva + extras no catalogados + WP (si no tiene usuario)
    const otros = (r.otros || []).map(o => o.name).filter(Boolean);
    const bits = [];
    if (r.obs && r.obs.trim()) bits.push(r.obs.trim());
    if (otros.length) bits.push('Extras no catalogados: ' + otros.join(', '));
    if (n.comentario && n.comentario.trim()) bits.push('Comentario de los novios: ' + n.comentario.trim());
    let wpId = null;
    if (n.wp && n.wp.name) {
      const wpU = n.wp.email && users.byEmail(n.wp.email); const wpUser = wpU && users.get(wpU.id);
      if (wpUser && wpUser.role === 'planner') wpId = wpUser.id;
      else bits.push('Wedding planner: ' + [n.wp.name, n.wp.email, n.wp.phone].filter(Boolean).join(' · '));
    }
    const fechaHoy = new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });
    const obsPriv = bits.length ? `Escrito en la reserva (por ${seller}, ${fechaHoy}): (${bits.join(' · ')})` : '';
    const imp = importe(r);
    const u = users.create({ email: s1.email, name: [first(s1.name), first(s2.name)].filter(Boolean).join(' y ') || s1.name, role: 'user', data: {} });
    const ev = {
      id: store.nextId('events'), tipo: r.pack, conyuges: [s1.name, s2.name].filter(Boolean).join(' y '), fecha: n.fecha || '', hora: '00:01',
      lugar, lugarOtro, ceremoniaFuera: false, estado: 0, metodo: 'Transferencia',
      pagoCliente: r2(+body.pagoCliente || 0), pagado: imp.total, pagoRestaurante: 0,
      userId: u.id, services: (r.extras || []).filter(e => e.id).map(e => ({ servicio: +e.id, resp: '', resp2: '' })),
      music: {}, extras: {}, labels: {},
      spouses: [{ name: s1.name || '', dni: s1.dni || '', email: s1.email || '', mobile: s1.mobile || '' }, { name: s2.name || '', dni: s2.dni || '', email: s2.email || '', mobile: s2.mobile || '' }],
      obsPriv, reservaId: r.id,
    };
    if (wpId) ev.wpId = wpId;
    store.put('events', ev);
    const invite = await makeInvite(u);
    r.eventId = ev.id; r.userId = u.id; r.createdEventAt = new Date().toISOString(); r.createdEventBy = (users.get(user.id) || {}).name || '';
    store.put('reservas', r);
    store.audit(user.id, 'reserva-crear-boda', 'events', ev.id);
    return { event: { id: ev.id }, invite };
  }

  // ======================= API del equipo =======================
  async function handle(req, res, user, seg, method, url) {
    if (!isComercial(user)) return fail(res, 404, 'No encontrado');
    // Configuración (textos de bienvenida + precios de tarifa) — solo administración
    if (seg[1] === 'config') {
      if (!isAdmin(user)) return fail(res, 403, 'Solo administración');
      if (method === 'GET') return ok(res, Object.assign(cfg(), { extrasCatalog: store.all('extras').map(x => ({ id: x.id, name: x.name })) }));
      if (method === 'PUT') {
        const b = await readBody(req); const cur = store.setting('reservasConfig') || {};
        if (b.welcome) cur.welcome = { Fiesta: String(b.welcome.Fiesta || ''), Bodorrio: String(b.welcome.Bodorrio || ''), Tinglado: String(b.welcome.Tinglado || '') };
        if (b.tarifa) cur.tarifa = { packs: b.tarifa.packs || {}, extras: b.tarifa.extras || {} };
        if (Array.isArray(b.hiddenExtras)) cur.hiddenExtras = b.hiddenExtras.map(Number).filter(Boolean);
        store.setSetting('reservasConfig', cur);
        return ok(res, cfg());
      }
    }
    if (seg.length === 1 && method === 'GET') {
      const list = store.all('reservas').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(r => view(r, user));
      return ok(res, { reservas: list, packs: PACKS, hiddenExtras: cfg().hiddenExtras, extrasCatalog: store.all('extras').map(x => ({ id: x.id, name: x.name })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'es')), isAdmin: isAdmin(user) });
    }
    if (seg.length === 1 && method === 'POST') {
      const b = await readBody(req);
      if (!PACKS.includes(b.pack)) return fail(res, 400, 'Elige un pack.');
      const extras = (b.extras || []).map(id => ({ id: +id, name: extraName(id) })).filter(e => e.id && e.name);
      const otros = (b.otros || []).map(o => ({ name: String(o.name || '').trim().slice(0, 120), suma: !!o.suma })).filter(o => o.name);
      const me = users.get(user.id) || {};
      const r = { id: store.nextId('reservas'), code: newCode(), createdAt: new Date().toISOString(), sellerId: user.id,
        pack: b.pack, extras, otros, obs: String(b.obs || '').slice(0, 4000), checklist: {},
        importeManual: null,
        obsLog: b.obs ? [{ at: new Date().toISOString(), by: sellerLabel(me), text: String(b.obs).slice(0, 4000) }] : [] };
      { const m = parseManual(b.importe); if (m != null && m !== importeAuto(r)) r.importeManual = m; }
      store.put('reservas', r);
      store.audit(user.id, 'reserva-create', 'reservas', r.id);
      return ok(res, { reserva: view(r, user) });
    }
    const id = +seg[1];
    const r = id && store.get('reservas', id);
    if (!r) return fail(res, 404, 'Reserva no encontrada');
    const me = users.get(user.id) || {};
    if (seg.length === 2 && method === 'GET') return ok(res, { reserva: view(r, user) });
    if (seg.length === 2 && method === 'PUT') {
      const b = await readBody(req);
      if (b.venta) {   // editar pack / extras / otros: el enlace (código) es el mismo y muestra los cambios al momento
        if (r.eventId) return fail(res, 400, 'La boda ya está creada: los cambios se hacen en la propia boda.');
        if (r.invoice && r.invoice.number && !isAdmin(user)) return fail(res, 403, 'La factura ya está emitida: solo administración puede cambiar la venta.');
        if (!PACKS.includes(b.pack)) return fail(res, 400, 'Elige un pack.');
        r.pack = b.pack;
        r.extras = (b.extras || []).map(x => ({ id: +x, name: extraName(x) })).filter(e => e.id && e.name);
        r.otros = (b.otros || []).map(o => ({ name: String(o.name || '').trim().slice(0, 120), suma: !!o.suma })).filter(o => o.name);
        (r.ventaLog = r.ventaLog || []).push({ at: new Date().toISOString(), by: sellerLabel(me), pack: r.pack, extras: extrasTxt(r) });
      }
      if (b.importe !== undefined) {   // ajuste manual del importe de reserva (antes de emitir la factura, o administración)
        if (r.invoice && r.invoice.number && !isAdmin(user)) return fail(res, 403, 'La factura ya está emitida: solo administración puede cambiar el importe.');
        const m = parseManual(b.importe);
        r.importeManual = (m == null || m === importeAuto(r)) ? null : m;
      }
      if (b.obs !== undefined && String(b.obs) !== String(r.obs || '')) {
        r.obs = String(b.obs).slice(0, 4000);
        (r.obsLog = r.obsLog || []).push({ at: new Date().toISOString(), by: sellerLabel(me), text: r.obs });
      }
      if (isAdmin(user)) {
        if (b.invoiceNumber !== undefined) {
          const num = String(b.invoiceNumber || '').trim();
          if (!num) delete r.invoice; else if (!r.invoice || r.invoice.number !== num) r.invoice = { number: num };
          if (num) { r.checklist = r.checklist || {}; if (!r.checklist.factura_emitida) r.checklist.factura_emitida = { at: new Date().toISOString(), by: sellerLabel(me) }; }
        }
        if (b.loc !== undefined) r.loc = b.loc ? { lugar: +b.loc.lugar || 0, lugarOtro: +b.loc.lugar ? '' : String(b.loc.lugarOtro || '').trim() } : null;
        if (b.cancelled !== undefined) r.cancelled = !!b.cancelled;
      }
      store.put('reservas', r);
      if (b.invoiceNumber) await checkHolded(r, false);
      return ok(res, { reserva: view(store.get('reservas', id), user) });
    }
    if (seg[2] === 'check' && method === 'POST') {
      const b = await readBody(req);
      if (!CHECKS.some(c => c[0] === b.key)) return fail(res, 400, 'Paso no válido');
      if (['pago', 'factura_emitida'].includes(b.key) && !isAdmin(user)) return fail(res, 403, 'Solo administración');
      r.checklist = r.checklist || {};
      if (b.on) r.checklist[b.key] = { at: new Date().toISOString(), by: sellerLabel(me) }; else delete r.checklist[b.key];
      store.put('reservas', r);
      return ok(res, { reserva: view(r, user) });
    }
    if (seg[2] === 'holded' && method === 'POST') { await checkHolded(r, true); return ok(res, { reserva: view(store.get('reservas', id), user) }); }
    if (seg[2] === 'factura' && method === 'GET') {
      if (!r.invoice || !r.invoice.holdedId) return fail(res, 404, 'Factura no disponible');
      try { const buf = await holded.getInvoicePdf(r.invoice.holdedId); return send(res, 200, buf, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="factura-reserva-${r.code}.pdf"` }); }
      catch (e) { return fail(res, 502, 'No se pudo obtener la factura: ' + e.message); }
    }
    if (seg[2] === 'crear-boda' && method === 'POST') {
      if (!isAdmin(user)) return fail(res, 403, 'Solo administración puede crear la boda.');
      const b = await readBody(req);
      try { const out = await crearBoda(r, b, user); return ok(res, Object.assign({ reserva: view(store.get('reservas', id), user) }, out)); }
      catch (e) { return fail(res, e.status || 400, e.message); }
    }
    if (seg[2] === 'tarifa' && method === 'GET') {    // cálculo de "precio de tarifa" (+10 % IVA) para crear la boda
      const t = cfg().tarifa; const lines = [];
      lines.push({ name: 'Pack ' + r.pack, price: +t.packs[r.pack] || 0 });
      (r.extras || []).forEach(e => lines.push({ name: e.name, price: t.extras[e.id] != null && t.extras[e.id] !== '' ? +t.extras[e.id] : null }));
      (r.otros || []).forEach(o => lines.push({ name: o.name + ' (no catalogado)', price: null }));
      const base = r2(lines.reduce((s, l) => s + (l.price || 0), 0));
      return ok(res, { lines, base, total: r2(base * (1 + IVA)), missing: lines.filter(l => l.price == null).map(l => l.name) });
    }
    if (seg.length === 2 && method === 'DELETE') {
      if (!isAdmin(user)) return fail(res, 403, 'Solo administración');
      if (r.submittedAt || r.eventId) return fail(res, 400, 'Esta reserva ya tiene datos: cancélala en vez de borrarla.');
      store.del('reservas', id); return ok(res, { ok: true });
    }
    return fail(res, 404, 'No encontrado');
  }

  // ======================= Parte PÚBLICA (novios, sin sesión) =======================
  const hits = new Map();   // límite simple de envíos por IP
  const misses = new Map(); // códigos inexistentes probados por IP
  function publicView(r) {
    const imp = importe(r); const n = r.novios || {}; const st = status(r);
    return {
      code: r.code, pack: r.pack, extras: extrasTxt(r), importe: imp, status: st, submitted: !!r.submittedAt,
      resumen: r.submittedAt ? { novios: [n.s1 && n.s1.name, n.s2 && n.s2.name].filter(Boolean).join(' y '), fecha: fechaLarga(n.fecha), lugar: n.lugar } : null,
      factura: !!(r.invoice && r.invoice.holdedId) && !r.cancelled, pagada: !!(r.invoice && r.invoice.paid),
    };
  }
  async function publicApi(req, res, seg, method) {
    // /api/public/r/:code[/factura]
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now(); const bad = (misses.get(ip) || []).filter(t => now - t < 3600e3);
    if (bad.length > 30) return fail(res, 429, 'Demasiados intentos. Prueba más tarde.');
    const r = byCode(seg[2]);
    if (!r || r.cancelled) { bad.push(now); misses.set(ip, bad); return fail(res, 404, 'Este enlace no es válido. Pídenos uno nuevo por WhatsApp.'); }
    if (seg.length === 3 && method === 'GET') return ok(res, publicView(r));
    if (seg[3] === 'factura' && method === 'GET') {
      if (!r.invoice || !r.invoice.holdedId) return fail(res, 404, 'La factura aún no está disponible.');
      try { const buf = await holded.getInvoicePdf(r.invoice.holdedId); return send(res, 200, buf, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="Factura-reserva-Conecta-So.pdf"` }); }
      catch (e) { return fail(res, 502, 'No se pudo descargar la factura. Inténtalo más tarde.'); }
    }
    if (seg.length === 3 && method === 'POST') {
      if (r.submittedAt) return fail(res, 409, 'Ya hemos recibido vuestros datos. Si hay que cambiar algo, escribidnos por WhatsApp.');
      const h = (hits.get(ip) || []).filter(t => now - t < 3600e3); h.push(now); hits.set(ip, h);
      if (h.length > 20) return fail(res, 429, 'Demasiados intentos. Prueba más tarde.');
      const b = await readBody(req).catch(() => ({}));
      if (b.website) return ok(res, { ok: true });   // trampa anti-bots (campo oculto)
      const S = (v, max = 160) => String(v == null ? '' : v).trim().slice(0, max);
      const sp = o => ({ name: S(o && o.name), dni: S(o && o.dni, 20).toUpperCase(), email: S(o && o.email).toLowerCase(), mobile: S(o && o.mobile, 30) });
      const n = { s1: sp(b.s1), s2: sp(b.s2), fecha: S(b.fecha, 10), lugar: S(b.lugar, 160), comentario: S(b.comentario, 1500) };
      if (b.wp && b.wp.has && S(b.wp.name)) n.wp = { name: S(b.wp.name), email: S(b.wp.email).toLowerCase() };
      const miss = [];
      if (!n.s1.name) miss.push('nombre y apellidos'); if (!n.s1.dni) miss.push('DNI / NIE');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(n.s1.email)) miss.push('email válido'); if (!n.s1.mobile) miss.push('móvil');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(n.fecha)) miss.push('fecha de la boda'); if (!n.lugar) miss.push('lugar de la boda');
      if (!b.consent) miss.push('aceptar el tratamiento de datos');
      if (miss.length) return fail(res, 400, 'Falta: ' + miss.join(', ') + '.');
      r.novios = n; r.submittedAt = new Date().toISOString(); r.consentAt = r.submittedAt;
      const m = matchLoc(n.lugar); r.loc = m ? { lugar: m.id, lugarOtro: '', auto: true } : { lugar: 0, lugarOtro: n.lugar, auto: true };
      store.put('reservas', r);
      store.audit(null, 'reserva-submit', 'reservas', r.id);
      try { notifyNew(r); } catch (e) {}
      return ok(res, publicView(r));
    }
    return fail(res, 404, 'No encontrado');
  }

  // Página pública /r/:code (HTML propio, ligero, con vista previa bonita para WhatsApp)
  function publicPage(res, code) {
    const r = byCode(code);
    const base = APP_URL() || '';
    const title = 'Conecta So · Reserva de vuestra boda';
    const desc = r ? `Pack ${r.pack} · Completad vuestros datos para reservar la fecha` : 'Completad vuestros datos para reservar la fecha';
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escH(title)}</title><meta name="robots" content="noindex,nofollow">
<meta property="og:type" content="website"><meta property="og:title" content="${escH(title)}"><meta property="og:description" content="${escH(desc)}">
<meta property="og:image" content="${escH(base)}/assets/brand/og-reserva.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="theme-color" content="#130F17"><link rel="icon" href="/assets/brand/favicon-32.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap">
<style>${PAGE_CSS}</style></head><body>
<header class="top"><img src="/assets/brand/logo-principal-blanco.svg" alt="Conecta So" class="logo"><div class="kick">Reserva de vuestra boda</div></header>
<main id="app"><div class="card"><p class="muted">Cargando…</p></div></main>
<footer class="foot">Conecta So · DJs, sonido e iluminación · <a href="https://www.conectaso.es">conectaso.es</a></footer>
<script>window.__CODE=${JSON.stringify(String(code || '').toUpperCase())};${PAGE_JS}</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  return { handle, publicApi, publicPage, CHECKS };
};

/* ---------------- estilos y lógica de la página pública ---------------- */
const PAGE_CSS = `
@font-face{font-family:'Outer Sans';src:url('/assets/fonts/outer-sans-black.woff2') format('woff2');font-weight:900;font-display:swap}
@font-face{font-family:'Evolve Sans';src:url('/assets/fonts/evolve-sans.woff2') format('woff2');font-weight:400;font-display:swap}
:root{--ink:#130F17;--cream:#F9F5E1;--pink:#E82C88;--blue:#31B9CB;--yellow:#F0E85A;--muted:#6a6472;--line:#e3ddd0}
*{box-sizing:border-box}html,body{margin:0}
body{font-family:'Evolve Sans',-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--cream);color:var(--ink);font-size:15px;line-height:1.5}
.top{background:var(--ink);padding:34px 16px 30px;text-align:center;position:relative;overflow:hidden}
.top:after{content:"";position:absolute;left:0;right:0;bottom:0;height:6px;background:linear-gradient(90deg,var(--pink),var(--blue),var(--yellow))}
.logo{width:220px;max-width:70%;height:auto}
.kick{margin-top:12px;color:var(--yellow);font-family:'Archivo Black','Outer Sans',Arial Black,sans-serif;font-size:13px;letter-spacing:.14em;text-transform:uppercase}
main{max-width:620px;margin:0 auto;padding:22px 16px 30px}
.card{background:#fff;border:2px solid var(--ink);padding:18px 18px;margin-bottom:16px}
h2{font-family:'Archivo Black','Outer Sans',Arial Black,sans-serif;font-size:19px;margin:0 0 12px;letter-spacing:-.01em}
h3{font-size:14px;margin:18px 0 8px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.pack{font-family:'Archivo Black','Outer Sans',Arial Black,sans-serif;font-size:24px;color:var(--pink)}
.ex{margin:8px 0 0;padding:0;list-style:none}.ex li{padding:4px 0;border-top:1px dashed var(--line)}.ex li:before{content:"+ ";color:var(--pink);font-weight:700}
.amount{display:flex;justify-content:space-between;align-items:baseline;margin-top:14px;padding-top:12px;border-top:2px solid var(--ink)}
.amount b{font-size:22px}
.muted{color:var(--muted)}.small{font-size:12.5px}
label{display:block;font-weight:700;font-size:13px;margin:12px 0 4px}
input:not([type=checkbox]),textarea{width:100%;font:inherit;padding:11px 12px;border:2px solid var(--ink);background:#fff;border-radius:0;-webkit-appearance:none}
input[type=checkbox]{accent-color:var(--pink)}
input:not([type=checkbox]):focus,textarea:focus{outline:3px solid var(--blue);outline-offset:0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}@media(max-width:520px){.grid{grid-template-columns:1fr}}
.chk{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:13.5px}.chk input{width:20px;height:20px;flex:none;margin-top:1px}
.btn{display:block;width:100%;padding:15px;border:2px solid var(--ink);background:var(--pink);color:#fff;font-family:'Archivo Black','Outer Sans',Arial Black,sans-serif;font-size:15px;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;box-shadow:4px 4px 0 var(--ink);margin-top:18px;text-align:center;text-decoration:none}
.btn:active{transform:translate(3px,3px);box-shadow:1px 1px 0 var(--ink)}
.btn--ghost{background:#fff;color:var(--ink)}
.err{background:#fde7e9;border:2px solid #c62828;color:#8b1a1a;padding:10px 12px;margin-top:12px;font-weight:700}
.ok{text-align:center}.ok .big{font-size:46px}
.ovl{position:fixed;inset:0;background:rgba(19,15,23,.72);display:flex;align-items:center;justify-content:center;padding:16px;z-index:9}
.ovl .card{max-width:480px;width:100%;margin:0}
.conf div{padding:9px 0;border-bottom:1px dashed var(--line);font-size:16px}.conf span{display:block;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.conf .date{font-size:20px;font-weight:800;color:var(--pink)}
.warn{background:#fff8cc;border:2px solid var(--ink);padding:10px 12px;margin-top:10px;font-weight:700}
.row2{display:flex;gap:10px}.row2 .btn{margin-top:14px}
.note{background:#eaf7f9;border:2px solid var(--ink);padding:10px 12px;margin:16px 0 4px;font-size:13.5px}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.foot{text-align:center;color:var(--muted);font-size:12px;padding:10px 16px 30px}.foot a{color:var(--muted)}
`;
const PAGE_JS = `
(function(){
var app=document.getElementById('app'),code=window.__CODE,data=null;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function eur(n){return (Math.round((+n||0)*100)/100).toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2})+' €'}
var DOW=['domingo','lunes','martes','miércoles','jueves','viernes','sábado'],MON=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function larga(iso){var m=/^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(iso||'');if(!m)return iso;var d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));var t=DOW[d.getUTCDay()];return t.charAt(0).toUpperCase()+t.slice(1)+', '+(+m[3])+' de '+MON[+m[2]-1]+' de '+m[1]}
var NET='No hemos podido conectar con el servidor. Esperad unos segundos y volved a pulsar el botón: vuestros datos siguen aquí.';
function once(method,body){return fetch('/api/public/r/'+code,{method:method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,cache:'no-store'}).then(function(r){return r.text().then(function(t){var j=null;try{j=JSON.parse(t)}catch(e){}
 if(!j){var er=new Error(NET);er.net=true;throw er}if(!r.ok)throw new Error(j.error||'Error');return j})},function(){var er=new Error(NET);er.net=true;throw er})}
function api(method,body){return once(method,body).catch(function(e){if(!e.net)throw e;return new Promise(function(ok){setTimeout(ok,2500)}).then(function(){return once(method,body)})})}
function packCard(d){return '<div class="card"><h2>Vuestra reserva</h2><div class="pack">Pack '+esc(d.pack)+'</div>'+(d.extras.length?'<ul class="ex">'+d.extras.map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul>':'')+
 '<div class="amount"><span>Importe de la reserva<br><span class="muted small">'+eur(d.importe.base)+' + 10 % IVA</span></span><b>'+eur(d.importe.total)+'</b></div></div>'}
function done(d){
 var h=packCard(d)+'<div class="card ok"><div class="big">'+(d.pagada?'🎉':'✅')+'</div><h2>'+(d.pagada?'¡Reserva confirmada!':'¡Datos recibidos!')+'</h2>';
 if(d.resumen)h+='<p><b>'+esc(d.resumen.novios)+'</b><br>'+esc(larga(d.resumen.fecha)||d.resumen.fecha)+' · '+esc(d.resumen.lugar)+'</p>';
 if(d.pagada)h+='<p>Hemos recibido el pago. ¡Vuestra fecha está reservada! En breve recibiréis el acceso a vuestra intranet para preparar la boda.</p>';
 else if(d.factura)h+='<p>Ya tenéis disponible la <b>factura de reserva</b>. Para reservar la fecha, haced la transferencia del importe indicado: <b>el número de cuenta está en el pie de la factura</b>.</p><a class="btn" href="/api/public/r/'+code+'/factura">Descargar factura</a>';
 else h+='<p>¡Gracias! En breve os enviaremos la <b>factura de reserva</b>. Podréis descargarla también desde este mismo enlace.</p>';
 app.innerHTML=h+'</div>';
}
function form(d,err){
 app.innerHTML=packCard(d)+'<form class="card" id="f" novalidate><h2>Vuestros datos</h2><p class="muted small">Los necesitamos para la factura de reserva y para crear vuestra intranet privada.</p>'+
 '<h3>Datos de uno de los dos</h3><label>Nombre y apellidos</label><input name="s1n" autocomplete="name" required><div class="grid"><div><label>DNI / NIE</label><input name="s1d" required></div><div><label>Móvil</label><input name="s1m" type="tel" autocomplete="tel" required></div></div><label>Email</label><input name="s1e" type="email" autocomplete="email" required>'+
 '<p class="note">💡 Con los datos de uno de los dos es suficiente. Los datos del otro cónyuge los podréis introducir más adelante dentro de vuestra propia intranet.</p>'+
 '<h3>La boda</h3><label>Fecha de la boda</label><input name="fecha" type="date" required><label>Lugar de la celebración (nombre de la finca)</label><input name="lugar" placeholder="Ej.: Mas la Boella" required>'+
 '<label class="chk" style="margin-top:16px"><input type="checkbox" name="wph" id="wph"> Tenemos wedding planner</label><div id="wpb" hidden><label>Nombre de la wedding planner</label><input name="wpn"><label>Email de la wedding planner <span class="muted">(opcional)</span></label><input name="wpe" type="email"></div>'+
 '<label>¿Algo que queráis comentarnos? <span class="muted">(opcional)</span></label><textarea name="com" rows="3"></textarea>'+
 '<div class="hp"><label>Web</label><input name="website" tabindex="-1" autocomplete="off"></div>'+
 '<label class="chk" style="margin-top:18px"><input type="checkbox" name="consent"> <span>Acepto que Conecta So trate estos datos para gestionar la reserva, emitir la factura y preparar nuestra boda.</span></label>'+
 (err?'<div class="err">'+esc(err)+'</div>':'')+'<button class="btn" type="submit">Revisar y enviar</button></form>';
 var f=document.getElementById('f');document.getElementById('wph').onchange=function(){document.getElementById('wpb').hidden=!this.checked};
 if(window.__last){Object.keys(window.__last).forEach(function(k){var e=f.elements[k];if(!e)return;if(e.type==='checkbox')e.checked=!!window.__last[k];else e.value=window.__last[k]});document.getElementById('wpb').hidden=!f.elements.wph.checked}
 f.onsubmit=function(ev){ev.preventDefault();var v={};Array.prototype.forEach.call(f.elements,function(e){if(e.name)v[e.name]=e.type==='checkbox'?e.checked:e.value.trim()});window.__last=v;
  var miss=[];if(!v.s1n)miss.push('nombre y apellidos');if(!v.s1d)miss.push('DNI / NIE');if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v.s1e))miss.push('email válido');if(!v.s1m)miss.push('móvil');if(!v.fecha)miss.push('fecha');if(!v.lugar)miss.push('lugar');if(!v.consent)miss.push('aceptar el tratamiento de datos');
  if(miss.length){form(d,'Falta: '+miss.join(', ')+'.');return}
  confirmBox(d,v)}
}
function confirmBox(d,v){
 var today=new Date().toISOString().slice(0,10),yrs=(+v.fecha.slice(0,4))-new Date().getFullYear(),w='';
 if(v.fecha<today)w='⚠️ Esta fecha ya ha pasado. ¿Seguro que es correcta?';else if(yrs>3)w='⚠️ Esta fecha es dentro de más de 3 años. Revisad el año.';
 var o=document.createElement('div');o.className='ovl';o.innerHTML='<div class="card"><h2>¿Está todo bien?</h2><p class="muted small">Revisad sobre todo la fecha y el lugar antes de enviar.</p><div class="conf">'+
 '<div><span>Fecha de la boda</span><b class="date">'+esc(larga(v.fecha))+'</b></div><div><span>Lugar</span><b>'+esc(v.lugar)+'</b></div><div><span>Pack</span><b>'+esc(d.pack)+(d.extras.length?' + '+esc(d.extras.join(' + ')):'')+'</b></div><div><span>A nombre de</span><b>'+esc(v.s1n)+'</b></div></div>'+
 (w?'<div class="warn">'+w+'</div>':'')+'<div class="row2"><button class="btn btn--ghost" id="back" type="button">← Corregir</button><button class="btn" id="go" type="button">✓ Sí, es correcto</button></div></div>';
 document.body.appendChild(o);
 o.querySelector('#back').onclick=function(){o.remove()};
 o.querySelector('#go').onclick=function(){var b=this;b.disabled=true;b.textContent='Enviando…';
  api('POST',{s1:{name:v.s1n,dni:v.s1d,email:v.s1e,mobile:v.s1m},fecha:v.fecha,lugar:v.lugar,wp:{has:v.wph,name:v.wpn,email:v.wpe},comentario:v.com,consent:v.consent,website:v.website})
  .then(function(r){o.remove();data=r;done(r);window.scrollTo(0,0)}).catch(function(e){o.remove();form(d,e.message)})}
}
api('GET').then(function(d){data=d;if(d.submitted)done(d);else form(d)}).catch(function(e){app.innerHTML='<div class="card"><h2>Enlace no válido</h2><p>'+esc(e.message)+'</p></div>'});
})();
`;
