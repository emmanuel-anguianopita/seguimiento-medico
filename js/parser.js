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
const normUnit = (u) => { const t = collapse(u.replace(/\u03BC/g, "\u00B5")); return UNIT_MAP[t] ?? t; };
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

function parseRow(line, family) {
  const s = line.trim();
  if (!s) return null;
  if (family === "otero") return parseA(s);
  if (family === "chopo") return parseB(s);
  return parseA(s) || parseB(s);
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

function sectionOf(line, family) {
  const n = norm(line);
  for (const [k, v] of SECTION_RULES) if (n === k) return v;
  if (family === "chopo" && n.length >= 8 && upperRatio(line) > 0.9 && !/\d{3,}/.test(n) &&
      !BOILER.some((b) => n.includes(b)) && !/^(Q F B|QBP|L B D)/.test(n) && /[A-Z]{4}/.test(n) && !/\d+\.\d+/.test(line)) return "Otros";
  return null;
}

function detectFamily(text) {
  const t = text.toLowerCase();
  if (t.includes("chopo") || t.includes("(lr)")) return "chopo";
  if (t.includes("fecha de toma") || t.includes("mariano otero")) return "otero";
  return "unknown";
}

const iso = (d, m, y) => `${y}-${m}-${d}`;
const isSummary = (page) => page.some((l) => l.toLowerCase().includes("resumen comparativo"));

/** pages: arreglo de páginas; cada página es un arreglo de filas de texto. */
export function parseDocument(pages) {
  const family = detectFamily(pages.map((p) => p.join("\n")).join("\n"));
  const out = { family, lab: family === "otero" ? "Centro Analítico Mariano Otero" : family === "chopo" ? "Chopo" : "Laboratorio",
    date: null, patient: null, birth: null, folio: null, results: [] };
  const usable = pages.filter((p) => !isSummary(p));
  for (const page of usable) for (const l of page) {
    let m;
    if (!out.date && (m = /Fecha de (?:Toma|Registro|Muestra|Recepci[oó]n):\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(l))) out.date = iso(m[1], m[2], m[3]);
    if (!out.patient && (m = /(?<!ID )Paciente:\s*(.+?)(?:\s+Sexo:|$)/.exec(l))) {
      const c = m[1].replace(/,/g, " ").split(/\s+/).filter(Boolean).join(" ").toUpperCase();
      if (c) out.patient = c;
    }
    if (!out.birth && (m = /Fecha de nacimiento:\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(l))) out.birth = iso(m[1], m[2], m[3]);
    if (!out.folio && (m = /(?:Folio|Orden):\s*([A-Za-z0-9]+)/.exec(l))) out.folio = m[1];
  }
  let section = "Otros";
  const seen = new Set();
  for (const page of usable) for (const l of page) {
    const sec = sectionOf(l.trim(), family);
    if (sec) { section = sec; continue; }
    const raw = parseRow(l, family);
    if (!raw) continue;
    const { key, display } = canonical(raw.name, normUnit(raw.unit), section);
    if (seen.has(key)) continue;
    seen.add(key);
    out.results.push(build(raw, section, key, display, norm(raw.name) === "ERITROCITOS" ? "10⁶/µL" : ""));
  }
  return out;
}
