'use strict';
/**
 * Lee el texto de un ticket (sacado con Tesseract) y propone los datos:
 * tienda, fecha, total, descuento, IVA, tipo (gasto / devolución) y categoría.
 * Es una aproximación: la persona revisa antes de guardar.
 */
const CATS = ['Materiales', 'Herramientas', 'Mano de obra', 'Electricidad', 'Fontanería', 'Pintura', 'Suelos y azulejos',
  'Carpintería', 'Cocina', 'Baño', 'Electrodomésticos', 'Mobiliario', 'Iluminación', 'Transporte y escombros', 'Licencias y tasas', 'Otros'];

const TIENDAS = [
  ['leroy merlin', 'Leroy Merlin', 'Materiales'], ['leroy', 'Leroy Merlin', 'Materiales'], ['bauhaus', 'Bauhaus', 'Materiales'],
  ['bricomart', 'Bricomart', 'Materiales'], ['brico depot', 'Brico Depôt', 'Materiales'], ['bricodepot', 'Brico Depôt', 'Materiales'],
  ['obramat', 'Obramat', 'Materiales'], ['bricor', 'Bricor', 'Materiales'], ['aki', 'AKI', 'Materiales'], ['ikea', 'IKEA', 'Mobiliario'],
  ['wurth', 'Würth', 'Herramientas'], ['würth', 'Würth', 'Herramientas'], ['saltoki', 'Saltoki', 'Fontanería'], ['fontgas', 'Fontgas', 'Fontanería'],
  ['salvador escoda', 'Salvador Escoda', 'Fontanería'], ['bdb', 'BdB', 'Materiales'], ['cofac', 'Cofac', 'Materiales'],
  ['media markt', 'MediaMarkt', 'Electrodomésticos'], ['mediamarkt', 'MediaMarkt', 'Electrodomésticos'], ['el corte ingles', 'El Corte Inglés', 'Otros'],
  ['el corte inglés', 'El Corte Inglés', 'Otros'], ['amazon', 'Amazon', 'Otros'], ['action', 'Action', 'Otros'], ['norauto', 'Norauto', 'Otros'],
  ['porcelanosa', 'Porcelanosa', 'Suelos y azulejos'], ['tau ceramica', 'Tau Cerámica', 'Suelos y azulejos'], ['roca', 'Roca', 'Baño'],
  ['jysk', 'JYSK', 'Mobiliario'], ['conforama', 'Conforama', 'Mobiliario'], ['maisons du monde', 'Maisons du Monde', 'Mobiliario'],
  ['bruguer', 'Bruguer', 'Pintura'], ['titan', 'Titan', 'Pintura'], ['valentine', 'Valentine', 'Pintura'], ['pinturas', null, 'Pintura'],
  ['ferreteria', null, 'Herramientas'], ['ferretería', null, 'Herramientas'], ['electricidad', null, 'Electricidad'], ['fontaneria', null, 'Fontanería']
];

