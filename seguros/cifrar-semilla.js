'use strict';
/**
 * Genera la semilla CIFRADA de Conecta Seguros (se ejecuta en el ordenador de quien prepara los datos, NO en el servidor).
 *   CLAVE='contraseña inicial' node cifrar-semilla.js datos.json carpeta-pdfs/
 * - datos.json y los PDF NUNCA se suben al repositorio: solo los .enc que crea este script.
 * - Mantiene la misma «salt» si ya existe semilla/indice.json (así la clave guardada en el servidor sigue valiendo)
 *   y sube el número de versión para que el servidor aplique los cambios.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [, , datos, pdfDir] = process.argv;
const pw = process.env.CLAVE;
if (!pw || !datos) { console.error('Uso: CLAVE=... node cifrar-semilla.js datos.json [carpeta-pdfs]'); process.exit(1); }
const OUT = path.join(__dirname, 'semilla');
fs.mkdirSync(OUT, { recursive: true });
const idxFile = path.join(OUT, 'indice.json');
let idx = { v: 0, salt: crypto.randomBytes(16).toString('base64') };
try { idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')); } catch (e) {}
const key = crypto.scryptSync(pw, Buffer.from(idx.salt, 'base64'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
function enc(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), out]);
}
// comprobación: si ya había semilla, la clave tiene que abrirla
const prev = path.join(OUT, 'datos.enc');
if (fs.existsSync(prev)) {
  const b = fs.readFileSync(prev);
  try { const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); d.update(b.subarray(28)); d.final(); }
  catch (e) { console.error('Esa CLAVE no abre la semilla actual. Usa la contraseña inicial.'); process.exit(1); }
}
const json = JSON.parse(fs.readFileSync(datos, 'utf8'));
fs.writeFileSync(prev, enc(Buffer.from(JSON.stringify(json))));
if (pdfDir) for (const f of fs.readdirSync(pdfDir)) {
  if (!/^[a-z0-9-]{1,60}\.pdf$/.test(f)) continue;
  fs.writeFileSync(path.join(OUT, f + '.enc'), enc(fs.readFileSync(path.join(pdfDir, f))));
}
idx.v = (idx.v || 0) + 1;
fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2) + '\n');
console.log(`Semilla cifrada · versión ${idx.v} · ${json.polizas.length} pólizas`);
