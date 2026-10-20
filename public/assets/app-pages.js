'use strict';
/* ============================================================================
   Páginas del gestor (se apoyan en lo publicado por app.js en window.__CS).
   ============================================================================ */
(function () {
const CS = window.__CS;
const { S, api, shell, pageHead, table, refreshTable, toast, modal, esc, fmtEur, dmy, slash, ymd, pad, TODAY, MONTHS, hm, toMin,
  estado, locBadge, extraName, userName, djOf, dot, pagoChip, svg, roleLabel, on, loading, eventMiniList, rebuildMaps, loadContext, $, $$ } = CS;
const isAdmin = () => S.user.role === 'admin';
const el = id => document.getElementById(id);
// Traducción directa de bloques largos del cliente (con negritas/importes), que el
// traductor por nodos no puede cubrir. Solo traduce para novios/wedding planner.
// Trabajadores que cobran por horas (no por boda): ven un "parte de horas" en vez del albarán normal.
const HOURLY_IDS = { 1251: true }; // Josep ayudante
// Momentos para etiquetar los archivos subidos (valor guardado en castellano, etiqueta traducida).
const FILE_MOMENTS = [
  ['', ['Sin momento concreto', 'Sense moment concret', 'No specific moment', 'Aucun moment précis']],
  ['Entrada ceremonia', ['Entrada ceremonia', 'Entrada cerimònia', 'Ceremony entrance', 'Entrée cérémonie']],
  ['Anillos', ['Anillos', 'Anells', 'Rings', 'Alliances']],
  ['Firmas', ['Firmas', 'Signatures', 'Signing', 'Signatures']],
  ['Salida ceremonia', ['Salida ceremonia', 'Sortida cerimònia', 'Ceremony exit', 'Sortie cérémonie']],
  ['Aperitivo', ['Aperitivo', 'Aperitiu', 'Aperitif', 'Apéritif']],
  ['Entrada banquete', ['Entrada al banquete', 'Entrada al banquet', 'Banquet entrance', 'Entrée au banquet']],
  ['Primer plato', ['Primer plato', 'Primer plat', 'First course', 'Entrée']],
  ['Postre / Tarta', ['Postre / Tarta', 'Postres / Pastís', 'Dessert / Cake', 'Dessert / Gâteau']],
  ['Regalo', ['Regalo / Sorpresa', 'Regal / Sorpresa', 'Gift / Surprise', 'Cadeau / Surprise']],
  ['Baile nupcial', ['Baile nupcial', 'Ball nupcial', 'First dance', 'Danse nuptiale']],
  ['Fiesta', ['Fiesta', 'Festa', 'Party', 'Fête']],
  ['Otro', ['Otro', 'Altre', 'Other', 'Autre']],
];
const _tLang = () => (S.user && (S.user.role === 'user' || S.user.role === 'planner')) ? (S.lang || 'es') : 'es';
const tt = (es, ca, en, fr) => ({ es: es, ca: ca || es, en: en || es, fr: fr || es }[_tLang()] || es);
// la boda ha finalizado: a partir de las 00:00 del día siguiente a la fecha de la boda
// Una boda se considera finalizada al DÍA SIGUIENTE a las 05:00 (hora local): hasta entonces sigue pendiente.
const bizToday = () => { const d = new Date(Date.now() - 5 * 3600000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const eventFinished = ev => !!(ev && ev.fecha && ev.fecha < bizToday());

/* catálogos del formulario de evento */
const MUSIC_AREAS = [
  { key: 'ceremony', title: 'Ceremonia', sec: 'C', moments: [['first_spouse_entry', 'Entrada primer cónyuge'], ['second_spouse_entry', 'Entrada segundo cónyuge'], ['rings', 'Anillos'], ['signatures', 'Firmas'], ['exit', 'Salida'], ['readings', 'Lecturas']] },
  { key: 'aperitif', title: 'Aperitivo', sec: 'A', moments: [['entry', 'Entrada de novios']] },
  { key: 'banquet', title: 'Banquete', sec: 'B', moments: [['entry', 'Entrada de novios'], ['first', 'Primer plato'], ['second', 'Segundo plato'], ['sorbet', 'Sorbete'], ['dessert', 'Postre'], ['cake_presentation', 'Presentación tarta nupcial'], ['cake', 'Tarta nupcial']] },
];
const DISCO_MOMENTS = [['dance', 'Baile nupcial'], ['last_song', 'Última canción de fiesta']];
// Recomendaciones: playlists reales de Conecta So (de la intranet) con propuestas por momento.
const MUSIC_RECS = [
  ['Entrada novi@s ceremonia', 'https://open.spotify.com/playlist/51OdjSmATezd3E56mKq0OE'],
  ['Anillos', 'https://open.spotify.com/playlist/53RabRhLRNuND6N0f9ZdtC'],
  ['Lecturas y firmas', 'https://open.spotify.com/playlist/53mZxWQkPS0zEdJl0FZa9V'],
  ['Salida ceremonia', 'https://open.spotify.com/playlist/0NAaY9YJwXhs9uN4Q4mULJ'],
  ['Entrada aperitivo o salón', 'https://open.spotify.com/playlist/2k8R2QLj6GavwoSDW6jqbX'],
  ['Salida platos', 'https://open.spotify.com/playlist/2X6ebp6h1RIHLLa4xE22Le'],
  ['Pastel', 'https://open.spotify.com/playlist/6BmSb32coeM2b6IJYRzvX4'],
  ['Brindis', 'https://open.spotify.com/playlist/4RI6oQ69ag4i8GcDPz2AQy'],
  ['Regalo madres o padres', 'https://open.spotify.com/playlist/3n3vHONNoDwLTSWynWocGi'],
  ['Regalo hermano/as', 'https://open.spotify.com/playlist/07jGMeNeNN3HUrVUFTx0zR'],
  ['Liga', 'https://open.spotify.com/playlist/3bm634qIx2h1TfqQ6wJckg'],
  ['Versiones cañeras (REMIX)', 'https://open.spotify.com/playlist/4c4xsTgcUAfQ4mshM3HlBo'],
  ['Baile nupcial', 'https://open.spotify.com/playlist/7K4ko4nbOk9xE1mCJxowmA'],
];
// Algunas fincas tienen momentos musicales distintos. Can Ribas (ceremonia con votos y entrada de vehículo;
// banquete con 1ª/2ª degustación). El resto de fincas (incl. Can Oliver) usan la estructura estándar (MUSIC_AREAS).
const RIBAS_AREAS = [
  { key: 'ceremony', title: 'Ceremonia', sec: 'C', moments: [['first_spouse_entry', 'Entrada primer cónyuge'], ['second_spouse_entry', 'Entrada segundo cónyuge'], ['rings', 'Anillos'], ['signatures', 'Firmas'], ['exit', 'Salida'], ['readings', 'Lecturas'], ['vehicle_entry', 'Entrada vehículo 2º cónyuge'], ['vows', 'Votos']] },
  { key: 'aperitif', title: 'Aperitivo', sec: 'A', moments: [['entry', 'Entrada de novios']] },
  { key: 'banquet', title: 'Banquete', sec: 'B', moments: [['entry', 'Entrada de novios'], ['first', 'Primer plato'], ['first_tasting', '1ª degustación'], ['second_tasting', '2ª degustación'], ['cake', 'Tarta nupcial']] },
];
// Can Oliver (todas sus variantes): el banquete lleva Vino blanco y Vino tinto (config correcta de "Can Oliver Carpa").
const OLIVER_AREAS = [
  { key: 'ceremony', title: 'Ceremonia', sec: 'C', moments: [['first_spouse_entry', 'Entrada primer cónyuge'], ['second_spouse_entry', 'Entrada segundo cónyuge'], ['rings', 'Anillos'], ['signatures', 'Firmas'], ['exit', 'Salida'], ['readings', 'Lecturas']] },
  { key: 'aperitif', title: 'Aperitivo', sec: 'A', moments: [['entry', 'Entrada de novios']] },
  { key: 'banquet', title: 'Banquete', sec: 'B', moments: [['entry', 'Entrada de novios'], ['wine_white', 'Vino blanco'], ['first', 'Primer plato'], ['sorbet', 'Sorbete'], ['second', 'Segundo plato'], ['wine_red', 'Vino tinto'], ['cake', 'Tarta nupcial']] },
];
// Can Oliver: extras que los novios NO pueden ver (fuego frío y tarima)
const OLIVER_HIDE_EXTRAS = ['extra_maquinas_fuego_frio', 'extra_servicio_de_tarima'];
const RIBAS_IDS = [14, 15, 16];          // Can Ribas Cirerers / Oliveres / Exclusivo
const OLIVER_IDS = [8, 25, 26, 27];      // Can Oliver Carpa / 200 / 400 / Rústico
const isRibas = ev => RIBAS_IDS.includes(+((ev && ev.lugar) || 0));
const isOliver = ev => OLIVER_IDS.includes(+((ev && ev.lugar) || 0));
const musicAreasFor = ev => isRibas(ev) ? RIBAS_AREAS : (isOliver(ev) ? OLIVER_AREAS : MUSIC_AREAS);
// base de las imágenes reales de los servicios extra (públicas en el servidor de Conecta So)
const EXTRA_IMG = 'https://intranet.conectaso.es/public/images/extras/';
// [clave, nombre, descripción, icono] — igual que en la intranet (la foto real se carga desde EXTRA_IMG)
const EXTRAS_CLIENTE = [
  ['extra_fotomaton', 'Fotomatón', 'Una forma original de crear recuerdos: cámara de alta definición, caja de atrezzo y disfraces, e impresión de las fotos en tiras personalizables. Os enviamos copia de todas las fotos por e-mail.', '📸'],
  ['extra_videomaton', 'Videomatón 360 grados', 'Cámara sobre un brazo que gira 360º captando movimientos y bailes. Vídeo personalizado (nombres, fecha) que se envía a cada invitado por código QR.', '🎥'],
  ['extra_hora_loca_animacion', 'Hora loca animación', '2 animadores para dar el show durante la fiesta: chupitos, limbo, palos y gafas led, globos, silbatos y bengalas frías para un fiestón.', '🎉'],
  ['extra_pistola_co2', 'Pistolas CO₂', 'Efecto megatrón manejado por los novios o los DJs, para que tu boda sea un tomorrowland.', '💨'],
  ['extra_maquinas_fuego_frio', '2 máquinas fuego frío', 'Momentos increíbles, fotos espectaculares y efecto WOW entre los invitados. Muy recomendable para el baile nupcial.', '🎆'],
  ['extra_maquinas_humo_vertical_led', '2 máquinas de humo vertical con led', '¿Sumamos contenido a la fiesta con un poco de humo iluminado?', '🌫️'],
  ['extra_photocall_sofa_chester_letras_led', 'Photocall sofá chester + letras led', 'Un espacio único donde hacerse fotos con los invitados, con 3 frases a elegir.', '🛋️'],
  ['extra_iluminacion_ambiental_led', 'Iluminación ambiental fachadas led colores', 'Decora con color las zonas donde quieras, personalizable en el color que elijas.', '💡'],
  ['extra_burbujas_humo_interior', 'Burbujas con humo en su interior', '¿Quieres darle un toque diferente a la entrada al aperitivo o al baile nupcial?', '🫧'],
  ['extra_confeti', 'Servicio de confeti (a consultar permiso con el lugar)', 'Consigue 3 momentos WOW en diferentes momentos de la boda.', '🎊'],
  ['extra_servicio_de_tarima', 'Servicio de tarima', 'Que el DJ esté en alto siempre mola. Convierte tu boda en todo un espectáculo.', '🎚️'],
  ['extra_servicio_de_suelo_led', 'Servicio de suelo led', 'Sorprende a los invitados con un suelo led: fotos espectaculares y una zona de baile diferente.', '🟦'],
  ['extra_servicio_de_proyeccion', 'Servicio de proyección', '¿Tienes que proyectar un vídeo? Avísanos para estar preparados.', '📽️'],
  ['extra_humo_bajo', 'Humo bajo', 'Niebla cerca del suelo para el baile nupcial: un efecto nube espectacular.', '🌁'],
  ['extra_lanzadores_humo_aereo', 'Lanzadores de humo aéreo', 'Humos aéreos de colores que se elevan por el aire. Un toque de magia para el evento.', '🎇'],
];
// --- traducciones de los extras (nombre y descripción) para ca / en / fr ---
const EXTRAS_I18N = {
  extra_fotomaton: { ca: ['Fotomatón', "Una manera original de crear records: càmera d'alta definició, caixa d'attrezzo i disfresses, i impressió de les fotos en tires personalitzables. Us enviem còpia de totes les fotos per e-mail."], en: ['Photo booth', 'An original way to create memories: high-definition camera, props and costume box, and prints of the photos on customisable strips. We email you a copy of all the photos.'], fr: ['Photomaton', "Une façon originale de créer des souvenirs : caméra haute définition, boîte d'accessoires et déguisements, et impression des photos sur des bandes personnalisables. Nous vous envoyons une copie de toutes les photos par e-mail."] },
  extra_videomaton: { ca: ['Videomatón 360 graus', "Càmera sobre un braç que gira 360º captant moviments i balls. Vídeo personalitzat (noms, data) que s'envia a cada convidat per codi QR."], en: ['360-degree video booth', 'Camera on an arm that spins 360º capturing movements and dancing. Personalised video (names, date) sent to each guest via QR code.'], fr: ['Vidéomaton 360 degrés', 'Caméra sur un bras qui tourne à 360º en captant les mouvements et les danses. Vidéo personnalisée (noms, date) envoyée à chaque invité par code QR.'] },
  extra_hora_loca_animacion: { ca: ['Hora boja animació', "2 animadors per donar l'espectacle durant la festa: xopets, limbo, pals i ulleres led, globus, xiulets i bengales fredes per a una gran festa."], en: ['Crazy hour animation', '2 entertainers to put on a show during the party: shots, limbo, LED sticks and glasses, balloons, whistles and cold sparklers for a huge party.'], fr: ['Heure folle animation', '2 animateurs pour faire le show pendant la fête : shots, limbo, bâtons et lunettes led, ballons, sifflets et feux froids pour une grande fête.'] },
  extra_pistola_co2: { ca: ['Pistoles CO₂', 'Efecte megatró manejat pels nuvis o els DJs, perquè la teva boda sigui un tomorrowland.'], en: ['CO₂ guns', 'Megatron effect operated by the couple or the DJs, to turn your wedding into a tomorrowland.'], fr: ['Pistolets CO₂', 'Effet mégatron manié par les mariés ou les DJs, pour que votre mariage soit un tomorrowland.'] },
  extra_maquinas_fuego_frio: { ca: ['2 màquines de foc fred', 'Moments increïbles, fotos espectaculars i efecte WOW entre els convidats. Molt recomanable per al ball nupcial.'], en: ['2 cold-fire machines', 'Incredible moments, spectacular photos and a WOW effect among guests. Highly recommended for the first dance.'], fr: ['2 machines à feu froid', 'Des moments incroyables, des photos spectaculaires et un effet WOW parmi les invités. Très recommandé pour la danse nuptiale.'] },
  extra_maquinas_humo_vertical_led: { ca: ['2 màquines de fum vertical amb led', 'Sumem contingut a la festa amb una mica de fum il·luminat?'], en: ['2 vertical smoke machines with LED', 'Shall we add something to the party with a bit of lit-up smoke?'], fr: ['2 machines à fumée verticale avec led', 'On ajoute du contenu à la fête avec un peu de fumée illuminée ?'] },
  extra_photocall_sofa_chester_letras_led: { ca: ['Photocall sofà chester + lletres led', 'Un espai únic on fer-se fotos amb els convidats, amb 3 frases a triar.'], en: ['Chesterfield sofa photocall + LED letters', 'A unique space to take photos with guests, with 3 phrases to choose from.'], fr: ['Photocall canapé chesterfield + lettres led', 'Un espace unique pour prendre des photos avec les invités, avec 3 phrases au choix.'] },
  extra_iluminacion_ambiental_led: { ca: ['Il·luminació ambiental façanes led colors', 'Decora amb color les zones que vulguis, personalitzable en el color que triïs.'], en: ['Ambient façade LED colour lighting', 'Decorate the areas you want with colour, customisable in the colour you choose.'], fr: ["Éclairage d'ambiance façades led couleurs", 'Décorez de couleur les zones que vous voulez, personnalisable dans la couleur de votre choix.'] },
  extra_burbujas_humo_interior: { ca: ["Bombolles amb fum a l'interior", "Vols donar un toc diferent a l'entrada a l'aperitiu o al ball nupcial?"], en: ['Bubbles with smoke inside', 'Want to give a different touch to the entrance to the aperitif or the first dance?'], fr: ["Bulles avec de la fumée à l'intérieur", "Envie de donner une touche différente à l'entrée de l'apéritif ou à la danse nuptiale ?"] },
  extra_confeti: { ca: ['Servei de confeti (a consultar permís amb el lloc)', 'Aconsegueix 3 moments WOW en diferents moments de la boda.'], en: ['Confetti service (permission to be checked with the venue)', 'Get 3 WOW moments at different points of the wedding.'], fr: ['Service de confettis (autorisation à vérifier avec le lieu)', 'Obtenez 3 moments WOW à différents moments du mariage.'] },
  extra_servicio_de_tarima: { ca: ['Servei de tarima', 'Que el DJ estigui enlaire sempre mola. Converteix la teva boda en tot un espectacle.'], en: ['Stage platform service', 'Having the DJ up high always looks great. Turn your wedding into a real show.'], fr: ["Service d'estrade", "Avoir le DJ en hauteur, c'est toujours sympa. Transformez votre mariage en véritable spectacle."] },
  extra_servicio_de_suelo_led: { ca: ['Servei de terra led', 'Sorprèn els convidats amb un terra led: fotos espectaculars i una zona de ball diferent.'], en: ['LED floor service', 'Surprise your guests with an LED floor: spectacular photos and a different dance area.'], fr: ['Service de sol led', 'Surprenez les invités avec un sol led : des photos spectaculaires et une piste de danse différente.'] },
  extra_servicio_de_proyeccion: { ca: ['Servei de projecció', "Has de projectar un vídeo? Avisa'ns per estar preparats."], en: ['Projection service', "Need to project a video? Let us know so we're ready."], fr: ['Service de projection', 'Vous devez projeter une vidéo ? Prévenez-nous pour que nous soyons prêts.'] },
  extra_humo_bajo: { ca: ['Fum baix', 'Boira a prop del terra per al ball nupcial: un efecte núvol espectacular.'], en: ['Low smoke', 'Fog close to the floor for the first dance: a spectacular cloud effect.'], fr: ['Fumée basse', 'Brouillard au ras du sol pour la danse nuptiale : un effet nuage spectaculaire.'] },
  extra_lanzadores_humo_aereo: { ca: ['Llançadors de fum aeri', "Fums aeris de colors que s'eleven per l'aire. Un toc de màgia per a l'esdeveniment."], en: ['Aerial smoke launchers', 'Coloured aerial smoke that rises into the air. A touch of magic for the event.'], fr: ['Lanceurs de fumée aérienne', "Fumées aériennes colorées qui s'élèvent dans les airs. Une touche de magie pour l'événement."] },
};
// Acepta tanto la fila completa del extra [clave,nombre,desc,icono] como solo la clave (string).
const _exRow = x => Array.isArray(x) ? x : (EXTRAS_CLIENTE.find(e => e[0] === x) || [x, x, '', '']);
const exName = x => { const r = _exRow(x); const l = _tLang(); const t = l !== 'es' && EXTRAS_I18N[r[0]] && EXTRAS_I18N[r[0]][l]; return t ? t[0] : r[1]; };
const exDesc = x => { const r = _exRow(x); const l = _tLang(); const t = l !== 'es' && EXTRAS_I18N[r[0]] && EXTRAS_I18N[r[0]][l]; return t ? t[1] : (r[2] || ''); };
// --- auto-detección de extras a partir de los servicios asignados al evento ---
const EXTRA_STOP = new Set(['de', 'con', 'y', 'en', 'la', 'el', 'los', 'las', 'x', 'por', 'un', 'una', 'del', 'al', 'a', 'o', 'led', 'servicio', 'servicios', 'maquina', 'maquinas', 'grados', 'su', 'interior', 'ambiental', 'color', 'colores', 'consultar', 'permiso', 'lugar']);
const normX = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const toksX = s => normX(s).split(' ').filter(t => t && !EXTRA_STOP.has(t) && t.length > 1);
// tokens que por sí solos ya identifican el extra (basta 1 coincidencia)
const UNIQUE_X = new Set(['co2', 'fotomaton', 'videomaton', 'confeti', 'tarima', 'burbujas', 'suelo', 'proyeccion', 'proyector', 'aereo', 'aereos', 'chester', 'photocall']);
// Eventos "sencillos" (Corporativo, Extras): sin música ni extras, solo
// datos+observaciones, servicios y costes/facturación. Igual que la intranet real.
function isSimpleEvent(ev) { return /^(corporativ|extras?)/i.test(String((ev && ev.tipo) || '')); }
function extraMatchesService(extraName, svcName) {
  const et = new Set(toksX(extraName)), common = toksX(svcName).filter(t => et.has(t));
  if (common.some(t => UNIQUE_X.has(t))) return true;
  return common.length >= 2;
}
// servicios asignados cuyo nombre coincide con una tarjeta de extra → se marca sola
function autoExtraKeys(ev) {
  const names = (ev.services || []).map(s => extraName(s.servicio)).filter(Boolean);
  const set = {};
  EXTRAS_CLIENTE.forEach(x => { if (names.some(n => extraMatchesService(x[1], n))) set[x[0]] = true; });
  return set;
}
const SEC_OF = { ceremony: 'C', aperitif: 'A', banquet: 'B' };

/* helpers de formulario */
const fg = (label, ctl) => `<label>${label}</label><div>${ctl}</div>`;
const inp = (name, val, { ph = '', type = 'text', ro = false } = {}) => `<input class="control" type="${type}" name="${name}" value="${esc(val ?? '')}" placeholder="${esc(ph)}" ${ro ? 'readonly' : ''}>`;
const sel = (name, opts, val, attr = '') => `<select class="control" name="${name}" ${attr}>${opts.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(t)}</option>`; }).join('')}</select>`;
const ta = (name, val, ph = '') => `<textarea class="control" name="${name}" placeholder="${esc(ph)}">${esc(val ?? '')}</textarea>`;
function collectForm(form) {
  const o = {};
  $$('input,select,textarea', form).forEach(e => { if (!e.name) return; if (e.type === 'checkbox') o[e.name] = e.checked; else if (e.type === 'radio') { if (e.checked) o[e.name] = e.value; else if (!(e.name in o)) o[e.name] = ''; } else o[e.name] = e.value; });
  return o;
}

/* =========================================================================
   LISTA DE EVENTOS
   ========================================================================= */
on(/^#\/eventos$/, () => eventsList(false));
on(/^#\/eventos\/realizados$/, () => eventsList(true));
const DONE_VIEW = { sel: '12m' };  // '12m' | 'all' | '2026' ...
async function eventsList(done) {
  loading(['Eventos', done ? 'Realizadas' : 'Pendientes']);
  const data = await api('events' + (done ? '?status=done' : ''));
  let evs = data.events;
  const admin = isAdmin();
  // Extras = servicios contratados con su responsable, como en la intranet
  const svcList = e => (e.services || []).filter(s => s.servicio);
  const svcHtml = e => { const svc = svcList(e); return svc.length ? `<div class="svc-list">${svc.map(s => `<div><b>${esc(extraName(s.servicio))}</b> → ${esc(userName(s.resp) || '—')}${s.resp2 ? ' y ' + esc(userName(s.resp2)) : ''}</div>`).join('')}</div>` : '<span class="muted">—</span>'; };
  const cols = [
    { t: 'Id', get: e => e.id, html: e => admin ? `<a class="ev-id" href="#/eventos/${e.id}" style="color:${estado(e.estado).c}" title="${esc(estado(e.estado).n)}">${e.id}</a>` : `<a href="#/eventos/${e.id}">${e.id}</a>` },
    ...(admin ? [{ t: 'Tipo', get: e => e.tipo, html: e => `<a href="#/eventos/${e.id}">${esc(e.tipo)}</a>` }] : []),
    { t: 'Cónyuges', get: e => e.conyuges, html: e => `<a href="#/eventos/${e.id}">${esc(e.conyuges || 'No indicado')}</a>` },
    { t: 'Fecha', get: e => e.fecha || '', html: e => slash(e.fecha) },
    { t: 'Hora', get: e => e.hora || '' },
    { t: 'Lugar', get: e => CS.locName(e), html: e => locBadge(e) },
    { t: 'DJ', get: e => djOf(e), html: e => djOf(e) ? esc(djOf(e)) : (admin ? '<span class="no-dj" title="Sin DJ asignado" aria-label="Sin DJ asignado">🚨</span>' : '<span class="muted">—</span>') },
    { t: 'Extras', get: e => svcList(e).map(s => extraName(s.servicio)).join(' '), nofilter: true, html: svcHtml },
  ];
  if (admin) cols.push(
    { t: 'Pago', get: e => '', html: e => pagoChip(e), nosort: true },
    { t: 'Usuario', get: e => clientName(e), html: e => `<a href="#/usuario/${e.userId}" title="Ver ficha del cliente">${e.userId} - ${esc(clientName(e))}</a>` });
  cols.push({ t: '', nosort: true, html: e => `<div class="row-actions"><a class="btn btn--icon" href="#/eventos/${e.id}" title="Abrir / editar">${svg('edit')}</a><a class="btn btn--icon" href="#/eventos/${e.id}/pdf" title="PDF">${svg('doc')}</a>${admin ? `<button class="btn btn--icon" data-del-event="${e.id}" title="Borrar">🗑</button>` : ''}</div>` });
  const title = done ? 'Bodas realizadas' : 'Bodas pendientes';
  const lead = admin ? 'Gestiona todas las bodas y eventos creados.' : (S.user.role === 'planner' ? 'Bodas en las que estás asignado/a.' : 'Tus eventos asignados.');
  let yearBar = '';
  if (done) {
    const years = [...new Set(evs.map(e => (e.fecha || '').slice(0, 4)).filter(Boolean))].sort().reverse();
    const cut = new Date(); cut.setFullYear(cut.getFullYear() - 1); const cutISO = cut.toISOString().slice(0, 10);
    if (DONE_VIEW.sel === '12m') evs = evs.filter(e => (e.fecha || '') >= cutISO);
    else if (DONE_VIEW.sel !== 'all') evs = evs.filter(e => (e.fecha || '').slice(0, 4) === DONE_VIEW.sel);
    const chip = (v, lab) => `<button type="button" class="yrchip${DONE_VIEW.sel === v ? ' on' : ''}" data-yr="${v}">${lab}</button>`;
    yearBar = `<div class="yrbar">${chip('12m', 'Últimos 12 meses')}${years.map(y => chip(y, y)).join('')}${chip('all', 'Todos los años')}</div>`;
  }
  const tblId = done ? 'dtDone_' + DONE_VIEW.sel : 'dtTodo';
  const legend = admin ? `<details class="estado-leg-wrap"><summary>Mostrar leyenda de estados</summary><div class="estado-leg" title="El color del número de evento indica su estado">${(S.meta.estados || []).map(s => `<span><i style="background:${s.c}"></i>${esc(s.n)}</span>`).join('')}</div></details>` : '';
  shell(`${pageHead(title, lead)}<div class="panel"><div class="panel__body">${yearBar}${table(tblId, { rows: evs, order: [3, done ? 'desc' : 'asc'], filters: admin, cols, dense: true, len: 25, empty: 'No hay bodas en esta lista.' })}${legend}</div></div>`, ['Eventos', title]);
  if (admin) $$('[data-del-event]').forEach(b => b.onclick = () => confirmDeleteEvent(+b.dataset.delEvent, done));
  $$('[data-yr]').forEach(b => b.onclick = () => { DONE_VIEW.sel = b.dataset.yr; eventsList(true); });
}
const clientName = e => e.clienteNombre || e.conyuges || userName(e.userId) || 'Cliente';
function confirmDeleteEvent(id, done) {
  modal('Borrar evento', `¿Seguro que quieres eliminar el evento #${id}? Esta acción no se puede deshacer.`, {
    okText: 'Eliminar', danger: true, onOk: async () => { await api('events/' + id, { method: 'DELETE' }); toast('Evento eliminado', 'ok'); eventsList(done); }
  });
}

