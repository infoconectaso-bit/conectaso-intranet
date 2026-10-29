'use strict';
/**
 * Inventario de material de Hora Loca.
 * - Artículos con stock (se suma/resta a mano, o se descuenta por pack).
 * - Packs por nº de invitados (bill of materials) tomados de la hoja de Adrià.
 * - QR por pack: un enlace firmado que SOLO permite descontar ese pack (sin login, sin acceso
 *   al resto de la intranet). El token se valida con HMAC(packId, secreto).
 *
 * Todo se guarda en settings (sobrevive al volcado).
 */
const crypto = require('crypto');

// --- Semilla de artículos (id estable + nombre visible). Reutilizables (disfraces/careta/botellas/
//     capa) se gestionan igual pero NO los consume ningún pack. ---
const ITEMS_SEED = [
  ['palos_espuma_led', 'Palos de espuma LED'],
  ['jeringuillas', 'Jeringuillas'],
  ['gafas_led', 'Gafas LED'],
  ['diademas_led', 'Diademas de LED'],
  ['collares_led', 'Collares de LED'],
  ['anillos_led', 'Anillos de LED'],
  ['diademas_novia', 'Diademas novia'],
  ['collares_hawaianos', 'Collares hawaianos'],
  ['globos_led', 'Globos LED'],
  ['pulseras_led', 'Pulseras de LED'],
  ['bengalas', 'Bengalas'],
  ['capa_led_novia', 'Capa de LED novia'],
  ['botellas_alcohol', 'Botellas de alcohol'],
  ['careta_mono', 'Careta de mono'],
  ['disfraz_dinosaurio', 'Disfraz dinosaurio'],
  ['disfraz_alien', 'Disfraz alien'],
];

// Orden de columnas de la hoja: palos, jeringuillas, gafas, diademas_led, collares_led, anillos,
// diademas_novia, collares_hawaianos, globos, pulseras, bengalas.
const PACK_COLS = ['palos_espuma_led', 'jeringuillas', 'gafas_led', 'diademas_led', 'collares_led', 'anillos_led', 'diademas_novia', 'collares_hawaianos', 'globos_led', 'pulseras_led', 'bengalas'];
const PACKS_SEED_ROWS = [
  ['p50_60', '50 a 60 invitados', 50, 60, [40, 40, 8, 2, 2, 8, 1, 8, 4, 4, 2]],
  ['p60_70', '60 a 70 invitados', 60, 70, [45, 50, 8, 4, 4, 12, 1, 10, 4, 6, 2]],
  ['p70_80', '70 a 80 invitados', 70, 80, [55, 60, 10, 5, 4, 12, 1, 10, 4, 8, 2]],
  ['p80_90', '80 a 90 invitados', 80, 90, [65, 70, 12, 6, 5, 12, 1, 12, 4, 10, 2]],
  ['p90_100', '90 a 100 invitados', 90, 100, [75, 75, 12, 6, 5, 14, 1, 12, 4, 12, 2]],
  ['p100_120', '100 a 120 invitados', 100, 120, [85, 85, 14, 8, 6, 15, 1, 12, 4, 12, 2]],
  ['p120_140', '120 a 140 invitados', 120, 140, [100, 100, 18, 10, 8, 18, 1, 16, 6, 15, 2]],
  ['p140_170', '140 a 170 invitados', 140, 170, [120, 120, 22, 12, 10, 22, 1, 20, 6, 20, 2]],
];

function packsSeed() {
  return PACKS_SEED_ROWS.map(([id, label, min, max, qtys]) => {
    const bom = {};
    PACK_COLS.forEach((c, i) => { if (qtys[i]) bom[c] = qtys[i]; });
    return { id, label, min, max, bom };
  });
}

