// Lector de resultados de laboratorio. Trabaja sobre filas de texto (una fila de tabla por cadena).
// Formatos reconocidos: Centro Analítico Mariano Otero y Chopo.
// Es una traducción fiel de la implementación validada en Python y de la versión en Swift.

const VOCAB = ["A. Obscuro", "A. Claro", "Amarillo obscuro", "Amarillo claro", "Amarillo", "Ligeramente turbio",
  "Negativo", "Positivo", "Normal", "Ausentes", "Ausente", "Escasas", "Escasos", "Moderadas", "Moderados",
  "Abundantes", "Abundante", "Presentes", "Presente", "Trazas", "Claro", "Turbio", "Regulares", "Aumentadas",
  "Raras", "Pocas", "Numerosas"];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VOCAB_RE = VOCAB.map(esc).join("|");
const NUM = "\\d+(?:\\.\\d+)?";

const RE_A = new RegExp("^\\+?\\s*(\\S.*?)\\s+((?:[<>]\\s?)?" + NUM + "|" + VOCAB_RE + ")(\\s*\\*{1,2})?(?=\\s|$)(?:\\s+(.*))?$");
const RE_B = new RegExp("^([A-Za-zÁÉÍÓÚáéíóúÑñ]\\S*(?:\\s+\\S+)*?)\\s+(" + NUM + ")(?=\\s)\\s+(.+)$");
const RANGE_END = [
  ["range", new RegExp("(" + NUM + ")\\s*-\\s*(" + NUM + ")$")],
  ["cmp", new RegExp("(≤|≥|<=|>=|<|>)\\s*(" + NUM + ")$")],
  ["text", new RegExp("(" + VOCAB_RE + ")$")],
];
const RANGE_START = [
  ["range", new RegExp("^(" + NUM + ")\\s*-\\s*(" + NUM + ")\\s*(.*)$")],
  ["cmp", new RegExp("^(≤|≥|<=|>=|<|>)\\s*(" + NUM + ")\\s*(.*)$")],
];
const UNIT_NUMBER = /(?<![\w^/])\d+(?:\.\d+)?(?![\w^/])/;

export const stripAccents = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

export function norm(s) {
  return stripAccents(s).toUpperCase().replace("(%)", " ").replace(/[^A-Z0-9]+/g, " ").trim();
}

export function upperRatio(s) {
  const letters = [...s].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return 1;
  const up = letters.filter((c) => c !== c.toLowerCase() && c === c.toUpperCase()).length;
  return up / letters.length;
}

const UNIT_MAP = { "10^3/µL": "10³/µL", "miles/µL": "10³/µL", "10^6/µL": "10⁶/µL", "millones/µL": "10⁶/µL", "g/dL (%)": "g/dL", "g/dL(%)": "g/dL" };
const collapse = (s) => s.replace(/\s+/g, " ").trim();
// pdf.js entrega la letra griega mu (U+03BC); los PDF de referencia usan el signo de micro (U+00B5).
const UNIT_EXTRA = [[/^x?\s*10\^6\s*\/\s*[uµ]l$/i, "10⁶/µL"], [/^x?\s*10\^3\s*\/\s*[uµ]l$/i, "10³/µL"], [/^gr\/dl$/i, "g/dL"],
  [/^u\/ml\.?$/i, "U/mL"], [/^ui\/ml$/i, "UI/mL"], [/^uui\/ml$/i, "µUI/mL"], [/^mg\/dl$/i, "mg/dL"], [/^ng\/dl$/i, "ng/dL"], [/^mm\/hr$/i, "mm/h"]];
const normUnit = (u) => {
  const t = collapse(u.replace(/\u03BC/g, "\u00B5"));
  if (UNIT_MAP[t] !== undefined) return UNIT_MAP[t];
  for (const [rx, v] of UNIT_EXTRA) if (rx.test(t)) return v;
  return t;
};
function unitOK(u) {
  if (u.length > 14) return false;
  return !UNIT_NUMBER.test(u.replace("10^3", "").replace("10^6", ""));
}
function validName(n) {
  if (!n) return false;
  const last = n[n.length - 1];
  if (last === ":" || last === "<" || last === ">") return false;
  return [...n].filter((c) => /\p{L}/u.test(c)).length >= 3;
}

function parseA(s) {
  const m = RE_A.exec(s);
  if (!m) return null;
  const name = collapse(m[1]);
  if (!validName(name) || upperRatio(name) < 0.7) return null;
  const rest = (m[4] || "").trim();
  for (const [kind, rx] of RANGE_END) {
    const mm = rx.exec(rest);
    if (mm) {
      const unit = rest.slice(0, mm.index).trim();
      if (!unitOK(unit)) return null;
      return { name, valueText: m[2].trim(), flag: !!m[3], unit, kind, g1: mm[1] || "", g2: mm[2] || "" };
    }
  }
  return null;
}

