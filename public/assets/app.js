'use strict';
/* ============================================================================
   Gestor de eventos · Conecta So — aplicación de cliente (SPA)
   Habla con la API del servidor. La interfaz se adapta al perfil del usuario;
   el servidor es siempre quien decide qué datos se entregan y qué se puede guardar.
   ============================================================================ */
(function () {
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (id) => document.getElementById(id);
// Normaliza para búsquedas: minúsculas y SIN acentos (así "garcia" encuentra "García").
const deac = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// --- Passkeys / Face ID (WebAuthn) en el navegador ---
const waSupported = () => !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
const _b2u = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const _u2b = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
async function passkeyRegister(label) {
  const { cid, options } = await api('webauthn/register/begin', { method: 'POST', body: {} });
  options.challenge = _u2b(options.challenge); options.user.id = _u2b(options.user.id);
  (options.excludeCredentials || []).forEach(c => c.id = _u2b(c.id));
  const cred = await navigator.credentials.create({ publicKey: options });
  return api('webauthn/register/finish', { method: 'POST', body: { cid, label: label || 'Face ID', clientDataJSON: _b2u(cred.response.clientDataJSON), attestationObject: _b2u(cred.response.attestationObject) } });
}
async function passkeyLogin(email) {
  const { cid, options } = await api('webauthn/login/begin', { method: 'POST', body: { email } });
  options.challenge = _u2b(options.challenge);
  (options.allowCredentials || []).forEach(c => c.id = _u2b(c.id));
  const a = await navigator.credentials.get({ publicKey: options });
  return api('webauthn/login/finish', { method: 'POST', body: { cid, id: _b2u(a.rawId), clientDataJSON: _b2u(a.response.clientDataJSON), authenticatorData: _b2u(a.response.authenticatorData), signature: _b2u(a.response.signature) } });
}
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = el('app');

/* ---------- cliente de API ---------- */
async function api(path, { method = 'GET', body, form } = {}) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (form) opt.body = form;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  // Las LECTURAS (GET) se reintentan automáticamente ante fallos transitorios (red caída,
  // error 5xx del servidor, o respuesta no-JSON de un proxy). Es la causa del típico
  // "nada por aquí" que al recargar ya mostraba los datos. Las escrituras NO se reintentan.
  const isGet = method === 'GET';
  const maxTries = isGet ? 3 : 1;
  let lastErr;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 250 * attempt));
    let res;
    try { res = await fetch('/api/' + path, opt); }
    catch (e) { lastErr = Object.assign(new Error('Sin conexión'), { status: 0 }); continue; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
    if (!res.ok) {
      const err = Object.assign(new Error((data && data.error) || ('Error ' + res.status)), { status: res.status, data });
      if (isGet && res.status >= 500) { lastErr = err; continue; } // 5xx transitorio → reintenta
      throw err;
    }
    if (isGet && !ct.includes('json')) { lastErr = Object.assign(new Error('Respuesta vacía'), { status: 0 }); continue; } // cuerpo vacío/no-JSON → reintenta
    return data;
  }
  throw lastErr || Object.assign(new Error('Error de red'), { status: 0 });
}

/* ---------- estado global ---------- */
const S = { user: null, meta: null, brand: null, mailEnabled: false, locById: {}, extraById: {}, staffById: {}, lang: 'es' };
try { S.lang = localStorage.getItem('conecta_lang') || 'es'; } catch (e) { S.lang = 'es'; }

/* ============================ IDIOMAS (cliente / wedding planner) ============================
 * La interfaz del cliente puede verse en Catalán, Inglés o Francés además de Español.
 * TR[textoEspañol] = [catalán, inglés, francés]. El español es la base (sin traducir).
 * Solo se traduce para roles 'user' y 'planner'; administración y técnicos siempre en español.
 */
