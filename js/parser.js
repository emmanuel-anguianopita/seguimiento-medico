// Lector de resultados de laboratorio. Trabaja sobre filas de texto (una fila de tabla por cadena).
// Formatos reconocidos: Centro Analítico Mariano Otero y Chopo.
// Es una traducción fiel de la implementación validada en Python y de la versión en Swift.

import { systemOf } from "./systems.js";
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
  [/^u\/ml\.?$/i, "U/mL"], [/^ui\/ml$/i, "UI/mL"], [/^uui\/ml$/i, "µUI/mL"], [/^mg\/dl$/i, "mg/dL"], [/^ng\/dl$/i, "ng/dL"], [/^mm\/hr$/i, "mm/h"],
  [/^meq\/l$/i, "mmol/L"], [/^k\/[uµ]l$/i, "10³/µL"], [/^m\/[uµ]l$/i, "10⁶/µL"], [/^fl$/i, "fL"], [/^g\/dl$/i, "g/dL"], [/^leu\/[uµ]l$/i, "Cel/µL"], [/^x campo$/i, "por campo"], [/^mL\/min\/1\.73\s?m(?:2|²)$/i, "mL/min/1.73 m²"], [/^[uµ]g\/dl$/i, "µg/dL"]];
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
  return [...n].filter((c) => /\p{L}/u.test(c)).length >= 3 || /^pH$/i.test(n);
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

/** Estilo D (sistema PasNet): la referencia va en la línea anterior, «Nombre   resultado» en la fila y la unidad en la línea siguiente. */
const UNIT_LINE = /^(%|fl|pg|x campo|[A-Za-zµμ]+\/[A-Za-zµμ0-9.^³]+)$/i;
const WORD = /^[A-Za-zÁÉÍÓÚÑáéíóúñ]+(?: [A-Za-zÁÉÍÓÚÑáéíóúñ]+)?$/;
function parseD(lines, i) {
  const cells = lines[i].split(/\s{3,}/).map((c) => c.trim());
  if (cells.length !== 2) return null;
  const name = collapse(cells[0]), val = cells[1];
  if ([...name].filter((c) => /\p{L}/u.test(c)).length < 2 || /:/.test(name) || name.length > 45 || /^(estudio|paciente|doctor)\b/i.test(name)) return null;
  const numeric = /^[<>]?\s?\d+(?:\.\d+)?$/.test(val);
  if (!numeric && !WORD.test(val) && !/^\d+\s?-\s?\d+$/.test(val)) return null;
  const prev = (lines[i - 1] || "").trim(), next = (lines[i + 1] || "").trim();
  let unit = UNIT_LINE.test(next) ? next : "", kind = "text", g1 = "", g2 = "", flag = false, m;
  const pc = prev.split(/\s{3,}/).map((c) => c.trim());
  if (pc.length === 2 && pc[0] === "(*)") { flag = true; if (!unit && UNIT_LINE.test(pc[1])) unit = pc[1]; }
  else if ((m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(prev))) { kind = "range"; g1 = m[1]; g2 = m[2]; }
  else if ((m = /^Hasta\s+(\d+(?:\.\d+)?)$/i.exec(prev))) { kind = "cmp"; g1 = "≤"; g2 = m[1]; }
  else if ((m = /^(<|>)\s*(\d+(?:\.\d+)?)$/.exec(prev))) { kind = "cmp"; g1 = m[1]; g2 = m[2]; }
  else if (/^[A-Za-zÁÉÍÓÚÑáéíóúñ]+$/.test(prev) && !numeric) { g1 = prev; flag = stem(val) !== stem(prev); }
  if (!numeric && unit !== "x campo") unit = "";   // en resultados cualitativos la unidad solo describe el umbral
  return { name, valueText: val, flag, unit, kind, g1, g2 };
}

/** Orina de Chopo: nombre | resultado cualitativo | referencia (que puede venir partida en varias columnas). */
function parseOrinaText(line) {
  const cells = line.trim().split(/\s{3,}/).map((c) => c.trim()).filter(Boolean);
  if (cells.length < 3) return null;
  const name = collapse(cells[0]);
  if ([...name].filter((c) => /\p{L}/u.test(c)).length < 3 || /:/.test(name) || name.length > 40) return null;
  const res = cells[1];
  if (!/^[A-Za-zÁÉÍÓÚÑáéíóúñ]+$/.test(res)) return null;
  const ref = cells.slice(2).join(" ").replace(/\s+/g, " ").trim();
  if (!/^(?:[A-Za-zÁÉÍÓÚÑáéíóúñ]|[<>≤≥])/.test(ref)) return null;
  const first = ref.split(" ")[0];
  return { name, valueText: res, flag: /^[A-Za-zÁÉÍÓÚÑáéíóúñ]+$/.test(first) && stem(res) !== stem(first), unit: "", kind: "text", g1: ref, g2: "" };
}

