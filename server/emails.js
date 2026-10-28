'use strict';
/**
 * Plantillas HTML de los correos de Conecta So (invitación por rol y restablecer contraseña).
 * Email-safe: tablas + estilos en línea. El logo se sirve desde el propio servidor (APP_URL).
 */
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const INK = '#130F17', CREAM = '#F9F5E1', PINK = '#E82C88', MUTED = '#6a6472', LINE = '#e8e2d4';
const WEB = 'https://conectaso.es', IG = 'https://www.instagram.com/conecta.so/', TEL = '674 758 989';

// Envoltorio con marca. logoUrl puede ir vacío: entonces se muestra el nombre como texto.
function shell({ logoUrl, title, lead, bodyHtml, cta, link, foot }) {
  const logo = logoUrl
    ? `<img src="${esc(logoUrl)}" width="190" alt="Conecta So" style="display:block;margin:0 auto;border:0;outline:none;max-width:190px;height:auto">`
    : `<div style="font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:bold;letter-spacing:1px;color:#ffffff">CONECTA SÓ</div>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${CREAM};-webkit-text-size-adjust:100%">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(lead || '')}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM}"><tr><td align="center" style="padding:28px 14px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${LINE};border-radius:16px;overflow:hidden">
    <tr><td align="center" style="background:${INK};padding:34px 30px">${logo}</td></tr>
    <tr><td style="padding:36px 36px 8px 36px">
      <h1 style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:23px;line-height:1.25;color:${INK}">${title}</h1>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#39333f">${bodyHtml}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px 0"><tr><td align="center" bgcolor="${PINK}" style="border-radius:10px">
        <a href="${esc(link)}" style="display:inline-block;padding:15px 30px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:10px">${cta}</a>
      </td></tr></table>
      <p style="margin:18px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;line-height:1.6;color:${MUTED}">${foot}<br>Si el botón no funciona, copia y pega este enlace:<br><a href="${esc(link)}" style="color:${PINK};word-break:break-all">${esc(link)}</a></p>
    </td></tr>
    <tr><td style="padding:22px 36px 30px 36px;border-top:1px solid ${LINE}">
      <p style="margin:0 0 4px 0;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;color:${INK};font-weight:bold">Conecta Só</p>
      <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.7;color:${MUTED}">DJs, sonido e iluminación para bodas y eventos<br>
        🌐 <a href="${WEB}" style="color:${MUTED}">conectaso.es</a> &nbsp;·&nbsp; 📸 <a href="${IG}" style="color:${MUTED}">@conecta.so</a> &nbsp;·&nbsp; 📞 ${TEL}</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

// Textos por rol para la invitación (crear contraseña la primera vez).
function inviteCopy(role, name) {
  const hi = name ? esc(name) : '';
  if (role === 'user') return {
    subject: 'Bienvenidos a vuestro espacio · Conecta Só',
    title: `¡Bienvenidos a vuestro espacio! 💛`,
    lead: 'Crea tu contraseña y entra a preparar la música de tu boda.',
    body: `<p style="margin:0 0 14px 0">¡Hola${hi ? ' ' + hi : ''}! 🎉</p>
<p style="margin:0 0 14px 0">Enhorabuena, ¡ya empieza la cuenta atrás! Os hemos creado <b>vuestro espacio en Conecta Só</b>, donde prepararéis con calma toda la música y los detalles de vuestro gran día: ceremonia, aperitivo, banquete y fiesta.</p>
<p style="margin:0">Para empezar, solo tenéis que crear vuestra contraseña:</p>`,
    cta: 'Crear mi contraseña',
    foot: 'Este enlace caduca en 14 días.',
  };
  if (role === 'planner') return {
    subject: 'Tu acceso de wedding planner · Conecta Só',
    title: 'Tu acceso como wedding planner',
    lead: 'Crea tu contraseña para gestionar tus bodas con Conecta Só.',
    body: `<p style="margin:0 0 14px 0">Hola${hi ? ' ' + hi : ''},</p>
<p style="margin:0 0 14px 0">Te damos acceso al <b>gestor de Conecta Só</b> para coordinar con nosotros las bodas que lleváis: música, servicios, horarios y los detalles de cada evento.</p>
<p style="margin:0">Crea tu contraseña para entrar:</p>`,
    cta: 'Crear mi contraseña',
    foot: 'Este enlace caduca en 14 días.',
  };
  // dj y admin comparten el mismo texto (equipo Conecta Só)
  return {
    subject: 'Tu acceso al gestor · Conecta Só',
    title: 'Tu acceso al gestor de Conecta Só',
    lead: 'Crea tu contraseña para entrar al gestor de Conecta Só.',
    body: `<p style="margin:0 0 14px 0">Hola${hi ? ' ' + hi : ''},</p>
<p style="margin:0 0 14px 0">Ya tienes acceso al <b>gestor de Conecta Só</b>: eventos, hojas de ruta, fichajes, vehículos, mantenimiento y tu facturación, todo en un mismo sitio.</p>
<p style="margin:0">Crea tu contraseña para empezar:</p>`,
    cta: 'Crear mi contraseña',
    foot: 'Este enlace caduca en 14 días.',
  };
}

function plainFromCopy(c, link) {
  return `${c.title}\n\n${c.body.replace(/<[^>]+>/g, '').replace(/\n{2,}/g, '\n\n').trim()}\n\n${c.cta}: ${link}\n\n${c.foot}\n\n— Conecta Só · conectaso.es`;
}

function inviteEmail(u, link, baseUrl) {
  const logoUrl = baseUrl ? baseUrl.replace(/\/$/, '') + '/assets/brand/logo-email-blanco.png' : '';
  const c = inviteCopy(u.role, u.name);
  return { subject: c.subject, text: plainFromCopy(c, link), html: shell({ logoUrl, title: c.title, lead: c.lead, bodyHtml: c.body, cta: c.cta, link, foot: c.foot }) };
}

function resetEmail(u, link, baseUrl) {
  const logoUrl = baseUrl ? baseUrl.replace(/\/$/, '') + '/assets/brand/logo-email-blanco.png' : '';
  const c = {
    subject: 'Restablece tu contraseña · Conecta Só',
    title: 'Restablece tu contraseña',
    lead: 'Crea una nueva contraseña para tu cuenta de Conecta Só.',
    body: `<p style="margin:0 0 14px 0">Hola${u.name ? ' ' + esc(u.name) : ''},</p>
<p style="margin:0 0 14px 0">Hemos recibido una solicitud para restablecer la contraseña de tu cuenta de Conecta Só. Pulsa el botón para crear una nueva:</p>`,
    cta: 'Crear nueva contraseña',
    foot: 'El enlace caduca en 24 horas. Si no has sido tú, puedes ignorar este mensaje con tranquilidad.',
  };
  return { subject: c.subject, text: plainFromCopy(c, link), html: shell({ logoUrl, title: c.title, lead: c.lead, bodyHtml: c.body, cta: c.cta, link, foot: c.foot }) };
}

const slashDate = f => { const p = String(f || '').slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : (f || ''); };

// Recordatorio a los novios 15 días antes de la boda.
function coupleReminderEmail(ev, link, baseUrl) {
  const logoUrl = baseUrl ? baseUrl.replace(/\/$/, '') + '/assets/brand/logo-email-blanco.png' : '';
  const c = {
    subject: 'Faltan 15 días para vuestra boda 💍 · Conecta Só',
    title: '¡Ya queda nada! 💍',
    lead: 'Repasad que tenéis todo listo para vuestra boda.',
    body: `<p style="margin:0 0 14px 0">¡Hola ${esc(ev.conyuges || 'pareja')}!</p>
<p style="margin:0 0 14px 0">Faltan <b>15 días</b> para vuestra boda del <b>${slashDate(ev.fecha)}</b> 🎉 Es buen momento para repasar que lo tenéis todo a punto en vuestro espacio: la <b>música</b> de cada momento, vuestros datos y los detalles.</p>
<p style="margin:0">Si queréis cambiar algo, aún estáis a tiempo:</p>`,
    cta: 'Entrar en mi boda',
    foot: 'Entrad cuando queráis con vuestro email y contraseña.',
  };
  return { subject: c.subject, text: plainFromCopy(c, link), html: shell({ logoUrl, title: c.title, lead: c.lead, bodyHtml: c.body, cta: c.cta, link, foot: c.foot }) };
}

// Recordatorio a los novios 7 días antes si la música no está completa.
function coupleMusicEmail(ev, link, baseUrl) {
  const logoUrl = baseUrl ? baseUrl.replace(/\/$/, '') + '/assets/brand/logo-email-blanco.png' : '';
  const c = {
    subject: 'Os falta un poco de música para vuestra boda 🎵 · Conecta Só',
    title: 'Os falta un poco de música 🎵',
    lead: 'Completad la música antes de que se cierre la edición.',
    body: `<p style="margin:0 0 14px 0">¡Hola ${esc(ev.conyuges || 'pareja')}!</p>
<p style="margin:0 0 14px 0">Faltan <b>7 días</b> para vuestra boda del <b>${slashDate(ev.fecha)}</b> y hemos visto que aún tenéis <b>algunos momentos musicales sin canción</b>. Para que vuestro DJ lo prepare todo perfecto, entrad y completad la música (ceremonia, aperitivo, banquete y fiesta).</p>
<p style="margin:0">Es rápido y marca la diferencia:</p>`,
    cta: 'Completar mi música',
    foot: 'La edición se cierra unos días antes de la boda, así que mejor no dejarlo para el final 🙂',
  };
  return { subject: c.subject, text: plainFromCopy(c, link), html: shell({ logoUrl, title: c.title, lead: c.lead, bodyHtml: c.body, cta: c.cta, link, foot: c.foot }) };
}

// Aviso al DJ: falta ≤1 mes para la boda y NO consta el "Meeting realizado". Se repite a diario
// hasta que el DJ cambie el estado. 'dias' = días que faltan para la boda.
function djMeetingEmail(u, ev, link, baseUrl, dias) {
  const logoUrl = baseUrl ? baseUrl.replace(/\/$/, '') + '/assets/brand/logo-email-blanco.png' : '';
  const cuando = dias <= 0 ? '<b>hoy</b>' : (dias === 1 ? '<b>mañana</b>' : `en <b>${dias} días</b>`);
  const c = {
    subject: '⚠️ Aún no has hecho el meeting · Boda #' + ev.id + ' · Conecta Só',
    title: '⚠️ Te falta el meeting con los novios',
    lead: 'La boda se acerca y no consta el meeting como realizado.',
    body: `<p style="margin:0 0 14px 0">Hola${u.name ? ' ' + esc(u.name) : ''},</p>
<p style="margin:0 0 14px 0">La boda <b>${esc(ev.conyuges || ('#' + ev.id))}</b> es ${cuando} (<b>${slashDate(ev.fecha)}</b>) y <b>todavía no has marcado el meeting como realizado</b>.</p>
<p style="margin:0 0 14px 0">Por favor, haz el meeting con los novios y <b>actualiza el estado de la boda a "Meeting realizado"</b>. Mientras no lo cambies, seguirás recibiendo este aviso cada día.</p>
<p style="margin:0">Entra aquí para gestionarlo:</p>`,
    cta: 'Ver la boda',
    foot: 'Recibes este recordatorio porque eres el DJ asignado a esta boda.',
  };
  return { subject: c.subject, text: plainFromCopy(c, link), html: shell({ logoUrl, title: c.title, lead: c.lead, bodyHtml: c.body, cta: c.cta, link, foot: c.foot }) };
}

// Aviso al DJ/técnico cuando la boda ha finalizado, para rellenar su parte de trabajo.
function djAlbaranEmail(u, ev, link, baseUrl) {
  const logoUrl = baseUrl ? baseUrl.replace(/\/$/, '') + '/assets/brand/logo-email-blanco.png' : '';
  const c = {
    subject: 'Rellena tu parte de trabajo · Boda #' + ev.id + ' · Conecta Só',
    title: '¿Cómo fue la boda? Rellena tu parte',
    lead: 'Indica horas extra, opinión y observaciones del evento.',
    body: `<p style="margin:0 0 14px 0">Hola${u.name ? ' ' + esc(u.name) : ''},</p>
<p style="margin:0 0 14px 0">La boda <b>${esc(ev.conyuges || ('#' + ev.id))}</b> del <b>${slashDate(ev.fecha)}</b> ya ha finalizado. Entra para rellenar tu <b>albarán de trabajo</b>:</p>
<p style="margin:0 0 14px 0">• Las <b>horas extra</b> realizadas<br>• Si hay que <b>pedir opinión</b> a los novios<br>• Tus <b>observaciones</b> del evento</p>
<p style="margin:0">Con rellenarlo nos ayudas a cerrar el evento y tu cobro:</p>`,
    cta: 'Rellenar mi parte',
    foot: 'Entra con tu email y contraseña, en la pestaña Servicios del evento.',
  };
  return { subject: c.subject, text: plainFromCopy(c, link), html: shell({ logoUrl, title: c.title, lead: c.lead, bodyHtml: c.body, cta: c.cta, link, foot: c.foot }) };
}

// Aviso a facturación cuando una boda solicita uno o más servicios extra.
// `items` = lista de nombres de los extras pedidos; `finca` = nombre del lugar.
function extraRequestEmail(ev, items, finca, link, baseUrl) {
  const logoUrl = baseUrl ? baseUrl.replace(/\/$/, '') + '/assets/brand/logo-email-blanco.png' : '';
  const list = (items || []).map(x => esc(x));
  const chips = list.map(n => `<tr><td style="padding:10px 14px;border:1px solid #f0d7e7;border-radius:10px;background:#fdf2f8;font-family:Arial,Helvetica,sans-serif;font-size:14.5px;color:#9d1b5f;font-weight:bold">✨ ${n}</td></tr><tr><td style="height:8px;line-height:8px">&nbsp;</td></tr>`).join('');
  const boda = esc(ev.conyuges ? ev.conyuges + ' · #' + ev.id : ('#' + ev.id));
  const body = `<p style="margin:0 0 14px 0">La boda <b>${boda}</b> acaba de solicitar ${list.length > 1 ? '<b>estos servicios extra</b>' : '<b>un servicio extra</b>'}:</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 6px 0">${chips}</table>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0 2px 0;border-top:1px solid #ece4f1">
  <tr><td style="padding:12px 0 2px 0;font-family:Arial,Helvetica,sans-serif;font-size:13.5px;color:#6b6472">📅 Fecha del evento: <b style="color:#39333f">${slashDate(ev.fecha)}</b></td></tr>
  <tr><td style="padding:2px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13.5px;color:#6b6472">📍 Lugar: <b style="color:#39333f">${esc(finca || '—')}</b></td></tr>
</table>
<p style="margin:16px 0 0 0">Entra en <b>Servicios extras</b> para revisar la disponibilidad y continuar con la reserva:</p>`;
  const text = `Nueva solicitud de extra · Boda ${ev.conyuges ? ev.conyuges + ' (#' + ev.id + ')' : '#' + ev.id}\n\n` +
    `Servicios solicitados:\n${(items || []).map(x => '• ' + x).join('\n')}\n\n` +
    `Fecha del evento: ${slashDate(ev.fecha)}\nLugar: ${finca || '—'}\n\n` +
    `Entra en la intranet (Servicios extras) para revisar la disponibilidad y continuar con la reserva.\n${link}\n\n— Conecta Só · conectaso.es`;
  return {
    subject: `Nueva solicitud de extra · Boda #${ev.id}`,
    text,
    html: shell({ logoUrl, title: '✨ Nueva solicitud de extra', lead: `La boda #${ev.id} ha pedido un servicio extra`, bodyHtml: body, cta: 'Revisar la solicitud', link, foot: 'Entra con tu cuenta de administración.' }),
  };
}