/* =========================================================================
   FICHA DE EVENTO  (admin = completa · dj/planner/cliente = adaptada)
   ========================================================================= */
on(/^#\/eventos\/(\d+)$/, async m => {
  loading(['Eventos', '#' + m[1]]);
  let data; try { data = await api('events/' + m[1]); } catch (e) { return shell(`<div class="empty"><span class="script">No disponible</span>${esc(e.message)}</div>`, ['Eventos']); }
  const ev = data.event;
  if (isAdmin()) return eventEditorAdmin(ev);
  return eventViewRole(ev);
});

/* ---- editor completo (admin) ---- */
function eventEditorAdmin(ev) {
  const staffOpts = [['', 'Selecciona un usuario']].concat((S.meta.staff || []).map(u => [u.id, u.name]));
  const svcOpts = [['', 'Selecciona un servicio']].concat((S.meta.extras || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'es')).map(x => [x.id, x.name]));
  const locOpts = [[0, 'Selecciona un lugar']].concat((S.meta.locations || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'es')).map(l => [l.id, l.name])).concat([['otro', 'Otro']]);
  const pend = (+ev.pagoCliente || 0) - (+ev.pagado || 0);
  const prog = eventProgress(ev);
  const shiftIso = (iso, n) => { const p = String(iso || '').slice(0, 10).split('-'); if (p.length < 3) return ''; const d = new Date(+p[0], +p[1] - 1, +p[2]); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const simple = isSimpleEvent(ev);
  const lockNotice = (ev.fecha && !simple) ? `<p class="hint evtop-notice">Edición del cliente: se cierra sola el <b>${dmy(shiftIso(ev.fecha, -7))}</b> (7 días antes). Avisos al cliente: ${prog >= 100 ? `solo <b>${dmy(shiftIso(ev.fecha, -15))}</b> (ya está al 100%)` : `<b>${dmy(shiftIso(ev.fecha, -30))}</b> y <b>${dmy(shiftIso(ev.fecha, -15))}</b>`} <span class="muted">· el envío real de email se activa al conectar el dominio</span></p>` : '';
  const adminTabs = simple
    ? `<div class="tabs" id="evTabs"><button data-tab="datos" class="on">Datos</button><button data-tab="servicios">Servicios</button><button data-tab="facturacion">Facturación</button><button data-tab="archivos">Archivos</button></div>`
    : `<div class="tabs" id="evTabs"><button data-tab="datos" class="on">Datos</button><button data-tab="musica">Música</button><button data-tab="extras">Extras</button><button data-tab="servicios">Servicios</button><button data-tab="ruta">Ruta</button><button data-tab="facturacion">Facturación</button><button data-tab="archivos">Archivos</button></div>`;
  const headLabel = simple ? `${esc(ev.tipo)} #${ev.id}` : `Boda #${ev.id}`;
  const body = `<form id="evForm" data-id="${ev.id}">
    <div class="page-head"><div><h1 style="font-size:24px">${headLabel}</h1><div class="lead">${esc(ev.conyuges || 'Sin cónyuges')} · ${dmy(ev.fecha)}</div><div class="page-head__accent"></div></div>
      <div class="btn-row"><a class="btn" href="#/eventos/${ev.id}/pdf">Resumen PDF</a></div></div>
    <div class="panel evtop"><div class="panel__body">
      <div class="evtop-top">
        <div class="field evtop-method"><label>Método de pago</label>
          <div class="radset">
            <label class="chk chk--radio"><input type="radio" name="payment_method" value="Efectivo" ${ev.metodo === 'Efectivo' ? 'checked' : ''}> <span>Efectivo</span></label>
            <label class="chk chk--radio"><input type="radio" name="payment_method" value="Transferencia" ${ev.metodo === 'Transferencia' ? 'checked' : ''}> <span>Transferencia</span></label>
          </div></div>
        <div class="field evtop-estado"><label>Estado</label>${sel('event_status', S.meta.estados.map((s, i) => [i, s.n]), ev.estado)}</div>
        <div class="field evtop-prog"><label>Progreso</label><div class="progress progress--green"><div id="progBar" style="width:${prog}%">${prog}%</div></div></div>
      </div>
      <div class="evtop-pay">
        <div class="field"><label>Pago cliente (€)</label>${inp('event_total_import', ev.pagoCliente)}</div>
        <div class="field"><label>Pagado (€)</label>${inp('event_payed_import', ev.pagado)}</div>
        <div class="field"><label>Pendiente</label><input class="control" readonly value="${pend} €" id="pendField"></div>
      </div>
    </div></div>
    <div class="tabs-row">
      ${adminTabs}
      ${simple ? '' : `<label class="switch switch--onoff edituser-toggle" title="La edición se cierra sola 7 días antes de la boda. Actívala aquí para volver a habilitarla."><span class="edituser-lbl">Edición cliente</span><input type="checkbox" name="habilitar_edicion_para_usuario" ${ev.canEdit ? 'checked' : ''}><span class="track"></span><span class="switch-state">${ev.canEdit ? 'Activado' : 'Desactivado'}</span></label>`}
    </div>
    ${lockNotice}
    <div data-pane="datos">${paneDatos(ev, locOpts)}${simple ? '' : accessBlock(ev)}</div>
    ${simple ? '' : `<div data-pane="musica" style="display:none">${paneMusica(ev, true)}</div>
    <div data-pane="extras" style="display:none">${paneExtras(ev)}</div>`}
    <div data-pane="servicios" style="display:none">${paneServicios(ev, svcOpts, staffOpts)}</div>
    ${simple ? '' : `<div data-pane="ruta" style="display:none">${paneRuta(ev)}</div>`}
    <div data-pane="facturacion" style="display:none">${paneFacturacion(ev)}</div>
    <div data-pane="archivos" style="display:none"><div class="panel"><div class="panel__body" id="filesBox">Cargando archivos…</div></div></div>
    <div class="floatbar">${simple ? '' : '<button type="button" class="btn" id="genPlaylist">Generar playlist</button>'}<button type="submit" class="btn btn--primary">${simple ? 'Guardar evento' : 'Guardar boda'}</button></div>
  </form>`;
  shell(body, ['Eventos', '#' + ev.id]);
  wireEventForm(ev, { full: true });
}