// Siembra una sola vez (si no existe). No pisa lo que Adrià haya cambiado luego.
function ensureSeed(store) {
  if (!store.setting('hlItems')) {
    store.setSetting('hlItems', ITEMS_SEED.map(([id, name]) => ({ id, name, qty: 0 })));
  }
  if (!store.setting('hlPacks')) {
    store.setSetting('hlPacks', packsSeed());
  }
  if (!store.setting('hlSecret')) {
    store.setSetting('hlSecret', crypto.randomBytes(24).toString('hex'));
  }
  // Dominio FIJO de los QR. Se usa prueba.lol porque seguirá apuntando a este mismo servidor
  // aunque se cambie intranet.conectaso.es al nuevo dominio: así los QR impresos NO hay que
  // reimprimirlos nunca. Si algún día se quiere otro dominio, basta cambiar este setting.
  if (!store.setting('hlScanHost')) {
    store.setSetting('hlScanHost', 'prueba.lol');
  }
}

function state(store) {
  ensureSeed(store);
  return { items: store.setting('hlItems') || [], packs: store.setting('hlPacks') || [] };
}

// --- Token firmado por pack (scope = descontar ESE pack, nada más) ---
function sign(packId, store) {
  const secret = store.setting('hlSecret') || '';
  return crypto.createHmac('sha256', secret).update('hl:' + packId).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
}
function tokenFor(packId, store) { return packId + '.' + sign(packId, store); }
function verifyToken(token, store) {
  const t = String(token || '');
  const i = t.lastIndexOf('.');
  if (i < 0) return null;
  const packId = t.slice(0, i), sig = t.slice(i + 1);
  const exp = sign(packId, store);
  if (sig.length !== exp.length) return null;
  // comparación en tiempo constante
  let ok = 0; for (let k = 0; k < exp.length; k++) ok |= sig.charCodeAt(k) ^ exp.charCodeAt(k);
  if (ok !== 0) return null;
  const packs = (state(store).packs) || [];
  return packs.find(p => p.id === packId) || null;
}

// Info de un pack para la página de escaneo (nombre + líneas con nombre de artículo y cantidad + stock)
function packView(pack, store) {
  const items = state(store).items;
  const nameOf = id => (items.find(x => x.id === id) || {}).name || id;
  const stockOf = id => +((items.find(x => x.id === id) || {}).qty) || 0;
  const lines = Object.keys(pack.bom).map(id => ({ id, name: nameOf(id), need: pack.bom[id], stock: stockOf(id) }));
  return { id: pack.id, label: pack.label, lines };
}

// Descuenta el pack del stock. Devuelve el resultado (permite negativos para que se vea el déficit).
function consume(pack, store) {
  const items = (store.setting('hlItems') || []).map(x => Object.assign({}, x));
  const changes = [];
  Object.keys(pack.bom).forEach(id => {
    const it = items.find(x => x.id === id);
    if (!it) return;
    const before = +it.qty || 0; it.qty = before - pack.bom[id];
    changes.push({ id, name: it.name, used: pack.bom[id], before, after: it.qty });
  });
  store.setSetting('hlItems', items);
  return { ok: true, pack: pack.label, changes };
}

// Ajuste manual de un artículo (delta + o -, o fijar qty). Admin.
function adjust(store, id, delta, setTo) {
  const items = (store.setting('hlItems') || []).map(x => Object.assign({}, x));
  const it = items.find(x => x.id === id);
  if (!it) return { ok: false, error: 'Artículo no encontrado' };
  if (setTo != null && !isNaN(setTo)) it.qty = Math.round(+setTo);
  else it.qty = (+it.qty || 0) + Math.round(+delta || 0);
  store.setSetting('hlItems', items);
  return { ok: true, id, qty: it.qty };
}

// Guarda items y/o packs completos (admin): nombres, orden, cantidades de pack, altas/bajas.
function save(store, body) {
  if (Array.isArray(body.items)) {
    const clean = body.items.filter(x => x && x.id && x.name).map(x => ({ id: String(x.id), name: String(x.name).slice(0, 60), qty: Math.round(+x.qty || 0) }));
    store.setSetting('hlItems', clean);
  }
  if (Array.isArray(body.packs)) {
    const clean = body.packs.filter(p => p && p.id).map(p => {
      const bom = {}; Object.keys(p.bom || {}).forEach(k => { const v = Math.round(+p.bom[k] || 0); if (v) bom[k] = v; });
      return { id: String(p.id), label: String(p.label || '').slice(0, 60), min: +p.min || 0, max: +p.max || 0, bom };
    });
    store.setSetting('hlPacks', clean);
  }
  return state(store);
}