const LANG_IDX = { ca: 0, en: 1, fr: 2 };
const LANGS = [['ca', 'CAT', '<span class="senyera" aria-label="Català"></span>'], ['es', 'ESP', '🇪🇸'], ['en', 'ENG', '🇬🇧'], ['fr', 'FRA', '🇫🇷']];
const TR = {
  // menú
  'Principal': ['Principal', 'Main', 'Principal'], 'Inicio': ['Inici', 'Home', 'Accueil'], 'Mis bodas': ['Les meves bodes', 'My weddings', 'Mes mariages'],
  'Mi evento': ['El meu esdeveniment', 'My event', 'Mon événement'], 'Mi boda': ['La meva boda', 'My wedding', 'Mon mariage'], 'Realizadas': ['Realitzades', 'Past', 'Passés'],
  'Mis pagos': ['Els meus pagaments', 'My payments', 'Mes paiements'], 'Vehículos': ['Vehicles', 'Vehicles', 'Véhicules'], 'Mi cuenta': ['El meu compte', 'My account', 'Mon compte'],
  'Cerrar sesión': ['Tancar sessió', 'Log out', 'Déconnexion'], 'Otros': ['Altres', 'Other', 'Autres'], 'Tiempo': ['Temps', 'Time', 'Temps'], 'Cliente': ['Client', 'Client', 'Client'],
  'Ver todas': ['Veure totes', 'See all', 'Voir tout'],
  // pestañas y secciones
  'Datos': ['Dades', 'Details', 'Détails'], 'Música': ['Música', 'Music', 'Musique'], 'Extras': ['Extres', 'Extras', 'Extras'], 'Archivos': ['Arxius', 'Files', 'Fichiers'],
  'Servicios': ['Serveis', 'Services', 'Services'], 'Ceremonia': ['Cerimònia', 'Ceremony', 'Cérémonie'], 'Aperitivo': ['Aperitiu', 'Aperitif', 'Apéritif'],
  'Banquete': ['Banquet', 'Banquet', 'Banquet'], 'Entregas': ['Lliuraments', 'Gifts', 'Cadeaux'], 'Fiesta': ['Festa', 'Party', 'Fête'], 'Recomendaciones': ['Recomanacions', 'Recommendations', 'Recommandations'],
  'Datos principales': ['Dades principals', 'Main details', 'Informations principales'], 'Datos de los cónyuges': ['Dades dels cònjuges', 'Groom & bride details', 'Les mariés'],
  'Momentos musicales': ['Moments musicals', 'Music moments', 'Moments musicaux'],
  'Música de tu boda completada': ['Música de la teva boda completada', 'Your wedding music completed', 'Musique de votre mariage complétée'],
  'Guardar': ['Desar', 'Save', 'Enregistrer'],
  // datos
  'Tipo de boda': ['Tipus de boda', 'Wedding type', 'Type de mariage'], 'Fecha': ['Data', 'Date', 'Date'], 'Hora de la ceremonia': ['Hora de la cerimònia', 'Ceremony time', 'Heure de la cérémonie'],
  'Hora inicio aperitivo': ["Hora d'inici de l'aperitiu", 'Aperitif start time', "Heure de début de l'apéritif"], 'Lugar de la celebración': ['Lloc de la celebració', 'Venue', 'Lieu de la célébration'],
  'Lugar de la ceremonia': ['Lloc de la cerimònia', 'Ceremony place', 'Lieu de la cérémonie'], 'Nº de invitados': ['Nº de convidats', 'Nº of guests', "Nb d'invités"],
  'Nombre': ['Nom', 'Name', 'Nom'], 'Móvil': ['Mòbil', 'Mobile', 'Portable'], 'Dirección': ['Adreça', 'Address', 'Adresse'],
  'Primer cónyuge': ['Primer cònjuge', 'Groom', 'Premier marié'], 'Segundo cónyuge': ['Segon cònjuge', 'Bride', 'Second marié'],
  // momentos
  'Entrada primer cónyuge': ['Entrada primer cònjuge', "Groom's entrance", 'Entrée du premier marié'], 'Entrada segundo cónyuge': ['Entrada segon cònjuge', "Bride's entrance", 'Entrée du second marié'],
  'Anillos': ['Anells', 'Rings', 'Alliances'], 'Firmas': ['Signatures', 'Signing', 'Signatures'], 'Salida': ['Sortida', 'Exit', 'Sortie'], 'Lecturas': ['Lectures', 'Readings', 'Lectures'],
  'Entrada vehículo 2º cónyuge': ['Entrada vehicle 2n cònjuge', "Bride's car entrance", 'Entrée voiture 2e marié'], 'Votos': ['Vots', 'Vows', 'Vœux'],
  'Entrada de novios': ['Entrada dels nuvis', 'Couple entrance', 'Entrée des mariés'], 'Primer plato': ['Primer plat', 'First course', 'Premier plat'],
  'Segundo plato': ['Segon plat', 'Second course', 'Plat principal'], 'Sorbete': ['Sorbet', 'Sorbet', 'Sorbet'], 'Postre': ['Postres', 'Dessert', 'Dessert'],
  'Vino blanco': ['Vi blanc', 'White wine', 'Vin blanc'], 'Vino tinto': ['Vi negre', 'Red wine', 'Vin rouge'],
  'Presentación tarta nupcial': ['Presentació pastís nupcial', 'Cake presentation', 'Présentation du gâteau'], 'Tarta nupcial': ['Pastís nupcial', 'Wedding cake', 'Gâteau de mariage'],
  '1ª degustación': ['1a degustació', '1st tasting', '1re dégustation'], '2ª degustación': ['2a degustació', '2nd tasting', '2e dégustation'],
  'Baile nupcial': ['Ball nupcial', 'First dance', 'Ouverture de bal'], 'Última canción de fiesta': ['Última cançó de festa', 'Last party song', 'Dernière chanson'],
  'Artista · Canción': ['Artista · Cançó', 'Artist · Song', 'Artiste · Chanson'], 'Comentario (opcional)': ['Comentari (opcional)', 'Comment (optional)', 'Commentaire (facultatif)'],
  '+ Añadir momento': ['+ Afegir moment', '+ Add moment', '+ Ajouter un moment'],
  // fiesta
  'Enlace a playlist': ['Enllaç a la playlist', 'Playlist link', 'Lien playlist'], 'Tipo de lista': ['Tipus de llista', 'List type', 'Type de liste'],
  'Lista obligatoria': ['Llista obligatòria', 'Mandatory list', 'Liste obligatoire'], 'Lista orientativa': ['Llista orientativa', 'Suggested list', 'Liste indicative'],
  '¿Se aceptan peticiones de invitados?': ["S'accepten peticions dels convidats?", 'Accept guest requests?', 'Accepter les demandes des invités ?'],
  'Sí, todas': ['Sí, totes', 'Yes, all', 'Oui, toutes'], 'No, ninguna': ['No, cap', 'No, none', 'Non, aucune'], 'Sí, si son similares a nuestra playlist': ['Sí, si són semblants a la nostra playlist', 'Yes, if similar to our playlist', 'Oui, si similaires à notre playlist'],
  'Restricciones': ['Restriccions', 'Restrictions', 'Restrictions'], 'Observaciones': ['Observacions', 'Notes', 'Remarques'], 'Logo para el fotomatón': ['Logo per al fotomató', 'Photo booth logo', 'Logo pour le photobooth'],
  'Quitar': ['Treure', 'Remove', 'Retirer'],
  // extras
  'Servicios extras a contratar': ['Serveis extres a contractar', 'Extra services', 'Services supplémentaires'],
  'Ver info': ['Veure info', 'View info', "Voir l'info"], '✓ Añadido': ['✓ Afegit', '✓ Added', '✓ Ajouté'], '✓ Incluido': ['✓ Inclòs', '✓ Included', '✓ Inclus'],
  // reserva extras
  '⏳ Pendiente de confirmación': ['⏳ Pendent de confirmació', '⏳ Awaiting confirmation', '⏳ En attente de confirmation'], '💳 Pendiente de pago': ['💳 Pendent de pagament', '💳 Awaiting payment', '💳 En attente de paiement'],
  '✓ Reservado': ['✓ Reservat', '✓ Booked', '✓ Réservé'],
  // pago
  'Tu pago': ['El teu pagament', 'Your payment', 'Votre paiement'], 'Importe total': ['Import total', 'Total amount', 'Montant total'], 'Pagado': ['Pagat', 'Paid', 'Payé'], 'Pendiente': ['Pendent', 'Pending', 'En attente'],
  // acceso
  'Acceso a la boda': ["Accés a la boda", 'Wedding access', 'Accès au mariage'], '+ Invitar a otra persona': ['+ Convidar una altra persona', '+ Invite someone', '+ Inviter une autre personne'], 'Titular': ['Titular', 'Owner', 'Titulaire'],
  // recomendaciones
  'Ver propuestas ↗': ['Veure propostes ↗', 'View ideas ↗', 'Voir les idées ↗'],
  // archivos y desplazamiento
  'Subir archivo': ['Pujar arxiu', 'Upload file', 'Téléverser un fichier'], 'Momento del archivo': ["Moment de l'arxiu", 'File moment', 'Moment du fichier'], 'Archivo': ['Arxiu', 'File', 'Fichier'],
  'Descargar': ['Descarregar', 'Download', 'Télécharger'], 'Sin archivos todavía.': ['Encara no hi ha arxius.', 'No files yet.', 'Aucun fichier pour le moment.'],
  'Ver ruta en Google Maps ↗': ['Veure ruta a Google Maps ↗', 'View route on Google Maps ↗', "Voir l'itinéraire sur Google Maps ↗"],
  // navegación y cuenta del cliente
  'Mi contrato': ['El meu contracte', 'My contract', 'Mon contrat'],
  'Tu evento con Conecta So.': ['El teu esdeveniment amb Conecta So.', 'Your event with Conecta So.', 'Votre événement avec Conecta So.'],
  'Tus eventos asignados.': ['Els teus esdeveniments assignats.', 'Your assigned events.', 'Vos événements assignés.'],
  'Tus próximas bodas de un vistazo.': ['Les teves properes bodes d\'un cop d\'ull.', 'Your upcoming weddings at a glance.', 'Vos prochains mariages en un coup d\'œil.'],
  // botones comunes
  'Guardar boda': ['Desar boda', 'Save wedding', 'Enregistrer le mariage'],
  'Guardar evento': ['Desar esdeveniment', 'Save event', 'Enregistrer l\'événement'],
  'Cancelar': ['Cancel·lar', 'Cancel', 'Annuler'],
  'Añadir': ['Afegir', 'Add', 'Ajouter'],
  'Eliminar': ['Eliminar', 'Delete', 'Supprimer'],
  'Volver': ['Tornar', 'Back', 'Retour'],
  'Cerrar': ['Tancar', 'Close', 'Fermer'],
  'Generar playlist': ['Generar playlist', 'Generate playlist', 'Générer la playlist'],
  // contrato TyC (cliente)
  'Contrato interno': ['Contracte intern', 'Internal contract', 'Contrat interne'],
  'Contrato firmado': ['Contracte signat', 'Signed contract', 'Contrat signé'],
  'Pendiente de firma': ['Pendent de signatura', 'Pending signature', 'En attente de signature'],
  'Firmar y entrar': ['Signar i entrar', 'Sign and enter', 'Signer et entrer'],
  'Salir': ['Sortir', 'Exit', 'Quitter'],
  'He leído y acepto el contrato.': ['He llegit i accepto el contracte.', 'I have read and accept the contract.', 'J\'ai lu et j\'accepte le contrat.'],
  'Descargar / Imprimir PDF': ['Descarregar / Imprimir PDF', 'Download / Print PDF', 'Télécharger / Imprimer le PDF'],
  'Contratantes': ['Contractants', 'Contracting parties', 'Contractants'],
  'Lugar de celebración': ['Lloc de celebració', 'Venue', 'Lieu de célébration'],
  'Fecha del evento': ['Data de l\'esdeveniment', 'Event date', 'Date de l\'événement'],
  // pago
  'Método de pago': ['Mètode de pagament', 'Payment method', 'Mode de paiement'],
  'Efectivo': ['Efectiu', 'Cash', 'Espèces'],
  'Transferencia': ['Transferència', 'Bank transfer', 'Virement'],
  // música / fiesta extra
  'Canción': ['Cançó', 'Song', 'Chanson'],
  'Enlace': ['Enllaç', 'Link', 'Lien'],
  'Playlist': ['Playlist', 'Playlist', 'Playlist'],
  'Sin enlace': ['Sense enllaç', 'No link', 'Sans lien'],
  'Progreso': ['Progrés', 'Progress', 'Progression'],
  // avisos cliente
  'Rellena aquí la música y los detalles de tu boda. Recuerda Guardar al terminar.': ['Omple aquí la música i els detalls de la teva boda. Recorda Desar en acabar.', 'Fill in your wedding music and details here. Remember to Save when done.', 'Remplissez ici la musique et les détails de votre mariage. Pensez à enregistrer.'],
  // datos / avisos del cliente
  'La fecha solo la puede cambiar administración. Si necesitáis moverla, avisadnos y lo gestionamos nosotros.': ['La data només la pot canviar administració. Si necessiteu moure-la, aviseu-nos i ho gestionem nosaltres.', 'Only administration can change the date. If you need to move it, let us know and we will handle it.', "Seule l'administration peut changer la date. Si vous devez la déplacer, prévenez-nous et nous nous en occupons."],
  'Rellena aquí la música y los detalles de tu boda. Recuerda guardar al terminar.': ['Omple aquí la música i els detalls de la teva boda. Recorda desar en acabar.', 'Fill in your wedding music and details here. Remember to save when done.', 'Remplissez ici la musique et les détails de votre mariage. Pensez à enregistrer.'],
  // momentos musicales
  'Momento personalizado': ['Moment personalitzat', 'Custom moment', 'Moment personnalisé'],
  'Momento / destinatario': ['Moment / destinatari', 'Moment / recipient', 'Moment / destinataire'],
  'Enlace (preferiblemente Spotify)': ['Enllaç (preferiblement Spotify)', 'Link (preferably Spotify)', 'Lien (de préférence Spotify)'],
  'Arrastra ⠿ para ordenar': ['Arrossega ⠿ per ordenar', 'Drag ⠿ to reorder', 'Glissez ⠿ pour réordonner'],
  'Música completada': ['Música completada', 'Music completed', 'Musique complétée'],
  'Qué NO debe sonar': ['Què NO ha de sonar', 'What should NOT be played', 'Ce qui ne doit PAS être joué'],
  'Lo que quieras contarnos': ['El que ens vulguis explicar', 'Anything you want to tell us', 'Ce que vous voulez nous dire'],
  'Guardar': ['Desar', 'Save', 'Enregistrer'],
  'Mi boda': ['La meva boda', 'My wedding', 'Mon mariage'],
  '+ Añadir momento': ['+ Afegir moment', '+ Add moment', '+ Ajouter un moment'],
  'Datos': ['Dades', 'Details', 'Détails'],
};
function translateNode(node, idx) { const raw = node.nodeValue; const k = raw.trim(); if (k && TR[k] && TR[k][idx]) node.nodeValue = raw.replace(k, TR[k][idx]); }
let _translating = false;
function applyLang(root) {
  if (S.lang === 'es' || LANG_IDX[S.lang] == null || !(S.user && (S.user.role === 'user' || S.user.role === 'planner'))) return;
  const idx = LANG_IDX[S.lang]; root = root || document.body; _translating = true;
  try {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const ns = []; let n; while (n = w.nextNode()) ns.push(n);
    ns.forEach(nd => translateNode(nd, idx));
    (root.querySelectorAll ? root.querySelectorAll('[placeholder]') : []).forEach(e => { const k = (e.getAttribute('placeholder') || '').trim(); if (TR[k] && TR[k][idx]) e.setAttribute('placeholder', TR[k][idx]); });
  } finally { _translating = false; }
}
let _langObs = false;
function startLangObserver() {
  if (_langObs) return; _langObs = true;
  const mo = new MutationObserver(muts => { if (_translating || S.lang === 'es') return; const idx = LANG_IDX[S.lang]; if (idx == null) return; _translating = true; try { muts.forEach(m => m.addedNodes.forEach(nd => { if (nd.nodeType === 1) applyLang(nd); else if (nd.nodeType === 3) translateNode(nd, idx); })); } finally { _translating = false; } });
  try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
}
function setLang(l) { S.lang = l; try { localStorage.setItem('conecta_lang', l); } catch (e) {} if (typeof route === 'function') route(); setTimeout(() => applyLang(document.body), 0); }
function rebuildMaps() {
  S.locById = {}; (S.meta.locations || []).forEach(l => S.locById[l.id] = l);
  S.extraById = {}; (S.meta.extras || []).forEach(x => S.extraById[x.id] = x);
  S.staffById = {}; [...(S.meta.staff || []), ...(S.meta.djs || []), ...(S.meta.planners || [])].forEach(u => S.staffById[u.id] = u.name);
}