// --- Fotos del fotomatón listas (solo enlace de descarga; SIN reseña de Google) ---
function coupleFotosEmail(ev, link, baseUrl, fincaName) {
  const logoUrl = baseUrl ? baseUrl.replace(/\/$/, '') + '/assets/brand/logo-principal-blanco.svg' : '';
  const names = esc(ev.conyuges || 'pareja');
  const fecha = (() => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ev.fecha || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; })();
  const lugar = esc(fincaName || ev.lugarOtro || '');
  const sub = [fecha, lugar].filter(Boolean).join('  ·  ');
  const logo = logoUrl
    ? `<img src="${esc(logoUrl)}" width="180" alt="Conecta So" style="display:block;margin:0 auto;border:0;max-width:180px;height:auto">`
    : `<div style="font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:bold;letter-spacing:1px;color:#fff">CONECTA SÓ</div>`;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${CREAM};-webkit-text-size-adjust:100%">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">¡Vuestras fotos del fotomatón ya están listas para descargar! 📸</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM}"><tr><td align="center" style="padding:30px 14px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#fff;border:1px solid ${LINE};border-radius:18px;overflow:hidden">
    <tr><td align="center" style="background:${INK};padding:30px 30px 26px">${logo}</td></tr>
    <tr><td style="height:5px;background:${PINK};line-height:5px;font-size:0">&nbsp;</td></tr>
    <tr><td align="center" style="padding:36px 36px 6px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" width="76" height="76" style="width:76px;height:76px;background:${PINK};border-radius:50%;font-size:36px;line-height:76px;color:#fff">📸</td></tr></table>
    </td></tr>
    <tr><td align="center" style="padding:20px 36px 0">
      <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:25px;line-height:1.25;color:${INK}">¡Vuestras fotos ya están aquí!</h1>
      <p style="margin:12px 0 2px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-style:italic;color:${PINK}">${names}</p>
      ${sub ? `<p style="margin:2px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;letter-spacing:.4px;color:${MUTED};text-transform:uppercase">${sub}</p>` : ''}
    </td></tr>
    <tr><td style="padding:22px 44px 0">
      <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15.5px;line-height:1.7;color:#39333f;text-align:center">
        Ya podéis descargar <b>todas las fotos del fotomatón</b> de vuestra boda. ¡Teníamos muchas ganas de enseñároslas! Son vuestras para siempre. 💛</p>
    </td></tr>
    <tr><td align="center" style="padding:28px 36px 6px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="${PINK}" style="border-radius:12px">
        <a href="${esc(link)}" style="display:inline-block;padding:17px 38px;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:bold;color:#fff;text-decoration:none;border-radius:12px">📸  Descargar nuestras fotos</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:16px 44px 4px">
      <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;line-height:1.6;color:${MUTED};text-align:center">El enlace estará disponible durante unos meses, así que descargadlas con calma.<br>Si el botón no funciona, copia y pega este enlace:<br><a href="${esc(link)}" style="color:${PINK};word-break:break-all">${esc(link)}</a></p>
    </td></tr>
    <tr><td style="padding:26px 36px 30px;border-top:1px solid ${LINE};margin-top:18px">
      <p style="margin:18px 0 4px 0;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;color:${INK};font-weight:bold;text-align:center">Conecta Só</p>
      <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.7;color:${MUTED};text-align:center">DJs, sonido e iluminación para bodas y eventos<br>
        🌐 <a href="${WEB}" style="color:${MUTED}">conectaso.es</a> &nbsp;·&nbsp; 📸 <a href="${IG}" style="color:${MUTED}">@conecta.so</a> &nbsp;·&nbsp; 📞 ${TEL}</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
  return { subject: '¡Vuestras fotos del fotomatón ya están listas! 📸 · Conecta Só', html, text: `¡Vuestras fotos del fotomatón ya están listas!\n\n${ev.conyuges || ''}${sub ? ' · ' + sub.replace(/·/g, '-') : ''}\n\nDescargadlas aquí: ${link}\n\nConecta Só · conectaso.es` };
}

module.exports = { inviteEmail, resetEmail, coupleReminderEmail, coupleMusicEmail, djMeetingEmail, djAlbaranEmail, extraRequestEmail, coupleFotosEmail, shell, inviteCopy };
