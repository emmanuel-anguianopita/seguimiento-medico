// Resumen histórico en PDF: toma lo que está publicado en la carpeta data (ya descifrado) y dibuja tablas y gráficas.
// No depende de la pantalla ni de los datos locales: recibe {name, profile, reports, weights} y devuelve los bytes del PDF.
import { PdfDoc, textWidth, wrap } from "./pdfwriter.js";
import { restandardize } from "./parser.js";
import { progress } from "./progress.js";
import { SYSTEM_NAMES, systemOf } from "./systems.js";
import { compose, bmi as calcBmi, ageYears } from "./composition.js";
import { fmt } from "./charts.js";

const C = { text: "#16181d", muted: "#6b7280", line: "#e5e7eb", accent: "#c8283c", ok: "#1f9d55", bajo: "#2f6fdb", alto: "#d64545", fuera: "#d9822b",
  soft: "#f4f5f7", okBg: "#e6f4ec", bajoBg: "#e8f0fd", altoBg: "#fdecec", fueraBg: "#fdf1e3" };
const STATUS_LABEL = { normal: "Normal", bajo: "Bajo", alto: "Alto", fuera: "Fuera de rango" };
const STATUS_COLOR = { normal: C.ok, bajo: C.bajo, alto: C.alto, fuera: C.fuera };
const STATUS_BG = { bajo: C.bajoBg, alto: C.altoBg, fuera: C.fueraBg };
const CHANGE_LABEL = { mejoro: "Mejoró", empeoro: "Empeoró", estable: "Estable", igual: "Sin cambio", nuevo: "Nuevo" };

const toTime = (iso) => new Date(iso + "T12:00:00").getTime();
const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
const fmtLong = (d) => d.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
const fmtShort = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
const signed = (v) => `${v > 0 ? "+" : ""}${fmt(Number(v.toFixed(2)))}`;
const display = (p) => (p.value !== null && p.value !== undefined ? fmt(p.value) : p.text ?? "–");
function reference(p) {
  switch (p.refKind) {
    case "range": return `${fmt(p.refLow)} – ${fmt(p.refHigh)}`;
    case "lt": return `< ${fmt(p.refHigh)}`;
    case "le": return `<= ${fmt(p.refHigh)}`;
    case "gt": return `> ${fmt(p.refLow)}`;
    case "ge": return `>= ${fmt(p.refLow)}`;
    default: return p.refText || "–";
  }
}