/* ---------- utilidades de formato ---------- */
const pad = n => String(n).padStart(2, '0');
const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const fmtEur = n => (Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const dmy = s => { if (!s) return ''; const p = String(s).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s; };
const slash = s => (s ? String(s).replace(/-/g, '/') : '');
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const hm = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const toMin = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const estado = i => (S.meta.estados && S.meta.estados[i]) || { n: '', c: '#999' };
const locName = ev => { const l = S.locById[ev.lugar]; return l ? l.name : (ev.lugarOtro ? 'Otro (' + ev.lugarOtro + ')' : ''); };
const extraName = id => (S.extraById[id] || {}).name || '';
const userName = id => S.staffById[id] || '';
const djOf = ev => ev.djId ? userName(ev.djId) : ((ev.services || []).find(s => extraName(s.servicio) === 'Servicio de Dj') ? userName((ev.services.find(s => extraName(s.servicio) === 'Servicio de Dj')).resp) : '');

function toast(msg, kind) {
  const t = document.createElement('div'); t.className = 'toast' + (kind ? ' toast--' + kind : '');
  t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3000);
}
/* Copiar al portapapeles. Usa la API moderna en https y, en http (como el servidor
   por IP), recurre a un textarea temporal + execCommand para que funcione igual. */
function _copyFallback(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.left = '0'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { ta.setSelectionRange(0, text.length); } catch (e) {}
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch (e) { return false; }
}
function copyText(text) {
  text = String(text == null ? '' : text);
  if (navigator.clipboard && window.isSecureContext && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true, () => _copyFallback(text));
  }
  return Promise.resolve(_copyFallback(text));
}
function modal(title, bodyHtml, { okText, onOk, danger } = {}) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><div class="mb">${bodyHtml}</div>
    <div class="mf">${onOk ? `<button class="btn btn--ghost" data-x>Cancelar</button><button class="btn ${danger ? 'btn--primary' : 'btn--dark'}" data-ok>${esc(okText || 'Aceptar')}</button>` : '<button class="btn btn--dark" data-x>Cerrar</button>'}</div></div>`;
  document.body.appendChild(bg);
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-x]')) bg.remove(); if (e.target.closest('[data-ok]')) { const keep = onOk(bg); if (keep !== true) bg.remove(); } });
  return bg;
}

/* ---- Instalar como app (Android/Windows con botón nativo; iPhone con pasos) ---- */
let _deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); _deferredInstall = e; });
window.addEventListener('appinstalled', () => { try { localStorage.setItem('cs_install_off', '1'); } catch (e) {} _deferredInstall = null; });
const _isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
const _isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
// Solo móvil/tablet: en ordenador no se ofrece instalar la app.
const _isMobile = () => /android|iphone|ipad|ipod|iemobile|blackberry|opera mini|mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
function maybeInstallPrompt() {
  try {
    if (!S.user || ['user', 'planner', 'dj'].indexOf(S.user.role) < 0) return;  // novios, wedding planner y DJs
    if (!_isMobile()) return;                                                    // solo en móvil/tablet, nunca en ordenador
    if (_isStandalone()) return;                                                 // ya está instalada
    if (localStorage.getItem('cs_install_off') === '1') return;                  // instalada o "no volver a mostrar"
    if (sessionStorage.getItem('cs_install_shown') === '1') return;             // una vez por sesión
    sessionStorage.setItem('cs_install_shown', '1');
  } catch (e) { return; }
  let action;
  if (_deferredInstall) {
    action = '<button class="btn btn--primary btn--block" id="iInstall" style="margin-top:4px">📲 Instalar la app</button>';
  } else if (_isIOS()) {
    action = '<div class="hint" style="margin-top:4px">En tu iPhone: pulsa <b>Compartir</b> (el icono ⬆️ de abajo) y luego <b>«Añadir a pantalla de inicio»</b>.</div>';
  } else {
    action = '<div class="hint" style="margin-top:4px">En el menú de tu navegador (⋮) elige <b>«Instalar aplicación»</b> o <b>«Añadir a pantalla de inicio»</b>.</div>';
  }
  const body = `<p style="margin:0 0 12px">Ten tu boda siempre a mano: añade <b>Conecta Só</b> a tu móvil y entra de un toque, como una app. 💛</p>${action}
    <div style="margin-top:14px;text-align:center"><a href="#" id="iLater" style="font-size:13px;color:var(--muted)">Ahora no</a>
    &nbsp;·&nbsp; <a href="#" id="iNever" style="font-size:13px;color:var(--muted)">No volver a mostrar</a></div>`;
  const bg = modal('📲 Instala Conecta Só', body);
  const inst = bg.querySelector('#iInstall');
  if (inst) inst.onclick = async () => {
    bg.remove();
    try { _deferredInstall.prompt(); const r = await _deferredInstall.userChoice; if (r && r.outcome === 'accepted') { try { localStorage.setItem('cs_install_off', '1'); } catch (e) {} } _deferredInstall = null; } catch (e) {}
  };
  const later = bg.querySelector('#iLater'); if (later) later.onclick = e => { e.preventDefault(); bg.remove(); };
  const never = bg.querySelector('#iNever'); if (never) never.onclick = e => { e.preventDefault(); try { localStorage.setItem('cs_install_off', '1'); } catch (x) {} bg.remove(); };
}
const ICON = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10', events: 'M7 2v4M17 2v4M3 9h18M5 5h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z',
  extras: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4', users: 'M17 20v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2M12 10a4 4 0 100-8 4 4 0 000 8m9 10v-2a4 4 0 00-3-3.87',
  loc: 'M12 21s-7-5.5-7-11a7 7 0 0114 0c0 5.5-7 11-7 11zM12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5z', clock: 'M12 7v5l3 2M12 22a10 10 0 100-20 10 10 0 000 20z',
  plane: 'M2 12l20-8-8 20-2.5-9L2 12z', euro: 'M18 6a7 7 0 100 12M4 10h9M4 14h8', car: 'M5 13l2-6h10l2 6M5 13h14v5H5v-5zm2 5v2m10-2v2M7 16h.01M17 16h.01',
  doc: 'M14 3v5h5M8 13h8M8 17h8M8 9h3M7 3h8l5 5v11a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z',
  moon: 'M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z',
  wrench: 'M14.7 6.3a4 4 0 00-5.4 5.2L3 17.8 6.2 21l6.3-6.3a4 4 0 005.2-5.4l-2.7 2.7-2.1-.6-.6-2.1 2.7-2.7z',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9', key: 'M15 7a4 4 0 11-5.6 3.6L3 17v4h4l1-1h2v-2h2l1.4-1.4A4 4 0 0015 7z',
  mail: 'M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1zM3 6l9 7 9-7',
  phone: 'M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z',
};
const svg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[k]}"/></svg>`;

/* =========================================================================
   ARRANQUE
   ========================================================================= */
async function boot() {
  applyNight();  // aplica el modo noche cuanto antes (también en la pantalla de login)
  // Autologin del DJ por enlace mágico del albarán (antes de pedir login).
  if ((location.hash || '').startsWith('#/albaran')) return albaranAutologin();
  try {
    const me = await api('auth/me');
    S.user = me.user; S.mailEnabled = me.mailEnabled;
  } catch (e) { S.user = null; }
  window.addEventListener('hashchange', route);
  if (!S.user) return renderAuth();
  await loadContext();
  if (await tycGate()) return;
  route();
  setTimeout(maybeInstallPrompt, 1500);
}
/* Autologin del DJ/trabajador por enlace mágico para rellenar su parte de trabajo. */
async function albaranAutologin() {
  const qs = new URLSearchParams((location.hash.split('?')[1]) || '');
  const token = qs.get('token'), ev = qs.get('ev');
  if (token === 'DEMO-TOKEN') {
    app.innerHTML = authShell(`<h1>✅ El botón funciona</h1><div class="sub">Este es un <b>correo de prueba</b>, así que el enlace es de ejemplo. En un correo real, este botón te llevaría directamente a tu espacio (sin tener que iniciar sesión).</div><a class="btn btn--dark btn--block" href="#/">Ir al inicio</a>`);
    return;
  }
  window.addEventListener('hashchange', route);
  try {
    const r = await api('auth/albaran-login', { method: 'POST', body: { token } });
    S.user = r.user; S.mailEnabled = r.mailEnabled;
    await loadContext();
    if (S.user.role === 'user' && await tycGate()) return;  // los novios firman TyC la 1ª vez
    // El DJ llega desde el email del parte: lo llevamos directo a la pestaña del parte de ese evento.
    if (S.user.role === 'dj' && ev) location.hash = '#/parte/' + ev;
    else location.hash = ev ? ('#/eventos/' + ev) : (S.user.role === 'user' ? '#/' : '#/eventos/realizados');
    route();
  } catch (e) {
    app.innerHTML = authShell(`<h1>Enlace no válido</h1><div class="sub">${esc(e.message || 'El enlace ha caducado o no es válido. Pídele a administración uno nuevo.')}</div><a class="btn btn--dark btn--block" href="#/">Ir al inicio</a>`);
    $$('a[href="#/"]').forEach(a => a.onclick = () => { location.hash = '#/'; location.reload(); });
  }
}
/* Contrato TyC: el cliente debe firmarlo la primera vez antes de entrar. */
async function tycGate() {
  if (!S.user || S.user.role !== 'user' || S.user.tycSigned || S.user.tycNotNeeded) return false;
  try { await renderTyc(); return true; } catch (e) { return false; }
}
async function renderTyc() {
  const r = await api('tyc/current');
  const a = r.autofill || {}; const isClient = S.user.role === 'user';
  const fecha = a.fecha ? dmy(a.fecha) : '';
  const text = (r.tyc.text || '')
    .replace(/\{novios\}/g, `<b>${esc(a.novios || '—')}</b>`)
    .replace(/\{finca\}/g, `<b>${esc(a.finca || '—')}</b>`)
    .replace(/\{fecha\}/g, `<b>${esc(fecha || '—')}</b>`);
  const privacyText = (r.privacy && r.privacy.text) || '';
  const nm = String(a.novios || '').split(/\s+y\s+/i).map(s => s.trim());
  const dniFields = isClient
    ? `<div class="grid-2">
         <div class="field"><label>Nombre completo · primer cónyuge</label><input class="control" id="tName1" value="${esc(nm[0] || '')}" placeholder="Nombre y apellidos"></div>
         <div class="field"><label>DNI · primer cónyuge</label><input class="control" id="tDni" placeholder="DNI"></div>
         <div class="field"><label>Nombre completo · segundo cónyuge</label><input class="control" id="tName2" value="${esc(nm[1] || '')}" placeholder="Nombre y apellidos"></div>
         <div class="field"><label>DNI · segundo cónyuge</label><input class="control" id="tDni2" placeholder="DNI"></div>
       </div>`
    : `<div class="field"><label>DNI</label><input class="control" id="tDni" placeholder="DNI"></div>`;
  app.innerHTML = `<div class="tyc-screen"><div class="tyc-card">
    <div class="tyc-head"><img src="/assets/brand/logo-principal-azul.svg" alt="Conecta So" style="height:40px"><span class="tyc-tag">Contrato interno</span></div>
    <h1>${esc(tycTitleYear(r.tyc.title, a.fecha))}</h1>
    <p class="tyc-sub">Antes de entrar por primera vez, lee y firma el contrato. Solo tienes que hacerlo una vez.</p>
    ${isClient && (a.finca || fecha) ? `<div class="tyc-datos"><div><span>Lugar</span><b>${esc(a.finca || '—')}</b></div><div><span>Fecha</span><b>${esc(fecha || '—')}</b></div></div>` : ''}
    <div class="tyc-body">${text}</div>
    ${isClient && privacyText ? `<details class="tyc-privacy"><summary>Ver política de privacidad</summary><div class="tyc-body" style="margin-top:8px">${privacyText}</div></details>` : ''}
    <form id="tycForm" class="tyc-form">
      ${dniFields}
      ${isClient ? '' : `<div class="field"><label>Firma (escribe tu nombre completo)</label><input class="control" id="tName" value="${esc(S.user.name || '')}" placeholder="Nombre y apellidos"></div>`}
      <label class="tyc-accept"><input type="checkbox" id="tAccept"> ${isClient ? 'He leído y acepto el contrato y la política de privacidad.' : 'He leído y acepto el contrato.'}</label>
      <div class="tyc-actions"><button type="button" class="btn btn--ghost" id="tLogout">Salir</button><button type="submit" class="btn btn--primary">Firmar y entrar</button></div>
    </form></div></div>`;
  const form = el('tycForm');
  el('tLogout').onclick = async () => { await api('auth/logout', { method: 'POST' }); S.user = null; location.hash = '#/'; renderAuth(); };
  form.onsubmit = async e => {
    e.preventDefault();
    const name1 = (el('tName1') || {}).value ? el('tName1').value.trim() : '';
    const name2 = (el('tName2') || {}).value ? el('tName2').value.trim() : '';
    const name = isClient ? name1 : ((el('tName') || {}).value || '').trim();
    const dni = el('tDni').value.trim();
    const dni2 = (el('tDni2') || {}).value ? el('tDni2').value.trim() : '';
    if (!el('tAccept').checked) return toast('Debes marcar que aceptas el contrato', 'err');
    if (isClient) { if (!name1 || !name2) return toast('Escribe el nombre completo de ambos cónyuges', 'err'); }
    else if (!name) return toast('Escribe tu nombre para firmar', 'err');
    if (!dni) return toast('Indica el DNI', 'err');
    try { const res = await api('tyc/sign', { method: 'POST', body: { name, name1, name2, dni, dni2 } }); S.user = res.user || Object.assign(S.user, { tycSigned: true }); toast('Contrato firmado', 'ok'); location.hash = '#/'; route(); }
    catch (err) { toast(err.message, 'err'); }
  };
}
async function loadContext() {
  const [meta, brand] = await Promise.all([api('meta'), api('brand').catch(() => ({}))]);
  S.meta = meta; S.brand = brand; rebuildMaps();
}

