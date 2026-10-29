'use strict';
/**
 * Generación de PDF de la hoja de ruta con Chromium headless (CLI, sin dependencias npm).
 * Chromium carga el propio SPA en localhost, autenticado por un token de sesión efímero que se le
 * pasa por ?pdftoken, espera a que el deck se dibuje (virtual-time-budget) e imprime a PDF.
 * El CSS @media print ya maqueta cada folio como una página horizontal.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');

// Binario de Chromium: en la imagen Alpine es /usr/bin/chromium-browser.
function chromiumBin() {
  if (process.env.CHROMIUM_BIN && fs.existsSync(process.env.CHROMIUM_BIN)) return process.env.CHROMIUM_BIN;
  for (const p of ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chrome']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function available() { return !!chromiumBin(); }

/**
 * Renderiza la hoja de ruta del evento `id` a PDF (Buffer). `userId` = admin/dj que la descarga.
 * ASÍNCRONO: Chromium necesita que este mismo servidor conteste sus peticiones mientras renderiza,
 * así que NO se puede bloquear el event loop. Devuelve una promesa.
 */
function renderRoutePdf(route, userId) {
  return new Promise((resolve, reject) => {
    const bin = chromiumBin();
    if (!bin) return reject(new Error('Generador de PDF no disponible en este servidor.'));
    const port = process.env.PORT || 3000;
    const token = auth.mintSession(userId, 120000);           // sesión efímera (2 min)
    const outFile = path.join(os.tmpdir(), 'pdf-' + crypto.randomBytes(5).toString('hex') + '.pdf');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
    const hash = route.charAt(0) === '#' ? route : ('#' + route);
    const url = 'http://127.0.0.1:' + port + '/?pdftoken=' + encodeURIComponent(token) + hash;
    const args = [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-software-rasterizer', '--hide-scrollbars', '--force-color-profile=srgb',
      // Ventana ANCHA: si no, la barra lateral encoge el deck y fitDeck lo escala (sale pequeño con
      // mucho blanco). Con 1800px de ancho el deck se dibuja a tamaño real (1280px, zoom 1).
      '--window-size=1800,1100', '--force-device-scale-factor=1',
      '--run-all-compositor-stages-before-draw', '--virtual-time-budget=12000',
      '--no-pdf-header-footer', '--user-data-dir=' + profile,
      '--print-to-pdf=' + outFile, url,
    ];
    let stderr = '', done = false;
    const cleanup = () => { auth.dropSession(token); try { fs.unlinkSync(outFile); } catch (e) {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} };
    const finish = (err, buf) => { if (done) return; done = true; clearTimeout(killer); cleanup(); err ? reject(err) : resolve(buf); };
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} finish(new Error('Tiempo de espera agotado generando el PDF.')); }, 45000);
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.on('error', e => finish(new Error('No se pudo iniciar Chromium: ' + e.message)));
    child.on('exit', (code) => {
      try {
        if (!fs.existsSync(outFile)) return finish(new Error('Chromium no generó el PDF (code ' + code + '). ' + stderr.slice(-200)));
        const buf = fs.readFileSync(outFile);
        if (!buf || buf.length < 1000) return finish(new Error('El PDF salió vacío.'));
        finish(null, buf);
      } catch (e) { finish(e); }
    });
  });
}

// Atajos por tipo de documento.
function renderRutaPdf(id, userId) { return renderRoutePdf('/eventos/' + id + '/ruta-doc', userId); }
function renderBodaPdf(id, userId) { return renderRoutePdf('/eventos/' + id + '/pdf', userId); }

module.exports = { renderRoutePdf, renderRutaPdf, renderBodaPdf, available, chromiumBin };
