'use strict';
/**
 * WebAuthn / passkeys (Face ID / Touch ID) — verificación en Node PURO (solo 'crypto').
 * Sin librerías externas, igual que el resto de la intranet.
 *
 * Soporta las passkeys de plataforma (iPhone/Mac/Android): algoritmos ES256 (P-256) y RS256.
 * La CONTRASEÑA sigue funcionando como respaldo; esto es un método de acceso ADICIONAL.
 *
 * Seguridad: en cada acceso se comprueba la FIRMA contra la clave pública guardada, que el
 * CHALLENGE coincide (un solo uso), el ORIGEN, el rpIdHash, y que hubo verificación de usuario (UV).
 */
const crypto = require('crypto');

// --- base64url ---
const b64u = {
  enc: buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
};

// --- Decodificador CBOR mínimo (uint, negint, bytes, texto, array, mapa, bool/null) ---
function cborDecode(buf) {
  let o = 0;
  function readLen(ai) {
    if (ai < 24) return ai;
    if (ai === 24) return buf[o++];
    if (ai === 25) { const v = buf.readUInt16BE(o); o += 2; return v; }
    if (ai === 26) { const v = buf.readUInt32BE(o); o += 4; return v; }
    if (ai === 27) { const v = Number(buf.readBigUInt64BE(o)); o += 8; return v; }
    throw new Error('CBOR longitud no soportada (ai=' + ai + ')');
  }
  function read() {
    const ib = buf[o++]; const mt = ib >> 5; const ai = ib & 0x1f;
    if (mt === 7) { if (ai === 20) return false; if (ai === 21) return true; if (ai === 22) return null; if (ai === 23) return undefined; throw new Error('CBOR simple/float no soportado'); }
    const len = readLen(ai);
    switch (mt) {
      case 0: return len;                 // entero positivo
      case 1: return -1 - len;            // entero negativo
      case 2: { const b = buf.subarray(o, o + len); o += len; return b; }                 // bytes
      case 3: { const s = buf.toString('utf8', o, o + len); o += len; return s; }         // texto
      case 4: { const a = []; for (let i = 0; i < len; i++) a.push(read()); return a; }    // array
      case 5: { const m = new Map(); for (let i = 0; i < len; i++) { const k = read(); m.set(k, read()); } return m; } // mapa
      default: throw new Error('CBOR tipo mayor no soportado (mt=' + mt + ')');
    }
  }
  const value = read();
  return { value, bytesRead: o };
}

// --- authenticatorData: rpIdHash(32) + flags(1) + signCount(4) [+ attestedCredentialData] ---
function parseAuthData(ad) {
  if (ad.length < 37) throw new Error('authenticatorData demasiado corto');
  const flags = ad[32];
  const out = {
    rpIdHash: ad.subarray(0, 32), flags,
    up: !!(flags & 0x01), uv: !!(flags & 0x04), at: !!(flags & 0x40),
    signCount: ad.readUInt32BE(33)
  };
  let o = 37;
  if (out.at) {
    out.aaguid = ad.subarray(o, o + 16); o += 16;
    const credIdLen = ad.readUInt16BE(o); o += 2;
    out.credentialId = ad.subarray(o, o + credIdLen); o += credIdLen;
    const { value: cose, bytesRead } = cborDecode(ad.subarray(o));
    out.coseKey = cose; o += bytesRead;
  }
  return out;
}

// --- Clave COSE -> JWK pública (serializable) ---
function coseToJwk(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2) {                         // EC2
    const crv = cose.get(-1), x = cose.get(-2), y = cose.get(-3);
    if (crv !== 1) throw new Error('curva EC no soportada (solo P-256)');
    return { jwk: { kty: 'EC', crv: 'P-256', x: b64u.enc(x), y: b64u.enc(y) }, alg: alg || -7 };
  }
  if (kty === 3) {                         // RSA
    const n = cose.get(-1), e = cose.get(-2);
    return { jwk: { kty: 'RSA', n: b64u.enc(n), e: b64u.enc(e) }, alg: alg || -257 };
  }
  throw new Error('tipo de clave COSE no soportado (kty=' + kty + ')');
}

// --- Verificación del REGISTRO (alta de la passkey) ---
function verifyRegistration({ attestationObject, clientDataJSON, expectedChallenge, expectedOrigins, rpId }) {
  const cd = JSON.parse(Buffer.from(clientDataJSON).toString('utf8'));
  if (cd.type !== 'webauthn.create') throw new Error('tipo de clientData incorrecto');
  if (cd.challenge !== expectedChallenge) throw new Error('el challenge no coincide');
  if (!expectedOrigins.includes(cd.origin)) throw new Error('origen no permitido: ' + cd.origin);
  const { value: att } = cborDecode(Buffer.from(attestationObject));
  const authData = att.get('authData');
  const p = parseAuthData(authData);
  if (!p.rpIdHash.equals(crypto.createHash('sha256').update(rpId).digest())) throw new Error('rpIdHash no coincide');
  if (!p.up) throw new Error('sin presencia de usuario');
  if (!p.uv) throw new Error('sin verificación de usuario (Face ID / código)');
  if (!p.coseKey) throw new Error('authData sin clave pública');
  const { jwk, alg } = coseToJwk(p.coseKey);
  // Validamos que la clave se puede importar (si no, createPublicKey lanza)
  crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return { credentialId: b64u.enc(p.credentialId), publicKeyJwk: jwk, alg, signCount: p.signCount };
}

// --- Verificación del ACCESO (login con la passkey) ---
function verifyAssertion({ authenticatorData, clientDataJSON, signature, publicKeyJwk, expectedChallenge, expectedOrigins, rpId }) {
  const cd = JSON.parse(Buffer.from(clientDataJSON).toString('utf8'));
  if (cd.type !== 'webauthn.get') throw new Error('tipo de clientData incorrecto');
  if (cd.challenge !== expectedChallenge) throw new Error('el challenge no coincide');
  if (!expectedOrigins.includes(cd.origin)) throw new Error('origen no permitido: ' + cd.origin);
  const ad = Buffer.from(authenticatorData);
  const p = parseAuthData(ad);
  if (!p.rpIdHash.equals(crypto.createHash('sha256').update(rpId).digest())) throw new Error('rpIdHash no coincide');
  if (!p.up) throw new Error('sin presencia de usuario');
  if (!p.uv) throw new Error('sin verificación de usuario (Face ID / código)');
  const clientHash = crypto.createHash('sha256').update(Buffer.from(clientDataJSON)).digest();
  const signed = Buffer.concat([ad, clientHash]);
  const pub = crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' });
  const sig = Buffer.from(signature);
  const ok = publicKeyJwk.kty === 'EC'
    ? crypto.verify('sha256', signed, { key: pub, dsaEncoding: 'der' }, sig)   // WebAuthn ES256 = firma DER
    : crypto.verify('sha256', signed, pub, sig);                               // RS256
  if (!ok) throw new Error('firma no válida');
  return { signCount: p.signCount };
}

// Challenge aleatorio (base64url)
function randomChallenge() { return b64u.enc(crypto.randomBytes(32)); }

module.exports = { b64u, cborDecode, parseAuthData, coseToJwk, verifyRegistration, verifyAssertion, randomChallenge };