const PALABRAS = {
  'Pintura': ['pintura', 'rodillo', 'brocha', 'esmalte', 'imprimacion', 'imprimación', 'plastica', 'plástica', 'barniz', 'cinta carrocero', 'carrocero', 'masilla', 'aguaplast', 'disolvente', 'titanlux', 'bruguer', 'cubeta', 'lija'],
  'Herramientas': ['taladro', 'broca', 'destornillador', 'martillo', 'sierra', 'nivel', 'alicate', 'llave', 'atornillador', 'radial', 'disco', 'metro', 'cutter', 'makita', 'bosch', 'dewalt', 'stanley', 'black', 'ryobi', 'paleta', 'llana', 'escalera', 'guantes', 'herramienta'],
  'Electricidad': ['cable', 'enchufe', 'interruptor', 'diferencial', 'magnetotermico', 'magnetotérmico', 'regleta', 'base', 'caja empotrar', 'mecanismo', 'tubo corrugado', 'corrugado', 'legrand', 'simon', 'schneider', 'conmutador', 'manguera'],
  'Fontanería': ['grifo', 'latiguillo', 'sifon', 'sifón', 'multicapa', 'codo', 'teflon', 'teflón', 'valvula', 'válvula', 'llave paso', 'desague', 'desagüe', 'pvc', 'termo', 'calentador', 'tuberia', 'tubería', 'racor', 'manguito'],
  'Suelos y azulejos': ['azulejo', 'porcelanico', 'porcelánico', 'ceramica', 'cerámica', 'cemento cola', 'adhesivo cementoso', 'junta', 'rodapie', 'rodapié', 'tarima', 'laminado', 'parquet', 'vinilico', 'vinílico', 'gres', 'baldosa', 'crucetas', 'nivelador'],
  'Carpintería': ['puerta', 'madera', 'bisagra', 'tablero', 'manilla', 'pomo', 'marco', 'listón', 'liston', 'aglomerado', 'mdf', 'contrachapado', 'tapajunta', 'armario'],
  'Iluminación': ['bombilla', 'led', 'foco', 'lampara', 'lámpara', 'plafon', 'plafón', 'aplique', 'downlight', 'tira led', 'luminaria'],
  'Cocina': ['cocina', 'encimera', 'fregadero', 'campana', 'mueble cocina', 'zocalo', 'zócalo'],
  'Baño': ['inodoro', 'lavabo', 'mampara', 'plato ducha', 'ducha', 'bañera', 'banera', 'mueble baño', 'espejo', 'columna ducha', 'wc'],
  'Electrodomésticos': ['lavadora', 'frigorifico', 'frigorífico', 'nevera', 'horno', 'vitroceramica', 'vitrocerámica', 'induccion', 'inducción', 'lavavajillas', 'microondas', 'secadora'],
  'Mobiliario': ['sofa', 'sofá', 'mesa', 'silla', 'estanteria', 'estantería', 'colchon', 'colchón', 'cama', 'comoda', 'cómoda'],
  'Materiales': ['yeso', 'cemento', 'mortero', 'saco', 'pladur', 'placa', 'ladrillo', 'arena', 'silicona', 'tornillo', 'taco', 'perfil', 'montante', 'canal', 'aislante', 'lana de roca', 'escayola', 'hormigon', 'hormigón', 'impermeabilizante', 'espuma'],
  'Transporte y escombros': ['portes', 'transporte', 'contenedor', 'escombro', 'envio', 'envío', 'entrega a domicilio', 'reparto', 'gestion residuos', 'residuos'],
  'Licencias y tasas': ['ayuntamiento', 'ajuntament', 'tasa', 'licencia', 'llicencia', 'icio', 'comunicacion previa'],
  'Mano de obra': ['mano de obra', 'horas', 'instalacion', 'instalación', 'montaje', 'servicio', 'operario', 'presupuesto']
};

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Importes como 1.234,56 · 12,50 · 12.50 · -3,00 · 3,00-
const AMT = /(-?)\s?(\d{1,3}(?:[.\s]\d{3})*|\d+)[,.](\d{2})(?!\d)\s?(-?)/g;
function amounts(line) {
  const out = []; let m; AMT.lastIndex = 0;
  while ((m = AMT.exec(line))) {
    const v = parseFloat(m[2].replace(/[.\s]/g, '') + '.' + m[3]);
    if (!isFinite(v)) continue;
    out.push((m[1] === '-' || m[4] === '-') ? -v : v);
  }
  return out;
}