/* ---- vista adaptada (dj / planner / cliente) ---- */
function eventViewRole(ev) {
  const role = S.user.role;
  const isPlanner = role === 'planner';
  // el wedding planner puede editar música, extras y horarios (nunca finca ni fecha)
  const canEditMusic = (role === 'user' && ev.canEdit) || isPlanner;
  const locOpts = [[0, 'Selecciona un lugar']].concat((S.meta.locations || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'es')).map(l => [l.id, l.name])).concat([['otro', 'Otro']]);
  let intro = '';
  if (role === 'user') {
    if (ev.canEdit) {
      // días hasta el cierre de edición (7 días antes de la boda)
      const p = String(ev.fecha || '').slice(0, 10).split('-');
      const dCierre = p.length === 3 ? (new Date(+p[0], +p[1] - 1, +p[2]) - new Date()) / 86400000 - 7 : null;
      const cierreTxt = p.length === 3 ? dmy(new Date(new Date(+p[0], +p[1] - 1, +p[2]).getTime() - 7 * 86400000).toISOString().slice(0, 10)) : '';
      intro = (dCierre != null && dCierre <= 14 && dCierre >= 0)
        ? `<p class="hint cli-hint cli-hint--warn">✏️ La edición se cierra el <b>${cierreTxt}</b> · quedan <b>${Math.ceil(dCierre)} día${Math.ceil(dCierre) === 1 ? '' : 's'}</b>. Recuerda guardar.</p>`
        : `<p class="hint cli-hint">Rellena aquí la música y los detalles de tu boda. Recuerda guardar al terminar.</p>`;
    } else {
      intro = `<p class="hint cli-hint cli-hint--closed"><b>Edición cerrada</b> (desde 7 días antes de la boda). Para cambiar algo, <b>contacta con nosotros</b> y te la reabrimos.</p>`;
    }
  }
  if (role === 'dj') intro = `<div class="alert alert--info">Ficha del evento. Puedes añadir tus observaciones como DJ al final.</div>`;
  if (role === 'planner') intro = `<div class="alert alert--info">Como <b>wedding planner</b> puedes editar la <b>música</b>, los <b>extras</b> y los <b>horarios</b> de la boda. La <b>finca</b> y la <b>fecha</b> solo las cambia administración. Recuerda <b>Guardar</b> al terminar.</div>`;

  const simple = isSimpleEvent(ev);
  const tabs = simple
    ? (role === 'user'
      ? `<div class="tabs" id="evTabs"><button data-tab="datos" class="on">Datos</button><button data-tab="archivos">Archivos</button></div>`
      : `<div class="tabs" id="evTabs"><button data-tab="datos" class="on">Datos</button>${role === 'dj' ? '<button data-tab="servicios">Servicios</button>' : ''}</div>`)
    : (role === 'user'
    ? `<div class="tabs" id="evTabs"><button data-tab="datos" class="on">Datos</button><button data-tab="musica">Música</button><button data-tab="extras">Extras</button><button data-tab="archivos">Archivos</button></div>`
    : `<div class="tabs" id="evTabs"><button data-tab="datos" class="on">Datos</button><button data-tab="musica">Música</button><button data-tab="extras">Extras</button>${role === 'dj' ? '<button data-tab="servicios">Servicios</button><button data-tab="ruta">Ruta</button>' : ''}</div>`);
  const panes = `
    <div data-pane="datos">${paneDatos(ev, locOpts, { readonly: !(role === 'user' && ev.canEdit), horariosEditable: isPlanner })}${role === 'user' ? clientPaymentBlock(ev) + accessBlock(ev) : ''}</div>
    ${simple ? '' : `<div data-pane="musica" style="display:none">${paneMusica(ev, canEditMusic)}</div>
    <div data-pane="extras" style="display:none">${paneExtras(ev, { readonly: !canEditMusic })}</div>`}
    ${role === 'dj' ? `<div data-pane="servicios" style="display:none">${paneServicios(ev, null, null, { readonly: true })}${(role === 'dj' && !simple) ? (eventFinished(ev)
        ? (HOURLY_IDS[S.user.id]
          ? `<div class="panel"><div class="panel__head"><h3>Parte de horas</h3></div><div class="panel__body">
              <p class="hint" style="margin-bottom:12px">La boda ha finalizado. Indica <b>cuántas horas has trabajado</b> y pulsa guardar. Se te sumarán a tu ficha para el cobro.</p>
              <div class="form-grid"><div class="field"><label>Horas trabajadas</label><input class="control" type="number" min="0" step="0.5" id="helperHours" value="${ev.helperHours && ev.helperHours[S.user.id] != null ? esc(ev.helperHours[S.user.id]) : ''}" placeholder="p. ej. 13"></div></div>
              <div class="btn-row" style="margin-top:10px"><button type="button" class="btn btn--primary" data-save-hours>Guardar mis horas</button><span id="hoursMsg" class="muted" style="margin-left:10px"></span></div></div></div>`
          : `<div class="panel"><div class="panel__head"><h3>Albarán de trabajo</h3></div><div class="panel__body">
            <p class="hint" style="margin-bottom:12px">La boda ha finalizado. Indica las horas extra realizadas, si hay que pedir opinión y tus observaciones.</p>
            <div class="form-grid">
              ${fg('Horas extra realizadas', sel('dj_assigned_overtime', [['', 'Selecciona'], 'Sin horas extra', 'Media Hora', '1 Hora', '1 hora y media', '2 Horas', '2 hora y media', '3 Horas', '3 hora y media', '4 Horas', '4 hora y media', '5 Horas'], ev.djOvertime))}
              ${fg('¿Pedir opinión a los novios?', sel('ask_for_opinion', [['', '—'], 'Si', 'No'], ev.opinion))}
            </div>
            ${fg('Observaciones', ta('dj_observations', ev.obsDj, 'Notas tras el evento…'))}</div></div>`)
        : `<div class="panel"><div class="panel__body"><div class="alert alert--info">${HOURLY_IDS[S.user.id] ? 'Tu <b>parte de horas</b> estará disponible <b>cuando finalice la boda</b> (a partir del día siguiente).' : 'El <b>albarán de trabajo</b> (horas extra, opinión y observaciones) estará disponible para rellenar <b>cuando finalice la boda</b> (a partir del día siguiente). Recibirás un email como recordatorio.'}</div></div></div>`) : ''}</div>
      ${(role === 'dj' && !simple) ? `<div data-pane="ruta" style="display:none">${paneRuta(ev)}</div>` : ''}` : (role === 'user' ? `<div data-pane="archivos" style="display:none"><div class="panel"><div class="panel__body" id="filesBox">Cargando…</div></div></div>` : '')}`;
  const canSave = canEditMusic || role === 'dj';
  // porcentaje de música completada (también visible para los novios)
  const prog = eventProgress(ev);
  const progHtml = (!simple && (role === 'user' || role === 'planner')) ? `<div class="cli-prog cli-prog--mini">
      <div class="cli-prog__row"><span>Música completada</span><b id="progPct">${prog}%</b></div>
      <div class="progress progress--green progress--mini"><div id="progBar" style="width:${prog}%"></div></div></div>` : '';
  const headHtml = (role === 'user')
    ? `<div class="ev-cli-head"><h1>${esc(ev.conyuges || ev.tipo || 'Mi boda')}</h1><div class="ev-cli-sub">${dmy(ev.fecha)}${ev.hora ? ' · ' + ev.hora : ''}</div></div>`
    : pageHead((ev.conyuges || ev.tipo || 'Evento') + ' · #' + ev.id, dmy(ev.fecha) + (ev.hora ? ' · ' + ev.hora : ''));
  shell(`${headHtml}
    ${intro}${progHtml}<form id="evForm" class="${role === 'user' ? 'ev-client' : ''}" data-id="${ev.id}">${tabs}${panes}
    ${canSave ? `<div class="floatbar"><button type="submit" class="btn btn--primary">Guardar</button></div>` : ''}</form>`, role === 'user' ? [tt('Mi boda', 'La meva boda', 'My wedding', 'Mon mariage')] : ['Eventos', '#' + ev.id]);
  wireEventForm(ev, { full: false, role, canEditMusic, canSave });
}

// progreso: SOLO campos musicales. Los momentos marcados como "no se incluye"
// (m.on) y la ceremonia, si es fuera de la finca, no cuentan ni en el total.
function eventProgress(ev) {
  const music = ev.music || {};
  const active = k => !(music[k] && music[k].on);
  const keys = [];
  musicAreasFor(ev).forEach(a => { if (a.key === 'ceremony' && ev.ceremoniaFuera) return; a.moments.forEach(m => keys.push(a.key + '_' + m[0])); });
  DISCO_MOMENTS.forEach(m => keys.push('disco_' + m[0]));
  let total = 0, filled = 0;
  keys.forEach(k => { if (!active(k)) return; total++; if (music[k] && music[k].song) filled++; });
  (ev.optionals || []).forEach(o => { if (o.on) return; total++; if (o.value) filled++; });
  total++; if ((ev.disco || {}).playlist) filled++; // enlace a playlist
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(filled / total * 100)));
}

/* Base de Conecta So para calcular desplazamientos */
const BASE_ADDR = 'Carrer del Comerç, Martorelles, Barcelona';
const BASE_LL = '41.5293,2.2440';
// Extrae coordenadas de un enlace de Google Maps (largo) o de "lat,lng".
function parseLatLngP(s) {
  s = decodeURIComponent(s || '');
  let m = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/); if (m) return [+m[1], +m[2]];
  m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/); if (m) return [+m[1], +m[2]];
  m = s.match(/[?&](?:q|query|ll|sll|daddr)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/); if (m) return [+m[1], +m[2]];
  m = s.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/); if (m) return [+m[1], +m[2]];
  return null;
}
// Tiempo de desplazamiento desde la base hasta la finca (solo DJ y admin). Enlace de ruta a Google Maps.
function travelInfo(ev) {
  const role = S.user.role;
  if (!(role === 'admin' || role === 'dj')) return '';
  const loc = (S.meta.locations || []).find(l => String(l.id) === String(ev.lugar));
  const isOtro = !loc && !!ev.lugarOtro;
  const dest = loc && loc.lat && loc.lng ? (loc.lat + ',' + loc.lng)
    : (loc ? loc.name + ', Barcelona'
      : (isOtro && ev.otroLat ? ev.otroLat + ',' + ev.otroLng : (ev.lugarOtro || '')));
  if (!dest && !isOtro) return '';
  const maps = 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(BASE_ADDR) + '&destination=' + encodeURIComponent(dest) + '&travelmode=driving';
  // minutos: finca con travelMin, o evento "Otro" con otroTravelMin
  const tMin = loc ? loc.travelMin : (isOtro ? ev.otroTravelMin : null);
  const tKm = loc ? loc.travelKm : (isOtro ? ev.otroTravelKm : null);
  const tApx = loc ? loc.travelApprox : (isOtro ? ev.otroApprox : false);
  const mins = tMin ? `<b>🚗 ${tApx ? '~' : ''}${tMin} min</b>${tKm ? ' · ' + tKm + ' km' : ''} <span class="muted">desde Martorelles${tApx ? ' (aprox.)' : ''}</span>` : `<span class="muted">Tiempo de desplazamiento: pendiente de calcular</span>`;
  // para "Otro", el admin puede pegar el enlace de Google Maps y calcular
  const otroCalc = (isOtro && role === 'admin') ? `<div class="otro-travel" style="margin-top:8px"><input class="control" id="otroTravelLink" placeholder="Pega el enlace de Google Maps del lugar (o: lat,long)" value="${esc(ev.otroLink || '')}"><button type="button" class="btn btn--sm btn--primary" id="otroTravelCalc">Calcular</button></div>` : '';
  return `<div class="travel-box"><div><span id="travelMins">${mins}</span> <a class="travel-link" id="travelMaps" href="${maps}" target="_blank" rel="noopener">Ver ruta en Google Maps ↗</a></div>${otroCalc}</div>`;
}
/* Hoja de ruta del evento (DJ/técnico y admin): tiempos calculados automáticamente.
   TODO: automatizar el montaje según material/servicios y permitir ajustarlo a mano. */
