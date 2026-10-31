'use strict';
/**
 * Email "cartel de neón" para la factura de reserva (mismo estilo que la página de reserva).
 * HTML de email: tablas + estilos en línea. El neón (Yellowtail + brillo) se ve completo en
 * Apple Mail / iPhone; en Gmail se ve el mismo diseño en rosa sin el brillo (degrada bien).
 */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WEB = 'https://www.conectaso.es', IG = 'https://www.instagram.com/conecta.so/', TEL = '674 758 989';

function neonInvoiceEmail({ first, pack, extras = [], fecha, lugar, total, base, link, logoUrl, number, facturaUrl, payUrl }) {
  const F = "font-family:'Outfit',Helvetica,Arial,sans-serif";
  const chips = extras.map(x => `<span style="display:inline-block;margin:4px 3px;padding:6px 13px;border:1px solid #5FC9D6;border-radius:999px;color:#BFF4FA;font-size:14px;font-weight:600;${F}">+ ${esc(x)}</span>`).join('');
  const btn = (href, label, primary) => primary
    ? `<a href="${esc(href)}" style="display:block;max-width:340px;margin:0 auto;background:#E82C88;color:#ffffff;text-decoration:none;font-size:17px;font-weight:700;padding:17px 20px;border-radius:16px;box-shadow:0 0 24px rgba(232,44,136,.55);text-align:center;${F}">${label}</a>`
    : `<a href="${esc(href)}" style="display:block;max-width:340px;margin:12px auto 0;background:transparent;color:#BFF4FA;text-decoration:none;font-size:16px;font-weight:700;padding:15px 20px;border:1px solid #5FC9D6;border-radius:16px;box-shadow:0 0 14px rgba(49,185,203,.30);text-align:center;${F}">${label}</a>`;
  const dl = facturaUrl || link;
  const ctas = payUrl
    ? btn(payUrl, 'Pagar aquí · ' + esc(total), true) + btn(dl, 'Descargar factura', false)
    : btn(dl, 'Descargar factura', true) + btn(link, 'Ver mi reserva', false);
  const howTo = payUrl ? 'Por transferencia<br>o con tarjeta,<br>como prefiráis' : 'El número de cuenta<br>para la transferencia<br>está al pie de la factura';
  const row = (k, v) => `<tr><td style="padding:11px 0;border-bottom:1px solid #2E2233;color:#A99AAE;font-size:15px;${F}">${esc(k)}</td><td align="right" style="padding:11px 0;border-bottom:1px solid #2E2233;color:#F4EEF6;font-size:15px;font-weight:600;${F}">${esc(v)}</td></tr>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light">
<link href="https://fonts.googleapis.com/css2?family=Yellowtail&family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
<title>Vuestra factura de reserva</title></head>
<body style="margin:0;padding:0;background:#100A12">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">Factura de la paga y señal de vuestra boda: ${esc(total)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#100A12" style="background:#100A12"><tr><td align="center" style="padding:26px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#170E1B;border:1px solid #2A1E2F;border-radius:22px">
  <tr><td align="center" style="padding:30px 24px 6px">${logoUrl ? `<img src="${esc(logoUrl)}" width="150" alt="Conecta So" style="display:block;border:0;max-width:150px;height:auto">` : `<span style="color:#F9F5E1;font-size:24px;font-weight:700;${F}">CONECTA SO</span>`}</td></tr>
  <tr><td align="center" style="padding:22px 24px 4px">
    <div style="color:#7FE7F4;font-size:16px;${F};text-shadow:0 0 6px rgba(127,231,244,.9),0 0 18px rgba(49,185,203,.7)">vuestra factura de reserva</div>
    <div style="font-family:'Yellowtail','Brush Script MT',cursive;font-size:66px;line-height:1.1;color:#FFE3F1;padding:6px 0 10px;text-shadow:0 0 4px #ffffff,0 0 12px #FF5FB0,0 0 28px #E82C88,0 0 56px #E82C88">${esc(/^pack\b/i.test(String(pack || '')) ? pack : 'Pack ' + pack)}</div>
    ${chips ? `<div style="padding:0 0 6px">${chips}</div>` : ''}
  </td></tr>
  <tr><td style="padding:22px 34px 4px;color:#E9E1EC;font-size:16px;line-height:1.6;${F}">
    <p style="margin:0 0 12px">¡Hola${first ? ' ' + esc(first) : ''}!</p>
    <p style="margin:0">Os adjuntamos la factura de la paga y señal de vuestra boda con Conecta So. Con este pago vuestra fecha queda bloqueada.</p>
  </td></tr>
  <tr><td style="padding:22px 34px 6px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#20152A;border:1px solid #3A2A44;border-radius:16px"><tr>
      <td style="padding:18px 20px;${F}"><div style="color:#A99AAE;font-size:14px">Paga y señal</div><div style="color:#F4EEF6;font-size:40px;font-weight:700;line-height:1.1">${esc(total)}</div><div style="color:#A99AAE;font-size:13px">${esc(base)} + IVA (10 %)</div></td>
      <td align="right" style="padding:18px 20px;color:#CFC4D3;font-size:14px;line-height:1.45;${F}">${howTo}</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:14px 34px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${row('Fecha', fecha)}${row('Lugar', lugar)}${number ? row('Factura', number) : ''}</table></td></tr>
  <tr><td align="center" style="padding:28px 34px 8px">
    ${ctas}
    <div style="color:#A99AAE;font-size:13px;line-height:1.6;padding-top:14px;${F}">${payUrl ? 'En «Pagar aquí» elegís transferencia (con los datos para copiar) o tarjeta.<br>' : ''}La factura también va adjunta en este email.</div>
  </td></tr>
  <tr><td align="center" style="padding:26px 34px 30px;border-top:1px solid #2A1E2F;color:#8E8194;font-size:13px;line-height:1.7;${F}">
    ¿Alguna duda? Escribidnos por WhatsApp al ${TEL} o respondiendo a este email.<br>
    <a href="${WEB}" style="color:#BFF4FA;text-decoration:none">conectaso.es</a> &nbsp; <a href="${IG}" style="color:#BFF4FA;text-decoration:none">@conecta.so</a>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
module.exports = { neonInvoiceEmail };