/* =========================================================================
   AUTENTICACIÓN
   ========================================================================= */
function authShell(inner) {
  return `<div class="auth"><div class="auth__brand">
    <img class="logo-wordmark" src="/assets/brand/logo-principal-blanco.svg" alt="Conecta So">
    <img class="el el--vinilo" src="/assets/brand/el-vinilo.svg" alt="">
    <div><div class="auth__hero script">Montamos el tinglado</div>
      <p>El gestor de eventos de Conecta So: bodas, música, equipo y facturación en un mismo sitio.</p></div>
    <div style="color:#8a8494;font-size:12px">Conecta So · soylallorona.com</div>
  </div><div class="auth__form"><div class="auth__card">${inner}</div></div></div>`;
}
function renderAuth() {
  removeSpotlight();
  const h = location.hash;
  if (h.startsWith('#/activar')) return renderActivate();
  if (h.startsWith('#/recuperar')) return renderForgot();
  app.innerHTML = authShell(`
    <h1>Hola de nuevo</h1>
    <div class="sub">Entra con tu cuenta de Conecta So.</div>
    <form id="loginForm">
      <div class="field"><label>Email</label><div class="input-icon"><input class="control" name="email" type="email" autocomplete="username" required>${svg('users')}</div></div>
      <div class="field"><label>Contraseña</label><div class="pw-wrap"><input class="control" name="password" type="password" autocomplete="current-password" required><button type="button" class="pw-eye" data-pwtoggle aria-label="Mostrar u ocultar la contraseña">👁</button></div></div>
      <div id="loginErr" class="field-error" style="display:none"></div>
      <button class="btn btn--primary btn--block" type="submit">Entrar</button>
      ${waSupported() ? `<button type="button" id="faceIdBtn" class="btn btn--block" style="margin-top:10px">🔒 Entrar con Face ID</button>` : ''}
      <div style="margin-top:16px;text-align:center"><a href="#/recuperar">¿Olvidaste tu contraseña?</a></div>
    </form>`);
  const fib = el('faceIdBtn');
  if (fib) fib.onclick = async () => {
    const email = ((document.querySelector('#loginForm [name=email]') || {}).value || '').trim();
    const errEl = el('loginErr'); errEl.style.display = 'none';
    if (!email) { errEl.textContent = 'Escribe tu email y pulsa Face ID.'; errEl.style.display = 'block'; return; }
    fib.disabled = true;
    try { await passkeyLogin(email); location.hash = '#/'; await afterLogin(); }
    catch (err) { errEl.textContent = (err && err.message) || 'No se pudo entrar con Face ID.'; errEl.style.display = 'block'; fib.disabled = false; }
  };
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target; const btn = $('button', f); btn.disabled = true;
    const errEl = el('loginErr'); errEl.style.display = 'none';
    const emailVal = f.email.value.trim(), pwVal = f.password.value;
    try {
      await api('auth/login', { method: 'POST', body: { email: emailVal, password: pwVal } });
      // Pide al navegador guardar la contraseña (Chrome/Android y similares). Safari usa sus propios autocomplete.
      try { if (window.PasswordCredential && navigator.credentials && navigator.credentials.store) { navigator.credentials.store(new PasswordCredential({ id: emailVal, password: pwVal, name: emailVal })).catch(() => {}); } } catch (e) {}
      location.hash = '#/'; await afterLogin();
    } catch (err) { errEl.textContent = err.message; errEl.style.display = 'block'; btn.disabled = false; }
  });
}
async function afterLogin() {
  const me = await api('auth/me'); S.user = me.user; S.mailEnabled = me.mailEnabled;
  await loadContext(); if (await tycGate()) return; if (!location.hash || location.hash === '#/recuperar') location.hash = '#/'; route();
  setTimeout(maybeInstallPrompt, 1500);
}
function renderForgot() {
  app.innerHTML = authShell(`
    <h1>Recuperar acceso</h1>
    <div class="sub">Te enviaremos un enlace para crear una contraseña nueva.</div>
    <form id="fForm">
      <div class="field"><label>Email</label><input class="control" name="email" type="email" required></div>
      <button class="btn btn--primary btn--block" type="submit">Enviar enlace</button>
      <div style="margin-top:16px;text-align:center"><a href="#/">Volver a entrar</a></div>
    </form>`);
  $('#fForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('auth/forgot', { method: 'POST', body: { email: e.target.email.value.trim() } }); } catch (x) {}
    app.innerHTML = authShell(`<h1>Revisa tu correo</h1><div class="sub">Si ese email tiene una cuenta activa, le hemos enviado un enlace para restablecer la contraseña. ${S.mailEnabled ? '' : '<br><br><b>Nota:</b> el envío de correo no está configurado todavía; pide el enlace a administración.'}</div><a class="btn btn--dark btn--block" href="#/">Volver</a>`);
  });
}
async function renderActivate() {
  const token = new URLSearchParams(location.hash.split('?')[1] || '').get('token');
  if (token === 'DEMO-TOKEN') {
    app.innerHTML = authShell(`<h1>✅ El botón funciona</h1><div class="sub">Este es un <b>correo de prueba</b>, así que el enlace es de ejemplo y no crea ninguna contraseña. En un correo real (alta o restablecer), este mismo botón te abriría el formulario para crear tu contraseña.</div><a class="btn btn--dark btn--block" href="#/">Ir al inicio</a>`);
    return;
  }
  // Si hay otra cuenta abierta, se cierra para que el formulario sea de la persona correcta.
  if (S.user) { try { await api('auth/logout', { method: 'POST' }); } catch (e) {} S.user = null; }
  let info; try { info = await api('auth/invite-info?token=' + encodeURIComponent(token || '')); }
  catch (e) { app.innerHTML = authShell(`<h1>Enlace no válido</h1><div class="sub">Este enlace no es válido o ha caducado. Pide uno nuevo a administración.</div><a class="btn btn--dark btn--block" href="#/">Ir al inicio</a>`); return; }
  app.innerHTML = authShell(`
    <h1>${info.kind === 'invite' ? '¡Bienvenido/a!' : 'Nueva contraseña'}</h1>
    <div class="sub">${esc(info.email)} — crea tu contraseña para ${info.kind === 'invite' ? 'activar tu cuenta' : 'volver a entrar'}.</div>
    <form id="aForm">
      <div class="field"><label>Contraseña nueva</label><div class="pw-wrap"><input class="control" name="password" type="password" autocomplete="new-password" required><button type="button" class="pw-eye" data-pwtoggle aria-label="Mostrar u ocultar la contraseña">👁</button></div></div>
      <div class="field"><label>Repite la contraseña</label><div class="pw-wrap"><input class="control" name="password2" type="password" required><button type="button" class="pw-eye" data-pwtoggle aria-label="Mostrar u ocultar la contraseña">👁</button></div></div>
      <div class="hint">Mínimo 6 caracteres.</div>
      <div id="aErr" class="field-error" style="display:none"></div>
      <button class="btn btn--primary btn--block" type="submit" style="margin-top:14px">Guardar y entrar</button>
    </form>`);
  $('#aForm').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target; const errEl = el('aErr'); errEl.style.display = 'none';
    if ((f.password.value || '').length < 6) { errEl.textContent = 'La contraseña debe tener al menos 6 caracteres.'; errEl.style.display = 'block'; return; }
    if (f.password.value !== f.password2.value) { errEl.textContent = 'Las contraseñas no coinciden.'; errEl.style.display = 'block'; return; }
    try { await api('auth/activate', { method: 'POST', body: { token, password: f.password.value } }); location.hash = '#/'; await afterLogin(); }
    catch (err) { errEl.textContent = err.message; errEl.style.display = 'block'; }
  });
}

