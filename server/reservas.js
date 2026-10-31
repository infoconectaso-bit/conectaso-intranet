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
      holdedDoc: c.holdedDoc === 'invoice' ? 'invoice' : 'estimate',   // PRUEBAS: presupuesto; REAL: factura
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
    const conceptoFactura = `Reserva servicio DJ + Pack ${r.pack}${ex.length ? ' + ' + ex.join(' + ') : ''}`;
    return { linea, conceptoFactura, lugar, fecha: n.fecha || '', obs: `Fecha: ${fechaLarga(n.fecha)} · Lugar: ${lugar}` };
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
    if (!r.invoice || !r.invoice.number || r.invoice.docType === 'estimate') return r;
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
        if (b.holdedDoc) cur.holdedDoc = b.holdedDoc === 'invoice' ? 'invoice' : 'estimate';
        store.setSetting('reservasConfig', cur);
        return ok(res, cfg());
      }
    }
    if (seg.length === 1 && method === 'GET') {
      const list = store.all('reservas').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(r => view(r, user));
      return ok(res, { reservas: list, packs: PACKS, hiddenExtras: cfg().hiddenExtras, holdedDoc: cfg().holdedDoc, extrasCatalog: store.all('extras').map(x => ({ id: x.id, name: x.name })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'es')), isAdmin: isAdmin(user) });
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
    if (seg[2] === 'emitir' && method === 'POST') {   // crea el contacto y el PRESUPUESTO/FACTURA en Holded
      if (!isAdmin(user)) return fail(res, 403, 'Solo administración');
      if (!r.submittedAt) return fail(res, 400, 'Los novios aún no han rellenado sus datos.');
      if (r.invoice && r.invoice.number) return fail(res, 409, 'Esta reserva ya tiene documento en Holded (' + r.invoice.number + ').');
      if (!holded.enabled()) return fail(res, 400, 'Holded no está configurado.');
      const n = r.novios || {}; const s1 = n.s1 || {}; const c = concepto(r); const type = cfg().holdedDoc;
      try {
        const ct = await holded.ensureContact({ name: s1.name, nif: s1.dni, email: s1.email, mobile: s1.mobile });
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
        const lineDesc = [c.lugar, fechaCorta(n.fecha)].filter(Boolean).join(' ');
        const doc = await holded.createReservaDoc(type, { contactId: ct.id, date: today, concept: c.conceptoFactura, lineDesc, notes: c.obs, base: importe(r).base });
        r.invoice = { number: doc.number, holdedId: doc.id, docType: type, contactId: ct.id, createdAt: new Date().toISOString(), paid: false };
        r.checklist = r.checklist || {}; if (!r.checklist.factura_emitida) r.checklist.factura_emitida = { at: new Date().toISOString(), by: sellerLabel(me) };
        store.put('reservas', r); store.audit(user.id, 'reserva-emitir-' + type, 'reservas', r.id);
        return ok(res, { reserva: view(r, user), doc });
      } catch (e) { return fail(res, 502, e.message); }
    }
    if (seg[2] === 'holded' && method === 'POST') { await checkHolded(r, true); return ok(res, { reserva: view(store.get('reservas', id), user) }); }
    if (seg[2] === 'factura' && method === 'GET') {
      if (!r.invoice || !r.invoice.holdedId) return fail(res, 404, 'Factura no disponible');
      try { const buf = await holded.getDocPdf(r.invoice.docType || 'invoice', r.invoice.holdedId); return send(res, 200, buf, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="factura-reserva-${r.code}.pdf"` }); }
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
      resumen: r.submittedAt ? { novios: [n.s1 && n.s1.name, n.s2 && n.s2.name].filter(Boolean).join(' y '), fecha: fechaLarga(n.fecha), fechaIso: n.fecha, lugar: n.lugar } : null,
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
      try { const buf = await holded.getDocPdf(r.invoice.docType || 'invoice', r.invoice.holdedId); return send(res, 200, buf, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="Factura-reserva-Conecta-So.pdf"` }); }
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
      if (!n.s1.name) miss.push('nombre y los dos apellidos');
      else if (n.s1.name.split(/\s+/).filter(Boolean).length < 3) miss.push('el nombre completo con los DOS apellidos (lo necesitamos para la factura)'); if (!n.s1.dni) miss.push('DNI / NIE');
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
<meta name="twitter:card" content="summary_large_image"><meta name="theme-color" content="#F4F3F7"><link rel="icon" href="/assets/brand/favicon-32.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700;12..96,800&display=swap">
<style>${PAGE_CSS}</style></head><body>
<main id="app" class="wrap"><div class="loading">Cargando vuestra reserva…</div></main>
<footer class="foot"><img src="/assets/brand/logo-principal-azul.svg" alt="Conecta So" class="foot-logo"><span>DJs, sonido e iluminación para bodas</span><a href="https://www.conectaso.es">conectaso.es</a></footer>
<script>window.__CODE=${JSON.stringify(String(code || '').toUpperCase())};${PAGE_JS}</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  return { handle, publicApi, publicPage, CHECKS };
};

