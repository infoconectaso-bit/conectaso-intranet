'use strict';
/**
 * Envío de correo opcional por SMTP, implementado sobre los módulos de red de Node (sin dependencias externas).
 * Variables: SMTP_HOST, SMTP_PORT (465 TLS directo, 587 STARTTLS), SMTP_USER, SMTP_PASS, MAIL_FROM.
 * Si no hay SMTP configurado, enabled() devuelve false y la aplicación muestra el enlace al administrador.
 */
const net = require('net');
const tls = require('tls');
const https = require('https');

// Configuración guardada desde el panel de admin (si existe); si no, se usa el .env.
function saved() {
  try { return require('./db').store.setting('mailConfig') || {}; } catch (e) { return {}; }
}
function cfg() {
  const s = saved();
  return {
    host: s.host || process.env.SMTP_HOST,
    port: +(s.port || process.env.SMTP_PORT || 587),
    user: s.user || process.env.SMTP_USER,
    pass: s.pass || process.env.SMTP_PASS,
    from: s.from || process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@conectaso.es',
    fromName: s.fromName || 'Conecta Só',
    // Clave API de Brevo (v3): si está, se envía por HTTPS (puerto 443) en vez de SMTP.
    // Útil cuando el servidor tiene bloqueados los puertos de correo salientes.
    apiKey: s.apiKey || process.env.BREVO_API_KEY,
  };
}
// Envío por la API HTTP de Brevo (https://api.brevo.com/v3/smtp/email). Puerto 443.
function sendViaBrevoApi(c, { to, subject, text, html, attachments }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      sender: { email: c.from, name: c.fromName || 'Conecta Só' },
      to: [{ email: to }],
      subject,
      htmlContent: html || ('<pre>' + (text || '') + '</pre>'),
      textContent: text || '',
      ...(attachments && attachments.length ? { attachment: attachments.map(a => ({ name: a.name, content: Buffer.from(a.content).toString('base64') })) } : {}),
    });
    const req = https.request('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': c.apiKey, 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: 20000,
    }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300) ? resolve({ ok: true }) : reject(new Error('Brevo API ' + res.statusCode + ': ' + b.slice(0, 200))));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera de la API agotado')));
    req.write(payload); req.end();
  });
}
// Lista blanca de destinatarios (red de seguridad): del panel o del .env.
function allowlist() {
  const s = saved();
  const raw = (s.allowlist != null && s.allowlist !== '') ? s.allowlist : process.env.MAIL_ALLOWLIST;
  return String(raw || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}
// INTERRUPTOR DE SEGURIDAD: por defecto el correo está DESACTIVADO. Se activa desde el panel
// (mailConfig.enabled) o, si no hay config guardada, con MAIL_DISABLED=false en el .env.
function isDisabled() {
  const s = saved();
  if (typeof s.enabled === 'boolean') return !s.enabled;
  return process.env.MAIL_DISABLED !== 'false';
}
const enabled = () => { const c = cfg(); return !isDisabled() && !!(c.host || c.apiKey); };
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const encHeader = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

/** Conversa con el servidor SMTP paso a paso. Resuelve al aceptarse el mensaje. */
function sendMail({ to, subject, text, html, attachments }) {   // attachments: [{ name, content: Buffer, type }]
  if (isDisabled()) { console.log('[CORREO DESACTIVADO] NO se envía →', to, '·', subject); return Promise.resolve({ disabled: true }); }
  // RED DE SEGURIDAD: si hay lista blanca, SOLO se envía a esas direcciones; cualquier otra
  // (p. ej. un cliente real) se bloquea. Imprescindible en un servidor de pruebas con datos reales.
  const allow = allowlist();
  if (allow.length && allow.indexOf(String(to).trim().toLowerCase()) < 0) {
    console.log('[CORREO BLOQUEADO · fuera de MAIL_ALLOWLIST] NO se envía →', to, '·', subject);
    return Promise.resolve({ skipped: true });
  }
  const c = cfg();
  // Si hay clave API de Brevo, se envía por HTTPS (evita el bloqueo de puertos SMTP del servidor).
  if (c.apiKey) return sendViaBrevoApi(c, { to, subject, text, html, attachments });
  if (!c.host) return Promise.reject(new Error('SMTP no configurado'));
  const b64body = s => b64(s).replace(/(.{76})/g, '$1\r\n');
  const head = [
    `From: ${encHeader('Conecta So')} <${c.from}>`,
    `To: ${to}`,
    `Subject: ${encHeader(subject)}`,
    'MIME-Version: 1.0',
  ];
  let lines;
  if (html) {
    // multipart/alternative: el cliente muestra el HTML y, si no puede, el texto plano.
    const bnd = 'cs_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    lines = head.concat([
      `Content-Type: multipart/alternative; boundary="${bnd}"`, '',
      `--${bnd}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64body(text || ''),
      `--${bnd}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64body(html),
      `--${bnd}--`,
    ]).join('\r\n');
    // Con adjuntos: multipart/mixed que envuelve el cuerpo (texto + HTML) y los ficheros.
    if (attachments && attachments.length) {
      const mx = 'csm_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      const body = lines.split('\r\n').slice(head.length).join('\r\n');
      lines = head.concat([`Content-Type: multipart/mixed; boundary="${mx}"`, '', `--${mx}`, body]
        .concat(...attachments.map(a => [`--${mx}`, `Content-Type: ${a.type || 'application/octet-stream'}; name="${a.name}"`, 'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${a.name}"`, '', Buffer.from(a.content).toString('base64').replace(/(.{76})/g, '$1\r\n')]))
        .concat([`--${mx}--`])).join('\r\n');
    }
  } else {
    lines = head.concat(['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64body(text || '')]).join('\r\n');
  }

  return new Promise((resolve, reject) => {
    let sock = c.port === 465 ? tls.connect(c.port, c.host, { servername: c.host }) : net.connect(c.port, c.host);
    let buf = '';
    let queue = [];
    let settled = false;
    const finish = (err) => { if (settled) return; settled = true; try { sock.end(); } catch (e) {} err ? reject(err) : resolve(); };
    const timer = setTimeout(() => finish(new Error('Tiempo de espera SMTP agotado')), 20000);

    const send = s => sock.write(s + '\r\n');
    const expect = (code, cb) => queue.push({ code, cb });
    const upgradeTls = () => {
      sock.removeAllListeners('data');
      const s2 = tls.connect({ socket: sock, servername: c.host }, () => runStart());
      s2.on('data', onData); s2.on('error', finish); sock = s2;
    };
    const runStart = () => {
      send(`EHLO conectaso`);
      expect(250, () => { if (c.user) send(`AUTH LOGIN`), expect(334, () => { send(b64(c.user)); expect(334, () => { send(b64(c.pass)); expect(235, mailFrom); }); }); else mailFrom(); });
    };
    const mailFrom = () => { send(`MAIL FROM:<${c.from}>`); expect(250, () => { send(`RCPT TO:<${to}>`); expect(250, () => { send('DATA'); expect(354, () => { sock.write(lines + '\r\n.\r\n'); expect(250, () => { send('QUIT'); clearTimeout(timer); finish(); }); }); }); }); };

    function onData(chunk) {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (/^\d{3}-/.test(line)) continue; // respuesta multilínea, esperar la última
        const code = +line.slice(0, 3);
        const step = queue.shift();
        if (!step) {
          if (c.port !== 465 && /STARTTLS/i.test(line)) continue;
          continue;
        }
        if (code !== step.code) return finish(new Error('SMTP ' + line));
        step.cb();
      }
    }
    sock.on('data', onData);
    sock.on('error', finish);
    sock.once('connect', () => {});
    // Primer saludo del servidor
    if (c.port === 465) { expect(220, () => runStart()); }
    else {
      expect(220, () => { send('EHLO conectaso'); expect(250, () => { send('STARTTLS'); expect(220, upgradeTls); }); });
    }
  });
}

module.exports = { enabled, sendMail, cfg };