const _p2 = n => String(n).padStart(2, '0');
const _hm2min = s => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? (+m[1] * 60 + +m[2]) : null; };
const _min2hm = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return _p2(Math.floor(m / 60)) + ':' + _p2(m % 60); };
// Montaje por tipo de boda (reglas de Conecta So):
// Recomendado 1h · Pack fiesta 1h30 · Bodorrio 1h30 · Tinglado 3h (3h30 con tarima) · más extras → valorar.
function montajeInfo(ev) {
  const tipo = (ev.tipo || '').toLowerCase();
  const extrasOn = ev.extras ? Object.keys(ev.extras).filter(k => ev.extras[k]) : [];
  const svcNames = (ev.services || []).map(s => (extraName(s.servicio) || '').toLowerCase());
  // Tiempo de montaje por defecto según el pack (antes del inicio de la ceremonia).
  let min = 90, regla = '';
  if (/recomendad/.test(tipo)) { min = 60; regla = 'Recomendado · 1 h antes'; }
  else if (/fiesta/.test(tipo)) { min = 90; regla = 'Pack fiesta · 1 h 30 antes'; }
  else if (/bodorrio/.test(tipo)) { min = 90; regla = 'Bodorrio · 1 h 30 antes'; }
  else if (/tinglado/.test(tipo)) { min = 180; regla = 'Tinglado · 3 h antes'; }
  else { min = 90; regla = 'Montaje estándar · 1 h 30 antes'; }
  // Servicios de montaje pesado que exigen ir con MÁS tiempo (valorar en cada evento).
  const HEAVY = /(tarima|pantalla|suelo led|proyecci|c[aá]bez|cabeza|moving head|truss)/;
  const heavy = extrasOn.some(k => /tarima|suelo_led|proyeccion|pantalla/.test(k)) || svcNames.some(n => HEAVY.test(n));
  const note = heavy
    ? '⚠ Ojo con el tiempo: este evento lleva servicios de montaje pesado (tarima, pantalla LED, cabezas móviles o truss extra). Valora salir con más antelación de la indicada.'
    : '';
  return { min, regla, note, warn: heavy };
}
function paneRuta(ev) {
  const loc = (S.meta.locations || []).find(l => String(l.id) === String(ev.lugar));
  const travel = loc ? loc.travelMin : (ev.lugarOtro ? ev.otroTravelMin : null);
  const travelKm = loc ? loc.travelKm : (ev.lugarOtro ? ev.otroTravelKm : null);
  const destName = loc ? loc.name : (ev.lugarOtro || '—');
  const target = _hm2min(ev.ceremoniaFuera ? ev.celebrationHour : ev.hora);
  const mt = montajeInfo(ev);
  const head = `<div class="panel"><div class="panel__head"><h3>🗺️ Hoja de ruta</h3></div><div class="panel__body">`;
  if (target == null || travel == null) {
    return `${head}<div class="alert alert--warn">Para calcular la hoja de ruta falta la <b>hora de ${ev.ceremoniaFuera ? 'inicio del aperitivo' : 'la ceremonia'}</b>${travel == null ? ' y el <b>tiempo de desplazamiento</b> de la finca (indícalo en Desplazamientos o, si es "Otro", en Datos)' : ''}.</div></div></div>`;
  }
  const listo = target, inicioMontaje = target - mt.min, llegada = inicioMontaje, salida = llegada - travel;
  const hhmm = m => m < 0 ? _min2hm(m) + ' (día anterior)' : _min2hm(m);
  const row = (ic, t, time, sub) => `<div class="ruta-row"><div class="ruta-ic">${ic}</div><div class="ruta-main"><div class="ruta-t">${t}</div>${sub ? `<div class="ruta-sub muted">${sub}</div>` : ''}</div><div class="ruta-time">${time}</div></div>`;
  return `${head}
    <p class="hint">Tiempos calculados automáticamente: desplazamiento desde Martorelles a <b>${esc(destName)}</b> (${travel} min${travelKm ? ' · ' + travelKm + ' km' : ''}) y montaje según el tipo de boda: <b>${esc(mt.regla)}</b> (${mt.min} min).</p>
    ${mt.note ? `<div class="alert alert--warn" style="margin-bottom:12px">⚠ ${esc(mt.note)}</div>` : ''}
    <div class="ruta">
      ${row('🚗', 'Salida desde Martorelles', hhmm(salida), 'Desplazamiento ' + travel + ' min' + (travelKm ? ' · ' + travelKm + ' km' : ''))}
      ${row('📍', 'Llegada a ' + esc(destName), hhmm(llegada), 'Inicio del montaje')}
      ${row('🔧', 'Montaje de equipo', hhmm(inicioMontaje) + '–' + hhmm(listo), mt.regla + ' · ' + mt.min + ' min')}
      ${row('✅', 'Todo listo', hhmm(listo), 'A la hora de ' + (ev.ceremoniaFuera ? 'inicio' : 'la ceremonia'))}
      ${ev.ceremoniaFuera ? '' : row('💍', 'Ceremonia', _min2hm(_hm2min(ev.hora)), '')}
      ${(() => { const ap = ev.ceremoniaFuera ? _hm2min(ev.celebrationHour) : (_hm2min(ev.hora) != null ? _hm2min(ev.hora) + 60 : null); return ap != null ? row('🥂', 'Aperitivo', _min2hm(ap), ev.ceremoniaFuera ? '' : '1 h después de la ceremonia') : ''; })()}
    </div>
    ${(ev.services || []).filter(s => s.servicio).length ? `<h4 class="form-sub" style="margin-top:18px">Servicios y técnicos</h4>
      <div class="table-wrap"><table class="dt"><thead><tr><th>Servicio</th><th>Responsable(s)</th></tr></thead><tbody>
      ${(ev.services || []).filter(s => s.servicio).map(s => `<tr><td><b>${esc(extraName(s.servicio))}</b></td><td>${esc([s.resp, s.resp2].filter(Boolean).map(r => userName(r)).join(' · ') || 'Sin asignar')}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div class="btn-row" style="margin-top:14px">
      <a class="btn btn--sm btn--primary" href="#/eventos/${ev.id}/ruta-doc">📄 Ver / imprimir hoja de ruta</a>
    </div>
  </div></div>
  <div id="rutaPlano"></div>`;
}
/* --- paneles --- */
function paneDatos(ev, locOpts, { readonly = false, horariosEditable = false } = {}) {
  const ro = readonly ? { ro: true } : {};
  const roH = (readonly && !horariosEditable) ? { ro: true } : {}; // horarios editables para el wedding planner
  const roSel = readonly ? 'disabled' : '';
  const sp = ev.spouses || [{}, {}];
  const showSpouse = S.user.role === 'admin' || S.user.role === 'user';
  return `<div class="mblock"><h4>Datos principales</h4><div class="inner"><div class="form-grid">
    ${isAdmin() ? fg('Tipo de boda', sel('wedding_type', S.meta.tipos, ev.tipo, roSel)) : ''}
    ${isAdmin()
      ? fg('Fecha', inp('wedding_date', ev.fecha, { type: 'date' }))
      : fg('Fecha', `<input class="control" type="date" value="${esc(ev.fecha || '')}" data-datelock readonly>
          <p class="hint">La fecha solo la puede cambiar administración. Si necesitáis moverla, avisadnos y lo gestionamos nosotros.</p>`)}
    ${fg('Hora de la ceremonia', inp('wedding_hour', ev.hora, { type: 'time', ...roH }))}
    ${fg('Hora inicio aperitivo', inp('celebration_hour', ev.celebrationHour, { type: 'time', ...roH }))}
    ${fg('Lugar de la celebración', sel('celebration_location', locOpts, ev.lugar === 0 && ev.lugarOtro ? 'otro' : ev.lugar, roSel + ' data-search') + `<div id="otroWrap" style="margin-top:8px;display:${(!ev.lugar && ev.lugarOtro) ? 'block' : 'none'}">${inp('celebration_location_other', ev.lugarOtro, { ph: 'Indica el lugar', ...ro })}</div>` + travelInfo(ev))}
    ${fg('Lugar de la ceremonia', inp('wedding_location', ev.lugarCeremonia, ro))}
    ${fg(tt('Ceremonia fuera del lugar de la celebración', 'Cerimònia fora del lloc de la celebració', 'Ceremony away from the venue', 'Cérémonie hors du lieu de réception'), `<label class="chk"><input type="checkbox" name="ceremony_outside" ${ev.ceremoniaFuera ? 'checked' : ''} ${readonly ? 'disabled' : ''}> <span>${tt('Marca si la ceremonia se celebra fuera de la finca (no realizamos la sonorización de ceremonia)', 'Marca si la cerimònia se celebra fora de la finca (no fem la sonorització de cerimònia)', 'Tick if the ceremony is held away from the venue (we do not provide ceremony sound)', 'Cochez si la cérémonie a lieu hors du lieu (nous ne sonorisons pas la cérémonie)')}</span></label>`)}
    ${fg('Nº de invitados', inp('guest_number', ev.guests, { type: 'number', ...ro }))}
    ${isAdmin() ? fg('Observaciones ocultas', ta('privat_observations', ev.obsPriv, 'Solo las ven administración y el DJ')) : (S.user.role === 'dj' && ev.obsPriv !== undefined ? fg('Observaciones ocultas', `<div class="readbox">${esc(ev.obsPriv) || '<span class="muted">Sin observaciones ocultas</span>'}</div>`) : '')}
  </div></div></div>
  ${isAdmin() ? `<div class="mblock mblock--of"><h4>Asignaciones</h4><div class="inner"><div class="form-grid">
    ${fg('DJ asignado', sel('dj_vinculated', [['', 'Selecciona un DJ']].concat((S.meta.djs || []).map(u => [u.id, u.name])), ev.djId, 'data-search'))}
    ${eventFinished(ev) ? fg('Horas extra DJ', sel('dj_assigned_overtime', [['', 'Selecciona'], 'Sin horas extra', 'Media Hora', '1 Hora', '1 hora y media', '2 Horas', '2 hora y media', '3 Horas', '3 hora y media', '4 Horas', '4 hora y media', '5 Horas'], ev.djOvertime)) : fg('Horas extra DJ', '<div class="readbox"><span class="muted">Se rellena cuando finaliza la boda (el DJ lo indica en su albarán).</span></div>')}
    ${fg('Wedding planner', sel('wp_vinculated', [['', 'Selecciona un planner']].concat((S.meta.planners || []).map(u => [u.id, u.name])), ev.wpId, 'data-search'))}
  </div></div></div>` : ''}
  ${showSpouse ? `<div class="mblock"><h4>Datos de los cónyuges</h4><div class="inner"><div class="grid-2">
    ${sp.slice(0, 2).map((s, i) => { const p = i === 0 ? 'first' : 'second'; return `<div><h5 style="margin-bottom:10px">${i === 0 ? 'Primer' : 'Segundo'} cónyuge</h5><div class="form-grid">
      ${fg('Nombre', inp(p + '_spouse', s.name, ro))}
      ${fg('DNI', inp(p + '_spouse_dni', s.dni, ro))}
      ${fg('Email', inp(p + '_spouse_email', s.email, { type: 'email', ...ro }))}
      ${fg('Móvil', inp(p + '_spouse_mobile', s.mobile, ro))}
      ${fg('Dirección', inp(p + '_spouse_address', s.address, ro))}</div></div>`; }).join('')}
  </div></div></div>` : ''}`;
}

// Detecta el tipo de enlace. Se prefiere SIEMPRE Spotify; otros enlaces se abren igual pero se avisa.
function linkService(url) {
  const u = String(url || '').toLowerCase();
  if (/open\.spotify\.com|spotify:/.test(u)) return { name: 'Spotify', color: '#1DB954', spotify: true };
  if (/youtube\.com|youtu\.be/.test(u)) return { name: 'YouTube', color: '#FF0000' };
  if (/^https?:\/\//.test(u)) return { name: 'Abrir', color: '#130F17' };
  return null;
}
// Reúne todos los momentos con enlace (música fija + momentos personalizados) en orden.
function eventMusicLinks(ev) {
  const out = [];
  const mu = ev.music || {};
  Object.keys(mu).forEach(k => { const m = mu[k]; if (m && m.link && !m.on) out.push({ title: momentTitle(ev, k, (ev.labels && ev.labels[k]) || k), song: m.song || '', url: m.link, order: +m.order || 50 }); });
  (ev.optionals || []).forEach(o => { if (o.link) out.push({ title: o.title || 'Momento', song: o.value || '', url: o.link, order: +o.order || 60 }); });
  return out.sort((a, b) => a.order - b.order);
}
// ¿Todos los enlaces de los momentos son de Spotify? (requisito para generar la playlist)
function allSpotify(ev) {
  const ls = eventMusicLinks(ev);
  if (!ls.length) return false;
  return ls.every(l => (linkService(l.url) || {}).spotify);
}
// Iconos por momento musical (entrada novios, anillos, platos, etc.)
const MOMENT_ICON = { first_spouse_entry: '👰', second_spouse_entry: '🤵', rings: '💍', signatures: '✍️', exit: '🚪', readings: '📖', vehicle_entry: '🚗', vows: '💌', entry: '💑', first: '🍽️', second: '🍖', sorbet: '🍧', dessert: '🍰', wine_white: '🥂', wine_red: '🍷', cake_presentation: '🎂', cake: '🎂', dance: '💃', last_song: '🎶' };
const momentIcon = key => MOMENT_ICON[String(key).replace(/^(ceremony|aperitif|banquet|disco)_/, '')] || '🎵';
// Enlace con el nombre de la plataforma (Spotify / YouTube) y color de marca. Vale para web y PDF.
function linkChip(url) {
  const s = linkService(url); if (!s || !url) return '';
  const icon = s.spotify ? '▶' : (s.name === 'YouTube' ? '▶' : '↗');
  const label = s.spotify ? 'Reproducir' : (s.name === 'YouTube' ? 'Abrir en YouTube' : 'Abrir');
  const ok = s.spotify ? `<span class="link-ok" title="Enlace de Spotify correcto">✓</span>` : '';
  return `${ok}<a class="link-chip" href="${esc(url)}" target="_blank" rel="noopener" style="background:${s.color}" title="${label}"><span class="tri">${icon}</span>${s.name}</a>`;
}
// Título del momento. Los dos de "entrada de cónyuge" toman automáticamente el nombre de los datos del cónyuge.
function momentTitle(ev, key, def) {
  const sp = ev.spouses || [];
  if (key === 'ceremony_first_spouse_entry') { const n = (sp[0] && sp[0].name || '').trim(); return n ? 'Entrada de ' + n : def; }
  if (key === 'ceremony_second_spouse_entry') { const n = (sp[1] && sp[1].name || '').trim(); return n ? 'Entrada de ' + n : def; }
  return (ev.labels && ev.labels[key]) || def;
}
const toolsHtml = (readonly, isOpt) => readonly ? '' : `<span class="m-tools"><span class="m-grip" title="Arrastra para mover">⠿</span>${isOpt ? '<button type="button" class="m-del" data-del-opt title="Quitar">✕</button>' : ''}</span>`;
const linkField = (name, val, readonly, extra = '') => `<div data-linkwrap><div class="link-row"><input class="control" ${name ? `name="${name}"` : extra} data-link value="${esc(val || '')}" placeholder="Pega el enlace de Spotify o YouTube" ${readonly ? 'readonly' : ''}><span data-chip>${linkChip(val)}</span></div></div>`;

// comentario plegable (oculto por defecto; abierto si ya tiene texto)
function cmtField(inner, hasVal) {
  return `<div class="cmt${hasVal ? ' open' : ''}" data-cmt>
    <button type="button" class="cmt-btn" data-cmt-toggle>💬 Comentario${hasVal ? '' : ' <span class="cmt-plus">+</span>'}</button>
    <div class="cmt-body"${hasVal ? '' : ' style="display:none"'}>${inner}</div></div>`;
}
function momentRow(ev, key, title, { readonly }) {
  const m = (ev.music || {})[key] || {};
  const t = momentTitle(ev, key, (ev.labels && ev.labels[key]) || title);
  const ro = readonly ? 'readonly' : '';
  return `<div class="moment" data-moment data-key="${esc(key)}" data-deftitle="${esc(title)}">
    <h5>${toolsHtml(readonly, false)}<span data-mtitle><span class="m-ic">${momentIcon(key)}</span> ${esc(t)}</span><label class="switch switch--incl" style="margin-left:auto" title="Verde = activado (se incluye) · Rojo = desactivado (no se incluye)"><input type="checkbox" name="check_${key}" ${m.on ? 'checked' : ''} ${readonly ? 'disabled' : ''}><span class="track"></span><span class="switch-state">${m.on ? 'Desactivado' : 'Activado'}</span></label></h5>
    <div class="mgrid">
      <div><label class="mlab">Artista · Canción</label><input class="control" name="${key}" value="${esc(m.song || '')}" placeholder="Artista - Canción" ${ro}></div>
      <div><label class="mlab">Enlace (Spotify o YouTube)</label>${linkField('link_' + key, m.link, readonly)}</div>
      <div class="full">${cmtField(`<input class="control" name="comment_${key}" value="${esc(m.comment || '')}" placeholder="Comentario (opcional)" ${ro}>`, !!m.comment)}</div>
    </div></div>`;
}
function optRow(o, { readonly }) {
  const ro = readonly ? 'readonly' : '';
  return `<div class="moment" data-moment data-opt data-oid="${esc(o.id || '')}" data-kind="${esc(o.kind || 'optionals')}" data-area="${esc(o.area || 'ceremony')}" data-sec="${esc(o.sec || 'C')}">
    <h5>${toolsHtml(readonly, true)}<span>${readonly ? esc(o.title || 'Momento') : 'Momento personalizado'}</span></h5>
    <div class="mgrid">
      <div><label class="mlab">Momento / destinatario</label><input class="control" data-f="title" value="${esc(o.title || '')}" placeholder="Ej: Padres, Votos…" ${ro}></div>
      <div><label class="mlab">Artista · Canción</label><input class="control" data-f="value" value="${esc(o.value || '')}" placeholder="Artista - Canción" ${ro}></div>
      <div><label class="mlab">Enlace (Spotify o YouTube)</label>${linkField('', o.link, readonly, 'data-f="link"')}</div>
      <div class="full">${cmtField(`<input class="control" data-f="comment" value="${esc(o.comment || '')}" placeholder="Comentario (opcional)" ${ro}>`, !!o.comment)}</div>
    </div></div>`;
}
function paneMusica(ev, canEdit) {
  const readonly = !canEdit;
  const optsIn = sec => (ev.optionals || []).filter(o => (o.sec || 'C') === sec).sort((a, b) => (+a.order || 99) - (+b.order || 99));
  const sectionBody = (sec, fixedKeys) => {
    // fijos y personalizados se mezclan y se ordenan por el orden guardado (lo que permite arrastrar entre ellos)
    const rows = [];
    (fixedKeys || []).forEach((f, i) => { const mu = (ev.music || {})[f[0]] || {}; rows.push({ order: +mu.order || (i + 1), html: momentRow(ev, f[0], f[1], { readonly }) }); });
    optsIn(sec).forEach(o => rows.push({ order: +o.order || 60, html: optRow(o, { readonly }) }));
    rows.sort((a, b) => a.order - b.order);
    return `<div data-sortbox="${sec}">${rows.map(r => r.html).join('')}</div>${readonly ? '' : `<button type="button" class="btn btn--sm" data-add-opt="${sec}">+ Añadir momento</button>`}`;
  };
  const reorderHint = readonly ? '' : `<span class="reorder-hint">Arrastra ⠿ para ordenar</span>`;
  const d = ev.disco || {};
  const roS = readonly ? 'disabled' : '', ro = readonly ? { ro: true } : {};
  // cada apartado es una sección; luego se muestran como pestañas para no tener que hacer scroll
  // aviso específico de Can Oliver: el aperitivo no está incluido
  const oliverAperitivo = isOliver(ev) ? `<div class="alert alert--warn"><b>La sonorización del aperitivo no está incluida en Can Oliver.</b> Si la queréis, tiene un coste extra de <b>170 €</b>. Para confirmarlo, avisad a <b>Nández</b> de que queréis el servicio.</div>` : '';
  const sections = musicAreasFor(ev).map(a => ({ key: a.key, label: a.title, body: (a.key === 'ceremony')
    ? `<div class="inner ceremony-inner${ev.ceremoniaFuera ? ' ceremony-out' : ''}">
        <div class="alert alert--warn ceremony-out-msg">${tt(
          '<b>No realizamos la sonorización de ceremonia.</b> La ceremonia se celebra <b>fuera de la finca de la boda</b>, por lo que no se configura la música de ceremonia.',
          '<b>No fem la sonorització de cerimònia.</b> La cerimònia se celebra <b>fora de la finca de la boda</b>, per la qual cosa no es configura la música de cerimònia.',
          '<b>We do not provide ceremony sound.</b> The ceremony takes place <b>away from the wedding venue</b>, so ceremony music is not set up here.',
          '<b>Nous ne sonorisons pas la cérémonie.</b> La cérémonie a lieu <b>hors du lieu de réception</b>, la musique de cérémonie n\'est donc pas configurée ici.')}</div>
        <div class="ceremony-fields">${sectionBody(SEC_OF[a.key], a.moments.map(mm => [a.key + '_' + mm[0], mm[1]]))}</div></div>`
    : `<div class="inner">${a.key === 'aperitif' ? oliverAperitivo : ''}${sectionBody(SEC_OF[a.key], a.moments.map(mm => [a.key + '_' + mm[0], mm[1]]))}</div>` }));
  const radset = (name, opts, cur) => `<div class="radset">${opts.map(([v, l]) => `<label class="chk chk--radio"><input type="radio" name="${name}" value="${esc(v)}" ${String(cur) === String(v) ? 'checked' : ''} ${roS}> <span>${esc(l)}</span></label>`).join('')}</div>`;
  sections.push({ key: 'entregas', label: 'Entregas', body: `<div class="inner">${sectionBody('E', [])}</div>` });
  sections.push({ key: 'fiesta', label: 'Fiesta', body: `<div class="inner"><div class="form-grid">
    ${fg('Enlace a playlist', linkField('link_playlist', d.playlist, readonly))}
    ${fg('Tipo de lista', radset('compliance_list', [['obligatoria', 'Lista obligatoria'], ['orientativa', 'Lista orientativa']], d.compliance))}
    ${fg('¿Se aceptan peticiones de invitados?', radset('guest_requests', [['si_todas', 'Sí, todas'], ['no_ninguna', 'No, ninguna'], ['si_similares', 'Sí, si son similares a nuestra playlist']], d.guests))}
    ${fg('Restricciones', ta('disco_restrictions', d.restrictions, 'Qué NO debe sonar'))}
    ${fg('Observaciones', ta('disco_observations', d.observations, 'Lo que quieras contarnos'))}
    ${fg('Logo para el fotomatón', `<input type="file" accept="image/png,image/jpeg" id="fotoLogoInput" class="control" ${readonly ? 'disabled' : ''}>
      <input type="hidden" name="foto_logo_data" value="${esc(d.fotoLogo || '')}">
      <div id="fotoLogoPrev" class="foto-logo-prev">${d.fotoLogo ? `<img src="${esc(d.fotoLogo)}" alt="Logo fotomatón"><button type="button" class="btn btn--xs btn--red" id="fotoLogoDel">Quitar</button>` : ''}</div>
      <p class="hint">Sube el logo que quieres en las fotos del fotomatón. Preferiblemente <b>PNG o JPG con fondo blanco</b>.</p>`)}
  </div>${sectionBody('D', DISCO_MOMENTS.map(mm => ['disco_' + mm[0], mm[1]]))}</div>` });
  // Recomendaciones: playlists con propuestas musicales para cada momento (al final del todo)
  sections.push({ key: 'recomendaciones', label: 'Recomendaciones', body: `<div class="inner">
    <p class="hint" style="margin-bottom:12px">¿No sabéis qué poner en cada momento? Aquí tenéis <b>playlists con propuestas</b> para inspiraros. Abridlas y coged las ideas que más os gusten.</p>
    <div class="recs-list">${MUSIC_RECS.map(r => `<a class="rec-card" href="${esc(r[1])}" target="_blank" rel="noopener"><span class="rec-ic">🎧</span><span class="rec-nm">${esc(r[0])}</span><span class="rec-go">Ver propuestas ↗</span></a>`).join('')}</div></div>` });
  const nav = `<div class="mtabs" data-mtabs role="tablist">${sections.map((s, i) => `<button type="button" class="mtab${i === 0 ? ' on' : ''}" data-mtab="${s.key}">${esc(s.label)}</button>`).join('')}</div>`;
  const panes = sections.map((s, i) => `<section class="mblock mpane${i === 0 ? ' on' : ''}" data-mpane="${s.key}"${i === 0 ? '' : ' style="display:none"'}><h4>${esc(s.label)}${s.key === 'extras' ? '' : reorderHint}</h4>${s.body}</section>`).join('');
  // si todos los momentos tienen enlace de Spotify, se ofrece abrir/crear la playlist
  const spoti = allSpotify(ev) ? `<div class="spoti-bar"><button type="button" class="btn btn--spoti" id="openSpoti">🎵 Abre tu playlist de Spotify</button><span class="hint">Todos los momentos tienen enlace de Spotify, así que podemos montar tu playlist automáticamente.</span></div>` : '';
  return `<div class="music-wrap">${spoti}${nav}${panes}</div>`;
}
// precio de reserva por servicio extra: 50€ + 21% IVA
const RESERVA_BASE = 50, RESERVA_IVA = 0.21, RESERVA_TOTAL = RESERVA_BASE * (1 + RESERVA_IVA); // 60,50 €
function paneExtras(ev, { readonly = false } = {}) {
  const role = S.user.role;
  const auto = autoExtraKeys(ev);
  const status = ev.extraStatus || {};
  // en Can Oliver, los novios no pueden ver fuego frío ni tarima
  const hideForClient = (role === 'user' && isOliver(ev)) ? OLIVER_HIDE_EXTRAS : [];
  const tiles = EXTRAS_CLIENTE.filter(x => !hideForClient.includes(x[0])).map(x => {
    const manual = ev.extras && ev.extras[x[0]];
    const isAuto = !manual && auto[x[0]];
    const st = status[x[0]]; // solicitado | pendiente_pago | reservado
    const on = manual || isAuto;
    const lock = readonly || isAuto;
    // estado y acción según el flujo de reserva
    let stLabel, badge = '', action = '';
    if (isAuto) stLabel = tt('✓ Incluido', '✓ Inclòs', '✓ Included', '✓ Inclus');
    else if (st === 'reservado') { stLabel = tt('✓ Reservado', '✓ Reservat', '✓ Booked', '✓ Réservé'); badge = `<span class="ex-badge ex-badge--ok">${stLabel}</span>`; }
    else if (st === 'pendiente_pago') {
      stLabel = tt('Pendiente de pago', 'Pendent de pagament', 'Awaiting payment', 'En attente de paiement'); badge = `<span class="ex-badge ex-badge--pay">💳 ${stLabel}</span>`;
      if (role === 'user' || role === 'planner') action = `<button type="button" class="btn btn--xs btn--primary" data-extra-pay="${x[0]}">${tt('Pagar reserva', 'Pagar reserva', 'Pay deposit', "Payer l'acompte")} ${fmtEur(RESERVA_TOTAL)}</button>`;
      else if (role === 'admin') action = `<button type="button" class="btn btn--xs" data-extra-pay="${x[0]}">Marcar pagado</button>`;
    } else if (st === 'solicitado') {
      stLabel = tt('Pendiente de confirmación', 'Pendent de confirmació', 'Awaiting confirmation', 'En attente de confirmation'); badge = `<span class="ex-badge ex-badge--wait">⏳ ${stLabel}</span>`;
      if (role === 'admin') action = `<button type="button" class="btn btn--xs btn--primary" data-extra-confirm="${x[0]}">Confirmar disponibilidad</button> <a class="ex-mail" data-extra-mail="${x[0]}">ver aviso enviado</a>`;
    } else stLabel = manual ? tt('✓ Añadido', '✓ Afegit', '✓ Added', '✓ Ajouté') : tt('Ver info', 'Veure info', 'View info', 'Voir info');
    return `<div class="extra-tile${on ? ' on' : ''}${isAuto ? ' extra-tile--auto' : ''}${st ? ' extra-tile--' + st : ''}" data-extra="${x[0]}" role="button" tabindex="0" aria-label="${esc(exName(x))}">
      <input type="checkbox" name="${x[0]}" ${on ? 'checked' : ''} ${lock ? 'disabled' : ''} hidden>
      <span class="extra-tile__ic">${x[3] || '✨'}</span>
      <span class="extra-tile__nm">${esc(exName(x))}</span>
      <span class="extra-tile__st">${stLabel}</span>
      ${badge}
      ${action ? `<div class="ex-actions" data-noopen>${action}</div>` : ''}
    </div>`;
  }).join('');
  const reserva = fmtEur(RESERVA_TOTAL);
  const avisos = `<div class="alert alert--warn">
    <p>${tt(
      '<b>Atención!</b> Al marcar y guardar un servicio extra se envía la solicitud a Conecta So (<b>facturación</b> y <b>comercial</b>). Para cancelarlo, ponte en contacto por email.',
      '<b>Atenció!</b> En marcar i desar un servei extra s\'envia la sol·licitud a Conecta So (<b>facturació</b> i <b>comercial</b>). Per cancel·lar-ho, contacta per email.',
      '<b>Note!</b> When you tick and save an extra service, the request is sent to Conecta So (<b>billing</b> and <b>sales</b>). To cancel it, contact us by email.',
      '<b>Attention !</b> En cochant et enregistrant un service supplémentaire, la demande est envoyée à Conecta So (<b>facturation</b> et <b>commercial</b>). Pour l\'annuler, contactez-nous par email.')}</p>
    <p style="margin:6px 0 0">${tt(
      '<b>Cómo funciona:</b> 1) lo marcáis → <b>pendiente de confirmación</b>; 2) confirmamos disponibilidad y os llega un WhatsApp con el enlace de pago de la reserva (' + reserva + ' por servicio) → <b>pendiente de pago</b>; 3) al pagar queda <b>reservado</b>.',
      '<b>Com funciona:</b> 1) ho marqueu → <b>pendent de confirmació</b>; 2) confirmem disponibilitat i us arriba un WhatsApp amb l\'enllaç de pagament de la reserva (' + reserva + ' per servei) → <b>pendent de pagament</b>; 3) en pagar queda <b>reservat</b>.',
      '<b>How it works:</b> 1) you tick it → <b>awaiting confirmation</b>; 2) we confirm availability and you get a WhatsApp with the deposit payment link (' + reserva + ' per service) → <b>awaiting payment</b>; 3) once paid it is <b>booked</b>.',
      '<b>Comment ça marche :</b> 1) vous cochez → <b>en attente de confirmation</b> ; 2) nous confirmons la disponibilité et vous recevez un WhatsApp avec le lien de paiement de l\'acompte (' + reserva + ' par service) → <b>en attente de paiement</b> ; 3) une fois payé, c\'est <b>réservé</b>.')}</p></div>`;
  return `<div class="panel"><div class="panel__head"><h3>Servicios extras a contratar</h3></div>
    <div class="panel__body">${avisos}<p class="hint" style="margin-bottom:12px">${readonly ? tt('Pulsa un servicio para ver la información.', 'Prem un servei per veure la informació.', 'Tap a service to see the information.', 'Appuyez sur un service pour voir les informations.') : tt('Pulsa un servicio para ver la información y añadirlo a tu boda.', 'Prem un servei per veure la informació i afegir-lo a la teva boda.', 'Tap a service to see the information and add it to your wedding.', "Appuyez sur un service pour voir les informations et l'ajouter à votre mariage.")}</p><div class="extra-tiles">${tiles}</div></div></div>`;
}
// Textos de los avisos (email a facturación/comercial y WhatsApp con enlace de pago)
function extraFincaName(ev) { const l = (S.meta.locations || []).find(y => String(y.id) === String(ev.lugar)); return l ? l.name : (ev.lugarOtro || '—'); }
function extraEmailText(ev, x) {
  return `Para: facturacion@conectaso.es; comercial@conectaso.es
Asunto: Solicitud de servicio extra · Boda #${ev.id}

Los novios de la boda #${ev.id}${ev.conyuges ? ' (' + ev.conyuges + ')' : ''} quieren reservar el servicio:
• ${x[1]}

Lugar: ${extraFincaName(ev)}
Fecha del evento: ${dmy(ev.fecha)}

Acción: confirmar disponibilidad de material y técnicos. Al confirmar, la intranet enviará al cliente un WhatsApp con el enlace de pago de la reserva (${fmtEur(RESERVA_TOTAL)}).`;
}
function extraWhatsappText(ev, x) {
  return `Hola! 👋 Tenemos disponibilidad para *${x[1]}* en vuestra boda del ${dmy(ev.fecha)} en ${extraFincaName(ev)}.

Para reservarlo, abonad la reserva de *${fmtEur(RESERVA_TOTAL)}* (50 € + IVA) en este enlace de pago seguro:
👉 [enlace de pago Holded]

En cuanto recibamos el pago, el servicio quedará *reservado*. ¡Gracias! — Conecta So`;
}
// detalle desplegable de un servicio extra (info + imagen); la foto real se añadirá más adelante
function openExtraDetail(key, form) {
  const x = EXTRAS_CLIENTE.find(e => e[0] === key); if (!x) return;
  const cb = form.querySelector('input[name="' + key + '"]');
  const readonly = !cb || cb.disabled;
  const ov = document.createElement('div'); ov.className = 'xmodal';
  const render = () => {
    const on = cb && cb.checked;
    ov.innerHTML = `<div class="xmodal__box">
      <button type="button" class="xmodal__x" data-x aria-label="${tt('Cerrar', 'Tancar', 'Close', 'Fermer')}">✕</button>
      <div class="xmodal__img"><img src="${EXTRA_IMG}${key}.jpg" alt="${esc(exName(x))}" onerror="this.closest('.xmodal__img').classList.add('noimg')"><span class="xmodal__imgnote">${tt('Imagen pendiente de subir', 'Imatge pendent de pujar', 'Image to be uploaded', 'Image à télécharger')}</span></div>
      <div class="xmodal__body">
        <h3>${x[3] || ''} ${esc(exName(x))}</h3>
        <p>${esc(exDesc(x))}</p>
        ${readonly
          ? `<div class="xmodal__state ${on ? 'on' : ''}">${on ? tt('✓ Contratado para este evento', '✓ Contractat per a aquest esdeveniment', '✓ Booked for this event', '✓ Réservé pour cet événement') : tt('No contratado', 'No contractat', 'Not booked', 'Non réservé')}</div>`
          : `<button type="button" class="btn ${on ? 'btn--dark' : 'btn--primary'} btn--block" data-toggle>${on ? tt('Quitar de mi boda', 'Treure de la meva boda', 'Remove from my wedding', 'Retirer de mon mariage') : tt('Añadir a mi boda', 'Afegir a la meva boda', 'Add to my wedding', 'Ajouter à mon mariage')}</button>`}
      </div></div>`;
  };
  render();
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', e => {
    if (e.target === ov || e.target.closest('[data-x]')) return close();
    if (e.target.closest('[data-toggle]') && cb) {
      cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true }));
      const tile = form.querySelector('.extra-tile[data-extra="' + key + '"]');
      if (tile) { tile.classList.toggle('on', cb.checked); const st = tile.querySelector('.extra-tile__st'); if (st) st.textContent = cb.checked ? tt('✓ Añadido', '✓ Afegit', '✓ Added', '✓ Ajouté') : tt('Ver info', 'Veure info', 'View info', 'Voir info'); }
      render();
    }
  });
}
// convierte los <select data-search> en desplegables con buscador por texto
function enhanceSearchSelects(root) {
  $$('select[data-search]', root).forEach(select => {
    if (select.dataset.enh) return; select.dataset.enh = '1';
    const wrap = document.createElement('div'); wrap.className = 'ssel';
    const input = document.createElement('input'); input.type = 'text'; input.className = 'control ssel__input'; input.autocomplete = 'off';
    if (select.disabled) input.disabled = true;
    const menu = document.createElement('div'); menu.className = 'ssel__menu'; menu.hidden = true;
    select.style.display = 'none';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(input); wrap.appendChild(menu); wrap.appendChild(select);
    const sync = () => { const o = select.options[select.selectedIndex]; input.value = o ? o.text : ''; };
    const build = (q) => {
      q = (q || '').toLowerCase().trim(); menu.innerHTML = '';
      [...select.options].forEach((o, i) => {
        if (q && !o.text.toLowerCase().includes(q)) return;
        const it = document.createElement('div'); it.className = 'ssel__opt' + (i === select.selectedIndex ? ' on' : '');
        it.textContent = o.text; it.dataset.i = i; menu.appendChild(it);
      });
      if (!menu.children.length) menu.innerHTML = '<div class="ssel__empty">Sin resultados</div>';
    };
    const choose = i => { select.selectedIndex = i; sync(); select.dispatchEvent(new Event('change', { bubbles: true })); menu.hidden = true; };
    input.addEventListener('focus', () => { build(''); menu.hidden = false; input.select(); });
    input.addEventListener('input', () => { build(input.value); menu.hidden = false; });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const f = menu.querySelector('.ssel__opt'); if (f && !menu.hidden) { e.preventDefault(); choose(+f.dataset.i); } }
      else if (e.key === 'Escape') { menu.hidden = true; sync(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { menu.hidden = true; sync(); }, 150));
    menu.addEventListener('mousedown', e => { const it = e.target.closest('.ssel__opt'); if (it) { e.preventDefault(); choose(+it.dataset.i); } });
    sync();
  });
}
function paneServicios(ev, svcOpts, staffOpts, { readonly = false } = {}) {
  if (readonly || !svcOpts) {
    const rows = (ev.services || []).map(s => `<tr><td><b>${esc(extraName(s.servicio))}</b></td><td>${esc(userName(s.resp))}${s.resp2 ? ' · ' + esc(userName(s.resp2)) : ''}</td><td>${esc(s.horas || '')}</td></tr>`).join('');
    return `<div class="panel"><div class="panel__head"><h3>Servicios y responsables</h3></div><div class="panel__body"><div class="table-wrap"><table class="dt"><thead><tr><th>Servicio</th><th>Responsables</th><th>Horas extra</th></tr></thead><tbody>${rows || '<tr><td class="td-empty" colspan="3">Sin servicios</td></tr>'}</tbody></table></div></div></div>`;
  }
  const rows = (ev.services || []).map(s => svcRow(s, svcOpts, staffOpts)).join('');
  return `<div class="panel"><div class="panel__head"><h3>Servicios y responsables</h3><button type="button" class="btn btn--sm" id="addSvc">+ Añadir servicio</button></div>
    <div class="panel__body"><div class="svc-head"><span>Servicio</span><span>Responsable</span><span>Responsable 2</span><span></span></div><div id="svcBox">${rows}</div>
    <p class="hint" style="margin-top:8px">El importe que paga el cliente lo pones a mano arriba en <b>Pago cliente</b>; aquí solo se vincula el servicio con su técnico.</p></div></div>`;
}
function svcRow(s, svcOpts, staffOpts) {
  return `<div class="svc-row" data-svc><div>${sel('', svcOpts, s.servicio, 'data-s="servicio" data-search')}</div><div>${sel('', staffOpts, s.resp, 'data-s="resp" data-search')}</div><div>${sel('', staffOpts, s.resp2, 'data-s="resp2" data-search')}</div><button type="button" class="btn btn--icon" data-del-svc>✕</button></div>`;
}
function paneFacturacion(ev) {
  const rowsOf = src => (src || []).map(r => { const mk = r[2] || ''; const cls = mk === 'h' ? 'fact-h' : mk === 's' ? 'fact-s' : mk === 't' ? 'fact-t' : mk === 'w' ? 'fact-w' : mk === 'sub' ? 'fact-sub' : mk === 'note' ? 'fact-note' : ''; return `<tr class="${cls}"><td>${esc(r[0])}</td><td style="text-align:right">${esc(r[1] || '')}</td></tr>`; }).join('');
  const rows = rowsOf(ev.factRows);
  const revRows = isAdmin() ? rowsOf(ev.revRows) : '';
  const plusList = (ev.plus || []).length ? `<ul class="plus-list">${ev.plus.map(p => `<li><span class="plus-amt ${(+p.amount) < 0 ? 'neg' : 'pos'}">${(+p.amount) > 0 ? '+' : ''}${esc(p.amount)} €</span> ${p.userId ? '<b>' + esc(userName(p.userId)) + '</b> · ' : ''}${esc(p.concept || 'Plus')}</li>`).join('')}</ul>` : '';
  const staffOpts = [['', 'General (sin trabajador)']].concat((S.meta.staff || []).map(s => [s.id, s.name]));
  const plusAdd = isAdmin() ? (eventFinished(ev)
    ? `<div class="plus-add"><h4 class="form-sub">Añadir plus a esta boda</h4>
        <div class="plus-add__row">
          ${inp('plus_amount', '', { type: 'number', ph: 'Importe (+/−) €' })}
          ${inp('plus_concept', '', { ph: 'Concepto (opcional)' })}
          ${sel('plus_user', staffOpts, '')}
          <button type="button" class="btn btn--primary" id="addPlusBtn">Añadir</button>
        </div><p class="hint">El importe puede ser positivo o negativo. Si eliges un trabajador, se suma a su facturación.</p></div>`
    : `<p class="hint" style="margin-top:14px">Los pluses solo pueden añadirse <b>una vez finalizada la boda</b>.</p>`) : '';
  return `<div class="panel"><div class="panel__head"><h3>Facturación del evento</h3></div><div class="panel__body">
    <h4 class="form-sub">Coste de personal</h4>
    ${rows ? `<div class="table-wrap"><table class="dt"><tbody>${rows}</tbody></table></div>` : '<div class="empty">Sin datos de facturación.</div>'}
    ${revRows ? `<h4 class="form-sub" style="margin-top:18px">Ingresos y beneficio</h4><div class="table-wrap"><table class="dt"><tbody>${revRows}</tbody></table></div>` : ''}
    ${(ev.plus || []).length ? `<h4 class="form-sub">Pluses</h4>${plusList}` : ''}${plusAdd}
    ${eventFinished(ev) ? `<div class="form-grid" style="margin-top:18px">${fg('Pedir opinión', sel('ask_for_opinion', [['', '—'], 'Si', 'No'], ev.opinion))}${fg('Observaciones del DJ', ta('dj_observations', ev.obsDj))}</div>
      ${ev.djId ? `<div class="btn-row" style="margin-top:12px"><button type="button" class="btn btn--sm btn--blue" data-albaran-link title="Genera el enlace de autologin para que el DJ rellene su parte">🔗 Enlace parte de trabajo del DJ</button></div>` : ''}` : '<p class="hint" style="margin-top:14px">El albarán del DJ (horas extra, opinión y observaciones) se rellena cuando finaliza la boda.</p>'}</div></div>`;
}