/* =========================================================================
   NAVEGACIÓN POR PERFIL
   ========================================================================= */
function navFor(role) {
  if (role === 'admin') return [
    { s: 'Principal' }, { t: 'Inicio', i: 'home', h: '#/' },
    { s: 'Eventos' }, { t: 'Bodas pendientes', i: 'events', h: '#/eventos' }, { t: 'Bodas realizadas', i: 'events', h: '#/eventos/realizados' },
    { t: 'Servicios extras', i: 'extras', h: '#/extras' },
    { s: 'Equipo' }, { t: 'Usuarios', i: 'users', h: '#/usuarios' }, { t: 'Localizaciones', i: 'loc', h: '#/localizaciones' },
    { t: 'Control horario', i: 'clock', h: '#/horario' }, { t: 'Vacaciones', i: 'plane', h: '#/vacaciones' }, { t: 'Nóminas', i: 'doc', h: '#/nominas' },
    { s: 'Negocio' }, { t: 'Cobros de la semana', i: 'euro', h: '#/cobros' }, { t: 'Impagos', i: 'euro', h: '#/impagos' }, { t: 'Descuadre facturas', i: 'euro', h: '#/descuadres' }, { t: 'Facturación equipo', i: 'euro', h: '#/facturacion' },
    { t: 'Copias de seguridad', i: 'doc', h: '#/backups' },
    { t: 'Vehículos', i: 'car', h: '#/vehiculos' }, { t: 'Mantenimiento', i: 'wrench', h: '#/mantenimiento' }, { t: 'Términos (TYC)', i: 'doc', h: '#/tyc' },
    // Papelera y Beneficios se han movido a "Mi cuenta → Configuración avanzada" (protegidos con contraseña).
  ];
  if (role === 'dj') {
    const tt = !!(S.user && S.user.time_tracking);     // solo quien tiene control horario habilitado
    const veh = !!(S.user && S.user.vehicle_allowed);  // solo quien puede conducir furgoneta
    return [
      { s: 'Mi trabajo' }, { t: 'Inicio', i: 'home', h: '#/' }, { t: 'Mis eventos', i: 'events', h: '#/eventos' },
      { t: 'Realizados', i: 'events', h: '#/eventos/realizados' },
      ...(tt ? [{ s: 'Tiempo' }, { t: 'Mi control horario', i: 'clock', h: '#/horario' }, { t: 'Mis vacaciones', i: 'plane', h: '#/vacaciones' }] : []),
      ...((tt || [723, 292].includes(S.user && S.user.id)) ? [{ s: 'Nóminas' }, { t: 'Mis nóminas', i: 'doc', h: '#/nominas' }] : []),
      { s: 'Otros' }, { t: 'Mis pagos', i: 'euro', h: '#/mis-pagos' },
      ...(veh ? [{ t: 'Vehículos', i: 'car', h: '#/vehiculos' }] : []),
      { t: 'Mantenimiento', i: 'wrench', h: '#/mantenimiento' },
    ];
  }
  if (role === 'planner') return [
    { s: 'Principal' }, { t: 'Inicio', i: 'home', h: '#/' }, { t: 'Mis bodas', i: 'events', h: '#/eventos' },
    { t: 'Realizadas', i: 'events', h: '#/eventos/realizados' },
  ];
  return [ // user / cliente
    { s: 'Mi boda' }, { t: 'Inicio', i: 'home', h: '#/' }, { t: 'Mi evento', i: 'events', h: '#/eventos' },
    { t: 'Mi contrato', i: 'doc', h: '#/mi-contrato' },
  ];
}
function shell(bodyHtml, crumbs) {
  const u = S.user;
  const nav = navFor(u.role).map(n => n.s
    ? `<div class="nav__section">${esc(n.s)}</div>`
    : `<a href="${n.h}" data-nav="${n.h}">${svg(n.i)}<span>${esc(n.t)}</span></a>`).join('');
  app.innerHTML = `<div class="app">
    <aside class="sidebar">
      <div class="sidebar__logo"><img src="/assets/brand/logo-reducido-azul.svg" alt="">
        <div class="wm">CONECTA<small>Gestor de eventos</small></div></div>
      ${(u.role === 'user' || u.role === 'planner') ? `<div class="langsel langsel--top" id="langsel">${LANGS.map(l => `<button type="button" data-lang="${l[0]}" class="${S.lang === l[0] ? 'on' : ''}" title="${l[1]}"><span class="flag">${l[2]}</span><span class="code">${l[1]}</span></button>`).join('')}</div>` : ''}
      <nav class="nav">${nav}</nav>
      <div class="nav__foot"><a href="#/cuenta" data-nav="#/cuenta">${svg('key')}<span>Mi cuenta</span></a>
        <a href="#" id="nightToggle" class="night-toggle" title="Modo noche: atenúa la intranet sola de noche (de 21:00 a 7:00) para reducir el impacto visual y no deslumbrar. Se guarda en este dispositivo.">${svg('moon')}<span>Modo noche</span><b id="nightState" class="night-state"></b></a>
        <a href="#" id="logoutLink">${svg('logout')}<span>Cerrar sesión</span></a></div>
    </aside>
    <div class="main">
      <header class="topbar">
        <div class="topbar__left"><button class="burger" id="burger">☰</button>
          <div class="crumbs">${(crumbs || []).map((c, i, a) => i === a.length - 1 ? `<b>${esc(c)}</b>` : `${esc(c)} <span>›</span>`).join(' ')}</div></div>
        <div class="userchip" id="userchip"><span class="avatar">${esc((u.name || '?').trim().charAt(0).toUpperCase())}</span>
          <span class="who">${esc(u.name || u.email)}<small>${esc(roleLabel(u.role))}</small></span></div>
      </header>
      <div class="content">${bodyHtml}</div>
    </div></div>`;
  markActive();
  applyNight();
  const nt = el('nightToggle'); if (nt) nt.onclick = e => { e.preventDefault(); toggleNight(); };
  el('burger').onclick = () => document.body.classList.toggle('nav-open');
  $$('.nav a[data-nav], .nav__foot a[data-nav]').forEach(a => a.onclick = () => document.body.classList.remove('nav-open'));
  el('logoutLink').onclick = async e => { e.preventDefault(); await api('auth/logout', { method: 'POST' }); S.user = null; location.hash = '#/'; renderAuth(); };
  el('userchip').onclick = () => {
    if ($('.menu')) return $('.menu').remove();
    const m = document.createElement('div'); m.className = 'menu';
    m.innerHTML = `<a href="#/cuenta">${svg('key')} Mi cuenta</a><button id="mLogout">${svg('logout')} Cerrar sesión</button>`;
    el('userchip').after(m);
    $('#mLogout', m).onclick = () => el('logoutLink').click();
    setTimeout(() => document.addEventListener('click', function h(ev) { if (!ev.target.closest('.menu,#userchip')) { m.remove(); document.removeEventListener('click', h); } }), 0);
  };
  const ls = el('langsel');
  if (ls) $$('button[data-lang]', ls).forEach(b => b.onclick = () => setLang(b.dataset.lang));
  startLangObserver();
  applyLang(app);
  initSpotlight();
}
const roleLabel = r => ({ admin: 'Administración', dj: 'DJ / Técnico', planner: 'Wedding planner', user: 'Cliente' }[r] || r);