function parseB(s) {
  const m = RE_B.exec(s);
  if (!m) return null;
  const name = collapse(m[1]);
  if (!validName(name)) return null;
  const rest = m[3].trim();
  for (const [kind, rx] of RANGE_START) {
    const mm = rx.exec(rest);
    if (mm) {
      const unit = (mm[3] || "").trim();
      if (!unitOK(unit)) return null;
      return { name, valueText: m[2], flag: false, unit, kind, g1: mm[1] || "", g2: mm[2] || "" };
    }
  }
  return null;
}

/** Estilo C: tres columnas separadas por espacios amplios: nombre | resultado (con unidad) | referencia (con unidad). */
const stem = (t) => t.trim().split(/\s+/)[0].toUpperCase().replace(/S$/, "");
function parseC(line) {
  const cells = line.trim().split(/\s{3,}/).map((c) => c.trim());
  if (cells.length !== 3) return null;
  const name = collapse(cells[0].replace(/\s*\((?:M|H|F)\)\s*$/, ""));
  if ([...name].filter((c) => /\p{L}/u.test(c)).length < 2 || /[:]$/.test(name) || /^(resultado|nombre|doctor|dilucion|dilución)/i.test(name)) return null;
  const res = cells[1], ref = cells[2];
  const mv = /^([<>]?\s?\d+(?:\.\d+)?)(?:\s+(\S.*))?$/.exec(res);
  if (!mv) {
    if (/\d{3,}/.test(res) && !/:/.test(res)) return null;
    if (!/^[A-Za-zÁÉÍÓÚÑ]/.test(res) || !/^[A-Za-zÁÉÍÓÚÑ]/.test(ref)) return null;
    return { name, valueText: res, flag: stem(res) !== stem(ref), unit: "", kind: "text", g1: ref, g2: "" };
  }
  const unitRes = (mv[2] || "").trim();
  let kind = "text", g1 = ref, g2 = "", unitRef = "", m;
  if ((m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(.*)$/.exec(ref))) { kind = "range"; g1 = m[1]; g2 = m[2]; unitRef = m[3]; }
  else if ((m = /^(≤|≥|<=|>=|<|>)\s*(\d+(?:\.\d+)?)\s*(.*)$/.exec(ref))) { kind = "cmp"; g1 = m[1]; g2 = m[2]; unitRef = m[3]; }
  else if ((m = /^(\d+(?:\.\d+)?)\s*(\S.*)?$/.exec(ref))) { kind = "range"; g1 = m[1]; g2 = m[1]; unitRef = m[2] || ""; }
  const unit = unitRes || unitRef.trim();
  if (unit.length > 18) return null;
  return { name, valueText: mv[1].replace(/\s/g, ""), flag: false, unit, kind, g1, g2 };
}

function parseRow(line, profile) {
  if (profile?.rowStyle === "C") return parseC(line.trim());
  const s = line.trim();
  if (!s) return null;
  if (profile?.rowStyle === "A") return parseA(s);
  if (profile?.rowStyle === "B") return parseB(s);
  return parseA(s) || parseB(s);   // formato desconocido: se intentan los dos estilos
}

export function computeStatus(value, kind, low, high, flag) {
  if (value === null) return flag ? "fuera" : "normal";
  switch (kind) {
    case "range": return low !== null && value < low ? "bajo" : high !== null && value > high ? "alto" : "normal";
    case "lt": return value < (high ?? Infinity) ? "normal" : "alto";
    case "le": return value <= (high ?? Infinity) ? "normal" : "alto";
    case "gt": return value > (low ?? -Infinity) ? "normal" : "bajo";
    case "ge": return value >= (low ?? -Infinity) ? "normal" : "bajo";
    default: return flag ? "fuera" : "normal";
  }
}

function build(r, category, key, display, defaultUnit) {
  const compact = r.valueText.replace(/ /g, "");
  const digits = compact.replace(/^[<>]+/, "");
  let value = null, text = null;
  if (/^\d+(\.\d+)?$/.test(digits)) value = parseFloat(digits); else text = r.valueText;
  let low = null, high = null, kind = "text", refText = "";
  if (r.kind === "range") { kind = "range"; low = parseFloat(r.g1); high = parseFloat(r.g2); }
  else if (r.kind === "cmp") {
    const x = parseFloat(r.g2);
    if (r.g1 === "<") { kind = "lt"; high = x; }
    else if (r.g1 === "≤" || r.g1 === "<=") { kind = "le"; high = x; }
    else if (r.g1 === ">") { kind = "gt"; low = x; }
    else { kind = "ge"; low = x; }
  } else { refText = r.g1; }
  const unit = normUnit(r.unit) || defaultUnit;
  return { key, name: display, category, value, text, unit, refLow: low, refHigh: high, refKind: kind, refText,
    status: computeStatus(value, kind, low, high, r.flag) };
}