// --- Página de escaneo del QR (HTML autocontenido, sin sesión). Carga los datos por token y
//     pide confirmar antes de descontar. ---
function scanPage() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hora Loca · descontar material</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#0f0c12;color:#1b1b22;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:460px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column}
.hd{background:#17171d;color:#fff;padding:20px 22px;text-align:center}
.hd b{color:#e5007e}
.card{background:#fff;margin:14px;border-radius:16px;padding:20px 20px 24px;box-shadow:0 10px 30px #0006}
h1{font-size:20px;margin:0 0 2px}
.sub{color:#6a6a77;font-size:14px;margin:0 0 16px}
table{width:100%;border-collapse:collapse;font-size:15px}
td{padding:8px 4px;border-bottom:1px solid #eee}
td.q{text-align:right;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
td.q small{color:#9a9aa5;font-weight:400}
.neg{color:#c62828}
.btn{display:block;width:100%;border:0;border-radius:12px;padding:16px;font-size:17px;font-weight:700;cursor:pointer;margin-top:18px}
.btn--go{background:#e5007e;color:#fff}
.btn--go:active{opacity:.85}
.btn:disabled{opacity:.5}
.msg{text-align:center;padding:30px 20px;font-size:16px;line-height:1.5}
.ok-ico{font-size:52px}
.foot{color:#8a8a95;font-size:12px;text-align:center;padding:10px 0 24px}
</style></head>
<body><div class="wrap">
  <div class="hd"><div style="font-size:18px;font-weight:800;letter-spacing:1px">CONECTA <b>SÓ</b></div><div style="font-size:12px;opacity:.7;margin-top:2px">Material Hora Loca</div></div>
  <div id="app"><div class="msg">Cargando…</div></div>
  <div class="foot">Este enlace solo sirve para descontar este pack del inventario.</div>
</div>
<script>
var T=new URLSearchParams(location.search).get('t')||'';
var app=document.getElementById('app');
function esc(s){return String(s).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function render(d){
  if(!d||!d.ok){ app.innerHTML='<div class="msg">⚠️ Enlace no válido o caducado.</div>'; return; }
  var rows=d.lines.map(function(l){var after=l.stock-l.need;var cls=after<0?' class="neg"':'';return '<tr><td>'+esc(l.name)+'</td><td class="q"><b>'+l.need+'</b> <small>(quedan '+l.stock+')</small></td></tr>';}).join('');
  app.innerHTML='<div class="card"><h1>'+esc(d.label)+'</h1><p class="sub">Se descontará del stock:</p>'+
    '<table>'+rows+'</table>'+
    '<button class="btn btn--go" id="go">Confirmar y descontar</button></div>';
  document.getElementById('go').onclick=doConsume;
}
function doConsume(){
  var b=document.getElementById('go'); b.disabled=true; b.textContent='Descontando…';
  fetch('/api/hl/consume',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:T})})
   .then(function(r){return r.json();}).then(function(d){
     if(d&&d.ok){ var ch=(d.changes||[]).map(function(c){var cls=c.after<0?' class="neg"':'';return '<tr><td>'+esc(c.name)+'</td><td class="q">−'+c.used+' → <b'+cls+'>'+c.after+'</b></td></tr>';}).join('');
       app.innerHTML='<div class="card"><div class="msg"><div class="ok-ico">✅</div>Descontado de <b>'+esc(d.pack)+'</b></div><table>'+ch+'</table></div>'; }
     else { app.innerHTML='<div class="msg">⚠️ '+esc((d&&d.error)||'No se pudo descontar')+'</div>'; }
   }).catch(function(){ app.innerHTML='<div class="msg">⚠️ Error de conexión. Inténtalo otra vez.</div>'; });
}
fetch('/api/hl/peek',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:T})})
 .then(function(r){return r.json();}).then(render).catch(function(){app.innerHTML='<div class="msg">⚠️ Error de conexión.</div>';});
</script>
</body></html>`;
}

module.exports = { ensureSeed, state, tokenFor, verifyToken, packView, consume, adjust, save, scanPage, ITEMS_SEED, PACK_COLS };
