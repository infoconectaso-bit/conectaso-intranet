'use strict';
/**
 * RESTAURACIÓN RÁPIDA (recuperación ante desastre).
 * Se ejecuta en un SERVIDOR NUEVO (no desde dentro de la intranet), para descargar la última copia
 * de seguridad desde Backblaze B2 y dejar los datos listos antes de arrancar la app.
 *
 * Autónomo: solo necesita Node 22 y las claves de Backblaze. NO depende de la base de datos ni del
 * resto de la app (por eso lleva su propia firma S3, copiada de cloud-backup.js).
 *
 * Config por variables de entorno (ver RESTAURAR.md):
 *   B2_ENDPOINT   p.ej. https://s3.eu-central-003.backblazeb2.com
 *   B2_BUCKET     p.ej. conectaso-backups
 *   B2_REGION     p.ej. eu-central-003
 *   B2_KEY_ID     keyID de una clave de Backblaze (basta permiso de LECTURA)
 *   B2_APP_KEY    applicationKey de esa clave
 *   DATA_DIR      carpeta de datos destino (por defecto /data; en local ../data)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_DEST = process.env.DB_PATH || path.join(DATA_DIR, 'conectaso.db');
const UPLOADS = path.join(DATA_DIR, 'uploads');
const PREFIX = 'conectaso/';
const FILES_KEY = 'conectaso-archivos/conectaso-archivos-actual.tar';

const C = {
  endpoint: process.env.B2_ENDPOINT || '', bucket: process.env.B2_BUCKET || '',
  region: (process.env.B2_REGION || '').trim(), keyId: process.env.B2_KEY_ID || '', appKey: process.env.B2_APP_KEY || ''
};
function need() { for (const k of ['endpoint', 'bucket', 'region', 'keyId', 'appKey']) if (!C[k]) { console.error('FALTA la variable B2_' + (k === 'keyId' ? 'KEY_ID' : k === 'appKey' ? 'APP_KEY' : k.toUpperCase()) + '. Revisa RESTAURAR.md.'); process.exit(1); } }

const host = () => String(C.endpoint).replace(/^https?:\/\//, '').replace(/\/+$/, '');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
function enc(s) { return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function amz() { const d = new Date(), p = n => String(n).padStart(2, '0'); const a = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; return { a, day: a.slice(0, 8) }; }

// Petición S3 firmada (SigV4), estilo path. Devuelve { status, buf } (binario) o lanza.
async function s3(method, key, query = {}) {
  const h = host(), payloadHash = sha256(Buffer.alloc(0)), { a, day } = amz();
  const keyPath = key ? '/' + String(key).split('/').map(enc).join('/') : '';
  const canonicalUri = '/' + enc(C.bucket) + keyPath;
  const canonicalQuery = Object.keys(query).sort().map(k => enc(k) + '=' + enc(query[k])).join('&');
  const canonicalHeaders = `host:${h}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${a}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${day}/${C.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${a}\n${scope}\n${sha256(Buffer.from(canonicalRequest))}`;
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + C.appKey, day), C.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const auth = `AWS4-HMAC-SHA256 Credential=${C.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const qs = canonicalQuery ? '?' + canonicalQuery : '';
  const res = await fetch(`https://${h}${canonicalUri}${qs}`, { method, headers: { 'x-amz-date': a, 'x-amz-content-sha256': payloadHash, 'Authorization': auth } });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error('B2 ' + res.status + ': ' + buf.toString('utf8').slice(0, 300).replace(/\s+/g, ' '));
  return { status: res.status, buf };
}

// Lista la carpeta de la base de datos y devuelve la copia .db MÁS RECIENTE (por fecha de subida).
async function newestDb() {
  const { buf } = await s3('GET', '', { 'list-type': '2', 'prefix': PREFIX, 'max-keys': '1000' });
  const xml = buf.toString('utf8');
  let best = null;
  (xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []).forEach(bl => {
    const k = (bl.match(/<Key>([^<]+)<\/Key>/) || [])[1]; if (!k || !/\.db$/.test(k)) return;
    const lm = (bl.match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1] || '';
    if (!best || lm > best.lm) best = { key: k, lm };
  });
  return best;
}

async function main() {
  need();
  console.log('>> Restaurando desde Backblaze (' + C.bucket + ') a ' + DATA_DIR);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS, { recursive: true });

  // 1) Base de datos: la copia más reciente
  const db = await newestDb();
  if (!db) throw new Error('No se encontró ninguna copia de la base de datos en el bucket.');
  console.log('   Base de datos: ' + db.key + '  (' + db.lm + ')');
  const { buf: dbBuf } = await s3('GET', db.key);
  fs.writeFileSync(DB_DEST, dbBuf);
  console.log('   ✅ Base de datos restaurada en ' + DB_DEST + ' (' + (dbBuf.length / 1048576).toFixed(1) + ' MB)');

  // 2) Archivos subidos (nóminas, planos, fotos): el paquete actual (si existe)
  try {
    const { buf: tarBuf } = await s3('GET', FILES_KEY);
    const tmp = path.join(DATA_DIR, '_restore_archivos.tar');
    fs.writeFileSync(tmp, tarBuf);
    execFileSync('tar', ['-xf', tmp, '-C', UPLOADS]);
    fs.unlinkSync(tmp);
    console.log('   ✅ Archivos restaurados en ' + UPLOADS + ' (' + (tarBuf.length / 1048576).toFixed(1) + ' MB)');
  } catch (e) {
    console.warn('   ⚠ No se pudo restaurar el paquete de archivos (' + e.message + '). La base de datos SÍ está restaurada; los archivos se pueden recuperar luego desde Backblaze.');
  }

  console.log('\n>> LISTO. Ahora arranca la intranet con:  bash ACTUALIZAR.sh');
}
main().catch(e => { console.error('\n❌ ERROR en la restauración:', e.message); process.exit(1); });