const ALIASES = {};
function al(display, ...names) {
  for (const n of names) ALIASES[norm(n)] = display;
  ALIASES[norm(display)] = display;
}
al("Hematocrito", "Hematócrito");
al("Volumen corpuscular medio", "Volumen Corp. Medio", "VOLUMEN CORPUSCULAR MEDIO");
al("Hemoglobina corpuscular media", "Hemoglobina Corp. Media", "HEMOGLOBINA CORPUSCULAR MEDIA");
al("Concentración media de hemoglobina corpuscular", "Conc. Media de Hemoglobina Corp.", "CONC. MEDIA DE HB CORPUSCULAR");
al("Ancho de distribución eritrocitaria (CV)", "Ancho de Distrib. de Eritrocitos (CV)", "ANCHO DE DISTRIBUCIÓN ERITROCITARIA (C.V.)");
al("Ancho de distribución eritrocitaria (DE)", "Ancho de Distrib. de Eritrocitos (SD)", "ANCHO DE DISTRIBUCIÓN ERITROCITARIA (D.E.)");
al("Nitrógeno ureico (BUN)", "NITROGENO UREICO (BUN)");
al("Relación BUN/creatinina", "RELACION BUN/CREATININA");
al("Creatinina", "CREATININA EN SUERO");
al("Ácido úrico", "ACIDO URICO EN SUERO");
al("Colesterol total", "COLESTEROL TOTAL");
al("Colesterol HDL", "COLESTEROL HDL");
al("Colesterol LDL", "COLESTEROL LDL");
al("Colesterol VLDL", "COLESTEROL VLDL");
al("Relación colesterol LDL/HDL", "RELACION COLESTEROL LDL/COLESTEROL HDL");
al("Índice de riesgo aterogénico", "INDICE DE RIESGO ATEROGENICO");
al("Triglicéridos", "TRIGLICERIDOS");
al("AST (TGO)", "ASPARTATO AMINOTRANSFERASA (TGO)(AST)");
al("ALT (TGP)", "ALANINO AMINOTRANSFERASA (TGP)(ALT)");
al("GGT", "GAMMAGLUTAMIL TRANSPEPTIDASA (GGT)");
al("Fosfatasa alcalina (ALP)", "FOSFATASA ALCALINA (ALP)");
al("LDH", "DESHIDROGENASA LACTICA (LDH)");
al("Proteínas totales", "PROTEÍNAS TOTALES SÉRICAS");
al("Albúmina", "ALBÚMINA EN SUERO");
al("Relación A/G", "RELACION A/G");
al("Calcio", "CALCIO EN SUERO");
al("Fósforo", "FOSFORO EN SUERO");
al("Magnesio", "MAGNESIO EN SUERO");
al("Bilirrubina total", "BILIRRUBINA TOTAL");
al("Bilirrubina directa", "BILIRRUBINA DIRECTA");
al("Bilirrubina indirecta", "BILIRRUBINA INDIRECTA");
al("Gravedad específica", "GRAVEDAD ESPECIFICA");
al("pH urinario", "REACCIÓN pH");
al("Vitamina D (25-OH)", "Vitamina D (25,hidroxi)");
al("Anticoagulante lúpico (ratio dRVVT)", "Ratio dRVVT");
al("Concentración media de hemoglobina corpuscular", "C.H.C.M.");
al("Volumen corpuscular medio", "V.C.M.");
al("Plaquetas", "RECUENTO PLAQUETARIO");
al("AST (TGO)", "T.G.O.");
al("ALT (TGP)", "T.G.P.");
al("GGT", "GAMA-GLUTAMIL-TRANSPEPTIDASA");
al("LDH", "DESHIDROGENASA LACTICA");
al("Bilirrubina total", "BILIRRUBINAS TOTALES");
al("Fosfatasa alcalina (ALP)", "FOSFATASA ALCALINA");
al("Proteínas totales", "PROTEINAS TOTALES");
al("Albúmina", "ALBUMINAS");
al("Globulina", "GLOBULINAS");
al("Proteína C reactiva", "PROTEINA C REACTIVA");
al("Hormona estimulante de la tiroides (TSH)", "HORMONA TIROIDEO-ESTIMULANTE");
al("Tiroxina libre (T4 libre)", "TIROXINA LIBRE (T4 LIBRE)");
al("Velocidad de sedimentación globular", "VEL. SEDIMENTACION (WESTERGREN)");
al("Anticuerpos anti-CCP IgG", "ACS.ANTI-CITRULINADOS IgG");
al("Neutrófilos segmentados (%)", "SEGMENTADOS");
al("Eosinófilos", "EOSINOFILOS");
al("Basófilos", "BASOFILOS");
al("Antígeno HLA-B27", "ANTIGENO DE HISTOCOMPATIBILIDAD");
al("Anticuerpos anti-citoplasma de neutrófilos P-ANCA (IFI)", "ACS. ANTI P-ANCA");
al("Anticuerpos anti-citoplasma de neutrófilos C-ANCA (IFI)", "ACS. ANTI C-ANCA");
al("Anti-mieloperoxidasa (MPO, ELISA)", "ACS. ANTI P-ANCA MIELOPEROXIDASA");
al("Anti-proteinasa 3 (PR3, ELISA)", "ACS. ANTI-C-ANCA PROTEINASA -3 (PR3)");
al("Anticuerpos antinucleares (ANA)", "ACS. ANTI-NUCLEARES");
al("Anti-nRNP/Sm", "nRNP/SM");
al("Anti-Sm", "SM");
al("Anti-RNP 70", "RNP 70");
al("Anti-RNP A", "RNP A");
al("Anti-RNP C", "RNP C");
al("Anti-SS-A nativo (60 kDa)", "SS-A nativo (60 kDa)");
al("Anti-Ro-52", "Ro-52");
al("Anti-SS-B", "SS-B");
al("Anti-Scl-70", "Scl-70");
al("Anti-PM-Scl 100", "PM-Scl 100");
al("Anti-Jo-1", "Jo-1");
al("Anti-centrómero B", "Centromero B");
al("Anti-PCNA", "PCNA");
al("Anti-dsDNA", "dsDNA");
al("Anti-nucleosomas", "Nucleosomas");
al("Anti-histonas", "Histonas");
al("Anti-proteínas ribosomales", "Ribosomales Protein");
al("Anti-mitocondriales M2 (AMA M2)", "AMA M2");
const DIFF = new Set(["Neutrófilos", "Linfocitos", "Monocitos", "Eosinófilos", "Basófilos"].map(norm));