/* ---------- Buscador global tipo Spotlight (lupa fija + overlay, Ctrl/Cmd+K) ---------- */
function removeSpotlight() { ['spot-btn', 'spot-overlay', 'spot-style'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); }); }
function initSpotlight() {
  if (!S.user || document.getElementById('spot-btn')) return;   // vive en <body>, sobrevive a los re-render
  const mag = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
  const st = document.createElement('style'); st.id = 'spot-style';
  st.textContent = `
  #spot-btn{position:fixed;right:18px;bottom:18px;z-index:9000;width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;background:#E82C88;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}
  #spot-btn svg{width:24px;height:24px}
  #spot-overlay{position:fixed;inset:0;z-index:9001;background:rgba(10,12,20,.45);display:none;align-items:flex-start;justify-content:center}
  #spot-overlay.open{display:flex}
  .spot-box{margin-top:12vh;width:min(620px,92vw);background:#fff;color:#1b2430;border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden}
  .spot-in{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(0,0,0,.08)}
  .spot-in input{flex:1;border:none;outline:none;font-size:18px;background:transparent;color:inherit}
  .spot-res{max-height:60vh;overflow:auto}
  .spot-item{display:flex;flex-direction:column;gap:2px;padding:11px 16px;cursor:pointer;border-bottom:1px solid rgba(0,0,0,.05)}
  .spot-item.sel,.spot-item:hover{background:rgba(232,44,136,.10)}
  .spot-item .t{font-weight:600}.spot-item .s{font-size:12px;color:#6a7382}
  .spot-item .tag{font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:#E82C88;font-weight:700}
  .spot-empty{padding:18px 16px;color:#889;text-align:center;font-size:14px}
  @media (prefers-color-scheme: dark){.spot-box{background:#1c1e26;color:#eee}.spot-item .s{color:#9aa4b2}}`;
  document.head.appendChild(st);
  const btn = document.createElement('button'); btn.id = 'spot-btn'; btn.title = 'Buscar (Ctrl/Cmd+K)'; btn.setAttribute('aria-label', 'Buscar'); btn.innerHTML = mag;
  document.body.appendChild(btn);
  const ov = document.createElement('div'); ov.id = 'spot-overlay';
  ov.innerHTML = `<div class="spot-box"><div class="spot-in">${mag.replace('width:24px', '')}<input type="text" placeholder="Buscar bodas, personas, fincas…" autocomplete="off" spellcheck="false"></div><div class="spot-res"></div></div>`;
  document.body.appendChild(ov);
  const input = ov.querySelector('input'); const resBox = ov.querySelector('.spot-res');
  let items = [], sel = -1, timer = null, seq = 0;
  const open = () => { ov.classList.add('open'); input.value = ''; resBox.innerHTML = '<div class="spot-empty">Escribe para buscar…</div>'; items = []; sel = -1; setTimeout(() => input.focus(), 30); };
  const close = () => ov.classList.remove('open');
  const scrollSel = () => { const e = resBox.querySelector('.spot-item.sel'); if (e) e.scrollIntoView({ block: 'nearest' }); };
  const render = () => {
    if (!items.length) { resBox.innerHTML = '<div class="spot-empty">Sin resultados.</div>'; return; }
    resBox.innerHTML = items.map((r, i) => `<div class="spot-item ${i === sel ? 'sel' : ''}" data-i="${i}"><span class="tag">${esc(r.type)}</span><span class="t">${esc(r.title)}</span>${r.sub ? `<span class="s">${esc(r.sub)}</span>` : ''}</div>`).join('');
    $$('.spot-item', resBox).forEach(e => e.onclick = () => go(+e.dataset.i));
  };
  const go = i => { const r = items[i]; if (!r) return; close(); location.hash = r.hash; };
  const search = async () => {
    const q = input.value.trim();
    if (q.length < 2) { items = []; resBox.innerHTML = '<div class="spot-empty">Escribe al menos 2 letras…</div>'; return; }
    const my = ++seq;
    try { const r = await api('search?q=' + encodeURIComponent(q)); if (my !== seq) return; items = r.results || []; sel = items.length ? 0 : -1; render(); }
    catch (e) { if (my === seq) resBox.innerHTML = '<div class="spot-empty">Error al buscar.</div>'; }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 180); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); scrollSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); scrollSel(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (sel >= 0) go(sel); }
    else if (e.key === 'Escape') { close(); }
  });
  btn.onclick = open;
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K') && S.user) { e.preventDefault(); ov.classList.contains('open') ? close() : open(); } });
}
// --- Modo noche automático: atenúa la intranet a partir de las 21:00 (hasta las 7:00).
// Se guarda en el dispositivo (localStorage), así queda activado cada vez que entran. ---
const NIGHT_START = 21, NIGHT_END = 7;
function nightEnabled() { try { return localStorage.getItem('conecta_night') === '1'; } catch (e) { return false; } }
function applyNight() {
  const h = new Date().getHours();
  const on = nightEnabled() && (h >= NIGHT_START || h < NIGHT_END);
  document.documentElement.classList.toggle('night-dim', on);
  const st = document.getElementById('nightState'); if (st) st.textContent = nightEnabled() ? 'Activado' : 'Desactivado';
  const tg = document.getElementById('nightToggle'); if (tg) tg.classList.toggle('on', nightEnabled());
}
function toggleNight() {
  const willEnable = !nightEnabled();
  try { localStorage.setItem('conecta_night', willEnable ? '1' : '0'); } catch (e) {}
  applyNight();
  if (typeof toast === 'function') toast(willEnable
    ? 'Modo noche activado: la intranet se atenúa sola de noche (de 21:00 a 7:00) para reducir el impacto visual y no deslumbrar. Queda guardado en este dispositivo.'
    : 'Modo noche desactivado.', 'ok');
}
if (!window.__nightInt) window.__nightInt = setInterval(applyNight, 60000); // revisa cada minuto para que entre solo a las 21:00
// Título del contrato con el AÑO DE LA BODA (se actualiza según la fecha del evento).
const tycTitleYear = (baseTitle, fechaBoda) => {
  const y = (fechaBoda && /^\d{4}/.test(String(fechaBoda))) ? String(fechaBoda).slice(0, 4) : String(new Date().getFullYear());
  const base = String(baseTitle || 'Términos y condiciones de servicio').replace(/\s*\b(19|20)\d{2}\b\s*$/, '').trim();
  return base + ' ' + y;
};
function markActive() {
  const h = (location.hash || '#/').split('?')[0];
  const links = $$('.nav a[data-nav]');
  const targets = links.map(a => a.getAttribute('data-nav'));
  // Coincidencia respetando límites de segmento (#/eventos NO coincide con #/eventos/realizados… salvo exacto o con "/").
  const matches = t => t === h || (t !== '#/' && (h === t || h.startsWith(t + '/')));
  links.forEach(a => {
    const t = a.getAttribute('data-nav');
    let on = matches(t);
    // Si otro destino del menú coincide de forma MÁS específica (prefijo más largo), este no se marca.
    if (on) on = !targets.some(o => o !== t && o.length > t.length && matches(o));
    a.classList.toggle('active', on);
  });
}
function pageHead(title, lead, right) {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${lead ? `<div class="lead">${esc(lead)}</div>` : ''}<div class="page-head__accent"></div></div>${right || ''}</div>`;
}

/* =========================================================================
   TABLA (ordenar, filtrar, paginar) — en cliente sobre un array ya cargado
   ========================================================================= */
const TBL = {};
function table(id, cfg) {
  const st = TBL[id] || (TBL[id] = { page: 0, len: cfg.len || 50, q: '', order: cfg.order || [0, 'asc'], f: {} });
  st.cfg = cfg;
  return `<div class="dt" id="${id}"><div class="dt-mount">${renderTable(id)}</div></div>`;
}
function renderTable(id) {
  const st = TBL[id], cfg = st.cfg;
  let rows = cfg.rows.slice();
  const txt = (c, r) => deac(c.get ? c.get(r) : '');
  if (st.q) { const q = deac(st.q); rows = rows.filter(r => cfg.cols.some(c => txt(c, r).includes(q))); }
  Object.entries(st.f).forEach(([ci, v]) => { if (v) rows = rows.filter(r => txt(cfg.cols[ci], r).includes(deac(v))); });
  const [oc, od] = st.order, col = cfg.cols[oc];
  if (col && col.get) rows.sort((a, b) => { const x = col.get(a), y = col.get(b); const r = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x).localeCompare(String(y), 'es', { numeric: true }); return od === 'asc' ? r : -r; });
  const total = rows.length, pages = Math.max(1, Math.ceil(total / st.len));
  if (st.page >= pages) st.page = pages - 1;
  const slice = rows.slice(st.page * st.len, st.page * st.len + st.len);
  const from = total ? st.page * st.len + 1 : 0, to = Math.min(total, (st.page + 1) * st.len);
  const ths = cfg.cols.map((c, i) => `<th data-sort="${c.nosort ? '' : i}" class="${c.nosort ? 'nosort' : ''}">${esc(c.t)}${c.nosort ? '' : `<span class="caret">${oc === i ? (od === 'asc' ? '▲' : '▼') : '⇅'}</span>`}</th>`).join('');
  const filt = cfg.filters ? `<tr class="filters">${cfg.cols.map((c, i) => `<th>${c.nofilter || c.nosort ? '' : `<input data-cf="${i}"${(c.num || c.t === 'Id') ? ' inputmode="numeric"' : ''} value="${esc(st.f[i] || '')}" placeholder="Buscar">`}</th>`).join('')}</tr>` : '';
  const body = slice.length ? slice.map(r => `<tr>${cfg.cols.map(c => `<td>${c.html ? c.html(r) : esc(c.get(r))}</td>`).join('')}</tr>`).join('')
    : `<tr><td class="td-empty" colspan="${cfg.cols.length}">${esc(cfg.empty || 'No hay registros.')}</td></tr>`;
  const start = Math.max(0, Math.min(st.page - 2, pages - 5)); const pb = [];
  for (let p = start; p < Math.min(pages, start + 5); p++) pb.push(`<button data-pg="${p}" class="${p === st.page ? 'cur' : ''}">${p + 1}</button>`);
  return `<div class="dt-top"><label>Mostrar <select class="control control--sm" data-len style="width:auto">${[25, 50, 100].map(n => `<option ${n === st.len ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Buscar <input class="control control--sm dt-search" data-q value="${esc(st.q)}"></label></div>
    <div class="table-wrap"><table class="dt${cfg.dense ? ' dt--dense' : ''}"><thead><tr>${ths}</tr>${filt}</thead><tbody>${body}</tbody></table></div>
    <div class="dt-foot"><div>${total ? `${from}–${to} de ${total.toLocaleString('es-ES')}` : '0 registros'}</div>
      <div class="pager"><button data-pg="0" ${st.page === 0 ? 'disabled' : ''}>«</button>${pb.join('')}<button data-pg="${pages - 1}" ${st.page >= pages - 1 ? 'disabled' : ''}>»</button></div></div>`;
}
function refreshTable(id, focus) {
  const w = el(id); if (!w) return; const act = document.activeElement;
  const sel = act && (act.dataset.q !== undefined ? '[data-q]' : act.dataset.cf !== undefined ? `[data-cf="${act.dataset.cf}"]` : null);
  const pos = act && act.selectionStart;
  $('.dt-mount', w).innerHTML = renderTable(id);
  const st = TBL[id]; if (st && typeof st.onRender === 'function') { try { st.onRender(); } catch (x) {} }  // re-enganchar acciones de fila
  if (focus && sel) { const e2 = $(sel, w); if (e2) { e2.focus(); try { e2.setSelectionRange(pos, pos); } catch (x) {} } }
}
// Engancha las acciones de fila de una tabla (botones editar/borrar, etc.) y las vuelve
// a enganchar tras cada refresco (orden, filtro, paginación). Portado de la demo.
function bindTable(id, cb) { const st = TBL[id]; if (st) st.onRender = cb; if (typeof cb === 'function') { try { cb(); } catch (x) {} } }
document.addEventListener('input', e => {
  const w = e.target.closest('.dt[id]'); if (!w || !TBL[w.id]) return; const st = TBL[w.id];
  if (e.target.dataset.q !== undefined) { st.q = e.target.value; st.page = 0; refreshTable(w.id, true); }
  if (e.target.dataset.cf !== undefined) { st.f[e.target.dataset.cf] = e.target.value; st.page = 0; refreshTable(w.id, true); }
});
document.addEventListener('change', e => { const w = e.target.closest('.dt[id]'); if (w && TBL[w.id] && e.target.dataset.len !== undefined) { TBL[w.id].len = +e.target.value; TBL[w.id].page = 0; refreshTable(w.id); } });
document.addEventListener('click', e => {
  const w = e.target.closest('.dt[id]'); if (!w || !TBL[w.id]) return; const st = TBL[w.id];
  const th = e.target.closest('th[data-sort]'); if (th && th.dataset.sort !== '') { const c = +th.dataset.sort; st.order = [c, st.order[0] === c && st.order[1] === 'asc' ? 'desc' : 'asc']; refreshTable(w.id); }
  const pg = e.target.closest('[data-pg]'); if (pg && !pg.disabled) { st.page = +pg.dataset.pg; refreshTable(w.id); }
});
// Toca CUALQUIER parte de un campo de fecha u hora para abrir su desplegable (no solo el iconito).
document.addEventListener('click', e => {
  const el = e.target.closest('input[type="date"], input[type="time"], input[type="datetime-local"]');
  if (!el || el.readOnly || el.disabled) return;
  if (typeof el.showPicker === 'function') { try { el.showPicker(); } catch (x) {} }
});
// Visor rápido de imágenes (lightbox): amplía una foto SIN abrir otra pestaña. Cualquier
// elemento con data-zoom="<url>" lo activa (p. ej. las fotos de los partes de mantenimiento).
function openLightbox(src) {
  const bg = document.createElement('div');
  bg.className = 'lightbox';
  bg.innerHTML = `<img src="${src}" alt=""><button class="lightbox__x" type="button" aria-label="Cerrar">✕</button>`;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  bg.addEventListener('click', ev => { if (ev.target === bg || ev.target.closest('.lightbox__x')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bg);
}
document.addEventListener('click', e => { const z = e.target.closest('[data-zoom]'); if (z) { e.preventDefault(); openLightbox(z.getAttribute('data-zoom')); } });
// Ojito de contraseña: muestra/oculta lo escrito en el campo de contraseña de al lado.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-pwtoggle]'); if (!t) return;
  e.preventDefault();
  const inp = t.parentElement.querySelector('input'); if (!inp) return;
  const show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; t.textContent = show ? '🙈' : '👁';
});

/* chips reutilizables */
const dot = (color, title) => `<span class="dot" style="background:${color}" title="${esc(title || '')}"></span>`;
const locBadge = ev => { const l = S.locById[ev.lugar]; return l ? `<span class="loc-badge" style="background:${esc(l.colorHex || '#777')}">${esc(l.name)}</span>` : (ev.lugarOtro ? `Otro (${esc(ev.lugarOtro)})` : '—'); };
function pagoChip(ev) {
  if (ev.pagoCliente === undefined) return '—'; // perfil sin acceso a importes
  const pend = (+ev.pagoCliente || 0) - (+ev.pagado || 0);
  if (!ev.pagoCliente) return dot('#F6BF26', 'Importe no indicado');
  if (pend <= 0) return ev.metodo === 'Efectivo' ? `<span class="dot dot--e" style="background:#0B8043" title="Abonado (efectivo)">E</span>` : dot('#0B8043', 'Abonado');
  return dot('#D50000', 'Pendiente: ' + pend + ' €');
}

/* =========================================================================
   ROUTER
   ========================================================================= */
const routes = [];
const on = (re, fn) => routes.push([re, fn]);
function route() {
  // Enlaces de los correos: funcionan SIEMPRE, aunque ya haya una sesión abierta
  // (p. ej. un admin probando). Crear/restablecer contraseña y autologin mágico.
  const hraw = location.hash || '#/';
  if (hraw.startsWith('#/activar')) return renderActivate();
  if (hraw.startsWith('#/recuperar')) return renderForgot();
  if (hraw.startsWith('#/albaran')) return albaranAutologin();
  if (!S.user) return renderAuth();
  const h = hraw.split('?')[0];
  const r = routes.find(([re]) => re.test(h));
  markActive();
  if (!r) return shell(`<div class="empty"><span class="script">Nada por aquí</span>Esa página no existe. <a href="#/">Volver al inicio</a></div>`, ['No encontrado']);
  Promise.resolve(r[1](h.match(r[0]))).catch(err => {
    if (err.status === 401) { S.user = null; return renderAuth(); }
    shell(`<div class="empty"><span class="script">Ups</span>${esc(err.message || 'Error')}</div>`, ['Error']);
  });
  window.scrollTo(0, 0);
}
const loading = (crumbs) => shell('<div class="loading">Cargando…</div>', crumbs);

/* ---- Inicio / dashboard por rol ---- */
on(/^#\/$/, async () => {
  loading(['Inicio']);
  if (S.user.role === 'admin') return dashboardAdmin();
  if (S.user.role === 'dj') return dashboardDj();
  return dashboardSimple();
});
async function dashboardAdmin() {
  const [pend, alerts, vac, itv, dup, exr] = await Promise.all([
    api('events'),
    api('price-alerts').catch(() => ({ groups: [], totalCombos: 0 })),
    api('vacation-conflicts').catch(() => ({ conflicts: [], total: 0 })),
    api('itv-alerts').catch(() => ({ vehicles: [], total: 0 })),
    api('staff-conflicts').catch(() => ({ conflicts: [], total: 0 })),
    api('extra-requests').catch(() => ({ requests: [], pending: 0 })),
  ]);
  const upcoming = pend.events.filter(e => e.fecha >= ymd(TODAY)).sort((a, b) => a.fecha.localeCompare(b.fecha));
  const next = upcoming.slice(0, 8);
  const in7 = upcoming.filter(e => e.fecha <= ymd(addDays(TODAY, 7))).length;
  const sinDj = pend.events.filter(e => !djOf(e)).length;
  shell(`${pageHead('Hola, ' + (S.user.name || '').split(' ')[0], 'Tus próximas bodas de un vistazo.')}
    ${extraReqPanel(exr)}
    ${dupPanel(dup)}
    ${vacationPanel(vac)}
    ${itvPanel(itv)}
    ${priceAlertPanel(alerts)}
    <div class="grid-3">
      <div class="stat stat--pink"><div class="k">Bodas pendientes</div><div class="v">${pend.events.length}</div></div>
      <div class="stat stat--blue"><div class="k">En los próximos 7 días</div><div class="v">${in7}</div></div>
      <div class="stat stat--yellow"><div class="k">Sin DJ asignado</div><div class="v">${sinDj}</div></div>
    </div>
    <div class="panel"><div class="panel__head"><h2>Próximas bodas</h2><a class="btn btn--sm" href="#/eventos">Ver todas</a></div>
      <div class="panel__body" style="padding:0">${eventMiniList(next)}</div></div>`, ['Inicio']);
  wirePriceAlerts();
  wireDupAck();
}
/* Aviso: solicitudes de extras pendientes de aceptar/declinar (lo piden los novios). */
function extraReqPanel(x) {
  if (!x || !x.pending) return '';
  return `<a class="panel va-panel va-panel--alert extra-req-panel" href="#/extras"><div class="panel__head"><h2>❗ Solicitudes de extras por revisar</h2><span class="pa-sum">${x.pending} pendiente${x.pending > 1 ? 's' : ''}</span></div>
    <div class="panel__body"><p class="hint" style="margin:0">Los novios han solicitado <b>${x.pending}</b> servicio${x.pending > 1 ? 's' : ''} extra. Acéptalo o decláralo según disponibilidad. <b>Ir a Servicios extras →</b></p></div></a>`;
}
/* Aviso: DJ/técnico asignado a 2+ bodas el mismo día (excepto quienes sí pueden). */
function dupPanel(d) {
  if (!d || !d.total) return '';
  const rows = d.conflicts.map(c => `<div class="va-row">
      <span><b>${esc(c.workerName)}</b> en ${c.events.length} bodas el mismo día</span>
      <span class="va-when">· ${dmy(c.date)} · ${c.events.map(e => `<a href="#/eventos/${e.id}">#${e.id}${e.conyuges ? ' (' + esc(e.conyuges) + ')' : ''}</a>`).join(' · ')}</span>
      <button class="btn btn--sm" data-dupack data-w="${c.workerId}" data-d="${c.date}" title="Ocultar este aviso (ya está avisado)">Marcar como avisado</button></div>`).join('');
  return `<div class="panel va-panel va-panel--alert"><div class="panel__head"><h2>🚨 DJ/técnico duplicado el mismo día</h2><span class="pa-sum">${d.total} aviso${d.total > 1 ? 's' : ''}</span></div>
    <div class="panel__body"><p class="hint" style="margin-bottom:10px">Un mismo DJ o técnico está asignado a <b>más de una boda el mismo día</b>. Revisa las asignaciones. Si ese caso ya está avisado y es correcto, pulsa <b>Marcar como avisado</b> para ocultarlo.</p>${rows}</div></div>`;
}
function wireDupAck() {
  $$('[data-dupack]').forEach(b => b.onclick = () => {
    api('dup-ack', { method: 'POST', body: { workerId: +b.dataset.w, date: b.dataset.d } })
      .then(() => { toast('Aviso ocultado', 'ok'); route(); })
      .catch(() => toast('No se pudo', 'err'));
  });
}
/* Aviso: boda próxima con alguien asignado que está de vacaciones ese día. */
function vacationPanel(v) {
  if (!v || !v.total) return '';
  const rows = v.conflicts.map(c => `<div class="va-row">
      <span><b>${esc(c.workerName)}</b> está de vacaciones</span>
      <span class="va-when">· boda #${c.evId}${c.conyuges ? ' · ' + esc(c.conyuges) : ''} el ${dmy(c.fecha)}</span>
      <a class="va-badge" href="#/eventos/${c.evId}">Ver boda</a></div>`).join('');
  return `<div class="panel va-panel"><div class="panel__head"><h2>🏖️ DJ/técnico asignado de vacaciones</h2><span class="pa-sum">${v.total} aviso${v.total > 1 ? 's' : ''}</span></div>
    <div class="panel__body"><p class="hint" style="margin-bottom:10px">Estas bodas tienen asignado a alguien que está de vacaciones ese día. Revisa la asignación.</p>${rows}</div></div>`;
}
/* Aviso: vehículos con ITV caducada o a punto de caducar (15 días o menos). */
function itvPanel(v) {
  if (!v || !v.total) return '';
  const rows = v.vehicles.map(x => {
    const cad = x.days < 0;
    const estado = cad ? `<span class="tag tag--red">ITV caducada hace ${-x.days} día${x.days === -1 ? '' : 's'}</span>` : `<span class="tag tag--yellow">Caduca en ${x.days} día${x.days === 1 ? '' : 's'}</span>`;
    return `<div class="va-row"><span><b>${esc(x.plate)}</b> · ${esc(x.brand)} ${esc(x.model)}</span><span class="va-when">· ITV ${dmy(x.itvDate)}</span>${estado}</div>`;
  }).join('');
  return `<div class="panel va-panel"><div class="panel__head"><h2>🚗 ITV por caducar</h2><span class="pa-sum">${v.total} vehículo${v.total > 1 ? 's' : ''}</span></div>
    <div class="panel__body"><p class="hint" style="margin-bottom:10px">Estos vehículos tienen la ITV caducada o a punto de caducar (15 días o menos). <a href="#/vehiculos">Ver vehículos</a></p>${rows}</div></div>`;
}
/* Aviso: técnicos/DJs con servicios asignados sin precio configurado. */
function priceAlertPanel(a) {
  if (!a || !a.totalCombos) return '';
  const rows = a.groups.map(g => `<div class="pa-worker">
      <div class="pa-worker__h">${esc(g.name)} <span class="pa-badge">${g.services.length} sin precio</span></div>
      ${g.services.map(s => `<div class="pa-row">
        <span class="pa-svc">${esc(s.name)}</span>
        <span class="pa-ev">${s.count} boda${s.count > 1 ? 's' : ''}</span>
        <button class="btn btn--sm btn--primary" data-pfix data-w="${g.workerId}" data-s="${s.serviceId}" data-wn="${esc(g.name)}" data-sn="${esc(s.name)}" data-c="${s.count}">Añadir precio</button>
      </div>`).join('')}
    </div>`).join('');
  return `<div class="panel pa-panel"><div class="panel__head"><h2>⚠ Precios por revisar</h2><span class="pa-sum">${a.totalCombos} servicios · ${a.totalWorkers} trabajadores</span></div>
    <div class="panel__body"><p class="hint" style="margin-bottom:10px">Estos técnicos y DJs están asignados a servicios en bodas <b>de hoy en adelante</b> para los que <b>no tienen precio asignado</b>. Añade su precio para que se sume a su facturación cuando se realice el evento.</p>
    <div class="pa-list">${rows}</div></div></div>`;
}
function wirePriceAlerts() {
  $$('[data-pfix]').forEach(b => b.onclick = () => {
    const d0 = b.dataset;
    modal('Añadir precio · ' + d0.wn, `<form id="pfixForm">
      <p class="hint">Servicio: <b>${esc(d0.sn)}</b><br>Bodas afectadas (de hoy en adelante): <b>${esc(d0.c)}</b></p>
      <div class="field"><label>Precio por servicio (€)</label><input class="control" id="pfAmount" type="number" placeholder="Ej: 60"></div>
      <p class="hint">Se guarda como precio estándar de este servicio para ${esc(d0.wn)} y se aplicará a su facturación cuando se realicen esas bodas.</p></form>`,
      { okText: 'Guardar', onOk: () => {
        const raw = String((($('#pfAmount') || {}).value || '')).trim();
        if (raw === '' || isNaN(+raw) || +raw < 0) { toast('Indica un importe válido (0 o más)', 'err'); return true; }
        api('price-fix', { method: 'POST', body: { workerId: +d0.w, serviceId: +d0.s, amount: +raw } })
          .then(() => { toast('Precio guardado', 'ok'); route(); })
          .catch(() => toast('No se pudo guardar', 'err'));
      } });
  });
}
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
async function dashboardDj() {
  const tt = !!(S.user && S.user.time_tracking);  // solo quien ficha horas ve "Horas este mes"
  const [ev, bal] = await Promise.all([api('events'), api('finance/me').catch(() => ({}))]);
  const next = ev.events.sort((a, b) => a.fecha.localeCompare(b.fecha)).slice(0, 8);
  shell(`${pageHead('Hola, ' + (S.user.name || '').split(' ')[0], 'Tus próximos eventos y tu actividad.')}
    <div class="grid-3">
      <div class="stat stat--pink"><div class="k">Eventos próximos</div><div class="v">${ev.events.length}</div></div>
      <div class="stat stat--blue"><div class="k">Pendiente de cobro</div><div class="v">${bal.history ? fmtEur(bal.history.rest - (bal.payments || []).reduce((t, p) => t + (+p.amount || 0), 0)) : '—'}</div></div>
      ${tt ? `<div class="stat stat--yellow"><div class="k">Horas este mes</div><div class="v" id="hMes">—</div></div>` : ''}
    </div>
    <div class="panel"><div class="panel__head"><h2>Tus próximos eventos</h2></div><div class="panel__body" style="padding:0">${eventMiniList(next)}</div></div>`, ['Inicio']);
  if (tt) api('attendance-summary').then(s => { const r = (s.rows || [])[0]; if (r && el('hMes')) el('hMes').textContent = hm(r.m0) + ' h'; }).catch(() => {});
}
// Datos de contacto de Conecta So (visibles para el cliente en su Inicio).
const CS_CONTACT = { phone: '674 758 989', wa: '34674758989', email: 'comercial@conectaso.es', web: 'https://www.conectaso.es', ig: 'https://www.instagram.com/conecta.so/' };
async function dashboardSimple() {
  const ev = await api('events');
  const list = ev.events;
  if (S.user.role === 'planner') {
    shell(`${pageHead('Hola, ' + (S.user.name || '').split(' ')[0], 'Las bodas en las que estás asignado/a.')}
      <div class="panel"><div class="panel__head"><h2>Mis bodas</h2></div><div class="panel__body" style="padding:0">${eventMiniList(list)}</div></div>`, ['Inicio']);
    return;
  }
  // Cliente (novios): pantalla de bienvenida con información y contacto antes de entrar a su boda.
  // Traduce según el idioma elegido (LANG_IDX: ca=0, en=1, fr=2; 'es' u otro → castellano).
  const T = (es, ca, en, fr) => { const i = LANG_IDX[S.lang]; return i == null ? es : ([ca, en, fr][i] || es); };
  const first = (S.user.name || '').split(' ')[0];
  const enterBtns = list.length
    ? list.map(e => `<a class="btn btn--primary btn--lg" href="#/eventos/${e.id}">${T('Entrar en mi boda', 'Entrar a la meva boda', 'Enter my wedding', 'Entrer dans mon mariage')}${list.length > 1 ? ' · ' + esc(e.conyuges || dmy(e.fecha)) : ''}</a>`).join(' ')
    : `<span class="muted">${T('Todavía no tienes ninguna boda asignada.', 'Encara no tens cap boda assignada.', "You don't have any wedding assigned yet.", "Vous n'avez encore aucun mariage attribué.")}</span>`;
  shell(`<div class="cli-welcome">
      <div class="cli-welcome__hero">
        <img class="cli-welcome__logo" src="assets/brand/logo-principal-azul.svg" alt="Conecta So">
        <h1>${T('¡Hola, ' + first + '!', 'Hola, ' + first + '!', 'Hi ' + first + '!', 'Bonjour ' + first + ' !')}</h1>
        <p class="cli-welcome__lead">${T(
          'Bienvenido/a a vuestro espacio de Conecta So. Aquí preparáis toda la música y los detalles de vuestra boda: ceremonia, aperitivo, banquete y fiesta. Rellenadlo con calma, se guarda automáticamente y podéis volver siempre que queráis.',
          'Benvingut/da al vostre espai de Conecta So. Aquí prepareu tota la música i els detalls de la vostra boda: cerimònia, aperitiu, banquet i festa. Ompliu-ho amb calma, es desa automàticament i podeu tornar sempre que vulgueu.',
          'Welcome to your Conecta So space. Here you prepare all the music and details of your wedding: ceremony, aperitif, banquet and party. Fill it in calmly — it saves automatically and you can come back whenever you like.',
          'Bienvenue dans votre espace Conecta So. Vous y préparez toute la musique et les détails de votre mariage : cérémonie, apéritif, banquet et fête. Remplissez-le tranquillement, tout est enregistré automatiquement et vous pouvez revenir quand vous voulez.')}</p>
        <div class="cli-welcome__cta">${enterBtns}</div>
      </div>
      <div class="cli-welcome__contact">
        <h3>${T('¿Alguna duda? Hablamos', 'Algun dubte? En parlem', 'Any questions? Let us talk', 'Une question ? Parlons-en')}</h3>
        <div style="text-align:center;margin-bottom:16px"><a class="ig-follow" href="${CS_CONTACT.ig}" target="_blank" rel="noopener"><span class="ig-follow__ic">📸</span> ${T('Seguir en Instagram', 'Segueix-nos a Instagram', 'Follow on Instagram', 'Suivez-nous sur Instagram')} <b>@conecta.so</b></a></div>
        <div class="cli-contact-grid">
          <a class="cli-contact" href="https://wa.me/${CS_CONTACT.wa}" target="_blank" rel="noopener"><span class="cli-contact__ic">💬</span><span><b>WhatsApp</b><br>${CS_CONTACT.phone}</span></a>
          <a class="cli-contact" href="tel:+${CS_CONTACT.wa}"><span class="cli-contact__ic">📞</span><span><b>${T('Teléfono', 'Telèfon', 'Phone', 'Téléphone')}</b><br>${CS_CONTACT.phone}</span></a>
          <a class="cli-contact" href="mailto:${CS_CONTACT.email}"><span class="cli-contact__ic">✉️</span><span><b>Email</b><br>${CS_CONTACT.email}</span></a>
          <a class="cli-contact" href="${CS_CONTACT.ig}" target="_blank" rel="noopener"><span class="cli-contact__ic">📸</span><span><b>Instagram</b><br>@conecta.so</span></a>
          <a class="cli-contact" href="${CS_CONTACT.web}" target="_blank" rel="noopener"><span class="cli-contact__ic">🌐</span><span><b>${T('Nuestra web', 'El nostre web', 'Our website', 'Notre site')}</b><br>www.conectaso.es</span></a>
        </div>
      </div>
    </div>`, ['Inicio']);
}
function eventMiniList(list) {
  if (!list.length) return `<div class="empty"><span class="script">Nada aún</span>No hay eventos para mostrar.</div>`;
  return `<div class="table-wrap" style="border:0"><table class="dt"><tbody>${list.map(e => `<tr onclick="location.hash='#/eventos/${e.id}'" style="cursor:pointer">
    <td><b>${esc(e.conyuges || e.tipo)}</b><br><span style="color:var(--muted)">#${e.id} · ${esc(e.tipo)}</span></td>
    <td>${dmy(e.fecha)}<br><span style="color:var(--muted)">${esc(e.hora || '')}</span></td>
    <td>${locBadge(e)}</td>
    <td>${djOf(e) ? esc(djOf(e)) : '<span style="color:var(--muted)">Sin DJ</span>'}</td>
    ${S.user.role === 'admin' ? `<td>${dot(estado(e.estado).c, estado(e.estado).n)}</td><td>${pagoChip(e)}</td>` : ''}
  </tr>`).join('')}</tbody></table></div>`;
}

/* El resto de páginas se cargan desde módulos añadidos abajo */
window.__CS = { S, api, shell, pageHead, table, refreshTable, bindTable, toast, modal, copyText, esc, fmtEur, dmy, slash, ymd, pad, TODAY, MONTHS, hm, toMin,
  estado, locName, locBadge, extraName, userName, djOf, dot, pagoChip, svg, roleLabel, tycTitleYear, on, loading, eventMiniList, rebuildMaps, loadContext, $, $$ };

boot();
})();
