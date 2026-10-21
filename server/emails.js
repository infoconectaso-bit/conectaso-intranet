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

module.exports = { inviteEmail, resetEmail, shell, inviteCopy };