function sentence(raw) {
  if (upperRatio(raw) >= 0.8) { const s = raw.toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); }
  return raw;
}

function canonical(raw, unit, section) {
  const pct = raw.includes("(%)");
  const n = norm(raw);
  let display = ALIASES[n] ?? sentence(raw.replace("(%)", "").trim());
  if (DIFF.has(n)) display += pct || unit === "%" ? " (%)" : " (absolutos)";
  return { key: (section === "Orina" ? "orina:" : "") + norm(display), display };
}

const SECTION_RULES = [["BIOMETRIA HEMATICA", "Hematología"], ["HEMATOLOGIA", "Hematología"], ["QUIMICA CLINICA", "Química clínica"],
  ["UROANALISIS", "Orina"], ["EXAMEN GENERAL DE ORINA", "Orina"], ["EXAMEN FISICO", "Orina"], ["EXAMEN QUIMICO", "Orina"],
  ["EXAMEN MICROSCOPICO", "Orina"]];
const BOILER = ["RESULTADOS", "ANALISIS CLINICOS", "GRUPO", "SUCURSAL", "WWW", "BEETHOVEN", "ZAPOPAN", "ACREDITACION",
  "GRACIAS", "INFORME", "PRUEBA", "AVISO", "DESCARGA", "RECUERDE"];

const UDG_TITLES = [["BIOMETRIAHEMATICA", "Hematología"],
  ["BILIRRUBINAS", "Química clínica"], ["FOSFATASAALCALINA", "Química clínica"], ["GAMAGLUTAMIL", "Química clínica"], ["DESHIDROGENASA", "Química clínica"],
  ["PROTEINASTOTALES", "Química clínica"], ["TGO", "Química clínica"], ["TGP", "Química clínica"],
  ["HORMONATIROIDEO", "Otros"], ["T4LIBRE", "Otros"],
  ["PROTEINACREACTIVA", "Inmunología"], ["VELSEDIMENTACION", "Inmunología"], ["ACS", "Inmunología"], ["FACTORREUMATOIDE", "Inmunología"],
  ["ANTIGENODEHISTO", "Inmunología"], ["PERFILINMUNO", "Inmunología"]];