function parseRow(line, profile) {
  if (profile?.rowStyle === "C") return parseC(line.trim());
  const s = line.trim().replace(/\s[–—]\s/g, " - ").replace(/(\d)\s?[–—]\s?(\d)/g, "$1-$2");
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
// ---- Estandarización de nombres: nombres equivalentes de distintos laboratorios, siglas y variantes de escritura ----
al("Neutrófilos", "Neutrofilos", "Neutrófilos segmentados", "SEGMENTADOS", "Segmentados", "Neutrófilos totales", "NEU", "Neu#");
al("Linfocitos", "Linfocitos totales", "LYM", "Lin");
al("Monocitos", "MON", "Mono");
al("Eosinófilos", "EOS");
al("Basófilos", "BAS");
al("Eritrocitos", "Glóbulos rojos", "Globulos rojos", "Recuento de eritrocitos", "Cuenta de glóbulos rojos", "Eritrocitos (RBC)", "RBC", "Hematíes", "Hematies");
al("Leucocitos", "Glóbulos blancos", "Globulos blancos", "Leucocitos totales", "Recuento de leucocitos", "Cuenta de leucocitos", "Leucocitos (WBC)", "WBC");
al("Hemoglobina", "Hb", "HGB", "Hemoglobina (Hb)");
al("Hematocrito", "Hto", "HCT", "Hematocrito (Hct)");
al("Volumen corpuscular medio", "VCM", "MCV", "Volumen globular medio", "Volumen corpuscular medio (VCM)");
al("Hemoglobina corpuscular media", "HCM", "MCH", "Hemoglobina globular media", "Hemoglobina corpuscular media (HCM)");
al("Concentración media de hemoglobina corpuscular", "CHCM", "CMHC", "MCHC", "Concentración media de hemoglobina globular", "Concentración de hemoglobina corpuscular media", "Conc. media de hemoglobina corpuscular");
al("Ancho de distribución eritrocitaria (CV)", "RDW", "RDW-CV", "ADE", "ADE-CV", "Amplitud de distribución eritrocitaria", "Ancho de distribución eritrocitaria", "Ancho de distrib. de eritrocitos", "Índice de anisocitosis");
al("Ancho de distribución eritrocitaria (DE)", "RDW-SD", "ADE-DE", "ADE-SD");
al("Plaquetas", "PLT", "Trombocitos", "Cuenta plaquetaria", "Recuento de plaquetas", "Plaquetas (PLT)");
al("Volumen plaquetario medio", "VPM", "MPV", "Volumen medio plaquetario");
al("Glucosa", "Glucosa en ayunas", "Glucosa en ayuno", "Glucosa sérica", "Glucosa en suero", "Glucosa basal", "Glucosa (ayuno)", "Glucosa plasmática", "GLU", "Glicemia", "Glucemia");
al("Urea", "Urea en suero", "Urea sérica", "Urea sanguínea");
al("Nitrógeno ureico (BUN)", "BUN", "Nitrógeno de urea", "Nitrógeno ureico", "Nitrógeno ureico en sangre", "Nitrógeno ureico sanguíneo");
al("Creatinina", "Creatinina sérica", "Creatinina en sangre");
al("Ácido úrico", "Ácido úrico sérico", "Acido urico", "Úrico");
al("Colesterol total", "Colesterol", "Colesterol sérico", "Colesterol-total", "Colesterol total en suero");
al("Colesterol HDL", "HDL", "HDL colesterol", "Colesterol de alta densidad", "Colesterol-HDL", "Colesterol HDL (bueno)", "C-HDL", "HDL-C");
al("Colesterol LDL", "LDL", "LDL colesterol", "Colesterol de baja densidad", "Colesterol-LDL", "Colesterol LDL calculado", "LDL calculado", "C-LDL", "LDL-C", "Colesterol LDL (malo)");
al("Colesterol VLDL", "VLDL", "VLDL colesterol", "Colesterol de muy baja densidad", "Colesterol-VLDL", "C-VLDL", "VLDL calculado");
al("Colesterol no HDL", "Colesterol no-HDL", "Colesterol NO HDL", "No-HDL", "Colesterol no HDL calculado");
al("Triglicéridos", "Trigliceridos séricos", "Triglicéridos en suero", "TG", "Triglicéridos séricos");
al("AST (TGO)", "AST", "TGO", "SGOT", "GOT", "Transaminasa glutámico oxalacética", "Aspartato aminotransferasa", "Aspartato amino transferasa", "Aspartato aminotransferasa (AST)");
al("ALT (TGP)", "ALT", "TGP", "SGPT", "GPT", "Transaminasa glutámico pirúvica", "Alanina aminotransferasa", "Alanino aminotransferasa", "Alanina aminotransferasa (ALT)");
al("GGT", "Gamma glutamil transferasa", "Gamma glutamil transpeptidasa", "Gamma-glutamil transpeptidasa", "Gamma GT", "Gama GT", "GGTP", "Gamma glutamiltransferasa", "Gama glutamil transferasa");
al("Fosfatasa alcalina (ALP)", "Fosfatasa alcalina", "ALP", "FA", "Fosfatasa alcalina total");
al("LDH", "Deshidrogenasa láctica", "Lactato deshidrogenasa", "Deshidrogenasa láctica (DHL)", "DHL", "Deshidrogenasa lactica");
al("Bilirrubina total", "Bilirrubinas totales", "Bilirrubina (total)");
al("Bilirrubina directa", "Bilirrubina conjugada", "Bilirrubina (directa)");
al("Bilirrubina indirecta", "Bilirrubina no conjugada", "Bilirrubina (indirecta)");
al("Proteínas totales", "Proteínas totales en suero", "Proteínas séricas", "Proteina total", "Proteínas totales (suero)");
al("Albúmina", "Albumina sérica", "Albumina", "ALB");
al("Globulina", "Globulinas", "Globulina sérica");
al("Calcio", "Calcio sérico", "Calcio total", "Ca");
al("Fósforo", "Fosforo inorgánico", "Fósforo sérico", "Fósforo inorgánico", "P inorgánico");
al("Magnesio", "Magnesio sérico", "Mg");
al("Sodio", "Sodio sérico", "Na", "Sodio (Na)");
al("Potasio", "Potasio sérico", "K", "Potasio (K)");
al("Cloruro", "Cloro", "Cloruros", "Cl", "Cloro sérico", "Cloro (Cl)");
al("Hierro", "Hierro sérico", "Fe", "Hierro total");
al("Amilasa", "Amilasa sérica", "Amilasa total");
al("Lipasa", "Lipasa sérica");
al("Hemoglobina glicosilada (HbA1c)", "HbA1c", "Hemoglobina glicada", "Hemoglobina glucosilada", "Hemoglobina A1c", "A1C", "HB A1c", "Hemoglobina glicosilada");
al("Insulina", "Insulina basal", "Insulina en ayunas", "Insulina sérica");
al("Ferritina", "Ferritina sérica");
al("Vitamina B12", "B12", "Cobalamina", "Vitamina B-12", "Vitamina B 12");
al("Ácido fólico", "Folatos", "Folato", "Vitamina B9", "Ácido fólico sérico");
al("Vitamina D (25-OH)", "Vitamina D", "25 hidroxivitamina D", "25-OH vitamina D", "25-hidroxivitamina D", "Vitamina D 25 hidroxi", "Vitamina D total", "25-OH-Vitamina D");
al("Hormona estimulante de la tiroides (TSH)", "TSH", "Tirotropina", "Hormona estimulante de tiroides", "Hormona tiroestimulante", "TSH ultrasensible");
al("Tiroxina libre (T4 libre)", "T4 libre", "Tiroxina libre", "FT4", "T4L");
al("Triyodotironina libre (T3 libre)", "T3 libre", "Triyodotironina libre", "FT3", "T3L");
al("Tiroxina total (T4)", "T4 total", "Tiroxina total", "T4");
al("Triyodotironina total (T3)", "T3 total", "Triyodotironina total", "T3");
al("Proteína C reactiva", "PCR", "Proteína C-reactiva", "Proteína C reactiva ultrasensible", "PCR ultrasensible", "PCR-us", "Proteina C reactiva cuantitativa");
al("Velocidad de sedimentación globular", "VSG", "Velocidad de sedimentación", "Eritrosedimentación", "Velocidad de sedimentación globular (VSG)");
al("Creatina fosfocinasa (CPK)", "CPK", "CK", "Creatina cinasa", "Creatinfosfocinasa", "Creatina fosfoquinasa", "Creatinquinasa");
al("Homocisteína", "Homocisteina");
al("Fibrinógeno", "Fibrinogeno");
al("Antígeno prostático específico (PSA)", "PSA", "Antígeno prostático específico", "PSA total");
al("Cortisol", "Cortisol sérico", "Cortisol AM");
al("Testosterona total", "Testosterona", "Testosterona sérica");
al("Estradiol", "Estradiol sérico", "E2");
al("Progesterona", "Progesterona sérica");
al("Nitrógeno ureico (BUN)", "Nitrógeno de urea en sangre (BUN)", "Nitrógeno de urea en sangre");
al("Relación BUN/creatinina", "Relación BUN/creat", "BUN/creatinina", "Relación urea/creatinina");
al("Colesterol LDL", "Colesterol LDL directo", "LDL directo", "Colesterol LDL (directo)");
al("Índice de riesgo aterogénico", "Índice aterogénico", "Indice aterogenico", "Riesgo aterogénico");
al("Relación colesterol LDL/HDL", "Relación LDL/HDL", "LDL/HDL", "Cociente LDL/HDL");
al("Relación AST/ALT", "Relación: AST/ALT", "AST/ALT", "Cociente AST/ALT", "Relación TGO/TGP");
al("Fosfatasa alcalina (ALP)", "F. Alcalina total", "F. Alcalina", "Fosfatasa alcalina total");
al("Velocidad de sedimentación globular", "Westergren", "Sedimentación Westergren", "Velocidad de sedimentación Westergren");
al("Capacidad total de fijación de hierro (TIBC)", "Captación de hierro", "TIBC", "Capacidad total de fijación de hierro", "Capacidad de fijación de hierro", "CTFH", "Capacidad total de saturación de hierro", "Capacidad total de unión a hierro");
al("Capacidad de fijación de hierro no saturada (UIBC)", "UIBC", "Capacidad latente de fijación de hierro", "CLFH");
al("Saturación de hierro", "Porcentaje de saturación de hierro", "% saturación de hierro", "Índice de saturación de transferrina", "Saturación de transferrina", "Porcentaje de saturación de transferrina");
al("Inmunoglobulina G (IgG)", "Inmunoglobulina G", "IgG", "IgG total");
al("Inmunoglobulina A (IgA)", "Inmunoglobulina A", "IgA", "IgA total");
al("Inmunoglobulina M (IgM)", "Inmunoglobulina M", "IgM", "IgM total");
al("Filtración glomerular estimada (TFGe)", "Tasa de filtración glomerular estimada", "TFG", "TFGe", "eGFR", "Filtrado glomerular estimado", "Tasa de filtrado glomerular", "Depuración de creatinina estimada");
al("Transferrina", "Transferrina sérica");
al("LDL pequeñas y densas (sdLDL)", "sd LDL", "sdLDL", "LDL pequeñas y densas");
al("Lípidos totales", "Lípidos totales en suero");
al("Fosfolípidos", "Fosfolípidos en suero", "Fosfolipidos");
al("Leucocitos", "Leucocitos WBC");
al("Linfocitos", "Linfocitos LYM", "Linfocitos LYM #", "Linfocitos LYM %");
al("Monocitos", "Monocitos MID", "MID", "Monocitos MID #", "Monocitos MID %");
al("Neutrófilos", "Granulocitos", "Granulocitos GRA", "GRA", "Granulocitos GRA #", "Granulocitos GRA %");
al("Eosinófilos", "EO", "EO #", "EO %"); al("Basófilos", "BA", "BA #", "BA %");
al("Eritrocitos", "Eritrocitos RBC"); al("Hemoglobina", "Hemoglobina HGB"); al("Hematocrito", "Hematocrito HCT");
al("Plaquetas", "Plaquetas PLT"); al("Plaquetocrito (PCT)", "PCT", "Plaquetocrito");
al("Urea", "UREA/BUN", "Urea BUN");
al("Colesterol HDL", "Colesterol de alta densidad HDL");
al("Colesterol LDL", "Colesterol de baja densidad LDL");
const DIFF = new Set(["Neutrófilos", "Linfocitos", "Monocitos", "Eosinófilos", "Basófilos"].map(norm));

// Orina: los mismos nombres significan otra cosa que en sangre (por ejemplo, «Bilirrubina»)
const ORINA = {};
const alo = (display, ...names) => { for (const n of [display, ...names]) ORINA[norm(n)] = display; };
alo("Bilirrubina", "Bilirrubinas", "Bilirrubina total");
alo("Proteínas", "Proteína", "Proteinas");
alo("Glucosa");
alo("Cetonas", "Cuerpos cetónicos", "Cetona");
alo("Nitritos", "Nitrito");
alo("Urobilinógeno", "Urobilinogeno");
alo("Gravedad específica", "Densidad", "Densidad urinaria", "Peso específico");
alo("pH urinario", "pH", "Reacción", "Reacción pH");
alo("Esterasa leucocitaria", "Leucocito esterasa", "Esterasa leucocitaria");
alo("Leucocitos", "Leucocitos por campo");
alo("Eritrocitos", "Hematíes", "Glóbulos rojos");
alo("Sangre (erit. lisados)", "Hemoglobina", "Sangre", "Sangre oculta", "Eritrocitos lisados");
alo("Eritrocitos dismórficos", "Eritrocitos dismorficos");
alo("Cilindros", "Cilindros urinarios");
alo("Células epiteliales escamosas", "Células pavimentosas", "Células escamosas", "Células epiteliales planas");
alo("Células epiteliales no escamosas", "Células de transición", "Células tubulares renales", "Células transicionales");
alo("Filamento mucoide", "Hilo mucoso", "Redes mucoides", "Moco", "Hilos de moco", "Filamentos mucoides");
alo("Aspecto", "Turbidez", "Transparencia");
alo("Cristales", "Cristales urinarios");
alo("Bacterias");
alo("Levaduras", "Hongos");
alo("Color");

// Coincidencia flexible: ignora acentos, mayúsculas, signos, plurales y palabras de relleno («en suero», «sérico»…)
const FILLER = new Set(["EN", "DE", "LA", "EL", "DEL", "LOS", "LAS", "SUERO", "SERICO", "SERICA", "SERICOS", "SERICAS", "SANGRE", "PLASMA", "CUANTITATIVA", "CUANTITATIVO"]);
const loose = (name) => norm(name).split(" ").filter((t) => t && !FILLER.has(t)).map((t) => (t.length > 4 && t.endsWith("S") && !t.endsWith("SS") ? t.slice(0, -1) : t)).join(" ");
let LOOSE = null;
function looseIndex() {
  if (LOOSE) return LOOSE;
  LOOSE = new Map();
  for (const [k, display] of Object.entries(ALIASES)) { const l = loose(k); if (l && !LOOSE.has(l)) LOOSE.set(l, display); }
  return LOOSE;
}
const looseOrina = (name) => { const l = loose(name); for (const [k, v] of Object.entries(ORINA)) if (loose(k) === l) return v; return null; };

function sentence(raw) {
  if (upperRatio(raw) >= 0.8) { const s = raw.toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); }
  return raw;
}