/** Prepara los datos: estandariza nombres, ordena por fecha y arma una serie por indicador. */
export function buildSummary(payload) {
  const reports = (payload.reports || []).map((r) => {
    const seen = new Set();
    return { ...r, results: (r.results || []).map(restandardize).filter((x) => !seen.has(x.key) && seen.add(x.key)) };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const map = new Map();
  for (const r of reports) for (const x of r.results) {
    const pt = { rid: r.id, date: r.date, t: toTime(r.date), value: x.value, text: x.text, unit: x.unit, status: x.status, refLow: x.refLow, refHigh: x.refHigh, refKind: x.refKind, refText: x.refText };
    const s = map.get(x.key);
    if (s) { s.points.push(pt); s.name = x.name; s.category = x.category; }
    else map.set(x.key, { key: x.key, name: x.name, category: x.category, points: [pt] });
  }
  const series = [...map.values()];
  const weights = [...(payload.weights || [])].sort((a, b) => a.date.localeCompare(b.date));
  return { name: payload.name || "Paciente", profile: payload.profile || {}, reports, weights, series, prog: reports.length ? progress(series, reports) : null };
}

// ---------- Dibujo ----------
const PW = 792, PH = 612, M = 36, TOP = 62, BOTTOM = PH - 38, CW = PW - 2 * M;

function miniChart(pg, x, y, w, h, { title, unit = "", points, refLow = null, refHigh = null, yMin = null, yMax = null, big = false }) {
  pg.rect(x, y, w, h, { fill: "#ffffff", stroke: C.line });
  pg.text(title, x + 7, y + 12, { size: big ? 10 : 8, bold: true, maxW: w - 14 });
  if (unit) pg.text(unit, x + 7, y + (big ? 23 : 21), { size: big ? 8 : 6.5, color: C.muted, maxW: w - 14 });
  const L = x + (big ? 36 : 32), R = x + w - 10, T = y + (big ? 32 : 27), B = y + h - (big ? 18 : 15);
  const sorted = [...points].sort((a, b) => a.t - b.t);
  let t0 = sorted[0].t, t1 = sorted[sorted.length - 1].t;
  if (t0 === t1) { t0 -= 86400000 * 15; t1 += 86400000 * 15; }
  const vals = sorted.map((p) => p.v).concat([refLow, refHigh].filter((v) => v !== null));
  let lo = yMin ?? Math.min(...vals), hi = yMax ?? Math.max(...vals);
  if (lo === hi) { const d = Math.abs(lo) * 0.1 || 1; lo -= d; hi += d; }
  const nonNeg = Math.min(...vals) >= 0;
  if (yMin === null) lo -= (hi - lo) * 0.1;
  if (yMax === null) hi += (hi - lo) * 0.1;
  if (nonNeg && lo < 0) lo = 0;   // un conteo o una concentración no puede ser negativa
  const steps = yMin === 0 && yMax === 100 ? 4 : 3;
  const X = (t) => L + ((t - t0) / (t1 - t0)) * (R - L);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (B - T);
  if (refLow !== null && refHigh !== null) pg.rect(L, Y(refHigh), R - L, Math.max(0.5, Y(refLow) - Y(refHigh)), { fill: C.okBg });
  for (let i = 0; i <= steps; i++) {
    const v = lo + ((hi - lo) * i) / steps;
    pg.line(L, Y(v), R, Y(v), { color: C.line, lineWidth: 0.4 });
    pg.text(fmt(Number(v.toPrecision(3))), L - 4, Y(v) + 2.4, { size: big ? 7 : 6, color: C.muted, align: "right" });
  }
  if (refHigh !== null && refLow === null) pg.line(L, Y(refHigh), R, Y(refHigh), { color: C.alto, lineWidth: 0.7, dash: [3, 2] });
  if (refLow !== null && refHigh === null) pg.line(L, Y(refLow), R, Y(refLow), { color: C.bajo, lineWidth: 0.7, dash: [3, 2] });
  if (sorted.length > 1) pg.polyline(sorted.map((p) => [X(p.t), Y(p.v)]), { color: "#4b5563", lineWidth: big ? 1.4 : 1 });
  for (const p of sorted) pg.circle(X(p.t), Y(p.v), big ? 3.2 : 2.3, { fill: STATUS_COLOR[p.status] || C.ok });
  pg.text(fmtShort(new Date(sorted[0].t).toISOString().slice(0, 10)), L, y + h - 5, { size: big ? 7.5 : 6.5, color: C.muted, align: sorted.length > 1 ? "left" : "center" });
  if (sorted.length > 1) pg.text(fmtShort(new Date(sorted[sorted.length - 1].t).toISOString().slice(0, 10)), R, y + h - 5, { size: big ? 7.5 : 6.5, color: C.muted, align: "right" });
}

function spark(pg, x, y, w, h, points) {
  if (points.length < 2) return;
  const s = [...points].sort((a, b) => a.t - b.t);
  const t0 = s[0].t, t1 = s[s.length - 1].t;
  let lo = Math.min(...s.map((p) => p.v)), hi = Math.max(...s.map((p) => p.v));
  if (lo === hi) { lo -= 1; hi += 1; }
  pg.polyline(s.map((p) => [x + ((p.t - t0) / (t1 - t0 || 1)) * w, y + (1 - (p.v - lo) / (hi - lo)) * h]), { color: "#6b7280", lineWidth: 0.9 });
  const last = s[s.length - 1];
  pg.circle(x + w, y + (1 - (last.v - lo) / (hi - lo)) * h, 1.6, { fill: STATUS_COLOR[last.status] || C.ok });
}

/** Genera el PDF. opts.now: fecha de generación (para pruebas). Devuelve Uint8Array. */
export async function buildResumenPdf(payload, opts = {}) {
  const S = buildSummary(payload);
  if (!S.reports.length && !S.weights.length) throw new Error("Sin estudios ni registros de peso");
  const now = opts.now || new Date();
  const doc = new PdfDoc({ title: `Resumen histórico de indicadores de salud - ${S.name}`, author: "Anatomía según Emmanuel Anguiano", subject: "Resumen histórico de indicadores de salud", width: PW, height: PH });
  let pg = null, y = 0;
  const newPage = (cont = false) => {
    pg = doc.addPage(); y = TOP;
    pg.text("ANATOMÍA SEGÚN EMMANUEL ANGUIANO", M, 30, { size: 8, bold: true, color: C.accent });
    pg.text(`${S.name} · Resumen histórico`, PW - M, 30, { size: 8, color: C.muted, align: "right", maxW: 400 });
    pg.line(M, 38, PW - M, 38, { color: C.accent, lineWidth: 1 });
    return pg;
  };
  const ensure = (h) => { if (y + h > BOTTOM) { newPage(true); return true; } return false; };
  const heading = (text, need = 40) => { ensure(need); pg.text(text.toUpperCase(), M, y + 10, { size: 8.5, bold: true, color: C.muted }); y += 18; };

  newPage();
  // ---- Encabezado
  pg.text("Resumen histórico de indicadores de salud", M, y + 18, { size: 20, bold: true }); y += 30;
  pg.text(S.name, M, y + 14, { size: 14, bold: true, color: C.accent, maxW: CW }); y += 22;
  const dates = S.reports.map((r) => r.date);
  const labs = [...new Set(S.reports.map((r) => r.lab).filter(Boolean))];
  const prof = S.profile, lastDate = dates[dates.length - 1] || S.weights[S.weights.length - 1]?.date;
  const age = prof.birthDate && lastDate ? ageYears(prof.birthDate, lastDate) : null;
  const meta = [`Generado el ${fmtLong(now)}`,
    S.reports.length ? `${S.reports.length} estudio${S.reports.length === 1 ? "" : "s"} de laboratorio (${fmtDate(dates[0])}${dates.length > 1 ? " a " + fmtDate(dates[dates.length - 1]) : ""})` : "Sin estudios de laboratorio",
    S.weights.length ? `${S.weights.length} registro${S.weights.length === 1 ? "" : "s"} de peso` : null,
    age != null ? `${age} años` : null, prof.sex ? (prof.sex === "F" ? "Mujer" : "Hombre") : null, prof.heightCm ? `${fmt(prof.heightCm)} cm` : null].filter(Boolean).join("  ·  ");
  y += pg.paragraph(meta, M, y, CW, { size: 9, color: C.muted }) + 8;
  if (labs.length) y += pg.paragraph(`Laboratorios: ${labs.join("; ")}`, M, y, CW, { size: 8, color: C.muted }) + 6;

  // ---- Resumen general
  const P = S.prog;
  if (P) {
    const t = P.timeline[P.timeline.length - 1], top = y + 4, hh = 138;
    pg.rect(M, top, 236, hh, { fill: C.soft });
    pg.text(`Indicadores dentro de rango · estudio del ${fmtDate(P.latestDate)}`, M + 12, top + 18, { size: 7.5, color: C.muted, maxW: 212 });
    pg.text(`${fmt(P.nowPct)} %`, M + 12, top + 52, { size: 30, bold: true });
    if (P.deltaPct !== null) {
      const col = P.deltaPct > 0 ? C.ok : P.deltaPct < 0 ? C.alto : C.muted;
      if (P.deltaPct !== 0) pg.triangle(M + 12 + textWidth(`${fmt(P.nowPct)} %`, 30, true) + 14, top + 44, 4, P.deltaPct > 0, col);
      pg.text(`${signed(P.deltaPct)} puntos`, M + 12 + textWidth(`${fmt(P.nowPct)} %`, 30, true) + 24, top + 48, { size: 9, bold: true, color: col });
    }
    pg.rect(M + 12, top + 62, 212, 6, { fill: C.line }); pg.rect(M + 12, top + 62, 212 * Math.min(100, P.nowPct) / 100, 6, { fill: C.ok });
    pg.text(`${t.ok} de ${t.total} indicadores en rango${P.previousDate ? "" : " · primer estudio"}`, M + 12, top + 82, { size: 8, color: C.muted, maxW: 212 });
    if (P.previousDate) pg.text(`Comparado con el estudio del ${fmtDate(P.previousDate)}`, M + 12, top + 93, { size: 8, color: C.muted, maxW: 212 });
    const flat = P.counts.estable + P.counts.igual;
    [["Mejoraron", P.counts.mejoro, C.ok], ["Empeoraron", P.counts.empeoro, C.alto], ["Sin cambio", flat, C.muted], ["Nuevos", P.counts.nuevo, C.bajo]].forEach(([l, n, col], i) => {
      const bx = M + 12 + i * 54;
      pg.text(String(n), bx, top + 117, { size: 15, bold: true, color: col }); pg.text(l, bx, top + 129, { size: 6.5, color: C.muted });
    });
    if (P.timeline.length > 1) miniChart(pg, M + 248, top, CW - 248, hh, { title: "Indicadores dentro de rango por estudio", unit: "porcentaje (%)", big: true, yMin: 0, yMax: 100, points: P.timeline.map((x) => ({ t: toTime(x.date), v: x.pct, status: "normal" })) });
    else { pg.rect(M + 248, top, CW - 248, hh, { stroke: C.line }); pg.paragraph("Con un solo estudio todavía no hay evolución que graficar. Cuando se agreguen nuevos estudios aparecerá aquí la tendencia.", M + 264, top + 50, CW - 280, { size: 9, color: C.muted }); }
    y = top + hh + 14;

    // ---- Por sistema u órgano
    heading("Por sistema u órgano");
    const cols = [[0, 250, "Sistema u órgano", "left"], [250, 70, "Indicadores", "right"], [320, 70, "En rango", "right"], [400, 190, "", "left"], [590, 65, "Mejoraron", "right"], [655, 65, "Empeoraron", "right"]];
    const rowH = 15;
    const sysHead = () => { pg.rect(M, y, CW, 15, { fill: C.soft }); for (const [dx, w, l, al] of cols) if (l) pg.text(l, M + dx + (al === "right" ? w - 6 : 6), y + 10.5, { size: 7.5, bold: true, color: C.muted, align: al }); y += 15; };
    sysHead();
    for (const s of P.bySystem) {
      if (y + rowH > BOTTOM) { newPage(true); sysHead(); }
      const pct = s.total ? s.ok / s.total : 0;
      pg.text(s.name, M + 6, y + 10.5, { size: 8.5, maxW: 240 });
      pg.text(String(s.total), M + 314, y + 10.5, { size: 8.5, align: "right" });
      pg.text(`${s.ok} (${Math.round(pct * 100)} %)`, M + 384, y + 10.5, { size: 8.5, align: "right" });
      pg.rect(M + 410, y + 4.5, 160, 6, { fill: C.line }); if (pct > 0) pg.rect(M + 410, y + 4.5, 160 * pct, 6, { fill: pct === 1 ? C.ok : pct >= 0.7 ? "#7bbf8e" : C.fuera });
      pg.text(s.mejoro ? String(s.mejoro) : "–", M + 649, y + 10.5, { size: 8.5, color: s.mejoro ? C.ok : C.muted, bold: !!s.mejoro, align: "right" });
      pg.text(s.empeoro ? String(s.empeoro) : "–", M + 714, y + 10.5, { size: 8.5, color: s.empeoro ? C.alto : C.muted, bold: !!s.empeoro, align: "right" });
      pg.line(M, y + rowH, M + CW, y + rowH, { color: C.line, lineWidth: 0.4 });
      y += rowH;
    }
  }

  // ---- Indicadores que requieren atención
  if (P && P.attention.length) {
    newPage();
    heading(`Indicadores fuera de rango en el último estudio (${P.attention.length})`);
    const cols = [[0, 236, "Indicador"], [236, 120, "Último valor"], [356, 120, "Referencia"], [476, 96, "Estado"], [572, 148, "Cambio frente al estudio anterior"]];
    const head = () => { pg.rect(M, y, CW, 15, { fill: C.soft }); for (const [dx, , l] of cols) pg.text(l, M + dx + 6, y + 10.5, { size: 7.5, bold: true, color: C.muted }); y += 15; };
    head();
    const att = [...P.attention].sort((a, b) => a.system.localeCompare(b.system, "es") || a.name.localeCompare(b.name, "es"));
    for (const it of att) {
      if (y + 15 > BOTTOM) { newPage(true); head(); }
      const l = it.last;
      pg.circle(M + 9, y + 7.5, 2.6, { fill: STATUS_COLOR[l.status] });
      pg.text(`${it.name}${it.category === "Orina" ? " (orina)" : ""}`, M + 18, y + 10.5, { size: 8.5, maxW: 212 });
      pg.text(`${display(l)} ${l.unit || ""}`.trim(), M + 242, y + 10.5, { size: 8.5, bold: true, maxW: 110 });
      pg.text(reference(l), M + 362, y + 10.5, { size: 8.5, color: C.muted, maxW: 110 });
      pg.text(STATUS_LABEL[l.status], M + 482, y + 10.5, { size: 8.5, color: STATUS_COLOR[l.status], bold: true });
      const ch = it.change === "nuevo" || !it.prev ? "Nuevo" : `${CHANGE_LABEL[it.change]}${it.delta ? ` (${signed(it.delta)})` : ""}`;
      pg.text(ch, M + 578, y + 10.5, { size: 8.5, color: it.change === "mejoro" ? C.ok : it.change === "empeoro" ? C.alto : C.muted, maxW: 140 });
      pg.line(M, y + 15, M + CW, y + 15, { color: C.line, lineWidth: 0.4 });
      y += 15;
    }
    const withChart = att.map((it) => S.series.find((s) => s.key === it.key)).filter((s) => s && s.points.filter((p) => p.value !== null).length >= 2);
    if (withChart.length) {
      y += 14; heading("Evolución de los indicadores fuera de rango", 40 + 112);
      const cw = (CW - 3 * 10) / 4, chh = 112;
      let col = 0;
      for (const s of withChart.slice(0, 40)) {
        if (col === 0 && y + chh > BOTTOM) newPage(true);
        const nums = s.points.filter((p) => p.value !== null), refPt = nums[nums.length - 1];
        miniChart(pg, M + col * (cw + 10), y, cw, chh, { title: s.name, unit: refPt.unit, points: nums.map((p) => ({ t: p.t, v: p.value, status: p.status })), refLow: refPt.refLow, refHigh: refPt.refHigh });
        if (++col === 4) { col = 0; y += chh + 10; }
      }
      if (col) y += chh + 10;
    }
  }

  // ---- Peso y composición corporal
  if (S.weights.length) {
    newPage();
    heading("Peso y composición corporal");
    const ws = S.weights, last = ws[ws.length - 1];
    const comp = [...ws].reverse().find((w) => w.fatPct != null || w.waterPct != null || w.boneKg != null) || last;
    const c = compose(comp, prof);
    const lines = [["Peso", `${fmt(Number(last.kg.toFixed(1)))} kg`, `registro del ${fmtDate(last.date)}`]];
    if (ws.length > 1) lines.push(["Cambio desde el inicio", `${last.kg - ws[0].kg > 0 ? "+" : ""}${fmt(Number((last.kg - ws[0].kg).toFixed(1)))} kg`, `desde el ${fmtDate(ws[0].date)}`]);
    const item = (n, it, u) => it && lines.push([n, `${fmt(it.value)}${u}`, [it.label, it.range ? `ref. ${it.range}` : ""].filter(Boolean).join(" · ")]);
    item("IMC", c.bmi, ""); item("Grasa corporal", c.fat, " %"); item("Agua corporal", c.water, " %"); item("Masa ósea", c.bone, " kg");
    if (c.fat) lines.push(["Masa grasa / masa magra", `${fmt(c.fatMassKg)} / ${fmt(c.leanMassKg)} kg`, ""]);
    let ty = y;
    for (const [n, v, note] of lines) {
      pg.text(n, M, ty + 11, { size: 8.5, color: C.muted, maxW: 112 }); pg.text(v, M + 118, ty + 11, { size: 9.5, bold: true, maxW: 150 });
      ty += note ? 15 + pg.paragraph(note, M + 118, ty + 14, 164, { size: 7, color: C.muted, lead: 9 }) + 6 : 21;
    }
    if (c.headline) { pg.text(c.headline, M, ty + 8, { size: 8, bold: true, maxW: 270 }); ty += 14; }
    const gx = M + 290, gw = (CW - 290 - 10) / 2, gh = 118;
    const charts = [["Peso", "kg", (w) => w.kg], ["IMC", "", (w) => (prof.heightCm ? Number(calcBmi(w.kg, prof.heightCm).toFixed(1)) : null)],
      ["Grasa corporal", "porcentaje (%)", (w) => w.fatPct], ["Agua corporal", "porcentaje (%)", (w) => w.waterPct], ["Masa ósea", "kg", (w) => w.boneKg]]
      .map(([title, unit, f]) => ({ title, unit, points: ws.filter((w) => f(w) != null).map((w) => ({ t: toTime(w.date), v: f(w), status: "normal" })) })).filter((x) => x.points.length > 1);
    charts.forEach((ch, i) => miniChart(pg, gx + (i % 2) * (gw + 10), y + Math.floor(i / 2) * (gh + 10), gw, gh, ch));
    y = Math.max(ty, y + Math.ceil(charts.length / 2) * (gh + 10)) + 6;
    // Registros
    heading("Registros de peso");
    const wc = [[0, 90, "Fecha"], [90, 70, "Peso (kg)"], [160, 80, "Grasa (%)"], [240, 80, "Agua (%)"], [320, 90, "Masa ósea (kg)"], [410, 310, "Nota"]];
    const wh = () => { pg.rect(M, y, CW, 15, { fill: C.soft }); for (const [dx, , l] of wc) pg.text(l, M + dx + 6, y + 10.5, { size: 7.5, bold: true, color: C.muted }); y += 15; };
    wh();
    for (const w of [...ws].reverse().slice(0, 60)) {
      if (y + 14 > BOTTOM) { newPage(true); wh(); }
      [fmtDate(w.date), fmt(w.kg), w.fatPct != null ? fmt(w.fatPct) : "–", w.waterPct != null ? fmt(w.waterPct) : "–", w.boneKg != null ? fmt(w.boneKg) : "–", w.note || ""]
        .forEach((v, i) => pg.text(v, M + wc[i][0] + 6, y + 10, { size: 8.5, maxW: wc[i][1] - 10 }));
      pg.line(M, y + 14, M + CW, y + 14, { color: C.line, lineWidth: 0.4 });
      y += 14;
    }
  }

  // ---- Histórico por sistema
  if (S.series.length) {
    newPage();
    heading("Histórico de indicadores por sistema u órgano");
    const shown = S.reports.slice(-9), n = shown.length, colW = Math.min(52, Math.floor(376 / n));
    const unitW = 50, refW = 78, spW = 44, nameW = CW - unitW - refW - spW - n * colW;
    pg.paragraph(`${S.series.length} indicadores en ${S.reports.length} estudio${S.reports.length === 1 ? "" : "s"}.${S.reports.length > n ? ` La tabla muestra los ${n} más recientes; la minigráfica de tendencia abarca todos.` : ""} Los valores fuera de rango aparecen sombreados: rojo alto, azul bajo, naranja fuera de rango.`, M, y, CW, { size: 8, color: C.muted });
    y += 26;
    const xName = M, xUnit = M + nameW, xRef = xUnit + unitW, xCols = xRef + refW, xSp = xCols + n * colW;
    const band = (title, cont) => {
      pg.rect(M, y, CW, 17, { fill: C.soft });
      pg.text(title + (cont ? " (continuación)" : ""), xName + 6, y + 11.5, { size: 8.5, bold: true, maxW: nameW - 8 });
      pg.text("Unidad", xUnit + 4, y + 11.5, { size: 6.5, bold: true, color: C.muted }); pg.text("Referencia", xRef + 4, y + 11.5, { size: 6.5, bold: true, color: C.muted });
      shown.forEach((r, i) => pg.text(fmtShort(r.date), xCols + i * colW + colW / 2, y + 11.5, { size: 6.8, bold: true, color: i === n - 1 ? C.text : C.muted, align: "center" }));
      pg.text("Tendencia", xSp + 2, y + 11.5, { size: 6.5, bold: true, color: C.muted });
      y += 17;
    };
    const byName = (a, b) => a.name.localeCompare(b.name, "es");
    for (const g of SYSTEM_NAMES) {
      const rows = S.series.filter((s) => systemOf(s.name, s.category) === g).sort(byName);
      if (!rows.length) continue;
      if (y + 17 + 28 > BOTTOM) newPage(true);
      band(`${g} (${rows.length})`, false);
      for (const s of rows) {
        if (y + 14 > BOTTOM) { newPage(true); band(`${g} (${rows.length})`, true); }
        const lastPt = s.points[s.points.length - 1];
        const by = new Map(s.points.map((p) => [p.rid, p]));
        shown.forEach((r, i) => { const p = by.get(r.id); if (p && STATUS_BG[p.status]) pg.rect(xCols + i * colW + 1, y, colW - 2, 14, { fill: STATUS_BG[p.status] }); });
        pg.text(s.name + (s.category === "Orina" ? " (orina)" : ""), xName + 6, y + 10, { size: 8, maxW: nameW - 10 });
        pg.text(lastPt.unit || "", xUnit + 4, y + 10, { size: 7, color: C.muted, maxW: unitW - 6 });
        pg.text(reference(lastPt), xRef + 4, y + 10, { size: 7, color: C.muted, maxW: refW - 6 });
        shown.forEach((r, i) => {
          const p = by.get(r.id);
          if (!p) return pg.text("–", xCols + i * colW + colW / 2, y + 10, { size: 8, color: C.muted, align: "center" });
          pg.text(display(p), xCols + i * colW + colW / 2, y + 10, { size: 8, bold: p.status !== "normal", color: p.status === "normal" ? C.text : STATUS_COLOR[p.status], align: "center", maxW: colW - 3 });
        });
        spark(pg, xSp + 2, y + 3, spW - 8, 8, s.points.filter((p) => p.value !== null).map((p) => ({ t: p.t, v: p.value, status: p.status })));
        pg.line(M, y + 14, M + CW, y + 14, { color: C.line, lineWidth: 0.4 });
        y += 14;
      }
      y += 8;
    }
  }

  // ---- Estudios incluidos y notas
  if (S.reports.length) {
    ensure(60 + Math.min(S.reports.length, 12) * 14);
    heading("Estudios incluidos");
    const ec = [[0, 90, "Fecha"], [90, 330, "Laboratorio"], [420, 130, "Folio"], [550, 80, "Resultados"], [630, 90, "Fuera de rango"]];
    const eh = () => { pg.rect(M, y, CW, 15, { fill: C.soft }); for (const [dx, , l] of ec) pg.text(l, M + dx + 6, y + 10.5, { size: 7.5, bold: true, color: C.muted }); y += 15; };
    eh();
    for (const r of [...S.reports].reverse()) {
      if (y + 14 > BOTTOM) { newPage(true); eh(); }
      [fmtDate(r.date), r.lab || "–", r.folio || "–", String(r.results.length), String(r.results.filter((x) => x.status !== "normal").length)]
        .forEach((v, i) => pg.text(v, M + ec[i][0] + 6, y + 10, { size: 8.5, maxW: ec[i][1] - 10 }));
      pg.line(M, y + 14, M + CW, y + 14, { color: C.line, lineWidth: 0.4 });
      y += 14;
    }
    y += 12;
    const note = "Cada valor se clasifica con los límites de referencia del informe del que proviene; en la columna «Referencia» se muestran los del estudio más reciente de cada indicador. Los nombres de los indicadores se unificaron entre laboratorios para poder compararlos. Este resumen es informativo y no sustituye la valoración de un profesional de la salud.";
    const nh = wrap(note, 8, false, CW).length * 11 + 4;
    ensure(nh); pg.paragraph(note, M, y, CW, { size: 8, color: C.muted });
  }

  // ---- Pie de página con numeración
  const total = doc.pages.length;
  doc.pages.forEach((p, i) => {
    p.text("Documento personal con información médica confidencial.", M, PH - 20, { size: 7, color: C.muted });
    p.text(`Página ${i + 1} de ${total}`, PW - M, PH - 20, { size: 7, color: C.muted, align: "right" });
  });
  return doc.build();
}