function fecha(text) {
  const re = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/g; let m;
  const now = new Date();
  while ((m = re.exec(text))) {
    let d = +m[1], mo = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < 2015 || y > now.getFullYear() + 1) continue;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

function leerTicket(text) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const all = norm(raw);
  const res = { comercio: '', fecha: fecha(raw), concepto: '', categoria: 'Otros', tipo: 'gasto', importe: 0, descuento: 0, iva: 0, lineas: [], confianza: 'baja', aviso: null };

  // Tienda
  let catTienda = null;
  for (const [k, nombre, cat] of TIENDAS) {
    const re = new RegExp('(^|[^a-z])' + norm(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)');
    if (re.test(all)) { if (nombre && !res.comercio) res.comercio = nombre; if (!catTienda) catTienda = cat; if (nombre) break; }
  }
  if (!res.comercio) {
    const cand = lines.slice(0, 6).find(l => /[a-záéíóúñ]{3,}/i.test(l) && (l.match(/[a-záéíóúñ]/gi) || []).length >= 4 && !/ticket|factura|fecha|nif|cif|tel|c\/|calle|www|http/i.test(l));
    if (cand) res.comercio = cand.replace(/[^\p{L}\p{N} &.'-]/gu, '').trim().slice(0, 40);
  }

  // Total
  let total = null, fuerte = false;
  const prioridad = [/total\s*(a\s*)?pagar/, /importe\s*total/, /total\s*(eur|€|euros)/, /total\s*factura/, /^total\b/, /\btotal\b/, /a\s*pagar/, /importe/];
  for (const re of prioridad) {
    for (let i = 0; i < lines.length; i++) {
      const n = norm(lines[i]);
      if (!re.test(n) || /sub\s*total|total\s*iva|base|cuota|articulos|unidades|uds|ahorro|descuento/.test(n)) continue;
      let a = amounts(lines[i]);
      if (!a.length && lines[i + 1]) a = amounts(lines[i + 1]);
      if (a.length) { total = a[a.length - 1]; fuerte = true; break; }
    }
    if (total != null) break;
  }
  const todos = lines.flatMap(amounts).filter(v => Math.abs(v) < 100000);
  if (total == null && todos.length) total = todos.reduce((a, b) => Math.abs(b) > Math.abs(a) ? b : a, 0);

  // Devolución
  if (/devolucion|abono|rectificativa|reembolso/.test(all) || (total != null && total < 0)) res.tipo = 'devolucion';
  res.importe = total != null ? Math.round(Math.abs(total) * 100) / 100 : 0;

  // Descuentos
  let desc = 0;
  for (const l of lines) {
    const n = norm(l);
    if (/dto|descuento|desc\.|ahorro|promo|oferta|cupon|rebaja|bonificacion/.test(n)) {
      const a = amounts(l);
      if (!a.length) continue;
      if (/total\s*ahorro|ahorro\s*total|has ahorrado|total\s*descuento/.test(n)) { desc = Math.abs(a[a.length - 1]); break; }
      const neg = a.filter(v => v < 0);
      desc += Math.abs(neg.length ? neg[neg.length - 1] : a[a.length - 1]);
    }
  }
  if (desc > 0 && desc < res.importe * 3) res.descuento = Math.round(desc * 100) / 100;

  // IVA: cuota (importe menor que el total en la línea del IVA)
  for (let i = 0; i < lines.length; i++) {
    const n = norm(lines[i]);
    if (!/(^|[^a-z])i\.?v\.?a\.?([^a-z]|$)|cuota|impuestos/.test(n)) continue;
    let a = amounts(lines[i]).map(Math.abs).filter(v => v > 0 && v < res.importe * 0.5 && v !== 21 && v !== 10 && v !== 4);
    if (!a.length && lines[i + 1]) a = amounts(lines[i + 1]).map(Math.abs).filter(v => v > 0 && v < res.importe * 0.5);
    if (a.length) { res.iva = a[a.length - 1]; break; }
  }
  if (!res.iva && res.importe && /iva\s*incl|21\s*%/.test(all)) res.iva = Math.round(res.importe * 21 / 121 * 100) / 100;

  // Artículos: líneas con texto + importe, antes del total
  for (const l of lines) {
    const n = norm(l);
    if (/dto|descuento|ahorro|promo|cupon|total|iva|base|cuota|cambio|efectivo|tarjeta|visa|mastercard|entregado|pagar|nif|cif|fecha|hora|ticket|factura|tel|operacion|autoriz|redondeo/.test(n)) continue;
    const a = amounts(l); if (!a.length) continue;
    const d = l.replace(AMT, ' ').replace(/\b\d+([.,]\d+)?\s*(x|uds?|un|ud)\b/gi, ' ').replace(/[^\p{L}\p{N} ./%-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if ((d.match(/\p{L}/gu) || []).length < 3) continue;
    res.lineas.push({ d: d.slice(0, 60), i: Math.abs(a[a.length - 1]) });
    if (res.lineas.length >= 8) break;
  }

  // Categoría por palabras clave (artículos pesan más), luego por tienda
  const puntos = {};
  const textoArt = norm(res.lineas.map(x => x.d).join(' '));
  for (const [cat, ws] of Object.entries(PALABRAS)) {
    for (const w of ws) {
      const re = new RegExp('(^|[^a-z])' + norm(w) + '([^a-z]|$)');
      if (re.test(textoArt)) puntos[cat] = (puntos[cat] || 0) + 2;
      else if (re.test(all)) puntos[cat] = (puntos[cat] || 0) + 1;
    }
  }
  const mejor = Object.entries(puntos).sort((a, b) => b[1] - a[1])[0];
  res.categoria = mejor ? mejor[0] : (catTienda || 'Otros');

  // Concepto: "Categoría – artículo, artículo"
  const arts = res.lineas.slice(0, 2).map(x => x.d.toLowerCase().replace(/^\d+\s*/, '')).filter(Boolean);
  res.concepto = (res.categoria + (arts.length ? ' – ' + arts.join(', ') : (res.comercio ? ' – ' + res.comercio : ''))).slice(0, 120);

  // Confianza
  const ok = [fuerte, !!res.fecha, !!res.comercio].filter(Boolean).length;
  res.confianza = ok === 3 ? 'alta' : ok === 2 ? 'media' : 'baja';
  if (!lines.length || raw.replace(/\s/g, '').length < 20) { res.confianza = 'baja'; res.aviso = 'No se ve texto en la foto. Prueba con más luz y el ticket bien plano.'; }
  else if (!fuerte) res.aviso = 'No encuentro la palabra TOTAL: comprueba el importe.';
  return res;
}

module.exports = { leerTicket, CATS };