function canonical(raw, unit, section) {
  const pct = raw.includes("(%)") || /%\s*$/.test(raw);
  const n = norm(raw);
  let display = (section === "Orina" ? (ORINA[n] ?? looseOrina(raw)) : null) ?? ALIASES[n] ?? looseIndex().get(loose(raw)) ?? sentence(raw.replace("(%)", "").trim());
  if (DIFF.has(norm(display))) display += pct || unit === "%" ? " (%)" : " (absolutos)";
  return { key: (section === "Orina" ? "orina:" : "") + norm(display), display };
}

/** Vuelve a estandarizar el nombre de un resultado ya guardado (estudios importados con versiones anteriores). */
export function restandardize(r) {
  if (!r || !r.name) return r;
  const pct = /\(%\)\s*$/.test(r.name) || r.unit === "%";
  const base = r.name.replace(/\s*\((?:%|absolutos)\)\s*$/i, "");
  const { key, display } = canonical(base, pct ? "%" : r.unit, r.category);
  return key === r.key && display === r.name ? r : { ...r, key, name: display };
}

const SECTION_RULES = [["BIOMETRIA HEMATICA", "Hematología"], ["HEMATOLOGIA", "Hematología"], ["QUIMICA CLINICA", "Química clínica"],
  ["UROANALISIS", "Orina"], ["EXAMEN GENERAL DE ORINA", "Orina"], ["EXAMEN FISICO", "Orina"], ["EXAMEN QUIMICO", "Orina"],
  ["EXAMEN MICROSCOPICO", "Orina"], ["BIOMETRIA HEMATICA COMPLETA", "Hematología"], ["EXAMEN MACROSCOPICO", "Orina"], ["EXAMEN FISICO QUIMICO", "Orina"]];
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
  { id: "pasnet", lab: "Laboratorio clínico (sistema PasNet)", rowStyle: "D", groupTitles: false, detect: (t) => t.includes("pasnet") || (t.includes("informe de resultados") && t.includes("valores de referencia") && t.includes("estudio   resultado")) },
  { id: "otero", lab: "Centro Analítico Mariano Otero", rowStyle: "A", groupTitles: false, detect: (t) => t.includes("fecha de toma") || t.includes("mariano otero") },
];
export const SUPPORTED_LABS = LAB_PROFILES.map((p) => p.lab);