/* --- interacción del formulario de evento --- */
// bloque "Acceso a la boda": titular + invitados (novio/novia con su propio email)
// bloque de pago del cliente: total, pagado, pendiente y botón de pasarela (Holded)
function clientPaymentBlock(ev) {
  const p = ev.pago; if (!p) return '';
  const pend = p.pendiente;
  const firstHalf = Math.round(pend * 50) / 100; // 50% del pendiente (a céntimos)
  return `<div class="panel pay-block"><div class="panel__head"><h3>Tu pago</h3></div><div class="panel__body">
    <div class="pay-grid">
      <div class="pay-cell"><span>Importe total</span><b>${fmtEur(p.total)}</b></div>
      <div class="pay-cell"><span>Pagado</span><b style="color:#0B8043">${fmtEur(p.pagado)}</b></div>
      <div class="pay-cell"><span>Pendiente</span><b style="color:${pend > 0 ? '#D50000' : '#0B8043'}">${fmtEur(pend)}</b></div>
    </div>
    ${pend > 0
      ? `<div class="pay-actions">
           <button type="button" class="btn btn--primary" id="payNow">💳 Pagar todo el pendiente (${fmtEur(pend)})</button>
           <button type="button" class="btn btn--dark" id="payHalf">➗ Pagar en 2 plazos (ahora ${fmtEur(firstHalf)})</button>
         </div>
         <p class="hint" style="margin-top:8px">Pago seguro con tarjeta. Puedes abonar el total de una vez o dividirlo en <b>2 plazos</b>. <span class="muted">La pasarela se conectará con Holded cuando esté publicada.</span></p>`
      : `<p style="margin-top:12px;color:#0B8043;font-weight:700">✓ Está todo pagado. ¡Gracias!</p>`}
  </div></div>`;
}
function accessBlock(ev) {
  if (!(S.user.role === 'admin' || S.user.role === 'user')) return '';
  const users = ev.accessUsers || [];
  return `<div class="panel access-block"><div class="panel__head"><h3>Acceso a la boda</h3><button type="button" class="btn btn--sm btn--blue" data-invite-user>+ Invitar a otra persona</button></div>
    <div class="panel__body"><p class="hint" style="margin-bottom:10px">${tt('Novio y novia (o quien queráis) podéis tener cada uno vuestro acceso con vuestro propio email.', 'Els dos (o qui vulgueu) podeu tenir cadascú el vostre accés amb el vostre propi email.', 'Both of you (or whoever you like) can each have your own access with your own email.', 'Vous pouvez chacun (ou qui vous voulez) avoir votre propre accès avec votre propre email.')}</p>
      <ul class="access-list">${users.length ? users.map(u => `<li><b>${esc(u.name || u.email)}</b> <span class="muted">${esc(u.email)}</span> ${u.owner ? '<span class="tag tag--green">Titular</span>' : `<button type="button" class="btn btn--xs btn--red" data-rm-user="${u.id}">Quitar</button>`}</li>`).join('') : '<li class="muted">Sin accesos todavía.</li>'}</ul></div></div>`;
}
function wireEventForm(ev, { full, role, canEditMusic, canSave }) {
  const form = el('evForm'); if (!form) return;
  // acceso a la boda: invitar / quitar personas
  const wireAccess = () => {
    const ib = form.querySelector('[data-invite-user]');
    if (ib) ib.onclick = () => {
      modal('Invitar a otra persona a la boda', `<form id="invUForm"><p class="hint">Recibirá un email para crear su contraseña y acceder a la ficha de esta boda.</p>
        <div class="field"><label>Nombre</label>${inp('iname', '', { ph: 'Ej: María' })}</div>
        <div class="field"><label>Email</label>${inp('iemail', '', { type: 'email' })}</div></form>`,
        { okText: 'Enviar invitación', onOk: () => {
          const d = collectForm($('#invUForm'));
          if (!d.iemail || d.iemail.indexOf('@') < 0) { toast('Indica un email válido', 'err'); return true; }
          api('events/' + ev.id + '/invite-user', { method: 'POST', body: { email: d.iemail, name: d.iname } })
            .then(() => { toast('Invitación enviada a ' + d.iemail, 'ok'); reloadAccess(); })
            .catch(e => toast(e.message || 'No se pudo invitar', 'err'));
        } });
    };
    form.querySelectorAll('[data-rm-user]').forEach(b => b.onclick = () => {
      api('events/' + ev.id + '/remove-user', { method: 'POST', body: { userId: b.dataset.rmUser } })
        .then(() => { toast('Acceso quitado', 'ok'); reloadAccess(); }).catch(e => toast(e.message || 'Error', 'err'));
    });
  };
  const reloadAccess = async () => { try { const r = await api('events/' + ev.id); ev.accessUsers = r.event.accessUsers; const blk = form.querySelector('.access-block'); if (blk) { blk.outerHTML = accessBlock(ev); wireAccess(); } } catch (e) {} };
  wireAccess();
  // botones de pago (pasarela Holded, pendiente de conectar): total o en 2 plazos
  const payPend = (ev.pago && ev.pago.pendiente) || 0;
  const payFirst = Math.round(payPend * 50) / 100;
  const holdedNote = `<p class="hint" style="margin-top:8px">Esta pasarela se conectará con <b>Holded</b> cuando la intranet esté publicada. De momento es una demostración del flujo.</p>`;
  const payNowBtn = form.querySelector('#payNow');
  if (payNowBtn) payNowBtn.onclick = () => modal('Pago seguro', `<p>Vas a abonar tu importe pendiente completo: <b>${fmtEur(payPend)}</b>.</p>
    <p class="hint">Serás redirigido a la pasarela de pago segura.</p>${holdedNote}`, { okText: 'Ir a pagar' });
  const payHalfBtn = form.querySelector('#payHalf');
  if (payHalfBtn) payHalfBtn.onclick = () => modal('Pago en 2 plazos', `<p><b>Primer plazo (ahora):</b> ${fmtEur(payFirst)} <span class="muted">(50%)</span></p>
    <p><b>Segundo plazo:</b> ${fmtEur(payPend - payFirst)} — lo podrás abonar más adelante desde esta misma pantalla.</p>
    <p class="hint">Ahora pagarás solo el primer plazo.</p>${holdedNote}`, { okText: 'Pagar primer plazo' });
  // logo del fotomatón: se lee como dataURL y se guarda en un campo oculto
  const fotoInput = form.querySelector('#fotoLogoInput');
  const fotoHidden = form.querySelector('input[name="foto_logo_data"]');
  const fotoPrev = form.querySelector('#fotoLogoPrev');
  const paintFoto = url => { if (!fotoPrev) return; fotoPrev.innerHTML = url ? `<img src="${url}" alt="Logo fotomatón"><button type="button" class="btn btn--xs btn--red" id="fotoLogoDel">Quitar</button>` : ''; const del = fotoPrev.querySelector('#fotoLogoDel'); if (del) del.onclick = () => { if (fotoHidden) fotoHidden.value = ''; if (fotoInput) fotoInput.value = ''; paintFoto(''); }; };
  if (fotoInput) fotoInput.onchange = () => {
    const f = fotoInput.files && fotoInput.files[0]; if (!f) return;
    if (f.size > 4 * 1024 * 1024) { toast('La imagen es muy grande (máx. 4 MB)', 'err'); fotoInput.value = ''; return; }
    const rd = new FileReader();
    rd.onload = () => { if (fotoHidden) fotoHidden.value = rd.result; paintFoto(rd.result); };
    rd.readAsDataURL(f);
  };
  if (fotoPrev) paintFoto(fotoHidden ? fotoHidden.value : '');
  // desplazamiento para lugar "Otro" (solo admin): pegar enlace de Google Maps y calcular
  const otroBtn = form.querySelector('#otroTravelCalc');
  if (otroBtn) otroBtn.onclick = async () => {
    const inp2 = form.querySelector('#otroTravelLink'); const link = (inp2 && inp2.value || '').trim();
    const ll = parseLatLngP(link);
    if (!ll) { toast('Pega el enlace largo de Google Maps (con @lat,long) o escribe "lat,long".', 'err'); return; }
    otroBtn.disabled = true; otroBtn.textContent = 'Calculando…';
    let min, km, approx = false;
    try {
      const r = await fetch('https://router.project-osrm.org/route/v1/driving/2.2440,41.5293;' + ll[1] + ',' + ll[0] + '?overview=false');
      const j = await r.json(); const rt = j.routes && j.routes[0]; if (!rt) throw 0;
      min = Math.round(rt.duration / 60); km = Math.round(rt.distance / 100) / 10;
    } catch (e) {
      const toRad = d => d * Math.PI / 180, R = 6371, dLat = toRad(ll[0] - 41.5293), dLng = toRad(ll[1] - 2.2440);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(41.5293)) * Math.cos(toRad(ll[0])) * Math.sin(dLng / 2) ** 2;
      km = Math.round(2 * R * Math.asin(Math.sqrt(a)) * 1.3 * 10) / 10; min = Math.round(km / 50 * 60); approx = true;
    }
    try {
      await api('events/' + ev.id, { method: 'PUT', body: { event: { otroLat: ll[0], otroLng: ll[1], otroTravelMin: min, otroTravelKm: km, otroApprox: approx, otroLink: link } } });
      Object.assign(ev, { otroLat: ll[0], otroLng: ll[1], otroTravelMin: min, otroTravelKm: km, otroApprox: approx, otroLink: link });
      const sp = form.querySelector('#travelMins'); if (sp) sp.innerHTML = `<b>🚗 ${approx ? '~' : ''}${min} min</b> · ${km} km <span class="muted">desde Martorelles${approx ? ' (aprox.)' : ''}</span>`;
      const mp = form.querySelector('#travelMaps'); if (mp) mp.href = 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(BASE_ADDR) + '&destination=' + ll[0] + ',' + ll[1] + '&travelmode=driving';
      toast(`${approx ? '≈ ' : ''}${min} min · ${km} km`, 'ok');
    } catch (e) { toast('No se pudo guardar', 'err'); } finally { otroBtn.disabled = false; otroBtn.textContent = 'Calcular'; }
  };
  // playlist de Spotify: lista ordenada de momentos + operativa (creación real al conectar Spotify)
  const spotiBtn = form.querySelector('#openSpoti');
  if (spotiBtn) spotiBtn.onclick = () => {
    const ls = eventMusicLinks(ev);
    const rows = ls.map((l, i) => `<li><span class="spoti-n">${i + 1}.</span> <b>${esc(l.title)}</b>${l.song ? ' — ' + esc(l.song) : ''} <a href="${esc(l.url)}" target="_blank" rel="noopener" class="spoti-open">abrir</a></li>`).join('');
    modal('Tu playlist de Spotify', `<p>Hemos reunido <b>${ls.length} canciones</b> de los momentos de tu boda, en orden:</p>
      <ol class="spoti-list">${rows}</ol>
      <p class="hint" style="margin-top:10px">Cuando la intranet esté publicada y conectada con <b>Spotify</b>, este botón creará la playlist automáticamente en la cuenta y te dará el enlace para abrirla. De momento es una demostración del flujo.</p>`,
      { okText: 'Entendido' });
  };
  enhanceSearchSelects(form);
  // pestañas
  const tabs = el('evTabs');
  if (tabs) tabs.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return; $$('[data-tab]', tabs).forEach(x => x.classList.toggle('on', x === b)); $$('[data-pane]', form).forEach(p => p.style.display = p.dataset.pane === b.dataset.tab ? '' : 'none'); if (b.dataset.tab === 'archivos') loadFiles(ev); if (b.dataset.tab === 'ruta' && typeof loadRutaPlano === 'function') loadRutaPlano(ev); });
  // añadir plus (admin, solo boda finalizada)
  function wirePlus() {
    const pb = form.querySelector('#addPlusBtn'); if (!pb) return;
    pb.onclick = async () => {
      const amount = +((form.querySelector('[name=plus_amount]') || {}).value || 0);
      if (!amount) { toast('Indica un importe (puede ser positivo o negativo)', 'err'); return; }
      const concept = (form.querySelector('[name=plus_concept]') || {}).value || '';
      const userId = (form.querySelector('[name=plus_user]') || {}).value || '';
      try { const r = await api('events/' + ev.id + '/plus', { method: 'POST', body: { amount, concept, userId: userId || null } }); Object.assign(ev, r.event); toast('Plus añadido', 'ok'); const pane = form.querySelector('[data-pane="facturacion"]'); if (pane) { pane.innerHTML = paneFacturacion(ev); wirePlus(); } }
      catch (e) { toast(e.message || 'No se pudo añadir el plus', 'err'); }
    };
  }
  wirePlus();
  // aviso al asignar un DJ/técnico que está de vacaciones el día de la boda
  const vacs = S.meta.vacations || [];
  const checkVac = wid => {
    if (!wid || !ev.fecha) return;
    const v = vacs.find(x => x.userId == wid && x.status !== 'Denegado' && x.start && x.end && ev.fecha >= x.start && ev.fecha <= x.end);
    if (v) toast('⚠ ' + (userName(wid) || 'Ese trabajador') + ' está de vacaciones el día de la boda (' + dmy(v.start) + '–' + dmy(v.end) + ')', 'err');
  };
  form.addEventListener('change', e => { const t = e.target; if (t && t.tagName === 'SELECT' && (t.name === 'dj_vinculated' || (t.matches && t.matches('[data-s="resp"],[data-s="resp2"]')))) checkVac(t.value); });
  // sub-pestañas de música (Ceremonia · Aperitivo · Banquete · Fiesta · Entregas · Extras)
  const mtabs = form.querySelector('[data-mtabs]');
  if (mtabs) mtabs.addEventListener('click', e => { const b = e.target.closest('[data-mtab]'); if (!b) return; const wrap = b.closest('.music-wrap'); $$('[data-mtab]', mtabs).forEach(x => x.classList.toggle('on', x === b)); $$('[data-mpane]', wrap).forEach(p => { const on = p.dataset.mpane === b.dataset.mtab; p.style.display = on ? '' : 'none'; p.classList.toggle('on', on); }); });
  // lugar "otro"
  const locSel = form.querySelector('[name=celebration_location]');
  if (locSel) locSel.addEventListener('change', () => { const w = el('otroWrap'); if (w) w.style.display = locSel.value === 'otro' ? 'block' : 'none'; });
  // importes en vivo
  if (full) ['event_total_import', 'event_payed_import'].forEach(n => { const i = form.querySelector('[name=' + n + ']'); if (i) i.addEventListener('input', () => { const t = +form.event_total_import.value || 0, p = +form.event_payed_import.value || 0; if (el('pendField')) el('pendField').value = (t - p) + ' €'; }); });
  // toggle Habilitar edición: texto Activado/Desactivado en vivo
  const enTog = form.querySelector('[name=habilitar_edicion_para_usuario]');
  if (enTog) enTog.addEventListener('change', () => { const st = enTog.closest('.switch--onoff').querySelector('.switch-state'); if (st) st.textContent = enTog.checked ? 'Activado' : 'Desactivado'; });
  // tarjetas de servicios extra: marcar/desmarcar en vivo
  form.addEventListener('change', e => {
    const sw = e.target.closest('.switch--incl'); if (sw && e.target.matches('input[type=checkbox]')) { const st = sw.querySelector('.switch-state'); if (st) st.textContent = e.target.checked ? 'Desactivado' : 'Activado'; }
  });
  // ceremonia fuera del lugar: activa el mensaje en Música → Ceremonia en vivo
  const cOut = form.querySelector('[name=ceremony_outside]');
  if (cOut) cOut.addEventListener('change', () => { const ci = form.querySelector('.ceremony-inner'); if (ci) ci.classList.toggle('ceremony-out', cOut.checked); });
  // fecha bloqueada para novios/dj/planner: al pulsarla, aviso de que solo la cambia administración
  form.addEventListener('mousedown', e => { const dl = e.target.closest('[data-datelock]'); if (dl) { e.preventDefault(); dl.blur(); toast('La fecha solo la cambia administración. Si necesitáis moverla, escribidnos y la gestionamos nosotros.', 'info'); } });
  // flujo de reserva de extras: confirmar disponibilidad / pagar reserva / ver aviso
  const reloadExtras = async () => { try { const r = await api('events/' + ev.id); ev.extraStatus = r.event.extraStatus || {}; const exRO = S.user.role === 'admin' ? false : !((S.user.role === 'user' && ev.canEdit) || S.user.role === 'planner'); const pane = form.querySelector('[data-pane="extras"]'); if (pane) { pane.innerHTML = paneExtras(ev, { readonly: exRO }); } } catch (e) {} };
  form.addEventListener('click', async e => {
    const al = e.target.closest('[data-albaran-link]');
    if (al) { e.preventDefault(); al.disabled = true;
      try {
        const r = await api('events/' + ev.id + '/albaran-link');
        const link = location.origin + '/#/albaran?token=' + encodeURIComponent(r.token) + '&ev=' + ev.id;
        const asunto = encodeURIComponent('Tu parte de trabajo · boda #' + ev.id);
        const cuerpo = encodeURIComponent('Hola ' + (r.workerName || '') + ',\n\nLa boda ha finalizado. Entra en este enlace para rellenar tu parte de trabajo (entras directamente, sin contraseña):\n' + link + '\n\nGracias.');
        modal('Enlace del parte de trabajo', `<p>Comparte este enlace con <b>${esc(r.workerName || 'el DJ')}</b>. Al abrirlo <b>entra directamente</b> (sin contraseña) a rellenar ${r.hourly ? 'su parte de horas' : 'su albarán'} de esta boda. Caduca en 7 días.</p>
          <div class="field"><label>Enlace</label><input class="control" id="albLink" readonly value="${esc(link)}" onclick="this.select()"></div>
          <div class="btn-row"><button type="button" class="btn btn--sm btn--primary" id="albCopy">Copiar enlace</button> <a class="btn btn--sm" href="mailto:?subject=${asunto}&body=${cuerpo}">Abrir en email</a></div>`, { okText: 'Cerrar' });
        setTimeout(() => { const c = document.getElementById('albCopy'); if (c) c.onclick = () => { const i = document.getElementById('albLink'); i.select(); try { navigator.clipboard.writeText(i.value); } catch (x) { document.execCommand('copy'); } toast('Enlace copiado', 'ok'); }; }, 60);
      } catch (err) { toast(err.message || 'No se pudo generar el enlace', 'err'); }
      finally { al.disabled = false; }
      return; }
    const sh = e.target.closest('[data-save-hours]');
    if (sh) { e.preventDefault();
      const inp2 = form.querySelector('#helperHours'); const msg = form.querySelector('#hoursMsg');
      const hours = parseFloat((inp2 || {}).value);
      if (isNaN(hours) || hours < 0) { if (msg) { msg.textContent = 'Indica un número de horas válido.'; msg.style.color = '#d9534f'; } return; }
      sh.disabled = true; if (msg) { msg.textContent = 'Guardando…'; msg.style.color = ''; }
      try { await api('events/' + ev.id + '/mis-horas', { method: 'POST', body: { hours } }); if (msg) { msg.textContent = '✓ Horas guardadas'; msg.style.color = '#0B8043'; } toast('Horas guardadas', 'ok'); }
      catch (err) { if (msg) { msg.textContent = err.message || 'Error al guardar'; msg.style.color = '#d9534f'; } }
      finally { sh.disabled = false; }
      return; }
    const cf = e.target.closest('[data-extra-confirm]');
    const pay = e.target.closest('[data-extra-pay]');
    const mail = e.target.closest('[data-extra-mail]');
    if (cf) { e.preventDefault(); e.stopPropagation(); const key = cf.dataset.extraConfirm; const x = EXTRAS_CLIENTE.find(y => y[0] === key);
      modal('Confirmar disponibilidad · ' + x[1], `<p>Al confirmar, la intranet enviará este <b>WhatsApp</b> a los novios con el enlace de pago de la reserva:</p>
        <pre class="msg-preview">${esc(extraWhatsappText(ev, x))}</pre>`, { okText: 'Confirmar y enviar', onOk: () => { api('events/' + ev.id + '/extra-confirm', { method: 'POST', body: { key } }).then(() => { toast('Disponibilidad confirmada · WhatsApp enviado', 'ok'); reloadExtras(); }).catch(err => toast(err.message || 'Error', 'err')); } });
      return; }
    if (pay) { e.preventDefault(); e.stopPropagation(); const key = pay.dataset.extraPay; const x = EXTRAS_CLIENTE.find(y => y[0] === key); const admin = S.user.role === 'admin';
      modal(admin ? 'Marcar reserva pagada' : 'Pagar reserva · ' + x[1], admin
        ? `<p>Marca como pagada la reserva de <b>${esc(x[1])}</b> (${fmtEur(RESERVA_TOTAL)}).</p>`
        : `<p>Reserva de <b>${esc(x[1])}</b>: <b>${fmtEur(RESERVA_TOTAL)}</b> (50 € + IVA).</p><p class="hint">Serás redirigido a la pasarela de pago segura. <span class="muted">Se conectará con Holded al publicar.</span></p>`,
        { okText: admin ? 'Marcar pagado' : 'Pagar ahora', onOk: () => { api('events/' + ev.id + '/extra-pay', { method: 'POST', body: { key } }).then(() => { toast('Reserva pagada · servicio reservado', 'ok'); reloadExtras(); }).catch(err => toast(err.message || 'Error', 'err')); } });
      return; }
    if (mail) { e.preventDefault(); e.stopPropagation(); const key = mail.dataset.extraMail; const x = EXTRAS_CLIENTE.find(y => y[0] === key);
      modal('Aviso enviado a facturación y comercial', `<pre class="msg-preview">${esc(extraEmailText(ev, x))}</pre>`, { okText: 'Cerrar' });
      return; }
    // abrir el detalle de un servicio extra al pulsar su icono (no si se pulsa un botón de acción)
    const t = e.target.closest('.extra-tile'); if (t && !e.target.closest('[data-noopen]')) { e.preventDefault(); openExtraDetail(t.dataset.extra, form); }
  });
  form.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.extra-tile') && !e.target.closest('[data-noopen]')) { e.preventDefault(); openExtraDetail(e.target.closest('.extra-tile').dataset.extra, form); } });
  // comentario plegable de cada momento
  form.addEventListener('click', e => { const t = e.target.closest('[data-cmt-toggle]'); if (!t) return; e.preventDefault(); const box = t.closest('[data-cmt]'); const body = box.querySelector('.cmt-body'); const open = box.classList.toggle('open'); body.style.display = open ? '' : 'none'; if (open) { const i = body.querySelector('input,textarea'); if (i) i.focus(); } });
  // añadir / quitar momentos · subir / bajar
  form.addEventListener('click', e => {
    const add = e.target.closest('[data-add-opt]'); if (add) { const box = form.querySelector(`[data-sortbox="${add.dataset.addOpt}"]`); box.insertAdjacentHTML('beforeend', optRow({ sec: add.dataset.addOpt }, { readonly: false })); if (form._updProgress) form._updProgress(); }
    const delo = e.target.closest('[data-del-opt]'); if (delo) { delo.closest('[data-moment]').remove(); if (form._updProgress) form._updProgress(); }
    if (e.target.id === 'addSvc') { const staffOpts = [['', 'Selecciona un usuario']].concat((S.meta.staff || []).map(u => [u.id, u.name])); const svcOpts = [['', 'Selecciona un servicio']].concat((S.meta.extras || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'es')).map(x => [x.id, x.name])); el('svcBox').insertAdjacentHTML('beforeend', svcRow({}, svcOpts, staffOpts)); enhanceSearchSelects(el('svcBox')); }
    const dsv = e.target.closest('[data-del-svc]'); if (dsv) dsv.closest('[data-svc]').remove();
    if (e.target.id === 'genPlaylist') { e.preventDefault(); showPlaylist(form); }
  });
  // al escribir un enlace → botón para abrirlo; al escribir el nombre del cónyuge → actualiza el título de su entrada
  form.addEventListener('input', e => {
    const lk = e.target.closest('[data-link]'); if (lk) { const chip = lk.parentElement.querySelector('[data-chip]'); if (chip) chip.innerHTML = linkChip(lk.value); }
    if (e.target.name === 'first_spouse' || e.target.name === 'second_spouse') {
      const key = e.target.name === 'first_spouse' ? 'ceremony_first_spouse_entry' : 'ceremony_second_spouse_entry';
      const row = form.querySelector(`[data-moment][data-key="${key}"]`);
      if (row) { const span = row.querySelector('[data-mtitle]'); const n = e.target.value.trim(); if (span) span.textContent = n ? 'Entrada de ' + n : (row.dataset.deftitle || ''); }
    }
  });
  // progreso en vivo + marcar "Completado" al 100% (como en la intranet original)
  if (full) {
    const updateProgress = () => {
      const bar = el('progBar'); if (!bar) return;
      const songs = $$('[data-moment] input[name]', form).filter(i => /^(ceremony|aperitif|banquet|disco)_[a-z_]+$/.test(i.name));
      const optVals = $$('[data-moment] [data-f=value]', form);
      const mains = ['wedding_type', 'wedding_date', 'wedding_hour', 'celebration_location', 'payment_method'].map(n => form.querySelector('[name=' + n + ']')).filter(Boolean);
      const all = [...songs, ...optVals, ...mains];
      const filled = all.filter(i => String(i.value || '').trim() !== '').length;
      const pct = all.length ? Math.max(5, Math.round(filled / all.length * 100)) : 0;
      bar.style.width = pct + '%'; bar.textContent = pct + '%';
      if (pct === 100) { const st = form.querySelector('[name=event_status]'); const compIdx = (S.meta.estados || []).findIndex(s => /completad/i.test(s.n)); if (st && compIdx >= 0 && st.value !== String(compIdx)) st.value = String(compIdx); }
    };
    form.addEventListener('input', updateProgress);
    updateProgress();
  } else if (role === 'user' || role === 'planner') {
    // progreso en vivo para novios/planner: cuenta SOLO los campos musicales activos
    // (los momentos desactivados no cuentan) y los personalizados añadidos. Los campos
    // vacíos obligatorios se marcan en amarillo; al escribir pasan al color base.
    const upd = () => {
      const bar = el('progBar'); if (!bar) return;
      // campo de canción de cada momento fijo que NO esté desactivado ("no se incluye")
      const songs = $$('[data-moment] input[name]', form).filter(i => /^(ceremony|aperitif|banquet|disco)_[a-z_]+$/.test(i.name) && !((i.closest('[data-moment]').querySelector('input[name^=check_]') || {}).checked));
      const optVals = $$('[data-moment][data-opt] [data-f=value]', form);  // personalizados añadidos
      const playlist = form.querySelector('[name=link_playlist]');
      const req = [...songs, ...optVals]; if (playlist) req.push(playlist);
      $$('.control.req-empty', form).forEach(i => i.classList.remove('req-empty')); // limpiar
      let filled = 0;
      req.forEach(i => {
        const ok = String(i.value || '').trim() !== '';
        if (ok) filled++;
        else i.classList.add('req-empty');   // obligatorio vacío → amarillo
      });
      const pct = req.length ? Math.round(filled / req.length * 100) : 0;
      bar.style.width = pct + '%'; bar.textContent = pct + '%';
      const num = el('progPct'); if (num) num.textContent = pct + '%';
    };
    form.addEventListener('input', upd);
    form.addEventListener('change', upd);   // para las casillas de "no se incluye"
    form._updProgress = upd;                // para llamarlo al añadir/quitar momentos
    upd();
  }
  // reordenar arrastrando (ratón y táctil)
  initSortable(form);
  // guardar
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const payload = buildEventPayload(ev, form, { full, role, canEditMusic });
    const btn = form.querySelector('button[type=submit]');
    const orig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.classList.remove('btn--ok'); btn.classList.add('btn--loading'); btn.innerHTML = '<span class="btn-spin"></span> Guardando…'; }
    try {
      const r = await api('events/' + ev.id, { method: 'PUT', body: { event: payload } });
      Object.assign(ev, r.event); reloadExtras();
      if (btn) { btn.classList.remove('btn--loading'); btn.classList.add('btn--ok'); btn.innerHTML = '✓ Guardado'; setTimeout(() => { btn.classList.remove('btn--ok'); btn.innerHTML = orig; btn.disabled = false; }, 1600); }
      else toast('Guardado correctamente', 'ok');
    } catch (err) {
      toast(err.message, 'err');
      if (btn) { btn.classList.remove('btn--loading'); btn.innerHTML = orig; btn.disabled = false; }
    }
  });
}
// Arrastrar para reordenar momentos dentro de cada bloque. Usa Pointer Events: funciona con ratón y con el dedo (táctil).
function initSortable(form) {
  form.addEventListener('pointerdown', e => {
    const g = e.target.closest('.m-grip'); if (!g) return;
    e.preventDefault();
    const row = g.closest('[data-moment]'); const box = row.parentElement; if (!box || !box.matches('[data-sortbox]')) return;
    row.classList.add('dragging');
    try { g.setPointerCapture(e.pointerId); } catch (x) {}
    const move = ev => {
      const els = [...box.querySelectorAll('[data-moment]:not(.dragging)')];
      let before = null;
      for (const c of els) { const b = c.getBoundingClientRect(); if (ev.clientY < b.top + b.height / 2) { before = c; break; } }
      if (before) box.insertBefore(row, before); else box.appendChild(row);
    };
    const up = () => { row.classList.remove('dragging'); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
  });
}
function buildEventPayload(ev, form, { full, role, canEditMusic }) {
  const d = collectForm(form);
  // Lee música y momentos recorriendo el DOM en el ORDEN actual (tras arrastrar / subir-bajar).
  const mo = (() => {
    const music = {}, optionals = [];
    $$('[data-sortbox]', form).forEach(box => {
      [...box.querySelectorAll('[data-moment]')].forEach((row, i) => {
        const order = String(i + 1);
        if (row.dataset.key) {
          const k = row.dataset.key;
          music[k] = Object.assign({}, (ev.music || {})[k], {
            on: (row.querySelector('[name="check_' + k + '"]') || {}).checked || false,
            song: (row.querySelector('[name="' + k + '"]') || {}).value || '',
            link: (row.querySelector('[name="link_' + k + '"]') || {}).value || '',
            comment: (row.querySelector('[name="comment_' + k + '"]') || {}).value || '', order });
        } else {
          optionals.push({ id: +row.dataset.oid || 0, kind: row.dataset.kind || 'optionals', area: row.dataset.area || 'ceremony', sec: box.dataset.sortbox, order,
            title: ($('[data-f=title]', row) || {}).value || '', value: ($('[data-f=value]', row) || {}).value || '', link: ($('[data-f=link]', row) || {}).value || '', comment: ($('[data-f=comment]', row) || {}).value || '' });
        }
      });
    });
    return { music, optionals };
  })();
  const readMoments = () => mo.music;
  const readOpts = () => mo.optionals;
  const readDisco = () => ({ playlist: d.link_playlist, compliance: d.compliance_list || '', guests: d.guest_requests || '', restrictions: d.disco_restrictions, observations: d.disco_observations, fotoLogo: d.foto_logo_data || '' });
  const readExtras = () => { const o = {}; EXTRAS_CLIENTE.forEach(x => { if (d[x[0]]) o[x[0]] = true; }); return o; };
  const readSpouses = () => ['first', 'second'].map((p, i) => Object.assign({}, (ev.spouses || [])[i] || {}, { name: d[p + '_spouse'], dni: d[p + '_spouse_dni'], email: d[p + '_spouse_email'], mobile: d[p + '_spouse_mobile'], address: d[p + '_spouse_address'] }));

  if (!full) {
    // cliente: música/momentos/extras/datos permitidos; dj: solo obsDj
    if (role === 'dj') return { obsDj: d.dj_observations, djOvertime: d.dj_assigned_overtime, opinion: d.ask_for_opinion };
    const out = { music: readMoments(), optionals: readOpts(), disco: readDisco(), extras: readExtras(), spouses: readSpouses(),
      guests: d.guest_number, celebrationHour: d.celebration_hour, lugarCeremonia: d.wedding_location, hora: d.wedding_hour, ceremoniaFuera: !!d.ceremony_outside };
    return out;
  }
  // admin: todo
  return {
    tipo: d.wedding_type, fecha: d.wedding_date, hora: d.wedding_hour, celebrationHour: d.celebration_hour,
    lugar: d.celebration_location === 'otro' ? 0 : +d.celebration_location, lugarOtro: d.celebration_location === 'otro' ? d.celebration_location_other : '',
    lugarCeremonia: d.wedding_location, ceremoniaFuera: !!d.ceremony_outside, guests: d.guest_number, obsPriv: d.privat_observations,
    metodo: d.payment_method, estado: +d.event_status, pagoCliente: +d.event_total_import || 0, pagado: +d.event_payed_import || 0,
    editUser: d.habilitar_edicion_para_usuario, editUnlock: d.habilitar_edicion_para_usuario,
    djId: +d.dj_vinculated || '', djOvertime: d.dj_assigned_overtime, wpId: +d.wp_vinculated || '',
    music: readMoments(), optionals: readOpts(), disco: readDisco(), extras: readExtras(), spouses: readSpouses(),
    opinion: d.ask_for_opinion, obsDj: d.dj_observations,
    services: $$('[data-svc]', form).map(r => ({ servicio: +$('[data-s=servicio]', r).value || '', resp: +$('[data-s=resp]', r).value || '', resp2: +$('[data-s=resp2]', r).value || '', precio: (($('[data-s=precio]', r) || {}).value || '') })).filter(s => s.servicio),
  };
}
function showPlaylist(form) {
  const songs = [];
  $$('[data-moment]', form).forEach(row => {
    const inp = row.dataset.key ? row.querySelector('[name="' + row.dataset.key + '"]') : row.querySelector('[data-f=value]');
    const link = (row.querySelector('[data-link]') || {}).value || '';
    if (inp && inp.value.trim()) songs.push({ s: inp.value.trim(), link });
  });
  modal('Playlist del evento', songs.length ? '<ol style="padding-left:20px">' + songs.map(x => `<li style="margin:6px 0">${esc(x.s)} ${linkChip(x.link)}</li>`).join('') + '</ol>' : '<p>No hay canciones indicadas todavía.</p>');
}

/* archivos */
// Los archivos subidos se guardan en IndexedDB del navegador (gran capacidad), para que
// NO desaparezcan al recargar (la BBDD de la demo es demasiado grande para localStorage).
const fileIDB = {
  _p: null,
  open() { if (this._p) return this._p; this._p = new Promise((res, rej) => { try { const r = indexedDB.open('conectaso_files', 1); r.onupgradeneeded = () => { r.result.createObjectStore('files', { keyPath: 'key' }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }); return this._p; },
  async put(evId, f) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put({ key: evId + '_' + f.id, evId: +evId, file: f }); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
  async list(evId) { const db = await this.open(); return new Promise((res) => { const out = []; const tx = db.transaction('files', 'readonly'); const cur = tx.objectStore('files').openCursor(); cur.onsuccess = e => { const c = e.target.result; if (c) { if (c.value.evId == evId) out.push(c.value.file); c.continue(); } else res(out.sort((a, b) => (a.date || '').localeCompare(b.date || ''))); }; tx.onerror = () => res(out); }); },
  async del(evId, fid) { const db = await this.open(); return new Promise((res) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').delete(evId + '_' + fid); tx.oncomplete = () => res(); tx.onerror = () => res(); }); },
  // Clave/valor genérico (para planos de montaje: imagen y marcadores) — no interfiere con los archivos de eventos
  async putRaw(key, val) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put({ key, raw: val }); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
  async getRaw(key) { const db = await this.open(); return new Promise((res) => { const tx = db.transaction('files', 'readonly'); const r = tx.objectStore('files').get(key); r.onsuccess = () => res(r.result ? r.result.raw : null); r.onerror = () => res(null); }); },
  async delRaw(key) { const db = await this.open(); return new Promise((res) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').delete(key); tx.oncomplete = () => res(); tx.onerror = () => res(); }); },
};
CS.fileIDB = fileIDB; // compartir el almacén con app-admin (planos de montaje)
async function loadFiles(ev) {
  const box = el('filesBox'); if (!box) return;
  // política: los archivos se eliminan 1 año después de la fecha de la boda (liberar espacio)
  if (ev.fecha) {
    const limite = new Date(ev.fecha); limite.setFullYear(limite.getFullYear() + 1);
    if (new Date() > limite) {
      box.innerHTML = `<div class="alert alert--warn"><b>Archivos eliminados.</b> Ha pasado más de 1 año desde la fecha de la boda (${slash(ev.fecha)}), por lo que los archivos adjuntos se han eliminado automáticamente para liberar espacio.</div>`;
      return;
    }
  }
  try {
    const r = await api('files/list/' + ev.id);
    const canUpload = isAdmin() || S.user.role === 'dj' || (S.user.role === 'user' && ev.editUser);
    const isAudio = f => /^audio\//.test(f.mime || '') || /\.(mp3|wav|ogg|m4a|aac)$/i.test(f.name || '');
    const fsize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round((n || 0) / 1024)) + ' KB';
    const cards = (r.files || []).map(f => `<div class="file-card">
        <div class="file-card__main">
          <div class="file-card__ic">${isAudio(f) ? '🎵' : '📄'}</div>
          <div class="file-card__meta"><div class="file-card__name">${esc(f.name)}${f.momento ? ` <span class="file-moment">${esc(f.momento)}</span>` : ''}</div>
            <div class="file-card__sub">${fsize(f.size)}${f.created_at ? ' · ' + slash(String(f.created_at).slice(0, 10)) : ''}</div></div>
          <div class="file-card__act">
            <a class="btn btn--sm" href="/api/files/${f.id}" target="_blank" download="${esc(f.name)}">Descargar</a>
            ${isAdmin() ? `<button class="btn btn--icon" data-del-file="${f.id}" title="Eliminar">🗑</button>` : ''}
          </div></div>
        ${isAudio(f) ? `<audio controls preload="none" src="/api/files/${f.id}" style="width:100%;margin-top:8px"></audio>` : ''}
      </div>`).join('');
    box.innerHTML = `<div class="panel__intro"><p class="hint">${tt(
      'Sube archivos para la boda (partituras, voz en off, anuncios, documentos…). Se guardan en el servidor y cualquier usuario del evento podrá descargarlos. Los MP3 se pueden escuchar aquí mismo.',
      'Puja arxius per a la boda (partitures, veu en off, anuncis, documents…). Es desen al servidor i qualsevol usuari de l\'esdeveniment els podrà descarregar. Els MP3 es poden escoltar aquí mateix.',
      'Upload files for the wedding (scores, voice-overs, announcements, documents…). They are stored on the server and anyone in the event can download them. MP3s can be played right here.',
      'Téléversez des fichiers pour le mariage (partitions, voix off, annonces, documents…). Ils sont stockés sur le serveur et toute personne de l\'événement peut les télécharger. Les MP3 se lisent ici même.')}</p></div>
      ${cards ? `<div class="file-list">${cards}</div>` : '<div class="empty">Sin archivos todavía.</div>'}
      ${canUpload ? `<div class="file-upload">
        <div class="form-grid" style="align-items:end">
          ${fg(tt('Archivo', 'Arxiu', 'File', 'Fichier'), `<input type="file" id="fileInput" class="control"><p class="hint">${tt('Máx. 60 MB por archivo.', 'Màx. 60 MB per arxiu.', 'Max 60 MB per file.', 'Max 60 Mo par fichier.')}</p>`)}
          ${fg(tt('¿Para qué momento?', 'Per a quin moment?', 'For which moment?', 'Pour quel moment ?'), `<input id="fileMomento" class="control" type="text" list="fileMomentos" autocomplete="off" placeholder="${tt('Escribe el momento (opcional)', 'Escriu el moment (opcional)', 'Type the moment (optional)', 'Écrivez le moment (facultatif)')}"><datalist id="fileMomentos">${FILE_MOMENTS.filter(m => m[0]).map(m => `<option value="${esc(tt(m[1][0], m[1][1], m[1][2], m[1][3]))}"></option>`).join('')}</datalist>`)}
        </div>
        <button type="button" class="btn btn--primary btn--sm" id="fileBtn">${tt('Subir archivo', 'Pujar arxiu', 'Upload file', 'Téléverser')}</button>
      </div>` : ''}`;
    if (canUpload) {
      el('fileBtn').onclick = async () => {
        const fi = el('fileInput'); const file = fi.files && fi.files[0];
        if (!file) { toast('Elige un archivo', 'err'); return; }
        if (file.size > 60 * 1048576) { toast('El archivo supera el límite de 60 MB', 'err'); return; }
        const fd = new FormData(); fd.append('file', file, file.name);
        const mSel = el('fileMomento'); if (mSel && mSel.value) fd.append('momento', mSel.value);
        const btn = el('fileBtn'); btn.disabled = true; btn.textContent = 'Subiendo…';
        try { await api('files/events/' + ev.id, { method: 'POST', form: fd }); toast('Archivo subido', 'ok'); loadFiles(ev); }
        catch (err) { toast(err.message || 'No se pudo subir', 'err'); btn.disabled = false; btn.textContent = 'Subir archivo'; }
      };
    }
    $$('[data-del-file]', box).forEach(b => b.onclick = () => modal('Borrar archivo', '¿Eliminar este archivo?', { okText: 'Eliminar', danger: true, onOk: async () => { try { await api('files/' + b.dataset.delFile, { method: 'DELETE' }); } catch (e) {} loadFiles(ev); } }));
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/* =========================================================================
   PDF — resumen musical (mismo formato que la intranet original)
   ========================================================================= */
on(/^#\/eventos\/(\d+)\/pdf$/, async m => {
  loading(['Eventos', 'PDF']);
  const { event: ev } = await api('events/' + m[1]);
  const NI = '<b>No indicado</b>', val = v => v ? `<b>${esc(v)}</b>` : NI;
  const label = (k, def) => momentTitle(ev, k, (ev.labels && ev.labels[k]) || def);
  const opts = (ev.optionals || []).slice().sort((a, b) => (+a.order || 99) - (+b.order || 99));
  const area = key => {
    const fixed = (key === 'disco' ? DISCO_MOMENTS : musicAreasFor(ev).find(a => a.key === key).moments)
      .map((mm, i) => { const k = key + '_' + mm[0], mu = (ev.music || {})[k] || {}; return { on: mu.on, order: +mu.order || (i + 1), html: `<div><span class="m-ic">${momentIcon(k)}</span> ${esc(label(k, mm[1]))} : ${val(mu.song)} ${linkChip(mu.link)}</div>` }; })
      .filter(x => !x.on);
    const extra = opts.filter(o => (o.sec || 'C') === (SEC_OF[key] || (key === 'disco' ? 'D' : ''))).map(o => ({ order: +o.order || 60, html: `<div>• ${esc(o.title)} : ${val(o.value)} ${linkChip(o.link)}</div>` }));
    return fixed.concat(extra).sort((a, b) => a.order - b.order).map(x => x.html).join('');
  };
  const ent = opts.filter(o => (o.sec || 'C') === 'E').map(o => `<div>• Entrega para: ${esc(o.title)} : ${val(o.value)} ${linkChip(o.link)}</div>`).join('');
  const extrasList = EXTRAS_CLIENTE.filter(x => ev.extras && ev.extras[x[0]]).map(x => `<div>• ${esc(x[1])}</div>`).join('');
  const sp = ev.spouses || [{}, {}];
  const head = `<div class="pdf-head"><img src="assets/brand/logo-principal-azul.svg" alt="Conecta So"><div style="text-align:right;color:#777;font-size:10px">Configuración musical de boda<br>${esc(ev.conyuges)}<br>${dmy(ev.fecha)}</div></div>`;
  shell(`${pageHead('Resumen musical', S.user.role === 'user' ? esc(ev.conyuges || '') : 'Boda #' + ev.id)}
    <div class="pdf-toolbar"><button class="btn btn--primary" onclick="window.print()">Imprimir / Guardar PDF</button></div>
    <div class="pdf-page">${head}<h2>Resumen de configuración musical de boda</h2>
      ${ev.obsPriv && String(ev.obsPriv).trim() ? '<div class="pdf-notice">⚠ Este evento tiene <b>observaciones ocultas</b>. Entra en la intranet para leerlas (no se muestran en este PDF).</div>' : ''}
      <h3>1. Datos previos</h3><div class="pdf-grid">
        <div>Fecha de boda : ${val(dmy(ev.fecha))}</div>${isAdmin() ? `<div>Tipo de boda : ${val(ev.tipo)}</div>` : ''}
        <div>Hora de la ceremonia : ${val(ev.hora)}</div><div>Lugar de la ceremonia : ${val(ev.lugarCeremonia)}</div>
        <div>Hora inicio aperitivo : ${val(ev.celebrationHour)}</div><div>Lugar de la celebración : ${val(CS.locName(ev))}</div>
        <div>DJ asignado : ${val(djOf(ev))}</div><div>Nº de invitados : ${val(ev.guests)}</div></div>
      <h3 style="font-size:11px">Cónyuges:</h3><div class="pdf-grid">${sp.map(s => `<div><b>${esc(s.name || 'No indicado')}</b>${s.mobile ? ` (${esc(s.mobile)})` : ''}</div>`).join('')}</div>
      <h3>2. Ceremonia</h3>${area('ceremony')}
      <h3>3. Aperitivo</h3>${area('aperitif')}
      <h3>4. Banquete</h3>${area('banquet')}
      <h3>5. Entregas</h3>${ent}
      <h3>6. Fiesta</h3>${area('disco')}<div>Enlace a playlist : ${val((ev.disco || {}).playlist)}</div>
      <h3>7. Extras</h3>${extrasList || '<div>No se ha marcado ninguno.</div>'}
    </div>`, ['Eventos', '#' + ev.id, 'PDF']);
});

on(/^#\/eventos\/(\d+)\/ruta-doc$/, async m => {
  loading(['Eventos', 'Hoja de ruta']);
  const { event: ev } = await api('events/' + m[1]);
  const val = v => v ? esc(v) : '—';
  const loc = (S.meta.locations || []).find(l => String(l.id) === String(ev.lugar));
  const travel = loc ? loc.travelMin : (ev.lugarOtro ? ev.otroTravelMin : null);
  const travelKm = loc ? loc.travelKm : (ev.lugarOtro ? ev.otroTravelKm : null);
  const destName = loc ? loc.name : (ev.lugarOtro || '—');
  const mt = montajeInfo(ev);
  const target = _hm2min(ev.ceremoniaFuera ? ev.celebrationHour : ev.hora);
  const fmtTravel = travel != null ? (travel + ' min' + (travelKm ? ' · ' + travelKm + ' km' : '')) : '—';
  const fechaLarga = f => { if (!f) return '—'; const d = new Date(f + 'T00:00:00'); const dd = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']; const mm = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']; return `${dd[d.getDay()]}, ${d.getDate()} de ${mm[d.getMonth()]} de ${d.getFullYear()}`; };
  let tlHtml = '<p style="color:#b4aeb9">Faltan datos para calcular los tiempos (hora y/o desplazamiento).</p>', salidaTxt = '';
  if (target != null && travel != null) {
    const listo = target, inicioMontaje = target - mt.min, llegada = inicioMontaje, salida = llegada - travel;
    const hhmm = x => _min2hm(x) + (x < 0 ? ' (día anterior)' : '');
    const t = (time, lbl, sub) => `<div class="t"><span class="dot"></span><div class="hh">${time}</div><div><div class="lbl">${lbl}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div></div>`;
    salidaTxt = hhmm(salida);
    tlHtml = t(hhmm(salida), 'Salida', 'Martorelles · ' + fmtTravel)
      + t(hhmm(llegada), 'Montaje', esc(mt.regla) + ' · ' + mt.min + ' min')
      + t(hhmm(listo), 'Todo listo', 'A la hora de ' + (ev.ceremoniaFuera ? 'inicio' : 'la ceremonia'))
      + (ev.ceremoniaFuera ? '' : t(_min2hm(_hm2min(ev.hora)), 'Ceremonia', 'En la finca'))
      + (() => { const ap = ev.ceremoniaFuera ? _hm2min(ev.celebrationHour) : (_hm2min(ev.hora) != null ? _hm2min(ev.hora) + 60 : null); return ap != null ? t(_min2hm(ap), 'Aperitivo', ev.ceremoniaFuera ? '' : 'Ceremonia + 1 h') : ''; })();
  }
  // plano(s) de montaje por zonas (si está disponible el módulo). Protegido: si falla, se omite.
  let planoZones = [];
  try { planoZones = window.planoZonesForEvent ? await window.planoZonesForEvent(ev) : []; } catch (e) { planoZones = []; }
  const planoHtml = planoZones.length === 1 ? planoZones[0].html : '';
  const escaleta = () => {
    const secs = musicAreasFor(ev).filter(a => !(a.key === 'ceremony' && ev.ceremoniaFuera))
      .map(a => ({ title: a.title, moments: a.moments.map(mm => [a.key + '_' + mm[0], mm[1]]) }));
    secs.push({ title: 'Fiesta', moments: DISCO_MOMENTS.map(mm => ['disco_' + mm[0], mm[1]]) });
    const pl = (ev.disco || {}).playlist;
    let html = '', n = 0;
    secs.forEach(s => {
      const rows = s.moments.map(([k, def]) => {
        const mu = (ev.music || {})[k] || {};
        if (mu.on || (!mu.song && !mu.link)) return '';
        const chip = mu.link ? '<span class="sp">Spotify</span>' : '<span class="warn">Sin enlace</span>';
        return `<tr><td class="mic"><span class="box"></span></td><td class="mom">${esc(momentTitle(ev, k, def))}</td><td>${esc(mu.song || '')}</td><td class="notes">${chip}</td></tr>`;
      }).filter(Boolean).join('');
      if (!rows) return; n++;
      html += `<tr class="sec"><td></td><td colspan="3" class="sname">${n} · ${esc(s.title)}</td></tr>` + rows;
    });
    if (pl) html += `<tr class="sec"><td></td><td colspan="3" class="sname">Playlist general</td></tr><tr><td class="mic"><span class="box"></span></td><td class="mom">Ambiente / fiesta</td><td>${esc(pl)}</td><td class="notes"><span class="sp">Spotify</span></td></tr>`;
    return html;
  };
  const escRows = escaleta();
  const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(destName + ' Barcelona');
  // aviso (no el contenido) si hay observaciones ocultas
  const obsAviso = (ev.obsPriv && String(ev.obsPriv).trim()) ? '<div class="note-tip" style="margin-top:12px">⚠ Este evento tiene <b>observaciones ocultas</b>. Entra en la intranet para leerlas (no se muestran aquí).</div>' : '';
  // Servicios con su técnico responsable (para la hoja de ruta).
  const svcList = (ev.services || []).filter(s => s.servicio).map(s => ({
    nm: extraName(s.servicio),
    resp: [s.resp, s.resp2].filter(Boolean).map(r => userName(r)).join(' · ') || 'Sin asignar',
  }));
  const svcSlide = svcList.length ? `<section class="slide dark page slide--auto" style="min-height:auto">
      <h2>Servicios y técnicos</h2>
      <p style="color:#b4aeb9;margin-bottom:18px">Quién se encarga de cada servicio en este evento.</p>
      <div class="svc-resp-grid">${svcList.map(s => `<div class="card"><h3>${esc(s.nm)} <span class="ic">🔧</span></h3><div class="v" style="font-size:19px">${esc(s.resp)}</div></div>`).join('')}</div>
      <img src="/assets/brand/logo-reducido-blanco.svg" class="wm" alt=""><div class="pg">${pg()}</div>
    </section>` : '';
  let pageNo = 1;
  const pg = () => ('0' + (++pageNo)).slice(-2);
  shell(`${pageHead('Hoja de ruta', 'Boda #' + ev.id)}
    <div class="pdf-toolbar"><a class="btn" href="#/eventos/${ev.id}">← Volver</a> <button class="btn btn--primary" onclick="window.print()">Imprimir / Guardar PDF</button></div>
    <div class="ruta-deck">

      <section class="slide dark cover">
        <span class="stripe"></span>
        <img src="/assets/brand/logo-principal-blanco.svg" class="logo" alt="Conecta So">
        <div class="kick">Hoja de ruta · equipo</div>
        <h1>${esc(ev.conyuges || ('Boda #' + ev.id))}</h1>
        <div class="meta"><b>Boda #${ev.id}</b> · ${val(ev.tipo)}<br>${esc(fechaLarga(ev.fecha))} · <b>${esc(destName)}</b></div>
        <img src="/assets/brand/el-vinilo.svg" class="vinilo" alt="">
        <div class="pg">Conecta So</div>
      </section>

      <section class="slide dark page">
        <h2 style="margin-bottom:14px">Resumen del evento</h2>
        <div class="grid3" style="margin-bottom:14px">
          <div class="card"><h3>Localización <span class="ic">📍</span></h3>
            <div class="row"><div class="k">Finca</div><div class="v">${val(destName)}</div></div>
            <div class="row"><div class="k">Hora ceremonia</div><div class="v sm">${val(ev.hora)}</div></div>
          </div>
          <div class="card"><h3>Equipo <span class="ic">🎧</span></h3>
            <div class="row"><div class="k">DJ / Técnico</div><div class="v">${val(djOf(ev))}</div></div>
            <div class="row"><div class="k">Tipo de servicio</div><div class="v sm">${val(ev.tipo)}</div></div>
          </div>
          <div class="card"><h3>Contacto <span class="ic">📞</span></h3>
            <div class="row"><div class="k">Email</div><div class="v sm">info@conectaso.es</div></div>
            <div class="row"><div class="k">Web</div><div class="v sm">conectaso.es</div></div>
          </div>
        </div>
        <div class="resumen-2col">
          <div class="card"><h3>Timing del día <span class="ic">⏱️</span></h3><div class="tl tl--compact">${tlHtml}</div></div>
          <div class="card"><h3>Normativa interna <span class="ic">📋</span></h3>
            <div class="norm-grid">
              <div class="nvc"><b>Uniformidad</b><span>Ropa negra + camiseta/sudadera Conecta So, calzado cerrado. Nada de corto, chándal ni roturas.</span></div>
              <div class="nvc"><b>Montaje y seguridad</b><span>Todo montado y recogido antes de la llegada de invitados. Cableado fijado y tapado. Altura: solo autorizados.</span></div>
              <div class="nvc"><b>Conducta</b><span>No compartir fotos ni datos. Trato discreto y respetuoso. Sin alcohol ni tabaco en zonas visibles.</span></div>
              <div class="nvc"><b>Material y cierre</b><span>Orden; cajas vacías ocultas. Averías: marcar "NO FUNCIONA". Revisar restos de cinta al cerrar.</span></div>
            </div>
            ${obsAviso}
          </div>
        </div>
        <img src="/assets/brand/logo-reducido-blanco.svg" class="wm" alt=""><div class="pg">${pg()}</div>
      </section>

      <section class="slide dark page">
        <h2>Ubicación y acceso</h2>
        <div class="grid2" style="height:460px">
          <div>
            <div class="card" style="margin-bottom:20px"><h3>Dirección del evento <span class="ic">📍</span></h3>
              <div class="v" style="font-size:20px;line-height:1.3">${val(destName)}</div>
              <div style="color:#b4aeb9;margin-top:6px">${esc(ev.lugarCeremonia ? ('Ceremonia: ' + ev.lugarCeremonia) : 'Zona Barcelona')}${travelKm ? ' · a ' + travelKm + ' km (' + travel + ' min) desde Martorelles' : ''}</div>
              <a class="accent" style="display:inline-block;margin-top:12px;font-family:var(--disp);font-size:14px;text-decoration:none" href="${mapsUrl}" target="_blank" rel="noopener">▸ Ver ruta en Google Maps</a>
            </div>
            <div class="card"><h3>Desplazamiento <span class="ic">🚐</span></h3>
              <div class="row"><div class="k">Tiempo estimado</div><div class="v">${travel != null ? travel + ' min' : '—'}</div></div>
              <div class="row"><div class="k">Distancia</div><div class="v sm">${travelKm ? travelKm + ' km desde base (Martorelles)' : '—'}</div></div>
              ${salidaTxt ? `<div class="note-tip">Salida recomendada con margen para montaje a las <b>${salidaTxt}</b>.</div>` : ''}
              ${mt.note ? `<div class="warn-tip">${esc(mt.note)}</div>` : ''}
            </div>
          </div>
          ${planoHtml
            ? `<div class="card" style="display:flex;flex-direction:column"><h3>Plano de montaje <span class="ic">🗺️</span></h3><div class="deck-plano">${planoHtml}</div></div>`
            : `<div class="mapbox"><div class="big">Vista satélite de la finca</div><div style="max-width:30ch">Sube la captura aérea de la finca en el plano de montaje y aparecerá aquí junto a los puntos de descarga y parking.</div></div>`}
        </div>
        <img src="/assets/brand/logo-reducido-blanco.svg" class="wm" alt=""><div class="pg">${pg()}</div>
      </section>

      ${planoZones.length > 1 ? `<section class="slide dark page">
        <h2>Planos de montaje</h2>
        <div class="plano-zonas-grid">
          ${planoZones.map(z => `<div class="card"><h3>${esc(z.label)} <span class="ic">🗺️</span></h3><div class="deck-plano">${z.html}</div></div>`).join('')}
        </div>
        <img src="/assets/brand/logo-reducido-blanco.svg" class="wm" alt=""><div class="pg">${pg()}</div>
      </section>` : ''}

      ${svcSlide}

      ${escRows ? `<section class="slide light slide--auto" style="padding:48px 64px 40px">
        <h2 style="font-size:40px;margin-bottom:14px">Escaleta musical</h2>
        <table class="esc">
          <thead><tr><th class="mic">Mic</th><th>Momento</th><th>Canción</th><th class="notes">Notas</th></tr></thead>
          <tbody>${escRows}</tbody>
        </table>
        <div class="footnote">Nota: todos los momentos están sujetos a cambios según el desarrollo del evento.</div>
      </section>` : ''}

    </div>`, ['Eventos', '#' + ev.id, 'Hoja de ruta']);
  // Escala las slides fijas (1280×720) para que quepan; la escaleta musical (.slide--auto) NO se
  // escala con zoom (iOS la renderiza mal): es responsive por sí misma y refluye en móvil.
  const fitDeck = () => { const deck = document.querySelector('.ruta-deck'); if (!deck) return; const avail = deck.clientWidth || (deck.parentElement ? deck.parentElement.clientWidth : 1280); const s = Math.min(1, avail / 1280); deck.querySelectorAll('.slide:not(.slide--auto)').forEach(sl => { sl.style.zoom = s; }); };
  setTimeout(fitDeck, 30);
  if (!window.__rutaFitBound) { window.__rutaFitBound = true; window.addEventListener('resize', () => { clearTimeout(window.__rutaFitT); window.__rutaFitT = setTimeout(fitDeck, 120); }); }
});

CS.momentHelpers = { MUSIC_AREAS, DISCO_MOMENTS, EXTRAS_CLIENTE, SEC_OF, fg, inp, sel, ta, collectForm, isAdmin, enhanceSearchSelects };
})();
