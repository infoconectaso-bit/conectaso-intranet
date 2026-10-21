'use strict';
/**
 * Envío de correo opcional por SMTP, implementado sobre los módulos de red de Node (sin dependencias externas).
 * Variables: SMTP_HOST, SMTP_PORT (465 TLS directo, 587 STARTTLS), SMTP_USER, SMTP_PASS, MAIL_FROM.
 * Si no hay SMTP configurado, enabled() devuelve false y la aplicación muestra el enlace al administrador.
 */
const net = require('net');
const tls = require('tls');

function cfg() {
  return {
    host: process.env.SMTP_HOST,
    port: +(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@conectaso.es',
  };
}
// INTERRUPTOR DE SEGURIDAD: por defecto el correo está DESACTIVADO. No se envía ni un email
// (ni a clientes ni a nadie) salvo que se ponga explícitamente MAIL_DISABLED=false Y haya SMTP.
const MAIL_DISABLED = process.env.MAIL_DISABLED !== 'false';
const enabled = () => !MAIL_DISABLED && !!cfg().host;
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const encHeader = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

/** Conversa con el servidor SMTP paso a paso. Resuelve al aceptarse el mensaje. */
function sendMail({ to, subject, text, html }) {
  if (MAIL_DISABLED) { console.log('[CORREO DESACTIVADO] NO se envía →', to, '·', subject); return Promise.resolve({ disabled: true }); }
  // RED DE SEGURIDAD (entornos de pruebas): si MAIL_ALLOWLIST está definida, SOLO se envía
  // a esas direcciones; cualquier otra (p. ej. un cliente real) se bloquea. Así, en un
  // servidor de pruebas con datos reales, nunca sale un correo a un novio o DJ de verdad.
  const allow = String(process.env.MAIL_ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && allow.indexOf(String(to).trim().toLowerCase()) < 0) {
    console.log('[CORREO BLOQUEADO · fuera de MAIL_ALLOWLIST] NO se envía →', to, '·', subject);
    return Promise.resolve({ skipped: true });
  }
  const c = cfg();
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