function detectProfile(text) {
  const t = text.toLowerCase();
  return LAB_PROFILES.find((p) => p.detect(t)) || null;
}

// Si el PDF no rotula la sección (por ejemplo «Química integral de 45 elementos»), la categoría se deduce del nombre.
const CATEGORY_OF_SYSTEM = { "Sangre: serie roja": "Hematología", "Sangre: serie blanca": "Hematología", "Plaquetas": "Hematología",
  "Hígado y vías biliares": "Química clínica", "Páncreas": "Química clínica", "Riñón y vías urinarias": "Química clínica", "Glucosa y metabolismo": "Química clínica",
  "Lípidos y corazón": "Química clínica", "Electrolitos y minerales": "Química clínica", "Proteínas": "Química clínica", "Vitaminas y huesos": "Química clínica",
  "Inflamación y reumatología": "Inmunología", "Autoinmunidad": "Inmunología" };
const categoryByName = (display) => CATEGORY_OF_SYSTEM[systemOf(display, "")] || "Otros";

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
    if (!out.date && (m = /Fecha(?: de (?:Toma|Registro|Muestra|Recepci[oó]n)| y hora de registro)?\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(l))) out.date = iso(m[1], m[2], m[3]);
    if (!out.patient && (m = /(?<!ID )Paciente\s*:\s*(.+?)(?:\s+Sexo:|$)/.exec(l))) {
      const c = m[1].replace(/,/g, " ").split(/\s+/).filter(Boolean).join(" ").toUpperCase();
      if (c) out.patient = c;
    }
    if (!out.patient && (m = /^Nombre:\s*(.+?)\s+Orden:/.exec(l))) out.patient = m[1].split(/\s+/).filter(Boolean).join(" ").toUpperCase();
    if (!out.birth && (m = /Fecha de nacimiento\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(l))) out.birth = iso(m[1], m[2], m[3]);
    if (!out.sex && (m = /Sexo(?: \/ Edad)?\s*:\s*(Mujer|Hombre|Femenino|Masculino)/i.exec(l))) out.sex = /^(mujer|femenino)$/i.test(m[1]) ? "F" : "M";
    if (!out.folio && (m = /^\*?(LF\d+)\s*\*?$/.exec(l.trim()))) out.folio = m[1];
    if (!out.folio && (m = /(?:Folio|Orden):\s*([A-Za-z0-9]+)/.exec(l))) out.folio = m[1];
  }
  let section = profile?.defaultSection ?? "Otros";
  const seen = new Set();
  for (const page of usable) for (const [li, l] of page.entries()) {
    const sec = sectionOf(l.trim(), profile);
    if (sec) { section = sec; continue; }
    let raw = profile?.rowStyle === "D" ? parseD(page, li) : parseRow(l, profile);
    if (!raw && section === "Orina" && profile?.id === "chopo") raw = parseOrinaText(l);   // orina de Chopo: resultados cualitativos en tres columnas
    if (!raw) continue;
    const { key, display } = canonical(raw.name, normUnit(raw.unit), section);
    if (seen.has(key)) continue;
    seen.add(key);
    out.results.push(build(raw, section === "Otros" ? categoryByName(display) : section, key, display, norm(raw.name) === "ERITROCITOS" && section !== "Orina" ? "10⁶/µL" : ""));
  }
  return out;
}