/* ---------------- estilos y lógica de la página pública ---------------- */
const PAGE_CSS = `
/* Página pública de reserva: la reserva como una ENTRADA de evento (ticket). */
:root{--bg:#F4F3F7;--paper:#FFFFFF;--ink:#130F17;--ink2:#4A4452;--muted:#7D7787;--line:#E4E1EA;--pink:#E82C88;--blue:#31B9CB;--lemon:#F0E85A;--bad:#C4213A}
*{box-sizing:border-box}html,body{margin:0}
body{font-family:'Bricolage Grotesque',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-optical-sizing:auto;background:var(--bg);color:var(--ink);font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:560px;margin:0 auto;padding:max(18px,env(safe-area-inset-top)) 16px 24px}
.loading{padding:80px 0;text-align:center;color:var(--muted)}
/* ---------- ticket ---------- */
.tk{position:relative;filter:drop-shadow(0 18px 30px rgba(19,15,23,.18));margin:6px 0 22px}
@media (prefers-reduced-motion:no-preference){.tk{animation:tkIn .7s cubic-bezier(.2,.8,.2,1) both}@keyframes tkIn{from{opacity:0;transform:translateY(18px) rotate(-1.2deg)}to{opacity:1;transform:none}}}
.tk-top{position:relative;overflow:hidden;background:var(--ink);color:#fff;border-radius:22px 22px 0 0;padding:20px 22px 26px}
.tk-top:before{content:"";position:absolute;inset:-40% -30% auto auto;width:300px;height:300px;border-radius:50%;background:radial-gradient(closest-side,rgba(232,44,136,.75),rgba(232,44,136,0))}
.tk-top:after{content:"";position:absolute;inset:auto auto -55% -25%;width:320px;height:320px;border-radius:50%;background:radial-gradient(closest-side,rgba(49,185,203,.55),rgba(49,185,203,0))}
.tk-top>*{position:relative;z-index:1}
.tk-head{display:flex;justify-content:space-between;align-items:center;gap:12px}
.tk-logo{height:22px;width:auto}
.tk-code{font-size:13px;font-weight:600;letter-spacing:.08em;opacity:.8}
.tk-for{margin:26px 0 0;font-size:15px;font-weight:500;opacity:.8}
.tk-pack{margin:0;font-size:clamp(46px,14vw,64px);line-height:.92;font-weight:800;letter-spacing:-.035em}
.tk-pack small{display:block;font-size:.36em;font-weight:500;letter-spacing:0;opacity:.75;margin-bottom:4px}
.tk-ex{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px;padding:0;list-style:none}
.tk-ex li{font-size:13.5px;font-weight:600;padding:5px 11px;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22)}
.tk-cut{position:relative;height:22px;background:var(--paper);overflow:hidden}
.tk-cut:before,.tk-cut:after{content:"";position:absolute;top:0;width:22px;height:22px;border-radius:50%;background:var(--bg)}
.tk-cut:before{left:-11px}.tk-cut:after{right:-11px}
.tk-cut span{position:absolute;left:18px;right:18px;top:10px;border-top:2px dashed var(--line)}
.tk-bot{background:var(--paper);border-radius:0 0 22px 22px;padding:6px 22px 20px;display:flex;justify-content:space-between;align-items:flex-end;gap:14px}
.tk-lbl{font-size:14px;color:var(--ink2);font-weight:600}
.tk-amt{font-size:clamp(30px,9vw,38px);font-weight:800;letter-spacing:-.03em;line-height:1;white-space:nowrap}
.tk-sub{font-size:13px;color:var(--muted);margin-top:4px}
.tk-why{font-size:13px;color:var(--ink2);text-align:right;max-width:130px;line-height:1.35}
.stamp{position:absolute;right:16px;top:58px;z-index:2;transform:rotate(-10deg);border:2.5px solid var(--lemon);color:var(--lemon);font-weight:800;font-size:16px;letter-spacing:.03em;padding:3px 11px;border-radius:9px;background:rgba(19,15,23,.45)}
@media (prefers-reduced-motion:no-preference){.stamp{animation:stampIn .45s .35s cubic-bezier(.2,1.6,.4,1) both}@keyframes stampIn{from{opacity:0;transform:rotate(-10deg) scale(1.8)}to{opacity:1;transform:rotate(-10deg) scale(1)}}}
/* ---------- formulario ---------- */
.sheet{background:var(--paper);border-radius:22px;padding:22px 20px 24px;box-shadow:0 1px 0 var(--line)}
.intro{margin:0 0 6px;font-size:22px;font-weight:700;letter-spacing:-.015em;line-height:1.2}
.intro-sub{margin:0 0 4px;color:var(--ink2);font-size:15px}
.step{margin-top:26px}
.step-h{display:flex;align-items:center;gap:10px;margin:0 0 12px;font-size:18px;font-weight:700;letter-spacing:-.01em}
.step-h b{display:inline-flex;width:28px;height:28px;border-radius:50%;background:var(--ink);color:#fff;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex:none}
.f{margin-top:12px}
.f label{display:block;font-size:14.5px;font-weight:600;margin:0 0 6px;color:var(--ink)}
.f .opt{font-weight:400;color:var(--muted)}
.f input:not([type=checkbox]),.f textarea{display:block;width:100%;font:inherit;font-size:16px;color:var(--ink);background:#FAFAFC;border:1.5px solid var(--line);border-radius:12px;padding:13px 14px;min-height:52px;-webkit-appearance:none;appearance:none;transition:border-color .15s,box-shadow .15s}
.f textarea{min-height:96px;resize:vertical}
.f input::placeholder,.f textarea::placeholder{color:#A9A3B3}
.f input:focus,.f textarea:focus{outline:none;border-color:var(--ink);background:#fff;box-shadow:0 0 0 4px rgba(232,44,136,.16)}
.f .help{font-size:13px;color:var(--muted);margin-top:6px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}@media(max-width:480px){.two{grid-template-columns:1fr}}
.hint{margin-top:14px;padding:12px 14px;border-radius:12px;background:#EEF9FB;color:#1E5E68;font-size:14px;line-height:1.45}
.tick{display:flex;gap:12px;align-items:flex-start;margin-top:16px;font-size:15px;cursor:pointer}
.tick input{width:22px;height:22px;flex:none;margin:1px 0 0;accent-color:var(--pink)}
.tick small{display:block;color:var(--muted);font-size:13px}
.err{margin-top:16px;padding:12px 14px;border-radius:12px;background:#FDECEF;color:var(--bad);font-weight:600;font-size:14.5px}
.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:56px;margin-top:20px;padding:0 20px;border:0;border-radius:14px;background:var(--ink);color:#fff;font:inherit;font-size:17px;font-weight:700;cursor:pointer;text-decoration:none;transition:transform .1s}
.btn:active{transform:scale(.985)}
.btn:focus-visible{outline:3px solid var(--pink);outline-offset:3px}
.btn[disabled]{opacity:.6}
.btn--pink{background:var(--pink)}
.btn--ghost{background:transparent;color:var(--ink);border:1.5px solid var(--line)}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
/* ---------- hoja de confirmación ---------- */
.ovl{position:fixed;inset:0;background:rgba(19,15,23,.5);display:flex;align-items:flex-end;justify-content:center;z-index:9}
.bs{width:100%;max-width:560px;background:var(--paper);border-radius:24px 24px 0 0;padding:10px 20px calc(20px + env(safe-area-inset-bottom))}
@media (prefers-reduced-motion:no-preference){.bs{animation:bsUp .32s cubic-bezier(.2,.9,.25,1) both}@keyframes bsUp{from{transform:translateY(100%)}to{transform:none}}}
.bs-grip{width:40px;height:5px;border-radius:3px;background:var(--line);margin:0 auto 14px}
.bs h2{margin:0 0 4px;font-size:22px;font-weight:700;letter-spacing:-.015em}
.bs p{margin:0;color:var(--ink2);font-size:15px}
.cal{display:flex;gap:16px;align-items:center;margin:18px 0 6px}
.cal-pg{flex:none;width:96px;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 0 0 1.5px var(--line),0 8px 18px rgba(19,15,23,.08);text-align:center}
.cal-m{background:var(--pink);color:#fff;font-size:13px;font-weight:700;padding:5px 0;text-transform:capitalize}
.cal-d{font-size:44px;font-weight:800;line-height:1.05;letter-spacing:-.03em;padding-top:4px}
.cal-y{font-size:12.5px;color:var(--muted);padding-bottom:7px}
.cal-txt b{display:block;font-size:19px;letter-spacing:-.01em;text-transform:none}
.cal-txt span{display:block;color:var(--ink2);font-size:15px;margin-top:2px}
.rows{margin:12px 0 0;padding:0;list-style:none;border-top:1px solid var(--line)}
.rows li{display:flex;justify-content:space-between;gap:14px;padding:11px 0;border-bottom:1px solid var(--line);font-size:15px}
.rows li span{color:var(--muted)}.rows li b{text-align:right;font-weight:600}
.warn{margin-top:12px;padding:11px 14px;border-radius:12px;background:#FFF8C7;color:#5B4D00;font-weight:600;font-size:14.5px}
.bs-act{display:grid;grid-template-columns:1fr 1.4fr;gap:10px}.bs-act .btn{margin-top:16px}
/* ---------- estado enviado ---------- */
.done{text-align:left}
.done h1{margin:0 0 8px;font-size:26px;font-weight:800;letter-spacing:-.02em;line-height:1.15}
.done p{margin:0 0 10px;color:var(--ink2)}
.foot{display:flex;flex-direction:column;align-items:center;gap:4px;padding:18px 16px calc(28px + env(safe-area-inset-bottom));color:var(--muted);font-size:13px}
.foot-logo{height:20px;width:auto;opacity:.85;margin-bottom:4px}.foot a{color:var(--muted)}
`;
const PAGE_JS = `
(function(){
var app=document.getElementById('app'),code=window.__CODE,data=null;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function eur(n){return (Math.round((+n||0)*100)/100).toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2})+' €'}
var DOW=['domingo','lunes','martes','miércoles','jueves','viernes','sábado'],MON=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function parts(iso){var m=/^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(iso||'');if(!m)return null;var d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));return {y:m[1],m:MON[+m[2]-1],d:+m[3],w:DOW[d.getUTCDay()]}}
function cap(t){return t.charAt(0).toUpperCase()+t.slice(1)}
var NET='No hemos podido conectar con el servidor. Esperad unos segundos y volved a pulsar el botón: vuestros datos siguen aquí.';
function once(method,body){return fetch('/api/public/r/'+code,{method:method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,cache:'no-store'}).then(function(r){return r.text().then(function(t){var j=null;try{j=JSON.parse(t)}catch(e){}
 if(!j){var er=new Error(NET);er.net=true;throw er}if(!r.ok)throw new Error(j.error||'Error');return j})},function(){var er=new Error(NET);er.net=true;throw er})}
function api(method,body){return once(method,body).catch(function(e){if(!e.net)throw e;return new Promise(function(ok){setTimeout(ok,2500)}).then(function(){return once(method,body)})})}
function ticket(d,stamp){
 return '<section class="tk" aria-label="Vuestra reserva"><div class="tk-top">'+(stamp?'<div class="stamp">'+esc(stamp)+'</div>':'')+
  '<div class="tk-head"><img class="tk-logo" src="/assets/brand/logo-principal-blanco.svg" alt="Conecta So"><span class="tk-code">'+esc(d.code)+'</span></div>'+
  '<p class="tk-for">Vuestra boda con nosotros</p><h1 class="tk-pack"><small>Pack</small>'+esc(d.pack)+'</h1>'+
  (d.extras.length?'<ul class="tk-ex">'+d.extras.map(function(x){return '<li>+ '+esc(x)+'</li>'}).join('')+'</ul>':'')+
 '</div><div class="tk-cut" aria-hidden="true"><span></span></div><div class="tk-bot"><div><div class="tk-lbl">Paga y señal</div><div class="tk-amt">'+eur(d.importe.total)+'</div><div class="tk-sub">'+eur(d.importe.base)+' + IVA (10 %)</div></div>'+
 '<div class="tk-why">Con este pago vuestra fecha queda bloqueada.</div></div></section>'}
function done(d){
 var r=d.resumen||{},h=ticket(d,d.pagada?'¡Reservado!':'Recibido')+'<div class="sheet done">';
 if(d.pagada)h+='<h1>Vuestra fecha está reservada</h1><p>Hemos recibido el pago. En breve os llegará el acceso a vuestra intranet para preparar la música y todos los detalles.</p>';
 else if(d.factura)h+='<h1>Ya tenéis la factura</h1><p>Haced la transferencia de <b>'+eur(d.importe.total)+'</b> para bloquear la fecha. El número de cuenta está al pie de la factura.</p><a class="btn btn--pink" href="/api/public/r/'+code+'/factura">Descargar factura</a>';
 else h+='<h1>¡Gracias! Ya tenemos vuestros datos</h1><p>En breve os enviaremos la factura de la paga y señal. También podréis descargarla desde este mismo enlace.</p>';
 if(r.novios)h+='<ul class="rows"><li><span>A nombre de</span><b>'+esc(r.novios)+'</b></li><li><span>Fecha</span><b>'+esc(cap(r.fecha||''))+'</b></li><li><span>Lugar</span><b>'+esc(r.lugar)+'</b></li></ul>';
 app.innerHTML=h+'</div>';
}
function form(d,err){
 app.innerHTML=ticket(d)+'<form class="sheet" id="f" novalidate>'+
 '<h2 class="intro">Completad la reserva</h2><p class="intro-sub">Son dos minutos. Con estos datos preparamos la factura de la paga y señal.</p>'+
 '<div class="step"><h3 class="step-h"><b>1</b>Vuestros datos</h3>'+
  '<div class="f"><label for="s1n">Nombre y los dos apellidos</label><input id="s1n" name="s1n" autocomplete="name" placeholder="Laura Pérez Gil"><div class="help">Tal y como aparecerá en la factura.</div></div>'+
  '<div class="two"><div class="f"><label for="s1d">DNI o NIE</label><input id="s1d" name="s1d" autocapitalize="characters"></div><div class="f"><label for="s1m">Móvil</label><input id="s1m" name="s1m" type="tel" autocomplete="tel" inputmode="tel"></div></div>'+
  '<div class="f"><label for="s1e">Email</label><input id="s1e" name="s1e" type="email" autocomplete="email" inputmode="email"><div class="help">Aquí os llegará el acceso a vuestra intranet.</div></div>'+
  '<div class="hint">Basta con los datos de uno de los dos. Los de tu pareja los podréis añadir después desde vuestra intranet.</div></div>'+
 '<div class="step"><h3 class="step-h"><b>2</b>La boda</h3>'+
  '<div class="f"><label for="fecha">Fecha de la boda</label><input id="fecha" name="fecha" type="date"></div>'+
  '<div class="f"><label for="lugar">Lugar de la celebración</label><input id="lugar" name="lugar" placeholder="Nombre de la finca o del restaurante"></div>'+
  '<label class="tick"><input type="checkbox" name="wph" id="wph"><span>Tenemos wedding planner</span></label>'+
  '<div id="wpb" hidden><div class="f"><label for="wpn">Nombre de la wedding planner</label><input id="wpn" name="wpn"></div><div class="f"><label for="wpe">Su email <span class="opt">(opcional)</span></label><input id="wpe" name="wpe" type="email" inputmode="email"></div></div>'+
  '<div class="f"><label for="com">¿Algo que queráis contarnos? <span class="opt">(opcional)</span></label><textarea id="com" name="com" rows="3"></textarea></div></div>'+
 '<div class="step"><h3 class="step-h"><b>3</b>Revisar y enviar</h3>'+
  '<div class="hp"><label>Web</label><input name="website" tabindex="-1" autocomplete="off"></div>'+
  '<label class="tick"><input type="checkbox" name="consent"><span>Acepto que Conecta So use estos datos para gestionar la reserva, emitir la factura y preparar nuestra boda.</span></label>'+
  (err?'<div class="err" role="alert">'+esc(err)+'</div>':'')+'<button class="btn" type="submit">Revisar y enviar</button></div></form>';
 var f=document.getElementById('f');document.getElementById('wph').onchange=function(){document.getElementById('wpb').hidden=!this.checked};
 if(window.__last){Object.keys(window.__last).forEach(function(k){var e=f.elements[k];if(!e)return;if(e.type==='checkbox')e.checked=!!window.__last[k];else e.value=window.__last[k]});document.getElementById('wpb').hidden=!f.elements.wph.checked}
 if(err){var ee=f.querySelector('.err');if(ee)ee.scrollIntoView({block:'center'})}
 f.onsubmit=function(ev){ev.preventDefault();var v={};Array.prototype.forEach.call(f.elements,function(e){if(e.name)v[e.name]=e.type==='checkbox'?e.checked:e.value.trim()});window.__last=v;
  var miss=[];if(!v.s1n)miss.push('nombre y los dos apellidos');else if(v.s1n.split(/\\s+/).filter(Boolean).length<3)miss.push('el nombre completo con los dos apellidos (lo necesitamos para la factura)');if(!v.s1d)miss.push('DNI o NIE');if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v.s1e))miss.push('un email válido');if(!v.s1m)miss.push('el móvil');if(!v.fecha)miss.push('la fecha de la boda');if(!v.lugar)miss.push('el lugar');if(!v.consent)miss.push('aceptar el uso de los datos');
  if(miss.length){form(d,'Falta: '+miss.join(', ')+'.');return}
  confirmBox(d,v)}
}
function confirmBox(d,v){
 var today=new Date().toISOString().slice(0,10),yrs=(+v.fecha.slice(0,4))-new Date().getFullYear(),w='',p=parts(v.fecha);
 if(v.fecha<today)w='Esta fecha ya ha pasado. Revisad el día y el año.';else if(yrs>3)w='Esta fecha es dentro de más de tres años. Revisad el año.';
 var o=document.createElement('div');o.className='ovl';o.setAttribute('role','dialog');o.setAttribute('aria-modal','true');
 o.innerHTML='<div class="bs"><div class="bs-grip"></div><h2>¿Es correcto?</h2><p>Revisad sobre todo la fecha y el lugar antes de enviar.</p>'+
 (p?'<div class="cal"><div class="cal-pg"><div class="cal-m">'+esc(p.m)+'</div><div class="cal-d">'+p.d+'</div><div class="cal-y">'+p.y+'</div></div><div class="cal-txt"><b>'+esc(cap(p.w))+', '+p.d+' de '+esc(p.m)+'</b><span>'+esc(v.lugar)+'</span></div></div>':'')+
 '<ul class="rows"><li><span>Pack</span><b>'+esc(d.pack)+(d.extras.length?' + '+esc(d.extras.join(' + ')):'')+'</b></li><li><span>A nombre de</span><b>'+esc(v.s1n)+'</b></li><li><span>Paga y señal</span><b>'+eur(d.importe.total)+'</b></li></ul>'+
 (w?'<div class="warn">'+w+'</div>':'')+'<div class="bs-act"><button class="btn btn--ghost" id="back" type="button">Corregir</button><button class="btn btn--pink" id="go" type="button">Sí, enviar</button></div></div>';
 document.body.appendChild(o);o.querySelector('#go').focus();
 o.addEventListener('click',function(e){if(e.target===o)o.remove()});
 o.querySelector('#back').onclick=function(){o.remove()};
 o.querySelector('#go').onclick=function(){var b=this;b.disabled=true;b.textContent='Enviando…';
  api('POST',{s1:{name:v.s1n,dni:v.s1d,email:v.s1e,mobile:v.s1m},fecha:v.fecha,lugar:v.lugar,wp:{has:v.wph,name:v.wpn,email:v.wpe},comentario:v.com,consent:v.consent,website:v.website})
  .then(function(r){o.remove();data=r;done(r);window.scrollTo(0,0)}).catch(function(e){o.remove();form(d,e.message)})}
}
api('GET').then(function(d){data=d;if(d.submitted)done(d);else form(d)}).catch(function(e){app.innerHTML='<div class="sheet done"><h1>Este enlace no funciona</h1><p>'+esc(e.message)+'</p></div>'});
})();
`;