function sectionOf(line, profile) {
  if (profile?.titleSections) {
    if (/\s{3,}/.test(line) || line.length > 60 || upperRatio(line) < 0.8) return null;
    const c = norm(line).replace(/[^A-Z0-9]/g, "");
    for (const [k, v] of UDG_TITLES) if (c.startsWith(k)) return v;
    return null;
  }
  const n = norm(line);
  for (const [k, v] of SECTION_RULES) if (n === k) return v;
  if (profile?.groupTitles && n.length >= 8 && upperRatio(line) > 0.9 && !/\d{3,}/.test(n) &&
      !BOILER.some((b) => n.includes(b)) && !/^(Q F B|QBP|L B D)/.test(n) && /[A-Z]{4}/.test(n) && !/\d+\.\d+/.test(line)) return "Otros";
  return null;
}

/**
 * Registro de formatos de laboratorio. Para agregar uno nuevo basta con una entrada aquí:
 *  - detect: reconoce el laboratorio a partir del texto del PDF (en minúsculas).
 *  - rowStyle: "A" = nombre, valor, unidad, rango  |  "B" = nombre, valor, rango, unidad.
 *  - groupTitles: true si el PDF separa los estudios con títulos en mayúsculas.
 * Si el formato trae otra disposición de columnas, se agrega un estilo de fila nuevo (parseA/parseB).
 */
export const LAB_PROFILES = [
  { id: "chopo", lab: "Chopo", rowStyle: "B", groupTitles: true, detect: (t) => t.includes("chopo") || t.includes("(lr)") },
  { id: "udg", lab: "Laboratorio Universidad de Guadalajara", rowStyle: "C", groupTitles: false, defaultSection: "Inmunología", titleSections: true,
    detect: (t) => t.includes("valores de referencia") && /nombre:[\s\S]*orden:/.test(t) },
  { id: "otero", lab: "Centro Analítico Mariano Otero", rowStyle: "A", groupTitles: false, detect: (t) => t.includes("fecha de toma") || t.includes("mariano otero") },
];
export const SUPPORTED_LABS = LAB_PROFILES.map((p) => p.lab);

function detectProfile(text) {
  const t = text.toLowerCase();
  return LAB_PROFILES.find((p) => p.detect(t)) || null;
}

const iso = (d, m, y) => `${y}-${m}-${d}`;
const isSummary = (page) => page.some((l) => l.toLowerCase().includes("resumen comparativo"));

/** pages: arreglo de páginas; cada página es un arreglo de filas de texto. */
export function parseDocument(pages) {
  const profile = detectProfile(pages.map((p) => p.join("\n")).join("\n"));
  const out = { family: profile?.id ?? "unknown", lab: profile?.lab ?? "Laboratorio",
    date: null, patient: null, birth: null, sex: null, folio: null, results: [] };
  const usable = pages.filter((p) => !isSummary(p));
  for (const page of usable) for (const l of page) {
    let m;
    if (!out.date && (m = /Fecha(?: de (?:Toma|Registro|Muestra|Recepci[oó]n))?:\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(l))) out.date = iso(m[1], m[2], m[3]);
    if (!out.patient && (m = /(?<!ID )Paciente:\s*(.+?)(?:\s+Sexo:|$)/.exec(l))) {
      const c = m[1].replace(/,/g, " ").split(/\s+/).filter(Boolean).join(" ").toUpperCase();
      if (c) out.patient = c;
    }
    if (!out.patient && (m = /^Nombre:\s*(.+?)\s+Orden:/.exec(l))) out.patient = m[1].split(/\s+/).filter(Boolean).join(" ").toUpperCase();
    if (!out.birth && (m = /Fecha de nacimiento:\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(l))) out.birth = iso(m[1], m[2], m[3]);
    if (!out.sex && (m = /Sexo:\s*(Mujer|Hombre|Femenino|Masculino)/i.exec(l))) out.sex = /^(mujer|femenino)$/i.test(m[1]) ? "F" : "M";
    if (!out.folio && (m = /(?:Folio|Orden):\s*([A-Za-z0-9]+)/.exec(l))) out.folio = m[1];
  }
  let section = profile?.defaultSection ?? "Otros";
  const seen = new Set();
  for (const page of usable) for (const l of page) {
    const sec = sectionOf(l.trim(), profile);
    if (sec) { section = sec; continue; }
    const raw = parseRow(l, profile);
    if (!raw) continue;
    const { key, display } = canonical(raw.name, normUnit(raw.unit), section);
    if (seen.has(key)) continue;
    seen.add(key);
    out.results.push(build(raw, section, key, display, norm(raw.name) === "ERITROCITOS" ? "10⁶/µL" : ""));
  }
  return out;
}
